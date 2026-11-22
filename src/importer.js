'use strict';

// Turns an extracted document into proposed records for a register.
// Nothing is written until commit() is called with the (possibly user-edited)
// mapping, so every import is previewed and approved by a person first.

const { TABS, ORDER } = require('./schema');
const { norm, parseDate, parseNumber, parseBool, parseEnum } = require('./values');
const R = require('./resources');

const PREVIEW_ROWS = 300;
const HEADER_SCAN_ROWS = 60;

const aliasCache = new Map();
function aliases(tabName, field) {
  const k = tabName + '.' + field;
  if (!aliasCache.has(k)) {
    const def = TABS[tabName].fields[field];
    aliasCache.set(k, [...new Set([norm(field.replace(/_/g, ' ')), norm(def.label), ...(def.aliases || []).map(norm)].filter(Boolean))]);
  }
  return aliasCache.get(k);
}

// How well a heading/label matches a field: 1 = exact synonym, ~0.75 = contains it.
function matchScore(heading, list) {
  const h = norm(heading);
  if (!h || h.length > 60) return 0;
  let best = 0;
  for (const a of list) {
    let s = 0;
    if (h === a) s = 1;
    else if (a.length >= 3 && ` ${h} `.includes(` ${a} `)) s = 0.75;
    else if (h.length >= 3 && a.length >= 3 && ` ${a} `.includes(` ${h} `) && h.split(' ').length >= 1 && h.length >= a.length / 2) s = 0.6;
    if (s) s += a.length / 1000; // prefer the more specific synonym
    if (s > best) best = s;
  }
  return best;
}

function mapHeaders(tabName, headers) {
  const tab = TABS[tabName];
  const cands = [];
  headers.forEach((h, i) => {
    for (const f of Object.keys(tab.fields)) {
      const s = matchScore(h, aliases(tabName, f));
      if (s > 0) cands.push({ i, f, s });
    }
  });
  cands.sort((a, b) => b.s - a.s || a.i - b.i);
  const mapping = headers.map(() => null); const used = new Set(); let total = 0;
  for (const c of cands) {
    if (mapping[c.i] || used.has(c.f)) continue;
    mapping[c.i] = c.f; used.add(c.f); total += c.s;
  }
  return { mapping, total, matched: used.size };
}

function scoreHeader(tabName, cells) {
  const nonEmpty = cells.filter((c) => String(c ?? '').trim()).length;
  if (nonEmpty < 2) return null;
  const m = mapHeaders(tabName, cells.map((c) => String(c ?? '')));
  if (m.matched < 2) return null;
  const tab = TABS[tabName];
  const keyHit = tab.key.some((k) => m.mapping.includes(k));
  const reqHit = Object.entries(tab.fields).filter(([f, d]) => d.required && m.mapping.includes(f)).length;
  return { ...m, score: m.total + (keyHit ? 1 : 0) + reqHit * 0.5, keyHit };
}

function findHeader(tabName, table) {
  let best = null;
  const limit = Math.min(table.rows.length, table.layout ? 400 : HEADER_SCAN_ROWS);
  for (let r = 0; r < limit; r++) {
    const s = scoreHeader(tabName, table.rows[r] || []);
    if (s && (!best || s.score > best.score)) best = { ...s, row: r };
  }
  return best;
}

// Rows under the header, as arrays aligned to the header's columns.
function dataRows(table, headerRow, keyCols) {
  if (!table.layout) {
    return table.rows.slice(headerRow + 1).map((cells, i) => ({ line: headerRow + i + 2, cells }));
  }
  // PDF: re-split each line by the header's column positions, and fold
  // wrapped lines (no value in the key column) into the row above.
  const head = table.layout[headerRow];
  // A column starts just left of its heading (table text is usually left-aligned
  // under the heading and may run wider than it).
  const bounds = head.cells.map((c, i) => (i === 0 ? -Infinity : Math.max(head.cells[i - 1].endX, c.x - 0.4 * head.size)));
  const headText = head.cells.map((c) => c.text).join('|');
  const out = [];
  for (let li = headerRow + 1; li < table.layout.length; li++) {
    const l = table.layout[li];
    if (l.cells.map((c) => c.text).join('|') === headText) continue; // header repeated on next page
    const cells = head.cells.map(() => '');
    const ends = head.cells.map(() => -Infinity);
    for (const p of l.parts) {
      let col = 0;
      for (let i = 0; i < bounds.length; i++) if (p.x >= bounds[i] - 0.5) col = i;
      const gap = p.x - ends[col];
      cells[col] += (cells[col] && gap > 0.12 * l.size && !cells[col].endsWith(' ') && !p.text.startsWith(' ') ? ' ' : '') + p.text;
      ends[col] = p.endX;
    }
    const clean = cells.map((c) => c.replace(/\s+/g, ' ').trim());
    if (!clean.some(Boolean)) continue;
    const prev = out[out.length - 1];
    const keyEmpty = keyCols.length && keyCols.every((k) => !clean[k]);
    if (prev && keyEmpty && prev.page === l.page) {
      clean.forEach((c, i) => { if (c) prev.cells[i] = prev.cells[i] ? `${prev.cells[i]} ${c}` : c; });
      continue;
    }
    out.push({ line: li + 1, page: l.page, cells: clean });
  }
  return out;
}

// Convert one cell to the field's type. Returns { value } or { warning }.
function convert(tabName, field, raw) {
  const def = TABS[tabName].fields[field];
  if (raw === null || raw === undefined || String(raw).trim() === '') return { value: null };
  let value;
  switch (def.type) {
    case 'date': value = parseDate(raw); if (!value) return { warning: `${def.label}: couldn't read date "${raw}"` }; break;
    case 'number': value = parseNumber(raw); if (value === null) return { warning: `${def.label}: "${raw}" is not a number` }; break;
    case 'bool': value = parseBool(raw); if (!value) return { warning: `${def.label}: "${raw}" is not yes/no` }; break;
    case 'enum': {
      const r = parseEnum(def, raw);
      if (!r.value) return { warning: `${def.label}: "${raw}" not recognised${def.default ? `, left as ${def.default.replace(/_/g, ' ')}` : ''}` };
      value = r.value; break;
    }
    default: value = typeof raw === 'number' ? String(raw) : String(raw).replace(/\s+/g, ' ').trim();
  }
  try { return { value: R.validateValue(field, { ...def, required: false }, value) }; } catch (err) { return { warning: err.message }; }
}

const keyOf = (tab, values) => {
  const parts = tab.key.map((k) => norm(values[k] ?? ''));
  return parts.every((p) => !p) ? null : parts.join('|');
};

// Decide create / update / unchanged / skip for each proposed record.
function plan(db, tabName, proposals) {
  const tab = TABS[tabName];
  const existing = new Map();
  for (const row of db.prepare(`SELECT * FROM ${tabName}`).all()) {
    const k = keyOf(tab, row);
    if (k && !existing.has(k)) existing.set(k, row);
  }
  const seen = new Map();
  const counts = { create: 0, update: 0, unchanged: 0, skip: 0 };
  const rows = proposals.map((p) => {
    const r = { ...p, warnings: [...(p.warnings || [])] };
    const k = keyOf(tab, r.values);
    if (k && seen.has(k)) {
      r.action = 'skip'; r.warnings.push(`same ${tab.key.map((f) => tab.fields[f].label).join(' + ')} as row ${seen.get(k)} in this file`);
    } else if (k && existing.has(k)) {
      const cur = existing.get(k);
      const changes = {};
      for (const [f, v] of Object.entries(r.values)) if (v !== null && v !== cur[f]) changes[f] = { from: cur[f], to: v };
      r.id = cur.id; r.version = cur.version; r.changes = changes;
      r.action = Object.keys(changes).length ? 'update' : 'unchanged';
    } else {
      const missing = Object.entries(tab.fields).filter(([f, d]) => d.required && (r.values[f] === null || r.values[f] === undefined)).map(([, d]) => d.label);
      if (missing.length) { r.action = 'skip'; r.warnings.push(`missing ${missing.join(', ')}`); }
      else r.action = 'create';
    }
    if (k && !seen.has(k)) seen.set(k, r.line ?? '?');
    if (p.excluded && r.action !== 'skip') { r.action = 'skip'; r.warnings.push('excluded by you'); }
    counts[r.action]++;
    return r;
  });
  return { rows, counts };
}

function keywordBonus(tabName, filename, text) {
  const f = ` ${norm(filename)} `; const t = ` ${norm(String(text || '').slice(0, 4000))} `;
  let b = 0;
  for (const kw of TABS[tabName].keywords || []) {
    const k = norm(kw);
    if (f.includes(` ${k} `) || f.includes(` ${k}`)) b = Math.max(b, 1.5);
    else if (t.includes(` ${k} `)) b = Math.max(b, 0.5);
  }
  return b;
}

/* ---------------- single-document (form) reading ---------------- */

function labelPairs(extracted) {
  const colon = []; const cells = [];
  for (const line of extracted.lines || []) {
    for (const c of line.cells) {
      const m = /^([^:]{2,60}?)\s*[:：]\s*(.+)$/.exec(c);
      if (m) colon.push([m[1], m[2]]);
    }
    const cs = line.cells;
    for (let k = 0; k + 1 < cs.length; k++) {
      if (/[:：]\s*$/.test(cs[k]) || k % 2 === 0) cells.push([cs[k].replace(/[:：]\s*$/, ''), cs[k + 1]]);
    }
  }
  return [...colon, ...cells];
}

function readFields(tabName, extracted) {
  const tab = TABS[tabName];
  const raw = {}; const found = {};
  for (const [label, value] of labelPairs(extracted)) {
    let best = null; let bestScore = 0.74;
    for (const f of Object.keys(tab.fields)) {
      if (raw[f] !== undefined) continue;
      const s = matchScore(label, aliases(tabName, f));
      if (s > bestScore) { best = f; bestScore = s; }
    }
    if (best && String(value).trim()) { raw[best] = value; found[best] = label.trim(); }
  }
  const text = extracted.text || '';
  const keyField = tab.key[0];
  if (raw[keyField] === undefined && tab.keyPattern) {
    const m = tab.keyPattern.exec(text);
    if (m) { raw[keyField] = m[0]; found[keyField] = 'pattern in text'; }
  }
  if (tab.fields.revision && raw.revision === undefined) {
    const m = /\bRev(?:ision)?\.?\s*[:#-]?\s*([A-Z]?\d{1,2}[A-Z]?|[A-Z])\b/.exec(text);
    if (m) { raw.revision = m[1]; found.revision = 'pattern in text'; }
  }
  const titleField = tab.display.find((f) => f !== keyField && tab.fields[f].required && raw[f] === undefined);
  if (titleField) {
    const first = (extracted.lines || []).map((l) => l.cells.join(' ')).find((l) => l.length > 3 && l.length < 150 && !/[:：]/.test(l));
    if (first) { raw[titleField] = first; found[titleField] = 'first line of document'; }
  }
  const values = {}; const warnings = [];
  for (const [f, v] of Object.entries(raw)) {
    const c = convert(tabName, f, v);
    if (c.warning) warnings.push(c.warning); else values[f] = c.value;
  }
  return { values, found, warnings, matched: Object.keys(values).length };
}

/* ---------------- public API ---------------- */

// opts: { tab: 'auto'|tabName, mode, filename, table, headerRow, mapping, exclude: [line] }
function analyseFull(db, extracted, opts = {}) {
  const tabs = opts.tab && opts.tab !== 'auto' ? [opts.tab] : ORDER;
  for (const t of tabs) R.getTab(t);
  const tables = extracted.tables || [];

  // Score every (tab, table) pair.
  const cands = [];
  for (const t of tabs) {
    const bonus = keywordBonus(t, opts.filename, extracted.text);
    tables.forEach((table, ti) => {
      const h = findHeader(t, table);
      if (h) cands.push({ tab: t, table: ti, header: h, score: h.score + bonus });
    });
    if (!tables.length || extracted.kind === 'pdf' || extracted.kind === 'docx') {
      const f = readFields(t, extracted);
      if (f.matched >= 2) cands.push({ tab: t, table: null, fields: f, score: f.matched * 0.6 + bonus });
    }
  }
  cands.sort((a, b) => b.score - a.score);

  const tabScores = [];
  for (const c of cands) if (!tabScores.find((x) => x.tab === c.tab)) tabScores.push({ tab: c.tab, score: Math.round(c.score * 10) / 10 });

  let chosen = cands[0] || null;
  if (opts.tab && opts.tab !== 'auto' && Number.isInteger(opts.table) && tables[opts.table]) {
    const table = tables[opts.table];
    const row = Number.isInteger(opts.headerRow) ? opts.headerRow : findHeader(opts.tab, table)?.row;
    if (row !== undefined && row !== null && table.rows[row]) {
      chosen = { tab: opts.tab, table: opts.table, header: { row, ...mapHeaders(opts.tab, table.rows[row].map((c) => String(c ?? ''))) } };
    }
  } else if (opts.tab && opts.tab !== 'auto' && opts.mode === 'fields') {
    chosen = cands.find((c) => c.table === null) || { tab: opts.tab, table: null, fields: readFields(opts.tab, extracted) };
  }

  const base = {
    kind: extracted.kind,
    tables: tables.map((t, i) => ({ index: i, name: t.name, rows: t.rows.length })),
    tabScores,
    excerpt: String(extracted.text || '').slice(0, 4000),
  };

  if (!chosen) {
    const tab = opts.tab && opts.tab !== 'auto' ? opts.tab : null;
    const f = tab ? readFields(tab, extracted) : null;
    if (f && f.matched >= 1) chosen = { tab, table: null, fields: f };
    else {
      return {
        ...base, mode: 'none', tab,
        message: extracted.text && extracted.text.trim()
          ? 'Could not find a register table or recognisable fields in this document. It is stored as evidence; check the excerpt below or pick another register.'
          : 'No readable text was found. If this is a scanned PDF, it needs OCR first (or upload the original Excel/Word file). It is stored as evidence.',
      };
    }
  }

  if (chosen.table === null) {
    const f = chosen.fields;
    const p = plan(db, chosen.tab, [{ line: 1, values: f.values, warnings: f.warnings }]);
    return { ...base, mode: 'fields', tab: chosen.tab, found: f.found, record: f.values, ...p };
  }

  const table = tables[chosen.table];
  const headerRow = chosen.header.row;
  const headers = (table.layout ? table.layout[headerRow].cells.map((c) => c.text) : table.rows[headerRow]).map((c) => String(c ?? '').trim());
  let mapping = chosen.header.mapping.slice(0, headers.length);
  while (mapping.length < headers.length) mapping.push(null);
  if (Array.isArray(opts.mapping)) {
    const fields = TABS[chosen.tab].fields;
    const usedFields = new Set();
    mapping = headers.map((_, i) => {
      const f = opts.mapping[i];
      if (!f || !Object.hasOwn(fields, f) || usedFields.has(f)) return null;
      usedFields.add(f); return f;
    });
  }
  const tab = TABS[chosen.tab];
  const keyCols = tab.key.map((k) => mapping.indexOf(k)).filter((i) => i >= 0);
  const exclude = new Set(opts.exclude || []);

  const proposals = [];
  for (const { line, cells } of dataRows(table, headerRow, keyCols)) {
    if (!cells.some((c) => String(c ?? '').trim())) continue;
    const values = {}; const warnings = [];
    mapping.forEach((f, i) => {
      if (!f) return;
      const c = convert(chosen.tab, f, cells[i]);
      if (c.warning) warnings.push(c.warning);
      else if (c.value !== null) values[f] = c.value;
    });
    if (!Object.keys(values).length) continue;
    proposals.push({ line, values, warnings, excluded: exclude.has(line) });
  }
  const p = plan(db, chosen.tab, proposals);
  return {
    ...base, mode: 'table', tab: chosen.tab, table: chosen.table, headerRow, headers, mapping,
    counts: p.counts, total: p.rows.length, rows: p.rows, // trimmed to PREVIEW_ROWS by analyse()
  };
}

function analyse(db, extracted, opts = {}) {
  const a = analyseFull(db, extracted, opts);
  if (a.mode === 'table') a.rows = a.rows.slice(0, PREVIEW_ROWS);
  return a;
}

// Write the analysed rows. For 'fields' mode the client sends the edited record.
function commit(db, user, upload, extracted, opts) {
  let rows; let tabName;
  if (opts.mode === 'fields') {
    tabName = opts.tab;
    const tab = R.getTab(tabName);
    const values = {}; const warnings = [];
    for (const f of Object.keys(tab.fields)) {
      if (opts.record?.[f] === undefined) continue;
      const c = convert(tabName, f, opts.record[f]);
      if (c.warning) throw new R.HttpError(400, c.warning);
      values[f] = c.value;
    }
    rows = plan(db, tabName, [{ line: 1, values, warnings }]).rows;
  } else {
    const a = analyseFull(db, extracted, { ...opts, filename: upload.filename });
    if (a.mode !== 'table') throw new R.HttpError(400, 'nothing to import from this document as a table');
    tabName = a.tab;
    rows = a.rows;
  }

  const result = { tab: tabName, created: 0, updated: 0, unchanged: 0, skipped: 0 };
  R.tx(db, () => {
    for (const r of rows) {
      if (r.action === 'create') {
        R.create(db, tabName, r.values, user, { sourceUploadId: upload.id, action: 'import' });
        result.created++;
      } else if (r.action === 'update') {
        const current = R.strip(tabName, db.prepare(`SELECT * FROM ${tabName} WHERE id = ?`).get(r.id));
        const changes = {};
        for (const [f, v] of Object.entries(r.values)) if (v !== null && v !== current[f]) changes[f] = { from: current[f], to: v };
        R.applyUpdate(db, tabName, current, changes, user, { sourceUploadId: upload.id, action: 'import' });
        result.updated++;
      } else if (r.action === 'unchanged') result.unchanged++;
      else result.skipped++;
    }
    db.prepare(`UPDATE uploads SET status = 'imported', tab = ?, summary = ?, imported_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(tabName, JSON.stringify(result), upload.id);
  });
  return result;
}

module.exports = { analyse, commit, mapHeaders, matchScore, findHeader, readFields };

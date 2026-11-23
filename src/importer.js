'use strict';

// Turns an extracted document into proposed records for a register.
// Nothing is written until commit() is called with the (possibly user-edited)
// mapping, so every import is previewed and approved by a person first.
//
// Column matching uses, in order: the document type's saved mapping (exact
// headings), then each column's "headings that mean this" (aliases), its label
// and key. Headings the user maps by hand are learned at import (settings.learn).

const registry = require('./registry');
const settings = require('./settings');
const { norm, parseDate, parseNumber, parseBool, parseEnum } = require('./values');
const R = require('./resources');

const PREVIEW_ROWS = 300;
const HEADER_SCAN_ROWS = 60;

const aliasCache = new WeakMap(); // tab definition → Map(field → normalised aliases)
function aliases(T, field) {
  let m = aliasCache.get(T);
  if (!m) { m = new Map(); aliasCache.set(T, m); }
  if (!m.has(field)) {
    const def = T.fields[field];
    m.set(field, [...new Set([norm(field.replace(/_/g, ' ')), norm(def.label), ...(def.aliases || []).map(norm)].filter(Boolean))]);
  }
  return m.get(field);
}

// How well a heading/label matches a field: 1 = exact synonym, ~0.75 = contains it.
function matchScore(heading, list) {
  const h = norm(heading);
  if (!h || h.length > 60) return 0;
  let best = 0;
  for (const a of list) {
    let s = 0;
    if (h === a) s = 1;
    else if (a.length >= 4 && h.replace(/ /g, '') === a.replace(/ /g, '')) s = 0.95; // OCR often drops spaces ("NCRNo")
    else if (a.length >= 3 && ` ${h} `.includes(` ${a} `)) s = 0.75;
    else if (h.length >= 3 && a.length >= 3 && ` ${a} `.includes(` ${h} `) && h.length >= a.length / 2) s = 0.6;
    if (s) s += a.length / 1000; // prefer the more specific synonym
    if (s > best) best = s;
  }
  return best;
}

// docMap: a document type's saved mapping { normalised heading: field | '' (ignore) }
function mapHeaders(T, headers, docMap = {}) {
  const cands = [];
  const forced = headers.map((h) => (Object.hasOwn(docMap, norm(h)) ? docMap[norm(h)] : undefined));
  headers.forEach((h, i) => {
    if (forced[i] !== undefined) {
      if (forced[i] && T.fields[forced[i]]) cands.push({ i, f: forced[i], s: 2 });
      return;
    }
    for (const f of Object.keys(T.fields)) {
      const s = matchScore(h, aliases(T, f));
      if (s > 0) cands.push({ i, f, s });
    }
  });
  cands.sort((a, b) => b.s - a.s || a.i - b.i);
  const mapping = headers.map(() => null); const used = new Set(); let total = 0;
  for (const c of cands) {
    if (mapping[c.i] || used.has(c.f)) continue;
    mapping[c.i] = c.f; used.add(c.f); total += Math.min(c.s, 1);
  }
  return { mapping, total, matched: used.size };
}

function scoreHeader(T, cells, docMap) {
  const nonEmpty = cells.filter((c) => String(c ?? '').trim()).length;
  if (nonEmpty < 2) return null;
  const m = mapHeaders(T, cells.map((c) => String(c ?? '')), docMap);
  if (m.matched < 2) return null;
  const keyHit = T.key.some((k) => m.mapping.includes(k));
  const reqHit = Object.entries(T.fields).filter(([f, d]) => d.required && m.mapping.includes(f)).length;
  return { ...m, score: m.total + (keyHit ? 1 : 0) + reqHit * 0.5, keyHit };
}

const cellsAt = (table, r) => (table.layout ? (table.layout[r]?.cells || []).map((c) => c.text) : table.rows[r] || []).map((c) => String(c ?? '').trim());

// Two-row header: a parent heading (often merged across columns, e.g. "Inspection By")
// over short sub-headings ("S", "GC", "CR"). Returns the combined headings or null.
function combinedHeader(table, r) {
  if (table.layout || r + 1 >= table.rows.length) return null;
  const base = cellsAt(table, r); const sub = cellsAt(table, r + 1);
  const subCells = sub.map((v, i) => [i, v]).filter(([, v]) => v);
  const baseCount = base.filter(Boolean).length;
  if (!subCells.length || subCells.length >= baseCount || subCells.some(([, v]) => v.length > 25)) return null;
  const mergeAt = (i) => (table.merges || []).find((m) => m.r0 <= r && m.r1 >= r && m.c0 <= i && m.c1 >= i && m.c1 > m.c0);
  // every sub-heading must sit under a merged parent or an empty cell next to one
  const parentAt = (i) => {
    const m = mergeAt(i);
    if (m) return cellsAt(table, m.r0)[m.c0] || '';
    if (!base[i]) for (let j = i - 1; j >= 0; j--) if (base[j]) return sub[j] ? base[j] : '';
    return base[i] && (!base[i + 1] && sub[i + 1]) ? base[i] : null;
  };
  if (subCells.some(([i]) => parentAt(i) === null || parentAt(i) === '')) return null;
  const width = Math.max(base.length, sub.length);
  return Array.from({ length: width }, (_, i) => (sub[i] ? `${parentAt(i)} ${sub[i]}`.trim() : base[i] || ''));
}

// Best reading of row r as a header: on its own, or combined with the sub-heading row below.
function headerAt(T, table, r, docMap) {
  const single = cellsAt(table, r);
  const one = scoreHeader(T, single, docMap);
  const combo = combinedHeader(table, r);
  const two = combo ? scoreHeader(T, combo, docMap) : null;
  if (two && (!one || two.score > one.score)) return { ...two, row: r, span: 2, cells: combo };
  return one ? { ...one, row: r, span: 1, cells: single } : null;
}

function findHeader(T, table, docMap) {
  let best = null;
  const limit = Math.min(table.rows.length, table.layout ? 400 : HEADER_SCAN_ROWS);
  for (let r = 0; r < limit; r++) {
    const h = headerAt(T, table, r, docMap);
    if (h && (!best || h.score > best.score)) best = h;
  }
  return best;
}

// A row that only carries a section title ("1. PRE-INSTALLATION"): a merged cell
// across most of the row, a single filled cell, or a section number plus a title.
function isSectionRow(table, rowIndex, filled) {
  if (!filled.length) return false;
  if ((table.merges || []).some((m) => m.r0 === rowIndex && m.c1 - m.c0 >= 2 && m.c0 <= filled[0][0])) return true;
  if (filled.length === 1) return filled[0][1].length > 2;
  return filled.length === 2 && /^\d{1,2}(\.0+)?\.?$/.test(filled[0][1]) && /[A-Za-z]{3}/.test(filled[1][1]);
}

function sectionLabel(filled) {
  const vals = filled.map(([, v]) => v);
  if (vals.length >= 2 && /^\d{1,2}(\.0+)?\.?$/.test(vals[0])) return `${vals[0].replace(/(\.0+)?\.?$/, '')}. ${vals.slice(1).join(' ')}`;
  return vals.join(' ');
}

// Rows under the header, as arrays aligned to the header's columns.
function dataRows(table, headerRow, keyCols, span = 1) {
  if (!table.layout) {
    return table.rows.slice(headerRow + span).map((cells, i) => ({ line: headerRow + span + i + 1, cells }));
  }
  // PDF/OCR: re-split each line by the header's column positions, and fold
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
function convert(T, field, raw) {
  const def = T.fields[field];
  if (raw === null || raw === undefined || String(raw).trim() === '') return { value: null };
  let value;
  // Typical OCR confusions inside dates/numbers: O→0, l/I/|→1, S→5, B→8, spaces around separators.
  const ocrFix = (s) => String(s).replace(/[Oo]/g, '0').replace(/[lI|]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/\s*([/.\-])\s*/g, '$1');
  switch (def.type) {
    case 'date':
      value = parseDate(raw) || (typeof raw === 'string' ? parseDate(ocrFix(raw)) : null);
      if (!value) return { warning: `${def.label}: couldn't read date "${raw}"` };
      break;
    case 'number':
      value = parseNumber(raw);
      if (value === null && typeof raw === 'string' && /^[\dOolIS|B.,\s]+$/.test(raw)) value = parseNumber(ocrFix(raw));
      if (value === null) return { warning: `${def.label}: "${raw}" is not a number` };
      break;
    case 'bool': value = parseBool(raw); if (!value) return { warning: `${def.label}: "${raw}" is not yes/no` }; break;
    case 'enum': {
      const r = parseEnum(def, raw);
      if (!r.value) return { warning: `${def.label}: "${raw}" not recognised${def.default ? `, left as ${def.labels?.[def.default] || def.default}` : ''}` };
      value = r.value; break;
    }
    default: value = typeof raw === 'number' ? String(raw) : String(raw).replace(/\s+/g, ' ').trim();
  }
  try { return { value: R.validateValue(field, { ...def, required: false }, value) }; } catch (err) { return { warning: err.message }; }
}

const keyOf = (T, values) => {
  const parts = T.key.map((k) => norm(values[k] ?? ''));
  return parts.every((p) => !p) ? null : parts.join('|');
};

// Decide create / update / unchanged / skip for each proposed record.
function plan(db, T, proposals) {
  const existing = new Map();
  for (const row of db.prepare(`SELECT * FROM ${T.name}`).all()) {
    const k = keyOf(T, row);
    if (k && !existing.has(k)) existing.set(k, row);
  }
  const seen = new Map();
  const counts = { create: 0, update: 0, unchanged: 0, skip: 0 };
  const rows = proposals.map((p) => {
    const r = { ...p, warnings: [...(p.warnings || [])] };
    const k = keyOf(T, r.values);
    if (k && seen.has(k)) {
      r.action = 'skip'; r.warnings.push(`same ${T.key.map((f) => T.fields[f].label).join(' + ')} as row ${seen.get(k)} in this file`);
    } else if (k && existing.has(k)) {
      const cur = existing.get(k);
      const changes = {};
      for (const [f, v] of Object.entries(r.values)) if (v !== null && v !== cur[f]) changes[f] = { from: cur[f], to: v };
      r.id = cur.id; r.version = cur.version; r.changes = changes;
      r.action = Object.keys(changes).length ? 'update' : 'unchanged';
    } else {
      const missing = Object.entries(T.fields).filter(([f, d]) => d.required && (r.values[f] === null || r.values[f] === undefined)).map(([, d]) => d.label);
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

function keywordHit(keywords, filename, text) {
  const f = ` ${norm(filename)} `; const t = ` ${norm(String(text || '').slice(0, 4000))} `;
  let b = 0;
  for (const kw of keywords || []) {
    const k = norm(kw);
    if (!k) continue;
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

function readFields(T, extracted, docMap = {}) {
  const raw = {}; const found = {};
  for (const [label, value] of labelPairs(extracted)) {
    const forced = docMap[norm(label)];
    let best = null; let bestScore = 0.74;
    if (forced !== undefined) { if (forced && T.fields[forced] && raw[forced] === undefined) best = forced; }
    else {
      for (const f of Object.keys(T.fields)) {
        if (raw[f] !== undefined) continue;
        const s = matchScore(label, aliases(T, f));
        if (s > bestScore) { best = f; bestScore = s; }
      }
    }
    if (best && String(value).trim()) { raw[best] = value; found[best] = label.trim(); }
  }
  const text = extracted.text || '';
  const keyField = T.key[0];
  if (raw[keyField] === undefined && T.keyPattern) {
    const m = T.keyPattern.exec(text);
    if (m) { raw[keyField] = m[0]; found[keyField] = 'pattern in text'; }
  }
  if (T.fields.revision && raw.revision === undefined) {
    const m = /\bRev(?:ision)?\.?\s*[:#-]?\s*([A-Z]?\d{1,2}[A-Z]?|[A-Z])\b/.exec(text);
    if (m) { raw.revision = m[1]; found.revision = 'pattern in text'; }
  }
  const titleField = T.display.find((f) => f !== keyField && T.fields[f]?.required && raw[f] === undefined);
  if (titleField) {
    const first = (extracted.lines || []).map((l) => l.cells.join(' ')).find((l) => l.length > 3 && l.length < 150 && !/[:：]/.test(l));
    if (first) { raw[titleField] = first; found[titleField] = 'first line of document'; }
  }
  const values = {}; const warnings = [];
  for (const [f, v] of Object.entries(raw)) {
    const c = convert(T, f, v);
    if (c.warning) warnings.push(c.warning); else values[f] = c.value;
  }
  return { values, found, warnings, matched: Object.keys(values).length };
}

/* ---------------- document types ---------------- */

function pickDocType(db, opts, extracted) {
  if (opts.docType) return settings.getDocType(db, opts.docType);
  if (opts.tab && opts.tab !== 'auto') return null;
  // auto: a document type whose keywords appear in the file name (or, weaker, in the text)
  let best = null; let bestScore = 0;
  for (const dt of settings.listDocTypes(db)) {
    const s = keywordHit(dt.keywords, opts.filename, extracted.text);
    if (s > bestScore) { best = dt; bestScore = s; }
  }
  return bestScore >= 1.5 ? best : null;
}

/* ---------------- public API ---------------- */

// opts: { tab: 'auto'|name, docType, mode, filename, table, headerRow, mapping, exclude: [line] }
function analyseFull(db, extracted, opts = {}) {
  const reg = registry.load(db);
  const docType = pickDocType(db, opts, extracted);
  const tables = extracted.tables || [];
  const base = {
    kind: extracted.kind,
    ocr: extracted.ocr || null,
    tables: tables.map((t, i) => ({ index: i, name: t.name, rows: t.rows.length })),
    excerpt: String(extracted.text || '').slice(0, 4000),
    docType: docType ? { id: docType.id, name: docType.name, mode: docType.mode } : null,
  };

  if (docType && docType.mode === 'evidence' && !(opts.tab && opts.tab !== 'auto' && opts.tab !== docType.register)) {
    return { ...base, mode: 'evidence', tab: docType.register, tabScores: [], message: `Stored as evidence ("${docType.name}").` };
  }

  const wanted = opts.tab && opts.tab !== 'auto' ? opts.tab : docType?.register || null;
  const names = wanted ? [wanted] : reg.order;
  for (const t of names) R.getTab(db, t);
  const docMap = docType && docType.register === (wanted || docType.register) ? docType.mapping : {};
  const mode = opts.mode || (docType && docType.mode === 'fields' ? 'fields' : null);

  // Score every (register, table) pair.
  const cands = [];
  for (const t of names) {
    const T = reg.tabs[t];
    const bonus = keywordHit(T.keywords, opts.filename, extracted.text);
    if (mode !== 'fields') {
      tables.forEach((table, ti) => {
        const h = findHeader(T, table, docMap);
        if (h) cands.push({ tab: t, table: ti, header: h, score: h.score + bonus });
      });
    }
    if (mode === 'fields' || !tables.length || ['pdf', 'docx', 'image'].includes(extracted.kind)) {
      const f = readFields(T, extracted, docMap);
      if (f.matched >= (mode === 'fields' ? 1 : 2)) cands.push({ tab: t, table: null, fields: f, score: f.matched * 0.6 + bonus + (mode === 'fields' ? 10 : 0) });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  base.tabScores = [];
  for (const c of cands) if (!base.tabScores.find((x) => x.tab === c.tab)) base.tabScores.push({ tab: c.tab, score: Math.round(c.score * 10) / 10 });

  let chosen = cands[0] || null;
  if (wanted && mode !== 'fields' && Number.isInteger(opts.table) && tables[opts.table]) {
    const table = tables[opts.table];
    const T = reg.tabs[wanted];
    const row = Number.isInteger(opts.headerRow) ? opts.headerRow : findHeader(T, table, docMap)?.row;
    if (row !== undefined && row !== null && table.rows[row]) {
      const h = headerAt(T, table, row, docMap);
      const cells = h ? h.cells : cellsAt(table, row);
      chosen = { tab: wanted, table: opts.table, header: { row, span: h ? h.span : 1, cells, ...mapHeaders(T, cells, docMap) } };
    }
  } else if (wanted && mode === 'fields' && (!chosen || chosen.table !== null)) {
    chosen = { tab: wanted, table: null, fields: readFields(reg.tabs[wanted], extracted, docMap) };
  }

  if (!chosen && wanted && mode !== 'fields' && tables.length) {
    // The user picked the register but no heading is recognised yet: offer the
    // biggest table with its first header-like row, so the columns can be mapped
    // by hand (and learned at import).
    const ti = tables.reduce((best, t, i) => (t.rows.length > tables[best].rows.length ? i : best), 0);
    const rows = tables[ti].rows;
    const row = rows.findIndex((r) => r.filter((c) => String(c ?? '').trim()).length >= 2);
    if (row >= 0 && row < rows.length - 1) {
      const T = reg.tabs[wanted];
      const cells = cellsAt(tables[ti], row);
      chosen = { tab: wanted, table: ti, header: { row, span: 1, cells, ...mapHeaders(T, cells, docMap) }, unmatched: true };
    }
  }

  if (!chosen) {
    const f = wanted ? readFields(reg.tabs[wanted], extracted, docMap) : null;
    if (f && f.matched >= 1) chosen = { tab: wanted, table: null, fields: f };
    else {
      return {
        ...base, mode: 'none', tab: wanted,
        message: extracted.ocr && extracted.ocr.error && !(extracted.text || '').trim()
          ? `This looks like a scanned document, but OCR could not read it: ${extracted.ocr.error}. The file is stored as evidence.`
          : extracted.text && extracted.text.trim()
            ? 'Could not find a register table or recognisable fields in this document. It is stored as evidence. Pick a register or document type, check the text below, or teach the register the headings this document uses (Settings → Registers).'
            : 'No readable text was found. If this is a scanned PDF, it needs OCR first (or upload the original Excel/Word file). It is stored as evidence.',
      };
    }
  }

  const T = reg.tabs[chosen.tab];
  if (chosen.table === null) {
    const f = chosen.fields;
    const p = plan(db, T, [{ line: 1, values: f.values, warnings: f.warnings }]);
    return { ...base, mode: 'fields', tab: chosen.tab, found: f.found, record: f.values, ...p };
  }

  const table = tables[chosen.table];
  const headerRow = chosen.header.row;
  const headerSpan = chosen.header.span || 1;
  const headers = (chosen.header.cells || cellsAt(table, headerRow)).map((c) => String(c ?? '').trim());
  const autoMapping = chosen.header.mapping.slice(0, headers.length);
  while (autoMapping.length < headers.length) autoMapping.push(null);
  let mapping = autoMapping;
  if (Array.isArray(opts.mapping)) {
    const usedFields = new Set();
    mapping = headers.map((_, i) => {
      const f = opts.mapping[i];
      if (!f || !Object.hasOwn(T.fields, f) || usedFields.has(f)) return null;
      usedFields.add(f); return f;
    });
  }
  const keyCols = T.key.map((k) => mapping.indexOf(k)).filter((i) => i >= 0);
  const exclude = new Set(opts.exclude || []);

  const proposals = [];
  let section = null; let sections = 0;
  for (const { line, cells } of dataRows(table, headerRow, keyCols, headerSpan)) {
    const filled = cells.map((c, i) => [i, String(c ?? '').trim()]).filter(([, v]) => v);
    if (!filled.length) continue;
    if (T.sectionField && !mapping.includes(T.sectionField) && isSectionRow(table, line - 1, filled)) {
      section = sectionLabel(filled); sections++;
      continue;
    }
    const values = {}; const warnings = [];
    mapping.forEach((f, i) => {
      if (!f) return;
      const c = convert(T, f, cells[i]);
      if (c.warning) warnings.push(c.warning);
      else if (c.value !== null) values[f] = c.value;
    });
    if (!Object.keys(values).length) continue;
    if (T.sectionField && section && (values[T.sectionField] === undefined || values[T.sectionField] === null)) values[T.sectionField] = section;
    proposals.push({ line, values, warnings, excluded: exclude.has(line) });
  }
  const p = plan(db, T, proposals);
  return {
    ...base, mode: 'table', tab: chosen.tab, table: chosen.table, headerRow, headerSpan, headers, mapping, autoMapping, unmatched: !!chosen.unmatched,
    sectionField: T.sectionField && !mapping.includes(T.sectionField) ? T.sectionField : null, sections,
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
  let rows; let tabName; let a = null;
  if (opts.mode === 'fields') {
    tabName = opts.tab;
    const T = R.getTab(db, tabName);
    const values = {}; const warnings = [];
    for (const f of Object.keys(T.fields)) {
      if (opts.record?.[f] === undefined) continue;
      const c = convert(T, f, opts.record[f]);
      if (c.warning) throw new R.HttpError(400, c.warning);
      values[f] = c.value;
    }
    rows = plan(db, T, [{ line: 1, values, warnings }]).rows;
  } else {
    a = analyseFull(db, extracted, { ...opts, filename: upload.filename });
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
        const current = R.strip(db, tabName, db.prepare(`SELECT * FROM ${tabName} WHERE id = ?`).get(r.id));
        const changes = {};
        for (const [f, v] of Object.entries(r.values)) if (v !== null && v !== current[f]) changes[f] = { from: current[f], to: v };
        R.applyUpdate(db, tabName, current, changes, user, { sourceUploadId: upload.id, action: 'import' });
        result.updated++;
      } else if (r.action === 'unchanged') result.unchanged++;
      else result.skipped++;
    }
    const docTypeId = a?.docType?.id || (opts.docType ? Number(opts.docType) : null);
    db.prepare(`UPDATE uploads SET status = 'imported', tab = ?, doc_type_id = COALESCE(?, doc_type_id), summary = ?, imported_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(tabName, docTypeId, JSON.stringify(result), upload.id);
  });

  // Learn from the user's column choices so the next file maps itself.
  if (a) {
    const T = R.getTab(db, tabName);
    result.learned = settings.learn(db, {
      register: tabName, docTypeId: a.docType?.id || null, headers: a.headers, mapping: a.mapping, autoMapping: a.autoMapping, user,
      isKnown: (f, h) => matchScore(h, aliases(T, f)) >= 0.95,
    });
  }
  return result;
}

module.exports = { analyse, commit, mapHeaders, matchScore, findHeader, readFields };

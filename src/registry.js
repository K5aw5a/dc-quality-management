'use strict';

// Register definitions live in the database (table `registers`) so they can be
// edited in the app. src/schema.js only provides the starting set.
//
// Stored definition (JSON):
//   { label, singular, description, keywords[], key[], display[], statusField,
//     due, dueLabel, soonDays, reason, keyPattern, age: { from, label, statuses[]|null },
//     columns: [{ key, label, type, required, max, aliases[], hidden, inList, default,
//                 options: [{ value, label, tone, done, hold, na, aliases[] }] }] }
// compile() turns it into the runtime shape used everywhere else:
//   { name, builtin, label, ..., fields: { key: { label, type, values, labels, tones, map, ... } },
//     computed, list, done[], hold[], na[] }

const { TABS: DEFAULTS, ORDER: DEFAULT_ORDER } = require('./schema');
const { norm } = require('./values');

const TYPES = ['string', 'text', 'enum', 'date', 'number', 'bool', 'url'];
const TONES = ['ok', 'warn', 'bad', 'muted'];
const RESERVED = new Set(['id', 'version', 'created_by', 'created_at', 'updated_at', 'source_upload_id']);

class RegistryError extends Error {}

const slug = (s, max = 40) => norm(s).replace(/ /g, '_').replace(/^(\d)/, 'c_$1').slice(0, max).replace(/_+$/, '') || 'column';

/* ---------- defaults (schema.js) → stored form ---------- */

const AGE_DEFAULTS = {
  submittals: { from: 'date_submitted', label: 'Days in review', statuses: ['submitted', 'under_review'] },
  issues: { from: 'raised_date', label: 'Age (days)', statuses: null },
};

function fromDefault(name) {
  const t = DEFAULTS[name];
  const statusField = Object.keys(t.fields).find((f) => f.endsWith('status') && t.fields[f].type === 'enum') || null;
  const columns = Object.entries(t.fields).map(([key, f]) => {
    const col = {
      key, label: f.label, type: f.type, required: !!f.required, aliases: [...(f.aliases || [])],
      hidden: false, inList: t.list.includes(key),
    };
    if (f.max) col.max = f.max;
    if (f.default !== undefined) col.default = f.default;
    if (f.type === 'enum') {
      col.options = f.values.map((v) => ({
        value: v,
        label: f.labels?.[v] || v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
        tone: f.tones?.[v] || 'muted',
        done: key === statusField && t.done.includes(v),
        hold: key === statusField && t.hold.includes(v),
        na: key === statusField && v === 'n_a',
        aliases: [...(f.map?.[v] || [])],
      }));
    }
    return col;
  });
  return {
    label: t.label, singular: t.singular, description: '', keywords: [...(t.keywords || [])],
    key: [...t.key], display: [...t.display], statusField,
    due: t.due || null, dueLabel: t.dueLabel || null, soonDays: t.soonDays || 14, reason: t.reason || null,
    keyPattern: t.keyPattern ? t.keyPattern.source : null,
    age: AGE_DEFAULTS[name] || null,
    columns,
  };
}

const DESCRIPTIONS = {
  checklist: 'Audit readiness checklist: one row per audit item, with status, owner, gap/action and the evidence to have ready.',
  submittals: 'Technical submittals sent for GC review, their revision and review status, and what is blocking approval.',
  deliveries: 'Purchase orders and expected/actual deliveries, with submittal approval and material inspection (MIR) checks.',
  materials: 'Materials on site: delivered, stored, installed and remaining quantities, expiry and installer/area.',
  itps: 'Inspection and test plans: one row per ITP with revision, approval status and linked checklists.',
  benchmarks: 'Benchmarks / first-of-kind (FOK) installations to be inspected and approved before rollout.',
  issues: 'Issues, snags and non-conformance reports with owner, target date and status.',
  calibration: 'Test and measuring equipment with calibration dates, due dates and certificates.',
  tasks: 'Installer task list: area, task, dates, materials needed and status.',
  sources: 'Map of where each register/tracker lives today and which audit areas it supports.',
};

function defaultDefs() {
  return DEFAULT_ORDER.map((name, i) => ({ name, builtin: name, position: i, def: { ...fromDefault(name), description: DESCRIPTIONS[name] || '' } }));
}

/* ---------- validation of an edited definition ---------- */

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const list = (v, max = 60) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;\n]/)).map((x) => str(x, max)).filter(Boolean);

// Clean a definition coming from the editor. `prev` is the stored definition
// (null for a new register): existing column keys and option values are kept.
function sanitize(input, prev) {
  if (!input || typeof input !== 'object') throw new RegistryError('invalid register definition');
  const label = str(input.label, 80);
  if (!label) throw new RegistryError('the register needs a name');
  const prevCols = new Map((prev?.columns || []).map((c) => [c.key, c]));
  const used = new Set();
  const rename = new Map(); // key sent by the editor (may be temporary, e.g. "new1") → final key
  const columns = [];
  for (const c of Array.isArray(input.columns) ? input.columns.slice(0, 80) : []) {
    const colLabel = str(c.label, 80);
    if (!colLabel) continue;
    let key = c.key && prevCols.has(c.key) ? c.key : null;
    if (!key) {
      let base = slug(colLabel); if (RESERVED.has(base)) base = `${base}_col`;
      key = base; let n = 2;
      while (used.has(key) || prevCols.has(key) || RESERVED.has(key)) key = `${base}_${n++}`;
    }
    if (used.has(key)) continue;
    used.add(key);
    if (c.key) rename.set(String(c.key), key);
    const type = TYPES.includes(c.type) ? c.type : 'string';
    const col = {
      key, label: colLabel, type, required: !!c.required, hidden: !!c.hidden, inList: c.inList !== false,
      aliases: [...new Set(list(c.aliases, 80))].slice(0, 60),
    };
    const max = Number(c.max);
    if (Number.isInteger(max) && max > 0 && max <= 10000) col.max = max;
    if (type === 'enum') {
      const prevOpts = new Map((prevCols.get(key)?.options || []).map((o) => [o.value, o]));
      const seen = new Set();
      col.options = [];
      for (const o of Array.isArray(c.options) ? c.options.slice(0, 40) : []) {
        const oLabel = str(o.label, 60);
        if (!oLabel) continue;
        let value = o.value && prevOpts.has(o.value) ? o.value : null;
        if (!value) { const b = slug(oLabel, 30); value = b; let n = 2; while (seen.has(value) || prevOpts.has(value)) value = `${b}_${n++}`; }
        if (seen.has(value)) continue;
        seen.add(value);
        col.options.push({
          value, label: oLabel, tone: TONES.includes(o.tone) ? o.tone : 'muted',
          done: !!o.done, hold: !!o.hold, na: !!o.na, aliases: [...new Set(list(o.aliases, 60))].slice(0, 40),
        });
      }
      if (!col.options.length) throw new RegistryError(`"${colLabel}" is a status/choice column but has no options`);
      const d = str(c.default, 40);
      if (d && col.options.some((o) => o.value === d)) col.default = d;
    } else if (c.default !== undefined && c.default !== null && c.default !== '') col.default = str(c.default, 200);
    columns.push(col);
  }
  // Columns that were removed in the editor are kept, hidden, so their data survives.
  for (const [key, pc] of prevCols) if (!used.has(key)) columns.push({ ...pc, hidden: true });

  const visible = columns.filter((c) => !c.hidden);
  if (!visible.length) throw new RegistryError('the register needs at least one visible column');
  const rk = (k) => (k === null || k === undefined ? k : rename.get(String(k)) || String(k));
  const isCol = (k, pred = () => true) => visible.some((c) => c.key === k && pred(c));
  const key = [...new Set(list(input.key).map(rk))].filter((k) => isCol(k));
  if (!key.length) throw new RegistryError('choose at least one column that identifies a record (e.g. a reference number)');
  let display = [...new Set(list(input.display).map(rk))].filter((k) => isCol(k));
  if (!display.length) display = key.slice(0, 1);
  const statusField = isCol(rk(input.statusField), (c) => c.type === 'enum') ? rk(input.statusField) : null;
  const due = isCol(rk(input.due), (c) => c.type === 'date') ? rk(input.due) : null;
  const reason = isCol(rk(input.reason)) ? rk(input.reason) : null;
  let age = null;
  if (input.age && isCol(rk(input.age.from), (c) => c.type === 'date')) {
    const statusOpts = statusField ? visible.find((c) => c.key === statusField).options : [];
    // statuses may be sent as option values or (for new options) labels
    const statuses = list(input.age.statuses).map((s) => statusOpts.find((o) => o.value === s || o.label === s)?.value).filter(Boolean);
    age = { from: rk(input.age.from), label: str(input.age.label, 40) || 'Age (days)', statuses: statuses.length ? statuses : null };
  }
  const soon = Number(input.soonDays);
  let keyPattern = str(input.keyPattern, 200) || null;
  if (keyPattern) { try { new RegExp(keyPattern, 'i'); } catch { keyPattern = null; } }
  return {
    label, singular: str(input.singular, 60) || label.replace(/s$/i, ''), description: str(input.description, 1000),
    keywords: [...new Set(list(input.keywords, 60))].slice(0, 30), key, display, statusField, due,
    dueLabel: str(input.dueLabel, 40) || null, soonDays: Number.isInteger(soon) && soon > 0 && soon <= 365 ? soon : 14,
    reason, keyPattern, age, columns,
  };
}

/* ---------- compile stored → runtime ---------- */

function compile(name, builtin, def) {
  const fields = {};
  for (const c of def.columns) {
    if (c.hidden) continue;
    const f = { label: c.label, type: c.type, required: !!c.required, aliases: c.aliases || [] };
    if (c.max) f.max = c.max;
    if (c.default !== undefined) f.default = c.default;
    if (c.type === 'enum') {
      f.values = c.options.map((o) => o.value);
      f.labels = Object.fromEntries(c.options.map((o) => [o.value, o.label]));
      f.tones = Object.fromEntries(c.options.map((o) => [o.value, o.tone]));
      f.map = Object.fromEntries(c.options.map((o) => [o.value, o.aliases || []]));
      if (f.default === undefined && c.required) f.default = f.values[0];
    }
    fields[c.key] = f;
  }
  const status = def.statusField && def.columns.find((c) => c.key === def.statusField);
  const computed = {};
  if (def.age) computed.age_days = { label: def.age.label, type: 'number' };
  if (builtin === 'materials' && fields.delivered_qty) computed.remaining = { label: 'Remaining', type: 'number' };
  if (builtin === 'checklist') computed.evidence_files = { label: 'Files', type: 'number' };
  const list = def.columns.filter((c) => !c.hidden && c.inList).map((c) => c.key);
  // show computed columns right after the field they derive from (or at the end)
  for (const k of Object.keys(computed)) {
    const after = k === 'age_days' ? def.statusField : k === 'remaining' ? 'installed_qty' : null;
    const i = after ? list.indexOf(after) : -1;
    if (i >= 0) list.splice(i + 1, 0, k); else list.push(k);
  }
  let keyPattern = null;
  if (def.keyPattern) { try { keyPattern = new RegExp(def.keyPattern, 'i'); } catch { /* ignore */ } }
  return {
    name, builtin: builtin || null, label: def.label, singular: def.singular, description: def.description || '',
    keywords: def.keywords || [], key: def.key, display: def.display, keyPattern,
    statusField: status ? def.statusField : null,
    due: def.due && fields[def.due] ? def.due : null, dueLabel: def.dueLabel, soonDays: def.soonDays || 14,
    reason: def.reason && fields[def.reason] ? def.reason : null,
    age: def.age && fields[def.age.from] ? def.age : null,
    fields, computed, list,
    done: status ? status.options.filter((o) => o.done).map((o) => o.value) : [],
    hold: status ? status.options.filter((o) => o.hold).map((o) => o.value) : [],
    na: status ? status.options.filter((o) => o.na).map((o) => o.value) : [],
  };
}

/* ---------- loading (cached per database) ---------- */

const caches = new WeakMap();

function load(db) {
  let c = caches.get(db);
  if (c) return c;
  const rows = db.prepare('SELECT * FROM registers ORDER BY archived, position, id').all();
  const tabs = {}; const order = []; const archived = [];
  for (const r of rows) {
    const def = JSON.parse(r.def);
    if (r.archived) { archived.push(r.name); continue; }
    tabs[r.name] = compile(r.name, r.builtin, def);
    order.push(r.name);
  }
  c = { tabs, order, archived, byBuiltin: Object.fromEntries(order.filter((n) => tabs[n].builtin).map((n) => [tabs[n].builtin, n])) };
  caches.set(db, c);
  return c;
}

const invalidate = (db) => caches.delete(db);

module.exports = { load, invalidate, compile, sanitize, defaultDefs, slug, RegistryError, TYPES, TONES };

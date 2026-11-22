'use strict';

// Editing registers and document types, and learning column mappings from imports.

const registry = require('./registry');
const { norm } = require('./values');
const R = require('./resources');

const { HttpError } = R;
const parse = (row) => ({ ...row, def: JSON.parse(row.def) });

function wrap(fn) {
  try { return fn(); } catch (err) {
    if (err instanceof registry.RegistryError) throw new HttpError(400, err.message);
    throw err;
  }
}

function resync(db) {
  require('./db').syncTables(db); // also clears the registry cache
}

/* ---------------- registers ---------------- */

function listRegisters(db) {
  return db.prepare('SELECT * FROM registers ORDER BY archived, position, id').all().map((r) => {
    let records = null;
    try { records = db.prepare(`SELECT COUNT(*) AS n FROM ${r.name}`).get().n; } catch { /* table missing */ }
    const def = JSON.parse(r.def);
    return {
      name: r.name, builtin: r.builtin, archived: !!r.archived, label: def.label, description: def.description,
      columns: def.columns.filter((c) => !c.hidden).length, records, version: r.version, updated_at: r.updated_at, updated_by: r.updated_by,
    };
  });
}

function getRegister(db, name) {
  const row = db.prepare('SELECT * FROM registers WHERE name = ?').get(String(name));
  if (!row) throw new HttpError(404, 'unknown register');
  return parse(row);
}

const STARTER_COLUMNS = [
  { key: 'n1', label: 'Ref', type: 'string', required: true, inList: true, aliases: ['ref', 'reference', 'no', 'number', 'id'] },
  { key: 'n2', label: 'Title', type: 'string', required: true, inList: true, aliases: ['title', 'description', 'name', 'subject'] },
  {
    key: 'n3', label: 'Status', type: 'enum', inList: true, default: 'open', aliases: ['status', 'state'],
    options: [
      { label: 'Open', tone: 'warn', aliases: ['open', 'new', 'pending'] },
      { label: 'On hold', tone: 'bad', hold: true, aliases: ['hold', 'blocked'] },
      { label: 'Closed', tone: 'ok', done: true, aliases: ['closed', 'done', 'complete'] },
    ],
  },
  { key: 'n4', label: 'Owner', type: 'string', inList: true, aliases: ['owner', 'responsible', 'assigned to'] },
  { key: 'n5', label: 'Due date', type: 'date', inList: true, aliases: ['due date', 'due', 'target date'] },
  { key: 'n6', label: 'Notes', type: 'text', inList: false, aliases: ['notes', 'comments', 'remarks'] },
];

function createRegister(db, input, user) {
  return wrap(() => {
    const columns = Array.isArray(input.columns) && input.columns.length ? input.columns : STARTER_COLUMNS;
    const def = registry.sanitize({
      key: ['n1'], display: ['n1', 'n2'], statusField: 'n3', due: 'n5', reason: 'n6', ...input, columns,
    }, null);
    const base = `r_${registry.slug(def.label, 30)}`;
    let name = base; let n = 2;
    const taken = (x) => db.prepare('SELECT 1 FROM registers WHERE name = ?').get(x)
      || db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(x);
    while (taken(name)) name = `${base}_${n++}`;
    const pos = (db.prepare('SELECT MAX(position) AS p FROM registers').get().p ?? -1) + 1;
    R.tx(db, () => {
      const info = db.prepare('INSERT INTO registers (name, def, position, updated_by) VALUES (?, ?, ?, ?)')
        .run(name, JSON.stringify(def), pos, user.username);
      R.logActivity(db, user, 'registers', Number(info.lastInsertRowid), 'create', { label: def.label });
    });
    resync(db);
    return getRegister(db, name);
  });
}

function updateRegister(db, name, input, user) {
  return wrap(() => {
    const cur = getRegister(db, name);
    if (Number(input.version) !== cur.version) throw new HttpError(409, 'this register was changed by someone else; reload and try again');
    const def = registry.sanitize(input.def, cur.def);
    R.tx(db, () => {
      const info = db.prepare(`UPDATE registers SET def = ?, version = version + 1, updated_by = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ? AND version = ?`)
        .run(JSON.stringify(def), user.username, name, cur.version);
      if (info.changes !== 1) throw new HttpError(409, 'this register was changed by someone else; reload and try again');
      R.logActivity(db, user, 'registers', cur.id, 'edit', summarise(cur.def, def));
    });
    resync(db);
    return getRegister(db, name);
  });
}

// Short human summary of what changed in a register definition (for the activity log).
function summarise(a, b) {
  const out = {};
  for (const k of ['label', 'description', 'statusField', 'due', 'reason']) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[k] = { from: a[k], to: b[k] };
  const ak = new Map(a.columns.map((c) => [c.key, c]));
  const added = b.columns.filter((c) => !ak.has(c.key)).map((c) => c.label);
  const hidden = b.columns.filter((c) => c.hidden && ak.has(c.key) && !ak.get(c.key).hidden).map((c) => c.label);
  const changed = b.columns.filter((c) => ak.has(c.key) && JSON.stringify(ak.get(c.key)) !== JSON.stringify(c)).map((c) => c.label);
  if (added.length) out.columns_added = { from: null, to: added.join(', ') };
  if (hidden.length) out.columns_hidden = { from: null, to: hidden.join(', ') };
  if (changed.length) out.columns_changed = { from: null, to: changed.join(', ') };
  return out;
}

function archiveRegister(db, name, archived, user) {
  const cur = getRegister(db, name);
  if (archived && db.prepare('SELECT COUNT(*) AS n FROM registers WHERE archived = 0').get().n <= 1) {
    throw new HttpError(400, 'at least one register must stay active');
  }
  db.prepare('UPDATE registers SET archived = ?, version = version + 1, updated_by = ? WHERE name = ?').run(archived ? 1 : 0, user.username, name);
  R.logActivity(db, user, 'registers', cur.id, archived ? 'archive' : 'restore', null);
  registry.invalidate(db);
  return getRegister(db, name);
}

/* ---------------- document types ---------------- */

const MODES = ['table', 'fields', 'evidence'];

function docTypeOut(row) {
  return { ...row, keywords: JSON.parse(row.keywords || '[]'), mapping: JSON.parse(row.mapping || '{}') };
}

function listDocTypes(db) {
  return db.prepare('SELECT * FROM doc_types ORDER BY name').all().map(docTypeOut);
}

function getDocType(db, id) {
  const row = db.prepare('SELECT * FROM doc_types WHERE id = ?').get(Number(id));
  if (!row) throw new HttpError(404, 'unknown document type');
  return docTypeOut(row);
}

function cleanDocType(db, input) {
  const name = String(input.name ?? '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'the document type needs a name');
  const mode = MODES.includes(input.mode) ? input.mode : 'table';
  const register = input.register ? String(input.register) : null;
  const { tabs } = registry.load(db);
  if (mode !== 'evidence' && (!register || !tabs[register])) throw new HttpError(400, 'choose the register this document type goes into');
  if (register && !tabs[register]) throw new HttpError(400, 'unknown register');
  const keywords = [...new Set((Array.isArray(input.keywords) ? input.keywords : String(input.keywords ?? '').split(/[,;\n]/))
    .map((k) => String(k).trim().slice(0, 60)).filter(Boolean))].slice(0, 30);
  const mapping = {};
  const fields = register ? tabs[register].fields : {};
  for (const [h, f] of Object.entries(input.mapping && typeof input.mapping === 'object' ? input.mapping : {}).slice(0, 300)) {
    const key = norm(h).slice(0, 80);
    if (!key) continue;
    if (f === '' || f === null) mapping[key] = '';
    else if (Object.hasOwn(fields, f)) mapping[key] = f;
  }
  return {
    name, description: String(input.description ?? '').trim().slice(0, 500), register: mode === 'evidence' && !register ? null : register,
    mode, keywords: JSON.stringify(keywords), mapping: JSON.stringify(mapping),
    checklist_ref: String(input.checklist_ref ?? '').trim().slice(0, 32) || null,
  };
}

function uniqueName(db, name, exceptId = null) {
  const row = db.prepare('SELECT id FROM doc_types WHERE name = ?').get(name);
  if (row && row.id !== exceptId) throw new HttpError(400, `a document type called "${name}" already exists`);
}

function createDocType(db, input, user) {
  const d = cleanDocType(db, input);
  uniqueName(db, d.name);
  const info = db.prepare(`INSERT INTO doc_types (name, description, register, mode, keywords, mapping, checklist_ref, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(d.name, d.description, d.register, d.mode, d.keywords, d.mapping, d.checklist_ref, user.username);
  const id = Number(info.lastInsertRowid);
  R.logActivity(db, user, 'doc_types', id, 'create', { name: d.name });
  return getDocType(db, id);
}

function updateDocType(db, id, input, user) {
  const cur = getDocType(db, id);
  if (Number(input.version) !== cur.version) throw new HttpError(409, 'this document type was changed by someone else; reload and try again');
  const d = cleanDocType(db, input);
  uniqueName(db, d.name, cur.id);
  db.prepare(`UPDATE doc_types SET name = ?, description = ?, register = ?, mode = ?, keywords = ?, mapping = ?, checklist_ref = ?,
    version = version + 1, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(d.name, d.description, d.register, d.mode, d.keywords, d.mapping, d.checklist_ref, user.username, cur.id);
  R.logActivity(db, user, 'doc_types', cur.id, 'edit', null);
  return getDocType(db, cur.id);
}

function deleteDocType(db, id, user) {
  const cur = getDocType(db, id);
  db.prepare('DELETE FROM doc_types WHERE id = ?').run(cur.id);
  R.logActivity(db, user, 'doc_types', cur.id, 'delete', { name: cur.name });
}

/* ---------------- learning from an import ---------------- */

// After an import: remember the headings the user mapped by hand.
//  - with a document type: its saved mapping gets every heading → field (or ignored)
//  - always: a heading the register didn't recognise is added to that column's headings
function learn(db, { register, docTypeId, headers, mapping, autoMapping, isKnown, user }) {
  const learned = { docType: 0, register: [] };
  if (docTypeId) {
    const dt = getDocType(db, docTypeId);
    if (dt.register === register) {
      const m = { ...dt.mapping };
      headers.forEach((h, i) => {
        const k = norm(h);
        if (!k) return;
        if (mapping[i]) m[k] = mapping[i];
        else if (autoMapping[i]) m[k] = ''; // the user chose to ignore this column
      });
      if (JSON.stringify(m) !== JSON.stringify(dt.mapping)) {
        db.prepare('UPDATE doc_types SET mapping = ?, version = version + 1 WHERE id = ?').run(JSON.stringify(m), dt.id);
        learned.docType = Object.keys(m).length;
      }
    }
  }
  const row = db.prepare('SELECT * FROM registers WHERE name = ?').get(register);
  if (!row) return learned;
  const def = JSON.parse(row.def);
  let changed = false;
  headers.forEach((h, i) => {
    const f = mapping[i];
    const k = norm(h);
    if (!f || !k || k.length > 60 || isKnown(f, h)) return;
    for (const c of def.columns) {
      const before = (c.aliases || []).length;
      c.aliases = (c.aliases || []).filter((a) => norm(a) !== k);
      if (c.aliases.length !== before) changed = true;
    }
    const col = def.columns.find((c) => c.key === f);
    if (col) { col.aliases.push(String(h).trim().slice(0, 80)); changed = true; learned.register.push(`${h} → ${col.label}`); }
  });
  if (changed) {
    db.prepare('UPDATE registers SET def = ?, version = version + 1, updated_by = ? WHERE id = ?').run(JSON.stringify(def), user.username, row.id);
    R.logActivity(db, user, 'registers', row.id, 'learn', { headings: { from: null, to: learned.register.join('; ') } });
    registry.invalidate(db);
  }
  return learned;
}

module.exports = {
  listRegisters, getRegister, createRegister, updateRegister, archiveRegister,
  listDocTypes, getDocType, createDocType, updateDocType, deleteDocType, learn,
};

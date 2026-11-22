'use strict';

const { TABS, computeRow } = require('./schema');
const { parseDate, parseNumber, parseBool, parseEnum } = require('./values');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message); this.status = status; this.extra = extra;
  }
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function validateValue(field, def, value) {
  if (value === null || value === undefined || value === '') {
    if (def.required) throw new HttpError(400, `${def.label || field} is required`);
    return null;
  }
  switch (def.type) {
    case 'enum': {
      if (def.values.includes(value)) return value;
      const { value: v } = parseEnum(def, value);
      if (!v) throw new HttpError(400, `${def.label || field} must be one of: ${def.values.join(', ')}`);
      return v;
    }
    case 'date': {
      const d = parseDate(value);
      if (!d) throw new HttpError(400, `${def.label || field} must be a date (YYYY-MM-DD or DD/MM/YYYY)`);
      return d;
    }
    case 'number': {
      const n = parseNumber(value);
      if (n === null) throw new HttpError(400, `${def.label || field} must be a number`);
      return n;
    }
    case 'bool': {
      const b = parseBool(value);
      if (!b) throw new HttpError(400, `${def.label || field} must be yes or no`);
      return b;
    }
    case 'url':
      if (typeof value !== 'string' || !/^https?:\/\/\S+$/i.test(value) || value.length > 2000) {
        throw new HttpError(400, `${def.label || field} must be an http(s) URL`);
      }
      return value;
    default: {
      if (typeof value !== 'string' && typeof value !== 'number') throw new HttpError(400, `${def.label || field} must be text`);
      const s = String(value).trim();
      const max = def.max || (def.type === 'text' ? 10000 : 500);
      if (s.length > max) throw new HttpError(400, `${def.label || field} is longer than ${max} characters`);
      if (!s && def.required) throw new HttpError(400, `${def.label || field} is required`);
      return s || null;
    }
  }
}

function getTab(name) {
  if (!Object.hasOwn(TABS, name)) throw new HttpError(404, 'unknown register');
  return TABS[name];
}

function context(db, name) {
  const ctx = { today: today() };
  if (name === 'checklist') {
    ctx.evidence = new Map(db.prepare(`SELECT lower(checklist_ref) AS ref, COUNT(*) AS n FROM uploads
      WHERE checklist_ref IS NOT NULL GROUP BY lower(checklist_ref)`).all().map((r) => [r.ref, r.n]));
  }
  return ctx;
}

const withComputed = (name, rows, ctx) => rows.map((r) => ({ ...r, ...computeRow(name, r, ctx) }));

function logActivity(db, user, resource, recordId, action, changes) {
  db.prepare('INSERT INTO activity (username, resource, record_id, action, changes) VALUES (?, ?, ?, ?, ?)')
    .run(user.username, resource, recordId, action, changes ? JSON.stringify(changes) : null);
}

function all(db, name) {
  getTab(name);
  return withComputed(name, db.prepare(`SELECT * FROM ${name} ORDER BY id`).all(), context(db, name));
}

function list(db, name, query) {
  const tab = getTab(name);
  const where = []; const params = [];
  for (const [field, def] of Object.entries(tab.fields)) {
    if (query.has(field) && ['enum', 'bool', 'date'].includes(def.type)) {
      where.push(`${field} = ?`);
      params.push(validateValue(field, { ...def, required: false }, query.get(field)));
    }
  }
  if (query.get('source_upload_id')) { where.push('source_upload_id = ?'); params.push(Number(query.get('source_upload_id'))); }
  const q = query.get('q');
  if (q) {
    const textFields = Object.entries(tab.fields).filter(([, d]) => ['string', 'text', 'enum'].includes(d.type));
    where.push(`(${textFields.map(([f]) => `${f} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    for (let i = 0; i < textFields.length; i++) params.push(like);
  }
  const rows = db.prepare(`SELECT * FROM ${name} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id LIMIT 5000`).all(...params);
  return withComputed(name, rows, context(db, name));
}

function get(db, name, id) {
  getTab(name);
  const row = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(Number(id));
  if (!row) throw new HttpError(404, 'not found');
  return withComputed(name, [row], context(db, name))[0];
}

function strip(name, row) {
  // drop computed columns before comparing/storing
  const out = { ...row };
  for (const k of Object.keys(TABS[name].computed || {})) delete out[k];
  return out;
}

function create(db, name, body, user, { sourceUploadId = null, action = 'create' } = {}) {
  const tab = getTab(name);
  const values = {};
  for (const [field, def] of Object.entries(tab.fields)) {
    const v = body[field] === undefined || body[field] === null || body[field] === '' ? def.default : body[field];
    values[field] = validateValue(field, def, v);
  }
  const fields = Object.keys(values);
  const info = db.prepare(`INSERT INTO ${name} (${fields.join(', ')}, source_upload_id, created_by)
    VALUES (${fields.map(() => '?').join(', ')}, ?, ?)`).run(...fields.map((f) => values[f]), sourceUploadId, user.username);
  const id = Number(info.lastInsertRowid);
  logActivity(db, user, name, id, action, values);
  return id;
}

function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (err) { db.exec('ROLLBACK'); throw err; }
}

function createOne(db, name, body, user) {
  return get(db, name, tx(db, () => create(db, name, body, user)));
}

// Apply validated changes to a stored row. Returns the change set (may be empty).
function applyUpdate(db, name, current, changes, user, { sourceUploadId, action = 'update' } = {}) {
  const fields = Object.keys(changes);
  if (!fields.length) return changes;
  const sets = fields.map((f) => `${f} = ?`);
  const params = fields.map((f) => changes[f].to);
  if (sourceUploadId) { sets.push('source_upload_id = ?'); params.push(sourceUploadId); }
  const info = db.prepare(`UPDATE ${name} SET ${sets.join(', ')},
      version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND version = ?`).run(...params, current.id, current.version);
  if (info.changes !== 1) throw new HttpError(409, 'this record was changed by someone else; reload and try again');
  logActivity(db, user, name, current.id, action, changes);
  return changes;
}

function diff(name, current, body) {
  const tab = getTab(name);
  const changes = {};
  for (const [field, def] of Object.entries(tab.fields)) {
    if (body[field] === undefined) continue;
    const v = validateValue(field, def, body[field]);
    if (v !== current[field]) changes[field] = { from: current[field], to: v };
  }
  return changes;
}

// Optimistic concurrency: the client sends the version it last saw. If someone
// else saved in between, the update is refused (409) with the current record.
function update(db, name, id, body, user) {
  const version = Number(body.version);
  if (!Number.isInteger(version)) throw new HttpError(400, 'version is required');
  const current = strip(name, get(db, name, id));
  if (current.version !== version) {
    throw new HttpError(409, 'this record was changed by someone else; reload and try again', { current });
  }
  const changes = diff(name, current, body);
  if (Object.keys(changes).length) tx(db, () => applyUpdate(db, name, current, changes, user));
  return get(db, name, id);
}

function remove(db, name, id, user) {
  const current = strip(name, get(db, name, id));
  tx(db, () => {
    db.prepare(`DELETE FROM ${name} WHERE id = ?`).run(current.id);
    logActivity(db, user, name, current.id, 'delete', current);
  });
}

function activity(db, query) {
  const where = []; const params = [];
  if (query.get('resource')) { where.push('resource = ?'); params.push(query.get('resource')); }
  if (query.get('record_id')) { where.push('record_id = ?'); params.push(Number(query.get('record_id'))); }
  return db.prepare(`SELECT * FROM activity ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT 200`).all(...params)
    .map((r) => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : null }));
}

module.exports = {
  HttpError, today, validateValue, getTab, list, all, get, strip, create, createOne,
  applyUpdate, diff, update, remove, activity, tx,
};

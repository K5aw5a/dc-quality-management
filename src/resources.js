'use strict';

const { RESOURCES } = require('./schema');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message); this.status = status; this.extra = extra;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateValue(field, def, value) {
  if (value === null || value === undefined || value === '') {
    if (def.required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  switch (def.type) {
    case 'enum':
      if (!def.values.includes(value)) throw new HttpError(400, `${field} must be one of: ${def.values.join(', ')}`);
      return value;
    case 'date':
      if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
        throw new HttpError(400, `${field} must be a date (YYYY-MM-DD)`);
      }
      return value;
    case 'ref': {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${field} must be a record id`);
      return n;
    }
    case 'url':
      if (typeof value !== 'string' || !/^https?:\/\/\S+$/i.test(value) || value.length > 2000) {
        throw new HttpError(400, `${field} must be an http(s) URL`);
      }
      return value;
    default: {
      if (typeof value !== 'string' && typeof value !== 'number') throw new HttpError(400, `${field} must be text`);
      const s = String(value).trim();
      const max = def.max || (def.type === 'text' ? 10000 : 500);
      if (s.length > max) throw new HttpError(400, `${field} is longer than ${max} characters`);
      if (!s && def.required) throw new HttpError(400, `${field} is required`);
      return s || null;
    }
  }
}

function getResource(name) {
  if (!Object.hasOwn(RESOURCES, name)) throw new HttpError(404, 'unknown resource');
  return RESOURCES[name];
}

function checkRefs(db, res, values) {
  for (const [field, def] of Object.entries(res.fields)) {
    if (def.type === 'ref' && values[field] != null) {
      const exists = db.prepare(`SELECT 1 FROM ${def.ref} WHERE id = ?`).get(values[field]);
      if (!exists) throw new HttpError(400, `${field} refers to a ${def.ref} record that does not exist`);
    }
  }
}

function logActivity(db, user, resource, recordId, action, changes) {
  db.prepare('INSERT INTO activity (username, resource, record_id, action, changes) VALUES (?, ?, ?, ?, ?)')
    .run(user.username, resource, recordId, action, changes ? JSON.stringify(changes) : null);
}

function list(db, name, query) {
  const res = getResource(name);
  const where = []; const params = [];
  for (const [field, def] of Object.entries(res.fields)) {
    if (query.has(field) && ['enum', 'ref', 'date'].includes(def.type)) {
      where.push(`${field} = ?`);
      params.push(validateValue(field, { ...def, required: false }, query.get(field)));
    }
  }
  const q = query.get('q');
  if (q) {
    const textFields = Object.entries(res.fields).filter(([, d]) => ['string', 'text', undefined].includes(d.type));
    where.push(`(${textFields.map(([f]) => `${f} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    for (let i = 0; i < textFields.length; i++) params.push(like);
  }
  const sql = `SELECT * FROM ${name} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY updated_at DESC, id DESC LIMIT 1000`;
  return db.prepare(sql).all(...params);
}

function get(db, name, id) {
  getResource(name);
  const row = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(Number(id));
  if (!row) throw new HttpError(404, 'not found');
  return row;
}

function create(db, name, body, user) {
  const res = getResource(name);
  const values = {};
  for (const [field, def] of Object.entries(res.fields)) {
    const v = body[field] === undefined ? def.default : body[field];
    values[field] = validateValue(field, def, v);
  }
  checkRefs(db, res, values);
  const fields = Object.keys(values);
  db.exec('BEGIN');
  try {
    const info = db.prepare(`INSERT INTO ${name} (${fields.join(', ')}, created_by)
      VALUES (${fields.map(() => '?').join(', ')}, ?)`).run(...fields.map((f) => values[f]), user.username);
    const id = Number(info.lastInsertRowid);
    logActivity(db, user, name, id, 'create', values);
    db.exec('COMMIT');
    return get(db, name, id);
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

// Optimistic concurrency: the client sends the version it last saw. If someone
// else saved in between, the update is refused (409) with the current record,
// instead of silently overwriting their change.
function update(db, name, id, body, user) {
  const res = getResource(name);
  const version = Number(body.version);
  if (!Number.isInteger(version)) throw new HttpError(400, 'version is required');
  const current = get(db, name, id);
  if (current.version !== version) {
    throw new HttpError(409, 'this record was changed by someone else; reload and try again', { current });
  }
  const changes = {};
  for (const [field, def] of Object.entries(res.fields)) {
    if (body[field] === undefined) continue;
    const v = validateValue(field, def, body[field]);
    if (v !== current[field]) changes[field] = { from: current[field], to: v };
  }
  if (!Object.keys(changes).length) return current;
  checkRefs(db, res, Object.fromEntries(Object.entries(changes).map(([f, c]) => [f, c.to])));
  const fields = Object.keys(changes);
  db.exec('BEGIN');
  try {
    const info = db.prepare(`UPDATE ${name} SET ${fields.map((f) => `${f} = ?`).join(', ')},
        version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND version = ?`).run(...fields.map((f) => changes[f].to), current.id, version);
    if (info.changes !== 1) throw new HttpError(409, 'this record was changed by someone else; reload and try again');
    logActivity(db, user, name, current.id, 'update', changes);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return get(db, name, id);
}

function remove(db, name, id, user) {
  const current = get(db, name, id);
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM ${name} WHERE id = ?`).run(current.id);
    logActivity(db, user, name, current.id, 'delete', current);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

function activity(db, query) {
  const where = []; const params = [];
  if (query.get('resource')) { where.push('resource = ?'); params.push(query.get('resource')); }
  if (query.get('record_id')) { where.push('record_id = ?'); params.push(Number(query.get('record_id'))); }
  return db.prepare(`SELECT * FROM activity ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT 200`).all(...params)
    .map((r) => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : null }));
}

module.exports = { HttpError, list, get, create, update, remove, activity };

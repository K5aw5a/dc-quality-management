'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { extractFull, kindOf } = require('./parsers');
const { HttpError } = require('./resources');

// Files are stored by content hash in uploadDir (outside git, next to the DB).
function store(db, uploadDir, { filename, buf, tab, checklistRef, user }) {
  filename = path.basename(String(filename || '').replace(/\\/g, '/')).slice(0, 200) || 'upload';
  let kind;
  try { kind = kindOf(filename, buf); } catch (err) { throw new HttpError(400, err.message); }
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  fs.mkdirSync(uploadDir, { recursive: true });
  const file = path.join(uploadDir, sha256);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  const previous = db.prepare('SELECT id, filename, created_at FROM uploads WHERE sha256 = ? ORDER BY id DESC').get(sha256) || null;
  const info = db.prepare(`INSERT INTO uploads (filename, kind, size, sha256, tab, checklist_ref, status, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, 'stored', ?)`).run(filename, kind, buf.length, sha256, tab || null, checklistRef || null, user.username);
  return { upload: get(db, Number(info.lastInsertRowid)), previous };
}

function get(db, id) {
  const u = db.prepare('SELECT * FROM uploads WHERE id = ?').get(Number(id));
  if (!u) throw new HttpError(404, 'upload not found');
  return { ...u, summary: u.summary ? JSON.parse(u.summary) : null };
}

function list(db) {
  return db.prepare('SELECT * FROM uploads ORDER BY id DESC LIMIT 1000').all()
    .map((u) => ({ ...u, summary: u.summary ? JSON.parse(u.summary) : null }));
}

function read(uploadDir, upload) {
  const file = path.join(uploadDir, upload.sha256);
  if (!/^[0-9a-f]{64}$/.test(upload.sha256) || !fs.existsSync(file)) throw new HttpError(410, 'the stored file is missing');
  return fs.readFileSync(file);
}

// OCR results are cached next to the file (<sha256>.ocr.json) so re-analysing
// (changing the register or column mapping) doesn't re-run OCR.
async function extractUpload(uploadDir, upload) {
  const cacheFile = path.join(uploadDir, `${upload.sha256}.ocr.json`);
  const cache = {
    get() { try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { return null; } },
    set(v) { try { fs.writeFileSync(cacheFile, JSON.stringify(v)); } catch { /* cache is optional */ } },
  };
  try {
    return await extractFull(upload.filename, read(uploadDir, upload), { cache });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(422, `could not read ${upload.filename}: ${err.message}`);
  }
}

function remove(db, uploadDir, id) {
  const u = get(db, id);
  db.prepare('DELETE FROM uploads WHERE id = ?').run(u.id);
  const others = db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE sha256 = ?').get(u.sha256).n;
  if (!others) {
    fs.rmSync(path.join(uploadDir, u.sha256), { force: true });
    fs.rmSync(path.join(uploadDir, `${u.sha256}.ocr.json`), { force: true });
  }
}

module.exports = { store, get, list, read, extractUpload, remove };

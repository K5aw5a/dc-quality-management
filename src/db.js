'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SOURCES_SEED } = require('./schema');
const registry = require('./registry');

// Migrations are append-only. Each runs once, tracked by PRAGMA user_version.
// Register tables themselves are created/extended by syncTables() from schema.js.
const MIGRATIONS = [
  // 1: core tables
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        username TEXT NOT NULL,
        resource TEXT NOT NULL,
        record_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        changes TEXT
      );
      CREATE INDEX IF NOT EXISTS activity_record ON activity(resource, record_id);
    `);
  },
  // 2: v0.1 had generic modules. Keep their data under legacy_* names, then add uploads.
  (db) => {
    const exists = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    for (const t of ['findings', 'inspections', 'trackers', 'documents', 'submittals']) {
      if (exists(t) && !exists(`legacy_${t}`)) {
        db.exec(`ALTER TABLE ${t} RENAME TO legacy_${t}`);
        db.prepare("UPDATE activity SET resource = ? WHERE resource = ?").run(`legacy_${t}`, t);
      }
    }
    db.exec(`
      CREATE TABLE uploads (
        id INTEGER PRIMARY KEY,
        filename TEXT NOT NULL,
        kind TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        tab TEXT,
        checklist_ref TEXT,
        status TEXT NOT NULL DEFAULT 'stored',
        summary TEXT,
        uploaded_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        imported_at TEXT
      );
      CREATE INDEX uploads_sha ON uploads(sha256);
      CREATE INDEX uploads_ref ON uploads(checklist_ref);
    `);
  },
  // 3: registers and document types become editable data
  (db) => {
    db.exec(`
      CREATE TABLE registers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        builtin TEXT,
        def TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE doc_types (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT,
        register TEXT,
        mode TEXT NOT NULL DEFAULT 'table' CHECK (mode IN ('table', 'fields', 'evidence')),
        keywords TEXT NOT NULL DEFAULT '[]',
        mapping TEXT NOT NULL DEFAULT '{}',
        checklist_ref TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      ALTER TABLE uploads ADD COLUMN doc_type_id INTEGER REFERENCES doc_types(id) ON DELETE SET NULL;
    `);
    const ins = db.prepare('INSERT INTO registers (name, builtin, def, position, updated_by) VALUES (?, ?, ?, ?, ?)');
    for (const r of registry.defaultDefs()) ins.run(r.name, r.builtin, JSON.stringify(r.def), r.position, 'system');
    const dt = db.prepare('INSERT INTO doc_types (name, description, register, mode, keywords, updated_by) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [name, desc, reg, mode, kw] of DOC_TYPE_SEED) dt.run(name, desc, reg, mode, JSON.stringify(kw), 'system');
  },
];

// Starter document types (generic; edit in the app).
const DOC_TYPE_SEED = [
  ['Audit checklist workbook', 'The audit readiness checklist (Excel).', 'checklist', 'table', ['audit checklist', 'readiness checklist']],
  ['Submittal register export', 'Submittal log exported from ACC or the GC.', 'submittals', 'table', ['submittal register', 'submittal log', 'transmittal log']],
  ['Issues / NCR export', 'Issues, snags or NCR list exported from ACC.', 'issues', 'table', ['issues export', 'ncr log', 'snag list', 'issues report']],
  ['NCR form', 'A single non-conformance report.', 'issues', 'fields', ['ncr form', 'non conformance report']],
  ['Calibration certificate', 'One certificate for one instrument.', 'calibration', 'fields', ['calibration certificate', 'cal cert', 'certificate of calibration']],
  ['Procedure / reference document', 'Procedures, presentations and method statements, stored as evidence.', null, 'evidence', ['procedure', 'method statement', 'presentation', 'process']],
];

function sqlType(def) {
  return def.type === 'number' ? 'REAL' : 'TEXT';
}

// Additive schema sync: create missing register tables and add missing columns
// (from the stored register definitions). Never drops or changes existing columns.
function syncTables(db) {
  const created = [];
  const exists = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  for (const r of db.prepare('SELECT name, builtin, def FROM registers').all()) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(r.name)) continue; // never build SQL from an unsafe name
    const cols = JSON.parse(r.def).columns.filter((c) => /^[a-z][a-z0-9_]{0,62}$/.test(c.key));
    if (!exists(r.name)) {
      db.exec(`
        CREATE TABLE ${r.name} (
          id INTEGER PRIMARY KEY,
          ${cols.map((c) => `${c.key} ${sqlType(c)}`).join(',\n          ')}${cols.length ? ',' : ''}
          source_upload_id INTEGER REFERENCES uploads(id) ON DELETE SET NULL,
          version INTEGER NOT NULL DEFAULT 1,
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )`);
      created.push(r.builtin || r.name);
    } else {
      const have = new Set(db.prepare(`PRAGMA table_info(${r.name})`).all().map((c) => c.name));
      for (const c of cols) if (!have.has(c.key)) db.exec(`ALTER TABLE ${r.name} ADD COLUMN ${c.key} ${sqlType(c)}`);
    }
  }
  if (created.includes('sources')) {
    const ins = db.prepare('INSERT INTO sources (register, status, location, audit_areas, needed_for_audit, created_by) VALUES (?, ?, ?, ?, ?, ?)');
    for (const row of SOURCES_SEED) ins.run(...row, 'system');
  }
  registry.invalidate(db);
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  db.exec('BEGIN');
  try { syncTables(db); db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); throw err; }
}

module.exports = { openDb, syncTables };

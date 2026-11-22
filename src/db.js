'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { TABS, ORDER, SOURCES_SEED } = require('./schema');

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
];

function sqlType(def) {
  return def.type === 'number' ? 'REAL' : 'TEXT';
}

// Additive schema sync: create missing register tables and add missing columns.
// Never drops or changes existing columns.
function syncTables(db) {
  const created = [];
  for (const name of ORDER) {
    const fields = TABS[name].fields;
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (!exists) {
      const cols = Object.entries(fields).map(([f, d]) => `${f} ${sqlType(d)}`);
      db.exec(`
        CREATE TABLE ${name} (
          id INTEGER PRIMARY KEY,
          ${cols.join(',\n          ')},
          source_upload_id INTEGER REFERENCES uploads(id) ON DELETE SET NULL,
          version INTEGER NOT NULL DEFAULT 1,
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )`);
      created.push(name);
    } else {
      const have = new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
      for (const [f, d] of Object.entries(fields)) {
        if (!have.has(f)) db.exec(`ALTER TABLE ${name} ADD COLUMN ${f} ${sqlType(d)}`);
      }
    }
  }
  if (created.includes('sources')) {
    const ins = db.prepare('INSERT INTO sources (register, status, location, audit_areas, needed_for_audit, created_by) VALUES (?, ?, ?, ?, ?, ?)');
    for (const row of SOURCES_SEED) ins.run(...row, 'system');
  }
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

module.exports = { openDb };

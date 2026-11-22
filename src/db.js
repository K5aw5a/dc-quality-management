'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { RESOURCES, ORDER } = require('./schema');

function columnSql(name, def) {
  if (def.type === 'ref') {
    return `${name} INTEGER REFERENCES ${def.ref}(id) ON DELETE ${def.required ? 'CASCADE' : 'SET NULL'}`;
  }
  return `${name} TEXT`;
}

// Migrations are append-only. Each runs once, tracked by PRAGMA user_version.
const MIGRATIONS = [
  (db) => {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE activity (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        username TEXT NOT NULL,
        resource TEXT NOT NULL,
        record_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        changes TEXT
      );
      CREATE INDEX activity_record ON activity(resource, record_id);
    `);
    for (const name of ORDER) {
      const cols = Object.entries(RESOURCES[name].fields).map(([f, d]) => columnSql(f, d));
      db.exec(`
        CREATE TABLE ${name} (
          id INTEGER PRIMARY KEY,
          ${cols.join(',\n          ')},
          version INTEGER NOT NULL DEFAULT 1,
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
      `);
    }
  },
];

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
}

module.exports = { openDb };

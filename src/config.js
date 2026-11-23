'use strict';

// Settings come from (highest priority first): environment variables, then a
// local.env file in the app folder (not in Git), then defaults.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.join(__dirname, '..');

// KEY=value lines; # comments; optional quotes; %VAR% / $env:VAR expanded on Windows-style paths.
function parseEnvFile(text, env = process.env) {
  const out = {};
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:\$env:)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    v = v.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (all, k) => env[k] ?? all)
      .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (all, k) => env[k] ?? all);
    out[m[1]] = v;
  }
  return out;
}

// Fill process.env from local.env without overriding variables already set.
function loadLocalEnv(file = path.join(APP_DIR, 'local.env')) {
  if (!fs.existsSync(file)) return null;
  const vals = parseEnvFile(fs.readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(vals)) if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
  return file;
}

// Default database location: per-user app data on Windows (outside OneDrive), ./data elsewhere.
function defaultDbPath(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'dc-quality', 'qm.db');
  }
  return path.join(APP_DIR, 'data', 'qm.db');
}

module.exports = { parseEnvFile, loadLocalEnv, defaultDbPath, APP_DIR };

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseEnvFile, defaultDbPath } = require('../src/config');

test('local.env: comments, quotes, PowerShell-style lines and %VAR% expansion', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', USERPROFILE: 'C:\\Users\\me' };
  const v = parseEnvFile([
    '\uFEFF# comment', '', 'PROJECT_NAME=My project', 'LOGO_FILE = "%USERPROFILE%\\Pictures\\logo.png"',
    '$env:DB_PATH = "$env:LOCALAPPDATA\\dc-quality\\qm.db"', 'BAD LINE', "OCR_LANG='en-GB'", 'UNKNOWN=%NOPE%\\x',
  ].join('\r\n'), env);
  assert.equal(v.PROJECT_NAME, 'My project');
  assert.equal(v.LOGO_FILE, 'C:\\Users\\me\\Pictures\\logo.png');
  assert.equal(v.DB_PATH, 'C:\\Users\\me\\AppData\\Local\\dc-quality\\qm.db');
  assert.equal(v.OCR_LANG, 'en-GB');
  assert.equal(v.UNKNOWN, '%NOPE%\\x');
  assert.equal(Object.keys(v).length, 5);
});

test('default database: AppData on Windows, ./data elsewhere', () => {
  assert.equal(defaultDbPath({ LOCALAPPDATA: 'C:\\L' }, 'win32'), path.join('C:\\L', 'dc-quality', 'qm.db'));
  assert.match(defaultDbPath({}, 'linux'), /data[\\/]qm\.db$/);
});

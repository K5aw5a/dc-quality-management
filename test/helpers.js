'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { createUser } = require('../src/auth');

async function startServer() {
  const db = openDb(':memory:');
  createUser(db, 'Admin', 'admin-password-123', 'admin');
  createUser(db, 'member', 'member-password-123', 'member');
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-test-'));
  const server = createApp({ db, uploadDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(p, { method = 'GET', body, cookie, headers = {}, raw = false } = {}) {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(body !== undefined && !isBuf ? { 'Content-Type': 'application/json' } : {}),
        ...(isBuf ? { 'Content-Type': 'application/octet-stream' } : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...headers,
      },
      body: body !== undefined ? (isBuf || typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    if (raw) return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }

  async function loginAs(username, password) {
    const r = await call('/api/login', { method: 'POST', body: { username, password } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.headers.get('set-cookie').split(';')[0];
  }

  const stop = () => { server.close(); db.close(); fs.rmSync(uploadDir, { recursive: true, force: true }); };
  return { db, base, call, loginAs, stop, uploadDir };
}

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));

module.exports = { startServer, fixture };

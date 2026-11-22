'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { createUser } = require('../src/auth');

let server, base, db;

before(async () => {
  db = openDb(':memory:');
  createUser(db, 'Admin', 'admin-password-123', 'admin');
  createUser(db, 'member', 'member-password-123', 'member');
  server = createApp({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); db.close(); });

async function call(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

async function loginAs(username, password) {
  const r = await call('/api/login', { method: 'POST', body: { username, password } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.headers.get('set-cookie').split(';')[0];
}

test('health check is public', async () => {
  assert.equal((await call('/api/health')).status, 200);
});

test('API requires login', async () => {
  assert.equal((await call('/api/submittals')).status, 401);
  assert.equal((await call('/api/schema')).status, 401);
});

test('login rejects bad password and accepts case-insensitive username', async () => {
  assert.equal((await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'nope' } })).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { username: 'ghost', password: 'nope' } })).status, 401);
  const cookie = await loginAs('ADMIN', 'admin-password-123');
  assert.match(cookie, /^qm_session=/);
  const me = await call('/api/me', { cookie });
  assert.equal(me.body.user.username, 'Admin');
});

test('session cookie is HttpOnly and SameSite=Strict', async () => {
  const r = await call('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin-password-123' } });
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
});

test('logout invalidates the session', async () => {
  const cookie = await loginAs('member', 'member-password-123');
  assert.equal((await call('/api/me', { cookie })).status, 200);
  await call('/api/logout', { method: 'POST', body: {}, cookie });
  assert.equal((await call('/api/me', { cookie })).status, 401);
});

test('writes must be JSON (CSRF guard)', async () => {
  const cookie = await loginAs('member', 'member-password-123');
  const r = await call('/api/submittals', {
    method: 'POST', cookie, body: 'ref=X&title=Y',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(r.status, 415);
});

test('submittal CRUD with defaults, validation and filters', async () => {
  const cookie = await loginAs('member', 'member-password-123');
  const bad = await call('/api/submittals', { method: 'POST', cookie, body: { title: 'No ref' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /ref is required/);

  const badEnum = await call('/api/submittals', { method: 'POST', cookie, body: { ref: 'S-1', title: 'x', status: 'maybe' } });
  assert.equal(badEnum.status, 400);

  const created = await call('/api/submittals', {
    method: 'POST', cookie,
    body: { ref: 'SUB-E-001', title: 'UPS datasheet', discipline: 'electrical', due_date: '2026-12-01' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'draft');
  assert.equal(created.body.version, 1);
  assert.equal(created.body.created_by, 'member');

  const filtered = await call('/api/submittals?discipline=electrical&q=UPS', { cookie });
  assert.equal(filtered.body.items.length, 1);
  const none = await call('/api/submittals?status=approved', { cookie });
  assert.equal(none.body.items.length, 0);
});

test('optimistic concurrency blocks stale updates', async () => {
  const cookie = await loginAs('member', 'member-password-123');
  const { body: rec } = await call('/api/trackers', {
    method: 'POST', cookie, body: { tracker: 'punch_list', title: 'Missing blanking panels', location: 'Hall A / Row 3' },
  });
  const first = await call(`/api/trackers/${rec.id}`, { method: 'PATCH', cookie, body: { version: rec.version, status: 'in_progress' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.version, 2);

  const stale = await call(`/api/trackers/${rec.id}`, { method: 'PATCH', cookie, body: { version: rec.version, status: 'closed' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.status, 'in_progress');

  const missingVersion = await call(`/api/trackers/${rec.id}`, { method: 'PATCH', cookie, body: { status: 'closed' } });
  assert.equal(missingVersion.status, 400);
});

test('activity log records who changed what', async () => {
  const cookie = await loginAs('member', 'member-password-123');
  const { body: rec } = await call('/api/inspections', { method: 'POST', cookie, body: { title: 'Generator load bank test', area: 'power' } });
  await call(`/api/inspections/${rec.id}`, { method: 'PATCH', cookie, body: { version: 1, status: 'passed' } });
  const { body } = await call(`/api/activity?resource=inspections&record_id=${rec.id}`, { cookie });
  assert.equal(body.items.length, 2);
  assert.equal(body.items[0].action, 'update');
  assert.deepEqual(body.items[0].changes.status, { from: 'scheduled', to: 'passed' });
  assert.equal(body.items[0].username, 'member');
});

test('references are validated and child records cascade', async () => {
  const cookie = await loginAs('Admin', 'admin-password-123');
  const orphan = await call('/api/findings', { method: 'POST', cookie, body: { inspection_id: 99999, item: 'x' } });
  assert.equal(orphan.status, 400);

  const { body: insp } = await call('/api/inspections', { method: 'POST', cookie, body: { title: 'CRAH audit', area: 'cooling' } });
  const finding = await call('/api/findings', {
    method: 'POST', cookie, body: { inspection_id: insp.id, item: 'Filter differential pressure', result: 'fail', severity: 'major' },
  });
  assert.equal(finding.status, 201);
  const byParent = await call(`/api/findings?inspection_id=${insp.id}`, { cookie });
  assert.equal(byParent.body.items.length, 1);

  assert.equal((await call(`/api/inspections/${insp.id}`, { method: 'DELETE', cookie })).status, 204);
  assert.equal((await call(`/api/findings/${finding.body.id}`, { cookie })).status, 404);
});

test('documents can link to a submittal', async () => {
  const cookie = await loginAs('member', 'member-password-123');
  const { body: sub } = await call('/api/submittals', { method: 'POST', cookie, body: { ref: 'SUB-M-010', title: 'Chiller shop drawings' } });
  const badUrl = await call('/api/documents', { method: 'POST', cookie, body: { title: 'x', url: 'javascript:alert(1)' } });
  assert.equal(badUrl.status, 400);
  const doc = await call('/api/documents', {
    method: 'POST', cookie, body: { title: 'Chiller GA drawing', doc_type: 'drawing', url: 'https://example.com/ga.pdf', submittal_id: sub.id },
  });
  assert.equal(doc.status, 201);
  assert.equal(doc.body.submittal_id, sub.id);
});

test('only admins can delete', async () => {
  const cookie = await loginAs('member', 'member-password-123');
  const { body: rec } = await call('/api/trackers', { method: 'POST', cookie, body: { tracker: 'rfi', title: 'Cable tray height' } });
  assert.equal((await call(`/api/trackers/${rec.id}`, { method: 'DELETE', cookie })).status, 403);
});

test('unknown resources and bad ids return 404', async () => {
  const cookie = await loginAs('member', 'member-password-123');
  assert.equal((await call('/api/users', { cookie })).status, 404);
  assert.equal((await call('/api/sessions', { cookie })).status, 404);
  assert.equal((await call('/api/submittals/abc', { cookie })).status, 404);
  assert.equal((await call('/api/submittals/424242', { cookie })).status, 404);
});

test('static files are served and path traversal is blocked', async () => {
  const index = await fetch(base + '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  const trav = await fetch(base + '/..%2fpackage.json');
  assert.equal(trav.status, 404);
});

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let t;
before(async () => { t = await startServer(); });
after(() => t.stop());

test('health check is public', async () => {
  assert.equal((await t.call('/api/health')).status, 200);
});

test('API requires login', async () => {
  assert.equal((await t.call('/api/submittals')).status, 401);
  assert.equal((await t.call('/api/schema')).status, 401);
  assert.equal((await t.call('/api/dashboard')).status, 401);
  assert.equal((await t.call('/api/uploads')).status, 401);
});

test('login rejects bad password and accepts case-insensitive username', async () => {
  assert.equal((await t.call('/api/login', { method: 'POST', body: { username: 'admin', password: 'nope' } })).status, 401);
  assert.equal((await t.call('/api/login', { method: 'POST', body: { username: 'ghost', password: 'nope' } })).status, 401);
  const cookie = await t.loginAs('ADMIN', 'admin-password-123');
  const me = await t.call('/api/me', { cookie });
  assert.equal(me.body.user.username, 'Admin');
});

test('session cookie is HttpOnly and SameSite=Strict', async () => {
  const r = await t.call('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin-password-123' } });
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
});

test('logout invalidates the session', async () => {
  const cookie = await t.loginAs('member', 'member-password-123');
  assert.equal((await t.call('/api/me', { cookie })).status, 200);
  await t.call('/api/logout', { method: 'POST', body: {}, cookie });
  assert.equal((await t.call('/api/me', { cookie })).status, 401);
});

test('writes must be JSON (CSRF guard)', async () => {
  const cookie = await t.loginAs('member', 'member-password-123');
  const r = await t.call('/api/submittals', {
    method: 'POST', cookie, body: 'ref=X&title=Y',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(r.status, 415);
});

test('schema lists the registers without server-only parts', async () => {
  const cookie = await t.loginAs('member', 'member-password-123');
  const { body } = await t.call('/api/schema', { cookie });
  assert.deepEqual(body.order.slice(0, 3), ['checklist', 'submittals', 'deliveries']);
  assert.equal(body.tabs.itps.keyPattern, undefined);
  assert.equal(body.tabs.submittals.fields.gc_status.tones.approved, 'ok');
});

test('submittal CRUD with defaults, lenient dates and computed days in review', async () => {
  const cookie = await t.loginAs('member', 'member-password-123');
  const bad = await t.call('/api/submittals', { method: 'POST', cookie, body: { title: 'No ref' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Ref is required/);

  const created = await t.call('/api/submittals', {
    method: 'POST', cookie,
    body: { ref: 'SUB-E-001', title: 'UPS datasheet', system: 'EPMS', date_submitted: '01/01/2026', gc_status: 'under_review' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.date_submitted, '2026-01-01');
  assert.equal(created.body.version, 1);
  assert.ok(created.body.age_days > 0); // "Days in review" age rule

  const filtered = await t.call('/api/submittals?gc_status=under_review&q=UPS', { cookie });
  assert.equal(filtered.body.items.length, 1);
});

test('numbers, yes/no and computed remaining on materials', async () => {
  const cookie = await t.loginAs('member', 'member-password-123');
  const r = await t.call('/api/materials', { method: 'POST', cookie, body: { item: 'Cat6 cable', delivered_qty: '1.200,5', installed_qty: 200, location: 'Store A' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.delivered_qty, 1200.5);
  assert.equal(r.body.remaining, 1000.5);
  const d = await t.call('/api/deliveries', { method: 'POST', cookie, body: { item: 'UPS', mir_done: 'Y' } });
  assert.equal(d.body.mir_done, 'yes');
});

test('optimistic concurrency blocks stale updates', async () => {
  const cookie = await t.loginAs('member', 'member-password-123');
  const { body: rec } = await t.call('/api/issues', {
    method: 'POST', cookie, body: { issue_id: 'SN-1', description: 'Missing blanking panels', location: 'Hall A' },
  });
  const first = await t.call(`/api/issues/${rec.id}`, { method: 'PATCH', cookie, body: { version: rec.version, status: 'in_progress' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.version, 2);
  const stale = await t.call(`/api/issues/${rec.id}`, { method: 'PATCH', cookie, body: { version: rec.version, status: 'closed' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.status, 'in_progress');
  assert.equal((await t.call(`/api/issues/${rec.id}`, { method: 'PATCH', cookie, body: { status: 'closed' } })).status, 400);
});

test('activity log records who changed what', async () => {
  const cookie = await t.loginAs('member', 'member-password-123');
  const { body: rec } = await t.call('/api/benchmarks', { method: 'POST', cookie, body: { item: 'Containment FOK', location: 'Hall B' } });
  await t.call(`/api/benchmarks/${rec.id}`, { method: 'PATCH', cookie, body: { version: 1, status: 'approved' } });
  const { body } = await t.call(`/api/activity?resource=benchmarks&record_id=${rec.id}`, { cookie });
  assert.equal(body.items.length, 2);
  assert.deepEqual(body.items[0].changes.status, { from: 'planned', to: 'approved' });
  assert.equal(body.items[0].username, 'member');
});

test('only admins can delete', async () => {
  const cookie = await t.loginAs('member', 'member-password-123');
  const { body: rec } = await t.call('/api/tasks', { method: 'POST', cookie, body: { task: 'Pull cables', area: 'Hall A' } });
  assert.equal((await t.call(`/api/tasks/${rec.id}`, { method: 'DELETE', cookie })).status, 403);
  const admin = await t.loginAs('admin', 'admin-password-123');
  assert.equal((await t.call(`/api/tasks/${rec.id}`, { method: 'DELETE', cookie: admin })).status, 204);
});

test('"where info lives" is seeded', async () => {
  const cookie = await t.loginAs('member', 'member-password-123');
  const { body } = await t.call('/api/sources', { cookie });
  assert.ok(body.items.length >= 10);
  assert.ok(body.items.some((r) => r.register === 'Submittal register'));
});

test('unknown registers and bad ids return 404', async () => {
  const cookie = await t.loginAs('member', 'member-password-123');
  assert.equal((await t.call('/api/users', { cookie })).status, 404);
  assert.equal((await t.call('/api/sessions', { cookie })).status, 404);
  assert.equal((await t.call('/api/legacy_submittals', { cookie })).status, 404);
  assert.equal((await t.call('/api/submittals/abc', { cookie })).status, 404);
  assert.equal((await t.call('/api/submittals/424242', { cookie })).status, 404);
});

test('static files are served and path traversal is blocked', async () => {
  const index = await fetch(t.base + '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(t.base + '/..%2fpackage.json')).status, 404);
  assert.equal((await fetch(t.base + '/%E0%A4%A')).status, 404);
});

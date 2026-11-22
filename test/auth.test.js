'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const auth = require('../src/auth');

test('password hashing round-trips and rejects wrong passwords', () => {
  const h = auth.hashPassword('correct horse battery');
  assert.ok(auth.verifyPassword('correct horse battery', h));
  assert.ok(!auth.verifyPassword('wrong', h));
  assert.ok(!auth.verifyPassword('x', 'garbage'));
});

test('createUser enforces username and password rules', () => {
  const db = openDb(':memory:');
  assert.throws(() => auth.createUser(db, 'a', 'long-enough-pw'), /invalid username/);
  assert.throws(() => auth.createUser(db, 'alice', 'short'), /at least 10/);
  auth.createUser(db, 'alice', 'long-enough-pw');
  assert.throws(() => auth.createUser(db, 'ALICE', 'long-enough-pw'), /UNIQUE/);
});

test('expired sessions are rejected', () => {
  const db = openDb(':memory:');
  auth.createUser(db, 'bob', 'long-enough-pw');
  const { token } = auth.login(db, 'bob', 'long-enough-pw');
  assert.equal(auth.sessionUser(db, token).username, 'bob');
  db.prepare('UPDATE sessions SET expires_at = 0').run();
  assert.equal(auth.sessionUser(db, token), null);
});

test('login limiter blocks after repeated failures', () => {
  const l = new auth.LoginLimiter(3, 60_000);
  for (let i = 0; i < 3; i++) l.fail('1.2.3.4');
  assert.ok(l.blocked('1.2.3.4'));
  assert.ok(!l.blocked('5.6.7.8'));
  l.reset('1.2.3.4');
  assert.ok(!l.blocked('1.2.3.4'));
});

test('migrations are idempotent', () => {
  const db = openDb(':memory:');
  const v = db.prepare('PRAGMA user_version').get().user_version;
  assert.ok(v >= 1);
});

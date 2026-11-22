'use strict';

const crypto = require('node:crypto');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE = 'qm_session';
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createUser(db, username, password, role = 'member') {
  username = String(username || '').trim();
  if (!/^[A-Za-z0-9._@-]{2,64}$/.test(username)) throw new Error('invalid username');
  if (String(password || '').length < 10) throw new Error('password must be at least 10 characters');
  const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), role);
  return Number(info.lastInsertRowid);
}

// Username lookup is case-insensitive (COLLATE NOCASE). A password check runs
// even for unknown users so response time doesn't reveal which usernames exist.
function login(db, username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  const ok = verifyPassword(String(password || ''), user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), user.id, Date.now() + SESSION_TTL_MS);
  return { token, user: publicUser(user) };
}

function sessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), Date.now());
  return row ? publicUser(row) : null;
}

function logout(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role });

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, { secure }) {
  const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secure) attrs.push('Secure');
  attrs.push(token ? `Max-Age=${SESSION_TTL_MS / 1000}` : 'Max-Age=0');
  return attrs.join('; ');
}

// Simple in-memory brute-force guard: 10 failed logins per IP per 15 minutes.
class LoginLimiter {
  constructor(max = 10, windowMs = 15 * 60 * 1000) {
    this.max = max; this.windowMs = windowMs; this.hits = new Map();
  }
  blocked(ip) {
    const e = this.hits.get(ip);
    if (!e) return false;
    if (Date.now() - e.start > this.windowMs) { this.hits.delete(ip); return false; }
    return e.count >= this.max;
  }
  fail(ip) {
    const e = this.hits.get(ip);
    if (!e || Date.now() - e.start > this.windowMs) this.hits.set(ip, { start: Date.now(), count: 1 });
    else e.count++;
  }
  reset(ip) { this.hits.delete(ip); }
}

module.exports = {
  COOKIE, hashPassword, verifyPassword, createUser, login, logout,
  sessionUser, parseCookies, sessionCookie, LoginLimiter,
};

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');
const resources = require('./resources');
const { RESOURCES } = require('./schema');

const { HttpError } = resources;
const MAX_BODY = 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', ...headers,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    // Requiring JSON on every write, together with the SameSite=Strict cookie,
    // blocks cross-site form posts (CSRF) without a token dance.
    if (!type.startsWith('application/json')) return reject(new HttpError(415, 'expected application/json'));
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch { reject(new HttpError(400, 'invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(publicDir, pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(publicDir, rel);
  if (!file.startsWith(path.resolve(publicDir) + path.sep)) return send(res, 404, { error: 'not found' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function createApp({ db, publicDir = path.join(__dirname, '..', 'public'), cookieSecure = false, trustProxy = false }) {
  const limiter = new auth.LoginLimiter();

  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
    const method = req.method;
    const token = auth.parseCookies(req.headers.cookie)[auth.COOKIE];
    const ip = trustProxy
      ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress
      : req.socket.remoteAddress;

    if (parts[0] === 'health' && method === 'GET') return send(res, 200, { ok: true });

    if (parts[0] === 'login' && method === 'POST') {
      if (limiter.blocked(ip)) throw new HttpError(429, 'too many failed logins; try again later');
      const body = await readJson(req);
      const result = auth.login(db, body.username, body.password);
      if (!result) { limiter.fail(ip); throw new HttpError(401, 'invalid username or password'); }
      limiter.reset(ip);
      return send(res, 200, { user: result.user },
        { 'Set-Cookie': auth.sessionCookie(result.token, { secure: cookieSecure }) });
    }

    if (parts[0] === 'logout' && method === 'POST') {
      auth.logout(db, token);
      return send(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie('', { secure: cookieSecure }) });
    }

    // Everything below requires a logged-in user.
    const user = auth.sessionUser(db, token);
    if (!user) throw new HttpError(401, 'login required');

    if (parts[0] === 'me' && method === 'GET') return send(res, 200, { user });
    if (parts[0] === 'schema' && method === 'GET') return send(res, 200, { resources: RESOURCES });
    if (parts[0] === 'activity' && method === 'GET') return send(res, 200, { items: resources.activity(db, url.searchParams) });

    const [name, id] = parts;
    if (!name || parts.length > 2) throw new HttpError(404, 'not found');
    if (id !== undefined && !/^\d+$/.test(id)) throw new HttpError(404, 'not found');

    if (!id && method === 'GET') return send(res, 200, { items: resources.list(db, name, url.searchParams) });
    if (!id && method === 'POST') return send(res, 201, resources.create(db, name, await readJson(req), user));
    if (id && method === 'GET') return send(res, 200, resources.get(db, name, id));
    if (id && method === 'PATCH') return send(res, 200, resources.update(db, name, id, await readJson(req), user));
    if (id && method === 'DELETE') {
      if (user.role !== 'admin') throw new HttpError(403, 'only admins can delete records');
      resources.remove(db, name, id, user);
      return send(res, 204);
    }
    throw new HttpError(405, 'method not allowed');
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      return serveStatic(publicDir, url.pathname, res);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
      console.error(err);
      return send(res, 500, { error: 'internal error' });
    }
  });
}

module.exports = { createApp };

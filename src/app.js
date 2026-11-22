'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const auth = require('./auth');
const resources = require('./resources');
const uploads = require('./uploads');
const importer = require('./importer');
const { dashboard } = require('./dashboard');
const { writeXlsx } = require('./parsers/xlsx');
const { TABS, ORDER } = require('./schema');

const { HttpError } = resources;
const MAX_JSON = 1024 * 1024;
const MAX_UPLOAD = 25 * 1024 * 1024;
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

// Schema as sent to the browser (no regexes / server-only parts).
const PUBLIC_SCHEMA = JSON.parse(JSON.stringify(
  Object.fromEntries(ORDER.map((t) => {
    const { keyPattern, keywords, ...rest } = TABS[t];
    return [t, rest];
  })),
));

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', ...headers,
  });
  res.end(payload);
}

function sendFile(res, buf, filename, type = 'application/octet-stream') {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new HttpError(413, `file is larger than ${Math.round(max / 1048576)} MB`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  // Requiring JSON on every write, together with the SameSite=Strict cookie,
  // blocks cross-site form posts (CSRF) without a token dance.
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'expected application/json');
  const buf = await readBody(req, MAX_JSON);
  try {
    const body = JSON.parse(buf.toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new HttpError(400, 'invalid JSON body'); }
}

function serveStatic(publicDir, pathname, res) {
  let rel;
  try { rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { return send(res, 404, { error: 'not found' }); }
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

function exportSheet(db, tabName, { empty = false } = {}) {
  const tab = TABS[tabName];
  const cols = [
    ...Object.entries(tab.fields).map(([f, d]) => ({ key: f, header: d.label, type: d.type })),
    ...(empty ? [] : Object.entries(tab.computed || {}).map(([f, d]) => ({ key: f, header: d.label, type: d.type }))),
  ];
  const label = (f, v) => {
    const d = tab.fields[f];
    if (d?.type === 'enum' && v) return d.labels?.[v] || v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    return v;
  };
  const rows = empty ? [] : resources.all(db, tabName).map((r) => cols.map((c) => label(c.key, r[c.key])));
  return { name: tab.label, columns: cols, rows };
}

function createApp({
  db, publicDir = path.join(__dirname, '..', 'public'), uploadDir = path.join(os.tmpdir(), 'dc-quality-uploads'),
  cookieSecure = false, trustProxy = false, projectName = 'Quality Management',
}) {
  const limiter = new auth.LoginLimiter();

  async function handleUploads(req, res, url, parts, user) {
    const method = req.method;
    const [, id, action] = parts;
    if (!id) {
      if (method === 'GET') return send(res, 200, { items: uploads.list(db) });
      if (method === 'POST') {
        if (!String(req.headers['content-type'] || '').startsWith('application/octet-stream')) throw new HttpError(415, 'expected application/octet-stream');
        const tab = url.searchParams.get('tab') || 'auto';
        if (tab !== 'auto' && tab !== 'evidence') resources.getTab(tab);
        const buf = await readBody(req, MAX_UPLOAD);
        if (!buf.length) throw new HttpError(400, 'empty file');
        const { upload, previous } = uploads.store(db, uploadDir, {
          filename: url.searchParams.get('filename'), buf, user,
          tab: tab === 'auto' ? null : tab,
          checklistRef: (url.searchParams.get('checklist_ref') || '').slice(0, 32) || null,
        });
        let analysis = null;
        if (tab !== 'evidence') {
          try {
            analysis = importer.analyse(db, uploads.extractUpload(uploadDir, upload), { tab, filename: upload.filename });
            db.prepare("UPDATE uploads SET status = 'analysed', tab = COALESCE(tab, ?) WHERE id = ?").run(analysis.tab, upload.id);
          } catch (err) {
            if (!(err instanceof HttpError)) throw err;
            db.prepare("UPDATE uploads SET status = 'failed', summary = ? WHERE id = ?").run(JSON.stringify({ error: err.message }), upload.id);
            analysis = { mode: 'error', message: err.message };
          }
        }
        return send(res, 201, { upload: uploads.get(db, upload.id), previous, analysis });
      }
      throw new HttpError(405, 'method not allowed');
    }
    if (!/^\d+$/.test(id)) throw new HttpError(404, 'not found');
    const upload = uploads.get(db, id);
    if (!action && method === 'GET') return send(res, 200, upload);
    if (!action && method === 'DELETE') {
      if (user.role !== 'admin') throw new HttpError(403, 'only admins can delete uploads');
      uploads.remove(db, uploadDir, id);
      return send(res, 204);
    }
    if (!action && method === 'PATCH') {
      const body = await readJson(req);
      const ref = body.checklist_ref === null || body.checklist_ref === '' ? null : String(body.checklist_ref ?? upload.checklist_ref ?? '').slice(0, 32);
      db.prepare('UPDATE uploads SET checklist_ref = ? WHERE id = ?').run(ref, upload.id);
      return send(res, 200, uploads.get(db, id));
    }
    if (action === 'file' && method === 'GET') return sendFile(res, uploads.read(uploadDir, upload), upload.filename);
    if (action === 'analyse' && method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, importer.analyse(db, uploads.extractUpload(uploadDir, upload), { ...body, filename: upload.filename }));
    }
    if (action === 'import' && method === 'POST') {
      const body = await readJson(req);
      if (!body.tab) throw new HttpError(400, 'tab is required');
      resources.getTab(body.tab);
      const extracted = body.mode === 'fields' ? null : uploads.extractUpload(uploadDir, upload);
      return send(res, 200, importer.commit(db, user, upload, extracted, body));
    }
    throw new HttpError(404, 'not found');
  }

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

    if (method === 'GET' && parts.length === 1) {
      if (parts[0] === 'me') return send(res, 200, { user, project: projectName });
      if (parts[0] === 'schema') return send(res, 200, { tabs: PUBLIC_SCHEMA, order: ORDER });
      if (parts[0] === 'dashboard') return send(res, 200, dashboard(db));
      if (parts[0] === 'activity') return send(res, 200, { items: resources.activity(db, url.searchParams) });
      if (parts[0] === 'export.xlsx') {
        const stamp = resources.today();
        return sendFile(res, writeXlsx(ORDER.map((t) => exportSheet(db, t))), `quality-registers-${stamp}.xlsx`,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      }
    }
    if (parts[0] === 'uploads') return handleUploads(req, res, url, parts, user);

    const [name, id] = parts;
    if (!name || parts.length > 2) throw new HttpError(404, 'not found');
    if (id === 'export.xlsx' || id === 'template.xlsx') {
      resources.getTab(name);
      const empty = id === 'template.xlsx';
      const fname = `${TABS[name].label.replace(/[^\w]+/g, '-').toLowerCase()}${empty ? '-template' : `-${resources.today()}`}.xlsx`;
      return sendFile(res, writeXlsx([exportSheet(db, name, { empty })]), fname,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }
    if (id !== undefined && !/^\d+$/.test(id)) throw new HttpError(404, 'not found');

    if (!id && method === 'GET') return send(res, 200, { items: resources.list(db, name, url.searchParams) });
    if (!id && method === 'POST') return send(res, 201, resources.createOne(db, name, await readJson(req), user));
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

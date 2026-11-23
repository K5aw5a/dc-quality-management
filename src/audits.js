'use strict';

// Audit records: a read-only view of the quality audits (preparation, areas,
// findings, action list). The record is written outside the app (prepared in
// chat as audit-record.json) and loaded by uploading the file; the app keeps
// every version and shows the latest. There is no in-app editing on purpose.

const { HttpError } = require('./resources');

const TONES = ['ok', 'warn', 'bad', 'none', 'info'];
const MAX_BYTES = 2 * 1024 * 1024;

const str = (v, max = 2000) => (v === null || v === undefined ? '' : String(v)).slice(0, max);
const arr = (v, max = 200) => (Array.isArray(v) ? v.slice(0, max) : []);
const strs = (v, max = 50) => arr(v, max).map((s) => str(s)).filter(Boolean);
const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const tone = (t) => (TONES.includes(t) ? t : 'none');
const status = (s) => {
  if (Array.isArray(s) && s[0]) return [str(s[0], 40), tone(s[1])];
  if (s && typeof s === 'object' && s.label) return [str(s.label, 40), tone(s.tone)];
  return null;
};

// Accepts the JSON written in chat and returns a cleaned copy (only known fields).
function normalise(input) {
  if (!input || typeof input !== 'object' || input.type !== 'audit-record') {
    throw new HttpError(400, 'this JSON file is not an audit record (expected "type": "audit-record")');
  }
  const audits = arr(input.audits, 50).map((a, i) => ({
    id: str(a.id, 40) || `audit-${i + 1}`,
    title: str(a.title, 120) || `Audit ${i + 1}`,
    kind: str(a.kind, 200),
    date: date(a.date),
    status: status(a.status) || ['', 'none'],
    prep: arr(a.prep).map((p) => ({ text: str(p.text), area: Number.isInteger(p.area) ? p.area : null, done: !!p.done })).filter((p) => p.text),
    areas: arr(a.areas, 60).map((x, j) => ({
      n: Number.isInteger(x.n) ? x.n : j + 1,
      name: str(x.name, 200),
      status: status(x.status),
      say: strs(x.say), show: strs(x.show), notes: strs(x.notes), ask: strs(x.ask),
      gaps: arr(x.gaps, 50).map((g) => (Array.isArray(g) ? g.slice(0, 3).map((s) => str(s, 500)) : [str(g, 500), '', ''])),
    })).filter((x) => x.name),
    findings: arr(a.findings, 500).map((f) => ({ area: str(f.area, 40), finding: str(f.finding), type: status(f.type) })).filter((f) => f.finding),
    actions: arr(a.actions, 1000).map((x) => ({
      ref: str(x.ref, 40), action: str(x.action), area: str(x.area, 40), owner: str(x.owner, 200),
      due: date(x.due), status: status(x.status),
    })).filter((x) => x.action),
  }));
  if (!audits.length) throw new HttpError(400, 'the audit record has no audits');
  const c = input.context && typeof input.context === 'object' ? input.context : {};
  return {
    type: 'audit-record',
    updated: date(input.updated),
    context: { project: str(c.project, 100), client: str(c.client, 100), scope: str(c.scope, 200), qualityPlan: str(c.qualityPlan, 200) },
    audits,
  };
}

function parse(buf) {
  if (buf.length > MAX_BYTES) throw new HttpError(413, 'audit record is larger than 2 MB');
  let json;
  try { json = JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); } catch { throw new HttpError(400, 'the file is not valid JSON'); }
  return normalise(json);
}

function save(db, record, upload, user) {
  const info = db.prepare('INSERT INTO audit_records (data, upload_id, uploaded_by) VALUES (?, ?, ?)')
    .run(JSON.stringify(record), upload?.id ?? null, user.username);
  db.prepare("UPDATE uploads SET status = 'imported', summary = ?, imported_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(JSON.stringify({ auditRecord: true, audits: record.audits.length, version: Number(info.lastInsertRowid) }), upload?.id ?? -1);
  return Number(info.lastInsertRowid);
}

function latest(db) {
  const row = db.prepare('SELECT * FROM audit_records ORDER BY id DESC LIMIT 1').get();
  if (!row) return { record: null, versions: 0 };
  const versions = db.prepare('SELECT COUNT(*) AS n FROM audit_records').get().n;
  return { record: JSON.parse(row.data), version: row.id, versions, loadedAt: row.created_at, loadedBy: row.uploaded_by, uploadId: row.upload_id };
}

function summary(record) {
  const a = record.audits;
  const open = a.reduce((n, x) => n + x.actions.filter((y) => y.status?.[1] !== 'ok').length, 0);
  return `${a.length} audit${a.length === 1 ? '' : 's'} · ${a.reduce((n, x) => n + x.areas.length, 0)} areas · ${a.reduce((n, x) => n + x.findings.length, 0)} findings · ${open} open actions`;
}

module.exports = { parse, normalise, save, latest, summary };

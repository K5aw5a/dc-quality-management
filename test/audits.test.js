'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { normalise } = require('../src/audits');

// Synthetic record (no real project data).
const record = (over = {}) => ({
  type: 'audit-record',
  updated: '2026-11-23',
  context: { project: 'Demo', client: 'Client X', scope: 'BMS', qualityPlan: 'Rev 1' },
  audits: [{
    id: 'audit-1', title: 'Audit 1', kind: 'First client audit', date: '2026-11-23',
    status: { label: 'Audit day', tone: 'warn' },
    prep: [{ text: 'Set ITP date', area: 2, done: false }, { text: 'Check numbers', area: 5, done: true }],
    areas: [
      { n: 1, name: 'Quality plan', status: ['Ready', 'ok'], say: ['Approved'], ask: ['Appendix only?'] },
      { n: 2, name: 'ITPs', status: ['Gap', 'bad'], say: ['Submission by {date}'], gaps: [['ITP pack', '{owner}', '{date}']] },
    ],
    findings: [], actions: [],
  }],
  ...over,
});

let t; let cookie;
before(async () => { t = await startServer(); cookie = await t.loginAs('member', 'member-password-123'); });
after(() => t.stop());

const upload = (name, obj) => t.call(`/api/uploads?filename=${encodeURIComponent(name)}`, {
  method: 'POST', cookie, body: Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)),
});

test('no record yet: the Audits API says so', async () => {
  const r = await t.call('/api/audits', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.body.record, null);
});

test('uploading audit-record.json loads it; each upload is a new version', async () => {
  const r = await upload('audit-record.json', record());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.analysis.mode, 'audit-record');
  assert.match(r.body.analysis.summary, /1 audit · 2 areas/);

  let a = (await t.call('/api/audits', { cookie })).body;
  assert.equal(a.versions, 1);
  assert.equal(a.record.audits[0].areas[1].gaps[0][1], '{owner}');

  const withActions = record();
  withActions.audits[0].actions = [{ ref: 'A1', action: 'Issue ITP register', area: '2', owner: 'QM', due: '2026-12-05', status: ['Open', 'warn'] }];
  withActions.audits[0].findings = [{ area: '2', finding: 'ITP register missing', type: ['Minor', 'warn'] }];
  await upload('audit-record.json', withActions);
  a = (await t.call('/api/audits', { cookie })).body;
  assert.equal(a.versions, 2);
  assert.equal(a.record.audits[0].actions[0].due, '2026-12-05');
  assert.equal(a.record.audits[0].findings.length, 1);
});

test('the uploaded file is kept and listed as an audit record', async () => {
  const files = (await t.call('/api/uploads', { cookie })).body.items;
  const f = files.find((x) => x.filename === 'audit-record.json');
  assert.equal(f.kind, 'json');
  assert.equal(f.summary.auditRecord, true);
});

test('other JSON and broken files are refused with a clear message', async () => {
  assert.match((await upload('x.json', { hello: 1 })).body.error, /not an audit record/);
  assert.match((await upload('x.json', '{not json')).body.error, /not valid JSON/);
  assert.match((await upload('x.json', { type: 'audit-record', audits: [] })).body.error, /no audits/);
});

test('unknown fields are dropped, tones and dates are checked, text stays text', () => {
  const n = normalise(record({ evil: '<script>', audits: [{ title: '<img src=x onerror=alert(1)>', date: 'tomorrow', status: ['X', 'neon'], areas: [{ name: 'A', status: ['S', 'nope'], say: ['<b>hi</b>'] }], extra: 1 }] }));
  assert.equal(n.evil, undefined);
  assert.equal(n.audits[0].extra, undefined);
  assert.equal(n.audits[0].date, null);
  assert.deepEqual(n.audits[0].status, ['X', 'none']);
  assert.equal(n.audits[0].areas[0].say[0], '<b>hi</b>'); // rendered with textContent in the browser
});

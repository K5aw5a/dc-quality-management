'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, fixture } = require('./helpers');
const { extract } = require('../src/parsers');
const { analyse } = require('../src/importer');
const { openDb } = require('../src/db');

let t; let cookie;
before(async () => { t = await startServer(); cookie = await t.loginAs('member', 'member-password-123'); });
after(() => t.stop());

test('ITP Excel: two-row header, 8 merged section rows, point codes', async () => {
  const r = await t.call('/api/uploads?filename=ITP%20rev%2002.xlsx', { method: 'POST', cookie, body: fixture('itp.xlsx') });
  const a = r.body.analysis;
  assert.equal(a.tab, 'itp_activities');
  assert.equal(a.headerRow, 3);
  assert.equal(a.headerSpan, 2);
  assert.deepEqual(a.headers.slice(5, 8), ['Inspection By S', 'Inspection By GC', 'Inspection By CR']);
  assert.deepEqual(a.mapping, ['item_no', 'activity', 'controlling_document', 'requirement', 'frequency', 'insp_s', 'insp_gc', 'insp_cr', 'verifying_document']);
  assert.equal(a.sections, 8);
  assert.equal(a.sectionField, 'section');
  assert.deepEqual(a.counts, { create: 16, update: 0, unchanged: 0, skip: 0 });
  const first = a.rows[0].values;
  assert.equal(first.section, '1. PRE-INSTALLATION');
  assert.deepEqual([first.insp_s, first.insp_gc, first.insp_cr], ['h', 'w', 'r']);
  assert.equal(a.rows[15].values.section, '8. HANDOVER');

  const imp = await t.call(`/api/uploads/${r.body.upload.id}/import`, { method: 'POST', cookie, body: { tab: 'itp_activities' } });
  assert.equal(imp.body.created, 16);
  const items = (await t.call('/api/itp_activities?insp_s=h', { cookie })).body.items;
  assert.equal(items.length, 8, 'one hold point per section for the subcontractor');

  // uploading the same ITP again: updates in place, no duplicates
  const again = await t.call('/api/uploads?filename=ITP%20rev%2002.xlsx', { method: 'POST', cookie, body: fixture('itp.xlsx') });
  assert.deepEqual(again.body.analysis.counts, { create: 0, update: 0, unchanged: 16, skip: 0 });
});

test('ITP as CSV: no merged cells, "1 | SECTION" rows, sub-headings under an empty parent cell', () => {
  const csv = [
    'Item No.,Activity,Controlling Document,Requirement,Frequency,Inspection By,,,Verifying Document',
    ',,,,,S,GC,CR,',
    '1,PRE-INSTALLATION,,,,,,,',
    '1.1,Review drawings,Spec 26,Approved,Once,R,R,R,Transmittal',
    '1.2,Check site readiness,Spec 26,Clear access,Each area,H,W,,Checklist A',
    '2,INSTALLATION,,,,,,,',
    '2.1,Fix containment,Spec 26,Per drawings,10%,W,M,,Checklist B',
  ].join('\n');
  const a = analyse(openDb(':memory:'), extract('itp.csv', Buffer.from(csv)), { tab: 'itp_activities' });
  assert.equal(a.headerSpan, 2);
  assert.deepEqual(a.mapping.slice(5, 8), ['insp_s', 'insp_gc', 'insp_cr']);
  assert.equal(a.sections, 2);
  assert.deepEqual(a.rows.map((r) => [r.values.item_no, r.values.section]), [['1.1', '1. PRE-INSTALLATION'], ['1.2', '1. PRE-INSTALLATION'], ['2.1', '2. INSTALLATION']]);
  assert.equal(a.rows[1].values.insp_cr, undefined);
});

test('a single-row header is not mistaken for a two-row one', () => {
  const csv = 'Item No.,Activity,Frequency\n1.1,Check,Once\n1.2,Test,Each\n';
  const a = analyse(openDb(':memory:'), extract('x.csv', Buffer.from(csv)), { tab: 'itp_activities' });
  assert.equal(a.headerSpan, 1);
  assert.equal(a.rows.length, 2);
});

test('existing databases get the ITP activities register after the ITP register', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qm-itp-')), 'old.db');
  let db = openDb(file);
  db.exec("DELETE FROM registers WHERE name = 'itp_activities'; DELETE FROM doc_types WHERE name = 'ITP activity table'; PRAGMA user_version = 4;");
  db.close();
  db = openDb(file);
  const order = db.prepare('SELECT name FROM registers ORDER BY position').all().map((r) => r.name);
  assert.equal(order[order.indexOf('itps') + 1], 'itp_activities');
  assert.ok(db.prepare("SELECT 1 FROM doc_types WHERE name = 'ITP activity table'").get());
  db.close();
});

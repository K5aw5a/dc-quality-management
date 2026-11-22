'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, fixture } = require('./helpers');
const { extract } = require('../src/parsers');
const { readXlsx, writeXlsx } = require('../src/parsers/xlsx');
const { parseCsvText, decodeText } = require('../src/parsers/csv');
const { parseDate, parseNumber, parseBool, parseEnum } = require('../src/values');
const { TABS } = require('../src/schema');
const { openDb } = require('../src/db');

/* ---------- value parsing ---------- */

test('dates: day-first, ISO, Excel serials, month names (EN/ES)', () => {
  assert.equal(parseDate('17/09/2026'), '2026-09-17');
  assert.equal(parseDate('17-09-26'), '2026-09-17');
  assert.equal(parseDate('2026-09-17'), '2026-09-17');
  assert.equal(parseDate('09/17/2026'), '2026-09-17'); // unambiguous month-first
  assert.equal(parseDate('17 Sep 2026'), '2026-09-17');
  assert.equal(parseDate('17-sept-2026'), '2026-09-17');
  assert.equal(parseDate('17 de septiembre de 2026'), '2026-09-17');
  assert.equal(parseDate('Sep 17, 2026'), '2026-09-17');
  assert.equal(parseDate(46282), '2026-09-17');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('soon'), null);
});

test('numbers in EU and UK formats', () => {
  assert.equal(parseNumber('1.234,5'), 1234.5);
  assert.equal(parseNumber('1,234.5'), 1234.5);
  assert.equal(parseNumber('12,5'), 12.5);
  assert.equal(parseNumber('1,250'), 1250);
  assert.equal(parseNumber('12 pcs'), 12);
  assert.equal(parseNumber('n/a'), null);
});

test('yes/no and status wording', () => {
  assert.equal(parseBool('Y'), 'yes');
  assert.equal(parseBool('✓'), 'yes');
  assert.equal(parseBool('Pending'), 'no');
  const gc = TABS.submittals.fields.gc_status;
  assert.equal(parseEnum(gc, 'Code B').value, 'approved_as_noted');
  assert.equal(parseEnum(gc, 'Approved with comments').value, 'approved_as_noted');
  assert.equal(parseEnum(gc, 'Revise & Resubmit').value, 'revise_resubmit');
  assert.equal(parseEnum(gc, 'Pending GC review').value, 'under_review');
  assert.equal(parseEnum(gc, 'Banana').value, null);
  assert.equal(parseEnum(TABS.checklist.fields.status, 'N/A').value, 'n_a');
});

/* ---------- readers ---------- */

test('xlsx reader: header below a summary block, formulas, round trip with writer', () => {
  const x = readXlsx(fixture('checklist.xlsx'));
  const rows = x.tables[0].rows;
  assert.equal(rows[7][0], 'Ref');
  assert.equal(rows[8][0], '1.1');
  assert.equal(rows[9][3], 'Partial');

  const buf = writeXlsx([{ name: 'Test', columns: [{ header: 'Ref' }, { header: 'Due', type: 'date' }, { header: 'Qty', type: 'number' }], rows: [['A-1', '2026-09-17', 3], ['A-2 & <x>', null, 1.5]] }]);
  const back = readXlsx(buf).tables[0].rows;
  assert.deepEqual(back[0], ['Ref', 'Due', 'Qty']);
  assert.deepEqual(back[1], ['A-1', '2026-09-17', 3]);
  assert.deepEqual(back[2], ['A-2 & <x>', '', 1.5]);
});

test('csv reader: semicolons, quotes and Windows-1252', () => {
  const rows = parseCsvText('Ref;Title;Status\r\nS-1;"Cable; tray ""A""";Open\n');
  assert.deepEqual(rows[1], ['S-1', 'Cable; tray "A"', 'Open']);
  assert.equal(decodeText(Buffer.from([0x43, 0x61, 0x66, 0xe9])), 'Café');
});

test('docx reader: paragraphs and tables', () => {
  const d = extract('cert.docx', fixture('cert.docx'));
  assert.equal(d.tables.length, 1);
  assert.deepEqual(d.tables[0].rows[1], ['SUB-BMS-001', 'BMS controllers datasheet', 'B', '03/09/2026', 'Approved as noted']);
  assert.match(d.text, /Certificate No: CC-2026-0417/);
});

test('pdf reader: LibreOffice (CID fonts) and reportlab (Type1) PDFs', () => {
  const a = extract('cert.pdf', fixture('cert.pdf'));
  assert.match(a.text, /Certificate No: CC-2026-0417/);
  assert.match(a.text, /Next Due Date: 12\/03\/2027/);
  const b = extract('ncr.pdf', fixture('ncr.pdf'));
  assert.match(b.text, /Café test é/);
  assert.match(b.text, /NCR-013/);
});

test('unsupported and broken files give clear errors', () => {
  assert.throws(() => extract('old.xls', Buffer.from('x')), /Save As/);
  assert.throws(() => extract('x.docx', Buffer.from('not a zip')), /zip/);
  assert.throws(() => extract('x.pdf', Buffer.from('%PDF-1.4\n/Encrypt 5 0 R\n')), /encrypted/);
});

/* ---------- upload -> analyse -> import ---------- */

let t; let cookie;
before(async () => { t = await startServer(); cookie = await t.loginAs('member', 'member-password-123'); });
after(() => t.stop());

const upload = (file, q = '') => t.call(`/api/uploads?filename=${encodeURIComponent(file)}${q}`, { method: 'POST', cookie, body: fixture(file) });

test('uploads must be octet-stream and a supported type', async () => {
  const r = await t.call('/api/uploads?filename=a.xlsx', { method: 'POST', cookie, body: { x: 1 } });
  assert.equal(r.status, 415);
  const bad = await t.call('/api/uploads?filename=a.exe', { method: 'POST', cookie, body: Buffer.from('MZ') });
  assert.equal(bad.status, 400);
});

test('checklist workbook: auto-detected, previewed, imported, then re-import is unchanged', async () => {
  const r = await upload('checklist.xlsx');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = r.body.analysis;
  assert.equal(a.mode, 'table');
  assert.equal(a.tab, 'checklist');
  assert.equal(a.headerRow, 7);
  assert.deepEqual(a.mapping, ['ref', 'area', 'item', 'status', 'location', 'owner', 'gap', 'qp_ref', 'evidence']);
  assert.deepEqual(a.counts, { create: 5, update: 0, unchanged: 0, skip: 0 });

  // nothing written until import
  assert.equal((await t.call('/api/checklist', { cookie })).body.items.length, 0);

  const id = r.body.upload.id;
  const imp = await t.call(`/api/uploads/${id}/import`, { method: 'POST', cookie, body: { tab: 'checklist' } });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.created, 5);
  const items = (await t.call('/api/checklist', { cookie })).body.items;
  assert.equal(items.length, 5);
  assert.equal(items.find((i) => i.ref === '2.1').status, 'missing');
  assert.equal(items[0].source_upload_id, id);

  const again = await upload('checklist.xlsx');
  assert.ok(again.body.previous, 'duplicate upload is flagged');
  assert.deepEqual(again.body.analysis.counts, { create: 0, update: 0, unchanged: 5, skip: 0 });
});

test('re-import with changes updates records and logs it as an import', async () => {
  const buf = writeXlsx([{ name: 'Checklist', columns: ['Ref', 'Item', 'Status'].map((h) => ({ header: h })), rows: [['2.1', 'ITP register', 'Ready'], ['9.9', 'New item', 'Missing']] }]);
  const r = await t.call('/api/uploads?filename=update.xlsx&tab=checklist', { method: 'POST', cookie, body: buf });
  assert.deepEqual(r.body.analysis.counts, { create: 1, update: 1, unchanged: 0, skip: 0 });
  const upd = r.body.analysis.rows.find((x) => x.action === 'update');
  assert.deepEqual(upd.changes.status, { from: 'missing', to: 'ready' });

  // user unticks the new row
  const newLine = r.body.analysis.rows.find((x) => x.action === 'create').line;
  const imp = await t.call(`/api/uploads/${r.body.upload.id}/import`, { method: 'POST', cookie, body: { tab: 'checklist', exclude: [newLine] } });
  assert.equal(imp.body.updated, 1);
  assert.equal(imp.body.created, 0);
  const item = (await t.call('/api/checklist?q=ITP register', { cookie })).body.items[0];
  assert.equal(item.status, 'ready');
  const hist = (await t.call(`/api/activity?resource=checklist&record_id=${item.id}`, { cookie })).body.items;
  assert.equal(hist[0].action, 'import');
});

test('user can remap a column before importing', async () => {
  const r = await upload('checklist.xlsx', '&tab=checklist');
  const id = r.body.upload.id;
  const mapping = [...r.body.analysis.mapping];
  mapping[5] = null; // ignore Owner
  const a = await t.call(`/api/uploads/${id}/analyse`, { method: 'POST', cookie, body: { tab: 'checklist', table: 0, headerRow: 7, mapping } });
  assert.equal(a.status, 200);
  assert.equal(a.body.mapping[5], null);
});

test('PDF table (NCR log) is read with correct columns', async () => {
  const r = await upload('ncr.pdf');
  const a = r.body.analysis;
  assert.equal(a.tab, 'issues');
  assert.equal(a.counts.create, 2);
  const first = a.rows[0].values;
  assert.equal(first.issue_id, 'NCR-012');
  assert.equal(first.description, 'Cable tray support missing');
  assert.equal(first.location, 'Hall A');
  assert.equal(first.target_date, '2026-10-15');
  assert.equal(a.rows[1].values.status, 'closed');
});

test('PDF table with wrapped cells (LibreOffice) is folded into one row', async () => {
  const r = await upload('cert.pdf', '&tab=submittals');
  const rows = r.body.analysis.rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].values.title, 'BMS controllers datasheet');
  assert.equal(rows[0].values.revision, 'B');
  assert.equal(rows[0].values.gc_status, 'approved_as_noted');
});

test('single document (certificate) is read as one record and saved after review', async () => {
  const r = await upload('cert.pdf', '&tab=calibration');
  const a = await t.call(`/api/uploads/${r.body.upload.id}/analyse`, { method: 'POST', cookie, body: { tab: 'calibration', mode: 'fields' } });
  assert.equal(a.body.mode, 'fields');
  assert.equal(a.body.record.certificate, 'CC-2026-0417');
  assert.equal(a.body.record.due_date, '2027-03-12');
  assert.equal(a.body.record.make_model, 'Fluke 726');
  const record = { ...a.body.record, cal_id: 'CAL-001' }; // user edits the ID
  const imp = await t.call(`/api/uploads/${r.body.upload.id}/import`, { method: 'POST', cookie, body: { tab: 'calibration', mode: 'fields', record } });
  assert.equal(imp.body.created, 1);
  const cal = (await t.call('/api/calibration', { cookie })).body.items[0];
  assert.equal(cal.cal_id, 'CAL-001');
});

test('evidence-only upload links to a checklist item and can be downloaded', async () => {
  const r = await upload('cert.docx', '&tab=evidence&checklist_ref=2.1');
  assert.equal(r.body.analysis, null);
  assert.equal(r.body.upload.checklist_ref, '2.1');
  const item = (await t.call('/api/checklist?q=ITP register', { cookie })).body.items[0];
  assert.equal(item.evidence_files, 1);
  const dl = await t.call(`/api/uploads/${r.body.upload.id}/file`, { cookie, raw: true });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(dl.buf, fixture('cert.docx'));
});

test('exports and templates are real xlsx files', async () => {
  const all = await t.call('/api/export.xlsx', { cookie, raw: true });
  assert.equal(all.status, 200);
  const sheets = readXlsx(all.buf).tables.map((x) => x.name);
  assert.ok(sheets.includes('Sheet "Audit checklist"'));
  assert.ok(sheets.includes('Sheet "Submittal register"'));
  const tpl = await t.call('/api/deliveries/template.xlsx', { cookie, raw: true });
  const rows = readXlsx(tpl.buf).tables[0].rows;
  assert.deepEqual(rows[0].slice(0, 3), ['PO', 'Item', 'Supplier']);
  assert.equal(rows.length, 1);
});

test('dashboard: readiness, overdue, on hold and submittal ageing', async () => {
  const past = '2020-01-01';
  await t.call('/api/issues', { method: 'POST', cookie, body: { issue_id: 'NCR-900', description: 'Late item', target_date: past } });
  await t.call('/api/tasks', { method: 'POST', cookie, body: { task: 'Terminate panel', area: 'LV1', status: 'blocked', notes: 'Waiting for breakers' } });
  await t.call('/api/submittals', { method: 'POST', cookie, body: { ref: 'SUB-OLD', title: 'Old', gc_status: 'under_review', date_submitted: past } });
  const { body } = await t.call('/api/dashboard', { cookie });
  assert.equal(body.readiness.total, 5); // the "9.9" row was excluded at import
  assert.equal(body.readiness.counts.ready, 2);
  assert.equal(body.readiness.pct, 50); // 2 ready of 4 applicable (1 N/A)
  assert.ok(body.readiness.attention.some((a) => a.status === 'partial'));
  assert.ok(body.overdue.some((o) => o.tab === 'issues' && o.title.startsWith('NCR-900')));
  assert.ok(body.onHold.some((o) => o.reason === 'Waiting for breakers'));
  assert.equal(body.ageing.buckets[3].count >= 1, true);
  assert.equal(body.cards.find((c) => c.tab === 'issues').tone, 'bad');
});

/* ---------- migration from v0.1 ---------- */

test('a v0.1 database is upgraded and its old data kept as legacy_* tables', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qm-mig-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at TEXT);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER, expires_at INTEGER);
    CREATE TABLE activity (id INTEGER PRIMARY KEY, at TEXT, username TEXT, resource TEXT, record_id INTEGER, action TEXT, changes TEXT);
    CREATE TABLE submittals (id INTEGER PRIMARY KEY, ref TEXT, title TEXT, contractor TEXT, version INTEGER DEFAULT 1);
    CREATE TABLE inspections (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE findings (id INTEGER PRIMARY KEY, inspection_id INTEGER REFERENCES inspections(id), item TEXT);
    INSERT INTO users (username, password_hash) VALUES ('kiwi', 'x');
    INSERT INTO submittals (ref, title, contractor) VALUES ('OLD-1', 'Old one', 'ACME');
    INSERT INTO activity (username, resource, record_id, action) VALUES ('kiwi', 'submittals', 1, 'create');
    PRAGMA user_version = 1;
  `);
  old.close();
  const db = openDb(file);
  assert.equal(db.prepare('SELECT username FROM users').get().username, 'kiwi');
  assert.equal(db.prepare('SELECT contractor FROM legacy_submittals').get().contractor, 'ACME');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM submittals').get().n, 0);
  assert.equal(db.prepare('SELECT resource FROM activity').get().resource, 'legacy_submittals');
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM sources').get().n > 0);
  db.close();
  openDb(file).close(); // reopening is a no-op
});

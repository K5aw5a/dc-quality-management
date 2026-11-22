'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, fixture } = require('./helpers');
const { writeXlsx } = require('../src/parsers/xlsx');

let t; let admin; let member;
before(async () => {
  t = await startServer();
  admin = await t.loginAs('admin', 'admin-password-123');
  member = await t.loginAs('member', 'member-password-123');
});
after(() => t.stop());

const xlsx = (headers, rows) => writeXlsx([{ name: 'Sheet1', columns: headers.map((h) => ({ header: h })), rows }]);
const upload = (name, buf, q = '') => t.call(`/api/uploads?filename=${encodeURIComponent(name)}${q}`, { method: 'POST', cookie: member, body: buf });

async function getReg(name) { return (await t.call(`/api/registers/${name}`, { cookie: admin })).body; }
async function putReg(name, def, version, cookie = admin) {
  return t.call(`/api/registers/${name}`, { method: 'PUT', cookie, body: { def, version } });
}

test('everyone can read register definitions; only admins can change them', async () => {
  const list = await t.call('/api/registers', { cookie: member });
  assert.equal(list.status, 200);
  assert.ok(list.body.items.some((r) => r.name === 'submittals' && r.records === 0));
  const reg = await getReg('submittals');
  assert.equal((await putReg('submittals', reg.def, reg.version, member)).status, 403);
  assert.equal((await t.call('/api/registers', { method: 'POST', cookie: member, body: { label: 'X' } })).status, 403);
});

test('edit a register: purpose, new column, teach a heading; data model follows', async () => {
  const reg = await getReg('submittals');
  const def = structuredClone(reg.def);
  def.description = 'Shop drawings and datasheets sent to the GC.';
  def.columns.push({ key: 'tmp1', label: 'Package', type: 'string', inList: true, aliases: ['work package', 'pkg'] });
  def.columns.find((c) => c.key === 'ref').aliases.push('Doc Code');
  const r = await putReg('submittals', def, reg.version);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.def.columns.some((c) => c.key === 'package'));

  const schema = (await t.call('/api/schema', { cookie: member })).body;
  assert.equal(schema.tabs.submittals.description, 'Shop drawings and datasheets sent to the GC.');
  assert.equal(schema.tabs.submittals.fields.package.label, 'Package');

  const rec = await t.call('/api/submittals', { method: 'POST', cookie: member, body: { ref: 'S-1', title: 'Cable tray', package: 'BMS' } });
  assert.equal(rec.status, 201, JSON.stringify(rec.body));
  assert.equal(rec.body.package, 'BMS');

  // a file using the taught headings maps itself
  const up = await upload('subs.xlsx', xlsx(['Doc Code', 'Title', 'Work Package'], [['S-2', 'Panels', 'EPMS']]), '&tab=submittals');
  assert.deepEqual(up.body.analysis.mapping, ['ref', 'title', 'package']);
});

test('removing a column hides it and keeps its data', async () => {
  const reg = await getReg('submittals');
  const def = structuredClone(reg.def);
  def.columns = def.columns.filter((c) => c.key !== 'package');
  const r = await putReg('submittals', def, reg.version);
  assert.equal(r.status, 200);
  assert.equal(r.body.def.columns.find((c) => c.key === 'package').hidden, true);
  const schema = (await t.call('/api/schema', { cookie: member })).body;
  assert.equal(schema.tabs.submittals.fields.package, undefined);
  assert.equal(t.db.prepare("SELECT package FROM submittals WHERE ref = 'S-1'").get().package, 'BMS');
  // bring it back
  const again = await getReg('submittals');
  const d2 = structuredClone(again.def);
  d2.columns.find((c) => c.key === 'package').hidden = false;
  await putReg('submittals', d2, again.version);
  assert.equal((await t.call('/api/submittals?q=Cable', { cookie: member })).body.items[0].package, 'BMS');
});

test('stale edits are refused, and bad definitions explained', async () => {
  const reg = await getReg('issues');
  assert.equal((await putReg('issues', reg.def, reg.version - 1)).status, 409);
  const noKey = structuredClone(reg.def); noKey.key = [];
  assert.match((await putReg('issues', noKey, reg.version)).body.error, /identifies a record/);
  const noOpts = structuredClone(reg.def); noOpts.columns.find((c) => c.key === 'status').options = [];
  assert.match((await putReg('issues', noOpts, reg.version)).body.error, /has no options/);
});

test('status options: new option, colour and "counts as done" drive the dashboard', async () => {
  const reg = await getReg('issues');
  const def = structuredClone(reg.def);
  const st = def.columns.find((c) => c.key === 'status');
  st.options.push({ label: 'Awaiting client', tone: 'bad', hold: true, aliases: ['with client'] });
  await putReg('issues', def, reg.version);
  await t.call('/api/issues', { method: 'POST', cookie: member, body: { issue_id: 'I-1', description: 'Door access', status: 'awaiting_client', notes: 'Client to confirm' } });
  const d = (await t.call('/api/dashboard', { cookie: member })).body;
  assert.ok(d.onHold.some((h) => h.title.startsWith('I-1') && h.statusLabel === 'Awaiting client' && h.reason === 'Client to confirm'));
});

test('create, use, archive and restore a custom register', async () => {
  const c = await t.call('/api/registers', { method: 'POST', cookie: admin, body: { label: 'Procedures', description: 'Approved procedures and method statements' } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const name = c.body.name;
  assert.equal(name, 'r_procedures');
  const rec = await t.call(`/api/${name}`, { method: 'POST', cookie: member, body: { ref: 'PR-01', title: 'W1 walkdowns', due_date: '01/01/2020' } });
  assert.equal(rec.status, 201, JSON.stringify(rec.body));
  assert.equal(rec.body.status, 'open');
  let d = (await t.call('/api/dashboard', { cookie: member })).body;
  assert.ok(d.cards.some((x) => x.tab === name && x.overdue === 1));

  const arch = await t.call(`/api/registers/${name}/archive`, { method: 'POST', cookie: admin, body: { archived: true } });
  assert.equal(arch.status, 200);
  assert.equal((await t.call(`/api/${name}`, { cookie: member })).status, 404);
  await t.call(`/api/registers/${name}/archive`, { method: 'POST', cookie: admin, body: { archived: false } });
  assert.equal((await t.call(`/api/${name}`, { cookie: member })).body.items.length, 1, 'data survives archiving');
  d = (await t.call('/api/dashboard', { cookie: member })).body;
  assert.ok(d.cards.some((x) => x.tab === name));
});

test('headings mapped by hand at import are learned by the register', async () => {
  const buf = xlsx(['Instrument tag', 'Kit', 'Next cal'], [['T-1', 'Megger', '01/02/2027']]);
  const up = await upload('kit.xlsx', buf, '&tab=calibration');
  const a = up.body.analysis;
  assert.notEqual(a.mapping[0], 'cal_id', 'not recognised as the ID at first (guessed as Equipment)');
  const mapping = ['cal_id', 'equipment', 'due_date'];
  const re = await t.call(`/api/uploads/${up.body.upload.id}/analyse`, { method: 'POST', cookie: member, body: { tab: 'calibration', table: 0, headerRow: a.headerRow, mapping } });
  assert.equal(re.body.counts.create, 1);
  const imp = await t.call(`/api/uploads/${up.body.upload.id}/import`, { method: 'POST', cookie: member, body: { tab: 'calibration', table: 0, headerRow: a.headerRow, mapping } });
  assert.equal(imp.body.created, 1);
  assert.ok(imp.body.learned.register.some((x) => x.startsWith('Instrument tag')));
  const next = await upload('kit2.xlsx', xlsx(['Instrument tag', 'Kit', 'Next cal'], [['T-2', 'Clamp meter', '01/03/2027']]), '&tab=calibration');
  assert.deepEqual(next.body.analysis.mapping, mapping);
});

test('document types: validation, register + reading mode, keywords, evidence, learned mapping', async () => {
  assert.equal((await t.call('/api/doctypes', { method: 'POST', cookie: admin, body: { name: 'X', mode: 'table' } })).status, 400);
  const dt = await t.call('/api/doctypes', {
    method: 'POST', cookie: admin,
    body: { name: 'Weekly delivery report', register: 'deliveries', mode: 'table', keywords: 'weekly delivery, delivery report' },
  });
  assert.equal(dt.status, 201, JSON.stringify(dt.body));
  const id = dt.body.id;

  // picked by name at upload
  const buf = xlsx(['Order', 'Equipment', 'ETA'], [['PO-9', 'UPS', '10/12/2026']]);
  const up = await upload('anything.xlsx', buf, `&doc_type=${id}`);
  assert.equal(up.body.analysis.docType.name, 'Weekly delivery report');
  assert.equal(up.body.analysis.tab, 'deliveries');
  const mapping = ['po', 'item', 'expected_date'];
  await t.call(`/api/uploads/${up.body.upload.id}/import`, { method: 'POST', cookie: member, body: { tab: 'deliveries', docType: id, table: 0, headerRow: up.body.analysis.headerRow, mapping } });
  const saved = (await t.call(`/api/doctypes/${id}`, { cookie: member })).body;
  assert.equal(saved.mapping.order, 'po');
  assert.equal(saved.mapping.eta, 'expected_date');

  // detected from the file name next time, mapping applied
  const auto = await upload('Weekly Delivery Report wk48.xlsx', xlsx(['Order', 'Equipment', 'ETA'], [['PO-10', 'Chiller', '11/12/2026']]));
  assert.equal(auto.body.analysis.docType?.id, id);
  assert.deepEqual(auto.body.analysis.mapping, mapping);

  // evidence-only type: stored, not read into a register
  const ev = (await t.call('/api/doctypes', { cookie: member })).body.items.find((d) => d.mode === 'evidence');
  const st = await upload('W1 walkdowns procedure.pdf', fixture('ncr.pdf'), `&doc_type=${ev.id}`);
  assert.equal(st.body.analysis, null);
  assert.equal(st.body.upload.doc_type_id, ev.id);

  // single-form type
  const cert = (await t.call('/api/doctypes', { cookie: member })).body.items.find((d) => d.name === 'Calibration certificate');
  const cu = await upload('cert.pdf', fixture('cert.pdf'), `&doc_type=${cert.id}`);
  assert.equal(cu.body.analysis.mode, 'fields');
  assert.equal(cu.body.analysis.record.certificate, 'CC-2026-0417');
});

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const zlib = require('node:zlib');
const { extract, extractFull } = require('../src/parsers');
const { encodePng, ccittToTiff } = require('../src/parsers/images');
const ocr = require('../src/ocr');
const { analyse } = require('../src/importer');
const { openDb } = require('../src/db');
const { startServer, fixture } = require('./helpers');

let hasTesseract = false;
try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }); hasTesseract = true; } catch { /* not installed */ }
const needsTesseract = { skip: !hasTesseract && 'tesseract not installed' };

/* ---------- scan detection & page images (no OCR engine needed) ---------- */

test('scanned PDFs are detected and each page image is prepared for OCR', () => {
  const jpeg = extract('a.pdf', fixture('scan-ncr-jpeg.pdf'));
  assert.deepEqual(jpeg.scannedPages, [1]);
  assert.equal(jpeg.ocrImages[0].format, 'jpeg');
  assert.equal(jpeg.ocrImages[0].data.subarray(0, 2).toString('hex'), 'ffd8'); // JPEG SOI

  const g4 = extract('b.pdf', fixture('scan-cert-g4.pdf'));
  assert.equal(g4.ocrImages[0].format, 'tiff');
  assert.equal(g4.ocrImages[0].data.subarray(0, 4).toString('latin1'), 'II*\u0000');

  const flate = extract('c.pdf', fixture('scan-ncr-flate.pdf')); // ASCII85 + Flate raw pixels
  assert.equal(flate.ocrImages[0].format, 'png');
  assert.equal(flate.ocrImages[0].data.subarray(1, 4).toString('latin1'), 'PNG');

  const text = extract('d.pdf', fixture('ncr.pdf'));
  assert.equal(text.ocrImages, undefined, 'text PDFs are not sent to OCR');
});

test('PNG encoder writes valid chunks', () => {
  const png = encodePng({ width: 2, height: 2, bitDepth: 8, colorType: 0, pixels: Buffer.from([0, 255, 255, 0]) });
  const idatLen = png.readUInt32BE(33);
  const idat = png.subarray(41, 41 + idatLen);
  assert.deepEqual([...zlib.inflateSync(idat)], [0, 0, 255, 0, 255, 0]);
  const crc = png.readUInt32BE(41 + idatLen);
  assert.equal(crc, zlib.crc32(png.subarray(37, 41 + idatLen)) >>> 0);
});

test('CCITT data is wrapped in a TIFF with the right tags', () => {
  const tif = ccittToTiff({ data: Buffer.from([1, 2, 3]), width: 100, height: 50, k: -1 });
  const n = tif.readUInt16LE(8);
  const tags = {};
  for (let i = 0; i < n; i++) tags[tif.readUInt16LE(10 + i * 12)] = tif.readUInt32LE(10 + i * 12 + 8) & (tif.readUInt16LE(10 + i * 12 + 2) === 3 ? 0xffff : 0xffffffff);
  assert.equal(tags[256], 100);
  assert.equal(tags[257], 50);
  assert.equal(tags[259], 4); // Group 4
  assert.deepEqual([...tif.subarray(tags[273], tags[273] + 3)], [1, 2, 3]);
});

/* ---------- OCR pipeline with a stand-in engine ---------- */

// Words as an OCR engine reports them (pixels, y downwards), laid out as a small table.
const fakeWords = [
  [{ text: 'NCRNo', x: 100, y: 100, w: 90, h: 20 }, { text: 'Description', x: 300, y: 101, w: 150, h: 20 }, { text: 'Target', x: 700, y: 99, w: 80, h: 20 }],
  [{ text: 'NCR-1', x: 100, y: 140, w: 80, h: 20 }, { text: 'Loose', x: 300, y: 141, w: 70, h: 20 }, { text: 'gland', x: 378, y: 141, w: 60, h: 20 }, { text: '1O/l2/2026', x: 700, y: 140, w: 120, h: 20 }],
];
const fakeEngine = async (images) => ({ engine: 'Fake OCR', pages: images.map((i) => i.page), items: ocr.toItems(1, fakeWords), errors: [] });

test('OCR words become a table; joined headings and O/l in dates are tolerated', async () => {
  const out = await extractFull('scan.pdf', fixture('scan-ncr-jpeg.pdf'), { ocr: fakeEngine });
  assert.equal(out.ocr.engine, 'Fake OCR');
  assert.deepEqual(out.lines[1].cells, ['NCR-1', 'Loose gland', '1O/l2/2026']);
  const a = analyse(openDb(':memory:'), out, { filename: 'scan.pdf' });
  assert.equal(a.tab, 'issues');
  assert.deepEqual(a.mapping, ['issue_id', 'description', 'target_date']);
  assert.equal(a.rows[0].values.target_date, '2026-12-10'); // 10/12/2026, day first
  assert.equal(a.ocr.engine, 'Fake OCR');
});

test('OCR results are cached so re-analysis does not run OCR again', async () => {
  let calls = 0; let stored = null;
  const engine = async (imgs) => { calls++; return fakeEngine(imgs); };
  const cache = { get: () => stored, set: (v) => { stored = v; } };
  await extractFull('scan.pdf', fixture('scan-ncr-jpeg.pdf'), { ocr: engine, cache });
  await extractFull('scan.pdf', fixture('scan-ncr-jpeg.pdf'), { ocr: engine, cache });
  assert.equal(calls, 1);
});

test('when OCR is unavailable the analysis says so', async () => {
  const off = async () => ({ engine: null, items: [], error: 'no OCR engine found' });
  const out = await extractFull('scan.pdf', fixture('scan-cert-g4.pdf'), { ocr: off });
  const a = analyse(openDb(':memory:'), out, { filename: 'scan.pdf' });
  assert.equal(a.mode, 'none');
  assert.match(a.message, /scanned document.*no OCR engine found/);
});

test('Windows OCR output (PowerShell JSON) is parsed, including collapsed arrays', () => {
  const two = ocr.parseWindowsOutput('junk\r\n{"ok":true,"language":"en-US","pages":[{"lines":[[["Ref",10,20,30,12],["Title",60,20,40,12]],[["S-1",10,40,25,12]]]}]}');
  assert.equal(two[0].length, 2);
  assert.deepEqual(two[0][0][1], { text: 'Title', x: 60, y: 20, w: 40, h: 12 });
  // PowerShell turns a one-word line into a flat array
  const one = ocr.parseWindowsOutput('{"ok":true,"pages":{"lines":[["Only",1,2,3,4]]}}');
  assert.deepEqual(one[0][0], [{ text: 'Only', x: 1, y: 2, w: 3, h: 4 }]);
  assert.throws(() => ocr.parseWindowsOutput('{"ok":false,"error":"Cannot add type. Definition of type is not supported in this language mode."}'), /blocked by this computer's PowerShell policy/);
});

test('Windows OCR script is passed safely (no template interpolation, AsTask helper intact)', () => {
  assert.ok(ocr.WINDOWS_SCRIPT.includes("'IAsyncOperation`1'"));
  assert.ok(!ocr.WINDOWS_SCRIPT.includes('${'));
  assert.ok(ocr.WINDOWS_SCRIPT.includes('TryCreateFromUserProfileLanguages'));
});

/* ---------- real OCR (Tesseract) ---------- */

test('Tesseract reads a JPEG-scanned NCR log into the right columns', needsTesseract, async () => {
  ocr._reset();
  const out = await extractFull('scan.pdf', fixture('scan-ncr-jpeg.pdf'));
  assert.match(out.ocr.engine, /Tesseract/);
  const a = analyse(openDb(':memory:'), out, { filename: 'scan.pdf' });
  assert.equal(a.tab, 'issues');
  const r = a.rows.find((x) => x.values.issue_id === 'NCR-012');
  assert.ok(r, JSON.stringify(a.rows.map((x) => x.values)));
  assert.equal(r.values.description, 'Cable tray support missing');
  assert.equal(r.values.target_date, '2026-10-15');
});

test('Tesseract reads Flate- and CCITT-scanned pages', needsTesseract, async () => {
  const flate = await extractFull('scan.pdf', fixture('scan-ncr-flate.pdf'));
  assert.match(flate.text, /NCR-013/);
  const g4 = await extractFull('scan.pdf', fixture('scan-cert-g4.pdf'));
  const a = analyse(openDb(':memory:'), g4, { filename: 'cert.pdf', tab: 'calibration', mode: 'fields' });
  assert.equal(a.record.certificate, 'CC-2026-0417');
  assert.equal(a.record.due_date, '2027-03-12');
});

let t; let cookie;
before(async () => { t = await startServer(); cookie = await t.loginAs('member', 'member-password-123'); });
after(() => t.stop());

test('scanned PDF upload → OCR preview → import', needsTesseract, async () => {
  const r = await t.call('/api/uploads?filename=ncr-scan.pdf', { method: 'POST', cookie, body: fixture('scan-ncr-jpeg.pdf') });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.analysis.ocr.engine, /Tesseract/);
  assert.equal(r.body.analysis.tab, 'issues');
  const imp = await t.call(`/api/uploads/${r.body.upload.id}/import`, { method: 'POST', cookie, body: { tab: 'issues' } });
  assert.equal(imp.body.created, 2);
});

test('photos/scans can be uploaded as images', needsTesseract, async () => {
  const jpeg = extract('a.pdf', fixture('scan-ncr-jpeg.pdf')).ocrImages[0].data;
  const r = await t.call('/api/uploads?filename=photo.jpg&tab=issues', { method: 'POST', cookie, body: jpeg });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.upload.kind, 'jpg');
  assert.equal(r.body.analysis.mode, 'table');
  assert.ok(r.body.analysis.rows.some((x) => x.values.issue_id === 'NCR-013'));
});

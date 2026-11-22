'use strict';

const { readXlsx } = require('./xlsx');
const { readCsv } = require('./csv');
const { readDocx } = require('./docx');
const { readPdf, assemble } = require('./pdf');

const IMAGE_FORMATS = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', tif: 'tiff', tiff: 'tiff', bmp: 'bmp' };

// A photo or scan uploaded directly: all of it goes to OCR.
function readImage(format) {
  return (buf) => ({ kind: 'image', pages: 1, tables: [], lines: [], text: '', scannedPages: [1], ocrImages: [{ page: 1, format, data: buf }], textItems: [] });
}

const KINDS = {
  xlsx: readXlsx, xlsm: readXlsx, csv: readCsv, txt: readCsv, docx: readDocx, docm: readDocx, pdf: readPdf,
  ...Object.fromEntries(Object.entries(IMAGE_FORMATS).map(([ext, fmt]) => [ext, readImage(fmt)])),
};

function kindOf(filename, buf) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (buf && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (ext === 'xls') throw new Error('old .xls files are not supported; open it in Excel and "Save As" .xlsx');
  if (ext === 'doc') throw new Error('old .doc files are not supported; open it in Word and "Save As" .docx');
  if (!KINDS[ext]) throw new Error(`unsupported file type .${ext}; upload .xlsx, .csv, .docx, .pdf or a scan/photo (.jpg, .png, .tif)`);
  return ext;
}

function fillLines(out) {
  if (!out.lines || !out.lines.length) {
    out.lines = [];
    for (const t of out.tables) for (const r of t.rows) {
      const cells = r.map((c) => String(c ?? '').trim()).filter(Boolean);
      if (cells.length) out.lines.push({ cells });
    }
  }
  return out;
}

// Synchronous part: everything except OCR.
// Returns { kind, tables: [{ name, rows: [[cell]] }], lines: [{ cells }], text, ocrImages? }
function extract(filename, buf) {
  const kind = kindOf(filename, buf);
  return fillLines(KINDS[kind](buf));
}

// Full extraction including OCR of scanned pages / images.
// cache: optional { get(): result|null, set(result) } for OCR results (OCR is slow).
async function extractFull(filename, buf, { ocr, cache } = {}) {
  const out = extract(filename, buf);
  if (!out.ocrImages || !out.ocrImages.length) return out;
  let res = cache?.get() || null;
  if (!res) {
    res = await (ocr || require('../ocr').ocrImages)(out.ocrImages);
    if (res.items.length) cache?.set(res);
  }
  const info = { engine: res.engine, pages: out.scannedPages, error: res.error || null, warnings: res.errors || [] };
  if (!res.items.length) return { ...out, ocr: info, ocrImages: undefined, textItems: undefined };
  const merged = assemble([...out.textItems, ...res.items], { pages: out.pages, ocr: info });
  merged.kind = out.kind;
  return fillLines(merged);
}

module.exports = { extract, extractFull, kindOf, IMAGE_FORMATS };

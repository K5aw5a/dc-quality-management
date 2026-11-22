'use strict';

const { readXlsx } = require('./xlsx');
const { readCsv } = require('./csv');
const { readDocx } = require('./docx');
const { readPdf } = require('./pdf');

const KINDS = {
  xlsx: readXlsx, xlsm: readXlsx, csv: readCsv, txt: readCsv, docx: readDocx, docm: readDocx, pdf: readPdf,
};

function kindOf(filename, buf) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (buf && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (ext === 'xls') throw new Error('old .xls files are not supported; open it in Excel and "Save As" .xlsx');
  if (ext === 'doc') throw new Error('old .doc files are not supported; open it in Word and "Save As" .docx');
  if (!KINDS[ext]) throw new Error(`unsupported file type .${ext}; upload .xlsx, .csv, .docx or .pdf`);
  return ext;
}

// Returns { kind, tables: [{ name, rows: [[cell]] }], lines?: [{ cells }], text }
function extract(filename, buf) {
  const kind = kindOf(filename, buf);
  const out = KINDS[kind](buf);
  if (!out.lines) {
    out.lines = [];
    for (const t of out.tables) for (const r of t.rows) {
      const cells = r.map((c) => String(c ?? '').trim()).filter(Boolean);
      if (cells.length) out.lines.push({ cells });
    }
  }
  return out;
}

module.exports = { extract, kindOf };

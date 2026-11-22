'use strict';

// Turning messy cell text into clean typed values. Used by both manual entry
// validation and the importer.

const { serialToIso } = require('./parsers/xlsx');

// "Gap / action needed" -> "gap action needed"; strips accents and punctuation.
function norm(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const MONTHS = {
  jan: 1, january: 1, ene: 1, enero: 1, feb: 2, february: 2, febrero: 2, mar: 3, march: 3, marzo: 3,
  apr: 4, april: 4, abr: 4, abril: 4, may: 5, mayo: 5, jun: 6, june: 6, junio: 6, jul: 7, july: 7, julio: 7,
  aug: 8, august: 8, ago: 8, agosto: 8, sep: 9, sept: 9, september: 9, set: 9, septiembre: 9,
  oct: 10, october: 10, octubre: 10, nov: 11, november: 11, noviembre: 11, dec: 12, december: 12, dic: 12, diciembre: 12,
};

function iso(y, m, d) {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // 31/02 etc.
  return dt.toISOString().slice(0, 10);
}

// Dates default to day-first (DD/MM/YYYY), as used in Ireland/UK/Spain.
function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v > 20000 && v < 80000 ? serialToIso(v) : null;
  const s = String(v).trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:\s.*)?$/.exec(s);
  if (m) {
    let d = +m[1]; let mo = +m[2];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d]; // clearly month-first
    return iso(+m[3], mo, d);
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]+(?:de\s+)?([A-Za-zé]+)\.?,?[\s\-/.]+(?:de\s+)?(\d{2,4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  if (/^\d{5}(\.\d+)?$/.test(s)) return parseDate(Number(s));
  return null;
}

function parseNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = /-?[\d.,\s]*\d/.exec(String(v));
  if (!m) return null;
  let s = m[0].replace(/\s/g, '');
  const lastDot = s.lastIndexOf('.'); const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // the later separator is the decimal one
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    s = /,\d{3}$/.test(s) && !/^-?0,/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const TRUE = new Set(['yes', 'y', 'true', '1', 'x', 'si', 'done', 'ok', 'approved', 'complete', 'completed', 'received']);
const FALSE = new Set(['no', 'n', 'false', '0', 'pending', 'not done', 'outstanding', 'tbc', 'open']);
function parseBool(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  const s = String(v).trim();
  if (/^[✓✔☑]/.test(s)) return 'yes';
  if (/^[✗✘☐]/.test(s)) return 'no';
  const n = norm(s);
  if (TRUE.has(n)) return 'yes';
  if (FALSE.has(n)) return 'no';
  return null;
}

// Map free text to an enum value: exact value / label / listed synonyms,
// then the longest synonym found inside the text.
function parseEnum(def, v) {
  if (v === null || v === undefined || v === '') return { value: null };
  const n = norm(v);
  if (!n) return { value: null };
  for (const val of def.values) {
    if (n === norm(val) || n === norm(def.labels?.[val] || '')) return { value: val };
  }
  const map = def.map || {};
  for (const [val, words] of Object.entries(map)) if (words.some((w) => norm(w) === n)) return { value: val };
  let best = null; let bestLen = 0;
  for (const [val, words] of Object.entries(map)) {
    for (const w of words) {
      const nw = norm(w);
      if (nw.length < 3) continue;
      if ((` ${n} `).includes(` ${nw} `) && nw.length > bestLen) { best = val; bestLen = nw.length; }
    }
  }
  return best ? { value: best } : { value: null, unknown: String(v) };
}

module.exports = { norm, parseDate, parseNumber, parseBool, parseEnum };

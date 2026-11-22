'use strict';

// CSV reader that copes with what Excel produces in different locales:
// comma / semicolon / tab delimiters, UTF-8 (with or without BOM) or Windows-1252.

const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';

function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    let s = '';
    for (const b of buf) s += b >= 0x80 && b <= 0x9f ? CP1252[b - 0x80] : String.fromCharCode(b);
    return s;
  }
}

function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  let best = ','; let bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = sample.map((l) => l.split(d).length - 1);
    const nonZero = counts.filter((c) => c > 0);
    // prefer delimiters that appear consistently on many lines
    const score = nonZero.length * 10 + (nonZero.length ? Math.min(...nonZero) : 0);
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

function parseCsvText(text, delimiter = detectDelimiter(text)) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
      if (rows.length >= 20000) break;
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

function readCsv(buf) {
  const text = decodeText(buf);
  const rows = parseCsvText(text);
  return { kind: 'csv', tables: [{ name: 'CSV', rows }], text };
}

module.exports = { readCsv, parseCsvText, decodeText, detectDelimiter };

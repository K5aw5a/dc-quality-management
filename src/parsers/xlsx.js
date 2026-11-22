'use strict';

const path = require('node:path').posix;
const { readZip, writeZip } = require('./zip');
const { parseXml, findAll, find, kids, attr, text, local } = require('./xml');

const MAX_ROWS = 20000;
const MAX_COLS = 200;

// Built-in Excel number formats that are dates.
const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function isDateFormat(code) {
  if (!code) return false;
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dy]/i.test(stripped) || /m{3,}/i.test(stripped) || (/m/i.test(stripped) && !/h|s/i.test(stripped) && /[/.\-]/.test(stripped));
}

function serialToIso(serial, date1904) {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return null;
  const ms = Math.round((serial + (date1904 ? 1462 : 0)) * 86400000) + Date.UTC(1899, 11, 30);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function resolveTarget(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  return path.normalize(path.join(path.dirname(base), target));
}

function readXlsx(buf) {
  const zip = readZip(buf);
  const wbPath = 'xl/workbook.xml';
  const wbXml = zip.text(wbPath);
  if (!wbXml) throw new Error('not an Excel workbook (.xlsx)');
  const wb = parseXml(wbXml);
  const date1904 = ['1', 'true'].includes(attr(find(wb, 'workbookPr'), 'date1904'));

  const rels = {};
  const relXml = zip.text('xl/_rels/workbook.xml.rels');
  if (relXml) for (const r of findAll(parseXml(relXml), 'Relationship')) rels[attr(r, 'Id')] = resolveTarget(wbPath, attr(r, 'Target'));

  const shared = [];
  const ssXml = zip.text('xl/sharedStrings.xml');
  if (ssXml) {
    for (const si of findAll(parseXml(ssXml), 'si')) {
      // concatenate <t> runs, skipping phonetic hints (<rPh>)
      let s = '';
      (function walk(n) {
        for (const c of n.children) {
          if (typeof c === 'string') continue;
          const ln = local(c.name);
          if (ln === 'rPh' || ln === 'phoneticPr') continue;
          if (ln === 't') s += text(c); else walk(c);
        }
      })(si);
      shared.push(s);
    }
  }

  const dateStyles = new Set();
  const stXml = zip.text('xl/styles.xml');
  if (stXml) {
    const st = parseXml(stXml);
    const custom = {};
    for (const nf of findAll(st, 'numFmt')) custom[Number(attr(nf, 'numFmtId'))] = attr(nf, 'formatCode');
    const xfs = find(st, 'cellXfs');
    if (xfs) {
      kids(xfs, 'xf').forEach((xf, i) => {
        const id = Number(attr(xf, 'numFmtId') || 0);
        if (BUILTIN_DATE_FMTS.has(id) || isDateFormat(custom[id])) dateStyles.add(i);
      });
    }
  }

  const tables = [];
  for (const sheet of findAll(wb, 'sheet')) {
    const name = attr(sheet, 'name');
    const target = rels[attr(sheet, 'id')];
    const xml = target && zip.text(target);
    if (!xml) continue;
    if (attr(sheet, 'state') === 'hidden' || attr(sheet, 'state') === 'veryHidden') continue;
    const rows = [];
    for (const row of findAll(parseXml(xml), 'row')) {
      const r = Number(attr(row, 'r')) || rows.length + 1;
      if (r > MAX_ROWS) break;
      const cells = [];
      let next = 0;
      for (const c of kids(row, 'c')) {
        let ci = colIndex(attr(c, 'r'));
        if (ci < 0) ci = next;
        next = ci + 1;
        if (ci >= MAX_COLS) continue;
        const t = attr(c, 't');
        const v = find(c, 'v');
        let value = '';
        if (t === 's') value = shared[Number(v ? text(v) : -1)] ?? '';
        else if (t === 'inlineStr') { const is = find(c, 'is'); value = is ? findAll(is, 't').map(text).join('') : ''; }
        else if (t === 'str' || t === 'e') value = v ? text(v) : '';
        else if (t === 'b') value = v ? text(v) === '1' : '';
        else if (v) {
          const num = Number(text(v));
          value = Number.isFinite(num) ? num : text(v);
          if (typeof value === 'number' && dateStyles.has(Number(attr(c, 's') || 0))) value = serialToIso(value, date1904) ?? value;
        }
        cells[ci] = value;
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
      while (rows.length < r - 1) rows.push([]);
      rows[r - 1] = cells;
    }
    tables.push({ name: `Sheet "${name}"`, rows });
  }
  return { kind: 'xlsx', tables, text: tables.map((t) => t.rows.map((r) => r.join(' \t ')).join('\n')).join('\n\n') };
}

/* ---------------- writer ---------------- */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  // strip characters XML 1.0 can't carry
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function colName(i) {
  let s = ''; i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

function isoToSerial(iso) {
  const t = Date.parse(iso + 'T00:00:00Z');
  return Number.isNaN(t) ? null : (t - Date.UTC(1899, 11, 30)) / 86400000;
}

// sheets: [{ name, columns: [{ header, type }], rows: [[...values]] }]
function writeXlsx(sheets) {
  const used = new Set();
  const safeName = (n) => {
    let s = String(n).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim() || 'Sheet';
    let k = 2; const base = s;
    while (used.has(s.toLowerCase())) s = `${base.slice(0, 28)} ${k++}`;
    used.add(s.toLowerCase());
    return s;
  };
  const files = [];
  const sheetEntries = sheets.map((sh, i) => ({ ...sh, name: safeName(sh.name), file: `sheet${i + 1}.xml` }));

  for (const sh of sheetEntries) {
    const widths = sh.columns.map((c) => Math.min(60, Math.max(8, String(c.header).length + 2)));
    const rowXml = [];
    const header = sh.columns.map((c, ci) => `<c r="${colName(ci)}1" t="inlineStr" s="2"><is><t>${esc(c.header)}</t></is></c>`).join('');
    rowXml.push(`<row r="1">${header}</row>`);
    sh.rows.forEach((row, ri) => {
      const r = ri + 2;
      const cells = row.map((v, ci) => {
        if (v === null || v === undefined || v === '') return '';
        const ref = `${colName(ci)}${r}`;
        const type = sh.columns[ci]?.type;
        if (type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
          const serial = isoToSerial(v);
          if (serial !== null) return `<c r="${ref}" s="1"><v>${serial}</v></c>`;
        }
        if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
        widths[ci] = Math.min(60, Math.max(widths[ci], String(v).length + 2));
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      }).join('');
      rowXml.push(`<row r="${r}">${cells}</row>`);
    });
    const lastCol = colName(Math.max(0, sh.columns.length - 1));
    files.push({
      name: `xl/worksheets/${sh.file}`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${rowXml.join('')}</sheetData>${sh.columns.length ? `<autoFilter ref="A1:${lastCol}${sh.rows.length + 1}"/>` : ''}</worksheet>`,
    });
  }

  files.push(
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetEntries.map((s) => `<Override PartName="/xl/worksheets/${s.file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetEntries.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${s.file}"/>`).join('')}<Relationship Id="rId${sheetEntries.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf numFmtId="14" applyNumberFormat="1"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>` },
  );
  return writeZip(files);
}

module.exports = { readXlsx, writeXlsx, serialToIso, isDateFormat };

'use strict';

const { readZip } = require('./zip');
const { parseXml, kids, attr, local } = require('./xml');

// Text of a paragraph-ish subtree: w:t text, tabs and breaks.
function runText(node) {
  let s = '';
  for (const c of node.children) {
    if (typeof c === 'string') continue;
    const ln = local(c.name);
    if (ln === 't') s += c.children.filter((x) => typeof x === 'string').join('');
    else if (ln === 'tab') s += '\t';
    else if (ln === 'br' || ln === 'cr') s += '\n';
    else if (ln === 'p') s += (s ? '\n' : '') + runText(c);
    else if (ln === 'tbl') s += (s ? '\n' : '') + tableRows(c).map((r) => r.join(' | ')).join('\n');
    else if (ln === 'delText' || ln === 'instrText') continue; // deleted text, field codes
    else s += runText(c);
  }
  return s;
}

function tableRows(tbl) {
  const rows = [];
  for (const tr of kids(tbl, 'tr')) {
    const cells = [];
    for (const tc of kids(tr, 'tc')) {
      const pr = kids(tc, 'tcPr')[0];
      const span = Number(attr(pr && kids(pr, 'gridSpan')[0], 'val')) || 1;
      const vMerge = pr && kids(pr, 'vMerge')[0];
      const continued = vMerge && attr(vMerge, 'val') !== 'restart';
      const value = continued ? '' : runText(tc).replace(/\s*\n\s*/g, ' ').trim();
      cells.push(value);
      for (let i = 1; i < span; i++) cells.push('');
    }
    rows.push(cells);
  }
  return rows;
}

function readDocx(buf) {
  const zip = readZip(buf);
  const xml = zip.text('word/document.xml');
  if (!xml) throw new Error('not a Word document (.docx)');
  const doc = parseXml(xml);
  const body = kids(kids(doc, 'document')[0] || doc, 'body')[0];
  if (!body) return { kind: 'docx', tables: [], text: '', lines: [] };

  const tables = []; const lines = [];
  (function walk(node) {
    for (const c of kids(node)) {
      const ln = local(c.name);
      if (ln === 'p') {
        const t = runText(c);
        for (const l of t.split('\n')) if (l.trim()) lines.push({ cells: l.split('\t').map((x) => x.trim()).filter(Boolean) });
      } else if (ln === 'tbl') {
        const rows = tableRows(c);
        tables.push({ name: `Table ${tables.length + 1}`, rows });
        for (const r of rows) if (r.some((x) => x)) lines.push({ cells: r.filter(Boolean), table: true });
      } else if (ln === 'sdt' || ln === 'sdtContent' || ln === 'customXml') walk(c);
    }
  })(body);

  return { kind: 'docx', tables, lines, text: lines.map((l) => l.cells.join('  ')).join('\n') };
}

module.exports = { readDocx };

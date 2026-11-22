'use strict';

// Zero-dependency PDF text extractor. It rebuilds lines of text and splits
// them into cells by horizontal gaps, which is enough to read registers and
// forms exported from Word/Excel/ACC. Not supported: encrypted PDFs, scanned
// images (no OCR), exotic font encodings.

const zlib = require('node:zlib');

const MAX_STREAM_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 300;

class Name { constructor(n) { this.name = n; } }
class Ref { constructor(num, gen) { this.num = num; this.gen = gen; } }
class PdfStr { constructor(bytes) { this.bytes = bytes; } } // latin1 byte string
class Op { constructor(op) { this.op = op; } }
const EOF = Symbol('EOF');
const DELIM = new Set(['<<', '>>', '[', ']', '{', '}']);

const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const isDelim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;

class Lexer {
  constructor(s, pos = 0) { this.s = s; this.pos = pos; this.buf = []; }

  skip() {
    const s = this.s;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (isWs(c)) this.pos++;
      else if (c === 37) { while (this.pos < s.length && s[this.pos] !== '\n' && s[this.pos] !== '\r') this.pos++; }
      else break;
    }
  }

  raw() {
    this.skip();
    const s = this.s;
    if (this.pos >= s.length) return EOF;
    const c = s[this.pos];
    if (c === '<' && s[this.pos + 1] === '<') { this.pos += 2; return '<<'; }
    if (c === '>' && s[this.pos + 1] === '>') { this.pos += 2; return '>>'; }
    if (c === '[' || c === ']' || c === '{' || c === '}') { this.pos++; return c; }
    if (c === '/') {
      let j = this.pos + 1;
      while (j < s.length && !isWs(s.charCodeAt(j)) && !isDelim(s.charCodeAt(j))) j++;
      const n = s.slice(this.pos + 1, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      this.pos = j;
      return new Name(n);
    }
    if (c === '(') return this.literal();
    if (c === '<') {
      const end = s.indexOf('>', this.pos);
      let hex = s.slice(this.pos + 1, end < 0 ? s.length : end).replace(/[^0-9a-fA-F]/g, '');
      this.pos = end < 0 ? s.length : end + 1;
      if (hex.length % 2) hex += '0';
      let out = '';
      for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
      return new PdfStr(out);
    }
    if (c === ')' || c === '>') { this.pos++; return this.raw(); } // stray
    let j = this.pos;
    while (j < s.length && !isWs(s.charCodeAt(j)) && !isDelim(s.charCodeAt(j))) j++;
    const word = s.slice(this.pos, j);
    this.pos = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
    if (/^[+-]?\d*\.?\d*$/.test(word) && word.length) return 0; // e.g. "-" or "."
    return new Op(word);
  }

  literal() {
    const s = this.s; let depth = 1; let out = ''; let i = this.pos + 1;
    while (i < s.length && depth > 0) {
      const c = s[i];
      if (c === '\\') {
        const n = s[i + 1];
        if (n === 'n') { out += '\n'; i += 2; } else if (n === 'r') { out += '\r'; i += 2; }
        else if (n === 't') { out += '\t'; i += 2; } else if (n === 'b') { out += '\b'; i += 2; }
        else if (n === 'f') { out += '\f'; i += 2; }
        else if (n === '\r') { i += s[i + 2] === '\n' ? 3 : 2; } else if (n === '\n') { i += 2; }
        else if (n >= '0' && n <= '7') {
          let oct = ''; let k = i + 1;
          while (oct.length < 3 && s[k] >= '0' && s[k] <= '7') oct += s[k++];
          out += String.fromCharCode(parseInt(oct, 8) & 0xff); i = k;
        } else if (n !== undefined) { out += n; i += 2; } else i++;
      } else {
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) { i++; break; }
        out += c; i++;
      }
    }
    this.pos = i;
    return new PdfStr(out);
  }

  next() { return this.buf.length ? this.buf.shift() : this.raw(); }
  peek(k = 0) { while (this.buf.length <= k) this.buf.push(this.raw()); return this.buf[k]; }

  // Parse one PDF object (dict/array/primitive/ref).
  object() {
    const t = this.next();
    if (t === '<<') {
      const d = Object.create(null);
      for (;;) {
        const k = this.next();
        if (k === '>>' || k === EOF) break;
        if (k instanceof Name) d[k.name] = this.object();
      }
      return d;
    }
    if (t === '[') {
      const a = [];
      for (;;) {
        const p = this.peek();
        if (p === ']' || p === EOF) { this.next(); break; }
        a.push(this.object());
      }
      return a;
    }
    if (typeof t === 'number' && Number.isInteger(t)) {
      const a = this.peek(0); const b = this.peek(1);
      if (typeof a === 'number' && b instanceof Op && b.op === 'R') { this.next(); this.next(); return new Ref(t, a); }
      return t;
    }
    if (t instanceof Op) {
      if (t.op === 'true') return true;
      if (t.op === 'false') return false;
      if (t.op === 'null') return null;
    }
    return t;
  }
}

/* ---------------- document structure ---------------- */

class PdfDoc {
  constructor(buf) {
    this.src = buf.toString('latin1');
    if (!this.src.slice(0, 1024).includes('%PDF')) throw new Error('not a PDF file');
    if (/\/Encrypt\s+(\d+\s+\d+\s+R|<<)/.test(this.src)) {
      const e = new Error('this PDF is encrypted/password-protected; save or print an unprotected copy and upload that');
      e.code = 'ENCRYPTED';
      throw e;
    }
    this.direct = new Map(); // num -> offset after "obj"
    this.inStream = new Map(); // num -> { stm, index }
    this.cache = new Map();
    this.stmCache = new Map();
    this.scan();
  }

  scan() {
    const src = this.src; const re = /(\d+)\s+(\d+)\s+obj\b/g; let m;
    const objStms = [];
    while ((m = re.exec(src))) {
      const num = Number(m[1]); const start = re.lastIndex;
      this.direct.set(num, start);
      const endobj = src.indexOf('endobj', start);
      const stream = src.indexOf('stream', start);
      if (stream !== -1 && (endobj === -1 || stream < endobj)) {
        if (/\/Type\s*\/ObjStm/.test(src.slice(start, stream))) objStms.push(num);
        const es = src.indexOf('endstream', stream + 6);
        if (es !== -1) re.lastIndex = es + 9;
      } else if (endobj !== -1) re.lastIndex = endobj + 6;
    }
    for (const stm of objStms) {
      try {
        const { offsets } = this.objStm(stm);
        offsets.forEach(([num], index) => { if (!this.direct.has(num) && !this.inStream.has(num)) this.inStream.set(num, { stm, index }); });
      } catch { /* damaged object stream: skip */ }
    }
  }

  objStm(num) {
    if (this.stmCache.has(num)) return this.stmCache.get(num);
    const obj = this.get(new Ref(num, 0));
    const data = this.streamData(obj).toString('latin1');
    const n = this.get(obj.dict.N) || 0; const first = this.get(obj.dict.First) || 0;
    const lx = new Lexer(data); const offsets = [];
    for (let i = 0; i < n; i++) offsets.push([lx.next(), lx.next()]);
    const res = { data, first, offsets };
    this.stmCache.set(num, res);
    return res;
  }

  get(v) {
    if (!(v instanceof Ref)) return v;
    if (this.cache.has(v.num)) return this.cache.get(v.num);
    this.cache.set(v.num, null); // cycle guard
    let value = null;
    try {
      if (this.direct.has(v.num)) value = this.parseDirect(this.direct.get(v.num));
      else if (this.inStream.has(v.num)) {
        const { stm, index } = this.inStream.get(v.num);
        const s = this.objStm(stm);
        value = new Lexer(s.data, s.first + s.offsets[index][1]).object();
      }
    } catch { value = null; }
    this.cache.set(v.num, value);
    return value;
  }

  parseDirect(pos) {
    const lx = new Lexer(this.src, pos);
    const value = lx.object();
    const t = lx.peek();
    if (t instanceof Op && t.op === 'stream' && value && typeof value === 'object') {
      lx.next();
      let p = lx.buf.length ? null : lx.pos;
      if (p === null) { p = this.src.indexOf('stream', pos) + 6; }
      if (this.src[p] === '\r') p++;
      if (this.src[p] === '\n') p++;
      let len = this.get(value.Length);
      let end = -1;
      if (Number.isInteger(len) && len >= 0 && this.src.slice(p + len, p + len + 30).includes('endstream')) end = p + len;
      if (end < 0) {
        end = this.src.indexOf('endstream', p);
        if (end < 0) end = this.src.length;
        if (this.src[end - 1] === '\n') end--;
        if (this.src[end - 1] === '\r') end--;
      }
      return { dict: value, raw: this.src.slice(p, end), isStream: true };
    }
    return value;
  }

  streamData(obj) {
    if (!obj || !obj.isStream) return Buffer.alloc(0);
    let data = Buffer.from(obj.raw, 'latin1');
    let filters = this.get(obj.dict.Filter);
    let parms = this.get(obj.dict.DecodeParms);
    if (!filters) return data;
    if (!Array.isArray(filters)) { filters = [filters]; parms = [parms]; }
    if (!Array.isArray(parms)) parms = [parms];
    filters.forEach((f, i) => {
      const name = this.get(f)?.name;
      const p = this.get(parms[i]);
      if (name === 'FlateDecode' || name === 'Fl') data = predict(inflate(data), p, this);
      else if (name === 'ASCIIHexDecode' || name === 'AHx') data = asciiHex(data);
      else if (name === 'ASCII85Decode' || name === 'A85') data = ascii85(data);
      else if (name === 'LZWDecode' || name === 'LZW') data = predict(lzw(data, p ? this.get(p.EarlyChange) ?? 1 : 1), p, this);
      else throw new Error('unsupported filter ' + name); // images etc.
    });
    return data;
  }

  pages() {
    const out = [];
    let catalog = null;
    for (const num of [...this.direct.keys(), ...this.inStream.keys()]) {
      if (!this.src.slice(this.direct.get(num) ?? 0, (this.direct.get(num) ?? 0) + 400).includes('Catalog') && this.direct.has(num)) continue;
      const o = this.get(new Ref(num, 0));
      if (o && !o.isStream && this.get(o.Type)?.name === 'Catalog') { catalog = o; break; }
    }
    const seen = new Set();
    const walk = (nodeRef, inherited) => {
      if (out.length >= MAX_PAGES) return;
      const key = nodeRef instanceof Ref ? nodeRef.num : null;
      if (key !== null) { if (seen.has(key)) return; seen.add(key); }
      const node = this.get(nodeRef);
      if (!node || node.isStream) return;
      const res = node.Resources !== undefined ? this.get(node.Resources) : inherited;
      const kids = this.get(node.Kids);
      if (Array.isArray(kids)) for (const k of kids) walk(k, res);
      else if (this.get(node.Type)?.name === 'Page' || node.Contents !== undefined) out.push({ node, resources: res });
    };
    if (catalog) walk(catalog.Pages, null);
    if (!out.length) {
      // fallback: every /Type /Page object, by object number
      for (const num of [...this.direct.keys()].sort((a, b) => a - b)) {
        const o = this.get(new Ref(num, 0));
        if (o && !o.isStream && this.get(o.Type)?.name === 'Page') out.push({ node: o, resources: this.get(o.Resources) });
        if (out.length >= MAX_PAGES) break;
      }
    }
    return out;
  }
}

function inflate(data) {
  const opts = { maxOutputLength: MAX_STREAM_BYTES };
  try { return zlib.inflateSync(data, opts); } catch { /* try lenient */ }
  try { return zlib.inflateSync(data, { ...opts, finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { /* raw */ }
  return zlib.inflateRawSync(data, { ...opts, finishFlush: zlib.constants.Z_SYNC_FLUSH });
}

function predict(data, parms, doc) {
  const pred = parms ? doc.get(parms.Predictor) : 1;
  if (!pred || pred < 10) return data;
  const cols = (doc.get(parms.Columns) || 1) * (doc.get(parms.Colors) || 1) * ((doc.get(parms.BitsPerComponent) || 8) / 8);
  const bpp = Math.max(1, Math.round((doc.get(parms.Colors) || 1) * (doc.get(parms.BitsPerComponent) || 8) / 8));
  const rowLen = Math.round(cols) + 1;
  const out = Buffer.alloc(Math.floor(data.length / rowLen) * (rowLen - 1));
  let prev = Buffer.alloc(rowLen - 1);
  for (let r = 0; r * rowLen < data.length - 1; r++) {
    const type = data[r * rowLen];
    const row = Buffer.from(data.subarray(r * rowLen + 1, (r + 1) * rowLen));
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0; const b = prev[i]; const c = i >= bpp ? prev[i - bpp] : 0;
      if (type === 1) row[i] = (row[i] + a) & 0xff;
      else if (type === 2) row[i] = (row[i] + b) & 0xff;
      else if (type === 3) row[i] = (row[i] + ((a + b) >> 1)) & 0xff;
      else if (type === 4) {
        const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    row.copy(out, r * (rowLen - 1));
    prev = row;
  }
  return out;
}

function asciiHex(data) {
  let hex = data.toString('latin1').replace(/>.*$/s, '').replace(/[^0-9a-fA-F]/g, '');
  if (hex.length % 2) hex += '0';
  return Buffer.from(hex, 'hex');
}

function ascii85(data) {
  const s = data.toString('latin1').replace(/~>.*$/s, '').replace(/^<~/, '').replace(/\s/g, '');
  const out = []; let tuple = [];
  for (const ch of s) {
    if (ch === 'z' && tuple.length === 0) { out.push(0, 0, 0, 0); continue; }
    tuple.push(ch.charCodeAt(0) - 33);
    if (tuple.length === 5) {
      let v = 0; for (const t of tuple) v = v * 85 + t;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); tuple = [];
    }
  }
  if (tuple.length) {
    const n = tuple.length; while (tuple.length < 5) tuple.push(84);
    let v = 0; for (const t of tuple) v = v * 85 + t;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Buffer.from(out);
}

function lzw(data, early) {
  const out = []; let dict = []; let codeLen = 9; let prev = null; let bits = 0; let acc = 0;
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict[i] = [i]; dict[256] = null; dict[257] = null; codeLen = 9; prev = null; };
  reset();
  for (const byte of data) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= codeLen) {
      const code = (acc >>> (bits - codeLen)) & ((1 << codeLen) - 1); bits -= codeLen;
      if (code === 256) { reset(); continue; }
      if (code === 257) return Buffer.from(out);
      let entry = dict[code];
      if (!entry && prev) entry = [...prev, prev[0]];
      if (!entry) return Buffer.from(out);
      out.push(...entry);
      if (prev) dict.push([...prev, entry[0]]);
      prev = entry;
      if (dict.length + early >= (1 << codeLen) && codeLen < 12) codeLen++;
      if (out.length > MAX_STREAM_BYTES) return Buffer.from(out);
    }
  }
  return Buffer.from(out);
}

/* ---------------- fonts ---------------- */

const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';
const WIN_ANSI = Array.from({ length: 256 }, (_, i) => {
  if (i < 32) return '';
  if (i >= 0x80 && i <= 0x9f) return CP1252_HIGH[i - 0x80];
  return String.fromCharCode(i);
});

const GLYPHS = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&',
  quotesingle: "'", quoteright: '’', quoteleft: '‘', parenleft: '(', parenright: ')', asterisk: '*', plus: '+',
  comma: ',', hyphen: '-', period: '.', slash: '/', colon: ':', semicolon: ';', less: '<', equal: '=',
  greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^',
  underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~', bullet: '•',
  endash: '–', emdash: '—', quotedblleft: '“', quotedblright: '”', quotesinglbase: '‚', quotedblbase: '„',
  ellipsis: '…', degree: '°', copyright: '©', registered: '®', trademark: '™', section: '§', paragraph: '¶',
  periodcentered: '·', multiply: '×', divide: '÷', plusminus: '±', mu: 'µ', Euro: '€', sterling: '£', yen: '¥',
  cent: '¢', ordfeminine: 'ª', ordmasculine: 'º', exclamdown: '¡', questiondown: '¿', germandbls: 'ß',
  fi: 'fi', fl: 'fl', minus: '−', nbspace: ' ', uni00A0: ' ', sfthyphen: '-', guillemotleft: '«',
  guillemotright: '»', dotlessi: 'ı', oslash: 'ø', Oslash: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ',
  eth: 'ð', Eth: 'Ð', thorn: 'þ', Thorn: 'Þ', lslash: 'ł', Lslash: 'Ł', dagger: '†', daggerdbl: '‡',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  onehalf: '½', onequarter: '¼', threequarters: '¾', twosuperior: '²', threesuperior: '³', onesuperior: '¹',
};
const ACCENTS = { acute: '́', grave: '̀', circumflex: '̂', dieresis: '̈', tilde: '̃', cedilla: '̧', ring: '̊', caron: '̌' };

function glyphChar(name) {
  if (name in GLYPHS) return GLYPHS[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  let m = /^uni([0-9A-Fa-f]{4})/.exec(name) || /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  m = /^([A-Za-z])(acute|grave|circumflex|dieresis|tilde|cedilla|ring|caron)$/.exec(name);
  if (m) return (m[1] + ACCENTS[m[2]]).normalize('NFC');
  const base = name.split('.')[0];
  if (base !== name) return glyphChar(base);
  return '';
}

function utf16(hex) {
  let s = '';
  for (let i = 0; i + 3 < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
  if (hex.length === 2) s = String.fromCharCode(parseInt(hex, 16));
  return s;
}

function parseCMap(text) {
  const map = new Map(); let bytes = 0;
  for (const m of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const h of m[1].matchAll(/<([0-9a-fA-F]+)>/g)) bytes = Math.max(bytes, h[1].length / 2);
  }
  for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(parseInt(p[1], 16), utf16(p[2]));
      if (!bytes) bytes = p[1].length / 2;
    }
  }
  for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(p[1], 16); const hi = Math.min(parseInt(p[2], 16), lo + 65535);
      if (!bytes) bytes = p[1].length / 2;
      if (p[3] !== undefined) {
        const base = utf16(p[3]);
        for (let c = lo; c <= hi; c++) {
          map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo)));
        }
      } else {
        const list = [...p[4].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16(x[1]));
        list.forEach((s, i) => { if (lo + i <= hi) map.set(lo + i, s); });
      }
    }
  }
  return { map, bytes: bytes || 2 };
}

function buildFont(doc, fontRef) {
  const f = doc.get(fontRef);
  const font = { bytes: 1, toUni: null, enc: WIN_ANSI.slice(), widths: new Map(), dw: 500, scale: 0.001 };
  if (!f || f.isStream) return font;
  const subtype = doc.get(f.Subtype)?.name;
  const tu = doc.get(f.ToUnicode);
  if (tu && tu.isStream) {
    try { font.toUni = parseCMap(doc.streamData(tu).toString('latin1')); } catch { /* ignore */ }
  }
  if (subtype === 'Type0') {
    font.bytes = font.toUni && font.toUni.bytes === 1 ? 1 : 2;
    const desc = doc.get((doc.get(f.DescendantFonts) || [])[0]);
    if (desc) {
      font.dw = doc.get(desc.DW) ?? 1000;
      const w = doc.get(desc.W) || [];
      for (let i = 0; i < w.length;) {
        const first = doc.get(w[i]); const second = doc.get(w[i + 1]);
        if (Array.isArray(second)) { second.forEach((x, k) => font.widths.set(first + k, doc.get(x))); i += 2; }
        else { const wv = doc.get(w[i + 2]); for (let c = first; c <= second && c - first < 65536; c++) font.widths.set(c, wv); i += 3; }
      }
    } else font.dw = 1000;
    return font;
  }
  if (subtype === 'Type3') {
    const fm = doc.get(f.FontMatrix);
    if (Array.isArray(fm)) font.scale = doc.get(fm[0]) || 0.001;
  }
  const firstChar = doc.get(f.FirstChar) || 0;
  const widths = doc.get(f.Widths);
  if (Array.isArray(widths)) widths.forEach((w, i) => font.widths.set(firstChar + i, doc.get(w)));
  else {
    const base = doc.get(f.BaseFont)?.name || '';
    font.dw = /Courier/.test(base) ? 600 : 520;
    font.widths.set(32, /Courier/.test(base) ? 600 : 278);
  }
  const enc = doc.get(f.Encoding);
  if (enc && !(enc instanceof Name) && Array.isArray(doc.get(enc.Differences))) {
    let code = 0;
    for (const d of doc.get(enc.Differences)) {
      const v = doc.get(d);
      if (typeof v === 'number') code = v;
      else if (v instanceof Name) { if (code < 256) font.enc[code] = glyphChar(v.name); code++; }
    }
  }
  return font;
}

function decodeString(font, bytes) {
  const out = [];
  const n = font.bytes;
  for (let i = 0; i + n - 1 < bytes.length; i += n) {
    const code = n === 2 ? (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1) : bytes.charCodeAt(i);
    let ch = font.toUni ? font.toUni.map.get(code) : undefined;
    if (ch === undefined) ch = n === 1 ? font.enc[code] : '';
    const w = (font.widths.get(code) ?? font.dw) * font.scale;
    out.push({ ch: ch ?? '', w, space: n === 1 && code === 32 });
  }
  return out;
}

/* ---------------- content streams ---------------- */

const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const ID = [1, 0, 0, 1, 0, 0];

function runContent(doc, data, resources, ctm0, page, items, depth, fontCache) {
  const lx = new Lexer(data);
  const ops = [];
  let gs = { ctm: ctm0, font: null, size: 12, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 };
  const stack = [];
  let tm = ID; let tlm = ID;
  const res = doc.get(resources) || {};
  const fonts = doc.get(res.Font) || {};
  const xobjs = doc.get(res.XObject) || {};

  const getFont = (name) => {
    const ref = fonts[name];
    const key = ref instanceof Ref ? 'r' + ref.num : 'n' + name + depth;
    if (!fontCache.has(key)) fontCache.set(key, buildFont(doc, ref));
    return fontCache.get(key);
  };

  const show = (str) => {
    if (!gs.font || !(str instanceof PdfStr)) return;
    const glyphs = decodeString(gs.font, str.bytes);
    if (!glyphs.length) return;
    const start = mul([gs.size * gs.th, 0, 0, gs.size, 0, gs.rise], mul(tm, gs.ctm));
    let text = '';
    for (const g of glyphs) {
      text += g.ch;
      const tx = (g.w * gs.size + gs.tc + (g.space ? gs.tw : 0)) * gs.th;
      tm = mul([1, 0, 0, 1, tx, 0], tm);
    }
    const end = mul([1, 0, 0, 1, 0, gs.rise], mul(tm, gs.ctm));
    const size = Math.hypot(start[2], start[3]) || gs.size;
    if (text) items.push({ page, x: start[4], y: start[5], endX: end[4], size, text });
  };

  for (let guard = 0; guard < 2e6; guard++) {
    const t = lx.next();
    if (t === EOF) break;
    if (t === '[') {
      const arr = [];
      for (;;) { const x = lx.next(); if (x === ']' || x === EOF) break; arr.push(x); }
      ops.push(arr); continue;
    }
    if (t === '<<') { lx.buf.unshift('<<'); ops.push(lx.object()); continue; }
    if (!(t instanceof Op)) { ops.push(t); continue; }
    const op = t.op; const a = ops; const n = (i) => (typeof a[i] === 'number' ? a[i] : 0);
    switch (op) {
      case 'q': stack.push({ ...gs }); break;
      case 'Q': if (stack.length) gs = stack.pop(); break;
      case 'cm': if (a.length >= 6) gs.ctm = mul([n(0), n(1), n(2), n(3), n(4), n(5)], gs.ctm); break;
      case 'BT': tm = ID; tlm = ID; break;
      case 'Tf': gs.font = a[0] instanceof Name ? getFont(a[0].name) : gs.font; gs.size = n(1) || gs.size; break;
      case 'Tc': gs.tc = n(0); break;
      case 'Tw': gs.tw = n(0); break;
      case 'Tz': gs.th = n(0) / 100; break;
      case 'TL': gs.tl = n(0); break;
      case 'Ts': gs.rise = n(0); break;
      case 'Td': tlm = mul([1, 0, 0, 1, n(0), n(1)], tlm); tm = tlm; break;
      case 'TD': gs.tl = -n(1); tlm = mul([1, 0, 0, 1, n(0), n(1)], tlm); tm = tlm; break;
      case 'Tm': if (a.length >= 6) { tlm = [n(0), n(1), n(2), n(3), n(4), n(5)]; tm = tlm; } break;
      case 'T*': tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm; break;
      case 'Tj': show(a[0]); break;
      case "'": tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm; show(a[0]); break;
      case '"': gs.tw = n(0); gs.tc = n(1); tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm; show(a[2]); break;
      case 'TJ':
        if (Array.isArray(a[0])) {
          for (const el of a[0]) {
            if (el instanceof PdfStr) show(el);
            else if (typeof el === 'number') tm = mul([1, 0, 0, 1, (-el / 1000) * gs.size * gs.th, 0], tm);
          }
        }
        break;
      case 'Do': {
        if (depth > 5 || !(a[0] instanceof Name)) break;
        const xo = doc.get(xobjs[a[0].name]);
        if (xo && xo.isStream && doc.get(xo.dict.Subtype)?.name === 'Form') {
          let content;
          try { content = doc.streamData(xo).toString('latin1'); } catch { break; }
          const mtx = doc.get(xo.dict.Matrix);
          const m = Array.isArray(mtx) && mtx.length === 6 ? mtx.map((x) => doc.get(x)) : ID;
          runContent(doc, content, xo.dict.Resources ?? resources, mul(m, gs.ctm), page, items, depth + 1, fontCache);
        }
        break;
      }
      case 'BI': {
        const idm = /\sID[\s]/g; idm.lastIndex = lx.pos;
        const found = idm.exec(data);
        if (!found) { lx.pos = data.length; break; }
        const eim = /\sEI(?=[\s]|$)/g; eim.lastIndex = found.index + 4;
        const ei = eim.exec(data);
        lx.pos = ei ? ei.index + 3 : data.length; lx.buf = [];
        break;
      }
      default: break;
    }
    ops.length = 0;
  }
}

/* ---------------- layout ---------------- */

function buildLines(items) {
  const lines = [];
  const sorted = items
    .filter((it) => it.text.trim() !== '' || it.text === ' ')
    .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  for (const it of sorted) {
    const line = lines.length ? lines[lines.length - 1] : null;
    if (line && line.page === it.page && Math.abs(line.y - it.y) <= Math.max(2, 0.45 * Math.min(line.size, it.size))) line.items.push(it);
    else lines.push({ page: it.page, y: it.y, size: it.size, items: [it] });
  }
  return lines.map((l) => {
    l.items.sort((a, b) => a.x - b.x);
    const cells = [];
    let cur = null;
    for (const it of l.items) {
      const gap = cur ? it.x - cur.endX : Infinity;
      if (cur && gap < 0.7 * l.size) {
        const needsSpace = gap > 0.12 * l.size && !cur.text.endsWith(' ') && !it.text.startsWith(' ');
        cur.text += (needsSpace ? ' ' : '') + it.text;
        cur.endX = Math.max(cur.endX, it.endX);
      } else {
        cur = { x: it.x, endX: it.endX, text: it.text };
        cells.push(cur);
      }
    }
    return {
      page: l.page, y: l.y, size: l.size,
      cells: cells.map((c) => ({ x: c.x, endX: c.endX, text: c.text.replace(/\s+/g, ' ').trim() })).filter((c) => c.text),
      parts: l.items.filter((it) => it.text.trim()).map((it) => ({ x: it.x, endX: it.endX, text: it.text })),
    };
  }).filter((l) => l.cells.length);
}

function readPdf(buf) {
  const doc = new PdfDoc(buf);
  const items = []; const fontCache = new Map();
  const pages = doc.pages();
  pages.forEach(({ node, resources }, i) => {
    let contents = doc.get(node.Contents);
    if (!contents) return;
    if (!Array.isArray(contents)) contents = [node.Contents];
    const data = contents.map((c) => { try { return doc.streamData(doc.get(c)).toString('latin1'); } catch { return ''; } }).join('\n');
    try { runContent(doc, data, resources, ID, i + 1, items, 0, fontCache); } catch { /* keep what we have */ }
  });
  const lines = buildLines(items);
  const text = lines.map((l) => l.cells.map((c) => c.text).join('\t')).join('\n');
  return {
    kind: 'pdf',
    pages: pages.length,
    lines: lines.map((l) => ({ page: l.page, cells: l.cells.map((c) => c.text) })),
    // Rows are the gap-split cells; `layout` keeps positions so the importer
    // can re-split each line against the header row's column positions.
    tables: lines.length ? [{
      name: 'PDF text',
      rows: lines.map((l) => l.cells.map((c) => c.text)),
      layout: lines.map((l) => ({ size: l.size, page: l.page, cells: l.cells, parts: l.parts })),
    }] : [],
    text,
  };
}

module.exports = { readPdf, parseCMap, glyphChar, Lexer };

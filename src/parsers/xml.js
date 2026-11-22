'use strict';

// Tiny non-validating XML parser for Office Open XML parts. Ignores DTDs
// entirely (so no entity-expansion attacks), keeps element order.

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return ENTITIES[e] ?? m;
  });
}

function parseXml(src) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { top.children.push(m[1]); continue; }
    if (m[6] !== undefined) { top.children.push(decode(m[6])); continue; }
    if (!m[3]) continue; // comment / PI / doctype
    if (m[2] === '/') {
      // close: pop to the matching element (tolerates sloppy nesting)
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === m[3]) { stack.length = i; break; }
      }
      continue;
    }
    const attrs = {};
    const ar = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g; let a;
    while ((a = ar.exec(m[4] || ''))) attrs[a[1]] = decode(a[2] ?? a[3]);
    const el = { name: m[3], attrs, children: [] };
    top.children.push(el);
    if (!m[5]) stack.push(el);
  }
  return root;
}

const local = (name) => name.slice(name.indexOf(':') + 1);

// Depth-first search for elements by local name (namespace prefix ignored).
function findAll(node, name, out = []) {
  for (const c of node.children) {
    if (typeof c === 'string') continue;
    if (local(c.name) === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}
const find = (node, name) => findAll(node, name)[0] || null;
const kids = (node, name) => node.children.filter((c) => typeof c !== 'string' && (!name || local(c.name) === name));
const attr = (node, name) => {
  if (!node) return undefined;
  if (name in node.attrs) return node.attrs[name];
  for (const k of Object.keys(node.attrs)) if (local(k) === name) return node.attrs[k];
  return undefined;
};
function text(node) {
  if (typeof node === 'string') return node;
  return node.children.map(text).join('');
}

module.exports = { parseXml, findAll, find, kids, attr, text, local };

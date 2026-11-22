'use strict';

// Vanilla JS client. Registers, forms and the import preview are generated
// from /api/schema. All data is rendered with textContent (never innerHTML).

const $ = (sel, root = document) => root.querySelector(sel);
const S = { user: null, tabs: null, order: [], current: null, rows: [], editing: null, uploads: null };

/* ---------- helpers ---------- */

async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch('/api/' + path, {
    method,
    headers: raw ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {},
    body: raw || (body ? JSON.stringify(body) : undefined),
    credentials: 'same-origin',
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') showLogin();
  if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; e.data = data; throw e; }
  return data;
}

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k in n && k !== 'list') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const human = (v) => String(v).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const fmtDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};
const fmtWhen = (ts) => (ts ? fmtDate(ts) + ' ' + String(ts).slice(11, 16) : '');
const enumLabel = (def, v) => (v == null ? '' : def?.labels?.[v] || human(v));
const toneOf = (def, v) => def?.tones?.[v] || 'muted';
const badge = (text, tone = 'muted') => el('span', { class: `badge tone-${tone}`, text });
const statusField = (tab) => S.tabs[tab].statusField;
const titleOf = (tab, row) => S.tabs[tab].display.map((f) => row[f]).filter((v) => v != null && v !== '').join(' – ');

function daysFrom(iso) { return Math.round((Date.parse(iso) - Date.parse(today())) / 86400000); }

function valueNode(tab, field, v, row) {
  const t = S.tabs[tab];
  const def = t.fields[field] || t.computed?.[field];
  if (v === null || v === undefined || v === '') return '';
  if (def?.type === 'enum') return badge(enumLabel(def, v), toneOf(def, v));
  if (def?.type === 'bool') return badge(v === 'yes' ? 'Yes' : 'No', v === 'yes' ? 'ok' : 'warn');
  if (def?.type === 'date') return fmtDate(v);
  if (def?.type === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return String(v);
}

function textOf(tab, field, v) {
  const def = S.tabs[tab].fields[field];
  if (v === null || v === undefined || v === '') return '(empty)';
  if (def?.type === 'enum') return enumLabel(def, v);
  if (def?.type === 'bool') return v === 'yes' ? 'Yes' : 'No';
  if (def?.type === 'date') return fmtDate(v);
  return String(v);
}

function cellFor(tab, field, row) {
  const t = S.tabs[tab];
  const def = t.fields[field] || t.computed?.[field];
  const v = row[field];
  const td = el('td', {}, valueNode(tab, field, v, row));
  if (def?.type === 'number') td.className = 'num';
  if (def?.type === 'text' || (def?.type === 'string' && String(v || '').length > 40)) { td.className = 'clip'; td.title = v || ''; }
  if (field === t.due && v) {
    const done = t.done.includes(row[statusField(tab)]);
    const d = daysFrom(v);
    if (!done && d < 0) td.className = 'overdue';
    else if (!done && d <= (t.soonDays || 14)) td.className = 'soon';
  }
  if (field === 'age_days' && v != null) td.className = v > 28 ? 'num overdue' : v > 14 ? 'num soon' : 'num';
  return td;
}

/* ---------- auth & boot ---------- */

function showLogin() {
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  $('#login-form [name=username]').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#login-error').textContent = '';
  try {
    await api('login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
    e.target.reset();
    await start();
  } catch (err) { $('#login-error').textContent = err.message; }
});

$('#logout').addEventListener('click', async () => {
  await api('logout', { method: 'POST', body: {} }).catch(() => {});
  S.user = null;
  showLogin();
});

async function start() {
  const me = await api('me');
  S.user = me.user;
  await reloadSchema();
  $('#project-name').textContent = me.project;
  document.title = `${me.project} – Quality Dashboard`;
  $('#whoami').textContent = `${S.user.username} (${S.user.role})`;
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  route();
}

// Registers and document types can be edited, so the schema is reloaded after changes.
async function reloadSchema() {
  const schema = await api('schema');
  S.tabs = schema.tabs; S.order = schema.order; S.docTypes = schema.docTypes || [];
  $('#nav-registers').replaceChildren(...S.order.map((t) => el('a', { href: `#/r/${t}`, text: S.tabs[t].label, 'data-route': `r/${t}` })));
}

window.addEventListener('hashchange', () => S.user && route());

function route() {
  const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query || '');
  for (const s of document.querySelectorAll('main > section')) s.hidden = true;
  let key = parts[0] || 'dashboard';
  if (key === 'r' && S.tabs[parts[1]]) {
    key = `r/${parts[1]}`;
    showRegister(parts[1], parts[2] ? Number(parts[2]) : null);
  } else if (key === 'upload') showUpload(parts[1] ? Number(parts[1]) : null, params);
  else if (key === 'files') showFiles();
  else if (key === 'settings') { key = `settings/${parts[1] === 'doctypes' ? 'doctypes' : 'registers'}`; showSettings(parts.slice(1), params); }
  else { key = 'dashboard'; showDashboard(); }
  for (const a of document.querySelectorAll('.nav a')) {
    if (a.dataset.route === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
}

function show(id) { const s = $(id); s.hidden = false; return s; }

/* ---------- dashboard ---------- */

async function showDashboard() {
  const v = show('#view-dashboard');
  v.replaceChildren(el('p', { class: 'muted', text: 'Loading…' }));
  let d;
  try { d = await api('dashboard'); } catch (err) { v.replaceChildren(el('p', { class: 'error', text: err.message })); return; }
  const r = d.readiness;
  const atGc14 = d.ageing ? d.ageing.buckets.slice(2).reduce((s, b) => s + b.count, 0) : 0;
  const totalOverdue = d.cards.reduce((s, c) => s + c.overdue, 0);
  const totalHold = d.cards.reduce((s, c) => s + c.onHold, 0);
  const kpi = (label, value, sub, tone) => el('div', { class: `kpi tone-${tone}` },
    el('p', { class: 'label', text: label }), el('p', { class: 'value', text: value }), sub ? el('p', { class: 'sub', text: sub }) : null);

  const head = el('div', { class: 'page-head' },
    el('div', {}, el('h1', { text: 'Quality dashboard' }), el('p', { class: 'muted', text: `Status as of ${fmtDate(d.today)}` })),
    el('div', { class: 'actions' },
      el('a', { class: 'button', href: '/api/export.xlsx', download: '', text: 'Export all registers (.xlsx)' }),
      el('a', { class: 'button primary', href: '#/upload', text: 'Upload document' })));

  // status tiles: readiness %, then every status option that still needs work (not done / not N/A)
  const pending = (r.options || []).filter((o) => !o.done && !o.na);
  const kpis = el('div', { class: 'kpis' },
    r.register ? kpi('Audit readiness', r.applicable ? `${r.pct}%` : '–', r.applicable ? `${r.ready} of ${r.applicable} items ready` : 'Import your audit checklist',
      !r.applicable ? 'muted' : r.pct >= 80 ? 'ok' : r.pct >= 50 ? 'warn' : 'bad') : null,
    pending.map((o) => kpi(o.label, r.total ? r.counts[o.value] || 0 : '–', 'audit items', !r.total ? 'muted' : (r.counts[o.value] || 0) ? o.tone : 'ok')),
    kpi('Overdue', totalOverdue, 'across registers', totalOverdue ? 'bad' : 'ok'),
    kpi('On hold / blocked', totalHold, 'across registers', totalHold ? 'warn' : 'ok'),
    d.ageing ? kpi(`${d.ageing.label}: > 14 days in review`, atGc14, `${d.ageing.open} in review`, atGc14 ? 'warn' : 'ok') : null);

  let readinessRow = null;
  if (r.register) {
    const opts = r.options;
    const areaPanel = el('div', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', { text: 'Audit readiness by area' }), el('a', { href: `#/r/${r.register}`, class: 'small', text: 'Open checklist' })),
      r.total ? el('div', { class: 'areas' }, r.areas.map((a) => {
        const bar = el('div', { class: 'bar', title: opts.map((o) => `${o.label}: ${a.counts[o.value] || 0}`).join(' · ') });
        for (const o of opts) {
          const n = a.counts[o.value] || 0;
          if (n) { const sp = el('span', { class: `seg-tone-${o.na ? 'na' : o.tone}` }); sp.style.width = `${(n / a.total) * 100}%`; bar.append(sp); }
        }
        return el('div', { class: 'area-row' }, el('span', { text: a.area }), bar, el('span', { class: 'pct', text: `${a.pct}%` }));
      })) : el('p', { class: 'empty' }, 'No audit checklist yet. ', el('a', { href: `#/upload?tab=${r.register}`, text: 'Upload the checklist workbook' })),
      r.total ? el('div', { class: 'legend' }, opts.map((o) => el('span', {}, el('i', { class: `seg-tone-${o.na ? 'na' : o.tone}` }), o.label))) : null);
    const attention = el('div', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', { text: `Audit items needing action (${r.attention.length})` })),
      r.attention.length ? table(['Ref', 'Item', 'Status', 'Gap / action needed', 'Owner'], r.attention.slice(0, 40).map((a) => ({
        href: `#/r/${r.register}/${a.id}`,
        cells: [a.ref, a.title.replace(`${a.ref} – `, ''), badge(a.statusLabel, a.tone), a.gap || '—', a.owner || ''],
        clip: [1, 3],
      }))) : el('p', { class: 'muted', text: r.total ? 'Nothing needs action.' : 'Appears once the checklist is imported.' }));
    readinessRow = el('div', { class: 'grid2' }, areaPanel, attention);
  }

  const cards = el('div', { class: 'cards' }, d.cards.map((c) => el('a', { class: `reg-card tone-${c.tone}`, href: `#/r/${c.tab}`, title: c.description || '' },
    el('h3', { text: c.label }),
    el('span', { class: 'count', text: c.total }), el('span', { class: 'muted small', text: c.total === 1 ? ' record' : ' records' }),
    el('div', { class: 'chips' },
      c.overdue ? badge(`${c.overdue} overdue`, 'bad') : null,
      c.dueSoon ? badge(`${c.dueSoon} due soon`, 'warn') : null,
      c.onHold ? badge(`${c.onHold} on hold`, 'warn') : null,
      !c.total ? badge('empty', 'muted') : null,
      c.total && !c.overdue && !c.dueSoon && !c.onHold ? badge('OK', 'ok') : null),
    el('p', { class: 'muted small', text: c.lastUpload ? `Last upload ${fmtDate(c.lastUpload)}` : c.updated ? `Updated ${fmtDate(c.updated)}` : 'No data yet' }))));

  const itemRows = (list) => list.map((o) => ({
    href: `#/r/${o.tab}/${o.id}`,
    cells: [o.tabLabel, o.title, fmtDate(o.date), badge(o.days < 0 ? `${-o.days} d late` : o.days === 0 ? 'today' : `in ${o.days} d`, o.days < 0 ? 'bad' : 'warn'), o.owner || ''],
    clip: [1],
  }));
  const overdue = el('div', { class: 'panel' }, el('h2', { text: `Overdue (${d.overdue.length})` }),
    d.overdue.length ? table(['Register', 'Item', 'Date', '', 'Owner'], itemRows(d.overdue)) : el('p', { class: 'muted', text: 'Nothing overdue.' }));
  const soon = el('div', { class: 'panel' }, el('h2', { text: `Due soon (${d.dueSoon.length})` }),
    d.dueSoon.length ? table(['Register', 'Item', 'Date', '', 'Owner'], itemRows(d.dueSoon)) : el('p', { class: 'muted', text: 'Nothing due soon.' }));
  const hold = el('div', { class: 'panel' }, el('h2', { text: `On hold & why (${d.onHold.length})` }),
    d.onHold.length ? table(['Register', 'Item', 'Status', 'Reason'], d.onHold.map((o) => ({
      href: `#/r/${o.tab}/${o.id}`,
      cells: [o.tabLabel, o.title, badge(o.statusLabel || human(o.status), 'bad'), o.reason || '— no reason recorded —'], clip: [1, 3],
    }))) : el('p', { class: 'muted', text: 'Nothing on hold.' }));

  let ageing = null;
  if (d.ageing) {
    const maxB = Math.max(1, ...d.ageing.buckets.map((b) => b.count));
    const bucketTone = ['ok', 'warn', 'bad', 'bad'];
    ageing = el('div', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', { text: `${d.ageing.label}: waiting for review (${d.ageing.open})` }), el('a', { href: `#/r/${d.ageing.register}`, class: 'small', text: 'Open register' })),
      el('div', { class: 'hbars' }, d.ageing.buckets.map((b, i) => {
        const fill = el('div', { class: 'fill' }); fill.style.width = `${(b.count / maxB) * 100}%`;
        fill.style.background = `var(--${bucketTone[i]}-bar)`;
        return el('div', { class: 'hbar' }, el('span', { text: b.label }), el('div', { class: 'track' }, fill), el('span', { class: 'num', text: b.count }));
      })),
      d.ageing.oldest.length ? table(['Ref', 'Title', 'Days', 'Blocker'], d.ageing.oldest.map((s) => ({
        href: `#/r/${d.ageing.register}/${s.id}`, cells: [s.ref, s.title, badge(`${s.days} d`, s.days > 28 ? 'bad' : s.days > 14 ? 'warn' : 'ok'), s.blocker || ''], clip: [1, 3],
      }))) : el('p', { class: 'muted', text: 'Nothing in review.' }));
  }

  let deliveries = null;
  if (d.deliveriesRegister) {
    deliveries = el('div', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', { text: `Upcoming deliveries (${d.deliveries.length})` }), el('a', { href: `#/r/${d.deliveriesRegister}`, class: 'small', text: 'Open tracker' })),
      d.deliveries.length ? table(['Expected', 'PO', 'Item', 'Submittal', 'MIR'], d.deliveries.map((x) => ({
        href: `#/r/${d.deliveriesRegister}/${x.id}`,
        cells: [el('span', {}, fmtDate(x.expected), ' ', x.days < 0 ? badge(`${-x.days} d late`, 'bad') : null), x.po || '', x.item,
          x.submittalApproved === 'yes' ? badge('Approved', 'ok') : x.submittalApproved === 'no' ? badge('Not approved', 'bad') : '',
          x.mirDone === 'yes' ? badge('Done', 'ok') : x.mirDone === 'no' ? badge('Pending', 'warn') : ''],
        clip: [2],
      }))) : el('p', { class: 'muted', text: 'No deliveries expected in the next 3 weeks.' }));
  }

  let sources = null;
  if (d.sources && S.tabs[d.sources.register]) {
    const st = d.sources.register; const T = S.tabs[st];
    const cols = T.list.slice(0, 4);
    sources = el('div', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', { text: T.label }), el('a', { href: `#/r/${st}`, class: 'small', text: 'Edit' })),
      table(cols.map((f) => T.fields[f]?.label || f), d.sources.rows.map((s) => ({
        href: `#/r/${st}/${s.id}`, cells: cols.map((f) => valueNode(st, f, s[f], s)), clip: [2, 3],
      }))));
  }

  const pair = (a, b) => (a || b ? el('div', { class: 'grid2' }, a, b) : null);
  v.replaceChildren(...[head, kpis, readinessRow, el('h2', { text: 'Registers' }), cards,
    pair(overdue, soon), pair(hold, ageing), pair(deliveries, sources)].filter(Boolean));
}

function table(headers, rows) {
  return el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', { text: h })))),
    el('tbody', {}, rows.map((r) => {
      const tr = el('tr', { class: r.href ? 'click' : '' }, r.cells.map((c, i) => {
        const td = el('td', {}, c ?? '');
        if (r.clip?.includes(i)) { td.className = 'clip'; if (typeof c === 'string') td.title = c; }
        return td;
      }));
      if (r.href) tr.addEventListener('click', () => { location.hash = r.href; });
      return tr;
    }))));
}

/* ---------- upload & import ---------- */

async function showUpload(uploadId, params) {
  const v = show('#view-upload');
  const preTab = params.get('tab') || 'auto';
  const file = el('input', { type: 'file', accept: '.xlsx,.xlsm,.csv,.docx,.pdf,.jpg,.jpeg,.png,.tif,.tiff,.bmp', hidden: true });
  const fileName = el('span', { class: 'muted', text: 'Excel (.xlsx), CSV, Word (.docx), PDF (incl. scanned) or a photo/scan (.jpg, .png, .tif) · up to 25 MB' });
  const drop = el('div', { class: 'drop', tabIndex: 0, role: 'button' }, el('strong', { text: 'Drop a file here or click to choose' }), fileName, file);
  const docLabel = (d) => `${d.name}${d.mode === 'evidence' ? ' (evidence)' : d.register && S.tabs[d.register] ? ` → ${S.tabs[d.register].label}` : ''}`;
  const tabSel = el('select', { name: 'tab' },
    el('option', { value: 'auto', text: 'Detect automatically' }),
    S.docTypes.length ? el('optgroup', { label: 'Document types' }, S.docTypes.filter((d) => d.mode === 'evidence' || S.tabs[d.register]).map((d) => el('option', { value: `dt:${d.id}`, text: docLabel(d), title: d.description || '' }))) : null,
    el('optgroup', { label: 'Registers' }, S.order.map((t) => el('option', { value: t, text: S.tabs[t].label, title: S.tabs[t].description || '' }))),
    el('option', { value: 'evidence', text: 'Evidence only (just store the file)' }));
  const preDoc = params.get('doctype');
  tabSel.value = preDoc ? `dt:${preDoc}` : S.tabs[preTab] || preTab === 'evidence' ? preTab : 'auto';
  if (tabSel.selectedIndex < 0) tabSel.value = 'auto';
  const refSel = el('select', { name: 'checklist_ref' }, el('option', { value: '', text: '— none —' }));
  const checklistTab = S.order.find((t) => S.tabs[t].builtin === 'checklist');
  if (checklistTab) {
    const T = S.tabs[checklistTab];
    api(checklistTab).then(({ items }) => refSel.append(...items.map((i) => el('option', { value: i[T.key[0]], text: titleOf(checklistTab, i).slice(0, 90) })))).catch(() => {});
  }
  const hint = el('p', { class: 'muted small' });
  const showHint = () => {
    const v = tabSel.value;
    const d = v.startsWith('dt:') ? S.docTypes.find((x) => `dt:${x.id}` === v) : null;
    hint.textContent = d ? `${d.description || ''} ${d.mode === 'fields' ? 'Read as one record.' : d.mode === 'evidence' ? 'Stored, not read into a register.' : 'Read as a table.'}`
      : S.tabs[v] ? S.tabs[v].description || '' : v === 'auto' ? 'The app picks the register (or a document type whose keywords are in the file name).' : '';
    if (d?.checklist_ref && !refSel.value) refSel.value = d.checklist_ref;
  };
  tabSel.addEventListener('change', showHint);
  showHint();
  const go = el('button', { type: 'submit', class: 'primary', text: 'Upload and read', disabled: true });
  const msg = el('p', { class: 'error' });
  const result = el('div', { class: 'result' });

  let chosen = null;
  const pick = (f) => { chosen = f; fileName.textContent = f ? `${f.name} (${Math.round(f.size / 1024)} KB)` : ''; go.disabled = !f; };
  drop.addEventListener('click', () => file.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
  file.addEventListener('change', () => pick(file.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]); });

  const form = el('form', { class: 'upload-form card' }, drop,
    el('div', { class: 'form-row' },
      el('label', {}, 'What is this document?', tabSel),
      el('label', {}, 'Evidence for audit item (optional)', refSel)),
    hint,
    el('div', { class: 'actions' }, go), msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!chosen) return;
    go.disabled = true; go.textContent = /\.(pdf|jpe?g|png|tiff?|bmp)$/i.test(chosen.name) ? 'Reading (scans take a few seconds per page)…' : 'Reading…'; msg.textContent = '';
    try {
      const q = new URLSearchParams({ filename: chosen.name });
      if (tabSel.value.startsWith('dt:')) q.set('doc_type', tabSel.value.slice(3)); else q.set('tab', tabSel.value);
      if (refSel.value) q.set('checklist_ref', refSel.value);
      const r = await api(`uploads?${q}`, { method: 'POST', raw: chosen });
      S.uploads = null;
      history.replaceState(null, '', `#/upload/${r.upload.id}`);
      renderResult(result, r.upload, r.analysis, r.previous);
    } catch (err) { msg.textContent = err.message; }
    go.textContent = 'Upload and read'; go.disabled = !chosen;
  });

  v.replaceChildren(el('div', { class: 'page-head' }, el('div', {},
    el('h1', { text: 'Upload document' }),
    el('p', { class: 'muted', text: 'The file is read and shown as a preview first. Nothing changes in the registers until you click Import.' }))), form, result);

  if (uploadId) {
    try {
      const up = await api(`uploads/${uploadId}`);
      const dt = up.doc_type_id ? S.docTypes.find((d) => d.id === up.doc_type_id) : null;
      if ((up.tab === null && up.status === 'stored' && !dt) || dt?.mode === 'evidence') return renderResult(result, up, null, null);
      const a = await api(`uploads/${uploadId}/analyse`, { method: 'POST', body: { tab: up.tab || 'auto', docType: up.doc_type_id || undefined } });
      renderResult(result, up, a, null);
    } catch (err) { result.replaceChildren(el('p', { class: 'note tone-bad', text: err.message })); }
  }
}

function renderResult(box, upload, a, previous) {
  const parts = [];
  parts.push(el('div', { class: 'note' }, el('strong', { text: upload.filename }), ` · uploaded ${fmtWhen(upload.created_at)}`,
    ' · ', el('a', { href: `/api/uploads/${upload.id}/file`, text: 'download' }),
    upload.checklist_ref ? ` · evidence for audit item ${upload.checklist_ref}` : ''));
  if (previous) parts.push(el('p', { class: 'note tone-warn', text: `This exact file was already uploaded on ${fmtWhen(previous.created_at)} as "${previous.filename}". Importing again only applies differences.` }));

  if (!a || a.mode === 'evidence') {
    const dt = upload.doc_type_id ? S.docTypes.find((d) => d.id === upload.doc_type_id) : null;
    parts.push(el('p', { class: 'note tone-ok', text: `Stored as evidence${dt ? ` (${dt.name})` : ''}.${upload.checklist_ref ? '' : ' Tip: pick an audit item above when uploading so it counts as evidence for that item.'}` }));
    return box.replaceChildren(...parts);
  }

  // register / table / header controls → re-analyse
  const tabSel = el('select', {}, a.tab ? null : el('option', { value: '', text: '— choose a register —', disabled: true }),
    S.order.map((t) => el('option', { value: t, text: S.tabs[t].label })));
  tabSel.value = a.tab || '';
  const controls = el('div', { class: 'controls' }, el('label', {}, 'Read into register', tabSel));
  let tableSel = null; let headerInput = null;
  if (a.mode === 'table') {
    if (a.tables.length > 1) {
      tableSel = el('select', {}, a.tables.map((t) => el('option', { value: t.index, text: `${t.name} (${t.rows} rows)` })));
      tableSel.value = a.table;
      controls.append(el('label', {}, 'Sheet / table', tableSel));
    }
    headerInput = el('input', { type: 'number', min: 1, value: a.headerRow + 1 });
    controls.append(el('label', {}, 'Header row', headerInput));
  }
  const reanalyse = async (extra = {}) => {
    try {
      const body = { tab: tabSel.value, ...extra };
      if (a.docType && tabSel.value === a.tab && !('docType' in extra)) body.docType = a.docType.id;
      if (extra.keepTable !== false && tableSel && !('table' in extra)) body.table = Number(tableSel.value);
      const next = await api(`uploads/${upload.id}/analyse`, { method: 'POST', body });
      renderResult(box, upload, next, previous);
    } catch (err) { box.append(el('p', { class: 'note tone-bad', text: err.message })); }
  };
  tabSel.addEventListener('change', () => reanalyse({ keepTable: false }));
  tableSel?.addEventListener('change', () => reanalyse({ table: Number(tableSel.value) }));
  headerInput?.addEventListener('change', () => reanalyse({ table: a.table, headerRow: Number(headerInput.value) - 1 }));
  if (a.mode === 'table' && ['pdf', 'docx', 'image'].includes(a.kind)) {
    controls.append(el('button', { type: 'button', text: 'Read as a single document instead', onclick: () => reanalyse({ mode: 'fields', keepTable: false }) }));
  }
  if (a.mode === 'fields' && a.tables.length) {
    controls.append(el('button', { type: 'button', text: 'Read as a table instead', onclick: () => reanalyse({ keepTable: false }) }));
  }

  if (a.ocr && !a.ocr.error) {
    const pages = a.ocr.pages || [];
    parts.push(el('p', { class: 'note tone-warn', text: `Scanned ${pages.length === 1 ? 'page' : `pages (${pages.join(', ')})`} read with OCR (${a.ocr.engine}). OCR can misread characters, e.g. 0/O, 1/l, joined words: check the preview carefully before importing.${a.ocr.warnings?.length ? ' ' + a.ocr.warnings.join('; ') : ''}` }));
  }
  if (a.mode === 'error' || a.mode === 'none') {
    parts.push(el('p', { class: 'note tone-warn', text: a.message }), controls);
    if (a.excerpt) parts.push(el('details', {}, el('summary', { text: 'Text read from the document' }), el('pre', { class: 'excerpt', text: a.excerpt })));
    return box.replaceChildren(...parts);
  }

  const tab = S.tabs[a.tab];
  const detected = el('p', { class: 'note tone-ok' }, `Read as `, el('strong', { text: tab.label }),
    a.docType ? ` using document type "${a.docType.name}"` : '',
    a.mode === 'table' ? ` · ${a.tables[a.table]?.name || ''}, header on row ${a.headerRow + 1}` : ' · single document');
  parts.push(detected);
  if (a.unmatched) parts.push(el('p', { class: 'note tone-warn', text: `None of this file's headings are known to ${tab.label} yet. Choose a field for each column below; the register remembers your choices when you import.` }));
  if (S.user.role === 'admin' && !a.docType) {
    controls.append(el('button', { type: 'button', text: 'Save as document type…', title: 'Remember this register, reading mode and column mapping under a name you can pick at upload', onclick: () => saveAsDocType(upload, a, reanalyse) }));
  }
  parts.push(controls);

  if (a.mode === 'fields') {
    parts.push(fieldsForm(upload, a));
    return box.replaceChildren(...parts);
  }

  // table mode: mapping + preview
  const excluded = new Set(a.rows.filter((r) => r.warnings.includes('excluded by you')).map((r) => r.line));
  const mapped = a.mapping.map((f, i) => ({ f, i })).filter((x) => x.f);
  const fieldOptions = [el('option', { value: '', text: '— ignore —' }), ...Object.entries(tab.fields).map(([f, d]) => el('option', { value: f, text: d.label }))];
  const mapRow = el('tr', { class: 'map-row' }, el('th', { text: 'Column in file' }), el('th', { text: '→ field' }),
    a.headers.map((h, i) => {
      const s = el('select', { title: h }, fieldOptions.map((o) => o.cloneNode(true)));
      s.value = a.mapping[i] || '';
      s.addEventListener('change', () => {
        const mapping = [...a.mapping]; mapping[i] = s.value || null;
        reanalyse({ table: a.table, headerRow: a.headerRow, mapping, exclude: [...excluded] });
      });
      return el('th', {}, el('div', { class: 'src-head', text: h || `(column ${i + 1})` }), s);
    }), el('th'));

  const counts = el('div', { class: 'chips' });
  const importBtn = el('button', { type: 'button', class: 'primary' });
  const refresh = () => {
    const c = { create: 0, update: 0, unchanged: 0, skip: 0 };
    for (const r of a.rows) {
      const act = excluded.has(r.line) && r.action !== 'skip' ? 'skip' : r.action === 'skip' && r.warnings.includes('excluded by you') && !excluded.has(r.line) ? r.prevAction : r.action;
      c[act || 'skip']++;
    }
    if (a.total > a.rows.length) c.note = `(preview shows the first ${a.rows.length} of ${a.total} rows; counts are for the preview)`;
    counts.replaceChildren(badge(`${c.create} new`, c.create ? 'ok' : 'muted'), badge(`${c.update} updates`, c.update ? 'warn' : 'muted'),
      badge(`${c.unchanged} unchanged`, 'muted'), badge(`${c.skip} skipped`, c.skip ? 'bad' : 'muted'));
    if (c.note) counts.append(el('span', { class: 'muted small', text: c.note }));
    importBtn.textContent = `Import ${c.create} new + ${c.update} updates`;
    importBtn.disabled = !(c.create + c.update);
  };

  const actionBadge = (r) => {
    if (r.action === 'create') return badge('New', 'ok');
    if (r.action === 'update') return badge('Update', 'warn');
    if (r.action === 'unchanged') return badge('Unchanged', 'muted');
    return badge('Skip', 'bad');
  };
  const body = el('tbody', {}, a.rows.map((r) => {
    if (r.warnings.includes('excluded by you')) { r.prevAction = r.changes && Object.keys(r.changes).length ? 'update' : r.id ? 'unchanged' : 'create'; }
    const canToggle = !(r.action === 'skip' && !r.warnings.includes('excluded by you'));
    const box2 = el('input', { type: 'checkbox', checked: !excluded.has(r.line) && r.action !== 'skip', disabled: !canToggle, title: 'Include this row' });
    const tr = el('tr', { class: r.action === 'skip' ? 'skipped' : '' },
      el('td', {}, box2, ' ', el('span', { class: 'muted small', text: `#${r.line}` })),
      el('td', {}, actionBadge(r)),
      a.mapping.map((f) => {
        if (!f) return el('td', { class: 'muted' });
        const td = el('td', {}, valueNode(a.tab, f, r.values[f], r.values));
        if (r.changes?.[f]) { td.className = 'changed'; td.prepend(el('span', { class: 'from', text: textOf(a.tab, f, r.changes[f].from) })); }
        return td;
      }),
      el('td', { class: 'warn-list', text: r.warnings.filter((w) => w !== 'excluded by you').join(' · ') }));
    box2.addEventListener('change', () => {
      if (box2.checked) excluded.delete(r.line); else excluded.add(r.line);
      tr.classList.toggle('skipped', !box2.checked);
      refresh();
    });
    return tr;
  }));
  const wrap = el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, mapRow, el('tr', {}, el('th', { text: 'Row' }), el('th', { text: 'Action' }),
      a.mapping.map((f) => el('th', { text: f ? tab.fields[f].label : '' })), el('th', { text: 'Notes' }))),
    body));

  const unmapped = Object.entries(tab.fields).filter(([f, d]) => d.required && !a.mapping.includes(f)).map(([, d]) => d.label);
  if (unmapped.length) parts.push(el('p', { class: 'note tone-bad', text: `Required field not matched to a column: ${unmapped.join(', ')}. Pick it in the column selectors below.` }));
  const done = el('div');
  importBtn.addEventListener('click', async () => {
    importBtn.disabled = true; importBtn.textContent = 'Importing…';
    try {
      const res = await api(`uploads/${upload.id}/import`, { method: 'POST', body: { tab: a.tab, docType: a.docType?.id, table: a.table, headerRow: a.headerRow, mapping: a.mapping, exclude: [...excluded] } });
      showImported(box, res);
    } catch (err) { done.replaceChildren(el('p', { class: 'note tone-bad', text: err.message })); refresh(); }
  });
  refresh();
  parts.push(el('div', { class: 'controls' }, counts, el('span', { class: 'spacer' }), importBtn), done,
    el('p', { class: 'muted small', text: 'Pick a field for each column, untick rows you don\'t want, then import. Changed values show the old value crossed out. Empty cells never clear existing data.' }),
    wrap);
  box.replaceChildren(...parts);
}

async function saveAsDocType(upload, a, reanalyse) {
  const tab = S.tabs[a.tab];
  const name = prompt(`Name for this document type (e.g. "ACC issues export"). It will read files into ${tab.label} ${a.mode === 'fields' ? 'as one record' : 'as a table'} with the current column mapping.`);
  if (!name) return;
  const words = upload.filename.replace(/\.[^.]+$/, '').replace(/[\d_\-.()]+/g, ' ').trim().toLowerCase();
  const mapping = {};
  if (a.mode === 'table') a.headers.forEach((h, i) => { if (h) mapping[h] = a.mapping[i] || ''; });
  try {
    const dt = await api('doctypes', { method: 'POST', body: { name, register: a.tab, mode: a.mode === 'fields' ? 'fields' : 'table', keywords: words ? [words] : [], mapping } });
    await reloadSchema();
    await reanalyse({ docType: dt.id, keepTable: false });
  } catch (err) { alert(err.message); }
}

function fieldsForm(upload, a) {
  const tab = S.tabs[a.tab];
  const row = a.rows[0];
  const form = el('form', { class: 'card' });
  const fields = buildFields(tab, row.values, a.found);
  const err = el('p', { class: 'error' });
  const what = row.action === 'update' ? `Matches existing ${tab.singular.toLowerCase()} — saving updates it.`
    : row.action === 'unchanged' ? `Matches an existing ${tab.singular.toLowerCase()} with the same values.`
      : `Will create a new ${tab.singular.toLowerCase()}.`;
  form.append(el('p', { class: 'muted', text: `Check the values read from the document (green hints show where each came from), fill any gaps, then save. ${what}` }),
    fields, err, el('div', { class: 'actions' }, el('button', { type: 'submit', class: 'primary', text: 'Save to register' })));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const record = readFields(tab, form);
    try {
      const res = await api(`uploads/${upload.id}/import`, { method: 'POST', body: { tab: a.tab, docType: a.docType?.id, mode: 'fields', record } });
      showImported(form.parentElement, res);
    } catch (e2) { err.textContent = e2.message; }
  });
  return form;
}

function showImported(box, res) {
  const tab = S.tabs[res.tab];
  box.replaceChildren(el('div', { class: 'note tone-ok' },
    el('strong', { text: `Imported into ${tab.label}: ` }),
    `${res.created} created, ${res.updated} updated, ${res.unchanged} unchanged, ${res.skipped} skipped.`),
  res.learned?.register?.length ? el('p', { class: 'note', text: `Learned for next time: ${res.learned.register.join('; ')}.` }) : '',
  el('div', { class: 'actions' },
    el('a', { class: 'button primary', href: `#/r/${res.tab}`, text: `Open ${tab.label}` }),
    el('a', { class: 'button', href: '#/', text: 'Dashboard' }),
    el('button', { type: 'button', text: 'Upload another', onclick: () => { location.hash = '#/upload'; showUpload(null, new URLSearchParams()); } })));
}

/* ---------- uploaded files ---------- */

async function showFiles() {
  const v = show('#view-files');
  v.replaceChildren(el('p', { class: 'muted', text: 'Loading…' }));
  const { items } = await api('uploads');
  const statusBadge = (u) => {
    if (u.status === 'imported') return badge(`Imported${u.summary ? ` · ${u.summary.created} new, ${u.summary.updated} upd.` : ''}`, 'ok');
    if (u.status === 'analysed') return badge('Read, not imported', 'warn');
    if (u.status === 'failed') return badge('Could not read', 'bad');
    return badge('Stored', 'muted');
  };
  const rows = items.map((u) => el('tr', {},
    el('td', { text: fmtWhen(u.created_at) }),
    el('td', { class: 'clip', title: u.filename }, el('a', { href: `/api/uploads/${u.id}/file`, text: u.filename })),
    el('td', { text: u.tab ? S.tabs[u.tab]?.label || u.tab : '—' }),
    el('td', {}, statusBadge(u), u.status === 'failed' && u.summary?.error ? el('div', { class: 'muted small', text: u.summary.error }) : null),
    el('td', { text: u.checklist_ref || '' }),
    el('td', { text: u.uploaded_by }),
    el('td', {},
      el('a', { href: `#/upload/${u.id}`, text: u.status === 'imported' ? 'Re-import' : 'Review & import' }),
      S.user.role === 'admin' ? el('button', {
        type: 'button', class: 'link', text: ' · Delete',
        onclick: async () => { if (confirm(`Delete ${u.filename}? Records already imported stay.`)) { await api(`uploads/${u.id}`, { method: 'DELETE' }); showFiles(); } },
      }) : null)));
  v.replaceChildren(
    el('div', { class: 'page-head' }, el('div', {}, el('h1', { text: 'Uploaded files' }), el('p', { class: 'muted', text: `${items.length} file(s). Files are kept on this server, not in Git.` })),
      el('div', { class: 'actions' }, el('a', { class: 'button primary', href: '#/upload', text: 'Upload document' }))),
    items.length ? el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Uploaded', 'File', 'Register', 'Status', 'Audit item', 'By', ''].map((h) => el('th', { text: h })))),
      el('tbody', {}, rows))) : el('p', { class: 'empty', text: 'No files uploaded yet.' }));
}

/* ---------- registers ---------- */

let loadSeq = 0;
async function showRegister(name, openId) {
  show('#view-register');
  const changed = S.current !== name;
  S.current = name;
  const t = S.tabs[name];
  $('#reg-title').textContent = t.label;
  $('#new-btn').textContent = `New ${t.singular.toLowerCase()}`;
  $('#reg-import').href = `#/upload?tab=${name}`;
  $('#reg-export').href = `/api/${name}/export.xlsx`;
  $('#reg-template').href = `/api/${name}/template.xlsx`;
  $('#reg-edit').href = `#/settings/registers/${name}`;
  $('#reg-edit').textContent = S.user.role === 'admin' ? 'Edit register' : 'Register settings';
  $('#reg-desc').textContent = t.description || '';
  if (changed) {
    $('#search').value = '';
    const sf = statusField(name);
    const filter = $('#status-filter');
    filter.hidden = !sf;
    filter.replaceChildren(el('option', { value: '', text: 'All statuses' }),
      ...(sf ? t.fields[sf].values.map((v) => el('option', { value: v, text: enumLabel(t.fields[sf], v) })) : []));
  }
  await loadRegister();
  if (openId) {
    const row = S.rows.find((r) => r.id === openId);
    if (row) openEditor(row);
  }
}

let searchTimer;
$('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadRegister, 250); });
$('#status-filter').addEventListener('change', loadRegister);
$('#new-btn').addEventListener('click', () => openEditor(null));

async function loadRegister() {
  const name = S.current; const seq = ++loadSeq;
  const t = S.tabs[name];
  const params = new URLSearchParams();
  if ($('#search').value.trim()) params.set('q', $('#search').value.trim());
  const sf = statusField(name);
  if (sf && $('#status-filter').value) params.set(sf, $('#status-filter').value);
  const { items } = await api(`${name}?${params}`);
  if (seq !== loadSeq) return;
  S.rows = items;
  const cols = t.list;
  $('#grid thead').replaceChildren(el('tr', {}, cols.map((f) => el('th', { text: (t.fields[f] || t.computed?.[f])?.label || f })), el('th', { text: 'Source' })));
  $('#grid tbody').replaceChildren(...items.map((row) => {
    const tr = el('tr', { class: 'click' }, cols.map((f) => cellFor(name, f, row)),
      el('td', {}, row.source_upload_id ? el('a', { href: `/api/uploads/${row.source_upload_id}/file`, text: 'file', onclick: (e) => e.stopPropagation() }) : ''));
    tr.addEventListener('click', () => openEditor(row));
    return tr;
  }));
  const empty = $('#empty');
  empty.hidden = items.length > 0;
  empty.replaceChildren(params.toString() ? 'No matching records.' : el('span', {}, 'No records yet. ',
    el('a', { href: `#/upload?tab=${name}`, text: 'Import a file' }), ' or click New.'));
  const parts = [`${items.length} record${items.length === 1 ? '' : 's'}`];
  if (sf) {
    const c = {};
    for (const r of items) if (r[sf]) c[r[sf]] = (c[r[sf]] || 0) + 1;
    parts.push(...Object.entries(c).map(([k, n]) => `${enumLabel(t.fields[sf], k)}: ${n}`));
  }
  if (t.due) {
    const over = items.filter((r) => r[t.due] && daysFrom(r[t.due]) < 0 && !t.done.includes(r[sf])).length;
    if (over) parts.push(`overdue: ${over}`);
  }
  $('#reg-summary').textContent = parts.join(' · ');
}

/* ---------- editor ---------- */

function buildFields(tab, values = {}, found = {}) {
  const wrap = el('div', { class: 'fields' });
  for (const [key, f] of Object.entries(tab.fields)) {
    const value = values[key] ?? (Object.keys(values).length ? null : f.default) ?? '';
    let input;
    if (f.type === 'enum') {
      input = el('select', {}, f.required ? null : el('option', { value: '', text: '—' }), f.values.map((v) => el('option', { value: v, text: enumLabel(f, v) })));
    } else if (f.type === 'bool') {
      input = el('select', {}, el('option', { value: '', text: '—' }), el('option', { value: 'yes', text: 'Yes' }), el('option', { value: 'no', text: 'No' }));
    } else if (f.type === 'text') input = el('textarea');
    else input = el('input', { type: f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text', step: f.type === 'number' ? 'any' : undefined, maxLength: f.max || undefined });
    input.name = key;
    input.required = !!f.required;
    input.value = value == null ? '' : String(value);
    if (input.tagName === 'SELECT' && input.selectedIndex < 0) input.selectedIndex = 0;
    wrap.append(el('label', { class: f.type === 'text' ? 'wide' : '' }, f.label + (f.required ? ' *' : ''), input,
      found[key] ? el('span', { class: 'hint', text: `from "${found[key]}"` }) : null));
  }
  return wrap;
}

function readFields(tab, form) {
  const out = {};
  for (const key of Object.keys(tab.fields)) {
    const v = form.elements[key].value;
    out[key] = v === '' ? null : v;
  }
  return out;
}

async function openEditor(row) {
  const name = S.current; const t = S.tabs[name];
  S.editing = row;
  $('#edit-title').textContent = row ? `${t.singular}: ${titleOf(name, row)}` : `New ${t.singular.toLowerCase()}`;
  $('#edit-error').textContent = '';
  $('#edit-fields').replaceWith(Object.assign(buildFields(t, row || {}), { id: 'edit-fields' }));
  $('#delete-btn').hidden = !(row && S.user.role === 'admin');
  $('#edit-source').replaceChildren(row?.source_upload_id ? el('span', {}, 'Last imported from ', el('a', { href: `/api/uploads/${row.source_upload_id}/file`, text: 'this file' })) : '');
  const hist = $('#history'); hist.hidden = !row; hist.open = false;
  $('#history-list').replaceChildren();
  if (row) {
    api(`activity?resource=${name}&record_id=${row.id}`).then(({ items }) => {
      $('#history-list').replaceChildren(...items.map((x) => {
        const what = (x.action === 'update' || x.action === 'import') && x.changes
          ? `${x.action === 'import' ? 'import: ' : ''}${Object.entries(x.changes).map(([k, c]) => `${t.fields[k]?.label || k}: ${c.from ?? '—'} → ${c.to ?? '—'}`).join(', ')}`
          : x.action;
        return el('li', { text: `${fmtWhen(x.at)} · ${x.username} · ${what}` });
      }));
    }).catch(() => {});
  }
  $('#editor').showModal();
}

$('#cancel-btn').addEventListener('click', () => { $('#editor').close(); });
$('#editor').addEventListener('close', () => { if (/^#\/r\/\w+\/\d+/.test(location.hash)) history.replaceState(null, '', `#/r/${S.current}`); });

$('#edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = S.current; const t = S.tabs[name];
  const body = readFields(t, e.target);
  try {
    if (S.editing) await api(`${name}/${S.editing.id}`, { method: 'PATCH', body: { ...body, version: S.editing.version } });
    else await api(name, { method: 'POST', body });
    $('#editor').close();
    loadRegister();
  } catch (err) {
    $('#edit-error').textContent = err.status === 409
      ? 'Someone else changed this record while you were editing. Close and reopen it to see their changes.'
      : err.message;
  }
});

$('#delete-btn').addEventListener('click', async () => {
  if (!S.editing || !confirm('Delete this record? This cannot be undone.')) return;
  try {
    await api(`${S.current}/${S.editing.id}`, { method: 'DELETE' });
    $('#editor').close();
    loadRegister();
  } catch (err) { $('#edit-error').textContent = err.message; }
});

/* ---------- boot ---------- */

api('me').then(() => start()).catch(() => showLogin());

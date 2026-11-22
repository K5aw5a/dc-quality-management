'use strict';

// Vanilla JS client. Forms and tables are generated from /api/schema, so the
// frontend needs no changes when a field is added to src/schema.js.
// All record data is rendered with textContent (never innerHTML).

const $ = (sel) => document.querySelector(sel);
const state = { user: null, schema: null, current: null, rows: [], refCache: {}, editing: null };

const GOOD = new Set(['approved', 'approved_as_noted', 'passed', 'closed', 'current', 'pass']);
const BAD = new Set(['rejected', 'failed', 'blocked', 'fail', 'critical', 'withdrawn']);
const WARN = new Set(['revise_resubmit', 'passed_with_findings', 'under_review', 'in_progress', 'high', 'major', 'observation']);
const DONE = new Set(['approved', 'approved_as_noted', 'passed', 'passed_with_findings', 'closed', 'cancelled', 'rejected']);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api/' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') { showLogin(); }
  if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; e.data = data; throw e; }
  return data;
}

const human = (v) => String(v).replace(/_/g, ' ');
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
};
const today = () => new Date().toISOString().slice(0, 10);

/* ---------- auth ---------- */

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
    const { user } = await api('login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
    e.target.reset();
    await start(user);
  } catch (err) { $('#login-error').textContent = err.message; }
});

$('#logout').addEventListener('click', async () => {
  await api('logout', { method: 'POST', body: {} }).catch(() => {});
  state.user = null;
  showLogin();
});

/* ---------- layout ---------- */

async function start(user) {
  state.user = user;
  state.schema = (await api('schema')).resources;
  $('#whoami').textContent = `${user.username} (${user.role})`;
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  const tabs = $('#tabs');
  tabs.replaceChildren(...Object.entries(state.schema).map(([name, def]) => {
    const b = el('button', { type: 'button', textContent: def.label });
    b.dataset.name = name;
    b.addEventListener('click', () => { location.hash = name; });
    return b;
  }));
  route();
}

window.addEventListener('hashchange', () => state.user && route());

function route() {
  const name = location.hash.slice(1);
  select(Object.hasOwn(state.schema, name) ? name : Object.keys(state.schema)[0]);
}

function select(name) {
  state.current = name;
  const def = state.schema[name];
  for (const b of $('#tabs').children) {
    if (b.dataset.name === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  $('#view-title').textContent = def.label;
  $('#new-btn').textContent = `New ${def.singular.toLowerCase()}`;
  $('#search').value = '';
  const statusDef = def.fields.status;
  const filter = $('#status-filter');
  filter.hidden = !statusDef;
  filter.replaceChildren(el('option', { value: '', textContent: 'All statuses' }),
    ...(statusDef ? statusDef.values.map((v) => el('option', { value: v, textContent: human(v) })) : []));
  load();
}

let searchTimer;
$('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 250); });
$('#status-filter').addEventListener('change', load);
$('#new-btn').addEventListener('click', () => openEditor(null));

/* ---------- table ---------- */

async function refOptions(resource) {
  if (!state.refCache[resource]) state.refCache[resource] = (await api(resource)).items;
  return state.refCache[resource];
}

function refLabel(def, id) {
  const row = (state.refCache[def.ref] || []).find((r) => r.id === id);
  return row ? row[def.display] : `#${id}`;
}

async function load() {
  const name = state.current;
  const def = state.schema[name];
  const params = new URLSearchParams();
  if ($('#search').value.trim()) params.set('q', $('#search').value.trim());
  if ($('#status-filter').value) params.set('status', $('#status-filter').value);
  for (const f of Object.values(def.fields)) if (f.type === 'ref') await refOptions(f.ref);
  const { items } = await api(`${name}?${params}`);
  if (state.current !== name) return;
  state.rows = items;
  render();
}

function cell(def, field, value, row) {
  const f = def.fields[field];
  const td = el('td');
  if (value == null || value === '') return td;
  if (f.type === 'enum') {
    const cls = GOOD.has(value) ? 'good' : BAD.has(value) ? 'bad' : WARN.has(value) ? 'warn' : '';
    td.append(el('span', { className: `badge ${cls}`, textContent: human(value) }));
  } else if (f.type === 'ref') {
    td.textContent = refLabel(f, value);
  } else if (f.type === 'url') {
    const a = el('a', { href: value, textContent: 'open', target: '_blank', rel: 'noopener noreferrer' });
    a.addEventListener('click', (e) => e.stopPropagation());
    td.append(a);
  } else {
    td.textContent = value;
    if (f.type === 'date' && value < today() && !DONE.has(row.status)) td.className = 'overdue';
  }
  return td;
}

function render() {
  const def = state.schema[state.current];
  $('#grid thead').replaceChildren(el('tr', {}, ...def.list.map((f) => el('th', { textContent: def.fields[f].label }))));
  $('#grid tbody').replaceChildren(...state.rows.map((row) => {
    const tr = el('tr', {}, ...def.list.map((f) => cell(def, f, row[f], row)));
    tr.addEventListener('click', () => openEditor(row));
    return tr;
  }));
  $('#empty').hidden = state.rows.length > 0;
  const statusDef = def.fields.status;
  if (statusDef) {
    const counts = {};
    for (const r of state.rows) counts[r.status] = (counts[r.status] || 0) + 1;
    const overdue = state.rows.filter((r) => Object.entries(def.fields)
      .some(([k, f]) => f.type === 'date' && r[k] && r[k] < today() && !DONE.has(r.status))).length;
    $('#summary').textContent = `${state.rows.length} shown · ` +
      Object.entries(counts).map(([k, n]) => `${human(k)}: ${n}`).join(' · ') +
      (overdue ? ` · overdue: ${overdue}` : '');
  } else {
    $('#summary').textContent = `${state.rows.length} shown`;
  }
}

/* ---------- editor ---------- */

async function openEditor(row) {
  const name = state.current;
  const def = state.schema[name];
  state.editing = row;
  $('#edit-title').textContent = row ? `Edit ${def.singular.toLowerCase()}` : `New ${def.singular.toLowerCase()}`;
  $('#edit-error').textContent = '';
  const fields = [];
  for (const [key, f] of Object.entries(def.fields)) {
    const value = row ? row[key] : f.default;
    let input;
    if (f.type === 'enum') {
      input = el('select', {}, ...(f.required ? [] : [el('option', { value: '', textContent: '—' })]),
        ...f.values.map((v) => el('option', { value: v, textContent: human(v) })));
    } else if (f.type === 'ref') {
      const opts = await refOptions(f.ref);
      input = el('select', {}, el('option', { value: '', textContent: '—' }),
        ...opts.map((o) => el('option', { value: String(o.id), textContent: o[f.display] })));
    } else if (f.type === 'text') {
      input = el('textarea');
    } else {
      input = el('input', { type: f.type === 'date' ? 'date' : f.type === 'url' ? 'url' : 'text' });
      if (f.max) input.maxLength = f.max;
    }
    input.name = key;
    input.required = !!f.required;
    input.value = value == null ? '' : String(value);
    if (input.tagName === 'SELECT' && input.selectedIndex < 0) input.selectedIndex = 0;
    fields.push(el('label', { className: f.type === 'text' || key === 'title' ? 'wide' : '' }, f.label + (f.required ? ' *' : ''), input));
  }
  $('#edit-fields').replaceChildren(...fields);
  $('#delete-btn').hidden = !(row && state.user.role === 'admin');

  const history = $('#history');
  history.hidden = !row;
  history.open = false;
  $('#history-list').replaceChildren();
  if (row) {
    api(`activity?resource=${name}&record_id=${row.id}`).then(({ items }) => {
      $('#history-list').replaceChildren(...items.map((a) => {
        const what = a.action === 'update' && a.changes
          ? Object.entries(a.changes).map(([k, c]) => `${k}: ${c.from ?? '—'} → ${c.to ?? '—'}`).join(', ')
          : a.action;
        return el('li', { textContent: `${a.at.slice(0, 16).replace('T', ' ')} · ${a.username} · ${what}` });
      }));
    }).catch(() => {});
  }
  $('#editor').showModal();
}

$('#cancel-btn').addEventListener('click', () => $('#editor').close());

$('#edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = state.current;
  const def = state.schema[name];
  const body = {};
  for (const [key, f] of Object.entries(def.fields)) {
    const v = e.target.elements[key].value;
    body[key] = v === '' ? null : f.type === 'ref' ? Number(v) : v;
  }
  try {
    if (state.editing) {
      body.version = state.editing.version;
      await api(`${name}/${state.editing.id}`, { method: 'PATCH', body });
    } else {
      await api(name, { method: 'POST', body });
    }
    delete state.refCache[name];
    $('#editor').close();
    load();
  } catch (err) {
    $('#edit-error').textContent = err.status === 409
      ? 'Someone else changed this record while you were editing. Close and reopen it to see their changes.'
      : err.message;
  }
});

$('#delete-btn').addEventListener('click', async () => {
  if (!state.editing || !confirm('Delete this record? This cannot be undone.')) return;
  try {
    await api(`${state.current}/${state.editing.id}`, { method: 'DELETE' });
    delete state.refCache[state.current];
    $('#editor').close();
    load();
  } catch (err) { $('#edit-error').textContent = err.message; }
});

/* ---------- boot ---------- */

api('me').then(({ user }) => start(user)).catch(() => showLogin());

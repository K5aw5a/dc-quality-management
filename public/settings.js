'use strict';

// Settings: edit registers (columns, status options, rules) and document types.
// Uses the helpers defined in app.js (el, api, S, badge, ...). Admin-only edits;
// everyone else sees the same pages read-only.

const TYPE_LABELS = {
  string: 'Text', text: 'Long text', enum: 'Status / choice', date: 'Date', number: 'Number', bool: 'Yes / No', url: 'Link',
};
const TONE_LABELS = { ok: 'Green (OK)', warn: 'Amber (in progress)', bad: 'Red (problem)', muted: 'Grey (neutral)' };
const MODE_LABELS = { table: 'Table (many rows)', fields: 'Single document (one record)', evidence: 'Evidence only (store the file)' };

const isAdmin = () => S.user?.role === 'admin';
const csv = (a) => (a || []).join(', ');
const splitList = (s) => String(s || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
let newKey = 0;
const put = (target, ...nodes) => target.replaceChildren(...nodes.flat().filter((n) => n !== null && n !== undefined && n !== false));

async function showSettings(parts) {
  const v = show('#view-settings');
  put(v, el('p', { class: 'muted', text: 'Loading…' }));
  try {
    if (parts[0] === 'doctypes') {
      if (parts[1]) await docTypeEditor(v, parts[1]); else await docTypeList(v);
    } else if (parts[1]) await registerEditor(v, parts[1]);
    else await registerList(v);
  } catch (err) { put(v, el('p', { class: 'note tone-bad', text: err.message })); }
}

function pageHead(title, sub, ...actions) {
  return el('div', { class: 'page-head' },
    el('div', {}, el('h1', { text: title }), sub ? el('p', { class: 'muted', text: sub }) : null),
    el('div', { class: 'actions' }, ...actions));
}

const readOnlyNote = () => (isAdmin() ? null : el('p', { class: 'note', text: 'Read-only: only admins can change registers and document types.' }));

/* ================= registers ================= */

async function registerList(v) {
  const { items } = await api('registers');
  const newBtn = isAdmin() ? el('button', {
    type: 'button', class: 'primary', text: 'New register',
    onclick: async () => {
      const label = prompt('Name of the new register (e.g. "Procedures", "Training / TBT records", "RFI log"):');
      if (!label) return;
      try {
        const r = await api('registers', { method: 'POST', body: { label } });
        await reloadSchema();
        location.hash = `#/settings/registers/${r.name}`;
      } catch (err) { alert(err.message); }
    },
  }) : null;
  const rows = items.map((r) => el('tr', { class: r.archived ? 'skipped' : '' },
    el('td', {}, el('a', { href: `#/settings/registers/${r.name}`, text: r.label })),
    el('td', { class: 'clip', title: r.description || '', text: r.description || '' }),
    el('td', { class: 'num', text: r.columns }),
    el('td', { class: 'num', text: r.records ?? '' }),
    el('td', {}, r.archived ? badge('Archived', 'muted') : badge('Active', 'ok')),
    el('td', { class: 'muted small', text: r.updated_by ? `${fmtWhen(r.updated_at)} · ${r.updated_by}` : '' }),
    el('td', {},
      r.archived ? null : el('a', { href: `#/r/${r.name}`, text: 'Open' }),
      isAdmin() ? el('button', {
        type: 'button', class: 'link', text: r.archived ? 'Restore' : ' · Archive',
        onclick: async () => {
          if (!r.archived && !confirm(`Archive "${r.label}"? It disappears from the menu and dashboard; its ${r.records ?? 0} records are kept and come back if you restore it.`)) return;
          try { await api(`registers/${r.name}/archive`, { method: 'POST', body: { archived: !r.archived } }); await reloadSchema(); registerList(v); } catch (err) { alert(err.message); }
        },
      }) : null)));
  put(v,
    pageHead('Registers', 'What each register is for, its columns, and how files map into it.', newBtn), readOnlyNote(),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Register', 'What it is for', 'Columns', 'Records', 'Status', 'Last changed', ''].map((h) => el('th', { text: h })))),
      el('tbody', {}, rows))),
    el('p', { class: 'muted small', text: 'Archiving or removing never deletes data: archived registers and hidden columns keep their records.' }));
}

async function registerEditor(v, name) {
  const reg = await api(`registers/${name}`);
  const def = structuredClone(reg.def);
  let version = reg.version;
  const msg = el('p', { class: 'error', role: 'alert' });
  const body = el('div');

  const visibleCols = () => def.columns.filter((c) => !c.hidden);
  const colsOfType = (type) => visibleCols().filter((c) => !type || c.type === type);

  function input(value, onInput, props = {}) {
    const i = el('input', { type: 'text', value: value ?? '', ...props });
    i.addEventListener('input', () => onInput(i.value));
    return i;
  }
  function area(value, onInput, props = {}) {
    const t = el('textarea', { rows: 2, ...props }); t.value = value ?? '';
    t.addEventListener('input', () => onInput(t.value));
    return t;
  }
  function check(label, value, onChange, title) {
    const c = el('input', { type: 'checkbox', checked: !!value });
    c.addEventListener('change', () => onChange(c.checked));
    return el('label', { class: 'check', title }, c, ' ', label);
  }
  function select(options, value, onChange, props = {}) {
    const s = el('select', props, options.map(([val, text]) => el('option', { value: val, text })));
    s.value = value ?? '';
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  function checkList(cols, selected, onChange) {
    const set = new Set(selected || []);
    return el('div', { class: 'checklist' }, cols.map((c) => check(c.label, set.has(c.key), (on) => {
      if (on) set.add(c.key); else set.delete(c.key);
      onChange(cols.map((x) => x.key).filter((k) => set.has(k)));
    })));
  }

  function optionRows(col) {
    const rows = col.options.map((o, i) => el('tr', {},
      el('td', {}, input(o.label, (x) => { o.label = x; }, { required: true })),
      el('td', {}, select(Object.entries(TONE_LABELS), o.tone, (x) => { o.tone = x; render(); })),
      el('td', {}, check('', o.done, (x) => { o.done = x; }, 'Counts as done/closed: never overdue, counts as ready')),
      el('td', {}, check('', o.hold, (x) => { o.hold = x; }, 'Counts as on hold / blocked on the dashboard')),
      el('td', {}, check('', o.na, (x) => { o.na = x; }, 'Not applicable: left out of readiness %')),
      el('td', {}, input(csv(o.aliases), (x) => { o.aliases = splitList(x); }, { placeholder: 'other words meaning this, e.g. Code A, accepted' })),
      el('td', {},
        el('button', { type: 'button', class: 'link', text: '↑', title: 'Move up', disabled: i === 0, onclick: () => { col.options.splice(i - 1, 0, col.options.splice(i, 1)[0]); render(); } }),
        ' ',
        el('button', { type: 'button', class: 'link', text: 'Remove', onclick: () => { col.options.splice(i, 1); render(); } }))));
    return el('div', { class: 'options' },
      el('table', {}, el('thead', {}, el('tr', {}, ['Option', 'Colour', 'Done', 'On hold', 'N/A', 'Also matches (when importing)', ''].map((h) => el('th', { text: h })))), el('tbody', {}, rows)),
      el('div', { class: 'actions' },
        el('button', { type: 'button', text: '+ Add option', onclick: () => { col.options.push({ label: '', tone: 'muted', aliases: [] }); render(); } }),
        el('label', { class: 'inline' }, 'Default for new records ', select([['', '— none —'], ...col.options.filter((o) => o.value).map((o) => [o.value, o.label])], col.default, (x) => { col.default = x || undefined; }))));
  }

  function columnCard(col, i) {
    const cols = def.columns;
    const move = (d) => { const j = i + d; if (j < 0 || j >= cols.length) return; cols.splice(j, 0, cols.splice(i, 1)[0]); render(); };
    if (col.hidden) {
      return el('div', { class: 'col-card hidden-col' },
        el('strong', { text: col.label }), el('span', { class: 'muted small', text: ` · hidden (its data is kept) · ${TYPE_LABELS[col.type] || col.type}` }),
        el('button', { type: 'button', class: 'link', text: ' · Show again', onclick: () => { col.hidden = false; render(); } }));
    }
    return el('div', { class: 'col-card' },
      el('div', { class: 'col-head' },
        el('label', { class: 'grow' }, 'Column name', input(col.label, (x) => { col.label = x; }, { required: true })),
        el('label', {}, 'Type', select(Object.entries(TYPE_LABELS), col.type, (x) => {
          col.type = x;
          if (x === 'enum' && !col.options?.length) col.options = [{ label: 'Open', tone: 'warn' }, { label: 'Closed', tone: 'ok', done: true }];
          render();
        })),
        el('div', { class: 'col-flags' },
          check('Required', col.required, (x) => { col.required = x; }),
          check('Show in list', col.inList !== false, (x) => { col.inList = x; })),
        el('div', { class: 'col-move' },
          el('button', { type: 'button', class: 'link', text: '↑', title: 'Move up', onclick: () => move(-1) }),
          el('button', { type: 'button', class: 'link', text: '↓', title: 'Move down', onclick: () => move(1) }),
          el('button', { type: 'button', class: 'link danger-link', text: 'Remove', title: 'Hides the column; existing data is kept', onclick: () => { if (col.key.startsWith('new')) cols.splice(i, 1); else col.hidden = true; render(); } }))),
      el('label', { class: 'wide' }, 'Headings in files that mean this column (comma-separated)',
        area(csv(col.aliases), (x) => { col.aliases = splitList(x); }, { placeholder: 'e.g. NCR No, Issue ID, Ref' })),
      col.type === 'enum' ? optionRows(col) : null,
      el('p', { class: 'muted small', text: col.key.startsWith('new') ? 'New column' : `Stored as "${col.key}"` }));
  }

  function rules() {
    const statusCol = def.statusField && def.columns.find((c) => c.key === def.statusField && !c.hidden);
    const opt = (cols) => [['', '— none —'], ...cols.map((c) => [c.key, c.label])];
    const age = def.age || null;
    return el('div', { class: 'card rules' },
      el('h2', { text: 'Rules' }),
      el('div', { class: 'rule' }, el('strong', { text: 'Identify a record by' }), el('span', { class: 'muted small', text: 'Used to update instead of duplicate when the same row is imported again.' }),
        checkList(visibleCols(), def.key, (k) => { def.key = k; })),
      el('div', { class: 'rule' }, el('strong', { text: 'Title shown in lists and on the dashboard' }), checkList(visibleCols(), def.display, (k) => { def.display = k; })),
      el('div', { class: 'form-row' },
        el('label', {}, 'Status column', select(opt(colsOfType('enum')), def.statusField, (x) => { def.statusField = x || null; render(); })),
        el('label', {}, 'Due date column (overdue / due soon)', select(opt(colsOfType('date')), def.due, (x) => { def.due = x || null; })),
        el('label', {}, 'Due soon within (days)', input(def.soonDays, (x) => { def.soonDays = Number(x); }, { type: 'number', min: 1, max: 365 })),
        el('label', {}, 'On-hold reason column', select(opt(visibleCols()), def.reason, (x) => { def.reason = x || null; })),
        el('label', { title: 'Rows in a file that only carry a title (e.g. "1. PRE-INSTALLATION") fill this column for the rows below them' },
          'Section titles in files fill', select(opt(visibleCols().filter((c) => ['string', 'text'].includes(c.type))), def.sectionField, (x) => { def.sectionField = x || null; }))),
      el('div', { class: 'form-row' },
        el('label', {}, 'Age counter: days since', select(opt(colsOfType('date')), age?.from, (x) => { def.age = x ? { ...(def.age || { label: 'Age (days)' }), from: x } : null; render(); })),
        age ? el('label', {}, 'Age column name', input(age.label, (x) => { def.age.label = x; })) : null,
        age && statusCol ? el('div', {}, el('span', { class: 'muted small', text: 'Count only while status is (none ticked = while not done)' }),
          el('div', { class: 'checklist' }, statusCol.options.filter((o) => o.value).map((o) => check(o.label, (age.statuses || []).includes(o.value), (on) => {
            const s = new Set(age.statuses || []); if (on) s.add(o.value); else s.delete(o.value); def.age.statuses = [...s];
          })))) : null),
      el('div', { class: 'form-row' },
        el('label', {}, 'Words in file names that point to this register (comma-separated)', input(csv(def.keywords), (x) => { def.keywords = splitList(x); })),
        el('label', {}, 'Reference pattern in documents (advanced, regular expression)', input(def.keyPattern, (x) => { def.keyPattern = x; }, { placeholder: 'e.g. NCR-\\d+' }))));
  }

  function render() {
    const fs = el('fieldset', { disabled: !isAdmin(), class: 'plain' },
      el('div', { class: 'card' },
        el('div', { class: 'form-row' },
          el('label', {}, 'Register name', input(def.label, (x) => { def.label = x; }, { required: true })),
          el('label', {}, 'One record is called', input(def.singular, (x) => { def.singular = x; }))),
        el('label', { class: 'wide' }, 'What this register is for (shown on its page and when uploading)',
          area(def.description, (x) => { def.description = x; }, { rows: 3 }))),
      el('h2', { class: 'section', text: 'Columns' }),
      def.columns.map((c, i) => columnCard(c, i)),
      el('div', { class: 'actions' }, el('button', {
        type: 'button', text: '+ Add column',
        onclick: () => { def.columns.push({ key: `new${++newKey}`, label: '', type: 'string', inList: true, aliases: [] }); render(); },
      })),
      rules());
    body.replaceChildren(fs);
  }

  const saveButtons = [];
  const saveBtn = () => { const b = el('button', { type: 'button', class: 'primary', text: 'Save changes', hidden: !isAdmin(), onclick: () => doSave() }); saveButtons.push(b); return b; };
  async function doSave() {
      msg.textContent = '';
      saveButtons.forEach((b) => { b.disabled = true; });
      try {
        const r = await api(`registers/${name}`, { method: 'PUT', body: { def, version } });
        version = r.version;
        Object.assign(def, structuredClone(r.def));
        def.columns = structuredClone(r.def.columns);
        await reloadSchema();
        S.current = null;
        render();
        msg.replaceChildren(el('span', { class: 'badge tone-ok', text: 'Saved' }));
      } catch (err) { msg.textContent = err.message; }
      saveButtons.forEach((b) => { b.disabled = false; });
  }
  render();
  put(v,
    pageHead(`Register: ${def.label}`, `Last changed ${fmtWhen(reg.updated_at)}${reg.updated_by ? ` by ${reg.updated_by}` : ''}.`,
      el('a', { class: 'button', href: '#/settings/registers', text: 'All registers' }),
      reg.archived ? null : el('a', { class: 'button', href: `#/r/${name}`, text: 'Open register' }), saveBtn()),
    readOnlyNote(), body,
    el('div', { class: 'actions' }, saveBtn()), msg);
}

/* ================= document types ================= */

async function docTypeList(v) {
  const { items } = await api('doctypes');
  const rows = items.map((d) => el('tr', {},
    el('td', {}, el('a', { href: `#/settings/doctypes/${d.id}`, text: d.name })),
    el('td', { text: d.register ? S.tabs[d.register]?.label || `${d.register} (archived)` : '—' }),
    el('td', { text: MODE_LABELS[d.mode] }),
    el('td', { class: 'clip', title: csv(d.keywords), text: csv(d.keywords) }),
    el('td', { class: 'num', text: Object.keys(d.mapping).length }),
    el('td', {}, el('a', { href: `#/upload?doctype=${d.id}`, text: 'Upload one' }))));
  put(v,
    pageHead('Document types', 'Named kinds of documents you upload. Each knows its register, how to read it and how its columns map.',
      isAdmin() ? el('a', { class: 'button primary', href: '#/settings/doctypes/new', text: 'New document type' }) : null),
    readOnlyNote(),
    items.length ? el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Document type', 'Goes into', 'Read as', 'File-name words', 'Saved headings', ''].map((h) => el('th', { text: h })))),
      el('tbody', {}, rows))) : el('p', { class: 'empty', text: 'No document types yet.' }),
    el('p', { class: 'muted small', text: 'Tip: in an import preview, "Save as document type…" creates one from the current file, including your column choices. Column choices made at import are added to the document type automatically.' }));
}

async function docTypeEditor(v, id) {
  const isNew = id === 'new';
  const d = isNew ? { name: '', description: '', register: S.order[0], mode: 'table', keywords: [], mapping: {}, checklist_ref: null } : await api(`doctypes/${id}`);
  const msg = el('p', { class: 'error', role: 'alert' });
  const form = el('form', { class: 'card' });
  let mapping = Object.entries(d.mapping || {});

  const name = el('input', { value: d.name, required: true });
  const desc = el('textarea', { rows: 2 }); desc.value = d.description || '';
  const mode = el('select', {}, Object.entries(MODE_LABELS).map(([k, t]) => el('option', { value: k, text: t }))); mode.value = d.mode;
  const register = el('select', {}, el('option', { value: '', text: '— none —' }), S.order.map((t) => el('option', { value: t, text: S.tabs[t].label })));
  register.value = d.register || '';
  const keywords = el('input', { value: csv(d.keywords), placeholder: 'e.g. issues export, ncr log' });
  const ref = el('select', {}, el('option', { value: '', text: '— none —' }));
  const checklistTab = S.order.find((t) => S.tabs[t].builtin === 'checklist');
  if (checklistTab) {
    api(checklistTab).then(({ items }) => {
      ref.append(...items.map((i) => el('option', { value: i[S.tabs[checklistTab].key[0]], text: titleOf(checklistTab, i).slice(0, 90) })));
      ref.value = d.checklist_ref || '';
    }).catch(() => {});
  }
  const mapBox = el('div');
  function renderMap() {
    const fields = S.tabs[register.value]?.fields || {};
    const opts = [['', '— ignore this column —'], ...Object.entries(fields).map(([k, f]) => [k, f.label])];
    mapBox.replaceChildren(
      el('table', {}, el('thead', {}, el('tr', {}, ['Heading in the file', 'Goes into', ''].map((h) => el('th', { text: h })))),
        el('tbody', {}, mapping.map((m, i) => {
          const h = el('input', { value: m[0] }); h.addEventListener('input', () => { m[0] = h.value; });
          const s = el('select', {}, opts.map(([k, t]) => el('option', { value: k, text: t }))); s.value = m[1] || '';
          s.addEventListener('change', () => { m[1] = s.value; });
          return el('tr', {}, el('td', {}, h), el('td', {}, s), el('td', {}, el('button', { type: 'button', class: 'link', text: 'Remove', onclick: () => { mapping.splice(i, 1); renderMap(); } })));
        }))),
      el('button', { type: 'button', text: '+ Add heading', onclick: () => { mapping.push(['', '']); renderMap(); } }));
  }
  register.addEventListener('change', renderMap);
  renderMap();

  form.append(el('fieldset', { disabled: !isAdmin(), class: 'plain' },
    el('div', { class: 'form-row' },
      el('label', {}, 'Name', name),
      el('label', {}, 'Read as', mode),
      el('label', {}, 'Goes into register', register)),
    el('label', { class: 'wide' }, 'Description', desc),
    el('div', { class: 'form-row' },
      el('label', {}, 'Words in the file name that identify this type (comma-separated)', keywords),
      el('label', {}, 'Default audit item (evidence)', ref)),
    el('h2', { class: 'section', text: 'Saved column mapping' }),
    el('p', { class: 'muted small', text: 'Headings listed here always map this way for this document type, before the register\'s own headings are tried. Choices you make in an import preview are added automatically.' }),
    mapBox));

  const save = el('button', { type: 'submit', class: 'primary', text: isNew ? 'Create' : 'Save changes', hidden: !isAdmin() });
  const del = !isNew && isAdmin() ? el('button', {
    type: 'button', class: 'danger', text: 'Delete',
    onclick: async () => {
      if (!confirm(`Delete document type "${d.name}"? Uploaded files and imported records are not affected.`)) return;
      try { await api(`doctypes/${d.id}`, { method: 'DELETE' }); await reloadSchema(); location.hash = '#/settings/doctypes'; } catch (err) { msg.textContent = err.message; }
    },
  }) : null;
  form.append(el('div', { class: 'actions' }, save, del, el('span', { class: 'spacer' }), !isNew ? el('a', { class: 'button', href: `#/upload?doctype=${d.id}`, text: 'Upload a file of this type' }) : null), msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = '';
    const body = {
      name: name.value, description: desc.value, mode: mode.value, register: register.value || null,
      keywords: splitList(keywords.value), checklist_ref: ref.value || null,
      mapping: Object.fromEntries(mapping.filter(([h]) => h.trim()).map(([h, f]) => [h, f || ''])),
      version: d.version,
    };
    try {
      const r = isNew ? await api('doctypes', { method: 'POST', body }) : await api(`doctypes/${d.id}`, { method: 'PUT', body });
      await reloadSchema();
      if (isNew) location.hash = `#/settings/doctypes/${r.id}`;
      else { Object.assign(d, r); mapping = Object.entries(r.mapping); renderMap(); msg.replaceChildren(el('span', { class: 'badge tone-ok', text: 'Saved' })); }
    } catch (err) { msg.textContent = err.message; }
  });
  put(v,
    pageHead(isNew ? 'New document type' : `Document type: ${d.name}`, null, el('a', { class: 'button', href: '#/settings/doctypes', text: 'All document types' })),
    readOnlyNote(), form);
}

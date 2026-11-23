'use strict';

// Audits: read-only view of the latest audit record (loaded by uploading
// audit-record.json). No editing controls on purpose. Uses helpers from app.js.

const AUDIT_TONE = { ok: 'ok', warn: 'warn', bad: 'bad', none: 'muted', info: 'info' };
const auditPill = (s) => (s ? el('span', { class: `badge tone-${AUDIT_TONE[s[1]] || 'muted'}`, text: s[0] }) : '');
const fmtLong = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

// Text with {date} / {owner} / {?} placeholders shown as "to fill" chips.
function fillText(s) {
  const span = el('span');
  String(s ?? '').split(/(\{(?:date|owner|\?)\})/).forEach((part) => {
    const m = /^\{(date|owner|\?)\}$/.exec(part);
    span.append(m ? el('span', { class: 'fill', text: m[1] }) : part);
  });
  return span;
}
const bullets = (items, cls) => el('ul', { class: cls || '' }, items.map((i) => el('li', {}, fillText(i))));

function auditArea(a) {
  const blk = (title, node) => el('div', { class: 'blk' }, el('h4', { text: title }), node);
  return el('article', { class: 'area-card', id: `area-${a.n}` },
    el('div', { class: 'area-top' }, el('h3', {}, el('span', { class: 'area-num', text: String(a.n).padStart(2, '0') }), a.name), auditPill(a.status)),
    a.say.length ? blk('What we say', bullets(a.say)) : null,
    a.show.length ? blk('What to show', bullets(a.show)) : null,
    a.notes.length ? blk('Notes', bullets(a.notes)) : null,
    a.gaps.length ? blk('Gaps to close', el('ul', { class: 'gap' }, a.gaps.map((g) => el('li', {}, fillText(g[0]), g[1] ? ' · ' : '', g[1] ? fillText(g[1]) : '', g[2] ? ' · ' : '', g[2] ? fillText(g[2]) : '')))) : null,
    a.ask.length ? el('div', { class: 'ask' }, el('h4', { text: 'Questions to ask' }), a.ask.map((q) => el('p', {}, fillText(q)))) : null);
}

function auditSection(au) {
  const count = (t) => au.areas.filter((a) => a.status?.[1] === t).length;
  const stat = (n, label, tone) => el('div', { class: `kpi tone-${tone}` }, el('p', { class: 'value', text: n }), el('p', { class: 'label', text: label }));
  const open = au.actions.filter((x) => x.status?.[1] !== 'ok').length;
  return el('section', { class: 'audit', id: au.id },
    el('div', { class: 'audit-head' },
      el('div', {}, el('h2', { text: `${au.title}${au.kind ? `: ${au.kind}` : ''}` }), el('p', { class: 'muted', text: au.date ? fmtLong(au.date) : 'Date to be confirmed' })),
      au.status?.[0] ? auditPill(au.status) : ''),
    au.areas.length ? el('div', { class: 'kpis' },
      stat(count('ok'), 'areas ready', 'ok'), stat(count('warn'), 'areas partial', count('warn') ? 'warn' : 'ok'),
      stat(count('bad'), 'areas with a gap', count('bad') ? 'bad' : 'ok'), stat(count('info') + count('none'), 'to prepare / not started / N/A', 'muted'),
      au.prep.length ? stat(`${au.prep.filter((p) => p.done).length}/${au.prep.length}`, 'prep items done', 'muted') : null,
      au.actions.length ? stat(open, 'open actions', open ? 'warn' : 'ok') : null) : null,
    au.prep.length ? el('div', { class: 'panel prep-list' }, el('h2', { text: 'Before the audit' }),
      el('ul', {}, au.prep.map((p) => el('li', {}, el('span', { class: `box${p.done ? ' done' : ''}`, 'aria-label': p.done ? 'done' : 'to do' }),
        el('span', {}, fillText(p.text), p.area ? el('a', { class: 'area-ref', href: `#/audits/${au.id}/${p.area}`, text: ` area ${p.area}` }) : ''))))) : null,
    au.areas.length ? el('div', { class: 'area-grid' }, au.areas.map(auditArea)) : null,
    el('h2', { class: 'section', text: `Findings${au.findings.length ? ` (${au.findings.length})` : ''}` }),
    au.findings.length
      ? table(['Area', 'Finding', 'Type'], au.findings.map((f) => ({ cells: [f.area, fillText(f.finding), auditPill(f.type)] })))
      : el('p', { class: 'empty', text: 'Recorded after the audit.' }),
    el('h2', { class: 'section', text: `Action list${au.actions.length ? ` (${open} open)` : ''}` }),
    au.actions.length
      ? table(['Ref', 'Action', 'Area', 'Owner', 'Due', 'Status'], au.actions.map((x) => ({
        cells: [x.ref, fillText(x.action), x.area, fillText(x.owner), x.due ? fmtDate(x.due) : '', auditPill(x.status)],
      })))
      : el('p', { class: 'empty', text: 'Added when the action list from the audit report is shared.' }));
}

async function showAudits(target) {
  const v = show('#view-audits');
  v.replaceChildren(el('p', { class: 'muted', text: 'Loading…' }));
  let d;
  try { d = await api('audits'); } catch (err) { v.replaceChildren(el('p', { class: 'note tone-bad', text: err.message })); return; }
  if (!d.record) {
    v.replaceChildren(
      el('div', { class: 'page-head' }, el('div', {}, el('h1', { text: 'Audits' }), el('p', { class: 'muted', text: 'Record of the quality audits: preparation, findings and action lists.' }))),
      el('p', { class: 'empty' }, 'No audit record loaded yet. Ask in chat for the latest ', el('code', { text: 'audit-record.json' }), ', then ', el('a', { href: '#/upload', text: 'upload it' }), '.'));
    return;
  }
  const r = d.record; const c = r.context;
  const nodes = [
    el('div', { class: 'page-head' },
      el('div', {}, el('h1', { text: 'Audits' }),
        el('p', { class: 'muted', text: [c.client && `Client ${c.client}`, c.scope && `Scope ${c.scope}`, c.qualityPlan && `Quality Plan ${c.qualityPlan}`].filter(Boolean).join(' · ') })),
      el('div', { class: 'audit-meta muted small' },
        el('span', { text: `Record updated ${fmtLong(r.updated) || '—'} · version ${d.versions}` }),
        el('span', { text: `Loaded ${fmtWhen(d.loadedAt)} by ${d.loadedBy}` }),
        d.uploadId ? el('a', { href: `/api/uploads/${d.uploadId}/file`, text: 'Download this version' }) : null)),
    r.audits.length > 1 ? el('nav', { class: 'chips audit-jump' }, r.audits.map((a) => el('a', { class: 'badge tone-muted', href: `#/audits/${a.id}`, text: a.title }))) : null,
    ...r.audits.map(auditSection),
    el('p', { class: 'muted small', text: 'This page is read-only. It changes when a new audit-record.json is uploaded; placeholders like "date" are still to be filled in.' })];
  v.replaceChildren(...nodes.filter(Boolean));
  if (target) document.getElementById(target)?.scrollIntoView();
}

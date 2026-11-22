'use strict';

const registry = require('./registry');
const { daysBetween } = require('./schema');
const R = require('./resources');

const titleOf = (T, row, skip = null) => T.display.filter((f) => f !== skip).map((f) => row[f]).filter((v) => v !== null && v !== undefined && v !== '').join(' – ');

function areaSort(a, b) {
  const na = parseFloat(a); const nb = parseFloat(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

// Audit readiness from the checklist register: "ready" = status options marked
// done (excluding not-applicable), "attention" = amber/red options.
function readiness(T, rows) {
  const sf = T?.statusField;
  if (!T || !sf) return { total: 0, applicable: 0, pct: 0, counts: {}, options: [], areas: [], attention: [] };
  const f = T.fields[sf];
  const options = f.values.map((v) => ({ value: v, label: f.labels[v], tone: f.tones[v], done: T.done.includes(v), na: T.na.includes(v) }));
  const counts = Object.fromEntries(f.values.map((v) => [v, 0]));
  const areaField = T.fields.area ? 'area' : null;
  const areas = new Map();
  let ready = 0; let na = 0;
  for (const r of rows) {
    const s = r[sf];
    counts[s] = (counts[s] || 0) + 1;
    const isNa = T.na.includes(s); const isReady = T.done.includes(s) && !isNa;
    if (isNa) na++; if (isReady) ready++;
    const a = (areaField && r[areaField]) || '(no area)';
    if (!areas.has(a)) areas.set(a, { area: a, total: 0, ready: 0, na: 0, counts: {} });
    const e = areas.get(a); e.total++; e.counts[s] = (e.counts[s] || 0) + 1;
    if (isNa) e.na++; if (isReady) e.ready++;
  }
  const applicable = rows.length - na;
  const attention = rows.filter((r) => ['bad', 'warn'].includes(f.tones[r[sf]]))
    .sort((a, b) => (f.tones[a[sf]] === f.tones[b[sf]] ? areaSort(a[T.key[0]], b[T.key[0]]) : f.tones[a[sf]] === 'bad' ? -1 : 1))
    .map((r) => ({
      id: r.id, ref: r[T.key[0]], title: titleOf(T, r), status: r[sf], statusLabel: f.labels[r[sf]] || r[sf], tone: f.tones[r[sf]],
      gap: T.fields.gap ? r.gap : T.reason ? r[T.reason] : null, owner: r.owner ?? null,
    }));
  return {
    register: T.name, total: rows.length, applicable, ready, counts, options,
    pct: applicable ? Math.round((ready / applicable) * 100) : 0,
    areas: [...areas.values()].sort((a, b) => areaSort(a.area, b.area)).map((a) => ({
      ...a, pct: a.total - a.na ? Math.round((a.ready / (a.total - a.na)) * 100) : 0,
    })),
    attention,
  };
}

function dashboard(db) {
  const today = R.today();
  const reg = registry.load(db);
  const data = Object.fromEntries(reg.order.map((t) => [t, R.all(db, t)]));
  const uploads = db.prepare('SELECT tab, MAX(created_at) AS last FROM uploads GROUP BY tab').all();
  const lastUpload = Object.fromEntries(uploads.map((u) => [u.tab, u.last]));
  const builtin = (b) => (reg.byBuiltin[b] ? reg.tabs[reg.byBuiltin[b]] : null);

  const cl = builtin('checklist');
  const ready = readiness(cl, cl ? data[cl.name] : []);

  // Per-register cards and cross-register lists
  const cards = []; const overdue = []; const dueSoon = []; const onHold = [];
  for (const t of reg.order) {
    const T = reg.tabs[t]; const rows = data[t];
    let nOverdue = 0; let nSoon = 0; let nHold = 0; let nDone = 0;
    const ownerField = ['owner', 'responsible', 'installer'].find((f) => T.fields[f]);
    for (const r of rows) {
      const status = T.statusField ? r[T.statusField] : null;
      const done = T.done.includes(status);
      if (done) nDone++;
      if (T.hold.includes(status)) {
        nHold++;
        onHold.push({ tab: t, tabLabel: T.label, id: r.id, title: titleOf(T, r), status, statusLabel: T.fields[T.statusField].labels[status], reason: T.reason ? r[T.reason] : null });
      }
      if (T.due && r[T.due] && !done) {
        const days = daysBetween(today, r[T.due]);
        const item = { tab: t, tabLabel: T.label, id: r.id, title: titleOf(T, r), date: r[T.due], days, what: T.dueLabel || 'due', owner: ownerField ? r[ownerField] : null };
        if (days < 0) { nOverdue++; overdue.push(item); } else if (days <= (T.soonDays || 14)) { nSoon++; dueSoon.push(item); }
      }
    }
    const updated = rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), '');
    cards.push({
      tab: t, label: T.label, description: T.description, total: rows.length, done: nDone, overdue: nOverdue, dueSoon: nSoon, onHold: nHold,
      updated: updated || null, lastUpload: lastUpload[t] || null,
      tone: !rows.length ? 'muted' : nOverdue ? 'bad' : nSoon || nHold ? 'warn' : 'ok',
    });
  }
  overdue.sort((a, b) => a.days - b.days);
  dueSoon.sort((a, b) => a.days - b.days);

  // Submittals waiting for review (age rule of the submittal register)
  const sub = builtin('submittals');
  const inReview = sub && sub.age ? data[sub.name].filter((r) => r.age_days !== null && r.age_days !== undefined) : [];
  const buckets = [['0–7 days', 0, 7], ['8–14 days', 8, 14], ['15–28 days', 15, 28], ['29+ days', 29, Infinity]]
    .map(([label, lo, hi]) => ({ label, count: inReview.filter((r) => r.age_days >= lo && r.age_days <= hi).length }));
  const ageing = sub ? {
    register: sub.name, label: sub.label, open: inReview.length, buckets,
    oldest: inReview.sort((a, b) => b.age_days - a.age_days).slice(0, 10)
      .map((r) => ({ id: r.id, ref: r[sub.key[0]], title: titleOf(sub, r, sub.key[0]) || r[sub.key[0]], days: r.age_days, blocker: sub.reason ? r[sub.reason] : null })),
  } : null;

  // Deliveries expected in the next 21 days (and late ones)
  const del = builtin('deliveries');
  const deliveries = del && del.due ? data[del.name]
    .filter((r) => !del.done.includes(r[del.statusField]) && r[del.due] && daysBetween(today, r[del.due]) <= 21)
    .sort((a, b) => a[del.due].localeCompare(b[del.due]))
    .map((r) => ({
      id: r.id, po: r.po ?? null, item: titleOf(del, r, 'po') || r.po, expected: r[del.due], days: daysBetween(today, r[del.due]),
      submittalApproved: r.submittal_approved ?? null, mirDone: r.mir_done ?? null,
    })) : [];

  const src = builtin('sources');
  return {
    today, readiness: ready, cards,
    overdue: overdue.slice(0, 100), dueSoon: dueSoon.slice(0, 100), onHold: onHold.slice(0, 100),
    ageing, deliveries, deliveriesRegister: del?.name || null,
    sources: src ? { register: src.name, rows: data[src.name] } : null,
  };
}

module.exports = { dashboard };

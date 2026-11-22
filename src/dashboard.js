'use strict';

const { TABS, ORDER, daysBetween } = require('./schema');
const R = require('./resources');

const titleOf = (tab, row) => TABS[tab].display.map((f) => row[f]).filter((v) => v !== null && v !== undefined && v !== '').join(' – ');

function areaSort(a, b) {
  const na = parseFloat(a); const nb = parseFloat(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
}

function dashboard(db) {
  const today = R.today();
  const data = Object.fromEntries(ORDER.map((t) => [t, R.all(db, t)]));
  const uploads = db.prepare('SELECT tab, MAX(created_at) AS last, COUNT(*) AS n FROM uploads GROUP BY tab').all();
  const lastUpload = Object.fromEntries(uploads.map((u) => [u.tab, u.last]));

  // Audit readiness
  const cl = data.checklist;
  const statusCounts = { ready: 0, partial: 0, missing: 0, not_checked: 0, n_a: 0 };
  const areas = new Map();
  for (const r of cl) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
    const a = r.area || '(no area)';
    if (!areas.has(a)) areas.set(a, { area: a, total: 0, ready: 0, partial: 0, missing: 0, not_checked: 0, n_a: 0 });
    const e = areas.get(a); e.total++; e[r.status] = (e[r.status] || 0) + 1;
  }
  const applicable = cl.length - statusCounts.n_a;
  const readiness = {
    total: cl.length, applicable, counts: statusCounts,
    pct: applicable ? Math.round((statusCounts.ready / applicable) * 100) : 0,
    areas: [...areas.values()].sort((a, b) => areaSort(a.area, b.area)).map((a) => ({
      ...a, pct: a.total - a.n_a ? Math.round((a.ready / (a.total - a.n_a)) * 100) : 0,
    })),
    attention: cl.filter((r) => r.status === 'missing' || r.status === 'partial')
      .sort((a, b) => (a.status === b.status ? areaSort(a.ref, b.ref) : a.status === 'missing' ? -1 : 1))
      .map((r) => ({ id: r.id, ref: r.ref, area: r.area, item: r.item, status: r.status, gap: r.gap, owner: r.owner, evidence: r.evidence })),
  };

  // Per-register cards and cross-register lists
  const cards = []; const overdue = []; const dueSoon = []; const onHold = [];
  for (const t of ORDER) {
    const tab = TABS[t]; const rows = data[t];
    let nOverdue = 0; let nSoon = 0; let nHold = 0; let nDone = 0;
    for (const r of rows) {
      const statusField = Object.keys(tab.fields).find((f) => f.endsWith('status'));
      const status = statusField ? r[statusField] : null;
      const done = tab.done.includes(status);
      if (done) nDone++;
      if (tab.hold.includes(status)) {
        nHold++;
        onHold.push({ tab, id: r.id, title: titleOf(t, r), status, reason: tab.reason ? r[tab.reason] : null });
      }
      if (tab.due && r[tab.due] && !done) {
        const days = daysBetween(today, r[tab.due]);
        const item = { tab, id: r.id, title: titleOf(t, r), date: r[tab.due], days, what: tab.dueLabel || 'due', owner: r.owner || r.responsible || r.installer || null };
        if (days < 0) { nOverdue++; overdue.push(item); } else if (days <= (tab.soonDays || 14)) { nSoon++; dueSoon.push(item); }
      }
    }
    const updated = rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), '');
    cards.push({
      tab: t, label: tab.label, total: rows.length, done: nDone, overdue: nOverdue, dueSoon: nSoon, onHold: nHold,
      updated: updated || null, lastUpload: lastUpload[t] || null,
      tone: !rows.length ? 'muted' : nOverdue ? 'bad' : nSoon || nHold ? 'warn' : 'ok',
    });
  }
  const strip = (l) => l.map((x) => ({ ...x, tab: Object.keys(TABS).find((k) => TABS[k] === x.tab), tabLabel: x.tab.label }));
  overdue.sort((a, b) => a.days - b.days);
  dueSoon.sort((a, b) => a.days - b.days);

  // Submittals sitting with the GC
  const inReview = data.submittals.filter((r) => r.days_in_review !== null);
  const buckets = [['0–7 days', 0, 7], ['8–14 days', 8, 14], ['15–28 days', 15, 28], ['29+ days', 29, Infinity]]
    .map(([label, lo, hi]) => ({ label, count: inReview.filter((r) => r.days_in_review >= lo && r.days_in_review <= hi).length }));
  const ageing = {
    open: inReview.length, buckets,
    oldest: inReview.sort((a, b) => b.days_in_review - a.days_in_review).slice(0, 10)
      .map((r) => ({ id: r.id, ref: r.ref, title: r.title, days: r.days_in_review, status: r.gc_status, blocker: r.blocker, owner: r.owner })),
  };

  // Deliveries expected in the next 21 days (and late ones)
  const deliveries = data.deliveries
    .filter((r) => !TABS.deliveries.done.includes(r.status) && r.expected_date && daysBetween(today, r.expected_date) <= 21)
    .sort((a, b) => a.expected_date.localeCompare(b.expected_date))
    .map((r) => ({
      id: r.id, po: r.po, item: r.item, supplier: r.supplier, expected: r.expected_date, days: daysBetween(today, r.expected_date),
      status: r.status, submittalApproved: r.submittal_approved, mirDone: r.mir_done,
    }));

  return {
    today, readiness, cards,
    overdue: strip(overdue).slice(0, 100), dueSoon: strip(dueSoon).slice(0, 100), onHold: strip(onHold).slice(0, 100),
    ageing, deliveries, sources: data.sources,
  };
}

module.exports = { dashboard };

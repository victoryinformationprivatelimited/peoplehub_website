// The dashboard: one call that answers "how are we doing and what needs me today?", scoped to the signed-in person.
const express = require('express');
const db = require('./db');
const A = require('./auth');
const { statsFor, sentAtFor } = require('./tracking');
const { interest } = require('./scoring');
const rating = require('./rating');

const r = express.Router();
const ANY = A.requireRole('admin', 'staff', 'partner');
const isStaff = (u) => u.role === 'admin' || u.role === 'staff';

r.get('/dashboard', ANY, async (req, res) => {
  const u = req.user, partner = u.role === 'partner';
  const P = partner ? [u.partner_id] : [];
  const pScope = partner ? ' AND p.partner_id = $1' : '';
  const lScope = partner ? ' AND l.partner_id = $1' : '';
  const q = (sql, params) => db.query(sql, params).then((x) => x.rows);

  const [byStatus, wonMonth, won12, weekly, monthly, leadRows, myTasks, nextTasks, activity, expiring, openRows] = await Promise.all([
    q(`SELECT p.status, count(*)::int AS n, coalesce(sum((p.totals->>'monthlyRecurring')::numeric), 0)::float AS monthly FROM proposals p WHERE TRUE${pScope} GROUP BY p.status`, P),
    q(`SELECT count(*)::int AS n, coalesce(sum((p.totals->>'monthlyRecurring')::numeric), 0)::float AS monthly, coalesce(sum((p.totals->>'year1')::numeric), 0)::float AS year1
         FROM proposals p WHERE p.status = 'accepted' AND p.status_changed_at >= date_trunc('month', now())${pScope}`, P),
    q(`SELECT count(*) FILTER (WHERE p.status = 'accepted')::int AS wins, count(*) FILTER (WHERE p.status = 'lost')::int AS lost,
              coalesce(sum((p.totals->>'monthlyRecurring')::numeric) FILTER (WHERE p.status = 'accepted'), 0)::float AS monthly
         FROM proposals p WHERE p.status IN ('accepted', 'lost') AND p.status_changed_at > now() - interval '12 months'${pScope}`, P),
    q(`SELECT to_char(d.wk, 'DD Mon') AS label, d.wk::date AS wk, coalesce(c.n, 0)::int AS n
         FROM (SELECT generate_series(date_trunc('week', now()) - interval '7 weeks', date_trunc('week', now()), interval '1 week') AS wk) d
         LEFT JOIN (SELECT date_trunc('week', p.created_at) AS wk, count(*) AS n FROM proposals p WHERE p.created_at > now() - interval '8 weeks'${pScope} GROUP BY 1) c ON c.wk = d.wk ORDER BY d.wk`, P),
    q(`SELECT to_char(d.m, 'Mon') AS label, coalesce(c.v, 0)::float AS v, coalesce(c.n, 0)::int AS n
         FROM (SELECT generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') AS m) d
         LEFT JOIN (SELECT date_trunc('month', p.status_changed_at) AS m, sum((p.totals->>'monthlyRecurring')::numeric) AS v, count(*) AS n FROM proposals p
                     WHERE p.status = 'accepted' AND p.status_changed_at > now() - interval '6 months'${pScope} GROUP BY 1) c ON c.m = d.m ORDER BY d.m`, P),
    q(`SELECT l.stage, count(*)::int AS n, coalesce(sum(l.est_value), 0)::float AS value FROM leads l WHERE TRUE${lScope} GROUP BY l.stage`, P),
    q(`SELECT count(*) FILTER (WHERE due_date < current_date)::int AS overdue, count(*) FILTER (WHERE due_date = current_date)::int AS today, count(*)::int AS open
         FROM tasks WHERE assigned_to = $1 AND done_at IS NULL`, [u.id]),
    q(`SELECT t.id, t.title, t.type, t.due_date, t.lead_id, l.company_name AS lead_name FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id
        WHERE t.assigned_to = $1 AND t.done_at IS NULL ORDER BY t.due_date, t.id LIMIT 5`, [u.id]),
    q(`SELECT e.type, e.to_status, e.note, e.created_at, p.id AS proposal_id, p.ref_no, p.client->>'name' AS customer, coalesce(us.display_name, us.username) AS by_user
         FROM proposal_events e JOIN proposals p ON p.id = e.proposal_id LEFT JOIN app_users us ON us.id = e.user_id
        WHERE (e.type IN ('emailed', 'client_request') OR (e.type = 'status' AND e.to_status IN ('sent', 'viewed', 'negotiating', 'accepted', 'lost')))${pScope}
        ORDER BY e.created_at DESC LIMIT 9`, P),
    q(`SELECT p.id, p.ref_no, p.status, p.client->>'name' AS customer, (p.totals->>'monthlyRecurring')::float AS monthly,
              (p.created_at + (coalesce((p.selections->>'validityDays')::int, 30) || ' days')::interval) AS expires_at
         FROM proposals p WHERE p.status IN ('sent', 'viewed', 'negotiating')${pScope}
          AND p.created_at + (coalesce((p.selections->>'validityDays')::int, 30) || ' days')::interval BETWEEN now() AND now() + interval '7 days'
        ORDER BY expires_at LIMIT 5`, P),
    q(`SELECT p.id, p.ref_no, p.status, p.client->>'name' AS customer, (p.totals->>'monthlyRecurring')::float AS monthly FROM proposals p WHERE p.status IN ('sent', 'viewed', 'negotiating')${pScope}`, P),
  ]);

  const S = {}; byStatus.forEach((x) => { S[x.status] = x; });
  const sum = (keys, f) => keys.reduce((t, k) => t + ((S[k] && S[k][f]) || 0), 0);
  const w12 = won12[0];

  // Which open proposals look most promising, with the reasons (the same score shown on each proposal)
  const ids = openRows.map((x) => x.id);
  const [stats, sent] = await Promise.all([statsFor(ids), sentAtFor(ids)]);
  const hot = openRows.map((x) => ({ ...x, i: interest({ status: x.status, sentAt: sent[x.id] || null, stats: stats[x.id] || {} }) }))
    .filter((x) => x.i.score != null).sort((a, b) => b.i.score - a.i.score).slice(0, 5)
    .map((x) => ({ id: x.id, ref_no: x.ref_no, customer: x.customer, monthly: x.monthly, status: x.status, label: x.i.label, score: x.i.score, why: x.i.reasons.filter((s) => s.points > 0).slice(0, 2).map((s) => s.text) }));
  const notOpened = openRows.filter((x) => (() => { const i = interest({ status: x.status, sentAt: sent[x.id] || null, stats: stats[x.id] || {} }); return i.label === 'Waiting' || i.reasons.some((s) => /unopened|Not opened/i.test(s.text)); })()).length;

  const out = {
    role: u.role,
    pipeline: { count: sum(['sent', 'viewed', 'negotiating'], 'n'), monthly: sum(['sent', 'viewed', 'negotiating'], 'monthly'), byStage: { sent: (S.sent || {}).n || 0, viewed: (S.viewed || {}).n || 0, negotiating: (S.negotiating || {}).n || 0 }, notOpened },
    drafts: (S.draft || {}).n || 0,
    wonMonth: wonMonth[0],
    won12: { wins: w12.wins, lost: w12.lost, monthly: w12.monthly, rate: w12.wins + w12.lost ? Math.round(w12.wins / (w12.wins + w12.lost) * 100) : null },
    weekly: weekly.map((x) => ({ label: x.label, n: x.n })),
    monthly: monthly.map((x) => ({ label: x.label, v: x.v, n: x.n })),
    leads: ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'].map((s) => { const x = leadRows.find((y) => y.stage === s) || { n: 0, value: 0 }; return { stage: s, n: x.n, value: x.value }; }),
    tasks: { ...myTasks[0], next: nextTasks },
    hot, expiring, activity,
  };

  if (partner) {
    const lb = await rating.leaderboard();
    const me = lb.rows.find((x) => x.partner.id === u.partner_id);
    if (me) out.rating = { score: me.total, rank: me.rank, of: lb.rows.length, label: me.label, stars: me.stars, trend: me.trend, tip: me.hints[0] ? me.hints[0].text : null };
    const cm = await q(`SELECT status, coalesce(sum(amount), 0)::float AS v FROM commissions WHERE partner_id = $1 GROUP BY status`, [u.partner_id]);
    out.commissions = { pending: 0, approved: 0, paid: 0 }; cm.forEach((x) => { if (x.status in out.commissions) out.commissions[x.status] = x.v; });
    out.myApprovals = (await q(`SELECT count(*)::int AS n FROM discount_requests d JOIN proposals p ON p.id = d.proposal_id WHERE d.status = 'pending' AND p.partner_id = $1`, [u.partner_id]))[0].n;
  }
  if (isStaff(u)) {
    out.pendingApprovals = (await q(`SELECT count(*)::int AS n FROM discount_requests WHERE status = 'pending'`))[0].n;
    out.pendingCommissions = (await q(`SELECT coalesce(sum(amount), 0)::float AS v FROM commissions WHERE status IN ('pending', 'approved')`))[0].v;
    const lb = await rating.leaderboard();
    out.topPartners = lb.rows.slice(0, 5).map((x) => ({ company: x.partner.company_name, category: x.partner.category, score: x.total, label: x.label, rank: x.rank }));
    out.partnerCount = lb.rows.length;
    out.tierSuggestions = (await q(`SELECT count(*)::int AS n FROM tier_suggestions WHERE status = 'pending'`))[0].n;
  }
  res.json(out);
});

module.exports = r;

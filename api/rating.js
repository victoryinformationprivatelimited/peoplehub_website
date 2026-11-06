// Partner rating: a 0-100 score from real activity, a leaderboard everyone can see, and tier suggestions for admins.
//
//  Revenue and wins   40   monthly value won in the last 12 months (60%) and number of deals won (40%)
//  Win rate           15   won / (won + lost) over 12 months; neutral until enough decisions exist
//  Follow-up habit    15   share of follow-ups finished on or before their due date (last 90 days)
//  Pipeline activity  15   leads registered and proposals sent (last 90 days)
//  Engagement         15   presentations given and calls/meetings logged (last 90 days)
const express = require('express');
const db = require('./db');
const A = require('./auth');
const audit = require('./audit');

const r = express.Router();
const ANY = A.requireRole('admin', 'staff', 'partner');
const isStaff = (u) => u.role === 'admin' || u.role === 'staff';
const clamp01 = (n) => Math.max(0, Math.min(1, n));
const round1 = (n) => Math.round(n * 10) / 10;
const MAX = { revenue: 40, winRate: 15, discipline: 15, pipeline: 15, engagement: 15 };
const DEFAULTS = { revenueTarget: 3000, winsTarget: 4, minDecided: 3, pipelineTarget: 12, presentationsTarget: 4, activitiesTarget: 20 };

async function loadSettings() {
  const { rows } = await db.query('SELECT data FROM rating_settings WHERE id = 1');
  return { ...DEFAULTS, ...(rows[0] ? rows[0].data : {}) };
}

const labelFor = (s) => (s >= 75 ? 'Elite' : s >= 55 ? 'Strong' : s >= 35 ? 'Established' : 'Rising');
const starsFor = (s) => Math.round((s / 20) * 2) / 2;

/** Pure scoring from raw numbers, so it can be tested without a database. */
function score(m, cfg) {
  const revenueRatio = clamp01(m.mrrWon / cfg.revenueTarget), winsRatio = clamp01(m.wins / cfg.winsTarget);
  const decided = m.wins + m.lost, provisional = decided < cfg.minDecided;
  const parts = {
    revenue: MAX.revenue * (0.6 * revenueRatio + 0.4 * winsRatio),
    winRate: MAX.winRate * (provisional ? 0.5 : m.wins / decided),
    discipline: MAX.discipline * (m.tasksDue > 0 ? m.tasksOnTime / m.tasksDue : 0.5),
    pipeline: MAX.pipeline * clamp01((m.leads + m.proposalsSent) / cfg.pipelineTarget),
    engagement: MAX.engagement * (0.5 * clamp01(m.presentations / cfg.presentationsTarget) + 0.5 * clamp01(m.activities / cfg.activitiesTarget)),
  };
  Object.keys(parts).forEach((k) => { parts[k] = round1(parts[k]); });
  const total = round1(Object.values(parts).reduce((a, b) => a + b, 0));
  return { total, parts, provisional, label: labelFor(total), stars: starsFor(total) };
}

/** Plain-language next steps, biggest gain first. */
function hints(m, parts, cfg) {
  const out = [];
  const gap = (k) => MAX[k] - parts[k];
  if (m.tasksDue > m.tasksOnTime) out.push({ key: 'discipline', gain: gap('discipline'), text: `Finish follow-ups on time. ${m.tasksDue - m.tasksOnTime} of your last ${m.tasksDue} were late or still open.` });
  else if (m.tasksDue === 0) out.push({ key: 'discipline', gain: gap('discipline') * 0.5, text: 'Add follow-ups to your leads and complete them by the due date.' });
  const pipe = m.leads + m.proposalsSent;
  if (pipe < cfg.pipelineTarget) out.push({ key: 'pipeline', gain: gap('pipeline'), text: `Register leads and send proposals: ${pipe} of ${cfg.pipelineTarget} in the last 90 days.` });
  if (m.presentations < cfg.presentationsTarget) out.push({ key: 'engagement', gain: gap('engagement') * 0.5, text: `Present PeopleHub to a prospect: ${m.presentations} of ${cfg.presentationsTarget} presentations in the last 90 days.` });
  if (m.activities < cfg.activitiesTarget) out.push({ key: 'engagement', gain: gap('engagement') * 0.5, text: `Log your calls and meetings on the lead: ${m.activities} of ${cfg.activitiesTarget} in the last 90 days.` });
  if (m.wins + m.lost < cfg.minDecided) out.push({ key: 'winRate', gain: gap('winRate') * 0.3, text: `Close proposals as won or lost; your win rate counts once you have ${cfg.minDecided} decisions.` });
  if (m.mrrWon < cfg.revenueTarget) out.push({ key: 'revenue', gain: gap('revenue'), text: `Win more business: $${Math.round(m.mrrWon).toLocaleString()} of $${cfg.revenueTarget.toLocaleString()} monthly value won in the last 12 months.` });
  return out.sort((a, b) => b.gain - a.gain).slice(0, 3).map((h) => ({ text: h.text, points: Math.max(1, Math.round(h.gain)) }));
}

async function metricsByPartner() {
  const q = (sql) => db.query(sql).then((x) => x.rows);
  const [wins, tasks, leads, sent, pres, acts, partners] = await Promise.all([
    q(`SELECT partner_id, count(*) FILTER (WHERE status = 'accepted')::int AS wins, count(*) FILTER (WHERE status = 'lost')::int AS lost,
              coalesce(sum((totals->>'monthlyRecurring')::numeric) FILTER (WHERE status = 'accepted'), 0)::float AS mrr
         FROM proposals WHERE partner_id IS NOT NULL AND status IN ('accepted', 'lost') AND status_changed_at > now() - interval '12 months' GROUP BY partner_id`),
    q(`SELECT partner_id, count(*)::int AS due, count(*) FILTER (WHERE done_at IS NOT NULL AND done_at::date <= due_date)::int AS on_time
         FROM tasks WHERE partner_id IS NOT NULL AND due_date BETWEEN current_date - 90 AND current_date GROUP BY partner_id`),
    q(`SELECT partner_id, count(*)::int AS n FROM leads WHERE partner_id IS NOT NULL AND created_at > now() - interval '90 days' GROUP BY partner_id`),
    q(`SELECT p.partner_id, count(DISTINCT p.id)::int AS n FROM proposal_events e JOIN proposals p ON p.id = e.proposal_id
        WHERE p.partner_id IS NOT NULL AND e.type = 'status' AND e.to_status = 'sent' AND e.created_at > now() - interval '90 days' GROUP BY p.partner_id`),
    q(`SELECT partner_id, count(*)::int AS n FROM presentation_launches WHERE partner_id IS NOT NULL AND created_at > now() - interval '90 days' GROUP BY partner_id`),
    q(`SELECT l.partner_id, count(*)::int AS n FROM crm_activities a JOIN leads l ON l.id = a.lead_id
        WHERE l.partner_id IS NOT NULL AND a.type <> 'stage' AND a.created_at > now() - interval '90 days' GROUP BY l.partner_id`),
    q(`SELECT p.id, p.company_name, p.created_at, p.category_id, c.name AS category, c.partner_type, c.max_discount_pct, c.min_score
         FROM partners p JOIN partner_categories c ON c.id = p.category_id WHERE p.active ORDER BY p.company_name`),
  ]);
  const by = (rows, key = 'partner_id') => { const m = new Map(); rows.forEach((x) => m.set(x[key], x)); return m; };
  const W = by(wins), T = by(tasks), L = by(leads), S = by(sent), P = by(pres), C = by(acts);
  return partners.map((p) => ({
    partner: p,
    m: {
      wins: (W.get(p.id) || {}).wins || 0, lost: (W.get(p.id) || {}).lost || 0, mrrWon: (W.get(p.id) || {}).mrr || 0,
      tasksDue: (T.get(p.id) || {}).due || 0, tasksOnTime: (T.get(p.id) || {}).on_time || 0,
      leads: (L.get(p.id) || {}).n || 0, proposalsSent: (S.get(p.id) || {}).n || 0,
      presentations: (P.get(p.id) || {}).n || 0, activities: (C.get(p.id) || {}).n || 0,
    },
  }));
}

/** Everyone's rating, ranked, with the day's snapshot stored so trends can be shown. */
async function leaderboard() {
  const cfg = await loadSettings();
  const rows = (await metricsByPartner()).map(({ partner, m }) => {
    const s = score(m, cfg);
    return { partner, m, ...s, hints: hints(m, s.parts, cfg) };
  });
  rows.sort((a, b) => b.total - a.total || a.partner.company_name.localeCompare(b.partner.company_name));
  rows.forEach((x, i) => { x.rank = i + 1; });
  for (const x of rows) {
    await db.query('INSERT INTO rating_snapshots (partner_id, day, score) VALUES ($1, current_date, $2) ON CONFLICT (partner_id, day) DO UPDATE SET score = EXCLUDED.score', [x.partner.id, x.total]);
    const { rows: old } = await db.query('SELECT score::float AS s FROM rating_snapshots WHERE partner_id = $1 AND day <= current_date - 30 ORDER BY day DESC LIMIT 1', [x.partner.id]);
    x.trend = old[0] ? round1(x.total - old[0].s) : null;
  }
  // Badges: earned by being best at something, never by being worst
  const best = (key, min) => { const c = rows.filter((x) => x.parts[key] >= min).sort((a, b) => b.parts[key] - a.parts[key])[0]; return c ? c.partner.id : null; };
  const topCloser = best('revenue', 1), topPipeline = best('pipeline', 3);
  rows.forEach((x) => {
    x.badges = [];
    if (x.partner.id === topCloser) x.badges.push('Top closer');
    if (x.partner.id === topPipeline) x.badges.push('Most active');
    if (x.parts.discipline >= 14 && x.m.tasksDue >= 5) x.badges.push('Follow-up champion');
    if (x.trend !== null && x.trend >= 5) x.badges.push('On the rise');
  });
  return { rows, cfg };
}

// ---------- routes ----------
// Everyone sees everyone's score, rank and badges. Only your own company (and Victory) see the numbers behind a score.
r.get('/ratings/leaderboard', ANY, async (req, res) => {
  const { rows, cfg } = await leaderboard();
  const mine = req.user.role === 'partner' ? req.user.partner_id : null;
  const out = rows.map((x, i) => {
    const row = { rank: x.rank, partner_id: x.partner.id, company: x.partner.company_name, category: x.partner.category, score: x.total, stars: x.stars, label: x.label, trend: x.trend, badges: x.badges, you: x.partner.id === mine };
    if (isStaff(req.user) || row.you) {
      row.parts = x.parts; row.provisional = x.provisional; row.metrics = x.m; row.hints = x.hints;
      const above = rows[i - 1];
      row.toNextRank = above ? { company: above.partner.company_name, points: round1(above.total - x.total + 0.1) } : null;
    }
    return row;
  });
  let tier = null;
  if (mine) {
    const me = rows.find((x) => x.partner.id === mine);
    if (me) {
      const { rows: cats } = await db.query('SELECT id, name, max_discount_pct, min_score FROM partner_categories WHERE active AND partner_type = $1 ORDER BY max_discount_pct', [me.partner.partner_type]);
      const next = cats.find((c) => Number(c.max_discount_pct) > Number(me.partner.max_discount_pct));
      if (next) tier = { current: me.partner.category, next: next.name, nextDiscount: Number(next.max_discount_pct), needed: next.min_score, score: me.total, reached: me.total >= next.min_score };
    }
  }
  res.json({ rows: out, max: MAX, tier, totalPartners: rows.length });
});

r.get('/ratings/settings', A.requireRole('admin', 'staff'), async (req, res) => res.json(await loadSettings()));
r.put('/ratings/settings', A.requireRole('admin'), async (req, res) => {
  const next = {};
  for (const k of Object.keys(DEFAULTS)) {
    const v = Number(req.body[k]);
    if (!isFinite(v) || v <= 0 || v > 1e7) return res.status(400).json({ error: `${k} must be a positive number` });
    next[k] = v;
  }
  await db.query('UPDATE rating_settings SET data = $1 WHERE id = 1', [next]);
  await audit.log(req.user, 'rating.settings', 'rating', 1, JSON.stringify(next));
  res.json({ ok: true });
});

// Tier suggestions: compared with the category's own threshold, within its own type (reseller / agent)
async function refreshSuggestions() {
  const { rows } = await leaderboard();
  const { rows: cats } = await db.query('SELECT id, name, partner_type, max_discount_pct, min_score FROM partner_categories WHERE active');
  for (const x of rows) {
    const p = x.partner, tenureDays = (Date.now() - new Date(p.created_at)) / 86400000;
    const ladder = cats.filter((c) => c.partner_type === p.partner_type).sort((a, b) => Number(a.max_discount_pct) - Number(b.max_discount_pct));
    const idx = ladder.findIndex((c) => c.id === p.category_id);
    const up = ladder[idx + 1], down = ladder[idx - 1], cur = ladder[idx];
    let sug = null;
    if (up && tenureDays >= 90 && x.total >= up.min_score && x.total > 0) sug = { to: up.id, kind: 'upgrade' };
    else if (down && cur && tenureDays >= 180 && cur.min_score > 0 && x.total < cur.min_score - 10) sug = { to: down.id, kind: 'review' };
    if (!sug) { await db.query(`DELETE FROM tier_suggestions WHERE partner_id = $1 AND status = 'pending'`, [p.id]); continue; }
    const recent = await db.query(`SELECT 1 FROM tier_suggestions WHERE partner_id = $1 AND to_category_id = $2 AND status = 'dismissed' AND decided_at > now() - interval '30 days'`, [p.id, sug.to]);
    if (recent.rowCount) continue;
    await db.query(
      `INSERT INTO tier_suggestions (partner_id, from_category_id, to_category_id, kind, score) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (partner_id) WHERE status = 'pending' DO UPDATE SET to_category_id = EXCLUDED.to_category_id, kind = EXCLUDED.kind, score = EXCLUDED.score, from_category_id = EXCLUDED.from_category_id`,
      [p.id, p.category_id, sug.to, sug.kind, x.total]);
  }
}

r.get('/ratings/suggestions', A.requireRole('admin', 'staff'), async (req, res) => {
  await refreshSuggestions();
  const { rows } = await db.query(
    `SELECT s.id, s.kind, s.score::float AS score, s.status, s.created_at, s.decided_at, p.company_name,
            f.name AS from_name, f.max_discount_pct AS from_discount, t.name AS to_name, t.max_discount_pct AS to_discount
       FROM tier_suggestions s JOIN partners p ON p.id = s.partner_id JOIN partner_categories f ON f.id = s.from_category_id JOIN partner_categories t ON t.id = s.to_category_id
      ORDER BY (s.status = 'pending') DESC, coalesce(s.decided_at, s.created_at) DESC LIMIT 30`);
  res.json(rows);
});

r.put('/ratings/suggestions/:id', A.requireRole('admin'), async (req, res) => {
  const action = req.body.action;
  if (!['approve', 'dismiss'].includes(action)) return res.status(400).json({ error: 'Choose approve or dismiss' });
  const { rows } = await db.query(`SELECT * FROM tier_suggestions WHERE id = $1 AND status = 'pending'`, [parseInt(req.params.id, 10) || 0]);
  const s = rows[0];
  if (!s) return res.status(404).json({ error: 'Suggestion not found, or already decided' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (action === 'approve') await client.query('UPDATE partners SET category_id = $1 WHERE id = $2', [s.to_category_id, s.partner_id]);
    await client.query(`UPDATE tier_suggestions SET status = $1, decided_by = $2, decided_at = now() WHERE id = $3`, [action === 'approve' ? 'approved' : 'dismissed', req.user.id, s.id]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await audit.log(req.user, 'tier.' + action, 'partner', s.partner_id, `category ${s.from_category_id} -> ${s.to_category_id}`);
  res.json({ ok: true });
});

module.exports = r;
module.exports.score = score;
module.exports.leaderboard = leaderboard;
module.exports.DEFAULTS = DEFAULTS;

// What happens when a proposal is won or un-won: the lead is closed and the partner's commission is recorded or voided.
const express = require('express');
const db = require('./db');
const A = require('./auth');
const audit = require('./audit');

const r = express.Router();
const ANY = A.requireRole('admin', 'staff', 'partner');

async function onAccepted(proposalId) {
  const { rows } = await db.query('SELECT id, partner_id, totals FROM proposals WHERE id = $1', [proposalId]);
  const p = rows[0];
  if (!p || !p.partner_id) return null;
  const { rows: c } = await db.query('SELECT c.commission_pct FROM partners pa JOIN partner_categories c ON c.id = pa.category_id WHERE pa.id = $1', [p.partner_id]);
  const pct = c[0] ? Number(c[0].commission_pct) : 0;
  // The partner bills the implementation fee themselves, so it is not part of what commission is paid on
  const base = Number((p.totals || {}).year1Victory ?? (p.totals || {}).year1) || 0;
  if (!(pct > 0) || !(base > 0)) return null;
  const amount = Math.round(base * pct) / 100;
  // A proposal that was un-accepted and accepted again goes back to pending, unless it was already paid
  await db.query(
    `INSERT INTO commissions (proposal_id, partner_id, base_amount, pct, amount) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (proposal_id) DO UPDATE SET base_amount = EXCLUDED.base_amount, pct = EXCLUDED.pct, amount = EXCLUDED.amount, status = 'pending', updated_at = now()
      WHERE commissions.status = 'void'`, [p.id, p.partner_id, base, pct, amount]);
  return { amount };
}

async function onLeftAccepted(proposalId) {
  await db.query(`UPDATE commissions SET status = 'void', updated_at = now(), note = 'The proposal was reopened' WHERE proposal_id = $1 AND status IN ('pending', 'approved')`, [proposalId]);
  await db.query(`UPDATE commissions SET note = 'Reopened after payment: review with the partner' WHERE proposal_id = $1 AND status = 'paid'`, [proposalId]);
}

// ---------- commissions ----------
r.get('/commissions', ANY, async (req, res) => {
  const partner = req.user.role === 'partner';
  const params = partner ? [req.user.partner_id] : [];
  const { rows } = await db.query(
    `SELECT c.id, c.status, c.base_amount::float AS base_amount, c.pct::float AS pct, c.amount::float AS amount, c.note, c.created_at, c.paid_at,
            p.ref_no, p.client->>'name' AS customer, pa.company_name AS partner_name
       FROM commissions c JOIN proposals p ON p.id = c.proposal_id JOIN partners pa ON pa.id = c.partner_id
      ${partner ? 'WHERE c.partner_id = $1' : ''} ORDER BY c.created_at DESC LIMIT 300`, params);
  const sum = (st) => rows.filter((x) => x.status === st).reduce((t, x) => t + x.amount, 0);
  res.json({ rows, totals: { pending: sum('pending'), approved: sum('approved'), paid: sum('paid') } });
});

r.put('/commissions/:id', A.requireRole('admin'), async (req, res) => {
  const status = req.body.status, note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 300) : null;
  if (!['pending', 'approved', 'paid', 'void'].includes(status)) return res.status(400).json({ error: 'Unknown status' });
  const { rows } = await db.query(
    `UPDATE commissions SET status = $1::varchar, note = coalesce($2, note), updated_at = now(), paid_at = CASE WHEN $1::text = 'paid' THEN now() ELSE NULL END WHERE id = $3 RETURNING id, amount, proposal_id`,
    [status, note, parseInt(req.params.id, 10) || 0]);
  if (!rows[0]) return res.status(404).json({ error: 'Commission not found' });
  await audit.log(req.user, 'commission.' + status, 'commission', rows[0].id, `$${rows[0].amount}`);
  res.json({ ok: true });
});

module.exports = r;
module.exports.onAccepted = onAccepted;
module.exports.onLeftAccepted = onLeftAccepted;

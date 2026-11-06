// Discount approvals: a partner may ask Victory for more discount than their category allows, for one proposal.
const express = require('express');
const db = require('./db');
const A = require('./auth');
const mail = require('./email');
const audit = require('./audit');

const r = express.Router();
const ANY = A.requireRole('admin', 'staff', 'partner');
const BASE = () => (process.env.APP_BASE_URL || 'http://localhost:4400').replace(/\/+$/, '');
const escH = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function visible(user, alias) {
  return user.role === 'partner' ? { sql: ` AND ${alias}.partner_id = $1`, params: [user.partner_id] } : { sql: '', params: [] };
}

/** The highest total discount this person may use on this proposal: their category cap, or a granted approval if higher.
 *  An approval carries over to revisions of the same proposal. */
async function discountCap(user, proposalId) {
  if (user.role !== 'partner') return 100;
  const base = Number(user.max_discount_pct);
  if (!proposalId) return base;
  const { rows } = await db.query(
    `SELECT max(d.approved_pct)::float AS pct FROM discount_requests d JOIN proposals p ON p.id = d.proposal_id
      WHERE d.status = 'approved' AND p.partner_id = $2
        AND coalesce(p.parent_id, p.id) = (SELECT coalesce(parent_id, id) FROM proposals WHERE id = $1)`, [proposalId, user.partner_id]);
  return Math.max(base, (rows[0] && rows[0].pct) || 0);
}

async function notifyAdmins(subject, html) {
  if (!mail.configured()) return;
  const { rows } = await db.query(`SELECT email FROM app_users WHERE role = 'admin' AND active AND email IS NOT NULL`);
  for (const a of rows) mail.send({ to: a.email, subject, html }).catch(() => {});
}
const wrap = (inner) => `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:540px">${inner}<p><a href="${escH(BASE())}/tool/approvals.html" style="display:inline-block;background:#0d9467;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Open approvals</a></p></div>`;

// ---------- partner side ----------
r.get('/proposals/:id/discount-requests', ANY, async (req, res) => {
  const v = visible(req.user, 'p');
  const { rows } = await db.query(
    `SELECT d.id, d.requested_pct::float AS requested_pct, d.reason, d.status, d.approved_pct::float AS approved_pct, d.decision_note, d.created_at, d.decided_at
       FROM discount_requests d JOIN proposals p ON p.id = d.proposal_id WHERE d.proposal_id = $${v.params.length + 1}${v.sql} ORDER BY d.id DESC`, [...v.params, parseInt(req.params.id, 10) || 0]);
  res.json({ requests: rows, cap: await discountCap(req.user, parseInt(req.params.id, 10) || 0) });
});

r.post('/proposals/:id/discount-requests', ANY, async (req, res) => {
  if (req.user.role !== 'partner') return res.status(400).json({ error: 'Only partners need approval. Victory staff can set any discount.' });
  const v = visible(req.user, 'p');
  const { rows } = await db.query(`SELECT p.id, p.status, p.ref_no, p.client->>'name' AS customer FROM proposals p WHERE p.id = $${v.params.length + 1}${v.sql}`, [...v.params, parseInt(req.params.id, 10) || 0]);
  const p = rows[0];
  if (!p) return res.status(404).json({ error: 'Proposal not found' });
  if (p.status !== 'draft') return res.status(400).json({ error: 'Ask for approval while the proposal is still a draft' });
  const pct = Math.round(Number(req.body.pct) * 100) / 100;
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
  const cap = await discountCap(req.user, p.id);
  if (!(pct > cap) || pct > 100) return res.status(400).json({ error: `Ask for more than your current limit of ${cap}%` });
  if (reason.length < 5) return res.status(400).json({ error: 'Explain why the client needs this discount' });
  try {
    await db.query('INSERT INTO discount_requests (proposal_id, requested_by, requested_pct, reason) VALUES ($1,$2,$3,$4)', [p.id, req.user.id, pct, reason]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'There is already a request waiting for a decision on this proposal' });
    throw e;
  }
  notifyAdmins(`Discount approval: ${req.user.company_name || 'a partner'} asks for ${pct}%`, wrap(`<p><b>${escH(req.user.company_name)}</b> asks for a <b>${pct}%</b> discount (their limit is ${cap}%) on proposal ${escH(p.ref_no)} for ${escH(p.customer)}.</p><p><i>${escH(reason)}</i></p>`));
  res.status(201).json({ ok: true });
});

// ---------- Victory side ----------
r.get('/approvals/summary', A.requireRole('admin', 'staff'), async (req, res) => {
  const { rows } = await db.query(`SELECT count(*)::int AS pending FROM discount_requests WHERE status = 'pending'`);
  res.json(rows[0]);
});

r.get('/approvals', A.requireRole('admin', 'staff'), async (req, res) => {
  const { rows } = await db.query(
    `SELECT d.id, d.proposal_id, d.requested_pct::float AS requested_pct, d.reason, d.status, d.approved_pct::float AS approved_pct, d.decision_note, d.created_at, d.decided_at,
            p.ref_no, p.client->>'name' AS customer, (p.totals->>'monthlyBeforeDiscount')::float AS list_monthly, p.discount_pct::float AS current_pct,
            pa.company_name AS partner_name, c.name AS category, c.max_discount_pct::float AS cap, coalesce(u.display_name, u.username) AS requester,
            coalesce(du.display_name, du.username) AS decided_by_name
       FROM discount_requests d JOIN proposals p ON p.id = d.proposal_id LEFT JOIN partners pa ON pa.id = p.partner_id
       LEFT JOIN partner_categories c ON c.id = pa.category_id JOIN app_users u ON u.id = d.requested_by LEFT JOIN app_users du ON du.id = d.decided_by
      ORDER BY (d.status = 'pending') DESC, coalesce(d.decided_at, d.created_at) DESC LIMIT 60`);
  res.json(rows);
});

r.put('/approvals/:id', A.requireRole('admin'), async (req, res) => {
  const action = req.body.action;
  if (!['approve', 'decline'].includes(action)) return res.status(400).json({ error: 'Choose approve or decline' });
  const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 300) : '';
  const { rows } = await db.query(`SELECT d.*, p.ref_no, p.client->>'name' AS customer FROM discount_requests d JOIN proposals p ON p.id = d.proposal_id WHERE d.id = $1 AND d.status = 'pending'`, [parseInt(req.params.id, 10) || 0]);
  const d = rows[0];
  if (!d) return res.status(404).json({ error: 'Request not found, or already decided' });
  let approved = null;
  if (action === 'approve') {
    approved = req.body.approved_pct === undefined || req.body.approved_pct === '' ? Number(d.requested_pct) : Math.round(Number(req.body.approved_pct) * 100) / 100;
    if (!(approved > 0) || approved > 100) return res.status(400).json({ error: 'Enter a discount between 0 and 100' });
  } else if (note.length < 3) return res.status(400).json({ error: 'Give the partner a short reason for declining' });
  await db.query(`UPDATE discount_requests SET status = $1, approved_pct = $2, decision_note = $3, decided_by = $4, decided_at = now() WHERE id = $5`,
    [action === 'approve' ? 'approved' : 'declined', approved, note || null, req.user.id, d.id]);
  await audit.log(req.user, 'discount.' + action, 'proposal', d.proposal_id, `${d.ref_no}: asked ${d.requested_pct}%` + (approved ? `, approved ${approved}%` : ', declined'));
  const { rows: who } = await db.query('SELECT email FROM app_users WHERE id = $1', [d.requested_by]);
  if (who[0] && who[0].email && mail.configured()) {
    mail.send({ to: who[0].email, subject: `Discount request ${action === 'approve' ? 'approved' : 'declined'}: ${d.ref_no}`,
      html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:520px"><p>Your request for a ${d.requested_pct}% discount on proposal <b>${escH(d.ref_no)}</b> (${escH(d.customer)}) was <b>${action === 'approve' ? 'approved at ' + approved + '%' : 'declined'}</b>.</p>${note ? `<p><i>${escH(note)}</i></p>` : ''}<p><a href="${escH(BASE())}/tool/proposal.html?open=${d.proposal_id}" style="display:inline-block;background:#0d9467;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Open the proposal</a></p></div>` }).catch(() => {});
  }
  res.json({ ok: true });
});

module.exports = r;
module.exports.discountCap = discountCap;

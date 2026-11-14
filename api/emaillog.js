// Every email the system has sent or tried to send, with what the email service answered. Staff and admins see all; a partner sees their own company's.
const express = require('express');
const db = require('./db');
const A = require('./auth');
const delivery = require('./delivery');

const r = express.Router();
const ANY = A.requireRole('admin', 'staff', 'partner');

r.get('/email-log', ANY, async (req, res) => {
  const params = [];
  let where = '';
  if (req.user.role === 'partner') { params.push(req.user.partner_id); where += ` AND p.partner_id = $${params.length}`; }
  const status = req.query.status;
  if (status === 'failed') where += ' AND NOT e.ok';
  if (status === 'sent') where += ' AND e.ok';
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80).toLowerCase() : '';
  if (q) { params.push('%' + q + '%'); where += ` AND (lower(e.to_email) LIKE $${params.length} OR lower(e.subject) LIKE $${params.length} OR lower(p.ref_no) LIKE $${params.length} OR lower(coalesce(p.client->>'name', '')) LIKE $${params.length})`; }
  const limit = Math.min(500, Math.max(10, parseInt(req.query.limit, 10) || 200));
  const { rows } = await db.query(
    `SELECT e.id, e.created_at, e.to_email, e.role, e.resend, e.subject, e.ok, e.error, e.detail, e.duration_ms, e.attachments,
            p.id AS proposal_id, p.ref_no, p.client->>'name' AS customer, coalesce(u.display_name, u.username) AS sent_by
       FROM email_log e JOIN proposals p ON p.id = e.proposal_id LEFT JOIN app_users u ON u.id = e.sent_by
      WHERE TRUE${where} ORDER BY e.id DESC LIMIT ${limit}`, params);
  const staff = req.user.role !== 'partner';
  const withDelivery = await delivery.attach(rows.slice(0, 120).map((x) => ({ ...x })));
  const byId = new Map(withDelivery.map((x) => [x.id, x]));
  res.json(rows.map((x) => {
    const d = byId.get(x.id) || {};
    return { ...x, detail: staff ? x.detail : null, delivery: d.delivery || null, delivered_at: d.delivered_at || null, mail_opened_at: d.mail_opened_at || null };
  }));
});

module.exports = r;

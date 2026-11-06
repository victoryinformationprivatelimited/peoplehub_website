// Saved proposal setups ("Textile factory - Standard"): the quote inputs and style, reused for new proposals.
const express = require('express');
const db = require('./db');
const A = require('./auth');

const r = express.Router();
const ANY = A.requireRole('admin', 'staff', 'partner');

const mine = (u) => (u.role === 'partner' ? { sql: 'WHERE (partner_id = $1 OR partner_id IS NULL)', params: [u.partner_id] } : { sql: 'WHERE TRUE', params: [] });

r.get('/proposal-templates', ANY, async (req, res) => {
  const v = mine(req.user);
  const { rows } = await db.query(`SELECT t.id, t.name, t.note, t.input, t.validity, t.partner_id, t.created_at, u.username AS by_user FROM proposal_templates t JOIN app_users u ON u.id = t.created_by ${v.sql.split('partner_id').join('t.partner_id')} ORDER BY t.name`, v.params);
  res.json(rows.map((t) => ({ ...t, shared: t.partner_id === null, editable: req.user.role === 'admin' || t.partner_id === req.user.partner_id })));
});

r.post('/proposal-templates', ANY, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const note = String(req.body.note || '').trim().slice(0, 300);
  const input = req.body.input;
  if (name.length < 2) return res.status(400).json({ error: 'Give the template a name' });
  if (!input || typeof input !== 'object' || !Array.isArray(input.items)) return res.status(400).json({ error: 'Nothing to save' });
  const clean = { ...input, employees: input.employees };
  const validity = Math.min(365, Math.max(1, parseInt(req.body.validity, 10) || 30));
  const shared = req.user.role === 'admin' && req.body.shared === true;
  const pid = shared ? null : (req.user.partner_id || null);
  const { rows: n } = await db.query('SELECT count(*)::int AS c FROM proposal_templates WHERE created_by = $1', [req.user.id]);
  if (n[0].c >= 50) return res.status(400).json({ error: 'You can keep at most 50 templates' });
  const { rows } = await db.query('INSERT INTO proposal_templates (partner_id, created_by, name, note, input, validity) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [pid, req.user.id, name, note, JSON.stringify(clean), validity]);
  res.status(201).json({ id: rows[0].id });
});

r.delete('/proposal-templates/:id', ANY, async (req, res) => {
  const where = req.user.role === 'admin' ? 'id = $1' : 'id = $1 AND partner_id = $2';
  const { rowCount } = await db.query(`DELETE FROM proposal_templates WHERE ${where}`, req.user.role === 'admin' ? [req.params.id] : [req.params.id, req.user.partner_id]);
  if (!rowCount) return res.status(404).json({ error: 'Template not found' });
  res.json({ ok: true });
});

module.exports = r;

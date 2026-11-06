// Read-only view of the audit log, for admins.
const express = require('express');
const db = require('./db');
const A = require('./auth');

const r = express.Router();

r.get('/audit', A.requireRole('admin'), async (req, res) => {
  const params = [];
  let where = '';
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60).toLowerCase() : '';
  if (q) { params.push('%' + q + '%'); where = ` WHERE lower(action) LIKE $1 OR lower(coalesce(username, '')) LIKE $1 OR lower(coalesce(detail, '')) LIKE $1`; }
  const { rows } = await db.query(`SELECT id, username, action, entity, entity_id, detail, created_at FROM audit_log${where} ORDER BY id DESC LIMIT 300`, params);
  res.json(rows);
});

module.exports = r;

// A partner owner manages the logins of their own company ("tenant"). Members share the company's customers and proposals.
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const A = require('./auth');

const r = express.Router();
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bad = (res, msg) => res.status(400).json({ error: msg });
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const USER_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;

// Only the partner's owner login may manage the team
function owner(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (req.user.role !== 'partner' || req.user.partner_role !== 'owner') return res.status(403).json({ error: 'Only the partner owner can manage the team' });
  next();
}

function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (const b of crypto.randomBytes(14)) out += alphabet[b % alphabet.length];
  return out;
}

r.get('/team', owner, async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.display_name, u.email, u.partner_role, u.active, u.must_change_password, u.created_at
       FROM app_users u WHERE u.partner_id = $1 ORDER BY (u.partner_role = 'owner') DESC, u.created_at`, [req.user.partner_id]);
  const { rows: lim } = await db.query('SELECT max_users FROM partners WHERE id = $1', [req.user.partner_id]);
  res.json({ users: rows, maxUsers: lim[0].max_users });
});

r.post('/team', owner, async (req, res) => {
  const username = str(req.body.username, 40).toLowerCase();
  const displayName = str(req.body.displayName, 120);
  const email = str(req.body.email, 160).toLowerCase();
  if (!USER_RE.test(username)) return bad(res, 'Username: 3-40 characters, letters, numbers, dot, dash or underscore');
  if (email && !EMAIL_RE.test(email)) return bad(res, 'Enter a valid email address');
  const { rows: lim } = await db.query('SELECT max_users, (SELECT count(*)::int FROM app_users WHERE partner_id = $1) AS n FROM partners WHERE id = $1', [req.user.partner_id]);
  if (lim[0].n >= lim[0].max_users) return bad(res, `Your company can have at most ${lim[0].max_users} logins. Ask Victory Information to raise the limit.`);
  if ((await db.query('SELECT 1 FROM app_users WHERE lower(username) = $1', [username])).rowCount) return bad(res, 'That username is already taken');
  if (email && (await db.query('SELECT 1 FROM app_users WHERE lower(email) = $1', [email])).rowCount) return bad(res, 'That email address is already used by another login');
  const temp = tempPassword();
  const { rows } = await db.query(
    `INSERT INTO app_users (username, password_hash, role, partner_id, partner_role, display_name, email, must_change_password, password_changed_at, created_by_user)
     VALUES ($1,$2,'partner',$3,'member',$4,$5,TRUE,now(),$6) RETURNING id`,
    [username, A.hashPassword(temp), req.user.partner_id, displayName || null, email || null, req.user.id]);
  res.status(201).json({ id: rows[0].id, username, temporaryPassword: temp });
});

async function member(req, res) {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query('SELECT id, partner_role FROM app_users WHERE id = $1 AND partner_id = $2', [id, req.user.partner_id]);
  if (!rows[0]) { res.status(404).json({ error: 'User not found' }); return null; }
  if (rows[0].partner_role === 'owner') { bad(res, 'The owner login cannot be changed here'); return null; }
  return rows[0];
}

r.put('/team/:id/active', owner, async (req, res) => {
  const m = await member(req, res); if (!m) return;
  await db.query('UPDATE app_users SET active = $1 WHERE id = $2', [req.body.active !== false, m.id]);
  res.json({ ok: true });
});

r.post('/team/:id/reset-password', owner, async (req, res) => {
  const m = await member(req, res); if (!m) return;
  const temp = tempPassword();
  await db.query('UPDATE app_users SET password_hash = $1, must_change_password = TRUE, password_changed_at = now() WHERE id = $2', [A.hashPassword(temp), m.id]);
  res.json({ ok: true, temporaryPassword: temp });
});

module.exports = r;

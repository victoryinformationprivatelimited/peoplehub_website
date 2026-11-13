// Logins for everyone: an admin creates admin, staff and partner users, edits them, switches them off and resets their passwords.
// (A partner owner still manages their own company's team in team.js.)
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const A = require('./auth');
const mail = require('./email');
const audit = require('./audit');

const r = express.Router();
const ADMIN = A.requireRole('admin');
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bad = (res, msg) => res.status(400).json({ error: msg });
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const USER_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const BASE = () => (process.env.APP_BASE_URL || 'http://localhost:4400').replace(/\/+$/, '');
const escH = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Readable but unambiguous (no 0/O, 1/l/I)
function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (const b of crypto.randomBytes(14)) out += alphabet[b % alphabet.length];
  return out;
}

const COLS = `u.id, u.username, u.display_name, u.email, u.phone, u.role, u.partner_id, u.partner_role, u.active, u.must_change_password, u.created_at, p.company_name`;

r.get('/users', ADMIN, async (req, res) => {
  const { rows } = await db.query(`SELECT ${COLS} FROM app_users u LEFT JOIN partners p ON p.id = u.partner_id ORDER BY (u.role = 'admin') DESC, (u.role = 'staff') DESC, p.company_name NULLS FIRST, u.username`);
  const { rows: partners } = await db.query(`SELECT p.id, p.company_name, p.max_users, p.active, (SELECT count(*)::int FROM app_users u WHERE u.partner_id = p.id) AS logins,
      EXISTS (SELECT 1 FROM app_users u WHERE u.partner_id = p.id AND u.partner_role = 'owner') AS has_owner FROM partners p ORDER BY p.company_name`);
  res.json({ users: rows, partners, me: req.user.id });
});

// Create a login. A temporary password is made (or the admin types one); the person must choose their own at first sign-in.
r.post('/users', ADMIN, async (req, res) => {
  const role = ['admin', 'staff', 'partner'].includes(req.body.role) ? req.body.role : null;
  if (!role) return bad(res, 'Choose a role: admin, staff or partner');
  const username = str(req.body.username, 40).toLowerCase();
  const displayName = str(req.body.displayName, 120);
  const email = str(req.body.email, 160).toLowerCase();
  const phone = str(req.body.phone, 40);
  if (!USER_RE.test(username)) return bad(res, 'Username: 3-40 characters, letters, numbers, dot, dash or underscore');
  if (email && !EMAIL_RE.test(email)) return bad(res, 'Enter a valid email address');
  const given = typeof req.body.password === 'string' && req.body.password ? req.body.password : null;
  if (given && !A.validPassword(given)) return bad(res, 'The password must be at least 10 characters');
  if ((await db.query('SELECT 1 FROM app_users WHERE lower(username) = $1', [username])).rowCount) return bad(res, 'That username is already taken');
  if (email && (await db.query('SELECT 1 FROM app_users WHERE lower(email) = $1', [email])).rowCount) return bad(res, 'That email address is already used by another login');

  let partnerId = null, partnerRole = 'owner'; // the column is never empty; it only matters for partner logins
  if (role === 'partner') {
    partnerId = parseInt(req.body.partnerId, 10);
    if (!Number.isInteger(partnerId)) return bad(res, 'Choose the partner company this login belongs to');
    const { rows } = await db.query('SELECT p.id, p.max_users, (SELECT count(*)::int FROM app_users u WHERE u.partner_id = p.id) AS n, EXISTS (SELECT 1 FROM app_users u WHERE u.partner_id = p.id AND u.partner_role = \'owner\') AS has_owner FROM partners p WHERE p.id = $1', [partnerId]);
    if (!rows[0]) return bad(res, 'Choose the partner company this login belongs to');
    if (rows[0].n >= rows[0].max_users) return bad(res, `That company already has ${rows[0].n} of its ${rows[0].max_users} allowed logins. Raise its limit first.`);
    partnerRole = req.body.partnerRole === 'owner' ? 'owner' : 'member';
    if (partnerRole === 'owner' && rows[0].has_owner) return bad(res, 'That company already has an owner. Add this person as a member, or change the owner first.');
    // a company with no owner needs one, or nobody can manage its team
    if (!rows[0].has_owner) partnerRole = 'owner';
  }
  const temp = given || tempPassword();
  const { rows } = await db.query(
    `INSERT INTO app_users (username, password_hash, role, partner_id, partner_role, display_name, email, phone, must_change_password, password_changed_at, created_by_user)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,now(),$9) RETURNING id`,
    [username, A.hashPassword(temp), role, partnerId, partnerRole, displayName || null, email || null, phone || null, req.user.id]);
  await audit.log(req.user, 'user.create', 'user', rows[0].id, username + ' (' + role + ')');
  res.status(201).json({ id: rows[0].id, username, role, temporaryPassword: given ? null : temp });
});

async function activeAdminsOtherThan(id) {
  return (await db.query(`SELECT count(*)::int AS n FROM app_users WHERE role = 'admin' AND active AND id <> $1`, [id])).rows[0].n;
}

// Change name, email, phone, role (admin or staff) or, for a partner login, owner / member
r.put('/users/:id', ADMIN, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query('SELECT id, username, role, partner_id, partner_role, active FROM app_users WHERE id = $1', [id]);
  const u = rows[0]; if (!u) return res.status(404).json({ error: 'User not found' });
  const displayName = str(req.body.displayName, 120);
  const email = str(req.body.email, 160).toLowerCase();
  const phone = str(req.body.phone, 40);
  if (email && !EMAIL_RE.test(email)) return bad(res, 'Enter a valid email address');
  if (email && (await db.query('SELECT 1 FROM app_users WHERE lower(email) = $1 AND id <> $2', [email, id])).rowCount) return bad(res, 'That email address is already used by another login');
  let role = u.role, partnerRole = u.partner_role;
  if (u.role !== 'partner' && req.body.role && req.body.role !== u.role) {
    if (!['admin', 'staff'].includes(req.body.role)) return bad(res, 'The role must be admin or staff');
    if (id === req.user.id) return bad(res, 'You cannot change your own role');
    if (u.role === 'admin' && u.active && (await activeAdminsOtherThan(id)) === 0) return bad(res, 'This is the only active admin. Make someone else an admin first.');
    role = req.body.role;
  }
  if (u.role === 'partner' && req.body.partnerRole && req.body.partnerRole !== u.partner_role) {
    if (!['owner', 'member'].includes(req.body.partnerRole)) return bad(res, 'The partner role must be owner or member');
    if (req.body.partnerRole === 'owner' && (await db.query(`SELECT 1 FROM app_users WHERE partner_id = $1 AND partner_role = 'owner' AND id <> $2`, [u.partner_id, id])).rowCount) return bad(res, 'That company already has an owner');
    if (req.body.partnerRole === 'member' && (await db.query(`SELECT 1 FROM app_users WHERE partner_id = $1 AND partner_role = 'owner' AND id <> $2`, [u.partner_id, id])).rowCount === 0) return bad(res, 'A company needs an owner. Make another person the owner first.');
    partnerRole = req.body.partnerRole;
  }
  await db.query('UPDATE app_users SET display_name = $1, email = $2, phone = $3, role = $4, partner_role = $5 WHERE id = $6', [displayName || null, email || null, phone || null, role, partnerRole, id]);
  await audit.log(req.user, 'user.update', 'user', id, u.username + (role !== u.role ? ' role ' + u.role + ' -> ' + role : ''));
  res.json({ ok: true });
});

// Switch a login off or on (it keeps its history). The last active admin cannot be switched off.
r.put('/users/:id/active', ADMIN, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return bad(res, 'You cannot deactivate your own login');
  const { rows } = await db.query('SELECT id, username, role, active FROM app_users WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  const active = req.body.active !== false;
  if (!active && rows[0].role === 'admin' && rows[0].active && (await activeAdminsOtherThan(id)) === 0) return bad(res, 'This is the only active admin and cannot be switched off');
  await db.query('UPDATE app_users SET active = $1 WHERE id = $2', [active, id]);
  await audit.log(req.user, active ? 'user.activate' : 'user.deactivate', 'user', id, rows[0].username);
  res.json({ ok: true });
});

// Reset option 1: a new temporary password, shown once
r.post('/users/:id/temporary-password', ADMIN, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query('SELECT id, username FROM app_users WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  if (id === req.user.id) return bad(res, 'Use Change password on your own profile');
  const temp = tempPassword();
  await db.query('UPDATE app_users SET password_hash = $1, must_change_password = TRUE, password_changed_at = now() WHERE id = $2', [A.hashPassword(temp), id]);
  await audit.log(req.user, 'password.admin_reset', 'user', id, rows[0].username);
  res.json({ ok: true, username: rows[0].username, temporaryPassword: temp });
});

// Reset option 2: the admin types the new password
r.post('/users/:id/set-password', ADMIN, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query('SELECT id, username FROM app_users WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  if (id === req.user.id) return bad(res, 'Use Change password on your own profile');
  if (!A.validPassword(req.body.password)) return bad(res, 'The password must be at least 10 characters');
  await db.query('UPDATE app_users SET password_hash = $1, must_change_password = TRUE, password_changed_at = now() WHERE id = $2', [A.hashPassword(req.body.password), id]);
  await audit.log(req.user, 'password.admin_set', 'user', id, rows[0].username);
  res.json({ ok: true, username: rows[0].username });
});

// Reset option 3: email the person a link to choose their own password (valid for 30 minutes)
r.post('/users/:id/send-reset-link', ADMIN, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query('SELECT id, username, email, display_name FROM app_users WHERE id = $1', [id]);
  const u = rows[0]; if (!u) return res.status(404).json({ error: 'User not found' });
  if (!u.email) return bad(res, 'This login has no email address. Add one first, or use a temporary password.');
  if (!mail.configured()) return res.status(503).json({ error: 'Email is not set up on the server yet' });
  const token = crypto.randomBytes(32).toString('hex');
  await db.query('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [id]);
  await db.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 minutes')`, [id, sha(token)]);
  const link = `${BASE()}/tool/reset.html#token=${token}`;
  const sent = await mail.send({
    to: u.email, subject: 'Choose a new PeopleHub password',
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:520px"><p>Hello ${escH(u.display_name || u.username)},</p><p>Victory Information has asked for your PeopleHub password to be reset. This link works once and expires in 30 minutes.</p><p style="margin:18px 0"><a href="${escH(link)}" style="display:inline-block;background:#0d9467;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Choose a new password</a></p><p style="color:#555;font-size:13px">If you did not expect this, you can ignore this email.</p></div>`,
  });
  if (!sent.ok) return res.status(502).json({ error: sent.error || 'The email could not be sent' });
  await audit.log(req.user, 'password.reset_link', 'user', id, u.username);
  res.json({ ok: true, sentTo: u.email });
});

module.exports = r;

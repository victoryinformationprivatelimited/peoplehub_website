// Account self-service: profile, change password, forgot/reset by email, and admin password reset.
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const A = require('./auth');
const mail = require('./email');
const audit = require('./audit');

const r = express.Router();
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bad = (res, msg) => res.status(400).json({ error: msg });
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const BASE = () => (process.env.APP_BASE_URL || 'http://localhost:4400').replace(/\/+$/, '');
const ANY = A.requireRole('admin', 'staff', 'partner');
const escH = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Readable but unambiguous (no 0/O, 1/l/I)
function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (const b of crypto.randomBytes(14)) out += alphabet[b % alphabet.length];
  return out;
}

async function setPassword(userId, password, mustChange) {
  await db.query('UPDATE app_users SET password_hash = $1, must_change_password = $2, password_changed_at = now() WHERE id = $3', [A.hashPassword(password), !!mustChange, userId]);
}

// ---------- profile ----------
r.get('/me/profile', ANY, async (req, res) => {
  const u = req.user;
  let partner = null;
  if (u.partner_id) {
    const { rows } = await db.query(
      `SELECT p.id, p.company_name, p.contact_name, p.email, p.phone, p.created_at, p.logo, c.name AS category, c.partner_type, c.max_discount_pct
         FROM partners p JOIN partner_categories c ON c.id = p.category_id WHERE p.id = $1`, [u.partner_id]);
    if (rows[0]) partner = { id: rows[0].id, company: rows[0].company_name, contactName: rows[0].contact_name, email: rows[0].email, phone: rows[0].phone, since: rows[0].created_at, logo: rows[0].logo, category: rows[0].category, type: rows[0].partner_type, maxDiscountPct: Number(rows[0].max_discount_pct) };
  }
  const al = (await db.query('SELECT alert_email, alert_sms, alert_whatsapp, alert_push, ntfy_topic FROM app_users WHERE id = $1', [u.id])).rows[0] || {};
  res.json({ id: u.id, username: u.username, role: u.role, displayName: u.display_name || '', email: u.email || '', phone: u.phone || '',
    alertEmail: al.alert_email !== false, alertSms: !!al.alert_sms, alertWhatsapp: !!al.alert_whatsapp, alertPush: !!al.alert_push, ntfyTopic: al.ntfy_topic || '', ntfyServer: require('./push').server(),
    smsAvailable: require('./sms').configured(), whatsappAvailable: require('./whatsapp').configured(), partner });
});

r.put('/me/profile', ANY, async (req, res) => {
  const displayName = str(req.body.displayName, 120);
  const email = str(req.body.email, 160).toLowerCase();
  const phone = str(req.body.phone, 40);
  if (email && !EMAIL_RE.test(email)) return bad(res, 'Enter a valid email address');
  if (email) {
    const { rows } = await db.query('SELECT id FROM app_users WHERE lower(email) = $1 AND id <> $2', [email, req.user.id]);
    if (rows[0]) return bad(res, 'That email address is already used by another login');
  }
  const alertEmail = req.body.alertEmail !== false, alertSms = req.body.alertSms === true;
  if (alertSms && !require('./sms').normalize(phone)) return bad(res, 'Enter a Sri Lankan mobile number (for example 0771234567) to get SMS alerts');
  const alertWhatsapp = req.body.alertWhatsapp === true;
  if (alertWhatsapp && !require('./whatsapp').toWa(phone)) return bad(res, 'Enter a Sri Lankan mobile number (for example 0771234567) to get WhatsApp alerts');
  const alertPush = req.body.alertPush === true, push = require('./push');
  const curTopic = (await db.query('SELECT ntfy_topic FROM app_users WHERE id = $1', [req.user.id])).rows[0] || {};
  const topic = push.validTopic(curTopic.ntfy_topic) ? curTopic.ntfy_topic : (alertPush ? push.newTopic() : null);
  await db.query('UPDATE app_users SET display_name = $1, email = $2, phone = $3, alert_email = $5, alert_sms = $6, alert_whatsapp = $7, alert_push = $8, ntfy_topic = $9 WHERE id = $4', [displayName || null, email || null, phone || null, req.user.id, alertEmail, alertSms, alertWhatsapp, alertPush, topic]);
  res.json({ ok: true });
});

// Send yourself a test alert on one channel, using the saved details
const testHits = new Map();
r.post('/me/test-alert', ANY, async (req, res) => {
  const now = Date.now(), arr = (testHits.get(req.user.id) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (arr.length >= 8) return res.status(429).json({ error: 'Too many tests. Try again in a few minutes.' });
  arr.push(now); testHits.set(req.user.id, arr);
  const ch = req.body.channel;
  const u = (await db.query('SELECT phone FROM app_users WHERE id = $1', [req.user.id])).rows[0] || {};
  const text = 'Test alert from PeopleHub Proposal Studio. If you can read this, alerts are working.';
  let out;
  if (ch === 'sms') out = await require('./sms').send([u.phone], text);
  else if (ch === 'whatsapp') out = await require('./whatsapp').send(u.phone, text);
  else if (ch === 'push') {
    const push = require('./push');
    let topic = (await db.query('SELECT ntfy_topic FROM app_users WHERE id = $1', [req.user.id])).rows[0].ntfy_topic;
    if (!push.validTopic(topic)) { topic = push.newTopic(); await db.query('UPDATE app_users SET ntfy_topic = $1 WHERE id = $2', [topic, req.user.id]); }
    out = await push.send(topic, { title: 'PeopleHub test', text, url: (process.env.APP_BASE_URL || '').trim() });
  } else return bad(res, 'Choose sms, whatsapp or push');
  res.status(out.ok ? 200 : 502).json(out.ok ? { ok: true } : { error: out.error });
});

// ---------- co-branding: the partner's logo on their proposals ----------
const LOGO_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
r.put('/me/partner-logo', ANY, async (req, res) => {
  if (req.user.role !== 'partner' || req.user.partner_role !== 'owner') return res.status(403).json({ error: 'Only the partner owner can change the logo' });
  const d = req.body.dataUrl;
  if (typeof d !== 'string' || d.length > 200000 || !LOGO_RE.test(d)) return bad(res, 'Use a PNG or JPEG image under about 150 KB');
  await db.query('UPDATE partners SET logo = $1 WHERE id = $2', [d, req.user.partner_id]);
  await audit.log(req.user, 'partner.logo', 'partner', req.user.partner_id, null);
  res.json({ ok: true });
});
r.delete('/me/partner-logo', ANY, async (req, res) => {
  if (req.user.role !== 'partner' || req.user.partner_role !== 'owner') return res.status(403).json({ error: 'Only the partner owner can change the logo' });
  await db.query('UPDATE partners SET logo = NULL WHERE id = $1', [req.user.partner_id]);
  res.json({ ok: true });
});

// ---------- change password (signed in) ----------
r.post('/auth/change-password', ANY, async (req, res) => {
  const key = 'pw|' + req.user.id;
  if (A.loginThrottle(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const current = typeof req.body.current === 'string' ? req.body.current : '';
  const next = req.body.next;
  const { rows } = await db.query('SELECT password_hash FROM app_users WHERE id = $1', [req.user.id]);
  if (!rows[0] || !A.checkPassword(current, rows[0].password_hash)) { A.recordFailure(key); return bad(res, 'Your current password is not correct'); }
  if (!A.validPassword(next)) return bad(res, 'The new password must be at least 10 characters');
  if (next === current) return bad(res, 'Choose a password different from the current one');
  A.clearFailures(key);
  await setPassword(req.user.id, next, false);
  A.setSession(res, req.user.id); // keeps this browser signed in; older sessions are cut off
  res.json({ ok: true });
});

// ---------- forgot / reset by email (public) ----------
r.post('/auth/forgot', async (req, res) => {
  const generic = { ok: true, message: 'If an account matches, a reset link has been emailed. It is valid for 30 minutes.' };
  const key = 'forgot|' + req.ip;
  if (A.loginThrottle(key)) return res.status(429).json({ error: 'Too many requests. Try again later.' });
  A.recordFailure(key);
  const who = str(req.body.identifier, 160).toLowerCase();
  if (!who) return bad(res, 'Enter your username or email');
  const { rows } = await db.query('SELECT id, username, email, display_name FROM app_users WHERE active AND (lower(username) = $1 OR lower(email) = $1) LIMIT 1', [who]);
  const u = rows[0];
  if (u && u.email && mail.configured()) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.query('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [u.id]);
    await db.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 minutes')`, [u.id, sha(token)]);
    const link = `${BASE()}/tool/reset.html#token=${token}`;
    await mail.send({
      to: u.email, subject: 'Reset your PeopleHub password',
      html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:520px"><p>Hello ${escH(u.display_name || u.username)},</p><p>We received a request to reset your PeopleHub password. This link works once and expires in 30 minutes.</p><p><a href="${escH(link)}" style="display:inline-block;background:#0d9467;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Choose a new password</a></p><p style="color:#666;font-size:13px">If you did not ask for this, ignore this email; your password stays the same.</p></div>`,
    });
  }
  res.json(generic); // identical answer whether or not the account exists
});

r.post('/auth/reset', async (req, res) => {
  const key = 'reset|' + req.ip;
  if (A.loginThrottle(key)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const token = typeof req.body.token === 'string' ? req.body.token : '';
  if (!/^[0-9a-f]{64}$/.test(token)) { A.recordFailure(key); return bad(res, 'This reset link is not valid'); }
  if (!A.validPassword(req.body.password)) return bad(res, 'The new password must be at least 10 characters');
  const { rows } = await db.query(
    `UPDATE password_resets SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`, [sha(token)]);
  if (!rows[0]) { A.recordFailure(key); return bad(res, 'This reset link has expired or was already used. Request a new one.'); }
  await setPassword(rows[0].user_id, req.body.password, false);
  res.json({ ok: true });
});

// ---------- admin reset ----------
r.post('/users/:id/reset-password', A.requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query('SELECT id, username FROM app_users WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  if (id === req.user.id) return bad(res, 'Use Change password on your own profile');
  const temp = tempPassword();
  await setPassword(id, temp, true);
  await audit.log(req.user, 'password.admin_reset', 'user', id, rows[0].username);
  res.json({ ok: true, username: rows[0].username, temporaryPassword: temp });
});

module.exports = r;

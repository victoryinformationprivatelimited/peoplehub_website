const express = require('express');
const db = require('./db');
const A = require('./auth');
const { validatePriceList, applyDiscount } = require('./pricing');
const audit = require('./audit');

const r = express.Router();
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bad = (res, msg) => res.status(400).json({ error: msg });
const publicUser = (u) => ({
  id: u.id, username: u.username, role: u.role, email: u.email || null, displayName: u.display_name || null, mustChangePassword: !!u.must_change_password,
  partner: u.partner_id ? { id: u.partner_id, isOwner: u.partner_role === 'owner', company: u.company_name, category: u.category_name, maxDiscountPct: Number(u.max_discount_pct) } : null,
});

// ---------------- auth ----------------
r.post('/auth/login', async (req, res) => {
  const username = str(req.body.username, 80).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const key = req.ip + '|' + username;
  if (A.loginThrottle(key)) { require('./logger').warn('auth.login_blocked', { user: username, ip: req.ip }); return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' }); }
  const { rows } = await db.query('SELECT id, password_hash FROM app_users WHERE lower(username) = $1 AND active', [username]);
  if (!rows[0] || !A.checkPassword(password, rows[0].password_hash)) {
    A.recordFailure(key);
    require('./logger').warn('auth.login_failed', { user: username, ip: req.ip, reason: rows[0] ? 'wrong password' : 'unknown or inactive user' });
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  A.clearFailures(key);
  A.setSession(res, rows[0].id);
  require('./logger').info('auth.login', { user: username, ip: req.ip });
  require('./audit').log({ id: rows[0].id, username }, 'login', 'user', rows[0].id, 'signed in from ' + req.ip);
  const { rows: me } = await db.query(
    `SELECT u.id, u.username, u.role, u.partner_id, u.partner_role, u.email, u.display_name, u.must_change_password, p.company_name, c.name AS category_name, c.max_discount_pct
       FROM app_users u LEFT JOIN partners p ON p.id = u.partner_id LEFT JOIN partner_categories c ON c.id = p.category_id WHERE u.id = $1`, [rows[0].id]);
  res.json(publicUser(me[0]));
});
r.post('/auth/logout', (req, res) => { A.clearSession(res); res.json({ ok: true }); });
r.get('/auth/me', (req, res) => (req.user ? res.json(publicUser(req.user)) : res.status(401).json({ error: 'Not signed in' })));

// Account self-service (change password, forgot/reset, profile) is exempt from the forced-change gate below
// Public client web view and tracking (no sign-in; the private link is the key)
r.use(require('./tracking').pub);

r.use(require('./accounts'));

// A user with a temporary password can do nothing but change it
r.use((req, res, next) => (req.user && req.user.must_change_password ? res.status(403).json({ error: 'You must change your password first', code: 'must_change_password' }) : next()));

// ---------------- price list ----------------
// Admin and staff receive the base list. A partner receives only their own discounted list.
r.get('/price-list', A.requireRole('admin', 'staff', 'partner'), async (req, res) => {
  const { rows } = await db.query('SELECT id, data, created_at FROM price_lists WHERE is_current');
  if (!rows[0]) return res.json({ id: null, data: null });
  if (req.user.role === 'partner') {
    return res.json({ id: rows[0].id, listData: rows[0].data, data: applyDiscount(rows[0].data, req.user.max_discount_pct), discountPct: Number(req.user.max_discount_pct), category: req.user.category_name });
  }
  res.json({ id: rows[0].id, data: rows[0].data, createdAt: rows[0].created_at });
});

r.put('/price-list', A.requireRole('admin'), async (req, res) => {
  const err = validatePriceList(req.body);
  if (err) return bad(res, err);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE price_lists SET is_current = FALSE WHERE is_current');
    const { rows } = await client.query('INSERT INTO price_lists (data, is_current, created_by, label) VALUES ($1, TRUE, $2, $3) RETURNING id, created_at', [req.body, req.user.id, str(req.query.label, 120) || null]);
    await client.query('COMMIT');
    await audit.log(req.user, 'pricelist.publish', 'price_list', rows[0].id, str(req.query.label, 120) || null);
    res.json({ id: rows[0].id, createdAt: rows[0].created_at });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

// Every published version, newest first. Staff and admin see the base prices; the category view applies each discount.
r.get('/price-lists', A.requireRole('admin', 'staff'), async (req, res) => {
  const { rows } = await db.query(
    `SELECT l.id, l.is_current, l.label, l.created_at, u.username AS created_by,
            (SELECT count(*)::int FROM proposals p WHERE p.price_list_id = l.id) AS proposals
       FROM price_lists l LEFT JOIN app_users u ON u.id = l.created_by ORDER BY l.id DESC LIMIT 100`);
  res.json(rows);
});
r.get('/price-lists/:id', A.requireRole('admin', 'staff'), async (req, res) => {
  const { rows } = await db.query('SELECT id, data, is_current, label, created_at FROM price_lists WHERE id = $1', [parseInt(req.params.id, 10) || 0]);
  if (!rows[0]) return res.status(404).json({ error: 'Price list not found' });
  const { rows: cats } = await db.query('SELECT id, name, partner_type, max_discount_pct FROM partner_categories WHERE active ORDER BY sort_order, id');
  res.json({ ...rows[0], categories: cats.map((c) => ({ id: c.id, name: c.name, type: c.partner_type, discountPct: Number(c.max_discount_pct), data: applyDiscount(rows[0].data, c.max_discount_pct) })) });
});

// ---------------- partner categories ----------------
r.get('/categories', A.requireRole('admin', 'staff'), async (req, res) => {
  const { rows } = await db.query('SELECT id, name, partner_type, max_discount_pct, commission_pct, sort_order, active FROM partner_categories ORDER BY sort_order, name');
  res.json(rows.map((c) => ({ ...c, max_discount_pct: Number(c.max_discount_pct), commission_pct: Number(c.commission_pct) })));
});
function readCategory(body) {
  const name = str(body.name, 80), type = body.partner_type, pct = Number(body.max_discount_pct);
  if (!name) return { error: 'Name is required' };
  if (!['reseller', 'agent'].includes(type)) return { error: 'Type must be reseller or agent' };
  if (!isFinite(pct) || pct < 0 || pct > 100) return { error: 'Max discount must be between 0 and 100' };
  const comm = body.commission_pct === undefined || body.commission_pct === '' ? 0 : Number(body.commission_pct);
  if (!isFinite(comm) || comm < 0 || comm > 100) return { error: 'Commission must be between 0 and 100' };
  return { name, type, pct, comm, sort: parseInt(body.sort_order, 10) || 0, active: body.active !== false };
}
r.post('/categories', A.requireRole('admin'), async (req, res) => {
  const c = readCategory(req.body); if (c.error) return bad(res, c.error);
  try {
    const { rows } = await db.query('INSERT INTO partner_categories (name, partner_type, max_discount_pct, sort_order, active, commission_pct) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [c.name, c.type, c.pct, c.sort, c.active, c.comm]);
    await audit.log(req.user, 'category.create', 'category', rows[0].id, `${c.name}: ${c.pct}% discount, ${c.comm}% commission`);
    res.status(201).json({ id: rows[0].id });
  } catch (e) { if (e.code === '23505') return bad(res, 'A category with that name already exists'); throw e; }
});
r.put('/categories/:id', A.requireRole('admin'), async (req, res) => {
  const c = readCategory(req.body); if (c.error) return bad(res, c.error);
  try {
    const { rowCount } = await db.query('UPDATE partner_categories SET name=$1, partner_type=$2, max_discount_pct=$3, sort_order=$4, active=$5, commission_pct=$7 WHERE id=$6', [c.name, c.type, c.pct, c.sort, c.active, req.params.id, c.comm]);
    if (!rowCount) return res.status(404).json({ error: 'Category not found' });
    await audit.log(req.user, 'category.update', 'category', parseInt(req.params.id, 10), `${c.name}: ${c.pct}% discount, ${c.comm}% commission`);
    res.json({ ok: true });
  } catch (e) { if (e.code === '23505') return bad(res, 'A category with that name already exists'); throw e; }
});

// ---------------- partners ----------------
r.get('/partners', A.requireRole('admin', 'staff'), async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.id, p.company_name, p.contact_name, p.email, p.phone, p.category_id, p.active, p.created_at,
            c.name AS category_name, c.max_discount_pct,
            (SELECT json_agg(json_build_object('id', u.id, 'username', u.username, 'active', u.active) ORDER BY u.id) FROM app_users u WHERE u.partner_id = p.id) AS logins
       FROM partners p JOIN partner_categories c ON c.id = p.category_id ORDER BY p.company_name`);
  res.json(rows.map((p) => ({ ...p, max_discount_pct: Number(p.max_discount_pct), logins: p.logins || [] })));
});
function readPartner(body) {
  const company = str(body.company_name, 160), cat = parseInt(body.category_id, 10);
  if (!company) return { error: 'Company name is required' };
  if (!cat) return { error: 'Category is required' };
  return { company, contact: str(body.contact_name, 120), email: str(body.email, 160), phone: str(body.phone, 40), cat, active: body.active !== false };
}
r.post('/partners', A.requireRole('admin'), async (req, res) => {
  const p = readPartner(req.body); if (p.error) return bad(res, p.error);
  const { rows } = await db.query('SELECT 1 FROM partner_categories WHERE id = $1', [p.cat]);
  if (!rows[0]) return bad(res, 'Unknown category');
  const ins = await db.query('INSERT INTO partners (company_name, contact_name, email, phone, category_id, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [p.company, p.contact, p.email, p.phone, p.cat, p.active]);
  res.status(201).json({ id: ins.rows[0].id });
});
r.put('/partners/:id', A.requireRole('admin'), async (req, res) => {
  const p = readPartner(req.body); if (p.error) return bad(res, p.error);
  const { rowCount } = await db.query('UPDATE partners SET company_name=$1, contact_name=$2, email=$3, phone=$4, category_id=$5, active=$6 WHERE id=$7', [p.company, p.contact, p.email, p.phone, p.cat, p.active, req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Partner not found' });
  res.json({ ok: true });
});
// Create a login for a partner, or reset the password if the username already belongs to this partner.
r.post('/partners/:id/login', A.requireRole('admin'), async (req, res) => {
  const username = str(req.body.username, 80).toLowerCase(), password = req.body.password;
  if (!/^[a-z0-9._-]{3,80}$/.test(username)) return bad(res, 'Username must be 3–80 letters, numbers, dot, dash or underscore');
  if (!A.validPassword(password)) return bad(res, 'Password must be at least 10 characters');
  const { rows: pr } = await db.query('SELECT id FROM partners WHERE id = $1', [req.params.id]);
  if (!pr[0]) return res.status(404).json({ error: 'Partner not found' });
  const hash = A.hashPassword(password);
  const { rows: ex } = await db.query('SELECT id, partner_id FROM app_users WHERE lower(username) = $1', [username]);
  if (ex[0]) {
    if (ex[0].partner_id !== pr[0].id) return bad(res, 'That username is already taken');
    await db.query('UPDATE app_users SET password_hash = $1, active = TRUE WHERE id = $2', [hash, ex[0].id]);
    return res.json({ ok: true, reset: true });
  }
  await db.query("INSERT INTO app_users (username, password_hash, role, partner_id) VALUES ($1,$2,'partner',$3)", [username, hash, pr[0].id]);
  res.status(201).json({ ok: true });
});
r.use(require('./emaillog')); // every email sent or attempted, with what the email service answered
r.use(require('./users')); // admin: create logins, edit, switch off, reset passwords
r.use(require('./team'));
r.use(require('./tracking').staff);
r.use(require('./crm'));
r.use(require('./presentations'));
r.use(require('./approvals'));
r.use(require('./deals'));
r.use(require('./auditlog'));
r.use(require('./rating'));
r.use(require('./dashboard'));
r.use(require('./sections'));
r.use(require('./images').router);
r.use(require('./templates'));
r.use(require('./customers'));
r.use(require('./proposals'));

module.exports = r;

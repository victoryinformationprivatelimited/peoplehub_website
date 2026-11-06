const express = require('express');
const db = require('./db');
const A = require('./auth');

const r = express.Router();
const ANY = A.requireRole('admin', 'staff', 'partner');
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bad = (res, msg) => res.status(400).json({ error: msg });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A partner only ever sees customers that belong to their own company. Admin and staff see all.
// Returns the SQL fragment and parameter so every query applies the same rule.
function scope(user, paramIndex) {
  return user.role === 'partner' ? { sql: ` AND c.partner_id = $${paramIndex}`, params: [user.partner_id] } : { sql: '', params: [] };
}

async function loadCustomer(user, id) {
  const s = scope(user, 2);
  const { rows } = await db.query(`SELECT c.* FROM customers c WHERE c.id = $1${s.sql}`, [id, ...s.params]);
  return rows[0] || null;
}

function readCustomer(b) {
  const name = str(b.name, 160);
  if (!name) return { error: 'Organisation name is required' };
  return {
    name, industry: str(b.industry, 120), address: str(b.address, 300), sites: str(b.sites, 120),
    current_system: str(b.current_system, 160), website: str(b.website, 160), notes: typeof b.notes === 'string' ? b.notes.slice(0, 4000) : '',
    active: b.active !== false,
  };
}
function readContact(b) {
  const name = str(b.name, 120);
  if (!name) return { error: 'Contact name is required' };
  const email = str(b.email, 160);
  if (email && !EMAIL.test(email)) return { error: 'Contact email is not valid' };
  return { name, title: str(b.title, 120), email, phone: str(b.phone, 40), role: str(b.role, 40), is_primary: b.is_primary === true };
}

// ---- list / search
r.get('/customers', ANY, async (req, res) => {
  const q = str(req.query.q, 100).toLowerCase();
  const s = scope(req.user, 1);
  const params = [...s.params];
  let where = 'WHERE TRUE' + s.sql;
  if (q) { params.push('%' + q + '%'); where += ` AND (lower(c.name) LIKE $${params.length} OR EXISTS (SELECT 1 FROM customer_contacts k WHERE k.customer_id = c.id AND (lower(k.name) LIKE $${params.length} OR lower(k.email) LIKE $${params.length})))`; }
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.industry, c.sites, c.active, c.partner_id, c.created_at, p.company_name AS partner_name,
            (SELECT row_to_json(k) FROM (SELECT id, name, title, email, phone FROM customer_contacts WHERE customer_id = c.id ORDER BY is_primary DESC, id LIMIT 1) k) AS primary_contact,
            (SELECT count(*) FROM customer_contacts WHERE customer_id = c.id)::int AS contact_count,
            (SELECT count(*) FROM proposals pr WHERE pr.customer_id = c.id AND pr.status <> 'superseded')::int AS proposal_count,
            (SELECT coalesce(sum((pr.totals->>'monthlyRecurring')::numeric), 0)::float FROM proposals pr WHERE pr.customer_id = c.id AND pr.status IN ('sent', 'viewed', 'negotiating')) AS open_monthly,
            (SELECT coalesce(sum((pr.totals->>'monthlyRecurring')::numeric), 0)::float FROM proposals pr WHERE pr.customer_id = c.id AND pr.status = 'accepted') AS won_monthly,
            greatest(c.updated_at, (SELECT max(pr.updated_at) FROM proposals pr WHERE pr.customer_id = c.id), (SELECT max(a.created_at) FROM crm_activities a WHERE a.customer_id = c.id)) AS last_activity
       FROM customers c LEFT JOIN partners p ON p.id = c.partner_id ${where} ORDER BY lower(c.name) LIMIT 500`, params);
  res.json(rows);
});

// ---- duplicate check (within what the user is allowed to see)
r.get('/customers/check', ANY, async (req, res) => {
  const name = str(req.query.name, 160).toLowerCase(), email = str(req.query.email, 160).toLowerCase();
  if (!name && !email) return res.json([]);
  const s = scope(req.user, 3);
  const { rows } = await db.query(
    `SELECT DISTINCT c.id, c.name FROM customers c LEFT JOIN customer_contacts k ON k.customer_id = c.id
      WHERE ((($1 <> '') AND lower(c.name) = $1) OR (($2 <> '') AND lower(k.email) = $2))${s.sql} LIMIT 5`, [name, email, ...s.params]);
  res.json(rows);
});

// ---- create (optionally with first contact)
r.post('/customers', ANY, async (req, res) => {
  const c = readCustomer(req.body); if (c.error) return bad(res, c.error);
  let contact = null;
  if (req.body.contact && (req.body.contact.name || req.body.contact.email)) { contact = readContact(req.body.contact); if (contact.error) return bad(res, contact.error); }
  // Staff and Admin may assign a customer to a partner; a partner's customers always belong to that partner.
  let partnerId = null;
  if (req.user.role === 'partner') partnerId = req.user.partner_id;
  else if (req.body.partner_id) {
    const { rows } = await db.query('SELECT id FROM partners WHERE id = $1', [parseInt(req.body.partner_id, 10)]);
    if (!rows[0]) return bad(res, 'Unknown partner');
    partnerId = rows[0].id;
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO customers (name, industry, address, sites, current_system, website, notes, partner_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [c.name, c.industry, c.address, c.sites, c.current_system, c.website, c.notes, partnerId, req.user.id]);
    if (contact) await client.query('INSERT INTO customer_contacts (customer_id, name, title, email, phone, role, is_primary) VALUES ($1,$2,$3,$4,$5,$6,TRUE)', [ins.rows[0].id, contact.name, contact.title, contact.email, contact.phone, contact.role]);
    await client.query('COMMIT');
    res.status(201).json({ id: ins.rows[0].id });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

// ---- read one with contacts
r.get('/customers/:id', ANY, async (req, res) => {
  const cust = await loadCustomer(req.user, req.params.id);
  if (!cust) return res.status(404).json({ error: 'Customer not found' });
  const { rows } = await db.query('SELECT id, name, title, email, phone, role, is_primary FROM customer_contacts WHERE customer_id = $1 ORDER BY is_primary DESC, id', [cust.id]);
  const props = await db.query(`SELECT p.id, p.ref_no, p.version, p.status, p.created_at, (p.totals->>'monthlyRecurring')::float AS monthly, (p.totals->>'year1')::float AS year1 FROM proposals p WHERE p.customer_id = $1 ORDER BY p.created_at DESC`, [cust.id]);
  const lead = await db.query('SELECT id, stage FROM leads WHERE customer_id = $1 ORDER BY id DESC LIMIT 1', [cust.id]);
  const pn = cust.partner_id ? await db.query('SELECT company_name FROM partners WHERE id = $1', [cust.partner_id]) : { rows: [] };
  res.json({ ...cust, contacts: rows, proposals: props.rows, lead: lead.rows[0] || null, partner_name: pn.rows[0] ? pn.rows[0].company_name : null });
});

r.put('/customers/:id', ANY, async (req, res) => {
  const c = readCustomer(req.body); if (c.error) return bad(res, c.error);
  if (!(await loadCustomer(req.user, req.params.id))) return res.status(404).json({ error: 'Customer not found' });
  await db.query('UPDATE customers SET name=$1, industry=$2, address=$3, sites=$4, current_system=$5, website=$6, notes=$7, active=$8, updated_at=now() WHERE id=$9',
    [c.name, c.industry, c.address, c.sites, c.current_system, c.website, c.notes, c.active, req.params.id]);
  res.json({ ok: true });
});

// ---- contacts
async function setPrimary(client, customerId, contactId) {
  await client.query('UPDATE customer_contacts SET is_primary = FALSE WHERE customer_id = $1 AND is_primary', [customerId]);
  await client.query('UPDATE customer_contacts SET is_primary = TRUE WHERE id = $1', [contactId]);
}
r.post('/customers/:id/contacts', ANY, async (req, res) => {
  const k = readContact(req.body); if (k.error) return bad(res, k.error);
  const cust = await loadCustomer(req.user, req.params.id);
  if (!cust) return res.status(404).json({ error: 'Customer not found' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: has } = await client.query('SELECT count(*)::int AS n FROM customer_contacts WHERE customer_id = $1', [cust.id]);
    const ins = await client.query('INSERT INTO customer_contacts (customer_id, name, title, email, phone, role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [cust.id, k.name, k.title, k.email, k.phone, k.role]);
    if (k.is_primary || has[0].n === 0) await setPrimary(client, cust.id, ins.rows[0].id);
    await client.query('COMMIT');
    res.status(201).json({ id: ins.rows[0].id });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

async function loadContact(user, id) {
  const s = scope(user, 2);
  const { rows } = await db.query(`SELECT k.* FROM customer_contacts k JOIN customers c ON c.id = k.customer_id WHERE k.id = $1${s.sql}`, [id, ...s.params]);
  return rows[0] || null;
}
r.put('/contacts/:id', ANY, async (req, res) => {
  const k = readContact(req.body); if (k.error) return bad(res, k.error);
  const cur = await loadContact(req.user, req.params.id);
  if (!cur) return res.status(404).json({ error: 'Contact not found' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE customer_contacts SET name=$1, title=$2, email=$3, phone=$4, role=$5 WHERE id=$6', [k.name, k.title, k.email, k.phone, k.role, cur.id]);
    if (k.is_primary) await setPrimary(client, cur.customer_id, cur.id);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});
r.delete('/contacts/:id', ANY, async (req, res) => {
  const cur = await loadContact(req.user, req.params.id);
  if (!cur) return res.status(404).json({ error: 'Contact not found' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM customer_contacts WHERE id = $1', [cur.id]);
    if (cur.is_primary) await client.query('UPDATE customer_contacts SET is_primary = TRUE WHERE id = (SELECT id FROM customer_contacts WHERE customer_id = $1 ORDER BY id LIMIT 1)', [cur.customer_id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

r.loadCustomer = loadCustomer;

module.exports = r;

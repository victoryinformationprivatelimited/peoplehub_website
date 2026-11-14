// CRM: leads, follow-up tasks, activity log, customer timeline and daily reminder emails.
const express = require('express');
const db = require('./db');
const A = require('./auth');
const mail = require('./email');
const customers = require('./customers');

const r = express.Router();
const ANY = A.requireRole('admin', 'staff', 'partner');
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bad = (res, msg, extra) => res.status(400).json({ error: msg, ...(extra || {}) });
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const STAGES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'];
const ACT_TYPES = ['call', 'meeting', 'email', 'whatsapp', 'note'];
const TASK_TYPES = ['call', 'email', 'meeting', 'whatsapp', 'follow_up', 'other'];
const LOCK_DAYS = 90;
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'zoho.com', 'mail.com', 'yandex.com', 'gmx.com', 'slt.lk', 'sltnet.lk']);

// ---------- matching keys ----------
function nameKey(s) {
  let k = String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // "ABC (Pvt) Ltd" and "ABC" are the same company
  for (let i = 0; i < 3; i++) k = k.replace(/(pvtltd|privatelimited|pvt|ltd|limited|plc|inc|llc|company|co|group|holdings)$/, '');
  return k.slice(0, 160);
}
const domainOf = (email) => { const d = (String(email || '').split('@')[1] || '').toLowerCase(); return d && !FREE_MAIL.has(d) ? d.slice(0, 120) : null; };
const phoneKeyOf = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 7 ? d.slice(-9) : null; };

// ---------- visibility ----------
const isStaff = (u) => u.role === 'admin' || u.role === 'staff';
function leadScope(user, alias, start) {
  return user.role === 'partner' ? { sql: ` AND ${alias}.partner_id = $${start}`, params: [user.partner_id] } : { sql: '', params: [] };
}
async function loadLead(user, id) {
  const s = leadScope(user, 'l', 2);
  const { rows } = await db.query(`SELECT l.* FROM leads l WHERE l.id = $1${s.sql}`, [parseInt(id, 10) || 0, ...s.params]);
  return rows[0] || null;
}
// People a lead or task may be given to: colleagues in the same company, or Victory staff
async function assignable(user, userId) {
  if (!userId) return false;
  if (user.role === 'partner') {
    const { rows } = await db.query('SELECT 1 FROM app_users WHERE id = $1 AND partner_id = $2 AND active', [userId, user.partner_id]);
    return rows.length > 0;
  }
  const { rows } = await db.query(`SELECT 1 FROM app_users WHERE id = $1 AND role IN ('admin', 'staff') AND active`, [userId]);
  return rows.length > 0;
}

// ---------- channel conflict: who already holds this company? ----------
async function findConflicts(user, keys, excludeId) {
  const out = [];
  const { rows: leads } = await db.query(
    `SELECT l.id, l.company_name, l.partner_id, l.lock_until, l.stage FROM leads l
      WHERE l.stage <> 'lost' AND l.lock_until > now() AND ($5::int IS NULL OR l.id <> $5)
        AND (($1 <> '' AND l.name_key = $1) OR ($2::text IS NOT NULL AND l.email = $2) OR ($3::text IS NOT NULL AND l.email_domain = $3) OR ($4::text IS NOT NULL AND l.phone_key = $4))`,
    [keys.name_key, keys.email, keys.email_domain, keys.phone_key, excludeId || null]);
  leads.forEach((l) => out.push({ kind: 'lead', id: l.id, company: l.company_name, partner_id: l.partner_id, until: l.lock_until }));
  if (keys.name_key) {
    const { rows: cs } = await db.query(
      `SELECT id, name, partner_id FROM customers WHERE active AND regexp_replace(lower(name), '[^a-z0-9]', '', 'g') LIKE $1 || '%' LIMIT 50`, [keys.name_key]);
    cs.filter((c) => nameKey(c.name) === keys.name_key).forEach((c) => out.push({ kind: 'customer', id: c.id, company: c.name, partner_id: c.partner_id, until: null }));
  }
  const mine = user.role === 'partner' ? user.partner_id : null;
  return {
    // For a partner: "own" is their company, "others" is everyone else (Victory included).
    // For Victory staff: "own" is Victory's direct records, "others" is anything a partner holds.
    own: out.filter((c) => (user.role === 'partner' ? c.partner_id === mine : c.partner_id === null)),
    others: out.filter((c) => (user.role === 'partner' ? c.partner_id !== mine : c.partner_id !== null)),
  };
}

function readLead(b) {
  const email = str(b.email, 160).toLowerCase();
  return {
    company_name: str(b.company_name, 160), contact_name: str(b.contact_name, 120) || null, contact_title: str(b.contact_title, 120) || null,
    email: email || null, phone: str(b.phone, 40) || null, industry: str(b.industry, 120) || null, source: str(b.source, 40) || null,
    employees: b.employees === '' || b.employees == null ? null : Math.max(0, Math.min(1000000, parseInt(b.employees, 10) || 0)) || null,
    est_value: b.est_value === '' || b.est_value == null ? null : Math.max(0, Math.min(100000000, Number(b.est_value) || 0)) || null,
    notes: typeof b.notes === 'string' ? b.notes.trim().slice(0, 4000) || null : null,
  };
}

async function logActivity(clientOrDb, o) {
  await clientOrDb.query('INSERT INTO crm_activities (lead_id, customer_id, type, note, user_id) VALUES ($1,$2,$3,$4,$5)', [o.lead_id || null, o.customer_id || null, o.type, o.note || null, o.user_id || null]);
}
const extendLock = (id) => db.query(`UPDATE leads SET lock_until = greatest(lock_until, now() + ($2 || ' days')::interval), updated_at = now() WHERE id = $1 AND stage NOT IN ('lost')`, [id, String(LOCK_DAYS)]);

// ---------- leads ----------
r.get('/leads', ANY, async (req, res) => {
  const s = leadScope(req.user, 'l', 1);
  const params = [...s.params];
  let where = s.sql;
  if (STAGES.includes(req.query.stage)) { params.push(req.query.stage); where += ` AND l.stage = $${params.length}`; }
  if (req.query.mine === '1') { params.push(req.user.id); where += ` AND l.owner_id = $${params.length}`; }
  const q = str(req.query.q, 80).toLowerCase();
  if (q) { params.push('%' + q + '%'); where += ` AND (lower(l.company_name) LIKE $${params.length} OR lower(coalesce(l.contact_name,'')) LIKE $${params.length} OR lower(coalesce(l.email,'')) LIKE $${params.length})`; }
  const { rows } = await db.query(
    `SELECT l.id, l.company_name, l.contact_name, l.email, l.phone, l.stage, l.source, l.employees, l.est_value, l.lost_reason, l.customer_id, l.lock_until, l.created_at, l.updated_at, l.stage_changed_at,
            coalesce(o.display_name, o.username) AS owner_name, l.owner_id, pa.company_name AS partner_name,
            (SELECT min(t.due_date) FROM tasks t WHERE t.lead_id = l.id AND t.done_at IS NULL) AS next_due,
            (SELECT count(*)::int FROM tasks t WHERE t.lead_id = l.id AND t.done_at IS NULL) AS open_tasks
       FROM leads l JOIN app_users o ON o.id = l.owner_id LEFT JOIN partners pa ON pa.id = l.partner_id
      WHERE TRUE${where} ORDER BY l.updated_at DESC LIMIT 500`, params);
  res.json(rows);
});

r.get('/leads/summary', ANY, async (req, res) => {
  const s = leadScope(req.user, 'l', 1);
  const { rows } = await db.query(`SELECT l.stage, count(*)::int AS n, coalesce(sum(l.est_value), 0)::float AS value FROM leads l WHERE TRUE${s.sql} GROUP BY l.stage`, s.params);
  const out = {}; STAGES.forEach((st) => { out[st] = { n: 0, value: 0 }; }); rows.forEach((x) => { out[x.stage] = { n: x.n, value: x.value }; });
  res.json(out);
});

r.get('/leads/:id', ANY, async (req, res) => {
  const l = await loadLead(req.user, req.params.id);
  if (!l) return res.status(404).json({ error: 'Lead not found' });
  const [acts, tasks, props, owner] = await Promise.all([
    db.query(`SELECT a.id, a.type, a.note, a.created_at, coalesce(u.display_name, u.username) AS by_user FROM crm_activities a LEFT JOIN app_users u ON u.id = a.user_id WHERE a.lead_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT 200`, [l.id]),
    db.query(`SELECT t.id, t.type, t.title, t.due_date, t.done_at, t.assigned_to, coalesce(u.display_name, u.username) AS assignee FROM tasks t JOIN app_users u ON u.id = t.assigned_to WHERE t.lead_id = $1 ORDER BY (t.done_at IS NOT NULL), t.due_date`, [l.id]),
    l.customer_id ? db.query(`SELECT p.id, p.ref_no, p.version, p.status, p.totals->>'monthlyRecurring' AS monthly FROM proposals p WHERE p.customer_id = $1 ORDER BY p.created_at DESC`, [l.customer_id]) : { rows: [] },
    db.query('SELECT coalesce(display_name, username) AS name FROM app_users WHERE id = $1', [l.owner_id]),
  ]);
  res.json({ ...l, owner_name: owner.rows[0] && owner.rows[0].name, activities: acts.rows, tasks: tasks.rows, proposals: props.rows });
});

r.post('/leads', ANY, async (req, res) => {
  const d = readLead(req.body);
  if (!d.company_name) return bad(res, 'Enter the company name');
  if (d.email && !EMAIL_RE.test(d.email)) return bad(res, 'Enter a valid email address');
  const keys = { name_key: nameKey(d.company_name), email: d.email, email_domain: domainOf(d.email), phone_key: phoneKeyOf(d.phone) };
  if (!keys.name_key) return bad(res, 'Enter a valid company name');
  const hit = await findConflicts(req.user, keys, null);
  if (req.user.role === 'partner' && hit.others.length) {
    const until = hit.others.map((h) => h.until).filter(Boolean).sort().pop();
    return res.status(409).json({ error: 'This company is already registered by someone else' + (until ? ' until ' + new Date(until).toLocaleDateString('en-GB') : '') + ', or is an existing customer. Please contact Victory Information if you believe this is a mistake.', code: 'registered_elsewhere' });
  }
  if (hit.own.length && !req.body.force) {
    return res.status(409).json({ error: 'You already have this company on record.', code: 'duplicate', existing: hit.own.map((h) => ({ kind: h.kind, id: h.id, company: h.company })) });
  }
  if (isStaff(req.user) && hit.others.length && !req.body.force) {
    return res.status(409).json({ error: 'A partner holds this company or it is an existing customer. Confirm to register it anyway.', code: 'held_by_partner', existing: hit.others.map((h) => ({ kind: h.kind, id: h.id, company: h.company })) });
  }
  let partnerId = req.user.role === 'partner' ? req.user.partner_id : null;
  if (isStaff(req.user) && req.body.partner_id) {
    const pr = await db.query('SELECT id FROM partners WHERE id = $1 AND active', [parseInt(req.body.partner_id, 10) || 0]);
    if (!pr.rows[0]) return bad(res, 'Unknown partner');
    partnerId = pr.rows[0].id;
  }
  let ownerId = req.user.id;
  if (req.body.owner_id) {
    const oid = parseInt(req.body.owner_id, 10);
    if (partnerId && !(await db.query('SELECT 1 FROM app_users WHERE id = $1 AND partner_id = $2 AND active', [oid, partnerId])).rowCount) return bad(res, 'The owner must work for the same company');
    if (!partnerId && !(await assignable(req.user, oid))) return bad(res, 'The owner must be a Victory team member');
    ownerId = oid;
  }
  const { rows } = await db.query(
    `INSERT INTO leads (partner_id, owner_id, created_by, company_name, name_key, contact_name, contact_title, email, email_domain, phone, phone_key, industry, source, employees, est_value, notes, lock_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now() + ($17 || ' days')::interval) RETURNING id`,
    [partnerId, ownerId, req.user.id, d.company_name, keys.name_key, d.contact_name, d.contact_title, d.email, keys.email_domain, d.phone, keys.phone_key, d.industry, d.source, d.employees, d.est_value, d.notes, String(LOCK_DAYS)]);
  await logActivity(db, { lead_id: rows[0].id, type: 'stage', note: 'Lead created', user_id: req.user.id });
  res.status(201).json({ id: rows[0].id });
});

r.put('/leads/:id', ANY, async (req, res) => {
  const l = await loadLead(req.user, req.params.id);
  if (!l) return res.status(404).json({ error: 'Lead not found' });
  const d = readLead({ ...l, ...req.body });
  if (!d.company_name) return bad(res, 'Enter the company name');
  if (d.email && !EMAIL_RE.test(d.email)) return bad(res, 'Enter a valid email address');
  const keys = { name_key: nameKey(d.company_name), email: d.email, email_domain: domainOf(d.email), phone_key: phoneKeyOf(d.phone) };
  if (req.user.role === 'partner') {
    const hit = await findConflicts(req.user, keys, l.id);
    if (hit.others.length) return res.status(409).json({ error: 'Those details match a company registered by someone else.', code: 'registered_elsewhere' });
  }
  let ownerId = l.owner_id;
  if (req.body.owner_id && Number(req.body.owner_id) !== l.owner_id) {
    const oid = parseInt(req.body.owner_id, 10);
    const ok = l.partner_id ? (await db.query('SELECT 1 FROM app_users WHERE id = $1 AND partner_id = $2 AND active', [oid, l.partner_id])).rowCount > 0 : await assignable(req.user, oid);
    if (!ok) return bad(res, 'That person cannot own this lead');
    ownerId = oid;
  }
  await db.query(
    `UPDATE leads SET company_name=$1, name_key=$2, contact_name=$3, contact_title=$4, email=$5, email_domain=$6, phone=$7, phone_key=$8, industry=$9, source=$10, employees=$11, est_value=$12, notes=$13, owner_id=$14, updated_at=now() WHERE id=$15`,
    [d.company_name, keys.name_key, d.contact_name, d.contact_title, d.email, keys.email_domain, d.phone, keys.phone_key, d.industry, d.source, d.employees, d.est_value, d.notes, ownerId, l.id]);
  res.json({ ok: true });
});

async function setStage(lead, to, reason, userId) {
  await db.query(`UPDATE leads SET stage = $1, lost_reason = $2, stage_changed_at = now(), updated_at = now() WHERE id = $3`, [to, to === 'lost' ? reason : null, lead.id]);
  await logActivity(db, { lead_id: lead.id, type: 'stage', note: `${lead.stage} → ${to}` + (to === 'lost' && reason ? ' — ' + reason : ''), user_id: userId });
  if (to !== 'lost') await extendLock(lead.id);
}

r.put('/leads/:id/stage', ANY, async (req, res) => {
  const l = await loadLead(req.user, req.params.id);
  if (!l) return res.status(404).json({ error: 'Lead not found' });
  const to = req.body.stage, reason = str(req.body.reason, 300);
  if (!STAGES.includes(to)) return bad(res, 'Unknown stage');
  if (to === l.stage) return res.json({ ok: true });
  if (to === 'lost' && reason.length < 3) return bad(res, 'Say why the lead was lost');
  if (l.stage === 'lost' && to !== 'new' && to !== 'contacted') return bad(res, 'Reopen a lost lead as New or Contacted');
  if (l.stage === 'lost') {
    // Reopening: the company must not have been taken by someone else in the meantime
    const hit = await findConflicts(req.user, { name_key: l.name_key, email: l.email, email_domain: l.email_domain, phone_key: l.phone_key }, l.id);
    if (req.user.role === 'partner' && hit.others.length) return res.status(409).json({ error: 'This company has been registered by someone else since, so the lead cannot be reopened.', code: 'registered_elsewhere' });
  }
  await setStage(l, to, reason, req.user.id);
  if (l.stage === 'lost') await db.query(`UPDATE leads SET lock_until = now() + ($2 || ' days')::interval WHERE id = $1`, [l.id, String(LOCK_DAYS)]);
  res.json({ ok: true });
});

r.post('/leads/:id/activities', ANY, async (req, res) => {
  const l = await loadLead(req.user, req.params.id);
  if (!l) return res.status(404).json({ error: 'Lead not found' });
  const type = req.body.type, note = str(req.body.note, 1000);
  if (!ACT_TYPES.includes(type)) return bad(res, 'Unknown activity type');
  if (!note) return bad(res, 'Write a short note');
  await logActivity(db, { lead_id: l.id, customer_id: l.customer_id, type, note, user_id: req.user.id });
  if (l.stage !== 'lost') await extendLock(l.id);
  if (l.stage === 'new' && type !== 'note') await setStage(l, 'contacted', '', req.user.id);
  res.status(201).json({ ok: true });
});

// Turn a lead into a customer (with its contact), ready for a proposal
r.post('/leads/:id/convert', ANY, async (req, res) => {
  const l = await loadLead(req.user, req.params.id);
  if (!l) return res.status(404).json({ error: 'Lead not found' });
  if (l.stage === 'lost') return bad(res, 'Reopen the lead before creating a proposal');
  if (l.customer_id) return res.json({ customer_id: l.customer_id, existing: true });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const c = await client.query('INSERT INTO customers (name, industry, partner_id, created_by) VALUES ($1,$2,$3,$4) RETURNING id', [l.company_name, l.industry, l.partner_id, req.user.id]);
    if (l.contact_name) await client.query('INSERT INTO customer_contacts (customer_id, name, title, email, phone, is_primary) VALUES ($1,$2,$3,$4,$5,TRUE)', [c.rows[0].id, l.contact_name, l.contact_title, l.email, l.phone]);
    await client.query('UPDATE leads SET customer_id = $1, updated_at = now() WHERE id = $2', [c.rows[0].id, l.id]);
    await client.query(`INSERT INTO crm_activities (lead_id, customer_id, type, note, user_id) VALUES ($1,$2,'stage','Converted to a customer',$3)`, [l.id, c.rows[0].id, req.user.id]);
    await client.query('COMMIT');
    if (['new', 'contacted'].includes(l.stage)) await setStage(l, 'qualified', '', req.user.id);
    res.status(201).json({ customer_id: c.rows[0].id });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

// A proposal that has been sent belongs on the lead board. When its customer has no lead yet, one is created in the Proposal stage.
async function ensureLeadForProposal(customerId) {
  const { rows: ex } = await db.query('SELECT 1 FROM leads WHERE customer_id = $1 LIMIT 1', [customerId]);
  if (ex.length) return null; // already on the board (or was, and was closed)
  const { rows: pr } = await db.query(
    `SELECT p.id, p.ref_no, p.partner_id, p.created_by, p.client, p.selections, p.totals FROM proposals p
      WHERE p.customer_id = $1 AND p.status IN ('sent', 'viewed', 'negotiating') ORDER BY p.created_at DESC LIMIT 1`, [customerId]);
  const p = pr[0]; if (!p) return null;
  const { rows: cu } = await db.query('SELECT name, industry FROM customers WHERE id = $1', [customerId]);
  const c = cu[0]; if (!c) return null;
  const contact = (p.client && p.client.contact) || {};
  const email = contact.email ? String(contact.email).trim().toLowerCase().slice(0, 160) : null;
  const keys = { name_key: nameKey(c.name), email, email_domain: domainOf(email), phone_key: phoneKeyOf(contact.phone) };
  if (!keys.name_key) return null;
  // if another company already holds this one, it stays with them
  const hit = await findConflicts({ role: p.partner_id ? 'partner' : 'staff', partner_id: p.partner_id || null }, keys, null);
  if (hit.others.length) return null;
  const emp = parseInt(p.selections && p.selections.employees, 10);
  const value = Number(p.totals && p.totals.monthlyRecurring);
  const ins = await db.query(
    `INSERT INTO leads (partner_id, owner_id, created_by, company_name, name_key, contact_name, contact_title, email, email_domain, phone, phone_key, industry, source, employees, est_value, stage, customer_id, lock_until)
     VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'proposal',$12,$13,'proposal',$14, now() + ($15 || ' days')::interval) RETURNING id`,
    [p.partner_id || null, p.created_by, c.name.slice(0, 160), keys.name_key, contact.name ? String(contact.name).slice(0, 120) : null, contact.title ? String(contact.title).slice(0, 120) : null, email, keys.email_domain, contact.phone ? String(contact.phone).slice(0, 40) : null, keys.phone_key, c.industry ? String(c.industry).slice(0, 120) : null, Number.isInteger(emp) && emp > 0 ? emp : null, value > 0 ? value : null, customerId, String(LOCK_DAYS)]);
  await logActivity(db, { lead_id: ins.rows[0].id, type: 'stage', note: 'Added to the board when proposal ' + p.ref_no + ' was sent', user_id: p.created_by });
  return ins.rows[0].id;
}

// At start-up: proposals that were sent before this existed get their lead too
async function backfillLeadsFromProposals() {
  const { rows } = await db.query(
    `SELECT DISTINCT p.customer_id FROM proposals p WHERE p.status IN ('sent', 'viewed', 'negotiating') AND p.customer_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.customer_id = p.customer_id)`);
  let n = 0;
  for (const x of rows) { try { if (await ensureLeadForProposal(x.customer_id)) n++; } catch (e) { console.error('lead from proposal failed:', e.message); } }
  if (n) console.log('Added ' + n + ' lead' + (n === 1 ? '' : 's') + ' to the board for proposals that were already sent');
  return n;
}

// Called when a proposal moves: keeps the lead's stage in step with the deal
async function syncLeadFromProposal(customerId, status, reason, userId) {
  if (!customerId) return;
  const { rows } = await db.query(`SELECT * FROM leads WHERE customer_id = $1 AND stage NOT IN ('won', 'lost') ORDER BY id DESC LIMIT 1`, [customerId]);
  const l = rows[0];
  if (!l) { if (['sent', 'viewed', 'negotiating'].includes(status)) await ensureLeadForProposal(customerId); return; }
  if (status === 'sent' && ['new', 'contacted', 'qualified'].includes(l.stage)) await setStage(l, 'proposal', '', userId);
  else if (status === 'accepted') await setStage(l, 'won', '', userId);
  else if (status === 'lost') await setStage(l, 'lost', 'Proposal lost' + (reason ? ': ' + reason : ''), userId);
  else if (['viewed', 'negotiating'].includes(status)) await extendLock(l.id);
}

// ---------- follow-up tasks ----------
const today = () => new Date().toISOString().slice(0, 10);
function readTask(b) {
  return { title: str(b.title, 200), type: TASK_TYPES.includes(b.type) ? b.type : 'follow_up', due_date: /^\d{4}-\d{2}-\d{2}$/.test(b.due_date || '') ? b.due_date : null };
}
function taskScope(user, alias, start) {
  return user.role === 'partner' ? { sql: ` AND ${alias}.partner_id = $${start}`, params: [user.partner_id] } : { sql: '', params: [] };
}
const canSeeAll = (u) => isStaff(u) || (u.role === 'partner' && u.partner_role === 'owner');

r.get('/tasks/summary', ANY, async (req, res) => {
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE due_date < current_date)::int AS overdue, count(*) FILTER (WHERE due_date = current_date)::int AS today
       FROM tasks WHERE assigned_to = $1 AND done_at IS NULL`, [req.user.id]);
  res.json(rows[0]);
});

r.get('/tasks', ANY, async (req, res) => {
  const s = taskScope(req.user, 't', 1);
  const params = [...s.params];
  let where = s.sql;
  const who = req.query.who === 'all' && canSeeAll(req.user) ? 'all' : 'me';
  if (who === 'me') { params.push(req.user.id); where += ` AND t.assigned_to = $${params.length}`; }
  const scope = req.query.scope || 'open';
  if (scope === 'overdue') where += ' AND t.done_at IS NULL AND t.due_date < current_date';
  else if (scope === 'today') where += ' AND t.done_at IS NULL AND t.due_date = current_date';
  else if (scope === 'upcoming') where += ' AND t.done_at IS NULL AND t.due_date > current_date';
  else if (scope === 'done') where += ' AND t.done_at IS NOT NULL AND t.done_at > now() - interval \'30 days\'';
  else where += ' AND t.done_at IS NULL';
  for (const k of ['lead_id', 'customer_id', 'proposal_id']) if (req.query[k]) { params.push(parseInt(req.query[k], 10) || 0); where += ` AND t.${k} = $${params.length}`; }
  const { rows } = await db.query(
    `SELECT t.id, t.type, t.title, t.due_date, t.done_at, t.lead_id, t.customer_id, t.proposal_id, t.assigned_to, coalesce(u.display_name, u.username) AS assignee,
            l.company_name AS lead_name, c.name AS customer_name, p.ref_no AS proposal_ref
       FROM tasks t JOIN app_users u ON u.id = t.assigned_to LEFT JOIN leads l ON l.id = t.lead_id LEFT JOIN customers c ON c.id = t.customer_id LEFT JOIN proposals p ON p.id = t.proposal_id
      WHERE TRUE${where} ORDER BY t.done_at IS NOT NULL, t.due_date, t.id LIMIT 300`, params);
  res.json(rows);
});

r.post('/tasks', ANY, async (req, res) => {
  const d = readTask(req.body);
  if (!d.title) return bad(res, 'Say what needs to be done');
  if (!d.due_date) return bad(res, 'Choose a due date');
  const link = { lead_id: null, customer_id: null, proposal_id: null };
  if (req.body.lead_id) { const l = await loadLead(req.user, req.body.lead_id); if (!l) return bad(res, 'Lead not found'); link.lead_id = l.id; link.customer_id = l.customer_id; }
  else if (req.body.customer_id) { const c = await customers.loadCustomer(req.user, parseInt(req.body.customer_id, 10)); if (!c) return bad(res, 'Customer not found'); link.customer_id = c.id; }
  if (req.body.proposal_id) {
    const sc = req.user.role === 'partner' ? ' AND partner_id = $2' : '';
    const { rows } = await db.query(`SELECT id, customer_id FROM proposals WHERE id = $1${sc}`, req.user.role === 'partner' ? [parseInt(req.body.proposal_id, 10) || 0, req.user.partner_id] : [parseInt(req.body.proposal_id, 10) || 0]);
    if (!rows[0]) return bad(res, 'Proposal not found');
    link.proposal_id = rows[0].id; link.customer_id = link.customer_id || rows[0].customer_id;
  }
  let assignee = req.user.id;
  if (req.body.assigned_to && Number(req.body.assigned_to) !== req.user.id) {
    if (!(await assignable(req.user, parseInt(req.body.assigned_to, 10)))) return bad(res, 'That person cannot be given this task');
    assignee = parseInt(req.body.assigned_to, 10);
  }
  const partnerId = req.user.role === 'partner' ? req.user.partner_id : null;
  const { rows } = await db.query(
    `INSERT INTO tasks (lead_id, customer_id, proposal_id, partner_id, assigned_to, created_by, type, title, due_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [link.lead_id, link.customer_id, link.proposal_id, partnerId, assignee, req.user.id, d.type, d.title, d.due_date]);
  res.status(201).json({ id: rows[0].id });
});

async function loadTask(user, id) {
  const s = taskScope(user, 't', 2);
  const { rows } = await db.query(`SELECT t.* FROM tasks t WHERE t.id = $1${s.sql}`, [parseInt(id, 10) || 0, ...s.params]);
  return rows[0] || null;
}

r.put('/tasks/:id', ANY, async (req, res) => {
  const t = await loadTask(req.user, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (req.body.done !== undefined) {
    await db.query('UPDATE tasks SET done_at = $1, done_by = $2 WHERE id = $3', [req.body.done ? new Date() : null, req.body.done ? req.user.id : null, t.id]);
    if (req.body.done && t.lead_id) await logActivity(db, { lead_id: t.lead_id, customer_id: t.customer_id, type: 'note', note: 'Follow-up done: ' + t.title, user_id: req.user.id });
  }
  if (req.body.due_date || req.body.title || req.body.type) {
    const d = readTask({ ...t, due_date: req.body.due_date || String(t.due_date).slice(0, 10), title: req.body.title || t.title, type: req.body.type || t.type });
    if (!d.title || !d.due_date) return bad(res, 'Title and due date are needed');
    await db.query('UPDATE tasks SET title = $1, type = $2, due_date = $3 WHERE id = $4', [d.title, d.type, d.due_date, t.id]);
  }
  res.json({ ok: true });
});

r.delete('/tasks/:id', ANY, async (req, res) => {
  const t = await loadTask(req.user, req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (t.created_by !== req.user.id && !canSeeAll(req.user)) return res.status(403).json({ error: 'Only the person who created it can delete it' });
  await db.query('DELETE FROM tasks WHERE id = $1', [t.id]);
  res.json({ ok: true });
});

// ---------- customer timeline: CRM activity plus everything that happened to their proposals ----------
r.get('/customers/:id/timeline', ANY, async (req, res) => {
  const c = await customers.loadCustomer(req.user, parseInt(req.params.id, 10));
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  const { rows } = await db.query(
    `SELECT * FROM (
        SELECT a.created_at AS at, 'activity' AS kind, a.type AS type, a.note AS text, coalesce(u.display_name, u.username) AS by_user, NULL::text AS ref
          FROM crm_activities a LEFT JOIN app_users u ON u.id = a.user_id
         WHERE a.customer_id = $1 OR a.lead_id IN (SELECT id FROM leads WHERE customer_id = $1)
        UNION ALL
        SELECT e.created_at, 'proposal', e.type,
               CASE WHEN e.type = 'status' THEN 'Status: ' || coalesce(e.from_status, '') || ' → ' || coalesce(e.to_status, '') || coalesce(' — ' || e.note, '')
                    WHEN e.type = 'emailed' THEN 'Emailed to ' || coalesce(e.note, '') WHEN e.type = 'created' THEN coalesce(e.note, 'Proposal created')
                    WHEN e.type = 'client_request' THEN 'Client asked to talk: ' || coalesce(e.note, '') ELSE e.type END,
               coalesce(u.display_name, u.username), p.ref_no
          FROM proposal_events e JOIN proposals p ON p.id = e.proposal_id LEFT JOIN app_users u ON u.id = e.user_id WHERE p.customer_id = $1
        UNION ALL
        SELECT t.done_at, 'task', 'task', 'Follow-up done: ' || t.title, coalesce(u.display_name, u.username), NULL
          FROM tasks t LEFT JOIN app_users u ON u.id = t.done_by WHERE t.customer_id = $1 AND t.done_at IS NOT NULL
     ) x ORDER BY at DESC LIMIT 200`, [c.id]);
  res.json(rows);
});

// ---------- daily reminder emails ----------
// Who has follow-ups due today or overdue, grouped by person (only people with an email address)
async function dueByUser() {
  const { rows } = await db.query(
    `SELECT u.id AS user_id, u.email, coalesce(u.display_name, u.username) AS name, t.id, t.title, t.due_date, t.type, l.company_name AS lead_name, c.name AS customer_name
       FROM tasks t JOIN app_users u ON u.id = t.assigned_to AND u.active AND u.email IS NOT NULL
       LEFT JOIN leads l ON l.id = t.lead_id LEFT JOIN customers c ON c.id = t.customer_id
      WHERE t.done_at IS NULL AND t.due_date <= current_date ORDER BY t.due_date`);
  const out = new Map();
  rows.forEach((x) => { if (!out.has(x.user_id)) out.set(x.user_id, { email: x.email, name: x.name, tasks: [] }); out.get(x.user_id).tasks.push(x); });
  return out;
}
const escH = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function sendDigests() {
  if (!mail.configured()) return 0;
  const base = (process.env.APP_BASE_URL || 'http://localhost:4400').replace(/\/+$/, '');
  let sent = 0;
  for (const [userId, d] of await dueByUser()) {
    const claim = await db.query('INSERT INTO digest_log (user_id, day) VALUES ($1, current_date) ON CONFLICT DO NOTHING RETURNING user_id', [userId]);
    if (!claim.rowCount) continue;
    const overdue = d.tasks.filter((t) => String(t.due_date.toISOString ? t.due_date.toISOString() : t.due_date).slice(0, 10) < today());
    const li = (t) => `<li style="margin:6px 0"><b>${escH(t.title)}</b> <span style="color:#777">${escH(t.lead_name || t.customer_name || '')}</span></li>`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:540px"><p>Hello ${escH(d.name)},</p><p>You have <b>${d.tasks.length}</b> follow-up${d.tasks.length === 1 ? '' : 's'} to do${overdue.length ? ` (${overdue.length} overdue)` : ''}:</p><ul>${d.tasks.slice(0, 15).map(li).join('')}</ul><p><a href="${escH(base)}/tool/followups.html" style="display:inline-block;background:#0d9467;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Open my follow-ups</a></p></div>`;
    const res = await mail.send({ to: d.email, subject: `${d.tasks.length} follow-up${d.tasks.length === 1 ? '' : 's'} due today`, html });
    if (res.ok) sent++; else await db.query('DELETE FROM digest_log WHERE user_id = $1 AND day = current_date', [userId]);
  }
  return sent;
}
// Proposals that are about to expire without an answer: remind the person who sent them, once
async function sendExpiryNotices(dryRun) {
  if (!dryRun && !mail.configured()) return 0;
  const { rows } = await db.query(
    `SELECT p.id, p.ref_no, p.client->>'name' AS customer, p.created_by, p.created_at, coalesce((p.selections->>'validityDays')::int, 30) AS validity
       FROM proposals p WHERE p.status IN ('sent', 'viewed', 'negotiating')
        AND p.created_at + (coalesce((p.selections->>'validityDays')::int, 30) || ' days')::interval BETWEEN now() AND now() + interval '3 days'
        AND NOT EXISTS (SELECT 1 FROM proposal_events e WHERE e.proposal_id = p.id AND e.type = 'expiry_notice')`);
  if (dryRun) return rows;
  const base = (process.env.APP_BASE_URL || 'http://localhost:4400').replace(/\/+$/, '');
  let n = 0;
  for (const p of rows) {
    await db.query(`INSERT INTO proposal_events (proposal_id, type, note) VALUES ($1, 'expiry_notice', 'Reminder: the proposal expires within 3 days')`, [p.id]);
    const u = (await db.query('SELECT email FROM app_users WHERE id = $1 AND active AND email IS NOT NULL', [p.created_by])).rows[0];
    if (!u) continue;
    const res = await mail.send({ to: u.email, subject: `Proposal ${p.ref_no} expires soon`, html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:520px"><p>Proposal <b>${escH(p.ref_no)}</b> for <b>${escH(p.customer)}</b> expires within 3 days and has not been accepted. A call now could close it.</p><p><a href="${escH(base)}/tool/proposal.html?open=${p.id}" style="display:inline-block;background:#0d9467;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Open the proposal</a></p></div>` });
    if (res.ok) n++;
  }
  return n;
}

function startReminders() {
  const hour = parseInt(process.env.REMINDER_HOUR_UTC || '2', 10); // 02:00 UTC is 07:30 in Sri Lanka
  const run = () => { if (new Date().getUTCHours() >= hour) { sendDigests().catch((e) => console.error('reminders failed:', e.message)); sendExpiryNotices().catch((e) => console.error('expiry notices failed:', e.message)); } };
  setInterval(run, 15 * 60 * 1000).unref();
  setTimeout(run, 60 * 1000).unref();
}

module.exports = r;
module.exports.syncLeadFromProposal = syncLeadFromProposal;
module.exports.backfillLeadsFromProposals = backfillLeadsFromProposals;
module.exports.ensureLeadForProposal = ensureLeadForProposal;
module.exports.dueByUser = dueByUser;
module.exports.sendExpiryNotices = sendExpiryNotices;
module.exports.startReminders = startReminders;
module.exports.nameKey = nameKey;
module.exports.findConflicts = findConflicts;

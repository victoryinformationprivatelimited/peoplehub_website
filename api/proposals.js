const express = require('express');
const db = require('./db');
const A = require('./auth');
const customers = require('./customers');
const mail = require('./email');
const kit = require('./emailkit');
const delivery = require('./delivery');
const prices = require('./prices');
const log = require('./logger');
const pdf = require('./pdf');
const tracking = require('./tracking');
const crm = require('./crm');
const deals = require('./deals');
const approvals = require('./approvals');
const audit = require('./audit');
const sections = require('./sections');
const { readInput, compute, effectiveDiscount } = require('./quote');

const r = express.Router();
const ANY = A.requireRole('admin', 'staff', 'partner');
const bad = (res, msg, extra) => res.status(400).json({ error: msg, ...(extra || {}) });
const STATUSES = ['draft', 'sent', 'viewed', 'negotiating', 'accepted', 'lost', 'superseded'];
// Which manual moves are allowed from each stage (viewed is set by the system when the client opens the proposal)
const NEXT = { draft: ['sent'], sent: ['negotiating', 'accepted', 'lost'], viewed: ['negotiating', 'accepted', 'lost'], negotiating: ['sent', 'accepted', 'lost'], accepted: ['negotiating'], lost: ['negotiating'], superseded: [] };
async function logEvent(client, proposalId, type, userId, extra) {
  const e = extra || {};
  await client.query('INSERT INTO proposal_events (proposal_id, type, from_status, to_status, note, user_id) VALUES ($1,$2,$3,$4,$5,$6)', [proposalId, type, e.from || null, e.to || null, e.note || null, userId || null]);
}

async function currentList() {
  const { rows } = await db.query('SELECT id, data FROM price_lists WHERE is_current');
  return rows[0] || null;
}

// What the wizard needs to draw its choices: names and structure only, never prices.
r.get('/quote/catalog', ANY, async (req, res) => {
  const pl = await currentList();
  if (!pl) return res.status(409).json({ error: 'No price list has been published yet' });
  const d = pl.data;
  res.json({
    priceListId: pl.id,
    coreFeatures: d.core || [],
    items: d.items.filter((i) => i.group !== 'core').map((i) => ({ id: i.id, name: i.name, group: i.group, includes: i.includes || '' })),
    groups: d.groups.filter((g) => !g.mandatory),
    bands: d.bands.map((b, i) => ({ label: b.label, min: b.min, max: b.max, seatsIncluded: d.seats[i] })),
    storage: { freeMBPerEmployee: d.storage.freeMBPerEmployee, blockGB: d.storage.blockGB },
    maxDiscountPct: req.user.role === 'partner' ? Number(req.user.max_discount_pct) : 100,
    partnerCategory: req.user.role === 'partner' ? req.user.category_name : null,
  });
});

// Price a quote without saving it. Partners cannot exceed their category's maximum discount.
function priced(req, list, raw, capNow) {
  const read = readInput(list, raw);
  if (read.error) return { error: read.error };
  const cap = capNow !== undefined ? capNow : (req.user.role === 'partner' ? Number(req.user.max_discount_pct) : 100);
  const eff = effectiveDiscount(read.input.discounts);
  if (eff > cap + 1e-9) return { error: `Your ${req.user.category_name || 'category'} allows a maximum discount of ${cap}% (you entered ${eff}%). Save the proposal, then ask Victory to approve a higher discount.`, cap };
  return { input: read.input, quote: compute(list, read.input), cap };
}

r.post('/quote', ANY, async (req, res) => {
  const pl = await currentList();
  if (!pl) return res.status(409).json({ error: 'No price list has been published yet' });
  const p = priced(req, pl.data, req.body, await approvals.discountCap(req.user, parseInt(req.body.proposal_id, 10) || 0));
  if (p.error) return bad(res, p.error, { maxDiscountPct: p.cap });
  res.json({ quote: p.quote, maxDiscountPct: p.cap });
});

// ---------------- proposals ----------------
function visible(user, alias) {
  return user.role === 'partner' ? { sql: ` AND ${alias}.partner_id = $1`, params: [user.partner_id] } : { sql: '', params: [] };
}

const SELECT = `SELECT p.id, p.ref_no, p.status, p.created_at, p.updated_at, p.customer_id, p.contact_id, p.partner_id, p.discount_pct,
                       p.client, p.selections, p.totals, p.doc, p.price_list_id, p.version, p.parent_id, p.lost_reason, p.status_changed_at, pa.company_name AS partner_name, u.username AS created_by_name`;
const FROM = ' FROM proposals p LEFT JOIN partners pa ON pa.id = p.partner_id JOIN app_users u ON u.id = p.created_by';

r.get('/proposals', ANY, async (req, res) => {
  const v = visible(req.user, 'p');
  const { rows } = await db.query(
    `SELECT p.id, p.ref_no, (p.selections->>'incomplete') = 'true' AS incomplete, p.status, p.version, p.parent_id, p.created_at, p.updated_at, p.status_changed_at, p.discount_pct, p.lost_reason, u.username AS created_by_name, p.client->>'name' AS customer_name, p.totals->>'monthlyRecurring' AS monthly, (p.totals->>'implementationLow') = 'true' AS impl_low, p.totals->>'dueAtSigning' AS due_at_signing, pa.company_name AS partner_name
       ${FROM} WHERE TRUE${v.sql} ORDER BY p.created_at DESC LIMIT 300`, v.params);
  res.json(req.user.role === 'partner' ? rows.map((x) => ({ ...x, impl_low: false })) : rows);
});

r.get('/proposals/draft-count', ANY, async (req, res) => {
  const v = visible(req.user, 'p');
  const { rows } = await db.query(`SELECT count(*)::int AS drafts, count(*) FILTER (WHERE (p.selections->>'incomplete') = 'true')::int AS incomplete FROM proposals p WHERE p.status = 'draft'${v.sql}`, v.params);
  res.json(rows[0]);
});

r.get('/proposals/:id', ANY, async (req, res) => {
  const v = visible(req.user, 'p');
  const { rows } = await db.query(`${SELECT}${FROM} WHERE p.id = $${v.params.length + 1}${v.sql}`, [...v.params, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Proposal not found' });
  const acc = await db.query('SELECT signer_name, signer_title, proposal_hash, accepted_at FROM proposal_acceptances WHERE proposal_id = $1', [rows[0].id]);
  const logo = rows[0].partner_id ? (await db.query('SELECT logo FROM partners WHERE id = $1', [rows[0].partner_id])).rows[0] : null;
  res.json({ ...rows[0], totals: await prices.withModulePrices(rows[0].totals, rows[0].selections, rows[0].price_list_id), acceptance: acc.rows[0] || null, partner_logo: logo ? logo.logo : null });
});

// Shared by create and update: validate the customer and contact, price the quote, and build what gets stored.
async function build(req, proposalId) {
  const pl = await currentList();
  if (!pl) return { status: 409, error: 'No price list has been published yet' };
  const cust = await customers.loadCustomer(req.user, parseInt(req.body.customer_id, 10));
  if (!cust) return { status: 400, error: 'Choose a customer' };
  let contact = null;
  if (req.body.contact_id) {
    const { rows } = await db.query('SELECT * FROM customer_contacts WHERE id = $1 AND customer_id = $2', [parseInt(req.body.contact_id, 10), cust.id]);
    contact = rows[0] || null;
    if (!contact) return { status: 400, error: 'That contact does not belong to this customer' };
  }
  const cap = await approvals.discountCap(req.user, proposalId || 0);
  let p = priced(req, pl.data, req.body.input, cap);
  let incomplete = false;
  if (p.error && req.body.draft === true && req.body.input && typeof req.body.input === 'object') {
    // "Save draft": keep what has been entered so far. It is priced as a placeholder only and can never be sent or exported.
    const raw = req.body.input;
    const tmp = priced(req, pl.data, { ...raw, employees: Number(raw.employees) >= 1 ? raw.employees : 1, discounts: [] }, cap);
    if (!tmp.error) { p = { ...tmp, input: { ...tmp.input, employees: raw.employees === '' || raw.employees == null ? '' : raw.employees, discounts: Array.isArray(raw.discounts) ? raw.discounts.slice(0, 8) : [], incomplete: true } }; incomplete = true; }
  }
  if (p.error) return { status: 400, error: p.error, extra: { maxDiscountPct: p.cap } };
  if (p.quote.custom && !incomplete) return { status: 400, error: 'This company size needs a custom quote — please contact Victory Information.' };
  const client = {
    name: cust.name, logo: cust.logo || null, industry: cust.industry, address: cust.address, sites: cust.sites, current_system: cust.current_system, website: cust.website,
    contact: contact ? { name: contact.name, title: contact.title, email: contact.email, phone: contact.phone, role: contact.role } : null,
  };
  return { ok: true, incomplete, priceListId: pl.id, cust, contact, input: p.input, quote: p.quote, client, partnerId: req.user.role === 'partner' ? req.user.partner_id : cust.partner_id };
}

async function nextRef(client) {
  const year = new Date().getFullYear();
  const { rows } = await client.query('INSERT INTO proposal_counters (year, last) VALUES ($1, 1) ON CONFLICT (year) DO UPDATE SET last = proposal_counters.last + 1 RETURNING last', [year]);
  return `VI-PH-${year}-${String(rows[0].last).padStart(4, '0')}`;
}

r.post('/proposals', ANY, async (req, res) => {
  const b = await build(req);
  if (!b.ok) return res.status(b.status).json({ error: b.error, ...(b.extra || {}) });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const ref = await nextRef(client);
    const { rows } = await client.query(
      `INSERT INTO proposals (ref_no, created_by, partner_id, price_list_id, client, selections, customisations, discount_pct, totals, customer_id, contact_id, doc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, ref_no`,
      [ref, req.user.id, b.partnerId, b.priceListId, b.client, b.input, JSON.stringify(b.input.customisations), b.quote.discountPct, b.quote, b.cust.id, b.contact ? b.contact.id : null, await sections.buildDoc(b.partnerId, b.input)]);
    await logEvent(client, rows[0].id, 'created', req.user.id, {});
    await client.query('COMMIT');
    res.status(201).json({ ...rows[0], incomplete: b.incomplete });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

// Only drafts can be re-priced and edited; once sent, accepted or lost a proposal is frozen.
r.put('/proposals/:id', ANY, async (req, res) => {
  const v = visible(req.user, 'p');
  const { rows: cur } = await db.query(`SELECT p.id, p.status FROM proposals p WHERE p.id = $${v.params.length + 1}${v.sql}`, [...v.params, req.params.id]);
  if (!cur[0]) return res.status(404).json({ error: 'Proposal not found' });
  if (cur[0].status !== 'draft') return bad(res, 'Only a draft proposal can be edited');
  const b = await build(req, cur[0].id);
  if (!b.ok) return res.status(b.status).json({ error: b.error, ...(b.extra || {}) });
  await db.query(
    `UPDATE proposals SET partner_id=$1, price_list_id=$2, client=$3, selections=$4, customisations=$5, discount_pct=$6, totals=$7, customer_id=$8, contact_id=$9, doc=$11, updated_at=now() WHERE id=$10`,
    [b.partnerId, b.priceListId, b.client, b.input, JSON.stringify(b.input.customisations), b.quote.discountPct, b.quote, b.cust.id, b.contact ? b.contact.id : null, cur[0].id, await sections.buildDoc(b.partnerId, b.input)]);
  res.json({ ok: true, incomplete: b.incomplete });
});

r.put('/proposals/:id/status', ANY, async (req, res) => {
  const to = req.body.status;
  if (!STATUSES.includes(to)) return bad(res, 'Unknown status');
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
  const v = visible(req.user, 'p');
  const { rows: cur } = await db.query(`SELECT p.id, p.status, p.customer_id, (p.selections->>'incomplete') = 'true' AS incomplete FROM proposals p WHERE p.id = $${v.params.length + 1}${v.sql}`, [...v.params, req.params.id]);
  if (!cur[0]) return res.status(404).json({ error: 'Proposal not found' });
  if (cur[0].incomplete && to !== 'draft') return bad(res, 'This draft is incomplete. Finish it and press Save proposal first.');
  const from = cur[0].status;
  if (!(NEXT[from] || []).includes(to)) return bad(res, `A proposal that is ${from} cannot be moved to ${to}`);
  if (to === 'lost' && reason.length < 3) return bad(res, 'Say why the proposal was lost');
  await db.query('UPDATE proposals SET status = $1, lost_reason = $2, status_changed_at = now(), updated_at = now() WHERE id = $3', [to, to === 'lost' ? reason : null, cur[0].id]);
  await logEvent(db, cur[0].id, 'status', req.user.id, { from, to, note: to === 'lost' ? reason : null });
  await crm.syncLeadFromProposal(cur[0].customer_id, to, reason, req.user.id);
  if (to === 'accepted') await deals.onAccepted(cur[0].id);
  if (from === 'accepted') await deals.onLeftAccepted(cur[0].id);
  res.json({ ok: true, status: to });
});

// A revision is a new draft copied from an existing proposal; the old version is marked superseded and kept for history.
r.post('/proposals/:id/revise', ANY, async (req, res) => {
  const v = visible(req.user, 'p');
  const { rows } = await db.query(`SELECT p.* FROM proposals p WHERE p.id = $${v.params.length + 1}${v.sql}`, [...v.params, req.params.id]);
  const src = rows[0];
  if (!src) return res.status(404).json({ error: 'Proposal not found' });
  if (src.status === 'draft') return bad(res, 'A draft can simply be edited');
  if (src.status === 'accepted') return bad(res, 'An accepted proposal cannot be revised');
  if (src.status === 'superseded') return bad(res, 'Revise the latest version of this proposal instead');
  const rootId = src.parent_id || src.id;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: fam } = await client.query('SELECT ref_no, version FROM proposals WHERE id = $1 OR parent_id = $1 ORDER BY version DESC', [rootId]);
    const { rows: root } = await client.query('SELECT ref_no FROM proposals WHERE id = $1', [rootId]);
    const version = fam[0].version + 1;
    const ref = `${root[0].ref_no}-v${version}`;
    const ins = await client.query(
      `INSERT INTO proposals (ref_no, created_by, partner_id, price_list_id, client, selections, customisations, discount_pct, totals, customer_id, contact_id, parent_id, version, doc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, ref_no, version`,
      [ref, req.user.id, src.partner_id, src.price_list_id, src.client, src.selections, JSON.stringify(src.customisations), src.discount_pct, src.totals, src.customer_id, src.contact_id, rootId, version, src.doc]);
    await client.query(`UPDATE proposals SET status = 'superseded', status_changed_at = now(), updated_at = now() WHERE id = $1`, [src.id]);
    await logEvent(client, src.id, 'status', req.user.id, { from: src.status, to: 'superseded', note: 'Replaced by ' + ref });
    await logEvent(client, ins.rows[0].id, 'created', req.user.id, { note: 'Revision ' + version + ' of ' + root[0].ref_no });
    await client.query('COMMIT');
    res.status(201).json(ins.rows[0]);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
});

r.get('/proposals/:id/versions', ANY, async (req, res) => {
  const v = visible(req.user, 'p');
  const { rows } = await db.query(`SELECT p.id, p.parent_id FROM proposals p WHERE p.id = $${v.params.length + 1}${v.sql}`, [...v.params, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Proposal not found' });
  const rootId = rows[0].parent_id || rows[0].id;
  const out = await db.query(
    `SELECT p.id, p.ref_no, p.version, p.status, p.created_at, p.totals->>'monthlyRecurring' AS monthly, p.totals->>'dueAtSigning' AS due_at_signing
       FROM proposals p WHERE (p.id = $1 OR p.parent_id = $1) ORDER BY p.version`, [rootId]);
  res.json(out.rows);
});

r.get('/proposals/:id/timeline', ANY, async (req, res) => {
  const v = visible(req.user, 'p');
  const { rows } = await db.query(
    `SELECT e.type, e.from_status, e.to_status, e.note, e.created_at, u.username AS by_user
       FROM proposal_events e JOIN proposals p ON p.id = e.proposal_id LEFT JOIN app_users u ON u.id = e.user_id
      WHERE e.proposal_id = $${v.params.length + 1}${v.sql} ORDER BY e.created_at, e.id`, [...v.params, req.params.id]);
  res.json(rows);
});

// ---- Email a proposal ----
const escH = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const HOURLY_LIMIT = 10;

r.post('/proposals/:id/send', ANY, async (req, res) => {
  if (!mail.configured()) return res.status(503).json({ error: 'Email is not set up on the server yet' });
  const split = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).map((x) => String(x).trim()).filter(Boolean);
  const toList = split(req.body.to), ccList = split(req.body.cc).filter((x) => !toList.map((y) => y.toLowerCase()).includes(x.toLowerCase()));
  const recipients = [...toList.map((a) => ({ a, role: 'to' })), ...ccList.map((a) => ({ a, role: 'cc' }))].filter((x, i, arr) => arr.findIndex((y) => y.a.toLowerCase() === x.a.toLowerCase()) === i);
  const subject = String(req.body.subject || '').trim().slice(0, 200);
  const message = String(req.body.message || '').trim().slice(0, 6000);
  if (!toList.length) return bad(res, 'Enter a recipient email address');
  if (recipients.length > 8) return bad(res, 'A single send can go to at most 8 addresses');
  const badAddr = recipients.find((x) => !EMAIL_RE.test(x.a) || x.a.length > 200);
  if (badAddr) return bad(res, '"' + badAddr.a.slice(0, 60) + '" is not a valid email address');
  if (!subject) return bad(res, 'Enter a subject');
  if (!message) return bad(res, 'Enter a message');
  const v = visible(req.user, 'p');
  const { rows } = await db.query(`${SELECT}${FROM} WHERE p.id = $${v.params.length + 1}${v.sql}`, [...v.params, req.params.id]);
  const p = rows[0];
  if (!p) return res.status(404).json({ error: 'Proposal not found' });
  if (p.selections && p.selections.incomplete) return bad(res, 'This draft is incomplete. Finish it and press Save proposal before sending.');
  if (p.status === 'lost') return bad(res, 'A lost proposal cannot be emailed');
  if (p.status === 'superseded') return bad(res, 'This version was replaced by a newer revision; send the latest one');
  if (p.status === 'accepted') return bad(res, 'This proposal is already accepted');
  const { rows: cnt } = await db.query(`SELECT count(*)::int AS n FROM email_log WHERE sent_by = $1 AND created_at > now() - interval '1 hour'`, [req.user.id]);
  if (cnt[0].n + recipients.length > HOURLY_LIMIT * 2) return res.status(429).json({ error: `Sending limit reached (${HOURLY_LIMIT * 2} emails per hour). Try again later.` });
  let replyTo = null;
  if (req.user.role === 'partner') {
    const pr = await db.query('SELECT email FROM partners WHERE id = $1', [req.user.partner_id]);
    if (pr.rows[0] && pr.rows[0].email && EMAIL_RE.test(pr.rows[0].email)) replyTo = pr.rows[0].email;
  } else if (req.user.email && EMAIL_RE.test(req.user.email)) replyTo = req.user.email; // replies reach the person who sent it
  const senderName = req.user.role === 'partner' ? req.user.company_name : req.user.username;
  const o = req.body.options || {};
  const opts = { includeSummary: o.includeSummary !== false, includeLink: o.includeLink !== false, pdfAttached: o.attachPdf === true };
  let attachments = [];
  log.info('email.request', { ref: p.ref_no, by: req.user.username, to: recipients.map((x) => x.a).join(','), pdf: opts.pdfAttached, link: opts.includeLink, summary: opts.includeSummary, status: p.status });
  if (opts.pdfAttached) {
    const tp = Date.now();
    try {
      const pdfBuf = await pdf.render(req.user.id, p.id);
      attachments = [{ filename: p.ref_no + '.pdf', content: pdfBuf, contentType: 'application/pdf' }];
      log.info('email.pdf_ready', { ref: p.ref_no, ms: Date.now() - tp, bytes: pdfBuf.length });
    } catch (e) {
      log.error('email.pdf_failed', { ref: p.ref_no, ms: Date.now() - tp, error: e.message });
      return res.status(424).json({ error: 'Could not create the proposal PDF, so the email was not sent. Untick the PDF attachment to send without it.' });
    }
  }
  const ids = (Array.isArray(req.body.attachmentIds) ? req.body.attachmentIds : []).map((x) => parseInt(x, 10)).filter(Number.isInteger).slice(0, 5);
  if (ids.length) {
    const { rows: files } = await db.query('SELECT id, name, mime, data FROM email_attachments WHERE proposal_id = $1 AND id = ANY($2) ORDER BY id', [p.id, ids]);
    files.forEach((f) => attachments.push({ filename: f.name, content: f.data, contentType: f.mime }));
  }

  const resend = p.status !== 'draft';
  const results = [];
  for (const rc of recipients) {
    // each person gets their own link, so we can tell who opened it or downloaded the PDF
    const link = opts.includeLink ? (await tracking.ensureLink(p.id, req.user.id, rc.a)).url : null;
    const html = kit.build(p, message, senderName, link, opts);
    const result = await mail.send({ to: rc.a, subject, html, replyTo, attachments });
    await db.query('INSERT INTO email_log (proposal_id, sent_by, to_email, subject, ok, error, role, resend, detail, duration_ms, attachments) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [p.id, req.user.id, rc.a, subject, result.ok, result.ok ? null : result.error, rc.role, resend, result.ok ? ('answered ' + result.status) : (result.detail ? String(result.detail).slice(0, 500) : null), result.ms || null, attachments.length]);
    results.push({ to: rc.a, role: rc.role, ok: result.ok, error: result.ok ? null : result.error });
  }
  const okList = results.filter((x) => x.ok);
  log.info('email.done', { ref: p.ref_no, by: req.user.username, sent: okList.length, failed: results.length - okList.length });
  if (!okList.length) return res.status(424).json({ error: results[0].error + (results[0].detail ? ' - ' + results[0].detail : ''), results });
  await logEvent(db, p.id, 'emailed', req.user.id, { note: (resend ? 'Resent to ' : '') + okList.map((x) => x.to).join(', ') });
  if (p.status === 'draft') { await db.query(`UPDATE proposals SET status = 'sent', status_changed_at = now(), updated_at = now() WHERE id = $1`, [p.id]); await logEvent(db, p.id, 'status', req.user.id, { from: 'draft', to: 'sent' }); }
  await crm.syncLeadFromProposal(p.customer_id, 'sent', '', req.user.id);
  res.json({ ok: true, status: p.status === 'draft' ? 'sent' : p.status, results });
});

async function ownProposal(req) {
  const v = visible(req.user, 'p');
  const { rows } = await db.query(`${SELECT}${FROM} WHERE p.id = $${v.params.length + 1}${v.sql}`, [...v.params, req.params.id]);
  return rows[0] || null;
}

// Extra files to send with the email (price schedules, brochures, a signed NDA...)
r.get('/proposals/:id/attachments', ANY, async (req, res) => {
  const p = await ownProposal(req); if (!p) return res.status(404).json({ error: 'Proposal not found' });
  const { rows } = await db.query('SELECT id, name, size FROM email_attachments WHERE proposal_id = $1 ORDER BY id', [p.id]);
  res.json(rows);
});
r.post('/proposals/:id/attachments', ANY, async (req, res) => {
  const p = await ownProposal(req); if (!p) return res.status(404).json({ error: 'Proposal not found' });
  const name = String(req.body.name || '').replace(/[^\w .()-]/g, '').trim().slice(0, 100);
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!name || !kit.ALLOWED_EXT[ext]) return bad(res, 'Attach a PDF, Word, Excel, PowerPoint, image, CSV or text file');
  const m = /^(?:data:[^;]+;base64,)?([A-Za-z0-9+/=]+)$/.exec(String(req.body.data || ''));
  if (!m) return bad(res, 'That file could not be read');
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length) return bad(res, 'The file is empty');
  if (buf.length > 5 * 1024 * 1024) return bad(res, 'Each file can be at most 5 MB');
  const { rows: ex } = await db.query('SELECT count(*)::int AS n, coalesce(sum(size),0)::int AS total FROM email_attachments WHERE proposal_id = $1', [p.id]);
  if (ex[0].n >= 5) return bad(res, 'You can attach at most 5 extra files');
  if (ex[0].total + buf.length > 12 * 1024 * 1024) return bad(res, 'The attachments are over 12 MB in total');
  const ins = await db.query('INSERT INTO email_attachments (proposal_id, uploaded_by, name, mime, size, data) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [p.id, req.user.id, name, kit.ALLOWED_EXT[ext], buf.length, buf]);
  res.status(201).json({ id: ins.rows[0].id, name, size: buf.length });
});
r.delete('/proposals/:id/attachments/:aid', ANY, async (req, res) => {
  const p = await ownProposal(req); if (!p) return res.status(404).json({ error: 'Proposal not found' });
  await db.query('DELETE FROM email_attachments WHERE id = $1 AND proposal_id = $2', [parseInt(req.params.aid, 10) || 0, p.id]);
  res.json({ ok: true });
});
// What the client will see, before sending
r.post('/proposals/:id/email-preview', ANY, async (req, res) => {
  const p = await ownProposal(req); if (!p) return res.status(404).json({ error: 'Proposal not found' });
  const o = req.body.options || {};
  const link = o.includeLink !== false ? (await tracking.ensureLink(p.id, req.user.id)).url : null;
  const senderName = req.user.role === 'partner' ? req.user.company_name : req.user.username;
  res.json({ html: kit.build(p, String(req.body.message || '').slice(0, 6000), senderName, link, { includeSummary: o.includeSummary !== false, includeLink: o.includeLink !== false, pdfAttached: o.attachPdf === true }) });
});

r.get('/proposals/:id/pdf', ANY, async (req, res) => {
  const v = visible(req.user, 'p');
  const { rows } = await db.query(`SELECT p.id, p.ref_no, (p.selections->>'incomplete') = 'true' AS incomplete FROM proposals p WHERE p.id = $${v.params.length + 1}${v.sql}`, [...v.params, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Proposal not found' });
  if (rows[0].incomplete) return bad(res, 'This draft is incomplete. Finish it and press Save proposal before creating the PDF.');
  try {
    const buf = await pdf.render(req.user.id, rows[0].id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${rows[0].ref_no}.pdf"`, 'Cache-Control': 'no-store' });
    res.send(buf);
  } catch (e) {
    log.error('pdf.export_failed', { ref: rows[0].ref_no, error: e.message });
    res.status(424).json({ error: 'Could not create the PDF' });
  }
});

r.get('/proposals/:id/emails', ANY, async (req, res) => {
  const v = visible(req.user, 'p');
  const { rows: logs } = await db.query(
    `SELECT e.to_email, e.subject, e.ok, e.error, e.role, e.resend, e.created_at FROM email_log e JOIN proposals p ON p.id = e.proposal_id
      WHERE e.proposal_id = $${v.params.length + 1}${v.sql} ORDER BY e.created_at DESC LIMIT 60`, [...v.params, req.params.id]);
  // when each person opened their own link (or, for older emails with the shared link, when anyone did)
  const { rows: per } = await db.query(
    `SELECT lower(l.recipient) AS who, v.created_at FROM proposal_views v JOIN proposal_links l ON l.id = v.link_id
      WHERE v.proposal_id = $1 AND NOT v.is_bot AND NOT v.internal AND v.type IN ('open','pdf') ORDER BY v.created_at`, [req.params.id]);
  const hasPersonal = per.some((x) => x.who);
  const people = new Set(logs.filter((l) => l.ok).map((l) => String(l.to_email).toLowerCase()));
  const canAttribute = hasPersonal || people.size <= 1; // with several recipients on a shared link nobody can tell who opened it
  const rows = (await delivery.attach(logs)).map((e) => {
    const at = e.ok && canAttribute ? (per.find((x) => (hasPersonal ? x.who === String(e.to_email).toLowerCase() : true) && new Date(x.created_at) >= new Date(e.created_at)) || {}).created_at : null;
    return { ...e, opened: !!at, opened_at: at || null };
  });
  res.json(rows);
});

module.exports = r;

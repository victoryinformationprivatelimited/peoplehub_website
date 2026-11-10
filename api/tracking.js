// Client web view of a proposal: private links, what the client does on the page, analytics and the interest score.
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const A = require('./auth');
const mail = require('./email');
const { interest } = require('./scoring');
const pdf = require('./pdf');
const deals = require('./deals');
const crm = require('./crm');
const audit = require('./audit');

const ANY = A.requireRole('admin', 'staff', 'partner');
const BASE = () => (process.env.APP_BASE_URL || 'http://localhost:4400').replace(/\/+$/, '');
const TYPES = ['open', 'engaged', 'heartbeat', 'section', 'pdf', 'cta'];
const SECTIONS = ['cover', 'summary', 'scope', 'custom', 'invest', 'terms'];
// Link scanners, previewers and crawlers that open links in emails and chat apps. Their visits must not count as the client reading.
const BOT_RE = /bot|crawl|spider|slurp|preview|scan|fetch|monitor|headless|python|curl|wget|java\/|go-http|okhttp|libwww|axios|node-fetch|safelinks|proofpoint|mimecast|barracuda|symantec|trend ?micro|forcepoint|skyhigh|zscaler|urlscan|googleimageproxy|facebookexternalhit|whatsapp\/|slack|telegram|discord|linkedinbot|outlook-?meta|ms ?office|microsoft office/i;

const sms = require('./sms');
const delivery = require('./delivery');
const prices = require('./prices');
const whatsapp = require('./whatsapp');
const push = require('./push');
const escH = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ipHash = (ip) => crypto.createHash('sha256').update(String(ip || '') + (process.env.SESSION_SECRET || '')).digest('hex').slice(0, 16);
const deviceOf = (ua) => (/mobile|android|iphone|ipad/i.test(ua || '') ? 'mobile' : 'desktop');

function visible(user, alias) {
  return user.role === 'partner' ? { sql: ` AND ${alias}.partner_id = $1`, params: [user.partner_id] } : { sql: '', params: [] };
}

// ---------- shared helpers ----------
// recipient = an email address gets that person their own link; none = the shared link
async function ensureLink(proposalId, userId, recipient) {
  const who = recipient ? String(recipient).trim().toLowerCase().slice(0, 200) : null;
  const { rows } = await db.query(
    `SELECT token, expires_at FROM proposal_links WHERE proposal_id = $1 AND revoked_at IS NULL AND expires_at > now() AND (CASE WHEN $2::text IS NULL THEN recipient IS NULL ELSE lower(recipient) = $2 END) ORDER BY id DESC LIMIT 1`, [proposalId, who]);
  if (rows[0]) return { token: rows[0].token, expiresAt: rows[0].expires_at, url: `${BASE()}/p/${rows[0].token}` };
  const { rows: pr } = await db.query(`SELECT selections->>'validityDays' AS v FROM proposals WHERE id = $1`, [proposalId]);
  const validity = Math.max(1, parseInt(pr[0] && pr[0].v, 10) || 30);
  const token = crypto.randomBytes(32).toString('hex');
  const ins = await db.query(
    `INSERT INTO proposal_links (proposal_id, token, created_by, expires_at, recipient) VALUES ($1,$2,$3, now() + ($4 || ' days')::interval + interval '14 days', $5) RETURNING expires_at`,
    [proposalId, token, userId || null, String(validity), who]);
  return { token, expiresAt: ins.rows[0].expires_at, url: `${BASE()}/p/${token}` };
}

// Engagement figures per proposal, with scanners, previewers and our own staff taken out
async function statsFor(ids) {
  if (!ids.length) return {};
  const { rows } = await db.query(
    `SELECT proposal_id,
            count(*) FILTER (WHERE type = 'open')::int AS visits,
            count(DISTINCT sid) FILTER (WHERE type = 'engaged')::int AS visitors,
            count(DISTINCT date_trunc('day', created_at)) FILTER (WHERE type = 'engaged')::int AS days,
            (coalesce(sum(ms) FILTER (WHERE type = 'heartbeat'), 0) / 1000)::int AS seconds,
            count(*) FILTER (WHERE type = 'pdf')::int AS pdfs,
            count(*) FILTER (WHERE type = 'cta')::int AS ctas,
            max(created_at) FILTER (WHERE type IN ('open', 'engaged', 'heartbeat')) AS last_view,
            min(created_at) FILTER (WHERE type = 'engaged') AS first_view,
            array_remove(array_agg(DISTINCT section) FILTER (WHERE type = 'section'), NULL) AS sections,
            count(DISTINCT device) FILTER (WHERE type = 'engaged')::int AS devices
       FROM proposal_views WHERE proposal_id = ANY($1::int[]) AND NOT is_bot AND NOT internal GROUP BY proposal_id`, [ids]);
  const out = {};
  rows.forEach((r) => { out[r.proposal_id] = { ...r, sections: r.sections || [] }; });
  return out;
}
async function sentAtFor(ids) {
  if (!ids.length) return {};
  const { rows } = await db.query(
    `SELECT proposal_id, min(created_at) AS at FROM proposal_events WHERE proposal_id = ANY($1::int[]) AND (type = 'emailed' OR (type = 'status' AND to_status = 'sent')) GROUP BY proposal_id`, [ids]);
  const out = {}; rows.forEach((r) => { out[r.proposal_id] = r.at; }); return out;
}

// ---------- staff routes ----------
const staff = express.Router();

staff.post('/proposals/:id/link', ANY, async (req, res) => {
  const v = visible(req.user, 'p');
  const { rows } = await db.query(`SELECT p.id, p.status FROM proposals p WHERE p.id = $${v.params.length + 1}${v.sql}`, [...v.params, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Proposal not found' });
  if (rows[0].status === 'draft') return res.status(400).json({ error: 'Save and send the proposal first' });
  res.json(await ensureLink(rows[0].id, req.user.id));
});

staff.get('/proposals/:id/analytics', ANY, async (req, res) => {
  const v = visible(req.user, 'p');
  const { rows } = await db.query(`SELECT p.id, p.status, p.discount_pct FROM proposals p WHERE p.id = $${v.params.length + 1}${v.sql}`, [...v.params, req.params.id]);
  const p = rows[0];
  if (!p) return res.status(404).json({ error: 'Proposal not found' });
  const stats = (await statsFor([p.id]))[p.id] || { visits: 0, visitors: 0, days: 0, seconds: 0, pdfs: 0, ctas: 0, sections: [], devices: 0, last_view: null, first_view: null };
  const sentAt = (await sentAtFor([p.id]))[p.id] || null;
  const { rows: link } = await db.query(`SELECT token, expires_at FROM proposal_links WHERE proposal_id = $1 AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`, [p.id]);
  const { rows: filtered } = await db.query(`SELECT count(*)::int AS n FROM proposal_views WHERE proposal_id = $1 AND type = 'open' AND is_bot`, [p.id]);
  const { rows: internalOpens } = await db.query(`SELECT count(DISTINCT sid)::int AS n FROM proposal_views WHERE proposal_id = $1 AND type = 'open' AND internal AND NOT is_bot`, [p.id]);
  const { rows: recent } = await db.query(
    `SELECT v.type, v.section, v.device, v.note, v.created_at, l.recipient FROM proposal_views v LEFT JOIN proposal_links l ON l.id = v.link_id
      WHERE v.proposal_id = $1 AND NOT v.is_bot AND NOT v.internal AND v.type IN ('engaged', 'pdf', 'cta') ORDER BY v.created_at DESC LIMIT 25`, [p.id]);
  // Who did what: one row per recipient (their own link), plus the shared link
  const { rows: per } = await db.query(
    `SELECT lower(l.recipient) AS who,
            count(*) FILTER (WHERE v.type = 'open')::int AS visits,
            (coalesce(sum(v.ms) FILTER (WHERE v.type = 'heartbeat'), 0) / 1000)::int AS seconds,
            count(*) FILTER (WHERE v.type = 'pdf')::int AS pdfs,
            count(*) FILTER (WHERE v.type = 'cta')::int AS ctas,
            min(v.created_at) FILTER (WHERE v.type IN ('open', 'engaged')) AS first_view,
            max(v.created_at) FILTER (WHERE v.type IN ('open', 'engaged', 'heartbeat')) AS last_view,
            array_remove(array_agg(DISTINCT v.section) FILTER (WHERE v.type = 'section'), NULL) AS sections
       FROM proposal_views v JOIN proposal_links l ON l.id = v.link_id
      WHERE v.proposal_id = $1 AND NOT v.is_bot AND NOT v.internal GROUP BY lower(l.recipient)`, [p.id]);
  // what the mail service saw: delivered, bounced, email opened, link clicked
  const { rows: logs } = await db.query(`SELECT to_email, subject, ok, created_at FROM email_log WHERE proposal_id = $1 ORDER BY created_at`, [p.id]);
  const withDelivery = await delivery.attach(logs);
  const byWho = new Map(), mailEvents = [];
  withDelivery.forEach((m) => {
    const k = String(m.to_email).toLowerCase(), prev = byWho.get(k) || { who: k, sentAt: null, delivered: null, delivery: null, delivered_at: null, mail_opened_at: null, mail_clicked_at: null, visits: 0, seconds: 0, pdfs: 0, ctas: 0, first_view: null, last_view: null, sections: [] };
    const early = (a, b) => (a && b ? (new Date(a) < new Date(b) ? a : b) : a || b);
    byWho.set(k, { ...prev, sentAt: m.created_at, delivered: prev.delivered === true || m.ok, delivery: m.delivery === 'bounced' || prev.delivery === 'bounced' ? 'bounced' : (m.delivery !== 'unknown' ? m.delivery : prev.delivery), delivered_at: early(prev.delivered_at, m.delivered_at), mail_opened_at: early(prev.mail_opened_at, m.mail_opened_at), mail_clicked_at: early(prev.mail_clicked_at, m.mail_clicked_at) });
    (m.events || []).filter((e) => ['opened', 'clicked', 'bounced', 'complaint'].includes(e.type)).forEach((e) => mailEvents.push({ type: 'mail_' + e.type, section: null, device: null, note: null, created_at: e.at, recipient: k }));
  });
  per.forEach((x) => { const k = x.who || null; byWho.set(k, { ...(byWho.get(k) || { who: k, sentAt: null, delivered: null }), ...x, who: k, sections: x.sections || [] }); });
  const people = [...byWho.values()].filter((x) => x.who || x.visits || x.pdfs).sort((a, b) => (b.last_view ? +new Date(b.last_view) : 0) - (a.last_view ? +new Date(a.last_view) : 0) || String(a.who).localeCompare(String(b.who)));
  res.json({
    stats, sentAt, link: link[0] ? { url: `${BASE()}/p/${link[0].token}`, expiresAt: link[0].expires_at } : null,
    scannerOpensIgnored: filtered[0].n, internalOpens: internalOpens[0].n, recent: [...recent, ...mailEvents].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 25), people, emailOpens: people.filter((x) => x.mail_opened_at).length, interest: interest({ status: p.status, sentAt, stats }),
  });
});

// For the list page: engagement and score for many proposals at once
staff.get('/proposals-insights', ANY, async (req, res) => {
  const v = visible(req.user, 'p');
  const { rows } = await db.query(`SELECT p.id, p.status FROM proposals p WHERE p.status IN ('sent', 'viewed', 'negotiating', 'accepted', 'lost')${v.sql}`, v.params);
  const ids = rows.map((r) => r.id);
  const [stats, sent] = await Promise.all([statsFor(ids), sentAtFor(ids)]);
  const out = {};
  rows.forEach((r) => {
    const s = stats[r.id] || { visits: 0, visitors: 0, days: 0, seconds: 0, pdfs: 0, ctas: 0, sections: [], devices: 0 };
    out[r.id] = { views: s.visitors, visits: s.visits, seconds: s.seconds, lastView: s.last_view || null, interest: interest({ status: r.status, sentAt: sent[r.id] || null, stats: s }) };
  });
  res.json(out);
});

// ---------- public routes (no sign-in; the token is the key) ----------
const pub = express.Router();
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  return arr.length > max;
}

async function linkByToken(token) {
  if (!/^[0-9a-f]{64}$/.test(token || '')) return null;
  const { rows } = await db.query(
    `SELECT l.id AS link_id, l.expires_at, l.revoked_at, p.*
       FROM proposal_links l JOIN proposals p ON p.id = l.proposal_id WHERE l.token = $1`, [token]);
  return rows[0] || null;
}

pub.get('/public/proposal/:token', async (req, res) => {
  if (limited('get|' + req.ip, 120, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many requests' });
  const row = await linkByToken(req.params.token);
  if (!row) return res.status(404).json({ error: 'This link is not valid' });
  if (row.revoked_at || new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'This proposal link has expired. Please ask us for a new one.' });
  const { rows: pl } = await db.query('SELECT data FROM price_lists WHERE id = $1', [row.price_list_id]);
  const d = pl[0] ? pl[0].data : { items: [], core: [] };
  const chosen = new Set((row.selections && row.selections.items) || []);
  let newer = null;
  if (row.status === 'superseded') {
    const { rows: n } = await db.query(`SELECT 1 FROM proposals WHERE (parent_id = $1 OR id = $1) AND version > $2 LIMIT 1`, [row.parent_id || row.id, row.version]);
    newer = n.length > 0;
  }
  const { rows: acc } = await db.query('SELECT signer_name, signer_title, accepted_at, proposal_hash FROM proposal_acceptances WHERE proposal_id = $1', [row.id]);
  const { rows: pres } = row.partner_id ? await db.query('SELECT company_name, logo FROM partners WHERE id = $1', [row.partner_id]) : { rows: [] };
  const contact = row.client && row.client.contact ? { name: row.client.contact.name, title: row.client.contact.title, email: row.client.contact.email } : null;
  res.set('Cache-Control', 'no-store');
  res.json({
    ref: row.ref_no, version: row.version, createdAt: row.created_at, validity: (row.selections && row.selections.validityDays) || 30,
    replaced: !!newer, closed: row.status === 'lost', status: row.status,
    acceptance: acc[0] ? { name: acc[0].signer_name, title: acc[0].signer_title, at: acc[0].accepted_at, ref: acc[0].proposal_hash.slice(0, 12) } : null,
    presentedBy: pres[0] ? pres[0].company_name : '', logo: pres[0] ? pres[0].logo : null,
    quote: await prices.withModulePrices(row.totals, row.selections, row.price_list_id), input: row.selections, doc: row.doc,
    customer: { name: row.client.name, logo: row.client.logo || null, sites: row.client.sites, current_system: row.client.current_system }, contact,
    catalog: { coreFeatures: d.core || [], items: (d.items || []).filter((i) => chosen.has(i.id)).map((i) => ({ id: i.id, name: i.name, group: i.group, includes: i.includes || '' })) },
  });
});

// The client downloads the same PDF the staff see. Rendered as the person who created the proposal.
pub.get('/public/proposal/:token/pdf', async (req, res) => {
  if (limited('pdf|' + req.ip, 6, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many downloads. Please try again in a few minutes.' });
  const row = await linkByToken(req.params.token);
  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) return res.status(404).json({ error: 'This link is not valid' });
  let buf;
  try { buf = await pdf.render(row.created_by, row.id); } catch (e) { console.error('public PDF failed:', e.message); return res.status(502).json({ error: 'Could not create the PDF' }); }
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  await db.query('INSERT INTO proposal_views (proposal_id, link_id, sid, type, device, ua, ip_hash, is_bot, internal) VALUES ($1,$2,$3,\x27pdf\x27,$4,$5,$6,$7,$8)',
    [row.id, row.link_id, /^[a-z0-9]{8,40}$/i.test(req.query.sid || '') ? req.query.sid : 'unknown00', deviceOf(ua), ua, ipHash(req.ip), !ua || BOT_RE.test(ua), !!req.user]);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${row.ref_no}.pdf"`, 'Cache-Control': 'no-store' });
  res.send(buf);
});

// The client accepts the proposal online. This is a simple electronic acceptance: it records who, when and exactly what was accepted.
const proposalHash = (row) => crypto.createHash('sha256').update(JSON.stringify({ ref: row.ref_no, version: row.version, totals: row.totals, selections: row.selections, client: row.client && row.client.name })).digest('hex');

pub.post('/public/proposal/:token/accept', async (req, res) => {
  if (limited('acc|' + req.ip, 10, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  const row = await linkByToken(req.params.token);
  if (!row) return res.status(404).json({ error: 'This link is not valid' });
  if (row.revoked_at || new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'This proposal link has expired' });
  const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
  const title = typeof req.body.title === 'string' ? req.body.title.trim().slice(0, 120) : '';
  if (name.length < 3) return res.status(400).json({ error: 'Please type your full name' });
  if (req.body.confirm !== true) return res.status(400).json({ error: 'Please confirm that you are authorised to accept this proposal' });
  if (['lost', 'superseded', 'draft'].includes(row.status)) return res.status(409).json({ error: row.status === 'superseded' ? 'A newer version of this proposal has been issued. Please use the latest link.' : 'This proposal can no longer be accepted online. Please contact us.' });
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const hash = proposalHash(row);
  const ins = await db.query(
    `INSERT INTO proposal_acceptances (proposal_id, link_id, signer_name, signer_title, proposal_hash, ip_hash, ua) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (proposal_id) DO NOTHING RETURNING accepted_at`,
    [row.id, row.link_id, name, title || null, hash, ipHash(req.ip), ua]);
  if (!ins.rows[0]) return res.status(409).json({ error: 'This proposal has already been accepted.' });
  const from = row.status;
  await db.query(`UPDATE proposals SET status = 'accepted', status_changed_at = now(), updated_at = now() WHERE id = $1`, [row.id]);
  await db.query(`INSERT INTO proposal_events (proposal_id, type, from_status, to_status, note) VALUES ($1,'status',$2,'accepted',$3)`, [row.id, from, 'Accepted online by ' + name + (title ? ', ' + title : '')]);
  await audit.log(null, 'proposal.accepted_online', 'proposal', row.id, row.ref_no + ' by ' + name);
  try { await crm.syncLeadFromProposal(row.customer_id, 'accepted', '', null); await deals.onAccepted(row.id); } catch (e) { console.error('post-acceptance failed:', e.message); }
  res.json({ ok: true, acceptedAt: ins.rows[0].accepted_at, name, title, ref: hash.slice(0, 12) });

  // after answering: tell the owner, and give the client a receipt
  try {
    const { rows: u } = await db.query('SELECT u.email, u.display_name, u.username, u.phone, u.alert_email, u.alert_sms, u.alert_whatsapp, u.alert_push, u.ntfy_topic FROM app_users u WHERE u.id = $1', [row.created_by]);
    notify(u[0], row, 'accepted your proposal', `${escH(row.client.name)} accepted proposal ${escH(row.ref_no)} online (signed by ${escH(name)}${title ? ', ' + escH(title) : ''}).`, `${row.client.name} ACCEPTED proposal ${row.ref_no} online (signed by ${name}).`);
    const to = row.client && row.client.contact && row.client.contact.email;
    if (to && mail.configured()) {
      mail.send({ to, subject: 'Thank you: proposal ' + row.ref_no + ' accepted',
        html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:520px"><p>Dear ${escH(name)},</p><p>Thank you. We have recorded your acceptance of proposal <b>${escH(row.ref_no)}</b> on ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}. Reference: <code>${escH(hash.slice(0, 12))}</code>.</p><p>We will be in touch shortly about the next steps.</p><p style="color:#777;font-size:13px">Victory Information (Pvt) Ltd</p></div>` }).catch(() => {});
    }
  } catch (e) { console.error('acceptance notices failed:', e.message); }
});

pub.post('/public/track/:token', async (req, res) => {
  if (limited('trk|' + req.ip + '|' + req.params.token.slice(0, 12), 240, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many requests' });
  const b = req.body || {};
  const type = b.type, sid = typeof b.sid === 'string' ? b.sid : '';
  if (!TYPES.includes(type) || !/^[a-z0-9]{8,40}$/i.test(sid)) return res.status(400).json({ error: 'Bad event' });
  const row = await linkByToken(req.params.token);
  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) return res.status(404).json({ error: 'Not found' });
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const isBot = !ua || BOT_RE.test(ua);
  const internal = !!req.user; // a signed-in colleague looking at the client's page is not the client
  const section = SECTIONS.includes(b.section) ? b.section : null;
  const ms = type === 'heartbeat' ? Math.max(0, Math.min(15000, parseInt(b.ms, 10) || 0)) : null;
  let note = null;
  if (type === 'cta') {
    const phone = String(b.phone || '').replace(/[^\d+ ()-]/g, '').trim().slice(0, 25);
    const when = String(b.when || '').trim().slice(0, 60);
    note = [phone ? 'Phone: ' + phone : '', when ? 'Best time: ' + when : '', String(b.note || '').trim()].filter(Boolean).join(' | ').slice(0, 500) || null;
  }
  await db.query(
    `INSERT INTO proposal_views (proposal_id, link_id, sid, type, section, ms, note, device, ua, ip_hash, is_bot, internal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [row.id, row.link_id, sid, type, section, ms, note, deviceOf(ua), ua, ipHash(req.ip), isBot, internal]);
  res.json({ ok: true });

  // After answering: the first real read moves the proposal to "viewed"; a request to talk alerts the owner
  if (isBot || internal || !['engaged', 'cta'].includes(type)) return;
  try {
    const { rows: u } = await db.query('SELECT u.email, u.display_name, u.username, u.phone, u.alert_email, u.alert_sms, u.alert_whatsapp, u.alert_push, u.ntfy_topic FROM app_users u WHERE u.id = $1', [row.created_by]);
    if (type === 'engaged' && row.status === 'sent') {
      const up = await db.query(`UPDATE proposals SET status = 'viewed', status_changed_at = now() WHERE id = $1 AND status = 'sent' RETURNING id`, [row.id]);
      if (up.rowCount) {
        await db.query(`INSERT INTO proposal_events (proposal_id, type, from_status, to_status, note) VALUES ($1,'status','sent','viewed','The client opened the proposal')`, [row.id]);
        notify(u[0], row, 'opened your proposal', `${escH(row.client.name)} has just opened proposal ${escH(row.ref_no)}.`);
      }
    }
    if (type === 'cta') {
      await db.query(`INSERT INTO proposal_events (proposal_id, type, note) VALUES ($1,'client_request',$2)`, [row.id, note || 'Asked to discuss the proposal']);
      const lk = (await db.query('SELECT recipient FROM proposal_links WHERE id = $1', [row.link_id])).rows[0];
      const who = lk && lk.recipient ? lk.recipient : null;
      notify(u[0], row, 'wants to talk', `${escH(row.client.name)} asked to discuss proposal ${escH(row.ref_no)}.${who ? '<br>From: ' + escH(who) : ''}${note ? '<br><br><i>' + escH(note) + '</i>' : ''}`,
        `${row.client.name} asked for a call about ${row.ref_no}.${who ? ' From ' + who + '.' : ''}${note ? ' ' + note : ''}`);
    }
  } catch (e) { console.error('tracking follow-up failed:', e.message); }
});

function notify(user, row, what, bodyHtml, smsText) {
  if (!user) return;
  // Push: every event (it is free). SMS and WhatsApp: only the important ones, where the caller passed a short text.
  if (user.alert_push && push.validTopic(user.ntfy_topic)) push.send(user.ntfy_topic, { title: `${row.client.name} ${what}`, text: smsText || `Proposal ${row.ref_no}: ${what}`, url: `${BASE()}/tool/proposal.html?open=${row.id}` }).then((r) => { if (!r.ok) console.error('Push alert failed:', r.error); }).catch(() => {});
  if (smsText && user.alert_sms && user.phone && sms.configured()) sms.send([user.phone], smsText).then((r) => { if (!r.ok) console.error('SMS alert failed:', r.error); }).catch(() => {});
  if (smsText && user.alert_whatsapp && user.phone && whatsapp.configured()) whatsapp.send(user.phone, smsText).then((r) => { if (!r.ok) console.error('WhatsApp alert failed:', r.error); }).catch(() => {});
  if (!user.email || !mail.configured() || user.alert_email === false) return;
  mail.send({
    to: user.email, subject: `${row.client.name} ${what} (${row.ref_no})`,
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:520px"><p>${bodyHtml}</p><p><a href="${escH(BASE())}/tool/proposal.html?open=${row.id}" style="display:inline-block;background:#0d9467;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Open the proposal</a></p><p style="color:#777;font-size:12px">A good moment to follow up.</p></div>`,
  }).catch(() => {});
}

module.exports = { staff, pub, ensureLink, statsFor, sentAtFor };

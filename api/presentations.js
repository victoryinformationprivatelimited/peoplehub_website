// Presentation launcher: partners start the PeopleHub sales deck from here, pre-filled with the client and their own details.
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');
const A = require('./auth');
const audit = require('./audit');

const r = express.Router();
const ANY = A.requireRole('admin', 'staff', 'partner');
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const DECK_DIR = path.join(__dirname, '..', 'present');

// The deck understands these (see Presentation/src/profiles). Kept here so the launcher can offer them as choices.
const COUNTRIES = [['lk', 'Sri Lanka'], ['in', 'India'], ['ae', 'United Arab Emirates'], ['fj', 'Fiji']];
const INDUSTRIES = [['generic', 'All industries'], ['apparel', 'Apparel & manufacturing'], ['retail', 'Retail & FMCG'], ['bpo', 'IT, BPO & services'], ['healthcare', 'Healthcare & hospitals'], ['education', 'Education & universities'], ['finance', 'Banking & finance'], ['construction', 'Construction & engineering'], ['logistics', 'Logistics & transport'], ['hospitality', 'Tourism & hospitality'], ['plantation', 'Plantation & agriculture']];

// The rest of the deck's settings, so the launcher can offer them too. Kept in step with Presentation/src.
const PAINS = [['attendance', 'Manual attendance and overtime sheets'], ['payroll', 'Payroll errors and disputes'], ['leave', 'Leave approvals lost in email or paper'], ['data', 'Employee data scattered across files'], ['hiring', 'Slow hiring and onboarding'], ['compliance', 'Statutory and audit compliance risk'], ['insight', 'No real-time HR reporting'], ['attrition', 'Low engagement and high attrition'], ['queries', 'Employees keep asking HR the same questions'], ['training', 'Training and certifications not tracked']];
const NAVS = {
  workshop: [['wall', 'Discovery wall'], ['wheel', 'Module wheel'], ['landscape', 'Module and feature landscape'], ['lenses', 'Three lenses']],
  tour: [['lenses', 'Three lenses'], ['landscape', 'Module and feature landscape'], ['wheel', 'Module wheel'], ['constellation', 'One-platform constellation']],
};
const AGENDAS = [20, 30, 45, 60];
const isStaff = (u) => u.role === 'admin' || u.role === 'staff';
const installed = () => fs.existsSync(path.join(DECK_DIR, 'index.html'));

r.get('/presentations', ANY, async (req, res) => {
  const decks = await db.query(
    `SELECT id, name, tagline, best_for, partner_visible, active FROM presentation_decks WHERE ($1::boolean OR (active AND partner_visible)) AND ($2::boolean OR active) ORDER BY sort_order`,
    [isStaff(req.user), req.user.role === 'admin']);
  const scope = req.user.role === 'partner' ? 'WHERE l.partner_id = $1' : '';
  const recent = await db.query(
    `SELECT l.id, l.deck_id, d.name AS deck_name, l.client, l.created_at, coalesce(u.display_name, u.username) AS by_user
       FROM presentation_launches l LEFT JOIN presentation_decks d ON d.id = l.deck_id LEFT JOIN app_users u ON u.id = l.user_id ${scope} ORDER BY l.created_at DESC LIMIT 8`,
    req.user.role === 'partner' ? [req.user.partner_id] : []);
  res.json({ installed: installed(), decks: decks.rows, recent: recent.rows, countries: COUNTRIES, industries: INDUSTRIES, pains: PAINS, navs: NAVS, agendas: AGENDAS });
});

r.post('/presentations/launch', ANY, async (req, res) => {
  if (!installed()) return res.status(503).json({ error: 'The presentation is not installed on this server yet. Ask an administrator.' });
  const deckId = str(req.body.deck, 30);
  const { rows } = await db.query('SELECT id, name, partner_visible FROM presentation_decks WHERE id = $1 AND active', [deckId]);
  if (!rows[0] || (!isStaff(req.user) && !rows[0].partner_visible)) return res.status(400).json({ error: 'That presentation is not available to you' });
  const client = str(req.body.client, 160);
  const country = COUNTRIES.some((c) => c[0] === req.body.country) ? req.body.country : null;
  const industry = INDUSTRIES.some((c) => c[0] === req.body.industry) ? req.body.industry : null;
  const headcount = Math.max(0, Math.min(1000000, parseInt(req.body.headcount, 10) || 0));
  const hrTeam = Math.max(0, Math.min(100000, parseInt(req.body.hrTeam, 10) || 0));
  const pains = (Array.isArray(req.body.pains) ? req.body.pains : []).filter((p) => PAINS.some((x) => x[0] === p));
  const customPain = str(req.body.customPain, 120);
  const agenda = AGENDAS.includes(parseInt(req.body.agenda, 10)) ? parseInt(req.body.agenda, 10) : 0;
  const nav = (NAVS[deckId] || []).some((n) => n[0] === req.body.nav) ? req.body.nav : null;
  const theme = ['light', 'dark'].includes(req.body.theme) ? req.body.theme : null;
  const settings = req.body.mode === 'settings'; // open the deck's own settings screen with everything prefilled

  let leadId = null;
  if (req.body.lead_id) {
    const scope = req.user.role === 'partner' ? ' AND partner_id = $2' : '';
    const l = await db.query(`SELECT id FROM leads WHERE id = $1${scope}`, req.user.role === 'partner' ? [parseInt(req.body.lead_id, 10) || 0, req.user.partner_id] : [parseInt(req.body.lead_id, 10) || 0]);
    if (l.rows[0]) leadId = l.rows[0].id;
  }

  // Who is presenting: the partner's company and the person's own details
  const me = await db.query(
    `SELECT coalesce(u.display_name, u.username) AS name, u.email, u.phone, p.company_name, p.email AS pemail, p.phone AS pphone FROM app_users u LEFT JOIN partners p ON p.id = u.partner_id WHERE u.id = $1`, [req.user.id]);
  const m = me.rows[0];
  const q = new URLSearchParams();
  q.set('deck', deckId);
  if (country) q.set('country', country);
  if (industry) q.set('industry', industry);
  if (client) q.set('client', client);
  if (headcount) q.set('headcount', String(headcount));
  if (hrTeam) q.set('hrTeam', String(hrTeam));
  if (pains.length) q.set('pains', pains.join(','));
  if (customPain) q.set('customPain', customPain);
  if (agenda) q.set('agenda', String(agenda));
  if (nav) q.set('nav', nav);
  if (theme) q.set('theme', theme);
  if (settings) q.set('launcher', '1');
  // A partner is only offered the presentations that were opened to them
  if (!isStaff(req.user)) {
    const ok = await db.query('SELECT id FROM presentation_decks WHERE active AND partner_visible ORDER BY sort_order');
    q.set('decks', ok.rows.map((x) => x.id).join(','));
  }
  if (req.user.role === 'partner') {
    q.set('pco', m.company_name || ''); q.set('pname', m.name || '');
    if (m.email || m.pemail) q.set('pemail', m.email || m.pemail);
    if (m.phone || m.pphone) q.set('pphone', m.phone || m.pphone);
  }
  await db.query('INSERT INTO presentation_launches (user_id, partner_id, deck_id, client, lead_id) VALUES ($1,$2,$3,$4,$5)',
    [req.user.id, req.user.role === 'partner' ? req.user.partner_id : null, deckId, client || null, leadId]);
  if (leadId) await db.query(`INSERT INTO crm_activities (lead_id, type, note, user_id) VALUES ($1,'meeting',$2,$3)`, [leadId, 'Presented: ' + rows[0].name, req.user.id]).catch(() => {});
  res.json({ url: '/present/index.html?' + q.toString() });
});

// Admin decides which decks partners may launch
r.put('/presentations/decks/:id', A.requireRole('admin'), async (req, res) => {
  const { rowCount } = await db.query('UPDATE presentation_decks SET partner_visible = coalesce($1, partner_visible), active = coalesce($2, active) WHERE id = $3',
    [typeof req.body.partner_visible === 'boolean' ? req.body.partner_visible : null, typeof req.body.active === 'boolean' ? req.body.active : null, req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Presentation not found' });
  await audit.log(req.user, 'deck.update', 'deck', null, req.params.id + ' ' + JSON.stringify({ partner_visible: req.body.partner_visible, active: req.body.active }));
  res.json({ ok: true });
});

// The deck itself: static files, signed-in users only
function serveDeck() {
  const router = express.Router();
  router.use(A.loadUser, (req, res, next) => {
    if (!req.user) return res.redirect('/tool/proposals.html');
    res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    next();
  });
  router.use(express.static(DECK_DIR, { index: 'index.html', dotfiles: 'deny', maxAge: '1h' }));
  return router;
}

module.exports = r;
module.exports.serveDeck = serveDeck;

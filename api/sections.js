// The proposal text library: defaults in code, replaceable by Victory (for everyone) or by a partner (for their own proposals).
const express = require('express');
const db = require('./db');
const A = require('./auth');
const audit = require('./audit');
const { SECTIONS, STYLES, byKey } = require('./content/sections');
const { PILLARS } = require('./content/modules');

const r = express.Router();
const ANY = A.requireRole('admin', 'staff', 'partner');
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Always in every style, so a proposal cannot be left without its price or acceptance
const REQUIRED = ['exec', 'scope', 'invest', 'accept'];

/** Defaults, then Victory's replacements, then the partner's own (if any). */
async function resolve(partnerId) {
  const { rows } = await db.query('SELECT partner_id, key, title, body FROM section_overrides WHERE partner_id IS NULL OR partner_id = $1', [partnerId || 0]);
  const glob = {}, mine = {};
  rows.forEach((o) => { (o.partner_id ? mine : glob)[o.key] = o; });
  return SECTIONS.map((s) => {
    const o = mine[s.key] || glob[s.key];
    return {
      key: s.key, part: s.part, kind: s.kind, styles: s.styles, required: REQUIRED.includes(s.key),
      title: (o && o.title) || s.title, body: s.kind === 'text' ? ((o && o.body) || s.body) : undefined,
      custom: mine[s.key] ? 'partner' : glob[s.key] ? 'victory' : null,
    };
  });
}

/** What a proposal stores so its wording and structure never change after it is sent. */
async function buildDoc(partnerId, input) {
  const style = STYLES.some((s) => s.id === input.style) ? input.style : 'standard';
  const excluded = (Array.isArray(input.excluded) ? input.excluded : []).filter((k) => byKey[k] && !REQUIRED.includes(k));
  const sections = (await resolve(partnerId)).map((s) => ({ key: s.key, part: s.part, kind: s.kind, styles: s.styles, title: s.title, body: s.body }));
  return { style, excluded, sections, pillars: PILLARS };
}

r.get('/proposal-sections', ANY, async (req, res) => {
  // Victory edits the defaults everyone sees; a partner edits their own company's version
  const partnerId = req.user.role === 'partner' ? req.user.partner_id : null;
  res.json({ styles: STYLES, sections: await resolve(partnerId), pillars: PILLARS, editable: req.user.role === 'admin' || (req.user.role === 'partner' && req.user.partner_role === 'owner'), scope: partnerId ? 'your company' : 'Victory defaults' });
});

function writer(req, res) {
  if (req.user.role === 'admin') return { partnerId: null };
  if (req.user.role === 'partner' && req.user.partner_role === 'owner') return { partnerId: req.user.partner_id };
  res.status(403).json({ error: req.user.role === 'partner' ? 'Only the partner owner can change the proposal text' : 'Only an admin can change the default proposal text' });
  return null;
}

r.put('/proposal-sections/:key', ANY, async (req, res) => {
  const w = writer(req, res); if (!w) return;
  const def = byKey[req.params.key];
  if (!def || def.kind !== 'text') return res.status(404).json({ error: 'That section cannot be edited' });
  const title = str(req.body.title, 120) || def.title;
  const body = typeof req.body.body === 'string' ? req.body.body.replace(/\r\n/g, '\n').trim() : '';
  if (body.length < 3) return res.status(400).json({ error: 'The text cannot be empty' });
  if (body.length > 12000) return res.status(400).json({ error: 'That is too long. Keep it under about 12,000 characters.' });
  await db.query(
    `INSERT INTO section_overrides (partner_id, key, title, body, updated_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (coalesce(partner_id, 0), key) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [w.partnerId, def.key, title, body, req.user.id]);
  await audit.log(req.user, 'text.update', 'section', null, def.key + (w.partnerId ? ' (partner ' + w.partnerId + ')' : ' (Victory default)'));
  res.json({ ok: true });
});

r.delete('/proposal-sections/:key', ANY, async (req, res) => {
  const w = writer(req, res); if (!w) return;
  await db.query('DELETE FROM section_overrides WHERE coalesce(partner_id, 0) = $1 AND key = $2', [w.partnerId || 0, req.params.key]);
  await audit.log(req.user, 'text.reset', 'section', null, req.params.key);
  res.json({ ok: true });
});

module.exports = r;
module.exports.buildDoc = buildDoc;
module.exports.resolve = resolve;

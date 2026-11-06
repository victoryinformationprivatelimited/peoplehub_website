// Pictures used inside proposal wording. Stored in the database; shown by an unguessable id so the client page and PDF can load them.
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const A = require('./auth');

const r = express.Router();
const ANY = A.requireRole('admin', 'staff', 'partner');
const MAX = 400 * 1024;

function sniff(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null; // SVG and anything else is refused (scripts can hide in SVG)
}

r.post('/images', ANY, async (req, res) => {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+\/=]+)$/.exec(String(req.body.data || ''));
  if (!m) return res.status(400).json({ error: 'Use a PNG, JPG or WEBP picture' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX) return res.status(400).json({ error: 'The picture is larger than 400 KB. Shrink it and try again.' });
  const mime = sniff(buf);
  if (!mime) return res.status(400).json({ error: 'That file is not a valid PNG, JPG or WEBP picture' });
  const { rows: c } = await db.query('SELECT count(*)::int AS n FROM proposal_images WHERE uploaded_by = $1 AND created_at > now() - interval \'1 day\'', [req.user.id]);
  if (c[0].n >= 60) return res.status(429).json({ error: 'Too many uploads today' });
  const id = crypto.randomBytes(12).toString('hex');
  const name = String(req.body.name || 'picture').replace(/[^\w .-]/g, '').slice(0, 100) || 'picture';
  await db.query('INSERT INTO proposal_images (id, partner_id, uploaded_by, name, mime, data) VALUES ($1,$2,$3,$4,$5,$6)', [id, req.user.partner_id || null, req.user.id, name, mime, buf]);
  res.status(201).json({ id, url: '/img/' + id });
});

// Public, read only: the id is 96 random bits
const serve = async (req, res) => {
  if (!/^[0-9a-f]{24}$/.test(req.params.id)) return res.status(404).end();
  const { rows } = await db.query('SELECT mime, data FROM proposal_images WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).end();
  res.set({ 'Content-Type': rows[0].mime, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
  res.send(rows[0].data);
};

module.exports = { router: r, serve };

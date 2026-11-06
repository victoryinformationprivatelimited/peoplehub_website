const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const COOKIE = 'vi_session';
const SECRET = process.env.SESSION_SECRET;
const MAX_AGE_MS = 8 * 60 * 60 * 1000;

if (!SECRET || SECRET.length < 32) {
  console.error('SESSION_SECRET must be set (at least 32 characters) in api/.env');
  process.exit(1);
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function setSession(res, userId) {
  const token = jwt.sign({ uid: userId }, SECRET, { expiresIn: Math.floor(MAX_AGE_MS / 1000) });
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(MAX_AGE_MS / 1000)}${secure}`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// Loads the signed-in user fresh from the database each request so deactivation takes effect immediately.
async function loadUser(req, res, next) {
  req.user = null;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    try {
      const { uid, iat } = jwt.verify(token, SECRET);
      const { rows } = await db.query(
        `SELECT u.id, u.username, u.role, u.partner_id, u.email, u.display_name, u.phone, u.must_change_password, u.password_changed_at, u.partner_role,
                p.company_name, p.category_id, c.name AS category_name, c.max_discount_pct
           FROM app_users u
           LEFT JOIN partners p ON p.id = u.partner_id AND p.active
           LEFT JOIN partner_categories c ON c.id = p.category_id AND c.active
          WHERE u.id = $1 AND u.active`,
        [uid]
      );
      const u = rows[0];
      // A password change signs out every older session
      const stale = u && u.password_changed_at && iat < Math.floor(new Date(u.password_changed_at).getTime() / 1000);
      if (u && !stale && (u.role !== 'partner' || u.category_id)) req.user = u;
    } catch (e) { /* invalid or expired token: treated as signed out */ }
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });
    next();
  };
}

// POST/PUT/PATCH must be JSON, so a plain cross-site form post (which cannot send application/json) is rejected.
// DELETE needs no body, and browsers will not send a cross-site DELETE without a permission check first.
function requireJson(req, res, next) {
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }
  next();
}

const attempts = new Map();
function loginThrottle(key) {
  const now = Date.now();
  const rec = (attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(key, rec);
  return rec.length >= 8;
}
function recordFailure(key) { (attempts.get(key) || attempts.set(key, []).get(key)).push(Date.now()); }
function clearFailures(key) { attempts.delete(key); }

function hashPassword(pw) { return bcrypt.hashSync(pw, 11); }
function checkPassword(pw, hash) { return bcrypt.compareSync(pw, hash); }
function validPassword(pw) { return typeof pw === 'string' && pw.length >= 10 && pw.length <= 200; }

module.exports = { loadUser, requireRole, requireJson, setSession, clearSession, loginThrottle, recordFailure, clearFailures, hashPassword, checkPassword, validPassword };

// Who changed what: a short, append-only record of sensitive actions. Never allowed to break the action itself.
const db = require('./db');

async function log(user, action, entity, entityId, detail) {
  try {
    await db.query('INSERT INTO audit_log (user_id, username, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [user ? user.id : null, user ? user.username : null, action, entity || null, entityId || null, detail ? String(detail).slice(0, 500) : null]);
  } catch (e) { console.error('audit failed:', e.message); }
}

module.exports = { log };

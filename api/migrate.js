// Brings the database up to date every time the app starts. schema.sql only ever creates what is missing
// (CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, ON CONFLICT DO NOTHING), so running it again is safe.
// This is what lets a brand-new empty database, or one from an older release, work without any manual step.
const fs = require('fs');
const path = require('path');
const db = require('./db');

module.exports = async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(sql);
};

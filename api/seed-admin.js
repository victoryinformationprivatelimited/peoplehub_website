// Creates the first Admin login. Usage:  node seed-admin.js [username]
// A random password is generated and written to api/.admin-initial-password (git-ignored). Read it, sign in, then delete the file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { hashPassword } = require('./auth');

(async () => {
  const username = (process.argv[2] || 'admin').toLowerCase();
  const { rows } = await db.query('SELECT 1 FROM app_users WHERE lower(username) = $1', [username]);
  if (rows[0]) { console.log('User "' + username + '" already exists — nothing changed.'); return db.end(); }
  const password = crypto.randomBytes(15).toString('base64url');
  await db.query("INSERT INTO app_users (username, password_hash, role) VALUES ($1,$2,'admin')", [username, hashPassword(password)]);
  fs.writeFileSync(path.join(__dirname, '.admin-initial-password'), 'username: ' + username + '\npassword: ' + password + '\n');
  console.log('Admin "' + username + '" created. Password saved to api/.admin-initial-password');
  await db.end();
})().catch((e) => { console.error(e.message); process.exit(1); });

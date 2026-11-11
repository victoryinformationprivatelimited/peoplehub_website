const path = require('path');
const fs = require('fs');
const express = require('express');
require('express-async-errors'); // a failed async handler now answers 500 instead of crashing the server
const A = require('./auth');
const routes = require('./routes');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use('/api/proposals/:id/attachments', express.json({ limit: '9mb' })); // file uploads for the email
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.get('/api/health', async (req, res) => {
  try { await require('./db').query('SELECT 1'); res.json({ ok: true }); } catch (e) { res.status(503).json({ ok: false }); }
});

app.get('/img/:id', require('./images').serve);
app.use('/api', A.loadUser, A.requireJson, routes);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// The sales deck (built from the Presentation project into ./present). Signed-in users only, and it must come before the open static folder below.
app.use('/present', require('./presentations').serveDeck());

// The same process serves the website and tool pages so the pages and the API share one origin (and one login cookie).
const SITE_ROOT = path.join(__dirname, '..');
const BLOCKED = /^\/(api\/|node_modules\/|present\/|scripts\/|\.git|\.env)|\.(sql|md)$|^\/(serve\.js|\.gitignore)$/i;
app.use((req, res, next) => (BLOCKED.test(req.path) ? res.status(404).end() : next()));
app.use(express.static(SITE_ROOT, { index: 'index.html', dotfiles: 'deny' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

// The client-facing proposal page: one fixed HTML shell, the private token is read by the page itself
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/p/:token', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
  res.sendFile(path.join(__dirname, '..', 'tool', 'view.html'));
});

const PORT = parseInt(process.env.PORT || '4400', 10);
// Create or update the database tables first, so an empty database (a new server) needs no manual setup
require('./migrate')().then(() => {
  require('./crm').startReminders(); // daily follow-up emails
  app.listen(PORT, () => console.log('PeopleHub pricing API and site on port ' + PORT));
}).catch((e) => { console.error('Database setup failed:', e.message); process.exit(1); });

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
require('express-async-errors'); // a failed async handler now answers 500 instead of crashing the server
const log = require('./logger');
const audit = require('./audit');
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

// ---- activity log -------------------------------------------------------------------------------------------------
// Every change a signed-in person makes is written to the audit log (Audit log page), and a line goes to the console.
// LOG_REQUESTS: "writes" (default) logs every change, every error and anything slow; "all" logs every request; "off" logs only errors.
const LOG_MODE = ['all', 'writes', 'off'].includes(process.env.LOG_REQUESTS) ? process.env.LOG_REQUESTS : 'writes';
app.use((req, res, next) => {
  const isApi = req.path.startsWith('/api/') && req.path !== '/api/health';
  if (!isApi) return next();
  req.id = crypto.randomBytes(4).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  const t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t0, status = res.statusCode, write = req.method !== 'GET' && req.method !== 'HEAD';
    const chatter = req.path.startsWith('/api/public/track'); // the client page reports reading time all the time
    const path = log.cleanPath(req.originalUrl || req.path);
    const interesting = LOG_MODE === 'all' || status >= 400 || ms > 3000 || (write && !chatter && LOG_MODE === 'writes');
    if (interesting) {
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      log[level]('http', { id: req.id, method: req.method, path, status, ms, user: req.user && req.user.username, role: req.user && req.user.role, ip: req.ip });
    }
    // every successful change by a signed-in person goes to the audit log
    if (write && req.user && status < 400 && !chatter) audit.log(req.user, 'request ' + req.method + ' ' + path, null, null, 'status ' + status);
  });
  next();
});

app.get('/api/health', async (req, res) => {
  try { await require('./db').query('SELECT 1'); res.json({ ok: true }); } catch (e) { log.error('health.failed', { error: e.message }); res.status(503).json({ ok: false }); }
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
// Pages, scripts and styles are always re-checked, so a proxy or CDN (such as Cloudflare) never keeps serving an old version after a release
const NO_STALE = /\.(html|js|css)$/i;
app.use(express.static(SITE_ROOT, { index: 'index.html', dotfiles: 'deny', setHeaders: (res, file) => { if (NO_STALE.test(file)) res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate'); } }));

app.use((err, req, res, next) => {
  log.error('http.error', { id: req.id, method: req.method, path: log.cleanPath(req.originalUrl || req.path), user: req.user && req.user.username, error: err && err.message, where: err && err.stack ? String(err.stack).split('\n').slice(1, 3).join(' | ') : undefined });
  res.status(500).json({ error: 'Something went wrong', requestId: req.id });
});

// The client-facing proposal page: one fixed HTML shell, the private token is read by the page itself
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/p/:token', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
  res.sendFile(path.join(__dirname, '..', 'tool', 'view.html'));
});

// A crash that nothing caught is written to the log first, then the process stops so Docker starts it again
process.on('unhandledRejection', (e) => { log.error('process.unhandled_rejection', { error: e && e.message ? e.message : String(e), where: e && e.stack ? String(e.stack).split('\n').slice(1, 3).join(' | ') : undefined }); process.exit(1); });
process.on('uncaughtException', (e) => { log.error('process.uncaught_exception', { error: e && e.message, where: e && e.stack ? String(e.stack).split('\n').slice(1, 3).join(' | ') : undefined }); process.exit(1); });

const PORT = parseInt(process.env.PORT || '4400', 10);
// Create or update the database tables first, so an empty database (a new server) needs no manual setup
require('./migrate')().then(() => {
  require('./crm').startReminders(); // daily follow-up emails
  require('./crm').backfillLeadsFromProposals().catch((e) => log.error('lead.backfill_failed', { error: e.message }));
  app.listen(PORT, () => {
    console.log('PeopleHub pricing API and site on port ' + PORT);
    // what this server can and cannot do, so a missing setting shows up straight away
    log.info('startup', {
      node: process.version, port: PORT, base_url: process.env.APP_BASE_URL || '(not set)', request_log: LOG_MODE,
      email: require('./email').configured() ? 'ready' : 'NOT SET UP (PLUNK_SECRET_KEY / PLUNK_FROM)',
      sms: require('./sms').configured() ? 'ready' : 'off', whatsapp: require('./whatsapp').configured() ? 'ready' : 'off',
      deck: fs.existsSync(path.join(SITE_ROOT, 'present', 'index.html')) ? 'installed' : 'missing',
    });
  });
}).catch((e) => { log.error('startup.database_failed', { error: e.message }); process.exit(1); });

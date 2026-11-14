// Transactional email through Plunk. The secret key and sender live only in api/.env.
const log = require('./logger');
const URL = 'https://next-api.useplunk.com/v1/send';

const configured = () => !!process.env.PLUNK_SECRET_KEY && !!process.env.PLUNK_FROM;

/** Returns { ok, status, ms, error?, detail? }. Every attempt is written to the log with what the email service answered. */
async function send({ to, subject, html, replyTo, attachments }) {
  const files = (attachments || []).length, bytes = (attachments || []).reduce((n, a) => n + (a.content ? a.content.length : 0), 0);
  if (!configured()) {
    log.warn('email.failed', { to, subject, reason: 'not configured', has_key: !!process.env.PLUNK_SECRET_KEY, has_from: !!process.env.PLUNK_FROM });
    return { ok: false, error: 'Email is not configured on the server' };
  }
  const body = { to, subject, body: html, from: process.env.PLUNK_FROM, name: process.env.PLUNK_FROM_NAME || 'Victory Information', subscribed: false };
  if (replyTo) body.reply = replyTo;
  // attachments: [{ filename, content (Buffer), contentType }] sent to Plunk as base64
  if (files) body.attachments = attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64'), contentType: a.contentType }));
  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(URL, { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.PLUNK_SECRET_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    text = await res.text();
  } catch (e) {
    const ms = Date.now() - t0;
    log.error('email.failed', { to, subject, reason: 'could not reach the email service', error: (e.cause && e.cause.code) || e.name || e.message, message: e.message, ms, files, bytes });
    return { ok: false, error: 'Could not reach the email service', detail: (e.cause && e.cause.code) || e.message, ms };
  }
  const ms = Date.now() - t0;
  if (!res.ok) {
    log.error('email.failed', { to, subject, status: res.status, answer: text.slice(0, 300), ms, files, bytes });
    return { ok: false, status: res.status, ms, error: 'The email service refused the message (' + res.status + ')', detail: text.slice(0, 300) };
  }
  log.info('email.sent', { to, subject, status: res.status, ms, files, bytes });
  return { ok: true, status: res.status, ms };
}

module.exports = { send, configured };

// Transactional email through Plunk. The secret key and sender live only in api/.env.
const URL = 'https://next-api.useplunk.com/v1/send';

const configured = () => !!process.env.PLUNK_SECRET_KEY && !!process.env.PLUNK_FROM;

async function send({ to, subject, html, replyTo, attachments }) {
  if (!configured()) return { ok: false, error: 'Email is not configured on the server' };
  const body = { to, subject, body: html, from: process.env.PLUNK_FROM, name: process.env.PLUNK_FROM_NAME || 'Victory Information', subscribed: false };
  if (replyTo) body.reply = replyTo;
  // attachments: [{ filename, content (Buffer), contentType }] sent to Plunk as base64
  if (attachments && attachments.length) body.attachments = attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64'), contentType: a.contentType }));
  let res, text;
  try {
    res = await fetch(URL, { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.PLUNK_SECRET_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    text = await res.text();
  } catch (e) { return { ok: false, error: 'Could not reach the email service' }; }
  if (!res.ok) return { ok: false, error: 'The email service refused the message (' + res.status + ')', detail: text.slice(0, 300) };
  return { ok: true };
}

module.exports = { send, configured };

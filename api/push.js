// Phone push notifications through ntfy (https://ntfy.sh, free). Each user has a private random topic and subscribes to it in the ntfy app.
// Settings in api/.env (both optional): NTFY_SERVER (default https://ntfy.sh), NTFY_TOKEN (only for a protected self-hosted server)
const crypto = require('crypto');

const server = () => (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
const newTopic = () => 'ph-' + crypto.randomBytes(12).toString('hex');
const validTopic = (t) => /^ph-[0-9a-f]{24}$/.test(String(t || ''));

async function send(topic, { title, text, url, priority }) {
  if (!validTopic(topic)) return { ok: false, error: 'No push topic yet' };
  // header values must be plain single-line ASCII
  const h = (v) => String(v || '').replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
  const headers = { Title: h(title || 'PeopleHub'), Priority: String(priority || 4), Tags: 'bell' };
  if (url && /^https?:\/\//.test(url)) headers.Click = h(url);
  if (process.env.NTFY_TOKEN) headers.Authorization = 'Bearer ' + process.env.NTFY_TOKEN;
  try {
    const res = await fetch(`${server()}/${topic}`, { method: 'POST', headers, body: String(text || '').slice(0, 1000), signal: AbortSignal.timeout(15000) });
    return res.ok ? { ok: true } : { ok: false, error: 'The push service refused the message (' + res.status + ')' };
  } catch (e) { return { ok: false, error: 'Could not reach the push service' }; }
}

module.exports = { send, newTopic, validTopic, server };

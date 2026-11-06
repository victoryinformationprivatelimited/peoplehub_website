// SMS alerts through Dialog eSMS (https://e-sms.dialog.lk). Credentials live only in api/.env.
//   ESMS_USERNAME, ESMS_PASSWORD   the eSMS login
//   ESMS_MASK                      optional sender name (max 11 characters); the account default is used if blank
//   ESMS_PAYMENT                   0 = wallet (default), 4 = package
const LOGIN_URL = 'https://esms.dialog.lk/api/v2/user/login';
const SEND_URL = 'https://e-sms.dialog.lk/api/v2/sms';

const configured = () => !!process.env.ESMS_USERNAME && !!process.env.ESMS_PASSWORD;

let token = null, tokenUntil = 0;

// Sri Lankan mobile numbers: 0771234567, +94771234567, 94771234567 and 771234567 all become 771234567
function normalize(n) {
  let d = String(n == null ? '' : n).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('94')) d = d.slice(2);
  else if (d.length === 10 && d.startsWith('0')) d = d.slice(1);
  return /^7\d{8}$/.test(d) ? d : null;
}

async function login() {
  const res = await fetch(LOGIN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.ESMS_USERNAME, password: process.env.ESMS_PASSWORD }), signal: AbortSignal.timeout(15000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.status !== 'success' || !j.token) throw new Error('eSMS login failed' + (j.comment ? ': ' + String(j.comment).slice(0, 120) : ''));
  token = j.token; tokenUntil = Date.now() + Math.max(60, (Number(j.expiration) || 43200) - 300) * 1000; // the token lasts 12 hours
  return token;
}

async function post(message, mobiles) {
  const body = { msisdn: mobiles.map((m) => ({ mobile: m })), message, transaction_id: Date.now() * 1000 + Math.floor(Math.random() * 1000), payment_method: process.env.ESMS_PAYMENT === '4' ? 4 : 0 };
  if (process.env.ESMS_MASK) body.sourceAddress = String(process.env.ESMS_MASK).slice(0, 11);
  const res = await fetch(SEND_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const j = await res.json().catch(() => ({}));
  return { res, j };
}

/** numbers: any mix of accepted formats. Returns { ok } or { ok: false, error }. */
async function send(numbers, text) {
  if (!configured()) return { ok: false, error: 'SMS is not set up on the server' };
  const mobiles = [...new Set((numbers || []).map(normalize).filter(Boolean))];
  if (!mobiles.length) return { ok: false, error: 'No valid Sri Lankan mobile number' };
  const message = String(text || '').trim().slice(0, 300);
  if (!message) return { ok: false, error: 'Empty message' };
  try {
    if (!token || Date.now() > tokenUntil) await login();
    let { res, j } = await post(message, mobiles);
    if (res.status === 401 || (j.status === 'failed' && /token|auth/i.test(String(j.comment || '')))) { await login(); ({ res, j } = await post(message, mobiles)); }
    if (j.status === 'success') return { ok: true };
    return { ok: false, error: 'eSMS refused the message' + (j.comment ? ': ' + String(j.comment).slice(0, 120) : ' (' + res.status + ')') };
  } catch (e) { return { ok: false, error: e.message || 'Could not reach eSMS' }; }
}

module.exports = { send, configured, normalize };

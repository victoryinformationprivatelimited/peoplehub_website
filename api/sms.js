// SMS alerts through Dialog eSMS (https://e-sms.dialog.lk). Credentials live only in api/.env.
// Two ways to sign in; the key is used when both are set:
//   ESMS_KEY                       the "URL Message Key" from the eSMS portal (sends by GET, no login needed)
//   ESMS_USERNAME, ESMS_PASSWORD   the eSMS API login (sends by POST with a token)
//   ESMS_MASK                      optional sender name (max 11 characters); the account default is used if blank
//   ESMS_PAYMENT                   0 = wallet (default), 4 = package
const LOGIN_URL = 'https://esms.dialog.lk/api/v2/user/login';
const SEND_URL = 'https://e-sms.dialog.lk/api/v2/sms';
const KEY_URL = 'https://e-sms.dialog.lk/api/v1/message-via-url/create/url-campaign';

const usesKey = () => !!process.env.ESMS_KEY;
const configured = () => usesKey() || (!!process.env.ESMS_USERNAME && !!process.env.ESMS_PASSWORD);

let token = null, tokenUntil = 0;

// Sri Lankan mobile numbers: 0771234567, +94771234567, 94771234567 and 771234567 all become 771234567
function normalize(n) {
  let d = String(n == null ? '' : n).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('94')) d = d.slice(2);
  else if (d.length === 10 && d.startsWith('0')) d = d.slice(1);
  return /^7\d{8}$/.test(d) ? d : null;
}

// What eSMS means by the number it answers with when sending by key
const KEY_ERRORS = {
  2001: 'eSMS could not create the campaign', 2002: 'eSMS says the request was bad', 2003: 'No phone number was given', 2004: 'The message was empty',
  2005: 'The phone number format is not valid', 2006: 'This eSMS account is not allowed to send by key (ask Dialog to enable it)', 2007: 'The eSMS key is not valid',
  2008: 'Not enough money in the eSMS wallet, or no messages left in the package', 2009: 'No valid numbers were left (the number may have blocked this sender name)',
  2010: 'This eSMS account is not allowed to use packages', 2011: 'eSMS reported a transaction error', 2012: 'This eSMS account has no access to that sender name (mask)', 2020: 'Too many requests to eSMS; try again in a moment',
};

async function sendByKey(mobiles, message) {
  const q = new URLSearchParams({ esmsqk: process.env.ESMS_KEY, list: mobiles.join(','), message });
  if (process.env.ESMS_MASK) q.set('source_address', String(process.env.ESMS_MASK).slice(0, 11));
  if (process.env.ESMS_PAYMENT === '4') q.set('paymentType', '4');
  const res = await fetch(KEY_URL + '?' + q.toString(), { method: 'GET', signal: AbortSignal.timeout(15000) });
  const text = (await res.text()).trim();
  const code = parseInt(text, 10);
  if (res.ok && code === 1) return { ok: true };
  return { ok: false, error: KEY_ERRORS[code] ? KEY_ERRORS[code] + ' (code ' + code + ')' : 'eSMS refused the message (' + res.status + (Number.isFinite(code) ? ', code ' + code : '') + ')' };
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
    if (usesKey()) return await sendByKey(mobiles, message);
    if (!token || Date.now() > tokenUntil) await login();
    let { res, j } = await post(message, mobiles);
    if (res.status === 401 || (j.status === 'failed' && /token|auth/i.test(String(j.comment || '')))) { await login(); ({ res, j } = await post(message, mobiles)); }
    if (j.status === 'success') return { ok: true };
    return { ok: false, error: 'eSMS refused the message' + (j.comment ? ': ' + String(j.comment).slice(0, 120) : ' (' + res.status + ')') };
  } catch (e) { return { ok: false, error: e.message || 'Could not reach eSMS' }; }
}

module.exports = { send, configured, normalize, usesKey, KEY_ERRORS };

// WhatsApp alerts through the official WhatsApp Business Cloud API (Meta).
// Messages that the business starts must use an approved template. One generic alert template is used:
//   name: WA_TEMPLATE (default peoplehub_alert), category Utility, body: "PeopleHub alert: {{1}}"
// Settings in api/.env: WA_TOKEN (permanent system-user token), WA_PHONE_ID (phone number id), WA_TEMPLATE, WA_LANG
const configured = () => !!process.env.WA_TOKEN && !!process.env.WA_PHONE_ID;

// 0771234567, +94771234567, 771234567 -> 94771234567
function toWa(n) {
  let d = String(n == null ? '' : n).replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 9 && d.startsWith('7')) d = '94' + d;
  return /^947\d{8}$/.test(d) ? d : null;
}

async function send(number, text) {
  if (!configured()) return { ok: false, error: 'WhatsApp is not set up on the server' };
  const to = toWa(number);
  if (!to) return { ok: false, error: 'No valid Sri Lankan mobile number' };
  // template parameters may not contain new lines, tabs or long runs of spaces
  const clean = String(text || '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 900);
  if (!clean) return { ok: false, error: 'Empty message' };
  const body = {
    messaging_product: 'whatsapp', to, type: 'template',
    template: { name: process.env.WA_TEMPLATE || 'peoplehub_alert', language: { code: process.env.WA_LANG || 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: clean }] }] },
  };
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(process.env.WA_PHONE_ID)}/messages`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.WA_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.messages) return { ok: true };
    return { ok: false, error: 'WhatsApp refused the message' + (j.error && j.error.message ? ': ' + String(j.error.message).slice(0, 140) : ' (' + res.status + ')') };
  } catch (e) { return { ok: false, error: 'Could not reach WhatsApp' }; }
}

module.exports = { send, configured, toWa };

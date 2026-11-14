// One readable line per event, written to the console (Dokploy shows it as the container log):
//   2026-11-14T08:21:05.123Z INFO  email.sent to=client@example.com ref=VI-PH-2026-0001 status=200 ms=412
// Never pass passwords, tokens, keys or message bodies in here.
const fmt = (v) => {
  const s = String(v).replace(/\s+/g, ' ').trim().slice(0, 400);
  return /[\s="]/.test(s) ? JSON.stringify(s) : s;
};

function write(level, event, data) {
  const parts = Object.entries(data || {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => k + '=' + fmt(v));
  const line = new Date().toISOString() + ' ' + level.toUpperCase().padEnd(5) + ' ' + event + (parts.length ? ' ' + parts.join(' ') : '');
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

// Server addresses in paths carry private tokens; hide them
const cleanPath = (p) => String(p || '').replace(/\/[0-9a-f]{64}(?=\/|$|\?)/g, '/<token>').replace(/\?.*$/, '');

module.exports = {
  info: (event, data) => write('info', event, data),
  warn: (event, data) => write('warn', event, data),
  error: (event, data) => write('error', event, data),
  cleanPath,
};

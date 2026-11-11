// Real delivery status for proposal emails, read from Plunk's activity feed (sent, delivered, opened, clicked, bounced, complaint).
// Plunk does not give us an id when we send, so an event is matched to our log row by recipient, subject and time.
const FEED = 'https://next-api.useplunk.com/activity';

let cache = { at: 0, events: [] };

// The most recent email events, kept for 20 seconds so several proposals on one screen make one request
async function events(minTime) {
  if (!process.env.PLUNK_SECRET_KEY) return [];
  if (Date.now() - cache.at < 20000) return cache.events;
  const out = [];
  let cursor = null;
  try {
    for (let page = 0; page < 5; page++) {
      const res = await fetch(`${FEED}?limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, { headers: { Authorization: 'Bearer ' + process.env.PLUNK_SECRET_KEY }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) break;
      const j = await res.json();
      const rows = Array.isArray(j.data) ? j.data : [];
      rows.filter((x) => /^email\./.test(x.type)).forEach((x) => out.push({ type: x.type.slice(6), at: new Date(x.timestamp), to: String(x.contactEmail || '').toLowerCase(), subject: (x.metadata && x.metadata.subject) || '' }));
      if (!j.hasMore || !j.cursor || !rows.length) break;
      if (rows.length && new Date(rows[rows.length - 1].timestamp) < minTime) break; // far enough back
      cursor = j.cursor;
    }
  } catch (e) { return cache.events; }
  cache = { at: Date.now(), events: out };
  return out;
}

/** logs: [{ to_email, subject, created_at, ok }]. Returns the same rows with delivery fields added. */
async function attach(logs) {
  const sent = logs.filter((l) => l.ok);
  if (!sent.length) return logs.map((l) => ({ ...l, delivery: l.ok ? 'unknown' : 'failed' }));
  const minTime = new Date(Math.min(...sent.map((l) => +new Date(l.created_at))) - 120000);
  const ev = await events(minTime);
  return logs.map((l) => {
    if (!l.ok) return { ...l, delivery: 'failed' };
    const t0 = +new Date(l.created_at) - 120000, t1 = +new Date(l.created_at) + 7 * 86400000;
    const mine = ev.filter((e) => e.to === String(l.to_email).toLowerCase() && e.subject === l.subject && +e.at >= t0 && +e.at <= t1);
    if (!mine.length) return { ...l, delivery: 'unknown' };
    const first = (type) => { const m = mine.filter((e) => e.type === type).sort((a, b) => a.at - b.at)[0]; return m ? m.at : null; };
    const bounced = first('bounced'), complaint = first('complaint'), delivered = first('delivered');
    return {
      ...l,
      delivery: bounced ? 'bounced' : complaint ? 'complaint' : delivered ? 'delivered' : 'sent',
      delivered_at: delivered, mail_opened_at: first('opened'), mail_clicked_at: first('clicked'), bounced_at: bounced,
      events: mine.filter((e) => e.type !== 'sent').map((e) => ({ type: e.type, at: e.at })),
    };
  });
}

module.exports = { attach };

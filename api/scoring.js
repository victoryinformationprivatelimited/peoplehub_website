// Interest score for a proposal that is out with a client.
// Deliberately a transparent points system, not a trained model: every point is explained, and the weights can be
// tuned by hand. A statistical model only makes sense once there are enough closed proposals to learn from.

const HOUR = 3600 * 1000, DAY = 24 * HOUR;

/**
 * @param {object} p  { status, sentAt (Date|null), stats (see tracking.js statsFor) , now (Date) }
 * @returns {{score:number|null, label:string, reasons:{text:string, points:number}[]}}
 */
function interest(p) {
  const now = p.now || new Date();
  const s = p.stats || {};
  if (p.status === 'accepted') return { score: 100, label: 'Won', reasons: [{ text: 'The client accepted the proposal', points: 0 }] };
  if (p.status === 'lost') return { score: 0, label: 'Lost', reasons: [{ text: 'Marked as lost', points: 0 }] };
  if (p.status === 'draft') return { score: null, label: 'Draft', reasons: [] };
  if (p.status === 'superseded') return { score: null, label: 'Replaced', reasons: [] };

  const reasons = [];
  let score = 30;
  const add = (points, text) => { score += points; reasons.push({ text, points }); };

  const sentAgo = p.sentAt ? now - new Date(p.sentAt) : null;
  const visitors = Number(s.visitors || 0), days = Number(s.days || 0), visits = Number(s.visits || 0);
  const seconds = Number(s.seconds || 0);
  const sections = s.sections || [];
  const lastAgo = s.last_view ? now - new Date(s.last_view) : null;

  if (visitors === 0 && !visits) {
    if (sentAgo !== null && sentAgo < 2 * DAY) return { score: null, label: 'Waiting', reasons: [{ text: 'Just sent: the client has had less than 2 days to open it', points: 0 }] };
    add(-15, 'Not opened since it was sent');
    if (sentAgo !== null && sentAgo > 3 * DAY) add(-20, 'Still unopened more than 3 days after sending');
  } else {
    add(15, 'The client opened the proposal');
    if (days >= 2) add(10, 'Came back on another day');
    if (visits >= 3) add(8, 'Opened three or more times');
    if (seconds >= 60) add(8, 'Spent over a minute reading it');
    if (seconds >= 180) add(8, 'Spent over three minutes reading it');
    if (sections.includes('invest')) add(8, 'Looked at the pricing section');
    if (sections.includes('terms')) add(6, 'Read right to the end');
    if (Number(s.pdfs || 0) > 0) add(10, 'Downloaded the PDF');
    if (Number(s.ctas || 0) > 0) add(18, 'Asked to discuss it');
    if (visitors >= 2 || Number(s.devices || 0) >= 2) add(8, 'Opened by more than one person or device');
    if (lastAgo !== null) {
      if (lastAgo <= 2 * DAY) add(10, 'Looked at it in the last two days');
      else if (lastAgo > 14 * DAY) add(-20, 'No activity for over two weeks');
      else if (lastAgo > 7 * DAY) add(-10, 'No activity for over a week');
    }
  }
  if (p.status === 'negotiating') add(15, 'Marked as negotiating');

  score = Math.max(0, Math.min(100, Math.round(score)));
  const label = score >= 65 ? 'Hot' : score >= 35 ? 'Warm' : 'Cold';
  return { score, label, reasons };
}

module.exports = { interest };

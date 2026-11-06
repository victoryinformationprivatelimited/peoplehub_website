// Builds the proposal email: the sender's own message (with simple formatting), an optional price summary and link button.
const escH = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const BASE = () => (process.env.APP_BASE_URL || 'http://localhost:4400').replace(/\/+$/, '');

const ALLOWED_EXT = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', csv: 'text/csv', txt: 'text/plain' };

// Same writing format as the proposal wording: blank line = paragraph, "- " bullet, "## " heading, **bold**, [text](https://..), ![caption](img:ID)
function inline(s) {
  return escH(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[([^\]]{1,120})\]\((https?:\/\/[^\s)"'<>]{1,300})\)/g, '<a href="$2" style="color:#0b6b4f">$1</a>');
}
function rich(text) {
  let out = '';
  String(text || '').replace(/\r/g, '').split(/\n\s*\n/).forEach((block) => {
    const lines = block.split('\n');
    let n = 0;
    while (n < lines.length) {
      const ln = lines[n];
      const im = /^!\[([^\]]{0,120})\]\(img:([0-9a-f]{24})\)\s*$/.exec(ln);
      if (im) { out += `<p style="margin:12px 0"><img src="${BASE()}/img/${im[2]}" alt="${escH(im[1])}" style="max-width:100%;border-radius:6px">${im[1] ? `<br><span style="font-size:12px;color:#777">${escH(im[1])}</span>` : ''}</p>`; n++; }
      else if (/^## /.test(ln)) { out += `<p style="margin:14px 0 4px;font-weight:700;color:#0b6b4f">${inline(ln.slice(3))}</p>`; n++; }
      else if (/^- /.test(ln)) { const li = []; while (n < lines.length && /^- /.test(lines[n])) { li.push(`<li>${inline(lines[n].slice(2))}</li>`); n++; } out += `<ul style="margin:6px 0 10px;padding-left:20px">${li.join('')}</ul>`; }
      else if (!ln.trim()) n++;
      else { const p = []; while (n < lines.length && lines[n].trim() && !/^(## |- |!\[)/.test(lines[n])) { p.push(inline(lines[n])); n++; } out += `<p style="margin:0 0 10px">${p.join('<br>')}</p>`; }
    }
  });
  return out;
}

/** o: { includeSummary, includeLink, pdfAttached, hasFiles } */
function build(p, message, senderName, link, o) {
  const opt = { includeSummary: true, includeLink: true, pdfAttached: true, ...(o || {}) };
  const t = p.totals || {};
  const row = (k, v) => `<tr><td style="padding:6px 0;color:#555">${escH(k)}</td><td style="padding:6px 0;text-align:right;font-weight:600">${escH(v)}</td></tr>`;
  const card = opt.includeSummary || (opt.includeLink && link)
    ? `<div style="border:1px solid #ddd;border-radius:8px;padding:16px;margin:18px 0">
<div style="font-size:13px;color:#777">Proposal ${escH(p.ref_no)}</div>
<div style="font-size:18px;font-weight:700;margin:2px 0 ${opt.includeSummary ? '10px' : '0'}">PeopleHub HRIS for ${escH(p.client && p.client.name)}</div>
${opt.includeSummary ? `<table style="width:100%;border-collapse:collapse">${row('Monthly subscription', usd(t.monthlyRecurring))}${row('One-time charges', usd(t.oneTime))}</table>` : ''}
${opt.includeLink && link ? `<p style="margin:16px 0 0"><a href="${escH(link)}" style="display:inline-block;background:#0d9467;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">View your proposal online</a></p>` : ''}</div>`
    : '';
  const notes = [];
  if (opt.includeSummary) notes.push('Prices in USD and all-inclusive, with no other taxes or hidden costs.');
  if (opt.pdfAttached) notes.push('The full proposal is attached as a PDF.');
  if (opt.includeLink && link) notes.push('We note when this proposal is opened so we can follow up at the right time.');
  return `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:560px">
${rich(message)}
${card}
<p style="color:#555;font-size:13px">${notes.length ? notes.join(' ') + '<br>' : ''}Sent by ${escH(senderName)} on behalf of Victory Information (Pvt) Ltd.</p></div>`;
}

module.exports = { build, rich, ALLOWED_EXT };

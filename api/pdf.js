// Renders a saved proposal to PDF by opening the real proposal page in headless Chromium,
// so the PDF always matches what staff see on screen.
const puppeteer = require('puppeteer-core');
const jwt = require('jsonwebtoken');

const CHROME = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';
const PORT = process.env.PORT || 4400;

// One render at a time keeps memory use small on a modest server.
let chain = Promise.resolve();

async function render(userId, proposalId) {
  const job = chain.then(() => renderNow(userId, proposalId));
  chain = job.catch(() => {});
  return job;
}

async function renderNow(userId, proposalId) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions'],
  });
  try {
    const page = await browser.newPage();
    // Short-lived session for this one render, signed like a normal login
    const token = jwt.sign({ uid: userId }, process.env.SESSION_SECRET, { expiresIn: 120 });
    await page.setCookie({ name: 'vi_session', value: encodeURIComponent(token), url: `http://127.0.0.1:${PORT}/` });
    await page.goto(`http://127.0.0.1:${PORT}/tool/proposal.html?print=${encodeURIComponent(proposalId)}`, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForSelector('body[data-print-ready="1"] #docWrap .pg', { timeout: 20000 });
    await page.emulateMediaType('print');
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
    return Buffer.from(pdf);
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { render };

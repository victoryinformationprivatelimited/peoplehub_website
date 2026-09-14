const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4322;
const ROOT = __dirname;
const PRICING_CONFIG_PATH = path.join(ROOT, 'tool', 'pricing-config.json');
const MAX_CONFIG_BODY_BYTES = 512 * 1024;

const TYPES = {
  '.html': 'text/html',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.join(ROOT, urlPath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// Shared pricing/profit settings the Admin login saves in the PeopleHub proposal tool, so every
// General-login user on this server gets the same admin-configured cost & margin numbers.
// Not authenticated at this layer — the tool's own login gate decides who is allowed to POST;
// this endpoint just stores whatever JSON it's given.
function handlePricingConfig(req, res) {
  if (req.method === 'GET') {
    fs.readFile(PRICING_CONFIG_PATH, (err, data) => {
      if (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_CONFIG_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const parsed = JSON.parse(body);
        fs.mkdir(path.dirname(PRICING_CONFIG_PATH), { recursive: true }, () => {
          fs.writeFile(PRICING_CONFIG_PATH, JSON.stringify(parsed), (writeErr) => {
            if (writeErr) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'write failed' }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          });
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
      }
    });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
}

http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  if (urlPath === '/api/pricing-config') {
    handlePricingConfig(req, res);
    return;
  }
  serveStatic(req, res);
}).listen(PORT, () => console.log('PeopleHub website serving on port ' + PORT));

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4322;
const ROOT = __dirname;

const TYPES = {
  '.html': 'text/html',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

http.createServer((req, res) => {
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
}).listen(PORT, () => console.log('PeopleHub website serving on port ' + PORT));

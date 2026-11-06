// Copies the built sales deck (Presentation/dist) into ./present so the app can serve it to signed-in users.
//   node scripts/sync-deck.js           copy the existing build
//   node scripts/sync-deck.js --build   build the deck first (needs `npm install` inside Presentation/)
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const src = path.join(__dirname, '..', '..', 'Presentation');
const dist = path.join(src, 'dist');
const out = path.join(__dirname, '..', 'present');

if (process.argv.includes('--build')) {
  console.log('Building the presentation…');
  execSync('npm run build', { cwd: src, stdio: 'inherit' });
}
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('No build found at ' + dist + '. Run again with --build.');
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(dist, out, { recursive: true });
const count = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0);
console.log('Deck installed in ' + out + ' (' + count(out) + ' files).');

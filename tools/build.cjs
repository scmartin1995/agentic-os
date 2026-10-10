// Builds the app without ever leaving dist/ empty. vite writes into dist-next-<pid>/; only when that build succeeds
// (and has an index.html) does it replace dist/. The build being replaced is kept as dist-prev/, the last good
// build the window falls back to (electron/recovery.cjs). A failed or hung build leaves dist/ as it was.
// Run: npm run build
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const nextName = 'dist-next-' + process.pid; // one per run, so two builds at once don't wipe each other
const next = path.join(root, nextName);
const prev = path.join(root, 'dist-prev');
const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

// leftovers from builds that were killed
for (const n of fs.readdirSync(root)) if (/^dist-next/.test(n) && Date.now() - fs.statSync(path.join(root, n)).mtimeMs > 3600e3) rm(path.join(root, n));
rm(next);
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const r = spawnSync(process.execPath, [vite, 'build', '--outDir', nextName, '--emptyOutDir'], { cwd: root, stdio: 'inherit', timeout: 10 * 60 * 1000 });
if (r.status !== 0 || !fs.existsSync(path.join(next, 'index.html'))) {
  console.error('\nBuild failed' + (r.error ? ` (${r.error.message})` : '') + '. dist/ was left as it was.');
  rm(next);
  process.exit(1);
}

// swap: dist -> dist-prev, dist-next -> dist. If the second step fails, put the old one back.
const hadDist = fs.existsSync(dist);
if (hadDist) { rm(prev); fs.renameSync(dist, prev); }
try { fs.renameSync(next, dist); } catch (e) {
  if (hadDist) fs.renameSync(prev, dist);
  console.error('Could not swap the new build in: ' + e.message + '. dist/ was left as it was.');
  process.exit(1);
}
console.log('\ndist/ updated (previous build kept in dist-prev/).');

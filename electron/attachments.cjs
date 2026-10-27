// Files the user drops or pastes into the chat. Each one is copied into a folder outside the vault
// (so it never clutters the graph), one sub-folder per day, and Agentic OS reads it from there.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 25 * 1024 * 1024;

const dir = () => path.join(app.getPath('userData'), 'attachments');

function save(name, bytes) {
  const buf = Buffer.from(bytes);
  if (buf.length > MAX_BYTES) return { error: `That file is over ${MAX_BYTES / 1024 / 1024} MB.` };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = path.basename(String(name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'file';
  const dest = path.join(dir(), stamp.slice(0, 10), `${stamp.slice(11)}__${safe}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return { path: dest, name: safe };
}

// Only paths this module wrote are passed on to Agentic OS.
const isMine = (p) => typeof p === 'string' && path.resolve(p).startsWith(dir() + path.sep);

// Keep 30 days of attachments. Called once the window is up; one day's folder at a time, with a breath in between.
async function prune(days = 30) {
  let names = [];
  try { names = fs.readdirSync(dir()); } catch { return; } // nothing to prune
  const cutoff = Date.now() - days * 864e5;
  for (const d of names) {
    const t = Date.parse(d);
    if (isNaN(t) || t >= cutoff) continue;
    try { await fs.promises.rm(path.join(dir(), d), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* next launch */ }
    await new Promise((r) => setImmediate(r));
  }
}

module.exports = { save, isMine, dir, prune };

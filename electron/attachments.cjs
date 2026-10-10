// Files the user drops or pastes into the chat. Each one is copied into a folder outside the workspace
// (so it never clutters the graph), one sub-folder per day, and the assistant reads it from there.
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

// Only paths this module wrote are passed on to the assistant.
const isMine = (p) => typeof p === 'string' && path.resolve(p).startsWith(dir() + path.sep);

// Keep 30 days of attachments.
function prune(days = 30) {
  try {
    const cutoff = Date.now() - days * 864e5;
    for (const d of fs.readdirSync(dir())) {
      const t = Date.parse(d);
      if (!isNaN(t) && t < cutoff) fs.rmSync(path.join(dir(), d), { recursive: true, force: true });
    }
  } catch { /* nothing to prune */ }
}

module.exports = { save, isMine, dir, prune };

// Small JSON files in the app's data folder, and a plain log, shared by every module that keeps one.
// Before this each module had its own readJson/writeJson, and only settings.cjs wrote safely.
//  - writeJson: writes to a temporary file and renames it into place, so a crash or power cut mid-write leaves the
//    old file, never a half-written one.
//  - readJson: a missing file is normal (returns the default). A file that exists but won't parse is NOT normal: it
//    is logged to app.log and the default is returned, so a damaged file leaves a trace instead of vanishing.
//  - log: one line to app.log in the data folder (kept to about 2 MB, with one older copy, app.log.1). For things
//    that went wrong quietly; never for chat contents.
const fs = require('fs');
const path = require('path');

function dataDir() {
  try { return require('electron').app.getPath('userData'); } catch { return process.env.AOS_USERDATA || ''; } // outside Electron (a plain node test)
}

const LOG_MAX = 2 * 1024 * 1024;
function log(...parts) {
  try {
    const dir = dataDir();
    if (!dir) return;
    const file = path.join(dir, 'app.log');
    try { if (fs.statSync(file).size > LOG_MAX) fs.renameSync(file, file + '.1'); } catch { /* no log yet */ }
    const text = parts.map((p) => (p instanceof Error ? p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ').replace(/\s+/g, ' ').slice(0, 400);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
  } catch { /* a log that can't be written must never break the thing being logged */ }
}

function readJson(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return fallback; } // missing or unreadable: the normal "nothing saved yet"
  try { return JSON.parse(text); } catch (e) {
    // The next save would replace it with the default, so keep the damaged one beside it for recovery.
    try { fs.copyFileSync(file, `${file}.damaged`); } catch { /* best effort */ }
    log('damaged JSON file, using the default (copy kept as .damaged):', path.basename(file), e);
    return fallback;
  }
}

// pretty: indent by that many spaces (settings and dreams are read by people sometimes). Throws if it can't write.
function writeJson(file, value, pretty) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, pretty));
  fs.renameSync(tmp, file);
}

// The same, for the places where a failed save must not stop the work (a chat still works if it can't be saved).
// Returns whether it worked, and logs when it didn't.
function tryWriteJson(file, value, pretty) {
  try { writeJson(file, value, pretty); return true; } catch (e) { log('could not save', path.basename(file), e); return false; }
}

// The same safe write for a plain text file (the Notes and Action items panels write markdown into the workspace).
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

module.exports = { readJson, writeJson, tryWriteJson, writeText, log, dataDir };

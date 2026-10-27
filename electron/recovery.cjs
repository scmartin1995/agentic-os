// Keeps the window from ever sitting black. Loads the app page and, if that can't be shown, falls back instead of
// failing quietly:
//   - dist/ is missing or half-built (a build was running)   -> the last good build (dist-prev/), else a waiting page
//   - the page fails to load                                 -> try again, then the waiting page
//   - the window's process crashes                           -> reload it (up to 3 times a minute), then a message
//   - the page loads but draws nothing (script error at start-up) -> the last good build, else a message
// Every one of these is written to recovery.log in the app data folder so there is a record of why.
// Chats are not touched here; the page checkpoints them while they work (see saveChat in src/App.tsx).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..');
const DIST = () => process.env.AOS_DIST || path.join(ROOT, 'dist');
const PREV = () => DIST() + '-prev';
const PAGE = path.join(__dirname, 'recovery.html');
const hasPage = (d) => { try { return fs.statSync(path.join(d, 'index.html')).size > 0; } catch { return false; } };

function note(text) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'recovery.log'), `${new Date().toISOString()} ${text}\n`); } catch { /* a log that can't be written must not break recovery */ }
}

// win: the BrowserWindow. opts.devUrl: Vite dev server (no fallback needed). opts.blankAfterMs: how long to wait before
// checking the page drew something (tests shorten it).
function guard(win, { devUrl, blankAfterMs = 6000 } = {}) {
  const wc = win.webContents;
  let dir = null; // folder the page is loaded from right now, null while showing the recovery page
  let waiting = null; // timer polling for a usable build
  let crashes = [];
  let loadFails = 0;
  const alive = () => !win.isDestroyed();

  function showMessage(reason, retry) {
    if (!alive()) return;
    dir = null;
    note(`showing recovery page: ${reason}`);
    win.loadFile(PAGE, { query: { reason, retry: retry ? '1' : '' } }).catch(() => {});
    if (retry && !waiting) waiting = setInterval(() => { if (hasPage(DIST()) || hasPage(PREV())) { clearInterval(waiting); waiting = null; start('build is back'); } }, 1500);
  }

  function start(why, { skip } = {}) {
    if (!alive()) return;
    if (devUrl) { win.loadURL(devUrl); return; }
    const pick = [DIST(), PREV()].find((d) => d !== skip && hasPage(d));
    if (!pick) { showMessage('Waiting for the app files. Agentic OS is being rebuilt and will open on its own.', true); return; }
    if (why) note(`loading ${pick === DIST() ? 'dist' : 'dist-prev (last good build)'}: ${why}`);
    dir = pick;
    win.loadFile(path.join(pick, 'index.html')).catch(() => {});
  }

  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !dir) return; // -3: a navigation we cancelled ourselves
    note(`page failed to load (${code} ${desc}) from ${dir}`);
    const bad = dir;
    if (++loadFails > 3) { loadFails = 0; showMessage('The app page would not load. Close and reopen Agentic OS; if that fails, run npm run build in the app folder.', false); return; }
    setTimeout(() => start('retry after failed load', { skip: loadFails > 1 ? bad : undefined }), 1000);
  });

  wc.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return;
    const now = Date.now();
    crashes = crashes.filter((t) => now - t < 60000).concat(now);
    note(`window process gone: ${d.reason} (code ${d.exitCode}), crash ${crashes.length} in the last minute`);
    if (crashes.length > 3) { showMessage('Agentic OS\'s window keeps crashing, usually when the PC is out of memory. Close some programs, then close and reopen Agentic OS. Your chats are saved.', false); return; }
    setTimeout(() => start('reloading after the window process stopped'), 1000);
  });

  // Page loaded but nothing was drawn: the script died before React mounted. Fall back to the last good build once.
  wc.on('did-finish-load', () => {
    if (!dir) return;
    const loadedFrom = dir;
    setTimeout(async () => {
      if (!alive() || dir !== loadedFrom) return;
      let drew = true;
      try { drew = await wc.executeJavaScript(`!!document.getElementById('root') && document.getElementById('root').childElementCount > 0`); } catch { return; }
      if (drew) { loadFails = 0; return; }
      note(`page drew nothing (${loadedFrom})`);
      if (loadedFrom === DIST() && hasPage(PREV())) start('page drew nothing; using the last good build', { skip: DIST() });
      else showMessage('Agentic OS\'s page started but drew nothing. Close and reopen Agentic OS. If it stays blank, the last build is broken: run npm run build in the app folder.', false);
    }, blankAfterMs);
  });

  win.on('closed', () => { if (waiting) clearInterval(waiting); });
  return { start };
}

module.exports = { guard, hasPage, note };

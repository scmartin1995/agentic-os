// Tests for electron/recovery.cjs: the window never ends up black. Hidden window, temp folders, no real app files touched.
// Run:  node_modules\.bin\electron tools\test-recovery.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // keep running between the test windows

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, extra = '') => { console.log(ok ? 'ok   ' : 'FAIL ', name, extra); if (!ok) failed++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-recovery-'));
app.setPath('userData', path.join(tmp, 'userData')); // the log goes here, not into the real app's data
const page = (dir, body) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'index.html'), body); };
const good = (tag) => `<!doctype html><div id="root"></div><script>document.getElementById('root').innerHTML='<p id="tag">${tag}</p>'</script>`;
const blank = '<!doctype html><div id="root"></div><script>throw new Error("boom")</script>';
const tagOf = (win) => Promise.race([sleep(1000).then(() => 'HUNG'), win.webContents.executeJavaScript(`document.getElementById('tag') ? document.getElementById('tag').textContent : document.getElementById('title') ? 'RECOVERY:' + document.getElementById('title').textContent : 'NOTHING'`).catch(() => 'ERR')]); // a crashed window never answers
async function until(win, want, ms = 8000) { const t0 = Date.now(); let got; while (Date.now() - t0 < ms) { got = await tagOf(win); if (got === want || (want instanceof RegExp && want.test(got))) return got; await sleep(200); } return got; }

app.whenReady().then(async () => {
  try {
    const recovery = require('../electron/recovery.cjs');
    const make = (name, blankAfterMs = 600) => {
      process.env.AOS_DIST = path.join(tmp, name);
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      const g = recovery.guard(win, { blankAfterMs });
      return { win, g, dist: process.env.AOS_DIST };
    };

    // 1. nothing built yet: waiting page, then the app appears by itself once a build lands
    let t = make('a');
    t.g.start();
    check('no build: waiting page, not black', /Agentic OS is getting ready/.test(await until(t.win, /RECOVERY:/)));
    page(t.dist, good('A-built'));
    check('build lands: page loads on its own', (await until(t.win, 'A-built', 6000)) === 'A-built');
    t.win.destroy();

    // 2. dist half-built (empty), last good build present: loads the last good build
    t = make('b');
    page(t.dist + '-prev', good('B-prev'));
    t.g.start();
    check('no dist, dist-prev present: loads dist-prev', (await until(t.win, 'B-prev')) === 'B-prev');
    t.win.destroy();

    // 3. new build is broken (draws nothing): falls back to the last good build
    t = make('c');
    page(t.dist, blank);
    page(t.dist + '-prev', good('C-prev'));
    t.g.start();
    check('broken dist falls back to dist-prev', (await until(t.win, 'C-prev', 8000)) === 'C-prev');
    t.win.destroy();

    // 4. broken and nothing to fall back to: a message, not black
    t = make('d');
    page(t.dist, blank);
    t.g.start();
    check('broken dist, no fallback: restart message', (await until(t.win, /RECOVERY:Agentic OS needs a restart/, 8000)).startsWith('RECOVERY:Agentic OS needs a restart'));
    t.win.destroy();

    // 5. window process crashes: reloads itself
    t = make('e', 60000);
    page(t.dist, good('E-ok'));
    t.g.start();
    await until(t.win, 'E-ok');
    t.win.webContents.forcefullyCrashRenderer();
    check('crashed window reloads itself', (await until(t.win, 'E-ok', 10000)) === 'E-ok');
    t.win.destroy();

    // 6. the log says why
    const log = fs.readFileSync(path.join(app.getPath('userData'), 'recovery.log'), 'utf8');
    check('recovery.log records the events', /page drew nothing/.test(log) && /window process gone/.test(log) && /showing recovery page/.test(log));
  } catch (e) {
    check('test ran without throwing', false, e.stack);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Electron may still hold its cache files; the OS temp folder cleans up */ }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  app.exit(failed ? 1 : 0);
});

// Agentic OS - Electron main process.
// A normal movable, resizable window with no Windows title bar (the app draws its own, with window buttons).
// F11 toggles full screen. With the phone link on, closing the window tucks the assistant into the tray instead of quitting.
// Flags: --fullscreen, --capture=out.png (render hidden, save a screenshot, quit; add --disable-gpu when memory is short).
//
// Settings, chats and backups live in the app data folder (%APPDATA%\agentic-os); notes live in the workspace.
const { app, BrowserWindow, protocol, net, shell, session, dialog, Tray, Menu, nativeImage, powerSaveBlocker, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

if (process.env.AOS_USERDATA) app.setPath('userData', path.resolve(process.env.AOS_USERDATA)); // tests: a throwaway data folder

const settings = require('./settings.cjs');
const vault = require('./vault.cjs');
if (!process.env.AGENTIC_OS_VAULT && settings.get('vaultPath')) vault.setRoot(settings.get('vaultPath'));
const api = require('./api.cjs');
const providers = require('./providers.cjs');
const engine = require('./engine.cjs');
const usage = require('./usage.cjs');
const ledger = require('./ledger.cjs');
const voice = require('./voice.cjs');
const stt = require('./stt.cjs');
const attachments = require('./attachments.cjs');
const chats = require('./chats.cjs');
const insights = require('./insights.cjs');
const dreams = require('./dreams.cjs');
const history = require('./history.cjs');
const discord = require('./discord.cjs');
const connectors = require('./connectors.cjs');
const actions = require('./actions.cjs');
const remote = require('./remote.cjs');
const { toolsDir } = require('./paths.cjs');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(1);
const dlog = (...a) => { if (process.env.AOS_DEBUG) fs.appendFileSync(path.join(ROOT, 'aos-debug.log'), a.map(String).join(' ') + '\n'); };
const FULLSCREEN = args.includes('--fullscreen');
const CAPTURE = (args.find((a) => a.startsWith('--capture=')) || '').split('=')[1];
const DEV_URL = process.env.VITE_DEV_URL;
const ICON = path.join(ROOT, 'public', 'app.ico');

// vault:// serves files from inside the workspace only (images, pdf, html previews).
// models:// serves the wake-word model from the tools folder.
protocol.registerSchemesAsPrivileged([
  { scheme: 'vault', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'models', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

let win = null;
let quitting = false;
let tray = null;
let awake = null;

function createWindow() {
  // AOS_SIZE=750x850 sets the window size (debug: check narrow layouts in --capture runs).
  const [sw, sh] = (process.env.AOS_SIZE || '').split('x').map(Number);
  const w = new BrowserWindow({
    width: sw > 0 ? sw : 1480,
    height: sh > 0 ? sh : 920,
    minWidth: 380, minHeight: 520,
    show: !CAPTURE,
    fullscreen: FULLSCREEN && !CAPTURE,
    frame: false,
    backgroundColor: '#151716',
    title: 'Agentic OS',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true, // built-in PDF viewer
      backgroundThrottling: !CAPTURE, // a hidden capture window must keep painting
      // render with real animation frames, without showing a window. AOS_ONSCREEN=1 keeps the window hidden but uses the
      // normal on-screen drawing path (graphics card and all), for bugs that only show there.
      offscreen: !!CAPTURE && !process.env.AOS_ONSCREEN,
      additionalArguments: CAPTURE ? ['--aos-capture'] : [],
    },
  });
  w.setMenuBarVisibility(false);
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { e.preventDefault(); w.setFullScreen(!w.isFullScreen()); }
  });
  const tellMode = () => { if (!w.isDestroyed()) w.webContents.send('window:state', { full: w.isFullScreen(), max: w.isMaximized() }); };
  for (const ev of ['enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize']) w.on(ev, tellMode);
  w.webContents.on('did-finish-load', tellMode);
  if (CAPTURE) w.webContents.setAudioMuted(true); // test runs never make noise
  // Never a black window: falls back to the last good build or a waiting page (recovery.cjs).
  require('./recovery.cjs').guard(w, { devUrl: DEV_URL, blankAfterMs: Number(process.env.AOS_BLANK_MS) || 6000 }).start();

  // Links clicked inside previews never navigate the app window.
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (e, url) => { if (url !== w.webContents.getURL()) e.preventDefault(); });

  // With the phone link on, the window closing must not take the assistant (and the phone's connection) with it.
  w.on('close', (e) => {
    if (quitting || CAPTURE || !settings.get('remote').enabled) return;
    e.preventDefault();
    w.hide();
    ensureTray();
  });

  if (process.env.AOS_DEBUG) {
    w.webContents.on('console-message', (e) => dlog('[renderer]', e.level, e.message));
    w.webContents.on('preload-error', (_e, p, err) => dlog('[preload-error]', p, err));
  }
  if (CAPTURE) w.webContents.once('did-finish-load', () => setTimeout(() => capture(w).catch((e) => { dlog('[capture failed]', e && e.message); app.quit(); }), Number(process.env.AOS_SETTLE) || 4000));
  return w;
}

// Test runs only: drive the page (type, click, run a script), then save a screenshot and quit.
async function capture(w) {
  const js = (c) => w.webContents.executeJavaScript(c);
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  if (process.env.AOS_DEBUG) dlog('[probe]', await js(`(async () => { try { return JSON.stringify({ aos: typeof window.aos, info: await window.aos.vault.info(), status: await window.aos.brain.status() }); } catch (e) { return 'ERR ' + e.message; } })()`));
  if (process.env.AOS_PASTE) {
    const b64 = fs.readFileSync(process.env.AOS_PASTE).toString('base64');
    dlog('[paste]', await js(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      document.getElementById('ask').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 800));
      return document.querySelector('.attach-tray')?.textContent || '(no tray)';
    })()`));
  }
  if (process.env.AOS_CLICK_FIRST) for (const want of process.env.AOS_CLICK_FIRST.split('>')) { await clickText(js, want); await nap(900); }
  if (process.env.AOS_ASK) {
    // type a question, send it, wait for the assistant to finish (max 3 min); AOS_APPROVE=yes|no answers any card
    await js(`(() => { const i = document.getElementById('ask'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(i, ${JSON.stringify(process.env.AOS_ASK)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await nap(300);
    await js(`document.querySelector('[aria-label="Send"]')?.click()`);
    const t0 = Date.now();
    await nap(2500);
    while (Date.now() - t0 < 180000) {
      if (!(await js(`!!document.querySelector('[aria-label="Stop"]')`))) break;
      if (process.env.AOS_APPROVE) {
        const label = process.env.AOS_APPROVE === 'yes' ? 'Yes' : 'No';
        const clicked = await js(`(() => { const b = [...document.querySelectorAll('.approval button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (b) { b.click(); return true; } return false; })()`);
        if (clicked) dlog('[approval] clicked', label);
      }
      await nap(800);
    }
    await nap(1500);
    dlog('[ask] finished in', Date.now() - t0, 'ms');
    dlog('[ask] on screen:', await js(`[...document.querySelectorAll('.msg')].map((n) => n.className.replace('msg ', '') + ': ' + n.textContent.replace(/\\s+/g, ' ').slice(0, 160)).join(' || ')`));
    dlog('[audio clips]', await js('window.__aosAudio || 0'));
  }
  if (process.env.AOS_FAKE_MIC) {
    // wait for the spoken question to arrive and the assistant to finish (max 3 min)
    const t0 = Date.now();
    let seen = false;
    while (Date.now() - t0 < 180000) {
      const st = await js(`({ you: document.querySelectorAll('.msg.you').length, busy: !!document.querySelector('[aria-label="Stop"]') })`);
      if (st.you > 0) seen = true;
      if (seen && !st.busy) break;
      await nap(1000);
    }
    await nap(2000);
    dlog('[fake mic] question seen:', seen, 'after', Date.now() - t0, 'ms; heard:', await js(`document.querySelector('.msg.you')?.textContent || '(nothing)'`));
  }
  if (process.env.AOS_FAKE_EVENTS) {
    // play made-up brain events into the chat on screen (a reply, files being read) without asking a real question
    for (const evt of JSON.parse(fs.readFileSync(process.env.AOS_FAKE_EVENTS, 'utf8'))) { w.webContents.send('brain:event', evt); await nap(250); }
  }
  if (process.env.AOS_CLICK) for (const want of process.env.AOS_CLICK.split('>')) { await clickText(js, want); await nap(1400); }
  if (process.env.AOS_JS) dlog('[js]', JSON.stringify(await js(fs.readFileSync(process.env.AOS_JS, 'utf8')).catch((e) => 'ERR ' + e.message)));
  if (process.env.AOS_WAIT) await nap(Number(process.env.AOS_WAIT));
  const img = await w.webContents.capturePage();
  fs.writeFileSync(path.resolve(CAPTURE), img.toPNG());
  quitting = true;
  app.quit();
}
// Click the first button whose text starts with `want`, or whose aria-label or title is exactly it.
const clickText = (js, want) => js(`(() => { const b = [...document.querySelectorAll('button, [role="button"]')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(want)}) || b.getAttribute('aria-label') === ${JSON.stringify(want)} || b.getAttribute('title') === ${JSON.stringify(want)}); if (b) b.click(); return !!b; })()`);

// One the app at a time (test captures excepted, so they can run while it's open).
const firstCopy = CAPTURE ? true : app.requestSingleInstanceLock();
if (!firstCopy) app.quit();

function showWindow() { if (!win || win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
function ensureTray() {
  if (tray) return;
  try {
    tray = new Tray(nativeImage.createFromPath(ICON));
    tray.setToolTip('Agentic OS');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Agentic OS', click: showWindow },
      { type: 'separator' },
      { label: 'Quit Agentic OS', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  } catch { /* no tray: the window still reopens from the shortcut */ }
}
// Phone link on: serve the phone, stay in the tray, and keep the PC from dozing off under it.
function applyRemote() {
  const on = !!settings.get('remote').enabled && (!CAPTURE || !!process.env.AOS_REMOTE_TEST); // AOS_REMOTE_TEST: let a test capture serve the phone view
  if (on) { remote.start(); ensureTray(); if (awake == null) awake = powerSaveBlocker.start('prevent-app-suspension'); }
  else { remote.stop(); if (awake != null) { powerSaveBlocker.stop(awake); awake = null; } }
  return remote.status();
}

// What a question cost and did, for the token dashboard and the meter. Used for questions asked at the PC,
// from a phone and by Discord DM.
function recordUsage(evt, work, chat) {
  if (evt.type === 'tool') { if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(evt.name)) work.edits++; else if (evt.path) work.reads++; }
  if (evt.type === 'result' && evt.usage) {
    // evt.costUsd is a running total on the Claude brain; the ledger works out this question's share (ledger.cjs).
    const own = ledger.add({
      model: (evt.models && evt.models[0]) || engine.status().model,
      asked: evt.asked, light: evt.light, kind: evt.kind, skills: evt.skills || [], ms: evt.ms, chat: typeof chat === 'string' ? chat.slice(0, 64) : null,
      input: evt.usage.input_tokens || 0, output: evt.usage.output_tokens || 0,
      cacheRead: evt.usage.cache_read_input_tokens || 0, cacheWrite: evt.usage.cache_creation_input_tokens || 0,
      total: evt.costUsd || 0, fresh: !!evt.fresh, ...work, error: !!evt.isError,
    });
    if (engine.mode() === 'api') usage.addCost(own); // on a plan, the windows are what matter
  }
  if (evt.type === 'limits') usage.setPlanWindow(evt.kind, evt.used, evt.resetsAt, evt.plan);
}

app.whenReady().then(() => {
  if (!firstCopy) return;
  // The microphone is allowed for this app's own window only.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media');

  // A malformed address (bad percent-escape) is a 404, not an exception.
  const pathOf = (req) => { try { return decodeURIComponent(new URL(req.url).pathname); } catch { return null; } };
  protocol.handle('models', (req) => {
    const p = pathOf(req);
    const file = p == null ? '' : path.join(toolsDir('models'), path.basename(p));
    return file && fs.existsSync(file) ? net.fetch(pathToFileURL(file).toString()) : new Response('Not found', { status: 404 });
  });
  protocol.handle('vault', (req) => {
    const p = pathOf(req);
    const abs = p == null ? null : vault.resolveInside(p.replace(/^\/+/, ''));
    return abs && fs.existsSync(abs) ? net.fetch(pathToFileURL(abs).toString()) : new Response('Not found', { status: 404 }); // a missing file (an unset avatar) is a 404, not an error
  });
  // Test runs only: AOS_FAKE_MIC=clip.wav plays a recording into the "microphone" instead of the real one.
  ipcMain.on('debug:fakeMic', (e) => { e.returnValue = CAPTURE && process.env.AOS_FAKE_MIC ? fs.readFileSync(process.env.AOS_FAKE_MIC).toString('base64') : null; });

  const R = { remote: true }; // the phone may call this too
  const h = api.handle;

  // ---- window (desktop only) ----
  h('window:state', (c) => { const w = BrowserWindow.fromWebContents(c.sender); return { full: !!w?.isFullScreen(), max: !!w?.isMaximized() }; });
  h('window:minimize', (c) => { BrowserWindow.fromWebContents(c.sender)?.minimize(); return true; });
  h('window:maximize', (c) => { const w = BrowserWindow.fromWebContents(c.sender); if (w) { if (w.isFullScreen()) w.setFullScreen(false); else if (w.isMaximized()) w.unmaximize(); else w.maximize(); } return true; });
  h('window:close', (c) => { BrowserWindow.fromWebContents(c.sender)?.close(); return true; });

  // ---- vault ----
  h('vault:info', () => vault.info(), R);
  h('vault:tree', () => vault.tree(), R);
  h('vault:graph', () => vault.graph(), R);
  h('vault:read', (_c, rel) => vault.read(rel), R);
  h('vault:skills', () => vault.skills(), R);
  h('vault:projects', () => vault.projects(), R);
  h('vault:openExternal', (_c, rel) => { const abs = vault.resolveInside(rel); return abs ? shell.openPath(abs) : 'outside vault'; });

  // ---- usage, panels ----
  h('usage:get', () => usage.get(engine.mode()), R);
  h('usage:ledger', () => ledger.summary(usage.get('plan').planName, engine.mode()), R);
  h('usage:setPlanPrice', (_c, v) => ledger.setPlanPrice(v), R);
  const discordCfg = () => discord.readConfig([ROOT, app.getPath('userData')]);
  let agyFound = null; // `where agy` once per run; installing it mid-run shows after a restart
  const skillCount = () => { try { return fs.readdirSync(path.join(ROOT, 'skills')).filter((n) => !n.startsWith('_') && fs.existsSync(path.join(ROOT, 'skills', n, 'SKILL.md'))).length; } catch { return null; } };
  const haveBuiltIn = () => {
    const d = discordCfg();
    if (agyFound == null) agyFound = !!providers.cliPath('agy');
    return { discord: !!(d.token && d.userId), whisper: stt.available(), piper: voice.available(), agy: agyFound, skills: skillCount(),
      wake: fs.existsSync(path.join(toolsDir('models'), 'vosk-model-small-en-us-0.15.tar.gz')), phone: remote.status().running };
  };
  h('connectors:summary', (_c, chatId) => connectors.summary(haveBuiltIn(), engine.loadedConnectors(chatId)), R);
  h('connectors:refresh', async (_c, chatId) => { await engine.refreshConnectors(); return connectors.summary(haveBuiltIn(), engine.loadedConnectors(chatId)); }, R);
  h('connectors:logo', (_c, name) => connectors.logo(name), R);
  h('connectors:setMode', (_c, m) => connectors.setMode(m), R);
  h('connectors:setPolicy', (_c, key, name, p) => connectors.setPolicy(String(key), String(name || ''), String(p)), R);
  h('insights:health', (_c, chatItems) => insights.health(Number(chatItems) || 0), R);
  h('insights:value', () => insights.value(usage.get('plan').planName), R);
  h('insights:setHourlyRate', (_c, v) => ledger.setHourlyRate(v), R);
  h('insights:setSkillMinutes', (_c, skill, v) => ledger.setSkillMinutes(skill, v), R);
  // Notes and Action items panels: plain markdown in the workspace, no AI (actions.cjs).
  h('actions:list', () => actions.list(), R);
  h('actions:close', (_c, project, raw) => actions.close(project, raw), R);
  h('actions:reopen', (_c, project, raw) => actions.reopen(project, raw), R);
  h('actions:update', (_c, project, raw, text) => actions.update(project, raw, text), R);
  h('notes:projects', () => actions.projects(), R);
  h('notes:list', (_c, project) => actions.notes(project || null), R);
  h('notes:add', (_c, project, text) => actions.addNote(project, text), R);
  h('notes:where', (_c, project) => actions.where(project), R);
  h('dreams:state', () => dreams.state(), R);
  h('dreams:run', () => { dreams.run('button'); return true; }, R);
  h('dreams:mark', (_c, day, id, status) => dreams.mark(day, id, status), R);
  h('dreams:setSettings', (_c, patch) => dreams.setSettings(patch), R);

  // ---- voice ----
  let muted = false;
  h('stt:status', () => ({ available: stt.available() }), R);
  h('stt:transcribe', (_c, pcm) => stt.transcribe(new Int16Array(pcm)), R);
  h('voice:status', () => ({ available: voice.available(), muted }), R);
  h('voice:mute', (_c, m) => { muted = !!m; return muted; }); // the PC's own speaker switch
  h('voice:settings', () => voice.settings(), R);
  h('voice:setSpeed', (_c, v) => voice.setSpeed(v), R);
  h('voice:preview', async () => {
    if (!voice.available()) return null;
    const wav = await voice.synth("Hello. This is how fast I will talk. You can change it here any time.");
    return wav ? wav.toString('base64') : null;
  }, R);

  // ---- the brain ----
  h('attach:save', (_c, name, bytes) => attachments.save(name, bytes), R);
  h('brain:status', () => ({ ...engine.status(), onboarded: !!settings.get('onboarded') }), R);
  // Several chats run side by side; every event is tagged with its chat id so each screen can file it.
  // Replies go to every screen (so the PC and a phone can both follow a chat); the voice goes only to whoever asked.
  h('brain:send', (c, text, speak, files, chat) => {
    const cid = typeof chat === 'string' && chat ? chat : 'default';
    const speaker = voice.createSpeaker((evt) => c.send('brain:event', { chat: cid, ...evt }));
    const talk = !!speak && (c.kind === 'remote' || !muted);
    const work = { reads: 0, edits: 0 };
    return engine.send(cid, text, (evt) => {
      recordUsage(evt, work, cid);
      discord.observe(evt, 'app'); // DMs the approval if it goes unanswered (discord.cjs)
      if (evt.type === 'text' && talk) speaker.feed(evt.text);
      if (evt.type === 'done' && talk) speaker.flush();
      if (evt.type === 'approval' && talk) speaker.feed(` Quick check. I want to ${evt.spoken}. Okay? `);
      api.broadcast('brain:event', { chat: cid, ...evt });
    }, (Array.isArray(files) ? files : []).filter(attachments.isMine));
  }, R);
  h('brain:stop', (_c, chat) => engine.stop(typeof chat === 'string' ? chat : undefined), R);
  h('brain:openChat', (_c, chat, sid) => engine.openChat(chat, sid), R);
  h('brain:approve', (_c, id, yes, question) => engine.approve(id, yes, question), R);
  h('chats:list', () => chats.list(), R);
  h('chats:load', (_c, id) => chats.load(id), R);
  h('chats:save', (_c, chat) => chats.save(chat), R);
  h('chats:remove', (_c, id) => { engine.closeChat(id); return chats.remove(id); }, R);

  // ---- setup: who you are, which brain, where the workspace is (desktop only, except reading the basics) ----
  const basics = () => { const s = settings.all(); return { onboarded: !!s.onboarded, userName: s.userName, assistantName: s.assistantName || 'Assistant', vaultPath: vault.ROOT, vaultSet: !!s.vaultPath, wakeWord: s.wakeWord !== false, budgets: s.budgets, openAtLogin: app.getLoginItemSettings().openAtLogin, version: app.getVersion() }; };
  h('setup:get', () => basics(), R);
  h('setup:set', (_c, patch) => {
    const p = patch || {};
    const next = {};
    if (typeof p.userName === 'string') next.userName = p.userName.trim().slice(0, 40);
    if (typeof p.assistantName === 'string') next.assistantName = p.assistantName.trim().slice(0, 30) || 'Assistant';
    if (typeof p.onboarded === 'boolean') next.onboarded = p.onboarded;
    if (typeof p.wakeWord === 'boolean') next.wakeWord = p.wakeWord;
    if (p.budgets && typeof p.budgets === 'object') next.budgets = { daily: Math.max(0, Number(p.budgets.daily) || 0), monthly: Math.max(0, Number(p.budgets.monthly) || 0) };
    if (typeof p.vaultPath === 'string' && p.vaultPath && fs.existsSync(p.vaultPath)) { next.vaultPath = path.resolve(p.vaultPath); vault.setRoot(next.vaultPath); api.broadcast('vault:changed', { outside: [] }); }
    if (typeof p.openAtLogin === 'boolean') app.setLoginItemSettings({ openAtLogin: p.openAtLogin });
    settings.set(next);
    return basics();
  });
  h('setup:pickFolder', async (c) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(c.sender), { title: 'Choose your notes folder', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = r.filePaths[0];
    let notes = 0;
    try { (function count(d, depth) { if (depth > 6 || notes > 5000) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.') || e.name === 'node_modules') continue; if (e.isDirectory()) count(path.join(d, e.name), depth + 1); else if (e.name.endsWith('.md')) notes++; } })(dir, 0); } catch { /* unreadable: say zero */ }
    return { path: dir, notes };
  });
  // A starter workspace for someone who has no notes folder yet: a copy of example-workspace/ from the app folder,
  // so it shows the layout the README describes. Files that already exist there are never overwritten.
  h('setup:starterVault', () => {
    const dir = path.join(app.getPath('documents'), 'Agentic OS');
    let notes = 0;
    (function copy(from, to) {
      fs.mkdirSync(to, { recursive: true });
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        const a = path.join(from, e.name), b = path.join(to, e.name);
        if (e.isDirectory()) copy(a, b);
        else { if (!fs.existsSync(b)) fs.copyFileSync(a, b); if (e.name.endsWith('.md')) notes++; }
      }
    })(path.join(ROOT, 'example-workspace'), dir);
    return { path: dir, notes };
  });
  h('setup:voice', () => ({ whisper: stt.available(), piper: voice.available(), wakeModel: fs.existsSync(path.join(toolsDir('models'), 'vosk-model-small-en-us-0.15.tar.gz')) }), R);

  h('providers:state', () => providers.state(), R);
  h('providers:test', (_c, o) => providers.test(o || {}));
  h('providers:save', (_c, o) => { const r = providers.save(o || {}); if (r.ok) api.broadcast('brain:event', { type: 'brainChanged' }); return r; });
  h('providers:forgetKey', (_c, id) => providers.forgetKey(id));
  h('providers:cliStatus', (_c, id) => providers.cliStatus(id));
  h('providers:openLogin', (_c, id) => providers.openLogin(id));
  h('providers:cliInstall', (_c, id) => providers.cliInstall(id));
  h('providers:openKeyPage', (_c, id) => { const u = providers.byId(id).keyUrl; if (u) shell.openExternal(u); return !!u; });

  // ---- Discord link (settings saved encrypted; v1's .env still works) ----
  h('discord:get', () => { const d = discordCfg(); return { configured: !!(d.token && d.userId), token: settings.hint('discord:token'), userId: settings.getSecret('discord:userId') || d.userId || '' }; });
  h('discord:set', (_c, o) => { if (o && typeof o.token === 'string' && o.token.trim()) settings.setSecret('discord:token', o.token.trim()); if (o && typeof o.userId === 'string') settings.setSecret('discord:userId', o.userId.trim()); return true; });
  h('discord:clear', () => { settings.setSecret('discord:token', ''); settings.setSecret('discord:userId', ''); return true; });

  // ---- phone link ----
  const qr = (url) => require('qrcode').toDataURL(url, { margin: 1, width: 260, color: { dark: '#041016', light: '#ffffff' } });
  const phone = async () => {
    const st = remote.status();
    const links = [];
    for (const a of st.addresses) { const url = `http://${a.address}:${st.port}${remote.pairPath()}`; links.push({ ...a, url, qr: await qr(url) }); }
    return { ...st, links };
  };
  h('phone:get', () => phone());
  h('phone:set', async (_c, o) => {
    const r = settings.get('remote');
    const port = o && Number(o.port) >= 1024 && Number(o.port) <= 65535 ? Math.round(Number(o.port)) : r.port;
    settings.set({ remote: { ...r, enabled: o && typeof o.enabled === 'boolean' ? o.enabled : r.enabled, port } });
    if (port !== r.port) remote.stop();
    applyRemote();
    await new Promise((res) => setTimeout(res, 300)); // let the port open (or fail) before reporting
    return phone();
  });
  h('phone:unpair', () => { remote.newToken(); return phone(); });
  // A pairing code for an address typed by hand (a Tailscale https name, say).
  h('phone:qr', async (_c, base) => {
    const b = String(base || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[\w.-]+(:\d+)?$/i.test(b)) return null;
    const url = b + remote.pairPath();
    return { url, qr: await qr(url) };
  });

  // Discord DMs (discord.cjs): approvals reach them when they're away, and they can chat with the assistant from their phone.
  // A DM after a long quiet spell (2 hours) starts a new chat, so one Discord chat never runs on for days.
  const DISCORD_NEW_CHAT_MS = 2 * 60 * 60 * 1000;
  let discordChat = 'discord';
  let discordLast = 0;
  if (!CAPTURE) discord.start({
    claude: engine, dirs: [ROOT, app.getPath('userData')], log: (...a) => dlog('[discord]', ...a),
    run: (text, sink) => {
      // Starting a message with "new chat" forces a new chat; whatever follows is the first question in it.
      const fresh = /^\s*new chat\b[\s:,.!-]*/i.exec(text);
      if (fresh) text = text.slice(fresh[0].length);
      if (fresh || (discordLast && Date.now() - discordLast > DISCORD_NEW_CHAT_MS)) discordChat = `discord-${Date.now()}`;
      discordLast = Date.now();
      if (!text.trim()) { sink({ type: 'start' }); sink({ type: 'text', text: 'New chat started. What do you need?' }); sink({ type: 'done' }); return Promise.resolve(); }
      const work = { reads: 0, edits: 0 };
      return engine.send(discordChat, text, (evt) => { recordUsage(evt, work, 'discord'); sink(evt); }, []);
    },
  });

  try { ledger.migrate(); } catch { /* the dashboard still opens */ }
  require('./policy.cjs').pruneBackups(); // keep 30 days of edit backups
  attachments.prune(); // and 30 days of dropped files
  win = createWindow();
  api.addSink((channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); });
  // A second launch (shortcut) just brings this window forward.
  app.on('second-instance', showWindow);
  require('./window.cjs').attach(() => win);
  applyRemote();
  // Plan check at launch (no tokens): the charge bar shows the plan and limits before the first question.
  if (!CAPTURE && settings.get('onboarded')) engine.refreshStartup((evt) => recordUsage(evt, { reads: 0, edits: 0 }, 'startup'))
    .then((ok) => { if (ok) api.broadcast('brain:event', { type: 'limits' }); }).catch(() => {});
  // Dreams: nightly at the chosen hour, or on the next launch if that was missed.
  if (!CAPTURE) dreams.start((evt) => api.broadcast('dreams:event', evt));
  setTimeout(() => history.load().catch(() => {}), 20000); // warm the session-log cache so panels open fast
  vault.watch((files) => {
    // Edits by someone other than the assistant get passed to them with their next question.
    const outside = files.filter((f) => f.endsWith('.md') && !engine.wroteRecently(f));
    if (outside.length) engine.noteOutsideChanges(outside);
    api.broadcast('vault:changed', { outside });
  });
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { voice.stop(); remote.stop(); app.quit(); });

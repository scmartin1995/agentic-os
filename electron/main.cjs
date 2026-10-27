// Agentic OS - Electron main process.
// A normal movable, resizable window with no Windows title bar (the app draws its own, with window buttons).
// F11 toggles full screen.
// Flags: --fullscreen, --capture=out.png (render hidden, save a screenshot, quit; add --disable-gpu when memory is short).
//
// Agentic OS keeps its own data folder (the system's app-data folder, under "agentic-os"), shared with no other app.
const { app, BrowserWindow, protocol, net, shell, session, dialog, ipcMain, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

app.setName('Agentic OS');
if (process.env.AOS_USERDATA) app.setPath('userData', path.resolve(process.env.AOS_USERDATA)); // tests: a throwaway data folder

const settings = require('./settings.cjs');
const vault = require('./vault.cjs');
if (!process.env.AOS_VAULT && settings.get('vaultPath')) vault.setRoot(settings.get('vaultPath'));
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
const search = require('./search.cjs');
const skillrun = require('./skillrun.cjs');
const mail = require('./mail.cjs');
const claudeEngine = require('./claude.cjs');
const jobs = require('./jobs.cjs');
const history = require('./history.cjs');
const discord = require('./discord.cjs');
const connectors = require('./connectors.cjs');
const tools = require('./tools.cjs');
const importV1 = require('./import-v1.cjs');
const actions = require('./actions.cjs');
const discover = require('./discover.cjs');
const okf = require('./okf.cjs');
const shared = require('./shared.cjs');
const { toolsDir } = require('./paths.cjs');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(1);
const dlog = (...a) => { if (process.env.AOS_DEBUG) fs.appendFileSync(path.join(ROOT, 'aos-debug.log'), a.map(String).join(' ') + '\n'); };
const FULLSCREEN = args.includes('--fullscreen');
const CAPTURE = (args.find((a) => a.startsWith('--capture=')) || '').split('=')[1];
const DEV_URL = process.env.VITE_DEV_URL;
const ICON = path.join(ROOT, 'public', process.platform === 'win32' ? 'app.ico' : 'app-icon-192.png');

// vault:// serves files from inside the vault only (images, pdf, html previews).
// models:// serves the wake-word model from the tools folder.
protocol.registerSchemesAsPrivileged([
  { scheme: 'vault', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'models', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

let win = null;
let quitting = false;

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
    backgroundColor: '#161616',
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
      additionalArguments: CAPTURE ? ['--aos-capture', ...(process.env.AOS_FAKE_OS ? [`--aos-os=${process.env.AOS_FAKE_OS}`] : [])] : [],
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
    // type a question, send it, wait for Agentic OS to finish (max 3 min); AOS_APPROVE=yes|no answers any card
    await js(`(() => { const i = document.getElementById('ask'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(i, ${JSON.stringify(process.env.AOS_ASK)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await nap(300);
    await js(`document.querySelector('[aria-label="Send"]')?.click()`);
    const t0 = Date.now();
    await nap(2500);
    while (Date.now() - t0 < 180000) {
      if (!(await js(`!!document.querySelector('[aria-label="Stop Agentic OS"]')`))) break;
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
    // wait for the spoken question to arrive and Agentic OS to finish (max 3 min)
    const t0 = Date.now();
    let seen = false;
    while (Date.now() - t0 < 180000) {
      const st = await js(`({ you: document.querySelectorAll('.msg.you').length, busy: !!document.querySelector('[aria-label="Stop Agentic OS"]') })`);
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
  // Test runs only: AOS_STEPS names a JSON file of steps run in order, each { js: file } (its result goes to the debug log),
  // { events: file } (made-up brain events played into the window) or { wait: ms }.
  if (process.env.AOS_STEPS) {
    const dir = path.dirname(path.resolve(process.env.AOS_STEPS));
    let n = 0;
    for (const st of JSON.parse(fs.readFileSync(process.env.AOS_STEPS, 'utf8'))) {
      n++;
      if (st.wait) await nap(st.wait);
      if (st.events) for (const evt of JSON.parse(fs.readFileSync(path.resolve(dir, st.events), 'utf8'))) { w.webContents.send('brain:event', evt); await nap(150); }
      if (st.js) dlog(`[step ${n}]`, JSON.stringify(await js(fs.readFileSync(path.resolve(dir, st.js), 'utf8')).catch((e) => 'ERR ' + e.message)));
    }
  }
  if (process.env.AOS_WAIT) await nap(Number(process.env.AOS_WAIT));
  const img = await w.webContents.capturePage();
  fs.writeFileSync(path.resolve(CAPTURE), img.toPNG());
  quitting = true;
  app.quit();
}
// Click the first button whose text starts with `want`, or whose aria-label or title is exactly it.
const clickText = (js, want) => js(`(() => { const b = [...document.querySelectorAll('button, [role="button"]')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(want)}) || b.getAttribute('aria-label') === ${JSON.stringify(want)} || b.getAttribute('title') === ${JSON.stringify(want)}); if (b) b.click(); return !!b; })()`);

// One Agentic OS at a time (test captures excepted, so they can run while it's open).
const firstCopy = CAPTURE ? true : app.requestSingleInstanceLock();
if (!firstCopy) app.quit();

function showWindow() { if (!win || win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }


// What a question cost and did, for the token dashboard and the meter.
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
    return abs ? net.fetch(pathToFileURL(abs).toString()) : new Response('Not found', { status: 404 });
  });
  // Test runs only: AOS_FAKE_MIC=clip.wav plays a recording into the "microphone" instead of the real one.
  ipcMain.on('debug:fakeMic', (e) => { e.returnValue = CAPTURE && process.env.AOS_FAKE_MIC ? fs.readFileSync(process.env.AOS_FAKE_MIC).toString('base64') : null; });

  const h = api.handle;

  // ---- window (desktop only) ----
  h('window:state', (c) => { const w = BrowserWindow.fromWebContents(c.sender); return { full: !!w?.isFullScreen(), max: !!w?.isMaximized(), min: !!w?.isMinimized() }; });
  h('window:minimize', (c) => { BrowserWindow.fromWebContents(c.sender)?.minimize(); return true; });
  h('window:maximize', (c) => { const w = BrowserWindow.fromWebContents(c.sender); if (w) { if (w.isFullScreen()) w.setFullScreen(false); else if (w.isMaximized()) w.unmaximize(); else w.maximize(); } return true; });
  h('window:close', (c) => { BrowserWindow.fromWebContents(c.sender)?.close(); return true; });

  // ---- vault ----
  // The folder tree, the link graph, the projects and the action items are only worked out again after the folder changes
  // (fresh.cjs); the screen asks for them several times over after every change, from several places.
  const fresh = require('./fresh.cjs');
  h('vault:info', () => vault.info());
  h('vault:tree', () => fresh.get('tree', () => vault.tree()));
  h('vault:graph', () => fresh.get('graph', () => vault.graph()));
  // Just the number of notes, for the side column; it used to build the whole link graph (243 KB) to count its nodes.
  h('vault:noteCount', () => fresh.get('noteCount', () => vault.listMarkdown().length));
  h('vault:read', (_c, rel) => vault.read(rel));
  h('vault:skills', () => vault.skills());
  h('vault:projects', () => fresh.get('projects', () => vault.projects()));
  // Projects panel corrections (.aos/panel-overrides.json). The watcher ignores dot-folders, so say so ourselves.
  h('vault:setOverride', (_c, rel, type) => { const r = vault.setOverride(rel, type ?? null); api.broadcast('vault:changed', { outside: [] }); return r; });
  h('vault:clearOverrides', (_c, projectRel) => { const r = vault.clearOverrides(projectRel); api.broadcast('vault:changed', { outside: [] }); return r; });
  h('vault:openExternal', (_c, rel) => { const abs = vault.resolveInside(rel); return abs ? shell.openPath(abs) : 'outside vault'; });
  // Show a note or folder in File Explorer (Finder on a Mac), selected, without opening it. Only inside the notes folder.
  h('vault:reveal', (_c, rel) => { const abs = vault.resolveInside(rel); if (!abs || !fs.existsSync(abs)) return false; shell.showItemInFolder(abs); return true; });

  // ---- Notes and Action items: plain markdown in the notes folder, no AI (actions.cjs) ----
  h('actions:list', () => fresh.get('actions', () => actions.list()));
  h('actions:close', (_c, project, raw) => actions.close(project, raw));
  h('actions:reopen', (_c, project, raw) => actions.reopen(project, raw));
  h('actions:update', (_c, project, raw, text) => actions.update(project, raw, text));
  h('notes:projects', () => actions.projects());
  h('notes:list', (_c, project) => actions.notes(project || null));
  h('notes:older', (_c, project) => actions.olderNotes(project || null));
  h('notes:add', (_c, project, text) => actions.addNote(project, text));
  h('notes:where', (_c, project) => actions.where(project));

  // ---- usage, panels ----
  h('usage:get', () => usage.get(engine.mode()));
  h('usage:ledger', () => ledger.summary(usage.get('plan').planName, engine.mode()));
  h('usage:setPlanPrice', (_c, v) => ledger.setPlanPrice(v));
  const discordCfg = () => discord.readConfig([ROOT, app.getPath('userData')]);
  const haveBuiltIn = () => { const d = discordCfg(); return { discord: !!(d.token && d.userId), whisper: stt.available(), piper: voice.available(), outlook: !!mail.state().lastPull }; };
  h('connectors:summary', () => connectors.summary(haveBuiltIn()));
  h('connectors:refresh', async () => { await engine.refreshConnectors(); return connectors.summary(haveBuiltIn()); });
  h('connectors:logo', (_c, name) => connectors.logo(name));
  h('connectors:setMode', (_c, m) => connectors.setMode(m));
  h('tools:summary', () => tools.summary());
  h('tools:disconnect', (_c, id) => tools.disconnect(String(id)));
  h('tools:reconnect', (_c, id) => tools.reconnect(String(id)));
  h('tools:removeCompletely', (_c, id) => tools.removeCompletely(String(id)));
  h('insights:health', (_c, chatItems) => insights.health(Number(chatItems) || 0));
  h('insights:value', () => insights.value(usage.get('plan').planName));
  h('insights:setHourlyRate', (_c, v) => ledger.setHourlyRate(v));
  h('insights:setSkillMinutes', (_c, skill, v) => ledger.setSkillMinutes(skill, v));
  // Search over the notes and saved chats (search.cjs). 'search:build' with { dry: true } is the quick no-AI refresh;
  // without it Haiku writes summaries for the notes that changed.
  h('search:query', async (_c, q, limit, scope) => { await search.ensureFresh(); return search.query(String(q || ''), { limit: Math.min(Number(limit) || 12, 30), scope: scope === 'all' ? 'all' : 'output' }); });
  h('search:status', () => search.status());
  h('search:review', (_c, limit) => search.reviewList(Number(limit) || 40));
  h('search:build', async (_c, opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    const t0 = Date.now();
    try {
      const r = await search.build({ dry: !!o.dry, only: typeof o.only === 'string' ? o.only : '', limit: Number(o.limit) || 0, oneShot: engine.oneShot });
      if (!o.dry) jobs.mark('searchIndex', { ok: !r.error, ms: Date.now() - t0, note: r.error || `${r.enriched} of ${r.notes} notes summarised` });
      return r;
    } catch (err) { jobs.mark('searchIndex', { ok: false, ms: Date.now() - t0, note: String((err && err.message) || err) }); throw err; }
  });
  // Run a skill without a chat (skillrun.cjs). 'skills:run' returns when the run ends; progress arrives as 'skills:event'.
  h('skills:run', (_c, skill, model) => skillrun.run({ skill, model, engine: claudeEngine, emit: (evt) => api.broadcast('skills:event', evt) }));
  h('skills:stop', (_c, skill) => skillrun.stop(skill));
  h('skills:state', () => skillrun.state());
  h('skills:recent', (_c, limit) => skillrun.recent(Number(limit) || 30));
  h('skills:test', () => skillrun.test(claudeEngine));
  // Mail (mail.cjs): last week from classic Outlook, read-only. 'mail:pull' returns when done; progress arrives as 'mail:event'.
  h('mail:state', () => mail.state());
  // Mail is searchable at once (dry: no model needed), but only when the pull changed what search holds: mail added, or a
  // reply closed (its text is dropped). A pull that found nothing new used to start a full pass of the notes folder all the
  // same, every 10 minutes; mail that failed to be read is not stored, so it changes nothing there either. (Mail that ages
  // out after 30 days leaves the index with the hourly pass.)
  const mailChangedSearch = (r) => !!r && !r.already && !!(r.added || r.closed);
  const refreshSearchAfterMail = (r) => { if (mailChangedSearch(r)) mail.checkWatch().catch(() => {}); return mailChangedSearch(r) ? search.build({ dry: true }) : null; };
  h('mail:pull', async () => { const r = await mail.pull({ oneShot: engine.oneShot, emit: (evt) => api.broadcast('mail:event', evt) }); await refreshSearchAfterMail(r); return r; });
  // Closing a reply tells every open view (dock badge, home widget) to re-read, not just the Mail panel.
  h('mail:dismiss', (_c, id) => { const r = mail.dismiss(id); api.broadcast('mail:event', { type: 'changed' }); return r; });
  h('mail:done', (_c, id) => { const r = mail.done(id); api.broadcast('mail:event', { type: 'changed' }); return r; });
  h('mail:checkWatch', async () => { const r = await mail.checkWatch(); api.broadcast('mail:event', { type: 'changed' }); return r; });
  h('mail:unwatch', (_c, id) => { const r = mail.unwatch(id); api.broadcast('mail:event', { type: 'changed' }); return r; });
  h('mail:openInOutlook', (_c, id) => mail.openInOutlook(id));
  h('dreams:state', () => dreams.state());
  h('dreams:run', () => { dreams.run('button'); return true; });
  h('dreams:mark', (_c, day, id, status) => dreams.mark(day, id, status));
  h('dreams:setSettings', (_c, patch) => dreams.setSettings(patch));

  // ---- voice ----
  let muted = false;
  h('stt:status', () => ({ available: stt.available() }));
  h('stt:transcribe', (_c, pcm) => stt.transcribe(new Int16Array(pcm)));
  h('voice:status', () => ({ available: voice.available(), muted }));
  h('voice:mute', (_c, m) => { muted = !!m; return muted; }); // the PC's own speaker switch
  h('voice:settings', () => voice.settings());
  h('voice:setSpeed', (_c, v) => voice.setSpeed(v));
  h('voice:preview', async () => {
    if (!voice.available()) return null;
    const wav = await voice.synth("This is how fast I will talk. Change the speed and I will use it from the next sentence.");
    return wav ? wav.toString('base64') : null;
  });

  // ---- the brain ----
  h('attach:save', (_c, name, bytes) => attachments.save(name, bytes));
  h('brain:status', () => ({ ...engine.status(), onboarded: !!settings.get('onboarded') }));
  // Several chats run side by side; every event is tagged with its chat id so each screen can file it.
  // Replies go to the window; the voice goes only to whoever asked.
  h('brain:send', (c, text, speak, files, chat) => {
    const cid = typeof chat === 'string' && chat ? chat : 'default';
    const speaker = voice.createSpeaker((evt) => c.send('brain:event', { chat: cid, ...evt }));
    const talk = !!speak && !muted;
    const work = { reads: 0, edits: 0 };
    return engine.send(cid, text, (evt) => {
      recordUsage(evt, work, cid);
      discord.observe(evt, 'app'); // DMs the approval if it goes unanswered (discord.cjs)
      if (evt.type === 'text' && talk) speaker.feed(evt.text);
      if (evt.type === 'done' && talk) speaker.flush();
      if (evt.type === 'approval' && talk) speaker.feed(` Quick check. I want to ${evt.spoken}. Okay? `);
      api.broadcast('brain:event', { chat: cid, ...evt });
    }, (Array.isArray(files) ? files : []).filter(attachments.isMine));
  });
  h('brain:refreshModels', (_c, force) => engine.refreshModels(!!force));
  h('brain:setPick', (_c, chat, model, effort) => engine.setPick(typeof chat === 'string' && chat ? chat : 'default', model, effort));
  h('brain:stop', (_c, chat) => engine.stop(typeof chat === 'string' ? chat : undefined));
  h('brain:openChat', (_c, chat, sid) => engine.openChat(chat, sid));
  h('brain:approve', (_c, id, yes, all, question) => engine.approve(id, yes, all, question));
  h('brain:allowEdits', (_c, v) => engine.setAllowEdits(v));
  h('chats:list', () => chats.list());
  h('chats:load', (_c, id) => chats.load(id));
  h('chats:save', (_c, chat) => chats.save(chat));
  h('chats:remove', (_c, id) => { engine.closeChat(id); return chats.remove(id); });

  // ---- setup: who you are, which brain, where the vault is (desktop only, except reading the basics) ----
  const basics = () => { const s = settings.all(); return { onboarded: !!s.onboarded, userName: s.userName, vaultPath: vault.ROOT, vaultSet: !!s.vaultPath, okfMode: okf.MODES.includes(s.okfMode) ? s.okfMode : null, wakeWord: s.wakeWord !== false, budgets: s.budgets, openAtLogin: app.getLoginItemSettings().openAtLogin, version: app.getVersion() }; };
  h('setup:get', () => basics());
  h('setup:set', (_c, patch) => {
    const p = patch || {};
    const next = {};
    if (typeof p.userName === 'string') next.userName = p.userName.trim().slice(0, 40);
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
  // A small starter vault for someone who has no notes folder yet.
  h('setup:starterVault', () => {
    const dir = path.join(app.getPath('documents'), 'Agentic OS Notes');
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
    const put = (rel, text) => { const f = path.join(dir, rel); if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); } };
    put('index.md', '# Notes\n\nYour notes live here. Agentic OS reads this page first, so link new pages from it.\n\n- [Projects](projects/index.md)\n- [Skills](skills/index.md)\n- [Log](log.md)\n');
    put('projects/index.md', '# Projects\n\nOne folder per project, each with a README.md. Link them here.\n');
    put('log.md', '# Log\n\nNewest first. Agentic OS adds an entry when it changes something.\n');
    put('agent-os/README.md', '# Rules for agents\n\n- Link every new page from the nearest index.md.\n- Add a dated entry to log.md after any change.\n- Say plainly when something is a guess.\n');
    // the starter skills (learning from each chat, tidying, model choice) and the manifest that lets the engine load them
    const starter = path.join(ROOT, 'starter');
    (function copy(from, rel) { for (const e of fs.readdirSync(from, { withFileTypes: true })) { const r = path.join(rel, e.name); if (e.isDirectory()) copy(path.join(from, e.name), r); else put(r, fs.readFileSync(path.join(from, e.name), 'utf8')); } })(starter, '');
    settings.set({ okfMode: 'index' }); // the starter folder is already in this shape
    return { path: dir, notes: 12 };
  });
  // "Agentic OS discover": a read-only look at the chosen folder (no AI, nothing written), then the user's OKF choice is applied.
  h('setup:discover', () => discover.scanAsync(vault.ROOT)); // on a background thread: the window never freezes
  h('setup:applyOkf', (_c, mode) => {
    if (!okf.MODES.includes(mode)) throw new Error('Unknown choice.');
    const r = okf.apply(vault.ROOT, mode, { starterDir: path.join(ROOT, 'starter'), onWrite: shared.markWritten });
    settings.set({ okfMode: mode });
    api.broadcast('vault:changed', { outside: [] });
    return r;
  });
  h('setup:v1', () => importV1.look());
  h('setup:importV1', (_c, want) => importV1.run(want));
  h('setup:voice', () => ({ whisper: stt.available(), piper: voice.available(), wakeModel: fs.existsSync(path.join(toolsDir('models'), 'vosk-model-small-en-us-0.15.tar.gz')) }));

  h('providers:state', () => providers.state());
  h('providers:test', (_c, o) => providers.test(o || {}));
  h('providers:save', (_c, o) => { const r = providers.save(o || {}); if (r.ok) api.broadcast('brain:event', { type: 'brainChanged' }); return r; });
  h('providers:importSettings', () => providers.importSettings());
  h('providers:applyImport', async () => { const r = await providers.applyImport(); if (r.ok) api.broadcast('brain:event', { type: 'brainChanged' }); return r; });
  h('providers:forgetKey', (_c, id) => providers.forgetKey(id));
  h('providers:cliStatus', () => providers.cliStatus());
  h('providers:openLogin', () => providers.openLogin());
  h('providers:openKeyPage', () => { const u = providers.byId().keyUrl; if (u) shell.openExternal(u); return !!u; });

  // Other models (workers.cjs): keys, gateway address, test. Dispatch itself is the ask_worker tool in claude.cjs.
  const workers = require('./workers.cjs');
  h('workers:state', () => workers.state());
  h('workers:test', (_c, o) => workers.test(o || {}));
  h('workers:save', (_c, o) => workers.save(o || {}));
  h('workers:forgetKey', (_c, id) => workers.forgetKey(String(id)));

  // ---- Discord link (settings saved encrypted; v1's .env still works) ----
  h('discord:get', () => { const d = discordCfg(); return { configured: !!(d.token && d.userId), token: settings.hint('discord:token'), userId: settings.getSecret('discord:userId') || d.userId || '' }; });
  h('discord:set', (_c, o) => { if (o && typeof o.token === 'string' && o.token.trim()) settings.setSecret('discord:token', o.token.trim()); if (o && typeof o.userId === 'string') settings.setSecret('discord:userId', o.userId.trim()); return true; });
  h('discord:clear', () => { settings.setSecret('discord:token', ''); settings.setSecret('discord:userId', ''); return true; });

  if (!CAPTURE) discord.start({
    claude: engine, dirs: [ROOT, app.getPath('userData')], log: (...a) => dlog('[discord]', ...a),
    run: (text, sink) => { const work = { reads: 0, edits: 0 }; return engine.send('discord', text, (evt) => { recordUsage(evt, work, 'discord'); sink(evt); }, []); },
  });

  try { ledger.migrate(); } catch { /* the dashboard still opens */ }
  // A Mac has a menu bar at the top of the screen whatever the window does, and Cmd+C, Cmd+V and Cmd+Q come from it.
  const menu = require('./platform.cjs').menuTemplate();
  if (menu) Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
  if (process.platform === 'darwin' && app.dock) {
    const big = path.join(ROOT, 'build', 'icon.png');
    try { app.dock.setIcon(nativeImage.createFromPath(fs.existsSync(big) ? big : path.join(ROOT, 'public', 'app-icon-192.png'))); } catch { /* the default icon stays */ }
  }
  win = createWindow();
  api.addSink((channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); });
  // A second launch (shortcut) just brings this window forward.
  app.on('second-instance', showWindow);
  require('./window.cjs').attach(() => win);
  // Plan check at launch (no tokens): the charge bar shows the plan and limits before the first question.
  if (!CAPTURE && settings.get('onboarded')) engine.refreshStartup((evt) => recordUsage(evt, { reads: 0, edits: 0 }, 'startup'))
    .then((ok) => { if (ok) api.broadcast('brain:event', { type: 'limits' }); }).catch(() => {});
  // Dreams: nightly at the chosen hour, or on the next launch if that was missed.
  if (!CAPTURE) dreams.start((evt) => api.broadcast('dreams:event', evt));
  if (!CAPTURE && process.platform === 'win32') mail.startDaily({ // reads classic Outlook: Windows only
    oneShot: engine.oneShot, emit: (evt) => api.broadcast('mail:event', evt), ready: () => !!require('./settings.cjs').get('onboarded'),
    after: refreshSearchAfterMail, onDone: (r) => jobs.mark('mailPull', r),
  });
  // Search index: kept up to date on its own; a failed run shows red in Health.
  if (!CAPTURE) search.startRoutine(engine.oneShot, (r) => jobs.mark('searchIndex', r));
  setTimeout(() => history.load().catch(() => {}), 20000); // warm the session-log cache so panels open fast
  // Housekeeping, once the window is up (it used to run before the window opened and held launch up for seconds):
  // 30 days of edit backups, a week of worker scratch folders (moved to the backups, not copied), 30 days of dropped files.
  // Each takes a breath between folders. Not in test captures, which must not move or delete anything.
  if (!CAPTURE) setTimeout(async () => {
    try { await require('./policy.cjs').pruneBackupsSoon(); await workers.pruneScratch(); await attachments.prune(); } catch (e) { require('./store.cjs').log('housekeeping stopped:', e); }
  }, 15000);
  vault.watch((files) => {
    // Edits by someone other than Agentic OS get passed to it with its next question.
    const outside = files.filter((f) => f.endsWith('.md') && !engine.wroteRecently(f));
    if (outside.length) engine.noteOutsideChanges(outside);
    api.broadcast('vault:changed', { outside });
  });
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { voice.stop(); app.quit(); });

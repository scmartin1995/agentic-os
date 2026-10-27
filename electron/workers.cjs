// Other models ("workers"): non-Claude models and coding agents Agentic OS can hand a job to, through the company
// gateway. Claude stays the brain; a worker is something Claude dispatches work to, after the user's yes.
//  - Settings > Other models: a key per worker (encrypted like the Brain key, settings.cjs) and the shared gateway address.
//  - claude.cjs `ask_worker`: the approval card, then run() below.
//  - Connectors & Tools lists each worker with its call counts (summary(), merged in by tools.cjs).
// First worker: Codex (an AGENT worker: a headless coding agent that acts on files). Each run happens in a scratch
// folder with copies of the files it needs; nothing in the notes folder is touched until Claude reviews the result
// and copies back what is worth keeping (through the normal backup path). The key reaches the program as an
// environment variable for that one run only.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { spawn, execFile } = require('child_process');
const settings = require('./settings.cjs');
const store = require('./store.cjs');
const vault = require('./vault.cjs');
const policy = require('./policy.cjs');

const DAY = 24 * 3600 * 1000;
const DEFAULT_BASE = '';
const RUN_LIMIT_MS = 15 * 60 * 1000;
const KEY_VAR = 'AOS_WORKER_KEY';

// kind: 'agent' acts on files in a scratch folder; 'model' (later) is one prompt in, one answer out.
const CATALOG = [
  {
    id: 'codex', name: 'Codex', kind: 'agent', bin: 'codex', pkg: '@openai/codex', color: '#4589ff',
    blurb: "OpenAI's coding agent, run headless. Reads and edits files in a scratch copy and reports back.",
    // Documented, not observed: filled in from the vendor's docs; the observed column in agent-os/Worker_Strengths.md starts empty.
    goodFor: 'Multi-file code changes, refactors, writing and running tests, scripts.',
  },
];
const byId = (id) => CATALOG.find((w) => w.id === id) || null;

const dataFile = (n) => path.join(store.dataDir(), n);
const secretName = (id) => `worker:${id}`;
const config = () => {
  const c = store.readJson(dataFile('workers.json'), {});
  return { baseUrl: c.baseUrl || DEFAULT_BASE, items: c.items && typeof c.items === 'object' ? c.items : {} };
};
const saveConfig = (c) => store.writeJson(dataFile('workers.json'), c);
const itemOf = (c, id) => ({ model: '', wireApi: 'responses', goodFor: '', enabled: true, ...(c.items[id] || {}) });

// ---- is the program on this PC? ----
function installed(id) {
  const w = byId(id);
  return new Promise((resolve) => {
    if (!w) return resolve(false);
    execFile(process.platform === 'win32' ? 'where' : 'which', [w.bin], { windowsHide: true, timeout: 8000 }, (err, out) => resolve(!err && !!String(out || '').trim()));
  });
}

// ---- what Settings shows ----
async function state() {
  const c = config();
  const items = [];
  for (const w of CATALOG) {
    const it = itemOf(c, w.id);
    items.push({ id: w.id, name: w.name, kind: w.kind, blurb: w.blurb, pkg: w.pkg, color: w.color, defaultGoodFor: w.goodFor,
      model: it.model, wireApi: it.wireApi, goodFor: it.goodFor, enabled: it.enabled !== false,
      key: settings.hint(secretName(w.id)), installed: await installed(w.id) });
  }
  return { baseUrl: c.baseUrl, encrypted: settings.canEncrypt(), items };
}

function save({ id, key, baseUrl, model, wireApi, goodFor, enabled }) {
  const w = byId(id);
  if (!w) return { ok: false, error: 'No worker with that id.' };
  const c = config();
  if (typeof baseUrl === 'string' && baseUrl.trim()) {
    if (!/^https?:\/\//i.test(baseUrl.trim())) return { ok: false, error: 'That address should start with https:// (or http://).' };
    c.baseUrl = baseUrl.trim().replace(/\/+$/, '');
  }
  const it = itemOf(c, id);
  if (typeof model === 'string') it.model = model.trim();
  if (wireApi === 'responses' || wireApi === 'chat') it.wireApi = wireApi;
  if (typeof goodFor === 'string') it.goodFor = goodFor.trim().slice(0, 400);
  if (typeof enabled === 'boolean') it.enabled = enabled;
  c.items[id] = it;
  if (typeof key === 'string' && key.trim()) settings.setSecret(secretName(id), key.trim());
  saveConfig(c);
  return { ok: true };
}
function forgetKey(id) { settings.setSecret(secretName(id), ''); return true; }

// Same trick as providers.cjs: Chromium's network stack trusts the company certificates and proxy.
function netFetch(url, opts) {
  try { const { net } = require('electron'); if (net && app.isReady()) return net.fetch(url, opts); } catch { /* not in Electron */ }
  return fetch(url, opts);
}

// Free check: ask the gateway for its model list with this worker's key.
async function test({ id, key, baseUrl }) {
  const w = byId(id);
  if (!w) return { ok: false, error: 'No worker with that id.' };
  const k = String(key || '').trim() || settings.getSecret(secretName(id));
  const base = String(baseUrl || '').trim().replace(/\/+$/, '') || config().baseUrl;
  if (!k) return { ok: false, error: 'Paste the key first.' };
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'That address should start with https:// (or http://).' };
  try {
    const res = await netFetch(`${base}/models`, { headers: { Authorization: `Bearer ${k}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'The gateway did not accept that key. Check it is the one for this tool.' };
    if (!res.ok) return { ok: false, error: `The gateway answered with an error (${res.status}).` };
    const body = await res.json().catch(() => null);
    if (!body) return { ok: false, error: 'The address answered, but not with a model list. It may not be the OpenAI-style address; check it with the key page.' };
    const models = (body.data || body.models || []).map((m) => String(m.id || m.name || m)).filter(Boolean).sort();
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: `Could not reach the gateway: ${String((err && err.message) || err)}` };
  }
}

// ---- call log (counts for Connectors & Tools; what was asked is never kept) ----
const logFile = () => dataFile('worker-calls.json');
function logCall(id, ok, ms) {
  const l = store.readJson(logFile(), []);
  const calls = Array.isArray(l) ? l : [];
  calls.push({ t: Date.now(), id, ok: !!ok, ms: Math.round(ms) });
  store.writeJson(logFile(), calls.slice(-2000));
}
// Rows shaped like tools.cjs's, so the panel draws them the same way.
async function summaryRows() {
  const calls = store.readJson(logFile(), []);
  const now = Date.now();
  const c = config();
  const rows = [];
  for (const w of CATALOG) {
    const key = settings.hint(secretName(w.id));
    if (!key.saved && !(Array.isArray(calls) ? calls : []).some((x) => x.id === w.id)) continue; // not set up and never used: nothing to show
    const r = { id: `worker-${w.id}`, name: w.name, icon: null, skills: [], worker: true, kind: w.kind, active: itemOf(c, w.id).enabled !== false,
      color: w.color, total: 0, d7: 0, d30: 0, last: 0, days: Array(14).fill(0) };
    for (const x of Array.isArray(calls) ? calls : []) {
      if (x.id !== w.id) continue;
      r.total++;
      if (now - x.t < 7 * DAY) r.d7++;
      if (now - x.t < 30 * DAY) r.d30++;
      r.last = Math.max(r.last, x.t);
      const age = Math.floor((now - x.t) / DAY);
      if (age < 14) r.days[13 - age]++;
    }
    rows.push(r);
  }
  return rows;
}

// ---- running an agent worker ----
const scratchRoot = () => path.join(app.getPath('userData'), 'worker-scratch');

function tomlStr(s) { return JSON.stringify(String(s)); } // a JSON string is a valid TOML basic string

// Codex reads its provider from $CODEX_HOME/config.toml. A private CODEX_HOME per run keeps the gateway settings out of
// the user's own ~/.codex and leaves their Codex sign-in alone.
function codexConfig(base, it) {
  return [
    it.model ? `model = ${tomlStr(it.model)}` : '',
    'model_provider = "gateway"',
    '[model_providers.gateway]',
    'name = "Gateway"',
    `base_url = ${tomlStr(base)}`,
    `env_key = ${tomlStr(KEY_VAR)}`,
    `wire_api = ${tomlStr(it.wireApi || 'responses')}`,
    // Windows: the default (elevated) sandbox cannot write in the scratch folder, so Codex ends up read-only.
    '[windows]',
    'sandbox = "unelevated"',
    '',
  ].filter((l, i) => l !== '' || i > 0).join('\n');
}

function snapshot(dir) {
  const out = new Map();
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.codex-home' || e.name === '.worker-last-message.txt') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = fs.statSync(p); out.set(path.relative(dir, p).split(path.sep).join('/'), `${s.size}:${Math.floor(s.mtimeMs)}`); }
    }
  })(dir);
  return out;
}

// Returns { ok, error?, text, changed: [rel], dir, ms }. Files are vault-relative paths (files or folders) copied into the
// scratch folder under the same relative path.
async function run({ id, task, files = [], signal }) {
  const w = byId(id);
  if (!w) return { ok: false, error: 'No worker with that id.' };
  const c = config();
  const it = itemOf(c, id);
  const key = settings.getSecret(secretName(id));
  if (!key) return { ok: false, error: `No key is saved for ${w.name}. Add it in Settings > Other models.` };
  if (it.enabled === false) return { ok: false, error: `${w.name} is switched off in Settings > Other models.` };
  if (!(await installed(id))) return { ok: false, error: `${w.name} is not installed on this PC yet (npm install -g ${w.pkg}).` };

  const t0 = Date.now();
  const dir = path.join(scratchRoot(), `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}_${id}`);
  const home = path.join(dir, '.codex-home');
  const outFile = path.join(dir, '.worker-last-message.txt');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), codexConfig(c.baseUrl, it));

  const copied = [];
  for (const rel of files) {
    const abs = vault.resolveInside(String(rel).replace(/\\/g, '/'));
    if (!abs || !fs.existsSync(abs)) continue;
    const to = path.join(dir, path.relative(vault.ROOT, abs));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(abs, to, { recursive: true });
    copied.push(path.relative(vault.ROOT, abs).split(path.sep).join('/'));
  }
  const before = snapshot(dir);

  const cmd = `${w.bin} exec --skip-git-repo-check --sandbox workspace-write --ephemeral -C "${dir}" -o "${outFile}" -`;
  const res = await new Promise((resolve) => {
    let log = '';
    let done = false;
    const child = spawn(cmd, { shell: true, windowsHide: true, cwd: dir, env: { ...process.env, CODEX_HOME: home, [KEY_VAR]: key } });
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(r); };
    const kill = () => { try { if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); else child.kill('SIGKILL'); } catch { /* already gone */ } };
    const onAbort = () => { kill(); finish({ code: null, log, stopped: true }); };
    const timer = setTimeout(() => { kill(); finish({ code: null, log, timedOut: true }); }, RUN_LIMIT_MS);
    signal?.addEventListener('abort', onAbort);
    child.stdout.on('data', (d) => { log = (log + d).slice(-6000); });
    child.stderr.on('data', (d) => { log = (log + d).slice(-6000); });
    child.on('error', (e) => finish({ code: -1, log: String(e.message || e) }));
    child.on('close', (code) => finish({ code, log }));
    child.stdin.on('error', () => {});
    child.stdin.end(String(task));
  });

  const after = snapshot(dir);
  const changed = [...after.keys()].filter((k) => before.get(k) !== after.get(k)).sort();
  let text = '';
  try { text = fs.readFileSync(outFile, 'utf8').trim(); } catch { /* no final message written */ }
  const ms = Date.now() - t0;
  const ok = res.code === 0 && !res.timedOut && !res.stopped;
  logCall(id, ok, ms);
  const why = res.stopped ? 'It was stopped.' : res.timedOut ? `It ran past ${RUN_LIMIT_MS / 60000} minutes and was stopped.` : res.code === 0 ? '' : `${w.name} exited with an error. Last output: ${String(res.log || '').trim().slice(-1200)}`;
  return { ok, error: ok ? '' : why, text, changed, copied, dir, ms };
}

// Scratch folders older than a week go to the backup folder (kept 30 days there, so still undoable). Each is one move,
// not a copy: a single Codex folder holds thousands of small files, and copying them held the app up for seconds. Called
// once the window is up, and gives the app a breath between folders. Returns how many were moved.
async function pruneScratch() {
  let moved = 0;
  let names = [];
  try { names = fs.readdirSync(scratchRoot()); } catch { return 0; } // none yet
  for (const n of names) {
    const p = path.join(scratchRoot(), n);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > 7 * DAY && policy.moveToBackup(p)) moved++;
    } catch { /* gone, or in use: next launch */ }
    await new Promise((r) => setImmediate(r));
  }
  return moved;
}

module.exports = { CATALOG, byId, state, save, forgetKey, test, run, summaryRows, scratchRoot, pruneScratch, installed };

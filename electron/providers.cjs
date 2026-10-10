// Which LLM is the assistant's brain, and how the user signs in to it.
//
// Every provider can be reached one of two ways, and onboarding offers whichever exist:
//   - "subscription": the user's own paid plan, signed in through the provider's OWN sign-in flow in its own
//     official command-line app (Claude Code, Codex, Gemini CLI). This app opens that flow in a terminal window and
//     afterwards only asks "are you signed in?". It never sees, reads or stores the login.
//   - "key": an API key the user pastes. It is checked with a free "list models" call, then saved encrypted
//     (settings.cjs). It is only ever sent to that provider's own address.
//   - "local": a model server on this PC (Ollama, LM Studio). No login.
//
// Engines (who does the work):
//   claude    - Claude Agent SDK (claude.cjs). Everything: connectors, helper agents, plan meter.
//   universal - this app's own agent loop over any OpenAI-compatible API (universal.cjs). Same tools, same
//               ask-first gate and backups; no claude.ai connectors or helpers.
//   codex / agycli (geminicli is kept but no longer offered) - the provider's CLI does the work in its own sandbox (cli-engine.cjs). Chat and file work;
//               the CLI's own safety rules apply instead of the assistant's cards. Not yet tested against the real CLIs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const settings = require('./settings.cjs');

const CATALOG = [
  {
    id: 'claude', name: 'Claude', by: 'Anthropic', color: '#d97757', level: 'full',
    methods: ['subscription', 'key'], engine: { subscription: 'claude', key: 'claude' },
    keyUrl: 'https://console.anthropic.com/settings/keys', keyLooks: 'sk-ant-…',
    blurb: 'Everything the app can do: connected apps, helper agents and the plan meter.',
    subscription: 'Your Claude Pro or Max plan, through Claude Code.',
  },
  {
    id: 'openai', name: 'ChatGPT', by: 'OpenAI', color: '#10a37f', level: 'core',
    methods: ['subscription', 'key'], engine: { subscription: 'codex', key: 'universal' },
    baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', keyLooks: 'sk-…',
    cli: { cmd: 'codex', pkg: '@openai/codex', login: 'codex login', name: 'Codex' },
    blurb: 'Chat, files, edits with backups, voice and the ask-first cards.',
    subscription: 'Your ChatGPT Plus or Pro plan, through OpenAI\'s Codex app.',
  },
  {
    // Google closed the Gemini CLI to free personal accounts ("client no longer supported", seen 2026-10-07), so
    // Gemini is key-only here. The Google account sign-in lives under Antigravity below.
    id: 'gemini', name: 'Gemini', by: 'Google (API key)', color: '#4c8df6', level: 'core',
    methods: ['key'], engine: { key: 'universal' },
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey', keyLooks: 'AIza…',
    blurb: 'Chat, files, edits with backups, voice and the ask-first cards.',
  },
  {
    id: 'antigravity', name: 'Antigravity', by: 'Google account', color: '#8b7cf6', level: 'core',
    methods: ['subscription'], engine: { subscription: 'agycli' },
    cli: { cmd: 'agy', pkg: 'Google.AntigravityCLI', install: 'winget install --id Google.AntigravityCLI -e --accept-source-agreements --accept-package-agreements', login: 'agy', name: 'Antigravity CLI' },
    blurb: 'Your Google account, through Google\'s Antigravity command line. Also draws pictures.',
    subscription: 'Your Google account, through Google\'s Antigravity CLI (agy).',
  },
  {
    id: 'local', name: 'On this PC', by: 'Ollama or LM Studio', color: '#a3a3a3', level: 'core',
    methods: ['local'], engine: { local: 'universal' },
    baseUrl: 'http://localhost:11434/v1',
    blurb: 'A model running on this computer. Private and free; needs a model that can use tools.',
  },
  {
    id: 'custom', name: 'Another provider', by: 'OpenRouter, Groq, xAI, Mistral, DeepSeek…', color: '#c4b5fd', level: 'core',
    methods: ['key'], engine: { key: 'universal' }, baseUrl: '',
    presets: [
      { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1' }, { name: 'Groq', url: 'https://api.groq.com/openai/v1' },
      { name: 'xAI', url: 'https://api.x.ai/v1' }, { name: 'Mistral', url: 'https://api.mistral.ai/v1' },
      { name: 'DeepSeek', url: 'https://api.deepseek.com/v1' },
    ],
    blurb: 'Any service that speaks the OpenAI API. Paste its address and key.',
  },
];
const byId = (id) => CATALOG.find((p) => p.id === id) || CATALOG[0];

// What the window is allowed to see: the catalog, the saved choice, and whether a key is saved (never the key).
function state() {
  const p = settings.get('provider');
  const def = byId(p.id);
  return {
    catalog: CATALOG.map(({ engine, ...c }) => ({ ...c, engines: engine })),
    current: { id: def.id, method: p.method, baseUrl: p.baseUrl || def.baseUrl || '', models: p.models, engine: def.engine[p.method] || 'claude', key: settings.hint(`key:${def.id}`), price: p.price || null },
    encrypted: settings.canEncrypt(),
  };
}

// The resolved brain, for the engines (main process only: includes the key).
function active() {
  const p = settings.get('provider');
  const def = byId(p.id);
  const method = def.methods.includes(p.method) ? p.method : def.methods[0];
  const envKey = { openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' }[def.id];
  return {
    id: def.id, name: def.name, method, engine: def.engine[method],
    baseUrl: String(p.baseUrl || def.baseUrl || '').replace(/\/+$/, ''),
    key: method === 'key' ? settings.getSecret(`key:${def.id}`) || (envKey ? settings.envOr(envKey) : '') : '',
    models: p.models || {}, price: p.price || null, cli: def.cli || null,
  };
}

// ---------- API keys ----------
const NOT_CHAT = /embed|tts|whisper|dall-?e|image|audio|realtime|moderation|transcri|rerank|guard|babbage|davinci|instruct|computer-use|sora|veo|imagen|aqa|learnlm/i;
const LIGHT = /mini|flash|haiku|nano|small|lite|instant|8b|:1b|:3b/i;
const STRONG = /opus|ultra|-pro\b|pro$|max|large|heavy|fable|reason/i;

// Pick sensible starting models from a provider's own list: a quick cheap one, an everyday one, a strong one.
// Newest first when the list carries dates. The user can change all three in Settings.
function suggest(models) {
  const chat = models.filter((m) => !NOT_CHAT.test(m.id));
  const sorted = [...chat].sort((a, b) => (b.created || 0) - (a.created || 0));
  const light = sorted.find((m) => LIGHT.test(m.id));
  const standard = sorted.find((m) => !LIGHT.test(m.id) && !STRONG.test(m.id)) || sorted.find((m) => !LIGHT.test(m.id)) || sorted[0];
  const strong = sorted.find((m) => STRONG.test(m.id) && !LIGHT.test(m.id) && m !== standard);
  return { light: (light || standard || {}).id || '', standard: (standard || {}).id || '', strong: (strong || {}).id || '' };
}

// Free check that a key (or a local server) works: ask for the model list. Returns { ok, models, suggested, error }.
async function test({ id, key, baseUrl }) {
  const def = byId(id);
  key = String(key || '').trim() || (def.methods.includes('key') ? settings.getSecret(`key:${def.id}`) : '');
  const base = String(baseUrl || def.baseUrl || '').trim().replace(/\/+$/, '');
  try {
    let url, headers;
    if (def.id === 'claude') {
      if (!key) return { ok: false, error: 'Paste your key first.' };
      url = 'https://api.anthropic.com/v1/models?limit=100';
      headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    } else {
      if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'That address should start with http:// or https://.' };
      if (!key && def.id !== 'local') return { ok: false, error: 'Paste your key first.' };
      url = base + '/models';
      headers = key ? { Authorization: `Bearer ${key}` } : {};
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'That key was not accepted. Check it was copied whole and is still active.' };
    if (!res.ok) return { ok: false, error: `The service answered with an error (${res.status}).` };
    const body = await res.json();
    const list = (Array.isArray(body) ? body : body.data || body.models || []).map((m) => ({ id: String(m.id || m.name || '').replace(/^models\//, ''), created: Number(m.created) || Date.parse(m.created_at || '') / 1000 || 0 })).filter((m) => m.id);
    if (!list.length) return { ok: def.id !== 'local', models: [], suggested: { light: '', standard: '', strong: '' }, error: def.id === 'local' ? 'The server is running but has no models yet. Pull one first (for example: ollama pull qwen3).' : '' };
    return { ok: true, models: list.filter((m) => !NOT_CHAT.test(m.id)).map((m) => m.id).sort(), suggested: suggest(list) };
  } catch (err) {
    const local = def.id === 'local';
    return { ok: false, error: local ? 'Nothing answered at that address. Is Ollama (or LM Studio\'s server) running?' : `Could not reach the service: ${String((err && err.message) || err)}` };
  }
}

// Save the choice made in onboarding or Settings. A key is stored encrypted and never handed back.
function save({ id, method, key, baseUrl, models, price }) {
  const def = byId(id);
  if (!def.methods.includes(method)) return { ok: false, error: 'That way of signing in is not offered for this provider.' };
  if (method === 'key' && key) settings.setSecret(`key:${def.id}`, String(key).trim());
  if (method === 'key' && !settings.getSecret(`key:${def.id}`) && !(def.id === 'claude' && settings.envOr('ANTHROPIC_API_KEY'))) return { ok: false, error: 'No key saved yet.' };
  const prev = settings.get('provider');
  const same = prev.id === def.id;
  settings.set({ provider: {
    id: def.id, method,
    baseUrl: String(baseUrl != null ? baseUrl : same ? prev.baseUrl : '').trim(),
    models: { light: '', standard: '', strong: '', ...(same ? prev.models : {}), ...(models || {}) },
    price: price !== undefined ? price : same ? prev.price || null : null,
  } });
  return { ok: true };
}
function forgetKey(id) { settings.setSecret(`key:${byId(id).id}`, ''); return true; }

// ---------- subscriptions: the providers' own command-line apps ----------
const which = (cmd) => { try { const r = spawnSync('where', [cmd], { encoding: 'utf8', windowsHide: true, timeout: 8000 }); return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : []; } catch { return []; } };
// npm puts a .cmd launcher on the PATH; prefer it over the extension-less shell script next to it.
function cliPath(cmd) { const found = which(cmd); return found.find((f) => /\.(cmd|exe|bat)$/i.test(f)) || found[0] || ''; }

function claudeExe() {
  const dir = path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64');
  try { const exe = fs.readdirSync(dir).find((f) => /^claude(\.exe)?$/i.test(f)); return exe ? path.join(dir, exe) : ''; } catch { return ''; }
}

// Is the provider's CLI installed, and (as far as can be told without touching the login) signed in?
async function cliStatus(id) {
  const def = byId(id);
  if (def.id === 'claude') {
    const a = await require('./claude.cjs').account();
    return { installed: !!claudeExe(), signedIn: a.signedIn && !/api.?key/i.test(a.source) ? true : a.signedIn, plan: a.plan, who: a.email, error: a.ok ? '' : a.error };
  }
  if (!def.cli) return { installed: false, signedIn: false };
  const exe = cliPath(def.cli.cmd);
  if (!exe) return { installed: false, signedIn: false, pkg: def.cli.pkg, name: def.cli.name };
  let signedIn = false;
  if (def.id === 'openai') {
    // "codex login status" exits 0 when signed in
    try { const r = spawnSync(`"${exe}" login status`, { shell: true, encoding: 'utf8', windowsHide: true, timeout: 15000 }); signedIn = r.status === 0 && !/not logged in/i.test((r.stdout || '') + (r.stderr || '')); } catch { /* unknown */ }
  } else if (def.id === 'antigravity') {
    // "agy models" asks Google for the model list, so it only succeeds with a working sign-in.
    // Verified signed in on 2026-10-07; the signed-out case has not been seen.
    try { const r = spawnSync(`"${exe}" models`, { shell: true, encoding: 'utf8', windowsHide: true, timeout: 20000 }); signedIn = r.status === 0 && /gemini|claude/i.test(r.stdout || ''); } catch { /* unknown */ }
  }
  return { installed: true, signedIn, name: def.cli.name };
}

// Opens the provider's own sign-in in a normal terminal window, so the login happens entirely in their app.
function openLogin(id) {
  const def = byId(id);
  const env = { ...process.env };
  let line;
  if (def.id === 'claude') {
    const exe = claudeExe();
    if (!exe) return { ok: false, error: 'The bundled Claude Code was not found. Run npm install in the app folder.' };
    delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; // sign in with the claude.ai account, not a key
    env.DISABLE_AUTOUPDATER = '1'; // it must never replace itself while the assistant uses it
    line = `"${exe}" /login`;
  } else if (def.cli) {
    if (!cliPath(def.cli.cmd)) return { ok: false, error: `${def.cli.name} is not installed yet.` };
    line = def.cli.login;
  } else return { ok: false, error: 'This provider has no sign-in; it uses a key.' };
  try {
    spawn('cmd.exe', ['/d', '/s', '/c', `start "Sign in for Agentic OS" cmd /k ${line}`], { detached: true, stdio: 'ignore', env, windowsVerbatimArguments: true }).unref();
    return { ok: true };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
}

// Installs the provider's official CLI from npm (only when the user presses Install in onboarding).
function cliInstall(id) {
  const def = byId(id);
  if (!def.cli) return Promise.resolve({ ok: false, error: 'Nothing to install for this provider.' });
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(def.cli.install || `npm install -g ${def.cli.pkg}`, { shell: true, windowsHide: true });
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    p.on('close', (code) => resolve(code === 0 && cliPath(def.cli.cmd) ? { ok: true } : { ok: false, error: out.trim().split(/\r?\n/).slice(-3).join(' ') || `npm exited with ${code}` }));
  });
}

module.exports = { CATALOG, byId, state, active, test, save, forgetKey, suggest, cliStatus, cliPath, openLogin, cliInstall, claudeExe };

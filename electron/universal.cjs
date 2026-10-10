// The universal brain: the assistant on any LLM that speaks the OpenAI chat API (OpenAI, Gemini, OpenRouter, Groq, xAI,
// Mistral, a local Ollama...). The Claude brain (claude.cjs) gets its tools from Claude Code; here the app runs the
// loop itself: send the chat, stream the reply, run the tools the model asks for, send the results back, repeat.
//
// What matches the Claude brain: the persona, the answer method, the workspace indexes, the same tool names (so
// policy.cjs gates them identically), ask-first cards, backups before every edit, several chats at once, the
// quick/everyday/strong model tiers with a yes/no card before stepping up, the same events.
// What it does not have: claude.ai connectors, helper agents, and a plan meter (it counts tokens instead).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const vault = require('./vault.cjs');
const policy = require('./policy.cjs');
const attachments = require('./attachments.cjs');
const win = require('./window.cjs');
const jobs = require('./jobs.cjs');
const shared = require('./shared.cjs');
const providers = require('./providers.cjs');
const claude = require('./claude.cjs'); // only for the shared persona text and helpers; no Claude call is made here
const store = require('./store.cjs');

const MAX_RUNNING = Math.max(1, Number(process.env.AGENTIC_OS_MAX_CHATS) || 3);
const MAX_STEPS = 40; // tool rounds in one question
const STEP_UP_TURNS = 4;
const OUT_CAP = 30000; // characters of one tool result
const SILENT_MS = Number(process.env.AOS_LLM_SILENT_MS) || 120000; // give up on a provider that sends nothing for this long
// A model on this PC ("On this PC" in Settings, Brain) is slow to read: about 26 tokens a second on the user's 8 GB
// laptop with no graphics card (measured 2026-10-10), and it sends nothing while it reads. The full standing
// instructions (about 12k tokens, mostly vault indexes) would take minutes, so a local brain gets a slim version,
// a longer wait, smaller tool results, no thinking out loud, and fewer tools.
const isLocal = () => providers.active().id === 'local';
const LOCAL_SILENT_MS = Number(process.env.AOS_LOCAL_SILENT_MS) || 600000;
const LOCAL_OUT_CAP = 8000;
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.csv', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.cs', '.py', '.css', '.html', '.htm', '.yml', '.yaml', '.bat', '.ps1', '.sh', '.ahk', '.xml', '.toml', '.ini', '.log', '.sql', '.go', '.rs', '.java', '.c', '.h', '.cpp']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', '.trash']);

const chats = new Map(); // chat id -> state
const dir = () => path.join(app.getPath('userData'), 'brains');
const logDir = () => path.join(app.getPath('userData'), 'sessions'); // read by history.cjs, same shape as Claude Code's logs
const safe = (id) => String(id).replace(/[^a-z0-9-]/gi, '_').slice(0, 80);

function chatFor(id = 'default') {
  let S = chats.get(id);
  if (!S) {
    S = { id, title: '', sessionId: null, messages: [], abort: null, gen: 0, stepUp: null, lastModel: '', lastActive: 0, turns: 0, autoRun: false, said: {}, standing: null, lastFolder: null, outsideChanges: new Set() };
    chats.set(id, S);
  }
  return S;
}
const running = () => [...chats.values()].filter((S) => S.abort);

function persist(S) {
  // the chat still works if this fails; it just won't survive a restart (and the log says so)
  store.tryWriteJson(path.join(dir(), `${safe(S.id)}.json`), { sessionId: S.sessionId, messages: S.messages, lastModel: S.lastModel, turns: S.turns });
}
function restore(S, sid) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir(), `${safe(S.id)}.json`), 'utf8'));
    if (d.sessionId !== sid || !Array.isArray(d.messages)) return false;
    S.messages = d.messages; S.sessionId = d.sessionId; S.lastModel = d.lastModel || ''; S.turns = d.turns || 0;
    // the index pages as they are now become the baseline for "changed since this chat began"
    S.standing = d.messages[0] && d.messages[0].role === 'system' ? { text: d.messages[0].content, pages: new Map(claude.indexPages().map((p) => [p.rel, p.text])) } : null;
    return true;
  } catch { return false; }
}
// One line per question and per skill read, in the same shape as Claude Code's session logs, so Health, Value and
// Dreams count them the same way whichever brain did the work.
function log(S, line) {
  try { fs.mkdirSync(logDir(), { recursive: true }); fs.appendFileSync(path.join(logDir(), `${safe(S.id)}.jsonl`), JSON.stringify({ timestamp: new Date().toISOString(), sessionId: S.sessionId || S.id, ...line }) + '\n'); } catch { /* history is nice to have */ }
}

// ---------- models ----------
function tiers() {
  const m = providers.active().models || {};
  const standard = m.standard || m.light || m.strong || '';
  return { light: m.light || standard, standard, strong: m.strong && m.strong !== standard ? m.strong : '' };
}
function pickModel(S, text, hasFiles) {
  const t = tiers();
  if (S.stepUp) { if (S.stepUp.turns-- > 0) return S.stepUp.model; S.stepUp = null; }
  if (S.sessionId && claude.CONFIRM.test(String(text || '').trim()) && S.lastModel) return S.lastModel;
  const light = !hasFiles && claude.isLight(text);
  // Same rule as the Claude brain: the quick model only takes short questions at the start of a chat.
  if (S.sessionId) return light && S.lastModel === t.light ? t.light : t.standard;
  return light ? t.light : t.standard;
}

// ---------- standing instructions ----------
function skillsList() {
  try { return vault.skills().groups.flatMap((g) => g.skills).map((s) => `- ${s.name}: ${String(s.description || s.title || '').replace(/\s+/g, ' ').slice(0, 220)} (${s.path})`).join('\n'); } catch { return ''; }
}
function systemPrompt(S) {
  if (S.standing) return S.standing.text;
  const t = tiers();
  const persona = claude.PERSONA.replace(/^Updating yourself:.*\n/m, '').replace(/^Showing files:.*\n/m, 'Showing files: when {user} asks to see, open or pull up a workspace file, use the open_file tool so it opens in the app\'s viewer.\n');
  const method = claude.METHOD.split('\n\nModels:')[0];
  const pages = claude.indexPages();
  const local = isLocal();
  const skills = local ? '' : skillsList();
  // Local: only the workspace's front page rides along; the rest are read when needed. All pages stay in S.standing.pages
  // so the "index pages changed" note still only reports real changes.
  const shown = local ? pages.filter((p) => p.rel === 'index.md' || p.rel.toLowerCase() === 'readme.md') : pages;
  const text = claude.personalize([
    persona, method,
    local ? `## On this PC\nYou are running on a small model on {user}'s own computer, which is slow. Keep answers short, use as few tools as you can, and read an index page (README.md, projects/ and so on) only when the question needs it. Skills (how-to notes) are in skills/<name>/SKILL.md.` : '',
    t.strong ? `Models: you start on the cheapest model that fits the question. Never switch up on your own. If the task is harder than your current model can do well (real multi-file changes, a bug with no obvious cause, a design trade-off, or you are guessing), call request_model with a one-sentence plain-words reason and a short handoff brief; {user} gets a yes/no card. Ask once per task. On yes, say one short line and stop: the app carries on with the task on the stronger model straight away. On no, carry on and say plainly where you may fall short.` : '',
    `## Your tools\nRead, Glob and Grep look at files; Write and Edit change them (the old version is backed up first); PowerShell runs a command on this Windows PC (give it a plain-words description); WebFetch reads one web page; WebSearch searches the web; open_file shows a workspace file to {user}; window moves the app window. Relative paths are relative to the workspace root, which is your working folder: ${vault.ROOT}. Use full paths in commands. Read a file before you edit it. You have no helper agents and no connected apps (email, calendar) on this brain; say so plainly if asked for those.`,
    skills ? `## Skills\nHow-to notes for kinds of task, kept in the workspace. Before a task one of these covers, Read its file and follow it.\n${skills}` : '',
    '## Backups of files you changed\n' + policy.backupDir(),
    '## Vault indexes (as they were when this chat began)\n' + shown.map((p) => `### ${p.rel}\n${p.text}`).join('\n\n'),
  ].filter(Boolean).join('\n\n'));
  S.standing = { text, pages: new Map(pages.map((p) => [p.rel, p.text])) };
  S.said = {};
  return text;
}

// ---------- tools ----------
const abs = (p) => path.resolve(vault.ROOT, String(p || ''));
const relInVault = (a) => (a === vault.ROOT || a.startsWith(vault.ROOT + path.sep) ? path.relative(vault.ROOT, a).split(path.sep).join('/') : null);
const clip = (t, n = OUT_CAP) => (t.length > n ? t.slice(0, n) + `\n… (cut: ${t.length - n} more characters)` : t);
const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

function toolDefs(S) {
  const t = tiers();
  const defs = [
    fn('Read', 'Read a text file. Returns numbered lines. Relative paths are relative to the vault root.', { file_path: { type: 'string' }, offset: { type: 'integer', description: 'First line to read (1-based).' }, limit: { type: 'integer', description: 'How many lines.' } }, ['file_path']),
    fn('Glob', 'Find files by name pattern, newest first. Example: projects/**/README.md', { pattern: { type: 'string' }, path: { type: 'string', description: 'Folder to search in. Default: the workspace root.' } }, ['pattern']),
    fn('Grep', 'Search inside files with a regular expression. Returns matching lines as path:line: text.', { pattern: { type: 'string' }, path: { type: 'string', description: 'File or folder. Default: the vault root.' }, glob: { type: 'string', description: 'Only files matching this name pattern, e.g. *.md' }, ignore_case: { type: 'boolean' } }, ['pattern']),
    fn('Write', 'Create a file or replace its whole contents. The old version is backed up first.', { file_path: { type: 'string' }, content: { type: 'string' } }, ['file_path', 'content']),
    fn('Edit', 'Replace one exact piece of text in a file. old_string must appear exactly once unless replace_all is true. The old version is backed up first.', { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['file_path', 'old_string', 'new_string']),
    fn('PowerShell', 'Run a PowerShell command on this Windows PC, from the vault root. Use full paths.', { command: { type: 'string' }, description: { type: 'string', description: 'One short plain-words sentence: what this does and to what.' }, timeout_seconds: { type: 'integer' } }, ['command', 'description']),
    fn('WebFetch', 'Read one web page (GET only) and return its text.', { url: { type: 'string' } }, ['url']),
    fn('WebSearch', 'Search the web. Returns a few results with titles, links and snippets.', { query: { type: 'string' } }, ['query']),
    fn('open_file', 'Open a vault file in the app viewer so the user can see it.', { path: { type: 'string', description: 'Path inside the vault, relative to its root.' } }, ['path']),
    fn('window', 'Move or resize the app window you live in, when asked.', { action: { type: 'string', enum: win.ACTIONS } }, ['action']),
  ];
  if (t.strong && !S.autoRun) defs.push(fn('request_model', 'Ask the user to switch this task to the stronger (costlier) model. Gives a yes/no card. Ask once per task.', { reason: { type: 'string' }, handoff: { type: 'string', description: 'Short brief for the stronger model: goal, what you tried, files involved, why you are stuck.' } }, ['reason', 'handoff']));
  return defs;
}

function walk(root, onFile, limit = 20000) {
  let n = 0;
  (function go(d) {
    if (n > limit) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) go(p); else if (e.isFile()) { n++; onFile(p); }
    }
  })(root);
}
function globRe(pattern) {
  const esc = String(pattern).replace(/\\/g, '/').replace(/[.+^${}()|[\]]/g, '\\$&');
  return new RegExp('^' + esc.replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?') + '$', 'i');
}

function runPowerShell(command, seconds, signal) {
  return new Promise((resolve) => {
    let out = '', done = false;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: vault.ROOT, windowsHide: true });
    const finish = (tail) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', kill); resolve(clip((out + tail).trim() || '(no output)')); };
    const kill = () => { try { p.kill(); } catch { /* gone */ } finish('\n(stopped)'); };
    const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } finish(`\n(timed out after ${seconds} s)`); }, seconds * 1000);
    signal?.addEventListener('abort', kill);
    p.stdout.on('data', (d) => { if (out.length < OUT_CAP * 2) out += d; });
    p.stderr.on('data', (d) => { if (out.length < OUT_CAP * 2) out += d; });
    p.on('error', (e) => finish(`\nCould not start PowerShell: ${e.message}`));
    p.on('close', (code) => finish(code ? `\n(exit code ${code})` : ''));
  });
}

const htmlToText = (h) => String(h).replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<\/(p|div|h\d|li|tr|br)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();

// Runs one tool. Returns the text handed back to the model. Risky ones have already been through gate().
async function runTool(name, input, S, emit, signal, ctl) {
  switch (name) {
    case 'Read': {
      const a = abs(input.file_path);
      if (!fs.existsSync(a) || fs.statSync(a).isDirectory()) return `No file at ${input.file_path}.`;
      const ext = path.extname(a).toLowerCase();
      const st = fs.statSync(a);
      if (IMAGE_EXT.has(ext)) return 'That is an image. You can only see images the user attaches to a message.';
      if (ext === '.pdf' || (!TEXT_EXT.has(ext) && st.size > 0 && fs.readFileSync(a).subarray(0, 4000).includes(0))) return `That is a ${ext || 'binary'} file; it can't be read as text here. Offer to open it for the user with open_file.`;
      if (st.size > 2 * 1024 * 1024) return `That file is ${(st.size / 1048576).toFixed(1)} MB; use Grep to find the part you need, or Read with offset and limit.`;
      const lines = fs.readFileSync(a, 'utf8').split(/\r?\n/);
      const from = Math.max(1, Number(input.offset) || 1), count = Math.max(1, Number(input.limit) || 2000);
      const part = lines.slice(from - 1, from - 1 + count);
      return clip(part.map((l, i) => `${String(from + i).padStart(5)}\t${l}`).join('\n') + (from - 1 + count < lines.length ? `\n… (${lines.length - (from - 1 + count)} more lines; use offset)` : ''), 60000);
    }
    case 'Glob': {
      const root = abs(input.path || '.'), re = globRe(input.pattern);
      const hits = [];
      walk(root, (p) => { const r = path.relative(root, p).split(path.sep).join('/'); if (re.test(r) || re.test(path.basename(p))) hits.push(p); });
      hits.sort((x, y) => { try { return fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs; } catch { return 0; } });
      return hits.length ? hits.slice(0, 300).map((p) => relInVault(p) ?? p).join('\n') + (hits.length > 300 ? `\n… (${hits.length - 300} more)` : '') : 'No files match.';
    }
    case 'Grep': {
      let re;
      try { re = new RegExp(String(input.pattern), input.ignore_case ? 'i' : ''); } catch (e) { return `That pattern is not a valid regular expression: ${e.message}`; }
      const root = abs(input.path || '.'), only = input.glob ? globRe(input.glob) : null;
      const out = [];
      const scan = (p) => {
        if (out.length >= 200) return;
        if (only && !only.test(path.basename(p)) && !only.test(path.relative(root, p).split(path.sep).join('/'))) return;
        if (!TEXT_EXT.has(path.extname(p).toLowerCase())) return;
        let text;
        try { if (fs.statSync(p).size > 2 * 1024 * 1024) return; text = fs.readFileSync(p, 'utf8'); } catch { return; }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && out.length < 200; i++) if (re.test(lines[i])) out.push(`${relInVault(p) ?? p}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
      };
      if (fs.existsSync(root) && fs.statSync(root).isFile()) scan(root); else walk(root, scan);
      return out.length ? out.join('\n') + (out.length >= 200 ? '\n… (first 200 matches; narrow the search)' : '') : 'No matches.';
    }
    case 'Write': {
      const a = abs(input.file_path);
      fs.mkdirSync(path.dirname(a), { recursive: true });
      fs.writeFileSync(a, String(input.content ?? ''));
      return `Wrote ${relInVault(a) ?? a}.`;
    }
    case 'Edit': {
      const a = abs(input.file_path);
      if (!fs.existsSync(a)) return `No file at ${input.file_path}. Use Write to create it.`;
      const text = fs.readFileSync(a, 'utf8');
      const old = String(input.old_string ?? ''), neu = String(input.new_string ?? '');
      if (!old) return 'old_string is empty. Give the exact text to replace.';
      const n = text.split(old).length - 1;
      if (n === 0) return 'old_string was not found in the file. Read the file again and copy the text exactly, including spaces.';
      if (n > 1 && !input.replace_all) return `old_string appears ${n} times. Add more surrounding text so it is unique, or set replace_all.`;
      fs.writeFileSync(a, input.replace_all ? text.split(old).join(neu) : text.replace(old, () => neu));
      return `Edited ${relInVault(a) ?? a}${n > 1 ? ` (${n} places)` : ''}.`;
    }
    case 'PowerShell':
      return runPowerShell(String(input.command || ''), Math.min(600, Math.max(5, Number(input.timeout_seconds) || 120)), signal);
    case 'WebFetch': {
      const url = String(input.url || '');
      if (!/^https?:\/\//i.test(url)) return 'Give a full http(s) address.';
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Agentic OS; personal assistant)' }, redirect: 'follow', signal: AbortSignal.any([signal, AbortSignal.timeout(25000)].filter(Boolean)) });
        const type = res.headers.get('content-type') || '';
        if (!res.ok) return `The page answered with an error (${res.status}).`;
        if (!/text|json|xml/i.test(type)) return `That address is not a text page (${type || 'unknown type'}).`;
        const body = await res.text();
        return clip(/html/i.test(type) ? htmlToText(body) : body, 20000);
      } catch (e) { return `Could not load the page: ${e.message}`; }
    }
    case 'WebSearch': {
      try {
        const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(String(input.query || '')), { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.any([signal, AbortSignal.timeout(20000)].filter(Boolean)) });
        const html = await res.text();
        const hits = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g)].slice(0, 8).map((m) => {
          let link = m[1].replace(/&amp;/g, '&');
          const u = link.match(/[?&]uddg=([^&]+)/); if (u) link = decodeURIComponent(u[1]);
          return `${htmlToText(m[2])}\n${link}\n${htmlToText(m[3] || '')}`;
        });
        return hits.length ? hits.join('\n\n') : 'The search came back empty. Try other words, or WebFetch a page you already know.';
      } catch (e) { return `The search failed: ${e.message}`; }
    }
    case 'open_file': {
      const a = vault.resolveInside(String(input.path || '').replace(/\\/g, '/'));
      if (!a || !fs.existsSync(a) || fs.statSync(a).isDirectory()) return `No file at "${input.path}" inside the vault. Check the path and try again.`;
      const rel = relInVault(a);
      emit({ type: 'open', path: rel });
      return `Opened ${rel} in the viewer.`;
    }
    case 'window':
      return win.control(String(input.action || ''));
    case 'request_model': {
      const t = tiers();
      if (!t.strong) return 'There is no stronger model set up; carry on as you are.';
      if (ctl.model === t.strong) return 'You are already on the strongest model; carry on.';
      const { yes, question } = await shared.ask(emit, signal, S, { tool: 'request_model', summary: `switch to ${t.strong}: ${String(input.reason || '').slice(0, 200)}`, what: `This is harder than ${ctl.model} can do well.`, spoken: 'switch to the stronger model' });
      if (question) return `Nothing changed. The user has not said yes or no yet; they asked: "${question}". Answer plainly, then ask again with request_model if it is still needed.`;
      if (!yes) return 'The user said no. Stay on this model, do the best you can, and say briefly where it may fall short. Do not ask again for this task.';
      S.stepUp = { model: t.strong, turns: STEP_UP_TURNS };
      ctl.carryOn = String(input.handoff || '').slice(0, 1500) || true;
      return 'Approved. Say one short line (like "Switching up.") and end your turn now. The app carries on with the task on the stronger model straight away.';
    }
    default:
      return `There is no tool called ${name}.`;
  }
}

// The same gate as the Claude brain's canUseTool: catastrophic actions ask first, deletes and overwrites are backed
// up first, edits are backed up and remembered. Returns null to go ahead, or the refusal to hand back to the model.
async function gate(name, input, S, emit, signal) {
  const forPolicy = name === 'Write' || name === 'Edit' ? { ...input, file_path: abs(input.file_path) } : input;
  const c = policy.check(name, forPolicy);
  if (c.ask) {
    const { yes, question } = await shared.ask(emit, signal, S, { tool: name, summary: c.summary, what: typeof input.description === 'string' ? input.description : '', spoken: c.spoken || c.summary, risky: !!c.risky });
    if (question) return `Nothing was run. The user has not said yes or no yet; they asked: "${question}". Answer plainly: what this does, why it is needed, what could go wrong, and any safer option. Then, if it is still the right move, try the exact same action again so they get a fresh yes/no card. Do not do it any other way.`;
    if (!yes) return 'The user said no. Drop this action and do not try another way to do it; tell them briefly you have left it.';
  }
  for (const b of c.backups || []) {
    if (!policy.backupAny(b) && fs.existsSync(b)) return `Not run: the safety copy of ${b} could not be made first. Tell the user plainly and ask before trying another way.`;
  }
  if (name === 'Write' || name === 'Edit') {
    const a = abs(input.file_path);
    policy.backup(a);
    const rel = relInVault(a);
    if (rel !== null) {
      shared.markWritten(rel);
      for (const o of chats.values()) if (o !== S) o.outsideChanges.add(rel);
    }
  }
  return null;
}

// ---------- the model call ----------
function headers(p) {
  const h = { 'Content-Type': 'application/json' };
  if (p.key) h.Authorization = `Bearer ${p.key}`;
  if (/openrouter\.ai/.test(p.baseUrl)) { h['X-Title'] = 'Agentic OS'; }
  return h;
}
const friendly = (status, body) => {
  let detail = '';
  try { const j = JSON.parse(body); detail = (j.error && (j.error.message || j.error)) || j.message || ''; } catch { detail = String(body || '').slice(0, 200); }
  if (status === 401 || status === 403) return 'The key was not accepted. Open Settings, then Brain, and check it.';
  if (status === 429) return `The provider says slow down or the quota is used up. ${String(detail).slice(0, 200)}`;
  if (status === 404) return `The provider does not know that model. Pick another in Settings, then Brain. ${String(detail).slice(0, 160)}`;
  return `The provider answered with an error (${status}). ${String(detail).slice(0, 240)}`;
};

// One streamed completion. Calls onText for each piece of the reply; returns { content, toolCalls, usage }.
async function complete(opts) {
  // Watchdog: every piece that arrives resets it; two minutes of silence ends the call with a plain message.
  const silent = new AbortController();
  let timer = null;
  const wait = opts.p.id === 'local' ? LOCAL_SILENT_MS : SILENT_MS;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => silent.abort(), wait); };
  arm();
  try {
    return await stream({ ...opts, signal: AbortSignal.any([opts.signal, silent.signal].filter(Boolean)), arm });
  } catch (err) {
    if (silent.signal.aborted && !(opts.signal && opts.signal.aborted)) throw new Error(opts.p.id === 'local' ? `The model on this PC sent nothing for ${Math.round(wait / 60000)} minutes. It may be too big for this computer; try a smaller one in Settings, then Brain.` : 'The provider stopped answering. Check your connection and try again.');
    throw err;
  } finally { clearTimeout(timer); }
}
async function stream({ p, model, messages, tools, signal, onText, arm }) {
  const body = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (tools && tools.length) body.tools = tools;
  if (p.id === 'local') body.reasoning_effort = 'none'; // Ollama: answer straight away instead of thinking out loud first
  let res = await fetch(p.baseUrl + '/chat/completions', { method: 'POST', headers: headers(p), body: JSON.stringify(body), signal });
  if (res.status === 400) {
    // Some servers don't know stream_options (or reasoning_effort); ask again without them before giving up.
    const first = await res.text();
    delete body.stream_options; delete body.reasoning_effort;
    res = await fetch(p.baseUrl + '/chat/completions', { method: 'POST', headers: headers(p), body: JSON.stringify(body), signal });
    if (!res.ok) { const e = new Error(friendly(res.status, (await res.text()) || first)); e.status = res.status; throw e; }
  } else if (!res.ok) { const e = new Error(friendly(res.status, await res.text())); e.status = res.status; throw e; }

  let content = '', usage = null, buf = '';
  const calls = [];
  const take = (data) => {
    if (!data || data === '[DONE]') return;
    let j;
    try { j = JSON.parse(data); } catch { return; }
    if (j.error) throw new Error(friendly(j.error.code || 500, JSON.stringify(j)));
    if (j.usage) usage = j.usage;
    const d = j.choices && j.choices[0] && j.choices[0].delta;
    if (!d) return;
    if (typeof d.content === 'string' && d.content) { content += d.content; onText(d.content); }
    for (const tc of d.tool_calls || []) {
      // no index: a piece with an id starts a new call, one without continues the last
      const at = typeof tc.index === 'number' ? tc.index : tc.id ? calls.length : Math.max(0, calls.length - 1);
      // keep everything the provider sent with the call (Gemini's thought signatures ride in extra fields)
      const c = calls[at] || (calls[at] = { ...tc, id: tc.id || '', type: 'function', function: { name: '', arguments: '' } });
      if (tc.id && !c.id) c.id = tc.id;
      if (tc.function) { if (tc.function.name) c.function.name = tc.function.name; if (typeof tc.function.arguments === 'string') c.function.arguments += tc.function.arguments; }
      delete c.index;
    }
  };
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    arm();
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) take(line.slice(5).trim());
    }
  }
  if (buf.trim().startsWith('data:')) take(buf.trim().slice(5).trim());
  const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now().toString(36)}_${i}` }));
  return { content, toolCalls, usage };
}

const imagePart = (file) => {
  const ext = path.extname(file).toLowerCase();
  try {
    if (!IMAGE_EXT.has(ext) || fs.statSync(file).size > 5 * 1024 * 1024) return null;
    return { type: 'image_url', image_url: { url: `data:image/${ext === '.jpg' ? 'jpeg' : ext.slice(1)};base64,${fs.readFileSync(file).toString('base64')}` } };
  } catch { return null; }
};

function touchedPath(input) {
  const p = input && (input.file_path || input.path);
  if (typeof p !== 'string') return null;
  return relInVault(abs(p));
}
function rememberFolder(rel, S) {
  let isDir = false;
  try { isDir = fs.statSync(path.join(vault.ROOT, rel)).isDirectory(); } catch { /* not there */ }
  S.lastFolder = isDir ? rel : path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
}

// ---------- one question ----------
async function send(chatId, text, emit, files = [], resumed = false, auto = false) {
  const S = chatFor(chatId);
  const raw = emit;
  emit = (e) => raw({ ...e, chat: S.id });
  if (S.abort && S.autoRun && !auto) { stop(S.id); for (let i = 0; S.abort && i < 30; i++) await new Promise((r) => setTimeout(r, 100)); }
  if (S.abort) { emit({ type: 'error', message: 'Still working on the last request.' }); return; }
  if (running().length >= MAX_RUNNING) {
    if (auto) return;
    if (!resumed) emit({ type: 'error', message: `${MAX_RUNNING} chats are already working. Let one finish or stop one first, then ask again.` });
    emit({ type: 'done' });
    return;
  }
  S.abort = new AbortController();
  const abort = S.abort, signal = abort.signal, myGen = S.gen, t0 = Date.now();
  const p = providers.active();
  if (!auto && !resumed && !S.title) S.title = String(text || '').replace(/\s+/g, ' ').slice(0, 60);
  const skillsUsed = [];
  if (!auto && !resumed) S.turns++;
  S.autoRun = auto;
  if (!resumed) emit({ type: 'start' });
  const fresh = !S.sessionId;
  const model = auto ? tiers().standard : (S.lastModel = pickModel(S, text, files.length > 0));
  if (fresh) {
    S.sessionId = `u-${S.id}-${Date.now().toString(36)}`;
    S.messages = [{ role: 'system', content: systemPrompt(S) }];
    emit({ type: 'session', id: S.sessionId });
  }
  const ctl = { model, carryOn: false };
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let isError = false;
  try {
    if (!p.baseUrl) throw new Error('No address is set for this provider. Open Settings, then Brain.');
    if (!model) throw new Error('No model is chosen yet. Open Settings, then Brain, and pick one.');
    // What changed since the last question rides in with the question, as it does for the Claude brain.
    const context = claude.questionContext(S);
    S.outsideChanges = new Set();
    const images = files.map(imagePart).filter(Boolean);
    const others = files.filter((f) => !IMAGE_EXT.has(path.extname(f).toLowerCase()));
    const said = [context, text, others.length ? `[Attached ${others.length === 1 ? 'a file' : `${others.length} files`}. Look at ${others.length === 1 ? 'it' : 'them'} with Read before you answer: ${others.join(' ; ')}]` : ''].filter(Boolean).join('\n\n');
    S.messages.push({ role: 'user', content: images.length ? [{ type: 'text', text: said || 'Have a look at this.' }, ...images] : said });
    if (!auto && !resumed) log(S, { type: 'user', message: { content: [{ type: 'text', text: String(text || '').slice(0, 600) }] } });

    for (let step = 0; step < MAX_STEPS; step++) {
      let r;
      try {
        r = await complete({ p, model: ctl.model, messages: S.messages, tools: toolDefs(S), signal, onText: (t) => emit({ type: 'text', text: t }) });
      } catch (err) {
        // A model that can't take pictures refuses the whole request: send the words alone, once.
        const last = S.messages[S.messages.length - 1];
        if (err.status === 400 && step === 0 && Array.isArray(last.content)) {
          last.content = last.content.find((c) => c.type === 'text').text + '\n\n[The attached picture could not be sent: this model does not take images.]';
          r = await complete({ p, model: ctl.model, messages: S.messages, tools: toolDefs(S), signal, onText: (t) => emit({ type: 'text', text: t }) });
        } else throw err;
      }
      if (r.usage) {
        const cached = (r.usage.prompt_tokens_details && r.usage.prompt_tokens_details.cached_tokens) || 0;
        usage.input_tokens += Math.max(0, (r.usage.prompt_tokens || 0) - cached);
        usage.cache_read_input_tokens += cached;
        usage.output_tokens += r.usage.completion_tokens || 0;
      }
      const msg = { role: 'assistant', content: r.content || null };
      if (r.toolCalls.length) msg.tool_calls = r.toolCalls;
      S.messages.push(msg);
      if (!r.toolCalls.length) break;
      for (const tc of r.toolCalls) {
        const name = tc.function.name;
        let input = {}, out;
        try { input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { out = 'The arguments were not valid JSON. Call the tool again with valid JSON.'; }
        if (out === undefined) {
          const tp = touchedPath(input);
          if (tp !== null) rememberFolder(tp, S);
          // Reading a skill file counts as using that skill (the Claude brain has a Skill tool for this).
          const sk = name === 'Read' && tp && tp.match(/^skills\/([^/]+)\/SKILL\.md$/i);
          if (sk) { skillsUsed.push(sk[1]); log(S, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: sk[1] } }] } }); }
          emit({ type: 'tool', name, input, path: tp });
          try {
            out = (['Write', 'Edit', 'PowerShell'].includes(name) ? await gate(name, input, S, emit, signal) : null) ?? await runTool(name, input, S, emit, signal, ctl);
          } catch (e) { out = `That failed: ${(e && e.message) || e}`; }
        }
        S.messages.push({ role: 'tool', tool_call_id: tc.id, content: clip(String(out), p.id === 'local' ? LOCAL_OUT_CAP : OUT_CAP) });
        if (signal.aborted) break;
      }
      if (signal.aborted || ctl.carryOn) break;
      if (step === MAX_STEPS - 1) emit({ type: 'note', message: `Stopped after ${MAX_STEPS} steps so this can't run away. Say "carry on" to continue.` });
    }
  } catch (err) {
    isError = true;
    emit({ type: 'error', message: signal.aborted ? 'Stopped.' : String((err && err.message) || err) });
  } finally {
    const stopped = signal.aborted;
    // A stop can land between a tool call and its result; the chat must still be well-formed for the next question.
    const open = new Set();
    for (const m of S.messages) { if (m.tool_calls) m.tool_calls.forEach((c) => open.add(c.id)); if (m.role === 'tool') open.delete(m.tool_call_id); }
    for (const id of open) S.messages.push({ role: 'tool', tool_call_id: id, content: 'Stopped before this ran.' });
    const price = p.price || {};
    const cost = ((usage.input_tokens * (Number(price.in) || 0)) + (usage.cache_read_input_tokens * (Number(price.cached ?? price.in) || 0)) + (usage.output_tokens * (Number(price.out) || 0))) / 1e6;
    // costUsd is this question's own cost here (not a running total), so it is always "fresh" for the ledger.
    emit({ type: 'result', isError, costUsd: cost, fresh: true, usage, models: [ctl.model], asked: model, light: !auto && !resumed && files.length === 0 && claude.isLight(text), kind: auto ? 'auto' : 'ask', skills: [...new Set(skillsUsed)], ms: Date.now() - t0 });
    S.abort = null;
    S.lastActive = Date.now();
    if (myGen === S.gen) persist(S);
    if (ctl.carryOn && !stopped && myGen === S.gen) {
      const brief = typeof ctl.carryOn === 'string' ? ` The previous model's handoff brief (a lead to check, not settled fact): ${ctl.carryOn}` : '';
      setImmediate(() => send(S.id, `[The user said yes to the stronger model, and you are on it now. Carry on with the task; don't repeat what was already said.${brief}]`, raw, [], true));
    } else {
      emit({ type: 'done' });
    }
    if (auto) S.autoRun = false;
  }
}

function stop(chatId) {
  const all = chatId == null;
  shared.cancel(chatId);
  for (const S of chats.values()) if (S.abort && (all || S.id === chatId)) S.abort.abort();
  return true;
}
function openChat(chatId, sid) {
  const S = chatFor(chatId);
  if (!S.abort) {
    if (typeof sid === 'string' && sid && sid !== S.sessionId) restore(S, sid);
    S.lastActive = Date.now();
  }
  return true;
}
function closeChat(chatId) {
  stop(chatId);
  const S = chats.get(chatId);
  if (S) { S.gen++; chats.delete(chatId); }
  try { fs.unlinkSync(path.join(dir(), `${safe(chatId)}.json`)); } catch { /* never saved */ }
  return true;
}
function noteOutsideChanges(files) { for (const S of chats.values()) for (const f of files) S.outsideChanges.add(f); }
function status() {
  const on = running();
  const p = providers.active();
  return { ready: !!(p.baseUrl && tiers().standard), mode: mode(), model: tiers().standard, busy: on.length > 0, running: on.map((S) => S.id) };
}
const mode = () => 'api';

// One question, one JSON answer, no tools. Dreams uses it. Returns { out, text, usage, model, cost }.
async function oneShot({ system, prompt, schema }) {
  const p = providers.active();
  const model = tiers().standard;
  const body = { model, messages: [{ role: 'system', content: system + (schema ? `\n\nAnswer with ONE JSON object and nothing else, matching this JSON schema:\n${JSON.stringify(schema)}` : '') }, { role: 'user', content: prompt }] };
  if (schema) body.response_format = { type: 'json_object' };
  const local = p.id === 'local';
  if (local) body.reasoning_effort = 'none';
  const limit = local ? LOCAL_SILENT_MS : 180000;
  let res = await fetch(p.baseUrl + '/chat/completions', { method: 'POST', headers: headers(p), body: JSON.stringify(body), signal: AbortSignal.timeout(limit) });
  if (res.status === 400 && (schema || local)) { delete body.response_format; delete body.reasoning_effort; res = await fetch(p.baseUrl + '/chat/completions', { method: 'POST', headers: headers(p), body: JSON.stringify(body), signal: AbortSignal.timeout(limit) }); }
  if (!res.ok) throw new Error(friendly(res.status, await res.text()));
  const j = await res.json();
  const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  let out = null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) try { out = JSON.parse(m[0]); } catch { /* the caller copes with no JSON */ }
  const u = j.usage || {};
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  const price = p.price || {};
  const usage = { input: Math.max(0, (u.prompt_tokens || 0) - cached), output: u.completion_tokens || 0, cacheRead: cached, cacheWrite: 0 };
  return { out, text, usage, model, cost: (usage.input * (Number(price.in) || 0) + usage.output * (Number(price.out) || 0)) / 1e6 };
}

module.exports = { id: 'universal', send, stop, openChat, closeChat, status, mode, noteOutsideChanges, oneShot, chatFor, complete, globRe, htmlToText };

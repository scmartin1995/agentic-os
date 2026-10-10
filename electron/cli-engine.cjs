// Subscription brains that aren't Claude: the provider's own command-line app does the work, signed in with the
// user's own plan through the provider's own sign-in (ChatGPT plan -> OpenAI's Codex; Google account -> Gemini CLI).
// This app starts the CLI in its documented non-interactive JSON mode for each question, feeds the question in on
// stdin, and turns the CLI's event lines into the same events the other brains emit.
//
// Limits, stated plainly:
//   - The CLI's own sandbox decides what is allowed (edits inside the workspace folder, nothing outside). the assistant's
//     ask-first cards and edit backups (policy.cjs) can't see inside the CLI, so they do not apply here.
//   - No claude.ai connectors, helper agents, plan meter or model step-up.
//   - Written from the CLIs' documentation (Codex "non-interactive mode", Gemini CLI "headless" and CLI reference,
//     read 2026-10-04) and tested only against stand-in CLIs that print those documented events (tools/test-v2.cjs).
//     NOT yet run against the real Codex or Gemini CLI: neither is installed on this PC. The Antigravity CLI (agy)
//     adapter was checked against the real agy on 2026-10-07 (reading, writing, replies, resume not yet).
const path = require('path');
const { spawn } = require('child_process');
const vault = require('./vault.cjs');
const shared = require('./shared.cjs');
const providers = require('./providers.cjs');
const claude = require('./claude.cjs'); // persona text only

const MAX_RUNNING = Math.max(1, Number(process.env.AGENTIC_OS_MAX_CHATS) || 3);
const chats = new Map();
function chatFor(id = 'default') {
  let S = chats.get(id);
  if (!S) { S = { id, title: '', sessionId: null, abort: null, gen: 0, turns: 0, lastActive: 0, outsideChanges: new Set() }; chats.set(id, S); }
  return S;
}
const running = () => [...chats.values()].filter((S) => S.abort);
const okId = (s) => typeof s === 'string' && /^[\w.:-]{1,120}$/.test(s);
const relInVault = (p) => { const a = path.resolve(vault.ROOT, String(p || '')); return a === vault.ROOT || a.startsWith(vault.ROOT + path.sep) ? path.relative(vault.ROOT, a).split(path.sep).join('/') : null; };

function standing() {
  const persona = claude.PERSONA.replace(/^Updating yourself:.*\n/m, '').replace(/^Showing files:.*\n/m, '').replace(/^Doing things:.*\n/m, 'Doing things: you can read and edit files in the vault and run commands inside your sandbox. Say what you did in a sentence. Ask before anything that deletes work or reaches outside the vault.\n');
  const pages = claude.indexPages();
  return claude.personalize([persona, claude.METHOD.split('\n\nModels:')[0], '## Vault indexes\n' + pages.map((p) => `### ${p.rel}\n${p.text}`).join('\n\n')].join('\n\n'));
}

// ---------- the CLIs (Gemini CLI is kept for reference; Google no longer lets free personal accounts use it) ----------
const ADAPTERS = {
  // OpenAI Codex: codex exec --json, prompt on stdin ("-"), resume with "exec resume <thread id>".
  codex: {
    cmd: 'codex',
    args: (S, model) => ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', ...(okId(model) ? ['-m', model] : []), ...(okId(S.sessionId) ? ['resume', S.sessionId] : []), '-'],
    on(j, S, emit, acc) {
      if (j.type === 'thread.started' && j.thread_id) { if (j.thread_id !== S.sessionId) { S.sessionId = j.thread_id; emit({ type: 'session', id: S.sessionId }); } return; }
      if (j.type === 'turn.completed' && j.usage) {
        const cached = j.usage.cached_input_tokens || 0;
        acc.usage.input_tokens += Math.max(0, (j.usage.input_tokens || 0) - cached);
        acc.usage.cache_read_input_tokens += cached;
        acc.usage.output_tokens += j.usage.output_tokens || 0;
        return;
      }
      if (j.type === 'turn.failed' || j.type === 'error') { emit({ type: 'error', message: String((j.error && j.error.message) || j.message || 'Codex reported an error.') }); acc.failed = true; return; }
      const it = j.item;
      if (!it || !/^item\./.test(j.type)) return;
      const kind = it.type || it.item_type;
      if (kind === 'agent_message' && j.type === 'item.completed' && it.text) { emit({ type: 'text', text: (acc.said ? '\n\n' : '') + it.text }); acc.said = true; }
      else if (kind === 'command_execution' && j.type === 'item.started') emit({ type: 'tool', name: 'Shell', input: { command: it.command }, path: null });
      else if (kind === 'file_change' && j.type === 'item.completed') for (const c of it.changes || []) { const rel = relInVault(c.path); if (rel !== null) shared.markWritten(rel); emit({ type: 'tool', name: 'Edit', input: { file_path: c.path }, path: rel }); }
      else if (kind === 'web_search' && j.type === 'item.started') emit({ type: 'tool', name: 'WebSearch', input: { pattern: it.query }, path: null });
      else if (kind === 'mcp_tool_call' && j.type === 'item.started') emit({ type: 'tool', name: String(it.tool || 'tool'), input: {}, path: null });
    },
  },
  // Google Gemini CLI: headless when stdin is piped, -o stream-json, resume with --resume <session id>.
  geminicli: {
    cmd: 'gemini',
    args: (S, model) => ['-o', 'stream-json', '--approval-mode', 'auto_edit', ...(okId(model) ? ['-m', model] : []), ...(okId(S.sessionId) ? ['--resume', S.sessionId] : [])],
    on(j, S, emit, acc) {
      if (j.type === 'init' && j.session_id) { if (j.session_id !== S.sessionId) { S.sessionId = j.session_id; emit({ type: 'session', id: S.sessionId }); } return; }
      if (j.type === 'message' && j.role === 'assistant' && typeof j.content === 'string' && j.content) { emit({ type: 'text', text: j.content }); return; }
      if (j.type === 'tool_use') {
        const input = j.parameters || j.args || {};
        const p = input.file_path || input.absolute_path || input.path || input.dir_path;
        const rel = typeof p === 'string' ? relInVault(p) : null;
        const name = String(j.tool_name || j.name || 'tool');
        if (rel !== null && /write|edit|replace/i.test(name)) shared.markWritten(rel);
        emit({ type: 'tool', name: /write|edit|replace/i.test(name) ? 'Edit' : /read/i.test(name) ? 'Read' : name, input, path: rel });
        return;
      }
      if (j.type === 'error') { emit({ type: 'error', message: String(j.message || 'Gemini CLI reported an error.') }); if (j.severity !== 'warning') acc.failed = true; return; }
      if (j.type === 'result') {
        const st = j.stats || {};
        const cached = st.cached || st.cached_tokens || 0;
        acc.usage.input_tokens += Math.max(0, (st.input_tokens || st.input || 0) - cached);
        acc.usage.cache_read_input_tokens += cached;
        acc.usage.output_tokens += st.output_tokens || st.output || 0;
        if (j.status && j.status !== 'success') acc.failed = true;
      }
    },
  },
  // Google Antigravity CLI (agy): -p= with stream-json in and out; the question goes in as one JSON line,
  // resume with --conversation <id>. Event shapes checked against the real agy 1.2.16 on 2026-10-07.
  agycli: {
    cmd: 'agy',
    args: (S, model) => ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'accept-edits', ...(okId(model) ? ['--model', model] : []), ...(okId(S.sessionId) ? ['--conversation', S.sessionId] : []), '-p='],
    stdin: (prompt) => JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n',
    on(j, S, emit, acc) {
      if (j.event === 'init' && j.conversation_id) { if (j.conversation_id !== S.sessionId) { S.sessionId = j.conversation_id; emit({ type: 'session', id: S.sessionId }); } return; }
      if (j.event === 'step_update' && j.step_update) {
        const u = j.step_update;
        if (u.step_type === 'agent_response' && u.text_delta) {
          const fresh = acc.step !== u.step_index; // a new reply after a tool step starts a new paragraph
          acc.step = u.step_index;
          emit({ type: 'text', text: (fresh && acc.said ? '\n\n' : '') + u.text_delta });
          acc.said = true;
        } else if (u.step_type === 'tool' && u.state === 'ACTIVE') {
          const info = u.tool_info || {};
          const input = info.parameters || {};
          const p = input.AbsolutePath || input.TargetFile || input.FilePath || input.File || input.DirectoryPath || input.SearchPath;
          const rel = typeof p === 'string' ? relInVault(p) : null;
          const name = String(u.tool_name || info.name || 'tool');
          const edit = /write_to_file|replace_file_content|sed_file|notebook_edit/i.test(name);
          if (rel !== null && edit) shared.markWritten(rel);
          emit({ type: 'tool', name: edit ? 'Edit' : /view_file|read_url/i.test(name) ? 'Read' : /run_command/i.test(name) ? 'Shell' : /search_web/i.test(name) ? 'WebSearch' : name, input: p ? { ...input, file_path: p } : input, path: rel });
        }
        return;
      }
      if (j.event === 'result' && j.result) {
        const r = j.result, us = r.usage || {};
        const cached = us.cache_read_tokens || 0;
        acc.usage.input_tokens += Math.max(0, (us.input_tokens || 0) - cached);
        acc.usage.cache_read_input_tokens += cached;
        acc.usage.output_tokens += us.output_tokens || 0;
        if (r.status && r.status !== 'SUCCESS') { emit({ type: 'error', message: String(r.error || 'Antigravity reported an error.') }); acc.failed = true; }
      }
    },
  },
};

// Starts the CLI, writes the prompt to its stdin, and calls onLine for every JSON line it prints.
function runCli(kind, S, model, prompt, signal, onLine) {
  const A = ADAPTERS[kind];
  const exe = process.env[`AOS_FAKE_${kind.toUpperCase()}`] || providers.cliPath(A.cmd); // the env var is for tests only
  return new Promise((resolve, reject) => {
    if (!exe) return reject(new Error(`${A.cmd} is not installed. Open Settings, then Brain, to install it or pick another brain.`));
    // npm installs a .cmd launcher, which needs a shell. Everything on the command line is a fixed flag or a
    // checked id; the user's words only ever go in on stdin.
    const p = spawn(`"${exe}" ${A.args(S, model).join(' ')}`, { cwd: vault.ROOT, shell: true, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
    let buf = '', err = '';
    const kill = () => { try { spawn('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true }); } catch { /* gone */ } };
    signal.addEventListener('abort', kill);
    p.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('{')) { try { onLine(JSON.parse(line)); } catch { /* not an event line */ } }
      }
    });
    p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    p.on('error', (e) => { signal.removeEventListener('abort', kill); reject(e); });
    p.on('close', (code) => {
      signal.removeEventListener('abort', kill);
      if (buf.trim().startsWith('{')) { try { onLine(JSON.parse(buf.trim())); } catch { /* partial */ } }
      resolve({ code, err: err.trim() });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(A.stdin ? A.stdin(prompt) : prompt);
  });
}

const NOT_SIGNED_IN = /not logged in|login required|unauthori[sz]ed|authenticat|sign in|401/i;

async function send(chatId, text, emit, files = []) {
  const S = chatFor(chatId);
  const raw = emit;
  emit = (e) => raw({ ...e, chat: S.id });
  if (S.abort) { emit({ type: 'error', message: 'Still working on the last request.' }); return; }
  if (running().length >= MAX_RUNNING) { emit({ type: 'error', message: `${MAX_RUNNING} chats are already working. Let one finish or stop one first, then ask again.` }); emit({ type: 'done' }); return; }
  S.abort = new AbortController();
  const signal = S.abort.signal, t0 = Date.now(), myGen = S.gen;
  const p = providers.active();
  const kind = p.engine;
  if (!S.title) S.title = String(text || '').replace(/\s+/g, ' ').slice(0, 60);
  S.turns++;
  emit({ type: 'start' });
  const fresh = !S.sessionId;
  const model = (p.models && p.models.standard) || '';
  const acc = { usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, failed: false, said: false };
  const outside = [...S.outsideChanges].slice(0, 40);
  S.outsideChanges = new Set();
  const prompt = [
    fresh ? `[Standing instructions from the app, not from the user]\n${standing()}\n[End of standing instructions]` : '',
    outside.length ? `[Note from the app: these notes changed since you last looked, not by you: ${outside.join(', ')}]` : '',
    text,
    files.length ? `[Attached file${files.length === 1 ? '' : 's'}; read ${files.length === 1 ? 'it' : 'them'} before you answer: ${files.join(' ; ')}]` : '',
  ].filter(Boolean).join('\n\n');
  try {
    const r = await runCli(kind, S, model, prompt, signal, (j) => { if (myGen === S.gen) ADAPTERS[kind].on(j, S, emit, acc); });
    if (signal.aborted) emit({ type: 'error', message: 'Stopped.' });
    else if (r.code !== 0 && !acc.failed) {
      acc.failed = true;
      emit({ type: 'error', message: NOT_SIGNED_IN.test(r.err) ? `${p.name} is not signed in. Open Settings, then Brain, and sign in again.` : `${ADAPTERS[kind].cmd} stopped with an error${r.err ? `: ${r.err.split(/\r?\n/).slice(-2).join(' ').slice(0, 300)}` : ` (code ${r.code})`}.` });
    }
  } catch (err) {
    acc.failed = true;
    emit({ type: 'error', message: signal.aborted ? 'Stopped.' : String((err && err.message) || err) });
  } finally {
    emit({ type: 'result', isError: acc.failed, costUsd: 0, fresh: true, usage: acc.usage, models: [model || kind], asked: model || kind, light: false, kind: 'ask', skills: [], ms: Date.now() - t0 });
    S.abort = null;
    S.lastActive = Date.now();
    emit({ type: 'done' });
  }
}

function stop(chatId) {
  const all = chatId == null;
  shared.cancel(chatId);
  for (const S of chats.values()) if (S.abort && (all || S.id === chatId)) S.abort.abort();
  return true;
}
function openChat(chatId, sid) { const S = chatFor(chatId); if (!S.abort) { if (okId(sid)) S.sessionId = sid; S.lastActive = Date.now(); } return true; }
function closeChat(chatId) { stop(chatId); const S = chats.get(chatId); if (S) { S.gen++; chats.delete(chatId); } return true; }
function noteOutsideChanges(files) { for (const S of chats.values()) for (const f of files) S.outsideChanges.add(f); }
function status() {
  const on = running();
  const p = providers.active();
  return { ready: true, mode: 'sub', model: (p.models && p.models.standard) || p.engine, busy: on.length > 0, running: on.map((S) => S.id) };
}

// One question, one answer, in a throwaway session. Dreams uses it.
async function oneShot({ system, prompt, schema }) {
  const p = providers.active();
  const S = { id: 'oneshot', sessionId: null };
  const acc = { usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, failed: false, said: false };
  let text = '';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 240000);
  try {
    await runCli(p.engine, S, (p.models && p.models.standard) || '', `${system}${schema ? `\n\nAnswer with ONE JSON object and nothing else, matching this JSON schema:\n${JSON.stringify(schema)}` : ''}\n\n${prompt}`, ctl.signal,
      (j) => ADAPTERS[p.engine].on(j, S, (e) => { if (e.type === 'text') text += e.text; if (e.type === 'error') acc.failed = e.message; }, acc));
  } finally { clearTimeout(timer); }
  if (acc.failed && !text) throw new Error(typeof acc.failed === 'string' ? acc.failed : 'the model call failed');
  let out = null;
  const m = text.match(/\{[\s\S]*\}/);
  if (m) try { out = JSON.parse(m[0]); } catch { /* no JSON */ }
  return { out, text, usage: { input: acc.usage.input_tokens, output: acc.usage.output_tokens, cacheRead: acc.usage.cache_read_input_tokens, cacheWrite: 0 }, model: (p.models && p.models.standard) || p.engine, cost: 0 };
}

module.exports = { id: 'cli', send, stop, openChat, closeChat, status, mode: () => 'sub', noteOutsideChanges, oneShot, ADAPTERS };

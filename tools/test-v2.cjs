// Tests for what is new in v2, with nothing real touched: a throwaway data folder, a throwaway vault, a stand-in
// LLM server on localhost, stand-in Codex/Gemini command-line apps, and a throwaway data folder.
// No window opens, no real provider is called, no tokens are spent.
// Run:  node_modules\.bin\electron tools\test-v2.cjs
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-v2-test-'));
const VAULT = path.join(tmp, 'vault');
app.setPath('userData', path.join(tmp, 'userData'));
process.env.AGENTIC_OS_VAULT = VAULT;
process.env.AOS_BACKUP_DIR = path.join(tmp, 'backups');
process.env.AOS_REMOTE_HOST = '127.0.0.1'; // the phone server listens on this PC only during tests (no firewall prompt)
delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.GEMINI_API_KEY;

const put = (rel, text, root = VAULT) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
put('index.md', '# Notes\n\n- [Alpha](notes/alpha.md)\n');
put('notes/alpha.md', '# Alpha\n\nThe launch date is 12 March.\n');
put('skills/tidy/SKILL.md', '---\nname: tidy\ndescription: How to tidy notes\n---\nTidy them.\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const check = (name, ok, extra = '') => { console.log(ok ? 'ok   ' : 'FAIL ', name, ok ? '' : extra); ok ? passed++ : failed++; };

// ---------- a stand-in LLM server (OpenAI chat API) ----------
// Each test queues the replies the "model" should give; every request body is kept for checking.
const script = [];
const seen = [];
const sse = (res, chunks) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`); res.write('data: [DONE]\n\n'); res.end(); };
const say = (text) => [{ choices: [{ delta: { content: text.slice(0, 5) } }] }, { choices: [{ delta: { content: text.slice(5) } }] }, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } }];
const callTool = (name, args, id = 'call_1') => [{ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] }, { choices: [], usage: { prompt_tokens: 50, completion_tokens: 10 } }];
let llmPort = 0;
const llm = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/v1/models') {
      if (req.headers.authorization !== 'Bearer good-key') { res.writeHead(401); return res.end('{"error":{"message":"bad key"}}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'big-model', created: 30 }, { id: 'small-mini', created: 20 }, { id: 'text-embedding-9', created: 40 }, { id: 'huge-pro', created: 10 }] }));
    }
    if (req.url === '/v1/chat/completions') {
      const j = JSON.parse(body);
      seen.push({ auth: req.headers.authorization, body: j });
      const next = script.shift();
      if (!next) { res.writeHead(500); return res.end('{"error":{"message":"test script ran out"}}'); }
      if (next.status) { res.writeHead(next.status); return res.end(JSON.stringify({ error: { message: next.message || 'nope' } })); }
      if (next.hang) return; // never answers: for the Stop test
      if (!j.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: next.json } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); }
      return sse(res, next);
    }
    res.writeHead(404); res.end();
  });
});

// Run one question through an engine and collect its events. `answer(evt)` can answer approval cards.
async function ask(engine, chat, text, { files = [], answer } = {}) {
  const events = [];
  const shared = require('../electron/shared.cjs');
  await engine.send(chat, text, (e) => { events.push(e); if (e.type === 'approval' && answer) setTimeout(() => { const a = answer(e); shared.approve(e.id, a.yes, a.question || ''); }, 20); }, files);
  for (let i = 0; i < 100 && !events.some((e) => e.type === 'done'); i++) await sleep(50);
  return { events, text: events.filter((e) => e.type === 'text').map((e) => e.text).join(''), of: (t) => events.filter((e) => e.type === t) };
}

app.whenReady().then(async () => {
  try {
    await new Promise((r) => llm.listen(0, '127.0.0.1', r));
    llmPort = llm.address().port;
    const BASE = `http://127.0.0.1:${llmPort}/v1`;

    // ---------- settings and secrets ----------
    const settings = require('../electron/settings.cjs');
    settings.set({ userName: 'Robin' });
    check('settings: saved and read back', settings.get('userName') === 'Robin' && JSON.parse(fs.readFileSync(path.join(tmp, 'userData', 'settings.json'), 'utf8')).userName === 'Robin');
    settings.setSecret('key:test', 'sk-super-secret-1234');
    const rawSecrets = fs.readFileSync(path.join(tmp, 'userData', 'secrets.json'), 'utf8');
    check('secrets: read back whole', settings.getSecret('key:test') === 'sk-super-secret-1234');
    check('secrets: not stored as readable text when Windows encryption is available', !settings.canEncrypt() || !rawSecrets.includes('sk-super-secret-1234'), rawSecrets.slice(0, 80));
    check('secrets: the window only gets a hint', JSON.stringify(settings.hint('key:test')) === '{"saved":true,"tail":"1234"}');
    settings.setSecret('key:test', '');
    check('secrets: can be removed', settings.getSecret('key:test') === '' && !settings.hint('key:test').saved);

    // ---------- providers: key check, model suggestions, saving ----------
    const providers = require('../electron/providers.cjs');
    let r = await providers.test({ id: 'custom', key: 'wrong', baseUrl: BASE });
    check('provider: a bad key is refused in plain words', !r.ok && /not accepted/.test(r.error), JSON.stringify(r));
    r = await providers.test({ id: 'custom', key: 'good-key', baseUrl: BASE });
    check('provider: a good key lists chat models only', r.ok && r.models.join() === 'big-model,huge-pro,small-mini', JSON.stringify(r));
    check('provider: suggests quick / everyday / strong models', r.suggested.light === 'small-mini' && r.suggested.standard === 'big-model' && r.suggested.strong === 'huge-pro', JSON.stringify(r.suggested));
    r = await providers.test({ id: 'local', baseUrl: 'http://127.0.0.1:9/v1' });
    check('provider: a local server that is not running says so', !r.ok && /Nothing answered/.test(r.error), JSON.stringify(r));
    check('provider: cannot save "key" with no key', !providers.save({ id: 'custom', method: 'key', baseUrl: BASE }).ok);
    r = providers.save({ id: 'custom', method: 'key', key: 'good-key', baseUrl: BASE, models: { light: 'small-mini', standard: 'big-model', strong: 'huge-pro' } });
    const st = providers.state();
    check('provider: saved; the window sees no key', r.ok && st.current.id === 'custom' && st.current.key.saved && !JSON.stringify(st).includes('good-key'), JSON.stringify(st.current));
    check('provider: the engines get the key and the right engine', providers.active().key === 'good-key' && providers.active().engine === 'universal');
    check('provider: Claude on a plan login never falls back to a stray key', (() => { const before = settings.get('provider'); settings.set({ provider: { ...before, id: 'claude', method: 'subscription' } }); process.env.ANTHROPIC_API_KEY = 'sk-ant-stray'; const m = require('../electron/claude.cjs').mode(); delete process.env.ANTHROPIC_API_KEY; settings.set({ provider: before }); return m === 'plan'; })());

    // ---------- the universal engine ----------
    const engine = require('../electron/engine.cjs');
    const shared = require('../electron/shared.cjs');
    check('router: picks the universal engine', engine.name() === 'universal' && engine.mode() === 'api');

    script.push(say('Hello there, boss.'));
    let a = await ask(engine, 'c1', 'hi');
    check('chat: streams a reply', a.text === 'Hello there, boss.', a.text);
    check('chat: events in order', a.events[0].type === 'start' && a.events.at(-1).type === 'done' && a.of('result').length === 1, a.events.map((e) => e.type).join());
    check('chat: a short hello goes to the quick model', seen.at(-1).body.model === 'small-mini', seen.at(-1).body.model);
    check('chat: sends the key only as a bearer header', seen.at(-1).auth === 'Bearer good-key');
    const sys = seen.at(-1).body.messages[0];
    check('chat: standing instructions carry the persona, the user name, the skills and the vault index', sys.role === 'system' && /You are Assistant, Robin's assistant/.test(sys.content) && /Robin/.test(sys.content) && /tidy: How to tidy notes/.test(sys.content) && /\[Alpha\]\(notes\/alpha\.md\)/.test(sys.content), sys.content.slice(0, 200));
    const res1 = a.of('result')[0];
    check('chat: counts tokens (fresh, cached, output)', res1.usage.input_tokens === 60 && res1.usage.cache_read_input_tokens === 40 && res1.usage.output_tokens === 20, JSON.stringify(res1.usage));
    check('chat: session id is tagged with its engine', /^universal:u-c1-/.test(a.of('session')[0].id), JSON.stringify(a.of('session')));

    script.push(callTool('Read', { file_path: 'notes/alpha.md' }), say('It is 12 March.'));
    a = await ask(engine, 'c1', 'Read the alpha note and summarise the launch plan for me please');
    check('tools: Read runs and its result goes back to the model', a.text === 'It is 12 March.' && /12 March/.test(seen.at(-1).body.messages.at(-1).content) && seen.at(-1).body.messages.at(-1).role === 'tool', JSON.stringify(seen.at(-1).body.messages.at(-1)));
    check('tools: the file lights up (tool event with its vault path)', a.of('tool')[0].name === 'Read' && a.of('tool')[0].path === 'notes/alpha.md');
    check('chat: a later, longer question moves to the everyday model and keeps the history', seen.at(-1).body.model === 'big-model' && seen.at(-1).body.messages.some((m) => m.content === 'Hello there, boss.'));

    script.push(callTool('Edit', { file_path: 'notes/alpha.md', old_string: '12 March', new_string: '19 March' }), say('Changed.'));
    a = await ask(engine, 'c1', 'Change the launch date in the alpha note to the 19th of March please');
    const backups = fs.existsSync(process.env.AOS_BACKUP_DIR) ? fs.readdirSync(process.env.AOS_BACKUP_DIR, { recursive: true }).filter((n) => /alpha\.md$/.test(String(n))) : [];
    check('edit: the file is changed', /19 March/.test(fs.readFileSync(path.join(VAULT, 'notes/alpha.md'), 'utf8')));
    check('edit: the old version was backed up first', backups.length === 1 && /12 March/.test(fs.readFileSync(path.join(process.env.AOS_BACKUP_DIR, String(backups[0])), 'utf8')), JSON.stringify(backups));
    check('edit: no card for an ordinary edit, and the app knows it wrote it', a.of('approval').length === 0 && shared.wroteRecently('notes/alpha.md'));

    script.push(callTool('Write', { file_path: 'notes/new.md', content: '# New\n' }), say('Made it.'));
    a = await ask(engine, 'c1', 'Create a new note called new in the notes folder with a heading please');
    check('write: creates a file inside the vault', fs.readFileSync(path.join(VAULT, 'notes/new.md'), 'utf8') === '# New\n');

    const marker = path.join(tmp, 'ran.txt');
    script.push(callTool('PowerShell', { command: `git reset --hard; Set-Content -Path '${marker}' -Value x`, description: 'Throws away uncommitted work' }), say('Left it.'));
    a = await ask(engine, 'c1', 'Please reset the repository to how it was before all of my changes', { answer: () => ({ yes: false }) });
    check('gate: a catastrophic command shows a risky card with plain words', a.of('approval').length === 1 && a.of('approval')[0].risky && /git work/.test(a.of('approval')[0].summary) && a.of('approval')[0].what === 'Throws away uncommitted work', JSON.stringify(a.of('approval')));
    check('gate: "no" means it never runs, and the model is told', !fs.existsSync(marker) && /said no/.test(seen.at(-1).body.messages.at(-1).content), seen.at(-1).body.messages.at(-1).content);

    script.push(callTool('PowerShell', { command: 'git clean -fd', description: 'Deletes untracked files' }), say('It deletes files git does not track.'));
    a = await ask(engine, 'c1', 'Please clean out every one of the untracked files in the repository', { answer: () => ({ yes: false, question: 'what does that delete?' }) });
    check('gate: asking a question first holds the action and passes the question on', /what does that delete\?/.test(seen.at(-1).body.messages.at(-1).content) && a.of('approved')[0].question === 'what does that delete?');

    script.push(callTool('PowerShell', { command: `Set-Content -Path '${marker}' -Value hello; Get-Content '${marker}'`, description: 'Writes a test file' }), say('Done.'));
    a = await ask(engine, 'c1', 'Please write the word hello into the little test file and show it to me');
    check('command: an ordinary command runs without a card and its output goes back', a.of('approval').length === 0 && fs.existsSync(marker) && /hello/.test(seen.at(-1).body.messages.at(-1).content), seen.at(-1).body.messages.at(-1).content);

    script.push(callTool('request_model', { reason: 'tricky bug', handoff: 'look at alpha.md' }), say('Solved on the big one.'));
    a = await ask(engine, 'c1', 'There is a strange bug somewhere in this and I can not find the cause of it', { answer: () => ({ yes: true }) });
    await sleep(300);
    check('models: stepping up asks first, then carries on on the strong model', a.of('approval')[0].tool === 'request_model' && seen.at(-1).body.model === 'huge-pro' && /handoff brief/.test(seen.at(-1).body.messages.at(-1).content), seen.at(-1).body.model);

    script.push(callTool('open_file', { path: 'notes/alpha.md' }), say('There you go.'));
    a = await ask(engine, 'c2', 'Open the alpha note on screen for me so that I can read it please');
    check('open_file: asks the window to show the note', a.of('open')[0] && a.of('open')[0].path === 'notes/alpha.md');

    script.push(callTool('Glob', { pattern: '**/*.md' }), callTool('Grep', { pattern: 'launch', ignore_case: true }, 'call_2'), say('Found.'));
    a = await ask(engine, 'c2', 'Find every markdown note and then search them all for the word launch');
    const toolMsgs = seen.at(-1).body.messages.filter((m) => m.role === 'tool').slice(-2).map((m) => m.content);
    check('search: Glob lists notes and Grep finds the line', /notes\/alpha\.md/.test(toolMsgs[0]) && /notes\/alpha\.md:3: The launch date/.test(toolMsgs[1]), JSON.stringify(toolMsgs));

    script.push({ status: 401 });
    a = await ask(engine, 'c3', 'hello');
    check('errors: a refused key becomes a plain message', a.of('error').length === 1 && /key was not accepted/.test(a.of('error')[0].message) && a.of('result')[0].isError, JSON.stringify(a.of('error')));

    script.push({ hang: true });
    const stopping = ask(engine, 'c4', 'hello');
    await sleep(400);
    engine.stop('c4');
    a = await stopping;
    check('stop: ends a waiting chat cleanly', a.of('error')[0] && a.of('error')[0].message === 'Stopped.' && a.events.at(-1).type === 'done', a.events.map((e) => e.type).join());
    check('script: every scripted reply was used (the test itself is in step)', script.length === 0, String(script.length));

    // a chat survives a restart: forget it in memory, reopen by its saved session id
    const universal = require('../electron/universal.cjs');
    const sid = universal.chatFor('c1').sessionId;
    universal.chatFor('c1').messages = []; universal.chatFor('c1').sessionId = null;
    engine.openChat('c1', `universal:${sid}`);
    script.push(say('Still here.'));
    a = await ask(engine, 'c1', 'Do you remember what we were just talking about a moment ago?');
    check('restart: a reopened chat carries its history', seen.at(-1).body.messages.some((m) => m.content === 'Hello there, boss.') && a.of('session').length === 0);
    engine.openChat('c9', 'a1b2c3d4-0000-4000-8000-000000000000'); // a Claude session id, under another brain
    check('router: a chat from another brain starts fresh instead of failing', universal.chatFor('c9').sessionId === null);

    script.push({ json: '{"cards":[{"headline":"x"}]}' });
    const one = await engine.oneShot({ system: 'sys', prompt: 'digest', schema: { type: 'object' } });
    check('one-shot (Dreams): returns parsed JSON and token counts', one.out.cards[0].headline === 'x' && one.usage.input === 10 && seen.at(-1).body.stream === undefined);

    const hist = await require('../electron/history.cjs').load();
    check('history: questions asked through this brain are counted for Health / Value / Dreams', hist.prompts.some((p) => p.text === 'hi') && hist.prompts.every((p) => !p.text.startsWith('[')), JSON.stringify(hist.prompts.slice(0, 2)));

    // ---------- subscription brains: stand-in Codex and Gemini command-line apps ----------
    const fakeDir = path.join(tmp, 'fake');
    const fake = (name, lines) => {
      put(`${name}.js`, `const fs=require('fs');let i='';process.stdin.on('data',d=>i+=d).on('end',()=>{fs.writeFileSync(${JSON.stringify(path.join(fakeDir, name + '.seen.json'))},JSON.stringify({args:process.argv.slice(2),stdin:i,cwd:process.cwd()}));for(const l of ${JSON.stringify(lines)})console.log(JSON.stringify(l));});`, fakeDir);
      return put(`${name}.cmd`, `@echo off\r\nnode "%~dp0${name}.js" %*\r\n`, fakeDir);
    };
    process.env.AOS_FAKE_CODEX = fake('codex', [
      { type: 'thread.started', thread_id: 'th_123' }, { type: 'turn.started' },
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'dir', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: path.join(VAULT, 'notes', 'alpha.md'), kind: 'update' }] } },
      { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'All sorted.' } },
      { type: 'turn.completed', usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 30 } },
    ]);
    settings.set({ provider: { id: 'openai', method: 'subscription', baseUrl: '', models: { light: '', standard: '', strong: '' } } });
    check('router: ChatGPT subscription uses the Codex engine', engine.name() === 'codex' && engine.mode() === 'sub');
    a = await ask(engine, 'k1', 'tidy the alpha note');
    let got = JSON.parse(fs.readFileSync(path.join(fakeDir, 'codex.seen.json'), 'utf8'));
    check('codex: started in JSON mode, in the vault, with the question on stdin only', got.args.join(' ') === 'exec --json --skip-git-repo-check --sandbox workspace-write -' && path.resolve(got.cwd) === path.resolve(VAULT) && /tidy the alpha note/.test(got.stdin) && /You are Assistant/.test(got.stdin), JSON.stringify(got.args));
    check('codex: reply, steps and tokens come through as normal events', a.text === 'All sorted.' && a.of('tool').map((t) => t.name).join() === 'Shell,Edit' && a.of('tool')[1].path === 'notes/alpha.md' && a.of('result')[0].usage.input_tokens === 300 && a.of('session')[0].id === 'codex:th_123', JSON.stringify(a.events.map((e) => e.type)));
    a = await ask(engine, 'k1', 'and again');
    got = JSON.parse(fs.readFileSync(path.join(fakeDir, 'codex.seen.json'), 'utf8'));
    check('codex: the next question resumes the same thread and does not resend the instructions', got.args.join(' ') === 'exec --json --skip-git-repo-check --sandbox workspace-write resume th_123 -' && !/You are Assistant/.test(got.stdin), JSON.stringify(got.args));

    // Event shapes copied from a real agy 1.2.16 run (2026-10-07).
    const su = (o) => ({ event: 'step_update', step_update: { conversation_id: 'ag_9', ...o } });
    process.env.AOS_FAKE_AGYCLI = fake('agy', [
      { event: 'init', conversation_id: 'ag_9', init: { model: 'gemini-3.8-flash-low' } },
      su({ step_index: 0, state: 'DONE', step_type: 'user_input' }),
      su({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: path.join(VAULT, 'index.md') } } }),
      su({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: path.join(VAULT, 'index.md') }, output: '9 lines' } }),
      su({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Here ' }),
      su({ step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'you go.' }),
      { event: 'result', result: { conversation_id: 'ag_9', status: 'SUCCESS', response: 'Here you go.', usage: { input_tokens: 90, output_tokens: 12, cache_read_tokens: 10 } } },
    ]);
    settings.set({ provider: { id: 'antigravity', method: 'subscription', baseUrl: '', models: { light: '', standard: '', strong: '' } } });
    a = await ask(engine, 'g1', 'what is in the index');
    got = JSON.parse(fs.readFileSync(path.join(fakeDir, 'agy.seen.json'), 'utf8'));
    const sent = JSON.parse(got.stdin.trim());
    check('antigravity cli: stream-json in and out, reply and steps come through', engine.name() === 'agycli' && got.args.join(' ') === '--input-format stream-json --output-format stream-json --mode accept-edits -p=' && sent.event === 'user' && /what is in the index/.test(sent.message.content) && a.text === 'Here you go.' && a.of('tool')[0].name === 'Read' && a.of('tool')[0].path === 'index.md' && a.of('session')[0].id === 'agycli:ag_9' && a.of('result')[0].usage.output_tokens === 12 && a.of('result')[0].usage.input_tokens === 80, JSON.stringify(got.args) + a.text);
    a = await ask(engine, 'g1', 'and again');
    got = JSON.parse(fs.readFileSync(path.join(fakeDir, 'agy.seen.json'), 'utf8'));
    check('antigravity cli: the next question resumes the same conversation', got.args.join(' ').includes('--conversation ag_9'), JSON.stringify(got.args));
    delete process.env.AOS_FAKE_CODEX;
    const missing = providers.cliPath('codex');
    if (!missing) { settings.set({ provider: { id: 'openai', method: 'subscription', baseUrl: '', models: {} } }); a = await ask(engine, 'k2', 'hello'); check('codex: not installed says so plainly', /not installed/.test((a.of('error')[0] || {}).message || ''), JSON.stringify(a.of('error'))); }
    settings.set({ provider: { id: 'custom', method: 'key', baseUrl: BASE, models: { light: 'small-mini', standard: 'big-model', strong: 'huge-pro' } } });

    // ---------- the phone link ----------
    const api = require('../electron/api.cjs');
    const remote = require('../electron/remote.cjs');
    api.handle('vault:info', () => ({ notes: 3 }), { remote: true });
    api.handle('echo:bytes', (_c, buf) => Buffer.from(buf).toString('utf8'), { remote: true });
    api.handle('brain:send', (c, text) => { c.send('brain:event', { type: 'text', text: 'only you: ' + text }); api.broadcast('brain:event', { type: 'done' }); return true; }, { remote: true });
    api.handle('providers:save', () => 'should never run from a phone');
    const dist = path.join(tmp, 'dist');
    put('index.html', '<!doctype html><div id="root">app</div>', dist);
    put('assets/a.js', 'console.log(1)', dist);
    settings.set({ remote: { enabled: true, port: 18765 + (process.pid % 500) } });
    remote.start({ dist: () => dist });
    await sleep(300);
    const P = `http://127.0.0.1:${remote.status().port}`;
    const get = (u, h = {}) => fetch(P + u, { headers: h, redirect: 'manual' });
    const post = (channel, args, h = {}) => fetch(P + '/api/invoke', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ channel, args }) });
    check('phone: nothing without pairing (page, API, vault files)', (await get('/')).status === 401 && (await post('vault:info', [])).status === 401 && (await get('/vault/index.md')).status === 401);
    check('phone: a wrong code is refused', (await get('/pair?k=nope')).status === 401);
    // A bad percent-escape used to throw inside the server's request handler (found in the 7 Oct code review).
    const raw = (p) => new Promise((ok) => { http.get({ host: '127.0.0.1', port: remote.status().port, path: p }, (r) => { r.resume(); ok(r.statusCode); }).on('error', () => ok(0)); });
    check('phone: a malformed address gets a 400 and the server carries on', (await raw('/%E0%A4%A')) === 400 && (await get('/')).status === 401);
    const pair = await get(remote.pairPath());
    const cookie = (pair.headers.get('set-cookie') || '').split(';')[0];
    check('phone: the right code pairs and sets an http-only cookie', pair.status === 302 && /^aos=[a-f0-9]{48}$/.test(cookie) && /HttpOnly/.test(pair.headers.get('set-cookie')), pair.headers.get('set-cookie'));
    const C = { Cookie: cookie, 'X-Client': 'phone1' };
    check('phone: serves the app and its files once paired', (await (await get('/', C)).text()).includes('id="root"') && (await get('/assets/a.js', C)).status === 200);
    check('phone: can call what it is allowed to', (await (await post('vault:info', [], C)).json()).result.notes === 3);
    check('phone: cannot call desktop-only things (keys, sign-ins)', (await (await post('providers:save', [{}], C)).json()).ok === false && (await (await post('nope:nothing', [], C)).json()).ok === false);
    check('phone: files and speech arrive as bytes', (await (await post('echo:bytes', [{ __b64: Buffer.from('héllo').toString('base64') }], C)).json()).result === 'héllo');
    check('phone: another website cannot drive the app with the phone\'s cookie', (await post('vault:info', [], { ...C, Origin: 'https://evil.example' })).status === 403);
    check('phone: reads vault files, and nothing outside the vault', /Alpha/.test(await (await get('/vault/notes/alpha.md', C)).text()) && (await get('/vault/..%2F..%2Fsecrets.json', C)).status === 404 && (await get('/..%2Fuserdata%2Fsecrets.json', C)).status === 404);
    // events: a private one for this phone, a broadcast for every screen
    const ev = await fetch(P + '/api/events?c=phone1', { headers: { Cookie: cookie } });
    const reader = ev.body.getReader();
    let stream = '';
    const pump = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; stream += Buffer.from(value).toString('utf8'); } })().catch(() => {});
    await sleep(200);
    await post('brain:send', ['ping'], C);
    await sleep(300);
    check('phone: gets its own events and the shared ones', /only you: ping/.test(stream) && /"type":"done"/.test(stream), stream.slice(0, 200));
    check('phone: counted as connected', remote.status().phones === 1);
    remote.newToken();
    await sleep(200);
    check('phone: "unpair all" locks old phones out', (await post('vault:info', [], C)).status === 401 && remote.status().phones === 0);
    reader.cancel().catch(() => {}); await pump;
    remote.stop();

    settings.setSecret('discord:token', 'tok-abc');
    check('discord: reads the saved (encrypted) token when there is no .env', require('../electron/discord.cjs').readConfig([path.join(tmp, 'nowhere')]).token === 'tok-abc');

    // ---------- the vault can move without a restart ----------
    const vault = require('../electron/vault.cjs');
    const other = path.join(tmp, 'vault2');
    put('index.md', '# Other\n', other);
    vault.setRoot(other);
    check('vault: switching folders takes effect at once', vault.info().notes === 1 && vault.ROOT === other && vault.resolveInside('../vault/index.md') === null);
  } catch (err) {
    failed++;
    console.log('FAIL  the test run itself broke:', err && err.stack ? err.stack : err);
  } finally {
    console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
    llm.close();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows may still hold a file; it is in the temp folder */ }
    app.exit(failed ? 1 : 0);
  }
});

// What the real Claude Code engine actually sends to a gateway, for the connection Agentic OS saved.
// The assistant's own settings are set up in a throwaway data folder, then the real engine (the one Agentic OS uses) is started with
// exactly what Agentic OS would give it, against a stand-in gateway on this PC that records each request and answers with an
// error on purpose. Nothing leaves this PC and no tokens are spent.
// Run:  node_modules\.bin\electron tools\test-wire.cjs
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-wire-test-'));
app.setPath('userData', path.join(tmp, 'userData'));
process.env.AOS_VAULT = path.join(tmp, 'notes');
fs.mkdirSync(process.env.AOS_VAULT, { recursive: true });
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete process.env[k];

// Anything printed in a failure is masked: only the first characters of a credential are ever shown.
const mask = (seen) => JSON.stringify(seen.map((s) => ({ ...s, auth: String(s.auth).replace(/(Bearer\s+\S{3})\S*/, '$1…'), apiKey: s.apiKey ? '…' : '' })));
let passed = 0, failed = 0;
const check = (name, ok, extra = '') => { console.log(ok ? 'ok   ' : 'FAIL ', name, ok ? '' : extra); ok ? passed++ : failed++; };

// a stand-in gateway: records every request, answers with an error so the engine stops after one try
function standIn() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let j = null; try { j = JSON.parse(body); } catch { /* not JSON */ }
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', apiKey: req.headers['x-api-key'] || '', model: j && j.model });
      res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"message":"stand-in: stop here"}');
    });
  });
  return { seen, srv, start: () => new Promise((r) => srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + srv.address().port))) };
}

// run the real engine the way claude.cjs does (same environment, same settings, same model name), one question
async function runEngine(claude, model) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const q = query({ prompt: 'hi', options: { cwd: process.env.AOS_VAULT, model: claude.engineModel(model), env: claude.authEnv(), settings: claude.engineSettings(), settingSources: [], mcpServers: {}, maxTurns: 1, persistSession: false } });
  const stop = setTimeout(() => { try { q.close(); } catch { /* gone */ } }, 25000);
  try { for await (const m of q) if (m.type === 'result') break; } catch { /* the stand-in answers with an error on purpose */ }
  clearTimeout(stop); try { q.close(); } catch { /* gone */ }
}

app.whenReady().then(async () => {
  try {
    const providers = require('../electron/providers.cjs');
    const claude = require('../electron/claude.cjs');

    // 1. a gateway in Anthropic's own format: the model in the request body is the pinned name
    let g = standIn(); let base = await g.start();
    providers.save({ id: 'claude', method: 'key', key: 'tok-wire-1234', baseUrl: base, models: { light: 'gw-quick', standard: 'gw-everyday', strong: 'gw-hard' } });
    await runEngine(claude, claude.SONNET);
    let calls = g.seen.filter((s) => /\/v1\/messages/.test(s.url));
    check('wire, gateway: the model in the request is the pinned name, key as a bearer token', calls.length > 0 && calls.every((c) => c.model === 'gw-everyday' && c.auth === 'Bearer tok-wire-1234'), mask(g.seen));
    check('wire: with a key or a gateway the engine is given its own empty config folder, so a Claude login on this PC is never sent anywhere', /engine-home$/.test(claude.authEnv().CLAUDE_CONFIG_DIR || ''));
    g.srv.close();

    // 2. the quick tier with no quick model pinned uses the everyday one
    g = standIn(); base = await g.start();
    providers.save({ id: 'claude', method: 'key', key: 'tok-wire-1234', baseUrl: base, models: { light: '', standard: 'gw-everyday', strong: '' } });
    await runEngine(claude, claude.HAIKU);
    calls = g.seen.filter((s) => /\/v1\/messages/.test(s.url));
    check('wire, gateway: a quick question with no quick model pinned goes to the everyday model, not to one the account may lack', calls.length > 0 && calls.every((c) => c.model === 'gw-everyday'), JSON.stringify(g.seen.map((s) => s.model)));
    g.srv.close();

    providers.save({ id: 'claude', method: 'subscription' });
    check('wire: on the Claude plan sign-in the engine uses the normal config folder, where that login is', claude.authEnv().CLAUDE_CONFIG_DIR === undefined || claude.authEnv().CLAUDE_CONFIG_DIR === process.env.CLAUDE_CONFIG_DIR);
  } catch (err) {
    failed++;
    console.log('FAIL  the test run itself broke:', err && err.stack ? err.stack : err);
  } finally {
    console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows may still hold a file; it is in the temp folder */ }
    app.exit(failed ? 1 : 0);
  }
});

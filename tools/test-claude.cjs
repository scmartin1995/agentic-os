// Tests for the parts of electron/claude.cjs that need no Claude call: which model a question gets, what the standing
// instructions say and when they change, what rides in with a question, and which connectors stay in a chat.
// Nothing real is touched (throwaway data folder and vault); no tokens are spent.
// Run:  node_modules\.bin\electron tools\test-claude.cjs
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-claude-test-'));
const VAULT = path.join(tmp, 'vault');
app.setPath('userData', path.join(tmp, 'userData'));
process.env.AGENTIC_OS_VAULT = VAULT;
process.env.AOS_BACKUP_DIR = path.join(tmp, 'backups');
delete process.env.AGENTIC_OS_MODEL; // a forced model would hide everything below

const put = (rel, text) => { const f = path.join(VAULT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
put('index.md', '# Notes\n\n- [Alpha](notes/alpha.md)\n');
put('notes/index.md', '---\ntype: Index\n---\n# Notes folder\n\nNothing yet.\n');
put('notes/alpha.md', '# Alpha\n');

let passed = 0, failed = 0;
const check = (name, ok, extra = '') => { console.log(ok ? 'ok   ' : 'FAIL ', name, ok ? '' : extra); ok ? passed++ : failed++; };

app.whenReady().then(() => {
  try {
    const claude = require('../electron/claude.cjs');
    const connectors = require('../electron/connectors.cjs');
    const { HAIKU, SONNET } = claude;
    let n = 0;
    const fresh = () => claude.chatFor('t' + ++n);
    const midChat = (lastModel) => { const S = fresh(); S.sessionId = 'sess-' + n; S.lastModel = lastModel; return S; };

    // ---------- isLight: what counts as a quick lookup ----------
    check('light: a short question that asks for a fact', claude.isLight("What's the launch date?") && claude.isLight('who is on the team'));
    check('light: small talk', claude.isLight('thanks') && claude.isLight('Hey there') && claude.isLight('cool, got it'));
    check('not light: anything asking for work to be done', !claude.isLight('what is the best way to build this?') && !claude.isLight('can you update the README'));
    check('not light: long questions, and statements that are not questions', !claude.isLight('what ' + 'is the thing '.repeat(12)) && !claude.isLight('The launch date moved to March'));

    // ---------- pickModel: the cheapest model that fits, and never a mid-chat switch to Haiku ----------
    check('model: a short lookup that opens a chat runs on Haiku', claude.pickModel(fresh(), 'what is the launch date?', false) === HAIKU);
    check('model: a first question that is work runs on Sonnet', claude.pickModel(fresh(), 'write the launch plan', false) === SONNET);
    check('model: attaching a file is never "light"', claude.pickModel(fresh(), 'what is this?', true) === SONNET);
    check('model: a lookup in the middle of a Sonnet chat stays on Sonnet (a switch would re-read the whole chat)', claude.pickModel(midChat(SONNET), 'what is the date?', false) === SONNET);
    check('model: a chat that began on Haiku stays there for short lookups', claude.pickModel(midChat(HAIKU), 'when is it?', false) === HAIKU);
    check('model: a chat that began on Haiku moves to Sonnet at the first real question', claude.pickModel(midChat(HAIKU), 'please write the summary', false) === SONNET);
    check('model: "yes, do it" stays on the model that proposed it', claude.pickModel(midChat('claude-opus-5-5'), 'yes, do it', false) === 'claude-opus-5-5');
    const stepped = midChat(SONNET);
    stepped.stepUp = { model: 'claude-fable-5-1', turns: 2 };
    const seq = [1, 2, 3].map(() => claude.pickModel(stepped, 'carry on with the plan', false));
    check('model: a step-up lasts its turns, then drops back', seq.join() === ['claude-fable-5-1', 'claude-fable-5-1', SONNET].join() && stepped.stepUp === null, seq.join());

    // ---------- standing instructions: written once per chat, never changed mid-chat ----------
    const S = fresh();
    const first = claude.systemAppend(S, true);
    check('instructions: carry the persona, the method, the backup folder and the vault indexes', /You are Assistant/.test(first) && /How to answer every question/.test(first) && /Backups of files you changed/.test(first) && /### index\.md/.test(first) && /Nothing yet\./.test(first) && !/type: Index/.test(first), first.slice(0, 120));
    put('notes/index.md', '# Notes folder\n\nSomething new has landed here.\n');
    check('instructions: the same text for the rest of the chat even after an index page changes (keeps the cache)', claude.systemAppend(S, false) === first);
    check('instructions: a new chat reads the pages again', /Something new has landed here\./.test(claude.systemAppend(fresh(), true)));

    // ---------- what rides in with a question instead ----------
    const c1 = claude.questionContext(S);
    check('question note: first one says where he was, and that an index page changed since the chat began', /Where you were/.test(c1) && /Index pages changed since this chat began/.test(c1) && /notes\/index\.md/.test(c1), c1);
    check('question note: not repeated when nothing new has happened', claude.questionContext(S) === '', claude.questionContext(S));
    S.outsideChanges.add('notes/alpha.md');
    const c2 = claude.questionContext(S);
    check('question note: edits made outside the app are passed on', /Changed since you last looked/.test(c2) && /notes\/alpha\.md/.test(c2), c2);
    claude.rememberFolder('notes/alpha.md', S);
    const c3 = claude.questionContext(S), c4 = claude.questionContext(S);
    check('question note: a new working folder is mentioned once', /You were last working in: notes\//.test(c3) && !/last working in/.test(c4), c3 + ' || ' + c4);

    // ---------- connectors: matching names, and which tools stay out of a chat ----------
    connectors.setSeen([
      { name: 'claude.ai Gmail', status: 'connected', tools: [1, 2, 3], source: 'claudeai' },
      { name: 'claude.ai Google Drive', status: 'connected', tools: [1], source: 'claudeai' },
      { name: 'claude.ai Dropbox', status: 'needs-auth', tools: [], source: 'claudeai' },
      { name: 'github', status: 'connected', tools: [1, 2], source: 'dynamic' },
      { name: 'aos', status: 'connected', tools: [1], source: 'sdk' },
    ]);
    const p = connectors.pick(['gmail', 'Google Drive', 'Dropbox', 'nonsense']);
    check('connectors: names match loosely, only connected apps count, unknown ones are reported', p.keys.join() === 'claude_ai_Gmail,claude_ai_Google_Drive' && p.unknown.join() === 'Dropbox,nonsense', JSON.stringify(p));
    check('connectors: GitHub is spelled with its capital H', connectors.servers().find((s) => s.key === 'github').name === 'GitHub');
    check('connectors: the app\'s own tools are not a connector', !connectors.servers().some((s) => s.key === 'aos'));
    const deny = connectors.denyExcept(new Set(['claude_ai_Gmail']));
    check('connectors: only the app asked for stays; every other one is denied by name', deny.includes('mcp__claude_ai_Google_Drive') && deny.includes('mcp__github') && !deny.includes('mcp__claude_ai_Gmail'), deny.join());
    check('connectors: asking for nothing denies them all', connectors.denyExcept(new Set()).length === 4);
    connectors.setSeen([{ name: 'Higgsfield', status: 'connected', tools: [1], source: 'claudeai' }]);
    check('connectors: a hidden one is kept out of the list and out of the names the assistant is told', connectors.servers().length === 0 && connectors.names().join() === 'Chrome', connectors.names().join());
    check('connectors: names are cleaned of odd characters before the assistant sees them', (() => { connectors.setSeen([{ name: 'claude.ai Ev<il> Tool', status: 'connected', tools: [], source: 'claudeai' }]); return connectors.names().join() === 'Evil Tool,Chrome'; })(), connectors.names().join());

    // ---------- per-row policy and Chrome on demand (2026-10-08) ----------
    connectors.setSeen([
      { name: 'claude.ai Gmail', status: 'connected', tools: [1, 2, 3], source: 'claudeai' },
      { name: 'claude.ai Google Calendar', status: 'connected', tools: [1], source: 'claudeai' },
      { name: 'github', status: 'connected', tools: [1, 2], source: 'dynamic' },
    ]);
    const GM = 'claude_ai_Gmail', CAL = 'claude_ai_Google_Calendar', CH = connectors.CHROME.key;
    let pl = connectors.plan(new Set());
    check('plan: nothing asked for, nothing loaded, Chrome included', pl.load.size === 0 && !pl.chrome && !pl.claudeAi, JSON.stringify([...pl.load]));
    check('plan: "Chrome", "browser" and "Claude in Chrome" all find the browser', ['Chrome', 'browser', 'Claude in Chrome'].every((w) => connectors.pick([w]).keys[0] === CH));
    pl = connectors.plan(new Set([CH]));
    check('plan: asking for Chrome loads only Chrome; the claude.ai apps stay switched off', pl.chrome && !pl.claudeAi && pl.load.size === 1);
    pl = connectors.plan(new Set([GM]));
    check('plan: asking for Gmail loads Gmail and denies the other apps by name', pl.claudeAi && !pl.chrome && pl.deny.includes(`mcp__${CAL}`) && pl.deny.includes('mcp__github') && !pl.deny.includes(`mcp__${GM}`), pl.deny.join());
    connectors.setPolicy(CAL, 'Google Calendar', 'always');
    pl = connectors.plan(new Set());
    check('policy: a row set to "Every chat" loads with nothing asked for', pl.load.has(CAL) && pl.claudeAi && pl.deny.includes(`mcp__${GM}`), JSON.stringify([...pl.load]));
    connectors.setPolicy(GM, 'Gmail', 'never');
    check('policy: a row set to "Never" stays out even when asked for, and the assistant is not told about it', !connectors.plan(new Set([GM])).load.has(GM) && !connectors.names().includes('Gmail'));
    connectors.setMode('always');
    pl = connectors.plan(new Set());
    check('policy: "Every chat" at the top loads everything except rows set to "Never"', pl.chrome && pl.load.has('github') && pl.load.has(CAL) && !pl.load.has(GM), JSON.stringify([...pl.load]));
    connectors.setPolicy(CAL, 'Google Calendar', 'always');
    check('policy: choosing what the switch already says clears the row\'s own setting', connectors.effective(CAL) === 'always' && (() => { connectors.setMode('ondemand'); return connectors.effective(CAL) === 'ondemand'; })());
    connectors.setPolicy(CH, 'Claude in Chrome', 'hidden');
    check('policy: a hidden Chrome cannot be picked or loaded', connectors.pick(['Chrome']).keys.length === 0 && !connectors.plan(new Set([CH])).chrome && !connectors.names().includes('Chrome'));
    connectors.setPolicy(CH, 'Claude in Chrome', 'shown');
    check('policy: showing it again brings it back', connectors.pick(['Chrome']).keys[0] === CH);
    const S2 = fresh();
    check('panel: a chat with nothing asked for shows nothing "in this chat"', claude.loadedConnectors(S2.id).length === 0 && claude.loadedConnectors('no-such-chat').length === 0);
    S2.connectorApps.add(CH); S2.connectorsLeft = 2;
    check('panel: a chat that asked for Chrome shows it "in this chat"', claude.loadedConnectors(S2.id).includes(CH));
  } catch (e) {
    console.log('FAIL  test crashed:', e && e.stack || e);
    failed++;
  }
  console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Electron still holds its data folder; the OS temp cleanup gets it */ }
  app.exit(failed ? 1 : 0);
});

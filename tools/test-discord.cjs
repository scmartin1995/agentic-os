// Tests for electron/discord.cjs against a fake Discord. Run: node tools/test-discord.cjs
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBridge, readConfig, chunks } = require('../electron/discord.cjs');

const ME = '111111111111111111';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok   ', name); } catch (e) { console.log('FAIL ', name, '\n     ', e.message); process.exitCode = 1; }
}

function rig(opts = {}) {
  const sent = []; // every DM
  const calls = []; // approve/stop calls
  const client = { users: { fetch: async () => ({ send: async (p) => { const m = { ...p, edits: [], edit: async (e) => { m.edits.push(e); } }; sent.push(m); return m; } }) } };
  const ran = [];
  const bridge = createBridge({
    client, userId: ME, delayMs: 40, log: () => {},
    approve: (...a) => calls.push(['approve', ...a]), stop: () => calls.push(['stop']),
    run: async (text, sink) => { ran.push(text); sink({ type: 'start' }); sink({ type: 'text', text: 'Right, ' }); sink({ type: 'text', text: 'done.' }); sink({ type: 'done' }); },
    ...opts,
  });
  return { bridge, sent, calls, ran };
}
const approval = (o = {}) => ({ type: 'approval', id: 7, tool: 'Bash', summary: 'delete files or folders: rm -rf secret-folder', what: 'Clears the old build folder', spoken: 'delete files or folders', risky: true, ...o });
const tap = (customId, userId = ME) => { const log = []; return { user: { id: userId }, customId, update: async (p) => log.push(['update', p]), reply: async (p) => log.push(['reply', p]), showModal: async (p) => log.push(['modal', p]), log }; };

(async () => {
  await test('answered at the PC before the delay: no DM', async () => {
    const { bridge, sent } = rig();
    bridge.observe({ type: 'start' }); bridge.observe(approval());
    bridge.observe({ type: 'approved', id: 7, yes: true, question: '' });
    await sleep(100);
    assert.strictEqual(sent.length, 0);
  });

  await test('unanswered: DM with plain words, no raw command, three buttons', async () => {
    const { bridge, sent } = rig();
    bridge.observe({ type: 'start' }); bridge.observe(approval());
    await sleep(100);
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].content.includes('**Wants to:** Delete files or folders'));
    assert.ok(sent[0].content.includes('**In plain words:** Clears the old build folder'));
    assert.ok(!sent[0].content.includes('rm -rf'), 'raw command leaked');
    assert.deepStrictEqual(sent[0].components[0].components.map((b) => b.label), ['Yes', 'No', 'Question']);
    assert.deepStrictEqual(sent[0].allowedMentions, { parse: [] });
  });

  await test('no description from the assistant: card says so and points to the Question button, still no raw command', async () => {
    const { bridge, sent } = rig();
    bridge.observe({ type: 'start' }); bridge.observe(approval({ what: '' }));
    await sleep(100);
    assert.ok(sent[0].content.includes('Tap Question'));
    assert.ok(!sent[0].content.includes('In plain words'));
    assert.ok(!sent[0].content.includes('rm -rf'));
  });

  await test('model-switch card shows the reason in plain words', async () => {
    const { bridge, sent } = rig();
    bridge.observe({ type: 'start' });
    bridge.observe({ type: 'approval', id: 9, tool: 'request_model', summary: 'switch to Opus 5.5: the bug has no obvious cause', what: 'This is harder than Sonnet 5.5 can do well.', spoken: 'switch to Opus 5.5', risky: false });
    await sleep(100);
    assert.ok(sent[0].content.includes('**Wants to:** Switch to Opus 5.5'));
    assert.ok(sent[0].content.includes('**In plain words:** The bug has no obvious cause'));
  });

  await test('PC idle (walked away): DM at once', async () => {
    const { bridge, sent } = rig({ delayMs: 60000, idleSeconds: () => 300 });
    bridge.observe({ type: 'start' }); bridge.observe(approval());
    await sleep(30);
    assert.strictEqual(sent.length, 1);
  });

  await test('desktop answers after the DM went out: DM edited, buttons gone', async () => {
    const { bridge, sent } = rig();
    bridge.observe({ type: 'start' }); bridge.observe(approval());
    await sleep(100);
    bridge.observe({ type: 'approved', id: 7, yes: false, question: '' });
    await sleep(10);
    assert.strictEqual(sent[0].edits.length, 1);
    assert.deepStrictEqual(sent[0].edits[0].components, []);
    assert.ok(sent[0].edits[0].content.includes('Answered at the PC: no'));
  });

  await test('risky yes needs a second tap', async () => {
    const { bridge, sent, calls } = rig();
    bridge.observe({ type: 'start' }); bridge.observe(approval());
    await sleep(100);
    const t1 = tap('aos:7:yes'); await bridge.onInteraction(t1);
    assert.strictEqual(calls.length, 0, 'approved on first tap');
    assert.deepStrictEqual(t1.log[0][1].components[0].components.map((b) => b.label), ['Yes, do it', 'Cancel']);
    const t2 = tap('aos:7:yes2'); await bridge.onInteraction(t2);
    assert.deepStrictEqual(calls, [['approve', 7, true]]);
    assert.deepStrictEqual(t2.log[0][1].components, []);
    // the desktop's own 'approved' event afterwards must not edit the DM again
    bridge.observe({ type: 'approved', id: 7, yes: true, question: '' });
    await sleep(10);
    assert.strictEqual(sent[0].edits.length, 0);
  });

  await test('non-risky yes is one tap; no is one tap', async () => {
    const { bridge, calls } = rig();
    bridge.observe({ type: 'start' }); bridge.observe(approval({ id: 1, risky: false }));
    bridge.observe(approval({ id: 2, risky: false }));
    await sleep(100);
    await bridge.onInteraction(tap('aos:1:yes'));
    await bridge.onInteraction(tap('aos:2:no'));
    assert.deepStrictEqual(calls, [['approve', 1, true], ['approve', 2, false]]);
  });

  await test("someone else's tap is refused", async () => {
    const { bridge, calls } = rig();
    bridge.observe({ type: 'start' }); bridge.observe(approval({ risky: false }));
    await sleep(100);
    const t = tap('aos:7:yes', '999'); await bridge.onInteraction(t);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(t.log[0][0], 'reply');
  });

  await test('Question button opens a modal; submitting holds the action back with his question', async () => {
    const { bridge, calls } = rig();
    bridge.observe({ type: 'start' }); bridge.observe(approval());
    await sleep(100);
    const t = tap('aos:7:ask'); await bridge.onInteraction(t);
    assert.strictEqual(t.log[0][0], 'modal');
    const s = tap('aos:7:q'); s.fields = { getTextInputValue: () => 'why is it needed?' };
    await bridge.onInteraction(s);
    assert.deepStrictEqual(calls, [['approve', 7, false, 'why is it needed?']]);
  });

  await test('tapping a card that was already answered says so', async () => {
    const { bridge, calls } = rig();
    const t = tap('aos:99:yes'); await bridge.onInteraction(t);
    assert.strictEqual(calls.length, 0);
    assert.ok(t.log[0][1].content.includes('already answered'));
  });

  await test('stray custom ids are ignored', async () => {
    const { bridge, calls } = rig();
    const t = tap('something-else'); await bridge.onInteraction(t);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(t.log.length, 0);
  });

  const msg = (content, o = {}) => ({ content, author: { id: ME, bot: false }, guild: null, channel: { sendTyping: async () => {} }, reply: async () => {}, ...o });

  await test('a DM runs the assistant and the reply comes back by DM', async () => {
    const { bridge, sent, ran } = rig();
    await bridge.onMessage(msg('what is on today?'));
    await sleep(10);
    assert.deepStrictEqual(ran, ['what is on today?']);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].content, 'Right, done.');
  });

  await test('strangers, bots and server channels are ignored', async () => {
    const { bridge, ran } = rig();
    await bridge.onMessage(msg('hi', { author: { id: '999', bot: false } }));
    await bridge.onMessage(msg('hi', { author: { id: ME, bot: true } }));
    await bridge.onMessage(msg('hi', { guild: { id: 'g' } }));
    await bridge.onMessage(msg('   '));
    assert.strictEqual(ran.length, 0);
  });

  await test('"stop" stops instead of asking the assistant', async () => {
    const { bridge, calls, ran } = rig();
    await bridge.onMessage(msg('Stop'));
    assert.deepStrictEqual(calls, [['stop']]);
    assert.strictEqual(ran.length, 0);
  });

  await test('approval during a Discord chat is DMed at once, no delay', async () => {
    const { bridge, sent } = rig({ delayMs: 60000, run: async (t, sink) => { sink({ type: 'start' }); sink(approval({ risky: false })); } });
    await bridge.onMessage(msg('tidy my downloads'));
    await sleep(30);
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].components);
  });

  await test('after chatting in Discord, the next desktop approval skips the wait', async () => {
    const { bridge, sent } = rig({ delayMs: 60000 });
    await bridge.onMessage(msg('hello'));
    sent.length = 0;
    bridge.observe({ type: 'start' }, 'app'); bridge.observe(approval({ risky: false }));
    await sleep(30);
    assert.strictEqual(sent.length, 1);
  });

  await test('a desktop task sends ONLY the approval card: no progress notes, no "done", no errors', async () => {
    const a = rig();
    a.bridge.observe({ type: 'start' });
    a.bridge.observe({ type: 'text', text: 'Still building the flow view.' }); a.bridge.observe({ type: 'tool', name: 'Bash' });
    a.bridge.observe(approval({ risky: false }));
    await sleep(100);
    a.bridge.observe({ type: 'approved', id: 7, yes: true, question: '' });
    a.bridge.observe({ type: 'text', text: 'Still working: redoing the spacing.' }); a.bridge.observe({ type: 'tool', name: 'Edit' });
    a.bridge.observe({ type: 'text', text: 'All tidy.' });
    a.bridge.observe({ type: 'error', message: 'Plan limit reached for now.' }, 'app');
    a.bridge.observe({ type: 'done' });
    await sleep(20);
    assert.strictEqual(a.sent.length, 1, 'only the card should have been sent, got: ' + a.sent.map((m) => m.content.slice(0, 40)).join(' | '));
    assert.ok(a.sent[0].components);
  });

  await test('a DM chat gets only his final answer, not the commentary between steps', async () => {
    const { bridge, sent } = rig({
      run: async (t, sink) => {
        sink({ type: 'start' });
        sink({ type: 'text', text: 'Still building the flow view. ' }); sink({ type: 'tool', name: 'Bash' });
        sink({ type: 'text', text: 'Still working: redoing it. ' }); sink({ type: 'tool', name: 'Edit' });
        sink({ type: 'text', text: 'All done, boss. The skill is written.' }); sink({ type: 'done' });
      },
    });
    await bridge.onMessage(msg('build it'));
    await sleep(20);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].content, 'All done, boss. The skill is written.');
  });

  await test('after a tap on Question, only the assistant\'s answer to it comes back (sent when it tries again), nothing else', async () => {
    const { bridge, sent, calls } = rig();
    bridge.observe({ type: 'start' }); bridge.observe({ type: 'text', text: 'Working on it.' }); bridge.observe({ type: 'tool', name: 'Bash' });
    bridge.observe(approval({ risky: false }));
    await sleep(100);
    await bridge.onInteraction(tap('aos:7:ask'));
    const s = tap('aos:7:q'); s.fields = { getTextInputValue: () => 'why?' }; await bridge.onInteraction(s);
    assert.deepStrictEqual(calls, [['approve', 7, false, 'why?']]);
    bridge.observe({ type: 'approved', id: 7, yes: false, question: 'why?' });
    bridge.observe({ type: 'text', text: 'It clears the old build so the new one is clean.' });
    bridge.observe({ type: 'tool', name: 'Bash' }); // tries again
    bridge.observe(approval({ id: 8, risky: false }));
    bridge.observe({ type: 'text', text: 'Trying again.' });
    bridge.observe({ type: 'done' });
    await sleep(100);
    const texts = sent.map((m) => m.content);
    assert.ok(texts.some((t) => t === 'It clears the old build so the new one is clean.'), 'answer missing: ' + texts.join(' | '));
    assert.ok(!texts.some((t) => t.includes('Working on it') || t.includes('Trying again')), 'progress leaked');
  });

  await test('two chats at once: replies and Question answers stay with their own chat', async () => {
    const { bridge, sent, calls } = rig();
    bridge.observe({ type: 'start', chat: 'a' }, 'discord'); bridge.observe({ type: 'start', chat: 'b' }, 'app');
    bridge.observe({ type: 'text', chat: 'a', text: 'Answer for A.' }); bridge.observe({ type: 'text', chat: 'b', text: 'Chatter in B.' });
    bridge.observe({ type: 'done', chat: 'b' }); // B's done must not flush A's reply, nor send B's (a desktop chat)
    bridge.observe({ type: 'done', chat: 'a' });
    await sleep(20);
    assert.deepStrictEqual(sent.map((m) => m.content), ['Answer for A.']);
    sent.length = 0;
    // a Question tapped on B's card makes B's answer come back, not A's
    bridge.observe({ type: 'start', chat: 'a' }, 'app'); bridge.observe({ type: 'start', chat: 'b' }, 'app');
    bridge.observe(approval({ id: 21, chat: 'b', chatTitle: 'Tidy the downloads', risky: false }));
    await sleep(100);
    assert.ok(sent[0].content.includes('**Chat:** Tidy the downloads'), sent[0].content);
    const s = tap('aos:21:q'); s.fields = { getTextInputValue: () => 'why?' }; await bridge.onInteraction(s);
    assert.deepStrictEqual(calls, [['approve', 21, false, 'why?']]);
    sent.length = 0;
    bridge.observe({ type: 'text', chat: 'a', text: 'A chatter.' }); bridge.observe({ type: 'done', chat: 'a' });
    bridge.observe({ type: 'text', chat: 'b', text: 'Because it is old.' }); bridge.observe({ type: 'done', chat: 'b' });
    await sleep(20);
    assert.deepStrictEqual(sent.map((m) => m.content), ['Because it is old.']);
  });

  await test('a helper asking is marked as such on the card', async () => {
    const { bridge, sent } = rig();
    bridge.observe({ type: 'start' }); bridge.observe(approval({ helper: true }));
    await sleep(100);
    assert.ok(sent[0].content.includes('one of my helpers'));
  });

  await test('errors from a Discord chat come back by DM (e.g. busy)', async () => {
    const { bridge, sent } = rig({ run: async (t, sink) => sink({ type: 'error', message: 'Still working on the last request.' }) });
    await bridge.onMessage(msg('and another thing'));
    await sleep(10);
    assert.ok(sent[0].content.includes('Still working'));
  });

  await test('a failing DM send never throws or blocks answering', async () => {
    const calls = [];
    const client = { users: { fetch: async () => ({ send: async () => { throw new Error('Cannot send messages to this user'); } }) } };
    const bridge = createBridge({ client, userId: ME, delayMs: 10, approve: (...a) => calls.push(a), stop() {}, run: async () => {}, log: () => {} });
    bridge.observe({ type: 'start' }); bridge.observe(approval());
    await sleep(60);
    bridge.observe({ type: 'approved', id: 7, yes: true, question: '' }); // desktop still works
    assert.strictEqual(bridge.waiting.size, 0);
  });

  await test('long replies are split under 2000 characters', () => {
    const c = chunks(('word '.repeat(300) + '\n').repeat(5));
    assert.ok(c.length > 1 && c.every((x) => x.length <= 1900));
  });

  await test('config: reads .env, ignores blanks, keeps the delay default, never needs quotes', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-'));
    fs.writeFileSync(path.join(d, '.env'), 'DISCORD_BOT_TOKEN="abc.def"\nDISCORD_USER_ID=123\nDISCORD_DELAY_MIN=\n');
    const c = readConfig([d]);
    assert.strictEqual(c.token, 'abc.def'); assert.strictEqual(c.userId, '123'); assert.strictEqual(c.delayMs, 180000);
    fs.writeFileSync(path.join(d, '.env'), 'DISCORD_BOT_TOKEN=\nDISCORD_USER_ID=\nDISCORD_DELAY_MIN=0\n');
    const e = readConfig([d]);
    assert.strictEqual(e.token, ''); assert.strictEqual(e.delayMs, 0);
    fs.rmSync(d, { recursive: true, force: true });
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();

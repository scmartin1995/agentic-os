// Tests for electron/fresh.cjs (answers about the notes folder kept until it changes) and the folder watcher's pacing in vault.cjs.
// The risk in a cache is a stale answer after a change, so most of this is about every way the folder can change: the watcher,
// the app's own writes, a panel correction, and time. Throwaway folders only. Run: node tools/test-fresh.cjs
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The long form of the temp folder: Windows' folder watcher aborts the whole process when it is given an 8.3 short name
// (C:\Users\STERLI~1\...), which os.tmpdir() can return. The app's own vault path is always the long form.
const tmp = fs.realpathSync.native(os.tmpdir());
const VAULT = fs.mkdtempSync(path.join(tmp, 'aos-fresh-'));
process.env.AOS_VAULT = VAULT;
process.env.AOS_USERDATA = fs.mkdtempSync(path.join(tmp, 'aos-fresh-data-'));
const put = (rel, text) => { const p = path.join(VAULT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
put('projects/Alpha/README.md', '# Alpha\n');
put('projects/Alpha/Output/first.md', '# First\n');
const fresh = require('../electron/fresh.cjs');
const vault = require('../electron/vault.cjs');
const shared = require('../electron/shared.cjs');

const stamps = []; // when the folder watcher reported a change
let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('ok   ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n     ', String(e.message).split('\n').slice(0, 4).join('\n      ')); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await test('the work is done once; later asks get the same answer without redoing it', () => {
    fresh.drop(); let calls = 0;
    const a = fresh.get('x', () => { calls++; return { n: calls }; });
    const b = fresh.get('x', () => { calls++; return { n: calls }; });
    const c = fresh.get('x', () => { calls++; return { n: calls }; });
    assert.strictEqual(calls, 1); assert.strictEqual(a, b); assert.strictEqual(b, c);
  });

  await test('different names are kept apart', () => {
    fresh.drop(); assert.strictEqual(fresh.get('a', () => 1), 1); assert.strictEqual(fresh.get('b', () => 2), 2); assert.strictEqual(fresh.get('a', () => 99), 1);
  });

  await test('drop() makes the next ask do the work again', () => {
    fresh.drop(); let calls = 0; fresh.get('x', () => ++calls); fresh.drop(); fresh.get('x', () => ++calls);
    assert.strictEqual(calls, 2);
  });

  await test('an answer worked out while a change happens is not kept (it may already be out of date)', () => {
    fresh.drop(); let calls = 0;
    const v = fresh.get('x', () => { calls++; fresh.drop(); return 'worked out before the change landed'; });
    assert.strictEqual(v, 'worked out before the change landed');
    fresh.get('x', () => { calls++; return 'worked out after'; });
    assert.strictEqual(calls, 2, 'asked for again, not served from before the change');
  });

  await test('an answer older than 60 seconds is worked out again, even if no change was reported', () => {
    fresh.drop(); let calls = 0; fresh.get('x', () => ++calls);
    const real = Date.now; Date.now = () => real() + fresh.TTL_MS + 1;
    try { fresh.get('x', () => ++calls); } finally { Date.now = real; }
    assert.strictEqual(calls, 2);
  });

  await test('a throw while working it out is not kept, and the next ask tries again', () => {
    fresh.drop(); let calls = 0;
    assert.throws(() => fresh.get('x', () => { calls++; throw new Error('boom'); }), /boom/);
    assert.strictEqual(fresh.get('x', () => { calls++; return 'ok'; }), 'ok'); assert.strictEqual(calls, 2);
  });

  await test('the app writing a note itself drops what was kept (shared.markWritten)', () => {
    fresh.drop(); let calls = 0; fresh.get('projects', () => ++calls);
    shared.markWritten('projects/Alpha/Output/first.md');
    fresh.get('projects', () => ++calls);
    assert.strictEqual(calls, 2);
  });

  await test('a Projects-panel correction drops what was kept, and the projects list shows it straight away', () => {
    fresh.drop();
    const before = fresh.get('projects', () => vault.projects());
    const file = before[0].deliverables.concat(before[0].working).find((f) => /first\.md$/.test(f.path));
    fresh.get('tree', () => vault.tree());
    vault.setOverride('projects/Alpha/Output/first.md', 'evidence');
    let again = 0; fresh.get('projects', () => { again++; return vault.projects(); });
    assert.strictEqual(again, 1, 'worked out again after the correction');
    assert.ok(file !== undefined, 'the file was listed before');
    vault.clearOverrides('projects/Alpha');
  });

  await test('a note\'s title is read again when the note is edited (the Projects list keeps each header until the note changes)', () => {
    const f = put('projects/Alpha/Output/titled.md', '---\ntitle: First title\ndescription: first\n---\nbody\n');
    const find = () => { const p = vault.projects().find((x) => x.folder === 'Alpha'); return [...p.deliverables, ...p.working, ...p.sessionNotes, ...p.search].find((x) => /titled\.md$/.test(x.path)); };
    assert.strictEqual(find().title, 'First title');
    assert.strictEqual(find().title, 'First title', 'and again, from the kept header');
    fs.writeFileSync(f, '---\ntitle: Second title\ndescription: second\n---\nbody\n'); const t = new Date(Date.now() + 3000); fs.utimesSync(f, t, t);
    assert.strictEqual(find().title, 'Second title', 'the edit shows at once');
    fs.rmSync(f);
    assert.strictEqual(find(), undefined, 'and a deleted note is gone');
  });

  await test('the screen asks for the note count and gets the same number the link graph has', () => {
    assert.strictEqual(vault.listMarkdown().length, vault.graph().nodes.length);
  });

  await test('the folder watcher reports a change, and drops what was kept first', async () => {
    fresh.drop(); let reported = null;
    vault.watch((files) => { reported = files; stamps.push(Date.now()); });
    await wait(300);
    fresh.get('tree', () => 'old tree');
    put('projects/Alpha/Output/second.md', '# Second\n');
    for (let i = 0; i < 40 && !reported; i++) await wait(100);
    assert.ok(reported && reported.some((f) => /second\.md$/.test(f)), 'reported: ' + JSON.stringify(reported));
    assert.strictEqual(fresh.get('tree', () => 'new tree'), 'new tree', 'the kept tree was dropped by the change');
  });

  await test('a steady trickle of edits (one every 400 ms for 8 s) is reported along the way, not held back until it stops', async () => {
    await wait(1500); stamps.length = 0;
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) { put('projects/Alpha/Output/trickle.md', `# T${i}\n`); await wait(400); }
    await wait(1200);
    const at = stamps.map((x) => ((x - t0) / 1000).toFixed(1)).join(', ');
    assert.ok(stamps.length >= 2, `reported ${stamps.length} time(s): ${at}`);
    const first = (stamps[0] - t0) / 1000;
    assert.ok(first < 3.8, `the first report came after ${first.toFixed(1)} s; a watcher that waits for quiet would say nothing until about 8.6 s`);
    const gaps = stamps.slice(1).map((x, i) => (x - stamps[i]) / 1000);
    assert.ok(gaps.every((g) => g < 4.2), `gaps between reports: ${gaps.map((g) => g.toFixed(1)).join(', ')}`);
    console.log(`       reports at ${at} s`);
  });

  await test('one quiet edit is still reported quickly', async () => {
    await wait(1500); stamps.length = 0;
    const t0 = Date.now(); put('projects/Alpha/Output/quiet.md', '# Q\n');
    for (let i = 0; i < 30 && !stamps.length; i++) await wait(100);
    assert.strictEqual(stamps.length, 1);
    assert.ok(stamps[0] - t0 < 1500, `took ${stamps[0] - t0} ms`);
  });

  console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
  fs.rmSync(VAULT, { recursive: true, force: true }); fs.rmSync(process.env.AOS_USERDATA, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();

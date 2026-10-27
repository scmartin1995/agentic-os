// Tests that a search-index pass leaves unchanged notes alone. A pass used to open, hash and unzip every note (1-3 s of the app's
// one thread, after every mail check and on any search when the index was 5 minutes old); now a note whose size and modified
// time are as they were is not opened, and the index file is only rewritten when something in it is different.
// Throwaway vault and data folder; no AI call. Run: node tools/test-search-incremental.cjs
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-incr-'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-incr-data-'));
process.env.AOS_VAULT = VAULT;
process.env.AOS_USERDATA = DATA;
const put = (rel, text, mtime) => { const p = path.join(VAULT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); if (mtime) fs.utimesSync(p, mtime, mtime); return p; };
const zip = require('./zip-fixture.cjs');

for (let i = 0; i < 30; i++) put(`projects/A/notes/n${i}.md`, `# Note ${i}\nbody of note ${i} with word${i}\n`);
fs.writeFileSync(path.join(VAULT, 'projects/A/notes/book.xlsx'), zip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="S" sheetId="1"/></sheets></workbook>', 'xl/sharedStrings.xml': '<sst><si><t>Aardvark</t></si></sst>', 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>' }));

// count how many files a pass opens: wrap fs.openSync and fs.readFileSync for paths inside the vault
const realOpen = fs.openSync, realRead = fs.readFileSync;
let opened = [];
fs.openSync = function (p, ...a) { if (typeof p === 'string' && p.startsWith(VAULT)) opened.push(path.relative(VAULT, p).replace(/\\/g, '/')); return realOpen.call(this, p, ...a); };
fs.readFileSync = function (p, ...a) { if (typeof p === 'string' && p.startsWith(VAULT) && /\.(xlsx|docx|pptx)$/i.test(p)) opened.push(path.relative(VAULT, p).replace(/\\/g, '/')); return realRead.call(this, p, ...a); };
const search = require('../electron/search.cjs');
const indexFile = path.join(DATA, 'search-index.json');
// Once a note has a summary the ranking uses it instead of the note's opening text, so (like a real model) the stand-in writes
// a summary that mentions what the note is about: its title line and the first words of its text.
const fake = async ({ prompt }) => ({ cost: 0, out: { items: [...prompt.matchAll(/=== id: (.*)\ntitle: (.*)\n([^\n]*)\n?([^\n]*)/g)].map((m) => ({ id: m[1], summary: `Summary of ${m[1]}: ${m[2]} ${m[3]} ${m[4]}`, questions: ['q'], atoms: ['ATOM-1'] })) } });

let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('ok   ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n     ', String(e.message).split('\n').slice(0, 5).join('\n      ')); } };
const mine = () => opened.filter((p) => /^projects\//.test(p));

(async () => {
  await test('the first pass reads every note (there is nothing to reuse yet)', async () => {
    opened = []; await search.build({ dry: true });
    assert.ok(mine().length >= 31, `opened ${mine().length}`);
  });

  await test('a second pass with nothing changed opens none of the notes', async () => {
    opened = []; const r = await search.build({ dry: true });
    assert.strictEqual(mine().length, 0, 'opened: ' + mine().slice(0, 5).join(', '));
    assert.strictEqual(r.notes, 31);
  });

  await test('...and does not rewrite the index file, but still marks it as freshly checked', async () => {
    const before = fs.statSync(indexFile).mtimeMs;
    const builtBefore = JSON.parse(fs.readFileSync(indexFile, 'utf8')).built;
    await new Promise((r) => setTimeout(r, 30));
    await search.build({ dry: true });
    assert.strictEqual(fs.statSync(indexFile).mtimeMs, before, 'file untouched');
    await search.ensureFresh(); // a search right after must not start another pass
    assert.ok(search.status().built > builtBefore, 'built moved on in memory, so ensureFresh() has nothing to do');
  });

  await test('a note that changed is read again, and only that one', async () => {
    const p = path.join(VAULT, 'projects/A/notes/n7.md');
    fs.writeFileSync(p, '# Note 7\nnow talks about zeppelins\n');
    opened = []; await search.build({ dry: true });
    assert.deepStrictEqual(mine(), ['projects/A/notes/n7.md']);
    assert.ok(search.query('zeppelins', { limit: 3 }).some((x) => /n7\.md$/.test(x.path)), 'new text is searchable');
  });

  await test('a changed note is saved; the next pass is quiet again', async () => {
    opened = []; await search.build({ dry: true });
    assert.strictEqual(mine().length, 0);
  });

  await test('same text saved again (new time, same words) keeps its summary', async () => {
    search.reset();
    await search.build({ oneShot: fake });
    const p = path.join(VAULT, 'projects/A/notes/n3.md');
    const text = fs.readFileSync(p, 'utf8');
    fs.writeFileSync(p, text); const t = new Date(Date.now() + 5000); fs.utimesSync(p, t, t); // touched, not edited
    await search.build({ dry: true });
    const hit = search.query('word3', { limit: 3 }).find((x) => /n3\.md$/.test(x.path));
    assert.ok(hit && hit.enriched && /Summary of/.test(hit.summary), 'summary kept: ' + JSON.stringify(hit));
  });

  await test('a new note appears, a deleted one leaves', async () => {
    put('projects/A/notes/brandnew.md', '# Brand new\nflamingo content\n');
    fs.rmSync(path.join(VAULT, 'projects/A/notes/n1.md'));
    opened = []; await search.build({ dry: true });
    assert.deepStrictEqual(mine(), ['projects/A/notes/brandnew.md']);
    assert.ok(search.query('flamingo', { limit: 3 }).length >= 1);
    assert.ok(!Object.keys(JSON.parse(fs.readFileSync(indexFile, 'utf8')).entries).some((k) => /n1\.md$/.test(k)), 'gone from the saved index');
  });

  await test('an unchanged Excel file is not unzipped again', async () => {
    search.reset(); fs.rmSync(indexFile, { force: true });
    await search.build({ dry: true }); // heuristic entry: the workbook's text is searchable
    assert.ok(search.query('aardvark', { limit: 3 }).some((x) => /book\.xlsx$/.test(x.path)), 'found before');
    opened = []; await search.build({ dry: true });
    assert.ok(!mine().some((p) => /book\.xlsx$/.test(p)), 'not opened: ' + mine().join(', '));
    assert.ok(search.query('aardvark', { limit: 3 }).some((x) => /book\.xlsx$/.test(x.path)), 'still searchable from the kept entry');
  });

  await test('notes without a summary are read when the model is about to be asked, so it has their text', async () => {
    search.reset(); fs.rmSync(indexFile, { force: true });
    await search.build({ dry: true }); // heuristic entries, no summaries
    let sent = 0, sawText = true;
    const spy = async ({ prompt }) => { sent += (prompt.match(/=== id:/g) || []).length; if (/=== id: [^\n]*\n[^\n]*\n\s*(\n|=== id:|$)/.test(prompt)) sawText = false; return fake({ prompt }); };
    await search.build({ oneShot: spy });
    assert.ok(sent >= 30, `sent ${sent} notes to the model`);
    assert.ok(sawText, 'every note had its text in the prompt');
  });

  await test('a second build started while a long first one is going does not run alongside it', async () => {
    // (The guard is new in effect: the old build never paused, so nothing could start in the middle of it. A pass that is
    // short enough to finish without pausing is over before a second caller can arrive, so this needs a vault big enough to pause.)
    for (let i = 0; i < 300; i++) put(`projects/C/big/b${i}.md`, `# B${i}\n` + 'lorem ipsum '.repeat(300));
    search.reset(); fs.rmSync(indexFile, { force: true });
    const first = search.build({ dry: true });
    const second = await search.build({ dry: true });
    assert.ok(second.already, 'second caller was told a pass is already running: ' + JSON.stringify(second).slice(0, 100));
    const r = await first;
    assert.ok(r.notes >= 300, 'the first pass finished normally');
    const third = await search.build({ dry: true });
    assert.ok(!third.already, 'and a later one can start again');
  });

  await test('the pass gives the app the thread back while it works', async () => {
    for (let i = 0; i < 400; i++) put(`projects/B/many/m${i}.md`, `# M${i}\n` + 'lorem ipsum '.repeat(200));
    search.reset(); fs.rmSync(indexFile, { force: true });
    let ticks = 0; const timer = setInterval(() => ticks++, 1);
    await search.build({ dry: true });
    clearInterval(timer);
    assert.ok(ticks >= 3, `other work ran ${ticks} times during the pass`);
  });

  await test('a pass over 430 unchanged notes is quick', async () => {
    const t0 = process.hrtime.bigint(); await search.build({ dry: true }); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 250, `${ms.toFixed(0)} ms`);
    console.log(`       unchanged pass over ${Object.keys(JSON.parse(fs.readFileSync(indexFile, 'utf8')).entries).length} notes: ${ms.toFixed(0)} ms`);
  });

  await test('saved chats: an unchanged chat file is not read again, a changed one is, a new one is picked up, a deleted one leaves', async () => {
    const chats = path.join(DATA, 'chats'); fs.mkdirSync(chats, { recursive: true });
    const chat = (id, text) => fs.writeFileSync(path.join(chats, id + '.json'), JSON.stringify({ id, title: 'T ' + id, updated: Date.now(), items: [{ role: 'you', text }, { role: 'assistant', text: 'ok' }] }));
    for (let i = 0; i < 20; i++) chat('c' + i, `question about quokka${i}`);
    fs.writeFileSync(path.join(chats, 'empty.json'), JSON.stringify({ id: 'empty', items: [] }));
    fs.writeFileSync(path.join(chats, 'broken.json'), '{ not json');
    const reads = []; const realJson = require('../electron/store.cjs').readJson;
    const store = require('../electron/store.cjs'); store.readJson = (f, d) => { if (/chats/.test(f)) reads.push(path.basename(f)); return realJson(f, d); };
    search.reset(); fs.rmSync(indexFile, { force: true });
    await search.build({ dry: true });
    assert.ok(search.query('quokka3 question', { limit: 5 }).some((x) => x.kind === 'chat'), 'a chat is searchable');
    reads.length = 0; await search.build({ dry: true });
    assert.deepStrictEqual(reads, [], 'nothing re-read on a quiet pass (including the empty and broken ones): ' + reads.join(','));
    chat('c5', 'question about wombat'); const t = new Date(Date.now() + 5000); fs.utimesSync(path.join(chats, 'c5.json'), t, t);
    chat('c99', 'a brand new question about platypus');
    reads.length = 0; await search.build({ dry: true });
    assert.deepStrictEqual(reads.sort(), ['c5.json', 'c99.json'], 'only the changed and the new one: ' + reads.join(','));
    assert.ok(search.query('wombat question', { limit: 5 }).some((x) => x.kind === 'chat'), 'changed chat is searchable');
    assert.ok(search.query('platypus question', { limit: 5 }).some((x) => x.kind === 'chat'), 'new chat is searchable');
    const saved = JSON.parse(fs.readFileSync(indexFile, 'utf8')).entries['chat:c5'];
    assert.ok(saved && /wombat/.test(saved.lead) && !/quokka5/.test(saved.lead), 'the changed chat is stored with its new text only: ' + (saved && saved.lead));
    assert.ok(!search.query('quokka5 question', { limit: 5 }).some((x) => x.path === 'chat:c5'), 'and no longer found by its old text');
    fs.rmSync(path.join(chats, 'c7.json'));
    await search.build({ dry: true });
    assert.ok(!('chat:c7' in JSON.parse(fs.readFileSync(indexFile, 'utf8')).entries), 'deleted chat leaves the index');
    assert.ok(!search.query('quokka7 question', { limit: 5 }).some((x) => x.path === 'chat:c7'), 'and is no longer found');
    store.readJson = realJson;
  });

  await test('a kept chat without a summary is read when the model is about to be asked, so it has its text', async () => {
    search.reset(); fs.rmSync(indexFile, { force: true });
    await search.build({ dry: true });
    let blank = 0, sent = 0;
    const spy = async ({ prompt }) => { for (const m of prompt.matchAll(/=== id: (chat:\S+)\ntitle: [^\n]*\n([^\n]*)/g)) { sent++; if (!m[2].trim()) blank++; } return fake({ prompt }); };
    await search.build({ oneShot: spy });
    assert.ok(sent >= 15, 'chats were sent: ' + sent);
    assert.strictEqual(blank, 0, blank + ' chats went to the model with no text');
  });

  await test('an index saved by the previous version (no signatures) still works, and is upgraded by one pass', async () => {
    const j = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    for (const e of Object.values(j.entries)) delete e.sig;
    fs.writeFileSync(indexFile, JSON.stringify(j)); search.reset();
    opened = []; await search.build({ dry: true });
    assert.ok(mine().length > 400, 'read everything once');
    opened = []; await search.build({ dry: true });
    assert.strictEqual(mine().length, 0, 'and then nothing');
    const again = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    assert.ok(Object.values(again.entries).filter((e) => e.kind === 'note').every((e) => /^1:/.test(e.sig)), 'signatures written');
  });

  console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
  fs.openSync = realOpen; fs.readFileSync = realRead;
  fs.rmSync(VAULT, { recursive: true, force: true }); fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();

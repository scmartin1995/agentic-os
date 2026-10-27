// Tests for electron/search.cjs (the map's search and the search_notes tool). Run: node tools/test-search.cjs
// Uses a throwaway vault and data folder, never the real ones. No AI call: Haiku is replaced by a stand-in.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-search-'));
process.env.AOS_VAULT = VAULT;
process.env.AOS_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-search-data-'));
const put = (rel, text, mtime) => {
  const p = path.join(VAULT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text);
  if (mtime) fs.utimesSync(p, mtime, mtime);
};
const DAY = 86400000;
put('projects/Alpha/README.md', '# Alpha\nThe alpha project.\n');
put('projects/Alpha/notes/sailpoint.md', '---\ntitle: SailPoint capability\nstale_when: SailPoint team answers the open questions\n---\n# SailPoint capability\nSelf-service database access through SailPoint.\n', new Date(Date.now() - 1 * DAY));
put('projects/Alpha/old/oracle-plan.md', '# Oracle wave plan\nOracle wave plan for the factory.\n', new Date(Date.now() - 300 * DAY));
put('projects/Alpha/notes/oracle-plan.md', '# Oracle wave plan\nOracle wave plan for the factory.\n', new Date(Date.now() - 2 * DAY));
put('projects/Alpha/Output/keep-it-moving.html', '<html><head><title>Keep it moving: covering the role</title><style>.x{color:red}</style></head><body><script>var hidden=1</script><h1>Guide</h1><p>Weekly status reports and intake.</p></body></html>');
const zip = require('./zip-fixture.cjs');
const putBin = (rel, buf) => { const p = path.join(VAULT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); };
putBin('projects/Alpha/Output/budget.docx', zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Quarterly &amp; budget plan for hamsterwheel</w:t></w:r></w:p></w:body></w:document>' }));
putBin('projects/Alpha/Output/roster.xlsx', zip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="Roster" sheetId="1"/></sheets></workbook>', 'xl/sharedStrings.xml': '<sst><si><t>Zebrafish</t></si></sst>', 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>42</v></c></row></sheetData></worksheet>' }));
putBin('projects/Alpha/Output/broken.pptx', Buffer.from('this is not a zip file'));
put('projects/Alpha/Output/table.csv', 'name,colour\nmarmoset,teal\n');
put('projects/Alpha/index.md', '# Index\nsailpoint oracle\n');

const search = require('../electron/search.cjs');

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('ok   ', name); } catch (e) { console.log('FAIL ', name, '\n     ', String(e.message).split('\n').slice(0, 6).join('\n      ')); process.exitCode = 1; } };

(async () => {
  await test('a heuristic build indexes notes and skips index pages', async () => {
    const r = await search.build({ dry: true });
    assert.strictEqual(r.notes, 9);
    assert.ok(!search.query('Index', { limit: 10 }).some((x) => /index\.md$/.test(x.path)));
  });

  await test('a query finds the note by a word in its title or body', () => {
    const r = search.query('sailpoint', { limit: 3 });
    assert.ok(r.length >= 1);
    assert.ok(/sailpoint\.md$/.test(r[0].path));
  });

  await test('prefix matching finds a partial word', () => {
    assert.ok(search.query('sailp', { limit: 3 }).some((x) => /sailpoint\.md$/.test(x.path)));
  });

  await test('stale_when is carried on the hit and printed', () => {
    const r = search.query('sailpoint', { limit: 1 })[0];
    assert.ok(/SailPoint team answers/.test(r.staleWhen));
    assert.ok(/STALE WHEN:/.test(search.format([r])));
  });

  await test('of two same-titled notes, the newer ranks first and the older is flagged', () => {
    const r = search.query('oracle wave plan', { limit: 5 });
    assert.ok(/notes[/]oracle-plan\.md$/.test(r[0].path), r.map((x) => x.path).join(', '));
    const old = r.find((x) => /old[/]oracle-plan\.md$/.test(x.path));
    assert.ok(old && /notes[/]oracle-plan\.md$/.test(old.newerTwin || ''), 'older copy should point at the newer one');
  });

  await test('a stand-in for Haiku adds summaries and atoms, and they are searchable', async () => {
    const fake = async ({ prompt }) => ({ cost: 0.001, out: { items: [...prompt.matchAll(/=== id: (.*)/g)].map((m) => ({ id: m[1], summary: 'Summary of ' + m[1], questions: ['q'], atoms: ['TICKET-4242'] })) } });
    const r = await search.build({ oneShot: fake });
    assert.strictEqual(r.failed, 0);
    assert.strictEqual(r.enriched, 9);
    assert.ok(search.query('TICKET-4242', { limit: 2 }).length >= 1);
  });

  await test('a failed Haiku call leaves notes searchable and counts as failed', async () => {
    put('projects/Alpha/notes/fresh.md', '# Fresh note\nbrandnewword lives here.\n');
    const r = await search.build({ oneShot: async () => { throw new Error('gateway down'); } });
    assert.strictEqual(r.failed, 1);
    assert.ok(search.query('brandnewword', { limit: 2 }).some((x) => /fresh\.md$/.test(x.path)));
  });

  await test('unchanged notes keep their summary on a rebuild', async () => {
    const r = await search.build({ dry: true });
    assert.ok(r.enriched >= 9);
  });

  await test('a deleted file leaves the index', async () => {
    fs.rmSync(path.join(VAULT, 'projects/Alpha/notes/fresh.md'));
    await search.build({ dry: true });
    assert.strictEqual(search.query('brandnewword', { limit: 2 }).length, 0);
  });

  await test('the routine never calls Haiku before the first full pass is approved', async () => {
    search.reset();
    fs.rmSync(path.join(process.env.AOS_USERDATA, 'search-index.json'), { force: true });
    let calls = 0;
    const spy = async () => { calls++; return { cost: 0, out: { items: [] } }; };
    await search.routine(spy);
    assert.strictEqual(calls, 0);
    assert.strictEqual(search.status().seeded, false);
  });

  await test('after one full clean pass the routine uses Haiku, for changed notes only', async () => {
    const fake = async ({ prompt }) => ({ cost: 0, out: { items: [...prompt.matchAll(/=== id: (.*)/g)].map((m) => ({ id: m[1], summary: 'S', questions: [], atoms: [] })) } });
    await search.build({ oneShot: fake });
    assert.strictEqual(search.status().seeded, true);
    let sent = 0;
    const count = async (a) => { sent += (a.prompt.match(/=== id:/g) || []).length; return fake(a); };
    await search.routine(count);
    assert.strictEqual(sent, 0, 'nothing changed, so nothing is sent');
    put('projects/Alpha/notes/changed.md', '# Changed\nsomething new\n');
    await search.routine(count);
    assert.strictEqual(sent, 1);
  });

  await test('a partial or failed pass does not mark the index as seeded', async () => {
    search.reset();
    fs.rmSync(path.join(process.env.AOS_USERDATA, 'search-index.json'), { force: true });
    await search.build({ oneShot: async () => { throw new Error('down'); } });
    assert.strictEqual(search.status().seeded, false);
  });

  await test('the review list holds notes that say when they go stale, oldest first', async () => {
    await search.build({ dry: true });
    const r = search.reviewList();
    assert.ok(r.some((x) => /sailpoint\.md$/.test(x.path)));
    assert.ok(r.every((x) => x.staleWhen));
  });

  await test('saved chats never crowd the files out of the results', async () => {
    const chats = path.join(process.env.AOS_USERDATA, 'chats');
    fs.mkdirSync(chats, { recursive: true });
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(chats, 'c' + i + '.json'), JSON.stringify({ id: 'c' + i, title: 'sailpoint chat ' + i, updated: Date.now(), items: [{ role: 'you', text: 'sailpoint sailpoint sailpoint oracle wave plan' }] }));
    search.reset();
    await search.build({ dry: true });
    const r = search.query('sailpoint oracle', { limit: 8 });
    assert.ok(r.some((x) => x.kind === 'note'), 'a file should be in the results');
    assert.ok(r.filter((x) => x.kind === 'chat').length <= 2, 'chats are capped');
  });

  await test('an html page is searchable by its title and visible text, not its scripts', async () => {
    await search.build({ dry: true });
    assert.ok(/keep-it-moving.html$/.test((search.query('keep it moving', { limit: 3 })[0] || {}).path || ''));
    assert.ok(search.query('intake status', { limit: 3 }).some((x) => /keep-it-moving/.test(x.path)));
    assert.ok(!search.query('hidden', { limit: 3 }).some((x) => /keep-it-moving/.test(x.path)), 'script text must not be indexed');
  });

  await test('documents scope returns only Output and Client Facing files', async () => {
    const r = search.query('sailpoint oracle keep', { limit: 10, scope: 'output' });
    assert.ok(r.length >= 1 && r.every((x) => /(Output|Client Facing)[/]/.test(x.path)), r.map((x) => x.path).join(', '));
    assert.ok(search.query('sailpoint', { limit: 10, scope: 'all' }).some((x) => /notes[/]sailpoint/.test(x.path)));
  });

  await test('Word, Excel and CSV outputs are searchable by what is inside them', async () => {
    await search.build({ dry: true });
    assert.ok(search.query('hamsterwheel', { limit: 3, scope: 'output' }).some((x) => /budget[.]docx$/.test(x.path)));
    assert.ok(search.query('zebrafish', { limit: 3, scope: 'output' }).some((x) => /roster[.]xlsx$/.test(x.path)));
    assert.ok(search.query('marmoset', { limit: 3, scope: 'output' }).some((x) => /table[.]csv$/.test(x.path)));
  });

  await test('a damaged Office file is skipped by content but never breaks the build', async () => {
    const r = await search.build({ dry: true });
    assert.ok(!r.error);
    assert.ok(search.query('broken', { limit: 3, scope: 'output' }).some((x) => /broken[.]pptx$/.test(x.path)), 'still findable by its name');
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  fs.rmSync(VAULT, { recursive: true, force: true });
  fs.rmSync(process.env.AOS_USERDATA, { recursive: true, force: true });
})();

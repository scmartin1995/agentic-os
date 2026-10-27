// Tests for electron/discover.cjs and electron/okf.cjs. Run: node tools/test-okf.cjs
// Uses throwaway folders, never a real notes folder.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const discover = require('../electron/discover.cjs');
const okf = require('../electron/okf.cjs');
const STARTER = path.join(__dirname, '..', 'starter');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aos-okf-'));
const put = (root, rel, text = '') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const hash = (root, rel) => crypto.createHash('sha1').update(fs.readFileSync(path.join(root, rel))).digest('hex');
const HDR = (t) => `---\ntype: Note\ntitle: ${t}\ndescription: d\ntags: [a]\ntimestamp: 2026-01-01T00:00:00Z\n---\n# ${t}\n`;

function messy() {
  const r = tmp();
  put(r, 'Clients/Acme/kickoff.md', '# Kickoff call\n\nWe agreed the launch date is the 14th and the budget is fixed.\n');
  put(r, 'Clients/Acme/notes.md', HDR('Acme notes'));
  put(r, 'Clients/Beta/brief.md', '# Beta brief: phase one\n\nScope for phase one of the Beta work.\n');
  put(r, 'Clients/Beta/budget.xlsx', 'not really');
  put(r, 'Clients/Beta/contract.pdf', 'not really');
  put(r, 'Personal/todo.md', '- buy milk\n');
  put(r, 'Personal/passwords.txt', 'hunter2');
  put(r, 'readme-first.md', '# Hello\n');
  put(r, '.obsidian/app.json', '{}');
  put(r, 'node_modules/pkg/index.md', '# should be skipped\n');
  return r;
}

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('ok   ', name); } catch (e) { console.log('FAIL ', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); process.exitCode = 1; } };

test('discover counts files and kinds, skips junk folders, spots Obsidian', () => {
  const r = messy();
  const d = discover.scan(r);
  assert.strictEqual(d.exists, true);
  assert.strictEqual(d.kinds.notes, 5);
  assert.strictEqual(d.kinds.office, 1);
  assert.strictEqual(d.kinds.pdf, 1);
  assert.strictEqual(d.obsidian, true);
  assert.ok(!d.topFolders.some((f) => f.name === 'node_modules'));
  assert.strictEqual(d.topFolders[0].name, 'Clients');
});

test('discover reads headers and index pages, and gives a plain verdict', () => {
  const r = messy();
  const d = discover.scan(r);
  assert.strictEqual(d.notes.withHeader, 1);
  assert.strictEqual(d.structure.foldersWithIndex, 0);
  assert.strictEqual(d.verdict, 'loose');
  assert.strictEqual(discover.scan(tmp()).verdict, 'empty');
});

test('discover flags names that look like passwords or keys, without opening them', () => {
  const d = discover.scan(messy());
  assert.deepStrictEqual(d.secrets, ['Personal/passwords.txt']);
});

test('discover on a missing folder says so and does not throw', () => {
  const d = discover.scan(path.join(os.tmpdir(), 'aos-no-such-folder-xyz'));
  assert.strictEqual(d.exists, false);
});

test('leave: adds only Agentic OS\'s own files, and no existing file changes', () => {
  const r = messy();
  const before = { a: hash(r, 'Clients/Acme/kickoff.md'), b: hash(r, 'readme-first.md') };
  const res = okf.apply(r, 'leave', { starterDir: STARTER });
  assert.strictEqual(res.indexes, 0);
  assert.ok(exists(r, 'skills/lessons-review/SKILL.md'));
  assert.ok(exists(r, '.claude-plugin/plugin.json'));
  assert.ok(exists(r, 'agent-os/README.md'));
  assert.ok(!exists(r, 'index.md') && !exists(r, 'log.md') && !exists(r, 'Clients/index.md'));
  assert.strictEqual(hash(r, 'Clients/Acme/kickoff.md'), before.a);
  assert.strictEqual(hash(r, 'readme-first.md'), before.b);
  assert.match(read(r, 'agent-os/README.md'), /leave existing notes exactly as they are/);
});

test('index: adds an index page to every folder with notes, plus log.md, and never edits what exists', () => {
  const r = messy();
  put(r, 'Personal/index.md', '# My own index\n');
  const own = hash(r, 'Personal/index.md');
  const res = okf.apply(r, 'index', { starterDir: STARTER });
  assert.ok(res.indexes >= 3);
  assert.strictEqual(hash(r, 'Personal/index.md'), own, 'an existing index is not touched');
  const acme = read(r, 'Clients/Acme/index.md');
  assert.match(acme, /^---\ntype: Index\n/);
  assert.match(acme, /\[Kickoff call\]\(kickoff\.md\) - We agreed the launch date/);
  assert.match(acme, /\[Acme notes\]\(notes\.md\)/);
  const root = read(r, 'index.md');
  assert.match(root, /\[Clients\]\(Clients\/index\.md\)/);
  assert.match(root, /\[Hello\]\(readme-first\.md\)/);
  assert.ok(!exists(r, 'node_modules/pkg/index.md') || read(r, 'node_modules/pkg/index.md') === '# should be skipped\n');
  assert.ok(!exists(r, '.obsidian/index.md'));
  assert.ok(exists(r, 'log.md'));
});

test('index: the skills and rules folders Agentic OS adds are not given index pages of their own', () => {
  const r = messy();
  okf.apply(r, 'index', { starterDir: STARTER });
  assert.ok(!exists(r, 'skills/learn/index.md') && !exists(r, 'skills/model-selection/references/index.md') && !exists(r, 'agent-os/index.md'));
  assert.ok(exists(r, 'skills/index.md'));
  assert.doesNotMatch(read(r, 'index.md'), /agent-os|skills\/learn/);
});

test('index: running it twice adds nothing the second time', () => {
  const r = messy();
  okf.apply(r, 'index', { starterDir: STARTER });
  const again = okf.apply(r, 'index', { starterDir: STARTER });
  assert.strictEqual(again.indexes, 0);
  assert.strictEqual(again.made.length, 0);
});

test('an existing plugin manifest with another name is left alone and reported', () => {
  const r = tmp();
  put(r, '.claude-plugin/plugin.json', '{"name":"someone-else"}');
  const res = okf.apply(r, 'leave', { starterDir: STARTER });
  assert.strictEqual(res.manifest, 'other');
  assert.strictEqual(read(r, '.claude-plugin/plugin.json'), '{"name":"someone-else"}');
});

test('an existing agent-os/README.md and skills folder are kept', () => {
  const r = tmp();
  put(r, 'agent-os/README.md', 'mine');
  put(r, 'skills/index.md', 'my skills');
  put(r, 'skills/learn/SKILL.md', 'my learn');
  okf.apply(r, 'index', { starterDir: STARTER });
  assert.strictEqual(read(r, 'agent-os/README.md'), 'mine');
  assert.strictEqual(read(r, 'skills/index.md'), 'my skills');
  assert.strictEqual(read(r, 'skills/learn/SKILL.md'), 'my learn');
  assert.ok(exists(r, 'skills/model-selection/SKILL.md'));
});

test('titles with a colon are written as safe YAML', () => {
  const r = messy();
  okf.apply(r, 'index', { starterDir: STARTER });
  const fm = read(r, 'Clients/Beta/index.md');
  assert.match(fm, /\[Beta brief: phase one\]\(brief\.md\)/); // the link text is fine; frontmatter titles use the folder name
});

function readyVault(mode = 'index') {
  const r = messy();
  okf.apply(r, mode, { starterDir: STARTER });
  return r;
}

test('self-correct: a new note gets a header, an index line and a log line', () => {
  const r = readyVault();
  put(r, 'Clients/Acme/risks.md', '# Risks: launch week\n\nThe main risk is the supplier slipping a week.\n');
  const backed = [], wrote = [];
  const out = okf.selfCorrect(r, 'index', ['Clients/Acme/risks.md'], { backup: (a) => backed.push(path.basename(a)), onWrite: (x) => wrote.push(x) });
  assert.deepStrictEqual(out, { headers: 1, linked: 1, indexes: 0, logged: 1 });
  const note = read(r, 'Clients/Acme/risks.md');
  assert.match(note, /^---\ntype: Note\ntitle: "Risks: launch week"\n/);
  assert.match(note, /\n# Risks: launch week\n/);
  assert.match(read(r, 'Clients/Acme/index.md'), /\[Risks: launch week\]\(risks\.md\) - The main risk is the supplier slipping a week\./);
  assert.match(read(r, 'log.md'), /## \d{4}-\d{2}-\d{2}\n\n- `Clients\/Acme\/risks\.md` was added by Agentic OS\./);
  assert.ok(backed.includes('index.md') && backed.includes('log.md'), 'both edited files were backed up first');
  assert.ok(wrote.includes('log.md'));
});

test('self-correct: running again changes nothing (no duplicate link)', () => {
  const r = readyVault();
  put(r, 'Clients/Acme/risks.md', '# Risks\n\nThe supplier may slip by a week.\n');
  okf.selfCorrect(r, 'index', ['Clients/Acme/risks.md']);
  const idx = read(r, 'Clients/Acme/index.md');
  const out = okf.selfCorrect(r, 'index', ['Clients/Acme/risks.md']);
  assert.strictEqual(out.headers, 0);
  assert.strictEqual(out.linked, 0);
  assert.strictEqual(read(r, 'Clients/Acme/index.md'), idx);
});

test('self-correct: a note that already has a header keeps its own text', () => {
  const r = readyVault();
  put(r, 'Clients/Acme/mine.md', HDR('Mine') + '\nBody.\n');
  const before = read(r, 'Clients/Acme/mine.md');
  okf.selfCorrect(r, 'index', ['Clients/Acme/mine.md']);
  assert.strictEqual(read(r, 'Clients/Acme/mine.md'), before);
});

test('self-correct: a note in a folder with no index gets one', () => {
  const r = readyVault();
  put(r, 'Ideas/first.md', '# First idea\n\nSomething worth trying out soon.\n');
  const out = okf.selfCorrect(r, 'index', ['Ideas/first.md']);
  assert.strictEqual(out.indexes, 1);
  assert.match(read(r, 'Ideas/index.md'), /\[First idea\]\(first\.md\)/);
});

test('self-correct does nothing in "leave" mode, or for index and log pages', () => {
  const r = readyVault('leave');
  put(r, 'Clients/Acme/risks.md', '# Risks\n\nThe supplier may slip by a week.\n');
  const note = read(r, 'Clients/Acme/risks.md');
  assert.deepStrictEqual(okf.selfCorrect(r, 'leave', ['Clients/Acme/risks.md']), { headers: 0, linked: 0, indexes: 0, logged: 0 });
  assert.strictEqual(read(r, 'Clients/Acme/risks.md'), note);
  const r2 = readyVault();
  assert.strictEqual(okf.selfCorrect(r2, 'index', ['index.md', 'log.md', '../escape.md']).logged, 0);
});

test('log.md gets today\'s heading on top, and a second entry the same day goes under the same heading', () => {
  const r = readyVault();
  put(r, 'Clients/Acme/a.md', '# A\n\nA note about the first thing.\n');
  put(r, 'Clients/Acme/b.md', '# B\n\nA note about the second thing.\n');
  okf.selfCorrect(r, 'index', ['Clients/Acme/a.md']);
  okf.selfCorrect(r, 'index', ['Clients/Acme/b.md']);
  const log = read(r, 'log.md');
  assert.strictEqual((log.match(/^## \d{4}-\d{2}-\d{2}$/gm) || []).length, 1);
  assert.match(log, /b\.md` was added by Agentic OS\.\n\n- `Clients\/Acme\/a\.md`/);
});

test('prompt text differs by choice and always says what is allowed', () => {
  assert.match(okf.promptText('leave'), /exactly as they are/);
  assert.match(okf.promptText('index'), /Do not change the shape of existing notes/);
  assert.match(okf.promptText('tidy'), /wait for a yes/);
  assert.match(okf.promptText('nonsense'), /exactly as they are/);
});

// ---- the scan on a background thread, with a hard limit ----
const atest = async (name, fn) => { try { await fn(); passed++; console.log('ok   ', name); } catch (e) { console.log('FAIL ', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); process.exitCode = 1; } };
(async () => {
  await atest('scanAsync gives the same answer as scan, from a background thread', async () => {
    const r = messy();
    const a = await discover.scanAsync(r);
    const s = discover.scan(r);
    assert.strictEqual(a.partial, undefined);
    assert.strictEqual(a.files, s.files);
    assert.deepStrictEqual(a.kinds, s.kinds);
    assert.deepStrictEqual(a.secrets, s.secrets);
    assert.strictEqual(a.notes.withHeader, s.notes.withHeader);
  });
  await atest('scanAsync on a missing folder says so and still finishes', async () => {
    const a = await discover.scanAsync(path.join(os.tmpdir(), 'aos-no-such-folder-xyz'));
    assert.strictEqual(a.exists, false);
  });
  await atest('scanAsync is cut off at its limit: the answer comes back at once, flagged slow and partial, with no percentages invented', async () => {
    const big = tmp();
    for (let i = 0; i < 4000; i++) put(big, 'Area' + (i % 40) + '/note-' + i + '.md', '# n\n');
    const t0 = Date.now();
    const a = await discover.scanAsync(big, 1); // a 1 ms limit: the thread cannot even have started
    assert.ok(Date.now() - t0 < 2000, 'came back late: ' + (Date.now() - t0) + ' ms');
    assert.strictEqual(a.exists, true);
    assert.strictEqual(a.slow, true);
    assert.strictEqual(a.partial, true);
    assert.strictEqual(a.truncated, true);
  });
  await atest('the scan only reads the start of a limited number of notes, however many there are', async () => {
    const big = tmp();
    for (let i = 0; i < 900; i++) put(big, 'A/n' + i + '.md', '---\ntitle: x\n---\n');
    const a = await discover.scanAsync(big);
    assert.strictEqual(a.notes.count, 900);
    assert.strictEqual(a.notes.sampled, 600);
    assert.strictEqual(a.headerCoverage, 100);
  });
  await atest('a cloud-synced folder (OneDrive, Dropbox...) has no note opened: names, sizes and index pages only', async () => {
    const base = tmp();
    const cloud = path.join(base, 'OneDrive - Test Co', 'Notes');
    put(cloud, 'A/one.md', '---\ntitle: x\n---\n');
    put(cloud, 'A/two.md', '# two\n');
    put(cloud, 'A/index.md', '# A\n');
    const a = await discover.scanAsync(cloud);
    assert.strictEqual(a.headersSkipped, true);
    assert.strictEqual(a.notes.sampled, 0);
    assert.strictEqual(a.notes.count, 3);
    assert.strictEqual(a.structure.foldersWithIndex, 1);
    assert.strictEqual(a.verdict, 'structured');
    const plain = await discover.scanAsync(messy());
    assert.strictEqual(plain.headersSkipped, undefined);
    for (const p of ['C:\\Users\\x\\OneDrive - Contoso\\Desktop\\notes', 'C:\\Users\\x\\Dropbox\\notes', '/Users/x/Library/CloudStorage/GoogleDrive-a@b.com/My Drive', '/Users/x/Library/Mobile Documents/iCloud Drive/notes']) assert.ok(discover.isCloudPath(p), p);
    assert.ok(!discover.isCloudPath('C:\\Users\\x\\Documents\\Notes'));
  });
  console.log('\n' + passed + ' passed');
})();


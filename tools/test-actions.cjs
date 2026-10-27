// Tests for electron/actions.cjs (the Notes and Action items panels). Run: node tools/test-actions.cjs
// Uses a throwaway vault, never the real one.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-actions-'));
process.env.AOS_VAULT = VAULT;
process.env.AOS_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-actions-data-'));
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true }); fs.writeFileSync(path.join(VAULT, rel), text); };
put('projects/Alpha/README.md', '# Alpha\n');
put('projects/Beta_Two/README.md', '# Beta\n');
put('projects/Client/README.md', '# Client\n');
put('projects/Client/input/README.md', '---\ntype: Reference\nreceived: true\n---\n# From the client\n');
put('agent-os/inbox/index.md', '# Inbox\n');

const A = require('../electron/actions.cjs');
const shared = require('../electron/shared.cjs');
const read = (rel) => fs.readFileSync(path.join(VAULT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(VAULT, rel));
const T = (d, h, m) => new Date(2026, 9, d, h, m); // October 2026

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('ok   ', name); } catch (e) { console.log('FAIL ', name, '\n     ', String(e.message).split('\n').slice(0, 6).join('\n      '), '\n     ', (e.stack.split('\n').find((l) => l.includes('test-actions.cjs:')) || '').trim()); process.exitCode = 1; } };

test('ISO weeks, including the year edges', () => {
  assert.strictEqual(A.isoWeek(new Date(2026, 9, 8)), '2026-W41');
  assert.strictEqual(A.isoWeek(new Date(2026, 9, 5)), '2026-W41'); // Monday
  assert.strictEqual(A.isoWeek(new Date(2026, 9, 4)), '2026-W40'); // Sunday before
  assert.strictEqual(A.isoWeek(new Date(2026, 0, 1)), '2026-W01');
  assert.strictEqual(A.isoWeek(new Date(2027, 0, 1)), '2026-W53');
  assert.strictEqual(A.isoWeek(new Date(2024, 11, 30)), '2025-W01');
});

test('the "action item" prefix: any capitals, colon, dash or space; nothing else', () => {
  assert.strictEqual(A.actionText('action item: call the dealer'), 'call the dealer');
  assert.strictEqual(A.actionText('  Action Item - call the dealer'), 'call the dealer');
  assert.strictEqual(A.actionText('ACTION ITEM call\nthe dealer'), 'call the dealer');
  assert.strictEqual(A.actionText('action item — call'), 'call');
  assert.strictEqual(A.actionText('action items: call'), null);
  assert.strictEqual(A.actionText('action: call'), null);
  assert.strictEqual(A.actionText('call the dealer, action item'), null);
  assert.strictEqual(A.actionText('action item:'), '');
});

test('a plain note makes a weekly file with frontmatter, a day heading and a time heading', () => {
  const r = A.addNote('Alpha', 'First thought.', T(8, 9, 5));
  assert.strictEqual(r.file, 'projects/Alpha/input/notes/2026-W41.md');
  assert.strictEqual(r.action, null);
  const t = read(r.file);
  assert.match(t, /^---\ntype: Notes\ntitle: Notes - Alpha, week 2026-W41\n/);
  assert.match(t, /tags: \[source, planning\]/);
  assert.match(t, /## Thu 2026-10-08\n\n### 09:05\nFirst thought\.\n$/);
  assert.ok(!exists('projects/Alpha/action-items.md'));
  assert.ok(shared.wroteRecently(r.file), 'marked as written by the app');
});

test('an action item note is kept whole in the note and copied (without the prefix) to Open', () => {
  const r = A.addNote('Alpha', 'Action item: call the dealer, waiting on Sam', T(8, 10, 42));
  assert.match(read(r.file), /### 10:42 · action item\nAction item: call the dealer, waiting on Sam\n$/);
  assert.strictEqual((read(r.file).match(/## Thu 2026-10-08/g) || []).length, 1, 'same day: one day heading');
  const f = read('projects/Alpha/action-items.md');
  assert.match(f, /^---\ntype: Task\n/);
  assert.match(f, /## Open\n\n- \[ \] call the dealer, waiting on Sam \| added 2026-10-08 10:42 · \[note\]\(input\/notes\/2026-W41\.md\)\n\n## Closed\n/);
  assert.strictEqual(r.action.text, 'call the dealer, waiting on Sam');
  assert.strictEqual(r.action.added, '2026-10-08 10:42');
});

test('a second item goes under the first, and a new day gets its own heading', () => {
  A.addNote('Alpha', 'action item - book the inspection', T(9, 8, 0));
  const f = read('projects/Alpha/action-items.md');
  assert.match(f, /waiting on Sam \| added [^\n]+\n- \[ \] book the inspection \| added 2026-10-09 08:00/);
  assert.match(read('projects/Alpha/input/notes/2026-W41.md'), /## Fri 2026-10-09\n\n### 08:00 · action item/);
});

test('an empty "action item" note is refused, and so is an empty note', () => {
  assert.throws(() => A.addNote('Alpha', 'action item:  ', T(9, 8, 1)), /Add what needs doing/);
  assert.throws(() => A.addNote('Alpha', '   ', T(9, 8, 1)), /empty/);
});

test('a received input/ folder is never written into: notes go to work/notes', () => {
  const r = A.addNote('Client', 'action item: reply to Sam', T(8, 11, 20));
  assert.strictEqual(r.file, 'projects/Client/work/notes/2026-W41.md');
  assert.ok(!exists('projects/Client/input/notes'));
  assert.match(read('projects/Client/action-items.md'), /\[note\]\(work\/notes\/2026-W41\.md\)/);
});

test('Inbox notes and items go to agent-os/inbox', () => {
  const r = A.addNote('Inbox', 'action item: decide where this goes', T(8, 12, 0));
  assert.strictEqual(r.file, 'agent-os/inbox/notes-2026-W41.md');
  assert.match(read('agent-os/inbox/action-items.md'), /\[note\]\(notes-2026-W41\.md\)/);
});

test('unknown projects and paths outside the vault are refused', () => {
  assert.throws(() => A.addNote('Nope', 'x'), /no project/);
  assert.throws(() => A.addNote('../agent-os', 'x'), /no project/);
  assert.throws(() => A.close('Alpha/../..', '- [ ] x'), /no project/);
});

test('list() reads every project, with the note link made vault-relative', () => {
  const l = A.list();
  assert.strictEqual(l.open, 4);
  const it = l.items.find((i) => i.text === 'reply to Sam');
  assert.strictEqual(it.project, 'Client');
  assert.strictEqual(it.note, 'projects/Client/work/notes/2026-W41.md');
  assert.strictEqual(l.items.find((i) => i.project === 'Inbox').note, 'agent-os/inbox/notes-2026-W41.md');
});

test('close moves the line to the top of Closed with a stamp; reopen puts it back exactly', () => {
  const it = A.list().items.find((i) => i.text === 'book the inspection');
  const before = read('projects/Alpha/action-items.md');
  const c = A.close('Alpha', it.raw, T(9, 9, 30));
  assert.strictEqual(c.raw, '- [x] book the inspection | added 2026-10-09 08:00, closed 2026-10-09 09:30 · [note](input/notes/2026-W41.md)');
  const after = read('projects/Alpha/action-items.md');
  assert.match(after, /## Closed\n\n- \[x\] book the inspection/);
  assert.ok(!/- \[ \] book the inspection/.test(after));
  assert.strictEqual(A.list().open, 3);
  A.close('Alpha', A.list().items.find((i) => i.text.startsWith('call the dealer')).raw, T(9, 9, 40));
  assert.match(read('projects/Alpha/action-items.md'), /## Closed\n\n- \[x\] call the dealer[^\n]+\n- \[x\] book the inspection/, 'newest closed first');
  A.reopen('Alpha', A.list().items.find((i) => i.text.startsWith('call the dealer')).raw);
  A.reopen('Alpha', c.raw);
  const back = A.list().items.filter((i) => i.project === 'Alpha' && !i.done).map((i) => i.text);
  assert.deepStrictEqual(back, ['call the dealer, waiting on Sam', 'book the inspection']);
  assert.strictEqual(read('projects/Alpha/action-items.md').replace(/\n+/g, '\n'), before.replace(/\n+/g, '\n'));
  assert.ok(!/\n\n\n/.test(read('projects/Alpha/action-items.md')), 'moving lines leaves no runs of blank lines');
});

test('update rewords an item and keeps its dates and note link; the note itself is untouched', () => {
  const it = A.list().items.find((i) => i.project === 'Alpha' && i.text === 'book the inspection');
  const noteBefore = read('projects/Alpha/input/notes/2026-W41.md');
  const r = A.update('Alpha', it.raw, 'book the roof inspection | by Friday\n  please');
  assert.strictEqual(r.raw, '- [ ] book the roof inspection / by Friday please | added 2026-10-09 08:00 · [note](input/notes/2026-W41.md)');
  assert.strictEqual(read('projects/Alpha/input/notes/2026-W41.md'), noteBefore, 'the note is not 1:1 with its item');
  const again = A.list().items.find((i) => i.text.startsWith('book the roof'));
  assert.strictEqual(again.added, '2026-10-09 08:00');
  assert.strictEqual(again.note, 'projects/Alpha/input/notes/2026-W41.md');
  assert.throws(() => A.update('Alpha', again.raw, '   '), /some words/);
  assert.throws(() => A.update('Alpha', it.raw, 'x'), /changed in the file/, 'the old line is gone');
  A.update('Alpha', again.raw, 'book the inspection'); // put it back for the tests below
});

test('update works on a hand-typed line with no dates, and on a closed one', () => {
  put('projects/Beta_Two/action-items.md', '## Open\n\n- [ ] plain\n\n## Closed\n\n- [x] old | added 2026-10-01 09:00, closed 2026-10-02 10:00\n');
  assert.strictEqual(A.update('Beta_Two', '- [ ] plain', 'plain, reworded').raw, '- [ ] plain, reworded');
  assert.strictEqual(A.update('Beta_Two', '- [x] old | added 2026-10-01 09:00, closed 2026-10-02 10:00', 'older').raw, '- [x] older | added 2026-10-01 09:00, closed 2026-10-02 10:00');
});

test('a line changed by hand since the panel read it is not touched', () => {
  assert.throws(() => A.close('Alpha', '- [ ] something that is not there'), /changed in the file/);
});

test('hand edits count: [x] in Open is closed, a bare "- [ ] line" is open, CRLF files keep CRLF', () => {
  put('projects/Beta_Two/action-items.md', '# Action items\r\n\r\n## Open\r\n\r\n- [ ] buy milk\r\n- [x] done by hand\r\n\r\n## Closed\r\n');
  const b = A.list().items.filter((i) => i.project === 'Beta_Two');
  assert.deepStrictEqual(b.map((i) => [i.text, i.done, i.added]), [['buy milk', false, null], ['done by hand', true, null]]);
  A.close('Beta_Two', '- [ ] buy milk', T(9, 10, 0));
  const t = read('projects/Beta_Two/action-items.md');
  assert.ok(!/[^\r]\n/.test(t), 'still CRLF throughout');
  assert.match(t, /- \[x\] buy milk \| closed 2026-10-09 10:00/);
  A.addNote('Beta_Two', 'action item: new one', T(9, 10, 5));
  assert.match(read('projects/Beta_Two/action-items.md'), /## Open\r\n\r\n- \[x\] done by hand\r\n- \[ \] new one/);
});

test('notes(): this week and last, newest first, with action flags', () => {
  A.addNote('Alpha', 'Last week thought.', T(2, 16, 0));
  A.addNote('Alpha', 'Too old to show.', new Date(2026, 8, 20, 9, 0));
  const n = A.notes('Alpha', T(9, 12, 0));
  assert.deepStrictEqual(n.map((x) => `${x.date} ${x.time} ${x.action ? 'A' : '-'}`), ['2026-10-09 08:00 A', '2026-10-08 10:42 A', '2026-10-08 09:05 -', '2026-10-02 16:00 -']);
  assert.strictEqual(n[3].file, 'projects/Alpha/input/notes/2026-W40.md');
  const all = A.notes(null, T(9, 12, 0));
  assert.ok(all.some((x) => x.project === 'Client') && all.some((x) => x.project === 'Inbox'));
});

test('a multi-line note keeps its lines', () => {
  A.addNote('Alpha', 'line one\nline two', T(9, 13, 0));
  assert.strictEqual(A.notes('Alpha', T(9, 14, 0))[0].text, 'line one\nline two');
});

// A folder with no projects/: each top-level folder is a project, apart from the assistant's own and the usual non-project ones.
const vault = require('../electron/vault.cjs');
const FLAT = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-flat-'));
const putF = (rel, text) => { fs.mkdirSync(path.dirname(path.join(FLAT, rel)), { recursive: true }); fs.writeFileSync(path.join(FLAT, rel), text); };
putF('Garden/README.md', '---\ntitle: Garden\ndescription: Raised beds.\n---\n# Garden\n');
putF('Garden/output/plan.md', '---\ntitle: Bed plan\ndescription: What goes where.\n---\n# Plan\n');
putF('Garden/seeds.md', '# Seeds\n[plan](output/plan.md)\n');
putF('Taxes/README.md', '# Taxes\n');
putF('Taxes/input/README.md', '---\nreceived: true\n---\n# From the accountant\n');
putF('skills/learn/SKILL.md', '---\nname: learn\n---\n');
putF('agent-os/inbox/index.md', '# Inbox\n');
putF('_templates/t.md', '# T\n');
putF('.obsidian/app.json', '{}');
putF('loose.md', '# A note at the top\n');

test('no projects/ folder: top-level folders are projects, Agentic OS\'s own folders are not', () => {
  vault.setRoot(FLAT);
  const lay = vault.projectLayout();
  assert.deepStrictEqual({ base: lay.base, names: lay.names }, { base: '', names: ['Garden', 'Taxes'] });
  assert.deepStrictEqual(A.projects(), ['Garden', 'Taxes', 'Inbox']);
  const ps = vault.projects();
  const g = ps.find((p) => p.folder === 'Garden');
  assert.strictEqual(g.path, 'Garden');
  assert.strictEqual(g.title, 'Garden');
  assert.deepStrictEqual(g.deliverables.map((d) => d.path), ['Garden/output/plan.md']);
  assert.deepStrictEqual(g.working.map((d) => d.path), ['Garden/seeds.md']);
  assert.ok(!ps.some((p) => ['skills', 'agent-os', '_templates', '.obsidian'].includes(p.folder)));
});

test('no projects/ folder: notes, action items and the map use the top-level folder', () => {
  const r = A.addNote('Garden', 'action item: order compost', T(8, 9, 0));
  assert.strictEqual(r.file, 'Garden/input/notes/2026-W41.md');
  assert.match(fs.readFileSync(path.join(FLAT, 'Garden/action-items.md'), 'utf8'), /- \[ \] order compost/);
  assert.strictEqual(A.addNote('Taxes', 'Received folder stays untouched.', T(8, 9, 5)).file, 'Taxes/work/notes/2026-W41.md');
  assert.ok(!fs.existsSync(path.join(FLAT, 'Taxes/input/notes')));
  assert.ok(A.list().items.some((i) => i.project === 'Garden' && i.text === 'order compost'));
  const nodes = vault.graph().nodes;
  assert.strictEqual(nodes.find((n) => n.id === 'Garden/seeds.md').project, 'Garden');
  assert.strictEqual(nodes.find((n) => n.id === 'loose.md').project, undefined);
  assert.strictEqual(nodes.find((n) => n.id === 'skills/learn/SKILL.md').project, undefined);
  assert.throws(() => A.addNote('skills', 'nope', T(8, 9, 0)), /no project called/);
});

test('with a projects/ folder, top-level folders are not projects', () => {
  putF('projects/Real/README.md', '# Real\n');
  const lay = vault.projectLayout();
  assert.deepStrictEqual({ base: lay.base, names: lay.names }, { base: 'projects', names: ['Real'] });
  assert.deepStrictEqual(vault.projects().map((p) => p.path), ['projects/Real']);
  assert.strictEqual(vault.graph().nodes.find((n) => n.id === 'Garden/seeds.md').project, undefined);
  vault.setRoot(VAULT);
});

// ---- an OKF project: week notes in Raw/Notes/, action items in a register (registers.cjs) ----

const OKF = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-okf-'));
const putO = (rel, text) => { fs.mkdirSync(path.dirname(path.join(OKF, rel)), { recursive: true }); fs.writeFileSync(path.join(OKF, rel), text); };
const readO = (rel) => fs.readFileSync(path.join(OKF, rel), 'utf8');
const REG = 'Acme/Platform Team/Records/actionitem-register.md';
const WEEK = 'Acme/Platform Team/Raw/Notes/261005_Week_Notes.md';
const p2t = (n) => String(n).padStart(2, '0');
const today = new Date();
const todayTag = `${p2t(today.getFullYear() % 100)}${p2t(today.getMonth() + 1)}${p2t(today.getDate())}`;
const todayIso = `${today.getFullYear()}-${p2t(today.getMonth() + 1)}-${p2t(today.getDate())}`;
for (const d of ['Raw', 'Records', 'Sessions']) fs.mkdirSync(path.join(OKF, 'Acme/Platform Team', d), { recursive: true });
putO('Acme/README.md', '# Acme\n');
putO(REG, [
  '---', 'title: Platform Team Action Items', 'concept_class: action-item', 'as_of: 2026-10-01', '---', '',
  '# Platform Team Action Items', '', 'One is open and one is closed.', '',
  '## Where the items stand', '', '| # | Item | Status | Waiting on |', '| --- | --- | --- | --- |',
  '| 1 | Define the handoff | `[CLOSED 260921]` | — |', '| 2 | Chase the MySQLs | `[OPEN]` | Lora |', '',
  '## 1 — Define the handoff `[CLOSED 260921]`', '', '**Summary.** Define the task requirements for the DBA handoff.', '',
  '**Updates**', '- [260915] Raised in the stand-up.', '- [260921] Closed on his word.', '', '---', '',
  '## 2 — Chase the MySQLs `[OPEN]`', '', '**Summary.** Chase the MySQLs.', '',
  '**Updates**', '- [261001] Auto-added from today\'s notes.', '', '**Sources.** a note.', '', '---', '',
  '## Provenance and decay', '', 'Prose that is not an item.', '',
].join('\n'));

test('OKF project: notes go to Raw/Notes/<Monday>_Week_Notes.md and action items to the register', () => {
  vault.setRoot(OKF);
  assert.ok(A.projects().includes('Platform Team'));
  const w = A.where('Platform Team', T(8, 9, 0));
  assert.strictEqual(w.file, WEEK);
  assert.strictEqual(w.actions, REG);
});

test('OKF project: the register\'s items are listed, with waiting-on, and dates only where the register has them', () => {
  const regs = A.list().items.filter((i) => i.register);
  assert.strictEqual(regs.length, 2);
  const open = regs.find((i) => i.num === 2);
  assert.strictEqual(open.project, 'Platform Team');
  assert.strictEqual(open.done, false);
  assert.strictEqual(open.text, 'Chase the MySQLs (waiting on Lora)');
  assert.strictEqual(open.added, '2026-10-01'); // from the Auto-added line
  const shut = regs.find((i) => i.num === 1);
  assert.strictEqual(shut.done, true);
  assert.strictEqual(shut.closed, '2026-09-21');
  assert.strictEqual(shut.added, null); // its first update isn't an Auto-added line
});

test('OKF project: close, reopen and update follow the register\'s rules', () => {
  const raw = `register:${REG}#2`;
  assert.strictEqual(A.close('Platform Team', raw).raw, raw);
  let t = readO(REG);
  assert.match(t, new RegExp(`^## 2 — Chase the MySQLs \`\\[CLOSED ${todayTag}\\]\`$`, 'm'));
  assert.match(t, new RegExp(`^\\| 2 \\| Chase the MySQLs \\| \`\\[CLOSED ${todayTag}\\]\` \\| — \\|$`, 'm'));
  assert.match(t, new RegExp(`- \\[261001\\] Auto-added from today's notes\\.\\n- \\[${todayTag}\\] Closed on his word\\.`));
  assert.match(t, /^Zero are open and two are closed\.$/m);
  assert.match(t, new RegExp(`^as_of: ${todayIso}$`, 'm'));
  assert.throws(() => A.close('Platform Team', raw), /already closed/);
  A.reopen('Platform Team', raw);
  t = readO(REG);
  assert.match(t, /^## 2 — Chase the MySQLs `\[OPEN\]`$/m);
  assert.match(t, /^One is open and one is closed\.$/m);
  A.update('Platform Team', raw, 'Lora replied, two left.');
  assert.match(readO(REG), new RegExp(`- \\[${todayTag}\\] Reopened on his word\\.\\n- \\[${todayTag}\\] Lora replied, two left\\.`));
  assert.throws(() => A.update('Platform Team', raw, '  '), /needs some words/);
  assert.throws(() => A.close('Inbox', raw), /not in this project/);
});

test('OKF project: a note is written in the week file\'s own format, and "action item" files a new register item', () => {
  putO(WEEK, '## Wednesday — Oct 7 (processed)\n- **6:46am** — Looked at the IDC list\n\n## Thursday — Oct 8\n- **9:55am** — First\n');
  const r = A.addNote('Platform Team', 'Action item: call Phillip\nabout VCLIPRD', T(8, 14, 10));
  assert.strictEqual(r.file, WEEK);
  assert.strictEqual(readO(WEEK), '## Wednesday — Oct 7 (processed)\n- **6:46am** — Looked at the IDC list\n\n## Thursday — Oct 8\n- **9:55am** — First\n- **2:10pm** — Action item: call Phillip\n  about VCLIPRD\n');
  assert.strictEqual(r.action.num, 3);
  assert.strictEqual(r.action.added, todayIso);
  const t = readO(REG);
  assert.match(t, /^## 3 — call Phillip about VCLIPRD `\[OPEN\]`$/m);
  assert.ok(t.indexOf('## 3 —') < t.indexOf('## Provenance and decay'), 'the new item goes after the last item, not after the prose');
  assert.match(t, /^\| 3 \| call Phillip about VCLIPRD \| `\[OPEN\]` \| — \|$/m);
  assert.match(t, /Source: \[`Acme\/Platform Team\/Raw\/Notes\/261005_Week_Notes\.md`\]\(\.\.\/Raw\/Notes\/261005_Week_Notes\.md\)/);
  A.addNote('Platform Team', 'Friday thought', T(9, 8, 5));
  assert.match(readO(WEEK), /about VCLIPRD\n\n## Friday — Oct 9\n- \*\*8:05am\*\* — Friday thought\n$/);
});

test('OKF project: notes() reads the week files back, dated by weekday, newest first', () => {
  const ns = A.notes('Platform Team', T(9, 12, 0));
  assert.deepStrictEqual(ns.map((n) => `${n.date} ${n.time} ${n.action ? 'A' : '-'}`), ['2026-10-09 08:05 -', '2026-10-08 14:10 A', '2026-10-08 09:55 -', '2026-10-07 06:46 -']);
  assert.strictEqual(ns[1].text, 'Action item: call Phillip\nabout VCLIPRD');
  vault.setRoot(VAULT);
});

// ---- one shared register: every project's action items go into the one register, tagged with their project ----

const SHR = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-shared-'));
const putS = (rel, text) => { fs.mkdirSync(path.dirname(path.join(SHR, rel)), { recursive: true }); fs.writeFileSync(path.join(SHR, rel), text); };
const readS = (rel) => fs.readFileSync(path.join(SHR, rel), 'utf8');
for (const d of ['Raw', 'Records', 'Sessions']) fs.mkdirSync(path.join(SHR, 'Acme/Platform Team', d), { recursive: true });
putS('Acme/README.md', '# Acme\n');
putS('Gamma/README.md', '# Gamma\n');
putS('agent-os/inbox/index.md', '# Inbox\n');
// the same register as the tests above left it, minus item 3 (its section and its table row)
putS(REG, readO(REG).replace(/^## 3 —[\s\S]*?^---\r?\n\r?\n/m, '').replace(/^\| 3 \|.*\r?\n/m, ''));

test('shared register: a plain project\'s action item goes into the one register, with a Project line', () => {
  vault.setRoot(SHR);
  const before = readS(REG);
  assert.strictEqual(require('../electron/registers.cjs').sharedRegister(), REG);
  assert.strictEqual(A.where('Gamma', T(8, 9, 0)).actions, REG);
  const r = A.addNote('Gamma', 'Action item: send the Gamma plan', T(8, 9, 30));
  assert.strictEqual(r.action.num, 3);
  assert.strictEqual(r.action.file, REG);
  assert.strictEqual(r.action.origin, 'Gamma');
  assert.strictEqual(r.action.project, 'Platform Team', 'the register\'s own project owns the item');
  assert.ok(!fs.existsSync(path.join(SHR, 'Gamma/action-items.md')), 'no second file is made');
  const t = readS(REG);
  assert.match(t, /^## 3 — send the Gamma plan `\[OPEN\]`$/m);
  assert.match(t, /^\*\*Project\.\*\* Gamma$/m);
  assert.match(t, /^\| 3 \| send the Gamma plan \| `\[OPEN\]` \| — \|$/m);
  assert.ok(t.indexOf('## 3 —') < t.indexOf('## Provenance and decay'));
  assert.ok(t.length > before.length);
});

test('shared register: the Inbox files there too, and an item with no Project line is labelled by its register\'s project', () => {
  const r = A.addNote('Inbox', 'Action item: sort the inbox', T(8, 10, 0));
  assert.strictEqual(r.action.num, 4);
  assert.strictEqual(r.action.origin, 'Inbox');
  assert.ok(!fs.existsSync(path.join(SHR, 'agent-os/inbox/action-items.md')));
  const items = A.list().items.filter((i) => i.register);
  assert.strictEqual(items.length, 4);
  assert.strictEqual(items.find((i) => i.num === 2).origin, 'Platform Team'); // older item: no Project line
  assert.strictEqual(items.find((i) => i.num === 3).origin, 'Gamma');
});

test('shared register: close, reopen and update work through the owning project, and keep the Project line', () => {
  const raw = `register:${REG}#3`;
  A.close('Platform Team', raw);
  assert.match(readS(REG), new RegExp(`^## 3 — send the Gamma plan \`\\[CLOSED ${todayTag}\\]\`$`, 'm'));
  A.reopen('Platform Team', raw);
  A.update('Platform Team', raw, 'Draft sent.');
  const t = readS(REG);
  assert.match(t, /^\*\*Project\.\*\* Gamma$/m);
  assert.match(t, /Draft sent\./);
  assert.strictEqual(A.list().items.find((i) => i.raw === raw).origin, 'Gamma');
  vault.setRoot(VAULT);
});

// The Projects panel's sorting (vault.cjs projects()) and its corrections file, in an OKF project of its own.
const PJ = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-panel-'));
process.env.AOS_BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-panel-bk-'));
const putP = (rel, text) => { fs.mkdirSync(path.dirname(path.join(PJ, rel)), { recursive: true }); fs.writeFileSync(path.join(PJ, rel), text); };
putP('Team/Records/person-a.md', '---\ntitle: A, Person\n---\n');
putP('Team/Records/tool-x-dashboard.html', '<p>x</p>');
putP('Team/Client Facing/page.md', '---\ntitle: The page\n---\n');
putP('Team/Client Facing/Kit/index.md', '---\ntitle: The kit\n---\n');
putP('Team/Client Facing/Kit/part.md', '# Part\n');
putP('Team/Client Facing/Kit.zip', 'zip');
putP('Team/Sessions/261001_Call/_README.md', '# Call\n\n*Part of the knowledge base.\nEntry point: x.*\n\nWhat the call settled.\n');
putP('Team/Sessions/261001_Call/Output/261001_Call_Key_Points.md', '---\ntitle: Key points\n---\n');
putP('Team/Sessions/261001_Call/Output/261001_Call_Workbook.xlsx', 'x');
putP('Team/Sessions/261001_Call/Output/build.ps1', 'x');
putP('Team/Sessions/261001_Call/Input/call.vtt', 'x');
putP('Team/Raw/Jira/export.csv', 'x');

test('Projects panel: notes, records, sessions, bundles and dashboards each land in their own place', () => {
  vault.setRoot(PJ);
  const p = vault.projects().find((x) => x.folder === 'Team');
  assert.strictEqual(p.okf, true);
  assert.deepStrictEqual(p.deliverables.map((d) => d.path).sort(), ['Team/Client Facing/Kit/index.md', 'Team/Client Facing/page.md', 'Team/Records/tool-x-dashboard.html', 'Team/Sessions/261001_Call/Output/261001_Call_Workbook.xlsx']);
  assert.strictEqual(p.deliverables.find((d) => d.bundle).bundle, 2); // the folder is one card; its zip is not a second one
  assert.deepStrictEqual(p.sessionNotes.map((d) => d.name), ['261001_Call_Key_Points.md']);
  assert.deepStrictEqual(p.records.map((d) => d.group), ['person']);
  const s = p.sessions[0];
  assert.strictEqual(s.outcome, 'What the call settled.');
  assert.deepStrictEqual(s.output.map((e) => e.type).sort(), ['deliverable', 'note']);
  assert.deepStrictEqual(s.evidence.map((e) => e.name).sort(), ['build.ps1', 'call.vtt']); // scripts are never deliverables
  assert.deepStrictEqual(p.raw, [{ label: 'Raw / Jira', count: 1 }]);
  assert.ok(p.search.some((f) => f.name === 'part.md') && p.search.some((f) => f.name === 'export.csv')); // still findable
});

test('Projects panel: a correction moves a file and lasts; null and clearOverrides undo it', () => {
  const wb = 'Team/Sessions/261001_Call/Output/261001_Call_Workbook.xlsx';
  vault.setOverride(wb, 'evidence');
  vault.setOverride('Team/Records/tool-x-dashboard.html', 'evidence');
  let p = vault.projects().find((x) => x.folder === 'Team');
  assert.ok(!p.deliverables.some((d) => d.path === wb));
  assert.ok(p.sessions[0].output.some((e) => e.path === wb && e.overridden)); // back with its session
  assert.ok(p.working.some((e) => e.name === 'tool-x-dashboard.html'));
  assert.strictEqual(p.corrections, 2);
  assert.ok(fs.existsSync(path.join(PJ, '.aos/panel-overrides.json')));
  vault.setOverride(wb, null);
  assert.ok(vault.projects().find((x) => x.folder === 'Team').deliverables.some((d) => d.path === wb));
  vault.clearOverrides('Team');
  assert.strictEqual(vault.projects().find((x) => x.folder === 'Team').corrections, 0);
  assert.throws(() => vault.setOverride('../outside.md', 'note'));
  assert.throws(() => vault.setOverride(wb, 'bogus'));
  vault.setRoot(VAULT);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
fs.rmSync(PJ, { recursive: true, force: true });
fs.rmSync(VAULT, { recursive: true, force: true });
fs.rmSync(FLAT, { recursive: true, force: true });
fs.rmSync(OKF, { recursive: true, force: true });
fs.rmSync(SHR, { recursive: true, force: true });

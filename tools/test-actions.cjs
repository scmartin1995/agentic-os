// Tests for electron/actions.cjs (the Notes and Action items pages). Run: node tools/test-actions.cjs
// Uses a throwaway workspace, never a real one.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-actions-'));
process.env.AGENTIC_OS_VAULT = WS;
process.env.AOS_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-actions-data-'));
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(WS, rel)), { recursive: true }); fs.writeFileSync(path.join(WS, rel), text); };
put('projects/Alpha/README.md', '# Alpha\n');
put('projects/beta-two/README.md', '# Beta\n');
put('projects/_archive/README.md', '# not a project\n');
// a hand-made checklist with no Open/Closed headings, Windows line endings
put('projects/beta-two/action-items.md', '# To do\r\n\r\n- [x] book the movers\r\n- [ ] set up internet\r\n* [ ] change the address\r\n');

const A = require('../electron/actions.cjs');
const shared = require('../electron/shared.cjs');
const read = (rel) => fs.readFileSync(path.join(WS, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(WS, rel));
const T = (d, h, m) => new Date(2026, 9, d, h, m); // October 2026

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('ok   ', name); } catch (e) { console.log('FAIL ', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); process.exitCode = 1; } };

test('projects: every folder under projects/ except _ and . ones, plus the Inbox', () => {
  assert.deepStrictEqual(A.projects(), ['Alpha', 'beta-two', 'Inbox']);
});

test('the "action item" prefix: any capitals, colon, dash or space; nothing else', () => {
  assert.strictEqual(A.actionText('action item: call the dealer'), 'call the dealer');
  assert.strictEqual(A.actionText('  Action Item - call the dealer'), 'call the dealer');
  assert.strictEqual(A.actionText('ACTION ITEM call\nthe dealer'), 'call the dealer');
  assert.strictEqual(A.actionText('action items: call'), null);
  assert.strictEqual(A.actionText('call the dealer, action item'), null);
  assert.strictEqual(A.actionText('action item:'), '');
});

test('a plain note goes to the project\'s notes.md under a day heading and a time heading', () => {
  const r = A.addNote('Alpha', 'First thought.', T(8, 9, 5));
  assert.strictEqual(r.file, 'projects/Alpha/notes.md');
  assert.strictEqual(r.action, null);
  assert.strictEqual(read(r.file), '# Notes: Alpha\n\n## Thu 2026-10-08\n\n### 09:05\nFirst thought.\n');
  assert.ok(!exists('projects/Alpha/action-items.md'));
  assert.ok(shared.wroteRecently(r.file), 'marked as written by the app');
});

test('a second note the same day shares the day heading', () => {
  A.addNote('Alpha', 'Second thought.', T(8, 9, 30));
  assert.strictEqual((read('projects/Alpha/notes.md').match(/## Thu 2026-10-08/g) || []).length, 1);
});

test('an action item note is kept in the note and copied (without the prefix) to action-items.md', () => {
  const r = A.addNote('Alpha', 'Action item: call the dealer, waiting on Sam', T(8, 10, 42));
  assert.match(read('projects/Alpha/notes.md'), /### 10:42 · action item\nAction item: call the dealer, waiting on Sam\n$/);
  assert.strictEqual(r.action.text, 'call the dealer, waiting on Sam');
  assert.strictEqual(read('projects/Alpha/action-items.md'), '# Action items: Alpha\n\n## Open\n\n- [ ] call the dealer, waiting on Sam | added 2026-10-08 10:42 · [note](notes.md)\n\n## Closed\n');
});

test('list(): checkbox lines from every action-items.md, open and closed, with the Inbox', () => {
  A.addNote('Inbox', 'action item: renew insurance', T(9, 8, 0));
  const r = A.list();
  assert.strictEqual(r.open, 4);
  assert.deepStrictEqual(r.items.map((i) => `${i.project}:${i.done ? 'x' : ' '}:${i.text}`), [
    'Alpha: :call the dealer, waiting on Sam', 'beta-two:x:book the movers', 'beta-two: :set up internet', 'beta-two: :change the address', 'Inbox: :renew insurance',
  ]);
  assert.strictEqual(r.items[0].note, 'projects/Alpha/notes.md');
  assert.ok(exists('inbox/notes.md') && exists('inbox/action-items.md'));
});

test('closing in a file with Open/Closed: the line moves under Closed with a stamp; reopen moves it back', () => {
  const it = A.list().items.find((i) => i.project === 'Alpha');
  const c = A.close('Alpha', it.raw, T(9, 15, 0));
  assert.strictEqual(c.raw, '- [x] call the dealer, waiting on Sam | added 2026-10-08 10:42, closed 2026-10-09 15:00 · [note](notes.md)');
  assert.match(read('projects/Alpha/action-items.md'), /## Open\n\n## Closed\n\n- \[x\] call the dealer/);
  const o = A.reopen('Alpha', c.raw);
  assert.strictEqual(o.raw, '- [ ] call the dealer, waiting on Sam | added 2026-10-08 10:42 · [note](notes.md)');
  assert.match(read('projects/Alpha/action-items.md'), /## Open\n\n- \[ \] call the dealer[^\n]*\n\n## Closed\n/);
});

test('closing in a plain checklist: ticked where it is, line endings and bullet kept', () => {
  const it = A.list().items.find((i) => i.text === 'change the address');
  A.close('beta-two', it.raw, T(9, 16, 0));
  assert.strictEqual(read('projects/beta-two/action-items.md'), '# To do\r\n\r\n- [x] book the movers\r\n- [ ] set up internet\r\n* [x] change the address | closed 2026-10-09 16:00\r\n');
  A.reopen('beta-two', '* [x] change the address | closed 2026-10-09 16:00');
  assert.match(read('projects/beta-two/action-items.md'), /\* \[ \] change the address\r\n$/);
});

test('update rewords only the text and keeps the dates', () => {
  const it = A.list().items.find((i) => i.project === 'Alpha');
  const r = A.update('Alpha', it.raw, 'ring the dealer');
  assert.strictEqual(r.raw, '- [ ] ring the dealer | added 2026-10-08 10:42 · [note](notes.md)');
});

test('a changed line, a closed one, or an unknown project is refused', () => {
  assert.throws(() => A.close('Alpha', '- [ ] not there'), /changed in the file/);
  assert.throws(() => A.close('beta-two', '- [x] book the movers'), /already closed/);
  assert.throws(() => A.addNote('../../etc', 'x'), /no project/);
  assert.throws(() => A.addNote('_archive', 'x'), /no project/);
});

test('notes(): dated entries from this week and last, newest first; untimed text under a day counts', () => {
  put('projects/beta-two/notes.md', '# Notes\n\nintro with no date is not listed\n\n## Wed 2026-10-07\n\nMovers booked.\n\n## 2026-09-20\n\nToo old.\n');
  A.addNote('Alpha', 'Last week thought.', T(2, 16, 0));
  const n = A.notes(null, T(9, 12, 0));
  assert.deepStrictEqual(n.map((x) => `${x.project} ${x.date} ${x.time} ${x.action ? 'A' : '-'}`), [
    'Inbox 2026-10-09 08:00 A', 'Alpha 2026-10-08 10:42 A', 'Alpha 2026-10-08 09:30 -', 'Alpha 2026-10-08 09:05 -', 'beta-two 2026-10-07 00:00 -', 'Alpha 2026-10-02 16:00 -',
  ]);
  assert.strictEqual(n.find((x) => x.project === 'beta-two').text, 'Movers booked.');
});

test('where(): the two file names for a project', () => {
  assert.deepStrictEqual(A.where('beta-two', T(9, 12, 0)), { file: 'projects/beta-two/notes.md', actions: 'projects/beta-two/action-items.md', week: '2026-W41' });
  assert.strictEqual(A.where('Inbox').file, 'inbox/notes.md');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
fs.rmSync(WS, { recursive: true, force: true });

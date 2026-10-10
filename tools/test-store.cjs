// Tests for electron/store.cjs (safe JSON files and the app log). Run: node tools/test-store.cjs
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-store-'));
process.env.AOS_USERDATA = dir; // store.cjs falls back to this outside Electron
const store = require('../electron/store.cjs');

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('ok   ', name); } catch (e) { console.log('FAIL ', name, '\n     ', e.message); process.exitCode = 1; } };
const f = (n) => path.join(dir, n);

test('writeJson then readJson round-trips, and makes missing folders', () => {
  store.writeJson(path.join(dir, 'a', 'b', 'x.json'), { n: 1, s: 'hi' });
  assert.deepStrictEqual(store.readJson(path.join(dir, 'a', 'b', 'x.json'), null), { n: 1, s: 'hi' });
});

test('writeJson leaves no temporary file behind, and replaces an existing file', () => {
  store.writeJson(f('y.json'), { v: 1 });
  store.writeJson(f('y.json'), { v: 2 });
  assert.strictEqual(store.readJson(f('y.json'), null).v, 2);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

test('a failed write keeps the old file (the rename never happens)', () => {
  store.writeJson(f('z.json'), { keep: true });
  const bad = { toJSON() { throw new Error('cannot serialise'); } };
  assert.throws(() => store.writeJson(f('z.json'), bad));
  assert.deepStrictEqual(store.readJson(f('z.json'), null), { keep: true });
});

test('a missing file gives the default and writes no log line', () => {
  const before = fs.existsSync(f('app.log')) ? fs.readFileSync(f('app.log'), 'utf8') : '';
  assert.deepStrictEqual(store.readJson(f('nope.json'), { d: 1 }), { d: 1 });
  const after = fs.existsSync(f('app.log')) ? fs.readFileSync(f('app.log'), 'utf8') : '';
  assert.strictEqual(after, before);
});

test('a damaged file gives the default, is logged, and a copy is kept before anything overwrites it', () => {
  fs.writeFileSync(f('bad.json'), '{"half": ');
  assert.deepStrictEqual(store.readJson(f('bad.json'), []), []);
  assert.strictEqual(fs.readFileSync(f('bad.json.damaged'), 'utf8'), '{"half": ');
  assert.match(fs.readFileSync(f('app.log'), 'utf8'), /damaged JSON file.*bad\.json/);
});

test('tryWriteJson reports failure instead of throwing, and logs it', () => {
  fs.writeFileSync(f('afile'), 'x'); // a file where a folder is needed
  assert.strictEqual(store.tryWriteJson(path.join(f('afile'), 'sub', 'q.json'), { a: 1 }), false);
  assert.match(fs.readFileSync(f('app.log'), 'utf8'), /could not save q\.json/);
  assert.strictEqual(store.tryWriteJson(f('ok.json'), { a: 1 }), true);
});

test('log writes one timestamped line, flattens newlines, and caps the length', () => {
  store.log('line one\nline two', { a: 1 });
  store.log('x'.repeat(2000));
  const lines = fs.readFileSync(f('app.log'), 'utf8').trim().split('\n');
  const mine = lines.filter((l) => /line one line two/.test(l));
  assert.strictEqual(mine.length, 1);
  assert.match(mine[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z line one line two \{"a":1\}$/);
  assert.ok(lines.every((l) => l.length < 450));
});

test('the log rotates once it passes about 2 MB', () => {
  fs.writeFileSync(f('app.log'), 'x'.repeat(2 * 1024 * 1024 + 10));
  store.log('after the big one');
  assert.ok(fs.existsSync(f('app.log.1')));
  assert.match(fs.readFileSync(f('app.log'), 'utf8'), /after the big one/);
  assert.ok(fs.statSync(f('app.log')).size < 1000);
});

console.log(`\n${passed} passed`);
fs.rmSync(dir, { recursive: true, force: true });

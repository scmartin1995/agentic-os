// Tests for the launch-time housekeeping (policy.moveToBackup, policy.pruneBackupsSoon, workers.pruneScratch, attachments.prune).
// They used to copy thousands of small files before the window opened (11 s for one Codex scratch folder). Now an old scratch
// folder is one move into the backups, and expired backups and attachments are removed a folder at a time with a breath between.
// Runs against a throwaway folder; nothing real is touched. Run: node tools/test-housekeeping.cjs
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-housekeeping-'));
process.env.AOS_BACKUP_DIR = path.join(T, 'backups');
const orig = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => T, isReady: () => false }, safeStorage: { isEncryptionAvailable: () => false }, ipcMain: { handle() {}, on() {} }, net: {} };
  return orig.apply(this, arguments);
};
const policy = require('../electron/policy.cjs');
const workers = require('../electron/workers.cjs');
const attachments = require('../electron/attachments.cjs');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok   ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n     ', e.message); }
}
const make = (dir, files) => { for (let i = 0; i < files; i++) { const f = path.join(dir, `d${i % 7}`, `f${i}.txt`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `file ${i}`); } };
const old = (p, days) => { const t = new Date(Date.now() - days * 864e5); fs.utimesSync(p, t, t); };
const count = (d) => { let n = 0; (function w(x) { for (const e of fs.readdirSync(x, { withFileTypes: true })) { if (e.isDirectory()) w(path.join(x, e.name)); else n++; } })(d); return n; };

(async () => {
  try {
    const scratch = workers.scratchRoot();
    fs.mkdirSync(scratch, { recursive: true });

    await test('moveToBackup keeps every file, removes the original, and lands in today\'s backup folder', () => {
      const src = path.join(T, 'srcfolder'); make(src, 40);
      const dest = policy.moveToBackup(src);
      assert.ok(dest, 'returned a destination');
      assert.ok(!fs.existsSync(src), 'original is gone');
      assert.strictEqual(count(dest), 40, 'all 40 files are in the backup');
      assert.ok(dest.startsWith(path.join(T, 'backups', new Date().toISOString().slice(0, 10))), 'under today\'s folder: ' + dest);
    });

    await test('moveToBackup of something that is not there does nothing and returns null', () => {
      assert.strictEqual(policy.moveToBackup(path.join(T, 'nope')), null);
    });

    await test('a scratch folder older than 7 days is moved to the backups, intact; a fresh one stays', async () => {
      const oldDir = path.join(scratch, '20260101000000_codex'); make(oldDir, 120); old(oldDir, 10);
      const newDir = path.join(scratch, '20261001000000_codex'); make(newDir, 5);
      const moved = await workers.pruneScratch();
      assert.strictEqual(moved, 1, 'one folder moved');
      assert.ok(!fs.existsSync(oldDir), 'old one is gone from scratch');
      assert.ok(fs.existsSync(newDir), 'fresh one is still there');
      const kept = fs.readdirSync(path.join(T, 'backups')).flatMap((d) => fs.readdirSync(path.join(T, 'backups', d)).map((n) => path.join(T, 'backups', d, n))).filter((p) => /20260101000000_codex/.test(p));
      assert.strictEqual(kept.length, 1, 'found the moved folder in the backups');
      assert.strictEqual(count(kept[0]), 120, 'all 120 files kept for the 30-day undo');
    });

    await test('moving 3,000 files takes about the same time as moving 3: it is one rename, not a copy', async () => {
      const big = path.join(scratch, '20260102000000_codex'); make(big, 3000); old(big, 10);
      const small = path.join(scratch, '20260103000000_codex'); make(small, 3); old(small, 10);
      const t0 = process.hrtime.bigint(); policy.moveToBackup(big); const bigMs = Number(process.hrtime.bigint() - t0) / 1e6;
      const t1 = process.hrtime.bigint(); policy.moveToBackup(small); const smallMs = Number(process.hrtime.bigint() - t1) / 1e6;
      assert.ok(bigMs < 250, `3,000 files moved in ${bigMs.toFixed(0)} ms (a copy took seconds)`);
      assert.ok(!fs.existsSync(big) && !fs.existsSync(small));
      console.log(`       3,000 files: ${bigMs.toFixed(1)} ms   3 files: ${smallMs.toFixed(1)} ms`);
    });

    await test('housekeeping lets the app breathe: other work runs between folders', async () => {
      for (let i = 0; i < 6; i++) { const d = path.join(scratch, `2026020${i}000000_codex`); make(d, 30); old(d, 10); }
      let ticks = 0; const timer = setInterval(() => ticks++, 1);
      await workers.pruneScratch();
      clearInterval(timer);
      assert.ok(ticks >= 3, `the event loop ran ${ticks} times while 6 folders were handled (0 would mean it was held)`);
    });

    await test('expired backup days are removed; recent ones and non-date entries stay', async () => {
      const bk = path.join(T, 'backups');
      for (const [name, days] of [['2026-01-05', 60], ['2026-01-06', 45], [new Date().toISOString().slice(0, 10) + '-keep', 0]]) { /* names below */ }
      fs.mkdirSync(path.join(bk, '2020-01-01'), { recursive: true }); fs.writeFileSync(path.join(bk, '2020-01-01', 'a.txt'), 'x');
      fs.mkdirSync(path.join(bk, '2020-06-01'), { recursive: true }); fs.writeFileSync(path.join(bk, '2020-06-01', 'b.txt'), 'x');
      fs.mkdirSync(path.join(bk, 'manual-before-something'), { recursive: true }); fs.writeFileSync(path.join(bk, 'manual-before-something', 'c.txt'), 'x');
      const recent = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
      fs.mkdirSync(path.join(bk, recent), { recursive: true }); fs.writeFileSync(path.join(bk, recent, 'd.txt'), 'x');
      await policy.pruneBackupsSoon(30);
      assert.ok(!fs.existsSync(path.join(bk, '2020-01-01')) && !fs.existsSync(path.join(bk, '2020-06-01')), 'expired days gone');
      assert.ok(fs.existsSync(path.join(bk, 'manual-before-something')), 'a folder with no date in its name is left alone');
      assert.ok(fs.existsSync(path.join(bk, recent)), 'a recent day is kept');
    });

    await test('the synchronous pruneBackups still works (kept for callers that need it to finish first)', () => {
      const bk = path.join(T, 'backups'); fs.mkdirSync(path.join(bk, '2019-03-03'), { recursive: true }); fs.writeFileSync(path.join(bk, '2019-03-03', 'z.txt'), 'x');
      policy.pruneBackups(30);
      assert.ok(!fs.existsSync(path.join(bk, '2019-03-03')));
    });

    await test('attachments older than 30 days are removed; newer stay', async () => {
      const a = attachments.dir();
      fs.mkdirSync(path.join(a, '2020-02-02'), { recursive: true }); fs.writeFileSync(path.join(a, '2020-02-02', 'old.txt'), 'x');
      const recent = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
      fs.mkdirSync(path.join(a, recent), { recursive: true }); fs.writeFileSync(path.join(a, recent, 'new.txt'), 'x');
      await attachments.prune();
      assert.ok(!fs.existsSync(path.join(a, '2020-02-02')) && fs.existsSync(path.join(a, recent)));
    });

    await test('nothing to clean (no folders at all) is not an error', async () => {
      fs.rmSync(workers.scratchRoot(), { recursive: true, force: true }); fs.rmSync(attachments.dir(), { recursive: true, force: true });
      assert.strictEqual(await workers.pruneScratch(), 0);
      await attachments.prune();
    });

    await test('main.cjs no longer does this work before the window opens, and skips it in test captures', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
      const beforeWindow = src.slice(src.indexOf('app.whenReady()'), src.indexOf('win = createWindow()'));
      assert.ok(!/pruneBackups|pruneScratch|attachments\.prune/.test(beforeWindow), 'no clean-up before createWindow()');
      assert.ok(/if \(!CAPTURE\) setTimeout\(async \(\) => \{[\s\S]*pruneBackupsSoon[\s\S]*pruneScratch[\s\S]*attachments\.prune/.test(src), 'it runs later, and not under --capture');
    });
  } finally {
    fs.rmSync(T, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
  process.exit(failed ? 1 : 0);
})();

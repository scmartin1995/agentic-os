// Tests when a search-index pass is started after mail, and that a search straight after a pass does not start another.
// The rule lives in electron/main.cjs (mailChangedSearch / refreshSearchAfterMail), which cannot be loaded without the whole
// app, so the rule is read out of the source and run here. Run: node tools/test-search-trigger.cjs
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const rule = /const mailChangedSearch = (.*);\n/.exec(src);
const helper = /const refreshSearchAfterMail = (.*);\n/.exec(src);
let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('ok   ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n     ', e.message); } };

test('the rule and its helper are in main.cjs', () => { assert.ok(rule && helper); });
let builds = 0;
const search = { build: () => { builds++; return Promise.resolve({}); } };
// eslint-disable-next-line no-new-func
const mailChangedSearch = new Function(`return ${rule[1]}`)();
const mail = { checkWatch: () => Promise.resolve({}) }; // the helper also re-checks watched mail after a pull that changed something
const refreshSearchAfterMail = new Function('mailChangedSearch', 'search', 'mail', `return ${helper[1]}`)(mailChangedSearch, search, mail);

const none = { fetched: 2040, bulk: 3, added: 0, needReply: 0, closed: 0, failed: 0, error: '' };
test('a pull that found nothing new does not start a pass', () => { builds = 0; refreshSearchAfterMail(none); assert.strictEqual(builds, 0); });
test('a pull that added mail does', () => { builds = 0; refreshSearchAfterMail({ ...none, added: 3 }); assert.strictEqual(builds, 1); });
test('a pull that closed a reply does', () => { builds = 0; refreshSearchAfterMail({ ...none, closed: 1 }); assert.strictEqual(builds, 1); });
test('mail that failed to be read stores nothing, so it does not start a pass (this retried 24 messages every 10 minutes)', () => {
  builds = 0; refreshSearchAfterMail({ ...none, failed: 24, error: 'timed out' }); assert.strictEqual(builds, 0);
});
test('a pull that could not reach Outlook does not', () => { builds = 0; refreshSearchAfterMail({ ...none, fetched: 0, error: 'Outlook is not open' }); assert.strictEqual(builds, 0); });
test('a pull that was refused because another was running does not', () => { builds = 0; refreshSearchAfterMail({ already: true }); assert.strictEqual(builds, 0); });
test('no result at all does not', () => { builds = 0; refreshSearchAfterMail(undefined); refreshSearchAfterMail(null); assert.strictEqual(builds, 0); });
test('mixed: some added, some failed, does', () => { builds = 0; refreshSearchAfterMail({ ...none, added: 5, failed: 2 }); assert.strictEqual(builds, 1); });

test('mail.cjs hands the pull result to the hook', () => {
  const m = fs.readFileSync(path.join(__dirname, '..', 'electron', 'mail.cjs'), 'utf8');
  assert.ok(/await deps\.after\(r\)/.test(m), 'startDaily calls after(r)');
});
test('main.cjs uses the helper for both the manual pull and the scheduled check, and no longer starts a pass unconditionally', () => {
  const uses = src.match(/refreshSearchAfterMail/g) || [];
  assert.ok(uses.length >= 3, `helper used ${uses.length - 1} times`);
  assert.ok(!/after: \(\) => search\.build/.test(src), 'no unconditional pass after the scheduled check');
  assert.ok(!/await search\.build\(\{ dry: true \}\); return r;/.test(src), 'no unconditional pass after a manual pull');
});

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);

// electron/skillrun.cjs: the guards around a skill run (bad names, missing skills, the log). No model call, no tokens.
// A stand-in engine makes the SDK call fail fast, so a run ends in the log as "failed" without touching a gateway.
// Run:  node_modules\.bin\electron tools\test-skillrun.cjs
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-skillrun-'));
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-skillrun-vault-'));
app.setPath('userData', tmp);
process.env.AOS_USERDATA = tmp;
process.env.AOS_VAULT = VAULT;
fs.mkdirSync(path.join(VAULT, 'skills', 'demo'), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\n# Demo\n');

app.whenReady().then(async () => {
  const assert = require('assert');
  const skillrun = require('../electron/skillrun.cjs');
  let passed = 0, failed = 0;
  const test = async (name, fn) => { try { await fn(); passed++; console.log('ok   ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n     ', String(e.message).split('\n')[0]); } };
  const events = [];
  // authEnv throws: the run must end as a logged failure, not a crash, and clear its "running" state.
  const engine = { HAIKU: 'h', SONNET: 's', engineModel: (m) => m, engineSettings: () => ({}), authEnv: () => { throw new Error('stand-in: no gateway'); } };

  await test('rejects a name that is not a skill folder name', async () => {
    await assert.rejects(skillrun.run({ skill: '../etc', engine, emit: () => {} }), /not a skill name/);
    await assert.rejects(skillrun.run({ skill: 'a b', engine, emit: () => {} }), /not a skill name/);
  });
  await test('rejects a skill that does not exist', async () => {
    await assert.rejects(skillrun.run({ skill: 'nope', engine, emit: () => {} }), /no skill called nope/);
  });
  await test('a failing run is logged as failed, reported, and no longer running', async () => {
    const r = await skillrun.run({ skill: 'demo', model: 'haiku', engine, emit: (e) => events.push(e) });
    assert.strictEqual(r.ok, false);
    assert.match(r.note, /no gateway/);
    assert.deepStrictEqual(events.map((e) => e.type), ['start', 'done']);
    assert.deepStrictEqual(skillrun.state(), []);
    const last = skillrun.recent(5)[0];
    assert.strictEqual(last.skill, 'demo'); assert.strictEqual(last.ok, false); assert.strictEqual(last.model, 'haiku');
  });
  await test('an unknown model falls back to sonnet', async () => {
    await skillrun.run({ skill: 'demo', model: 'opus', engine, emit: () => {} });
    assert.strictEqual(skillrun.recent(1)[0].model, 'sonnet');
  });
  await test('recent() is newest first and the job shows in jobs.json', async () => {
    const r = skillrun.recent(10);
    assert.ok(r.length >= 2);
    assert.ok(r[0].at >= r[r.length - 1].at);
    assert.strictEqual(require('../electron/jobs.cjs').all()['run:demo'].ok, false);
  });
  await test('stop() on something not running is false', async () => { assert.strictEqual(skillrun.stop('demo'), false); });

  console.log(`\n${passed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
});

// Checks what differs between Windows and a Mac (electron/platform.cjs). Everything takes the platform as an argument, so the Mac
// answers are checked here on whatever computer this runs on. A real run on a Mac is still needed; see the README.
// Run: node tools/test-platform.cjs
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const platform = require('../electron/platform.cjs');
const gw = require('../electron/gateway.cjs');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('ok   ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n     ', e.message); } }

test('the engine package is named for the system and the chip', () => {
  assert.strictEqual(platform.enginePackage('win32', 'x64'), 'claude-agent-sdk-win32-x64');
  assert.strictEqual(platform.enginePackage('darwin', 'arm64'), 'claude-agent-sdk-darwin-arm64');
  assert.strictEqual(platform.enginePackage('darwin', 'x64'), 'claude-agent-sdk-darwin-x64');
  assert.strictEqual(platform.engineFile('win32'), 'claude.exe');
  assert.strictEqual(platform.engineFile('darwin'), 'claude');
});

test('every engine package this computer could need is one the Claude Code package actually lists', () => {
  const listed = Object.keys(require('../node_modules/@anthropic-ai/claude-agent-sdk/package.json').optionalDependencies || {});
  for (const [p, a] of [['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64']]) assert.ok(listed.includes('@anthropic-ai/' + platform.enginePackage(p, a)), `${p} ${a}`);
});

test('the program is found for this computer (npm installed it)', () => {
  const exe = platform.claudeExe();
  assert.ok(exe && fs.existsSync(exe), exe);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-platform-test-'));
try {
  const put = (base, pkg, file) => { const f = path.join(base, 'node_modules', '@anthropic-ai', pkg, file); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); return f; };
  test('a Mac program is found for the right chip only', () => {
    const base = path.join(tmp, 'a');
    const f = put(base, 'claude-agent-sdk-darwin-arm64', 'claude');
    assert.strictEqual(platform.claudeExe('darwin', 'arm64', base), f);
    assert.strictEqual(platform.claudeExe('darwin', 'x64', base), '');
    assert.strictEqual(platform.claudeExe('win32', 'x64', base), '');
  });
  test('in a packaged app the program is looked for outside the archive (app.asar.unpacked)', () => {
    const res = path.join(tmp, 'b', 'resources');
    const f = put(path.join(res, 'app.asar.unpacked'), 'claude-agent-sdk-darwin-arm64', 'claude');
    assert.strictEqual(platform.claudeExe('darwin', 'arm64', path.join(res, 'app.asar')), f);
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

test('Mac sign-in opens Terminal, clears the key and gateway variables first, and quotes a path with spaces and quotes', () => {
  const exe = '/Users/Jo "J" Smith/Agentic OS/node_modules/x/claude';
  const r = platform.loginSpawn(exe, gw.ROUTING_VARS, 'darwin');
  assert.strictEqual(r.cmd, 'osascript');
  assert.strictEqual(r.args[0], '-e');
  const m = r.args[1].match(/do script (".*")\nend tell$/s);
  assert.ok(m, r.args[1]);
  const line = JSON.parse(m[1]); // what Terminal is told to run
  assert.ok(line.startsWith('unset '), line);
  for (const v of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'AWS_BEARER_TOKEN_BEDROCK', 'CLAUDE_CODE_USE_BEDROCK']) assert.ok(line.includes(v), v);
  assert.ok(line.includes('DISABLE_AUTOUPDATER=1 "/Users/Jo \\"J\\" Smith/Agentic OS/node_modules/x/claude" /login'), line);
});

test('Windows sign-in opens a command window with those variables removed from its environment', () => {
  const r = platform.loginSpawn('C:\\app\\claude.exe', gw.ROUTING_VARS, 'win32', { PATH: 'p', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'u' });
  assert.strictEqual(r.cmd, 'cmd.exe');
  assert.ok(/\/login$/.test(r.args[3]));
  assert.strictEqual(r.options.env.ANTHROPIC_API_KEY, undefined);
  assert.strictEqual(r.options.env.ANTHROPIC_BASE_URL, undefined);
  assert.strictEqual(r.options.env.PATH, 'p');
  assert.strictEqual(r.options.env.DISABLE_AUTOUPDATER, '1');
});

test('the optional voice programs are named for the system', () => {
  assert.strictEqual(platform.piperName('win32'), 'piper.exe');
  assert.strictEqual(platform.piperName('darwin'), 'piper');
  assert.strictEqual(platform.whisperPath('/t/w', 'darwin'), path.join('/t/w', 'whisper-cli'));
  assert.strictEqual(platform.whisperPath('C:\\t\\w', 'win32'), path.join('C:\\t\\w', 'Release', 'whisper-cli.exe'));
});

test('a Mac gets an application menu named Agentic OS with copy, paste and quit; Windows gets none', () => {
  assert.strictEqual(platform.menuTemplate('win32'), null);
  const m = platform.menuTemplate('darwin');
  assert.strictEqual(m[0].label, 'Agentic OS');
  const roles = m.flatMap((x) => x.submenu.map((i) => i.role)).filter(Boolean);
  for (const r of ['quit', 'copy', 'paste', 'cut', 'selectAll', 'undo', 'minimize', 'zoom', 'hide']) assert.ok(roles.includes(r), r);
});

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exitCode = failed ? 1 : 0;

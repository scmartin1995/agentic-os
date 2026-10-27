// Checks that the model picker beside the input box keeps its size once a model is chosen. (A class named "set" once
// collided with the Settings layout and stretched it across the chat.) Runs the real window hidden, with a throwaway
// data folder and notes: no microphone, no real service, no tokens. Run: node tools/test-layout.cjs
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-layout-test-'));
const vault = path.join(tmp, 'notes'), data = path.join(tmp, 'data');
fs.mkdirSync(vault, { recursive: true }); fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(vault, 'index.md'), '# Index\n');
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ onboarded: true, userName: 'Robin' }));
const js = (name, body) => fs.writeFileSync(path.join(tmp, name), body);
const pause = 'await new Promise((r) => setTimeout(r, 300));';
js('pin.js', `(async () => { document.querySelector('.mpick-btn').click(); ${pause} const o = [...document.querySelectorAll('.mpick-opt')].find((x) => x.textContent.startsWith('Fable')); o.click(); ${pause} document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); ${pause} return 'ok'; })()`);
js('measure.js', `(() => { const b = document.querySelector('.mpick-btn'); const t = document.querySelector('.inputbar textarea'); const cs = getComputedStyle(b); return { btn: Math.round(b.getBoundingClientRect().width), text: Math.round(t.getBoundingClientRect().width), display: cs.display, pinned: b.classList.contains('pinned') }; })()`);
fs.writeFileSync(path.join(tmp, 'steps.json'), JSON.stringify([{ wait: 2000 }, { js: 'measure.js' }, { js: 'pin.js' }, { js: 'measure.js' }]));

const log = path.join(root, 'aos-debug.log');
try { fs.rmSync(log); } catch { /* none yet */ }
spawnSync(path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'), ['.', '--disable-gpu', `--capture=${path.join(tmp, 'a.png')}`], {
  cwd: root, timeout: 150000,
  env: { ...process.env, AOS_DEBUG: '1', AOS_USERDATA: data, AOS_VAULT: vault, AOS_SIZE: '1280x800', AOS_STEPS: path.join(tmp, 'steps.json') },
});
const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
const step = (n) => { const m = text.match(new RegExp(`\\[step ${n}\\] (.*)`)); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } };
const auto = step(2), pinned = step(4);

let passed = 0, failed = 0;
const check = (name, ok, extra = '') => { console.log(ok ? 'ok   ' : 'FAIL ', name, ok ? '' : extra); ok ? passed++ : failed++; };
check('the picker shows, small, before a model is chosen', !!auto && auto.btn > 30 && auto.btn < 120, JSON.stringify(auto));
check('after choosing a model it stays small and inline', !!pinned && pinned.pinned && pinned.btn < 120 && pinned.display !== 'grid', JSON.stringify(pinned));
check('the question box keeps its room', !!pinned && pinned.text > 100, JSON.stringify(pinned));
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
try { fs.rmSync(log, { force: true }); if (process.env.KEEP) console.log(text.slice(-1500)); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder */ }
process.exit(failed ? 1 : 0);

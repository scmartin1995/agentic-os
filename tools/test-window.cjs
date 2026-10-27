// Checks the title-bar window buttons for both layouts (Windows and Mac) in a hidden window: where they sit, that maximise
// toggles to restore and back, that minimise minimises, and that close closes the window. A throwaway data folder and
// throwaway notes; no microphone, no real service, no tokens.
// Run:  node tools\test-window.cjs
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-window-test-'));
const vault = path.join(tmp, 'notes'), data = path.join(tmp, 'data');
fs.mkdirSync(vault, { recursive: true }); fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(vault, 'index.md'), '# Index\n');
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ onboarded: true, userName: 'Robin' }));
const js = (name, body) => fs.writeFileSync(path.join(tmp, name), body);
const click = (label) => `(async () => { const b = document.querySelector('.win-btns [aria-label="${label}"]'); if (!b) return { found: false }; b.click(); await new Promise((r) => setTimeout(r, 600)); return { found: true, state: await window.aos.window.state() }; })()`;
// Where the buttons sit, measured on screen: Windows at the right end of the title bar, Mac at the top left (look B puts
// the Mac dots at the top of the side list, which is the window's top-left corner).
js('layout.js', `(() => { const gs = document.querySelectorAll('.win-btns'); const g = gs[0]; const r = g.getBoundingClientRect(); return { count: gs.length, order: [...g.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')), first: r.left < 40 && r.top < 40, last: r.right >= window.innerWidth - 2 && r.top < 10, mac: g.classList.contains('mac') }; })()`);
js('max.js', click('Maximise window'));
js('restore.js', click('Restore window'));
js('min.js', click('Minimise window'));
js('close.js', click('Close window'));
fs.writeFileSync(path.join(tmp, 'steps.json'), JSON.stringify([{ wait: 1500 }, { js: 'layout.js' }, { js: 'max.js' }, { js: 'restore.js' }, { js: 'min.js' }, { js: 'close.js' }]));

const log = path.join(root, 'aos-debug.log');
const electron = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
function run(fakeOs) {
  try { fs.rmSync(log); } catch { /* none yet */ }
  const png = path.join(tmp, `${fakeOs}.png`);
  const r = spawnSync(electron, ['.', '--disable-gpu', `--capture=${png}`], {
    cwd: root, encoding: 'utf8', shell: process.platform === 'win32', timeout: 150000,
    env: { ...process.env, AOS_DEBUG: '1', AOS_USERDATA: data, AOS_VAULT: vault, AOS_SIZE: '1280x800', AOS_STEPS: path.join(tmp, 'steps.json'), AOS_FAKE_OS: fakeOs },
  });
  const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const step = (n) => { const m = text.match(new RegExp(`\\[step ${n}\\] (.*)`)); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } };
  return { step, closed: !fs.existsSync(png), exited: r.status === 0 && !r.error };
}

let passed = 0, failed = 0;
const check = (name, ok, extra = '') => { console.log(ok ? 'ok   ' : 'FAIL ', name, ok ? '' : extra); ok ? passed++ : failed++; };
for (const [fake, order] of [['win', ['Minimise window', 'Maximise window', 'Close window']], ['mac', ['Close window', 'Minimise window', 'Maximise window']]]) {
  const r = run(fake), lay = r.step(2), mx = r.step(3), rs = r.step(4), mn = r.step(5), cl = r.step(6);
  const label = fake === 'win' ? 'Windows' : 'Mac';
  check(`${label}: three buttons in the right order, ${fake === 'win' ? 'at the right end of the title bar' : 'at the top left of the window'}`, !!lay && lay.count === 1 && JSON.stringify(lay.order) === JSON.stringify(order) && (fake === 'win' ? lay.last && !lay.first : lay.first && !lay.last) && lay.mac === (fake === 'mac'), JSON.stringify(lay));
  check(`${label}: maximise maximises, and the same button then restores`, !!(mx && rs) && mx.found && mx.state.max === true && rs.found && rs.state.max === false, JSON.stringify([mx, rs]));
  check(`${label}: minimise minimises`, !!mn && mn.found && mn.state.min === true, JSON.stringify(mn));
  check(`${label}: close closes the window and the app ends`, cl === null && r.closed && r.exited, JSON.stringify({ cl, closed: r.closed, exited: r.exited })); // the window is gone before the click can report back, and the app ends cleanly without taking its screenshot
}
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
try { fs.rmSync(log, { force: true }); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder */ }
process.exit(failed ? 1 : 0);

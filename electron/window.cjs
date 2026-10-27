// Lets Agentic OS move its own window: full screen, maximise, snap left/right, hop monitors.
// Exposed to Claude as the in-process MCP tool mcp__aos__window (see claude.cjs).
const { screen } = require('electron');

let getWin = () => null;
function attach(fn) { getWin = fn; }

const ACTIONS = ['fullscreen', 'exit_fullscreen', 'maximize', 'restore', 'minimize', 'left', 'right', 'center', 'next_monitor'];

// Leave full screen / maximised first so setBounds actually takes.
function unstick(win) {
  if (win.isFullScreen()) win.setFullScreen(false);
  if (win.isMaximized()) win.unmaximize();
  if (win.isMinimized()) win.restore();
}

function snap(win, area, side) {
  const w = side === 'center' ? Math.round(area.width * 0.7) : Math.floor(area.width / 2);
  const h = side === 'center' ? Math.round(area.height * 0.8) : area.height;
  const x = side === 'left' ? area.x : side === 'right' ? area.x + area.width - w : area.x + Math.round((area.width - w) / 2);
  const y = side === 'center' ? area.y + Math.round((area.height - h) / 2) : area.y;
  win.setBounds({ x, y, width: w, height: h });
}

function control(action) {
  const win = getWin();
  if (!win || win.isDestroyed()) return 'No window to move.';
  const display = screen.getDisplayMatching(win.getBounds());
  switch (action) {
    case 'fullscreen': win.setFullScreen(true); break;
    case 'exit_fullscreen': win.setFullScreen(false); break;
    case 'maximize': if (win.isFullScreen()) win.setFullScreen(false); win.maximize(); break;
    case 'restore': unstick(win); break;
    case 'minimize': win.minimize(); break;
    case 'left': case 'right': case 'center': unstick(win); snap(win, display.workArea, action); break;
    case 'next_monitor': {
      const all = screen.getAllDisplays();
      if (all.length < 2) return 'Only one monitor connected.';
      const next = all[(all.findIndex((d) => d.id === display.id) + 1) % all.length];
      const wasFull = win.isFullScreen();
      unstick(win);
      snap(win, next.workArea, 'center');
      if (wasFull) win.setFullScreen(true);
      break;
    }
    default: return `Unknown action. Use one of: ${ACTIONS.join(', ')}.`;
  }
  win.focus();
  return `Done: ${action}.`;
}

module.exports = { ACTIONS, attach, control };

// What differs between Windows and a Mac (Linux is not supported): which engine program to run, how the Claude sign-in window is
// opened, what the voice programs are called, and what the application menu holds. Everything takes the platform as an
// argument so the Mac answers can be checked on a Windows PC (tools/test-platform.cjs).
const fs = require('fs');
const path = require('path');

const normal = (p) => (p === 'win32' || p === 'darwin' ? p : 'linux');

// The folder of the Claude Code program that npm installs for this computer (one per system and chip).
function enginePackage(plat = process.platform, arch = process.arch) {
  return `claude-agent-sdk-${normal(plat)}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
}
const engineFile = (plat = process.platform) => (normal(plat) === 'win32' ? 'claude.exe' : 'claude');

// Full path of the Claude Code program, or '' when it is not there. In a packaged app the program sits outside the archive
// (app.asar.unpacked), because a program inside an archive cannot be run.
function claudeExe(plat = process.platform, arch = process.arch, base = path.join(__dirname, '..')) {
  const dir = path.join(base, 'node_modules', '@anthropic-ai', enginePackage(plat, arch)).replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
  const file = path.join(dir, engineFile(plat));
  try { return fs.existsSync(file) ? file : ''; } catch { return ''; }
}

// The settings that decide where Claude Code connects. The sign-in must not see them, or it signs in to a key or gateway
// instead of the Claude account.
const quote = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
// How to open Claude Code's own sign-in in a normal terminal window. Returns { cmd, args, options } for child_process.spawn.
function loginSpawn(exe, routingVars, plat = process.platform, env = process.env) {
  if (normal(plat) === 'darwin') {
    // Terminal does not inherit this app's environment, so the unsetting is part of the command it is told to run.
    const line = `unset ${routingVars.join(' ')}; DISABLE_AUTOUPDATER=1 ${quote(exe)} /login`;
    const script = `tell application "Terminal"\n  activate\n  do script ${JSON.stringify(line)}\nend tell`;
    return { cmd: 'osascript', args: ['-e', script], options: { detached: true, stdio: 'ignore' } };
  }
  const clean = { ...env };
  for (const v of routingVars) delete clean[v];
  clean.DISABLE_AUTOUPDATER = '1'; // it must never replace itself while Agentic OS uses it
  return { cmd: 'cmd.exe', args: ['/d', '/s', '/c', `start "Sign in for Agentic OS" cmd /k "${exe}" /login`], options: { detached: true, stdio: 'ignore', env: clean, windowsVerbatimArguments: true } };
}

// The optional voice programs (not shipped; added to the assistant's own tools folder by whoever wants voice).
const piperName = (plat = process.platform) => (normal(plat) === 'win32' ? 'piper.exe' : 'piper');
const whisperPath = (dir, plat = process.platform) => (normal(plat) === 'win32' ? path.join(dir, 'Release', 'whisper-cli.exe') : path.join(dir, 'whisper-cli'));

// The application menu. A Mac shows one at the top of the screen whatever the window does, and Cmd+C, Cmd+V and Cmd+Q come from
// it, so it is set explicitly (named Agentic OS). Windows and Linux have none: the window has no menu bar.
function menuTemplate(plat = process.platform, appName = 'Agentic OS') {
  if (normal(plat) !== 'darwin') return null;
  return [
    { label: appName, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
  ];
}

module.exports = { enginePackage, engineFile, claudeExe, loginSpawn, piperName, whisperPath, menuTemplate };

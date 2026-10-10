// Decides, for each action the assistant wants to take, whether they can just do it or must ask the user first.
// the user's rules: 2026-10-03 "the assistant can do everything unless there is a hard irreversible change";
// narrowed 2026-10-04 to "only things that are truly catastrophic and could not be recovered".
// Edits, deletes and overwrites are made recoverable by backing the old version up first (backup(),
// backupAny()), so they only ask when a backup isn't possible. This runs in the app, outside the model,
// so a persona change can't talk its way past it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const short = (cmd) => (cmd.length > 140 ? cmd.slice(0, 140) + '…' : cmd);

// Places where even a backed-up edit is too dangerous (the system itself).
const SYSTEM_PATH = /^[a-z]:[\\/](windows|program files( \(x86\))?|programdata)([\\/]|$)/i;

// Only these ask, because they are catastrophic and can't be brought back. Each entry: pattern, plain-words reason.
// Not on the list on purpose (the user 2026-10-04): plain deletes and > overwrites (backed up instead, see
// deleteCheck / redirectTargets), uninstalling, shutting down, closing programs, force-copying, plain
// git push, rebase/amend/branch -D (git's reflog brings those back) and ordinary settings tweaks.
const CATASTROPHIC = [
  // the format command itself ("format D:", "format.com /q"), not Format-Table, -Format or .format(
  [/(?<![\w.-])format(?:\.com)?(?![\w-])(?=\s+(?:[a-z]:|\/))|Format-Volume|diskpart|\bmkfs|bcdedit/i, 'format a drive or change how Windows boots'],
  [/git\s+push\s.*(--force(?!-with-lease)\b|\s-f\b)|git\s+reset\s+--hard|git\s+clean|git\s+checkout\s+--|git\s+restore\b(?!.*--staged)/i, 'throw away git work that can not be brought back'],
  [/\breg\s+delete|\bnet\s+user|\bsc\s+delete|schtasks\s+\/delete/i, 'delete registry entries, services or accounts'],
  [/\bcurl(?:\.exe)?\s.*(-X\s*(POST|PUT|DELETE|PATCH)|--data|-d\s|-F\s|--upload-file|-T\s)|(?:Invoke-(?:WebRequest|RestMethod)|\b(?:iwr|irm))\s.*(?:-Method\s+(?:Post|Put|Delete|Patch)|-Body\b)|Send-MailMessage|\bscp\b|\bsftp\b|\bftp\b/i, 'send data off this PC'],
  [/npm\s+publish|gh\s+(pr\s+merge|repo\s+delete|release\s+delete)|gh\s+api\s.*-X\s*DELETE/i, 'publish or delete something online'],
];

// Deletes are allowed when the files can be backed up first, so the user can get them back for 30 days.
// Anything wide, huge, outside their own folders, or too tangled to read for certain still asks.
const DELETE = /\brm\b|\bdel\b|\berase\b|\brmdir\b|\brd\b|Remove-Item|Clear-Content|Clear-RecycleBin|\bunlink\b/i;
const DELETE_VERB = /^(rm|del|erase|rmdir|rd|ri|Remove-Item)$/i;
const REGENERATED = new Set(['node_modules', 'dist', '.cache', '__pycache__', '.next', '.vite', '.turbo', 'coverage']); // rebuilt by a command, not worth backing up
const BACKUP_CAP = 300 * 1024 * 1024; // bytes; bigger than this can't be backed up, so it asks
const BACKUP_FILES = 20000;

// Git Bash writes C:\x as /c/x. Returns an absolute Windows path, or null for relative or unclear ones
// (relative paths depend on a "cd" earlier in the shell, so they can't be trusted).
function absWin(p) {
  p = String(p || '');
  const g = p.match(/^\/([a-zA-Z])\/(.*)$/);
  if (g) p = `${g[1].toUpperCase()}:/${g[2]}`;
  return /^[a-zA-Z]:[\\/]/.test(p) ? path.resolve(p) : null;
}

// Total size of a file or folder, giving up (Infinity) when it is over the cap, too many files, or has a link in it.
function treeSize(p) {
  let size = 0, files = 0;
  (function walk(f) {
    if (size > BACKUP_CAP || files > BACKUP_FILES) return;
    const st = fs.lstatSync(f);
    if (st.isSymbolicLink()) { size = Infinity; return; }
    if (st.isDirectory()) { for (const e of fs.readdirSync(f)) walk(path.join(f, e)); }
    else { size += st.size; files++; }
  })(p);
  return size > BACKUP_CAP || files > BACKUP_FILES ? Infinity : size;
}

const within = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// A delete command is safe to run unasked only when it is one plain delete of absolute paths in their own
// folders that we can copy to the backup folder first. Returns { ok, backups } or { ok: false, why }.
function deleteCheck(cmd) {
  const no = (why) => ({ ok: false, why: `delete files I can't back up first (${why})` });
  if (/[|;&`$%*?<>(){},~\r\n]/.test(cmd)) return no('too complicated to check');
  const toks = [...cmd.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]));
  if (!DELETE_VERB.test(toks[0] || '')) return no('too complicated to check');
  const targets = [];
  for (const t of toks.slice(1)) {
    if (/^-(Include|Exclude|Filter|Stream|Credential)/i.test(t)) return no('filters are too complicated to check');
    if (t === '--' || t.startsWith('-') || /^\/[a-z]$/i.test(t)) continue; // flags: -rf, -Recurse, /s, /q
    const abs = absWin(t);
    if (!abs) return no('a path that is not a full path');
    targets.push(abs);
  }
  if (!targets.length) return no('no path to check');
  const home = os.homedir();
  let vaultRoot = '';
  try { vaultRoot = require('./vault.cjs').ROOT; } catch { /* no vault, nothing extra to protect */ }
  const backups = [];
  for (const abs of targets) {
    const rel = path.relative(home, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return no('outside your own folders');
    if (vaultRoot && within(vaultRoot, abs)) return no('that is the whole wiki or a folder holding it');
    if (within(abs, backupDir())) return no('that is the backup folder');
    let st = null;
    try { st = fs.lstatSync(abs); } catch { continue; } // not there, so the delete changes nothing
    if (st.isSymbolicLink()) return no('it is a link to somewhere else');
    const depth = rel.split(path.sep).length;
    if (depth < (st.isDirectory() ? 3 : 2)) return no('that is a whole top-level folder');
    if (REGENERATED.has(path.basename(abs).toLowerCase())) continue;
    if (!isFinite(treeSize(abs))) return no('too big or too many files');
    backups.push(abs);
  }
  return { ok: true, backups };
}

// Files that "> file" would overwrite, so check() can back them up first. Appends (>>) and redirects to
// nowhere are ignored; targets that depend on a variable are skipped (can't be known).
function redirectTargets(cmd) {
  const out = [];
  for (const m of String(cmd).matchAll(/(?:^|[^>&0-9<])>(?!>)\s*(?:"([^"]+)"|'([^']+)'|([^\s|;&<>]+))/g)) {
    const t = m[1] || m[2] || m[3] || '';
    if (/[$%]|^\$null$|^nul$|^\/dev\//i.test(t)) continue;
    const abs = absWin(t);
    if (abs) { try { if (fs.statSync(abs).isFile()) out.push(abs); } catch { /* new file, nothing to lose */ } }
  }
  return out;
}

// Claude in Chrome runs in the user's real, signed-in browser, so a click can send a trade, a waiver claim,
// a message or a payment. Looking, scrolling and opening pages run unasked; anything that clicks, types,
// fills a form, runs page script or uploads asks first (the user 2026-10-07). One yes covers the rest of
// that question (the user 2026-10-10); claude.cjs canUseTool remembers it in S.chromeOk.
const BROWSER_ACTS = new Set(['form_input', 'javascript_tool', 'file_upload', 'upload_image', 'shortcuts_execute', 'browser_batch']);
const COMPUTER_LOOKS = new Set(['screenshot', 'scroll', 'scroll_to', 'zoom', 'wait', 'hover', 'mouse_move']);
function browser(name, input) {
  const act = name === 'computer' ? String(input.action || '') : '';
  if (BROWSER_ACTS.has(name) || (name === 'computer' && !COMPUTER_LOOKS.has(act))) {
    const what = name === 'computer' ? `${act.replace(/_/g, ' ')}${input.text ? ` "${short(String(input.text))}"` : ''}` : name.replace(/_/g, ' ');
    return { ask: true, summary: `act in your Chrome (${what}) - this could change something on a website; a yes covers the rest of this question`, spoken: 'click or type in your Chrome' };
  }
  return { ask: false, summary: `look in your Chrome (${name.replace(/_/g, ' ')})` };
}

function check(tool, input) {
  input = input || {};
  switch (tool) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const p = String(input.file_path || input.notebook_path || '');
      if (SYSTEM_PATH.test(p)) return { ask: true, risky: true, summary: `change a Windows system file: ${p}`, spoken: 'change a Windows system file' };
      return { ask: false, summary: `edit ${p} (old version backed up)` };
    }
    case 'Bash':
    case 'PowerShell': {
      const cmd = String(input.command || '').trim();
      for (const [re, why] of CATASTROPHIC) {
        if (re.test(cmd)) return { ask: true, risky: true, summary: `${why}: ${short(cmd)}`, spoken: why };
      }
      const backups = [];
      if (DELETE.test(cmd)) {
        let v;
        try { v = deleteCheck(cmd); } catch { v = { ok: false, why: "delete files I can't back up first (could not read them)" }; }
        if (!v.ok) return { ask: true, risky: true, summary: `${v.why}: ${short(cmd)}`, spoken: v.why };
        backups.push(...v.backups);
      }
      try { backups.push(...redirectTargets(cmd)); } catch { /* best effort */ }
      return { ask: false, summary: `run: ${short(cmd)}`, backups }; // the caller copies `backups` away before the command runs
    }
    default:
      if (tool.startsWith('mcp__claude-in-chrome__')) return browser(tool.slice('mcp__claude-in-chrome__'.length), input);
      return { ask: false, summary: `use ${tool}` };
  }
}

// Before the assistant changes a file, keep the old version so the change can be undone.
// Backups live outside the workspace (so they don't clutter the graph), one folder per day.
function backupDir() { return process.env.AOS_BACKUP_DIR || path.join(app.getPath('userData'), 'backups'); } // env var: tests only

// Copy a file or a whole folder to the backup folder (30 days). Returns where it went, or null if there was
// nothing there or the copy failed. Used before a delete or an overwrite by command.
function backupAny(p) {
  try {
    if (!p || !fs.existsSync(p)) return null;
    if (!fs.statSync(p).isDirectory()) return backup(p);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = path.resolve(p).replace(/^([a-z]):/i, '$1').split(/[\\/]+/).join('__');
    const dest = path.join(backupDir(), stamp.slice(0, 10), `${stamp}__${safe}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(p, dest, { recursive: true });
    return dest;
  } catch { return null; }
}

function backup(file) {
  try {
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const day = stamp.slice(0, 10);
    const safe = path.resolve(file).replace(/^([a-z]):/i, '$1').split(/[\\/]+/).join('__');
    const dest = path.join(backupDir(), day, `${stamp}__${safe}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    return dest;
  } catch { return null; }
}

// Keep 30 days of backups.
function pruneBackups(days = 30) {
  try {
    const cutoff = Date.now() - days * 864e5;
    for (const d of fs.readdirSync(backupDir())) {
      const t = Date.parse(d);
      if (!isNaN(t) && t < cutoff) fs.rmSync(path.join(backupDir(), d), { recursive: true, force: true });
    }
  } catch { /* nothing to prune */ }
}

module.exports = { check, backup, backupAny, backupDir, pruneBackups };

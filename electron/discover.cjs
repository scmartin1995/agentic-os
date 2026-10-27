// "Agentic OS discover": a read-only look at a folder, so Agentic OS can say what it found before it asks anything.
// No AI, no network, no tokens, and nothing is written. Symlinks are not followed.
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', '.trash', 'dist', 'build', '__pycache__', '.venv', 'venv', '.idea', '.vscode']);
const MD = new Set(['.md', '.markdown']);
const TEXT = new Set(['.txt', '.csv', '.json', '.yml', '.yaml', '.xml', '.toml', '.ini', '.log', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.py', '.css', '.sql', '.sh', '.ps1', '.bat']);
const HTML = new Set(['.html', '.htm']);
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);
const OFFICE = new Set(['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods', '.odp', '.rtf', '.msg', '.eml']);
// Names that usually mean a password, a key or a login. A guess from the name only; nothing is opened.
const SECRET = /(^|[\\/._ -])(\.env|id_rsa|id_ed25519|credentials?|secrets?|passwords?|private[-_ ]?key|api[-_ ]?keys?)([\\/._ -]|$)|\.(pem|pfx|p12|key|kdbx)$/i;

const MAX_FILES = 50000;
const MAX_MS = 8000;
const BIG = 25 * 1024 * 1024;
const HEADER_SAMPLE = 600; // notes whose first lines are read to look for a header (each read can pull a cloud file down, so not every note)
// Folders kept by a sync service (OneDrive, Dropbox, Google Drive, iCloud, Box). Opening a file there can make the service
// download it, and one that cannot be fetched blocks the read for good, so Agentic OS looks at names and sizes only.
const CLOUD = /[\\/](OneDrive[^\\/]*|Dropbox[^\\/]*|Google ?Drive[^\\/]*|iCloud ?Drive[^\\/]*|Box( Sync)?)([\\/]|$)/i;
const HARD_LIMIT_MS = 15000; // the screen is never kept waiting longer than this, whatever the folder does

function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (MD.has(ext)) return 'notes';
  if (TEXT.has(ext)) return 'text';
  if (HTML.has(ext)) return 'web';
  if (ext === '.pdf') return 'pdf';
  if (IMAGE.has(ext)) return 'images';
  if (OFFICE.has(ext)) return 'office';
  return 'other';
}

function hasHeader(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    const head = buf.toString('utf8', 0, n);
    return /^---\r?\n[\s\S]*?\r?\n---/.test(head) || /^---\r?\n(?:[\w-]+:.*\r?\n){1,}/.test(head);
  } catch { return false; } finally { if (fd != null) try { fs.closeSync(fd); } catch { /* closed */ } }
}

function blank(root) {
  return {
    root, exists: false, files: 0, folders: 0, truncated: false,
    kinds: { notes: 0, text: 0, web: 0, pdf: 0, images: 0, office: 0, other: 0 },
    notes: { count: 0, withHeader: 0, sampled: 0 },
    structure: { foldersWithNotes: 0, foldersWithIndex: 0, hasRootIndex: false, hasLog: false, hasRules: false, hasSkills: false, hasManifest: false, manifestName: null },
    obsidian: false, git: false,
    topFolders: [], big: [], secrets: [], symlinks: 0, newest: 0,
  };
}

// onProgress, when given, is called every 250 files with the running counts (the background thread passes them on).
function scan(root, onProgress) {
  const out = blank(root);
  const cloud = CLOUD.test(root);
  if (cloud) out.headersSkipped = true;
  let st;
  try { st = fs.statSync(root); } catch { return out; }
  if (!st.isDirectory()) return out;
  out.exists = true;
  const t0 = Date.now();
  const tops = new Map(); // first folder name -> { name, files, notes, newest }
  const top = (name) => { if (!tops.has(name)) tops.set(name, { name, files: 0, notes: 0, newest: 0 }); return tops.get(name); };
  let headersRead = 0;

  const rootEntries = (() => { try { return fs.readdirSync(root, { withFileTypes: true }); } catch { return null; } })();
  if (!rootEntries) { out.error = 'That folder could not be read.'; return out; }
  out.obsidian = rootEntries.some((e) => e.name === '.obsidian' && e.isDirectory());
  out.git = rootEntries.some((e) => e.name === '.git');

  function walk(dir, rel, depth) {
    if (out.truncated) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    out.folders++;
    let notesHere = 0, indexHere = false;
    for (const e of entries) {
      if (out.files >= MAX_FILES || Date.now() - t0 > MAX_MS) { out.truncated = true; break; }
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { out.symlinks++; continue; }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (depth < 12) walk(path.join(dir, e.name), relPath, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      out.files++;
      if (onProgress && out.files % 250 === 0) onProgress({ files: out.files, folders: out.folders, kinds: { ...out.kinds }, notes: out.notes.count });
      const kind = kindOf(e.name);
      out.kinds[kind]++;
      const group = top(rel ? rel.split('/')[0] : '(top level)');
      group.files++;
      let stat = null;
      try { stat = fs.statSync(path.join(dir, e.name)); } catch { /* vanished */ }
      if (stat) {
        if (stat.mtimeMs > out.newest) out.newest = stat.mtimeMs;
        if (stat.mtimeMs > group.newest) group.newest = stat.mtimeMs;
        if (stat.size > BIG && out.big.length < 10) out.big.push({ rel: relPath, mb: Math.round(stat.size / 1048576) });
      }
      if (SECRET.test(relPath) && out.secrets.length < 20) out.secrets.push(relPath);
      if (kind === 'notes') {
        notesHere++;
        out.notes.count++;
        group.notes++;
        if (/^index\.md$/i.test(e.name)) indexHere = true;
        if (!cloud && headersRead < HEADER_SAMPLE) { headersRead++; out.notes.sampled++; if (hasHeader(path.join(dir, e.name))) out.notes.withHeader++; }
      }
    }
    if (notesHere > 0) { out.structure.foldersWithNotes++; if (indexHere) out.structure.foldersWithIndex++; }
  }
  walk(root, '', 0);

  const s = out.structure;
  const has = (n) => { try { return fs.existsSync(path.join(root, n)); } catch { return false; } };
  s.hasRootIndex = has('index.md');
  s.hasLog = has('log.md');
  s.hasRules = has('agent-os/README.md');
  s.hasSkills = has('skills');
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    s.hasManifest = true; s.manifestName = typeof m.name === 'string' ? m.name : null;
  } catch { /* none, or not readable */ }

  out.topFolders = [...tops.values()].sort((a, b) => b.files - a.files).slice(0, 8);
  // One plain verdict the screen can lean on.
  const idx = s.foldersWithNotes ? s.foldersWithIndex / s.foldersWithNotes : 0;
  const hdr = out.notes.sampled ? out.notes.withHeader / out.notes.sampled : 0;
  out.verdict = out.notes.count === 0 ? 'empty' : idx >= 0.8 && (cloud || hdr >= 0.8) ? 'structured' : 'loose'; // headers unread in a cloud folder: judged on index pages alone
  out.indexCoverage = Math.round(idx * 100);
  out.headerCoverage = Math.round(hdr * 100);
  return out;
}

// What the screen gets when the scan had to be cut off: the counts so far, flagged so the screen says so and does not
// quote percentages it never measured.
function partial(root, last) {
  const o = blank(root);
  o.exists = true; o.truncated = true; o.slow = true; o.partial = true;
  if (last) { o.files = last.files; o.folders = last.folders; o.kinds = last.kinds; o.notes.count = last.notes; }
  o.verdict = o.notes.count ? 'loose' : 'empty';
  return o;
}

// The same scan on a background thread, so a big or slow folder (a network drive, a cloud folder that fetches files on
// demand) can never freeze the window, and with a hard limit even if a single read hangs. Always resolves.
function scanAsync(root, limitMs = HARD_LIMIT_MS) {
  return new Promise((resolve) => {
    let done = false, last = null, worker = null;
    const finish = (r) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { if (worker) worker.terminate(); } catch { /* already gone */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish(partial(root, last)), limitMs);
    try { worker = new Worker(__filename, { workerData: { discoverRoot: root } }); worker.unref(); } // unref: a thread stuck in a read can never keep the app from closing
    catch { return finish(scan(root)); } // no threads here: scan in place
    worker.on('message', (m) => { if (m && m.type === 'progress') last = m.data; else if (m && m.type === 'done') finish(m.data); });
    worker.on('error', () => finish(last ? partial(root, last) : { ...blank(root), error: 'That folder could not be read.' }));
    worker.on('exit', () => finish(last ? partial(root, last) : blank(root)));
  });
}

// When this file is started as the background thread, do the scan and hand the result back.
if (!isMainThread && workerData && typeof workerData.discoverRoot === 'string') {
  const r = scan(workerData.discoverRoot, (p) => parentPort.postMessage({ type: 'progress', data: p }));
  parentPort.postMessage({ type: 'done', data: r });
}

module.exports = { scan, scanAsync, kindOf, SKIP_DIRS, isCloudPath: (p) => CLOUD.test(p) };

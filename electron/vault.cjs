// Reads the workspace: file tree, link graph, file contents. Never touches anything outside the workspace root.
const fs = require('fs');
const path = require('path');

// The vault folder is chosen in onboarding (settings.cjs) and can be changed in Settings without a restart, so it
// is read through `vault.ROOT` (a live getter) everywhere. AGENTIC_OS_VAULT still overrides it, as in v1.
const DEFAULT_ROOT = path.join(require('os').homedir(), 'Documents', 'Agentic OS');
let ROOT = path.resolve(process.env.AGENTIC_OS_VAULT || DEFAULT_ROOT);
const SKIP = new Set(['.obsidian', '.git', 'node_modules', '.trash']);

const TEXT = new Set(['.md', '.txt', '.json', '.csv', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.cs', '.py', '.css', '.yml', '.yaml', '.bat', '.ps1', '.sh', '.ahk', '.xml', '.toml', '.ini', '.log']);
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

const toRel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

function resolveInside(rel) {
  const abs = path.resolve(ROOT, rel || '');
  return abs === ROOT || abs.startsWith(ROOT + path.sep) ? abs : null;
}

function kindOf(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.md') return 'md';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.csv') return 'csv';
  if (IMAGE.has(ext)) return 'image';
  if (TEXT.has(ext)) return 'text';
  return 'other';
}

function walk(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push({ name: e.name, path: toRel(abs), dir: true, children: walk(abs) });
    else out.push({ name: e.name, path: toRel(abs), dir: false, kind: kindOf(e.name) });
  }
  // folders first, then files; index/README first within files
  const rank = (n) => (n.dir ? 0 : /^(index|readme)\.md$/i.test(n.name) ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function tree() {
  return { root: ROOT, children: walk(ROOT) };
}

// One walk of the workspace. (It used to walk each folder again for every level above it.)
function listMarkdown() {
  const acc = [];
  (function each(nodes) {
    for (const n of nodes) {
      if (n.dir) each(n.children);
      else if (n.kind === 'md') acc.push(n.path);
    }
  })(walk(ROOT));
  return acc;
}

// Folders whose README.md frontmatter says `received: true`: material other people gave us, kept
// unchanged and read-only (never run or followed). The graph colours it and the Projects panel groups it,
// so it can be archived later by moving that one folder.
function receivedRoots(files = listMarkdown()) {
  return files
    .filter((f) => /(^|\/)readme\.md$/i.test(f) && noteLinks(f)?.received)
    .map((f) => ({ dir: path.posix.dirname(f) + '/', readme: f }));
}
const isUnder = (roots, rel) => roots.some((r) => rel.startsWith(r.dir));

// What each note links to (and whether it is a `received: true` README), kept until the note's size or modified
// time changes. The graph is rebuilt on every vault change; reading all the notes again each time took over
// half a second and held up everything else the app was doing. Now only the notes that changed are read.
const linkCache = new Map(); // note path -> { mtime, size, md, wiki, received }
function noteLinks(rel) {
  const abs = path.join(ROOT, rel);
  let st;
  try { st = fs.statSync(abs); } catch { linkCache.delete(rel); return null; }
  const c = linkCache.get(rel);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) return c;
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  const md = [], wiki = [];
  for (const m of text.matchAll(/\]\(([^)\s#]+?)(?:#[^)]*)?\)/g)) {
    let target = m[1];
    if (/^[a-z]+:/i.test(target)) continue;
    try { target = decodeURIComponent(target); } catch {}
    md.push(target);
  }
  for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) wiki.push(path.posix.basename(m[1].trim()).toLowerCase());
  const n = { mtime: st.mtimeMs, size: st.size, md, wiki, received: /(^|\/)readme\.md$/i.test(rel) && frontmatter(text).received === 'true' };
  linkCache.set(rel, n);
  return n;
}

// Links: relative markdown links [x](a/b.md#h) and Obsidian [[wikilinks]] (matched by file name).
function graph() {
  const files = listMarkdown();
  const received = receivedRoots(files);
  const set = new Set(files);
  const byName = new Map();
  for (const f of files) byName.set(path.posix.basename(f, '.md').toLowerCase(), f);
  const links = [];
  const seen = new Set();
  const add = (a, b) => {
    if (a === b || !set.has(b)) return;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!seen.has(k)) { seen.add(k); links.push({ source: a, target: b }); }
  };
  for (const f of files) {
    const note = noteLinks(f);
    if (!note) continue;
    const base = path.posix.dirname(f);
    for (const target of note.md) {
      let rel = path.posix.normalize(path.posix.join(base, target));
      if (rel.endsWith('/')) rel += 'README.md';
      if (!rel.endsWith('.md') && set.has(rel + '/README.md')) rel += '/README.md';
      add(f, rel);
    }
    for (const name of note.wiki) {
      const hit = byName.get(name);
      if (hit) add(f, hit);
    }
  }
  for (const k of linkCache.keys()) if (!set.has(k)) linkCache.delete(k); // notes that are gone
  const nodes = files.map((id) => ({ id, name: path.posix.basename(id, '.md'), group: id.split('/')[0], ...(isUnder(received, id) ? { received: true } : {}) }));
  return { nodes, links };
}

function read(rel) {
  const abs = resolveInside(rel);
  if (!abs || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return { error: 'not found' };
  const kind = kindOf(rel);
  const size = fs.statSync(abs).size;
  if (kind === 'md' || kind === 'text' || kind === 'csv' || kind === 'html') {
    if (size > 2_000_000) return { kind: 'other', path: rel, size, note: 'too large to preview' };
    return { kind, path: rel, size, text: fs.readFileSync(abs, 'utf8') };
  }
  return { kind, path: rel, size };
}

function info() {
  return { root: ROOT, exists: fs.existsSync(ROOT), notes: fs.existsSync(ROOT) ? listMarkdown().length : 0 };
}

// --- Menu tools: Skills list and Projects list ---

// Just the simple `key: value` and `key: [a, b]` lines of a note's frontmatter.
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*?)\s*(#.*)?$/);
    if (!kv) continue;
    const v = kv[2];
    out[kv[1]] = /^\[.*\]$/.test(v) ? v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean) : v.replace(/^["']|["']$/g, '');
  }
  return out;
}
const readText = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } };

// Every skill in skills/<name>/SKILL.md, grouped the way skills/index.md groups them.
function skills() {
  const dir = path.join(ROOT, 'skills');
  if (!fs.existsSync(dir)) return { groups: [] };
  const group = new Map(); // skill folder -> section heading in the index
  let heading = 'Skills';
  for (const line of readText('skills/index.md').split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+)/);
    if (h) { heading = h[1].trim(); continue; }
    for (const m of line.matchAll(/\]\(([^)/]+)\/SKILL\.md\)/g)) if (!group.has(m[1])) group.set(m[1], heading); // first listing wins
  }
  const list = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const rel = `skills/${e.name}/SKILL.md`;
    const text = readText(rel);
    if (!text) continue;
    const fm = frontmatter(text);
    list.push({ name: fm.name || e.name, title: fm.title || e.name, description: fm.description || '', tags: Array.isArray(fm.tags) ? fm.tags : [], pinned: fm.pinned === 'true', path: rel, group: group.get(e.name) || 'Skills' });
  }
  const order = [...new Set([...group.values(), 'Skills'])];
  const groups = order.map((g) => ({ name: g, skills: list.filter((s) => s.group === g).sort((a, b) => a.name.localeCompare(b.name)) })).filter((g) => g.skills.length);
  return { groups };
}

// Each folder in projects/: what it is, its status line, web links (designs, canvases), and its files by kind.
function projects() {
  const dir = path.join(ROOT, 'projects');
  if (!fs.existsSync(dir)) return [];
  const all = (n, acc = []) => { for (const c of n.children || []) { if (c.dir) all(c, acc); else acc.push(c); } return acc; };
  const received = receivedRoots();
  const out = [];
  for (const p of walk(dir)) {
    if (!p.dir) continue;
    const everything = all(p);
    // received material gets its own section, so the project's own files stay easy to find
    const files = everything.filter((f) => !isUnder(received, f.path));
    const got = everything.filter((f) => isUnder(received, f.path));
    const readmeRel = files.find((f) => f.path === `${p.path}/README.md`)?.path || files.find((f) => /readme\.md$/i.test(f.name))?.path || null;
    const text = readmeRel ? readText(readmeRel) : '';
    const fm = frontmatter(text);
    const status = (text.match(/^\*\*Status:\*\*\s*(.+)$/m) || [])[1] || '';
    const links = [];
    for (const m of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
      if (!links.some((l) => l.url === m[2])) links.push({ label: m[1], url: m[2] });
    }
    const item = (f) => ({ name: f.name, path: f.path, kind: f.kind, sub: path.posix.relative(p.path, path.posix.dirname(f.path)) });
    const isOutput = (f) => /(^|\/)output\//.test(f.path.slice(p.path.length));
    const notes = files.filter((f) => f.kind === 'md' && f.path !== readmeRel);
    let modified = 0; // newest file edit in the project, so the list can put recent work first
    for (const f of everything) { try { modified = Math.max(modified, fs.statSync(path.join(ROOT, f.path)).mtimeMs); } catch { /* gone */ } }
    out.push({
      modified,
      folder: p.name,
      path: p.path,
      title: (fm.title || p.name.replace(/_/g, ' ')).replace(/\s+-\s+Project Home$/i, ''),
      description: fm.description || '',
      status: status.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').trim(),
      readme: readmeRel,
      links: links.slice(0, 6),
      summaries: notes.filter(isOutput).map(item),
      notes: notes.filter((f) => !isOutput(f)).map(item),
      designs: files.filter((f) => f.kind === 'image' || f.kind === 'html' || f.kind === 'pdf').map(item),
      other: files.filter((f) => f.kind !== 'md' && f.kind !== 'image' && f.kind !== 'html' && f.kind !== 'pdf').map(item),
      received: got.map(item),
      receivedReadmes: received.filter((r) => r.dir.startsWith(p.path + '/')).map((r) => r.readme),
    });
  }
  return out.sort((a, b) => b.modified - a.modified);
}

let watcher = null;
// Windows reports a 'change' when it lazily writes a file's last-access time to disk, which can
// be up to an hour after something merely read it. So a 'change' only counts if the file's
// modified time moved past what we last saw (or past when watching began).
const seenMtime = new Map();
let watchStarted = 0;
function reallyChanged(event, rel) {
  if (event === 'rename') return true; // created, deleted or renamed
  let m;
  try { m = fs.statSync(path.join(ROOT, rel)).mtimeMs; } catch { return true; }
  const before = seenMtime.get(rel) ?? watchStarted;
  seenMtime.set(rel, m);
  return m > before;
}

let onChangeSaved = null;
function watch(onChange) {
  onChangeSaved = onChange;
  if (watcher || !fs.existsSync(ROOT)) return;
  let t = null;
  const changed = new Set();
  watchStarted = Date.now();
  try {
    watcher = fs.watch(ROOT, { recursive: true }, (e, file) => {
      if (!file || file.split(/[\\/]/).some((p) => p.startsWith('.'))) return;
      const rel = file.split(/[\\/]/).join('/');
      if (!reallyChanged(e, rel)) return;
      changed.add(rel);
      clearTimeout(t);
      t = setTimeout(() => { const files = [...changed]; changed.clear(); onChange(files); }, 600);
    });
  } catch (e) { require('./store.cjs').log('could not watch the notes folder; edits made elsewhere will not show until restart:', e); }
}

// Point the app at another vault folder: the watcher moves with it.
function setRoot(p) {
  const next = path.resolve(String(p || DEFAULT_ROOT));
  if (next === ROOT) return ROOT;
  ROOT = next;
  if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
  seenMtime.clear();
  if (onChangeSaved) watch(onChangeSaved);
  return ROOT;
}

module.exports = { resolveInside, tree, graph, read, info, watch, skills, projects, setRoot, receivedRoots, DEFAULT_ROOT };
Object.defineProperty(module.exports, 'ROOT', { enumerable: true, get: () => ROOT });

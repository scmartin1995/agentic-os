// Reads the notes folder: file tree, link graph, file contents. Never touches anything outside the vault root.
const fs = require('fs');
const path = require('path');

// The vault folder is chosen in onboarding (settings.cjs) and can be changed in Settings without a restart, so it
// is read through `vault.ROOT` (a live getter) everywhere. AOS_VAULT overrides it.
const DEFAULT_ROOT = path.join(require('os').homedir(), 'Documents', 'Agentic OS Notes');
let ROOT = path.resolve(process.env.AOS_VAULT || DEFAULT_ROOT);
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

// Where projects live. With a projects/ folder (the OKF layout), each folder inside it is a project, as-is. Without
// one (a plain folder of folders, an Obsidian vault), each top-level folder is a project, apart from the assistant's own and
// the usual non-project folders below — unless that top-level folder isn't itself OKF-structured (no Client
// Facing/Raw/Records/Sessions/Tools of its own) but a direct child of it is (e.g. Acme/Platform Team): that child is
// promoted to a project in its own right, named for itself, and the parent folder is not also listed. base is '' in
// the top-level case, so a plain project's path is just its name; a promoted project's path carries the extra segment
// and its breadcrumb says so.
const NOT_PROJECTS = new Set(['skills', 'agent-os', 'logs', '_templates', 'templates', 'attachments', 'assets', 'archive', 'inbox']);
const OKF_MARKERS = ['Client Facing', 'Raw', 'Records', 'Sessions', 'Tools'];
// A folder with this file directly inside it is never promoted to its own project tile, even if it's OKF-shaped —
// it's deliberately filed under its parent and should be read as part of that project, not a separate one.
const NO_PROMOTE = '.no-project';
function okfMarkerCount(abs) {
  let n = 0;
  for (const m of OKF_MARKERS) { try { if (fs.statSync(path.join(abs, m)).isDirectory()) n++; } catch { /* missing */ } }
  return n;
}
function projectLayout() {
  let base = 'projects';
  try { if (!fs.statSync(path.join(ROOT, base)).isDirectory()) base = ''; } catch { base = ''; }
  const entries = []; // { name, rel, breadcrumb }
  try {
    const topDirs = fs.readdirSync(base ? path.join(ROOT, base) : ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !/^[._]/.test(e.name) && !SKIP.has(e.name) && (base || !NOT_PROJECTS.has(e.name.toLowerCase())));
    for (const e of topDirs) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (base) { entries.push({ name: e.name, rel, breadcrumb: e.name }); continue; } // a projects/ folder: every entry is a project, as-is
      const abs = path.join(ROOT, rel);
      if (okfMarkerCount(abs) >= 2) { entries.push({ name: e.name, rel, breadcrumb: e.name }); continue; }
      let children = [];
      try { children = fs.readdirSync(abs, { withFileTypes: true }).filter((c) => c.isDirectory() && !/^[._]/.test(c.name) && !SKIP.has(c.name)); } catch { /* unreadable */ }
      const promoted = children.filter((c) => okfMarkerCount(path.join(abs, c.name)) >= 2 && !fs.existsSync(path.join(abs, c.name, NO_PROMOTE)));
      if (promoted.length) promoted.forEach((c) => entries.push({ name: c.name, rel: `${rel}/${c.name}`, breadcrumb: `${e.name} / ${c.name}` }));
      else entries.push({ name: e.name, rel, breadcrumb: e.name });
    }
  } catch { /* the folder can't be read */ }
  return { base, entries, names: entries.map((en) => en.name) };
}
const projectPath = (name, layout = projectLayout()) => layout.entries.find((en) => en.name === name)?.rel ?? name;
// The project a note belongs to, or null — the entry whose folder contains the note.
function projectOf(rel, layout = projectLayout()) {
  for (const en of layout.entries) if (rel.startsWith(en.rel + '/')) return en.name;
  return null;
}

// One walk of the vault. (It used to walk each folder again for every level above it.)
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
  const layout = projectLayout();
  const nodes = files.map((id) => { const project = projectOf(id, layout); return { id, name: path.posix.basename(id, '.md'), group: id.split('/')[0], ...(project ? { project } : {}), ...(isUnder(received, id) ? { received: true } : {}) }; });
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

// A note's header (its title and description), kept until the note's size or modified time changes, like noteLinks does for
// its links. The Projects list is worked out again after every change in the folder, and reading every note in full to
// get at the top of each one was most of what it cost. `mtime` is the file's modified time, which the caller already has.
const headCache = new Map(); // note path -> { mtime, root, head }
function headOf(rel, mtime) {
  if (typeof mtime !== 'number') return frontmatter(readText(rel)); // modified time unknown (the file vanished mid-scan): read it, keep nothing
  const hit = headCache.get(rel);
  if (hit && hit.mtime === mtime && hit.root === ROOT) return hit.head;
  const head = frontmatter(readText(rel));
  headCache.set(rel, { mtime, root: ROOT, head });
  return head;
}

// Every skill in skills/<name>/SKILL.md, grouped the way skills/index.md groups them.
function skills() {
  const dir = path.join(ROOT, 'skills');
  if (!fs.existsSync(dir)) return { groups: [] };
  const group = new Map(); // skill folder -> section heading in the index
  let heading = 'Other';
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
    list.push({ name: fm.name || e.name, title: fm.title || e.name, description: fm.description || '', tags: Array.isArray(fm.tags) ? fm.tags : [], pinned: fm.pinned === 'true', path: rel, group: group.get(e.name) || 'Other' });
  }
  const order = [...new Set([...group.values(), 'Other'])];
  const groups = order.map((g) => ({ name: g, skills: list.filter((s) => s.group === g).sort((a, b) => a.name.localeCompare(b.name)) })).filter((g) => g.skills.length);
  return { groups };
}

// Corrections made in the Projects panel ("Not a deliverable", "Make it a deliverable"): one small file at the vault
// root, so a correction works for every kind of file (an .html dashboard has no frontmatter to carry it) and lasts.
// The dot-folder keeps it out of the tree, the map and the watcher.
const OVERRIDES = '.aos/panel-overrides.json';
const KINDS = new Set(['deliverable', 'note', 'evidence']);
function overrides() {
  try { const o = JSON.parse(fs.readFileSync(path.join(ROOT, OVERRIDES), 'utf8')); return o && o.files && typeof o.files === 'object' ? o.files : {}; } catch { return {}; }
}
function saveOverrides(files) {
  require('./fresh.cjs').drop(); // the Projects panel is worked out from these
  const file = path.join(ROOT, OVERRIDES);
  try { require('./policy.cjs').backup(file); } catch { /* best effort; writing still proceeds */ }
  const about = 'Corrections made in the Projects panel: file path -> how the panel shows it (deliverable, note or evidence). Delete a line to undo it.';
  require('./store.cjs').writeText(file, JSON.stringify({ about, files }, null, 2) + '\n');
  return { count: Object.keys(files).length };
}
// type null removes the correction, so the file goes back to wherever its folder puts it.
function setOverride(rel, type = null) {
  const abs = resolveInside(rel);
  if (!abs || abs === ROOT || !fs.existsSync(abs)) throw new Error('That file is no longer in the notes folder.');
  if (type !== null && !KINDS.has(type)) throw new Error(`Unknown kind: ${type}`);
  const files = overrides();
  if (type === null) delete files[rel]; else files[rel] = type;
  return saveOverrides(files);
}
function clearOverrides(projectRel) {
  const files = overrides();
  for (const k of Object.keys(files)) if (k.startsWith(projectRel + '/')) delete files[k];
  return saveOverrides(files);
}

const NAV = /^(index|readme|_readme)\.md$/i; // navigation pages, not work
const SCRIPT = /\.(ps1|psm1|pl|bat|cmd|sh|py|js|cjs|mjs|ts|ahk|vbs)$/i;
const SOURCE = /\.(csv|vtt|json|log|tmp)$|\.bak\./i; // material that went in, when it sits loose in a session folder
const isDash = (f) => f.kind === 'html' && /dashboard/i.test(f.name) && !/template/i.test(f.name);
const sessionDate = (n) => { const m = n.match(/^(\d{2})(\d{2})(\d{2})[_-]/); return m ? `20${m[1]}-${m[2]}-${m[3]}` : ''; };
// A web page's <title>, from its first few kilobytes, so a dashboard is named the way it names itself.
function htmlTitle(rel) {
  let fd;
  try {
    fd = fs.openSync(path.join(ROOT, rel), 'r');
    const buf = Buffer.alloc(8192);
    const m = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0)).match(/<title[^>]*>([^<]{1,200})<\/title>/i);
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', middot: '·', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
    return m ? m[1].replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : named[e.toLowerCase()] ?? all)).replace(/\s+/g, ' ').trim() : '';
  } catch { return ''; } finally { if (fd != null) try { fs.closeSync(fd); } catch { /* closed */ } }
}
const cleanName = (n) => n.replace(/\.[a-z0-9]+$/i, '').replace(/^\d{6,}[_\- ]*/, '').replace(/[_-]+/g, ' ').trim();
// A session README's first real paragraph: what the occasion was and what it produced.
function outcomeOf(text) {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const para = [];
  let skip = false; // inside a boilerplate paragraph ("Part of the … knowledge base. Entry point: …")
  for (const raw of body.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) { if (para.length) break; skip = false; continue; }
    if (skip) continue;
    if (/^[*_]?(Part of\b|This folder is part of)/i.test(l)) { if (para.length) break; skip = true; continue; }
    if (/^(#|>|\||---)/.test(l)) { if (para.length) break; continue; }
    para.push(l);
  }
  const t = para.join(' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').trim();
  return t.length > 240 ? t.slice(0, 237).trim() + '…' : t;
}

// Each project folder (see projectLayout): what it is, its status line, web links (designs, canvases), and its files
// sorted by what they are for. Deliverables are what the project hands over: Client Facing, the non-note files in a
// session's Output (or top level), a plain project's output/ folder, and any dashboard page wherever it lives. A note
// in a session's Output is a session note, not a deliverable. A folder inside Client Facing or Output is one bundle, led by its index page. Scripts and source
// material are never deliverables. Corrections from the panel (overrides()) win over all of that.
function projects() {
  const { entries } = projectLayout();
  const all = (n, acc = []) => { for (const c of n.children || []) { if (c.dir) all(c, acc); else acc.push(c); } return acc; };
  const received = receivedRoots();
  const ov = overrides();
  const out = [];
  for (const en of entries) {
    const { name, rel, breadcrumb } = en;
    const p = { name, path: rel, children: walk(path.join(ROOT, rel)) };
    const everything = all(p);
    // received material gets its own section, so the project's own files stay easy to find
    const files = everything.filter((f) => !isUnder(received, f.path));
    const got = everything.filter((f) => isUnder(received, f.path));
    // Only the project's own root README/_README counts — not the first one found anywhere in its subtree, which
    // used to surface a random nested session's _README.md as if it were the whole project's description.
    const readmeRel = files.find((f) => path.posix.dirname(f.path) === p.path && /^_?readme\.md$/i.test(f.name))?.path || null;
    const text = readmeRel ? readText(readmeRel) : '';
    const fm = frontmatter(text);
    const status = (text.match(/^\*\*Status:\*\*\s*(.+)$/m) || [])[1] || '';
    const links = [];
    for (const m of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
      if (!links.some((l) => l.url === m[2])) links.push({ label: m[1], url: m[2] });
    }
    // modified on every file, so the Projects panel can order any list newest or oldest first (mtime is filled below,
    // before item() is first called)
    const item = (f) => ({ name: f.name, path: f.path, kind: f.kind, sub: path.posix.relative(p.path, path.posix.dirname(f.path)), modified: mtime.get(f.path) || 0, created: born.get(f.path) || 0 });
    let modified = 0; // newest file edit in the project, so the list can put recent work first
    const mtime = new Map(), born = new Map(); // born: when the file was created (never later than its last edit)
    for (const f of everything) { try { const st = fs.statSync(path.join(ROOT, f.path)), t = st.mtimeMs; mtime.set(f.path, t); born.set(f.path, Math.min(st.birthtimeMs || t, t)); modified = Math.max(modified, t); } catch { /* gone */ } }
    // each listed file: its header's title and description when it has one, the kind its folder gives it (auto), and
    // the kind it is shown as (type: auto, unless corrected in the panel)
    const entry = (f, auto, extra = {}) => {
      const head = f.kind === 'md' ? headOf(f.path, mtime.get(f.path)) : f.kind === 'html' ? { title: htmlTitle(f.path) } : {};
      const type = KINDS.has(ov[f.path]) ? ov[f.path] : auto;
      return { ...item(f), title: head.title || '', description: head.description || '', auto, type, ...(type !== auto ? { overridden: true } : {}), ...extra };
    };
    const deliverables = [], sessionNotes = [], records = [], working = [], search = [];
    const raw = new Map(); // "Raw / Jira" -> file count
    const sessions = new Map(); // session folder name -> { name, path, date, title, readme, outcome, output, evidence }
    const session = (n) => {
      if (!sessions.has(n)) sessions.set(n, { name: n, path: `${p.path}/Sessions/${n}`, date: sessionDate(n), title: cleanName(n), readme: null, outcome: '', output: [], evidence: [] });
      return sessions.get(n);
    };
    const bundles = new Map(); // bundle folder -> { files, session? }
    // where a listed entry goes once its type is known
    const place = (e, s) => {
      if (s) { if (e.auto === 'evidence' && e.type === 'evidence') s.evidence.push(e); else s.output.push(e); }
      if (e.type === 'deliverable') deliverables.push(e);
      else if (e.type === 'note' && s) sessionNotes.push(e);
      else if (!s) working.push(e);
      search.push(e);
    };
    for (const f of files) {
      if (f.path === readmeRel) continue;
      const segs = f.path.slice(p.path.length + 1).split('/');
      const top = segs[0];
      const inSession = top === 'Sessions' && segs.length >= 3;
      const s = inSession ? session(segs[1]) : null;
      const from = s ? (s.date ? `${s.date} · ${s.title}` : s.title) : top === 'Client Facing' ? 'Client Facing' : top === 'Records' ? 'Records' : '';
      // a folder handed over whole: one card, not one per file inside it
      const depth = top === 'Client Facing' ? 2 : inSession && segs[2].toLowerCase() === 'output' ? 4 : 0;
      if (depth && segs.length > depth) {
        const key = `${p.path}/${segs.slice(0, depth).join('/')}`;
        if (!bundles.has(key)) bundles.set(key, { files: [], s, from });
        bundles.get(key).files.push(f);
        continue;
      }
      if (inSession && segs.length === 3 && /^_?readme\.md$/i.test(f.name)) { s.readme = f.path; s.outcome = outcomeOf(readText(f.path)); continue; }
      if (NAV.test(f.name)) continue;
      if (top === 'Raw' || top === 'Tools') {
        const k = segs.length > 2 ? `${top} / ${segs[1]}` : top;
        raw.set(k, (raw.get(k) || 0) + 1);
        search.push({ ...item(f), title: '', description: '', auto: 'raw', type: 'raw' });
        continue;
      }
      // a zip beside the folder it was made from is the same bundle twice
      if (/\.zip$/i.test(f.name) && files.some((g) => g.path.startsWith(f.path.replace(/\.zip$/i, '') + '/'))) { search.push({ ...item(f), title: '', description: '', auto: 'raw', type: 'raw' }); continue; }
      let auto;
      if (SCRIPT.test(f.name)) auto = 'evidence';
      else if (/template/i.test(f.name)) auto = 'working'; // what a build fills in, not what it produced
      else if (isDash(f) || (top === 'Records' && f.kind === 'html')) auto = 'deliverable'; // a live page kept beside its record
      else if (top === 'Client Facing') auto = 'deliverable';
      else if (top === 'Records' && segs.length === 2 && f.kind === 'md') { const e = entry(f, 'record', { group: f.name.split('-')[0].toLowerCase() }); if (e.type === 'record') { records.push(e); search.push(e); } else place(e, null); continue; }
      else if (inSession) {
        const part = segs.length > 3 ? segs[2].toLowerCase() : '';
        if (part === 'output' || !part) auto = f.kind === 'md' ? 'note' : !part && SOURCE.test(f.name) ? 'evidence' : 'deliverable';
        else auto = 'evidence'; // Input/, work/ and anything else inside a session: the evidence trail
      } else if (segs.slice(0, -1).some((x) => x.toLowerCase() === 'output')) {
        // a plain project's output/ folder is what it produced, notes included; inside a Sessions folder a note is a write-up
        auto = f.kind === 'md' && segs.includes('Sessions') ? 'note' : 'deliverable';
      }
      else auto = 'working';
      const e = entry(f, auto, from ? { from } : {});
      if (e.type === 'note' && !s) { working.push(e); search.push(e); continue; } // a note outside a session is a working file
      place(e, s);
    }
    // each bundle: led by its index page (or README, or its first note), dated by its newest file
    for (const [dir, b] of bundles) {
      const lead = b.files.find((f) => path.posix.dirname(f.path) === dir && /^(index|readme|_readme)\.md$/i.test(f.name))
        || b.files.find((f) => f.kind === 'md') || b.files[0];
      const e = entry(lead, 'deliverable', { bundle: b.files.length, ...(b.from ? { from: b.from } : {}) });
      e.title = e.title || cleanName(path.posix.basename(dir));
      e.modified = Math.max(...b.files.map((f) => mtime.get(f.path) || 0));
      place(e, b.s);
      for (const f of b.files) if (f !== lead) search.push({ ...item(f), title: '', description: '', auto: 'raw', type: 'raw', from: e.title });
    }
    const newest = (a, b) => b.modified - a.modified;
    deliverables.sort(newest); sessionNotes.sort(newest); working.sort(newest);
    records.sort((a, b) => a.name.localeCompare(b.name));
    const sessionList = [...sessions.values()].filter((x) => x.readme || x.output.length || x.evidence.length).sort((a, b) => b.name.localeCompare(a.name));
    for (const x of sessionList) { x.output.sort(newest); x.evidence.sort(newest); }
    out.push({
      modified,
      folder: p.name,
      path: p.path,
      breadcrumb,
      title: (fm.title || p.name.replace(/_/g, ' ')).replace(/\s+-\s+Project Home$/i, ''),
      description: fm.description || '',
      status: status.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').trim(),
      readme: readmeRel,
      links: links.slice(0, 6),
      okf: okfMarkerCount(path.join(ROOT, p.path)) >= 2,
      deliverables,
      sessionNotes, // the write-ups in sessions' Output folders (key points, call summaries), newest first
      records,
      sessions: sessionList,
      working, // everything else of the project's own, newest first
      raw: [...raw.entries()].map(([label, count]) => ({ label, count })),
      search, // every file, for the finder and the recently edited strip
      corrections: Object.keys(ov).filter((k) => k.startsWith(p.path + '/')).length,
      designs: files.filter((f) => f.kind === 'image').map(item), // pictures, for the project's tile
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
// A change is passed on 600 ms after the last one in a burst, but never more than 3 s after the first: a steady trickle of
// edits (a sync, an agent writing files) used to push the report back each time, then fire in one go; and every report makes
// the screen ask again, so this keeps it to one every few seconds at most while keeping the quiet-moment behaviour.
const QUIET_MS = 600, LONGEST_MS = 3000;
function watch(onChange) {
  onChangeSaved = onChange;
  if (watcher || !fs.existsSync(ROOT)) return;
  let t = null, first = 0;
  const changed = new Set();
  watchStarted = Date.now();
  const fire = () => { t = null; first = 0; const files = [...changed]; changed.clear(); onChange(files); };
  try {
    watcher = fs.watch(ROOT, { recursive: true }, (e, file) => {
      if (!file || file.split(/[\\/]/).some((p) => p.startsWith('.'))) return;
      const rel = file.split(/[\\/]/).join('/');
      if (!reallyChanged(e, rel)) return;
      require('./fresh.cjs').drop(); // what was worked out about the folder is out of date from this moment
      changed.add(rel);
      const now = Date.now();
      if (!first) first = now;
      clearTimeout(t);
      t = setTimeout(fire, Math.max(0, Math.min(QUIET_MS, first + LONGEST_MS - now)));
    });
  } catch { /* watching is a nicety */ }
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

module.exports = { resolveInside, receivedRoots, listMarkdown, okfMarkerCount, tree, graph, read, info, watch, skills, projects, setOverride, clearOverrides, projectLayout, projectPath, projectOf, setRoot, DEFAULT_ROOT };
Object.defineProperty(module.exports, 'ROOT', { enumerable: true, get: () => ROOT });

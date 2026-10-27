// OKF: the simple way Agentic OS likes its notes kept, and what it does about it.
//   - every note starts with a short header (type, title, description, tags, timestamp)
//   - every folder has an index.md that lists what is in it
//   - log.md records what changed
// Agentic OS finds answers by reading the index pages first, so this is what makes it quick and cheap.
//
// Three choices (the user's, made in setup or Settings):
//   leave - existing notes are left exactly as they are; Agentic OS adds only its own folders
//   index - Agentic OS adds index pages on top and keeps what it writes in this shape. Nothing existing is edited or moved
//   tidy  - as index, and Agentic OS may suggest bringing older notes into shape, one plain sentence at a time, waiting for a yes
// Nothing here uses AI. Nothing existing is overwritten, moved or renamed: new files are created, and the two files
// that get a line added (an index page and log.md) are backed up first.
const fs = require('fs');
const path = require('path');

const MODES = ['leave', 'index', 'tidy'];
const SKIP = new Set(['.git', 'node_modules', '.obsidian', '.trash', '_archive', 'dist', 'build']);
const MAX_INDEX_ENTRIES = 200;
const MAX_INDEXES = 400;

const p2 = (n) => String(n).padStart(2, '0');
const today = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const stamp = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, 'Z');
const norm = (p) => p.split(path.sep).join('/');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const q = (s) => (/[:#\[\]{}&*!|>'"%@`]|^\s|\s$/.test(s) ? JSON.stringify(s) : s); // a YAML-safe value

function readHead(abs, n = 2500) {
  let fd;
  try { fd = fs.openSync(abs, 'r'); const b = Buffer.alloc(n); const r = fs.readSync(fd, b, 0, n, 0); return b.toString('utf8', 0, r); } catch { return ''; } finally { if (fd != null) try { fs.closeSync(fd); } catch { /* closed */ } }
}
function splitHeader(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return m ? { header: m[1], body: text.slice(m[0].length) } : { header: null, body: text };
}
function titleOf(abs) {
  const { header, body } = splitHeader(readHead(abs));
  const t = header && header.match(/^title:\s*(.+?)\s*$/m);
  if (t) return t[1].replace(/^["']|["']$/g, '');
  const h = body.match(/^#\s+(.+?)\s*$/m);
  if (h) return h[1];
  return path.basename(abs, path.extname(abs)).replace(/[-_]+/g, ' ');
}
function descriptionOf(body) {
  for (const raw of body.split(/\r?\n/)) {
    if (/^\s*#/.test(raw)) continue; // a heading is the title, not the description
    const line = raw.replace(/^[\s>*\-#\d.)]+/, '').replace(/[*_`]|\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
    if (line.length > 12 && !/^---/.test(raw)) return line.slice(0, 140);
  }
  return '';
}
function header({ type, title, description, tags, at }) {
  return `---\ntype: ${type}\ntitle: ${q(title)}\ndescription: ${q(description || title)}\ntags: [${tags.join(', ')}]\ntimestamp: ${stamp(at || new Date())}\n---\n`;
}

// The rules written into agent-os/README.md (only if the folder has none), and the standing sentence the model is given.
function rulesText(mode) {
  const common = [
    '- Start at index.md. Read a folder\'s index.md before searching it.',
    '- Say plainly when something is a guess or could not be checked.',
  ];
  const shape = [
    '- Every note you create starts with a short header: type, title, description, tags, timestamp.',
    '- Link every new note from its folder\'s index.md, with a one-line description.',
    '- Add a dated line to log.md after any change.',
    '- Use normal relative links, like [text](folder/note.md).',
  ];
  const lines = mode === 'leave'
    ? [...common, '- The owner chose to leave existing notes exactly as they are: do not move, rename or add headers to them. Ask first before writing anything new outside agent-os/.']
    : mode === 'tidy'
      ? [...common, ...shape, '- Older notes that do not follow this can be brought into shape, but only after the owner says yes to each change, described in one plain sentence. Never move or rename without a yes.']
      : [...common, ...shape, '- Existing notes keep their own shape. Only the notes you create follow the list above.'];
  return `# Rules for agents\n\n${lines.join('\n')}\n`;
}
function promptText(mode) {
  if (mode === 'index') return 'This notes folder follows a simple structure (OKF): each note starts with a short header (type, title, description, tags, timestamp), each folder has an index.md listing its pages, and log.md records changes. Follow it for every note you create. Do not change the shape of existing notes unless asked. The app quietly links and logs any new note you forget, so a miss is harmless, but doing it yourself is better.';
  if (mode === 'tidy') return 'This notes folder follows a simple structure (OKF): each note starts with a short header (type, title, description, tags, timestamp), each folder has an index.md listing its pages, and log.md records changes. Follow it for every note you create. When you meet an older note that does not follow it, you may suggest bringing it into shape: say what you would change in one plain sentence, and wait for a yes before editing, moving or renaming it. The app quietly links and logs any new note you forget.';
  return 'The owner chose to leave their existing notes exactly as they are. Do not reorganise, rename, move, or add headers to existing notes. Put anything new you write under agent-os/ unless they say where, and ask first.';
}

// ---- adding the starter content (skills and the manifest) without overwriting anything ----

function listFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), r)); else out.push(r);
  }
  return out;
}

function installStarter(root, starterDir, put) {
  const note = { manifest: 'ok', skills: 0 };
  if (!starterDir || !fs.existsSync(starterDir)) return note;
  for (const rel of listFiles(starterDir)) {
    const text = fs.readFileSync(path.join(starterDir, rel), 'utf8');
    if (rel === '.claude-plugin/plugin.json') {
      const f = path.join(root, rel);
      if (fs.existsSync(f)) {
        let name = null;
        try { name = JSON.parse(fs.readFileSync(f, 'utf8')).name; } catch { /* unreadable */ }
        note.manifest = name === 'aos' ? 'ok' : 'other';
        continue;
      }
    }
    if (put(rel, text) && /^skills\/[^/]+\/SKILL\.md$/.test(rel)) note.skills++;
  }
  return note;
}

// ---- index pages ----

function mdFiles(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /\.(md|markdown)$/i.test(e.name) && !/^index\.md$/i.test(e.name)).map((e) => e.name).sort((a, b) => a.localeCompare(b)); } catch { return []; } }
function subDirs(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && !SKIP.has(e.name)).map((e) => e.name).sort((a, b) => a.localeCompare(b)); } catch { return []; } }
const hasIndex = (dir) => { try { return fs.readdirSync(dir).some((n) => /^index\.md$/i.test(n)); } catch { return false; } };

function indexText(dir, name, files, subs, at) {
  const lines = [];
  for (const f of files.slice(0, MAX_INDEX_ENTRIES)) {
    const abs = path.join(dir, f);
    const { body } = splitHeader(readHead(abs));
    const d = descriptionOf(body);
    lines.push(`- [${titleOf(abs)}](${encodeURI(f)})${d ? ` - ${d}` : ''}`);
  }
  if (files.length > MAX_INDEX_ENTRIES) lines.push(`- ...and ${files.length - MAX_INDEX_ENTRIES} more pages in this folder`);
  const folders = subs.map((s) => `- [${s.replace(/[-_]+/g, ' ')}](${encodeURI(s)}/index.md)`);
  return header({ type: 'Index', title: name, description: `What is in ${name}.`, tags: ['index'], at })
    + `\n# ${name}\n\nA list of what is in this folder. Added by Agentic OS so notes can be found quickly; edit it freely.\n`
    + (lines.length ? `\n## Pages\n\n${lines.join('\n')}\n` : '') + (folders.length ? `\n## Folders\n\n${folders.join('\n')}\n` : '');
}

// Adds an index.md to every folder that holds notes (or folders with notes) and has none. Existing files are never touched.
function addIndexes(root, put) {
  let made = 0;
  // The assistant's own folders are not notes to index: each skill is one folder with its own SKILL.md, and agent-os holds the rules.
  const ownFolder = (rel) => /^(skills\/.+|agent-os(\/.*)?)$/.test(rel);
  (function walk(dir, rel, depth) {
    if (ownFolder(rel)) return false;
    const subs = subDirs(dir).filter((s) => depth < 8);
    const kept = [];
    for (const s of subs) if (walk(path.join(dir, s), rel ? `${rel}/${s}` : s, depth + 1)) kept.push(s);
    const files = mdFiles(dir);
    const present = hasIndex(dir);
    if (!present && (files.length || kept.length) && made < MAX_INDEXES) {
      const name = rel ? path.basename(dir) : 'Notes';
      if (put(rel ? `${rel}/index.md` : 'index.md', indexText(dir, name, files, kept))) made++;
    }
    return present || files.length > 0 || kept.length > 0;
  })(root, '', 0);
  return made;
}

// One call for setup and Settings: does what the chosen mode says, and says what it did.
function apply(root, mode, opts = {}) {
  mode = MODES.includes(mode) ? mode : 'leave';
  const made = [], kept = [];
  const put = (rel, text) => {
    const f = path.join(root, rel);
    if (fs.existsSync(f)) { kept.push(rel); return false; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    made.push(rel);
    if (opts.onWrite) opts.onWrite(rel);
    return true;
  };
  const starter = installStarter(root, opts.starterDir, put);
  put('agent-os/README.md', rulesText(mode));
  let indexes = 0;
  if (mode !== 'leave') {
    put('log.md', header({ type: 'Log', title: 'Log', description: 'What changed and when, newest first.', tags: ['log'] }) + '\n# Log\n\nNewest first. Agentic OS adds a line when it creates a note.\n');
    indexes = addIndexes(root, put);
  }
  return { mode, made, kept: kept.length, indexes, skills: starter.skills, manifest: starter.manifest };
}

// ---- quiet self-correction after a chat turn: only for notes Agentic OS created in that turn ----

function nearestIndex(root, abs) {
  let dir = path.dirname(abs);
  while (dir.length >= root.length) {
    const hit = (() => { try { return fs.readdirSync(dir).find((n) => /^index\.md$/i.test(n)); } catch { return null; } })();
    if (hit) return path.join(dir, hit);
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return null;
}

function addLink(indexAbs, noteAbs, backup, onWrite, root) {
  const rel = norm(path.relative(path.dirname(indexAbs), noteAbs));
  const text = fs.readFileSync(indexAbs, 'utf8');
  if (new RegExp(`\\]\\(\\.?/?(${esc(rel)}|${esc(encodeURI(rel))})[)#]`).test(text)) return false;
  const { body } = splitHeader(readHead(noteAbs));
  const d = descriptionOf(body);
  const bullet = `- [${titleOf(noteAbs)}](${encodeURI(rel)})${d ? ` - ${d}` : ''}`;
  const nl = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let at = -1;
  lines.forEach((l, i) => { if (/^\s*[-*]\s+\[[^\]]*\]\([^)]*\.md[^)]*\)/.test(l)) at = i; });
  if (at >= 0) lines.splice(at + 1, 0, bullet);
  else { while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); lines.push('', bullet, ''); }
  if (backup) backup(indexAbs);
  fs.writeFileSync(indexAbs, lines.join(nl));
  if (onWrite) onWrite(norm(path.relative(root, indexAbs)));
  return true;
}

function addLog(root, entry, backup, onWrite) {
  const f = path.join(root, 'log.md');
  if (!fs.existsSync(f)) return false;
  const text = fs.readFileSync(f, 'utf8');
  const nl = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const day = `## ${today()}`;
  const h = lines.findIndex((l) => l.trim() === day);
  if (h >= 0) lines.splice(h + 1, 0, '', `- ${entry}`);
  else {
    const first = lines.findIndex((l) => /^##\s/.test(l));
    const block = [day, '', `- ${entry}`, ''];
    if (first >= 0) lines.splice(first, 0, ...block); else { while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); lines.push('', ...block); }
  }
  if (backup) backup(f);
  fs.writeFileSync(f, lines.join(nl).replace(/(\r?\n){3,}/g, nl + nl));
  if (onWrite) onWrite('log.md');
  return true;
}

// `created` = vault-relative paths of notes the model wrote that did not exist before this turn.
function selfCorrect(root, mode, created, opts = {}) {
  const done = { headers: 0, linked: 0, indexes: 0, logged: 0 };
  if (!MODES.includes(mode) || mode === 'leave') return done;
  const put = (rel, text) => { const f = path.join(root, rel); if (fs.existsSync(f)) return false; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); if (opts.onWrite) opts.onWrite(rel); done.indexes++; return true; };
  const logged = [];
  for (const rel of created) {
    if (!/\.(md|markdown)$/i.test(rel) || /(^|\/)(index|log)\.md$/i.test(rel) || rel.split('/').some((s) => s.startsWith('.') || SKIP.has(s))) continue;
    const abs = path.join(root, rel);
    if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) continue;
    let text = fs.readFileSync(abs, 'utf8');
    if (!splitHeader(text).header) {
      const { body } = splitHeader(text);
      const h = header({ type: 'Note', title: titleOf(abs), description: descriptionOf(body), tags: ['note'] });
      if (opts.onWrite) opts.onWrite(rel);
      fs.writeFileSync(abs, h + (/\r\n/.test(text) ? '\r\n' : '\n') + body.replace(/^\s+/, ''));
      done.headers++;
    }
    let idx = nearestIndex(root, abs);
    if (!idx || path.dirname(idx) !== path.dirname(abs)) {
      // the note's own folder has no index: give it one (this lists the note too)
      const dir = path.dirname(abs);
      const r = norm(path.relative(root, dir));
      if (r && hasIndex(dir) === false) put(`${r}/index.md`, indexText(dir, path.basename(dir), mdFiles(dir), [], new Date()));
      idx = nearestIndex(root, abs);
    }
    if (idx && addLink(idx, abs, opts.backup, opts.onWrite, root)) done.linked++;
    logged.push(rel);
  }
  if (logged.length && addLog(root, `${logged.length === 1 ? `\`${logged[0]}\` was added` : `${logged.length} notes were added (${logged.slice(0, 3).map((r) => `\`${r}\``).join(', ')}${logged.length > 3 ? ', ...' : ''})`} by Agentic OS.`, opts.backup, opts.onWrite)) done.logged = logged.length;
  return done;
}

module.exports = { MODES, apply, addIndexes, selfCorrect, rulesText, promptText, titleOf, descriptionOf };

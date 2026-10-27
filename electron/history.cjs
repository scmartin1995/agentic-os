// What the user asked and which skills ran, read from Claude Code's own session logs for the vault
// (~/.claude/projects/<vault path as a slug>/*.jsonl). Every Claude Code session whose working folder is the
// vault lands there, the app's and any other, so Health, Value and Dreams start with real history instead of
// an empty ledger. Read-only. Each file is parsed once and kept; when it grows, only the new lines are read.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vault = require('./vault.cjs');

const DAY = 24 * 3600 * 1000;
// Claude Code names the folder after the working directory with every non-alphanumeric character as "-".
const dir = () => path.join(os.homedir(), '.claude', 'projects', vault.ROOT.replace(/[^a-zA-Z0-9]/g, '-'));
// With a key or a gateway the engine keeps its logs in its own config folder (see engineHome in claude.cjs); both are read.
const ownDir = () => { try { return path.join(require('electron').app.getPath('userData'), 'engine-home', 'projects', vault.ROOT.replace(/[^a-zA-Z0-9]/g, '-')); } catch { return ''; } };
const logFiles = () => {
  const out = [];
  for (const d of [dir(), ownDir()]) { if (!d) continue; try { for (const n of fs.readdirSync(d)) if (n.endsWith('.jsonl')) out.push(path.join(d, n)); } catch { /* no logs there yet */ } }
  return out;
};

// Prompts the app sends on its own (Lessons pass, model carry-on, dream) start with "[" and aren't the user.
const isMachine = (t) => /^\s*(\[|<)/.test(t);

const cache = new Map(); // file -> { size, mtime, offset, prompts, skills, mcp }

// Reads one log. The logs only ever grow, so a file that got bigger is read from where the last read stopped
// (`offset`, just past its last whole line) and the new lines are added to what is already known. The active
// chat's log can be over 10 MB and used to be read again in full every time a panel opened.
function parse(file, st, known) {
  const grown = known && st.size > known.size && known.offset <= st.size;
  const from = grown ? known.offset : 0;
  const out = grown ? known : { prompts: [], skills: [], mcp: [] };
  const done = (offset) => ({ size: st.size, mtime: st.mtimeMs, offset, prompts: out.prompts, skills: out.skills, mcp: out.mcp });
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    try { buf = Buffer.alloc(st.size - from); fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
  } catch { return done(from); }
  const end = buf.lastIndexOf(10) + 1; // whole lines only; a half-written last line waits for the next read
  parseLines(buf.toString('utf8', 0, end), out);
  return done(from + end);
}

function parseLines(text, out) {
  for (const line of text.split('\n')) {
    // cheap string checks first: most lines are tool results and attachments
    const user = line.startsWith('{"') && line.includes('"type":"user"') && line.includes('"type":"text"');
    const skill = line.includes('"name":"Skill"') || line.includes('"name":"mcp__');
    if (!user && !skill) continue;
    let l;
    try { l = JSON.parse(line); } catch { continue; }
    if (l.isSidechain) continue;
    const t = Date.parse(l.timestamp) || 0;
    const content = l.message && l.message.content;
    if (!Array.isArray(content)) continue;
    if (l.type === 'user') {
      for (const b of content) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() && !isMachine(b.text)) {
          out.prompts.push({ t, session: l.sessionId || '', text: b.text.trim().slice(0, 600) });
        }
      }
    } else if (l.type === 'assistant') {
      for (const b of content) {
        // Connector and MCP calls are named mcp__<server>__<tool>; only the names are kept, never the inputs.
        if (b.type === 'tool_use' && typeof b.name === 'string' && b.name.startsWith('mcp__')) {
          const [, server, ...tool] = b.name.split('__');
          if (server) out.mcp.push({ t, session: l.sessionId || '', server, tool: tool.join('__') });
        }
        if (b.type === 'tool_use' && b.name === 'Skill' && b.input && typeof b.input.skill === 'string') {
          out.skills.push({ t, session: l.sessionId || '', skill: b.input.skill.replace(/^aos:/, '') });
        }
      }
    }
  }
}

// Everything since `since` (ms), newest last. Old files are skipped by modified time without opening them.
// Always the last 120 days (callers narrow it); calls that overlap share one scan.
let running = null;
function load() {
  if (!running) running = scan(Date.now() - 120 * DAY).finally(() => { running = null; });
  return running;
}
async function scan(since) {
  const names = logFiles();
  if (!names.length) return { prompts: [], skills: [], mcp: [], since: null };
  const prompts = [], skills = [], mcp = [];
  let oldest = null;
  for (const n of names) {
    const f = n;
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < since) continue;
    let c = cache.get(f);
    if (!c || c.size !== st.size || c.mtime !== st.mtimeMs) {
      c = parse(f, st, c);
      cache.set(f, c);
      await new Promise((r) => setImmediate(r)); // let the app breathe between files: the first scan is over 100 MB
    }
    for (const p of c.prompts) if (p.t >= since) { prompts.push(p); if (oldest == null || p.t < oldest) oldest = p.t; }
    for (const s of c.skills) if (s.t >= since) skills.push(s);
    for (const m of c.mcp) if (m.t >= since) mcp.push(m);
  }
  prompts.sort((a, b) => a.t - b.t);
  skills.sort((a, b) => a.t - b.t);
  mcp.sort((a, b) => a.t - b.t);
  return { prompts, skills, mcp, since: oldest };
}

module.exports = { load, DAY };

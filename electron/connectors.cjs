// Connectors panel: everything Agentic OS can reach, discovered rather than listed by hand.
//  - What is connected: asked of Claude Code at launch and on Refresh (claude.cjs refreshStartup / refreshConnectors,
//    no model call), kept in connectors-seen.json so the panel has something to show straight away.
//  - How often each is used: counted from the session logs (history.cjs), names only, never the contents.
//  - Name, colour, logo: derived from the connector's own name. A bundled logo in public/connectors/<slug>.svg wins;
//    otherwise one is fetched once from the Simple Icons set (public icon name only) and cached; otherwise a badge.
// Token cost, measured 2026-10-04 with a one-word question and every connector connected: +4.1k tokens per chat on
// Sonnet (+2.3k on Haiku). Claude Code lists the tools by name and fetches a tool's details only when it is used, so
// the cost is the name list, not the tool details. Still, they stay out of chats by default and Agentic OS loads only the
// app a task needs (use_connectors); a connector kept out with disallowedTools still leaves about 1.2k behind.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const history = require('./history.cjs');

const dataFile = (n) => path.join(app.getPath('userData'), n);
const { readJson, writeJson } = require('./store.cjs'); // writeJson saves atomically; readJson logs a damaged file

// 'ondemand' (default): Agentic OS loads them for a task by calling use_connectors. 'always': every chat. 'never': none.
const MODES = ['ondemand', 'always', 'never'];
const mode = () => { const m = readJson(dataFile('connectors.json'), {}).mode; return MODES.includes(m) ? m : 'ondemand'; };
function setMode(m) {
  if (MODES.includes(m)) writeJson(dataFile('connectors.json'), { ...readJson(dataFile('connectors.json'), {}), mode: m });
  return mode();
}

// ---- what is connected (from Claude Code's mcpServerStatus) ----
const seen = () => readJson(dataFile('connectors-seen.json'), { at: null, servers: [] });
function setSeen(servers) {
  writeJson(dataFile('connectors-seen.json'), { at: Date.now(), servers: servers.map((s) => ({
    name: String(s.name), status: s.status, tools: (s.tools || []).length, source: s.source || s.scope || '',
  })) });
}
// The part after "mcp__" in a tool name: the server name with anything odd turned into "_".
const keyOf = (name) => String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
const cleanName = (n) => String(n).replace(/^claude\.ai\s+/i, '').replace(/^claude_ai_/, '').replace(/[_-]+/g, ' ').trim();
const slugOf = (n) => cleanName(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// The claude.ai apps found at the last check, as { key, name, status }. key is the mcp__<key>__ tool prefix.
const servers = () => seen().servers.filter((s) => /claude/i.test(s.source || ''))
  .map((s) => ({ key: keyOf(s.name), name: cleanName(s.name), status: s.status }));
// Match names Agentic OS asks for ("gmail", "Google Drive") to connected apps. Loose on case, spaces and punctuation.
function pick(wanted) {
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
  const all = servers().filter((s) => s.status === 'connected');
  const keys = [], unknown = [];
  for (const w of wanted) {
    const n = norm(w);
    const m = n && all.find((s) => norm(s.name) === n || (n.length >= 3 && norm(s.name).includes(n)));
    if (m) keys.push(m.key); else unknown.push(String(w).slice(0, 40));
  }
  return { keys: [...new Set(keys)], unknown };
}
// Names of the connected claude.ai apps, for the assistant's instructions. Outside text, so it is cut down to plain words.
const names = () => seen().servers
  .filter((s) => s.status === 'connected' && /claude/i.test(s.source || ''))
  .map((s) => cleanName(s.name).replace(/[^\w .&-]/g, '').slice(0, 40)).filter(Boolean);

// A steady colour per name, for the badge and bars when there is no brand colour.
const CARBON = ['#33b1ff', '#8a3ffc', '#08bdba', '#ff7eb6', '#6fdc8c', '#4589ff', '#d2a106', '#d12771', '#bae6ff', '#ba4e00', '#d4bbff', '#007d79'];
function colorOf(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return CARBON[h % CARBON.length];
}

// ---- logos ----
const logoDir = () => dataFile('connector-logos');
const MISS_DAYS = 30;
async function logo(name) {
  const flat = cleanName(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!flat) return null;
  const svg = path.join(logoDir(), `${flat}.svg`), miss = path.join(logoDir(), `${flat}.miss`);
  try { return `data:image/svg+xml;base64,${fs.readFileSync(svg).toString('base64')}`; } catch { /* not cached */ }
  try { if (Date.now() - fs.statSync(miss).mtimeMs < MISS_DAYS * 86400000) return null; } catch { /* no marker */ }
  fs.mkdirSync(logoDir(), { recursive: true });
  try {
    const r = await fetch(`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${flat}.svg`, { signal: AbortSignal.timeout(6000) });
    const t = r.ok ? await r.text() : '';
    if (!t.startsWith('<svg')) { fs.writeFileSync(miss, ''); return null; }
    const lit = t.replace('<svg ', '<svg fill="#c6c6c6" '); // the set is black; the app is dark
    fs.writeFileSync(svg, lit);
    return `data:image/svg+xml;base64,${Buffer.from(lit).toString('base64')}`;
  } catch { return null; } // offline: try again next time, nothing cached
}

// ---- the panel ----
// `have`: which built-in services are set up on this PC, from main.cjs.
async function summary(have = {}) {
  const h = await history.load();
  const now = Date.now(), DAY = history.DAY;
  const by = {};
  for (const m of h.mcp) {
    if (m.server.startsWith('ccd_')) continue; // Claude app plumbing, not a tool it chose
    const c = (by[m.server] ||= { total: 0, d7: 0, d30: 0, last: 0, days: Array(14).fill(0), tools: {} });
    c.total++;
    if (now - m.t < 7 * DAY) c.d7++;
    if (now - m.t < 30 * DAY) c.d30++;
    c.last = Math.max(c.last, m.t);
    const age = Math.floor((now - m.t) / DAY);
    if (age < 14) c.days[13 - age]++;
    c.tools[m.tool] = (c.tools[m.tool] || 0) + 1;
  }

  const s = seen();
  const rows = new Map();
  for (const d of s.servers) {
    const key = keyOf(d.name);
    rows.set(key, { key, name: cleanName(d.name), status: d.status, tools: d.tools, kind: /claude/i.test(d.source) ? 'Connector' : 'Built in' });
  }
  for (const key of Object.keys(by)) {
    if (rows.has(key)) continue;
    // In the logs but not connected now: the history stays, and it says so (only judged once discovery has run).
    rows.set(key, { key, name: key === 'aos' ? 'Agentic OS tools' : cleanName(key), tools: null,
      status: key === 'aos' ? 'builtin' : s.at ? 'removed' : 'unknown', kind: key === 'aos' ? 'This app' : 'Connector' });
  }
  const items = [...rows.values()].map((r) => {
    const c = by[r.key] || { total: 0, d7: 0, d30: 0, last: 0, days: Array(14).fill(0), tools: {} };
    return {
      ...r, id: r.key === 'aos' ? 'aos' : slugOf(r.name), color: colorOf(r.name),
      total: c.total, d7: c.d7, d30: c.d30, last: c.last, days: c.days,
      topTools: Object.entries(c.tools).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => ({ name, n })),
    };
  }).sort((a, b) => b.d30 - a.d30 || b.total - a.total || (a.status === 'connected' ? 0 : 1) - (b.status === 'connected' ? 0 : 1) || a.name.localeCompare(b.name));

  // Services the app itself uses, only if they are set up here. Not connector calls, so no counts.
  const builtIn = [
    (() => { try { const p = require('./providers.cjs').active(); return { id: 'claude', name: 'Claude', kind: p.method === 'subscription' ? 'Answers, on your plan login' : p.baseUrl ? 'Answers, through your gateway' : 'Answers, on your API key', on: true }; } catch { return { id: 'claude', name: 'Claude', kind: 'Answers', on: true }; } })(),
    { id: 'outlook', name: 'Outlook', kind: 'Mail, read from classic Outlook on this PC', on: !!have.outlook },
    { id: 'whisper', name: 'Whisper', kind: 'Speech to text, on this PC', on: !!have.whisper },
    { id: 'piper', name: 'Piper', kind: "the assistant's voice, on this PC", on: !!have.piper },
  ].filter((b) => b.on).map(({ on, ...b }) => ({ ...b, color: colorOf(b.name) }));

  return { since: h.since, mode: mode(), checkedAt: s.at, items, builtIn };
}

module.exports = { summary, mode, setMode, seen, setSeen, names, servers, pick, logo };

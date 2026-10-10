// Connectors panel: everything the assistant can reach, discovered rather than listed by hand.
//  - What is connected: asked of Claude Code at launch and on Refresh (claude.cjs refreshStartup / refreshConnectors,
//    no model call), kept in connectors-seen.json so the panel has something to show straight away.
//  - How often each is used: counted from the session logs (history.cjs), names only, never the contents.
//  - Name, colour, logo: derived from the connector's own name. A bundled logo in public/connectors/<slug>.svg wins;
//    otherwise one is fetched once from the Simple Icons set (public icon name only) and cached; otherwise a badge.
// Token cost, measured 2026-10-04 with a one-word question and every connector connected: +4.1k tokens per chat on
// Sonnet (+2.3k on Haiku). Claude Code lists the tools by name and fetches a tool's details only when it is used, so
// the cost is the name list, not the tool details. Still, they stay out of chats by default and the assistant loads only the
// app a task needs (use_connectors); a connector kept out with disallowedTools still leaves about 1.2k behind.
//  - Servers the user added to Claude Code themselves (`claude mcp add --scope user`, e.g. Claude Design) count as
//    connectors too: read from their ~/.claude.json (userServers) and passed in by hand, since the app starts Claude Code
//    with no settings files (claude.cjs, settingSources: []). Loaded the same way: only when a task asks for them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const history = require('./history.cjs');

const dataFile = (n) => path.join(app.getPath('userData'), n);
const { readJson, writeJson } = require('./store.cjs'); // writeJson saves atomically; readJson logs a damaged file

// 'ondemand' (default): the assistant loads them for a task by calling use_connectors. 'always': every chat. 'never': none.
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
// "claude.ai Google Drive" -> "Google Drive"; an all-lowercase name like "claude-design" -> "Claude Design".
const cleanName = (n) => {
  const t = String(n).replace(/^claude\.ai\s+/i, '').replace(/^claude_ai_/, '').replace(/[_-]+/g, ' ').trim();
  return (/[A-Z]/.test(t) ? t : t.replace(/\b[a-z]/g, (c) => c.toUpperCase())).replace(/\bGithub\b/g, 'GitHub');
};
const slugOf = (n) => cleanName(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// What counts as a connector: a claude.ai app ('claudeai') or a server passed in from their Claude Code config ('dynamic').
// Not 'sdk' (this app's own tools) and not 'plugin'.
const isConnector = (s) => /^(claudeai|dynamic)$/i.test(s.source || '') || /claude/i.test(s.source || '');
// Connectors the user does not want to see (slug of the name). Still connected on their account, just kept out of the panel
// and out of the assistant's list. Set from a row's chip in the panel ("Hidden"), saved as "hidden" in connectors.json.
const hiddenSlugs = () => { const h = readJson(dataFile('connectors.json'), {}).hidden; return new Set(Array.isArray(h) ? h : ['higgsfield']); };
const isHidden = (name) => hiddenSlugs().has(slugOf(name));
// The connectors found at the last check, as { key, name, status, source }. key is the mcp__<key>__ tool prefix.
const servers = () => seen().servers.filter(isConnector).filter((s) => !isHidden(s.name))
  .map((s) => ({ key: keyOf(s.name), name: cleanName(s.name), status: s.status, source: /dynamic/i.test(s.source || '') ? 'yours' : 'apps' }));

// Claude in Chrome is not a claude.ai app or a server from their config: Claude Code adds it with its --chrome flag.
// Since 2026-10-08 it loads like the others (only when a task asks for it), not in every chat. Its tools are not
// listed until it is loaded, so the count is the one seen on 2026-10-07.
const CHROME = { key: 'claude-in-chrome', name: 'Claude in Chrome', tools: 22 };
const chromeHidden = () => hiddenSlugs().has(slugOf(CHROME.name));

// ---- how each one loads ----
// A row's own setting ("policy" in connectors.json, by key) overrides the switch at the top of the panel.
const POLICIES = ['ondemand', 'always', 'never'];
const policies = () => { const p = readJson(dataFile('connectors.json'), {}).policy; return p && typeof p === 'object' ? p : {}; };
const effective = (key) => (POLICIES.includes(policies()[key]) ? policies()[key] : mode());
// p: 'ondemand' | 'always' | 'never' | 'hidden' | 'shown'. Choosing what the switch already says clears the override,
// so the row follows the switch again.
function setPolicy(key, name, p) {
  const cfg = readJson(dataFile('connectors.json'), {});
  const policy = { ...(cfg.policy && typeof cfg.policy === 'object' ? cfg.policy : {}) };
  const hidden = new Set(hiddenSlugs());
  const slug = slugOf(name || key);
  if (p === 'hidden') { hidden.add(slug); delete policy[key]; }
  else if (p === 'shown') hidden.delete(slug);
  else if (POLICIES.includes(p)) { hidden.delete(slug); if (p === mode()) delete policy[key]; else policy[key] = p; }
  else return false;
  writeJson(dataFile('connectors.json'), { ...cfg, policy, hidden: [...hidden] });
  return true;
}

// What one question loads. `asked`: keys the assistant asked for with use_connectors, while their turns last.
//  load: every key in the chat; chrome: pass --chrome; claudeAi: any claude.ai app in (else they are switched off
//  whole, which leaves nothing behind); deny: the connected apps to remove by name, since claude.ai apps come all
//  or none.
function plan(asked = new Set()) {
  const pool = [...servers().filter((s) => s.status === 'connected'), ...(chromeHidden() ? [] : [{ ...CHROME, source: 'browser' }])];
  const load = new Set(pool.filter((s) => { const e = effective(s.key); return e === 'always' || (e === 'ondemand' && asked.has(s.key)); }).map((s) => s.key));
  const claudeAi = pool.some((s) => s.source === 'apps' && load.has(s.key));
  return { load, chrome: load.has(CHROME.key), claudeAi, deny: servers().filter((s) => !load.has(s.key)).map((s) => `mcp__${s.key}`) };
}

// ---- servers the user added to Claude Code themselves ----
// `claude mcp add --scope user ...` writes them to ~/.claude.json. Claude Code only reads that file with its settings,
// and this app starts it with none (so their terminal set-up never leaks into the assistant), so they are read here and passed in
// (claude.cjs). `only`: a Set of server keys to include (the ones the assistant asked for); null = all of them.
const userConfigFile = () => path.join(os.homedir(), '.claude.json');
function userServers(only = null) {
  const all = readJson(userConfigFile(), {}).mcpServers;
  const out = {};
  if (!all || typeof all !== 'object') return out;
  for (const [name, c] of Object.entries(all)) {
    if (!c || typeof c !== 'object') continue;
    const type = c.type || (c.command ? 'stdio' : '');
    if (!['http', 'sse', 'stdio'].includes(type)) continue;
    if (only && !only.has(keyOf(name))) continue;
    const cfg = { ...c, type };
    // headersHelper (Claude Code's own setting): a command that prints the auth headers as JSON, so no token sits in the
    // config file. The SDK does not run it for servers passed in by hand, so it is run here, in memory only.
    if (cfg.headersHelper) {
      try {
        const o = require('child_process').execSync(cfg.headersHelper, { encoding: 'utf8', timeout: 8000, windowsHide: true });
        cfg.headers = { ...(cfg.headers || {}), ...JSON.parse(o) };
      } catch { /* no headers: the server will show as needing sign-in */ }
      delete cfg.headersHelper;
    }
    out[name] = cfg;
  }
  return out;
}
// Match names the assistant asks for ("gmail", "Google Drive") to connected apps. Loose on case, spaces and punctuation.
// "Chrome", "browser" and "Claude in Chrome" all mean the browser.
function pick(wanted) {
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
  const all = [...servers().filter((s) => s.status === 'connected'), ...(chromeHidden() ? [] : [CHROME])];
  const keys = [], unknown = [];
  for (const w of wanted) {
    const n = norm(w);
    const m = n && (/^(browser|chrome|googlechrome|claudeinchrome)$/.test(n) && !chromeHidden() ? CHROME
      : all.find((s) => norm(s.name) === n || (n.length >= 3 && norm(s.name).includes(n))));
    if (m) keys.push(m.key); else unknown.push(String(w).slice(0, 40));
  }
  return { keys: [...new Set(keys)], unknown };
}
// Tool-name prefixes to remove from a chat so only the apps the assistant asked for stay in (`keep`: a Set of server keys).
// Used with disallowedTools; a connector kept out this way still leaves about 1.2k tokens behind (measured 2026-10-04).
const denyExcept = (keep) => servers().filter((s) => !keep.has(s.key)).map((s) => `mcp__${s.key}`);
// Names of the connected apps the assistant may load, for their instructions. Outside text, so it is cut down to plain words.
// Ones set to "Never" are left out, so they are not told about something they cannot use.
const names = () => [
  ...seen().servers.filter((s) => s.status === 'connected' && isConnector(s) && !isHidden(s.name) && effective(keyOf(s.name)) !== 'never')
    .map((s) => cleanName(s.name).replace(/[^\w .&-]/g, '').slice(0, 40)),
  ...(!chromeHidden() && effective(CHROME.key) !== 'never' ? ['Chrome'] : []),
].filter(Boolean);

// A steady colour per name, for the badge and bars when there is no brand colour.
function colorOf(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 65% 62%)`;
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
    const lit = t.replace('<svg ', '<svg fill="#cbd5e1" '); // the set is black; the app is dark
    fs.writeFileSync(svg, lit);
    return `data:image/svg+xml;base64,${Buffer.from(lit).toString('base64')}`;
  } catch { return null; } // offline: try again next time, nothing cached
}

// ---- the panel ----
// Seven sections by where a thing comes from (inventory, 2026-10-07): brain, connected apps, added by you, browser,
// the assistant's own tools, on this PC, always on. Only the middle four are tool calls, so only they have counts.
// `have`: what is set up on this PC, from main.cjs. `loaded`: keys loaded in the chat that is open now.
const TOKENS_PER_TOOL = 53; // 77 tool names cost 4.1k tokens on Sonnet (measured 2026-10-04); rough
const OWN_TOOLS = ['open_file', 'window', 'use_connectors', 'request_model', 'request_helpers'];
async function summary(have = {}, loaded = []) {
  const h = await history.load();
  const now = Date.now(), DAY = history.DAY;
  const by = {};
  for (const m of h.mcp) {
    if (m.server.startsWith('ccd_')) continue; // Claude app plumbing, not a tool they chose
    const c = (by[m.server] ||= { total: 0, d30: 0, last: 0, days: Array(14).fill(0), tools: {} });
    c.total++;
    if (now - m.t < 30 * DAY) c.d30++;
    c.last = Math.max(c.last, m.t);
    const age = Math.floor((now - m.t) / DAY);
    if (age < 14) c.days[13 - age]++;
    c.tools[m.tool] = (c.tools[m.tool] || 0) + 1;
  }
  const inChat = new Set(loaded);
  const counts = (key) => {
    const c = by[key] || { total: 0, d30: 0, last: 0, days: Array(14).fill(0), tools: {} };
    return { total: c.total, d30: c.d30, last: c.last, days: c.days,
      topTools: Object.entries(c.tools).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => ({ name, n })) };
  };
  const row = (r) => {
    const policy = r.fixed ? null : effective(r.key);
    return { id: slugOf(r.name), color: colorOf(r.name), kind: '', note: '', ...r, ...counts(r.key), policy,
      own: !r.fixed && POLICIES.includes(policies()[r.key]), // set on the row, not just following the switch
      loaded: policy === 'always' && r.status === 'connected' ? 'every' : inChat.has(r.key) ? 'chat' : null };
  };
  const byUse = (a, b) => b.d30 - a.d30 || b.total - a.total || (a.status === 'connected' ? 0 : 1) - (b.status === 'connected' ? 0 : 1) || a.name.localeCompare(b.name);

  const s = seen();
  const apps = [], yours = [], hidden = [];
  const known = new Set(['aos', 'helpers', CHROME.key]);
  for (const d of s.servers) {
    if (!isConnector(d)) continue;
    const key = keyOf(d.name);
    known.add(key);
    if (isHidden(d.name)) { hidden.push({ key, name: cleanName(d.name) }); continue; }
    const r = row({ key, name: cleanName(d.name), status: d.status, tools: d.tools });
    (/dynamic/i.test(d.source || '') ? yours : apps).push(r);
  }
  // In the logs but not connected now: the history stays, and it says so (only judged once discovery has run).
  for (const key of Object.keys(by)) {
    if (known.has(key) || isHidden(key)) continue;
    apps.push(row({ key, name: cleanName(key), tools: null, status: s.at ? 'removed' : 'unknown', fixed: s.at ? 'Gone' : '–' }));
  }
  if (chromeHidden()) hidden.push({ key: CHROME.key, name: CHROME.name });
  const browser = chromeHidden() ? [] : [row({ key: CHROME.key, name: CHROME.name, status: 'connected', statusText: 'Your Chrome', tools: CHROME.tools,
    note: 'needs Chrome open with the Claude extension' })];
  const own = [
    { ...row({ key: 'aos', id: 'assistant', name: 'App tools', status: 'builtin', tools: OWN_TOOLS.length, note: OWN_TOOLS.join(' · '), fixed: 'Always' }), loaded: null },
    { ...row({ key: 'helpers', id: 'helpers', name: 'Helpers', status: 'builtin', tools: 2, note: 'scout (Haiku, reads only) · worker (Sonnet, can edit)', fixed: 'On your yes' }), loaded: null },
  ];

  let brain;
  try {
    const p = require('./providers.cjs').active();
    brain = { id: p.id, name: p.name,
      note: p.method === 'subscription' ? (p.id === 'claude' ? 'Your plan login, through Claude Code' : 'Your plan login') : p.method === 'local' ? 'A model on this PC' : 'Your API key',
      detail: p.id === 'claude' ? 'Sonnet 5.5 everyday · Haiku 4.5 for short lookups at the start of a chat · Opus 5.5 and Fable 5.1 only on your yes' : '' };
  } catch { brain = { id: 'claude', name: 'Claude', note: '', detail: '' }; }

  // Not tool calls, so no counts. Shown whether or not they are set up, so nothing is missing; off ones are dimmed.
  const pc = [
    { id: 'whisper', name: 'Whisper', kind: 'Speech to text', on: !!have.whisper },
    { id: 'piper', name: 'Piper', kind: 'Spoken answers', on: !!have.piper },
    { id: 'vosk', icon: 'ear', name: 'Vosk', kind: '"Hey computer" wake word', on: !!have.wake },
    { id: 'discord', name: 'Discord', kind: have.discord ? 'Approvals and chat by DM' : 'Not set up · Settings > Discord', on: !!have.discord },
    { id: 'phone', icon: 'phone', name: 'Phone link', kind: have.phone ? 'On' : 'Off · Settings > Phone', on: !!have.phone },
  ].map((t) => ({ ...t, color: colorOf(t.name) }));

  return { since: h.since, mode: mode(), checkedAt: s.at, tokensPerTool: TOKENS_PER_TOOL, brain: { ...brain, color: colorOf(brain.name) },
    apps: apps.sort(byUse), yours: yours.sort(byUse), browser, own, pc, skills: have.skills ?? null, hidden };
}

module.exports = { summary, mode, setMode, setPolicy, effective, plan, CHROME, seen, setSeen, names, servers, pick, denyExcept, logo, userServers };

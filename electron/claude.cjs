// The Claude brain: talks to Claude through the Claude Agent SDK, which runs the unmodified Claude Code binary.
// One of several engines in v2 (see engine.cjs); this is the one with everything (connectors, helpers, plan meter).
//
// Two ways to authenticate, both inside Anthropic's rules for personal use
// (https://code.claude.com/docs/en/legal-and-compliance):
//   - "plan": the user's own claude.ai login, signed in through Anthropic's own flow (onboarding opens it).
//     This app never reads, copies, or stores that login.
//     Personal, single-user, ordinary use only - do not share this app on this login.
//   - "api":  an Anthropic API key saved in onboarding (encrypted, settings.cjs), billed to that key.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const vault = require('./vault.cjs');
const policy = require('./policy.cjs');
const attachments = require('./attachments.cjs');
const win = require('./window.cjs');
const jobs = require('./jobs.cjs');
const connectors = require('./connectors.cjs');
const settings = require('./settings.cjs');
const shared = require('./shared.cjs');
const store = require('./store.cjs');

// Cheapest model that fits. Short lookups and small talk run on Haiku, everything else on Sonnet. The assistant never
// moves up on its own: when a task needs a stronger model it calls request_model, the user says yes or no, and on
// yes the task carries on at once on that model. AGENTIC_OS_MODEL forces one model for everything.
const FORCED = process.env.AGENTIC_OS_MODEL || null;
const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const FABLE = 'claude-fable-5-1';
const RANK = { [HAIKU]: 0, [SONNET]: 1, [OPUS]: 2, [FABLE]: 3 };
const NICE = { [HAIKU]: 'Haiku 4.5', [SONNET]: 'Sonnet 5.5', [OPUS]: 'Opus 5.5', [FABLE]: 'Fable 5.1' };
const ASK_FOR = { sonnet: SONNET, opus: OPUS, fable: FABLE };
// After a yes, the stronger model keeps the next few turns (so "yes, do it" and follow-up steps
// stay on it), then the assistant drops back to the everyday tier.
const STEP_UP_TURNS = 4;
const CONNECTOR_TURNS = 3;

// Several chats can run at once (the user, 2026-10-04). Everything that belongs to one conversation lives in
// its own state object, so chats never share a Claude session, a step-up model, loaded connectors or a stop button.
// Only approvals, "yes to all edits" and the written-files list are shared. Each running chat is its own Claude Code
// process, and this PC runs low on memory, so the number running at once is capped (AGENTIC_OS_MAX_CHATS).
const MAX_RUNNING = Math.max(1, Number(process.env.AGENTIC_OS_MAX_CHATS) || 3);
const chats = new Map(); // chat id -> state
function chatFor(id = 'default') {
  let S = chats.get(id);
  if (!S) {
    S = {
      id, title: '',
      sessionId: null, abort: null, gen: 0,
      stepUp: null, // { model, turns }
      connectorsLeft: 0, // questions left with some connectors loaded (use_connectors); 0 = chat runs without them
      connectorApps: new Set(), // which ones: server keys, the part after mcp__ in their tool names
      lastModel: FORCED || SONNET, lastActive: 0,
      turns: 0, // questions the user has asked in this chat
      autoRun: false, // a background wrap-up is running
      helperBudget: 0, // helpers the user approved for this question (request_helpers); the Agent hook spends it
      standing: null, // this session's standing instructions and the index pages they were built from (systemAppend)
      said: {}, // what the app last told this session with a question (questionContext)
      modelCosts: null, // Claude Code's running cost per model after the last question here (null = not known, e.g. after a restart)
      lastFolder: null, // vault folder of the last file the assistant touched ('' = vault root)
      outsideChanges: new Set(), // notes that changed outside the assistant since its last question here
    };
    chats.set(id, S);
  }
  return S;
}
const running = () => [...chats.values()].filter((S) => S.abort);
// What the next question in this chat would load (the Connectors panel's "In this chat"). Never creates a chat.
const loadedConnectors = (id) => { const S = chats.get(id); return S && S.connectorsLeft > 0 ? [...connectors.plan(S.connectorApps).load] : []; };
const CHITCHAT = /^(thanks|thank you|cheers|got it|cool|nice|great|hello|hi|hey)\b[\s\S]{0,40}$/i;
// "yes, do it" answers whatever was just proposed, so it stays on the model that proposed it.
const CONFIRM = /^(yes|yeah|yep|no|nope|ok|okay|sure|go on|go ahead|do it)\b[\s\S]{0,40}$/i;
const LOOKUP = /^(what|what's|whats|when|where|who|which|how (much|many|old|long|far)|is|are|do|does|did|can|will)\b/i;
const DOING = /\b(edit|write|create|add|change|update|fix|build|install|run|delete|remove|move|rename|save|make|summari[sz]e|compare|plan|design|debug|implement|refactor|research|explain why|set up)\b/i;
// A light question: short, asks for something to be looked up or answered, not done.
function isLight(text) {
  const t = String(text || '').trim();
  if (CHITCHAT.test(t)) return true;
  return t.length <= 120 && LOOKUP.test(t) && !DOING.test(t);
}
function pickModel(S, text, hasFiles) {
  if (FORCED) return FORCED;
  if (S.stepUp) {
    if (S.stepUp.turns-- > 0) return S.stepUp.model;
    S.stepUp = null;
  }
  if (S.sessionId && CONFIRM.test(String(text || '').trim())) return S.lastModel;
  const light = !hasFiles && isLight(text);
  // Haiku only takes a short question at the start of a chat (the user, 2026-10-04). Each model keeps its own cached
  // copy of the chat, so dropping to Haiku part-way made Haiku read the whole chat at full price, and often Sonnet
  // again on the next question: 6 of 14 switches in the ledger re-read about 100k tokens. A chat that began on
  // Haiku stays there for short questions and moves up to Sonnet, for good, at the first one that isn't.
  if (S.sessionId) return light && S.lastModel === HAIKU ? HAIKU : SONNET;
  return light ? HAIKU : SONNET;
}
let lastModelUsed = FORCED || SONNET; // for status() and the ledger fallback

// The assistant's personality is a note the user owns: agent/persona.md in their workspace (everything after the
// frontmatter). It is read when a chat's standing instructions are built, so a new chat picks up an edit. If the note is
// missing or empty, PERSONA_DEFAULT is used. PERSONA_REST (how the assistant does things) and METHOD stay in code, so a
// personality edit can't weaken the safety rules or the answering method.
// {user}, {assistant} and {appDir} are filled in by personalize().
const PERSONA_DEFAULT = `You are {assistant}, {user}'s assistant inside their Agentic OS, a desktop app that works out of their notes folder.
Manner: calm, friendly and direct. Answer first, then add detail only if it helps.
Length: you may be read aloud, so keep answers to one to three short sentences unless {user} asks for detail.
Talk, don't recite: say what the notes say in your own words. Don't read documents out word for word, and don't cite file paths unless asked where something came from.
Honesty: you don't make things up. If the notes don't say, say so, and where you looked. Never say something is done until you've checked it.
Straight talk: don't agree just to please. If a plan has a hole, say so plainly and kindly, with your reason, then respect {user}'s call.
Asking: when you're not sure where something belongs or what {user} means, ask instead of guessing.
Mistakes: when you get something wrong, say so in one sentence, fix it, and move on.
Plain words: explain things simply and skip jargon unless {user} uses it first.`;
const PERSONA_REST = `Doing things: you can do whatever the job needs - edit and create notes, change files on this PC, run commands, install things, search the web. Just do it and say what you did in a sentence. Every file you edit or overwrite is backed up automatically first, so edits can be undone (backups are in the folder named below; restore from there if asked). Deleting files and overwriting with > are backed up for you first, so use full paths for them (relative paths, wildcards and chained commands can't be backed up, so they get checked instead). Only catastrophic, unrecoverable actions - formatting drives, throwing away git work (force push, reset --hard, clean), deleting registry entries or accounts, deleting things you can't back up (very big, or outside the user's folders), sending data off the PC, publishing or deleting things online - get checked with {user} automatically; if they say no, drop it and don't find another way round. Everything else you just do. Right before one of those, say in a sentence or two of plain words what it will do and why it's needed, and give the command a plain-words description (its description field: one short sentence saying what it does and to what, like "Deletes the old build folder"), so {user} can decide without guessing. They may ask questions before answering; answer them straight. When the notes don't have something, you can search the web; say it came from the web and offer to save it.
Updating yourself: never run "claude update" or replace your own claude.exe while you're running. If a newer Claude Code is needed, tell {user} it's an npm update of @anthropic-ai/claude-agent-sdk in the app folder ({appDir}) followed by a restart of the app.
Showing files: when {user} asks to see, open or pull up a workspace file, use the open_file tool so it opens in the app's viewer.
Your home is {user}'s workspace (the current working directory). How it is organised (its README.md says more):
- projects/<name>/ is one folder per project. Each may hold notes.md (dated notes) and action-items.md (checkbox lines: "- [ ] open", "- [x] done"). The app's Notes and Actions pages read exactly those two file names, so keep using them, and keep action items as checkbox lines.
- inbox/ has the same two files, for things that don't belong to a project yet.
- skills/<name>/SKILL.md holds how-to instructions for a kind of task. Read the matching one before doing that kind of task.
- agent/persona.md is your personality. Only {user} edits it; you may suggest a change.
Link a new page from the nearest index.md or README.md if the folder has one.`;
function personaText() {
  try {
    const body = stripFrontmatter(fs.readFileSync(path.join(vault.ROOT, 'agent', 'persona.md'), 'utf8'));
    if (body) return body;
  } catch { /* no persona note: the built-in one */ }
  return PERSONA_DEFAULT;
}
const buildPersona = () => personaText() + '\n' + PERSONA_REST;

// How the assistant answers. Kept apart from the persona so personality edits can't weaken it.
const METHOD = `How to answer every question about {user}'s work, notes or projects:
1. Check the folder you were last working in first (the app names it in a note that comes with the question, when it has changed). The answer is often right there.
2. Then review the workspace indexes below and read every note they point to that could hold the answer.
3. If the indexes don't lead to it, search the whole workspace with Grep (try a few wordings) before giving up.
4. Only say you don't know after steps 1-3, and then say where you looked.
Never answer about {user}'s work or projects from memory alone; check the notes.

Models: you start on the cheapest model that fits the question, to save plan usage. Never switch up on your own. If the task is harder than your current model can do well (real multi-file code changes, a bug with no obvious cause, a design trade-off, or you are guessing), call request_model with a one-sentence plain-words reason and a short handoff brief for the stronger model (goal, what you tried, files involved, why you are stuck); {user} gets a yes/no card. Ask once per task. On yes, say one short line and stop: the app carries on with the task on the stronger model straight away. On no, carry on and say plainly where you may fall short.

Helpers (subagents): you can hand parts of a job to helpers, but only after {user} says yes. When a job splits into independent pieces, or is a big read-through whose details you don't need, call request_helpers once with the helpers you want, each one's job in plain words, and a one-sentence reason. On yes, start them with the Agent tool, only the ones approved; on no, do it yourself and don't ask again for this question. Never ask for a quick lookup. Pick the cheapest helper that fits: "scout" (Haiku, reads and searches only) for finding and reading; "worker" (Sonnet, can edit files and run commands, same rules as you) for jobs that change things. At most four at once. Write each helper a complete brief, because it knows nothing of this chat: the goal, the skills/<name>/SKILL.md files to read first, the notes to start from, and what to hand back. The web is a last resort for helpers. Check what they hand back before relying on it, then answer in your own words.`;

// Helpers the assistant can hand work to (the Agent tool, after a yes to request_helpers). Neither can hand work on or ask for a model.
// The same short rules are also added to every brief by the hook in send(), so they hold even if the assistant forgets them.
const HELPER_RULES = "Working rules (from the app): 1) Read every skills/<name>/SKILL.md file this brief names before anything else, and follow it. 2) Check the workspace before the web: start from the notes named above, then the indexes and Grep. 3) The web is a last resort: one targeted search, then fetch only the one page that answers it. Hand back a short extract plus the source link. 4) Be brief: under 150 words, answer first, file paths after, and say plainly what you could not find.";
const NO_HELPER_TOOLS = ['Agent', 'Task', 'mcp__aos__request_helpers', 'mcp__aos__request_model', 'mcp__aos__use_connectors', 'mcp__aos__window'];
const HELPERS = {
  scout: {
    description: 'Finds and reads things in the workspace or on the web and reports short plain facts with file paths. Read-only: it never changes anything. Use for lookups, comparisons and read-throughs.',
    prompt: "You are a scout working for the assistant in the user's workspace (your working directory). First read any skills/<name>/SKILL.md files the brief names. Then find what the brief asks for in the notes it names, the indexes, and Grep. The web is a last resort. You change nothing. Report back briefly: the answer first, then the file paths you relied on, and say plainly what you could not find.",
    tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
    model: 'haiku',
    maxTurns: 25,
  },
  worker: {
    description: 'Does a self-contained job that changes things (edit notes, create files, run commands) and reports what it did. Use for parallel pieces of a bigger job, each with its own clear brief.',
    prompt: "You are a worker doing one self-contained job for the assistant in the user's workspace (your working directory). First read any skills/<name>/SKILL.md files the brief names and follow them; check the notes before the web. Do exactly what the brief says, no more. Every file you edit is backed up first; stick to full paths. Report briefly what you changed (file paths) and anything you could not do.",
    disallowedTools: NO_HELPER_TOOLS,
    model: 'sonnet',
    maxTurns: 40,
  },
};
// Fills in the user's and the assistant's names (Settings) and this copy of the app's folder.
const APP_DIR = path.join(__dirname, '..');
function personalize(text) {
  const user = (settings.get('userName') || '').trim() || 'the user';
  const assistant = (settings.get('assistantName') || '').trim() || 'Assistant';
  return String(text).split('{user}').join(user).split('{assistant}').join(assistant).split('{appDir}').join(APP_DIR);
}
const stripFrontmatter = (t) => t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();

// Every index.md in the workspace, plus the README.md at its root, as [{ rel, text }].
function indexPages() {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase() === 'index.md' || (dir === vault.ROOT && e.name.toLowerCase() === 'readme.md')) files.push(p);
    }
  })(vault.ROOT);
  return files.sort().map((p) => {
    const rel = path.relative(vault.ROOT, p).split(path.sep).join('/');
    let text = '';
    try { text = stripFrontmatter(fs.readFileSync(p, 'utf8')); } catch (e) { store.log('could not read index page', rel, e); }
    return { rel, text: text.slice(0, 6000) };
  });
}

function folderContext(S) {
  if (S.lastFolder === null) return 'You have not opened any folder yet this session.';
  let names = [];
  try { names = fs.readdirSync(path.join(vault.ROOT, S.lastFolder)).filter((n) => !n.startsWith('.')).slice(0, 60); } catch {}
  return `You were last working in: ${S.lastFolder || '(vault root)'}/\nIt contains: ${names.join(', ')}`;
}

// Notes that changed outside the assistant (the user, another agent, or another of their chats) are passed to each chat with its next question.
function noteOutsideChanges(files) { for (const S of chats.values()) for (const f of files) S.outsideChanges.add(f); }

// The connected apps, as discovered at launch (connectors.cjs). Empty until the first check finishes.
const connectorNames = () => connectors.names().join(', ');
// the assistant's standing instructions are written once, when a chat's Claude session starts, and then sent unchanged with
// every question in it (the user, 2026-10-04). Claude keeps a cached copy of a chat and only reuses it while everything
// before the new question is word-for-word the same; the instructions come first, so any change to them (a new folder,
// one edited index page) made the whole chat be read again at full price. What changes from question to question goes
// in with the question instead (questionContext). `fresh`: this question starts a new session.
function systemAppend(S = chatFor('default'), fresh = true) {
  if (!fresh && S.standing) return S.standing.text;
  const pages = indexPages();
  const text = personalize([
    buildPersona(), METHOD,
    '## Backups of files you changed\n' + policy.backupDir(),
    '## Connectors\nThe connected apps' + (connectorNames() ? ` (${connectorNames()})` : '') + ' are not loaded in a chat by default, to save tokens. When {user} asks for something that needs one, call use_connectors naming only the app(s) needed, with a short reason, and end your turn; the app carries on with just those loaded for the next few questions. Never call it for notes, files or ordinary web questions. Chrome (the browser {user} is signed in to on this PC, through the Claude extension) loads the same way: ask for "Chrome" when a task needs a site they are signed in to, or a page that WebFetch cannot read.',
    '## Workspace indexes (as they were when this chat began)\n' + pages.map((p) => `### ${p.rel}\n${p.text}`).join('\n\n'),
  ].join('\n\n'));
  S.standing = { text, pages: new Map(pages.map((p) => [p.rel, p.text])) };
  S.said = {}; // nothing has been said with a question yet in this session
  return text;
}

// What has changed since the assistant was last told, sent with the question as a note from the app (a UserPromptSubmit hook in
// send(), so it never lands in the user's own words in the session log). Each part is only sent when it differs from
// what this session was last told, so it doesn't pile up in a long chat. Returns '' when there is nothing new.
function questionContext(S) {
  const said = S.said || (S.said = {});
  const parts = [];
  const tell = (key, value, text) => { if (value && said[key] !== value) parts.push(text); said[key] = value; };
  const where = folderContext(S);
  tell('where', where, '## Where you were\n' + where);
  tell('others', running().length > 1 ? 'yes' : '', "## Other chats\nThe user has other chats with you running right now. They can edit the same workspace, so re-read a note just before you change it, and keep edits small.");
  const outside = [...S.outsideChanges].slice(0, 40).join('\n');
  if (outside) parts.push('## Changed since you last looked (not by you)\n' + outside + '\nMention it if it matters to the question; re-read before relying on old knowledge of these.');
  // Index pages that no longer match the copies in the standing instructions.
  let stale = '';
  if (S.standing) {
    const now = indexPages();
    const changed = now.filter((p) => S.standing.pages.get(p.rel) !== p.text).map((p) => p.rel);
    for (const rel of S.standing.pages.keys()) if (!now.some((p) => p.rel === rel)) changed.push(`${rel} (removed)`);
    stale = changed.join('\n');
  }
  tell('stale', stale, '## Index pages changed since this chat began\n' + stale + '\nThe copies in your instructions are older. Read these files again before you rely on them.');
  return parts.length ? '[Note from the app, not from the user]\n\n' + parts.join('\n\n') : '';
}

function loadKey() {
  const p = settings.get('provider');
  if (p.id !== 'claude' || p.method !== 'key') return null; // the plan login was chosen: never fall back to a stray key
  return settings.getSecret('key:claude') || settings.envOr('ANTHROPIC_API_KEY') || null;
}

const mode = () => (loadKey() ? 'api' : 'plan');

function authEnv() {
  const key = loadKey();
  const env = { ...process.env };
  // The bundled Claude Code must not update itself: on 2026-10-04 its updater renamed claude.exe
  // aside and never put the new one in place, so the assistant couldn't start. Updates come via npm.
  env.DISABLE_AUTOUPDATER = '1';
  if (key) env.ANTHROPIC_API_KEY = key;
  else { delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; } // let Claude Code use its own login
  return env;
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const { approve } = shared;
const askUser = shared.ask;

function status() {
  const on = running();
  return { ready: true, mode: mode(), model: lastModelUsed, busy: on.length > 0, running: on.map((S) => S.id) };
}

// Stop one chat (its running work and any card it is waiting on), or every chat when no id is given.
function stop(chatId) {
  const all = chatId == null;
  shared.cancel(chatId);
  for (const S of chats.values()) if (S.abort && (all || S.id === chatId)) S.abort.abort();
  return true;
}

// Make sure a chat exists in the backend and, for one reopened from disk, carries on its Claude session.
// Counts as active now, so the idle reset doesn't throw the old history away on the first question.
// A chat that is running keeps its live session.
function openChat(chatId, sid) {
  const S = chatFor(chatId);
  if (!S.abort) {
    S.sessionId = typeof sid === 'string' && sid ? sid : S.sessionId;
    S.lastActive = Date.now();
  }
  return true;
}

// A chat the user has forgotten or left for good: stop it and let go of its state.
function closeChat(chatId) {
  stop(chatId);
  const S = chats.get(chatId);
  if (S) { S.gen++; chats.delete(chatId); }
  return true;
}

// Paths the agent touched, from tool inputs: Read/Edit/Write use file_path; Grep/Glob use path.
function touchedPath(input) {
  const p = input && (input.file_path || input.path || input.notebook_path);
  if (typeof p !== 'string') return null;
  const abs = path.resolve(vault.ROOT, p);
  return abs === vault.ROOT || abs.startsWith(vault.ROOT + path.sep) ? path.relative(vault.ROOT, abs).split(path.sep).join('/') : null;
}

function rememberFolder(rel, S = chatFor('default')) {
  let isDir = false;
  try { isDir = fs.statSync(path.join(vault.ROOT, rel)).isDirectory(); } catch {}
  S.lastFolder = isDir ? rel : path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
}

const AUTH_HELP = {
  authentication_failed: 'Claude is not signed in. Open Settings, then Brain, and sign in again (or switch to an API key there).',
  oauth_org_not_allowed: 'This Claude account is not allowed to use Claude Code.',
  billing_error: 'Billing problem on the account or API key.',
  rate_limit: 'Plan limit reached for now. The charge meter shows when it resets.',
};

// `resumed`: this is the automatic carry-on after the user said yes to a stronger model, so the
// reply continues in the same bubble (no second 'start').
async function send(chatId, text, emit, files = [], resumed = false, auto = false) {
  const S = chatFor(chatId);
  // Every event carries its chat, so the window (and Discord) can tell the chats apart.
  const raw = emit;
  emit = (e) => raw({ ...e, chat: S.id });
  // the user asking something beats a background wrap-up: drop it and carry on with their question.
  if (S.abort && S.autoRun && !auto) { stop(S.id); for (let i = 0; S.abort && i < 30; i++) await new Promise((r) => setTimeout(r, 100)); }
  if (S.abort) { emit({ type: 'error', message: 'Still working on the last request.' }); return; }
  if (running().length >= MAX_RUNNING) {
    if (auto) return; // the quiet wrap-up just waits for another time
    if (!resumed) emit({ type: 'error', message: `${MAX_RUNNING} chats are already working. Let one finish or stop one first, then ask again.` });
    emit({ type: 'done' });
    return;
  }
  S.abort = new AbortController(); // before the first await, so a second send can't slip in
  const abort = S.abort;
  const myGen = S.gen;
  const { query, createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = require('zod');
  const t0 = Date.now();
  if (!auto && !resumed && !S.title) S.title = String(text || '').replace(/\s+/g, ' ').slice(0, 60);
  const skillsUsed = []; // skills this question ran, for the ledger (Health, Value)
  if (!auto && !resumed) { S.turns++; S.helperBudget = 0; S.chromeOk = false; } // a yes to helpers, or to acting in Chrome, covers one question
  S.autoRun = auto;
  // before 'start', so the reply bubble stays the last chat item
  if (!resumed) emit({ type: 'start' });
  const resumeId = S.sessionId || null; // null: this question starts a new Claude session, so its cost counter starts at zero
  const model = auto ? SONNET : (S.lastModel = lastModelUsed = pickModel(S, text, files.length > 0)); // the background pass doesn't eat a step-up turn
  const append = systemAppend(S, !resumeId);
  const context = questionContext(S); // goes in with the question, below
  S.outsideChanges = new Set(); // it has been told now
  // Connectors (Gmail, Drive...) put their whole tool lists in the chat, so they load only when the assistant asked for them (use_connectors).
  // Each one follows the switch in the Connectors panel unless its row says otherwise (connectors.plan). Chrome too, since
  // 2026-10-08. The background pass loads none.
  if (S.connectorsLeft <= 0) S.connectorApps.clear(); // a past ask has run out; it must not come back with the next one
  const cPlan = auto ? connectors.plan(new Set()) : connectors.plan(S.connectorApps);
  if (auto) { cPlan.load.clear(); cPlan.chrome = false; cPlan.claudeAi = false; }
  if (!auto && !resumed && S.connectorsLeft > 0) S.connectorsLeft--;
  // claude.ai apps come all or none, so the ones not loaded are removed from the chat by name.
  const deny = cPlan.claudeAi ? cPlan.deny : [];
  // Servers the user added to Claude Code themselves (e.g. Claude Design) are passed in by hand, and only when loaded: Claude Code
  // never reads their config here (settingSources: []), and an unloaded server passed in would still list its tools.
  const userMcp = cPlan.load.size ? connectors.userServers(cPlan.load) : {};
  let connectorsCarry = false; // the assistant called use_connectors: carried on once this turn ends, with them loaded
  let carryOn = false; // the user said yes to a stronger model: the handoff brief (or true), carried on once this turn ends

  const aos = createSdkMcpServer({ name: 'aos', version: '1.0.0', tools: [
    // the assistant can move its own window on request (window.cjs).
    tool('window', "Move or resize the Agentic OS window you live in, when the user asks (e.g. 'go full screen', 'move to the left', 'other monitor').",
      { action: z.enum(win.ACTIONS) },
      async ({ action }) => ({ content: [{ type: 'text', text: win.control(action) }] })),
    // the assistant shows a vault file in the app's own viewer (the same one a file-tree click opens).
    tool('open_file', 'Open a vault file in the Agentic OS viewer so the user can see it. Use this, not Start-Process, when they ask to see or open a note.',
      { path: z.string().describe('Path inside the vault, relative to its root, e.g. projects/website/README.md') },
      async ({ path: p }) => {
        const abs = vault.resolveInside(String(p).replace(/\\/g, '/'));
        const say = (t) => ({ content: [{ type: 'text', text: t }] });
        if (!abs || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return say(`No file at "${p}" inside the vault. Check the path and try again.`);
        const rel = path.relative(vault.ROOT, abs).split(path.sep).join('/');
        emit({ type: 'open', path: rel });
        return say(`Opened ${rel} in the viewer.`);
      }),
    // the assistant asks for the connectors only when a task needs one. No card: the user already asked for the task.
    tool('use_connectors', `Load just the connected app(s) a task needs${connectorNames() ? ` (${connectorNames()})` : ''}. Apps are not loaded by default, to save tokens. Call this only when the user asks for something that needs one, naming only the app(s) needed, then end your turn.`,
      { apps: z.array(z.string()).min(1).describe('Only the apps this task needs, by name, e.g. ["Gmail"].'), reason: z.string().describe('One short phrase: why.') },
      async ({ apps, reason }) => {
        const say = (t) => ({ content: [{ type: 'text', text: t }] });
        const { keys: found, unknown } = connectors.pick(apps);
        if (!found.length) return say(`No connected app matches ${apps.join(', ')}. ${connectorNames() ? `Connected: ${connectorNames()}.` : 'None are known yet; The user can press Refresh in the Connectors panel.'} Tell the user plainly if it is not connected.`);
        const keys = found.filter((k) => connectors.effective(k) !== 'never');
        if (!keys.length) return say("That app is set to 'Never' in the Connectors panel. Tell the user plainly they can change it there; do not try another way.");
        const missing = keys.filter((k) => !cPlan.load.has(k));
        if (!missing.length) return say(`${apps.join(', ')} is already loaded; use it directly.`);
        keys.forEach((k) => S.connectorApps.add(k));
        S.connectorsLeft = CONNECTOR_TURNS;
        connectorsCarry = String(reason || '').slice(0, 200) || true;
        return say(`Loading ${keys.length > 1 ? 'them' : 'it'} now${unknown.length ? ` (not connected: ${unknown.join(', ')})` : ''}. Say one short line (like "Grabbing Gmail.") and end your turn. Do no more work this turn: the app carries on with the task straight away, with it ready.`);
      }),
    // the assistant asks to move up to a stronger model; only the user's yes makes it happen.
    tool('request_model', 'Ask the user to switch this task to a stronger (and costlier) model, when it is harder than your current model can do well. Gives them a yes/no card. Ask once per task, with a one-sentence plain-words reason.',
      { model: z.enum(['sonnet', 'opus', 'fable']), reason: z.string(), handoff: z.string().describe('Short brief for the stronger model: the goal, what you have tried, the files involved, and why you are stuck. Plain facts, no guesses presented as fact.') },
      async ({ model: want, reason, handoff }, extra) => {
        const target = ASK_FOR[want];
        const say = (t) => ({ content: [{ type: 'text', text: t }] });
        if (FORCED) return say('The model is locked by the app; carry on as you are.');
        if (RANK[target] <= (RANK[model] ?? 0)) return say(`You are already on ${NICE[model] || model}; carry on.`);
        const { yes, question } = await askUser(emit, extra?.signal || abort.signal, S, {
          tool: 'request_model', summary: `switch to ${NICE[target]}: ${String(reason).slice(0, 200)}`,
          what: `This is harder than ${NICE[model] || 'the current model'} can do well.`, spoken: `switch to ${NICE[target]}`,
        });
        if (question) return say(`Nothing changed. The user has not said yes or no yet; they asked: "${question}". Answer them plainly, no jokes, then ask again with request_model if it is still needed.`);
        if (!yes) return say(`The user said no. Stay on ${NICE[model] || 'this model'}, do the best you can, and tell them briefly where it may fall short. Do not ask again for this task.`);
        S.stepUp = { model: target, turns: STEP_UP_TURNS };
        carryOn = String(handoff || '').slice(0, 1500) || true;
        return say(`Approved. Say one short line (like "Switching up.") and end your turn now. Do no more work this turn: the app carries on with the task on ${NICE[target]} straight away.`);
      }),
    // the assistant asks before handing parts of a job to helpers; the Agent hook below only lets approved helpers start.
    tool('request_helpers', 'Ask the user before handing parts of this job to helpers (subagents). Gives them one yes/no card for the whole plan. Ask once per question, only when the job really splits up or is a big read-through; never for a quick lookup. Then, on yes, start exactly those helpers with the Agent tool.',
      { helpers: z.array(z.object({ type: z.enum(['scout', 'worker']), job: z.string().describe('What this helper will do, in plain words.') })).min(1).max(4),
        reason: z.string().describe('One plain-words sentence: why helpers are worth it here.') },
      async ({ helpers: plan, reason }, extra) => {
        const say = (t) => ({ content: [{ type: 'text', text: t }] });
        if (auto) return say('Helpers are not available for this background pass; do it yourself.');
        const n = plan.length;
        const kinds = plan.some((h) => h.type === 'worker') ? 'Scouts only read (Haiku, cheap); workers can change files and run commands (Sonnet).' : 'Scouts only read and search (Haiku, cheap); they change nothing.';
        const { yes, question } = await askUser(emit, extra?.signal || abort.signal, S, {
          tool: 'request_helpers',
          summary: `use ${n} helper${n === 1 ? '' : 's'}: ${plan.map((h) => `${h.type} - ${String(h.job).slice(0, 90)}`).join('; ')}`,
          what: `${String(reason).slice(0, 220)} ${kinds}`.trim(),
          spoken: `hand part of this to ${n} helper${n === 1 ? '' : 's'}`,
        });
        if (question) return say(`Nothing started. The user has not said yes or no yet; they asked: "${question}". Answer them plainly, no jokes, then ask again with request_helpers if you still want them.`);
        if (!yes) return say('The user said no to helpers. Do the work yourself, and tell them briefly if it will take longer or you may miss something. Do not ask again for this question.');
        S.helperBudget = n;
        return say(`Approved: you may start up to ${n} helper${n === 1 ? '' : 's'}, exactly as planned, with the Agent tool. Brief each fully (skills to read first, notes to start from, what to hand back, the web as a last resort).`);
      }),
  ] });

  // Every action outside the always-allowed list comes through here (see policy.cjs).
  // Helpers' tool calls come through here too (agentID is set), so they get exactly the same gate as the assistant.
  const canUseTool = async (tool, input, { signal, agentID }) => {
    const c = policy.check(tool, input);
    const chrome = tool.startsWith('mcp__claude-in-chrome__');
    // One yes to act in Chrome covers every click, keystroke and form in the same question (the user 2026-10-10).
    if (c.ask && chrome && S.chromeOk) c.ask = false;
    if (c.ask) { // only irreversible actions reach here; each one asks
      const what = typeof input?.description === 'string' ? input.description : '';
      const { yes, question } = await askUser(emit, signal, S, { tool, summary: c.summary, what, spoken: c.spoken || c.summary, risky: !!c.risky, helper: !!agentID });
      if (question) return { behavior: 'deny', message: `Nothing was run. The user has not said yes or no yet; they asked: "${question}". Answer them plainly, no jokes: what this does, why it is needed, what could go wrong, and any safer option. Then, if it is still the right move, try the exact same action again so they get a fresh yes/no card. Do not do it any other way.` };
      if (!yes) return { behavior: 'deny', message: 'The user said no. Drop this action and do not try another way to do it; tell them briefly you have left it.' };
      if (chrome) S.chromeOk = true;
    }
    // Deletes and > overwrites by command run unasked because they are copied to the backup folder first.
    // If a copy fails, the command does not run (a delete with no backup is not recoverable).
    for (const b of c.backups || []) {
      if (!policy.backupAny(b) && fs.existsSync(b)) return { behavior: 'deny', message: `Not run: the safety copy of ${b} could not be made first. Tell the user plainly and ask before trying another way.` };
    }
    const p = touchedPath(input);
    if (EDIT_TOOLS.has(tool) || tool === 'NotebookEdit') {
      policy.backup(path.resolve(vault.ROOT, String(input.file_path || input.notebook_path || '')));
      if (p !== null) {
        shared.markWritten(p);
        for (const o of chats.values()) if (o !== S) o.outsideChanges.add(p); // the other chats didn't make this edit
      }
    }
    return { behavior: 'allow', updatedInput: input };
  };
  const helpers = new Map(); // Agent tool_use id -> helper, added when the hook lets it start (so a refused call shows nothing)
  try {
    const q = query({
      prompt: files.length ? `${text}\n\n[The user attached ${files.length === 1 ? 'a file' : `${files.length} files`}. Look at ${files.length === 1 ? 'it' : 'them'} with the Read tool before you answer: ${files.join(' ; ')}]` : text,
      options: {
        cwd: vault.ROOT,
        model,
        resume: resumeId || undefined,
        includePartialMessages: true,
        abortController: abort,
        systemPrompt: { type: 'preset', preset: 'claude_code', append },
        // Looking is always fine; everything else goes through canUseTool / policy.cjs.
        allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'TodoWrite', 'mcp__aos__window', 'mcp__aos__open_file', 'mcp__aos__request_model', 'mcp__aos__use_connectors', 'mcp__aos__request_helpers'],
        mcpServers: { aos, ...userMcp },
        agents: HELPERS, // scout and worker, for the Agent tool (see METHOD)
        // The Agent tool never reaches canUseTool, so this hook is its gate: only helpers the user said yes to
        // (request_helpers), only our two kinds (cheap, with known tools), no model/permission overrides, and they
        // run while the assistant waits (the default is the background, which would let its turn end while they work).
        // The working rules (skills first, web last, short answers) are added to every brief.
        hooks: {
          // What changed since the last question (folder, other chats, edited notes) rides in with the question, so the
          // standing instructions never change mid-chat and the chat stays cached (see systemAppend).
          UserPromptSubmit: [{ hooks: [async () => (context ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } } : {})] }],
          PreToolUse: [{ matcher: 'Agent|Task', hooks: [async (input) => {
          const decide = (permissionDecision, extra) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, ...extra } });
          const ti = input.tool_input || {};
          if (input.agent_id) return decide('deny', { permissionDecisionReason: 'Helpers cannot start helpers.' });
          if (!HELPERS[ti.subagent_type]) return decide('deny', { permissionDecisionReason: 'Use the "scout" or "worker" helper (subagent_type), nothing else.' });
          if (S.helperBudget <= 0) return decide('deny', { permissionDecisionReason: 'The user has not approved helpers for this question. Call request_helpers first with your plan; start helpers only after they say yes. If they said no, do the work yourself.' });
          S.helperBudget--;
          const h = { id: input.tool_use_id, name: String(ti.subagent_type), desc: String(ti.description || '').slice(0, 120), brief: String(ti.prompt || '').slice(0, 1500) };
          helpers.set(h.id, h);
          emit({ type: 'helper', phase: 'start', ...h });
          const { model: _m, mode: _mode, isolation: _i, team_name: _t, ...safe } = ti; // no model or permission overrides
          return decide('allow', { updatedInput: { ...safe, run_in_background: false, prompt: `${String(ti.prompt || '')}\n\n${HELPER_RULES}` } });
        }] }],
        },
        // A workspace with .claude-plugin/plugin.json is loaded as a Claude Code plugin, so its skills/ show up as skills.
        plugins: fs.existsSync(path.join(vault.ROOT, '.claude-plugin', 'plugin.json')) ? [{ type: 'local', path: vault.ROOT }] : [],
        skills: 'all',
        additionalDirectories: [policy.backupDir(), attachments.dir()], // restore old versions; read what the user drops in
        permissionMode: 'default',
        canUseTool,
        settingSources: [],
        // Connectors stay out of the chat unless asked for, and then only the app needed (see cPlan, deny).
        settings: { disableClaudeAiConnectors: !cPlan.claudeAi },
        disallowedTools: deny,
        // Claude in Chrome: the assistant drives the user's own signed-in Chrome, loaded like a
        // connector (above). Reading and moving around run unasked; clicking, typing and form-filling ask (policy.cjs, browser).
        extraArgs: cPlan.chrome ? { chrome: null } : {},
        env: authEnv(),
      },
    });

    // Plan meter snapshot. The SDK marks this call experimental, so it is optional:
    // the documented rate_limit_event below keeps the meter fed if this ever goes away.
    if (mode() === 'plan' && typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET === 'function') {
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
        .then((u) => {
          if (!u || !u.rate_limits_available || !u.rate_limits) return;
          for (const [kind, w] of Object.entries(u.rate_limits)) {
            if (w && typeof w.utilization === 'number') emit({ type: 'limits', kind, used: w.utilization, resetsAt: w.resets_at ? Date.parse(w.resets_at) : null, plan: u.subscription_type });
          }
        })
        .catch(() => {});
    }

    for await (const m of q) {
      if (m.session_id && myGen === S.gen && m.session_id !== S.sessionId) { S.sessionId = m.session_id; emit({ type: 'session', id: S.sessionId }); }
      if (m.type === 'stream_event') {
        // Helpers' own words are theirs, not the assistant's reply: only the top-level stream is the answer.
        if (m.parent_tool_use_id) continue;
        const ev = m.event;
        if (ev && ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') emit({ type: 'text', text: ev.delta.text });
      } else if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
        const byHelper = !!m.parent_tool_use_id;
        for (const b of m.message.content) {
          if (b.type !== 'tool_use') continue;
          if ((b.name === 'Agent' || b.name === 'Task') && !byHelper) {
            continue; // shown when the hook lets it start (a refused call shows nothing)
          }
          // A skill call is a tool_use named "Skill" with input { skill: "<plugin>:<name>" } (seen in the session logs, 2026-10-04).
          if (b.name === 'Skill' && b.input && typeof b.input.skill === 'string') skillsUsed.push(b.input.skill.replace(/^[w-]+:/, ''));
          const p = touchedPath(b.input);
          if (p !== null && !byHelper) rememberFolder(p, S);
          emit({ type: 'tool', name: b.name, input: b.input, path: p, helper: byHelper || undefined });
        }
        if (m.error && !byHelper) emit({ type: 'error', message: AUTH_HELP[m.error] || `Claude error: ${m.error}` });
      } else if (m.type === 'user' && !m.parent_tool_use_id && m.message && Array.isArray(m.message.content)) {
        // A helper's hand-back arrives as the result of the Agent call that started it.
        for (const b of m.message.content) {
          if (b.type !== 'tool_result' || !helpers.has(b.tool_use_id)) continue;
          const h = helpers.get(b.tool_use_id);
          helpers.delete(b.tool_use_id);
          emit({ type: 'helper', phase: 'end', ...h, ok: !b.is_error });
        }
      } else if (m.type === 'rate_limit_event' && m.rate_limit_info) {
        const r = m.rate_limit_info;
        if (r.rateLimitType && typeof r.utilization === 'number') {
          emit({ type: 'limits', kind: r.rateLimitType, used: r.utilization <= 1 ? r.utilization * 100 : r.utilization, resetsAt: r.resetsAt ? r.resetsAt * (r.resetsAt < 1e12 ? 1000 : 1) : null });
        }
      } else if (m.type === 'result') {
        // total_cost_usd and modelUsage are running totals for the whole Claude session: they carry on climbing across
        // the questions of a chat (seen in the ledger, 2026-10-04). So the model that did this question's work is the
        // one whose cost rose most since the last question; helpers like Haiku title calls also show up in modelUsage.
        // After a restart the earlier totals aren't known, so the model the app picked is used.
        const costs = Object.fromEntries(Object.entries(m.modelUsage || {}).map(([k, v]) => [k, (v && v.costUSD) || 0]));
        const before = resumeId ? S.modelCosts : {};
        const used = before ? Object.entries(costs).map(([k, c]) => [k, c - (before[k] || 0)]).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k) : [model];
        S.modelCosts = costs;
        // costUsd is that running total; `fresh` tells the ledger the counter started at zero for this question.
        emit({ type: 'result', isError: !!m.is_error, costUsd: m.total_cost_usd, fresh: !resumeId, usage: m.usage, models: used.length ? used : [model],
          asked: model, light: !auto && !resumed && files.length === 0 && isLight(text), kind: auto ? 'auto' : 'ask', skills: [...new Set(skillsUsed)], ms: Date.now() - t0 });
      }
    }
    // A helper still open when the turn ends (stopped, crashed) must not spin forever in the window.
    for (const h of helpers.values()) emit({ type: 'helper', phase: 'end', ...h, ok: false });
  } catch (err) {
    emit({ type: 'error', message: abort.signal.aborted ? 'Stopped.' : String((err && err.message) || err) });
  } finally {
    const stopped = abort.signal.aborted;
    S.abort = null;
    S.lastActive = Date.now();
    // Said yes to a stronger model: no 'done' yet, the same reply carries on right away.
    if (connectorsCarry && !stopped && myGen === S.gen) {
      setImmediate(() => send(S.id, `[The connectors are loaded now${typeof connectorsCarry === 'string' ? ` (${connectorsCarry})` : ''}. Carry on with the task the user asked about; don't repeat what you already said.]`, raw, [], true));
    } else if (carryOn && !stopped && myGen === S.gen) {
      const brief = typeof carryOn === 'string' ? ` The previous model's handoff brief (treat it as a lead to check, not as settled fact): ${carryOn}` : '';
      setImmediate(() => send(S.id, `[The user said yes to switching to ${(S.stepUp && NICE[S.stepUp.model]) || 'the stronger model'}, and you are on it now. Carry on with the task you asked about; don't repeat what you already said.${brief}]`, raw, [], true));
    } else {
      emit({ type: 'done' });
    }
    if (auto) S.autoRun = false;
  }
}

// Launch check, so the charge bar and the Connectors panel are right before the first question.
// Starts Claude Code with an input that never sends a message (no model call, no tokens), asks it for the plan's
// rate limits and for which connectors are connected (a few seconds while they connect), then shuts it down.
// The servers from the user's Claude Code config ride along so the check sees them too (they come back as source 'dynamic').
async function idleQuery() {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  let release;
  const gate = new Promise((r) => { release = r; });
  async function* idle() { await gate; }
  const q = query({ prompt: idle(), options: { cwd: vault.ROOT, settingSources: [], mcpServers: connectors.userServers(), env: authEnv() } });
  const timer = setTimeout(() => { release(); try { q.close(); } catch { /* already gone */ } }, 30000);
  return { q, done: () => { clearTimeout(timer); release(); try { q.close(); } catch { /* already gone */ } } };
}
// Waits for the claude.ai connectors to finish connecting (up to ~12 s), then saves what is there.
async function discoverConnectors(q) {
  let list = [];
  for (let i = 0; i < 8; i++) {
    list = await q.mcpServerStatus();
    if (list.length && !list.some((x) => x.status === 'pending')) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (list.length) connectors.setSeen(list.filter((x) => x.source !== 'sdk'));
  return list.length;
}
async function refreshStartup(emit) {
  if (mode() !== 'plan') return false; // connectors come with the plan login
  const { q, done } = await idleQuery();
  try {
    const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).catch(() => null);
    let ok = false;
    if (u && u.rate_limits_available && u.rate_limits) {
      for (const [kind, w] of Object.entries(u.rate_limits)) {
        if (w && typeof w.utilization === 'number') emit({ type: 'limits', kind, used: w.utilization, resetsAt: w.resets_at ? Date.parse(w.resets_at) : null, plan: u.subscription_type });
      }
      ok = true;
    }
    await discoverConnectors(q).catch(() => 0);
    return ok;
  } catch { return false; } finally { done(); }
}
// The panel's Refresh button.
async function refreshConnectors() {
  if (mode() !== 'plan') return 0;
  const { q, done } = await idleQuery();
  try { return await discoverConnectors(q); } catch { return 0; } finally { done(); }
}

const wroteRecently = shared.wroteRecently;

// One question, one JSON answer, no tools (web search only when asked for). Dreams uses it (dreams.cjs).
// Returns { out, text, usage, model, cost }.
async function oneShot({ system, prompt, schema, web = false }) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const q = query({
    prompt,
    options: {
      cwd: vault.ROOT,
      model: SONNET,
      systemPrompt: system,
      tools: web ? ['WebSearch'] : [],
      allowedTools: web ? ['WebSearch'] : [],
      canUseTool: async (tool) => (web && tool === 'WebSearch' ? { behavior: 'allow' } : { behavior: 'deny', message: 'No tools in this pass.' }),
      maxTurns: web ? 6 : 3,
      outputFormat: schema ? { type: 'json_schema', schema } : undefined,
      persistSession: false,
      settingSources: [],
      // No MCP servers or claude.ai connectors: their tool lists made the first test dream about 71k tokens
      // of set-up for a 3k-token digest (2026-10-04).
      mcpServers: {},
      strictMcpConfig: true,
      settings: { disableClaudeAiConnectors: true },
      env: authEnv(),
    },
  });
  let result = null;
  for await (const m of q) if (m.type === 'result') result = m;
  if (!result || result.is_error) throw new Error(result ? `the model call failed (${result.subtype || 'error'})` : 'no answer came back');
  const used = Object.entries(result.modelUsage || {}).sort((a, b) => ((b[1] && b[1].costUSD) || 0) - ((a[1] && a[1].costUSD) || 0)).map(([k]) => k);
  const u = result.usage || {};
  return {
    out: result.structured_output || null, text: typeof result.result === 'string' ? result.result : '',
    usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 },
    model: used[0] || SONNET, cost: result.total_cost_usd || 0,
  };
}

// Is Claude Code signed in, and as what? Starts it without sending a message (no tokens). Used by onboarding and
// Settings. Never returns the login itself, only what Claude Code reports about it.
async function account() {
  try {
    const { q, done } = await idleQuery();
    try {
      const a = await Promise.race([q.accountInfo(), new Promise((_, no) => setTimeout(() => no(new Error('timed out')), 25000))]);
      const signedIn = !!(a && (a.email || a.subscriptionType || a.tokenSource || a.apiKeySource));
      return { ok: true, signedIn, email: (a && a.email) || '', plan: (a && a.subscriptionType) || '', source: (a && (a.tokenSource || a.apiKeySource)) || '' };
    } finally { done(); }
  } catch (err) {
    return { ok: false, signedIn: false, email: '', plan: '', source: '', error: String((err && err.message) || err) };
  }
}

module.exports = { oneShot, account, personalize, get PERSONA() { return buildPersona(); }, METHOD, indexPages, folderContext, questionContext, CONFIRM, NICE, pickModel, id: 'claude', refreshStartup, refreshConnectors, HAIKU, SONNET, authEnv, isLight, send, stop, openChat, closeChat, status, mode, systemAppend, rememberFolder, chatFor, approve, noteOutsideChanges, wroteRecently, HELPERS, loadedConnectors };

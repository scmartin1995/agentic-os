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
const tools = require('./tools.cjs');
const workers = require('./workers.cjs');
const settings = require('./settings.cjs');
const shared = require('./shared.cjs');
const okf = require('./okf.cjs');
const store = require('./store.cjs');
const gateway = require('./gateway.cjs');
const discover = require('./discover.cjs');
const search = require('./search.cjs');

// Cheapest model that fits.
// Short lookups and small talk run on Haiku, everything else on Sonnet. Agentic OS never moves up on its
// own: when a task needs a stronger model it calls request_model, the user says yes or no, and on
// yes the task carries on at once on that model. AOS_MODEL forces one model for everything.
const FORCED = process.env.AOS_MODEL || null;
const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const FABLE = 'claude-fable-5-1';
const RANK = { [HAIKU]: 0, [SONNET]: 1, [OPUS]: 2, [FABLE]: 3 };
const NICE = { [HAIKU]: 'Haiku 4.5', [SONNET]: 'Sonnet 5.5', [OPUS]: 'Opus 5.5', [FABLE]: 'Fable 5.1' };
const ASK_FOR = { sonnet: SONNET, opus: OPUS, fable: FABLE };
// After a yes, the stronger model keeps the next few turns (so "yes, do it" and follow-up steps
// stay on it), then Agentic OS drops back to the everyday tier.
const STEP_UP_TURNS = 4;
const CONNECTOR_TURNS = 3;

// Several chats can run at once. Everything that belongs to one conversation lives in
// its own state object, so chats never share a Claude session, a step-up model, loaded connectors or a stop button.
// Only approvals, "yes to all edits" and the written-files list are shared. Each running chat is its own Claude Code
// process, and this PC runs low on memory, so the number running at once is capped (AOS_MAX_CHATS).
const MAX_RUNNING = Math.max(1, Number(process.env.AOS_MAX_CHATS) || 3);
const chats = new Map(); // chat id -> state
function chatFor(id = 'default') {
  let S = chats.get(id);
  if (!S) {
    S = {
      id, title: '',
      sessionId: null, abort: null, gen: 0,
      stepUp: null, // { model, turns }
      pick: null, // the model the user chose with the picker by the input box ('haiku' | 'sonnet' | 'opus' | 'fable'); null = Agentic OS decides
      effort: null, // 'low' | 'medium' | 'high' | 'xhigh' | 'max' from the picker; null = the model's default
      connectorsLeft: 0, // questions left with some connectors loaded (use_connectors); 0 = chat runs without them
      connectorApps: new Set(), // which ones: server keys, the part after mcp__ in their tool names
      lastModel: FORCED || SONNET, lastActive: 0,
      turns: 0, // questions the user has asked in this chat
      autoRun: false, // a background wrap-up is running
      helperBudget: 0, // helpers the user approved for this question (request_helpers); the Agent hook spends it
      standing: null, // this session's standing instructions and the index pages they were built from (systemAppend)
      said: {}, // what the app last told this session with a question (questionContext)
      modelCosts: null, // Claude Code's running cost per model after the last question here (null = not known, e.g. after a restart)
      lastFolder: null, // vault folder of the last file Agentic OS touched ('' = vault root)
      outsideChanges: new Set(), // notes that changed outside Agentic OS since its last question here
      created: new Set(), // notes written for the first time this turn, for the quiet tidy-up afterwards (okf.cjs)
    };
    chats.set(id, S);
  }
  return S;
}
const running = () => [...chats.values()].filter((S) => S.abort);
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
// The picker by the input box. A chosen model beats everything: auto-routing, a step-up and the "yes" rule.
const PICKABLE = { haiku: HAIKU, sonnet: SONNET, opus: OPUS, fable: FABLE };
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// A pin is a model family (haiku/sonnet/opus/fable, direct accounts) or the exact id of a model the gateway lists.
const EXACT_ID = /^[A-Za-z0-9][\w.:/@-]{2,120}$/;
const pinnedModel = (pick) => (PICKABLE[pick] ? PICKABLE[pick] : pick);
// Through a gateway a pin is the exact id of a listed model, one of the plain tier names the picker offers when the gateway has no
// list to read (Bedrock), or any other name the user typed, which goes through as typed (the gateway says if it does not know it).
// Family words a gateway cannot be asked for by name (fable, or haiku/sonnet/opus beside a real list) are not pins. A direct account
// takes a family word or a typed Claude id.
const TIERS = new Set(['haiku', 'sonnet', 'opus']);
const gatewayPin = (m) => typeof m === 'string' && EXACT_ID.test(m) && !refused.has(m) && (gatewayModels.ids.includes(m) || (TIERS.has(m) ? !gatewayModels.ids.length : !PICKABLE[m]));
const directPin = (m) => !!PICKABLE[m] || (typeof m === 'string' && EXACT_ID.test(m) && /^claude-/i.test(m));
function setPick(chatId, model, effort) {
  const S = chatFor(chatId);
  S.pick = gatewayCfg() ? (gatewayPin(model) ? model : null) : (directPin(model) ? model : null);
  S.effort = EFFORTS.includes(effort) ? effort : null;
  if (S.pick) S.stepUp = null;
  return { model: S.pick, effort: S.effort };
}
function pickModel(S, text, hasFiles) {
  if (FORCED) return FORCED;
  if (S.pick) return pinnedModel(S.pick);
  if (S.stepUp) {
    if (S.stepUp.turns-- > 0) return S.stepUp.model;
    S.stepUp = null;
  }
  if (S.sessionId && CONFIRM.test(String(text || '').trim())) return S.lastModel;
  const light = !hasFiles && isLight(text);
  // Haiku only takes a short question at the start of a chat. Each model keeps its own cached
  // copy of the chat, so dropping to Haiku part-way made Haiku read the whole chat at full price, and often Sonnet
  // again on the next question: 6 of 14 switches in the ledger re-read about 100k tokens. A chat that began on
  // Haiku stays there for short questions and moves up to Sonnet, for good, at the first one that isn't.
  if (S.sessionId) return light && S.lastModel === HAIKU ? HAIKU : SONNET;
  return light ? HAIKU : SONNET;
}
let lastModelUsed = FORCED || SONNET; // for status() and the ledger fallback

// Lessons pass, the automatic wrap-up.
// Every AUTO_WRAP_EVERY questions in a chat, a quiet lessons-review pass over just those turns saves what they
// taught into the shared skills, so "wrap up" never has to cover a whole long chat. It runs after the reply is done,
// shows only a one-line note, and gets a grace period to finish on its own before a real question forces it to stop.
const AUTO_WRAP_EVERY = 10;
const AUTO_WRAP_PROMPT = `[Lessons pass (automatic wrap-up), not from the user. Run the aos:lessons-review skill over only the last ${AUTO_WRAP_EVERY} questions of this conversation: save any lesson, fix or correction into the right skill, log skill changes in log.md, and write no session summary (a manual "wrap up" does that). Work quietly. Finish with ONE short plain sentence saying what changed, or "Nothing to save."]`;
const AUTO_WRAP_GRACE_MS = 45000; // how long a user's message waits for a running lessons pass to finish before it is forced to stop

// The assistant's manner. Kept plain on purpose.
const PERSONA = `You are the assistant inside Agentic OS, the user's desktop app.
Manner: plain, calm and direct. Answer first, then the reasoning if it is needed. No jokes and no character voice.
Length: keep answers short unless the user asks for detail. One to three sentences is often enough.
Talk, don't recite: say what the notes say in your own words. Don't read documents out word for word. Give file paths when they help the user find something.
Honesty: you don't make things up. If the notes don't say, say so, and say where you looked.
Doing things: you can do what the job needs - edit and create notes, change files, run commands, search the web. Do it and say what you did in a sentence. Every file you edit or overwrite is backed up automatically first, so edits can be undone (backups are in the folder named below; restore from there if asked). Deleting files and overwriting with > are backed up for you first, so use full paths for them (relative paths, wildcards and chained commands can't be backed up, so they get checked instead). Catastrophic, unrecoverable actions - formatting drives, throwing away git work (force push, reset --hard, clean), deleting registry entries or accounts, deleting things that can't be backed up (very big, or outside the user's folders), sending data off the machine, publishing or deleting things online - are checked with the user automatically; if they say no, drop it and don't find another way round. Right before one of those, say in a sentence or two of plain words what it will do and why it is needed, and give the command a plain-words description (use its description field: one short sentence saying what it does and to what, like "Deletes the old build folder"), so the user can decide without guessing. They may ask questions before answering; answer them straight. Before writing into the notes folder, follow its own README rules if it has any. When the notes don't have something, you can search the web; say it came from the web and offer to save it.
Updating yourself: never run "claude update" or replace your own claude.exe while you're running. If a newer Claude Code is needed, tell the user it is an npm update of @anthropic-ai/claude-agent-sdk in __APP_DIR__ followed by a restart of the app.
Showing files: when the user asks to see, open or pull up a vault file, use the open_file tool so it opens in the app's viewer. Don't use other programs for vault files unless they ask for that.
Your home is the user's notes folder (the current working directory). If it has rules of its own in a README, follow them before writing anything into it.`;

// How Agentic OS answers. Kept apart from the persona so personality edits can't weaken it.
const METHOD = `How to answer every question about the user's work or projects:
1. Check the folder you were last working in first (the app names it in a note that comes with the question, when it has changed). The answer is often right there.
2. Call search_notes with the key words of the question (try a second wording if the first misses). It ranks every note and saved chat, newest first among close matches, and shows each one's date and any stale_when flag. Read the top hits that could hold the answer; trust the newer file when two disagree.
3. If search_notes misses, review the vault indexes below, then search the whole vault with Grep (try a few wordings) before giving up.
4. Only say you don't know after steps 1-3, and then say where you looked.
Never answer about the user's work or projects from memory alone; check the notes.
If a note you rely on is marked confidence: low or contested, say so.
If the answer took several notes (or notes plus the web) and the user is likely to ask again, save it back into the vault as agent-os/README.md says ("Save good answers back") and tell them in one sentence.

Skills grow from use: when the user asks for the same kind of thing a second time (a repeated prompt, a repeated chore), say so in one sentence and offer to turn it into a skill with the learn skill; a new skill needs their yes. When they paste a tip, thread, video or page about how to do something, offer to turn it into a skill the same day.

Progress: for any job with three or more steps, start with your task list (TaskCreate for each step, or TodoWrite if that is what you have) and keep it current with TaskUpdate (one in_progress at a time, mark each completed as it finishes). The app shows that list as a progress bar above the input box. Skip it for quick lookups.

Models: you start on the cheapest model that fits the question, to save cost (see the model-selection skill). Never switch up on your own. If the task is harder than your current model can do well (real multi-file code changes, a bug with no obvious cause, a design trade-off, or you are guessing), call request_model with a one-sentence plain-words reason and a short handoff brief for the stronger model (goal, what you tried, files involved, why you are stuck); the user gets a yes/no card. Ask once per task, not on every turn. On yes, say one short line and stop: the app carries on with the task on the stronger model straight away. On no, carry on and say plainly where you may fall short.

Helpers (subagents): you can hand parts of a job to helpers, but only after the user says yes. When you think a job needs helpers (it splits into independent pieces, like checking several notes or projects or a web search plus a vault search, or it is a big read-through whose details you don't need in your own head), call request_helpers once, with the helpers you want, each one's job in plain words, and a one-sentence reason. They get a yes/no card (and may ask questions first). On yes, start them with the Agent tool, only the ones they approved; on no, do it yourself, and don't ask again for this question. Do not ask for a quick lookup or anything you can do in a step or two. Pick the cheapest helper that fits: "scout" (Haiku, reads and searches only, never changes anything) for finding and reading; "worker" (Sonnet, can edit files and run commands, same rules as you) for jobs that change things. At most four at once; several Agent calls in one message run side by side. Helpers save tokens only if they are well briefed, so before you ask, look at the skills index and the vault indexes you already have and decide which skills and notes apply. Then write each helper a complete brief, because it knows nothing of this chat: the goal, the exact skills/<name>/SKILL.md files to read first (the how is already written down there; it saves the helper from working it out or fetching it from the web), the vault notes to start from, and what to hand back (short, plain facts with file paths). Tell it the web is a last resort: only what the skills and the vault can't answer, one targeted search, a short extract with the source link rather than whole pages. Helpers always run while you wait (the app makes sure of that), so don't ask for the background. A helper's risky actions stop for the user's yes/no exactly like yours do; helpers can't switch models. Check what they hand back before you rely on it, then answer in your own voice; don't paste their reports at the user. If a helper had to go to the web, offer to save what it found into the vault (or into a skill) so nobody fetches it twice. Say in a few words what you handed off.

Other models (workers): besides helpers, the user can set up non-Claude workers in Settings > Other models, reached through the company gateway. They are not you and not helpers: you write the instructions, they do the work, you check it. Use ask_worker when the user asks for one by name ("have Codex do this", "ask ChatGPT"), or suggest one when a job fits its "good for" note (agent-os/Worker_Strengths.md has what is known so far); the user gets one yes/no card per launch. An agent worker (Codex) works in a scratch folder on copies of the files you name, so write it a complete brief: the goal, which files, what done looks like. When it finishes, read what it changed in the scratch folder before relying on it, copy back only what is worth keeping (Write/Edit into the notes folder, backed up as usual), and say in a sentence what it did and what you kept. Then ask one short line, "Was Codex a good fit for this?", and add the answer to the Observed table in agent-os/Worker_Strengths.md.`;

// Helpers Agentic OS can hand work to (the Agent tool, after the user's yes to request_helpers). Cheapest tier that fits; neither can hand work on or ask for a model.
// The same short rules are also added to every brief by the hook in send(), so they hold even if Agentic OS forgets them.
const HELPER_RULES = "Working rules (from the app): 1) Read every skills/<name>/SKILL.md file this brief names before anything else, and follow it. 2) Check the wiki before the web: start from the notes named above, then the vault indexes and Grep. 3) The web is a last resort for what the skills and notes can't answer: one targeted search, then fetch only the one page that answers it. Never paste whole pages; hand back a short extract plus the source link. 4) Be brief: under 150 words, answer first, file paths after, and say plainly what you could not find.";
const NO_HELPER_TOOLS = ['Agent', 'Task', 'mcp__aos__request_helpers', 'mcp__aos__request_model', 'mcp__aos__use_connectors', 'mcp__aos__register_tool', 'mcp__aos__window', 'mcp__aos__ask_worker'];
const HELPERS = {
  scout: {
    description: 'Finds and reads things in the wiki or on the web and reports short plain facts with file paths. Read-only: it never changes anything. Use for lookups, comparisons and read-throughs.',
    prompt: "You are a scout working for Agentic OS in the user's notes folder (your working directory). First read any skills/<name>/SKILL.md files the brief names: they hold the how, so you don't have to work it out or look it up. Then find what the brief asks for in the notes it names, the vault indexes, and Grep. The web is a last resort for what those can't answer. You change nothing. Report back briefly: the answer first, then the file paths you relied on, and say plainly what you could not find or what looked contested or low-confidence. No padding.",
    tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
    model: 'haiku',
    maxTurns: 25,
  },
  worker: {
    description: 'Does a self-contained job that changes things (edit notes, create files, run commands) and reports what it did. Use for parallel pieces of a bigger job, each with its own clear brief.',
    prompt: "You are a worker doing one self-contained job for Agentic OS in the user's notes folder (your working directory). First read any skills/<name>/SKILL.md files the brief names and follow them; check the notes before the web, and use the web only for what they can't answer. Do exactly what the brief says, no more. Follow the vault's own rules in agent-os/README.md before writing into it (frontmatter, link new pages from the right index, add a log.md entry). Every file you edit is backed up first; stick to full paths. Report briefly what you changed (file paths) and anything you could not do.",
    disallowedTools: NO_HELPER_TOOLS,
    model: 'sonnet',
    maxTurns: 40,
  },
};
// The instructions name this copy of the app, and the user by name when one was given in setup.
const APP_DIR = path.join(__dirname, '..');
function personalize(text) {
  const name = String(settings.get('userName') || '').trim();
  let t = String(text).split('__APP_DIR__').join(APP_DIR);
  if (name) t += `\n\nThe user's name is ${name}.`;
  return t;
}
const stripFrontmatter = (t) => t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();

// Every index.md in the vault (about 7k tokens on 2026-10-04), as [{ rel, text }].
function indexPages() {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase() === 'index.md') files.push(p);
    }
  })(vault.ROOT);
  return files.sort().map((p) => {
    const rel = path.relative(vault.ROOT, p).split(path.sep).join('/');
    let text = '';
    try { text = stripFrontmatter(fs.readFileSync(p, 'utf8')); } catch {}
    return { rel, text: text.slice(0, 6000) };
  });
}

// The folder layout as names only (nothing is opened, so a cloud-synced folder is not pulled down): folders to three levels
// with their file counts, so the model works out how this person keeps their files without being told or asking.
function folderMap() {
  const lines = [];
  const MAX_LINES = 160, SKIP = new Set(['node_modules', 'dist', 'build', '__pycache__', 'venv']);
  (function walk(dir, depth, indent) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const dirs = ents.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirs) {
      if (lines.length >= MAX_LINES) { if (lines[lines.length - 1] !== '…') lines.push('…'); return; }
      let n = 0;
      try { n = fs.readdirSync(path.join(dir, d.name), { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.')).length; } catch {}
      lines.push(`${indent}${d.name}/ (${n} file${n === 1 ? '' : 's'})`);
      if (depth < 3) walk(path.join(dir, d.name), depth + 1, indent + '  ');
    }
  })(vault.ROOT, 1, '');
  let top = [];
  try { top = fs.readdirSync(vault.ROOT, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name).slice(0, 30); } catch {}
  return (lines.length ? lines.join('\n') : '(no folders)') + (top.length ? `\nFiles at the top: ${top.join(', ')}` : '');
}

function folderContext(S) {
  if (S.lastFolder === null) return 'You have not opened any folder yet this session.';
  let names = [];
  try { names = fs.readdirSync(path.join(vault.ROOT, S.lastFolder)).filter((n) => !n.startsWith('.')).slice(0, 60); } catch {}
  return `You were last working in: ${S.lastFolder || '(vault root)'}/\nIt contains: ${names.join(', ')}`;
}

// Notes that changed outside Agentic OS (The user, another agent, or another chat of its) are passed to each chat with its next question.
function noteOutsideChanges(files) { for (const S of chats.values()) for (const f of files) S.outsideChanges.add(f); }

// The connected apps, as discovered at launch (connectors.cjs). Empty until the first check finishes.
const connectorNames = () => connectors.names().join(', ');
// The assistant's standing instructions are written once, when a chat's Claude session starts, and then sent unchanged with
// every question in it. Claude keeps a cached copy of a chat and only reuses it while everything
// before the new question is word-for-word the same; the instructions come first, so any change to them (a new folder,
// one edited index page) made the whole chat be read again at full price. What changes from question to question goes
// in with the question instead (questionContext). `fresh`: this question starts a new session.
const okfMode = () => { const m = settings.get('okfMode'); return okf.MODES.includes(m) ? m : null; };

// After a turn that created notes: give each a header, link it from its folder's index and log it (okf.cjs). Quiet and local.
function tidyNewNotes(S, emit) {
  if (!S.created.size) return;
  const rels = [...S.created];
  S.created.clear();
  const mode = okfMode();
  if (!mode || mode === 'leave') return;
  try {
    const r = okf.selfCorrect(vault.ROOT, mode, rels, { backup: policy.backup, onWrite: shared.markWritten });
    const lines = r.linked + r.indexes;
    const parts = [r.headers && `${r.headers} header${r.headers === 1 ? '' : 's'}`, lines && `${lines} index line${lines === 1 ? '' : 's'}`, r.logged && 'the log'].filter(Boolean);
    if (parts.length) emit({ type: 'note', message: `Tidied the new note${rels.length === 1 ? '' : 's'}: added ${parts.join(', ')}.` });
  } catch (e) { store.log('could not tidy new notes:', e); }
}

function systemAppend(S = chatFor('default'), fresh = true) {
  if (!fresh && S.standing) return S.standing.text;
  const pages = indexPages();
  const text = personalize([
    PERSONA, METHOD,
    '## Backups of files you changed\n' + policy.backupDir(),
    '## Connectors\nConnected apps' + (connectorNames() ? ` (${connectorNames()})` : '') + ' are not loaded in a chat by default, to save tokens. When the user asks for something that needs one, call use_connectors naming only the app(s) needed, with a short reason, and end your turn; the app carries on with just those loaded for the next few questions. Never call it for notes, files or web questions.',
    ...(okfMode() ? ['## How notes are kept\n' + okf.promptText(okfMode())] : []),
    '## Folder map (as it was when this chat began)\nFolders to three levels, with file counts. Work out for yourself how this person keeps their files, from these names, the index pages below if there are any, and a few files you open when it matters. Never ask them how their folders are organised, and do not ask them to run a scan or set anything up first.\n' + folderMap(),
    '## Vault indexes (as they were when this chat began)\n' + (pages.length ? '' : '(none: this folder has no index pages, so use the folder map above and search.)\n') + pages.map((p) => `### ${p.rel}\n${p.text}`).join('\n\n'),
  ].join('\n\n'));
  S.standing = { text, pages: new Map(pages.map((p) => [p.rel, p.text])) };
  S.said = {}; // nothing has been said with a question yet in this session
  return text;
}

// What has changed since Agentic OS was last told, sent with the question as a note from the app (a UserPromptSubmit hook in
// send(), so it never lands in the user's own words in the session log). Each part is only sent when it differs from
// what this session was last told, so it doesn't pile up in a long chat. Returns '' when there is nothing new.
function questionContext(S) {
  const said = S.said || (S.said = {});
  const parts = [];
  const tell = (key, value, text) => { if (value && said[key] !== value) parts.push(text); said[key] = value; };
  const where = folderContext(S);
  tell('where', where, '## Where you were\n' + where);
  tell('others', running().length > 1 ? 'yes' : '', "## Other chats\nthe user has other chats with you running right now. They can edit the same wiki, so re-read a note just before you change it, and keep edits small.");
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

// The organisation's gateway, when one is set up: an address and a key (or, for a Bedrock-style gateway, an address
// alone). null means Claude Code talks to Anthropic with a key or the user's own sign-in.
function gatewayCfg() {
  const p = settings.get('provider');
  if (p.id !== 'claude' || p.method !== 'key') return null;
  const baseUrl = String(p.baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) return null;
  const g = p.gateway || {};
  const style = g.style === 'bedrock' ? 'bedrock' : 'anthropic';
  const key = settings.getSecret('key:claude') || settings.envOr('ANTHROPIC_API_KEY') || '';
  const headers = settings.getSecret('headers:claude');
  if (!key && !(style === 'bedrock' && (headers || baseUrl))) return null;
  return { baseUrl, key, keyHeader: p.keyHeader === 'x-api-key' ? 'x-api-key' : 'bearer', style, headers, disableBetas: !!g.disableBetas, certFile: g.certFile || '', models: p.models || {},
    keyVar: g.keyVar || 'ANTHROPIC_AUTH_TOKEN', skipAuth: g.skipAuth !== false, region: g.region || '', extraEnv: g.extraEnv || {}, modelOverrides: g.modelOverrides || {} };
}

const mode = () => (gatewayCfg() || loadKey() ? 'api' : 'plan');

function authEnv() {
  const key = loadKey();
  const env = { ...process.env };
  // The bundled Claude Code must not update itself, and nothing in it reports out: no usage reports, error reports,
  // surveys or marketplace installs. Through a gateway these are on by default, so they are always switched off here.
  Object.assign(env, { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_FEEDBACK_COMMAND: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1' });
  const g = gatewayCfg();
  // With a key or a gateway the engine gets a config folder of its own with no login in it. Checked against the real engine:
  // if this PC has a Claude login, the engine sends that login's token to the gateway instead of the gateway's key. A
  // company gateway must never see someone's personal Claude login, and a key must mean the key.
  if (g || key) env.CLAUDE_CONFIG_DIR = engineHome();
  // Whatever routing variables this PC happens to have are cleared first; then only what the user chose in Agentic OS is set.
  if (g) return gateway.applyToEnv(env, g); // every model call goes to the gateway, with the key it issued
  for (const v of gateway.ROUTING_VARS) delete env[v];
  if (key) env.ANTHROPIC_API_KEY = key; // an Anthropic key; with neither, Claude Code uses its own sign-in
  return env;
}

// The engine's own config folder, used whenever a key or a gateway is set up (never when the Claude plan sign-in is used).
function engineHome() {
  const dir = path.join(app.getPath('userData'), 'engine-home');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the engine will say if it cannot use it */ }
  return dir;
}

// Settings handed to the engine itself (not environment variables).
// skipWebFetchPreflight: a web fetch must not first ask Anthropic whether the site is allowed. A work network may block that, and Agentic OS sends nothing to Anthropic that the user did not choose.
const engineSettings = (extra = {}) => {
  const g = gatewayCfg();
  // Bedrock gateways often map one Claude version to the company's own inference profile (an ARN); Claude Code reads that map from its settings.
  return { skipWebFetchPreflight: true, ...(g && g.style === 'bedrock' && Object.keys(g.modelOverrides).length ? { modelOverrides: g.modelOverrides } : {}), ...extra };
};

// Which model name is handed to Claude Code. Normally the exact Claude version. Through a gateway the names the user pinned
// (an Amazon Bedrock inference-profile name, say) only apply to the three plain names haiku, sonnet and opus, so those are used
// instead, and a tier with no pinned name falls back to sonnet rather than asking for a model the account may not have.
// The helpers: scouts ask for haiku. Through a gateway with no quick model pinned, there may be no haiku to ask for, so they use sonnet.
function helperDefs() {
  const g = gatewayCfg();
  if (!g || (g.models || {}).light) return HELPERS;
  return { ...HELPERS, scout: { ...HELPERS.scout, model: 'sonnet' } };
}

function engineModel(model) {
  const g = gatewayCfg();
  if (!g) return model;
  if (gatewayModels.ids.includes(model)) return model; // a model the gateway itself lists: asked for by its exact name
  const m = g.models || {};
  if (model === HAIKU) return m.light ? 'haiku' : 'sonnet';
  if (model === OPUS || model === FABLE) return m.strong ? 'opus' : 'sonnet';
  if (model === SONNET) return 'sonnet';
  return model;
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const { approve, setAllowEdits } = shared;
const askUser = shared.ask;

// The models the gateway says it has (its /v1/models list), fetched once per start and again when asked. Only Claude models
// can be driven by the engine, so those are the ones kept. Agentic OS never sends anything but a listing request here.
const gatewayModels = { ids: [], at: 0, error: '' };
async function refreshGatewayModels(force = false) {
  const g = gatewayCfg();
  if (!g) { gatewayModels.ids = []; return gatewayModels; }
  if (!force && gatewayModels.at && Date.now() - gatewayModels.at < 10 * 60 * 1000) return gatewayModels;
  const h = { 'anthropic-version': '2023-06-01', ...(g.keyHeader === 'x-api-key' ? { 'x-api-key': g.key } : { Authorization: 'Bearer ' + g.key }) };
  try {
    const res = await fetch(g.baseUrl + '/v1/models?limit=1000', { headers: h, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('the gateway answered ' + res.status);
    const body = await res.json();
    const list = (Array.isArray(body) ? body : body.data || body.models || []).map((m) => String(m.id || m.name || '')).filter((id) => /claude|anthropic/i.test(id)); // also catches Bedrock-style names such as us.anthropic.claude-sonnet-4-6
    gatewayModels.ids = [...new Set(list)].sort(); gatewayModels.error = '';
  } catch (err) { gatewayModels.error = String((err && err.message) || err); }
  gatewayModels.at = Date.now();
  return gatewayModels;
}
// Models the gateway lists but refuses for this app, learned when a request fails; shown greyed out in the picker.
const refused = new Map(); // id -> short reason
const niceId = (id) => id.replace(/^.*anthropic\./i, '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// A gateway can list a model and still refuse it for an app like this one (yours says "Model not available for Coding
// Agents" for Opus). Each listed model is asked once, a single word with a one-token answer, the first time the picker is
// opened; a refusal greys it out. Anything else that goes wrong (slow, busy) leaves the model selectable.
const probed = new Set();
async function probeGatewayModels() {
  const g = gatewayCfg();
  if (!g) return;
  const h = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(g.keyHeader === 'x-api-key' ? { 'x-api-key': g.key } : { Authorization: 'Bearer ' + g.key }) };
  await Promise.all(gatewayModels.ids.filter((id) => !probed.has(id)).map(async (id) => {
    probed.add(id);
    try {
      const res = await fetch(g.baseUrl + '/v1/messages', { method: 'POST', headers: h, body: JSON.stringify({ model: id, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }), signal: AbortSignal.timeout(30000) });
      if (res.status === 400 || res.status === 403 || res.status === 404) {
        const text = await res.text();
        if (/not available|not allowed|not permitted|E003|access/i.test(text)) refused.set(id, 'Not available through this gateway');
      }
    } catch { probed.delete(id); /* timed out or offline: try again next time the menu opens */ }
  }));
}

// What the picker by the input box offers. Straight to Claude: the four models. Through a gateway only the tiers it has been
// given are real choices (a gateway that maps Opus and Fable to one model shows that one model once, under its own name).
function pickChoices() {
  const auto = { id: null, name: 'Auto', note: 'Agentic OS picks the cheapest that fits' };
  const g = gatewayCfg();
  if (!g) return [auto, { id: 'haiku', name: 'Haiku', note: 'Quick lookups, cheapest' }, { id: 'sonnet', name: 'Sonnet', note: 'Everyday work' }, { id: 'opus', name: 'Opus', note: 'Harder tasks and code' }, { id: 'fable', name: 'Fable', note: 'The strongest, costliest' }];
  const out = [auto];
  for (const id of gatewayModels.ids) out.push({ id, name: niceId(id), note: refused.get(id) || id, unavailable: refused.has(id) });
  if (out.length === 1) { // the list could not be read: fall back to the tiers the gateway was set up with
    const m = g.models || {}, std = m.standard || '';
    if (m.light && m.light !== std) out.push({ id: 'haiku', name: 'Light', note: m.light });
    out.push({ id: 'sonnet', name: 'Standard', note: std || 'Everyday work' });
    if (m.strong && m.strong !== std) out.push({ id: 'opus', name: 'Strong', note: m.strong });
  }
  return out;
}

function status() {
  if (gatewayCfg() && !gatewayModels.at) refreshGatewayModels().catch(() => {});
  const on = running();
  return { ready: true, choices: pickChoices(), mode: mode(), model: lastModelUsed, busy: on.length > 0, running: on.map((S) => S.id), allowEdits: shared.getAllowEdits() };
}

// Stop one chat (its running work and any card it is waiting on), or every chat when no id is given.
function stop(chatId) {
  const all = chatId == null;
  shared.cancel(chatId);
  for (const S of chats.values()) if (S.abort && (all || S.id === chatId)) S.abort.abort();
  return true;
}

// Make sure a chat exists in the backend and, for one reopened from disk, carries on its Claude session.
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

// The text of an assistant message, for matching what an error says.
const assistantText = (m) => (m.message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');

// `resumed`: this is the automatic carry-on after the user said yes to a stronger model, so the
// reply continues in the same bubble (no second 'start').
async function send(chatId, text, emit, files = [], resumed = false, auto = false) {
  const S = chatFor(chatId);
  // Every event carries its chat, so the window (and Discord) can tell the chats apart.
  const raw = emit;
  emit = (e) => raw({ ...e, chat: S.id });
  // The user's question still wins, but the lessons pass deserves to finish its save rather than be cut off
  // mid-edit: give it a bounded grace period to end on its own before forcing it to stop.
  if (S.abort && S.autoRun && !auto) {
    emit({ type: 'note', message: 'Finishing the lessons pass before starting on this...' });
    for (let i = 0; S.abort && S.autoRun && i < AUTO_WRAP_GRACE_MS / 200; i++) await new Promise((r) => setTimeout(r, 200));
    if (S.abort) { stop(S.id); for (let i = 0; S.abort && i < 30; i++) await new Promise((r) => setTimeout(r, 100)); }
  }
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
  if (auto) {
    // Quiet: no reply bubble, no voice. Only the graph lighting, usage counts and one closing note get through.
    const real = emit;
    let said = '';
    let failed = ''; // a failed run must not report "Nothing to save" (it did on 2026-10-04)
    emit = (e) => {
      if (e.type === 'text') said += e.text;
      else if (e.type === 'error') failed = failed || e.message;
      else if (e.type === 'done') {
        jobs.mark('lessonsPass', { ok: !failed, ms: Date.now() - t0, note: failed || said.trim() || 'Nothing to save.' });
        real({ type: 'note', message: failed ? `Lessons pass couldn't run, so nothing was checked: ${failed}` : `Lessons pass: ${said.trim() || 'Nothing to save.'}` });
        real(e);
      }
      else if (e.type !== 'start' && e.type !== 'audio') real(e);
    };
    real({ type: 'note', message: `Lessons pass: gathering lessons from the last ${AUTO_WRAP_EVERY} questions...` });
  } else if (!resumed) { S.turns++; S.helperBudget = 0; } // a yes to helpers covers one question
  S.autoRun = auto;
  // before 'start', so the reply bubble stays the last chat item
  if (!resumed) emit({ type: 'start' });
  const resumeId = S.sessionId || null; // null: this question starts a new Claude session, so its cost counter starts at zero
  const model = auto ? SONNET : (S.lastModel = lastModelUsed = pickModel(S, text, files.length > 0)); // the background pass doesn't eat a step-up turn
  const append = systemAppend(S, !resumeId);
  const context = questionContext(S); // goes in with the question, below
  S.outsideChanges = new Set(); // it has been told now
  // Connectors (Gmail, Drive...) put their whole tool lists in the chat, so they load only when Agentic OS asked for them (use_connectors).
  const cMode = connectors.mode();
  const withConnectors = !auto && (cMode === 'always' || (cMode === 'ondemand' && S.connectorsLeft > 0));
  if (withConnectors && cMode === 'ondemand' && !resumed) S.connectorsLeft--;
  // On demand, only the apps Agentic OS asked for stay in; the other connected apps are removed from the chat by name.
  const deny = withConnectors && cMode === 'ondemand' ? connectors.servers().filter((s) => !S.connectorApps.has(s.key)).map((s) => `mcp__${s.key}`) : [];
  let connectorsCarry = false; // Agentic OS called use_connectors: carried on once this turn ends, with them loaded
  let carryOn = false; // the user said yes to a stronger model: the handoff brief (or true), carried on once this turn ends

  const aos = createSdkMcpServer({ name: 'aos', version: '1.0.0', tools: [
    // Agentic OS can move its own window on request (window.cjs).
    tool('window', "Move or resize the Agentic OS window, when the user asks (e.g. 'go full screen', 'move to the left', 'other monitor').",
      { action: z.enum(win.ACTIONS) },
      async ({ action }) => ({ content: [{ type: 'text', text: win.control(action) }] })),
    // Agentic OS shows a vault file in the app's own viewer (the same one a file-tree click opens).
    tool('open_file', 'Open a vault file in the Agentic OS viewer so the user can see it. Use this, not Start-Process, when they ask to see or open a note.',
      { path: z.string().describe('Path inside the vault, relative to its root, e.g. projects/Example/README.md') },
      async ({ path: p }) => {
        const abs = vault.resolveInside(String(p).replace(/\\/g, '/'));
        const say = (t) => ({ content: [{ type: 'text', text: t }] });
        if (!abs || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return say(`No file at "${p}" inside the vault. Check the path and try again.`);
        const rel = path.relative(vault.ROOT, abs).split(path.sep).join('/');
        emit({ type: 'open', path: rel });
        return say(`Opened ${rel} in the viewer.`);
      }),
    // Search over the whole vault and saved chats (search.cjs): BM25 over summaries and exact atoms, recency boost, stale_when shown.
    tool('search_notes', 'Search every note in the vault and every saved chat by words or a plain question. Returns the best matches, newest first among close ones, each with its path, project, type, date, a short summary, and a STALE WHEN flag if the note says when it stops being true. Start here to find a file, then Read the top hits. A result whose path starts with chat: is a past conversation, not a file.',
      { query: z.string().describe('Key words or a short question, e.g. "SailPoint capability open questions" or "who owns the OMI intake".'), limit: z.number().int().min(1).max(15).optional(), documents_only: z.boolean().optional().describe('true: only finished documents (Output and Client Facing folders), for "find the doc" requests.') },
      async ({ query, limit, documents_only }) => {
        await search.ensureFresh();
        return { content: [{ type: 'text', text: search.format(search.query(String(query || ''), { limit: limit || 8, scope: documents_only ? 'output' : 'all' })) }] };
      }),
    // Agentic OS asks for the connectors only when a task needs one. No card: the user already asked for the task.
    tool('use_connectors', `Load just the connected app(s) a task needs${connectorNames() ? ` (${connectorNames()})` : ''}. Apps are not loaded by default, to save tokens. Call this only when the user asks for something that needs one, naming only the app(s) needed, then end your turn.`,
      { apps: z.array(z.string()).min(1).describe('Only the apps this task needs, by name, e.g. ["Gmail"].'), reason: z.string().describe('One short phrase: why.') },
      async ({ apps, reason }) => {
        const say = (t) => ({ content: [{ type: 'text', text: t }] });
        if (cMode === 'never') return say("Connectors are switched off in the user's Connectors settings. Tell them plainly that they can turn them to 'Only when needed' there; do not try another way.");
        if (cMode === 'always') return say('All the connectors are already loaded; use them directly.');
        const { keys, unknown } = connectors.pick(apps);
        if (!keys.length) return say(`No connected app matches ${apps.join(', ')}. ${connectorNames() ? `Connected: ${connectorNames()}.` : 'None are known yet; the user can press Refresh in the Connectors panel.'} Tell them plainly if it is not connected.`);
        const missing = keys.filter((k) => !S.connectorApps.has(k));
        if (withConnectors && !missing.length) return say(`${apps.join(', ')} is already loaded; use it directly.`);
        keys.forEach((k) => S.connectorApps.add(k));
        S.connectorsLeft = CONNECTOR_TURNS;
        connectorsCarry = String(reason || '').slice(0, 200) || true;
        return say(`Loading ${keys.length > 1 ? 'them' : 'it'} now${unknown.length ? ` (not connected: ${unknown.join(', ')})` : ''}. Say one short line (like "Grabbing Gmail.") and end your turn. Do no more work this turn: the app carries on with the task straight away, with it ready.`);
      }),
    // Agentic OS asks to move up to a stronger model; only the user's yes makes it happen.
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
    // "Look through my folder": the same read-only scan as setup (discover.cjs: names and sizes, no AI, nothing written),
    // run only when the user asks for it in chat. Agentic OS gets the short report instead of opening every file itself.
    tool('look_through_folder', 'Take a quick read-only look at the notes folder (or one folder inside it): counts of notes and other files, how organised they are (headers, index pages), the biggest areas, large files, and names that look like passwords or keys. Free and fast: no files are opened or changed. Use it when the user asks what is in their folder, how it is organised, or for help setting it up or tidying it; then explain the result in plain words and suggest next steps.',
      { folder: z.string().optional().describe('A folder inside the vault, relative to its root. Leave out for the whole notes folder.') },
      async ({ folder }) => {
        const say = (t) => ({ content: [{ type: 'text', text: t }] });
        const abs = folder ? vault.resolveInside(String(folder).replace(/\\/g, '/')) : vault.ROOT;
        if (!abs || !fs.existsSync(abs)) return say(`No folder at "${folder}" inside the notes folder.`);
        const r = await discover.scanAsync(abs);
        if (r.error) return say(r.error);
        const { root, ...rest } = r;
        const note = r.partial ? ' The folder was slow to read (perhaps cloud-synced), so the look stopped early: these are partial counts; say so.' : r.headersSkipped ? ' It looks cloud-synced, so no notes were opened to check headers.' : '';
        return say(`Look through ${folder || 'the notes folder'}:${note} ${JSON.stringify(rest)}`);
      }),
    // Skill use from the session logs (insights.cjs), so skill-tidy never has to count by hand. Read-only.
    tool('skill_use', "How much each skill in this vault has been used: last used, uses in the last 30 days and the last 90, counted from the app's own session logs. Free, fast, read-only. Also says how far back the log reaches, because a skill with no uses can only be called unused for that long. Use it for skill-tidy and for any 'which skills do I use' question; never count by searching chats.",
      {},
      async () => {
        const say = (t) => ({ content: [{ type: 'text', text: t }] });
        try {
          const r = await require('./insights.cjs').skillUse();
          return say(`Log starts ${r.loggedSince || 'unknown'}. Skill use (name, last used, uses in 30 days, uses in 90 days; fewest first):\n` + r.rows.map((x) => `${x.name}, ${x.lastUsed || 'never'}, ${x.uses30}, ${x.uses90}`).join('\n'));
        } catch (e) { return say(`Could not read the skill-use log: ${e.message}`); }
      }),
    // Agentic OS asks before handing parts of a job to helpers; the Agent hook below only lets approved helpers start.
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
    // Called once, after Agentic OS has already installed something and confirmed it works (not before —
    // installing is a normal risky action, asked about the usual way, not through this tool). This just
    // records it so the Connectors & Tools panel can show and track it.
    tool('register_tool', "Record a CLI tool that is installed and confirmed working, so it shows up in the Connectors & Tools panel with usage tracking and a disconnect/remove option. Call this once, after installing or when you find one that is installed but missing from the panel — never to ask permission to install (ask the user plainly first, the normal way).",
      { name: z.string().describe('Plain name for the tool, e.g. "TWG CLI".'),
        icon: z.string().nullable().optional().describe('A short hint for its badge; usually not needed, a letter badge is used by default.'),
        skills: z.array(z.string()).min(1).describe('The skill folder names under this vault\'s skills/ it owns (e.g. ["twg","twg-jira"]), already in place.'),
        binary: z.string().nullable().optional().describe('The program name, e.g. "twg.exe", if there is one.'),
        uninstall: z.object({ type: z.enum(['msi', 'manual']), path: z.string() }).nullable().optional()
          .describe('How "Remove completely" should undo the install: an MSI file/product code to run msiexec /x against, or the install folder to delete if there is no uninstaller.') },
      async ({ name, icon, skills: skillNames, binary, uninstall }) => {
        const say = (t) => ({ content: [{ type: 'text', text: t }] });
        const missing = skillNames.filter((n) => !fs.existsSync(path.join(vault.ROOT, 'skills', n)));
        if (missing.length) return say(`Not registered: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in this vault's skills/ folder yet. Copy the skill files there first, then call register_tool again.`);
        const entry = tools.register({ name, icon: icon || null, skills: skillNames, binary: binary || null, uninstall: uninstall || null });
        return say(`Registered ${entry.name} in Connectors & Tools, tracking ${skillNames.join(', ')}. Tell the user plainly it's ready, and that they can see it, disconnect it, or remove it completely from the Connectors & Tools panel.`);
      }),
    // Other models (workers.cjs). One yes/no card per launch; the worker then runs unattended in a scratch folder.
    tool('ask_worker', `Hand a job to one of the user's other models (not Claude), through the company gateway, after one yes/no card. Use when the user asks for one by name, or when a job fits its "good for" note. Available: ${workers.CATALOG.map((w) => `${w.id} (${w.name}, ${w.kind === 'agent' ? 'coding agent that edits copies of files' : 'one prompt, one answer'}; good for: ${w.goodFor})`).join('; ')}. An agent worker gets copies of the files you list in a scratch folder and changes only those copies; you review and copy back.`,
      { worker: z.enum(workers.CATALOG.map((w) => w.id)),
        task: z.string().describe('The complete brief: the goal, which files, what done looks like. The worker knows nothing of this chat.'),
        files: z.array(z.string()).max(50).optional().describe('Vault-relative paths (files or folders) to copy into its scratch folder.'),
        reason: z.string().describe('One plain-words sentence for the card: why this worker fits.') },
      async ({ worker: id, task, files: list = [], reason }, extra) => {
        const say = (t) => ({ content: [{ type: 'text', text: t }] });
        if (auto) return say('Other models are not available for this background pass; do it yourself.');
        const w = workers.byId(id);
        const { yes, question } = await askUser(emit, extra?.signal || abort.signal, S, {
          tool: 'ask_worker',
          summary: `hand this to ${w.name}: ${String(task).slice(0, 160)}`,
          what: `${String(reason).slice(0, 220)} ${list.length ? `It works on copies of ${list.length} file${list.length === 1 ? '' : 's'} in a scratch folder; nothing in your notes changes until Agentic OS reviews it.` : 'It works in an empty scratch folder; nothing in your notes changes.'} Uses your ${w.name} key from Settings > Other models.`,
          spoken: `hand this to ${w.name}`,
        });
        if (question) return say(`Nothing started. The user has not said yes or no yet; they asked: "${question}". Answer them plainly, then ask again with ask_worker if it still fits.`);
        if (!yes) return say(`The user said no to ${w.name}. Do it yourself, and do not ask again for this task.`);
        emit({ type: 'toolActive', id: `worker-${w.id}`, name: w.name, icon: null, color: w.color });
        const r = await workers.run({ id, task, files: list, signal: extra?.signal || abort.signal });
        const where = `Scratch folder: ${r.dir || '(none)'}.`;
        if (!r.ok) return say(`${w.name} did not finish. ${r.error} ${where} Tell the user plainly; if the error points at setup (key, gateway address, model name), say what to check in Settings > Other models.`);
        const secs = Math.round(r.ms / 1000);
        return say(`${w.name} finished in ${secs}s. ${where}\nFiles copied in: ${r.copied.join(', ') || 'none'}.\nFiles it created or changed (paths relative to the scratch folder): ${r.changed.join(', ') || 'none'}.\nIts final message:\n${r.text || '(none)'}\n\nNow read the changed files in the scratch folder, check them, and copy back only what is worth keeping into the notes folder with Write/Edit (backed up as usual). Tell the user in a sentence what ${w.name} did and what you kept, then ask one short line: "Was ${w.name} a good fit for this?" and add their answer to the Observed table in agent-os/Worker_Strengths.md.`);
      }),
  ] });

  // Every action outside the always-allowed list comes through here (see policy.cjs).
  // Helpers' tool calls come through here too (agentID is set), so they get exactly the same gate as Agentic OS.
  const canUseTool = async (tool, input, { signal, agentID }) => {
    const c = policy.check(tool, input);
    const preApproved = false; // only irreversible actions reach here now; each one asks
    if (c.ask && preApproved) emit({ type: 'autoApproved', summary: c.summary });
    if (c.ask && !preApproved) {
      const what = typeof input?.description === 'string' ? input.description : '';
      const { yes, question } = await askUser(emit, signal, S, { tool, summary: c.summary, what, spoken: c.spoken || c.summary, risky: !!c.risky, helper: !!agentID });
      if (question) return { behavior: 'deny', message: `Nothing was run. The user has not said yes or no yet; they asked: "${question}". Answer them plainly, no jokes: what this does, why it is needed, what could go wrong, and any safer option. Then, if it is still the right move, try the exact same action again so they get a fresh yes/no card. Do not do it any other way.` };
      if (!yes) return { behavior: 'deny', message: 'The user said no. Drop this action and do not try another way to do it; tell them briefly you have left it.' };
    }
    // Deletes and > overwrites by command run unasked because they are copied to the backup folder first.
    // If a copy fails, the command does not run (a delete with no backup is not recoverable).
    for (const b of c.backups || []) {
      if (!policy.backupAny(b) && fs.existsSync(b)) return { behavior: 'deny', message: `Not run: the safety copy of ${b} could not be made first. Tell the user plainly and ask before trying another way.` };
    }
    const p = touchedPath(input);
    if (EDIT_TOOLS.has(tool) || tool === 'NotebookEdit') {
      if (tool === 'Write' && p !== null && !fs.existsSync(path.resolve(vault.ROOT, p))) S.created.add(p);
      policy.backup(path.resolve(vault.ROOT, String(input.file_path || input.notebook_path || '')));
      if (p !== null) {
        shared.markWritten(p);
        for (const o of chats.values()) if (o !== S) o.outsideChanges.add(p); // the other chats didn't make this edit
      }
    }
    return { behavior: 'allow', updatedInput: input };
  };
  const helpers = new Map(); // Agent tool_use id -> helper, added when the hook lets it start (so a refused call shows nothing)
  // The step list for the tracker (Chat.tsx), built from TaskCreate / TaskUpdate calls (TodoWrite sends its whole list at once).
  const tasks = new Map(); // task id -> { content, status }
  const taskCalls = new Map(); // TaskCreate tool_use id -> task, waiting for the result that carries its id
  const sendPlan = () => emit({ type: 'plan', todos: [...tasks.values()].slice(0, 30) });
  const resultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.text) || '').join(' ') : '');
  try {
    const q = query({
      prompt: files.length ? `${text}\n\n[The user attached ${files.length === 1 ? 'a file' : `${files.length} files`}. Look at ${files.length === 1 ? 'it' : 'them'} with the Read tool before you answer: ${files.join(' ; ')}]` : text,
      options: {
        cwd: vault.ROOT,
        model: engineModel(model),
        ...(S.effort && !auto && model !== HAIKU ? { effort: S.effort } : {}), // Haiku has no effort setting
        resume: resumeId || undefined,
        includePartialMessages: true,
        abortController: abort,
        systemPrompt: { type: 'preset', preset: 'claude_code', append },
        // Looking is always fine; everything else goes through canUseTool / policy.cjs.
        allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'mcp__aos__window', 'mcp__aos__open_file', 'mcp__aos__look_through_folder', 'mcp__aos__search_notes', 'mcp__aos__skill_use', 'mcp__aos__request_model', 'mcp__aos__use_connectors', 'mcp__aos__request_helpers', 'mcp__aos__register_tool', 'mcp__aos__ask_worker'],
        mcpServers: { aos },
        agents: helperDefs(), // scout and worker, for the Agent tool (see METHOD)
        // The Agent tool never reaches canUseTool, so this hook is its gate: only helpers the user said yes to
        // (request_helpers), only our two kinds (cheap, with known tools), no model/permission overrides, and they
        // run while Agentic OS waits (the default is the background, which would let its turn end while they work).
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
        // Shared skills live in skills/; the vault root is a plugin named "aos" (.claude-plugin/plugin.json).
        plugins: [{ type: 'local', path: vault.ROOT }],
        skills: 'all',
        additionalDirectories: [policy.backupDir(), attachments.dir(), workers.scratchRoot()], // restore old versions; read what the user drops in; review a worker's scratch folder
        permissionMode: 'default',
        canUseTool,
        settingSources: [],
        // Connectors stay out of the chat unless asked for, and then only the app needed (see withConnectors, deny).
        settings: engineSettings({ disableClaudeAiConnectors: !withConnectors }),
        disallowedTools: deny,
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

    let errored = false; // an error already went to the window for this question
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
          // A skill call is a tool_use named "Skill" with input { skill: "aos:<name>" } (seen in the session logs, 2026-10-04).
          if (b.name === 'Skill' && b.input && typeof b.input.skill === 'string') {
            const skillName = b.input.skill.replace(/^aos:/, '');
            skillsUsed.push(skillName);
            // The name badge in Chat.tsx: shown the moment a registered tool's skill is actually used.
            const owner = tools.ownerOf(skillName);
            if (owner && !byHelper) emit({ type: 'toolActive', ...owner });
          }
          const p = touchedPath(b.input);
          if (p !== null && !byHelper) rememberFolder(p, S);
          // The step tracker above the input box (Chat.tsx): a TodoWrite list is the job's plan; helper steps carry their parent.
          if (b.name === 'TodoWrite' && !byHelper && b.input && Array.isArray(b.input.todos)) {
            emit({ type: 'plan', todos: b.input.todos.slice(0, 30).map((t) => ({ content: String((t && t.content) || '').slice(0, 140), status: ['pending', 'in_progress', 'completed'].includes(t && t.status) ? t.status : 'pending' })) });
          }
          if (b.name === 'TaskCreate' && !byHelper && b.input) taskCalls.set(b.id, { content: String(b.input.subject || '').slice(0, 140), status: 'pending' });
          if (b.name === 'TaskUpdate' && !byHelper && b.input && b.input.taskId != null) {
            const id = String(b.input.taskId);
            const t = tasks.get(id);
            if (b.input.status === 'deleted') tasks.delete(id);
            else if (t) {
              if (b.input.subject) t.content = String(b.input.subject).slice(0, 140);
              if (['pending', 'in_progress', 'completed'].includes(b.input.status)) t.status = b.input.status;
            }
            sendPlan();
          }
          emit({ type: 'tool', name: b.name, input: b.input, path: p, helper: byHelper || undefined, parent: m.parent_tool_use_id || undefined });
        }
        if (m.error && !byHelper) { errored = true; emit({ type: 'error', message: (gatewayCfg() && gateway.friendlyError(`${m.error} ${assistantText(m)}`)) || AUTH_HELP[m.error] || `Claude error: ${m.error}` }); }
      } else if (m.type === 'user' && !m.parent_tool_use_id && m.message && Array.isArray(m.message.content)) {
        // A helper's hand-back arrives as the result of the Agent call that started it.
        for (const b of m.message.content) {
          if (b.type === 'tool_result' && taskCalls.has(b.tool_use_id)) {
            const t = taskCalls.get(b.tool_use_id);
            taskCalls.delete(b.tool_use_id);
            const num = /Task #(\d+)/.exec(resultText(b.content));
            if (num && !b.is_error) { tasks.set(num[1], t); sendPlan(); }
            continue;
          }
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
        // A failed call through a gateway: say what to ask its owner for, in plain words.
        if (m.is_error && !errored && gatewayCfg()) { errored = true; emit({ type: 'error', message: gateway.friendlyError(String(m.result || '')) || `The gateway returned an error: ${String(m.result || m.subtype || 'unknown').slice(0, 300)}` }); }
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
    const raw = String((err && err.message) || err);
    if (/E003|not available for/i.test(raw) && gatewayModels.ids.includes(model)) { refused.set(model, 'Not available through this gateway'); if (S.pick === model) S.pick = null; }
    emit({ type: 'error', message: abort.signal.aborted ? 'Stopped.' : (gatewayCfg() && gateway.friendlyError(raw)) || raw });
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
      tidyNewNotes(S, emit);
      emit({ type: 'done' });
      // Every AUTO_WRAP_EVERY questions, wrap up quietly (not after a stop, and never after the wrap-up itself).
      if (!auto && !resumed && !stopped && myGen === S.gen && S.turns > 0 && S.turns % AUTO_WRAP_EVERY === 0) setImmediate(() => send(S.id, AUTO_WRAP_PROMPT, raw, [], false, true));
    }
    if (auto) S.autoRun = false;
  }
}

// Launch check, so the charge bar and the Connectors panel are right before the first question.
// Starts Claude Code with an input that never sends a message (no model call, no tokens), asks it for the plan's
// rate limits and for which connectors are connected (a few seconds while they connect), then shuts it down.
async function idleQuery() {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  let release;
  const gate = new Promise((r) => { release = r; });
  async function* idle() { await gate; }
  const q = query({ prompt: idle(), options: { cwd: vault.ROOT, settingSources: [], settings: engineSettings(), mcpServers: {}, env: authEnv() } });
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
// The cheapest model that can do a plain job: through a gateway, a Haiku it lists by name (the newest); otherwise the usual mapping.
async function lightModel() {
  if (gatewayCfg()) {
    await refreshGatewayModels();
    const h = gatewayModels.ids.filter((id) => /haiku/i.test(id) && !refused.has(id)).sort().pop();
    if (h) return h;
  }
  return null;
}
// A gateway can list a Haiku this account may not call (it answers 403 "Invalid Authentication"). When the Haiku picked by
// lightModel() is turned away, remember it as refused so it is not picked again, and run the job once on the pinned model (2026-10-26).
async function oneShot(opts) {
  const exactLight = opts.model === 'haiku' ? await lightModel() : null;
  try { return await oneShotOn(opts, exactLight); }
  catch (e) {
    if (!exactLight || !/authenticat|\b403\b|security token|not available|not allowed|not permitted|E003/i.test(String((e && e.message) || e))) throw e;
    refused.set(exactLight, 'Not available through this gateway');
    return oneShotOn(opts, null);
  }
}
async function oneShotOn({ system, prompt, schema, web = false, model: want, timeoutMs }, exactLight) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  // A model call that never answers must not hang its caller for good (a stuck mail pull blocked every later check, 2026-10-23).
  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abortController.abort(); }, timeoutMs || (web ? 5 * 60 * 1000 : 60 * 1000));
  const q = query({
    prompt,
    options: {
      abortController,
      cwd: vault.ROOT,
      model: exactLight || engineModel(want === 'haiku' ? HAIKU : SONNET),
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
      settings: engineSettings({ disableClaudeAiConnectors: true }),
      env: authEnv(),
    },
  });
  let result = null;
  try { for await (const m of q) if (m.type === 'result') result = m; }
  catch (e) { if (timedOut) throw new Error('the model call timed out'); throw e; }
  finally { clearTimeout(timer); }
  if (timedOut) throw new Error('the model call timed out');
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

module.exports = { refreshGatewayModels, probeGatewayModels, oneShot, account, personalize, PERSONA, METHOD, indexPages, folderContext, questionContext, CONFIRM, NICE, id: 'claude', refreshStartup, refreshConnectors, HAIKU, SONNET, authEnv, engineSettings, engineModel, helperDefs, SONNET, OPUS, HAIKU: HAIKU, isLight, send, stop, openChat, closeChat, status, mode, systemAppend, rememberFolder, chatFor, setPick, pickModel, approve, setAllowEdits, noteOutsideChanges, wroteRecently, HELPERS };

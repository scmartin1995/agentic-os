// The brain router. v1 had one brain (claude.cjs); v2 picks the engine that matches the provider chosen in
// onboarding (providers.cjs) and gives the rest of the app one set of calls whichever it is.
//
//   claude    -> claude.cjs      (Claude plan login or Anthropic key; everything)
//   universal -> universal.cjs   (any OpenAI-compatible API key, or a local model)
//   codex / agycli -> cli-engine.cjs (ChatGPT / Google account through their own CLIs; geminicli is retired)
//
// A saved chat remembers which engine its session belongs to: session ids from engines other than Claude are
// tagged "engine:id" on the way out. Reopened under a different brain, a chat keeps its messages on screen and
// simply starts a fresh session.
const providers = require('./providers.cjs');
const shared = require('./shared.cjs');
const claude = require('./claude.cjs');
const universal = require('./universal.cjs');
const cli = require('./cli-engine.cjs');

const ENGINES = { claude, universal, codex: cli, geminicli: cli, agycli: cli };
const name = () => providers.active().engine || 'claude';
const active = () => ENGINES[name()] || claude;

const tagOut = (n, id) => (n === 'claude' ? id : `${n}:${id}`);
function tagIn(sid) {
  if (typeof sid !== 'string' || !sid) return { engine: null, id: null };
  const m = sid.match(/^(universal|codex|geminicli|agycli):(.+)$/);
  return m ? { engine: m[1], id: m[2] } : { engine: 'claude', id: sid };
}

function send(chatId, text, emit, files = []) {
  const n = name();
  return active().send(chatId, text, (e) => emit(e.type === 'session' ? { ...e, id: tagOut(n, e.id) } : e), files);
}
function stop(chatId) { for (const e of new Set(Object.values(ENGINES))) e.stop(chatId); return true; }
function openChat(chatId, sid) {
  const t = tagIn(sid);
  return active().openChat(chatId, t.engine === name() ? t.id : null);
}
function closeChat(chatId) { for (const e of new Set(Object.values(ENGINES))) e.closeChat(chatId); return true; }
function noteOutsideChanges(files) { for (const e of new Set(Object.values(ENGINES))) e.noteOutsideChanges(files); }

// 'plan' (Claude plan windows), 'api' (spend against a budget) or 'sub' (a non-Claude subscription: tokens only).
const mode = () => active().mode();
function status() {
  const p = providers.active();
  const def = providers.byId(p.id);
  return { ...active().status(), mode: mode(), provider: { id: p.id, name: p.name, method: p.method, engine: name(), level: def.level } };
}

// Launch checks that only the Claude plan login has: plan limits and claude.ai connectors (no tokens).
const refreshStartup = (emit) => (name() === 'claude' ? claude.refreshStartup(emit) : Promise.resolve(false));
const refreshConnectors = () => (name() === 'claude' ? claude.refreshConnectors() : Promise.resolve(0));
const oneShot = (opts) => active().oneShot(opts);
const loadedConnectors = (id) => (name() === 'claude' && id ? claude.loadedConnectors(String(id)) : []);

module.exports = {
  send, stop, openChat, closeChat, status, mode, noteOutsideChanges, refreshStartup, refreshConnectors, oneShot, name, loadedConnectors,
  approve: shared.approve, wroteRecently: shared.wroteRecently,
};

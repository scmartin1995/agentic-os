// The brain, as the rest of the app sees it. Claude is the only one (claude.cjs); this module is the one set of calls
// main.cjs uses, so the window never needs to know which engine file is behind it.
const providers = require('./providers.cjs');
const shared = require('./shared.cjs');
const claude = require('./claude.cjs');

const name = () => 'claude';
const refreshModels = (force) => claude.refreshGatewayModels(force).then(() => claude.probeGatewayModels()).then(() => claude.status().choices);
const setPick = (chatId, model, effort) => claude.setPick(chatId, model, effort);
const send = (chatId, text, emit, files = []) => claude.send(chatId, text, emit, files);
const stop = (chatId) => claude.stop(chatId);
const openChat = (chatId, sid) => claude.openChat(chatId, typeof sid === 'string' && sid ? sid : null);
const closeChat = (chatId) => claude.closeChat(chatId);
const noteOutsideChanges = (files) => claude.noteOutsideChanges(files);

// 'plan' (Claude plan windows) or 'api' (spend against a budget: an Anthropic key or a gateway).
const mode = () => claude.mode();
function status() {
  const p = providers.active();
  return { ...claude.status(), mode: mode(), provider: { id: p.id, name: p.name, method: p.method } };
}

// Launch checks that only the Claude plan login has: plan limits and claude.ai connectors (no tokens).
const refreshStartup = (emit) => claude.refreshStartup(emit);
const refreshConnectors = () => claude.refreshConnectors();
const oneShot = (opts) => claude.oneShot(opts);

module.exports = {
  send, setPick, refreshModels, stop, openChat, closeChat, status, mode, noteOutsideChanges, refreshStartup, refreshConnectors, oneShot, name,
  approve: shared.approve, setAllowEdits: shared.setAllowEdits, wroteRecently: shared.wroteRecently,
};

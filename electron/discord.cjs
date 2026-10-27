// Agentic OS has no chat-app link. This stand-in keeps the callers in main.cjs simple: nothing is read, started or sent.
module.exports = { readConfig: () => ({}), start: () => {}, observe: () => {}, stop: () => {} };

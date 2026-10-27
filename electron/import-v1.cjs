// Agentic OS does not copy anything from another app's data folder. This stand-in answers "nothing found".
module.exports = { look: () => ({ found: false, groups: [], discord: false }), run: () => ({}) };

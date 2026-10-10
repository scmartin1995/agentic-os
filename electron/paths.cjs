// Where the optional voice tools live (whisper.cpp, Piper, the wake-word model: about 1.1 GB, not in git).
// The app looks in its own tools/ folder; AOS_TOOLS_DIR points it somewhere else. See docs/voice.md.
const path = require('path');

function toolsDir(name) {
  return path.join(process.env.AOS_TOOLS_DIR || path.join(__dirname, '..', 'tools'), name);
}

module.exports = { toolsDir };

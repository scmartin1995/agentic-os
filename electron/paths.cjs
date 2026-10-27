// Where optional voice tools live, if someone adds them (whisper.cpp, Piper, a wake-word model). Agentic OS looks only
// in its own tools/ folder, or in AOS_TOOLS_DIR. Nothing is borrowed from any other app on the machine.
const fs = require('fs');
const path = require('path');

function toolsDir(name) {
  const places = [process.env.AOS_TOOLS_DIR, path.join(__dirname, '..', 'tools')].filter(Boolean);
  for (const p of places) if (fs.existsSync(path.join(p, name))) return path.join(p, name);
  return path.join(places[places.length - 1], name);
}

module.exports = { toolsDir };

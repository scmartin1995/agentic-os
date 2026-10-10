// One-time sign-in for the Claude Code copy that the app runs (bundled with the Agent SDK).
// Opens Claude Code's own interactive prompt; type /login and finish in the browser.
// The app never sees the login - Claude Code stores it in your user profile, same as always.
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const dir = path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64');
const exe = fs.readdirSync(dir).find((f) => /^claude(\.exe)?$/i.test(f));
if (!exe) { console.error('Could not find the bundled Claude Code binary in', dir); process.exit(1); }
console.log('Starting Claude Code. Type /login, sign in in the browser, then /exit.\n');
const env = { ...process.env };
delete env.ANTHROPIC_API_KEY; // make sure it signs in with the claude.ai account, not a key
env.DISABLE_AUTOUPDATER = '1'; // never let it rename itself mid-update (it once broke the app); update via npm
spawnSync(path.join(dir, exe), [], { stdio: 'inherit', env });

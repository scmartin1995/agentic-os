// Saved conversations, so the user can flip back to an old chat after starting a new one.
// One JSON file per chat in the app's data folder: what the chat panel showed, plus the
// Claude session id so the assistant picks up where they left off.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const store = require('./store.cjs');

const dir = () => path.join(app.getPath('userData'), 'chats');
const safeId = (id) => (typeof id === 'string' && /^[a-z0-9-]{6,64}$/i.test(id) ? id : null);
const file = (id) => path.join(dir(), `${id}.json`);

function list(limit = 40) {
  let names = [];
  try { names = fs.readdirSync(dir()).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    // a damaged chat file is skipped, but logged (and a copy kept) so it is never a silent gap in the list
    const c = store.readJson(path.join(dir(), n), null);
    if (!c || typeof c !== 'object') continue;
    out.push({ id: c.id, title: c.title || 'Untitled chat', updated: c.updated || 0, count: Array.isArray(c.items) ? c.items.length : 0, interrupted: !!c.busy });
  }
  return out.sort((a, b) => b.updated - a.updated).slice(0, limit);
}

function load(id) {
  if (!safeId(id)) return null;
  return store.readJson(file(id), null);
}

function save(chat) {
  if (!chat || !safeId(chat.id)) return false;
  return store.tryWriteJson(file(chat.id), { ...chat, updated: Date.now() });
}

// A chat saved while it was still replying (busy: true) and never saved again was cut off, e.g. the app closed.
// Only from the chat list's own × button, which the user clicks themselves.
function remove(id) {
  if (!safeId(id)) return false;
  try { fs.unlinkSync(file(id)); return true; } catch { return false; }
}

module.exports = { list, load, save, remove };

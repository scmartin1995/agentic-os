// Last run of each thing that works on its own (Dreams, Lessons pass), for the Health panel's
// "Running on its own" list. One small JSON file in the app data folder.
const fs = require('fs');
const path = require('path');
const store = require('./store.cjs');
const { app } = require('electron');

const file = () => path.join(app.getPath('userData'), 'jobs.json');
function all() { return store.readJson(file(), {}); }

// name: 'dreams' | 'lessonsPass'. ok: finished without error. note: one short line.
function mark(name, { ok = true, ms = 0, note = '' } = {}) {
  const j = all();
  j[name] = { at: Date.now(), ok: !!ok, ms: Math.round(ms), note: String(note).slice(0, 200) };
  store.tryWriteJson(file(), j); // not worth failing a run over; a failure is logged
}

module.exports = { all, mark };

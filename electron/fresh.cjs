// Answers that are expensive to work out and only change when the notes folder does, kept until it does.
//
// One edit in the notes folder used to make the screen ask again for the folder tree, the link graph, every project, and the
// action items (App), then the projects and action items a second time (the home ring), and once more for each panel that
// was open. Each ask was worked out from scratch on the app's one thread (about 280 ms for the lot, in one block), and a
// stream of edits from a sync or an agent made that constant. Now the first ask after a change does the work and the rest are
// handed the same answer.
//
// An answer is dropped (a) when the folder watcher reports a change, (b) when the app writes a note or a panel setting itself
// (shared.markWritten, vault.setOverride), and (c) 60 s after it was made, so a change the watcher missed cannot linger.
const TTL_MS = 60 * 1000;
const kept = new Map(); // name -> { at, value }
let generation = 0; // goes up on every drop, so an answer worked out before a change is never stored after it

function get(name, make) {
  const hit = kept.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const g = generation;
  const value = make();
  if (g === generation) kept.set(name, { at: Date.now(), value });
  return value;
}

function drop() { generation++; kept.clear(); }

module.exports = { get, drop, TTL_MS };

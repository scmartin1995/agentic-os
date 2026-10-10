// One list of everything the screens can ask the app to do, used by both screens:
//   - the desktop window, over Electron's internal channel (preload.cjs)
//   - a paired phone, over the local web server (remote.cjs)
// A handler is registered once with handle(); `remote: true` lets the phone call it too. Anything that changes
// the brain, keys, folders or the PC itself stays desktop-only.
// Events flow the other way: broadcast() reaches every screen; a handler's ctx.send() reaches only the caller.
const { ipcMain } = require('electron');

const handlers = new Map(); // channel -> { fn, remote }
const sinks = new Set(); // (channel, payload) => void, one per kind of screen

function handle(channel, fn, { remote = false } = {}) {
  handlers.set(channel, { fn, remote });
  ipcMain.handle(channel, (e, ...args) => fn({
    kind: 'window', sender: e.sender,
    send: (ch, payload) => { if (!e.sender.isDestroyed()) e.sender.send(ch, payload); },
  }, ...args));
}

// For remote.cjs: run a handler on behalf of a phone, if that handler allows it.
async function invokeRemote(channel, ctx, args) {
  const h = handlers.get(channel);
  if (!h || !h.remote) throw new Error('Not available from the phone.');
  return h.fn(ctx, ...(Array.isArray(args) ? args : []));
}

function addSink(fn) { sinks.add(fn); return () => sinks.delete(fn); }
function broadcast(channel, payload) { for (const s of sinks) { try { s(channel, payload); } catch { /* one dead screen must not stop the others */ } } }

module.exports = { handle, invokeRemote, addSink, broadcast };

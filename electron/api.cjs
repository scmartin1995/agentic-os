// One list of everything the screen can ask the app to do. A handler is registered once with handle().
// Events flow the other way: broadcast() reaches the window; a handler's ctx.send() reaches only the caller.
const { ipcMain } = require('electron');

const sinks = new Set(); // (channel, payload) => void

function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => fn({
    kind: 'window', sender: e.sender,
    send: (ch, payload) => { if (!e.sender.isDestroyed()) e.sender.send(ch, payload); },
  }, ...args));
}

function addSink(fn) { sinks.add(fn); return () => sinks.delete(fn); }
function broadcast(channel, payload) { for (const s of sinks) { try { s(channel, payload); } catch { /* a closed window must not stop the rest */ } } }

module.exports = { handle, addSink, broadcast };

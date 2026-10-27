// The only bridge between the window and the app. It carries two things: "ask the app to do X" (invoke) and
// "tell me when Y happens" (on). The friendly, typed `window.aos` object is built on top of it in src/aos.ts,
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Test runs only (AOS_FAKE_MIC): the page's microphone becomes a recording played once the wake-word model has loaded.
const fakeMic = ipcRenderer.sendSync('debug:fakeMic');
if (fakeMic) {
  webFrame.executeJavaScript(`(() => {
    const b64 = ${JSON.stringify(fakeMic)};
    let ctx, dest;
    const play = async (data, delay) => {
      const buf = await ctx.decodeAudioData(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)).buffer);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      src.start(ctx.currentTime + delay);
    };
    window.__fakeMicPlay = (data) => play(data, 0.3);
    navigator.mediaDevices.getUserMedia = async () => {
      if (!ctx) { ctx = new AudioContext({ sampleRate: 16000 }); dest = ctx.createMediaStreamDestination(); await play(b64, 8); }
      return dest.stream;
    };
  })()`);
}

const OK = /^[a-z]+:[A-Za-z0-9]+$/; // "area:action", nothing else
// Which kind of computer this is, so the window buttons sit where that system puts them. A test capture can pretend (AOS_FAKE_OS).
const fakeOs = (process.argv.find((a) => a.startsWith('--aos-os=')) || '').slice(9);
contextBridge.exposeInMainWorld('aosBridge', {
  kind: 'desktop',
  os: (fakeOs || process.platform) === 'darwin' || fakeOs === 'mac' ? 'mac' : 'win',
  quiet: process.argv.includes('--aos-capture') && !fakeMic, // a test capture: leave the real microphone alone
  invoke: (channel, ...args) => (OK.test(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error('bad channel'))),
  on: (channel, fn) => {
    if (!OK.test(channel)) return () => {};
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});

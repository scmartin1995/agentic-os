// The assistant's voice: local Piper TTS, shaped to the voice the user picked on 2026-10-03
// (VCTK speaker p254, English, +2 semitones). Live use: 25% faster was too fast to follow, so
// 10% faster with longer pauses and a lighter bass boost for clarity; still too quick, so later the
// same day natural pace (1.0) with slightly longer pauses; heard live and still a little fast, so
// 8% slower than natural (0.92) with 0.5 s between sentences (2026-10-03). Percentages are always
// against Piper's natural pace, not against the previous setting.
// Piper runs as one long-lived process so the model loads once; each sentence becomes a WAV
// that is sent to the window to play in order.
// Speed is now set from Settings in the menu and saved to voice-settings.json; 0.92 is only the
// default until then. A change takes effect from the next sentence, no restart.
// Speed is applied to the finished audio (stretch() below), not through Piper's length_scale: length_scale has a floor
// (nothing gets faster than about 1.5x) and Piper's random timing varied a sentence by 15% between runs, so the
// old slider could not be heard. Piper now always speaks at its natural pace with its randomness off, so the same
// text and the same speed always sound the same, and the slider moves the pace by exactly what it says.
// Off switch: AOS_VOICE=off. Piper lives in tools/piper (gitignored; see README).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

const SPEED_MIN = 0.5, SPEED_MAX = 1.8; // half speed to nearly double; 1.0 is Piper's natural pace
const settingsFile = () => path.join(app.getPath('userData'), 'voice-settings.json');
const store = require('./store.cjs');
function savedSettings() { return store.readJson(settingsFile(), {}); }
const clampSpeed = (v) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(v * 100) / 100));

const VOICE = {
  model: 'en_GB-vctk-medium',
  speaker: 76, // VCTK p254
  pitch: 1.12, // +2 semitones
  speed: Number(process.env.AOS_VOICE_SPEED || 0.92), // default: 8% slower than Piper's natural pace
  bassDb: 3,
};
const DEFAULT_SPEED = VOICE.speed;
let loaded = false;
function speed() {
  if (!loaded) { loaded = true; const s = Number(savedSettings().speed); if (s > 0) VOICE.speed = clampSpeed(s); }
  return VOICE.speed;
}
function setSpeed(v) {
  const s = savedSettings();
  s.speed = clampSpeed(Number(v) || DEFAULT_SPEED);
  store.tryWriteJson(settingsFile(), s);
  loaded = true;
  VOICE.speed = s.speed;
  return VOICE.speed;
}
const settings = () => ({ speed: speed(), defaultSpeed: DEFAULT_SPEED, min: SPEED_MIN, max: SPEED_MAX });

const PIPER_DIR = require('./paths.cjs').toolsDir('piper');
const PIPER = path.join(PIPER_DIR, 'piper', 'piper.exe');
const MODEL = path.join(PIPER_DIR, 'voices', VOICE.model + '.onnx');
const TMP = path.join(os.tmpdir(), 'aos-voice');

const available = () => process.env.AOS_VOICE !== 'off' && fs.existsSync(PIPER) && fs.existsSync(MODEL);

// ---- audio shaping (same math as tools/voice-samples.cjs) ----
function readWav(buf) {
  const rate = buf.readUInt32LE(24);
  let p = 12;
  while (p < buf.length - 8) {
    const id = buf.toString('ascii', p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === 'data') {
      const n = Math.floor(Math.min(size, buf.length - p - 8) / 2), s = new Float32Array(n);
      for (let i = 0; i < n; i++) s[i] = buf.readInt16LE(p + 8 + i * 2) / 32768;
      return { rate, s };
    }
    p += 8 + size;
  }
  throw new Error('no data chunk');
}

function toWav(rate, s) {
  const b = Buffer.alloc(44 + s.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + s.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(s.length * 2, 40);
  for (let i = 0; i < s.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s[i])) * 32767), 44 + i * 2);
  return b;
}

function pitchUp(s, k) {
  const out = new Float32Array(Math.floor(s.length / k));
  for (let i = 0; i < out.length; i++) {
    const x = i * k, j = Math.floor(x), f = x - j;
    out[i] = (s[j] || 0) * (1 - f) + (s[j + 1] || 0) * f;
  }
  return out;
}

// Change the pace without changing the pitch (WSOLA: overlap-add short frames, each nudged to the spot where it
// lines up best with what came before). alpha > 1 slows the speech, alpha < 1 speeds it up.
function stretch(s, rate, alpha) {
  if (Math.abs(alpha - 1) < 0.005 || s.length < rate / 10) return s;
  const N = 2 * Math.round(rate * 0.02), H = N / 2, D = Math.round(rate * 0.012); // 40 ms frames, search +-12 ms
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / N);
  const out = new Float32Array(Math.ceil(s.length * alpha) + 2 * N);
  let prev = 0, end = N;
  for (let i = 0; i < N && i < s.length; i++) out[i] += s[i] * win[i];
  for (let k = 1; ; k++) {
    const target = Math.round((k * H) / alpha), nat = prev + H;
    if (target + N + D >= s.length || nat + H >= s.length) break;
    let best = target, bestScore = -Infinity;
    for (let c = Math.max(0, target - D); c <= target + D; c += 1) {
      let dot = 0, e = 1e-9;
      for (let i = 0; i < H; i += 2) { const a = s[nat + i], b = s[c + i]; dot += a * b; e += b * b; }
      const score = dot / Math.sqrt(e);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    const o = k * H;
    for (let i = 0; i < N; i++) out[o + i] += s[best + i] * win[i];
    prev = best;
    end = o + N;
  }
  return out.subarray(0, end); // only what was written, not the spare room at the end
}

function bass(s, rate, db, freq = 200) {
  const A = Math.pow(10, db / 40), w = (2 * Math.PI * freq) / rate, cs = Math.cos(w), sn = Math.sin(w);
  const sq = 2 * Math.sqrt(A) * (sn / 2) * Math.SQRT2;
  const b0 = A * ((A + 1) - (A - 1) * cs + sq), b1 = 2 * A * ((A - 1) - (A + 1) * cs), b2 = A * ((A + 1) - (A - 1) * cs - sq);
  const a0 = (A + 1) + (A - 1) * cs + sq, a1 = -2 * ((A - 1) + (A + 1) * cs), a2 = (A + 1) + (A - 1) * cs - sq;
  const out = new Float32Array(s.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < s.length; i++) {
    const x = s[i], y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y; x2 = x1; x1 = x; y2 = y1; y1 = y;
  }
  return out;
}

function normalize(s, peak = 0.9) {
  let m = 0;
  for (const v of s) m = Math.max(m, Math.abs(v));
  return m ? s.map((v) => (v * peak) / m) : s;
}

// ---- long-lived Piper process: one JSON line in, one output path out ----
let proc = null;
let waiting = []; // resolvers in request order
let seqFile = 0;

function piper() {
  if (proc) return proc;
  fs.mkdirSync(TMP, { recursive: true });
  // Natural pace (the pitch lift below shortens it, so ask for that much longer), no random timing, no silence added: speed() and the gap are applied to the audio.
  const p = spawn(PIPER, ['-m', MODEL, '--json-input', '--length_scale', String(VOICE.pitch), '--noise_w', '0', '--sentence_silence', '0'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  proc = p;
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { const r = waiting.shift(); if (r) r(line); }
    }
  });
  p.on('exit', () => { if (proc !== p) return; proc = null; for (const r of waiting) r(null); waiting = []; });
  return p;
}

function synthFile(text) {
  return new Promise((resolve) => {
    const file = path.join(TMP, `s${process.pid}-${seqFile++}.wav`);
    const p = piper();
    waiting.push((out) => resolve(out ? file : null));
    p.stdin.write(JSON.stringify({ text, speaker_id: VOICE.speaker, output_file: file }) + '\n');
  });
}

async function synth(text) {
  const file = await synthFile(text);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const { rate, s } = readWav(fs.readFileSync(file));
    const alpha = 1 / speed(); // seconds of speech per natural second: 2 is half speed, 0.5 is double
    const talk = normalize(bass(stretch(pitchUp(s, VOICE.pitch), rate, alpha), rate, VOICE.bassDb));
    const gap = Math.round(rate * 0.5 * alpha); // the pause after a sentence slows and quickens with the voice
    const out = new Float32Array(talk.length + gap);
    out.set(talk);
    return toWav(rate, out);
  } finally {
    fs.rm(file, () => {});
  }
}

// ---- turning streamed reply text into speakable sentences ----
const fileName = (p) => p.split(/[\\/]/).filter(Boolean).pop().replace(/\.\w{2,4}$/, '').replace(/^\d+[-_ ]*/, '').replace(/[-_]+/g, ' ');

function speakable(t) {
  return t
    .replace(/```[\s\S]*?```/g, ' ') // code blocks are for reading, not hearing
    // file paths are said by name: `projects/Home_Buying/output/07-city-ranking.md` -> "city ranking"
    .replace(/`([^`]*)`/g, (_, x) => (/[\\/]|\.\w{2,4}$/.test(x) ? fileName(x) : x))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links: keep the label
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// One speaker per reply: feed() it text as it streams; it speaks whole sentences in order.
function createSpeaker(emit) {
  let pending = '';
  let chain = Promise.resolve();
  let seq = 0;
  let spoken = 0;
  const MAX = 900; // characters per reply; long answers are for reading
  let quiet = false; // the "Sources:" list at the end is for the chat, never read aloud
  const say = (sentence) => {
    const text = speakable(sentence);
    if (/^sources?\s*:/i.test(text)) quiet = true;
    if (!text || quiet || spoken >= MAX) return;
    spoken += text.length;
    const n = seq++;
    const job = synth(text);
    chain = chain.then(async () => {
      const wav = await job;
      if (wav) emit({ type: 'audio', seq: n, data: wav.toString('base64') });
    });
  };
  return {
    feed(text) {
      if (!available()) return;
      pending += text;
      let m;
      // a sentence ends at . ! ? followed by space/newline, or at a blank line
      while ((m = pending.match(/^([\s\S]*?[.!?…])(\s+)|^([\s\S]*?)\n\s*\n/))) {
        say(m[1] || m[3]);
        pending = pending.slice(m[0].length);
      }
    },
    flush() {
      if (!available()) return chain;
      if (pending.trim()) say(pending);
      pending = '';
      return chain;
    },
  };
}

function stop() {
  if (proc) { try { proc.kill(); } catch {} proc = null; }
}

module.exports = { available, createSpeaker, synth, stop, VOICE, settings, setSpeed, stretch };

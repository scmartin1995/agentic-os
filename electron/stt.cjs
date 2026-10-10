// Speech to text, on this PC: whisper.cpp (tools/whisper, gitignored) with the base.en model.
// The window records 16 kHz mono and sends the samples here; nothing leaves the machine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DIR = require('./paths.cjs').toolsDir('whisper');
const CLI = path.join(DIR, 'Release', 'whisper-cli.exe');
const MODEL = path.join(DIR, 'ggml-base.en.bin');
// Names Whisper wouldn't guess on its own; it leans toward these spellings.
const VOCAB = 'Agentic OS, action items, notes, projects, skills, inbox.';

const available = () => fs.existsSync(CLI) && fs.existsSync(MODEL);

function wav16k(int16) {
  const b = Buffer.alloc(44 + int16.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + int16.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(int16.length * 2, 40);
  Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).copy(b, 44);
  return b;
}

let n = 0;
function transcribe(pcm) {
  return new Promise((resolve) => {
    if (!available()) return resolve({ error: 'Speech recognition is not installed (tools/whisper).' });
    const int16 = pcm instanceof Int16Array ? pcm : new Int16Array(pcm.buffer || pcm);
    if (int16.length < 16000 * 0.3) return resolve({ text: '' }); // under 0.3 s: nothing said
    const file = path.join(os.tmpdir(), `aos-stt-${process.pid}-${n++}.wav`);
    fs.writeFileSync(file, wav16k(int16));
    execFile(CLI, ['-m', MODEL, '-f', file, '-nt', '-np', '-l', 'en', '-t', '4', '--prompt', VOCAB], { windowsHide: true, timeout: 60000 }, (err, stdout) => {
      fs.rm(file, () => {});
      if (err) return resolve({ error: 'Speech recognition failed.' });
      const text = stdout.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim(); // drop [BLANK_AUDIO], (wind) etc.
      resolve({ text });
    });
  });
}

module.exports = { available, transcribe };

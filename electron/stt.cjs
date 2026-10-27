// Speech to text, on this PC. First choice: whisper.cpp (tools/whisper, gitignored) with the small.en model.
// If that is missing or fails, the speech recognizer built into Windows (System.Speech) is the fallback.
// The window records 16 kHz mono and sends the samples here; nothing leaves the machine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DIR = require('./paths.cjs').toolsDir('whisper');
const CLI = path.join(DIR, 'Release', 'whisper-cli.exe');
const MODEL = path.join(DIR, 'ggml-small.en.bin');
// Words Whisper wouldn't guess on its own; it leans toward these spellings.
const VOCAB = 'Agentic OS, notes, project, session, deliverable, skill, action item, Jira, ServiceNow, AWS, Azure, GCP.';

const haveWhisper = () => fs.existsSync(CLI) && fs.existsSync(MODEL);
const available = () => haveWhisper() || process.platform === 'win32';

function wav16k(int16) {
  const b = Buffer.alloc(44 + int16.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + int16.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(int16.length * 2, 40);
  Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).copy(b, 44);
  return b;
}

// Windows PowerShell 5.1 ships System.Speech; the free-text dictation grammar turns the recording into words.
const SCRIPT = `
param([string]$wav)
Add-Type -AssemblyName System.Speech
$e = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$e.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$e.SetInputToWaveFile($wav)
$out = @()
try { while ($true) { $r = $e.Recognize(); if ($null -eq $r) { break }; $out += $r.Text } } catch { }
[Console]::Out.Write(($out -join ' '))
`;
const SCRIPT_FILE = path.join(os.tmpdir(), `aos-stt-${process.pid}.ps1`);

let wrote = false;
let n = 0;

function viaWhisper(int16) {
  return new Promise((resolve) => {
    const file = path.join(os.tmpdir(), `aos-stt-${process.pid}-${n++}.wav`);
    fs.writeFileSync(file, wav16k(int16));
    execFile(CLI, ['-m', MODEL, '-f', file, '-nt', '-np', '-l', 'en', '-t', '8', '-fa', '--prompt', VOCAB], { windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
      fs.rm(file, () => {});
      if (err) { try { fs.appendFileSync(path.join(os.tmpdir(), 'aos-stt-error.log'), new Date().toISOString() + ' whisper: ' + (stderr || err.message) + '\n'); } catch {} return resolve(null); }
      resolve({ text: stdout.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim() }); // drop [BLANK_AUDIO], (wind) etc.
    });
  });
}

async function transcribe(pcm) {
  if (!available()) return { error: 'Speech recognition needs Windows.' };
  const int16 = pcm instanceof Int16Array ? pcm : new Int16Array(pcm.buffer || pcm);
  if (int16.length < 16000 * 0.3) return { text: '' }; // under 0.3 s: nothing said
  if (haveWhisper()) { const r = await viaWhisper(int16); if (r) return r; }
  return viaWindows(int16);
}

function viaWindows(int16) {
  return new Promise((resolve) => {
    const file = path.join(os.tmpdir(), `aos-stt-${process.pid}-${n++}.wav`);
    const padded = new Int16Array(int16.length + 8000); padded.set(int16);
    fs.writeFileSync(file, wav16k(padded));
    if (!wrote) { fs.writeFileSync(SCRIPT_FILE, SCRIPT); wrote = true; }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_FILE, file], { windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
      fs.rm(file, () => {});
      if (err) { try { fs.appendFileSync(path.join(os.tmpdir(), 'aos-stt-error.log'), new Date().toISOString() + ' samples=' + int16.length + ' ' + (stderr || err.message) + '\n'); } catch {} }
      if (err) return resolve({ error: 'Windows speech recognition failed. Check Settings, Time & language, Speech.' });
      resolve({ text: stdout.replace(/\s+/g, ' ').trim() });
    });
  });
}

module.exports = { available, transcribe };

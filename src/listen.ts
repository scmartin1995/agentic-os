// Microphone: "Hey computer" wake word (Vosk, on-device, limited to a tiny grammar) and push-to-talk.
// After the wake word or while Space / the mic button is held, it records 16 kHz audio and hands
// it to whisper.cpp in the main process. Nothing is sent anywhere else.

export type Phase = 'off' | 'loading' | 'waiting' | 'recording' | 'transcribing';

const WAKE_MODEL = 'models://files/vosk-model-small-en-us-0.15.tar.gz';
// Grammar keeps Vosk to a few phrases, so it can only "hear" these or nothing.
const GRAMMAR = JSON.stringify(['hey computer', 'okay computer', 'computer', '[unk]']);
const isWake = (t: string) => /\b(hey|okay|ok) computer\b/.test(t);
// Stray phrases ("the villains of darkness") got through, so a finished phrase must be heard with this
// confidence per word. Chosen in Settings (Wake word); strict is the default.
export type WakeSensitivity = 'strict' | 'normal' | 'loose';
export const WAKE_SENS_KEY = 'aos-wake-sens';
const MIN_CONF: Record<WakeSensitivity, number> = { strict: 0.9, normal: 0.8, loose: 0.6 };
const sensitivity = (): WakeSensitivity => {
  try { const v = localStorage.getItem(WAKE_SENS_KEY); if (v === 'normal' || v === 'loose') return v; } catch { /* default */ }
  return 'strict';
};
const sure = (words: any[] | undefined, min: number) => !!words?.length && words.every((w) => w.conf >= min);

// 1.2 s cut the user off mid-thought (2026-10-03), so allow a real pause.
const SILENCE_END_MS = 2000; // stop after this much quiet once speech started
const NO_SPEECH_MS = 7000; // give up if nothing is said after the wake word
const FOLLOW_UP_MS = 6000; // after the assistant talks, how long the mic stays open for a reply
const MAX_MS = 45000;

export class Listener {
  phase: Phase = 'off';
  wake = false;
  paused = false; // true while the assistant is talking or working, so they can't wake themselves
  onPhase: (p: Phase) => void = () => {};
  onText: (t: string) => void = () => {};
  onError: (m: string) => void = () => {};

  private ctx: AudioContext | null = null;
  private rec: any = null; // Vosk recognizer
  private chunks: Float32Array[] = [];
  private started = 0;
  private lastVoice = 0;
  private heard = false;
  private firstVoice = -1; // chunk where speech started; the quiet before it is cut
  private lastVoiceChunk = -1;
  private noise = 0.01;
  private source: 'wake' | 'ptt' = 'wake';
  private noSpeechMs = NO_SPEECH_MS;
  private followUp = false;
  private cooldownUntil = 0; // ignore late wake-word results right after a recording
  private rate = 16000; // what the microphone really records at (some phones refuse 16 kHz)
  level = 0; // how loud the room is right now, 0 to 1 (the stage's listening ring follows it)

  private set(p: Phase) { this.phase = p; this.onPhase(p); }

  private async ensureMic() {
    if (this.ctx) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(window.isSecureContext ? 'no microphone on this device' : 'phones only allow the microphone over https (see Settings, Phone)');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    let ctx: AudioContext;
    try { ctx = new AudioContext({ sampleRate: 16000 }); } catch { ctx = new AudioContext(); }
    this.rate = ctx.sampleRate;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (e) => this.onAudio(e.inputBuffer);
    src.connect(proc);
    proc.connect(ctx.destination); // required for processing to run; outputs silence
    this.ctx = ctx;
  }

  async setWake(on: boolean) {
    this.wake = on;
    if (!on) { if (this.phase === 'waiting' || this.phase === 'loading') this.set('off'); return; }
    try {
      await this.ensureMic();
      if (!this.rec) {
        this.set('loading');
        const { createModel } = await import('vosk-browser');
        const model = await createModel(WAKE_MODEL);
        const rec = new model.KaldiRecognizer(16000, GRAMMAR);
        rec.setWords(true); // a confidence score per word
        rec.on('result', (m: any) => this.checkWake(m?.result?.text || '', m?.result?.result));
        this.rec = rec;
      }
      if (this.wake && this.phase !== 'recording' && this.phase !== 'transcribing') this.set('waiting');
    } catch (err) {
      this.wake = false;
      this.set('off');
      this.onError(`Couldn't start the wake word: ${(err as Error).message || err}`);
    }
  }

  private checkWake(text: string, words?: any[]) {
    if (this.phase === 'waiting' && !this.paused && performance.now() > this.cooldownUntil
      && isWake(text) && sure(words, MIN_CONF[sensitivity()])) this.begin('wake');
  }

  // Open the mic once without the wake word: after the assistant asks a yes/no question, or after they
  // finishes talking so the user can reply (followUp: a softer tone and a shorter wait).
  async listenNow(followUp = false) {
    try { await this.ensureMic(); } catch (err) { this.onError(`Microphone unavailable: ${(err as Error).message || err}`); return; }
    if (this.phase !== 'recording' && this.phase !== 'transcribing') this.begin('wake', followUp);
  }

  get inFollowUp() { return this.followUp && this.phase === 'recording'; }

  async pushToTalk(down: boolean) {
    if (down) {
      try { await this.ensureMic(); } catch (err) { this.onError(`Microphone unavailable: ${(err as Error).message || err}`); return; }
      if (this.phase !== 'recording' && this.phase !== 'transcribing') this.begin('ptt');
    } else if (this.phase === 'recording' && this.source === 'ptt') {
      this.finish();
    }
  }

  private begin(source: 'wake' | 'ptt', followUp = false) {
    this.source = source;
    this.followUp = followUp;
    this.noSpeechMs = followUp ? FOLLOW_UP_MS : NO_SPEECH_MS;
    this.chunks = [];
    this.started = this.lastVoice = performance.now();
    this.heard = false;
    this.firstVoice = this.lastVoiceChunk = -1;
    if (source === 'wake') chime(followUp);
    this.set('recording');
  }

  private onAudio(buf: AudioBuffer) {
    const data = buf.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    this.level = this.phase === 'recording' ? Math.min(1, rms * 9) : 0;

    if (this.phase === 'waiting') {
      this.noise = this.noise * 0.95 + rms * 0.05; // track the room's background level
      if (!this.paused && this.rec) this.rec.acceptWaveform(buf);
      return;
    }
    if (this.phase !== 'recording') return;

    this.chunks.push(new Float32Array(data));
    const now = performance.now();
    // quieter speech still counts (0.012 missed soft endings of sentences)
    if (rms > Math.max(0.008, this.noise * 2.5)) {
      if (!this.heard) this.firstVoice = this.chunks.length - 1;
      this.heard = true; this.lastVoice = now; this.lastVoiceChunk = this.chunks.length - 1;
    }
    if (this.source === 'ptt') { if (now - this.started > MAX_MS) this.finish(); return; }
    if (!this.heard && now - this.started > this.noSpeechMs) { this.cancel(); return; }
    if ((this.heard && now - this.lastVoice > SILENCE_END_MS) || now - this.started > MAX_MS) this.finish();
  }

  private cancel() {
    this.chunks = [];
    this.cooldownUntil = performance.now() + 3000;
    this.set(this.wake ? 'waiting' : 'off');
    this.rec?.retrieveFinalResult();
  }

  private async finish() {
    // Whisper invents a word ("and", "so") for the breath, chime and quiet before speech
    // (2026-10-03), so send only the speech plus one chunk (~0.25 s) of padding each side.
    const chunks = this.firstVoice < 0 ? this.chunks
      : this.chunks.slice(Math.max(0, this.firstVoice - 1), this.lastVoiceChunk + 2);
    this.chunks = [];
    this.set('transcribing');
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    // whisper wants 16 kHz: a microphone that recorded faster is brought down to it (straight-line resample)
    const step = this.rate / 16000;
    const pcm = new Int16Array(Math.floor(total / step));
    for (let i = 0; i < pcm.length; i++) {
      const x = i * step, k = Math.floor(x), f = x - k;
      const v = all[k] * (1 - f) + (all[Math.min(total - 1, k + 1)] ?? 0) * f;
      pcm[i] = Math.max(-1, Math.min(1, v)) * 32767;
    }
    this.level = 0;
    const res = await window.aos.stt.transcribe(pcm.buffer);
    // Vosk may still report the "hey computer" that started this; don't let it trigger again.
    this.cooldownUntil = performance.now() + 4000;
    this.rec?.retrieveFinalResult(); // clear anything Vosk half-heard
    this.set(this.wake ? 'waiting' : 'off');
    if (res.error) this.onError(res.error);
    else if (res.text && res.text.replace(/[^a-z]/gi, '').length > 1) this.onText(res.text);
  }
}

// Short two-note chime so you know the assistant is listening; one soft note for a follow-up.
function chime(soft = false) {
  try {
    const ctx = new AudioContext();
    const t = ctx.currentTime;
    const notes: [number, number][] = soft ? [[880, 0]] : [[660, 0], [990, 0.09]];
    for (const [f, d] of notes) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(soft ? 0.05 : 0.12, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.18);
      o.connect(g).connect(ctx.destination);
      o.start(t + d);
      o.stop(t + d + 0.2);
    }
    setTimeout(() => ctx.close(), 500);
  } catch { /* no chime is fine */ }
}

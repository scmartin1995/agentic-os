// The assistant's voice. Clips arrive one sentence at a time (numbered) and play back to back through one Web Audio
// graph, which gives two things v1's <audio> tags could not: a live loudness reading (the stage animates to its
// actual voice), and playback through one audio context.
export class Voice {
  onSpeaking: (on: boolean) => void = () => {};
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private bins: Uint8Array<ArrayBuffer> = new Uint8Array(64);
  private queue = new Map<number, string>();
  private next = 0;
  private playing: AudioBufferSourceNode | null = null;
  private gen = 0;

  constructor() {
    // Browsers keep sound off until the person touches the page; wake the audio on the first touch or key.
    const unlock = () => { this.ensure()?.resume().catch(() => {}); };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
  }

  private ensure() {
    if (!this.ctx) {
      try {
        const ctx = new AudioContext();
        const an = ctx.createAnalyser();
        an.fftSize = 128;
        an.smoothingTimeConstant = 0.78;
        an.connect(ctx.destination);
        this.ctx = ctx; this.analyser = an; this.bins = new Uint8Array(an.frequencyBinCount);
      } catch { /* no audio on this device: replies stay text */ }
    }
    return this.ctx;
  }

  add(seq: number, b64: string) {
    (window as unknown as { __aosAudio?: number }).__aosAudio = ((window as unknown as { __aosAudio?: number }).__aosAudio || 0) + 1; // for test runs
    this.queue.set(seq, b64);
    this.pump();
  }

  private async pump() {
    if (this.playing) return;
    const data = this.queue.get(this.next);
    if (!data) { this.onSpeaking(false); return; }
    this.queue.delete(this.next);
    this.next++;
    const ctx = this.ensure();
    if (!ctx || !this.analyser) { this.pump(); return; }
    const gen = this.gen;
    try {
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const buf = await ctx.decodeAudioData(bytes.buffer);
      if (gen !== this.gen) return; // hushed while decoding
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.analyser);
      src.onended = () => { if (this.playing === src) { this.playing = null; this.pump(); } };
      this.playing = src;
      this.onSpeaking(true);
      src.start();
    } catch { this.playing = null; this.pump(); }
  }

  // Stop talking now and forget what was queued (a new question, a chat switch, mute).
  hush() {
    this.gen++;
    this.queue.clear();
    this.next = 0;
    const p = this.playing;
    this.playing = null;
    if (p) { p.onended = null; try { p.stop(); } catch { /* already ended */ } }
    this.onSpeaking(false);
  }

  // How loud it is right now, 0 to 1, and the spread across pitch for the bars under it.
  level(): number {
    if (!this.analyser || !this.playing) return 0;
    this.analyser.getByteFrequencyData(this.bins);
    let sum = 0;
    for (let i = 2; i < 34; i++) sum += this.bins[i];
    return Math.min(1, sum / (32 * 150));
  }
  spectrum(): Uint8Array | null {
    if (!this.analyser || !this.playing) return null;
    this.analyser.getByteFrequencyData(this.bins);
    return this.bins;
  }
}

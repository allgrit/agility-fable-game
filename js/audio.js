// WebAudio-синтезатор: все SFX генерируются кодом, без аудиофайлов.
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.crowdGain = null;
    this.enabled = true;
    this.muted = false;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.55;
  }

  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return true; }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      this.master.connect(this.ctx.destination);
      this._noise = this._makeNoise();
      this._startCrowd();
      return true;
    } catch { this.enabled = false; return false; }
  }

  _makeNoise() {
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _env(gain, t0, a, peak, d, sustain = 0) {
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + a);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustain), t0 + a + d);
  }

  _osc(type, freq, t0, dur, peak = 0.3, dest = null, glideTo = null) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
    this._env(g, t0, 0.008, peak, dur);
    o.connect(g); g.connect(dest || this.master);
    o.start(t0); o.stop(t0 + dur + 0.1);
  }

  _noiseBurst(t0, dur, peak, freq = 1200, q = 1) {
    const s = this.ctx.createBufferSource(); s.buffer = this._noise; s.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    this._env(g, t0, 0.005, peak, dur);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t0); s.stop(t0 + dur + 0.1);
  }

  // ---- Толпа: постоянный гул + управляемые волны оваций ----
  _startCrowd() {
    const s = this.ctx.createBufferSource(); s.buffer = this._noise; s.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420; f.Q.value = 0.6;
    this.crowdGain = this.ctx.createGain(); this.crowdGain.gain.value = 0.015;
    const lfo = this.ctx.createOscillator(); lfo.frequency.value = 0.13;
    const lfoG = this.ctx.createGain(); lfoG.gain.value = 0.006;
    lfo.connect(lfoG); lfoG.connect(this.crowdGain.gain);
    s.connect(f); f.connect(this.crowdGain); this.crowdGain.connect(this.master);
    s.start(); lfo.start();
  }

  crowdLevel(v) { // 0..1 — интенсивность гула
    if (!this.ctx) return;
    this.crowdGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.crowdGain.gain.linearRampToValueAtTime(0.012 + v * 0.10, this.ctx.currentTime + 0.4);
  }

  cheer(big = false) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._noiseBurst(t, big ? 1.6 : 0.7, big ? 0.22 : 0.10, 900, 0.4);
    if (big) for (let i = 0; i < 6; i++) {
      this._osc('triangle', 500 + Math.random() * 700, t + Math.random() * 0.8, 0.25, 0.03);
    }
  }

  gasp() { if (this.ctx) this._noiseBurst(this.ctx.currentTime, 0.5, 0.09, 500, 0.7); }

  // ---- Игровые SFX ----
  whistle() {
    if (!this.ctx) return; const t = this.ctx.currentTime;
    this._osc('sine', 2200, t, 0.18, 0.25, null, 2600);
    this._osc('sine', 2200, t + 0.22, 0.34, 0.25, null, 1800);
  }

  countdown(final = false) {
    if (!this.ctx) return;
    this._osc('square', final ? 1200 : 700, this.ctx.currentTime, final ? 0.28 : 0.12, 0.12);
  }

  bark(size = 1) {
    if (!this.ctx) return; const t = this.ctx.currentTime;
    const f0 = 400 / size;
    this._osc('sawtooth', f0 * 1.8, t, 0.07, 0.22, null, f0 * 0.9);
    this._noiseBurst(t, 0.08, 0.12, 1500, 0.8);
  }

  jumpWhoosh() { if (this.ctx) this._noiseBurst(this.ctx.currentTime, 0.28, 0.14, 700, 0.5); }

  land() {
    if (!this.ctx) return;
    this._noiseBurst(this.ctx.currentTime, 0.09, 0.13, 240, 0.8);
  }

  knock() {
    if (!this.ctx) return; const t = this.ctx.currentTime;
    this._osc('square', 180, t, 0.12, 0.3, null, 90);
    this._noiseBurst(t, 0.15, 0.2, 800, 0.6);
    this._noiseBurst(t + 0.18, 0.1, 0.1, 500, 0.6); // отскок планки
  }

  weaveTick(i) {
    if (!this.ctx) return;
    this._osc('triangle', 800 + (i % 2) * 220, this.ctx.currentTime, 0.07, 0.15);
  }

  perfect() {
    if (!this.ctx) return; const t = this.ctx.currentTime;
    this._osc('sine', 880, t, 0.1, 0.18);
    this._osc('sine', 1320, t + 0.07, 0.16, 0.18);
  }

  good() { if (this.ctx) this._osc('sine', 660, this.ctx.currentTime, 0.12, 0.14); }

  miss() {
    if (!this.ctx) return; const t = this.ctx.currentTime;
    this._osc('sawtooth', 160, t, 0.3, 0.2, null, 90);
  }

  creak() {
    if (!this.ctx) return; const t = this.ctx.currentTime;
    this._osc('sawtooth', 90, t, 0.5, 0.06, null, 60);
    this._noiseBurst(t, 0.5, 0.03, 300, 3);
  }

  slam() {
    if (!this.ctx) return;
    this._osc('square', 70, this.ctx.currentTime, 0.2, 0.25, null, 45);
    this._noiseBurst(this.ctx.currentTime, 0.12, 0.15, 200, 1);
  }

  tunnelWhoosh() { if (this.ctx) this._noiseBurst(this.ctx.currentTime, 0.5, 0.1, 400, 0.6); }

  step() {
    if (!this.ctx) return;
    this._noiseBurst(this.ctx.currentTime, 0.04, 0.05, 350 + Math.random() * 150, 1.2);
  }

  fanfare() {
    if (!this.ctx) return; const t = this.ctx.currentTime;
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => {
      this._osc('triangle', f, t + i * 0.14, 0.5, 0.16);
      this._osc('sine', f / 2, t + i * 0.14, 0.5, 0.10);
    });
    this._osc('triangle', 1319, t + 0.6, 0.9, 0.14);
  }

  sad() {
    if (!this.ctx) return; const t = this.ctx.currentTime;
    [392, 349, 311].forEach((f, i) => this._osc('triangle', f, t + i * 0.25, 0.4, 0.1));
  }

  click() { if (this.ctx) this._osc('square', 900, this.ctx.currentTime, 0.04, 0.08); }
}

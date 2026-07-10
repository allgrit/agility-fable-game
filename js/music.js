// MusicEngine: процедурный WebAudio-саундтрек. Lookahead-планировщик (25мс тик,
// 120мс горизонт), состояния menu/run/results, слои интенсивности от комбо,
// дакинг под SFX, lowpass от скорости собаки. Ни одного аудиофайла.

const STATES = {
  menu: {
    bpm: 92,
    // F лидийский: Fmaj7 → G/F → Am7 → G6 (по такту)
    chords: [[174.6, 220, 261.6, 329.6], [196, 246.9, 293.7, 349.2],
             [220, 261.6, 329.6, 392], [196, 246.9, 293.7, 329.6]],
    bass: [87.3, 87.3, 110, 98],
  },
  run: {
    bpm: 128,
    // D миксолидийский: D → C → G/B → D
    chords: [[146.8, 220, 293.7, 370], [130.8, 196, 261.6, 329.6],
             [123.5, 196, 246.9, 293.7], [146.8, 220, 293.7, 370]],
    bass: [73.4, 65.4, 61.7, 73.4],
  },
  results_win: {
    bpm: 100,
    chords: [[130.8, 196, 261.6, 329.6], [174.6, 220, 261.6, 349.2],
             [196, 246.9, 293.7, 392], [130.8, 196, 261.6, 329.6]],
    bass: [65.4, 87.3, 98, 65.4],
  },
  results_fail: {
    bpm: 76,
    chords: [[110, 164.8, 220, 261.6], [174.6, 220, 261.6, 349.2],
             [130.8, 196, 261.6, 329.6], [196, 246.9, 293.7, 392]],
    bass: [55, 87.3, 65.4, 98],
  },
};

// Пентатоника D для лид-паттернов (5 вариантов по бару)
const PENTA = [293.7, 329.6, 370, 440, 493.9, 587.3];

export class MusicEngine {
  constructor(ctx, master) {
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.3;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 4000;
    this.bus.connect(this.lp);
    this.lp.connect(master);

    this.state = null;
    this.intensity = 0;        // = combo игрока
    this.step = 0;             // 16-е ноты
    this.nextTime = 0;
    this.enabled = true;
    this._timer = setInterval(() => this._tick(), 25);
  }

  setState(name) {
    if (this.state === name || !STATES[name]) return;
    this.state = name;
    this.step = 0;
    this.nextTime = Math.max(this.nextTime, this.ctx.currentTime + 0.05);
  }

  setIntensity(v) { this.intensity = v; }

  speedFilter(dogSpeed) {
    // Быстрее собака — ярче микс
    this.lp.frequency.setTargetAtTime(900 + dogSpeed * 350, this.ctx.currentTime, 0.2);
  }

  duck(amount = 0.35, hold = 0.15) {
    const t = this.ctx.currentTime;
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setValueAtTime(this.bus.gain.value, t);
    this.bus.gain.linearRampToValueAtTime(0.3 * (1 - amount), t + 0.05);
    this.bus.gain.linearRampToValueAtTime(0.3, t + 0.05 + hold + 0.4);
  }

  dip() {
    // «Провал» при потере комбо: lowpass вниз на такт
    const t = this.ctx.currentTime;
    this.lp.frequency.cancelScheduledValues(t);
    this.lp.frequency.setValueAtTime(this.lp.frequency.value, t);
    this.lp.frequency.linearRampToValueAtTime(500, t + 0.12);
    this.lp.frequency.linearRampToValueAtTime(3500, t + 1.4);
  }

  _tick() {
    if (!this.enabled || !this.state || this.ctx.state !== 'running') return;
    const conf = STATES[this.state];
    const stepDur = 60 / conf.bpm / 4; // 16-я
    while (this.nextTime < this.ctx.currentTime + 0.12) {
      this._schedule(this.step, this.nextTime, conf, stepDur);
      this.nextTime += stepDur;
      this.step = (this.step + 1) % 64; // 4 такта
    }
  }

  _osc(type, freq, t, dur, peak, dest) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest || this.bus);
    o.start(t); o.stop(t + dur + 0.05);
  }

  _noise(t, dur, peak, freq) {
    if (!this._nbuf) {
      const len = this.ctx.sampleRate;
      this._nbuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this._nbuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    const s = this.ctx.createBufferSource(); s.buffer = this._nbuf; s.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.bus);
    s.start(t); s.stop(t + dur + 0.05);
  }

  _schedule(step, t, conf, stepDur) {
    const bar = Math.floor(step / 16) % 4;
    const beat = Math.floor((step % 16) / 4);   // 0..3
    const sixteenth = step % 4;
    const chord = conf.chords[bar];
    const inRun = this.state === 'run';
    const menu = this.state === 'menu';
    const I = this.intensity;

    // Пад: аккорд на начало такта (везде)
    if (step % 16 === 0) {
      for (const f of chord) this._osc('triangle', f, t, stepDur * 14, menu ? 0.045 : 0.03);
    }

    if (menu) {
      // Редкий арп
      if (step % 8 === 4) this._osc('sine', chord[(bar + 1) % 4] * 2, t, stepDur * 3, 0.05);
      return;
    }
    if (this.state.startsWith('results')) {
      if (sixteenth === 0 && beat % 2 === 0) this._osc('sine', conf.bass[bar], t, stepDur * 3, 0.09);
      return;
    }

    // ---- RUN: слои по интенсивности (комбо) ----
    // Kick — всегда, на каждую четверть
    if (sixteenth === 0) {
      this._osc('sine', 55, t, 0.11, 0.32);
    }
    // Бас — восьмые
    if (I >= 1 && step % 2 === 0) {
      this._osc('sawtooth', conf.bass[bar] * (beat === 3 && sixteenth >= 2 ? 1.5 : 1), t, stepDur * 1.6, 0.075);
    }
    // Хэты — офбит
    if (I >= 2 && sixteenth === 2) this._noise(t, 0.04, 0.05, 6000);
    // Арп — 16-е через одну
    if (I >= 4 && step % 2 === 1) {
      this._osc('square', chord[step % chord.length] * 2, t, stepDur * 0.9, 0.028);
    }
    // Лид — пентатоника, паттерн от бара
    if (I >= 7 && sixteenth === 0) {
      const idx = (bar * 3 + beat * 2 + Math.floor(step / 16)) % PENTA.length;
      this._osc('triangle', PENTA[idx] * 2, t, stepDur * 3, 0.05);
    }
    // Клэп толпы — 2 и 4 доля
    if (I >= 10 && sixteenth === 0 && (beat === 1 || beat === 3)) {
      this._noise(t, 0.09, 0.08, 1500);
    }
  }
}

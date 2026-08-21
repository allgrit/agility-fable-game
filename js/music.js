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

// Пороги вертикального слоения (vertical layering): комбо буквально включает
// инструменты. Лид и арпеджиатор — награда за высокое комбо, поэтому их потеря
// слышна как «музыка исчезла» — сильный негативный фидбек без штрафа очками.
export const LAYER_THRESHOLDS = {
  kick: 0, bass: 1, hats: 2, arp: 4, lead: 8, clap: 10, arpeggio: 12,
};

// Чистая функция — какие слои звучат при данной интенсивности (= комбо).
export function activeLayers(intensity) {
  const I = Number.isFinite(intensity) ? intensity : 0;
  const out = {};
  for (const k in LAYER_THRESHOLDS) out[k] = I >= LAYER_THRESHOLDS[k];
  return out;
}

// Бит-клок: чистая арифметика четвертей, чтобы визуал мог «дышать» в такт
// без доступа к WebAudio (и чтобы это можно было покрыть тестами в node).
// elapsedSec — время от якоря состояния; такт = 4 четверти.
export function beatClock(elapsedSec, bpm) {
  const zero = { index: 0, phase: 0, barPhase: 0 };
  if (!Number.isFinite(elapsedSec) || !Number.isFinite(bpm) || bpm <= 0 || elapsedSec <= 0) return zero;
  const beats = elapsedSec / (60 / bpm);
  const index = Math.floor(beats);
  return { index, phase: beats - index, barPhase: (beats % 4) / 4 };
}

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
    // Якорь бит-клока: nextTime — это БУДУЩЕЕ время планировщика (горизонт 120мс),
    // как фаза оно бы увело картинку вперёд звука. Считаем от слышимого момента.
    this.originTime = 0;
    this.leadCutAt = null;     // когда в последний раз оборвали мелодию (для тестов/дебага)
    this._fillFrom = 0;        // окно drum fill: [_fillFrom, _fillUntil)
    this._fillUntil = 0;
    this.enabled = true;
    this._timer = setInterval(() => this._tick(), 25);
  }

  setState(name) {
    if (this.state === name || !STATES[name]) return;
    this.state = name;
    this.step = 0;
    this.nextTime = Math.max(this.nextTime, this.ctx.currentTime + 0.05);
    this.originTime = this.nextTime;   // такт нового состояния начинается здесь
  }

  // ---- Бит-клок для рендера: мир дышит в бит ----
  get bpm() { return this.state && STATES[this.state] ? STATES[this.state].bpm : 0; }

  get _clock() {
    if (!this.state || this.ctx.state !== 'running') return { index: 0, phase: 0, barPhase: 0 };
    return beatClock(this.ctx.currentTime - this.originTime, this.bpm);
  }

  get beatIndex() { return this._clock.index; }
  get beatPhase() { return this._clock.phase; }
  get barPhase() { return this._clock.barPhase; }

  // Импульс 1→0 внутри четверти: готовый множитель для пульсации визуала.
  pulse(sharpness = 3) {
    if (!this.state || this.ctx.state !== 'running') return 0;
    return (1 - this._clock.phase) ** sharpness;
  }

  dispose() {
    clearInterval(this._timer);
    this._timer = null;
  }

  setIntensity(v) {
    const had = activeLayers(this.intensity).lead;
    this.intensity = v;
    // Комбо упало ниже лид-порога — мелодия должна оборваться, а не растаять
    if (had && !activeLayers(v).lead) this.leadCut();
  }

  // «Музыка исчезла»: короткий спад шины без удара — dip() по потере комбо
  // прилетает отдельно из game.js, складывать два эффекта в кашу нельзя.
  leadCut() {
    const t = this.ctx.currentTime;
    this.leadCutAt = t;
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setValueAtTime(this.bus.gain.value, t);
    this.bus.gain.linearRampToValueAtTime(0.3 * 0.45, t + 0.07);
    this.bus.gain.linearRampToValueAtTime(0.3, t + 0.5);
  }

  // Сбивка перед сменой темпа/финишем: планируется на такт вперёд, сетку не рвёт.
  drumFill(delay = 0) {
    const conf = STATES[this.state];
    if (!conf) return;
    const bar = (60 / conf.bpm) * 4;
    this._fillFrom = this.ctx.currentTime + delay;
    this._fillUntil = this._fillFrom + bar;
  }

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

    // Сбивка идёт поверх любого состояния — она про «сейчас что-то изменится»
    if (t >= this._fillFrom && t < this._fillUntil) this._fillHit(t, step, stepDur);

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
    const L = activeLayers(I);
    // Kick — всегда, на каждую четверть
    if (L.kick && sixteenth === 0) {
      this._osc('sine', 55, t, 0.11, 0.32);
    }
    // Бас — восьмые
    if (L.bass && step % 2 === 0) {
      this._osc('sawtooth', conf.bass[bar] * (beat === 3 && sixteenth >= 2 ? 1.5 : 1), t, stepDur * 1.6, 0.075);
    }
    // Хэты — офбит
    if (L.hats && sixteenth === 2) this._noise(t, 0.04, 0.05, 6000);
    // Арп — 16-е через одну
    if (L.arp && step % 2 === 1) {
      this._osc('square', chord[step % chord.length] * 2, t, stepDur * 0.9, 0.028);
    }
    // Лид — пентатоника, паттерн от бара (награда за комбо ≥8)
    if (L.lead && sixteenth === 0) {
      const idx = (bar * 3 + beat * 2 + Math.floor(step / 16)) % PENTA.length;
      this._osc('triangle', PENTA[idx] * 2, t, stepDur * 3, 0.05);
    }
    // Клэп толпы — 2 и 4 доля
    if (L.clap && sixteenth === 0 && (beat === 1 || beat === 3)) {
      this._noise(t, 0.09, 0.08, 1500);
    }
    // Арпеджиатор ≥12 — кульминация: плотные 16-е поверх лида. Тише и короче
    // лида, иначе на верхнем комбо микс превращается в кашу.
    if (L.arpeggio) {
      const idx = (step * 2 + bar) % PENTA.length;
      this._osc('sine', PENTA[idx] * 2, t, stepDur * 0.45, 0.022);
    }
  }

  // Учащающиеся том-удары внутри окна сбивки: чем ближе конец, тем плотнее
  // и выше — ухо успевает подготовиться к смене.
  _fillHit(t, step, stepDur) {
    const span = this._fillUntil - this._fillFrom;
    const p = span > 0 ? (t - this._fillFrom) / span : 0;
    const every = p > 0.75 ? 1 : p > 0.45 ? 2 : 4;   // 16-е → 8-е → четверти
    if (step % every !== 0) return;
    this._noise(t, stepDur * 0.8, 0.07 + p * 0.06, 220 + p * 900);
    if (p > 0.6) this._osc('triangle', 110 + p * 180, t, stepDur * 0.7, 0.06);
  }
}

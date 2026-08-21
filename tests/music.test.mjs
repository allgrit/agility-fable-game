// Тесты музыкального движка: node --test tests/music.test.mjs
// WebAudio в node нет — считаем чистые функции напрямую, а класс гоняем на стабе
// контекста, где вместо звука копятся вызовы (нам важен контракт, не тембр).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MusicEngine, beatClock, activeLayers, LAYER_THRESHOLDS } from '../js/music.js';
import { AudioEngine } from '../js/audio.js';
import { QTE_DEFS } from '../js/qte.js';

// ---- стаб AudioContext ----
function makeParam(log, name) {
  const p = {
    value: 0,
    setValueAtTime: (v, t) => { p.value = v; log.push([name, 'set', v, t]); return p; },
    linearRampToValueAtTime: (v, t) => { log.push([name, 'lin', v, t]); return p; },
    exponentialRampToValueAtTime: (v, t) => { log.push([name, 'exp', v, t]); return p; },
    setTargetAtTime: (v, t, c) => { log.push([name, 'target', v, t, c]); return p; },
    cancelScheduledValues: (t) => { log.push([name, 'cancel', t]); return p; },
  };
  return p;
}

function makeCtx() {
  const log = [];
  const node = (kind) => ({
    kind,
    type: '',
    gain: makeParam(log, kind + '.gain'),
    frequency: makeParam(log, kind + '.frequency'),
    Q: makeParam(log, kind + '.Q'),
    detune: makeParam(log, kind + '.detune'),
    buffer: null,
    loop: false,
    connect() { return this; },
    disconnect() {},
    start(t) { log.push([kind, 'start', t]); },
    stop(t) { log.push([kind, 'stop', t]); },
  });
  return {
    currentTime: 0,
    state: 'running',
    sampleRate: 44100,
    log,
    createGain: () => node('gain'),
    createOscillator: () => node('osc'),
    createBiquadFilter: () => node('filter'),
    createBufferSource: () => node('src'),
    createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
  };
}

function makeEngine() {
  const ctx = makeCtx();
  const master = ctx.createGain();
  return { ctx, engine: new MusicEngine(ctx, master) };
}

// ---- beatClock ----
test('beatClock: старт такта — фаза 0, индекс 0', () => {
  const c = beatClock(0, 120);
  assert.equal(c.index, 0);
  assert.equal(c.phase, 0);
  assert.equal(c.barPhase, 0);
});

test('beatClock: середина четверти даёт фазу 0.5', () => {
  const c = beatClock(0.25, 120); // четверть при 120 BPM = 0.5 с
  assert.equal(c.index, 0);
  assert.ok(Math.abs(c.phase - 0.5) < 1e-9);
  assert.ok(Math.abs(c.barPhase - 0.125) < 1e-9);
});

test('beatClock: граница бита сбрасывает фазу и двигает индекс', () => {
  const before = beatClock(0.499, 120);
  const at = beatClock(0.5, 120);
  assert.equal(before.index, 0);
  assert.ok(before.phase > 0.99);
  assert.equal(at.index, 1);
  assert.ok(at.phase < 1e-9);
});

test('beatClock: фаза всегда в [0,1), barPhase тоже', () => {
  for (let i = 0; i < 500; i++) {
    const c = beatClock(i * 0.037, 128);
    assert.ok(c.phase >= 0 && c.phase < 1, `phase=${c.phase}`);
    assert.ok(c.barPhase >= 0 && c.barPhase < 1, `barPhase=${c.barPhase}`);
  }
});

test('beatClock: переход через такт — barPhase обнуляется на 4-й четверти', () => {
  const beat = 0.5;
  assert.ok(Math.abs(beatClock(beat * 3.999, 120).barPhase - 1) < 1e-2);
  const next = beatClock(beat * 4, 120);
  assert.equal(next.index, 4);
  assert.ok(next.barPhase < 1e-9);
});

test('beatClock: bpm=0 / отрицательный elapsed не дают NaN', () => {
  for (const c of [beatClock(1, 0), beatClock(1, -30), beatClock(NaN, 120), beatClock(-5, 120)]) {
    assert.ok(Number.isFinite(c.index) && Number.isFinite(c.phase) && Number.isFinite(c.barPhase));
    assert.equal(c.phase, 0);
    assert.equal(c.barPhase, 0);
    assert.equal(c.index, 0);
  }
});

// ---- activeLayers ----
test('activeLayers: лид ровно на 8, не на 7', () => {
  assert.equal(activeLayers(7).lead, false);
  assert.equal(activeLayers(8).lead, true);
  assert.equal(LAYER_THRESHOLDS.lead, 8);
});

test('activeLayers: арпеджиатор ровно на 12, клэп на 10', () => {
  assert.equal(activeLayers(11).arpeggio, false);
  assert.equal(activeLayers(12).arpeggio, true);
  assert.equal(activeLayers(9).clap, false);
  assert.equal(activeLayers(10).clap, true);
});

test('activeLayers: нижние слои не пропадают наверху, kick всегда', () => {
  assert.equal(activeLayers(0).kick, true);
  const top = activeLayers(30);
  for (const k of ['kick', 'bass', 'hats', 'arp', 'lead', 'clap', 'arpeggio']) {
    assert.equal(top[k], true, `слой ${k} пропал при I=30`);
  }
  const zero = activeLayers(0);
  assert.deepEqual(
    [zero.bass, zero.hats, zero.arp, zero.lead, zero.clap, zero.arpeggio],
    [false, false, false, false, false, false]);
});

// ---- MusicEngine ----
test('MusicEngine: до setState фаза нулевая и ничего не падает', () => {
  const { engine } = makeEngine();
  assert.equal(engine.bpm, 0);
  assert.equal(engine.beatPhase, 0);
  assert.equal(engine.barPhase, 0);
  assert.equal(engine.beatIndex, 0);
  assert.ok(Number.isFinite(engine.pulse()));
  engine.dispose();
});

test('MusicEngine: setState ставит origin, фаза считается от него', () => {
  const { ctx, engine } = makeEngine();
  ctx.currentTime = 10;
  engine.setState('run');
  assert.equal(engine.bpm, 128);
  assert.ok(engine.originTime >= 10);
  ctx.currentTime = engine.originTime; // ровно в origin
  assert.ok(engine.beatPhase < 1e-9);
  ctx.currentTime = engine.originTime + 60 / 128 / 2;
  assert.ok(Math.abs(engine.beatPhase - 0.5) < 1e-6);
  engine.dispose();
});

test('MusicEngine: beatPhase растёт со временем и сбрасывается на бите', () => {
  const { ctx, engine } = makeEngine();
  engine.setState('run');
  const beat = 60 / 128;
  const o = engine.originTime;
  ctx.currentTime = o + beat * 0.2;
  const a = engine.beatPhase;
  ctx.currentTime = o + beat * 0.8;
  const b = engine.beatPhase;
  assert.ok(b > a, 'фаза должна расти');
  ctx.currentTime = o + beat * 1.05;
  assert.ok(engine.beatPhase < a, 'после бита фаза сбрасывается');
  assert.equal(engine.beatIndex, 1);
  engine.dispose();
});

test('MusicEngine: pulse падает от ~1 к ~0 внутри четверти', () => {
  const { ctx, engine } = makeEngine();
  engine.setState('run');
  const beat = 60 / 128, o = engine.originTime;
  ctx.currentTime = o + beat * 0.01;
  const hi = engine.pulse();
  ctx.currentTime = o + beat * 0.95;
  const lo = engine.pulse();
  assert.ok(hi > 0.9 && hi <= 1, `hi=${hi}`);
  assert.ok(lo < 0.05, `lo=${lo}`);
  engine.dispose();
});

test('MusicEngine: остановленный контекст — фаза 0, без NaN', () => {
  const { ctx, engine } = makeEngine();
  engine.setState('run');
  ctx.currentTime = engine.originTime + 1.3;
  ctx.state = 'suspended';
  assert.equal(engine.beatPhase, 0);
  assert.equal(engine.barPhase, 0);
  assert.equal(engine.pulse(), 0);
  engine.dispose();
});

test('MusicEngine: падение комбо ниже лида обрывает мелодию', () => {
  const { ctx, engine } = makeEngine();
  engine.setState('run');
  engine.setIntensity(9);
  assert.equal(engine.leadCutAt, null);
  ctx.currentTime = 5;
  engine.setIntensity(0);
  assert.equal(engine.leadCutAt, 5, 'leadCut должен сработать при 9 → 0');
  engine.dispose();
});

test('MusicEngine: падение внутри лид-зоны (9 → 8) мелодию не рвёт', () => {
  const { ctx, engine } = makeEngine();
  engine.setState('run');
  engine.setIntensity(9);
  ctx.currentTime = 5;
  engine.setIntensity(8);
  assert.equal(engine.leadCutAt, null);
  engine.dispose();
});

test('MusicEngine: рост комбо лид не рвёт', () => {
  const { engine } = makeEngine();
  engine.setState('run');
  engine.setIntensity(2);
  engine.setIntensity(14);
  assert.equal(engine.leadCutAt, null);
  engine.dispose();
});

test('MusicEngine: drumFill выставляет окно сбивки в будущем', () => {
  const { ctx, engine } = makeEngine();
  engine.setState('run');
  ctx.currentTime = 3;
  engine.drumFill(0.5);
  assert.ok(engine._fillUntil > 3.5, `_fillUntil=${engine._fillUntil}`);
  engine.dispose();
});

test('MusicEngine: планировщик генерирует звук и не ломается на всех интенсивностях', () => {
  const { ctx, engine } = makeEngine();
  engine.setState('run');
  engine.drumFill(0);
  for (const I of [0, 1, 2, 4, 7, 8, 10, 12, 25]) {
    engine.setIntensity(I);
    for (let i = 0; i < 40; i++) { ctx.currentTime += 0.05; engine._tick(); }
  }
  assert.ok(ctx.log.some(e => e[1] === 'start'), 'ничего не запланировано');
  assert.ok(ctx.log.every(e => e.slice(2).every(v => typeof v !== 'number' || Number.isFinite(v))),
    'в расписание попал NaN');
  engine.dispose();
});

// ---- AudioEngine.cue ----
function makeAudio() {
  const ctx = makeCtx();
  const a = new AudioEngine();
  a.ctx = ctx;
  a.master = ctx.createGain();
  a._noise = ctx.createBuffer(1, 128, 44100);
  return { ctx, a };
}

test('cue: планируется в будущее и не падает ни на одном типе снаряда', () => {
  const { ctx, a } = makeAudio();
  ctx.currentTime = 4;
  for (const type of [...Object.keys(QTE_DEFS), 'какой-то-новый-тип']) {
    const before = ctx.log.length;
    a.cue(type, 0.5);
    assert.ok(ctx.log.length > before, `тип ${type} не дал звука`);
  }
  const starts = ctx.log.filter(e => e[1] === 'start');
  assert.ok(starts.length > 0);
  assert.ok(starts.every(e => e[2] >= 4.5 - 1e-9), 'cue запланирован раньше delay');
});

test('cue: без контекста молчит, отрицательный delay не уводит в прошлое', () => {
  const silent = new AudioEngine();
  assert.doesNotThrow(() => silent.cue('jump', 0.5));
  const { ctx, a } = makeAudio();
  ctx.currentTime = 2;
  a.cue('jump', -5);
  assert.ok(ctx.log.filter(e => e[1] === 'start').every(e => e[2] >= 2 - 1e-9));
});

test('cue: разные типы звучат по-разному (тембр различим)', () => {
  const sig = (type) => {
    const { ctx, a } = makeAudio();
    a.cue(type, 0);
    return JSON.stringify(ctx.log.filter(e => e[0].endsWith('frequency') || e[1] === 'start'));
  };
  const groups = ['jump', 'tire', 'seesaw', 'tunnel', 'spread', 'weave', 'table', 'aframe'];
  const seen = new Set(groups.map(sig));
  assert.equal(seen.size, groups.length, 'какие-то типы cue звучат одинаково');
});

test('MusicEngine: dispose снимает таймер', () => {
  const { engine } = makeEngine();
  assert.ok(engine._timer);
  engine.dispose();
  assert.equal(engine._timer, null);
});

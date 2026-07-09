// QTE-система: реакция собаки на команды хендлера. Чистая логика, время (сек) подаётся извне.
//
// Виды QTE:
//  press       — одна клавиша в тайминг-окне (барьеры, шина, стена, длинный прыжок, туннель)
//  rhythm      — чередование ←→ по битам (слалом, 12 стоек = 6 тактов)
//  holdRelease — удерживать ↑ на снаряде, отпустить в жёлтой контактной зоне (горка, бум)
//  twoStage    — ↑ на заход, затем Space в момент опускания доски (качели)
//  hold        — удерживать Space до заполнения шкалы (стол)

export const QTE_DEFS = {
  jump:    { kind: 'press', key: 'Space',     command: 'Хоп!',        window: 0.55, lead: 1.0 },
  tire:    { kind: 'press', key: 'Space',     command: 'Хоп!',        window: 0.48, lead: 1.0 },
  wall:    { kind: 'press', key: 'Space',     command: 'Хоп!',        window: 0.52, lead: 1.0 },
  broad:   { kind: 'press', key: 'Space',     command: 'Хоп-хоп!',    window: 0.52, lead: 1.0 },
  tunnel:  { kind: 'press', key: 'ArrowDown', command: 'Туннель!',    window: 0.60, lead: 1.1 },
  weave:   { kind: 'rhythm', keys: ['ArrowLeft', 'ArrowRight'], beats: 6, beat: 0.46,
             command: 'Змейка!', window: 0.38, lead: 1.2 },
  aframe:  { kind: 'holdRelease', key: 'ArrowUp', command: 'Вперёд!', zoneCmd: 'Зона!',
             window: 0.6, lead: 1.1, travel: 1.6, zone: [0.72, 0.97] },
  dogwalk: { kind: 'holdRelease', key: 'ArrowUp', command: 'Вперёд!', zoneCmd: 'Зона!',
             window: 0.65, lead: 1.1, travel: 2.2, zone: [0.78, 0.98] },
  seesaw:  { kind: 'twoStage', key: 'ArrowUp', key2: 'Space', command: 'Качели!', tipCmd: 'Жди!',
             window: 0.5, lead: 1.1, tipDelay: 0.9, window2: 0.42 },
  table:   { kind: 'hold', key: 'Space', command: 'Стол!', holdCmd: 'Ждать…',
             holdTime: 3.0, window: 0.6, lead: 1.1 },
};

// PS-style обманки: на press-снарядах показываем несколько кнопок,
// настоящая раскрывается за reveal секунд до цели. Сложнее с классом.
export const DECOY_CHANCE = { novice: 0, open: 0.35, excellent: 0.55, masters: 0.75 };
export const DECOY_REVEAL = { novice: 0.6, open: 0.55, excellent: 0.45, masters: 0.35 };
const ALL_KEYS = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

export function makeDecoys(realKey, cls, rand = Math.random) {
  const pool = ALL_KEYS.filter(k => k !== realKey);
  const a = pool.splice(Math.floor(rand() * pool.length), 1)[0];
  const b = pool.splice(Math.floor(rand() * pool.length), 1)[0];
  const options = [realKey, a, b];
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return { options, reveal: DECOY_REVEAL[cls] ?? 0.5, revealed: false };
}

export function gradeFromDelta(dt, window) {
  const a = Math.abs(dt);
  if (a <= window * 0.28) return 'perfect';
  if (a <= window * 0.60) return 'good';
  if (a <= window) return 'late';
  return 'miss';
}

const GRADE_SCORE = { perfect: 3, good: 2, late: 1, miss: 0 };

// Общий контракт: new Qte(type, {windowScale}) → update(t)/press(key,t)/release(key,t)
// события копятся в this.events (и возвращаются из вызова), финал — this.result.
export class Qte {
  constructor(type, opts = {}) {
    this.type = type;
    this.def = QTE_DEFS[type];
    if (!this.def) throw new Error('unknown qte type: ' + type);
    this.w = this.def.window * (opts.windowScale || 1);
    this.state = 'wait';       // wait → active → done
    this.result = null;        // {grade, faults, label}
    this.events = [];
    this.target = this.def.lead;   // момент идеального действия (сек от старта QTE)
    this.beatIdx = 0;
    this.beatGrades = [];
    this.holding = false;
    this.stage = 0;
    this.stageGrade = 'good';   // защитная инициализация для twoStage
    this.holdStart = null;
    this.progress = 0;         // для шкал (стол, контактные)
  }

  _emit(type, data = {}) { this.events.push({ type, ...data }); }

  _finish(grade, faults, label) {
    if (this.state === 'done') return;
    this.state = 'done';
    this.result = { grade, faults, label, score: GRADE_SCORE[grade] ?? 0 };
    this._emit('result', this.result);
  }

  update(t) {
    const d = this.def, w = this.w;
    if (this.state === 'done') return this._drain();
    if (this.state === 'wait') { this.state = 'active'; this._emit('command', { text: d.command }); }

    switch (d.kind) {
      case 'press':
        if (t > this.target + w) this._finish('miss', 5, 'Отказ!');
        break;
      case 'rhythm': {
        while (this.beatIdx < d.beats && t > this.target + this.beatIdx * d.beat + w) {
          this.beatGrades.push('miss');
          this._emit('beat', { i: this.beatIdx, grade: 'miss' });
          this.beatIdx++;
        }
        if (this.beatIdx >= d.beats) this._finishRhythm();
        break;
      }
      case 'holdRelease': {
        // target = момент, когда нужно уже держать ↑; затем travel по снаряду; зона — доля travel.
        if (!this.holding && this.holdStart == null && t > this.target + w) {
          this._finish('miss', 5, 'Отказ!');
          break;
        }
        if (this.holding) {
          this.progress = Math.min(1, (t - this.holdStart2) / d.travel);
          if (this.progress >= 1) {
            // Не отпустил — собака сама сошла, медленно, но зону задела.
            this._finish('late', 0, 'Медленно…');
          }
        }
        break;
      }
      case 'twoStage': {
        if (this.stage === 0 && t > this.target + w) { this._finish('miss', 5, 'Отказ!'); break; }
        if (this.stage === 1) {
          const tipT = this.tipAt + d.tipDelay;
          this.progress = Math.min(1, (t - this.tipAt) / d.tipDelay);
          if (t > tipT + this.w * 1.2) this._finish('miss', 5, 'Спрыгнула!');
        }
        break;
      }
      case 'hold': {
        if (!this.holding && this.holdStart == null && t > this.target + w) {
          this._finish('miss', 5, 'Мимо стола!');
          break;
        }
        if (this.holding) {
          this.progress = Math.min(1, (t - this.holdStart) / d.holdTime);
          if (this.progress >= 1) {
            const g = gradeFromDelta(this.pressDelta, w);
            this._finish(g === 'miss' ? 'late' : g, 0, 'Выдержка!');
          }
        }
        break;
      }
    }
    return this._drain();
  }

  press(key, t) {
    if (this.state !== 'active') return this._drain();
    const d = this.def, w = this.w;
    switch (d.kind) {
      case 'press': {
        if (key !== d.key) { this._finish('miss', 5, wrongLabel(this.type)); break; }
        const g = gradeFromDelta(t - this.target, w);
        this._finish(g, g === 'miss' ? 5 : 0, g === 'miss' ? wrongLabel(this.type) : null);
        break;
      }
      case 'rhythm': {
        if (this.beatIdx >= d.beats) break;
        const expect = d.keys[this.beatIdx % 2];
        const beatT = this.target + this.beatIdx * d.beat;
        const g = key === expect ? gradeFromDelta(t - beatT, w) : 'miss';
        this.beatGrades.push(g);
        this._emit('beat', { i: this.beatIdx, grade: g });
        this.beatIdx++;
        if (this.beatIdx >= d.beats) this._finishRhythm();
        break;
      }
      case 'holdRelease': {
        if (key !== d.key || this.holding || this.holdStart != null) break;
        this.entryGrade = gradeFromDelta(t - this.target, w);
        if (this.entryGrade === 'miss') { this._finish('miss', 5, 'Отказ!'); break; }
        this.holding = true;
        this.holdStart = t;
        this.holdStart2 = t;
        this._emit('climb');
        break;
      }
      case 'twoStage': {
        if (this.stage === 0) {
          if (key !== d.key) { this._finish('miss', 5, 'Отказ!'); break; }
          const g = gradeFromDelta(t - this.target, w);
          if (g === 'miss') { this._finish('miss', 5, 'Отказ!'); break; }
          this.stage = 1; this.stageGrade = g; this.tipAt = t;
          this._emit('tip', { text: d.tipCmd });
        } else if (this.stage === 1) {
          if (key !== d.key2) { this._finish('miss', 5, 'Спрыгнула!'); break; }
          const g = gradeFromDelta(t - (this.tipAt + d.tipDelay), this.def.window2 * (this.w / this.def.window));
          if (g === 'miss') { this._finish('miss', 5, 'Рано!'); break; }
          const combined = GRADE_SCORE[g] < GRADE_SCORE[this.stageGrade] ? g : this.stageGrade;
          this._finish(combined, 0, null);
        }
        break;
      }
      case 'hold': {
        if (key !== d.key || this.holding || this.holdStart != null) break;
        this.pressDelta = t - this.target;
        if (gradeFromDelta(this.pressDelta, w) === 'miss') { this._finish('miss', 5, 'Мимо стола!'); break; }
        this.holding = true;
        this.holdStart = t;
        this._emit('hold', { text: d.holdCmd });
        break;
      }
    }
    return this._drain();
  }

  release(key, t) {
    if (this.state !== 'active' || !this.holding) return this._drain();
    const d = this.def;
    if (key !== d.key) return this._drain();
    switch (d.kind) {
      case 'holdRelease': {
        const p = this.progress;
        if (p < d.zone[0]) {
          this._finish('miss', 5, 'Мимо зоны!');
        } else {
          const zc = (d.zone[0] + d.zone[1]) / 2, zr = (d.zone[1] - d.zone[0]) / 2;
          const g = Math.abs(p - zc) < zr * 0.45 ? 'perfect' : 'good';
          const worst = GRADE_SCORE[g] < GRADE_SCORE[this.entryGrade] ? g : this.entryGrade;
          this._finish(worst, 0, 'Зона!');
        }
        break;
      }
      case 'hold': {
        this._finish('miss', 5, 'Рано сошла!');
        break;
      }
    }
    return this._drain();
  }

  _finishRhythm() {
    const misses = this.beatGrades.filter(g => g === 'miss').length;
    if (misses > 0) { this._finish('miss', 5, 'Пропуск стойки!'); return; }
    const avg = this.beatGrades.reduce((s, g) => s + GRADE_SCORE[g], 0) / this.beatGrades.length;
    this._finish(avg >= 2.6 ? 'perfect' : avg >= 1.8 ? 'good' : 'late', 0, null);
  }

  _drain() { const e = this.events; this.events = []; return e; }
}

function wrongLabel(type) {
  return { jump: 'Сбита планка!', wall: 'Сбит кирпич!', tire: 'Задела шину!',
           broad: 'Наступила!', tunnel: 'Отказ!' }[type] || 'Ошибка!';
}

// Длительность фазы прохождения снаряда после QTE (сек) — для планирования в game.js.
export function qteDuration(type) {
  const d = QTE_DEFS[type];
  switch (d.kind) {
    case 'rhythm': return d.lead + d.beats * d.beat + 0.3;
    case 'holdRelease': return d.lead + d.travel + 0.4;
    case 'twoStage': return d.lead + d.tipDelay + 0.8;
    case 'hold': return d.lead + d.holdTime + 0.5;
    default: return d.lead + 0.5;
  }
}

// QTE-система: реакция собаки на команды хендлера. Чистая логика, время (сек) подаётся извне.
//
// Виды QTE:
//  press       — одна клавиша в тайминг-окне (барьеры, стена, длинный прыжок, туннель)
//  rhythm      — чередование ←→ по битам (легаси-слалом; в V4 заменён groove)
//  groove      — слалом-ритм: 12 стоек = 12 битов метронома, окна в мс (не масштабируются
//                породой), BPM растёт от perfect-серий, 3 промаха = возврат на 1-ю стойку
//  holdRelease — удерживать ↑ на снаряде, отпустить в жёлтой контактной зоне (горка, бум)
//  twoStage    — ↑ на заход, затем Space в момент опускания доски (качели)
//  hold        — удерживать Space до заполнения шкалы (легаси-стол)
//  freeze      — стол «Замри»: заход, 5с НЕ трогать кнопки (судья считает, бывают
//                фейк-паузы), затем GO → Space за goWindow; ввод во время счёта = заново
//  doubleTap   — шина: тап на взлёте + второй тап в апексе полёта (окно фикс. в мс)
//  charge      — spread/triple: зажать Space, дуга заряда до 100% за travel сек,
//                отпустить в узком секторе зоны; перезаряд или слабый заряд = сбитая планка
//  serp        — серпантин: 3-5 барьеров веером, направление раскрывается за reveal
//                до бита — жми стрелку стороны в темп

export const QTE_DEFS = {
  jump:    { kind: 'press', key: 'Space',     command: 'Хоп!',        window: 0.55, lead: 1.0 },
  tire:    { kind: 'doubleTap', key: 'Space', command: 'Хоп!', apexCmd: 'Ещё!',
             window: 0.48, lead: 1.0, apexDelay: 0.5, window2: 0.22 },
  wall:    { kind: 'press', key: 'Space',     command: 'Хоп!',        window: 0.52, lead: 1.0 },
  broad:   { kind: 'press', key: 'Space',     command: 'Хоп-хоп!',    window: 0.52, lead: 1.0 },
  tunnel:  { kind: 'press', key: 'ArrowDown', command: 'Туннель!',    window: 0.60, lead: 1.1 },
  weave:   { kind: 'groove', keys: ['ArrowLeft', 'ArrowRight'], beats: 12,
             command: 'Змейка!', window: 0.38, lead: 1.2 },
  aframe:  { kind: 'holdRelease', key: 'ArrowUp', command: 'Вперёд!', zoneCmd: 'Зона!',
             window: 0.6, lead: 1.1, travel: 1.6, zone: [0.72, 0.97] },
  dogwalk: { kind: 'holdRelease', key: 'ArrowUp', command: 'Вперёд!', zoneCmd: 'Зона!',
             window: 0.65, lead: 1.1, travel: 2.2, zone: [0.78, 0.98] },
  seesaw:  { kind: 'twoStage', key: 'ArrowUp', key2: 'Space', command: 'Качели!', tipCmd: 'Жди!',
             window: 0.5, lead: 1.1, tipDelay: 0.9, window2: 0.42 },
  table:   { kind: 'freeze', key: 'Space', command: 'Стол!', holdCmd: 'Замри…', goCmd: 'GO!',
             freezeTime: 5.0, goWindow: 0.35, window: 0.6, lead: 1.1 },
  spread:  { kind: 'charge', key: 'Space', command: 'Заряд!',
             window: 0.55, lead: 1.0, travel: 0.9, zone: [0.60, 0.85] },
  triple:  { kind: 'charge', key: 'Space', command: 'Заря-я-яд!',
             window: 0.5, lead: 1.0, travel: 0.9, zone: [0.68, 0.82] },
  serpentine: { kind: 'serp', keys: ['ArrowLeft', 'ArrowRight'], count: 4, beat: 0.62,
             reveal: 0.7, command: 'Серпантин!', window: 0.4, lead: 1.2 },
};

// Weave Groove: BPM и окна (сек) по классам. Окна НЕ масштабируются породой —
// это чистый скилл-потолок. ok маппится в грейд 'late'.
export const GROOVE_BPM = { novice: 96, open: 112, excellent: 128, masters: 144 };
export const GROOVE_WINDOWS = {
  novice:    { p: 0.090, g: 0.160, o: 0.230 },
  open:      { p: 0.075, g: 0.130, o: 0.190 },
  excellent: { p: 0.060, g: 0.110, o: 0.160 },
  masters:   { p: 0.045, g: 0.085, o: 0.125 },
};

// PS-style обманки: на press-снарядах показываем несколько кнопок, настоящая
// раскрывается за reveal секунд до цели. Настоящие, но РЕДКИЕ — иначе на мобайле
// (основная платформа) слишком сложно тянуться к разным кнопкам.
export const DECOY_CHANCE = { novice: 0, open: 0.1, excellent: 0.18, masters: 0.3 };
export const DECOY_REVEAL = { novice: 0.6, open: 0.6, excellent: 0.55, masters: 0.5 };
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

// Общий контракт: new Qte(type, {windowScale, ...}) → update(t)/press(key,t)/release(key,t)
// события копятся в this.events (и возвращаются из вызова), финал — this.result.
// opts для V4: bpm/grooveWindows/accelEvery/audioOffset (groove), fakePauses (freeze),
// serpSeq или serpRand (serp), riskScale (late-commit сжимает окно).
export class Qte {
  constructor(type, opts = {}) {
    this.type = type;
    this.def = QTE_DEFS[type];
    if (!this.def) throw new Error('unknown qte type: ' + type);
    this.w = this.def.window * (opts.windowScale || 1) * (opts.riskScale || 1);
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
    const d = this.def;
    if (d.kind === 'groove') {
      this.beat = 60 / (opts.bpm || 120);
      this.baseBeat = this.beat; // рестарт возвращает исходный темп
      this.gw = opts.grooveWindows || GROOVE_WINDOWS.open;
      this.accelEvery = opts.accelEvery || 4;   // perfect-серия для +4% BPM
      this.audioOffset = opts.audioOffset || 0; // калибровка задержки звука (сек)
      this.nextBeatT = null;   // ставится при активации (= target)
      this.perfectStreak = 0;
      this.missCount = 0;      // промахи текущего прохода; 3 = возврат на 1-ю стойку
      this.restarts = 0;
      this._lastMissBeat = null; // для стресс-окна после промаха
    }
    if (d.kind === 'freeze') {
      this.fakePauses = opts.fakePauses || []; // [{at, dur}] по сырому времени счёта
      this.freezeStart = null;
      this.goAt = null;
      // Сентинел выше любого счёта — иначе первый же update после старта/сброса
      // эмитит ложный count(5) до того, как прошло время
      this._lastSec = Math.ceil(d.freezeTime) + 1;
    }
    if (d.kind === 'serp') {
      const rand = opts.serpRand || Math.random;
      this.seq = opts.serpSeq ||
        Array.from({ length: d.count }, () => d.keys[rand() < 0.5 ? 0 : 1]);
    }
    // Прогрессия: до Excellent шина — обычный одиночный тап (без апекса)
    this.noApex = !!opts.noApex;
  }

  _emit(type, data = {}) { this.events.push({ type, ...data }); }

  _finish(grade, faults, label) {
    if (this.state === 'done') return;
    this.state = 'done';
    // hitMs — знаковая дельта тайминга в мс (для микро-подсказки S1.11), если известна
    const hitMs = this._hitDelta != null ? Math.round(this._hitDelta * 1000) : null;
    this.result = { grade, faults, label, score: GRADE_SCORE[grade] ?? 0, hitMs };
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
      case 'freeze': {
        // stage 0: заход на стол (press в окне); 1: счёт «замри»; 2: GO-окно
        if (this.stage === 0 && t > this.target + w) { this._finish('miss', 5, 'Мимо стола!'); break; }
        if (this.stage === 1) {
          const raw = t - this.freezeStart;
          this.inPause = this.fakePauses.some(p => raw >= p.at && raw < p.at + p.dur);
          const paused = this.fakePauses.reduce(
            (s, p) => s + Math.min(Math.max(raw - p.at, 0), p.dur), 0);
          const pure = raw - paused;
          this.progress = Math.min(1, pure / d.freezeTime);
          // Судья считает вслух: 5..1 по чистым секундам
          const sec = Math.ceil(d.freezeTime - pure);
          if (sec !== this._lastSec && sec >= 1 && sec <= d.freezeTime) {
            this._lastSec = sec;
            this._emit('count', { n: sec });
          }
          if (pure >= d.freezeTime) {
            this.stage = 2;
            this.goAt = t;
            this._emit('go', { text: d.goCmd });
          }
        } else if (this.stage === 2) {
          if (t > this.goAt + d.goWindow) {
            this._finish('late', 0, 'Замешкалась…');
          }
        }
        break;
      }
      case 'doubleTap': {
        if (this.stage === 0 && t > this.target + w) { this._finish('miss', 5, 'Отказ!'); break; }
        if (this.stage === 1) {
          const apexT = this.tapAt + (this.apexDelay ?? d.apexDelay);
          if (!this._apexFired && t >= apexT) {
            this._apexFired = true;
            this._emit('apex', { text: d.apexCmd });
          }
          // Окно второго тапа фиксированное (±window2/2), породой не масштабируется.
          // Нет второго тапа — не фолт, но лучший исход лишь «впритык».
          if (t > apexT + d.window2) this._finish('late', 0, 'Задними задела…');
        }
        break;
      }
      case 'charge': {
        if (!this.holding && this.holdStart == null && t > this.target + w) {
          this._finish('miss', 5, 'Отказ!');
          break;
        }
        if (this.holding) {
          this.progress = Math.min(1, (t - this.holdStart) / d.travel);
          if (this.progress >= 1) {
            // Перезаряд: собака сорвалась в прыжок сама и снесла планку
            this._finish('miss', 5, 'Перезаряд!');
          }
        }
        break;
      }
      case 'serp': {
        while (this.beatIdx < d.count && t > this.target + this.beatIdx * d.beat + w) {
          this.beatGrades.push('miss');
          this._emit('beat', { i: this.beatIdx, grade: 'miss' });
          this.beatIdx++;
        }
        if (this.beatIdx >= d.count) this._finishSerp();
        break;
      }
      case 'groove': {
        if (this.nextBeatT === null) this.nextBeatT = this.target;
        while (this.beatIdx < d.beats && t > this.nextBeatT + this.gw.o * this._grooveLeeway()) {
          this._grooveBeat('miss', t);
          if (this.state === 'done') break;
        }
        if (this.state !== 'done' && this.beatIdx >= d.beats) this._finishGroove();
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
        // pressKey — настоящая обманка: требуемая клавиша задаётся извне (случайная
        // из показанных «?»), не всегда Space. По умолчанию — натуральная клавиша.
        const need = this.pressKey || d.key;
        if (key !== need) { this._finish('miss', 5, wrongLabel(this.type)); break; }
        // Раннее нажатие до окна: первое прощаем («собака ещё не готова»),
        // каждое следующее — анти-спам: сжимаем окно на 25% (Sekiro), не фейлим.
        // Убирает доминирующую стратегию «тапать заранее» на обманках.
        if (t < this.target - this.w) {
          if (!this.earlyUsed) { this.earlyUsed = true; this._emit('early'); break; }
          this.w = Math.max(this.w * 0.75, this.def.window * 0.3);
          this._emit('early', { penalized: true });
          break;
        }
        this._hitDelta = t - this.target;
        const g = gradeFromDelta(t - this.target, this.w);
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
      case 'freeze': {
        if (this.stage === 0) {
          if (key !== d.key) { this._finish('miss', 5, 'Мимо стола!'); break; }
          const g = gradeFromDelta(t - this.target, w);
          if (g === 'miss') { this._finish('miss', 5, 'Мимо стола!'); break; }
          this.stage = 1;
          this.stageGrade = g;
          this.freezeStart = t;
          this._lastSec = Math.ceil(d.freezeTime) + 1;
          this._emit('hold', { text: d.holdCmd });
        } else if (this.stage === 1) {
          // ЛЮБОЙ ввод во время счёта — судья начинает счёт заново
          this.freezeStart = t;
          this._lastSec = Math.ceil(d.freezeTime) + 1;
          this.progress = 0;
          this._emit('freezeReset');
        } else if (this.stage === 2) {
          if (key !== d.key) { this._finish('miss', 5, 'Спрыгнула вбок!'); break; }
          // Идеал GO-нажатия — четверть окна после сигнала (реакция, не предугадывание)
          const g = gradeFromDelta(t - (this.goAt + d.goWindow * 0.25), d.goWindow * 0.75);
          if (g === 'miss') { this._finish('late', 0, 'Замешкалась…'); break; }
          const combined = GRADE_SCORE[g] < GRADE_SCORE[this.stageGrade] ? g : this.stageGrade;
          this._finish(combined, 0, 'Выдержка!');
        }
        break;
      }
      case 'doubleTap': {
        if (this.stage === 0) {
          if (key !== d.key) { this._finish('miss', 5, 'Задела шину!'); break; }
          if (t < this.target - w && !this.earlyUsed) {
            this.earlyUsed = true;
            this._emit('early');
            break;
          }
          const g = gradeFromDelta(t - this.target, w);
          if (g === 'miss') { this._finish('miss', 5, 'Задела шину!'); break; }
          if (this.noApex) { this._finish(g, 0, null); break; }
          this.stage = 1;
          this.stageGrade = g;
          this.tapAt = t;
          this._emit('takeoff', { grade: g });
        } else if (this.stage === 1) {
          if (key !== d.key) { this._finish('miss', 5, 'Задела шину!'); break; }
          const apexT = this.tapAt + (this.apexDelay ?? d.apexDelay);
          const g = gradeFromDelta(t - apexT, d.window2);
          if (g === 'miss') { this._finish('late', 0, 'Задними задела…'); break; }
          const combined = GRADE_SCORE[g] < GRADE_SCORE[this.stageGrade] ? g : this.stageGrade;
          this._finish(combined, 0, null);
        }
        break;
      }
      case 'charge': {
        if (key !== d.key || this.holding || this.holdStart != null) break;
        this.entryGrade = gradeFromDelta(t - this.target, w);
        if (this.entryGrade === 'miss') { this._finish('miss', 5, 'Отказ!'); break; }
        this.holding = true;
        this.holdStart = t;
        this._emit('chargeStart');
        break;
      }
      case 'serp': {
        if (this.beatIdx >= d.count) break;
        const expect = this.seq[this.beatIdx];
        const beatT = this.target + this.beatIdx * d.beat;
        const g = key === expect ? gradeFromDelta(t - beatT, w) : 'miss';
        this.beatGrades.push(g);
        this._emit('beat', { i: this.beatIdx, grade: g });
        this.beatIdx++;
        if (this.beatIdx >= d.count) this._finishSerp();
        break;
      }
      case 'groove': {
        if (this.nextBeatT === null || this.beatIdx >= d.beats) break;
        const expect = d.keys[this.beatIdx % 2];
        // Калибровка: игрок жмёт на audioOffset позже реального бита — вычитаем
        const delta = (t - this.nextBeatT) - this.audioOffset;
        const lee = this._grooveLeeway();  // стресс-окно: шире на первых битах и после промаха
        let g;
        if (key !== expect) g = 'miss';
        else {
          const a = Math.abs(delta);
          g = a <= this.gw.p * lee ? 'perfect' : a <= this.gw.g * lee ? 'good'
            : a <= this.gw.o * lee ? 'late' : 'miss';
        }
        this._grooveBeat(g, t, g === 'miss' ? null : delta);
        if (this.state !== 'done' && this.beatIdx >= d.beats) this._finishGroove();
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
      case 'charge': {
        const p = this.progress;
        if (p < d.zone[0]) {
          // Слабый заряд — прыжок в планку
          this._finish('miss', 5, 'Слабый заряд!');
        } else {
          const zc = (d.zone[0] + d.zone[1]) / 2, zr = (d.zone[1] - d.zone[0]) / 2;
          const g = Math.abs(p - zc) < zr * 0.45 ? 'perfect' : 'good';
          const worst = GRADE_SCORE[g] < GRADE_SCORE[this.entryGrade] ? g : this.entryGrade;
          this._finish(worst, 0, null);
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

  _finishSerp() {
    const misses = this.beatGrades.filter(g => g === 'miss').length;
    if (misses > 0) { this._finish('miss', 5, 'Сбила!'); return; }
    const avg = this.beatGrades.reduce((s, g) => s + GRADE_SCORE[g], 0) / this.beatGrades.length;
    this._finish(avg >= 2.6 ? 'perfect' : avg >= 1.8 ? 'good' : 'late', 0, null);
  }

  // Скрытое расширение окна: на первых 2 битах и сразу после промаха игрок
  // напряжён и наименее точен (NecroDancer) — окно шире, чтобы не карать в стрессе.
  _grooveLeeway() {
    if (this.beatIdx < 2) return 1.4;
    if (this._lastMissBeat != null && this.beatIdx - this._lastMissBeat <= 1) return 1.35;
    return 1;
  }

  // Обработка одного бита groove: грейд, серии, разгон BPM, возврат при 3 промахах.
  // delta — знаковое смещение хита от бита (для автокалибровки); null для таймаута.
  _grooveBeat(g, t, delta = null) {
    this.beatGrades.push(g);
    // perfectRun — сколько perfect подряд для питч-лесенки (не сбрасывается разгоном)
    if (g === 'perfect') this._pitchIdx = (this._pitchIdx || 0) + 1;
    else this._pitchIdx = 0;
    this._emit('beat', { i: this.beatIdx, grade: g, delta, pitch: this._pitchIdx });
    this.beatIdx++;
    if (g === 'perfect') {
      this.perfectStreak++;
      if (this.perfectStreak % this.accelEvery === 0) {
        // Разгон метронома с потолком 168 BPM — окна не должны перекрываться
        this.beat = Math.max(this.beat / 1.04, 60 / 168);
        this._emit('accel', { bpm: Math.round(60 / this.beat) });
      }
    } else {
      this.perfectStreak = 0;
    }
    if (g === 'miss') {
      this._lastMissBeat = this.beatIdx; // beatIdx уже инкрементнут — след. бит получит leeway
      this.missCount++;
      if (this.missCount >= 3) {
        // Возврат на 1-ю стойку: время идёт, фолтов нет — наказание темпом.
        // Темп тоже сбрасывается — «с первой стойки» значит с исходного ритма,
        // иначе разгон копится через рестарты без предела.
        this.beat = this.baseBeat;
        this.beatIdx = 0;
        this.beatGrades = [];
        this.missCount = 0;
        this.perfectStreak = 0;
        this._lastMissBeat = null;
        this.restarts++;
        this.nextBeatT = t + this.beat * 2;
        this._emit('restart', { n: this.restarts });
        return;
      }
    }
    this.nextBeatT += this.beat;
  }

  _finishGroove() {
    const misses = this.beatGrades.filter(g => g === 'miss').length;
    const golden = this.restarts === 0 && misses === 0 &&
      this.beatGrades.every(g => g === 'perfect');
    if (golden) this._emit('golden');
    let grade;
    if (misses > 0) grade = 'late';
    else {
      const avg = this.beatGrades.reduce((s, g) => s + GRADE_SCORE[g], 0) / this.beatGrades.length;
      grade = avg >= 2.6 ? 'perfect' : avg >= 1.8 ? 'good' : 'late';
    }
    this._finish(grade, 0, golden ? 'GOLDEN WEAVE!' : null);
    if (golden && this.result) this.result.golden = true;
  }

  _drain() { const e = this.events; this.events = []; return e; }
}

function wrongLabel(type) {
  return { jump: 'Сбита планка!', wall: 'Сбит кирпич!', tire: 'Задела шину!',
           broad: 'Наступила!', tunnel: 'Отказ!',
           spread: 'Снесла обе!', triple: 'Снесла все три!' }[type] || 'Ошибка!';
}

// Длительность фазы прохождения снаряда после QTE (сек) — для планирования в game.js.
export function qteDuration(type) {
  const d = QTE_DEFS[type];
  switch (d.kind) {
    case 'rhythm': return d.lead + d.beats * d.beat + 0.3;
    case 'groove': return d.lead + d.beats * (60 / (GROOVE_BPM.open)) + 0.5;
    case 'holdRelease': return d.lead + d.travel + 0.4;
    case 'twoStage': return d.lead + d.tipDelay + 0.8;
    case 'hold': return d.lead + d.holdTime + 0.5;
    case 'freeze': return d.lead + d.freezeTime + d.goWindow + 0.6;
    case 'doubleTap': return d.lead + d.apexDelay + d.window2 + 0.4;
    case 'charge': return d.lead + d.travel + 0.4;
    case 'serp': return d.lead + d.count * d.beat + 0.3;
    default: return d.lead + 0.5;
  }
}

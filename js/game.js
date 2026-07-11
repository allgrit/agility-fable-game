// Оркестратор забега: собака на сплайне, QTE у снарядов, судейство, камера, эффекты.
import { Path } from './spline.js';
import { Qte, QTE_DEFS, makeDecoys, DECOY_CHANCE, GROOVE_BPM, GROOVE_WINDOWS } from './qte.js';
import { computeSct, BREEDS } from './scoring.js';
import { haptic } from './haptics.js';

const TAKEOFF = 1.3;    // м до снаряда — точка отталкивания: идеальный момент команды
const SYNC_TYPES = new Set(['weave', 'aframe', 'dogwalk', 'seesaw', 'table', 'tunnel',
  'spread', 'triple', 'serpentine']);

// Обучающие подсказки: первая встреча со сложной механикой — slow-mo + инструкция.
export const HINTS = {
  tunnel:  'ТУННЕЛЬ: жми НИЗ на подлёте ко входу!',
  weave:   'СЛАЛОМ: жми ЛЕВО и ПРАВО в ритм метронома — стойки-ноты едут к линии удара!',
  aframe:  'ГОРКА: зажми ВЕРХ на подлёте и отпусти в ЖЁЛТОЙ зоне шкалы!',
  dogwalk: 'БУМ: зажми ВЕРХ на подлёте и отпусти в ЖЁЛТОЙ зоне шкалы!',
  seesaw:  'КАЧЕЛИ: ВЕРХ на заходе, потом ХОП, когда доска опустится!',
  table:   'СТОЛ: ХОП на заходе, потом ЗАМРИ — не трогай кнопки, пока судья считает. По сигналу GO — ХОП!',
  tire2:   'ШИНА: ХОП на подлёте и ЕЩЁ раз в верхней точке полёта!',
  spread:  'ЗАРЯД: зажми ХОП на подлёте и отпусти в жёлтом секторе дуги!',
  triple:  'ТРОЙНОЙ: как заряд, но сектор уже — целься точнее!',
  serpentine: 'СЕРПАНТИН: стрелки раскрываются на подлёте — жми сторону в темп!',
};

export class Run {
  constructor({ course, breed, audio, particles, renderer, modifier = 'none', windowMul = 1, audioOffset = 0 }) {
    this.audioOffset = audioOffset; // калибровка задержки звука для groove (сек)
    this.bonusPoints = 0;           // событийные бонусы очков (Golden Weave и т.п.)
    this.course = course;
    this.breed = breed;
    this.modifier = modifier;
    this.windowScale = breed.windowScale * windowMul * (course.class.windowMul || 1);
    this.eliminated = false;
    this.audio = audio;
    this.fx = particles;
    this.r = renderer;
    this.path = new Path(course.pathPoints);
    this.sct = computeSct(this.path.length, course.cls, course.class.sctSpeed);

    // Дистанции входа/выхода снарядов вдоль пути: pathPoints = [start, e1,x1, e2,x2, ..., finish]
    this.marks = course.obstacles.map((o, i) => ({
      o,
      entryD: this.path.pointDists[1 + i * 2],
      exitD: this.path.pointDists[2 + i * 2],
      qte: null, qteStart: 0, resolved: false,
      state: {}, refusalT: 0,
    }));

    this.dog = {
      dist: 0, speed: 0, x: course.start.x, y: course.start.y,
      heading: 0, elevation: 0, airborne: false, runPhase: 0,
      happy: false, hidden: false,
    };
    this.handler = { x: course.start.x - 1.5, y: course.start.y + 2, runPhase: 0, speed: 0, facing: 1, commanding: false, speech: null, shirt: breed.handlerShirt || null };
    this.phase = 'countdown';   // countdown → running → finished
    this.countdownT = 2.2;      // ритуал старта: тишина, стойка, рука судьи
    this.sprint = { active: false, boost: 0, lastKey: null };
    this.slowmoT = 0;           // micro-slow-mo последнего барьера
    this.desatT = 0;            // десатурация при потере комбо
    this.time = 0;
    this.score = { faults: 0, perfects: 0, goods: 0, lates: 0, misses: 0, combo: 0, maxCombo: 0, refusals: 0 };
    this.activeIdx = -1;
    this.boost = 0;       // временный буст скорости
    this.slowT = 0;       // временное замедление после ошибок
    this.hitstop = 0;
    this.popups = [];     // всплывающие оценки {text,color,x,y,t}
    this.events = [];     // для HUD/экрана: {type,...}
    this.finishT = 0;
    this._stepAcc = 0;
    this.hintText = null; // обучающая подсказка при первой встрече механики
    this.hintSlow = 0;    // сек оставшегося slow-mo
    // Late-commit: фокусы риска. Заявка до окна → окно сжимается до 35% ширины,
    // бонусные очки за успех, промах = 5 фолтов.
    const maxFocus = 3 + (breed.ability === 'drive' ? 1 : 0);
    this.focus = { count: maxFocus, max: maxFocus, used: 0, perfectsSince: 0, regens: 0 };
    this._stubbornUsed = false; // джек: один сейв комбо за прогон
  }

  // Заявка риска на текущий press-снаряд: только ДО открытия окна.
  tryRisk() {
    if (this.phase !== 'running' || this.focus.count <= 0) return false;
    const m = this.activeMark;
    if (!m || !m.qte || m.qte.state !== 'active' || m.risk) return false;
    if (m.qte.def.kind !== 'press' && m.qte.def.kind !== 'doubleTap') return false;
    const t = this.time - m.qteStart;
    if (t >= m.qte.target - m.qte.w) return false; // окно уже открыто — поздно
    m.risk = true;
    this.focus.count--;
    this.focus.used++;
    m.qte.w *= 0.35; // окно сжимается до 35% ширины (симметрично вокруг цели)
    this.popups.push({ text: '⚡ РИСК ×2!', color: '#ff8a65', x: this.dog.x, y: this.dog.y - 3.0, t: 0 });
    this.audio.reveal();
    this.emit({ type: 'risk' });
    return true;
  }

  emit(e) { this.events.push(e); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  get activeMark() { return this.activeIdx >= 0 ? this.marks[this.activeIdx] : null; }

  // Опции QTE по типу снаряда: прогрессия механик и параметры V4.
  _qteOpts(type) {
    const cls = this.course.cls;
    const opts = { windowScale: this.windowScale };
    if (type === 'tire') {
      // Double-tap шины — механика Excellent+; раньше это обычный тап
      opts.noApex = cls === 'novice' || cls === 'open';
    }
    if (type === 'table') {
      // Фейк-паузы судьи: с Open одна, с Masters до двух
      const n = cls === 'masters' ? 2 : cls === 'novice' ? 0 : 1;
      opts.fakePauses = Array.from({ length: n }, (_, i) => ({
        at: 1.0 + i * 2.0 + Math.random() * 1.2, dur: 0.35 + Math.random() * 0.25,
      }));
    }
    if (type === 'weave') {
      opts.bpm = GROOVE_BPM[cls] || 112;
      opts.grooveWindows = GROOVE_WINDOWS[cls] || GROOVE_WINDOWS.open;
      opts.accelEvery = this.breed.ability === 'groove' ? 3 : 4;
      opts.audioOffset = this.audioOffset || 0;
    }
    return opts;
  }

  baseSpeed() {
    return this.course.class.dogSpeed * this.breed.speedMul;
  }

  comboMul() { return 1 + Math.min(0.35, this.score.combo * 0.045); }

  // ---------- ВВОД ----------
  input(key, isDown) {
    if (this.phase !== 'running') return;
    if ((key === 'ShiftLeft' || key === 'ShiftRight') && isDown) { this.tryRisk(); return; }
    // Финишный mash-спурт: после последнего снаряда ←→ попеременно = рывок
    if (this.sprint.active && isDown && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      if (this.sprint.lastKey && this.sprint.lastKey !== key) {
        this.sprint.boost = Math.min(0.45, this.sprint.boost + 0.06);
        this.audio.step();
        if (this.sprint.boost >= 0.3) this.audio.crowdRoar(this.sprint.boost);
        this.fx.dust(this.dog.x, this.dog.y);
      }
      this.sprint.lastKey = key;
      return;
    }
    const m = this.activeMark;
    if (!m || !m.qte) return;
    const t = this.time - m.qteStart;
    const evs = isDown ? m.qte.press(key, t) : m.qte.release(key, t);
    this._handleQteEvents(m, evs);
  }

  // ---------- ЦИКЛ ----------
  update(dt) {
    // Таймеры слоу-мо тают по РЕАЛЬНОМУ dt — иначе перекрывающиеся эффекты
    // (hitstop + hint + slowmo) растягивали друг друга в разы
    const rawDt = dt;
    if (this.hitstop > 0) { this.hitstop -= rawDt; dt *= 0.15; }
    if (this.hintSlow > 0) { this.hintSlow -= rawDt; dt *= 0.35; if (this.hintSlow <= 0) this.hintText = null; }
    if (this.slowmoT > 0) { this.slowmoT -= rawDt; dt *= 0.5; }
    if (this.desatT > 0) this.desatT -= dt;
    if (this.flashT > 0) this.flashT -= rawDt;
    this.time += this.phase === 'running' ? dt : 0;
    this.audio.music?.speedFilter(this.dog.speed);

    if (this.phase === 'countdown') {
      // Ритуал старта: полная тишина, собака дрожит в стойке, судья поднимает руку.
      this.countdownT -= dt;
      this.dog.tremble = this.countdownT < 1.6;
      if (this.countdownT <= 0) {
        this.phase = 'running';
        this.dog.tremble = false;
        this.audio.whistle();
        this.audio.crowdLevel(0.3);
        this.audio.music?.setState('run');
        this.emit({ type: 'go' });
      }
    }

    if (this.phase === 'running') this._updateRunning(dt);
    if (this.phase === 'finished') this.finishT += dt;

    this._updateDogPose(dt);
    this._updateHandler(dt);
    this._updateCamera(dt);
    this.fx.update(dt);
    for (const p of this.popups) p.t += dt;
    this.popups = this.popups.filter(p => p.t < 1.1);
  }

  _updateRunning(dt) {
    const d = this.dog;

    // Активация QTE следующего снаряда: дистанция подобрана так, чтобы в момент
    // идеального нажатия (target) собака была в точке отталкивания ДО снаряда.
    if (this.activeIdx < 0) {
      const next = this.marks.findIndex(m => !m.resolved);
      if (next >= 0) {
        const nm = this.marks[next];
        const lead = QTE_DEFS[nm.o.type].lead;
        const v = Math.max(d.speed, this.baseSpeed() * 0.6);
        if (d.dist >= nm.entryD - TAKEOFF - lead * v) {
          this.activeIdx = next;
          nm.qte = new Qte(nm.o.type, this._qteOpts(nm.o.type));
          nm.qteStart = this.time;
          nm.startDist = d.dist;
          nm.state.active = true;
          // Первая встреча со сложной механикой: slow-mo + инструкция.
          // Шина до Excellent — простой тап, её double-tap-хинт под ключом tire2.
          let hintKey = nm.o.type === 'tire' ? (nm.qte.noApex ? null : 'tire2') : nm.o.type;
          if (hintKey && HINTS[hintKey]) {
            let seen = {};
            try { seen = JSON.parse(localStorage.getItem('agility_hints') || '{}'); } catch {}
            if (!seen[hintKey]) {
              seen[hintKey] = true;
              try { localStorage.setItem('agility_hints', JSON.stringify(seen)); } catch {}
              this.hintText = HINTS[hintKey];
              this.hintSlow = 2.4;
            }
          }
          // PS-style обманка: только press-QTE, шанс растёт с классом.
          if (nm.qte.def.kind === 'press' && Math.random() < (DECOY_CHANCE[this.course.cls] || 0)) {
            nm.decoys = makeDecoys(nm.qte.def.key, this.course.cls);
            // Шелти: чутьё — обманка раскрывается заметно раньше
            if (this.breed.ability === 'sense') nm.decoys.reveal *= 1.45;
            nm.decoys.revealAt = nm.qte.target - nm.decoys.reveal;
          }
        }
      }
    }

    const m = this.activeMark;
    if (m && m.qte) {
      // Дрейф цели press-QTE: target всегда = момент прибытия собаки в точку
      // отталкивания при её ТЕКУЩЕЙ скорости — визуал и физика не расходятся.
      if (m.qte.def.kind === 'press' && m.qte.state === 'active') {
        const eta = (m.entryD - TAKEOFF - d.dist) / Math.max(d.speed, 0.5);
        if (eta > 0) {
          // Плавный дрейф цели: без скачков при бустах/замедлениях.
          const want = (this.time - m.qteStart) + eta;
          const drift = Math.max(-0.12, Math.min(0.12, want - m.qte.target));
          m.qte.target += drift;
        }
      }
      const evs = m.qte.update(this.time - m.qteStart);
      this._handleQteEvents(m, evs);
      if (m.decoys && !m.decoys.revealed
          && this.time - m.qteStart >= m.qte.target - m.decoys.reveal) {
        m.decoys.revealed = true;
        this.audio.reveal();
      }
      // Метроном groove: тик каждого бита шедулится точно в WebAudio-времени
      // незадолго до бита (lookahead ~0.12с игрового времени).
      if (m.qte.def.kind === 'groove' && m.qte.state === 'active'
          && m.qte.nextBeatT !== null && m.qte.beatIdx < m.qte.def.beats) {
        const tq = this.time - m.qteStart;
        const eta = m.qte.nextBeatT - tq;
        if (eta <= 0.12 && m.qte._scheduledBeat !== m.qte.beatIdx + m.qte.restarts * 100) {
          m.qte._scheduledBeat = m.qte.beatIdx + m.qte.restarts * 100;
          this.audio.metroTick?.(Math.max(0, eta), m.qte.beatIdx % 2);
        }
      }
    }

    // Финишный спурт активируется, когда все снаряды пройдены
    if (!this.sprint.active && this.marks.every(mm => mm.resolved) && this.phase === 'running') {
      this.sprint.active = true;
      this.emit({ type: 'sprint' });
    }
    if (this.sprint.active) this.sprint.boost = Math.max(0, this.sprint.boost - dt * 0.2);

    // Скорость
    let target = this.baseSpeed() * this.comboMul() * (1 + this.sprint.boost);
    if (this.boost > 0) { target *= 1.3; this.boost -= dt; }
    if (this.slowT > 0) { target *= 0.6; this.slowT -= dt; }
    if (m && !m.resolved && m.o.type === 'weave' && m.qte
        && m.qte.def.kind === 'groove' && m.qte.state === 'active') {
      // Groove-слалом: собака идёт «стойка-в-бит» — позиция привязана к битам,
      // визуал и ритм не расходятся. При возврате на 1-ю стойку отбегает назад.
      const q = m.qte;
      const beatProgress = Math.min(1, q.beatIdx / q.def.beats);
      const wantD = m.entryD + beatProgress * (m.exitD - m.entryD);
      const tq = this.time - m.qteStart;
      const eta = Math.max(0.15, (q.nextBeatT ?? tq) - tq);
      target = Math.min(target, Math.max(-2.5, (wantD - d.dist) / eta));
    } else if (m && !m.resolved && SYNC_TYPES.has(m.o.type) && m.qte && m.qte.state === 'active') {
      // На "синхронных" снарядах не убегаем дальше точки ожидания
      // (градиентное замедление — без ощущения "вкопанной" остановки).
      const waitAt = this._waitPoint(m);
      if (d.dist >= waitAt) target = Math.min(target, 0);
      else if (d.dist >= waitAt - 1.2) target = Math.min(target, 2.0);
      else if (d.dist >= waitAt - 2.0) target = Math.min(target, 3.0);
    }
    if (m && m.refusalT > 0) { m.refusalT -= dt; target = 0.4; }
    for (const mm of this.marks) {
      if (mm.state.rattle > 0) mm.state.rattle -= dt;
      if (mm.state.doneT !== undefined) mm.state.doneT += dt;
      mm.state.dogInside = mm.o.type === 'tunnel' && d.hidden
        && d.dist >= mm.entryD && d.dist <= mm.exitD;
    }
    // Уши торчком при активной команде, хвост поджат после ошибки
    d.alert = !!(m && m.qte && m.qte.state === 'active');
    if (d.sadT > 0) d.sadT -= dt;
    if (this.judgeArmT > 0) this.judgeArmT -= dt;
    this.r.crowdFocusX = d.x;
    d.speed += (target - d.speed) * Math.min(1, dt * 5);
    d.dist += d.speed * dt;

    // Пузырь хендлера нервничает синхронно с приближением к точке нажатия.
    if (this.handler.speech && m && m.qte && m.qte.state === 'active'
        && m.qte.def.kind === 'press') {
      const dd = m.entryD - TAKEOFF - d.dist;
      const v = Math.max(d.speed, 0.5);
      this.handler.speech.urgency = Math.max(0, Math.min(1, 1 - dd / (v * 1.1)));
    }

    // Завершение снаряда: собака миновала выход
    if (m && m.resolved && d.dist > m.exitD + 0.5) {
      m.state.active = false;
      this.activeIdx = -1;
    }

    // Босс-призрак финишировал раньше нас — толпа ахает
    if (this.ghost && !this._ghostFinished && this.time >= this.ghost.time) {
      this._ghostFinished = true;
      this.audio.gasp();
      this.popups.push({ text: `${this.ghost.name} на финише!`, color: '#b388ff',
        x: d.x, y: d.y - 3.2, t: 0 });
    }

    // Финиш
    if (d.dist >= this.path.length - 0.2) {
      this.phase = 'finished';
      d.happy = true;
      haptic('finish');
      this.audio.crowdLevel(0.9);
      const clean = this.score.faults === 0;
      this.audio.music?.setState(clean || this.score.faults <= 5 ? 'results_win' : 'results_fail');
      if (clean) { this.audio.fanfare(); this.audio.cheer(true); }
      else if (this.score.faults <= 10) { this.audio.cheer(true); }
      else this.audio.sad();
      this.fx.confettiBurst(d.x, d.y, clean ? 120 : 40, this.breed.finishFx || null);
      this.emit({ type: 'finish' });
    }
  }

  _waitPoint(m) {
    switch (m.o.type) {
      case 'table': return (m.entryD + m.exitD) / 2;
      case 'seesaw': return m.entryD + (m.exitD - m.entryD) * 0.55;
      // Туннель: не замираем у входа — собака влетает с ходу и ждёт уже внутри.
      case 'tunnel': return m.entryD + 0.8;
      case 'weave': return m.exitD - 0.4;
      case 'serpentine': return m.exitD - 0.4;
      // Заряд: собака приседает у точки отталкивания, копит прыжок
      case 'spread': case 'triple': return m.entryD - 0.9;
      default: return m.exitD - 0.9; // contact: ждём отпускания у зоны
    }
  }

  _handleQteEvents(m, evs) {
    for (const e of evs) {
      switch (e.type) {
        case 'command':
          this.handler.speech = { text: e.text, t: 0, urgency: 0 };
          this.handler.commanding = true;
          this.audio.voice(m.o.type); // голосовой шаблон механики — слышно, что впереди
          this.emit({ type: 'command', text: e.text, obstacle: m.o });
          break;
        case 'beat':
          if (e.grade !== 'miss') {
            m.state.wobble = e.i * 2;
            // Питч-лесенка: perfect играет ноту вверх по пентатонике (osu!-хитсаунд
            // в момент нажатия). good — приглушённо, промах — диссонанс ниже.
            this.audio.grooveHit(e.grade, e.pitch || 0);
          } else {
            this.audio.grooveHit('miss', 0);
          }
          // Автокалибровка: копим знаковые дельты хитов слалома
          if (e.delta != null) this._calibSamples = (this._calibSamples || []).concat(e.delta);
          // Микро-дельта под HUD (S1.11): последняя дельта в мс
          if (e.delta != null) this.lastHitDelta = Math.round(e.delta * 1000);
          break;
        case 'tip':
          this.audio.creak();
          this.handler.speech = { text: e.text, t: 0, urgency: 0.8 };
          break;
        case 'hold':
          this.handler.speech = { text: e.text, t: 0, urgency: 0.4 };
          break;
        case 'climb':
          this.audio.step();
          break;
        // --- V4: стол «Замри» ---
        case 'count':
          this.audio.judgeCount?.(e.n);
          this.handler.speech = { text: `${e.n}…`, t: 0, urgency: 0.2 };
          break;
        case 'freezeReset':
          this.audio.miss();
          this.popups.push({ text: 'Заново!', color: '#ff8a65', x: this.dog.x, y: this.dog.y - 2.6, t: 0 });
          break;
        case 'go':
          this.audio.goSignal?.();
          this.handler.speech = { text: e.text, t: 0, urgency: 1 };
          this.r.zoomPunch();
          break;
        // --- V4: шина double-tap ---
        case 'takeoff': {
          this._jumpArc(m);
          // Апекс — реальная середина дуги при текущей скорости
          const arcLen = (m.exitD + 1.0) - (m.entryD - TAKEOFF);
          m.qte.apexDelay = arcLen / 2 / Math.max(this.dog.speed, 1);
          this.audio.jumpWhoosh();
          break;
        }
        case 'apex':
          this.slowmoT = 0.28;   // slow-mo кадр апекса
          this.handler.speech = { text: e.text, t: 0, urgency: 1 };
          this.popups.push({ text: 'ЕЩЁ!', color: '#8fd8ff', x: this.dog.x, y: this.dog.y - 3.0, t: 0 });
          break;
        // --- V4: чарж-барьер ---
        case 'chargeStart':
          this.audio.chargeSound?.();
          break;
        // --- V4: groove ---
        case 'accel':
          this.popups.push({ text: `Темп! ${e.bpm} BPM`, color: '#b388ff', x: this.dog.x, y: this.dog.y - 3.0, t: 0 });
          this.audio.cheer(false);
          break;
        case 'restart':
          this.popups.push({ text: 'С первой стойки!', color: '#ff8a65', x: this.dog.x, y: this.dog.y - 2.6, t: 0 });
          this.audio.miss();
          this.emit({ type: 'weaveRestart' });
          break;
        case 'golden': {
          // Бонус растёт с классом: на Open голден заметно легче — плоские +1500
          // делали его фарм-классом (вердикт баланс-аудита)
          const gb = { novice: 400, open: 400, excellent: 700, masters: 1000 }[this.course.cls] ?? 700;
          this.bonusPoints += gb;
          this.popups.push({ text: `+${gb}`, color: '#ffd54a', x: this.dog.x + 1.4, y: this.dog.y - 2.2, t: 0 });
          this.fx.confettiBurst(this.dog.x, this.dog.y, 80, 'golden');
          // Кульминация: длинный фриз + вспышка + slow-mo (пропорционально событию)
          this.hitstop = 0.15;
          this.slowmoT = 0.3;
          this.flashT = 0.35;
          this.r.zoomPunch();
          haptic('golden');
          this.audio.fanfare();
          this.emit({ type: 'goldenWeave' });
          break;
        }
        case 'early':
          // Раннее нажатие прощено: мягкий фидбек без фолта
          this.popups.push({ text: 'Рано!', color: '#cfd8dc', x: this.dog.x, y: this.dog.y - 2.6, t: 0 });
          this.audio.click();
          break;
        case 'result':
          this._applyResult(m, e);
          break;
      }
    }
  }

  _applyResult(m, res) {
    // Разминка: провалить нельзя — промах превращается в мягкий повтор захода
    if (this.warmup && res.grade === 'miss') {
      this.handler.commanding = false;
      this.popups.push({ text: 'Ничего, ещё раз!', color: '#9ff0b4', x: this.dog.x, y: this.dog.y - 2.6, t: 0 });
      this.audio.good();
      m.qte = null;
      m.state.active = false;
      m.state.knocked = false;
      this.activeIdx = -1;
      const v = Math.max(this.dog.speed, 3);
      this.dog.dist = Math.max(0, m.entryD - TAKEOFF - QTE_DEFS[m.o.type].lead * v - 2);
      this.slowT = 0.3;
      return;
    }
    m.resolved = true;
    m.state.doneT = 0; // номер лопается в галочку
    this.handler.commanding = false;
    const d = this.dog;
    const { grade, faults, label } = res;
    const gradeText = { perfect: 'ИДЕАЛЬНО!', good: 'Хорошо!', late: 'Впритык…', miss: label || 'Ошибка!' }[grade];
    const gradeColor = { perfect: '#ffd54a', good: '#69f0ae', late: '#ffab6b', miss: '#ff6b6b' }[grade];
    // Выше собаки, чтобы не спорить с кольцом следующего QTE
    this.popups.push({ text: gradeText, color: gradeColor, x: d.x, y: d.y - 2.6, t: 0 });
    // Микро-дельта тайминга (S1.11): учит игрока сдвигать нажатие
    if (res.hitMs != null && grade !== 'miss') {
      const sign = res.hitMs >= 0 ? '+' : '';
      this.popups.push({ text: `${sign}${res.hitMs} мс`, color: '#9fb4c8',
        x: d.x, y: d.y - 1.5, t: 0, small: true });
    }
    // Live-дельта против призрака (S1.4): на каждом снаряде — насколько мы
    // впереди/позади темпа призрака. Зелёный = отыгрываем, красный = теряем.
    if (this.ghost && this.ghost.time > 0) {
      const ghostReach = (m.entryD / this.path.length) * this.ghost.time;
      const lead = ghostReach - this.time; // >0 = мы быстрее призрака к этой точке
      const txt = `${lead >= 0 ? '−' : '+'}${Math.abs(lead).toFixed(1)}с`;
      this.popups.push({ text: txt, color: lead >= 0 ? '#69f0ae' : '#ff8a8a',
        x: d.x + 1.6, y: d.y - 3.2, t: 0 });
    }

    const hadCombo = this.score.combo >= 3;
    if (grade === 'perfect') {
      this.score.perfects++;
      this.score.combo += this.breed.comboRate;
      this.score.maxCombo = Math.max(this.score.maxCombo, Math.floor(this.score.combo));
      this.boost = 1.4;
      this.hitstop = 0.09;
      d.popT = 1;            // squash&stretch пружина на perfect
      haptic('perfect');
      this.audio.perfect();
      this.audio.music?.duck(0.3, 0.1);
      this.fx.sparks(d.x, d.y, '#ffd54a');
      this.r.zoomPunch();
      if (this.score.combo >= 4) this.audio.cheer(false);
      this.audio.crowdLevel(Math.min(0.8, 0.3 + this.score.combo * 0.07));
      // Риск оправдался: ×2 очков за снаряд
      if (m.risk) {
        this.bonusPoints += 120;
        this.popups.push({ text: '⚡ ×2!', color: '#ff8a65', x: d.x + 1.2, y: d.y - 2.0, t: 0 });
      }
      // Восстановление фокуса: 8 перфектов подряд, максимум ОДИН реген за прогон —
      // иначе потолок рисковых очков раздувается на длинных трассах
      this.focus.perfectsSince++;
      if (this.focus.perfectsSince >= 8 && this.focus.count < this.focus.max && this.focus.regens < 1) {
        this.focus.count++;
        this.focus.regens++;
        this.focus.perfectsSince = 0;
        this.popups.push({ text: '+⚡ фокус', color: '#8fd8ff', x: d.x, y: d.y - 3.4, t: 0 });
      }
    } else if (grade === 'good') {
      this.score.goods++;
      this.score.combo += this.breed.comboRate * 0.5;
      this.focus.perfectsSince = 0;
      if (m.risk) this.bonusPoints += 40; // смелость вознаграждается и на good
      this.audio.good();
    } else if (grade === 'late') {
      this.score.lates++;
      this.focus.perfectsSince = 0;
      // Джек: упрямство — один сброс комбо за прогон прощается
      if (hadCombo && this.breed.ability === 'stubborn' && !this._stubbornUsed) {
        this._stubbornUsed = true;
        this.popups.push({ text: 'Упрямство!', color: '#9ff0b4', x: d.x, y: d.y - 3.2, t: 0 });
      } else {
        this.score.combo = 0;
        if (hadCombo) { this.desatT = 0.5; this.audio.music?.dip(); }
      }
      // Планка дрожит от близкого пролёта
      if (m.o.type === 'jump' || m.o.type === 'wall') { m.state.rattle = 0.6; this.audio.creak(); }
      this.audio.crowdLevel(0.25);
    } else {
      this.score.misses++;
      this.score.combo = 0;
      this.focus.perfectsSince = 0;
      this.score.faults += faults;
      this.slowT = 0.6;
      if (hadCombo) { this.desatT = 0.55; this.audio.music?.dip(); }
      haptic('fault');
      this.audio.miss();
      this.audio.gasp();
      this.audio.crowdLevel(0.15);
      this.r.shake(0.55);
      this.r.kick(Math.cos(d.heading) * 8, Math.sin(d.heading) * 6);
      d.sadT = 1.6;          // хвост поджат
      this.judgeArmT = 1.2;  // судья фиксирует фолт рукой
      const isKnock = (m.o.type === 'jump' || m.o.type === 'wall') && label !== 'Отказ!';
      if (isKnock) {
        m.state.knocked = true;
        this.audio.knock();
        this.fx.barPieces(m.o.x, m.o.y, m.o.angle);
      } else {
        // Отказ: собака сбивается с хода
        this.score.refusals++;
        m.refusalT = 1.1;
        if (this.modifier === 'strict' && this.score.refusals >= 3 && this.phase === 'running') {
          // Строгий судья: 3 отказа = дисквалификация
          this.eliminated = true;
          this.phase = 'finished';
          this.audio.sad();
          this.audio.crowdLevel(0.05);
          this.emit({ type: 'finish' });
        }
      }
      this.emit({ type: 'fault', faults });
    }
    this.emit({ type: 'grade', grade });
    this.audio.music?.setIntensity(Math.floor(this.score.combo));

    // Micro-slow-mo на последнем снаряде перед спуртом
    const unresolved = this.marks.filter(mm => !mm.resolved).length;
    if (unresolved === 0 && grade !== 'miss') this.slowmoT = 0.35;

    // Эффект прохождения снаряда
    this._passEffects(m, grade);
  }

  _passEffects(m, grade) {
    const type = m.o.type;
    // Шина double-tap: дуга уже стартовала на событии takeoff
    const tireAirborne = type === 'tire' && m.qte && m.qte.stage >= 1;
    if (['jump', 'tire', 'wall', 'broad', 'spread', 'triple'].includes(type)
        && grade !== 'miss' && !tireAirborne) {
      this._jumpArc(m);
      this.audio.jumpWhoosh();
    }
    if (type === 'tunnel' && grade !== 'miss') this.audio.tunnelWhoosh();
    if (type === 'seesaw' && grade !== 'miss') {
      m.state.tilt = 1;
      this.audio.slam();
    }
    if (type === 'table' && grade !== 'miss') this.audio.land();
  }

  _jumpArc(m) {
    // Дуга начинается с точки отталкивания — там, где собака была в момент команды.
    this._jump = { from: m.entryD - TAKEOFF, to: m.exitD + 1.0, peak: m.o.type === 'tire' ? 1.0 : 0.8 };
  }

  // ---------- ПОЗА СОБАКИ ----------
  _updateDogPose(dt) {
    const d = this.dog;
    const p = this.path.pointAt(d.dist);
    const tg = this.path.tangentAt(d.dist);
    d.x = p.x; d.y = p.y;
    d.heading = Math.atan2(tg.y, tg.x);
    d.runPhase += d.speed * dt * 2.2;

    // Высота: прыжковая дуга или профиль снаряда
    d.elevation = 0; d.airborne = false; d.hidden = false;
    if (this._jump && d.dist >= this._jump.from && d.dist <= this._jump.to) {
      const t = (d.dist - this._jump.from) / (this._jump.to - this._jump.from);
      d.elevation = Math.sin(t * Math.PI) * this._jump.peak;
      d.airborne = true;
      if (t >= 0.98) this.audio.land();
    } else if (this._jump && d.dist > this._jump.to) {
      this._jump = null;
      // Приземление: сквош + двойная пыль + лёгкий камера-кик
      d.landT = 1;
      this.fx.dust(d.x, d.y);
      this.fx.dust(d.x + 0.3, d.y);
      this.r.kick(0, 3);
    }
    if (d.landT > 0) d.landT = Math.max(0, d.landT - dt * 6);
    if (d.popT > 0) d.popT = Math.max(0, d.popT - dt * 5); // ~0.2с пружина perfect

    // След лап на земле + trail-позиции для комбо-шлейфа
    this._pawAcc = (this._pawAcc || 0) + d.speed * dt;
    if (this._pawAcc > 0.9 && !d.airborne && !d.hidden && this.phase === 'running') {
      this._pawAcc = 0;
      this.fx.paw(d.x, d.y, d.heading, this.breed.pawColor || null);
    }
    if (!this.trail) this.trail = [];
    this._trailAcc = (this._trailAcc || 0) + dt;
    if (this._trailAcc > 0.045) {
      this._trailAcc = 0;
      this.trail.push({ x: d.x, y: d.y, e: d.elevation || 0, h: d.heading });
      if (this.trail.length > 7) this.trail.shift();
    }
    const m = this.marks.find(mm => d.dist >= mm.entryD - 0.2 && d.dist <= mm.exitD + 0.2);
    if (m) {
      const t = Math.max(0, Math.min(1, (d.dist - m.entryD) / Math.max(0.01, m.exitD - m.entryD)));
      if (m.o.type === 'aframe') d.elevation = Math.sin(t * Math.PI) * 1.7;
      if (m.o.type === 'dogwalk') d.elevation = t < 0.3 ? t / 0.3 * 1.25 : t > 0.7 ? (1 - t) / 0.3 * 1.25 : 1.25;
      if (m.o.type === 'seesaw') {
        const tilt = m.state.tilt === 1 ? 1 : -1;
        d.elevation = 0.65 + (t - 0.5) * 2 * 0.65 * (tilt === 1 ? -1 : 1) * -1;
        d.elevation = Math.max(0.05, tilt === 1 ? 0.65 * (1 - (t - 0.5) * 2) : 0.65 * (1 + (t - 0.5) * 2) * (t < 0.5 ? t * 2 : 1));
      }
      if (m.o.type === 'table') d.elevation = 0.55;
      if (m.o.type === 'tunnel') d.hidden = true;
    }

    // Пыль из-под лап при быстром беге
    this._stepAcc += d.speed * dt;
    if (this._stepAcc > 1.6 && !d.airborne && !d.hidden && this.phase === 'running') {
      this._stepAcc = 0;
      this.fx.dust(d.x - Math.cos(d.heading) * 0.5, d.y - Math.sin(d.heading) * 0.5);
      if (d.speed > 3) this.audio.step();
    }
  }

  _updateHandler(dt) {
    const h = this.handler, d = this.dog;
    // Хендлер бежит параллельно, ближе к центру поля, чуть позади.
    const behind = this.path.pointAt(Math.max(0, d.dist - 1.6));
    const tg = this.path.tangentAt(Math.max(0, d.dist - 1.6));
    const cx = this.course.field.w / 2, cy = this.course.field.h / 2;
    const side = ((cx - behind.x) * -tg.y + (cy - behind.y) * tg.x) > 0 ? 1 : -1;
    const tx = behind.x - tg.y * 2.4 * side;
    const ty = behind.y + tg.x * 2.4 * side;
    const k = Math.min(1, dt * 3.2);
    const nx = h.x + (tx - h.x) * k, ny = h.y + (ty - h.y) * k;
    h.speed = Math.hypot(nx - h.x, ny - h.y) / Math.max(dt, 1e-6);
    h.facing = (nx - h.x) >= 0 ? 1 : -1;
    h.x = nx; h.y = ny;
    h.runPhase += h.speed * dt * 2.4;
    if (h.speech) {
      h.speech.t += dt;
      if (h.speech.t > 1.6) h.speech = null;
    }
  }

  _updateCamera(dt) {
    const cam = this.r.cam;
    const ahead = this.path.pointAt(Math.min(this.path.length, this.dog.dist + 3.5));
    const tx = (this.dog.x * 0.55 + ahead.x * 0.45);
    const ty = (this.dog.y * 0.55 + ahead.y * 0.45);
    const k = Math.min(1, dt * 3.5);
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;
    const targetZoom = this.r.canvas.height / 22 * (this.phase === 'finished' ? 1.25 : 1);
    cam.zoom += (targetZoom - cam.zoom) * Math.min(1, dt * 2);
  }

  // ---------- РЕНДЕР КАДРА ----------
  draw() {
    const r = this.r, ctx = r.ctx;
    r.drawField(this.course.field, Math.min(1, this.score.combo * 0.12 + (this.phase === 'finished' ? 1 : 0)));
    this.fx.drawGround(ctx, (x, y) => r.toScreen(x, y)); // следы лап — под всем
    r.drawStartFinish(this.course.start, 'СТАРТ');
    r.drawStartFinish(this.course.finish, 'ФИНИШ');
    r.drawJudge(this.course.field.w - 6, 5,
      (this.phase === 'countdown' && this.countdownT < 1.4) || this.judgeArmT > 0);


    // Снаряды в порядке y; собака рисуется поверх снаряда, на котором стоит.
    const sorted = [...this.marks].sort((a, b) => a.o.y - b.o.y);
    const dogY = this.dog.y;
    const onMark = this.marks.find(mm =>
      this.dog.dist >= mm.entryD - 0.2 && this.dog.dist <= mm.exitD + 0.2 && mm.o.type !== 'tunnel');
    const drawDog = () => {
      // Комбо-шлейф: полупрозрачные силуэты позади (HSL-перелив с ×8)
      if (this.score.combo >= 4 && this.trail && this.phase === 'running') {
        this.trail.forEach((p, i) => {
          const a = (i / this.trail.length) * 0.3;
          const s = r.toScreen(p.x, p.y, 0.32 + p.e);
          ctx.save();
          ctx.globalAlpha = a;
          ctx.fillStyle = this.score.combo >= 8
            ? `hsl(${(r.time * 240 + i * 40) % 360}, 90%, 60%)` : this.breed.body;
          ctx.beginPath();
          ctx.ellipse(s.x, s.y, r.cam.zoom * 0.5 * this.breed.size, r.cam.zoom * 0.28 * this.breed.size,
            Math.atan2(Math.sin(p.h) * 0.86, Math.cos(p.h)), 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        });
      }
      if (!this.dog.hidden) r.drawDog(this.dog, this.breed);
      else { ctx.globalAlpha = 0.25; r.drawDog(this.dog, this.breed); ctx.globalAlpha = 1; }
    };
    // Босс-призрак: бежит по трассе с постоянным темпом (время босса = SCT × k).
    // Заметный силуэт с ореолом и шлейфом — соперник, которого надо обогнать.
    if (this.ghost && this.phase !== 'countdown') {
      const gd = Math.min(this.path.length - 0.1,
        Math.max(0, this.time / this.ghost.time * this.path.length));
      const gp = this.path.pointAt(gd);
      const gt = this.path.tangentAt(gd);
      const gh = Math.atan2(gt.y, gt.x);
      const glook = BREEDS[this.ghost.look] || this.breed;
      // Фиолетовый ореол под призраком — виден на любой теме
      const gsb = r.toScreen(gp.x, gp.y, 0.3);
      ctx.save();
      ctx.fillStyle = 'rgba(179,136,255,0.30)';
      ctx.shadowColor = '#b388ff'; ctx.shadowBlur = 22;
      ctx.beginPath();
      ctx.ellipse(gsb.x, gsb.y, r.cam.zoom * 0.9, r.cam.zoom * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // Шлейф из призрачных силуэтов позади
      ctx.save();
      for (let k = 3; k >= 1; k--) {
        const bd = Math.max(0, gd - k * 0.9);
        const bp = this.path.pointAt(bd);
        const bs = r.toScreen(bp.x, bp.y, 0.32);
        ctx.globalAlpha = 0.10 * (4 - k);
        ctx.fillStyle = '#b388ff';
        ctx.beginPath();
        ctx.ellipse(bs.x, bs.y, r.cam.zoom * 0.5, r.cam.zoom * 0.28, gh, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = 0.62;
      r.drawDog({ x: gp.x, y: gp.y, heading: gh,
        runPhase: this.time * 9, elevation: 0, airborne: false }, glook);
      ctx.restore();
      // Подпись на плашке, пульсирует
      const gs = r.toScreen(gp.x, gp.y, 1.9);
      ctx.save();
      ctx.textAlign = 'center';
      const gfs = Math.round(r.cam.zoom * 0.5 * (1 + Math.sin(r.time * 5) * 0.06));
      ctx.font = `900 ${gfs}px "Segoe UI", sans-serif`;
      const gtw = ctx.measureText(`👻 ${this.ghost.name}`).width;
      ctx.fillStyle = 'rgba(20,12,36,0.78)';
      ctx.beginPath();
      ctx.roundRect(gs.x - gtw / 2 - 8, gs.y - gfs * 0.95, gtw + 16, gfs * 1.4, 8);
      ctx.fill();
      ctx.fillStyle = '#d1b3ff';
      ctx.fillText(`👻 ${this.ghost.name}`, gs.x, gs.y);
      ctx.restore();
    }

    let dogDrawn = false;
    for (const m of sorted) {
      if (!onMark && !dogDrawn && m.o.y > dogY && m.o.type !== 'tunnel') { drawDog(); dogDrawn = true; }
      r.drawObstacle(m.o, m.state);
      if (onMark && m === onMark) { drawDog(); dogDrawn = true; }
    }
    if (!dogDrawn) drawDog();

    // Кольцо тайминга вокруг собаки: сжимается к ней, жёлтое = жми сейчас.
    // В «Сумерках» кольцо проявляется только у самой точки отталкивания.
    const tm = this.activeMark;
    if (this.phase === 'running' && tm && tm.qte && tm.qte.state === 'active'
        && tm.qte.def.kind === 'press'
        && !(this.modifier === 'dusk'
          && tm.entryD - TAKEOFF - this.dog.dist > tm.qte.w * Math.max(this.dog.speed, 0.5))) {
      const q = tm.qte;
      const v = Math.max(this.dog.speed, 0.5);
      const dd = tm.entryD - TAKEOFF - this.dog.dist;   // м до точки отталкивания
      const inPerfect = Math.abs(dd) <= q.w * 0.28 * v;
      const inGood = Math.abs(dd) <= q.w * 0.6 * v;
      const s = r.toScreen(this.dog.x, this.dog.y, 0.32 + (this.dog.elevation || 0));
      const base = r.cam.zoom * 0.95;
      const rad = base + Math.max(0, dd) * r.cam.zoom * 0.55;
      ctx.save();
      ctx.strokeStyle = inPerfect ? '#ffd54a' : inGood ? '#69f0ae' : 'rgba(255,255,255,0.65)';
      ctx.lineWidth = inPerfect ? r.cam.zoom * 0.14 : r.cam.zoom * 0.08;
      if (inPerfect) { ctx.shadowColor = '#ffd54a'; ctx.shadowBlur = 14; }
      // Колорблайнд: форма дублирует цвет — пунктир вне окна, двойной контур в perfect
      if (r.colorblind && !inGood) ctx.setLineDash([r.cam.zoom * 0.25, r.cam.zoom * 0.18]);
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, rad, rad * 0.8, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (r.colorblind && inPerfect) {
        ctx.setLineDash([]);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = r.cam.zoom * 0.05;
        ctx.beginPath();
        ctx.ellipse(s.x, s.y, rad * 1.12, rad * 0.9, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    r.drawHandler(this.handler);
    if (this.handler.speech) r.drawSpeech(this.handler, this.handler.speech.text, this.handler.speech.urgency);
    this.fx.draw(ctx, (x, y) => r.toScreen(x, y, 0.5));

    // Эффекты модификаторов
    if (this.modifier === 'rain') {
      ctx.save();
      ctx.strokeStyle = 'rgba(180,210,255,0.35)';
      ctx.lineWidth = 1.5;
      const n = 40, W = r.canvas.width, H = r.canvas.height;
      for (let i = 0; i < n; i++) {
        // Детерминированный псевдослучайный дождь от времени
        const s = Math.sin(i * 127.1) * 43758.5453;
        const fx0 = (s - Math.floor(s));
        const fy = ((r.time * (0.9 + fx0 * 0.6) + fx0 * 7) % 1);
        const x = fx0 * W + fy * 60;
        const y = fy * (H + 80) - 40;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 6, y + 18); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(40,70,120,0.10)';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    } else if (this.modifier === 'dusk') {
      ctx.save();
      const W = r.canvas.width, H = r.canvas.height;
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.72);
      g.addColorStop(0, 'rgba(15,10,40,0.05)');
      g.addColorStop(1, 'rgba(10,6,30,0.55)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    // Тонировка темы (закат/вечер/пасмурно)
    r.drawThemeOverlay();

    // Спидлайны на разогнанном комбо
    if (this.score.combo >= 6 && this.phase === 'running') {
      ctx.save();
      const W = r.canvas.width, H = r.canvas.height;
      ctx.strokeStyle = 'rgba(255,255,255,0.13)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 10; i++) {
        const seed = Math.sin(i * 91.7 + Math.floor(r.time * 12)) * 43758.5;
        const rr = seed - Math.floor(seed);
        const ang = rr * Math.PI * 2;
        const edge = Math.min(W, H) * 0.5;
        const x0 = W / 2 + Math.cos(ang) * edge * 0.92, y0 = H / 2 + Math.sin(ang) * edge * 0.92;
        const x1 = W / 2 + Math.cos(ang) * edge * (0.7 - rr * 0.1), y1 = H / 2 + Math.sin(ang) * edge * (0.7 - rr * 0.1);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      ctx.restore();
    }

    // Десатурация на полсекунды при потере комбо — мир «гаснет»
    if (this.desatT > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'saturation';
      ctx.fillStyle = `hsla(0, 0%, 50%, ${Math.min(0.85, this.desatT * 1.7)})`;
      ctx.fillRect(0, 0, r.canvas.width, r.canvas.height);
      ctx.restore();
    }

    // Белая вспышка кульминации (Golden Weave)
    if (this.flashT > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,250,220,${Math.min(0.6, this.flashT * 1.6)})`;
      ctx.fillRect(0, 0, r.canvas.width, r.canvas.height);
      ctx.restore();
    }

    // Подсказка финишного спурта
    if (this.sprint.active && this.phase === 'running') {
      ctx.save();
      ctx.textAlign = 'center';
      const zz = Math.min(r.canvas.width, r.canvas.height) / 700;
      const pulse = 1 + Math.sin(r.time * 14) * 0.06;
      ctx.font = `900 ${Math.round(34 * zz * pulse)}px "Segoe UI", sans-serif`;
      ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      const msg = 'ФИНИШ! ЖМИ ← → !';
      ctx.strokeText(msg, r.canvas.width / 2, r.canvas.height * 0.24);
      ctx.fillStyle = this.sprint.boost > 0.25 ? '#ffd54a' : '#fff';
      ctx.fillText(msg, r.canvas.width / 2, r.canvas.height * 0.24);
      ctx.restore();
    }

    // Всплывающие оценки (появление с overshoot-скейлом)
    for (const p of this.popups) {
      const s = r.toScreen(p.x, p.y, 1.2 + p.t * 1.4);
      const pop = p.t < 0.18 ? 0.5 + (p.t / 0.18) * 0.75 : 1.25 - Math.min(0.25, (p.t - 0.18) * 1.4);
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - p.t * 0.9);
      // small — микро-дельта тайминга: вдвое мельче основной оценки
      const fscale = p.small ? 0.3 : 0.62;
      ctx.font = `900 ${Math.round(r.cam.zoom * (fscale - p.t * 0.1) * pop)}px "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeText(p.text, s.x, s.y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, s.x, s.y);
      ctx.restore();
    }
  }
}

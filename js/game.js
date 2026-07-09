// Оркестратор забега: собака на сплайне, QTE у снарядов, судейство, камера, эффекты.
import { Path } from './spline.js';
import { Qte, QTE_DEFS, makeDecoys, DECOY_CHANCE } from './qte.js';
import { computeSct } from './scoring.js';

const TAKEOFF = 1.3;    // м до снаряда — точка отталкивания: идеальный момент команды
const SYNC_TYPES = new Set(['weave', 'aframe', 'dogwalk', 'seesaw', 'table', 'tunnel']);

export class Run {
  constructor({ course, breed, audio, particles, renderer, modifier = 'none', windowMul = 1 }) {
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
    this.handler = { x: course.start.x - 1.5, y: course.start.y + 2, runPhase: 0, speed: 0, facing: 1, commanding: false, speech: null };
    this.phase = 'countdown';   // countdown → running → finished
    this.countdownT = 3.2;
    this.lastCount = 4;
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
  }

  emit(e) { this.events.push(e); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  get activeMark() { return this.activeIdx >= 0 ? this.marks[this.activeIdx] : null; }

  baseSpeed() {
    return this.course.class.dogSpeed * this.breed.speedMul;
  }

  comboMul() { return 1 + Math.min(0.35, this.score.combo * 0.045); }

  // ---------- ВВОД ----------
  input(key, isDown) {
    const m = this.activeMark;
    if (this.phase !== 'running' || !m || !m.qte) return;
    const t = this.time - m.qteStart;
    const evs = isDown ? m.qte.press(key, t) : m.qte.release(key, t);
    this._handleQteEvents(m, evs);
  }

  // ---------- ЦИКЛ ----------
  update(dt) {
    if (this.hitstop > 0) { this.hitstop -= dt; dt *= 0.15; }
    this.time += this.phase === 'running' ? dt : 0;

    if (this.phase === 'countdown') {
      this.countdownT -= dt;
      const c = Math.ceil(this.countdownT);
      if (c !== this.lastCount && c > 0) { this.lastCount = c; this.audio.countdown(); }
      if (this.countdownT <= 0) {
        this.phase = 'running';
        this.audio.whistle();
        this.audio.crowdLevel(0.3);
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
          nm.qte = new Qte(nm.o.type, { windowScale: this.windowScale });
          nm.qteStart = this.time;
          nm.startDist = d.dist;
          nm.state.active = true;
          // PS-style обманка: только press-QTE, шанс растёт с классом.
          if (nm.qte.def.kind === 'press' && Math.random() < (DECOY_CHANCE[this.course.cls] || 0)) {
            nm.decoys = makeDecoys(nm.qte.def.key, this.course.cls);
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
        if (eta > 0) m.qte.target = (this.time - m.qteStart) + eta;
      }
      const evs = m.qte.update(this.time - m.qteStart);
      this._handleQteEvents(m, evs);
      if (m.decoys && !m.decoys.revealed
          && this.time - m.qteStart >= m.qte.target - m.decoys.reveal) {
        m.decoys.revealed = true;
        this.audio.reveal();
      }
    }

    // Скорость
    let target = this.baseSpeed() * this.comboMul();
    if (this.boost > 0) { target *= 1.3; this.boost -= dt; }
    if (this.slowT > 0) { target *= 0.6; this.slowT -= dt; }
    if (m && !m.resolved && SYNC_TYPES.has(m.o.type) && m.qte && m.qte.state === 'active') {
      // На "синхронных" снарядах не убегаем дальше точки ожидания.
      const waitAt = this._waitPoint(m);
      if (d.dist >= waitAt) target = Math.min(target, 0);
      else if (d.dist >= waitAt - 1.2) target = Math.min(target, 2.0);
      if (m.o.type === 'weave' && d.dist > m.entryD - 0.5) target = Math.min(target, 2.4);
    }
    if (m && m.refusalT > 0) { m.refusalT -= dt; target = 0.4; }
    d.speed += (target - d.speed) * Math.min(1, dt * 5);
    d.dist += d.speed * dt;

    // Завершение снаряда: собака миновала выход
    if (m && m.resolved && d.dist > m.exitD + 0.5) {
      m.state.active = false;
      this.activeIdx = -1;
    }

    // Финиш
    if (d.dist >= this.path.length - 0.2) {
      this.phase = 'finished';
      d.happy = true;
      this.audio.crowdLevel(0.9);
      const clean = this.score.faults === 0;
      if (clean) { this.audio.fanfare(); this.audio.cheer(true); }
      else if (this.score.faults <= 10) { this.audio.cheer(true); }
      else this.audio.sad();
      this.fx.confettiBurst(d.x, d.y, clean ? 120 : 40);
      this.emit({ type: 'finish' });
    }
  }

  _waitPoint(m) {
    switch (m.o.type) {
      case 'table': return (m.entryD + m.exitD) / 2;
      case 'seesaw': return m.entryD + (m.exitD - m.entryD) * 0.55;
      case 'tunnel': return m.entryD - 0.4;
      case 'weave': return m.exitD - 0.4;
      default: return m.exitD - 0.9; // contact: ждём отпускания у зоны
    }
  }

  _handleQteEvents(m, evs) {
    for (const e of evs) {
      switch (e.type) {
        case 'command':
          this.handler.speech = { text: e.text, t: 0, urgency: 0 };
          this.handler.commanding = true;
          this.audio.bark(this.breed.size);
          this.emit({ type: 'command', text: e.text, obstacle: m.o });
          break;
        case 'beat':
          if (e.grade !== 'miss') { this.audio.weaveTick(e.i); m.state.wobble = e.i * 2; }
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
        case 'result':
          this._applyResult(m, e);
          break;
      }
    }
  }

  _applyResult(m, res) {
    m.resolved = true;
    this.handler.commanding = false;
    const d = this.dog;
    const { grade, faults, label } = res;
    const gradeText = { perfect: 'ИДЕАЛЬНО!', good: 'Хорошо!', late: 'Впритык…', miss: label || 'Ошибка!' }[grade];
    const gradeColor = { perfect: '#ffd54a', good: '#69f0ae', late: '#ffab6b', miss: '#ff6b6b' }[grade];
    this.popups.push({ text: gradeText, color: gradeColor, x: d.x, y: d.y - 1.5, t: 0 });

    if (grade === 'perfect') {
      this.score.perfects++;
      this.score.combo += this.breed.comboRate;
      this.score.maxCombo = Math.max(this.score.maxCombo, Math.floor(this.score.combo));
      this.boost = 1.4;
      this.hitstop = 0.09;
      this.audio.perfect();
      this.fx.sparks(d.x, d.y, '#ffd54a');
      if (this.score.combo >= 4) this.audio.cheer(false);
      this.audio.crowdLevel(Math.min(0.8, 0.3 + this.score.combo * 0.07));
    } else if (grade === 'good') {
      this.score.goods++;
      this.score.combo += this.breed.comboRate * 0.5;
      this.audio.good();
    } else if (grade === 'late') {
      this.score.lates++;
      this.score.combo = 0;
      this.audio.crowdLevel(0.25);
    } else {
      this.score.misses++;
      this.score.combo = 0;
      this.score.faults += faults;
      this.slowT = 0.6;
      this.audio.miss();
      this.audio.gasp();
      this.audio.crowdLevel(0.15);
      this.r.shake(0.55);
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

    // Эффект прохождения снаряда
    this._passEffects(m, grade);
  }

  _passEffects(m, grade) {
    const type = m.o.type;
    if (['jump', 'tire', 'wall', 'broad'].includes(type) && grade !== 'miss') {
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
      this.fx.dust(d.x, d.y);
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
    r.drawStartFinish(this.course.start, 'СТАРТ');
    r.drawStartFinish(this.course.finish, 'ФИНИШ');
    r.drawJudge(this.course.field.w - 6, 5);


    // Снаряды в порядке y; собака рисуется поверх снаряда, на котором стоит.
    const sorted = [...this.marks].sort((a, b) => a.o.y - b.o.y);
    const dogY = this.dog.y;
    const onMark = this.marks.find(mm =>
      this.dog.dist >= mm.entryD - 0.2 && this.dog.dist <= mm.exitD + 0.2 && mm.o.type !== 'tunnel');
    const drawDog = () => {
      if (!this.dog.hidden) r.drawDog(this.dog, this.breed);
      else { ctx.globalAlpha = 0.25; r.drawDog(this.dog, this.breed); ctx.globalAlpha = 1; }
    };
    let dogDrawn = false;
    for (const m of sorted) {
      if (!onMark && !dogDrawn && m.o.y > dogY && m.o.type !== 'tunnel') { drawDog(); dogDrawn = true; }
      r.drawObstacle(m.o, m.state);
      if (onMark && m === onMark) { drawDog(); dogDrawn = true; }
    }
    if (!dogDrawn) drawDog();

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

    // Всплывающие оценки
    for (const p of this.popups) {
      const s = r.toScreen(p.x, p.y, 1.2 + p.t * 1.4);
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - p.t * 0.9);
      ctx.font = `900 ${Math.round(r.cam.zoom * (0.62 - p.t * 0.1))}px "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeText(p.text, s.x, s.y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, s.x, s.y);
      ctx.restore();
    }
  }
}

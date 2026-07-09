// Рендер мира: поле, снаряды (псевдо-3D через "высоту"), собака, хендлер, толпа.
// Мир в метрах; toScreen проецирует с камерой. Высота объекта = смещение вверх по экрану.

const YELLOW = '#f4c430'; // контактные зоны

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { x: 26, y: 18, zoom: 24, shake: 0 };
    this.time = 0;
  }

  resize(w, h) { this.canvas.width = w; this.canvas.height = h; }

  toScreen(x, y, e = 0) {
    const z = this.cam.zoom;
    const sx = (x - this.cam.x) * z + this.canvas.width / 2 + this._shx;
    const sy = (y - this.cam.y) * z * 0.86 + this.canvas.height / 2 - e * z + this._shy;
    return { x: sx, y: sy, scale: z };
  }

  begin(dt) {
    this.time += dt;
    this.cam.shake = Math.max(0, this.cam.shake - dt * 2.2);
    const sh = this.cam.shake;
    this._shx = (Math.random() - 0.5) * sh * 14;
    this._shy = (Math.random() - 0.5) * sh * 10;
  }

  shake(power = 0.6) { this.cam.shake = Math.min(1, this.cam.shake + power); }

  // ---------- ПОЛЕ ----------
  drawField(field, crowdHype) {
    const { ctx } = this;
    ctx.fillStyle = '#1d5c30';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    // Полосы газона
    for (let i = 0; i < field.w; i += 4) {
      const a = this.toScreen(i, 0), b = this.toScreen(Math.min(i + 2, field.w), field.h);
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      ctx.fillRect(a.x, this.toScreen(0, -3).y, b.x - a.x, this.toScreen(0, field.h + 6).y - this.toScreen(0, -3).y);
    }
    // Песчаный ринг с кромкой
    const p0 = this.toScreen(0, 0), p1 = this.toScreen(field.w, field.h);
    ctx.fillStyle = '#2e7d43';
    ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
    for (let i = 0; i < field.w; i += 4) {
      const a = this.toScreen(i, 0), b = this.toScreen(Math.min(i + 2, field.w), field.h);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(a.x, p0.y, b.x - a.x, p1.y - p0.y);
    }
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(2, this.cam.zoom * 0.06);
    ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
    this._drawCrowd(field, crowdHype);
  }

  _drawCrowd(field, hype = 0) {
    const { ctx } = this;
    const colors = ['#d66', '#6a9bd6', '#d6b656', '#8f6ad6', '#5abf8a', '#d6786a', '#e0e0e0'];
    const rows = [[-2.2, 0], [-3.4, 1]];
    for (const [off, row] of rows) {
      for (let i = 0; i < field.w; i += 1.6) {
        const seed = Math.sin(i * 12.7 + row * 5.1) * 43758.5;
        const rnd = seed - Math.floor(seed);
        const bounce = Math.max(0, Math.sin(this.time * (3 + rnd * 3) + i * 2)) * hype * 0.35;
        for (const yy of [off, field.h - off]) {
          const s = this.toScreen(i + (row ? 0.8 : 0), yy, 0.5 + bounce);
          const r = this.cam.zoom * 0.22;
          ctx.fillStyle = colors[Math.floor(rnd * colors.length)];
          ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = 'rgba(255,224,189,0.9)';
          ctx.beginPath(); ctx.arc(s.x, s.y - r * 0.9, r * 0.62, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  }

  drawJudge(x, y) {
    const { ctx } = this;
    this._shadow(x, y, 0.5);
    const s = this.toScreen(x, y, 0.9), z = this.cam.zoom;
    ctx.fillStyle = '#37474f';
    ctx.fillRect(s.x - z * 0.18, s.y - z * 0.5, z * 0.36, z * 0.9);
    ctx.fillStyle = '#ffe0bd';
    ctx.beginPath(); ctx.arc(s.x, s.y - z * 0.72, z * 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillRect(s.x + z * 0.1, s.y - z * 0.45, z * 0.22, z * 0.3); // планшет
  }

  // ---------- СНАРЯДЫ ----------
  _shadow(x, y, r) {
    const s = this.toScreen(x, y);
    this.ctx.fillStyle = 'rgba(0,0,0,0.22)';
    this.ctx.beginPath();
    this.ctx.ellipse(s.x, s.y, r * this.cam.zoom, r * this.cam.zoom * 0.4, 0, 0, Math.PI * 2);
    this.ctx.fill();
  }

  _pole(x, y, h, color, w = 0.07) {
    const { ctx } = this;
    const b = this.toScreen(x, y), t = this.toScreen(x, y, h);
    ctx.strokeStyle = color; ctx.lineWidth = w * this.cam.zoom;
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(t.x, t.y); ctx.stroke();
  }

  _barLine(x1, y1, x2, y2, h, color, w = 0.09) {
    const { ctx } = this;
    const a = this.toScreen(x1, y1, h), b = this.toScreen(x2, y2, h);
    ctx.strokeStyle = color; ctx.lineWidth = w * this.cam.zoom;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }

  drawObstacle(o, state = {}) {
    const { ctx } = this;
    const dx = Math.cos(o.angle), dy = Math.sin(o.angle);
    const px = -dy, py = dx; // перпендикуляр
    const num = state.done ? null : String(o.i);
    if (o.skipGeom) {
      // Повторное прохождение того же снаряда: геометрия уже нарисована, только номер.
      if (num) this._numberTag(o, num, state.active);
      return;
    }

    switch (o.type) {
      case 'jump': {
        const wsp = 0.75;
        this._shadow(o.x, o.y, 0.9);
        // Крылья
        for (const side of [-1, 1]) {
          const wx = o.x + px * wsp * side, wy = o.y + py * wsp * side;
          this._pole(wx, wy, 0.9, '#3b6fd4', 0.1);
          this._pole(wx + px * side * 0.45, wy + py * side * 0.45, 0.55, '#3b6fd4', 0.1);
        }
        if (!state.knocked) {
          this._barLine(o.x - px * wsp, o.y - py * wsp, o.x + px * wsp, o.y + py * wsp, 0.62, '#f0ede4', 0.1);
          const m1 = { x: o.x - px * 0.25, y: o.y - py * 0.25 }, m2 = { x: o.x + px * 0.25, y: o.y + py * 0.25 };
          this._barLine(m1.x, m1.y, m2.x, m2.y, 0.62, '#e05555', 0.1);
        } else {
          this._barLine(o.x - px * wsp, o.y - py * wsp + 0.2, o.x + px * wsp, o.y + py * wsp - 0.1, 0.06, '#f0ede4', 0.1);
        }
        break;
      }
      case 'tire': {
        this._shadow(o.x, o.y, 0.8);
        for (const side of [-1, 1]) this._pole(o.x + px * 0.95 * side, o.y + py * 0.95 * side, 1.6, '#7a5230', 0.12);
        this._barLine(o.x - px * 0.95, o.y - py * 0.95, o.x + px * 0.95, o.y + py * 0.95, 1.6, '#7a5230', 0.1);
        const c = this.toScreen(o.x, o.y, 0.85), z = this.cam.zoom;
        ctx.strokeStyle = '#d84343'; ctx.lineWidth = z * 0.16;
        ctx.beginPath(); ctx.ellipse(c.x, c.y, z * 0.42, z * 0.42, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = z * 0.04;
        ctx.beginPath(); ctx.ellipse(c.x, c.y, z * 0.42, z * 0.42, 0, 0, Math.PI * 2); ctx.stroke();
        break;
      }
      case 'wall': {
        this._shadow(o.x, o.y, 0.9);
        const z = this.cam.zoom;
        const base = this.toScreen(o.x, o.y, 0);
        ctx.save();
        ctx.translate(base.x, base.y);
        ctx.rotate(Math.atan2((this.toScreen(o.x + px, o.y + py).y - base.y), (this.toScreen(o.x + px, o.y + py).x - base.x)));
        ctx.fillStyle = '#b0543c';
        ctx.fillRect(-z * 0.8, -z * (state.knocked ? 0.35 : 0.75), z * 1.6, z * (state.knocked ? 0.35 : 0.75));
        ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1;
        for (let r = 1; r <= 2; r++) {
          ctx.beginPath(); ctx.moveTo(-z * 0.8, -z * r * 0.25); ctx.lineTo(z * 0.8, -z * r * 0.25); ctx.stroke();
        }
        if (!state.knocked) {
          ctx.fillStyle = '#c96a50';
          for (const sx of [-0.55, 0, 0.55]) ctx.fillRect(z * (sx - 0.18), -z * 0.98, z * 0.36, z * 0.23);
        }
        ctx.restore();
        break;
      }
      case 'broad': {
        this._shadow(o.x, o.y, 1.1);
        for (let k = 0; k < 4; k++) {
          const t = (k / 3 - 0.5) * o.len;
          const cx = o.x + dx * t, cy = o.y + dy * t;
          this._barLine(cx - px * 0.7, cy - py * 0.7, cx + px * 0.7, cy + py * 0.7,
            0.12 + k * 0.09, k % 2 ? '#e8e4da' : '#4b8bd4', 0.16);
        }
        for (const side of [-1, 1]) {
          this._pole(o.x - dx * o.len / 2 + px * 0.8 * side, o.y - dy * o.len / 2 + py * 0.8 * side, 0.7, '#fff', 0.06);
          this._pole(o.x + dx * o.len / 2 + px * 0.8 * side, o.y + dy * o.len / 2 + py * 0.8 * side, 0.7, '#fff', 0.06);
        }
        break;
      }
      case 'tunnel': {
        // Изогнутая труба: дуга от entry к exit с боковым смещением
        const bend = 2.2 * (o.i % 2 ? 1 : -1);
        const mid = { x: o.x + px * bend, y: o.y + py * bend };
        const steps = 14;
        for (let k = steps; k >= 0; k--) {
          const t = k / steps;
          const a = 1 - t, b = t;
          const qx = a * a * o.entry.x + 2 * a * b * mid.x + b * b * o.exit.x;
          const qy = a * a * o.entry.y + 2 * a * b * mid.y + b * b * o.exit.y;
          const s = this.toScreen(qx, qy, 0.4);
          const z = this.cam.zoom;
          ctx.fillStyle = k === 0 || k === steps ? '#12333d' : (k % 2 ? '#2196a8' : '#1b7f90');
          ctx.beginPath(); ctx.arc(s.x, s.y, z * 0.5, 0, Math.PI * 2); ctx.fill();
        }
        break;
      }
      case 'weave': {
        this._shadow(o.x, o.y, o.len / 2);
        for (let k = 0; k < 12; k++) {
          const t = (k / 11 - 0.5) * o.len;
          const wob = state.wobble && Math.abs(state.wobble - k) < 1.2
            ? Math.sin(this.time * 20) * 0.12 : 0;
          this._pole(o.x + dx * t + px * wob, o.y + dy * t + py * wob, 1.0,
            k % 2 ? '#e8e8e8' : '#4b8bd4', 0.08);
        }
        break;
      }
      case 'aframe': {
        const z = this.cam.zoom;
        this._shadow(o.x, o.y, 1.6);
        const half = o.len / 2;
        // Два ската как трапеции с жёлтыми зонами
        for (const side of [-1, 1]) {
          const b1 = { x: o.x + dx * half * side, y: o.y + dy * half * side };
          const bl = this.toScreen(b1.x - px * 0.9, b1.y - py * 0.9);
          const br = this.toScreen(b1.x + px * 0.9, b1.y + py * 0.9);
          const tl = this.toScreen(o.x - px * 0.9, o.y - py * 0.9, 1.7);
          const tr = this.toScreen(o.x + px * 0.9, o.y + py * 0.9, 1.7);
          ctx.fillStyle = side < 0 ? '#3577c9' : '#2c66b0';
          ctx.beginPath(); ctx.moveTo(bl.x, bl.y); ctx.lineTo(br.x, br.y);
          ctx.lineTo(tr.x, tr.y); ctx.lineTo(tl.x, tl.y); ctx.closePath(); ctx.fill();
          // Жёлтая контактная зона (нижние 40%)
          const zl = this.toScreen(b1.x - px * 0.9 + (o.x - b1.x) * 0.38, b1.y - py * 0.9 + (o.y - b1.y) * 0.38, 0.65);
          const zr = this.toScreen(b1.x + px * 0.9 + (o.x - b1.x) * 0.38, b1.y + py * 0.9 + (o.y - b1.y) * 0.38, 0.65);
          ctx.fillStyle = YELLOW;
          ctx.beginPath(); ctx.moveTo(bl.x, bl.y); ctx.lineTo(br.x, br.y);
          ctx.lineTo(zr.x, zr.y); ctx.lineTo(zl.x, zl.y); ctx.closePath(); ctx.fill();
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = z * 0.04;
        const rl = this.toScreen(o.x - px * 0.9, o.y - py * 0.9, 1.7), rr = this.toScreen(o.x + px * 0.9, o.y + py * 0.9, 1.7);
        ctx.beginPath(); ctx.moveTo(rl.x, rl.y); ctx.lineTo(rr.x, rr.y); ctx.stroke();
        break;
      }
      case 'dogwalk': {
        this._shadow(o.x, o.y, o.len / 2);
        const half = o.len / 2;
        const h = 1.25;
        const rampL = 0.3;
        const segs = [
          { a: -half, b: -half + o.len * rampL, ha: 0, hb: h, zone: 'start' },
          { a: -half + o.len * rampL, b: half - o.len * rampL, ha: h, hb: h },
          { a: half - o.len * rampL, b: half, ha: h, hb: 0, zone: 'end' },
        ];
        for (const seg of segs) {
          const steps = 6;
          for (let k = 0; k < steps; k++) {
            const t0 = seg.a + (seg.b - seg.a) * (k / steps);
            const t1 = seg.a + (seg.b - seg.a) * ((k + 1) / steps);
            const h0 = seg.ha + (seg.hb - seg.ha) * (k / steps);
            const h1 = seg.ha + (seg.hb - seg.ha) * ((k + 1) / steps);
            const isZone = (seg.zone === 'end' && k >= steps - 3) || (seg.zone === 'start' && k < 3);
            const a1 = this.toScreen(o.x + dx * t0 - px * 0.32, o.y + dy * t0 - py * 0.32, h0);
            const a2 = this.toScreen(o.x + dx * t0 + px * 0.32, o.y + dy * t0 + py * 0.32, h0);
            const b2 = this.toScreen(o.x + dx * t1 + px * 0.32, o.y + dy * t1 + py * 0.32, h1);
            const b1 = this.toScreen(o.x + dx * t1 - px * 0.32, o.y + dy * t1 - py * 0.32, h1);
            ctx.fillStyle = isZone ? YELLOW : '#4b74b8';
            ctx.beginPath(); ctx.moveTo(a1.x, a1.y); ctx.lineTo(a2.x, a2.y);
            ctx.lineTo(b2.x, b2.y); ctx.lineTo(b1.x, b1.y); ctx.closePath(); ctx.fill();
          }
        }
        for (const t of [-half + o.len * rampL, half - o.len * rampL]) {
          this._pole(o.x + dx * t, o.y + dy * t, 1.25, '#39587e', 0.1);
        }
        break;
      }
      case 'seesaw': {
        this._shadow(o.x, o.y, o.len / 2);
        const half = o.len / 2;
        const tilt = state.tilt !== undefined ? state.tilt : -1; // -1 вход внизу, 1 выход внизу
        const hMid = 0.65;
        const hIn = hMid - tilt * hMid, hOut = hMid + tilt * hMid;
        this._pole(o.x, o.y, hMid, '#8a5a30', 0.14);
        const steps = 8;
        for (let k = 0; k < steps; k++) {
          const t0 = -half + o.len * (k / steps), t1 = -half + o.len * ((k + 1) / steps);
          const hh0 = hIn + (hOut - hIn) * (k / steps), hh1 = hIn + (hOut - hIn) * ((k + 1) / steps);
          const isZone = k < 2 || k >= steps - 2;
          const a1 = this.toScreen(o.x + dx * t0 - px * 0.32, o.y + dy * t0 - py * 0.32, hh0);
          const a2 = this.toScreen(o.x + dx * t0 + px * 0.32, o.y + dy * t0 + py * 0.32, hh0);
          const b2 = this.toScreen(o.x + dx * t1 + px * 0.32, o.y + dy * t1 + py * 0.32, hh1);
          const b1 = this.toScreen(o.x + dx * t1 - px * 0.32, o.y + dy * t1 - py * 0.32, hh1);
          ctx.fillStyle = isZone ? YELLOW : '#c96a3a';
          ctx.beginPath(); ctx.moveTo(a1.x, a1.y); ctx.lineTo(a2.x, a2.y);
          ctx.lineTo(b2.x, b2.y); ctx.lineTo(b1.x, b1.y); ctx.closePath(); ctx.fill();
        }
        break;
      }
      case 'table': {
        this._shadow(o.x, o.y, 1.0);
        const z = this.cam.zoom;
        const c = this.toScreen(o.x, o.y, 0.55);
        for (const [ox, oy] of [[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]]) {
          this._pole(o.x + ox, o.y + oy, 0.5, '#5a4632', 0.09);
        }
        ctx.fillStyle = '#3aa05a';
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, z * 0.95, z * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#2a7a42'; ctx.lineWidth = z * 0.06; ctx.stroke();
        break;
      }
    }
    if (num) this._numberTag(o, num, state.active);
  }

  _numberTag(o, num, active) {
    const { ctx } = this;
    const dx = Math.cos(o.angle), dy = Math.sin(o.angle);
    const s = this.toScreen(o.x - dy * 1.5, o.y + dx * 1.5, 0.4);
    const z = this.cam.zoom, r = z * (active ? 0.34 : 0.26);
    ctx.fillStyle = active ? '#ffd54a' : 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#222';
    ctx.font = `bold ${Math.round(r * 1.1)}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(num, s.x, s.y + 1);
  }

  drawStartFinish(p, label) {
    const { ctx } = this;
    const z = this.cam.zoom;
    for (const side of [-1.3, 1.3]) this._pole(p.x + side, p.y, 1.5, '#d84343', 0.1);
    const a = this.toScreen(p.x - 1.3, p.y, 1.5), b = this.toScreen(p.x + 1.3, p.y, 1.5);
    ctx.strokeStyle = '#d84343'; ctx.lineWidth = z * 0.08;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(z * 0.32)}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(label, (a.x + b.x) / 2, a.y - z * 0.14);
  }

  // ---------- СОБАКА ----------
  drawDog(dog, breed) {
    const { ctx } = this;
    const z = this.cam.zoom * breed.size;
    const e = dog.elevation || 0;
    this._shadowDog(dog.x, dog.y, breed.size * (1 - Math.min(0.5, e * 0.3)));
    const s = this.toScreen(dog.x, dog.y, 0.32 + e);
    ctx.save();
    ctx.translate(s.x, s.y);
    const hx = Math.cos(dog.heading), hy = Math.sin(dog.heading) * 0.86;
    ctx.rotate(Math.atan2(hy, hx));
    // При движении влево не переворачиваем собаку на спину, а зеркалим вертикально:
    // ноги остаются внизу, морда смотрит по ходу движения.
    if (hx < 0) ctx.scale(1, -1);
    ctx.scale(z / 24, z / 24); // нормируем: рисуем в условных px при zoom=24

    const run = dog.runPhase || 0;
    const speedK = Math.min(1.4, (dog.speed || 4) / 5);
    const stretch = dog.airborne ? 1.25 : 1 + Math.sin(run * 2) * 0.06 * speedK;

    // Ноги
    ctx.strokeStyle = breed.legs || breed.body; ctx.lineWidth = 3.2; ctx.lineCap = 'round';
    const legPairs = [[-8, 0], [-8, Math.PI], [8, Math.PI * 0.9], [8, Math.PI * 1.9]];
    for (const [lx, ph] of legPairs) {
      const swing = dog.airborne ? (lx > 0 ? -0.9 : 0.9) : Math.sin(run + ph) * 0.9 * speedK;
      ctx.beginPath();
      ctx.moveTo(lx, 2);
      ctx.lineTo(lx + Math.sin(swing) * 7, 9 + Math.abs(Math.cos(swing)) * 2);
      ctx.stroke();
    }
    // Хвост
    const wag = Math.sin(this.time * (dog.happy ? 18 : 8)) * (dog.happy ? 7 : 3);
    ctx.strokeStyle = breed.body; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-13, -3);
    ctx.quadraticCurveTo(-19, -8 + wag * 0.4, -21, -5 + wag);
    ctx.stroke();
    // Тело
    ctx.fillStyle = breed.body;
    ctx.beginPath();
    ctx.ellipse(0, 0, 13 * stretch, 6.5 / Math.sqrt(stretch), 0, 0, Math.PI * 2);
    ctx.fill();
    // Мерль-пятна (аусси): тёмные кляксы, обрезанные по телу
    if (breed.merle) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, 0, 13 * stretch, 6.5 / Math.sqrt(stretch), 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = breed.merle;
      for (const [sx, sy, sr] of [[-7, -2.5, 2.6], [-1.5, 2, 2.1], [4, -3.5, 1.9], [-10.5, 1.5, 1.8], [8.5, 1.5, 1.5]]) {
        ctx.beginPath();
        ctx.ellipse(sx * stretch, sy, sr, sr * 0.75, 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    // Грудь/воротник
    ctx.fillStyle = breed.chest;
    ctx.beginPath();
    ctx.ellipse(6 * stretch, 1.5, 6 * stretch * 0.7, 4.4, 0, 0, Math.PI * 2);
    ctx.fill();
    // Голова
    const bob = dog.airborne ? -2 : Math.sin(run * 2) * 1.2;
    ctx.fillStyle = breed.body;
    ctx.beginPath();
    ctx.ellipse(14 * stretch, -4 + bob, 6.2, 5.4, -0.15, 0, Math.PI * 2);
    ctx.fill();
    // Медные подпалины на щеке и брови (аусси)
    if (breed.tan) {
      ctx.fillStyle = breed.tan;
      ctx.beginPath();
      ctx.ellipse(13 * stretch, -1.5 + bob, 2.6, 2.0, -0.2, 0, Math.PI * 2); ctx.fill(); // щека
      ctx.beginPath();
      ctx.ellipse(15.2 * stretch, -7.6 + bob, 1.2, 0.8, -0.2, 0, Math.PI * 2); ctx.fill(); // бровь
    }
    // Белая проточина по центру морды (аусси)
    if (breed.merle) {
      ctx.fillStyle = breed.chest;
      ctx.beginPath();
      ctx.ellipse(16.5 * stretch, -5.2 + bob, 2.6, 1.5, -0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // Морда
    ctx.fillStyle = breed.chest;
    ctx.beginPath();
    ctx.ellipse(18.5 * stretch, -2.5 + bob, 3.4, 2.6, -0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(21 * stretch, -3 + bob, 1.3, 0, Math.PI * 2); ctx.fill(); // нос
    if (breed.eye) { // голубой глаз с зрачком
      ctx.fillStyle = breed.eye;
      ctx.beginPath(); ctx.arc(15.5 * stretch, -5.5 + bob, 1.35, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath(); ctx.arc(15.7 * stretch, -5.5 + bob, 0.65, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.beginPath(); ctx.arc(15.5 * stretch, -5.5 + bob, 1.1, 0, Math.PI * 2); ctx.fill(); // глаз
    }
    // Уши (реагируют на скорость/полёт)
    const earBack = dog.airborne ? 0.8 : speedK * 0.5;
    ctx.fillStyle = breed.ear;
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(12 * stretch, -8 + bob);
      ctx.rotate(-0.5 - earBack + side * 0.25);
      ctx.beginPath();
      ctx.ellipse(0, -3, 1.9, 3.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // Язык на радостях
    if (dog.happy) {
      ctx.fillStyle = '#e2697d';
      ctx.beginPath();
      ctx.ellipse(19 * stretch, 0.5 + bob, 1.5, 2.6 + Math.sin(this.time * 14) * 0.5, 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _shadowDog(x, y, k) {
    const s = this.toScreen(x, y);
    this.ctx.fillStyle = 'rgba(0,0,0,0.28)';
    this.ctx.beginPath();
    this.ctx.ellipse(s.x, s.y, this.cam.zoom * 0.55 * k, this.cam.zoom * 0.22 * k, 0, 0, Math.PI * 2);
    this.ctx.fill();
  }

  // ---------- ХЕНДЛЕР ----------
  drawHandler(h) {
    const { ctx } = this;
    this._shadow(h.x, h.y, 0.42);
    const z = this.cam.zoom;
    const s = this.toScreen(h.x, h.y, 0.95);
    const run = h.runPhase || 0;
    ctx.save();
    ctx.translate(s.x, s.y);
    const flip = h.facing < 0 ? -1 : 1;
    ctx.scale(flip * z / 24, z / 24);
    // Ноги в беге
    ctx.strokeStyle = '#26415e'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    for (const ph of [0, Math.PI]) {
      const sw = Math.sin(run + ph) * 0.8 * Math.min(1, h.speed / 4 + 0.2);
      ctx.beginPath(); ctx.moveTo(0, 8);
      ctx.lineTo(Math.sin(sw) * 6, 20); ctx.stroke();
    }
    // Корпус
    ctx.fillStyle = '#e05561';
    ctx.beginPath();
    ctx.roundRect(-6, -8, 12, 17, 5);
    ctx.fill();
    // Руки (жестикуляция при команде)
    ctx.strokeStyle = '#e05561'; ctx.lineWidth = 3.6;
    const cmdArm = h.commanding ? -1.9 + Math.sin(this.time * 16) * 0.15 : Math.sin(run) * 0.7;
    ctx.beginPath(); ctx.moveTo(4, -5); ctx.lineTo(4 + Math.cos(cmdArm) * 9, -5 + Math.sin(cmdArm) * 9); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-4, -5); ctx.lineTo(-4 - Math.cos(run) * 5, -5 + Math.sin(run + Math.PI) * 6); ctx.stroke();
    // Голова
    ctx.fillStyle = '#ffd9b8';
    ctx.beginPath(); ctx.arc(0, -13.5, 5.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#6b4a2f';
    ctx.beginPath(); ctx.arc(0, -15.5, 5.2, Math.PI * 1.05, Math.PI * 1.95); ctx.fill();
    ctx.restore();
  }

  drawSpeech(h, text, urgency = 0) {
    const { ctx } = this;
    const s = this.toScreen(h.x, h.y, 2.4);
    const z = this.cam.zoom;
    const pulse = 1 + Math.sin(this.time * 12) * 0.04 * (1 + urgency);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.scale(pulse, pulse);
    ctx.font = `bold ${Math.round(z * 0.5)}px "Segoe UI", sans-serif`;
    const tw = ctx.measureText(text).width;
    const pw = tw + z * 0.6, ph = z * 0.85;
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.strokeStyle = urgency > 0.5 ? '#e05555' : '#333';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.roundRect(-pw / 2, -ph, pw, ph, z * 0.25);
    ctx.moveTo(-z * 0.15, 0); ctx.lineTo(0, z * 0.32); ctx.lineTo(z * 0.2, 0);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#1a1a1a';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, -ph / 2 + 1);
    ctx.restore();
  }
}

// Система частиц: пыль, конфетти, искры, обломки планок, звёздочки Perfect.
export class Particles {
  constructor() {
    this.list = [];
    this.ground = []; // следы лап: кольцевой буфер, рисуются ПОД миром
  }

  paw(x, y, heading, color) {
    // Пара отпечатков поперёк курса; цвет — из экипировки следов
    const px = -Math.sin(heading), py = Math.cos(heading);
    for (const side of [-0.14, 0.14]) {
      this.ground.push({ x: x + px * side, y: y + py * side, life: 1, color });
    }
    if (this.ground.length > 64) this.ground.splice(0, this.ground.length - 64);
  }

  drawGround(ctx, toScreen) {
    for (const p of this.ground) {
      p.life -= 0.004;
      if (p.life <= 0) continue;
      const s = toScreen(p.x, p.y);
      ctx.save();
      ctx.globalAlpha = Math.min(0.3, p.life * 0.3);
      ctx.fillStyle = p.color === 'rainbow'
        ? `hsl(${(p.life * 540) % 360}, 80%, 55%)`
        : (p.color || '#1f4527');
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, s.scale * 0.07, s.scale * 0.05, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    this.ground = this.ground.filter(p => p.life > 0);
  }

  spawn(p) { this.list.push({ life: 1, rot: 0, vr: 0, grav: 0, drag: 1, size: 0.15, ...p }); }

  dust(x, y) {
    for (let i = 0; i < 3; i++) this.spawn({
      x: x + (Math.random() - 0.5) * 0.4, y: y + (Math.random() - 0.5) * 0.2,
      vx: (Math.random() - 0.5) * 1.2, vy: -Math.random() * 0.6,
      decay: 2.2, size: 0.12 + Math.random() * 0.14,
      color: `rgba(180,160,120,${0.35 + Math.random() * 0.2})`, kind: 'puff',
    });
  }

  sparks(x, y, color = '#ffd54a') {
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, v = 2 + Math.random() * 4;
      this.spawn({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1.5,
        decay: 1.6, grav: 6, size: 0.08 + Math.random() * 0.1, color, kind: 'spark',
      });
    }
  }

  barPieces(x, y, angle) {
    for (let i = 0; i < 2; i++) this.spawn({
      x, y, vx: (Math.random() - 0.5) * 4, vy: -3 - Math.random() * 2,
      decay: 0.8, grav: 12, rot: angle, vr: (Math.random() - 0.5) * 12,
      size: 0.8, color: '#e8e4da', kind: 'bar',
    });
  }

  confettiBurst(x, y, n = 60, preset = null) {
    let colors = ['#ff5252', '#ffd740', '#69f0ae', '#40c4ff', '#e040fb', '#ffab40'];
    if (preset === 'golden') colors = ['#ffd54a', '#f4c430', '#fff3b0', '#c9a227'];
    if (preset === 'hearts') colors = ['#f06292', '#e91e63', '#f8bbd0', '#ff8a80'];
    if (preset === 'fireworks') {
      // три разнесённых залпа искр + обычное конфетти
      for (const [ox, oy] of [[-2.5, -1], [2.5, -1.5], [0, -3]]) this.sparks(x + ox, y + oy, '#ffd54a');
    }
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = 2 + Math.random() * 7;
      const ribbon = i % 5 === 0; // 20% — ленты: медленнее падают, сильнее кувыркаются
      this.spawn({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 4,
        decay: ribbon ? 0.25 : 0.35 + Math.random() * 0.2,
        grav: ribbon ? 2.2 : 4, drag: ribbon ? 0.955 : 0.98,
        rot: Math.random() * 6, vr: (Math.random() - 0.5) * (ribbon ? 26 : 15),
        size: ribbon ? 0.3 + Math.random() * 0.15 : 0.16 + Math.random() * 0.12,
        flutter: Math.random() * 6,
        color: colors[i % colors.length], kind: ribbon ? 'ribbon' : 'confetti',
      });
    }
  }

  update(dt) {
    for (const p of this.list) {
      p.life -= p.decay * dt;
      p.vy += p.grav * dt;
      p.vx *= Math.pow(p.drag, dt * 60);
      p.vy *= Math.pow(p.drag, dt * 60);
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
    this.list = this.list.filter(p => p.life > 0);
  }

  draw(ctx, toScreen) {
    for (const p of this.list) {
      const s = toScreen(p.x, p.y);
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      ctx.translate(s.x, s.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      const px = p.size * s.scale;
      if (p.kind === 'puff') {
        ctx.beginPath(); ctx.arc(0, 0, px * (1.6 - p.life * 0.6), 0, Math.PI * 2); ctx.fill();
      } else if (p.kind === 'bar') {
        ctx.fillRect(-px, -px * 0.12, px * 2, px * 0.24);
        ctx.fillStyle = '#c94f4f';
        ctx.fillRect(-px * 0.4, -px * 0.12, px * 0.5, px * 0.24);
      } else if (p.kind === 'confetti') {
        ctx.fillRect(-px / 2, -px / 4, px, px / 2);
      } else if (p.kind === 'ribbon') {
        // Лента: узкая полоса с волной-флаттером
        const wobble = Math.sin(p.life * 9 + (p.flutter || 0)) * px * 0.25;
        ctx.fillRect(-px, -px * 0.09 + wobble * 0.3, px * 2, px * 0.18);
      } else {
        ctx.beginPath(); ctx.arc(0, 0, px, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }
}

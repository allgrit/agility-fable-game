// Catmull-Rom сплайн с таблицей длин дуг: выборка точки/касательной по пройденной дистанции.
export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

export class Path {
  constructor(points, samplesPerSeg = 24) {
    // Дублируем крайние точки, чтобы сплайн проходил через первую и последнюю.
    const pts = [points[0], ...points, points[points.length - 1]];
    this.samples = [];
    for (let i = 0; i < pts.length - 3; i++) {
      for (let s = 0; s < samplesPerSeg; s++) {
        this.samples.push(catmullRom(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], s / samplesPerSeg));
      }
    }
    this.samples.push({ ...points[points.length - 1] });
    this.cum = [0];
    for (let i = 1; i < this.samples.length; i++) {
      const dx = this.samples[i].x - this.samples[i - 1].x;
      const dy = this.samples[i].y - this.samples[i - 1].y;
      this.cum.push(this.cum[i - 1] + Math.hypot(dx, dy));
    }
    this.length = this.cum[this.cum.length - 1];
    // Дистанция вдоль пути для каждой исходной точки (ближайший сэмпл).
    this.pointDists = points.map(p => {
      let best = 0, bd = Infinity;
      for (let i = 0; i < this.samples.length; i++) {
        const d = (this.samples[i].x - p.x) ** 2 + (this.samples[i].y - p.y) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return this.cum[best];
    });
  }

  _index(dist) {
    const d = Math.max(0, Math.min(dist, this.length));
    let lo = 0, hi = this.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] < d) lo = mid + 1; else hi = mid;
    }
    return Math.max(1, lo);
  }

  pointAt(dist) {
    const i = this._index(dist);
    const d0 = this.cum[i - 1], d1 = this.cum[i];
    const t = d1 > d0 ? (Math.max(0, Math.min(dist, this.length)) - d0) / (d1 - d0) : 0;
    const a = this.samples[i - 1], b = this.samples[i];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  tangentAt(dist) {
    const a = this.pointAt(Math.max(0, dist - 0.4));
    const b = this.pointAt(Math.min(this.length, dist + 0.4));
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  }
}

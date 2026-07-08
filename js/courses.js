// Реальные трассы чемпионатов (оцифрованные официальные course maps) + конвертер.
// Формат данных: координаты в метрах от ЛЕВОГО НИЖНЕГО угла (ось y вверх),
// angle_deg — направление движения собаки (0° = +x, против часовой).
// Игровые координаты: y вниз → зеркалим y и знак угла.
import { OBSTACLES, CLASSES } from './course.js';
import { REAL_COURSES_RAW } from './courses-data.js';

export const REAL_COURSES = REAL_COURSES_RAW;

export function realToCourse(rc) {
  const H = rc.field.h;
  const flip = ([x, y]) => ({ x, y: H - y });

  const obstacles = rc.obstacles.map(ro => {
    const spec = OBSTACLES[ro.type] || OBSTACLES.jump;
    const a = (-ro.angle_deg * Math.PI) / 180;
    const c = flip([ro.x, ro.y]);
    let entry, exit;
    if (ro.entry && ro.exit) {
      entry = flip(ro.entry); exit = flip(ro.exit);
    } else {
      const half = spec.len / 2;
      entry = { x: c.x - Math.cos(a) * half, y: c.y - Math.sin(a) * half };
      exit = { x: c.x + Math.cos(a) * half, y: c.y + Math.sin(a) * half };
    }
    const angle = Math.atan2(exit.y - entry.y, exit.x - entry.x);
    return { i: ro.n, type: ro.type, x: c.x, y: c.y, angle, len: spec.len, entry, exit };
  }).sort((o1, o2) => o1.i - o2.i);

  // Повторные прохождения одного снаряда: геометрию рисуем один раз, номера — все.
  const byKey = new Map();
  for (const o of obstacles) {
    const key = `${o.type}:${o.x.toFixed(1)}:${o.y.toFixed(1)}`;
    if (byKey.has(key)) o.skipGeom = true;
    else byKey.set(key, o);
  }

  const first = obstacles[0], lastO = obstacles[obstacles.length - 1];
  const clampF = (p) => ({
    x: Math.max(1, Math.min(rc.field.w - 1, p.x)),
    y: Math.max(1, Math.min(H - 1, p.y)),
  });
  const start = clampF({
    x: first.entry.x - Math.cos(first.angle) * 4,
    y: first.entry.y - Math.sin(first.angle) * 4,
  });
  const finish = clampF({
    x: lastO.exit.x + Math.cos(lastO.angle) * 5,
    y: lastO.exit.y + Math.sin(lastO.angle) * 5,
  });
  const pathPoints = [start];
  for (const o of obstacles) pathPoints.push(o.entry, o.exit);
  pathPoints.push(finish);

  const cls = obstacles.length >= 20 ? 'masters' : 'excellent';
  return {
    seed: 0, cls, class: CLASSES[cls],
    name: rc.name.split('(')[0].trim(), source: rc.source, org: rc.org,
    obstacles, start, finish, pathPoints,
    field: { w: rc.field.w, h: H, margin: 0 },
  };
}

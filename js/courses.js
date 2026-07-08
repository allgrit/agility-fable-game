// Реальные трассы чемпионатов (оцифрованные course maps) + конвертер в игровой формат.
// Данные заполняются из разведки: {name, source, field:{w,h}, obstacles:[{n,type,x,y,angle_deg}]}
import { OBSTACLES, CLASSES } from './course.js';

export const REAL_COURSES = [];

export function realToCourse(rc) {
  const scaleUp = Math.max(1, 36 / rc.field.h, 52 / rc.field.w * 0.75);
  const obstacles = rc.obstacles.map(ro => {
    const spec = OBSTACLES[ro.type] || OBSTACLES.jump;
    const a = (ro.angle_deg * Math.PI) / 180;
    const x = ro.x, y = ro.y;
    const half = spec.len / 2;
    return {
      i: ro.n, type: ro.type,
      x, y, angle: a, len: spec.len,
      entry: { x: x - Math.cos(a) * half, y: y - Math.sin(a) * half },
      exit: { x: x + Math.cos(a) * half, y: y + Math.sin(a) * half },
    };
  }).sort((o1, o2) => o1.i - o2.i);

  const first = obstacles[0], lastO = obstacles[obstacles.length - 1];
  const start = {
    x: first.entry.x - Math.cos(first.angle) * 4,
    y: first.entry.y - Math.sin(first.angle) * 4,
  };
  const finish = {
    x: lastO.exit.x + Math.cos(lastO.angle) * 5,
    y: lastO.exit.y + Math.sin(lastO.angle) * 5,
  };
  const pathPoints = [start];
  for (const o of obstacles) pathPoints.push(o.entry, o.exit);
  pathPoints.push(finish);

  const cls = obstacles.length >= 18 ? 'masters' : obstacles.length >= 16 ? 'excellent' : 'open';
  return {
    seed: 0, cls, class: CLASSES[cls],
    name: rc.name, source: rc.source,
    obstacles, start, finish, pathPoints,
    field: { w: rc.field.w, h: rc.field.h, margin: 0 },
  };
}

// Процедурный генератор трасс аджилити. Чистая логика, без DOM.
import { makeRng } from './rng.js';

export const FIELD = { w: 52, h: 36, margin: 4 };

// windowMul — множитель окна реакции: новичкам заметно легче, мастерам строже.
// Механики вводятся постепенно: Novice — только прыжки и туннели,
// Open — + слалом и горка/бум, Excellent — + качели и стол.
export const CLASSES = {
  novice:    { name: 'Novice',    count: 12, contacts: 0, weave: false, table: false, seesaw: false,
               dogSpeed: 4.2, sctSpeed: 3.0, windowMul: 1.45 },
  open:      { name: 'Open',      count: 14, contacts: 1, weave: true, table: false, seesaw: false,
               dogSpeed: 4.8, sctSpeed: 3.5, windowMul: 1.2 },
  excellent: { name: 'Excellent', count: 16, contacts: 2, weave: true, table: true, seesaw: true,
               dogSpeed: 5.4, sctSpeed: 4.0, windowMul: 1.0 },
  masters:   { name: 'Masters',   count: 18, contacts: 2, weave: true, table: true, seesaw: true,
               dogSpeed: 5.8, sctSpeed: 4.4, windowMul: 0.9 },
};

// Длина снаряда вдоль оси движения (м) и минимальный разбег перед ним.
export const OBSTACLES = {
  jump:    { len: 0.4, gap: [5.5, 8.5], label: 'Барьер' },
  tire:    { len: 0.4, gap: [6, 8.5],   label: 'Шина' },
  wall:    { len: 0.6, gap: [5.5, 8],   label: 'Стена' },
  broad:   { len: 1.6, gap: [6, 8.5],   label: 'Длинный прыжок' },
  tunnel:  { len: 5.0, gap: [5, 7.5],   label: 'Туннель' },
  weave:   { len: 6.6, gap: [5.5, 7.5], label: 'Слалом' },
  aframe:  { len: 5.2, gap: [6, 8],     label: 'Горка' },
  dogwalk: { len: 8.6, gap: [6, 8],     label: 'Бум' },
  seesaw:  { len: 4.4, gap: [6, 8],     label: 'Качели' },
  table:   { len: 1.2, gap: [5.5, 7.5], label: 'Стол' },
};

export const CONTACT_TYPES = ['aframe', 'dogwalk', 'seesaw'];

// Список типов снарядов для класса с учётом правил (слалом x1, шина <=1, стол <=1).
function buildTypeList(rng, cls) {
  const c = CLASSES[cls];
  const types = [];
  const contacts = CONTACT_TYPES.filter(t => c.seesaw || t !== 'seesaw');
  for (let i = 0; i < c.contacts; i++) {
    types.push(contacts.splice(rng.int(0, contacts.length - 1), 1)[0]);
  }
  if (c.weave) types.push('weave');
  types.push('tunnel');
  if (rng.chance(0.55)) types.push('tunnel');
  if (rng.chance(0.6)) types.push('tire');
  if (c.table && rng.chance(0.5)) types.push('table');
  if (rng.chance(0.45)) types.push('wall');
  if (rng.chance(0.4)) types.push('broad');
  while (types.length < c.count) types.push('jump');
  types.length = c.count;
  // Перемешать, но: первый и последний снаряд — всегда прыжковый (реальная практика),
  // слалом и контактные не в первых двух позициях.
  for (let i = types.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [types[i], types[j]] = [types[j], types[i]];
  }
  const isEasy = t => ['jump', 'tire', 'wall', 'broad'].includes(t);
  const easyIdx = types.findIndex(isEasy);
  if (easyIdx > 0) [types[0], types[easyIdx]] = [types[easyIdx], types[0]];
  let lastEasy = -1;
  for (let i = 0; i < types.length - 1; i++) if (isEasy(types[i])) lastEasy = i;
  if (lastEasy >= 0 && !isEasy(types[types.length - 1])) {
    [types[types.length - 1], types[lastEasy]] = [types[lastEasy], types[types.length - 1]];
  }
  return types;
}

function segDist(a1, a2, b1, b2) {
  // Минимальное расстояние между двумя отрезками (по точкам с шагом).
  let best = Infinity;
  for (let t = 0; t <= 1; t += 0.2) {
    const p = { x: a1.x + (a2.x - a1.x) * t, y: a1.y + (a2.y - a1.y) * t };
    for (let s = 0; s <= 1; s += 0.2) {
      const q = { x: b1.x + (b2.x - b1.x) * s, y: b1.y + (b2.y - b1.y) * s };
      best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
    }
  }
  return best;
}

function inBounds(p) {
  return p.x >= FIELD.margin && p.x <= FIELD.w - FIELD.margin &&
         p.y >= FIELD.margin && p.y <= FIELD.h - FIELD.margin;
}

function tryLayout(rng, types) {
  const obstacles = [];
  let pos = { x: FIELD.margin + 2, y: FIELD.h / 2 + rng.range(-6, 6) };
  let dir = rng.range(-0.35, 0.35); // радианы, старт направо
  const start = { ...pos };

  for (let i = 0; i < types.length; i++) {
    const spec = OBSTACLES[types[i]];
    let placed = false;
    for (let attempt = 0; attempt < 14 && !placed; attempt++) {
      const gap = rng.range(spec.gap[0], spec.gap[1]);
      // Поворот: серпантин — знак чередуется с шумом; у края тянем к центру.
      let turn = rng.range(0.25, 1.05) * (rng.chance(0.5) ? 1 : -1);
      if (i === 0) turn = rng.range(-0.3, 0.3);
      let nd = dir + turn;
      const entry = { x: pos.x + Math.cos(nd) * gap, y: pos.y + Math.sin(nd) * gap };
      const exit = { x: entry.x + Math.cos(nd) * spec.len, y: entry.y + Math.sin(nd) * spec.len };
      const cx = FIELD.w / 2, cy = FIELD.h / 2;
      if (!inBounds(entry) || !inBounds(exit)) {
        // Разворачиваем к центру поля и пробуем ещё раз.
        dir = Math.atan2(cy - pos.y, cx - pos.x) + rng.range(-0.5, 0.5);
        continue;
      }
      let ok = true;
      for (let k = 0; k < obstacles.length - 1; k++) {
        const o = obstacles[k];
        if (segDist(entry, exit, o.entry, o.exit) < 3.2) { ok = false; break; }
      }
      if (!ok) continue;
      obstacles.push({
        i: i + 1, type: types[i],
        entry, exit,
        x: (entry.x + exit.x) / 2, y: (entry.y + exit.y) / 2,
        angle: nd, len: spec.len,
      });
      pos = exit; dir = nd; placed = true;
    }
    if (!placed) return null;
  }
  const finish = {
    x: Math.max(FIELD.margin, Math.min(FIELD.w - FIELD.margin, pos.x + Math.cos(dir) * 6)),
    y: Math.max(FIELD.margin, Math.min(FIELD.h - FIELD.margin, pos.y + Math.sin(dir) * 6)),
  };
  return { obstacles, start, finish };
}

export function generateCourse(seed, cls = 'novice') {
  const rng = makeRng(seed);
  for (let attempt = 0; attempt < 120; attempt++) {
    const types = buildTypeList(rng, cls);
    const layout = tryLayout(rng, types);
    if (!layout) continue;
    const pathPoints = [layout.start];
    for (const o of layout.obstacles) { pathPoints.push(o.entry, o.exit); }
    pathPoints.push(layout.finish);
    return {
      seed, cls, class: CLASSES[cls],
      obstacles: layout.obstacles,
      start: layout.start, finish: layout.finish,
      pathPoints, field: FIELD,
    };
  }
  throw new Error(`course generation failed for seed=${seed} cls=${cls}`);
}

export function validateCourse(course) {
  const errs = [];
  const counts = {};
  for (const o of course.obstacles) {
    counts[o.type] = (counts[o.type] || 0) + 1;
    if (!inBounds(o.entry) || !inBounds(o.exit)) errs.push(`obstacle ${o.i} out of bounds`);
  }
  const cc = CLASSES[course.cls];
  if ((counts.weave || 0) !== (cc.weave ? 1 : 0)) errs.push('weave count mismatch');
  if ((counts.tire || 0) > 1) errs.push('tire > 1');
  if ((counts.table || 0) > (cc.table ? 1 : 0)) errs.push('table not allowed / > 1');
  if (!cc.seesaw && (counts.seesaw || 0) > 0) errs.push('seesaw not allowed');
  const nContacts = CONTACT_TYPES.reduce((s, t) => s + (counts[t] || 0), 0);
  if (nContacts < cc.contacts) errs.push('not enough contact obstacles');
  if (cc.contacts === 0 && nContacts > 0) errs.push('contacts not allowed');
  if (!(counts.tunnel >= 1)) errs.push('no tunnel');
  if (course.obstacles.length !== CLASSES[course.cls].count) errs.push('wrong obstacle count');
  for (let a = 0; a < course.obstacles.length; a++) {
    for (let b = a + 2; b < course.obstacles.length; b++) {
      const oa = course.obstacles[a], ob = course.obstacles[b];
      if (segDist(oa.entry, oa.exit, ob.entry, ob.exit) < 2.0) {
        errs.push(`obstacles ${oa.i} and ${ob.i} overlap`);
      }
    }
  }
  return errs;
}

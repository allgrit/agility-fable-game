// S4.7 «Звёзды Punch-Out»: perfect на «коронных» снарядах трассы копит звёзды,
// промах их сжигает, накопленное тратится на Star Finish — удвоение последнего снаряда.
// Чистая логика: без DOM, без WebAudio, без Math.random. Всё детерминировано от course.seed.
import { makeRng } from './rng.js';

export const MAX_STARS = 3;               // сколько звёзд помещается на счётчике
export const STAR_FINISH_MULT = 2;        // Star Finish — ×2 очков за последний снаряд
export const SIGNATURE_SALT = 0x5741;     // соль RNG: коронные не коррелируют с раскладкой
export const MIN_SIGNATURE_GAP = 2;       // минимальный зазор между коронными снарядами

// Насколько «дорого» стоит удвоение в зависимости от того, как взят финиш.
// Промах — ничего; впритык — четверть драмы; идеально — всё.
export const FINISH_GRADE_WEIGHT = { perfect: 1, good: 0.6, late: 0.4, miss: 0 };

// Что вообще стоит один снаряд в finalScore(): доля перфект-пула (1000/total)
// плюс примерный вклад в maxCombo (одна ступень комбо = 50 очков).
// Для Open (14 снарядов) выходит ≈121 — ровно цена существующего риска ×2 (+120).
export function obstacleValue(total) {
  return 1000 / Math.max(1, total || 1) + 50;
}

// Бонус очков за Star Finish: линейно растёт с числом потраченных звёзд.
// 1 звезда ≈ риск ×2, 3 звезды ≈ Golden Weave — по месту в существующем балансе.
export function starFinishBonus(stars, grade, total) {
  const w = FINISH_GRADE_WEIGHT[grade] ?? 0;
  if (!stars || w <= 0) return 0;
  return Math.round(obstacleValue(total) * (STAR_FINISH_MULT - 1) * stars * w);
}

// Коронные снаряды трассы: индексы в course.obstacles.
// Детерминированно от course.seed — одна и та же трасса всегда «коронует» одно и то же
// (важно для трассы дня и переигровок карьеры). rand — необязательный свой RNG.
export function pickSignature(course, rand = null) {
  const obstacles = course && Array.isArray(course.obstacles) ? course.obstacles : null;
  if (!obstacles) return [];
  const last = obstacles.length - 1;
  // Первый снаряд — заход, последний зарезервирован под Star Finish.
  const pool = [];
  for (let i = 1; i < last; i++) pool.push(i);
  if (!pool.length) return [];

  const rng = rand || makeRng(((course.seed | 0) ^ SIGNATURE_SALT) >>> 0);
  const want = Math.min(MAX_STARS, pool.length);
  const picked = [];
  const usedTypes = new Set();
  let minAllowed = pool[0];

  for (let b = 0; b < want; b++) {
    // Свой отрезок трассы на каждую звезду — коронные распределены от старта к финишу.
    const from = Math.floor((b * pool.length) / want);
    const to = Math.floor(((b + 1) * pool.length) / want);
    const bucket = pool.slice(from, Math.max(to, from + 1));
    const free = bucket.filter(i => i >= minAllowed);
    const cand = free.length ? free : bucket;
    // Со случайного места по кругу ищем ещё не занятый тип снаряда — коронные разнотипны.
    const off = rng.int(0, cand.length - 1);
    let choice = cand[off];
    for (let k = 0; k < cand.length; k++) {
      const idx = cand[(off + k) % cand.length];
      if (!usedTypes.has(obstacles[idx].type)) { choice = idx; break; }
    }
    picked.push(choice);
    usedTypes.add(obstacles[choice].type);
    minAllowed = choice + MIN_SIGNATURE_GAP;
  }
  picked.sort((a, b) => a - b);
  return picked;
}

// Счётчик звёзд прогона. Возвращаемые объекты описывают событие, чтобы игровой
// слой сам решал, какой попап показать и какой звук сыграть.
export function createStars(course, { burnMode = 'all', signature = null } = {}) {
  const total = course && Array.isArray(course.obstacles) ? course.obstacles.length : 0;
  const sig = signature ? [...signature] : pickSignature(course);
  const sigSet = new Set(sig);
  const finishIndex = total - 1;

  let count = 0;
  let armed = false;
  let spent = false;

  function burn() {
    if (count <= 0) return 0;
    const n = burnMode === 'one' ? 1 : count;
    count -= n;
    return n;
  }

  return {
    signature: Object.freeze(sig),
    finishIndex,
    burnMode,
    get count() { return count; },
    get max() { return MAX_STARS; },

    isSignature(idx) { return sigSet.has(idx); },

    // Итог снаряда: perfect на коронном даёт звезду (кап MAX_STARS),
    // miss сжигает накопленное, good/late — нейтральны.
    onResult(idx, grade) {
      const isSig = sigSet.has(idx);
      let gained = 0, burned = 0, capped = false;
      if (grade === 'miss') {
        burned = burn();
      } else if (isSig && grade === 'perfect') {
        if (count < MAX_STARS) { count++; gained = 1; }
        else capped = true;
      }
      if (count === 0) armed = false;
      return { idx, grade, signature: isSig, gained, burned, capped, count, max: MAX_STARS };
    },

    // Взводится перед последним снарядом: есть ли чем бить.
    armFinish() { armed = !spent && count > 0; return armed; },
    isFinishArmed() { return armed && count > 0; },

    // Трата звёзд на последнем снаряде. Успех (не miss) — ×2 и бонус очков;
    // промах или пустой счётчик — ×1 без бонуса. Звёзды уходят в любом случае.
    spendOnFinish(grade) {
      const stars = spent ? 0 : count;
      const ok = stars > 0 && grade !== 'miss';
      const bonus = ok ? starFinishBonus(stars, grade, total) : 0;
      const burned = stars > 0 && !ok ? stars : 0;
      count = 0; armed = false;
      if (stars > 0) spent = true;
      return {
        grade, multiplier: ok ? STAR_FINISH_MULT : 1,
        starsSpent: ok ? stars : 0, burned, bonus, count,
      };
    },

    reset() { count = 0; armed = false; spent = false; },
  };
}

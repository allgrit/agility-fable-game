// Мета-прогрессия: валюты 🦴/🏵️, XP собак с титулами, streak трассы дня.
// Единый версионированный ключ localStorage `agility_meta` с мигратором.
// Всё зарабатывается только игрой — покупок за деньги нет.

const KEY = 'agility_meta';
const VERSION = 1;

function defaults() {
  return {
    v: VERSION,
    bones: 0,          // 🦴 soft-валюта
    rosettes: 0,       // 🏵️ hard-валюта (только вехи)
    firstClears: {},   // trackId → 1 (бонус за первое прохождение)
    medalPaid: {},     // trackId → лучшая оплаченная медаль (бонус только за улучшение)
    rosettePaid: {},   // id вехи → 1
    dogs: {},          // breedId → { xp, level, equip: {coat,neck,paws,finish} }
    owned: {},         // itemId → 1
    counters: { runs: 0, cleans: 0, perfectRuns: 0 },
    streak: { count: 0, last: '' },   // трасса дня: дней подряд, дата последнего
    quests: { day: '', week: '', daily: [], weekly: [] }, // прогресс заданий
  };
}

export function loadMeta() {
  try {
    const m = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!m || typeof m !== 'object') return defaults();
    if (m.v !== VERSION) return migrate(m);
    return { ...defaults(), ...m, dogs: m.dogs || {}, quests: { ...defaults().quests, ...m.quests } };
  } catch { return defaults(); }
}

function migrate(old) {
  // v0 → v1: пока нечего мигрировать, только дефолты поверх
  return { ...defaults(), ...old, v: VERSION };
}

export function saveMeta(m) {
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch {}
}

// ---------- ВАЛЮТА ----------
// bones = очки/100 + медальный бонус (только при улучшении) + бонус первого
// прохождения, всё × streak-множитель трассы дня.
export function streakMult(count) {
  if (count >= 30) return 1.5;
  if (count >= 7) return 1.25;
  if (count >= 3) return 1.1;
  return 1;
}

const MEDAL_BONUS = { 1: 5, 2: 10, 3: 20 };

export function earnFromRun(meta, { points, stars, trackId, isDaily, todayStr, runOfDay = 0 }) {
  const detail = [];
  let bones = Math.round(points / 90);
  if (bones > 0) detail.push([`очки`, bones]);
  // Бонус активности: 5-й и 10-й прогоны дня
  if (runOfDay === 5 || runOfDay === 10) {
    bones += 20;
    detail.push([`${runOfDay}-й прогон дня`, 20]);
  }

  const paid = meta.medalPaid[trackId] || 0;
  if (stars > paid) {
    let medalB = 0;
    for (let s = paid + 1; s <= stars; s++) medalB += MEDAL_BONUS[s] || 0;
    meta.medalPaid[trackId] = stars;
    bones += medalB;
    detail.push([`медаль`, medalB]);
  }
  if (!meta.firstClears[trackId]) {
    meta.firstClears[trackId] = 1;
    bones += 30;
    detail.push(['первое прохождение', 30]);
  }

  // Streak трассы дня: заход сегодня продлевает серию; пропуск дня снимает ступень
  if (isDaily && meta.streak.last !== todayStr) {
    const last = meta.streak.last;
    const gap = last ? daysBetween(last, todayStr) : 99;
    if (gap === 1) meta.streak.count += 1;
    else if (gap > 1) meta.streak.count = Math.max(1, Math.floor(meta.streak.count / 2));
    else meta.streak.count = Math.max(1, meta.streak.count);
    if (!last || gap >= 1) meta.streak.last = todayStr;
    if (meta.streak.count === 0) meta.streak.count = 1;
  }
  const mult = streakMult(meta.streak.count);
  if (mult > 1) {
    const extra = Math.round(bones * (mult - 1));
    bones += extra;
    detail.push([`серия ×${mult}`, extra]);
  }
  meta.bones += bones;
  return { bones, detail };
}

function daysBetween(a, b) {
  // даты в формате DD.MM.YYYY
  const p = (s) => { const [d, m, y] = s.split('.').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(b) - p(a)) / 86400000);
}

// Розетки: только вехи, каждая платится один раз (id вехи в rosettePaid)
export function grantRosette(meta, id, amount) {
  if (meta.rosettePaid[id]) return 0;
  meta.rosettePaid[id] = 1;
  meta.rosettes += amount;
  return amount;
}

// ---------- XP И ТИТУЛЫ ----------
export const TITLES = [
  { level: 30, tag: 'CH',   name: 'Чемпион' },
  { level: 20, tag: 'MACH', name: 'Мастер аджилити' },
  { level: 10, tag: 'ADX',  name: 'Опытный атлет' },
  { level: 5,  tag: 'AD',   name: 'Собака-спортсмен' },
];

export function xpToNext(level) { return Math.round(100 * Math.pow(level, 1.5)); }

export function dogState(meta, breedId) {
  if (!meta.dogs[breedId]) meta.dogs[breedId] = { xp: 0, level: 1, equip: {} };
  const d = meta.dogs[breedId];
  if (!d.equip) d.equip = {};
  return d;
}

export function titleFor(level) {
  const t = TITLES.find(tt => level >= tt.level);
  return t ? t.tag : '';
}

// Начисление XP; возвращает {gained, levelsUp: [новые уровни]}
export function earnXp(meta, breedId, { points, stars, clean }) {
  const d = dogState(meta, breedId);
  const gained = Math.round(points / 10) + stars * 25 + (clean ? 50 : 0);
  d.xp += gained;
  const levelsUp = [];
  while (d.level < 30 && d.xp >= xpToNext(d.level)) {
    d.xp -= xpToNext(d.level);
    d.level += 1;
    levelsUp.push(d.level);
  }
  return { gained, levelsUp };
}

// Розетки за уровни собак: 10 → 1, 20 → 2, 30 → 3
export function rosettesForLevels(meta, breedId, levelsUp) {
  let total = 0;
  for (const L of levelsUp) {
    if (L === 10) total += grantRosette(meta, `lvl10:${breedId}`, 1);
    if (L === 20) total += grantRosette(meta, `lvl20:${breedId}`, 2);
    if (L === 30) total += grantRosette(meta, `lvl30:${breedId}`, 3);
  }
  return total;
}

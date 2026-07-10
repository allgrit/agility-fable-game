import { saveMeta } from './meta.js';

// Система достижений: 36 записей — цепочки I/II/III и одиночные.
// id первых 10 не меняются (совместимость agility_ach).
export const ACHIEVEMENTS = [
  // --- Базовые (существующие id) ---
  { id: 'first-run',   icon: '🐾', name: 'Первый выход',   desc: 'Завершить первый забег' },
  { id: 'first-q',     icon: '✨', name: 'Чистая работа',   desc: 'Первый чистый прогон (Q)' },
  { id: 'combo-10',    icon: '🔥', name: 'В ударе',        desc: 'Комбо ×10 за один забег' },
  { id: 'perfect-run', icon: '🌟', name: 'Безупречность', desc: '100% идеальных на трассе' },
  { id: 'golden-paw',  icon: '🥇', name: 'Золотая лапа',   desc: '5 золотых медалей — открывает Пуделя!' },
  { id: 'excellent',   icon: '🎓', name: 'Отличник',       desc: 'Дойти до класса Excellent' },
  { id: 'masters',     icon: '👑', name: 'Мастер',         desc: 'Дойти до класса Masters' },
  { id: 'worldcup-q',  icon: '🌍', name: 'Мировой уровень', desc: 'Чистый прогон реальной трассы чемпионата' },
  { id: 'daily-player', icon: '📅', name: 'Постоянство',   desc: 'Пройти трассу дня' },
  { id: 'obstacles-100', icon: '💯', name: 'Сотня',        desc: '100 снарядов за карьеру' },

  // --- Цепочки ---
  { id: 'obstacles-500',  icon: '🚧', name: 'Пятьсот снарядов',  desc: '500 снарядов суммарно' },
  { id: 'obstacles-2500', icon: '🏗️', name: 'Ветеран трасс',     desc: '2500 снарядов суммарно' },
  { id: 'combo-20',  icon: '⚡', name: 'Серия ×20',        desc: 'Комбо ×20 за один забег' },
  { id: 'combo-40',  icon: '🌪️', name: 'Неудержимость',    desc: 'Комбо ×40 за один забег' },
  { id: 'quals-15',  icon: '📜', name: '15 квалификаций',  desc: '15 прогонов с Q' },
  { id: 'quals-60',  icon: '🏛️', name: 'Ходячий протокол', desc: '60 прогонов с Q' },
  { id: 'perfects-200', icon: '🎯', name: 'Снайпер',       desc: '200 идеальных нажатий суммарно' },
  { id: 'perfects-1000', icon: '🎯', name: 'Хирург тайминга', desc: '1000 идеальных нажатий суммарно' },
  { id: 'streak-3',  icon: '🔥', name: 'Три дня подряд',   desc: 'Серия трассы дня: 3 дня' },
  { id: 'streak-7',  icon: '🗓️', name: 'Неделя без пропуска', desc: 'Серия трассы дня: 7 дней' },
  { id: 'streak-30', icon: '🏵️', name: 'Месяц дисциплины', desc: 'Серия трассы дня: 30 дней' },
  { id: 'speed-5',   icon: '⏱️', name: 'Быстрее судьи',    desc: 'Финиш на 5с раньше SCT' },
  { id: 'speed-10',  icon: '🚀', name: 'Реактивная собака', desc: 'Финиш на 10с раньше SCT' },
  { id: 'speed-15',  icon: '☄️', name: 'Молния ринга',     desc: 'Финиш на 15с раньше SCT' },

  // --- Одиночные ---
  { id: 'all-breeds', icon: '🐕‍🦺', name: 'Кинолог',       desc: 'Пробежать каждой открытой породой' },
  { id: 'breed-lv10', icon: '🎖️', name: 'Титул ADX',      desc: 'Довести собаку до 10 уровня' },
  { id: 'breed-lv20', icon: '🏅', name: 'Титул MACH',      desc: 'Довести собаку до 20 уровня' },
  { id: 'all-gold-novice', icon: '🌈', name: 'Идеальный старт', desc: 'Все 5 золотых в классе Novice' },
  { id: 'worldcup-all', icon: '🗺️', name: 'Кругосветка',   desc: 'Q на всех 6 трассах чемпионатов' },
  { id: 'fakeout-10', icon: '🃏', name: 'Не проведёшь',    desc: 'Разгадать 10 обманок «?»' },
  { id: 'diamond',    icon: '💎', name: 'Бриллиант',       desc: 'Получить 4-ю звезду (перфект-челлендж)' },
  { id: 'shopper',    icon: '🛍️', name: 'Первая обновка',  desc: 'Купить предмет в магазине' },
  { id: 'collector-5', icon: '🎒', name: 'Коллекционер',   desc: 'Владеть 5 предметами' },
  { id: 'fashionista', icon: '💃', name: 'Модник',         desc: 'Занять все 4 слота экипировки' },
  { id: 'rich-1000',  icon: '🦴', name: 'Костяной магнат', desc: 'Накопить 1000 🦴 на балансе' },
  { id: 'poodle-run', icon: '🐩', name: 'Шоу пуделя',      desc: 'Пробежать трассу пуделем' },
];

export function loadAch() {
  try { return JSON.parse(localStorage.getItem('agility_ach') || '{}'); }
  catch { return {}; }
}

export function hasAch(id) { return !!loadAch()[id]; }

// Проверяет все условия; возвращает список НОВЫХ достижений.
// ctx: { run, result, mode, cls, goldCount, meta }
export function checkAchievements(ctx) {
  const { run, result, mode, cls, goldCount, meta } = ctx;
  const ach = loadAch();
  const newly = [];
  const grant = (id) => {
    if (!ach[id]) { ach[id] = Date.now(); newly.push(ACHIEVEMENTS.find(a => a.id === id)); }
  };

  // Суммарные счётчики (легаси-ключ снарядов подхватываем)
  const legacy = Number(localStorage.getItem('agility_obstacles') || 0);
  const c = meta.counters;
  c.obstacles = (c.obstacles ?? legacy) + run.marks.length;
  c.perfects = (c.perfects || 0) + run.score.perfects;
  c.quals = (c.quals || 0) + (result.qualified ? 1 : 0);
  c.fakeouts = (c.fakeouts || 0) +
    run.marks.filter(m => m.decoys && m.qte?.result && m.qte.result.grade !== 'miss').length;
  c.breeds = c.breeds || {};
  c.breeds[run.breed.id] = 1;

  grant('first-run');
  if (result.clean) grant('first-q');
  if (run.score.maxCombo >= 10) grant('combo-10');
  if (run.score.maxCombo >= 20) grant('combo-20');
  if (run.score.maxCombo >= 40) grant('combo-40');
  if (run.score.perfects === run.marks.length && run.marks.length > 0) grant('perfect-run');
  if (goldCount >= 5) grant('golden-paw');
  if (cls === 'excellent' || cls === 'masters') grant('excellent');
  if (cls === 'masters') grant('masters');
  if (mode === 'worldcup' && result.clean) grant('worldcup-q');
  if (mode === 'daily') grant('daily-player');
  if (c.obstacles >= 100) grant('obstacles-100');
  if (c.obstacles >= 500) grant('obstacles-500');
  if (c.obstacles >= 2500) grant('obstacles-2500');
  if (c.quals >= 15) grant('quals-15');
  if (c.quals >= 60) grant('quals-60');
  if (c.perfects >= 200) grant('perfects-200');
  if (c.perfects >= 1000) grant('perfects-1000');
  if (meta.streak.count >= 3) grant('streak-3');
  if (meta.streak.count >= 7) grant('streak-7');
  if (meta.streak.count >= 30) grant('streak-30');
  const margin = run.sct - run.time;
  if (result.clean && margin >= 5) grant('speed-5');
  if (result.clean && margin >= 10) grant('speed-10');
  if (result.clean && margin >= 15) grant('speed-15');
  if (Object.keys(c.breeds).length >= 5) grant('all-breeds');
  if (c.fakeouts >= 10) grant('fakeout-10');
  if (result.stars >= 4) grant('diamond');
  if (run.breed.id === 'poodle') grant('poodle-run');
  if (meta.bones >= 1000) grant('rich-1000');
  const ownedCount = Object.keys(meta.owned).length;
  if (ownedCount >= 1) grant('shopper');
  if (ownedCount >= 5) grant('collector-5');
  const eq = (meta.dogs[run.breed.id] || {}).equip || {};
  if (['coat', 'neck', 'paws', 'finish'].every(sl => eq[sl])) grant('fashionista');
  // Медальные наборы
  if (ctx.medals) {
    const novGold = [1, 2, 3, 4, 5].every(st => (ctx.medals[`c:novice:${st}`] || 0) >= 3);
    if (novGold) grant('all-gold-novice');
    const wcAll = [0, 1, 2, 3, 4, 5].every(i => meta.rosettePaid[`wcq:w:${i}`]);
    if (wcAll) grant('worldcup-all');
  }

  if (newly.length) localStorage.setItem('agility_ach', JSON.stringify(ach));
  saveMeta(meta); // счётчики замучены — фиксируем сразу
  return newly;
}

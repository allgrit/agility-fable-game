// Система достижений: проверка условий после каждого прогона, хранение в localStorage.
export const ACHIEVEMENTS = [
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
];

export function loadAch() {
  try { return JSON.parse(localStorage.getItem('agility_ach') || '{}'); }
  catch { return {}; }
}

export function hasAch(id) { return !!loadAch()[id]; }

// Проверяет все условия; возвращает список НОВЫХ достижений.
export function checkAchievements(ctx) {
  const { run, result, mode, cls, goldCount } = ctx;
  const ach = loadAch();
  const newly = [];
  const grant = (id) => {
    if (!ach[id]) { ach[id] = Date.now(); newly.push(ACHIEVEMENTS.find(a => a.id === id)); }
  };

  // Счётчик снарядов
  const obst = Number(localStorage.getItem('agility_obstacles') || 0) + run.marks.length;
  localStorage.setItem('agility_obstacles', String(obst));

  grant('first-run');
  if (result.clean) grant('first-q');
  if (run.score.maxCombo >= 10) grant('combo-10');
  if (run.score.perfects === run.marks.length && run.marks.length > 0) grant('perfect-run');
  if (goldCount >= 5) grant('golden-paw');
  if (cls === 'excellent' || cls === 'masters') grant('excellent');
  if (cls === 'masters') grant('masters');
  if (mode === 'worldcup' && result.clean) grant('worldcup-q');
  if (mode === 'daily') grant('daily-player');
  if (obst >= 100) grant('obstacles-100');

  if (newly.length) localStorage.setItem('agility_ach', JSON.stringify(ach));
  return newly;
}

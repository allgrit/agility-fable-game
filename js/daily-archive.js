// S4.11 «Календарь-архив трасс дня» (Trackmania Track of the Day / art of rally).
//
// Чистый модуль: без DOM, без localStorage, без `new Date()` внутри функций.
// Любая дата приходит параметром — иначе тесты флакают на границе суток и в разных
// часовых поясах. Чтение `agility_medals` / `agility_daily` остаётся на UI-слое,
// сюда приходят уже разобранные объекты.
//
// Арифметика трассы дня дублирует живую игру (js/main.js):
//   todayNum()      → dayNumFor(date)        = y*10000 + m*100 + d
//   todayStr()      → dayKeyFor(date)        = 'DD.MM.YYYY'
//   generateCourse(todayNum()*13 + 7, ...)   → dailySeed(dayNum)
//   dailyCls()      → dailyClassFor(dayNum)  = ['open','excellent','masters'][n % 3]
//   dailyModifier() → dailyModifierFor(n)    = [...][floor(n / 3) % 4]
//   courseKey()     → medalKeyFor(date)      = `d:${dayKey}`
// Расхождение здесь = календарь показывает не ту трассу, которую игрок реально бежал,
// поэтому формулы зафиксированы тестом tests/daily-archive.test.mjs.

export const DAILY_CLASSES = ['open', 'excellent', 'masters'];
export const DAILY_MODIFIERS = ['none', 'rain', 'dusk', 'strict'];
export const MEDAL_ICON = { 4: '💎', 3: '🥇', 2: '🥈', 1: '🥉' };

// Понедельник — первый день недели (русскоязычная игра).
export const WEEK_START = 1;
export const WEEKDAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const MONTH_NAMES = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

// ---------- гражданская дата {y, m, d} ----------
// m — человеческий месяц 1..12 (не JS-индекс), чтобы не плодить off-by-one.

const pad2 = (n) => String(n).padStart(2, '0');

// Принимает Date (берутся ЛОКАЛЬНЫЕ компоненты — как в main.js), строку 'DD.MM.YYYY',
// число-dayNum (20260821), объект {y,m,d} / {year,month,day}.
export function toCivil(date) {
  // Текущее время внутрь модуля не подставляем — дату всегда передаёт вызывающий.
  if (date == null) throw new TypeError('daily-archive: дата обязательна');
  if (date instanceof Date) {
    return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
  }
  if (typeof date === 'number') {
    if (!Number.isFinite(date) || date < 10000101) throw new TypeError(`daily-archive: некорректный dayNum ${date}`);
    return { y: Math.floor(date / 10000), m: Math.floor(date / 100) % 100, d: date % 100 };
  }
  if (typeof date === 'string') {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(date.trim());
    if (!m) throw new TypeError(`daily-archive: ожидалась дата 'DD.MM.YYYY', пришло '${date}'`);
    return { y: +m[3], m: +m[2], d: +m[1] };
  }
  if (typeof date === 'object') {
    const y = date.y ?? date.year, mo = date.m ?? date.month, d = date.d ?? date.day;
    if ([y, mo, d].every((v) => Number.isFinite(v))) return { y, m: mo, d };
  }
  throw new TypeError('daily-archive: не распознан формат даты');
}

// UTC-полдень: арифметика дней без сюрпризов перехода на летнее время.
function toUtc(c) { return Date.UTC(c.y, c.m - 1, c.d, 12); }
function fromUtc(ts) {
  const dt = new Date(ts);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
export function addDays(date, n) { return fromUtc(toUtc(toCivil(date)) + n * 86400000); }
export function daysBetween(from, to) {
  return Math.round((toUtc(toCivil(to)) - toUtc(toCivil(from))) / 86400000);
}
export function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
// 0 = понедельник … 6 = воскресенье
export function weekdayIndex(date) {
  return (new Date(toUtc(toCivil(date))).getUTCDay() + 7 - WEEK_START) % 7;
}

// ---------- параметры трассы дня (зеркало main.js) ----------
export function dayNumFor(date) {
  const c = toCivil(date);
  return c.y * 10000 + c.m * 100 + c.d;
}
export function dayKeyFor(date) {
  const c = toCivil(date);
  return `${pad2(c.d)}.${pad2(c.m)}.${c.y}`;
}
export function medalKeyFor(date) { return `d:${dayKeyFor(date)}`; }
export function dailySeed(dayNum) { return dayNum * 13 + 7; }
export function dailyClassFor(dayNum) { return DAILY_CLASSES[dayNum % 3]; }
export function dailyModifierFor(dayNum) { return DAILY_MODIFIERS[Math.floor(dayNum / 3) % 4]; }

// Всё о трассе конкретной даты одним объектом — этого хватает, чтобы построить
// ровно ту же трассу: generateCourse(p.seed, p.cls).
export function dailyParams(date) {
  const dayNum = dayNumFor(date);
  return {
    date: toCivil(date),
    dayNum,
    key: dayKeyFor(date),
    medalKey: medalKeyFor(date),
    seed: dailySeed(dayNum),
    cls: dailyClassFor(dayNum),
    modifier: dailyModifierFor(dayNum),
  };
}

// ---------- нормализация сохранённого состояния ----------
// medals: объект `agility_medals` целиком (ключи `d:DD.MM.YYYY`, `c:…`, `w:…`).
// dailyBest: либо одиночная запись `agility_daily` {date, points}, либо карта
// {'21.08.2026': 1234} (если UI когда-нибудь начнёт хранить историю).
export function normalizeDailyBest(dailyBest) {
  if (!dailyBest) return {};
  if (typeof dailyBest.date === 'string') {
    return dailyBest.points == null ? {} : { [dailyBest.date]: dailyBest.points };
  }
  const out = {};
  for (const [k, v] of Object.entries(dailyBest)) {
    if (v == null) continue;
    out[k] = typeof v === 'object' ? (v.points ?? null) : v;
    if (out[k] == null) delete out[k];
  }
  return out;
}

// Все даты трасс дня, о которых есть хоть какая-то запись, по возрастанию.
export function playedDates({ medals = {}, dailyBest = null } = {}) {
  const best = normalizeDailyBest(dailyBest);
  const keys = new Set();
  for (const k of Object.keys(medals || {})) {
    if (k.startsWith('d:') && (medals[k] || 0) >= 1) keys.add(k.slice(2));
  }
  for (const k of Object.keys(best)) keys.add(k);
  return [...keys]
    .filter((k) => /^\d{2}\.\d{2}\.\d{4}$/.test(k))
    .map(toCivil)
    .sort((a, b) => dayNumFor(a) - dayNumFor(b));
}

export function earliestPlayed(state) {
  const all = playedDates(state);
  return all.length ? all[0] : null;
}

// ---------- сетка месяца ----------
/**
 * @param {object} o
 * @param {number} o.year   — год сетки
 * @param {number} o.month  — месяц 1..12
 * @param {*} o.today       — «сегодня» игрока (обязательно, извне)
 * @param {object} [o.medals]     — agility_medals
 * @param {*} [o.dailyBest]       — agility_daily (или карта дата→очки)
 * @param {*} [o.firstPlayed]     — первый сыгранный день; если не задан, берётся из данных
 * @returns сетка + сводка + флаги навигации
 */
export function buildCalendar({ year, month, today, medals = {}, dailyBest = null, firstPlayed = undefined } = {}) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    throw new RangeError(`daily-archive: некорректный месяц ${year}-${month}`);
  }
  const todayC = toCivil(today);
  const todayNum = dayNumFor(todayC);
  const best = normalizeDailyBest(dailyBest);
  const total = daysInMonth(year, month);

  const days = [];
  for (let d = 1; d <= total; d++) {
    const c = { y: year, m: month, d };
    const p = dailyParams(c);
    const medal = Math.max(0, Math.min(4, Math.floor(medals?.[p.medalKey] || 0)));
    const points = best[p.key] ?? null;
    const played = medal >= 1 || points != null;
    const isToday = p.dayNum === todayNum;
    const isFuture = p.dayNum > todayNum;
    const isPast = p.dayNum < todayNum;
    days.push({
      date: p.date,
      dayNum: p.dayNum,
      key: p.key,
      medalKey: p.medalKey,
      seed: p.seed,
      cls: p.cls,
      modifier: p.modifier,
      weekday: weekdayIndex(c),
      played,
      medal,
      medalIcon: MEDAL_ICON[medal] || '',
      points,
      isToday,
      isFuture,
      isPast,
      // Пропуск: день в прошлом и записей о нём нет (UI красит серым).
      missed: isPast && !played,
      // Будущие дни недоступны, прошлые — можно перебежать.
      playable: !isFuture,
      // Зачёт только за сегодня: перебег прошедшего дня — вне зачёта
      // (очки/медаль не идут в статистику и лидерборд).
      isScored: isToday,
    });
  }

  const leading = weekdayIndex({ y: year, m: month, d: 1 });
  const cells = [...Array(leading).fill(null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const first = firstPlayed === undefined ? earliestPlayed({ medals, dailyBest }) : (firstPlayed && toCivil(firstPlayed));
  const bounds = { today: todayC, firstPlayed: first || null };

  return {
    year,
    month,
    monthName: MONTH_NAMES[month - 1],
    weekStart: WEEK_START,
    weekdayLabels: WEEKDAY_LABELS,
    leadingBlanks: leading,
    days,
    cells,
    weeks,
    summary: summarize(days),
    bounds,
    canPrev: canGoPrev({ year, month }, bounds),
    canNext: canGoNext({ year, month }, bounds),
  };
}

// Сводка месяца. Пропуски и серия считаются только по прошедшим/сегодняшнему дням —
// будущее не «пропущено», оно просто ещё не наступило.
export function summarize(days) {
  const elapsed = days.filter((x) => !x.isFuture);
  const medals = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let played = 0, missed = 0, points = 0, best = 0;
  let streak = 0, longest = 0;
  for (const day of elapsed) {
    if (day.played) {
      played++;
      if (medals[day.medal] !== undefined) medals[day.medal]++;
      if (day.points != null) { points += day.points; best = Math.max(best, day.points); }
      streak++;
      if (streak > longest) longest = streak;
    } else {
      missed++;
      streak = 0;
    }
  }
  return {
    daysTotal: days.length,
    daysElapsed: elapsed.length,
    played,
    missed,
    medals,
    medalsTotal: medals[1] + medals[2] + medals[3] + medals[4],
    pointsTotal: points,
    bestPoints: best,
    longestStreak: longest,
    // серия, тянущаяся к концу месяца (нужна, чтобы сшивать месяцы)
    tailStreak: streak,
  };
}

// Текущая серия подряд сыгранных дней по фактическим данным архива (питает meta.streak).
// Отсчёт от сегодня; если сегодня ещё не бегали — серия жива до конца суток,
// поэтому считаем от вчера.
export function currentStreak({ today, medals = {}, dailyBest = null, maxLookback = 730 } = {}) {
  const best = normalizeDailyBest(dailyBest);
  const isPlayed = (c) => (medals?.[medalKeyFor(c)] || 0) >= 1 || best[dayKeyFor(c)] != null;
  let cur = toCivil(today);
  if (!isPlayed(cur)) cur = addDays(cur, -1);
  let n = 0;
  while (n < maxLookback && isPlayed(cur)) { n++; cur = addDays(cur, -1); }
  return n;
}

// ---------- навигация по месяцам ----------
// Нельзя листать в будущее и раньше месяца первого сыгранного дня.
const ord = (c) => c.y * 12 + (c.m - 1);
const cursorOf = (o) => ({ y: o.year ?? o.y, m: o.month ?? o.m });

function limits({ today, firstPlayed } = {}) {
  const t = cursorOf(toCivil(today));
  const f = firstPlayed ? cursorOf(toCivil(firstPlayed)) : t;
  // Первый сыгранный день позже сегодняшнего — данные битые, не даём нижней границе
  // уехать вперёд.
  return { min: ord(f) <= ord(t) ? f : t, max: t };
}

export function canGoPrev(cursor, bounds) {
  const c = cursorOf(cursor), l = limits(bounds);
  return ord(c) - 1 >= ord(l.min);
}
export function canGoNext(cursor, bounds) {
  const c = cursorOf(cursor), l = limits(bounds);
  return ord(c) + 1 <= ord(l.max);
}
// Возвращают {year, month} или null, если шаг запрещён.
export function prevMonth(cursor, bounds) {
  if (!canGoPrev(cursor, bounds)) return null;
  const c = cursorOf(cursor);
  return c.m === 1 ? { year: c.y - 1, month: 12 } : { year: c.y, month: c.m - 1 };
}
export function nextMonth(cursor, bounds) {
  if (!canGoNext(cursor, bounds)) return null;
  const c = cursorOf(cursor);
  return c.m === 12 ? { year: c.y + 1, month: 1 } : { year: c.y, month: c.m + 1 };
}
// Курсор по умолчанию — месяц «сегодня».
export function currentCursor(today) {
  const c = toCivil(today);
  return { year: c.y, month: c.m };
}

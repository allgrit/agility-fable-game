// S4.11 «Календарь-архив трасс дня»: node --test tests/daily-archive.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCourse } from '../js/course.js';
import {
  toCivil, addDays, daysBetween, daysInMonth, weekdayIndex,
  dayNumFor, dayKeyFor, medalKeyFor, dailySeed, dailyClassFor, dailyModifierFor, dailyParams,
  normalizeDailyBest, playedDates, earliestPlayed,
  buildCalendar, summarize, currentStreak,
  prevMonth, nextMonth, canGoPrev, canGoNext, currentCursor,
  WEEK_START, WEEKDAY_LABELS, MEDAL_ICON,
} from '../js/daily-archive.js';

// ---------- эталон: формулы, скопированные из js/main.js ----------
// Если игра поменяет свои формулы, а модуль — нет, эти тесты покраснеют.
function refTodayStr(d) {
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}
function refTodayNum(d) {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
const refDailyCls = (n) => ['open', 'excellent', 'masters'][n % 3];
const refDailyModifier = (n) => ['none', 'rain', 'dusk', 'strict'][Math.floor(n / 3) % 4];
const refDailySeed = (n) => n * 13 + 7;

test('dayNumFor / dayKeyFor совпадают с todayNum() / todayStr() живой игры', () => {
  // 400 дат подряд, включая границы месяцев и високосный февраль
  for (let i = 0; i < 400; i++) {
    const d = new Date(2024, 0, 1 + i, 12);   // локальная дата — как в main.js
    assert.equal(dayNumFor(d), refTodayNum(d), `dayNum ${d}`);
    assert.equal(dayKeyFor(d), refTodayStr(d), `dayKey ${d}`);
  }
});

test('dailySeed / dailyClassFor / dailyModifierFor совпадают с формулами main.js', () => {
  for (let i = 0; i < 400; i++) {
    const d = new Date(2024, 0, 1 + i, 12);
    const n = refTodayNum(d);
    assert.equal(dailySeed(n), refDailySeed(n));
    assert.equal(dailyClassFor(n), refDailyCls(n));
    assert.equal(dailyModifierFor(n), refDailyModifier(n));
  }
});

test('dailyParams: связка ключ/сид/класс/модификатор для конкретной даты', () => {
  const p = dailyParams({ y: 2026, m: 8, d: 21 });
  assert.equal(p.dayNum, 20260821);
  assert.equal(p.key, '21.08.2026');
  assert.equal(p.medalKey, 'd:21.08.2026');
  assert.equal(p.seed, 20260821 * 13 + 7);
  assert.equal(p.cls, ['open', 'excellent', 'masters'][20260821 % 3]);
  assert.equal(p.modifier, ['none', 'rain', 'dusk', 'strict'][Math.floor(20260821 / 3) % 4]);
});

test('один день — всегда одна и та же трасса', () => {
  for (const day of ['01.01.2026', '29.02.2024', '31.12.2026']) {
    const n = dayNumFor(day);
    const a = generateCourse(dailySeed(n), dailyClassFor(n));
    const b = generateCourse(dailySeed(n), dailyClassFor(n));
    assert.deepEqual(a.obstacles.map((o) => o.type), b.obstacles.map((o) => o.type));
    assert.deepEqual(a.obstacles, b.obstacles);
  }
});

test('разные дни дают разные трассы (хотя бы иногда)', () => {
  const sets = new Set();
  for (let i = 0; i < 30; i++) {
    const n = dayNumFor(addDays('01.03.2026', i));
    sets.add(generateCourse(dailySeed(n), dailyClassFor(n)).obstacles.map((o) => o.type).join(','));
  }
  assert.ok(sets.size > 5, `30 дней дали всего ${sets.size} разных трасс`);
});

test('toCivil принимает Date, строку, dayNum и объект', () => {
  const want = { y: 2026, m: 8, d: 21 };
  assert.deepEqual(toCivil(new Date(2026, 7, 21, 12)), want);
  assert.deepEqual(toCivil('21.08.2026'), want);
  assert.deepEqual(toCivil(20260821), want);
  assert.deepEqual(toCivil({ year: 2026, month: 8, day: 21 }), want);
  assert.deepEqual(toCivil(want), want);
  assert.throws(() => toCivil(null));
  assert.throws(() => toCivil('2026-08-21'));
});

test('арифметика дней: границы месяцев, високосный год, обратный ход', () => {
  assert.deepEqual(addDays('31.01.2026', 1), { y: 2026, m: 2, d: 1 });
  assert.deepEqual(addDays('28.02.2026', 1), { y: 2026, m: 3, d: 1 });
  assert.deepEqual(addDays('28.02.2024', 1), { y: 2024, m: 2, d: 29 });   // високосный
  assert.deepEqual(addDays('01.01.2026', -1), { y: 2025, m: 12, d: 31 });
  assert.equal(daysBetween('01.03.2024', '01.04.2024'), 31);
  assert.equal(daysBetween('01.02.2024', '01.03.2024'), 29);
  assert.equal(daysBetween('01.02.2026', '01.03.2026'), 28);
});

test('длина месяца: 31 / 30 / 28 / 29', () => {
  assert.equal(daysInMonth(2026, 1), 31);
  assert.equal(daysInMonth(2026, 4), 30);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2024, 2), 29);   // високосный
  assert.equal(daysInMonth(2000, 2), 29);   // век, делящийся на 400
  assert.equal(daysInMonth(1900, 2), 28);   // век, не делящийся на 400
  assert.equal(daysInMonth(2026, 12), 31);
});

test('неделя начинается с понедельника', () => {
  assert.equal(WEEK_START, 1);
  assert.equal(WEEKDAY_LABELS[0], 'Пн');
  assert.equal(WEEKDAY_LABELS[6], 'Вс');
  assert.equal(weekdayIndex('17.08.2026'), 0);   // понедельник
  assert.equal(weekdayIndex('23.08.2026'), 6);   // воскресенье
});

// ---------- сетка месяца ----------
const TODAY = '21.08.2026';   // пятница

function cal(extra = {}) {
  return buildCalendar({ year: 2026, month: 8, today: TODAY, ...extra });
}

test('сетка месяца: число дней и позиция первого числа', () => {
  const c = cal();
  assert.equal(c.days.length, 31);
  assert.equal(c.days[0].key, '01.08.2026');
  assert.equal(c.days[30].key, '31.08.2026');
  // 1 августа 2026 — суббота → 5 пустых ячеек перед ней при старте с понедельника
  assert.equal(c.leadingBlanks, 5);
  assert.equal(c.cells.length % 7, 0);
  assert.equal(c.weeks.length, c.cells.length / 7);
  assert.equal(c.weeks[0][5].key, '01.08.2026');
  assert.equal(c.weeks[0].slice(0, 5).every((x) => x === null), true);
});

test('сетка месяца: 30/28/29-дневные месяцы', () => {
  assert.equal(buildCalendar({ year: 2026, month: 4, today: '30.04.2026' }).days.length, 30);
  assert.equal(buildCalendar({ year: 2026, month: 2, today: '28.02.2026' }).days.length, 28);
  const feb24 = buildCalendar({ year: 2024, month: 2, today: '29.02.2024' });
  assert.equal(feb24.days.length, 29);
  assert.equal(feb24.days[28].key, '29.02.2024');
  // 1 февраля 2026 — воскресенье → 6 пустых ячеек
  assert.equal(buildCalendar({ year: 2026, month: 2, today: '28.02.2026' }).leadingBlanks, 6);
});

test('четыре состояния дня: сыгран с медалью, пропущен, сегодня, будущее', () => {
  const c = cal({
    medals: { 'd:18.08.2026': 3, 'c:open:1': 2 },
    dailyBest: { date: '18.08.2026', points: 1234 },
  });
  const by = (k) => c.days.find((x) => x.key === k);

  const playedDay = by('18.08.2026');
  assert.equal(playedDay.played, true);
  assert.equal(playedDay.medal, 3);
  assert.equal(playedDay.medalIcon, MEDAL_ICON[3]);
  assert.equal(playedDay.points, 1234);
  assert.equal(playedDay.missed, false);
  assert.equal(playedDay.playable, true);

  const missedDay = by('19.08.2026');
  assert.equal(missedDay.played, false);
  assert.equal(missedDay.medal, 0);
  assert.equal(missedDay.points, null);
  assert.equal(missedDay.missed, true);
  assert.equal(missedDay.isPast, true);
  assert.equal(missedDay.playable, true);

  const todayDay = by('21.08.2026');
  assert.equal(todayDay.isToday, true);
  assert.equal(todayDay.isFuture, false);
  assert.equal(todayDay.missed, false);   // сегодня ещё не пропуск
  assert.equal(todayDay.playable, true);

  const futureDay = by('22.08.2026');
  assert.equal(futureDay.isFuture, true);
  assert.equal(futureDay.playable, false);
  assert.equal(futureDay.missed, false);
  assert.equal(futureDay.played, false);
});

test('isScored: сегодня в зачёт, перебег прошлого дня — вне зачёта, будущее недоступно', () => {
  const c = cal({ medals: { 'd:18.08.2026': 4 } });
  assert.equal(c.days.find((x) => x.key === '21.08.2026').isScored, true);
  assert.equal(c.days.find((x) => x.key === '18.08.2026').isScored, false);
  assert.equal(c.days.find((x) => x.key === '20.08.2026').isScored, false);
  assert.equal(c.days.find((x) => x.key === '22.08.2026').isScored, false);
  // ровно один зачётный день в месяце
  assert.equal(c.days.filter((x) => x.isScored).length, 1);
});

test('день сыгран, если есть медаль ИЛИ результат в agility_daily', () => {
  const onlyMedal = cal({ medals: { 'd:10.08.2026': 1 } }).days.find((x) => x.key === '10.08.2026');
  assert.equal(onlyMedal.played, true);
  assert.equal(onlyMedal.points, null);
  const onlyPoints = cal({ dailyBest: { '11.08.2026': 900 } }).days.find((x) => x.key === '11.08.2026');
  assert.equal(onlyPoints.played, true);
  assert.equal(onlyPoints.medal, 0);
});

test('параметры трассы в ячейке совпадают с живой формулой', () => {
  const c = cal();
  for (const day of c.days) {
    assert.equal(day.seed, refDailySeed(day.dayNum));
    assert.equal(day.cls, refDailyCls(day.dayNum));
    assert.equal(day.modifier, refDailyModifier(day.dayNum));
  }
});

test('модуль не трогает localStorage и не зовёт new Date() без аргумента', async () => {
  const raw = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../js/daily-archive.js', import.meta.url), 'utf8'));
  // комментарии вырезаем: в них эти конструкции упоминаются как запрет
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/localStorage/.test(src), false, 'модуль не должен читать/писать localStorage');
  assert.equal(/new Date\(\s*\)/.test(src), false, 'new Date() без аргумента ломает детерминизм');
});

// ---------- сводка ----------
test('сводка: сыграно/пропущено/медали, будущее не считается пропуском', () => {
  const c = cal({
    medals: { 'd:01.08.2026': 3, 'd:02.08.2026': 2, 'd:03.08.2026': 4, 'd:21.08.2026': 1 },
    dailyBest: { '02.08.2026': 500, '21.08.2026': 700 },
  });
  const s = c.summary;
  assert.equal(s.daysTotal, 31);
  assert.equal(s.daysElapsed, 21);            // 1..21 августа
  assert.equal(s.played, 4);
  assert.equal(s.missed, 17);
  assert.deepEqual(s.medals, { 1: 1, 2: 1, 3: 1, 4: 1 });
  assert.equal(s.medalsTotal, 4);
  assert.equal(s.pointsTotal, 1200);
  assert.equal(s.bestPoints, 700);
});

test('сводка: самая длинная серия подряд, в том числе с разрывом', () => {
  const medals = {};
  for (const d of [1, 2, 3, 5, 6, 7, 8, 20]) medals[`d:${String(d).padStart(2, '0')}.08.2026`] = 2;
  const s = cal({ medals }).summary;
  assert.equal(s.played, 8);
  assert.equal(s.longestStreak, 4);   // 5..8 августа
  assert.equal(s.tailStreak, 0);      // 21-е не сыграно → хвост оборван
});

test('сводка: серия, упирающаяся в сегодня, попадает в tailStreak', () => {
  const medals = {};
  for (const d of [19, 20, 21]) medals[`d:${d}.08.2026`] = 3;
  const s = cal({ medals }).summary;
  assert.equal(s.longestStreak, 3);
  assert.equal(s.tailStreak, 3);
});

test('summarize на пустом месяце', () => {
  const s = summarize([]);
  assert.equal(s.played, 0);
  assert.equal(s.missed, 0);
  assert.equal(s.longestStreak, 0);
});

test('currentStreak: считает назад от сегодня по фактическим данным', () => {
  const medals = {};
  for (const d of [17, 18, 19, 20, 21]) medals[`d:${d}.08.2026`] = 2;
  assert.equal(currentStreak({ today: '21.08.2026', medals }), 5);
  // сегодня ещё не бегали — серия жива до конца суток, считаем от вчера
  delete medals['d:21.08.2026'];
  assert.equal(currentStreak({ today: '21.08.2026', medals }), 4);
  // разрыв обрывает серию
  delete medals['d:19.08.2026'];
  assert.equal(currentStreak({ today: '21.08.2026', medals }), 1);
  assert.equal(currentStreak({ today: '21.08.2026', medals: {} }), 0);
});

test('currentStreak: серия переходит через границу месяца', () => {
  const medals = { 'd:30.07.2026': 1, 'd:31.07.2026': 1, 'd:01.08.2026': 1, 'd:02.08.2026': 1 };
  assert.equal(currentStreak({ today: '02.08.2026', medals }), 4);
});

// ---------- служебные разборы состояния ----------
test('normalizeDailyBest: одиночная запись agility_daily и карта', () => {
  assert.deepEqual(normalizeDailyBest({ date: '21.08.2026', points: 100 }), { '21.08.2026': 100 });
  assert.deepEqual(normalizeDailyBest(null), {});
  assert.deepEqual(normalizeDailyBest({ '01.08.2026': 10, '02.08.2026': null }), { '01.08.2026': 10 });
});

test('playedDates / earliestPlayed: только трассы дня, отсортированы', () => {
  const state = {
    medals: { 'd:05.08.2026': 2, 'c:open:1': 3, 'w:0': 1, 'd:01.07.2026': 1 },
    dailyBest: { date: '21.08.2026', points: 10 },
  };
  assert.deepEqual(playedDates(state).map(dayKeyFor), ['01.07.2026', '05.08.2026', '21.08.2026']);
  assert.equal(dayKeyFor(earliestPlayed(state)), '01.07.2026');
  assert.equal(earliestPlayed({ medals: {}, dailyBest: null }), null);
});

// ---------- навигация ----------
test('навигация: нельзя в будущее', () => {
  const bounds = { today: TODAY, firstPlayed: '01.05.2026' };
  assert.equal(canGoNext({ year: 2026, month: 8 }, bounds), false);
  assert.equal(nextMonth({ year: 2026, month: 8 }, bounds), null);
  assert.deepEqual(nextMonth({ year: 2026, month: 7 }, bounds), { year: 2026, month: 8 });
});

test('навигация: нельзя раньше месяца первого сыгранного дня', () => {
  const bounds = { today: TODAY, firstPlayed: '17.05.2026' };
  assert.equal(canGoPrev({ year: 2026, month: 5 }, bounds), false);
  assert.equal(prevMonth({ year: 2026, month: 5 }, bounds), null);
  assert.deepEqual(prevMonth({ year: 2026, month: 6 }, bounds), { year: 2026, month: 5 });
});

test('навигация: переход через границу года', () => {
  const bounds = { today: '15.02.2027', firstPlayed: '20.11.2026' };
  assert.deepEqual(prevMonth({ year: 2027, month: 1 }, bounds), { year: 2026, month: 12 });
  assert.deepEqual(nextMonth({ year: 2026, month: 12 }, bounds), { year: 2027, month: 1 });
});

test('навигация: без сыгранных дней доступен только текущий месяц', () => {
  const bounds = { today: TODAY, firstPlayed: null };
  assert.equal(canGoPrev({ year: 2026, month: 8 }, bounds), false);
  assert.equal(canGoNext({ year: 2026, month: 8 }, bounds), false);
  assert.deepEqual(currentCursor(TODAY), { year: 2026, month: 8 });
});

test('buildCalendar сам выводит границы из данных и выставляет canPrev/canNext', () => {
  const c = cal({ medals: { 'd:03.06.2026': 2, 'd:18.08.2026': 3 } });
  assert.equal(dayKeyFor(c.bounds.firstPlayed), '03.06.2026');
  assert.equal(c.canPrev, true);
  assert.equal(c.canNext, false);
  const june = buildCalendar({ year: 2026, month: 6, today: TODAY, medals: { 'd:03.06.2026': 2 } });
  assert.equal(june.canPrev, false);
  assert.equal(june.canNext, true);
});

test('buildCalendar: некорректный месяц отвергается', () => {
  assert.throws(() => buildCalendar({ year: 2026, month: 13, today: TODAY }), RangeError);
  assert.throws(() => buildCalendar({ year: 2026, month: 0, today: TODAY }), RangeError);
});

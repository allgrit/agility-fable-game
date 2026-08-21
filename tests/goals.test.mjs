// Тесты витрины целей «Питомник»: node --test tests/goals.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- Заглушка localStorage: achievements.js читает/пишет прогресс напрямую ---
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { collectGoals, nearestGoals, groupGoals, GOAL_SECTIONS } = await import('../js/goals.js');
const { ACHIEVEMENTS, checkAchievements, metricValue, CAREER_METRICS } =
  await import('../js/achievements.js');
const { ITEMS, priceOf } = await import('../js/cosmetics.js');
const { BOSSES } = await import('../js/career.js');

// ---------- хелперы состояния ----------
function emptyMeta(over = {}) {
  return {
    bones: 0, rosettes: 0, firstClears: {}, medalPaid: {}, rosettePaid: {},
    dogs: {}, owned: {}, counters: { runs: 0, cleans: 0, perfectRuns: 0 },
    streak: { count: 0, last: '', freezes: 0 },
    quests: { day: '', week: '', daily: [], weekly: [] },
    bosses: {}, ngplusUnlocked: 0, ...over,
  };
}

function runCtx(over = {}) {
  const marks = over.marks || [];
  return {
    run: {
      marks,
      score: { perfects: 0, maxCombo: 0 },
      breed: { id: 'border' },
      sct: 40, time: 40,
      ...(over.run || {}),
    },
    result: { qualified: false, clean: false, stars: 0, ...(over.result || {}) },
    mode: over.mode || 'career',
    cls: over.cls || 'novice',
    goldCount: over.goldCount ?? 0,
    meta: over.meta || emptyMeta(),
    medals: over.medals,
  };
}

function freshAch() { store.clear(); }

// ================= ВИТРИНА ЦЕЛЕЙ =================

test('goals: новый игрок — целей много, все невыполнены, ближайших ровно 3', () => {
  const goals = collectGoals({ meta: emptyMeta(), ach: {}, medals: {} });
  assert.ok(goals.length > 40, `целей мало: ${goals.length}`);
  assert.ok(goals.every(g => g.done === false), 'у нового игрока не должно быть done');
  for (const g of goals) {
    assert.ok(typeof g.id === 'string' && g.id.length);
    assert.ok(typeof g.kind === 'string' && g.kind.length);
    assert.ok(typeof g.name === 'string' && g.name.length);
    assert.ok(typeof g.hint === 'string' && g.hint.length);
    assert.ok(g.progress >= 0 && g.progress <= 1, `${g.id}: progress=${g.progress}`);
    assert.ok(Number.isFinite(g.effort), `${g.id}: effort=${g.effort}`);
  }
  const near = nearestGoals(goals, 3);
  assert.equal(near.length, 3);
  assert.ok(near.every(g => !g.done));
});

test('goals: id целей уникальны', () => {
  const goals = collectGoals({ meta: emptyMeta(), ach: {}, medals: {} });
  const ids = new Set(goals.map(g => g.id));
  assert.equal(ids.size, goals.length);
});

test('goals: выполненные есть в списке, но не в nearest', () => {
  const meta = emptyMeta({
    bones: 5000,
    owned: { 'neck-bandana-red': 1, 'paws-gold': 1 },
    bosses: { novice: 1 },
    counters: { obstacles: 3000, perfects: 1200, quals: 70, fakeouts: 20, breeds: {} },
  });
  const ach = { 'first-run': 1, 'obstacles-100': 1 };
  const goals = collectGoals({ meta, ach, medals: {} });
  const byId = Object.fromEntries(goals.map(g => [g.id, g]));
  assert.equal(byId['ach:first-run'].done, true);
  assert.equal(byId['cosmetic:neck-bandana-red'].done, true);
  assert.equal(byId['boss:novice'].done, true);
  const near = nearestGoals(goals, 10);
  assert.ok(near.every(g => !g.done), 'в nearest не должно быть выполненных');
  assert.ok(!near.some(g => g.id === 'cosmetic:neck-bandana-red'));
});

test('goals: прогресс счётчиковых ачивок — 250 из 500 снарядов = 0.5', () => {
  const meta = emptyMeta({ counters: { obstacles: 250, perfects: 0, quals: 0, breeds: {} } });
  const goals = collectGoals({ meta, ach: { 'obstacles-100': 1 }, medals: {} });
  const g = goals.find(x => x.id === 'ach:obstacles-500');
  assert.equal(g.current, 250);
  assert.equal(g.target, 500);
  assert.equal(g.progress, 0.5);
  assert.equal(g.done, false);
  assert.match(g.hint, /250/);
  // выданная — done, прогресс 1 и не больше
  const done = goals.find(x => x.id === 'ach:obstacles-100');
  assert.equal(done.done, true);
  assert.equal(done.progress, 1);
});

test('goals: бинарные цели без target не ломают сортировку', () => {
  const goals = collectGoals({ meta: emptyMeta(), ach: {}, medals: {} });
  const bin = goals.filter(g => g.target === null);
  assert.ok(bin.length > 0, 'бинарные цели должны быть');
  for (const g of bin) {
    assert.equal(g.progress, 0);
    assert.equal(g.current, 0);
    assert.ok(Number.isFinite(g.effort));
  }
  const near = nearestGoals(goals, 12);
  assert.equal(near.length, 12);
  assert.ok(near.every(g => Number.isFinite(g.effort)));
});

test('goals: косметика — купленный done, некупленный показывает цену', () => {
  const item = ITEMS.find(i => i.id === 'neck-collar-gold');
  const price = priceOf(item);
  const meta = emptyMeta({ bones: 100, owned: { 'paws-gold': 1 } });
  const goals = collectGoals({ meta, ach: {}, medals: {} });
  const bought = goals.find(g => g.id === 'cosmetic:paws-gold');
  assert.equal(bought.done, true);
  assert.equal(bought.progress, 1);
  const wanted = goals.find(g => g.id === 'cosmetic:neck-collar-gold');
  assert.equal(wanted.done, false);
  assert.equal(wanted.target, price.bones);
  assert.equal(wanted.current, 100);
  assert.match(wanted.hint, new RegExp(String(price.bones)));
  assert.match(wanted.hint, /🦴/);
  // легендарка за розетки — подсказка в 🏵️
  const legend = goals.find(g => g.id === 'cosmetic:coat-gold');
  assert.match(legend.hint, /🏵️/);
});

test('goals: боссы — побеждённый done, следующий становится целью', () => {
  const meta = emptyMeta({ bosses: { novice: 1 } });
  const goals = collectGoals({ meta, ach: {}, medals: {} });
  const bossGoals = goals.filter(g => g.kind === 'boss');
  assert.equal(bossGoals.length, Object.keys(BOSSES).length);
  assert.equal(goals.find(g => g.id === 'boss:novice').done, true);
  const next = goals.find(g => g.id === 'boss:open');
  assert.equal(next.done, false);
  assert.match(next.name, /Молния/);
  assert.ok(nearestGoals(goals, 40).some(g => g.id === 'boss:open'));
});

test('goals: задания попадают в цели с прогрессом', () => {
  const meta = emptyMeta();
  meta.quests = {
    day: '01.01.2026', week: '2026-W1',
    daily: [{ id: 'obst25', progress: 10, done: false, claimed: false }],
    weekly: [{ id: 'wruns12', progress: 12, done: true, claimed: true }],
  };
  const goals = collectGoals({ meta, ach: {}, medals: {} });
  const q = goals.find(g => g.id === 'quest:obst25');
  assert.equal(q.kind, 'quest');
  assert.equal(q.current, 10);
  assert.equal(q.target, 25);
  assert.equal(q.progress, 0.4);
  assert.equal(goals.find(g => g.id === 'quest:wruns12').done, true);
});

test('goals: уровни собак — цель до ближайшего титула', () => {
  const meta = emptyMeta({ dogs: { border: { xp: 0, level: 7, equip: {} } } });
  const goals = collectGoals({ meta, ach: {}, medals: {} });
  const lv = goals.find(g => g.kind === 'level' && g.id.includes('border'));
  assert.ok(lv, 'должна быть цель по уровню собаки');
  assert.equal(lv.current, 7);
  assert.equal(lv.target, 10);
  assert.equal(lv.done, false);
});

test('goals: медали — прогресс золота по классу', () => {
  const medals = { 'c:novice:1': 3, 'c:novice:2': 3, 'c:novice:3': 2 };
  const goals = collectGoals({ meta: emptyMeta(), ach: {}, medals });
  const m = goals.find(g => g.id === 'medal:novice');
  assert.equal(m.kind, 'medal');
  assert.equal(m.current, 2);
  assert.equal(m.target, 5);
  assert.equal(m.done, false);
});

test('goals: ранжирование — близкая мелкая цель обгоняет далёкую крупную', () => {
  // 90% из 2500 снарядов (осталось 250) против 60% из 10 обманок (осталось 4)
  const meta = emptyMeta({
    counters: { obstacles: 2250, perfects: 0, quals: 0, fakeouts: 6, breeds: {} },
  });
  const goals = collectGoals({ meta, ach: {}, medals: {} });
  const big = goals.find(g => g.id === 'ach:obstacles-2500');
  const small = goals.find(g => g.id === 'ach:fakeout-10');
  assert.ok(big.progress > small.progress, 'доля у крупной цели выше');
  assert.ok(small.effort < big.effort, 'но усилий до мелкой цели меньше');
  const order = nearestGoals(goals, goals.length, { maxPerKind: 99 }).map(g => g.id);
  assert.ok(order.includes('ach:fakeout-10') && order.includes('ach:obstacles-2500'));
  assert.ok(order.indexOf('ach:fakeout-10') < order.indexOf('ach:obstacles-2500'));
});

test('goals: детерминированность — два вызова дают идентичный порядок', () => {
  const mk = () => emptyMeta({
    bones: 700, rosettes: 3,
    owned: { 'paws-gold': 1 },
    counters: { obstacles: 480, perfects: 190, quals: 14, fakeouts: 9, breeds: { border: 1 } },
    streak: { count: 2, last: '', freezes: 0 },
    dogs: { border: { xp: 10, level: 9, equip: {} } },
    bosses: { novice: 1 },
  });
  const a = collectGoals({ meta: mk(), ach: { 'first-run': 1 }, medals: { 'c:novice:1': 3 } });
  const b = collectGoals({ meta: mk(), ach: { 'first-run': 1 }, medals: { 'c:novice:1': 3 } });
  assert.deepEqual(a.map(g => g.id), b.map(g => g.id));
  assert.deepEqual(nearestGoals(a, 5).map(g => g.id), nearestGoals(b, 5).map(g => g.id));
  // равный effort → устойчивый тай-брейк по id
  const tie = [
    { id: 'z', done: false, effort: 1 }, { id: 'a', done: false, effort: 1 },
    { id: 'm', done: false, effort: 1 },
  ];
  assert.deepEqual(nearestGoals(tie, 3, { maxPerKind: 99 }).map(g => g.id), ['a', 'm', 'z']);
});

test('goals: nearest не отдаёт больше n и переживает пустой вход', () => {
  assert.deepEqual(nearestGoals([], 3), []);
  const goals = collectGoals({ meta: emptyMeta(), ach: {}, medals: {} });
  assert.equal(nearestGoals(goals, 1).length, 1);
  assert.equal(nearestGoals(goals).length, 3);
});

test('goals: nearest разбавляет разделы (не 3 косметики подряд)', () => {
  const meta = emptyMeta({ bones: 100000 });
  const near = nearestGoals(collectGoals({ meta, ach: {}, medals: {} }), 3);
  const kinds = new Set(near.map(g => g.kind));
  assert.ok(kinds.size >= 2, `ожидали разнообразие разделов, получили ${[...kinds]}`);
});

test('goals: группировка по разделам покрывает весь список', () => {
  const goals = collectGoals({ meta: emptyMeta(), ach: {}, medals: {} });
  const groups = groupGoals(goals);
  assert.ok(groups.length >= 4);
  assert.equal(groups.reduce((s, g) => s + g.goals.length, 0), goals.length);
  for (const gr of groups) {
    assert.ok(GOAL_SECTIONS.some(s => s.kind === gr.kind));
    assert.ok(typeof gr.title === 'string' && gr.title.length);
    assert.equal(gr.total, gr.goals.length);
    assert.equal(gr.done, gr.goals.filter(g => g.done).length);
  }
  const kinds = groups.map(g => g.kind);
  assert.ok(kinds.includes('achievement') && kinds.includes('cosmetic') && kinds.includes('boss'));
});

// ================= РЕГРЕССИЯ ACHIEVEMENTS =================

test('achievements: метрики ачивок объявлены данными и согласованы', () => {
  for (const a of ACHIEVEMENTS) {
    if (!a.metric) continue;
    assert.ok(CAREER_METRICS[a.metric], `${a.id}: неизвестная метрика ${a.metric}`);
    assert.ok(Number.isFinite(a.target) && a.target > 0, `${a.id}: нет target`);
  }
  const withMetric = ACHIEVEMENTS.filter(a => a.metric).map(a => a.id);
  for (const id of ['obstacles-100', 'obstacles-500', 'obstacles-2500',
    'quals-15', 'quals-60', 'perfects-200', 'perfects-1000',
    'streak-3', 'streak-7', 'streak-30', 'fakeout-10', 'all-breeds',
    'shopper', 'collector-5', 'rich-1000']) {
    assert.ok(withMetric.includes(id), `${id} должен иметь метрику`);
  }
  assert.equal(metricValue('obstacles', emptyMeta({ counters: { obstacles: 42 } })), 42);
});

test('achievements: цепочка obstacles — 100/500/2500 по тем же порогам', () => {
  freshAch();
  const marks = (n) => Array.from({ length: n }, () => ({}));
  let meta = emptyMeta({ counters: { obstacles: 99 } });
  let got = checkAchievements(runCtx({ meta, marks: marks(1) })).map(a => a.id);
  assert.ok(got.includes('obstacles-100'), '100 снарядов → obstacles-100');
  assert.ok(!got.includes('obstacles-500'));

  freshAch();
  meta = emptyMeta({ counters: { obstacles: 498 } });
  got = checkAchievements(runCtx({ meta, marks: marks(1) })).map(a => a.id);
  assert.ok(!got.includes('obstacles-500'), '499 < 500 — рано');
  meta.counters.obstacles = 499;
  got = checkAchievements(runCtx({ meta, marks: marks(1) })).map(a => a.id);
  assert.ok(got.includes('obstacles-500'), '500 снарядов → obstacles-500');

  freshAch();
  meta = emptyMeta({ counters: { obstacles: 2499 } });
  got = checkAchievements(runCtx({ meta, marks: marks(1) })).map(a => a.id);
  assert.ok(got.includes('obstacles-2500'));
  assert.ok(got.includes('obstacles-100') && got.includes('obstacles-500'), 'вся цепочка сразу');
});

test('achievements: комбо 10/20/40 по тем же порогам', () => {
  freshAch();
  let got = checkAchievements(runCtx({ run: { score: { perfects: 0, maxCombo: 9 } } })).map(a => a.id);
  assert.ok(!got.includes('combo-10'));
  got = checkAchievements(runCtx({ run: { score: { perfects: 0, maxCombo: 10 } } })).map(a => a.id);
  assert.ok(got.includes('combo-10'));
  assert.ok(!got.includes('combo-20'));

  freshAch();
  got = checkAchievements(runCtx({ run: { score: { perfects: 0, maxCombo: 40 } } })).map(a => a.id);
  assert.ok(got.includes('combo-10') && got.includes('combo-20') && got.includes('combo-40'));
});

test('achievements: perfects 200/1000 по тем же порогам', () => {
  freshAch();
  let meta = emptyMeta({ counters: { obstacles: 0, perfects: 190 } });
  let got = checkAchievements(runCtx({ meta, run: { score: { perfects: 9, maxCombo: 0 } } })).map(a => a.id);
  assert.ok(!got.includes('perfects-200'), '199 < 200');
  got = checkAchievements(runCtx({ meta, run: { score: { perfects: 1, maxCombo: 0 } } })).map(a => a.id);
  assert.ok(got.includes('perfects-200'));
  assert.ok(!got.includes('perfects-1000'));

  freshAch();
  meta = emptyMeta({ counters: { obstacles: 0, perfects: 999 } });
  got = checkAchievements(runCtx({ meta, run: { score: { perfects: 1, maxCombo: 0 } } })).map(a => a.id);
  assert.ok(got.includes('perfects-1000'));
});

test('achievements: остальные пороги не поехали (quals/streak/fakeout/breeds/bones/owned)', () => {
  freshAch();
  const meta = emptyMeta({
    bones: 1000,
    owned: { a: 1, b: 1, c: 1, d: 1, e: 1 },
    counters: { obstacles: 0, perfects: 0, quals: 59, fakeouts: 9, breeds: { a: 1, b: 1, c: 1, d: 1 } },
    streak: { count: 30, last: '', freezes: 0 },
  });
  const marks = [{ decoys: true, qte: { result: { grade: 'good' } } }];
  const got = checkAchievements(runCtx({ meta, marks, result: { qualified: true, clean: false, stars: 0 } })).map(a => a.id);
  assert.ok(got.includes('quals-60'), '59+1 = 60 квалификаций');
  assert.ok(got.includes('fakeout-10'), '9+1 = 10 обманок');
  assert.ok(got.includes('streak-3') && got.includes('streak-7') && got.includes('streak-30'));
  assert.ok(got.includes('rich-1000'));
  assert.ok(got.includes('shopper') && got.includes('collector-5'));
  assert.ok(got.includes('all-breeds'), '4 породы + текущая = 5');
});

test('achievements: не-счётчиковые условия остались прежними', () => {
  freshAch();
  let got = checkAchievements(runCtx({
    marks: [{}, {}], run: { score: { perfects: 2, maxCombo: 0 }, sct: 40, time: 24 },
    result: { qualified: true, clean: true, stars: 4 }, mode: 'worldcup', cls: 'masters', goldCount: 5,
  })).map(a => a.id);
  for (const id of ['first-run', 'first-q', 'perfect-run', 'golden-paw', 'excellent', 'masters',
    'worldcup-q', 'diamond', 'speed-5', 'speed-10', 'speed-15']) {
    assert.ok(got.includes(id), `ожидали ${id}`);
  }
  assert.ok(!got.includes('daily-player'));

  freshAch();
  got = checkAchievements(runCtx({ mode: 'daily' })).map(a => a.id);
  assert.ok(got.includes('daily-player'));

  // fashionista: все 4 слота у текущей породы
  freshAch();
  const meta = emptyMeta({
    owned: { x: 1 },
    dogs: { border: { xp: 0, level: 1, equip: { coat: 'a', neck: 'b', paws: 'c', finish: 'd' } } },
  });
  got = checkAchievements(runCtx({ meta })).map(a => a.id);
  assert.ok(got.includes('fashionista'));

  // выданное второй раз не выдаётся
  const again = checkAchievements(runCtx({ meta })).map(a => a.id);
  assert.ok(!again.includes('fashionista'));
});

test('achievements: медальные наборы (all-gold-novice, worldcup-all)', () => {
  freshAch();
  const medals = {};
  for (const st of [1, 2, 3, 4, 5]) medals[`c:novice:${st}`] = 3;
  const meta = emptyMeta();
  for (let i = 0; i < 6; i++) meta.rosettePaid[`wcq:w:${i}`] = 1;
  const got = checkAchievements(runCtx({ meta, medals })).map(a => a.id);
  assert.ok(got.includes('all-gold-novice'));
  assert.ok(got.includes('worldcup-all'));
});

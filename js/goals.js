// Витрина целей «Питомник» (S4, п.10): единый список того, ради чего играть
// дальше — ачивки, косметика, боссы, задания, уровни собак, медальные наборы.
// Модуль чистый: без DOM, без localStorage, без побочных эффектов — состояние
// приходит аргументом, наружу отдаётся только описание целей.
//
// Референс — Vampire Survivors: игрок в любой момент видит «во что играть
// дальше» и три ближайшие цели на post-run экране.

import { ACHIEVEMENTS, METRIC_UNITS, metricValue } from './achievements.js';
import { ITEMS, priceOf, SLOT_NAMES } from './cosmetics.js';
import { BOSSES, SEASONS } from './career.js';
import { questDef } from './quests.js';
import { TITLES } from './meta.js';

// ---------- Разделы витрины ----------
export const GOAL_SECTIONS = [
  { kind: 'quest',       title: 'Задания' },
  { kind: 'boss',        title: 'Боссы' },
  { kind: 'achievement', title: 'Достижения' },
  { kind: 'cosmetic',    title: 'Косметика' },
  { kind: 'level',       title: 'Уровни собак' },
  { kind: 'medal',       title: 'Медали' },
];

// ---------- Стоимость усилия ----------
// Всё меряем в одной валюте — «сколько прогонов примерно осталось». Так цель
// на 60% из 10 обманок (осталось 4 ≈ 8 прогонов) честно сравнивается с целью
// на 90% из 2500 снарядов (осталось 250 ≈ 17 прогонов).
// Коэффициенты = средний прирост метрики за один прогон (обратная величина).
const RUNS_PER_UNIT = {
  obstacles: 1 / 15,  // ~15 снарядов на трассе
  perfects:  1 / 10,  // ~10 идеальных нажатий за прогон
  quals:     2,       // Q примерно раз в два прогона
  fakeouts:  2,       // обманки редки
  breeds:    1,       // новая порода — один прогон
  streak:    3,       // день серии стоит дороже прогона: его не «доиграть»
  bones:     1 / 60,  // ~60 🦴 за прогон
  owned:     8,       // предмет ≈ 500 🦴
};
const BONES_PER_RUN = 60;
const RUNS_PER_ROSETTE = 10;   // розетки капают только с вех
const RUNS_PER_LEVEL = 2;
const RUNS_PER_GOLD = 3;       // золото на этапе карьеры

// Бинарные цели (без счётчика) не имеют «остатка» — им назначается ровная
// оценка усилия по типу, чтобы они не проваливались в конец и не всплывали
// наверх, а честно конкурировали где-то в середине.
const BINARY_RUNS = { achievement: 6, boss: 4, cosmetic: 5, quest: 3, level: 5, medal: 4 };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function goal({ id, kind, icon, name, desc, current, target, done, hint, effort, meta }) {
  const bin = !(target > 0);
  const cur = done ? (bin ? 1 : Math.min(current, target)) : (bin ? 0 : Math.max(0, current));
  const progress = done ? 1 : bin ? 0 : clamp01(cur / target);
  return {
    id, kind,
    icon: icon || '•',
    name,
    desc: desc || '',
    current: bin ? (done ? 1 : 0) : cur,
    target: bin ? null : target,
    done: !!done,
    progress,
    hint: hint || desc || '',
    // effort — оценка «сколько прогонов осталось»; поле служебное, по нему
    // ранжируются ближайшие цели, UI его показывать не обязан.
    effort: done ? 0 : Math.max(0, effort ?? BINARY_RUNS[kind] ?? 5),
    ...(meta ? { meta } : {}),
  };
}

const plural = (n, unit) => `${n} ${unit || ''}`.trim();

// ---------- Сборщики по разделам ----------
function achievementGoals(meta, ach) {
  return ACHIEVEMENTS.map((a) => {
    const done = !!ach[a.id];
    if (a.metric && a.target > 0) {
      const cur = metricValue(a.metric, meta);
      const left = Math.max(0, a.target - cur);
      const unit = METRIC_UNITS[a.metric] || '';
      return goal({
        id: `ach:${a.id}`, kind: 'achievement', icon: a.icon, name: a.name, desc: a.desc,
        current: cur, target: a.target, done,
        hint: done ? a.desc : `${plural(cur, '')}/${plural(a.target, unit)} — осталось ${left}`,
        effort: left * (RUNS_PER_UNIT[a.metric] ?? 1),
        meta: { achId: a.id, metric: a.metric },
      });
    }
    return goal({
      id: `ach:${a.id}`, kind: 'achievement', icon: a.icon, name: a.name, desc: a.desc,
      current: 0, target: null, done, hint: a.desc, meta: { achId: a.id },
    });
  });
}

function cosmeticHint(price, meta) {
  const parts = [];
  if (price.bones) parts.push(`${price.bones} 🦴`);
  if (price.rosettes) parts.push(`${price.rosettes} 🏵️`);
  const lackB = Math.max(0, (price.bones || 0) - (meta.bones || 0));
  const lackR = Math.max(0, (price.rosettes || 0) - (meta.rosettes || 0));
  if (!lackB && !lackR) return `${parts.join(' + ')} — хватает, можно забрать`;
  const lack = [];
  if (lackB) lack.push(`${lackB} 🦴`);
  if (lackR) lack.push(`${lackR} 🏵️`);
  return `${parts.join(' + ')} — не хватает ${lack.join(' + ')}`;
}

function cosmeticGoals(meta) {
  const owned = meta.owned || {};
  return ITEMS.map((it) => {
    const price = priceOf(it);
    const done = !!owned[it.id];
    // Прогресс — по основной валюте предмета: сколько уже накоплено.
    const byBones = !!price.bones;
    const target = byBones ? price.bones : (price.rosettes || 1);
    const current = byBones ? (meta.bones || 0) : (meta.rosettes || 0);
    // Усилие — полная цена в прогонах: балансом можно распорядиться иначе,
    // поэтому «уже накопленное» скидывает цель, но не обнуляет её.
    const full = (price.bones || 0) / BONES_PER_RUN + (price.rosettes || 0) * RUNS_PER_ROSETTE;
    const lackB = Math.max(0, (price.bones || 0) - (meta.bones || 0));
    const lackR = Math.max(0, (price.rosettes || 0) - (meta.rosettes || 0));
    const left = lackB / BONES_PER_RUN + lackR * RUNS_PER_ROSETTE;
    return goal({
      id: `cosmetic:${it.id}`, kind: 'cosmetic', icon: '🎀',
      name: it.name, desc: SLOT_NAMES[it.slot] || 'Косметика',
      current, target, done,
      hint: done ? 'В коллекции' : cosmeticHint(price, meta),
      effort: Math.max(0.5, left || full * 0.25),
      meta: { itemId: it.id, slot: it.slot, price },
    });
  });
}

function bossGoals(meta) {
  const bosses = meta.bosses || {};
  return Object.entries(BOSSES).map(([cls, b]) => {
    const done = !!bosses[cls];
    const season = SEASONS[cls];
    return goal({
      id: `boss:${cls}`, kind: 'boss', icon: '👻',
      name: `${b.name} — ${season ? season.name : cls}`,
      desc: b.intro,
      current: 0, target: null, done,
      hint: done ? 'Побеждён' : `Обгони призрака в классе ${season ? season.name : cls} с квалификацией`,
      meta: { cls, bossId: b.id },
    });
  });
}

function questGoals(meta) {
  const q = meta.quests || {};
  const out = [];
  for (const [list, tag] of [[q.daily, 'день'], [q.weekly, 'неделя']]) {
    for (const st of list || []) {
      const def = questDef(st.id);
      if (!def) continue;
      const cur = Math.min(st.progress || 0, def.target);
      const left = Math.max(0, def.target - cur);
      out.push(goal({
        id: `quest:${st.id}`, kind: 'quest', icon: '📋',
        name: def.name, desc: `Задание (${tag})`,
        current: cur, target: def.target, done: !!st.done,
        hint: st.done ? `Готово · +${def.bones} 🦴` : `${cur}/${def.target} · +${def.bones} 🦴`,
        effort: left / Math.max(1, def.target) * (tag === 'день' ? 2 : 6),
        meta: { questId: st.id, scope: tag },
      }));
    }
  }
  return out;
}

function levelGoals(meta) {
  const milestones = [...TITLES].map(t => t.level).sort((a, b) => a - b);
  const out = [];
  for (const breedId of Object.keys(meta.dogs || {}).sort()) {
    const d = meta.dogs[breedId] || {};
    const level = d.level || 1;
    const next = milestones.find(m => m > level);
    if (!next) continue;
    const title = TITLES.find(t => t.level === next);
    out.push(goal({
      id: `level:${breedId}:${next}`, kind: 'level', icon: '🎖️',
      name: `Титул ${title ? title.tag : next} · ${breedId}`,
      desc: title ? title.name : `Уровень ${next}`,
      current: level, target: next, done: false,
      hint: `Уровень ${level}/${next} — ещё ${next - level} уровней`,
      effort: (next - level) * RUNS_PER_LEVEL,
      meta: { breedId, level },
    }));
  }
  return out;
}

const MEDAL_CLASSES = ['novice', 'open', 'excellent', 'masters'];
const STAGES = [1, 2, 3, 4, 5];

function medalGoals(medals) {
  return MEDAL_CLASSES.map((cls) => {
    const golds = STAGES.filter(st => (medals[`c:${cls}:${st}`] || 0) >= 3).length;
    const season = SEASONS[cls];
    return goal({
      id: `medal:${cls}`, kind: 'medal', icon: '🥇',
      name: `Золото: ${season ? season.name : cls}`,
      desc: `Все 5 этапов класса на золото`,
      current: golds, target: STAGES.length, done: golds >= STAGES.length,
      hint: `${golds}/${STAGES.length} этапов на 🥇`,
      effort: (STAGES.length - golds) * RUNS_PER_GOLD,
      meta: { cls },
    });
  });
}

// ---------- Публичное API ----------

// state: { meta, ach = {}, medals = {} }
// meta — объект из loadMeta(), ach — карта из loadAch(), medals — agility_medals.
// Возвращает единый плоский список целей; порядок стабильный (по разделам).
export function collectGoals(state = {}) {
  const meta = state.meta || {};
  const ach = state.ach || {};
  const medals = state.medals || {};
  const byKind = {
    quest: questGoals(meta),
    boss: bossGoals(meta),
    achievement: achievementGoals(meta, ach),
    cosmetic: cosmeticGoals(meta),
    level: levelGoals(meta),
    medal: medalGoals(medals),
  };
  return GOAL_SECTIONS.flatMap(s => byKind[s.kind] || []);
}

// n ближайших НЕвыполненных целей.
// «Ближайшая» = минимальное оставшееся усилие (effort, в прогонах), а не
// максимальная доля прогресса. Тай-брейк по id — порядок не прыгает между
// кадрами. maxPerKind разбавляет подборку: три косметики подряд читаются как
// «иди в магазин», а не как «во что играть дальше».
export function nearestGoals(goals, n = 3, opts = {}) {
  const maxPerKind = opts.maxPerKind ?? 2;
  const pool = (goals || []).filter(g => !g.done)
    .slice()
    .sort((a, b) => (a.effort - b.effort) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = [];
  const used = {};
  for (const g of pool) {
    if (out.length >= n) break;
    const k = g.kind || '_';
    if ((used[k] || 0) >= maxPerKind) continue;
    used[k] = (used[k] || 0) + 1;
    out.push(g);
  }
  // добор, если квоты по разделам не дали набрать n
  if (out.length < n) {
    for (const g of pool) {
      if (out.length >= n) break;
      if (!out.includes(g)) out.push(g);
    }
  }
  return out;
}

// Разбивка для экрана-витрины: секции в фиксированном порядке, пустые опущены.
export function groupGoals(goals) {
  const out = [];
  for (const s of GOAL_SECTIONS) {
    const list = (goals || []).filter(g => g.kind === s.kind);
    if (!list.length) continue;
    out.push({
      kind: s.kind, title: s.title, goals: list,
      total: list.length,
      done: list.filter(g => g.done).length,
    });
  }
  return out;
}

// Сводка «сколько всего собрано» — для шапки экрана.
export function goalsSummary(goals) {
  const total = (goals || []).length;
  const done = (goals || []).filter(g => g.done).length;
  return { total, done, percent: total ? done / total : 0 };
}

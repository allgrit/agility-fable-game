// Задания: 3 daily из пула по сиду даты (сброс в полночь), 2 weekly по сиду
// ISO-недели (сброс в понедельник). Прогресс в agility_meta.quests.

export const DAILY_POOL = [
  { id: 'runs3',    name: 'Пройди 3 трассы',            target: 3,  bones: 50, ev: 'run' },
  { id: 'perf20',   name: '20 идеальных нажатий',        target: 20, bones: 40, ev: 'perfect' },
  { id: 'clean1',   name: 'Чистый прогон (Q)',           target: 1,  bones: 50, ev: 'clean' },
  { id: 'combo10',  name: 'Комбо ×10 за один забег',     target: 1,  bones: 40, ev: 'combo10' },
  { id: 'daily1',   name: 'Пробеги трассу дня',          target: 1,  bones: 60, ev: 'daily' },
  { id: 'obst25',   name: 'Пройди 25 снарядов',          target: 25, bones: 40, ev: 'obstacle' },
  { id: 'medal1',   name: 'Возьми любую медаль',         target: 1,  bones: 40, ev: 'medal' },
  { id: 'tunnel6',  name: '6 туннелей за день',          target: 6,  bones: 40, ev: 'tunnel' },
];

export const WEEKLY_POOL = [
  { id: 'wcleans5', name: '5 чистых прогонов за неделю', target: 5,  bones: 150, rosettes: 1, ev: 'clean' },
  { id: 'wruns12',  name: '12 трасс за неделю',          target: 12, bones: 120, rosettes: 1, ev: 'run' },
  { id: 'wgold2',   name: '2 золотые медали',            target: 2,  bones: 150, rosettes: 2, ev: 'gold' },
  { id: 'wdaily3',  name: '3 трассы дня за неделю',      target: 3,  bones: 120, rosettes: 1, ev: 'daily' },
];

function seededPick(pool, count, seed) {
  const src = [...pool];
  const out = [];
  let s = seed >>> 0;
  for (let i = 0; i < count && src.length; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push(src.splice(s % src.length, 1)[0]);
  }
  return out;
}

export function isoWeek(d = new Date()) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return `${dt.getUTCFullYear()}-W${Math.ceil((((dt - y0) / 86400000) + 1) / 7)}`;
}

// Обновляет/инициализирует активные задания в meta.quests по текущей дате.
export function refreshQuests(meta, dayKey, dayNum) {
  const q = meta.quests;
  if (q.day !== dayKey) {
    q.day = dayKey;
    q.daily = seededPick(DAILY_POOL, 3, dayNum * 7919 + 3)
      .map(t => ({ id: t.id, progress: 0, done: false, claimed: false }));
  }
  const wk = isoWeek();
  if (q.week !== wk) {
    q.week = wk;
    const wkNum = Number(wk.replace(/\D/g, ''));
    q.weekly = seededPick(WEEKLY_POOL, 2, wkNum * 104729 + 17)
      .map(t => ({ id: t.id, progress: 0, done: false, claimed: false }));
  }
}

export function questDef(id) {
  return DAILY_POOL.find(t => t.id === id) || WEEKLY_POOL.find(t => t.id === id);
}

// events: { run, clean, perfect, obstacle, combo10, daily, medal, gold, tunnel } — счётчики за прогон
export function applyRunToQuests(meta, events) {
  const completedNow = [];
  for (const list of [meta.quests.daily, meta.quests.weekly]) {
    for (const st of list || []) {
      if (st.done) continue;
      const def = questDef(st.id);
      if (!def) continue;
      const inc = events[def.ev] || 0;
      if (!inc) continue;
      st.progress = Math.min(def.target, st.progress + inc);
      if (st.progress >= def.target) {
        st.done = true;
        completedNow.push(def);
      }
    }
  }
  return completedNow;
}

// Выдача наград за выполненные (авто-клейм)
export function claimDone(meta) {
  let bones = 0, rosettes = 0;
  for (const list of [meta.quests.daily, meta.quests.weekly]) {
    for (const st of list || []) {
      if (st.done && !st.claimed) {
        const def = questDef(st.id);
        st.claimed = true;
        bones += def.bones || 0;
        rosettes += def.rosettes || 0;
      }
    }
  }
  // Бонус «все 3 daily»
  const d = meta.quests.daily || [];
  if (meta.quests.dailyBonus && meta.quests.dailyBonus !== meta.quests.day) {
    meta.quests.dailyBonus = null; // сброс метки прошлого дня ДО проверки
  }
  if (d.length === 3 && d.every(s => s.done) && !meta.quests.dailyBonus) {
    meta.quests.dailyBonus = meta.quests.day;
    bones += 50;
  }
  // Бонус «обе weekly»
  const wl = meta.quests.weekly || [];
  if (meta.quests.weeklyBonus && meta.quests.weeklyBonus !== meta.quests.week) {
    meta.quests.weeklyBonus = null;
  }
  if (wl.length === 2 && wl.every(s => s.done) && !meta.quests.weeklyBonus) {
    meta.quests.weeklyBonus = meta.quests.week;
    bones += 50;
  }
  meta.bones += bones;
  meta.rosettes += rosettes;
  return { bones, rosettes };
}

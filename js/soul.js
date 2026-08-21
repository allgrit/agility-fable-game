// S3 «Душа собаки»: комментатор ринга, темпераменты пород, idle-жизнь в меню,
// досье собаки. Чистая логика без DOM — тестируется в node.

// ---------- КОММЕНТАТОР ----------
// Радио-строка в стиле трансляции Crufts. Триггеры приходят из забега,
// комментатор сам решает, стоит ли говорить (кулдаун + приоритет) и что именно.
// Реплики — шаблоны с плейсхолдерами {dog} {n} {t} {ghost} {obst}.
export const COMMENTARY = {
  // Старт: первые секунды забега
  start: [
    'И вот на линии — {dog}. Трибуны замерли.',
    'Судья даёт отмашку. {dog} на старте, хвост как метроном.',
    'Тишина на ринге. Только дыхание собаки и стук сердца хендлера.',
    '{dog} выходит на дорожку. Помните это имя.',
  ],
  // Чистая зона: несколько снарядов подряд без штрафа
  cleanZone: [
    'Чисто! Пока ни одной планки на траве.',
    'Ни одной ошибки — судья только успевает кивать.',
    'Идут по нотам: {n} снарядов, {n} чистых.',
    'Обратите внимание на линии: ни одного лишнего движения.',
    'Хендлер даже не повышает голос — они читают друг друга.',
  ],
  // Серия перфектов
  streak: [
    'Три идеальных подряд! Это уже заявка.',
    'Собака поймала ритм — и ринг поймал вместе с ней.',
    'Вот она, та самая связка, ради которой сюда приезжают.',
    'Комбо ×{n}! Трибуны встают.',
  ],
  // Штраф
  fault: [
    'Ох! Планка на траве. Пять штрафных.',
    'Досадно. Такое бывает даже у чемпионов.',
    'Судья поднимает руку — есть ошибка.',
    'Планка качнулась… и упала. Обидно, очень обидно.',
    'Ничего, дистанция ещё длинная.',
  ],
  // Отказ
  refusal: [
    'Отказ! Собака не поняла посыл хендлера.',
    'Промах на заходе — придётся перестраиваться.',
    'Здесь потеряли темп. Судья фиксирует отказ.',
  ],
  // Контактная зона взята идеально
  contact: [
    'Лапа точно в жёлтую зону — судья доволен.',
    'Идеальный контакт! Ни сантиметра мимо.',
    'Вот как надо сходить с контактного снаряда.',
  ],
  // Слалом
  weave: [
    'Слалом как по учебнику — двенадцать стоек в один ритм.',
    'Смотрите на плечи: собака ведёт корпусом, а не головой.',
    'Такой слалом ставится годами.',
  ],
  golden: [
    'GOLDEN WEAVE! Двенадцать из двенадцати идеально! Ринг сходит с ума!',
    'Двенадцать безупречных стоек! Это войдёт в нарезку года!',
  ],
  // Против призрака
  ghostAhead: [
    '{dog} впереди графика {ghost} на {t}с!',
    'Темп быстрее, чем у {ghost}. Рекорд ринга под угрозой!',
    'Секундомер на нашей стороне: {t}с преимущества.',
  ],
  ghostBehind: [
    '{ghost} пока быстрее — отставание {t}с.',
    'График уходит. Нужно добирать на контактных.',
    'Отстаём на {t}с, но всё решает финишная прямая.',
  ],
  // Риск
  risk: [
    'Они идут на риск! Ва-банк на этом снаряде!',
    'Заявка риска — смелое решение при таком счёте.',
  ],
  // Рекорд ринга (лучше личного рекорда по времени)
  record: [
    'Это темп рекорда ринга! Держите секундомеры наготове.',
    'Быстрее, чем всё, что мы видели сегодня на этой дорожке.',
    'Если так добегут — новый рекорд трассы.',
  ],
  // Финишный спурт
  sprint: [
    'Последний снаряд позади — финишная прямая!',
    'Ускоряются! Всё решится на этих метрах!',
    'Хендлер уже кричит на весь ринг — вперёд!',
  ],
  // Финиш
  finishClean: [
    'ЧИСТО! Квалификация! {dog} — {t}с и ни одного штрафа!',
    'Табло молчит — ни одной ошибки. Это классика жанра!',
    'Чистый прогон за {t}с! Трибуны на ногах!',
  ],
  finishFault: [
    'Финиш. Ошибки были, но характер — на месте.',
    'Не сегодня. Но эта собака ещё вернётся на эту дорожку.',
    'Есть над чем работать — и есть с чем работать.',
  ],
  // Церемония
  podium: [
    'Розетка отправляется на ошейник. Заслуженно!',
    'Подиум! Аплодисменты этой паре!',
    'Хендлер на коленях, собака на тумбе — вот ради этого всё и затевалось.',
  ],
};

// Приоритеты: чем выше, тем важнее — перебивает кулдаун слабой реплики.
const PRIORITY = {
  golden: 5, finishClean: 5, finishFault: 5, podium: 5,
  fault: 4, refusal: 4, record: 4, sprint: 4,
  ghostAhead: 3, ghostBehind: 3, risk: 3, streak: 3,
  cleanZone: 2, contact: 2, weave: 2, start: 2,
};

function fill(tpl, ctx = {}) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (ctx[k] !== undefined ? String(ctx[k]) : ''));
}

// Комментатор ринга: держит кулдаун, не повторяет недавние реплики,
// пропускает слабые триггеры, пока звучит важный.
export class Commentator {
  constructor({ cooldown = 4.5, memory = 8 } = {}) {
    this.cooldown = cooldown;
    this.memory = memory;          // сколько последних реплик не повторять
    this.recent = [];
    this.line = null;              // текущая реплика {text, t, life}
    this.silent = 0;               // сек до следующей возможной реплики
    this._cursor = {};             // ротация внутри пула
  }

  update(dt) {
    if (this.silent > 0) this.silent -= dt;
    if (this.line) {
      this.line.t += dt;
      if (this.line.t > this.line.life) this.line = null;
    }
  }

  // Возвращает текст, если реплика прозвучала, иначе null.
  say(trigger, ctx = {}) {
    const pool = COMMENTARY[trigger];
    if (!pool || !pool.length) return null;
    const prio = PRIORITY[trigger] || 1;
    // Пока идёт кулдаун — говорим только о важном (приоритет 4+)
    if (this.silent > 0 && prio < 4) return null;
    // Не перебиваем реплику того же или большего веса, если она только началась
    if (this.line && this.line.prio > prio && this.line.t < 1.2) return null;
    // Ротация: берём первый не звучавший недавно вариант
    let text = null;
    const start = this._cursor[trigger] ?? 0;
    for (let k = 0; k < pool.length; k++) {
      const i = (start + k) % pool.length;
      const candidate = fill(pool[i], ctx);
      if (!this.recent.includes(candidate)) {
        text = candidate;
        this._cursor[trigger] = (i + 1) % pool.length;
        break;
      }
    }
    if (!text) { // все варианты недавно звучали — берём следующий по кругу
      const i = start % pool.length;
      text = fill(pool[i], ctx);
      this._cursor[trigger] = (i + 1) % pool.length;
    }
    this.recent.push(text);
    if (this.recent.length > this.memory) this.recent.shift();
    this.line = { text, t: 0, life: Math.max(2.4, Math.min(4.5, text.length * 0.055)), prio, trigger };
    this.silent = this.cooldown;
    return text;
  }

  current() { return this.line ? this.line.text : null; }
}

// Сколько всего реплик в банке (для тестов и статистики)
export function commentaryCount() {
  return Object.values(COMMENTARY).reduce((s, arr) => s + arr.length, 0);
}

// ---------- ТЕМПЕРАМЕНТЫ ПОРОД ----------
// Чистая косметика: ни одна черта не трогает окна реакции, скорость и очки.
// quirk — уникальная выходка, показывается в конкретной фазе забега.
export const TEMPERAMENTS = {
  border: {
    trait: 'Нетерпеливый', desc: 'Приседает на старте от нетерпения — работа для неё праздник.',
    quirk: 'crouch',      // фаза countdown: приседает и подёргивает лапами
    favIdle: 'tailChase',
  },
  sheltie: {
    trait: 'Церемонная', desc: 'Перед стартом делает поклон-потягушку, как на выставке.',
    quirk: 'bow',         // фаза countdown: поклон
    favIdle: 'yawn',
  },
  jack: {
    trait: 'Артист', desc: 'После финиша драматично падает на бок — публика в восторге.',
    quirk: 'faint',       // фаза finished: «падает» на бок
    favIdle: 'scratch',
  },
  aussie: {
    trait: 'Задира', desc: 'Лает на призрака-соперника — Хлоя не признаёт чужих на своём ринге.',
    quirk: 'barkGhost',   // при появлении/обгоне призрака: лай
    favIdle: 'tailChase',
  },
  poodle: {
    trait: 'Шоумен', desc: 'После чистого прогона крутит пируэт — шоу должно продолжаться.',
    quirk: 'pirouette',   // фаза finished при чистом прогоне
    favIdle: 'yawn',
  },
};

export function temperamentFor(breedId) {
  return TEMPERAMENTS[breedId] || { trait: 'Спокойный', desc: 'Ровный характер без выходок.', quirk: null, favIdle: 'scratch' };
}

// ---------- IDLE-ЖИЗНЬ В МЕНЮ ----------
// Автомат состояний собаки на карточке: по таймеру уходит в короткую выходку
// и возвращается в покой. 30с без ввода — засыпает; смена окраса — встряхивается.
export const IDLE_STATES = {
  idle:      { dur: [3.5, 7.0] },
  scratch:   { dur: [1.8, 2.6] },
  yawn:      { dur: [1.4, 2.0] },
  tailChase: { dur: [2.0, 3.0] },
  shake:     { dur: [0.9, 1.1] },
  sleep:     { dur: [999, 999] },
};
const IDLE_POOL = ['scratch', 'yawn', 'tailChase'];
export const SLEEP_AFTER = 30; // сек бездействия до сна

export class IdleMachine {
  constructor(rnd = Math.random) {
    this.rnd = rnd;
    this.state = 'idle';
    this.t = 0;
    this.dur = 4;
    this.favIdle = null;   // любимая выходка породы выпадает чаще
  }

  // idleSec — сколько игрок не трогает ввод; force — принудительное состояние
  update(dt, { idleSec = 0 } = {}) {
    this.t += dt;
    // Сон: наступает независимо от текущей выходки, но не перебивает встряхивание
    if (idleSec >= SLEEP_AFTER && this.state !== 'sleep' && this.state !== 'shake') {
      this.set('sleep');
      return this.state;
    }
    if (this.state === 'sleep') {
      if (idleSec < SLEEP_AFTER) this.set('idle');
      return this.state;
    }
    if (this.t < this.dur) return this.state;
    this.set(this.state === 'idle' ? this._pickQuirk() : 'idle');
    return this.state;
  }

  _pickQuirk() {
    // Любимая выходка породы — вдвое вероятнее прочих
    const pool = this.favIdle ? [...IDLE_POOL, this.favIdle] : IDLE_POOL;
    return pool[Math.floor(this.rnd() * pool.length)];
  }

  set(state) {
    const def = IDLE_STATES[state] || IDLE_STATES.idle;
    this.state = state;
    this.t = 0;
    this.dur = def.dur[0] + this.rnd() * (def.dur[1] - def.dur[0]);
  }

  // Прогресс текущего состояния 0..1 — для анимаций рендера
  progress() { return Math.max(0, Math.min(1, this.t / this.dur)); }
}

// ---------- ДОСЬЕ СОБАКИ ----------
export const OBSTACLE_NAMES = {
  jump: 'барьер', tire: 'шина', wall: 'стена', broad: 'длинный прыжок',
  tunnel: 'туннель', weave: 'слалом', aframe: 'горка', dogwalk: 'бум',
  seesaw: 'качели', table: 'стол', spread: 'двойной барьер',
  triple: 'тройной барьер', serpentine: 'серпантин',
};

// Любимый снаряд = наибольшая доля перфектов при значимой выборке (>= 3 попыток).
export function favoriteObstacle(stats) {
  let best = null, bestRate = -1;
  for (const [type, s] of Object.entries(stats || {})) {
    if (!s || (s.seen || 0) < 3) continue;
    const rate = (s.perfect || 0) / s.seen;
    if (rate > bestRate || (rate === bestRate && best && s.seen > (stats[best].seen || 0))) {
      bestRate = rate; best = type;
    }
  }
  if (!best || bestRate <= 0) return null;
  return { type: best, name: OBSTACLE_NAMES[best] || best, rate: bestRate };
}

// Накопление статистики снарядов в meta (для досье): { type: {seen, perfect} }
export function recordObstacleStats(meta, marks) {
  const st = meta.counters.obstacleStats || (meta.counters.obstacleStats = {});
  for (const m of marks || []) {
    const type = m.o?.type;
    if (!type) continue;
    const a = st[type] || (st[type] = { seen: 0, perfect: 0 });
    a.seen++;
    if (m.qte?.result?.grade === 'perfect') a.perfect++;
  }
  return st;
}

// Лучшее время собаки: храним в meta.counters.bestTime[breedId]
export function recordBestTime(meta, breedId, timeSec, clean) {
  if (!clean) return false;
  const bt = meta.counters.bestTime || (meta.counters.bestTime = {});
  if (bt[breedId] == null || timeSec < bt[breedId]) {
    bt[breedId] = +timeSec.toFixed(2);
    return true;
  }
  return false;
}

// Кличка: у Хлои — своя, у остальных пород по умолчанию имя породы.
export function dogName(meta, breed) {
  const custom = meta?.dogs?.[breed.id]?.name;
  return (custom && String(custom).trim()) || breed.name;
}

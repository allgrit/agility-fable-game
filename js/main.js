// Точка входа: меню → забег → результаты. Input, HUD, игровой цикл.
import { generateCourse, CLASSES } from './course.js';
import { BREEDS, finalScore, nextClass, CLASS_ORDER } from './scoring.js';
import { AudioEngine } from './audio.js';
import { Particles } from './particles.js';
import { Renderer } from './render.js';
import { Run } from './game.js';
import { QTE_DEFS } from './qte.js';
import { REAL_COURSES, realToCourse } from './courses.js';
import { ACHIEVEMENTS, loadAch, hasAch, checkAchievements } from './achievements.js';
import { pickTheme, THEMES } from './themes.js';
import { loadMeta, saveMeta, earnFromRun, earnXp, rosettesForLevels, dogState,
  titleFor, xpToNext, streakMult, grantRosette } from './meta.js';
import { ITEMS, RARITY, SLOT_NAMES, itemById, priceOf, dailyShowcase, applyEquip } from './cosmetics.js';
import { refreshQuests, applyRunToQuests, claimDone, questDef } from './quests.js';

// Service worker: свежая версия при каждом деплое без ручной очистки кеша.
// При смене контролирующего SW (не первой установке) — тихая перезагрузка.
if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === '127.0.0.1' || location.hostname === 'localhost')) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });
}

const canvas = document.getElementById('game');
const renderer = new Renderer(canvas);
const audio = new AudioEngine();
const fx = new Particles();

const STAGES = 5; // трасс в каждом классе карьеры

const app = {
  state: 'menu',           // menu | run | results | board
  breedIdx: 0,
  cls: localStorage.getItem('agility_class') || 'novice', // прогресс карьеры
  stage: Number(localStorage.getItem('agility_stage') || 1), // 1..STAGES
  run: null,
  result: null,
  mode: 'career',          // career | worldcup (реальные трассы) | daily (трасса дня)
  realIdx: 0,
  t: 0,
  bestPoints: Number(localStorage.getItem('agility_best') || 0),
};

function careerSeed(cls, stage) {
  return (CLASS_ORDER.indexOf(cls) + 1) * 1000 + stage * 37 + 11;
}

// ---------- ЛИДЕРБОРД (localStorage) ----------
function loadBoard() {
  try { return JSON.parse(localStorage.getItem('agility_board') || '[]'); }
  catch { return []; }
}
function saveRunToBoard(run, res) {
  const board = loadBoard();
  board.push({
    ts: Date.now(),
    breed: run.breed.name,
    cls: run.course.class.name,
    course: run.course.name || 'Трасса',
    mode: app.mode,
    time: +run.time.toFixed(2),
    faults: res.totalFaults,
    stars: res.stars,
    points: res.points,
    clean: res.clean,
  });
  board.sort((a, b) => b.points - a.points);
  board.length = Math.min(board.length, 20);
  localStorage.setItem('agility_board', JSON.stringify(board));
}
function saveProgress() {
  localStorage.setItem('agility_class', app.cls);
  localStorage.setItem('agility_stage', String(app.stage));
}

// ---------- МОДИФИКАТОРЫ-ИСПЫТАНИЯ (трасса дня) ----------
const MODIFIERS = {
  none:   { name: '', mult: 1 },
  rain:   { name: '🌧 Дождь — окна реакции уже', mult: 1.3, windowMul: 0.85 },
  dusk:   { name: '🌆 Сумерки — зона видна в последний момент', mult: 1.4 },
  strict: { name: '⚖ Строгий судья — 3 отказа = дисквалификация', mult: 1.5 },
};
function dailyModifier() {
  return ['none', 'rain', 'dusk', 'strict'][Math.floor(todayNum() / 3) % 4];
}
function activeModifier() {
  return app.mode === 'daily' ? dailyModifier() : 'none';
}

// ---------- ТРАССА ДНЯ ----------
function todayStr() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}
function todayNum() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
function dailyCls() { return ['open', 'excellent', 'masters'][todayNum() % 3]; }
function dailyBest() {
  try {
    const b = JSON.parse(localStorage.getItem('agility_daily') || 'null');
    return b && b.date === todayStr() ? b.points : null;
  } catch { return null; }
}
function saveDailyBest(points) {
  const cur = dailyBest();
  if (cur == null || points > cur) {
    localStorage.setItem('agility_daily', JSON.stringify({ date: todayStr(), points }));
    return true;
  }
  return false;
}

// ---------- МЕДАЛИ (лучшие звёзды за трассу) ----------
const MEDAL_ICON = { 4: '💎', 3: '🥇', 2: '🥈', 1: '🥉' };
function loadMedals() {
  try { return JSON.parse(localStorage.getItem('agility_medals') || '{}'); }
  catch { return {}; }
}
function courseKey() {
  if (app.mode === 'daily') return `d:${todayStr()}`;
  if (app.mode === 'worldcup') return `w:${app.realIdx % REAL_COURSES.length}`;
  return `c:${app.cls}:${app.stage}`;
}
function recordMedal(stars) {
  if (stars < 1) return false;
  const m = loadMedals();
  const key = courseKey();
  if ((m[key] || 0) >= stars) return false;
  m[key] = stars;
  localStorage.setItem('agility_medals', JSON.stringify(m));
  return true;
}
function medalCounts() {
  const m = loadMedals();
  const c = { 3: 0, 2: 0, 1: 0 };
  for (const v of Object.values(m)) if (c[v] !== undefined) c[v]++;
  return c;
}

const breedList = Object.values(BREEDS);
const breedLocked = (b) => b.unlockAch && !hasAch(b.unlockAch);
const toasts = []; // {icon, name, desc, t}
const CHLOE_URL = 'https://vk.com/chloe.myaussie'; // дневник аусси Хлои — прототипа персонажа
// Мета-прогрессия: единое состояние валют/XP/заданий
const meta = loadMeta();
{
  const d = new Date();
  refreshQuests(meta, d.toDateString(), d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate());
  saveMeta(meta);
}
function openChloe() {
  audio.click();
  window.open(CHLOE_URL, '_blank', 'noopener');
}

// DPR-рендер: чёткая картинка на ретине; все hit-тесты в canvas-координатах.
const DPR = Math.min(2, window.devicePixelRatio || 1);
function resize() {
  const vw = window.visualViewport?.width || window.innerWidth;
  const vh = window.visualViewport?.height || window.innerHeight;
  canvas.width = Math.round(vw * DPR);
  canvas.height = Math.round(vh * DPR);
}
window.addEventListener('resize', resize);
window.visualViewport?.addEventListener('resize', resize);
resize();

const isPortrait = () => canvas.height > canvas.width;
function evXY(e) {
  // Точный маппинг тапа в canvas-пиксели: CSS-размер канваса может расходиться
  // с visualViewport (iOS-панели, зум) — фиксированный DPR давал смещение вниз экрана.
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (canvas.width / r.width),
    y: (e.clientY - r.top) * (canvas.height / r.height),
  };
}

// ---------- УПРАВЛЕНИЕ ----------
const KEYS = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window
  || location.search.includes('touch');

audio.setMuted(localStorage.getItem('agility_muted') === '1');
function toggleMute() {
  audio.setMuted(!audio.muted);
  localStorage.setItem('agility_muted', audio.muted ? '1' : '0');
}

// Виртуальные тач-кнопки: компактный D-pad слева, «ХОП» (Space) справа.
// Радиус масштабируется от ширины, чтобы всё влезало на узких телефонах.
function touchButtons() {
  const w = canvas.width, h = canvas.height;
  // Радиус под палец: на узких высоких экранах опираемся на ширину.
  const u = Math.max(Math.min(w * 0.095, h * 0.06), Math.min(w, h) * 0.055);
  // Выше от кромки: iOS Safari-панель и жест «домой» не должны накрывать пад.
  const cx = u * 2.3, cy = h - u * 4.6;
  return [
    { code: 'ArrowUp',    x: cx,            y: cy - u * 1.18, r: u, label: '↑', hotLabel: 'ВЕРХ' },
    { code: 'ArrowDown',  x: cx,            y: cy + u * 1.18, r: u, label: '↓', hotLabel: 'НИЗ' },
    { code: 'ArrowLeft',  x: cx - u * 1.18, y: cy,            r: u, label: '←', hotLabel: 'ЛЕВО' },
    { code: 'ArrowRight', x: cx + u * 1.18, y: cy,            r: u, label: '→', hotLabel: 'ПРАВО' },
    { code: 'Space', x: w - u * 2.0, y: h - u * 4.2, r: u * 1.45, label: 'ХОП', hotLabel: 'ХОП' },
  ];
}
const touchPointers = new Map(); // pointerId → key code

function muteZone() {
  const z = Math.min(canvas.width, canvas.height) / 700;
  return { x: canvas.width - 34 * z, y: 130 * z, r: 26 * z };
}

function trophyZone() {
  const z = Math.min(canvas.width, canvas.height) / 700;
  return { x: canvas.width - 34 * z, y: 195 * z, r: 26 * z };
}

function shopZone() {
  const z = Math.min(canvas.width, canvas.height) / 700;
  return { x: canvas.width - 34 * z, y: 325 * z, r: 26 * z };
}
function questsZone() {
  const z = Math.min(canvas.width, canvas.height) / 700;
  return { x: canvas.width - 34 * z, y: 390 * z, r: 26 * z };
}

// Полноэкранный режим (недоступен на iPhone — там прячем кнопку).
const FS_SUPPORTED = !!(document.documentElement.requestFullscreen);
function fsZone() {
  const z = Math.min(canvas.width, canvas.height) / 700;
  return { x: canvas.width - 34 * z, y: 260 * z, r: 26 * z };
}
function toggleFullscreen() {
  if (!FS_SUPPORTED) return;
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
window.addEventListener('keydown', (e) => {
  if (KEYS.includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  audio.ensure();
  if (e.code === 'KeyM') return toggleMute();
  if (e.code === 'KeyL' && app.state !== 'run') {
    app.state = app.state === 'board' ? 'menu' : 'board';
    audio.click();
    return;
  }
  if (e.code === 'KeyB' && app.state !== 'run') {
    app.state = app.state === 'shop' ? 'menu' : 'shop';
    audio.click();
    return;
  }
  if (e.code === 'KeyJ' && app.state !== 'run') {
    app.state = app.state === 'quests' ? 'menu' : 'quests';
    audio.click();
    return;
  }
  if (app.state === 'board' || app.state === 'shop' || app.state === 'quests') {
    if (e.code === 'Escape' || e.code === 'Enter') { app.state = 'menu'; audio.click(); }
    return;
  }
  if (app.state === 'menu') return menuKey(e.code);
  if (app.state === 'results') return resultsKey(e.code);
  if (app.state === 'run') {
    // Финиш разминки: любой ввод завершает онбординг и запускает настоящий старт
    if (app.run?.warmup && app.run.phase === 'finished') {
      localStorage.setItem('agility_onboarded', '1');
      return startRun();
    }
    if (e.code === 'Escape') return toMenu();
    if (e.code === 'KeyR') return startRun();
    app.run.input(e.code, true);
  }
});
window.addEventListener('keyup', (e) => {
  if (app.state === 'run') app.run.input(e.code, false);
});
// iOS: гасим системные жесты — выделение, лупу, контекстное меню, двойной тап.
canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  audio.ensure();
  const p = evXY(e);
  const mz = muteZone();
  if (Math.hypot(p.x - mz.x, p.y - mz.y) < mz.r) { toggleMute(); return; }
  if (FS_SUPPORTED) {
    const fz = fsZone();
    if (Math.hypot(p.x - fz.x, p.y - fz.y) < fz.r) { toggleFullscreen(); return; }
  }
  if (app.state === 'run') {
    if (app.run?.warmup && app.run.phase === 'finished') {
      localStorage.setItem('agility_onboarded', '1');
      startRun();
      return;
    }
    // Магнит: тап засчитывается ближайшей кнопке в расширенной зоне —
    // промах пальца на пару миллиметров не должен глотать ввод.
    let best = null, bestD = Infinity;
    for (const b of touchButtons()) {
      const dd = Math.hypot(p.x - b.x, p.y - b.y);
      if (dd < bestD) { bestD = dd; best = b; }
    }
    if (best && bestD <= best.r * 2.4) {
      touchPointers.set(e.pointerId, best.code);
      app.run.input(best.code, true);
    }
    return;
  }
  if (app.state === 'board' || app.state === 'quests') { app.state = 'menu'; audio.click(); return; }
  if (app.state === 'shop') {
    if (!handleShopTap(p)) { app.state = 'menu'; audio.click(); }
    return;
  }
  const tz = trophyZone();
  if (app.state === 'menu' && Math.hypot(p.x - tz.x, p.y - tz.y) < tz.r) {
    app.state = 'board'; audio.click(); return;
  }
  const sz = shopZone();
  if (app.state === 'menu' && Math.hypot(p.x - sz.x, p.y - sz.y) < sz.r) {
    app.state = 'shop'; audio.click(); return;
  }
  const qz = questsZone();
  if (app.state === 'menu' && Math.hypot(p.x - qz.x, p.y - qz.y) < qz.r) {
    app.state = 'quests'; audio.click(); return;
  }
  const inZone = (zz) => zz && p.x >= zz.x && p.x <= zz.x + zz.w && p.y >= zz.y && p.y <= zz.y + zz.h;
  if (app.state === 'menu' && inZone(app.chloeZoneMenu)) return openChloe();
  // Кнопки-стрелки переключателя режима
  if (app.state === 'menu' && app.modeArrows) {
    const { left, right } = app.modeArrows;
    if (Math.hypot(p.x - left.x, p.y - left.y) <= left.r) return menuKey('ArrowUp');
    if (Math.hypot(p.x - right.x, p.y - right.y) <= right.r) return menuKey('ArrowDown');
  }
  if (app.state === 'menu') menuClick(p.x, p.y);
  else if (app.state === 'results') {
    // Секвенция ещё идёт — первый тап всегда скип
    if (app.run && app.run.finishT < 3.4) { app.run.finishT = 3.4; audio.click(); return; }
    if (inZone(app.chloeZoneResults)) return openChloe();
    if (IS_TOUCH) {
      const w2 = canvas.width, h2 = canvas.height;
      const z2 = Math.min(w2, h2) / 700;
      const pw2 = Math.min(520 * z2, w2 * 0.9), ph2 = Math.min(570 * z2, h2 * 0.88);
      const px2 = w2 / 2 - pw2 / 2, py2 = h2 / 2 - ph2 / 2;
      const pad = 8 * z2; // запас хит-зоны под палец
      for (const b of resultsButtons(px2, py2, pw2, ph2, z2)) {
        if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) {
          audio.click();
          if (b.id === 'next') return resultsKey('Enter');
          if (b.id === 'retry') return resultsKey('KeyR');
          if (b.id === 'share') return shareResult();
          if (b.id === 'menu') return resultsKey('Escape');
        }
      }
      return; // тап мимо кнопок — ничего (не случайный рестарт)
    }
    resultsKey('Enter');
  }
});
function releaseTouch(e) {
  const code = touchPointers.get(e.pointerId);
  if (code) {
    touchPointers.delete(e.pointerId);
    if (app.state === 'run') app.run.input(code, false);
  }
}
canvas.addEventListener('pointerup', releaseTouch);
canvas.addEventListener('pointercancel', releaseTouch);

function menuKey(code) {
  if (code === 'ArrowLeft') { app.breedIdx = (app.breedIdx + breedList.length - 1) % breedList.length; audio.click(); }
  if (code === 'ArrowRight') { app.breedIdx = (app.breedIdx + 1) % breedList.length; audio.click(); }
  if (code === 'ArrowUp' || code === 'ArrowDown') {
    const modes = ['career', 'worldcup', 'daily'];
    const dir = code === 'ArrowUp' ? -1 : 1;
    app.mode = modes[(modes.indexOf(app.mode) + dir + modes.length) % modes.length];
    audio.click();
  }
  if (code === 'Enter' || code === 'Space') startRun();
  if (code.startsWith('Digit')) {
    const n = +code.slice(5) - 1;
    if (n >= 0 && n < breedList.length) { app.breedIdx = n; audio.click(); }
  }
}

function menuClick(x, y) {
  const w = canvas.width, h = canvas.height;
  const n = breedList.length;
  if (isPortrait()) {
    const top = h * 0.36, cardH = h * 0.082, gap = h * 0.008;
    for (let i = 0; i < n; i++) {
      const cy = top + i * (cardH + gap);
      if (y > cy && y < cy + cardH && Math.abs(x - w / 2) < w * 0.44) {
        if (app.breedIdx === i) startRun(); else { app.breedIdx = i; audio.click(); }
        return;
      }
    }
    if (y > h * 0.82) startRun();
    if (y < h * 0.29) menuKey('ArrowDown');
    return;
  }
  const L = app.menuLayout || { cardsTop: h * 0.38, cardH: h * 0.34, cardW: Math.min(195, w * 0.178) };
  const cardW = L.cardW;
  for (let i = 0; i < n; i++) {
    const cx = w / 2 + (i - (n - 1) / 2) * (cardW + 14);
    if (Math.abs(x - cx) < cardW / 2 && y > L.cardsTop && y < L.cardsTop + L.cardH) {
      if (app.breedIdx === i) startRun(); else { app.breedIdx = i; audio.click(); }
      return;
    }
  }
  if (y > h * 0.76) startRun();
  if (y < h * 0.3) menuKey('ArrowDown');
}

function resultsKey(code) {
  // Первый инпут во время секвенции = скип к финальному состоянию протокола
  if (app.run && app.run.finishT < 3.4 && code !== 'Escape') {
    app.run.finishT = 3.4;
    audio.click();
    return;
  }
  if (code === 'KeyS') return shareResult();
  if (code === 'Enter' || code === 'Space') {
    if (app.mode === 'career') {
      if (app.result && app.result.qualified) {
        app.stage++;
        if (app.stage > STAGES) {
          if (app.cls !== 'masters') { app.cls = nextClass(app.cls); app.stage = 1; }
          else app.stage = STAGES; // карьера пройдена — фармим медали Masters
        }
        saveProgress();
      }
      // не квалифицировались — та же трасса ещё раз
    } else if (app.mode === 'worldcup') {
      app.realIdx = (app.realIdx + 1) % REAL_COURSES.length;
    }
    startRun();
  }
  if (code === 'KeyR') startRun();
  if (code === 'Escape') toMenu();
}

function toMenu() { app.state = 'menu'; app.run = null; audio.crowdLevel(0); }

function startRun() {
  const breed = breedList[app.breedIdx];
  if (breedLocked(breed)) {
    const a = ACHIEVEMENTS.find(x => x.id === breed.unlockAch);
    toasts.push({ icon: '🔒', name: breed.name, desc: `Открой: ${a?.desc || ''}`, t: 0 });
    audio.miss();
    return;
  }
  // Первый запуск: разминка во «Дворе» — 3 снаряда, провалить нельзя
  if (!localStorage.getItem('agility_onboarded')) return startWarmup();
  let course;
  if (app.mode === 'worldcup' && REAL_COURSES.length) {
    course = realToCourse(REAL_COURSES[app.realIdx % REAL_COURSES.length]);
  } else if (app.mode === 'daily') {
    course = generateCourse(todayNum() * 13 + 7, dailyCls());
    course.name = `Трасса дня ${todayStr()}`;
  } else {
    // Прогрессия внутри Novice: 1-2 — только прыжки, 3-4 — + слалом, 5 — + горка (превью Open).
    const variant = app.cls === 'novice'
      ? { weave: app.stage >= 3, contacts: app.stage >= 5 ? 1 : 0 }
      : {};
    course = generateCourse(careerSeed(app.cls, app.stage), app.cls, variant);
    course.name = `${CLASSES[app.cls].name} · трасса ${app.stage}/${STAGES}`;
  }
  const mod = MODIFIERS[activeModifier()];
  renderer.theme = pickTheme({ mode: app.mode, stage: app.stage, modifier: activeModifier() });
  const dressed = applyEquip(breed, dogState(meta, breed.id).equip, meta.owned);
  app.run = new Run({ course, breed: dressed, audio, particles: fx, renderer,
    modifier: activeModifier(), windowMul: mod.windowMul || 1 });
  renderer.cam.x = course.start.x;
  renderer.cam.y = course.start.y;
  app.state = 'run';
  app.result = null;
  audio.crowdLevel(0.15);
}

// Онбординг: «Двор» — jump, jump, tunnel с гигантскими окнами; miss = мягкий повтор.
function startWarmup() {
  const course = generateCourse(4242, 'novice', {});
  course.obstacles = course.obstacles.slice(0, 3);
  // Состав строго jump → jump → tunnel: сначала одна кнопка, потом вторая
  const setType = (o, type, len) => {
    o.type = type; o.len = len;
    o.exit = { x: o.entry.x + Math.cos(o.angle) * len, y: o.entry.y + Math.sin(o.angle) * len };
    o.x = (o.entry.x + o.exit.x) / 2; o.y = (o.entry.y + o.exit.y) / 2;
  };
  if (course.obstacles[0].type !== 'jump') setType(course.obstacles[0], 'jump', 0.4);
  if (course.obstacles[1].type !== 'jump') setType(course.obstacles[1], 'jump', 0.4);
  const t3 = course.obstacles[2];
  if (t3.type !== 'tunnel') setType(t3, 'tunnel', 5.0);
  course.finish = {
    x: t3.exit.x + Math.cos(t3.angle) * 5,
    y: t3.exit.y + Math.sin(t3.angle) * 5,
  };
  course.pathPoints = [course.start];
  for (const o of course.obstacles) course.pathPoints.push(o.entry, o.exit);
  course.pathPoints.push(course.finish);
  course.name = 'Разминка во дворе';
  renderer.theme = THEMES.day;
  app.run = new Run({ course, breed: breedList[app.breedIdx], audio, particles: fx, renderer,
    windowMul: 1.9 });
  app.run.warmup = true; // мягкий режим: без фолтов, с повторами
  renderer.cam.x = course.start.x;
  renderer.cam.y = course.start.y;
  app.state = 'run';
  app.result = null;
  audio.crowdLevel(0.1);
}

// ---------- HUD ----------
function drawHud(run) {
  const ctx = renderer.ctx, w = canvas.width;
  const z = Math.min(w, canvas.height) / 700;

  // Разминка: чистый экран без панелей — только суть. Финал — приглашение на старт.
  if (run.warmup) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(18 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText('🐾 Разминка во дворе', w / 2, 30 * z);
    if (run.phase === 'finished' && run.finishT > 0.8) {
      ctx.fillStyle = 'rgba(6,12,10,0.6)';
      ctx.fillRect(0, 0, w, canvas.height);
      ctx.font = `900 ${Math.round(38 * z)}px "Segoe UI", sans-serif`;
      ctx.fillStyle = '#ffd54a';
      ctx.fillText('Ты готов к соревнованиям!', w / 2, canvas.height * 0.42);
      ctx.font = `bold ${Math.round(20 * z)}px "Segoe UI", sans-serif`;
      ctx.fillStyle = Math.sin(app.t * 4) > -0.3 ? '#fff' : 'rgba(255,255,255,0.4)';
      ctx.fillText(IS_TOUCH ? 'Тап — на старт!' : 'Любая клавиша — на старт!', w / 2, canvas.height * 0.5);
    }
    ctx.restore();
    const wm = run.activeMark;
    if (wm && wm.qte && wm.qte.state === 'active' && run.phase === 'running') drawQte(run, wm, z);
    if (IS_TOUCH) drawTouchControls(run);
    return;
  }

  // Верхняя панель: снаряды, время, фолты, комбо
  ctx.save();
  ctx.font = `bold ${Math.round(22 * z)}px "Segoe UI", sans-serif`;
  panel(ctx, 14, 14, 300 * z, 88 * z);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const done = run.marks.filter(m => m.resolved).length;
  ctx.fillText(`Снаряд ${Math.min(done + 1, run.marks.length)}/${run.marks.length}`, 30, 26 * z);
  const overSct = run.time > run.sct;
  ctx.fillStyle = overSct ? '#ff6b6b' : '#c8f7d0';
  ctx.fillText(`${run.time.toFixed(1)}с / SCT ${run.sct}с`, 30, 56 * z);
  ctx.restore();

  ctx.save();
  panel(ctx, w - 230 * z - 14, 14, 230 * z, 88 * z);
  ctx.font = `bold ${Math.round(22 * z)}px "Segoe UI", sans-serif`;
  ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillStyle = run.score.faults ? '#ff8a8a' : '#fff';
  ctx.fillText(`Фолты: ${run.score.faults}`, w - 30, 26 * z);
  const combo = Math.floor(run.score.combo);
  ctx.fillStyle = combo >= 3 ? '#ffd54a' : '#cfd8dc';
  ctx.fillText(combo > 0 ? `Комбо ×${combo}` : 'Комбо —', w - 30, 56 * z);
  ctx.restore();

  // Класс и порода (в портрете — под панелями, чтобы не наезжать)
  ctx.save();
  ctx.font = `${Math.round(15 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.textAlign = 'center';
  const cname = run.course.name || run.course.class.name;
  const modName = MODIFIERS[run.modifier]?.name;
  ctx.fillText(`${cname} · ${breedList[app.breedIdx].name}`, w / 2, (isPortrait() ? 118 : 22) * z);
  if (modName) {
    ctx.fillStyle = '#ffab6b';
    ctx.fillText(modName, w / 2, (isPortrait() ? 140 : 44) * z);
  }
  ctx.restore();

  // Ритуал старта: тишина, стойка, «На старт…» — затем взрывное «ВПЕРЁД!»
  if (run.phase === 'countdown' || (run.phase === 'running' && run.time < 0.6)) {
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const isGo = run.phase === 'running';
    ctx.font = `900 ${Math.round((isGo ? 110 : 44) * z)}px "Segoe UI", sans-serif`;
    ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    const txt = isGo ? 'ВПЕРЁД!' : 'На старт…';
    ctx.strokeText(txt, w / 2, canvas.height * 0.4);
    ctx.fillStyle = isGo ? '#ffd54a' : 'rgba(255,255,255,0.85)';
    ctx.fillText(txt, w / 2, canvas.height * 0.4);
    ctx.restore();
  }

  // Обучающая подсказка (slow-mo при первой встрече механики).
  // Многострочный баннер: на узких экранах текст переносится, а не вылезает.
  if (run.hintText) {
    ctx.save();
    ctx.textAlign = 'center';
    // На клавиатуре подсказки говорят клавишами, на таче — именами кнопок
    const hint = IS_TOUCH ? run.hintText
      : run.hintText.replace('ЛЕВО и ПРАВО', '← и →').replace(/ВЕРХ/g, '↑').replace(/ХОП/g, 'ПРОБЕЛ');
    const fs = Math.round((isPortrait() ? 19 : 24) * z);
    ctx.font = `900 ${fs}px "Segoe UI", sans-serif`;
    const maxW = w * 0.86;
    const lines = [];
    let line = '';
    for (const word of hint.split(' ')) {
      const probe = line ? line + ' ' + word : word;
      if (ctx.measureText(probe).width > maxW && line) { lines.push(line); line = word; }
      else line = probe;
    }
    if (line) lines.push(line);
    const lh = fs * 1.35;
    const bw = Math.min(maxW, Math.max(...lines.map(l => ctx.measureText(l).width))) + 44 * z;
    const bh = lines.length * lh + 26 * z;
    const hy = canvas.height * 0.3;
    ctx.fillStyle = 'rgba(10,18,14,0.88)';
    ctx.strokeStyle = '#ffd54a'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(w / 2 - bw / 2, hy - bh / 2, bw, bh, 14 * z);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffd54a';
    lines.forEach((l, i) => {
      ctx.fillText(l, w / 2, hy - bh / 2 + 22 * z + i * lh + fs * 0.35);
    });
    ctx.restore();
  }

  // QTE-индикатор
  const m = run.activeMark;
  if (m && m.qte && m.qte.state === 'active' && run.phase === 'running') drawQte(run, m, z);

  if (IS_TOUCH) drawTouchControls(run);
}

function expectedKey(run) {
  const m = run?.activeMark;
  if (!m || !m.qte || m.qte.state !== 'active') return null;
  if (m.decoys && !m.decoys.revealed) return null; // не палим кнопку до раскрытия
  const q = m.qte, d = q.def;
  if (d.kind === 'rhythm') return d.keys[q.beatIdx % 2];
  if (d.kind === 'twoStage') return q.stage === 1 ? d.key2 : d.key;
  return d.key;
}

function drawTouchControls(run) {
  const ctx = renderer.ctx;
  const hot = expectedKey(run);
  // «Когда жать»: в окне нажатия мигание учащается и кнопка вспыхивает целиком.
  let urgency = 0; // 0 — просто ожидается, 1 — good-окно, 2 — perfect
  const m = run?.activeMark;
  if (m && m.qte && m.qte.state === 'active' && m.qte.def.kind === 'press') {
    const v = Math.max(run.dog.speed, 0.5);
    const dd = m.entryD - TAKEOFF_UI - run.dog.dist;
    if (Math.abs(dd) <= m.qte.w * 0.28 * v) urgency = 2;
    else if (Math.abs(dd) <= m.qte.w * 0.6 * v) urgency = 1;
  }
  const t = run?.time ?? app.t;
  for (const b of touchButtons()) {
    const active = touchPointers.size && [...touchPointers.values()].includes(b.code);
    const isHot = b.code === hot;
    const blinkHz = urgency === 2 ? 14 : urgency === 1 ? 8 : 4;
    const blinkOn = Math.sin(t * blinkHz * Math.PI) > -0.2;
    // Ожидаемая кнопка увеличивается и показывает слово-команду вместо стрелки.
    const r = b.r * (isHot ? 1.12 : 1);
    const label = isHot ? b.hotLabel : b.label;
    ctx.save();
    // Плотный фон — кнопки не должны тонуть в толпе и траве.
    const flash = isHot && urgency === 2 && blinkOn;
    ctx.fillStyle = active || flash ? 'rgba(255,213,74,0.9)'
      : isHot ? 'rgba(20,34,24,0.95)' : 'rgba(8,16,12,0.88)';
    ctx.strokeStyle = isHot ? (blinkOn ? '#ffd54a' : 'rgba(255,255,255,0.5)') : 'rgba(255,255,255,0.7)';
    ctx.lineWidth = isHot && blinkOn ? 7 : 3;
    if (isHot && blinkOn) { ctx.shadowColor = '#ffd54a'; ctx.shadowBlur = urgency === 2 ? 26 : 14; }
    ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = active || flash ? '#1a1a1a' : isHot ? '#ffd54a' : '#fff';
    ctx.font = `900 ${Math.round(r * (label.length > 2 ? 0.4 : label.length > 1 ? 0.48 : 0.85))}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, b.x, b.y + 2);
    ctx.restore();
  }
}

// ---------- КАРТА КАРЬЕРЫ ----------
// 4 класса × 5 трасс: медаль = пройдена, номер = впереди, ▶ = текущая позиция.
function drawCareerMap(ctx, cx, y, z, portrait) {
  const medals = loadMedals();
  const curClsIdx = CLASS_ORDER.indexOf(app.cls);
  // В портрете — только строка текущего класса, в landscape — все 4 в 2 колонки.
  const classes = portrait ? [app.cls] : CLASS_ORDER;
  const cellW = 300 * z;
  const rowH = 19 * z;
  ctx.save();
  ctx.font = `${Math.round(portrait ? 13 * z : 14 * z)}px "Segoe UI", sans-serif`;
  classes.forEach((cls, i) => {
    const ci = CLASS_ORDER.indexOf(cls);
    const col = portrait ? 0 : i % 2, row = portrait ? 0 : Math.floor(i / 2);
    const rx = portrait ? cx - 110 * z : cx - cellW + col * cellW + 16 * z;
    const ry = y + row * rowH;
    const locked = ci > curClsIdx;
    ctx.textAlign = 'left';
    ctx.fillStyle = locked ? 'rgba(255,255,255,0.35)' : ci === curClsIdx ? '#ffe082' : 'rgba(255,255,255,0.85)';
    ctx.fillText(CLASSES[cls].name.padEnd(9), rx, ry);
    for (let s = 1; s <= STAGES; s++) {
      const sx = rx + (86 + (s - 1) * 26) * z;
      const stars = medals[`c:${cls}:${s}`] || 0;
      const isCur = ci === curClsIdx && s === app.stage;
      if (isCur) {
        ctx.fillStyle = '#ffd54a';
        const pulse = 1 + Math.sin(app.t * 5) * 0.15;
        ctx.font = `bold ${Math.round((portrait ? 13 : 15) * z * pulse)}px "Segoe UI", sans-serif`;
        ctx.fillText(stars ? MEDAL_ICON[stars] : '▶', sx, ry);
        ctx.font = `${Math.round(portrait ? 12 * z : 14 * z)}px "Segoe UI", sans-serif`;
      } else if (stars) {
        ctx.fillText(MEDAL_ICON[Math.min(4, stars)], sx, ry);
      } else {
        ctx.fillStyle = locked ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.45)';
        ctx.fillText(locked ? '🔒' : '○', sx, ry);
        ctx.fillStyle = locked ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.85)';
      }
    }
  });
  ctx.restore();
}

// ---------- МАГАЗИН / ГАРДЕРОБ ----------
function drawShop() {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;
  ctx.save();
  ctx.fillStyle = 'rgba(6,12,10,0.85)';
  ctx.fillRect(0, 0, w, h);
  const pw = Math.min(680 * z, w * 0.96), ph = Math.min(600 * z, h * 0.94);
  const px = w / 2 - pw / 2, py = h / 2 - ph / 2;
  panel(ctx, px, py, pw, ph);
  const breed = breedList[app.breedIdx];
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd54a';
  ctx.font = `900 ${Math.round(24 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(`🛍 Магазин · Гардероб (${breed.name})`, w / 2, py + 34 * z);
  ctx.font = `${Math.round(15 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = '#ffe9a8';
  ctx.fillText(`Баланс: 🦴 ${meta.bones} · 🏵️ ${meta.rosettes}   ·   тап: купить / надеть / снять`, w / 2, py + 58 * z);

  const dnum = (new Date().getFullYear()) * 10000 + (new Date().getMonth() + 1) * 100 + new Date().getDate();
  const showcase = dailyShowcase(dnum);
  const cols = isPortrait() ? 2 : 4;
  const cw = (pw - 32 * z) / cols, chh = 62 * z;
  const equip = dogState(meta, breed.id).equip;
  app.shopCells = [];
  ITEMS.forEach((it, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = px + 16 * z + col * cw, y = py + 76 * z + row * (chh + 6 * z);
    if (y + chh > py + ph - 40 * z) return;
    const owned = !!meta.owned[it.id];
    const equipped = owned && equip[it.slot] === it.id;
    const onSale = showcase.includes(it.id);
    const rc = { common: '#9e9e9e', rare: '#4fc3f7', epic: '#b388ff', legendary: '#ffd54a' }[it.rarity];
    ctx.fillStyle = equipped ? 'rgba(60,90,60,0.9)' : 'rgba(16,28,22,0.9)';
    ctx.strokeStyle = rc; ctx.lineWidth = equipped ? 3 : 1.5;
    ctx.beginPath(); ctx.roundRect(x, y, cw - 8 * z, chh, 8 * z); ctx.fill(); ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(12.5 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(it.name.slice(0, 22), x + 8 * z, y + 17 * z);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = `${Math.round(10.5 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(`${SLOT_NAMES[it.slot]}${it.breed ? ' · ' + (BREEDS[it.breed]?.name || '') : ''}`, x + 8 * z, y + 31 * z);
    ctx.font = `bold ${Math.round(12 * z)}px "Segoe UI", sans-serif`;
    if (equipped) { ctx.fillStyle = '#9ff0b4'; ctx.fillText('✓ Надето', x + 8 * z, y + 49 * z); }
    else if (owned) { ctx.fillStyle = '#8fd8ff'; ctx.fillText('Куплено — надеть', x + 8 * z, y + 49 * z); }
    else {
      const pr = priceOf(it);
      const cost = pr.rosettes && !pr.bones ? `${pr.rosettes} 🏵️` : `${Math.round(pr.bones * (onSale ? 0.7 : 1))} 🦴`;
      ctx.fillStyle = onSale ? '#ffd54a' : '#ffe9a8';
      ctx.fillText(`${cost}${onSale ? '  −30%!' : ''}`, x + 8 * z, y + 49 * z);
    }
    app.shopCells.push({ x, y, w: cw - 8 * z, h: chh, id: it.id });
  });
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = `${Math.round(14 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('B / ESC / тап мимо — назад', w / 2, py + ph - 18 * z);
  ctx.restore();
}

function handleShopTap(p) {
  for (const c of app.shopCells || []) {
    if (p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) {
      const it = itemById(c.id);
      const breed = breedList[app.breedIdx];
      const equip = dogState(meta, breed.id).equip;
      if (meta.owned[it.id]) {
        if (it.slot === 'coat' && it.breed && it.breed !== breed.id) {
          toasts.push({ icon: '🚫', name: 'Не подходит', desc: 'Этот окрас для другой породы', t: 0 });
        } else if (equip[it.slot] === it.id) {
          delete equip[it.slot];
          audio.click();
        } else {
          equip[it.slot] = it.id;
          audio.good();
        }
      } else {
        const dnum = (new Date().getFullYear()) * 10000 + (new Date().getMonth() + 1) * 100 + new Date().getDate();
        const sale = dailyShowcase(dnum).includes(it.id);
        const pr = priceOf(it);
        const bonesCost = pr.bones ? Math.round(pr.bones * (sale ? 0.7 : 1)) : 0;
        if (pr.rosettes && !pr.bones) {
          if (meta.rosettes >= pr.rosettes) {
            meta.rosettes -= pr.rosettes; meta.owned[it.id] = 1;
            toasts.push({ icon: '🛍', name: 'Куплено!', desc: it.name, t: 0 });
            audio.perfect();
          } else { toasts.push({ icon: '🏵️', name: 'Не хватает розеток', desc: `Нужно ${pr.rosettes}`, t: 0 }); audio.miss(); }
        } else if (meta.bones >= bonesCost) {
          meta.bones -= bonesCost; meta.owned[it.id] = 1;
          toasts.push({ icon: '🛍', name: 'Куплено!', desc: it.name, t: 0 });
          audio.perfect();
        } else { toasts.push({ icon: '🦴', name: 'Не хватает косточек', desc: `Нужно ${bonesCost}`, t: 0 }); audio.miss(); }
      }
      saveMeta(meta);
      return true;
    }
  }
  return false;
}

// ---------- ЗАДАНИЯ ----------
function drawQuests() {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;
  ctx.save();
  ctx.fillStyle = 'rgba(6,12,10,0.85)';
  ctx.fillRect(0, 0, w, h);
  const pw = Math.min(560 * z, w * 0.94), ph = Math.min(480 * z, h * 0.9);
  const px = w / 2 - pw / 2, py = h / 2 - ph / 2;
  panel(ctx, px, py, pw, ph);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd54a';
  ctx.font = `900 ${Math.round(24 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('📋 Задания', w / 2, py + 36 * z);

  const row = (st, y) => {
    const def = questDef(st.id);
    if (!def) return;
    ctx.textAlign = 'left';
    ctx.fillStyle = st.done ? '#9ff0b4' : '#fff';
    ctx.font = `bold ${Math.round(15 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(`${st.done ? '✓ ' : ''}${def.name}`, px + 28 * z, y);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(st.done ? `+${def.bones} 🦴${def.rosettes ? ` +${def.rosettes} 🏵️` : ''}`
      : `${st.progress}/${def.target}`, px + pw - 28 * z, y);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(px + 28 * z, y + 7 * z, pw - 56 * z, 5 * z);
    ctx.fillStyle = st.done ? '#69f0ae' : '#ffd54a';
    ctx.fillRect(px + 28 * z, y + 7 * z, (pw - 56 * z) * Math.min(1, st.progress / def.target), 5 * z);
  };
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `${Math.round(13 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('СЕГОДНЯ (сброс в полночь)', px + 28 * z, py + 66 * z);
  (meta.quests.daily || []).forEach((st, i) => row(st, py + (92 + i * 44) * z));
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `${Math.round(13 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('НЕДЕЛЯ (сброс в понедельник)', px + 28 * z, py + 240 * z);
  (meta.quests.weekly || []).forEach((st, i) => row(st, py + (266 + i * 44) * z));

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffe9a8';
  ctx.font = `${Math.round(14 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(`Все 3 дневных = +50 🦴 бонусом · Баланс: 🦴 ${meta.bones} · 🏵️ ${meta.rosettes}`, w / 2, py + ph - 44 * z);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText('J / ESC / тап — назад', w / 2, py + ph - 18 * z);
  ctx.restore();
}

// ---------- ЭКРАН ЛИДЕРБОРДА ----------
function drawBoard() {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;
  ctx.save();
  ctx.fillStyle = 'rgba(6,12,10,0.82)';
  ctx.fillRect(0, 0, w, h);
  const board = loadBoard();
  const pw = Math.min(640 * z, w * 0.94), ph = Math.min(560 * z, h * 0.9);
  const px = w / 2 - pw / 2, py = h / 2 - ph / 2;
  panel(ctx, px, py, pw, ph);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd54a';
  ctx.font = `900 ${Math.round(30 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('🏆 ЛУЧШИЕ ПРОГОНЫ', w / 2, py + 44 * z);

  if (!board.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = `${Math.round(19 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText('Пока пусто — пробеги первую трассу!', w / 2, py + ph / 2);
  } else {
    const rows = Math.min(board.length, isPortrait() ? 5 : 7);
    const rowH = Math.min(36 * z, (ph - 280 * z) / rows);
    ctx.font = `${Math.round(14 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.textAlign = 'left';
    ctx.fillText('#  Очки', px + 24 * z, py + 78 * z);
    ctx.fillText('Время / Фолты', px + pw * 0.32, py + 78 * z);
    ctx.fillText('Собака · Трасса', px + pw * 0.55, py + 78 * z);
    for (let i = 0; i < rows; i++) {
      const e = board[i];
      const ry = py + 100 * z + i * rowH;
      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(px + 12 * z, ry - rowH * 0.62, pw - 24 * z, rowH * 0.9);
      }
      ctx.fillStyle = i === 0 ? '#ffd54a' : i < 3 ? '#ffe9a8' : '#e8f5ec';
      ctx.font = `${i < 3 ? 'bold ' : ''}${Math.round(16 * z)}px "Segoe UI", sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillText(`${i + 1}. ${e.points}${e.clean ? ' ★Q' : ''}`, px + 24 * z, ry);
      ctx.fillText(`${e.time.toFixed(1)}с / ${e.faults}ф`, px + pw * 0.32, ry);
      const label = `${e.breed} · ${e.cls} · ${e.course}`;
      ctx.fillText(label.length > 42 ? label.slice(0, 41) + '…' : label, px + pw * 0.55, ry);
    }
  }
  // Достижения: сетка под таблицей
  const ach = loadAch();
  const cols = isPortrait() ? 2 : 5;
  const cellW = (pw - 40 * z) / cols;
  const startY = py + ph - 26 * z - Math.ceil(ACHIEVEMENTS.length / cols) * 34 * z - 16 * z;
  ctx.textAlign = 'left';
  ACHIEVEMENTS.forEach((a, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const ax = px + 24 * z + col * cellW;
    const ay = startY + row * 34 * z;
    const got = !!ach[a.id];
    ctx.globalAlpha = got ? 1 : 0.35;
    ctx.font = `${Math.round(17 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.fillText(got ? a.icon : '🔒', ax, ay);
    ctx.fillStyle = got ? '#ffe9a8' : 'rgba(255,255,255,0.6)';
    ctx.font = `${Math.round(11 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(a.name, ax + 24 * z, ay - 4 * z);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = `${Math.round(9 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(a.desc.slice(0, 30), ax + 24 * z, ay + 8 * z);
  });
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = `${Math.round(16 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('L / ESC / тап — назад', w / 2, py + ph - 26 * z);
  ctx.restore();
}

// Тосты достижений: правый нижний угол, 3.5 сек
function drawToasts(dt) {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;
  let y = h - 90 * z - (IS_TOUCH ? 240 * z : 0);
  for (const t of toasts) {
    t.t = (t.t || 0) + dt;
    const alpha = t.t < 0.3 ? t.t / 0.3 : t.t > 3.0 ? Math.max(0, 1 - (t.t - 3.0) / 0.5) : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    const tw = 250 * z;
    ctx.fillStyle = 'rgba(16,28,20,0.92)';
    ctx.strokeStyle = '#ffd54a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(w - tw - 16 * z, y - 30 * z, tw, 58 * z, 12 * z);
    ctx.fill(); ctx.stroke();
    ctx.textAlign = 'left';
    ctx.font = `${Math.round(24 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(t.icon, w - tw - 2 * z, y + 3 * z);
    ctx.fillStyle = '#ffd54a';
    ctx.font = `bold ${Math.round(14 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(t.name, w - tw + 32 * z, y - 8 * z);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `${Math.round(11 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(t.desc.slice(0, 38), w - tw + 32 * z, y + 10 * z);
    ctx.restore();
    y -= 70 * z;
  }
  for (let i = toasts.length - 1; i >= 0; i--) if (toasts[i].t > 3.5) toasts.splice(i, 1);
}

function drawTrophyIcon() {
  const ctx = renderer.ctx;
  ctx.save();
  ctx.globalAlpha = 0.8;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const qDone = (meta.quests.daily || []).filter(q => q.done).length;
  for (const [zone, icon, badge] of [
    [trophyZone(), '🏆', null],
    [shopZone(), '🛍', null],
    [questsZone(), '📋', qDone < 3 ? `${qDone}/3` : '✓'],
  ]) {
    ctx.fillStyle = 'rgba(10,20,15,0.55)';
    ctx.beginPath(); ctx.arc(zone.x, zone.y, zone.r, 0, Math.PI * 2); ctx.fill();
    ctx.font = `${Math.round(zone.r * 1.05)}px "Segoe UI", sans-serif`;
    ctx.fillText(icon, zone.x, zone.y + 2);
    if (badge) {
      ctx.font = `bold ${Math.round(zone.r * 0.55)}px "Segoe UI", sans-serif`;
      ctx.fillStyle = badge === '✓' ? '#9ff0b4' : '#ffd54a';
      ctx.fillText(badge, zone.x, zone.y + zone.r + 9);
    }
  }
  ctx.restore();
}

function drawMuteIcon() {
  const ctx = renderer.ctx;
  const mz = muteZone();
  ctx.save();
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = 'rgba(10,20,15,0.55)';
  ctx.beginPath(); ctx.arc(mz.x, mz.y, mz.r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = audio.muted ? '#ff8a8a' : '#fff';
  ctx.font = `${Math.round(mz.r * 1.1)}px "Segoe UI", sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(audio.muted ? '🔇' : '🔊', mz.x, mz.y + 2);
  if (FS_SUPPORTED) {
    const fz = fsZone();
    ctx.fillStyle = 'rgba(10,20,15,0.55)';
    ctx.beginPath(); ctx.arc(fz.x, fz.y, fz.r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.round(fz.r * 1.0)}px "Segoe UI", sans-serif`;
    ctx.fillText(document.fullscreenElement ? '⤢' : '⛶', fz.x, fz.y + 2);
  }
  ctx.restore();
}

function panel(ctx, x, y, w, h) {
  ctx.fillStyle = 'rgba(12,24,18,0.62)';
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 14); ctx.fill(); ctx.stroke();
}

// На таче Space — это кнопка «ХОП», подсказки должны говорить её именем.
const KEY_LABEL = IS_TOUCH
  ? { Space: 'ХОП', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }
  : { Space: 'ПРОБЕЛ', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };

function drawQte(run, m, z) {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const def = m.qte.def, q = m.qte;
  const t = run.time - m.qteStart;
  let cy = h - 130 * z;
  if (IS_TOUCH) {
    const topOfButtons = Math.min(...touchButtons().map(b => b.y - b.r));
    cy = topOfButtons - 70 * z;
  }
  const cx = w / 2;

  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  if (def.kind === 'rhythm') {
    // 6 стрелок ← → с бегущей подсветкой; шаг сжимается на узких экранах,
    // кейкапы мельче шага — не перекрываются.
    const step = Math.min(70 * z, (w * 0.9) / def.beats);
    const kr = step * 0.44;
    for (let i = 0; i < def.beats; i++) {
      const x = cx + (i - (def.beats - 1) / 2) * step;
      const key = def.keys[i % 2];
      const g = q.beatGrades[i];
      const isNext = i === q.beatIdx;
      const beatT = q.target + i * def.beat;
      const closeness = Math.max(0, 1 - Math.abs(t - beatT) / def.beat);
      keycap(ctx, x, cy, kr * (isNext ? 1 + closeness * 0.25 : 0.9), KEY_LABEL[key],
        g ? (g === 'miss' ? '#ff6b6b' : '#69f0ae') : isNext ? '#ffd54a' : 'rgba(255,255,255,0.5)');
    }
  } else if (def.kind === 'hold' && q.holding) {
    gaugeBar(ctx, cx, cy, 260 * z, q.progress, '#69f0ae', 'ДЕРЖИМ… стол 3 сек', z);
  } else if (def.kind === 'holdRelease' && q.holding) {
    // Шкала движения по снаряду с жёлтой зоной — отпустить в зоне
    const bw = 300 * z;
    gaugeBar(ctx, cx, cy, bw, q.progress, '#4fc3f7',
      `Отпусти ${IS_TOUCH ? 'ВЕРХ' : '↑'} в жёлтой зоне!`, z);
    const zx = cx - bw / 2 + bw * def.zone[0], zw = bw * (def.zone[1] - def.zone[0]);
    ctx.fillStyle = 'rgba(244,196,48,0.85)';
    ctx.fillRect(zx, cy - 12 * z, zw, 24 * z);
    const px = cx - bw / 2 + bw * q.progress;
    ctx.fillStyle = '#fff';
    ctx.fillRect(px - 2, cy - 18 * z, 4, 36 * z);
  } else if (def.kind === 'twoStage' && q.stage === 1) {
    // Ждать опускания доски: кольцо сжимается к моменту удара
    const tipT = q.tipAt + def.tipDelay;
    const rem = Math.max(0, tipT - t);
    keycap(ctx, cx, cy, 52 * z, KEY_LABEL[def.key2], '#ffd54a');
    ring(ctx, cx, cy, 52 * z + rem * 90 * z, '#ffd54a');
  } else if (m.decoys && !m.decoys.revealed) {
    // PS-style обманка: три кандидата, настоящая кнопка раскроется позже
    const step = 92 * z;
    const spin = Math.floor(run.time * 9) % m.decoys.options.length;
    m.decoys.options.forEach((k, i) => {
      keycap(ctx, cx + (i - 1) * step, cy, 42 * z * (i === spin ? 1.12 : 0.9), KEY_LABEL[k],
        i === spin ? '#ffd54a' : 'rgba(255,255,255,0.45)');
    });
    ctx.fillStyle = '#ffd54a';
    ctx.font = `900 ${Math.round(34 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText('?', cx, cy - 62 * z);
  } else if (def.kind === 'press') {
    // press: ГЛАВНЫЙ индикатор тайминга — кольцо вокруг собаки (game.js).
    // Здесь только «какую клавишу жать» (на таче это делает сама кнопка).
    if (!IS_TOUCH) {
      const inPerfect = Math.abs(t - q.target) <= q.w * 0.28;
      const inGood = Math.abs(t - q.target) <= q.w * 0.6;
      const pulse = inPerfect ? 1 + Math.sin(run.time * 22) * 0.08 : 1;
      keycap(ctx, cx, cy, 44 * z * pulse, KEY_LABEL[def.key],
        inPerfect ? '#ffd54a' : inGood ? '#9ff0b4' : 'rgba(255,255,255,0.85)');
    }
  } else {
    // стадия захода holdRelease/hold/twoStage: клавиша + сжимающееся кольцо тайминга
    const key = def.key;
    const rem = Math.max(0, q.target - t);
    const closeness = 1 - Math.min(1, rem / def.lead);
    keycap(ctx, cx, cy, 52 * z * (1 + closeness * 0.12), KEY_LABEL[key],
      rem < q.w ? '#ffd54a' : 'rgba(255,255,255,0.85)');
    ring(ctx, cx, cy, 52 * z + rem * 110 * z, rem < q.w ? '#ffd54a' : 'rgba(255,255,255,0.6)');
  }
  ctx.restore();
}

// Точка отталкивания для UI-расчётов, синхронно с game.js TAKEOFF.
const TAKEOFF_UI = 1.3;

function keycap(ctx, x, y, r, label, color) {
  ctx.save();
  ctx.fillStyle = 'rgba(15,20,30,0.85)';
  ctx.strokeStyle = color; ctx.lineWidth = 3.5;
  ctx.beginPath(); ctx.roundRect(x - r, y - r * 0.7, r * 2, r * 1.4, r * 0.3);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = `900 ${Math.round(r * (label.length > 2 ? 0.42 : 0.8))}px "Segoe UI", sans-serif`;
  ctx.fillText(label, x, y + 2);
  ctx.restore();
}

function ring(ctx, x, y, r, color) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.globalAlpha = 0.85;
  ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.75, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

function gaugeBar(ctx, cx, cy, bw, p, color, caption, z) {
  ctx.save();
  ctx.fillStyle = 'rgba(15,20,30,0.85)';
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(cx - bw / 2 - 4, cy - 16 * z, bw + 8, 32 * z, 10); ctx.fill(); ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillRect(cx - bw / 2, cy - 12 * z, bw * Math.min(1, p), 24 * z);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(16 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(caption, cx, cy - 30 * z);
  ctx.restore();
}

// ---------- МЕНЮ ----------
function drawMenu(dt) {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  if (window.__layoutDebug) window.__layoutDebug.cards = [];
  app.t += dt;
  // Фон: размытое поле
  renderer.cam.x = 26 + Math.sin(app.t * 0.1) * 6;
  renderer.cam.y = 18 + Math.cos(app.t * 0.13) * 3;
  renderer.cam.zoom = h / 26;
  renderer.begin(dt);
  renderer.drawField({ w: 52, h: 36 }, 0.15);
  ctx.fillStyle = 'rgba(8,14,20,0.55)';
  ctx.fillRect(0, 0, w, h);

  const z = Math.min(w, h) / 700;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = `900 ${Math.round(64 * z)}px "Segoe UI", sans-serif`;
  ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.strokeText('AGILITY TRIAL!', w / 2, h * 0.16);
  const grad = ctx.createLinearGradient(0, h * 0.1, 0, h * 0.2);
  grad.addColorStop(0, '#ffe082'); grad.addColorStop(1, '#ff9d47');
  ctx.fillStyle = grad;
  ctx.fillText('AGILITY TRIAL!', w / 2, h * 0.16);
  ctx.font = `${Math.round(20 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = '#e0f2e9';
  ctx.fillText('Ты — собака. Слушай хендлера и жми верные клавиши вовремя!', w / 2, h * 0.16 + 46 * z);
  // Промо: игра от аусси Хлои — кликабельная ссылка на её дневник
  ctx.font = `bold ${Math.round(15 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = '#8fd8ff';
  const chloeText = '🐾 Игра от аусси Хлои · её дневник ВКонтакте →';
  // Шапка меню — вертикальный ПОТОК (в единицах z): не налезает при любых пропорциях окна
  const chloeY = h * 0.16 + 70 * z;
  ctx.fillText(chloeText, w / 2, chloeY);
  const ctw = ctx.measureText(chloeText).width;
  app.chloeZoneMenu = { x: w / 2 - ctw / 2 - 10, y: chloeY - 15 * z, w: ctw + 20, h: 21 * z };

  // Переключатель режима: явные кнопки-стрелки по бокам + точки-индикаторы
  const modeFs = Math.round((isPortrait() ? 17 : 22) * z);
  ctx.font = `bold ${modeFs}px "Segoe UI", sans-serif`;
  ctx.fillStyle = '#ffd54a';
  let modeName;
  if (app.mode === 'career') {
    modeName = `КАРЬЕРА · ${CLASSES[app.cls].name} · трасса ${app.stage}/${STAGES}`;
  } else if (app.mode === 'worldcup') {
    modeName = isPortrait() ? `ЧЕМПИОНАТ МИРА (${REAL_COURSES.length})`
      : `ЧЕМПИОНАТ МИРА · реальные трассы (${REAL_COURSES.length})`;
  } else {
    const db = dailyBest();
    modeName = isPortrait()
      ? `ТРАССА ДНЯ · ${CLASSES[dailyCls()].name}${db != null ? ` · ${db}` : ''}`
      : `ТРАССА ДНЯ ${todayStr()} · ${CLASSES[dailyCls()].name}${db != null ? ` · лучший: ${db}` : ''}`;
  }
  const modeY = chloeY + 34 * z;
  ctx.fillText(modeName, w / 2, modeY);
  const mw = ctx.measureText(modeName).width;
  const ar = 16 * z; // радиус кнопок-стрелок
  const axL = Math.max(ar + 8, w / 2 - mw / 2 - 30 * z);
  const axR = Math.min(w - ar - 8, w / 2 + mw / 2 + 30 * z);
  for (const [ax, ch] of [[axL, '‹'], [axR, '›']]) {
    ctx.beginPath();
    ctx.fillStyle = 'rgba(14,26,20,0.85)';
    ctx.strokeStyle = 'rgba(255,213,74,0.8)';
    ctx.lineWidth = 2;
    ctx.arc(ax, modeY - modeFs * 0.32, ar, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffd54a';
    ctx.font = `bold ${Math.round(ar * 1.4)}px "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, ax, modeY - modeFs * 0.32);
    ctx.textBaseline = 'alphabetic';
    ctx.font = `bold ${modeFs}px "Segoe UI", sans-serif`;
  }
  app.modeArrows = {
    left: { x: axL, y: modeY - modeFs * 0.32, r: ar * 1.5 },
    right: { x: axR, y: modeY - modeFs * 0.32, r: ar * 1.5 },
  };
  // Точки-индикаторы трёх режимов
  const modesOrder = ['career', 'worldcup', 'daily'];
  modesOrder.forEach((mo, i) => {
    ctx.beginPath();
    ctx.fillStyle = mo === app.mode ? '#ffd54a' : 'rgba(255,255,255,0.35)';
    ctx.arc(w / 2 + (i - 1) * 16 * z, modeY + 11 * z, 3.4 * z, 0, Math.PI * 2);
    ctx.fill();
  });

  // Подстрока: карта карьеры / модификатор дня — продолжение потока
  const subY = modeY + 30 * z;
  let headerBottom = modeY + 16 * z; // низ точек-индикаторов
  if (app.mode === 'career') {
    drawCareerMap(ctx, w / 2, subY, z, isPortrait());
    headerBottom = subY + (isPortrait() ? 1 : 2) * 19 * z;
  } else if (app.mode === 'daily') {
    const mod = MODIFIERS[dailyModifier()];
    if (mod.name) {
      ctx.font = `${Math.round(16 * z)}px "Segoe UI", sans-serif`;
      ctx.fillStyle = '#ffab6b';
      ctx.fillText(`${mod.name} · очки ×${mod.mult}`, w / 2, subY);
      headerBottom = subY + 6 * z;
    }
  }
  // Сводка медалей: не в карьере всегда; в карьере — на портрете (там карта
  // показывает только текущий класс и общий счёт медалей иначе не виден)
  if (app.mode !== 'career' || isPortrait()) {
    const mc = medalCounts();
    if (mc[3] + mc[2] + mc[1] > 0) {
      const medalY = headerBottom + 16 * z;
      ctx.font = `${Math.round(15 * z)}px "Segoe UI", sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(`🥇×${mc[3]}  🥈×${mc[2]}  🥉×${mc[1]}`, w / 2, medalY);
      headerBottom = medalY + 4 * z;
    }
  }
  // Карточки начинаются после шапки; высота сжимается под доступное место
  const startTextY = h * 0.83 - 26 * z;
  const cardsTop = Math.max(isPortrait() ? h * 0.36 : h * 0.38, headerBottom + 14 * z);
  if (window.__layoutDebug) {
    window.__layoutDebug.modeY = modeY - 22 * z;
    window.__layoutDebug.subY = subY;
    window.__layoutDebug.cardsTop = cardsTop;
    window.__layoutDebug.chloe = app.chloeZoneMenu;
  }

  // Карточки пород
  if (isPortrait()) {
    const top = cardsTop, cardH = h * 0.082, gap = h * 0.008, cardW = w * 0.88;
    breedList.forEach((b, i) => {
      const cy = top + i * (cardH + gap), cx = w / 2;
      const sel = i === app.breedIdx;
      ctx.save();
      ctx.fillStyle = sel ? 'rgba(30,52,40,0.92)' : 'rgba(14,26,20,0.8)';
      ctx.strokeStyle = sel ? '#ffd54a' : 'rgba(255,255,255,0.25)';
      ctx.lineWidth = sel ? 4 : 1.5;
      ctx.beginPath(); ctx.roundRect(cx - cardW / 2, cy, cardW, cardH, 16); ctx.fill(); ctx.stroke();
      const locked = breedLocked(b);
      ctx.save();
      if (locked) ctx.globalAlpha = 0.45;
      ctx.translate(cx - cardW / 2 + cardH * 0.75, cy + cardH * 0.55);
      ctx.scale(1.15, 1.15);
      drawCardDog(ctx, { runPhase: app.t * (sel ? 8 : 3), happy: sel && !locked }, b, cardH * 0.55);
      ctx.restore();
      ctx.textAlign = 'left';
      ctx.fillStyle = sel ? '#ffe082' : '#fff';
      ctx.font = `bold ${Math.round(19 * z)}px "Segoe UI", sans-serif`;
      ctx.fillText(`${locked ? '🔒 ' : ''}${b.name}`, cx - cardW / 2 + cardH * 1.6, cy + cardH * 0.42);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = `${Math.round(13 * z)}px "Segoe UI", sans-serif`;
      ctx.fillText(locked ? 'Открой: 5 золотых 🥇' : b.desc,
        cx - cardW / 2 + cardH * 1.6, cy + cardH * 0.72);
      if (window.__layoutDebug) {
        window.__layoutDebug.cards.push({ x: cx - cardW / 2, y: cy, w: cardW, h: cardH,
          descBottom: cy + cardH * 0.72 + 13 * z, locked, sel });
      }
      ctx.restore();
    });
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(22 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = Math.sin(app.t * 4) > -0.3 ? '#fff' : 'rgba(255,255,255,0.4)';
    if (window.__layoutDebug) window.__layoutDebug.startTextY = h * 0.84 - 22 * z;
    ctx.fillText('ТАП ПО СОБАКЕ — НА СТАРТ!', w / 2, h * 0.84);
    ctx.font = `${Math.round(14 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillText('Кнопки на экране подскажут, что жать', w / 2, h * 0.88);
    if (app.bestPoints) {
      ctx.fillStyle = '#ffd54a';
      ctx.fillText(`Рекорд: ${app.bestPoints} очков`, w / 2, h * 0.92);
    }
    ctx.restore();
    return;
  }
  const cardW = Math.min(195, w * 0.178);
  const cardH = Math.max(120 * z, Math.min(h * 0.34, startTextY - cardsTop - 14 * z));
  app.menuLayout = { cardsTop, cardH, cardW };
  breedList.forEach((b, i) => {
    const cx = w / 2 + (i - (breedList.length - 1) / 2) * (cardW + 14), cy = cardsTop;
    const sel = i === app.breedIdx;
    const locked = breedLocked(b);
    ctx.save();
    if (sel) { ctx.translate(cx, cy + cardH / 2); ctx.scale(1.06, 1.06); ctx.translate(-cx, -(cy + cardH / 2)); }
    ctx.fillStyle = sel ? 'rgba(30,52,40,0.92)' : 'rgba(14,26,20,0.8)';
    ctx.strokeStyle = sel ? '#ffd54a' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = sel ? 4 : 1.5;
    ctx.beginPath(); ctx.roundRect(cx - cardW / 2, cy, cardW, cardH, 18); ctx.fill(); ctx.stroke();
    // Пёсик на карточке
    const dogY = cy + cardH * 0.36;
    renderer.cam.zoom = 34 * z;
    const fake = { x: 0, y: 0, heading: -0.1, runPhase: app.t * (sel ? 8 : 3), speed: sel ? 5 : 1, happy: sel && !locked, elevation: 0 };
    ctx.save();
    if (locked) ctx.globalAlpha = 0.4;
    ctx.translate(cx, dogY);
    ctx.scale(1.6, 1.6);
    drawCardDog(ctx, fake, b, z * 34);
    ctx.restore();
    ctx.textAlign = 'center';
    ctx.fillStyle = sel ? '#ffe082' : '#fff';
    let nameFs = Math.round(22 * z);
    ctx.font = `bold ${nameFs}px "Segoe UI", sans-serif`;
    const nameTxt = `${locked ? '🔒 ' : ''}${b.name}`;
    const ntw = ctx.measureText(nameTxt).width;
    if (ntw > cardW - 16) {
      nameFs = Math.max(11, Math.floor(nameFs * (cardW - 16) / ntw));
      ctx.font = `bold ${nameFs}px "Segoe UI", sans-serif`;
    }
    ctx.fillText(nameTxt, cx, cy + cardH * 0.62);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = `${Math.round(14 * z)}px "Segoe UI", sans-serif`;
    const descBottom = wrapText(ctx, locked ? 'Открой: 5 золотых 🥇' : b.desc,
      cx, cy + cardH * 0.72, cardW - 30, 17 * z, 3);
    if (window.__layoutDebug) {
      window.__layoutDebug.cards.push({ x: cx - cardW / 2, y: cy, w: cardW, h: cardH, descBottom, locked, sel });
    }
    ctx.restore();
  });
  if (window.__layoutDebug) window.__layoutDebug.startTextY = h * 0.83 - 24 * z;

  ctx.font = `bold ${Math.round(24 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = Math.sin(app.t * 4) > -0.3 ? '#fff' : 'rgba(255,255,255,0.4)';
  ctx.fillText('ENTER / клик — на старт!', w / 2, h * 0.83);
  ctx.font = `${Math.round(15 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.fillText('← → выбор породы · ПРОБЕЛ прыжок · ↓ туннель · ←→ слалом · ↑ горка/бум · L — лидерборд', w / 2, h * 0.88);
  ctx.fillStyle = '#ffd54a';
  const balanceLine = `🦴 ${meta.bones}   🏵️ ${meta.rosettes}` +
    (app.bestPoints ? `   ·   Рекорд: ${app.bestPoints}` : '') +
    (meta.streak.count >= 2 ? `   ·   🔥 серия ${meta.streak.count} дн (×${streakMult(meta.streak.count)})` : '');
  ctx.fillText(balanceLine, w / 2, h * 0.93);
  ctx.restore();
}

function drawCardDog(ctx, dog, breed, zoom) {
  // Упрощённая отрисовка пса для карточки через Renderer-логику
  const save = { cam: { ...renderer.cam }, canvas: renderer.canvas };
  ctx.save();
  ctx.scale(zoom / 24, zoom / 24);
  ctx.fillStyle = breed.body;
  ctx.beginPath(); ctx.ellipse(0, 0, 13, 6.5, 0, 0, Math.PI * 2); ctx.fill();
  if (breed.merle) {
    ctx.save();
    ctx.beginPath(); ctx.ellipse(0, 0, 13, 6.5, 0, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = breed.merle;
    for (const [sx, sy, sr] of [[-7, -2.5, 2.6], [-1.5, 2, 2.1], [4, -3.5, 1.9], [-10.5, 1.5, 1.8]]) {
      ctx.beginPath(); ctx.ellipse(sx, sy, sr, sr * 0.75, 0.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  ctx.fillStyle = breed.chest;
  ctx.beginPath(); ctx.ellipse(6, 1.5, 4.5, 4.2, 0, 0, Math.PI * 2); ctx.fill();
  if (breed.curly) {
    ctx.fillStyle = breed.curly;
    for (const [px2, py2, pr] of [[-11, -4, 3], [-6, -6.2, 3.2], [0, -6.8, 3.4], [6, -6, 3], [11, -4, 2.7], [-3, 6, 3]]) {
      ctx.beginPath(); ctx.arc(px2, py2, pr, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.fillStyle = breed.body;
  ctx.beginPath(); ctx.ellipse(14, -4, 6.2, 5.4, -0.15, 0, Math.PI * 2); ctx.fill();
  if (breed.curly) {
    ctx.fillStyle = breed.curly;
    for (const [hx2, hy2, hr] of [[13, -9.5, 2.4], [15.5, -10, 2.2], [11, -8.5, 2]]) {
      ctx.beginPath(); ctx.arc(hx2, hy2, hr, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (breed.tan) {
    ctx.fillStyle = breed.tan;
    ctx.beginPath(); ctx.ellipse(13, -1.5, 2.6, 2.0, -0.2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(15.2, -7.6, 1.2, 0.8, -0.2, 0, Math.PI * 2); ctx.fill();
  }
  if (breed.merle) {
    ctx.fillStyle = breed.chest;
    ctx.beginPath(); ctx.ellipse(16.5, -5.2, 2.6, 1.5, -0.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = breed.chest;
  ctx.beginPath(); ctx.ellipse(18.5, -2.5, 3.4, 2.6, -0.1, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#222';
  ctx.beginPath(); ctx.arc(21, -3, 1.3, 0, Math.PI * 2); ctx.fill();
  if (breed.eye) {
    ctx.fillStyle = breed.eye;
    ctx.beginPath(); ctx.arc(15.5, -5.5, 1.35, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(15.7, -5.5, 0.65, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.beginPath(); ctx.arc(15.5, -5.5, 1.1, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = breed.ear;
  for (const side of [-1, 1]) {
    ctx.save(); ctx.translate(12, -8); ctx.rotate(-0.6 + side * 0.25);
    ctx.beginPath(); ctx.ellipse(0, -3, 1.9, 3.8, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  const run = dog.runPhase;
  ctx.strokeStyle = breed.legs || breed.body; ctx.lineWidth = 3.2; ctx.lineCap = 'round';
  for (const [lx, ph] of [[-8, 0], [-8, Math.PI], [8, Math.PI * 0.9], [8, Math.PI * 1.9]]) {
    const sw = Math.sin(run + ph) * 0.8;
    ctx.beginPath(); ctx.moveTo(lx, 2); ctx.lineTo(lx + Math.sin(sw) * 7, 10); ctx.stroke();
  }
  if (dog.happy) {
    ctx.fillStyle = '#e2697d';
    ctx.beginPath(); ctx.ellipse(19, 0.5, 1.5, 2.6, 0.3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function wrapText(ctx, text, x, y, maxW, lh, maxLines = 99) {
  const words = text.split(' ');
  let line = '', yy = y, count = 1;
  for (const wd of words) {
    if (ctx.measureText(line + wd).width > maxW && line) {
      ctx.fillText(line.trim(), x, yy); line = ''; yy += lh;
      if (++count > maxLines) return yy;
    }
    line += wd + ' ';
  }
  ctx.fillText(line.trim(), x, yy);
  return yy + lh;
}

// ---------- РЕЗУЛЬТАТЫ ----------
function drawResults(run, z) {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  if (!app.result) {
    app.result = finalScore({
      time: run.time, sct: run.sct, faults: run.score.faults,
      perfects: run.score.perfects, total: run.marks.length, maxCombo: run.score.maxCombo,
    });
    const mod = MODIFIERS[run.modifier];
    if (run.eliminated) {
      app.result.title = 'ДИСКВАЛИФИКАЦИЯ — 3 отказа!';
      app.result.stars = 0;
      app.result.points = 0;
      app.result.qualified = false;
      app.result.clean = false;
    } else if (mod.mult > 1) {
      app.result.points = Math.round(app.result.points * mod.mult);
    }
    app.newMedal = recordMedal(app.result.stars);
    if (app.mode === 'daily') app.newDailyBest = saveDailyBest(app.result.points);
    // Достижения
    const newly = checkAchievements({
      run, result: app.result, mode: app.mode, cls: app.cls, goldCount: medalCounts()[3],
    });
    for (const a of newly) {
      toasts.push({ icon: a.icon, name: a.name, desc: a.desc, t: 0 });
      audio.fanfare();
    }
    if (app.result.points > app.bestPoints) {
      app.bestPoints = app.result.points;
      localStorage.setItem('agility_best', String(app.bestPoints));
    }
    saveRunToBoard(run, app.result);

    // ---- V2 Мета: перфект-челлендж (4-я звезда), валюты, XP, задания ----
    if (!run.warmup) {
      const res0 = app.result;
      // 4-я звезда: все перфекты + 0 фолтов + запас времени >= 3с
      if (res0.stars === 3 && run.score.perfects === run.marks.length
          && res0.totalFaults === 0 && run.time <= run.sct - 3) {
        res0.stars = 4;
        app.newMedal = recordMedal(4) || app.newMedal;
      }
      const trackId = courseKey();
      const earned = earnFromRun(meta, {
        points: res0.points, stars: Math.min(3, res0.stars), trackId,
        isDaily: app.mode === 'daily', todayStr: todayStr(),
      });
      // Розетки-вехи: первое золото трассы, чистая ЧМ-трасса
      let ros = 0;
      if (res0.stars >= 3) ros += grantRosette(meta, `gold:${trackId}`, 1);
      if (app.mode === 'worldcup' && res0.clean) ros += grantRosette(meta, `wcq:${trackId}`, 2);
      // XP собаки
      const breedId = breedList[app.breedIdx].id;
      const xp = earnXp(meta, breedId, { points: res0.points, stars: Math.min(3, res0.stars), clean: res0.clean });
      ros += rosettesForLevels(meta, breedId, xp.levelsUp);
      for (const L of xp.levelsUp) {
        const tag = titleFor(L);
        toasts.push({ icon: '🐕', name: `Уровень ${L}!`, desc: tag ? `Новый титул: ${tag}` : `${breedList[app.breedIdx].name} растёт`, t: 0 });
      }
      // Задания
      const ev = {
        run: 1,
        clean: res0.clean ? 1 : 0,
        perfect: run.score.perfects,
        obstacle: run.marks.length,
        combo10: run.score.maxCombo >= 10 ? 1 : 0,
        daily: app.mode === 'daily' ? 1 : 0,
        medal: res0.stars >= 1 ? 1 : 0,
        gold: res0.stars >= 3 ? 1 : 0,
        tunnel: run.marks.filter(m => m.o.type === 'tunnel').length,
      };
      const doneNow = applyRunToQuests(meta, ev);
      const claimed = claimDone(meta);
      for (const dq of doneNow) toasts.push({ icon: '📋', name: 'Задание выполнено', desc: dq.name, t: 0 });
      app.lastEarn = { bones: earned.bones + (claimed.bones || 0), detail: earned.detail,
        rosettes: ros + (claimed.rosettes || 0), xp: xp.gained, breedId };
      saveMeta(meta);
    }
  }
  const res = app.result;
  // Протокол судьи печатается поэтапно (ft = сек после финиша); скип — любая клавиша.
  const ft = run.finishT;
  const ease = (a, dur = 0.45) => Math.max(0, Math.min(1, (ft - a) / dur));
  const stamp = (a) => { // звук штампа один раз на этап
    run._stamps = run._stamps || {};
    if (ft >= a && !run._stamps[a]) { run._stamps[a] = 1; audio.click(); }
  };
  const pw = Math.min(520 * z, w * 0.9), ph = Math.min((IS_TOUCH ? 570 : 500) * z, h * 0.88);
  const px = w / 2 - pw / 2, py = h / 2 - ph / 2;
  ctx.save();
  ctx.fillStyle = `rgba(6,12,10,${0.72 * ease(0, 0.3)})`;
  ctx.fillRect(0, 0, w, h);
  panel(ctx, px, py, pw, ph);
  ctx.textAlign = 'center';

  // 1.4с: вердикт-титул с лёгким наклоном и появлением
  if (ft >= 1.4) {
    stamp(1.4);
    const k = ease(1.4, 0.25);
    ctx.save();
    ctx.translate(w / 2, py + 52 * z);
    ctx.rotate(-0.02 * k);
    ctx.scale(0.8 + 0.2 * k, 0.8 + 0.2 * k);
    ctx.globalAlpha = k;
    ctx.fillStyle = res.clean ? '#ffd54a' : '#fff';
    ctx.font = `900 ${Math.round(34 * z)}px "Segoe UI", sans-serif`;
    wrapText(ctx, res.title, 0, 0, pw - 60, 40 * z);
    ctx.restore();
  }

  // 2.6с+: звёзды вылетают по одной
  for (let i = 0; i < 3; i++) {
    const at = 2.6 + i * 0.25;
    const on = i < res.stars && ft > at;
    if (on) stamp(at);
    const k = on ? ease(at, 0.2) : 1;
    const sx = w / 2 + (i - 1) * 76 * z;
    ctx.font = `${Math.round(52 * z * (on ? 0.7 + 0.3 * k : 1))}px "Segoe UI", sans-serif`;
    ctx.fillStyle = on ? '#ffd54a' : 'rgba(255,255,255,0.18)';
    ctx.fillText('★', sx, py + 130 * z);
  }

  ctx.font = `${Math.round(21 * z)}px "Segoe UI", sans-serif`;
  const modLine = MODIFIERS[run.modifier].mult > 1 && !run.eliminated
    ? ` (×${MODIFIERS[run.modifier].mult})` : '';
  // 0.4с: время (rolling), 0.9с: фолты, 1.9с: перфекты, 2.2с: очки (rolling)
  const rows = [
    [0.4, () => `Время: ${(run.time * ease(0.4)).toFixed(2)}с  (SCT ${run.sct}с${res.timeFaults ? `, +${res.timeFaults} time faults` : ''})`],
    [0.9, () => `Фолты: ${res.totalFaults}   Отказы: ${run.score.refusals}`],
    [1.9, () => `Идеально: ${run.score.perfects}/${run.marks.length}   Макс. комбо: ×${run.score.maxCombo}`],
    [2.2, () => `Очки: ${Math.round(res.points * ease(2.2, 0.6))}${modLine}${ft > 2.9 && res.points >= app.bestPoints && res.points > 0 ? ' — РЕКОРД!' : ''}`],
  ];
  rows.forEach(([at, fn], i) => {
    if (ft < at) return;
    stamp(at);
    ctx.globalAlpha = ease(at, 0.2);
    ctx.fillStyle = '#e8f5ec';
    ctx.fillText(fn(), w / 2, py + (185 + i * 38) * z);
    ctx.globalAlpha = 1;
  });

  // 3.0с: медаль с bounce
  if (res.stars > 0 && ft >= 3.0) {
    stamp(3.0);
    const k = ease(3.0, 0.35);
    const bounce = 1 + Math.sin(k * Math.PI) * 0.5;
    ctx.font = `${Math.round(30 * z * bounce)}px "Segoe UI", sans-serif`;
    ctx.fillText(`${MEDAL_ICON[res.stars]}${app.newMedal && ft > 3.4 ? ' Новая медаль!' : ''}`, w / 2, py + 345 * z);
  }
  if (app.mode === 'daily' && app.newDailyBest && ft > 3.2) {
    ctx.font = `bold ${Math.round(17 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = '#ffd54a';
    ctx.fillText('Лучший результат дня!', w / 2, py + 375 * z);
  }

  // V2: заработанное за прогон + XP-бар собаки
  if (app.lastEarn && ft > 3.3) {
    const e = app.lastEarn;
    ctx.font = `bold ${Math.round(16 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = '#ffe9a8';
    ctx.fillText(`+${e.bones} 🦴${e.rosettes ? `   +${e.rosettes} 🏵️` : ''}   +${e.xp} XP`,
      w / 2, py + (IS_TOUCH ? 428 : 372) * z);
    const d = dogState(meta, e.breedId);
    const bw2 = 220 * z, bx2 = w / 2 - bw2 / 2, by2 = py + (IS_TOUCH ? 444 : 386) * z;
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(bx2, by2, bw2, 7 * z);
    ctx.fillStyle = '#69f0ae';
    ctx.fillRect(bx2, by2, bw2 * Math.min(1, d.xp / xpToNext(d.level)), 7 * z);
    ctx.font = `${Math.round(12 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    const tg = titleFor(d.level);
    ctx.fillText(`${tg ? tg + ' · ' : ''}уровень ${d.level}`, w / 2, by2 + 20 * z);
  }

  // Промо Хлои: после провала — поддержка, после победы — приглашение в дневник
  if (ft > 2.8) {
    const chloeMsg = res.qualified
      ? '🐾 Хлоя гордится тобой! Её дневник →'
      : '🐾 Хлоя верит в тебя! Загляни в её дневник →';
    ctx.font = `bold ${Math.round(14 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = '#8fd8ff';
    const cy2 = py + (IS_TOUCH ? 400 : 405) * z;
    ctx.fillText(chloeMsg, w / 2, cy2);
    const ctw2 = ctx.measureText(chloeMsg).width;
    app.chloeZoneResults = { x: w / 2 - ctw2 / 2 - 10, y: cy2 - 16 * z, w: ctw2 + 20, h: 26 * z };
  } else {
    app.chloeZoneResults = null;
  }

  if (ft > 1.0) {
    const nextText = app.mode === 'career'
      ? (res.qualified
        ? (app.stage >= STAGES && app.cls !== 'masters'
          ? `Класс ${CLASSES[nextClass(app.cls)].name}!`
          : 'Следующая трасса')
        : 'Ещё попытка')
      : app.mode === 'daily' ? 'Ещё попытка (лучший в зачёт)'
      : 'Следующая трасса чемпионата';
    if (IS_TOUCH) {
      // Тач: настоящие кнопки вместо клавиатурных подсказок
      for (const b of resultsButtons(px, py, pw, ph, z)) {
        ctx.save();
        ctx.fillStyle = b.id === 'next' ? 'rgba(255,213,74,0.92)' : 'rgba(20,36,26,0.95)';
        ctx.strokeStyle = b.id === 'next' ? '#ffd54a' : 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.roundRect(b.x, b.y, b.w, b.h, 12 * z); ctx.fill(); ctx.stroke();
        ctx.fillStyle = b.id === 'next' ? '#1a1a1a' : '#fff';
        ctx.font = `bold ${Math.round((b.id === 'next' ? 19 : 14) * z)}px "Segoe UI", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(b.id === 'next' ? nextText : b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
        ctx.restore();
      }
      ctx.textBaseline = 'alphabetic';
    } else {
      ctx.font = `bold ${Math.round(20 * z)}px "Segoe UI", sans-serif`;
      ctx.fillStyle = Math.sin(app.t * 4) > -0.3 ? '#ffd54a' : 'rgba(255,213,74,0.4)';
      ctx.fillText(`ENTER — ${nextText.toLowerCase()}`, w / 2, py + ph - 64 * z);
      ctx.font = `${Math.round(16 * z)}px "Segoe UI", sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText('R — переиграть · S — поделиться · ESC — меню', w / 2, py + ph - 32 * z);
    }
  }
  ctx.restore();
}

// Тач-кнопки экрана результатов: большая «Дальше» + ряд действий под ней
function resultsButtons(px, py, pw, ph, z) {
  const bw = pw - 48 * z, bh = 52 * z;
  const rowY = py + ph - 62 * z;
  const smallW = (bw - 16 * z) / 3;
  return [
    { id: 'next', x: px + 24 * z, y: rowY - bh - 12 * z, w: bw, h: bh },
    { id: 'retry', label: '↺ Ещё раз', x: px + 24 * z, y: rowY, w: smallW, h: 44 * z },
    { id: 'share', label: '📤 Поделиться', x: px + 24 * z + smallW + 8 * z, y: rowY, w: smallW, h: 44 * z },
    { id: 'menu', label: '⌂ Меню', x: px + 24 * z + (smallW + 8 * z) * 2, y: rowY, w: smallW, h: 44 * z },
  ];
}

// Шеринг: эмодзи-строка (паттерн Wordle) в буфер + PNG-карточка текущего кадра
function shareResult() {
  const res = app.result, run = app.run;
  if (!res || !run) return;
  const stars = '⭐'.repeat(res.stars) || '—';
  const txt = `🐕 Agility Trial! · ${run.course.name || 'Трасса'} · ${run.time.toFixed(2)}с ${stars}` +
    `${res.clean ? ' · Q!' : ''} · комбо ×${run.score.maxCombo} · ${res.points} очков\n` +
    'https://allgrit.github.io/agility-fable-game/\n' +
    `Игра от аусси Хлои 🐾 ${CHLOE_URL}`;
  // Мобильные: родное окно шаринга (Android/iOS); десктоп: буфер + PNG
  if (navigator.share) {
    navigator.share({ text: txt }).catch(() => {});
    toasts.push({ icon: '📤', name: 'Поделиться', desc: 'Выбери, куда отправить', t: 0 });
  } else {
    try { navigator.clipboard?.writeText(txt); } catch {}
    try {
      const a = document.createElement('a');
      a.download = 'agility-result.png';
      a.href = canvas.toDataURL('image/png');
      a.click();
    } catch {}
    toasts.push({ icon: '📋', name: 'Скопировано!', desc: 'Текст в буфере + PNG-карточка', t: 0 });
  }
  audio.click();
}

// ---------- ЦИКЛ ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  app.t += dt;

  if (app.state === 'menu' || app.state === 'board' || app.state === 'shop' || app.state === 'quests') {
    audio.music?.setState('menu');
    drawMenu(dt);
    drawMuteIcon();
    drawTrophyIcon();
    if (app.state === 'board') drawBoard();
    if (app.state === 'shop') drawShop();
    if (app.state === 'quests') drawQuests();
    drawToasts(dt);
  } else if (app.run) {
    renderer.begin(dt);
    app.run.update(dt);
    app.run.draw();
    drawHud(app.run);
    const z = Math.min(canvas.width, canvas.height) / 700;
    if (app.run.phase === 'finished' && app.run.finishT > 0.4 && !app.run.warmup) {
      app.state = 'results';
    }
    if (app.state === 'results') drawResults(app.run, z);
    drawMuteIcon();
    drawToasts(dt);
    for (const e of app.run.drainEvents()) {
      // события уже озвучены внутри Run; здесь место для метрик/отладки
      if (window.__agilityEvents) window.__agilityEvents.push(e);
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Хук для тестового харнесса (Playwright)
window.__agility = {
  meta, saveMeta: () => saveMeta(meta),
  app, startRun,
  setMode(m) { app.mode = m; },
  setClass(c) { app.cls = c; },
  setSeed(s) { app.stage = ((s - 1) % 5) + 1; }, // legacy-хук тестов: сид → этап
  getState() {
    return {
      state: app.state,
      phase: app.run?.phase,
      dist: app.run?.dog.dist,
      pathLen: app.run?.path.length,
      faults: app.run?.score.faults,
      time: app.run?.time,
      activeQte: app.run?.activeMark ? {
        type: app.run.activeMark.o.type,
        state: app.run.activeMark.qte?.state,
        t: app.run.time - app.run.activeMark.qteStart,
        target: app.run.activeMark.qte?.target,
      } : null,
    };
  },
  pressKey(code) { app.run?.input(code, true); },
  releaseKey(code) { app.run?.input(code, false); },
};
window.__agilityEvents = [];

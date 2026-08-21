// Точка входа: меню → забег → результаты. Input, HUD, игровой цикл.
import { generateCourse, CLASSES } from './course.js';
import { BREEDS, finalScore, nextClass, CLASS_ORDER, medalTimes, timeMedal } from './scoring.js';
import { AudioEngine } from './audio.js';
import { Particles } from './particles.js';
import { Renderer } from './render.js';
import { Run } from './game.js';
import { QTE_DEFS, Qte, GROOVE_WINDOWS } from './qte.js';
import { REAL_COURSES, realToCourse } from './courses.js';
import { ACHIEVEMENTS, loadAch, hasAch, checkAchievements } from './achievements.js';
import { pickTheme, THEMES } from './themes.js';
import { loadMeta, saveMeta, earnFromRun, earnXp, addXp, rosettesForLevels, dogState,
  titleFor, xpToNext, streakMult, grantRosette } from './meta.js';
import { ITEMS, RARITY, SLOT_NAMES, itemById, priceOf, dailyShowcase, applyEquip } from './cosmetics.js';
import { refreshQuests, applyRunToQuests, claimDone, questDef } from './quests.js';
import { SEASONS, BOSSES, bossFor, pickLine, startLineFor, newspaperFor } from './career.js';
import { setHapticsEnabled } from './haptics.js';
import { dogName, temperamentFor, favoriteObstacle, recordObstacleStats, recordBestTime,
  IdleMachine, OBSTACLE_NAMES } from './soul.js';
import { updateCalibration } from './calibrate.js';
// S4.10 «Питомник» — витрина целей; S4.11 — календарь-архив трасс дня.
import { collectGoals, nearestGoals, groupGoals, goalsSummary } from './goals.js';
import { buildCalendar, currentCursor, prevMonth, nextMonth } from './daily-archive.js';
// Fable Arcade SDK: аналитика игроков + онлайн-лидерборд (общий бэкенд по game-id).
import { SDK } from '../sdk/config.js';
import { track, telemetryEnabled } from '../sdk/analytics.js';
import { submitScore, fetchTop } from '../sdk/leaderboard.js';

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

// Аналитика: загрузка игры (даёт распределение по версиям и работу автообновления).
track('game_loaded', {
  device: (window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window) ? 'touch' : 'desktop',
  w: window.innerWidth, h: window.innerHeight,
});

const canvas = document.getElementById('game');
const renderer = new Renderer(canvas);
const audio = new AudioEngine();
const fx = new Particles();

const STAGES = 5; // трасс в каждом классе карьеры
// Тест-драйв: ?test=v4 — механики V4; ?test=s1 — демо новинок «Game Feel»
const TEST_MODE = new URLSearchParams(location.search).get('test'); // 'v4' | 's1' | '' | null
const TEST_DRIVE = new URLSearchParams(location.search).has('test');
const FREEZE_MAX = 2, FREEZE_COST = 200; // заначка стрика (S1.5)

const app = {
  state: 'menu',           // menu | run | results | board
  breedIdx: 0,
  cls: localStorage.getItem('agility_class') || 'novice', // прогресс карьеры
  stage: Number(localStorage.getItem('agility_stage') || 1), // 1..STAGES
  run: null,
  result: null,
  mode: 'career',          // career | worldcup (реальные трассы) | daily (трасса дня) | zen (прогулка)
  realIdx: 0,
  t: 0,
  bestPoints: Number(localStorage.getItem('agility_best') || 0),
  testDrive: TEST_DRIVE,
};

// Порядок режимов в переключателе меню: стрелки, точки-индикаторы и ↑↓ читают
// один и тот же массив, иначе они разъезжаются. Zen — последним: это выход
// «отдохнуть», а не соревновательный режим.
const MODE_ORDER = ['career', 'worldcup', 'daily', 'zen'];

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
    risks: run.focus?.used || 0, // ⚡ сыгранных заявок риска
  });
  board.sort((a, b) => b.points - a.points);
  board.length = Math.min(board.length, 20);
  localStorage.setItem('agility_board', JSON.stringify(board));
}
function saveProgress() {
  localStorage.setItem('agility_class', app.cls);
  localStorage.setItem('agility_stage', String(app.stage));
}

// ---------- ОНЛАЙН-ЛИДЕРБОРД (Fable Arcade SDK) ----------
// Имя игрока для онлайн-топа: спрашиваем один раз при первой отправке, дальше помним.
function playerName() {
  let n = localStorage.getItem('agility_player');
  if (!n) {
    try { n = (window.prompt('Имя для онлайн-рейтинга (видно всем):', '') || '').trim(); } catch { n = ''; }
    n = (n || 'Аноним').slice(0, 24);
    localStorage.setItem('agility_player', n);
  }
  return n;
}
function submitOnline(points, time) {
  if (!telemetryEnabled()) return; // тесты/харнесс не шлют реальные результаты на прод
  const r = submitScore(playerName(), points, time);
  if (r && r.then) r.then((res) => {
    if (res && res.rank) app.onlineRank = res.rank;
    track('leaderboard_submit', { score: Math.floor(points), rank: (res && res.rank) || 0,
      nickname_set: !!localStorage.getItem('agility_player') });
  });
}
// Онлайн-топ для экрана лидерборда: тянем при открытии, кэшируем в app.
function refreshOnlineTop() {
  if (!telemetryEnabled()) { app.onlineTop = []; return; }
  app.onlineTopLoading = true;
  const p = fetchTop('all', 10);
  if (p && p.then) p.then((top) => { app.onlineTop = top || []; app.onlineTopLoading = false; })
    .catch(() => { app.onlineTop = []; app.onlineTopLoading = false; });
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
  if (app.mode !== 'daily') return 'none';
  // Перебег из архива (S4.11) несёт модификатор СВОЕГО дня, а не сегодняшнего.
  return app.archiveDay ? app.archiveDay.modifier : dailyModifier();
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
  if (app.mode === 'daily') return `d:${app.archiveDay ? app.archiveDay.key : todayStr()}`;
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
// S3.2: собака живёт в меню — автомат выходок (чешется/зевает/гоняется за хвостом),
// сон после 30с без ввода, встряхивание при смене породы или окраса.
const menuIdle = new IdleMachine();
const CHLOE_URL = 'https://vk.com/chloe.myaussie'; // дневник аусси Хлои — прототипа персонажа
// Настройки (доступность и громкости)
const settings = (() => {
  // assist — S4.8 «Хендлер помогает»: окна реакции +50% и метроном весь забег.
  // Это доступность, а не читерство: цена честная и явная (🦴 ×0.5, без Golden
  // Weave и без онлайн-топа), поэтому флаг живёт в общих настройках.
  const defs = { shake: true, colorblind: false, music: 0.6, sfx: 0.6, haptics: true, assist: false };
  try { return { ...defs, ...JSON.parse(localStorage.getItem('agility_settings') || '{}') }; }
  catch { return { ...defs }; }
})();
function saveSettings() {
  try { localStorage.setItem('agility_settings', JSON.stringify(settings)); } catch {}
  renderer.shakeScale = settings.shake ? 1 : 0;
  renderer.colorblind = settings.colorblind;
  setHapticsEnabled(settings.haptics !== false);
  if (audio.music) audio.music.bus.gain.value = 0.3 * settings.music / 0.6;
  if (audio.master && !audio.muted) audio.master.gain.value = 0.55 * settings.sfx / 0.6;
}

// Мета-прогрессия: единое состояние валют/XP/заданий
const meta = loadMeta();
{
  const d = new Date();
  refreshQuests(meta, d.toDateString(), d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate());
  saveMeta(meta);
}
function openChloe() {
  track('diary_click', { from: app.state });
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
saveSettings();

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
function settingsZone() {
  const z = Math.min(canvas.width, canvas.height) / 700;
  return { x: canvas.width - 34 * z, y: 455 * z, r: 26 * z };
}
// S3.7: досье собаки — кличка, характер, любимый снаряд, лучшее время
function dossierZone() {
  const z = Math.min(canvas.width, canvas.height) / 700;
  return { x: canvas.width - 34 * z, y: 520 * z, r: 26 * z };
}
// S4.10: витрина целей «Питомник» — всё, ради чего играть дальше
function kennelZone() {
  const z = Math.min(canvas.width, canvas.height) / 700;
  return { x: canvas.width - 34 * z, y: 585 * z, r: 26 * z };
}
// S4.11: календарь-архив трасс дня
function archiveZone() {
  const z = Math.min(canvas.width, canvas.height) / 700;
  return { x: canvas.width - 34 * z, y: 650 * z, r: 26 * z };
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
  app.lastInputT = app.t; // S3.2: собака в меню засыпает без ввода
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
  if (e.code === 'KeyD' && app.state !== 'run') {
    app.state = app.state === 'dossier' ? 'menu' : 'dossier';
    audio.click();
    return;
  }
  if (e.code === 'KeyO' && app.state !== 'run') {
    app.state = app.state === 'settings' ? 'menu' : 'settings';
    audio.click();
    return;
  }
  // S4.10 «Питомник» (K) и S4.11 «Архив трасс дня» (A)
  if (e.code === 'KeyK' && app.state !== 'run') {
    if (app.state === 'kennel') app.state = 'menu';
    else { openKennel(); }
    audio.click();
    return;
  }
  if (e.code === 'KeyA' && app.state !== 'run') {
    if (app.state === 'archive') app.state = 'menu';
    else openArchive();
    audio.click();
    return;
  }
  if (app.state === 'kennel') {
    if (e.code === 'Escape' || e.code === 'Enter') { app.state = 'menu'; audio.click(); return; }
    if (e.code === 'ArrowUp') return kennelScrollBy(-60 * kennelLayout().z);
    if (e.code === 'ArrowDown') return kennelScrollBy(60 * kennelLayout().z);
    if (e.code === 'PageUp') return kennelScrollBy(-kennelLayout().viewH * 0.9);
    if (e.code === 'PageDown') return kennelScrollBy(kennelLayout().viewH * 0.9);
    return;
  }
  if (app.state === 'archive') {
    if (e.code === 'Escape' || e.code === 'Enter') { app.state = 'menu'; audio.click(); return; }
    if (e.code === 'ArrowLeft') return archiveStep(-1);
    if (e.code === 'ArrowRight') return archiveStep(1);
    return;
  }
  if (app.state === 'board' || app.state === 'shop' || app.state === 'quests'
      || app.state === 'settings' || app.state === 'dossier') {
    if (e.code === 'Escape' || e.code === 'Enter') { app.state = 'menu'; audio.click(); }
    return;
  }
  if (app.state === 'photo') {
    if (e.code === 'KeyS') return sharePhoto();
    photoContinue();
    return;
  }
  if (app.state === 'podium') { podiumContinue(); return; }
  if (app.state === 'treat') {
    if (e.code === 'Escape') closeTreat();
    else treatAdvance();
    return;
  }
  if (app.state === 'news') {
    if (e.code === 'Enter' || e.code === 'Space' || e.code === 'Escape') newsContinue();
    return;
  }
  if (app.state === 'champion') {
    if (e.code === 'Enter' || e.code === 'Space' || e.code === 'Escape') { toMenu(); audio.click(); }
    return;
  }
  if (app.state === 'calib') {
    if (e.code === 'Escape' || e.code === 'Enter') { app.state = 'settings'; audio.click(); return; }
    if (e.code === 'Space') calibInput();
    return;
  }
  if (app.state === 'trainer') {
    if (e.code === 'Escape' || e.code === 'Enter') { app.state = 'settings'; audio.click(); return; }
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') trainerInput(e.code);
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
    // Фото-режим (S3.8) забирает ввод целиком, пока включён
    if (app.photoMode) { photoModeInput(e.code); return; }
    if (e.code === 'Escape') return toMenu();
    if (e.code === 'KeyR') return startRun();
    if (e.code === 'KeyP') {
      if (app.run.phase === 'countdown') return petDog();
      return togglePhotoMode();
    }
    // Победный круг: любой ввод — сразу к кадру-полароиду
    if (app.run.victoryLap && app.run.skipVictoryLap()) return;
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
  app.lastInputT = app.t;
  audio.ensure();
  const p = evXY(e);
  const mz = muteZone();
  if (Math.hypot(p.x - mz.x, p.y - mz.y) < mz.r) { toggleMute(); return; }
  if (FS_SUPPORTED) {
    const fz = fsZone();
    if (Math.hypot(p.x - fz.x, p.y - fz.y) < fz.r) { toggleFullscreen(); return; }
  }
  if (app.state === 'run' && app.photoMode) {
    if (!handlePhotoModeTap(p)) app.photoModeDrag = { x: p.x, y: p.y };
    return;
  }
  if (app.state === 'run') {
    if (app.run?.warmup && app.run.phase === 'finished') {
      localStorage.setItem('agility_onboarded', '1');
      startRun();
      return;
    }
    if (app.run.victoryLap && app.run.skipVictoryLap()) return;
    // Ритуал старта: тап по собаке — погладить (S3.1)
    if (app.run.phase === 'countdown') {
      const ds = renderer.toScreen(app.run.dog.x, app.run.dog.y, 0.5);
      if (Math.hypot(p.x - ds.x, p.y - ds.y) < renderer.cam.zoom * 2.0) { petDog(); return; }
    }
    // Тап по хендлеру — заявка риска (late-commit)
    if (app.run.phase === 'running' && app.run.focus?.count > 0) {
      const hs = renderer.toScreen(app.run.handler.x, app.run.handler.y, 0.8);
      if (Math.hypot(p.x - hs.x, p.y - hs.y) < renderer.cam.zoom * 1.6) {
        if (app.run.tryRisk()) return;
      }
    }
    // Магнит: тап засчитывается ближайшей кнопке в расширенной зоне —
    // промах пальца на пару миллиметров не должен глотать ввод.
    let best = null, bestD = Infinity;
    for (const b of touchButtons()) {
      const dd = Math.hypot(p.x - b.x, p.y - b.y);
      if (dd < bestD) { bestD = dd; best = b; }
    }
    // Стол «Замри»: во время счёта любой ввод = сброс — магнит сжимается до
    // точного попадания, чтобы случайный тап рядом с кнопкой не карал игрока
    const fm = app.run.activeMark;
    const freezing = fm?.qte?.def?.kind === 'freeze' && fm.qte.stage === 1;
    const magnetR = freezing ? 1.0 : 2.4;
    if (best && bestD <= best.r * magnetR) {
      touchPointers.set(e.pointerId, best.code);
      app.run.input(best.code, true);
    }
    return;
  }
  if (app.state === 'photo') { handlePhotoTap(p); return; }
  if (app.state === 'podium') { podiumContinue(); return; }
  if (app.state === 'treat') {
    if (p.y < canvas.height * 0.12) closeTreat(); else treatAdvance();
    return;
  }
  if (app.state === 'board' || app.state === 'quests') { app.state = 'menu'; audio.click(); return; }
  if (app.state === 'news') { newsContinue(); return; }
  if (app.state === 'champion') { toMenu(); audio.click(); return; }
  if (app.state === 'calib') {
    // Верхняя кромка — назад; остальное — тап калибровки
    if (p.y < canvas.height * 0.12) { app.state = 'settings'; audio.click(); }
    else calibInput();
    return;
  }
  if (app.state === 'trainer') {
    const sl = app.trainerSlider;
    if (sl && p.x >= sl.x - 12 && p.x <= sl.x + sl.w + 12 && p.y >= sl.y && p.y <= sl.y + sl.h) {
      const frac = Math.max(0, Math.min(1, (p.x - sl.sx) / sl.sw));
      app.trainer.bpm = Math.round(80 + frac * 90);
      settings.trainerBpm = app.trainer.bpm;
      saveSettings();
      app.trainer.restT = 0.01; // перезапуск захода с новым темпом
      return;
    }
    if (p.y < canvas.height * 0.12) { app.state = 'settings'; audio.click(); return; }
    trainerInput(p.x < canvas.width / 2 ? 'ArrowLeft' : 'ArrowRight');
    return;
  }
  if (app.state === 'shop') {
    if (!handleShopTap(p)) { app.state = 'menu'; audio.click(); }
    return;
  }
  if (app.state === 'settings') {
    if (!handleSettingsTap(p)) { app.state = 'menu'; audio.click(); }
    return;
  }
  if (app.state === 'dossier') {
    if (!handleDossierTap(p)) { app.state = 'menu'; audio.click(); }
    return;
  }
  // Питомник: палец либо тянет список, либо (если не потянул) закрывает экран
  if (app.state === 'kennel') {
    const L = kennelLayout();
    app.kennelDrag = {
      y0: p.y, y: p.y, scroll0: app.kennelScroll || 0, moved: 0,
      inside: p.x >= L.px && p.x <= L.px + L.pw && p.y >= L.py && p.y <= L.py + L.ph,
    };
    return;
  }
  if (app.state === 'archive') {
    if (!handleArchiveTap(p)) { app.state = 'menu'; audio.click(); }
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
  const stz = settingsZone();
  if (app.state === 'menu' && Math.hypot(p.x - stz.x, p.y - stz.y) < stz.r) {
    app.state = 'settings'; audio.click(); return;
  }
  const dsz = dossierZone();
  if (app.state === 'menu' && Math.hypot(p.x - dsz.x, p.y - dsz.y) < dsz.r) {
    app.state = 'dossier'; audio.click(); return;
  }
  const kez = kennelZone();
  if (app.state === 'menu' && Math.hypot(p.x - kez.x, p.y - kez.y) < kez.r) {
    openKennel(); audio.click(); return;
  }
  const arz = archiveZone();
  if (app.state === 'menu' && Math.hypot(p.x - arz.x, p.y - arz.y) < arz.r) {
    openArchive(); audio.click(); return;
  }
  const inZone = (zz) => zz && p.x >= zz.x && p.x <= zz.x + zz.w && p.y >= zz.y && p.y <= zz.y + zz.h;
  // Дуэль-реванш с пропущенным боссом (строка «Дуэли» на карте карьеры)
  if (app.state === 'menu' && app.mode === 'career') {
    for (const bz of app.bossZones || []) {
      if (inZone(bz)) {
        app.bossChallenge = bz.cls;
        audio.click();
        startRun();
        return;
      }
    }
  }
  if (app.state === 'menu' && inZone(app.chloeZoneMenu)) return openChloe();
  // Кнопки-стрелки переключателя режима
  if (app.state === 'menu' && app.modeArrows) {
    const { left, right } = app.modeArrows;
    if (Math.hypot(p.x - left.x, p.y - left.y) <= left.r) return menuKey('ArrowUp');
    if (Math.hypot(p.x - right.x, p.y - right.y) <= right.r) return menuKey('ArrowDown');
  }
  if (app.state === 'menu') menuClick(p.x, p.y);
  else if (app.state === 'results') {
    // Секвенция ещё идёт — первый тап всегда скип (в спокойном итоге Zen/практики
    // секвенции нет, и «съедать» первый тап нельзя — кнопки должны работать сразу)
    const calmRes = !!(app.run && (app.run.zen || app.run.practice));
    if (!calmRes && app.run && app.run.finishT < 3.4) { app.run.finishT = 3.4; audio.click(); return; }
    if (inZone(app.chloeZoneResults)) return openChloe();
    if (IS_TOUCH) {
      // Геометрия панели берётся из общего resultsPanel(): раньше здесь жила
      // своя (устаревшая) формула высоты, и хит-зоны уезжали от нарисованных кнопок.
      const { px: px2, py: py2, pw: pw2, ph: ph2, z: z2 } = resultsPanel();
      const pad = 8 * z2; // запас хит-зоны под палец
      for (const b of resultsButtons(px2, py2, pw2, ph2, z2)) {
        if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) {
          audio.click();
          if (b.id === 'next') return resultsKey('Enter');
          if (b.id === 'retry') return resultsKey('KeyR');
          if (b.id === 'treat') return openTreat();
          if (b.id === 'share') return shareResult();
          if (b.id === 'practice') return resultsKey('KeyP');
          if (b.id === 'menu') return resultsKey('Escape');
        }
      }
      return; // тап мимо кнопок — ничего (не случайный рестарт)
    }
    resultsKey('Enter');
  }
});
canvas.addEventListener('pointermove', (e) => {
  // Питомник: вертикальный свайп по списку целей (S4.10)
  if (app.state === 'kennel' && app.kennelDrag) {
    const kp = evXY(e);
    const dg2 = app.kennelDrag;
    dg2.moved = Math.max(dg2.moved, Math.abs(kp.y - dg2.y0));
    app.kennelScroll = dg2.scroll0 - (kp.y - dg2.y0);
    clampKennelScroll();
    dg2.y = kp.y;
    return;
  }
  // Фото-режим: тянем кадр пальцем/мышью (S3.8)
  const dg = app.photoModeDrag;
  if (!dg || !app.photoMode) return;
  const p = evXY(e);
  const k = renderer.cam.zoom || 1;
  renderer.cam.x -= (p.x - dg.x) / k;
  renderer.cam.y -= (p.y - dg.y) / (k * 0.86);
  dg.x = p.x; dg.y = p.y;
});

function releaseTouch(e) {
  app.photoModeDrag = null;
  // Питомник: палец отпущен без протяжки — это был тап. Тап мимо панели закрывает.
  if (app.state === 'kennel' && app.kennelDrag) {
    const dg = app.kennelDrag;
    app.kennelDrag = null;
    const z = Math.min(canvas.width, canvas.height) / 700;
    if (dg.moved < 6 * z && !dg.inside) { app.state = 'menu'; audio.click(); }
    return;
  }
  const code = touchPointers.get(e.pointerId);
  if (code) {
    touchPointers.delete(e.pointerId);
    if (app.state === 'run') app.run.input(code, false);
  }
}
canvas.addEventListener('pointerup', releaseTouch);
canvas.addEventListener('pointercancel', releaseTouch);
// Колесо мыши — прокрутка витрины целей (десктоп)
canvas.addEventListener('wheel', (e) => {
  if (app.state !== 'kennel') return;
  e.preventDefault();
  kennelScrollBy(e.deltaY * (e.deltaMode === 1 ? 16 : 1));
}, { passive: false });

function menuKey(code) {
  if (code === 'ArrowLeft') { app.breedIdx = (app.breedIdx + breedList.length - 1) % breedList.length; audio.click(); menuIdle.set('shake'); }
  if (code === 'ArrowRight') { app.breedIdx = (app.breedIdx + 1) % breedList.length; audio.click(); menuIdle.set('shake'); }
  if (code === 'ArrowUp' || code === 'ArrowDown') {
    const modes = MODE_ORDER;
    const dir = code === 'ArrowUp' ? -1 : 1;
    app.mode = modes[(modes.indexOf(app.mode) + dir + modes.length) % modes.length];
    audio.click();
  }
  if (code === 'Enter' || code === 'Space') startRun();
  if (code.startsWith('Digit')) {
    const n = +code.slice(5) - 1;
    if (n >= 0 && n < breedList.length) { app.breedIdx = n; audio.click(); menuIdle.set('shake'); }
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
        if (app.breedIdx === i) startRun(); else { app.breedIdx = i; audio.click(); menuIdle.set('shake'); }
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
      if (app.breedIdx === i) startRun(); else { app.breedIdx = i; audio.click(); menuIdle.set('shake'); }
      return;
    }
  }
  if (y > h * 0.76) startRun();
  if (y < h * 0.3) menuKey('ArrowDown');
}

function resultsKey(code) {
  const calm = !!(app.run && (app.run.zen || app.run.practice));
  // Практика: «ещё раз» = ещё загон по тому же снаряду, а не боевой прогон
  if (code === 'KeyR' && app.run?.practice) {
    return startPractice(app.run.practice.type, app.run.course.cls);
  }
  // Мгновенный рестарт (S1.1): R перезапускает сразу, даже во время секвенции —
  // не нужно сперва скипать протокол. Спидран-цикл без трения.
  if (code === 'KeyR') return startRun();
  // P — уйти в загон по проблемному снаряду (S4.9), если есть что тренировать
  if (code === 'KeyP') {
    const offer = practiceOffer();
    if (offer) return startPractice(offer.type, offer.cls);
    return;
  }
  // Первый инпут во время секвенции = скип к финальному состоянию протокола.
  // Спокойный итог (Zen/практика) секвенции не печатает — скипать нечего.
  if (!calm && app.run && app.run.finishT < 3.4 && code !== 'Escape') {
    app.run.finishT = 3.4;
    audio.click();
    return;
  }
  if (code === 'KeyS') return shareResult();
  if (code === 'KeyT') return openTreat();
  if (code === 'Enter' || code === 'Space') {
    // Zen и практика прогрессию не двигают: ни этапов карьеры, ни подиума —
    // просто следующий заход (прогулка / обычный старт после тренировки).
    if (calm) return startRun();
    // Подиум-церемония (S3.5): боссовые и турнирные заезды награждают перед выходом
    if (podiumPlace() && !app.podiumDone) { openPodium(); return; }
    // Тест-драйв: без прогрессии — просто ещё заход
    if (app.testDrive) return startRun();
    // Победа над боссом: сначала газетная вырезка, потом переход
    if (app.bossWin) {
      app.state = 'news';
      audio.click();
      return;
    }
    if (app.mode === 'career') {
      if (app.bossChallenge) {
        // Реванш проигран — та же дуэль ещё раз, прогресс не двигаем
      } else if (isBossStage()) {
        // Босс не побеждён — та же дуэль ещё раз (победа обработана в результатах)
      } else if (app.result && app.result.qualified) {
        app.stage++;
        if (app.stage > STAGES) {
          if (meta.bosses[app.cls] || !bossFor(app.cls)) {
            // Босс уже бит (или его нет) — легаси-переход класса
            if (app.cls !== 'masters') { app.cls = nextClass(app.cls); app.stage = 1; }
            else app.stage = STAGES;
          }
          // иначе stage = 6 — впереди дуэль с боссом
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

// Босс-этап: 6-я трасса класса — дуэль с призраком (если босс ещё не побеждён)
function isBossStage() {
  return app.mode === 'career' && app.stage > STAGES && !!bossFor(app.cls);
}

// После победы над боссом: класс закрыт, переход дальше (или гранд-финал → чемпион)
function applyBossVictory(bossCls) {
  meta.bosses[bossCls] = 1;
  if (bossCls === 'masters') meta.ngplusUnlocked = 1;
  // Переход класса — только у естественного босса текущего класса (этап 6).
  // Реванш с пропущенным боссом текущий прогресс не трогает.
  if (!app.bossChallenge && bossCls === app.cls && app.stage > STAGES && bossCls !== 'masters') {
    app.cls = nextClass(bossCls);
    app.stage = 1;
    saveProgress();
  }
  app.bossChallenge = null;
  saveMeta(meta);
}

// Погладить собаку на ритуале старта: главный крючок привязанности (S3.1)
function petDog() {
  if (!app.run) return;
  const first = !app.run.petted;
  if (!app.run.pet()) return;
  if (first) track('pet', { mode: app.mode, cls: app.cls, breed: breedList[app.breedIdx].id });
}

function toMenu() {
  app.state = 'menu';
  app.run = null;
  app.bossChallenge = null;
  // Перебег из архива живёт ровно до выхода в меню: следующий «Старт» в режиме
  // «трасса дня» снова даёт сегодняшнюю трассу, а не последнюю открытую из календаря.
  app.archiveDay = null;
  audio.crowdLevel(0);
}

function startRun() {
  const breed = breedList[app.breedIdx];
  if (breedLocked(breed)) {
    const a = ACHIEVEMENTS.find(x => x.id === breed.unlockAch);
    toasts.push({ icon: '🔒', name: breed.name, desc: `Открой: ${a?.desc || ''}`, t: 0 });
    audio.miss();
    return;
  }
  // Первый запуск: разминка во «Дворе» — 3 снаряда, провалить нельзя
  // (тест-драйв стартует сразу, без онбординга)
  if (!app.testDrive && !localStorage.getItem('agility_onboarded')) return startWarmup();
  // Смена дня в живой сессии: пересоздать daily/weekly-задания
  {
    const d = new Date();
    refreshQuests(meta, d.toDateString(), d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate());
    saveMeta(meta);
  }
  let course;
  if (app.mode === 'worldcup' && REAL_COURSES.length) {
    course = realToCourse(REAL_COURSES[app.realIdx % REAL_COURSES.length]);
  } else if (app.mode === 'zen') {
    // S4.12 «Прогулка в парке»: класс Open — щадящий и при этом живой. Novice дал
    // бы только барьеры и туннели (гулять скучно), Excellent+ тащит обманки,
    // фейк-паузы судьи и double-tap шину — механики про давление, которому
    // в Zen места нет. Open добавляет слалом и контактный снаряд: ритм есть,
    // подвоха нет. Сид крутится от прогона к прогону — парк каждый раз новый.
    app.zenIdx = (app.zenIdx || 0) + 1;
    course = generateCourse(931 + app.zenIdx * 17, 'open');
    course.name = '🌇 Прогулка в парке';
  } else if (app.mode === 'daily') {
    // Календарь-архив (S4.11) подкладывает параметры выбранного дня; без него — сегодня.
    const ad = app.archiveDay;
    course = generateCourse(ad ? ad.seed : todayNum() * 13 + 7, ad ? ad.cls : dailyCls());
    course.name = `Трасса дня ${ad ? ad.key : todayStr()}`;
  } else if (app.testDrive && TEST_MODE === 's1') {
    // Демо S1 «Game Feel» (?test=s1): короткая трасса, заточенная под новинки —
    // прыжки (hitstop/squash/микро-дельта/анти-спам обманок), groove-слалом
    // (хитсаунды/питч-лесенка/стресс-окно), финиш (медаль Тренера); призрак Эйва
    // даёт live-дельту. Excellent-класс включает обманки «?» для анти-спама.
    course = generateCourse(707, 'excellent', { forceTypes: [
      'jump', 'weave', 'aframe', 'tire', 'jump', 'tunnel', 'jump',
    ] });
    course.name = '✨ Демо S1 · Game Feel';
  } else if (app.testDrive) {
    // Тест-драйв V4 (?test=v4): все новые механики на одной трассе по порядку —
    // шина double-tap, чарж, серпантин, groove-слалом, стол «Замри», тройной
    course = generateCourse(4242, 'excellent', { forceTypes: [
      'jump', 'tire', 'spread', 'serpentine', 'weave', 'table', 'triple', 'seesaw', 'tunnel', 'jump',
    ] });
    course.name = '🧪 Тест-драйв V4 · все механики';
  } else if (isBossStage() || app.bossChallenge) {
    // Босс-этап (6-й) или реванш с пропущенным боссом: дуэльная трасса класса босса
    const bcls = app.bossChallenge || app.cls;
    const boss = bossFor(bcls);
    course = generateCourse(careerSeed(bcls, 1) * 31 + 17, bcls);
    course.name = `👻 ${app.bossChallenge ? 'Реванш' : 'Босс'}: ${boss.name} · ${SEASONS[bcls].name}`;
  } else {
    // Прогрессия внутри Novice: 1-2 — только прыжки, 3-4 — + слалом, 5 — + горка (превью Open).
    const variant = app.cls === 'novice'
      ? { weave: app.stage >= 3, contacts: app.stage >= 5 ? 1 : 0 }
      : {};
    course = generateCourse(careerSeed(app.cls, app.stage), app.cls, variant);
    course.name = `${CLASSES[app.cls].name} · трасса ${app.stage}/${STAGES}`;
  }
  const mod = MODIFIERS[activeModifier()];
  // Zen всегда идёт на закате: тёплый свет — половина настроения режима.
  renderer.theme = app.mode === 'zen' ? THEMES.sunset
    : pickTheme({ mode: app.mode, stage: app.stage, modifier: activeModifier() });
  const dressed = applyEquip(breed, dogState(meta, breed.id).equip, meta.owned);
  if (dressed.ringTheme) renderer.theme = dressed.ringTheme;
  // NG+ после гранд-финала: окна реакции ×0.85 — второй круг для ветеранов
  const ngMul = meta.ngplusUnlocked && settings.ngplus ? 0.85 : 1;
  app.run = new Run({ course, breed: dressed, audio, particles: fx, renderer,
    modifier: activeModifier(), windowMul: (mod.windowMul || 1) * ngMul,
    audioOffset: settings.audioOffset || 0,
    // S3: комментатору нужны кличка и личный рекорд трассы («темп рекорда ринга»)
    dogName: dogName(meta, breed),
    bestTime: (meta.counters.courseBest || {})[courseKey()] || null,
    // S4: ассист — из настроек (действует в любом режиме), Zen — из режима меню
    assist: !!settings.assist,
    zen: app.mode === 'zen' });
  // Перебег прошедшего дня — вне зачёта: очки/медаль/онлайн-топ не начисляются.
  // Флаг живёт на run, поэтому переживает переход run → results.
  app.run.unscored = !!(app.archiveDay && app.archiveDay.scored === false);
  app.bossWin = null;
  app.photo = null;          // кадр-полароид прошлого чистого прогона
  app.photoDone = false;
  app.podiumDone = false;
  app.podium = null;
  app.treatDone = false;
  app.photoMode = null;
  renderer.crowdStanding = false;
  if (app.testDrive) {
    // Для полноты картины — призрак-соперница Эйва (мраморная аусси)
    app.run.ghost = { name: 'Эйва', k: 1.05, time: app.run.sct * 1.05, look: 'aussie' };
    app.run.startLine = TEST_MODE === 's1'
      ? 'Демо Game Feel! Слушай слалом, лови ×2 риск, смотри дельту призрака.'
      : 'Тест-драйв! Пробуем всё новое: шину, заряд, серпантин, ритм-слалом, стол и тройной!';
    // Демо S1: ровно одна настоящая обманка (на 5-м снаряде) — показать механику
    if (TEST_MODE === 's1') app.run.demoDecoyOnce = 4;
  } else if (isBossStage() || app.bossChallenge) {
    const bcls = app.bossChallenge || app.cls;
    const boss = bossFor(bcls);
    app.run.ghost = { name: boss.name, k: boss.k, time: app.run.sct * boss.k, look: boss.breedLook };
    app.run.bossCls = bcls;
    app.run.startLine = pickLine('bossStart');
    toasts.push({ icon: '👻', name: boss.name, desc: boss.taunt, t: 0 });
  } else if (app.mode === 'zen') {
    app.run.startLine = 'Просто гуляем. Секундомер сегодня выходной — иди в своё удовольствие.';
  } else {
    app.run.startLine = startLineFor(app.mode, app.cls);
  }
  renderer.cam.x = course.start.x;
  renderer.cam.y = course.start.y;
  app.state = 'run';
  app.result = null;
  audio.crowdLevel(0.15);
  // Аналитика: старт забега (run_id связывает старт с исходом).
  app._runId = String(Date.now()) + '-' + (app._runN = (app._runN || 0) + 1);
  track('run_start', { run_id: app._runId, mode: app.mode, cls: app.cls, stage: app.stage,
    breed: breed.id, course: course.name });
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

// ---------- ПРАКТИКА-ЗАГОН (S4.9) ----------
// «Проблемный снаряд» = тот, на котором игрок реально сыпался в этом прогоне.
// Считаем по фактическим оценкам QTE (те же данные, что уходят в run_end.obstacles):
// берём тип с наибольшим числом промахов, при равенстве — где выше доля промахов,
// затем — который встретился раньше (обычно там и развалился прогон).
function problemObstacle(run) {
  if (!run || run.warmup || run.practice || run.zen || app.testDrive) return null;
  const stat = {};
  run.marks.forEach((m, i) => {
    const g = m.qte?.result?.grade;
    if (!g) return;
    const a = stat[m.o.type] || (stat[m.o.type] = { type: m.o.type, seen: 0, miss: 0, first: i });
    a.seen++;
    if (g === 'miss') a.miss++;
  });
  const bad = Object.values(stat).filter(a => a.miss > 0);
  if (!bad.length) return null;
  bad.sort((a, b) => b.miss - a.miss
    || (b.miss / b.seen) - (a.miss / a.seen)
    || a.first - b.first);
  return bad[0].type;
}

// Кнопка практики предлагается, только если есть что тренировать
function practiceOffer() {
  if (app.state !== 'results') return null;
  const t = problemObstacle(app.run);
  return t ? { type: t, cls: app.run.course.cls || app.cls } : null;
}

// Загон: 5 повторов одного снаряда, первые 3 попытки в 0.7× темпе, ничего
// не начисляется (run.unscored). Класс берём тот же, что был в провальном
// прогоне: механика снаряда зависит от класса (шина с апексом, фейк-паузы стола),
// и тренировать надо ровно ту версию, на которой игрок посыпался.
function startPractice(type, cls) {
  const kls = CLASSES[cls] ? cls : 'open';
  const course = generateCourse(1700 + (app._practiceN = (app._practiceN || 0) + 1) * 29, kls,
    { forceTypes: [type, type, type, type, type] });
  course.name = `🎯 Загон · ${OBSTACLE_NAMES[type] || type}`;
  const breed = breedList[app.breedIdx];
  renderer.theme = THEMES.day;
  const dressed = applyEquip(breed, dogState(meta, breed.id).equip, meta.owned);
  app.run = new Run({ course, breed: dressed, audio, particles: fx, renderer,
    assist: !!settings.assist,
    dogName: dogName(meta, breed),
    practice: { type, slowTries: 3 } });
  app.run.startLine = `Разберём ${OBSTACLE_NAMES[type] || type}. Первые заходы — медленно, торопиться некуда.`;
  renderer.cam.x = course.start.x;
  renderer.cam.y = course.start.y;
  app.state = 'run';
  app.result = null;
  app.bossWin = null;
  app.photo = null;
  app.photoDone = false;
  app.podiumDone = false;
  app.podium = null;
  app.treatDone = false;
  app.photoMode = null;
  renderer.crowdStanding = false;
  audio.crowdLevel(0.05);
  app._runId = String(Date.now()) + '-' + (app._runN = (app._runN || 0) + 1);
  track('practice_start', { run_id: app._runId, obstacle: type, cls: kls, mode: app.mode });
}

// ---------- HUD ----------
// Сдвиг центрального текста шапки: в портрете панель со звёздами выше, и имя
// класса/модификатор/комментатор должны уехать вниз ровно на добавленную строку.
let hudShiftY = 0;
// Анимация звёзд живёт в модуле, а не в Run: game.js — не наш файл, да и это
// чисто визуальное состояние. Помним последний count и кто из слотов «вспыхнул».
const starFx = { seen: -1, t: -9, dir: 0, idx: -1 };
// То же для окна чистого выхода: Run отдаёт только момент закрытия, а для кольца
// нужен момент открытия — засекаем его сами при смене until.
const cleanFx = { until: -1, from: 0 };

// Пятиконечная звезда: заливка = получена, контур = пустой слот.
// Форма (заливка/контур) сама по себе несёт смысл — читается и в колорблайнде.
function starGlyph(ctx, cx, cy, r, filled, color) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5;
    const rr = i % 2 ? r * 0.44 : r;
    ctx[i ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
  if (filled) { ctx.fillStyle = color; ctx.fill(); }
  else { ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, r * 0.18); ctx.stroke(); }
}

// Ряд звёзд Punch-Out (S4.7): пустые слоты видны всегда — игрок сразу понимает,
// что их три. Появление и сжигание — короткая вспышка: это момент драмы.
function drawStarRow(ctx, run, x, cy, z) {
  const st = run.stars;
  const max = st.max || 3;
  const count = Math.max(0, Math.min(max, st.count | 0));
  if (starFx.seen !== count) {
    // первый кадр не анимируем — иначе вспышка на рестарте забега
    if (starFx.seen >= 0) {
      starFx.t = app.t;
      starFx.dir = count > starFx.seen ? 1 : -1;
      starFx.idx = Math.max(count, starFx.seen) - 1;
    }
    starFx.seen = count;
  }
  const flash = Math.max(0, 1 - (app.t - starFx.t) / 0.45);
  const step = 23 * z, r = 9 * z;
  ctx.save();
  for (let i = 0; i < max; i++) {
    const sx = x + step * (i + 0.5);
    const hot = i === starFx.idx && flash > 0;
    const sc = hot ? 1 + Math.sin(flash * Math.PI) * 0.55 : 1;
    const filled = i < count;
    let color = filled ? '#ffd54a' : 'rgba(255,255,255,0.34)';
    if (hot) color = starFx.dir > 0 ? '#fffbe6' : '#ff6b6b';
    starGlyph(ctx, sx, cy, r * sc, filled, color);
  }
  // Финиш заряжен — главная мотивация не мазать на последнем снаряде
  if (st.isFinishArmed?.() === true) {
    const p = 0.5 + 0.5 * Math.sin(app.t * 6);
    // Подпись слева направо сразу за звёздами: у правого края панели живёт
    // кнопка звука, туда лезть нельзя.
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.round(14 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = `rgba(255,213,74,${0.6 + 0.4 * p})`;
    ctx.fillText('ФИНИШ ×2', x + step * max + 8 * z, cy);
  }
  ctx.restore();
}

// Намёк на окно чистого выхода (S4.6): маленькое кольцо над собакой, которое
// «сдувается» вместе с окном. Ни баннеров, ни текста — механика для своих.
function drawCleanExitHint(run, z) {
  const ce = run.cleanExit;
  if (!ce || ce.used || !run.dog || !(run.time < ce.until)) return;
  if (cleanFx.until !== ce.until) { cleanFx.until = ce.until; cleanFx.from = run.time; }
  const span = Math.max(0.12, ce.until - cleanFx.from);
  const k = Math.max(0, Math.min(1, (ce.until - run.time) / span));
  const s = renderer.toScreen(run.dog.x, run.dog.y, 1.6);
  const ctx = renderer.ctx;
  ctx.save();
  ctx.globalAlpha = 0.25 + 0.5 * k;
  ctx.strokeStyle = '#9ff0b4'; ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(s.x, s.y, 9 * z, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#9ff0b4';
  ctx.beginPath(); ctx.arc(s.x, s.y, 2 * z, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawHud(run) {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;

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

  // Верхняя панель: снаряды, время (или — в Zen/практике — то, что уместно)
  ctx.save();
  ctx.font = `bold ${Math.round(22 * z)}px "Segoe UI", sans-serif`;
  // Zen: таймера нет (run.timed === false) — панель ужимается до одной строки
  panel(ctx, 14, 14, 300 * z, (run.timed ? 88 : 56) * z);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const done = run.marks.filter(m => m.resolved).length;
  ctx.fillText(`Снаряд ${Math.min(done + 1, run.marks.length)}/${run.marks.length}`, 30, 26 * z);
  if (run.practice) {
    // Практика-загон: вместо секундомера — попытка и текущий темп. Игрок должен
    // видеть, что первые заходы медленнее, и поймать момент выхода на полный темп.
    const p = run.practice;
    const full = p.tries >= p.slowTries;
    ctx.font = `bold ${Math.round(19 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = full ? '#ffd54a' : '#8fd8ff';
    ctx.fillText(`Попытка ${p.tries + 1} · темп ${Math.round(p.speedMul * 100)}%` +
      (full ? ' — полный!' : ` → 100% через ${p.slowTries - p.tries}`), 30, 56 * z);
  } else if (run.timed) {
    const overSct = run.time > run.sct;
    ctx.fillStyle = overSct ? '#ff6b6b' : '#c8f7d0';
    ctx.fillText(`${run.time.toFixed(1)}с / SCT ${run.sct}с`, 30, 56 * z);
  }
  ctx.restore();

  // Zen и практика: правой панели с фолтами/риском/звёздами нет вовсе — судить
  // некому, оценка была бы враньём. Комбо оставляем строкой без панели:
  // оно ведёт темп и слои музыки, это информация, а не приговор.
  if (!run.timed || run.practice) {
    ctx.save();
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.font = `bold ${Math.round(20 * z)}px "Segoe UI", sans-serif`;
    const cb = Math.floor(run.score.combo);
    const tag = run.practice ? '🎯 Загон' : '🌇 Прогулка';
    ctx.fillStyle = cb >= 3 ? 'rgba(255,213,74,0.9)' : 'rgba(255,255,255,0.6)';
    ctx.fillText(cb > 0 ? `${tag} · ритм ×${cb}` : tag, w - 30, 26 * z);
    ctx.restore();
    hudShiftY = 0;
    drawHudTail(run, z);
    return;
  }

  ctx.save();
  // Панель растёт на одну строку только если есть И риск, И звёзды — иначе
  // звёзды садятся на свободную третью строку и высота остаётся прежней.
  const riskOn = !!run.focus, starsOn = !!run.stars;
  const rx = w - 230 * z - 14;
  panel(ctx, rx, 14, 230 * z, (riskOn && starsOn ? 140 : 112) * z);
  ctx.font = `bold ${Math.round(22 * z)}px "Segoe UI", sans-serif`;
  ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  ctx.fillStyle = run.score.faults ? '#ff8a8a' : '#fff';
  ctx.fillText(`Фолты: ${run.score.faults}`, w - 30, 26 * z);
  const combo = Math.floor(run.score.combo);
  ctx.fillStyle = combo >= 3 ? '#ffd54a' : '#cfd8dc';
  // Надбавка «чистого выхода» (S4.6) — приписка к комбо, и только когда она есть:
  // механика для своих, новичка не заваливаем лишним текстом.
  const ceBonus = run.cleanExitBonus > 0 ? ` +${run.cleanExitBonus.toFixed(1)}` : '';
  const comboTxt = combo > 0 ? `Комбо ×${combo}${ceBonus}` : 'Комбо —';
  // Дыхание в бит (S4.1): только число комбо и только на наградном лид-слое
  // (комбо ≥8). Позиции панелей и кнопок не трогаем — их проверяет e2e.
  const beat = combo >= 8 ? (audio.music?.pulse?.() ?? 0) : 0;
  if (beat > 0.01) {
    ctx.save();
    ctx.translate(w - 30, 56 * z);
    ctx.scale(1 + beat * 0.02, 1 + beat * 0.02);
    ctx.fillText(comboTxt, 0, 0);
    ctx.restore();
  } else ctx.fillText(comboTxt, w - 30, 56 * z);
  // Фокусы риска: ⚡ доступные заявки late-commit (Shift / тап по хендлеру)
  if (riskOn) {
    ctx.font = `bold ${Math.round(17 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = run.focus.count > 0 ? '#ff8a65' : 'rgba(255,255,255,0.3)';
    const bolts = '⚡'.repeat(run.focus.count) + '·'.repeat(run.focus.max - run.focus.count);
    ctx.fillText(`Риск ${bolts}`, w - 30, 88 * z);
  }
  // Звёзды Punch-Out (S4.7)
  if (starsOn) drawStarRow(ctx, run, rx + 14 * z, (riskOn ? 127 : 97) * z, z);
  ctx.restore();
  // В портрете панели идут во всю ширину — центральный текст съезжает вниз ровно
  // на добавленную строку, иначе имя класса наедет на звёзды.
  hudShiftY = (riskOn && starsOn && isPortrait()) ? 30 * z : 0;

  drawHudTail(run, z);
}

// Общая часть HUD ниже панелей: имя трассы, комментатор, ритуал старта,
// подсказки, QTE, реплики, тач-кнопки. Одна для боевого забега и для Zen —
// в Zen меняется только «шапка» с панелями, а мир и подсказки те же.
function drawHudTail(run, z) {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  // Класс и порода (в портрете — под панелями, чтобы не наезжать)
  ctx.save();
  ctx.font = `${Math.round(15 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.textAlign = 'center';
  const cname = run.course.name || run.course.class.name;
  const modName = MODIFIERS[run.modifier]?.name;
  ctx.fillText(`${cname} · ${breedList[app.breedIdx].name}`, w / 2, (isPortrait() ? 118 : 22) * z + hudShiftY);
  // Вторая строка шапки: модификатор дня и/или напоминание про ассист.
  // Игрок не должен «забыть», что окна расширены и косточки урезаны, —
  // поэтому метка висит весь забег, а не всплывает разово.
  const subParts = [];
  if (modName) subParts.push(modName);
  if (run.assist) subParts.push('🤝 Ассист: окна +50% · 🦴 ×0.5');
  if (subParts.length) {
    ctx.fillStyle = modName ? '#ffab6b' : '#9ff0b4';
    ctx.fillText(subParts.join('  ·  '), w / 2, (isPortrait() ? 140 : 44) * z + hudShiftY);
  }
  ctx.restore();

  // Перебег из архива (S4.11): честная плашка — результат никуда не идёт.
  // Ниже строки комментатора (72z/168z), иначе они дерутся за одно место.
  if (run.unscored) {
    drawUnscoredBadge(ctx, w / 2, (isPortrait() ? 198 : 102) * z + hudShiftY, z,
      run.practice ? '🎯 Тренировка — очки и награды не начисляются' : null);
  }

  // Радио-строка комментатора (S3): трансляция ринга по триггерам забега
  drawCommentary(run, z);

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

  // Приглашение погладить собаку в стойке (S3.1) — и подтверждение баффа
  if (run.phase === 'countdown') {
    const petMsg = run.petted ? '💙 Спокойный старт — дрожь ушла'
      : (IS_TOUCH ? '🐾 Погладь собаку — тапни по ней' : '🐾 Погладь собаку — тап по ней или P');
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(16 * z)}px "Segoe UI", sans-serif`;
    const tw = ctx.measureText(petMsg).width;
    const py2 = canvas.height * 0.56;
    ctx.globalAlpha = run.petted ? 1 : (Math.sin(app.t * 4) > -0.4 ? 1 : 0.55);
    ctx.fillStyle = 'rgba(20,40,60,0.7)';
    ctx.strokeStyle = run.petted ? 'rgba(159,240,180,0.8)' : 'rgba(240,98,146,0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(w / 2 - tw / 2 - 14 * z, py2 - 15 * z, tw + 28 * z, 26 * z, 13 * z);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = run.petted ? '#9ff0b4' : '#ffd9e5';
    ctx.fillText(petMsg, w / 2, py2 + 3 * z);
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

  // Окно «чистого выхода» (S4.6) — скромный намёк у собаки, без баннеров
  drawCleanExitHint(run, z);

  // Подсказка риска (S1): пока можно заявить (окно ещё не открыто, есть фокус) —
  // мигающая плашка «SHIFT / тап по хендлеру = риск ×2». SHIFT неочевиден без неё.
  if (m && m.qte && m.qte.state === 'active' && run.phase === 'running'
      && run.focus?.count > 0 && !m.risk
      && (m.qte.def.kind === 'press' || m.qte.def.kind === 'doubleTap')
      && !(m.decoys && !m.decoys.revealed)) {
    const tq = run.time - m.qteStart;
    if (tq < m.qte.target - m.qte.w) {
      ctx.save();
      ctx.textAlign = 'center';
      const blink = Math.sin(run.time * 6) > -0.2;
      const txt = IS_TOUCH ? '⚡ Тап по хендлеру — риск ×2' : '⚡ SHIFT — риск ×2';
      ctx.font = `bold ${Math.round(15 * z)}px "Segoe UI", sans-serif`;
      const tw = ctx.measureText(txt).width;
      const ry = IS_TOUCH ? h * 0.4 : h * 0.68;
      ctx.globalAlpha = blink ? 1 : 0.5;
      ctx.fillStyle = 'rgba(40,20,10,0.8)';
      ctx.beginPath(); ctx.roundRect(w / 2 - tw / 2 - 12 * z, ry - 15 * z, tw + 24 * z, 26 * z, 8 * z); ctx.fill();
      ctx.fillStyle = '#ff8a65';
      ctx.fillText(txt, w / 2, ry + 2 * z);
      ctx.restore();
    }
  }

  // Реплика хендлера: на ритуале старта и сразу после финиша
  const line = run.phase === 'countdown' ? run.startLine
    : (run.phase === 'finished' && run.finishT < 2.6 ? run.finishLine : null);
  if (line) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = `italic bold ${Math.round(17 * z)}px "Segoe UI", sans-serif`;
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    const ly = h * (IS_TOUCH ? 0.3 : 0.76);
    ctx.strokeText(`«${line}»`, w / 2, ly);
    ctx.fillStyle = '#ffe9c4';
    ctx.fillText(`«${line}»`, w / 2, ly);
    ctx.restore();
  }

  if (IS_TOUCH) drawTouchControls(run);
}

// Комментатор ринга (S3.4): одна строка «радио-трансляции» под шапкой HUD.
// Появляется с проездом слева, живёт 2.5–4.5с, гаснет — не спорит с QTE внизу.
function drawCommentary(run, z) {
  const line = run.commentator?.line;
  if (!line) return;
  const ctx = renderer.ctx, w = canvas.width;
  const inK = Math.min(1, line.t / 0.25);
  const outK = Math.min(1, Math.max(0, (line.life - line.t) / 0.4));
  const y = (isPortrait() ? 168 : 72) * z + hudShiftY;
  ctx.save();
  ctx.globalAlpha = Math.min(inK, outK);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  let fs = Math.round((isPortrait() ? 14 : 16) * z);
  ctx.font = `italic ${fs}px "Segoe UI", sans-serif`;
  const maxW = w * (isPortrait() ? 0.9 : 0.62);
  let txt = line.text;
  while (ctx.measureText(txt).width > maxW - 44 * z && txt.length > 12) txt = txt.slice(0, -2);
  if (txt !== line.text) txt += '…';
  const tw = ctx.measureText(txt).width;
  const pw2 = tw + 46 * z, ph2 = 28 * z;
  const px2 = w / 2 - pw2 / 2 + (1 - inK) * -20 * z;
  ctx.fillStyle = 'rgba(8,16,12,0.78)';
  ctx.strokeStyle = 'rgba(143,216,255,0.45)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(px2, y - ph2 / 2, pw2, ph2, ph2 / 2); ctx.fill(); ctx.stroke();
  ctx.font = `${Math.round(fs * 0.95)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = '#8fd8ff';
  ctx.fillText('🎙', px2 + 12 * z, y + 1);
  ctx.font = `italic ${fs}px "Segoe UI", sans-serif`;
  ctx.fillStyle = '#dff0ff';
  ctx.fillText(txt, px2 + 36 * z, y + 1);
  ctx.restore();
  ctx.textBaseline = 'alphabetic';
}

function expectedKey(run) {
  const m = run?.activeMark;
  if (!m || !m.qte || m.qte.state !== 'active') return null;
  if (m.decoys && !m.decoys.revealed) return null; // не палим кнопку до раскрытия
  const q = m.qte, d = q.def;
  if (d.kind === 'rhythm' || d.kind === 'groove') return d.keys[q.beatIdx % 2];
  if (d.kind === 'twoStage') return q.stage === 1 ? d.key2 : d.key;
  if (d.kind === 'serp') {
    // Направление раскрывается за reveal до бита; на таче чуть раньше —
    // палец должен успеть дойти до кнопки после подсветки
    const t = run.time - m.qteStart;
    const beatT = q.target + q.beatIdx * d.beat;
    return t >= beatT - (IS_TOUCH ? 1.0 : d.reveal) ? q.seq[q.beatIdx] : null;
  }
  if (d.kind === 'freeze') return q.stage === 1 ? null : d.key; // во время счёта НЕ жать
  return q.pressKey || d.key; // настоящая обманка: подсвечиваем раскрытую клавишу
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
    // Босс класса: 👑 побеждён / 👻 текущая дуэль / силуэт впереди
    if (bossFor(cls)) {
      const bx = rx + (86 + STAGES * 26) * z;
      const beaten = !!meta.bosses[cls];
      const isCurBoss = ci === curClsIdx && app.stage > STAGES;
      if (isCurBoss) {
        const pulse = 1 + Math.sin(app.t * 5) * 0.15;
        ctx.font = `bold ${Math.round((portrait ? 13 : 15) * z * pulse)}px "Segoe UI", sans-serif`;
        ctx.fillStyle = '#b388ff';
        ctx.fillText('👻', bx, ry);
        ctx.font = `${Math.round(portrait ? 12 * z : 14 * z)}px "Segoe UI", sans-serif`;
      } else {
        ctx.fillStyle = beaten ? '#ffd54a' : 'rgba(255,255,255,0.35)';
        ctx.fillText(beaten ? '👑' : (locked ? '' : '👻'), bx, ry);
      }
      ctx.fillStyle = locked ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.85)';
    }
  });

  // Пропущенные боссы прошлых классов: старый прогресс обгонял появление боссов
  // (сейв с cls=excellent никогда не встретит Эйву). Строка «Дуэли» — тап по
  // призраку запускает реванш БЕЗ сдвига текущего прогресса.
  app.bossZones = [];
  let extraRows = 0;
  const missed = CLASS_ORDER.filter((cls2, ci2) =>
    ci2 < curClsIdx && bossFor(cls2) && !meta.bosses[cls2]);
  if (missed.length) {
    extraRows = 1;
    const dy = y + (portrait ? 1 : 2) * 19 * z + 6 * z;
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(13.5 * z)}px "Segoe UI", sans-serif`;
    const prefix = '⚔ Дуэли: ';
    const parts = missed.map(cls2 => `👻 ${bossFor(cls2).name}`);
    const full = prefix + parts.join('  ·  ') + ' — тапни!';
    ctx.fillStyle = '#d1b3ff';
    ctx.fillText(full, cx, dy);
    const totalW = ctx.measureText(full).width;
    let xCursor = cx - totalW / 2 + ctx.measureText(prefix).width;
    const sepW = ctx.measureText('  ·  ').width;
    missed.forEach((cls2, i) => {
      const pw2 = ctx.measureText(parts[i]).width;
      app.bossZones.push({ cls: cls2, x: xCursor - 8, y: dy - 15 * z, w: pw2 + 16, h: 22 * z });
      xCursor += pw2 + sepW;
    });
  }
  ctx.restore();
  return extraRows;
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

  // Заначка стрика (S1.5): защищает серию трассы дня при пропуске, макс 2
  const frz = meta.streak.freezes || 0;
  const frzMax = frz >= FREEZE_MAX;
  const ft = `🧊 Заначка стрика ${frz}/${FREEZE_MAX}${frzMax ? '' : ` — ${FREEZE_COST}🦴`}`;
  ctx.font = `bold ${Math.round(13 * z)}px "Segoe UI", sans-serif`;
  const ftw = ctx.measureText(ft).width;
  const fzx = w / 2 - ftw / 2 - 10 * z, fzy = py + 70 * z;
  ctx.fillStyle = frzMax ? 'rgba(120,180,255,0.15)' : 'rgba(120,180,255,0.22)';
  ctx.strokeStyle = '#7fbfff'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(fzx, fzy - 13 * z, ftw + 20 * z, 22 * z, 8 * z); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#cfe4ff'; ctx.textAlign = 'center';
  ctx.fillText(ft, w / 2, fzy + 1 * z);
  app.freezeBuyZone = frzMax ? null : { x: fzx, y: fzy - 13 * z, w: ftw + 20 * z, h: 22 * z };

  const dnum = (new Date().getFullYear()) * 10000 + (new Date().getMonth() + 1) * 100 + new Date().getDate();
  const showcase = dailyShowcase(dnum);
  const cols = isPortrait() ? 2 : 4;
  const cw = (pw - 32 * z) / cols, chh = 62 * z;
  const equip = dogState(meta, breed.id).equip;
  app.shopCells = [];
  // Только применимое к выбранной породе: чужие окрасы не показываем,
  // иначе каталог не влезает в панель (лишние ряды обрезались молча).
  // Группируем по слотам — окрасы первыми, чтобы на портретной обрезке
  // не терялись предметы своей породы.
  const slotOrder = { coat: 0, neck: 1, paws: 2, finish: 3, handler: 4, ring: 5 };
  const visibleItems = ITEMS
    .filter(it => it.slot !== 'coat' || !it.breed || it.breed === breed.id)
    .sort((a, b) => (slotOrder[a.slot] ?? 9) - (slotOrder[b.slot] ?? 9));
  visibleItems.forEach((it, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = px + 16 * z + col * cw, y = py + 98 * z + row * (chh + 6 * z);
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
  // Покупка заначки стрика
  const fz = app.freezeBuyZone;
  if (fz && p.x >= fz.x && p.x <= fz.x + fz.w && p.y >= fz.y && p.y <= fz.y + fz.h) {
    if ((meta.streak.freezes || 0) >= FREEZE_MAX) return true;
    if (meta.bones >= FREEZE_COST) {
      meta.bones -= FREEZE_COST;
      meta.streak.freezes = (meta.streak.freezes || 0) + 1;
      saveMeta(meta);
      track('freeze_buy', { cost: FREEZE_COST, total: meta.streak.freezes });
      toasts.push({ icon: '🧊', name: 'Заначка куплена!', desc: 'Спасёт стрик при пропуске дня', t: 0 });
      audio.good();
    } else {
      toasts.push({ icon: '🦴', name: 'Не хватает косточек', desc: `Нужно ${FREEZE_COST}`, t: 0 });
      audio.miss();
    }
    return true;
  }
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
          menuIdle.set('shake'); // собака отряхивается, примеряя обновку
        }
      } else {
        const dnum = (new Date().getFullYear()) * 10000 + (new Date().getMonth() + 1) * 100 + new Date().getDate();
        const sale = dailyShowcase(dnum).includes(it.id);
        const pr = priceOf(it);
        const bonesCost = pr.bones ? Math.round(pr.bones * (sale ? 0.7 : 1)) : 0;
        if (pr.rosettes && !pr.bones) {
          if (meta.rosettes >= pr.rosettes) {
            meta.rosettes -= pr.rosettes; meta.owned[it.id] = 1;
            track('cosmetic_buy', { item: it.id, slot: it.slot, rarity: it.rarity, currency: 'rosettes', cost: pr.rosettes });
            toasts.push({ icon: '🛍', name: 'Куплено!', desc: it.name, t: 0 });
            audio.perfect();
          } else { toasts.push({ icon: '🏵️', name: 'Не хватает розеток', desc: `Нужно ${pr.rosettes}`, t: 0 }); audio.miss(); }
        } else if (meta.bones >= bonesCost) {
          meta.bones -= bonesCost; meta.owned[it.id] = 1;
          track('cosmetic_buy', { item: it.id, slot: it.slot, rarity: it.rarity, currency: 'bones', cost: bonesCost, sale });
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

  // Календарь трассы дня: 30 клеток, заполненные — дни серии
  const calY = py + 358 * z;
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `${Math.round(13 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(`СЕРИЯ ТРАССЫ ДНЯ: ${meta.streak.count} дн (множитель ×${streakMult(meta.streak.count)})`, px + 28 * z, calY - 12 * z);
  for (let i = 0; i < 30; i++) {
    const cxq = px + 28 * z + (i % 15) * 18 * z;
    const cyq = calY + Math.floor(i / 15) * 18 * z;
    const filled = i < Math.min(30, meta.streak.count);
    ctx.beginPath();
    ctx.fillStyle = filled ? '#ffd54a' : 'rgba(255,255,255,0.15)';
    ctx.arc(cxq, cyq, 6 * z, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffe9a8';
  ctx.font = `${Math.round(14 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(`Все 3 дневных = +50 🦴 бонусом · Баланс: 🦴 ${meta.bones} · 🏵️ ${meta.rosettes}`, w / 2, py + ph - 44 * z);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText('J / ESC / тап — назад', w / 2, py + ph - 18 * z);
  ctx.restore();
}

// ---------- НАСТРОЙКИ (доступность) ----------
function settingsRows(px, py, pw, z) {
  const offMs = Math.round((settings.audioOffset || 0) * 1000);
  const rows = [
    { id: 'shake', name: 'Тряска экрана', kind: 'toggle', y: py + 82 * z },
    { id: 'colorblind', name: 'Колорблайнд: форма дублирует цвет', kind: 'toggle', y: py + 126 * z },
    { id: 'haptics', name: 'Вибрация (тач)', kind: 'toggle', y: py + 170 * z },
    // Название прямо называет и помощь, и её цену — чтобы игрок не чувствовал
    // себя обманутым ни включая ассист, ни увидев урезанную награду.
    { id: 'assist', name: '🤝 Хендлер помогает · окна +50%, 🦴 ×0.5', kind: 'toggle', y: py + 214 * z },
    { id: 'music', name: 'Музыка', kind: 'slider', y: py + 268 * z },
    { id: 'sfx', name: 'Звуки', kind: 'slider', y: py + 318 * z },
    { id: 'calib', name: `🎧 Калибровка звука (${offMs >= 0 ? '+' : ''}${offMs} мс)`, kind: 'button', y: py + 372 * z },
    { id: 'trainer', name: '🎵 Тренировка змейки', kind: 'button', y: py + 416 * z },
  ];
  if (meta.ngplusUnlocked) {
    rows.push({ id: 'ngplus', name: '👑 NG+ · окна реакции ×0.85', kind: 'toggle', y: py + 460 * z });
  }
  return rows;
}

function drawSettings() {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;
  ctx.save();
  ctx.fillStyle = 'rgba(6,12,10,0.85)';
  ctx.fillRect(0, 0, w, h);
  const pw = Math.min(520 * z, w * 0.94);
  // +44z к высоте панели — под строку ассиста (S4.8), иначе последняя строка
  // и подпись «O / ESC — назад» дерутся за одно место.
  const ph = Math.min((meta.ngplusUnlocked ? 554 : 514) * z, h * 0.92);
  const px = w / 2 - pw / 2, py = h / 2 - ph / 2;
  panel(ctx, px, py, pw, ph);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd54a';
  ctx.font = `900 ${Math.round(24 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('⚙ Настройки', w / 2, py + 40 * z);
  app.settingsRows = settingsRows(px, py, pw, z).map(r => ({ ...r, px, pw }));
  for (const r of app.settingsRows) {
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(15 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(r.name, px + 28 * z, r.y);
    if (r.kind === 'button') {
      // Кнопка-строка целиком: рамка вокруг названия
      const bw2 = pw - 48 * z;
      ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(px + 20 * z, r.y - 22 * z, bw2, 34 * z, 8 * z); ctx.stroke();
      r.hit = { x: px + 20 * z, y: r.y - 22 * z, w: bw2, h: 34 * z };
    } else if (r.kind === 'toggle') {
      const on = !!settings[r.id];
      const tx = px + pw - 84 * z, ty = r.y - 13 * z;
      ctx.fillStyle = on ? '#4caf6d' : 'rgba(255,255,255,0.2)';
      ctx.beginPath(); ctx.roundRect(tx, ty, 52 * z, 22 * z, 11 * z); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(tx + (on ? 40 : 12) * z, ty + 11 * z, 8.5 * z, 0, Math.PI * 2); ctx.fill();
      r.hit = { x: tx - 8, y: ty - 8, w: 52 * z + 16, h: 22 * z + 16 };
    } else {
      const sx = px + 28 * z, sw = pw - 56 * z, sy = r.y + 12 * z;
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(sx, sy, sw, 8 * z);
      ctx.fillStyle = '#ffd54a';
      ctx.fillRect(sx, sy, sw * settings[r.id], 8 * z);
      ctx.beginPath(); ctx.arc(sx + sw * settings[r.id], sy + 4 * z, 9 * z, 0, Math.PI * 2); ctx.fill();
      r.hit = { x: sx - 10, y: sy - 14 * z, w: sw + 20, h: 30 * z, sx, sw };
    }
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = `${Math.round(14 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('O / ESC / тап мимо — назад', w / 2, py + ph - 20 * z);
  ctx.restore();
}

function handleSettingsTap(p) {
  for (const r of app.settingsRows || []) {
    const hh = r.hit;
    if (hh && p.x >= hh.x && p.x <= hh.x + hh.w && p.y >= hh.y && p.y <= hh.y + hh.h) {
      if (r.kind === 'button') {
        if (r.id === 'calib') startCalib();
        else if (r.id === 'trainer') startTrainer();
      } else if (r.kind === 'toggle') settings[r.id] = !settings[r.id];
      else settings[r.id] = Math.max(0, Math.min(1, (p.x - hh.sx) / hh.sw));
      saveSettings();
      audio.click();
      return true;
    }
  }
  return false;
}

// ---------- УГОЩЕНИЕ ПОСЛЕ ЗАБЕГА (S3.6) ----------
// Пятисекундный ритуал в один тап: сидеть → дай лапу → печенька. Полностью
// необязателен (урок Little Friends: ритуал не должен превращаться в работу).
const TREAT_STEPS = [
  { cmd: 'Сидеть!', pose: 'sit', hint: 'Тап / ПРОБЕЛ — команда' },
  { cmd: 'Дай лапу!', pose: 'paw', hint: 'Тап / ПРОБЕЛ — команда' },
  { cmd: 'Печенька! 🍪', pose: 'chew', hint: 'Тап / ПРОБЕЛ — угостить' },
];
const TREAT_XP = 40;

function openTreat() {
  if (app.treatDone) return;
  app.treat = { step: 0, t: 0, done: false, xp: 0 };
  app.state = 'treat';
  audio.click();
}

function treatAdvance() {
  const tr = app.treat;
  if (!tr) return;
  if (tr.done) { closeTreat(); return; }
  tr.step++;
  tr.t = 0;
  audio.good();
  if (tr.step >= TREAT_STEPS.length) {
    // Печенька съедена: сердечки, XP-бонус, уровни как обычно
    tr.done = true;
    tr.step = TREAT_STEPS.length - 1;
    const breedId = breedList[app.breedIdx].id;
    const xp = addXp(meta, breedId, TREAT_XP);
    tr.xp = TREAT_XP;
    for (const L of xp.levelsUp) {
      const tag = titleFor(L);
      toasts.push({ icon: '🐕', name: `Уровень ${L}!`, desc: tag ? `Новый титул: ${tag}` : 'Собака растёт', t: 0 });
    }
    saveMeta(meta);
    app.treatDone = true;
    audio.perfect();
    track('treat', { breed: breedId, xp: TREAT_XP });
  }
}

function closeTreat() {
  app.treat = null;
  app.state = 'results';
  audio.click();
}

function drawTreat(dt) {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;
  const tr = app.treat;
  if (!tr) { app.state = 'results'; return; }
  tr.t += dt;
  const step = TREAT_STEPS[tr.step];
  const breed = breedList[app.breedIdx];
  const dressed = applyEquip(breed, dogState(meta, breed.id).equip, meta.owned);
  ctx.save();
  ctx.fillStyle = 'rgba(6,12,10,0.94)';
  ctx.fillRect(0, 0, w, h);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd54a';
  ctx.font = `900 ${Math.round(26 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('🍪 Угощение', w / 2, h * 0.2);
  // Команда хендлера крупно
  ctx.fillStyle = '#fff';
  ctx.font = `900 ${Math.round(34 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(tr.done ? 'Кто у нас молодец?' : step.cmd, w / 2, h * 0.3);
  // Собака выполняет команду
  ctx.save();
  ctx.translate(w / 2, h * 0.56);
  ctx.scale(2.2, 2.2);
  drawCardDog(ctx, { runPhase: 0, happy: tr.done || step.pose === 'chew',
    idle: { state: step.pose, k: Math.min(1, tr.t / 0.6) } }, dressed, 52 * z);
  ctx.restore();
  // Печенька в кадре на последнем шаге
  if (step.pose === 'chew' && !tr.done) {
    ctx.font = `${Math.round(34 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText('🍪', w / 2 + 90 * z, h * 0.5);
  }
  if (tr.done) {
    if (!tr._hearts) { tr._hearts = 1; }
    ctx.fillStyle = '#9ff0b4';
    ctx.font = `bold ${Math.round(22 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(`+${tr.xp} XP · хороший пёс!`, w / 2, h * 0.72);
    // Сердечки над собакой
    for (let i = 0; i < 6; i++) {
      const ph2 = ((app.t * 0.5 + i * 0.17) % 1);
      ctx.globalAlpha = 0.9 * (1 - ph2);
      ctx.fillStyle = ['#f06292', '#e91e63', '#ff8a80'][i % 3];
      ctx.font = `${Math.round((16 + i * 2) * z)}px "Segoe UI", sans-serif`;
      ctx.fillText('♥', w / 2 + (i - 2.5) * 34 * z, h * 0.44 - ph2 * 60 * z);
      ctx.globalAlpha = 1;
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = `${Math.round(15 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(tr.done ? 'Тап / ENTER — к протоколу' : `${step.hint}   ·   ESC — пропустить`,
    w / 2, h - 34 * z);
  // Точки прогресса ритуала
  TREAT_STEPS.forEach((_, i) => {
    ctx.beginPath();
    ctx.fillStyle = i < tr.step || tr.done ? '#ffd54a' : i === tr.step ? '#fff' : 'rgba(255,255,255,0.3)';
    ctx.arc(w / 2 + (i - 1) * 22 * z, h * 0.35, 5 * z, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

// ---------- ФОТО-РЕЖИМ С ПАУЗЫ (S3.8) ----------
// P во время забега замораживает мир: HUD прячется, кадр двигается и зумится,
// сверху — рамка с логотипом и кличкой. S сохраняет PNG.
function togglePhotoMode() {
  if (!app.run || app.state !== 'run') return;
  if (app.photoMode) {
    renderer.cam.x = app.photoMode.baseX;
    renderer.cam.y = app.photoMode.baseY;
    renderer.cam.zoom = app.photoMode.baseZoom;
    app.photoMode = null;
    audio.click();
    return;
  }
  app.photoMode = { baseX: renderer.cam.x, baseY: renderer.cam.y, baseZoom: renderer.cam.zoom, zoom: 1 };
  audio.click();
  track('photo_mode', { mode: app.mode, phase: app.run.phase });
}

function photoModeInput(code) {
  const pm = app.photoMode;
  if (!pm) return false;
  const step = 1.2 / (pm.zoom || 1);
  if (code === 'ArrowLeft') renderer.cam.x -= step;
  else if (code === 'ArrowRight') renderer.cam.x += step;
  else if (code === 'ArrowUp') renderer.cam.y -= step;
  else if (code === 'ArrowDown') renderer.cam.y += step;
  else if (code === 'Equal' || code === 'NumpadAdd') { pm.zoom = Math.min(2.5, pm.zoom * 1.12); renderer.cam.zoom = pm.baseZoom * pm.zoom; }
  else if (code === 'Minus' || code === 'NumpadSubtract') { pm.zoom = Math.max(0.5, pm.zoom / 1.12); renderer.cam.zoom = pm.baseZoom * pm.zoom; }
  else if (code === 'KeyS') savePhotoShot();
  else if (code === 'Escape' || code === 'KeyP') togglePhotoMode();
  else return false;
  return true;
}

function photoModeButtons() {
  const w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;
  const bw = 120 * z, bh = 44 * z, gap = 10 * z;
  const y = h - 74 * z;
  return [
    { id: 'zoomOut', label: '−', x: w / 2 - bw * 1.5 - gap * 1.5, y, w: bw * 0.6, h: bh },
    { id: 'zoomIn', label: '+', x: w / 2 - bw * 0.9 - gap * 0.5, y, w: bw * 0.6, h: bh },
    { id: 'save', label: '💾 PNG', x: w / 2 - bw * 0.3 + gap * 0.5, y, w: bw, h: bh },
    { id: 'exit', label: '✕ Выход', x: w / 2 + bw * 0.7 + gap * 1.5, y, w: bw, h: bh },
  ];
}

function drawPhotoMode() {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;
  const breed = breedList[app.breedIdx];
  ctx.save();
  // Рамка кадра: широкие поля по краям
  const pad = 18 * z;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 3 * z;
  ctx.strokeRect(pad, pad, w - pad * 2, h - pad * 2);
  // Уголки-визир
  ctx.lineWidth = 5 * z;
  const cl = 34 * z;
  for (const [cx2, cy2, sx2, sy2] of [[pad, pad, 1, 1], [w - pad, pad, -1, 1],
    [pad, h - pad, 1, -1], [w - pad, h - pad, -1, -1]]) {
    ctx.beginPath();
    ctx.moveTo(cx2 + sx2 * cl, cy2); ctx.lineTo(cx2, cy2); ctx.lineTo(cx2, cy2 + sy2 * cl);
    ctx.stroke();
  }
  // Подпись: логотип и кличка
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = `900 ${Math.round(18 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('🐕 Agility Trial!', pad + 16 * z, h - pad - 16 * z);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffd54a';
  ctx.fillText(dogName(meta, breed), w - pad - 16 * z, h - pad - 16 * z);
  // Подсказки управления и кнопки
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = `${Math.round(14 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(IS_TOUCH ? '📸 Фото-режим · тяни кадр пальцем'
    : '📸 Фото-режим · стрелки — кадр · +/− зум · S — сохранить PNG · P/ESC — выход', w / 2, pad + 30 * z);
  app.photoModeBtns = photoModeButtons();
  for (const b of app.photoModeBtns) {
    ctx.fillStyle = b.id === 'save' ? 'rgba(255,213,74,0.92)' : 'rgba(12,22,18,0.9)';
    ctx.strokeStyle = b.id === 'save' ? '#ffd54a' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(b.x, b.y, b.w, b.h, 10 * z); ctx.fill(); ctx.stroke();
    ctx.fillStyle = b.id === 'save' ? '#1a1a1a' : '#fff';
    ctx.font = `bold ${Math.round(15 * z)}px "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
}

function handlePhotoModeTap(p) {
  for (const b of app.photoModeBtns || []) {
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
      audio.click();
      if (b.id === 'save') savePhotoShot();
      else if (b.id === 'exit') togglePhotoMode();
      else photoModeInput(b.id === 'zoomIn' ? 'Equal' : 'Minus');
      return true;
    }
  }
  return false;
}

function savePhotoShot() {
  const name = dogName(meta, breedList[app.breedIdx]);
  try {
    const a = document.createElement('a');
    a.download = `agility-${name}-${Date.now()}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
    toasts.push({ icon: '📸', name: 'Кадр сохранён', desc: 'PNG скачан', t: 0 });
  } catch {
    toasts.push({ icon: '⚠️', name: 'Не вышло сохранить', desc: 'Браузер заблокировал скачивание', t: 0 });
  }
  track('photo_mode_save', { mode: app.mode });
  audio.click();
}

// ---------- ПОДИУМ-ЦЕРЕМОНИЯ (S3.5) ----------
// Награждают только там, где есть соперники: дуэли с боссом и турнирные трассы
// чемпионата мира. Место: 1 — победа над призраком/чистый прогон, 2 — квалификация,
// 3 — всё остальное. Розетка за золото вешается на ошейник и остаётся косметикой.
const PODIUM_ROSETTE = 'neck-rosette-champion';

function podiumPlace() {
  const run = app.run, res = app.result;
  // Zen и практика — вне соревнования: церемонии награждения там не бывает
  if (!run || !res || run.warmup || run.zen || run.practice || app.testDrive) return 0;
  const isDuel = !!run.bossCls, isCup = app.mode === 'worldcup';
  if (!isDuel && !isCup) return 0;
  if (run.eliminated) return 3;
  if (isDuel) {
    if (res.qualified && run.ghost && run.time < run.ghost.time) return 1;
    return res.qualified ? 2 : 3;
  }
  if (res.clean) return 1;
  return res.qualified ? 2 : 3;
}

function openPodium() {
  const place = podiumPlace();
  const breed = breedList[app.breedIdx];
  app.podium = { place, t: 0, name: dogName(meta, breed), rosette: false };
  // Золото турнира — розетка на ошейник, выдаётся один раз
  if (place === 1 && !meta.owned[PODIUM_ROSETTE]) {
    meta.owned[PODIUM_ROSETTE] = 1;
    const eq = dogState(meta, breed.id).equip;
    if (!eq.neck) eq.neck = PODIUM_ROSETTE;   // сразу надеваем, если шея свободна
    saveMeta(meta);
    app.podium.rosette = true;
    toasts.push({ icon: '🏵️', name: 'Розетка чемпиона!', desc: 'Надета на ошейник — теперь косметика', t: 0 });
  }
  app.state = 'podium';
  audio.fanfare();
  track('podium', { place, mode: app.mode, cls: app.cls, rosette: app.podium.rosette });
}

function podiumContinue() {
  app.podiumDone = true;
  app.state = 'results';
  audio.click();
  resultsKey('Enter');
}

function drawPodium() {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;
  const pd = app.podium;
  if (!pd) { app.state = 'results'; return; }
  pd.t += 1 / 60;
  const breed = breedList[app.breedIdx];
  const eq0 = dogState(meta, breed.id).equip;
  // На церемонии розетка чемпиона всегда на виду — ради неё всё и затевалось
  const dressed = applyEquip(breed,
    pd.place === 1 && meta.owned[PODIUM_ROSETTE] ? { ...eq0, neck: PODIUM_ROSETTE } : eq0,
    meta.owned);
  ctx.save();
  ctx.fillStyle = 'rgba(6,12,10,0.96)';
  ctx.fillRect(0, 0, w, h);
  // Лучи прожекторов над подиумом
  ctx.save();
  ctx.translate(w / 2, h * 0.18);
  for (let i = 0; i < 7; i++) {
    ctx.save();
    ctx.rotate((i / 7 - 0.5) * 1.1 + Math.sin(app.t * 0.4) * 0.05);
    ctx.fillStyle = 'rgba(255,213,74,0.05)';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-40 * z, h); ctx.lineTo(40 * z, h); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd54a';
  ctx.font = `900 ${Math.round(28 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('🏅 ЦЕРЕМОНИЯ НАГРАЖДЕНИЯ', w / 2, h * 0.16);

  // Тумбы 1-2-3: центр выше, по бокам ниже
  const baseY = h * 0.74;
  const boxW = Math.min(150 * z, w * 0.22);
  const slots = [
    { place: 2, x: w / 2 - boxW * 1.08, hgt: 78 * z, color: '#b8c2cc' },
    { place: 1, x: w / 2,               hgt: 118 * z, color: '#ffd54a' },
    { place: 3, x: w / 2 + boxW * 1.08, hgt: 54 * z, color: '#cd8b56' },
  ];
  for (const sl of slots) {
    const mine = sl.place === pd.place;
    // Подъём тумбы с пружиной при появлении
    const k = Math.min(1, pd.t / 0.5);
    const hh = sl.hgt * k;
    ctx.fillStyle = mine ? 'rgba(255,213,74,0.22)' : 'rgba(255,255,255,0.09)';
    ctx.strokeStyle = mine ? '#ffd54a' : 'rgba(255,255,255,0.35)';
    ctx.lineWidth = mine ? 3 : 1.5;
    ctx.beginPath(); ctx.roundRect(sl.x - boxW / 2, baseY - hh, boxW, hh, 6 * z);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = mine ? '#ffd54a' : 'rgba(255,255,255,0.6)';
    ctx.font = `900 ${Math.round(30 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(String(sl.place), sl.x, baseY - hh / 2 + 10 * z);
    // Собаки на тумбах: наша с эмоцией по месту, соперники — серые силуэты
    ctx.save();
    if (mine) {
      // Эмоция: золото — радость и виляние хвостом, серебро/бронза — потухший вид
      const happy = pd.place === 1;
      ctx.translate(sl.x, baseY - hh - 26 * z);
      ctx.scale(1.25, 1.25);
      drawCardDog(ctx, { runPhase: happy ? app.t * 5 : 0, happy,
        idle: happy ? null : { state: 'sleep', k: 0.5 } }, dressed, 46 * z);
    } else {
      ctx.translate(sl.x, baseY - hh - 21 * z);
      ctx.globalAlpha = 0.35;
      drawCardDog(ctx, { runPhase: 0, happy: false, idle: null },
        { ...BREEDS.border, body: '#5c6670', chest: '#8a949e', ear: '#454e57' }, 40 * z);
    }
    ctx.restore();
  }
  // Хендлер на коленях у центральной тумбы — обнимает собаку
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.font = `900 ${Math.round(24 * z)}px "Segoe UI", sans-serif`;
  const placeWord = { 1: 'ПЕРВОЕ МЕСТО!', 2: 'Второе место', 3: 'Третье место' }[pd.place];
  ctx.fillText(`${pd.name} — ${placeWord}`, w / 2, h * 0.245);
  ctx.fillStyle = pd.place === 1 ? '#9ff0b4' : 'rgba(255,255,255,0.8)';
  ctx.font = `italic ${Math.round(16 * z)}px "Segoe UI", sans-serif`;
  const line = pd.place === 1
    ? (pd.rosette ? 'Розетка отправляется на ошейник — она останется с тобой навсегда.'
      : 'Розетка уже в гардеробе — сегодня просто аплодисменты.')
    : 'Судьи жмут лапу. Следующий раз — выше.';
  ctx.fillText(line, w / 2, h * 0.29);
  ctx.fillStyle = Math.sin(app.t * 4) > -0.3 ? '#ffd54a' : 'rgba(255,213,74,0.4)';
  ctx.font = `bold ${Math.round(18 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('ENTER / тап — дальше', w / 2, h - 30 * z);
  ctx.restore();
}

// ---------- ФОТО-ФИНИШ: ПОЛАРОИД (S3.3) ----------
// После победного круга кадр сцены (без HUD) замирает в бумажной рамке с
// кличкой, временем и титулом — главный момент, которым хочется поделиться.
function capturePhoto() {
  const run = app.run;
  const off = document.createElement('canvas');
  off.width = canvas.width; off.height = canvas.height;
  off.getContext('2d').drawImage(canvas, 0, 0);
  const breed = breedList[app.breedIdx];
  const d = dogState(meta, breed.id);
  const tag = titleFor(d.level);
  app.photo = {
    frame: off,
    name: dogName(meta, breed),
    time: run.time,
    course: run.course.name || 'Трасса',
    title: tag ? `${tag} · чистый прогон` : 'Чистый прогон · Q',
    date: todayStr(),
  };
  app.state = 'photo';
  audio.click();
  track('photo_finish', { mode: app.mode, cls: app.cls, time: +run.time.toFixed(2) });
}

function photoButtons(px, py, pw, ph, z) {
  const bw = (pw - 3 * 18 * z) / 2, bh = 46 * z;
  const by = py + ph + 16 * z;
  return [
    { id: 'share', label: IS_TOUCH ? '📤 Поделиться' : '📤 Поделиться (S)', x: px + 18 * z, y: by, w: bw, h: bh },
    { id: 'next', label: IS_TOUCH ? '▶ К протоколу' : '▶ К протоколу (ENTER)', x: px + 36 * z + bw, y: by, w: bw, h: bh },
  ];
}

function drawPhoto() {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;
  const ph0 = app.photo;
  if (!ph0) { app.state = 'results'; return; }
  ctx.save();
  ctx.fillStyle = '#0b1410';
  ctx.fillRect(0, 0, w, h);
  // Лист полароида: белая карточка с широким полем снизу, лёгкий наклон
  const cardW = Math.min(560 * z, w * 0.82);
  const imgH = cardW * 0.72;
  const cardH = imgH + 118 * z;
  const cx = w / 2, cy = h * 0.46;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.025);
  ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 26 * z; ctx.shadowOffsetY = 8 * z;
  ctx.fillStyle = '#f6f3ea';
  ctx.beginPath(); ctx.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 6 * z); ctx.fill();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  // Снимок: вписываем центральную часть кадра сцены
  const ix = -cardW / 2 + 16 * z, iy = -cardH / 2 + 16 * z;
  const iw = cardW - 32 * z, ih = imgH;
  const src = ph0.frame;
  const scale = Math.max(iw / src.width, ih / src.height);
  const sw2 = iw / scale, sh2 = ih / scale;
  ctx.save();
  ctx.beginPath(); ctx.rect(ix, iy, iw, ih); ctx.clip();
  ctx.drawImage(src, (src.width - sw2) / 2, (src.height - sh2) * 0.42, sw2, sh2, ix, iy, iw, ih);
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.lineWidth = 1;
  ctx.strokeRect(ix, iy, iw, ih);
  // Подпись «от руки»
  ctx.textAlign = 'center';
  ctx.fillStyle = '#22303a';
  ctx.font = `italic 900 ${Math.round(30 * z)}px Georgia, serif`;
  ctx.fillText(`${ph0.name} · ${ph0.time.toFixed(2)}с`, 0, iy + ih + 44 * z);
  ctx.fillStyle = '#5a6b76';
  ctx.font = `italic ${Math.round(16 * z)}px Georgia, serif`;
  ctx.fillText(`${ph0.title} · ${ph0.course}`, 0, iy + ih + 68 * z);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#93a2ac';
  ctx.font = `${Math.round(12 * z)}px Georgia, serif`;
  ctx.fillText('🐕 Agility Trial!', ix, iy + ih + 92 * z);
  ctx.textAlign = 'right';
  ctx.fillText(ph0.date, ix + iw, iy + ih + 92 * z);
  ctx.restore();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd54a';
  ctx.font = `900 ${Math.round(26 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('📸 ФОТО-ФИНИШ', w / 2, cy - cardH / 2 - 26 * z);

  // Кнопки под карточкой
  app.photoBtns = photoButtons(cx - cardW / 2, cy - cardH / 2, cardW, cardH, z);
  for (const b of app.photoBtns) {
    ctx.fillStyle = b.id === 'next' ? 'rgba(255,213,74,0.92)' : 'rgba(20,36,26,0.95)';
    ctx.strokeStyle = b.id === 'next' ? '#ffd54a' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.roundRect(b.x, b.y, b.w, b.h, 12 * z); ctx.fill(); ctx.stroke();
    ctx.fillStyle = b.id === 'next' ? '#1a1a1a' : '#fff';
    ctx.font = `bold ${Math.round(16 * z)}px "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
}

function handlePhotoTap(p) {
  for (const b of app.photoBtns || []) {
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
      audio.click();
      return b.id === 'share' ? sharePhoto() : photoContinue();
    }
  }
  photoContinue();
}

function photoContinue() {
  app.photoDone = true;
  app.state = 'results';
  audio.click();
}

// Поделиться кадром: текст-хвастовство + PNG текущего экрана с полароидом
function sharePhoto() {
  const ph0 = app.photo;
  if (!ph0) return;
  const txt = `📸 ${ph0.name} — чистый прогон за ${ph0.time.toFixed(2)}с на «${ph0.course}»!\n` +
    '🐕 Agility Trial! https://allgrit.github.io/agility-fable-game/\n' +
    `Игра от аусси Хлои 🐾 ${CHLOE_URL}`;
  const url = canvas.toDataURL('image/png');
  if (navigator.share) {
    navigator.share({ text: txt }).catch(() => {});
    toasts.push({ icon: '📤', name: 'Фото-финиш', desc: 'Выбери, куда отправить', t: 0 });
  } else {
    try { navigator.clipboard?.writeText(txt); } catch {}
    try {
      const a = document.createElement('a');
      a.download = `agility-photo-${ph0.name}.png`;
      a.href = url;
      a.click();
    } catch {}
    toasts.push({ icon: '📸', name: 'Полароид сохранён', desc: 'PNG скачан, текст в буфере', t: 0 });
  }
  track('photo_share', { mode: app.mode });
  audio.click();
}

// ---------- ДОСЬЕ СОБАКИ (S3.7) ----------
// Паспорт спортсмена: кличка (переименовывается), характер породы, любимый
// снаряд по статистике перфектов, лучшее чистое время, уровень и титул.
function drawDossier() {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;
  const breed = breedList[app.breedIdx];
  const temper = temperamentFor(breed.id);
  const d = dogState(meta, breed.id);
  const fav = favoriteObstacle(meta.counters.obstacleStats);
  const best = (meta.counters.bestTime || {})[breed.id];
  const tag = titleFor(d.level);
  ctx.save();
  ctx.fillStyle = 'rgba(6,12,10,0.88)';
  ctx.fillRect(0, 0, w, h);
  const pw = Math.min(560 * z, w * 0.94), ph = Math.min(470 * z, h * 0.9);
  const px = w / 2 - pw / 2, py = h / 2 - ph / 2;
  panel(ctx, px, py, pw, ph);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd54a';
  ctx.font = `900 ${Math.round(24 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('📖 Досье собаки', w / 2, py + 38 * z);

  // Портрет: собака рисуется живой, с текущей idle-выходкой
  ctx.save();
  ctx.translate(px + 86 * z, py + 108 * z);
  ctx.scale(1.5, 1.5);
  drawCardDog(ctx, { runPhase: app.t * 4, happy: true,
    // В паспорте собака бодрствует: сон из меню сюда не переносим
    idle: { state: menuIdle.state === 'sleep' ? 'idle' : menuIdle.state, k: menuIdle.progress() } },
    breed, 40 * z);
  ctx.restore();

  // Кличка — кликабельная строка (переименование)
  ctx.textAlign = 'left';
  const nx = px + 170 * z;
  ctx.fillStyle = '#fff';
  ctx.font = `900 ${Math.round(26 * z)}px "Segoe UI", sans-serif`;
  const nameTxt = dogName(meta, breed);
  ctx.fillText(nameTxt, nx, py + 96 * z);
  const ntw = ctx.measureText(nameTxt).width;
  ctx.fillStyle = 'rgba(143,216,255,0.9)';
  ctx.font = `${Math.round(15 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('✏ переименовать', nx + ntw + 14 * z, py + 96 * z);
  app.renameZone = { x: nx - 6 * z, y: py + 74 * z, w: ntw + 150 * z, h: 30 * z };
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = `${Math.round(15 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(`${breed.name} · ур. ${d.level}${tag ? ` · ${tag}` : ''}`, nx, py + 120 * z);

  const rows = [
    ['🎭', 'Характер', temper.trait],
    ['🐾', 'Повадка', temper.desc],
    ['⭐', 'Любимый снаряд', fav
      ? `${fav.name} (${Math.round(fav.rate * 100)}% идеальных)`
      : 'ещё изучаем — нужно больше прогонов'],
    ['⏱', 'Лучшее чистое время', best != null ? `${best.toFixed(2)}с` : '—'],
    ['🏵️', 'Розетки хендлера', String(meta.rosettes)],
    ['🥇', 'Золотых медалей', String(medalCounts()[3])],
  ];
  const rw = pw - 56 * z, rx = w / 2 - rw / 2, rh = 34 * z, gap = 7 * z;
  rows.forEach(([icon, label, val], i) => {
    const yy = py + 160 * z + i * (rh + gap);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath(); ctx.roundRect(rx, yy, rw, rh, 9 * z); ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `${Math.round(16 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(icon, rx + 12 * z, yy + rh / 2 + 1);
    ctx.font = `${Math.round(14 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(label, rx + 38 * z, yy + rh / 2 + 1);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#e8f5ec';
    ctx.font = `bold ${Math.round(14 * z)}px "Segoe UI", sans-serif`;
    // Длинные повадки ужимаем по ширине, чтобы не наезжать на подпись
    let v = val;
    const maxW = rw - 190 * z;
    while (ctx.measureText(v).width > maxW && v.length > 14) v = v.slice(0, -2);
    if (v !== val) v += '…';
    ctx.fillText(v, rx + rw - 12 * z, yy + rh / 2 + 1);
    ctx.textBaseline = 'alphabetic';
  });
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = `${Math.round(14 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('D / ESC / тап мимо — назад', w / 2, py + ph - 18 * z);
  ctx.restore();
}

function handleDossierTap(p) {
  const rz = app.renameZone;
  if (rz && p.x >= rz.x && p.x <= rz.x + rz.w && p.y >= rz.y && p.y <= rz.y + rz.h) {
    const breed = breedList[app.breedIdx];
    let name = null;
    try { name = window.prompt('Кличка собаки:', dogName(meta, breed)); } catch {}
    if (name && name.trim()) {
      dogState(meta, breed.id).name = name.trim().slice(0, 18);
      saveMeta(meta);
      audio.good();
      track('dog_rename', { breed: breed.id });
    }
    return true;
  }
  return false;
}

// ---------- ПИТОМНИК: ВИТРИНА ЦЕЛЕЙ (S4.10) ----------
// Vampire Survivors: игрок в любой момент видит «во что играть дальше». Здесь
// это единый прокручиваемый список — ачивки, косметика, боссы, задания, уровни,
// медальные наборы — с прогресс-барами. Выполненные остаются в списке: это
// витрина коллекции, а не todo, из которого вещи исчезают.

// Целей около сотни, а собираются они из пяти модулей — пересчитывать каждый
// кадр расточительно. Кэш живёт полсекунды: экран остаётся живым, но не жжёт CPU.
function currentGoals() {
  if (!app._goals || app.t - (app._goalsT ?? -9) > 0.5) {
    app._goals = collectGoals({ meta, ach: loadAch(), medals: loadMedals() });
    app._goalsT = app.t;
  }
  return app._goals;
}
function kennelBadge() {
  const s = goalsSummary(currentGoals());
  return s.total ? `${s.done}/${s.total}` : null;
}
function openKennel() {
  app._goals = null;              // после забега список обязан быть свежим
  app.kennelScroll = app.kennelScroll || 0;
  app.state = 'kennel';
  clampKennelScroll();
}

function kennelLayout() {
  const w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;
  const pw = Math.min(620 * z, w * 0.94);
  // Список длинный — в портрете забираем высоту экрана, а не квадрат по ширине.
  const ph = Math.min(h * 0.92, Math.max(600 * z, h * 0.72));
  const px = w / 2 - pw / 2, py = h / 2 - ph / 2;
  const viewTop = py + 86 * z;
  return { w, h, z, pw, ph, px, py, viewTop, viewH: ph - 124 * z,
    rowH: 42 * z, secH: 30 * z };
}
function kennelContentH(L, groups) {
  let sum = 0;
  for (const g of groups) sum += L.secH + g.goals.length * L.rowH;
  return sum;
}
function clampKennelScroll() {
  const L = kennelLayout();
  const max = Math.max(0, kennelContentH(L, groupGoals(currentGoals())) - L.viewH);
  app.kennelScroll = Math.max(0, Math.min(max, app.kennelScroll || 0));
}
function kennelScrollBy(dy) {
  app.kennelScroll = (app.kennelScroll || 0) + dy;
  clampKennelScroll();
}

// Обрезка строки по ширине с многоточием (шрифт должен быть выставлен заранее).
function fitText(ctx, s, maxW) {
  if (ctx.measureText(s).width <= maxW) return s;
  let cut = s;
  while (cut.length > 2 && ctx.measureText(cut + '…').width > maxW) cut = cut.slice(0, -1);
  return cut + '…';
}
const fmtNum = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

// Непрозрачная карточка (как у протокола судьи): плотный список нельзя читать
// сквозь меню — полупрозрачный panel() под ним превращается в кашу.
function solidPanel(ctx, x, y, w, h, z) {
  ctx.fillStyle = 'rgba(14,26,20,0.97)';
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 16 * z); ctx.fill(); ctx.stroke();
}

function drawGoalRow(ctx, g, x, y, w, hh, z) {
  ctx.save();
  ctx.globalAlpha = g.done ? 0.55 : 1;
  ctx.fillStyle = g.done ? 'rgba(105,240,174,0.08)' : 'rgba(255,255,255,0.05)';
  ctx.beginPath(); ctx.roundRect(x, y + 2 * z, w, hh - 6 * z, 8 * z); ctx.fill();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = `${Math.round(16 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = '#fff';
  ctx.fillText(g.icon, x + 10 * z, y + hh * 0.42);
  ctx.font = `bold ${Math.round(13 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = g.done ? '#9ff0b4' : '#fff';
  ctx.fillText(fitText(ctx, (g.done ? '✓ ' : '') + g.name, w * 0.52), x + 34 * z, y + hh * 0.36);
  ctx.font = `${Math.round(11 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText(fitText(ctx, g.hint, w * 0.58), x + 34 * z, y + hh * 0.7);
  // Правая колонка: у счётной цели — бар и current/target, у бинарной — галочка/замок.
  const cw = w * 0.28, cx = x + w - cw - 12 * z;
  ctx.textAlign = 'right';
  if (g.target) {
    ctx.font = `bold ${Math.round(12 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = g.done ? '#9ff0b4' : '#e8f5ec';
    ctx.fillText(`${fmtNum(g.current)}/${fmtNum(g.target)}`, x + w - 12 * z, y + hh * 0.34);
    const by = y + hh * 0.62;
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath(); ctx.roundRect(cx, by, cw, 5 * z, 2.5 * z); ctx.fill();
    ctx.fillStyle = g.done ? '#69f0ae' : '#ffd54a';
    ctx.beginPath(); ctx.roundRect(cx, by, Math.max(2 * z, cw * g.progress), 5 * z, 2.5 * z); ctx.fill();
  } else {
    ctx.font = `${Math.round(17 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = g.done ? '#9ff0b4' : 'rgba(255,255,255,0.35)';
    ctx.fillText(g.done ? '✓' : '🔒', x + w - 14 * z, y + hh * 0.46);
  }
  ctx.restore();
  ctx.textBaseline = 'alphabetic';
}

function drawKennel() {
  const ctx = renderer.ctx;
  const L = kennelLayout();
  const { z, px, py, pw, ph } = L;
  const goals = currentGoals();
  const groups = groupGoals(goals);
  const sum = goalsSummary(goals);
  clampKennelScroll();

  ctx.save();
  ctx.fillStyle = 'rgba(6,12,10,0.9)';
  ctx.fillRect(0, 0, L.w, L.h);
  solidPanel(ctx, px, py, pw, ph, z);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd54a';
  ctx.font = `900 ${Math.round(24 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('🏠 Питомник', L.w / 2, py + 34 * z);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = `${Math.round(14 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(`${sum.done} из ${sum.total} целей · ${Math.round(sum.percent * 100)}%`,
    L.w / 2, py + 56 * z);
  const gw = pw - 56 * z, gx = px + 28 * z, gy = py + 66 * z;
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.beginPath(); ctx.roundRect(gx, gy, gw, 6 * z, 3 * z); ctx.fill();
  ctx.fillStyle = '#ffd54a';
  ctx.beginPath(); ctx.roundRect(gx, gy, Math.max(2 * z, gw * sum.percent), 6 * z, 3 * z); ctx.fill();

  // Список: обрезаем по окну прокрутки, рисуем только видимые строки
  ctx.save();
  ctx.beginPath(); ctx.rect(px + 6 * z, L.viewTop, pw - 12 * z, L.viewH); ctx.clip();
  const vBot = L.viewTop + L.viewH;
  let y = L.viewTop - app.kennelScroll;
  for (const grp of groups) {
    if (y + L.secH > L.viewTop && y < vBot) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${Math.round(12 * z)}px "Segoe UI", sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(grp.title.toUpperCase(), px + 20 * z, y + L.secH * 0.66);
      ctx.textAlign = 'right';
      ctx.fillStyle = grp.done === grp.total ? '#9ff0b4' : 'rgba(255,255,255,0.55)';
      ctx.fillText(`${grp.done}/${grp.total}`, px + pw - 20 * z, y + L.secH * 0.66);
      ctx.textBaseline = 'alphabetic';
    }
    y += L.secH;
    for (const g of grp.goals) {
      if (y + L.rowH > L.viewTop && y < vBot) drawGoalRow(ctx, g, px + 16 * z, y, pw - 32 * z, L.rowH, z);
      y += L.rowH;
    }
  }
  ctx.restore();

  // Полоса прокрутки: без неё непонятно, что список длинный
  const contentH = kennelContentH(L, groups);
  if (contentH > L.viewH) {
    const trackX = px + pw - 9 * z;
    const kh = Math.max(24 * z, L.viewH * (L.viewH / contentH));
    const kt = L.viewTop + (L.viewH - kh) * (app.kennelScroll / (contentH - L.viewH));
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.roundRect(trackX, L.viewTop, 4 * z, L.viewH, 2 * z); ctx.fill();
    ctx.fillStyle = 'rgba(255,213,74,0.65)';
    ctx.beginPath(); ctx.roundRect(trackX, kt, 4 * z, kh, 2 * z); ctx.fill();
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = `${Math.round(13 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(fitText(ctx, IS_TOUCH ? 'Свайп — прокрутка · тап мимо — назад'
    : 'Колесо / ↑↓ — прокрутка · K / ESC — назад', pw - 32 * z), L.w / 2, py + ph - 16 * z);
  ctx.restore();
}

// ---------- КАЛЕНДАРЬ-АРХИВ ТРАСС ДНЯ (S4.11) ----------
// Trackmania Track of the Day: месяц как сетка, у сыгранного дня — медаль,
// пропуски серые, будущее выключено. Перебег прошедшего дня разрешён, но вне зачёта.
function rawDailyBest() {
  try { return JSON.parse(localStorage.getItem('agility_daily') || 'null'); }
  catch { return null; }
}
function archiveCalendar() {
  const cur = app.archiveCursor || (app.archiveCursor = currentCursor(new Date()));
  return buildCalendar({ year: cur.year, month: cur.month, today: new Date(),
    medals: loadMedals(), dailyBest: rawDailyBest() });
}
function openArchive() {
  app.archiveCursor = currentCursor(new Date());
  app.state = 'archive';
}
function archiveStep(dir) {
  const cal = archiveCalendar();
  const next = dir < 0 ? prevMonth(app.archiveCursor, cal.bounds)
    : nextMonth(app.archiveCursor, cal.bounds);
  if (!next) return;          // шаг за границы данных модуль запрещает — молча игнорируем
  app.archiveCursor = next;
  audio.click();
}
function startArchiveRun(day) {
  app.mode = 'daily';
  app.archiveDay = { key: day.key, seed: day.seed, cls: day.cls,
    modifier: day.modifier, scored: day.isScored !== false };
  audio.click();
  track('archive_run', { day: day.key, scored: day.isScored !== false, cls: day.cls });
  startRun();                 // тот же путь, что и обычная трасса дня
}

function drawUnscoredBadge(ctx, cx, cy, z, text) {
  const txt = text || '⚠ Вне зачёта — перебег прошедшего дня';
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = `bold ${Math.round(13 * z)}px "Segoe UI", sans-serif`;
  const tw = ctx.measureText(txt).width;
  ctx.fillStyle = 'rgba(60,40,10,0.75)';
  ctx.strokeStyle = 'rgba(255,171,107,0.8)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(cx - tw / 2 - 12 * z, cy - 13 * z, tw + 24 * z, 23 * z, 11 * z);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#ffab6b';
  ctx.fillText(txt, cx, cy + 3 * z);
  ctx.restore();
}

function drawArchive() {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;
  const cal = archiveCalendar();
  // Высота панели считается от содержимого: месяц бывает на 5 и на 6 недель,
  // фиксированная высота оставляла бы дыру под сеткой.
  // В портрете панель во всю ширину: клетка календаря должна оставаться под палец.
  const pw = isPortrait() ? w * 0.94 : Math.min(560 * z, w * 0.94);
  const cellW = (pw - 40 * z) / 7;
  const rowsN = Math.max(1, cal.weeks.length);
  const cellH = Math.min(cellW * 1.15, 72 * z);
  const ph = Math.min(h * 0.94, (112 + 96) * z + rowsN * cellH);
  const px = w / 2 - pw / 2, py = h / 2 - ph / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(6,12,10,0.9)';
  ctx.fillRect(0, 0, w, h);
  solidPanel(ctx, px, py, pw, ph, z);
  app.archivePanel = { x: px, y: py, w: pw, h: ph };

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd54a';
  ctx.font = `900 ${Math.round(22 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('📅 Архив трасс дня', w / 2, py + 32 * z);

  // Месяц + стрелки листания (неактивные видны, но глушатся)
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(18 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(`${cal.monthName} ${cal.year}`, w / 2, py + 62 * z);
  const ar = 17 * z, ay = py + 56 * z;
  const arrows = {
    prev: { x: px + 34 * z, y: ay, r: ar, on: cal.canPrev },
    next: { x: px + pw - 34 * z, y: ay, r: ar, on: cal.canNext },
  };
  app.archiveArrows = arrows;
  for (const [key, a] of Object.entries(arrows)) {
    ctx.globalAlpha = a.on ? 1 : 0.25;
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffd54a';
    ctx.font = `bold ${Math.round(18 * z)}px "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(key === 'prev' ? '‹' : '›', a.x, a.y + 1);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.globalAlpha = 1;

  // Сетка месяца
  const gx = px + 20 * z;
  const headY = py + 92 * z;
  ctx.font = `bold ${Math.round(12 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  cal.weekdayLabels.forEach((lbl, i) => ctx.fillText(lbl, gx + cellW * (i + 0.5), headY));
  const gridTop = headY + 10 * z;
  app.archiveCells = [];
  cal.weeks.forEach((week, r) => {
    week.forEach((day, c) => {
      if (!day) return;
      const cx = gx + cellW * c, cy = gridTop + cellH * r;
      const bx = cx + 2 * z, by = cy + 2 * z, bw = cellW - 4 * z, bh = cellH - 4 * z;
      ctx.save();
      if (day.isFuture) ctx.globalAlpha = 0.28;
      ctx.fillStyle = day.played ? 'rgba(255,213,74,0.16)'
        : day.missed ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.03)';
      ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 7 * z); ctx.fill();
      if (day.isToday) {
        ctx.strokeStyle = '#ffd54a'; ctx.lineWidth = 2 * z;
        ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 7 * z); ctx.stroke();
      } else if (day.played) {
        ctx.strokeStyle = 'rgba(255,213,74,0.35)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 7 * z); ctx.stroke();
      }
      ctx.textAlign = 'left';
      ctx.font = `${Math.round(10 * z)}px "Segoe UI", sans-serif`;
      ctx.fillStyle = day.isToday ? '#ffd54a'
        : day.missed ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.65)';
      ctx.fillText(String(day.dayNum % 100), bx + 5 * z, by + 12 * z);
      ctx.textAlign = 'center';
      if (day.played) {
        ctx.font = `${Math.round(19 * z)}px "Segoe UI", sans-serif`;
        ctx.fillText(day.medalIcon || '✔', bx + bw / 2, by + bh * 0.62);
        if (day.points != null) {
          ctx.font = `${Math.round(9 * z)}px "Segoe UI", sans-serif`;
          ctx.fillStyle = 'rgba(255,255,255,0.6)';
          ctx.fillText(String(day.points), bx + bw / 2, by + bh - 5 * z);
        }
      } else if (day.missed) {
        ctx.font = `${Math.round(15 * z)}px "Segoe UI", sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillText('·', bx + bw / 2, by + bh * 0.66);
      }
      ctx.restore();
      app.archiveCells.push({ x: bx, y: by, w: bw, h: bh, day });
    });
  });

  // Сводка месяца
  const s = cal.summary;
  ctx.textAlign = 'center';
  const maxW = pw - 32 * z;
  ctx.font = `bold ${Math.round(13 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = '#e8f5ec';
  ctx.fillText(fitText(ctx,
    `Сыграно ${s.played} · пропущено ${s.missed} · лучшая серия ${s.longestStreak} дн`, maxW),
    w / 2, py + ph - 60 * z);
  ctx.font = `${Math.round(13 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillText(`💎 ${s.medals[4]}   🥇 ${s.medals[3]}   🥈 ${s.medals[2]}   🥉 ${s.medals[1]}`,
    w / 2, py + ph - 40 * z);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `${Math.round(12 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(fitText(ctx, 'Тап по дню — перебежать · прошедшие дни вне зачёта · A / ESC — назад', maxW),
    w / 2, py + ph - 18 * z);
  ctx.restore();
}

function handleArchiveTap(p) {
  const a = app.archiveArrows || {};
  for (const [key, zn] of Object.entries(a)) {
    if (Math.hypot(p.x - zn.x, p.y - zn.y) <= zn.r + 6) { archiveStep(key === 'prev' ? -1 : 1); return true; }
  }
  for (const c of app.archiveCells || []) {
    if (p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) {
      if (c.day.playable) startArchiveRun(c.day);
      return true;            // будущий день — просто глухой тап, экран не закрываем
    }
  }
  const pr = app.archivePanel;
  if (pr && p.x >= pr.x && p.x <= pr.x + pr.w && p.y >= pr.y && p.y <= pr.y + pr.h) return true;
  return false;
}

// ---------- ГАЗЕТНАЯ ВЫРЕЗКА (победа над боссом) ----------
function drawNews() {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;
  const bw = app.bossWin;
  if (!bw) { app.state = 'menu'; return; }
  const paper = newspaperFor(bw.boss, bw.breedName, bw.time, bw.ghostTime);
  ctx.save();
  ctx.fillStyle = 'rgba(8,10,8,0.94)';
  ctx.fillRect(0, 0, w, h);
  // Лист газеты с лёгким наклоном
  const pw = Math.min(520 * z, w * 0.92), ph = Math.min(480 * z, h * 0.88);
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-0.02);
  ctx.fillStyle = '#efe8d8';
  ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 2;
  ctx.fillRect(-pw / 2, -ph / 2, pw, ph);
  ctx.strokeRect(-pw / 2, -ph / 2, pw, ph);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#2b2b30';
  ctx.font = `900 ${Math.round(17 * z)}px Georgia, serif`;
  ctx.fillText('— АДЖИЛИТИ ВЕСТНИК —', 0, -ph / 2 + 34 * z);
  ctx.strokeStyle = '#2b2b30'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(-pw / 2 + 20 * z, -ph / 2 + 46 * z); ctx.lineTo(pw / 2 - 20 * z, -ph / 2 + 46 * z); ctx.stroke();
  ctx.font = `900 ${Math.round(30 * z)}px Georgia, serif`;
  wrapText(ctx, paper.title, 0, -ph / 2 + 92 * z, pw - 50 * z, 34 * z, 2);
  ctx.font = `bold italic ${Math.round(16 * z)}px Georgia, serif`;
  ctx.fillStyle = '#4a4a52';
  wrapText(ctx, paper.sub, 0, -ph / 2 + 150 * z, pw - 60 * z, 21 * z, 2);
  // «Фото»: рамка с силуэтом собаки-победителя
  const fy = -ph / 2 + 205 * z, fh = 120 * z;
  ctx.fillStyle = '#d9d2c0';
  ctx.fillRect(-pw / 2 + 40 * z, fy, pw - 80 * z, fh);
  ctx.strokeStyle = '#8a8578'; ctx.strokeRect(-pw / 2 + 40 * z, fy, pw - 80 * z, fh);
  ctx.font = `${Math.round(52 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('🐕🏆', 0, fy + fh / 2 + 18 * z);
  ctx.fillStyle = '#2b2b30';
  ctx.font = `${Math.round(14 * z)}px Georgia, serif`;
  wrapText(ctx, paper.body, 0, fy + fh + 30 * z, pw - 70 * z, 19 * z, 4);
  ctx.restore();
  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = Math.sin(app.t * 4) > -0.3 ? '#ffd54a' : 'rgba(255,213,74,0.4)';
  ctx.font = `bold ${Math.round(18 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('ENTER / тап — дальше', w / 2, h - 30 * z);
  ctx.restore();
}

// Продолжение после газеты: гранд-финал ведёт на экран чемпиона
function newsContinue() {
  const wasFinal = app.bossWin && app.bossWin.cls === 'masters';
  app.bossWin = null;
  audio.click();
  if (wasFinal) { app.state = 'champion'; return; }
  startRun(); // класс уже переключён в applyBossVictory
}

// ---------- ЭКРАН ЧЕМПИОНА (гранд-финал пройден) ----------
function drawChampion() {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;
  ctx.save();
  ctx.fillStyle = 'rgba(8,10,8,0.96)';
  ctx.fillRect(0, 0, w, h);
  // Лучи славы
  ctx.translate(w / 2, h * 0.42);
  for (let i = 0; i < 12; i++) {
    ctx.save();
    ctx.rotate((i / 12) * Math.PI * 2 + app.t * 0.15);
    ctx.fillStyle = 'rgba(255,213,74,0.06)';
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(-30 * z, -h); ctx.lineTo(30 * z, -h); ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.textAlign = 'center';
  ctx.font = `${Math.round(110 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('🏆', 0, 20 * z);
  ctx.fillStyle = '#ffd54a';
  ctx.font = `900 ${Math.round(40 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('ЧЕМПИОН!', 0, 90 * z);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(18 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(`${breedList[app.breedIdx].name} побеждает Астру в гранд-финале`, 0, 128 * z);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `italic ${Math.round(16 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(`«${pickLine('champion') || 'Дай лапу.'}»`, 0, 160 * z);
  ctx.fillStyle = '#b388ff';
  ctx.font = `bold ${Math.round(16 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('Открыт NG+ — окна реакции ×0.85 (включается в настройках)', 0, 205 * z);
  ctx.restore();
  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = Math.sin(app.t * 4) > -0.3 ? '#ffd54a' : 'rgba(255,213,74,0.4)';
  ctx.font = `bold ${Math.round(18 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('ENTER / тап — в меню', w / 2, h - 30 * z);
  ctx.restore();
}

// ---------- КАЛИБРОВКА АУДИО-ЗАДЕРЖКИ ----------
// Метроном 100 BPM, игрок тапает в такт 8 раз; медиана смещений → settings.audioOffset.
function startCalib() {
  app.calib = { start: app.t, beat: 0.6, taps: [], nextTick: 0, done: false };
  app.state = 'calib';
}

function calibInput() {
  const c = app.calib;
  if (!c || c.done) return;
  const t = app.t - c.start;
  if (t < c.beat * 1.5) return; // первые полтора такта — вслушаться
  const nearest = Math.round(t / c.beat) * c.beat;
  c.taps.push(t - nearest);
  audio.click();
  if (c.taps.length >= 8) {
    const sorted = [...c.taps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // Клампим до вменяемых ±250мс — защита от случайных тапов
    settings.audioOffset = Math.max(-0.25, Math.min(0.25, median));
    saveSettings();
    c.done = true;
  }
}

function drawCalib() {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;
  const c = app.calib;
  ctx.save();
  ctx.fillStyle = 'rgba(6,12,10,0.92)';
  ctx.fillRect(0, 0, w, h);
  // Лукахед-шедулинг тиков метронома в точном WebAudio-времени
  const t = app.t - c.start;
  if (!c.done && c.nextTick - t < 0.12) {
    audio.metroTick?.(Math.max(0, c.nextTick - t), Math.round(c.nextTick / c.beat) % 2);
    c.nextTick += c.beat;
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd54a';
  ctx.font = `900 ${Math.round(26 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('🎧 Калибровка звука', w / 2, h * 0.22);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `${Math.round(16 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(IS_TOUCH ? 'Тапай по экрану точно в такт метроному — 8 раз'
    : 'Жми ПРОБЕЛ точно в такт метроному — 8 раз', w / 2, h * 0.30);
  // Пульс на бит
  const phase = (t % c.beat) / c.beat;
  const pr = (40 + (1 - phase) * 26) * z;
  ctx.strokeStyle = phase < 0.15 ? '#ffd54a' : 'rgba(255,255,255,0.5)';
  ctx.lineWidth = phase < 0.15 ? 8 : 3;
  ctx.beginPath(); ctx.arc(w / 2, h * 0.5, pr, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = `900 ${Math.round(30 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(c.done ? '✓' : `${c.taps.length}/8`, w / 2, h * 0.5 + 10 * z);
  if (c.done) {
    const ms = Math.round((settings.audioOffset || 0) * 1000);
    ctx.fillStyle = '#69f0ae';
    ctx.font = `bold ${Math.round(20 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(`Готово! Задержка: ${ms >= 0 ? '+' : ''}${ms} мс`, w / 2, h * 0.66);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `${Math.round(14 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(IS_TOUCH ? 'Тап по ВЕРХНЕМУ краю — назад' : 'ESC — назад', w / 2, h * 0.88);
  ctx.restore();
}

// ---------- ТРЕНИРОВКА ЗМЕЙКИ ----------
// Бесконечный groove с BPM-слайдером: оттачивай ритм без трассы и судьи.
function startTrainer() {
  const bpm = settings.trainerBpm || 110;
  app.trainer = {
    bpm, start: app.t, streak: 0, best: 0, total: 0, perfect: 0,
    qte: newTrainerQte(bpm),
    restT: 0,
  };
  app.state = 'trainer';
}

function newTrainerQte(bpm) {
  return new Qte('weave', {
    bpm, grooveWindows: GROOVE_WINDOWS.excellent,
    audioOffset: settings.audioOffset || 0,
  });
}

function trainerInput(key) {
  const tr = app.trainer;
  if (!tr || tr.restT > 0) return;
  const evs = tr.qte.press(key, app.t - tr.start);
  trainerEvents(evs);
}

function trainerEvents(evs) {
  const tr = app.trainer;
  for (const e of evs) {
    if (e.type === 'beat') {
      tr.total++;
      if (e.grade === 'perfect') { tr.perfect++; tr.streak++; tr.best = Math.max(tr.best, tr.streak); audio.perfect(); }
      else { tr.streak = 0; if (e.grade === 'miss') audio.miss(); else audio.good(); }
    }
  }
  if (tr.qte.state === 'done') tr.restT = 1.0; // пауза и новый заход
}

function drawTrainer(dt) {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;
  const tr = app.trainer;
  ctx.save();
  ctx.fillStyle = 'rgba(6,12,10,0.92)';
  ctx.fillRect(0, 0, w, h);
  if (tr.restT > 0) {
    tr.restT -= dt;
    if (tr.restT <= 0) { tr.start = app.t; tr.qte = newTrainerQte(tr.bpm); }
  } else {
    const t = app.t - tr.start;
    trainerEvents(tr.qte.update(t));
    // Метроном-тики с лукахедом
    const q = tr.qte;
    if (q.state === 'active' && q.nextBeatT !== null && q.beatIdx < q.def.beats) {
      const eta = q.nextBeatT - t;
      // Ключ учитывает рестарты — иначе первый бит после возврата молчит
      if (eta <= 0.12 && q._schedTick !== q.beatIdx + q.restarts * 100) {
        q._schedTick = q.beatIdx + q.restarts * 100;
        audio.metroTick?.(Math.max(0, eta), q.beatIdx % 2);
      }
    }
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#b388ff';
  ctx.font = `900 ${Math.round(24 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('🎵 Тренировка змейки', w / 2, h * 0.14);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `${Math.round(15 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(IS_TOUCH ? 'Тапай ЛЕВУЮ и ПРАВУЮ половины экрана в такт'
    : 'Жми ← и → попеременно в такт метроному', w / 2, h * 0.21);
  // Лента нот по центру
  if (tr.restT <= 0) {
    drawGrooveLane(ctx, { time: app.t }, { qte: tr.qte, qteStart: tr.start }, w / 2, h * 0.45, w, z);
  } else {
    ctx.fillStyle = '#69f0ae';
    ctx.font = `900 ${Math.round(26 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText('Заход пройден! Ещё раз…', w / 2, h * 0.45);
  }
  // Статистика
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(17 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(`Perfect: ${tr.perfect}/${tr.total}   Серия: ${tr.streak}   Рекорд серии: ${tr.best}`, w / 2, h * 0.62);
  // BPM-слайдер
  const sw = Math.min(360 * z, w * 0.7), sx = w / 2 - sw / 2, sy = h * 0.74;
  const frac = (tr.bpm - 80) / (170 - 80);
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(sx, sy, sw, 8 * z);
  ctx.fillStyle = '#b388ff';
  ctx.fillRect(sx, sy, sw * frac, 8 * z);
  ctx.beginPath(); ctx.arc(sx + sw * frac, sy + 4 * z, 10 * z, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `bold ${Math.round(14 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(`${tr.bpm} BPM`, w / 2, sy - 12 * z);
  app.trainerSlider = { x: sx, y: sy - 14 * z, w: sw, h: 34 * z, sx, sw };
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `${Math.round(14 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('ESC / тап по верху — назад', w / 2, h * 0.9);
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
  ctx.fillText('🏆 ЛУЧШИЕ ПРОГОНЫ', w / 2, py + 40 * z);

  // Онлайн-топ (Fable Arcade): компактная строка мировых лидеров + твой ранг.
  if (app.onlineTop === undefined && !app.onlineTopLoading) refreshOnlineTop();
  ctx.font = `${Math.round(13 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = '#8fd8ff';
  let ol = '🌐 ';
  if (app.onlineTopLoading || app.onlineTop === undefined) ol += 'загрузка онлайн-топа…';
  else if (!app.onlineTop.length) ol += 'онлайн-топ пуст — будь первым!';
  else ol += app.onlineTop.slice(0, 3).map((e, i) => `${i + 1}. ${e.name} ${e.score}`).join('   ·   ');
  if (app.onlineRank) ol += `    (ты #${app.onlineRank})`;
  ctx.fillText(ol.length > 74 ? ol.slice(0, 73) + '…' : ol, w / 2, py + 62 * z);

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
      ctx.fillText(`${i + 1}. ${e.points}${e.clean ? ' ★Q' : ''}${e.risks ? ` ⚡${e.risks}` : ''}`, px + 24 * z, ry);
      ctx.fillText(`${e.time.toFixed(1)}с / ${e.faults}ф`, px + pw * 0.32, ry);
      const label = `${e.breed} · ${e.cls} · ${e.course}`;
      ctx.fillText(label.length > 42 ? label.slice(0, 41) + '…' : label, px + pw * 0.55, ry);
    }
  }
  // Достижения: сетка под таблицей
  const ach = loadAch();
  const cols = isPortrait() ? 3 : 6;
  const cellW = (pw - 40 * z) / cols;
  const startY = py + ph - 26 * z - Math.ceil(ACHIEVEMENTS.length / cols) * 26 * z - 12 * z;
  ctx.textAlign = 'left';
  ACHIEVEMENTS.forEach((a, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const ax = px + 24 * z + col * cellW;
    const ay = startY + row * 26 * z;
    const got = !!ach[a.id];
    ctx.globalAlpha = got ? 1 : 0.32;
    ctx.font = `${Math.round(14 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.fillText(got ? a.icon : '🔒', ax, ay);
    ctx.fillStyle = got ? '#ffe9a8' : 'rgba(255,255,255,0.6)';
    ctx.font = `${Math.round(10 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(a.name.slice(0, 20), ax + 20 * z, ay);
  });
  // Ранг хендлера: сумма уровней всех собак
  const sumLv = Object.values(meta.dogs).reduce((acc, d) => acc + (d.level || 1), 0);
  const rank = sumLv >= 50 ? 'Легенда ринга' : sumLv >= 25 ? 'Судья FCI' : sumLv >= 10 ? 'Инструктор' : 'Новичок';
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8fd8ff';
  ctx.font = `bold ${Math.round(13 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(`Ранг хендлера: ${rank} (Σ уровней ${sumLv})`, w / 2, startY - 10 * z);
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
  // Показываем сколько влезает по высоте; остальные ждут в очереди (их таймер не тикает)
  const maxVisible = Math.max(2, Math.floor(y / (70 * z)));
  let shown = 0;
  for (const t of toasts) {
    if (shown++ >= maxVisible) break;
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
    [settingsZone(), '⚙️', null],
    [dossierZone(), '📖', null],
    [kennelZone(), '🏠', kennelBadge()],
    [archiveZone(), '📅', null],
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

// Микро-подсказки на подлёте к сложным снарядам: что делать ПОСЛЕ первого нажатия.
// Показываются каждый раз (в отличие от разовых slow-mo HINTS) — снимают панику
// «нажал, а дальше что?». Ключ = тип снаряда.
const APPROACH_HINTS = {
  tire:    () => `${KEY_LABEL.Space} дважды — второй в верхней точке!`,
  spread:  () => `Зажми ${KEY_LABEL.Space} — отпусти в жёлтом секторе`,
  triple:  () => `Зажми ${KEY_LABEL.Space} — сектор узкий, целься!`,
  table:   () => `${KEY_LABEL.Space} на заход · потом ЗАМРИ до GO`,
  seesaw:  () => `${KEY_LABEL.ArrowUp} на заход · по опусканию — ${KEY_LABEL.Space}`,
  aframe:  () => `Зажми ${KEY_LABEL.ArrowUp} — отпусти в жёлтой зоне`,
  dogwalk: () => `Зажми ${KEY_LABEL.ArrowUp} — отпусти в жёлтой зоне`,
  serpentine: () => 'Стрелки по подсветке — жми в темп',
};

function drawApproachHint(ctx, type, cx, cy, z) {
  const fn = APPROACH_HINTS[type];
  if (!fn) return;
  const txt = fn();
  ctx.save();
  ctx.textAlign = 'center';
  // Крупно и на плашке — читается за долю секунды подлёта
  const fs = Math.round(21 * z);
  ctx.font = `900 ${fs}px "Segoe UI", sans-serif`;
  const tw = ctx.measureText(txt).width;
  const hy = cy - 78 * z;
  ctx.fillStyle = 'rgba(10,18,14,0.88)';
  ctx.strokeStyle = 'rgba(255,213,74,0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(cx - tw / 2 - 16 * z, hy - fs * 0.85, tw + 32 * z, fs * 1.7, 10 * z);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#ffe9a8';
  ctx.fillText(txt, cx, hy + fs * 0.32);
  ctx.restore();
}

// Легенда демо S1: на старте — панель «что пробовать», в беге — компактная строка.
const DEMO_LINES = [
  '👂 Слалом: слушай, как perfect идёт вверх по нотам',
  '💥 Идеальный прыжок — собака «пружинит» + удар кадра',
  '🔢 Под оценкой — дельта тайминга «+12 мс»',
  '👻 Обгоняй Эйву: «−0.4с» зелёным = ты быстрее',
  '⚡ SHIFT (тап по хендлеру) до прыжка — риск ×2',
  '❓ Не тапай обманку заранее — окно сузится',
  '🏅 На финише — медаль Тренера (цель по времени)',
  '📳 На телефоне — вибрация; ⟳ R — мгновенный рестарт',
];
function drawDemoLegend(run, z) {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  ctx.save();
  ctx.textAlign = 'left';
  if (run.phase === 'countdown') {
    // Полная легенда поверх старта
    const pw = Math.min(560 * z, w * 0.92), lh = 30 * z;
    const ph = 70 * z + DEMO_LINES.length * lh;
    const px = w / 2 - pw / 2, py = h * 0.5 - ph / 2;
    ctx.fillStyle = 'rgba(8,16,12,0.9)';
    ctx.strokeStyle = '#ffd54a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(px, py, pw, ph, 14 * z); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffd54a'; ctx.textAlign = 'center';
    ctx.font = `900 ${Math.round(22 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText('✨ Демо «Game Feel» — новинки', w / 2, py + 34 * z);
    ctx.textAlign = 'left';
    ctx.font = `${Math.round(15 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = '#e8f5ec';
    DEMO_LINES.forEach((s, i) => ctx.fillText(s, px + 24 * z, py + 66 * z + i * lh));
  } else if (run.phase === 'running') {
    // Компактная бегущая подсказка сверху
    const i = Math.floor(run.time / 3.2) % DEMO_LINES.length;
    ctx.font = `bold ${Math.round(14 * z)}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    const s = DEMO_LINES[i];
    const tw = ctx.measureText(s).width;
    ctx.fillStyle = 'rgba(8,16,12,0.72)';
    ctx.beginPath(); ctx.roundRect(w / 2 - tw / 2 - 12 * z, h * 0.135, tw + 24 * z, 24 * z, 8 * z); ctx.fill();
    ctx.fillStyle = '#ffe9a8';
    ctx.fillText(s, w / 2, h * 0.135 + 16 * z);
  }
  ctx.restore();
}

// Цветовая грамматика телеграфов (S1.10) — единый язык через все снаряды:
//   жёлтый  #ffd54a — «держи/отпускай здесь» (perfect-кольцо, зона hold-release,
//                     сектор заряда, счёт стола) и идеальный тайминг;
//   зелёная #69f0ae — good-окно и сигнал GO (традиция светофора: «жми»);
//   голубой #8fd8ff/#4fc3f7 — «тапай» (апекс шины, прогресс заряда, шкала контакта);
//   красный #ff6b6b/#ff8a8a — «не то / жди / промах» (обманка «?», отставание, miss).
function drawQte(run, m, z) {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const def = m.qte.def, q = m.qte;
  const t = run.time - m.qteStart;
  let cy = h - 130 * z;
  if (IS_TOUCH) {
    const topOfButtons = Math.min(...touchButtons().map(b => b.y - b.r));
    // 90z: лента groove на компактных экранах не должна липнуть к кнопкам
    cy = topOfButtons - 90 * z;
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
  } else if (def.kind === 'groove') {
    // Лента нот: стойки-ноты едут справа налево к линии удара. Цвет по стороне.
    drawGrooveLane(ctx, run, m, cx, cy, w, z);
  } else if (def.kind === 'serp') {
    // Серпантин: стрелки раскрываются за reveal до бита, до того — «?»
    drawApproachHint(ctx, 'serpentine', cx, cy, z);
    const step = Math.min(80 * z, (w * 0.8) / def.count);
    const kr = step * 0.42;
    for (let i = 0; i < def.count; i++) {
      const x = cx + (i - (def.count - 1) / 2) * step;
      const g = q.beatGrades[i];
      const isNext = i === q.beatIdx;
      const beatT = q.target + i * def.beat;
      const revealed = t >= beatT - (IS_TOUCH ? 1.0 : def.reveal);
      const label = revealed ? KEY_LABEL[q.seq[i]] : '?';
      keycap(ctx, x, cy, kr * (isNext ? 1.1 : 0.85), label,
        g ? (g === 'miss' ? '#ff6b6b' : '#69f0ae')
          : isNext && revealed ? '#ffd54a' : 'rgba(255,255,255,0.5)');
    }
  } else if (def.kind === 'freeze' && q.stage === 1) {
    // Судья считает: большая цифра, шкала выдержки, предупреждение НЕ ЖАТЬ.
    const secLeft = Math.ceil(def.freezeTime * (1 - q.progress));
    ctx.fillStyle = q.inPause ? 'rgba(255,255,255,0.45)' : '#ffd54a';
    ctx.font = `900 ${Math.round(58 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(q.inPause ? '…' : String(secLeft), cx, cy - 84 * z);
    gaugeBar(ctx, cx, cy, 260 * z, q.progress, '#b388ff', 'ЗАМРИ! Не трогай кнопки', z);
  } else if (def.kind === 'freeze' && q.stage === 2) {
    const pulse = 1 + Math.sin(run.time * 26) * 0.12;
    ctx.fillStyle = '#69f0ae';
    ctx.font = `900 ${Math.round(46 * z * pulse)}px "Segoe UI", sans-serif`;
    ctx.fillText('GO!', cx, cy - 54 * z);
    keycap(ctx, cx, cy, 48 * z * pulse, KEY_LABEL[def.key], '#69f0ae');
  } else if (def.kind === 'doubleTap' && q.stage === 1) {
    // Второй тап в апексе: кольцо сжимается к моменту вершины полёта
    const apexT = q.tapAt + (q.apexDelay ?? def.apexDelay);
    const rem = Math.max(0, apexT - t);
    const inWin = Math.abs(t - apexT) <= def.window2;
    keycap(ctx, cx, cy, 48 * z, KEY_LABEL[def.key], inWin ? '#ffd54a' : '#8fd8ff');
    ring(ctx, cx, cy, 48 * z + rem * 160 * z, inWin ? '#ffd54a' : '#8fd8ff');
  } else if (def.kind === 'charge' && q.holding) {
    // Дуга заряда: сектор зоны жёлтый, стрелка-прогресс бежит по дуге
    drawChargeArc(ctx, cx, cy, 52 * z, q.progress, def.zone, z, IS_TOUCH);
  } else if (def.kind === 'hold' && q.holding) {
    gaugeBar(ctx, cx, cy, 260 * z, q.progress, '#69f0ae', 'ДЕРЖИМ… стол 3 сек', z);
  } else if (def.kind === 'holdRelease' && q.holding) {
    // Шкала движения по снаряду с жёлтой зоной — отпустить в зоне
    const bw = 300 * z;
    const zr = q.zoneRed; // узкая overdrive-зона у самого края (S4.5), может не быть
    const up = IS_TOUCH ? 'ВЕРХ' : '↑';
    gaugeBar(ctx, cx, cy, bw, q.progress, '#4fc3f7',
      zr ? `Отпусти ${up} в жёлтой · красная = жадный бонус`
        : `Отпусти ${up} в жёлтой зоне!`, z);
    const zx = cx - bw / 2 + bw * def.zone[0], zw = bw * (def.zone[1] - def.zone[0]);
    ctx.fillStyle = 'rgba(244,196,48,0.85)';
    ctx.fillRect(zx, cy - 12 * z, zw, 24 * z);
    // Красная зона рисуется ПОСЛЕ gaugeBar (иначе рамка перекроет) и поверх жёлтой.
    // Пульс + косая штриховка + двойной контур: в колорблайнде её от жёлтой
    // отличает форма, а не только цвет — это не «ошибка», а жадный бонус.
    if (zr) {
      const rx0 = cx - bw / 2 + bw * zr[0];
      const rw = Math.max(3 * z, bw * (zr[1] - zr[0]));
      const pl = 0.5 + 0.5 * Math.sin(run.time * 13);
      const top = cy - 12 * z, hgt = 24 * z;
      ctx.save();
      ctx.fillStyle = `rgba(214,40,40,${0.55 + 0.35 * pl})`;
      ctx.fillRect(rx0, top, rw, hgt);
      ctx.beginPath(); ctx.rect(rx0, top, rw, hgt); ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2;
      for (let sx = rx0 - hgt; sx < rx0 + rw + hgt; sx += 7 * z) {
        ctx.beginPath(); ctx.moveTo(sx, cy + 12 * z); ctx.lineTo(sx + hgt, top); ctx.stroke();
      }
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.strokeRect(rx0, top, rw, hgt);
      ctx.strokeStyle = `rgba(255,90,90,${0.4 + 0.6 * pl})`; ctx.lineWidth = 1.5;
      ctx.strokeRect(rx0 - 3 * z, top - 4 * z, rw + 6 * z, hgt + 8 * z);
      ctx.restore();
      // Зона всего 3% шкалы (~10px) — курсор её почти целиком перекрывает.
      // Ширину не раздуваем (игрок целится по нарисованному), поэтому выносим
      // указатель ВНИЗ: под шкалой пусто до тач-кнопок, а зона остаётся видна.
      const rcx = rx0 + rw / 2, ty = cy + 20 * z;
      ctx.save();
      ctx.fillStyle = `rgba(255,90,90,${0.55 + 0.45 * pl})`;
      ctx.beginPath();
      ctx.moveTo(rcx, ty); ctx.lineTo(rcx - 5 * z, ty + 7 * z); ctx.lineTo(rcx + 5 * z, ty + 7 * z);
      ctx.closePath(); ctx.fill();
      ctx.font = `900 ${Math.round(13 * z)}px "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText('×1.5', rcx, ty + 21 * z);
      ctx.fillStyle = '#ff8a8a';
      ctx.fillText('×1.5', rcx, ty + 21 * z);
      ctx.restore();
    }
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
    // Обманка до раскрытия: кандидаты крутятся, настоящая кнопка ещё не ясна.
    // Красный «?» = «жди, не тапай» (цветовая грамматика).
    const step = 92 * z;
    const spin = Math.floor(run.time * 9) % m.decoys.options.length;
    m.decoys.options.forEach((k, i) => {
      keycap(ctx, cx + (i - 1) * step, cy, 42 * z * (i === spin ? 1.12 : 0.9), KEY_LABEL[k],
        i === spin ? '#ff8a65' : 'rgba(255,255,255,0.4)');
    });
    ctx.fillStyle = '#ff6b6b';
    ctx.font = `900 ${Math.round(34 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText('?', cx, cy - 62 * z);
  } else if (m.decoys && m.decoys.revealed) {
    // Обманка раскрыта: крупно бьём настоящую клавишу — реагируй! (и на таче
    // подсветится соответствующая кнопка через expectedKey)
    const need = q.pressKey || def.key;
    const inGood = Math.abs(t - q.target) <= q.w * 0.6;
    const pulse = 1 + Math.sin(run.time * 24) * 0.12;
    ctx.fillStyle = '#ffd54a';
    ctx.font = `900 ${Math.round(20 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText('ЖМИ!', cx, cy - 60 * z);
    keycap(ctx, cx, cy, 50 * z * pulse, KEY_LABEL[need], inGood ? '#ffd54a' : '#fff');
  } else if (def.kind === 'press') {
    // press: ГЛАВНЫЙ индикатор тайминга — кольцо вокруг собаки (game.js).
    // Здесь только «какую клавишу жать» (на таче это делает сама кнопка).
    if (!IS_TOUCH) {
      const inPerfect = Math.abs(t - q.target) <= q.w * 0.28;
      const inGood = Math.abs(t - q.target) <= q.w * 0.6;
      const pulse = inPerfect ? 1 + Math.sin(run.time * 22) * 0.08 : 1;
      keycap(ctx, cx, cy, 44 * z * pulse, KEY_LABEL[q.pressKey || def.key],
        inPerfect ? '#ffd54a' : inGood ? '#9ff0b4' : 'rgba(255,255,255,0.85)');
    }
  } else {
    // стадия захода holdRelease/hold/twoStage/freeze/charge/doubleTap:
    // клавиша + сжимающееся кольцо тайминга + микро-подсказка «что дальше»
    drawApproachHint(ctx, m.o.type, cx, cy, z);
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

// Лента нот Weave Groove: ноты-стойки едут справа налево к линии удара.
// Синие ← и жёлтые → — цветокод стороны; на линии удара вспышка грейда.
function drawGrooveLane(ctx, run, m, cx, cy, w, z) {
  const q = m.qte, def = q.def;
  const t = run.time - m.qteStart;
  const laneW = Math.min(w * 0.86, 660 * z), laneH = 58 * z;
  const lx = cx - laneW / 2, hitX = lx + laneW * 0.18;
  const pxPerSec = laneW * 0.55 / Math.max(0.3, q.beat * 3); // ~3 бита видимы справа
  ctx.save();
  // Фон ленты
  ctx.fillStyle = 'rgba(12,20,16,0.78)';
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(lx, cy - laneH / 2, laneW, laneH, 12 * z); ctx.fill(); ctx.stroke();
  // Линия удара
  ctx.strokeStyle = '#ffd54a'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(hitX, cy - laneH / 2 - 6 * z); ctx.lineTo(hitX, cy + laneH / 2 + 6 * z); ctx.stroke();
  // Будущие ноты от текущего бита
  if (q.nextBeatT !== null) {
    ctx.beginPath(); ctx.rect(lx, cy - laneH, laneW, laneH * 2); ctx.clip();
    for (let i = q.beatIdx; i < def.beats; i++) {
      const beatT = q.nextBeatT + (i - q.beatIdx) * q.beat;
      const x = hitX + (beatT - t) * pxPerSec;
      if (x > lx + laneW + 20 * z) break;
      const side = i % 2; // 0 = ←, 1 = →
      const near = Math.max(0, 1 - Math.abs(beatT - t) / q.beat);
      keycap(ctx, x, cy, (17 + near * 5) * z, side ? '→' : '←',
        side ? '#e0a63c' : '#4b8bd4');
    }
  }
  // Вспышка последнего грейда на линии удара
  const lastG = q.beatGrades[q.beatGrades.length - 1];
  if (q.beatGrades.length !== q._seenBeats) { q._seenBeats = q.beatGrades.length; q._lastFlash = t; }
  if (lastG && t - (q._lastFlash ?? -9) < 0.28) {
    ctx.fillStyle = { perfect: '#ffd54a', good: '#69f0ae', late: '#ffab6b', miss: '#ff6b6b' }[lastG];
    ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.arc(hitX, cy, 14 * z, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }
  // BPM и прогресс стоек
  ctx.fillStyle = '#b388ff';
  ctx.font = `bold ${Math.round(13 * z)}px "Segoe UI", sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText(`${Math.round(60 / q.beat)} BPM`, lx + 8 * z, cy - laneH / 2 - 10 * z);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillText(`стойка ${Math.min(q.beatIdx + 1, def.beats)}/${def.beats}`, lx + laneW - 8 * z, cy - laneH / 2 - 10 * z);
  ctx.restore();
}

// Дуга заряда spread/triple: 270° прогресса, зона отпуска — жёлтый сектор.
function drawChargeArc(ctx, cx, cy, r, progress, zone, z, touch) {
  const a0 = Math.PI * 0.75, sweep = Math.PI * 1.5; // 270°, от юго-запада по часовой
  ctx.save();
  ctx.lineCap = 'round';
  // Фон дуги
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 10 * z;
  ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + sweep); ctx.stroke();
  // Жёлтый сектор зоны
  ctx.strokeStyle = 'rgba(244,196,48,0.9)';
  ctx.beginPath(); ctx.arc(cx, cy, r, a0 + sweep * zone[0], a0 + sweep * zone[1]); ctx.stroke();
  // Прогресс
  const inZone = progress >= zone[0] && progress <= zone[1];
  ctx.strokeStyle = inZone ? '#ffd54a' : '#8fd8ff'; ctx.lineWidth = 6 * z;
  if (inZone) { ctx.shadowColor = '#ffd54a'; ctx.shadowBlur = 12; }
  ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + sweep * Math.min(1, progress)); ctx.stroke();
  ctx.shadowBlur = 0;
  // Подпись
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(15 * z)}px "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(`Отпусти ${touch ? 'ХОП' : 'ПРОБЕЛ'} в жёлтом!`, cx, cy - r - 18 * z);
  ctx.restore();
}

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
  // app.t инкрементирует только frame() — здесь был двойной тик (анимации ×2)
  // Фон: размытое поле
  renderer.cam.x = 26 + Math.sin(app.t * 0.1) * 6;
  renderer.cam.y = 18 + Math.cos(app.t * 0.13) * 3;
  renderer.cam.zoom = h / 26;
  renderer.begin(dt);
  renderer.drawField({ w: 52, h: 36 }, 0.15);
  ctx.fillStyle = 'rgba(8,14,20,0.55)';
  ctx.fillRect(0, 0, w, h);

  const z = Math.min(w, h) / 700;
  // S3.2: idle-жизнь выбранной собаки — выходки по таймеру, сон без ввода
  menuIdle.favIdle = temperamentFor(breedList[app.breedIdx].id).favIdle;
  menuIdle.update(dt, { idleSec: app.t - (app.lastInputT ?? app.t) });
  const idlePose = { state: menuIdle.state, k: menuIdle.progress() };
  // Версия сборки (Fable Arcade SDK): левый нижний угол — видно, обновилась ли игра.
  ctx.save();
  ctx.textAlign = 'left';
  ctx.font = `${Math.round(11 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  ctx.fillText(SDK.VERSION, 12 * z, h - 10 * z);
  ctx.restore();
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = `900 ${Math.round(64 * z)}px "Segoe UI", sans-serif`;
  ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.strokeText('AGILITY TRIAL!', w / 2, h * 0.16);
  const grad = ctx.createLinearGradient(0, h * 0.1, 0, h * 0.2);
  grad.addColorStop(0, '#ffe082'); grad.addColorStop(1, '#ff9d47');
  ctx.fillStyle = grad;
  ctx.fillText('AGILITY TRIAL!', w / 2, h * 0.16);
  // Подзаголовок крупнее на мобайле (Codex: вторичный текст мелковат); на узком
  // экране — короче, чтобы не переносился.
  ctx.font = `${Math.round((isPortrait() ? 24 : 20) * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = '#e0f2e9';
  ctx.fillText(isPortrait() ? 'Ты — собака. Жми команды в такт!'
    : 'Ты — собака. Слушай хендлера и жми верные клавиши вовремя!', w / 2, h * 0.16 + 46 * z);
  // Промо: игра от аусси Хлои — кликабельная ссылка на её дневник
  // Промо дневника Хлои — заметнее: крупнее и на пилюле-кнопке (позиция chloeY
  // фиксирована в потоке шапки, поэтому остальная вёрстка не едет)
  const chloeText = '🐾 Игра от аусси Хлои · её дневник ВКонтакте →';
  const chloeY = h * 0.16 + 70 * z;
  ctx.font = `bold ${Math.round(16.5 * z)}px "Segoe UI", sans-serif`;
  const ctw = ctx.measureText(chloeText).width;
  ctx.fillStyle = 'rgba(20,60,90,0.55)';
  ctx.strokeStyle = 'rgba(143,216,255,0.7)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(w / 2 - ctw / 2 - 13 * z, chloeY - 13 * z, ctw + 26 * z, 21 * z, 11 * z);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#bfe6ff';
  ctx.fillText(chloeText, w / 2, chloeY + 1 * z);
  app.chloeZoneMenu = { x: w / 2 - ctw / 2 - 13 * z, y: chloeY - 13 * z, w: ctw + 26 * z, h: 21 * z };

  // Переключатель режима: явные кнопки-стрелки по бокам + точки-индикаторы
  const modeFs = Math.round((isPortrait() ? 17 : 22) * z);
  ctx.font = `bold ${modeFs}px "Segoe UI", sans-serif`;
  ctx.fillStyle = '#ffd54a';
  let modeName;
  if (app.testDrive) {
    modeName = '🧪 ТЕСТ-ДРАЙВ V4 · все новые механики';
  } else if (app.mode === 'career') {
    const season = SEASONS[app.cls]?.name || '';
    modeName = isBossStage()
      ? `КАРЬЕРА · ${season} · 👻 БОСС: ${bossFor(app.cls).name}`
      : `КАРЬЕРА · ${season} · ${CLASSES[app.cls].name} · трасса ${app.stage}/${STAGES}`;
  } else if (app.mode === 'worldcup') {
    modeName = isPortrait() ? `ЧЕМПИОНАТ МИРА (${REAL_COURSES.length})`
      : `ЧЕМПИОНАТ МИРА · реальные трассы (${REAL_COURSES.length})`;
  } else if (app.mode === 'zen') {
    modeName = isPortrait() ? '🌇 ПРОГУЛКА В ПАРКЕ'
      : '🌇 ПРОГУЛКА В ПАРКЕ · без таймера, штрафов и судьи';
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
  // Точки-индикаторы режимов (центрируются по количеству — их уже четыре с Zen)
  const modesOrder = MODE_ORDER;
  modesOrder.forEach((mo, i) => {
    ctx.beginPath();
    ctx.fillStyle = mo === app.mode ? '#ffd54a' : 'rgba(255,255,255,0.35)';
    ctx.arc(w / 2 + (i - (modesOrder.length - 1) / 2) * 16 * z, modeY + 11 * z, 3.4 * z, 0, Math.PI * 2);
    ctx.fill();
  });

  // Подстрока: карта карьеры / модификатор дня — продолжение потока
  const subY = modeY + 30 * z;
  let headerBottom = modeY + 16 * z; // низ точек-индикаторов
  if (app.mode === 'career') {
    const extra = drawCareerMap(ctx, w / 2, subY, z, isPortrait());
    headerBottom = subY + ((isPortrait() ? 1 : 2) + (extra || 0)) * 19 * z;
  } else if (app.mode === 'zen') {
    // Честная подпись: в Zen ничего не начисляется — это отдых, а не ферма
    ctx.font = `${Math.round(16 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = '#ffcf9e';
    ctx.fillText('Закат, свой темп · промахи без штрафа · без наград и рекордов', w / 2, subY);
    headerBottom = subY + 6 * z;
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
      drawCardDog(ctx, { runPhase: app.t * (sel ? 8 : 3), happy: sel && !locked,
        idle: sel && !locked ? idlePose : null }, b, cardH * 0.55);
      ctx.restore();
      ctx.textAlign = 'left';
      ctx.fillStyle = sel ? '#ffe082' : '#fff';
      ctx.font = `bold ${Math.round(21 * z)}px "Segoe UI", sans-serif`;
      ctx.fillText(`${locked ? '🔒 ' : ''}${b.name}`, cx - cardW / 2 + cardH * 1.6, cy + cardH * 0.42);
      ctx.fillStyle = 'rgba(255,255,255,0.82)';
      ctx.font = `${Math.round(14.5 * z)}px "Segoe UI", sans-serif`;
      ctx.fillText(locked ? 'Открой: 5 золотых 🥇' : b.desc,
        cx - cardW / 2 + cardH * 1.6, cy + cardH * 0.72);
      if (window.__layoutDebug) {
        window.__layoutDebug.cards.push({ x: cx - cardW / 2, y: cy, w: cardW, h: cardH,
          descBottom: cy + cardH * 0.72 + 13 * z, locked, sel });
      }
      ctx.restore();
    });
    // Явная жёлтая кнопка старта (Codex: CTA должна быть сильнее ссылки).
    ctx.textAlign = 'center';
    if (window.__layoutDebug) window.__layoutDebug.startTextY = h * 0.84 - 22 * z;
    const bw = w * 0.7, bx = w / 2 - bw / 2, byy = h * 0.835, bh = 52 * z;
    const pulse = 0.9 + (Math.sin(app.t * 4) * 0.5 + 0.5) * 0.1;
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.fillStyle = '#ffd54a';
    ctx.beginPath(); ctx.roundRect(bx, byy, bw, bh, 14 * z); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#1a1a1a';
    ctx.font = `900 ${Math.round(22 * z)}px "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText('▶  НА СТАРТ', w / 2, byy + bh / 2 + 1);
    ctx.textBaseline = 'alphabetic';
    app.startBtnZone = { x: bx, y: byy, w: bw, h: bh };
    ctx.font = `${Math.round(14.5 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('или тап по выбранной собаке', w / 2, byy + bh + 22 * z);
    if (app.bestPoints) {
      ctx.fillStyle = '#ffd54a';
      ctx.font = `bold ${Math.round(14 * z)}px "Segoe UI", sans-serif`;
      ctx.fillText(`Рекорд: ${app.bestPoints} очков`, w / 2, byy + bh + 44 * z);
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
    const fake = { x: 0, y: 0, heading: -0.1, runPhase: app.t * (sel ? 8 : 3), speed: sel ? 5 : 1,
      happy: sel && !locked, elevation: 0, idle: sel && !locked ? idlePose : null };
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

  // Дар выбранной породы — строкой между карточками и стартом
  const selBreed = breedList[app.breedIdx];
  if (selBreed.abilityText && !breedLocked(selBreed)) {
    ctx.font = `bold ${Math.round(14 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = '#ffcf9e';
    ctx.fillText(selBreed.abilityText, w / 2, h * 0.795);
  }

  ctx.font = `bold ${Math.round(24 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = Math.sin(app.t * 4) > -0.3 ? '#fff' : 'rgba(255,255,255,0.4)';
  ctx.fillText('ENTER / клик — на старт!', w / 2, h * 0.83);
  ctx.font = `${Math.round(15 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.fillText('← → выбор породы · ПРОБЕЛ прыжок · ↓ туннель · ←→ слалом · ↑ горка/бум · SHIFT риск ×2 · L — лидерборд', w / 2, h * 0.88);
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
  // S3.2 «Собака живёт в меню»: поза по состоянию idle-автомата
  const idle = dog.idle || null;
  const st = idle ? idle.state : 'idle';
  const k = idle ? idle.k : 0;          // прогресс состояния 0..1
  const breath = st === 'sleep' ? 1 + Math.sin(app.t * 2.2) * 0.035 : 1;
  if (st === 'tailChase') {             // гоняется за хвостом: кружится вокруг себя
    ctx.rotate(Math.sin(k * Math.PI) * k * Math.PI * 3);
    ctx.scale(0.94, 0.94);
  } else if (st === 'shake') {          // встряхивается после смены окраса
    ctx.rotate(Math.sin(k * Math.PI * 14) * 0.13);
  } else if (st === 'scratch') {        // чешется: корпус кренится к задней лапе
    ctx.rotate(-0.12 + Math.sin(k * Math.PI * 12) * 0.03);
  } else if (st === 'sleep') {          // спит: осел на землю, дышит
    ctx.translate(0, 3.5);
    ctx.scale(1.06, 0.9 * breath);
  } else if (st === 'sit') {            // ритуал: садится — зад оседает, перед прямой
    ctx.rotate(-0.36 * k);
    ctx.translate(0, 3.2 * k);
  } else if (st === 'paw') {            // ритуал: сидит и подаёт лапу
    ctx.rotate(-0.36);
    ctx.translate(0, 3.2);
  } else if (st === 'chew') {           // ритуал: сидит и жуёт печеньку
    ctx.rotate(-0.36);
    ctx.translate(0, 3.2 + Math.sin(app.t * 18) * 0.4);
  }
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
  // Экипировка шеи видна и вне забега: бандана, ошейник, розетка подиума (S3.5)
  if (breed.neckItem) {
    const ni = breed.neckItem;
    const col = ni.color === 'rainbow' ? `hsl(${(app.t * 90) % 360}, 85%, 60%)` : ni.color;
    if (ni.kind === 'bandana') {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(8, -5); ctx.lineTo(11, 3); ctx.lineTo(4, 5); ctx.closePath(); ctx.fill();
    } else {
      ctx.strokeStyle = ni.kind === 'rosette' ? '#7a5230' : col;
      ctx.lineWidth = 2.6;
      ctx.beginPath(); ctx.ellipse(9.5, -2, 4.6, 3.4, -0.2, 0.4, Math.PI * 1.4); ctx.stroke();
      if (ni.kind === 'rosette') {
        ctx.fillStyle = col;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          ctx.beginPath();
          ctx.ellipse(9.5 + Math.cos(a) * 1.7, 0.6 + Math.sin(a) * 1.7, 1.5, 1.0, a, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#fff8dc';
        ctx.beginPath(); ctx.arc(9.5, 0.6, 1.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = col; ctx.lineWidth = 1.2;
        for (const off of [-1.0, 1.0]) {
          ctx.beginPath(); ctx.moveTo(9.5 + off * 0.6, 1.8); ctx.lineTo(9.5 + off * 1.6, 5.6); ctx.stroke();
        }
      }
    }
  }
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
  const closedEye = st === 'sleep' || st === 'yawn';
  if (closedEye) {              // спит или зевает — глаз-дужка
    ctx.strokeStyle = '#222'; ctx.lineWidth = 0.9; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(15.5, -5.0, 1.5, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
  } else if (breed.eye) {
    ctx.fillStyle = breed.eye;
    ctx.beginPath(); ctx.arc(15.5, -5.5, 1.35, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(15.7, -5.5, 0.65, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.beginPath(); ctx.arc(15.5, -5.5, 1.1, 0, Math.PI * 2); ctx.fill();
  }
  // Зевок: раскрытая пасть тянется по синусоиде состояния
  if (st === 'yawn') {
    const open = Math.sin(k * Math.PI) * 3.4;
    ctx.fillStyle = '#2a1a1a';
    ctx.beginPath(); ctx.ellipse(19.5, -1.0 + open * 0.3, 2.6, 1.2 + open, -0.1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e2697d';
    ctx.beginPath(); ctx.ellipse(19.5, 0.4 + open * 0.5, 1.3, 0.9 + open * 0.4, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = breed.ear;
  for (const side of [-1, 1]) {
    // Во сне уши обвисают, при встряхивании — хлопают
    const earRot = st === 'sleep' ? 0.5 : st === 'shake' ? Math.sin(k * Math.PI * 14) * 0.5 : 0;
    ctx.save(); ctx.translate(12, -8); ctx.rotate(-0.6 + side * 0.25 + earRot);
    ctx.beginPath(); ctx.ellipse(0, -3, 1.9, 3.8, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  // Лапы: в покое/беге шагают, в выходках стоят (кроме чесания задней лапой)
  const running = st === 'idle' || st === 'tailChase' || st === 'shake';
  const run = running ? dog.runPhase : 0;
  ctx.strokeStyle = breed.legs || breed.body; ctx.lineWidth = 3.2; ctx.lineCap = 'round';
  for (const [lx, ph] of [[-8, 0], [-8, Math.PI], [8, Math.PI * 0.9], [8, Math.PI * 1.9]]) {
    // Чешется: одна задняя лапа поднята к уху и частит
    if (st === 'scratch' && lx === -8 && ph === 0) {
      const sc = Math.sin(k * Math.PI * 12) * 1.2;
      ctx.beginPath(); ctx.moveTo(-8, 2); ctx.lineTo(6.5 + sc, -6.5); ctx.stroke();
      continue;
    }
    if (st === 'sleep') { // лежит: лапы поджаты вперёд
      ctx.beginPath(); ctx.moveTo(lx, 2); ctx.lineTo(lx + 4, 5); ctx.stroke();
      continue;
    }
    if (st === 'sit' || st === 'paw' || st === 'chew') {
      // Сидит: задние лапы подогнуты, передние прямые; «дай лапу» — правая вперёд
      // Задние лапы подогнуты под корпус — собака сидит на бедре
      if (lx < 0) { ctx.beginPath(); ctx.moveTo(lx, 2); ctx.lineTo(lx - 2.5, 5.5); ctx.stroke(); continue; }
      if (st === 'paw' && ph === Math.PI * 0.9) {
        ctx.beginPath(); ctx.moveTo(lx, 2); ctx.lineTo(lx + 8, -3 + Math.sin(app.t * 8) * 0.8); ctx.stroke();
        continue;
      }
      ctx.beginPath(); ctx.moveTo(lx, 2); ctx.lineTo(lx + 1, 10); ctx.stroke();
      continue;
    }
    const sw = Math.sin(run + ph) * 0.8;
    ctx.beginPath(); ctx.moveTo(lx, 2); ctx.lineTo(lx + Math.sin(sw) * 7, 10); ctx.stroke();
  }
  if (st === 'chew') {
    const chew = Math.abs(Math.sin(app.t * 14)) * 1.6;
    ctx.fillStyle = '#2a1a1a';
    ctx.beginPath(); ctx.ellipse(19.5, -0.6, 2.3, 0.7 + chew, -0.1, 0, Math.PI * 2); ctx.fill();
  }
  if (dog.happy && st !== 'sleep' && st !== 'yawn') {
    ctx.fillStyle = '#e2697d';
    ctx.beginPath(); ctx.ellipse(19, 0.5, 1.5, 2.6, 0.3, 0, Math.PI * 2); ctx.fill();
  }
  // Хвост: во сне лежит, в погоне за хвостом задран и мечется
  ctx.strokeStyle = breed.body; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-13, -3);
  if (st === 'sleep') ctx.quadraticCurveTo(-18, 1, -20, 4);
  else if (st === 'tailChase') ctx.quadraticCurveTo(-18, -9, -13, -12);
  else ctx.quadraticCurveTo(-19, -8, -21, -5 + Math.sin(app.t * (dog.happy ? 18 : 8)) * (dog.happy ? 7 : 3));
  ctx.stroke();
  // Сонные «Z-z-z» над головой
  if (st === 'sleep') {
    ctx.fillStyle = 'rgba(180,220,255,0.9)';
    ctx.font = 'bold 7px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    for (let i = 0; i < 3; i++) {
      const ph2 = (app.t * 0.6 + i * 0.33) % 1;
      ctx.globalAlpha = 0.85 * (1 - ph2);
      ctx.fillText('z', 17 + ph2 * 7, -12 - ph2 * 9 - i * 1.5);
    }
    ctx.globalAlpha = 1;
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
// Геометрия панели протокола — одна формула на отрисовку и на хит-тест кнопок.
// Панель выросла против S3: снизу добавился блок «ближайшие цели» (S4.10).
function resultsPanel() {
  const w = canvas.width, h = canvas.height;
  const z = Math.min(w, h) / 700;
  const pw = Math.min(520 * z, w * 0.9);
  // Спокойный итог (Zen/практика) короче протокола судьи: там нет звёзд, медали,
  // наград и целей. Высоту меняем именно здесь — эту же геометрию читает
  // хит-тест тач-кнопок, иначе кнопки и их зоны разъедутся.
  const calm = !!(app.run && (app.run.zen || app.run.practice));
  const ph = Math.min((calm ? (IS_TOUCH ? 560 : 500) : (IS_TOUCH ? 732 : 664)) * z, h * 0.96);
  return { w, h, z, pw, ph, px: w / 2 - pw / 2, py: h / 2 - ph / 2 };
}

function drawResults(run, z) {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  // Zen и практика судьёй не судятся: у них свой спокойный итог без вердикта,
  // звёзд, медалей и начислений (см. drawCalmResults).
  if (run.zen || run.practice) return drawCalmResults(run, z);
  if (!app.result) {
    // Тихая автокалибровка: усваиваем дельты хитов слалома этого прогона
    if (run._calibSamples && run._calibSamples.length) {
      const st = updateCalibration(
        { offset: settings.audioOffset || 0, hits: settings.calibHits || [] },
        run._calibSamples);
      settings.audioOffset = st.offset;
      settings.calibHits = st.hits;
      saveSettings();
    }
    app.result = finalScore({
      time: run.time, sct: run.sct, faults: run.score.faults,
      perfects: run.score.perfects, total: run.marks.length, maxCombo: run.score.maxCombo,
      bonus: run.bonusPoints || 0,
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
    // Перебег прошедшего дня из архива (S4.11) — вне зачёта: ни медали, ни рекорда
    // дня, ни онлайн-сабмита. Локальная статистика и XP при этом живут как обычно.
    const scored = !run.unscored;
    // Ассист расширяет окна в полтора раза — время такого прогона несопоставимо
    // с чужими в общем топе, поэтому онлайн-сабмит выключен. Локальный прогресс
    // (медали, карьера, рекорд) остаётся: игра должна проходиться и с ассистом,
    // иначе доступность превращается в тупик.
    const scoredOnline = scored && !run.assist;
    app.newMedal = scored ? recordMedal(app.result.stars) : false;
    app.newDailyBest = false;
    if (scored && app.mode === 'daily') app.newDailyBest = saveDailyBest(app.result.points);
    // Босс-дуэль: победа = квалификация + время быстрее призрака
    if (run.ghost && run.bossCls) {
      const won = app.result.qualified && run.time < run.ghost.time;
      if (won) {
        app.bossWin = { boss: bossFor(run.bossCls), time: run.time, ghostTime: run.ghost.time,
          breedName: run.breed.name, cls: run.bossCls };
        applyBossVictory(run.bossCls);
        run.finishLine = pickLine('bossWin');
        track('boss_win', { boss: run.bossCls, name: bossFor(run.bossCls).name, time: +run.time.toFixed(2) });
        audio.fanfare();
      } else {
        run.finishLine = pickLine('bossLose');
      }
    } else {
      run.finishLine = pickLine(app.result.clean ? 'finishClean' : 'finishFail');
    }
    // Достижения
    const newly = checkAchievements({
      run, result: app.result, mode: app.mode, cls: app.cls, goldCount: medalCounts()[3],
      meta, medals: loadMedals(),
    });
    for (const a of newly) {
      toasts.push({ icon: a.icon, name: a.name, desc: a.desc, t: 0 });
      track('achievement_unlock', { id: a.id });
      audio.fanfare();
    }
    if (scored && app.result.points > app.bestPoints) {
      app.bestPoints = app.result.points;
      localStorage.setItem('agility_best', String(app.bestPoints));
    }
    saveRunToBoard(run, app.result);

    // Аналитика + онлайн-лидерборд (кроме разминки и тест-драйва).
    if (!run.warmup && !app.testDrive) {
      // Успешность по КАЖДОМУ типу снаряда: seen/perfect/clean(good+late)/fault(miss)
      // → дашборд «Чистота снарядов» показывает, где игроки сыплются по механике.
      const obStats = {};
      for (const m of run.marks) {
        const g = m.qte?.result?.grade;
        const a = obStats[m.o.type] || (obStats[m.o.type] = { seen: 0, perfect: 0, clean: 0, fault: 0 });
        a.seen++;
        if (g === 'perfect') a.perfect++;
        else if (g === 'good' || g === 'late') a.clean++;
        else if (g === 'miss') a.fault++;
      }
      track('run_end', { run_id: app._runId, points: app.result.points, time: +run.time.toFixed(2),
        faults: app.result.totalFaults, stars: app.result.stars, clean: !!app.result.clean,
        qualified: !!app.result.qualified, eliminated: !!run.eliminated,
        perfects: run.score.perfects, max_combo: run.score.maxCombo,
        risks: run.focus?.used || 0, golden: !!run.goldenWeave,
        obstacles: obStats, obstacle_count: run.marks.length,
        assist: !!run.assist,
        mode: app.mode, cls: app.cls, breed: run.breed.name });
      if (scoredOnline && app.result.points > 0) submitOnline(app.result.points, run.time);
    }

    // ---- V2 Мета: перфект-челлендж (4-я звезда), валюты, XP, задания ----
    if (!run.warmup) {
      const res0 = app.result;
      // 4-я звезда: все перфекты + 0 фолтов + запас времени >= 3с
      if (res0.stars === 3 && run.score.perfects === run.marks.length
          && res0.totalFaults === 0 && run.time <= run.sct - 3) {
        res0.stars = 4;
        if (scored) app.newMedal = recordMedal(4) || app.newMedal;
      }
      const trackId = courseKey();
      const dkey = new Date().toDateString();
      if (!meta.counters.runsToday || meta.counters.runsToday.day !== dkey) {
        meta.counters.runsToday = { day: dkey, n: 0 };
      }
      meta.counters.runsToday.n += 1;
      // S3-досье: статистика по типам снарядов, личный рекорд собаки и трассы.
      // Рекорд трассы питает реплику комментатора «темп рекорда ринга».
      recordObstacleStats(meta, run.marks);
      recordBestTime(meta, breedList[app.breedIdx].id, run.time, res0.clean);
      if (res0.clean) {
        const cb = meta.counters.courseBest || (meta.counters.courseBest = {});
        if (cb[trackId] == null || run.time < cb[trackId]) cb[trackId] = +run.time.toFixed(2);
      }
      const earned = earnFromRun(meta, {
        points: res0.points, stars: Math.min(3, res0.stars), trackId,
        isDaily: scored && app.mode === 'daily', todayStr: todayStr(),
        runOfDay: meta.counters.runsToday.n,
      });
      // Заначка сработала молча — сообщаем постфактум (Duolingo-паттерн)
      const frzUsed = earned.detail.find(d => d[0] === 'freezeUsed');
      if (frzUsed) {
        earned.detail = earned.detail.filter(d => d[0] !== 'freezeUsed');
        toasts.push({ icon: '🧊', name: 'Заначка спасла стрик!', desc: `Покрыт пропуск (${frzUsed[1]} дн.)`, t: 0 });
      }
      // Per-dog медали: золото копится на собаку (для будущих титульных ачивок)
      if (res0.stars >= 3) {
        meta.counters.goldByBreed = meta.counters.goldByBreed || {};
        meta.counters.goldByBreed[breedList[app.breedIdx].id] =
          (meta.counters.goldByBreed[breedList[app.breedIdx].id] || 0) + 1;
      }
      // Честная цена ассиста: косточки за прогон вдвое. Урезаем ДО дара пуделя,
      // чтобы множители не спорили за порядок, и обязательно показываем игроку
      // строкой в награде — скрытый штраф был бы обманом, а не честностью.
      if (run.assist && earned.bones > 0) {
        const cut = earned.bones - Math.floor(earned.bones * 0.5);
        meta.bones -= cut;
        earned.bones -= cut;
        earned.detail.push(['ассист ×0.5', -cut]);
      }
      // Пудель: дар «шоу» — ×1.25 косточек за прогон (×1.5 стакался со
      // streak-множителем до ×2.25 и делал пуделя безальтернативным фармером)
      if (run.breed.ability === 'show' && earned.bones > 0) {
        const extra = Math.round(earned.bones * 0.25);
        meta.bones += extra;
        earned.bones += extra;
        earned.detail.push(['дар «шоу» ×1.25', extra]);
      }
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
        track('level_up', { breed: breedId, level: L, title: tag || '' });
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
      for (const dq of doneNow) { track('quest_complete', { id: dq.id, bones: dq.bones || 0 }); toasts.push({ icon: '📋', name: 'Задание выполнено', desc: dq.name, t: 0 }); }
      app.lastEarn = { bones: earned.bones + (claimed.bones || 0), detail: earned.detail,
        rosettes: ros + (claimed.rosettes || 0), xp: xp.gained, breedId, assist: !!run.assist };
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
  const { pw, ph, px, py } = resultsPanel();
  // Слоты нижней части протокола: медаль — герой (крупная, без рамки), внизу у Хлои воздух.
  //   slot1 — итог против времени/призрака, medal — крупная медаль, earn — награда+XP,
  //   goals — три ближайшие цели (S4.10), chloe — промо
  const SL = { one: 334 * z, medal: 394 * z, medalCap: 414 * z, earn: 438 * z,
    goals: 466 * z, chloe: 560 * z };
  ctx.save();
  // Сильнее гасим сцену за протоколом (по ревью Codex: конфетти/HUD мешали читать)
  ctx.fillStyle = `rgba(6,12,10,${0.86 * ease(0, 0.3)})`;
  ctx.fillRect(0, 0, w, h);
  // Непрозрачная карточка протокола
  ctx.save();
  ctx.globalAlpha = ease(0, 0.3);
  ctx.fillStyle = 'rgba(14,26,20,0.98)';
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(px, py, pw, ph, 16 * z); ctx.fill(); ctx.stroke();
  ctx.restore();
  ctx.textAlign = 'center';

  // Метка ассиста — в свободном левом верхнем углу протокола, над вердиктом.
  // Прямо называет цену: половина косточек и никакого онлайн-топа.
  if (run.assist && ft > 0.2) {
    const txt = '🤝 Ассист · 🦴 ×0.5 · без онлайн-топа';
    ctx.save();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.globalAlpha = ease(0.2, 0.3);
    ctx.font = `bold ${Math.round(12 * z)}px "Segoe UI", sans-serif`;
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = 'rgba(20,50,36,0.85)';
    ctx.strokeStyle = 'rgba(159,240,180,0.7)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.roundRect(px + 12 * z, py + 10 * z, tw + 20 * z, 20 * z, 10 * z);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#9ff0b4';
    ctx.fillText(txt, px + 22 * z, py + 20 * z);
    ctx.restore();
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  }

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

  // Статистика строками-пилюлями с иконкой слева и значением справа (мокап + Codex):
  // читаемая сетка вместо центрированной каши.
  const modLine = MODIFIERS[run.modifier].mult > 1 && !run.eliminated
    ? ` ×${MODIFIERS[run.modifier].mult}` : '';
  const record = ft > 2.9 && res.points >= app.bestPoints && res.points > 0;
  const rows = [
    [0.4, '⏱', 'Время', () => `${(run.time * ease(0.4)).toFixed(2)}с / SCT ${run.sct}с${res.timeFaults ? ` +${res.timeFaults}` : ''}`],
    [0.9, '🚫', 'Штраф', () => `${res.totalFaults} фолт · ${run.score.refusals} отказ`],
    [1.9, '⭐', 'Идеально', () => `${run.score.perfects}/${run.marks.length} · комбо ×${run.score.maxCombo}`],
    [2.2, '💯', 'Очки', () => `${Math.round(res.points * ease(2.2, 0.6))}${modLine}${record ? ' 🏆' : ''}`],
  ];
  const rw = pw - 56 * z, rx = w / 2 - rw / 2, rh = 32 * z, rgap = 6 * z;
  rows.forEach(([at, icon, label, fn], i) => {
    if (ft < at) return;
    stamp(at);
    const yy = py + 170 * z + i * (rh + rgap);
    ctx.save();
    ctx.globalAlpha = ease(at, 0.2);
    // фон-пилюля строки
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath(); ctx.roundRect(rx, yy, rw, rh, 9 * z); ctx.fill();
    // иконка + подпись слева
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(16 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(icon, rx + 12 * z, yy + rh / 2 + 1);
    ctx.font = `${Math.round(15 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(label, rx + 38 * z, yy + rh / 2 + 1);
    // значение справа
    ctx.textAlign = 'right';
    ctx.fillStyle = i === 3 && record ? '#ffd54a' : '#e8f5ec';
    ctx.font = `bold ${Math.round(16 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(fn(), rx + rw - 12 * z, yy + rh / 2 + 1);
    ctx.restore();
  });
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';

  // slot1 — один из: вердикт против призрака / медаль Тренера / лучший день.
  // Взаимоисключающие: в дуэли призрак, в дейли — рекорд дня, иначе — Тренер.
  if (run.ghost && ft > 3.1) {
    const dTime = run.ghost.time - run.time;
    ctx.font = `bold ${Math.round(15 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = dTime > 0 && res.qualified ? '#b388ff' : '#ff8a8a';
    const msg = dTime > 0 && res.qualified
      ? `👻 ${run.ghost.name}: ${run.ghost.time.toFixed(2)}с — ты быстрее на ${dTime.toFixed(2)}с!`
      : res.qualified
        ? `👻 ${run.ghost.name}: ${run.ghost.time.toFixed(2)}с — не хватило ${(-dTime).toFixed(2)}с`
        : `👻 Против ${run.ghost.name} нужна квалификация (≤5 фолтов)`;
    ctx.fillText(msg, w / 2, py + SL.one);
  } else if (app.mode === 'daily' && app.newDailyBest && ft > 3.2) {
    ctx.font = `bold ${Math.round(16 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = '#ffd54a';
    ctx.fillText('⭐ Лучший результат дня!', w / 2, py + SL.one);
  } else if (ft > 2.5 && res.qualified) {
    const mt = medalTimes(run.sct);
    const tier = timeMedal(run.time, run.sct);
    const dAuthor = run.time - mt.author;
    ctx.font = `bold ${Math.round(14 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = tier === 'author' ? '#ffd54a' : '#cfe4ff';
    const label = { author: '', gold: '🥇 Золото времени',
      silver: '🥈 Серебро времени', bronze: '🥉 Бронза времени' }[tier] || '';
    const msg = tier === 'author'
      ? `🏅 Медаль Тренера! (${mt.author.toFixed(1)}с)`
      : `${label} · до Тренера ${dAuthor > 0 ? dAuthor.toFixed(1) + 'с' : '—'}`;
    ctx.fillText(msg, w / 2, py + SL.one);
  }

  // Медаль — герой протокола: крупная, без рамки, с лёгким свечением и bounce.
  if (res.stars > 0 && ft >= 3.0) {
    stamp(3.0);
    const k = ease(3.0, 0.35);
    const bounce = 1 + Math.sin(k * Math.PI) * 0.5;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(255,213,74,0.6)'; ctx.shadowBlur = 18 * z;
    ctx.font = `${Math.round(52 * z * bounce)}px "Segoe UI", sans-serif`;
    ctx.fillText(MEDAL_ICON[res.stars], w / 2, py + SL.medal);
    ctx.restore();
    if (app.newMedal && ft > 3.4) {
      ctx.fillStyle = '#ffd54a';
      ctx.font = `bold ${Math.round(17 * z)}px "Segoe UI", sans-serif`;
      ctx.fillText('Новая медаль!', w / 2, py + SL.medalCap);
    }
  }

  // slot3 — награда за прогон + XP-бар собаки, сгруппированы в блок
  if (app.lastEarn && ft > 3.3) {
    const e = app.lastEarn;
    const d = dogState(meta, e.breedId);
    const tg = titleFor(d.level);
    const bw = pw - 100 * z, bx = w / 2 - bw / 2, byy = py + SL.earn - 14 * z;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath(); ctx.roundRect(bx, byy, bw, 40 * z, 10 * z); ctx.fill();
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = `bold ${Math.round(15 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = '#ffe9a8';
    ctx.fillText(`+${e.bones} 🦴${e.assist ? ' 🤝×0.5' : ''}${e.rosettes ? ` +${e.rosettes} 🏵️` : ''}  ·  +${e.xp} XP · ${tg ? tg + ' · ' : ''}ур. ${d.level}`,
      w / 2, byy + 16 * z);
    const bw2 = bw - 32 * z, bx2 = w / 2 - bw2 / 2, by2 = byy + 26 * z;
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath(); ctx.roundRect(bx2, by2, bw2, 7 * z, 3.5 * z); ctx.fill();
    ctx.fillStyle = '#69f0ae';
    ctx.beginPath(); ctx.roundRect(bx2, by2, bw2 * Math.min(1, d.xp / xpToNext(d.level)), 7 * z, 3.5 * z); ctx.fill();
    ctx.restore();
  }

  // slot «goals» — три ближайшие цели (S4.10): «во что играть дальше». Появляется
  // последним, чтобы не спорить с медалью-героем. В разминке и вне зачёта — молчим.
  if (ft > 3.6 && !run.warmup && !run.unscored) {
    const near = nearestGoals(currentGoals(), 3);
    if (near.length) {
      const k = ease(3.6, 0.4);
      const bw = pw - 56 * z, bx = w / 2 - bw / 2, top = py + SL.goals;
      ctx.save();
      ctx.globalAlpha = k;
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath(); ctx.roundRect(bx, top, bw, 74 * z, 10 * z); ctx.fill();
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.font = `bold ${Math.round(11 * z)}px "Segoe UI", sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText('🎯 БЛИЖАЙШИЕ ЦЕЛИ', bx + 12 * z, top + 13 * z);
      near.forEach((g, i) => {
        const yy = top + (30 + i * 17) * z;
        ctx.textAlign = 'left';
        ctx.font = `${Math.round(12 * z)}px "Segoe UI", sans-serif`;
        ctx.fillStyle = '#fff';
        ctx.fillText(g.icon, bx + 12 * z, yy);
        ctx.font = `${Math.round(12 * z)}px "Segoe UI", sans-serif`;
        ctx.fillStyle = '#e8f5ec';
        ctx.fillText(fitText(ctx, g.name, bw * 0.44), bx + 32 * z, yy);
        // мини-бар
        const mx = bx + bw * 0.54, mw = bw * 0.24;
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.beginPath(); ctx.roundRect(mx, yy - 2.5 * z, mw, 5 * z, 2.5 * z); ctx.fill();
        ctx.fillStyle = '#ffd54a';
        ctx.beginPath(); ctx.roundRect(mx, yy - 2.5 * z, Math.max(2 * z, mw * g.progress), 5 * z, 2.5 * z); ctx.fill();
        ctx.textAlign = 'right';
        ctx.font = `${Math.round(11 * z)}px "Segoe UI", sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        // «ещё N» врёт, когда счётчик уже добит, но цель не закрыта (косметика:
        // косточки накоплены — осталось зайти в магазин).
        const left = g.target ? Math.max(0, g.target - g.current) : 0;
        ctx.fillText(g.target
          ? (left > 0 ? `ещё ${fmtNum(left)}` : (g.kind === 'cosmetic' ? 'в магазин' : 'вот-вот'))
          : 'открыть', bx + bw - 12 * z, yy);
      });
      ctx.restore();
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    }
  }
  // Перебег из архива: честная плашка вместо блока целей
  if (ft > 3.6 && run.unscored) drawUnscoredBadge(ctx, w / 2, py + SL.goals + 30 * z, z);

  // slot4 — промо Хлои: после провала поддержка, после победы приглашение в дневник
  if (ft > 2.8) {
    const chloeMsg = res.qualified
      ? '🐾 Хлоя гордится тобой! Её дневник →'
      : '🐾 Хлоя верит в тебя! Загляни в её дневник →';
    ctx.font = `bold ${Math.round(16 * z)}px "Segoe UI", sans-serif`;
    const cy2 = py + SL.chloe;
    const ctw2 = ctx.measureText(chloeMsg).width;
    // Пилюля-кнопка — заметнее (слот SL.chloe фиксирован, вёрстка не едет)
    ctx.fillStyle = 'rgba(20,60,90,0.5)';
    ctx.strokeStyle = 'rgba(143,216,255,0.7)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(w / 2 - ctw2 / 2 - 12 * z, cy2 - 15 * z, ctw2 + 24 * z, 25 * z, 12 * z);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#bfe6ff';
    ctx.fillText(chloeMsg, w / 2, cy2 + 1 * z);
    app.chloeZoneResults = { x: w / 2 - ctw2 / 2 - 12 * z, y: cy2 - 15 * z, w: ctw2 + 24 * z, h: 25 * z };
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
      : app.mode === 'daily' ? (run.unscored ? 'Ещё попытка (вне зачёта)' : 'Ещё попытка (лучший в зачёт)')
      : 'Следующая трасса чемпионата';
    if (IS_TOUCH) {
      // Тач: настоящие кнопки вместо клавиатурных подсказок
      for (const b of resultsButtons(px, py, pw, ph, z)) {
        ctx.save();
        ctx.globalAlpha = b.id === 'treat' && app.treatDone ? 0.4 : 1;
        ctx.fillStyle = b.id === 'next' ? 'rgba(255,213,74,0.92)' : 'rgba(20,36,26,0.95)';
        ctx.strokeStyle = b.id === 'next' ? '#ffd54a' : 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.roundRect(b.x, b.y, b.w, b.h, 12 * z); ctx.fill(); ctx.stroke();
        ctx.fillStyle = b.id === 'next' ? '#1a1a1a' : '#fff';
        ctx.font = `bold ${Math.round((b.id === 'next' ? 19 : 14) * z)}px "Segoe UI", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        // Подписи узких кнопок ужимаем под ширину: «двойной барьер» в практике
        // длиннее прежних лейблов и на 390px вылезал бы за рамку.
        ctx.fillText(b.id === 'next' ? nextText : fitText(ctx, b.label, b.w - 10 * z),
          b.x + b.w / 2, b.y + b.h / 2 + 1);
        ctx.restore();
      }
      ctx.textBaseline = 'alphabetic';
    } else {
      ctx.font = `bold ${Math.round(20 * z)}px "Segoe UI", sans-serif`;
      ctx.fillStyle = Math.sin(app.t * 4) > -0.3 ? '#ffd54a' : 'rgba(255,213,74,0.4)';
      ctx.fillText(`ENTER — ${nextText.toLowerCase()}`, w / 2, py + ph - 64 * z);
      ctx.font = `${Math.round(16 * z)}px "Segoe UI", sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      const offerK = practiceOffer();
      // Строка подсказок длиннее панели не влезала — ужимаем по ширине протокола
      ctx.fillText(fitText(ctx, offerK
        ? `R — переиграть · P — 🎯 загон: ${OBSTACLE_NAMES[offerK.type] || offerK.type} · T — угостить · ESC — меню`
        : 'R — переиграть · T — угостить 🍪 · S — поделиться · ESC — меню', pw - 30 * z),
      w / 2, py + ph - 32 * z);
    }
  }
  ctx.restore();
}

// Спокойный итог: Zen «Прогулка в парке» и практика-загон. Ни вердикта, ни
// звёзд, ни медалей, ни начислений — только тёплая сводка того, что было.
// Мета молчит намеренно: режим без давления не должен становиться фермой.
function drawCalmResults(run, z) {
  const ctx = renderer.ctx, w = canvas.width, h = canvas.height;
  const practice = !!run.practice;
  if (!app.result) {
    // Заглушка результата: подиум/шеринг/клавиши ждут объект, но судить нечего
    app.result = { stars: 0, points: 0, qualified: true, clean: run.score.faults === 0,
      totalFaults: 0, timeFaults: 0,
      title: practice ? 'Загон окончен' : 'Прогулка окончена' };
    if (!app.testDrive) {
      track('run_end', { run_id: app._runId, mode: practice ? 'practice' : 'zen',
        unscored: true, time: +run.time.toFixed(2), obstacle_count: run.marks.length,
        perfects: run.score.perfects, tries: run.practice ? run.practice.tries : 0,
        obstacle: run.practice ? run.practice.type : '', assist: !!run.assist });
    }
  }
  const ft = run.finishT;
  const ease = (a, dur = 0.45) => Math.max(0, Math.min(1, (ft - a) / dur));
  const { pw, ph, px, py } = resultsPanel();
  const done = run.marks.filter(m => m.resolved).length;
  const title = practice
    ? `🎯 Загон · ${OBSTACLE_NAMES[run.practice.type] || run.practice.type}`
    : '🌇 Прогулка окончена';
  const lines = practice
    ? [
      ['🔁', 'Попыток', `${run.practice.tries}`],
      ['⭐', 'В такт', `${run.score.perfects} из ${done}`],
      ['🏃', 'Темп', run.practice.tries >= run.practice.slowTries
        ? 'вышел на полный' : `${Math.round(run.practice.speedMul * 100)}% — темп ещё щадящий`],
    ]
    : [
      ['🐾', 'Снарядов', `${done} из ${run.marks.length}`],
      ['⭐', 'В такт', `${run.score.perfects}`],
      ['🌤', 'Гуляли', `${run.time.toFixed(0)}с`],
    ];
  const footer = practice
    ? 'Тренировка: ничего не начисляется.'
    : 'Ни очков, ни медалей — просто хорошая прогулка.';

  ctx.save();
  ctx.fillStyle = `rgba(6,12,10,${0.82 * ease(0, 0.3)})`;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.globalAlpha = ease(0, 0.3);
  ctx.fillStyle = 'rgba(16,24,32,0.98)';
  ctx.strokeStyle = 'rgba(255,213,74,0.25)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(px, py, pw, ph, 16 * z); ctx.fill(); ctx.stroke();
  ctx.restore();

  ctx.textAlign = 'center';
  ctx.globalAlpha = ease(0.15, 0.35);
  ctx.fillStyle = practice ? '#8fd8ff' : '#ffc98a';
  ctx.font = `900 ${Math.round(30 * z)}px "Segoe UI", sans-serif`;
  wrapText(ctx, title, w / 2, py + 76 * z, pw - 60 * z, 36 * z);

  const rw = pw - 56 * z, rx = w / 2 - rw / 2, rh = 36 * z, rgap = 10 * z;
  lines.forEach(([icon, label, val], i) => {
    const yy = py + 150 * z + i * (rh + rgap);
    ctx.save();
    ctx.globalAlpha = ease(0.3 + i * 0.2, 0.35);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath(); ctx.roundRect(rx, yy, rw, rh, 9 * z); ctx.fill();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(16 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(icon, rx + 12 * z, yy + rh / 2 + 1);
    ctx.font = `${Math.round(15 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(label, rx + 38 * z, yy + rh / 2 + 1);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#e8f5ec';
    ctx.font = `bold ${Math.round(16 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(fitText(ctx, val, rw * 0.6), rx + rw - 12 * z, yy + rh / 2 + 1);
    ctx.restore();
  });
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.globalAlpha = ease(0.9, 0.5);
  ctx.font = `italic ${Math.round(15 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  wrapText(ctx, footer, w / 2, py + ph - 170 * z, pw - 70 * z, 22 * z);
  ctx.globalAlpha = 1;

  const nextText = practice ? 'К соревнованиям' : 'Ещё прогулка';
  if (IS_TOUCH) {
    for (const b of resultsButtons(px, py, pw, ph, z)) {
      ctx.save();
      ctx.globalAlpha = b.id === 'treat' && app.treatDone ? 0.4 : 1;
      ctx.fillStyle = b.id === 'next' ? 'rgba(255,213,74,0.92)' : 'rgba(20,36,26,0.95)';
      ctx.strokeStyle = b.id === 'next' ? '#ffd54a' : 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.roundRect(b.x, b.y, b.w, b.h, 12 * z); ctx.fill(); ctx.stroke();
      ctx.fillStyle = b.id === 'next' ? '#1a1a1a' : '#fff';
      ctx.font = `bold ${Math.round((b.id === 'next' ? 19 : 14) * z)}px "Segoe UI", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(b.id === 'next' ? nextText : fitText(ctx, b.label, b.w - 10 * z),
        b.x + b.w / 2, b.y + b.h / 2 + 1);
      ctx.restore();
    }
    ctx.textBaseline = 'alphabetic';
  } else {
    ctx.font = `bold ${Math.round(20 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = Math.sin(app.t * 4) > -0.3 ? '#ffd54a' : 'rgba(255,213,74,0.4)';
    ctx.fillText(`ENTER — ${nextText.toLowerCase()}`, w / 2, py + ph - 64 * z);
    ctx.font = `${Math.round(16 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(practice ? 'R — ещё загон · T — угостить 🍪 · ESC — меню'
      : 'R — ещё прогулка · T — угостить 🍪 · S — поделиться · ESC — меню', w / 2, py + ph - 32 * z);
  }
  ctx.restore();
}

// Тач-кнопки экрана результатов: большая «Дальше» + ряд действий под ней.
// Действий ВСЕГДА четыре: пятая кнопка не влезает в ряд на 390px, поэтому
// «Практика» (S4.9) не добавляется, а ЗАМЕЩАЕТ «Поделиться» — после провала
// хвастаться нечем, а тренировка ровно там и нужна.
function resultsButtons(px, py, pw, ph, z) {
  const bw = pw - 48 * z, bh = 52 * z;
  const rowY = py + ph - 62 * z;
  const smallW = (bw - 18 * z) / 4;
  const at = (i) => px + 24 * z + (smallW + 6 * z) * i;
  const offer = practiceOffer();
  const third = offer
    ? { id: 'practice', label: `🎯 ${OBSTACLE_NAMES[offer.type] || offer.type}` }
    : { id: 'share', label: '📤 Поделиться' };
  return [
    { id: 'next', x: px + 24 * z, y: rowY - bh - 12 * z, w: bw, h: bh },
    { id: 'retry', label: '↺ Ещё раз', x: at(0), y: rowY, w: smallW, h: 44 * z },
    { id: 'treat', label: '🍪 Угостить', x: at(1), y: rowY, w: smallW, h: 44 * z },
    { ...third, x: at(2), y: rowY, w: smallW, h: 44 * z },
    { id: 'menu', label: '⌂ Меню', x: at(3), y: rowY, w: smallW, h: 44 * z },
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
// Фанел экранов: одним хуком ловим menu_shown и открытия вкладок
// (board/shop/quests/settings/results/champion/news/trainer/calib) → screen_open.
let _prevScreen = null;
function trackScreen() {
  if (app.state === _prevScreen) return;
  _prevScreen = app.state;
  if (['menu', 'board', 'shop', 'quests', 'settings', 'dossier', 'kennel', 'archive',
    'results', 'champion', 'news',
    'trainer', 'calib', 'photo', 'podium', 'treat'].includes(app.state)) {
    track('screen_open', { screen: app.state, mode: app.mode });
  }
}

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  app.t += dt;
  trackScreen();

  if (['menu', 'board', 'shop', 'quests', 'settings', 'dossier', 'kennel', 'archive'].includes(app.state)) {
    audio.music?.setState('menu');
    drawMenu(dt);
    drawMuteIcon();
    drawTrophyIcon();
    if (app.state === 'board') drawBoard();
    if (app.state === 'shop') drawShop();
    if (app.state === 'quests') drawQuests();
    if (app.state === 'settings') drawSettings();
    if (app.state === 'dossier') drawDossier();
    if (app.state === 'kennel') drawKennel();
    if (app.state === 'archive') drawArchive();
    drawToasts(dt);
  } else if (app.state === 'calib') {
    drawCalib();
  } else if (app.state === 'trainer') {
    drawTrainer(dt);
  } else if (app.state === 'news') {
    drawNews();
    drawToasts(dt);
  } else if (app.state === 'champion') {
    drawChampion();
    drawToasts(dt);
  } else if (app.state === 'photo') {
    drawPhoto();
    drawToasts(dt);
  } else if (app.state === 'podium') {
    drawPodium();
    drawToasts(dt);
  } else if (app.state === 'treat') {
    drawTreat(dt);
    drawToasts(dt);
  } else if (app.run) {
    renderer.begin(dt);
    if (!app.photoMode) app.run.update(dt);   // фото-режим замораживает мир
    app.run.draw();
    // Фото-финиш (S3.3): кадр снимаем ДО HUD — на полароиде только сцена
    if (app.run.photoReady && !app.photo) { capturePhoto(); return requestAnimationFrame(frame); }
    if (app.photoMode) { drawPhotoMode(); drawToasts(dt); return requestAnimationFrame(frame); }
    drawHud(app.run);
    const z = Math.min(canvas.width, canvas.height) / 700;
    if (app.testDrive && TEST_MODE === 's1') drawDemoLegend(app.run, z);
    // Победный круг задерживает протокол судьи до кадра-полароида
    const lapPending = app.run.victoryLap && !app.photoDone;
    if (app.run.phase === 'finished' && app.run.finishT > 0.4 && !app.run.warmup && !lapPending) {
      app.state = 'results';
    }
    if (app.state === 'results') drawResults(app.run, z);
    drawMuteIcon();
    drawToasts(dt);
    for (const e of app.run.drainEvents()) {
      // события уже озвучены внутри Run; здесь место для метрик/отладки
      if (window.__agilityEvents) window.__agilityEvents.push(e);
      // Аналитика редких ключевых моментов в забеге
      if (e.type === 'goldenWeave') { app.run.goldenWeave = true; track('golden_weave', { cls: app.cls }); }
      else if (e.type === 'risk') track('risk_arm', { cls: app.cls });
      else if (e.type === 'weaveRestart') track('weave_restart', { cls: app.cls });
      // Ассист съел Golden Weave — говорим об этом прямо, один раз за забег:
      // игрок должен понимать, что бонус недоступен, а не думать, что не попал.
      else if (e.type === 'goldenSuppressed' && !app.run._goldenNotice) {
        app.run._goldenNotice = 1;
        toasts.push({ icon: '🤝', name: 'Golden Weave выключен', desc: 'Так работает ассист — окна шире, бонуса нет', t: 0 });
        track('golden_suppressed', { reason: e.reason || 'assist' });
      }
      // Практика: выход на полный темп — главный момент загона
      else if (e.type === 'practiceFullSpeed') {
        toasts.push({ icon: '🔥', name: 'Полный темп!', desc: `Попыток пройдено: ${e.tries} — дальше по-боевому`, t: 0 });
        track('practice_full_speed', { obstacle: app.run.practice?.type || '', tries: e.tries });
      }
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Хук для тестового харнесса (Playwright)
window.__agility = {
  meta, saveMeta: () => saveMeta(meta), settings, applySettings: saveSettings, breedLocked,
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
  pet() { petDog(); },
  // S3: промотать победный круг и кадр-полароид (для e2e-сценариев)
  skipCeremony() {
    if (app.state === 'photo') { photoContinue(); return; }
    if (app.run && app.run.victoryLap) {
      app.run.skipVictoryLap();
      app.run.photoReady = false;   // кадр не снимаем — сразу к протоколу
    }
    app.photoDone = true;
  },
  menuIdle,
  // S4.10/S4.11: витрина целей и календарь-архив (для e2e и ручной приёмки)
  openKennel, openArchive, startArchiveRun, kennelScrollBy,
  // S4: практика-загон (и её выбор проблемного снаряда) — для e2e и приёмки
  startPractice, problemObstacle, practiceOffer,
  openPodium,
  openTreat, treatAdvance, togglePhotoMode,
  pressKey(code) { app.run?.input(code, true); },
  releaseKey(code) { app.run?.input(code, false); },
};
window.__agilityEvents = [];

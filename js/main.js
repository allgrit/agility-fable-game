// Точка входа: меню → забег → результаты. Input, HUD, игровой цикл.
import { generateCourse, CLASSES } from './course.js';
import { BREEDS, finalScore, nextClass, CLASS_ORDER } from './scoring.js';
import { AudioEngine } from './audio.js';
import { Particles } from './particles.js';
import { Renderer } from './render.js';
import { Run } from './game.js';
import { QTE_DEFS } from './qte.js';
import { REAL_COURSES, realToCourse } from './courses.js';

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
const MEDAL_ICON = { 3: '🥇', 2: '🥈', 1: '🥉' };
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
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * DPR, y: (e.clientY - r.top) * DPR };
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
  const cx = u * 2.3, cy = h - u * 3.6;      // центр D-pad — повыше от кромки
  return [
    { code: 'ArrowUp',    x: cx,            y: cy - u * 1.18, r: u, label: '↑', hotLabel: 'ВЕРХ' },
    { code: 'ArrowDown',  x: cx,            y: cy + u * 1.18, r: u, label: '↓', hotLabel: 'НИЗ' },
    { code: 'ArrowLeft',  x: cx - u * 1.18, y: cy,            r: u, label: '←', hotLabel: 'ЛЕВО' },
    { code: 'ArrowRight', x: cx + u * 1.18, y: cy,            r: u, label: '→', hotLabel: 'ПРАВО' },
    { code: 'Space', x: w - u * 2.0, y: h - u * 3.2, r: u * 1.45, label: 'ХОП', hotLabel: 'ХОП' },
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
  if (app.state === 'board') {
    if (e.code === 'Escape' || e.code === 'Enter') { app.state = 'menu'; audio.click(); }
    return;
  }
  if (app.state === 'menu') return menuKey(e.code);
  if (app.state === 'results') return resultsKey(e.code);
  if (app.state === 'run') {
    if (e.code === 'Escape') return toMenu();
    if (e.code === 'KeyR') return startRun();
    app.run.input(e.code, true);
  }
});
window.addEventListener('keyup', (e) => {
  if (app.state === 'run') app.run.input(e.code, false);
});
canvas.addEventListener('pointerdown', (e) => {
  audio.ensure();
  const p = evXY(e);
  const mz = muteZone();
  if (Math.hypot(p.x - mz.x, p.y - mz.y) < mz.r) { toggleMute(); return; }
  if (app.state === 'run') {
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
  if (app.state === 'board') { app.state = 'menu'; audio.click(); return; }
  const tz = trophyZone();
  if (app.state === 'menu' && Math.hypot(p.x - tz.x, p.y - tz.y) < tz.r) {
    app.state = 'board'; audio.click(); return;
  }
  if (app.state === 'menu') menuClick(p.x, p.y);
  else if (app.state === 'results') resultsKey('Enter');
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
    const top = h * 0.33, cardH = h * 0.1, gap = h * 0.014;
    for (let i = 0; i < n; i++) {
      const cy = top + i * (cardH + gap);
      if (y > cy && y < cy + cardH && Math.abs(x - w / 2) < w * 0.44) {
        if (app.breedIdx === i) startRun(); else { app.breedIdx = i; audio.click(); }
        return;
      }
    }
    if (y > h * 0.8) startRun();
    if (y < h * 0.29) menuKey('ArrowDown');
    return;
  }
  const cardW = Math.min(230, w * 0.21);
  for (let i = 0; i < n; i++) {
    const cx = w / 2 + (i - (n - 1) / 2) * (cardW + 18);
    if (Math.abs(x - cx) < cardW / 2 && y > h * 0.38 && y < h * 0.72) {
      if (app.breedIdx === i) startRun(); else { app.breedIdx = i; audio.click(); }
      return;
    }
  }
  if (y > h * 0.76) startRun();
  if (y < h * 0.3) menuKey('ArrowDown');
}

function resultsKey(code) {
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
  let course;
  if (app.mode === 'worldcup' && REAL_COURSES.length) {
    course = realToCourse(REAL_COURSES[app.realIdx % REAL_COURSES.length]);
  } else if (app.mode === 'daily') {
    course = generateCourse(todayNum() * 13 + 7, dailyCls());
    course.name = `Трасса дня ${todayStr()}`;
  } else {
    course = generateCourse(careerSeed(app.cls, app.stage), app.cls);
    course.name = `${CLASSES[app.cls].name} · трасса ${app.stage}/${STAGES}`;
  }
  const mod = MODIFIERS[activeModifier()];
  app.run = new Run({ course, breed, audio, particles: fx, renderer,
    modifier: activeModifier(), windowMul: mod.windowMul || 1 });
  renderer.cam.x = course.start.x;
  renderer.cam.y = course.start.y;
  app.state = 'run';
  app.result = null;
  audio.crowdLevel(0.15);
}

// ---------- HUD ----------
function drawHud(run) {
  const ctx = renderer.ctx, w = canvas.width;
  const z = Math.min(w, canvas.height) / 700;

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

  // Отсчёт
  if (run.phase === 'countdown') {
    const c = Math.ceil(run.countdownT);
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.round(120 * z)}px "Segoe UI", sans-serif`;
    ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    const txt = c > 0 ? String(c) : 'ВПЕРЁД!';
    ctx.strokeText(txt, w / 2, canvas.height * 0.4);
    ctx.fillStyle = '#ffd54a';
    ctx.fillText(txt, w / 2, canvas.height * 0.4);
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
        ctx.fillText(MEDAL_ICON[stars], sx, ry);
      } else {
        ctx.fillStyle = locked ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.45)';
        ctx.fillText(locked ? '🔒' : '○', sx, ry);
        ctx.fillStyle = locked ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.85)';
      }
    }
  });
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
    const rows = Math.min(board.length, 10);
    const rowH = Math.min(40 * z, (ph - 140 * z) / rows);
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
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = `${Math.round(16 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText('L / ESC / тап — назад', w / 2, py + ph - 26 * z);
  ctx.restore();
}

function drawTrophyIcon() {
  const ctx = renderer.ctx;
  const tz = trophyZone();
  ctx.save();
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = 'rgba(10,20,15,0.55)';
  ctx.beginPath(); ctx.arc(tz.x, tz.y, tz.r, 0, Math.PI * 2); ctx.fill();
  ctx.font = `${Math.round(tz.r * 1.05)}px "Segoe UI", sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('🏆', tz.x, tz.y + 2);
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
    // 6 стрелок ← → с бегущей подсветкой; шаг сжимается на узких экранах
    const step = Math.min(64 * z, (w * 0.9) / def.beats);
    for (let i = 0; i < def.beats; i++) {
      const x = cx + (i - (def.beats - 1) / 2) * step;
      const key = def.keys[i % 2];
      const g = q.beatGrades[i];
      const isNext = i === q.beatIdx;
      const beatT = q.target + i * def.beat;
      const closeness = Math.max(0, 1 - Math.abs(t - beatT) / def.beat);
      keycap(ctx, x, cy, 46 * z * (isNext ? 1 + closeness * 0.25 : 0.9), KEY_LABEL[key],
        g ? (g === 'miss' ? '#ff6b6b' : '#69f0ae') : isNext ? '#ffd54a' : 'rgba(255,255,255,0.5)');
    }
  } else if (def.kind === 'hold' && q.holding) {
    gaugeBar(ctx, cx, cy, 260 * z, q.progress, '#69f0ae', 'ДЕРЖИМ… стол 3 сек', z);
  } else if (def.kind === 'holdRelease' && q.holding) {
    // Шкала движения по снаряду с жёлтой зоной — отпустить в зоне
    const bw = 300 * z;
    gaugeBar(ctx, cx, cy, bw, q.progress, '#4fc3f7', 'Отпусти ↑ в жёлтой зоне!', z);
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
    // press: тайминг-бар — палочка бежит к зоне, скорость палочки = скорость собаки.
    // На таче клавишу в центре не дублируем — подсвечивается сама кнопка «ХОП».
    const inPerfect = Math.abs(t - q.target) <= q.w * 0.28;
    const inGood = Math.abs(t - q.target) <= q.w * 0.6;
    if (!IS_TOUCH) {
      const pulse = inPerfect ? 1 + Math.sin(run.time * 22) * 0.08 : 1;
      keycap(ctx, cx, cy, 44 * z * pulse, KEY_LABEL[def.key],
        inPerfect ? '#ffd54a' : inGood ? '#9ff0b4' : 'rgba(255,255,255,0.85)');
      timingBar(ctx, run, m, q, cx, cy - 78 * z, z);
    } else {
      timingBar(ctx, run, m, q, cx, cy, z);
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

// Тайминг-бар: палочка = позиция собаки на подлёте к точке отталкивания.
// Скорость палочки — реальная скорость собаки; ширина зоны = окно × скорость.
const TAKEOFF_UI = 1.3; // м до снаряда, синхронно с game.js TAKEOFF
function timingBar(ctx, run, m, q, cx, cy, z) {
  const takeoffD = m.entryD - TAKEOFF_UI;
  const startD = m.startDist ?? takeoffD - 5;
  const totalDist = Math.max(0.8, takeoffD - startD);
  const p = (run.dog.dist - startD) / totalDist;   // 1.0 = точка отталкивания
  const v = Math.max(run.dog.speed, 0.5);
  const barW = Math.min(340 * z * (0.8 + v * 0.06), canvas.width * 0.8);
  const x0 = cx - barW / 2, barH = 20 * z;
  const targetX = x0 + barW * 0.78;                // цель на 78% — виден перелёт
  const pxPerFrac = barW * 0.78;
  ctx.save();
  ctx.fillStyle = 'rgba(12,20,16,0.78)';
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(x0 - 5, cy - barH / 2 - 5, barW + 10, barH + 10, 9 * z);
  ctx.fill(); ctx.stroke();
  // Зоны в долях дистанции: good (зелёная) и perfect (жёлтое ядро).
  // В «Сумерках» зона проявляется только на последней трети подлёта.
  const duskHidden = run.modifier === 'dusk' && p < 0.62;
  if (!duskHidden) {
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x0, cy - barH / 2, barW, barH, 6 * z); ctx.clip();
    const goodW = (q.w * 0.6 * v / totalDist) * pxPerFrac;
    const perfW = (q.w * 0.28 * v / totalDist) * pxPerFrac;
    ctx.fillStyle = 'rgba(105,240,174,0.45)';
    ctx.fillRect(targetX - goodW, cy - barH / 2, goodW * 2, barH);
    ctx.fillStyle = '#ffd54a';
    ctx.fillRect(targetX - perfW, cy - barH / 2, perfW * 2, barH);
    ctx.restore();
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = `bold ${Math.round(15 * z)}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('? ? ?', targetX, cy);
  }
  // Палочка-собака
  const px = Math.min(x0 + barW, x0 + p * pxPerFrac);
  const inPerfect = Math.abs(run.dog.dist - takeoffD) <= q.w * 0.28 * v;
  ctx.fillStyle = '#fff';
  ctx.shadowColor = inPerfect ? '#ffd54a' : 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = inPerfect ? 10 * z : 4 * z;
  ctx.fillRect(px - 2 * z, cy - barH / 2 - 6 * z, 4 * z, barH + 12 * z);
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
  ctx.fillText('Ты — собака. Слушай хендлера и жми верные клавиши вовремя!', w / 2, h * 0.16 + 52 * z);

  // Режим
  ctx.font = `bold ${Math.round(22 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = '#ffd54a';
  let modeName;
  if (app.mode === 'career') {
    modeName = `КАРЬЕРА · ${CLASSES[app.cls].name} · трасса ${app.stage}/${STAGES}`;
  } else if (app.mode === 'worldcup') {
    modeName = `ЧЕМПИОНАТ МИРА · реальные трассы (${REAL_COURSES.length})`;
  } else {
    const db = dailyBest();
    modeName = `ТРАССА ДНЯ ${todayStr()} · ${CLASSES[dailyCls()].name}${db != null ? ` · лучший: ${db}` : ''}`;
  }
  ctx.fillText(`⟨ ↑↓ ⟩  ${modeName}`, w / 2, h * 0.28);

  // Подстрока: карта карьеры / модификатор дня
  if (app.mode === 'career') {
    drawCareerMap(ctx, w / 2, h * 0.315, z, isPortrait());
  } else if (app.mode === 'daily') {
    const mod = MODIFIERS[dailyModifier()];
    if (mod.name) {
      ctx.font = `${Math.round(16 * z)}px "Segoe UI", sans-serif`;
      ctx.fillStyle = '#ffab6b';
      ctx.fillText(`${mod.name} · очки ×${mod.mult}`, w / 2, h * 0.315);
    }
  }
  // Сводка медалей (в карьере медали видны на карте)
  if (app.mode !== 'career') {
    const mc = medalCounts();
    if (mc[3] + mc[2] + mc[1] > 0) {
      ctx.font = `${Math.round(15 * z)}px "Segoe UI", sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(`🥇×${mc[3]}  🥈×${mc[2]}  🥉×${mc[1]}`, w / 2, h * 0.345);
    }
  }

  // Карточки пород
  if (isPortrait()) {
    const top = h * 0.33, cardH = h * 0.1, gap = h * 0.014, cardW = w * 0.88;
    breedList.forEach((b, i) => {
      const cy = top + i * (cardH + gap), cx = w / 2;
      const sel = i === app.breedIdx;
      ctx.save();
      ctx.fillStyle = sel ? 'rgba(30,52,40,0.92)' : 'rgba(14,26,20,0.8)';
      ctx.strokeStyle = sel ? '#ffd54a' : 'rgba(255,255,255,0.25)';
      ctx.lineWidth = sel ? 4 : 1.5;
      ctx.beginPath(); ctx.roundRect(cx - cardW / 2, cy, cardW, cardH, 16); ctx.fill(); ctx.stroke();
      ctx.save();
      ctx.translate(cx - cardW / 2 + cardH * 0.75, cy + cardH * 0.55);
      ctx.scale(1.15, 1.15);
      drawCardDog(ctx, { runPhase: app.t * (sel ? 8 : 3), happy: sel }, b, cardH * 0.55);
      ctx.restore();
      ctx.textAlign = 'left';
      ctx.fillStyle = sel ? '#ffe082' : '#fff';
      ctx.font = `bold ${Math.round(19 * z)}px "Segoe UI", sans-serif`;
      ctx.fillText(b.name, cx - cardW / 2 + cardH * 1.6, cy + cardH * 0.42);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = `${Math.round(13 * z)}px "Segoe UI", sans-serif`;
      ctx.fillText(b.desc, cx - cardW / 2 + cardH * 1.6, cy + cardH * 0.72);
      ctx.restore();
    });
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(22 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = Math.sin(app.t * 4) > -0.3 ? '#fff' : 'rgba(255,255,255,0.4)';
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
  const cardW = Math.min(230, w * 0.21), cardH = h * 0.34;
  breedList.forEach((b, i) => {
    const cx = w / 2 + (i - (breedList.length - 1) / 2) * (cardW + 18), cy = h * 0.38;
    const sel = i === app.breedIdx;
    ctx.save();
    if (sel) { ctx.translate(cx, cy + cardH / 2); ctx.scale(1.06, 1.06); ctx.translate(-cx, -(cy + cardH / 2)); }
    ctx.fillStyle = sel ? 'rgba(30,52,40,0.92)' : 'rgba(14,26,20,0.8)';
    ctx.strokeStyle = sel ? '#ffd54a' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = sel ? 4 : 1.5;
    ctx.beginPath(); ctx.roundRect(cx - cardW / 2, cy, cardW, cardH, 18); ctx.fill(); ctx.stroke();
    // Пёсик на карточке
    const dogY = cy + cardH * 0.36;
    renderer.cam.zoom = 34 * z;
    const fake = { x: 0, y: 0, heading: -0.1, runPhase: app.t * (sel ? 8 : 3), speed: sel ? 5 : 1, happy: sel, elevation: 0 };
    ctx.save();
    ctx.translate(cx, dogY);
    ctx.scale(1.6, 1.6);
    drawCardDog(ctx, fake, b, z * 34);
    ctx.restore();
    ctx.textAlign = 'center';
    ctx.fillStyle = sel ? '#ffe082' : '#fff';
    ctx.font = `bold ${Math.round(22 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(b.name, cx, cy + cardH * 0.62);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = `${Math.round(14 * z)}px "Segoe UI", sans-serif`;
    wrapText(ctx, b.desc, cx, cy + cardH * 0.72, cardW - 30, 18 * z);
    ctx.restore();
  });

  ctx.font = `bold ${Math.round(24 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = Math.sin(app.t * 4) > -0.3 ? '#fff' : 'rgba(255,255,255,0.4)';
  ctx.fillText('ENTER / клик — на старт!', w / 2, h * 0.83);
  ctx.font = `${Math.round(15 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.fillText('← → выбор породы · ПРОБЕЛ прыжок · ↓ туннель · ←→ слалом · ↑ горка/бум · L — лидерборд', w / 2, h * 0.88);
  if (app.bestPoints) {
    ctx.fillStyle = '#ffd54a';
    ctx.fillText(`Рекорд: ${app.bestPoints} очков`, w / 2, h * 0.93);
  }
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
  ctx.fillStyle = breed.body;
  ctx.beginPath(); ctx.ellipse(14, -4, 6.2, 5.4, -0.15, 0, Math.PI * 2); ctx.fill();
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

function wrapText(ctx, text, x, y, maxW, lh) {
  const words = text.split(' ');
  let line = '', yy = y;
  for (const wd of words) {
    if (ctx.measureText(line + wd).width > maxW && line) {
      ctx.fillText(line.trim(), x, yy); line = ''; yy += lh;
    }
    line += wd + ' ';
  }
  ctx.fillText(line.trim(), x, yy);
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
    if (app.result.points > app.bestPoints) {
      app.bestPoints = app.result.points;
      localStorage.setItem('agility_best', String(app.bestPoints));
    }
    saveRunToBoard(run, app.result);
  }
  const res = app.result;
  const pw = Math.min(520 * z, w * 0.9), ph = Math.min(460 * z, h * 0.85);
  const px = w / 2 - pw / 2, py = h / 2 - ph / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(6,12,10,0.72)';
  ctx.fillRect(0, 0, w, h);
  panel(ctx, px, py, pw, ph);
  ctx.textAlign = 'center';
  ctx.fillStyle = res.clean ? '#ffd54a' : '#fff';
  ctx.font = `900 ${Math.round(34 * z)}px "Segoe UI", sans-serif`;
  wrapText(ctx, res.title, w / 2, py + 52 * z, pw - 60, 40 * z);

  // Звёзды
  const t = Math.min(1, run.finishT / 1.5);
  for (let i = 0; i < 3; i++) {
    const on = i < res.stars && t > (i + 1) / 3.5;
    const sx = w / 2 + (i - 1) * 76 * z;
    ctx.font = `${Math.round(52 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = on ? '#ffd54a' : 'rgba(255,255,255,0.18)';
    ctx.fillText('★', sx, py + 130 * z);
  }

  ctx.font = `${Math.round(21 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = '#e8f5ec';
  const modLine = MODIFIERS[run.modifier].mult > 1 && !run.eliminated
    ? ` (×${MODIFIERS[run.modifier].mult})` : '';
  const lines = [
    `Время: ${run.time.toFixed(2)}с  (SCT ${run.sct}с${res.timeFaults ? `, +${res.timeFaults} time faults` : ''})`,
    `Фолты: ${res.totalFaults}   Отказы: ${run.score.refusals}`,
    `Идеально: ${run.score.perfects}/${run.marks.length}   Макс. комбо: ×${run.score.maxCombo}`,
    `Очки: ${res.points}${modLine}${res.points >= app.bestPoints && res.points > 0 ? ' — РЕКОРД!' : ''}`,
  ];
  lines.forEach((l, i) => ctx.fillText(l, w / 2, py + (185 + i * 38) * z));
  // Медаль за трассу
  if (res.stars > 0) {
    ctx.font = `${Math.round(30 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(`${MEDAL_ICON[res.stars]}${app.newMedal ? ' Новая медаль!' : ''}`, w / 2, py + 345 * z);
  }
  if (app.mode === 'daily' && app.newDailyBest) {
    ctx.font = `bold ${Math.round(17 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = '#ffd54a';
    ctx.fillText('Лучший результат дня!', w / 2, py + 375 * z);
  }

  ctx.font = `bold ${Math.round(20 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = Math.sin(app.t * 4) > -0.3 ? '#ffd54a' : 'rgba(255,213,74,0.4)';
  const nextLabel = app.mode === 'career'
    ? (res.qualified
      ? (app.stage >= STAGES && app.cls !== 'masters'
        ? `ENTER — класс ${CLASSES[nextClass(app.cls)].name}!`
        : 'ENTER — следующая трасса')
      : 'ENTER — ещё попытка')
    : app.mode === 'daily' ? 'ENTER — ещё попытка (лучший идёт в зачёт)'
    : 'ENTER — следующая трасса чемпионата';
  ctx.fillText(nextLabel, w / 2, py + ph - 64 * z);
  ctx.font = `${Math.round(16 * z)}px "Segoe UI", sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText('R — переиграть · ESC — меню', w / 2, py + ph - 32 * z);
  ctx.restore();
}

// ---------- ЦИКЛ ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  app.t += dt;

  if (app.state === 'menu' || app.state === 'board') {
    drawMenu(dt);
    drawMuteIcon();
    drawTrophyIcon();
    if (app.state === 'board') drawBoard();
  } else if (app.run) {
    renderer.begin(dt);
    app.run.update(dt);
    app.run.draw();
    drawHud(app.run);
    const z = Math.min(canvas.width, canvas.height) / 700;
    if (app.run.phase === 'finished' && app.run.finishT > 1.2) {
      app.state = 'results';
    }
    if (app.state === 'results') drawResults(app.run, z);
    drawMuteIcon();
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

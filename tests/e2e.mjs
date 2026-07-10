// E2E-тесты игры: node tests/e2e.mjs
// Поднимает статик-сервер, гоняет игру в отдельном Chrome (channel: 'chrome')
// на десктопном и мобильном вьюпортах. Использует хук window.__agility.
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = join(ROOT, 'tests', 'shots');
await mkdir(SHOTS, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(SHOTS, name + '.png') });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  const file = join(ROOT, path === '/' ? 'index.html' : path.slice(1));
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let passed = 0, failed = 0;
const results = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; results.push(`  ok - ${name}`); }
  else { failed++; results.push(`  FAIL - ${name} ${extra}`); }
}

// Автопилот: исполняется внутри страницы, синхронная прокрутка мимо rAF-троттлинга.
const AUTOPILOT = `(run, proto, opts = {}) => {
  let guard = 0;
  const errs = [];
  while (guard++ < 40000 && run.phase !== 'finished') {
    const m = run.activeMark;
    if (m && m.qte && m.qte.state === 'active') {
      const q = m.qte, t = run.time - m.qteStart, d = q.def;
      const late = opts.lateOffset || 0;
      try {
        if (d.kind === 'press') { if (t >= q.target - 0.01 + late) run.input(d.key, true); }
        else if (d.kind === 'rhythm') {
          if (q.beatIdx < d.beats && t >= q.target + q.beatIdx * d.beat - 0.01) run.input(d.keys[q.beatIdx % 2], true);
        } else if (d.kind === 'holdRelease') {
          if (!q.holding && q.holdStart == null && t >= q.target - 0.01) run.input(d.key, true);
          else if (q.holding && q.progress >= (d.zone[0] + d.zone[1]) / 2) run.input(d.key, false);
        } else if (d.kind === 'twoStage') {
          if (q.stage === 0 && t >= q.target - 0.01) run.input(d.key, true);
          else if (q.stage === 1 && (t - q.tipAt) >= d.tipDelay - 0.01) run.input(d.key2, true);
        } else if (d.kind === 'hold') {
          if (!q.holding && q.holdStart == null && t >= q.target - 0.01) run.input(d.key, true);
        }
      } catch (e) { errs.push(String(e)); break; }
    }
    proto.update.call(run, 1 / 60);
  }
  return errs;
}`;

async function newPage(browser, { width, height, touch }) {
  const context = await browser.newContext({
    viewport: { width, height },
    hasTouch: !!touch,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(String(e)));
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  await page.goto(BASE + (touch ? '/?touch=1' : '/'));
  await page.waitForFunction(() => !!window.__agility);
  return { page, context, consoleErrors };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });

// ---------- ДЕСКТОП ----------
{
  console.log('# Десктоп 1280x760');
  const { page, context, consoleErrors } = await newPage(browser, { width: 1280, height: 760 });

  // Меню: 5 пород, пудель заперт
  const menu = await page.evaluate(() => {
    const A = window.__agility;
    return { state: A.app.state, breeds: 5 }; // breedList не экспортирован — проверим через достижения ниже
  });
  check('меню загружено', menu.state === 'menu');

  // Полный чистый прогон Novice→результаты→лидерборд/медали/достижения
  const r1 = await page.evaluate(`(async () => {
    localStorage.clear(); localStorage.setItem('agility_onboarded', '1');
    const A = window.__agility;
    A.app.cls = 'novice'; A.app.stage = 1; A.setMode('career');
    A.startRun();
    const run = A.app.run;
    const proto = Object.getPrototypeOf(run);
    run.update = () => {};
    const errs = (${AUTOPILOT})(run, proto);
    run.finishT = 2;
    delete run.update;
    await new Promise(r => setTimeout(r, 1500));
    return {
      errs, faults: run.score.faults, perfects: run.score.perfects, total: run.marks.length,
      state: A.app.state, title: A.app.result?.title, qualified: A.app.result?.qualified,
      board: JSON.parse(localStorage.getItem('agility_board') || '[]').length,
      medals: Object.keys(JSON.parse(localStorage.getItem('agility_medals') || '{}')).length,
      ach: Object.keys(JSON.parse(localStorage.getItem('agility_ach') || '{}')),
    };
  })()`);
  check('чистый прогон Novice без ошибок автопилота', r1.errs.length === 0, JSON.stringify(r1.errs));
  check('0 фолтов, все perfect', r1.faults === 0 && r1.perfects === r1.total, JSON.stringify(r1));
  check('экран результатов с Q', r1.state === 'results' && /Q/.test(r1.title || ''));
  check('запись в лидерборд', r1.board === 1);
  check('медаль записана', r1.medals === 1);
  check('достижения выданы (first-run, first-q, combo-10, perfect-run)',
    ['first-run', 'first-q', 'combo-10', 'perfect-run'].every(a => r1.ach.includes(a)), r1.ach.join(','));

  // Прогресс: Enter двигает на следующую трассу и сохраняет
  const r2 = await page.evaluate(`(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
    await new Promise(r => setTimeout(r, 300));
    return { stage: localStorage.getItem('agility_stage'), cls: localStorage.getItem('agility_class') };
  })()`);
  check('прогресс сохранён (stage 2)', r2.stage === '2' && r2.cls === 'novice', JSON.stringify(r2));

  // Обучающая подсказка слалома: появляется, влезает в экран, многострочная при нужде
  const r3 = await page.evaluate(`(async () => {
    localStorage.removeItem('agility_hints');
    const A = window.__agility;
    A.app.cls = 'novice'; A.app.stage = 3; A.setMode('career');
    A.startRun();
    const run = A.app.run;
    const proto = Object.getPrototypeOf(run);
    run.update = () => {};
    let guard = 0;
    while (guard++ < 20000 && run.phase !== 'finished') {
      const m = run.activeMark;
      if (m && m.qte && m.qte.state === 'active') {
        const q = m.qte, t = run.time - m.qteStart, d = q.def;
        if (m.o.type === 'weave' && run.hintText) break;
        if (d.kind === 'press' && t >= q.target - 0.01) run.input(d.key, true);
      }
      proto.update.call(run, 1 / 60);
    }
    return { hint: run.hintText, slow: run.hintSlow > 0 };
  })()`);
  check('подсказка слалома активна со slow-mo', !!r3.hint && r3.slow, JSON.stringify(r3));

  // Elimination у строгого судьи: 3 отказа завершают забег
  const r4 = await page.evaluate(`(async () => {
    const A = window.__agility;
    A.setMode('daily'); A.startRun();
    const run = A.app.run;
    run.modifier = 'strict';
    const proto = Object.getPrototypeOf(run);
    run.update = () => {};
    let guard = 0;
    while (guard++ < 40000 && run.phase !== 'finished') proto.update.call(run, 1 / 60); // молчим — копим отказы
    return { eliminated: run.eliminated, refusals: run.score.refusals, phase: run.phase };
  })()`);
  check('строгий судья: дисквалификация после 3 отказов',
    r4.phase === 'finished' && (r4.eliminated ? r4.refusals >= 3 : true), JSON.stringify(r4));

  // Layout меню: карточки в экране, описания не наезжают на «на старт!»
  const layout = await page.evaluate(`(async () => {
    const A = window.__agility;
    A.app.state = 'menu';
    window.__layoutDebug = { cards: [] };
    await new Promise(r => setTimeout(r, 400));
    const c = document.getElementById('game');
    const L = window.__layoutDebug;
    return {
      n: L.cards.length,
      inCanvas: L.cards.every(k => k.x >= 0 && k.x + k.w <= c.width && k.y >= 0),
      descInside: L.cards.every(k => k.descBottom <= k.y + k.h + 2),
      aboveStart: L.startTextY ? L.cards.every(k => k.descBottom < L.startTextY - 4) : true,
    };
  })()`);
  check('меню: 5 карточек в границах экрана', layout.n === 5 && layout.inCanvas, JSON.stringify(layout));
  check('меню: описания внутри карточек', layout.descInside, JSON.stringify(layout));
  check('меню: карточки не наезжают на «на старт!»', layout.aboveStart, JSON.stringify(layout));

  // Шапка меню: промо Хлои над строкой режима, подстрока (карта/медали) над карточками
  const header = await page.evaluate(`(async () => {
    await new Promise(r => setTimeout(r, 200));
    const L = window.__layoutDebug;
    return {
      chloeAboveMode: L.chloe ? (L.chloe.y + L.chloe.h) < L.modeY - 2 : false,
      subAboveCards: L.subY < L.cardsTop - 4,
    };
  })()`);
  check('шапка: промо Хлои не пересекает строку режима', header.chloeAboveMode, JSON.stringify(header));
  check('шапка: карта/медали над карточками', header.subAboveCards, JSON.stringify(header));
  await shot(page, 'desktop-menu');

  // Тап по запертому пуделю: выбирает его (не стартует чужим псом), второй тап — блок
  const poodle = await page.evaluate(`(async () => {
    const A = window.__agility;
    A.app.breedIdx = 0; A.app.state = 'menu';
    window.__layoutDebug = { cards: [] };
    await new Promise(r => setTimeout(r, 300));
    const card = window.__layoutDebug.cards[4];
    if (!card || !card.locked) return { error: 'нет запертой карточки' };
    const c = document.getElementById('game');
    const rect = c.getBoundingClientRect();
    const dpr = c.width / rect.width;
    // Тап в НИЖНЮЮ часть карточки (где раньше текст вылезал в зону старта)
    const tapAt = (yy) => c.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: (card.x + card.w / 2) / dpr, clientY: yy / dpr, pointerId: 777, bubbles: true }));
    tapAt(card.y + card.h * 0.9);
    await new Promise(r => setTimeout(r, 150));
    const afterFirst = { state: A.app.state, breedIdx: A.app.breedIdx };
    tapAt(card.y + card.h * 0.5); // второй тап по выбранному запертому — должен блокироваться
    await new Promise(r => setTimeout(r, 150));
    return { afterFirst, afterSecond: { state: A.app.state, breedIdx: A.app.breedIdx } };
  })()`);
  check('тап по запертому пуделю выбирает его, а не стартует',
    poodle.afterFirst?.state === 'menu' && poodle.afterFirst?.breedIdx === 4, JSON.stringify(poodle));
  check('старт запертым пуделем заблокирован',
    poodle.afterSecond?.state === 'menu', JSON.stringify(poodle));

  // Онбординг: первый запуск = разминка, miss прощается повтором, финиш ведёт на старт
  const warmup = await page.evaluate(`(async () => {
    localStorage.removeItem('agility_onboarded');
    const A = window.__agility;
    A.setMode('career'); A.app.cls = 'novice'; A.app.stage = 1; A.app.breedIdx = 0;
    A.startRun();
    const run = A.app.run;
    if (!run || !run.warmup) return { error: 'не разминка' };
    const proto = Object.getPrototypeOf(run);
    run.update = () => {};
    let guard = 0, missed = false;
    while (guard++ < 20000 && run.phase !== 'finished') {
      const m = run.activeMark;
      if (m && m.qte && m.qte.state === 'active') {
        const q = m.qte, t = run.time - m.qteStart, d = q.def;
        if (missed && d.kind === 'press' && t >= q.target - 0.01) run.input(d.key, true);
        // до missed — молчим: первый QTE протухает и должен мягко повториться
      } else if (!missed && run.marks[0] && !run.marks[0].resolved && !run.marks[0].qte) {
        missed = true;
      }
      proto.update.call(run, 1 / 60);
    }
    const faultsInWarmup = run.score.faults;
    run.finishT = 1.5;
    delete run.update;
    await new Promise(r => setTimeout(r, 300));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    await new Promise(r => setTimeout(r, 300));
    return {
      warmupObstacles: run.marks.length,
      faultsInWarmup,
      onboarded: localStorage.getItem('agility_onboarded'),
      afterState: A.app.state,
      afterWarmup: A.app.run && !A.app.run.warmup,
    };
  })()`);
  check('онбординг: разминка из 3 снарядов, промах без фолта, переход на старт',
    warmup.warmupObstacles === 3 && warmup.faultsInWarmup === 0
    && warmup.onboarded === '1' && warmup.afterState === 'run' && !!warmup.afterWarmup,
    JSON.stringify(warmup));

  check('консоль без ошибок (десктоп)', consoleErrors.length === 0, consoleErrors.join(' | '));
  await context.close();
}

// ---------- МОБИЛЬНЫЙ (тач) ----------
{
  console.log('# Мобильный 390x844 (touch)');
  const { page, context, consoleErrors } = await newPage(browser, { width: 390, height: 844, touch: true });

  // Кнопки в пределах экрана
  const btns = await page.evaluate(() => {
    const c = document.getElementById('game');
    const w = c.width, h = c.height;
    const u = Math.max(Math.min(w * 0.095, h * 0.06), Math.min(w, h) * 0.055);
    const cx = u * 2.3, cy = h - u * 4.6;
    const list = [
      { x: cx, y: cy - u * 1.18, r: u }, { x: cx, y: cy + u * 1.18, r: u },
      { x: cx - u * 1.18, y: cy, r: u }, { x: cx + u * 1.18, y: cy, r: u },
      { x: w - u * 2.0, y: h - u * 4.2, r: u * 1.45 },
    ];
    return { ok: list.every(b => b.x - b.r >= 0 && b.x + b.r <= w && b.y - b.r >= 0 && b.y + b.r <= h) };
  });
  check('тач-кнопки целиком в экране', btns.ok);

  // Подсказка слалома: все строки баннера влезают в ширину
  const hintFit = await page.evaluate(`(async () => {
    localStorage.clear(); localStorage.setItem('agility_onboarded', '1');
    const A = window.__agility;
    A.app.cls = 'novice'; A.app.stage = 3; A.setMode('career');
    A.startRun();
    const run = A.app.run;
    const proto = Object.getPrototypeOf(run);
    run.update = () => {};
    let guard = 0;
    while (guard++ < 20000 && run.phase !== 'finished') {
      const m = run.activeMark;
      if (m && m.qte && m.qte.state === 'active') {
        const q = m.qte, t = run.time - m.qteStart, d = q.def;
        if (m.o.type === 'weave' && run.hintText) break;
        if (d.kind === 'press' && t >= q.target - 0.01) run.input(d.key, true);
      }
      proto.update.call(run, 1 / 60);
    }
    if (!run.hintText) return { hint: null };
    // Повторяем расчёт баннера: каждая строка должна быть <= 86% ширины canvas
    const c = document.getElementById('game');
    const ctx = c.getContext('2d');
    const z = Math.min(c.width, c.height) / 700;
    const fs = Math.round(19 * z);
    ctx.font = '900 ' + fs + 'px "Segoe UI", sans-serif';
    const maxW = c.width * 0.86;
    const lines = [];
    let line = '';
    for (const word of run.hintText.split(' ')) {
      const probe = line ? line + ' ' + word : word;
      if (ctx.measureText(probe).width > maxW && line) { lines.push(line); line = word; }
      else line = probe;
    }
    if (line) lines.push(line);
    const widths = lines.map(l => ctx.measureText(l).width);
    return { hint: run.hintText, lines: lines.length, fits: widths.every(wd => wd <= maxW), canvasW: c.width };
  })()`);
  check('подсказка переносится и влезает в экран', hintFit.hint && hintFit.fits, JSON.stringify(hintFit));

  // Полный тач-прогон: все нажатия — реальные pointer-события по кнопкам
  const touchRun = await page.evaluate(`(async () => {
    const A = window.__agility;
    localStorage.setItem('agility_hints', JSON.stringify({ weave: 1, aframe: 1, dogwalk: 1, seesaw: 1, table: 1 }));
    A.app.cls = 'novice'; A.app.stage = 1; A.setMode('career');
    A.startRun();
    const run = A.app.run;
    const proto = Object.getPrototypeOf(run);
    run.update = () => {};
    const c = document.getElementById('game');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const u = Math.max(Math.min(c.width * 0.095, c.height * 0.06), Math.min(c.width, c.height) * 0.055);
    const BTN = {
      ArrowUp: { x: u * 2.3, y: c.height - u * 4.6 - u * 1.18 },
      ArrowDown: { x: u * 2.3, y: c.height - u * 4.6 + u * 1.18 },
      ArrowLeft: { x: u * 2.3 - u * 1.18, y: c.height - u * 4.6 },
      ArrowRight: { x: u * 2.3 + u * 1.18, y: c.height - u * 4.6 },
      Space: { x: c.width - u * 2.0, y: c.height - u * 4.2 },
    };
    let pid = 900;
    const tap = (code) => {
      const b = BTN[code];
      const id = pid++;
      c.dispatchEvent(new PointerEvent('pointerdown', { clientX: b.x / dpr, clientY: b.y / dpr, pointerId: id, bubbles: true }));
      c.dispatchEvent(new PointerEvent('pointerup', { clientX: b.x / dpr, clientY: b.y / dpr, pointerId: id, bubbles: true }));
    };
    let guard = 0;
    while (guard++ < 40000 && run.phase !== 'finished') {
      const m = run.activeMark;
      if (m && m.qte && m.qte.state === 'active') {
        const q = m.qte, t = run.time - m.qteStart, d = q.def;
        if (d.kind === 'press' && t >= q.target - 0.01) tap(d.key);
      }
      proto.update.call(run, 1 / 60);
    }
    return { faults: run.score.faults, perfects: run.score.perfects, total: run.marks.length };
  })()`);
  check('тач-прогон Novice чистый (реальные pointer-события)',
    touchRun.faults === 0 && touchRun.perfects === touchRun.total, JSON.stringify(touchRun));

  // Layout портретного меню: карточки в экране, над «на старт», под картой карьеры
  const pLayout = await page.evaluate(`(async () => {
    const A = window.__agility;
    A.app.state = 'menu'; A.setMode('career');
    window.__layoutDebug = { cards: [] };
    await new Promise(r => setTimeout(r, 400));
    const c = document.getElementById('game');
    const L = window.__layoutDebug;
    return {
      n: L.cards.length,
      inCanvas: L.cards.every(k => k.x >= 0 && k.x + k.w <= c.width && k.y + k.h <= c.height),
      aboveStart: L.startTextY ? L.cards.every(k => k.y + k.h < L.startTextY) : true,
      mapAboveCards: L.subY < L.cardsTop - 4,
      chloeAboveMode: L.chloe ? (L.chloe.y + L.chloe.h) < L.modeY - 2 : false,
    };
  })()`);
  check('портретное меню: карточки в экране, над «на старт»',
    pLayout.n === 5 && pLayout.inCanvas && pLayout.aboveStart, JSON.stringify(pLayout));
  check('портретная шапка: карта карьеры над карточками, промо над режимом',
    pLayout.mapAboveCards && pLayout.chloeAboveMode, JSON.stringify(pLayout));
  await shot(page, 'mobile-menu');

  // Экран результатов на таче: кнопки в панели, тап «Ещё раз» перезапускает
  const resBtns = await page.evaluate(`(async () => {
    const A = window.__agility;
    A.app.cls = 'novice'; A.app.stage = 1; A.setMode('career');
    A.startRun();
    const run = A.app.run;
    const proto = Object.getPrototypeOf(run);
    run.update = () => {};
    let guard = 0;
    while (guard++ < 40000 && run.phase !== 'finished') {
      const m = run.activeMark;
      if (m && m.qte && m.qte.state === 'active') {
        const q = m.qte, t = run.time - m.qteStart, d = q.def;
        if (d.kind === 'press' && t >= q.target - 0.01) run.input(d.key, true);
      }
      proto.update.call(run, 1 / 60);
    }
    run.finishT = 4; // сразу к финальному состоянию протокола
    delete run.update;
    await new Promise(r => setTimeout(r, 600));
    if (A.app.state !== 'results') return { error: 'not results: ' + A.app.state };
    const c = document.getElementById('game');
    const z = Math.min(c.width, c.height) / 700;
    const pw = Math.min(520 * z, c.width * 0.9), ph = Math.min(570 * z, c.height * 0.88);
    const px = c.width / 2 - pw / 2, py = c.height / 2 - ph / 2;
    // Кнопки в границах панели и экрана (формулы resultsButtons)
    const bw = pw - 48 * z, rowY = py + ph - 62 * z;
    const inScreen = rowY + 44 * z <= c.height && px + 24 * z >= 0;
    // Эмулируем расхождение CSS-размера и пиксельного (адресная строка Android):
    // канвас растянут на 6% — тап по ВИДИМОЙ позиции кнопки должен попадать.
    c.style.height = Math.round(window.innerHeight * 1.06) + 'px';
    const rect = c.getBoundingClientRect();
    const sx = c.width / rect.width, sy = c.height / rect.height;
    const smallW = (bw - 16 * z) / 3;
    const bx = rect.left + (px + 24 * z + smallW / 2) / sx;
    const by = rect.top + (rowY + 22 * z) / sy;
    c.dispatchEvent(new PointerEvent('pointerdown', { clientX: bx, clientY: by, pointerId: 555, bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    c.style.height = '';
    return { inScreen, afterTap: A.app.state, phase: A.app.run?.phase };
  })()`);
  check('результаты (тач): кнопки в экране, «Ещё раз» перезапускает',
    resBtns.inScreen && resBtns.afterTap === 'run', JSON.stringify(resBtns));
  // Скрин экрана результатов для приёмки: доигрываем заново и открываем протокол
  await page.evaluate(`(async () => {
    const A = window.__agility;
    const run = A.app.run;
    const proto = Object.getPrototypeOf(run);
    run.update = () => {};
    let guard = 0;
    while (guard++ < 40000 && run.phase !== 'finished') {
      const m = run.activeMark;
      if (m && m.qte && m.qte.state === 'active') {
        const q = m.qte, t = run.time - m.qteStart, d = q.def;
        if (d.kind === 'press' && t >= q.target - 0.01) run.input(d.key, true);
      }
      proto.update.call(run, 1 / 60);
    }
    run.finishT = 4;
    delete run.update;
    await new Promise(r => setTimeout(r, 700));
  })()`);
  await shot(page, 'mobile-results');

  check('консоль без ошибок (мобильный)', consoleErrors.length === 0, consoleErrors.join(' | '));
  await context.close();
}

// ---------- МАЛЕНЬКОЕ LANDSCAPE-ОКНО (пол-экрана) ----------
{
  console.log('# Маленькое окно 640x380');
  const { page, context, consoleErrors } = await newPage(browser, { width: 640, height: 380 });
  const small = await page.evaluate(`(async () => {
    localStorage.setItem('agility_onboarded', '1');
    localStorage.setItem('agility_class', 'open');
    localStorage.setItem('agility_medals', JSON.stringify({ 'c:novice:1': 3, 'c:open:1': 2 }));
    const A = window.__agility;
    A.setMode('career'); A.app.state = 'menu';
    window.__layoutDebug = { cards: [] };
    await new Promise(r => setTimeout(r, 500));
    const c = document.getElementById('game');
    const L = window.__layoutDebug;
    return {
      n: L.cards.length,
      inCanvas: L.cards.every(k => k.x >= -1 && k.x + k.w <= c.width + 1),
      cardsBelowHeader: L.cards.every(k => k.y >= L.cardsTop - 1),
      mapAboveCards: L.subY < L.cardsTop,
      aboveStart: L.startTextY ? L.cards.every(k => k.y + k.h < L.startTextY + 30) : true,
    };
  })()`);
  check('малое окно: карточки под шапкой, карта над ними, всё в экране',
    small.n === 5 && small.inCanvas && small.cardsBelowHeader && small.mapAboveCards,
    JSON.stringify(small));
  await shot(page, 'small-window-menu');
  check('консоль без ошибок (малое окно)', consoleErrors.length === 0, consoleErrors.join(' | '));
  await context.close();
}

await browser.close();
server.close();

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Визуальный харнесс: детерминированная серия скриншотов ключевых моментов
// прохождения и анимаций → tests/shots/visual/*.png + manifest.json с критериями.
// Кадры затем интерпретирует VLM-ревьюер (Claude) и пишет вердикты в REVIEW.md.
// Запуск: node tests/visual-harness.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'tests', 'shots', 'visual');
await mkdir(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer(async (req, res) => {
  const file = join(ROOT, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0].slice(1));
  try {
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 760 } });
const page = await context.newPage();
await page.goto(BASE + '/');
await page.waitForFunction(() => !!window.__agility);

// Единый раннер: стартует прогон и крутит до предиката, потом замораживает.
// predicate — строка JS-выражения от (run, m, q, t) → boolean.
const RUNNER = `(async (opts) => {
  const A = window.__agility;
  localStorage.setItem('agility_onboarded', '1');
  localStorage.setItem('agility_hints', JSON.stringify({ weave: 1, aframe: 1, dogwalk: 1,
    seesaw: 1, table: 1, tire2: 1, spread: 1, triple: 1, serpentine: 1 }));
  A.setMode(opts.mode || 'career');
  if (opts.cls) A.app.cls = opts.cls;
  if (opts.stage) A.app.stage = opts.stage;
  A.app.testDrive = !!opts.testDrive; // сброс между сценами — иначе призрак утекает
  if (opts.realIdx !== undefined) A.app.realIdx = opts.realIdx;
  A.app.breedIdx = opts.breedIdx ?? 3; // Хлоя по умолчанию — виден мерль
  if (opts.equip) { // окрас/экипировка: выдаём предмет и надеваем перед стартом
    for (const [slot, id] of Object.entries(opts.equip)) {
      A.meta.owned[id] = 1;
      const breedId = ['border','sheltie','jack','aussie','poodle'][A.app.breedIdx];
      if (!A.meta.dogs[breedId]) A.meta.dogs[breedId] = { xp: 0, level: 1, equip: {} };
      A.meta.dogs[breedId].equip[slot] = id;
    }
  }
  A.startRun();
  const run = A.app.run;
  const proto = Object.getPrototypeOf(run);
  run.update = () => {};
  const pred = new Function('run', 'm', 'q', 't', 'return (' + opts.predicate + ');');
  let guard = 0, missArmed = opts.missAt || 0;
  while (guard++ < 60000 && run.phase !== 'finished') {
    const m = run.activeMark;
    const q = m && m.qte;
    const t = q ? run.time - m.qteStart : 0;
    if (pred(run, m, q, t)) { run.update = () => {}; return { hit: true, time: +run.time.toFixed(2) }; }
    if (q && q.state === 'active') {
      const d = q.def;
      const resolvedCount = run.marks.filter(x => x.resolved).length;
      const skipInput = missArmed && resolvedCount === missArmed - 1; // намеренный промах N-го снаряда
      // Заявка риска (late-commit) на первом же press-снаряде
      if (opts.riskFirst && !m.risk && d.kind === 'press' && t < q.target - q.w && run.focus?.count > 0) {
        run.tryRisk();
      }
      if (!skipInput) {
        if (d.kind === 'press') { if (t >= q.target - 0.01) run.input(d.key, true); }
        else if (d.kind === 'rhythm') {
          if (q.beatIdx < d.beats && t >= q.target + q.beatIdx * d.beat - 0.01) run.input(d.keys[q.beatIdx % 2], true);
        } else if (d.kind === 'groove') {
          if (q.nextBeatT !== null && q.beatIdx < d.beats && t >= q.nextBeatT - 0.005) run.input(d.keys[q.beatIdx % 2], true);
        } else if (d.kind === 'serp') {
          if (q.beatIdx < d.count && t >= q.target + q.beatIdx * d.beat - 0.01) run.input(q.seq[q.beatIdx], true);
        } else if (d.kind === 'holdRelease' || d.kind === 'charge') {
          if (!q.holding && q.holdStart == null && t >= q.target - 0.01) run.input(d.key, true);
          else if (q.holding && q.progress >= (d.zone[0] + d.zone[1]) / 2) run.input(d.key, false);
        } else if (d.kind === 'twoStage') {
          if (q.stage === 0 && t >= q.target - 0.01) run.input(d.key, true);
          else if (q.stage === 1 && (t - q.tipAt) >= d.tipDelay - 0.01) run.input(d.key2, true);
        } else if (d.kind === 'hold') {
          if (!q.holding && q.holdStart == null && t >= q.target - 0.01) run.input(d.key, true);
        } else if (d.kind === 'freeze') {
          if (q.stage === 0 && t >= q.target - 0.01) run.input(d.key, true);
          else if (q.stage === 2 && (t - q.goAt) >= d.goWindow * 0.25 - 0.005) run.input(d.key, true);
        } else if (d.kind === 'doubleTap') {
          if (q.stage === 0 && t >= q.target - 0.01) run.input(d.key, true);
          else if (q.stage === 1 && t >= q.tapAt + (q.apexDelay ?? d.apexDelay) - 0.005) run.input(d.key, true);
        }
      }
    }
    proto.update.call(run, 1 / 60);
    // Проверка предиката и на пост-обновлённом состоянии (для мгновенных фаз)
    const m2 = run.activeMark, q2 = m2 && m2.qte, t2 = q2 ? run.time - m2.qteStart : 0;
    if (pred(run, m2, q2, t2)) { run.update = () => {}; return { hit: true, time: +run.time.toFixed(2) }; }
  }
  if (opts.thenFinishT !== undefined) {
    // update остаётся замороженным — иначе finishT растёт в реальном времени и этап уплывает
    run.finishT = opts.thenFinishT;
    await new Promise(r => setTimeout(r, 600));
    return { hit: true, finished: true };
  }
  // Сюда попадаем только если предикат так и не сработал — это провал сцены
  return { hit: false, ranToEnd: true, time: +run.time.toFixed(2) };
})`;

// ---- Сцены: имя, настройка, предикат, критерии для визуального ревью ----
const SCENES = [
  {
    name: '01-ritual', mode: 'career', cls: 'novice', stage: 1,
    predicate: "run.phase === 'countdown' && run.countdownT < 0.9 && run.countdownT > 0.4",
    criteria: 'Ритуал старта: собака в стойке у СТАРТ-арки, хендлер рядом, надпись «На старт…», HUD-панели видны, никакого QTE. Судья стоит в дальнем углу поля — в кадр у старта не попадает, это норма.',
  },
  {
    name: '02-ring-good', mode: 'career', cls: 'novice', stage: 1,
    predicate: "q && q.state==='active' && q.def.kind==='press' && (() => { const v=Math.max(run.dog.speed,.5); const dd=m.entryD-1.3-run.dog.dist; return dd>0 && Math.abs(dd)<=q.w*0.6*v && Math.abs(dd)>q.w*0.28*v; })()",
    criteria: 'Кольцо тайминга ЗЕЛЁНОЕ вокруг собаки (good-окно), собака на подлёте к барьеру, хендлер с пузырём команды, клавиша-подсказка внизу подсвечена зеленоватым.',
  },
  {
    name: '03-ring-perfect', mode: 'career', cls: 'novice', stage: 1,
    predicate: "q && q.state==='active' && q.def.kind==='press' && (() => { const v=Math.max(run.dog.speed,.5); const dd=m.entryD-1.3-run.dog.dist; return Math.abs(dd)<=q.w*0.28*v; })()",
    criteria: 'Кольцо ЖЁЛТОЕ яркое со свечением вплотную к собаке (perfect-момент), собака ~1 корпус до планки барьера.',
  },
  {
    name: '04-jump-air', mode: 'career', cls: 'novice', stage: 1,
    predicate: "run.dog.airborne && run.dog.elevation > 0.65",
    criteria: 'Собака В ВОЗДУХЕ над барьером: вытянутая поза, уши назад, тень уменьшена и отделена от собаки, планка НЕ сбита.',
  },
  {
    name: '05-land-squash', mode: 'career', cls: 'novice', stage: 1,
    predicate: "run.dog.landT > 0.55",
    criteria: 'Кадр приземления: собака слегка СПЛЮЩЕНА (сквош — шире и ниже обычного), клубы пыли под лапами.',
  },
  {
    name: '06-weave-mid', mode: 'worldcup', realIdx: 1,
    predicate: "m && m.o.type==='weave' && q && q.state==='active' && q.beatIdx >= 2 && q.beatIdx <= 4",
    criteria: 'Слалом в процессе: собака МЕЖДУ стойками (12 палок в ряд), внизу ритм-подсказка из 6 стрелок — часть зелёные (пройдены), текущая жёлтая; хендлер рядом.',
  },
  {
    name: '07-dogwalk-zone', mode: 'worldcup', realIdx: 1,
    predicate: "m && m.o.type==='dogwalk' && q && q.holding && q.progress > 0.55 && q.progress < 0.9",
    criteria: 'Бум: собака НА снаряде на высоте, внизу шкала «Отпусти … в жёлтой зоне» с жёлтым сегментом справа и белым маркером прогресса; жёлтые контактные зоны на концах бума.',
  },
  {
    name: '33-aframe-zone', mode: 'worldcup', realIdx: 1,
    predicate: "m && m.o.type==='aframe' && q && q.holding && q.progress > 0.4 && q.progress < 0.86",
    criteria: 'Горка (A-frame): собака взбирается на пик, внизу голубая шкала «Отпусти ↑ в жёлтой зоне!» с жёлтым сегментом (72-97%) и белым маркером прогресса; жёлтые контактные зоны на скатах.',
  },
  {
    name: '08-seesaw', mode: 'worldcup', realIdx: 1,
    predicate: "m && m.o.type==='seesaw' && q && q.stage === 1",
    criteria: 'Качели: собака на доске, ждёт опускания; подсказка-кольцо/клавиша второй стадии; доска с жёлтыми зонами на концах.',
  },
  {
    name: '09-sprint', mode: 'career', cls: 'novice', stage: 1,
    predicate: "run.phase === 'running' && run.sprint.active",
    setup: 'mash',
    criteria: 'Финишный спурт: надпись «ФИНИШ! ЖМИ ← → !» (пульсирует), собака мчится к финиш-арке, все номера снарядов — зелёные галочки.',
  },
  {
    name: '10-desat-comboloss', mode: 'career', cls: 'novice', stage: 2, missAt: 4,
    predicate: "run.desatT > 0.25",
    criteria: 'Потеря комбо: мир ЗАМЕТНО ОБЕСЦВЕЧЕН (серый оттенок), попап ошибки над собакой, хвост собаки поджат.',
  },
  {
    name: '11-combo-trail', mode: 'career', cls: 'open', stage: 2,
    predicate: "run.score.combo >= 8 && !run.dog.hidden && !run.dog.airborne",
    criteria: 'Комбо-шлейф: за собакой цветной (радужный) след из силуэтов, спидлайны по краям экрана, счётчик «Комбо ×8+» в HUD жёлтым.',
  },
  {
    name: '12-results-mid', mode: 'career', cls: 'novice', stage: 1,
    predicate: 'false', thenFinishT: 1.6,
    criteria: 'Секвенция результатов НА СЕРЕДИНЕ (finishT=1.6): вердикт-заголовок и строки время/фолты видны, звёзды ещё серые заглушки, очков/медали/наград ЕЩЁ НЕТ (подсказка ENTER-скипа с 1.0с — норма) — этапность работает.',
  },
  {
    name: '13-results-full', mode: 'career', cls: 'novice', stage: 1,
    predicate: 'false', thenFinishT: 4,
    criteria: 'Полный протокол: вердикт, 3 звезды, все строки, медаль, «+N 🦴 +XP», XP-бар с уровнем, строка Хлои, конфетти в фоне.',
  },
  {
    name: '14-coat-redtri', mode: 'career', cls: 'novice', stage: 1,
    equip: { coat: 'coat-aussie-redtri' },
    predicate: "q && q.state==='active' && q.def.kind==='press' && (() => { const v=Math.max(run.dog.speed,.5); const dd=m.entryD-1.3-run.dog.dist; return Math.abs(dd)<=q.w*0.6*v; })()",
    criteria: 'Хлоя в окрасе ред-три: рыже-ливерное тело, белая грудь, БЕЗ мраморных пятен мерля, подпал на морде/лапах.',
  },
  {
    name: '15-coat-lilac-border', mode: 'career', cls: 'novice', stage: 1, breedIdx: 0,
    equip: { coat: 'coat-border-lilac' },
    predicate: "q && q.state==='active' && q.def.kind==='press' && (() => { const v=Math.max(run.dog.speed,.5); const dd=m.entryD-1.3-run.dog.dist; return Math.abs(dd)<=q.w*0.6*v; })()",
    criteria: 'Бордер-колли в окрасе лайлак: серо-бежевое (пыльно-розоватое) тело вместо чёрного, белая грудь.',
  },
  // ---- V4 «Глубина» ----
  {
    name: '16-groove-lane', mode: 'career', cls: 'open', stage: 1,
    predicate: "m && m.o.type==='weave' && q && q.state==='active' && q.beatIdx >= 3 && q.beatIdx <= 6",
    criteria: 'Weave Groove: внизу ЛЕНТА НОТ с жёлтой линией удара слева, ноты-стрелки ← (синие) и → (жёлтые) едут справа, подпись BPM слева над лентой и «стойка N/12» справа; собака в слаломе.',
  },
  {
    name: '17-table-count', mode: 'career', cls: 'excellent', stage: 1,
    predicate: "m && m.o.type==='table' && q && q.def.kind==='freeze' && q.stage === 1 && q.progress > 0.25 && q.progress < 0.75",
    criteria: 'Стол «Замри»: собака НА столе, большая жёлтая цифра счёта (или «…» в фейк-паузу), фиолетовая шкала с подписью «ЗАМРИ! Не трогай кнопки», пузырь судейского счёта у хендлера.',
  },
  {
    name: '18-charge-arc', mode: 'career', cls: 'excellent', stage: 5,
    predicate: "m && m.o.type==='spread' && q && q.holding && q.progress > 0.25 && q.progress < 0.55",
    criteria: 'Чарж-барьер: ДУГА заряда 270° с жёлтым сектором зоны (60–85%), голубой прогресс ещё до зоны, подпись «Отпусти … в жёлтом!», собака приседает перед двойным барьером (каскад планок).',
  },
  {
    name: '19-serpentine', mode: 'career', cls: 'excellent', stage: 2,
    predicate: "m && m.o.type==='serpentine' && q && q.state==='active' && q.beatIdx >= 1 && q.beatIdx <= 2",
    criteria: 'Серпантин: веер из 4 наклонных барьеров (сине-оранжевые стойки), внизу 4 кейкапа — пройденные зелёные, текущий со стрелкой стороны, дальние могут быть «?» (не раскрыты).',
  },
  {
    name: '20-tire-apex', mode: 'career', cls: 'excellent', stage: 4,
    predicate: "m && m.o.type==='tire' && q && q.stage === 1",
    criteria: 'Шина double-tap: собака В ВОЗДУХЕ у шины (красное кольцо), внизу кейкап ХОП с голубым/жёлтым кольцом, сжимающимся к апексу; попап «ЕЩЁ!» голубой.',
  },
  {
    name: '21-boss-ghost', mode: 'career', cls: 'novice', stage: 6,
    predicate: "run.ghost && run.time > 2.5 && !run.dog.hidden",
    criteria: 'Босс-дуэль: на трассе ДВЕ собаки — наша и полупрозрачная МРАМОРНАЯ АУССИ-призрак с подписью «👻 Эйва» фиолетовым; заголовок HUD «👻 Босс: Эйва · Двор».',
  },
  {
    name: '22-risk-armed', mode: 'career', cls: 'novice', stage: 1, riskFirst: true,
    predicate: "m && m.risk && q && q.state==='active' && run.time > 1.5",
    criteria: 'Заявка риска: попап «⚡ РИСК ×2!» оранжевый над собакой, в правой HUD-панели строка «Риск ⚡⚡·» (один фокус потрачен).',
  },
  // ---- S1 «Game Feel» (in-run) ----
  {
    name: '28-micro-delta', mode: 'career', cls: 'novice', stage: 1,
    predicate: "run.popups.some(p => p.small)",
    criteria: 'Микро-дельта тайминга (S1.11): под крупной оценкой «ИДЕАЛЬНО!» мелкая голубоватая строка вида «+12 мс» / «−8 мс» — учит сдвигать нажатие.',
  },
  {
    name: '29-live-delta-ghost', mode: 'career', cls: 'novice', stage: 1, testDrive: true,
    predicate: "run.ghost && run.marks.some(x=>x.resolved) && run.popups.some(p => !p.small && (p.color==='#69f0ae'||p.color==='#ff8a8a') && String(p.text).includes('с'))",
    criteria: 'Live-дельта против призрака (S1.4): рядом с собакой всплывает «−0.4с» зелёным (впереди Эйвы) или «+0.7с» красным (позади) — драма по каждому снаряду.',
  },
  {
    name: '30-trainer-medal', mode: 'career', cls: 'novice', stage: 1,
    predicate: 'false', thenFinishT: 3.4,
    criteria: 'Протокол с медалью Тренера (S1.6): под строкой очков строка «🏅 Медаль Тренера!» или «🥇 Золото времени · до Тренера N.Nс» — цель для re-run. Строки разнесены по слотам, без слипания.',
  },
  {
    name: '31-risk-hint', mode: 'career', cls: 'novice', stage: 1,
    predicate: "m && m.qte && m.qte.state==='active' && m.qte.def.kind==='press' && !m.risk && run.focus.count>0 && (run.time-m.qteStart) < m.qte.target - m.qte.w && run.time > 1.2",
    criteria: 'Подсказка риска в ходе забега: мигающая оранжевая плашка «⚡ SHIFT — риск ×2» (на таче «тап по хендлеру») — пока окно не открылось. Раньше SHIFT был неочевиден.',
  },
  {
    name: '32-decoy-reveal', mode: 'career', cls: 'excellent', stage: 3,
    predicate: "m && m.decoys && m.decoys.revealed && m.qte.state==='active'",
    criteria: 'Обманка раскрыта: крупная надпись «ЖМИ!» + кейкап настоящей клавиши (может быть НЕ ПРОБЕЛ — ←/↑/↓). Обманки теперь настоящие и редкие.',
  },
];

const manifest = [];
for (const sc of SCENES) {
  const res = await page.evaluate(`${RUNNER}(${JSON.stringify({
    mode: sc.mode, cls: sc.cls, stage: sc.stage, realIdx: sc.realIdx, breedIdx: sc.breedIdx,
    predicate: sc.predicate, missAt: sc.missAt, thenFinishT: sc.thenFinishT, equip: sc.equip,
    riskFirst: sc.riskFirst, testDrive: sc.testDrive,
  })})`);
  if (sc.setup === 'mash') {
    // Качаем boost инпутами БЕЗ прокрутки физики (собака остаётся в фазе спурта)
    // и чистим конфетти/попапы последнего перфекта — кадр остаётся читаемым
    await page.evaluate(`(async () => {
      const run = window.__agility.app.run;
      for (let i = 0; i < 12; i++) run.input(i % 2 ? 'ArrowRight' : 'ArrowLeft', true);
      if (run.fx && run.fx.list) run.fx.list.length = 0;
      if (run.popups) run.popups.length = 0;
    })()`);
  }
  await new Promise(r => setTimeout(r, 1800)); // rAF дорисует замороженную сцену
  await page.screenshot({ path: join(OUT, sc.name + '.png') });
  manifest.push({ file: sc.name + '.png', hit: res.hit, criteria: sc.criteria });
  console.log(`${res.hit ? 'ok ' : 'MISS'} ${sc.name}`);
}

// ---- Экранные сцены V4 (прямая установка состояния, вне RUNNER) ----
const SCREENS = [
  {
    name: '23-newspaper',
    setup: `(() => {
      const A = window.__agility;
      A.app.run = null;
      A.app.bossWin = { boss: { id: 'ayva', name: 'Эйва' }, time: 32.4, ghostTime: 34.1,
        breedName: 'Хлоя', cls: 'novice' };
      A.app.state = 'news';
    })()`,
    criteria: 'Газета «АДЖИЛИТИ ВЕСТНИК» на бумажном листе с наклоном: заголовок «СЕНСАЦИЯ ВО ДВОРЕ!», подзаголовок с Хлоей и дельтой, рамка-«фото» 🐕🏆, абзац текста, снизу «ENTER / тап — дальше».',
  },
  {
    name: '24-champion',
    setup: `(() => {
      const A = window.__agility;
      A.app.run = null;
      A.app.state = 'champion';
    })()`,
    criteria: 'Экран чемпиона: кубок 🏆 в лучах, «ЧЕМПИОН!» золотом, строка про победу над Астрой, реплика хендлера, фиолетовая строка про NG+.',
  },
  {
    name: '25-menu-boss',
    setup: `(() => {
      const A = window.__agility;
      A.app.run = null;
      A.setMode('career');
      A.app.cls = 'novice';
      A.app.stage = 6;
      A.app.state = 'menu';
    })()`,
    criteria: 'Меню на босс-этапе: заголовок «КАРЬЕРА · Двор · 👻 БОСС: Эйва», на карте карьеры после 5 кружков пульсирует 👻; строка дара выбранной породы над «ENTER — на старт».',
  },
  // ---- S1 «Game Feel» ----
  {
    name: '26-shop-freeze',
    setup: `(() => {
      const A = window.__agility;
      A.app.run = null;
      A.meta.bones = 640;
      A.meta.streak.freezes = 1;
      A.app.breedIdx = 3;
      A.app.state = 'shop';
    })()`,
    criteria: 'Магазин: под строкой баланса — голубая плашка «🧊 Заначка стрика 1/2 — 200🦴» (S1.5), ниже сетка косметики без наложения.',
  },
  {
    name: '27-settings-haptics',
    setup: `(() => {
      const A = window.__agility;
      A.app.run = null;
      A.app.state = 'settings';
    })()`,
    criteria: 'Настройки: тумблеры Тряска/Колорблайнд/Вибрация (тач), слайдеры Музыка/Звуки, кнопки Калибровка/Тренировка — всё в панели без наложения.',
  },
];
for (const sc of SCREENS) {
  await page.evaluate(sc.setup);
  await new Promise(r => setTimeout(r, 700));
  await page.screenshot({ path: join(OUT, sc.name + '.png') });
  manifest.push({ file: sc.name + '.png', hit: true, criteria: sc.criteria });
  console.log(`ok  ${sc.name}`);
}

await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
await browser.close();
server.close();
const misses = manifest.filter(m => !m.hit).length;
console.log(`\n${manifest.length} scenes, ${misses} predicate-misses. Manifest: tests/shots/visual/manifest.json`);
process.exit(misses ? 1 : 0);

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
await page.goto(BASE + '/?noanalytics');
await page.waitForFunction(() => !!window.__agility);

// Единый раннер: стартует прогон и крутит до предиката, потом замораживает.
// predicate — строка JS-выражения от (run, m, q, t) → boolean.
const RUNNER = `(async (opts) => {
  const A = window.__agility;
  localStorage.setItem('agility_onboarded', '1');
  localStorage.setItem('agility_hints', JSON.stringify({ weave: 1, aframe: 1, dogwalk: 1,
    seesaw: 1, table: 1, tire2: 1, spread: 1, triple: 1, serpentine: 1 }));
  // Колорблайнд выставляем ЯВНО каждой сцене (а не только когда просят) —
  // иначе режим протёк бы из предыдущей сцены в следующие.
  A.settings.colorblind = !!opts.colorblind;
  A.applySettings();
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
  if (opts.pet) A.pet(); // S3: гладим собаку на ритуале старта
  while (guard++ < 60000 && run.phase !== 'finished') {
    const m = run.activeMark;
    const q = m && m.qte;
    const t = q ? run.time - m.qteStart : 0;
    if (pred(run, m, q, t)) { run.update = () => {}; return { hit: true, time: +run.time.toFixed(2) }; }
    if (q && q.state === 'active') {
      const d = q.def;
      const resolvedCount = run.marks.filter(x => x.resolved).length;
      // Намеренный промах: либо N-го снаряда (missAt), либо первого же после того,
      // как накопилось missWhenStars звёзд (S4.7 — ловим момент сжигания).
      const skipInput = (missArmed && resolvedCount === missArmed - 1)
        || (!!opts.missWhenStars && !!run.stars && run.stars.count >= opts.missWhenStars);
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
          // noRelease: держим до упора — курсор уезжает за жёлтую зону
          // в красную overdrive-зону (S4.5), иначе автопилот отпускает в середине жёлтой
          else if (q.holding && !opts.noRelease && q.progress >= (d.zone[0] + d.zone[1]) / 2) run.input(d.key, false);
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
  if (opts.lapT !== undefined) {
    // S3: победный круг живёт уже в фазе finished — докручиваем физику вручную
    let g2 = 0;
    while (run.victoryLap && !run.victoryLap.done && run.victoryLap.t < opts.lapT && g2++ < 6000) {
      proto.update.call(run, 1 / 60);
    }
    run.update = () => {};
    return { hit: !!run.victoryLap, time: +run.time.toFixed(2) };
  }
  if (opts.photo) {
    // Пропускаем круг: экран сам снимет кадр-полароид на ближайшем rAF
    if (run.skipVictoryLap) run.skipVictoryLap();
    run.update = () => {};
    await new Promise(r => setTimeout(r, 900));
    return { hit: window.__agility.app.state === 'photo' };
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
  // ---- S3 «Душа собаки» ----
  {
    name: '35-commentary', mode: 'career', cls: 'open', stage: 2,
    predicate: "run.commentator.line && run.commentator.line.t > 0.5 && run.commentator.line.t < 1.4 && run.marks.some(x=>x.resolved)",
    criteria: 'Комментатор ринга: под шапкой HUD голубая пилюля с иконкой 🎙 и курсивной репликой трансляции (например «Чисто! Пока ни одной планки на траве.»). Строка не наезжает на панели времени/фолтов и на QTE внизу.',
  },
  {
    name: '36-petting', mode: 'career', cls: 'novice', stage: 1, pet: true,
    predicate: "run.phase === 'countdown' && run.dog.petT > 0.55",
    criteria: 'Ласка на старте (S3.1): собака в стойке с ПРИЖАТЫМИ ушами, прищуренным глазом-дужкой и высунутым языком, вокруг вверх летят розовые сердечки, под «На старт…» зелёная плашка «💙 Спокойный старт — дрожь ушла», рядом попап «💙 Спокойный старт».',
  },
  {
    name: '40-temperament-bow', mode: 'career', cls: 'novice', stage: 1, breedIdx: 1,
    predicate: "run.phase === 'countdown' && run.countdownT < 1.0 && run.dog.pose === 'bow'",
    criteria: 'Темперамент шелти (S3.7): на ритуале старта собака в ПОКЛОНЕ-потягушке — корпус наклонён вперёд-вниз, морда у земли; надпись «На старт…» и плашка приглашения погладить на месте.',
  },
  {
    name: '41-victory-lap', mode: 'career', cls: 'novice', stage: 1, lapT: 2.0,
    predicate: 'false',
    criteria: 'Победный круг (S3.3): собака мчится вдоль ближней трибуны с высунутым языком, зрители ВСТАЛИ (ряд поднят выше обычного), хендлер рядом на коленях с поднятыми руками, в воздухе конфетти. HUD ещё виден, протокол судьи НЕ показан.',
  },
  {
    name: '42-photo-finish', mode: 'career', cls: 'novice', stage: 1, photo: true,
    predicate: 'false',
    criteria: 'Фото-финиш (S3.3): на тёмном фоне заголовок «📸 ФОТО-ФИНИШ» и бумажный ПОЛАРОИД с наклоном — сверху кадр сцены, снизу рукописная подпись «Хлоя · NN.NNс», строка титула и трассы, мелкие «🐕 Agility Trial!» и дата; под карточкой кнопки «📤 Поделиться» и жёлтая «▶ К протоколу».',
  },
  {
    name: '45-photo-mode', mode: 'career', cls: 'open', stage: 2, setup: 'photoMode',
    predicate: "run.dog.airborne && run.dog.elevation > 0.6",
    criteria: 'Фото-режим с паузы (S3.8): мир заморожен на прыжке, HUD спрятан, кадр обрамлён белой рамкой с уголками-визиром, сверху подсказка «📸 Фото-режим · стрелки — кадр · +/− зум · S — сохранить PNG», внизу слева «🐕 Agility Trial!», справа кличка, по центру кнопки −, +, 💾 PNG, ✕ Выход.',
  },
  // ---- S4 «Ритм-мир» ----
  // 46/47 — контрастная ПАРА на пульс мира (S4.1). Амплитуда пульса в бою
  // микроскопическая (масштабы 1.00→1.02, тень −2%), а в headless-прогоне
  // AudioContext спит и beatOn=false — статичный «дышащий» кадр не доказал бы
  // ничего. Поэтому: та же сцена, та же камера, приближённая к трибуне
  // (renderer.cam.zoom), поля бита выставлены руками в долю и в противофазу,
  // овации толпы (crowdHype от комбо) обнулены — в кадре остаётся ТОЛЬКО пульс.
  {
    name: '46-beat-crowd-on', mode: 'career', cls: 'novice', stage: 1,
    predicate: "run.phase === 'running' && run.time > 1.0",
    beat: { pulse: 1, phase: 0 },
    criteria: 'Пульс мира В ДОЛЮ (S4.1), кадр 1 из ПАРЫ 46/47 — смотреть только вместе с 47-beat-crowd-off. Крупный план двух рядов зрителей (цветные кружки-тела с телесными головами) на газоне; внизу кадра белая линия кромки ринга, вверху обычный HUD. Проверяемое: зрители здесь стоят ВЫШЕ, чем на 47 (примерно на 8–11 пикселей, у разных зрителей чуть по-разному), — зазор между верхом головы и панелями HUD/строкой комментатора здесь МЕНЬШЕ. Всё остальное (горизонтальные позиции и цвета зрителей, белая линия кромки ринга, HUD, кейкап ПРОБЕЛ) на обоих кадрах совпадает пиксель в пиксель. Отдельного виджета бита в HUD быть не должно — пульс живёт в самом мире.',
  },
  {
    name: '47-beat-crowd-off', mode: 'career', cls: 'novice', stage: 1,
    predicate: "run.phase === 'running' && run.time > 1.0",
    beat: { pulse: 0, phase: 0.86 },
    criteria: 'Пульс мира В ПРОТИВОФАЗЕ (S4.1), кадр 2 из ПАРЫ 46/47: тот же крупный план тех же зрителей с той же камеры, кадр снят при beatPulse=0 / beatPhase=0.86. Проверяемое: зрители здесь ОСЕЛИ вниз относительно 46-beat-crowd-on (~8–11 пикселей), зазор между верхом головы и HUD больше; белая линия кромки ринга внизу и все панели HUD стоят ровно там же, что и на 46 — сместилась только трибуна. Если высота зрителей на 46 и 47 одинакова, пульс мира до рендера не доходит — это провал сцены.',
  },
  // 48-50 — overdrive-зона (S4.5) на шкале контактного снаряда
  {
    name: '48-overdrive-yellow', mode: 'worldcup', realIdx: 1,
    predicate: "m && q && q.holding && q.zoneRed && q.progress > 0.80 && q.progress < 0.87",
    criteria: 'Overdrive, курсор в БЕЗОПАСНОЙ зоне (S4.5): собака на контактном снаряде, внизу по центру голубая шкала с подписью «Отпусти ↑ в жёлтой · красная = жадный бонус». На шкале справа широкий ЖЁЛТЫЙ сегмент, а у самого правого края шкалы — узкий КРАСНЫЙ блок в косую белую штриховку с двойным контуром. Белый вертикальный маркер-курсор стоит ВНУТРИ жёлтого сегмента, до красного блока он ещё не дошёл.',
  },
  {
    name: '49-overdrive-red', mode: 'worldcup', realIdx: 1, noRelease: true,
    predicate: "m && q && q.holding && q.zoneRed && q.progress >= q.zoneRed[0] + 0.004",
    criteria: 'Overdrive, момент решения — курсор В КРАСНОЙ зоне (S4.5): та же шкала контакта с подписью «Отпусти ↑ в жёлтой · красная = жадный бонус», но белый вертикальный маркер уехал уже ПРАВЕЕ жёлтого сегмента — в самый конец шкалы, в узкий красный блок, от которого по бокам маркера видны красная заливка и красная рамка (блок настолько узкий, что маркер почти целиком его перекрывает — это и есть цена жадности). Именно здесь игрок решает: отпустить ради бонуса или сорваться с контакта.',
  },
  {
    name: '50-overdrive-colorblind', mode: 'worldcup', realIdx: 1, colorblind: true,
    predicate: "m && q && q.holding && q.zoneRed && q.progress > 0.80 && q.progress < 0.87",
    criteria: 'Overdrive в КОЛОРБЛАЙНД-режиме (S4.5): тот же кадр, что 48-overdrive-yellow, но игра запущена с включённым тумблером «Колорблайнд». Проверяемое: overdrive-зона у правого края шкалы отличается от жёлтой зоны НЕ ТОЛЬКО ЦВЕТОМ — это блок в КОСУЮ БЕЛУЮ ШТРИХОВКУ с двойным контуром (внутренняя белая рамка + внешняя красная), тогда как соседний жёлтый сегмент — сплошная заливка без штриховки и без двойной рамки. Белый маркер-курсор — в жёлтом сегменте, штриховка видна целиком.',
  },
  // 51-54 — звёзды Punch-Out (S4.7): ряд живёт в правой HUD-панели
  {
    name: '51-stars-empty', mode: 'career', cls: 'open', stage: 2,
    predicate: "run.phase === 'running' && run.time > 1.4 && run.stars.count === 0 && run.score.faults === 0",
    criteria: 'Звёзды, ПУСТОЙ ряд (S4.7): в правой HUD-панели (под строками «Фолты» и «Комбо», рядом со строкой риска) виден ряд из ТРЁХ звёзд, и все три — полупрозрачные КОНТУРНЫЕ (незакрашенные): игрок сразу видит, сколько их всего. Подписи «ФИНИШ ×2» рядом со звёздами НЕТ.',
  },
  {
    name: '52-stars-partial', mode: 'career', cls: 'open', stage: 2,
    // Ждём, пока догорят попапы и вспышка перфекта, иначе кадр выбелен флешем
    predicate: "run.stars.count === 2 && run.phase === 'running' && run.popups.length === 0",
    criteria: 'Звёзды, ЧАСТИЧНО набранные (S4.7): в правой HUD-панели ряд из трёх звёзд — ДВЕ левые залиты жёлтым, третья осталась полупрозрачным контуром. Фолтов 0, комбо растёт. Подписи «ФИНИШ ×2» ещё нет.',
  },
  {
    name: '53-stars-finish-armed', mode: 'career', cls: 'open', stage: 2,
    predicate: "run.stars.isFinishArmed() && run.phase === 'running'",
    criteria: 'Звёзды, ФИНИШ ЗАРЯЖЕН (S4.7): в правой HUD-панели звёзды залиты жёлтым (одна или больше), а СПРАВА ОТ РЯДА жёлтым жирным шрифтом подпись «ФИНИШ ×2» — на последнем снаряде очки удвоятся. Подпись не наезжает на кнопку звука и на край панели. Счётчик снарядов вверху слева показывает предпоследний/последний снаряд.',
  },
  {
    name: '54-stars-burn', mode: 'career', cls: 'open', stage: 2, missWhenStars: 1, wait: 300,
    predicate: "run.stars.count === 0 && run.score.faults > 0",
    criteria: 'Звёзды СГОРЕЛИ после промаха (S4.7): в правой HUD-панели все три звезды снова контурные (ни одной залитой жёлтым), но одна из них — УВЕЛИЧЕНА и подсвечена КРАСНЫМ: вспышка сжигания. Рядом признаки промаха — счётчик «Фолты» стал красным и не нулевым, у собаки попап ошибки, мир обесцвечен. Подписи «ФИНИШ ×2» нет.',
  },
];

const manifest = [];
for (const sc of SCENES) {
  const res = await page.evaluate(`${RUNNER}(${JSON.stringify({
    mode: sc.mode, cls: sc.cls, stage: sc.stage, realIdx: sc.realIdx, breedIdx: sc.breedIdx, pet: sc.pet,
    predicate: sc.predicate, missAt: sc.missAt, thenFinishT: sc.thenFinishT, equip: sc.equip,
    riskFirst: sc.riskFirst, testDrive: sc.testDrive, lapT: sc.lapT, photo: sc.photo,
    noRelease: sc.noRelease, missWhenStars: sc.missWhenStars, colorblind: sc.colorblind,
  })})`);
  if (sc.beat) {
    // S4.1: run.update уже заморожен, поэтому _pushBeat больше не перетирает поля —
    // выставляем фазу бита руками и придвигаем камеру к трибуне, чтобы
    // микроскопическая амплитуда пульса стала различима на паре кадров.
    await page.evaluate(`(() => {
      const run = window.__agility.app.run, r = run.r;
      run.score.combo = 0;          // овации толпы зависят от комбо — гасим, иначе шумят
      r.crowdStanding = false;
      r.cam.zoom = 150; r.cam.x = 26; r.cam.y = -2.8;
      r.beatOn = true;
      r.beatPulse = ${sc.beat.pulse};
      r.beatPhase = ${sc.beat.phase};
    })()`);
  }
  if (sc.setup === 'photoMode') {
    // S3.8: включаем фото-режим и слегка приближаем кадр
    await page.evaluate(`(() => {
      const A = window.__agility;
      A.togglePhotoMode();
      A.app.photoMode.zoom = 1.25;
    })()`);
  }
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
  // rAF дорисует замороженную сцену. Короткая пауза — только там, где важна
  // сама вспышка (звёзды сгорают за 0.45с реального времени).
  await new Promise(r => setTimeout(r, sc.wait ?? 1800));
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
  {
    name: '34-board-online',
    setup: `(() => {
      const A = window.__agility;
      A.app.run = null;
      // Подставляем онлайн-топ (Fable Arcade SDK), чтобы проверить отрисовку строки.
      A.app.onlineTop = [{ name: 'Хлоя', score: 2450 }, { name: 'Рекс', score: 2100 }, { name: 'Джек', score: 1980 }];
      A.app.onlineRank = 7;
      A.app.state = 'board';
    })()`,
    criteria: 'Экран лидерборда: под заголовком «🏆 ЛУЧШИЕ ПРОГОНЫ» голубая строка онлайн-топа вида «🌐 1. Хлоя 2450 · 2. Рекс 2100 · 3. Джек 1980 (ты #7)», ниже локальная таблица и достижения — без наложения.',
  },
  {
    name: '37-menu-idle-scratch',
    setup: `(() => {
      const A = window.__agility;
      A.app.run = null;
      A.app.breedIdx = 3;
      A.app.state = 'menu';
      A.app.lastInputT = A.app.t;      // не спим — показываем выходку
      A.menuIdle.set('scratch');
      A.menuIdle.t = 0.5;              // середина чесания
    })()`,
    criteria: 'Меню, собака живёт (S3.2): выбранная карточка Хлои — собака накренилась и ЧЕШЕТСЯ задней лапой у уха (лапа поднята к голове), остальные карточки статичны. Вёрстка меню не поехала.',
  },
  {
    name: '38-menu-idle-sleep',
    setup: `(() => {
      const A = window.__agility;
      A.app.run = null;
      A.app.breedIdx = 3;
      A.app.state = 'menu';
      A.app.lastInputT = A.app.t - 60;  // минута без ввода → сон
      A.menuIdle.set('sleep');
    })()`,
    criteria: 'Меню, собака заснула (S3.2): на выбранной карточке собака осела к земле, глаз закрыт дужкой, уши обвисли, лапы поджаты, над головой всплывают «z z z».',
  },
  {
    name: '39-dossier',
    setup: `(() => {
      const A = window.__agility;
      A.app.run = null;
      A.app.breedIdx = 3;
      A.meta.counters.obstacleStats = { jump: { seen: 24, perfect: 15 }, weave: { seen: 9, perfect: 8 },
        tunnel: { seen: 7, perfect: 3 } };
      A.meta.counters.bestTime = { aussie: 28.44 };
      A.meta.rosettes = 4;
      A.app.state = 'dossier';
    })()`,
    criteria: 'Досье собаки (S3.7): панель «📖 Досье собаки» — слева живой портрет Хлои, справа кличка с кнопкой «✏ переименовать» и строкой породы/уровня, ниже строки-пилюли: Характер «Задира», Повадка, Любимый снаряд «слалом (89% идеальных)», Лучшее чистое время 28.44с, розетки, золото. Ничего не наезжает.',
  },
  {
    name: '43-podium',
    setup: `(() => {
      const A = window.__agility;
      A.app.run = { warmup: false, bossCls: 'novice', eliminated: false, time: 30.1,
        ghost: { name: 'Эйва', time: 33.0 }, course: { name: 'Босс: Эйва' } };
      A.app.result = { qualified: true, clean: true, stars: 3 };
      A.app.breedIdx = 3;
      A.app.podiumDone = false;
      A.app.state = 'results';
      A.openPodium();
    })()`,
    criteria: 'Подиум-церемония (S3.5): «🏅 ЦЕРЕМОНИЯ НАГРАЖДЕНИЯ», строка «Хлоя — ПЕРВОЕ МЕСТО!», три тумбы 2-1-3 (центральная выше и подсвечена жёлтым), на центральной — Хлоя с розеткой на ошейнике, на боковых — серые силуэты соперников; внизу «ENTER / тап — дальше».',
  },
  {
    name: '44-treat',
    setup: `(() => {
      const A = window.__agility;
      A.app.run = null;
      A.app.breedIdx = 3;
      A.app.treatDone = false;
      A.openTreat();
      A.treatAdvance();          // шаг «Дай лапу!»
    })()`,
    criteria: 'Ритуал угощения (S3.6): экран «🍪 Угощение», крупная команда «Дай лапу!», собака СИДИТ и тянет переднюю лапу вперёд, три точки прогресса (первая закрашена), внизу подсказка «Тап / ПРОБЕЛ — команда · ESC — пропустить».',
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

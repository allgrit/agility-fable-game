// Тесты чистой логики: node --test tests/logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCourse, validateCourse, CLASSES } from '../js/course.js';
import { Path } from '../js/spline.js';
import { Qte, QTE_DEFS, gradeFromDelta, qteDuration } from '../js/qte.js';
import { computeSct, timeFaults, finalScore, BREEDS, nextClass } from '../js/scoring.js';

test('генератор: 200 сидов по всем классам дают валидные трассы', () => {
  for (const cls of Object.keys(CLASSES)) {
    for (let seed = 1; seed <= 50; seed++) {
      const c = generateCourse(seed, cls);
      const errs = validateCourse(c);
      assert.deepEqual(errs, [], `seed=${seed} cls=${cls}: ${errs.join('; ')}`);
    }
  }
});

test('генератор: детерминизм по сиду', () => {
  const a = generateCourse(42, 'open');
  const b = generateCourse(42, 'open');
  assert.deepEqual(a.obstacles.map(o => [o.type, o.x.toFixed(3), o.y.toFixed(3)]),
    b.obstacles.map(o => [o.type, o.x.toFixed(3), o.y.toFixed(3)]));
});

test('генератор: первый и последний снаряды — прыжковые', () => {
  const easy = ['jump', 'tire', 'wall', 'broad'];
  for (let seed = 1; seed <= 30; seed++) {
    const c = generateCourse(seed, 'masters');
    assert.ok(easy.includes(c.obstacles[0].type), `seed=${seed} first=${c.obstacles[0].type}`);
    assert.ok(easy.includes(c.obstacles.at(-1).type), `seed=${seed} last=${c.obstacles.at(-1).type}`);
  }
});

test('путь: длина положительна, точки монотонны по дистанции', () => {
  const c = generateCourse(7, 'excellent');
  const p = new Path(c.pathPoints);
  assert.ok(p.length > 60, `path too short: ${p.length}`);
  for (let i = 1; i < p.pointDists.length; i++) {
    assert.ok(p.pointDists[i] >= p.pointDists[i - 1] - 0.5,
      `pointDists not monotonic at ${i}: ${p.pointDists[i - 1]} -> ${p.pointDists[i]}`);
  }
  const mid = p.pointAt(p.length / 2);
  assert.ok(Number.isFinite(mid.x) && Number.isFinite(mid.y));
});

test('QTE press: perfect в целевой момент, miss при неверной клавише и таймауте', () => {
  let q = new Qte('jump');
  q.update(0.1);
  q.press('Space', q.target);
  assert.equal(q.result.grade, 'perfect');

  q = new Qte('jump');
  q.update(0.1);
  q.press('ArrowDown', q.target);
  assert.equal(q.result.grade, 'miss');
  assert.equal(q.result.faults, 5);

  q = new Qte('tunnel');
  q.update(0.1);
  q.update(q.target + QTE_DEFS.tunnel.window + 0.1);
  assert.equal(q.result.grade, 'miss');
});

test('QTE groove (слалом-ритм): 12 битов в темп → perfect + golden, окна в мс', () => {
  const d = QTE_DEFS.weave;
  const opts = { bpm: 120, grooveWindows: { p: 0.06, g: 0.11, o: 0.16 } };
  let q = new Qte('weave', opts);
  q.update(0.01);
  let t = q.target;
  const evs = [];
  for (let i = 0; i < d.beats; i++) {
    evs.push(...q.press(d.keys[i % 2], t));
    t = q.nextBeatT; // beat мог ускориться от perfect-серии
  }
  assert.equal(q.result.grade, 'perfect');
  assert.ok(q.result.golden, 'все perfect = Golden Weave');
  assert.ok(evs.some(e => e.type === 'golden'));
  assert.ok(evs.some(e => e.type === 'accel'), 'BPM разогнался от perfect-серии');

  // Окно не масштабируется: нажатие с ошибкой 0.1с при p=0.06 → good, не perfect
  q = new Qte('weave', opts);
  q.update(0.01);
  q.press(d.keys[0], q.target + 0.1);
  assert.equal(q.beatGrades[0], 'good');
});

test('QTE groove: 3 промаха = возврат на 1-ю стойку без фолтов', () => {
  const d = QTE_DEFS.weave;
  const q = new Qte('weave', { bpm: 120, grooveWindows: { p: 0.06, g: 0.11, o: 0.16 } });
  q.update(0.01);
  // Три подряд неверные клавиши = 3 miss
  let evs = [];
  for (let i = 0; i < 3; i++) evs.push(...q.press('Space', q.nextBeatT ?? q.target));
  assert.ok(evs.some(e => e.type === 'restart'));
  assert.equal(q.beatIdx, 0, 'вернулась на 1-ю стойку');
  assert.equal(q.state, 'active', 'слалом продолжается');
  // Дальше можно пройти чисто (restarts штрафят только временем)
  let t = q.nextBeatT;
  for (let i = 0; i < d.beats; i++) { q.press(d.keys[i % 2], t); t = q.nextBeatT; }
  assert.equal(q.result.grade, 'perfect');
  assert.ok(!q.result.golden, 'после рестарта golden не даётся');
  assert.equal(q.result.faults, 0);
});

test('QTE groove: рестарт сбрасывает разгон BPM, кламп на 168', () => {
  const d = QTE_DEFS.weave;
  const opts = { bpm: 144, grooveWindows: { p: 0.045, g: 0.085, o: 0.125 } };
  let q = new Qte('weave', opts);
  q.update(0.01);
  // Разгоняем: 4 перфекта → beat ускорился
  let t = q.target;
  for (let i = 0; i < 4; i++) { q.press(d.keys[i % 2], t); t = q.nextBeatT; }
  assert.ok(q.beat < q.baseBeat, 'разгон применился');
  // 3 промаха → возврат: темп вернулся к исходному
  for (let i = 0; i < 3; i++) q.press('Space', q.nextBeatT);
  assert.equal(q.beat, q.baseBeat, 'рестарт сбросил разгон');
  // Кламп: даже бесконечный разгон не уводит выше 168 BPM
  q = new Qte('weave', { ...opts, accelEvery: 1 });
  q.update(0.01);
  t = q.target;
  for (let i = 0; i < d.beats; i++) { q.press(d.keys[i % 2], t); t = q.nextBeatT; }
  assert.ok(60 / q.beat <= 168.01, `BPM клампится: ${Math.round(60 / q.beat)}`);
});

test('QTE groove: audioOffset сдвигает оценку тайминга', () => {
  const q = new Qte('weave', { bpm: 120, grooveWindows: { p: 0.06, g: 0.11, o: 0.16 }, audioOffset: 0.1 });
  q.update(0.01);
  // Игрок жмёт на 0.1 позже бита, но offset=0.1 компенсирует → perfect
  q.press(QTE_DEFS.weave.keys[0], q.target + 0.1);
  assert.equal(q.beatGrades[0], 'perfect');
});

test('QTE holdRelease (горка): отпускание в зоне ок, раньше зоны — 5 фолтов', () => {
  const d = QTE_DEFS.aframe;
  let q = new Qte('aframe');
  q.update(0.01);
  q.press('ArrowUp', q.target);
  const zoneMid = (d.zone[0] + d.zone[1]) / 2;
  q.update(q.target + d.travel * zoneMid);
  q.release('ArrowUp', q.target + d.travel * zoneMid);
  assert.equal(q.result.grade, 'perfect');
  assert.equal(q.result.faults, 0);

  q = new Qte('aframe');
  q.update(0.01);
  q.press('ArrowUp', q.target);
  q.update(q.target + d.travel * 0.3);
  q.release('ArrowUp', q.target + d.travel * 0.3);
  assert.equal(q.result.grade, 'miss');
  assert.equal(q.result.faults, 5);
});

test('QTE holdRelease: не отпустил — late без фолтов (собака дошла сама)', () => {
  const d = QTE_DEFS.dogwalk;
  const q = new Qte('dogwalk');
  q.update(0.01);
  q.press('ArrowUp', q.target);
  q.update(q.target + d.travel + 0.2);
  assert.equal(q.result.grade, 'late');
  assert.equal(q.result.faults, 0);
});

test('QTE twoStage (качели): обе стадии вовремя → успех, ранний прыжок → miss', () => {
  const d = QTE_DEFS.seesaw;
  let q = new Qte('seesaw');
  q.update(0.01);
  q.press('ArrowUp', q.target);
  assert.equal(q.state, 'active');
  q.press('Space', q.target + d.tipDelay);
  assert.equal(q.result.grade, 'perfect');

  q = new Qte('seesaw');
  q.update(0.01);
  q.press('ArrowUp', q.target);
  q.press('Space', q.target + 0.05); // сильно раньше опускания
  assert.equal(q.result.grade, 'miss');
});

test('QTE freeze (стол «Замри»): заход + тишина 5с + GO-нажатие → успех', () => {
  const d = QTE_DEFS.table;
  let q = new Qte('table');
  q.update(0.01);
  q.press('Space', q.target);           // заход на стол — perfect
  assert.equal(q.stage, 1);
  const evs = q.update(q.target + d.freezeTime + 0.01); // счёт дошёл до нуля
  assert.equal(q.stage, 2);
  assert.ok(evs.some(e => e.type === 'go'));
  q.press('Space', q.goAt + d.goWindow * 0.25);  // реакция в идеальной точке GO-окна
  assert.equal(q.result.grade, 'perfect');
  assert.equal(q.result.faults, 0);
});

test('QTE freeze: ввод во время счёта = счёт заново; проспал GO → late', () => {
  const d = QTE_DEFS.table;
  let q = new Qte('table');
  q.update(0.01);
  q.press('Space', q.target);
  q.update(q.target + 2.0);
  assert.ok(q.progress > 0.3);
  const evs = q.press('ArrowLeft', q.target + 2.2); // дёрнулась во время счёта
  assert.ok(evs.some(e => e.type === 'freezeReset'));
  assert.equal(q.progress, 0, 'счёт начался заново');
  assert.equal(q.state, 'active');
  // Полный счёт заново, но GO проспан
  q.update(q.target + 2.2 + d.freezeTime + 0.01);
  assert.equal(q.stage, 2);
  q.update(q.goAt + d.goWindow + 0.05);
  assert.equal(q.result.grade, 'late');
  assert.equal(q.result.faults, 0);
});

test('QTE freeze: фейк-пауза судьи замораживает счёт', () => {
  const d = QTE_DEFS.table;
  const q = new Qte('table', { fakePauses: [{ at: 1.0, dur: 0.5 }] });
  q.update(0.01);
  q.press('Space', q.target);
  q.update(q.target + 1.2); // внутри паузы
  assert.ok(q.inPause, 'судья сделал фейк-паузу');
  const pBefore = q.progress;
  q.update(q.target + 1.4);
  assert.equal(q.progress, pBefore, 'во время паузы счёт стоит');
  // Полный счёт с учётом паузы: 5с чистых + 0.5 паузы
  q.update(q.target + d.freezeTime + 0.5 + 0.01);
  assert.equal(q.stage, 2);
});

test('QTE doubleTap (шина): тап на взлёте + тап в апексе, без второго — late', () => {
  const d = QTE_DEFS.tire;
  let q = new Qte('tire');
  q.update(0.01);
  const evs = q.press('Space', q.target);
  assert.ok(evs.some(e => e.type === 'takeoff'));
  assert.equal(q.stage, 1);
  q.press('Space', q.tapAt + d.apexDelay); // точно в апексе
  assert.equal(q.result.grade, 'perfect');
  assert.equal(q.result.faults, 0);

  // Нет второго тапа → late без фолтов
  q = new Qte('tire');
  q.update(0.01);
  q.press('Space', q.target);
  q.update(q.target + d.apexDelay + d.window2 + 0.05);
  assert.equal(q.result.grade, 'late');
  assert.equal(q.result.faults, 0);

  // Прогрессия: до Excellent шина — обычный тап (noApex)
  q = new Qte('tire', { noApex: true });
  q.update(0.01);
  q.press('Space', q.target);
  assert.equal(q.result.grade, 'perfect');
});

test('QTE charge (spread/triple): отпуск в зоне ок, перезаряд и слабый заряд = 5 фолтов', () => {
  const d = QTE_DEFS.spread;
  let q = new Qte('spread');
  q.update(0.01);
  q.press('Space', q.target);
  const zoneMid = (d.zone[0] + d.zone[1]) / 2;
  q.update(q.target + d.travel * zoneMid);
  q.release('Space', q.target + d.travel * zoneMid);
  assert.equal(q.result.grade, 'perfect');

  // Слабый заряд (отпуск до зоны)
  q = new Qte('spread');
  q.update(0.01);
  q.press('Space', q.target);
  q.update(q.target + d.travel * 0.3);
  q.release('Space', q.target + d.travel * 0.3);
  assert.equal(q.result.grade, 'miss');
  assert.equal(q.result.faults, 5);

  // Перезаряд (не отпустил)
  q = new Qte('spread');
  q.update(0.01);
  q.press('Space', q.target);
  q.update(q.target + d.travel + 0.05);
  assert.equal(q.result.grade, 'miss');
  assert.equal(q.result.label, 'Перезаряд!');

  // Тройной строже: зона уже
  const dt = QTE_DEFS.triple;
  assert.ok(dt.zone[1] - dt.zone[0] < d.zone[1] - d.zone[0]);
});

test('QTE serp (серпантин): последовательность сторон, ошибка стороны = 5 фолтов', () => {
  const d = QTE_DEFS.serpentine;
  const seq = ['ArrowLeft', 'ArrowRight', 'ArrowRight', 'ArrowLeft'];
  let q = new Qte('serpentine', { serpSeq: seq });
  q.update(0.01);
  for (let i = 0; i < d.count; i++) q.press(seq[i], q.target + i * d.beat);
  assert.equal(q.result.grade, 'perfect');

  q = new Qte('serpentine', { serpSeq: seq });
  q.update(0.01);
  q.press('ArrowRight', q.target); // не та сторона на первом
  for (let i = 1; i < d.count; i++) q.press(seq[i], q.target + i * d.beat);
  assert.equal(q.result.grade, 'miss');
  assert.equal(q.result.faults, 5);
});

test('градации тайминга симметричны и упорядочены', () => {
  assert.equal(gradeFromDelta(0, 0.5), 'perfect');
  assert.equal(gradeFromDelta(-0.13, 0.5), 'perfect');
  assert.equal(gradeFromDelta(0.2, 0.5), 'good');
  assert.equal(gradeFromDelta(-0.4, 0.5), 'late');
  assert.equal(gradeFromDelta(0.6, 0.5), 'miss');
});

test('qteDuration покрывает все типы', () => {
  for (const type of Object.keys(QTE_DEFS)) {
    assert.ok(qteDuration(type) > 0.5, type);
  }
});

test('скоринг: SCT, time faults, чистый прогон и звёзды', () => {
  assert.equal(computeSct(160, 'novice', 3.2), 50);
  assert.equal(timeFaults(52.3, 50), 3);
  assert.equal(timeFaults(49.9, 50), 0);

  const clean = finalScore({ time: 40, sct: 50, faults: 0, perfects: 10, total: 12, maxCombo: 6 });
  assert.equal(clean.clean, true);
  assert.equal(clean.stars, 3);
  assert.match(clean.title, /Q/);

  const faulty = finalScore({ time: 55, sct: 50, faults: 10, perfects: 2, total: 12, maxCombo: 1 });
  assert.equal(faulty.clean, false);
  assert.equal(faulty.totalFaults, 15);
  assert.equal(faulty.stars, 0);
});

test('породы: у всех заданы модификаторы, классы по порядку', () => {
  for (const b of Object.values(BREEDS)) {
    assert.ok(b.speedMul > 0.5 && b.windowScale > 0.5 && b.size > 0);
  }
  assert.equal(nextClass('novice'), 'open');
  assert.equal(nextClass('masters'), 'masters');
});

// ---- Реальные трассы ----
const { REAL_COURSES, realToCourse } = await import('../js/courses.js');
const { Path: RPath } = await import('../js/spline.js');

test('реальные трассы: 6 штук, конвертация валидна и физически проходима', () => {
  assert.equal(REAL_COURSES.length, 6);
  for (const rc of REAL_COURSES) {
    const c = realToCourse(rc);
    assert.ok(c.obstacles.length >= 18, `${rc.name}: мало снарядов`);
    // Все точки в границах ринга
    for (const o of c.obstacles) {
      for (const p of [o.entry, o.exit]) {
        assert.ok(p.x >= -1 && p.x <= c.field.w + 1 && p.y >= -1 && p.y <= c.field.h + 1,
          `${rc.name} #${o.i}: точка вне ринга (${p.x.toFixed(1)},${p.y.toFixed(1)})`);
      }
    }
    // Дистанции между последовательными снарядами реалистичны (2–13 м)
    for (let i = 1; i < c.obstacles.length; i++) {
      const prev = c.obstacles[i - 1], cur = c.obstacles[i];
      const gap = Math.hypot(cur.entry.x - prev.exit.x, cur.entry.y - prev.exit.y);
      assert.ok(gap >= 0.5 && gap <= 14,
        `${rc.name}: переход ${prev.i}→${cur.i} нереален (${gap.toFixed(1)}м)`);
    }
    // Сплайн строится и имеет чемпионатную длину
    const p = new RPath(c.pathPoints);
    assert.ok(p.length > 100 && p.length < 350, `${rc.name}: длина пути ${p.length.toFixed(0)}м`);
    // Слалом ровно один на прохождение
    assert.equal(c.obstacles.filter(o => o.type === 'weave').length, 1, rc.name);
  }
});

test('реальные трассы: повторные снаряды дедуплицированы для рендера', () => {
  const c = realToCourse(REAL_COURSES[0]); // Nordic: 3/21, 4/18, 8/17 повторы
  const dups = c.obstacles.filter(o => o.skipGeom);
  assert.ok(dups.length >= 3, `ожидались повторы, найдено ${dups.length}`);
});

test('PS-style обманки: настоящая клавиша всегда среди опций, опции уникальны', async () => {
  const { makeDecoys, DECOY_CHANCE, DECOY_REVEAL } = await import('../js/qte.js');
  let x = 12345;
  const rand = () => { x = (x * 1103515245 + 12345) % 2 ** 31; return x / 2 ** 31; };
  for (let i = 0; i < 100; i++) {
    const d = makeDecoys('Space', 'masters', rand);
    assert.equal(d.options.length, 3);
    assert.ok(d.options.includes('Space'));
    assert.equal(new Set(d.options).size, 3);
    assert.ok(d.reveal > 0 && d.revealed === false);
  }
  assert.equal(DECOY_CHANCE.novice, 0);
  assert.ok(DECOY_REVEAL.masters < DECOY_REVEAL.open);
});

test('press: первое раннее нажатие прощается, второе — отказ', () => {
  const q = new Qte('jump');
  q.update(0.01);
  let evs = q.press('Space', 0.05); // сильно раньше окна
  assert.ok(evs.some(e => e.type === 'early'), 'нет события early');
  assert.equal(q.state, 'active');
  evs = q.press('Space', 0.06); // второй ранний — уже отказ
  assert.equal(q.result?.grade, 'miss');

  const q2 = new Qte('jump');
  q2.update(0.01);
  q2.press('Space', 0.05); // прощение
  q2.press('Space', q2.target); // затем идеально
  assert.equal(q2.result.grade, 'perfect');
});

test('прогрессия внутри Novice: variant добавляет слалом и горку', () => {
  const plain = generateCourse(1011 + 37 + 11, 'novice');
  assert.ok(!plain.obstacles.some(o => o.type === 'weave'), 'на 1-й трассе не должно быть слалома');
  const withWeave = generateCourse(1011 + 3 * 37 + 11, 'novice', { weave: true });
  assert.equal(withWeave.obstacles.filter(o => o.type === 'weave').length, 1);
  assert.deepEqual(validateCourse(withWeave), []);
  const withContact = generateCourse(1011 + 5 * 37 + 11, 'novice', { weave: true, contacts: 1 });
  assert.ok(withContact.obstacles.some(o => ['aframe', 'dogwalk', 'seesaw'].includes(o.type)));
  assert.deepEqual(validateCourse(withContact), []);
});

// ---- V2 Мета ----
const { earnFromRun, earnXp, xpToNext, streakMult, grantRosette, dogState, titleFor } =
  await import('../js/meta.js');
const { refreshQuests, applyRunToQuests, claimDone } = await import('../js/quests.js');
const { dailyShowcase, applyEquip, itemById } = await import('../js/cosmetics.js');

function freshMeta() {
  return { v: 1, bones: 0, rosettes: 0, firstClears: {}, medalPaid: {}, rosettePaid: {},
    dogs: {}, owned: {}, counters: {}, streak: { count: 0, last: '' },
    quests: { day: '', week: '', daily: [], weekly: [] } };
}

test('мета: косточки — медаль платится только за улучшение, firstClear однократный', () => {
  const m = freshMeta();
  const a = earnFromRun(m, { points: 1000, stars: 2, trackId: 't1', isDaily: false, todayStr: '10.07.2026' });
  assert.equal(a.bones, 11 + 5 + 10 + 30); // очки(/90) + 🥉+🥈 + первое прохождение
  const b = earnFromRun(m, { points: 1000, stars: 2, trackId: 't1', isDaily: false, todayStr: '10.07.2026' });
  assert.equal(b.bones, 11); // только очки
  const c = earnFromRun(m, { points: 1000, stars: 3, trackId: 't1', isDaily: false, todayStr: '10.07.2026' });
  assert.equal(c.bones, 11 + 20); // улучшение до золота
  const d5 = earnFromRun(m, { points: 900, stars: 0, trackId: 't1', isDaily: false, todayStr: '10.07.2026', runOfDay: 5 });
  assert.equal(d5.bones, 10 + 20); // бонус активности за 5-й прогон дня
});

test('мета: streak трассы дня растёт по дням и даёт множитель', () => {
  const m = freshMeta();
  earnFromRun(m, { points: 0, stars: 0, trackId: 'd1', isDaily: true, todayStr: '10.07.2026' });
  earnFromRun(m, { points: 0, stars: 0, trackId: 'd2', isDaily: true, todayStr: '11.07.2026' });
  earnFromRun(m, { points: 0, stars: 0, trackId: 'd3', isDaily: true, todayStr: '12.07.2026' });
  assert.ok(m.streak.count >= 3, `streak=${m.streak.count}`);
  assert.equal(streakMult(m.streak.count), 1.1);
  assert.equal(streakMult(30), 1.5);
});

test('мета: XP растит уровни, титулы по вехам, розетки один раз', () => {
  const m = freshMeta();
  const r = earnXp(m, 'border', { points: 3000, stars: 3, clean: true });
  assert.ok(r.gained === 300 + 75 + 50);
  assert.ok(dogState(m, 'border').level >= 2);
  assert.equal(titleFor(10), 'ADX');
  assert.equal(grantRosette(m, 'x', 2), 2);
  assert.equal(grantRosette(m, 'x', 2), 0); // повтор не платится
  assert.equal(m.rosettes, 2);
});

test('квесты: детерминированный выбор, прогресс и авто-клейм', () => {
  const m = freshMeta();
  refreshQuests(m, 'day-key-1', 20260710);
  assert.equal(m.quests.daily.length, 3);
  assert.equal(m.quests.weekly.length, 2);
  const ids1 = m.quests.daily.map(q => q.id).join(',');
  const m2 = freshMeta();
  refreshQuests(m2, 'day-key-1', 20260710);
  assert.equal(m2.quests.daily.map(q => q.id).join(','), ids1); // тот же сид — те же задания
  // Прогресс: событие run двигает соответствующие задания
  applyRunToQuests(m, { run: 1, perfect: 50, obstacle: 30, clean: 1, daily: 1, medal: 1, gold: 1, combo10: 1, tunnel: 10 });
  const before = m.bones;
  claimDone(m);
  assert.ok(m.bones >= before); // награды выданы (если что-то закрылось)
});

test('косметика: витрина дня детерминирована, applyEquip уважает породу и владение', () => {
  const a = dailyShowcase(20260710).join(',');
  assert.equal(dailyShowcase(20260710).join(','), a);
  assert.equal(dailyShowcase(20260710).length, 3);
  const breed = { id: 'border', body: '#111', chest: '#eee', ear: '#000' };
  const owned = { 'coat-border-red': 1, 'neck-bandana-red': 1 };
  const dressed = applyEquip(breed, { coat: 'coat-border-red', neck: 'neck-bandana-red' }, owned);
  assert.equal(dressed.body, itemById('coat-border-red').palette.body);
  assert.ok(dressed.neckItem);
  // Чужой окрас не применяется
  const wrong = applyEquip({ id: 'jack', body: '#f2ece0' }, { coat: 'coat-border-red' }, owned);
  assert.equal(wrong.body, '#f2ece0');
  // Не куплено — не применяется
  const notOwned = applyEquip(breed, { coat: 'coat-border-red' }, {});
  assert.equal(notOwned.body, '#111');
});

test('V4 способности: у каждой породы задан дар с описанием', async () => {
  const { BREEDS } = await import('../js/scoring.js');
  const abilities = new Set();
  for (const b of Object.values(BREEDS)) {
    assert.ok(b.ability, `${b.id}: есть ability`);
    assert.ok(b.abilityText && b.abilityText.length > 5, `${b.id}: есть описание дара`);
    abilities.add(b.ability);
  }
  assert.equal(abilities.size, 5, 'все дары уникальны');
});

test('V4 late-commit: riskScale сжимает окно QTE', () => {
  const normal = new Qte('jump');
  const risky = new Qte('jump', { riskScale: 0.35 });
  assert.ok(Math.abs(risky.w - normal.w * 0.35) < 1e-9);
  // Perfect в риске возможен только у самой цели
  risky.update(0.01);
  risky.press('Space', risky.target);
  assert.equal(risky.result.grade, 'perfect');
});

test('V4 finalScore: bonus добавляется к очкам (Golden Weave, риск)', async () => {
  const { finalScore } = await import('../js/scoring.js');
  const base = finalScore({ time: 30, sct: 40, faults: 0, perfects: 10, total: 12, maxCombo: 8 });
  const bonused = finalScore({ time: 30, sct: 40, faults: 0, perfects: 10, total: 12, maxCombo: 8, bonus: 1500 });
  assert.equal(bonused.points - base.points, 1500);
});

test('V4 карьера 2.0: боссы, сезоны, реплики, газеты', async () => {
  const { BOSSES, SEASONS, pickLine, startLineFor, newspaperFor, bossFor, LINES } =
    await import('../js/career.js');
  // Боссы: 4 класса, k строго убывает; поздние — быстрее SCT (< 1)
  const ks = ['novice', 'open', 'excellent', 'masters'].map(c => BOSSES[c].k);
  assert.deepEqual(ks, [1.18, 0.95, 0.88, 0.86]);
  for (let i = 1; i < ks.length; i++) assert.ok(ks[i] < ks[i - 1], 'k строго убывает');
  for (const cls of Object.keys(BOSSES)) {
    assert.ok(BOSSES[cls].name && BOSSES[cls].intro && BOSSES[cls].taunt);
    assert.ok(SEASONS[cls], `сезон для ${cls}`);
  }
  assert.ok(SEASONS.worldcup);
  assert.equal(bossFor('worldcup'), null);
  // Банк реплик: суммарно достаточно строк, pickLine ротирует без повторов подряд
  const total = Object.values(LINES).reduce((s, arr) => s + arr.length, 0);
  assert.ok(total >= 30, `реплик: ${total}`);
  const a = pickLine('fault'), b = pickLine('fault');
  assert.notEqual(a, b, 'ротация фраз');
  assert.ok(startLineFor('career', 'novice'));
  assert.ok(startLineFor('worldcup', 'masters'));
  // Газета: заголовок для каждого босса, подстановка имени и дельты
  for (const cls of Object.keys(BOSSES)) {
    const p = newspaperFor(BOSSES[cls], 'Хлоя', 30, 31.5);
    assert.ok(p.title && p.sub.includes('Хлоя'), `${cls}: газета`);
  }
});

test('каталог косметики валиден: id уникальны, слоты/редкости известны, окрасы полны', async () => {
  const { ITEMS, RARITY, SLOT_NAMES } = await import('../js/cosmetics.js');
  const { BREEDS } = await import('../js/scoring.js');
  const ids = new Set();
  for (const it of ITEMS) {
    assert.ok(!ids.has(it.id), `дубль id ${it.id}`);
    ids.add(it.id);
    assert.ok(RARITY[it.rarity], `${it.id}: редкость ${it.rarity}`);
    assert.ok(SLOT_NAMES[it.slot], `${it.id}: слот ${it.slot}`);
    if (it.slot === 'coat') {
      assert.ok(it.palette && it.palette.body, `${it.id}: у окраса есть palette.body`);
      if (it.breed) assert.ok(BREEDS[it.breed], `${it.id}: порода ${it.breed} существует`);
    }
  }
  // Не-мерльные окрасы аусси гасят мерль базы (merle: null перекрывает spread)
  const chloe = BREEDS.aussie;
  assert.ok(chloe.merle, 'база Хлои — мерль');
  const redtri = applyEquip({ ...chloe }, { coat: 'coat-aussie-redtri' }, { 'coat-aussie-redtri': 1 });
  assert.equal(redtri.merle, null);
  assert.ok(redtri.tan, 'у ред-три есть подпал');
  const blackbi = applyEquip({ ...chloe }, { coat: 'coat-aussie-blackbi' }, { 'coat-aussie-blackbi': 1 });
  assert.equal(blackbi.merle, null);
  assert.equal(blackbi.tan, null);
});

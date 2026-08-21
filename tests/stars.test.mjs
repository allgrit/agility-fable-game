// S4.7 «звёзды Punch-Out»: node --test tests/stars.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCourse } from '../js/course.js';
import {
  MAX_STARS, STAR_FINISH_MULT, FINISH_GRADE_WEIGHT,
  pickSignature, createStars, starFinishBonus,
} from '../js/stars.js';

// Мини-трасса нужной длины с полем seed — для проверки коротких трасс.
function fakeCourse(seed, types) {
  return { seed, obstacles: types.map((type, i) => ({ i: i + 1, type })) };
}

test('константы: 3 звезды, финиш ×2', () => {
  assert.equal(MAX_STARS, 3);
  assert.equal(STAR_FINISH_MULT, 2);
  assert.equal(FINISH_GRADE_WEIGHT.perfect, 1);
  assert.equal(FINISH_GRADE_WEIGHT.miss, 0);
});

test('pickSignature: детерминизм на одном сиде', () => {
  const a = generateCourse(42, 'open');
  const b = generateCourse(42, 'open');
  assert.deepEqual(pickSignature(a), pickSignature(b));
  // повторный вызов на том же объекте — тот же результат
  assert.deepEqual(pickSignature(a), pickSignature(a));
});

test('pickSignature: разные сиды дают разные наборы (хотя бы иногда)', () => {
  const sets = new Set();
  for (let seed = 1; seed <= 30; seed++) {
    sets.add(pickSignature(generateCourse(seed, 'open')).join(','));
  }
  assert.ok(sets.size > 1, `все 30 сидов дали один набор: ${[...sets]}`);
});

test('pickSignature: не первый, не последний, в границах, без дублей, отсортирован', () => {
  for (const cls of ['novice', 'open', 'excellent', 'masters']) {
    for (let seed = 1; seed <= 25; seed++) {
      const c = generateCourse(seed, cls);
      const sig = pickSignature(c);
      const last = c.obstacles.length - 1;
      assert.equal(sig.length, MAX_STARS, `${cls}/${seed}: ${sig}`);
      assert.equal(new Set(sig).size, sig.length, `дубли: ${sig}`);
      assert.deepEqual(sig, [...sig].sort((x, y) => x - y), `не отсортирован: ${sig}`);
      for (const idx of sig) {
        assert.ok(Number.isInteger(idx), `не целое: ${idx}`);
        assert.ok(idx > 0 && idx < last, `${cls}/${seed}: idx=${idx}, last=${last}`);
      }
    }
  }
});

test('pickSignature: коронные снаряды по возможности разнотипны и распределены', () => {
  let diverse = 0, spread = 0, n = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const c = generateCourse(seed, 'excellent');
    const sig = pickSignature(c);
    const types = sig.map(i => c.obstacles[i].type);
    if (new Set(types).size === types.length) diverse++;
    // ни один соседний коронный не стоит вплотную к другому
    if (sig.every((v, i) => i === 0 || v - sig[i - 1] >= 2)) spread++;
    n++;
  }
  assert.ok(diverse / n >= 0.7, `разнотипность всего ${diverse}/${n}`);
  assert.ok(spread / n >= 0.9, `распределение всего ${spread}/${n}`);
});

test('pickSignature: короткие трассы не роняют модуль', () => {
  assert.deepEqual(pickSignature(fakeCourse(1, [])), []);
  assert.deepEqual(pickSignature(fakeCourse(1, ['jump'])), []);
  assert.deepEqual(pickSignature(fakeCourse(1, ['jump', 'jump'])), []);
  // разминка на 3 снаряда: доступен ровно один коронный — средний
  assert.deepEqual(pickSignature(fakeCourse(1, ['jump', 'tunnel', 'jump'])), [1]);
  const four = pickSignature(fakeCourse(7, ['jump', 'tunnel', 'weave', 'jump']));
  assert.equal(four.length, 2);
  assert.ok(four.every(i => i > 0 && i < 3));
  // без course вообще
  assert.deepEqual(pickSignature(null), []);
  assert.deepEqual(pickSignature({}), []);
});

test('createStars: perfect на коронном даёт звезду, на обычном — нет', () => {
  const c = generateCourse(42, 'open');
  const st = createStars(c);
  const sig = st.signature[0];
  const plain = [...Array(c.obstacles.length).keys()].find(i => !st.isSignature(i) && i > 0);

  assert.equal(st.count, 0);
  const r1 = st.onResult(plain, 'perfect');
  assert.equal(r1.gained, 0);
  assert.equal(r1.signature, false);
  assert.equal(st.count, 0);

  const r2 = st.onResult(sig, 'perfect');
  assert.equal(r2.gained, 1);
  assert.equal(r2.signature, true);
  assert.equal(r2.count, 1);
  assert.equal(st.count, 1);
});

test('createStars: good/late на коронном не копят и не жгут', () => {
  const c = generateCourse(42, 'open');
  const st = createStars(c);
  st.onResult(st.signature[0], 'perfect');
  for (const g of ['good', 'late']) {
    const r = st.onResult(st.signature[1], g);
    assert.equal(r.gained, 0);
    assert.equal(r.burned, 0);
    assert.equal(st.count, 1);
  }
});

test('createStars: кап MAX_STARS не превышается', () => {
  const c = generateCourse(42, 'open');
  const st = createStars(c);
  for (const idx of st.signature) st.onResult(idx, 'perfect');
  assert.equal(st.count, MAX_STARS);
  // повторный perfect на коронном сверх капа ничего не добавляет
  const r = st.onResult(st.signature[0], 'perfect');
  assert.equal(r.gained, 0);
  assert.equal(r.capped, true);
  assert.equal(st.count, MAX_STARS);
});

test('createStars: miss сжигает все накопленные звёзды', () => {
  const c = generateCourse(42, 'open');
  const st = createStars(c);
  st.onResult(st.signature[0], 'perfect');
  st.onResult(st.signature[1], 'perfect');
  assert.equal(st.count, 2);
  const plain = [...Array(c.obstacles.length).keys()].find(i => !st.isSignature(i) && i > 0);
  const r = st.onResult(plain, 'miss');
  assert.equal(r.burned, 2);
  assert.equal(r.count, 0);
  assert.equal(st.count, 0);
  // промах на пустом счётчике — burned 0
  assert.equal(st.onResult(plain, 'miss').burned, 0);
});

test('createStars: режим burnMode=one сжигает одну звезду', () => {
  const c = generateCourse(42, 'open');
  const st = createStars(c, { burnMode: 'one' });
  st.onResult(st.signature[0], 'perfect');
  st.onResult(st.signature[1], 'perfect');
  const r = st.onResult(0, 'miss');
  assert.equal(r.burned, 1);
  assert.equal(st.count, 1);
});

test('Star Finish: со звёздами ×2, звёзды списываются', () => {
  const c = generateCourse(42, 'open');
  const st = createStars(c);
  assert.equal(st.isFinishArmed(), false);
  for (const idx of st.signature) st.onResult(idx, 'perfect');
  assert.equal(st.armFinish(), true);
  assert.equal(st.isFinishArmed(), true);

  const res = st.spendOnFinish('perfect');
  assert.equal(res.multiplier, STAR_FINISH_MULT);
  assert.equal(res.starsSpent, MAX_STARS);
  assert.ok(res.bonus > 0);
  assert.equal(st.count, 0);
  assert.equal(st.isFinishArmed(), false);
  // повторный вызов ничего не удваивает
  const again = st.spendOnFinish('perfect');
  assert.equal(again.multiplier, 1);
  assert.equal(again.bonus, 0);
});

test('Star Finish: без звёзд ×1 и нулевой бонус', () => {
  const c = generateCourse(42, 'open');
  const st = createStars(c);
  assert.equal(st.armFinish(), false);
  const res = st.spendOnFinish('perfect');
  assert.equal(res.multiplier, 1);
  assert.equal(res.starsSpent, 0);
  assert.equal(res.bonus, 0);
});

test('Star Finish: промах на последнем снаряде не удваивает и жжёт звёзды', () => {
  const c = generateCourse(42, 'open');
  const st = createStars(c);
  for (const idx of st.signature) st.onResult(idx, 'perfect');
  const res = st.spendOnFinish('miss');
  assert.equal(res.multiplier, 1);
  assert.equal(res.bonus, 0);
  assert.equal(res.burned, MAX_STARS);
  assert.equal(st.count, 0);
});

test('Star Finish: бонус растёт со звёздами и падает с качеством нажатия', () => {
  const c = generateCourse(42, 'open');
  const mk = (stars, grade) => {
    const st = createStars(c);
    for (let k = 0; k < stars; k++) st.onResult(st.signature[k], 'perfect');
    return st.spendOnFinish(grade).bonus;
  };
  assert.ok(mk(3, 'perfect') > mk(2, 'perfect'));
  assert.ok(mk(2, 'perfect') > mk(1, 'perfect'));
  assert.ok(mk(3, 'perfect') > mk(3, 'good'));
  assert.ok(mk(3, 'good') > mk(3, 'late'));
  // якорь баланса: 1 звезда + perfect ≈ цена риска ×2 на снаряде (120 очков)
  const one = mk(1, 'perfect');
  assert.ok(one >= 90 && one <= 160, `bonus=${one}`);
  // чистая функция бонуса согласована с методом
  assert.equal(mk(3, 'perfect'), starFinishBonus(3, 'perfect', c.obstacles.length));
});

test('createStars: finishIndex — последний снаряд, reset обнуляет', () => {
  const c = generateCourse(42, 'open');
  const st = createStars(c);
  assert.equal(st.finishIndex, c.obstacles.length - 1);
  st.onResult(st.signature[0], 'perfect');
  st.reset();
  assert.equal(st.count, 0);
  assert.equal(st.isFinishArmed(), false);
});

test('createStars: короткая трасса без коронных работает без исключений', () => {
  const st = createStars(fakeCourse(3, ['jump', 'jump']));
  assert.deepEqual(st.signature, []);
  assert.equal(st.isSignature(0), false);
  assert.equal(st.onResult(0, 'perfect').gained, 0);
  assert.equal(st.armFinish(), false);
  assert.equal(st.spendOnFinish('perfect').multiplier, 1);
});

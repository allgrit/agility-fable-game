// Судейство: SCT, фолты, звёзды, титулы. Чистая логика.

export const BREEDS = {
  border: {
    id: 'border', name: 'Бордер-колли', desc: 'Молния. Узкое окно реакции.',
    speedMul: 1.15, windowScale: 0.85, comboRate: 1.0,
    body: '#2b2b30', chest: '#f5f0e8', ear: '#1c1c20', size: 1.0,
  },
  sheltie: {
    id: 'sheltie', name: 'Шелти', desc: 'Точность и стиль. Широкое окно реакции.',
    speedMul: 0.95, windowScale: 1.2, comboRate: 1.0,
    body: '#a86a32', chest: '#f7efdd', ear: '#7a4a20', size: 0.82,
  },
  jack: {
    id: 'jack', name: 'Джек-рассел', desc: 'Заводной моторчик. Комбо растёт быстрее.',
    speedMul: 0.9, windowScale: 1.0, comboRate: 1.6,
    body: '#f2ece0', chest: '#ffffff', ear: '#c07830', size: 0.7,
  },
  aussie: {
    id: 'aussie', name: 'Хлоя', desc: 'Та самая аусси! Игра посвящена ей 💙',
    speedMul: 1.08, windowScale: 1.05, comboRate: 1.15,
    body: '#9aa3ad', chest: '#f7f5f0', ear: '#2e3238', size: 0.95,
    merle: '#3a3f46', tan: '#c98a4b', eye: '#8fd8ff', legs: '#e8e2d6',
  },
  poodle: {
    id: 'poodle', name: 'Той-пудель', desc: 'Кудрявый шоколадный чемпион. Широкое окно и комбо!',
    speedMul: 0.95, windowScale: 1.15, comboRate: 1.4,
    body: '#5d3a24', chest: '#6f4830', ear: '#4a2d1a', size: 0.68,
    curly: '#6f4830', unlockAch: 'golden-paw',
  },
};

export function computeSct(pathLength, cls, sctSpeed) {
  // SCT = длина трассы / судейская скорость, округление вверх до секунды.
  return Math.ceil(pathLength / sctSpeed);
}

export function timeFaults(timeSec, sct) {
  return Math.max(0, Math.ceil(timeSec - sct));
}

export function finalScore({ time, sct, faults, perfects, total, maxCombo }) {
  const tf = timeFaults(time, sct);
  const totalFaults = faults + tf;
  const clean = faults === 0 && tf === 0;
  // Квалификация для прогрессии мягче титула Q: как Novice-судейство (<=5 faults).
  const qualified = totalFaults <= 5;
  let stars = 0;
  if (totalFaults === 0) stars = perfects >= total * 0.7 ? 3 : 2;
  else if (totalFaults <= 5) stars = 1;
  const title = clean
    ? (perfects === total ? 'БЕЗУПРЕЧНО! Q + Перфект!' : 'ЧИСТЫЙ ПРОГОН! Квалификация «Q»!')
    : totalFaults <= 5 ? 'Хороший прогон' : totalFaults <= 15 ? 'Есть над чем работать' : 'Тренируемся дальше!';
  const points = Math.max(0, Math.round(
    1000 * (total ? perfects / total : 0) + maxCombo * 50 + Math.max(0, sct - time) * 20 - totalFaults * 30
  ));
  return { timeFaults: tf, totalFaults, clean, qualified, stars, title, points };
}

export const CLASS_ORDER = ['novice', 'open', 'excellent', 'masters'];

export function nextClass(cls) {
  const i = CLASS_ORDER.indexOf(cls);
  return CLASS_ORDER[Math.min(i + 1, CLASS_ORDER.length - 1)];
}

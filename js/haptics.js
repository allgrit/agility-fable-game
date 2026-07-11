// Тактильная отдача (navigator.vibrate). Интенсивность = значимость события,
// всегда в связке со звуком/визуалом. iOS Safari не поддерживает — молча no-op.
// Настройка вкл/выкл в settings; main.js вызывает setHapticsEnabled().

let enabled = true;
const supported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

export function setHapticsEnabled(v) { enabled = !!v; }

const PATTERNS = {
  perfect: [12],
  good:    [8],
  fault:   [22, 40, 22],   // двойной — «ошибка»
  land:    [16],
  finish:  [30, 50, 30, 50, 60], // туш на финиш
  golden:  [10, 30, 10, 30, 10, 30, 40],
};

export function haptic(kind) {
  if (!enabled || !supported) return;
  const p = PATTERNS[kind];
  if (p) { try { navigator.vibrate(p); } catch {} }
}

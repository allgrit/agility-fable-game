// Тихая автокалибровка аудио-задержки по хитам слалома (NecroDancer/BPM).
// Копим знаковые дельты попаданий; когда набралось ≥8, берём скользящую медиану
// последних 12 и, если систематический сдвиг >25мс, подмешиваем 50% в offset.
// Чистая логика — тестируется без DOM.

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// state: { offset (сек), hits: number[] }. deltas — новые знаковые дельты (сек).
// Возвращает новый state с, возможно, скорректированным offset.
export function updateCalibration(state, deltas) {
  const hits = [...(state.hits || []), ...deltas].slice(-12);
  let offset = state.offset || 0;
  if (hits.length >= 8) {
    const m = median(hits);
    if (Math.abs(m) > 0.025) {
      offset += m * 0.5;                       // подмешиваем половину систематического сдвига
      offset = Math.max(-0.25, Math.min(0.25, offset));
      return { offset, hits: [] };             // сброс окна после коррекции
    }
  }
  return { offset, hits };
}

export { median as _median };

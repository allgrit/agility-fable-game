// Тестовый автопилот: идеальная игра через хук window.__agility.
// Использование: вставить в консоль браузера (или page.evaluate в Playwright),
// затем window.__autopilot.start('open', 9) — класс и seed.
(function () {
  let timer = null;
  function tick() {
    const A = window.__agility;
    const run = A.app.run;
    if (!run || run.phase !== 'running') return;
    const m = run.activeMark;
    if (!m || !m.qte || m.qte.state !== 'active') return;
    const q = m.qte, t = run.time - m.qteStart, d = q.def;
    if (d.kind === 'press') {
      if (t >= q.target - 0.02) run.input(d.key, true);
    } else if (d.kind === 'rhythm') {
      if (q.beatIdx < d.beats && t >= q.target + q.beatIdx * d.beat - 0.02) {
        run.input(d.keys[q.beatIdx % 2], true);
      }
    } else if (d.kind === 'holdRelease') {
      if (!q.holding && q.holdStart == null && t >= q.target - 0.02) run.input(d.key, true);
      else if (q.holding && q.progress >= (d.zone[0] + d.zone[1]) / 2) run.input(d.key, false);
    } else if (d.kind === 'twoStage') {
      if (q.stage === 0 && t >= q.target - 0.02) run.input(d.key, true);
      else if (q.stage === 1 && (t - q.tipAt) >= d.tipDelay - 0.02) run.input(d.key2, true);
    } else if (d.kind === 'hold') {
      if (!q.holding && q.holdStart == null && t >= q.target - 0.02) run.input(d.key, true);
    } else if (d.kind === 'groove') {
      if (q.nextBeatT !== null && q.beatIdx < d.beats && t >= q.nextBeatT - 0.01) run.input(d.keys[q.beatIdx % 2], true);
    } else if (d.kind === 'serp') {
      if (q.beatIdx < d.count && t >= q.target + q.beatIdx * d.beat - 0.02) run.input(q.seq[q.beatIdx], true);
    } else if (d.kind === 'charge') {
      if (!q.holding && q.holdStart == null && t >= q.target - 0.02) run.input(d.key, true);
      else if (q.holding && q.progress >= (d.zone[0] + d.zone[1]) / 2) run.input(d.key, false);
    } else if (d.kind === 'freeze') {
      if (q.stage === 0 && t >= q.target - 0.02) run.input(d.key, true);
      else if (q.stage === 2 && (t - q.goAt) >= d.goWindow * 0.25 - 0.01) run.input(d.key, true);
    } else if (d.kind === 'doubleTap') {
      if (q.stage === 0 && t >= q.target - 0.02) run.input(d.key, true);
      else if (q.stage === 1 && t >= q.tapAt + (q.apexDelay ?? d.apexDelay) - 0.01) run.input(d.key, true);
    }
  }
  window.__autopilot = {
    start(cls, seed, mode) {
      const A = window.__agility;
      if (mode) A.setMode(mode);
      if (cls) A.setClass(cls);
      if (seed != null) A.setSeed(seed);
      A.startRun();
      if (timer) clearInterval(timer);
      timer = setInterval(tick, 16);
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    async waitFinish() {
      const A = window.__agility;
      await new Promise(res => {
        const iv = setInterval(() => {
          if (A.getState().phase === 'finished') { clearInterval(iv); res(); }
        }, 100);
      });
      return { score: A.app.run.score, sct: A.app.run.sct, time: A.app.run.time };
    },
  };
})();

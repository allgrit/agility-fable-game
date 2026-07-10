# temp patch: остаток V2 — интеграция
import io

# ---- game.js: рубашка хендлера + пресет hearts + запись перфект-финиша ----
p = 'js/game.js'
s = io.open(p, encoding='utf-8').read()
old = "    this.handler = { x: course.start.x - 1.5, y: course.start.y + 2, runPhase: 0, speed: 0, facing: 1, commanding: false, speech: null };"
new = "    this.handler = { x: course.start.x - 1.5, y: course.start.y + 2, runPhase: 0, speed: 0, facing: 1, commanding: false, speech: null, shirt: breed.handlerShirt || null };"
assert s.count(old) == 1
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8').write(s)

# ---- render.js: цвет рубашки хендлера ----
p = 'js/render.js'
s = io.open(p, encoding='utf-8').read()
old = """    // Корпус
    ctx.fillStyle = '#e05561';
    ctx.beginPath();
    ctx.roundRect(-6, -8, 12, 17, 5);
    ctx.fill();
    // Руки (жестикуляция при команде)
    ctx.strokeStyle = '#e05561'; ctx.lineWidth = 3.6;"""
new = """    // Корпус (цвет формы — из экипировки)
    const shirt = h.shirt || '#e05561';
    ctx.fillStyle = shirt;
    ctx.beginPath();
    ctx.roundRect(-6, -8, 12, 17, 5);
    ctx.fill();
    // Руки (жестикуляция при команде)
    ctx.strokeStyle = shirt; ctx.lineWidth = 3.6;"""
assert s.count(old) == 1
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8').write(s)

# ---- particles.js: пресет hearts ----
p = 'js/particles.js'
s = io.open(p, encoding='utf-8').read()
old = "    if (preset === 'golden') colors = ['#ffd54a', '#f4c430', '#fff3b0', '#c9a227'];"
new = """    if (preset === 'golden') colors = ['#ffd54a', '#f4c430', '#fff3b0', '#c9a227'];
    if (preset === 'hearts') colors = ['#f06292', '#e91e63', '#f8bbd0', '#ff8a80'];"""
assert s.count(old) == 1
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8').write(s)

# ---- main.js ----
p = 'js/main.js'
s = io.open(p, encoding='utf-8').read()

# 1) Тема ринга из экипировки
old = """  const dressed = applyEquip(breed, dogState(meta, breed.id).equip, meta.owned);
  app.run = new Run({ course, breed: dressed, audio, particles: fx, renderer,
    modifier: activeModifier(), windowMul: mod.windowMul || 1 });"""
new = """  const dressed = applyEquip(breed, dogState(meta, breed.id).equip, meta.owned);
  if (dressed.ringTheme) renderer.theme = dressed.ringTheme;
  app.run = new Run({ course, breed: dressed, audio, particles: fx, renderer,
    modifier: activeModifier(), windowMul: mod.windowMul || 1 });"""
assert s.count(old) == 1
s = s.replace(old, new)

# 2) checkAchievements: передаём meta и medals
old = """      const newly = checkAchievements({
        run, result: app.result, mode: app.mode, cls: app.cls, goldCount: medalCounts()[3],
      });"""
new = """      const newly = checkAchievements({
        run, result: app.result, mode: app.mode, cls: app.cls, goldCount: medalCounts()[3],
        meta, medals: loadMedals(),
      });"""
assert s.count(old) == 1
s = s.replace(old, new)

# 3) Компактная сетка 36 достижений на экране трофеев
old = """  const ach = loadAch();
  const cols = isPortrait() ? 2 : 5;
  const cellW = (pw - 40 * z) / cols;
  const startY = py + ph - 26 * z - Math.ceil(ACHIEVEMENTS.length / cols) * 34 * z - 16 * z;"""
new = """  const ach = loadAch();
  const cols = isPortrait() ? 3 : 6;
  const cellW = (pw - 40 * z) / cols;
  const startY = py + ph - 26 * z - Math.ceil(ACHIEVEMENTS.length / cols) * 26 * z - 12 * z;"""
assert s.count(old) == 1
s = s.replace(old, new)
old = """  ACHIEVEMENTS.forEach((a, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const ax = px + 24 * z + col * cellW;
    const ay = startY + row * 34 * z;
    const got = !!ach[a.id];
    ctx.globalAlpha = got ? 1 : 0.35;
    ctx.font = `${Math.round(17 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.fillText(got ? a.icon : '🔒', ax, ay);
    ctx.fillStyle = got ? '#ffe9a8' : 'rgba(255,255,255,0.6)';
    ctx.font = `${Math.round(11 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(a.name, ax + 24 * z, ay - 4 * z);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = `${Math.round(9 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(a.desc.slice(0, 30), ax + 24 * z, ay + 8 * z);
  });"""
new = """  ACHIEVEMENTS.forEach((a, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const ax = px + 24 * z + col * cellW;
    const ay = startY + row * 26 * z;
    const got = !!ach[a.id];
    ctx.globalAlpha = got ? 1 : 0.32;
    ctx.font = `${Math.round(14 * z)}px "Segoe UI", sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.fillText(got ? a.icon : '🔒', ax, ay);
    ctx.fillStyle = got ? '#ffe9a8' : 'rgba(255,255,255,0.6)';
    ctx.font = `${Math.round(10 * z)}px "Segoe UI", sans-serif`;
    ctx.fillText(a.name.slice(0, 20), ax + 20 * z, ay);
  });
  // Ранг хендлера: сумма уровней всех собак
  const sumLv = Object.values(meta.dogs).reduce((acc, d) => acc + (d.level || 1), 0);
  const rank = sumLv >= 50 ? 'Легенда ринга' : sumLv >= 25 ? 'Судья FCI' : sumLv >= 10 ? 'Инструктор' : 'Новичок';
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8fd8ff';
  ctx.font = `bold ${Math.round(13 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(`Ранг хендлера: ${rank} (Σ уровней ${sumLv})`, w / 2, startY - 10 * z);"""
assert s.count(old) == 1
s = s.replace(old, new)

# 4) Календарь streak на экране заданий
old = """  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffe9a8';
  ctx.font = `${Math.round(14 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(`Все 3 дневных = +50 🦴 бонусом · Баланс: 🦴 ${meta.bones} · 🏵️ ${meta.rosettes}`, w / 2, py + ph - 44 * z);"""
new = """  // Календарь трассы дня: 30 клеток, заполненные — дни серии
  const calY = py + 358 * z;
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `${Math.round(13 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(`СЕРИЯ ТРАССЫ ДНЯ: ${meta.streak.count} дн (множитель ×${streakMult(meta.streak.count)})`, px + 28 * z, calY - 12 * z);
  const days = meta.streak.days || [];
  for (let i = 0; i < 30; i++) {
    const cxq = px + 28 * z + (i % 15) * 18 * z;
    const cyq = calY + Math.floor(i / 15) * 18 * z;
    const filled = i < Math.min(30, meta.streak.count);
    ctx.beginPath();
    ctx.fillStyle = filled ? '#ffd54a' : 'rgba(255,255,255,0.15)';
    ctx.arc(cxq, cyq, 6 * z, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffe9a8';
  ctx.font = `${Math.round(14 * z)}px "Segoe UI", sans-serif`;
  ctx.fillText(`Все 3 дневных = +50 🦴 бонусом · Баланс: 🦴 ${meta.bones} · 🏵️ ${meta.rosettes}`, w / 2, py + ph - 44 * z);"""
assert s.count(old) == 1
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8').write(s)
print('ok')

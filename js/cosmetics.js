// Каталог косметики: всё процедурное, без арт-ассетов. Редкости и цены —
// только за игровую валюту, весь каталог виден всегда (без гачи).
// Слоты экипировки: coat (окрас), neck (шея), paws (следы), finish (эффект финиша).

export const RARITY = {
  common:    { name: 'Обычный',     bones: 150 },
  rare:      { name: 'Редкий',      bones: 500 },
  epic:      { name: 'Эпический',   bones: 1500, rosettes: 4 },
  legendary: { name: 'Легендарный', rosettes: 10 },
};

// Окрасы: подмена палитры конкретной породы (breed-specific)
export const ITEMS = [
  // --- Окрасы (slot: coat) ---
  { id: 'coat-border-red', slot: 'coat', breed: 'border', name: 'Рыжий бордер', rarity: 'rare',
    palette: { body: '#8a4a1f', chest: '#f5f0e8', ear: '#6b3714' } },
  { id: 'coat-border-blue', slot: 'coat', breed: 'border', name: 'Блю-мерль бордер', rarity: 'epic',
    palette: { body: '#8f99a8', chest: '#f5f0e8', ear: '#2e3238', merle: '#3a3f46' } },
  { id: 'coat-sheltie-bi', slot: 'coat', breed: 'sheltie', name: 'Би-блэк шелти', rarity: 'rare',
    palette: { body: '#26262c', chest: '#ffffff', ear: '#17171c' } },
  { id: 'coat-jack-tri', slot: 'coat', breed: 'jack', name: 'Триколор джек', rarity: 'rare',
    palette: { body: '#f2ece0', chest: '#ffffff', ear: '#2b2b30', tan: '#c07830' } },
  { id: 'coat-aussie-red', slot: 'coat', breed: 'aussie', name: 'Ред-мерль Хлоя', rarity: 'epic',
    palette: { body: '#b3907a', chest: '#f7f5f0', ear: '#7a4a30', merle: '#7a4a30', tan: '#c98a4b' } },
  { id: 'coat-poodle-white', slot: 'coat', breed: 'poodle', name: 'Белый пудель', rarity: 'epic',
    palette: { body: '#efe9df', chest: '#f7f3ea', ear: '#ddd2c2', curly: '#f7f3ea' } },
  { id: 'coat-gold', slot: 'coat', breed: null, name: 'Золотой чемпион', rarity: 'legendary',
    palette: { body: '#c9a227', chest: '#f4e3a1', ear: '#9a7a1a' } },

  // --- Шея (slot: neck) ---
  { id: 'neck-bandana-red', slot: 'neck', name: 'Красная бандана', rarity: 'common',
    neck: { kind: 'bandana', color: '#d84343' } },
  { id: 'neck-bandana-blue', slot: 'neck', name: 'Синяя бандана', rarity: 'common',
    neck: { kind: 'bandana', color: '#3b6fd4' } },
  { id: 'neck-collar-gold', slot: 'neck', name: 'Золотой ошейник', rarity: 'rare',
    neck: { kind: 'collar', color: '#ffd54a' } },
  { id: 'neck-scarf-rainbow', slot: 'neck', name: 'Радужный платок', rarity: 'epic',
    neck: { kind: 'bandana', color: 'rainbow' } },

  // --- Следы лап (slot: paws) ---
  { id: 'paws-gold', slot: 'paws', name: 'Золотые следы', rarity: 'common', paws: '#c9a227' },
  { id: 'paws-blue', slot: 'paws', name: 'Голубые следы', rarity: 'common', paws: '#4fc3f7' },
  { id: 'paws-rainbow', slot: 'paws', name: 'Радужные следы', rarity: 'epic', paws: 'rainbow' },

  // --- Эффект финиша (slot: finish) ---
  { id: 'finish-fireworks', slot: 'finish', name: 'Фейерверк', rarity: 'rare', finish: 'fireworks' },
  { id: 'finish-golden', slot: 'finish', name: 'Золотой дождь', rarity: 'epic', finish: 'golden' },
];

export const SLOT_NAMES = { coat: 'Окрас', neck: 'Шея', paws: 'Следы', finish: 'Финиш' };

export function itemById(id) { return ITEMS.find(i => i.id === id); }

export function priceOf(item) {
  const r = RARITY[item.rarity];
  return r.rosettes && !r.bones ? { rosettes: r.rosettes } : { bones: r.bones, rosettes: r.rosettes };
}

// Витрина дня: 3 предмета со скидкой 30% по сиду даты
export function dailyShowcase(dateNum) {
  const ids = [];
  let s = dateNum;
  const pool = [...ITEMS];
  for (let k = 0; k < 3 && pool.length; k++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    ids.push(pool.splice(s % pool.length, 1)[0].id);
  }
  return ids;
}

// Применение экипировки к рендер-описанию породы
export function applyEquip(breed, equip, owned) {
  if (!equip) return breed;
  let b = breed;
  const coat = equip.coat && owned[equip.coat] && itemById(equip.coat);
  if (coat && (!coat.breed || coat.breed === breed.id)) {
    b = { ...b, ...coat.palette };
  }
  const neck = equip.neck && owned[equip.neck] && itemById(equip.neck);
  if (neck) b = { ...b, neckItem: neck.neck };
  const paws = equip.paws && owned[equip.paws] && itemById(equip.paws);
  if (paws) b = { ...b, pawColor: paws.paws };
  const fin = equip.finish && owned[equip.finish] && itemById(equip.finish);
  if (fin) b = { ...b, finishFx: fin.finish };
  return b;
}

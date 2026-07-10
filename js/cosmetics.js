// Каталог косметики: всё процедурное, без арт-ассетов. Редкости и цены —
// только за игровую валюту, весь каталог виден всегда (без гачи).
// Слоты экипировки: coat (окрас), neck (шея), paws (следы), finish (эффект финиша).

export const RARITY = {
  common:    { name: 'Обычный',     bones: 150 },
  rare:      { name: 'Редкий',      bones: 500 },
  epic:      { name: 'Эпический',   bones: 1500, rosettes: 2 },
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

  // --- Волна 2 каталога ---
  { id: 'coat-border-tri', slot: 'coat', breed: 'border', name: 'Триколор бордер', rarity: 'common',
    palette: { body: '#2b2b30', chest: '#f5f0e8', ear: '#1c1c20', tan: '#b5763a' } },
  { id: 'coat-sheltie-merle', slot: 'coat', breed: 'sheltie', name: 'Блю-мерль шелти', rarity: 'epic',
    palette: { body: '#9aa3ad', chest: '#f7f5f0', ear: '#2e3238', merle: '#3a3f46' } },
  { id: 'coat-jack-lemon', slot: 'coat', breed: 'jack', name: 'Лимонный джек', rarity: 'common',
    palette: { body: '#f5eccb', chest: '#ffffff', ear: '#e0c26a' } },
  { id: 'coat-aussie-black', slot: 'coat', breed: 'aussie', name: 'Блэк-три Хлоя', rarity: 'rare',
    palette: { body: '#26262c', chest: '#f7f5f0', ear: '#17171c', merle: '#101014', tan: '#c98a4b' } },
  { id: 'coat-poodle-apricot', slot: 'coat', breed: 'poodle', name: 'Абрикосовый пудель', rarity: 'rare',
    palette: { body: '#d9a06b', chest: '#e8bb8a', ear: '#c08850', curly: '#e0ad7a' } },
  { id: 'neck-bandana-green', slot: 'neck', name: 'Зелёная бандана', rarity: 'common',
    neck: { kind: 'bandana', color: '#4caf6d' } },
  { id: 'neck-bandana-black', slot: 'neck', name: 'Чёрная бандана', rarity: 'common',
    neck: { kind: 'bandana', color: '#26262c' } },
  { id: 'neck-collar-spike', slot: 'neck', name: 'Ошейник с шипами', rarity: 'rare',
    neck: { kind: 'collar', color: '#c0c4c8' } },
  { id: 'paws-pink', slot: 'paws', name: 'Розовые следы', rarity: 'common', paws: '#f48fb1' },
  { id: 'paws-ember', slot: 'paws', name: 'Огненные следы', rarity: 'rare', paws: '#ff7043' },
  { id: 'finish-hearts', slot: 'finish', name: 'Сердечки', rarity: 'rare', finish: 'hearts' },
  { id: 'handler-blue', slot: 'handler', name: 'Хендлер: синяя форма', rarity: 'common',
    shirt: '#3b6fd4' },
  { id: 'handler-gold', slot: 'handler', name: 'Хендлер: форма чемпионата', rarity: 'epic',
    shirt: '#c9a227' },
  { id: 'ring-beach', slot: 'ring', name: 'Ринг: пляж', rarity: 'legendary',
    theme: { outer: '#c8b077', grass: '#dbc389', stripeAlpha: 0.05, overlay: 'rgba(255,220,150,0.10)', lights: false } },

  // --- Волна 3: реальные окрасы бордер-колли и аусси (стандарты AKC/ASCA) ---
  // Бордер: шоко (bb-ливер), ред-мерль, лайлак (двойной дилют bb+dd),
  // слейт (дилют чёрного), голд (ee-red)
  { id: 'coat-border-choco', slot: 'coat', breed: 'border', name: 'Шоколадный бордер', rarity: 'rare',
    palette: { body: '#5a3a26', chest: '#f5f0e8', ear: '#43291a' } },
  { id: 'coat-border-redmerle', slot: 'coat', breed: 'border', name: 'Ред-мерль бордер', rarity: 'epic',
    palette: { body: '#b08b72', chest: '#f5f0e8', ear: '#8a5638', merle: '#7a4a30' } },
  { id: 'coat-border-lilac', slot: 'coat', breed: 'border', name: 'Лайлак бордер', rarity: 'epic',
    palette: { body: '#9c8a80', chest: '#f5f0e8', ear: '#7d6b62' } },
  { id: 'coat-border-slate', slot: 'coat', breed: 'border', name: 'Слейт бордер', rarity: 'rare',
    palette: { body: '#6e7580', chest: '#f5f0e8', ear: '#565c66' } },
  { id: 'coat-border-gold', slot: 'coat', breed: 'border', name: 'Голд бордер', rarity: 'common',
    palette: { body: '#d8a85c', chest: '#f7f0e0', ear: '#b8863c' } },
  // Аусси: не-мерльные окрасы гасят мерль базовой Хлои (merle: null),
  // у ливерных — янтарный глаз вместо голубого
  { id: 'coat-aussie-redtri', slot: 'coat', breed: 'aussie', name: 'Ред-три Хлоя', rarity: 'rare',
    palette: { body: '#8a4f2c', chest: '#f7f5f0', ear: '#6b3a1e', tan: '#d09a5a', merle: null, eye: '#b8863c' } },
  { id: 'coat-aussie-blackbi', slot: 'coat', breed: 'aussie', name: 'Блэк-би Хлоя', rarity: 'common',
    palette: { body: '#26262c', chest: '#f7f5f0', ear: '#17171c', tan: null, merle: null, eye: '#8fd8ff' } },
  { id: 'coat-aussie-redbi', slot: 'coat', breed: 'aussie', name: 'Ред-би Хлоя', rarity: 'common',
    palette: { body: '#7a4a30', chest: '#f7f5f0', ear: '#5d3722', tan: null, merle: null, eye: '#b8863c' } },
];

export const SLOT_NAMES = { coat: 'Окрас', neck: 'Шея', paws: 'Следы', finish: 'Финиш', handler: 'Хендлер', ring: 'Ринг' };

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
  const hand = equip.handler && owned[equip.handler] && itemById(equip.handler);
  if (hand) b = { ...b, handlerShirt: hand.shirt };
  const ring = equip.ring && owned[equip.ring] && itemById(equip.ring);
  if (ring) b = { ...b, ringTheme: ring.theme };
  return b;
}

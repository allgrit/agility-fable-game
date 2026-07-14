// Аналитика игроков (cookieless, server-side ingestion на общий бэкенд).
// visitor_id — анонимный GUID в localStorage (не ПД), VERSION в каждом батче —
// чтобы видеть распределение по версиям и работу автообновления.
// track() безопасен: не роняет игру, буфер флашится по времени/выходу, не в игровом цикле.

import { SDK } from './config.js';

const ENDPOINT = SDK.API + '/events';

// Отключение аналитики (тесты/харнесс). Проверяется динамически: URL-флаг ?noanalytics
// теряется при bootstrap-reload на ?fresh, поэтому метку дублируем в localStorage —
// иначе тестовый трафик засоряет статистику уникальных игроков (каждый прогон = новый GUID).
if (/[?&]noanalytics\b/.test(location.search)) {
  try { localStorage.setItem('__noanalytics', '1'); } catch { /* ignore */ }
}
function isDisabled() {
  try {
    if (/[?&]harness\b/.test(location.search)) return true;
    if (localStorage.getItem('__noanalytics')) return true;
  } catch { /* ignore */ }
  return false;
}
const DISABLED = isDisabled();

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxxyxxx4xxxyxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function visitorId() {
  try {
    let v = localStorage.getItem('__vid');
    if (!v) { v = uuid(); localStorage.setItem('__vid', v); localStorage.setItem('__vfirst', new Date().toISOString().slice(0, 10)); }
    return v;
  } catch { return 'anon'; }
}

const VISITOR = visitorId();
const SESSION = uuid().slice(0, 8);
let buffer = [];
let flushTimer = null;

function post(payload, useBeacon) {
  try {
    const body = JSON.stringify(payload);
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
    } else {
      fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  } catch { /* аналитика молчит при любой ошибке */ }
}

function flush(useBeacon = false) {
  if (!buffer.length) return;
  const events = buffer; buffer = [];
  post({ game: SDK.GAME_ID, visitor: VISITOR, ver: SDK.VERSION, events }, useBeacon);
}

// track('run_death', { distance_m, obstacle_type })
export function track(name, params = {}) {
  if (DISABLED || isDisabled()) return;
  buffer.push({ name, ts: Date.now(), params });
  if (buffer.length >= 20) return flush();
  if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 5000);
}

export function sessionId() { return SESSION; }
export function firstSeen() { try { return localStorage.getItem('__vfirst'); } catch { return null; } }
// Включена ли телеметрия сейчас. Игра оборачивает этим и отправку в лидерборд,
// чтобы тестовый трафик (harness/?noanalytics) не засорял ни аналитику, ни топ.
export function telemetryEnabled() { return !DISABLED && !isDisabled(); }

if (!DISABLED && typeof window !== 'undefined') {
  const onLeave = () => { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } flush(true); };
  window.addEventListener('pagehide', onLeave);
  window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') onLeave(); });
}

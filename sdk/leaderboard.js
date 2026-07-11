// Клиент онлайн-лидерборда (общий мультиарендный бэкенд). HMAC-подпись через WebCrypto.
// Все запросы устойчивы к офлайну (возвращают null, не бросают).

import { SDK } from './config.js';

async function hmac(msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(SDK.SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function submitScore(name, score, distance = 0) {
  try {
    const nm = String(name || 'Аноним').slice(0, 24);
    const sc = Math.floor(score);
    const ts = Date.now();
    const sig = await hmac(`${SDK.GAME_ID}|${nm}|${sc}|${ts}`);
    const res = await fetch(`${SDK.API}/scores`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game: SDK.GAME_ID, name: nm, score: sc, distance: Math.floor(distance || 0), ts, sig }),
    });
    return res.ok ? await res.json() : null; // { ok, rank }
  } catch { return null; }
}

export async function fetchTop(period = 'all', limit = 10) {
  try {
    const res = await fetch(`${SDK.API}/top?game=${SDK.GAME_ID}&period=${period}&limit=${limit}`, { cache: 'no-store' });
    return res.ok ? (await res.json()).top : null;
  } catch { return null; }
}

// PWA-обёртка для игр Fable Arcade: регистрация SW, самоочистка залипшего кэша,
// форс-сброс по ?fresh/?v, версия-бейдж с кнопкой «обновить», отложенный reload.
// Подключается ОДНОЙ строкой в игре: import { initPWA } from './sdk/pwa.js'; initPWA({...})
//
// ВАЖНО: bootstrap-самоочистку (по имени кэша) надо продублировать inline в <head>
// index.html — см. pwaBootstrapSnippet(). index.html грузится всегда свежим и потому
// знает актуальную версию даже когда весь остальной кэш устарел.

import { SDK } from './config.js';

// Вызывать из <head> inline-скриптом (см. snippet ниже). Здесь — как ES для полноты.
export function bootstrap() {
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.has('harness')) return;
    const forced = qs.has('fresh') || qs.has('v');
    if (forced && !sessionStorage.getItem('__busted')) {
      sessionStorage.setItem('__busted', '1');
      wipeAll().then(() => location.replace(location.pathname));
      return;
    }
    if (sessionStorage.getItem('__busted') || !('caches' in window)) return;
    caches.keys().then((ks) => {
      const prefix = SDK.CACHE.replace(/-v\d+$/, '');
      const stale = ks.filter((k) => k.indexOf(prefix) === 0 && k !== SDK.CACHE);
      if (!stale.length) return;
      sessionStorage.setItem('__busted', '1');
      wipeAll().then(() => location.reload());
    }).catch(() => {});
  } catch { /* ignore */ }
}

function wipeAll() {
  const jobs = [];
  if ('caches' in window) jobs.push(caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))));
  if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))));
  return Promise.all(jobs).catch(() => {});
}

// Инлайн-строка для <head> (копировать в index.html до модулей).
export function pwaBootstrapSnippet(cacheName) {
  return `<script>window.__CACHE='${cacheName}';(function(){try{var q=new URLSearchParams(location.search);if(q.has('harness'))return;var f=q.has('fresh')||q.has('v');var wipe=function(){var j=[];if('caches'in window)j.push(caches.keys().then(function(k){return Promise.all(k.map(function(x){return caches.delete(x)}))}));if(navigator.serviceWorker)j.push(navigator.serviceWorker.getRegistrations().then(function(r){return Promise.all(r.map(function(x){return x.unregister()}))}));return Promise.all(j)};if(f&&!sessionStorage.getItem('__busted')){sessionStorage.setItem('__busted','1');wipe().then(function(){location.replace(location.pathname)});return}if(sessionStorage.getItem('__busted')||!('caches'in window))return;caches.keys().then(function(ks){var p=window.__CACHE.replace(/-v\\d+$/,'');var s=ks.filter(function(k){return k.indexOf(p)===0&&k!==window.__CACHE});if(!s.length)return;sessionStorage.setItem('__busted','1');wipe().then(function(){location.reload()})}).catch(function(){})}catch(e){}})();</script>`;
}

// Регистрация SW + версия-бейдж + кнопка «обновить». getState() — чтобы отложить reload
// до конца забега (передай функцию, возвращающую 'running'|'idle'|…).
export function initPWA({ getState, isBusy, badgeSelector = '#version-badge' } = {}) {
  const busy = isBusy || (() => false);
  // Версия-бейдж с кнопкой сброса
  const badge = document.querySelector(badgeSelector);
  if (badge) {
    badge.innerHTML = `<span>${SDK.VERSION}</span> <button class="fa-upd" title="Сбросить кэш и загрузить свежую версию">⟳ обновить</button>`;
    const btn = badge.querySelector('.fa-upd');
    if (btn) btn.onclick = async () => { btn.textContent = '⟳ …'; await wipeAll(); location.href = location.pathname + '?fresh=' + Date.now(); };
  }
  if (!('serviceWorker' in navigator) || /[?&]harness\b/.test(location.search)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
      reg.update().catch(() => {});
      setInterval(() => reg.update().catch(() => {}), 60000);
    }).catch(() => {});
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      const doReload = () => location.reload();
      if (busy()) { window.__pendingReload = doReload; } else { doReload(); }
    });
  });
}

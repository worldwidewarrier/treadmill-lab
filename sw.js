// Treadmill Lab service worker — precache the app shell for offline use; network-first for navigations.
const VERSION = 'tl-v1.1.9';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './css/app.css', './vendor/uPlot.min.css', './vendor/uPlot.iife.min.js',
  './js/app.js', './js/alerts.js', './js/analysis.js', './js/ble.js', './js/charts.js', './js/dfa.js', './js/fit.js', './js/i18n.js', './js/importers.js', './js/lactate.js', './js/prescribe.js', './js/session.js', './js/sources.js', './js/store.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url); if (url.origin !== location.origin) return;
  if (req.mode === 'navigate') { e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put('./index.html', copy)); return r; }).catch(() => caches.match('./index.html'))); return; }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return r; })));
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

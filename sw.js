// Treadmill Lab service worker — precache the app shell for offline use; network-first for navigations.
const VERSION = 'tl-v1.1.16';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './css/app.css', './vendor/uPlot.min.css', './vendor/uPlot.iife.min.js',
  './js/app.js', './js/alerts.js', './js/analysis.js', './js/ble.js', './js/charts.js', './js/dfa.js', './js/fit.js', './js/i18n.js', './js/importers.js', './js/lactate.js', './js/prescribe.js', './js/session.js', './js/sources.js', './js/store.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'];
// cache: 'reload' = fetch every file from the server, not from the browser's HTTP cache (which may still hold the previous release for a few minutes)
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
// The start page: network first, so a visit always sees the published page — but the cached copy whenever the host is slow,
// unreachable or answering with an error page. Other pages under the same address are never stored as the start page.
const SHELL = new URL('./', self.location.href).pathname; // '/treadmill-lab/'
const NAV_TIMEOUT_MS = 4000;
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url); if (url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    const cachedShell = () => caches.match('./index.html');
    if (url.pathname !== SHELL && url.pathname !== SHELL + 'index.html') { e.respondWith(fetch(req).catch(async () => (await cachedShell()) || Response.error())); return; }
    const net = fetch(req);
    e.waitUntil(net.then(r => { if (!r.ok) return null; const copy = r.clone(); return caches.open(VERSION).then(c => c.put('./index.html', copy)); }).catch(() => {})); // keeps the cached start page current, also when the answer arrives after the timeout
    e.respondWith((async () => {
      let late = null; const slow = new Promise(res => { late = setTimeout(() => res(null), NAV_TIMEOUT_MS); });
      let r = null; try { r = await Promise.race([net, slow]); } catch (err) { r = null; } clearTimeout(late); // null = no answer (offline) or none in time
      if (r && (r.ok || r.type === 'opaqueredirect')) return r;
      return (await cachedShell()) || r || net; // 5xx / 404 from the host, offline, or too slow → the app from the cache
    })());
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return r; })));
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

// Headless: service-worker life cycle on a private copy of the app served like GitHub Pages (Cache-Control: max-age=600).
// install → everything cached → works offline → a new release published a moment later reaches the phone with its new files
// (the browser's HTTP cache still holds the previous release for ten minutes; the precache must not take its files from there).
// Self-contained: starts its own server on a free port.   TL_SRC=<dir> tests another copy of the app.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join, extname, dirname } from 'node:path'; import { fileURLToPath } from 'node:url';
const SRC = process.env.TL_SRC || join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'tl-sw-')); for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', 'css', 'js', 'vendor', 'icons']) cpSync(join(SRC, f), join(dir, f), { recursive: true });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let failNav = false; // true = answer page requests with 503, as a host in trouble would
let down = false;    // true = no network: every connection is cut (Playwright's offline switch does not reach requests made by the worker)
let slowNav = 0;     // ms the host takes to answer a page request (overloaded host, weak signal)
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html'; const file = join(dir, p);
  if (down) { req.socket.destroy(); return; }
  if (failNav && p === '/index.html') { res.writeHead(503, { 'Content-Type': 'text/html' }); res.end('<h1>503 Service Unavailable</h1>'); return; }
  if (slowNav && p === '/index.html') { const body = readFileSync(file); setTimeout(() => { try { res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'max-age=600' }); res.end(body); } catch (e) { /* the browser gave up */ } }, slowNav); return; }
  if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'max-age=600', 'Last-Modified': statSync(file).mtime.toUTCString() }); res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}/`;
let fails = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) fails++; };
const verOf = () => readFileSync(join(dir, 'sw.js'), 'utf8').match(/VERSION = 'tl-v([^']+)'/)[1];
const assets = () => [...readFileSync(join(dir, 'sw.js'), 'utf8').match(/const ASSETS = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
const publish = v => { // a release = the two version strings change, exactly like a real deploy
  const old = verOf(); writeFileSync(join(dir, 'sw.js'), readFileSync(join(dir, 'sw.js'), 'utf8').replace(`tl-v${old}`, `tl-v${v}`));
  writeFileSync(join(dir, 'js/app.js'), readFileSync(join(dir, 'js/app.js'), 'utf8').replace(`APP_VERSION = '${old}'`, `APP_VERSION = '${v}'`));
};
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 384, height: 604 }, locale: 'ko-KR' });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
const swState = () => page.evaluate(async () => { const keys = await caches.keys(); const out = { controller: !!navigator.serviceWorker.controller, keys, entries: 0, appVersion: null, shown: null };
  for (const k of keys) { const c = await caches.open(k); out.entries += (await c.keys()).length; const r = await c.match('./js/app.js'); if (r) out.appVersion = ((await r.text()).match(/APP_VERSION = '([^']+)'/) || [])[1]; } return out; });
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await page.waitForTimeout(250); } return false; }; // (waitForFunction treats the Promise of an async predicate as truthy)
const shownVersion = async () => { await page.click('#nav button[data-view=settings]'); await page.waitForSelector('[data-action=force-update]'); return page.evaluate(() => (document.querySelector('#view').textContent.match(/Treadmill Lab v([0-9.]+)/) || [])[1]); };

// 1) first visit: the worker installs and caches every file of the app shell
const v1 = verOf(); const list = assets();
await page.goto(base, { waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
await page.evaluate(() => navigator.serviceWorker.ready); await until(async () => (await page.evaluate(() => caches.keys())).length === 1 && (await swState()).entries === list.length, 10000);
let s = await swState();
check('worker installed, one cache named after the version', s.keys.length === 1 && s.keys[0] === `tl-v${v1}`, JSON.stringify(s.keys));
check(`all ${list.length} app-shell files are cached`, s.entries === list.length, `${s.entries} entries`);
// 2) offline: the app starts from the cache
await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
down = true; await page.goto(base + '?offline', { waitUntil: 'load' }).catch(() => {}); // an address the browser itself has no copy of → only the worker's cache can answer
const offlineOk = await page.waitForSelector('#view .card', { timeout: 8000 }).then(() => true, () => false);
check('starts without network and shows its version', offlineOk && await shownVersion() === v1);
down = false;
// 3) a release is published seconds later; the phone opens the app again
const v2 = v1.replace(/\d+$/, n => String(+n + 1)); publish(v2);
await page.goto(base, { waitUntil: 'networkidle' }); // this visit finds the new sw.js and installs it in the background
const arrived = await until(async () => { const k = await page.evaluate(() => caches.keys()); return k.length === 1 && k[0] === `tl-v${v2}`; }, 20000); await page.waitForTimeout(500);
check('the new release is noticed on the next visit', arrived);
s = await swState();
check('new worker took over; the old cache is gone', s.keys.length === 1 && s.keys[0] === `tl-v${v2}`, JSON.stringify(s.keys));
check(`its cache holds the files of ${v2}, not the copies the browser still had of ${v1}`, s.appVersion === v2, `cached js/app.js says ${s.appVersion}`);
await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
const shown = await shownVersion(); check(`after one reload Settings shows v${v2}`, shown === v2, `shows v${shown}`);
// 4) the host answers with an error page (outage): the app must open from the cache, and the error page must not become the offline start page
const appShown = () => page.waitForSelector('#view .card', { timeout: 6000 }).then(() => true, () => false);
failNav = true; const resp = await page.reload({ waitUntil: 'load' }); const duringOutage = await appShown(); failNav = false; // a reload goes to the server even while the browser's own copy is fresh
check('host answers 503 → the app opens from the cache instead of the error page', duringOutage, `page shows ${duringOutage ? 'the app' : 'the host error page'} (response ${resp.status()})`);
down = true; await page.goto(base + '?start', { waitUntil: 'load' }).catch(() => {});
check('…and the error page is not kept as the offline start page', await appShown());
down = false;
// 5) the host is slow (15 s for the page): the app must not wait for it
slowNav = 15000; const t0 = Date.now(); await page.goto(base + '?slow', { waitUntil: 'load', timeout: 30000 }).catch(() => {}); const slowOk = await appShown(); const took = (Date.now() - t0) / 1000; slowNav = 0;
check('host takes 15 s to answer → the app opens from the cache within a few seconds', slowOk && took < 9, `${took.toFixed(1)} s`);
// 6) another page under the same address is opened once (a README, a 404 page of the host): it must not replace the app's start page
writeFileSync(join(dir, 'notes.html'), '<!doctype html><title>notes</title><h1 id="other">some other page</h1>');
await page.goto(base + 'notes.html', { waitUntil: 'load' }); const sawOther = await page.locator('#other').count() === 1; await page.waitForTimeout(400);
down = true; await page.goto(base + '?again', { waitUntil: 'load' }).catch(() => {});
const stillApp = await appShown(); check('visiting another page of the site does not overwrite the offline start page', sawOther && stillApp, stillApp ? 'offline start shows the app' : 'offline start shows the other page');
down = false;
await browser.close(); server.close();
console.log('errors:', errors.length ? errors : 'none'); if (errors.length) fails++;
console.log(fails ? `${fails} FAILURE(S)` : 'ALL PASS'); process.exit(fails ? 1 : 0);

// Headless: the Bluetooth path through the real UI with a mock strap injected as navigator.bluetooth (the other UI tests only use demo/replay).
// Covers: RR counter before Start, pause clocks, lactate cue while another tab is showing, flaky reconnect (no doubled RR),
// failed first connection (nothing left running), numeric settings.
// Needs the dev server:  python3 -m http.server 8765   (≈ 1 min, real-time clock)
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs'; import { tmpdir } from 'node:os';
const SHOTS = process.env.TL_SHOTS || `${tmpdir()}/treadmill-lab-shots`; mkdirSync(SHOTS, { recursive: true });
const base = process.env.TL_BASE || 'http://127.0.0.1:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 384, height: 604 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'ko-KR', timezoneId: 'Asia/Seoul', serviceWorkers: 'block' });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push('pageerror: ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
let fails = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) fails++; };
const shot = n => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });

// ---- mock strap: Chrome semantics (same characteristic object within a connection; NetworkError when the link is gone) ----
await page.addInitScript(() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms)); const netErr = () => Object.assign(new Error('GATT Server is disconnected.'), { name: 'NetworkError' });
  class Strap extends EventTarget {
    constructor() { super(); this.name = 'Polar H10 MOCK'; this.conn = 0; this.connected = false; this.failDiscovery = 0; this.connectCalls = 0; this.sent = 0; this.chars = new Map(); const dev = this;
      this.gatt = { get connected() { return dev.connected; }, async connect() { dev.connectCalls++; await sleep(30); if (!dev.connected) { dev.connected = true; dev.conn++; } return dev.server(dev.conn); }, disconnect() { if (dev.connected) dev.drop(); } };
      setInterval(() => this.notify(), 1000); }
    server(conn) { const dev = this; return { async getPrimaryService(name) { await sleep(20); if (!dev.connected || dev.conn !== conn) throw netErr(); if (name === 'heart_rate' && dev.failDiscovery > 0) { dev.failDiscovery--; dev.drop(); throw netErr(); }
      if (name === 'battery_service') return { async getCharacteristic() { return { async readValue() { return new DataView(new Uint8Array([77]).buffer); } }; } };
      return { async getCharacteristic() { await sleep(10); if (!dev.connected || dev.conn !== conn) throw netErr(); if (!dev.chars.has(conn)) { const c = new EventTarget(); c.notifying = false; c.startNotifications = async () => { await sleep(10); if (!dev.connected || dev.conn !== conn) throw netErr(); c.notifying = true; return c; }; c.stopNotifications = async () => { c.notifying = false; }; dev.chars.set(conn, c); } return dev.chars.get(conn); } }; } }; }
    drop() { this.connected = false; this.dispatchEvent(new Event('gattserverdisconnected')); }
    notify() { const c = this.chars.get(this.conn); if (!this.connected || !c || !c.notifying) return; const dv = new DataView(new ArrayBuffer(6)); dv.setUint8(0, 0x10 | 0x06); dv.setUint8(1, 142); dv.setUint16(2, 430, true); dv.setUint16(4, 434, true); const ev = new Event('characteristicvaluechanged'); Object.defineProperty(ev, 'target', { value: { value: dv } }); this.sent += 2; c.dispatchEvent(ev); }
  }
  const strap = new Strap(); window.__strap = strap;
  Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async () => strap, getAvailability: async () => true }, configurable: true });
});
await page.goto(base, { waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
const version = await page.evaluate(async () => (await import('./js/app.js')).APP_VERSION);

// ---- 1) failed first connection: error shown, nothing reconnects in the background, the set-up form is left alone ----
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg'); await page.click('#mode-seg button[data-mode=free]'); await page.waitForSelector('#free-cues');
await page.evaluate(() => { window.__strap.failDiscovery = 1; });
await page.click('[data-action=connect]'); await page.waitForSelector('.notice.warn', { timeout: 5000 });
await page.evaluate(() => { window.__marker = document.querySelector('#mode-seg'); }); // the same node must still be there later = no re-render loop
await page.fill('#sess-speed', '9.3'); // typed, not yet committed
await page.waitForTimeout(4500);
const f1 = await page.evaluate(() => ({ source: TL.source === null, strapConnected: window.__strap.connected, connectCalls: window.__strap.connectCalls, sameNode: window.__marker === document.querySelector('#mode-seg'), typed: document.querySelector('#sess-speed').value, err: document.querySelector('.notice.warn')?.textContent.slice(0, 12), startDisabled: document.querySelector('[data-action=start]').disabled, hr: document.querySelector('#pre-hr').textContent }));
check('failed first connection: error hint shown, Start stays disabled', f1.source && /NetworkError/.test(f1.err) && f1.startDisabled, JSON.stringify(f1));
check('…no reconnect in the background (strap released)', f1.strapConnected === false && f1.connectCalls === 1, `strap connected ${f1.strapConnected}, connect calls ${f1.connectCalls}`);
check('…the set-up screen is not redrawn every second (typed speed survives)', f1.sameNode && f1.typed === '9.3', `same node ${f1.sameNode}, field "${f1.typed}"`);

// ---- 2) connect: RR counter rises before Start ----
const callsBefore = await page.evaluate(() => window.__strap.connectCalls);
await page.evaluate(() => { const b = document.querySelector('[data-action=connect]'); b.click(); b.click(); }); // an impatient double tap
await page.waitForSelector('[data-action=start]:not([disabled])', { timeout: 5000 });
await page.waitForTimeout(3200);
const dbl = await page.evaluate(() => ({ calls: window.__strap.connectCalls, status: TL.source && TL.source.status, sent: window.__strap.sent, seen: TL.engine.view().rrSeen }));
check('double tap on Connect: one connection, every RR interval counted once', dbl.calls - callsBefore === 1 && dbl.status === 'connected' && dbl.seen > 0 && dbl.seen <= dbl.sent, JSON.stringify(dbl));
const pre = await page.evaluate(() => ({ rr: +document.querySelector('#pre-rr').textContent, hr: document.querySelector('#pre-hr').textContent, batt: document.querySelector('#pre-batt').textContent, chip: document.querySelector('#conn-text').textContent, oldError: !!document.querySelector('.notice.warn') }));
check('connect screen: heart rate, battery and a rising RR count before Start', pre.rr >= 4 && pre.hr === '142' && pre.batt === '77%', JSON.stringify(pre));
check('the hint from the failed attempt is gone once connected', pre.oldError === false);
await shot('40-connect-screen');

// ---- 3) free session: pause clocks, cue on another tab ----
await page.fill('#sess-speed', '9'); await page.fill('#free-cues', '0.3'); // cue at 18 s
await page.click('[data-action=start]'); await page.waitForSelector('#lv-hr');
await page.evaluate(() => { window.__cues = []; const a = TL.alerts; const cue = a.cue.bind(a); a.cue = (t, o) => { window.__cues.push(t); return cue(t, o); }; });
await page.waitForTimeout(4200);
await page.click('[data-action=pause]'); await page.waitForTimeout(300);
const p0 = await page.evaluate(() => ({ el: document.querySelector('#lv-elapsed').textContent, big: document.querySelector('#lv-phase-time').textContent, v: TL.engine.view().elapsedSec }));
await page.waitForTimeout(4000);
const p1 = await page.evaluate(() => ({ el: document.querySelector('#lv-elapsed').textContent, big: document.querySelector('#lv-phase-time').textContent, v: TL.engine.view().elapsedSec, lbl: document.querySelector('#lv-phase-lbl').textContent }));
check('paused: both clocks stand still', p0.el === p1.el && p0.big === p1.big && Math.abs(p1.v - p0.v) < 0.01 && p1.lbl.startsWith('⏸'), `${p0.el}/${p0.big} → ${p1.el}/${p1.big}`);
await shot('41-live-paused');
await page.click('[data-action=pause]'); await page.waitForTimeout(1300);
const p2 = await page.evaluate(() => ({ v: TL.engine.view().elapsedSec, big: TL.engine.view().phaseElapsed }));
check('resumed: clocks continue from where they stopped and agree', p2.v - p1.v > 0.5 && p2.v - p1.v < 2.5 && Math.abs(p2.v - p2.big) < 0.01, `elapsed ${p1.v.toFixed(1)} → ${p2.v.toFixed(1)}, phase ${p2.big.toFixed(1)}`);
await page.click('#nav button[data-view=plan]'); // leave the Session tab before the cue is due
await page.waitForFunction(() => TL.engine.view().elapsedSec > 19.5, null, { timeout: 30000 });
const cue = await page.evaluate(() => ({ cues: window.__cues, fired: [...TL.live.cueFired], view: TL.view }));
check('lactate cue fires on time while the Plan tab is showing', cue.view === 'plan' && cue.cues.some(t => /채혈/.test(t)) && cue.fired.includes('18:c'), JSON.stringify(cue));

// ---- 4) the link drops and drops again during the first reconnect: every RR still arrives exactly once ----
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#lv-hr');
await page.evaluate(() => { window.__strap.failDiscovery = 1; window.__strap.drop(); });
await page.waitForFunction(() => TL.source && TL.source.status === 'connected', null, { timeout: 15000 });
await page.waitForTimeout(700);
const mark = await page.evaluate(() => ({ rr: TL.engine.rr.length, sent: window.__strap.sent }));
await page.waitForTimeout(4100);
const after = await page.evaluate(() => ({ rr: TL.engine.rr.length, sent: window.__strap.sent, status: TL.source.status }));
check('after a flaky reconnect each RR interval is recorded once', after.rr - mark.rr === after.sent - mark.sent && after.sent - mark.sent >= 6, `strap sent ${after.sent - mark.sent}, app recorded ${after.rr - mark.rr}`);
await page.click('[data-action=lactate]'); await page.waitForSelector('#lac-modal'); for (const k of ['1', '.', '4']) await page.click(`#lac-modal .keypad button[data-k="${k}"]`); await page.click('#lac-modal [data-x=save]'); await page.waitForTimeout(150); if (await page.$('.rpe')) await page.click('.rpe button[data-r="11"]');
await page.click('[data-action=stop]'); await page.click('.modal [data-x=yes]'); await page.waitForSelector('#vc-end', { timeout: 10000 });
const saved = await page.evaluate(() => ({ type: TL.detail.type, speed: TL.detail.speed, kind: TL.detail.sourceKind, pauseMs: TL.detail.pauseMs, lactate: TL.detail.events.filter(e => e.type === 'lactate').map(e => e.value), rest: document.querySelector('#vc-rest').value, targets: TL.detail.targets }));
// (a sample in the first 4 min is filed as the resting value — this session is under a minute long)
check('session saved from the strap with speed, pause time and lactate', saved.type === 'free' && saved.speed === 9 && saved.kind === 'ble' && saved.pauseMs > 3500 && saved.pauseMs < 5500 && saved.lactate.length === 1 && saved.lactate[0] === 1.4 && saved.rest === '1.4' && saved.targets === null, JSON.stringify(saved));

// ---- 5) settings: a <select> value is stored as a number ----
await page.click('#nav button[data-view=settings]'); await page.waitForSelector('[data-set="alpha1.stepSec"]');
await page.selectOption('[data-set="alpha1.stepSec"]', '10'); await page.waitForTimeout(300);
const st = await page.evaluate(async () => ({ live: TL.settings.alpha1.stepSec, stored: (await (await import('./js/store.js')).store.getSettings()).alpha1.stepSec, mode: TL.settings.alpha1.artifactMode }));
check('update interval saved as the number 10', st.live === 10 && st.stored === 10 && st.mode === 'auto', JSON.stringify(st));
await page.evaluate(async () => { const { store } = await import('./js/store.js'); const s = await store.getSettings(); s.alpha1.stepSec = '20'; await store.saveSettings(s); }); // what an older version stored
await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
check('text left by an older version is repaired on load', await page.evaluate(() => TL.settings.alpha1.stepSec === 20));
await page.click('#nav button[data-view=settings]'); await page.waitForSelector('[data-action=force-update]');
const foot = await page.evaluate(() => document.querySelector('#view').textContent);
check(`settings show v${version} and the storage-protection line`, foot.includes('v' + version) && /저장소 보호/.test(foot), (foot.match(/저장소 보호[^<]{0,12}/) || [''])[0]);
await shot('42-settings-foot');

// ---- 6) a session that no longer exists ----
await page.evaluate(() => TL.navigate('analysis', 'no-such-session')); await page.waitForTimeout(600);
check('opening a deleted session says so instead of hanging', /not found/.test(await page.textContent('#view')), JSON.stringify((await page.textContent('#view')).slice(0, 40)));

await browser.close();
const errs = errors.filter(e => !/en-US@posix|GATT [Ss]erver (is )?disconnected/.test(e)); // (the failed first connection is logged by the app on purpose)
console.log('errors:', errs.length ? errs : 'none'); if (errs.length) fails++;
console.log(fails ? `${fails} FAILURE(S)` : 'ALL PASS'); process.exit(fails ? 1 : 0);

// Headless (dev server on :8765), v1.1.32 — "스트랩 미휴대로 젖산만 측정 결과 앱에 적용":
//   1. what happened on 10/17: a two-lap check recorded on the demo strap (made-up heart rate), lap 1 1.2 → end 0.8 at 8.9 km/h —
//      left out of the weekly check; the session card offers "Real run without strap (lactate only)"; after it the made-up heart rate
//      is gone, the verdict is borderline without heart-rate advice, and Home's weekly check counts it (8.9, borderline);
//   2. next time: Sensor → "No strap (lactate only)" is ready at once, the session runs with heart rate "–", no error.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs'; import { tmpdir } from 'node:os';
const SHOTS = process.env.TL_SHOTS || `${tmpdir()}/treadmill-lab-shots`; mkdirSync(SHOTS, { recursive: true });
const base = process.env.TL_BASE || 'http://127.0.0.1:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 384, height: 790 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
let fails = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) fails++; };
const shot = n => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
const text = () => page.evaluate(() => document.getElementById('view').textContent);
const weekly = () => page.evaluate(() => { const h2 = [...document.querySelectorAll('#view h2')].find(h => /주간 LT1 검증/.test(h.textContent)); return h2 && h2.nextElementSibling ? h2.nextElementSibling.textContent : ''; });
const typeLac = async v => { for (const k of v) await page.click(`#lac-modal .keypad button[data-k="${k}"]`); await page.click('#lac-modal [data-x=save]'); await page.waitForTimeout(150); };
await page.goto(base, { waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');

// ---- 1. the demo recording of 10/17 (short laps at ×60), then converted
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg'); await page.click('#mode-seg button[data-mode=verify]'); await page.waitForSelector('#lap-1');
await page.fill('#sess-speed', '8.9'); await page.$eval('#sess-speed', el => el.dispatchEvent(new Event('change')));
for (const [id, v] of [['#lap-wu', '1'], ['#lap-1', '2'], ['#lap-2', '3']]) { await page.fill(id, v); await page.$eval(id, el => el.dispatchEvent(new Event('change'))); }
await page.click('#src-seg button[data-src=demo]'); await page.selectOption('#demo-speed', '60'); await page.click('[data-action=connect]'); await page.waitForSelector('[data-action=start]:not([disabled])'); await page.click('[data-action=start]'); await page.waitForSelector('#lv-zone');
await page.waitForSelector('#lac-modal', { timeout: 25000 }); await typeLac('1.2');
await page.waitForTimeout(900); await page.click('#lv-lap'); await page.waitForFunction(() => TL.engine.phase === 'work' && TL.engine.rep === 2, null, { timeout: 5000 });
await page.waitForSelector('#lac-modal', { timeout: 25000 }); await typeLac('0.8');
await page.click('[data-action=stop]'); await page.click('.modal [data-x=yes]'); await page.waitForSelector('#vc-laps', { timeout: 10000 });
const before = await page.evaluate(() => ({ kind: TL.detail.sourceKind, hr: TL.detail.hrLive.length, speed: TL.detail.speed, btn: !!document.querySelector('[data-action=to-nostrap]'), txt: document.getElementById('view').textContent }));
check('the demo recording: source demo, a made-up heart rate, speed 8.9; the card offers the conversion and says why', before.kind === 'demo' && before.hr > 100 && before.speed === 8.9 && before.btn && /가짜/.test(before.txt), JSON.stringify({ ...before, txt: undefined }));
await shot('60-demo-card');
await page.click('#nav button[data-view=home]'); await page.waitForSelector('#view .card'); await page.waitForTimeout(300);
check('Home before: the demo run is not counted (weekly check still at the LT1 speed 8.7, no result)', /8\.7 km\/h/.test(await weekly()) && !/10\/1\d, 8\.9/.test(await weekly()), (await weekly()).slice(0, 140));
await page.click('#nav button[data-view=analysis]'); await page.waitForSelector('#view'); await page.click('.list-item[data-action=open-session]'); await page.waitForSelector('[data-action=to-nostrap]');
await page.click('[data-action=to-nostrap]'); await page.waitForSelector('.modal [data-x=yes]'); await page.click('.modal [data-x=yes]');
await page.waitForFunction(() => TL.detail && TL.detail.sourceKind === 'nostrap', null, { timeout: 5000 }); await page.waitForTimeout(300);
const after = await page.evaluate(async () => { const { store } = await import('./js/store.js'); const s = await store.getSession(TL.detail.id); return { kind: s.sourceKind, from: s.convertedFrom, hr: s.hrLive.length, lac: s.events.filter(e => e.type === 'lactate').map(e => e.value).join(','), btn: !!document.querySelector('[data-action=to-nostrap]'), verdict: [...document.querySelectorAll('#view .notice')].map(n => n.textContent).join(' | '), txt: document.getElementById('view').textContent }; });
check('converted: source nostrap (from demo), no heart rate, lactate 1.2 / 0.8 kept, the button gone', after.kind === 'nostrap' && after.from === 'demo' && after.hr === 0 && after.lac === '1.2,0.8' && !after.btn, JSON.stringify({ ...after, verdict: undefined, txt: undefined }));
check('  the verdict: borderline at 8.9, judged on lactate only, no "목표 심박"', /경계 @ 8\.9 km\/h/.test(after.verdict) && /스트랩 없음/.test(after.verdict) && !/목표 심박/.test(after.verdict), after.verdict.slice(0, 220));
check('  the card says "No strap — lactate only", and no NaN anywhere', /스트랩 없음 — 젖산만으로 판정/.test(after.txt) && !/NaN/.test(after.txt) && /심박 기록 없음/.test(after.txt));
await shot('61-converted-card');
await page.click('#nav button[data-view=home]'); await page.waitForSelector('#view .card'); await page.waitForTimeout(300);
const w = await weekly();
check('Home after: the weekly check counts it — latest 8.9 borderline → this week 8.9', /경계/.test(w) && /8\.9 km\/h/.test(w), w.slice(0, 200));
check('  no zone changed by it (LT1 143 @ 8.7)', await page.evaluate(() => TL.settings.zones.lt1Hr === 143 && TL.settings.zones.lt1Speed === 8.7));
await shot('62-home-weekly');

// ---- 2. next time: No strap
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#src-seg'); await page.click('#src-seg button[data-src=nostrap]');
await page.waitForSelector('[data-action=start]:not([disabled])', { timeout: 5000 });
const pre = await page.evaluate(() => ({ kind: TL.source && TL.source.kind, status: TL.source && TL.source.status, note: /스트랩 없이 실제로 달릴 때/.test(document.getElementById('view').textContent), seg: [...document.querySelectorAll('#src-seg button')].map(b => b.getBoundingClientRect()).every(r => r.right <= 384 && r.height <= 80) }));
check('Sensor → 「스트랩 없음 (젖산만)」: ready at once (no pairing), with its note, the four buttons fit the width', pre.kind === 'nostrap' && pre.status === 'connected' && pre.note && pre.seg, JSON.stringify(pre));
await shot('63-nostrap-setup');
await page.click('[data-action=start]'); await page.waitForSelector('#lv-zone'); await page.waitForTimeout(2500);
const live = await page.evaluate(() => ({ running: TL.engine.state, hr: document.getElementById('lv-hr').textContent, phase: TL.engine.phase }));
check('the session runs: heart rate "–", warm-up phase on the clock', live.running === 'running' && live.hr === '–' && live.phase === 'warmup', JSON.stringify(live));
await shot('64-nostrap-live');
await page.click('[data-action=stop]'); await page.click('.modal [data-x=yes]'); await page.waitForTimeout(800);
check('Finish saves it as source nostrap', await page.evaluate(() => TL.detail && TL.detail.sourceKind === 'nostrap'));
check('no console or page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close(); console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);

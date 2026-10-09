// Headless: LT1 demo session with speed + end lactate via the live button → verdict card; seed 3 verification sessions → multi-day curve → apply.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs'; import { tmpdir } from 'node:os';
const SHOTS = process.env.TL_SHOTS || `${tmpdir()}/treadmill-lab-shots`; mkdirSync(SHOTS, { recursive: true }); // screenshots
const base = 'http://127.0.0.1:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 384, height: 604 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
let fails = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) fails++; };
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
await page.goto(base, { waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
await page.evaluate(async () => { TL.settings.zones = { lt1Hr: 146, lt2Hr: 167, lt1Speed: 9.9, lt2Speed: 12.0, source: 'seed', grade: 'B/B', updatedAt: Date.now() - 3 * 86400000 }; await TL.saveSettings(); });
await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
// LT1 demo session, 3 min, speed 9.5
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg'); await page.click('#mode-seg button[data-mode=lt1]'); await page.waitForSelector('#sess-speed');
await page.fill('#lt1-min', '3'); await page.fill('#sess-speed', '9.5'); await page.$eval('#sess-speed', el => el.dispatchEvent(new Event('change')));
await page.click('#src-seg button[data-src=demo]'); await page.selectOption('#demo-speed', '60'); await page.click('[data-action=connect]'); await page.waitForSelector('[data-action=start]:not([disabled])'); await page.click('[data-action=start]'); await page.waitForSelector('#lv-zone');
await page.waitForTimeout(3500); // ≈3.5 min
// end lactate via live button
await page.click('[data-action=lactate]'); await page.waitForSelector('#lac-modal'); for (const k of ['1', '.', '9']) await page.click(`#lac-modal .keypad button[data-k="${k}"]`); await page.click('#lac-modal [data-x=save]'); await page.waitForTimeout(100); if (await page.$('.rpe')) await page.click('.rpe button[data-r="12"]');
await page.click('[data-action=stop]'); await page.click('.modal [data-x=yes]'); await page.waitForSelector('#vc-end', { timeout: 10000 });
const vc = await page.evaluate(() => ({ speed: TL.detail.speed, end: document.getElementById('vc-end').value, verdict: document.querySelector('.notice')?.textContent || '' }));
check('verification card shows speed and end lactate from the live entry', vc.speed === 9.5 && vc.end === '1.9', JSON.stringify(vc));
check('verdict judged against the resting baseline of Settings (0.8): end 1.9 = +1.1 → borderline, and it says so', /LT1 경계/.test(vc.verdict) && /기준 안정 시 0\.8 대비 \+1\.1/.test(vc.verdict), vc.verdict.slice(0, 60));
await shot('30-verify-card');
// edit end lactate to 3.0 → high verdict with apply button
await page.fill('#vc-end', '3.0'); await page.$eval('#vc-end', el => el.dispatchEvent(new Event('change'))); await page.waitForSelector('[data-action=apply-verdict]', { timeout: 5000 });
const before = await page.evaluate(() => TL.settings.zones.lt1Hr); await page.click('[data-action=apply-verdict]'); await page.waitForTimeout(400);
const after = await page.evaluate(() => ({ hr: TL.settings.zones.lt1Hr, sp: TL.settings.zones.lt1Speed })); check('apply verdict caps LT1 below the failed 9.5 km/h run (HR < before, speed ≤ 9.0)', after.hr < before && after.sp <= 9.0, `${before} → ${after.hr} bpm, ${after.sp} km/h`);
// seed 3 more verification sessions at other speeds → multi-day curve
await page.evaluate(async () => { const { store } = await import('./js/store.js'); const now = Date.now(); const mk = (speed, end, hr, d) => { const t0 = now - d * 86400000; const hrLive = []; for (let i = 0; i < 1500; i++) hrLive.push([t0 + i * 1000, hr]); return { id: 'seed' + speed, type: 'lt1', final: true, startedAt: t0, endedAt: t0 + 1500000, speed, incline: 1, hrLive, features: [], events: [{ t: t0 + 1450000, type: 'lactate', value: end }], metrics: { durationSec: 1500, meanHr: hr } }; }; await store.putSession(mk(8, 1.1, 128, 6)); await store.putSession(mk(9, 1.4, 138, 5)); await store.putSession(mk(10.5, 2.2, 150, 4)); await store.putSession(mk(11.5, 3.6, 158, 2)); await store.putSession(mk(12.5, 5.4, 165, 1)); });
await page.click('#nav button[data-view=home]'); await page.waitForTimeout(200); await page.click('#nav button[data-view=analysis]'); await page.waitForSelector('[data-action=apply-multiday]', { timeout: 8000 });
const md = await page.evaluate(() => ({ n: TL.multiDay.points.length, speeds: TL.multiDay.points.map(p => p.x), lt1: TL.multiDay.analysis.lt1Primary.x, lt2: TL.multiDay.analysis.lt2Primary.x, grade: TL.multiDay.grade }));
check('multi-day curve from 5 speeds', md.n === 5 && md.lt1 > 8 && md.lt2 > md.lt1, JSON.stringify(md));
check('the demo (virtual strap) run at 9.5 km/h is not a curve point', !md.speeds.includes(9.5), JSON.stringify(md.speeds));
await shot('31-multiday');
await page.click('[data-action=apply-multiday]'); await page.waitForTimeout(400);
const z = await page.evaluate(() => TL.settings.zones); check('multi-day thresholds applied', z.source === 'multi-day lactate' && Number.isFinite(z.lt1Hr) && Number.isFinite(z.lt2Hr), JSON.stringify(z));
// continuous test setting (pause 0) through the live UI: 2 short stages, no lactate modal
await page.evaluate(async () => { TL.settings.protocol.pauseSec = 0; TL.settings.protocol.warmupSec = 30; TL.settings.protocol.stageSec = 60; TL.settings.protocol.maxStages = 3; await TL.saveSettings(); });
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg'); await page.click('#mode-seg button[data-mode=test]'); await page.waitForTimeout(200);
await page.click('#src-seg button[data-src=demo]'); await page.selectOption('#demo-speed', '60'); await page.click('[data-action=connect]'); await page.waitForSelector('[data-action=start]:not([disabled])'); await page.click('[data-action=start]'); await page.waitForSelector('#lv-hr');
let sawModal = false; for (let i = 0; i < 30; i++) { if (await page.$('#lac-modal')) sawModal = true; await page.waitForTimeout(150); }
const st = await page.evaluate(() => ({ stages: TL.engine.stages.length, phase: TL.engine.phase }));
check('continuous test ran stages without lactate modal', !sawModal && st.stages >= 2, JSON.stringify(st));
await browser.close();
console.log('errors:', errors.filter(e => !/en-US@posix/.test(e)));
console.log(fails ? `${fails} FAILURE(S)` : 'ALL PASS'); process.exit(fails ? 1 : 0);

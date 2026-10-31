// Headless (dev server on :8765), v1.1.33: once the band has settled (two borderlines at 8.9 km/h, no strap) Home says
// "LT1 검증 (4주마다)" with the next date, today's Thursday card in an off week is an easy run, and the Plan tab's Thursdays follow.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const base = process.env.TL_BASE || 'http://127.0.0.1:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 384, height: 790 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
let fails = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) fails++; };
await page.goto(base, { waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
await page.evaluate(async () => {
  const { SessionEngine, DEFAULT_LAPS } = await import('./js/session.js'); const { NoStrapSource } = await import('./js/sources.js'); const { sessionMetrics } = await import('./js/prescribe.js'); const { store } = await import('./js/store.js');
  class Clock extends NoStrapSource { constructor(t0) { super(); this.T = t0; this.status = 'connected'; } now() { return this.T; } }
  const alerts = { speak() {}, cue() {}, keepAwake: async () => true, beep() {}, vibrate() {}, update() {}, unlock() {} };
  const mk = async (lap1, end, daysAgo, id) => { const src = new Clock(Date.now() - daysAgo * 86400000 - 4 * 3600000); const eng = new SessionEngine({ settings: TL.settings, alerts, onEvent: () => {} }); eng.setSource(src);
    eng.configure({ mode: 'verify', laps: { ...DEFAULT_LAPS }, targets: null, meta: { speed: 8.9, incline: 1, purpose: 'lt1' } }); eng.start(); clearInterval(eng.timer);
    const go = sec => { for (let i = 0; i < sec; i++) { src.T += 1000; eng.tick(src.T); } };
    go(300); go(601); go(40); eng.enterLactate(lap1); go(30); eng.lap(); go(1801); go(45); eng.enterLactate(end); go(20);
    const s = eng.stop('user'); s.final = true; s.sourceKind = 'nostrap'; s.id = id; s.metrics = sessionMetrics(s); await store.putSession(s); };
  await mk(1.2, 0.8, 7, 'cad-a'); await mk(1.1, 0.9, 1, 'cad-b'); });
await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#view .card'); await page.waitForTimeout(300);
const home = await page.evaluate(() => { const h2 = [...document.querySelectorAll('#view h2')].find(h => /LT1 검증/.test(h.textContent)); return { title: h2 ? h2.textContent : '', card: h2 && h2.nextElementSibling ? h2.nextElementSibling.textContent : '', mode: TL.bandFinder.cadence.mode, ko: TL.bandFinder.ko, change: !!TL.bandFinder.change }; });
check('band finder: maintenance — settled at 8.9, "범위 확인됨", the next date and the daily-app hint; Home shows no weekly card (none without a band change since v1.1.37)', home.mode === 'maintenance' && !home.change && home.title === '' && /8\.9 km\/h/.test(home.ko) && /범위 확인됨/.test(home.ko) && /LT1 검사 주기/.test(home.ko), home.ko.slice(0, 220));
await page.evaluate(async () => { TL.settings.plan.calendar = ''; await TL.saveSettings(); }); // (a plain week: the default calendar's 10/19 week is the MLSS weekend)
await page.click('#nav button[data-view=plan]'); await page.waitForSelector('.plan-day'); await page.waitForTimeout(200);
const thu = await page.evaluate(() => { const rows = [...document.querySelectorAll('.plan-day')]; const r = rows.find(x => /토|Sat/.test(x.querySelector('.dow')?.textContent || '')); return r ? r.textContent : ''; });
check('Plan (this week, v1.1.44): a plain week\'s Saturday is the fixed-speed test / 4×4 alternation, not the two-lap check (that is the lt1 calendar kind)', /고정 속도 검사|VO₂max 4×4분/.test(thu) && !/LT1 검증 달리기/.test(thu), thu.slice(0, 160));
check('no console or page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close(); console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);

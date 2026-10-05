// Headless UI smoke test at Galaxy A35 CSS viewport (384×604 @2.8): console errors, navigation, demo step test ×60, import of real files.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs'; import { tmpdir } from 'node:os';
const SHOTS = process.env.TL_SHOTS || `${tmpdir()}/treadmill-lab-shots`; mkdirSync(SHOTS, { recursive: true }); // screenshots
import { readFileSync, existsSync } from 'node:fs';
const base = 'http://127.0.0.1:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 384, height: 604 }, deviceScaleFactor: 2.8125, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push('pageerror: ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForSelector('#view .card');
const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log('home loaded; horizontal overflow px:', await overflow());
await shot('01-home');
// settings
await page.click('#nav button[data-view=settings]'); await page.waitForSelector('[data-set="profile.birth"]'); console.log('settings overflow:', await overflow()); await shot('02-settings');
// plan (no zones yet)
await page.click('#nav button[data-view=plan]'); await page.waitForTimeout(200); await shot('03-plan-empty');
// live: demo step test at ×60 with short warm-up for the test
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg');
await page.evaluate(() => { TL.settings.protocol.warmupSec = 60; TL.settings.protocol.stageSec = 120; TL.settings.protocol.pauseSec = 20; });
await page.click('#src-seg button[data-src=demo]'); await page.selectOption('#demo-speed', '60'); await page.waitForTimeout(100);
await shot('04-live-setup');
await page.click('[data-action=connect]'); await page.waitForSelector('[data-action=start]:not([disabled])', { timeout: 5000 });
await page.click('[data-action=start]'); await page.waitForSelector('#lv-hr');
console.log('live overflow:', await overflow());
// drive lactate prompts automatically: whenever the lactate modal appears, type a value based on stage
const la = [1.0, 1.1, 1.3, 1.6, 2.1, 3.0, 4.4, 6.5, 9.0];
let stagesDone = 0; const t0 = Date.now();
while (Date.now() - t0 < 90000) {
  if (await page.$('#lac-modal')) {
    const v = la[Math.min(stagesDone, la.length - 1)]; const digits = String(v).split('');
    for (const d of digits) await page.click(`#lac-modal .keypad button[data-k="${d}"]`);
    await page.click('#lac-modal [data-x=save]'); await page.waitForTimeout(100);
    if (await page.$('.rpe')) { await page.click(`.rpe button[data-r="${9 + stagesDone}"]`); }
    stagesDone++;
    if (stagesDone === 3) await shot('05-live-running');
  }
  const st = await page.evaluate(() => ({ state: TL.engine.state, phase: TL.engine.phase, stages: TL.engine.stages.length, stopAdvised: TL.engine.stopAdvised }));
  if (st.stopAdvised && st.phase === 'pause') break;
  if (st.state !== 'running') break;
  await page.waitForTimeout(150);
}
console.log('stages completed:', stagesDone);
await page.click('[data-action=stop]'); await page.click('.modal [data-x=yes]');
await page.waitForSelector('#stage-table', { timeout: 10000 });
console.log('detail overflow:', await overflow());
await shot('06-test-detail');
const tri = await page.evaluate(() => { const s = TL.detail; return s.result; });
console.log('result:', JSON.stringify(tri));
await page.click('[data-action=apply-zones]'); await page.waitForTimeout(300);
// home with zones
await page.click('#nav button[data-view=home]'); await page.waitForSelector('.thr-card'); await shot('07-home-zones');
await page.click('#nav button[data-view=plan]'); await page.waitForSelector('.plan-day'); console.log('plan overflow:', await overflow()); await shot('08-plan');
// import real files
await page.click('#nav button[data-view=analysis]'); await page.waitForSelector('[data-action=import]');
const fi = await page.$('#file-input');
const wanted = ['test/data/fatmaxxer_rr_121156.csv', 'test/data/trainred_session.csv', 'test/data/trainred_sensor0.fit', 'test/data/fatmaxxer_features_0926.csv', 'test/data/synthetic_garmin.fit'];
const present = wanted.filter(p => existsSync(p)); if (present.length < wanted.length) console.log('SKIP private fixtures not present:', wanted.filter(p => !present.includes(p)).join(', '));
await fi.setInputFiles(present);
await page.waitForTimeout(2500);
const counts = await page.evaluate(() => ({ sessions: TL.sessions.length, imports: TL.imports.length, types: TL.sessions.map(s => s.type + ':' + (s.sourceKind || '')) }));
console.log('after import:', JSON.stringify(counts));
await shot('09-analysis-list');
// open the FatMaxxer-derived session
const id = await page.evaluate(() => TL.sessions.find(s => (s.sourceKind || '').includes('fatmaxxer'))?.id);
if (id) {
  await page.evaluate((id) => { document.querySelector(`[data-action=open-session][data-id="${id}"]`).click(); }, id);
  await page.waitForSelector('#tl-chart .uplot', { timeout: 8000 }); await shot('10-fatmaxxer-session');
  const m = await page.evaluate(() => TL.detail.metrics);
  console.log('fatmaxxer session metrics:', JSON.stringify(m));
  await page.evaluate(() => document.querySelector('[data-action=back]').click()); await page.waitForTimeout(300);
}
// open the synthetic garmin session (laps → stages)
const gid = await page.evaluate(() => TL.sessions.find(s => (s.filename || '').includes('synthetic'))?.id);
await page.evaluate((id) => { document.querySelector(`[data-action=open-session][data-id="${id}"]`).click(); }, gid);
await page.waitForSelector('#stage-table', { timeout: 8000 }); await shot('11-garmin-session');
// light theme check
await ctx.close();
const ctx2 = await browser.newContext({ viewport: { width: 384, height: 604 }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'ko-KR' }); const p2 = await ctx2.newPage(); p2.on('pageerror', e => errors.push('light pageerror: ' + e.message));
await p2.goto(base, { waitUntil: 'networkidle' }); await p2.waitForSelector('#view .card'); await p2.screenshot({ path: `${SHOTS}/12-home-light.png`, fullPage: true });
await browser.close();
console.log('errors:', errors.length ? errors : 'none');

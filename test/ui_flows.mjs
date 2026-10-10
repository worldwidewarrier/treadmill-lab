// Headless flows: LT1 session (demo), LT2 session (demo), replay of a FatMaxxer file, SmO2 attach, backup export.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs'; import { tmpdir } from 'node:os';
const SHOTS = process.env.TL_SHOTS || `${tmpdir()}/treadmill-lab-shots`; mkdirSync(SHOTS, { recursive: true }); // screenshots
import { readFileSync, existsSync } from 'node:fs';
const base = 'http://127.0.0.1:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 384, height: 604 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'ko-KR', timezoneId: 'Asia/Seoul', acceptDownloads: true });
const page = await ctx.newPage(); const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
let fails = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) fails++; };
await page.goto(base, { waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
// seed zones directly
await page.evaluate(async () => { TL.settings.zones = { lt1Hr: 146, lt2Hr: 167, lt1Speed: 9.9, lt2Speed: 12.0, source: 'seed', grade: 'B/B', updatedAt: Date.now() - 3 * 86400000, testSessionId: null }; await TL.saveSettings(); });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
// --- LT1 session via demo ×60 ---
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg');
await page.click('#mode-seg button[data-mode=lt1]'); await page.waitForSelector('#lt1-min'); await page.fill('#lt1-min', '12'); await page.$eval('#lt1-min', el => el.dispatchEvent(new Event('change')));
await page.click('#src-seg button[data-src=demo]'); await page.selectOption('#demo-speed', '60');
await page.click('[data-action=connect]'); await page.waitForSelector('[data-action=start]:not([disabled])');
await page.click('[data-action=start]'); await page.waitForSelector('#lv-zone');
await page.waitForTimeout(6000); // ≈6 min of data: past the 0–5-min easy jog, before the band is judged (10:00)
const preCls = await page.getAttribute('#lv-zone', 'class'); const preTxt = await page.textContent('#lv-zone-text');
check('LT1 banner before 10:00 says the band is not judged yet (v1.1.25)', /rest/.test(preCls) && /판정은 10:00부터/.test(preTxt), preCls + ' ' + preTxt);
await page.waitForFunction(() => (TL.engine?.view?.().elapsedSec || 0) >= 615, null, { timeout: 20000 }); // ≈10.25 min: judging has begun
await page.waitForTimeout(600);
const zoneCls = await page.getAttribute('#lv-zone', 'class'); const zoneTxt = await page.textContent('#lv-zone-text');
check('LT1 zone banner shows a state from 10:00', /in|above|below|drift/.test(zoneCls), zoneCls + ' ' + zoneTxt);
check('live view (not a step test) says when to type the lactate value', /멈춘 직후/.test(await page.evaluate(() => document.getElementById('lv-lac-hint')?.textContent || '')));
await shot('20-lt1-live');
await page.click('[data-action=stop]'); await page.click('.modal [data-x=yes]'); await page.waitForSelector('#tl-chart .uplot', { timeout: 10000 });
const m1 = await page.evaluate(() => TL.detail.metrics);
check('LT1 session saved with time-in-zone', m1 && Number.isFinite(m1.timeInZonePct), JSON.stringify(m1));
await shot('21-lt1-detail');
// --- LT2 session via demo ×60 ---
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg');
await page.click('#mode-seg button[data-mode=lt2]'); await page.waitForSelector('#lt2-reps');
for (const [id, v] of [['lt2-reps', '2'], ['lt2-work', '2'], ['lt2-rest', '1'], ['lt2-wu', '1'], ['lt2-cd', '1']]) { await page.fill('#' + id, v); await page.$eval('#' + id, el => el.dispatchEvent(new Event('change'))); }
await page.click('#src-seg button[data-src=demo]'); await page.selectOption('#demo-speed', '60');
await page.click('[data-action=connect]'); await page.waitForSelector('[data-action=start]:not([disabled])'); await page.click('[data-action=start]'); await page.waitForSelector('#lv-zone');
await page.waitForTimeout(9000); // ≈9 min: wu1 + 2×2 + 1 + cd1 = 7 min → done
const ph = await page.evaluate(() => ({ phase: TL.engine.phase, rep: TL.engine.rep }));
check('LT2 intervals progressed to cooldown/done', ['cooldown', 'done'].includes(ph.phase), JSON.stringify(ph));
await shot('22-lt2-live');
await page.click('[data-action=stop]'); await page.click('.modal [data-x=yes]'); await page.waitForSelector('#tl-chart .uplot', { timeout: 10000 });
// --- Replay of the user's FatMaxxer file + SmO2 attach: need the owner's private exports (test/data/README.md) ---
const havePrivate = existsSync('test/data/fatmaxxer_rr_123618.csv') && existsSync('test/data/trainred_session.csv');
if (!havePrivate) console.log('SKIP replay + SmO2 attach (private fixtures not present)');
if (havePrivate) {
  // --- Replay of the user's FatMaxxer file at ×60 ---
  const csv = readFileSync('test/data/fatmaxxer_rr_123618.csv', 'utf8');
  await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg');
  await page.click('#mode-seg button[data-mode=free]'); await page.click('#src-seg button[data-src=replay]'); await page.waitForSelector('#replay-speed');
  await page.evaluate(async (csv) => { const mod = await import('./js/importers.js'); const imp = mod.parseRrCsv(csv, 'rr_123618.csv'); TL.live.replay = { rr: imp.rr, filename: 'rr_123618.csv', durationSec: imp.durationSec }; TL.live.replaySpeed = 60; }, csv);
  await page.click('[data-action=connect]'); await page.waitForSelector('[data-action=start]:not([disabled])'); await page.click('[data-action=start]'); await page.waitForSelector('#lv-hr');
  await page.waitForTimeout(4500); // 178 s of data at ×60 ≈ 3 s → source ends → engine stops itself
  const st = await page.evaluate(async () => { const all = await (await import('./js/store.js')).store.listSessions(); const r = all.find(s => s.sourceKind === 'replay'); return { state: TL.engine.state, n: r ? r.rr.length : 0, feats: r ? r.features.length : 0, final: r?.final }; });
  check('replay consumed all RR and auto-saved', st.n === 225 && st.final === true && st.state !== 'running', JSON.stringify(st));
  // finished session must be saved: the engine stops itself on source end → UI should offer save; we call finalize via stop button if still visible
  if (await page.$('[data-action=stop]')) { await page.click('[data-action=stop]'); if (await page.$('.modal [data-x=yes]')) await page.click('.modal [data-x=yes]'); }
  await page.waitForTimeout(1500);
  const saved = await page.evaluate(() => TL.sessions.some(s => (s.sourceKind || '') === 'replay' && s.final));
  check('replay session saved', saved);
  // --- Attach SmO2: import Train.Red CSV, then attach to the replay session via modal ---
  await page.click('#nav button[data-view=analysis]'); await page.waitForSelector('[data-action=import]');
  await (await page.$('#file-input')).setInputFiles(['test/data/trainred_session.csv']); await page.waitForTimeout(1500);
  const sid = await page.evaluate(() => TL.sessions.find(s => (s.sourceKind || '') === 'replay')?.id);
  await page.evaluate((id) => document.querySelector(`[data-action=open-session][data-id="${id}"]`).click(), sid); await page.waitForSelector('[data-action=attach-smo2]');
  await page.click('[data-action=attach-smo2]'); await page.waitForSelector('.modal [data-imp]'); await page.click('.modal [data-imp]'); await page.waitForTimeout(1500);
  const sm = await page.evaluate(() => ({ n: TL.detail.smo2?.series?.length, off: TL.detail.smo2?.offsetMs }));
  check('SmO2 attached to session', sm.n === 15561, JSON.stringify(sm));
  await shot('23-smo2-attached');
}
// --- backup download ---
await page.click('#nav button[data-view=settings]'); await page.waitForSelector('[data-action=backup]');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=backup]')]);
const path = await dl.path(); const json = JSON.parse(readFileSync(path, 'utf8'));
check('backup JSON contains sessions', json.app === 'treadmill-lab' && json.sessions.length >= (havePrivate ? 3 : 2), `${json.sessions.length} sessions, ${json.imports.length} imports`);
// language switch to English only
await page.selectOption('[data-set="profile.lang"]', 'en'); await page.waitForTimeout(300);
check('English-only renders', (await page.textContent('#view')).includes('Profile'));
await shot('24-settings-en');
await browser.close();
console.log('errors:', errors.filter(e => !/en-US@posix/.test(e)));
console.log(fails ? `${fails} FAILURE(S)` : 'ALL PASS'); process.exit(fails ? 1 : 0);

// Headless (dev server on :8765): the two-lap LT1 verification run through the UI with the demo strap (×60) — setup card, cues,
// the lactate prompts in the gap and after lap 2, the session card (laps line, lap-1 label, tags, verdict); the band finder on Home
// after two real passes → 「범위 반영」; Thursday in the plan; Settings (resting-lactate date, sampling checklist); the one-time fixes.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs'; import { tmpdir } from 'node:os';
const SHOTS = process.env.TL_SHOTS || `${tmpdir()}/treadmill-lab-shots`; mkdirSync(SHOTS, { recursive: true });
const base = 'http://127.0.0.1:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 384, height: 700 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
let fails = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) fails++; };
const shot = n => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
const text = () => page.evaluate(() => document.getElementById('view').textContent);
await page.goto(base, { waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
// ---- 1. the one-time fixes: zones 147 @ 8.5 (the drifted value) → the review's 143 @ 8.7; the 10/5 card's 0.5 end value emptied
await page.evaluate(async () => { const { store } = await import('./js/store.js');
  TL.settings.zones = { lt1Hr: 147, lt2Hr: 157, lt1Speed: 8.5, lt2Speed: 10.5, source: 'multi-day lactate', grade: 'C/C', updatedAt: Date.now() - 2 * 86400000 }; TL.settings.migr = { z1117: null, oct5: null }; await TL.saveSettings();
  const t0 = new Date(2026, 9, 5, 6, 30).getTime(); const hrLive = []; for (let i = 0; i < 2100; i++) hrLive.push([t0 + i * 1000, i < 2000 ? 138 : 100]);
  await store.putSession({ id: 'oct5', type: 'free', final: true, sourceKind: 'ble', startedAt: t0, endedAt: t0 + 2100000, speed: 8.5, incline: 1, hrLive, features: [], events: [{ t: t0, type: 'phase', phase: 'work' }, { t: t0 + 2040000, type: 'lactate', value: 0.5 }] }); });
await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#view .card'); await page.waitForTimeout(400);
const mig = await page.evaluate(async () => { const { store } = await import('./js/store.js'); const s = await store.getSession('oct5'); const { lactateChecks } = await import('./js/prescribe.js'); return { z: TL.settings.zones, migr: TL.settings.migr, end: lactateChecks(s).end, removed: s.lactateChecksRemoved, toast: document.getElementById('toast-root').textContent }; });
check('first run of v1.1.17: zones set to the review values 143 @ 8.7 / 157 @ 10.5 (+ testLt1Speed 8.7), flagged done', mig.z.lt1Hr === 143 && mig.z.lt1Speed === 8.7 && mig.z.lt2Hr === 157 && mig.z.lt2Speed === 10.5 && mig.z.testLt1Speed === 8.7 && mig.migr.z1117 > 0, JSON.stringify(mig.z));
check('the 10/5 card: the 0.5 end value is emptied and kept in lactateChecksRemoved', mig.end === null && mig.removed && mig.removed.end === 0.5 && mig.migr.oct5 > 0, JSON.stringify(mig.removed));
await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
const again = await page.evaluate(async () => { const { store } = await import('./js/store.js'); const s = await store.getSession('oct5'); return { z: TL.settings.zones.lt1Hr, at: s.lactateChecksRemoved.at }; });
check('the fixes run once: a second load changes nothing', again.z === 143 && again.at === mig.removed.at);
// ---- 2. Home: the weekly check card (no result yet → the LT1 speed), the plan's Thursday
let home = await text();
check('Home shows the weekly LT1 check with the test speed 8.7 km/h and a way into the two-lap mode', /주간 LT1 검증/.test(home) && /8\.7 km\/h/.test(home) && !!(await page.$('[data-action=go-live][data-mode=verify]')), home.slice(0, 80));
await page.click('#nav button[data-view=plan]'); await page.waitForSelector('.plan-day'); const plan = await text();
check('Plan: Thursday is the two-lap verification run at 8.7 km/h, with the procedure note; the long run says mid sample at 30 min', /LT1 검증 달리기 \(두 랩, 8\.7 km\/h\)/.test(plan) && /간격 60–90초/.test(plan) && /30:00에 중간 채혈/.test(plan), plan.slice(0, 120));
await shot('40-plan-thursday');
// ---- 3. the two-lap run with the demo strap: warm-up 1 min, lap 1 2 min, lap 2 3 min at ×60
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg'); await page.click('#mode-seg button[data-mode=verify]'); await page.waitForSelector('#lap-1');
const setup = await page.evaluate(() => ({ speed: document.getElementById('sess-speed').value, lap1: document.getElementById('lap-1').value, lap2: document.getElementById('lap-2').value, txt: document.getElementById('view').textContent }));
check('setup card: test speed 8.7 (the LT1 speed), lap 1 10 min, lap 2 30 min, the line 0.8 + 0.5 = 1.3, the checklist', setup.speed === '8.7' && setup.lap1 === '10' && setup.lap2 === '30' && /0\.8 \+ 0\.5 = 1\.3/.test(setup.txt) && /첫 방울 닦기/.test(setup.txt), JSON.stringify([setup.speed, setup.lap1, setup.lap2]));
await page.click('#purpose-seg button[data-purpose=mlss]'); await page.waitForSelector('#lap-2'); const mlss = await page.evaluate(() => ({ lap2: document.getElementById('lap-2').value, speed: document.getElementById('sess-speed').value }));
check('MLSS variant: lap 2 = 20 min, speed = the LT2 speed 10.5', mlss.lap2 === '20' && mlss.speed === '10.5', JSON.stringify(mlss));
await page.click('#purpose-seg button[data-purpose=lt1]'); await page.waitForSelector('#lap-2');
await shot('41-verify-setup');
for (const [id, v] of [['#lap-wu', '1'], ['#lap-1', '2'], ['#lap-2', '3']]) { await page.fill(id, v); await page.$eval(id, el => el.dispatchEvent(new Event('change'))); }
await page.click('#src-seg button[data-src=demo]'); await page.selectOption('#demo-speed', '60'); await page.click('[data-action=connect]'); await page.waitForSelector('[data-action=start]:not([disabled])'); await page.click('[data-action=start]'); await page.waitForSelector('#lv-zone');
const lapBtn = () => page.$eval('#lv-lap', el => el.textContent);
check('warm-up: the lap button offers "Start lap 1"', /1랩 시작/.test(await lapBtn()));
await page.waitForFunction(() => TL.engine.phase === 'work' && TL.engine.rep === 1, null, { timeout: 15000 });
const l1 = await page.evaluate(() => ({ btn: document.getElementById('lv-lap').textContent, zone: document.getElementById('lv-zone-text').textContent, lbl: document.getElementById('lv-phase-lbl').textContent }));
check('lap 1 running: banner "랩 1 · 8.7 km/h", phase "랩 1 · 2:00", lap button "End lap"', /랩 1/.test(l1.zone) && /8\.7 km\/h/.test(l1.zone) && /랩 1 · 2:00/.test(l1.lbl) && /랩 종료/.test(l1.btn), JSON.stringify(l1));
await shot('42-verify-lap1');
await page.waitForSelector('#lac-modal', { timeout: 20000 }); // the clock ends lap 1 → gap → the prompt 30 s after the stop
const gap = await page.evaluate(() => ({ phase: TL.engine.phase, title: document.querySelector('#lac-modal h3').textContent, lbl: document.getElementById('lv-phase-lbl').textContent }));
check('the gap: the lactate prompt opens, titled lap 1 (gap)', gap.phase === 'gap' && /랩 1/.test(gap.title) && /간격/.test(gap.lbl), JSON.stringify(gap));
for (const k of ['1', '.', '0']) await page.click(`#lac-modal .keypad button[data-k="${k}"]`); await page.click('#lac-modal [data-x=save]'); await page.waitForTimeout(150); if (await page.$('.rpe')) await page.click('.modal [data-x=skip]');
await page.waitForTimeout(900); // ≈ 90 s of data in the gap
check('in the gap the lap button offers "Start lap 2"', /2랩 시작/.test(await lapBtn()));
await page.click('#lv-lap'); await page.waitForFunction(() => TL.engine.phase === 'work' && TL.engine.rep === 2, null, { timeout: 5000 });
check('lap 2 running: phase "랩 2 · 3:00"', /랩 2 · 3:00/.test(await page.$eval('#lv-phase-lbl', el => el.textContent)));
await page.waitForSelector('#lac-modal', { timeout: 20000 }); // the clock ends lap 2 → done → the prompt
const done = await page.evaluate(() => ({ phase: TL.engine.phase, title: document.querySelector('#lac-modal h3').textContent, btn: document.getElementById('lv-lap').disabled }));
check('after lap 2: phase done, the prompt titled lap 2 end, the lap button disabled', done.phase === 'done' && /랩 2/.test(done.title) && done.btn === true, JSON.stringify(done));
for (const k of ['1', '.', '3']) await page.click(`#lac-modal .keypad button[data-k="${k}"]`); await page.click('#lac-modal [data-x=save]'); await page.waitForTimeout(150); if (await page.$('.rpe')) await page.click('.modal [data-x=skip]');
await page.click('[data-action=stop]'); await page.click('.modal [data-x=yes]'); await page.waitForSelector('#vc-laps', { timeout: 10000 });
const card = await page.evaluate(() => ({ type: TL.detail.type, purpose: TL.detail.purpose, speed: TL.detail.speed, laps: document.getElementById('vc-laps').textContent, mid: document.getElementById('vc-mid').value, end: document.getElementById('vc-end').value, midLbl: document.querySelector('label[for], #vc-mid')?.closest('label')?.textContent || '', verdict: [...document.querySelectorAll('.notice')].map(n => n.textContent).join(' || '), purposeOpts: [...document.querySelectorAll('#vc-purpose option')].map(o => o.value), events: [...document.querySelectorAll('#view table tbody tr')].map(tr => tr.textContent) }));
check('the saved session: type verify, purpose lt1, speed 8.7', card.type === 'verify' && card.purpose === 'lt1' && card.speed === 8.7, JSON.stringify([card.type, card.purpose, card.speed]));
check('card: the laps line — lap 1 2.0 min, HR 5–10 min (n/a: lap 1 shorter than 6 min), gap ≈ 90 s, lap 2 3.0 min', /랩 1 2\.0분/.test(card.laps) && /간격 \d{2,3}초/.test(card.laps) && /랩 2 (2\.[89]|3\.0)분/.test(card.laps), card.laps.slice(0, 160));
check('card: the gap value sits in the lap-1 field (label 랩 1(2분)), the end value in the end field', card.mid === '1' && card.end === '1.3' && /랩 1\(2분\)/.test(card.midLbl), `${card.mid} ${card.end} ${card.midLbl}`);
check('card: the two-lap verdict — pass, +0.2 next week, the line 0.8 + 0.5 = 1.3, no zone button, the band-finder note', /통과 @ 8\.7 km\/h/.test(card.verdict) && /\+0\.2/.test(card.verdict) && !(await page.$('[data-action=apply-verdict]')) && /주간 범위 탐색기|Weekly band finder/.test(await text()), card.verdict.slice(0, 120));
check('card: the purpose select has no "auto" for a two-lap run', card.purposeOpts.join(',') === 'lt1,mlss', card.purposeOpts.join(','));
check('events: the lactate rows carry their tags (lap 1 · 2:00 at speed · s after the stop; lap 2 · 3:00)', card.events.some(r => /랩 1 · 2:00 달림/.test(r) && /정지 후 \d+초/.test(r)) && card.events.some(r => /랩 2 · 3:0\d 달림/.test(r)), card.events.filter(r => /lactate/.test(r)).join(' | '));
await shot('43-verify-card');
// CSV: the two-lap header and the tag columns
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-csv]')]); const { readFileSync } = await import('node:fs'); const csv = readFileSync(await dl.path(), 'utf8');
check('CSV: a two_lap header line with gap_sec and the lap values; event rows with lap / run_s / since_stop_s columns', /^# two_lap,1,lap1_min,2\.0,lap1_hr_5_10,,gap_sec,\d+,lap2_min,(2\.[89]|3\.0),/m.test(csv) && /^event_t_iso,elapsed_s,type,value,stage,phase,lap,run_s,since_stop_s,gap_s$/m.test(csv) && /,lactate,1,,gap,1,120,\d+,\d+$/m.test(csv), csv.split('\n').filter(l => /two_lap|lactate/.test(l)).join(' / ').slice(0, 300));
// ---- 4. the band finder: two real passes (8.7 then 8.9) → Home offers the band change → apply
await page.evaluate(async () => { const { store } = await import('./js/store.js');
  const mk = (id, speed, lap1, end, daysAgo, hr = 140) => { const t0 = Date.now() - daysAgo * 86400000; const S = s => t0 + s * 1000; const hrLive = []; for (let s = 0; s <= 2700; s++) hrLive.push([S(s), s < 300 ? 110 : s < 900 ? hr : s < 980 ? 100 : s < 2780 ? hr : 100]);
    const events = [{ t: S(0), type: 'start', mode: 'verify' }, { t: S(0), type: 'phase', phase: 'warmup' }, { t: S(300), type: 'phase', phase: 'work', rep: 1 }, { t: S(900), type: 'phase', phase: 'gap', rep: 1 }, { t: S(935), type: 'lactate', value: lap1, lap: 1, runSec: 600, sinceStopSec: 35, gapSec: 35 }, { t: S(980), type: 'phase', phase: 'work', rep: 2 }, { t: S(2780), type: 'phase', phase: 'done', rep: 2 }, { t: S(2815), type: 'lactate', value: end, lap: 2, runSec: 1800, sinceStopSec: 35 }, { t: S(2840), type: 'stop', reason: 'user' }];
    for (let s = 2701; s <= 2840; s++) hrLive.push([S(s), s < 2780 ? hr : 100]);
    return { id, type: 'verify', final: true, sourceKind: 'ble', startedAt: S(0), endedAt: S(2840), speed, incline: 1, purpose: 'lt1', laps: { warmupSec: 300, lap1Sec: 600, lap2Sec: 1800, gapCapSec: 180, sampleAtSec: 30 }, hrLive, features: [], events, metrics: { durationSec: 2840, meanHr: hr } }; };
  await store.putSession(mk('wk1', 8.7, 1.0, 1.3, 14)); await store.putSession(mk('wk2', 8.9, 1.0, 1.4, 7)); });
await page.click('#nav button[data-view=home]'); await page.waitForSelector('[data-action=apply-band]', { timeout: 8000 }); home = await text();
check('Home after two passes (8.7, 8.9): this week 9.0 km/h (capped at 8.7 + 0.3), "pass 2 weeks running", the band change LT1 8.7→8.9 offered', /9\.0 km\/h/.test(home) && /통과 2주 연속/.test(home) && /8\.7→8\.9 km\/h/.test(home), home.slice(0, 200));
await shot('44-home-band');
await page.click('[data-action=apply-band]'); await page.waitForTimeout(500);
const z = await page.evaluate(() => TL.settings.zones);
check('「범위 반영」: LT1 speed 8.9, the heart rate stays 143 (lap-1 HR 140 is lower: a floor does not fall), source marked +band', z.lt1Speed === 8.9 && z.lt1Hr === 143 && /\+band/.test(z.source), JSON.stringify(z));
const live = await (async () => { await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg'); await page.click('#mode-seg button[data-mode=verify]'); await page.waitForSelector('#sess-speed'); return page.$eval('#sess-speed', el => el.value); })();
check('the Session tab now proposes 9.0 km/h for this week\'s check', live === '9', live);
// ---- 5. Settings: the resting-lactate date, the sampling checklist; changing the baseline dates it today
await page.click('#nav button[data-view=settings]'); await page.waitForSelector('[data-set="profile.restLactateAt"]'); const st = await text();
check('Settings: resting-lactate "measured on" field (2026-10-09), the sampling checklist, the step-test LT1 speed field', (await page.$eval('[data-set="profile.restLactateAt"]', el => el.value)) === '2026-10-09' && /채혈 체크리스트/.test(st) && /한 부위만/.test(st) && !!(await page.$('[data-set="zones.testLt1Speed"]')));
await page.fill('[data-set="profile.restLactate"]', '0.9'); await page.$eval('[data-set="profile.restLactate"]', el => el.dispatchEvent(new Event('change', { bubbles: true }))); await page.waitForTimeout(300);
const today = new Date().toISOString().slice(0, 10); const rl = await page.evaluate(() => ({ v: TL.settings.profile.restLactate, at: TL.settings.profile.restLactateAt, field: document.querySelector('[data-set="profile.restLactateAt"]').value }));
check('a new resting value dates itself today', rl.v === 0.9 && rl.at === today && rl.field === today, JSON.stringify(rl));
await page.$eval('[data-set="profile.restLactate"]', el => el.blur()); await page.waitForTimeout(300); // (the browser fires its own change on blur after a fill: let it, then date the baseline 40 days back)
await page.evaluate(async () => { TL.settings.profile.restLactateAt = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10); await TL.saveSettings(); });
await page.click('#nav button[data-view=home]'); await page.waitForFunction(() => /측정 후 \d+일/.test(document.getElementById('view').textContent), null, { timeout: 8000 }).catch(() => {}); home = await text();
check('Home reminds to re-measure the baseline when it is 40 days old', /측정 후 (39|40|41)일/.test(home), home.match(/안정 시 젖산[^.]*/)?.[0] || home.slice(0, 300));
await shot('45-home-rest-reminder');
console.log('errors:', errors.length ? errors : 'none');
await browser.close(); console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);

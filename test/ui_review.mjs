// Headless (dev server on :8765), v1.1.35 — the Oct 17 review in the UI: the Plan tab alternates the ladder and the 4×4 and shows
// Friday as rest and Wed/Sun at the low end; a VO₂max Tuesday opens the session screen with the 4×4 structure, 169–179 bpm and 13.0 km/h;
// Settings carries the 3-km pace, the MLSS lactate and the step-test end rule; the session card takes a session RPE; an MLSS pass offers
// its end lactate as the ladder target; the LT2 setup text names the drifting ceiling.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const base = process.env.TL_BASE || 'http://127.0.0.1:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 384, height: 790 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
let fails = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) fails++; };
await page.goto(base, { waitUntil: 'networkidle' }); await page.waitForSelector('#view .card'); await page.waitForTimeout(300);
// the first run set the review thresholds and (v1.1.35) the 3-km pace
const z0 = await page.evaluate(() => ({ ...TL.settings.zones, minStagesPast4: TL.settings.protocol.minStagesPast4 }));
check('first run: 3-km pace 14.1 and the step-test end rule (2 stages past 4 mmol) are set by the migration; no MLSS lactate yet', z0.pace3k === 14.1 && z0.mlssLactate === null && z0.minStagesPast4 === 2, JSON.stringify(z0));
// a plan starting this Monday, hard week 1 = ladder; then move it one week back → this week is hard week 2 = VO₂max
const setStart = weeksBack => page.evaluate(async wb => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7 * wb); const mon = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; Object.assign(TL.settings.plan, { startDate: mon, calendar: '', weekOffset: 0 }); await TL.saveSettings(); }, weeksBack);
const planDays = async () => { await page.click('#nav button[data-view=home]'); await page.click('#nav button[data-view=plan]'); await page.waitForSelector('.plan-day'); await page.waitForTimeout(150); return page.evaluate(() => [...document.querySelectorAll('.plan-day')].map(r => ({ title: r.querySelector('b')?.textContent || '', nums: r.querySelector('.mono')?.textContent || '', text: r.textContent }))); };
await setStart(0); let days = await planDays();
// v1.1.44: four rows — Mon–Thu (the weekday quota), Fri, Sat (the quality / test session: odd weeks the fixed-speed test, even weeks 4×4), Sun (long run 60)
check('Plan, week 1 (v1.1.44): Mon–Thu = the weekday quota (jog 20 × 1, bodyweight × 1, no optional session), 133–140 bpm; Fri rest; Sat the fixed-speed test at 10.5 (154–160 bpm); Sun the long run at 7.5', /평일 할당 — 쉬운 조깅 20분 × 1 · 맨몸 근력 1세트 × 1 · 선택 세션 없음/.test(days[0].title) && /^133–140 bpm$/.test(days[0].nums) && /휴식 \(달리기 없음\)/.test(days[1].title) && /고정 속도 검사 30분 @ 10\.5 km\/h/.test(days[2].title) && /^154–160 bpm · 10\.5 km\/h/.test(days[2].nums) && /롱런|Long run/.test(days[3].title) && /7\.5 km\/h/.test(days[3].nums), JSON.stringify(days.map(d => `${d.title} | ${d.nums}`)));
const tag = await page.evaluate(() => document.querySelector('#view h2').textContent);
check('Plan header: week 1 is tagged the fixed-speed-test week', /고정 속도 검사 주/.test(tag), tag);
await page.evaluate(async () => { TL.settings.quota = { easy: 1, hard: 1, str: 1 }; await TL.saveSettings(); }); days = await planDays();
check('…the optional session switched on: the weekday row names the hill 4×4 (Saturday is the threshold type)', /선택 세션 1 \(VO₂max 언덕 4×4분/.test(days[0].title), days[0].title.slice(0, 160));
await setStart(1); days = await planDays();
check('Plan, week 2: Saturday = VO₂max 4×4 on the treadmill, 169–179 bpm · 13.0 km/h; the optional weekday session is the tempo 25 min (zone 3)', /VO₂max 4×4분 \(트레드밀\)/.test(days[2].title) && /169–179 bpm · 13\.0 km\/h/.test(days[2].nums) && /선택 세션 1 \(템포 25분/.test(days[0].title), JSON.stringify([days[2].title, days[2].nums, days[0].title.slice(0, 100)]));
await page.evaluate(async () => { TL.settings.quota = { easy: 1, hard: 0, str: 1 }; await TL.saveSettings(); });
// Home → the Tuesday session: open the live setup with the VO₂max structure (any weekday: the button is read from the Plan's Tuesday)
const btn = await page.evaluate(() => { const b = [...document.querySelectorAll('[data-action=go-live][data-mode=lt2]')][0]; return b ? { structure: b.dataset.structure, speed: b.dataset.speed } : null; });
if (btn) { // (Home shows Tuesday's button only on a Tuesday; the Plan tab has no start buttons — so drive the same path by hand)
  check('the start button carries the VO₂max structure and 13.0', /"kind":"vo2"/.test(btn.structure) && btn.speed === '13', JSON.stringify(btn));
}
await page.evaluate(async () => { const { lt2Structure } = await import('./js/prescribe.js'); TL.live.mode = 'lt2'; TL.live.lt2 = lt2Structure(2); TL.live.speed = 13; TL.navigate('live'); });
await page.waitForSelector('#lt2-reps'); await page.waitForTimeout(200);
const setup = await page.evaluate(() => ({ h3: document.querySelector('#view h3')?.textContent || '', target: [...document.querySelectorAll('#view .inline')].map(p => p.textContent).join(' | '), reps: document.getElementById('lt2-reps').value, work: document.getElementById('lt2-work').value, speed: document.getElementById('sess-speed').value, text: document.getElementById('view').textContent }));
check('session setup for the VO₂max week: "LT2 세션 — VO₂max 4×4", target 169–179 bpm · 13.0 km/h, 4 reps × 4 min', /VO₂max 4×4/.test(setup.h3) && /169–179 bpm/.test(setup.target) && /13\.0 km\/h/.test(setup.target) && setup.reps === '4' && setup.work === '4' && setup.speed === '13', JSON.stringify({ h3: setup.h3, target: setup.target, reps: setup.reps, work: setup.work, speed: setup.speed }));
await page.evaluate(async () => { const { lt2Structure } = await import('./js/prescribe.js'); TL.live.lt2 = lt2Structure(1); TL.live.speed = 10.5; TL.navigate('home'); TL.navigate('live'); });
await page.waitForSelector('#lt2-reps'); await page.waitForTimeout(200);
const ladder = await page.evaluate(() => ({ h3: document.querySelector('#view h3')?.textContent || '', text: document.getElementById('view').textContent }));
check('session setup for the ladder structure: "사다리" (its description is gone since v1.1.37)', /사다리|ladder/.test(ladder.h3), ladder.h3);
// Settings: the new fields
await page.click('#nav button[data-view=settings]'); await page.waitForSelector('[data-set="zones.pace3k"]');
const st = await page.evaluate(() => ({ pace: document.querySelector('[data-set="zones.pace3k"]').value, mlss: document.querySelector('[data-set="zones.mlssLactate"]').value, past4: document.querySelector('[data-set="protocol.minStagesPast4"]').value, cal: [...document.querySelectorAll('#view p.small.muted')].map(p => p.textContent).find(t => /vo2/.test(t)) || '' }));
check('Settings: 3-km pace 14.1, MLSS lactate empty, stages past 4 mmol = 2, the calendar help names vo2 / ladder / test', st.pace === '14.1' && st.mlss === '' && st.past4 === '2' && /vo2/.test(st.cal) && /ladder/.test(st.cal) && /test/.test(st.cal), JSON.stringify(st));
await page.fill('[data-set="zones.mlssLactate"]', '3.8'); await page.dispatchEvent('[data-set="zones.mlssLactate"]', 'change'); await page.waitForTimeout(300);
const mlssSet = await page.evaluate(async () => { const { ladderLactateWindow } = await import('./js/prescribe.js'); return { z: TL.settings.zones.mlssLactate, w: ladderLactateWindow() }; });
check('typing an MLSS lactate of 3.8 sets the ladder window 3.3–4.3 (own)', mlssSet.z === 3.8 && mlssSet.w.lo === 3.3 && mlssSet.w.hi === 4.3 && mlssSet.w.own === true, JSON.stringify(mlssSet));
// a recorded MLSS check (pass) and an easy run: the session card's RPE field, the MLSS-lactate button, Home's MLSS card
await page.evaluate(async () => {
  const { sessionMetrics } = await import('./js/prescribe.js'); const { store } = await import('./js/store.js'); const now = Date.now();
  const hr = (t0, n, v) => { const a = []; for (let i = 0; i < n; i++) a.push([t0 + i * 1000, v]); return a; };
  const t0 = now - 2 * 86400000; await store.putSession({ id: 'rv-mlss', type: 'free', purpose: 'mlss', final: true, sourceKind: 'ble', startedAt: t0, endedAt: t0 + 1800000, speed: 10.5, incline: 1, hrLive: hr(t0, 1800, 157), features: [], events: [{ t: t0, type: 'phase', phase: 'work' }, { t: t0 + 600000, type: 'lactate', value: 3.4 }, { t: t0 + 1790000, type: 'lactate', value: 3.7 }], tiz: { inSec: 0, totalSec: 0 }, rr: [], metrics: null });
  const t1 = now - 86400000; await store.putSession({ id: 'rv-easy', type: 'lt1', final: true, sourceKind: 'ble', startedAt: t1, endedAt: t1 + 3000000, speed: 8.1, incline: 1, hrLive: hr(t1, 3000, 138), features: [], events: [{ t: t1, type: 'phase', phase: 'work' }], tiz: { inSec: 2400, totalSec: 3000 }, rr: [], metrics: null });
  for (const id of ['rv-mlss', 'rv-easy']) { const s = await store.getSession(id); s.metrics = sessionMetrics(s); await store.putSession(s); }
});
await page.evaluate(() => TL.navigate('analysis', 'rv-easy')); await page.waitForSelector('#vc-rpe'); await page.waitForTimeout(200);
await page.fill('#vc-rpe', '6'); await page.dispatchEvent('#vc-rpe', 'change'); await page.waitForTimeout(500);
const rpe = await page.evaluate(async () => { const { store } = await import('./js/store.js'); const s = await store.getSession('rv-easy'); return { rpe: s.rpe, hint: document.querySelector('#vc-rpe')?.closest('.grid2')?.textContent || '' }; });
check('session card: a session RPE of 6 is stored, and an easy run at 6 is flagged as high', rpe.rpe === 6 && /쉬운 런치고 높음/.test(rpe.hint), JSON.stringify(rpe));
await page.evaluate(() => TL.navigate('analysis', 'rv-mlss')); await page.waitForSelector('#vc-end'); await page.waitForTimeout(300);
const mc = await page.evaluate(() => ({ verdict: [...document.querySelectorAll('#view .notice')].map(n => n.textContent).find(t => /MLSS/.test(t)) || '', btn: document.querySelector('[data-action=save-mlss-lactate]')?.textContent || '', apply: document.querySelector('[data-action=apply-verdict]')?.textContent || '' }));
check('MLSS check card: "통과", two passes before a raise, the end value 3.7 offered as the MLSS lactate; the floor (LT2 ≥ 10.5) still offered by the zone button', /MLSS 이하 통과/.test(mc.verdict) && /통과 2회면 다음 \+0\.3/.test(mc.verdict) && /MLSS 젖산 3\.7/.test(mc.btn) && /LT2/.test(mc.apply || 'LT2'), JSON.stringify(mc).slice(0, 300));
await page.click('[data-action=save-mlss-lactate]'); await page.waitForTimeout(400);
const saved = await page.evaluate(() => TL.settings.zones.mlssLactate); check('pressing it stores 3.7 as the MLSS lactate', saved === 3.7, String(saved));
await page.click('#nav button[data-view=home]'); await page.waitForSelector('#view .card'); await page.waitForTimeout(300);
const home = await page.evaluate(async () => { const h2 = [...document.querySelectorAll('#view h2')].find(h => /MLSS 검증/.test(h.textContent)); const { assessRecent } = await import('./js/prescribe.js'); const { store } = await import('./js/store.js'); const ins = assessRecent(await store.listSessions(), TL.settings.zones, TL.settings.zones.updatedAt, { restLactateAt: TL.settings.profile.restLactateAt }); return { card: h2 && h2.nextElementSibling ? h2.nextElementSibling.textContent : '', mp: TL.mlssPasses ? { passes: TL.mlssPasses.passes, next: TL.mlssPasses.nextSpeed, ko: TL.mlssPasses.ko } : null, ins: ins.notes.map(n => n.ko).join(' | ') }; });
check('Home: the MLSS card is gone once the lactate is saved (v1.1.37: a card only with something to press); the passes read pass at 10.5, 1/2, next check at the same speed; the insights carry the RPE fatigue flag', home.card === '' && home.mp && home.mp.passes === 1 && home.mp.next === 10.5 && /10\.5 km\/h: 통과/.test(home.mp.ko) && /통과 1\/2/.test(home.mp.ko) && /같은 속도/.test(home.mp.ko) && /RPE ≥ 5/.test(home.ins), JSON.stringify(home.mp) + ' || ' + home.ins.slice(0, 120));
check('no console or page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close(); console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);

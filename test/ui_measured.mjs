// Headless (dev server on :8765): a measured result on record and what the screens make of it (v1.1.26). The runs are rebuilt from the
// numbers of their summaries (no recording): 10/4 9.0 km/h → 2.8, 10/9 8.5 → 1.0, 10/10 the long run at 7.8 (0.8 at 30 min), and the
// first real two-lap check, 10/11: 8.7 km/h, lap 1 0.9 → end 0.8, gap 63 s, lap-1 heart rate 145 — a pass.
//   1. one pass changes no zone: thresholds, the easy run's 8.1 and the warm-up's 7.0 stay; the next check is at 8.9 on Home, in the
//      Plan tab, in the setup card's field and in the live banner ("5:00부터 랩 1 8.9 km/h");
//   2. the multi-day curve of points that lie around LT1: LT1 between the points, no LT2, 「이 역치를 존에 적용」 closed, with the reason;
//   3. a second pass (8.9, lap-1 heart rate 147): the curve still offers nothing (its cubic alone would say LT1 7.8 / LT2 9.0); Home
//      offers the band change LT1 8.7 → 8.9 km/h, 143 → 147 bpm, and with it every speed moves up 0.2.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs'; import { tmpdir } from 'node:os';
const SHOTS = process.env.TL_SHOTS || `${tmpdir()}/treadmill-lab-shots`; mkdirSync(SHOTS, { recursive: true });
const base = process.env.TL_BASE || 'http://127.0.0.1:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 384, height: 700 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
let fails = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) fails++; };
const shot = n => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
const noToast = () => page.evaluate(() => { document.getElementById('toast-root').innerHTML = ''; });
const text = () => page.evaluate(() => document.getElementById('view').textContent);
await page.goto(base, { waitUntil: 'networkidle' }); await page.waitForSelector('#view .card'); // first run: thresholds 143 @ 8.7 / 157 @ 10.5

/** Puts rebuilt runs into the store. which = 'first' (10/4, 10/9, 10/10 and the 10/11 check) or 'second' (a pass at 8.9, lap-1 heart rate 147). */
const seed = which => page.evaluate(async which => {
  const { store } = await import('./js/store.js'); const now = Date.now(), DAY = 86400000;
  // a single constant run: heart rate hr0 drifting by `drift` after minute 10; a value typed in the last minute (and one at midSec)
  const single = (id, speed, end, hr0, { durSec = 2100, daysAgo = 1, mid = null, midSec = null, drift = 0 } = {}) => { const t0 = now - daysAgo * DAY; const hrLive = []; for (let i = 0; i <= durSec; i++) hrLive.push([t0 + i * 1000, Math.round(hr0 + drift * Math.max(0, i - 600) / Math.max(1, durSec - 600))]);
    const events = [{ t: t0, type: 'phase', phase: 'work' }]; if (mid != null) events.push({ t: t0 + midSec * 1000, type: 'lactate', value: mid }); events.push({ t: t0 + (durSec - 40) * 1000, type: 'lactate', value: end });
    return { id, type: 'free', final: true, sourceKind: 'ble', startedAt: t0, endedAt: t0 + durSec * 1000, speed, incline: 1, hrLive, features: [], events, metrics: { durationSec: durSec, meanHr: hr0 } }; };
  // a two-lap check as the app records it: 5-min warm-up, lap 1 10 min, the lap-1 value 37 s into a 63-s gap, lap 2 30 min, Finish 29 s
  // after the lap-2 clock with no value typed at the stop — the end value comes from the card (lactateChecks, v2)
  const check = (id, speed, lap1, end, hoursAgo, up = 0) => { const t0 = now - hoursAgo * 3600000; const S = s => t0 + s * 1000; const rise = (from, to, tau, i) => to - (to - from) * Math.exp(-i / tau);
    const hr = s => s < 30 ? 95 : s < 300 ? rise(101, 126, 50, s - 30) : s < 900 ? (s < 600 ? rise(126, 145 + up, 55, s - 300) : 145 + up) : s < 963 ? Math.max(100, 145 + up - 1.1 * (s - 900)) : s < 1023 ? rise(100, 143.5 + up, 22, s - 963) : s < 1323 ? 144 + up : s < 2463 ? 144 + up + 7.3 * (s - 1323) / 1140 : s < 2763 ? 151.3 + up : Math.max(100, 151 + up - 1.2 * (s - 2763));
    const hrLive = []; for (let s = 0; s <= 2792; s++) hrLive.push([S(s), Math.round(hr(s))]);
    const events = [{ t: S(0), type: 'start', mode: 'verify' }, { t: S(0), type: 'phase', phase: 'warmup' }, { t: S(300), type: 'phase', phase: 'work', rep: 1 }, { t: S(900), type: 'phase', phase: 'gap', rep: 1 }, { t: S(937), type: 'lactate', value: lap1, lap: 1, runSec: 600, sinceStopSec: 37, gapSec: 37 }, { t: S(963), type: 'phase', phase: 'work', rep: 2 }, { t: S(2763), type: 'phase', phase: 'done', rep: 2 }, { t: S(2792), type: 'stop', reason: 'user' }];
    return { id, type: 'verify', final: true, sourceKind: 'ble', startedAt: S(0), endedAt: S(2792), speed, incline: 1, purpose: 'lt1', laps: { warmupSec: 300, lap1Sec: 600, lap2Sec: 1800, gapCapSec: 180, sampleAtSec: 30 }, hrLive, features: [], events, lactateChecks: { end }, lactateChecksV: 2, metrics: { durationSec: 2792, meanHr: 147 + up } }; };
  const list = which === 'first' ? [single('r104', 9.0, 2.8, 146, { daysAgo: 7, drift: 1 }), single('r109', 8.5, 1.0, 141, { daysAgo: 2, drift: 6 }), single('r1010', 7.8, 1.9, 135, { durSec: 5436, daysAgo: 1, mid: 0.8, midSec: 1800, drift: 9 }), check('oct11', 8.7, 0.9, 0.8, 3)] : [check('next', 8.9, 1.0, 1.0, 1, 2)];
  for (const s of list) await store.putSession(s);
}, which);
const reload = async () => { await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#view .card'); await page.waitForTimeout(300); await noToast(); };
const weekly = () => page.evaluate(() => { const h2 = [...document.querySelectorAll('#view h2')].find(h => /주간 LT1 검증|LT1 검증 \(4주마다\)/.test(h.textContent)); const card = h2 && h2.nextElementSibling; return card ? { text: card.textContent, speed: card.querySelector('[data-action=go-live]')?.dataset.speed ?? null, band: !!card.querySelector('[data-action=apply-band]') } : null; });
const planDays = async () => { await page.click('#nav button[data-view=plan]'); await page.waitForSelector('.plan-day'); return page.evaluate(() => [...document.querySelectorAll('.plan-day')].map(r => ({ nums: r.querySelector('.mono')?.textContent ?? '', wu: r.querySelector('.wu-line')?.textContent ?? null, head: r.children[1]?.children[0]?.textContent ?? '' }))); }; // Mon … Sun
const curve = async () => { await page.click('#nav button[data-view=home]'); await page.click('#nav button[data-view=analysis]'); await page.waitForSelector('[data-action=apply-multiday]', { timeout: 8000 }); return page.evaluate(() => { const b = document.querySelector('[data-action=apply-multiday]'), card = b.closest('.card'); return { disabled: b.disabled, boxes: [...card.querySelectorAll('.thr-card .box')].map(x => x.textContent), note: document.getElementById('md-note')?.textContent ?? '', rows: [...card.querySelectorAll('tbody tr')].map(r => r.textContent), raw: TL.multiDay.trust.raw }; }); };

// ---- 1. one pass on record ----
await seed('first'); await reload();
const vdTxt = await page.evaluate(async () => { const { store } = await import('./js/store.js'); const { lactateVerdict, lapStats } = await import('./js/prescribe.js'); const s = await store.getSession('oct11'); const ls = lapStats(s); return { ko: lactateVerdict(s).ko, hr: Math.round(ls.lap1Hr), drift: ls.lap2Drift, gap: ls.gapSec }; });
check('the rebuilt 10/11 check reads as its summary did: pass @ 8.7, lap 1 0.9 → end 0.8, gap 63 s, lap-1 heart rate 145, drift ≈ +7', /^통과 @ 8\.7 km\/h: 랩 1 0\.9 → 종료 0\.8 \(상승 -0\.1, 간격 63초\) · 랩 2 드리프트 \+7 bpm/.test(vdTxt.ko) && vdTxt.hr === 145 && vdTxt.drift > 6.5 && vdTxt.drift < 8 && vdTxt.gap === 63, JSON.stringify(vdTxt));
let z = await page.evaluate(() => TL.settings.zones);
check('one pass changes no zone: LT1 143 @ 8.7, LT2 157 @ 10.5', z.lt1Hr === 143 && z.lt1Speed === 8.7 && z.lt2Hr === 157 && z.lt2Speed === 10.5, JSON.stringify(z));
let w = await weekly();
check('Home, weekly check: 8.9 km/h — "10/…, 8.7 km/h: 통과 → 이번 주 검사 속도 8.9 km/h (+0.2)", no band change yet, and the button carries 8.9', w && /^8\.9 km\/h/.test(w.text) && /8\.7 km\/h\): 통과 → 이번 주 검사 속도 8\.9 km\/h \(\+0\.2\)/.test(w.text) && /두 주 연속 같은 결과일 때만/.test(w.text) && w.speed === '8.9' && w.band === false, JSON.stringify(w));
await noToast(); await shot('70-measured-home');
let days = await planDays();
check('Plan: Thursday is the check at 8.9 km/h; the easy days keep 8.1 with the warm-up at 7.0, the long run 7.5', /두 랩, 8\.9 km\/h/.test(days[3].head) && /· 8\.9 km\/h$/.test(days[3].nums) && days[3].wu === '워밍업 5분 · 걷기 5.5 → 7.0(0:30) km/h' && /^133–140 bpm · 8\.1 km\/h$/.test(days[0].nums) && days[0].wu === '워밍업 5분 · 7.0 km/h' && /· 7\.5 km\/h$/.test(days[5].nums), JSON.stringify(days.map(d => `${d.nums} | ${d.wu}`)));
// the check opened from Home: the field, then the banner
await page.click('#nav button[data-view=home]'); await page.waitForSelector('[data-action=go-live][data-mode=verify]'); await page.click('[data-action=go-live][data-mode=verify]'); await page.waitForSelector('#sess-speed');
check('the check opened from Home: 8.9 in the speed field; the warm-up line walk 5.5 → 7.0', await page.inputValue('#sess-speed') === '8.9' && await page.textContent('#wu-line') === '워밍업 5분: 걷기 5.5 → 7.0(0:30) km/h', `${await page.inputValue('#sess-speed')} | ${await page.textContent('#wu-line')}`);
await page.click('#src-seg button[data-src=demo]'); await page.selectOption('#demo-speed', '30'); await page.click('[data-action=connect]'); await page.waitForSelector('[data-action=start]:not([disabled])'); await page.click('[data-action=start]'); await page.waitForSelector('#lv-zone');
const read = () => { const zt = document.getElementById('lv-zone-text'); return { phase: TL.engine.phase, speed: document.getElementById('lv-speed')?.textContent ?? null, text: zt.textContent, next: zt.querySelector('.wu-next')?.textContent ?? null }; };
let s = await (await page.waitForFunction(`(() => { const read = ${read.toString()}; return TL.engine && TL.engine.phase === 'warmup' && TL.engine.view().phaseElapsed >= 60 ? read() : null; })()`, null, { timeout: 30000 })).jsonValue();
check('live, warm-up from 0:30: the banner 7.0, and under it lap 1 at the next test speed — "5:00부터 랩 1 8.9 km/h"', s.speed === '7.0' && s.next === '5:00부터 랩 1 8.9 km/h', JSON.stringify(s));
s = await (await page.waitForFunction(`(() => { const read = ${read.toString()}; return TL.engine && TL.engine.phase === 'work' && TL.engine.view().phaseElapsed >= 30 ? read() : null; })()`, null, { timeout: 60000 })).jsonValue();
check('live, lap 1: "랩 1 · 8.9 km/h"', s.speed === null && /랩 1 · 8\.9 km\/h/.test(s.text), JSON.stringify(s));
await page.click('[data-action=stop]'); await page.click('.modal [data-x=yes]'); await page.waitForTimeout(800);
// the Session tab on its own, and the easy run beside it
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg'); await page.click('#mode-seg button[data-mode=verify]'); await page.waitForSelector('#mode-seg button.active[data-mode=verify]'); await page.waitForSelector('#sess-speed');
const tabSpeed = await page.inputValue('#sess-speed');
await page.click('#mode-seg button[data-mode=lt1]'); await page.waitForSelector('#mode-seg button.active[data-mode=lt1]'); await page.waitForSelector('#lt1-min');
check('Session tab: the check proposes 8.9; the easy run still 8.1 with "워밍업 5분: 7.0 km/h"', tabSpeed === '8.9' && await page.inputValue('#sess-speed') === '8.1' && await page.textContent('#wu-line') === '워밍업 5분: 7.0 km/h', `${tabSpeed} | ${await page.inputValue('#sess-speed')} | ${await page.textContent('#wu-line')}`);

// ---- 2. the multi-day curve of points around LT1 ----
let c = await curve();
check('curve: four points — 7.8 → 0.8 (30′), 8.5 → 1, 8.7 → 0.8 (lap 2, lap 1 0.9, heart rate 145), 9 → 2.8', c.rows.length === 4 && /^7\.80\.8 \(30′\)/.test(c.rows[0]) && /^8\.51/.test(c.rows[1]) && /^8\.70\.8 \(랩 2 30′ · 랩 1 0\.9\)145/.test(c.rows[2]) && /^92\.8/.test(c.rows[3]), JSON.stringify(c.rows));
check('curve: LT1 145 bpm at 8.7 km/h (between 8.7 and 9.0); LT2 has no value', /145 bpm8\.7 km\/h$/.test(c.boxes[0]) && /– bpm– km\/h$/.test(c.boxes[1]), JSON.stringify(c.boxes));
check('curve: 「이 역치를 존에 적용」 is closed, and the note says why and where a zone change comes from', c.disabled === true && /LT2는 5점 이상이고 4\.0 mmol\/L에 닿은 곡선에서만/.test(c.note) && /「이 역치를 존에 적용」은 LT1·LT2가 모두 이 곡선에서 나올 때만/.test(c.note) && /홈의 「범위 반영」/.test(c.note) && /Apply these thresholds/.test(c.note), c.note.slice(0, 160));
await page.evaluate(() => { const b = document.querySelector('[data-action=apply-multiday]'); b.disabled = false; b.click(); }); await page.waitForTimeout(400); // even when forced
z = await page.evaluate(() => TL.settings.zones);
check('…a forced press writes nothing: thresholds still 143 @ 8.7 / 157 @ 10.5', z.lt1Hr === 143 && z.lt1Speed === 8.7 && z.lt2Hr === 157 && z.lt2Speed === 10.5 && !/multi-day/.test(z.source || ''), JSON.stringify(z));
await page.evaluate(() => document.querySelector('[data-action=apply-multiday]').scrollIntoView({ block: 'end' })); await noToast(); await page.screenshot({ path: `${SHOTS}/71-measured-curve.png` });

// ---- 3. a second pass ----
await seed('second'); await reload();
c = await curve();
check('five points: the cubic on its own would say LT1 under 8.5 km/h and LT2 under 9.0 — neither is shown', c.rows.length === 5 && c.raw.lt1.x < 8.5 && c.raw.lt2.x < 9.0 && /bpm8\.9 km\/h$/.test(c.boxes[0]) && /– bpm– km\/h$/.test(c.boxes[1]), JSON.stringify({ raw: c.raw, boxes: c.boxes }));
check('…the note: LT1 read between 8.9 and 9.0; the highest value 2.8 is under 4.0, so no LT2; apply stays closed', c.disabled === true && /두 점\(8\.9 · 9\.0 km\/h\) 사이에서 읽었습니다/.test(c.note) && /가장 높은 젖산이 2\.8 mmol\/L\(4\.0 미만\)/.test(c.note) && /MLSS 검증·계단 테스트/.test(c.note), c.note.slice(0, 200));
await page.click('#nav button[data-view=home]'); await page.waitForSelector('[data-action=apply-band]', { timeout: 8000 }); w = await weekly();
check('Home after the second pass: the band change LT1 143→147 bpm, 8.7→8.9 km/h is offered; this week 9.0 (the cap)', /^9\.0 km\/h/.test(w.text) && /통과 2주 연속/.test(w.text) && /LT1 143→147 bpm, LT1 8\.7→8\.9 km\/h/.test(w.text) && w.band === true, w.text.slice(0, 200));
await page.click('[data-action=apply-band]'); await page.waitForTimeout(500); z = await page.evaluate(() => TL.settings.zones);
check('「범위 반영」: LT1 147 @ 8.9; LT2 untouched', z.lt1Hr === 147 && z.lt1Speed === 8.9 && z.lt2Hr === 157 && z.lt2Speed === 10.5, JSON.stringify(z));
days = await planDays();
check('…and every speed follows: easy run 8.3 (137–144 bpm), warm-up 7.2, long run 7.7, the ladder\'s ramp 7.7 → 8.7 → 9.5, the check 9.0 after a walk and 7.2', /^137–144 bpm · 8\.3 km\/h$/.test(days[0].nums) && days[0].wu === '워밍업 5분 · 7.2 km/h' && /· 7\.7 km\/h$/.test(days[5].nums) && (days[1].wu === '워밍업 10분 · 7.7 → 8.7(4:00) → 9.5(7:00) km/h' || (!/사다리|ladder/i.test(days[1].nums + days[1].wu) && days[1].wu === '워밍업 5분 · 7.2 km/h')) /* (Tuesday is the ladder only in a ladder week; in the recovery week 10/12–18 it is an easy run) */ && /· 9\.0 km\/h$/.test(days[3].nums) && days[3].wu === '워밍업 5분 · 걷기 5.5 → 7.2(0:30) km/h', JSON.stringify(days.map(d => `${d.nums} | ${d.wu}`)));
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg'); await page.click('#mode-seg button[data-mode=lt2]'); await page.waitForSelector('#mode-seg button.active[data-mode=lt2]');
const ladder = await page.evaluate(() => document.querySelector('#view .card').textContent);
await page.click('#mode-seg button[data-mode=lt1]'); await page.waitForSelector('#mode-seg button.active[data-mode=lt1]'); await page.waitForSelector('#lt1-min');
check('Session tab after the change: easy run 8.3 in the field, "워밍업 5분: 7.2 km/h"; the ladder\'s recovery jog 6.7', await page.inputValue('#sess-speed') === '8.3' && await page.textContent('#wu-line') === '워밍업 5분: 7.2 km/h' && /회복 조깅 6\.7 km\/h/.test(ladder), `${await page.inputValue('#sess-speed')} | ${await page.textContent('#wu-line')} | ${(ladder.match(/회복 조깅 [\d.]+ km\/h/) || [''])[0]}`);

check('no console or page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
console.log('errors:', errors.length ? errors : 'none');
await browser.close(); console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);

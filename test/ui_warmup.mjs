// Headless (dev server on :8765): the speed to set, on the screen (v1.1.26) — one speed, never a range. Its own warm-up line on Home,
// in the Plan tab and on the setup cards (following the warm-up minutes as they are typed); during a session the large banner: the
// speed to set now and what comes next, step by step — the warm-up of every mode (easy run, two-lap check, MLSS variant, LT2 ladder,
// step test), the easy run's main speed until judging starts, the ladder's recovery and cool-down. The voice says the same. Demo strap.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs'; import { tmpdir } from 'node:os';
const SHOTS = process.env.TL_SHOTS || `${tmpdir()}/treadmill-lab-shots`; mkdirSync(SHOTS, { recursive: true });
const base = process.env.TL_BASE || 'http://127.0.0.1:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 384, height: 700 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
let fails = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) fails++; };
const shot = n => page.screenshot({ path: `${SHOTS}/${n}.png` });
const noToast = () => page.evaluate(() => { document.getElementById('toast-root').innerHTML = ''; });
const RANGE = /\d\.\d\s*[–-]\s*\d+\.\d\s*km\/h|\d\.\d에서 \d/; // a speed given as a range ("7.0–7.5 km/h", "7.0에서 7.5")
await page.goto(base, { waitUntil: 'networkidle' }); await page.waitForSelector('#view .card'); // first run: thresholds 143 @ 8.7 / 157 @ 10.5
const z = await page.evaluate(() => TL.settings.zones);
check('first run: thresholds 143 @ 8.7 / 157 @ 10.5 (the numbers below follow from them)', z.lt1Speed === 8.7 && z.lt2Speed === 10.5, JSON.stringify(z));

// ---- 1. Plan tab and Home: one speed per day, and the warm-up line of every kind of day ----
// this week = week 1 of a plan that starts this Monday; `kind` puts one calendar entry on it (mlss / step / blood)
const setWeek = kind => page.evaluate(async kind => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); const mon = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; Object.assign(TL.settings.plan, { startDate: mon, calendar: kind ? `${mon} ${kind}` : '', weekOffset: 0 }); await TL.saveSettings(); }, kind);
const planDays = async () => { await page.click('#nav button[data-view=home]'); await page.click('#nav button[data-view=plan]'); await page.waitForSelector('.plan-day'); return page.evaluate(() => [...document.querySelectorAll('.plan-day')].map(r => ({ wu: r.querySelector('.wu-line')?.textContent ?? null, nums: r.querySelector('.mono')?.textContent ?? '', run: (c => { c.querySelectorAll('.eve').forEach(e => e.remove()); return c.textContent; })(r.children[1].cloneNode(true)) }))); }; // Mon … Sun; run = the day's running lines (not the noon / evening exercise; since v1.1.27 they sit behind the title)
const EASY = '워밍업 5분 · 7.0 km/h', LADDER = '워밍업 10분 · 7.5 → 8.5(4:00) → 9.5(7:00) km/h', CHECK = '워밍업 5분 · 걷기 5.5 → 7.0(0:30) km/h', MLSS = '워밍업 5분 · 7.5 → 8.5(2:00) km/h', STEP = '워밍업 5분 · 걷기 5.5 km/h';
await setWeek(''); let days = await planDays(); let rows = days.map(d => d.wu);
check('Plan, a ladder week: easy runs and the long run warm up at 7.0 · ladder 7.5 → 8.5 → 9.5 with its times · two-lap check walk 5.5 → 7.0', JSON.stringify(rows) === JSON.stringify([EASY, LADDER, EASY, CHECK, EASY, EASY, EASY]), JSON.stringify(rows));
check('Plan: every day names one speed — easy 8.1, ladder 10.5, check 8.7, long run 7.5', /^133–140 bpm · 8\.1 km\/h$/.test(days[0].nums) && /· 10\.5 km\/h/.test(days[1].nums) && /· 8\.7 km\/h$/.test(days[3].nums) && /· 7\.5 km\/h$/.test(days[5].nums), JSON.stringify(days.map(d => d.nums)));
check('Plan: no running line gives a speed as a range', days.every(d => !RANGE.test(d.run)), days.filter(d => RANGE.test(d.run)).map(d => (d.run.match(/.{0,25}\d\.\d\s*[–-]\s*\d+\.\d\s*km\/h/) || d.run.match(/.{0,25}\d\.\d에서 \d/))[0]).join(' | '));
await noToast(); await shot('60-plan-warmup');
const todayIdx = await page.evaluate(() => (new Date().getDay() + 6) % 7);
await page.click('#nav button[data-view=home]'); await page.waitForSelector('#home-warmup');
const home = await page.evaluate(() => { const w = document.getElementById('home-warmup'), card = w.closest('.card'); return { wu: w.textContent, nums: w.previousElementSibling.textContent, head: card.querySelector('.small.muted').getBoundingClientRect().height, lh: parseFloat(getComputedStyle(card.querySelector('.small.muted')).lineHeight) || 18, speed: card.querySelector('[data-action=go-live]')?.dataset.speed ?? null, text: card.textContent }; });
check('Home: today\'s card has the same warm-up line as today\'s row of the plan, under a line with one speed', home.wu === rows[todayIdx] && !RANGE.test(home.nums) && / km\/h$/.test(home.nums), `${home.nums} / ${home.wu}`);
check('Home: the Start button carries that speed into the session, and the day / week line is one line', home.speed != null && home.nums.endsWith(`${(+home.speed).toFixed(1)} km/h`) && home.head < 2 * home.lh, `data-speed ${home.speed}, head ${home.head}px`);
await noToast(); await shot('61-home-warmup');
await setWeek('mlss'); rows = (await planDays()).map(d => d.wu);
check('Plan, an MLSS-check week: Tuesday 7.5 → 8.5 at 2:00', rows[1] === MLSS && rows[3] === CHECK, JSON.stringify(rows));
await setWeek('step'); rows = (await planDays()).map(d => d.wu);
check('Plan, a step-test week: Saturday is the 5-min walk at 5.5', rows[5] === STEP, JSON.stringify(rows));
await setWeek('blood'); rows = (await planDays()).map(d => d.wu);
check('Plan, a blood-test week: Thursday has no run and no warm-up line, Tuesday is an easy run', rows[3] === null && rows[1] === EASY, JSON.stringify(rows));
await setWeek('');

// ---- 2. live: the banner ----
const hookVoice = () => page.evaluate(() => { window.__said = []; const a = TL.alerts; if (a && !a.__hooked) { const sp = a.speak.bind(a), cu = a.cue.bind(a); a.speak = (t, o) => { window.__said.push(t); return sp(t, o); }; a.cue = (t, o) => { if (t) window.__said.push(t); return cu(t, o); }; a.__hooked = true; } });
const said = () => page.evaluate(() => window.__said.slice());
/** Opens the Session tab on `mode` (null = leave the mode as it is), runs `setup`, connects the demo strap at ×speed and presses Start. */
async function start(mode, speed, setup = null) {
  if (mode) { await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg'); await page.click(`#mode-seg button[data-mode=${mode}]`); await page.waitForSelector(`#mode-seg button.active[data-mode=${mode}]`); }
  await page.waitForSelector('#src-seg'); if (setup) await setup();
  await page.click('#src-seg button[data-src=demo]'); await page.selectOption('#demo-speed', String(speed));
  await page.click('[data-action=connect]'); await page.waitForSelector('[data-action=start]:not([disabled])');
  await page.locator('[data-action=start]').scrollIntoViewIfNeeded(); const y0 = await page.evaluate(() => window.scrollY); await hookVoice();
  await page.click('[data-action=start]'); await page.waitForSelector('#lv-zone'); return { y0, y1: await page.evaluate(() => window.scrollY) };
}
const stop = async () => { await page.click('[data-action=stop]'); await page.click('.modal [data-x=yes]'); await page.waitForSelector('#tl-chart .uplot', { timeout: 10000 }); };
const read = () => { const zt = document.getElementById('lv-zone-text'); return { el: Math.round(TL.engine.view().phaseElapsed), phase: TL.engine.phase, cls: document.getElementById('lv-zone').className, speed: document.getElementById('lv-speed')?.textContent ?? null, text: zt.textContent, next: zt.querySelector('.wu-next')?.textContent ?? null, lbl: document.getElementById('lv-phase-lbl').textContent, info: document.getElementById('lv-phase-info').textContent }; };
/** The screen once the phase clock has passed `sec` (a few seconds past a step, so the once-a-second repaint has happened), optionally in a given phase. */
const snap = async (sec, phase = null) => (await page.waitForFunction(`(() => { const read = ${read.toString()}; return TL.engine && TL.engine.state === 'running' && ${phase ? `TL.engine.phase === '${phase}' && ` : ''}TL.engine.view().phaseElapsed >= ${sec} ? read() : null; })()`, null, { timeout: 60000 })).jsonValue();
const snapWhen = async cond => (await page.waitForFunction(`(() => { const read = ${read.toString()}; return (${cond}) ? read() : null; })()`, null, { timeout: 60000 })).jsonValue();
const warm = s => /\bwarm\b/.test(s.cls);
const setNum = async (id, v) => { await page.fill('#' + id, String(v)); await page.$eval('#' + id, el => el.dispatchEvent(new Event('change'))); };

// easy run (LT1 session)
let st = await start('lt1', 30, () => setNum('lt1-min', 20));
check('Start opens the session screen at its top (the Start button was below the fold)', st.y0 > 0 && st.y1 === 0, `scrollY ${st.y0} → ${st.y1}`);
let s = await snap(20);
check('easy run, warm-up: the banner is the speed 7.0, large — one number', warm(s) && s.speed === '7.0' && /^워밍업7\.0km\/h/.test(s.text), JSON.stringify(s));
check('easy run, warm-up: under it the main speed from 5:00; the phase card names the phase without repeating that', s.next === '5:00부터 본 속도 8.1 km/h' && s.lbl === '워밍업 0–5분 / warm-up' && s.info === '', `${s.next} | ${s.lbl} | ${s.info}`);
const big = await page.evaluate(() => ({ speed: parseFloat(getComputedStyle(document.getElementById('lv-speed')).fontSize), body: parseFloat(getComputedStyle(document.body).fontSize), over: document.documentElement.scrollWidth - document.documentElement.clientWidth, inView: (r => r.top >= 0 && r.bottom <= window.innerHeight)(document.getElementById('lv-zone').getBoundingClientRect()), row: document.getElementById('lv-phase-lbl').getBoundingClientRect().top === document.getElementById('lv-elapsed').getBoundingClientRect().top }));
check('the speed is at least 2.4 × the body text, the banner is on the first screen, nothing overflows sideways, the phase label keeps its row', big.speed >= 2.4 * big.body && big.inView && big.over <= 0 && big.row, JSON.stringify(big));
await noToast(); await shot('62-live-lt1-warmup');
s = await snap(312);
check('easy run 5:00–10:00: the banner is the session\'s one speed, 8.1, "심박 판정은 10:00부터" under it', warm(s) && s.speed === '8.1' && /^본 속도8\.1km\/h/.test(s.text) && s.next === '심박 판정은 10:00부터' && s.lbl === '본 구간 / main part' && s.info === '목표 133–140 bpm', JSON.stringify(s));
await noToast(); await shot('62b-live-lt1-main-speed');
s = await snap(612);
check('easy run from 10:00: the banner is the zone state again (목표 133–140), the speed beside the target', !warm(s) && s.speed === null && /목표 133–140/.test(s.text) && s.lbl === '목표 133–140 bpm' && s.info === '8.1 km/h', JSON.stringify(s));
let v = await said();
check('easy run, voice: "워밍업 5분. 시속 7.0." → "본 속도로. 시속 8.1. 판정은 10분부터." — the numbers of the banner, no range', v.includes('워밍업 5분. 시속 7.0.') && v.includes('본 속도로. 시속 8.1. 판정은 10분부터.') && !v.some(t => RANGE.test(t)), v.join(' | '));
await stop();

// a session opened from Home carries the plan's speed (here a long run: 70 min at 7.5); a speed belongs to its mode
await page.click('#nav button[data-view=home]'); await page.waitForSelector('#home-warmup');
await page.evaluate(() => { const b = document.createElement('button'); Object.assign(b.dataset, { action: 'go-live', mode: 'lt1', minutes: '70', speed: '7.5' }); document.getElementById('view').appendChild(b); b.click(); });
await page.waitForSelector('#sess-speed');
check('opened from Home for a long run: the LT1 card has 70 min and 7.5 km/h in its fields', await page.inputValue('#lt1-min') === '70' && await page.inputValue('#sess-speed') === '7.5', `${await page.inputValue('#lt1-min')} ${await page.inputValue('#sess-speed')}`);
st = await start(null, 30);
s = await snap(20);
check('long run, warm-up: 7.0, then "5:00부터 본 속도 7.5 km/h"', warm(s) && s.speed === '7.0' && s.next === '5:00부터 본 속도 7.5 km/h', JSON.stringify(s));
s = await snap(312); v = await said();
check('long run from 5:00: banner and voice give 7.5, the speed of its card', warm(s) && s.speed === '7.5' && v.includes('본 속도로. 시속 7.5. 판정은 10분부터.'), `${JSON.stringify(s)} ${v.join(' | ')}`);
await stop();
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg');
const sp1 = await page.inputValue('#sess-speed'); await page.click('#mode-seg button[data-mode=lt2]'); await page.waitForSelector('#lt2-reps'); const sp2 = await page.inputValue('#sess-speed');
await page.click('#mode-seg button[data-mode=lt1]'); await page.waitForSelector('#lt1-min'); const sp3 = await page.inputValue('#sess-speed');
check('a speed belongs to its mode: 7.5 stays in the LT1 card, the ladder card opens with 10.5, back in LT1 the easy speed 8.1', sp1 === '7.5' && sp2 === '10.5' && sp3 === '8.1', `${sp1} ${sp2} ${sp3}`);

// two-lap LT1 check: 30 s walk, then the jog; lap 1 after it
st = await start('verify', 5);
s = await snap(5);
check('two-lap check 0:00–0:30: "워밍업 걷기" 5.5, next 7.0 from 0:30', warm(s) && s.speed === '5.5' && /^워밍업 걷기/.test(s.text) && s.next === '0:30부터 7.0 km/h', JSON.stringify(s));
check('two-lap check: the phase card names the whole warm-up and the heart-rate rule at its end', s.lbl === '워밍업 · 걷기 5.5 → 7.0(0:30) km/h' && s.info === '5:00에 심박 < 128', `${s.lbl} | ${s.info}`);
await noToast(); await shot('63-live-twolap-walk');
s = await snap(37); v = await said();
check('two-lap check from 0:30: 7.0, next lap 1 at the test speed 8.7 from 5:00', warm(s) && s.speed === '7.0' && /^워밍업7\.0/.test(s.text) && s.next === '5:00부터 랩 1 8.7 km/h', JSON.stringify(s));
check('two-lap check, voice: "…30초 걷기 5.5, 그 다음 시속 7.0." then "시속 7.0으로." at 0:30', v.includes('워밍업 5분. 30초 걷기 5.5, 그 다음 시속 7.0.') && v.includes('시속 7.0으로.') && !v.some(t => RANGE.test(t)), v.join(' | '));
await page.click('#lv-lap'); s = await snapWhen(`TL.engine.phase === 'work' && !/warm/.test(document.getElementById('lv-zone').className)`);
check('two-lap check, lap 1 started: the banner is the lap again (랩 1 · 8.7 km/h)', !warm(s) && s.speed === null && /랩 1 · 8\.7 km\/h/.test(s.text), JSON.stringify(s));
await stop();

// MLSS variant: 2 min at 7.5, then 8.5
st = await start('verify', 10, async () => { await page.click('#purpose-seg button[data-purpose=mlss]'); await page.waitForSelector('#purpose-seg button.active[data-purpose=mlss]'); });
s = await snap(20);
check('MLSS variant 0:00–2:00: 7.5, next 8.5 from 2:00; no heart-rate rule', warm(s) && s.speed === '7.5' && s.next === '2:00부터 8.5 km/h' && s.lbl === '워밍업 · 7.5 → 8.5(2:00) km/h' && s.info === '', JSON.stringify(s));
s = await snap(127);
check('MLSS variant from 2:00: 8.5, next lap 1 at 10.5 from 5:00', warm(s) && s.speed === '8.5' && s.next === '5:00부터 랩 1 10.5 km/h', JSON.stringify(s));
await stop();

// LT2 ladder (2 × 1 min, recovery 1 min, cool-down 2 min): the ramp, the recovery, the cool-down
st = await start('lt2', 30, async () => { for (const [id, val] of [['lt2-reps', 2], ['lt2-work', 1], ['lt2-rest', 1], ['lt2-wu', 10], ['lt2-cd', 2]]) await setNum(id, val); });
s = await snap(30, 'warmup');
check('ladder 0:00–4:00: 7.5, next 8.5 from 4:00', warm(s) && s.speed === '7.5' && s.next === '4:00부터 8.5 km/h' && s.lbl === '워밍업 · 7.5 → 8.5(4:00) → 9.5(7:00) km/h', JSON.stringify(s));
s = await snap(250, 'warmup');
check('ladder 4:00–7:00: 8.5, next 9.5 from 7:00', warm(s) && s.speed === '8.5' && s.next === '7:00부터 9.5 km/h', JSON.stringify(s));
await noToast(); await shot('64-live-ladder-ramp');
s = await snap(430, 'warmup');
check('ladder 7:00–10:00: 9.5, next the intervals at 10.5 from 10:00', warm(s) && s.speed === '9.5' && s.next === '10:00부터 인터벌 10.5 km/h', JSON.stringify(s));
s = await snap(5, 'work');
check('ladder, interval 1: the banner is the zone state with the interval target', !warm(s) && s.speed === null && /목표 154–160/.test(s.text), JSON.stringify(s));
s = await snap(6, 'rest'); await noToast(); await shot('64b-live-ladder-recovery');
check('ladder, recovery: the banner is the recovery speed 6.5, next "다음 인터벌 2/2 · 10.5 km/h"', warm(s) && s.speed === '6.5' && /^회복6\.5km\/h/.test(s.text) && s.next === '다음 인터벌 2/2 · 10.5 km/h' && s.lbl === '회복 1/2 / recovery', JSON.stringify(s));
s = await snap(6, 'cooldown');
check('ladder, cool-down first half: 7.0, next walking 5.5 from 1:00', warm(s) && s.speed === '7.0' && /^쿨다운7\.0km\/h/.test(s.text) && s.next === '1:00부터 걷기 5.5 km/h' && s.lbl === '쿨다운 · 7.0 → 걷기 5.5(1:00) km/h / cool-down', JSON.stringify(s));
s = await snap(66, 'cooldown');
check('ladder, cool-down second half: "쿨다운 걷기" 5.5', warm(s) && s.speed === '5.5' && /^쿨다운 걷기5\.5km\/h/.test(s.text) && s.next === null, JSON.stringify(s));
s = await snapWhen(`TL.engine.phase === 'done' && !/warm/.test(document.getElementById('lv-zone').className)`); v = await said();
check('ladder, after the cool-down: "완료 / done", no interval target', !warm(s) && /^완료 \/ done$/.test(s.text), JSON.stringify(s));
check('ladder, voice: ramp "시속 8.5로." / "시속 9.5로.", recovery "회복. 시속 6.5." — no range', v.includes('시속 8.5로.') && v.includes('시속 9.5로.') && v.includes('회복. 시속 6.5.') && !v.some(t => RANGE.test(t)), v.join(' | '));
await stop();

// step test: the walk
st = await start('test', 10);
s = await snap(10);
check('step test warm-up: "워밍업 걷기" 5.5, next stage 1 at 6.0 from 5:00; the phase card names the phase', warm(s) && s.speed === '5.5' && /^워밍업 걷기/.test(s.text) && s.next === '5:00부터 1단계 6.0 km/h' && s.lbl === '워밍업', JSON.stringify(s));
await page.click('#lv-lap'); s = await snapWhen(`TL.engine.phase === 'work' && !/warm/.test(document.getElementById('lv-zone').className)`);
check('step test, stage 1 started: the banner is the stage again', !warm(s) && s.speed === null && /단계 1/.test(s.text), JSON.stringify(s));
await stop();

// free mode has no warm-up: nothing changes
st = await start('free', 10);
s = await snap(5);
check('free mode: no speed banner', !warm(s) && s.speed === null, JSON.stringify(s));
await stop();

// English display
await page.evaluate(async () => { TL.settings.profile.lang = 'en'; await TL.saveSettings(); });
st = await start('lt1', 30);
s = await snap(20);
check('English display: "Warm-up" 7.0, "from 5:00: main speed 8.1 km/h"', warm(s) && s.speed === '7.0' && /^Warm-up/.test(s.text) && s.next === 'from 5:00: main speed 8.1 km/h', JSON.stringify(s));
await stop();
await page.evaluate(async () => { TL.settings.profile.lang = 'both'; await TL.saveSettings(); });

// ---- 3. setup cards: one speed, and the warm-up line following the minutes typed ----
const line = () => page.evaluate(() => { const el = document.getElementById('wu-line'); return el ? (el.hidden ? '(hidden)' : el.textContent) : null; });
const card = () => page.evaluate(() => document.querySelector('#view .card').textContent);
const mode = async m => { await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg'); await page.click(`#mode-seg button[data-mode=${m}]`); await page.waitForSelector(`#mode-seg button.active[data-mode=${m}]`); };
await mode('lt1'); let c = await card();
check('LT1 setup card: "워밍업 5분: 7.0 km/h", target 133–140 bpm · 8.1 km/h, 8.1 in the speed field, no range', await line() === '워밍업 5분: 7.0 km/h' && /133–140 bpm · 8\.1 km\/h/.test(c) && await page.inputValue('#sess-speed') === '8.1' && !RANGE.test(c), `${await line()} | ${c.replace(/\s+/g, ' ').slice(0, 80)}`);
const tgt = await page.evaluate(() => { const p = document.querySelector('#view .card p'); return { h: p.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(p).lineHeight) || 22 }; });
check('…and its target is one line', tgt.h < 2 * tgt.lh, JSON.stringify(tgt));
await noToast(); await shot('65-setup-lt1-warmup');
await mode('lt2'); c = await card();
check('ladder setup card: the ramp with its times, target 154–160 bpm · 10.5 km/h, recovery jog 6.5, no range', await line() === '워밍업 10분: 7.5 → 8.5(4:00) → 9.5(7:00) km/h' && /154–160 bpm · 10\.5 km\/h/.test(c) && /회복 조깅 6\.5 km\/h/.test(c) && !RANGE.test(c), `${await line()} | ${(c.match(/.{0,25}\d\.\d\s*[–-]\s*\d+\.\d\s*km\/h/) || [''])[0]}`);
await page.fill('#lt2-wu', '12'); check('…12 min typed: the times move with it (6:00, 9:00), before the field is left', await line() === '워밍업 12분: 7.5 → 8.5(6:00) → 9.5(9:00) km/h', await line());
await page.fill('#lt2-wu', '5'); check('…5 min: no ramp, 7.5', await line() === '워밍업 5분: 7.5 km/h', await line());
await page.fill('#lt2-wu', '0'); check('…0 min: the line is hidden', await line() === '(hidden)', await line());
await page.fill('#lt2-wu', '10'); check('…10 min again', await line() === '워밍업 10분: 7.5 → 8.5(4:00) → 9.5(7:00) km/h' && await page.evaluate(() => TL.live.lt2.warmupSec) === 600, await line());
await mode('verify'); await page.click('#purpose-seg button[data-purpose=lt1]'); await page.waitForSelector('#purpose-seg button.active[data-purpose=lt1]'); c = await card();
check('two-lap setup card: walk 5.5 → 7.0 at 0:30, no range (checklist included)', await line() === '워밍업 5분: 걷기 5.5 → 7.0(0:30) km/h' && /4:30 7\.0 km\/h/.test(c) && !RANGE.test(c), `${await line()} | ${(c.match(/.{0,25}\d\.\d\s*[–-]\s*\d+\.\d\s*km\/h/) || [''])[0]}`);
await page.click('#purpose-seg button[data-purpose=mlss]'); await page.waitForSelector('#purpose-seg button.active[data-purpose=mlss]');
check('…MLSS variant: 7.5 → 8.5 at 2:00', await line() === '워밍업 5분: 7.5 → 8.5(2:00) km/h', await line());
await page.fill('#lap-wu', '1'); check('…1-min warm-up: 7.5 only', await line() === '워밍업 1분: 7.5 km/h', await line());
await page.fill('#lap-wu', '5'); await page.click('#purpose-seg button[data-purpose=lt1]'); await page.waitForSelector('#purpose-seg button.active[data-purpose=lt1]');
await mode('test'); check('step-test card keeps its own wording ("워밍업 5분 @ 5.5 km/h"), no second line', await line() === null && /워밍업 5분 @ 5\.5 km\/h/.test(await page.textContent('#view')));
await mode('free'); check('free mode: no warm-up line', await line() === null);

check('no console or page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
console.log('errors:', errors.length ? errors : 'none');
await browser.close(); console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);

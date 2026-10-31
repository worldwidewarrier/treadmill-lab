// Headless (dev server on :8765): v1.1.36 — places. The Plan tab names where each day is run (unit / track / hill / gym), the session
// set-up asks where (motorized treadmill, track / outdoor, non-motorized), a run off the belt has no speed banner or speed cue and is
// recorded with its place; the one-time fix adds the 10/24 Saturday-off line to an install whose calendar has the 10/19 MLSS week.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const base = process.env.TL_BASE || 'http://127.0.0.1:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 384, height: 700 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
let fails = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) fails++; };
await page.goto(base, { waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');

// ---- the fresh install's calendar and the plan tab
const cal = await page.evaluate(() => TL.settings.plan.calendar);
check('a fresh install gets the calendar with the MLSS check on Sun 10/25 and the TOEIC Saturday off', /2026-10-19 mlss MLSS 검증 \(10\/25 일, 헬스장\)/.test(cal) && /2026-10-19 satoff/.test(cal), cal);
await page.evaluate(async () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); const mon = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; Object.assign(TL.settings.plan, { startDate: mon, calendar: '', weekOffset: 0 }); await TL.saveSettings(); });
await page.click('#nav button[data-view=plan]'); await page.waitForSelector('.plan-day');
const tags = await page.evaluate(() => [...document.querySelectorAll('.plan-day .dow .place-tag')].map(e => e.textContent));
// v1.1.44: four rows — Mon–Thu (the weekday quota, at the unit) · Fri · Sat · Sun
check('Plan: every row names its place — Mon–Thu 부대 · Fri 부대 · Sat/Sun 헬스장', tags.join() === '부대,부대,헬스장,헬스장', tags.join());
const wk = await page.evaluate(() => [...document.querySelectorAll('.plan-day')][0].textContent);
check('Plan: Mon–Thu = the weekday quota (jog 20 min × 1 · bodyweight set × 1 · no optional session by default)', /평일 할당 — 쉬운 조깅 20분 × 1 · 맨몸 근력 1세트 × 1 · 선택 세션 없음/.test(wk), wk.slice(0, 120));
const sat = await page.evaluate(() => [...document.querySelectorAll('.plan-day')][2].textContent);
check('Plan: Saturday (week 1, threshold type) = the fixed-speed test at the gym, at the LT2 speed', /고정 속도 검사 30분 @ 10\.5 km\/h/.test(sat) && /헬스장/.test(sat), sat.slice(0, 120));

// ---- a run at the unit: by heart rate, no speed banner, recorded as off the belt
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg'); await page.click('#mode-seg button[data-mode=lt1]'); await page.waitForSelector('#sess-surface');
check('the LT1 card asks where: motorized treadmill (default) / track · outdoor / non-motorized', (await page.inputValue('#sess-surface')) === 'treadmill' && (await page.$$eval('#sess-surface option', o => o.map(x => x.value).join())) === 'treadmill,outdoor,nmt');
await page.selectOption('#sess-surface', 'nmt'); await page.waitForTimeout(200);
check('…choosing non-motorized says the run goes by heart rate and stays out of the curve', /심박으로 달리기/.test(await page.textContent('#view')) && (await page.inputValue('#sess-surface')) === 'nmt');
await page.click('#src-seg button[data-src=demo]'); await page.selectOption('#demo-speed', '30'); await page.click('[data-action=connect]'); await page.waitForSelector('[data-action=start]:not([disabled])');
await page.evaluate(() => { window.__said = []; const a = TL.alerts; const sp = a.speak.bind(a), cu = a.cue.bind(a); a.speak = (t, o) => { window.__said.push(t); return sp(t, o); }; a.cue = (t, o) => { if (t) window.__said.push(t); return cu(t, o); }; });
await page.click('[data-action=start]'); await page.waitForSelector('#lv-zone');
await page.waitForFunction(() => TL.engine.view().phaseElapsed >= 330, null, { timeout: 60000 }); await page.waitForTimeout(1200);
const live = await page.evaluate(() => ({ speed: document.getElementById('lv-speed')?.textContent ?? null, said: window.__said.slice(), meta: TL.engine.meta }));
check('off the belt: no large speed banner and no speed in the voice ("본 속도로. 판정은 10분부터.")', live.speed === null && !live.said.some(t => /시속/.test(t)) && live.said.includes('본 속도로. 판정은 10분부터.') && live.meta.surface === 'nmt' && live.meta.warmup === null, JSON.stringify({ speed: live.speed, said: live.said }));
await page.click('[data-action=stop]'); await page.click('.modal [data-x=yes]'); await page.waitForSelector('#vc-surface', { timeout: 15000 });
const rec = await page.evaluate(() => TL.detail ? TL.detail.surface : null);
check('the saved session carries surface nmt and its card shows it (with the off-belt note)', (await page.inputValue('#vc-surface')) === 'nmt' && /벨트 밖 세션/.test(await page.textContent('#view')), String(rec));
await page.selectOption('#vc-surface', 'treadmill'); await page.waitForTimeout(400);
check('…the place can be corrected on the card (here back to the treadmill)', (await page.inputValue('#vc-surface')) === 'treadmill' && !/벨트 밖 세션/.test(await page.textContent('#view')));

// ---- the one-time fix on an existing install: the old 10/19 MLSS line gets the Saturday-off line once
const OLD = '2026-10-12 recovery 회복주 / recovery week\n2026-10-19 mlss MLSS 검증 (10/20 화) / MLSS check (Tue 10/20)\n2026-10-26 step 계단 테스트 60분 (10/31 토) / step test 60 min (Sat 10/31)';
await page.evaluate(async old => { TL.settings.plan.calendar = old; delete TL.settings.migr.z1136; await TL.saveSettings(); }, OLD);
await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
let c2 = await page.evaluate(() => TL.settings.plan.calendar);
check('z1136: an install with the 10/19 MLSS week gets "2026-10-19 satoff …" once (the MLSS check moves to Sun 10/25)', c2.startsWith(OLD) && (c2.match(/2026-10-19 satoff/g) || []).length === 1, c2);
await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
c2 = await page.evaluate(() => TL.settings.plan.calendar);
check('…a second load adds nothing', (c2.match(/2026-10-19 satoff/g) || []).length === 1);
await page.evaluate(async () => { TL.settings.plan.calendar = '2026-11-09 blood'; delete TL.settings.migr.z1136; await TL.saveSettings(); }); await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
check('…a calendar without that week is left alone', (await page.evaluate(() => TL.settings.plan.calendar)) === '2026-11-09 blood');

check('no console or page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close(); console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);

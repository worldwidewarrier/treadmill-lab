// Headless (dev server on :8765): v1.1.40 — the week by quota (owner 10/23: "시간에 맞춰 하기 어려움 · 실행 가능성 높게 · 데이터로 주기적 개선").
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { tmpdir } from 'node:os'; const S = tmpdir();
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 384, height: 790 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
let f = 0; const ck = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) f++; };
const go = async iso => { await p.clock.setFixedTime(new Date(iso)); await p.goto(process.env.TL_BASE || 'http://127.0.0.1:8765/', { waitUntil: 'networkidle' }); await p.waitForSelector('#view .card'); await p.evaluate(() => { document.getElementById('toast-root').innerHTML = ''; }); };
const title = () => p.$eval('#view h3', e => e.textContent).catch(() => '');
const strip = () => p.$eval('.wk-strip', e => e.textContent).catch(() => '');
const putRun = (iso, type, rpe) => p.evaluate(async ([iso, type, rpe]) => { const r = indexedDB.open('treadmill-lab', 1); await new Promise(res => r.onsuccess = res); const t = r.result.transaction('sessions', 'readwrite'); t.objectStore('sessions').put({ id: 'run-' + iso, type, final: true, sourceKind: 'ble', startedAt: new Date(iso).getTime(), rpe, hrLive: [], rr: [], events: [] }); await new Promise(res => t.oncomplete = res); }, [iso, type, rpe ?? null]);
const tick = async id => { await p.click(`.chk-tap[data-id=${id}]`); await p.waitForTimeout(250); };
await p.clock.install({ time: new Date('2026-11-02T07:00:00+09:00') });
// v1.1.44 (10/31 design): weekday quota = easy jog 1 (0–2), optional session 0 (0–1, opt in), strength 1 (1–2); Saturday = the quality / test session
await go('2026-11-02T07:00:00+09:00'); // Mon of the split-step-test week 1/3
ck('Mon: an easy jog, quota strip 0/1', /쉬운 런 20분/.test(await title()) && /쉬운 조깅 0\/1/.test(await strip()) && /근력 0\/1/.test(await strip()), (await title()) + ' | ' + (await strip()));
ck('Mon: optional session opt-in button, no optional item yet', !!(await p.$('button.wk-tog[data-k=hard][data-to="1"]')) && !/선택 세션 0\/1/.test(await strip()), await strip());
ck('Mon: busy-day button', !!(await p.$('button[data-minutes="20"]')));
ck('Mon: bodyweight rows', !!(await p.$('.chk-tap[data-id=bw_push]')));
ck('Mon: one run row, not tappable, unticked', (await p.$$eval('.chk-tap[data-id^=r_]', r => r.map(x => x.dataset.id + ':' + (x.tagName) + ':' + x.parentElement.classList.contains('on')))).join() === 'r_run:DIV:false');
await go('2026-11-03T07:00:00+09:00'); // Tue: optional session off → still the easy jog
ck('Tue: optional off → the easy jog', /쉬운 런/.test(await title()), await title());
await p.click('button.wk-tog[data-k=hard][data-to="1"]'); await p.waitForTimeout(300);
ck('Tue: optional on → hill 4×4 (Saturday is the threshold type)', /언덕 4×4/.test(await title()) && /선택 세션 0\/1/.test(await strip()), (await title()) + ' | ' + (await strip()));
// skip Tue entirely → Wed still offers the optional session
await go('2026-11-04T07:00:00+09:00');
ck('Wed (Tue missed): optional session moves to Wed', /언덕 4×4/.test(await title()), await title());
await putRun('2026-11-04T06:00:00+09:00', 'lt2'); await tick('bw_push');
await go('2026-11-05T07:00:00+09:00');
ck('Thu: no hard within 48 h → easy jog', /쉬운 런/.test(await title()), await title());
ck('Thu: strip counts optional 1/1 and strength 1/1', /선택 세션 1\/1/.test(await strip()) && /근력 1\/1/.test(await strip()), await strip());
ck('Thu: strength quota met → no bodyweight rows', !(await p.$('.chk-tap[data-id=bw_push]')));
await putRun('2026-11-05T06:00:00+09:00', 'lt1');
await go('2026-11-06T07:00:00+09:00');
ck('Fri: weekday quota done → rest', /휴식/.test(await title()) && !(await p.$('button[data-minutes="20"]')), await title());
await go('2026-11-07T09:00:00+09:00');
ck('Sat: split step test 1/3 + barbell rows', /분할 계단 1\/3/.test(await title()) && !!(await p.$('button[data-action=go-test][data-split="1"]')) && !!(await p.$('.chk-tap[data-id=squat]')), await title());
await p.screenshot({ path: `${S}/quota-sat.png`, fullPage: true });
// review: the quota dates from the 11/2 week (quotaSince) → nothing on Monday 11/9; weeks 11/2 and 11/9 both complete → Monday 11/16 suggests one more easy jog and one more strength set
await go('2026-11-09T07:00:00+09:00');
ck('Mon (blood-test week): easy jog, no optional toggle', /쉬운 런/.test(await title()) && !(await p.$('button.wk-tog')), await title());
ck('Mon 11/9: no review yet (the quota dates from 11/2; two full weeks under it are needed)', !(await p.$('button[data-action=quota][data-k=easy]')));
await putRun('2026-11-10T06:00:00+09:00', 'lt1'); await go('2026-11-10T07:00:00+09:00'); await tick('bw_push');
await go('2026-11-16T07:00:00+09:00');
ck('Mon 11/16 review: suggests 1 → 2 easy jogs and 1 → 2 strength', !!(await p.$('button[data-action=quota][data-k=easy][data-to="2"]')) && !!(await p.$('button[data-action=quota][data-k=str][data-to="2"]')));
await p.click('button[data-action=quota][data-k=easy]'); await p.waitForTimeout(300);
ck('applied: strip shows /2', /쉬운 조깅 0\/2/.test(await strip()), await strip());
ck('no page errors', errs.length === 0, errs.join(' | ').slice(0, 300));
await b.close(); process.exit(f ? 1 : 0);

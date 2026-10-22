// Headless (dev server on :8765): v1.1.40 — the week by quota (owner 10/23: "시간에 맞춰 하기 어려움 · 실행 가능성 높게 · 데이터로 주기적 개선").
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { tmpdir } from 'node:os'; const S = tmpdir();
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 384, height: 790 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
let f = 0; const ck = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) f++; };
const go = async iso => { await p.clock.setFixedTime(new Date(iso)); await p.goto(process.env.TL_BASE || 'http://127.0.0.1:8765/', { waitUntil: 'networkidle' }); await p.waitForSelector('#view .card'); await p.evaluate(() => { document.getElementById('toast-root').innerHTML = ''; }); };
const title = () => p.$eval('#view h3', e => e.textContent).catch(() => '');
const strip = () => p.$eval('.wk-strip', e => e.textContent).catch(() => '');
const tick = async id => { await p.click(`.chk-tap[data-id=${id}]`); await p.waitForTimeout(250); };
await p.clock.install({ time: new Date('2026-11-02T07:00:00+09:00') });
await go('2026-11-02T07:00:00+09:00'); // Mon of a ladder week
ck('Mon: an easy run, quota strip shown', /쉬운 런/.test(await title()) && /쉬운 런 0\/3/.test(await strip()), (await title()) + ' | ' + (await strip()));
ck('Mon: busy-day button', !!(await p.$('button[data-minutes="20"]')));
ck('Mon: bodyweight rows', !!(await p.$('.chk-tap[data-id=bw_push]')));
await go('2026-11-03T07:00:00+09:00'); // Tue: skipped Monday, hard is due
ck('Tue: the hard session', /사다리|VO₂max|언덕/.test(await title()), await title());
// skip Tue entirely → Wed still offers the hard session
await go('2026-11-04T07:00:00+09:00');
ck('Wed (Tue missed): hard moves to Wed', /사다리|VO₂max|언덕/.test(await title()), await title());
await tick('r_main'); await tick('bw_push');
await go('2026-11-05T07:00:00+09:00');
ck('Thu: no hard within 48 h → easy', /쉬운 런/.test(await title()), await title());
ck('Thu: strip counts hard 1/1 and strength 1/2', /고강도 1\/1/.test(await strip()) && /근력 1\/2/.test(await strip()), await strip());
await tick('r_main');
await go('2026-11-06T07:00:00+09:00');
ck('Fri: catch-up easy run while quota left', /쉬운 런/.test(await title()), await title());
await go('2026-11-07T09:00:00+09:00');
ck('Sat: the plan\'s Saturday + barbell rows', !!(await p.$('.chk-tap[data-id=squat]')), await title());
await p.screenshot({ path: `${S}/quota-sat.png`, fullPage: true });
// review: week 11/2 had 1 easy of 3, week 10/26 none → Monday 11/9 suggests fewer easy runs
await go('2026-11-09T07:00:00+09:00');
ck('Mon review: suggests 3 → 2 easy runs', !!(await p.$('button[data-action=quota][data-k=easy][data-to="2"]')));
await p.click('button[data-action=quota][data-k=easy]'); await p.waitForTimeout(300);
ck('applied: strip shows /2', /쉬운 런 0\/2/.test(await strip()), await strip());
ck('no page errors', errs.length === 0, errs.join(' | ').slice(0, 300));
await b.close(); process.exit(f ? 1 : 0);

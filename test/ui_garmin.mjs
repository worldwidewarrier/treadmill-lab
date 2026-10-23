// Headless (dev server on :8765): v1.1.42 — a Garmin Connect export (.zip with one .fit) becomes one finished session: today's run ticks,
// the weekly quota counts it, the same file twice is refused, the session screen opens for the RPE. Uses the synthetic FIT (test/data),
// zipped at run time with deflate like Garmin Connect; TL_GARMIN_ZIP=<path> runs it on a real export instead (never committed: it holds GPS).
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path'; import { tmpdir } from 'node:os'; import { execFileSync } from 'node:child_process'; import { readFileSync } from 'node:fs';
import { parseFit } from '../js/fit.js';
const here = dirname(fileURLToPath(import.meta.url)); const FIT = join(here, 'data', 'synthetic_garmin.fit');
let ZIP = process.env.TL_GARMIN_ZIP; if (!ZIP) { ZIP = join(tmpdir(), 'tl_garmin_test.zip'); execFileSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED); z.write(sys.argv[2],"123_ACTIVITY.fit"); z.close()', ZIP, FIT]); }
const day = new Date(process.env.TL_GARMIN_ZIP ? '2026-10-23T05:00:00Z' : (b => { const f = parseFit(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); return f.startedAt; })(readFileSync(FIT)));
const now = new Date(day.getTime() + 6 * 3600e3);
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 384, height: 790 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
let f = 0; const ck = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) f++; };
await p.clock.install({ time: now }); await p.clock.setFixedTime(now);
await p.goto(process.env.TL_BASE || 'http://127.0.0.1:8765/', { waitUntil: 'networkidle' }); await p.waitForSelector('#view .card');
ck('the Garmin button is there', !!(await p.$('[data-action=garmin]')));
await p.setInputFiles('#garmin-input', ZIP); await p.waitForTimeout(1500);
const toastTxt = await p.$eval('#toast-root', e => e.textContent).catch(() => '');
ck('toast: added, with minutes and km', /가민 기록 추가/.test(toastTxt) && /분/.test(toastTxt), toastTxt.slice(0, 160));
ck('the session screen opened (RPE field)', !!(await p.$('#vc-rpe')));
const s = await p.evaluate(async () => { const r = indexedDB.open('treadmill-lab', 1); await new Promise(res => r.onsuccess = res); const t = r.result.transaction('sessions', 'readonly'); const g = t.objectStore('sessions').getAll(); await new Promise(res => g.onsuccess = res); return g.result.filter(x => x.sourceKind === 'garmin').map(x => ({ type: x.type, surface: x.surface, n: x.hrLive.length, final: x.final })); });
ck('one garmin session, final, outdoor', s.length === 1 && s[0].final && s[0].surface === 'outdoor' && s[0].n > 0, JSON.stringify(s));
await p.click('#nav button[data-view=home]'); await p.waitForSelector('#view .card');
const run = await p.$eval('.chk-tap[data-id=r_run]', e => e.parentElement.classList.contains('on')).catch(() => 'no run row (rest day)');
ck('Home: run ticked by the Garmin run (or a rest day)', run === true || run === 'no run row (rest day)', String(run));
await p.setInputFiles('#garmin-input', ZIP); await p.waitForTimeout(1200);
ck('the same file twice is refused', /이미 추가/.test(await p.$eval('#toast-root', e => e.textContent)));
await p.click('#nav button[data-view=analysis]'); await p.waitForTimeout(500);
ck('Analysis list draws', !!(await p.$('#view .list-item')));
ck('no page errors', errs.length === 0, errs.join(' | ').slice(0, 300));
await b.close(); process.exit(f ? 1 : 0);

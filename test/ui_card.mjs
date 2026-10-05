// Headless: the verification card for recordings that run on after the running stopped — end-of-run line, the "uncertain" state
// and its confirmation, the run end typed by hand, emptied fields, interval sessions, the multi-day table, the CSV line.
// Sessions are simulated and stored directly; needs the dev server on :8765.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { mkdirSync, readFileSync } from 'node:fs'; import { tmpdir } from 'node:os';
const SHOTS = process.env.TL_SHOTS || `${tmpdir()}/treadmill-lab-shots`; mkdirSync(SHOTS, { recursive: true });
let fails = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) fails++; };
const day = 86400000; const NOW = Date.now();
function rng(seed) { let s = (seed >>> 0) || 1; const u = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; const g = () => { let a = 0; while (!a) a = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u()); }; return { u, g }; }
/** Heart rate once a second: segs [{ until (s), hr (bpm | fn), tau, fast (share of a drop that goes within seconds) }] */
function simHr(T0, { segs, seed = 1, noise = 1.5, wander = 1, h0 = 95 }) { const { g } = rng(seed); const out = []; let slow = h0, fast = 0, cur = null; const total = segs[segs.length - 1].until; for (let sec = 0; sec <= total; sec++) { const seg = segs.find(x => sec < x.until) || segs[segs.length - 1]; const target = typeof seg.hr === 'function' ? seg.hr(sec) : seg.hr; if (seg !== cur) { cur = seg; const h = slow + fast; if (seg.fast && target < h) { fast = seg.fast * (h - target); slow = h - fast; } else { slow = h; fast = 0; } } const tau = seg.tau || (target >= slow ? 35 : 60); slow += (target - slow) * (1 - Math.exp(-1 / tau)); fast *= Math.exp(-1 / 15); out.push([T0 + sec * 1000, Math.round(slow + fast + noise * g() + wander * Math.sin(sec / 41 + seed))]); } return out; }
function mk(id, daysAgo, { segs, seed, type = 'free', speed, purpose, lactate = [], phases = null, extra = {} }) {
  const T0 = NOW - daysAgo * day; const hr = simHr(T0, { segs, seed }); const last = hr[hr.length - 1][0];
  const ev = [{ t: T0, type: 'start', mode: type }]; if (phases) for (const [sec, name] of phases) ev.push({ t: T0 + sec * 1000, type: 'phase', phase: name }); else ev.push({ t: T0, type: 'phase', phase: 'work' });
  for (const [sec, v] of lactate) ev.push({ t: T0 + sec * 1000, type: 'lactate', value: v }); ev.push({ t: last, type: 'stop', reason: 'user' }); ev.sort((a, b) => a.t - b.t);
  const features = []; for (let sec = 5; T0 + sec * 1000 <= last; sec += 5) features.push({ t: T0 + sec * 1000, alpha1: 0.42, hr: hr[sec][1], hrInst: hr[sec][1], rmssd: 4, artifactPct: 0.4, samples: 240, phase: 'work', stage: 0, paused: false });
  const s = { id, type, startedAt: T0, endedAt: last, final: true, sourceKind: 'ble', speed, incline: 1, hrLive: hr, features, rr: [], stages: [], events: ev, tiz: { inSec: 0, totalSec: 0 }, pauseMs: 0, alpha1Settings: { windowSec: 120 }, ...extra };
  if (purpose) s.purpose = purpose; return s;
}
const sessions = [
  // LT1 check: 35 min at 138, 90 s standing with the value typed, 3.5 min of walking before Finish
  // (its stored numbers are those an earlier version would have kept: the mean of the whole recording)
  mk('card-lt1', 6, { segs: [{ until: 2100, hr: 138 }, { until: 2190, hr: 96, fast: 0.5 }, { until: 2400, hr: 110, tau: 40 }], seed: 3, speed: 8.6, lactate: [[40, 1.2], [2160, 1.9]], extra: { metrics: { durationSec: 2400, meanHr: 133.4, maxHr: 144, meanAlpha1: 0.42, pctAlphaAbove75: 0, minAlpha1: 0.42, driftPct: -9.1, artifactPct: 0.4, timeInZonePct: null, rrCount: 0 } } }),
  // MLSS check with a 10-min sample
  mk('card-mlss', 5, { segs: [{ until: 600, hr: s => 150 + 6 * Math.min(1, s / 600) }, { until: 675, hr: 112, fast: 0.4 }, { until: 1875, hr: s => 156 + 8 * (s - 675) / 1200 }, { until: 1995, hr: 104, fast: 0.5 }, { until: 2300, hr: 118, tau: 40 }], seed: 5, speed: 10.5, purpose: 'mlss', lactate: [[650, 3.4], [1945, 4.1]] }),
  // nothing typed during the session, value typed in the card afterwards; the recording has a 6.5-min tail
  mk('card-later', 4, { segs: [{ until: 1800, hr: s => 156 + 6 * s / 1800 }, { until: 1900, hr: 108, fast: 0.5 }, { until: 2200, hr: 120, tau: 40 }], seed: 21, speed: 10.8, purpose: 'mlss', extra: { lactateChecks: { end: 4.2 } } }),
  // Finish pressed while running: nothing to find
  mk('card-flat', 2, { segs: [{ until: 2100, hr: 131 }], seed: 8, speed: 8.0, lactate: [[2095, 1.3]] }),
];
{ const segs = [{ until: 600, hr: 125 }]; const ph = [[0, 'warmup']]; let t = 600; for (let i = 0; i < 4; i++) { ph.push([t, 'work']); segs.push({ until: t + 480, hr: 160 + i }); t += 480; if (i < 3) { ph.push([t, 'rest']); segs.push({ until: t + 180, hr: 125, tau: 45 }); t += 180; } } ph.push([t, 'cooldown']); segs.push({ until: t + 90, hr: 110, fast: 0.5 }, { until: t + 300, hr: 118 });
  sessions.push(mk('card-intervals', 1, { segs, seed: 74, type: 'lt2', speed: 10.5, phases: ph, purpose: 'lt1', lactate: [[t + 60, 1.8]] })); } // purpose "LT1 check" on purpose: it must not turn intervals into an LT1 verdict

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 384, height: 700 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light', locale: 'ko-KR', timezoneId: 'Asia/Seoul', acceptDownloads: true });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
await page.evaluate(async list => { const { store } = await import('./js/store.js'); for (const s of list) await store.putSession(s); TL.settings.zones = { lt1Hr: 130, lt2Hr: 150, lt1Speed: 8.0, lt2Speed: 10.0, source: 'manual', grade: 'manual', updatedAt: Date.now() }; await TL.saveSettings(); await TL.refreshLists(); }, sessions);
const open = async id => { await page.evaluate(x => TL.navigate('analysis', x), id); await page.waitForSelector('#vc-end', { timeout: 8000 }); await page.waitForTimeout(200); };
const card = () => page.evaluate(() => ({ runend: document.getElementById('vc-runend')?.value, how: document.getElementById('vc-runend-how')?.textContent || '', last5: document.getElementById('vc-last5')?.textContent || '', confirm: !!document.getElementById('vc-runend-ok'), rest: document.getElementById('vc-rest').value, mid: document.getElementById('vc-mid').value, end: document.getElementById('vc-end').value, notices: [...document.getElementById('vc-end').closest('.card').querySelectorAll('.notice')].map(n => n.textContent), apply: document.querySelector('[data-action=apply-verdict]')?.textContent || null }));
const change = async (sel, v) => { await page.fill(sel, v); await page.$eval(sel, el => el.dispatchEvent(new Event('change'))); await page.waitForTimeout(450); };
const secs = txt => { const p = txt.split(':').map(Number); return p[0] * 60 + p[1]; };

// 1) the LT1 check with a tail
await open('card-lt1'); let c = await card();
check('LT1 check, recording ran on for 5 min: the card measures from the stop (35:00)', Math.abs(secs(c.runend) - 2100) <= 20 && /채혈 값을 입력하기 전/.test(c.how) && /더 기록됨/.test(c.how) && !c.confirm, `${c.runend} · ${c.how.slice(0, 44)}`);
check('  last-5-min heart rate is the running one (138), fields 1.2 / – / 1.9', /심박 13[789] bpm/.test(c.last5) && !/추정/.test(c.last5) && c.rest === '1.2' && c.mid === '' && c.end === '1.9', c.last5.slice(0, 40));
check('  zone button: floor raised to the running heart rate, not to the recovery', /LT1 130→13[789] bpm/.test(c.apply || '') && /8→8\.6 km\/h/.test(c.apply || ''), c.apply);
await page.screenshot({ path: `${SHOTS}/40-card-lt1.png`, fullPage: true });
// 2) MLSS with 10-min sample
await open('card-mlss'); c = await card();
check('MLSS check: 10-min and end value in their fields, verdict by the rise', c.mid === '3.4' && c.end === '4.1' && c.notices.some(n => /10분→종료 상승 0\.7/.test(n)) && Math.abs(secs(c.runend) - 1875) <= 20, `${c.mid}/${c.end} ${c.runend}`);
// 3) value typed afterwards, recording with a tail: uncertain until confirmed
await open('card-later'); c = await card();
check('value typed afterwards + tail: the card says the end is uncertain and offers to confirm it', c.confirm && c.notices.some(n => /달리기 종료 시점 불확실/.test(n)) && /추정/.test(c.how) && /추정 구간/.test(c.last5) && Math.abs(secs(c.runend) - 1800) <= 25, `${c.runend} ${c.how.slice(0, 20)}`);
check('  no proxy verdict and no zone button while it is uncertain', c.notices.some(n => /대리 판정은 보류/.test(n)) && c.apply === null);
await page.screenshot({ path: `${SHOTS}/41-card-uncertain.png`, fullPage: true });
await page.click('#vc-runend-ok'); await page.waitForTimeout(500); c = await card(); const st = await page.evaluate(() => ({ runEndSec: TL.detail.runEndSec, dur: TL.detail.metrics?.durationSec }));
check('  「확정」: the estimate becomes the end (stored), the proxy verdict and the zone button appear', !c.confirm && /직접 입력한 시각/.test(c.how) && Math.abs(st.runEndSec - 1800) <= 25 && !c.notices.some(n => /불확실/.test(n)) && c.notices.some(n => /대리 지표/.test(n)) && /LT2 150→16[0-3] bpm/.test(c.apply || ''), `${st.runEndSec} s · ${c.apply}`);
const zBefore = await page.evaluate(() => ({ ...TL.settings.zones })); await page.click('[data-action=apply-verdict]'); await page.waitForTimeout(400); const zAfter = await page.evaluate(() => ({ ...TL.settings.zones }));
check('  applying it writes exactly what the button said', zAfter.lt2Hr >= 160 && zAfter.lt2Hr <= 163 && zAfter.lt2Speed === 10.8 && zAfter.lt1Hr === zBefore.lt1Hr, `${zBefore.lt2Hr}@${zBefore.lt2Speed} → ${zAfter.lt2Hr}@${zAfter.lt2Speed}`);
await open('card-later'); await change('#vc-runend', ''); c = await card();
check('  emptying the field returns to the automatic estimate', c.confirm && (await page.evaluate(() => TL.detail.runEndSec ?? null)) === null && /추정/.test(c.how));
await change('#vc-runend', '99:00'); c = await card();
check('  a time outside the recording is refused and the field restored', (await page.evaluate(() => TL.detail.runEndSec ?? null)) === null && Math.abs(secs(c.runend) - 1800) <= 25 && /36:40/.test(await page.evaluate(() => document.querySelector('.toast')?.textContent || '')));
await change('#vc-runend', '36:40'); c = await card();
check('  typing the end of the recording ("ran to the end"): taken as it is', !c.confirm && (await page.evaluate(() => TL.detail.runEndSec)) === 2200 && /직접 입력한 시각/.test(c.how));
await change('#vc-runend', '30'); c = await card();
check('  "30" means 30 min', (await page.evaluate(() => TL.detail.runEndSec)) === 1800 && c.runend === '30:00');
// (a phone's number pad has no colon: digits alone and other separators must do)
await change('#vc-runend', '2930'); c = await card(); const d1 = await page.evaluate(() => TL.detail.runEndSec);
await change('#vc-runend', '29.40'); c = await card(); const d2 = await page.evaluate(() => TL.detail.runEndSec);
await change('#vc-runend', '2975'); const c3 = await card(); const d3 = await page.evaluate(() => TL.detail.runEndSec);
check('  "2930" = 29:30, "29.40" = 29:40; "2975" (75 s) is refused', d1 === 1770 && d2 === 1780 && c.runend === '29:40' && d3 === 1780 && c3.runend === '29:40', `${d1} ${d2} ${d3} ${c3.runend}`);
check('  the field asks for a number pad', (await page.getAttribute('#vc-runend', 'inputmode')) === 'numeric');
// 4) fields
await open('card-mlss'); await change('#vc-mid', ''); c = await card();
check('emptying the 10-min field keeps it empty (and the verdict follows)', c.mid === '' && c.end === '4.1' && !c.notices.some(n => /10분→종료 상승/.test(n)), c.notices.map(n => n.slice(0, 30)).join(' | '));
await change('#vc-end', '5.2'); c = await card();
check('typing the end value changes only that field', c.end === '5.2' && c.mid === '' && (await page.evaluate(() => JSON.stringify(TL.detail.lactateChecks))) === '{"mid":null,"end":5.2}');
// 4b) the numbers kept with the session (shown in the list) follow once it has been opened
{ await open('card-lt1'); await page.waitForTimeout(300);
  const kept = await page.evaluate(async () => { const { store } = await import('./js/store.js'); const s = await store.getSession('card-lt1'); return s.metrics; });
  await page.evaluate(() => TL.navigate('analysis')); await page.waitForSelector('#view .list-item'); await page.waitForTimeout(300);
  const row = await page.evaluate(() => document.querySelector('.list-item[data-id=card-lt1] .s')?.textContent || '');
  check('numbers kept with an older session are brought in line when it is opened (list: running heart rate, duration of the recording)', Math.abs(kept.meanHr - 138) < 1 && Math.abs(kept.durationSec - 2400) < 2 && /40:00 · HR 13[789] /.test(row), `${JSON.stringify({ meanHr: kept.meanHr, dur: kept.durationSec })} · ${row.slice(0, 40)}`); }
// 5) Finish while running; intervals
await open('card-flat'); c = await card();
check('Finish pressed while running: end = end of the recording, nothing flagged', c.runend === '35:00' && /기록의 끝/.test(c.how) && !c.confirm && !/추정/.test(c.last5));
await open('card-intervals'); c = await card();
check('4 × 8 min with purpose "LT1 check": interval verdict, no zone button', c.notices.some(n => /마지막 반복 후 젖산 1\.8/.test(n) && /존 변경에는 쓰지 않습니다/.test(n)) && c.apply === null && /마지막 반복의 끝 5분/.test(c.last5), (c.notices[0] || '').slice(0, 50));
// 6) CSV line
await open('card-lt1'); const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-csv]')]); const csv = readFileSync(await dl.path(), 'utf8');
const m = csv.match(/^# run_end_s,(\d+),found_by,(\w+),certain,([01]),last5_hr_bpm,([\d.]+),last5_alpha1,([\d.]*)$/m);
check('CSV export says where the run ended and how that was found', !!m && Math.abs(+m[1] - 2100) <= 20 && m[2] === 'sample' && m[3] === '1' && Math.abs(+m[4] - 138) < 1.5, m ? m[0] : csv.split('\n').slice(0, 5).join(' / '));
// 7) multi-day table
await change('#vc-runend', ''); await open('card-later'); await change('#vc-runend', '');
await page.evaluate(() => TL.navigate('analysis')); await page.waitForSelector('#view h2'); await page.waitForTimeout(500);
const md = await page.evaluate(() => ({ pts: TL.multiDay.points.map(p => [p.x, p.la, Number.isFinite(p.hr) ? Math.round(p.hr) : null, !!p.unsure]), cells: [...document.querySelectorAll('#view table tbody tr')].map(tr => [...tr.children].map(td => td.textContent).join('|')), note: /달리기 종료 시점이 불확실한 세션/.test(document.getElementById('view').textContent) }));
check('multi-day table: the uncertain run shows "?" for its heart rate, the others their running heart rate; intervals are not a point', md.pts.length === 4 && md.pts.find(p => p[0] === 10.8)[3] === true && md.pts.find(p => p[0] === 10.8)[2] === null && md.cells.some(r => /^10\.8\|4\.2\|\?\|\?/.test(r)) && md.note && Math.abs(md.pts.find(p => p[0] === 8.6)[2] - 138) <= 1 && !md.pts.some(p => p[1] === 1.8), JSON.stringify(md.pts));
await page.screenshot({ path: `${SHOTS}/42-multiday-uncertain.png`, fullPage: true });
check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
console.log('errors:', errors.length ? errors : 'none'); errors.length = 0;
// 8) a screen that fails says so and leaves the rest of the app usable
{ await page.evaluate(async () => { const { store } = await import('./js/store.js'); window.__get = store.getSession; store.getSession = async () => { throw new Error('boom-for-test'); }; TL.navigate('analysis', 'card-lt1'); });
  await page.waitForSelector('#render-error', { timeout: 5000 }); const msg = await page.textContent('#render-error');
  await page.evaluate(async () => { const { store } = await import('./js/store.js'); store.getSession = window.__get; });
  await page.click('#nav button[data-view=home]'); await page.waitForSelector('#view .card'); const home = await page.evaluate(() => !document.getElementById('render-error') && document.querySelectorAll('#view .card').length > 0);
  await open('card-lt1'); const back = (await card()).end === '1.9';
  check('a screen that throws shows what happened; the other tabs and the same screen afterwards still work', /표시하지 못했습니다/.test(msg) && /boom-for-test/.test(msg) && home && back && errors.length === 1 && /boom-for-test/.test(errors[0]), msg.slice(0, 60) + ' | errors: ' + errors.length); }
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
await browser.close(); process.exit(fails ? 1 : 0);

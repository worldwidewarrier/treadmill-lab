// Headless: data paths that need no private files — generated FatMaxxer-style RR text and Train.Red-style CSV with heart rate.
// replay from a picked file → session; SmO2 import → auto-attach + clock alignment by heart rate; stage edits; manual thresholds;
// backup → delete everything → restore; CSV export. Needs the dev server on :8765.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const SHOTS = process.env.TL_SHOTS || `${tmpdir()}/treadmill-lab-shots`; mkdirSync(SHOTS, { recursive: true });
const base = process.env.TL_BASE || 'http://127.0.0.1:8765/'; const work = mkdtempSync(join(tmpdir(), 'tl-data-'));
let fails = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) fails++; };
function mkGauss(seed) { let s = seed >>> 0; const r = () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; return () => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }; }
const g = mkGauss(7);

// ---- generated files ----
// 1) RR text, FatMaxxer layout: 20 min at ≈140 bpm rising to ≈150, started 2 h ago (epoch-ms stamps)
const tRun = Date.now() - 2 * 3600000; const rrLines = ['timestamp, rr, since_start']; const hrAt = s => 140 + 10 * Math.min(1, s / 1200) - 35 * Math.exp(-s / 45);
const rrPts = []; // [time of the beat, RR] — also the source of the heart rate the other device logged
{ let t = tRun, w = 0; while (t < tRun + 1200000) { const s = (t - tRun) / 1000; w = 0.97 * w + g(); const rr = Math.round(60000 / hrAt(s) + 0.5 * w + 0.6 * g()); t += rr; rrPts.push([t, rr]); rrLines.push(`${t},${rr},${((t - tRun) / 1000).toFixed(3)}`); } }
// Heart rate as a strap reports it: the mean of the last four beats. Both the app and the SmO2 device log this value from the same
// strap, so the two series differ by the clock offset only (an ideal curve here would lead the app's by a second or two).
const strapHr = (() => { let i = 0; return s => { const t = tRun + s * 1000; while (i < rrPts.length && rrPts[i][0] <= t) i++; const last = rrPts.slice(Math.max(0, i - 4), i); return last.length ? Math.round(60000 / (last.reduce((a, b) => a + b[1], 0) / last.length)) : Math.round(hrAt(0)); }; })();
writeFileSync(join(work, 'rr_generated.csv'), rrLines.join('\n'));
// 2) Train.Red-style export of the same run from a device whose clock is 23 s behind: meta block, header, 10-Hz rows with SmO2, THb and heart rate
const lag = 23; const pad = n => String(n).padStart(2, '0'); const d0 = new Date(tRun - lag * 1000 + 9 * 3600000); // the export writes local wall-clock time; the browser below runs in Asia/Seoul (UTC+9)
const iso = `${d0.getUTCFullYear()}-${pad(d0.getUTCMonth() + 1)}-${pad(d0.getUTCDate())}T${pad(d0.getUTCHours())}:${pad(d0.getUTCMinutes())}:${pad(d0.getUTCSeconds())}.${String(d0.getUTCMilliseconds()).padStart(3, '0')}000`;
const tr = ['Train.Red Export', `Measurement Date,${iso}`, 'Sensor Position,Right VL Quad', 'Sensor ID,TEST-0001', 'Sport,Running', 'Number of Sensors,1', '', 'Timestamp (seconds passed),Lap/Event,SmO2 Unfiltered,SmO2,THb,HbDiff,Muscle State,Heart Rate (BPM)'];
for (let i = 0; i < 12000; i++) { const s = i / 10; const smo = 72 - 9 * (1 - Math.exp(-s / 100)) - 0.1 * s / 60; tr.push(`${s.toFixed(1)},0,${(smo + 0.4 * g()).toFixed(2)},${smo.toFixed(2)},${(24 + 0.2 * g()).toFixed(2)},${(1.2).toFixed(2)},1,${strapHr(s)}`); }
writeFileSync(join(work, 'trainred_generated.csv'), tr.join('\n'));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 384, height: 604 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'ko-KR', timezoneId: 'Asia/Seoul', serviceWorkers: 'block', acceptDownloads: true });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push('pageerror: ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const shot = n => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
await page.goto(base, { waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');

// ---- replay: pick the RR file, run it at ×60 in Free mode with a speed; the source ends → session saved by itself ----
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg'); await page.click('#mode-seg button[data-mode=free]'); await page.click('#src-seg button[data-src=replay]'); await page.waitForSelector('#replay-speed');
await page.evaluate(() => { TL.pendingReplayPick = true; }); await (await page.$('#file-input')).setInputFiles(join(work, 'rr_generated.csv')); await page.waitForTimeout(600);
const picked = await page.evaluate(() => TL.live.replay && { n: TL.live.replay.rr.length, dur: Math.round(TL.live.replay.durationSec) });
check('RR file picked for replay', picked && picked.n > 2500 && Math.abs(picked.dur - 1200) < 5, JSON.stringify(picked));
await page.selectOption('#replay-speed', '60'); await page.fill('#sess-speed', '9'); await page.fill('#free-cues', '');
await page.click('[data-action=connect]'); await page.waitForSelector('[data-action=start]:not([disabled])'); await page.click('[data-action=start]');
await page.waitForSelector('#vc-end', { timeout: 40000 }); // 20 min at ×60 = 20 s, then the detail view opens
const rp = await page.evaluate(() => ({ kind: TL.detail.sourceKind, final: TL.detail.final, speed: TL.detail.speed, rr: TL.detail.rr.length, feats: TL.detail.features.filter(f => Number.isFinite(f.alpha1)).length, start: TL.detail.startedAt, dur: Math.round((TL.detail.endedAt - TL.detail.startedAt) / 1000) }));
check('replay ran to the end and saved itself with the file\'s own clock', rp.kind === 'replay' && rp.final && rp.speed === 9 && rp.rr === picked.n && rp.feats > 150 && rp.start - tRun >= 0 && rp.start - tRun < 90000 && rp.dur > 1100 && rp.dur <= 1202, JSON.stringify(rp));
const sid = await page.evaluate(() => TL.detail.id);

// ---- SmO2 import: attaches to the overlapping session and corrects the 23-s clock difference from heart rate ----
await page.evaluate(() => TL.navigate('analysis')); await page.waitForSelector('[data-action=import]');
await (await page.$('#file-input')).setInputFiles(join(work, 'trainred_generated.csv')); await page.waitForTimeout(2500);
await page.evaluate(id => TL.navigate('analysis', id), sid); await page.waitForSelector('#vc-end');
const sm = await page.evaluate(() => { const s = TL.detail.smo2; return s && { n: s.series.length, pos: s.position, off: Math.round(s.offsetMs / 1000), ok: s.alignment?.ok, mad: s.alignment?.mad, head: document.querySelector('#view p.small.muted')?.textContent.slice(0, 160) }; });
check('SmO2 attached automatically (12000 points, position read)', sm && sm.n === 12000 && sm.pos === 'Right VL Quad', JSON.stringify(sm && { n: sm.n, pos: sm.pos }));
check('clock difference of 23 s found from heart rate and applied (±1 s)', sm && sm.ok === true && Math.abs(sm.off - lag) <= 1 && /심박 교차검증/.test(sm.head), sm && `offset ${sm.off} s, HR mismatch ${sm.mad?.toFixed(2)} bpm`);
const steady = await page.evaluate(async () => { const { smo2Steady } = await import('./js/analysis.js'); const r = smo2Steady(TL.detail); return r && { early: +r.earlyMean.toFixed(1), end: +r.endMean.toFixed(1), slope: +r.slopeEnd.toFixed(2), steady: r.steady, contact: r.contact }; });
check('constant-load SmO2 summary from the attached series', steady && steady.contact === 'ok' && steady.steady === true && Math.abs(steady.slope + 0.1) < 0.08 && steady.early > steady.end, JSON.stringify(steady));
await page.fill('#vc-end', '1.6'); await page.$eval('#vc-end', el => el.dispatchEvent(new Event('change'))); await page.waitForTimeout(500);
check('end lactate typed in the card → verdict', /LT1 아래 확인/.test(await page.textContent('#view')));
await shot('50-replay-smo2');
// CSV export carries the header lines and the RR block
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-csv]')]); const csv = readFileSync(await dl.path(), 'utf8');
check('session CSV: meta, exercise-end line, lactate, SmO2 line, features and RR', /# type,free/.test(csv) && /# exercise_end_s,\d+,end_basis,recording_end,work_bouts,1,recovery_tail_excluded_s,0,/.test(csv) && /# lactate_rest,,lactate_mid,,lactate_end,1.6,verdict,ok/.test(csv) && /# smo2_early_pct/.test(csv) && /t_iso,elapsed_s,hr_bpm,alpha1/.test(csv) && csv.split('\n').filter(l => /^\d{13},\d+,[01]$/.test(l)).length === picked.n, `${csv.length} chars`);

// ---- manual thresholds → Home and Plan ----
await page.click('#nav button[data-view=settings]'); await page.waitForSelector('[data-set="zones.lt1Hr"]');
for (const [k, v] of [['zones.lt1Hr', '140'], ['zones.lt1Speed', '8.4'], ['zones.lt2Hr', '157'], ['zones.lt2Speed', '10.5']]) { await page.fill(`[data-set="${k}"]`, v); await page.$eval(`[data-set="${k}"]`, el => el.dispatchEvent(new Event('change', { bubbles: true }))); await page.waitForTimeout(120); }
await page.click('#nav button[data-view=home]'); await page.waitForSelector('.thr-card');
const lastCard = (await page.textContent('[data-action=open-session]')).replace(/\s+/g, ' ');
check('Home: the last-session card shows its heart rate and α1, not dashes', /HR 1[34]\d · α1 \d\.\d\d/.test(lastCard), lastCard.slice(0, 80));
const home = await page.textContent('#view'); check('Home shows the manual thresholds and a session for today', /140\s*bpm/.test(home) && /157\s*bpm/.test(home) && /8\.4 km\/h/.test(home) && /manual/.test(home), home.replace(/\s+/g, ' ').slice(0, 110));
await page.click('#nav button[data-view=plan]'); await page.waitForSelector('.plan-day');
const plan = await page.evaluate(() => ({ days: document.querySelectorAll('.plan-day').length, zones: document.querySelectorAll('.zone-item').length, note: document.querySelector('#view .card p.small.muted')?.textContent.slice(0, 60), z2: [...document.querySelectorAll('.zone-item')][1]?.textContent.replace(/\s+/g, ' ') }));
check('Plan: 7 days, 5 zones, footnote in minutes', plan.days === 7 && plan.zones === 5 && /\+10분/.test(plan.note), JSON.stringify(plan));
await page.click('[data-action=week-next]'); await page.waitForTimeout(300); const wk = await page.evaluate(() => TL.settings.plan.weekOffset); await page.click('[data-action=week-prev]'); await page.waitForTimeout(300);
check('week ‹ › buttons move and return', wk === 1 && await page.evaluate(() => TL.settings.plan.weekOffset) === 0);

// ---- backup → delete everything → restore ----
await page.click('#nav button[data-view=settings]'); await page.waitForSelector('[data-action=backup]');
const [bk] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=backup]')]); const bkPath = join(work, 'backup.json'); await bk.saveAs(bkPath); const backup = JSON.parse(readFileSync(bkPath, 'utf8'));
check('backup holds the session with its SmO2, the import and the settings', backup.sessions.length === 1 && backup.sessions[0].smo2.series.length === 12000 && backup.imports.length === 1 && backup.settings.zones.lt1Hr === 140, `${backup.sessions.length} session, ${backup.imports.length} import, ${(readFileSync(bkPath).length / 1e6).toFixed(1)} MB`);
await page.click('[data-action=clear-all]'); await page.click('.modal [data-x=yes]'); await page.waitForSelector('#view .card'); await page.waitForTimeout(400);
const wiped = await page.evaluate(async () => { const { store } = await import('./js/store.js'); return { sessions: (await store.listSessions()).length, imports: (await store.listImports()).length, lt1: TL.settings.zones.lt1Hr, view: TL.view }; });
check('delete all: no sessions, no imports, thresholds cleared', wiped.sessions === 0 && wiped.imports === 0 && wiped.lt1 === null && wiped.view === 'home', JSON.stringify(wiped));
await page.click('#nav button[data-view=settings]'); await page.waitForSelector('[data-action=restore]');
await (await page.$('#file-input')).setInputFiles(bkPath); await page.waitForTimeout(2500);
const back = await page.evaluate(async () => { const { store } = await import('./js/store.js'); const all = await store.listSessions(); return { sessions: all.length, smo2: all[0]?.smo2?.series.length, lactate: all[0]?.lactateChecks?.end, imports: (await store.listImports()).length, lt1: TL.settings.zones.lt1Hr, shown: document.querySelector('[data-set="zones.lt1Hr"]')?.value }; });
check('restore brings everything back', back.sessions === 1 && back.smo2 === 12000 && back.lactate === 1.6 && back.imports === 1 && back.lt1 === 140, JSON.stringify(back));
check('…and the Settings screen shows the restored values at once', back.shown === '140', `LT1 field shows "${back.shown}"`);

// ---- demo step test ×60 → stage table edit recalculates; apply; delete ----
await page.evaluate(async () => { Object.assign(TL.settings.protocol, { warmupSec: 30, stageSec: 120, pauseSec: 15, maxStages: 8 }); await TL.saveSettings(); });
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg'); await page.click('#mode-seg button[data-mode=test]'); await page.click('#src-seg button[data-src=demo]'); await page.selectOption('#demo-speed', '60');
await page.click('[data-action=connect]'); await page.waitForSelector('[data-action=start]:not([disabled])'); await page.click('[data-action=start]'); await page.waitForSelector('#lv-hr');
const la = [1.0, 1.1, 1.3, 1.7, 2.4, 3.6, 5.2, 7.0]; let done = 0; const t0 = Date.now();
while (Date.now() - t0 < 60000) { if (await page.$('#lac-modal')) { for (const d of String(la[Math.min(done, 7)]).split('')) await page.click(`#lac-modal .keypad button[data-k="${d}"]`); await page.click('#lac-modal [data-x=save]'); await page.waitForTimeout(80); if (await page.$('.rpe')) await page.click(`.rpe button[data-r="${10 + done}"]`); done++; }
  const st = await page.evaluate(() => ({ phase: TL.engine.phase, stop: TL.engine.stopAdvised, state: TL.engine.state })); if ((st.stop && st.phase === 'pause') || st.phase === 'done' || st.state !== 'running') break; await page.waitForTimeout(120); }
await page.click('[data-action=stop]'); await page.click('.modal [data-x=yes]'); await page.waitForSelector('#stage-table', { timeout: 10000 });
const before = await page.evaluate(() => ({ lt2: TL.detail.result.lt2Speed, stages: TL.detail.stages.length, charts: TL.charts.length }));
await page.fill('#stage-table tr[data-idx="6"] input[data-f="lactate"]', '2.9'); await page.$eval('#stage-table tr[data-idx="6"] input[data-f="lactate"]', el => el.dispatchEvent(new Event('change', { bubbles: true }))); await page.waitForTimeout(700);
const after = await page.evaluate(() => ({ lt2: TL.detail.result.lt2Speed, la6: TL.detail.stages.find(s => s.idx === 6).lactate, charts: TL.charts.length, uplots: document.querySelectorAll('.uplot').length }));
check('step test finished with lactate on every stage', before.stages >= 6 && done >= 6, `${before.stages} stages, ${done} samples`);
check('editing a stage lactate recalculates the thresholds', after.la6 === 2.9 && Number.isFinite(after.lt2) && after.lt2 !== before.lt2, `LT2 ${before.lt2?.toFixed(2)} → ${after.lt2?.toFixed(2)} km/h`);
check('charts are rebuilt, not piled up', after.charts === before.charts && after.uplots === after.charts, `${before.charts} → ${after.charts} chart objects, ${after.uplots} on screen`);
await page.click('[data-action=apply-zones]'); await page.waitForTimeout(400);
check('thresholds of the test applied', await page.evaluate(() => TL.settings.zones.testSessionId === TL.detail.id && /lactate/.test(TL.settings.zones.source)));
await page.click('[data-action=delete-session]'); await page.click('.modal [data-x=yes]'); await page.waitForTimeout(600);
check('session deleted, back on the list', await page.evaluate(async () => TL.view === 'analysis' && !TL.param && !(await (await import('./js/store.js')).store.listSessions()).some(s => s.type === 'test')));

// ---- a backup restored while a session is running: that session keeps its settings, the next one starts with the restored ones ----
const bk2 = join(work, 'backup_settings.json'); writeFileSync(bk2, JSON.stringify({ app: 'treadmill-lab', version: 1, settings: { alpha1: { stepSec: 10, windowSec: 120, artifactMode: 'off', lambda: 500, scales: 'fatmaxxer' } }, sessions: [], imports: [] }));
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg'); await page.click('#mode-seg button[data-mode=free]'); await page.click('#src-seg button[data-src=demo]'); await page.selectOption('#demo-speed', '10');
await page.click('[data-action=connect]'); await page.waitForSelector('[data-action=start]:not([disabled])'); await page.click('[data-action=start]'); await page.waitForSelector('#lv-hr');
const run1 = await page.evaluate(() => ({ step: TL.engine.stepSec, mode: TL.engine.filter.mode }));
await page.click('#nav button[data-view=settings]'); await page.waitForSelector('[data-action=restore]'); await (await page.$('#file-input')).setInputFiles(bk2); await page.waitForTimeout(900);
const mid = await page.evaluate(() => ({ step: TL.engine.stepSec, state: TL.engine.state, want: TL.settings.alpha1.stepSec }));
check('restore during a running session: the session goes on with the settings it started with', mid.state === 'running' && mid.step === run1.step && mid.want === 10, JSON.stringify({ run1, mid }));
await page.click('#nav button[data-view=live]'); await page.waitForSelector('[data-action=stop]'); await page.click('[data-action=stop]'); await page.click('.modal [data-x=yes]'); await page.waitForSelector('#vc-end', { timeout: 10000 });
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg'); await page.click('[data-action=connect]'); await page.waitForSelector('[data-action=start]:not([disabled])'); await page.click('[data-action=start]'); await page.waitForSelector('#lv-hr'); await page.waitForTimeout(400);
const run2 = await page.evaluate(() => ({ step: TL.engine.stepSec, mode: TL.engine.filter.mode, same: TL.engine.settings === TL.settings }));
check('…and the next session uses the restored settings (10-s update, artifact filter off)', run2.step === 10 && run2.mode === 'off' && run2.same, JSON.stringify(run2));
await page.click('[data-action=stop]'); await page.click('.modal [data-x=yes]'); await page.waitForTimeout(600);
await browser.close();
const errs = errors.filter(e => !/en-US@posix/.test(e)); console.log('errors:', errs.length ? errs : 'none'); if (errs.length) fails++;
console.log(fails ? `${fails} FAILURE(S)` : 'ALL PASS'); process.exit(fails ? 1 : 0);

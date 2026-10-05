// node test/test_engine.mjs — session-engine clock and state rules on a hand-driven clock (no timers, no demo source):
// pause freezes the stage / interval / elapsed clocks, numeric settings stay numeric, nothing leaks from one session into the next;
// a stage ends where a pause began when it is closed during the pause; rows written while the strap is silent carry no stale values.
import { SessionEngine } from '../js/session.js';
import { sessionMetrics } from '../js/prescribe.js';
import { summarizeStages, analyzeSession } from '../js/analysis.js';
let failures = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) failures++; };
const alerts = { speak() {}, cue() {}, keepAwake: async () => true, beep() {}, vibrate() {} };
const mkSettings = (alpha1 = {}) => ({ protocol: { warmupSec: 0, stageSec: 60, pauseSec: 10, startSpeed: 8, speedStep: 1, incline: 1, type: 'speed', stopLactate: 6, stopRpe: 17, warmupSpeed: 5.5, maxStages: 4 }, treadmill: {}, alpha1: { artifactMode: 'auto', windowSec: 120, stepSec: 5, lambda: 500, ...alpha1 }, alerts: { zoneExitSec: 30 } });
class ClockSource { // a strap whose clock the test moves by hand; one notification per second with two RR intervals
  constructor() { this.T = 1_700_000_000_000; this.kind = 'clock'; this.status = 'connected'; this.h = {}; }
  now() { return this.T; } on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); } off(ev, fn) { this.h[ev] = (this.h[ev] || []).filter(f => f !== fn); }
  run(sec, hr = 140) { for (let i = 0; i < sec; i++) { this.T += 1000; const rr = 60000 / hr; (this.h.hr || []).forEach(fn => fn({ t: this.T, hr, rr: [rr, rr], contact: true })); } }
}
const boot = (settings, cfg) => { const src = new ClockSource(); const eng = new SessionEngine({ settings, alerts }); eng.setSource(src); eng.configure(cfg); eng.start(); clearInterval(eng.timer); return { src, eng }; };

// ---- pause in a step test: 60-s stage, pause at 20 s for 30 s ----
{
  const { src, eng } = boot(mkSettings(), { mode: 'test' });
  src.run(20); eng.pauseToggle(); const a = eng.view();
  src.run(30); const b = eng.view();
  check('stage countdown stands still while paused', a.phaseLeft === 40 && b.phaseLeft === 40, `${a.phaseLeft} → ${b.phaseLeft}`);
  check('elapsed clock stands still while paused', a.elapsedSec === 20 && b.elapsedSec === 20, `${a.elapsedSec} → ${b.elapsedSec}`);
  eng.pauseToggle(); const c = eng.view();
  check('after resume the stage still has its 40 s', c.phaseLeft === 40 && c.elapsedSec === 20 && eng.phase === 'work', `${c.phaseLeft} s left, phase ${eng.phase}`);
  src.run(39); check('stage is still running 39 s after resume', eng.phase === 'work' && eng.stages.length === 1);
  src.run(2); check('stage ends after 60 s of unpaused time', eng.phase === 'pause' && eng.stages[0].tEnd != null);
  eng.pauseToggle(); src.run(25); const s = eng.stop('test');
  check('finishing while paused counts that pause too', s.pauseMs === 55000, String(s.pauseMs));
  check('features recorded during a pause are flagged', s.features.some(f => f.paused) && s.features.some(f => !f.paused));
}
// ---- pause in an interval session ----
{
  const { src, eng } = boot(mkSettings(), { mode: 'lt2', intervals: { warmupSec: 0, reps: 2, workSec: 120, restSec: 60, cooldownSec: 60 }, targets: { hrLo: 150, hrHi: 160, alphaMin: null } });
  src.run(50); eng.pauseToggle(); src.run(200); eng.pauseToggle();
  check('interval keeps its remaining time across a long pause', eng.phase === 'work' && eng.rep === 1 && Math.round(eng.view().phaseLeft) === 70, `${eng.phase} rep ${eng.rep} left ${eng.view().phaseLeft}`);
  src.run(71); check('interval ends 70 s after resume', eng.phase === 'rest');
  eng.pauseToggle(); eng.lap(); src.run(40); eng.pauseToggle(); // "next block" pressed while paused: the new block starts counting at resume
  const v = eng.view(); check('a block started during a pause begins at resume', eng.phase === 'work' && eng.rep === 2 && Math.round(v.phaseLeft) === 120 && v.phaseElapsed === 0, `${eng.phase} left ${v.phaseLeft}`);
  eng.stop('test');
}
// ---- LT1 session target duration ----
{
  const { src, eng } = boot(mkSettings(), { mode: 'lt1', targets: { hrLo: 130, hrHi: 150, alphaMin: 0.75, durationSec: 600 } });
  src.run(100); eng.pauseToggle(); src.run(100); eng.pauseToggle(); src.run(10);
  check('LT1 countdown excludes paused time', Math.round(eng.view().phaseLeft) === 490, String(eng.view().phaseLeft));
  const s = eng.stop('test'); check('time in zone ignores paused time', s.tiz.totalSec === 110 && s.tiz.inSec === 110, JSON.stringify(s.tiz));
}
// ---- update interval stored as text by the settings <select> ----
{
  const { src, eng } = boot(mkSettings({ stepSec: '10' }), { mode: 'lt1', targets: { hrLo: 130, hrHi: 150, alphaMin: 0.75, durationSec: 600 } });
  src.run(60, 140); src.run(60, 170); const s = eng.stop('test');
  check('stepSec "10" (text) still adds seconds, not characters', s.tiz.totalSec === 120 && s.tiz.inSec === 60, JSON.stringify(s.tiz));
  check('time in zone 50 %', Math.abs(sessionMetrics(s).timeInZonePct - 50) < 1e-9);
  check('a session saved with text counters reports no time in zone instead of nonsense', Number.isNaN(sessionMetrics({ ...s, tiz: { inSec: '0101010', totalSec: '010101010101' } }).timeInZonePct));
}
// ---- RR intervals are counted before Start (connect screen) ----
{
  const src = new ClockSource(); const eng = new SessionEngine({ settings: mkSettings(), alerts }); eng.setSource(src);
  src.run(20, 70); check('RR counter rises before the session starts', eng.view().rrSeen === 40 && eng.view().samples === 0, `rrSeen ${eng.view().rrSeen}`);
  eng.setSource(new ClockSource()); check('RR counter restarts with a new sensor', eng.view().rrSeen === 0);
}
// ---- nothing carried over from the previous session ----
{
  const src = new ClockSource(); const eng = new SessionEngine({ settings: mkSettings(), alerts }); eng.setSource(src);
  eng.configure({ mode: 'lt1', targets: { hrLo: 130, hrHi: 150, alphaMin: 0.75, durationSec: 600 }, meta: { speed: 9, incline: 1 } }); eng.start(); clearInterval(eng.timer); src.run(5); const first = eng.stop('test');
  check('LT1 session keeps its own speed and targets', first.speed === 9 && first.targets.hrLo === 130);
  eng.reset(); eng.configure({ mode: 'test', targets: null, meta: null }); eng.start(); clearInterval(eng.timer); src.run(5); const second = eng.stop('test');
  check('the next step test has no speed and no target band from the session before', second.speed === null && second.incline === null && second.targets === null, JSON.stringify({ speed: second.speed, targets: second.targets }));
  eng.reset(); eng.configure({ mode: 'free', targets: null, meta: { speed: 8, incline: 1 } }); check('configure without targets/meta keys keeps them (undefined ≠ null)', (eng.configure({ mode: 'free' }), eng.meta.speed === 8));
}
// ---- a step-test stage with a pause inside: the stage clock ----
{
  const { src, eng } = boot(mkSettings({}), { mode: 'test', protocol: { warmupSec: 0, stageSec: 180, pauseSec: 30, startSpeed: 8, speedStep: 1, incline: 1, type: 'speed', maxStages: 4 } });
  src.run(150, 160); eng.pauseToggle(); src.run(60, 110); eng.pauseToggle(); src.run(31, 160); // runner steps off at 2:30 for a minute (HR 110), back on, the stage completes
  check('stage with a 60-s pause ends after 180 s of running', eng.phase === 'pause' && eng.stages[0].tEnd != null && (eng.stages[0].tEnd - eng.stages[0].tStart) / 1000 >= 240, `${(eng.stages[0].tEnd - eng.stages[0].tStart) / 1000} s on the clock`);
  src.run(29, 150); src.run(60, 170); const s = eng.stop('test'); const rows = summarizeStages(s); // 30-s sampling phase, then a minute of stage 2
  check('the stage cut short by Finish still gets its row', rows.length === 2 && Math.abs(rows[1].hr - 170) < 0.5 && Math.abs(rows[1].durationSec - 60) <= 1, `${rows.length} rows, stage 2: ${rows[1] && rows[1].durationSec} s, HR ${rows[1] && rows[1].hr.toFixed(1)}`);
}
// ---- "End stage" and Finish pressed during a pause: the stage ended when the pause began ----
{
  const proto = { warmupSec: 0, stageSec: 180, pauseSec: 30, startSpeed: 8, speedStep: 1, incline: 1, type: 'speed', maxStages: 6 };
  const a = boot(mkSettings({}), { mode: 'test', protocol: proto }); a.src.run(100, 150); const pausedAt = a.src.T; a.eng.pauseToggle(); a.src.run(25, 112); a.eng.lap(); // spent: Pause, then "End stage" 25 s later
  check('"End stage" during a pause: stage ends at the start of the pause', a.eng.stages[0].tEnd === pausedAt, `${(a.eng.stages[0].tEnd - a.eng.stages[0].tStart) / 1000} s`);
  a.eng.lap(); a.src.run(15, 112); a.eng.pauseToggle(); const va = a.eng.view(); check('the next stage, begun during the pause, starts counting at resume', a.eng.stages.length === 2 && Math.round(va.phaseLeft) === 180 && va.phaseElapsed === 0, `${va.phaseLeft} s left`);
  a.src.run(180, 160); const sa = a.eng.stop('test'); const ra = summarizeStages(sa);
  check('rows: stage 1 = the 100 s that were run at 150 bpm, stage 2 at 160 bpm', Math.abs(ra[0].durationSec - 100) <= 1 && Math.abs(ra[0].hr - 150) < 0.5 && Math.abs(ra[1].hr - 160) < 0.5, ra.map(r => `${r.durationSec} s / ${r.hr.toFixed(0)}`).join(', '));
  const b = boot(mkSettings({}), { mode: 'test', protocol: proto }); b.src.run(180, 140); b.src.run(30, 130); b.src.run(180, 155); b.src.run(30, 140); b.src.run(100, 170); const p3 = b.src.T; b.eng.pauseToggle(); b.src.run(90, 115); const sb = b.eng.stop('test'); const rb = summarizeStages(sb);
  check('Finish during a pause: the last stage ends where the pause began', sb.stages[2].tEnd === p3 && sb.pauseMs === 90000, `stage 3 ${(sb.stages[2].tEnd - sb.stages[2].tStart) / 1000} s, pauseMs ${sb.pauseMs}`);
  check('…and its row is the 100 s that were run (170 bpm), not the recovery', Math.abs(rb[2].durationSec - 100) <= 1 && Math.abs(rb[2].hr - 170) < 0.5, `${rb[2].durationSec} s, HR ${rb[2].hr.toFixed(1)}`);
  check('the finished session reports its running time (pause excluded)', Math.abs(b.eng.view().elapsedSec - 520) <= 1 && Math.abs(sessionMetrics(sb).durationSec - 520) <= 1, `${b.eng.view().elapsedSec} s`);
}
// ---- an autosave taken during a pause counts the pause so far ----
{
  const { src, eng } = boot(mkSettings({}), { mode: 'free', targets: null, meta: { speed: 9, incline: 1 } });
  src.run(100, 140); eng.pauseToggle(); src.run(200, 100); const snap = eng.snapshot(false);
  check('unfinished copy made while paused: pauseMs holds the open pause', snap.pauseMs === 200000 && snap.endedAt === null && snap.final === false, String(snap.pauseMs));
  check('…so its duration is the 100 s of running', Math.abs(sessionMetrics(snap).durationSec - 100) <= 1, String(sessionMetrics(snap).durationSec));
  eng.pauseToggle(); src.run(10, 140); eng.stop('test');
}
// ---- strap silent (out of range, reconnecting): rows are kept for the time base but carry no stale values ----
{
  const realNow = performance.now; let W = 1000; performance.now = () => W; // the engine tells "silent" by real time; here real time is moved by hand together with the data clock
  class Strap2 extends ClockSource { run(sec, hr = 140) { for (let i = 0; i < sec; i++) { this.T += 1000; W += 1000; const rr = 60000 / hr; (this.h.hr || []).forEach(fn => fn({ t: this.T, hr, rr: [rr * (1 + 0.02 * Math.sin(i * 1.3)), rr * (1 - 0.02 * Math.sin(i * 1.3))], contact: true })); } } silent(sec, eng) { for (let i = 0; i < sec * 4; i++) { this.T += 250; W += 250; eng.tick(); } } }
  const src = new Strap2(); const eng = new SessionEngine({ settings: mkSettings({}), alerts }); eng.setSource(src); eng.configure({ mode: 'lt1', targets: { hrLo: 130, hrHi: 150, alphaMin: 0.75, durationSec: 3600 }, meta: { speed: 8, incline: 1 } }); eng.start(); clearInterval(eng.timer);
  src.run(600, 140); const before = eng.features.length; const tizBefore = eng.tiz.totalSec; const t1 = src.T;
  src.silent(180, eng); const t2 = src.T; const vq = eng.view();
  const gap = eng.features.filter(f => f.t > t1 + 6000 && f.t <= t2);
  check('3 min without a notification: rows are still written every 5 s', gap.length >= 33 && gap.length <= 36, `${gap.length} rows`);
  check('…but none repeats the last heart rate or α1 as if it were measured', gap.every(f => f.gap === true && Number.isNaN(f.alpha1) && Number.isNaN(f.hr) && f.hrInst == null), JSON.stringify(gap[5]));
  check('the live view shows no heart rate and the zone waits', vq.hr === null && vq.zone === 'waiting', `hr ${vq.hr}, zone ${vq.zone}`);
  check('no time-in-zone is counted for the silent minutes', eng.tiz.totalSec - tizBefore <= 10, `${eng.tiz.totalSec - tizBefore} s added`);
  src.run(300, 142); const s = eng.stop('test'); const after = s.features.filter(f => f.t > t2 + 130000);
  check('readings resume when the strap is back', after.length > 20 && after.every(f => !f.gap && Number.isFinite(f.hr)) && eng.view().hr !== undefined, `${after.length} rows`);
  const m = sessionMetrics(s); check('session statistics use measured rows only', Number.isFinite(m.meanAlpha1) && s.features.filter(f => f.gap).every(f => !Number.isFinite(f.alpha1)), `mean α1 ${m.meanAlpha1.toFixed(2)}`);
  const first = s.features.find(f => f.t > t2 && !f.gap); check('the α1 window was emptied during the silence: the first rows after it hold only new beats', !!first && first.samples <= 2 * (first.t - t2) / 1000 + 2, first ? `${first.samples} beats in the window ${(first.t - t2) / 1000} s after the strap came back` : 'no row');
  performance.now = realNow;
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS'); process.exit(failures ? 1 : 0);

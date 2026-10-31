// node test/test_split.mjs — v1.1.44 (owner 10/31: "평일은 가장 쉽게, 주말 집중 · 분할 계단 · 매주 데이터로 개선 → 반영"):
// the split step test (parts, the engine's skipped prompts and auto-end, the merged curve), the same-speed trend and its block rule,
// the Saturday rotation and the weekday quota templates of the plan.
import { SessionEngine } from '../js/session.js';
import { computeZones, weeklyPlan, splitPart, SPLIT_PARTS, splitCurve, sameSpeedTrend, satQuality, sessionTargets, WEEKDAY_JOG_MIN, LONG_RUN_FIXED_MIN, TEMPO_STRUCTURE, parseCalendar, planContext } from '../js/prescribe.js';
let failures = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) failures++; };
const DAY = 86400000, now = Date.now();
const Z = computeZones({ lt1Hr: 143, lt2Hr: 157, lt1Speed: 8.7, lt2Speed: 10.5, maxHr: 188, pace3k: 14.1 });
const PRO = { warmupSec: 300, stageSec: 240, pauseSec: 30, startSpeed: 8, speedStep: 1, incline: 1, type: 'speed', stopLactate: 6, warmupSpeed: 5.5, maxStages: 12, minStagesPast4: 2 };

// ── the parts ──
check('splitPart: part 1 runs stages 1–2 and samples both (8 · 9 km/h, 14 min); part 2 runs 1–4, samples 3–4 (10 · 11, 23 min); part 3 runs 1–6, samples 5–6 (12 · 13, 32 min)', (() => { const a = splitPart(1, PRO), b = splitPart(2, PRO), c = splitPart(3, PRO); return a.run.join() === '1,2' && a.measure.join() === '1,2' && a.measureSpeeds.join() === '8,9' && a.minutes === 14 && b.run.join() === '1,2,3,4' && b.measure.join() === '3,4' && b.measureSpeeds.join() === '10,11' && b.last === 4 && b.minutes === 23 && c.run.length === 6 && c.measure.join() === '5,6' && c.measureSpeeds.join() === '12,13' && c.minutes === 32 && SPLIT_PARTS[3].measure.join() === '5,6'; })(), JSON.stringify(splitPart(2, PRO)));
check('splitPart without a protocol falls back to 8.0 + 1.0 (4-min stages, 30-s stops, 5-min walk); an unknown part is null', splitPart(1).speeds.join() === '8,9' && splitPart(1).minutes === 14 && splitPart(4) === null && splitPart(3, { startSpeed: 8, speedStep: 0.5 }).measureSpeeds.join() === '10,10.5');

// ── the engine: part 2 on a hand-driven clock (60-s stages, 10-s stops, so the test runs fast) ──
const alerts = { speak() {}, cue() {}, keepAwake: async () => true, beep() {}, vibrate() {} };
class ClockSource { constructor() { this.T = 1_700_000_000_000; this.kind = 'clock'; this.status = 'connected'; this.h = {}; } now() { return this.T; } on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); } off(ev, fn) { this.h[ev] = (this.h[ev] || []).filter(f => f !== fn); } run(sec, hr = 140) { for (let i = 0; i < sec; i++) { this.T += 1000; const rr = 60000 / hr; (this.h.hr || []).forEach(fn => fn({ t: this.T, hr, rr: [rr, rr], contact: true })); } } }
{
  const settings = { protocol: { ...PRO, warmupSec: 0, stageSec: 60, pauseSec: 10, maxStages: 6 }, treadmill: {}, alpha1: { artifactMode: 'auto', windowSec: 120 }, alerts: {} };
  const events = []; const src = new ClockSource(); const eng = new SessionEngine({ settings, alerts, onEvent: e => events.push(e.type + (e.stage != null ? ':' + e.stage : '')) }); eng.setSource(src);
  const sp = splitPart(2, settings.protocol);
  eng.configure({ mode: 'test', protocol: settings.protocol, meta: { stopHr: 179, splitStages: sp.measure, splitPart: 2, splitLast: sp.last } }); eng.start(); clearInterval(eng.timer);
  src.run(61); check('stage 1 of part 2 ends into the 10-s stop with no lactate prompt (a skip event instead)', eng.phase === 'pause' && events.includes('lactate-skip:1') && !events.includes('lactate-prompt:1') && eng.pendingLactate == null, events.join(' '));
  src.run(10); check('after the stop stage 2 begins by itself', eng.phase === 'work' && eng.stageIdx === 1);
  src.run(61); src.run(10); src.run(61); check('stage 3 (the first measured one) opens the lactate prompt', events.includes('lactate-prompt:3') && eng.pendingLactate === 3, events.join(' '));
  eng.enterLactate(1.6, 3); src.run(10); src.run(61);
  check('stage 4 (the last of the part) opens the prompt and marks the test to end after its stop', events.includes('lactate-prompt:4') && eng.stopAdvised === true && eng.phase === 'pause');
  eng.enterLactate(2.4, 4); src.run(11);
  check('the part ends by itself after the last stop (phase done), 4 stages recorded, lactate only on 3 and 4', eng.phase === 'done' && eng.stages.length === 4 && eng.stages[0].lactate == null && eng.stages[1].lactate == null && eng.stages[2].lactate === 1.6 && eng.stages[3].lactate === 2.4, `${eng.phase} ${eng.stages.length}`);
  const s = eng.stop('test');
  check('the record carries the split part (part 2, measured 3–4, last 4) and the stages', s.split && s.split.part === 2 && s.split.measure.join() === '3,4' && s.split.last === 4 && s.stages.length === 4 && s.type === 'test', JSON.stringify(s.split));
  { // a value typed late — after the next measured stage has already ended — keeps that stage's prompt pending (v1.1.44 fix)
    const ev2 = []; const src2 = new ClockSource(); const e2 = new SessionEngine({ settings, alerts, onEvent: e => ev2.push(e.type + (e.stage != null ? ':' + e.stage : '')) }); e2.setSource(src2);
    e2.configure({ mode: 'test', protocol: settings.protocol, meta: { stopHr: 179, splitStages: [1, 2], splitPart: 1, splitLast: 2 } }); e2.start(); clearInterval(e2.timer);
    src2.run(61); src2.run(10); src2.run(61); check('part 1: stage 2 ended while stage 1 is still untyped → pending moves to 2', e2.pendingLactate === 2 && ev2.includes('lactate-prompt:1') && ev2.includes('lactate-prompt:2'), ev2.join(' '));
    e2.enterLactate(1.1, 1); check('typing stage 1 late keeps stage 2 pending, the value lands on stage 1', e2.pendingLactate === 2 && e2.stages[0].lactate === 1.1 && e2.stages[1].lactate == null);
    e2.enterLactate(1.4, 2); check('then stage 2 clears it', e2.pendingLactate == null && e2.stages[1].lactate === 1.4);
  }
  const full = new SessionEngine({ settings, alerts, onEvent: e => events.push('F:' + e.type) }); full.setSource(new ClockSource()); full.configure({ mode: 'test', protocol: settings.protocol, meta: { stopHr: 179 } }); full.start(); clearInterval(full.timer);
  check('a full test (no split meta) carries no split field', full.snapshot(false).split === undefined);
}

// ── the merged curve ──
const mkTest = (part, stageSpecs, daysAgo, { demo = false, final = true } = {}) => { // stageSpecs: [[speed, lactate|null, hr], …]
  const t0 = now - daysAgo * DAY; let t = t0; const stages = []; const hrLive = [];
  for (const [speed, la, hr] of stageSpecs) { const tStart = t; t += 240000; for (let k = 0; k < 240; k++) hrLive.push([tStart + k * 1000, hr]); stages.push({ idx: stages.length + 1, speed, incline: 1, tStart, tEnd: t, tPauseEnd: t + 30000, lactate: la, rpe: null }); t += 30000; }
  return { id: `split-${part}-${daysAgo}`, type: 'test', final, sourceKind: demo ? 'demo' : 'ble', startedAt: t0, endedAt: t, stages, hrLive, features: [], events: [], split: { part, measure: stageSpecs.filter(x => x[1] != null).map((x, i) => i + 1), last: stageSpecs.length } };
};
{
  const p1 = mkTest(1, [[8, 0.9, 130], [9, 1.3, 141]], 14), p2 = mkTest(2, [[8, null, 131], [9, null, 142], [10, 2.1, 152], [11, 3.4, 161]], 7), p3 = mkTest(3, [[8, null, 130], [9, null, 141], [10, null, 151], [11, null, 160], [12, 5.2, 170], [13, 7.6, 178]], 0);
  const sc = splitCurve([p3, p1, p2]);
  check('three parts → six points (8 → 13 km/h), lactate from the measured stages only, heart rate from each stage\'s own last minute', sc.parts.length === 3 && sc.missing.length === 0 && sc.points.map(p => p.x).join() === '8,9,10,11,12,13' && sc.points.map(p => p.la).join() === '0.9,1.3,2.1,3.4,5.2,7.6' && sc.points.every(p => Number.isFinite(p.hr)) && sc.parts.map(p => p.part).join() === '1,2,3', JSON.stringify(sc.points.map(p => [p.x, p.la, Math.round(p.hr), p.part])));
  check('the lowest of the merged set is 0.9 (not the newest part\'s 5.2); LT1 = lowest + 0.5 lands between 9 and 10 km/h, LT2 (ModDmax) above it, both with a heart rate; ok', sc.lowest === 0.9 && sc.lt1 && sc.lt1.speed > 9 && sc.lt1.speed < 10 && sc.lt1.hr > 141 && sc.lt1.hr < 152 && sc.lt2 && sc.lt2.speed > sc.lt1.speed && Number.isFinite(sc.lt2.hr) && sc.ok && sc.maxLa === 7.6, JSON.stringify({ lowest: sc.lowest, lt1: sc.lt1, lt2: sc.lt2 }));
  const two = splitCurve([p1, p2]);
  check('two parts: four points, part 3 missing, still a curve (≥ 3 points) but LT2 needs the top', two.points.length === 4 && two.missing.join() === '3' && two.lt1 && two.lt1.speed > 9, JSON.stringify({ n: two.points.length, missing: two.missing, lt1: two.lt1, lt2: two.lt2 }));
  const one = splitCurve([p1]);
  check('one part: two points, no curve, LT1 null, missing 2 and 3', one.points.length === 2 && one.analysis === null && one.lt1 === null && one.missing.join() === '2,3' && !one.ok);
  const stale = splitCurve([mkTest(1, [[8, 0.9, 130], [9, 1.3, 141]], 40), p2, p3]);
  check('a part older than 28 days is left out (part 1 missing), a demo part never counts, an unfinished one neither', stale.missing.join() === '1' && splitCurve([p1, p2, mkTest(3, [[8, null, 130], [9, null, 141], [10, null, 151], [11, null, 160], [12, 5.2, 170], [13, 7.6, 178]], 0, { demo: true })]).missing.join() === '3' && splitCurve([p1, p2, mkTest(3, [[12, 5.2, 170], [13, 7.6, 178]], 0, { final: false })]).missing.join() === '3');
  const newer = splitCurve([p1, p2, p3, mkTest(1, [[8, 1.1, 132], [9, 1.5, 143]], 2)]);
  check('the newest of each part wins (a repeated part 1 two days ago replaces the 14-day-old one: 8 → 1.1)', newer.points.find(p => p.x === 8).la === 1.1 && newer.parts.length === 3);
}

// ── the same-speed trend ──
const mkVerify = (speed, daysAgo, lap1, end, hrLap1, hrLate, rpe, { surface = 'treadmill' } = {}) => {
  const t0 = now - daysAgo * DAY; const hrLive = []; const events = [{ t: t0, type: 'phase', phase: 'warmup' }];
  const wu = 300, l1 = 600, gap = 60, l2 = 1200; let t = t0;
  for (let i = 0; i < wu; i++) hrLive.push([t + i * 1000, 120]); t += wu * 1000; events.push({ t, type: 'phase', phase: 'work', rep: 1 });
  for (let i = 0; i < l1; i++) hrLive.push([t + i * 1000, hrLap1]); t += l1 * 1000; events.push({ t, type: 'phase', phase: 'gap' }); events.push({ t: t + 30000, type: 'lactate', value: lap1, rep: 1, phase: 'gap' });
  t += gap * 1000; events.push({ t, type: 'phase', phase: 'work', rep: 2 });
  for (let i = 0; i < l2; i++) hrLive.push([t + i * 1000, i < 360 ? hrLap1 + 1 : hrLate]); t += l2 * 1000; events.push({ t, type: 'phase', phase: 'done' }); events.push({ t: t + 30000, type: 'lactate', value: end, rep: 2, phase: 'done' });
  return { id: `v-${speed}-${daysAgo}`, type: 'verify', purpose: 'mlss', final: true, sourceKind: 'ble', startedAt: t0, endedAt: t + 40000, speed, incline: 1, surface, rpe, hrLive, features: [], events, laps: { warmupSec: wu, lap1Sec: l1, lap2Sec: l2 } };
};
{
  const a = mkVerify(10.5, 21, 1.5, 1.3, 157, 159, 4), b = mkVerify(10.5, 14, 1.4, 1.3, 156, 158, 4), c = mkVerify(10.5, 7, 1.2, 0.8, 154, 155, 3), d = mkVerify(10.5, 0, 1.1, 0.7, 153, 154, 3);
  const t2 = sameSpeedTrend([b, a]);
  check('two runs at 10.5: two rows (lap 1, end, rise, lap-1 HR, late HR, RPE), verdict hold (inside the noise band)', t2.speed === 10.5 && t2.rows.length === 2 && t2.rows[0].lap1 === 1.5 && t2.rows[0].end === 1.3 && t2.rows[0].rise === -0.2 && t2.rows[0].hr1 === 157 && t2.rows[0].hrLate === 159 && t2.rows[0].rpe === 4 && t2.verdict && t2.verdict.kind === 'hold' && t2.verdict.nextSpeed === 10.5, JSON.stringify(t2));
  const t4 = sameSpeedTrend([d, c, b, a]);
  check('two consecutive runs with the end value ≥ 0.5 under the first and the late HR ≥ 3 lower → verdict up, next 10.8', t4.rows.length === 4 && t4.verdict.kind === 'up' && t4.verdict.nextSpeed === 10.8 && /10\.8/.test(t4.verdict.ko), JSON.stringify(t4.verdict));
  const up = sameSpeedTrend([mkVerify(10.5, 0, 2.0, 2.0, 160, 166, 6), b, a]);
  check('the end value ≥ 0.5 up with the late HR ≥ 5 up → verdict check (fatigue, illness, diet), speed held', up.verdict.kind === 'check' && up.verdict.nextSpeed === 10.5);
  check('a single run: one row, no verdict yet; an empty list: no speed', sameSpeedTrend([a]).rows.length === 1 && sameSpeedTrend([a]).verdict === null && sameSpeedTrend([]).speed === null);
  check('the trend follows the newest run\'s speed (10.8 after a switch) unless a speed is given; off-belt runs never count', sameSpeedTrend([mkVerify(10.8, 0, 1.6, 1.5, 160, 162, 5), b, a]).speed === 10.8 && sameSpeedTrend([mkVerify(10.8, 0, 1.6, 1.5, 160, 162, 5), b, a], { speed: 10.5 }).rows.length === 2 && sameSpeedTrend([mkVerify(10.5, 0, 1.0, 0.9, 150, 150, 3, { surface: 'outdoor' }), b, a]).rows.length === 2);
}

// ── the plan: Saturday rotation, the split days, the weekday templates ──
{
  check('satQuality: odd hard weeks the fixed-speed test, even weeks the 4×4', satQuality(1) === 'fixed' && satQuality(2) === 'vo2' && satQuality(3) === 'fixed');
  const D = (p, d) => p.days.find(x => x.day === d);
  const s1 = weeklyPlan({ zones: Z, week: 1, kinds: ['split1'], protocol: PRO }), s2 = weeklyPlan({ zones: Z, week: 1, kinds: ['split2', 'blood'], protocol: PRO }), s3 = weeklyPlan({ zones: Z, week: 1, kinds: ['split3'], protocol: PRO });
  check('split1: Saturday a 14-min test day (part 1), stages 8 · 9 both sampled, the weekday optional session the hill 4×4, Sunday the long run 60', D(s1, 6).type === 'test' && D(s1, 6).split === 1 && D(s1, 6).minutes === 14 && /1: 8\.0● · 2: 9\.0●/.test(D(s1, 6).note.ko) && D(s1, 2).kind === 'vo2' && D(s1, 0).type === 'long' && D(s1, 0).minutes === 60, D(s1, 6).note.ko.slice(0, 160));
  check('split2 + blood: Saturday part 2 (23 min, 8 · 9 unmeasured, 10 · 11 sampled), Thursday no run, the weekday jog otherwise', D(s2, 6).split === 2 && D(s2, 6).minutes === 23 && /1: 8\.0 · 2: 9\.0 · 3: 10\.0● · 4: 11\.0●/.test(D(s2, 6).note.ko) && D(s2, 4).type === 'rest' && D(s2, 2).type === 'lt1', D(s2, 6).note.ko.slice(0, 160));
  check('split3: Saturday part 3 (32 min, 12 · 13 sampled) counts as the hard Saturday → the weekday optional session is the tempo, Sunday an easy 50', D(s3, 6).split === 3 && D(s3, 6).minutes === 32 && /5: 12\.0● · 6: 13\.0●/.test(D(s3, 6).note.ko) && D(s3, 2).kind === 'tempo' && D(s3, 0).type === 'lt1' && D(s3, 0).minutes === 50);
  const f = weeklyPlan({ zones: Z, week: 2, kinds: ['fixed'] }), tt = weeklyPlan({ zones: Z, week: 1, kinds: ['tt'] }), v = weeklyPlan({ zones: Z, week: 1, kinds: ['vo2'] });
  check('fixed: Saturday the fixed-speed test at 10.5 (verify, purpose mlss, the trend rule in the note), Sunday the long run; the weekday the hill 4×4', D(f, 6).type === 'verify' && D(f, 6).purpose === 'mlss' && D(f, 6).fixed && D(f, 6).speed === 10.5 && /같은 속도 추세/.test(D(f, 6).note.ko) && D(f, 0).type === 'long' && D(f, 2).kind === 'vo2');
  check('tt: Saturday the 3-km time trial on the track (no session to start), Sunday an easy 50, the weekday the tempo', D(tt, 6).tt === true && D(tt, 6).type === 'rest' && /3 km 모의 검정/.test(D(tt, 6).ko) && D(tt, 0).minutes === 50 && D(tt, 2).kind === 'tempo');
  check('vo2 kind: Saturday the 4×4 on the belt at 13.0 (HR 169–179) and the weekday tempo', D(v, 6).kind === 'vo2' && D(v, 6).speed === 13 && D(v, 6).hr.hrLo === 169 && D(v, 6).hr.hrHi === 179 && D(v, 6).surface === 'treadmill' && D(v, 2).kind === 'tempo');
  const p = weeklyPlan({ zones: Z, week: 1 });
  check('the weekday jog template: 20 min in the band 133–140, strides, the bodyweight set / steps / sitting breaks as the extras; Friday rest; the long run constant', D(p, 3).minutes === WEEKDAY_JOG_MIN && D(p, 3).hr.hrLo === 133 && D(p, 3).hr.hrHi === 140 && /스트라이드/.test(D(p, 3).note.ko) && /맨몸 근력 1세트/.test(D(p, 3).evening.ko) && /7,000보/.test(D(p, 3).evening.ko) && D(p, 5).type === 'rest' && D(p, 0).minutes === LONG_RUN_FIXED_MIN && p.satKind === 'fixed');
  check('the tempo targets: zone 3 = 144–152 at 143/157, a 5-min grace, no ceiling rise; the structure is one 25-min rep', (() => { const T = sessionTargets(Z, 'tempo'); return T.kind === 'tempo' && T.hrLo === 144 && T.hrHi === 152 && T.repGraceSec === 300 && !Number.isFinite(T.ceilHr) && TEMPO_STRUCTURE.reps === 1 && TEMPO_STRUCTURE.workSec === 1500; })());
  const cal = ['2026-11-02 split1 a', '2026-11-09 split2 b', '2026-11-09 blood c', '2026-11-16 split3 d', '2026-11-23 fixed e', '2026-11-30 fixed f', '2026-12-07 tt g'].join('\n');
  const c = d => planContext({ startDate: '2026-11-02', calendar: cal, now: new Date(d + 'T12:00:00') });
  check('the calendar kinds parse and each week of the 10/31 block carries its kind; the block weeks do not advance the Saturday alternation; 12/14 is the first free week (hard week 1 → fixed), 12/21 hard week 2', c('2026-11-04').kinds.join() === 'split1' && c('2026-11-11').kinds.join() === 'split2,blood' && c('2026-11-18').kinds.join() === 'split3' && c('2026-11-25').kinds.join() === 'fixed' && c('2026-12-09').kinds.join() === 'tt' && c('2026-12-09').ladderWeek === 1 && c('2026-12-16').kinds.length === 0 && c('2026-12-16').ladderWeek === 1 && c('2026-12-23').ladderWeek === 2 && parseCalendar(cal)['2026-12-07'].kinds.join() === 'tt', JSON.stringify(['2026-11-04', '2026-11-11', '2026-11-18', '2026-11-25', '2026-12-09', '2026-12-16', '2026-12-23'].map(d => [d, c(d).kinds.join('+'), c(d).ladderWeek])));
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS'); process.exit(failures ? 1 : 0);

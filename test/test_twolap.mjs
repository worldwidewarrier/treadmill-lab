// node test/test_twolap.mjs — the weekly two-lap LT1 verification run (v1.1.17): engine phases, cues and sample tags; the
// two-lap verdict (pass / borderline / fail, strict rule beyond a 3-min gap, durability flag); the band finder (next test speed,
// band change only after two consecutive results); the multi-day curve rules (lap-1 minutes 5–10, single runs minutes 8–13,
// > 35 min = durability); the MLSS rule (≤ 0.5 raise, 0.5–1.0 hold, no raise after a long stop); the LT1 late ceiling;
// the long-run cap; the α1 artifact gate; the monthly resting-lactate reminder.
import { SessionEngine, DEFAULT_LAPS, LATE_FROM_SEC } from '../js/session.js';
import { runTimeline, lapsFromEvents, hrvThresholds, ALPHA_ARTIFACT_MAX } from '../js/analysis.js';
import { lactateChecks, lactateVerdict, lapStats, bandFinder, multiDayCurve, verdictZoneChange, setRestBaseline, setTestLowest, lactateFloor, testLowest, weeklyPlan, longestRecentMin, sessionTargets, computeZones, assessRecent, sessionMetrics, claudeSummary, midLabel, earlyWindowHr } from '../js/prescribe.js';
let failures = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) failures++; };
const spoken = []; const alerts = { speak(t) { spoken.push(t); }, cue(t) { if (t) spoken.push(t); }, keepAwake: async () => true, beep() {}, vibrate() {} };
const settings = { protocol: {}, treadmill: {}, alpha1: { artifactMode: 'auto', windowSec: 120, stepSec: 5, lambda: 500 }, alerts: { zoneExitSec: 30 } };
class ClockSource { // a strap whose clock the test moves by hand: one notification per second, two RR intervals
  constructor(t0) { this.T = t0; this.kind = 'ble'; this.status = 'connected'; this.h = {}; }
  now() { return this.T; } on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); } off(ev, fn) { this.h[ev] = (this.h[ev] || []).filter(f => f !== fn); }
  run(sec, hr) { for (let i = 0; i < sec; i++) { this.T += 1000; const h = typeof hr === 'function' ? hr(i) : hr; const rr = 60000 / h; (this.h.hr || []).forEach(fn => fn({ t: this.T, hr: h, rr: [rr, rr], contact: true })); } }
}
const DAY = 86400000; const now = Date.now();
/**
 * A two-lap run through the engine, on a hand-driven clock. gapSec = how long the belt stood between the laps; lap1 / end = the
 * values typed in the gap (sampleAt s after the stop) and after lap 2; hr(sec of the run) = the heart rate while running.
 * Returns the session as the app would save it (startedAt = daysAgo days ago).
 */
function twoLapRun({ speed = 8.7, lap1 = 1.0, end = 1.3, gapSec = 75, sampleAt = 35, lap2Min = 30, lap1Min = 10, warmMin = 5, hr = () => 140, hrLap2 = null, daysAgo = 1, purpose = 'lt1', id = null, endSample = true, lap1Sample = true } = {}) {
  spoken.length = 0; const src = new ClockSource(now - daysAgo * DAY); const prompts = [];
  const eng = new SessionEngine({ settings, alerts, onEvent: e => { if (e.type === 'lactate-prompt') prompts.push(e); } }); eng.setSource(src);
  eng.configure({ mode: 'verify', laps: { ...DEFAULT_LAPS, warmupSec: warmMin * 60, lap1Sec: lap1Min * 60, lap2Sec: lap2Min * 60 }, targets: null, meta: { speed, incline: 1, purpose } });
  eng.start(); clearInterval(eng.timer);
  src.run(warmMin * 60, 110);                              // easy warm-up
  src.run(lap1Min * 60 + 1, i => hr(i));                   // lap 1 — the clock ends it
  const atStop = src.T; src.run(sampleAt, i => Math.max(95, 140 - 2 * i)); // standing: the heart rate falls
  if (lap1Sample) eng.enterLactate(lap1);
  src.run(gapSec - sampleAt, 100);
  eng.lap();                                               // "Start lap 2"
  src.run(lap2Min * 60 + 1, i => (hrLap2 || hr)(lap1Min * 60 + i)); // lap 2 — the clock ends it
  src.run(sampleAt, i => Math.max(95, 140 - 2 * i)); if (endSample) eng.enterLactate(end);
  src.run(30, 95);
  const s = eng.stop('user'); s.final = true; if (id) s.id = id; s.sourceKind = 'ble'; s.metrics = sessionMetrics(s); s.atStop = atStop; s.prompts = prompts; s.spoken = spoken.slice();
  return s;
}

// ───────────── 1. Engine: phases, cues, tags ─────────────
setRestBaseline(0.8); setTestLowest(null);
{
  const s = twoLapRun({ speed: 8.7, lap1: 1.1, end: 1.4, gapSec: 80 });
  const ph = s.events.filter(e => e.type === 'phase').map(e => e.phase);
  check('phases: warm-up → lap 1 (work) → gap → lap 2 (work) → done', ph.join(' ') === 'warmup work gap work done', ph.join(' '));
  const lp = lapsFromEvents(s);
  check('laps from the phase log: lap 1 ≈ 10 min, gap ≈ 80 s, lap 2 ≈ 30 min', lp && Math.abs(lp.lap1Sec - 600) <= 2 && Math.abs(lp.gapSec - 80) <= 2 && Math.abs(lp.lap2Sec - 1800) <= 2, lp ? `${lp.lap1Sec} ${lp.gapSec} ${lp.lap2Sec}` : 'none');
  const lac = s.events.filter(e => e.type === 'lactate');
  check('the gap value is tagged lap 1, 10 min at speed, 35 s after the stop; the end value lap 2, 30 min, 35 s', lac[0].lap === 1 && Math.abs(lac[0].runSec - 600) <= 2 && Math.abs(lac[0].sinceStopSec - 35) <= 1 && lac[0].gapSec === lac[0].sinceStopSec && lac[1].lap === 2 && Math.abs(lac[1].runSec - 1800) <= 2 && Math.abs(lac[1].sinceStopSec - 35) <= 1, JSON.stringify(lac.map(e => [e.lap, e.runSec, e.sinceStopSec])));
  check('cues: "30 s to the stop", the stop, "sample" at 30 s, lap-2 start, halfway, the end stop', s.spoken.some(t => /30초 후 정지/.test(t)) && s.spoken.filter(t => /^정지\. 벨트를 멈추고/.test(t)).length === 2 && s.spoken.filter(t => t === '채혈하세요.').length === 2 && s.spoken.some(t => /2랩 시작\. 30분/.test(t)) && s.spoken.some(t => /절반/.test(t)), s.spoken.join(' | '));
  check('no "gap 90 s" or "gap exceeded 3 min" cue for an 80-s gap', !s.spoken.some(t => /간격 90초|3분 초과/.test(t)));
  check('the lactate prompt opens 30 s after each stop (lap 1 and lap 2)', s.prompts.length === 2 && s.prompts[0].lap === 1 && s.prompts[1].lap === 2, JSON.stringify(s.prompts));
  check('the saved record: type verify, purpose lt1, speed, lap times', s.type === 'verify' && s.purpose === 'lt1' && s.speed === 8.7 && s.laps.lap1Start && s.laps.lap1End && s.laps.lap2Start && s.laps.lap2End);
  const tl = runTimeline(s); const c = lactateChecks(s);
  check('timeline: two laps, the gap as a stop of the run, the end at the lap-2 stop', tl.twoLap && tl.laps.length === 2 && Math.abs(tl.gapSec - 80) <= 2 && tl.stops.length >= 1 && tl.sure && Math.abs(tl.end - s.laps.lap2End) <= 20000, `${tl.how} ${tl.sure} gap ${tl.gapSec} stops ${tl.stops.length} end−lap2End ${(tl.end - s.laps.lap2End) / 1000}s`);
  check('samples: the gap value is the lap-1 (mid) value, the last the end value; the label says lap 1 (10 min)', c.mid === 1.1 && c.end === 1.4 && c.midMin === 10 && c.twoLap && midLabel(c).en === 'lap 1 (10 min)' && /랩 1\(10분\)/.test(midLabel(c).ko), JSON.stringify(c));
  const ls = lapStats(s);
  check('lap stats: lap-1 HR (min 5–10) 140, lap-2 drift ≈ 0, lap 2 = 30 min', Math.abs(ls.lap1Hr - 140) < 0.5 && Math.abs(ls.lap2Drift) < 0.5 && Math.abs(ls.lap2Min - 30) < 0.2 && Math.abs(ls.gapSec - 80) <= 2, JSON.stringify(ls));
  const m = sessionMetrics(s);
  check('session numbers: mean HR of the running, not of the gap or the recovery', m.meanHr > 138 && m.meanHr < 141, m.meanHr.toFixed(1));
  const long = twoLapRun({ gapSec: 200, sampleAt: 40 });
  check('a 200-s gap: the "90 s" and "3 min exceeded, strict rule" cues', long.spoken.some(t => /간격 90초/.test(t)) && long.spoken.some(t => /3분 초과/.test(t)), long.spoken.filter(t => /간격/.test(t)).join(' | '));
}
// ───────────── 2. The two-lap verdict ─────────────
{
  setRestBaseline(0.8); setTestLowest(null); // line = 0.8 + 0.5 = 1.3
  const v = (o) => lactateVerdict(twoLapRun(o));
  const p = v({ lap1: 1.0, end: 1.3 });
  check('pass: lap 1 1.0 ≤ 1.3, rise 0.3 ≤ 0.5 → next +0.2', p.twoLap && p.level === 'ok' && p.next === 0.2 && p.adjust === null && /Pass/.test(p.en) && /통과/.test(p.ko) && /\+0\.2/.test(p.en), p.en);
  check('  the verdict says which line it used (resting baseline 0.8 + 0.5 = 1.3)', /resting baseline 0\.8 \+ 0\.5 = 1\.3/.test(p.en) && /기준 안정 시 0\.8 \+ 0\.5 = 1\.3/.test(p.ko));
  const b1 = v({ lap1: 1.0, end: 1.7 });
  check('borderline: rise 0.7 (0.5–1.0) → same speed, HR −2, durability flagged (level passed, 30 min did not hold)', b1.level === 'near' && b1.next === 0 && b1.adjust.lt1Hr === -2 && b1.durability === true && /durability/.test(b1.en), b1.en);
  const b2 = v({ lap1: 1.2, end: 1.4 });
  check('borderline: lap 1 1.2 within 0.2 of the line 1.3 → same speed', b2.level === 'near' && b2.next === 0 && /within 0\.2/.test(b2.en) && b2.durability === false, b2.en);
  const f1 = v({ lap1: 1.5, end: 1.8 });
  check('fail: lap 1 1.5 > 1.3 → −0.3 km/h, HR −4, not a durability case', f1.level === 'high' && f1.next === -0.3 && f1.adjust.lt1Hr === -4 && f1.durability === false && /lap 1 1\.5 > line 1\.3/.test(f1.en), f1.en);
  const f2 = v({ lap1: 1.0, end: 2.2 });
  check('fail: rise 1.2 > 1.0 → −0.3, durability flagged', f2.level === 'high' && f2.next === -0.3 && f2.durability === true, f2.en);
  const f3 = v({ lap1: 1.2, end: 2.6 });
  check('fail: end 2.6 > 2.5', f3.level === 'high' && /end 2\.6 > 2\.5/.test(f3.en), f3.en);
  const st = v({ lap1: 1.0, end: 1.4, gapSec: 200, sampleAt: 40 });
  check('strict rule beyond a 3-min gap: rise 0.4 (≤ 0.5 but > 0.3) → borderline, and it says so', st.level === 'near' && st.strict === true && /strict rule/.test(st.en) && /엄격 규칙/.test(st.ko), st.en);
  const st2 = v({ lap1: 1.0, end: 1.3, gapSec: 200, sampleAt: 40 });
  check('strict rule: rise 0.3 still passes', st2.level === 'ok' && st2.strict === true);
  const dr = lactateVerdict(twoLapRun({ lap1: 1.0, end: 1.2, hrLap2: sec => 138 + 12 * Math.min(1, Math.max(0, sec - 660) / 1500) }));
  check('a level pass with lap-2 drift > 8 bpm: pass by lactate, durability flagged', dr.level === 'ok' && dr.durability === true && dr.lap2Drift > 8, `drift ${dr.lap2Drift?.toFixed(1)} ${dr.en}`);
  const nl = lactateVerdict(twoLapRun({ lap1: 1.0, end: 1.3, lap1Sample: false }));
  check('no lap-1 value: no two-lap verdict, asks for the lap-1 field, same speed', nl.twoLap && nl.level === 'near' && nl.next === 0 && /No lap-1 value/.test(nl.en));
  check('the two-lap verdict never changes a zone by itself (the band finder does, after two results)', verdictZoneChange({ lt1Hr: 140, lt1Speed: 8.4 }, twoLapRun({ lap1: 1.0, end: 1.3 })) === null);
  setTestLowest(1.0); const t = v({ lap1: 1.4, end: 1.6 });
  check('with a step test the line is its lowest value + 0.5 (1.0 → 1.5): lap 1 1.4 is within 0.2 → borderline, text names the test', t.level === 'near' && /test lowest 1\.0 \+ 0\.5 = 1\.5/.test(t.en), t.en);
  check('lactateFloor / testLowest', lactateFloor().from === 'test' && testLowest({ stages: [{ lactate: 1.2 }, { lactate: 0.9 }, { lactate: 1.6 }] }) === 0.9 && testLowest({ stages: [{ lactate: 1.2 }] }) === null);
  setTestLowest(null);
  const ml = lactateVerdict(twoLapRun({ purpose: 'mlss', speed: 10.5, lap1: 3.2, end: 3.6, lap2Min: 20 }));
  check('MLSS variant (purpose mlss, lap 2 = 20 min): the MLSS rule on lap 1 → end, rise 0.4 → +0.3', ml.kind === 'mlss' && ml.level === 'ok' && ml.adjust.lt2Speed === 0.3 && !ml.twoLap, ml.en);
  const mlHold = lactateVerdict(twoLapRun({ purpose: 'mlss', speed: 10.5, lap1: 3.2, end: 4.0, lap2Min: 20 }));
  check('MLSS rise 0.8 → confirmed, hold (no raise)', mlHold.level === 'ok' && mlHold.hold === true && mlHold.adjust === null, mlHold.en);
  const mlGap = lactateVerdict(twoLapRun({ purpose: 'mlss', speed: 10.5, lap1: 3.2, end: 3.5, lap2Min: 20, gapSec: 200, sampleAt: 40 }));
  check('MLSS rise 0.3 after a 200-s stop → at/below, but no raise', mlGap.level === 'ok' && mlGap.longGap === true && mlGap.adjust === null && /No raise/.test(mlGap.en), mlGap.en);
  const mlHigh = lactateVerdict(twoLapRun({ purpose: 'mlss', speed: 10.8, lap1: 3.4, end: 4.9, lap2Min: 20 }));
  check('MLSS rise 1.5 → above, −0.4', mlHigh.level === 'high' && mlHigh.adjust.lt2Speed === -0.4);
  const cs = claudeSummary({ session: twoLapRun({ lap1: 1.0, end: 1.3, id: 'cs' }), metrics: null });
  check('the copied summary has a two-lap line with the gap, the lap-1 heart rate and the tagged samples', /Two-lap LT1 check: lap 1 10\.0 min \(HR min 5-10 140 bpm\) → gap 7\d s → lap 2 30\.0 min/.test(cs) && /1 \(lap 1, 10 min at speed, 3[56] s after the stop\)/.test(cs), cs.split('\n').find(l => /Two-lap/.test(l)));
}
// ───────────── 3. The band finder ─────────────
{
  setRestBaseline(0.8); setTestLowest(null);
  const Z = { lt1Hr: 143, lt1Speed: 8.7, lt2Hr: 157, lt2Speed: 10.5, testLt1Speed: 8.7 };
  const none = bandFinder([], Z);
  check('no result yet: the test speed is the LT1 speed', none.nextSpeed === 8.7 && none.from === 'zones' && none.change === null);
  const w1 = twoLapRun({ speed: 8.7, lap1: 1.0, end: 1.3, daysAgo: 14, id: 'w1' });
  const b1 = bandFinder([w1], Z);
  check('one pass at 8.7: next week 8.9, no band change yet', b1.nextSpeed === 8.9 && b1.step === 0.2 && b1.streak.n === 1 && b1.change === null && /two consecutive/.test(b1.en), b1.en);
  const w2 = twoLapRun({ speed: 8.9, lap1: 1.0, end: 1.4, daysAgo: 7, id: 'w2' }); // (1.1 would be within 0.2 of the line 1.3: borderline)
  const b2 = bandFinder([w2, w1], Z);
  check('two passes running (8.7, 8.9): next 9.0 (capped at the step-test LT1 8.7 + 0.3), band change LT1 8.7→8.9 km/h and 143→? bpm offered', b2.nextSpeed === 9.0 && b2.capped === true && b2.streak.n === 2 && b2.change && b2.change.zones.lt1Speed === 8.9 && b2.change.keys.includes('lt1Speed'), JSON.stringify({ next: b2.nextSpeed, change: b2.change?.ko }));
  check('  the heart rate of the band is the lap-1 heart rate (140 < 143: the HR floor does not fall, only the speed rises)', !b2.change.keys.includes('lt1Hr'), JSON.stringify(b2.change.keys));
  const w3 = twoLapRun({ speed: 9.0, lap1: 1.6, end: 2.0, daysAgo: 0.5, id: 'w3' });
  const b3 = bandFinder([w3, w2, w1], Z);
  check('a fail after two passes: next 8.7 (−0.3), streak broken, no change', b3.nextSpeed === 8.7 && b3.streak.level === 'high' && b3.streak.n === 1 && b3.change === null, b3.en);
  const w4 = twoLapRun({ speed: 8.7, lap1: 1.6, end: 2.0, daysAgo: 0.2, id: 'w4', hr: () => 146 });
  const b4 = bandFinder([w4, w3, w2, w1], Z);
  check('two fails running (9.0, 8.7 at 146 bpm): next 8.4, band cap LT1 8.7→8.4 km/h, 143→142 bpm (lap-1 HR − 4)', b4.nextSpeed === 8.4 && b4.streak.n === 2 && b4.change && b4.change.zones.lt1Speed === 8.4 && b4.change.zones.lt1Hr === 142, JSON.stringify(b4.change?.zones));
  const demo = { ...w2, sourceKind: 'demo', id: 'wd' };
  check('demo runs and MLSS runs are not results', bandFinder([demo], Z).from === 'zones' && bandFinder([twoLapRun({ purpose: 'mlss', speed: 10.5, lap1: 3.2, end: 3.6, lap2Min: 20, id: 'wm' })], Z).from === 'zones');
  const bb = bandFinder([twoLapRun({ speed: 8.7, lap1: 1.2, end: 1.5, daysAgo: 7, id: 'wb1' }), twoLapRun({ speed: 8.7, lap1: 1.2, end: 1.5, daysAgo: 0.5, id: 'wb2' })], Z);
  check('two borderlines: same speed, no band change', bb.nextSpeed === 8.7 && bb.streak.n === 2 && bb.change === null);
}
// ───────────── 4. The multi-day curve rules ─────────────
{
  setRestBaseline(0.8);
  const single = (speed, end, hrFn, { durSec = 1800, daysAgo = 1, mid = null, midSec = null } = {}) => { const t0 = now - daysAgo * DAY; const hrLive = []; for (let i = 0; i <= durSec + 120; i++) hrLive.push([t0 + i * 1000, i <= durSec ? hrFn(i) : Math.max(95, hrFn(durSec) - 2 * (i - durSec))]);
    const events = [{ t: t0, type: 'phase', phase: 'work' }]; if (mid != null) events.push({ t: t0 + midSec * 1000, type: 'lactate', value: mid }); events.push({ t: t0 + (durSec + 40) * 1000, type: 'lactate', value: end }); return { id: 's' + speed + daysAgo, type: 'free', final: true, sourceKind: 'ble', startedAt: t0, endedAt: t0 + (durSec + 120) * 1000, speed, incline: 1, hrLive, features: [], events }; };
  const drifting = base => sec => base + 10 * Math.min(1, sec / 600) * Math.max(0, sec - 600) / 1200; // +10 bpm of drift over the run
  const two = twoLapRun({ speed: 8.7, lap1: 1.0, end: 1.3, id: 'c87', hr: sec => 140 + 6 * Math.max(0, sec - 600) / 1800 });
  const md = multiDayCurve([two, single(8.0, 1.0, drifting(132)), single(9.5, 2.0, drifting(148), { daysAgo: 2 }), single(10.5, 3.6, drifting(156), { daysAgo: 3 })]);
  const p87 = md.points.find(p => p.x === 8.7), p80 = md.points.find(p => p.x === 8.0);
  check('a two-lap run is a point by its end value with the lap-1 minutes-5–10 heart rate (140, not the drifted lap-2 end)', p87 && p87.la === 1.3 && p87.from === 'lap2' && Math.abs(p87.hr - 140) < 0.5 && p87.lap1 === 1.0, JSON.stringify(p87));
  check('a single 30-min run: the heart rate of minutes 8–13 (≈ 134), not of the last 5 min (≈ 141)', p80 && p80.from === 'end' && p80.hr > 132 && p80.hr < 136, JSON.stringify(p80));
  check('four speeds → thresholds', md.points.length === 4 && md.analysis && Number.isFinite(md.analysis.lt1Primary.hr));
  const longRun = single(8.0, 1.9, drifting(132), { durSec: 3600 });
  const mdL = multiDayCurve([longRun]);
  check('60 min at speed with only an end value: a durability reading, listed as skipped (why durability, 60 min)', !mdL.points.length && mdL.skipped[0].why === 'durability' && mdL.skipped[0].atMin === 60, JSON.stringify(mdL.skipped));
  const longMid = single(8.0, 1.9, drifting(132), { durSec: 3600, mid: 1.1, midSec: 1800 });
  const mdM = multiDayCurve([longMid]);
  check('…with a mid value at 30 min: that value is the point, heart rate from minutes 8–13', mdM.points.length === 1 && mdM.points[0].la === 1.1 && mdM.points[0].from === 'mid' && mdM.points[0].hr > 132 && mdM.points[0].hr < 136, JSON.stringify(mdM.points[0]));
  const short = multiDayCurve([single(8.0, 1.0, drifting(132), { durSec: 600 })]);
  check('a 10-min run: too short for the curve, listed', !short.points.length && short.skipped[0].why === 'too-short');
  const dur2 = multiDayCurve([twoLapRun({ speed: 8.7, lap1: 1.0, end: 1.6, lap2Min: 40, id: 'c40' })]);
  check('a two-lap run whose lap 2 ran 40 min: durability, not a point', !dur2.points.length && dur2.skipped[0].why === 'durability');
  const mlss = multiDayCurve([twoLapRun({ purpose: 'mlss', speed: 10.5, lap1: 3.2, end: 3.6, lap2Min: 20, id: 'c20' })]);
  check('an MLSS two-lap run (lap 2 = 20 min) is a point at 10.5 km/h', mlss.points.length === 1 && mlss.points[0].x === 10.5 && mlss.points[0].la === 3.6);
  check('earlyWindowHr of a 12-min run: NaN (minutes 8–13 are not there)', Number.isNaN(earlyWindowHr(single(8.0, 1.0, drifting(132), { durSec: 720 }))));
}
// ───────────── 5. LT1 session: late ceiling LT1 + 5 ─────────────
{
  const zones = computeZones({ lt1Hr: 143, lt2Hr: 157, lt1Speed: 8.7, lt2Speed: 10.5, maxHr: 188 }); const T = sessionTargets(zones, 'lt1', { minutes: 50 });
  check('LT1 targets carry the ceiling 148 (LT1 + 5) from minute 20', T.hrLo === 133 && T.hrHi === 140 && T.ceilHr === 148 && T.lateFromSec === 1200, JSON.stringify(T));
  check('LT1 targets say the band is judged from minute 10 (judgeFromSec 600)', T.judgeFromSec === 600);
  spoken.length = 0; const src = new ClockSource(now); const eng = new SessionEngine({ settings, alerts }); eng.setSource(src); eng.configure({ mode: 'lt1', targets: T, meta: { speed: 8.3, incline: 1, warmup: { lo: '7.0', hi: '7.5', sub: '8.5', ramp: '9.5', recLo: '6.5', recHi: '7.0', walk: '5.5', bandLo: '7.7', bandHi: '8.4' } } }); eng.start(); clearInterval(eng.timer);
  check('LT1 start: the warm-up intensity is spoken (v1.1.25)', spoken.some(t => /워밍업 5분. 시속 7.0에서 7.5/.test(t)), spoken.join(' | '));
  src.run(300, 118); check('5:00: the main speed and "judged from minute 10"', spoken.some(t => /본 속도로. 시속 7.7에서 8.4. 판정은 10분부터/.test(t)), spoken.join(' | '));
  src.run(240, 150);
  check('0–9 min: a low warm-up heart rate and even 4 min at 150 give no zone cue (judged from minute 10)', !spoken.some(t => /심박/.test(t)), spoken.join(' | '));
  src.run(60, 138); check('10:00: "판정 시작"', spoken.some(t => /판정 시작/.test(t)));
  src.run(300, 145);
  check('minute 10–15 at 145 (above the band 133–140): the zone-high cue, zone "above"', spoken.some(t => /심박 높음/.test(t)) && eng.zoneState === 'above', spoken.join(' | '));
  spoken.length = 0; src.run(LATE_FROM_SEC - 900 + 5, 138); src.run(300, 145);
  check('after minute 20 at 145 (under the ceiling 148): zone "drift", no zone cue (only the halfway cue of the 50-min session)', eng.zoneState === 'drift' && !spoken.some(t => /심박|천장/.test(t)), `${eng.zoneState} ${spoken.join(' | ')}`);
  src.run(120, 150);
  check('150 for 2 min after minute 20: the ceiling cue "slow down 0.3", zone "above"', spoken.some(t => /후반 심박 천장 초과.*0\.3/.test(t)) && eng.zoneState === 'above', spoken.join(' | '));
  const s = eng.stop('user');
  check('time in zone counts the drift minutes as in zone (minute 9–10, 15–20 and the drift minutes 20–25)', s.tiz.inSec >= 60 + 300 + 300 && s.tiz.inSec < 60 + 305 + 300 + 30 && s.tiz.inSec < s.tiz.totalSec, JSON.stringify(s.tiz));
}
// ───────────── 6. Weekly plan: Thursday = the verification run; the long-run cap ─────────────
{
  const zones = computeZones({ lt1Hr: 143, lt2Hr: 157, lt1Speed: 8.7, lt2Speed: 10.5, maxHr: 188 });
  const p = weeklyPlan({ zones, week: 2, weekdayMin: 60, weekendMin: 150, verifySpeed: 8.9 });
  const thu = p.days.find(d => d.day === 4), sat = p.days.find(d => d.day === 6);
  check('Thursday is the two-lap verification run, 45 min, at the band finder\'s speed', thu.type === 'verify' && thu.minutes === 45 && thu.speed === 8.9 && /8\.9 km\/h/.test(thu.en) && /gap 60–90 s/.test(thu.note.en), thu.en);
  check('Saturday long run 80 min (block week 2: 70 + 10), note: mid sample at 30 min + end sample', sat.minutes === 80 && /mid sample at 30/.test(sat.note.en) && p.longCap === null, `${sat.minutes} ${sat.note.en}`);
  const sessions = [{ final: true, sourceKind: 'ble', startedAt: now - 10 * DAY, endedAt: now - 10 * DAY + 62 * 60000, metrics: { durationSec: 62 * 60 } }, { final: true, sourceKind: 'demo', startedAt: now - 3 * DAY, endedAt: now - 3 * DAY + 150 * 60000, metrics: { durationSec: 9000 } }, { final: true, sourceKind: 'ble', startedAt: now - 40 * DAY, endedAt: now - 40 * DAY + 150 * 60000, metrics: { durationSec: 9000 } }];
  check('longest real run of the last 30 days: 62 min (the demo and the 40-day-old run do not count)', longestRecentMin(sessions) === 62);
  const pc = weeklyPlan({ zones, week: 2, weekdayMin: 60, weekendMin: 150, longestMin: 62 }); const satC = pc.days.find(d => d.day === 6);
  check('the long run is capped at 110 % of 62 = 68 → 70 min (rounded to 5), and the note says so', satC.minutes === 70 && pc.longCap && pc.longCap.cap === 70 && /110 % of the 30-day longest \(62 min\)/.test(satC.note.en), `${satC.minutes} ${satC.note.en}`);
  check('a cap above the planned long run leaves it alone (block week 4 → 100 min, longest 95 → cap 105)', (() => { const q = weeklyPlan({ zones, week: 1, blockWeek: 4, longestMin: 95 }); return q.days.find(d => d.day === 6).minutes === 100 && q.longCap === null; })());
  check('a longest run above the plan leaves the plan alone', weeklyPlan({ zones, week: 2, longestMin: 120 }).longCap === null);
}
// ───────────── 6a. Warm-up intensities spoken in the LT2 and two-lap modes (v1.1.25) ─────────────
{
  const W = { lo: '7.0', hi: '7.5', sub: '8.5', ramp: '9.5', recLo: '6.5', recHi: '7.0', walk: '5.5', bandLo: '7.7', bandHi: '8.4' };
  spoken.length = 0; let src = new ClockSource(now); let eng = new SessionEngine({ settings, alerts }); eng.setSource(src);
  eng.configure({ mode: 'lt2', intervals: { warmupSec: 600, reps: 2, workSec: 120, restSec: 60, cooldownSec: 60 }, targets: null, meta: { speed: 10.5, incline: 1, warmup: W } }); eng.start(); clearInterval(eng.timer);
  check('LT2 start: warm-up 10 min at 7.5, 8.5 at 4 min, 9.5 at 7 min', spoken.some(t => /워밍업 10분. 시속 7.5. 4분에 8.5, 7분에 9.5/.test(t)), spoken.join(' | '));
  src.run(245, 130); check('4:00: "시속 8.5로"', spoken.some(t => /시속 8.5로/.test(t)));
  src.run(180, 135); check('7:00: "시속 9.5로"', spoken.some(t => /시속 9.5로/.test(t)));
  src.run(180, 150); src.run(125, 160); check('after rep 1: the recovery jog speed is spoken', spoken.some(t => /회복. 시속 6.5에서 7.0/.test(t)), spoken.join(' | '));
  src.run(65, 140); src.run(125, 160); check('after the last rep: the cool-down speeds', spoken.some(t => /쿨다운 6분. 3분 시속 7.0, 3분 걷기 5.5/.test(t)), spoken.join(' | '));
  eng.stop('user');
  spoken.length = 0; src = new ClockSource(now); eng = new SessionEngine({ settings, alerts }); eng.setSource(src);
  eng.configure({ mode: 'verify', laps: { warmupSec: 300, lap1Sec: 600, lap2Sec: 1800, gapCapSec: 180, sampleAtSec: 30 }, targets: null, meta: { speed: 8.7, incline: 1, purpose: 'lt1', warmup: W } }); eng.start(); clearInterval(eng.timer);
  check('two-lap start: 30 s walk at 5.5 then 7.0–7.5', spoken.some(t => /워밍업 5분. 30초 걷기 5.5, 그 다음 시속 7.0에서 7.5/.test(t)), spoken.join(' | '));
  src.run(35, 110); check('0:30: "시속 7.0에서 7.5로"', spoken.some(t => /시속 7.0에서 7.5로/.test(t)));
  eng.stop('user');
  spoken.length = 0; src = new ClockSource(now); eng = new SessionEngine({ settings, alerts }); eng.setSource(src);
  eng.configure({ mode: 'verify', laps: { warmupSec: 300, lap1Sec: 600, lap2Sec: 1200, gapCapSec: 180, sampleAtSec: 30 }, targets: null, meta: { speed: 10.5, incline: 1, purpose: 'mlss', warmup: W } }); eng.start(); clearInterval(eng.timer);
  check('MLSS variant start: 2 min at 7.5, 3 min at 8.5', spoken.some(t => /워밍업 5분. 2분 시속 7.5, 3분 8.5/.test(t)), spoken.join(' | '));
  src.run(125, 120); check('2:00: "시속 8.5로"', spoken.some(t => /시속 8.5로/.test(t)));
  eng.stop('user');
}
// ───────────── 6b. Step test: the heart-rate stop criterion (v1.1.23, replaces RPE) ─────────────
{
  spoken.length = 0; const src = new ClockSource(now); const eng = new SessionEngine({ settings, alerts }); eng.setSource(src);
  eng.configure({ mode: 'test', protocol: { ...settings.protocol, warmupSec: 0, stageSec: 180, pauseSec: 30 }, meta: { stopHr: 179 } }); eng.start(); clearInterval(eng.timer);
  src.run(60, 150); check('stage 1 at 150 bpm: no stop cue', !spoken.some(t => /종료 기준/.test(t)));
  src.run(20, 180); check('20 s at 180 (≥ 179): not yet', !spoken.some(t => /종료 기준/.test(t)));
  src.run(15, 180); check('30 s at or above the stop heart rate → the stop-criterion cue, once', spoken.filter(t => /종료 기준/.test(t)).length === 1 && eng.stopAdvised === true, spoken.join(' | '));
  src.run(60, 182); check('…and not again', spoken.filter(t => /종료 기준/.test(t)).length === 1);
  eng.stop('user');
}
// ───────────── 7. α1 artifact gate 3 %; monthly resting-lactate reminder ─────────────
{
  const rows = [3, 5, 7, 9, 11, 13].map((v, i) => ({ idx: i + 1, speed: 6 + i, hr: 110 + 10 * i, alpha1: 1.2 - 0.12 * i, artifactPct: i === 2 ? 3.5 : 1 }));
  const h = hrvThresholds(rows); const h5 = hrvThresholds(rows, { artifactLimit: 5 });
  check('hrvThresholds leaves out a stage with 3.5 % artifacts (gate 3 %), kept with the old 5 % limit', ALPHA_ARTIFACT_MAX === 3 && h.points === 5 && h5.points === 6, `${h.points} vs ${h5.points}`);
  const t0 = now - DAY; const feats = [];
  for (let i = 0; i < 120; i++) feats.push({ t: t0 + i * 5000, alpha1: i % 2 ? 0.9 : 0.4, phase: 'work', artifactPct: i % 2 ? 1 : 4, hrInst: 140 });
  const m = sessionMetrics({ type: 'lt1', final: true, startedAt: t0, endedAt: t0 + 600000, hrLive: [[t0, 140], [t0 + 599000, 140]], features: feats, events: [] });
  check('sessionMetrics: the mean α1 takes the clean windows only (0.9), not the 4 %-artifact ones (0.4)', Math.abs(m.meanAlpha1 - 0.9) < 1e-9, m.meanAlpha1.toFixed(2));
  setRestBaseline(0.8);
  const zones = computeZones({ lt1Hr: 143, lt2Hr: 157, lt1Speed: 8.7, lt2Speed: 10.5, maxHr: 188 });
  const old = assessRecent([], zones, now - 7 * DAY, { restLactateAt: now - 35 * DAY }); const fresh = assessRecent([], zones, now - 7 * DAY, { restLactateAt: now - 10 * DAY }); const noDate = assessRecent([], zones, now - 7 * DAY, {});
  check('resting lactate measured 35 days ago → a reminder to re-measure; 10 days ago → none; no date → asks for the date', old.notes.some(n => n.kind === 'rest' && /35 days/.test(n.en)) && !fresh.notes.some(n => n.kind === 'rest') && noDate.notes.some(n => n.kind === 'rest' && /No date/.test(n.en)), old.notes.find(n => n.kind === 'rest')?.en);
  setRestBaseline(null);
  check('no baseline set → no reminder', !assessRecent([], zones, now - 7 * DAY, { restLactateAt: now - 60 * DAY }).notes.some(n => n.kind === 'rest'));
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS'); process.exit(failures ? 1 : 0);

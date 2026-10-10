// Where the running stopped (analysis.js runTimeline) and everything the verification card derives from it.
// Sessions are simulated: heart rate with realistic on/off kinetics, noise and slow wander; the moment the belt stopped is known.
import { runTimeline, pauseIntervals, runWindowStart, runWindowEnd, stoppedMs, smo2Steady, RUN_END } from '../js/analysis.js';
import { lactateChecks, midLabel, lactateVerdict, endWindowStats, endOnlyProxy, verdictZoneChange, multiDayCurve, sessionMetrics, claudeSummary } from '../js/prescribe.js';

let failures = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) failures++; };
const T0 = Date.UTC(2026, 9, 7, 6, 0, 0);
const mmss = sec => { const x = Math.round(sec); return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`; };
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
function rng(seed) { let s = (seed >>> 0) || 1; const u = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; const g = () => { let a = 0; while (!a) a = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u()); }; return { u, g }; }

/**
 * Heart rate, one value a second. segs: [{ until (s), hr (bpm or fn(s)), tau (s; default 35 up / 60 down), fast (0..1: share of a drop
 * that goes within seconds, tau 15 s — the fast phase of heart-rate recovery) }]. gaps: [[from, to]] seconds without a strap signal.
 */
function simHr({ segs, seed = 1, noise = 1.5, wander = 1, h0 = 95, gaps = [], step = 1 }) {
  const { g } = rng(seed); const out = []; let slow = h0, fast = 0, cur = null; const total = segs[segs.length - 1].until;
  for (let sec = 0; sec <= total; sec++) {
    const seg = segs.find(x => sec < x.until) || segs[segs.length - 1];
    const target = typeof seg.hr === 'function' ? seg.hr(sec) : seg.hr;
    if (seg !== cur) { cur = seg; const h = slow + fast; if (seg.fast && target < h) { fast = seg.fast * (h - target); slow = h - fast; } else { slow = h; fast = 0; } }
    const tau = seg.tau || (target >= slow ? 35 : 60);
    slow += (target - slow) * (1 - Math.exp(-1 / tau)); fast *= Math.exp(-1 / 15);
    if (sec % step) continue; if (gaps.some(k => sec >= k[0] && sec < k[1])) continue;
    out.push([T0 + sec * 1000, Math.round(slow + fast + noise * g() + wander * Math.sin(sec / 41 + seed))]);
  }
  return out;
}
/**
 * A session as the engine saves it. lactate: [[sec, value | null]] (null = the entry dialog was skipped); pauses: [[from, to | null]];
 * phases: [[sec, name]] (LT2 mode); a1: fn(sec) → α1 of the feature stamped at sec; smo2: fn(sec) → %.
 */
function mk({ hr, type = 'free', speed = 10.5, purpose, lactate = [], rpe = [], pauses = [], phases = null, endSec = null, final = true, a1 = () => 0.45, smo2 = null, extra = {} }) {
  const last = hr.length ? hr[hr.length - 1][0] : T0; const endedAt = final ? (endSec != null ? T0 + endSec * 1000 : last) : null;
  const ev = [{ t: T0, type: 'start', mode: type }];
  if (phases) for (const [sec, name] of phases) ev.push({ t: T0 + sec * 1000, type: 'phase', phase: name }); else ev.push({ t: T0, type: 'phase', phase: 'work' });
  for (const [sec, v] of lactate) ev.push({ t: T0 + sec * 1000, type: 'lactate', value: v });
  for (const [sec, v] of rpe) ev.push({ t: T0 + sec * 1000, type: 'rpe', value: v });
  let pauseMs = 0; const piv = [];
  for (const [a, b] of pauses) { ev.push({ t: T0 + a * 1000, type: 'pause' }); const to = b != null ? T0 + b * 1000 : (endedAt ?? last); if (b != null) ev.push({ t: to, type: 'resume' }); pauseMs += to - (T0 + a * 1000); piv.push([T0 + a * 1000, to]); }
  if (final) ev.push({ t: endedAt, type: 'stop', reason: 'user' });
  ev.sort((x, y) => x.t - y.t);
  const features = []; for (let sec = 5; T0 + sec * 1000 <= last; sec += 5) { const t = T0 + sec * 1000; features.push({ t, alpha1: a1(sec), hr: 0, hrInst: 0, artifactPct: 0.5, samples: 240, phase: 'work', paused: piv.some(p => t > p[0] && t <= p[1]) }); }
  const s = { id: 'x' + Math.random().toString(36).slice(2), type, startedAt: T0, endedAt, final, sourceKind: 'ble', speed, incline: 1, hrLive: hr, features, rr: [], stages: [], events: ev, tiz: { inSec: 0, totalSec: 0 }, pauseMs, alpha1Settings: { windowSec: 120 }, ...extra };
  if (purpose !== undefined) s.purpose = purpose;
  if (smo2) { const ser = []; for (let sec = 0; T0 + sec * 1000 <= last; sec += 2) ser.push([T0 + sec * 1000, smo2(sec), 25]); s.smo2 = { series: ser, offsetMs: 0 }; }
  return s;
}
const rel = (s, t) => (t - s.startedAt) / 1000;
/** The same session moved to yesterday (the multi-day curve takes the last 60 days only), every time stamp shifted alike. */
const recent = s => { const d = Date.now() - 86400000 - s.startedAt; return { ...s, id: s.id + 'r', startedAt: s.startedAt + d, endedAt: s.endedAt + d, hrLive: s.hrLive.map(p => [p[0] + d, p[1]]), features: s.features.map(f => ({ ...f, t: f.t + d })), events: s.events.map(e => ({ ...e, t: e.t + d })) }; };
const ZONES = { lt1Hr: 140, lt1Speed: 8.4, lt2Hr: 157, lt2Speed: 10.5 };
/** Mean heart rate of the seconds [a, b) — the truth a window should give. */
const truthHr = (s, a, b) => mean(s.hrLive.filter(p => p[0] >= T0 + a * 1000 && p[0] < T0 + b * 1000).map(p => p[1]));

// ───────────── 1. An LT1 check: the value is typed while standing, then the recording runs on ─────────────
{
  const RUN = 2100; // 35 min at ≈ 138 bpm
  const hrOf = (tail, seed) => simHr({ segs: [{ until: RUN, hr: 138 }, { until: RUN + 90, hr: 96, fast: 0.5 }, { until: RUN + 90 + 600, hr: 112, tau: 40 }], seed }).filter(p => p[0] <= T0 + (RUN + tail) * 1000);
  for (const [name, tail] of [['Finish 10 s after typing', 70], ['Finish 3 min after the stop', 180], ['90 s standing, then 8 min of walking', 570]]) {
    const s = mk({ hr: hrOf(tail, 3), speed: 8.6, lactate: [[40, 1.2], [RUN + 60, 1.9]], endSec: RUN + tail });
    const tl = runTimeline(s); const ew = endWindowStats(s, 300); const err = rel(s, tl.end) - RUN; const truth = truthHr(s, RUN - 300, RUN);
    check(`LT1 check, ${name}: the run ends at the stop`, tl.how === 'sample' && tl.sure && err >= 0 && err <= 20, `end ${mmss(rel(s, tl.end))} (belt stopped ${mmss(RUN)}), tail ${Math.round(tl.tailSec)} s`);
    check('  last-5-min heart rate is that of the running', Math.abs(ew.hr - truth) < 0.6 && ew.sure && ew.how === 'sample', `${ew.hr.toFixed(1)} vs ${truth.toFixed(1)} bpm (recording end: ${truthHr(s, RUN + tail - 300, RUN + tail + 1).toFixed(1)})`);
    const c = lactateChecks(s); check('  samples: rest 1.2, end 1.9, no mid', c.rest === 1.2 && c.end === 1.9 && c.mid === null, JSON.stringify(c));
    const vd = lactateVerdict(s); const z = verdictZoneChange({ ...ZONES, lt1Hr: 130 }, s, vd);
    check('  verdict below LT1; the zone floor takes the running heart rate', vd.level === 'ok' && z && z.zones.lt1Hr === Math.round(ew.hr) && z.zones.lt1Speed === 8.6, z ? z.en : 'no change');
    const m = sessionMetrics(s); check('  session numbers: mean heart rate without the recovery, duration still that of the recording', Math.abs(m.durationSec - (RUN + tail)) < 1.5 && m.meanHr > truthHr(s, 0, RUN + tail + 1) - 0.01 && Math.abs(m.meanHr - truthHr(s, 0, rel(s, tl.end) + 0.5)) < 0.3, `mean ${m.meanHr.toFixed(1)}, duration ${m.durationSec}`);
  }
}

// ───────────── 2. Two steps down: walked first, then sat down for the sample ─────────────
{
  const RUN = 2100;
  const hr = simHr({ segs: [{ until: RUN, hr: 138 }, { until: RUN + 120, hr: 118, tau: 40 }, { until: RUN + 330, hr: 92, tau: 50 }], seed: 9 });
  const s = mk({ hr, speed: 8.6, lactate: [[RUN + 210, 1.9]] }); const tl = runTimeline(s); const err = rel(s, tl.end) - RUN;
  check('walk 2 min, then sit: the run ended where the walking began, not where the sitting did', tl.how === 'sample' && tl.sure && err >= 0 && err <= 30, `end ${mmss(rel(s, tl.end))}`);
  check('  last-5-min heart rate', Math.abs(endWindowStats(s).hr - truthHr(s, RUN - 300, RUN)) < 0.8, endWindowStats(s).hr.toFixed(1));
  // a cool-down jog of a quarter of an hour before the sample: the stop is found, but at a level that is not the run's → shown, not relied on
  const hr2 = simHr({ segs: [{ until: 1800, hr: 160 }, { until: 1800 + 840, hr: 142, tau: 40 }, { until: 1800 + 840 + 200, hr: 100, fast: 0.5 }], seed: 4 });
  const s2 = mk({ hr: hr2, lactate: [[1800 + 840 + 70, 3.6]], purpose: 'mlss' }); const t2 = runTimeline(s2);
  check('14-min jog before the sample: uncertain (why "level"), no heart rate in the zone change, no proxy call', t2.how === 'sample' && !t2.sure && t2.why === 'level' && lactateVerdict(s2).unsure === true && (() => { const z = verdictZoneChange({ ...ZONES, lt2Hr: 120 }, s2); return !z || z.zones.lt2Hr === 120; })(), `end ${mmss(rel(s2, t2.end))} ${t2.why}`);
}

// ───────────── 2b. Long run (10/10): mid sample at 30 min, the field says 30 min, not 10 ─────────────
{
  const END = 5490; const level = sec => 128 + 8 * Math.min(1, sec / 600) + 8 * Math.max(0, sec - 1900) / 3600;
  const hr = simHr({ segs: [{ until: 1800, hr: level }, { until: 1890, hr: 100, fast: 0.4 }, { until: END, hr: level }, { until: END + 120, hr: 96, fast: 0.5 }], seed: 31 });
  const s = mk({ hr, lactate: [[60, 0.6], [1840, 0.8], [END + 60, 1.9]] }); const c = lactateChecks(s);
  check('long run: the 30-min value is the mid sample and its field says 30 min', c.rest === 0.6 && c.mid === 0.8 && c.end === 1.9 && c.midMin === 30 && midLabel(c).en === 'mid (30 min)', JSON.stringify(c));
  // its verdict is about durability: no LT1 call, no zone change (the app used to say "borderline LT1, target HR −2 bpm")
  const s78 = { ...s, speed: 7.8 }; const vd = lactateVerdict(s78);
  check('long run: verdict says long run, changes no zone', vd.longRun === true && vd.level === 'near' && vd.adjust === null && /Long run, 9\d min/.test(vd.en) && verdictZoneChange({ lt1Hr: 143, lt1Speed: 8.7 }, s78, vd) === null, vd.en);
  // in the multi-day curve the 30-min value stands for 7.8 km/h, not the end value; short checks keep their end value
  const shortRun = (speed, end, lvl, seed) => { const E = 2100; const h = simHr({ segs: [{ until: E, hr: sec => lvl + 6 * Math.min(1, sec / 600) }, { until: E + 120, hr: 100, fast: 0.5 }], seed }); return { ...mk({ hr: h, lactate: [[E + 40, end]] }), speed }; };
  const md = multiDayCurve([s78, shortRun(8.5, 1.0, 138, 41), shortRun(9.0, 2.8, 146, 42)]); const p78 = md.points.find(p => p.x === 7.8);
  check('multi-day curve: a long run is a point by its 30-min value (0.8) with the heart rate before it, not its end value (1.9)', p78 && p78.la === 0.8 && p78.from === 'mid' && p78.atMin === 30 && p78.hr > 130 && p78.hr < 140 && md.points.length === 3, JSON.stringify(p78));
  const noMid = { ...mk({ hr, lactate: [[END + 60, 1.9]] }), speed: 7.6 };
  check('…a long run with only an end value is left out of the curve', !multiDayCurve([noMid]).points.length);
  // the mid value typed in the card (10/10: entered in the 「10분」 field): a retyped value keeps the time of the sample it corrects;
  // a value typed with no sample of its own is left out and listed — until its minute is typed in the card
  const retyped = { ...s78, lactateChecks: { mid: 0.9 }, lactateChecksV: 2 }; const cr = lactateChecks(retyped);
  check('mid value retyped in the card keeps the minute of the logged sample', cr.mid === 0.9 && cr.midMin === 30 && multiDayCurve([retyped]).points[0]?.la === 0.9, JSON.stringify(cr));
  const typedOnly = { ...mk({ hr, lactate: [[60, 0.6], [END + 60, 1.9]] }), speed: 7.8, lactateChecks: { mid: 0.8 }, lactateChecksV: 2 };
  const mdT = multiDayCurve([typedOnly]);
  check('mid typed with no time: left out of the curve and listed as skipped', !mdT.points.length && mdT.skipped.length === 1 && mdT.skipped[0].x === 7.8 && mdT.skipped[0].why === 'long-no-mid', JSON.stringify(mdT.skipped));
  { const un = multiDayCurve([{ ...s78, final: false }]), ns = multiDayCurve([{ ...s78, speed: null }]);
    check('every left-out run says why (unfinished, no speed)', un.skipped[0]?.why === 'unfinished' && ns.skipped[0]?.why === 'no-speed' && !un.points.length && !ns.points.length, JSON.stringify([un.skipped, ns.skipped])); }
  const typedMin = { ...typedOnly, midMinTyped: 30 }; const mdM = multiDayCurve([typedMin]);
  check('…with its minute typed (30) it becomes the 7.8 km/h point', mdM.points.length === 1 && mdM.points[0].la === 0.8 && mdM.points[0].atMin === 30 && mdM.points[0].hr > 130 && mdM.points[0].hr < 140 && !mdM.skipped.length && lactateChecks(typedMin).midMin === 30, JSON.stringify(mdM.points[0]));
}

// ───────────── 3. MLSS check with a 10-min sample: a stop inside the run ─────────────
{
  const level = sec => 150 + 6 * Math.min(1, sec / 600) + 8 * Math.max(0, sec - 675) / 1200; const END = 1875; // 30 min of running + the 75-s stop
  const segs = () => [{ until: 600, hr: level }, { until: 675, hr: 112, fast: 0.4 }, { until: END, hr: level }, { until: END + 120, hr: 104, fast: 0.5 }, { until: END + 420, hr: 118, tau: 40 }];
  const hr = simHr({ segs: segs(), seed: 5 });
  const a1 = sec => (sec > 600 && sec <= 675 + 60) ? 1.3 : (sec > 675 + 60 && sec <= 675 + 60 + 120) ? 0.9 : sec > END ? 1.2 : 0.45; // standing / window still holding standing beats / running
  const s = mk({ hr, purpose: 'mlss', lactate: [[650, 3.4], [END + 70, 4.1]], a1 }); const tl = runTimeline(s);
  check('MLSS with 10-min sample: end at the last stop, one stop inside the run', tl.how === 'sample' && tl.sure && Math.abs(rel(s, tl.end) - END) <= 20 && tl.stops.length === 1 && Math.abs(rel(s, tl.stops[0][0]) - 600) <= 20 && rel(s, tl.stops[0][1]) >= 675 && rel(s, tl.stops[0][1]) <= 675 + 150, `end ${mmss(rel(s, tl.end))}, stop ${tl.stops.map(x => mmss(rel(s, x[0])) + '–' + mmss(rel(s, x[1]))).join()}`);
  const c = lactateChecks(s); check('  10-min value is the mid sample, the last one the end sample', c.mid === 3.4 && c.end === 4.1 && c.rest === null, JSON.stringify(c));
  check('  the mid sample carries the minute it was taken (card label "중간(10분)", not a fixed 10)', c.midMin === 10 && midLabel(c).ko === '중간(10분)' && midLabel({ mid: 0.8 }).ko === '중간', JSON.stringify(c));
  const vd = lactateVerdict(s); check('  verdict by the rise 3.4 → 4.1', vd.kind === 'mlss' && vd.level === 'ok' && /0\.7/.test(vd.en), vd.en);
  const px = endOnlyProxy(s); const stood = (tl.stops[0][2] - tl.stops[0][0]) / 60000;
  check('  running time leaves out the standing (75 s), not the minute the heart rate took to come back', Math.abs(px.durMin - ((tl.end - T0) / 60000 - stood)) < 1e-9 && px.durMin > 29.7 && px.durMin < 30.4 && stood > 1 && stood < 1.6 && tl.stops[0][2] < tl.stops[0][1] && Math.abs(stoppedMs(tl, T0, tl.end) / 60000 - stood) < 1e-9, `${px.durMin.toFixed(2)} min of running, stood ${(stood * 60).toFixed(0)} s, heart rate back after ${((tl.stops[0][1] - tl.stops[0][0]) / 1000).toFixed(0)} s`);
  // drift: the same run without the stop is the truth for minutes 8–13
  const plain = mk({ hr: simHr({ segs: [{ until: 1800, hr: sec => 150 + 6 * Math.min(1, sec / 600) + 8 * Math.max(0, sec - 600) / 1200 }], seed: 5 }), purpose: 'mlss', lactate: [[1795, 4.1]] });
  const pxPlain = endOnlyProxy(plain);
  check('  drift (min 8–13 → last 5) is not inflated by the stop', Math.abs(px.driftBpm - pxPlain.driftBpm) < 1.6 && px.driftBpm < 10, `with stop ${px.driftBpm.toFixed(1)}, same run without ${pxPlain.driftBpm.toFixed(1)} bpm`);
  const naive = mean(hr.filter(p => p[0] >= tl.end - 300000 && p[0] <= tl.end).map(p => p[1])) - mean(hr.filter(p => p[0] >= T0 + 480000 && p[0] < T0 + 780000).map(p => p[1]));
  check('  (the stop counted in would have added several bpm)', naive - px.driftBpm > 3, `naive ${naive.toFixed(1)}`);
  const m = sessionMetrics(s); check('  session α1 leaves out the standing and the 2 min after it', Math.abs(m.meanAlpha1 - 0.45) < 1e-9 && m.minAlpha1 === 0.45, `mean α1 ${m.meanAlpha1}`);
  const running = hr.filter(p => p[0] <= tl.end && !(p[0] > tl.stops[0][0] && p[0] < tl.stops[0][1])).map(p => p[1]);
  check('  session heart rate: that of the running — neither the stop for the sample nor the recovery at the end is in it', Math.abs(m.meanHr - mean(running)) < 1e-9 && m.meanHr - mean(hr.map(p => p[1])) > 1.5, `${m.meanHr.toFixed(1)} (whole recording ${mean(hr.map(p => p[1])).toFixed(1)})`);
  // the value typed only after running again → the same stop
  const s2 = mk({ hr, purpose: 'mlss', lactate: [[790, 3.4], [END + 70, 4.1]] }); const c2 = lactateChecks(s2); const t2 = runTimeline(s2);
  check('10-min value typed 2 min after running again: still the mid sample of that stop', c2.mid === 3.4 && c2.end === 4.1 && t2.stops.length === 1 && Math.abs(rel(s2, t2.stops[0][0]) - 600) <= 20, JSON.stringify(c2));
  // entry skipped (no value) at the 10-min stop: the stop still counts
  const s3 = mk({ hr, purpose: 'mlss', lactate: [[650, null], [END + 70, 4.1]] }); const p3 = endOnlyProxy(s3);
  check('10-min entry skipped: no mid value, the stop is still left out of the drift', lactateChecks(s3).mid === null && runTimeline(s3).stops.length === 1 && Math.abs(p3.driftBpm - px.driftBpm) < 1e-9);
  // two fingers at the end
  const s4 = mk({ hr, purpose: 'mlss', lactate: [[650, 3.4], [END + 60, 4.1], [END + 150, 4.4]] }); const c4 = lactateChecks(s4);
  check('two fingers at the end: both belong to the end, the first one counts', c4.mid === 3.4 && c4.end === 4.1 && Math.abs(rel(s4, runTimeline(s4).end) - END) <= 20, JSON.stringify(c4));
  const s5 = mk({ hr, purpose: 'mlss', lactate: [[END + 60, 4.1], [END + 150, 4.4]] }); const c5 = lactateChecks(s5);
  check('two fingers, no 10-min sample: the second is not taken for a mid sample', c5.mid === null && c5.end === 4.1, JSON.stringify(c5));
}

// ───────────── 4. The value typed long after the stop ─────────────
{
  const hr = simHr({ segs: [{ until: 1800, hr: 160 }, { until: 1890, hr: 118, fast: 0.5 }, { until: 1800 + 700, hr: 135, tau: 40 }], seed: 12 });
  const early = mk({ hr, purpose: 'mlss', lactate: [[1800 + 300, 4.0]] }), late = mk({ hr, purpose: 'mlss', lactate: [[1800 + 480, 4.0]] });
  const te = runTimeline(early), tl = runTimeline(late);
  check('typed 5 min after the stop: relied on', te.how === 'sample' && te.sure && Math.abs(rel(early, te.end) - 1800) <= 20);
  check(`typed 8 min after the stop (> ${RUN_END.lateMs / 60000} min): the stop is shown but not relied on`, tl.how === 'sample' && !tl.sure && tl.why === 'late-entry' && Math.abs(rel(late, tl.end) - 1800) <= 20 && endWindowStats(late).entryT === T0 + (1800 + 480) * 1000);
  check('  then: the proxy call is withheld and nothing is offered for the zones', lactateVerdict(late).unsure === true && lactateVerdict(late).level === 'near' && verdictZoneChange({ ...ZONES, lt2Hr: 120, lt2Speed: 9 }, late) === null && lactateVerdict(early).unsure !== true);
  const z = verdictZoneChange({ ...ZONES, lt2Hr: 120, lt2Speed: 9 }, { ...late, lactateChecks: { end: 2.5 } }); check('  a verdict that needs no proxy (end 2.5 → below LT2): the speed moves, the heart rate does not', z && z.zones.lt2Speed === 10.5 && z.zones.lt2Hr === 120, z ? z.en : 'none');
  const far = mk({ hr: simHr({ segs: [{ until: 1800, hr: 160 }, { until: 1890, hr: 118, fast: 0.5 }, { until: 1800 + 1000, hr: 135, tau: 40 }], seed: 12 }), purpose: 'mlss', lactate: [[1800 + 900, 4.0]] }); const tf = runTimeline(far);
  check('typed 15 min after the stop: beyond the search, the end is only an estimate', tf.how === 'hr' && !tf.sure && tf.why === 'no-entry' && Math.abs(rel(far, tf.end) - 1800) <= 20, `${tf.how} ${mmss(rel(far, tf.end))}`);
}

// ───────────── 4b. Pictures with two readings are shown, not relied on ─────────────
{
  const run = sec => 152 + 10 * Math.max(0, sec - 600) / 1200; const ZL = { lt1Hr: 140, lt1Speed: 8.4, lt2Hr: 120, lt2Speed: 9 };
  // straight into a 6-min cool-down jog 18 bpm lower, then stood for the sample
  const jog = mk({ hr: simHr({ segs: [{ until: 1800, hr: run }, { until: 2160, hr: 144, tau: 45 }, { until: 2250, hr: 102, tau: 55 }], seed: 2 }), speed: 10.8, purpose: 'mlss', lactate: [[2230, 4.6]] }); const tj = runTimeline(jog);
  check('6-min jog 18 bpm lower, then the sample: two steps down — the first is shown as the end, nothing is concluded', tj.how === 'sample' && !tj.sure && tj.why === 'two-steps' && Math.abs(rel(jog, tj.end) - 1800) <= 35, `${mmss(rel(jog, tj.end))} ${tj.why}`);
  check('  the value is still the end sample (typed after the stop), the proxy call is withheld, no zone moves', lactateChecks(jog).end === 4.6 && lactateVerdict(jog).unsure === true && verdictZoneChange(ZL, jog) === null && Number.isNaN(multiDayCurve([recent(jog)]).points[0].hr));
  check('  session numbers stay those of the whole recording', Math.abs(sessionMetrics(jog).meanHr - truthHr(jog, 0, 2251)) < 1e-9);
  // the same with the end confirmed in the card
  const jogOk = { ...jog, runEndSec: 1800 }; const tk = runTimeline(jogOk);
  check('  once the end is confirmed: certain, with the running heart rate, and the proxy call is made', tk.how === 'manual' && tk.sure && Math.abs(endWindowStats(jogOk).hr - truthHr(jog, 1500, 1801)) < 1e-9 && !lactateVerdict(jogOk).unsure && /HR drift \+\d+ bpm/.test(lactateVerdict(jogOk).en), lactateVerdict(jogOk).en.slice(0, 70));
  // walked 2 min, then stood: a staircase too, but a short one — no doubt there
  const stair = mk({ hr: simHr({ segs: [{ until: 1800, hr: run }, { until: 1920, hr: 140, tau: 40 }, { until: 2010, hr: 102, tau: 55 }], seed: 3 }), speed: 10.8, purpose: 'mlss', lactate: [[1990, 4.6]] }); const tst = runTimeline(stair);
  check('walked 2 min, then stood: the end is where the walking began, certain', tst.sure && Math.abs(rel(stair, tst.end) - 1800) <= 30, `${mmss(rel(stair, tst.end))} ${tst.why}`);
  // slowed down by 15 bpm (not stopped), value typed 4 min later while still moving
  const slow = mk({ hr: simHr({ segs: [{ until: 1800, hr: 160 }, { until: 2060, hr: 145, tau: 40 }], seed: 4 }), speed: 10.8, purpose: 'mlss', lactate: [[2040, 4.6]] }); const tsl = runTimeline(slow);
  check('15 bpm lower for 4 min and never further down, then a value: slowed or stopped? → shown, not relied on', tsl.how === 'sample' && !tsl.sure && tsl.why === 'shallow' && Math.abs(rel(slow, tsl.end) - 1800) <= 35 && lactateChecks(slow).end === 4.6, `${tsl.how} ${tsl.why} ${mmss(rel(slow, tsl.end))}`);
  // the same drop with the value typed after 75 s: a stop in its first minute looks no different — relied on
  const fresh = mk({ hr: simHr({ segs: [{ until: 1800, hr: 160 }, { until: 1890, hr: 145, tau: 40 }], seed: 4 }), speed: 10.8, purpose: 'mlss', lactate: [[1875, 4.6]] });
  check('  …typed 75 s after the drop: relied on', runTimeline(fresh).sure && runTimeline(fresh).how === 'sample');
  // a first value at the stop, another one 8 min later
  const two = mk({ hr: simHr({ segs: [{ until: 1800, hr: 160 }, { until: 1890, hr: 112, fast: 0.5 }, { until: 2400, hr: 128, tau: 40 }], seed: 5 }), speed: 10.8, purpose: 'mlss', lactate: [[1860, 4.4], [2290, 3.1]] }); const tt = runTimeline(two);
  check('a value at the stop and another 8 min later: flagged (late entry)', tt.how === 'sample' && !tt.sure && tt.why === 'late-entry' && Math.abs(rel(two, tt.end) - 1800) <= 20, `${tt.why}`);
}

// ───────────── 4c. Given up soon after the 10-min sample ─────────────
{
  const lvl = 158; // 10 min of running, 70 s for the sample, running again for `again` s, stop, value, Finish `tail` s after the stop
  const giveUp = (again, tail, typedAfter, seed) => { const stop2 = 670 + again; const hr = simHr({ segs: [{ until: 600, hr: lvl }, { until: 670, hr: 118, fast: 0.4 }, { until: stop2, hr: lvl + 3 }, { until: stop2 + tail, hr: 110, fast: 0.5 }], seed }); return { s: mk({ hr, purpose: 'mlss', lactate: [[650, 4.1], [stop2 + typedAfter, 7.2]] }), stop2 }; };
  for (const [again, tail, typed] of [[100, 90, 60], [180, 120, 70], [300, 90, 60], [100, 45, 30]]) {
    const { s, stop2 } = giveUp(again, tail, typed, 11 + again); const c = lactateChecks(s); const tl = runTimeline(s);
    check(`running again for ${again} s after the 10-min sample, then given up (value ${typed} s after the stop): 4.1 is the 10-min value, 7.2 the end value`, c.mid === 4.1 && c.end === 7.2, `${JSON.stringify(c)} end ${mmss(rel(s, tl.end))} (${tl.how})`);
    check('  the verdict is the rise 4.1 → 7.2: above MLSS', lactateVerdict(s).level === 'high' && /3\.1/.test(lactateVerdict(s).en));
    if (tl.how === 'sample') check('  the end of the run is the second stop', Math.abs(rel(s, tl.end) - stop2) <= 30, mmss(rel(s, tl.end)));
  }
  // the value typed 12 s after the second stop, Finish 8 s later: no stop to be seen yet — filed by the clock, and still right
  const { s: quick } = giveUp(150, 20, 12, 77); const cq = lactateChecks(quick);
  check('value typed 12 s after stopping, Finish at once: still 10-min value and end value', cq.mid === 4.1 && cq.end === 7.2, JSON.stringify(cq));
  // two fingers while standing after the 10-min stop of a run that goes on: both belong to that stop, the first counts
  const hr = simHr({ segs: [{ until: 600, hr: lvl }, { until: 720, hr: 112, fast: 0.4 }, { until: 1920, hr: lvl + 4 }, { until: 2010, hr: 108, fast: 0.5 }], seed: 78 });
  const fingers = mk({ hr, purpose: 'mlss', lactate: [[650, 4.1], [700, 4.3], [1980, 4.9]] }); const cf = lactateChecks(fingers);
  check('two fingers at the 10-min stop, one at the end: 4.1 / 4.9, one stop inside the run', cf.mid === 4.1 && cf.end === 4.9 && runTimeline(fingers).stops.length === 1, JSON.stringify(cf));
  // a value typed 8 min after a stop that was long over does not belong to that stop
  const stray = mk({ hr, purpose: 'mlss', lactate: [[650, 4.1], [1250, 4.5], [1980, 4.9]] }); const cs = lactateChecks(stray);
  check('a value typed while running, 9 min after the 10-min stop was over: not a second finger of that stop', cs.mid === 4.1 && cs.end === 4.9 && runTimeline(stray).stops.length === 1, JSON.stringify(cs));
}

// ───────────── 5. Nothing logged around the end ─────────────
{
  const RUN = 1800; const run = sec => 156 + 6 * sec / RUN;
  const tailHr = simHr({ segs: [{ until: RUN, hr: run }, { until: RUN + 100, hr: 108, fast: 0.5 }, { until: RUN + 400, hr: 120, tau: 40 }], seed: 21 });
  const s = mk({ hr: tailHr, purpose: 'mlss', extra: { lactateChecks: { end: 4.2 } } }); const tl = runTimeline(s); const ew = endWindowStats(s);
  check('values typed in the card afterwards, recording with a tail: estimate, not relied on', tl.how === 'hr' && !tl.sure && tl.why === 'no-entry' && Math.abs(rel(s, tl.end) - RUN) <= 20 && !ew.sure, `${tl.how} ${mmss(rel(s, tl.end))}`);
  check('  the estimate is what the card shows', Math.abs(ew.hr - truthHr(s, RUN - 300, RUN)) < 0.8, ew.hr.toFixed(1));
  const vd = lactateVerdict(s); check('  no proxy call from an estimated end', vd.level === 'near' && vd.unsure === true && vd.adjust === null && /uncertain/.test(vd.en), vd.en);
  const z = verdictZoneChange({ lt1Hr: 140, lt1Speed: 8.4, lt2Hr: 120, lt2Speed: 9 }, { ...s, lactateChecks: { end: 2.4 } });
  check('  a verdict that does not need the proxy still moves the speed, never the heart rate', z && z.zones.lt2Speed === 10.5 && z.zones.lt2Hr === 120 && !/bpm/.test(z.en), z ? z.en : 'none');
  const m = sessionMetrics(s); check('  session numbers stay those of the whole recording', Math.abs(m.meanHr - truthHr(s, 0, RUN + 401)) < 1e-9);
  // Finish pressed while running: nothing to estimate
  const flat = mk({ hr: simHr({ segs: [{ until: RUN, hr: run }], seed: 22 }), purpose: 'mlss', extra: { lactateChecks: { end: 4.2 } } }); const tf = runTimeline(flat);
  check('no tail (Finish while running): the end is the end of the recording, certain', tf.how === 'finish' && tf.sure && tf.end === flat.endedAt && tf.stops.length === 0 && tf.tailSec === 0);
  check('  proxy verdict as before', lactateVerdict(flat).level === 'ok' && !lactateVerdict(flat).unsure, lactateVerdict(flat).en);
  // a value typed by someone else while the athlete runs on, then Finish at speed
  const helper = mk({ hr: simHr({ segs: [{ until: 2100, hr: 138 }], seed: 23 }), speed: 8.6, lactate: [[2070, 1.8]] }); const th = runTimeline(helper);
  check('value typed while running, Finish while running: no stop is invented', th.how === 'finish' && th.sure && lactateChecks(helper).end === 1.8 && Math.abs(endWindowStats(helper).hr - truthHr(helper, 1800, 2101)) < 1e-9);
  // forgot to press Finish: half an hour of running, two hours on the sofa with some moving about
  const sofa = simHr({ segs: [{ until: 1800, hr: 150 }, { until: 2400, hr: 70, fast: 0.4 }, { until: 4000, hr: 62, tau: 200 }, { until: 4300, hr: 84, tau: 30 }, { until: 6000, hr: 60, tau: 60 }, { until: 6200, hr: 80, tau: 30 }, { until: 9000, hr: 58, tau: 60 }], seed: 31 });
  const forgot = mk({ hr: sofa, speed: 9, extra: { lactateChecks: { end: 2.9 } } }); const tg = runTimeline(forgot);
  check('Finish forgotten for two hours: the estimate is the end of the run, not something on the sofa', tg.how === 'hr' && !tg.sure && Math.abs(rel(forgot, tg.end) - 1800) <= 25, `${mmss(rel(forgot, tg.end))}`);
  // an earlier, harder stretch and no entry: by the heart rate alone the end cannot be told → estimate, flagged
  const surge = mk({ hr: simHr({ segs: [{ until: 900, hr: 140 }, { until: 1100, hr: 160, tau: 30 }, { until: 2400, hr: 140, tau: 40 }], seed: 33 }), speed: 9, extra: { lactateChecks: { end: 1.8 } } }); const ts = runTimeline(surge);
  check('a harder stretch of a few minutes earlier, the running going on at the old level: not taken for the end of the run', ts.how === 'finish' && ts.sure && ts.end === surge.endedAt, `${ts.how} ${mmss(rel(surge, ts.end))} sure ${ts.sure}`);
  // the pace lowered for good 20 min before Finish and nothing logged: by the heart rate alone this cannot be told from a cool-down → estimate, flagged
  const lower = mk({ hr: simHr({ segs: [{ until: 900, hr: 158 }, { until: 2100, hr: 140, tau: 40 }], seed: 34 }), speed: 9, extra: { lactateChecks: { end: 1.8 } } }); const tlw = runTimeline(lower);
  check('the pace lowered for good and nothing logged: an estimate that is flagged, never relied on', tlw.how === 'hr' && !tlw.sure && Math.abs(rel(lower, tlw.end) - 900) <= 30 && verdictZoneChange({ lt1Hr: 100, lt1Speed: 5 }, lower).zones.lt1Hr === 100, `${tlw.how} ${mmss(rel(lower, tlw.end))}`);
  // 90 s of false high readings in the middle
  const high = simHr({ segs: [{ until: 1800, hr: 140 }], seed: 35 }).map(p => (p[0] >= T0 + 700000 && p[0] < T0 + 790000) ? [p[0], p[1] + 22] : p);
  check('90 s of false high readings mid-run: no end is invented', runTimeline(mk({ hr: high, speed: 9, extra: { lactateChecks: { end: 1.8 } } })).how === 'finish');
  const surgeAnch = mk({ hr: simHr({ segs: [{ until: 900, hr: 140 }, { until: 1100, hr: 160, tau: 30 }, { until: 2400, hr: 140, tau: 40 }, { until: 2500, hr: 100, fast: 0.5 }], seed: 33 }), speed: 9, lactate: [[2460, 1.8]] }); const ta = runTimeline(surgeAnch);
  check('the same run with the value typed at the stop: certain, and the end is the stop', ta.how === 'sample' && ta.sure && Math.abs(rel(surgeAnch, ta.end) - 2400) <= 20, mmss(rel(surgeAnch, ta.end)));
}

// ───────────── 6. What is not a stop ─────────────
{
  // a slow slide (pace eased bit by bit, or cardiac drift downwards): 14 bpm over 10 min, value typed at the end while still running
  const slide = mk({ hr: simHr({ segs: [{ until: 1200, hr: 150 }, { until: 1800, hr: sec => 150 - 14 * (sec - 1200) / 600, tau: 20 }], seed: 41 }), lactate: [[1790, 2.2]], speed: 9 });
  check('a slow slide is not a stop', runTimeline(slide).how === 'finish' && runTimeline(slide).sure);
  // a dip of a few seconds (strap reads half) near the entry
  const hrDip = simHr({ segs: [{ until: 1800, hr: 150 }], seed: 42 }).map(p => (p[0] >= T0 + 1700000 && p[0] < T0 + 1708000) ? [p[0], Math.round(p[1] / 2)] : p);
  check('eight seconds of false low readings are not a stop', runTimeline(mk({ hr: hrDip, lactate: [[1790, 2.2]], speed: 9 })).how === 'finish');
  // a kick at the end, then the stop: the run ends at the stop, at the level of the kick
  const kick = mk({ hr: simHr({ segs: [{ until: 1700, hr: 150 }, { until: 1800, hr: 168, tau: 25 }, { until: 1900, hr: 110, fast: 0.5 }], seed: 43 }), lactate: [[1860, 5.2]], purpose: 'mlss' }); const tk = runTimeline(kick);
  check('a kick before the stop: the end is the stop', tk.how === 'sample' && tk.sure && Math.abs(rel(kick, tk.end) - 1800) <= 20, mmss(rel(kick, tk.end)));
  // a stop during the run that nothing logged (shoe lace): left alone — only what was logged is interpreted
  const lace = mk({ hr: simHr({ segs: [{ until: 900, hr: 150 }, { until: 960, hr: 115, fast: 0.4 }, { until: 1800, hr: 150 }], seed: 44 }), extra: { lactateChecks: { end: 2.0 } }, speed: 9 }); const tlc = runTimeline(lace);
  check('an unlogged stop mid-run is not interpreted', tlc.how === 'finish' && tlc.sure && tlc.stops.length === 0);
  // no heart rate at all / almost none
  const none = mk({ hr: [], lactate: [[30, 1.1], [600, 2.0], [1750, 2.4]], endSec: 1800, speed: 9 }); const cn = lactateChecks(none);
  check('no heart rate recorded: samples by the clock, nothing breaks', runTimeline(none).how === 'finish' && cn.rest === 1.1 && cn.mid === 2.0 && cn.end === 2.4 && Number.isNaN(endWindowStats(none).hr) && lactateVerdict(none).level === 'near');
  const sparse = mk({ hr: simHr({ segs: [{ until: 1800, hr: 150 }, { until: 1900, hr: 105, fast: 0.5 }], seed: 45, step: 5 }), lactate: [[1860, 2.4]], speed: 9 });
  check('one heart-rate value every 5 s (an imported file): filled in to one a second, the stop is timed as usual', runTimeline(sparse).how === 'sample' && runTimeline(sparse).sure && Math.abs(rel(sparse, runTimeline(sparse).end) - 1800) <= 20 && Math.abs(endWindowStats(sparse).hr - 150) < 1, `${runTimeline(sparse).how} ${mmss(rel(sparse, runTimeline(sparse).end))}`);
  // the same watch file with a 10-min hole from the stop on (auto-pause): nothing is made up across the hole
  const holed = mk({ hr: simHr({ segs: [{ until: 1800, hr: 150 }, { until: 2700, hr: 120, tau: 40 }], seed: 45, step: 5, gaps: [[1803, 2400]] }), extra: { lactateChecks: { end: 2.4 } }, speed: 9 }); const th = runTimeline(holed);
  check('  a 10-min hole in such a file stays a hole (the end is estimated at the last value before it, flagged — not a slow slide drawn across it)', th.how === 'hr' && !th.sure && Math.abs(rel(holed, th.end) - 1800) <= 30, `${th.how} ${mmss(rel(holed, th.end))}`);
  // strap silent around the stop
  const gap = mk({ hr: simHr({ segs: [{ until: 1800, hr: 150 }, { until: 2000, hr: 100, fast: 0.5 }], seed: 46, gaps: [[1770, 1840]] }), lactate: [[1860, 2.4]], speed: 9 }); const tg = runTimeline(gap);
  check('strap silent from 30 s before the stop to 40 s after: the end is put at the last running seconds or flagged, never later than the stop + 45 s', (tg.how === 'sample' || tg.how === 'hr') ? rel(gap, tg.end) <= 1845 : true, `${tg.how} ${mmss(rel(gap, tg.end))} sure ${tg.sure}`);
}

// ───────────── 7. Pause ─────────────
{
  const RUN = 1800; const base = seed => simHr({ segs: [{ until: RUN, hr: 158 }, { until: RUN + 150, hr: 105, fast: 0.5 }], seed });
  // Pause pressed at the stop, value typed, Finish while paused
  const a = mk({ hr: base(51), purpose: 'mlss', lactate: [[RUN + 70, 4.0]], pauses: [[RUN + 2, null]] }); const ta = runTimeline(a);
  check('Pause at the stop, never released: the run ends exactly at the Pause', ta.how === 'pause' && ta.sure && ta.end === T0 + (RUN + 2) * 1000 && lactateChecks(a).end === 4.0, `${ta.how} ${mmss(rel(a, ta.end))}`);
  // Pause pressed 50 s after the stop: the heart rate had left its level before
  const b = mk({ hr: base(52), purpose: 'mlss', lactate: [[RUN + 80, 4.0]], pauses: [[RUN + 50, null]] }); const tb = runTimeline(b);
  check('Pause pressed 50 s after the stop: the end is where the heart rate fell, not the Pause', tb.sure && rel(b, tb.end) >= RUN && rel(b, tb.end) <= RUN + 20, `${tb.how} ${mmss(rel(b, tb.end))}`);
  // Pause, then Finish 15 s later, nothing else: too soon for the heart rate, the Pause says it
  const c = mk({ hr: base(53).filter(p => p[0] <= T0 + (RUN + 15) * 1000), extra: { lactateChecks: { end: 4.0 } }, purpose: 'mlss', pauses: [[RUN, null]], endSec: RUN + 15 }); const tc = runTimeline(c);
  check('Pause, Finish 15 s later: the run ended at the Pause', tc.how === 'pause' && tc.sure && tc.end === T0 + RUN * 1000);
  // Pause touched by accident after 1 min and never released; the run goes on, the value is typed at the real stop
  const a1 = sec => sec > RUN + 2 ? 1.2 : 0.45;
  const d = mk({ hr: base(54), purpose: 'mlss', lactate: [[RUN + 70, 4.0]], pauses: [[60, null]], a1 }); const td = runTimeline(d); const ed = endWindowStats(d); const pd = endOnlyProxy(d);
  check('Pause touched at 1:00 and never released: the run is not thrown away', td.how === 'sample' && td.sure && Math.abs(rel(d, td.end) - RUN) <= 20 && td.stops.length === 0, `${td.how} ${mmss(rel(d, td.end))}`);
  check('  running time, heart rate and α1 of the whole run', pd.durMin > 29.9 && pd.durMin < 30.4 && Math.abs(ed.hr - truthHr(d, RUN - 300, RUN)) < 0.8 && Math.abs(ed.alpha1 - 0.45) < 1e-9 && Number.isFinite(pd.driftBpm), `${pd.durMin.toFixed(1)} min, HR ${ed.hr.toFixed(1)}, α1 ${ed.alpha1}`);
  // Pause during the 10-min draw (as the protocol says), released on running again
  const lv = sec => 152 + 8 * Math.max(0, sec - 690) / 1200;
  const mid = simHr({ segs: [{ until: 600, hr: 152 }, { until: 690, hr: 112, fast: 0.4 }, { until: 1890, hr: lv }, { until: 2010, hr: 104, fast: 0.5 }], seed: 55 });
  const e = mk({ hr: mid, purpose: 'mlss', lactate: [[660, 3.3], [1890 + 60, 4.0]], pauses: [[603, 688]] }); const te = runTimeline(e);
  check('Pause during the 10-min draw: one stop, beginning at the Pause', te.stops.length === 1 && te.stops[0][0] === T0 + 603000 && te.how === 'sample' && lactateChecks(e).mid === 3.3 && lactateChecks(e).end === 4.0, te.stops.map(x => mmss(rel(e, x[0])) + '–' + mmss(rel(e, x[1]))).join());
  // the same Pause without any value typed
  const f = mk({ hr: mid, purpose: 'mlss', lactate: [[1890 + 60, 4.0]], pauses: [[603, 688]] }); const tf = runTimeline(f);
  check('…and without a value typed: the Pause alone marks the stop (the heart rate confirms it)', tf.stops.length === 1 && tf.stops[0][0] === T0 + 603000 && endOnlyProxy(f).durMin < 30.5);
  // a Pause the heart rate does not confirm (app paused, running went on)
  const g = mk({ hr: simHr({ segs: [{ until: RUN, hr: 158 }, { until: RUN + 100, hr: 105, fast: 0.5 }], seed: 56 }), purpose: 'mlss', lactate: [[RUN + 60, 4.0]], pauses: [[700, 800]] }); const tgq = runTimeline(g);
  check('a Pause during which the running went on is not a stop', tgq.stops.length === 0 && endOnlyProxy(g).durMin > 29.9, `stops ${tgq.stops.length}, ${endOnlyProxy(g).durMin.toFixed(1)} min`);
  check('pauseIntervals: open pause closes at the end; resume without pause ignored', JSON.stringify(pauseIntervals({ endedAt: 500, events: [{ t: 50, type: 'resume' }, { t: 100, type: 'pause' }, { t: 200, type: 'resume' }, { t: 300, type: 'pause' }, { t: 500, type: 'stop' }] })) === '[[100,200],[300,500]]');
}

// ───────────── 8. The end typed in the card ─────────────
{
  const hr = simHr({ segs: [{ until: 900, hr: 140 }, { until: 1100, hr: 160, tau: 30 }, { until: 2400, hr: 140, tau: 40 }], seed: 33 });
  const s = mk({ hr, speed: 9, lactate: [[600, 1.5], [2395, 1.8]] });
  const auto = runTimeline(s); s.runEndSec = 2400; const man = runTimeline(s);
  check('run end typed in the card replaces the estimate and is certain', auto !== man && man.how === 'manual' && man.sure && man.end === T0 + 2400000 && lactateChecks(s).end === 1.8 && lactateChecks(s).mid === 1.5, `${auto.how}/${auto.sure} → ${man.how}/${man.sure}`);
  s.runEndSec = 1500; const cut = runTimeline(s); const ew = endWindowStats(s);
  check('  an earlier time: the windows end there', cut.end === T0 + 1500000 && Math.abs(ew.hr - truthHr(s, 1200, 1501)) < 1e-9 && Math.abs(endOnlyProxy(s).durMin - 25) < 1e-9 && cut.tailSec === 900);
  check('  a value typed within a minute before it or later is the end sample', (() => { const x = mk({ hr, speed: 9, lactate: [[1470, 2.2]] }); x.runEndSec = 1500; return lactateChecks(x).end === 2.2; })() && (() => { const x = mk({ hr, speed: 9, lactate: [[1300, 2.2]] }); x.runEndSec = 1500; return lactateChecks(x).end === 2.2 /* last 5 min of the run by the clock */; })() && (() => { const x = mk({ hr, speed: 9, lactate: [[700, 2.2]] }); x.runEndSec = 1500; return lactateChecks(x).mid === 2.2; })());
  for (const bad of [0, -5, NaN, -Infinity]) { s.runEndSec = bad; check(`  ${bad} is ignored`, runTimeline(s).how !== 'manual'); }
  s.runEndSec = 99999; check('  a time outside the recording is ignored', runTimeline(s).how !== 'manual'); s.runEndSec = 0; check('  zero is ignored', runTimeline(s).how !== 'manual'); s.runEndSec = '1500'; check('  text is ignored', runTimeline(s).how !== 'manual');
  delete s.runEndSec; check('  removing it returns to the automatic end', runTimeline(s).how === auto.how && runTimeline(s).end === auto.end);
  check('the timeline is computed once per session state', runTimeline(s) === runTimeline(s));
  s.events.push({ t: T0 + 2399000, type: 'rpe', value: 15 }); const again = runTimeline(s); check('  …and again when something was added to the session', again !== auto && again.end === auto.end);
}

// ───────────── 9. Fields of the card ─────────────
{
  const END = 1800; const hr = simHr({ segs: [{ until: 600, hr: 152 }, { until: 680, hr: 112, fast: 0.4 }, { until: END, hr: 156 }, { until: END + 100, hr: 104, fast: 0.5 }], seed: 61 });
  const s = mk({ hr, purpose: 'mlss', lactate: [[30, 1.0], [650, 3.4], [END + 60, 4.1]] });
  check('as recorded', JSON.stringify(lactateChecks(s)) === '{"rest":1,"mid":3.4,"end":4.1,"midMin":10}');
  s.lactateChecks = { end: 4.6 }; check('one field typed: only that one is fixed', JSON.stringify(lactateChecks(s)) === '{"rest":1,"mid":3.4,"end":4.6,"midMin":10}');
  s.lactateChecks = { mid: null }; check('a field emptied stays empty (it used to refill from the recording)', JSON.stringify(lactateChecks(s)) === '{"rest":1,"mid":null,"end":4.1,"midMin":null}');
  s.lactateChecks = { rest: null, mid: null, end: null }; check('all three emptied: no verdict', lactateChecks(s).end === null && lactateVerdict(s) === null);
  s.lactateChecks = { end: 'abc' }; check('rubbish in a field counts as empty', lactateChecks(s).end === null);
  delete s.lactateChecks;
  const twoRest = mk({ hr, purpose: 'mlss', lactate: [[20, 1.0], [140, 1.2], [END + 60, 4.1]] });
  check('a second baseline value (second finger before the run) is not the 10-min sample', JSON.stringify(lactateChecks(twoRest)) === '{"rest":1,"mid":null,"end":4.1,"midMin":null}');
}

// ───────────── 10. LT2 mode: warm-up, rep(s), cool-down ─────────────
{
  const WU = 600, REP = 1800; const hrOne = seed => simHr({ segs: [{ until: WU, hr: 125 }, { until: WU + REP, hr: sec => 156 + 6 * (sec - WU) / REP }, { until: WU + REP + 90, hr: 110, fast: 0.5 }, { until: WU + REP + 420, hr: 120, tau: 40 }], seed });
  const phases = [[0, 'warmup'], [WU, 'work'], [WU + REP, 'cooldown']];
  const one = mk({ hr: hrOne(71), type: 'lt2', phases, lactate: [[400, 1.3], [WU + REP + 60, 4.2]] }); const t1 = runTimeline(one); const c1 = lactateChecks(one);
  check('one 30-min rep: the run is the rep; a value from the warm-up is the baseline', t1.bouts === 1 && t1.start === T0 + WU * 1000 && t1.how === 'sample' && Math.abs(rel(one, t1.end) - (WU + REP)) <= 20 && c1.rest === 1.3 && c1.mid === null && c1.end === 4.2, `${t1.how} ${mmss(rel(one, t1.end))} ${JSON.stringify(c1)}`);
  const p1 = endOnlyProxy(one); check('  running time and drift are those of the rep (the warm-up is not "minutes 8–13")', p1.single && Math.abs(p1.durMin - 30) < 0.4 && p1.driftBpm > 1 && p1.driftBpm < 6, `${p1.durMin.toFixed(1)} min, drift ${p1.driftBpm.toFixed(1)}`);
  check('  verdict: MLSS rules', lactateVerdict(one).kind === 'mlss' && !lactateVerdict(one).intervals);
  // no value typed during the session: the rep clock ends the run
  const clock = mk({ hr: hrOne(72), type: 'lt2', phases, extra: { lactateChecks: { end: 4.2 } } }); const t2 = runTimeline(clock);
  check('no entry: the rep clock is the end (the heart rate agrees)', t2.how === 'phase' && t2.sure && t2.end === T0 + (WU + REP) * 1000);
  // the belt stopped 3 min before the clock, nothing pressed
  const early = mk({ hr: simHr({ segs: [{ until: WU, hr: 125 }, { until: WU + REP - 180, hr: 158 }, { until: WU + REP + 300, hr: 112, fast: 0.5 }], seed: 73 }), type: 'lt2', phases, extra: { lactateChecks: { end: 4.2 } } }); const t3 = runTimeline(early);
  check('belt stopped 3 min before the rep clock, nothing logged: estimate, not relied on', t3.how === 'hr' && !t3.sure && Math.abs(rel(early, t3.end) - (WU + REP - 180)) <= 20, `${t3.how} ${mmss(rel(early, t3.end))}`);
  // …with the value typed at that stop
  const earlyTyped = mk({ hr: early.hrLive, type: 'lt2', phases, lactate: [[WU + REP - 180 + 70, 5.1]] }); const t4 = runTimeline(earlyTyped);
  check('  with the value typed at that stop: certain', t4.how === 'sample' && t4.sure && Math.abs(rel(earlyTyped, t4.end) - (WU + REP - 180)) <= 20 && lactateChecks(earlyTyped).end === 5.1);
  // intervals 4 × 8 min / 3 min easy
  const segs = [{ until: 600, hr: 125 }]; const ph = [[0, 'warmup']]; let t = 600; for (let i = 0; i < 4; i++) { ph.push([t, 'work']); segs.push({ until: t + 480, hr: 160 + i }); t += 480; if (i < 3) { ph.push([t, 'rest']); segs.push({ until: t + 180, hr: 125, tau: 45 }); t += 180; } } ph.push([t, 'cooldown']); segs.push({ until: t + 90, hr: 110, fast: 0.5 }, { until: t + 300, hr: 118 });
  for (const purpose of [undefined, 'lt1', 'mlss']) {
    const iv = mk({ hr: simHr({ segs, seed: 74 }), type: 'lt2', phases: ph, purpose, lactate: [[t + 60, 2.3]] }); const tv = runTimeline(iv); const vd = lactateVerdict(iv);
    check(`4 × 8 min, purpose ${purpose ?? 'auto'}: interval verdict, no zone change, not a point of the curve`, tv.bouts === 4 && vd.intervals === true && vd.level === 'low' && verdictZoneChange({ lt1Hr: 100, lt1Speed: 5, lt2Hr: 100, lt2Speed: 5 }, iv) === null && multiDayCurve([recent(iv)]).points.length === 0 && !endOnlyProxy(iv).single && Number.isNaN(endOnlyProxy(iv).driftBpm), vd.en.slice(0, 60));
    if (purpose === undefined) check('  last-5-min figures are those of the last rep', tv.start === T0 + (t - 480) * 1000 && Math.abs(endWindowStats(iv).hr - truthHr(iv, t - 300, t)) < 1.2, endWindowStats(iv).hr.toFixed(1));
  }
  const up = mk({ hr: simHr({ segs, seed: 74 }), type: 'lt2', phases: ph, lactate: [[600 + 480 + 60, 3.0], [t + 60, 4.6]] }); check('  lactate climbing across the reps (3.0 → 4.6) is said so', lactateVerdict(up).level === 'high' && /rose \+1\.6/.test(lactateVerdict(up).en), lactateVerdict(up).en.slice(0, 70));
  // ended in the warm-up; and a record without a phase log
  const wu = mk({ hr: simHr({ segs: [{ until: 400, hr: 125 }], seed: 75 }), type: 'lt2', phases: [[0, 'warmup']], extra: { lactateChecks: { end: 1.4 } } });
  check('ended in the warm-up: recorded, no verdict on LT2, no zone change', runTimeline(wu).bouts === 0 && lactateVerdict(wu).intervals === true && /warm-up/.test(lactateVerdict(wu).en) && verdictZoneChange({ lt2Speed: 5, lt2Hr: 100 }, wu) === null);
  const bare = mk({ hr: simHr({ segs: [{ until: 1800, hr: 158 }], seed: 76 }), type: 'lt2', phases: [], extra: { lactateChecks: { end: 4.0 } } });
  check('an LT2 record without a phase log is never taken for one steady run', runTimeline(bare).bouts === 2 && lactateVerdict(bare).intervals === true && verdictZoneChange({ lt2Speed: 5, lt2Hr: 100 }, bare) === null);
  // rest of 0 s between reps: still intervals as far as the log goes
  const zero = mk({ hr: simHr({ segs: [{ until: 1200, hr: 158 }], seed: 77 }), type: 'lt2', phases: [[0, 'work'], [600, 'rest'], [600, 'work'], [1200, 'cooldown']], extra: { lactateChecks: { end: 4.0 } } });
  check('rest 0 s between two reps: no error, treated as intervals', runTimeline(zero).bouts === 2 && lactateVerdict(zero).intervals === true && Number.isFinite(endWindowStats(zero).hr));
}

// ───────────── 11. SmO2 ─────────────
{
  const RUN = 1800; const hr = simHr({ segs: [{ until: RUN, hr: 160 }, { until: RUN + 200, hr: 105, fast: 0.5 }], seed: 81 });
  const smo = sec => sec <= RUN ? 66 - 3 * Math.min(1, sec / 300) - 0.5 * Math.max(0, sec - 300) / 60 : Math.min(75, 66 - 3 - 12.5 + (sec - RUN) * 0.25); // falls 0.5 %/min during the run, rebounds 15 %/min after the stop
  const s = mk({ hr, purpose: 'mlss', lactate: [[RUN + 60, 4.4]], smo2: smo }); const ss = smo2Steady(s);
  check('SmO2 still falling at the end of the run is seen as falling, whatever the rebound after the stop', ss.steady === false && ss.slopeEnd < -0.4 && ss.slopeEnd > -0.6, `end slope ${ss.slopeEnd.toFixed(2)} %/min`);
  const wholeRec = { ...s, events: s.events.filter(e => e.type !== 'lactate'), lactateChecks: { end: 4.4 }, runEndSec: RUN + 200 };
  check('  (measured to the end of the recording it would have looked steady)', smo2Steady(wholeRec).steady === true, `slope ${smo2Steady(wholeRec).slopeEnd.toFixed(2)}`);
  check('  the proxy verdict follows', lactateVerdict(s).level === 'high' && /SmO2 still falling/.test(lactateVerdict(s).en));
  const big = { type: 'free', startedAt: T0, endedAt: T0 + 9000000, hrLive: [], events: [], smo2: { offsetMs: 0, series: Array.from({ length: 180000 }, (_, i) => [T0 + i * 50, 60 + (i % 7) * 0.1, 25]) } };
  check('a 10-Hz SmO2 file of a long run (180 000 values) does not overflow', (() => { try { const r = smo2Steady(big); return r && r.min === 60 && Math.abs(r.max - 60.6) < 1e-9; } catch (e) { return false; } })());
}

// ───────────── 12. Multi-day curve ─────────────
{
  const day = 86400000; const now = Date.now();
  const sess = (speed, la, level, daysAgo, typed) => { const hr = simHr({ segs: [{ until: 1800, hr: level }, { until: 1800 + 240, hr: level - 45, fast: 0.5 }], seed: speed * 10 }); const s = typed ? mk({ hr, speed, lactate: [[1860, la]] }) : mk({ hr, speed, extra: { lactateChecks: { end: la } } }); const shift = now - daysAgo * day - T0; s.startedAt += shift; s.endedAt += shift; s.hrLive = s.hrLive.map(p => [p[0] + shift, p[1]]); s.features = []; s.events = s.events.map(e => ({ ...e, t: e.t + shift })); return s; };
  const list = [sess(8, 1.1, 128, 9, true), sess(9, 1.4, 137, 7, true), sess(10, 1.9, 146, 5, false), sess(11, 2.9, 155, 3, true), sess(12, 4.4, 163, 1, true)];
  const md = multiDayCurve(list); const p10 = md.points.find(p => p.x === 10);
  check('a run whose end is uncertain gives its lactate to the curve, not its heart rate', md.points.length === 5 && p10.unsure === true && Number.isNaN(p10.hr) && md.points.filter(p => !p.unsure).every(p => Number.isFinite(p.hr)), md.points.map(p => `${p.x}:${Number.isFinite(p.hr) ? Math.round(p.hr) : '–'}`).join(' '));
  check('  the thresholds still get a heart rate (read off the other runs)', md.analysis && Number.isFinite(md.analysis.lt1Primary.hr) && Number.isFinite(md.analysis.lt2Primary.hr) && md.analysis.lt1Primary.hr > 128 && md.analysis.lt2Primary.hr < 164, `LT1 ${md.analysis.lt1Primary.hr.toFixed(0)} · LT2 ${md.analysis.lt2Primary.hr.toFixed(0)}`);
  check('  heart rates of the certain runs are those of the running (not of the 4-min tail)', md.points.filter(p => !p.unsure).every(p => Math.abs(p.hr - { 8: 128, 9: 137, 11: 155, 12: 163 }[p.x]) < 1.5));
}

// ───────────── 13. Runs finished at the stop behave exactly as they always did ─────────────
{
  // the formulas of v1.1.11, for comparison
  const baseWin = (s, sec = 300) => { const t1 = s.endedAt; return mean(s.hrLive.filter(p => p[0] >= t1 - sec * 1000 && p[1] > 0).map(p => p[1])); };
  const baseDrift = s => { const t0 = s.startedAt, t1 = s.endedAt; const h = s.hrLive.filter(p => p[1] > 0); const e = h.filter(p => p[0] >= t0 + 480000 && p[0] < t0 + 780000).map(p => p[1]), l = h.filter(p => p[0] >= t1 - 300000).map(p => p[1]); return e.length >= 10 && l.length >= 10 ? mean(l) - mean(e) : NaN; };
  const baseChecks = s => { const out = { rest: null, mid: null, end: null }; const dur = (s.endedAt - s.startedAt) / 1000; for (const e of s.events) { if (e.type !== 'lactate' || !Number.isFinite(e.value)) continue; const r = (e.t - s.startedAt) / 1000; if (r <= 240 && out.rest == null) out.rest = e.value; else if (r >= dur - 300 || r >= dur * 0.85) { if (out.end == null) out.end = e.value; } else if (out.mid == null) out.mid = e.value; } return out; };
  const { u } = rng(20261006); const U = (a, b) => a + (b - a) * u(); let n = 0, bad = 0; const badEx = [];
  const shapes = [
    (run, L) => [{ until: run, hr: sec => L + U(-4, 14) * 0 + (sec > 600 ? 9 * (sec - 600) / Math.max(1, run - 600) : 0) }],             // steady with drift
    (run, L) => [{ until: run, hr: sec => L + 6 * sec / run, tau: 150 }],                                                                 // slow start
    (run, L) => { const a = run - Math.round(U(60, 240)); return [{ until: a, hr: L }, { until: run, hr: L + U(10, 25), tau: 30 }]; },   // fast finish
    (run, L) => [{ until: run, hr: sec => L - 10 + 30 * sec / run }],                                                                     // progressive
    (run, L) => { const a = Math.round(U(0.2, 0.8) * run); return [{ until: a, hr: L }, { until: run, hr: L + U(6, 25), tau: 35 }]; },   // pace raised once
  ];
  for (let k = 0; k < 300; k++) {
    const run = Math.round(U(600, 3600)); const L = U(125, 168); const hr = simHr({ segs: shapes[k % shapes.length](run, L), seed: k + 1, noise: U(0.8, 3), wander: U(0, 3) });
    const lac = []; if (u() < 0.3) lac.push([Math.round(U(5, 230)), 1.2]); if (u() < 0.4) lac.push([Math.round(U(540, 700)), 2.6]); if (u() < 0.9) lac.push([run - Math.round(U(0, 20)), 3.3]);
    const s = mk({ hr, lactate: lac, purpose: [undefined, 'mlss', 'lt1'][k % 3], type: k % 4 ? 'free' : 'lt1', speed: 10 }); n++;
    const tl = runTimeline(s); const ew = endWindowStats(s); const px = endOnlyProxy(s); const c = lactateChecks(s); const b = baseChecks(s);
    const same = tl.how === 'finish' && tl.sure && tl.stops.length === 0 && ew.hr === baseWin(s) && (px.driftBpm === baseDrift(s) || (Number.isNaN(px.driftBpm) && Number.isNaN(baseDrift(s)))) && Math.abs(px.durMin - run / 60) < 1e-9 && c.rest === b.rest && c.mid === b.mid && c.end === b.end;
    if (!same) { bad++; if (badEx.length < 3) badEx.push(`#${k} run ${mmss(run)} ${tl.how}/${tl.sure} end ${mmss(rel(s, tl.end))} hr ${ew.hr} vs ${baseWin(s)}`); }
  }
  check(`${n} runs finished while running (steady, drifting, slow start, fast finish, progressive, pace raised): last-5-min heart rate, drift, running time and the three lactate fields as by the formulas of v1.1.11`, bad === 0, bad ? `${bad} differ: ${badEx.join(' | ')}` : '');
}

// ───────────── 14. Many simulated verification runs: is the end found, and how far off? ─────────────
{
  const { u } = rng(77001); const U = (a, b) => a + (b - a) * u(); const I = (a, b) => Math.round(U(a, b));
  let n = 0, found = 0, late = 0, early = 0, hrOff = 0, misfiled = 0, wrongSure = 0; const worst = []; const errs = [];
  for (let k = 0; k < 400; k++) {
    const run = I(900, 3000); const L = U(128, 170); const drift = U(-3, 10); const lvl = sec => L + drift * sec / run;
    const stand = I(40, 150); const standTo = L - U(22, 55); const fast = U(0.3, 0.6); const tauOff = U(45, 110);
    const after = k % 3; const walk = L - U(14, 40); const walkLen = after ? I(60, 600) : 0; // nothing / walk / jog after the sample
    const typed = I(Math.min(35, stand - 5), stand - 2); // the value is typed while still standing
    const segs = [{ until: run, hr: lvl }, { until: run + stand, hr: standTo, tau: tauOff, fast }]; if (walkLen) segs.push({ until: run + stand + walkLen, hr: walk, tau: 40 });
    const hr = simHr({ segs, seed: 1000 + k, noise: U(0.8, 2.6), wander: U(0, 2.5) });
    const two = u() < 0.25 && stand - typed > 25; const lac = [[run + typed, 2.2]]; if (two) lac.push([run + typed + 20, 2.4]);
    const s = mk({ hr, lactate: lac, speed: 9, purpose: 'lt1' }); n++;
    const tl = runTimeline(s); const ew = endWindowStats(s); const truth = truthHr(s, run - 300, run); const err = rel(s, tl.end) - run;
    if (tl.how === 'sample') { found++; errs.push(err); if (err > 45) late++; if (err < -45) early++; }
    if (tl.sure && Math.abs(ew.hr - truth) > 1.5) { hrOff++; if (worst.length < 4) worst.push(`#${k} L ${L.toFixed(0)} stand ${stand}s→${standTo.toFixed(0)} typed +${typed}s: ${tl.how} err ${err.toFixed(0)} s, HR ${ew.hr.toFixed(1)} vs ${truth.toFixed(1)}`); }
    const c = lactateChecks(s); if (c.end !== 2.2 || c.mid !== null) misfiled++;
    if (tl.how !== 'sample' && tl.sure && Math.abs(ew.hr - truth) > 1.5) wrongSure++;
  }
  errs.sort((a, b) => a - b); const q = p => errs[Math.min(errs.length - 1, Math.floor(p * errs.length))];
  check(`${n} verification runs (stand 40–150 s with the value typed, then nothing / walk / jog 14–40 bpm below): the stop is found in ≥ 97 %`, found >= 0.97 * n, `${found}/${n}`);
  check('  its timing: median within 15 s, 95 % within 35 s, none more than 45 s off', Math.abs(q(0.5)) <= 15 && q(0.95) <= 35 && q(0.02) >= -35 && late === 0 && early === 0, `median ${q(0.5)} s, 2 % ${q(0.02)} s, 95 % ${q(0.95)} s, max ${errs[errs.length - 1]} s, min ${errs[0]} s`);
  check('  no run that is called certain has its last-5-min heart rate off by more than 1.5 bpm', hrOff === 0, hrOff ? `${hrOff}: ${worst.join(' | ')}` : '');
  check('  the value is the end sample in every one (two fingers included)', misfiled === 0, String(misfiled));
}

// ───────────── 15. Helpers ─────────────
{
  const tl = { start: 0, end: 1000000, stops: [[200000, 260000], [700000, 760000]] };
  const tl2 = { ...tl, stops: [[200000, 260000, 240000], [700000, 760000, 730000]] };
  check('runWindowStart skips over stops', runWindowStart(tl2, 300) === 1000000 - 300000 - 60000 && runWindowStart(tl2, 100) === 900000 && runWindowStart(tl2, 240) === 760000 && runWindowStart(tl2, 241) === 699000 && runWindowStart(tl2, 5000) === 0, [300, 100, 240, 241, 5000].map(x => runWindowStart(tl2, x)).join());
  check('runWindowEnd skips over stops', runWindowEnd(tl2, 0, 100) === 100000 && runWindowEnd(tl2, 150000, 100) === 310000 && runWindowEnd(tl2, 150000, 50) === 200000 && runWindowEnd(tl2, 230000, 30) === 290000 && runWindowEnd(tl2, 650000, 300) === 1010000, [[0, 100], [150000, 100], [150000, 50], [230000, 30], [650000, 300]].map(x => runWindowEnd(tl2, x[0], x[1])).join());
  check('stoppedMs counts the standing that lies inside', stoppedMs(tl2, 0, 1000000) === 70000 && stoppedMs(tl2, 230000, 720000) === 30000 && stoppedMs(tl2, 300000, 600000) === 0 && stoppedMs(tl2, 0, 710000) === 50000);
}

// ───────────── 16. The copied summary says where the run ended and how that was found ─────────────
{
  const RUN = 2100; const line = s => claudeSummary({ session: s, metrics: sessionMetrics(s) }).split('\n').find(l => l.startsWith('Constant load')) || '';
  const hrA = simHr({ segs: [{ until: RUN, hr: 138 }, { until: RUN + 90, hr: 96, fast: 0.5 }, { until: RUN + 400, hr: 110, tau: 40 }], seed: 5 });
  const a = mk({ hr: hrA, speed: 8.6, lactate: [[RUN + 60, 1.9]] }); const la = line(a); const ea = rel(a, runTimeline(a).end);
  check('summary, value typed at the stop: run end, how it was found, the tail, running time', la.includes(`run ended at ${mmss(ea)} (found by: heart-rate drop before the lactate entry; the recording went on for ${mmss(RUN + 400 - ea)})`) && !la.includes('UNCERTAIN') && la.includes(`running time ${(ea / 60).toFixed(1)} min`), la.slice(0, 220));
  const b = mk({ hr: hrA, speed: 8.6 }); b.lactateChecks = { end: 1.9 }; const lb = line(b);
  check('summary, nothing logged near the end: the estimate is marked UNCERTAIN', /run ended at \d+:\d\d \(found by: heart rate alone; the recording went on for \d+:\d\d\) — UNCERTAIN: the last-5-min figures are estimates/.test(lb), lb.slice(0, 260));
  const c = mk({ hr: simHr({ segs: [{ until: RUN, hr: 138 }], seed: 6 }), speed: 8.6, lactate: [] }); c.lactateChecks = { end: 1.7 }; const lc = line(c);
  check('summary, Finish pressed while running: end of the recording, no tail', lc.includes(`run ended at ${mmss(RUN)} (found by: end of the recording)`) && !lc.includes('UNCERTAIN') && !lc.includes('went on'), lc.slice(0, 200));
  const d = mk({ hr: hrA, speed: 8.6, lactate: [[RUN + 60, 1.9]], extra: { runEndSec: 2000 } }); const ld = line(d);
  check('summary, end typed in the card: entered by hand', ld.includes('run ended at 33:20 (found by: entered by hand; the recording went on for 8:20)') && ld.includes('running time 33.3 min'), ld.slice(0, 200));
  // LT2 mode, 3 × 8 min with 3-min recoveries: not one run — the line must not present the last rep as the session's running time
  const segs = [{ until: 600, hr: 125 }]; const phases = [[0, 'warmup']]; let t = 600;
  for (let i = 0; i < 3; i++) { phases.push([t, 'work']); segs.push({ until: t + 480, hr: 160 }); t += 480; if (i < 2) { phases.push([t, 'rest']); segs.push({ until: t + 180, hr: 125, tau: 40 }); t += 180; } }
  phases.push([t, 'cooldown']); segs.push({ until: t + 240, hr: 118, tau: 45 });
  const e = mk({ hr: simHr({ segs, seed: 8 }), type: 'lt2', phases, lactate: [[t + 60, 3.8]] }); const le = line(e);
  check('summary, interval session: named as such, with the last rep', /interval session — last rep \d+\.\d min/.test(le) && !le.includes('running time'), le.slice(0, 200));
}

// ───────────── 17. Odd records: nothing throws, nothing takes long ─────────────
{
  // (a) clock times that lie far from the samples: the stop search must stay inside the heart-rate data
  const hr = simHr({ segs: [{ until: 1800, hr: 150 }, { until: 2000, hr: 100, fast: 0.5 }], seed: 3 });
  const odd = [
    ['recording "ended" a week after the last sample', mk({ hr, lactate: [], endSec: 7 * 86400 })],
    ['start time 0 (1970)', { ...mk({ hr, lactate: [[1860, 3.1]] }), startedAt: 0 }],
    ['no heart rate at all, clock times 56 years apart', { ...mk({ hr: [], lactate: [] }), startedAt: 0, endedAt: T0, events: [{ t: T0 - 5000, type: 'lactate', value: 2 }] }],
    ['a value typed a day after the last sample', mk({ hr, lactate: [[86400, 2.2]], endSec: 86400 + 60 })],
  ];
  for (const [name, s] of odd) { const t1 = performance.now(); let ok = true, tl = null; try { tl = runTimeline(s); endWindowStats(s); endOnlyProxy(s); lactateVerdict(s); sessionMetrics(s); smo2Steady(s); } catch (e) { ok = false; } const ms = performance.now() - t1; check(`odd record — ${name}: no error, quick`, ok && ms < 300 && tl && Number.isFinite(tl.end), `${ms.toFixed(0)} ms, end by ${tl && tl.how}`); }
  // (b) fields of the wrong kind, missing fields, times out of order: every figure the screens ask for comes back (possibly empty), none throws
  const { u } = rng(4242); const pick = a => a[Math.floor(u() * a.length)]; let threw = 0, n = 0, slowest = 0, first = '';
  for (let k = 0; k < 600; k++) {
    const len = pick([0, 1, 2, 30, 119, 121, 600, 2400]); const h = []; let level = 100 + u() * 60, t = T0 + pick([0, 5000, -3000]);
    for (let i = 0; i < len; i++) { const q = u(); if (q < 0.003) level -= 40; else if (q < 0.006) level += 30; level = Math.max(45, Math.min(205, level)); h.push([q > 0.997 ? t - 20000 : q > 0.996 ? NaN : t, q < 0.01 ? pick([0, NaN, -5, 999, null, '150']) : Math.round(level + (u() - 0.5) * 6)]); t += pick([1000, 1000, 1000, 1000, 2000, 500, 0, 61000]); }
    const evT = () => pick([T0, T0 + u() * (t - T0 + 1), t, t + 60000, T0 - 60000, NaN, undefined, null, 'x']); const ev = [];
    for (let i = pick([0, 1, 2, 3, 6]); i > 0; i--) { const ty = pick(['lactate', 'lactate', 'pause', 'resume', 'phase', 'rpe', 'stop', undefined]); ev.push({ t: evT(), type: ty, value: pick([1.2, 3.4, null, NaN, undefined, '2.1', -1]), phase: pick(['work', 'rest', 'warmup', undefined, 7]) }); }
    const s = { id: pick(['m' + k, undefined, null]), type: pick(['free', 'lt1', 'lt2', 'test', undefined]), startedAt: pick([T0, T0, T0, NaN, undefined, null, 0]), endedAt: pick([t, t, null, undefined, T0 - 1000, t + 3600000, NaN, 0, t + 7 * 86400000]), final: u() < 0.9, sourceKind: 'ble',
      speed: pick([10, null, undefined, NaN, '9']), hrLive: pick([h, h, h, undefined, null]), features: pick([undefined, null, [{ t: T0 + 5000, alpha1: 0.6 }, { t: NaN, alpha1: NaN }]]), stages: pick([[], undefined]), events: pick([ev, ev, ev, undefined, null]), tiz: pick([undefined, null, { inSec: '5', totalSec: '10' }]), pauseMs: pick([0, undefined, NaN, 'x']),
      alpha1Settings: pick([{ windowSec: 120 }, undefined, null, { windowSec: '90' }]), purpose: pick([undefined, null, 'lt1', 'mlss', 'x']), runEndSec: pick([undefined, undefined, 600, 0, -5, NaN, 1e12, '700', null]), lactateChecks: pick([undefined, undefined, { end: 2.1 }, { rest: 1, mid: 3, end: 4 }, { end: null }, { end: '3' }, null]) };
    n++; const t1 = performance.now();
    try { if (s.type !== 'test') runTimeline(s); sessionMetrics(s); lactateChecks(s); lactateVerdict(s); endWindowStats(s); endOnlyProxy(s); verdictZoneChange(ZONES, s); smo2Steady(s); multiDayCurve([s, { ...s, id: 'q' + k, speed: 9 }]); claudeSummary({ session: s, metrics: sessionMetrics(s) }); }
    catch (e) { threw++; if (!first) first = `#${k}: ${e.message}`; }
    slowest = Math.max(slowest, performance.now() - t1);
  }
  // (c) should the timeline code itself fail on a record, the screens still get an answer: the recording as it is, nothing concluded from it
  { const hr2 = simHr({ segs: [{ until: 1800, hr: 150 }, { until: 2000, hr: 100, fast: 0.5 }], seed: 3 });
    const bad = { ...mk({ hr: hr2, purpose: 'mlss' }), lactateChecks: { end: 4.0 } }; bad.events.splice(1, 0, { type: 'pause', get t() { throw new Error('boom'); } }); // (only the timeline reads the time of a Pause)
    const err = console.error; let logged = 0; console.error = () => { logged++; }; let tl = null, vd = null, z = null, ok = true;
    try { tl = runTimeline(bad); vd = lactateVerdict(bad); z = verdictZoneChange({ ...ZONES, lt2Hr: 120 }, bad, vd); sessionMetrics(bad); endOnlyProxy(bad); } catch (e) { ok = false; } finally { console.error = err; }
    check('a record the timeline code fails on: no error reaches the screens — end of the recording, marked uncertain, no proxy call, no heart rate into the zones', ok && logged >= 1 && tl && tl.how === 'finish' && tl.sure === false && tl.why === 'error' && tl.end === bad.endedAt && vd && vd.unsure === true && (!z || z.zones.lt2Hr === 120), tl ? `${tl.how} ${tl.why}` : 'threw');
    const byHand = { ...bad, runEndSec: 1800 }; console.error = () => {}; let t2 = null; try { t2 = runTimeline(byHand); } finally { console.error = err; }
    check('  … and an end typed by hand is still taken', t2 && t2.how === 'manual' && t2.sure === true && rel(byHand, t2.end) === 1800 && Math.abs(t2.tailSec - 200) < 1.5, t2 ? `${t2.how} ${rel(byHand, t2.end)}` : ''); }
  check(`${n} records with fields of the wrong kind, missing fields, times out of order: nothing throws`, threw === 0, threw ? `${threw} threw — ${first}` : `slowest ${slowest.toFixed(0)} ms`);
  check('  and none takes long', slowest < 500, `${slowest.toFixed(0)} ms`);
}

// ───────────── 18. One scenario for each rule ─────────────
{
  // — interval sessions —
  const segs = [{ until: 600, hr: 125 }]; const ph = [[0, 'warmup']]; let t = 600; for (let i = 0; i < 3; i++) { ph.push([t, 'work']); segs.push({ until: t + 480, hr: 160 + i }); t += 480; if (i < 2) { ph.push([t, 'rest']); segs.push({ until: t + 180, hr: 125, tau: 45 }); t += 180; } } ph.push([t, 'cooldown']); segs.push({ until: t + 200, hr: 112, fast: 0.5 });
  const ivHr = simHr({ segs, seed: 81 }); const iv = (lac, more = {}) => mk({ hr: ivHr, type: 'lt2', phases: ph, lactate: lac, ...more }); const lv = lac => lactateVerdict(iv(lac)).level;
  check('interval verdict by the value after the last rep: < 3 low · 3–4.5 on target · up to 6 a little high · 6 and more high', lv([[t + 50, 2.9]]) === 'low' && lv([[t + 50, 3.0]]) === 'ok' && lv([[t + 50, 4.5]]) === 'ok' && lv([[t + 50, 4.6]]) === 'near' && lv([[t + 50, 5.9]]) === 'near' && lv([[t + 50, 6.0]]) === 'high', [2.9, 3.0, 4.5, 4.6, 5.9, 6.0].map(v => lv([[t + 50, v]])).join(' '));
  check('  …and by the rise across the reps: +1.0 is fine, more is not', lv([[600 + 480 + 50, 3.0], [t + 50, 4.0]]) === 'ok' && lv([[600 + 480 + 50, 3.0], [t + 50, 4.5]]) === 'high');
  { const smo = sec => 60 - 0.2 * sec / 60; const ss = smo2Steady(iv([[t + 50, 3.8]], { smo2: smo }));
    check('  SmO2 of an interval session is read over the whole session (not over the last rep as if it were a run)', ss && ss.coverageSec > 2000, ss ? `${Math.round(ss.coverageSec)} s` : 'none'); }
  { const s2 = [{ until: 600, hr: 125 }, { until: 1500, hr: 158 }, { until: 1740, hr: 122, tau: 45 }, { until: 2640, hr: sec => 158 + 8 * (sec - 1740) / 900 }, { until: 2840, hr: 110, fast: 0.5 }];
    const two = mk({ hr: simHr({ segs: s2, seed: 82 }), type: 'lt2', phases: [[0, 'warmup'], [600, 'work'], [1500, 'rest'], [1740, 'work'], [2640, 'cooldown']], lactate: [[2700, 4.0]] });
    check('2 × 15 min: no drift figure across reps, however long the last one is', Number.isNaN(endOnlyProxy(two).driftBpm) && endOnlyProxy(two).single === false && lactateVerdict(two).intervals === true); }
  { const WU = 600, REP = 1800; const one = mk({ hr: simHr({ segs: [{ until: WU, hr: 125 }, { until: WU + REP, hr: 158 }, { until: WU + REP + 300, hr: 108, fast: 0.5 }], seed: 83 }), type: 'lt2', phases: [[0, 'warmup'], [WU, 'work'], [WU + REP, 'cooldown']], lactate: [[WU + REP + 60, 4.0]] });
    check('LT2 session: the session numbers are not cut at the end of the run (they are those of the work phases, as before)', Math.abs(sessionMetrics(one).meanHr - truthHr(one, 0, WU + REP + 301)) < 1e-9); }

  // — windows —
  { const lvl = sec => 150 + 8 * Math.max(0, sec - 800) / 1200; const hr = simHr({ segs: [{ until: 490, hr: 150 }, { until: 740, hr: 105, fast: 0.4 }, { until: 2000, hr: lvl }, { until: 2100, hr: 104, fast: 0.5 }], seed: 84 });
    const s = mk({ hr, purpose: 'mlss', lactate: [[560, 3.2], [2060, 4.0]] }); const px = endOnlyProxy(s); const tl = runTimeline(s); const truth = truthHr(s, 1700, 2000) - truthHr(s, 830, 1130);
    check('a 4-min stop in minutes 8–12: the early drift window is the 5 min of running after it', tl.stops.length === 1 && Number.isFinite(px.driftBpm) && Math.abs(px.driftBpm - truth) < 1.5, `drift ${px.driftBpm.toFixed(1)}, by hand ${truth.toFixed(1)}`); }
  { const END = 1875; const level = sec => 150 + 6 * Math.min(1, sec / 600) + 8 * Math.max(0, sec - 675) / 1200;
    const hr = simHr({ segs: [{ until: 600, hr: level }, { until: 675, hr: 112, fast: 0.4 }, { until: END, hr: level }, { until: END + 120, hr: 104, fast: 0.5 }], seed: 85 });
    const smo = sec => (sec >= 612 && sec < 690) || sec >= END + 2 ? 74 : 62 - 0.4 * Math.max(0, sec - 675) / 60; // 74 % within seconds of standing still, falling 0.4 %/min while running
    const s = mk({ hr, purpose: 'mlss', lactate: [[650, 3.4], [END + 70, 4.1]], smo2: smo }); const ss = smo2Steady(s);
    check('SmO2 with a 10-min stop: the rebound at the stop and at the end is in none of the figures', ss.max <= 62.01 && Math.abs(ss.slopeEnd + 0.4) < 0.01 && ss.steady === false, `max ${ss.max.toFixed(1)}, end slope ${ss.slopeEnd.toFixed(3)}`); }
  { const RUN = 1800; const hr = simHr({ segs: [{ until: RUN, hr: 158 }, { until: RUN + 150, hr: 105, fast: 0.5 }], seed: 86 }); const L = [[RUN + 60, 4.0]];
    const bySample = runTimeline(mk({ hr, lactate: L })), byHand = runTimeline(mk({ hr, lactate: L, extra: { runEndSec: RUN } })), byPause = runTimeline(mk({ hr, lactate: L, pauses: [[RUN, null]] })), byHr = runTimeline(mk({ hr, extra: { lactateChecks: { end: 4 } } })), byFinish = runTimeline(mk({ hr: hr.filter(p => p[0] <= T0 + RUN * 1000), extra: { lactateChecks: { end: 4 } } }));
    check('how late an end may be: 15 s when the heart rate timed it, nothing when it was pressed, typed, or the recording simply ended', bySample.lagMs === 15000 && byHr.lagMs === 15000 && byHr.how === 'hr' && byHand.lagMs === 0 && byPause.lagMs === 0 && byPause.how === 'pause' && byFinish.lagMs === 0 && byFinish.how === 'finish', [bySample, byHr, byHand, byPause, byFinish].map(x => `${x.how}:${x.lagMs}`).join(' '));
    const a1 = sec => sec > RUN ? 1.2 : sec > RUN - 60 ? 0.30 : 0.45; // a marker: lower in the last minute of running
    const sA = mk({ hr, lactate: L, a1 }); const tA = runTimeline(sA); const stA = sA.features.filter(f => f.t >= tA.end - 300000 && f.t <= tA.end - 15000).map(f => f.alpha1);
    check('  α1 of the last 5 min stops 15 s short of a heart-rate-timed end and takes everything before that', Math.abs(endWindowStats(sA).alpha1 - mean(stA)) < 1e-9 && stA.length >= 56 && stA.every(v => v <= 0.45) && stA.some(v => v === 0.30), `${endWindowStats(sA).alpha1.toFixed(4)} from ${stA.length} values`);
    const sB = mk({ hr, lactate: L, a1, extra: { runEndSec: RUN } }); const stB = sB.features.filter(f => f.t >= T0 + (RUN - 300) * 1000 && f.t <= T0 + RUN * 1000).map(f => f.alpha1);
    check('  …and runs right up to an end that was typed', Math.abs(endWindowStats(sB).alpha1 - mean(stB)) < 1e-9 && stB.length === 61); }
  { const RUN = 1800; const hr = simHr({ segs: [{ until: RUN, hr: 150 }, { until: RUN + 120, hr: 100, fast: 0.5 }], seed: 87 });
    const a = runTimeline(mk({ hr, lactate: [[RUN + 60, 2.0]] })), b = runTimeline(mk({ hr: [...hr.slice(900), ...hr.slice(0, 900)], lactate: [[RUN + 60, 2.0]], endSec: RUN + 120 }));
    check('heart-rate samples stored out of order give the same answer', a.how === 'sample' && b.how === 'sample' && a.end === b.end && b.sure, `${mmss((a.end - T0) / 1000)} / ${b.how} ${mmss((b.end - T0) / 1000)}`); }
  { const RUN = 1800; const hr = simHr({ segs: [{ until: RUN, hr: 150 }, { until: RUN + 120, hr: 100, fast: 0.5 }], seed: 87 });
    const strapOff = mk({ hr: hr.filter(p => p[0] <= T0 + RUN * 1000), extra: { lactateChecks: { end: 2.0 } }, endSec: RUN + 285, speed: 9 }); const ew = endWindowStats(strapOff);
    check('strap taken off at the stop, Finish nearly 5 min later: 15 s of heart rate are not "the last 5 min" — no figure, no heart rate for the zones', runTimeline(strapOff).how === 'finish' && Number.isNaN(ew.hr) && Number.isNaN(endOnlyProxy(strapOff).driftBpm) && (() => { const z = verdictZoneChange({ lt1Hr: 100, lt1Speed: 5 }, strapOff); return z && z.zones.lt1Hr === 100 && z.zones.lt1Speed === 9; })()); }

  // — which value is which —
  { const RUN = 1800; const hr = simHr({ segs: [{ until: RUN, hr: 158 }, { until: RUN + 150, hr: 105, fast: 0.5 }], seed: 86 });
    const s = mk({ hr, purpose: 'mlss', lactate: [[RUN + 40, 4.0]], extra: { runEndSec: RUN + 60 } }); const c = lactateChecks(s);
    check('end typed by hand 20 s after the value was saved: the value is still the end sample (a minute of tolerance)', c.end === 4.0 && c.mid === null, JSON.stringify(c)); }
  { const hr = simHr({ segs: [{ until: 900, hr: 158 }, { until: 2100, hr: 140, tau: 40 }], seed: 34 }); // pace lowered for good at 15:00; Finish at 35:00 while running; nothing typed anywhere near either
    const s = mk({ hr, speed: 9, lactate: [[600, 2.0], [1700, 2.6]] }); const tl = runTimeline(s); const c = lactateChecks(s);
    check('an end that is only estimated files nothing: the values stay where the clock of the recording puts them', tl.how === 'hr' && !tl.sure && Math.abs(rel(s, tl.end) - 900) <= 30 && c.mid === 2.0 && c.end === null, `${tl.how} ${mmss(rel(s, tl.end))} ${JSON.stringify(c)}`); }
  { const hr = simHr({ segs: [{ until: 1800, hr: 160 }, { until: 1890, hr: 112, fast: 0.5 }, { until: 2400, hr: 128, tau: 40 }], seed: 5 });
    const two = mk({ hr, speed: 10.8, purpose: 'mlss', lactate: [[1860, 4.4], [2290, 3.1]] }); const c = lactateChecks(two); const vd = lactateVerdict(two);
    check('a value at the stop and a recovery value 8 min later: the first is the end sample — no "rise −1.3" verdict out of the pair', runTimeline(two).why === 'late-entry' && c.end === 4.4 && c.mid === null && vd.unsure === true && !/rise/.test(vd.en), `${JSON.stringify(c)} ${vd.en.slice(0, 50)}`);
    const late = mk({ hr, speed: 10.8, purpose: 'mlss', lactate: [[2270, 4.4]] }); const cl = lactateChecks(late);
    check('one value, typed 8 min after the stop while walking, 2 min before Finish: the end sample (not a "10-min" value by the clock)', runTimeline(late).why === 'late-entry' && cl.end === 4.4 && cl.mid === null, JSON.stringify(cl)); }

  // — did the last stop end the run? —
  { const hr = simHr({ segs: [{ until: 1800, hr: 158 }, { until: 1880, hr: 112, fast: 0.5 }, { until: 2060, hr: 157 }], seed: 88 }); // sample at 30:00, then 3 more minutes at speed, Finish while running
    const s = mk({ hr, purpose: 'mlss', lactate: [[1860, 4.2]] }); const tl = runTimeline(s);
    check('3 more minutes at speed after the end sample, Finish while running: the sample still ended the run', tl.how === 'sample' && tl.sure && Math.abs(rel(s, tl.end) - 1800) <= 20 && lactateChecks(s).end === 4.2, `${tl.how} ${mmss(rel(s, tl.end))}`); }
  { const hr = simHr({ segs: [{ until: 600, hr: 156 }, { until: 675, hr: 112, fast: 0.4 }, { until: 1800, hr: 158 }], seed: 89 }); // 10-min sample, nothing typed after it, Finish while running at 30:00
    const s = mk({ hr, purpose: 'mlss', lactate: [[650, 3.4]] }); const tl = runTimeline(s); const c = lactateChecks(s);
    check('10-min sample, 19 more minutes, Finish while running: the stop lies inside the run and the value is the 10-min one', tl.how === 'finish' && tl.sure && tl.stops.length === 1 && c.mid === 3.4 && c.end === null && Math.abs(endOnlyProxy(s).durMin - (30 - (tl.stops[0][2] - tl.stops[0][0]) / 60000)) < 1e-9, `${tl.how} ${JSON.stringify(c)}`); }
  { const hr = simHr({ segs: [{ until: 600, hr: 156 }, { until: 675, hr: 112, fast: 0.4 }, { until: 745, hr: 156 }], seed: 90 }); // 10-min sample; a second value saved 50 s after running again; Finish 20 s later, still running
    const s = mk({ hr, purpose: 'mlss', lactate: [[650, 3.4], [725, 3.9]] }); const tl = runTimeline(s); const c = lactateChecks(s);
    check('a value saved while running again (heart rate on its way back up), Finish at once: the earlier stop is not taken for a certain end, the values keep their places', !(tl.sure && tl.how === 'sample') && c.mid === 3.4 && c.end === 3.9, `${tl.how}${tl.sure ? '' : ' (not relied on)'} ${JSON.stringify(c)}`); }
  { const hr = simHr({ segs: [{ until: 600, hr: 156 }, { until: 675, hr: 112, fast: 0.4 }, { until: 1050, hr: 144 }, { until: 1350, hr: 156 }], seed: 95 }); // after the sample 6 min easier, then back at speed; a value saved at 22:25 while running; Finish 5 s later
    const s = mk({ hr, purpose: 'mlss', lactate: [[650, 3.4], [1345, 3.9]] }); const tl = runTimeline(s); const c = lactateChecks(s);
    check('back at speed only minutes before Finish, a value saved while running: that value is the end sample, the old stop is not the end', tl.how === 'finish' && c.mid === 3.4 && c.end === 3.9, `${tl.how} ${mmss(rel(s, tl.end))} ${JSON.stringify(c)}`); }
  { const lvl = 158; const hr = simHr({ segs: [{ until: 600, hr: lvl }, { until: 670, hr: 113, fast: 0.5 }, { until: 725, hr: lvl + 3 }, { until: 800, hr: 110, fast: 0.5 }], seed: 96 }); // given up 55 s after the 10-min sample
    const s = mk({ hr, purpose: 'mlss', lactate: [[650, 4.1], [780, 7.2]] }); const tl = runTimeline(s); const c = lactateChecks(s);
    check('given up 55 s after the 10-min sample (the heart rate had come up 15+ bpm): two stops, 4.1 the 10-min value, 7.2 the end value', c.mid === 4.1 && c.end === 7.2 && Math.abs(rel(s, tl.end) - 725) <= 20 && tl.stops.length === 1, `${JSON.stringify(c)} end ${mmss(rel(s, tl.end))} stops ${tl.stops.length}`); }
  { const END = 1875; const level = sec => 150 + 6 * Math.min(1, sec / 600) + 8 * Math.max(0, sec - 675) / 1200; const hr = simHr({ segs: [{ until: 600, hr: level }, { until: 675, hr: 112, fast: 0.4 }, { until: END, hr: level }, { until: END + 120, hr: 104, fast: 0.5 }], seed: 5 });
    const s = mk({ hr, purpose: 'mlss', lactate: [[675 + 240, 3.4], [END + 70, 4.1]] }); const tl = runTimeline(s);
    check('10-min value saved 4 min after running again: it still marks that stop', tl.stops.length === 1 && Math.abs(rel(s, tl.stops[0][0]) - 600) <= 20 && lactateChecks(s).mid === 3.4, `stops ${tl.stops.length}`); }
  { const hr = simHr({ segs: [{ until: 600, hr: 156 }, { until: 670, hr: 143, tau: 30 }, { until: 1110, hr: 157 }], seed: 94 }); // the 10-min sample taken at a walk (13 bpm down for a minute); a second value saved at 18:00 while running; Finish at 18:30, running
    const s = mk({ hr, purpose: 'mlss', lactate: [[645, 3.4], [1080, 3.9]] }); const tl = runTimeline(s); const c = lactateChecks(s);
    check('a value saved while running, 6 min after a shallow stop was over, is not a second finger of that stop', tl.how === 'finish' && tl.stops.length === 1 && c.mid === 3.4 && c.end === 3.9, `${tl.how} stops ${tl.stops.length} ${JSON.stringify(c)}`); }

  // — Pause —
  { const RUN = 1800; const hr = simHr({ segs: [{ until: RUN, hr: 158 }, { until: RUN + 200, hr: 110, tau: 70 }], seed: 91 }); // no fast phase: the heart rate lingers at its level
    const s = mk({ hr, purpose: 'mlss', lactate: [[RUN + 80, 4.0]], pauses: [[RUN, null]] }); const tl = runTimeline(s); const alone = runTimeline(mk({ hr, purpose: 'mlss', lactate: [[RUN + 80, 4.0]] }));
    check('Pause pressed at the stop: its time is the end, to the second (by the heart rate alone it would be later)', tl.how === 'pause' && tl.end === T0 + RUN * 1000 && tl.lagMs === 0 && alone.end > tl.end && alone.how === 'sample', `Pause ${mmss(rel(s, tl.end))}, heart rate alone ${mmss((alone.end - T0) / 1000)}`); }
  { const hr = simHr({ segs: [{ until: 600, hr: 156 }, { until: 675, hr: 112, fast: 0.4 }, { until: 1800, hr: 158 }, { until: 1900, hr: 104, fast: 0.5 }], seed: 92 }); // a stop at 10:00 that nothing logged; Pause touched at 15:00 for 20 s while running
    const s = mk({ hr, purpose: 'mlss', lactate: [[1860, 4.0]], pauses: [[900, 920]] }); const tl = runTimeline(s);
    check('a Pause touched while running, minutes after a stop that nothing logged, does not lay claim to that stop', tl.stops.length === 0 && tl.how === 'sample' && tl.sure, `stops ${tl.stops.length}`); }
  { const RUN = 1800; const hr = simHr({ segs: [{ until: RUN, hr: 158 }, { until: RUN + 12, hr: 110, tau: 70 }], seed: 93 });
    const s = mk({ hr, purpose: 'mlss', pauses: [[RUN, null]], extra: { lactateChecks: { end: 4.0 } } }); const tl = runTimeline(s);
    check('Pause, Finish 12 s later, the heart rate has hardly moved yet: the Pause is the end', tl.how === 'pause' && tl.sure && tl.end === T0 + RUN * 1000 && Math.abs(tl.tailSec - 12) < 1e-9, `${tl.how} ${mmss(rel(s, tl.end))}`); }
  { const lvl = 158; const hr = simHr({ segs: [{ until: 600, hr: lvl }, { until: 688, hr: 113, fast: 0.5 }, { until: 790, hr: lvl + 2 }, { until: 900, hr: 108, fast: 0.5 }], seed: 97 }); // Pause for the 10-min draw (nothing typed), running again for 100 s, then given up; the value typed after that
    const s = mk({ hr, purpose: 'mlss', lactate: [[850, 7.2]], pauses: [[603, 688]] }); const tl = runTimeline(s);
    check('Pause for the 10-min draw, given up 100 s later: the value belongs to the second stop, the Pause marks the first', lactateChecks(s).end === 7.2 && Math.abs(rel(s, tl.end) - 790) <= 20 && tl.stops.length === 1 && tl.stops[0][0] === T0 + 603000, `end ${mmss(rel(s, tl.end))} stops ${tl.stops.map(x => mmss(rel(s, x[0]))).join()}`); }

  // — levels, surges, staircases —
  { const run = sec => 148 + 16 * sec / 2100; const hr = simHr({ segs: [{ until: 2100, hr: run }, { until: 2400, hr: sec => 164 - 10 * (sec - 2100) / 300, tau: 15 }, { until: 2640, hr: 154, tau: 30 }, { until: 2740, hr: 104, fast: 0.5 }], seed: 98 });
    const s = mk({ hr, purpose: 'mlss', lactate: [[2700, 4.0]] }); const tl = runTimeline(s); // a drifting run, eased by degrees over 5 min (2 bpm a minute: no step anywhere) to a jog 10 below, 4 min of that, then the stop
    check('eased by degrees to a jog before the sample (drifting run, so the jog is not far below the run as a whole): flagged, not relied on', tl.how === 'sample' && !tl.sure && tl.why === 'level' && verdictZoneChange({ lt2Hr: 100, lt2Speed: 5 }, s, { kind: 'mlss', level: 'ok' }).zones.lt2Hr === 100, `${tl.how} ${tl.sure ? 'sure' : tl.why} end ${mmss(rel(s, tl.end))}`); }
  { const hr = simHr({ segs: [{ until: 1500, hr: 150 }, { until: 1680, hr: 165, tau: 30 }, { until: 2040, hr: 150, tau: 40 }, { until: 2140, hr: 104, fast: 0.5 }], seed: 99 }); // a 3-min surge, then 6 min at the old level, then the stop
    const s = mk({ hr, purpose: 'mlss', lactate: [[2100, 4.0]] }); const tl = runTimeline(s);
    check('a surge that ended 6 min before the stop, the running going on at the old level: certain, and the end is the stop', tl.how === 'sample' && tl.sure && Math.abs(rel(s, tl.end) - 2040) <= 20, `${tl.sure ? 'sure' : tl.why} end ${mmss(rel(s, tl.end))}`); }
  { const hr = simHr({ segs: [{ until: 1800, hr: 150 }, { until: 2160, hr: sec => 150 + 12 * (sec - 1800) / 360, tau: 10 }, { until: 2460, hr: 148, tau: 40 }], seed: 100 }); // the last 6 min faster and faster (+12 bpm, no step), then a walk; nothing logged
    const s = mk({ hr, speed: 9, extra: { lactateChecks: { end: 2.4 } } }); const tl = runTimeline(s);
    check('a progressive finish, then a walk 14 below it, nothing logged: an estimate at the stop (a gradual rise is no surge) — not "the recording ended while running"', tl.how === 'hr' && !tl.sure && Math.abs(rel(s, tl.end) - 2160) <= 25, `${tl.how} ${mmss(rel(s, tl.end))}`); }
  { const hr = simHr({ segs: [{ until: 1200, hr: 150 }, { until: 1290, hr: 136, tau: 25 }, { until: 1900, hr: 143, tau: 30 }], seed: 102 }); // eased 14 bpm for 90 s, then on at 7 below the old level until Finish; nothing logged
    const s = mk({ hr, speed: 9, extra: { lactateChecks: { end: 2.4 } } }); const tl = runTimeline(s);
    check('nothing logged, a dip of 90 s and then on at 7 bpm below the old level: the heart rate did not stay down — no end is made of the dip', tl.how === 'finish' && tl.sure && tl.end === s.endedAt, `${tl.how} ${mmss(rel(s, tl.end))}`); }
  { const hr = simHr({ segs: [{ until: 1800, hr: 160 }, { until: 2040, hr: 142, tau: 40 }, { until: 2140, hr: 100, tau: 55, fast: 0.4 }], seed: 103 }); // a value saved a minute into a 4-min jog 18 below, a second one after standing still
    const s = mk({ hr, purpose: 'mlss', lactate: [[1860, 4.4], [2090, 4.6]] }); const tl = runTimeline(s);
    check('a first value a minute after the first step down, a second after the second step 4 min later: two steps, minutes apart — flagged, the first value is the end sample', tl.how === 'sample' && !tl.sure && tl.why === 'two-steps' && Math.abs(rel(s, tl.end) - 1800) <= 30 && lactateChecks(s).end === 4.4, `${tl.sure ? 'sure' : tl.why} end ${mmss(rel(s, tl.end))}`); }
  { const hr = simHr({ segs: [{ until: 1800, hr: 150 }, { until: 1860, hr: 110, fast: 0.5 }, { until: 2400, hr: 134, tau: 40 }, { until: 2700, hr: 150 }], seed: 101 }); // 30 min, a stop, a 9-min walk, 5 more minutes at speed until Finish; nothing logged
    const s = mk({ hr, speed: 9, extra: { lactateChecks: { end: 2.4 } } }); const tl = runTimeline(s);
    check('nothing logged and the recording ends at the running level after a break: the end of the recording, as before', tl.how === 'finish' && tl.sure && tl.end === s.endedAt, `${tl.how} ${mmss(rel(s, tl.end))}`); }
}

// ───────────── 19. Many kinds of runs, each with what really happened attached ─────────────
{
  // α1 as the engine would stamp it: 0.45 for a 2-min window of pure running, more the larger the share of it that was not running
  const a1From = idle => sec => { let n = 0; for (const [a, b] of idle) n += Math.max(0, Math.min(sec, b) - Math.max(sec - 120, a)); return 0.45 + 0.75 * Math.min(1, n / 120); };
  // SmO2: falls 0.4 %/min while running, rebounds toward 75 % within a minute of standing still
  const smoFrom = idle => { const cache = []; let v = 68; return sec => { while (cache.length <= sec) { const s = cache.length; const st = idle.some(([a, b]) => s >= a && s < b); v += st ? (75 - v) / 25 : (-0.4 / 60) + (v > 68 ? (68 - v) / 60 : 0); cache.push(v); } return cache[Math.floor(sec)]; }; };
  /** Scenario k: a session and the truth about it (end = second at which the run a sample belongs to ended; ambiguous = the picture has two readings). */
  function scenario(k) {
    const { u } = rng(k * 2654435761 + 17); const U = (a, b) => a + u() * (b - a), I = (a, b) => Math.floor(U(a, b + 1)), pick = a => a[Math.floor(u() * a.length)];
    const fam = ['stand', 'stair', 'mlss10', 'giveup', 'surge', 'noentry', 'pause', 'fingers', 'lt2', 'noise', 'stand', 'mlss10'][k % 12];
    const L = U(132, 170); const noise = U(0.8, 2.4), wander = U(0, 2.2); const seed = 5000 + k; const fast = U(0.3, 0.6), tauOff = U(45, 110);
    const drift = U(0, 10); const run = I(1500, 2700); const lvl = sec => L + drift * Math.max(0, sec - 600) / 1500;
    const P = { fam }; let segs = [], lactate = [], pauses = [], phases = null, type = 'free', purpose = pick([undefined, 'lt1', 'mlss']), idle = [], extra = {}, truth = {}, gaps = [], endSec = null, mod = null;
    const standTo = () => L - U(28, 55);
    if (fam === 'stand') { // the plain case: stop, stand, the value typed while standing (or later), then nothing / a walk / a jog
      const stand = I(40, 180), typed = I(12, stand - 3), after = pick(['none', 'walk', 'jog', 'none', 'walk']); const aLen = after === 'none' ? 0 : I(60, 700); const aTo = after === 'walk' ? L - U(14, 40) : L - U(8, 14);
      const typedLate = u() < 0.2 && aLen > 150; const tt = typedLate ? stand + I(30, Math.min(aLen - 10, 520)) : typed;
      segs = [{ until: run, hr: lvl }, { until: run + stand, hr: standTo(), tau: tauOff, fast }]; if (aLen) segs.push({ until: run + stand + aLen, hr: aTo, tau: 40 });
      const rest = u() < 0.4 ? [[I(20, 200), 1.1]] : []; lactate = [...rest, [run + tt, 2.2]]; if (u() < 0.2 && !typedLate && stand - typed > 25) lactate.push([run + typed + 20, 2.4]);
      idle = [[run, run + stand + aLen + 1]]; truth = { end: run, endRole: 2.2, rest: rest.length ? 1.1 : null, mid: null };
    } else if (fam === 'stair') { // walked or jogged first, then stood for the sample
      const d1 = pick([I(30, 170), I(190, 600)]), D1 = U(8, 30), stand = I(60, 130), typed = I(20, stand - 5);
      segs = [{ until: run, hr: lvl }, { until: run + d1, hr: L + drift * (run - 600) / 1500 - D1, tau: U(35, 55) }, { until: run + d1 + stand, hr: standTo() - 5, tau: tauOff, fast: fast * 0.8 }];
      lactate = [[run + d1 + typed, 3.6]]; idle = [[run, run + d1 + stand + 1]]; truth = { end: run, endRole: 3.6, rest: null, mid: null, ambiguous: d1 > 180 || D1 < 12 }; Object.assign(P, { d1, D1 });
    } else if (fam === 'mlss10') { // a stop for the 10-min sample, 20 more minutes, the stop for the end sample
      const s1 = I(560, 640), stop1 = I(50, 130), run2 = I(1100, 1300), stand = I(50, 150), typed2 = I(15, stand - 3); const typed1 = u() < 0.75 ? I(15, stop1 - 2) : stop1 + I(20, 200); const e2 = s1 + stop1 + run2; const after = pick(['none', 'walk', 'none']); const aLen = after === 'none' ? 0 : I(60, 500);
      const lv2 = sec => L + 4 + drift * Math.max(0, sec - s1 - stop1) / 1200;
      segs = [{ until: s1, hr: L }, { until: s1 + stop1, hr: standTo(), tau: tauOff, fast }, { until: e2, hr: lv2 }, { until: e2 + stand, hr: standTo(), tau: tauOff, fast }]; if (aLen) segs.push({ until: e2 + stand + aLen, hr: L - U(15, 35), tau: 40 });
      const skip1 = u() < 0.12; lactate = [[s1 + typed1, skip1 ? null : 3.4], [e2 + typed2, 4.1]]; if (u() < 0.15) lactate.push([e2 + typed2 + 25, 4.3]);
      if (u() < 0.2) pauses = [[s1 + I(1, 6), s1 + stop1 - I(0, 5)]];
      idle = [[s1, s1 + stop1], [e2, e2 + stand + aLen + 1]]; truth = { end: e2, endRole: 4.1, mid: skip1 ? null : 3.4, rest: null, stops: [[s1, s1 + stop1]] }; purpose = 'mlss';
    } else if (fam === 'giveup') { // running again after the 10-min sample, given up 1–7 min later
      const again = I(50, 420), tail = I(15, 150), typed = Math.min(tail - 3, I(10, 70)); const stop2 = 670 + again;
      segs = [{ until: 600, hr: L }, { until: 670, hr: standTo(), tau: tauOff, fast }, { until: stop2, hr: L + 3 }, { until: stop2 + tail, hr: standTo(), tau: tauOff, fast }];
      lactate = [[650, 4.1], [stop2 + typed, 7.2]]; idle = [[600, 670], [stop2, stop2 + tail + 1]]; truth = { end: stop2, endRole: 7.2, mid: 4.1, rest: null, stops: [[600, 670]] }; purpose = 'mlss';
    } else if (fam === 'surge') { // a harder stretch: in mid-run, late, as a kick before the stop, or a kick followed by a jog at the old level
      const kind = pick(['mid', 'late', 'kick', 'kickjog']); const up = U(10, 22), sLen = I(60, 300), stand = I(60, 140), typed = I(20, stand - 5); P.kind = kind;
      if (kind === 'mid' || kind === 'late') { const back = kind === 'mid' ? I(400, 900) : I(30, 240); const s0 = run - back - sLen; segs = [{ until: s0, hr: L }, { until: s0 + sLen, hr: L + up, tau: 30 }, { until: run, hr: L, tau: 40 }, { until: run + stand, hr: standTo(), tau: tauOff, fast }]; truth = { end: run, ambiguous: kind === 'late' && back < 150 }; }
      else if (kind === 'kick') { segs = [{ until: run - sLen, hr: L }, { until: run, hr: L + up, tau: 25 }, { until: run + stand, hr: standTo(), tau: tauOff, fast }]; truth = { end: run }; }
      else { const jog = I(60, 400); segs = [{ until: run - sLen, hr: L }, { until: run, hr: L + up, tau: 25 }, { until: run + jog, hr: L - U(0, 6), tau: 40 }, { until: run + jog + stand, hr: standTo(), tau: tauOff, fast }]; truth = { end: run, ambiguous: true }; idle = [[run + jog, run + jog + stand + 1]]; }
      const tEnd = segs[segs.length - 1].until; lactate = [[tEnd - stand + typed, 3.9]]; if (!idle.length) idle = [[run, tEnd + 1]]; truth.endRole = 3.9; truth.mid = null; truth.rest = null;
    } else if (fam === 'noentry') { // nothing typed during the session (the value goes into the card afterwards)
      const kind = pick(['stand', 'walk', 'jog', 'flat', 'lower', 'sofa', 'strapoff']); P.kind = kind;
      if (kind === 'flat') { segs = [{ until: run, hr: lvl }]; truth = { end: run, flat: true }; }
      else if (kind === 'lower') { const at = I(600, run - 600); segs = [{ until: at, hr: L }, { until: run, hr: L - U(10, 22), tau: 40 }]; truth = { end: run, ambiguous: true }; }
      else if (kind === 'sofa') { segs = [{ until: run, hr: lvl }, { until: run + 500, hr: 72, tau: tauOff, fast }, { until: run + 2500, hr: 62, tau: 200 }, { until: run + 2800, hr: 86, tau: 30 }, { until: run + 5000, hr: 60, tau: 60 }]; truth = { end: run }; idle = [[run, run + 5001]]; }
      else if (kind === 'strapoff') { const tail = I(60, 900); segs = [{ until: run, hr: lvl }, { until: run + 8, hr: L - 10, tau: 20 }]; endSec = run + 8 + tail; truth = { end: run }; idle = [[run, run + 9]]; }
      else { const stand = kind === 'stand' ? I(60, 500) : I(40, 100); const aLen = kind === 'stand' ? 0 : I(100, 700); const aTo = kind === 'walk' ? L - U(14, 40) : L - U(8, 14); segs = [{ until: run, hr: lvl }, { until: run + stand, hr: standTo(), tau: tauOff, fast }]; if (aLen) segs.push({ until: run + stand + aLen, hr: aTo, tau: 40 }); truth = { end: run }; idle = [[run, run + stand + aLen + 1]]; }
      extra = { lactateChecks: { end: pick([1.8, 2.4, 4.2]) } }; if (u() < 0.3) lactate = [[I(20, 200), 1.2]]; truth.rest = lactate.length ? 1.2 : null; truth.noEntry = true;
    } else if (fam === 'pause') {
      const kind = pick(['atstop', 'late', 'quick', 'accident', 'unconfirmed', 'early']); const stand = I(70, 160), typed = I(20, stand - 5); P.kind = kind;
      segs = [{ until: run, hr: lvl }, { until: run + stand, hr: standTo(), tau: tauOff, fast: kind === 'atstop' && u() < 0.5 ? 0 : fast }]; lactate = [[run + typed, 4.0]]; idle = [[run, run + stand + 1]]; truth = { end: run, endRole: 4.0, mid: null, rest: null };
      if (kind === 'atstop') pauses = [[run + I(0, 4), null]];                              // Pause pressed at the stop and never released
      else if (kind === 'late') pauses = [[run + I(30, 60), null]];                         // …half a minute after it
      else if (kind === 'quick') { const d = I(5, 40); segs[1].until = run + d; lactate = []; extra = { lactateChecks: { end: 4.0 } }; pauses = [[run, null]]; idle = [[run, run + d + 1]]; truth.endRole = undefined; } // Pause, Finish within seconds
      else if (kind === 'accident') pauses = [[I(40, 900), null]];                           // touched during the run, never released
      else if (kind === 'unconfirmed') pauses = [[I(300, 900), I(950, 1200)]];               // the app paused for minutes while the running went on
      else { const p0 = run - I(5, 30); pauses = [[p0, null]]; truth.end = p0; }             // pressed some seconds before the belt stopped
      purpose = 'mlss';
    } else if (fam === 'fingers') { // more than one value at a stop, a stray value, a skipped entry, a late baseline
      const kind = pick(['end3', 'mid2', 'stray', 'skipEnd', 'restLate']); const s1 = 600, stop1 = I(80, 140), e2 = s1 + stop1 + I(1100, 1300), stand = I(90, 170); P.kind = kind;
      segs = [{ until: s1, hr: L }, { until: s1 + stop1, hr: standTo(), tau: tauOff, fast }, { until: e2, hr: L + 4 }, { until: e2 + stand, hr: standTo(), tau: tauOff, fast }]; idle = [[s1, s1 + stop1], [e2, e2 + stand + 1]]; truth = { end: e2, mid: 3.4, endRole: 4.1, rest: null, stops: [[s1, s1 + stop1]] };
      if (kind === 'end3') lactate = [[s1 + 40, 3.4], [e2 + 30, 4.1], [e2 + 60, 4.4], [e2 + 85, 4.0]];
      else if (kind === 'mid2') lactate = [[s1 + 35, 3.4], [s1 + 70, 3.7], [e2 + 40, 4.1]];
      else if (kind === 'stray') lactate = [[s1 + 40, 3.4], [s1 + stop1 + I(400, 800), 3.9], [e2 + 40, 4.1]];
      else if (kind === 'skipEnd') { lactate = [[s1 + 40, 3.4], [e2 + 40, null]]; extra = { lactateChecks: { end: 4.1 } }; }
      else { lactate = [[I(100, 230), 1.0], [s1 + 40, 3.4], [e2 + 40, 4.1]]; truth.rest = 1.0; }
      purpose = 'mlss';
    } else if (fam === 'lt2') { // LT2 mode: one long rep (sometimes stopped before the clock), or intervals
      const reps = pick([1, 1, 3, 4]), work = reps === 1 ? I(1500, 1900) : 480, rest = 180, wu = 600; type = 'lt2'; phases = [[0, 'warmup']]; segs = [{ until: wu, hr: L - 30 }]; let t = wu;
      for (let i = 0; i < reps; i++) { phases.push([t, 'work']); segs.push({ until: t + work, hr: L + i }); t += work; if (i < reps - 1) { phases.push([t, 'rest']); segs.push({ until: t + rest, hr: L - 32, tau: 40 }); t += rest; } }
      const early = reps === 1 && u() < 0.4 ? I(90, 400) : 0; if (early) { segs[segs.length - 1].until = t - early; segs.push({ until: t, hr: standTo(), tau: tauOff, fast }); }
      phases.push([t, 'cooldown']); const cd = I(60, 360); segs.push({ until: t + cd, hr: early ? L - 40 : L - 38, tau: tauOff, fast: early ? 0 : fast });
      const entry = u() < 0.7; if (entry) lactate = [[(early ? t - early : t) + I(25, 55), 3.8]]; else extra = { lactateChecks: { end: 3.8 } };
      truth = { end: t - early, bouts: reps, endRole: entry ? 3.8 : undefined, mid: null, rest: null }; idle = [[t - early, t + cd + 1]];
    } else { // odd data: a slow slide, false readings, the strap silent around the stop, samples out of order, a value only every 5 s
      const kind = pick(['slide', 'dip', 'high', 'gapstop', 'unsorted', 'sparse']); const stand = I(70, 150), typed = I(20, stand - 5); P.kind = kind;
      if (kind === 'slide') { segs = [{ until: run - 600, hr: L }, { until: run, hr: sec => L - U(10, 16) * (sec - (run - 600)) / 600, tau: 20 }]; lactate = [[run - 10, 2.2]]; truth = { end: run, flat: true, endRole: 2.2 }; }
      else { segs = [{ until: run, hr: lvl }, { until: run + stand, hr: standTo(), tau: tauOff, fast }]; lactate = [[run + typed, 2.2]]; idle = [[run, run + stand + 1]]; truth = { end: run, endRole: 2.2 }; if (kind === 'gapstop') gaps = [[run - I(5, 40), run + I(10, 50)]]; }
      truth.mid = null; truth.rest = null; mod = kind;
    }
    let hr = simHr({ segs, seed, noise, wander, gaps, step: mod === 'sparse' ? 5 : 1 });
    if (mod === 'dip') { const a = T0 + (run - I(100, 400)) * 1000; hr = hr.map(p => (p[0] >= a && p[0] < a + 8000) ? [p[0], Math.round(p[1] / 2)] : p); }
    if (mod === 'high') { const a = T0 + I(500, run - 400) * 1000; hr = hr.map(p => (p[0] >= a && p[0] < a + 90000) ? [p[0], p[1] + 22] : p); }
    if (mod === 'unsorted') { for (let i = 50; i < hr.length - 1; i += 97) { const x = hr[i]; hr[i] = hr[i + 1]; hr[i + 1] = x; } }
    const session = mk({ hr, type, speed: 10.5, purpose, lactate, pauses, phases, endSec, a1: a1From(idle), smo2: k % 5 === 0 ? smoFrom(idle) : null, extra });
    return { fam, key: fam + (P.kind ? ':' + P.kind : ''), P, session, truth };
  }
  const N = 720; const F = {}; const get = k => F[k] || (F[k] = { n: 0, sure: 0, err: [], hrErr: [], a1Max: 0, rolesBad: [], wrong: [], stopsOk: 0, stopsN: 0, stopErr: [], durErr: [], hows: {}, smoBad: 0, smoN: 0, pauseOff: 0, estErr: [] });
  for (let k = 1; k <= N; k++) {
    const { fam, key, P, session: s, truth } = scenario(k); const f = get(key); f.n++;
    const tl = runTimeline(s); const endSec = rel(s, tl.end); const c = lactateChecks(s); const ew = endWindowStats(s, 300); const px = endOnlyProxy(s);
    f.hows[tl.how + (tl.sure ? '' : '?')] = (f.hows[tl.how + (tl.sure ? '' : '?')] || 0) + 1;
    // the truth for "the last 5 min of running": 300 s back from the true end, a stop inside (and the minute of coming back up) skipped over
    const inner = (truth.stops || []).map(x => [x[0], x[1] + 60]); let w0 = truth.end - 300; for (const x of inner.slice().reverse()) if (x[1] > w0 && x[0] < truth.end) w0 -= (Math.min(x[1], truth.end) - Math.max(x[0], w0));
    const tv = []; for (const p of s.hrLive) { const sec = (p[0] - T0) / 1000; if (sec > truth.end || sec < w0 || inner.some(x => sec > x[0] && sec < x[1])) continue; tv.push(p[1]); }
    if (tl.sure) { f.sure++;
      if (tl.how !== 'finish' && !truth.ambiguous) { f.err.push(endSec - truth.end); if (Math.abs(endSec - truth.end) > 45) f.wrong.push(k); if (Number.isFinite(ew.hr)) f.hrErr.push(Math.abs(ew.hr - mean(tv))); if (Number.isFinite(ew.alpha1)) f.a1Max = Math.max(f.a1Max, ew.alpha1); }
      if (truth.flat && tl.how !== 'finish') f.wrong.push(k);
      if (tl.how === 'pause' && !s.events.some(e => e.type === 'pause' && e.t === tl.end)) f.pauseOff++;
      if (truth.stops) { f.stopsN++; if (tl.stops.length === 1) { f.stopsOk++; f.stopErr.push(rel(s, tl.stops[0][0]) - truth.stops[0][0]); if (fam !== 'giveup') f.durErr.push(px.durMin - (truth.end - (truth.stops[0][1] - truth.stops[0][0])) / 60); } }
      if (s.smo2 && fam === 'stand' && tl.how === 'sample') { const ss = smo2Steady(s); f.smoN++; if (!ss || Math.abs(ss.slopeEnd + 0.4) > 0.02 || ss.steady !== false) f.smoBad++; }
    } else if (tl.how === 'hr') f.estErr.push(endSec - truth.end);
    if (truth.endRole !== undefined && (c.rest !== (truth.rest ?? null) || c.mid !== (truth.mid ?? null) || c.end !== truth.endRole)) f.rolesBad.push(k);
  }
  const all = Object.values(F); const sum = fn => all.reduce((a, f) => a + fn(f), 0); const cat = (keys, field) => keys.flatMap(k => F[k] ? F[k][field] : []);
  const qq = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : NaN; };
  const wrong = all.flatMap(f => f.wrong), rolesBad = all.flatMap(f => f.rolesBad);
  check(`${N} generated sessions of ${Object.keys(F).length} kinds: no end that is called certain lies more than 45 s from the true one`, wrong.length === 0, wrong.length ? `scenarios ${wrong.slice(0, 8).join(', ')}` : `${sum(f => f.sure)} certain, ${N - sum(f => f.sure)} not relied on`);
  const hrMax = Math.max(...all.flatMap(f => f.hrErr)); check('  last-5-min heart rate of a certain end: within 1 bpm of the heart rate of the last 5 min of running', hrMax < 1.0, `largest difference ${hrMax.toFixed(2)} bpm`);
  check('  α1 of a certain end is that of the running (a Pause pressed a few seconds after the stop lets those seconds in, no more)', Math.max(...all.map(f => f.a1Max)) <= 0.452, `largest ${Math.max(...all.map(f => f.a1Max)).toFixed(4)} (pure running = 0.45, standing = 1.2)`);
  check('  every value is filed as what it was (baseline / 10-min / end)', rolesBad.length === 0, rolesBad.length ? `scenarios ${rolesBad.slice(0, 8).join(', ')}` : '');
  const clean = ['stand', 'mlss10', 'fingers:end3', 'fingers:mid2', 'fingers:stray', 'fingers:skipEnd', 'fingers:restLate', 'pause:late', 'pause:unconfirmed', 'pause:accident', 'noise:high', 'noise:unsorted', 'noise:dip', 'noise:sparse', 'surge:mid', 'surge:kick', 'surge:late']; const ce = cat(clean, 'err');
  check('  timing of a stop for a sample (stand-still after the run): median within 5 s, 95 % within 8 s, none later than 12 s, none earlier than 25 s', qq(ce, 0.5) <= 5 && qq(ce, 0.5) >= 0 && qq(ce, 0.95) <= 8 && qq(ce, 1) <= 12 && qq(ce, 0) >= -25, `n ${ce.length}: min ${qq(ce, 0)}, median ${qq(ce, 0.5)}, 95 % ${qq(ce, 0.95)}, max ${qq(ce, 1)} s`);
  const st = F.stair; check('  walked or jogged first, then stood: when called certain, the end is where the walking began (−10 … +25 s)', st.err.length >= 20 && qq(st.err, 0) >= -10 && qq(st.err, 1) <= 25, `n ${st.err.length}: ${qq(st.err, 0)} … ${qq(st.err, 1)} s; ${st.n - st.sure} of ${st.n} not relied on`);
  const stops = ['mlss10', 'fingers:end3', 'fingers:mid2', 'fingers:stray', 'fingers:skipEnd', 'fingers:restLate', 'giveup']; const se = cat(stops, 'stopErr'), de = cat(stops, 'durErr');
  check('  a stop for the 10-min sample: found in every certain session, exactly once', stops.every(k => F[k].stopsOk === F[k].stopsN) && se.length > 200, stops.map(k => `${F[k].stopsOk}/${F[k].stopsN}`).join(' '));
  check('  …its beginning within −15 … +10 s, the running time within 0.45 min of the true one', qq(se, 0) >= -15 && qq(se, 1) <= 10 && qq(de, 0) >= -0.45 && qq(de, 1) <= 0.45, `start ${qq(se, 0)} … ${qq(se, 1)} s, running time ${qq(de, 0).toFixed(2)} … ${qq(de, 1).toFixed(2)} min`);
  check('  SmO2 end slope of the runs with a sensor file: that of the running (−0.40 %/min, not steady), untouched by the rebound after the stop', F.stand.smoN >= 15 && F.stand.smoBad === 0, `${F.stand.smoBad} of ${F.stand.smoN} off`);
  check('  an end marked by Pause is the moment Pause was pressed', sum(f => f.pauseOff) === 0 && (F['pause:early'].hows.pause || 0) >= 10 && (F['pause:quick'].hows.pause || 0) === F['pause:quick'].n);
  const never = ['noentry:stand', 'noentry:walk', 'noentry:jog', 'noentry:lower', 'noentry:sofa']; const ne = cat(['noentry:stand', 'noentry:walk', 'noentry:sofa'], 'estErr');
  check('  nothing typed during the session and a tail after the run: never certain — an estimate (within 45 s of the true end after a stand-still or a walk)', never.every(k => F[k].sure === 0 && F[k].hows['hr?'] === F[k].n) && ne.length >= 20 && qq(ne, 0) >= -45 && qq(ne, 1) <= 45, `estimates ${qq(ne, 0)} … ${qq(ne, 1)} s`);
  check('  Finish while running, or a slow slide with a value typed while running: the end of the recording', F['noentry:flat'].hows.finish === F['noentry:flat'].n && F['noise:slide'].hows.finish === F['noise:slide'].n);
  const rate = k => F[k].sure / F[k].n;
  check('  how often the plain cases are called certain: stand-still ≥ 95 %, with a 10-min stop 100 %, a surge in mid-run ≥ 80 %, LT2 mode ≥ 90 %', rate('stand') >= 0.95 && rate('mlss10') === 1 && rate('surge:mid') >= 0.8 && rate('lt2') >= 0.9, `${(100 * rate('stand')).toFixed(0)} / ${(100 * rate('mlss10')).toFixed(0)} / ${(100 * rate('surge:mid')).toFixed(0)} / ${(100 * rate('lt2')).toFixed(0)} %`);
  { let n = 0, sure = 0, flagged = 0, nLong = 0; for (let k = 1; k <= N; k++) { if (k % 12 !== 1) continue; const { P, session: s } = scenario(k); const tl = runTimeline(s); if (P.d1 <= 170 && P.D1 >= 12) { n++; if (tl.sure) sure++; } if (P.d1 >= 190 && P.D1 >= 12) { nLong++; if (!tl.sure) flagged++; } }
    check('  a walk of under 3 min before standing leaves no doubt; one of more than 3 min is flagged (two steps down, minutes apart)', n >= 10 && sure === n && nLong >= 10 && flagged >= 0.9 * nLong, `short walk: ${sure}/${n} certain; long walk: ${flagged}/${nLong} flagged`); }
}

// ───────────── 20. Findings of the third review ─────────────
{
  const Z = { lt1Hr: 140, lt1Speed: 8.4, lt2Hr: 120, lt2Speed: 9 };
  // a faster first 10 min (or the level before a mid stop) above the final level, a recovery tail, values in the card: never "end of the recording, certain"
  { const hr = simHr({ segs: [{ until: 600, hr: 160 }, { until: 690, hr: 115, fast: 0.4 }, { until: 1890, hr: 154 }, { until: 1980, hr: 110, fast: 0.5 }, { until: 2130, hr: 116, tau: 40 }], seed: 201 });
    const s = mk({ hr, purpose: 'mlss', extra: { lactateChecks: { mid: 4.9, end: 6.3 } } }); const tl = runTimeline(s); const z = verdictZoneChange(Z, s);
    check('earlier level above the final one, a recovery tail, nothing typed in the session: an estimate, not "certain"', !tl.sure && Math.abs(rel(s, tl.end) - 1890) <= 30 && (!z || z.zones.lt2Hr === 120), `${tl.how} ${tl.sure} ${mmss(rel(s, tl.end))}`); }
  // a cool-down jog 5 bpm below the run, then a walk down, Finish: not certain
  { const hr = simHr({ segs: [{ until: 1800, hr: 158 }, { until: 1870, hr: 115, fast: 0.4 }, { until: 2350, hr: 153, tau: 40 }, { until: 2530, hr: 105, tau: 60 }], seed: 202 });
    const s = mk({ hr, purpose: 'mlss', extra: { lactateChecks: { end: 2.6 } } }); const tl = runTimeline(s);
    check('a cool-down jog near the running level, then a walk down: not "end of the recording, certain"', !tl.sure, `${tl.how} ${tl.sure}`); }
  // a walk after the stop and a second value after it: the first value is the end value, the walk is not running
  { const hr = simHr({ segs: [{ until: 1800, hr: sec => 150 + 8 * sec / 1800 }, { until: 1920, hr: 108, fast: 0.5 }, { until: 2100, hr: 118, tau: 40 }, { until: 2160, hr: 104, fast: 0.3 }], seed: 203 });
    const s = mk({ hr, purpose: 'mlss', speed: 10.8, lactate: [[1845, 6.4], [2130, 5.9]] }); const c = lactateChecks(s); const tl = runTimeline(s);
    check('a second value after a 3-min walk: the first is the end sample, the end is the stop', c.end === 6.4 && c.mid === null && Math.abs(rel(s, tl.end) - 1800) <= 30, `${JSON.stringify(c)} ${tl.how} ${mmss(rel(s, tl.end))}`); }
  // a kick at the end, slow recovery, value typed 20 s after the stop, Finish 3 min later: not "certain" with the recovery inside
  { const hr = simHr({ segs: [{ until: 1560, hr: 150 }, { until: 1800, hr: 175, tau: 30 }, { until: 1980, hr: 100, tau: 250 }], seed: 204 });
    const s = mk({ hr, purpose: 'mlss', lactate: [[1820, 5.0]] }); const tl = runTimeline(s); const ew = endWindowStats(s);
    check('a kick, a slow recovery, Finish 3 min after the value: either the stop or flagged — never the recording end called certain', !(tl.how === 'finish' && tl.sure), `${tl.how} ${tl.sure} HR ${ew.hr.toFixed(1)}`); }
  // LT2 one rep, belt stopped 40 s before the rep clock, nothing typed: not the clock
  { const hr = simHr({ segs: [{ until: 600, hr: 125 }, { until: 2360, hr: 166 }, { until: 2700, hr: 105, fast: 0.5 }], seed: 205 });
    const s = mk({ hr, type: 'lt2', phases: [[0, 'warmup'], [600, 'work'], [2400, 'cooldown']], extra: { lactateChecks: { end: 6.2 } } }); const tl = runTimeline(s);
    check('LT2 rep: belt stopped 40 s before the rep clock — the clock is not taken for a certain end', !(tl.how === 'phase' && tl.sure), `${tl.how} ${tl.sure} ${mmss(rel(s, tl.end))}`); }
  // after the 10-min stop the running goes on 8 bpm lower; both values typed: the stop ends where the lower running began
  { const hr = simHr({ segs: [{ until: 600, hr: 160 }, { until: 690, hr: 115, fast: 0.4 }, { until: 1890, hr: 152 }, { until: 2000, hr: 108, fast: 0.5 }], seed: 206 });
    const s = mk({ hr, purpose: 'mlss', lactate: [[650, 4.0], [1935, 6.4]] }); const tl = runTimeline(s); const ew = endWindowStats(s);
    check('running 8 bpm lower after the 10-min stop: the stop is short, the last 5 min are those of the lower running', tl.sure && tl.stops.length === 1 && rel(s, tl.stops[0][1]) < 800 && Math.abs(ew.hr - truthHr(s, 1590, 1890)) < 1, `stop to ${mmss(rel(s, tl.stops[0][1]))}, HR ${ew.hr.toFixed(1)}`);
    const s2 = mk({ hr, purpose: 'mlss', lactate: [[650, 4.0]], extra: { lactateChecks: { end: 4.6 } } }); const t2 = runTimeline(s2);
    check('  …with the end value in the card: the 10-min stop is not taken for the end of the run', !(t2.sure && rel(s2, t2.end) < 900) && lactateChecks(s2).mid === 4.0, `${t2.how} ${t2.sure} ${mmss(rel(s2, t2.end))}`); }
  // Pause 4 min after a 15-bpm drop: flagged like a lactate value would be
  { const hr = simHr({ segs: [{ until: 1800, hr: 160 }, { until: 2040, hr: 145, tau: 40 }, { until: 2060, hr: 140 }], seed: 207 });
    const s = mk({ hr, purpose: 'mlss', pauses: [[2040, null]], extra: { lactateChecks: { end: 4.0 } } }); const tl = runTimeline(s);
    check('a Pause pressed minutes after a shallow drop: flagged (slowed, or stopped?)', !tl.sure && tl.why === 'shallow', `${tl.how} ${tl.sure} ${tl.why}`); }
  // multi-day: the fastest runs uncertain — no threshold heart rate borrowed from a slower run
  { const day = 86400000; const now = Date.now();
    const sess = (speed, la, level, daysAgo, typed) => { const hr = simHr({ segs: [{ until: 1800, hr: level }, { until: 1800 + 240, hr: level - 45, fast: 0.5 }], seed: speed * 10 + 3 }); const s = typed ? mk({ hr, speed, lactate: [[1860, la]] }) : mk({ hr, speed, extra: { lactateChecks: { end: la } } }); const shift = now - daysAgo * day - T0; s.startedAt += shift; s.endedAt += shift; s.hrLive = s.hrLive.map(p => [p[0] + shift, p[1]]); s.features = []; s.events = s.events.map(e => ({ ...e, t: e.t + shift })); return s; };
    const md = multiDayCurve([sess(8, 1.1, 128, 9, true), sess(9, 1.4, 137, 7, true), sess(10, 1.9, 146, 5, true), sess(11, 2.9, 155, 3, false), sess(12, 4.4, 164, 1, false)]);
    check('multi-day curve with the two fastest runs uncertain: their heart rate is not copied from the 10-km/h run, LT2 gets no heart rate', md.points.filter(p => p.unsure).length === 2 && md.analysis && !Number.isFinite(md.analysis.lt2Primary.hr), md.analysis ? `LT2 ${md.analysis.lt2Primary.x.toFixed(2)} km/h ${md.analysis.lt2Primary.hr}` : 'no analysis'); }
  // a record whose card fields were stored by v1.1.11 (all three at once): only the typed one is final
  { const hr = simHr({ segs: [{ until: 600, hr: 158 }, { until: 680, hr: 115, fast: 0.4 }, { until: 1830, hr: 160 }, { until: 2400, hr: 105, fast: 0.5 }], seed: 208 });
    const s = mk({ hr, purpose: 'mlss', lactate: [[640, 2.9], [1870, 3.4]] }); const fresh = lactateChecks(s);
    const legacy = { ...s, lactateChecks: { rest: 1.2, mid: 2.9, end: null } }; const now = { ...s, lactateChecks: { rest: 1.2, mid: 2.9, end: null }, lactateChecksV: 2 };
    check('card fields stored by v1.1.11: the untouched ones follow today\'s filing; stored by v1.1.12 they are final', fresh.end === 3.4 && lactateChecks(legacy).end === 3.4 && lactateChecks(legacy).rest === 1.2 && lactateChecks(now).end === null, `${JSON.stringify(lactateChecks(legacy))} / ${JSON.stringify(lactateChecks(now))}`); }
  // a heart-rate clock jump of a year: quick
  { const hr = simHr({ segs: [{ until: 1800, hr: 150 }, { until: 1900, hr: 105, fast: 0.5 }], seed: 209 }).map(p => p[0] > T0 + 1200000 ? [p[0] + 365 * 86400000, p[1]] : p);
    const s = mk({ hr, extra: { lactateChecks: { end: 2 } } }); const t1 = performance.now(); runTimeline(s); endWindowStats(s); endOnlyProxy(s); const ms = performance.now() - t1;
    check('a clock jump of a year inside the heart-rate data: quick', ms < 300, `${ms.toFixed(0)} ms`); }
  // damaged lists in a record: nothing throws
  { const hr = simHr({ segs: [{ until: 1800, hr: 150 }], seed: 210 }); const s = mk({ hr, lactate: [[1790, 2]] }); s.features.splice(3, 0, null); s.events.push(null); s.hrLive.splice(10, 0, null, 'x');
    let ok = true; try { sessionMetrics(s); lactateVerdict(s); endWindowStats(s); endOnlyProxy(s); verdictZoneChange(Z, s); multiDayCurve([s]); sessionMetrics({ ...s, events: {} }); } catch (e) { ok = false; }
    check('nulls and non-lists inside a record: nothing throws', ok); }
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS'); process.exit(failures ? 1 : 0);

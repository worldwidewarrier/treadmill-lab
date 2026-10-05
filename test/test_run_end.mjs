// Where the running stopped (analysis.js runTimeline) and everything the verification card derives from it.
// Sessions are simulated: heart rate with realistic on/off kinetics, noise and slow wander; the moment the belt stopped is known.
import { runTimeline, pauseIntervals, runWindowStart, runWindowEnd, stoppedMs, smo2Steady, RUN_END } from '../js/analysis.js';
import { lactateChecks, lactateVerdict, endWindowStats, endOnlyProxy, verdictZoneChange, multiDayCurve, sessionMetrics } from '../js/prescribe.js';

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

// ───────────── 3. MLSS check with a 10-min sample: a stop inside the run ─────────────
{
  const level = sec => 150 + 6 * Math.min(1, sec / 600) + 8 * Math.max(0, sec - 675) / 1200; const END = 1875; // 30 min of running + the 75-s stop
  const segs = () => [{ until: 600, hr: level }, { until: 675, hr: 112, fast: 0.4 }, { until: END, hr: level }, { until: END + 120, hr: 104, fast: 0.5 }, { until: END + 420, hr: 118, tau: 40 }];
  const hr = simHr({ segs: segs(), seed: 5 });
  const a1 = sec => (sec > 600 && sec <= 675 + 60) ? 1.3 : (sec > 675 + 60 && sec <= 675 + 60 + 120) ? 0.9 : sec > END ? 1.2 : 0.45; // standing / window still holding standing beats / running
  const s = mk({ hr, purpose: 'mlss', lactate: [[650, 3.4], [END + 70, 4.1]], a1 }); const tl = runTimeline(s);
  check('MLSS with 10-min sample: end at the last stop, one stop inside the run', tl.how === 'sample' && tl.sure && Math.abs(rel(s, tl.end) - END) <= 20 && tl.stops.length === 1 && Math.abs(rel(s, tl.stops[0][0]) - 600) <= 20 && rel(s, tl.stops[0][1]) >= 675 && rel(s, tl.stops[0][1]) <= 675 + 150, `end ${mmss(rel(s, tl.end))}, stop ${tl.stops.map(x => mmss(rel(s, x[0])) + '–' + mmss(rel(s, x[1]))).join()}`);
  const c = lactateChecks(s); check('  10-min value is the mid sample, the last one the end sample', c.mid === 3.4 && c.end === 4.1 && c.rest === null, JSON.stringify(c));
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
  check('  the value is still the end sample (by the clock of the recording), the proxy call is withheld, no zone moves', lactateChecks(jog).end === 4.6 && lactateVerdict(jog).unsure === true && verdictZoneChange(ZL, jog) === null && Number.isNaN(multiDayCurve([{ ...jog, id: 'j', startedAt: Date.now() - 1000 }]).points[0].hr));
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
  check('one heart-rate value every 5 s: too thin to time a stop — falls back to the recording, no error', ['finish', 'sample', 'hr'].includes(runTimeline(sparse).how) && Number.isFinite(endWindowStats(sparse).hr));
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
  for (const bad of [0, -5, 99999, NaN, '1500']) { s.runEndSec = bad; }
  s.runEndSec = 99999; check('  a time outside the recording is ignored', runTimeline(s).how !== 'manual'); s.runEndSec = 0; check('  zero is ignored', runTimeline(s).how !== 'manual'); s.runEndSec = '1500'; check('  text is ignored', runTimeline(s).how !== 'manual');
  delete s.runEndSec; check('  removing it returns to the automatic end', runTimeline(s).how === auto.how && runTimeline(s).end === auto.end);
  check('the timeline is computed once per session state', runTimeline(s) === runTimeline(s));
  s.events.push({ t: T0 + 2399000, type: 'rpe', value: 15 }); const again = runTimeline(s); check('  …and again when something was added to the session', again !== auto && again.end === auto.end);
}

// ───────────── 9. Fields of the card ─────────────
{
  const END = 1800; const hr = simHr({ segs: [{ until: 600, hr: 152 }, { until: 680, hr: 112, fast: 0.4 }, { until: END, hr: 156 }, { until: END + 100, hr: 104, fast: 0.5 }], seed: 61 });
  const s = mk({ hr, purpose: 'mlss', lactate: [[30, 1.0], [650, 3.4], [END + 60, 4.1]] });
  check('as recorded', JSON.stringify(lactateChecks(s)) === '{"rest":1,"mid":3.4,"end":4.1}');
  s.lactateChecks = { end: 4.6 }; check('one field typed: only that one is fixed', JSON.stringify(lactateChecks(s)) === '{"rest":1,"mid":3.4,"end":4.6}');
  s.lactateChecks = { mid: null }; check('a field emptied stays empty (it used to refill from the recording)', JSON.stringify(lactateChecks(s)) === '{"rest":1,"mid":null,"end":4.1}');
  s.lactateChecks = { rest: null, mid: null, end: null }; check('all three emptied: no verdict', lactateChecks(s).end === null && lactateVerdict(s) === null);
  s.lactateChecks = { end: 'abc' }; check('rubbish in a field counts as empty', lactateChecks(s).end === null);
  delete s.lactateChecks;
  const twoRest = mk({ hr, purpose: 'mlss', lactate: [[20, 1.0], [140, 1.2], [END + 60, 4.1]] });
  check('a second baseline value (second finger before the run) is not the 10-min sample', JSON.stringify(lactateChecks(twoRest)) === '{"rest":1,"mid":null,"end":4.1}');
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
    check(`4 × 8 min, purpose ${purpose ?? 'auto'}: interval verdict, no zone change, not a point of the curve`, tv.bouts === 4 && vd.intervals === true && vd.level === 'low' && verdictZoneChange({ lt1Hr: 100, lt1Speed: 5, lt2Hr: 100, lt2Speed: 5 }, iv) === null && multiDayCurve([{ ...iv, startedAt: Date.now() - 86400000 }]).points.length === 0 && !endOnlyProxy(iv).single && Number.isNaN(endOnlyProxy(iv).driftBpm), vd.en.slice(0, 60));
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
  check(`${n} runs finished while running (steady, drifting, slow start, fast finish, progressive, pace raised): every figure as in v1.1.11`, bad === 0, bad ? `${bad} differ: ${badEx.join(' | ')}` : '');
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

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS'); process.exit(failures ? 1 : 0);

// node test/test_exercise_end.mjs — the recording usually runs on for a minute or more after the belt stops (lactate sample, typing).
// 1) exerciseEnd() finds where the running stopped from heart rate alone, on synthetic runs with noise and many kinds of tail.
// 2) The numbers a verification run is judged by must not depend on how long the athlete took to press Finish.
// 3) Tails with several phases (stand, walk, stand), very long tails, and things that are NOT an end: slower pace, surges, false readings.
// 4) LT2 sessions recorded by the real engine: the phase log decides, intervals get their own verdict and never move the zones.
// 5) Lactate samples on runs given up early, on unfinished recordings, and with a belt stop for the 10-min sample.
import { exerciseEnd, workBout, smo2Steady, pausedMsBefore } from '../js/analysis.js';
import { endWindowStats, endOnlyProxy, lactateVerdict, lactateChecks, sessionMetrics, verdictZoneChange, multiDayCurve, claudeSummary } from '../js/prescribe.js';
import { SessionEngine } from '../js/session.js';
let failures = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) failures++; };
function mkGauss(seed) { let s = seed >>> 0; const r = () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; return () => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }; }
const T0 = Date.UTC(2026, 9, 7, 0, 0, 0);
/**
 * runSec of running at `level` bpm (+`drift` from minute 10 to the end, first-order on-kinetics), then tailSec of recovery towards `floor`
 * (time constant `tau`, starting `delay` s after the stop). step = sample spacing; midStop = { at, dur } is a belt stop in the middle.
 * SmO2 (when smo2Fall is given, %/min after minute 10) rebounds to 78 % within seconds of stopping, as muscle oxygenation does.
 */
function mk({ runSec = 1800, tailSec = 100, level = 150, drift = 4, floor = 100, tau = 65, step = 1, noise = 1.5, wander = 1.5, midStop = null, delay = 6, seed = 1, smo2Fall = null, end = 4.2, purpose = 'mlss' } = {}) {
  const g = mkGauss(seed); const hr = [], smo = []; let h = 95;
  for (let s = 0; s <= runSec + tailSec; s += step) {
    const inMid = midStop && s >= midStop.at && s < midStop.at + midStop.dur; const running = s < runSec && !inMid;
    const target = running ? level + drift * Math.max(0, s - 600) / Math.max(1, runSec - 600) + wander * Math.sin(s / 47) : inMid ? floor + 10 : (s - runSec < delay ? null : floor);
    if (target != null) h += (target - h) * (1 - Math.exp(-step / (running ? 30 : tau)));
    hr.push([T0 + s * 1000, Math.round(h + noise * g())]);
    if (smo2Fall != null) { const atStop = 62 - smo2Fall * (runSec - 600) / 60; const o = s < runSec ? 70 - 8 * (1 - Math.exp(-s / 120)) - smo2Fall * Math.max(0, s - 600) / 60 : atStop + (78 - atStop) * (1 - Math.exp(-(s - runSec) / 25)); smo.push([T0 + s * 1000, o + 0.3 * g(), 25]); }
  }
  const events = end != null ? [{ t: T0 + (runSec + Math.max(15, tailSec - 15)) * 1000, type: 'lactate', value: end }] : [];
  return { type: 'free', purpose, speed: 10.5, incline: 1, startedAt: T0, endedAt: T0 + (runSec + tailSec) * 1000, hrLive: hr, features: [], events, ...(smo2Fall != null ? { smo2: { series: smo, offsetMs: 0 } } : {}), _stop: T0 + runSec * 1000 };
}
// ---------- 1) detector ----------
const battery = (name, opts, expect) => {
  const errs = []; let miss = 0, falsePos = 0;
  for (let seed = 1; seed <= 25; seed++) { const s = mk({ ...opts, seed }); const ex = exerciseEnd(s); if (expect === 'none') { if (ex.how !== 'end' || ex.t !== s.endedAt) falsePos++; } else if (ex.how !== 'hr') miss++; else errs.push((ex.t - s._stop) / 1000); }
  if (expect === 'none') return check(name, falsePos === 0, `false detections ${falsePos}/25`);
  const lo = Math.min(...errs), hi = Math.max(...errs);
  check(name, miss === 0 && lo >= -20 && hi <= 20, `missed ${miss}/25, detected ${lo.toFixed(0)} … ${hi.toFixed(0)} s from the true stop`);
};
battery('no tail (finished while running) → recording end', { tailSec: 0 }, 'none');
battery('no tail, strong upward drift', { tailSec: 0, drift: 12 }, 'none');
battery('no tail, downward drift', { tailSec: 0, drift: -8 }, 'none');
battery('no tail, noisy strap (sd 3, wander 3)', { tailSec: 0, noise: 3, wander: 3 }, 'none');
battery('finished 10 s after stopping → nothing worth cutting', { tailSec: 10 }, 'none');
battery('belt stop in the middle of the run, none at the end', { tailSec: 0, midStop: { at: 600, dur: 90 } }, 'none');
for (const tail of [45, 90, 180, 300, 600]) battery(`standing tail ${tail} s`, { tailSec: tail });
battery('walking cool-down recorded for 4 min (HR settles at 118)', { tailSec: 240, floor: 118, tau: 50 });
battery('easy run at 136 bpm, 2-min tail', { level: 136, drift: 1, floor: 95, tailSec: 120 });
battery('hard run, drift +10, 100-s tail', { level: 152, drift: 10, tailSec: 100 });
battery('slow recovery (τ 110 s)', { tau: 110, tailSec: 150 });
battery('fast recovery (τ 35 s)', { tau: 35, tailSec: 90 });
battery('noisy strap, 2-min tail', { noise: 3, wander: 3, tailSec: 120 });
battery('5-s samples (imported file), 2-min tail', { step: 5, tailSec: 120 });
battery('mid-run belt stop + 2-min tail: only the final stop counts', { tailSec: 120, midStop: { at: 600, dur: 90 } });
battery('12-min run, 90-s tail', { runSec: 720, tailSec: 90 });
check('too short to judge (4 min) → recording end', exerciseEnd(mk({ runSec: 180, tailSec: 60 })).how === 'end');
check('no heart rate → recording end, no crash', (() => { const e = exerciseEnd({ startedAt: T0, endedAt: T0 + 1800000, hrLive: [] }); return e.how === 'end' && e.t === T0 + 1800000; })());
check('strap silent for the last minute → recording end', (() => { const s = mk({ tailSec: 120 }); s.hrLive = s.hrLive.filter(p => p[0] < s.endedAt - 60000); return exerciseEnd(s).how === 'end'; })());

// ---------- 2) results do not depend on the length of the tail ----------
const ref = { above: mk({ level: 152, drift: 10, tailSec: 0, smo2Fall: 0.5 }), below: mk({ level: 152, drift: 3, tailSec: 0, smo2Fall: 0 }) };
for (const tail of [60, 100, 180, 300]) {
  for (const [kind, opts] of [['above', { level: 152, drift: 10, smo2Fall: 0.5 }], ['below', { level: 152, drift: 3, smo2Fall: 0 }]]) {
    const s = mk({ ...opts, tailSec: tail }); const r = ref[kind];
    const ew = endWindowStats(s), ew0 = endWindowStats(r), px = endOnlyProxy(s), px0 = endOnlyProxy(r), ss = smo2Steady(s), ss0 = smo2Steady(r), v = lactateVerdict(s), v0 = lactateVerdict(r);
    check(`${kind} MLSS, ${tail}-s tail: last-5-min HR as without a tail`, Math.abs(ew.hr - ew0.hr) < 1.0 && ew.how === 'hr', `${ew.hr.toFixed(1)} vs ${ew0.hr.toFixed(1)} bpm`);
    check(`${kind} MLSS, ${tail}-s tail: HR drift and run time as without a tail`, Math.abs(px.driftBpm - px0.driftBpm) < 1.0 && Math.abs(px.durMin - 30) < 0.4, `${px.driftBpm.toFixed(1)} vs ${px0.driftBpm.toFixed(1)} bpm, ${px.durMin.toFixed(1)} min`);
    check(`${kind} MLSS, ${tail}-s tail: SmO2 end slope and steadiness as without a tail`, Math.abs(ss.slopeEnd - ss0.slopeEnd) < 0.12 && ss.steady === ss0.steady, `${ss.slopeEnd.toFixed(2)} vs ${ss0.slopeEnd.toFixed(2)} %/min, steady ${ss.steady}`);
    check(`${kind} MLSS, ${tail}-s tail: same verdict`, v.level === v0.level && v.level === (kind === 'above' ? 'high' : 'ok'), `${v.level} (${v0.level} without tail)`);
  }
}
{ // zone update from a confirmed run uses the running heart rate, not the recovery
  const z = { lt1Hr: 140, lt1Speed: 8.4, lt2Hr: 150, lt2Speed: 10.0 }; const s = mk({ level: 156, drift: 3, smo2Fall: 0, tailSec: 150 });
  const ch = verdictZoneChange(z, s); const trueEnd = endWindowStats(mk({ level: 156, drift: 3, smo2Fall: 0, tailSec: 0 })).hr;
  check('confirmed MLSS run raises the LT2 heart-rate floor to the running HR', ch && Math.abs(ch.zones.lt2Hr - Math.round(trueEnd)) <= 1 && ch.zones.lt2Speed === 10.5, JSON.stringify(ch?.zones));
}
{ // session metrics: drift % over the run only
  const a = sessionMetrics(mk({ drift: 8, tailSec: 0 })), b = sessionMetrics(mk({ drift: 8, tailSec: 180 }));
  check('cardiac drift % unaffected by a 3-min tail', Math.abs(a.driftPct - b.driftPct) < 0.4 && b.tailSec > 150, `${a.driftPct.toFixed(2)} vs ${b.driftPct.toFixed(2)} %, tail ${Math.round(b.tailSec)} s`);
  const t = sessionMetrics({ ...mk({ drift: 8, tailSec: 180 }), type: 'test' }); check('step tests are left alone', t.tailSec === 0);
}
{ // run time for the "≥ 25 min" rule: pauses before the stop count, a pause during the tail does not
  const s = mk({ tailSec: 120 }); s.events.push({ t: T0 + 600000, type: 'pause' }, { t: T0 + 660000, type: 'resume' }, { t: s._stop + 20000, type: 'pause' }, { t: s.endedAt, type: 'stop' }); s.pauseMs = 160000;
  check('paused time before the stop only', pausedMsBefore(s, s._stop) === 60000 && pausedMsBefore(s, s.endedAt) === 160000, `${pausedMsBefore(s, s._stop)} / ${pausedMsBefore(s, s.endedAt)}`);
  check('MLSS run time = 29 min (30 − 1 min pause), tail ignored', Math.abs(endOnlyProxy(s).durMin - 29) < 0.4, endOnlyProxy(s).durMin.toFixed(2));
}
{ // a 12-min cool-down walk left recording: the sample taken 90 s after the run is still the END sample, not a "10-min" one
  const s = mk({ tailSec: 720, floor: 112, tau: 50, end: null }); s.events.push({ t: s._stop + 90000, type: 'lactate', value: 4.2 });
  const c = lactateChecks(s);
  check('end sample recognised despite a long recorded cool-down', c.end === 4.2 && c.mid == null, JSON.stringify(c));
  const v = lactateVerdict(s); check('…and the run gets its verdict', v && v.kind === 'mlss', v ? v.level : 'no verdict');
  const m = mk({ tailSec: 120, end: null }); m.events.push({ t: T0 + 620000, type: 'lactate', value: 3.4 }, { t: m._stop + 60000, type: 'lactate', value: 4.0 });
  const cm = lactateChecks(m); check('10-min and end samples keep their places', cm.mid === 3.4 && cm.end === 4.0 && cm.rest == null, JSON.stringify(cm));
}

// ---------- 3) schedule-based runs: [{ until: s, hr: bpm | fn(s), tau, fast: { part, tau } }] ----------
/**
 * Heart rate follows each segment's target with time constant tau; `fast` makes a recovery bi-exponential (that part of the
 * drop decays with its own, short time constant — the vagal rebound of the first half minute). spikes: [{ from, to, add | factor }]
 * are false readings of the strap, applied to what is recorded, not to the heart.
 */
function sched({ schedule, step = 1, noise = 1.5, seed = 1, h0 = 95, type = 'free', spikes = [], extra = {} }) {
  const g = mkGauss(seed); const hr = []; let slow = h0, fast = 0, cur = null; const total = schedule[schedule.length - 1].until; let nextEmit = 0;
  for (let sec = 0; sec <= total; sec++) {
    const seg = schedule.find(x => sec < x.until) || schedule[schedule.length - 1];
    const target = typeof seg.hr === 'function' ? seg.hr(sec) : seg.hr;
    if (seg !== cur) { cur = seg; if (seg.fast) { const h = slow + fast; fast = seg.fast.part * (h - target); slow = h - fast; } }
    slow += (target - slow) * (1 - Math.exp(-1 / (seg.tau || 30))); fast *= Math.exp(-1 / ((seg.fast && seg.fast.tau) || 15));
    if (sec >= nextEmit) { let v = slow + fast + noise * g(); for (const k of spikes) if (sec >= k.from && sec < k.to) v = k.factor ? v * k.factor : v + k.add; hr.push([T0 + sec * 1000, Math.round(v)]); nextEmit = sec + step; }
  }
  return { type, purpose: 'mlss', speed: 10.5, incline: 1, startedAt: T0, endedAt: T0 + total * 1000, hrLive: hr, features: [], events: [], final: true, sourceKind: 'ble', ...extra };
}
const mmss = t => { const x = Math.round(t); return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`; };
/** 20 noise seeds; expect = seconds from the start where the running stopped, or 'none'. */
const many = (name, build, expect, tol = 20) => {
  const got = []; let wrong = 0;
  for (let seed = 1; seed <= 20; seed++) { const ss = build(seed); const ex = exerciseEnd(ss); const at = ex.how === 'hr' ? (ex.t - ss.startedAt) / 1000 : null; got.push(at);
    if (expect === 'none' ? at != null : (at == null || Math.abs(at - expect) > tol)) wrong++; }
  const seen = [...new Set(got.map(v => v == null ? 'none' : mmss(v)))].slice(0, 4).join(', ');
  check(name, wrong === 0, `${expect === 'none' ? 'expected none' : 'expected ' + mmss(expect)}, got ${seen}${wrong ? ` — wrong in ${wrong}/20` : ''}`);
};
const drift10 = sec => 152 + 10 * Math.max(0, sec - 600) / 1200; // a run above MLSS: +10 bpm from minute 10 to 30
const R = (hr = 155) => [{ until: 1800, hr }];
// several phases after the stop: the FIRST drop is the end of the run
many('stop → stand 100 s → walk 4 min → Finish while walking', seed => sched({ seed, schedule: [...R(drift10), { until: 1900, hr: 100, tau: 60 }, { until: 2140, hr: 128, tau: 40 }] }), 1800);
many('stop → stand 100 s → walk 4 min → stand 40 s → Finish', seed => sched({ seed, schedule: [...R(drift10), { until: 1900, hr: 100, tau: 60 }, { until: 2140, hr: 128, tau: 40 }, { until: 2180, hr: 98, tau: 55 }] }), 1800);
many('stop → stand 100 s → walk 4 min → stand 70 s → Finish', seed => sched({ seed, schedule: [...R(drift10), { until: 1900, hr: 100, tau: 60 }, { until: 2140, hr: 128, tau: 40 }, { until: 2210, hr: 98, tau: 55 }] }), 1800);
many('stop → stand 90 s → jog 3 min at 135 → stand 60 s → Finish', seed => sched({ seed, schedule: [...R(158), { until: 1890, hr: 100, tau: 60 }, { until: 2070, hr: 135, tau: 40 }, { until: 2130, hr: 98, tau: 55 }] }), 1800);
many('stop → sit 3 min → stand up and walk about (HR up 20) → sit 2 min → Finish', seed => sched({ seed, schedule: [...R(150), { until: 1980, hr: 92, tau: 55 }, { until: 2100, hr: 114, tau: 30 }, { until: 2220, hr: 94, tau: 50 }] }), 1800);
many('stop → walk 2 min → stand 2 min → walk 2 min → stand 1 min → Finish', seed => sched({ seed, schedule: [...R(156), { until: 1920, hr: 122, tau: 40 }, { until: 2040, hr: 100, tau: 50 }, { until: 2160, hr: 120, tau: 40 }, { until: 2220, hr: 100, tau: 50 }] }), 1800);
// recovery shapes other than one exponential
many('fast then slow recovery (half the drop in 15 s), 2-min tail', seed => sched({ seed, schedule: [...R(155), { until: 1920, hr: 100, tau: 110, fast: { part: 0.5, tau: 15 } }] }), 1800);
many('fast then slow recovery, 6-min tail', seed => sched({ seed, schedule: [...R(155), { until: 2160, hr: 98, tau: 140, fast: { part: 0.4, tau: 20 } }] }), 1800);
many('sluggish recovery: 8 s of no change, then slow (τ 120 s), 3-min tail', seed => sched({ seed, schedule: [...R(160), { until: 1808, hr: 160 }, { until: 1980, hr: 105, tau: 120 }] }), 1800, 25);
many('recovery only down to 125 (hot day, standing), 2.5-min tail', seed => sched({ seed, schedule: [...R(158), { until: 1950, hr: 125, tau: 45 }] }), 1800);
// very long tails: the search has no horizon
for (const tail of [900, 1020, 1200, 1800]) many(`standing tail of ${tail / 60} min`, seed => sched({ seed, schedule: [...R(155), { until: 1800 + tail, hr: 100, tau: 65 }] }), 1800);
for (const tail of [1020, 1500]) many(`cool-down walk of ${tail / 60} min left recording (HR 118)`, seed => sched({ seed, schedule: [...R(155), { until: 1800 + tail, hr: 118, tau: 50 }] }), 1800);
many('45-min easy run, then 25 min of walking home with the app still recording', seed => sched({ seed, schedule: [{ until: 2700, hr: 138 }, { until: 4200, hr: 105, tau: 60 }], extra: { purpose: 'lt1', speed: 8 } }), 2700);
// NOT an end: the runner is still running when Finish is pressed
many('pace eased for the last 6 min (150 → 136), Finish while running', seed => sched({ seed, schedule: [{ until: 1440, hr: 150 }, { until: 1800, hr: 136 }] }), 'none');
for (const d of [8, 12, 14]) many(`step-down of ${d} bpm at 22:00, Finish while running`, seed => sched({ seed, schedule: [{ until: 1320, hr: 150 }, { until: 1800, hr: 150 - d }] }), 'none');
many('2-min surge to 160 at 20:00, back to 140, Finish while running', seed => sched({ seed, schedule: [{ until: 1200, hr: 140 }, { until: 1320, hr: 160 }, { until: 1800, hr: 140 }] }), 'none');
many('LT1 run: 3 min too fast (150), corrected to 136 for the last 10 min', seed => sched({ seed, type: 'lt1', schedule: [{ until: 1020, hr: 136 }, { until: 1200, hr: 150 }, { until: 1800, hr: 136 }] }), 'none');
many('surge in the last 3 min (sprint finish to 172), Finish while running', seed => sched({ seed, schedule: [{ until: 1620, hr: 152 }, { until: 1800, hr: 172, tau: 40 }] }), 'none');
for (const len of [20, 50, 90]) many(`false HIGH reading (+25) for ${len} s, ten minutes before the end`, seed => sched({ seed, schedule: R(150), spikes: [{ from: 1200 - len, to: 1200, add: 25 }] }), 'none');
many('false LOW reading (half) for 40 s in the middle of the run', seed => sched({ seed, schedule: R(150), spikes: [{ from: 900, to: 940, factor: 0.5 }] }), 'none');
many('heart rate sagging 6 bpm over the last 8 min (fan switched on)', seed => sched({ seed, schedule: [{ until: 1320, hr: 154 }, { until: 1800, hr: sec => 154 - 6 * (sec - 1320) / 480 }] }), 'none');
many('two belt stops of 60 s during the run (10:00, 20:00), none at the end', seed => sched({ seed, schedule: [{ until: 600, hr: 154 }, { until: 660, hr: 112, tau: 45 }, { until: 1200, hr: 155 }, { until: 1260, hr: 112, tau: 45 }, { until: 1800, hr: 157 }] }), 'none');
many('pace eased by 10 bpm for the last 100 s, Finish while running', seed => sched({ seed, schedule: [{ until: 1700, hr: 150 }, { until: 1800, hr: 140 }] }), 'none');
many('5-min surge (+28 bpm) ending 4 min before Finish, pressed while running', seed => sched({ seed, schedule: [{ until: 660, hr: 126 }, { until: 950, hr: 154 }, { until: 1190, hr: 126 }] }), 'none');
many('pace eased by 8 bpm for the last 90 s, Finish while running', seed => sched({ seed, schedule: [{ until: 1710, hr: 152 }, { until: 1800, hr: 144 }] }), 'none');
many('pace eased by 20 bpm for the last 8 min (cool-down jog), Finish while jogging', seed => sched({ seed, schedule: [{ until: 1320, hr: 152 }, { until: 1800, hr: 132 }] }), 'none');
many('strap bumped twice while running: 4 s of doubled readings', seed => sched({ seed, schedule: R(150), spikes: [{ from: 1500, to: 1504, factor: 2 }, { from: 1700, to: 1704, factor: 2 }] }), 'none');
// a few fast minutes inside an easy run are a surge, not the run: the end is the final stop
for (const [dur, amp] of [[180, 30], [240, 24], [300, 24], [420, 19], [420, 30]]) for (const tail of [100, 300]) many(`easy run with ${dur / 60} min at +${amp} bpm ending 20:00, easy again, stop at 30:00, ${tail}-s tail`, seed => sched({ seed, schedule: [{ until: 1200 - dur, hr: 136 }, { until: 1200, hr: 136 + amp }, { until: 1800, hr: 136 }, { until: 1800 + tail, hr: 100, tau: 60 }], extra: { purpose: 'lt1', speed: 8 } }), 1800);
many('two surges (+25 bpm, 3 min each, at 10:00 and 20:00), stop at 30:00, 2-min tail', seed => sched({ seed, schedule: [{ until: 600, hr: 136 }, { until: 780, hr: 161 }, { until: 1200, hr: 136 }, { until: 1380, hr: 161 }, { until: 1800, hr: 136 }, { until: 1920, hr: 100, tau: 60 }] }), 1800);
many('hard finish (6 min at 160 after 24 min at 136), walk 5 min at 112, stand 90 s', seed => sched({ seed, schedule: [{ until: 1440, hr: 136 }, { until: 1800, hr: 160 }, { until: 2100, hr: 112, tau: 40 }, { until: 2190, hr: 100, tau: 50 }] }), 1800);
many('warm-up jog 10 min at 125, 20 min at 158, cool-down jog 6 min at 125, stand 80 s: the 158 block is the run', seed => sched({ seed, schedule: [{ until: 600, hr: 125 }, { until: 1800, hr: 158 }, { until: 2160, hr: 125, tau: 40 }, { until: 2240, hr: 100, tau: 50 }] }), 1800);
// started too fast: the first minutes are the fastest — which part is "the run" cannot be told, so nothing is cut
for (const [fast, hr] of [[300, 160], [360, 168], [480, 165]]) { let early = 0, right = 0, none = 0;
  for (let seed = 1; seed <= 20; seed++) { const ss = sched({ seed, schedule: [{ until: fast, hr }, { until: 1800, hr: 140 }, { until: 1900, hr: 100, tau: 60 }] }); const ex = exerciseEnd(ss); const at = (ex.t - ss.startedAt) / 1000; if (ex.how !== 'hr') none++; else if (Math.abs(at - 1800) <= 20) right++; else early++; }
  check(`first ${fast / 60} min at ${hr}, then 140 to 30:00, stop, 100-s tail: never "the run ended after ${fast / 60} min"`, early === 0, `true stop ${right}/20, left unresolved ${none}/20, wrong ${early}/20`); }
// false readings during the tail (strap bumped while drawing blood) do not move the end
many('4 s of doubled readings 40 s after the stop, 2-min tail', seed => sched({ seed, schedule: [...R(155), { until: 1920, hr: 100, tau: 60 }], spikes: [{ from: 1840, to: 1844, factor: 2 }] }), 1800);
many('6 s of +60 bpm 3 min after the stop, 6-min tail', seed => sched({ seed, schedule: [...R(155), { until: 2160, hr: 100, tau: 60 }], spikes: [{ from: 1980, to: 1986, add: 60 }] }), 1800);
// an eased pace AND a real stop: the stop is the end, not the change of pace
many('step-down of 10 bpm at 22:00, stop at 30:00, 2-min tail', seed => sched({ seed, schedule: [{ until: 1320, hr: 150 }, { until: 1800, hr: 140 }, { until: 1920, hr: 98, tau: 60 }] }), 1800);
many('surge at 20:00, stop at 30:00, 100-s tail', seed => sched({ seed, schedule: [{ until: 1200, hr: 140 }, { until: 1320, hr: 160 }, { until: 1800, hr: 140 }, { until: 1900, hr: 96, tau: 60 }] }), 1800);
many('false HIGH reading before the stop, 2-min tail', seed => sched({ seed, schedule: [...R(150), { until: 1920, hr: 98, tau: 60 }], spikes: [{ from: 1500, to: 1550, add: 25 }] }), 1800);
many('belt stop at 10:00 for the sample, stop at 30:00, walk 5 min, stand 1 min', seed => sched({ seed, schedule: [{ until: 600, hr: 154 }, { until: 675, hr: 108, tau: 50 }, { until: 1875, hr: 157 }, { until: 2175, hr: 124, tau: 40 }, { until: 2235, hr: 100, tau: 50 }] }), 1875);
// a cool-down jog 25 bpm and more below the run counts as "after the run" (the test load ended there)
many('LT2 run, then an 8-min cool-down jog at 128 and a stop', seed => sched({ seed, schedule: [...R(158), { until: 2280, hr: 128, tau: 40 }, { until: 2360, hr: 100, tau: 55 }] }), 1800);
// sample spacing and gaps
for (const step of [2, 5, 10]) many(`${step}-s samples, stand 100 s → walk 4 min → stand 70 s`, seed => sched({ seed, step, schedule: [...R(155), { until: 1900, hr: 100, tau: 60 }, { until: 2140, hr: 128, tau: 40 }, { until: 2210, hr: 98, tau: 55 }] }), 1800);
{ // the judged numbers of the multi-phase tail equal those of the same run finished at the stop
  const z = { lt1Hr: 140, lt1Speed: 8.4, lt2Hr: 163, lt2Speed: 11.0 }; // zones that such a run must pull DOWN (to 10.5 km/h, HR − 3)
  const mkRun = tail => { const ss = sched({ schedule: [...R(drift10), ...tail], extra: { speed: 10.8 } }); ss.events.push({ t: tail.length ? T0 + 1870000 : ss.endedAt - 1000, type: 'lactate', value: 4.6 }); return ss; };
  const ref = mkRun([]); const v0 = lactateVerdict(ref), e0 = endWindowStats(ref), p0 = endOnlyProxy(ref), c0 = verdictZoneChange(z, ref);
  for (const [name, tail] of [['walk 4 min → stand 40 s', [{ until: 1900, hr: 100, tau: 60 }, { until: 2140, hr: 128, tau: 40 }, { until: 2180, hr: 98, tau: 55 }]], ['walk 4 min → stand 70 s', [{ until: 1900, hr: 100, tau: 60 }, { until: 2140, hr: 128, tau: 40 }, { until: 2210, hr: 98, tau: 55 }]], ['17-min walk', [{ until: 2820, hr: 118, tau: 50 }]], ['20-min walk', [{ until: 3000, hr: 118, tau: 50 }]]]) {
    const ss = mkRun(tail); const v = lactateVerdict(ss), e = endWindowStats(ss), px = endOnlyProxy(ss), ch = verdictZoneChange(z, ss);
    check(`above-MLSS run + ${name}: verdict, drift and zone proposal as when finished at the stop`, v && v.level === v0.level && v.level === 'high' && Math.abs(e.hr - e0.hr) < 1 && Math.abs(px.driftBpm - p0.driftBpm) < 1 && !!ch && !!c0 && ch.zones.lt2Speed === c0.zones.lt2Speed && ch.zones.lt2Speed === 10.5 && Math.abs(ch.zones.lt2Hr - c0.zones.lt2Hr) <= 1 && ch.zones.lt2Hr < 163,
      `${v ? v.level : 'no verdict'}, last-5-min HR ${e.hr.toFixed(0)} (ref ${e0.hr.toFixed(0)}), drift ${px.driftBpm.toFixed(1)} (ref ${p0.driftBpm.toFixed(1)}), zones ${ch ? ch.en : 'unchanged'}`);
    check(`  …and the sample taken 70 s after the stop is the END sample`, lactateChecks(ss).end === 4.6 && lactateChecks(ss).mid == null, JSON.stringify(lactateChecks(ss)));
  }
}
{ // a pace change that is not an end leaves the figures on the whole recording
  const ss = sched({ schedule: [{ until: 1440, hr: 150 }, { until: 1800, hr: 136 }] }); const e = endWindowStats(ss), m = sessionMetrics(ss);
  check('eased pace, no stop: last-5-min HR is that of the last 5 min (136), nothing cut', e.how === 'end' && Math.abs(e.hr - 136) < 1.5 && m.tailSec === 0, `${e.hr.toFixed(1)} bpm, how ${e.how}`);
}

// ---------- 4) LT2 sessions as the engine records them ----------
const quiet = { speak() {}, cue() {}, keepAwake: async () => true, beep() {}, vibrate() {} };
const engSettings = () => ({ protocol: {}, treadmill: {}, alpha1: { artifactMode: 'auto', windowSec: 120, stepSec: 5, lambda: 500 }, alerts: { zoneExitSec: 30 } });
class Strap { constructor() { this.T = T0; this.kind = 'ble'; this.status = 'connected'; this.h = {}; this.hr = 95; this.g = mkGauss(7); this.i = 0; }
  now() { return this.T; } on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); } off(ev, fn) { this.h[ev] = (this.h[ev] || []).filter(f => f !== fn); }
  beat(target, tau = 30) { this.T += 1000; this.i++; this.hr += (target - this.hr) * (1 - Math.exp(-1 / tau)); const hr = Math.round(this.hr + 1.2 * this.g()); const rr = 60000 / hr; (this.h.hr || []).forEach(fn => fn({ t: this.T, hr, rr: [rr * (1 + 0.02 * Math.sin(this.i * 1.3)), rr * (1 - 0.02 * Math.sin(this.i * 1.3))], contact: true })); } }
/** Runs an LT2 session through the real engine. hrOf(phase, secInPhase, rep) gives the heart-rate target; at: { sec: fn(eng, src) } are things the runner does. */
function recordLt2({ intervals, hrOf, totalSec, at = {}, speed = 10.5, mode = 'lt2', purpose = null }) {
  const src = new Strap(); const eng = new SessionEngine({ settings: engSettings(), alerts: quiet }); eng.setSource(src);
  eng.configure({ mode, intervals, targets: { hrLo: 154, hrHi: 160, alphaMin: null }, meta: { speed, incline: 1 } }); eng.start(); clearInterval(eng.timer);
  for (let sec = 1; sec <= totalSec; sec++) { const ph = eng.phase; const inPh = (src.T - eng.phaseStart) / 1000; const [target, tau] = hrOf(ph, inPh, eng.rep, sec); src.beat(target, tau); if (at[sec]) at[sec](eng, src); }
  const s = eng.stop('user'); return { ...s, final: true, id: 'eng' + totalSec + mode, ...(purpose ? { purpose } : {}) };
}
const I48 = { warmupSec: 600, reps: 4, workSec: 480, restSec: 180, cooldownSec: 360 }, I130 = { warmupSec: 600, reps: 1, workSec: 1800, restSec: 180, cooldownSec: 360 };
const steady = work => (ph, inPh) => ph === 'work' ? [typeof work === 'function' ? work(inPh) : work, 35] : ph === 'rest' ? [130, 45] : ph === 'warmup' ? [125, 40] : [122, 45];
const zLow = { lt1Hr: 140, lt1Speed: 8.4, lt2Hr: 150, lt2Speed: 10.0 }, zHigh = { lt1Hr: 140, lt1Speed: 8.4, lt2Hr: 165, lt2Speed: 11.5 };
{ // 4 × 8 min at LT2, 3-min easy between, lactate 3.8 a minute after the last rep (the session HANDOFF §4 prescribes)
  const workEnd = 600 + 4 * 480 + 3 * 180; // 3060 s
  const s = recordLt2({ intervals: I48, hrOf: steady(158), totalSec: workEnd + 360 + 20, at: { [workEnd + 60]: eng => eng.enterLactate(3.8) } });
  const b = workBout(s), e = endWindowStats(s), m = sessionMetrics(s), v = lactateVerdict(s), c = lactateChecks(s);
  check('4×8: four work bouts from the phase log; the run ends with the last rep', b.how === 'phase' && b.bouts === 4 && Math.abs((b.t0 - T0) / 1000 - 600) <= 2 && Math.abs((b.t1 - T0) / 1000 - workEnd) <= 2 && Math.abs(b.tailSec - 380) <= 3, `${b.bouts} bouts, ${mmss((b.t0 - T0) / 1000)}–${mmss((b.t1 - T0) / 1000)}, tail ${Math.round(b.tailSec)} s`);
  check('4×8: "last 5 min" = last 5 min of the last rep (158), not the cool-down', Math.abs(e.hr - 158) < 1.5 && e.bouts === 4 && e.how === 'phase', `${e.hr.toFixed(1)} bpm`);
  check('4×8: sample a minute into the cool-down is the END sample', c.end === 3.8 && c.mid == null && c.rest == null, JSON.stringify(c));
  check('4×8: no cardiac-drift figure across intervals', Number.isNaN(m.driftPct) && Number.isNaN(endOnlyProxy(s).driftBpm) && endOnlyProxy(s).single === false, `driftPct ${m.driftPct}, proxy ${endOnlyProxy(s).driftBpm}`);
  check('4×8, lactate 3.8: "on target for LT2 intervals", no MLSS call', v && v.kind === 'mlss' && v.intervals === true && v.level === 'ok' && /3–4\.5/.test(v.en) && !/MLSS \(proxy\)|Above MLSS|At\/below MLSS/.test(v.en), v ? v.en.slice(0, 90) : 'no verdict');
  check('4×8: no zone change offered, whatever the zones say', verdictZoneChange(zLow, s) === null && verdictZoneChange(zHigh, s) === null);
  check('4×8: not a point of the multi-day constant-speed curve', multiDayCurve([{ ...s, startedAt: Date.now() - 86400000, endedAt: Date.now() - 86400000 + (s.endedAt - s.startedAt), events: s.events.map(x => ({ ...x, t: x.t - s.startedAt + Date.now() - 86400000 })), hrLive: s.hrLive.map(p => [p[0] - s.startedAt + Date.now() - 86400000, p[1]]) }]).points.length === 0);
  const txt = claudeSummary({ session: s, metrics: m, zones: zLow }); check('4×8: the copied summary says intervals and gives no drift', /Intervals, 4 work bouts/.test(txt) && /not defined across intervals/.test(txt), (txt.match(/Intervals[^\n]{0,110}/) || [''])[0]);
  const up = recordLt2({ intervals: I48, hrOf: steady(158), totalSec: workEnd + 380, at: { [600 + 480 + 60]: eng => eng.enterLactate(2.9), [workEnd + 60]: eng => eng.enterLactate(4.6) } });
  const vu = lactateVerdict(up); check('4×8, 2.9 after rep 1 → 4.6 after rep 4: "rising across the reps", still no zone change', vu.level === 'high' && vu.intervals === true && lactateChecks(up).mid === 2.9 && verdictZoneChange(zHigh, up) === null, vu.en.slice(0, 80));
  for (const [val, level] of [[2.4, 'low'], [4.4, 'ok'], [5.2, 'near'], [6.8, 'high']]) { const x = { ...s, events: s.events.map(ev => ev.type === 'lactate' ? { ...ev, value: val } : ev) }; const vx = lactateVerdict(x); check(`4×8, lactate ${val} after the last rep → ${level}, zones untouched`, vx.level === level && verdictZoneChange(zLow, x) === null && verdictZoneChange(zHigh, x) === null, vx.en.slice(0, 70)); }
}
{ // LT2 mode used for the MLSS check: one 30-min rep after a 10-min warm-up (README), end sample only
  const rep = d => recordLt2({ intervals: I130, hrOf: steady(inPh => 154 + d * Math.max(0, inPh - 600) / 1200), totalSec: 600 + 1800 + 360 + 20, at: { [2400 + 60]: eng => eng.enterLactate(4.0) } });
  const s = rep(3); const b = workBout(s), e = endWindowStats(s), px = endOnlyProxy(s), v = lactateVerdict(s), m = sessionMetrics(s);
  check('1×30: one bout, 10:00–40:00', b.how === 'phase' && b.bouts === 1 && Math.abs((b.t0 - T0) / 1000 - 600) <= 2 && Math.abs((b.t1 - T0) / 1000 - 2400) <= 2, `${mmss((b.t0 - T0) / 1000)}–${mmss((b.t1 - T0) / 1000)}`);
  check('1×30: run time 30 min, drift measured inside the rep (+3), warm-up and cool-down left out', Math.abs(px.durMin - 30) < 0.2 && px.single && Math.abs(px.driftBpm - 2.6) < 1.2 && Math.abs(e.hr - 156.6) < 1.5, `${px.durMin.toFixed(1)} min, drift ${px.driftBpm.toFixed(1)} bpm, last-5-min HR ${e.hr.toFixed(1)}`);
  check('1×30, steady, end 4.0: "likely at/below MLSS (proxy)"', v && v.level === 'ok' && !v.intervals && /proxy/.test(v.en), v ? v.en.slice(0, 80) : 'none');
  const ch = verdictZoneChange(zLow, s); check('1×30 confirmed: LT2 floor raised to the rep\'s speed and heart rate', ch && ch.zones.lt2Speed === 10.5 && Math.abs(ch.zones.lt2Hr - 157) <= 1, ch ? ch.en : 'no change');
  check('1×30: cardiac drift % of the rep (small, positive), not warm-up → cool-down', Number.isFinite(m.driftPct) && m.driftPct > -0.5 && m.driftPct < 3, `${m.driftPct.toFixed(2)} %`);
  const hot = rep(11); const vh = lactateVerdict(hot); check('1×30 with +11 bpm drift inside the rep → "likely above MLSS (proxy)"', vh.level === 'high' && /HR drift/.test(vh.en) && Math.abs(endOnlyProxy(hot).driftBpm - 9.5) < 2, `${vh.en.slice(0, 70)} (drift ${endOnlyProxy(hot).driftBpm.toFixed(1)})`);
  const free = sched({ schedule: [{ until: 1800, hr: sec => 154 + 3 * Math.max(0, sec - 600) / 1200, tau: 35 }, { until: 1900, hr: 100, tau: 60 }], h0: 125 }); free.events.push({ t: T0 + 1860000, type: 'lactate', value: 4.0 });
  check('…the same rep run in Free mode gives the same call', lactateVerdict(free).level === v.level && Math.abs(endOnlyProxy(free).driftBpm - px.driftBpm) < 1.5, `Free ${endOnlyProxy(free).driftBpm.toFixed(1)} vs LT2 ${px.driftBpm.toFixed(1)} bpm`);
  const two = recordLt2({ intervals: I130, hrOf: steady(156), totalSec: 2780, at: { [540]: eng => eng.enterLactate(1.4), [600 + 630]: eng => eng.enterLactate(3.4), [2460]: eng => eng.enterLactate(4.0) } });
  const c2 = lactateChecks(two); check('1×30: warm-up sample = baseline, 10 min into the rep = "10-min", after the rep = end', c2.rest === 1.4 && c2.mid === 3.4 && c2.end === 4.0, JSON.stringify(c2));
  check('…and the rise 3.4 → 4.0 confirms MLSS', lactateVerdict(two).level === 'ok' && /rise 0\.6/.test(lactateVerdict(two).en), lactateVerdict(two).en.slice(0, 70));
  const warm = recordLt2({ intervals: I130, hrOf: steady(156), totalSec: 2780, at: { [540]: eng => eng.enterLactate(1.4), [2460]: eng => eng.enterLactate(4.0) } });
  check('1×30: a warm-up sample is never taken for the 10-min sample', lactateChecks(warm).mid == null && lactateChecks(warm).rest === 1.4 && !/rise/.test(lactateVerdict(warm).en), JSON.stringify(lactateChecks(warm)));
}
{ // LT2 rep set to 40 min, given up at 30 min; the runner stands for 100 s (sample) and presses Finish: still in the "work" block
  const s = recordLt2({ intervals: { ...I130, workSec: 2400 }, hrOf: (ph, inPh, rep, sec) => ph === 'warmup' ? [125, 40] : sec <= 2400 ? [157, 35] : [102, 60], totalSec: 2500, at: { [2470]: eng => eng.enterLactate(5.1) } });
  const b = workBout(s), e = endWindowStats(s);
  check('rep abandoned and Finish pressed inside it: its end comes from the heart-rate drop', b.how === 'phase' && b.bouts === 1 && Math.abs((b.t1 - T0) / 1000 - 2400) <= 20 && Math.abs(e.hr - 157) < 1.5 && lactateChecks(s).end === 5.1, `end ${mmss((b.t1 - T0) / 1000)}, last-5-min HR ${e.hr.toFixed(1)}`);
}
{ // a pause inside the last rep (shoelace): paused heart rate is not part of the last 5 min
  const s = recordLt2({ intervals: I130, hrOf: (ph, inPh, rep, sec) => ph !== 'work' ? [125, 40] : (sec > 2200 && sec <= 2290 ? [110, 40] : [157, 35]), totalSec: 600 + 1800 + 90 + 60, at: { [2200]: eng => eng.pauseToggle(), [2290]: eng => eng.pauseToggle() } });
  const e = endWindowStats(s), px = endOnlyProxy(s), b = workBout(s);
  check('pause of 90 s in the rep: the rep still lasts its 30 min of running', Math.abs(px.durMin - 30) < 0.2 && Math.abs((b.t1 - b.t0) / 1000 - 1890) <= 2, `${px.durMin.toFixed(2)} min of running, block ${mmss((b.t1 - b.t0) / 1000)} on the clock`);
  const naive = (() => { const v = s.hrLive.filter(p => p[0] >= b.t1 - 300000 && p[0] <= b.t1).map(p => p[1]); return v.reduce((x, y) => x + y, 0) / v.length; })();
  check('…and the paused heart rate (110) is not in the last-5-min mean: 5 min of RUNNING are averaged', e.hr > 150 && e.hr - naive > 4, `${e.hr.toFixed(1)} bpm (with the paused stretch it would be ${naive.toFixed(1)})`);
}

// ---------- 5) lactate samples: runs given up early, unfinished recordings, the 10-min belt stop ----------
{
  const giveUp = (runMin, tail) => { const ss = sched({ schedule: [{ until: 600, hr: 165 }, { until: 640, hr: 120, tau: 40 }, { until: runMin * 60, hr: sec => 168 + (sec - 640) / 60, tau: 30 }, { until: runMin * 60 + tail, hr: 105, tau: 60 }], extra: { speed: 11.5 } });
    ss.events.push({ t: T0 + 640000, type: 'lactate', value: 4.1 }, { t: T0 + (runMin * 60 + Math.min(75, tail - 5)) * 1000, type: 'lactate', value: 7.2 }); return ss; };
  for (const [runMin, tail] of [[12, 120], [14, 120], [15, 120], [16, 120], [18, 120], [14, 45]]) { const ss = giveUp(runMin, tail); const c = lactateChecks(ss), v = lactateVerdict(ss);
    check(`"10,30" run given up at ${runMin}:00 (${tail}-s tail): 10-min sample stays the 10-min sample, the last one is the end`, c.mid === 4.1 && c.end === 7.2 && v.level === 'high' && /rise 3\.1/.test(v.en), `${JSON.stringify(c)} → ${v.level}`); }
}
{ // the app was closed without Finish: the autosaved recording has no end time
  for (const tail of [0, 90]) { const ss = sched({ schedule: [{ until: 1800, hr: 156 }, ...(tail ? [{ until: 1800 + tail, hr: 100, tau: 60 }] : [])], extra: { final: false } }); ss.endedAt = null;
    ss.events.push({ t: T0 + 630000, type: 'lactate', value: 3.4 }, { t: T0 + (tail ? 1860 : 1795) * 1000, type: 'lactate', value: 3.9 }); const c = lactateChecks(ss);
    check(`unfinished recording (${tail}-s tail): 10-min and end samples keep their places`, c.mid === 3.4 && c.end === 3.9 && Math.abs(endWindowStats(ss).hr - 156) < 1.5, JSON.stringify(c)); }
  const none = { type: 'free', startedAt: T0, endedAt: null, hrLive: [], features: [], events: [] }; check('unfinished and empty: no crash, no samples', lactateChecks(none).end == null && Number.isNaN(endWindowStats(none).hr));
}
{ // two baseline samples (second finger) before the run: the second is not the "10-min" sample
  const ss = sched({ schedule: [{ until: 1800, hr: 156 }, { until: 1900, hr: 100, tau: 60 }] }); ss.events.push({ t: T0 + 30000, type: 'lactate', value: 1.2 }, { t: T0 + 75000, type: 'lactate', value: 1.0 }, { t: T0 + 1870000, type: 'lactate', value: 4.2 });
  const c = lactateChecks(ss), v = lactateVerdict(ss); check('two samples in the first minutes + one at the end: no "10-min" value is made up', c.rest === 1.2 && c.mid == null && c.end === 4.2 && !/rise/.test(v.en), `${JSON.stringify(c)} → ${v.en.slice(0, 60)}`);
  const two = sched({ schedule: [{ until: 1800, hr: 156 }, { until: 1960, hr: 100, tau: 60 }] }); two.events.push({ t: T0 + 1865000, type: 'lactate', value: 4.2 }, { t: T0 + 1930000, type: 'lactate', value: 4.4 });
  check('two samples after the stop (both fingers): the first is the end value, none becomes "10-min"', lactateChecks(two).end === 4.2 && lactateChecks(two).mid == null, JSON.stringify(lactateChecks(two)));
}
{ // belt stop for the 10-min sample (app paused, as HANDOFF recommends): the drift figure must not take the dip for a low baseline
  const run = sec => 154 + 3 * Math.max(0, sec - 600) / 1200; const ref = sched({ schedule: [{ until: 1800, hr: run }] }); const d0 = endOnlyProxy(ref).driftBpm;
  for (const stop of [45, 75, 100]) { const ss = sched({ schedule: [{ until: 600, hr: run }, { until: 600 + stop, hr: 105, tau: 55 }, { until: 1800 + stop, hr: x => run(x - stop) }, { until: 1900 + stop, hr: 100, tau: 60 }] });
    ss.events.push({ t: T0 + 600000, type: 'pause' }, { t: T0 + (600 + stop) * 1000, type: 'resume' }); ss.pauseMs = stop * 1000; const px = endOnlyProxy(ss); ss.events.push({ t: ss.endedAt - 20000, type: 'lactate', value: 4.2 }); const v = lactateVerdict(ss);
    check(`belt stop of ${stop} s at 10:00 (paused): drift as without the stop, run time 30 min, end-only verdict "ok"`, Math.abs(px.driftBpm - d0) < 2 && Math.abs(px.durMin - 30) < 0.3 && v.level === 'ok', `drift ${px.driftBpm.toFixed(1)} (ref ${d0.toFixed(1)}) bpm, ${px.durMin.toFixed(1)} min → ${v.level}`);
    const np = { ...ss, events: ss.events.filter(ev => ev.type === 'lactate'), pauseMs: 0 }; const pn = endOnlyProxy(np);
    check(`  …also when the app was NOT paused during the stop`, Math.abs(pn.driftBpm - d0) < 2.5 && lactateVerdict(np).level === 'ok', `drift ${pn.driftBpm.toFixed(1)} bpm → ${lactateVerdict(np).level}`); }
  const long = sched({ schedule: [{ until: 600, hr: run }, { until: 730, hr: 105, tau: 55 }, { until: 1930, hr: x => run(x - 130) }, { until: 2030, hr: 100, tau: 60 }] }); long.events.push({ t: long.endedAt - 20000, type: 'lactate', value: 4.2 });
  check('unpaused stop of 130 s at 10:00 (strip trouble): still no false "above MLSS"', Math.abs(endOnlyProxy(long).driftBpm - d0) < 2.5 && lactateVerdict(long).level === 'ok', `drift ${endOnlyProxy(long).driftBpm.toFixed(1)} bpm → ${lactateVerdict(long).level}`);
  check('a run without any stop: the drift figure is the plain difference of the two window means', (() => { const h = ref.hrLive; const m = (x, y) => { const v = h.filter(p => p[0] >= T0 + x * 1000 && p[0] < T0 + y * 1000 + (y === 1800 ? 1 : 0)).map(p => p[1]); return v.reduce((q, w) => q + w, 0) / v.length; }; return Math.abs(d0 - (m(1500, 1800) - m(480, 780))) < 1e-9; })(), d0.toFixed(3));
}

// ---------- 6) results are remembered per session, never across different recordings ----------
{
  const a = { ...mk({ tailSec: 120 }), id: 'same-id' }, b = { ...mk({ tailSec: 0 }), id: 'same-id' };
  const ea = exerciseEnd(a), eb = exerciseEnd(b), again = exerciseEnd({ ...a, hrLive: a.hrLive.slice() });
  check('same id, different recording → worked out afresh', ea.how === 'hr' && eb.how === 'end' && eb.t === b.endedAt, `${ea.how} / ${eb.how}`);
  check('same session read again from storage (new objects) → same answer', again.how === 'hr' && again.t === ea.t && again.tailSec === ea.tailSec);
  const grown = { ...a, id: 'grows', endedAt: null, hrLive: a.hrLive.filter(p => p[0] <= a._stop) }; const g1 = exerciseEnd(grown); const g2 = exerciseEnd({ ...grown, hrLive: a.hrLive });
  check('an unfinished recording that has grown is looked at again', g1.how === 'end' && g2.how === 'hr' && Math.abs(g2.t - a._stop) <= 20000, `${g1.how} → ${g2.how}`);
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS'); process.exit(failures ? 1 : 0);

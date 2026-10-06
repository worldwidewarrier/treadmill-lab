import { lactateChecks, lactateVerdict, multiDayCurve, endWindowStats } from '../js/prescribe.js';
import { SessionEngine } from '../js/session.js';
import { DemoSource, demoProfileForEngine } from '../js/sources.js';
let failures = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) failures++; };
const now = Date.now();
// (the engine logs the phase at the start; an LT2 record without a phase log is never taken for one steady run)
const mk = (type, speed, { rest = null, mid = null, end = null, hr = 140, daysAgo = 1, dur = 1800 } = {}) => {
  const t0 = now - daysAgo * 86400000; const hrLive = []; for (let i = 0; i < dur; i++) hrLive.push([t0 + i * 1000, hr]);
  const events = [{ t: t0, type: 'phase', phase: 'work' }]; if (rest != null) events.push({ t: t0 + 30000, type: 'lactate', value: rest }); if (mid != null) events.push({ t: t0 + 600000, type: 'lactate', value: mid }); if (end != null) events.push({ t: t0 + dur * 1000 - 60000, type: 'lactate', value: end });
  return { id: type + speed + daysAgo, type, final: true, startedAt: t0, endedAt: t0 + dur * 1000, speed, incline: 1, hrLive, features: [], events };
};
// checks from events by timing
const c = lactateChecks(mk('lt1', 9, { rest: 1.1, mid: 1.6, end: 1.8 }));
check('events placed into rest/mid/end', c.rest === 1.1 && c.mid === 1.6 && c.end === 1.8, JSON.stringify(c));
check('explicit lactateChecks override', lactateChecks({ ...mk('lt1', 9, { end: 3 }), lactateChecks: { end: 1.5 } }).end === 1.5);
// LT1 verdicts
check('LT1 end 1.8 → ok', lactateVerdict(mk('lt1', 9, { rest: 1.0, end: 1.8 })).level === 'ok');
check('LT1 end 2.3 → near (−2)', (() => { const v = lactateVerdict(mk('lt1', 9.5, { end: 2.3 })); return v.level === 'near' && v.adjust.lt1Hr === -2; })());
check('LT1 end 3.1 → high (−4)', (() => { const v = lactateVerdict(mk('lt1', 10, { end: 3.1 })); return v.level === 'high' && v.adjust.lt1Hr === -4; })());
// LT2 / MLSS verdicts
check('LT2 Δ 0.6 → ok (+0.3)', (() => { const v = lactateVerdict(mk('lt2', 12, { mid: 3.4, end: 4.0 })); return v.level === 'ok' && v.adjust.lt2Speed === 0.3; })());
check('LT2 Δ 1.8 → high (−0.4)', (() => { const v = lactateVerdict(mk('lt2', 12.5, { mid: 3.8, end: 5.6 })); return v.level === 'high' && v.adjust.lt2Speed === -0.4; })());
check('LT2 end-only 6.5 → high', lactateVerdict(mk('lt2', 13, { end: 6.5 })).level === 'high');
check('no end sample → null', lactateVerdict(mk('lt1', 9, { rest: 1.0 })) === null);
{ // the app was closed without Finish: the autosaved copy has no end time — its end is the last heart beat
  const u = mk('free', 10.5, { mid: 3.4, end: 3.9 }); u.endedAt = null; u.final = false; const cu = lactateChecks(u);
  check('unfinished recording: the 10-min sample is not taken for the end sample', cu.mid === 3.4 && cu.end === 3.9, JSON.stringify(cu));
  check('unfinished recording without heart rate: no crash', lactateChecks({ type: 'free', startedAt: now, endedAt: null, hrLive: [], events: [{ t: now + 1000, type: 'lactate', value: 1.2 }] }).rest === 1.2);
}
// multi-day curve
const sessions = [mk('lt1', 8, { end: 1.1, hr: 128, daysAgo: 9 }), mk('lt1', 9, { end: 1.3, hr: 137, daysAgo: 7 }), mk('lt1', 10, { end: 1.8, hr: 146, daysAgo: 5 }), mk('lt2', 11, { end: 2.7, hr: 154, daysAgo: 3 }), mk('lt2', 12, { end: 4.2, hr: 162, daysAgo: 1 }), mk('lt2', 12, { end: 4.6, hr: 163, daysAgo: 10 }), mk('test', 7, { end: 1 })];
const md = multiDayCurve(sessions);
check('multi-day keeps newest per speed, excludes tests', md.points.length === 5 && md.points.find(p => p.x === 12).la === 4.2, JSON.stringify(md.points.map(p => [p.x, p.la])));
check('multi-day thresholds computed', md.analysis && Number.isFinite(md.analysis.lt1Primary.hr) && Number.isFinite(md.analysis.lt2Primary.hr), `LT1 ${md.analysis?.lt1Primary.x?.toFixed(1)} km/h ${md.analysis?.lt1Primary.hr?.toFixed(0)} bpm · LT2 ${md.analysis?.lt2Primary.x?.toFixed(1)} km/h ${md.analysis?.lt2Primary.hr?.toFixed(0)} bpm · grade ${md.grade}`);
check('grade B with 5 points spanning ≥2 mmol', md.grade === 'B');
check('endWindowStats HR', Math.abs(endWindowStats(sessions[0]).hr - 128) < 0.01);
// continuous test (pauseSec = 0): no lactate prompts, stages chain directly
const settings = { protocol: { warmupSec: 30, stageSec: 60, pauseSec: 0, startSpeed: 8, speedStep: 1, incline: 1, type: 'speed', stopLactate: 6, stopRpe: 17, warmupSpeed: 5.5, maxStages: 4 }, treadmill: {}, alpha1: { artifactMode: 'auto', windowSec: 120, stepSec: 5, lambda: 500 }, alerts: {} };
let prompts = 0; const engine = new SessionEngine({ settings, alerts: { speak() {}, cue() {}, keepAwake: async () => true }, onEvent: e => { if (e.type === 'lactate-prompt') prompts++; } });
engine.configure({ mode: 'test', meta: null }); const src = new DemoSource({ speed: 120, profile: demoProfileForEngine(engine) }); engine.setSource(src); await src.connect(); engine.start();
await new Promise(r => { const h = setInterval(() => { if (engine.phase === 'done' || engine.stages.length >= 4 && engine.phase !== 'work') { clearInterval(h); r(); } }, 100); setTimeout(() => { clearInterval(h); r(); }, 20000); });
const sess = engine.stop(); await src.disconnect();
check('continuous test: 4 stages, zero prompts, no pause phases', sess.stages.length === 4 && prompts === 0 && !sess.events.some(e => e.phase === 'pause'), `stages ${sess.stages.length} prompts ${prompts}`);
check('continuous test: stages contiguous', sess.stages.slice(1).every((st, i) => st.tStart === sess.stages[i].tEnd));

// ---- end-only MLSS proxy (no 10-min sample) ----
{
  const { lactateVerdict } = await import('../js/prescribe.js');
  const mk = (durMin, drift, end, extra = {}) => { const t0 = Date.UTC(2026, 9, 7, 0, 0, 0); const hr = []; for (let s = 0; s < durMin * 60; s += 5) hr.push([t0 + s * 1000, Math.round(150 + (s > 600 ? drift * Math.min(1, (s - 600) / (durMin * 60 - 600)) : 0))]); return { type: 'free', speed: 10.5, startedAt: t0, endedAt: t0 + durMin * 60000, hrLive: hr, features: [], events: [{ t: t0 + durMin * 60000 - 20000, type: 'lactate', value: end }, ...(extra.rpe ? [{ t: t0 + durMin * 60000 - 10000, type: 'rpe', value: extra.rpe }] : [])] }; };
  check('proxy: 30 min, drift +4, end 4.0 → ok (+0.3)', lactateVerdict(mk(30, 4, 4.0)).level === 'ok' && lactateVerdict(mk(30, 4, 4.0)).adjust.lt2Speed === 0.3);
  check('proxy: 30 min, drift +11, end 4.5 → high', lactateVerdict(mk(30, 11, 4.5)).level === 'high');
  check('proxy: 30 min, drift +8.5 (≈7 measured), end 4.0 → near', lactateVerdict(mk(30, 8.5, 4.0)).level === 'near');
  check('proxy: 20 min, end 4.0 → near (withheld)', lactateVerdict(mk(20, 2, 4.0)).level === 'near');
  check('proxy: RPE 19 → high even with flat HR', lactateVerdict(mk(30, 2, 4.0, { rpe: 19 })).level === 'high');
  check('end < 3 with purpose mlss → low', lactateVerdict({ ...mk(30, 2, 2.4), purpose: 'mlss' }).level === 'low');
  check('purpose lt1 forces LT1 rules even when end ≥ 3', lactateVerdict({ ...mk(30, 2, 3.2), purpose: 'lt1' }).level === 'high');
  check('end ≥ 6 still high', lactateVerdict(mk(30, 2, 6.5)).level === 'high');
}

// ---- verdictZoneChange: floors on confirmed runs, caps on failed runs ----
{
  const { verdictZoneChange } = await import('../js/prescribe.js');
  const run = (speed, endHr, end, extra = {}) => { const t0 = Date.UTC(2026, 9, 7); const hr = []; for (let s = 0; s < 1800; s += 5) hr.push([t0 + s * 1000, endHr]); return { type: 'free', speed, startedAt: t0, endedAt: t0 + 1800000, hrLive: hr, features: [], events: [{ t: t0 + 1780000, type: 'lactate', value: end }], ...extra }; };
  const z = { lt1Hr: 140, lt1Speed: 8.4, lt2Hr: 157, lt2Speed: 10.5 };
  const a = verdictZoneChange(z, run(10.5, 158, 4.0, { purpose: 'mlss' }));
  check('MLSS ok at 10.5/158 → LT2 HR floor 157→158, speed unchanged', a && a.zones.lt2Hr === 158 && a.zones.lt2Speed === 10.5 && !a.keys.includes('lt2Speed'), JSON.stringify(a?.keys));
  const b = verdictZoneChange(z, run(11.0, 163, 4.5, { purpose: 'mlss' }));
  check('MLSS ok at 11.0/163 → LT2 11.0 km/h, 163 bpm', b && b.zones.lt2Speed === 11 && b.zones.lt2Hr === 163);
  const hrs = []; const t0 = Date.UTC(2026, 9, 7); for (let s = 0; s < 1800; s += 5) hrs.push([t0 + s * 1000, 150 + (s > 600 ? 12 * (s - 600) / 1200 : 0)]);
  const c = verdictZoneChange(z, { ...run(10.5, 160, 5.0, { purpose: 'mlss' }), hrLive: hrs });
  check('MLSS high (drift +12) at 10.5 → LT2 cap 10.2 km/h, HR ≤ end−3', c && c.zones.lt2Speed === 10.2 && c.zones.lt2Hr <= 158, JSON.stringify(c?.zones));
  const d = verdictZoneChange(z, run(8.0, 136, 0.5));
  check('LT1 ok at 8.0/136 below current estimate → no change', d === null);
  const e = verdictZoneChange(z, run(8.5, 141, 1.6));
  check('LT1 ok at 8.5/141 → LT1 floor 8.5 km/h / 141 bpm', e && e.zones.lt1Speed === 8.5 && e.zones.lt1Hr === 141);
  const f = verdictZoneChange(z, run(9.0, 146, 2.8));
  check('LT1 high at 9.0/146 → cap 8.5 / 141 → no change vs 8.4/140', f === null, JSON.stringify(f?.zones));
  const g = verdictZoneChange({ lt1Hr: 146, lt1Speed: 9.0, lt2Hr: 160, lt2Speed: 11 }, run(9.0, 146, 2.8));
  check('LT1 high at 9.0/146 with zones at 9.0/146 → cap to 8.5 / 141', g && g.zones.lt1Speed === 8.5 && g.zones.lt1Hr === 141);
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS'); process.exit(failures ? 1 : 0);

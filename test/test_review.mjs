// node test/test_review.mjs — the rules of the Oct 17 review (v1.1.35), engine and verdict level: the ladder's heart-rate ceiling drifts
// after minute 10 of a rep and the cue is "RPE decides", not "slow down"; no cue in the first 4 min of a rep; the VO₂max session has its
// own band, cue and verdict; the step test ends by the same rule every time (lactate 6 is a floor); the MLSS lactate sets the ladder's
// window; two MLSS passes raise the speed; a structure's kind never leaks into the next session.
import { SessionEngine, DEFAULT_PROTOCOL } from '../js/session.js';
import { sessionTargets, computeZones, lactateVerdict, setMlssLactate, ladderLactateWindow, mlssPasses, lt2Structure, VO2_STRUCTURE } from '../js/prescribe.js';
import { VOICE } from '../js/i18n.js';
let failures = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) failures++; };
const spoken = []; const alerts = { speak(t) { spoken.push(t); }, cue(t) { spoken.push(t); }, keepAwake: async () => true, beep() {}, vibrate() {} };
const settings = { protocol: { ...DEFAULT_PROTOCOL, warmupSec: 0, stageSec: 60, pauseSec: 10, startSpeed: 8, speedStep: 1, maxStages: 8 }, treadmill: {}, alpha1: { artifactMode: 'auto', windowSec: 120, stepSec: 5, lambda: 500, guidance: 'off' }, alerts: { zoneExitSec: 30 } };
class ClockSource {
  constructor() { this.T = 1_700_000_000_000; this.kind = 'clock'; this.status = 'connected'; this.h = {}; }
  now() { return this.T; } on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); } off(ev, fn) { this.h[ev] = (this.h[ev] || []).filter(f => f !== fn); }
  run(sec, hr = 140) { for (let i = 0; i < sec; i++) { this.T += 1000; const rr = 60000 / hr; (this.h.hr || []).forEach(fn => fn({ t: this.T, hr, rr: [rr, rr], contact: true })); } }
}
const boot = cfg => { const src = new ClockSource(); const eng = new SessionEngine({ settings, alerts }); eng.setSource(src); eng.configure(cfg); eng.start(); clearInterval(eng.timer); spoken.length = 0; return { src, eng }; };
const zones = computeZones({ lt1Hr: 143, lt2Hr: 157, lt1Speed: 8.7, lt2Speed: 10.5, maxHr: 188, pace3k: 14.1, mlssLactate: null });

// ---- the ladder's ceiling: grace, drift, the RPE cue ----
{
  const T = sessionTargets(zones, 'lt2'); // 154–160, ceiling 160 → +1 per 2 min after 10:00 of a rep
  const { src, eng } = boot({ mode: 'lt2', intervals: { warmupSec: 0, reps: 2, workSec: 1200, restSec: 180, cooldownSec: 60 }, targets: T });
  src.run(230, 170); check('first 4 min of a rep: 170 bpm above the band gives no cue and the zone shows "waiting"', !spoken.some(t => /심박/.test(t)) && eng.zoneState === 'waiting', spoken.join(' | '));
  src.run(70, 170); check('from minute 4: 60 s above the ceiling → the ladder cue (RPE decides), not "slow down"', spoken.includes(VOICE.lt2_ceiling()) && !spoken.includes(VOICE.zone_high()), spoken.join(' | '));
  spoken.length = 0; src.run(300, 158); check('inside the band: nothing', spoken.length === 0 && eng.zoneState === 'in');
  src.run(200, 163); // minute 10:00 → 13:20 at 163: ceiling at 13:20 = 160 + floor(200/120) = 161 → still above
  check('at 163 bpm just after minute 10 the ceiling (161) is still exceeded', eng.zoneState === 'above', eng.zoneState);
  spoken.length = 0; src.run(360, 163); // → 19:20: ceiling 160 + floor(560/120) = 164 → 163 is under it: drift, not above
  check('by minute 19 the ceiling has drifted to 164: 163 bpm is "drift" (shown, not cued)', eng.zoneState === 'drift', eng.zoneState);
  eng.stop('test');
}
// ---- VO₂max reps: the band 90–95 %, 2:30 of grace, its own cue, its own verdict ----
{
  const TV = sessionTargets(zones, 'vo2'); check('VO₂max targets at HRmax 188: 169–179, grace 150 s, speed 13.0', TV.hrLo === 169 && TV.hrHi === 179 && TV.repGraceSec === 150 && TV.speedHi === 13 && TV.kind === 'vo2', JSON.stringify(TV));
  const { src, eng } = boot({ mode: 'lt2', intervals: { ...VO2_STRUCTURE, warmupSec: 0, cooldownSec: 60 }, targets: TV });
  src.run(140, 150); check('rising in the first 2:30: no "low" cue', !spoken.some(t => /심박 낮음/.test(t)) && eng.zoneState === 'waiting', spoken.join(' | '));
  src.run(100, 183); check('above 95 % for 60 s: the VO₂max cue (hold the speed), not the ladder cue', spoken.includes(VOICE.vo2_high()) && !spoken.includes(VOICE.lt2_ceiling()) && !spoken.includes(VOICE.zone_high()), spoken.join(' | '));
  const s = eng.stop('test');
  check('the session keeps the kind of its structure', s.intervals.kind === 'vo2' && s.intervals.reps === 4 && s.intervals.workSec === 240);
  const sv = { ...s, type: 'lt2', speed: 13, final: true, events: [...s.events, { t: s.endedAt + 30000, type: 'lactate', value: 7.8, phase: 'done' }] };
  const vd = lactateVerdict(sv); check('a VO₂max session with lactate 7.8 after the reps: recorded, not judged against the ladder window', vd && vd.vo2 === true && vd.level === 'ok' && /no target/.test(vd.en), vd && vd.en);
  // a ladder structure configured after a VO₂max one: the kind does not leak
  const e2 = new SessionEngine({ settings, alerts }); e2.configure({ mode: 'lt2', intervals: { ...VO2_STRUCTURE } }); e2.configure({ mode: 'lt2', intervals: { reps: 4, workSec: 480, restSec: 180, warmupSec: 600, cooldownSec: 360 } });
  check('configure() builds the intervals on the defaults: no kind from the previous session leaks', e2.intervals.kind === undefined && e2.intervals.reps === 4 && e2.intervals.workSec === 480, JSON.stringify(e2.intervals));
}
// ---- step test: lactate 6 is a floor; the end point is two stages past the 4-mmol point or the heart-rate criterion ----
{
  const { src, eng } = boot({ mode: 'test', meta: { stopHr: 179 } });
  const stage = la => { src.run(60, 150); eng.enterLactate(la); src.run(10, 150); };
  stage(1.0); stage(1.5); stage(2.4); stage(4.2); // stage 4 = the first ≥ 4.0
  check('stages up to the first 4-mmol point: no stop', eng.stopAdvised === false && eng.stages.length === 5);
  stage(6.4); check('lactate 6.4 one stage past the 4-mmol point: not the end yet — the voice says one more stage', eng.stopAdvised === false && spoken.some(t => /젖산 6 이상/.test(t) && /1단계 더/.test(t)), spoken.filter(t => /젖산/.test(t)).join(' | '));
  stage(8.0); check('the second stage past the 4-mmol point at ≥ 6.0: the stop criterion', eng.stopAdvised === true && spoken.includes(VOICE.stop_criteria()));
  eng.stop('test');
  const { src: s2, eng: e2 } = boot({ mode: 'test', meta: { stopHr: 179 } });
  s2.run(60, 150); e2.enterLactate(2.0); s2.run(10, 150); s2.run(35, 185); check('the heart-rate criterion (≥ stopHr for 30 s) ends the test on its own', e2.stopAdvised === true);
  e2.stop('test');
  check('DEFAULT_PROTOCOL carries minStagesPast4 = 2', DEFAULT_PROTOCOL.minStagesPast4 === 2);
}
// ---- the MLSS lactate and the ladder window; two passes ----
{
  setMlssLactate(null); check('no MLSS lactate: the ladder window is 3.0–4.5 (population default)', JSON.stringify(ladderLactateWindow()) === JSON.stringify({ lo: 3, hi: 4.5, own: false }));
  setMlssLactate(2.8); const W = ladderLactateWindow(); check('MLSS lactate 2.8 → window 2.3–3.3 (own)', W.lo === 2.3 && W.hi === 3.3 && W.own === true);
  const now = Date.now();
  const inter = end => { const t0 = now - 86400000; const hr = []; for (let i = 0; i < 2400; i++) hr.push([t0 + i * 1000, 158]); const ev = [{ t: t0, type: 'phase', phase: 'work', rep: 1 }, { t: t0 + 600000, type: 'phase', phase: 'rest', rep: 1 }, { t: t0 + 780000, type: 'phase', phase: 'work', rep: 2 }, { t: t0 + 1380000, type: 'phase', phase: 'rest', rep: 2 }, { t: t0 + 1560000, type: 'phase', phase: 'work', rep: 3 }, { t: t0 + 2160000, type: 'phase', phase: 'cooldown', rep: 3 }, { t: t0 + 2200000, type: 'lactate', value: end }]; return { id: 'i' + end, type: 'lt2', final: true, startedAt: t0, endedAt: t0 + 2400000, speed: 10.5, incline: 1, hrLive: hr, features: [], events: ev, intervals: { kind: 'ladder', reps: 3, workSec: 600, restSec: 180 } }; };
  const lv = end => lactateVerdict(inter(end));
  check('with the own window 2.3–3.3: 2.0 low · 3.0 on target · 3.6 above (−0.3) · 4.8 high (≥ hi + 1.5)', lv(2.0).level === 'low' && lv(3.0).level === 'ok' && lv(3.6).level === 'near' && lv(4.8).level === 'high' && /your MLSS lactate ± 0\.5 \(2\.3–3\.3\)/.test(lv(3.0).en), [2.0, 3.0, 3.6, 4.8].map(e => lv(e).level).join());
  setMlssLactate(null); check('back to the default: 3.0 on target, 2.9 low, 6.0 high', lv(3.0).level === 'ok' && lv(2.9).level === 'low' && lv(6.0).level === 'high');
  // MLSS checks: pass, pass → raise
  const mlss = (daysAgo, mid, end, speed = 10.5) => { const t0 = now - daysAgo * 86400000; const hr = []; for (let i = 0; i < 1800; i++) hr.push([t0 + i * 1000, 157]); return { id: 'm' + daysAgo, type: 'free', purpose: 'mlss', final: true, startedAt: t0, endedAt: t0 + 1800000, speed, incline: 1, hrLive: hr, features: [], events: [{ t: t0, type: 'phase', phase: 'work' }, { t: t0 + 600000, type: 'lactate', value: mid }, { t: t0 + 1790000, type: 'lactate', value: end }] }; };
  const one = mlssPasses([mlss(14, 3.4, 3.8)], 10.5); check('one pass at 10.5: 1/2, next check at the same speed, the MLSS lactate 3.8 offered', one.passes === 1 && one.nextSpeed === 10.5 && one.last.mlssLa === 3.8 && /1\/2/.test(one.en), one.en);
  const two = mlssPasses([mlss(14, 3.4, 3.8), mlss(7, 3.5, 3.9)], 10.5); check('two passes at 10.5: 2/2 → next 10.8', two.passes === 2 && two.nextSpeed === 10.8 && /next check at 10\.8/.test(two.en), two.en);
  const broken = mlssPasses([mlss(14, 3.4, 3.8), mlss(7, 3.0, 4.4)], 10.5); check('a fail after a pass: the count restarts (0/2)', broken.passes === 0 && broken.nextSpeed === 10.5 && broken.last.level === 'high', broken.en);
  const other = mlssPasses([mlss(14, 3.4, 3.8), mlss(7, 3.5, 3.9, 10.8)], 10.5); check('a pass at another speed does not count for 10.5', other.passes === 0, other.en);
}
// ---- structures ----
{
  check('lt2Structure: hard week 2 is the VO₂max structure (frozen template copied), week 1 the 4×8 ladder step', lt2Structure(2).kind === 'vo2' && lt2Structure(2) !== VO2_STRUCTURE && lt2Structure(1).kind === 'ladder' && lt2Structure(1).step === 1);
  check('the ladder steps 9 (3×15) and 13 (1×30) carry speedOffset −0.3; step 1 none', lt2Structure(9).speedOffset === -0.3 && lt2Structure(13).speedOffset === -0.3 && lt2Structure(1).speedOffset === 0);
  const T = sessionTargets(zones, 'lt2', { speedOffset: -0.3 }); check('the offset reaches the targets: 10.2 km/h for a long rep', T.speedHi === 10.2 && T.speedLo === 9.9);
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS'); process.exit(failures ? 1 : 0);

// Zones, weekly plan, progression, auto-adjustments, lactate verification runs and rule-based summaries (KO/EN).
import { analyzeLactate, interp } from './lactate.js';
import { list, smo2Steady, runTimeline, inStop, alphaTainted, runWindowStart, runWindowEnd, stoppedMs, alphaOn, ALPHA_ARTIFACT_MAX, summarizeStages } from './analysis.js';
const r1 = v => Math.round(v * 10) / 10;
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
/** Resting lactate measured on its own (Settings): used by the LT1 verdict when a session has no rest value of its own. */
let REST_BASELINE = null;
/** Lowest lactate of the latest step test (the "lowest" of the two-lap rule: lap 1 must be ≤ lowest + 0.5); null = use the resting baseline. */
let TEST_LOWEST = null;
/** Running time (min) above which a constant run is a long run: judged for durability, not for LT1 (see verdictCore, multiDayCurve). */
export const LONG_RUN_MIN = 45;
/** Minutes at speed beyond which a lactate value is a durability reading, never a point of the multi-day curve (v1.1.17). */
export const CURVE_MAX_MIN = 35;
/** Minutes of running a single constant run needs to be a point of the curve (its heart rate is read in minutes 8–13). */
export const CURVE_MIN_MIN = 15;
/** The two-lap rule (v1.1.17): the gap between the laps beyond which only a rise ≤ STRICT_RISE passes (lactate clears while standing). */
export const GAP_STRICT_SEC = 180, PASS_RISE = 0.5, STRICT_RISE = 0.3, FAIL_RISE = 1.0, END_MAX = 2.5, LINE_DELTA = 0.5, NEAR_LINE = 0.2;
export function setRestBaseline(v) { REST_BASELINE = Number.isFinite(v) && v >= 0.3 && v <= 4 ? v : null; }
export function setTestLowest(v) { TEST_LOWEST = Number.isFinite(v) && v >= 0.3 && v <= 4 ? v : null; }
/**
 * Lactate measured at the end of a passed/held MLSS check (Settings → thresholds, v1.1.35): the ladder's end-sample target is this value ± 0.5.
 * Lactate at MLSS ranges 1.9–7.5 mmol/L between people (Beneke 2000), so the old population window 3.0–4.5 only applies until it is known.
 */
let MLSS_LACTATE = null;
export function setMlssLactate(v) { MLSS_LACTATE = Number.isFinite(v) && v >= 1 && v <= 10 ? v : null; }
export function mlssLactate() { return MLSS_LACTATE; }
/** The ladder's lactate window: own MLSS lactate ± 0.5 when known, else 3.0–4.5. */
export function ladderLactateWindow() { return MLSS_LACTATE != null ? { lo: r1(MLSS_LACTATE - 0.5), hi: r1(MLSS_LACTATE + 0.5), own: true } : { lo: 3.0, hi: 4.5, own: false }; }
/** The line of the two-lap rule: lowest + 0.5, "lowest" = lowest in-test lactate of the latest step test, else the resting baseline. */
export function lactateFloor() { return TEST_LOWEST != null ? { lowest: TEST_LOWEST, from: 'test' } : REST_BASELINE != null ? { lowest: REST_BASELINE, from: 'baseline' } : null; }
/** Lowest lactate of the exercise stages of a step test (the warm-up and a value logged before stage 1 do not count). */
export function testLowest(session) {
  const v = list(session && session.stages).map(s => s && s.lactate).filter(x => Number.isFinite(x) && x >= 0.3);
  return v.length >= 2 ? Math.min(...v) : null;
}
/** Do the samples [[t, …], …] span at least `ms`? */
const covers = (pts, ms) => { let a = Infinity, b = -Infinity; for (const p of pts) { if (p[0] < a) a = p[0]; if (p[0] > b) b = p[0]; } return b - a >= ms; };
/** Length of the α1 window the session was recorded with: an α1 value stamped t is made of the beats of [t − window, t]. */
const alphaWindowMs = session => ((session.alpha1Settings && Number(session.alpha1Settings.windowSec)) || 120) * 1000;

/** Training zones from LT1/LT2 (HR and treadmill speed at the test incline). */
export function computeZones(z) {
  const { lt1Hr, lt2Hr, lt1Speed, lt2Speed, maxHr } = z;
  if (!Number.isFinite(lt1Hr) || !Number.isFinite(lt2Hr)) return null;
  const sp = (hr) => { // map HR → speed linearly between LT1 and LT2 (and extrapolate gently)
    if (!Number.isFinite(lt1Speed) || !Number.isFinite(lt2Speed) || lt2Hr === lt1Hr) return NaN;
    return r1(lt1Speed + (hr - lt1Hr) * (lt2Speed - lt1Speed) / (lt2Hr - lt1Hr));
  };
  const three = [
    { id: 'Z1', ko: '존1 · LT1 아래 (저강도)', en: 'Zone 1 · below LT1 (low)', hrLo: 0, hrHi: Math.round(lt1Hr), speedLo: NaN, speedHi: lt1Speed },
    { id: 'Z2', ko: '존2 · LT1–LT2 (중강도)', en: 'Zone 2 · LT1–LT2 (moderate)', hrLo: Math.round(lt1Hr) + 1, hrHi: Math.round(lt2Hr), speedLo: lt1Speed, speedHi: lt2Speed },
    { id: 'Z3', ko: '존3 · LT2 위 (고강도)', en: 'Zone 3 · above LT2 (high)', hrLo: Math.round(lt2Hr) + 1, hrHi: maxHr || 220, speedLo: lt2Speed, speedHi: NaN },
  ];
  const five = [
    { id: 'Z1', ko: '회복', en: 'Recovery', hrLo: 0, hrHi: Math.round(lt1Hr - 15), speedHi: sp(lt1Hr - 15) },
    { id: 'Z2', ko: '유산소 기반 (LT1 세션)', en: 'Aerobic base (LT1 session)', hrLo: Math.round(lt1Hr - 14), hrHi: Math.round(lt1Hr), speedLo: sp(lt1Hr - 14), speedHi: lt1Speed },
    { id: 'Z3', ko: '템포', en: 'Tempo', hrLo: Math.round(lt1Hr) + 1, hrHi: Math.round(lt2Hr - 5), speedLo: lt1Speed, speedHi: sp(lt2Hr - 5) },
    { id: 'Z4', ko: '역치 (LT2 세션)', en: 'Threshold (LT2 session)', hrLo: Math.round(lt2Hr - 4), hrHi: Math.round(lt2Hr + 3), speedLo: sp(lt2Hr - 4), speedHi: sp(lt2Hr + 3) },
    { id: 'Z5', ko: 'VO₂max', en: 'VO₂max', hrLo: Math.round(lt2Hr + 4), hrHi: maxHr || 220, speedLo: sp(lt2Hr + 4) },
  ];
  // pass-through of the athlete's other numbers (v1.1.35): the 3-km pace (strides, the 4×4 speed) and the lactate measured at MLSS (the ladder's target ± 0.5)
  return { three, five, lt1Hr, lt2Hr, lt1Speed, lt2Speed, maxHr, pace3k: Number.isFinite(z.pace3k) ? z.pace3k : null, mlssLactate: Number.isFinite(z.mlssLactate) ? z.mlssLactate : null, testLt1Speed: Number.isFinite(z.testLt1Speed) ? z.testLt1Speed : null };
}

/** Seconds into a ladder rep after which its heart-rate ceiling rises (v1.1.35): +1 bpm per LT2_LATE_STEP_SEC — the drift of a steady state (+12.6 bpm over 50 min at MLSS, Baron 2003/2008) is not a reason to slow down. */
export const LT2_LATE_FROM_SEC = 600, LT2_LATE_STEP_SEC = 120, LT2_REP_GRACE_SEC = 240, VO2_REP_GRACE_SEC = 150, TEMPO_GRACE_SEC = 300;
/** The 4 × 4-min speed: the 3-km pace − 1 km/h, to the nearest 0.5 km/h (13.0 at 14.1); NaN without a 3-km pace. */
export function vo2Speed(zones) { const p = zones && Number.isFinite(zones.pace3k) ? zones.pace3k : NaN; return Number.isFinite(p) ? Math.round((p - 1.0) * 2) / 2 : NaN; }
/** Heart-rate band of a VO₂max rep: 90–95 % of the maximal heart rate (Helgerud 2007). */
export function vo2Band(zones) { const mx = zones && Number.isFinite(zones.maxHr) ? zones.maxHr : 220; return { hrLo: Math.round(0.90 * mx), hrHi: Math.round(0.95 * mx) }; }
/**
 * Live-session targets by type. LT1 session = LT1−10…LT1−3 bpm (ceiling LT1 + 5 after 20 min); LT2 ladder = LT2 ±3 with the ceiling rising
 * +1 bpm per 2 min after minute 10 of a rep and no zone cue in its first 4 min (v1.1.35 — speed is cut on RPE ≥ 7, a lactate rise > 1.0 between
 * reps or a speed that cannot be held, never on heart rate alone); vo2 = 90–95 % HRmax at the 4×4 speed, no cue in the first 2:30 of a rep.
 */
export function sessionTargets(zones, type, opts = {}) {
  if (!zones) return null;
  const { lt1Hr, lt2Hr, lt1Speed, lt2Speed } = zones; const adj = opts.lt1Adjust || 0;
  // ceilHr / lateFromSec (v1.1.17): after 20 min of an LT1 session the ceiling is LT1 + 5 — the drift of a steady run is allowed; above it, "slow down 0.3"
  if (type === 'lt1') return { hrLo: Math.round(lt1Hr - 10 + adj), hrHi: Math.round(lt1Hr - 3 + adj), ceilHr: Math.round(lt1Hr + 5), lateFromSec: 1200, judgeFromSec: 600, speedLo: Number.isFinite(lt1Speed) ? r1(lt1Speed - 1.0) : NaN, speedHi: Number.isFinite(lt1Speed) ? r1(lt1Speed - 0.3) : NaN, alphaMin: 0.75, durationSec: (opts.minutes || 50) * 60 };
  if (type === 'lt2') { const off = Number.isFinite(opts.speedOffset) ? opts.speedOffset : 0; return { kind: 'ladder', hrLo: Math.round(lt2Hr - 3), hrHi: Math.round(lt2Hr + 3), ceilHr: Math.round(lt2Hr + 3), lateFromSec: LT2_LATE_FROM_SEC, lateStepSec: LT2_LATE_STEP_SEC, repGraceSec: LT2_REP_GRACE_SEC, speedLo: Number.isFinite(lt2Speed) ? r1(lt2Speed - 0.3 + off) : NaN, speedHi: Number.isFinite(lt2Speed) ? r1(lt2Speed + off) : NaN, alphaMin: null }; }
  if (type === 'vo2') { const b = vo2Band(zones); const sp = vo2Speed(zones); return { kind: 'vo2', hrLo: b.hrLo, hrHi: b.hrHi, repGraceSec: VO2_REP_GRACE_SEC, speedLo: sp, speedHi: sp, alphaMin: null }; }
  // v1.1.44: the optional weekday tempo — the five-zone Z3 (LT1 + 1 … LT2 − 5 bpm, 144–152 at 143/157), run by heart rate at the unit; no ceiling rise, no cue in the first 5 min of the rep (the heart rate is still rising)
  if (type === 'tempo') return { kind: 'tempo', hrLo: Math.round(lt1Hr + 1), hrHi: Math.round(lt2Hr - 5), ceilHr: NaN, repGraceSec: TEMPO_GRACE_SEC, speedLo: NaN, speedHi: NaN, alphaMin: null };
  return null;
}
/** One speed where there is a range (v1.1.26: the app names the speed to set, not a range to choose in): the middle of lo…hi in 0.1 km/h steps, a tie rounded up — 7.7–8.4 → 8.1. */
export function midSpeed(lo, hi) { const a = Math.round(lo * 10), b = Math.round(hi * 10); return Number.isFinite(a) && Number.isFinite(b) ? Math.floor((a + b + 1) / 2) / 10 : NaN; }
/**
 * The speeds a running session names, from the thresholds (v1.1.26: one speed each, where v1.1.20–25 gave ranges) — at LT1 8.7 / LT2 10.5:
 *   jog 7.0 = LT1 − 1.7: the easy jog — warm-up of the easy run, the long run and the two-lap check, first half of the ladder's cool-down
 *     (the low end of the former 7.0–7.5: a warm-up is there to stay under the Z1 ceiling, LT1 − 15 bpm);
 *   hi 7.5 = LT1 − 1.2: the first step of a ramp (ladder, MLSS check); sub 8.5 = LT1 − 0.2 and ramp 9.5 = LT2 − 1.0: its next steps;
 *   easy 8.1: the easy run — the middle of the band LT1 − 1.0…− 0.3 (sessionTargets), the value the session's speed field starts with;
 *   rec 6.5 = LT1 − 2.2: the recovery jog between intervals (the low end of the former 6.5–7.0: its job is a heart rate back under the band);
 *   walk 5.5. Strings with one decimal; null when the LT1 speed is not known (ramp: null without an LT2 speed).
 */
export function sessionSpeeds(zones) {
  if (!zones || !Number.isFinite(zones.lt1Speed)) return null; const s = zones.lt1Speed, f = x => (Math.round(x * 10) / 10).toFixed(1); const T = sessionTargets(zones, 'lt1');
  return { jog: f(s - 1.7), hi: f(s - 1.2), sub: f(s - 0.2), ramp: Number.isFinite(zones.lt2Speed) ? f(zones.lt2Speed - 1.0) : null, easy: f(midSpeed(T.speedLo, T.speedHi)), rec: f(s - 2.2), walk: '5.5' };
}

/**
 * Tuesday's hard session (v1.1.35, the Oct 17 review §3): the hard weeks alternate — odd hard weeks take the next step of the LT2 ladder,
 * even hard weeks are 4 × 4 min at 90–95 % HRmax (a threshold-only week raises no VO₂max: Stöggl & Sperlich 2014, Helgerud 2007; VO₂max is
 * the health outcome and the 3-km test). The ladder itself keeps its 8-step cycle (4×8 → 4×10 → 5×10 → recovery → 3×15 → 2×20 → 1×30 →
 * recovery), so one cycle now takes 16 hard weeks; its long reps (≥ 15 min) run at MLSS − 0.3 km/h (the Norwegian threshold reps sit below
 * MLSS, Casado 2023) and a recovery step is a short quality session, 2 × 8 min at MLSS − 0.3, not a week without intensity.
 * `kind` (ladder | vo2 | override from the calendar) and `speedOffset` ride on the structure; `recovery` marks the recovery steps.
 */
export const VO2_STRUCTURE = Object.freeze({ kind: 'vo2', reps: 4, workSec: 240, restSec: 180, warmupSec: 600, cooldownSec: 360, speedOffset: 0, label: 'VO₂max 4×4분 (회복 3분) / VO₂max 4×4 min (3-min jog)' });
/** v1.1.44: the optional weekday tempo — one 25-min rep at the zone-3 heart rate (LT1 + 1 … LT2 − 5), warm-up 10, cool-down 3; the cheap second quality session of a week whose Saturday is the VO₂max session. */
export const TEMPO_STRUCTURE = Object.freeze({ kind: 'tempo', reps: 1, workSec: 1500, restSec: 0, warmupSec: 600, cooldownSec: 180, speedOffset: 0, label: '템포 25분 (심박 존3) / tempo 25 min (zone-3 HR)' });
const LADDER_TABLE = { 1: [4, 8], 2: [4, 10], 3: [5, 10], 4: null, 5: [3, 15], 6: [2, 20], 7: [1, 30], 8: null };
/** Step `idx` (1-based, cycles of 8) of the LT2 ladder — steps 4 and 8 are the recovery steps (2 × 8 min at MLSS − 0.3). */
export function ladderStep(idx) {
  const w = ((idx - 1) % 8) + 1; const t = LADDER_TABLE[w];
  if (!t) return { kind: 'ladder', step: w, recovery: true, reps: 2, workSec: 480, restSec: 180, warmupSec: 600, cooldownSec: 360, speedOffset: -0.3, label: '회복주 2×8분 (MLSS − 0.3, 회복 3분) / recovery week 2×8 min (MLSS − 0.3, 3-min easy)' };
  const [reps, min] = t; const rest = min >= 15 ? 4 : 3; const long = min >= 15; const off = long ? ' (MLSS − 0.3)' : '';
  return { kind: 'ladder', step: w, recovery: false, reps, workSec: min * 60, restSec: rest * 60, warmupSec: 600, cooldownSec: 360, speedOffset: long ? -0.3 : 0, label: reps === 1 ? `템포 ${min}분${off} / tempo ${min} min${off}` : `${reps}×${min}분 (회복 ${rest}분)${off} / ${reps}×${min} min (${rest}-min easy)${off}` };
}
/** Which kind of hard session a hard week gets by itself: odd weeks the ladder, even weeks VO₂max. */
export const hardWeekKind = week => (week % 2 === 1 ? 'ladder' : 'vo2');
/** Index of the ladder step a hard week stands at (the ladder advances on odd weeks only). */
export const ladderIndex = week => Math.ceil(week / 2);
/** The Tuesday structure of hard week `week` (1-based); `kindOverride` = 'ladder' | 'vo2' from the week calendar. Never null since v1.1.35. */
export function lt2Structure(week, kindOverride = null) {
  const kind = kindOverride === 'vo2' || kindOverride === 'ladder' ? kindOverride : hardWeekKind(week);
  return kind === 'vo2' ? { ...VO2_STRUCTURE } : ladderStep(ladderIndex(week));
}
/** A recovery week = a hard week whose ladder step is a recovery step (hard weeks 7, 15, 23, …): long run × 0.7, strength lighter, Tuesday 2 × 8. */
export const isRecoveryWeek = week => hardWeekKind(week) === 'ladder' && ladderStep(ladderIndex(week)).recovery === true;
/**
 * Work minutes (reps × rep length) of the longest interval session of the last `days` days — the Tuesday session is capped at 110 % of it,
 * the same rule as the long run (a session more than 10 % beyond the recent longest carries a hazard of 1.64, Frandsen 2025). null = none yet.
 */
export function longestHardWorkMin(sessions, { days = 30, now = Date.now() } = {}) {
  let best = 0;
  for (const s of sessions || []) {
    if (!s || !s.final || s.type !== 'lt2' || s.sourceKind === 'demo' || !Number.isFinite(s.startedAt) || now - s.startedAt > days * 86400000) continue;
    const I = s.intervals || {}; const m = (Number(I.reps) || 0) * (Number(I.workSec) || 0) / 60; if (m > best) best = m;
  }
  return best > 0 ? Math.round(best) : null;
}

/** Running minutes of the longest real session of the last `days` days (the long-run cap of v1.1.17: next long run ≤ 110 % of it). */
export function longestRecentMin(sessions, { days = 30, now = Date.now() } = {}) {
  let best = 0;
  for (const s of sessions || []) {
    if (!s || !s.final || s.sourceKind === 'demo' || !Number.isFinite(s.startedAt) || now - s.startedAt > days * 86400000) continue;
    const m = s.metrics && Number.isFinite(s.metrics.durationSec) ? s.metrics.durationSec / 60 : (s.endedAt ? (s.endedAt - s.startedAt - (s.pauseMs || 0)) / 60000 : 0);
    if (m > best) best = m;
  }
  return best > 0 ? Math.round(best) : null;
}
/**
 * v1.1.18 — the week calendar of the plan. One line per entry: `YYYY-MM-DD kind note…` — the date is any day of that week (it is rounded
 * to its Monday). kinds: recovery (the whole week easy: Tuesday easy, long run × 0.7, strength lighter) · mlss (Tuesday = the 30-min MLSS
 * check) · easy (Tuesday easy, reason in the note) · blood (Tuesday easy, Thursday no run: a fasted blood draw; the check skips a week) ·
 * step (Saturday = the lactate step test instead of the long run) · v1.1.35: vo2 / ladder (force that kind of Tuesday session, e.g. `vo2` on
 * both weeks before a 3-km test) · test (the test week: Tuesday 3 × 4 min, Thursday easy 20 + strides, Saturday the test — no long run).
 * Weeks with recovery / mlss / easy / blood / test do not count as hard weeks, so the ladder–VO₂max alternation (lt2Structure) goes on where
 * it stopped. Lines without a known kind are ignored; `#` starts a comment.
 */
export const CALENDAR_KINDS = ['recovery', 'mlss', 'easy', 'blood', 'step', 'vo2', 'ladder', 'test', 'satoff', 'split1', 'split2', 'split3', 'fixed', 'tt', 'lt1'];
/** v1.1.36: weeks whose weekend has no long run (step test / MLSS check on Saturday, or the test week) — the long run does not grow across them. v1.1.44: the third split part and the time trial too. */
const NO_LONG = ['step', 'mlss', 'test', 'split3', 'tt'];
/** Weeks that do not advance the Saturday alternation (fixed-speed test ↔ 4×4): their Saturday is set by the calendar. */
const NON_LADDER = ['recovery', 'mlss', 'easy', 'blood', 'test', 'split1', 'split2', 'split3', 'fixed', 'tt', 'lt1', 'step'];
const localDate = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
const atNoon = s => new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? s + 'T12:00:00' : s);
/** The Monday of the week that holds `d` (a Date, ms, or 'YYYY-MM-DD'), as 'YYYY-MM-DD' in local time. */
export function mondayOf(d) { const x = atNoon(d); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return localDate(x); }
export function parseCalendar(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\d{4}-\d{2}-\d{2})\s+([A-Za-z]\w*)\s*(.*)$/); if (!m) continue; // v1.1.44: kinds may end in a digit (split1 · split2 · split3)
    const kind = m[2].toLowerCase(); if (!CALENDAR_KINDS.includes(kind)) continue;
    const mon = mondayOf(m[1]); const w = out[mon] || (out[mon] = { kinds: [], notes: [] });
    if (!w.kinds.includes(kind)) w.kinds.push(kind); if (m[3].trim()) w.notes.push(m[3].trim());
  }
  return out;
}
/**
 * Where the plan stands in a given week: blockWeek = weeks since the start date (1-based; the long run grows with it), ladderWeek = how many
 * ladder weeks there have been up to and including this one (drives lt2Structure / isRecoveryWeek), kinds/notes = this week's calendar lines.
 */
export function planContext({ startDate = null, calendar = '', weekOffset = 0, now = Date.now() } = {}) {
  const cal = typeof calendar === 'string' ? parseCalendar(calendar) : (calendar || {});
  const d0 = atNoon(mondayOf(now)); d0.setDate(d0.getDate() + 7 * (weekOffset || 0)); const monday = localDate(d0);
  const start = startDate && !isNaN(atNoon(startDate)) ? mondayOf(startDate) : monday; // (an unreadable start date = this week)
  const diffWeeks = Math.round((atNoon(monday) - atNoon(start)) / (7 * 86400000));
  let ladderWeek = 0, longWeek = 0; // longWeek: the weeks that had a long run (a step-test, MLSS-check or test week has none, so the long run does not grow across it)
  for (let i = 0; i <= diffWeeks; i++) { const d = atNoon(start); d.setDate(d.getDate() + 7 * i); const k = (cal[localDate(d)] || { kinds: [] }).kinds; if (!k.some(x => NON_LADDER.includes(x))) ladderWeek++; if (!k.some(x => NO_LONG.includes(x))) longWeek++; }
  const here = cal[monday] || { kinds: [], notes: [] };
  return { monday, blockWeek: Math.max(1, diffWeeks + 1), ladderWeek: Math.max(1, ladderWeek), longWeek: Math.max(1, longWeek), kinds: here.kinds.slice(), notes: here.notes.slice(), calendar: cal };
}
/** Time for `m` metres at `kmh` (v1.1.36: the track pace of a session, "2:17" for 400 m at 10.5 km/h). */
export function lapTime(kmh, m = 400) { if (!Number.isFinite(kmh) || kmh <= 0) return '–'; const t = Math.round(m / kmh * 3.6); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; }
/**
 * v1.1.36 (owner, 2026-10-19: weekdays at the unit — outdoor track or a hill, a non-motorized treadmill — weekends at the gym — motorized
 * treadmill, StairMaster, both days from 09:00): where each day is run. A fixed speed exists only on the gym's motorized belt, so every
 * session that needs one (the two-lap LT1 check, the MLSS check, the step test) is on the weekend; weekdays run by heart rate (easy days)
 * or by lap pace / the hill (Tuesday). `surface` = what the session record carries: 'treadmill' (speed is real) · 'outdoor' · 'nmt'.
 */
export const PLACES = Object.freeze({
  unit: { surface: 'outdoor', ko: '부대 05:30 · 트랙 또는 무동력', en: 'unit 05:30 · track or non-motorized treadmill' },
  track: { surface: 'outdoor', ko: '부대 05:30 · 트랙', en: 'unit 05:30 · track' },
  hill: { surface: 'outdoor', ko: '부대 05:30 · 언덕 (오르막 600 m + 평지 170 m)', en: 'unit 05:30 · hill (600 m up + 170 m flat)' },
  gym: { surface: 'treadmill', ko: '헬스장 09:00 · 동력식 트레드밀', en: 'gym 09:00 · motorized treadmill' },
});
export const SURFACES = ['treadmill', 'outdoor', 'nmt'];
/** Does a session's speed mean anything (v1.1.36)? Only on a motorized treadmill — old sessions without the field were all on one. */
export const onBelt = s => !s || !s.surface || s.surface === 'treadmill';
const r5 = x => Math.round(x / 5) * 5;
/**
 * v1.1.44 (owner 10/31: "평일은 가장 쉬운 운동, 주말에 집중 · 분할 계단 테스트 · 매주 데이터로 주기적 개선"): weekdays = walking plus a 20-min jog
 * or two and one set of bodyweight strength (an optional tempo / hill session when the weekday quota allows one); Saturday = the quality or
 * test session on the gym belt (split step test → fixed-speed test at the LT2 speed ↔ 4 × 4, by the calendar); Sunday = a long run of 60.
 */
export const WEEKDAY_JOG_MIN = 20;
export const LONG_RUN_FIXED_MIN = 60;
/**
 * The split step test: one continuous step test spread over three Saturdays. Part n runs stages 1…2n — the earlier stages unmeasured,
 * so the measured stages sit on the same accumulated state as in one continuous test — and samples its last two (two strips a week).
 * Stages from the protocol (8.0 + 1.0: 8 · 9 · 10 · 11 · 12 · 13); the parts merge into one curve (splitCurve).
 */
export const SPLIT_PARTS = Object.freeze({ 1: { run: [1, 2], measure: [1, 2] }, 2: { run: [1, 2, 3, 4], measure: [3, 4] }, 3: { run: [1, 2, 3, 4, 5, 6], measure: [5, 6] } });
export function splitPart(n, protocol = null) {
  const P = SPLIT_PARTS[n]; if (!P) return null;
  const start = Number.isFinite(protocol?.startSpeed) ? protocol.startSpeed : 8.0, step = Number.isFinite(protocol?.speedStep) && protocol.speedStep > 0 ? protocol.speedStep : 1.0;
  const stageSec = Number(protocol?.stageSec) > 0 ? Number(protocol.stageSec) : 240, pauseSec = Number.isFinite(Number(protocol?.pauseSec)) ? Number(protocol.pauseSec) : 30, warmupSec = Number.isFinite(Number(protocol?.warmupSec)) ? Number(protocol.warmupSec) : 300;
  const speeds = P.run.map(i => r1(start + (i - 1) * step));
  return { part: n, run: P.run.slice(), measure: P.measure.slice(), last: P.run[P.run.length - 1], speeds, measureSpeeds: P.measure.map(i => speeds[i - 1]), minutes: Math.round((warmupSec + P.run.length * (stageSec + pauseSec)) / 60) };
}
/** The Saturday of a week the calendar says nothing about: odd hard weeks the fixed-speed test at the LT2 speed (the threshold session that also measures), even weeks the 4 × 4 on the belt. */
export const satQuality = week => (hardWeekKind(week) === 'ladder' ? 'fixed' : 'vo2');
/**
 * The split step test's merged curve (v1.1.44): the newest of each part within `days`, every measured stage a point (newest per speed),
 * LT1 = lowest + 0.5 and LT2 = Log-Poly-ModDmax on the merged points (analyzeLactate), heart rate from the measured stages. `lowest` is
 * the lowest measured lactate across the parts — the "lowest" of the two-lap rule (the newest part alone would carry a high one).
 */
export function splitCurve(sessions, { days = 28, now = Date.now() } = {}) {
  const since = now - days * 86400000;
  const all = list(sessions).filter(s => s && s.type === 'test' && s.final && s.sourceKind !== 'demo' && s.split && Number.isFinite(s.startedAt) && s.startedAt >= since).sort((a, b) => a.startedAt - b.startedAt);
  const byPart = {}; for (const s of all) byPart[s.split.part || 0] = s; // the newest of each part
  const used = Object.values(byPart).sort((a, b) => a.startedAt - b.startedAt);
  const bySpeed = new Map();
  for (const s of used) for (const r of summarizeStages(s)) { if (!Number.isFinite(r.lactate) || !Number.isFinite(r.speed)) continue; bySpeed.set(r.speed, { x: r.speed, la: r.lactate, hr: r.hr, dup: !!r.lactateDup, date: s.startedAt, part: s.split.part || null, id: s.id }); }
  const points = [...bySpeed.values()].sort((a, b) => a.x - b.x);
  const analysis = points.length >= 3 ? analyzeLactate(points) : null;
  const pick = e => (e && Number.isFinite(e.x) ? { speed: r1(e.x), hr: Number.isFinite(e.hr) ? Math.round(e.hr) : null, la: Number.isFinite(e.la) ? Math.round(e.la * 10) / 10 : null } : null);
  const lt1 = analysis ? pick(analysis.lt1Primary) : null, lt2 = analysis ? pick(analysis.lt2Primary) : null;
  return { parts: used.map(s => ({ id: s.id, date: s.startedAt, part: s.split.part || null, measured: summarizeStages(s).filter(r => Number.isFinite(r.lactate)).map(r => r.speed) })), points, analysis, lowest: points.length ? Math.min(...points.map(p => p.la)) : null, missing: [1, 2, 3].filter(n => !byPart[n]), lt1, lt2, ok: !!(lt1 && lt2 && lt1.hr != null && lt2.hr != null), maxLa: analysis ? analysis.maxLa : null };
}
/**
 * Lactate at a fixed speed, week by week (v1.1.44): the two-lap runs on the belt at `speed` (default: the speed of the newest one) within
 * `days` — lap-1 value, end value, rise, lap-1 heart rate (minutes 5–10), last-5-min heart rate, RPE — and the block rule read against the
 * first run of the series: two consecutive runs with the end value ≥ 0.5 lower and the late heart rate ≥ 3 lower (or RPE ≥ 1 lower) → the
 * speed may rise 0.3; the end value ≥ 0.5 higher with the heart rate ≥ 5 higher → check fatigue, illness and diet; inside ± 0.3 / ± 3 → noise, hold.
 */
export function sameSpeedTrend(sessions, { days = 120, now = Date.now(), speed = null } = {}) {
  const since = now - days * 86400000;
  const runs = list(sessions).filter(s => s && s.type === 'verify' && s.final && s.sourceKind !== 'demo' && onBelt(s) && Number.isFinite(s.speed) && Number.isFinite(s.startedAt) && s.startedAt >= since).sort((a, b) => a.startedAt - b.startedAt);
  const sp = Number.isFinite(speed) ? r1(speed) : (runs.length ? r1(runs[runs.length - 1].speed) : null);
  if (sp == null) return { speed: null, rows: [], verdict: null };
  const rows = [];
  for (const s of runs) { if (r1(s.speed) !== sp) continue; const c = lactateChecks(s); if (!Number.isFinite(c.mid) && !Number.isFinite(c.end)) continue; const ls = lapStats(s); const ew = endWindowStats(s);
    rows.push({ id: s.id, date: s.startedAt, lap1: Number.isFinite(c.mid) ? c.mid : null, end: Number.isFinite(c.end) ? c.end : null, rise: Number.isFinite(c.mid) && Number.isFinite(c.end) ? Math.round((c.end - c.mid) * 10) / 10 : null, hr1: ls && Number.isFinite(ls.lap1Hr) ? Math.round(ls.lap1Hr) : null, hrLate: Number.isFinite(ew.hr) ? Math.round(ew.hr) : null, rpe: Number.isFinite(s.rpe) ? s.rpe : null, gapSec: ls ? ls.gapSec : null }); }
  let verdict = null;
  if (rows.length >= 2) {
    const base = rows[0], a = rows[rows.length - 1], b = rows[rows.length - 2];
    const dEnd = x => (x.end != null && base.end != null ? x.end - base.end : null), dHr = x => (x.hrLate != null && base.hrLate != null ? x.hrLate - base.hrLate : null), dRpe = x => (x.rpe != null && base.rpe != null ? x.rpe - base.rpe : null);
    const down = x => dEnd(x) != null && dEnd(x) <= -0.5 && ((dHr(x) != null && dHr(x) <= -3) || (dRpe(x) != null && dRpe(x) <= -1));
    const up = x => dEnd(x) != null && dEnd(x) >= 0.5 && dHr(x) != null && dHr(x) >= 5;
    if (rows.length >= 3 && down(a) && down(b)) verdict = { kind: 'up', nextSpeed: r1(sp + 0.3), ko: `${sp} km/h에서 종료 젖산이 기준보다 2주 연속 ≥ 0.5 낮고 심박·RPE도 내려감 → 다음 블록 ${r1(sp + 0.3)} km/h`, en: `at ${sp} km/h the end lactate sits ≥ 0.5 under the baseline two weeks running, heart rate / RPE down too → next block ${r1(sp + 0.3)} km/h` };
    else if (up(a)) verdict = { kind: 'check', nextSpeed: sp, ko: `종료 젖산 ≥ 0.5 상승 + 심박 ≥ 5 상승 → 피로·질병·식단 점검(수면, 안정 심박); 속도 유지`, en: `end lactate ≥ 0.5 up with heart rate ≥ 5 up → check fatigue, illness and diet (sleep, resting HR); hold the speed` };
    else verdict = { kind: 'hold', nextSpeed: sp, ko: `기준 대비 변화가 잡음대(± 0.3 mmol/L · ± 3 bpm) 안 → ${sp} km/h 유지`, en: `changes inside the noise band (± 0.3 mmol/L · ± 3 bpm) → hold ${sp} km/h` };
  }
  return { speed: sp, rows, verdict };
}
/**
 * The week as decided on 2026-10-10 (v1.1.18) and revised by the Oct 17 review (v1.1.35): mornings run, noon and evenings other exercise.
 * Mon easy 50 + strides at 3-km pace · Tue the hard day — the LT2 ladder and 4 × 4 min VO₂max intervals on alternate hard weeks (an MLSS
 * check or an easy run when the calendar says so; a recovery week keeps 2 × 8 min) · Wed easy 50 at the low end of the band · Thu the two-lap
 * LT1 check (45 min, fasted; an easy 45 in the weeks between checks) · Fri rest (no run: six running days at most) · Sat long run 70 → 100 min
 * (+10 a week, × 0.7 in recovery weeks, ≤ 110 % of the 30-day longest; one end sample every other long run) · Sun easy 50 at the low end.
 * Evenings: Mon home session, Tue strength A, Wed plyometric block + walk, Thu strength B, Fri plyometric block + foot core + wall sit, Sun optional incline walk.
 * `week` = the hard week (lt2Structure / isRecoveryWeek), `blockWeek` = weeks since the block start (the plyometric block grows with it), `longWeek` = long-run weeks so far
 * (the long run grows with it; default blockWeek), `kinds`/`notes` = this week's calendar entries (planContext), `hardCapMin` = work minutes of the longest interval
 * session of the last 30 days (longestHardWorkMin: Tuesday's reps are cut to stay within 110 % of it). weekdayMin only shortens the easy days when it is below 55; weekendMin caps the long run.
 */
export function weeklyPlan({ zones, week = 1, blockWeek = week, longWeek = blockWeek, weekdayMin = 60, weekendMin = 150, goal = 'base', lt1Adjust = 0, longestMin = null, hardCapMin = null, verifySpeed = null, verifyDue = true, verifyNext = null, kinds = [], notes = [], protocol = null }) {
  const K = kinds || []; const rec = isRecoveryWeek(week) || K.includes('recovery'); const k = rec ? 0.7 : 1; const lightWeek = rec || K.includes('easy') || K.includes('blood') || K.includes('test');
  const T1 = sessionTargets(zones, 'lt1', { lt1Adjust }); const T2 = sessionTargets(zones, 'lt2'); const TV = sessionTargets(zones, 'vo2');
  const steady = T1 ? { hrLo: T1.hrLo, hrHi: T1.hrHi } : null; // every easy run = the LT1 session band (LT1 −10…−3 at minute 10; the ceiling LT1 + 5 after 20 min is the session's)
  const band = T1 && Number.isFinite(T1.speedLo) ? [T1.speedLo, T1.speedHi] : null; const easySp = band ? midSpeed(band[0], band[1]) : null; const bandTxt = easySp != null ? ` ${easySp.toFixed(1)} km/h` : ''; // v1.1.26: one speed, the middle of the band (8.1 at LT1 8.7) — the band itself stays in `speeds`
  const slowSp = band ? band[0] : null; // v1.1.35: the day after the hard session and after the long run run at the low end of the band (7.7 at LT1 8.7), heart rate ≤ LT1 − 10
  const lt1Hr = zones && Number.isFinite(zones.lt1Hr) ? zones.lt1Hr : null; const lt1Speed = zones && Number.isFinite(zones.lt1Speed) ? zones.lt1Speed : null;
  const easyMin = Math.max(30, Math.min(50, Math.round(Math.min(weekdayMin, 60)) - 5)); // 50 unless the weekday allowance is below 55
  const jogMin = WEEKDAY_JOG_MIN; // v1.1.44: the weekday jog — 20 min, whenever it fits (30 when there is time); the busy-day floor is the same run
  // every instruction with a number (v1.1.20): warm-up and cool-down speeds, what "over it" means in seconds, the readiness gate, the evenings
  const f1 = x => (Math.round(x * 10) / 10).toFixed(1);
  const wu = lt1Speed != null ? { lo: f1(lt1Speed - 1.7), hi: f1(lt1Speed - 1.2) } : null; // lo = the easy jog of the warm-ups (7.0 at LT1 8.7; v1.1.26: one speed, see sessionSpeeds), hi = the first step of a ramp (7.5)
  const z1Top = lt1Hr != null ? Math.round(lt1Hr - 15) : null; // the app's Z1 ceiling (128 at LT1 143): the warm-up stays under it
  const p3 = zones && Number.isFinite(zones.pace3k) ? zones.pace3k : null; // the 3-km pace (Settings → thresholds): strides run at it or faster, the 4×4 one km/h under it
  const strideTxt = p3 != null ? { ko: ` · 끝에 스트라이드 4–6×20초 @ ${f1(p3)} km/h(3 km 페이스; 벨트가 느리면 경사 4 %에서 ${f1(p3 - 1.5)}), 사이 걷기 90초`, en: ` · 4–6 × 20 s strides at ${f1(p3)} km/h at the end (3-km pace; if the belt lags, ${f1(p3 - 1.5)} at 4 % incline), 90 s walk between` } : { ko: ' · 끝에 스트라이드 4–6×20초 @ 3 km 페이스(설정 → 역치에 3 km 페이스를 적으면 속도가 나옵니다), 사이 걷기 90초', en: ' · 4–6 × 20 s strides at 3-km pace at the end (enter the 3-km pace in Settings → thresholds for the number), 90 s walk between' };
  const lt2Sp = zones && Number.isFinite(zones.lt2Speed) ? zones.lt2Speed : null;
  const mlssLa = zones && Number.isFinite(zones.mlssLactate) ? zones.mlssLactate : null;
  // the readiness gate (v1.1.35, review §6): the trial-tested trigger is a rolling heart-rate-variability band, not a single night; the daily app does the judging
  const GATE = { ko: '실시 조건(오늘의 실시 체크가 판정): 7일 이동평균 lnRMSSD가 28일 평균 ± 0.5 SD 안 — 벗어나면 그날은 쉬운 런 · 수면 > 6시간이고 3일 평균이 평소보다 1시간 이상 적지 않음 — 아니면 구간 1개 줄임 · 안정 심박 < 7일 평균 + 7 — 넘으면 질병 의심, 휴식 · 통증 ≤ 2/10', en: 'do it only if (the daily app judges): the 7-day rolling lnRMSSD is inside the 28-day mean ± 0.5 SD — outside it, an easy run today · sleep > 6 h and the 3-night mean not ≥ 1 h under habitual — otherwise one rep fewer · resting HR < 7-day mean + 7 — above it, possible illness: rest · pain ≤ 2/10' };
  const easyDay = (day, min, extraKo = '', extraEn = '', strides = false, slow = false) => { const sp = slow && slowSp != null ? slowSp : easySp; const spTxt = sp != null ? ` ${sp.toFixed(1)} km/h` : ''; const capKo = slow && lt1Hr != null ? ` · 밴드 하단(고강도·롱런 다음 날): 심박 ≤ ${Math.round(lt1Hr - 10)}` : '', capEn = slow && lt1Hr != null ? ` · low end of the band (the day after the hard session / long run): HR ≤ ${Math.round(lt1Hr - 10)}` : '';
    return { day, type: 'lt1', ko: `쉬운 런 ${min}분${extraKo}`, en: `Easy run ${min} min${extraEn}`, minutes: min, hr: steady, speed: sp, slow, note: {
      ko: `0–5분 ${wu ? wu.lo : '–'} km/h → 본 구간${spTxt}(속도가 용량${slow ? ', 밴드 하단' : ''}) → 마지막 3분 걷기 5.5 · 심박은 천장: 10분부터 ${steady ? `${steady.hrLo}–${steady.hrHi}` : '–'}, 위로 30초 넘으면 −0.3 km/h · 20분부터 천장 ${lt1Hr != null ? lt1Hr + 5 : '–'}, 60초 넘으면 −0.3${capKo} · 15분마다 말하기(10단어 문장을 한 번에) — 안 되면 −0.3 · 끝나면 RPE(CR-10) 입력${strides ? strideTxt.ko : ''}`,
      en: `0–5 min at ${wu ? wu.lo : '–'} km/h → main part${spTxt} (speed is the dose${slow ? ', low end of the band' : ''}) → last 3 min walk 5.5 · heart rate is a ceiling: ${steady ? `${steady.hrLo}–${steady.hrHi}` : '–'} from minute 10, 30 s above it → −0.3 km/h · from minute 20 ceiling ${lt1Hr != null ? lt1Hr + 5 : '–'}, 60 s above → −0.3${capEn} · talk test every 15 min (a 10-word sentence in one breath) — failed → −0.3 · enter the session RPE (CR-10) at the end${strides ? strideTxt.en : ''}` } }; };
  // the long run: 70 min in the first long-run week, +10 a week, up to 100 (120 for a performance goal), × 0.7 in a recovery week, ≤ 110 % of the 30-day longest
  let longMin = Math.min(weekendMin, r5(LONG_RUN_FIXED_MIN * k)); let longCap = null; // v1.1.44: the long run holds at 60 (× 0.7 in a recovery week) while the weekdays are at their lightest; it grows only by a later decision
  if (Number.isFinite(longestMin) && longestMin > 0) { const cap = Math.max(30, r5(1.1 * longestMin)); if (cap < longMin) { longMin = cap; longCap = { longestMin, cap }; } }
  const noteTxt = notes && notes.length ? notes.join(' · ') : '';
  const vs = Number.isFinite(verifySpeed) ? verifySpeed : lt1Speed;
  const rpe7 = lightWeek ? { ko: ' · 가볍게: 무게 −10 %, 세트 −1', en: ' · lighter: −10 % load, one set fewer' } : { ko: ' · 2회 남기는 무게(RIR 2)', en: ' · a load that leaves 2 reps in reserve' };
  // v1.1.22: other exercise = a noon session of 20 min before lunch (11:30–11:50, eat after) + an evening extra at 17:30 only without overtime
  const EVE_GATE = { ko: '야근 없음 + ' + GATE.ko.replace('실시 조건(오늘의 실시 체크가 판정): ', '') + ' · 18:00 전 종료', en: 'no overtime + ' + GATE.en.replace('do it only if (the daily app judges): ', '') + ' · done by 18:00' };
  // strength (v1.1.35, review §7): the main lift heavy — running economy improves at ≥ 80 % 1RM, not at 3 × 8–10 (Llanos-Lagos 2024); one more pressing set
  const strengthNote = { ko: `11:30 워밍업 3분 + 메인 리프트(스쿼트/데드리프트 3×3–6 @ 1RM의 80 % 이상, 사이 2–3분 · 벤치↔친업 / OHP↔로우 3×8–12 슈퍼세트, 사이 60초), 11:50 종료 → 점심${rpe7.ko} · 모든 세트의 반복을 다 채우면 다음에 하체 +5 kg·상체 +2.5 kg`, en: `11:30 warm-up 3 min + the main lift (squat/deadlift 3 × 3–6 at ≥ 80 % 1RM, 2–3 min between · bench↔chin-up / OHP↔row 3 × 8–12 supersets, 60 s), done by 11:50 → lunch${rpe7.en} · all sets completed → next time +5 kg lower / +2.5 kg upper` };
  const accessoryNote = { ko: `17:30 보조 25분(야근 없을 때): RDL↔팔로프 / 불가리안↔페이스 풀 슈퍼세트, 파머스 캐리 2×40 m, 앉은 카프 3×15, 한발 균형 30초×2/측${rpe7.ko} · ${EVE_GATE.ko}`, en: `17:30 accessories 25 min (no overtime): RDL↔Pallof / Bulgarian↔face pull supersets, farmer's carry 2 × 40 m, seated calf 3 × 15, single-leg stand 30 s × 2/side${rpe7.en} · ${EVE_GATE.en}` };
  // the plyometric block (review §7): 10–40 pogo hops were a warm-up, not a dose — a block of 8–10 weeks, twice a week, 40 → 100 contacts, on the evenings after an easy day (never the evening before the ladder)
  const plyo = Math.min(100, 40 + 20 * Math.floor((Math.max(1, blockWeek) - 1) / 2));
  const plyoNote = { ko: `플라이오 블록 접지 ${plyo}회(10회 단위: 양발 포고 홉 → 한발 포고 홉 → A-스킵 10 m; 2주마다 +20, 100회까지, 8–10주 뒤 종료; 아픈 데 있으면 생략)`, en: `plyometric block, ${plyo} contacts (in tens: two-leg pogo hops → single-leg pogo → A-skips 10 m; +20 every 2 weeks up to 100, done after 8–10 weeks; skip when anything hurts)` };
  // Tuesday (v1.1.35): the ladder and the 4×4 on alternate hard weeks, overridable from the calendar; the ladder's reps stay within 110 % of the longest recent session
  const kindOv = K.includes('vo2') ? 'vo2' : K.includes('ladder') ? 'ladder' : null;
  let st = lt2Structure(week, kindOv); let capNote = null;
  if (K.includes('test')) st = { ...VO2_STRUCTURE, reps: 3, label: '검정 주 자극 3×4분 / test-week sharpener 3×4 min' };
  if (st.kind === 'ladder' && Number.isFinite(hardCapMin) && hardCapMin > 0) { const work = st.reps * st.workSec / 60; const cap = 1.1 * hardCapMin; if (work > cap + 1e-9 && st.reps > 2) { const reps = Math.max(2, Math.floor(cap / (st.workSec / 60))); if (reps < st.reps) { capNote = { ko: `상한: 구간 합 ${work}분 > 30일 최장 ${hardCapMin}분 × 1.1 → ${reps}회로`, en: `cap: ${work} min of reps > 110 % of the 30-day longest (${hardCapMin} min) → ${reps} reps` }; st = { ...st, reps, capped: true, label: st.label.replace(new RegExp(`${st.reps}×`, 'g'), `${reps}×`) }; } } }
  const stSp = lt2Sp != null ? r1(lt2Sp + (st.speedOffset || 0)) : null; const vo2Sp = vo2Speed(zones);
  const laTgt = mlssLa != null ? { ko: `본인 MLSS 젖산 ${mlssLa} ± 0.5 (${f1(mlssLa - 0.5)}–${f1(mlssLa + 0.5)})`, en: `your MLSS lactate ${mlssLa} ± 0.5 (${f1(mlssLa - 0.5)}–${f1(mlssLa + 0.5)})` } : { ko: '본인 MLSS 젖산 ± 0.5(MLSS 검증의 종료 젖산을 설정 → 역치에 적기 전까지는 3.0–4.5)', en: 'your MLSS lactate ± 0.5 (3.0–4.5 until the MLSS check\'s end value is entered in Settings → thresholds)' };
  const ceilKo = T2 ? `천장: 구간 10분까지 ${T2.hrHi}, 그 뒤 2분마다 +1 bpm(20분 ${T2.hrHi + 5} · 30분 ${T2.hrHi + 10}) — 심박만으로는 감속하지 않음 · 감속 −0.3은 RPE ≥ 7/10, 구간 간 젖산 상승 > 1.0, 속도를 못 지킬 때` : '', ceilEn = T2 ? `ceiling: ${T2.hrHi} for the first 10 min of a rep, then +1 bpm per 2 min (${T2.hrHi + 5} at 20 min · ${T2.hrHi + 10} at 30) — never slow down on heart rate alone · −0.3 on RPE ≥ 7/10, a lactate rise > 1.0 between reps, or a speed that cannot be held` : '';
  // v1.1.36 — places (PLACES): weekdays at the unit (track / hill / non-motorized treadmill: heart rate or lap pace, no lactate verdicts),
  // weekends at the gym 09:00 (the motorized belt: every check that needs a fixed speed). Saturday = the check of the week, Sunday = the long run.
  const at = (o, place) => ({ ...o, place, surface: PLACES[place].surface });
  const hrTxt = h => (h ? `${h.hrLo}–${h.hrHi}` : '–');
  const slowHr = lt1Hr != null ? { hrLo: z1Top, hrHi: Math.round(lt1Hr - 10) } : null; // the low end of the band: HR ≤ LT1 − 10 (133 at LT1 143)
  const NMT = { ko: '무동력: 속도 표시는 무시(벨트를 직접 밀어 같은 심박에 동력식보다 느린 것이 정상) · 처음 2주는 한 번에 ≤ 30분, 종아리·아킬레스 통증 > 2/10이면 무동력 중단 · 세션 장소 「무동력」으로 기록(곡선·판정에서 빠짐)', en: 'non-motorized: ignore its speed display (pushing the belt costs more, so the same heart rate shows a lower speed — expected) · first 2 weeks ≤ 30 min per run on it, stop using it if calf or Achilles pain rises above 2/10 · record with the place "non-motorized" (kept out of the curve and the verdicts)' };
  const strideTrack = p3 != null ? { ko: ` · 끝에 스트라이드 4–6×20초(≈ 80 m, 3 km 페이스 ${f1(p3)} km/h = 400 m ${lapTime(p3)}의 리듬, 전력 아님), 사이 걷기 90초`, en: ` · 4–6 × 20-s strides at the end (≈ 80 m at the rhythm of your 3-km pace ${f1(p3)} km/h = ${lapTime(p3)} per 400 m, not a sprint), 90 s walk between` } : { ko: ' · 끝에 스트라이드 4–6×20초(3 km 페이스 리듬), 사이 걷기 90초', en: ' · 4–6 × 20-s strides at the end (3-km-pace rhythm), 90 s walk between' };
  /** An easy run at the unit: heart rate is the dose there (no fixed speed on a track in the wind or on a non-motorized belt). */
  const unitEasy = (day, min, { slow = false, strides = false, ko = '', en = '', pre = null } = {}) => {
    const h = slow ? slowHr : steady; const ref = slow && slowSp != null ? slowSp : easySp;
    return at({ day, type: 'lt1', ko: `쉬운 런 ${min}분${ko}`, en: `Easy run ${min} min${en}`, minutes: min, hr: h, speed: null, slow, note: {
      ko: `${pre ? pre.ko + ' · ' : ''}트랙 또는 무동력(어둡거나 비·빙판이면 무동력) — 속도 대신 심박: 0–5분 천천히 조깅(5분에 심박 < ${z1Top ?? '–'}) → 본 구간 심박 ${slow ? `≤ ${h ? h.hrHi : '–'}(밴드 하단: 롱런·고강도 다음 날)` : hrTxt(h)} · ${slow ? '천장 그대로' : `20분부터 천장 ${lt1Hr != null ? lt1Hr + 5 : '–'}`}, 위로 60초 넘으면 천천히 · 15분마다 말하기(10단어 문장을 한 번에) — 안 되면 천천히 · 트랙 참고 400 m ${lapTime(ref)} 안팎(${ref != null ? f1(ref) : '–'} km/h) — 심박이 우선 · 마지막 3분 걷기 · ${NMT.ko} · 끝나면 RPE(CR-10) 입력${strides ? strideTrack.ko : ''}`,
      en: `${pre ? pre.en + ' · ' : ''}track or the non-motorized treadmill (dark, rain or ice → the non-motorized one) — heart rate instead of speed: 0–5 min easy jog (HR < ${z1Top ?? '–'} at 5:00) → main part at HR ${slow ? `≤ ${h ? h.hrHi : '–'} (low end of the band: the day after the long run / the hard session)` : hrTxt(h)} · ${slow ? 'the same ceiling throughout' : `from minute 20 ceiling ${lt1Hr != null ? lt1Hr + 5 : '–'}`}, 60 s above → slower · talk test every 15 min (a 10-word sentence in one breath) — failed → slower · track reference ≈ ${lapTime(ref)} per 400 m (${ref != null ? f1(ref) : '–'} km/h) — heart rate first · last 3 min walk · ${NMT.en} · enter the session RPE (CR-10) at the end${strides ? strideTrack.en : ''}` } }, 'unit');
  };
  const GYM = { ko: '헬스장 09:00', en: 'gym 09:00' };
  const STAIRS = lt1Hr != null ? { ko: `선택: 천국의 계단 20분(처음 2주는 10분) — 속도는 심박 ≤ ${Math.round(lt1Hr - 3)}가 되게, 손잡이에 기대지 않기, 무릎·아킬레스 통증 > 2/10이면 중단`, en: `optional: StairMaster 20 min (10 min for the first 2 weeks) — a step rate that keeps HR ≤ ${Math.round(lt1Hr - 3)}, no leaning on the rails, stop on knee or Achilles pain > 2/10` } : { ko: '선택: 천국의 계단 20분', en: 'optional: StairMaster 20 min' };
  // Tuesday — the unit: odd hard weeks the ladder on the track by lap pace, even hard weeks 4 × 4 min on the hill (600 m up + 170 m flat)
  const laddrTrack = (s, sp) => { const m = sp != null ? Math.round(sp * (s.workSec / 3600) * 100) * 10 : null; return {
    ko: `${noteTxt ? noteTxt + ' · ' : ''}${rec ? '회복주: 분량 × 0.7, 질 높은 세션은 짧게 유지 · ' : ''}${capNote ? capNote.ko + ' · ' : ''}부대 트랙 · 워밍업 10분 조깅(처음 7분 천천히 → 마지막 3분 점점 빠르게) → 구간 ${s.reps}×${s.workSec / 60}분 @ 400 m ${lapTime(sp)}(= ${sp != null ? f1(sp) : '–'} km/h${s.speedOffset ? ', MLSS − 0.3: 15분 이상 구간은 MLSS 바로 아래' : ', MLSS 속도'}; 구간 ≈ ${m ?? '–'} m), 심박 ${hrTxt(T2)} · ${ceilKo.replace(', 구간 간 젖산 상승 > 1.0', '')} · 회복 ${s.restSec / 60}분 천천히 조깅(페이스 무관; 끝에 심박이 ${steady ? steady.hrHi : '–'} 위면 피로 표시) · 쿨다운 6분 조깅 → 걷기 · 바람·추위로 바퀴마다 1–2 % 흔들림 — 구간 평균으로 보고 맞바람 바퀴는 쫓지 않기 · 트랙에서는 젖산 채혈 없음(추위·땀으로 손끝 값 신뢰도 ↓ — 사다리의 젖산 목표는 헬스장 MLSS 검증이 맡음) · 비·빙판이면 무동력에서 같은 시간 구조, 심박 ${hrTxt(T2)}만 · 워밍업 중 덱스트로스 30 g + 물 500 mL · 끝나면 RPE(CR-10) 입력`,
    en: `${noteTxt ? noteTxt + ' · ' : ''}${rec ? 'recovery week: volume × 0.7, the quality session kept short · ' : ''}${capNote ? capNote.en + ' · ' : ''}the unit's track · warm-up 10 min jog (7 min easy → the last 3 min building) → reps ${s.reps} × ${s.workSec / 60} min at ${lapTime(sp)} per 400 m (= ${sp != null ? f1(sp) : '–'} km/h${s.speedOffset ? ', MLSS − 0.3: reps of 15 min and more sit just under MLSS' : ', MLSS speed'}; ≈ ${m ?? '–'} m a rep), HR ${hrTxt(T2)} · ${ceilEn.replace(', a lactate rise > 1.0 between reps', '')} · recovery ${s.restSec / 60}-min easy jog (any pace; HR above ${steady ? steady.hrHi : '–'} at its end = a fatigue flag) · cool-down 6 min jog → walk · wind and cold move single laps by 1–2 % — judge the rep's average and do not chase a headwind lap · no lactate on the track (cold and sweat make finger samples unreliable — the gym's MLSS check owns the ladder's lactate target) · rain or ice → the same time structure on the non-motorized treadmill, HR ${hrTxt(T2)} only · dextrose 30 g + 500 mL water in the warm-up · enter the session RPE (CR-10) at the end` }; };
  const hillVo2 = (s, test = false) => { const vm = Number.isFinite(vo2Sp) ? Math.round(vo2Sp * (s.workSec / 3600) * 100) * 10 : null; return {
    ko: `${noteTxt ? noteTxt + ' · ' : ''}부대 언덕(오르막 600 m + 평지 170 m) · 워밍업 10분 조깅(마지막 3분 점점 빠르게) → 구간 ${s.reps}×4분: 언덕 아래에서 출발 → 오르막 → 이어서 평지, 4:00에 그 자리에서 멈춤 — 첫 구간에서 그 지점을 표시하고 2–${s.reps}회차는 그 지점까지 · 심박 목표 ${hrTxt(TV)}(최대 심박의 90–95 %, 구간 후반; 2:30까지는 올라가는 중) · 4:00 전에 770 m 끝에 닿으면 4분 강도로는 너무 빠름 → 다음 구간 낮추기 · 회복 = 내려오는 조깅 약 3분 · 쿨다운 6분 조깅 → 걷기 · 언덕을 못 쓰면 트랙 ${s.reps}×4분 @ 400 m ${lapTime(vo2Sp)}(${Number.isFinite(vo2Sp) ? f1(vo2Sp) : '–'} km/h, 구간 ≈ ${vm ?? '–'} m) · 비·빙판이면 무동력 ${s.reps}×4분, 심박만 · 젖산 채혈 없음 · 워밍업 중 덱스트로스 30 g + 물 500 mL${test ? ' · 검정 주: 3회만' : ''} · 끝나면 RPE 입력`,
    en: `${noteTxt ? noteTxt + ' · ' : ''}the unit's hill (600 m up + 170 m flat) · warm-up 10 min jog (the last 3 min building) → reps ${s.reps} × 4 min: start at the bottom → climb → on onto the flat, stop where you are at 4:00 — mark that spot on the first rep and reach it on reps 2–${s.reps} · HR target ${hrTxt(TV)} (90–95 % of max, the second half of each rep; still rising until 2:30) · reaching the end of the 770 m before 4:00 = too fast for a 4-min effort → ease off on the next rep · recovery = jog back down, about 3 min · cool-down 6 min jog → walk · no hill available → the track, ${s.reps} × 4 min at ${lapTime(vo2Sp)} per 400 m (${Number.isFinite(vo2Sp) ? f1(vo2Sp) : '–'} km/h, ≈ ${vm ?? '–'} m a rep) · rain or ice → ${s.reps} × 4 min on the non-motorized treadmill, HR only · no lactate sample · dextrose 30 g + 500 mL water in the warm-up${test ? ' · test week: 3 reps only' : ''} · enter the session RPE at the end` }; };
  // v1.1.44 — the Saturday of the week (the calendar first, else the alternation) decides the optional weekday session: a VO₂max-type Saturday
  // (4×4, the third split part, a step test, the time trial, the test week) leaves the weekday the tempo; a threshold-type or light Saturday leaves it the hill 4×4
  const satKind = K.includes('split1') ? 'split1' : K.includes('split2') ? 'split2' : K.includes('split3') ? 'split3' : K.includes('step') ? 'step' : K.includes('tt') ? 'tt' : K.includes('test') ? 'test' : (K.includes('mlss') || K.includes('fixed') || K.includes('ladder')) ? 'fixed' : K.includes('lt1') ? 'lt1' : K.includes('vo2') ? 'vo2' : (rec || K.includes('easy')) ? 'easy' : satQuality(week);
  const satHard = ['split3', 'step', 'tt', 'test', 'vo2'].includes(satKind);
  const tempoDay = () => { const TT = sessionTargets(zones, 'tempo'); return at({ day: 2, type: 'lt2', kind: 'tempo', ko: '템포 25분 (선택, 주 1)', en: 'Tempo 25 min (optional, once a week)', minutes: Math.round((TEMPO_STRUCTURE.warmupSec + TEMPO_STRUCTURE.workSec + TEMPO_STRUCTURE.cooldownSec) / 60), hr: TT ? { hrLo: TT.hrLo, hrHi: TT.hrHi } : null, structure: { ...TEMPO_STRUCTURE }, speed: null, note: {
    ko: `${noteTxt ? noteTxt + ' · ' : ''}부대 트랙 또는 무동력 · 워밍업 10분 조깅(추우면 15) → 25분 심박 ${hrTxt(TT)}(존3 = LT1 + 1 … LT2 − 5; 처음 5분은 올라가는 중, 판정 없음) · 위로 60초 넘으면 늦추기 · 쿨다운 3분 걷기 · 이번 주 토요일이 VO₂max형 세션이라 평일 선택 세션은 템포 · 토요일과 ≥ 48 h(화·수) · 통증 ≥ 3·안정 심박 +7이면 쉬운 조깅으로 · 끝나면 RPE(CR-10)`,
    en: `${noteTxt ? noteTxt + ' · ' : ''}the unit's track or the non-motorized treadmill · warm-up 10 min jog (15 when cold) → 25 min at HR ${hrTxt(TT)} (zone 3 = LT1 + 1 … LT2 − 5; still rising for 5 min, no cue) · 60 s above → slower · cool-down 3 min walk · this Saturday is a VO₂max-type session, so the optional weekday one is the tempo · ≥ 48 h before Saturday (Tue / Wed) · pain ≥ 3 or resting HR + 7 → an easy jog instead · session RPE (CR-10) at the end` } }, 'track'); };
  const hillDay = (sx, test = false) => at({ day: 2, type: 'lt2', kind: 'vo2', ko: `VO₂max 언덕 ${sx.reps}×4분${test ? ' (검정 주)' : ' (선택, 주 1)'}`, en: `VO₂max hill reps ${sx.reps}×4 min${test ? ' (test week)' : ' (optional, once a week)'}`, minutes: Math.round((sx.warmupSec + sx.reps * sx.workSec + (sx.reps - 1) * sx.restSec + sx.cooldownSec) / 60), hr: TV ? { hrLo: TV.hrLo, hrHi: TV.hrHi } : null, structure: sx, speed: Number.isFinite(vo2Sp) ? vo2Sp : null, note: hillVo2(sx, test) }, 'hill');
  let tue;
  if (rec || K.includes('easy') || K.includes('blood')) tue = unitEasy(2, jogMin, { pre: { ko: noteTxt || '이번 주는 평일 고강도 없음', en: noteTxt || 'no weekday hard session this week' } });
  else if (K.includes('test')) tue = hillDay({ ...VO2_STRUCTURE, reps: 3, label: '검정 주 자극 3×4분 / test-week sharpener 3×4 min' }, true);
  else if (satHard) tue = tempoDay();
  else tue = hillDay({ ...VO2_STRUCTURE });
  // Thursday — the unit: an easy 45 (the LT1 check moved to Saturday at the gym); no run on a blood-draw morning; 20 + strides in a test week
  const thu = K.includes('test')
    ? unitEasy(4, 20, { ko: ' + 스트라이드 (검정 주)', en: ' + strides (test week)', strides: true, pre: { ko: '검정 전 마지막 달리기 · LT1 검사 없음', en: 'the last run before the test · no LT1 check' } })
    : K.includes('blood')
    ? at({ day: 4, type: 'rest', ko: '달리기 0분 — 혈액검사 아침', en: 'No run (0 min) — blood-test morning', minutes: 0, hr: null, note: { ko: '전날 22:00부터 금식(물 가능) · 공복 채혈 뒤 아침 식사 · 토요일 헬스장 일정은 그대로', en: 'fasting from 22:00 the night before (water allowed) · breakfast after the draw · the Saturday gym session stays' } }, 'unit')
    : unitEasy(4, jogMin, { strides: true, ko: ' (여유 있으면 30)', en: ' (30 if there is time)' });
  // the long run: one end sample every other long run (v1.1.35) — at this intensity lactate stays flat and heart rate drifts, so the heart-rate ceiling and the RPE carry the durability reading
  const sampleWeek = Math.max(1, longWeek) % 2 === 0;
  const longRun = { day: 6, type: 'long', ko: `롱런 ${longMin}분`, en: `Long run ${longMin} min`, minutes: longMin, hr: steady, speed: lt1Speed != null ? Math.round((lt1Speed - 1.2) * 10) / 10 : null, note: { ko: `공복 · 0–5분 ${wu ? wu.lo : '–'} → 본 구간 ${lt1Speed != null ? f1(lt1Speed - 1.2) : '–'} km/h → 마지막 5분 걷기 5.5 · 심박 0–60분 ≤ ${steady ? steady.hrHi : '–'}, 60분 이후 ≤ ${lt1Hr != null ? lt1Hr + 2 : '–'} — 60초 넘으면 −0.3 km/h · ${sampleWeek ? '종료 채혈 1회(두 손가락, 쿨다운 전) — 격주의 채혈 주' : '이번 롱런은 채혈 없음(격주) — 심박 드리프트와 RPE로 판단'} · 물은 갈증대로(처음 한 번 달리기 전후 체중을 재서 땀 양 확인, 감량 < 2 %) · 덱스트로스 30 g = 30분·60분에 15 g씩 · 실내 ≥ 20 °C면 선풍기 · 판정(채혈 주): 종료 ≤ 2.0 → 양호, 2.0–2.5 → 지속시간 상승(존 변경 없음), > 2.5 → 다음 롱런 −0.3${longCap ? ` · 상한 = 30일 최장 ${longCap.longestMin}분 × 1.1` : ''}${rec ? ' · 회복주 × 0.7' : ''} · 끝나면 RPE 입력`, en: `fasted · 0–5 min at ${wu ? wu.lo : '–'} → main part at ${lt1Speed != null ? f1(lt1Speed - 1.2) : '–'} km/h → last 5 min walk at 5.5 · HR ≤ ${steady ? steady.hrHi : '–'} for 0–60 min, ≤ ${lt1Hr != null ? lt1Hr + 2 : '–'} after — 60 s above → −0.3 km/h · ${sampleWeek ? 'one end sample (two fingers, before the cool-down) — this is a sampling week' : 'no sample this long run (every other week) — durability from heart-rate drift and RPE'} · drink to thirst (weigh yourself before and after once to learn the sweat rate; loss < 2 %) · dextrose 30 g = 15 g at 30 and at 60 min · fan when the room is ≥ 20 °C · verdict (sampling weeks): end ≤ 2.0 → good, 2.0–2.5 → a rise from duration (no zone change), > 2.5 → next long run −0.3${longCap ? ` · cap = 110 % of the 30-day longest (${longCap.longestMin} min)` : ''}${rec ? ' · recovery week × 0.7' : ''} · enter the session RPE at the end` } };
  const sat = K.includes('step')
    ? { day: 6, type: 'test', ko: '계단 테스트 (젖산)', en: 'Step test (lactate)', minutes: 60, hr: null, note: { ko: `롱런 대신 · 공복, 카페인 없음(전날 14:00부터), 식단은 검사 2주 전부터 그대로 · 워밍업 5분 걷기 5.5 → 설정 → 프로토콜대로 4분 단계(시작 6.0, +1.0 km/h, 경사 1 %) + 30초 채혈 정지 · 종료 = 심박 ≥ 최대 심박의 95 % 또는 단계 미완수, 젖산 6.0은 4 mmol 지점에서 두 단계가 지난 뒤에만(매번 같은 종료점) · LT1 양옆 두 단계는 2회 채혈(차이 > 0.3이면 3회) · 끝나면 결과 적용(역치·검증 상한)`, en: `instead of the long run · fasted, no caffeine since 14:00 the day before, the diet unchanged for the 2 weeks before · 5-min walk at 5.5 → stages per Settings → Protocol: 4 min, start 6.0, +1.0 km/h, 1 % incline, 30-s sampling pauses · stop at HR ≥ 95 % of max or an uncompleted stage; lactate 6.0 ends it only once two stages past the 4-mmol point are done (the same end point every time) · the two stages around LT1 sampled twice (a 3rd if they differ by > 0.3) · apply the result after (thresholds, test-speed cap)` } }
    : K.includes('test')
    ? { day: 6, type: 'rest', ko: '검정일 또는 휴식 (롱런 없음)', en: 'Test day or rest (no long run)', minutes: 0, hr: null, note: { ko: '검정이 다른 날이면 오늘은 휴식 또는 걷기 20분 · 카페인 3–4.5 mg/kg은 훈련에서 먼저 시험한 양만', en: 'if the test is on another day, rest or a 20-min walk today · caffeine 3–4.5 mg/kg only at a dose rehearsed in training' } }
    : null;
  // Saturday — the gym 09:00 (v1.1.44): the calendar's session (split step test 1–3, fixed-speed test, 4×4, step test, time trial, two-lap LT1 check), else the alternation fixed-speed test ↔ 4×4; a light week an easy 50; then the barbell lifts
  const mlssDay = { day: 6, type: 'verify', purpose: 'mlss', ko: 'MLSS 검증 30분 (두 랩 MLSS 변형)', en: 'MLSS check 30 min (two-lap MLSS variant)', minutes: 37, hr: T2, speed: lt2Sp, note: { ko: `${GYM.ko} · 식후(사다리와 같은 조건: 워밍업 중 덱스트로스 30 g + 물 500 mL, 전날 탄수 5–7 g/kg) · 경사 1 % · 워밍업 5분 = 2분 ${wu ? wu.hi : '–'} → 3분 ${lt1Speed != null ? f1(lt1Speed - 0.2) : '–'} km/h → 랩 1 10분 @ LT2 속도${lt2Sp != null ? ` ${f1(lt2Sp)} km/h` : ''}(심박 ${hrTxt(T2)}) → 정지 ≤ 30초(매번 같게, 채혈은 30초에) → 랩 2 20분 → 종료 채혈 → 걷기 5분 5.5 · 상승 ≤ 0.5 → 통과: 같은 속도에서 통과 2회면 다음 +0.3(정지가 상승을 무디게 해 한 번으로는 올리지 않음) · 0.5–1.0 → 그 속도가 MLSS, 유지 · > 1.0 → −0.4 · 정지 > 3분이면 상향 없음 · 종료 젖산 = 본인 MLSS 젖산 → 설정 → 역치에 저장(사다리 목표 ± 0.5) · 스트립 2 + 여분 1 · 다음 날은 롱런 대신 쉬운 런 · 끝나면 RPE 입력`, en: `${GYM.en} · fed (same conditions as the ladder: dextrose 30 g + 500 mL water in the warm-up, carbohydrate 5–7 g/kg the day before) · incline 1 % · warm-up 5 min = 2 min at ${wu ? wu.hi : '–'} → 3 min at ${lt1Speed != null ? f1(lt1Speed - 0.2) : '–'} km/h → lap 1 10 min at the LT2 speed${lt2Sp != null ? ` ${f1(lt2Sp)} km/h` : ''} (HR ${hrTxt(T2)}) → stop ≤ 30 s (the same every time, sample at 30 s) → lap 2 20 min → end sample → 5 min walk at 5.5 · rise ≤ 0.5 → pass: two passes at the same speed → +0.3 next time (a stop blunts the rise, so one pass never raises it) · 0.5–1.0 → that speed is the MLSS, hold · > 1.0 → −0.4 · a stop over 3 min → no raise · the end value = your MLSS lactate → save it in Settings → thresholds (the ladder target ± 0.5) · 2 strips + 1 spare · the next day an easy run instead of the long run · enter the session RPE at the end` } };
  const checkDay = { day: 6, type: 'verify', ko: `LT1 검증 달리기 (두 랩${vs != null ? `, ${vs.toFixed(1)} km/h` : ''})`, en: `LT1 verification run (two laps${vs != null ? `, ${vs.toFixed(1)} km/h` : ''})`, minutes: 45, hr: steady, speed: vs, note: { ko: `${GYM.ko} · 공복 · 매번 같은 시각 ± 30분 · 경사 1 % · 금요일 휴식 뒤 · 워밍업 5분 = 0:30 걷기 5.5 → 4:30 ${wu ? wu.lo : '–'} km/h(5분에 심박 < ${z1Top ?? '–'}) → 랩 1 10분 @ 검사 속도 → 간격 60–90초(서서, 정지 30–45초 뒤 채혈, 상한 3분) → 랩 2 30분 → 종료 채혈 → 걷기 5분 5.5 · 스트립 2개(판정선 ± 0.2 안이면 3개) · 통과 +0.3 / 경계 유지 / 실패 −0.3(0.2 단계는 재검사 오차 4 % 안) · ${GATE.ko} — 발동이면 쉬운 런 45분으로 바꾸고 다음 토요일 같은 속도 · 끝나면 RPE 입력 · 검사 뒤 ${STAIRS.ko}`, en: `${GYM.en} · fasted · same clock time ± 30 min every time · incline 1 % · after the Friday rest · warm-up 5 min = 0:30 walk at 5.5 → 4:30 at ${wu ? wu.lo : '–'} km/h (HR < ${z1Top ?? '–'} at 5:00) → lap 1 10 min at the test speed → gap 60–90 s (stand still, sample 30–45 s after the stop, cap 3 min) → lap 2 30 min → end sample → 5 min walk at 5.5 · 2 strips (a 3rd within ± 0.2 of the line) · pass +0.3 / borderline same / fail −0.3 (a 0.2 step is inside the 4 % test–retest error) · ${GATE.en} — on a trigger run an easy 45 and repeat next Saturday at the same speed · enter the session RPE at the end · after the check, ${STAIRS.en}` } };
  const gymEasy = (day, min, slow = false, extra = null) => { const x = easyDay(day, min, '', '', false, slow); return { ...x, note: { ko: `${GYM.ko} · ${x.note.ko}${extra ? ' · ' + extra.ko : ''}`, en: `${GYM.en} · ${x.note.en}${extra ? ' · ' + extra.en : ''}` } }; };
  const PRO = protocol || null;
  const splitDay = n => { const sp = splitPart(n, PRO); const stageList = sp.speeds.map((v, k) => `${sp.run[k]}: ${f1(v)}${sp.measure.includes(sp.run[k]) ? '●' : ''}`).join(' · '); return { day: 6, type: 'test', split: n, ko: `분할 계단 ${n}/3 — 단계 ${sp.run[0]}–${sp.last}, 채혈 ${sp.measure.join('·')}`, en: `Split step test ${n}/3 — stages ${sp.run[0]}–${sp.last}, sampled at ${sp.measure.join(' and ')}`, minutes: sp.minutes, hr: null, speed: null, note: {
    ko: `${GYM.ko} · 공복, 카페인 없음(전날 14:00부터), 금 휴식, 식단은 블록 내내 그대로 · 걷기 5분 5.5 → 4분 단계 + 정지 30초(채혈 없는 단계도 같은 정지: 연속 검사와 같은 누적 상태) · ${stageList} (● = 채혈, 정지 30초에; 판정선 ± 0.2면 2장) · 경사 1 % · 종료 = 마지막 단계 뒤 자동(심박 ≥ 최대 심박의 95 %나 단계 미완수면 그 전에) · 세 부분이 분석 탭에서 한 곡선으로 합쳐짐 → LT1(최저 + 0.5)·LT2(ModDmax) → 「역치 적용」 · 끝나면 바벨 3종목(3/3 뒤엔 가볍게)`,
    en: `${GYM.en} · fasted, no caffeine since 14:00 the day before, Friday rest, the diet unchanged through the block · 5-min walk at 5.5 → 4-min stages + 30-s stop (the unmeasured stages stop the same way: the same accumulated state as in one continuous test) · ${stageList} (● = sample, at 30 s of the stop; two strips within ± 0.2 of the line) · incline 1 % · ends by itself after the last stage (earlier on HR ≥ 95 % of max or an unfinished stage) · the three parts merge into one curve on the Analysis tab → LT1 (lowest + 0.5) · LT2 (ModDmax) → "apply thresholds" · then the three barbell lifts (lighter after part 3)` } }; };
  const fixedDay = { ...mlssDay, fixed: true, ko: `고정 속도 검사 30분 @ ${lt2Sp != null ? f1(lt2Sp) : '–'} km/h (10 + 20, 스트립 2)`, en: `Fixed-speed test 30 min at ${lt2Sp != null ? f1(lt2Sp) : '–'} km/h (10 + 20, two strips)`, note: { ko: `${mlssDay.note.ko} · 매주 같은 조건·같은 속도: 종료값·상승·심박·RPE를 추세로 읽음(분석 탭 「같은 속도 추세」) — 기준 주 대비 2주 연속 ≥ 0.5 ↓ + 심박 ≥ 3 ↓ → +0.3, ≥ 0.5 ↑ + 심박 ≥ 5 ↑ → 피로·질병·식단 점검, ± 0.3 안 → 유지 · 끝나면 바벨 3종목`, en: `${mlssDay.note.en} · the same speed under the same conditions every week: end value, rise, heart rate and RPE read as a trend (Analysis → "same-speed trend") — against the first week, two weeks running ≥ 0.5 lower with the heart rate ≥ 3 lower → +0.3; ≥ 0.5 higher with the heart rate ≥ 5 higher → check fatigue, illness and diet; inside ± 0.3 → hold · then the three barbell lifts` } };
  const ttDay = { day: 6, type: 'rest', tt: true, ko: '3 km 모의 검정 (트랙 평지)', en: '3-km time trial (flat track)', minutes: 25, hr: null, speed: null, note: { ko: `트랙 평지(내리막 기록 무효) · 금 휴식, 목 쉬운 조깅 20분 + 스트라이드 4×20초 · 워밍업 10분 조깅 + 스트라이드 2회 → 3 km 전력 → 걷기 10분 · 결과를 설정 → 역치의 3 km 페이스에 적기(4×4 속도 = 페이스 − 1, 스트라이드가 따라 바뀜) · 카페인은 훈련에서 시험한 양만 · 내일은 쉬운 런 50`, en: `a flat track (a downhill time does not count) · Friday rest, Thursday an easy 20-min jog + 4 × 20-s strides · warm-up 10 min jog + 2 strides → 3 km all out → 10 min walk · enter the result as the 3-km pace in Settings → thresholds (the 4×4 speed = pace − 1 and the strides follow) · caffeine only at a dose rehearsed in training · tomorrow an easy 50` } };
  const vo2Sat = { day: 6, type: 'lt2', kind: 'vo2', ko: 'VO₂max 4×4분 (트레드밀)', en: 'VO₂max 4×4 min (treadmill)', minutes: Math.round((VO2_STRUCTURE.warmupSec + 4 * VO2_STRUCTURE.workSec + 3 * VO2_STRUCTURE.restSec + VO2_STRUCTURE.cooldownSec) / 60), hr: TV ? { hrLo: TV.hrLo, hrHi: TV.hrHi } : null, structure: { ...VO2_STRUCTURE }, speed: Number.isFinite(vo2Sp) ? vo2Sp : null, note: { ko: `${GYM.ko} · 워밍업 10분 = 4분 ${wu ? wu.hi : '–'} → 3분 ${lt1Speed != null ? f1(lt1Speed - 0.2) : '–'} → 3분 ${lt2Sp != null ? f1(lt2Sp - 1.0) : '–'} → 4×4분 @ ${Number.isFinite(vo2Sp) ? f1(vo2Sp) : '–'} km/h(3 km 페이스 − 1), 심박 ${hrTxt(TV)}(구간 후반; 2:30까지는 판정 없음) · 회복 3분 조깅 ${lt1Speed != null ? f1(lt1Speed - 2.2) : '–'} → 쿨다운 6분 · 마지막 구간을 같은 속도로 못 끝내면 다음 −0.3, 모든 구간이 90 %에 못 미치면 +0.3 · 전날 탄수 + 워밍업 덱스트로스 · 끝나면 RPE → 바벨 3종목`, en: `${GYM.en} · warm-up 10 min = 4 min at ${wu ? wu.hi : '–'} → 3 min at ${lt1Speed != null ? f1(lt1Speed - 0.2) : '–'} → 3 min at ${lt2Sp != null ? f1(lt2Sp - 1.0) : '–'} → 4 × 4 min at ${Number.isFinite(vo2Sp) ? f1(vo2Sp) : '–'} km/h (3-km pace − 1), HR ${hrTxt(TV)} (second half of each rep; no cue until 2:30) · 3-min recovery jog at ${lt1Speed != null ? f1(lt1Speed - 2.2) : '–'} → cool-down 6 min · last rep not held at the speed → next time −0.3; no rep reaching 90 % → +0.3 · carbohydrate the day before + dextrose in the warm-up · RPE at the end → the three barbell lifts` } };
  const satMain = satKind === 'split1' ? splitDay(1) : satKind === 'split2' ? splitDay(2) : satKind === 'split3' ? splitDay(3)
    : satKind === 'step' ? { ...sat, note: { ko: `${GYM.ko} · ${sat.note.ko} · 다음 날은 롱런 대신 쉬운 런`, en: `${GYM.en} · ${sat.note.en} · the next day an easy run instead of the long run` } }
    : satKind === 'tt' ? ttDay
    : satKind === 'test' ? sat
    : satKind === 'fixed' ? fixedDay
    : satKind === 'lt1' ? checkDay
    : satKind === 'vo2' ? vo2Sat
    : { ...gymEasy(6, 50, false, STAIRS), ko: '쉬운 런 50분 (가벼운 주)', en: 'Easy run 50 min (light week)' };
  // Sunday — the gym 09:00: the long run, except the day after a step test or an MLSS check (a test to exhaustion the day before distorts a 90-min run)
  const testedSat = ['split3', 'step', 'tt'].includes(satKind); // v1.1.44: the day after the exhaustive Saturdays an easy 50; after the fixed-speed test or the 4×4 the long run stays (it is easy)
  const longDay = { ...longRun, day: 0, note: { ko: `${GYM.ko} · ${longRun.note.ko}`, en: `${GYM.en} · ${longRun.note.en}` } };
  const sunMain = K.includes('test') ? gymEasy(0, Math.min(50, Math.max(30, r5(weekendMin * 0.5))), true) : testedSat ? gymEasy(0, 50) : longDay;
  const satoff = K.includes('satoff'); // the Saturday is taken (e.g. an exam): Saturday's session moves to Sunday, Sunday's own is dropped
  const SAT_EVE = { ko: '달리기 뒤 바벨 스쿼트·데드리프트·OHP 3세트씩(≥ 80 % 1RM; 검사가 무거웠으면 −10 %) · 혈압 ≥ 120이면 월 싯 4×2분 · 선택: 천국의 계단 20분 · 저녁 운동 없음', en: 'after the run the barbell squat, deadlift and overhead press, 3 sets each (≥ 80 % 1RM; −10 % after a heavy test) · wall sits 4 × 2 min if BP ≥ 120 · optional StairMaster 20 min · no evening exercise' };
  const WEEKDAY_EVE = { ko: '달리기 직후 맨몸 근력 1세트씩 — 스플릿 스쿼트·푸시업·친업(주 1회면 완료, 2회면 더 좋음) · 걷기 7,000보 이상 · 30–60분마다 일어서기 · 그 밖의 평일 운동 없음', en: 'right after the run one set each of the bodyweight circuit — split squat, push-up, chin-up (once a week completes it, twice is better) · 7,000+ steps a day · stand up every 30–60 min · nothing else on weekdays' };
  const sunEve = d => (d.type === 'long' ? { ko: '점심·저녁 운동 0분 (롱런 날)', en: 'noon and evening: no exercise (long-run day)' } : d.type === 'lt1' ? { ko: `16:30 경사 걷기 30분 (선택) — 경사 8–12 %, 4.5–5.5 km/h, 심박 ≤ ${steady ? steady.hrLo : '–'}(넘으면 경사 −2 %) · ${GATE.ko}`, en: `16:30 incline walk 30 min (optional) — incline 8–12 %, 4.5–5.5 km/h, HR ≤ ${steady ? steady.hrLo : '–'} (over it → incline −2 %) · ${GATE.en}` } : SAT_EVE);
  const satDay = satoff ? at({ day: 6, type: 'rest', ko: '토요일 일정 없음 (세션은 일요일로)', en: 'Saturday taken (the session moves to Sunday)', minutes: 0, hr: null, speed: null, note: { ko: `${noteTxt || '토요일 다른 일정'} · 토요일 세션을 일요일 09:00 헬스장에서 · 이번 주 일요일 롱런 없음`, en: `${noteTxt || 'Saturday taken'} · Saturday's session runs on Sunday 09:00 at the gym · no long run this Sunday` } }, 'gym') : at(satMain, 'gym');
  const sunDay = satoff ? at({ ...satMain, day: 0 }, 'gym') : at(sunMain, 'gym');
  const days = [
    { ...unitEasy(1, jogMin, { strides: true, ko: ' (여유 있으면 30)', en: ' (30 if there is time)' }), evening: WEEKDAY_EVE },
    { ...tue, evening: WEEKDAY_EVE },
    { ...unitEasy(3, jogMin, { strides: true, ko: ' (여유 있으면 30)', en: ' (30 if there is time)' }), evening: WEEKDAY_EVE },
    { ...thu, evening: WEEKDAY_EVE },
    { day: 5, type: 'rest', place: 'unit', surface: 'outdoor', ko: '휴식 (달리기 없음)', en: 'Rest (no run)', minutes: 0, hr: null, speed: null, note: { ko: '달리기는 주 6일까지(주 7일은 남성에서 부상 위험 5.9배, Fredette 2022) · 내일 토요일 세션 전 휴식 · 걷기는 그대로 · 평일 할당이 남았으면 쉬운 조깅 20분은 가능', en: 'Running on 6 days a week at most (7 days carried 5.9× the injury risk in men, Fredette 2022) · rest before Saturday\'s session · keep walking · an easy 20-min jog is allowed while the weekday quota is open' }, evening: { ko: '걷기 7,000보 이상 · 30–60분마다 일어서기 · 내일 검사면 카페인 없음(14:00부터), 저녁 식사는 평소대로', en: '7,000+ steps · stand up every 30–60 min · no caffeine from 14:00 before a test day, dinner as usual' } },
    { ...satDay, evening: SAT_EVE },
    { ...sunDay, evening: sunEve(sunDay) },
  ];
  const total = days.reduce((s, d) => s + d.minutes, 0); const hard = days.filter(d => d.type === 'lt2' || d.type === 'tempo' || d.purpose === 'mlss').reduce((s, d) => s + d.minutes * 0.55, 0);
  return { week, blockWeek, longWeek, recovery: rec, light: lightWeek, satKind, hardKind: tue.kind || (tue.purpose === 'mlss' ? 'mlss' : 'easy'), kinds: K.slice(), notes: (notes || []).slice(), days, totalMin: total, hardPct: total ? Math.round(100 * hard / total) : 0, longCap, hardCap: capNote, plyoContacts: plyo, speeds: T1 ? { lt1: [T1.speedLo, T1.speedHi], lt2: T2 ? [T2.speedLo, T2.speedHi] : null, vo2: Number.isFinite(vo2Sp) ? vo2Sp : null } : null, gate: GATE };
}

/** Why the week looks like this (the Oct 10 review, revised by the Oct 17 review — in the Plan tab). */
export const PLAN_WHY = [
  { ko: '원칙(10/31): 분을 효과가 큰 자리에 — 주 1회 고강도(+ 선택 1), 주 1회 롱런, 나머지는 최소. 훈련량이 적을수록 쉬운 분량이 아니라 강도가 체력을 사며(Storoschuk 2025), HIIT는 세션 약 11분에서 VO₂max 효과의 80 %에 닿음(Sports Med 2026). 평일 최소·주말 집중: 주 1–2일에 모아도 매일 나눈 것과 사망률 이득이 같고(Huang 2025), 강도만 지키면 주 2회로 지구력이 15주 유지됨(Spiering 2021).', en: 'Principle (Oct 31): put each minute where it does the most — one hard session a week (+ one optional), one long run, the rest minimal. With little training time it is intensity, not easy volume, that buys fitness (Storoschuk 2025), and HIIT reaches 80 % of its VO₂max effect at about 11 min a session (Sports Med 2026). Lightest weekdays, the weekend concentrated: activity packed into 1–2 days carries the same mortality benefit as activity spread out (Huang 2025), and with the intensity kept two sessions a week hold endurance for 15 weeks (Spiering 2021).' },
  { ko: '평일(부대): 걷기 7,000보 이상(2,000보 대비 사망 −47 %, Ding 2025) + 쉬운 조깅 20분 × 1–2(심박 133–140, 아무 때나; 0회도 허용) + 달리기 직후 맨몸 근력 1세트. 선택 세션 주 1(화·수): 토요일이 VO₂max형이면 템포 25분(심박 144–152), 역치형이면 언덕 4×4. 평일 고강도를 매일 하지 않는 이유: 존1에서 존2로 흘러간 집단은 정체(Seiler & Tønnessen 2009).', en: 'Weekdays (the unit): 7,000+ steps (−47 % mortality vs 2,000, Ding 2025) + an easy 20-min jog once or twice (HR 133–140, whenever it fits; none is allowed) + one set of bodyweight strength right after. One optional session a week (Tue / Wed): the tempo 25 min (HR 144–152) when Saturday is the VO₂max type, the hill 4×4 when it is the threshold type. Not every morning hard: the group whose zone 1 drifted into zone 2 stagnated (Seiler & Tønnessen 2009).' },
  { ko: '토요일(헬스장 트레드밀 09:00): 정밀한 것은 전부 여기 — 고정 속도·젖산·질 세션. 달력이 정하면 그 세션(분할 계단 1–3 → 고정 속도 검사 → 3 km 모의 검정), 아니면 고정 속도 검사(LT2 속도 10 + 20분, 스트립 2) ↔ 4×4 격주. 그 뒤 바벨 스쿼트·데드리프트·OHP(≥ 80 % 1RM: 러닝 경제성은 그 위에서만, Llanos-Lagos 2024; 주 60–120분 근력이 사망률 최저, Zhang 2026).', en: 'Saturday (gym treadmill 09:00): everything precise lives here — the fixed speed, the lactate, the quality session. The calendar\'s session when it names one (split step test 1–3 → fixed-speed test → 3-km time trial), else the fixed-speed test (the LT2 speed, 10 + 20 min, two strips) ↔ the 4×4 on alternate weeks. Then the barbell squat, deadlift and overhead press (≥ 80 % 1RM: running economy improves only above it, Llanos-Lagos 2024; 60–120 min of lifting a week carries the lowest mortality, Zhang 2026).' },
  { ko: '젖산은 주 2개: 분할 계단 테스트(3주 — 매주 앞 단계는 측정 없이 그대로 달려 연속 검사와 같은 누적 상태를 만들고 마지막 두 단계만 채혈; 세 부분을 한 곡선으로 합침) → 그 뒤 같은 속도에서의 추세. 전체 계단 테스트(60분, 스트립 11)는 쓰지 않음. 정지는 30초로 고정(길이가 흔들리면 상승이 무뎌짐, Beneke 2003). 최종 판정은 일정 속도 규칙: 상승 ≤ 0.5 통과 2회 → +0.3, 0.5–1.0 → MLSS, > 1.0 → −0.4(Heck 1985).', en: 'Lactate two strips a week: the split step test (three weeks — each week the earlier stages are run unmeasured so the measured stages sit on the same accumulated state as in one continuous test, the last two sampled; the three parts merge into one curve), then the trend at a fixed speed. No full step test (60 min, 11 strips). The stop is fixed at 30 s (a varying stop blunts the rise, Beneke 2003). The constant-speed rule has the last word: a rise ≤ 0.5 twice → +0.3, 0.5–1.0 → the MLSS, > 1.0 → −0.4 (Heck 1985).' },
  { ko: '일요일 롱런 60 @ LT1 − 1.2(심박 ≤ 140, 60분 뒤 ≤ 145): 지구력(피로 저항, Maunder 2021). 건강 이득은 이미 포화라 60으로 고정; 늘리는 건 다음 결정에서. 탈진형 토요일(분할 계단 3, 계단, 모의 검정) 다음 날은 쉬운 런 50.', en: 'Sunday long run 60 at LT1 − 1.2 (HR ≤ 140, ≤ 145 after 60 min): durability (Maunder 2021). The health benefit is already saturated, so it holds at 60; growing it is a later decision. The day after an exhaustive Saturday (split part 3, a step test, the time trial) an easy 50.' },
  { ko: '데이터로만 바뀜: 2주 실행률 < 50 % → 할당 −1, 2주 연속 완료 → +1(일·월 제안) · 쉬운 런 RPE ≥ 5 → 선택 세션 생략 · 7일 lnRMSSD 밴드 밖 → 쉬운 런, 안정 심박 +7 → 휴식, 통증 ≥ 3 → 쉬운 런 · 같은 속도 추세 2주 연속 ≥ 0.5 ↓ + 심박 ≥ 3 ↓ → +0.3 · 분할 계단 8주마다 → 역치 갱신 → 모든 숫자 재파생. 한 주 값으로는 아무것도 바꾸지 않음(스트립 ± 0.2–0.3, 재검사 CV 4 %).', en: 'Changes come from data only: two-week completion < 50 % → one fewer, two full weeks → one more (Sunday / Monday suggestions) · easy-run RPE ≥ 5 → skip the optional session · 7-day lnRMSSD outside its band → easy day, resting HR + 7 → rest, pain ≥ 3 → easy · same-speed trend two weeks ≥ 0.5 lower with HR ≥ 3 lower → +0.3 · the split step test every 8 weeks → thresholds → every number re-derived. Nothing changes on one week\'s value (strips ± 0.2–0.3, test–retest CV 4 %).' },
  { ko: '부상: 달리기 주 ≤ 6일(Fredette 2022), 단일 런 ≤ 30일 최장 × 1.1(Frandsen 2025), 고강도 간격 ≥ 48 h(Stanley 2013), 금 휴식, 토요일 워밍업 10분. 근력은 경제성·건강용 — 러너 부상 감소 효과는 2024 메타에서 입증되지 않음; 부상 레버는 부하 규칙. 용량 = 속도는 벨트에서만, 야외·무동력은 심박.', en: 'Injury: running on ≤ 6 days (Fredette 2022), no run beyond 110 % of the 30-day longest (Frandsen 2025), hard sessions ≥ 48 h apart (Stanley 2013), Friday rest, a 10-min warm-up on Saturday. Strength is for economy and health — its injury-prevention effect in runners was not shown in the 2024 meta-analysis; load rules are the lever. Speed is the dose only on the belt; outdoors and on the non-motorized treadmill, heart rate.' },
];
/** Per-session metrics used by insights and summaries. */
/**
 * A session recorded on the demo (virtual) strap that was really run without a strap (v1.1.32, owner: "스트랩 미휴대로 젖산만 측정"):
 * the clock, phases, laps, speed and lactate are real; the heart rate, RR and α1 were made up by the demo and are dropped. From then
 * on it counts like a real session (verdict, band finder, curve, longest run) with lactate only — a heart-rate figure is never taken from it.
 */
export function asLactateOnly(session) {
  const s = { ...session, sourceKind: 'nostrap', convertedFrom: session.sourceKind || 'demo', hrLive: [], rr: [], tiz: { totalSec: 0, inSec: 0 } };
  s.features = list(session.features).map(f => ({ t: f.t, stage: f.stage, phase: f.phase, rep: f.rep, paused: f.paused, hr: NaN, alpha1: NaN, rmssd: NaN, hrInst: null, artifactPct: 0, samples: 0 }));
  delete s.smo2Live; s.metrics = sessionMetrics(s); return s;
}
export const NO_HR_KINDS = ['nostrap'];
export function sessionMetrics(session) {
  // A Free / LT1 run in which something logged marks a stop (a lactate entry, Pause, the run end typed in the card) is measured up to
  // where the running ended and without the stops inside it. Every other session: the whole recording, as it always was.
  const logged = (session.type === 'free' || session.type === 'lt1' || session.type === 'verify') && list(session.hrLive).length > 0 && (session.type === 'verify' || Number.isFinite(session.runEndSec) || list(session.events).some(e => e.type === 'lactate' || e.type === 'pause'));
  const tl = logged ? runTimeline(session) : null; // (sessions with nothing logged — nearly all of them — are not even looked at)
  const cut = tl && tl.sure && (tl.how === 'sample' || tl.how === 'pause' || tl.how === 'manual' || tl.how === 'phase' || tl.stops.length) ? tl : null;
  const settle = alphaWindowMs(session);
  const feats = list(session.features).filter(f => !f.paused);
  const work = (cut ? list(session.features).filter(f => !alphaTainted(cut, f.t, settle)) : feats).filter(f => f.phase === 'work' || session.type === 'free'); // with a timeline its stops say what was running, not the Pause flag
  const a1 = work.filter(f => !(f.artifactPct >= ALPHA_ARTIFACT_MAX)).map(f => f.alpha1).filter(v => Number.isFinite(v)); // (α1 gate: a window with 3 % artifacts or more is left out)
  const allHr = list(session.hrLive).filter(p => p[1] > 0); const hrs = cut ? allHr.filter(p => p[0] <= cut.end && (!cut.twoLap || p[0] >= cut.start) && !inStop(cut, p[0])) : allHr; // (a two-lap run: the laps, not the warm-up)
  const n = hrs.length; const third = Math.floor(n / 3);
  // Cardiac drift: last third vs first third, excluding the first 5 min (ramp-up) when the session is long enough (≥ 15 min).
  const tStart = session.startedAt ?? (hrs.length ? hrs[0][0] : 0); const tLast = hrs.length ? hrs[hrs.length - 1][0] : 0;
  const skip = (tLast - tStart) >= 15 * 60000 ? 5 * 60000 : 0;
  const firstWin = hrs.filter(p => p[0] >= tStart + skip && p[0] < tStart + skip + (tLast - tStart - skip) / 3);
  const hr1 = firstWin.length ? mean(firstWin.map(p => p[1])) : (third ? mean(hrs.slice(0, third).map(p => p[1])) : NaN), hr3 = third ? mean(hrs.slice(n - third).map(p => p[1])) : NaN;
  const art = feats.length ? mean(feats.map(f => f.artifactPct)) : NaN;
  const endT = session.endedAt || (allHr.length ? allHr[allHr.length - 1][0] : (feats.length ? feats[feats.length - 1].t : null)); // the session's duration stays that of the recording
  const dur = endT && session.startedAt ? Math.max(0, (endT - session.startedAt - (session.pauseMs || 0)) / 1000) : 0;
  const tz = session.tiz; const tiz = tz && typeof tz.inSec === 'number' && typeof tz.totalSec === 'number' && tz.totalSec > 0 ? 100 * tz.inSec / tz.totalSec : NaN; // strings = a session recorded while the update interval was stored as text
  let maxHr = -Infinity; for (const p of hrs) if (p[1] > maxHr) maxHr = p[1];
  return { durationSec: dur, meanHr: n ? mean(hrs.map(p => p[1])) : NaN, maxHr: n ? maxHr : NaN, meanAlpha1: mean(a1), pctAlphaAbove75: a1.length ? 100 * a1.filter(v => v >= 0.75).length / a1.length : NaN, minAlpha1: a1.length ? Math.min(...a1) : NaN, driftPct: Number.isFinite(hr1) && hr1 ? 100 * (hr3 / hr1 - 1) : NaN, artifactPct: art, timeInZonePct: tiz, rrCount: (session.rr || []).length };
}

/**
 * Auto-adjustment rules from recent LT1 sessions (last 14 days) and test age. opts.restLactateAt (ms or ISO date): when the resting
 * baseline was measured — a monthly reminder to measure it again under the same conditions (v1.1.17).
 */
export function assessRecent(sessions, zones, lastTestAt, opts = {}) {
  const now = Date.now(); const recent = sessions.filter(s => s.type === 'lt1' && s.final && s.sourceKind !== 'demo' && now - s.startedAt < 14 * 86400000); // practice runs on the virtual strap never count
  const notes = []; const lt1Adjust = 0; const holdDuration = false; // v1.1.35: no target is moved by α1 any more and no duration is held by a drift figure — both are information now (review §5)
  const restAt = opts.restLactateAt != null ? new Date(opts.restLactateAt).getTime() : NaN; const restDays = Number.isFinite(restAt) ? Math.floor((now - restAt) / 86400000) : null;
  if (REST_BASELINE != null && (restDays == null || restDays >= 30)) notes.push({ kind: 'rest', ko: restDays == null ? `안정 시 젖산 기준값 ${REST_BASELINE}의 측정일이 없습니다 — 설정 → 프로필에 적어 두고, 매달 같은 조건(아침 공복, 채혈 규칙)으로 다시 재세요.` : `안정 시 젖산 기준값 ${REST_BASELINE} 측정 후 ${restDays}일 → 같은 조건(아침 공복, 채혈 규칙)으로 다시 재고 설정에 적으세요. 검증 달리기 날에는 안정 시 채혈이 필요 없습니다.`, en: restDays == null ? `No date for the resting-lactate baseline ${REST_BASELINE} — enter it in Settings → Profile and re-measure monthly under the same conditions (fasted, by the sampling rules).` : `${restDays} days since the resting-lactate baseline ${REST_BASELINE} was measured → re-measure it under the same conditions (fasted, by the sampling rules) and enter it in Settings. A check day needs no resting sample.` });
  const m = recent.map(sessionMetrics);
  if (m.length >= 2) {
    const drifts = m.map(x => x.driftPct).filter(isFinite);
    if (drifts.filter(d => d > 5).length >= 2) notes.push({ ko: '심박 드리프트 > 5 %가 2회 이상 — 수면·더위·수분을 점검하세요(정보: 지속시간은 바꾸지 않음, 기준값 자체가 미검증).', en: 'HR drift > 5 % in two or more sessions — check sleep, heat and fluids (information only: duration is not held; the cut-off itself is unvalidated).', kind: 'info' });
    const art = mean(m.map(x => x.artifactPct).filter(isFinite));
    if (art > 5) notes.push({ ko: `아티팩트 평균 ${art.toFixed(1)}% → 스트랩 전극을 적시고 위치를 확인하세요`, en: `Average artifacts ${art.toFixed(1)}% → wet the electrodes and check strap position`, kind: 'quality' });
  }
  // session RPE (CR-10, v1.1.35 — review §5): the cheapest and most sensitive fatigue signal. An easy run rated ≥ 5, or the easy-run RPE a point higher than the week before at the same speed, is the flag.
  const rpeRuns = recent.filter(s => Number.isFinite(s.rpe)).sort((a, b) => a.startedAt - b.startedAt);
  const hard = rpeRuns.filter(s => s.rpe >= 5);
  if (hard.length) notes.push({ ko: `쉬운 런 RPE ≥ 5가 ${hard.length}회(최근 14일; 마지막 ${hard[hard.length - 1].rpe}) — 피로 표시: 수면·연료·지난 고강도를 점검하고, 이번 주 쉬운 런은 밴드 하단으로.`, en: `Easy-run RPE ≥ 5 on ${hard.length} run(s) in 14 days (last ${hard[hard.length - 1].rpe}) — a fatigue flag: check sleep, fuel and the last hard session; run this week's easy runs at the low end of the band.`, kind: 'adjust' });
  const wk = t => now - t < 7 * 86400000; const a = rpeRuns.filter(s => wk(s.startedAt)), b = rpeRuns.filter(s => !wk(s.startedAt));
  if (a.length >= 2 && b.length >= 2) { const sameSpeed = Number.isFinite(a[0].speed) && b.every(s => Math.abs((s.speed ?? NaN) - a[0].speed) < 0.15) && a.every(s => Math.abs((s.speed ?? NaN) - a[0].speed) < 0.15); const d = mean(a.map(s => s.rpe)) - mean(b.map(s => s.rpe)); if (sameSpeed && d >= 1) notes.push({ ko: `같은 속도의 쉬운 런 RPE가 지난주보다 +${d.toFixed(1)} — 2주째 오르면 회복주를 당기세요.`, en: `Easy-run RPE at the same speed is +${d.toFixed(1)} on last week — a second rising week brings the recovery week forward.`, kind: 'adjust' }); }
  if (!rpeRuns.length && recent.length) notes.push({ ko: '달리기 끝에 RPE(CR-10)를 입력하면 피로 추세가 여기에 나옵니다(세션 카드의 RPE 칸).', en: 'Enter a session RPE (CR-10) after each run (the RPE field of the session card) and the fatigue trend shows here.', kind: 'info' });
  const weeks = lastTestAt ? (now - lastTestAt) / (7 * 86400000) : null;
  const retest = weeks == null || weeks >= 8;
  if (weeks != null && weeks >= 8) notes.push({ ko: `마지막 테스트 후 ${Math.floor(weeks)}주 → 재검사 권장`, en: `${Math.floor(weeks)} weeks since last test → retest recommended`, kind: 'retest' });
  if (weeks == null) notes.push({ ko: '아직 테스트가 없습니다. 첫 단계 테스트로 역치를 만드세요.', en: 'No test yet — run a first step test to set thresholds.', kind: 'retest' });
  return { lt1Adjust, holdDuration, notes, retest, weeksSinceTest: weeks, sessionsConsidered: m.length, rpeRuns: rpeRuns.length };
}

/** Rule-based post-session text. */
export function sessionSummaryText(session, metrics, zones, analysis = null) {
  const ko = [], en = [];
  const d = Math.round(metrics.durationSec / 60);
  if (session.type === 'test') {
    const tri = analysis?.tri; const lac = analysis?.lactate;
    const nSt = (session.stages || []).length; ko.push(`단계 테스트 ${nSt}단계, ${d}분.`); en.push(`Step test: ${nSt} stages, ${d} min.`);
    if (tri?.lt1) { ko.push(`LT1 ≈ ${Math.round(tri.lt1.hr)} bpm (${Number.isFinite(tri.lt1.speed) ? tri.lt1.speed.toFixed(1) + ' km/h' : ''}, 근거 ${tri.lt1.source}, 신뢰도 ${tri.grade1}).`); en.push(`LT1 ≈ ${Math.round(tri.lt1.hr)} bpm (${Number.isFinite(tri.lt1.speed) ? tri.lt1.speed.toFixed(1) + ' km/h' : ''}, source ${tri.lt1.source}, grade ${tri.grade1}).`); }
    if (tri?.lt2) { ko.push(`LT2 ≈ ${Math.round(tri.lt2.hr)} bpm (${Number.isFinite(tri.lt2.speed) ? tri.lt2.speed.toFixed(1) + ' km/h' : ''}, 근거 ${tri.lt2.source}, 신뢰도 ${tri.grade2}).`); en.push(`LT2 ≈ ${Math.round(tri.lt2.hr)} bpm (${Number.isFinite(tri.lt2.speed) ? tri.lt2.speed.toFixed(1) + ' km/h' : ''}, source ${tri.lt2.source}, grade ${tri.grade2}).`); }
    if (lac && !Number.isFinite(lac.lt2Primary.x)) { ko.push('젖산 곡선이 LT2를 지나기 전에 끝났습니다 — 다음엔 한두 단계 더 진행하세요.'); en.push('The lactate curve ended before LT2 — go one or two stages further next time.'); }
    if (analysis?.hrv && !analysis.hrv.hrvt1) { ko.push('α1이 0.75 아래로 내려오지 않았습니다 (아티팩트 또는 강도 부족).'); en.push('α1 never dropped below 0.75 (artifacts or insufficient intensity).'); }
  } else {
    const ty = String(session.type || '').toUpperCase(); const tyKo = session.type === 'verify' ? 'LT1 검증(두 랩)' : ty, tyEn = session.type === 'verify' ? 'LT1 check (two laps)' : ty;
    if (Number.isFinite(metrics.meanHr)) { ko.push(`${tyKo} 세션 ${d}분, 평균 심박 ${Math.round(metrics.meanHr)} bpm.`); en.push(`${tyEn} session ${d} min, mean HR ${Math.round(metrics.meanHr)} bpm.`); } else { ko.push(`${tyKo} 세션 ${d}분, 심박 기록 없음.`); en.push(`${tyEn} session ${d} min, no heart rate recorded.`); }
    if (Number.isFinite(metrics.timeInZonePct)) { ko.push(`존 체류 ${Math.round(metrics.timeInZonePct)}%.`); en.push(`Time in zone ${Math.round(metrics.timeInZonePct)}%.`); }
    if (alphaOn() && Number.isFinite(metrics.meanAlpha1)) {
      ko.push(`평균 α1 ${metrics.meanAlpha1.toFixed(2)} (0.75 이상 ${Math.round(metrics.pctAlphaAbove75)}%).`); en.push(`Mean α1 ${metrics.meanAlpha1.toFixed(2)} (≥0.75 for ${Math.round(metrics.pctAlphaAbove75)}%).`);
      if (session.type === 'lt1') { ko.push('(α1은 참고값 — 개인 오차 ± 25 bpm, 판정·조정에 쓰지 않음)'); en.push('(α1 for reference only — individual error ± 25 bpm; no verdict or adjustment rests on it)'); }
    }
    if (Number.isFinite(session.rpe)) { ko.push(`세션 RPE ${session.rpe}/10${session.type === 'lt1' && session.rpe >= 5 ? ' — 쉬운 런치고 높음(피로 표시)' : ''}.`); en.push(`Session RPE ${session.rpe}/10${session.type === 'lt1' && session.rpe >= 5 ? ' — high for an easy run (fatigue flag)' : ''}.`); }
    if (Number.isFinite(metrics.driftPct)) { ko.push(`심박 드리프트 ${metrics.driftPct >= 0 ? '+' : ''}${metrics.driftPct.toFixed(1)}%${metrics.driftPct > 5 ? ' (높음 — 수면·더위·수분 점검; 정보)' : ''}.`); en.push(`HR drift ${metrics.driftPct >= 0 ? '+' : ''}${metrics.driftPct.toFixed(1)}%${metrics.driftPct > 5 ? ' (high — check sleep, heat, fluids; information)' : ''}.`); }
  }
  if (Number.isFinite(metrics.artifactPct) && metrics.artifactPct > 5) { if (alphaOn()) { ko.push(`아티팩트 ${metrics.artifactPct.toFixed(1)}% — α1 해석에 주의.`); en.push(`Artifacts ${metrics.artifactPct.toFixed(1)}% — interpret α1 with care.`); } else { ko.push(`아티팩트 ${metrics.artifactPct.toFixed(1)}% — 스트랩 전극을 적시고 위치를 확인하세요.`); en.push(`Artifacts ${metrics.artifactPct.toFixed(1)}% — wet the electrodes and check the strap.`); } }
  return { ko: ko.join(' '), en: en.join(' ') };
}

/** How the end of the run was found (runTimeline `how`), in the words of the copied summary. */
const RUN_END_HOW = { sample: 'heart-rate drop before the lactate entry', pause: 'Pause', manual: 'entered by hand', phase: 'end of the rep clock', finish: 'end of the recording', hr: 'heart rate alone' };
/** Plain-text block to paste into Claude for interpretation. */
export function claudeSummary({ profile, zones, session, metrics, analysis, plan }) {
  const L = [];
  L.push(`# Treadmill Lab summary (${new Date().toISOString().slice(0, 10)})`);
  if (profile) L.push(`Athlete: age ${profile.age ?? '?'}, resting HR ${profile.restHr ?? '?'}${Number.isFinite(profile.restLactate) ? `, resting lactate ${profile.restLactate} mmol/L` : ''}, max HR ${profile.maxHr ?? '?'}${profile.appVersion ? ` (app v${profile.appVersion})` : ''}`);
  if (zones) L.push(`Thresholds: LT1 ${Math.round(zones.lt1Hr)} bpm @ ${zones.lt1Speed ?? '?'} km/h; LT2 ${Math.round(zones.lt2Hr)} bpm @ ${zones.lt2Speed ?? '?'} km/h${zones.grade ? ` (grade ${zones.grade})` : ''}${zones.updatedAt ? `, set ${new Date(zones.updatedAt).toISOString().slice(0, 10)}` : ''}${Number.isFinite(zones.mlssLactate) ? `; MLSS lactate ${zones.mlssLactate} mmol/L (ladder target ± 0.5)` : '; MLSS lactate not set (ladder target 3.0–4.5 until then)'}${Number.isFinite(zones.pace3k) ? `; 3-km pace ${zones.pace3k} km/h (4×4 at ${vo2Speed(zones)})` : ''}`);
  if (session) {
    L.push(`Session: ${session.type}${session.intervals?.kind ? ` (${session.intervals.kind}${session.intervals.reps ? ` ${session.intervals.reps}×${Math.round(session.intervals.workSec / 60)} min` : ''})` : ''}, ${new Date(session.startedAt).toLocaleString()}, ${Math.round((metrics?.durationSec || 0) / 60)} min, source ${session.sourceKind}, session RPE ${Number.isFinite(session.rpe) ? session.rpe + '/10' : 'not entered'}`);
    if (metrics) L.push(`Metrics: mean HR ${Number.isFinite(metrics.meanHr) ? Math.round(metrics.meanHr) : 'n/a'}, max HR ${Number.isFinite(metrics.maxHr) ? metrics.maxHr : 'n/a'}, mean α1 ${Number.isFinite(metrics.meanAlpha1) ? metrics.meanAlpha1.toFixed(2) : 'n/a'}, min α1 ${Number.isFinite(metrics.minAlpha1) ? metrics.minAlpha1.toFixed(2) : 'n/a'}, α1≥0.75 ${Number.isFinite(metrics.pctAlphaAbove75) ? Math.round(metrics.pctAlphaAbove75) + '%' : 'n/a'}, HR drift ${Number.isFinite(metrics.driftPct) ? metrics.driftPct.toFixed(1) + '%' : 'n/a'}, artifacts ${Number.isFinite(metrics.artifactPct) ? metrics.artifactPct.toFixed(1) + '%' : 'n/a'}, time in zone ${Number.isFinite(metrics.timeInZonePct) ? Math.round(metrics.timeInZonePct) + '%' : 'n/a'}`);
    if (session.type !== 'test') {
      const c = lactateChecks(session); const v = lactateVerdict(session); const ew = endWindowStats(session, 300); const px = endOnlyProxy(session);
      const mmss = sec => { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
      // Where the running ended and how that was found: everything "last 5 min" below is measured from there (see runTimeline).
      const endTxt = `run ended at ${mmss((ew.endT - session.startedAt) / 1000)} (found by: ${RUN_END_HOW[ew.how] || ew.how}${ew.tailSec >= 20 ? `; the recording went on for ${mmss(ew.tailSec)}` : ''})${ew.sure ? '' : ' — UNCERTAIN: the last-5-min figures are estimates'}`;
      const durTxt = ew.bouts === 1 ? `running time ${px.durMin.toFixed(1)} min` : ew.bouts === 0 ? 'ended in the warm-up' : `interval session — last rep ${px.durMin.toFixed(1)} min`;
      L.push(`Constant load (${session.purpose || 'auto'}): speed ${session.speed ?? '?'} km/h, incline ${session.incline ?? '?'} %; ${durTxt}; ${endTxt}; HR drift min 8-13 → last 5 ${Number.isFinite(px.driftBpm) ? (px.driftBpm >= 0 ? '+' : '') + px.driftBpm.toFixed(1) + ' bpm' : 'n/a'}; last-5-min HR ${Number.isFinite(ew.hr) ? Math.round(ew.hr) : 'n/a'}, α1 ${Number.isFinite(ew.alpha1) ? ew.alpha1.toFixed(2) : 'n/a'}; lactate rest ${c.rest ?? 'n/a'}, ${midLabel(c).en} ${c.mid ?? 'n/a'}, end ${c.end ?? 'n/a'}${v ? `; verdict: ${v.en}` : ''}`);
      const ls = lapStats(session); const fl = lactateFloor();
      if (ls) L.push(`Two-lap LT1 check: lap 1 ${ls.lap1Min.toFixed(1)} min (HR min 5-10 ${Number.isFinite(ls.lap1Hr) ? Math.round(ls.lap1Hr) : 'n/a'} bpm) → gap ${Number.isFinite(ls.gapSec) ? Math.round(ls.gapSec) + ' s' : 'n/a'}${Number.isFinite(ls.gapSec) && ls.gapSec > GAP_STRICT_SEC ? ' (STRICT rule: > 3 min)' : ''} → lap 2 ${ls.lap2Min.toFixed(1)} min (HR min 1-6 ${Number.isFinite(ls.lap2Early) ? Math.round(ls.lap2Early) : 'n/a'} → last 5 ${Number.isFinite(ls.lap2Late) ? Math.round(ls.lap2Late) : 'n/a'}, drift ${Number.isFinite(ls.lap2Drift) ? (ls.lap2Drift >= 0 ? '+' : '') + ls.lap2Drift.toFixed(1) + ' bpm' : 'n/a'}); line = ${fl ? `${fl.lowest} (${fl.from}) + 0.5 = ${r1(fl.lowest + LINE_DELTA)}` : 'n/a'}; samples: ${list(session.events).filter(e => e.type === 'lactate' && Number.isFinite(e.value)).map(e => `${e.value} (lap ${e.lap ?? '?'}, ${e.runSec != null ? Math.round(e.runSec / 60) + ' min at speed' : '?'}${e.sinceStopSec != null ? `, ${e.sinceStopSec} s after the stop` : ''})`).join('; ') || 'none logged'}`);
      const ss = smo2Steady(session);
      if (ss) L.push(`SmO2 (constant load): 5-10 min ${Number.isFinite(ss.earlyMean) ? ss.earlyMean.toFixed(1) : 'n/a'} %, last 5 min ${Number.isFinite(ss.endMean) ? ss.endMean.toFixed(1) : 'n/a'} % (drift ${Number.isFinite(ss.drift) ? (ss.drift > 0 ? '+' : '') + ss.drift.toFixed(1) : 'n/a'})${ew.sure ? '' : ' [end of the run UNCERTAIN: window estimated]'}, min ${Number.isFinite(ss.min) ? ss.min.toFixed(1) : 'n/a'} %, end slope ${Number.isFinite(ss.slopeEnd) ? ss.slopeEnd.toFixed(2) : 'n/a'} %/min → ${ss.steady == null ? 'n/a' : ss.steady ? 'steady' : 'NOT steady'}; THb mean ${Number.isFinite(ss.thbMean) ? ss.thbMean.toFixed(1) : 'n/a'} (contact ${ss.contact ?? 'n/a'}); coverage ${Math.round(ss.coverageSec / 60)} min; offset ${Math.round((session.smo2.offsetMs || 0) / 1000)} s${session.smo2.alignment ? ` (${session.smo2.alignment.method === 'manual' ? 'manual' : session.smo2.alignment.ok ? `HR-verified, ${session.smo2.alignment.mad.toFixed(2)} bpm` : `UNVERIFIED, HR mismatch ${session.smo2.alignment.mad.toFixed(1)} bpm`})` : ' (clock only)'}`);
    }
    if (session.stages?.length) { L.push('Stages (speed km/h | incline % | HR | α1 | lactate | SmO2):'); for (const r of (analysis?.rows || session.stages)) L.push(`  ${r.speed} | ${r.incline} | ${Number.isFinite(r.hr) ? Math.round(r.hr) : '-'} | ${Number.isFinite(r.alpha1) ? r.alpha1.toFixed(2) : '-'} | ${r.lactate ?? '-'} | ${Number.isFinite(r.smo2) ? r.smo2.toFixed(1) : '-'}`); }
    if (analysis?.lactate) { L.push('Lactate methods: ' + [...analysis.lactate.lt1, ...analysis.lactate.lt2].map(m => `${m.method}=${Number.isFinite(m.x) ? m.x.toFixed(2) + 'km/h/' + Math.round(m.hr) + 'bpm' : 'n/a'}`).join(', ')); }
    const kmh = v => Number.isFinite(v) ? v.toFixed(1) : '? km/h';
    if (analysis?.hrv) L.push(`HRVT: HRVT1 ${analysis.hrv.hrvt1 ? Math.round(analysis.hrv.hrvt1.hr) + ' bpm @ ' + kmh(analysis.hrv.hrvt1.speed) : 'n/a'}; HRVT2 ${analysis.hrv.hrvt2 ? Math.round(analysis.hrv.hrvt2.hr) + ' bpm @ ' + kmh(analysis.hrv.hrvt2.speed) : 'n/a'}${analysis.hrv.note ? ' (' + analysis.hrv.note + ')' : ''}${analysis.hrv.plateau ? ' [' + analysis.hrv.plateau.note + ']' : ''}`);
    if (analysis?.smo2) L.push(`SmO2 breakpoints: BP1 ${analysis.smo2.bp1 ? analysis.smo2.bp1.speed.toFixed(1) + ' km/h' : 'n/a'}, BP2 ${analysis.smo2.bp2 ? analysis.smo2.bp2.speed.toFixed(1) + ' km/h' : 'n/a'}${analysis.smo2.note ? ' (' + analysis.smo2.note + ')' : ''}`);
    if (analysis?.tri) L.push(`Triangulation: LT1 ${analysis.tri.lt1 ? Math.round(analysis.tri.lt1.hr) + ' bpm (' + analysis.tri.lt1.source + ', grade ' + analysis.tri.grade1 + ')' : 'n/a'}; LT2 ${analysis.tri.lt2 ? Math.round(analysis.tri.lt2.hr) + ' bpm (' + analysis.tri.lt2.source + ', grade ' + analysis.tri.grade2 + ')' : 'n/a'}`);
  }
  if (plan) L.push(`Plan week ${plan.week}${plan.recovery ? ' (recovery)' : ''}: ` + plan.days.map(d => `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.day]} ${d.en} ${d.minutes}min`).join('; '));
  L.push(alphaOn() ? 'Question: please interpret this session and suggest adjustments. (DFA α1: 0.75 ≈ aerobic threshold, 0.5 ≈ anaerobic threshold; lactate is the anchor.)'
    : 'Question: please interpret this session and suggest adjustments. (α1 guidance is switched OFF in the app for this athlete: α1 read 0.46 on a lactate-confirmed below-LT1 run, so α1 values above are recorded for comparison only — do not base intensity on them. Lactate is the anchor.)');
  return L.join('\n');
}


// ---------- Lactate verification runs (solo-friendly: samples only at rest / ~10 min / end) ----------
/**
 * {rest, mid, end} lactate. Values logged during the session are placed by what the run did around them (runTimeline: a sample
 * taken from the last stop on is the end sample, one whose stop was followed by more running a mid sample; without a stop of its
 * own, by the clock). A field typed in the card (session.lactateChecks) is final — also when it was emptied.
 */
export function lactateChecks(session) {
  const out = { rest: null, mid: null, end: null };
  let samples;
  if (session.type !== 'test') samples = runTimeline(session).samples;
  else { // step tests keep their samples per stage; this is only the header line of the CSV export
    const hl = list(session.hrLive); const t0 = session.startedAt, t1 = session.endedAt || (hl.length ? hl[hl.length - 1][0] : t0); const dur = (t1 - t0) / 1000;
    samples = list(session.events).filter(e => e.type === 'lactate' && Number.isFinite(e.value)).map(e => { const rel = (e.t - t0) / 1000; return { value: e.value, role: rel <= 240 ? 'rest' : (rel >= dur - 300 || rel >= dur * 0.85) ? 'end' : 'mid' }; });
  }
  let midT = null;
  for (const s of samples) if (out[s.role] == null) { out[s.role] = s.value; if (s.role === 'mid' && Number.isFinite(s.t)) midT = Number.isFinite(s.stopT) ? s.stopT : s.t; } // the minute the running stopped for it, else when it was typed // the first of each kind (a second finger does not replace it)
  const typed = typedChecks(session);
  // when the mid sample was taken, in whole minutes of the recording: the card and texts say "mid (30 min)", not a fixed "10 min".
  // A value retyped in the card keeps the time of the sample it corrects; a minute typed in the card (midMinTyped) wins; an emptied field has none.
  let midMin = midT == null ? null : Math.round((midT - session.startedAt) / 60000);
  // a two-lap run: the mid value is the lap-1 value, its "minute" the running time of lap 1
  const tl = session.type === 'verify' ? runTimeline(session) : null; const twoLap = !!(tl && tl.twoLap);
  if (twoLap) midMin = Math.round((tl.laps[0].end - tl.laps[0].start) / 60000);
  if (Number.isFinite(session.midMinTyped)) midMin = session.midMinTyped;
  if (('mid' in typed && typed.mid == null) || (typed.mid == null && out.mid == null)) midMin = null;
  return { ...out, ...typed, midMin, twoLap, gapSec: twoLap ? tl.gapSec : null };
}
/** Label of the mid sample: "중간 (30분)" / "mid (30 min)", "랩 1 (10분)" / "lap 1 (10 min)" of a two-lap run, or plain "중간" / "mid" when its time is not known. */
export function midLabel(c) { const m = c && Number.isFinite(c.midMin) ? c.midMin : null; if (c && c.twoLap) return { ko: `랩 1${m != null ? `(${m}분)` : ''}`, en: `lap 1${m != null ? ` (${m} min)` : ''}` }; return m == null ? { ko: '중간', en: 'mid' } : { ko: `중간(${m}분)`, en: `mid (${m} min)` }; }
/**
 * The card fields that were typed by hand ({ rest?, mid?, end? }, null = emptied). Up to v1.1.11 an edit in the card stored all three
 * fields, the two untouched ones as the clock had filed them; in such a record (no lactateChecksV) a field that equals that filing was
 * not typed and follows the rules of today. v1.1.12 stores the typed fields only, with lactateChecksV = 2.
 */
export function typedChecks(session) {
  const typed = session.lactateChecks && typeof session.lactateChecks === 'object' ? session.lactateChecks : {}; const out = {};
  const legacy = session.lactateChecksV !== 2 ? clockChecks(session) : null;
  for (const k of ['rest', 'mid', 'end']) {
    if (!Object.prototype.hasOwnProperty.call(typed, k)) continue;
    const v = Number.isFinite(typed[k]) ? typed[k] : null;
    if (legacy && v === legacy[k]) continue;
    out[k] = v;
  }
  return out;
}
/** The three values as v1.1.11 filed them: by the clock of the recording (≤ 4 min rest; last 5 min / 15 % end; the rest mid). */
function clockChecks(session) {
  const out = { rest: null, mid: null, end: null }; const hl = Array.isArray(session.hrLive) ? session.hrLive : [];
  const t0 = session.startedAt, t1 = session.endedAt || (hl.length && hl[hl.length - 1] ? hl[hl.length - 1][0] : t0); const dur = (t1 - t0) / 1000;
  for (const e of Array.isArray(session.events) ? session.events : []) { if (!e || e.type !== 'lactate' || !Number.isFinite(e.value)) continue; const r = (e.t - t0) / 1000; if (r <= 240 && out.rest == null) out.rest = e.value; else if (r >= dur - 300 || r >= dur * 0.85) { if (out.end == null) out.end = e.value; } else if (out.mid == null) out.mid = e.value; }
  return out;
}
/**
 * Mean HR / α1 over the last `sec` seconds of running (steady-state end). The window ends where the running stopped, not where the
 * recording did, and skips over a stop inside it. endT / how / sure / tailSec say what was used (see runTimeline).
 */
export function endWindowStats(session, sec = 300) {
  const tl = runTimeline(session); const t1 = tl.end; const from = runWindowStart(tl, sec); const settle = alphaWindowMs(session);
  const pts = list(session.hrLive).filter(p => p[0] >= from && p[0] <= t1 && p[1] > 0 && !inStop(tl, p[0]));
  // (a mean needs something to stand on: a few seconds of heart rate left in the window — the strap taken off minutes before Finish — are not "the last 5 min")
  const hr = covers(pts, 60000) ? pts.map(p => p[1]) : [];
  // α1: the stops decide what was running, not the app's Pause flag (see runTimeline); windows with ≥ 3 % artifacts are left out
  const a1 = list(session.features).filter(f => f.t >= from && Number.isFinite(f.alpha1) && !(f.artifactPct >= ALPHA_ARTIFACT_MAX) && !alphaTainted(tl, f.t, settle)).map(f => f.alpha1);
  return { hr: mean(hr), alpha1: mean(a1), endT: t1, fromT: from, how: tl.how, sure: tl.sure, why: tl.why, tailSec: tl.tailSec, bouts: tl.bouts, entryT: tl.entryT, twoLap: !!tl.twoLap, gapSec: tl.gapSec ?? null };
}
/** Mean heart rate of [a, b) when at least a minute of it is there (stops of the run skipped), else NaN. */
function hrWindow(session, tl, a, b) { const pts = list(session.hrLive).filter(p => p[1] > 0 && p[0] >= a && p[0] < b && !inStop(tl, p[0])); return covers(pts, 60000) ? mean(pts.map(p => p[1])) : NaN; }
/**
 * The two laps of a verification run (v1.1.17): lap1Hr = minutes 5–10 of lap 1 (the heart rate the multi-day curve and the band take);
 * lap2Drift = last 5 min of lap 2 − minutes 1–6 after the restart (the first minute is the re-rise); lap1Min / lap2Min = running time
 * of each lap; gapSec = lap-1 clock end → "Start lap 2". null for any other session.
 */
export function lapStats(session, tl = runTimeline(session)) {
  if (!tl || !tl.twoLap) return null; const [L1, L2] = tl.laps; const end2 = Math.min(L2.end, tl.end);
  const lap1Min = (L1.end - L1.start) / 60000, lap2Min = Math.max(0, (end2 - L2.start - stoppedMs(tl, L2.start, end2)) / 60000);
  const lap1Hr = lap1Min >= 6 ? hrWindow(session, tl, L1.start + 300000, L1.end) : NaN;
  const early = lap2Min >= 12 ? hrWindow(session, tl, L2.start + 60000, L2.start + 360000) : NaN, late = lap2Min >= 12 ? hrWindow(session, tl, Math.max(L2.start, end2 - 300000), end2) : NaN;
  return { lap1Hr, lap1Min, lap2Min, lap2Early: early, lap2Late: late, lap2Drift: Number.isFinite(early) && Number.isFinite(late) ? late - early : NaN, gapSec: tl.gapSec, sure: tl.sure };
}
/** Minutes 8–13 of a single constant run (the curve's heart rate for such runs, v1.1.17: before the drift, after the rise) — NaN when the run is shorter. */
export function earlyWindowHr(session, tl = runTimeline(session)) {
  const to = runWindowEnd(tl, tl.start + 480000, 300); if (to > tl.end + 1000) return NaN;
  return hrWindow(session, tl, tl.start + 480000, to);
}
/** Seconds the belt stood still for the mid (10-min) sample of a constant run: from the stop the sample belongs to until the running resumed. null when not known. */
function midStopSec(session, tl) {
  if (!tl) return null; if (tl.twoLap) return tl.gapSec;
  const smp = tl.samples.find(x => x.role === 'mid' && Number.isFinite(x.stopT)); if (!smp) return null;
  const st = tl.stops.find(s => Math.abs(s[0] - smp.stopT) <= 30000); return st ? Math.max(0, (st[2] - st[0]) / 1000) : null;
}
/**
 * Proxies for an end-only MLSS call on ONE continuous run: running time, HR drift (minutes 8–13 → last 5 min of running), SmO2
 * steadiness. A stop for a sample is left out of the running time and skipped over by both windows. single = false for interval
 * sessions (no drift: one part of a steady run is compared with another, which means nothing across rests); sure = false when
 * the end of the run is only an estimate — then the proxy must not be used.
 */
export function endOnlyProxy(session) {
  const tl = runTimeline(session); const t0 = tl.start, t1 = tl.end; const single = tl.bouts === 1;
  const durMin = (t1 - t0 - stoppedMs(tl, t0, t1)) / 60000;
  const hrs = list(session.hrLive).filter(p => p[1] > 0 && !inStop(tl, p[0]));
  const from = runWindowStart(tl, 300);
  const earlyTo = runWindowEnd(tl, t0 + 480000, 300); // 5 min of running from minute 8 on: minutes 8–13, or a little later when a stop falls into them
  const earlyP = hrs.filter(p => p[0] >= t0 + 480000 && p[0] < earlyTo && p[0] <= t1), lateP = hrs.filter(p => p[0] >= from && p[0] <= t1);
  const early = earlyP.map(p => p[1]), late = lateP.map(p => p[1]);
  const driftBpm = single && early.length >= 10 && late.length >= 10 && covers(earlyP, 60000) && covers(lateP, 60000) ? mean(late) - mean(early) : NaN;
  const ss = smo2Steady(session); 
  return { durMin, driftBpm, smo2Steady: ss ? ss.steady : null, single, sure: tl.sure, how: tl.how };
}
/**
 * Verdict for a constant-load session with end (and optional rest / 10-min) lactate.
 * LT1 runs: end ≤ 2.0 (and ≤ rest+1.0) → below LT1. LT2 runs (MLSS logic): Δ(mid→end) ≤ 1.0 → at/below MLSS.
 */
export function lactateVerdict(session) {
  const c = lactateChecks(session); const type = session.type;
  if (c.end == null) return null;
  const isMlss = session.purpose === 'mlss' || (session.purpose !== 'lt1' && (type === 'lt2' || (type === 'free' && c.end >= 3)));
  const vd = verdictCore(session, c, isMlss); return vd ? { kind: isMlss ? 'mlss' : 'lt1', ...vd } : null;
}
/**
 * The two-lap LT1 check (v1.1.17). lap 1 = the value after 10 min at the test speed, end = the value after lap 2 (30 min);
 * line = lowest + 0.5 (lowest = lowest in-test lactate of the latest step test, else the resting baseline).
 *   pass       lap 1 ≤ line and rise (lap 1 → end) ≤ 0.5 (≤ 0.3 when the gap exceeded 3 min: lactate clears while standing) → next check +0.3 km/h (v1.1.35: 0.2 was inside the 4 % test–retest error)
 *   borderline rise 0.5–1.0, or lap 1 within 0.2 of the line → same speed next week (target HR −2)
 *   fail       lap 1 > line, rise > 1.0 or end > 2.5 → next week −0.3 km/h (target HR −4)
 * durability: the level passed (lap 1 ≤ line) but the 30 min did not hold (rise > 0.5, or lap-2 drift > 8 bpm) — a duration problem, not a speed one.
 * No zone change follows from one run: the band finder moves the band after two consecutive results (bandFinder).
 */
/** No strap: the verdict's heart-rate advice ("target HR −2 / −4 bpm") has nothing to stand on — dropped, and said so. */
function noHrText(session, vd) {
  if (!vd || !NO_HR_KINDS.includes(session.sourceKind)) return vd;
  return { ...vd, adjust: null, noHr: true, ko: vd.ko.replace(/, 목표 심박 −\d bpm/, '') + ' (스트랩 없음 — 젖산만으로 판정, 심박 조정 없음)', en: vd.en.replace(/, target HR −\d bpm/, '') + ' (no strap — judged on lactate only, no heart-rate change)' };
}
function twoLapVerdict(session, c, tl) {
  const sp = session.speed; const spTxt = Number.isFinite(sp) ? ` @ ${sp} km/h` : '';
  const fl = lactateFloor(); const lowest = fl ? r1(fl.lowest) : 0.8; const line = r1(lowest + LINE_DELTA);
  const lineKo = fl ? (fl.from === 'test' ? `계단 검사 최저 ${lowest.toFixed(1)} + 0.5 = ${line}` : `기준 안정 시 ${lowest.toFixed(1)} + 0.5 = ${line}`) : `0.8 + 0.5 = ${line} (기준값 없음)`;
  const lineEn = fl ? (fl.from === 'test' ? `test lowest ${lowest.toFixed(1)} + 0.5 = ${line}` : `resting baseline ${lowest.toFixed(1)} + 0.5 = ${line}`) : `0.8 + 0.5 = ${line} (no baseline set)`;
  const ls = lapStats(session, tl); const gap = tl.gapSec; const strict = gap != null && gap > GAP_STRICT_SEC; const gapTxt = gap != null ? `${Math.round(gap)}초` : '?'; const gapEn = gap != null ? `${Math.round(gap)} s` : '?';
  const base = { twoLap: true, line, lowest, lineFrom: fl ? fl.from : null, gapSec: gap, strict, lap1: c.mid, end: c.end, lap1Hr: ls ? ls.lap1Hr : NaN, lap2Drift: ls ? ls.lap2Drift : NaN, lap2Min: ls ? ls.lap2Min : NaN };
  if (c.mid == null) return { ...base, level: 'near', adjust: null, next: 0, ko: `랩 1 값이 없습니다 — 종료 ${c.end}만으로는 두 랩 판정을 내리지 않습니다${spTxt}. 간격에서 찍은 값을 카드의 「랩 1」 칸에 적으세요(없으면 다음 주 같은 속도).`, en: `No lap-1 value — the end value ${c.end} alone gives no two-lap verdict${spTxt}. Enter the value taken in the gap in the card's "lap 1" field (or repeat next week at the same speed).` };
  const rise = r1(c.end - c.mid); const passRise = strict ? STRICT_RISE : PASS_RISE; const f1 = v => r1(v).toFixed(1);
  const levelFail = c.mid > line + 1e-9, endFail = c.end > END_MAX, riseFail = rise > FAIL_RISE;
  const drift = ls && Number.isFinite(ls.lap2Drift) ? ls.lap2Drift : NaN; const dTxt = Number.isFinite(drift) ? ` · 랩 2 드리프트 ${drift >= 0 ? '+' : ''}${drift.toFixed(0)} bpm` : '', dEn = Number.isFinite(drift) ? ` · lap-2 drift ${drift >= 0 ? '+' : ''}${drift.toFixed(0)} bpm` : '';
  const durability = !levelFail && !endFail && (rise > PASS_RISE || drift > 8);
  const lapTxt = `랩 1 ${f1(c.mid)} → 종료 ${f1(c.end)} (상승 ${rise >= 0 ? '+' : ''}${rise.toFixed(1)}, 간격 ${gapTxt})${dTxt}`, lapEn = `lap 1 ${f1(c.mid)} → end ${f1(c.end)} (rise ${rise >= 0 ? '+' : ''}${rise.toFixed(1)}, gap ${gapEn})${dEn}`;
  const strictKo = strict ? ' 간격이 3분을 넘어 엄격 규칙(상승 ≤ 0.3)을 적용했습니다.' : '', strictEn = strict ? ' The gap exceeded 3 min, so the strict rule (rise ≤ 0.3) was applied.' : '';
  const durKo = durability ? ' 수준은 통과(랩 1이 기준선 아래)했지만 30분을 버티지 못했습니다 — 속도가 아니라 지구력의 문제: 롱런 시간·보급을 점검하세요.' : '', durEn = durability ? ' The level passed (lap 1 under the line) but the 30 min did not hold — a durability problem, not a speed one: look at long-run duration and fuelling.' : '';
  if (levelFail || endFail || riseFail) {
    const why = levelFail ? [`랩 1 ${f1(c.mid)} > 기준선 ${line}`, `lap 1 ${f1(c.mid)} > line ${line}`] : endFail ? [`종료 ${f1(c.end)} > 2.5`, `end ${f1(c.end)} > 2.5`] : [`상승 ${rise.toFixed(1)} > 1.0`, `rise ${rise.toFixed(1)} > 1.0`];
    return { ...base, level: 'high', adjust: { lt1Hr: -4 }, next: -0.3, rise, durability, ko: `실패${spTxt}: ${why[0]} — ${lapTxt}. 기준선 ${lineKo}. 다음 주 검사 속도 −0.3 km/h, 목표 심박 −4 bpm.${durKo}${strictKo}`, en: `Fail${spTxt}: ${why[1]} — ${lapEn}. Line ${lineEn}. Next week's test speed −0.3 km/h, target HR −4 bpm.${durEn}${strictEn}` };
  }
  if (rise > passRise || c.mid >= line - NEAR_LINE - 1e-9) {
    const why = rise > passRise ? [`상승 ${rise.toFixed(1)} > ${passRise}`, `rise ${rise.toFixed(1)} > ${passRise}`] : [`랩 1 ${f1(c.mid)}이 기준선 ${line}의 0.2 이내`, `lap 1 ${f1(c.mid)} within 0.2 of the line ${line}`];
    return { ...base, level: 'near', adjust: { lt1Hr: -2 }, next: 0, rise, durability, ko: `경계${spTxt}: ${why[0]} — ${lapTxt}. 기준선 ${lineKo}. 다음 주 같은 속도로 재검, 목표 심박 −2 bpm.${durKo}${strictKo}`, en: `Borderline${spTxt}: ${why[1]} — ${lapEn}. Line ${lineEn}. Repeat next week at the same speed, target HR −2 bpm.${durEn}${strictEn}` };
  }
  return { ...base, level: 'ok', adjust: null, next: +0.3, rise, durability, ko: `통과${spTxt}: ${lapTxt} — 랩 1 ≤ 기준선 ${line}, 상승 ≤ ${passRise}. 기준선 ${lineKo}. 다음 검사 속도 +0.3 km/h(계단 검사 LT1 + 0.3까지; 0.2 단계는 재검사 오차 안).${strictKo}`, en: `Pass${spTxt}: ${lapEn} — lap 1 ≤ line ${line}, rise ≤ ${passRise}. Line ${lineEn}. Next test speed +0.3 km/h (up to the step-test LT1 + 0.3; a 0.2 step is inside the test–retest error).${strictEn}` };
}
/**
 * The weekly band finder (v1.1.17): from the two-lap runs (newest last) the next test speed — pass +0.3 (v1.1.35; up to the step-test LT1 speed
 * + 0.3), borderline the same, fail −0.3 — and, after two consecutive results of the same kind, the band change: two passes raise the
 * LT1 floor to the passed speed and lap-1 heart rate; two fails lower the cap to speed −0.3 / heart rate −4; borderline changes nothing.
 * → { nextSpeed, step, from: 'result' | 'zones', last: { date, speed, level }, streak: { level, n } | null, change: { zones, keys, ko, en } | null, ko, en }
 */
/** Weeks between LT1 checks once the band has settled (v1.1.33). */
export const MAINT_DAYS = 28;
/**
 * How often the two-lap check runs (v1.1.33, owner: "가장 좋은 방법으로 적용" — LT1 moves over weeks to months and one strip
 * carries ± 0.2–0.3 mmol/L, so weekly checks near the line mostly measure noise). Weekly while the search is moving; once the last
 * two checks at the same speed gave the same verdict, the band has settled → the next check is due 4 weeks after the last one.
 * A later check that disagrees (e.g. a pass where there were borderlines) puts it back to weekly by itself.
 * → { mode: 'weekly' | 'maintenance', due (ms, start of the due day), ko, en }
 */
export function checkCadence(results) {
  const n = (results || []).length; const day = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  if (n >= 2) { const a = results[n - 2], b = results[n - 1];
    if (Math.abs(a.s.speed - b.s.speed) < 0.05 && a.vd.level === b.vd.level) {
      const due = day(b.s.startedAt) + MAINT_DAYS * 86400000; const d = new Date(due); const md = `${d.getMonth() + 1}/${d.getDate()}`;
      return { mode: 'maintenance', due, ko: `범위 확인됨(${b.s.speed} km/h에서 같은 결과 2회) → 검사는 4주마다, 다음 ${md} 주 토요일 · 그 사이 토요일은 쉬운 런 + 천국의 계단(선택). 오늘의 실시 체크 → 설정 → LT1 검사 주기에도 같은 날짜를.`, en: `Band settled (the same result twice at ${b.s.speed} km/h) → checks every 4 weeks, next in the week of ${md} · Saturdays in between are easy runs (+ optional StairMaster). Set the same date in the daily app (설정 → LT1 검사 주기).` }; } }
  return { mode: 'weekly', due: null, ko: '범위가 정해질 때까지(같은 속도에서 같은 결과 2회) 매주 검사.', en: 'Weekly until the band settles (the same result twice at the same speed).' };
}
/** Is the two-lap check due in the week that starts on `monday` ('YYYY-MM-DD')? Weekly mode: always; maintenance: from the week holding `due` on. */
export function checkDueInWeek(cadence, monday) {
  if (!cadence || cadence.mode !== 'maintenance' || !Number.isFinite(cadence.due)) return true;
  const [y, m, d] = String(monday).split('-').map(Number); const sun = new Date(y, m - 1, d + 6, 23, 59, 59).getTime(); return sun >= cadence.due;
}
export function bandFinder(sessions, zones, { days = 70, now = Date.now() } = {}) {
  const z = zones || {}; const zSpeed = Number.isFinite(z.lt1Speed) ? z.lt1Speed : null;
  const runs = (sessions || []).filter(s => s && s.type === 'verify' && s.final && s.sourceKind !== 'demo' && onBelt(s) && (s.purpose || 'lt1') === 'lt1' && Number.isFinite(s.speed) && now - s.startedAt <= days * 86400000).sort((a, b) => a.startedAt - b.startedAt);
  const results = []; for (const s of runs) { const vd = lactateVerdict(s); if (vd && vd.twoLap && vd.lap1 != null) results.push({ s, vd }); }
  if (!results.length) return { nextSpeed: zSpeed, step: 0, from: 'zones', last: null, streak: null, change: null, results, cadence: checkCadence([]), ko: zSpeed != null ? `아직 두 랩 검증 결과가 없습니다 — 이번 주 검사 속도는 현재 LT1 속도 ${zSpeed.toFixed(1)} km/h.` : '아직 두 랩 검증 결과가 없습니다.', en: zSpeed != null ? `No two-lap result yet — this week's test speed is the current LT1 speed, ${zSpeed.toFixed(1)} km/h.` : 'No two-lap result yet.' };
  const last = results[results.length - 1]; const step = last.vd.next || 0;
  const cap = Number.isFinite(z.testLt1Speed) ? r1(z.testLt1Speed + 0.3) : (zSpeed != null ? r1(zSpeed + 0.3) : null);
  let next = r1(last.s.speed + step); let capped = false; if (step > 0 && cap != null && next > cap) { next = Math.max(last.s.speed, cap); capped = true; }
  let n = 1; for (let i = results.length - 2; i >= 0 && results[i].vd.level === last.vd.level; i--) n++;
  const streak = { level: last.vd.level, n };
  let change = null;
  if (n >= 2 && zones) {
    const out = { ...z }; const hr = Number.isFinite(last.vd.lap1Hr) ? Math.round(last.vd.lap1Hr) : NaN;
    if (last.vd.level === 'ok') { const v = r1(last.s.speed); if (!(z.lt1Speed >= v)) out.lt1Speed = v; if (Number.isFinite(hr) && !(z.lt1Hr >= hr)) out.lt1Hr = hr; }
    else if (last.vd.level === 'high') { const v = r1(last.s.speed - 0.3); if (!(z.lt1Speed <= v)) out.lt1Speed = v; if (Number.isFinite(hr) && !(z.lt1Hr <= hr - 4)) out.lt1Hr = hr - 4; }
    const keys = ['lt1Hr', 'lt1Speed'].filter(k => out[k] !== z[k] && Number.isFinite(out[k]));
    if (keys.length) { const fmt = k => `LT1 ${k === 'lt1Hr' ? `${Number.isFinite(z.lt1Hr) ? Math.round(z.lt1Hr) : '–'}→${out.lt1Hr} bpm` : `${Number.isFinite(z.lt1Speed) ? z.lt1Speed : '–'}→${out.lt1Speed} km/h`}`; const txt = keys.map(fmt).join(', '); change = { zones: out, keys, ko: txt, en: txt }; }
  }
  const lv = { ok: ['통과', 'pass'], near: ['경계', 'borderline'], high: ['실패', 'fail'] }[last.vd.level] || [last.vd.level, last.vd.level];
  const d = new Date(last.s.startedAt); const dTxt = `${d.getMonth() + 1}/${d.getDate()}`;
  const stepTxt = step > 0 ? `+${step.toFixed(1)}` : step < 0 ? step.toFixed(1) : '±0';
  const ko = `최근 검증(${dTxt}, ${last.s.speed} km/h): ${lv[0]} → 이번 주 검사 속도 ${next.toFixed(1)} km/h (${stepTxt}${capped ? ', 계단 검사 LT1 + 0.3 상한' : ''}).` + (n >= 2 ? ` ${lv[0]} ${n}회 연속${change ? ` → 범위 변경 가능: ${change.ko}` : ' — 현재 존과 모순 없음'}.` : ' 범위는 두 번 연속 같은 결과일 때만 바뀝니다.');
  const en = `Latest check (${dTxt}, ${last.s.speed} km/h): ${lv[1]} → this week's test speed ${next.toFixed(1)} km/h (${stepTxt}${capped ? ', capped at the step-test LT1 + 0.3' : ''}).` + (n >= 2 ? ` ${lv[1]} ${n} checks running${change ? ` → band change available: ${change.en}` : ' — consistent with the current zones'}.` : ' The band moves only after two consecutive results of the same kind.');
  const cadence = checkCadence(results);
  return { nextSpeed: next, step, from: 'result', capped, last: { date: last.s.startedAt, speed: last.s.speed, level: last.vd.level, id: last.s.id }, streak, change, results, cadence, ko: (cadence.mode === 'maintenance' ? ko.replace('이번 주 검사 속도', '다음 검사 속도') : ko) + ' ' + cadence.ko, en: (cadence.mode === 'maintenance' ? en.replace("this week's test speed", 'the next test speed') : en) + ' ' + cadence.en };
}
/**
 * MLSS checks at the current LT2 speed (v1.1.35): consecutive passes (rise ≤ 0.5 with the belt stopped ≤ 3 min) at `speed`, newest backwards —
 * the speed is raised 0.3 km/h after two of them, never after one (Beneke 2003: a stop for the sample blunts the rise). `mlssLa` = the end
 * lactate of the latest pass/hold, the value Settings → thresholds takes as the athlete's MLSS lactate.
 */
export function mlssPasses(sessions, speed, { days = 120, now = Date.now() } = {}) {
  const runs = (sessions || []).filter(s => s && s.final && s.sourceKind !== 'demo' && onBelt(s) && s.purpose === 'mlss' && Number.isFinite(s.speed) && now - s.startedAt <= days * 86400000).sort((a, b) => a.startedAt - b.startedAt);
  const results = runs.map(s => ({ s, vd: lactateVerdict(s) })).filter(x => x.vd && x.vd.kind === 'mlss');
  let n = 0; for (let i = results.length - 1; i >= 0; i--) { const x = results[i]; if (Number.isFinite(speed) && Math.abs(x.s.speed - speed) > 0.05) break; if (x.vd.pass) n++; else break; }
  const last = results.length ? results[results.length - 1] : null;
  const next = Number.isFinite(speed) ? (n >= 2 ? r1(speed + 0.3) : speed) : null;
  const ko = last ? `MLSS 검증 ${new Date(last.s.startedAt).getMonth() + 1}/${new Date(last.s.startedAt).getDate()} @ ${last.s.speed} km/h: ${last.vd.pass ? '통과' : last.vd.hold ? '유지(이 속도가 MLSS)' : last.vd.level === 'high' ? '초과' : '경계'} · 같은 속도 통과 ${n}/2${n >= 2 ? ` → 다음 검증 ${next} km/h` : ' → 다음도 같은 속도'}` : '아직 MLSS 검증 결과가 없습니다.';
  const en = last ? `MLSS check ${new Date(last.s.startedAt).getMonth() + 1}/${new Date(last.s.startedAt).getDate()} at ${last.s.speed} km/h: ${last.vd.pass ? 'pass' : last.vd.hold ? 'hold (this speed is the MLSS)' : last.vd.level === 'high' ? 'above' : 'borderline'} · passes at this speed ${n}/2${n >= 2 ? ` → next check at ${next} km/h` : ' → next check at the same speed'}` : 'No MLSS check result yet.';
  return { passes: n, results, last: last ? { date: last.s.startedAt, speed: last.s.speed, level: last.vd.level, pass: !!last.vd.pass, hold: !!last.vd.hold, mlssLa: last.vd.mlssLa ?? null, id: last.s.id } : null, nextSpeed: next, ko, en };
}
/**
 * Interval sessions (LT2 mode, more than one rep). The recoveries clear lactate, so the samples tell whether the reps were at the
 * intended intensity — the athlete's own MLSS lactate ± 0.5 after the last rep (v1.1.35; 3.0–4.5 until that value is known — lactate at
 * MLSS ranges 1.9–7.5 between people, Beneke 2000), not climbing from rep to rep — not where LT1 or MLSS lies. Neither the 10→30-min rise
 * rule nor the heart-rate proxy nor the LT1 limits apply, whatever purpose is chosen, and no zone change follows. A VO₂max session (4 × 4)
 * has no lactate target at all: its lactate is recorded, the session is judged on heart rate (90–95 % HRmax) and on holding the speed.
 */
function intervalVerdict(c, spTxt, delta, session = null) {
  const base = { adjust: null, intervals: true };
  if (session && session.intervals && session.intervals.kind === 'vo2') return { ...base, level: 'ok', vo2: true, ko: `VO₂max 세션: 젖산 ${c.end}${spTxt}은 기록만(목표 없음). 판정은 심박(최대 심박의 90–95 % 도달)과 속도 유지로 — 마지막 구간을 같은 속도로 못 끝냈으면 다음 −0.3, 모든 구간이 90 %에 못 미쳤으면 +0.3. 존 변경 없음.`, en: `VO₂max session: lactate ${c.end}${spTxt} is on record only (no target). Judge it on heart rate (reaching 90–95 % of max) and on holding the speed — last rep not finished at speed → next time −0.3; every rep under 90 % → +0.3. No zone change.` };
  const W = ladderLactateWindow(); const win = `${W.lo.toFixed(1)}–${W.hi.toFixed(1)}`; const tgtKo = W.own ? `본인 MLSS 젖산 ± 0.5(${win})` : `${win}(본인 MLSS 젖산 미설정 — MLSS 검증의 종료값을 설정 → 역치에 적으면 그 값 ± 0.5)`, tgtEn = W.own ? `your MLSS lactate ± 0.5 (${win})` : `${win} (own MLSS lactate not set — enter the MLSS check's end value in Settings → thresholds for your value ± 0.5)`;
  const noteKo = ' (인터벌은 회복 구간이 있어 LT1·MLSS 판정과 존 변경에는 쓰지 않습니다 — 검증은 정속 달리기로.)', noteEn = ' (With recoveries between reps this locates neither LT1 nor MLSS and changes no zones — verify with a constant run.)';
  const dTxt = delta != null ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}` : '';
  if (delta != null && delta > 1.0) return { ...base, level: 'high', ko: `인터벌 중 젖산 상승 ${dTxt} mmol/L (${c.mid} → ${c.end})${spTxt} — 반복마다 쌓이는 강도입니다. 다음엔 0.3 km/h 낮추세요.${noteKo}`, en: `Lactate rose ${dTxt} mmol/L across the reps (${c.mid} → ${c.end})${spTxt} — the pace accumulates lactate. Next time 0.3 km/h slower.${noteEn}` };
  if (c.end >= W.hi + 1.5) return { ...base, level: 'high', ko: `마지막 반복 후 젖산 ${c.end}${spTxt} — 목표 ${tgtKo}보다 1.5 이상 높습니다. 다음엔 0.3~0.5 km/h 낮추세요.${noteKo}`, en: `Lactate ${c.end} after the last rep${spTxt} — 1.5 or more above the target ${tgtEn}. Next time 0.3–0.5 km/h slower.${noteEn}` };
  if (c.end < W.lo) return { ...base, level: 'low', ko: `마지막 반복 후 젖산 ${c.end}${spTxt} — 목표 ${tgtKo} 아래. 구간 중 RPE가 7 미만이었다면 다음엔 +0.3 km/h, 7 이상이었다면 유지.${noteKo}`, en: `Lactate ${c.end} after the last rep${spTxt} — below the target ${tgtEn}. RPE under 7 during the reps → +0.3 km/h next time; 7 or more → hold.${noteEn}` };
  if (c.end <= W.hi) return { ...base, level: 'ok', ko: `마지막 반복 후 젖산 ${c.end}${spTxt}${delta != null ? `, 반복 간 변화 ${dTxt}` : ''} — 목표 범위 ${tgtKo} 안.${noteKo}`, en: `Lactate ${c.end} after the last rep${spTxt}${delta != null ? `, change across reps ${dTxt}` : ''} — on target (${tgtEn}).${noteEn}` };
  return { ...base, level: 'near', ko: `마지막 반복 후 젖산 ${c.end}${spTxt} — 목표 ${tgtKo}보다 높음. 다음엔 −0.3 km/h.${noteKo}`, en: `Lactate ${c.end} after the last rep${spTxt} — above the target ${tgtEn}. Next time −0.3 km/h.${noteEn}` };
}
function verdictCore(session, c, isMlss) {
  const sp = session.speed;
  const spTxt = Number.isFinite(sp) ? ` @ ${sp} km/h` : '';
  // the rest value of this session, else the resting baseline from Settings (measured on its own, under the sampling rules)
  const restUsed = c.rest != null ? c.rest : REST_BASELINE; const fromBase = c.rest == null && restUsed != null;
  const rise = restUsed != null ? c.end - restUsed : null; const delta = c.mid != null ? c.end - c.mid : null;
  const riseKo = rise != null ? ` (${fromBase ? `기준 안정 시 ${restUsed} 대비` : '안정 시'} ${rise >= 0 ? '+' : ''}${rise.toFixed(1)})` : '', riseEn = rise != null ? ` (${rise >= 0 ? '+' : ''}${rise.toFixed(1)} over ${fromBase ? `the resting baseline ${restUsed}` : 'rest'})` : '';
  const tl = session.type === 'test' ? null : runTimeline(session); const bouts = tl ? tl.bouts : 1;
  if (bouts === 0) return { level: 'near', adjust: null, intervals: true, ko: `워밍업 중에 끝난 세션입니다 — 젖산 ${c.end}은 기록만 하고 판정하지 않습니다.`, en: `The session ended in the warm-up — lactate ${c.end} is kept on record, no verdict.` };
  if (tl && tl.twoLap && !isMlss) return noHrText(session, twoLapVerdict(session, c, tl));
  if (bouts > 1 || (session.intervals && session.intervals.kind === 'vo2')) return intervalVerdict(c, spTxt, delta, session); // (a VO₂max session is judged as one whatever its rep count)
  if (isMlss) {
    if (delta != null) {
      // MLSS from the 10-min → end rise (v1.1.17): ≤ 0.5 → at/below MLSS, next +0.3 km/h — unless the belt stood for more than 3 min for
      // the sample (lactate clears while standing: the rise is understated — hold the speed); 0.5–1.0 → this speed IS the MLSS, hold it; > 1.0 → above.
      const gap = midStopSec(session, tl); const longGap = gap != null && gap > GAP_STRICT_SEC; const gapKo = gap != null ? ` (채혈 정지 ${Math.round(gap)}초)` : '', gapEn = gap != null ? ` (stop for the sample ${Math.round(gap)} s)` : '';
      // v1.1.35 (review §2): a stop for the sample blunts the rise and flatters the speed (Beneke 2003), so one pass never raises it — two passes at the same speed do (mlssPasses counts them); the end value is the athlete's MLSS lactate (the ladder's target ± 0.5).
      if (delta <= 0.5 && c.end < 8) return longGap ? { level: 'ok', adjust: null, hold: true, longGap: true, mlssLa: c.end, ko: `MLSS 이하 확인${spTxt}: ${midLabel(c).ko}→종료 상승 ${delta.toFixed(1)} mmol/L (≤0.5)${gapKo} — 정지가 3분을 넘어 상승이 과소평가됐을 수 있습니다. 상향 없이 같은 속도로 재검.`, en: `At/below MLSS${spTxt}: ${midLabel(c).en}→end rise ${delta.toFixed(1)} mmol/L (≤0.5)${gapEn} — the stop exceeded 3 min, so the rise may be understated. No raise: repeat at this speed.` }
        : { level: 'ok', adjust: null, pass: true, mlssLa: c.end, ko: `MLSS 이하 통과${spTxt}: ${midLabel(c).ko}→종료 상승 ${delta.toFixed(1)} mmol/L (≤0.5)${gapKo}. 같은 속도에서 통과 2회면 다음 +0.3 km/h(정지가 상승을 무디게 하므로 한 번으로는 올리지 않음) · 종료 ${c.end} = 본인 MLSS 젖산 → 설정에 저장.`, en: `At/below MLSS — pass${spTxt}: ${midLabel(c).en}→end rise ${delta.toFixed(1)} mmol/L (≤0.5)${gapEn}. Two passes at the same speed → +0.3 km/h next time (a stop blunts the rise, so one pass never raises it) · end ${c.end} = your MLSS lactate → save it in Settings.` };
      if (delta <= 1.0 && c.end < 8) return { level: 'ok', adjust: null, hold: true, mlssLa: c.end, ko: `MLSS 확인${spTxt}: ${midLabel(c).ko}→종료 상승 ${delta.toFixed(1)} mmol/L (0.5–1.0)${gapKo} — 이 속도가 MLSS입니다. 속도 유지(상향 없음) · 종료 ${c.end} = 본인 MLSS 젖산 → 설정에 저장.`, en: `MLSS confirmed${spTxt}: ${midLabel(c).en}→end rise ${delta.toFixed(1)} mmol/L (0.5–1.0)${gapEn} — this speed is the MLSS. Hold it (no raise) · end ${c.end} = your MLSS lactate → save it in Settings.` };
      return { level: 'high', adjust: { lt2Speed: -0.4 }, ko: `MLSS 초과${spTxt}: ${midLabel(c).ko}→종료 상승 ${delta.toFixed(1)} mmol/L (>1.0)${gapKo}. LT2 속도를 0.4 km/h 낮추세요.`, en: `Above MLSS${spTxt}: rise ${delta.toFixed(1)} mmol/L (>1.0)${gapEn}. Lower the LT2 speed by 0.4 km/h.` };
    }
    if (c.end >= 6) return { level: 'high', adjust: { lt2Speed: -0.4 }, ko: `종료 젖산 ${c.end} — LT2 위일 가능성${spTxt}. 10분 샘플을 추가하면 판정이 확실해집니다.`, en: `End lactate ${c.end} — likely above LT2${spTxt}. Add a 10-min sample next time for a firm call.` };
    if (c.end < 3) return { level: 'low', adjust: null, proxy: true, ko: `종료 젖산 ${c.end} — LT2 아래일 가능성${spTxt}(종료값만: 상향 근거로는 부족 — 10분 샘플이 있는 MLSS 검증에서 통과 2회).`, en: `End lactate ${c.end} — probably below LT2${spTxt} (end value only: not enough to raise the speed — two passes in an MLSS check with a 10-min sample are).` };
    // End-only MLSS proxy (solo use, no 10-min sample): must complete ≥ 25 min; HR drift (min 8–13 → last 5 min) ≤ 6 bpm and SmO2 steady → likely at/below MLSS; drift > 8 bpm or SmO2 still falling → likely above (v1.1.23: no RPE).
    const px = endOnlyProxy(session);
    // Running time, drift and the SmO2 end slope all hang on where the run ended: without a known end, no proxy call.
    if (!px.sure) return { level: 'near', adjust: null, unsure: true, ko: `종료 젖산 ${c.end} — 달리기가 끝난 시점이 불확실해 심박·SmO₂ 대리 판정은 보류합니다${spTxt}. 위의 「달리기 종료」 칸에서 시각을 확정하거나, 다음엔 10분 샘플을 추가하세요.`, en: `End lactate ${c.end} — where the run ended is uncertain, so the heart-rate / SmO2 proxy call is withheld${spTxt}. Confirm the end of the run in the field above, or add a 10-min sample next time.` };
    if (px.durMin < 25) return { level: 'near', adjust: null, ko: `종료 젖산 ${c.end} — ${Math.round(px.durMin)}분만 달려 MLSS 판정 보류${spTxt}. 30분을 채우거나(힘들어 중단했다면 MLSS 위) 10분 샘플을 추가하세요.`, en: `End lactate ${c.end} — only ${Math.round(px.durMin)} min, MLSS call withheld${spTxt}. Complete 30 min (if you stopped from fatigue, treat as above MLSS) or add a 10-min sample.` };
    const dTxt = Number.isFinite(px.driftBpm) ? `${px.driftBpm >= 0 ? '+' : ''}${px.driftBpm.toFixed(0)} bpm` : 'n/a';
    const bad = []; if (Number.isFinite(px.driftBpm) && px.driftBpm > 8) bad.push(`심박 드리프트 ${dTxt}|HR drift ${dTxt}`); if (px.smo2Steady === false) bad.push('SmO₂ 계속 하락|SmO2 still falling');
    // v1.1.35 (review §5): heart-rate drift and SmO₂ are information — at MLSS heart rate drifts +12.6 bpm with flat lactate (Can J Appl Physiol 2000), so a small drift proves no steady state and a large one none of its absence. The proxy may say "likely above" but never raises a speed.
    if (bad.length) return { level: 'high', adjust: null, proxy: true, ko: `종료 젖산 ${c.end} + ${bad.map(b => b.split('|')[0]).join(', ')} — MLSS 초과 가능성(대리 지표, 정보)${spTxt}. 다음은 같은 속도로 10분 샘플을 넣어 확인; 힘들어 중단했다면 −0.3.`, en: `End lactate ${c.end} + ${bad.map(b => b.split('|')[1]).join(', ')} — possibly above MLSS (proxy, information)${spTxt}. Next time confirm at this speed with a 10-min sample; if you stopped from fatigue, −0.3.` };
    if (Number.isFinite(px.driftBpm) && px.driftBpm <= 6) return { level: 'near', adjust: null, proxy: true, ko: `종료 젖산 ${c.end}, 심박 드리프트 ${dTxt} (8–13분 → 마지막 5분)${px.smo2Steady ? ', SmO₂ 안정' : ''} — MLSS 이하일 수 있음(대리 지표, 정보; 상향 근거 아님)${spTxt}. 확정하려면 10분 샘플이 있는 MLSS 검증.`, en: `End lactate ${c.end}, HR drift ${dTxt} (min 8–13 → last 5)${px.smo2Steady ? ', SmO2 steady' : ''} — may be at/below MLSS (proxy, information; no raise on it)${spTxt}. To confirm, an MLSS check with a 10-min sample.` };
    return { level: 'near', adjust: null, proxy: true, ko: `종료 젖산 ${c.end}, 심박 드리프트 ${dTxt} — MLSS 경계(대리 지표)${spTxt}. 같은 속도로 재검하거나 10분 샘플을 추가하세요.`, en: `End lactate ${c.end}, HR drift ${dTxt} — borderline MLSS (proxy)${spTxt}. Repeat at this speed or add a 10-min sample.` };
  }
  // Long runs (more than LONG_RUN_MIN of running): the LT1 rule (end ≤ rest + 1.0) is made for a 30–35-min check. Over 90 min
  // lactate can creep up from duration alone (heat, fluids, glycogen) at a speed well below LT1, so a long run says how the
  // athlete held up, not where LT1 lies: no zone change from it, and its end value is kept out of the multi-day curve.
  const px1 = endOnlyProxy(session);
  if (px1.sure && px1.durMin > LONG_RUN_MIN) {
    const mins = Math.round(px1.durMin); const mTxt = c.mid != null ? `${midLabel(c).ko} ${c.mid} → ` : '', mEn = c.mid != null ? `${midLabel(c).en} ${c.mid} → ` : '';
    const dRise = delta != null ? delta : rise; const dK = delta != null ? '중간 대비' : '안정 대비', dE = delta != null ? 'from the mid sample' : 'over rest';
    const base = { adjust: null, longRun: true };
    if (c.end <= 2.0 && (rise == null || rise <= 1.0)) return { ...base, level: 'ok', ko: `롱런 ${mins}분: ${mTxt}종료 ${c.end}${riseKo} — 끝까지 LT1 아래, 지구력 양호${spTxt}.`, en: `Long run, ${mins} min: ${mEn}end ${c.end}${riseEn} — below LT1 throughout, good durability${spTxt}.` };
    if (c.end <= 2.5 && (dRise == null || dRise <= 1.5)) return { ...base, level: 'near', ko: `롱런 ${mins}분: ${mTxt}종료 ${c.end} (${dK} +${(dRise ?? 0).toFixed(1)}) — 긴 시간에 따른 상승${spTxt}. LT1 판정·존 변경에는 쓰지 않습니다. 다음 롱런은 같은 속도에 수분·보급을 챙기거나 −0.3 km/h.`, en: `Long run, ${mins} min: ${mEn}end ${c.end} (+${(dRise ?? 0).toFixed(1)} ${dE}) — a rise from duration${spTxt}. Not used for LT1 or the zones. Next long run: same speed with fluids and fuel, or −0.3 km/h.` };
    return { ...base, level: 'high', ko: `롱런 ${mins}분: ${mTxt}종료 ${c.end}${riseKo} — 이 시간에는 강도가 높았습니다${spTxt}. 다음 롱런은 −0.3~−0.5 km/h. (LT1 판정·존 변경에는 쓰지 않음)`, en: `Long run, ${mins} min: ${mEn}end ${c.end}${riseEn} — too hard for this duration${spTxt}. Next long run −0.3 to −0.5 km/h. (Not used for LT1 or the zones.)` };
  }
  // LT1 / easy runs
  const tooHigh = c.end > 2.5 || (rise != null && rise > 1.5);
  const border = !tooHigh && (c.end > 2.0 || (rise != null && rise > 1.0));
  if (tooHigh) return { level: 'high', adjust: { lt1Hr: -4 }, ko: `종료 젖산 ${c.end}${riseKo} — LT1 위${spTxt}. 목표 심박 −4 bpm 후 재검증.`, en: `End lactate ${c.end}${riseEn} — above LT1${spTxt}. Target HR −4 bpm, then verify again.` };
  if (border) return { level: 'near', adjust: { lt1Hr: -2 }, ko: `종료 젖산 ${c.end}${riseKo} — LT1 경계${spTxt}. 목표 심박 −2 bpm.`, en: `End lactate ${c.end}${riseEn} — borderline LT1${spTxt}. Target HR −2 bpm.` };
  return { level: 'ok', adjust: null, ko: `종료 젖산 ${c.end}${riseKo} — LT1 아래 확인${spTxt}.`, en: `End lactate ${c.end}${riseEn} — below LT1 confirmed${spTxt}.` };
}
/**
 * Zone change proposed by a verification verdict, using the run's own speed and steady-state HR.
 * Confirmed runs raise a floor (LT ≥ this speed/HR); failed runs lower a cap (LT < this speed/HR). Returns null when nothing changes.
 * The heart rate is used only when the end of the run is known (endWindowStats.sure) — a heart rate averaged into the recovery
 * would move the zone to a wrong place; the speed part does not depend on it. Interval sessions change nothing.
 */
export function verdictZoneChange(zones, session, vd = lactateVerdict(session)) {
  if (!vd || vd.intervals || vd.longRun || vd.twoLap || vd.proxy || !onBelt(session)) return null; /* v1.1.36: a speed off the belt moves no zone */ const z = zones || {}; const ew = endWindowStats(session, 300); const sp = session.speed; // (two-lap LT1 runs: the band finder, after two consecutive results; v1.1.35: end-only proxies change nothing)
  const hr = ew.sure && Number.isFinite(ew.hr) ? Math.round(ew.hr) : NaN; const out = { ...z }; const r1 = v => Math.round(v * 10) / 10;
  const up = (k, v) => { if (Number.isFinite(v) && !(z[k] >= v)) out[k] = v; }; const down = (k, v) => { if (Number.isFinite(v) && !(z[k] <= v)) out[k] = v; };
  if (vd.kind === 'mlss') {
    if (vd.level === 'ok' || vd.level === 'low') { up('lt2Speed', Number.isFinite(sp) ? r1(sp) : NaN); up('lt2Hr', hr); }
    else if (vd.level === 'high') { down('lt2Speed', Number.isFinite(sp) ? r1(sp - 0.3) : NaN); down('lt2Hr', Number.isFinite(hr) ? hr - 3 : NaN); }
  } else {
    if (vd.level === 'ok') { up('lt1Speed', Number.isFinite(sp) ? r1(sp) : NaN); up('lt1Hr', hr); }
    else if (vd.level === 'near') { down('lt1Speed', Number.isFinite(sp) ? r1(sp) : NaN); down('lt1Hr', Number.isFinite(hr) ? hr - 2 : NaN); }
    else if (vd.level === 'high') { down('lt1Speed', Number.isFinite(sp) ? r1(sp - 0.5) : NaN); down('lt1Hr', Number.isFinite(hr) ? hr - 5 : NaN); }
  }
  const keys = ['lt1Hr', 'lt1Speed', 'lt2Hr', 'lt2Speed'].filter(k => out[k] !== z[k] && Number.isFinite(out[k]));
  if (!keys.length) return null;
  const fmt = k => `${k.startsWith('lt1') ? 'LT1' : 'LT2'} ${k.endsWith('Hr') ? `${Number.isFinite(z[k]) ? Math.round(z[k]) : '–'}→${out[k]} bpm` : `${Number.isFinite(z[k]) ? z[k] : '–'}→${out[k]} km/h`}`;
  const txt = keys.map(fmt).join(', ');
  return { zones: out, keys, ko: txt, en: txt };
}
/**
 * Multi-day lactate curve: constant-speed sessions (last `days`; demo and interval sessions excluded) → lactate vs speed (+ HR).
 * v1.1.17 rules: a two-lap run is a point by its end value (lap 2 of 20–35 min) with the heart rate of lap-1 minutes 5–10; a single
 * constant run of 15–35 min by its end value with the heart rate of minutes 8–13 (before the drift); a run of more than 35 min at
 * speed is a durability reading, not a point — unless a mid sample was taken 20–35 min in (that value, same heart-rate window).
 * A run whose end is uncertain gives its lactate; its heart rate (read early in the run) stands when the run plainly lasted that long.
 */
export function multiDayCurve(sessions, { days = 60, incline = null } = {}) {
  const now = Date.now(); const pts = [];
  // skipped: recent real sessions that carry lactate but are not a point, with the reason — shown under the curve, so nothing drops out unseen
  const skipped = []; const skip = (s, why, c = {}, extra = {}) => skipped.push({ id: s.id, date: s.startedAt, x: s.speed, why, mid: c.mid ?? null, midMin: c.midMin ?? null, ...extra });
  for (const s of sessions) {
    if (!s || s.type === 'test' || s.sourceKind === 'demo') continue; // demo (virtual strap) sessions are practice, not data
    if (now - s.startedAt > days * 86400000) continue;
    if (!onBelt(s)) { if (lactateChecks(s).end != null) skip(s, 'off-belt'); continue; } // v1.1.36: track / non-motorized speeds are no curve points
    if (incline != null && Number.isFinite(s.incline) && Math.abs(s.incline - incline) > 0.6) continue;
    const c = lactateChecks(s); if (c.end == null && c.mid == null) continue; // no lactate at all: not a verification run
    if (!s.final) { skip(s, 'unfinished', c); continue; }
    if (!Number.isFinite(s.speed)) { skip(s, 'no-speed', c); continue; }
    const tl = runTimeline(s);
    if (tl.twoLap) {
      const ls = lapStats(s, tl);
      if (c.end == null) { skip(s, 'no-end', c); continue; }
      if (ls.lap2Min > CURVE_MAX_MIN + 0.75) { skip(s, 'durability', c, { atMin: Math.round(ls.lap2Min) }); continue; } // (45 s of grace: a 35-min lap whose stop the heart rate timed a little late is still a 35-min lap)
      if (ls.lap2Min < 20 - 0.5) { skip(s, 'too-short', c, { atMin: Math.round(ls.lap2Min) }); continue; }
      pts.push({ x: s.speed, la: c.end, hr: ls.lap1Hr, alpha1: NaN, unsure: !tl.sure, from: 'lap2', atMin: Math.round(ls.lap2Min), lap1: c.mid, id: s.id, date: s.startedAt, incline: s.incline });
      continue;
    }
    const w = endWindowStats(s, 300);
    if (w.bouts !== 1) { skip(s, 'intervals', c); continue; } // intervals: lactate after reps with recoveries is not a point of the constant-speed curve
    const px = endOnlyProxy(s); const hrEarly = earlyWindowHr(s, tl);
    if (px.sure && px.durMin > CURVE_MAX_MIN + 0.75) {
      // more than 35 min at speed: the end value carries the duration (drift, fluids, glycogen), not the speed — a durability reading.
      // A sample taken 20–35 min in, while the run was still going, is comparable with a 30-min check — that one is the point.
      if (!(c.mid != null && Number.isFinite(c.midMin) && c.midMin >= 20 && c.midMin <= CURVE_MAX_MIN)) { skip(s, 'durability', c, { atMin: Math.round(px.durMin) }); continue; }
      pts.push({ x: s.speed, la: c.mid, hr: hrEarly, alpha1: NaN, unsure: false, from: 'mid', atMin: c.midMin, id: s.id, date: s.startedAt, incline: s.incline });
      continue;
    }
    if (c.end == null) { skip(s, 'no-end', c); continue; }
    if (px.sure && px.durMin < CURVE_MIN_MIN) { skip(s, 'too-short', c, { atMin: Math.round(px.durMin) }); continue; }
    pts.push({ x: s.speed, la: c.end, hr: hrEarly, alpha1: w.sure ? w.alpha1 : NaN, unsure: !w.sure, from: 'end', atMin: Math.round(px.durMin), id: s.id, date: s.startedAt, incline: s.incline });
  }
  // one point per speed: keep the most recent
  const bySpeed = new Map(); for (const p of pts.sort((a, b) => a.date - b.date)) bySpeed.set(p.x, p);
  const points = [...bySpeed.values()].sort((a, b) => a.x - b.x);
  // the heart rate of a run whose end is uncertain is read off the certain runs on either side of it — never beyond them (a copy of the
  // nearest run's heart rate would put a made-up threshold heart rate into the zones)
  const known = points.filter(p => Number.isFinite(p.hr)); const lo = known.length ? known[0].x : NaN, hi = known.length ? known[known.length - 1].x : NaN;
  const hrOf = p => Number.isFinite(p.hr) ? p.hr : (known.length >= 2 && p.x >= lo && p.x <= hi ? interp(known.map(q => q.x), known.map(q => q.hr), p.x) : NaN);
  const analysis = points.length >= 3 ? analyzeLactate(points.map(p => ({ x: p.x, la: p.la, hr: hrOf(p) }))) : null;
  const trust = analysis ? curveTrust(points, analysis, hrOf) : null;
  const span = points.length ? Math.max(...points.map(p => p.la)) - Math.min(...points.map(p => p.la)) : 0;
  const grade = points.length >= 5 && span >= 2 ? 'B' : points.length >= 3 ? 'C' : '-';
  return { points, analysis, grade, skipped, trust };
}
/** Lactate the points of a multi-day curve must reach before the curve may place LT2 (v1.1.26): points that stop below it describe the curve up to LT1 only. */
export const CURVE_LT2_MIN_LA = 4.0;
/**
 * What the points of a multi-day curve can carry (v1.1.26). The weekly checks put the points close together around LT1 (7.8 · 8.5 · 8.7 ·
 * 8.9 · 9.0 km/h): a polynomial through such points can cross the LT1 line where no point supports it (with a fifth point the cubic
 * gave LT1 7.8 km/h right after a pass at 8.9), and a Dmax taken on points that stop far below LT2 lands inside them (LT2 9.0 km/h
 * from a highest value of 2.8) — and 「이 역치를 존에 적용」 would have written both. So the primaries of `analysis` are corrected here:
 *   LT1 = where the lactate leaves the line (lowest + 0.5) for good — between the fastest point under the line and the next faster
 *         one. A fitted crossing outside that pair is replaced by the straight line between the two (`fixed`). When the fastest
 *         point is still under the line, LT1 lies above it: not reached, no value (`why: 'not-reached'`).
 *   LT2 = only when the points reach CURVE_LT2_MIN_LA and the estimate lies above LT1; otherwise no value (`why`: 'none' = too few
 *         points for the method, 'not-reached', 'below-lt1').
 * → { lt1: { ok, why, lo, hi, line, fixed }, lt2: { ok, why, maxLa }, apply, raw: { lt1, lt2 } } — raw = what the fit alone said.
 */
function curveTrust(points, analysis, hrOf) {
  const P = points, L1 = analysis.lt1Primary, L2 = analysis.lt2Primary; const raw = { lt1: { x: L1.x, hr: L1.hr }, lt2: { x: L2.x, hr: L2.hr } };
  const none = L => { L.x = NaN; L.hr = NaN; };
  const line = Math.min(...P.map(p => p.la)) + 0.5; let iLo = -1; for (let i = 0; i < P.length; i++) if (P[i].la < line - 1e-9) iLo = i; // the fastest point under the line
  const lt1 = { ok: false, why: null, lo: iLo >= 0 ? P[iLo].x : null, hi: null, line: r1(line), fixed: false };
  if (iLo < 0 || iLo === P.length - 1) { lt1.why = 'not-reached'; none(L1); }
  else {
    const a = P[iLo], b = P[iLo + 1]; lt1.hi = b.x;
    if (!(Number.isFinite(L1.x) && L1.x >= a.x - 0.05 && L1.x <= b.x + 0.05)) { // the fit crosses the line where the points do not: the straight line between the two points that do
      const t = (line - a.la) / (b.la - a.la); const ha = hrOf(a), hb = hrOf(b);
      L1.x = a.x + t * (b.x - a.x); L1.hr = Number.isFinite(ha) && Number.isFinite(hb) ? ha + t * (hb - ha) : NaN; L1.note = 'between the measured points'; lt1.fixed = true;
    }
    lt1.ok = Number.isFinite(L1.x);
  }
  const maxLa = Math.max(...P.map(p => p.la)); const lt2 = { ok: false, why: null, maxLa };
  if (!Number.isFinite(L2.x)) lt2.why = 'none';
  else if (maxLa < CURVE_LT2_MIN_LA - 1e-9) lt2.why = 'not-reached';
  else if (lt1.ok && !(L2.x > L1.x)) lt2.why = 'below-lt1';
  else lt2.ok = true;
  if (!lt2.ok) none(L2);
  return { lt1, lt2, apply: lt1.ok && lt2.ok && Number.isFinite(L1.hr) && Number.isFinite(L2.hr), raw };
}

// Zones, weekly plan, progression, auto-adjustments, lactate verification runs and rule-based summaries (KO/EN).
import { analyzeLactate, interp } from './lactate.js';
import { list, smo2Steady, runTimeline, inStop, alphaTainted, runWindowStart, runWindowEnd, stoppedMs, alphaOn, ALPHA_ARTIFACT_MAX } from './analysis.js';
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
  return { three, five, lt1Hr, lt2Hr, lt1Speed, lt2Speed, maxHr };
}

/** Live-session targets by type. offsets: LT1 session = LT1−10…LT1−3 bpm; LT2 = LT2 ±3. */
export function sessionTargets(zones, type, opts = {}) {
  if (!zones) return null;
  const { lt1Hr, lt2Hr, lt1Speed, lt2Speed } = zones; const adj = opts.lt1Adjust || 0;
  // ceilHr / lateFromSec (v1.1.17): after 20 min of an LT1 session the ceiling is LT1 + 5 — the drift of a steady run is allowed; above it, "slow down 0.3"
  if (type === 'lt1') return { hrLo: Math.round(lt1Hr - 10 + adj), hrHi: Math.round(lt1Hr - 3 + adj), ceilHr: Math.round(lt1Hr + 5), lateFromSec: 1200, judgeFromSec: 600, speedLo: Number.isFinite(lt1Speed) ? r1(lt1Speed - 1.0) : NaN, speedHi: Number.isFinite(lt1Speed) ? r1(lt1Speed - 0.3) : NaN, alphaMin: 0.75, durationSec: (opts.minutes || 50) * 60 };
  if (type === 'lt2') return { hrLo: Math.round(lt2Hr - 3), hrHi: Math.round(lt2Hr + 3), speedLo: Number.isFinite(lt2Speed) ? r1(lt2Speed - 0.3) : NaN, speedHi: Number.isFinite(lt2Speed) ? r1(lt2Speed) : NaN, alphaMin: null };
  return null;
}

/** LT2 session structure by progression week (1-based, cycles of 8; week 4 and 8 are recovery). */
export function lt2Structure(week) {
  const w = ((week - 1) % 8) + 1;
  const table = { 1: [4, 8], 2: [4, 10], 3: [5, 10], 4: null, 5: [3, 15], 6: [2, 20], 7: [1, 30], 8: null };
  const t = table[w]; if (!t) return null;
  const [reps, min] = t; const rest = min >= 15 ? 4 : 3;
  return { reps, workSec: min * 60, restSec: rest * 60, warmupSec: 600, cooldownSec: 360, label: reps === 1 ? `템포 ${min}분 / tempo ${min} min` : `${reps}×${min}분 (회복 ${rest}분) / ${reps}×${min} min (${rest}-min easy)` };
}
export const isRecoveryWeek = week => ((week - 1) % 8) + 1 === 4 || ((week - 1) % 8) + 1 === 8;

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
 * to its Monday). kinds: recovery (the whole week easy: Tuesday easy, long run × 0.7, strength RPE 7) · mlss (Tuesday = the 30-min MLSS
 * check) · easy (Tuesday easy, reason in the note) · blood (Tuesday easy, Thursday no run: a fasted blood draw; the check skips a week) ·
 * step (Saturday = the lactate step test instead of the long run). Weeks with recovery / mlss / easy / blood do not count as ladder weeks,
 * so the LT2 ladder (lt2Structure) goes on where it stopped. Lines without a known kind are ignored; `#` starts a comment.
 */
export const CALENDAR_KINDS = ['recovery', 'mlss', 'easy', 'blood', 'step'];
const NON_LADDER = ['recovery', 'mlss', 'easy', 'blood'];
const localDate = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
const atNoon = s => new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? s + 'T12:00:00' : s);
/** The Monday of the week that holds `d` (a Date, ms, or 'YYYY-MM-DD'), as 'YYYY-MM-DD' in local time. */
export function mondayOf(d) { const x = atNoon(d); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return localDate(x); }
export function parseCalendar(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\d{4}-\d{2}-\d{2})\s+([A-Za-z]+)\s*(.*)$/); if (!m) continue;
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
  let ladderWeek = 0, longWeek = 0; // longWeek: the weeks that had a long run (a step-test week has none, so the long run does not grow across it)
  for (let i = 0; i <= diffWeeks; i++) { const d = atNoon(start); d.setDate(d.getDate() + 7 * i); const k = (cal[localDate(d)] || { kinds: [] }).kinds; if (!k.some(x => NON_LADDER.includes(x))) ladderWeek++; if (!k.includes('step')) longWeek++; }
  const here = cal[monday] || { kinds: [], notes: [] };
  return { monday, blockWeek: Math.max(1, diffWeeks + 1), ladderWeek: Math.max(1, ladderWeek), longWeek: Math.max(1, longWeek), kinds: here.kinds.slice(), notes: here.notes.slice(), calendar: cal };
}
const r5 = x => Math.round(x / 5) * 5;
/**
 * The week as decided on 2026-10-10 (v1.1.18): mornings run, evenings other exercise. Mon easy 50 · Tue the one hard day (the LT2 ladder at
 * MLSS speed; an MLSS check or an easy run when the calendar says so) · Wed easy 50 · Thu the two-lap LT1 check (45 min, fasted) · Fri easy 30
 * optional · Sat long run 70 → 100 min (+10 a week, × 0.7 in recovery weeks, ≤ 110 % of the 30-day longest) · Sun easy 50. Evenings: Mon home
 * session, Tue strength A, Wed walk, Thu strength B, Fri foam-roll/calf/wall-sit, Sun optional incline walk.
 * `week` = the ladder week (lt2Structure / isRecoveryWeek), `blockWeek` = weeks since the block start, `longWeek` = long-run weeks so far (the long run grows with it; default blockWeek), `kinds`/`notes` = this
 * week's calendar entries (planContext). weekdayMin only shortens the easy days when it is below 55; weekendMin caps the long run.
 */
export function weeklyPlan({ zones, week = 1, blockWeek = week, longWeek = blockWeek, weekdayMin = 60, weekendMin = 150, goal = 'base', lt1Adjust = 0, longestMin = null, verifySpeed = null, kinds = [], notes = [] }) {
  const K = kinds || []; const rec = isRecoveryWeek(week) || K.includes('recovery'); const k = rec ? 0.7 : 1; const lightWeek = rec || K.includes('easy') || K.includes('blood');
  const T1 = sessionTargets(zones, 'lt1', { lt1Adjust }); const T2 = sessionTargets(zones, 'lt2');
  const steady = T1 ? { hrLo: T1.hrLo, hrHi: T1.hrHi } : null; // every easy run = the LT1 session band (LT1 −10…−3 at minute 10; the ceiling LT1 + 5 after 20 min is the session's)
  const band = T1 && Number.isFinite(T1.speedLo) ? [T1.speedLo, T1.speedHi] : null; const bandTxt = band ? ` · ${band[0].toFixed(1)}–${band[1].toFixed(1)} km/h` : '';
  const lt1Hr = zones && Number.isFinite(zones.lt1Hr) ? zones.lt1Hr : null; const lt1Speed = zones && Number.isFinite(zones.lt1Speed) ? zones.lt1Speed : null;
  const easyMin = Math.max(30, Math.min(50, Math.round(Math.min(weekdayMin, 60)) - 5)); // 50 unless the weekday allowance is below 55
  // every instruction with a number (v1.1.20): warm-up and cool-down speeds, what "over it" means in seconds, the readiness gate, the evenings
  const f1 = x => (Math.round(x * 10) / 10).toFixed(1);
  const wu = lt1Speed != null ? { lo: f1(lt1Speed - 1.7), hi: f1(lt1Speed - 1.2) } : null; // easy jog of the warm-ups (7.0–7.5 at LT1 8.7)
  const z1Top = lt1Hr != null ? Math.round(lt1Hr - 15) : null; // the app's Z1 ceiling (128 at LT1 143): the warm-up stays under it
  const strideSp = zones && Number.isFinite(zones.lt2Speed) ? f1(zones.lt2Speed + 1.0) : null;
  const lt2Sp = zones && Number.isFinite(zones.lt2Speed) ? zones.lt2Speed : null;
  const GATE = { ko: '실시 조건: 수면 ≥ 7시간 · 안정 심박 < 7일 평균 + 7(+4 이상이면 RMSSD ≥ 7일 평균의 80 %) · 통증 ≤ 2/10 — 하나라도 아니면', en: 'do it only if: sleep ≥ 7 h · resting HR < 7-day mean + 7 (from + 4 on, RMSSD ≥ 80 % of its 7-day mean) · pain ≤ 2/10 — otherwise' };
  const easyDay = (day, min, extraKo = '', extraEn = '', strides = false) => ({ day, type: 'lt1', ko: `쉬운 런 ${min}분${extraKo}`, en: `Easy run ${min} min${extraEn}`, minutes: min, hr: steady, speed: band, note: {
    ko: `0–5분 ${wu ? `${wu.lo}–${wu.hi}` : '–'} km/h → 본 구간${bandTxt}(속도가 용량) → 마지막 3분 걷기 5.5 · 심박은 천장: 10분부터 ${steady ? `${steady.hrLo}–${steady.hrHi}` : '–'}, 위로 30초 넘으면 −0.3 km/h · 20분부터 천장 ${lt1Hr != null ? lt1Hr + 5 : '–'}, 60초 넘으면 −0.3 · 15분마다 말하기(10단어 문장을 한 번에) — 안 되면 −0.3${strides && strideSp ? ` · 끝에 스트라이드 4×20초 @ ${strideSp} km/h, 사이 걷기 60초` : ''}`,
    en: `0–5 min at ${wu ? `${wu.lo}–${wu.hi}` : '–'} km/h → main part${bandTxt} (speed is the dose) → last 3 min walk 5.5 · heart rate is a ceiling: ${steady ? `${steady.hrLo}–${steady.hrHi}` : '–'} from minute 10, 30 s above it → −0.3 km/h · from minute 20 ceiling ${lt1Hr != null ? lt1Hr + 5 : '–'}, 60 s above → −0.3 · talk test every 15 min (a 10-word sentence in one breath) — failed → −0.3${strides && strideSp ? ` · 4 × 20 s strides at ${strideSp} km/h at the end, 60 s walk between` : ''}` } });
  // the long run: 70 min in the first long-run week, +10 a week, up to 100 (120 for a performance goal), × 0.7 in a recovery week, ≤ 110 % of the 30-day longest
  let longMin = Math.min(weekendMin, r5(Math.min(goal === 'perf' ? 120 : 100, 70 + 10 * (Math.max(1, longWeek) - 1)) * k)); let longCap = null;
  if (Number.isFinite(longestMin) && longestMin > 0) { const cap = Math.max(30, r5(1.1 * longestMin)); if (cap < longMin) { longMin = cap; longCap = { longestMin, cap }; } }
  const st = lt2Structure(week); const noteTxt = notes && notes.length ? notes.join(' · ') : '';
  const vs = Number.isFinite(verifySpeed) ? verifySpeed : lt1Speed;
  const rpe7 = lightWeek ? { ko: ' · RPE 7 · 볼륨 −30 %', en: ' · RPE 7 · volume −30 %' } : { ko: ' · RPE 8(2회 남김)', en: ' · RPE 8 (2 reps in reserve)' };
  // v1.1.21: other exercise = a noon session of ≤ 30 min before lunch (11:30–12:00, eat after) + an evening extra at 17:30 only without overtime
  const EVE_GATE = { ko: '야근 없음 + ' + GATE.ko.replace('실시 조건: ', '') + ' 쉼 · 18:00 전 종료', en: 'no overtime + ' + GATE.en.replace('do it only if: ', '') + ' rest · done by 18:00' };
  const strengthNote = { ko: `11:30 워밍업 5분 + 메인 2종목(스쿼트/데드리프트 3세트, 사이 120–150초 · 벤치↔친업/OHP↔로우 3세트 슈퍼세트, 사이 90초), 12:00 전 종료 → 점심${rpe7.ko} · 모든 반복을 RPE ≤ 8로 마치면 다음에 하체 +5 kg·상체 +2.5 kg`, en: `11:30 warm-up 5 min + the main lifts (squat/deadlift 3 sets, 120–150 s between · bench↔chin-up / OHP↔row 3 supersets, 90 s), done before 12:00 → lunch${rpe7.en} · all reps done at RPE ≤ 8 → next time +5 kg lower / +2.5 kg upper` };
  const accessoryNote = { ko: `17:30 보조 25분(야근 없을 때): RDL↔팔로프 / 불가리안↔페이스 풀 슈퍼세트, 파머스 캐리 2×40 m, 앉은 카프 3×15, 한발 균형 30초×2/측${rpe7.ko} · ${EVE_GATE.ko}`, en: `17:30 accessories 25 min (no overtime): RDL↔Pallof / Bulgarian↔face pull supersets, farmer's carry 2 × 40 m, seated calf 3 × 15, single-leg stand 30 s × 2/side${rpe7.en} · ${EVE_GATE.en}` };
  let tue;
  if (K.includes('mlss')) tue = { day: 2, type: 'verify', purpose: 'mlss', ko: 'MLSS 검증 30분 (두 랩 MLSS 변형)', en: 'MLSS check 30 min (two-lap MLSS variant)', minutes: 37, hr: T2, speed: lt2Sp, note: { ko: `공복 · 워밍업 5분 = 2분 ${wu ? wu.hi : '–'} → 3분 ${lt1Speed != null ? f1(lt1Speed - 0.2) : '–'} km/h → 랩 1 10분 @ LT2 속도${lt2Sp != null ? ` ${f1(lt2Sp)} km/h` : ''}(심박 ${T2 ? `${T2.hrLo}–${T2.hrHi}` : '–'}) → 정지 ≤ 45초(30–45초에 채혈) → 랩 2 20분 → 종료 채혈 → 걷기 5분 5.5 · 상승 ≤ 0.5 → 다음 +0.3 · 0.5–1.0 → 그 속도가 MLSS, 유지 · > 1.0 → −0.4 · 정지 > 3분이면 상향 없음`, en: `fasted · warm-up 5 min = 2 min at ${wu ? wu.hi : '–'} → 3 min at ${lt1Speed != null ? f1(lt1Speed - 0.2) : '–'} km/h → lap 1 10 min at the LT2 speed${lt2Sp != null ? ` ${f1(lt2Sp)} km/h` : ''} (HR ${T2 ? `${T2.hrLo}–${T2.hrHi}` : '–'}) → stop ≤ 45 s (sample at 30–45 s) → lap 2 20 min → end sample → 5 min walk at 5.5 · rise ≤ 0.5 → +0.3 next time · 0.5–1.0 → that speed is the MLSS, hold · > 1.0 → −0.4 · a stop over 3 min → no raise` } };
  else if (lightWeek || !st) tue = { day: 2, type: 'lt1', ko: `쉬운 런 45분${rec ? ' (회복주)' : ''}`, en: `Easy run 45 min${rec ? ' (recovery week)' : ''}`, minutes: 45, hr: steady, speed: band, note: { ko: `${noteTxt || (rec ? '사다리 4주째·8주째는 회복주 — 고강도 없음' : '이번 주는 고강도 없음')} · 0–5분 ${wu ? `${wu.lo}–${wu.hi}` : '–'} km/h → 본 구간${bandTxt} → 마지막 3분 걷기 5.5 · 심박 10분부터 ${steady ? `${steady.hrLo}–${steady.hrHi}` : '–'}, 30초 넘으면 −0.3 · 스트라이드 없음`, en: `${noteTxt || (rec ? 'ladder weeks 4 and 8 are recovery weeks — no hard session' : 'no hard session this week')} · 0–5 min at ${wu ? `${wu.lo}–${wu.hi}` : '–'} km/h → main part${bandTxt} → last 3 min walk 5.5 · HR ${steady ? `${steady.hrLo}–${steady.hrHi}` : '–'} from minute 10, 30 s above → −0.3 · no strides` } };
  else tue = { day: 2, type: 'lt2', ko: `LT2 사다리 ${st.label.split(' / ')[0]}`, en: `LT2 ladder ${st.label.split(' / ')[1]}`, minutes: Math.round((st.warmupSec + st.reps * st.workSec + (st.reps - 1) * st.restSec + st.cooldownSec) / 60), hr: T2, structure: st, speed: lt2Sp, note: { ko: `워밍업 10분 = 4분 ${wu ? wu.hi : '–'} → 3분 ${lt1Speed != null ? f1(lt1Speed - 0.2) : '–'} → 3분 ${lt2Sp != null ? f1(lt2Sp - 1.0) : '–'} km/h → 구간 ${st.reps}×${st.workSec / 60}분 @ ${lt2Sp != null ? f1(lt2Sp) : '–'} km/h(MLSS 속도), 심박 ${T2 ? `${T2.hrLo}–${T2.hrHi}` : '–'} · 구간 4분 이후 천장 ${T2 ? T2.hrHi : '–'}을 60초 넘으면 다음 구간 −0.3 · 회복 ${st.restSec / 60}분 조깅 ${lt1Speed != null ? `${f1(lt1Speed - 2.2)}–${f1(lt1Speed - 1.7)}` : '–'} km/h, 끝에 심박 < ${steady ? steady.hrHi : '–'}가 아니면 다음 구간 −0.3 · 쿨다운 6분 = 3분 ${wu ? wu.lo : '–'} → 3분 걷기 5.5 · 사다리 2·6주째에 마지막 구간 뒤 채혈: 3.0–4.5 적정, < 3.0 → +0.3, > 4.5 → −0.3, 1구간→마지막 상승 > 1.0 → −0.3`, en: `warm-up 10 min = 4 min at ${wu ? wu.hi : '–'} → 3 min at ${lt1Speed != null ? f1(lt1Speed - 0.2) : '–'} → 3 min at ${lt2Sp != null ? f1(lt2Sp - 1.0) : '–'} km/h → reps ${st.reps} × ${st.workSec / 60} min at ${lt2Sp != null ? f1(lt2Sp) : '–'} km/h (MLSS speed), HR ${T2 ? `${T2.hrLo}–${T2.hrHi}` : '–'} · from minute 4 of a rep, 60 s above ${T2 ? T2.hrHi : '–'} → next rep −0.3 · recovery ${st.restSec / 60} min jog at ${lt1Speed != null ? `${f1(lt1Speed - 2.2)}–${f1(lt1Speed - 1.7)}` : '–'} km/h, HR not under ${steady ? steady.hrHi : '–'} at its end → next rep −0.3 · cool-down 6 min = 3 min at ${wu ? wu.lo : '–'} → 3 min walk at 5.5 · ladder weeks 2 and 6: a sample after the last rep — 3.0–4.5 on target, < 3.0 → +0.3, > 4.5 → −0.3, rise rep 1 → last > 1.0 → −0.3` } };
  const thu = K.includes('blood')
    ? { day: 4, type: 'rest', ko: '달리기 0분 — 혈액검사 아침', en: 'No run (0 min) — blood-test morning', minutes: 0, hr: null, note: { ko: `전날 22:00부터 금식(물 가능) · 공복 채혈 뒤 아침 식사 · 이번 주 LT1 검증은 건너뛰고 다음 주 목요일에 같은 속도로`, en: `fasting from 22:00 the night before (water allowed) · breakfast after the draw · this week's LT1 check is skipped — next Thursday at the same speed` } }
    : { day: 4, type: 'verify', ko: `LT1 검증 달리기 (두 랩${vs != null ? `, ${vs.toFixed(1)} km/h` : ''})`, en: `LT1 verification run (two laps${vs != null ? `, ${vs.toFixed(1)} km/h` : ''})`, minutes: 45, hr: steady, speed: vs, note: { ko: `공복 · 같은 시각 ± 30분 · 워밍업 5분 = 0:30 걷기 5.5 → 4:30 ${wu ? `${wu.lo}–${wu.hi}` : '–'} km/h(5분에 심박 < ${z1Top ?? '–'}) → 랩 1 10분 @ 검사 속도 → 간격 60–90초(서서, 정지 30–45초 뒤 채혈, 상한 3분) → 랩 2 30분 → 종료 채혈 → 걷기 5분 5.5 · 스트립 2개(판정선 ± 0.2 안이면 3개) · ${GATE.ko} 쉬운 런 45분으로 바꾸고 다음 목요일 같은 속도`, en: `fasted · same clock time ± 30 min · warm-up 5 min = 0:30 walk at 5.5 → 4:30 at ${wu ? `${wu.lo}–${wu.hi}` : '–'} km/h (HR < ${z1Top ?? '–'} at 5:00) → lap 1 10 min at the test speed → gap 60–90 s (stand still, sample 30–45 s after the stop, cap 3 min) → lap 2 30 min → end sample → 5 min walk at 5.5 · 2 strips (a 3rd within ± 0.2 of the line) · ${GATE.en} run an easy 45 and repeat next Thursday at the same speed` } };
  const sat = K.includes('step')
    ? { day: 6, type: 'test', ko: '계단 테스트 (젖산)', en: 'Step test (lactate)', minutes: 60, hr: null, note: { ko: `롱런 대신 · 공복, 카페인 없음(전날 14:00부터) · 워밍업 5분 걷기 5.5 → 설정 → 프로토콜대로 3분 단계(시작 6.0, +1.0 km/h, 경사 1 %) + 30초 채혈 정지 · 종료 = 젖산 ≥ 6.0 또는 RPE ≥ 17 · LT1 양옆 두 단계는 2회 채혈(차이 > 0.3이면 3회) · 끝나면 결과 적용(역치·검증 상한)`, en: `instead of the long run · fasted, no caffeine since 14:00 the day before · 5-min walk at 5.5 → stages per Settings → Protocol: 3 min, start 6.0, +1.0 km/h, 1 % incline, 30-s sampling pauses · stop at lactate ≥ 6.0 or RPE ≥ 17 · the two stages around LT1 sampled twice (a 3rd if they differ by > 0.3) · apply the result after (thresholds, test-speed cap)` } }
    : { day: 6, type: 'long', ko: `롱런 ${longMin}분`, en: `Long run ${longMin} min`, minutes: longMin, hr: steady, speed: lt1Speed != null ? [Math.round((lt1Speed - 1.2) * 10) / 10, Math.round((lt1Speed - 1.2) * 10) / 10] : null, note: { ko: `공복 · 0–5분 ${wu ? wu.lo : '–'} → 본 구간 ${lt1Speed != null ? f1(lt1Speed - 1.2) : '–'} km/h → 마지막 5분 걷기 5.5 · 심박 0–60분 ≤ ${steady ? steady.hrHi : '–'}, 60분 이후 ≤ ${lt1Hr != null ? lt1Hr + 2 : '–'} — 60초 넘으면 −0.3 km/h · 30:00에 중간 채혈(정지 ≤ 45초, 30–45초 뒤) + 종료 채혈(두 손가락, 쿨다운 전) · 15분마다 물 125–190 mL(500–750 mL/h) · 30분부터 30분마다 덱스트로스 15–30 g(30–60 g/h) · 실내 ≥ 20 °C면 선풍기 · 판정: 중간 ≤ 최저 + 0.5 이고 종료 ≤ 중간 + 1.0 → 통과, 종료 > 중간 + 1.0 → 다음 롱런 −0.3${longCap ? ` · 상한 = 30일 최장 ${longCap.longestMin}분 × 1.1` : ''}${rec ? ' · 회복주 × 0.7' : ''}`, en: `fasted · 0–5 min at ${wu ? wu.lo : '–'} → main part at ${lt1Speed != null ? f1(lt1Speed - 1.2) : '–'} km/h → last 5 min walk at 5.5 · HR ≤ ${steady ? steady.hrHi : '–'} for 0–60 min, ≤ ${lt1Hr != null ? lt1Hr + 2 : '–'} after — 60 s above → −0.3 km/h · mid sample at 30:00 (stop ≤ 45 s, sample 30–45 s after) + end sample (two fingers, before the cool-down) · 125–190 mL water every 15 min (500–750 mL/h) · dextrose 15–30 g every 30 min from minute 30 (30–60 g/h) · fan when the room is ≥ 20 °C · verdict: mid ≤ lowest + 0.5 and end ≤ mid + 1.0 → pass; end > mid + 1.0 → next long run −0.3${longCap ? ` · cap = 110 % of the 30-day longest (${longCap.longestMin} min)` : ''}${rec ? ' · recovery week × 0.7' : ''}` } };
  const days = [
    { ...easyDay(1, easyMin, '', '', true), evening: { ko: `11:30 점심 홈 세션 25분 — 가동성 5분(발목 무릎-벽 10회/측 · 90/90 5회/측 · 흉추 오픈북 5회/측) · 발 코어 10분(아치 들어올리기 5초×10 · 토 요가 10회 · 발가락 벌리기 3초×10 · 수건 끌기 1분 · 한발 서기 30초×2/측) · 코어 10분(데드버그 3×8/측 · 사이드 플랭크 2×30초/측 · 버드독 2×8/측 · 할로우 2×20초), 12:00 전 종료 → 점심 · 17:30 추가 20분(야근 없을 때): 포고 홉 10회(2주마다 +10, 최대 40) · 월 싯 2분×4(사이 2분) · ${EVE_GATE.ko}`, en: `11:30 noon home session 25 min — mobility 5 min (knee-to-wall 10/side · 90/90 5/side · open book 5/side) · foot core 10 min (short foot 5 s × 10 · toe yoga × 10 · toe spread 3 s × 10 · towel curl 1 min · single-leg stand 30 s × 2/side) · core 10 min (dead bug 3 × 8/side · side plank 2 × 30 s/side · bird dog 2 × 8/side · hollow 2 × 20 s), done before 12:00 → lunch · 17:30 extra 20 min (no overtime): pogo hops × 10 (+10 every 2 weeks, max 40) · wall-sit 2 min × 4 (2 min between) · ${EVE_GATE.en}` } },
    { ...tue, evening: { ko: `근력 A 30분 — ${strengthNote.ko} · ${accessoryNote.ko}`, en: `strength A 30 min — ${strengthNote.en} · ${accessoryNote.en}` } },
    { ...easyDay(3, easyMin), evening: { ko: `11:30 점심 걷기 30분 — 5.5–6.0 km/h(10–11분/km), 심박 < 115, 12:00 전 종료 → 점심 · 17:30 추가 30분(야근 없을 때): 경사 걷기 8–12 %, 4.5–5.5 km/h, 심박 ≤ ${steady ? steady.hrLo : '–'}(넘으면 경사 −2 %) · ${EVE_GATE.ko}`, en: `11:30 noon walk 30 min — 5.5–6.0 km/h (10–11 min/km), HR < 115, done before 12:00 → lunch · 17:30 extra 30 min (no overtime): incline walk 8–12 %, 4.5–5.5 km/h, HR ≤ ${steady ? steady.hrLo : '–'} (over it → incline −2 %) · ${EVE_GATE.en}` } },
    { ...thu, evening: { ko: `근력 B 30분 — ${strengthNote.ko} · ${accessoryNote.ko}`, en: `strength B 30 min — ${strengthNote.en} · ${accessoryNote.en}` } },
    { ...easyDay(5, 30, ' (선택) 또는 휴식', ' (optional) or rest', true), optional: true, gate: GATE, evening: { ko: `11:30 점심 폼롤링·카프 홀드·가동성 20분 — 폼롤링 5분(종아리·허벅지 앞·엉덩이 각 60초/측) · 카프 홀드 5×45초(사이 30초) · 가동성 5분, 12:00 전 종료 → 점심 · 17:30 추가 25분(야근 없을 때): 발 코어 10분 · 월 싯 2분×4(사이 2분) · ${EVE_GATE.ko}`, en: `11:30 noon foam roll, calf holds, mobility 20 min — foam roll 5 min (calves, quads, glutes 60 s each side) · calf holds 5 × 45 s (30 s between) · mobility 5 min, done before 12:00 → lunch · 17:30 extra 25 min (no overtime): foot core 10 min · wall-sit 2 min × 4 (2 min between) · ${EVE_GATE.en}` } },
    { ...sat, evening: { ko: '점심·저녁 운동 0분', en: 'noon and evening: no exercise (0 min)' } },
    { ...easyDay(0, Math.min(50, Math.max(30, r5(weekendMin * 0.5)))), evening: { ko: `16:30 경사 걷기 30분 (선택) — 경사 8–12 %, 4.5–5.5 km/h, 심박 ≤ ${steady ? steady.hrLo : '–'}(넘으면 경사 −2 %) · ${GATE.ko} 쉼`, en: `16:30 incline walk 30 min (optional) — incline 8–12 %, 4.5–5.5 km/h, HR ≤ ${steady ? steady.hrLo : '–'} (over it → incline −2 %) · ${GATE.en} rest` } },
  ];
  if (days[4].note) { days[4].note = { ko: `${GATE.ko} 휴식 · ${days[4].note.ko}`, en: `${GATE.en} rest · ${days[4].note.en}` }; }
  const total = days.reduce((s, d) => s + d.minutes, 0); const hard = days.filter(d => d.type === 'lt2' || d.type === 'tempo' || d.purpose === 'mlss').reduce((s, d) => s + d.minutes * 0.55, 0);
  return { week, blockWeek, longWeek, recovery: rec, light: lightWeek, kinds: K.slice(), notes: (notes || []).slice(), days, totalMin: total, hardPct: total ? Math.round(100 * hard / total) : 0, longCap, speeds: T1 ? { lt1: [T1.speedLo, T1.speedHi], lt2: T2 ? [T2.speedLo, T2.speedHi] : null } : null };
}

/** Why the week looks like this (the Oct 10 review, in the Plan tab). */
export const PLAN_WHY = [
  { ko: '원칙: 분량을 늘리는 대신 각 분을 가장 효과적인 자리에. 대부분의 날은 LT1 아래, 주 1회는 정확히 LT2에서, 주 1회는 지구력용 롱런.', en: 'Principle: put each minute where it does the most, not more minutes — most days below LT1, one session exactly at LT2, one long run for durability.' },
  { ko: '볼륨 주 약 6시간: 쉬운 런 30–50분 ×5, 검증 45분, 롱런 70–100분. 40–60분이면 LT1 적응(미토콘드리아·지방 이용·모세혈관)에 충분하고 피로 없이 반복됨. 롱런은 매주 +10분, 최근 30일 최장 × 1.1 상한(초과 시 부상 위험 1.64배, Frandsen 2025).', en: 'Volume ≈ 6 h/week: easy runs 30–50 min ×5, the 45-min check, a long run of 70–100 min. 40–60 min is enough for the LT1 adaptations (mitochondria, fat use, capillaries) and repeats without fatigue. The long run grows +10 min a week under a cap of 110 % of the 30-day longest (hazard 1.64× above it, Frandsen 2025).' },
  { ko: '강도 분포: 약 85 % LT1 아래, 주 1회 LT2/MLSS, 그 위는 없음(지구력 선수 84–95 % 첫 역치 아래, 고강도 주 2회 정도 — Stöggl & Sperlich 2015). 고강도를 MLSS 속도에 두는 이유: 정상상태를 유지하는 최고 강도(Wackerhage 2022)라 자극은 최대, 회복 비용은 최소. 사다리는 속도가 아니라 구간 길이로 그 속도에서의 시간을 쌓음.', en: 'Intensity: ≈ 85 % below LT1, one LT2/MLSS session a week, nothing above (endurance athletes: 84–95 % below the first threshold, about two hard sessions a week — Stöggl & Sperlich 2015). The hard session sits at MLSS speed because it is the highest intensity that still holds a steady state (Wackerhage 2022): full stimulus, least recovery cost. The ladder lengthens the reps, not the speed.' },
  { ko: '용량 = 속도, 심박 = 천장: 트레드밀에서 속도는 정확하고 심박은 달리는 중 올라가며(10/9–10: 젖산 1.0 그대로, +6~9 bpm) 날마다 움직임. 그래서 범위는 속도로, 심박은 상한(LT1, 20분 뒤 LT1 + 5)으로만. 범위가 아직 LT1 아래임을 증명하는 것이 매주 목요일 두 랩 검증.', en: 'Dose = speed, heart rate = ceiling: on a treadmill speed is exact, heart rate drifts within a run (Oct 9–10: +6 to +9 bpm with lactate flat at 1.0) and moves day to day. So the band is a speed, heart rate only caps it (LT1, LT1 + 5 after 20 min), and Thursday’s two-lap check proves the band is still below LT1.' },
  { ko: '요일: 화 고강도는 월 쉬운 날 뒤라 신선하고 목까지 48시간(고강도 뒤 부교감 회복, Stanley 2013) · 목 검증은 고강도 48시간 뒤, 롱런 이틀 전, 매주 같은 시각·공복이라 값이 비교됨 · 토 롱런은 시간이 있는 날, 일 쉬운 런은 능동 회복 · 월·수 쉬운 런과 수 걷기는 고강도 사이의 완충.', en: 'Days: Tuesday hard comes after an easy Monday and leaves 48 h before Thursday (parasympathetic recovery after hard work, Stanley 2013) · the Thursday check is 48 h after the hard day, two days before the long run, same time and fasted every week so the values compare · Saturday has the time, Sunday is active recovery · Monday/Wednesday easy and the Wednesday walk buffer the hard days.' },
  { ko: '근력을 화·목 저녁에: 힘든 날은 힘들게, 쉬운 날은 쉽게 — 두 세션은 48시간 간격, 아침 달리기와 10시간 이상 떨어져 간섭이 적음. A(힌지·런지·벤치·로우·카프·사이드 플랭크)와 B(스쿼트·RDL·당기기·프레스·앉은 카프·노르딕·코펜하겐)로 패턴을 주 2회, 부상 예방 근육(종아리·햄스트링·내전근) 포함. 월·금 홈 세션은 가벼운 날의 저부하 부상 예방.', en: 'Strength on Tuesday and Thursday evenings keeps hard days hard and easy days easy — 48 h apart, ≥ 10 h after the morning run. A (hinge, lunge, bench, row, calf, side plank) and B (squat, RDL, pull, press, seated calf, Nordic, Copenhagen) cover every pattern twice a week with the injury-prevention muscles (calf, hamstring, adductor). Monday/Friday home sessions are low-load prevention on the light days.' },
  { ko: '아침 05:30 공복, 저녁 17:30: LT1 강도의 공복 달리기는 문제없고, 고정된 시각·상태가 젖산 검증을 깨끗하게 하며, 롱런 중 탄수(30–60 g/h)가 후반 드리프트가 연료 문제가 되는 것을 막음.', en: 'Mornings fasted at 05:30, the rest at 17:30: fasted running is fine at LT1 intensity, a fixed time and state keeps the lactate checks clean, and carbohydrate during the long run (30–60 g/h) stops late drift from being a fuel problem.' },
];

/** Per-session metrics used by insights and summaries. */
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
  const now = Date.now(); const recent = sessions.filter(s => s.type === 'lt1' && s.final && s.sourceKind !== 'demo' && now - s.startedAt < 14 * 86400000); // practice runs on the virtual strap never adjust real targets
  const notes = []; let lt1Adjust = 0; let holdDuration = false;
  const restAt = opts.restLactateAt != null ? new Date(opts.restLactateAt).getTime() : NaN; const restDays = Number.isFinite(restAt) ? Math.floor((now - restAt) / 86400000) : null;
  if (REST_BASELINE != null && (restDays == null || restDays >= 30)) notes.push({ kind: 'rest', ko: restDays == null ? `안정 시 젖산 기준값 ${REST_BASELINE}의 측정일이 없습니다 — 설정 → 프로필에 적어 두고, 매달 같은 조건(아침 공복, 채혈 규칙)으로 다시 재세요.` : `안정 시 젖산 기준값 ${REST_BASELINE} 측정 후 ${restDays}일 → 같은 조건(아침 공복, 채혈 규칙)으로 다시 재고 설정에 적으세요. 검증 달리기 날에는 안정 시 채혈이 필요 없습니다.`, en: restDays == null ? `No date for the resting-lactate baseline ${REST_BASELINE} — enter it in Settings → Profile and re-measure monthly under the same conditions (fasted, by the sampling rules).` : `${restDays} days since the resting-lactate baseline ${REST_BASELINE} was measured → re-measure it under the same conditions (fasted, by the sampling rules) and enter it in Settings. A check day needs no resting sample.` });
  const m = recent.map(sessionMetrics).filter(x => Number.isFinite(x.meanAlpha1));
  if (m.length >= 2) {
    const ma = mean(m.map(x => x.meanAlpha1));
    if (!alphaOn()) { /* α1 switched off: no target change from it */ }
    else if (ma < 0.70) { lt1Adjust = -3; notes.push({ ko: `최근 LT1 세션 평균 α1 ${ma.toFixed(2)} < 0.70 → 목표 심박 −3 bpm`, en: `Recent LT1 sessions average α1 ${ma.toFixed(2)} < 0.70 → target HR −3 bpm`, kind: 'adjust' }); }
    else if (ma > 1.0 && mean(m.map(x => x.timeInZonePct).filter(isFinite)) > 80) { lt1Adjust = +2; notes.push({ ko: `α1 평균 ${ma.toFixed(2)}로 여유 있음 → 목표 심박 +2 bpm 허용`, en: `Comfortable α1 (${ma.toFixed(2)}) → allow target HR +2 bpm`, kind: 'adjust' }); }
    const drifts = m.map(x => x.driftPct).filter(isFinite);
    if (drifts.filter(d => d > 5).length >= 2) { holdDuration = true; notes.push({ ko: '심박 드리프트 >5%가 2회 이상 → 이번 주 지속시간 동결', en: 'HR drift >5% in ≥2 sessions → hold duration this week', kind: 'hold' }); }
    const art = mean(m.map(x => x.artifactPct).filter(isFinite));
    if (art > 5) notes.push({ ko: `아티팩트 평균 ${art.toFixed(1)}% → 스트랩 전극을 적시고 위치를 확인하세요`, en: `Average artifacts ${art.toFixed(1)}% → wet the electrodes and check strap position`, kind: 'quality' });
  } else notes.push({ ko: 'LT1 세션이 2회 이상 쌓이면 자동 조정이 시작됩니다.', en: 'Auto-adjustment starts after two or more LT1 sessions.', kind: 'info' });
  const weeks = lastTestAt ? (now - lastTestAt) / (7 * 86400000) : null;
  const retest = weeks == null || weeks >= 8;
  if (weeks != null && weeks >= 8) notes.push({ ko: `마지막 테스트 후 ${Math.floor(weeks)}주 → 재검사 권장`, en: `${Math.floor(weeks)} weeks since last test → retest recommended`, kind: 'retest' });
  if (weeks == null) notes.push({ ko: '아직 테스트가 없습니다. 첫 단계 테스트로 역치를 만드세요.', en: 'No test yet — run a first step test to set thresholds.', kind: 'retest' });
  return { lt1Adjust, holdDuration, notes, retest, weeksSinceTest: weeks, sessionsConsidered: m.length };
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
    ko.push(`${tyKo} 세션 ${d}분, 평균 심박 ${Math.round(metrics.meanHr)} bpm.`); en.push(`${tyEn} session ${d} min, mean HR ${Math.round(metrics.meanHr)} bpm.`);
    if (Number.isFinite(metrics.timeInZonePct)) { ko.push(`존 체류 ${Math.round(metrics.timeInZonePct)}%.`); en.push(`Time in zone ${Math.round(metrics.timeInZonePct)}%.`); }
    if (alphaOn() && Number.isFinite(metrics.meanAlpha1)) {
      ko.push(`평균 α1 ${metrics.meanAlpha1.toFixed(2)} (0.75 이상 ${Math.round(metrics.pctAlphaAbove75)}%).`); en.push(`Mean α1 ${metrics.meanAlpha1.toFixed(2)} (≥0.75 for ${Math.round(metrics.pctAlphaAbove75)}%).`);
      if (session.type === 'lt1') { if (metrics.meanAlpha1 < 0.70) { ko.push('→ LT1보다 높은 강도였습니다. 다음 세션은 3 bpm 낮추세요.'); en.push('→ Harder than LT1; go 3 bpm lower next time.'); } else if (metrics.meanAlpha1 >= 0.75) { ko.push('→ 유산소 역치 아래에서 잘 유지했습니다.'); en.push('→ Stayed below the aerobic threshold.'); } }
    }
    if (Number.isFinite(metrics.driftPct)) { ko.push(`심박 드리프트 ${metrics.driftPct >= 0 ? '+' : ''}${metrics.driftPct.toFixed(1)}%${metrics.driftPct > 5 ? ' (높음 — 수분·지속시간 점검)' : ''}.`); en.push(`HR drift ${metrics.driftPct >= 0 ? '+' : ''}${metrics.driftPct.toFixed(1)}%${metrics.driftPct > 5 ? ' (high — check hydration/duration)' : ''}.`); }
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
  if (zones) L.push(`Thresholds: LT1 ${Math.round(zones.lt1Hr)} bpm @ ${zones.lt1Speed ?? '?'} km/h; LT2 ${Math.round(zones.lt2Hr)} bpm @ ${zones.lt2Speed ?? '?'} km/h${zones.grade ? ` (grade ${zones.grade})` : ''}${zones.updatedAt ? `, set ${new Date(zones.updatedAt).toISOString().slice(0, 10)}` : ''}`);
  if (session) {
    L.push(`Session: ${session.type}, ${new Date(session.startedAt).toLocaleString()}, ${Math.round((metrics?.durationSec || 0) / 60)} min, source ${session.sourceKind}`);
    if (metrics) L.push(`Metrics: mean HR ${Number.isFinite(metrics.meanHr) ? Math.round(metrics.meanHr) : 'n/a'}, max HR ${Number.isFinite(metrics.maxHr) ? metrics.maxHr : 'n/a'}, mean α1 ${Number.isFinite(metrics.meanAlpha1) ? metrics.meanAlpha1.toFixed(2) : 'n/a'}, min α1 ${Number.isFinite(metrics.minAlpha1) ? metrics.minAlpha1.toFixed(2) : 'n/a'}, α1≥0.75 ${Number.isFinite(metrics.pctAlphaAbove75) ? Math.round(metrics.pctAlphaAbove75) + '%' : 'n/a'}, HR drift ${Number.isFinite(metrics.driftPct) ? metrics.driftPct.toFixed(1) + '%' : 'n/a'}, artifacts ${Number.isFinite(metrics.artifactPct) ? metrics.artifactPct.toFixed(1) + '%' : 'n/a'}, time in zone ${Number.isFinite(metrics.timeInZonePct) ? Math.round(metrics.timeInZonePct) + '%' : 'n/a'}`);
    if (session.type !== 'test') {
      const c = lactateChecks(session); const v = lactateVerdict(session); const ew = endWindowStats(session, 300); const px = endOnlyProxy(session);
      const mmss = sec => { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
      // Where the running ended and how that was found: everything "last 5 min" below is measured from there (see runTimeline).
      const endTxt = `run ended at ${mmss((ew.endT - session.startedAt) / 1000)} (found by: ${RUN_END_HOW[ew.how] || ew.how}${ew.tailSec >= 20 ? `; the recording went on for ${mmss(ew.tailSec)}` : ''})${ew.sure ? '' : ' — UNCERTAIN: the last-5-min figures are estimates'}`;
      const durTxt = ew.bouts === 1 ? `running time ${px.durMin.toFixed(1)} min` : ew.bouts === 0 ? 'ended in the warm-up' : `interval session — last rep ${px.durMin.toFixed(1)} min`;
      L.push(`Constant load (${session.purpose || 'auto'}): speed ${session.speed ?? '?'} km/h, incline ${session.incline ?? '?'} %; ${durTxt}; ${endTxt}; HR drift min 8-13 → last 5 ${Number.isFinite(px.driftBpm) ? (px.driftBpm >= 0 ? '+' : '') + px.driftBpm.toFixed(1) + ' bpm' : 'n/a'}; RPE end ${px.rpeEnd ?? 'n/a'}; last-5-min HR ${Number.isFinite(ew.hr) ? Math.round(ew.hr) : 'n/a'}, α1 ${Number.isFinite(ew.alpha1) ? ew.alpha1.toFixed(2) : 'n/a'}; lactate rest ${c.rest ?? 'n/a'}, ${midLabel(c).en} ${c.mid ?? 'n/a'}, end ${c.end ?? 'n/a'}${v ? `; verdict: ${v.en}` : ''}`);
      const ls = lapStats(session); const fl = lactateFloor();
      if (ls) L.push(`Two-lap LT1 check: lap 1 ${ls.lap1Min.toFixed(1)} min (HR min 5-10 ${Number.isFinite(ls.lap1Hr) ? Math.round(ls.lap1Hr) : 'n/a'} bpm) → gap ${Number.isFinite(ls.gapSec) ? Math.round(ls.gapSec) + ' s' : 'n/a'}${Number.isFinite(ls.gapSec) && ls.gapSec > GAP_STRICT_SEC ? ' (STRICT rule: > 3 min)' : ''} → lap 2 ${ls.lap2Min.toFixed(1)} min (HR min 1-6 ${Number.isFinite(ls.lap2Early) ? Math.round(ls.lap2Early) : 'n/a'} → last 5 ${Number.isFinite(ls.lap2Late) ? Math.round(ls.lap2Late) : 'n/a'}, drift ${Number.isFinite(ls.lap2Drift) ? (ls.lap2Drift >= 0 ? '+' : '') + ls.lap2Drift.toFixed(1) + ' bpm' : 'n/a'}); line = ${fl ? `${fl.lowest} (${fl.from}) + 0.5 = ${r1(fl.lowest + LINE_DELTA)}` : 'n/a'}; samples: ${list(session.events).filter(e => e.type === 'lactate' && Number.isFinite(e.value)).map(e => `${e.value} (lap ${e.lap ?? '?'}, ${e.runSec != null ? Math.round(e.runSec / 60) + ' min at speed' : '?'}${e.sinceStopSec != null ? `, ${e.sinceStopSec} s after the stop` : ''})`).join('; ') || 'none logged'}`);
      const ss = smo2Steady(session);
      if (ss) L.push(`SmO2 (constant load): 5-10 min ${Number.isFinite(ss.earlyMean) ? ss.earlyMean.toFixed(1) : 'n/a'} %, last 5 min ${Number.isFinite(ss.endMean) ? ss.endMean.toFixed(1) : 'n/a'} % (drift ${Number.isFinite(ss.drift) ? (ss.drift > 0 ? '+' : '') + ss.drift.toFixed(1) : 'n/a'})${ew.sure ? '' : ' [end of the run UNCERTAIN: window estimated]'}, min ${Number.isFinite(ss.min) ? ss.min.toFixed(1) : 'n/a'} %, end slope ${Number.isFinite(ss.slopeEnd) ? ss.slopeEnd.toFixed(2) : 'n/a'} %/min → ${ss.steady == null ? 'n/a' : ss.steady ? 'steady' : 'NOT steady'}; THb mean ${Number.isFinite(ss.thbMean) ? ss.thbMean.toFixed(1) : 'n/a'} (contact ${ss.contact ?? 'n/a'}); coverage ${Math.round(ss.coverageSec / 60)} min; offset ${Math.round((session.smo2.offsetMs || 0) / 1000)} s${session.smo2.alignment ? ` (${session.smo2.alignment.method === 'manual' ? 'manual' : session.smo2.alignment.ok ? `HR-verified, ${session.smo2.alignment.mad.toFixed(2)} bpm` : `UNVERIFIED, HR mismatch ${session.smo2.alignment.mad.toFixed(1)} bpm`})` : ' (clock only)'}`);
    }
    if (session.stages?.length) { L.push('Stages (speed km/h | incline % | HR | α1 | lactate | RPE | SmO2):'); for (const r of (analysis?.rows || session.stages)) L.push(`  ${r.speed} | ${r.incline} | ${Number.isFinite(r.hr) ? Math.round(r.hr) : '-'} | ${Number.isFinite(r.alpha1) ? r.alpha1.toFixed(2) : '-'} | ${r.lactate ?? '-'} | ${r.rpe ?? '-'} | ${Number.isFinite(r.smo2) ? r.smo2.toFixed(1) : '-'}`); }
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
 * steadiness, last RPE. A stop for a sample is left out of the running time and skipped over by both windows. single = false for interval
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
  const ss = smo2Steady(session); const rpe = list(session.events).filter(e => e.type === 'rpe' && Number.isFinite(e.value)); const rpeEnd = rpe.length ? rpe[rpe.length - 1].value : null;
  return { durMin, driftBpm, smo2Steady: ss ? ss.steady : null, rpeEnd, single, sure: tl.sure, how: tl.how };
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
 *   pass       lap 1 ≤ line and rise (lap 1 → end) ≤ 0.5 (≤ 0.3 when the gap exceeded 3 min: lactate clears while standing) → next week +0.2 km/h
 *   borderline rise 0.5–1.0, or lap 1 within 0.2 of the line → same speed next week (target HR −2)
 *   fail       lap 1 > line, rise > 1.0 or end > 2.5 → next week −0.3 km/h (target HR −4)
 * durability: the level passed (lap 1 ≤ line) but the 30 min did not hold (rise > 0.5, or lap-2 drift > 8 bpm) — a duration problem, not a speed one.
 * No zone change follows from one run: the band finder moves the band after two consecutive results (bandFinder).
 */
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
  return { ...base, level: 'ok', adjust: null, next: +0.2, rise, durability, ko: `통과${spTxt}: ${lapTxt} — 랩 1 ≤ 기준선 ${line}, 상승 ≤ ${passRise}. 기준선 ${lineKo}. 다음 주 검사 속도 +0.2 km/h(계단 검사 LT1 + 0.3까지).${strictKo}`, en: `Pass${spTxt}: ${lapEn} — lap 1 ≤ line ${line}, rise ≤ ${passRise}. Line ${lineEn}. Next week's test speed +0.2 km/h (up to the step-test LT1 + 0.3).${strictEn}` };
}
/**
 * The weekly band finder (v1.1.17): from the two-lap runs (newest last) the next test speed — pass +0.2 (up to the step-test LT1 speed
 * + 0.3), borderline the same, fail −0.3 — and, after two consecutive results of the same kind, the band change: two passes raise the
 * LT1 floor to the passed speed and lap-1 heart rate; two fails lower the cap to speed −0.3 / heart rate −4; borderline changes nothing.
 * → { nextSpeed, step, from: 'result' | 'zones', last: { date, speed, level }, streak: { level, n } | null, change: { zones, keys, ko, en } | null, ko, en }
 */
export function bandFinder(sessions, zones, { days = 70, now = Date.now() } = {}) {
  const z = zones || {}; const zSpeed = Number.isFinite(z.lt1Speed) ? z.lt1Speed : null;
  const runs = (sessions || []).filter(s => s && s.type === 'verify' && s.final && s.sourceKind !== 'demo' && (s.purpose || 'lt1') === 'lt1' && Number.isFinite(s.speed) && now - s.startedAt <= days * 86400000).sort((a, b) => a.startedAt - b.startedAt);
  const results = []; for (const s of runs) { const vd = lactateVerdict(s); if (vd && vd.twoLap && vd.lap1 != null) results.push({ s, vd }); }
  if (!results.length) return { nextSpeed: zSpeed, step: 0, from: 'zones', last: null, streak: null, change: null, results, ko: zSpeed != null ? `아직 두 랩 검증 결과가 없습니다 — 이번 주 검사 속도는 현재 LT1 속도 ${zSpeed.toFixed(1)} km/h.` : '아직 두 랩 검증 결과가 없습니다.', en: zSpeed != null ? `No two-lap result yet — this week's test speed is the current LT1 speed, ${zSpeed.toFixed(1)} km/h.` : 'No two-lap result yet.' };
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
  const ko = `최근 검증(${dTxt}, ${last.s.speed} km/h): ${lv[0]} → 이번 주 검사 속도 ${next.toFixed(1)} km/h (${stepTxt}${capped ? ', 계단 검사 LT1 + 0.3 상한' : ''}).` + (n >= 2 ? ` ${lv[0]} ${n}주 연속${change ? ` → 범위 변경 가능: ${change.ko}` : ' — 현재 존과 모순 없음'}.` : ' 범위는 두 주 연속 같은 결과일 때만 바뀝니다.');
  const en = `Latest check (${dTxt}, ${last.s.speed} km/h): ${lv[1]} → this week's test speed ${next.toFixed(1)} km/h (${stepTxt}${capped ? ', capped at the step-test LT1 + 0.3' : ''}).` + (n >= 2 ? ` ${lv[1]} ${n} weeks running${change ? ` → band change available: ${change.en}` : ' — consistent with the current zones'}.` : ' The band moves only after two consecutive results of the same kind.');
  return { nextSpeed: next, step, from: 'result', capped, last: { date: last.s.startedAt, speed: last.s.speed, level: last.vd.level, id: last.s.id }, streak, change, results, ko, en };
}
/**
 * Interval sessions (LT2 mode, more than one rep). The recoveries clear lactate, so the samples tell whether the reps were at the
 * intended intensity (3–4.5 mmol/L after the last rep, not climbing from rep to rep) — not where LT1 or MLSS lies. Neither the
 * 10→30-min rise rule nor the heart-rate proxy nor the LT1 limits apply, whatever purpose is chosen, and no zone change follows.
 */
function intervalVerdict(c, spTxt, delta) {
  const base = { adjust: null, intervals: true };
  const noteKo = ' (인터벌은 회복 구간이 있어 LT1·MLSS 판정과 존 변경에는 쓰지 않습니다 — 검증은 정속 달리기로.)', noteEn = ' (With recoveries between reps this locates neither LT1 nor MLSS and changes no zones — verify with a constant run.)';
  const dTxt = delta != null ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}` : '';
  if (delta != null && delta > 1.0) return { ...base, level: 'high', ko: `인터벌 중 젖산 상승 ${dTxt} mmol/L (${c.mid} → ${c.end})${spTxt} — 반복마다 쌓이는 강도입니다. 다음엔 0.3~0.5 km/h 낮추세요.${noteKo}`, en: `Lactate rose ${dTxt} mmol/L across the reps (${c.mid} → ${c.end})${spTxt} — the pace accumulates lactate. Next time 0.3–0.5 km/h slower.${noteEn}` };
  if (c.end >= 6) return { ...base, level: 'high', ko: `마지막 반복 후 젖산 ${c.end}${spTxt} — LT2 인터벌 목표(3–4.5)보다 높습니다. 다음엔 0.3~0.5 km/h 낮추세요.${noteKo}`, en: `Lactate ${c.end} after the last rep${spTxt} — above the LT2-interval target (3–4.5). Next time 0.3–0.5 km/h slower.${noteEn}` };
  if (c.end < 3) return { ...base, level: 'low', ko: `마지막 반복 후 젖산 ${c.end}${spTxt} — LT2 인터벌 목표(3–4.5) 아래. 마지막 구간 RPE ≤ 15(6–20 척도)였다면 다음엔 +0.3 km/h, 16 이상이면 유지.${noteKo}`, en: `Lactate ${c.end} after the last rep${spTxt} — below the LT2-interval target (3–4.5). Last-rep RPE ≤ 15 (6–20 scale) → +0.3 km/h next time; 16 or more → hold.${noteEn}` };
  if (c.end <= 4.5) return { ...base, level: 'ok', ko: `마지막 반복 후 젖산 ${c.end}${spTxt}${delta != null ? `, 반복 간 변화 ${dTxt}` : ''} — LT2 인터벌 목표 범위(3–4.5).${noteKo}`, en: `Lactate ${c.end} after the last rep${spTxt}${delta != null ? `, change across reps ${dTxt}` : ''} — on target for LT2 intervals (3–4.5).${noteEn}` };
  return { ...base, level: 'near', ko: `마지막 반복 후 젖산 ${c.end}${spTxt} — LT2 인터벌 목표(3–4.5)보다 높음. ${c.end <= 5.0 ? '다음엔 −0.2 km/h' : '다음엔 −0.3 km/h'}(4.5–5.0 → −0.2, 5.0–6.0 → −0.3).${noteKo}`, en: `Lactate ${c.end} after the last rep${spTxt} — above the LT2-interval target (3–4.5). ${c.end <= 5.0 ? 'Next time −0.2 km/h' : 'Next time −0.3 km/h'} (4.5–5.0 → −0.2, 5.0–6.0 → −0.3).${noteEn}` };
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
  if (tl && tl.twoLap && !isMlss) return twoLapVerdict(session, c, tl);
  if (bouts > 1) return intervalVerdict(c, spTxt, delta);
  if (isMlss) {
    if (delta != null) {
      // MLSS from the 10-min → end rise (v1.1.17): ≤ 0.5 → at/below MLSS, next +0.3 km/h — unless the belt stood for more than 3 min for
      // the sample (lactate clears while standing: the rise is understated — hold the speed); 0.5–1.0 → this speed IS the MLSS, hold it; > 1.0 → above.
      const gap = midStopSec(session, tl); const longGap = gap != null && gap > GAP_STRICT_SEC; const gapKo = gap != null ? ` (채혈 정지 ${Math.round(gap)}초)` : '', gapEn = gap != null ? ` (stop for the sample ${Math.round(gap)} s)` : '';
      if (delta <= 0.5 && c.end < 8) return longGap ? { level: 'ok', adjust: null, hold: true, longGap: true, ko: `MLSS 이하 확인${spTxt}: ${midLabel(c).ko}→종료 상승 ${delta.toFixed(1)} mmol/L (≤0.5)${gapKo} — 정지가 3분을 넘어 상승이 과소평가됐을 수 있습니다. 상향 없이 같은 속도로 재검.`, en: `At/below MLSS${spTxt}: ${midLabel(c).en}→end rise ${delta.toFixed(1)} mmol/L (≤0.5)${gapEn} — the stop exceeded 3 min, so the rise may be understated. No raise: repeat at this speed.` }
        : { level: 'ok', adjust: { lt2Speed: +0.3 }, ko: `MLSS 이하 확인${spTxt}: ${midLabel(c).ko}→종료 상승 ${delta.toFixed(1)} mmol/L (≤0.5)${gapKo}. 다음 검증은 +0.3 km/h.`, en: `At/below MLSS${spTxt}: ${midLabel(c).en}→end rise ${delta.toFixed(1)} mmol/L (≤0.5)${gapEn}. Next verification +0.3 km/h.` };
      if (delta <= 1.0 && c.end < 8) return { level: 'ok', adjust: null, hold: true, ko: `MLSS 확인${spTxt}: ${midLabel(c).ko}→종료 상승 ${delta.toFixed(1)} mmol/L (0.5–1.0)${gapKo} — 이 속도가 MLSS입니다. 속도 유지(상향 없음).`, en: `MLSS confirmed${spTxt}: ${midLabel(c).en}→end rise ${delta.toFixed(1)} mmol/L (0.5–1.0)${gapEn} — this speed is the MLSS. Hold it (no raise).` };
      return { level: 'high', adjust: { lt2Speed: -0.4 }, ko: `MLSS 초과${spTxt}: ${midLabel(c).ko}→종료 상승 ${delta.toFixed(1)} mmol/L (>1.0)${gapKo}. LT2 속도를 0.4 km/h 낮추세요.`, en: `Above MLSS${spTxt}: rise ${delta.toFixed(1)} mmol/L (>1.0)${gapEn}. Lower the LT2 speed by 0.4 km/h.` };
    }
    if (c.end >= 6) return { level: 'high', adjust: { lt2Speed: -0.4 }, ko: `종료 젖산 ${c.end} — LT2 위일 가능성${spTxt}. 10분 샘플을 추가하면 판정이 확실해집니다.`, en: `End lactate ${c.end} — likely above LT2${spTxt}. Add a 10-min sample next time for a firm call.` };
    if (c.end < 3) return { level: 'low', adjust: { lt2Speed: +0.3 }, ko: `종료 젖산 ${c.end} — LT2 아래${spTxt}. 다음엔 +0.3 km/h.`, en: `End lactate ${c.end} — below LT2${spTxt}. Try +0.3 km/h next time.` };
    // End-only MLSS proxy (solo use, no 10-min sample): must complete ≥ 25 min; HR drift (min 8–13 → last 5 min) ≤ 6 bpm and SmO2 steady → likely at/below MLSS; drift > 8 bpm, SmO2 still falling or RPE ≥ 18 → likely above.
    const px = endOnlyProxy(session);
    // Running time, drift and the SmO2 end slope all hang on where the run ended: without a known end, no proxy call.
    if (!px.sure) return { level: 'near', adjust: null, unsure: true, ko: `종료 젖산 ${c.end} — 달리기가 끝난 시점이 불확실해 심박·SmO₂ 대리 판정은 보류합니다${spTxt}. 위의 「달리기 종료」 칸에서 시각을 확정하거나, 다음엔 10분 샘플을 추가하세요.`, en: `End lactate ${c.end} — where the run ended is uncertain, so the heart-rate / SmO2 proxy call is withheld${spTxt}. Confirm the end of the run in the field above, or add a 10-min sample next time.` };
    if (px.durMin < 25) return { level: 'near', adjust: null, ko: `종료 젖산 ${c.end} — ${Math.round(px.durMin)}분만 달려 MLSS 판정 보류${spTxt}. 30분을 채우거나(힘들어 중단했다면 MLSS 위) 10분 샘플을 추가하세요.`, en: `End lactate ${c.end} — only ${Math.round(px.durMin)} min, MLSS call withheld${spTxt}. Complete 30 min (if you stopped from fatigue, treat as above MLSS) or add a 10-min sample.` };
    const dTxt = Number.isFinite(px.driftBpm) ? `${px.driftBpm >= 0 ? '+' : ''}${px.driftBpm.toFixed(0)} bpm` : 'n/a';
    const bad = []; if (Number.isFinite(px.driftBpm) && px.driftBpm > 8) bad.push(`심박 드리프트 ${dTxt}|HR drift ${dTxt}`); if (px.smo2Steady === false) bad.push('SmO₂ 계속 하락|SmO2 still falling'); if (px.rpeEnd != null && px.rpeEnd >= 18) bad.push(`RPE ${px.rpeEnd}|RPE ${px.rpeEnd}`);
    if (bad.length) return { level: 'high', adjust: { lt2Speed: -0.3 }, ko: `종료 젖산 ${c.end} + ${bad.map(b => b.split('|')[0]).join(', ')} — MLSS 초과 가능성(대리 지표)${spTxt}. 다음은 −0.3 km/h.`, en: `End lactate ${c.end} + ${bad.map(b => b.split('|')[1]).join(', ')} — likely above MLSS (proxy)${spTxt}. Next −0.3 km/h.` };
    if (Number.isFinite(px.driftBpm) && px.driftBpm <= 6) return { level: 'ok', adjust: { lt2Speed: +0.3 }, ko: `종료 젖산 ${c.end}, 심박 드리프트 ${dTxt} (8–13분 → 마지막 5분)${px.smo2Steady ? ', SmO₂ 안정' : ''} — MLSS 이하 가능성 높음(대리 지표)${spTxt}. 다음은 +0.3 km/h. 확정하려면 10분 샘플 또는 같은 속도 10분 단독 런.`, en: `End lactate ${c.end}, HR drift ${dTxt} (min 8–13 → last 5)${px.smo2Steady ? ', SmO2 steady' : ''} — likely at/below MLSS (proxy)${spTxt}. Next +0.3 km/h; to confirm, add a 10-min sample or a separate 10-min run at this speed.` };
    return { level: 'near', adjust: null, ko: `종료 젖산 ${c.end}, 심박 드리프트 ${dTxt} — MLSS 경계${spTxt}. 같은 속도로 재검하거나 10분 샘플을 추가하세요.`, en: `End lactate ${c.end}, HR drift ${dTxt} — borderline MLSS${spTxt}. Repeat at this speed or add a 10-min sample.` };
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
  if (!vd || vd.intervals || vd.longRun || vd.twoLap) return null; const z = zones || {}; const ew = endWindowStats(session, 300); const sp = session.speed; // (two-lap LT1 runs: the band finder, after two consecutive results)
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
  const span = points.length ? Math.max(...points.map(p => p.la)) - Math.min(...points.map(p => p.la)) : 0;
  const grade = points.length >= 5 && span >= 2 ? 'B' : points.length >= 3 ? 'C' : '-';
  return { points, analysis, grade, skipped };
}

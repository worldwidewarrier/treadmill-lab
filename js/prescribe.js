// Zones, weekly plan, progression, auto-adjustments, lactate verification runs and rule-based summaries (KO/EN).
import { analyzeLactate, interp } from './lactate.js';
import { list, smo2Steady, runTimeline, inStop, alphaTainted, runWindowStart, runWindowEnd, stoppedMs, alphaOn } from './analysis.js';
const r1 = v => Math.round(v * 10) / 10;
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
/** Resting lactate measured on its own (Settings): used by the LT1 verdict when a session has no rest value of its own. */
let REST_BASELINE = null;
/** Running time (min) above which a constant run is a long run: judged for durability, not for LT1 (see verdictCore, multiDayCurve). */
export const LONG_RUN_MIN = 45;
export function setRestBaseline(v) { REST_BASELINE = Number.isFinite(v) && v >= 0.3 && v <= 4 ? v : null; }
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
  if (type === 'lt1') return { hrLo: Math.round(lt1Hr - 10 + adj), hrHi: Math.round(lt1Hr - 3 + adj), speedLo: Number.isFinite(lt1Speed) ? r1(lt1Speed - 1.0) : NaN, speedHi: Number.isFinite(lt1Speed) ? r1(lt1Speed - 0.3) : NaN, alphaMin: 0.75, durationSec: (opts.minutes || 50) * 60 };
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

/** Weekly plan for availability: weekdays (Mon–Fri) minutes, weekend minutes; goal 'base' | 'perf' | 'health'. */
export function weeklyPlan({ zones, week = 1, weekdayMin = 60, weekendMin = 150, goal = 'base', lt1Adjust = 0 }) {
  const rec = isRecoveryWeek(week); const k = rec ? 0.7 : 1;
  const T1 = sessionTargets(zones, 'lt1', { lt1Adjust }); const T2 = sessionTargets(zones, 'lt2');
  const easy = T1 ? { hrLo: T1.hrLo - 5, hrHi: T1.hrHi - 4 } : null; const steady = T1 ? { hrLo: T1.hrLo, hrHi: T1.hrHi } : null;
  const longMin = Math.min(weekendMin, Math.round((90 + 10 * Math.min(week - 1, 12)) * k));
  const wd = Math.round(Math.min(weekdayMin, 60) * k) - 5; // leave 5 min for transitions
  const st = lt2Structure(week);
  const lt2Day = st && !rec ? { type: 'lt2', ko: `LT2 세션 ${st.label.split(' / ')[0]}`, en: `LT2 session ${st.label.split(' / ')[1]}`, minutes: Math.round((st.warmupSec + st.reps * st.workSec + (st.reps - 1) * st.restSec + st.cooldownSec) / 60), hr: T2, structure: st } : { type: 'lt1', ko: '회복 LT1 (쉬움)', en: 'Recovery LT1 (easy)', minutes: Math.round(45 * k), hr: easy };
  const days = [
    { day: 1, type: 'lt1', ko: 'LT1 쉬움', en: 'LT1 easy', minutes: wd, hr: easy },
    { day: 2, type: 'lt1', ko: 'LT1 안정', en: 'LT1 steady', minutes: wd, hr: steady },
    { day: 3, ...lt2Day },
    { day: 4, type: 'lt1', ko: '회복 LT1 (쉬움)', en: 'Recovery LT1 (easy)', minutes: Math.round(45 * k), hr: easy },
    { day: 5, type: 'lt1', ko: 'LT1 안정', en: 'LT1 steady', minutes: wd, hr: steady },
    { day: 6, type: 'long', ko: `긴 LT1 ${longMin}분`, en: `Long LT1 ${longMin} min`, minutes: longMin, hr: steady },
    { day: 0, type: goal === 'perf' && !rec ? 'tempo' : 'lt1', ko: goal === 'perf' && !rec ? '템포 20분 (LT2−5)' : 'LT1 쉬움 또는 휴식', en: goal === 'perf' && !rec ? 'Tempo 20 min (LT2−5)' : 'LT1 easy or rest', minutes: Math.round(Math.min(90, weekendMin * 0.5) * k), hr: goal === 'perf' && !rec && T2 ? { hrLo: T2.hrLo - 7, hrHi: T2.hrLo - 1 } : easy },
  ];
  const total = days.reduce((s, d) => s + d.minutes, 0); const hard = days.filter(d => d.type === 'lt2' || d.type === 'tempo').reduce((s, d) => s + d.minutes * 0.55, 0);
  return { week, recovery: rec, days, totalMin: total, hardPct: Math.round(100 * hard / total), speeds: T1 ? { lt1: [T1.speedLo, T1.speedHi], lt2: T2 ? [T2.speedLo, T2.speedHi] : null } : null };
}

/** Per-session metrics used by insights and summaries. */
export function sessionMetrics(session) {
  // A Free / LT1 run in which something logged marks a stop (a lactate entry, Pause, the run end typed in the card) is measured up to
  // where the running ended and without the stops inside it. Every other session: the whole recording, as it always was.
  const logged = (session.type === 'free' || session.type === 'lt1') && list(session.hrLive).length > 0 && (Number.isFinite(session.runEndSec) || list(session.events).some(e => e.type === 'lactate' || e.type === 'pause'));
  const tl = logged ? runTimeline(session) : null; // (sessions with nothing logged — nearly all of them — are not even looked at)
  const cut = tl && tl.sure && (tl.how === 'sample' || tl.how === 'pause' || tl.how === 'manual' || tl.stops.length) ? tl : null;
  const settle = alphaWindowMs(session);
  const feats = list(session.features).filter(f => !f.paused);
  const work = (cut ? list(session.features).filter(f => !alphaTainted(cut, f.t, settle)) : feats).filter(f => f.phase === 'work' || session.type === 'free'); // with a timeline its stops say what was running, not the Pause flag
  const a1 = work.map(f => f.alpha1).filter(v => Number.isFinite(v));
  const allHr = list(session.hrLive).filter(p => p[1] > 0); const hrs = cut ? allHr.filter(p => p[0] <= cut.end && !inStop(cut, p[0])) : allHr;
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

/** Auto-adjustment rules from recent LT1 sessions (last 14 days) and test age. */
export function assessRecent(sessions, zones, lastTestAt) {
  const now = Date.now(); const recent = sessions.filter(s => s.type === 'lt1' && s.final && s.sourceKind !== 'demo' && now - s.startedAt < 14 * 86400000); // practice runs on the virtual strap never adjust real targets
  const notes = []; let lt1Adjust = 0; let holdDuration = false;
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
    const ty = String(session.type || '').toUpperCase(); ko.push(`${ty} 세션 ${d}분, 평균 심박 ${Math.round(metrics.meanHr)} bpm.`); en.push(`${ty} session ${d} min, mean HR ${Math.round(metrics.meanHr)} bpm.`);
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
  if (Number.isFinite(session.midMinTyped)) midMin = session.midMinTyped;
  if (('mid' in typed && typed.mid == null) || (typed.mid == null && out.mid == null)) midMin = null;
  return { ...out, ...typed, midMin };
}
/** Label of the mid sample: "중간 (30분)" / "mid (30 min)", or plain "중간" / "mid" when its time is not known. */
export function midLabel(c) { const m = c && Number.isFinite(c.midMin) ? c.midMin : null; return m == null ? { ko: '중간', en: 'mid' } : { ko: `중간(${m}분)`, en: `mid (${m} min)` }; }
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
  // α1: the stops decide what was running, not the app's Pause flag (see runTimeline)
  const a1 = list(session.features).filter(f => f.t >= from && Number.isFinite(f.alpha1) && !alphaTainted(tl, f.t, settle)).map(f => f.alpha1);
  return { hr: mean(hr), alpha1: mean(a1), endT: t1, fromT: from, how: tl.how, sure: tl.sure, why: tl.why, tailSec: tl.tailSec, bouts: tl.bouts, entryT: tl.entryT };
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
  if (c.end < 3) return { ...base, level: 'low', ko: `마지막 반복 후 젖산 ${c.end}${spTxt} — LT2 인터벌 목표(3–4.5) 아래. 여유가 있었다면 다음엔 +0.3 km/h.${noteKo}`, en: `Lactate ${c.end} after the last rep${spTxt} — below the LT2-interval target (3–4.5). If it felt controlled, +0.3 km/h next time.${noteEn}` };
  if (c.end <= 4.5) return { ...base, level: 'ok', ko: `마지막 반복 후 젖산 ${c.end}${spTxt}${delta != null ? `, 반복 간 변화 ${dTxt}` : ''} — LT2 인터벌 목표 범위(3–4.5).${noteKo}`, en: `Lactate ${c.end} after the last rep${spTxt}${delta != null ? `, change across reps ${dTxt}` : ''} — on target for LT2 intervals (3–4.5).${noteEn}` };
  return { ...base, level: 'near', ko: `마지막 반복 후 젖산 ${c.end}${spTxt} — LT2 인터벌 목표(3–4.5)보다 조금 높음. 속도를 유지하거나 0.2~0.3 km/h 낮추세요.${noteKo}`, en: `Lactate ${c.end} after the last rep${spTxt} — a little above the LT2-interval target (3–4.5). Hold the speed or go 0.2–0.3 km/h slower.${noteEn}` };
}
function verdictCore(session, c, isMlss) {
  const sp = session.speed;
  const spTxt = Number.isFinite(sp) ? ` @ ${sp} km/h` : '';
  // the rest value of this session, else the resting baseline from Settings (measured on its own, under the sampling rules)
  const restUsed = c.rest != null ? c.rest : REST_BASELINE; const fromBase = c.rest == null && restUsed != null;
  const rise = restUsed != null ? c.end - restUsed : null; const delta = c.mid != null ? c.end - c.mid : null;
  const riseKo = rise != null ? ` (${fromBase ? `기준 안정 시 ${restUsed} 대비` : '안정 시'} ${rise >= 0 ? '+' : ''}${rise.toFixed(1)})` : '', riseEn = rise != null ? ` (${rise >= 0 ? '+' : ''}${rise.toFixed(1)} over ${fromBase ? `the resting baseline ${restUsed}` : 'rest'})` : '';
  const bouts = session.type === 'test' ? 1 : runTimeline(session).bouts;
  if (bouts === 0) return { level: 'near', adjust: null, intervals: true, ko: `워밍업 중에 끝난 세션입니다 — 젖산 ${c.end}은 기록만 하고 판정하지 않습니다.`, en: `The session ended in the warm-up — lactate ${c.end} is kept on record, no verdict.` };
  if (bouts > 1) return intervalVerdict(c, spTxt, delta);
  if (isMlss) {
    if (delta != null) {
      if (delta <= 1.0 && c.end < 8) return { level: 'ok', adjust: { lt2Speed: +0.3 }, ko: `MLSS 이하 확인${spTxt}: ${midLabel(c).ko}→종료 상승 ${delta.toFixed(1)} mmol/L (≤1.0). 다음 검증은 +0.3 km/h.`, en: `At/below MLSS${spTxt}: ${midLabel(c).en}→end rise ${delta.toFixed(1)} mmol/L (≤1.0). Next verification +0.3 km/h.` };
      return { level: 'high', adjust: { lt2Speed: -0.4 }, ko: `MLSS 초과${spTxt}: ${midLabel(c).ko}→종료 상승 ${delta.toFixed(1)} mmol/L (>1.0). LT2 속도를 0.3~0.5 km/h 낮추세요.`, en: `Above MLSS${spTxt}: rise ${delta.toFixed(1)} mmol/L (>1.0). Lower the LT2 speed by 0.3–0.5 km/h.` };
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
  if (!vd || vd.intervals || vd.longRun) return null; const z = zones || {}; const ew = endWindowStats(session, 300); const sp = session.speed;
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
 * Multi-day lactate curve: constant-speed sessions (last `days`; demo and interval sessions excluded) with an end sample → lactate
 * vs speed (+ end-HR). A run whose end is uncertain gives its lactate but not its heart rate (unsure: true); for the thresholds its
 * heart rate is read off the other runs.
 */
export function multiDayCurve(sessions, { days = 60, incline = null } = {}) {
  const now = Date.now(); const pts = [];
  // skipped: recent real sessions that carry lactate but are not a point, with the reason — shown under the curve, so nothing drops out unseen
  const skipped = []; const skip = (s, why, c = {}) => skipped.push({ id: s.id, date: s.startedAt, x: s.speed, why, mid: c.mid ?? null, midMin: c.midMin ?? null });
  for (const s of sessions) {
    if (!s || s.type === 'test' || s.sourceKind === 'demo') continue; // demo (virtual strap) sessions are practice, not data
    if (now - s.startedAt > days * 86400000) continue;
    if (incline != null && Number.isFinite(s.incline) && Math.abs(s.incline - incline) > 0.6) continue;
    const c = lactateChecks(s); if (c.end == null && c.mid == null) continue; // no lactate at all: not a verification run
    if (!s.final) { skip(s, 'unfinished', c); continue; }
    if (!Number.isFinite(s.speed)) { skip(s, 'no-speed', c); continue; }
    const w = endWindowStats(s, 300);
    if (w.bouts !== 1) { skip(s, 'intervals', c); continue; } // intervals: lactate after reps with recoveries is not a point of the constant-speed curve
    const px = endOnlyProxy(s);
    if (px.sure && px.durMin > LONG_RUN_MIN) {
      // a long run: its end value carries the duration (drift, fluids, glycogen), not the speed. A sample taken 20–45 min in, while the
      // run was still going, is comparable with a 30–35-min check — that one is the point, with the heart rate of the 5 min of running before it.
      if (!(c.mid != null && Number.isFinite(c.midMin) && c.midMin >= 20 && c.midMin <= 45)) { skip(s, 'long-no-mid', c); continue; }
      const tl = runTimeline(s); const smp = tl.samples.find(x => x.role === 'mid'); const stopT = (smp && !Number.isFinite(s.midMinTyped)) ? (Number.isFinite(smp.stopT) ? smp.stopT : smp.t) : s.startedAt + c.midMin * 60000; // a typed minute (or no logged sample): that minute
      const hrs = list(s.hrLive).filter(p => p[1] > 0 && p[0] >= stopT - 300000 && p[0] <= stopT && !inStop(tl, p[0])).map(p => p[1]);
      pts.push({ x: s.speed, la: c.mid, hr: hrs.length ? mean(hrs) : NaN, alpha1: NaN, unsure: false, from: 'mid', atMin: c.midMin, id: s.id, date: s.startedAt, incline: s.incline });
      continue;
    }
    if (c.end == null) { skip(s, 'no-end', c); continue; }
    pts.push({ x: s.speed, la: c.end, hr: w.sure ? w.hr : NaN, alpha1: w.sure ? w.alpha1 : NaN, unsure: !w.sure, id: s.id, date: s.startedAt, incline: s.incline });
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

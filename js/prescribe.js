// Zones, weekly plan, progression, auto-adjustments, lactate verification runs and rule-based summaries (KO/EN).
import { analyzeLactate } from './lactate.js';
import { smo2Steady } from './analysis.js';
const r1 = v => Math.round(v * 10) / 10;
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;

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
  const feats = (session.features || []).filter(f => !f.paused);
  const work = feats.filter(f => f.phase === 'work' || session.type === 'free');
  const a1 = work.map(f => f.alpha1).filter(v => Number.isFinite(v));
  const hrs = (session.hrLive || []).filter(p => p[1] > 0);
  const n = hrs.length; const third = Math.floor(n / 3);
  // Cardiac drift: last third vs first third, excluding the first 5 min (ramp-up) when the session is long enough (≥ 15 min).
  const tStart = session.startedAt ?? (hrs.length ? hrs[0][0] : 0); const tLast = hrs.length ? hrs[hrs.length - 1][0] : 0;
  const skip = (tLast - tStart) >= 15 * 60000 ? 5 * 60000 : 0;
  const firstWin = hrs.filter(p => p[0] >= tStart + skip && p[0] < tStart + skip + (tLast - tStart - skip) / 3);
  const hr1 = firstWin.length ? mean(firstWin.map(p => p[1])) : (third ? mean(hrs.slice(0, third).map(p => p[1])) : NaN), hr3 = third ? mean(hrs.slice(n - third).map(p => p[1])) : NaN;
  const art = feats.length ? mean(feats.map(f => f.artifactPct)) : NaN;
  const endT = session.endedAt || (hrs.length ? hrs[hrs.length - 1][0] : (feats.length ? feats[feats.length - 1].t : null));
  const dur = endT && session.startedAt ? Math.max(0, (endT - session.startedAt - (session.pauseMs || 0)) / 1000) : 0;
  const tiz = session.tiz && session.tiz.totalSec ? 100 * session.tiz.inSec / session.tiz.totalSec : NaN;
  return { durationSec: dur, meanHr: n ? mean(hrs.map(p => p[1])) : NaN, maxHr: n ? Math.max(...hrs.map(p => p[1])) : NaN, meanAlpha1: mean(a1), pctAlphaAbove75: a1.length ? 100 * a1.filter(v => v >= 0.75).length / a1.length : NaN, minAlpha1: a1.length ? Math.min(...a1) : NaN, driftPct: Number.isFinite(hr1) && hr1 ? 100 * (hr3 / hr1 - 1) : NaN, artifactPct: art, timeInZonePct: tiz, rrCount: (session.rr || []).length };
}

/** Auto-adjustment rules from recent LT1 sessions (last 14 days) and test age. */
export function assessRecent(sessions, zones, lastTestAt) {
  const now = Date.now(); const recent = sessions.filter(s => s.type === 'lt1' && s.final && now - s.startedAt < 14 * 86400000);
  const notes = []; let lt1Adjust = 0; let holdDuration = false;
  const m = recent.map(sessionMetrics).filter(x => Number.isFinite(x.meanAlpha1));
  if (m.length >= 2) {
    const ma = mean(m.map(x => x.meanAlpha1));
    if (ma < 0.70) { lt1Adjust = -3; notes.push({ ko: `최근 LT1 세션 평균 α1 ${ma.toFixed(2)} < 0.70 → 목표 심박 −3 bpm`, en: `Recent LT1 sessions average α1 ${ma.toFixed(2)} < 0.70 → target HR −3 bpm`, kind: 'adjust' }); }
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
    ko.push(`단계 테스트 ${session.stages.length}단계, ${d}분.`); en.push(`Step test: ${session.stages.length} stages, ${d} min.`);
    if (tri?.lt1) { ko.push(`LT1 ≈ ${Math.round(tri.lt1.hr)} bpm (${Number.isFinite(tri.lt1.speed) ? tri.lt1.speed.toFixed(1) + ' km/h' : ''}, 근거 ${tri.lt1.source}, 신뢰도 ${tri.grade1}).`); en.push(`LT1 ≈ ${Math.round(tri.lt1.hr)} bpm (${Number.isFinite(tri.lt1.speed) ? tri.lt1.speed.toFixed(1) + ' km/h' : ''}, source ${tri.lt1.source}, grade ${tri.grade1}).`); }
    if (tri?.lt2) { ko.push(`LT2 ≈ ${Math.round(tri.lt2.hr)} bpm (${Number.isFinite(tri.lt2.speed) ? tri.lt2.speed.toFixed(1) + ' km/h' : ''}, 근거 ${tri.lt2.source}, 신뢰도 ${tri.grade2}).`); en.push(`LT2 ≈ ${Math.round(tri.lt2.hr)} bpm (${Number.isFinite(tri.lt2.speed) ? tri.lt2.speed.toFixed(1) + ' km/h' : ''}, source ${tri.lt2.source}, grade ${tri.grade2}).`); }
    if (lac && !Number.isFinite(lac.lt2Primary.x)) { ko.push('젖산 곡선이 LT2를 지나기 전에 끝났습니다 — 다음엔 한두 단계 더 진행하세요.'); en.push('The lactate curve ended before LT2 — go one or two stages further next time.'); }
    if (analysis?.hrv && !analysis.hrv.hrvt1) { ko.push('α1이 0.75 아래로 내려오지 않았습니다 (아티팩트 또는 강도 부족).'); en.push('α1 never dropped below 0.75 (artifacts or insufficient intensity).'); }
  } else {
    ko.push(`${session.type.toUpperCase()} 세션 ${d}분, 평균 심박 ${Math.round(metrics.meanHr)} bpm.`); en.push(`${session.type.toUpperCase()} session ${d} min, mean HR ${Math.round(metrics.meanHr)} bpm.`);
    if (Number.isFinite(metrics.timeInZonePct)) { ko.push(`존 체류 ${Math.round(metrics.timeInZonePct)}%.`); en.push(`Time in zone ${Math.round(metrics.timeInZonePct)}%.`); }
    if (Number.isFinite(metrics.meanAlpha1)) {
      ko.push(`평균 α1 ${metrics.meanAlpha1.toFixed(2)} (0.75 이상 ${Math.round(metrics.pctAlphaAbove75)}%).`); en.push(`Mean α1 ${metrics.meanAlpha1.toFixed(2)} (≥0.75 for ${Math.round(metrics.pctAlphaAbove75)}%).`);
      if (session.type === 'lt1') { if (metrics.meanAlpha1 < 0.70) { ko.push('→ LT1보다 높은 강도였습니다. 다음 세션은 3 bpm 낮추세요.'); en.push('→ Harder than LT1; go 3 bpm lower next time.'); } else if (metrics.meanAlpha1 >= 0.75) { ko.push('→ 유산소 역치 아래에서 잘 유지했습니다.'); en.push('→ Stayed below the aerobic threshold.'); } }
    }
    if (Number.isFinite(metrics.driftPct)) { ko.push(`심박 드리프트 ${metrics.driftPct >= 0 ? '+' : ''}${metrics.driftPct.toFixed(1)}%${metrics.driftPct > 5 ? ' (높음 — 수분·지속시간 점검)' : ''}.`); en.push(`HR drift ${metrics.driftPct >= 0 ? '+' : ''}${metrics.driftPct.toFixed(1)}%${metrics.driftPct > 5 ? ' (high — check hydration/duration)' : ''}.`); }
  }
  if (Number.isFinite(metrics.artifactPct) && metrics.artifactPct > 5) { ko.push(`아티팩트 ${metrics.artifactPct.toFixed(1)}% — α1 해석에 주의.`); en.push(`Artifacts ${metrics.artifactPct.toFixed(1)}% — interpret α1 with care.`); }
  return { ko: ko.join(' '), en: en.join(' ') };
}

/** Plain-text block to paste into Claude for interpretation. */
export function claudeSummary({ profile, zones, session, metrics, analysis, plan }) {
  const L = [];
  L.push(`# Treadmill Lab summary (${new Date().toISOString().slice(0, 10)})`);
  if (profile) L.push(`Athlete: age ${profile.age ?? '?'}, resting HR ${profile.restHr ?? '?'}, max HR ${profile.maxHr ?? '?'}`);
  if (zones) L.push(`Thresholds: LT1 ${Math.round(zones.lt1Hr)} bpm @ ${zones.lt1Speed ?? '?'} km/h; LT2 ${Math.round(zones.lt2Hr)} bpm @ ${zones.lt2Speed ?? '?'} km/h${zones.grade ? ` (grade ${zones.grade})` : ''}${zones.updatedAt ? `, set ${new Date(zones.updatedAt).toISOString().slice(0, 10)}` : ''}`);
  if (session) {
    L.push(`Session: ${session.type}, ${new Date(session.startedAt).toLocaleString()}, ${Math.round((metrics?.durationSec || 0) / 60)} min, source ${session.sourceKind}`);
    if (metrics) L.push(`Metrics: mean HR ${Math.round(metrics.meanHr)}, max HR ${metrics.maxHr}, mean α1 ${Number.isFinite(metrics.meanAlpha1) ? metrics.meanAlpha1.toFixed(2) : 'n/a'}, min α1 ${Number.isFinite(metrics.minAlpha1) ? metrics.minAlpha1.toFixed(2) : 'n/a'}, α1≥0.75 ${Number.isFinite(metrics.pctAlphaAbove75) ? Math.round(metrics.pctAlphaAbove75) + '%' : 'n/a'}, HR drift ${Number.isFinite(metrics.driftPct) ? metrics.driftPct.toFixed(1) + '%' : 'n/a'}, artifacts ${Number.isFinite(metrics.artifactPct) ? metrics.artifactPct.toFixed(1) + '%' : 'n/a'}, time in zone ${Number.isFinite(metrics.timeInZonePct) ? Math.round(metrics.timeInZonePct) + '%' : 'n/a'}`);
    if (session.type !== 'test') {
      const c = lactateChecks(session); const v = lactateVerdict(session); const ew = endWindowStats(session, 300);
      L.push(`Constant load: speed ${session.speed ?? '?'} km/h, incline ${session.incline ?? '?'} %; last-5-min HR ${Number.isFinite(ew.hr) ? Math.round(ew.hr) : 'n/a'}, α1 ${Number.isFinite(ew.alpha1) ? ew.alpha1.toFixed(2) : 'n/a'}; lactate rest ${c.rest ?? 'n/a'}, 10-min ${c.mid ?? 'n/a'}, end ${c.end ?? 'n/a'}${v ? `; verdict: ${v.en}` : ''}`);
      const ss = smo2Steady(session);
      if (ss) L.push(`SmO2 (constant load): 5-10 min ${Number.isFinite(ss.earlyMean) ? ss.earlyMean.toFixed(1) : 'n/a'} %, last 5 min ${Number.isFinite(ss.endMean) ? ss.endMean.toFixed(1) : 'n/a'} % (drift ${Number.isFinite(ss.drift) ? (ss.drift > 0 ? '+' : '') + ss.drift.toFixed(1) : 'n/a'}), min ${Number.isFinite(ss.min) ? ss.min.toFixed(1) : 'n/a'} %, end slope ${Number.isFinite(ss.slopeEnd) ? ss.slopeEnd.toFixed(2) : 'n/a'} %/min → ${ss.steady == null ? 'n/a' : ss.steady ? 'steady' : 'NOT steady'}; THb mean ${Number.isFinite(ss.thbMean) ? ss.thbMean.toFixed(1) : 'n/a'} (contact ${ss.contact ?? 'n/a'}); coverage ${Math.round(ss.coverageSec / 60)} min`);
    }
    if (session.stages?.length) { L.push('Stages (speed km/h | incline % | HR | α1 | lactate | RPE | SmO2):'); for (const r of (analysis?.rows || session.stages)) L.push(`  ${r.speed} | ${r.incline} | ${Number.isFinite(r.hr) ? Math.round(r.hr) : '-'} | ${Number.isFinite(r.alpha1) ? r.alpha1.toFixed(2) : '-'} | ${r.lactate ?? '-'} | ${r.rpe ?? '-'} | ${Number.isFinite(r.smo2) ? r.smo2.toFixed(1) : '-'}`); }
    if (analysis?.lactate) { L.push('Lactate methods: ' + [...analysis.lactate.lt1, ...analysis.lactate.lt2].map(m => `${m.method}=${Number.isFinite(m.x) ? m.x.toFixed(2) + 'km/h/' + Math.round(m.hr) + 'bpm' : 'n/a'}`).join(', ')); }
    if (analysis?.hrv) L.push(`HRVT: HRVT1 ${analysis.hrv.hrvt1 ? Math.round(analysis.hrv.hrvt1.hr) + ' bpm @ ' + analysis.hrv.hrvt1.speed.toFixed(1) : 'n/a'}; HRVT2 ${analysis.hrv.hrvt2 ? Math.round(analysis.hrv.hrvt2.hr) + ' bpm @ ' + analysis.hrv.hrvt2.speed.toFixed(1) : 'n/a'}${analysis.hrv.note ? ' (' + analysis.hrv.note + ')' : ''}${analysis.hrv.plateau ? ' [' + analysis.hrv.plateau.note + ']' : ''}`);
    if (analysis?.smo2) L.push(`SmO2 breakpoints: BP1 ${analysis.smo2.bp1 ? analysis.smo2.bp1.speed.toFixed(1) + ' km/h' : 'n/a'}, BP2 ${analysis.smo2.bp2 ? analysis.smo2.bp2.speed.toFixed(1) + ' km/h' : 'n/a'}${analysis.smo2.note ? ' (' + analysis.smo2.note + ')' : ''}`);
    if (analysis?.tri) L.push(`Triangulation: LT1 ${analysis.tri.lt1 ? Math.round(analysis.tri.lt1.hr) + ' bpm (' + analysis.tri.lt1.source + ', grade ' + analysis.tri.grade1 + ')' : 'n/a'}; LT2 ${analysis.tri.lt2 ? Math.round(analysis.tri.lt2.hr) + ' bpm (' + analysis.tri.lt2.source + ', grade ' + analysis.tri.grade2 + ')' : 'n/a'}`);
  }
  if (plan) L.push(`Plan week ${plan.week}${plan.recovery ? ' (recovery)' : ''}: ` + plan.days.map(d => `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.day]} ${d.en} ${d.minutes}min`).join('; '));
  L.push('Question: please interpret this session and suggest adjustments. (DFA α1: 0.75 ≈ aerobic threshold, 0.5 ≈ anaerobic threshold; lactate is the anchor.)');
  return L.join('\n');
}


// ---------- Lactate verification runs (solo-friendly: samples only at rest / ~10 min / end) ----------
/** Derive {rest, mid, end} lactate from logged events by timing; explicit session.lactateChecks wins. */
export function lactateChecks(session) {
  const out = { rest: null, mid: null, end: null, ...(session.lactateChecks || {}) };
  const t0 = session.startedAt, t1 = session.endedAt || t0; const dur = (t1 - t0) / 1000;
  for (const e of session.events || []) {
    if (e.type !== 'lactate' || !Number.isFinite(e.value)) continue;
    const rel = (e.t - t0) / 1000;
    if (rel <= 240 && out.rest == null) out.rest = e.value;
    else if (rel >= dur - 300 || rel >= dur * 0.85) { if (out.end == null) out.end = e.value; }
    else if (out.mid == null) out.mid = e.value;
  }
  return out;
}
/** Mean HR / α1 over the last `sec` seconds of a session (steady-state end). */
export function endWindowStats(session, sec = 300) {
  const t1 = session.endedAt || (session.hrLive?.length ? session.hrLive[session.hrLive.length - 1][0] : null); if (!t1) return { hr: NaN, alpha1: NaN };
  const hr = (session.hrLive || []).filter(p => p[0] >= t1 - sec * 1000 && p[1] > 0).map(p => p[1]);
  const a1 = (session.features || []).filter(f => f.t >= t1 - sec * 1000 && Number.isFinite(f.alpha1) && !f.paused).map(f => f.alpha1);
  return { hr: mean(hr), alpha1: mean(a1) };
}
/**
 * Verdict for a constant-load session with end (and optional rest / 10-min) lactate.
 * LT1 runs: end ≤ 2.0 (and ≤ rest+1.0) → below LT1. LT2 runs (MLSS logic): Δ(mid→end) ≤ 1.0 → at/below MLSS.
 */
export function lactateVerdict(session) {
  const c = lactateChecks(session); const sp = session.speed; const type = session.type;
  if (c.end == null) return null;
  const spTxt = Number.isFinite(sp) ? ` @ ${sp} km/h` : '';
  const rise = c.rest != null ? c.end - c.rest : null; const delta = c.mid != null ? c.end - c.mid : null;
  if (type === 'lt2' || (type === 'free' && c.end >= 3)) {
    if (delta != null) {
      if (delta <= 1.0 && c.end < 8) return { level: 'ok', adjust: { lt2Speed: +0.3 }, ko: `MLSS 이하 확인${spTxt}: 10분→종료 상승 ${delta.toFixed(1)} mmol/L (≤1.0). 다음 검증은 +0.3 km/h.`, en: `At/below MLSS${spTxt}: 10-min→end rise ${delta.toFixed(1)} mmol/L (≤1.0). Next verification +0.3 km/h.` };
      return { level: 'high', adjust: { lt2Speed: -0.4 }, ko: `MLSS 초과${spTxt}: 10분→종료 상승 ${delta.toFixed(1)} mmol/L (>1.0). LT2 속도를 0.3~0.5 km/h 낮추세요.`, en: `Above MLSS${spTxt}: rise ${delta.toFixed(1)} mmol/L (>1.0). Lower the LT2 speed by 0.3–0.5 km/h.` };
    }
    if (c.end >= 6) return { level: 'high', adjust: { lt2Speed: -0.4 }, ko: `종료 젖산 ${c.end} — LT2 위일 가능성${spTxt}. 10분 샘플을 추가하면 판정이 확실해집니다.`, en: `End lactate ${c.end} — likely above LT2${spTxt}. Add a 10-min sample next time for a firm call.` };
    if (c.end < 3) return { level: 'low', adjust: { lt2Speed: +0.3 }, ko: `종료 젖산 ${c.end} — LT2 아래${spTxt}. 다음엔 +0.3 km/h.`, en: `End lactate ${c.end} — below LT2${spTxt}. Try +0.3 km/h next time.` };
    return { level: 'near', adjust: null, ko: `종료 젖산 ${c.end} — LT2 근처${spTxt}. 안정 상태 확인에는 10분 샘플이 필요합니다.`, en: `End lactate ${c.end} — near LT2${spTxt}. A 10-min sample is needed to confirm steady state.` };
  }
  // LT1 / easy runs
  const tooHigh = c.end > 2.5 || (rise != null && rise > 1.5);
  const border = !tooHigh && (c.end > 2.0 || (rise != null && rise > 1.0));
  if (tooHigh) return { level: 'high', adjust: { lt1Hr: -4 }, ko: `종료 젖산 ${c.end}${rise != null ? ` (안정 시 +${rise.toFixed(1)})` : ''} — LT1 위${spTxt}. 목표 심박 −4 bpm 후 재검증.`, en: `End lactate ${c.end}${rise != null ? ` (+${rise.toFixed(1)} over rest)` : ''} — above LT1${spTxt}. Target HR −4 bpm, then verify again.` };
  if (border) return { level: 'near', adjust: { lt1Hr: -2 }, ko: `종료 젖산 ${c.end} — LT1 경계${spTxt}. 목표 심박 −2 bpm.`, en: `End lactate ${c.end} — borderline LT1${spTxt}. Target HR −2 bpm.` };
  return { level: 'ok', adjust: null, ko: `종료 젖산 ${c.end}${rise != null ? ` (안정 시 +${rise.toFixed(1)})` : ''} — LT1 아래 확인${spTxt}.`, en: `End lactate ${c.end}${rise != null ? ` (+${rise.toFixed(1)} over rest)` : ''} — below LT1 confirmed${spTxt}.` };
}
/** Multi-day lactate curve: constant-speed sessions (last `days`) with an end sample → lactate vs speed (+ end-HR). */
export function multiDayCurve(sessions, { days = 60, incline = null } = {}) {
  const now = Date.now(); const pts = [];
  for (const s of sessions) {
    if (s.type === 'test' || !s.final || !Number.isFinite(s.speed)) continue;
    if (now - s.startedAt > days * 86400000) continue;
    if (incline != null && Number.isFinite(s.incline) && Math.abs(s.incline - incline) > 0.6) continue;
    const c = lactateChecks(s); if (c.end == null) continue;
    const w = endWindowStats(s, 300);
    pts.push({ x: s.speed, la: c.end, hr: w.hr, alpha1: w.alpha1, id: s.id, date: s.startedAt, incline: s.incline });
  }
  // one point per speed: keep the most recent
  const bySpeed = new Map(); for (const p of pts.sort((a, b) => a.date - b.date)) bySpeed.set(p.x, p);
  const points = [...bySpeed.values()].sort((a, b) => a.x - b.x);
  const analysis = points.length >= 3 ? analyzeLactate(points.map(p => ({ x: p.x, la: p.la, hr: p.hr }))) : null;
  const span = points.length ? Math.max(...points.map(p => p.la)) - Math.min(...points.map(p => p.la)) : 0;
  const grade = points.length >= 5 && span >= 2 ? 'B' : points.length >= 3 ? 'C' : '-';
  return { points, analysis, grade };
}

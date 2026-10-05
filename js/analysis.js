// Stage summaries, HRV thresholds (DFA a1 0.75 / 0.5), SmO2 breakpoints and triangulation.
import { analyzeLactate, interp } from './lactate.js';

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
function linreg(xs, ys) {
  const n = xs.length; if (n < 2) return { a: NaN, b: NaN, r2: NaN, n };
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  const b = sxx ? sxy / sxx : NaN; const a = my - b * mx;
  const r2 = (sxx && syy) ? (sxy * sxy) / (sxx * syy) : NaN;
  return { a, b, r2, n };
}

/**
 * Build per-stage summaries from a recorded session.
 * stage: {idx, speed, incline, tStart, tEnd (end of work, ms), lactate, rpe}
 * features: [{t, alpha1, hr, artifactPct}] ; smo2: {series:[[t, smo2, thb]], offsetMs}
 */
// a1 uses the last 60 s of each stage so that every 120-s α1 window lies inside the stage (after the post-pause HR transient).
export function summarizeStages(session, { a1WindowSec = 60, smo2WindowSec = 60 } = {}) {
  const feats = session.features || [];
  const smo = session.smo2 && session.smo2.series ? session.smo2.series : null;
  const off = session.smo2 ? (session.smo2.offsetMs || 0) : 0;
  const out = []; const pauses = pauseIntervals(session);
  const activeStart = (tEnd, sec, tMin) => activeWindowStart(pauses, tEnd, sec, tMin); // a pause stops the stage clock; its minutes are not part of the stage
  for (const st of session.stages || []) {
    if (!Number.isFinite(st.tEnd) || !Number.isFinite(st.tStart)) continue;
    const w0 = activeStart(st.tEnd, a1WindowSec, st.tStart), w1 = st.tEnd;
    const f = feats.filter(p => p.t >= w0 && p.t <= w1 && !p.paused && !inPause(pauses, p.t) && Number.isFinite(p.alpha1));
    const fh = feats.filter(p => p.t >= w0 && p.t <= w1 && !p.paused && !inPause(pauses, p.t) && Number.isFinite(p.hr));
    // Prefer the strap's own HR (1 Hz) averaged over the window; fall back to the 2-min windowed HR of the features
    let hr = NaN;
    if (session.hrLive && session.hrLive.length) { const h = session.hrLive.filter(p => p[0] >= w0 && p[0] <= w1 && p[1] > 0 && !inPause(pauses, p[0])).map(p => p[1]); hr = mean(h); }
    if (!Number.isFinite(hr)) hr = mean(fh.map(p => p.hr));
    const row = {
      idx: st.idx, speed: st.speed, incline: st.incline, lactate: st.lactate, rpe: st.rpe,
      durationSec: (st.tEnd - st.tStart - overlapMs(pauses, st.tStart, st.tEnd)) / 1000,
      hr, alpha1: mean(f.map(p => p.alpha1)), alpha1n: f.length,
      artifactPct: mean(fh.map(p => p.artifactPct)),
      smo2: NaN, smo2Slope: NaN, thb: NaN,
    };
    if (smo && smo.length) {
      const s0 = activeStart(st.tEnd, smo2WindowSec, -Infinity); // same rule as heart rate and α1: paused minutes are not part of the stage
      const seg = smo.filter(p => p[0] + off >= s0 && p[0] + off <= st.tEnd && !inPause(pauses, p[0] + off));
      row.smo2 = mean(seg.map(p => p[1])); row.thb = mean(seg.map(p => p[2]).filter(isFinite));
      const s1 = activeStart(st.tEnd, 120, -Infinity);
      const s2 = smo.filter(p => p[0] + off >= s1 && p[0] + off <= st.tEnd && !inPause(pauses, p[0] + off));
      if (s2.length > 10) { const r = linreg(s2.map(p => (p[0] + off - st.tEnd) / 60000), s2.map(p => p[1])); row.smo2Slope = r.b; }
    }
    out.push(row);
  }
  return out;
}

/** Threshold crossing helper on stage rows: finds x (speed) and HR where y crosses level (descending y). */
function crossingDescending(rows, key, level) {
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (!Number.isFinite(a[key]) || !Number.isFinite(b[key])) continue;
    if (a[key] >= level && b[key] < level) {
      const t = (a[key] - level) / (a[key] - b[key]);
      return { speed: Number.isFinite(a.speed) && Number.isFinite(b.speed) ? a.speed + t * (b.speed - a.speed) : NaN, hr: a.hr + t * (b.hr - a.hr), how: 'interp' }; // stages without a speed (imported laps): unknown, not 0 km/h
    }
  }
  return null;
}

/**
 * HRV thresholds from stage rows (Rogers et al.: linear regression of a1 vs HR in the transition region).
 */
export function hrvThresholds(rows, { artifactLimit = 5 } = {}) {
  const valid = rows.filter(r => Number.isFinite(r.alpha1) && Number.isFinite(r.hr) && (!(r.artifactPct > artifactLimit)));
  const res = { hrvt1: null, hrvt2: null, fit: null, points: valid.length, note: '' };
  if (valid.length < 3) { res.note = 'need ≥3 valid stages'; return res; }
  const trans = valid.filter(r => r.alpha1 >= 0.4 && r.alpha1 <= 1.1);
  const pool = trans.length >= 3 ? trans : valid;
  const fit = linreg(pool.map(r => r.hr), pool.map(r => r.alpha1));
  res.fit = { ...fit, usedTransitionOnly: trans.length >= 3 };
  const hrMin = Math.min(...valid.map(r => r.hr)), hrMax = Math.max(...valid.map(r => r.hr));
  const solve = level => {
    if (Number.isFinite(fit.b) && fit.b < 0) {
      const hr = (level - fit.a) / fit.b;
      if (hr >= hrMin - 5 && hr <= hrMax + 8) {
        const speed = valid.every(r => Number.isFinite(r.speed)) ? interp(valid.map(r => r.hr), valid.map(r => r.speed), hr) : NaN;
        return { hr, speed, how: 'regression', r2: fit.r2 };
      }
    }
    return crossingDescending(valid, 'alpha1', level);
  };
  const poorFit = !(Number.isFinite(fit.r2) && fit.r2 >= 0.7);
  if (poorFit) { // a weak linear a1–HR relationship (plateau/floor pattern): use first crossings instead of the regression
    res.hrvt1 = crossingDescending(valid, 'alpha1', 0.75); res.hrvt2 = crossingDescending(valid, 'alpha1', 0.5);
    res.note = `weak linear fit (r²=${Number.isFinite(fit.r2) ? fit.r2.toFixed(2) : 'n/a'}) — first crossings used`;
  } else { res.hrvt1 = solve(0.75); res.hrvt2 = solve(0.5); }
  // plateau detection: a1 stuck in 0.3–0.55 while HR keeps rising over ≥4 stages → thresholds from a1 are unreliable
  const sorted = valid.slice().sort((a, b) => a.hr - b.hr); let run = [];
  for (const r of sorted) { if (r.alpha1 >= 0.3 && r.alpha1 <= 0.55) run.push(r); else if (run.length >= 4) break; else run = []; }
  if (run.length >= 4 && (run[run.length - 1].hr - run[0].hr) >= 20) res.plateau = { stages: run.length, hrFrom: run[0].hr, hrTo: run[run.length - 1].hr, note: `a1 floor (0.3–0.55) across ${run.length} stages (${Math.round(run[0].hr)}–${Math.round(run[run.length - 1].hr)} bpm): early a1 decline — verify with lactate` };
  if (!res.hrvt1) res.note = 'a1 never crossed 0.75 (test too easy or a1 noisy)';
  if (res.hrvt1 && !res.hrvt2) res.note = 'a1 did not reach 0.5 (test ended before HRVT2)';
  return res;
}

/** Continuous piecewise-linear fit with k breakpoints (k = 1 or 2) via grid search on stage rows. */
function piecewise(xs, ys, k) {
  const n = xs.length; let best = null;
  const cand = []; for (let i = 0; i < n - 1; i++) for (let s = 1; s < 4; s++) cand.push(xs[i] + (xs[i + 1] - xs[i]) * s / 4);
  const fitWith = ks => {
    // design: [1, x, max(0,x-k1), max(0,x-k2)]
    const cols = [xs.map(() => 1), xs.slice(), ...ks.map(kk => xs.map(x => Math.max(0, x - kk)))];
    const m = cols.length; const A = Array.from({ length: m }, () => new Array(m).fill(0)); const b = new Array(m).fill(0);
    for (let i = 0; i < m; i++) { for (let j = 0; j < m; j++) for (let t = 0; t < n; t++) A[i][j] += cols[i][t] * cols[j][t]; for (let t = 0; t < n; t++) b[i] += cols[i][t] * ys[t]; }
    // solve
    const M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < m; c++) { let p = c; for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;[M[c], M[p]] = [M[p], M[c]]; if (Math.abs(M[c][c]) < 1e-12) return null; for (let r = c + 1; r < m; r++) { const f = M[r][c] / M[c][c]; for (let q = c; q <= m; q++) M[r][q] -= f * M[c][q]; } }
    const co = new Array(m).fill(0); for (let r = m - 1; r >= 0; r--) { let s = M[r][m]; for (let q = r + 1; q < m; q++) s -= M[r][q] * co[q]; co[r] = s / M[r][r]; }
    let sse = 0; for (let t = 0; t < n; t++) { let yh = 0; for (let i = 0; i < m; i++) yh += co[i] * cols[i][t]; sse += (ys[t] - yh) ** 2; }
    return { ks, co, sse };
  };
  if (k === 1) { for (const k1 of cand) { const f = fitWith([k1]); if (f && (!best || f.sse < best.sse)) best = f; } }
  else { for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) { if (cand[j] - cand[i] < (xs[1] - xs[0]) * 0.9) continue; const f = fitWith([cand[i], cand[j]]); if (f && (!best || f.sse < best.sse)) best = f; } }
  const lin = linreg(xs, ys); let sseLin = 0; for (let t = 0; t < n; t++) sseLin += (ys[t] - (lin.a + lin.b * xs[t])) ** 2;
  if (best) best.improvement = sseLin > 0 ? 1 - best.sse / sseLin : 0;
  return best;
}

const median = a => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Paused stretches [from, to] in ms, from the session's pause / resume events; a pause still open at the end closes there. */
export function pauseIntervals(session) {
  const ev = (session.events || []).filter(e => e.type === 'pause' || e.type === 'resume' || e.type === 'stop').sort((a, b) => a.t - b.t);
  const out = []; let from = null;
  for (const e of ev) { if (e.type === 'pause') { if (from == null) from = e.t; } else if (from != null) { if (e.t > from) out.push([from, e.t]); from = null; } }
  if (from != null) { const hl = session.hrLive; const end = session.endedAt ?? (hl && hl.length ? hl[hl.length - 1][0] : from); if (end > from) out.push([from, end]); }
  return out;
}
const overlapMs = (iv, a, b) => iv.reduce((s, p) => s + Math.max(0, Math.min(p[1], b) - Math.max(p[0], a)), 0);
const inPause = (iv, t) => { for (const p of iv) if (t > p[0] && t <= p[1]) return true; return false; }; // a sample stamped at the very instant of Pause was taken running, one at the instant of Resume standing
/**
 * Start of the window that holds `sec` seconds of unpaused time before tEnd, not earlier than tMin.
 * pauses = pauseIntervals(session). Without pauses this is simply tEnd − sec.
 */
export function activeWindowStart(pauses, tEnd, sec, tMin = -Infinity) {
  let t = tEnd, left = sec * 1000;
  for (let i = pauses.length - 1; i >= 0; i--) { const p = pauses[i]; if (p[0] >= t) continue; if (p[1] <= tMin) break; const run = t - Math.min(p[1], t); if (run >= left) return Math.max(tMin, t - left); left -= run; t = Math.min(t, p[0]); }
  return Math.max(tMin, t - left);
}
/** Paused time (ms) inside [a, b]. */
export function pausedMsBetween(session, a, b) { return overlapMs(pauseIntervals(session), a, b); }
/** Paused time (ms) that lies before time t. */
export function pausedMsBefore(session, t) { return pausedMsBetween(session, -Infinity, t); }

/**
 * Where the running stopped in a constant-load recording.
 * The app keeps recording while the runner stops the belt, draws blood and types the value, so a session
 * usually ends one to three minutes after the exercise did — longer when a cool-down walk is left running.
 * Heart rate marks the moment: it leaves the level it held and never comes back. "Last 5 min" windows must
 * end there; anchored to the end of the recording they average recovery in, which lowers the heart rate and
 * lifts SmO2.
 *
 * Method, on a 15-s running median of the strap's heart rate. For a boundary τ, the run level L(τ) is the
 * 10th percentile of the 5 min before τ (brief dips such as a mid-run belt stop left out, so a short surge or
 * a burst of false readings cannot raise it). τ counts as "the running had stopped" when
 *   – from τ+30 s to the end of the recording the heart rate never returns to within bandBpm of L,
 *   – for tails over 2 min it also stays holdBpm below L from τ+90 s on (standing or walking, not merely a slower pace),
 *   – the last 20 s are dropShort below L (tails up to 2 min, still falling) rising to dropLong (4 min and more),
 *   – and from τ+90 s on it does not come back to within nearBpm of the level held for most of the run up to τ
 *     (a few fast minutes followed by more running at the usual pace are a surge, not the end of the run).
 * The EARLIEST such τ (+10 s) is the end of the exercise: stop → stand → walk → stand is one tail, not three.
 * A pace eased by less than ~15 bpm while still running is not an end; a belt slowed down in the last minute before stepping
 * off puts the end at the slow-down.
 * Built for what a verification run is: one load from the first minute to the stop (warm-up outside the recording).
 * Limits — heart rate alone cannot tell these apart: a walk less than ~15 bpm below the running heart rate counts as running;
 * a cool-down jog 25 bpm or more below the run counts as after it; a fast part that is longer than everything before it is taken
 * for the run (warm-up → block → cool-down jog: the block); a recording whose "tail" is more than 1.5 × the run before it
 * (fastest minutes at the start, or left recording for an hour) is left unresolved (how = 'end').
 * Returns { t, tailSec, how } — how = 'hr' when a tail was found, else 'end' (t = end of the recording).
 */
const exEndCache = new WeakMap(); // hrLive array → { sig, res }: several screens ask for the same session
const exEndById = new Map();      // session id → the same, for screens that read the sessions afresh from storage on every visit
const exEndSig = session => { const h = session.hrLive; const last = h && h.length ? h[h.length - 1] : null; return `${session.startedAt}|${session.endedAt}|${h ? h.length : 0}|${last ? last[0] + ':' + last[1] : ''}`; };
export function exerciseEnd(session, opts) {
  if (opts || !session || !session.hrLive || typeof session.hrLive !== 'object') return findExerciseEnd(session || {}, opts || {});
  const sig = exEndSig(session); let c = exEndCache.get(session.hrLive); if (c && c.sig === sig) return c.res;
  c = session.id != null ? exEndById.get(session.id) : null;
  if (!c || c.sig !== sig) { c = { sig, res: findExerciseEnd(session, {}) }; if (session.id != null) { if (exEndById.size >= 400) exEndById.delete(exEndById.keys().next().value); exEndById.set(session.id, c); } }
  exEndCache.set(session.hrLive, c); return c.res;
}
function findExerciseEnd(session, { bandBpm = 5, holdBpm = 15, nearBpm = 8, dropShort = 12, dropLong = 25, stepSec = 5 } = {}) {
  const hrs = (session.hrLive || []).filter(p => p && p[1] > 0);
  const tEnd = session.endedAt || (hrs.length ? hrs[hrs.length - 1][0] : null);
  const none = { t: tEnd, tailSec: 0, how: 'end' };
  if (tEnd == null || hrs.length < 30) return none;
  const t0 = session.startedAt ?? hrs[0][0];
  if (tEnd - t0 < 300000) return none; // under 5 min: no steady level to compare with
  const pts = hrs.filter(p => p[0] <= tEnd);
  if (pts.length < 30 || tEnd - pts[pts.length - 1][0] > 30000) return none; // heart rate missing at the end: cannot tell
  const T = pts.map(p => p[0]), H = pts.map(p => p[1]), n = T.length;
  const sm = new Float64Array(n); let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) { while (T[lo] < T[i] - 7500) lo++; while (hi < n - 1 && T[hi + 1] <= T[i] + 7500) hi++; sm[i] = median(H.slice(lo, hi + 1)); }
  const lastVals = H.filter((_, i) => T[i] >= tEnd - 20000); const hEnd = mean(lastVals.length ? lastVals : H.slice(-3));
  const sufMax = new Float64Array(n); for (let i = n - 1; i >= 0; i--) sufMax[i] = i === n - 1 ? sm[i] : Math.max(sm[i], sufMax[i + 1]); // max of the smoothed series from i to the end
  const firstIdxAtOrAfter = t => { let a = 0, b = n; while (a < b) { const m = (a + b) >> 1; if (T[m] < t) a = m + 1; else b = m; } return a; };
  // Level of sm[a..b): lower decile of the values that are not more than 12 bpm below the median (dips such as a mid-run belt stop left out).
  const levelOf = (a, b) => { const w = sm.slice(a, b).sort(); const m = w.length >> 1; const med = w.length % 2 ? w[m] : (w[m - 1] + w[m]) / 2; let k = 0; while (w[k] < med - 12) k++; return w[k + Math.floor(0.1 * (w.length - k - 1))]; };
  const iRun0 = firstIdxAtOrAfter(t0 + 120000); // the first 2 min (heart rate still rising) say nothing about the level of the run
  const stopped = tau => { // every rule but the surge rule; cheapest tests first (this runs for every 5 s of the recording)
    const iPost = firstIdxAtOrAfter(tau + 30000); if (iPost >= n) return false;
    const a = firstIdxAtOrAfter(tau - 300000), b = firstIdxAtOrAfter(tau + 1); if (b - a < 6 || T[b - 1] - T[a] < 60000) return false; // too little before τ to speak of a level
    let top = -Infinity; for (let i = a; i < b; i++) if (sm[i] > top) top = sm[i];
    if (sufMax[iPost] > top - bandBpm || hEnd > top - Math.min(dropShort, dropLong)) return false; // the level cannot exceed the window's maximum: no need to work it out
    const L = levelOf(a, b);
    if (sufMax[iPost] > L - bandBpm) return false;
    const tail = (tEnd - tau) / 1000; const iHold = firstIdxAtOrAfter(tau + 90000);
    if (tail > 120 && iHold < n && sufMax[iHold] > L - holdBpm) return false;
    const need = tail <= 120 ? dropShort : tail >= 240 ? dropLong : dropShort + (dropLong - dropShort) * (tail - 120) / 120;
    return hEnd <= L - need;
  };
  // Surge rule: from τ+90 s on (or, when the recording ends before that, in its last 20 s) the heart rate is back within nearBpm
  // of the level held for most of the run up to τ → τ ended a few fast minutes, not the run.
  const surgeEnd = tau => { const iHold = firstIdxAtOrAfter(tau + 90000), b = firstIdxAtOrAfter(tau + 1); return b - iRun0 >= 6 && (iHold < n ? sufMax[iHold] : hEnd) > levelOf(iRun0, b) - nearBpm; };
  const cand = []; for (let tau = tEnd - 30000; tau >= t0 + 120000; tau -= stepSec * 1000) if (stopped(tau)) cand.push(tau); // latest first
  let tauE = null; for (let i = cand.length - 1; i >= 0 && tauE == null; i--) if (!surgeEnd(cand[i])) tauE = cand[i]; // the earliest boundary wins
  if (tauE == null) return none;
  if (tEnd - tauE > 1.5 * (tauE - t0)) return none; // "tail" much longer than the run before it: more likely a fast start followed by the real run — not resolved
  const t = Math.min(tauE + 10000, tEnd - 20000); const tailSec = (tEnd - t) / 1000;
  return tailSec >= 20 ? { t, tailSec, how: 'hr' } : none;
}

/**
 * The stretch of a non-test session that its end-of-run figures refer to.
 *  – Free / LT1 sessions: from the start to where the running stopped (exerciseEnd).
 *  – LT2 sessions (warm-up, reps, cool-down): the work phases the engine logged; t1 = end of the last rep.
 * { t0, t1, lastStart, bouts, how: 'phase' | 'hr' | 'end', tailSec }. bouts > 1 = intervals: drift and the
 * end-only MLSS proxy compare one part of a steady run with another and have no meaning across rests.
 */
export function workBout(session) {
  const ex = exerciseEnd(session); const tRec = session.endedAt ?? ex.t;
  if (session.type === 'lt2') {
    const ph = (session.events || []).filter(e => e.type === 'phase').sort((a, b) => a.t - b.t); const work = [];
    for (let i = 0; i < ph.length; i++) if (ph[i].phase === 'work') work.push([ph[i].t, ph[i + 1] ? ph[i + 1].t : null]);
    if (work.length) {
      const last = work[work.length - 1]; if (last[1] == null) last[1] = (ex.how === 'hr' && ex.t > last[0]) ? ex.t : tRec; // finished inside the last rep
      return { t0: work[0][0], t1: last[1], lastStart: last[0], bouts: work.length, how: 'phase', tailSec: tRec != null ? Math.max(0, (tRec - last[1]) / 1000) : 0 };
    }
    return { t0: session.startedAt, t1: ex.t, lastStart: session.startedAt, bouts: 2, how: ex.how, tailSec: ex.tailSec }; // no phase log (hand-made record): warm-up and rests cannot be told apart, so never treated as one steady bout
  }
  return { t0: session.startedAt, t1: ex.t, lastStart: session.startedAt, bouts: 1, how: ex.how, tailSec: ex.tailSec };
}

/**
 * Constant-load SmO2 steady-state summary (verification / LT1 / LT2 runs):
 * early window (5–10 min) vs last 5 min, end slope (%/min over the last 10 min), THb as contact quality.
 * steady = end slope > −0.3 %/min (SmO2 keeps falling at the end only above the sustainable domain).
 * "End" is the end of the run (workBout), not of the recording: SmO2 rebounds within seconds of stopping,
 * and a minute of that rebound inside the window turns a falling end slope into a rising one.
 */
export function smo2Steady(session, { earlyFrom = 300, earlyTo = 600, endSec = 300, slopeSec = 600 } = {}) {
  const smo = session.smo2 && session.smo2.series; if (!smo || smo.length < 20) return null;
  const off = session.smo2.offsetMs || 0;
  const bout = workBout(session); const t0 = bout.t0 ?? session.startedAt; const t1 = bout.t1 ?? (smo[smo.length - 1][0] + off);
  const pauses = pauseIntervals(session); // belt stopped for a sample with the app paused: SmO2 rebounds there within seconds
  const pts = smo.map(p => [p[0] + off, p[1], p[2]]).filter(p => p[0] >= t0 && p[0] <= t1 && Number.isFinite(p[1]) && !inPause(pauses, p[0]));
  if (pts.length < 20) return null;
  const sel = (a, b) => pts.filter(p => p[0] >= a && p[0] < b);
  const early = sel(t0 + earlyFrom * 1000, t0 + earlyTo * 1000), late = sel(t1 - endSec * 1000, t1 + 1), seg = sel(t1 - slopeSec * 1000, t1 + 1);
  const thb = pts.map(p => p[2]).filter(Number.isFinite);
  let mn = Infinity, mx = -Infinity; for (const p of pts) { if (p[1] < mn) mn = p[1]; if (p[1] > mx) mx = p[1]; } // loops, not Math.min(...): a 10-Hz export of a long run has tens of thousands of points
  let thbMin = Infinity; for (const v of thb) if (v < thbMin) thbMin = v;
  const res = { n: pts.length, coverageSec: (pts[pts.length - 1][0] - pts[0][0]) / 1000, earlyMean: mean(early.map(p => p[1])), endMean: mean(late.map(p => p[1])), min: mn, max: mx, thbMean: mean(thb), thbMin: thb.length ? thbMin : NaN, slopeEnd: NaN, drift: NaN, steady: null, contact: null, endT: t1, tailSec: bout.tailSec || 0, bouts: bout.bouts };
  if (seg.length > 10) res.slopeEnd = linreg(seg.map(p => (p[0] - t1) / 60000), seg.map(p => p[1])).b;
  if (Number.isFinite(res.earlyMean) && Number.isFinite(res.endMean)) res.drift = res.endMean - res.earlyMean;
  if (Number.isFinite(res.slopeEnd) && bout.bouts === 1) res.steady = res.slopeEnd > -0.3; // across intervals with rests a slope says nothing about steadiness
  if (Number.isFinite(res.thbMean)) res.contact = res.thbMean >= 12 ? 'ok' : 'low';
  return res;
}

/**
 * Estimate the clock offset of an imported series relative to the session by matching heart rate
 * (Train.Red / Garmin exports carry the same H10 heart rate the app recorded).
 * Returns { offsetMs, mad, n, ok } with offsetMs in the app's convention: importTime + offsetMs = sessionTime.
 */
export function estimateOffsetMs(sessionHr, importHr, { maxLagSec = 180, stepSec = 1, maxPoints = 600 } = {}) {
  const S = (sessionHr || []).filter(p => p && p[1] > 0), I = (importHr || []).filter(p => p && p[1] > 0);
  if (S.length < 60 || I.length < 60) return { offsetMs: 0, mad: NaN, n: 0, ok: false };
  const stride = Math.max(1, Math.floor(S.length / maxPoints)); const pts = S.filter((_, i) => i % stride === 0);
  const it = I.map(p => p[0]), ih = I.map(p => p[1]);
  const at = (t) => { let lo = 0, hi = it.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (it[mid] < t) lo = mid + 1; else hi = mid; } const k = (lo > 0 && Math.abs(it[lo - 1] - t) < Math.abs(it[lo] - t)) ? lo - 1 : lo; return Math.abs(it[k] - t) <= 2500 ? ih[k] : null; };
  let best = null;
  for (let off = -maxLagSec; off <= maxLagSec; off += stepSec) {
    let sum = 0, n = 0;
    for (const [t, h] of pts) { const v = at(t - off * 1000); if (v == null) continue; sum += Math.abs(h - v); n++; }
    if (n < 60) continue; const mad = sum / n;
    if (!best || mad < best.mad) best = { offsetMs: off * 1000, mad, n };
  }
  if (!best) return { offsetMs: 0, mad: NaN, n: 0, ok: false };
  return { ...best, ok: best.mad < 2.5 };
}

/** SmO2 breakpoints from stage means vs speed (2 breakpoints when ≥6 stages, else 1). */
export function smo2Breakpoints(rows) {
  const valid = rows.filter(r => Number.isFinite(r.smo2) && Number.isFinite(r.speed));
  const res = { bp1: null, bp2: null, points: valid.length, note: '', slopes: valid.map(r => ({ speed: r.speed, slope: r.smo2Slope })) };
  if (valid.length < 4) { res.note = 'need ≥4 stages with SmO2'; return res; }
  const xs = valid.map(r => r.speed), ys = valid.map(r => r.smo2);
  const hrAt = x => interp(xs, valid.map(r => r.hr), x);
  const fit = piecewise(xs, ys, valid.length >= 6 ? 2 : 1);
  if (!fit) { res.note = 'fit failed'; return res; }
  res.fit = { improvement: fit.improvement, slopes: fit.co };
  if (fit.ks.length === 2) { res.bp1 = { speed: fit.ks[0], hr: hrAt(fit.ks[0]) }; res.bp2 = { speed: fit.ks[1], hr: hrAt(fit.ks[1]) }; }
  else { res.bp2 = { speed: fit.ks[0], hr: hrAt(fit.ks[0]) }; res.note = 'single breakpoint (fewer than 6 stages) reported as BP2'; }
  // steady-state marker: first stage whose last-2-min SmO2 slope is below -0.5 %/min
  const unsteady = valid.find(r => Number.isFinite(r.smo2Slope) && r.smo2Slope < -0.5);
  if (unsteady) res.firstUnsteady = { speed: unsteady.speed, hr: unsteady.hr, slope: unsteady.smo2Slope };
  if (fit.improvement < 0.3) res.note += (res.note ? '; ' : '') + 'weak breakpoint evidence';
  return res;
}

/** Agreement label between two HR values. */
export function agreement(hrA, hrB) {
  if (!Number.isFinite(hrA) || !Number.isFinite(hrB)) return { label: 'n/a', diff: NaN };
  const d = Math.abs(hrA - hrB);
  return { label: d <= 5 ? 'agree' : d <= 10 ? 'caution' : 'disagree', diff: d };
}

/**
 * Triangulate LT1/LT2 from lactate (anchor), HRVT and SmO2.
 * Returns consensus thresholds {lt1:{hr,speed,source}, lt2:{...}}, agreement table and grade A/B/C.
 */
export function triangulate({ lactate, hrv, smo2, stageCount = 0 }) {
  const pick = (lac, hrvt, bp) => {
    const cands = [];
    if (lac && Number.isFinite(lac.hr)) cands.push({ src: 'lactate', hr: lac.hr, speed: lac.x });
    if (hrvt && Number.isFinite(hrvt.hr)) cands.push({ src: 'hrv', hr: hrvt.hr, speed: hrvt.speed });
    if (bp && Number.isFinite(bp.hr)) cands.push({ src: 'smo2', hr: bp.hr, speed: bp.speed });
    if (!cands.length) return null;
    const anchor = cands.find(c => c.src === 'lactate') || cands.find(c => c.src === 'hrv') || cands[0];
    const others = cands.filter(c => c !== anchor).map(c => ({ ...c, ...agreement(anchor.hr, c.hr) }));
    // consensus: if lactate anchor exists use it; else average of agreeing non-lactate methods
    let hr = anchor.hr, speed = anchor.speed, source = anchor.src;
    if (anchor.src !== 'lactate' && others.length && others.every(o => o.label === 'agree')) {
      hr = mean([anchor.hr, ...others.map(o => o.hr)]); speed = mean([anchor.speed, ...others.map(o => o.speed)].filter(isFinite)); source = 'hrv+smo2';
    }
    return { hr, speed, source, anchor, others };
  };
  const lt1 = pick(lactate?.lt1Primary, hrv?.hrvt1, smo2?.bp1);
  const lt2 = pick(lactate?.lt2Primary, hrv?.hrvt2, smo2?.bp2);
  const gradeOf = (t) => {
    if (!t) return '-';
    const hasLac = t.anchor.src === 'lactate';
    const agree = t.others.filter(o => o.label === 'agree').length, dis = t.others.filter(o => o.label === 'disagree').length;
    if (hasLac && stageCount >= 6 && agree >= 1 && dis === 0) return 'A';
    if (hasLac && (dis === 0 || agree >= 1)) return 'B';
    if (!hasLac && agree >= 1 && dis === 0) return 'B';
    return 'C';
  };
  return { lt1, lt2, grade1: gradeOf(lt1), grade2: gradeOf(lt2) };
}

/** Convenience: run the full analysis on a session object. */
export function analyzeSession(session) {
  const rows = summarizeStages(session);
  const lacStages = rows.filter(r => Number.isFinite(r.lactate)).map(r => ({ x: r.speed, la: r.lactate, hr: r.hr }));
  const lactate = lacStages.length >= 3 ? analyzeLactate(lacStages) : null;
  const hrv = hrvThresholds(rows);
  const smo2 = smo2Breakpoints(rows);
  const tri = triangulate({ lactate, hrv, smo2, stageCount: rows.length });
  return { rows, lactate, hrv, smo2, tri };
}

// Stage summaries, HRV thresholds (DFA a1 0.75 / 0.5), SmO2 breakpoints and triangulation.
import { analyzeLactate, interp } from './lactate.js';

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
/** The entries of a stored list that can be read (a damaged record may hold nulls, or something that is not a list at all). */
export const list = x => Array.isArray(x) ? (x.every(v => v != null && typeof v === 'object') ? x : x.filter(v => v != null && typeof v === 'object')) : [];
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
  const smo = session.smo2 && session.smo2.series ? list(session.smo2.series) : null;
  const off = session.smo2 ? (session.smo2.offsetMs || 0) : 0;
  const out = [];
  for (const st of session.stages || []) {
    if (!Number.isFinite(st.tEnd) || !Number.isFinite(st.tStart)) continue;
    const w0 = Math.max(st.tStart, st.tEnd - a1WindowSec * 1000), w1 = st.tEnd;
    const f = feats.filter(p => p.t >= w0 && p.t <= w1 && Number.isFinite(p.alpha1));
    const fh = feats.filter(p => p.t >= w0 && p.t <= w1 && Number.isFinite(p.hr));
    // Prefer the strap's own HR (1 Hz) averaged over the window; fall back to the 2-min windowed HR of the features
    let hr = NaN;
    if (list(session.hrLive).length) { const h = list(session.hrLive).filter(p => p[0] >= w0 && p[0] <= w1 && p[1] > 0).map(p => p[1]); hr = mean(h); }
    if (!Number.isFinite(hr)) hr = mean(fh.map(p => p.hr));
    const row = {
      idx: st.idx, speed: st.speed, incline: st.incline, lactate: st.lactate, rpe: st.rpe,
      durationSec: (st.tEnd - st.tStart) / 1000,
      hr, alpha1: mean(f.map(p => p.alpha1)), alpha1n: f.length,
      artifactPct: mean(fh.map(p => p.artifactPct)),
      smo2: NaN, smo2Slope: NaN, thb: NaN,
    };
    if (smo && smo.length) {
      const s0 = st.tEnd - smo2WindowSec * 1000;
      const seg = smo.filter(p => p[0] + off >= s0 && p[0] + off <= st.tEnd);
      row.smo2 = mean(seg.map(p => p[1])); row.thb = mean(seg.map(p => p[2]).filter(isFinite));
      const s2 = smo.filter(p => p[0] + off >= st.tEnd - 120000 && p[0] + off <= st.tEnd);
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

// ---------- Where the running stopped (verification card) ----------
// A session is recorded until 종료 is pressed, but the run a lactate sample belongs to ends earlier: the belt stops, the finger is
// pricked, the value is typed, and often a cool-down follows. Everything "at the end of the run" — last-5-min heart rate and α1,
// drift, the SmO2 end slope, which sample is the end sample — has to be measured from where the running stopped.
// The rule of this code: a stop is inferred only where something was logged (a lactate entry, Pause, the rep clock of an LT2
// session); the heart rate is used to time it, because it leaves its level a few seconds after the belt stops. Where nothing was
// logged the end is merely estimated, and then nothing is concluded from it (sure = false).
const median = a => { const n = a.length; if (!n) return NaN; const s = Float64Array.from(a).sort(); const m = n >> 1; return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Paused stretches [from, to] in ms, from the pause / resume events; a pause still open at the end closes there. */
export function pauseIntervals(session) {
  const ev = list(session.events).filter(e => (e.type === 'pause' || e.type === 'resume' || e.type === 'stop') && Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
  const out = []; let from = null;
  for (const e of ev) { if (e.type === 'pause') { if (from == null) from = e.t; } else if (from != null) { if (e.t > from) out.push([from, e.t]); from = null; } }
  if (from != null) { const hl = list(session.hrLive); const end = session.endedAt || (hl.length ? hl[hl.length - 1][0] : from); if (end > from) out.push([from, end]); }
  return out;
}

export const RUN_END = {
  bandBpm: 5,      // "still at its level": the last 10 s within this of the median of the 2 min before …
  tightBpm: 2,     // … "really at it": within this
  sinkBpm: 4,      // …and the second minute of those two not this far below the first (that would be a slope, not a level)
  dropBpm: 10,     // a stop: afterwards the heart rate gets at least this far below that level …
  fastBpm: 8,      // … and the minute that follows (from 30 s on) lies this far below it (a slow downward slide is not a stop)
  backBpm: 5,      // running resumed: a whole minute back within this of the level …
  settleBpm: 3,    // … and the stop is over once the heart rate itself is within this of it
  climbBpm: 8,     // a level this far below an earlier one, or below the run so far, is not the run (walked first, then stood)
  stepBpm: 6,      // a surge begins with a step up of at least this within a minute
  reboundBpm: 15,  // between two values typed after one stop the heart rate came up this far again: the running had been taken up …
  resumeBpm: 8,    // … to within this of the level it stopped from (less: a walk or a cool-down jog)
  heldMs: 600000,  // a heart rate held within 2 × climbBpm of the level for this long after a stop: the running went on (at a lower speed)
  stepMs: 5000, levelMs: 120000, scanMs: 720000, afterMs: 90000,
  stepDownMs: 180000, // two steps down further apart than this: a cool-down, or running on at a lower speed? → shown, not relied on
  assocMs: 300000, // a value typed later than this after a stop was over does not belong to that stop
  runOnMs: 300000, // the last sample's stop still ends the run when no more than this much running followed it
  lateMs: 360000,  // a value typed later than this after the stop it points to: the stop is shown, but not relied on
  shallowMs: 120000, deepBpm: 25, // … and likewise when the value comes this long after the stop without the heart rate having been this far below the level (standing brings it there; a slower pace does not)
  lagMs: 15000,    // an end timed by the heart rate is up to this late (the heart rate needs some seconds to leave its level)
};

function hrSeries(session) {
  let src = list(session.hrLive).filter(p => p && p[1] > 0 && Number.isFinite(p[0]));
  for (let i = 1; i < src.length; i++) if (src[i][0] < src[i - 1][0]) { src.sort((a, b) => a[0] - b[0]); break; }
  // A file with a value only every few seconds (a watch on "smart recording") is filled in to one a second, because the rules below
  // count seconds; a gap of more than a minute stays a gap. A live recording (a value a second, or one per beat) is taken as it is.
  if (src.length > 2) {
    const d = new Float64Array(src.length - 1); for (let i = 1; i < src.length; i++) d[i - 1] = src[i][0] - src[i - 1][0];
    if (median(d) > 1500) {
      const out = [];
      for (let i = 0; i < src.length; i++) {
        out.push(src[i]); if (i + 1 === src.length) break;
        const g = src[i + 1][0] - src[i][0]; if (g > 1500 && g <= 60000) for (let t = src[i][0] + 1000; t < src[i + 1][0] - 400; t += 1000) out.push([t, src[i][1] + (src[i + 1][1] - src[i][1]) * (t - src[i][0]) / g]);
      }
      src = out;
    }
  }
  const n = src.length; const T = new Float64Array(n), V = new Float64Array(n); for (let i = 0; i < n; i++) { T[i] = src[i][0]; V[i] = src[i][1]; }
  const lb = t => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < t) lo = m + 1; else hi = m; } return lo; }; // first sample at or after t
  /** Median of the samples with a ≤ t < b; NaN when there are fewer than minN. */
  const med = (a, b, minN) => { const i = lb(a), j = lb(b); const k = j - i; if (k < minN) return NaN; const w = V.slice(i, j).sort(); const m = k >> 1; return k % 2 ? w[m] : (w[m - 1] + w[m]) / 2; };
  /**
   * When was the heart rate back at `ref`? From `from` on: the first whole minute (inside the recording, ≥ 20 samples) of which at
   * least half lies within backBpm of ref; from its start on, the first moment the heart rate itself is within settleBpm (the first
   * seconds of that minute are still on the way up). null: never — the running did not resume.
   */
  const backAt = (from, tEnd, ref) => {
    if (!n || !Number.isFinite(from)) return null;
    const R = RUN_END; const x = ref - R.backBpm; const i0 = lb(from); const C = new Int32Array(n - i0 + 1); for (let i = i0; i < n; i++) C[i - i0 + 1] = C[i - i0] + (V[i] >= x ? 1 : 0);
    const uEnd = Math.min(tEnd, T[n - 1] + 60000); // (no minute after the last sample can hold any)
    for (let u = from; u + 60000 <= uEnd; u += R.stepMs) {
      const i = lb(u), j = lb(u + 60000); const k = j - i;
      if (k === 0) { if (i >= n) break; u = Math.max(u, T[i] - 59000) - R.stepMs; continue; } // a hole in the data (strap off, a clock jump): skip to its far side
      if (k < 20 || 2 * (C[j - i0] - C[i - i0]) < k) continue;
      if (med(u + 30000, u + 60000, 8) < med(u, u + 30000, 8) - R.sinkBpm) continue; // falling through the level on the way down is not being back at it
      let v = u; while (v < u + 60000 && !(med(v - 10000, v + 10000, 5) >= ref - R.settleBpm)) v += R.stepMs;
      return Math.min(v, tEnd);
    }
    return null;
  };
  return { T, V, n, med, backAt };
}

/**
 * The stop that goes with something logged at tA (a lactate entry, Pause).
 * A candidate is a moment, at most scanMs before tA, at which the heart rate was still at its level (the last 10 s within bandBpm
 * of the median of the 2 min before, and that level not already sinking) while, between there and tA (+90 s), it got dropBpm below
 * the level, the minute that followed lying fastBpm below it. The latest candidate is the stop, unless the level it stands on was
 * itself reached by such a drop from a level climbBpm higher, with no return in between (walked first, then stood): then the earlier
 * one is — if less than stepDownMs lies between them, without question; otherwise the picture has two readings (a cool-down, or
 * running on at a lower speed?) and the result is marked twoStep. A higher level that was only a surge, after which the running went
 * on at the level before it, is not taken for the run.
 * With nothing logged (tA = the end of the recording, anyLevel = true) there is no place to start from: the latest candidate counts,
 * unless an earlier one stands clearly higher, and only if the heart rate never came back (after a surge: back to the level before it).
 * → { stopT, level, troughT, backT, lowLevel?, twoStep? } or null. backT: when the heart rate was back at the level (null = the
 * running did not resume). lowLevel: the stop was found only at a level well below the run so far.
 */
function stopBefore(H, tA, tRec, tMin, scanMs = RUN_END.scanMs, anyLevel = false) {
  const R = RUN_END; const step = R.stepMs;
  if (!H.n || !Number.isFinite(tA) || !Number.isFinite(tRec) || !Number.isFinite(tMin)) return null;
  // the grid: tA + k·step, from 90 s after the anchor (inside the recording) back to the scan limit — and nowhere outside the heart-rate
  // data (a record whose clock times lie far apart from its samples must not be walked through 5 s at a time); m[k] = median of the 20 s before it
  const kHi = Math.min(Math.max(0, Math.min(Math.floor(R.afterMs / step), Math.floor((tRec - tA) / step))), Math.ceil((H.T[H.n - 1] + 20000 - tA) / step));
  const kLo = -Math.floor((tA - Math.max(tMin, tA - scanMs, H.T[0])) / step);
  if (!(kLo <= 0) || !Number.isFinite(kLo) || kHi < kLo) return null;
  const m = new Float64Array(kHi - kLo + 1); const at = k => tA + k * step;
  for (let k = kLo; k <= kHi; k++) m[k - kLo] = H.med(at(k) - 20000, at(k) + 1, 5);
  let lo = Infinity, loT = null; const see = k => { const v = m[k - kLo]; if (v < lo) { lo = v; loT = at(k); } };
  for (let k = kHi; k > 0; k--) see(k);
  const all = []; // candidates, the latest first
  for (let k = Math.min(0, kHi); k >= kLo; k--) {
    see(k); const s = at(k);
    const last = H.med(s - 10000, s + 1, 3);
    if (!(last >= lo + R.dropBpm - R.bandBpm)) continue; // cannot be both at a level and dropBpm above the lowest point (saves the medians below for most of a tail)
    const level = H.med(s - R.levelMs, s - 10000, 30);
    if (!(last >= level - R.bandBpm)) continue;   // falling already, or no data
    if (!(level - lo >= R.dropBpm)) continue;     // nothing between here and the anchor is far enough below
    if (H.med(s - 65000, s - 10000, 15) < H.med(s - R.levelMs, s - 65000, 15) - R.sinkBpm) continue; // the "level" is a slope: this is inside a decline
    const after = H.med(s + 30000, Math.min(s + 90000, tRec) + 1, 5); // the minute that follows (what there is of it; nothing yet → the drop above has to do)
    if (Number.isFinite(after) && !(after <= level - R.fastBpm)) continue; // a slow slide or a blip, not a stop
    all.push({ k, stopT: s, level, lo, troughT: loT, gap: level - last });
  }
  if (!all.length) return null;
  // A slow decline (slowed to a jog) keeps the heart rate inside the band for half a minute: of the candidates on the same level in
  // the minute before the chosen one, the latest that is really at the level (tightBpm) is the better time.
  const tight = c => all.find(x => x.stopT <= c.stopT && x.stopT >= c.stopT - 60000 && Math.abs(x.level - c.level) <= R.settleBpm && x.gap <= R.tightBpm) || c;
  // Was the level held up to time t a surge? It was if it lies climbBpm above the run up to there (its median from minute 3 on) and was
  // reached by a step up within the last 8 min (the minute after stepBpm above the 2.5 min before; the slow upward drift of a long
  // run is no step, and neither is its start). Then → the level of the run it rose from; otherwise null.
  const surgeFrom = (t, level) => {
    const body = H.med(tMin + 180000, t - 10000, 60); if (!(level - body >= R.climbBpm)) return null;
    for (let u = t - 60000; u >= t - 480000; u -= 30000) { const a = H.med(u - 150000, u, 40); if (level - a >= R.climbBpm && H.med(u, u + 60000, 15) - a >= R.stepBpm) return body; }
    return null;
  };
  const surgeBase = c => { if (c.base === undefined) c.base = surgeFrom(c.stopT, c.level); return c.base; };
  if (anyLevel) {
    for (let i = all.length - 1; i >= 0; i--) if (all[i].stopT < tMin + 480000) all.splice(i, 1); // the first minutes (warm-up, a dry strap reading high) do not make an end
    if (!all.length) return null;
    const latest = all[0]; const top = surgeBase(latest) ?? latest.level; // the level the latest drop left from (a surge: the level it rose from)
    for (let tries = 0; all.length && tries < 60; tries++) {
      let best = all[0]; for (const c of all) if (c.level >= best.level + R.bandBpm) best = c;
      const pick = tight(best); const ref = surgeBase(pick) ?? pick.level;
      // the end of the run only if the heart rate stayed down: the rest of the recording lies fastBpm below (a wander back and forth does
      // not), and it never came back for a whole minute (after a surge: back to the level before it — then the running simply went on)
      if (H.med(pick.stopT + 30000, tRec + 1, 5) <= ref - R.fastBpm && H.backAt(pick.stopT + 30000, tRec, ref) == null) return { ...pick, backT: null };
      for (let i = all.length - 1; i >= 0; i--) if (Math.abs(all[i].stopT - best.stopT) <= 120000) all.splice(i, 1); // the others of the same drop say the same
    }
    return { none: true, top }; // there were drops, but none of them ended the run — the caller must not take the end of the recording for certain
  }
  // (the end of a surge after which the running went on at the old level — the heart rate never got dropBpm below that — is no stop at all)
  let cur = all.find(c => { const base = surgeBase(c); return base == null || base - c.lo >= R.dropBpm; }), twoStep = false; if (!cur) return null;
  for (;;) {
    const up = all.find(c => c.stopT < cur.stopT && c.level >= cur.level + R.climbBpm); if (!up) break;
    let peak = -Infinity; for (let k = up.k + 18; k <= cur.k; k++) { const v = m[k - kLo]; if (v > peak) peak = v; } // from 90 s after `up` (a slow step down needs that long to get clear of the level)
    if (peak >= up.level - R.backBpm) break;      // in between the heart rate was back up there: `up` was an earlier stop of its own, not the top of a staircase
    const base = surgeBase(up);
    if (base != null && Math.abs(cur.level - base) <= R.climbBpm) break; // `up` ended a surge, and the running went on at the level before it
    if (cur.stopT - up.stopT > R.stepDownMs) { twoStep = true; if (base != null) break; }
    cur = up;
  }
  cur = tight(cur);
  // Was the level it stopped from the level of the run? Not if it lies climbBpm below the run so far — or below a level held within
  // the scan range before it (slowed down by degrees, with no step to find), unless that higher level was itself only a surge.
  const body = H.med(tMin + 180000, cur.stopT - 10000, 60);
  let top = -Infinity, topT = null; for (let t = cur.stopT; t >= Math.max(tMin + R.levelMs, cur.stopT - scanMs); t -= 30000) { const v = H.med(t - R.levelMs, t, 30); if (v > top) { top = v; topT = t; } }
  const lowLevel = cur.level < body - R.climbBpm || (top - cur.level >= R.climbBpm && surgeFrom(topT, top) == null);
  return { ...cur, twoStep, lowLevel, backT: H.backAt(cur.troughT, tRec, cur.level) };
}
/**
 * Two values typed after the same stop are two fingers — unless the running was taken up again in between (a run given up a minute
 * or two after the 10-min sample). Then the heart rate came up from its lowest point by reboundBpm or more and fell again, and the
 * later value has a stop of its own: where that rise ended. → a stop like stopBefore's; { running, peakT } when the heart rate came
 * up but not down again; null for two fingers.
 */
function reboundStop(H, ep, tFrom, tTo, tRec) {
  const R = RUN_END; const pts = [];
  for (let s = ep.stopT; s <= Math.min(tTo + R.afterMs, tRec); s += R.stepMs) { const v = H.med(s - 20000, s + 1, 5); if (Number.isFinite(v)) pts.push([s, v]); }
  let lo = null; for (const p of pts) if (p[0] <= tTo && (!lo || p[1] < lo[1])) lo = p;                                    // the lowest point before the later value …
  if (!lo) return null;
  let hi = null; for (const p of pts) if (p[0] > Math.max(lo[0], tFrom) && p[0] <= tTo && (!hi || p[1] >= hi[1])) hi = p; // … the highest after it …
  if (!hi || hi[1] - lo[1] < R.reboundBpm) return null;
  // Up again, but well below the run: a walk or a cool-down jog — unless the heart rate was still climbing when it turned (a minute or so of
  // running taken up again does not get it back to the level; a walk or a jog levels off below it, or lasts longer than that).
  if (Number.isFinite(ep.level) && hi[1] < ep.level - R.resumeBpm) { const before = pts.find(p => p[0] >= hi[0] - 60000); if (hi[1] < ep.level - 2.5 * R.resumeBpm || hi[0] - lo[0] > 90000 || !before || hi[1] - before[1] < R.bandBpm) return null; }
  let lo2 = null; for (const p of pts) if (p[0] > hi[0] && (!lo2 || p[1] < lo2[1])) lo2 = p;                             // … and down again?
  const stopT = Math.max(lo[0], hi[0] - 10000); // (the 20-s median peaks some 10 s after the heart rate does)
  if (!lo2 || hi[1] - lo2[1] < R.bandBpm) return { running: true, peakT: hi[0] }; // not (yet): the value was typed while running again, or in the first seconds after stopping
  return { stopT, level: hi[1], lo: lo2[1], troughT: lo2[0], backT: H.backAt(lo2[0], tRec, hi[1]), rebound: true };
}

const tlCache = new WeakMap(); // session object → { sig, tl }
const tlById = new Map();      // session id → the same, for the screens that read the sessions afresh from storage on every visit
/**
 * The timeline of a non-test session:
 *   start   – where the run began (the session start; for an LT2 session the first / the last work phase)
 *   end     – where the running stopped; how = 'sample' (heart-rate drop before a lactate entry) | 'pause' | 'manual' (session.runEndSec)
 *             | 'phase' (rep clock of an LT2 session) | 'finish' (the recording ends at the running level) | 'hr' (estimate, nothing logged)
 *   sure    – false: the end is shown but nothing is concluded from it. why = 'no-entry' (how = 'hr': nothing was logged around it),
 *             'two-steps' (the heart rate stepped down twice, minutes apart, before the value was typed), 'late-entry' (a value
 *             was typed long after the stop), 'shallow' (minutes after it the heart rate was still not far down: slowed, not
 *             stopped?), 'level' (the stop was found only at a level below the run), 'error' (the record could not be worked out)
 *   stops   – [from, to, resumed] stops inside the run (for a sample, or a Pause the heart rate confirms): from where the heart rate left
 *             its level, to where it was back at it; resumed = its lowest point, about where the running began again
 *   samples – the lactate values logged during the session with their role: 'rest' | 'mid' | 'end'
 *   bouts   – work phases of an LT2 session (1 otherwise; 0 = ended in the warm-up; 2+ = intervals)
 *   lagMs   – how late `end` may be (a heart-rate-timed end: the heart rate needs some seconds to leave its level)
 */
export function runTimeline(session) {
  const hl = list(session.hrLive);
  const ev = list(session.events); const mid = hl.length ? hl[hl.length >> 1] : null, lastHr = hl.length ? hl[hl.length - 1] : null, lastEv = ev.length ? ev[ev.length - 1] : null;
  const sig = `${session.type}|${session.startedAt}|${session.endedAt}|${hl.length}|${mid ? mid[0] + ':' + mid[1] : ''}|${lastHr ? lastHr[0] + ':' + lastHr[1] : ''}|${ev.length}|${lastEv ? lastEv.t + ':' + lastEv.type + ':' + (lastEv.value ?? '') : ''}|${typeof session.runEndSec}:${session.runEndSec ?? ''}`;
  const hit = tlCache.get(session); if (hit && hit.sig === sig) return hit.tl;
  const id = session.id; const kept = id != null ? tlById.get(id) : null;
  let entry = kept && kept.sig === sig ? kept : null;
  if (!entry) {
    let tl;
    // Home, the session list and the session screen all come through here: one record this code did not foresee must not take them down.
    try { tl = buildTimeline(session); } catch (e) { console.error('runTimeline: could not work out where the run ended', e); tl = plainTimeline(session); }
    entry = { sig, tl };
  }
  tlCache.set(session, entry); if (id != null) { tlById.delete(id); tlById.set(id, entry); if (tlById.size > 300) tlById.delete(tlById.keys().next().value); }
  return entry.tl;
}
/** What is left when the timeline cannot be worked out: the recording as it is, with nothing concluded from it (why = 'error') — unless the end was typed by hand. */
function plainTimeline(session) {
  const ev = Array.isArray(session.events) ? session.events : [], hl = Array.isArray(session.hrLive) ? session.hrLive : [];
  let first = null, last = null; for (const p of hl) if (p && Number.isFinite(p[0])) { if (first == null) first = p[0]; last = p[0]; }
  const t0 = Number.isFinite(session.startedAt) ? session.startedAt : (first ?? 0); const tRec = session.endedAt || (last ?? t0);
  const manual = Number.isFinite(session.runEndSec) ? t0 + session.runEndSec * 1000 : null; const byHand = manual != null && manual > t0 && manual <= tRec + 1000;
  const end = byHand ? Math.min(manual, tRec) : tRec; const dur = (tRec - t0) / 1000; const samples = [];
  for (const e of ev) { if (!e || e.type !== 'lactate' || !Number.isFinite(e.t) || !Number.isFinite(e.value)) continue; const rel = (e.t - t0) / 1000; samples.push({ t: e.t, value: e.value, role: rel <= 240 ? 'rest' : (rel >= dur - 300 || rel >= dur * 0.85) ? 'end' : 'mid' }); }
  samples.sort((a, b) => a.t - b.t);
  return { t0, tRec, start: t0, end, how: byHand ? 'manual' : 'finish', sure: byHand, why: byHand ? null : 'error', bouts: session.type === 'lt2' ? 2 : 1, stops: [], samples, lagMs: 0, tailSec: Math.max(0, (tRec - end) / 1000), entryT: null };
}
function buildTimeline(session) {
  const R = RUN_END; const H = hrSeries(session); const ev = list(session.events);
  const t0 = Number.isFinite(session.startedAt) ? session.startedAt : (H.n ? H.T[0] : 0);
  const tRec = session.endedAt || (H.n ? H.T[H.n - 1] : t0);
  // LT2 sessions: the work phases the engine logged
  let start = t0, firstWork = t0, phaseEnd = null, bouts = 1;
  if (session.type === 'lt2') {
    const ph = ev.filter(e => e.type === 'phase' && Number.isFinite(e.t)).sort((a, b) => a.t - b.t); const work = [];
    for (let i = 0; i < ph.length; i++) if (ph[i].phase === 'work') work.push([ph[i].t, ph[i + 1] ? ph[i + 1].t : tRec]);
    if (!ph.length) bouts = 2;            // no phase log (hand-made record): warm-up, reps and rests cannot be told apart → never one steady run
    else if (!work.length) bouts = 0;     // ended in the warm-up
    else { bouts = work.length; firstWork = work[0][0]; start = work[work.length - 1][0]; phaseEnd = work[work.length - 1][1]; }
  }
  const restLimit = Math.max(t0 + 240000, firstWork);
  const lac = ev.filter(e => e.type === 'lactate' && Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
  // 1) the stops that something logged points to
  const eps = []; const near = (t, tolMs) => eps.find(o => Math.abs(o.stopT - t) <= tolMs);
  for (const e of lac) {
    if (e.t <= restLimit) continue;
    let ep = stopBefore(H, e.t, tRec, start);
    if (ep && ep.backT != null && e.t - ep.backT > R.assocMs) ep = null; // that stop was over long before this value was typed: not this value's stop
    if (!ep) continue;
    const same = near(ep.stopT, 30000);
    if (!same) { eps.push({ ...ep, src: 'sample', events: [e] }); continue; }
    const rb = reboundStop(H, same, same.events.length ? same.events[same.events.length - 1].t : same.stopT, e.t, tRec); // a second finger, or typed after running again?
    if (!rb) { same.events.push(e); if (ep.twoStep) same.twoStep = true; } // (the later value sees more of the picture: a second step down after the first value)
    else if (rb.running) { same.ranOn = true; if (same.backT == null) same.backT = rb.peakT; } // no stop of its own (yet): this value goes by the clock, and `same` did not end the run
    else { const own = near(rb.stopT, 30000); if (own) own.events.push(e); else eps.push({ ...rb, src: 'sample', events: [e] }); }
  }
  for (const p of pauseIntervals(session)) {
    const open = p[1] >= tRec - 1000; // Finish was pressed while paused
    let ep = p[0] > start ? stopBefore(H, Math.min(p[1], p[0] + 120000), tRec, start) : null;
    if (ep && ep.backT != null && ep.backT < p[0] - 60000) ep = null;        // a stop that was over before the Pause is not this Pause's
    if (!ep && open && tRec - p[0] <= 90000) ep = { stopT: p[0], level: NaN, troughT: p[0], backT: null }; // Pause, then Finish within moments: too soon for the heart rate to show the stop
    if (!ep) continue; // a Pause the heart rate does not confirm is not a stop (touched by accident, or the app was paused while the running went on)
    const byPause = Math.abs(ep.stopT - p[0]) <= 60000 && p[0] <= ep.stopT; // Pause was pressed at the stop: its time is exact, the heart rate lags a few seconds
    if (byPause) ep = { ...ep, stopT: p[0], exact: true };
    ep = { ...ep, markT: p[0] };
    const same = near(ep.stopT, 60000);
    if (same) { if (ep.stopT < same.stopT || (byPause && ep.stopT === same.stopT)) { same.stopT = ep.stopT; if (byPause) { same.src = 'pause'; same.exact = true; } } if (same.markT == null) same.markT = p[0]; }
    else eps.push({ ...ep, src: 'pause', events: [] });
  }
  eps.sort((a, b) => a.stopT - b.stopT);
  for (let i = 0; i < eps.length - 1; i++) if (eps[i].backT == null || eps[i].backT > eps[i + 1].stopT) {
    // not back at the old level before the next stop: the running went on at the level the next stop left from (a lower speed after the
    // sample, or simply a lower heart rate) — back once it got there; only if it never did, all of it belongs to the stop
    const nx = eps[i + 1]; const b = Number.isFinite(nx.level) ? H.backAt(eps[i].troughT, nx.stopT, nx.level) : null;
    eps[i].backT = b != null && b < nx.stopT ? b : nx.stopT;
  }
  // The last stop, never back at its level: did the running go on regardless, at a lower level, for minutes (a lower speed after the sample)?
  const heldOn = ep => { if (ep.backT != null || !Number.isFinite(ep.level)) return false; const x = ep.level - 2 * R.climbBpm;
    const from = Math.max(ep.troughT, ...ep.events.map(e => e.t)); // (held after the values were typed: they were typed at a stop, not on the way)
    for (let u = from; u + R.heldMs <= tRec; u += 30000) { const i = H.med(u, u + R.heldMs, 60); if (i >= x && H.med(u, u + 120000, 20) >= x) return true; } return false; };
  // 2) where the run ended
  const last = eps.length ? eps[eps.length - 1] : null;
  const manual = Number.isFinite(session.runEndSec) ? t0 + session.runEndSec * 1000 : null;
  let end = tRec, how = 'finish', sure = true, why = null, final = null;
  if (manual != null && manual > start && manual <= tRec + 1000) { end = Math.min(manual, tRec); how = 'manual'; }
  else if (last && !last.ranOn && !heldOn(last) && (last.backT == null || (tRec - last.backT <= R.runOnMs && !lac.some(e => e.t > last.backT && !last.events.includes(e))))) {
    // (the last stop ended the run if the running did not resume — or resumed for a few minutes at most, with nothing typed after it)
    final = last; end = last.stopT; how = last.src;
    // Relied on only when the picture has one reading: one clear stop, with the value typed soon after it.
    const first = last.events[0]; const markT = first ? first.t : last.markT; // (a stop marked by Pause alone: the moment Pause was pressed)
    if (last.lowLevel) { sure = false; why = 'level'; }                                               // found only at a level below the run
    else if (last.twoStep) { sure = false; why = 'two-steps'; }                                      // two steps down, minutes apart: which one ended the run?
    else if (lac.some(e => Number.isFinite(e.value) && e.t - last.stopT > R.lateMs) || (markT != null && markT - last.stopT > R.lateMs)) { sure = false; why = 'late-entry'; } // marked long after it: a cool-down in between — or running on at a lower speed?
    else if (markT != null && markT - last.stopT >= R.shallowMs && last.level - last.lo < R.deepBpm) { sure = false; why = 'shallow'; } // minutes after it the heart rate has not been far down: slowed, not stopped?
  } else {
    // nothing logged marks the end: does the recording end at the running level?
    const ep = stopBefore(H, tRec, tRec, start, 6 * 3600000, true);
    const tail = ep && !ep.none ? ep.stopT : null;
    if (phaseEnd != null && phaseEnd < tRec - 1000 && !(tail != null && tail < phaseEnd - 20000)) { end = phaseEnd; how = 'phase'; } // the rep clock ended the run (and the heart rate does not say it ended earlier)
    else if (tail != null) { end = tail; how = 'hr'; sure = false; why = 'no-entry'; }
    else if (ep && ep.none && H.med(tRec - 120000, tRec + 1, 30) < ep.top - R.dropBpm) { sure = false; why = 'no-entry'; } // drops that ended nothing, and the recording ends well below the run: its end is not the end of the run
    if (how === 'finish' && sure) { // a value typed near the end, and the recording ends well below where the heart rate was before it: it was typed at a stop the heart rate could not time
      const le = lac.filter(e => Number.isFinite(e.value) && e.t > start + 240000).pop();
      if (le && H.med(le.t - 120000, le.t - 10000, 30) - H.med(tRec - 120000, tRec + 1, 30) >= R.dropBpm) { sure = false; why = 'no-entry'; }
    }
  }
  if (end < start) end = start;
  const stops = eps.filter(o => o.backT != null && o.stopT < end && o.backT > o.stopT).map(o => [o.stopT, Math.min(o.backT, end), Math.min(Math.max(o.troughT, o.stopT), o.backT, end)]);
  // 3) what each logged value is
  // A value typed after the last stop is taken for the end sample also when the time of that stop is not relied on (by the clock, an end
  // value followed minutes later by a recovery value would become a "10-min → end" pair). An end that is only estimated from the heart
  // rate, with nothing logged, files nothing: there the clock of the recording decides, as it always did.
  const endR = sure ? end : tRec; const dur = (endR - t0) / 1000; const tol = how === 'manual' ? 60000 : 0; const samples = [];
  for (const e of lac) {
    if (!Number.isFinite(e.value)) continue;
    const own = eps.find(o => o.events.includes(e)); let role;
    if (e.t <= restLimit) role = 'rest';
    else if ((sure || final) && how !== 'finish' && e.t >= end - tol) role = 'end';  // taken after the running had stopped
    else if (how === 'manual' && own && own.stopT <= end + tol && own.stopT >= end - R.runOnMs) role = 'end'; // the end typed a little after the stop this value belongs to
    else if (own && own !== final) role = 'mid';                                     // its own stop was followed by more running
    else { const rel = (e.t - t0) / 1000; role = (rel >= dur - 300 || rel >= dur * 0.85) ? 'end' : 'mid'; } // no stop of its own: by the clock (last 5 min / 15 % of the run)
    samples.push({ t: e.t, value: e.value, role });
  }
  const lagMs = how === 'hr' || (final && !final.exact) ? R.lagMs : 0; // how late the end may be: nothing for a time that was pressed, typed or logged
  return { t0, tRec, start, end, how, sure, why, bouts, stops, samples, lagMs, tailSec: Math.max(0, (tRec - end) / 1000), entryT: final && final.events.length ? final.events[0].t : null };
}
/** Does a heart-rate value at time t belong to a stop (standing, or still on the way back up to the level)? */
export function inStop(tl, t) { for (const s of tl.stops) if (t > s[0] && t < s[1]) return true; return false; }
/**
 * Does an α1 value stamped t contain beats that were not running? α1 is made of the beats of [t − windowMs, t]: tainted from a stop
 * until windowMs after it, and in the seconds by which a heart-rate-timed stop (or the end of the run) may be late.
 */
export function alphaTainted(tl, t, windowMs) {
  if (t > tl.end - tl.lagMs) return true;
  for (const s of tl.stops) if (t > s[0] - RUN_END.lagMs && t <= s[1] + windowMs) return true;
  return false;
}
/** Start of the window that holds `sec` seconds of running before tl.end (stops are skipped over), not earlier than tl.start. */
export function runWindowStart(tl, sec) {
  let t = tl.end, left = sec * 1000;
  for (let i = tl.stops.length - 1; i >= 0; i--) { const s = tl.stops[i]; if (s[0] >= t) continue; const run = t - Math.min(s[1], t); if (run >= left) return Math.max(tl.start, t - left); left -= run; t = Math.min(t, s[0]); }
  return Math.max(tl.start, t - left);
}
/** End of the window that holds `sec` seconds of running from `from` on (stops are skipped over). It may lie beyond the end of the run. */
export function runWindowEnd(tl, from, sec) {
  let t = from, left = sec * 1000;
  for (const s of tl.stops) { if (s[1] <= t) continue; const run = Math.max(0, s[0] - t); if (run >= left) break; left -= run; t = Math.max(t, s[1]); }
  return t + left;
}
/** Time (ms) inside [a, b] spent standing in the timeline's stops (a Pause counts only where the heart rate confirmed it). */
export function stoppedMs(tl, a, b) { let sum = 0; for (const s of tl.stops) sum += Math.max(0, Math.min(b, s[2]) - Math.max(a, s[0])); return sum; }

/**
 * Constant-load SmO2 steady-state summary (verification / LT1 / LT2 runs):
 * early window (5–10 min) vs last 5 min, end slope (%/min over the last 10 min), THb as contact quality.
 * steady = end slope > −0.3 %/min (SmO2 keeps falling at the end only above the sustainable domain).
 * "End" is the end of the run (runTimeline), not of the recording: SmO2 rebounds within seconds of a stop, and a minute of that
 * rebound inside the window turns a falling end slope into a rising one.
 */
export function smo2Steady(session, { earlyFrom = 300, earlyTo = 600, endSec = 300, slopeSec = 600 } = {}) {
  const smo = list(session.smo2 && session.smo2.series); if (smo.length < 20) return null;
  const off = session.smo2.offsetMs || 0;
  const tl = session.type !== 'test' && list(session.hrLive).length ? runTimeline(session) : null; const one = !!tl && tl.bouts === 1;
  const t0 = one ? tl.start : session.startedAt;
  // An end timed by the heart rate is a few seconds late (the heart rate needs them to leave its level): keep clear of it.
  const t1 = one && tl.how !== 'finish' ? tl.end - tl.lagMs : (session.endedAt || (smo[smo.length - 1][0] + off));
  const stopped = t => { if (one) for (const s of tl.stops) if (t > s[0] && t < s[1] + 60000) return true; return false; }; // a stop and the minute of re-settling after it
  const pts = smo.map(p => [p[0] + off, p[1], p[2]]).filter(p => p[0] >= t0 && p[0] <= t1 && Number.isFinite(p[1]) && !stopped(p[0]));
  if (pts.length < 20) return null;
  const sel = (a, b) => pts.filter(p => p[0] >= a && p[0] < b);
  const early = sel(t0 + earlyFrom * 1000, t0 + earlyTo * 1000), late = sel(t1 - endSec * 1000, t1 + 1), seg = sel(t1 - slopeSec * 1000, t1 + 1);
  const thb = pts.map(p => p[2]).filter(Number.isFinite);
  let lo = Infinity, hi = -Infinity, thbLo = Infinity; for (const p of pts) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; } for (const v of thb) if (v < thbLo) thbLo = v; // (a 10-Hz export of a long run is too many values for Math.min(...))
  const res = { n: pts.length, coverageSec: (pts[pts.length - 1][0] - pts[0][0]) / 1000, earlyMean: mean(early.map(p => p[1])), endMean: mean(late.map(p => p[1])), min: lo, max: hi, thbMean: mean(thb), thbMin: thb.length ? thbLo : NaN, slopeEnd: NaN, drift: NaN, steady: null, contact: null };
  if (seg.length > 10) res.slopeEnd = linreg(seg.map(p => (p[0] - t1) / 60000), seg.map(p => p[1])).b;
  if (Number.isFinite(res.earlyMean) && Number.isFinite(res.endMean)) res.drift = res.endMean - res.earlyMean;
  if (Number.isFinite(res.slopeEnd)) res.steady = res.slopeEnd > -0.3;
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

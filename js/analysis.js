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
  const out = [];
  for (const st of session.stages || []) {
    if (!Number.isFinite(st.tEnd) || !Number.isFinite(st.tStart)) continue;
    const w0 = Math.max(st.tStart, st.tEnd - a1WindowSec * 1000), w1 = st.tEnd;
    const f = feats.filter(p => p.t >= w0 && p.t <= w1 && Number.isFinite(p.alpha1));
    const fh = feats.filter(p => p.t >= w0 && p.t <= w1 && Number.isFinite(p.hr));
    // Prefer the strap's own HR (1 Hz) averaged over the window; fall back to the 2-min windowed HR of the features
    let hr = NaN;
    if (session.hrLive && session.hrLive.length) { const h = session.hrLive.filter(p => p[0] >= w0 && p[0] <= w1 && p[1] > 0).map(p => p[1]); hr = mean(h); }
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
      return { speed: a.speed + t * (b.speed - a.speed), hr: a.hr + t * (b.hr - a.hr), how: 'interp' };
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
        const speed = interp(valid.map(r => r.hr), valid.map(r => r.speed), hr);
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

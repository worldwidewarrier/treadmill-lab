// Lactate threshold methods. Input: stages = [{x: intensity (km/h or W), la: mmol/L, hr?: bpm}], ascending x.
// Methods: baseline+Δ (LT1 default), log-log (LT1 secondary), Dmax, Log-Poly-ModDmax (LT2 default), OBLA 2.0/4.0.

// ---------- small linear algebra ----------
function solve(A, b) { // Gaussian elimination with partial pivoting; A is n×n array of arrays
  const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-14) return null;
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}

/** Least-squares polynomial fit (degree d) with x-normalisation; returns evaluator f(x). */
export function polyFit(xs, ys, d) {
  const n = xs.length; if (n < d + 1) d = n - 1;
  const xm = xs.reduce((a, b) => a + b, 0) / n; const xr = Math.max(...xs) - Math.min(...xs) || 1;
  const z = xs.map(x => (x - xm) / xr);
  const A = []; const b = [];
  for (let i = 0; i <= d; i++) {
    A.push([]); for (let j = 0; j <= d; j++) A[i].push(z.reduce((s, v) => s + Math.pow(v, i + j), 0));
    b.push(z.reduce((s, v, k) => s + Math.pow(v, i) * ys[k], 0));
  }
  const c = solve(A, b) || [ys.reduce((a, v) => a + v, 0) / n];
  const f = x => { const t = (x - xm) / xr; let s = 0; for (let i = c.length - 1; i >= 0; i--) s = s * t + c[i]; return s; };
  f.coef = c; f.degree = d;
  return f;
}

function linreg(xs, ys) {
  const n = xs.length; const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxx ? sxy / sxx : 0; const a = my - b * mx;
  let sse = 0; for (let i = 0; i < n; i++) sse += (ys[i] - (a + b * xs[i])) ** 2;
  return { a, b, sse };
}

/** Linear interpolation of y at x over ascending xs (clamped). */
export function interp(xs, ys, x) {
  if (!xs.length) return NaN;
  if (x <= xs[0]) return ys[0]; if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) { const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return ys[i - 1] + t * (ys[i] - ys[i - 1]); }
  return ys[ys.length - 1];
}

/** First x in [x0, x1] where monotone-ish curve f crosses level (dense search + bisection). */
function firstCrossing(f, x0, x1, level, steps = 400) {
  let prevX = x0, prevV = f(x0) - level;
  if (prevV >= 0) return x0;
  for (let i = 1; i <= steps; i++) {
    const x = x0 + (x1 - x0) * i / steps; const v = f(x) - level;
    if (v >= 0) { // bisection
      let lo = prevX, hi = x; for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (f(m) - level >= 0) hi = m; else lo = m; }
      return (lo + hi) / 2;
    }
    prevX = x; prevV = v;
  }
  return NaN;
}

function perpendicularMax(f, xA, yA, xB, yB, steps = 600) {
  // max perpendicular distance from the curve y=f(x) to chord A→B, searched over [xA, xB]
  const dx = xB - xA, dy = yB - yA; const L = Math.hypot(dx, dy) || 1;
  let best = -Infinity, bx = NaN;
  for (let i = 0; i <= steps; i++) {
    const x = xA + dx * i / steps; const y = f(x);
    const d = ((x - xA) * dy - (y - yA) * dx) / L; // signed; positive when the curve lies below the chord
    if (d > best) { best = d; bx = x; }
  }
  return { x: bx, d: best };
}

// ---------- methods ----------
export function lactateCurve(stages) {
  const xs = stages.map(s => s.x), ys = stages.map(s => s.la);
  const d = xs.length >= 5 ? 3 : (xs.length >= 3 ? 2 : 1);
  return polyFit(xs, ys, d);
}

/** LT1: baseline + delta (default 0.5 mmol/L). Baseline = lowest lactate of the exercise stages. */
export function lt1Baseline(stages, delta = 0.5) {
  if (stages.length < 3) return { x: NaN, la: NaN, note: 'need ≥3 stages' };
  const xs = stages.map(s => s.x), ys = stages.map(s => s.la);
  let iMin = 0; for (let i = 1; i < ys.length; i++) if (ys[i] < ys[iMin]) iMin = i;
  const base = ys[iMin]; const level = base + delta;
  const f = lactateCurve(stages);
  let x = firstCrossing(f, xs[iMin], xs[xs.length - 1], level);
  if (!Number.isFinite(x)) { // fall back to piecewise-linear data
    for (let i = iMin + 1; i < ys.length; i++) if (ys[i] >= level) { const t = (level - ys[i - 1]) / (ys[i] - ys[i - 1]); x = xs[i - 1] + t * (xs[i] - xs[i - 1]); break; }
  }
  return { x, la: level, baseline: base };
}

/** Log-log breakpoint (two-segment regression in log La vs log x). */
export function lt1LogLog(stages) {
  const pts = stages.filter(s => s.x > 0 && s.la > 0);
  if (pts.length < 4) return { x: NaN, la: NaN, note: 'need ≥4 stages' };
  const lx = pts.map(p => Math.log(p.x)), ly = pts.map(p => Math.log(p.la));
  let best = null;
  for (let k = 2; k <= pts.length - 2; k++) { // k points in the first segment
    const r1 = linreg(lx.slice(0, k), ly.slice(0, k)); const r2 = linreg(lx.slice(k), ly.slice(k));
    const sse = r1.sse + r2.sse;
    if (!best || sse < best.sse) best = { sse, r1, r2, k };
  }
  const { r1, r2 } = best;
  if (Math.abs(r2.b - r1.b) < 1e-9) return { x: NaN, la: NaN };
  const lxb = (r1.a - r2.a) / (r2.b - r1.b);
  const x = Math.exp(lxb);
  const la = Math.exp(r1.a + r1.b * lxb);
  const xs = pts.map(p => p.x);
  if (x < xs[0] || x > xs[xs.length - 1]) return { x: NaN, la: NaN, note: 'breakpoint outside range' };
  return { x, la };
}

/** Dmax: chord from first to last curve point. */
export function lt2Dmax(stages) {
  if (stages.length < 4) return { x: NaN, la: NaN, note: 'need ≥4 stages' };
  const f = lactateCurve(stages); const xs = stages.map(s => s.x);
  const xA = xs[0], xB = xs[xs.length - 1];
  const r = perpendicularMax(f, xA, f(xA), xB, f(xB));
  return { x: r.x, la: f(r.x) };
}

/** Log-Poly-ModDmax: chord from the log-log LT1 point (on the cubic) to the last point. */
export function lt2ModDmax(stages, startX = null) {
  if (stages.length < 5) return { x: NaN, la: NaN, note: 'need ≥5 stages' };
  const f = lactateCurve(stages); const xs = stages.map(s => s.x);
  let xA = startX;
  if (!Number.isFinite(xA)) { const ll = lt1LogLog(stages); xA = ll.x; }
  if (!Number.isFinite(xA)) { // fallback: first stage with rise > 0.4 above previous
    xA = xs[0]; for (let i = 1; i < stages.length; i++) if (stages[i].la - stages[i - 1].la > 0.4) { xA = xs[i - 1]; break; }
  }
  const xB = xs[xs.length - 1];
  if (!(xB > xA)) return { x: NaN, la: NaN };
  const r = perpendicularMax(f, xA, f(xA), xB, f(xB));
  return { x: r.x, la: f(r.x), start: xA };
}

/** OBLA: first intensity at a fixed lactate level (2.0, 4.0 …). */
export function obla(stages, level = 4) {
  if (stages.length < 3) return { x: NaN, la: level };
  const f = lactateCurve(stages); const xs = stages.map(s => s.x);
  const x = firstCrossing(f, xs[0], xs[xs.length - 1], level);
  return { x, la: level };
}

/** Full lactate analysis: all methods + HR mapping. */
export function analyzeLactate(stages) {
  const st = stages.filter(s => Number.isFinite(s.x) && Number.isFinite(s.la)).sort((a, b) => a.x - b.x);
  const xs = st.map(s => s.x), hrs = st.map(s => s.hr);
  // heart rate at a speed: from the points that have one; where some lack it, only between two that have it (never copied beyond them)
  const fx = xs.filter((_, i) => Number.isFinite(hrs[i])), fh = hrs.filter(h => Number.isFinite(h));
  const hrAt = x => hrs.every(h => Number.isFinite(h)) ? interp(xs, hrs, x) : (fx.length >= 2 && x >= fx[0] && x <= fx[fx.length - 1] ? interp(fx, fh, x) : NaN);
  const wrap = (m, r) => ({ method: m, x: r.x, la: r.la, hr: Number.isFinite(r.x) ? hrAt(r.x) : NaN, note: r.note || '' });
  const ll = lt1LogLog(st);
  const out = {
    stages: st,
    curve: st.length >= 3 ? lactateCurve(st) : null,
    lt1: [wrap('baseline+0.5', lt1Baseline(st, 0.5)), wrap('log-log', ll), wrap('OBLA 2.0', obla(st, 2))],
    lt2: [wrap('Log-Poly-ModDmax', lt2ModDmax(st, ll.x)), wrap('Dmax', lt2Dmax(st)), wrap('OBLA 4.0', obla(st, 4))],
  };
  out.lt1Primary = out.lt1[0]; out.lt2Primary = out.lt2[0];
  out.maxLa = st.length ? Math.max(...st.map(s => s.la)) : NaN;
  out.ok = Number.isFinite(out.lt1Primary.x) || Number.isFinite(out.lt2Primary.x);
  return out;
}

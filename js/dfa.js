// DFA alpha1 engine — FatMaxxer-compatible ("alpha1v2").
// Reference: FatMaxxer MainActivity.java (Apache-2.0, Ian Peake), itself a port of
// Marco Altini's DFA code with Kubios-style smoothness-priors detrending (Tarvainen 2002, lambda=500).
// Pipeline per window:  RR[] -> smoothness priors detrend (lambda) -> cumsum(x-mean)
//   -> fluctuation F(s) over the fixed scale list (forward + backward boxes, linear detrend per box)
//   -> alpha1 = slope of log2 F vs log2 s.

// FatMaxxer's hard-coded scale list (30 entries, 3..15 beats).
export const FATMAXXER_SCALES = [3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 7, 7, 7, 8, 8, 9, 9, 9, 10, 10, 11, 12, 12, 13, 13, 14, 15, 15];
// Strict Peng/Rogers scale list (every integer 4..16) — offered as an alternative.
export const KUBIOS_SCALES = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

/**
 * Smoothness priors detrending: returns x - (I + λ² D2ᵀD2)⁻¹ x  (the stationary component).
 * Solved as a symmetric pentadiagonal system in O(N) (no dense inverse).
 */
export function smoothnessPriors(x, lambda = 500) {
  const n = x.length;
  if (n < 3) return x.slice();
  const l2 = lambda * lambda;
  // Build the pentadiagonal matrix A = I + λ² D2ᵀ D2 (D2 is (n-2)×n second-difference operator).
  // Diagonals: main d0[i], first off d1[i] (A[i][i+1]), second off d2[i] (A[i][i+2]).
  const d0 = new Float64Array(n), d1 = new Float64Array(n), d2 = new Float64Array(n);
  for (let i = 0; i < n; i++) d0[i] = 1;
  // D2ᵀD2 contributions: for each row r of D2 (r = 0..n-3) with entries [1,-2,1] at cols r,r+1,r+2
  for (let r = 0; r <= n - 3; r++) {
    d0[r] += l2 * 1; d0[r + 1] += l2 * 4; d0[r + 2] += l2 * 1;
    d1[r] += l2 * -2; d1[r + 1] += l2 * -2;   // A[r][r+1] += -2, A[r+1][r+2] += -2
    d2[r] += l2 * 1;                           // A[r][r+2] += 1
  }
  // Banded Gaussian elimination for a symmetric pentadiagonal SPD system (no pivoting needed).
  // a = main diagonal, b = first super-diagonal A[i][i+1], c = second super-diagonal A[i][i+2].
  const a = Float64Array.from(d0), b = Float64Array.from(d1), c = Float64Array.from(d2);
  const y = Float64Array.from(x);
  for (let i = 0; i < n; i++) {
    const piv = a[i];
    if (i + 1 < n) {
      const m1 = b[i] / piv;              // multiplier for row i+1 (A[i+1][i] = b[i] by symmetry)
      a[i + 1] -= m1 * b[i];
      if (i + 2 < n) b[i + 1] -= m1 * c[i];
      y[i + 1] -= m1 * y[i];
    }
    if (i + 2 < n) {
      const m2 = c[i] / piv;              // multiplier for row i+2 (A[i+2][i] = c[i])
      a[i + 2] -= m2 * c[i];
      y[i + 2] -= m2 * y[i];
    }
  }
  // Back substitution with U (diagonal a, super-diagonals b, c as left after elimination).
  const u = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    if (i + 1 < n) s -= b[i] * u[i + 1];
    if (i + 2 < n) s -= c[i] * u[i + 2];
    u[i] = s / a[i];
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = x[i] - u[i];
  return out;
}

function linearFitResidualMS(y, offset, len) {
  // least-squares line against x = 0..len-1, returns mean squared residual
  const n = len;
  const xm = (n - 1) / 2;
  let ym = 0;
  for (let i = 0; i < n; i++) ym += y[offset + i];
  ym /= n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { const dx = i - xm; sxy += dx * (y[offset + i] - ym); sxx += dx * dx; }
  const b = sxx ? sxy / sxx : 0;
  const a = ym - b * xm;
  let ss = 0;
  for (let i = 0; i < n; i++) { const r = y[offset + i] - (a + b * i); ss += r * r; }
  return ss / n;
}

/**
 * Core DFA on an already-detrended RR array.
 * @param {number[]} x RR values (ms) — already detrended if desired
 * @param {number[]} scales box sizes
 * @returns {number} alpha
 */
export function dfaAlpha(x, scales = FATMAXXER_SCALES) {
  const n = x.length;
  if (n < 2 * Math.max(...scales)) return NaN;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  const y = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += x[i] - mean; y[i] = acc; }
  const logS = [], logF = [];
  for (const sc of scales) {
    const nb = Math.floor(n / sc);
    if (nb < 1) continue;
    let sumMs = 0;
    // forward boxes
    for (let b = 0; b < nb; b++) sumMs += linearFitResidualMS(y, b * sc, sc);
    // backward boxes aligned to the end
    for (let b = 0; b < nb; b++) sumMs += linearFitResidualMS(y, n - sc - b * sc, sc);
    const F = Math.sqrt(sumMs / (2 * nb));
    logS.push(Math.log2(sc)); logF.push(Math.log2(F));
  }
  // slope of least squares fit
  const m = logS.length;
  let sx = 0, sy = 0;
  for (let i = 0; i < m; i++) { sx += logS[i]; sy += logF[i]; }
  sx /= m; sy /= m;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < m; i++) { sxy += (logS[i] - sx) * (logF[i] - sy); sxx += (logS[i] - sx) ** 2; }
  return sxy / sxx;
}

/**
 * FatMaxxer alpha1v2: smoothness priors (lambda) then DFA on FatMaxxer scales.
 */
export function alpha1FatMaxxer(rr, lambda = 500) {
  if (rr.length < 30) return NaN;
  return dfaAlpha(smoothnessPriors(rr, lambda), FATMAXXER_SCALES);
}

/**
 * Streaming artifact filter identical to FatMaxxer: each new RR is compared with the previous
 * *received* RR; outside prev*(1±thr) it is dropped. 'auto' = 5% above 95 bpm, 25% below 80 bpm (hysteresis).
 */
export class ArtifactFilter {
  constructor(mode = 'auto') { this.mode = mode; this.prev = null; this.thr = 0.25; this.first = true; }
  setMode(mode) { this.mode = mode; }
  /** @returns {{accept:boolean, thr:number}} */
  push(rr, hr) {
    if (this.mode === 'auto') {
      if (hr > 95) this.thr = 0.05; else if (hr < 80) this.thr = 0.25;
    } else if (this.mode === 'off') { this.thr = Infinity; }
    else { this.thr = Number(this.mode); }
    let accept = true;
    if (!this.first && this.prev != null && isFinite(this.thr)) {
      const lo = this.prev * (1 - this.thr), hi = this.prev * (1 + this.thr);
      accept = !(lo >= rr || rr >= hi);
    }
    // hard physiological bounds regardless of mode
    if (rr < 250 || rr > 2500) accept = false;
    this.prev = rr;
    this.first = false;
    return { accept, thr: this.thr };
  }
  reset() { this.prev = null; this.first = true; }
}

/**
 * Rolling window of accepted RR intervals keyed by receive time; computes windowed features.
 */
export class Alpha1Window {
  constructor({ windowSec = 120, lambda = 500, scales = 'fatmaxxer' } = {}) {
    this.windowMs = windowSec * 1000; this.lambda = lambda; this.scales = scales;
    this.samples = []; // {t, rr}
    this.artifacts = []; // t
  }
  pushAccepted(t, rr) { this.samples.push({ t, rr }); this.expire(t); }
  pushArtifact(t) { this.artifacts.push(t); this.expire(t); }
  expire(now) {
    const cut = now - this.windowMs;
    while (this.samples.length && this.samples[0].t < cut) this.samples.shift();
    while (this.artifacts.length && this.artifacts[0] < cut) this.artifacts.shift();
  }
  /** Windowed features (alpha1, hr, rmssd, artifact%). */
  features() {
    const rr = this.samples.map(s => s.rr);
    const n = rr.length;
    if (!n) return null;
    let sum = 0, ssd = 0;
    for (let i = 0; i < n; i++) { sum += rr[i]; if (i) { const d = rr[i] - rr[i - 1]; ssd += d * d; } }
    const meanRR = sum / n;
    const hr = 60000 / meanRR;
    const rmssd = n > 1 ? Math.sqrt(ssd / (n - 1)) : NaN;
    const art = this.artifacts.length;
    const artPct = 100 * art / (art + n);
    let a1 = NaN;
    if (n >= 30) {
      const x = this.lambda > 0 ? smoothnessPriors(rr, this.lambda) : rr;
      a1 = dfaAlpha(x, this.scales === 'kubios' ? KUBIOS_SCALES : FATMAXXER_SCALES);
    }
    return { alpha1: a1, hr, rmssd, samples: n, artifacts: art, artifactPct: artPct, meanRR };
  }
}

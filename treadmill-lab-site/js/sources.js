// Alternative heart-rate sources sharing the BLE source interface: replay (RR file) and demo (synthetic).
// Both drive a virtual clock: now() returns the data time, advanced at `speed` × wall time.

class BaseSource {
  constructor() { this.listeners = {}; this.status = 'idle'; this.battery = null; this.name = ''; this.speed = 1; this._timer = null; }
  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; }
  off(ev, fn) { if (this.listeners[ev]) this.listeners[ev] = this.listeners[ev].filter(f => f !== fn); return this; }
  emit(ev, data) { (this.listeners[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }
  setStatus(s, detail = '') { this.status = s; this.emit('status', { status: s, detail, name: this.name, battery: this.battery }); }
  async disconnect() { clearInterval(this._timer); this._timer = null; this.setStatus('disconnected'); }
}

/** Replays [[tMs, rrMs], ...] as one HR notification per second of data time. */
export class ReplaySource extends BaseSource {
  constructor(rr, { speed = 1, name = 'Replay' } = {}) {
    super(); this.kind = 'replay'; this.rr = rr; this.speed = speed; this.name = name;
    this.t0 = rr.length ? rr[0][0] : Date.now(); this.tEnd = rr.length ? rr[rr.length - 1][0] : this.t0;
    this.idx = 0; this.cursor = this.t0; this.wallStart = null; this.recent = [];
  }
  now() { return this.wallStart == null ? this.t0 : Math.min(this.tEnd + 2000, this.t0 + (performance.now() - this.wallStart) * this.speed); }
  async connect() {
    this.wallStart = performance.now(); this.cursor = this.t0; this.idx = 0;
    this.setStatus('connected', `replay ×${this.speed}`);
    this._timer = setInterval(() => this.pump(), 100);
  }
  pump() {
    const vnow = this.now();
    while (this.cursor + 1000 <= vnow) {
      const tEvt = this.cursor + 1000; const batch = [];
      while (this.idx < this.rr.length && this.rr[this.idx][0] <= tEvt) { batch.push(this.rr[this.idx][1]); this.idx++; }
      if (batch.length) { this.recent.push(...batch); this.recent = this.recent.slice(-4); }
      const hr = this.recent.length ? Math.round(60000 / (this.recent.reduce((a, b) => a + b, 0) / this.recent.length)) : 0;
      if (this.idx < this.rr.length || batch.length) this.emit('hr', { t: tEvt, hr, rr: batch, contact: true });
      this.cursor = tEvt;
      if (this.idx >= this.rr.length) { this.setStatus('ended', 'replay finished'); clearInterval(this._timer); break; }
    }
  }
  get progress() { return this.rr.length ? this.idx / this.rr.length : 0; }
}

/**
 * Synthetic strap. profile(tSec) → { hr, alpha } (targets). RR noise is a blend of a random walk
 * (strongly correlated, α≈1.5) and white noise (α≈0.5); the blend is tuned so measured α1 ≈ target.
 */
export class DemoSource extends BaseSource {
  constructor({ speed = 1, profile = null, name = 'Demo strap' } = {}) {
    super(); this.kind = 'demo'; this.speed = speed; this.name = name; this.battery = 88;
    this.profile = profile || (t => ({ hr: 120, alpha: 0.9 }));
    this.t0 = Date.now(); this.wallStart = null; this.cursor = this.t0; this.walk = 0; this.rrPhase = 0; this.seed = 12345; this.hrLag = null;
  }
  rand() { this.seed = (1664525 * this.seed + 1013904223) >>> 0; return this.seed / 4294967296; }
  gauss() { let u = 0, v = 0; while (u === 0) u = this.rand(); v = this.rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  now() { return this.wallStart == null ? this.t0 : this.t0 + (performance.now() - this.wallStart) * this.speed; }
  async connect() { this.wallStart = performance.now(); this.cursor = this.t0; this.setStatus('connected', `demo ×${this.speed}`); this._timer = setInterval(() => this.pump(), 100); }
  // Noise mix parameter u∈[0,2]: 0 = correlated walk (α≈1.5), 1 = white (α≈0.6 on 3–15-beat scales), 2 = anti-correlated (α≈0.2).
  // Table (measured α at u) calibrated with test/calib_demo3.mjs; inverted at runtime.
  static CAL = [[0, 1.46], [0.25, 0.93], [0.4, 0.73], [0.5, 0.715], [0.7, 0.63], [1.0, 0.615], [1.3, 0.46], [1.6, 0.31], [2.0, 0.25]];
  static mixFor(alpha) {
    const t = DemoSource.CAL; if (alpha >= t[0][1]) return 0; if (alpha <= t[t.length - 1][1]) return 2;
    for (let i = 1; i < t.length; i++) if (alpha >= t[i][1]) { const f = (t[i - 1][1] - alpha) / (t[i - 1][1] - t[i][1]); return t[i - 1][0] + f * (t[i][0] - t[i - 1][0]); }
    return 2;
  }
  static weights(u) { return u <= 1 ? [1 - u, u, 0] : [0, 2 - u, u - 1]; }
  pump() {
    const vnow = this.now();
    while (this.cursor + 1000 <= vnow) {
      const tEvt = this.cursor + 1000; const tSec = (tEvt - this.t0) / 1000;
      const p = this.profile(tSec) || { hr: 120, alpha: 0.9 };
      // cardiac lag: first-order response, tau ≈ 25 s
      this.hrLag = this.hrLag == null ? p.hr : this.hrLag + (p.hr - this.hrLag) * (1 - Math.exp(-1 / 25));
      const meanRR = 60000 / this.hrLag;
      const sd = Math.max(3, Math.min(60, 4 + 0.09 * (meanRR - 400))); // RR variability shrinks with HR (≈58 ms at 60 bpm, ≈4 ms at 150 bpm)
      const [aw, awh, aa] = DemoSource.weights(this.mixOverride != null ? this.mixOverride : DemoSource.mixFor(p.alpha));
      const batch = [];
      let acc = this.rrPhase;
      while (acc < 1000) {
        this.walk = 0.985 * this.walk + this.gauss() * 0.17; // bounded correlated component (sd≈1)
        const e = this.gauss(); const anti = (e - 0.9 * (this.prevE || 0)) / 1.35; this.prevE = e; // negatively autocorrelated (sd≈1)
        const noise = sd * (aw * this.walk + awh * e * 0.9 + aa * anti);
        const rr = Math.max(300, Math.round(meanRR + noise));
        batch.push(rr); acc += rr;
      }
      this.rrPhase = acc - 1000;
      this.emit('hr', { t: tEvt, hr: Math.round(this.hrLag), rr: batch, contact: true });
      this.cursor = tEvt;
    }
  }
}

/** Demo profile wired to a SessionEngine: HR/α1 follow the current stage speed (treadmill truth model). */
export function demoProfileForEngine(engine, { restHr = 92, hrPerKmh = 8.6, hrBase = 60, alphaAt6 = 1.2, alphaSlope = 0.09 } = {}) {
  let lastWorkHr = restHr;
  return () => {
    const v = engine.view();
    let speed = 0, pausing = false;
    if (v.state !== 'running') speed = 0;
    else if (engine.mode === 'test') { if (v.phase === 'warmup') speed = engine.protocol.warmupSpeed; else if (v.phase === 'work' && v.stage) speed = v.stage.speed; else pausing = true; }
    else if (engine.mode === 'lt2') speed = v.phase === 'work' ? (engine.targets?.speedHi ?? 12) : v.phase === 'rest' ? 6 : v.phase === 'warmup' || v.phase === 'cooldown' ? 7 : 0;
    else speed = engine.targets?.speedLo ? (engine.targets.speedLo + (engine.targets.speedHi ?? engine.targets.speedLo)) / 2 : 8;
    let hr, alpha;
    if (pausing) { hr = Math.max(95, lastWorkHr - 30); alpha = 1.0; }             // standing on the belt edges: partial recovery
    else if (speed > 0) { hr = hrBase + hrPerKmh * speed; lastWorkHr = hr; alpha = Math.max(0.3, alphaAt6 - alphaSlope * (speed - 6)); }
    else { hr = restHr; alpha = 1.1; }
    return { hr, alpha, speed };
  };
}

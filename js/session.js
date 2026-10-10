// Session engine: drives a step test, LT1/LT2 sessions or free monitoring from any HR source.
import { ArtifactFilter, Alpha1Window } from './dfa.js';
import { VOICE } from './i18n.js';
import { uid } from './store.js';

export const DEFAULT_PROTOCOL = {
  type: 'speed',            // 'speed' (incline fixed) | 'incline' (speed fixed)
  incline: 1.0, startSpeed: 6.0, speedStep: 1.0,
  fixedSpeed: 7.0, startIncline: 1.0, inclineStep: 2.0,
  stageSec: 180, pauseSec: 30, warmupSec: 300, warmupSpeed: 5.5,
  stopLactate: 6.0, stopHrPct: 95, maxStages: 12, // (v1.1.23: the RPE stop criterion is gone — heart rate ≥ stopHrPct % of max replaces it)
};
const wall = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()); // real time, also for demo / replay sources that run on a fast data clock
const QUIET_MS = 5000; // the strap notifies once a second; nothing for 5 s = it is not sending (out of range, reconnecting)
export const DEFAULT_INTERVALS = { warmupSec: 600, reps: 4, workSec: 480, restSec: 180, cooldownSec: 360 };
/**
 * The weekly LT1 verification run (two laps, v1.1.17): easy warm-up → lap 1 at the test speed (10 min) → gap (belt stopped, stand
 * still, sample 30–45 s after the stop; 60–90 s is the aim, 3 min the cap — beyond it the strict rule applies) → lap 2 (30 min;
 * 20 min for the MLSS variant) → end sample before any cool-down. gapCapSec / sampleAtSec drive the voice cues.
 */
export const DEFAULT_LAPS = { warmupSec: 300, lap1Sec: 600, lap2Sec: 1800, gapCapSec: 180, sampleAtSec: 30 };
export const JUDGE_FROM_SEC = 600; // LT1 session: the heart-rate band is judged from minute 10 (no zone cues during the 0–5-min easy jog and the ramp)
/** Minutes of an LT1 session after which the heart-rate ceiling is LT1 + 5 (drift allowed) rather than the band's upper edge. */
export const LATE_FROM_SEC = 1200;

/** Build the ordered stage list for a protocol within treadmill limits. */
export function buildStages(protocol, treadmill = {}) {
  const out = []; const maxS = treadmill.maxSpeed ?? 18, maxI = treadmill.maxIncline ?? 15;
  for (let i = 0; i < (protocol.maxStages || 12); i++) {
    const speed = protocol.type === 'speed' ? +(protocol.startSpeed + i * protocol.speedStep).toFixed(1) : protocol.fixedSpeed;
    const incline = protocol.type === 'speed' ? protocol.incline : +(protocol.startIncline + i * protocol.inclineStep).toFixed(1);
    if (speed > maxS || incline > maxI) break;
    out.push({ idx: i + 1, speed, incline });
  }
  return out;
}

export class SessionEngine {
  constructor({ settings, alerts, onUpdate = () => {}, onEvent = () => {}, onAutosave = () => {} }) {
    this.settings = settings; this.alerts = alerts; this.onUpdate = onUpdate; this.onEvent = onEvent; this.onAutosave = onAutosave;
    this.source = null; this.mode = 'free'; this.protocol = { ...DEFAULT_PROTOCOL, ...(settings.protocol || {}) }; this.intervals = { ...DEFAULT_INTERVALS }; this.laps = { ...DEFAULT_LAPS };
    this.targets = null; // {hrLo, hrHi, alphaMin, ceilHr?, lateFromSec?}
    this.meta = null; this.rrSeen = 0; this.lastEvtWall = null; // rrSeen: RR intervals received from the current source (also before Start)
    this.reset();
  }
  reset() {
    const a = this.settings.alpha1 || {};
    this.filter = new ArtifactFilter(a.artifactMode || 'auto');
    this.window = new Alpha1Window({ windowSec: Number(a.windowSec) || 120, lambda: a.lambda ?? 500, scales: a.scales || 'fatmaxxer' });
    this.stepSec = Number(a.stepSec) > 0 ? Number(a.stepSec) : 5; // a <select> stores strings: '10' + 10 would concatenate
    this.plan = this.plan || [];
    this.state = 'idle'; // idle | ready | running | finished
    this.phase = 'none'; // test: warmup | work | pause | done ; lt2: warmup | work | rest | cooldown
    this.session = null; this.lastHr = null; this.lastEvt = null; this.lastFeature = null; this.features = []; this.hrLive = []; this.rr = []; this.events = [];
    this.stages = []; this.stageIdx = -1; this.phaseStart = 0; this.startedAt = 0; this.lastStep = 0; this.lastAutosave = 0;
    this.zoneState = 'waiting'; this.outsideSince = 0; this.alphaLowSince = 0; this.tiz = { inSec: 0, totalSec: 0 }; this.stopAdvised = false; this.pendingLactate = null; this.rep = 0;
    this.lastTick = 0; this.paused = false; this.pauseAccum = 0; this.pauseStartedAt = 0; this.endedAt = 0;
    this.lapTimes = { lap1Start: null, lap1End: null, lap2Start: null, lap2End: null }; this.ceilSince = 0; this.lateCued = false;
  }
  now() { return this.source && this.source.now ? this.source.now() : Date.now(); }
  /** targets / meta: pass null to clear what a previous session left behind; leave undefined to keep. */
  configure({ mode, protocol, intervals, laps, targets, meta }) {
    if (mode) this.mode = mode; if (protocol) this.protocol = { ...this.protocol, ...protocol }; if (intervals) this.intervals = { ...this.intervals, ...intervals }; if (laps) this.laps = { ...this.laps, ...laps };
    if (targets !== undefined) this.targets = targets || null; if (meta !== undefined) this.meta = meta ? { ...meta } : null;
    this.plan = this.mode === 'test' ? buildStages(this.protocol, this.settings.treadmill) : [];
    this.onUpdate(this.view());
  }
  setSource(source) {
    if (this.source && this._hrHandler) { this.source.off('hr', this._hrHandler); this.source.off('status', this._statusHandler); }
    this.source = source; this.rrSeen = 0; this.sourceStatus = null; this.lastEvtWall = null;
    this._hrHandler = e => this.onHr(e);
    this._statusHandler = s => { this.sourceStatus = s; if (s.status === 'connected' && this.state === 'idle') this.state = 'ready'; if (s.status === 'connected' && this.state === 'running') this.alerts?.speak(VOICE.connected(), { key: 'conn', minGapSec: 10 }); if (s.status === 'reconnecting' && this.state === 'running') this.alerts?.cue(VOICE.disconnected(), { beep: 'low', key: 'disc', minGapSec: 20 }); if (s.status === 'ended' && this.state === 'running') this.stop('source-ended'); this.onUpdate(this.view()); };
    source.on('hr', this._hrHandler);
    source.on('status', this._statusHandler);
  }
  // ---------- data path ----------
  onHr(e) {
    this.lastHr = e.hr; this.lastEvt = e; const t = e.t ?? this.now(); this.rrSeen += e.rr ? e.rr.length : 0; this.lastEvtWall = wall();
    if (this.state !== 'running') { this.onUpdate(this.view()); return; }
    this.hrLive.push([t, e.hr]);
    for (const rr of e.rr || []) {
      const { accept } = this.filter.push(rr, e.hr);
      if (accept) this.window.pushAccepted(t, rr); else this.window.pushArtifact(t);
      this.rr.push([t, Math.round(rr), accept ? 1 : 0]);
    }
    if (!(e.rr && e.rr.length)) this.window.expire(t);
    this.tick(t);
  }
  tick(t) {
    if (this.state !== 'running') return;
    const now = t ?? this.now();
    if (now - this.lastStep >= this.stepSec * 1000) {
      this.lastStep = now;
      // While the strap is silent nothing new is known: the row is kept (time base) but carries no heart rate and no α1 — the last
      // values must not be written again and again as if they were measured — and the α1 window ages out.
      const quiet = this.quiet(); if (quiet) this.window.expire(now);
      const f = this.window.features();
      const rec = { t: now, alpha1: f && !quiet ? f.alpha1 : NaN, hr: f && !quiet ? f.hr : NaN, hrInst: quiet ? null : this.lastHr, rmssd: f && !quiet ? f.rmssd : NaN, artifactPct: f ? f.artifactPct : 0, samples: f ? f.samples : 0, stage: this.stageIdx >= 0 ? this.stages[this.stageIdx]?.idx : 0, phase: this.phase, paused: this.paused };
      if (quiet) rec.gap = true;
      this.features.push(rec); this.lastFeature = rec;
      this.evaluateZone(rec, now);
    }
    this.runPhases(now);
    if (now - this.lastAutosave > 30000) { this.lastAutosave = now; this.onAutosave(this.snapshot(false)); }
    if (now - this.lastTick >= 1000) { this.lastTick = now; this.onUpdate(this.view()); }
  }
  /** True when a running session has had no notification from the strap for QUIET_MS of real time. */
  quiet() { return this.state === 'running' && this.lastEvtWall != null && wall() - this.lastEvtWall > QUIET_MS; }
  // ---------- control ----------
  start() {
    if (this.state === 'running') return;
    const now = this.now(); this.startedAt = now; this.lastStep = now; this.lastAutosave = now; this.state = 'running'; this.sessionId = uid();
    this.filter.reset(); this.events.push({ t: now, type: 'start', mode: this.mode });
    if (this.mode === 'test') { if (this.protocol.warmupSec > 0) this.setPhase('warmup', now); else this.beginStage(0, now); }
    else if (this.mode === 'lt2') { this.rep = 0; this.setPhase(this.intervals.warmupSec > 0 ? 'warmup' : 'work', now); if (this.phase === 'work') { this.rep = 1; this.alerts?.cue(VOICE.interval_work(1, this.intervals.reps), { beep: 'double' }); } }
    else if (this.mode === 'verify') { this.rep = 0; if (this.laps.warmupSec > 0) this.setPhase('warmup', now); else this.advanceLap(now, true); }
    else this.setPhase('work', now);
    this.alerts?.keepAwake(true);
    this.timer = setInterval(() => this.tick(), 250);
    this.onUpdate(this.view());
  }
  setPhase(p, now) { this.phase = p; this.phaseStart = now; this.events.push({ t: now, type: 'phase', phase: p, stage: this.stageIdx >= 0 ? this.stages[this.stageIdx]?.idx : 0, rep: this.rep }); this.warned = {}; }
  beginStage(i, now) {
    if (i >= this.plan.length) { this.stopAdvised = true; this.setPhase('done', now); this.alerts?.cue(VOICE.stop_criteria(), { beep: 'triple' }); return; }
    const p = this.plan[i]; this.stageIdx = i;
    this.stages.push({ idx: p.idx, speed: p.speed, incline: p.incline, tStart: now, tEnd: null, tPauseEnd: null, lactate: null, rpe: null });
    this.setPhase('work', now);
    this.alerts?.cue(VOICE.stage_start(p.idx, p.speed, this.protocol.type === 'incline' ? p.incline : (p.incline !== 1 ? p.incline : 0)), { beep: 'double', vib: [300, 100, 300] });
  }
  endStageWork(now) {
    const st = this.stages[this.stageIdx]; if (!st || st.tEnd) return;
    st.tEnd = this.paused ? Math.max(st.tStart, Math.min(now, this.pauseStartedAt)) : now; // "End stage" pressed during a pause: the running ended when the pause began
    if (!(this.protocol.pauseSec > 0)) { // continuous (α1-only) test: no sampling pause, straight into the next stage
      st.tPauseEnd = now; if (this.stopAdvised) { this.setPhase('done', now); return; } this.beginStage(this.stageIdx + 1, now); return;
    }
    this.setPhase('pause', now); this.pendingLactate = st.idx;
    this.alerts?.cue(VOICE.stage_end(), { beep: 'triple', vib: [500, 200, 500] });
    this.onEvent({ type: 'lactate-prompt', stage: st.idx });
  }
  lap() {
    const now = this.now();
    if (this.state !== 'running') return;
    if (this.mode === 'test') { if (this.phase === 'warmup') { this.alerts?.speak(VOICE.warmup_end()); this.beginStage(0, now); } else if (this.phase === 'work') this.endStageWork(now); else if (this.phase === 'pause') { const st = this.stages[this.stageIdx]; st.tPauseEnd = now; this.beginStage(this.stageIdx + 1, now); } }
    else if (this.mode === 'lt2') this.advanceInterval(now, true);
    else if (this.mode === 'verify') this.advanceLap(now, true);
    else this.events.push({ t: now, type: 'lap' });
    this.onUpdate(this.view());
  }
  /**
   * Where a lactate value sits in the run (v1.1.17): the lap it belongs to (0 = warm-up / rest), the running time at speed it was
   * taken after (runSec: the lap's running time for a value typed in the gap or after the end, else the running time so far),
   * sinceStopSec = seconds since the belt stopped (the sample should be taken 30–45 s after it), gapSec = the gap so far for a
   * value typed between the laps. Other modes: the running time of the current block and, while paused, the seconds since Pause.
   */
  sampleTags(now) {
    const L = this.lapTimes; const sec = (a, b) => a != null && b != null ? Math.max(0, Math.round((b - a) / 1000)) : null;
    if (this.mode === 'verify') {
      if (this.phase === 'gap') return { lap: 1, runSec: sec(L.lap1Start, L.lap1End), sinceStopSec: sec(L.lap1End, now), gapSec: sec(L.lap1End, now) };
      if (this.phase === 'done') return { lap: 2, runSec: sec(L.lap2Start, L.lap2End), sinceStopSec: sec(L.lap2End, now) };
      if (this.phase === 'work') return { lap: this.rep, runSec: Math.round(this.phaseSec(now)) };
      return { lap: 0, runSec: Math.round(this.phaseSec(now)) };
    }
    const out = { runSec: this.phase === 'work' || this.mode === 'free' || this.mode === 'lt1' ? Math.round(this.phaseSec(now)) : 0 };
    if (this.mode === 'lt2' && this.rep) out.lap = this.rep;
    if (this.paused) out.sinceStopSec = Math.max(0, Math.round((now - this.pauseStartedAt) / 1000));
    return out;
  }
  /** Seconds of the current phase, paused time left out (the clocks stand still while paused). */
  phaseSec(now) { return Math.max(0, ((this.paused ? this.pauseStartedAt : now) - this.phaseStart) / 1000); }
  /** Pause freezes the phase and elapsed clocks; resuming shifts the phase start by the paused time, so the time left in the stage / interval is unchanged. */
  pauseToggle() {
    if (this.state !== 'running') return;
    const now = this.now();
    if (!this.paused) { this.paused = true; this.pauseStartedAt = now; this.events.push({ t: now, type: 'pause' }); }
    else { this.endPause(now); this.events.push({ t: now, type: 'resume' }); }
    this.onUpdate(this.view());
  }
  endPause(now) {
    if (!this.paused) return;
    this.paused = false; this.pauseAccum += Math.max(0, now - this.pauseStartedAt);
    this.phaseStart += Math.max(0, now - Math.max(this.pauseStartedAt, this.phaseStart)); // a phase begun during the pause starts counting at resume
    this.outsideSince = 0; this.alphaLowSince = 0; // zone / α1 grace periods restart after a pause
  }
  enterLactate(value, stageIdx = null) {
    const idx = stageIdx ?? this.pendingLactate; const st = this.stages.find(s => s.idx === idx) || this.stages[this.stages.length - 1];
    if (st && value != null && Number.isFinite(value)) { if (st.lactate != null && st.lactate !== value) st.lactate2 = value; else st.lactate = value; }
    const now = this.now(); this.pendingLactate = null; this.events.push({ t: now, type: 'lactate', stage: st ? st.idx : null, rep: this.rep, phase: this.phase, value, ...this.sampleTags(now) });
    if (value >= this.protocol.stopLactate && !this.stopAdvised && this.mode === 'test') { this.stopAdvised = true; this.alerts?.cue(VOICE.stop_criteria(), { beep: 'triple' }); }
    this.onUpdate(this.view());
  }
  stop(reason = 'user') {
    if (this.state !== 'running') return this.session;
    const now = this.now(); clearInterval(this.timer);
    const pausedAt = this.paused ? this.pauseStartedAt : null;
    this.endPause(now); // finishing while paused: count that pause too (pauseMs)
    const st = this.stages[this.stageIdx]; if (st && !st.tEnd && this.phase === 'work') st.tEnd = pausedAt != null ? Math.max(st.tStart, Math.min(now, pausedAt)) : now; // …and the stage ended when the pause began, not minutes of recovery later
    if (this.mode === 'verify' && this.phase === 'work') { const tEnd = pausedAt != null ? Math.max(this.phaseStart, Math.min(now, pausedAt)) : now; if (this.rep === 1) this.lapTimes.lap1End = tEnd; else this.lapTimes.lap2End = tEnd; } // Finish pressed during a lap: the lap ended there
    this.events.push({ t: now, type: 'stop', reason }); this.state = 'finished'; this.endedAt = now;
    this.alerts?.keepAwake(false); this.alerts?.cue(VOICE.finished(), { beep: 'high' });
    this.session = this.snapshot(true); this.onUpdate(this.view()); this.onEvent({ type: 'finished', reason, session: this.session }); return this.session;
  }
  // ---------- phase logic ----------
  runPhases(now) {
    if (this.paused) return;
    const el = (now - this.phaseStart) / 1000; const P = this.protocol, A = this.alerts;
    if (this.mode === 'test') {
      if (this.phase === 'warmup') { const left = P.warmupSec - el; if (left <= 10 && !this.warned.w10) { this.warned.w10 = 1; A?.speak(VOICE.pause_warn(10)); } if (left <= 0) { A?.speak(VOICE.warmup_end()); this.beginStage(0, now); } }
      else if (this.phase === 'work') { const left = P.stageSec - el; if (left <= 10 && !this.warned.s10) { this.warned.s10 = 1; A?.cue(VOICE.stage_warn(10), { beep: 'single' }); }
        const stopHr = this.meta?.stopHr; if (Number.isFinite(stopHr) && this.lastHr >= stopHr) { if (!this.hiHrSince) this.hiHrSince = now; if ((now - this.hiHrSince) / 1000 >= 30 && !this.stopAdvised) { this.stopAdvised = true; A?.cue(VOICE.stop_criteria(), { beep: 'triple' }); } } else this.hiHrSince = 0; // v1.1.23: HR ≥ stopHr for 30 s = the stop criterion (replaces RPE)
        if (left <= 0) this.endStageWork(now); }
      else if (this.phase === 'pause') { const left = P.pauseSec - el; if (left <= 10 && !this.warned.p10) { this.warned.p10 = 1; A?.speak(VOICE.pause_warn(10)); } if (left <= 0) { const st = this.stages[this.stageIdx]; st.tPauseEnd = now; if (this.stopAdvised) { this.setPhase('done', now); } else this.beginStage(this.stageIdx + 1, now); } }
    } else if (this.mode === 'lt2') {
      const I = this.intervals;
      const dur = this.phase === 'warmup' ? I.warmupSec : this.phase === 'work' ? I.workSec : this.phase === 'rest' ? I.restSec : this.phase === 'cooldown' ? I.cooldownSec : Infinity;
      const left = dur - el;
      if (left <= 10 && !this.warned.x10 && Number.isFinite(dur)) { this.warned.x10 = 1; A?.speak(VOICE.pause_warn(10)); }
      if (left <= 0 && Number.isFinite(dur)) this.advanceInterval(now, false);
    } else if (this.mode === 'verify') {
      const Lp = this.laps;
      if (this.phase === 'warmup') { const left = Lp.warmupSec - el; if (left <= 10 && !this.warned.w10) { this.warned.w10 = 1; A?.speak(VOICE.lap_warn_start(10)); } if (left <= 0) this.advanceLap(now, false); }
      else if (this.phase === 'work') {
        const dur = this.rep === 1 ? Lp.lap1Sec : Lp.lap2Sec; const left = dur - el;
        if (this.rep === 2 && Math.abs(left - dur / 2) < 1 && !this.warned.half) { this.warned.half = 1; A?.speak(VOICE.halfway()); }
        if (left <= 30 && !this.warned.s30) { this.warned.s30 = 1; A?.cue(VOICE.lap_warn(30), { beep: 'single' }); }
        if (left <= 0) this.advanceLap(now, false);
      } else if (this.phase === 'gap' || this.phase === 'done') {
        // the belt is stopped: the sample 30–45 s after the stop; in the gap, the restart at 60–90 s, the cap at 3 min (strict rule beyond it)
        if (el >= Lp.sampleAtSec && !this.warned.g30) { this.warned.g30 = 1; A?.cue(VOICE.gap_sample(), { beep: 'triple', vib: [300, 100, 300, 100, 300] }); this.onEvent({ type: 'lactate-prompt', stage: null, lap: this.phase === 'gap' ? 1 : 2 }); }
        if (this.phase === 'gap' && el >= 90 && !this.warned.g90) { this.warned.g90 = 1; A?.speak(VOICE.gap_restart()); }
        if (this.phase === 'gap' && el >= Lp.gapCapSec && !this.warned.gcap) { this.warned.gcap = 1; A?.cue(VOICE.gap_cap(), { beep: 'low' }); }
      }
    } else if (this.mode === 'lt1' && this.targets?.durationSec) {
      const left = this.targets.durationSec - el;
      if (Math.abs(left - this.targets.durationSec / 2) < 1 && !this.warned.half) { this.warned.half = 1; A?.speak(VOICE.halfway()); }
      if (left <= 60 && !this.warned.m1) { this.warned.m1 = 1; A?.speak(VOICE.minute_left()); }
      if (left <= 0 && !this.warned.end) { this.warned.end = 1; A?.cue('목표 시간 완료. 쿨다운하세요.', { beep: 'triple' }); }
    }
  }
  /** The two-lap verification run: warm-up → lap 1 → gap → lap 2 → done (the recording goes on until Finish for the end sample). */
  advanceLap(now, manual) {
    const Lp = this.laps, L = this.lapTimes; const min = s => Math.round(s / 60);
    if (this.phase === 'warmup' || this.phase === 'none') { this.rep = 1; L.lap1Start = now; this.setPhase('work', now); this.alerts?.cue(VOICE.lap_start(1, min(Lp.lap1Sec)), { beep: 'double', vib: [300, 100, 300] }); }
    else if (this.phase === 'work' && this.rep === 1) { L.lap1End = now; this.setPhase('gap', now); this.alerts?.cue(VOICE.lap_stop(), { beep: 'triple', vib: [500, 200, 500] }); }
    else if (this.phase === 'gap') { this.rep = 2; L.lap2Start = now; this.setPhase('work', now); this.alerts?.cue(VOICE.lap_start(2, min(Lp.lap2Sec)), { beep: 'double', vib: [300, 100, 300] }); }
    else if (this.phase === 'work' && this.rep === 2) { L.lap2End = now; this.setPhase('done', now); this.alerts?.cue(VOICE.lap_stop(), { beep: 'triple', vib: [500, 200, 500] }); }
    // done: nothing more to advance to — Finish ends the recording
  }
  advanceInterval(now, manual) {
    const I = this.intervals;
    if (this.phase === 'warmup') { this.rep = 1; this.setPhase('work', now); this.alerts?.cue(VOICE.interval_work(1, I.reps), { beep: 'double', vib: [300, 100, 300] }); }
    else if (this.phase === 'work') { if (this.rep >= I.reps) { this.setPhase('cooldown', now); this.alerts?.cue('마지막 인터벌 끝. 쿨다운.', { beep: 'triple' }); } else { this.setPhase('rest', now); this.alerts?.cue(VOICE.interval_rest(), { beep: 'single' }); } }
    else if (this.phase === 'rest') { this.rep += 1; this.setPhase('work', now); this.alerts?.cue(VOICE.interval_work(this.rep, I.reps), { beep: 'double', vib: [300, 100, 300] }); }
    else if (this.phase === 'cooldown') { if (!manual) { this.alerts?.cue('쿨다운 완료.', { beep: 'high' }); this.setPhase('done', now); } }
  }
  evaluateZone(rec, now) {
    const T = this.targets; if (!T || this.paused) { this.zoneState = 'none'; return; }
    if (rec.gap) { this.zoneState = 'waiting'; return; } // strap silent: no heart rate to place in a zone
    const active = this.mode === 'lt1' ? this.phase === 'work' : this.mode === 'lt2' ? this.phase === 'work' : false;
    if (!active) { this.zoneState = 'rest'; this.outsideSince = 0; return; }
    const hr = this.lastHr; if (!hr) return;
    this.tiz.totalSec += this.stepSec;
    // LT1 session (v1.1.17): speed is the dose. After LATE_FROM_SEC of running the ceiling is LT1 + 5 (ceilHr) — the drift of a
    // steady run is allowed — and crossing it for a minute brings the "slow down 0.3" cue instead of the band's zone-high cue.
    const runSec = (now - this.startedAt - this.pauseAccum) / 1000;
    const late = this.mode === 'lt1' && Number.isFinite(T.ceilHr) && runSec >= (T.lateFromSec ?? LATE_FROM_SEC);
    const grace = this.mode === 'lt1' && runSec < (T.judgeFromSec ?? JUDGE_FROM_SEC); // v1.1.20: the band is judged from minute 10 — the warm-up ramp (0–5 min easy jog) gives no zone cues
    const hi = late ? T.ceilHr : T.hrHi;
    let z = 'in'; if (hr > hi) z = 'above'; else if (hr < T.hrLo) z = 'below'; else this.tiz.inSec += this.stepSec;
    if (late && z === 'in' && hr > T.hrHi) z = 'drift'; // above the band, under the ceiling: shown, not cued
    const A = this.alerts, exitSec = this.settings.alerts?.zoneExitSec ?? 30;
    if (z === 'in' || z === 'drift' || grace) this.outsideSince = 0; else { if (!this.outsideSince) this.outsideSince = now; if ((now - this.outsideSince) / 1000 >= (late && z === 'above' ? 60 : exitSec)) { if (late && z === 'above') A?.cue(VOICE.ceiling(), { beep: 'low', vib: [150, 100, 150], key: 'ceil', minGapSec: 180 }); else A?.cue(z === 'above' ? VOICE.zone_high() : VOICE.zone_low(), { beep: z === 'above' ? 'low' : 'high', vib: [150, 100, 150], key: 'zone', minGapSec: 60 }); } }
    this.zoneState = z;
    if (this.mode === 'lt1' && this.settings.alpha1?.guidance !== 'off' && Number.isFinite(rec.alpha1) && T.alphaMin) {
      if (rec.alpha1 < T.alphaMin) { if (!this.alphaLowSince) this.alphaLowSince = now; if ((now - this.alphaLowSince) / 1000 >= 60) A?.cue(VOICE.alpha_low(), { beep: 'low', key: 'alpha', minGapSec: 120 }); }
      else this.alphaLowSince = 0;
    }
    if (rec.artifactPct > 10 && rec.samples > 40) A?.speak(VOICE.artifacts_high(), { key: 'art', minGapSec: 120 });
  }
  // ---------- views & persistence ----------
  view() {
    const now = this.now(); const running = this.state === 'running';
    const clock = this.paused ? this.pauseStartedAt : now; // the clocks stand still while paused
    const el = running ? Math.max(0, (clock - this.phaseStart) / 1000) : 0;
    const P = this.protocol, I = this.intervals; let phaseDur = null;
    if (this.mode === 'test') phaseDur = this.phase === 'warmup' ? P.warmupSec : this.phase === 'work' ? P.stageSec : this.phase === 'pause' ? P.pauseSec : null;
    if (this.mode === 'lt2') phaseDur = this.phase === 'warmup' ? I.warmupSec : this.phase === 'work' ? I.workSec : this.phase === 'rest' ? I.restSec : this.phase === 'cooldown' ? I.cooldownSec : null;
    if (this.mode === 'lt1' && this.targets?.durationSec) phaseDur = this.targets.durationSec;
    if (this.mode === 'verify') phaseDur = this.phase === 'warmup' ? this.laps.warmupSec : this.phase === 'work' ? (this.rep === 1 ? this.laps.lap1Sec : this.laps.lap2Sec) : null; // gap / done: the clock counts up from the stop
    const st = this.stages[this.stageIdx]; const next = this.plan[this.stageIdx + 1];
    return {
      state: this.state, mode: this.mode, phase: this.phase, paused: this.paused, hr: this.quiet() ? null : this.lastHr, contact: this.lastEvt?.contact, feature: this.lastFeature, zone: this.zoneState,
      elapsedSec: running ? (clock - this.startedAt - this.pauseAccum) / 1000 : (this.endedAt ? Math.max(0, this.endedAt - this.startedAt - this.pauseAccum) / 1000 : 0), // paused time is not session time, also once finished
      phaseElapsed: el, phaseDur, phaseLeft: phaseDur != null ? Math.max(0, phaseDur - el) : null,
      stage: st ? { ...st } : null, nextStage: next || null, stages: this.stages, rep: this.rep, reps: I.reps, targets: this.targets, tiz: this.tiz, stopAdvised: this.stopAdvised, pendingLactate: this.pendingLactate,
      source: this.sourceStatus || { status: this.source ? this.source.status : 'idle', name: this.source?.name }, samples: this.window.samples.length, rrSeen: this.rrSeen, plan: this.plan, laps: this.mode === 'verify' ? { ...this.laps } : null,
    };
  }
  snapshot(final) {
    return {
      id: this.sessionId, type: this.mode, startedAt: this.startedAt, endedAt: final ? this.endedAt : null, final: !!final,
      sourceKind: this.source?.kind || 'unknown', protocol: this.mode === 'test' ? { ...this.protocol } : null, intervals: this.mode === 'lt2' ? { ...this.intervals } : null, targets: this.targets,
      laps: this.mode === 'verify' ? { ...this.laps, ...this.lapTimes } : null, purpose: this.mode === 'verify' ? (this.meta?.purpose || 'lt1') : undefined,
      alpha1Settings: { ...(this.settings.alpha1 || {}) }, speed: this.meta?.speed ?? null, incline: this.meta?.incline ?? null,
      rr: this.rr, features: this.features, hrLive: this.hrLive, stages: this.stages.map(s => ({ ...s })), events: this.events, tiz: { ...this.tiz }, pauseMs: this.pauseAccum + (!final && this.paused ? Math.max(0, this.now() - this.pauseStartedAt) : 0), // an autosave taken during a pause counts the pause so far
    };
  }
}

/** Offline feature computation for an imported RR series (same pipeline as live). */
export function computeFeaturesOffline(rr, alphaSettings = {}, stepSec = 5) {
  const filter = new ArtifactFilter(alphaSettings.artifactMode || 'auto');
  const win = new Alpha1Window({ windowSec: alphaSettings.windowSec || 120, lambda: alphaSettings.lambda ?? 500, scales: alphaSettings.scales || 'fatmaxxer' });
  const features = [], hrLive = [], rrOut = [];
  let nextStep = rr.length ? rr[0][0] + stepSec * 1000 : 0; let recent = [];
  for (const [t, v] of rr) {
    recent.push(v); recent = recent.slice(-4); const hr = Math.round(60000 / (recent.reduce((a, b) => a + b, 0) / recent.length));
    const { accept } = filter.push(v, hr);
    if (accept) win.pushAccepted(t, v); else win.pushArtifact(t);
    rrOut.push([t, Math.round(v), accept ? 1 : 0]); hrLive.push([t, hr]);
    while (t >= nextStep) { const f = win.features(); features.push({ t: nextStep, alpha1: f ? f.alpha1 : NaN, hr: f ? f.hr : NaN, hrInst: hr, rmssd: f ? f.rmssd : NaN, artifactPct: f ? f.artifactPct : 0, samples: f ? f.samples : 0 }); nextStep += stepSec * 1000; }
  }
  return { features, hrLive, rr: rrOut };
}

// node test/test_warmup.mjs — the speed to set, one number per step (v1.1.26): prescribe.sessionSpeeds / midSpeed (no ranges),
// session.warmupSteps / cooldownSteps / stepAt for every mode, and that those steps are the moments the engine speaks (the start cue
// and the ramp cues): the live banner shows the speed the voice says, when it says it.
import { SessionEngine, warmupSteps, cooldownSteps, stepAt, LT1_WARMUP_SEC } from '../js/session.js';
import { sessionSpeeds, midSpeed, sessionTargets, computeZones, weeklyPlan } from '../js/prescribe.js';
import { VOICE } from '../js/i18n.js';
let failures = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) failures++; };
const zones = computeZones({ lt1Hr: 143, lt2Hr: 157, lt1Speed: 8.7, lt2Speed: 10.5, maxHr: 188 });
const W = sessionSpeeds(zones); // what app.js hands the engine as meta.warmup
const brief = p => `${p.totalSec}: ` + p.steps.map(s => `${s.fromSec}=${s.walk ? 'walk ' : ''}${s.speed}`).join(', ');

// ───────────── 0. One speed, not a range ─────────────
{
  check('LT1 8.7 / LT2 10.5: jog 7.0 · ramp 7.5 → 8.5 → 9.5 · easy 8.1 · recovery 6.5 · walk 5.5', JSON.stringify(W) === JSON.stringify({ jog: '7.0', hi: '7.5', sub: '8.5', ramp: '9.5', easy: '8.1', rec: '6.5', walk: '5.5' }), JSON.stringify(W));
  check('midSpeed: the middle in 0.1 steps, a tie rounded up (7.7–8.4 → 8.1, 7.0–7.5 → 7.3, 6.5–7.0 → 6.8, 7.0–7.4 → 7.2, 7.5–7.5 → 7.5)', midSpeed(7.7, 8.4) === 8.1 && midSpeed(7.0, 7.5) === 7.3 && midSpeed(6.5, 7.0) === 6.8 && midSpeed(7.0, 7.4) === 7.2 && midSpeed(7.5, 7.5) === 7.5 && Number.isNaN(midSpeed(NaN, 8)));
  let bad = []; for (let i = 60; i <= 130; i++) { const s = i / 10; const z = computeZones({ lt1Hr: 143, lt2Hr: 157, lt1Speed: s, lt2Speed: s + 1.8, maxHr: 188 }); const sp = sessionSpeeds(z), T = sessionTargets(z, 'lt1'); const e = +sp.easy, lo10 = Math.round(T.speedLo * 10), hi10 = Math.round(T.speedHi * 10);
    if (!(Math.round(e * 10) === Math.floor((lo10 + hi10 + 1) / 2) && e >= T.speedLo && e <= T.speedHi && sp.jog === (s - 1.7).toFixed(1) && sp.rec === (s - 2.2).toFixed(1) && sp.hi === (s - 1.2).toFixed(1) && /^\d+\.\d$/.test(sp.easy))) bad.push(`${s}: ${JSON.stringify(sp)} band ${T.speedLo}–${T.speedHi}`); }
  check('every LT1 speed from 6.0 to 13.0: the easy speed is the middle of the band and inside it; the jogs are LT1 − 1.7 / − 2.2 / − 1.2 (no float slips)', bad.length === 0, bad.slice(0, 3).join(' | '));
  check('no speeds without an LT1 speed; no ramp top without an LT2 speed', sessionSpeeds(null) === null && sessionSpeeds({ lt1Hr: 143, lt2Hr: 157 }) === null && sessionSpeeds({ lt1Hr: 143, lt2Hr: 157, lt1Speed: 8.7 }).ramp === null);
  const p = weeklyPlan({ zones, week: 1 }); const run = d => `${d.ko} ${d.en} ${d.note.ko} ${d.note.en}`;
  check('the plan names one speed per day (easy 8.1, ladder 10.5, check 8.7, long run 7.5)', [1, 3, 5, 0].every(d => p.days.find(x => x.day === d).speed === 8.1) && p.days.find(x => x.day === 2).speed === 10.5 && p.days.find(x => x.day === 4).speed === 8.7 && p.days.find(x => x.day === 6).speed === 7.5, JSON.stringify(p.days.map(d => d.speed)));
  const ranged = p.days.filter(d => /\d\.\d\s*[–-]\s*\d+\.\d\s*km\/h/.test(run(d)) || /\d\.\d에서 \d/.test(run(d)));
  check('no running line of the plan gives a speed range (titles and notes, both languages)', ranged.length === 0, ranged.map(d => d.day + ': ' + (run(d).match(/.{20}\d\.\d\s*[–-]\s*\d+\.\d\s*km\/h/) || [''])[0]).join(' | '));
  check('the easy day says 0–5 min at 7.0, then 8.1; the ladder\'s recovery jog is 6.5; the check\'s warm-up jog is 7.0', /0–5분 7\.0 km\/h → 본 구간 8\.1 km\/h/.test(p.days[0].note.ko) && /0–5 min at 7\.0 km\/h → main part 8\.1 km\/h/.test(p.days[0].note.en) && /회복 3분 조깅 6\.5 km\/h/.test(p.days.find(x => x.day === 2).note.ko) && /4:30 7\.0 km\/h\(5분에 심박 < 128\)/.test(p.days.find(x => x.day === 4).note.ko), p.days[0].note.ko.slice(0, 60));
  check('"…로" after a number as it is read: 7.0으로 · 7.3으로 · 8.6으로 · 8.5로 · 9.1로 · 10으로', VOICE.lt2_ramp('7.0') === '시속 7.0으로.' && VOICE.lt2_ramp('7.3') === '시속 7.3으로.' && VOICE.lt2_ramp('8.6') === '시속 8.6으로.' && VOICE.lt2_ramp('8.5') === '시속 8.5로.' && VOICE.lt2_ramp('9.1') === '시속 9.1로.' && VOICE.lt2_ramp(10) === '시속 10으로.');
}
// ───────────── 1. The steps of each mode ─────────────
{
  check('easy run (LT1 session): 5 min at 7.0', brief(warmupSteps({ mode: 'lt1', W })) === '300: 0=7.0' && LT1_WARMUP_SEC === 300, brief(warmupSteps({ mode: 'lt1', W })));
  check('two-lap LT1 check: 30 s walk at 5.5, then 7.0', brief(warmupSteps({ mode: 'verify', W, purpose: 'lt1', warmupSec: 300 })) === '300: 0=walk 5.5, 30=7.0', brief(warmupSteps({ mode: 'verify', W, warmupSec: 300 })));
  check('…and the purpose defaults to the LT1 check', brief(warmupSteps({ mode: 'verify', W, warmupSec: 300 })) === '300: 0=walk 5.5, 30=7.0');
  check('MLSS variant: 2 min at 7.5, then 8.5', brief(warmupSteps({ mode: 'verify', W, purpose: 'mlss', warmupSec: 300 })) === '300: 0=7.5, 120=8.5', brief(warmupSteps({ mode: 'verify', W, purpose: 'mlss', warmupSec: 300 })));
  check('LT2 ladder, 10 min: 7.5 → 8.5 at 4:00 → 9.5 at 7:00', brief(warmupSteps({ mode: 'lt2', W, warmupSec: 600 })) === '600: 0=7.5, 240=8.5, 420=9.5', brief(warmupSteps({ mode: 'lt2', W, warmupSec: 600 })));
  check('LT2 ladder, 12 min: the two ramp steps keep their place before the end (6:00, 9:00)', brief(warmupSteps({ mode: 'lt2', W, warmupSec: 720 })) === '720: 0=7.5, 360=8.5, 540=9.5', brief(warmupSteps({ mode: 'lt2', W, warmupSec: 720 })));
  check('LT2 ladder under 9 min: no ramp, 7.5 throughout', brief(warmupSteps({ mode: 'lt2', W, warmupSec: 300 })) === '300: 0=7.5' && brief(warmupSteps({ mode: 'lt2', W, warmupSec: 539 })) === '539: 0=7.5' && warmupSteps({ mode: 'lt2', W, warmupSec: 540 }).steps.length === 3);
  check('step test: the protocol\'s warm-up speed, a walk at 5.5', brief(warmupSteps({ mode: 'test', protocol: { warmupSec: 300, warmupSpeed: 5.5 } })) === '300: 0=walk 5.5', brief(warmupSteps({ mode: 'test', protocol: { warmupSec: 300, warmupSpeed: 5.5 } })));
  check('…a 7.0 warm-up is not called a walk, a setting stored as text still counts', brief(warmupSteps({ mode: 'test', protocol: { warmupSec: '120', warmupSpeed: '7' } })) === '120: 0=7.0');
  check('ladder cool-down 6 min: 3 min at the jog 7.0, then walking 5.5', brief(cooldownSteps({ W, cooldownSec: 360 })) === '360: 0=7.0, 180=walk 5.5', brief(cooldownSteps({ W, cooldownSec: 360 })));
  check('…5 min: half and half (2:30)', brief(cooldownSteps({ W, cooldownSec: 300 })) === '300: 0=7.0, 150=walk 5.5');
  const every = [warmupSteps({ mode: 'lt1', W }), warmupSteps({ mode: 'verify', W, warmupSec: 300 }), warmupSteps({ mode: 'verify', W, purpose: 'mlss', warmupSec: 300 }), warmupSteps({ mode: 'lt2', W, warmupSec: 600 }), warmupSteps({ mode: 'test', protocol: { warmupSec: 300, warmupSpeed: 5.5 } }), cooldownSteps({ W, cooldownSec: 360 })].flatMap(p => p.steps);
  check('every step is one speed with one decimal — never a range', every.length === 11 && every.every(s => /^\d+\.\d$/.test(s.speed)), every.map(s => s.speed).join(' '));
}
// ───────────── 2. No warm-up, unknown speeds ─────────────
{
  check('free mode has no warm-up', warmupSteps({ mode: 'free', W }).steps.length === 0 && warmupSteps({ mode: 'free', W }).totalSec === 0);
  check('without the zones\' speeds (no W) there are no steps to show', ['lt1', 'lt2', 'verify'].every(mode => warmupSteps({ mode, warmupSec: 600 }).steps.length === 0) && cooldownSteps({ cooldownSec: 360 }).steps.length === 0);
  check('a warm-up or cool-down of 0 min has no steps', warmupSteps({ mode: 'verify', W, warmupSec: 0 }).steps.length === 0 && warmupSteps({ mode: 'lt2', W, warmupSec: 0 }).steps.length === 0 && warmupSteps({ mode: 'test', protocol: { warmupSec: 0, warmupSpeed: 5.5 } }).steps.length === 0 && cooldownSteps({ W, cooldownSec: 0 }).steps.length === 0);
  check('a step that would start at or after the end of the warm-up is left out (MLSS variant, 1- and 2-min warm-up)', brief(warmupSteps({ mode: 'verify', W, purpose: 'mlss', warmupSec: 60 })) === '60: 0=7.5' && brief(warmupSteps({ mode: 'verify', W, purpose: 'mlss', warmupSec: 120 })) === '120: 0=7.5');
  check('no LT2 speed (ramp top unknown): the ladder shows the steps it knows', brief(warmupSteps({ mode: 'lt2', W: { ...W, ramp: null }, warmupSec: 600 })) === '600: 0=7.5, 240=8.5');
  check('called with nothing: empty, no throw', warmupSteps().steps.length === 0 && cooldownSteps().steps.length === 0 && stepAt(null, 10) === null && stepAt({ steps: [] }, 10) === null);
}
// ───────────── 3. Which step applies when ─────────────
{
  const p = warmupSteps({ mode: 'lt2', W, warmupSec: 600 });
  const at = el => { const a = stepAt(p, el); return a ? `${a.step.speed}${a.next ? `>${a.next.speed}@${a.next.fromSec}` : ''}` : 'null'; };
  check('0:00 → 7.5, next 8.5 at 240', at(0) === '7.5>8.5@240', at(0));
  check('3:59 still 7.5, 4:00 → 8.5 (next 9.5 at 420)', at(239.9) === '7.5>8.5@240' && at(240) === '8.5>9.5@420', `${at(239.9)} ${at(240)}`);
  check('7:00 → 9.5, the last step has no next', at(420) === '9.5' && at(599) === '9.5' && at(700) === '9.5', at(420));
  const q = warmupSteps({ mode: 'verify', W, warmupSec: 300 });
  check('two-lap check: walk for the first 30 s, then the jog', stepAt(q, 29).step.walk === true && stepAt(q, 29).next.speed === '7.0' && stepAt(q, 30).step.speed === '7.0' && stepAt(q, 30).next === null);
  const c = cooldownSteps({ W, cooldownSec: 360 });
  check('cool-down: jog until 3:00, walk after', stepAt(c, 179).step.speed === '7.0' && stepAt(c, 179).next.walk === true && stepAt(c, 180).step.speed === '5.5' && stepAt(c, 180).step.walk === true);
}
// ───────────── 4. The steps are the moments the engine speaks ─────────────
const spoken = []; let clock = null; // spoken: { t: text, at: seconds since Start }
const alerts = { speak(t) { spoken.push({ t, at: clock ? (clock.T - clock.t0) / 1000 : null }); }, cue(t) { if (t) spoken.push({ t, at: clock ? (clock.T - clock.t0) / 1000 : null }); }, keepAwake: async () => true, beep() {}, vibrate() {} };
const settings = { protocol: { warmupSec: 300, warmupSpeed: 5.5, stageSec: 180, pauseSec: 30, startSpeed: 6, speedStep: 1, incline: 1, type: 'speed', maxStages: 12 }, treadmill: {}, alpha1: { artifactMode: 'auto', windowSec: 120, stepSec: 5, lambda: 500 }, alerts: { zoneExitSec: 30 } };
class ClockSource { // a strap whose clock the test moves by hand: one notification per second
  constructor(t0) { this.T = t0; this.t0 = t0; this.kind = 'ble'; this.status = 'connected'; this.h = {}; }
  now() { return this.T; } on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); } off(ev, fn) { this.h[ev] = (this.h[ev] || []).filter(f => f !== fn); }
  run(sec, hr = 115) { for (let i = 0; i < sec; i++) { this.T += 1000; const rr = 60000 / hr; (this.h.hr || []).forEach(fn => fn({ t: this.T, hr, rr: [rr, rr], contact: true })); } }
}
/** Starts a session, runs it `sec` seconds and returns what was spoken and the phase after each second. */
function run(cfg, sec) {
  spoken.length = 0; const src = new ClockSource(Date.now()); clock = src; const eng = new SessionEngine({ settings, alerts }); eng.setSource(src);
  eng.configure(cfg); eng.start(); clearInterval(eng.timer); const phases = [eng.phase];
  for (let i = 0; i < sec; i++) { src.run(1); phases.push(eng.phase); }
  eng.stop('user'); clock = null; return { said: spoken.slice(), phases };
}
/** Every later step of the plan is announced by a ramp cue ("시속 8.5로.") at exactly its second; nothing else is announced as a ramp. */
function stepsSpoken(name, plan, said) {
  const ramps = said.filter(s => /^시속 [\d.]+(으)?로\.$/.test(s.t));
  const want = plan.steps.slice(1).map(s => `${s.fromSec}:${VOICE.lt2_ramp(s.speed)}`).join(' | '), got = ramps.map(s => `${s.at}:${s.t}`).join(' | ');
  check(`${name}: the ramp cues come at the steps (${plan.steps.slice(1).map(s => s.fromSec).join(', ') || 'none'})`, want === got, `want "${want}" got "${got}"`);
}
const noRange = said => !said.some(s => /\d에서 \d/.test(s.t)); // "시속 7.0에서 7.5" was the range wording of v1.1.25
{
  // LT2 ladder, 10 min
  let cfg = { mode: 'lt2', intervals: { warmupSec: 600, reps: 2, workSec: 120, restSec: 60, cooldownSec: 360 }, targets: null, meta: { speed: 10.5, incline: 1, warmup: W } };
  let plan = warmupSteps({ mode: 'lt2', W, warmupSec: 600 }); let r = run(cfg, 1400);
  check('ladder 10 min: the start cue names every step — "워밍업 10분. 시속 7.5. 4분에 8.5, 7분에 9.5."', r.said[0].t === '워밍업 10분. 시속 7.5. 4분에 8.5, 7분에 9.5.' && r.said[0].at === 0, r.said[0].t);
  stepsSpoken('ladder 10 min', plan, r.said.filter(s => s.at < 600));
  check('ladder 10 min: the warm-up ends at its totalSec (phase work at 10:00, not before)', r.phases[599] === 'warmup' && r.phases[600] === 'work', `${r.phases[599]} ${r.phases[600]}`);
  const rest = r.said.find(s => /^회복/.test(s.t)), cool = r.said.find(s => /쿨다운/.test(s.t));
  check('ladder: the recovery cue names one speed — "회복. 시속 6.5." — when the recovery starts', rest && rest.t === '회복. 시속 6.5.' && rest.at === 720 && r.phases[720] === 'rest', JSON.stringify(rest));
  check('ladder: the cool-down cue names its two halves — "3분 시속 7.0, 3분 걷기 5.5" — the steps of cooldownSteps', cool && /쿨다운 6분\. 3분 시속 7\.0, 3분 걷기 5\.5\./.test(cool.t) && r.phases[cool.at] === 'cooldown' && brief(cooldownSteps({ W, cooldownSec: 360 })) === '360: 0=7.0, 180=walk 5.5', JSON.stringify(cool));
  check('ladder: nothing is spoken as a range', noRange(r.said), r.said.map(s => s.t).join(' | '));
  // 12 min: the start cue used to say "4분에 …, 7분에 …" whatever the length, while the ramp cues came at 6:00 and 9:00
  cfg = { ...cfg, intervals: { ...cfg.intervals, warmupSec: 720 } }; plan = warmupSteps({ mode: 'lt2', W, warmupSec: 720 }); r = run(cfg, 725);
  check('ladder 12 min: the start cue says when the ramp cues will come — "6분에 8.5, 9분에 9.5"', r.said[0].t === '워밍업 12분. 시속 7.5. 6분에 8.5, 9분에 9.5.', r.said[0].t);
  stepsSpoken('ladder 12 min', plan, r.said.filter(s => s.at < 720));
  // 5 min: no ramp
  cfg = { ...cfg, intervals: { ...cfg.intervals, warmupSec: 300 } }; plan = warmupSteps({ mode: 'lt2', W, warmupSec: 300 }); r = run(cfg, 305);
  check('ladder 5 min: the start cue promises no ramp — "워밍업 5분. 시속 7.5."', r.said[0].t === '워밍업 5분. 시속 7.5.', r.said[0].t);
  stepsSpoken('ladder 5 min', plan, r.said.filter(s => s.at < 300));
  // without the zones' speeds the old wording stays
  r = run({ ...cfg, meta: { speed: 10.5, incline: 1 } }, 5);
  check('ladder without warm-up numbers: "워밍업 5분. 쉬운 조깅."', r.said[0].t === '워밍업 5분. 쉬운 조깅.', r.said[0].t);
}
{
  // two-lap LT1 check and its MLSS variant
  const laps = { warmupSec: 300, lap1Sec: 600, lap2Sec: 1800, gapCapSec: 180, sampleAtSec: 30 };
  let plan = warmupSteps({ mode: 'verify', W, purpose: 'lt1', warmupSec: 300 }); let r = run({ mode: 'verify', laps, targets: null, meta: { speed: 8.7, incline: 1, purpose: 'lt1', warmup: W } }, 305);
  check('two-lap check: start cue "워밍업 5분. 30초 걷기 5.5, 그 다음 시속 7.0."', r.said[0].t === '워밍업 5분. 30초 걷기 5.5, 그 다음 시속 7.0.' && plan.steps[0].walk && plan.steps[0].speed === '5.5', r.said[0].t);
  stepsSpoken('two-lap check ("시속 7.0으로." at 0:30)', plan, r.said.filter(s => s.at < 300));
  check('two-lap check: lap 1 starts when the warm-up\'s totalSec is over; nothing spoken as a range', r.phases[299] === 'warmup' && r.phases[300] === 'work' && noRange(r.said));
  plan = warmupSteps({ mode: 'verify', W, purpose: 'mlss', warmupSec: 300 }); r = run({ mode: 'verify', laps: { ...laps, lap2Sec: 1200 }, targets: null, meta: { speed: 10.5, incline: 1, purpose: 'mlss', warmup: W } }, 305);
  check('MLSS variant: start cue "2분 시속 7.5, 3분 8.5"', /2분 시속 7\.5, 3분 8\.5/.test(r.said[0].t), r.said[0].t);
  stepsSpoken('MLSS variant', plan, r.said.filter(s => s.at < 300));
  plan = warmupSteps({ mode: 'verify', W, purpose: 'mlss', warmupSec: 60 }); r = run({ mode: 'verify', laps: { ...laps, warmupSec: 60 }, targets: null, meta: { speed: 10.5, incline: 1, purpose: 'mlss', warmup: W } }, 65);
  stepsSpoken('MLSS variant with a 1-min warm-up (the 2:00 step never comes)', plan, r.said.filter(s => s.at < 60));
}
{
  // easy run: the 5-min jog, then the session's one speed
  const T = sessionTargets(zones, 'lt1', { minutes: 20 });
  const plan = warmupSteps({ mode: 'lt1', W }); let r = run({ mode: 'lt1', targets: T, meta: { speed: 8.1, incline: 1, warmup: W } }, 305);
  check('easy run: start cue "워밍업 5분. 시속 7.0." = the one step', r.said[0].t === '워밍업 5분. 시속 7.0.' && brief(plan) === '300: 0=7.0', r.said[0].t);
  let main = r.said.find(s => /본 속도로/.test(s.t));
  check('easy run: "본 속도로. 시속 8.1. 판정은 10분부터." when the warm-up\'s totalSec is over (5:00) — one speed', main && main.at === plan.totalSec && main.t === '본 속도로. 시속 8.1. 판정은 10분부터.' && noRange(r.said), JSON.stringify(main));
  r = run({ mode: 'lt1', targets: T, meta: { speed: 7.5, incline: 1, warmup: W } }, 305); main = r.said.find(s => /본 속도로/.test(s.t));
  check('…the speed typed in the session\'s card is the one spoken (7.5, a long run)', main && main.t === '본 속도로. 시속 7.5. 판정은 10분부터.', JSON.stringify(main));
  r = run({ mode: 'lt1', targets: T, meta: { speed: null, incline: 1, warmup: W } }, 305); main = r.said.find(s => /본 속도로/.test(s.t));
  check('…without one, the easy speed 8.1', main && main.t === '본 속도로. 시속 8.1. 판정은 10분부터.', JSON.stringify(main));
  r = run({ mode: 'lt1', targets: T, meta: { speed: null, incline: 1 } }, 305); main = r.said.find(s => /본 속도로/.test(s.t));
  check('…and with no speeds at all, no number: "본 속도로. 판정은 10분부터."', main && main.t === '본 속도로. 판정은 10분부터.' && r.said[0].t === '워밍업 5분. 쉬운 조깅.', JSON.stringify(main));
}
{
  // step test: 5-min walk at the protocol speed, stage 1 after it
  const plan = warmupSteps({ mode: 'test', protocol: settings.protocol }); const r = run({ mode: 'test', protocol: settings.protocol, meta: { stopHr: 179 } }, 305);
  check('step test: start cue "워밍업 5분. 걷기, 시속 5.5." = the one step, a walk', r.said[0].t === '워밍업 5분. 걷기, 시속 5.5.' && brief(plan) === '300: 0=walk 5.5', r.said[0].t);
  check('step test: stage 1 starts when the warm-up\'s totalSec is over', r.phases[299] === 'warmup' && r.phases[300] === 'work' && r.said.some(s => s.at === 300 && /1단계/.test(s.t)));
}
console.log(failures ? `\n${failures} FAILED` : '\nall warm-up tests passed'); process.exit(failures ? 1 : 0);

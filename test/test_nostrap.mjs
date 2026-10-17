// node test/test_nostrap.mjs — v1.1.32: a real run without the strap (lactate only). The engine on a source that sends no heart rate;
// the two-lap verdict without heart-rate advice; the weekly band finder counts it (and moves only the LT1 speed); a demo recording
// converted with asLactateOnly (the 10/17 check: 8.9 km/h, lap 1 1.2 → end 0.8, gap 62 s); the curve and the summary without NaN.
import { SessionEngine, DEFAULT_LAPS } from '../js/session.js';
import { NoStrapSource } from '../js/sources.js';
import { lapsFromEvents } from '../js/analysis.js';
import { lactateVerdict, bandFinder, multiDayCurve, sessionMetrics, claudeSummary, asLactateOnly, setRestBaseline, setTestLowest } from '../js/prescribe.js';
let failures = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) failures++; };
const spoken = []; const alerts = { speak(t) { spoken.push(t); }, cue(t) { if (t) spoken.push(t); }, keepAwake: async () => true, beep() {}, vibrate() {} };
const settings = { protocol: {}, treadmill: {}, alpha1: { artifactMode: 'auto', windowSec: 120, stepSec: 5, lambda: 500 }, alerts: { zoneExitSec: 30 } };
const DAY = 86400000; const now = Date.now();
class ClockNoStrap extends NoStrapSource { constructor(t0) { super(); this.T = t0; this.status = 'connected'; } now() { return this.T; } }
/** A two-lap run on a source that sends nothing: the test moves the clock and ticks the engine once a second. */
function run({ speed = 8.9, lap1 = 1.2, end = 0.8, gapSec = 62, sampleAt = 40, daysAgo = 0, kind = 'nostrap', hr = null } = {}) {
  spoken.length = 0; const src = new ClockNoStrap(now - daysAgo * DAY - 3 * 3600000);
  const eng = new SessionEngine({ settings, alerts, onEvent: () => {} }); eng.setSource(src);
  eng.configure({ mode: 'verify', laps: { ...DEFAULT_LAPS }, targets: null, meta: { speed, incline: 1, purpose: 'lt1' } });
  eng.start(); clearInterval(eng.timer);
  const go = sec => { for (let i = 0; i < sec; i++) { src.T += 1000; if (hr) (src.listeners.hr || []).forEach(fn => fn({ t: src.T, hr, rr: [60000 / hr, 60000 / hr], contact: true })); eng.tick(src.T); } };
  go(300); go(601); go(sampleAt); eng.enterLactate(lap1); go(gapSec - sampleAt); eng.lap(); go(1801); go(50); eng.enterLactate(end); go(30);
  const s = eng.stop('user'); s.final = true; s.sourceKind = kind; s.id = `r${Math.random()}`; s.metrics = sessionMetrics(s); s.spoken = spoken.slice(); return s;
}
setRestBaseline(0.8); setTestLowest(null);
const Z = { lt1Hr: 143, lt1Speed: 8.7, lt2Hr: 157, lt2Speed: 10.5 };

// 1. The engine without a heart rate
const a = run();
const ph = a.events.filter(e => e.type === 'phase').map(e => e.phase).join(' ');
check('no strap: the phases run on the clock (warm-up → lap 1 → gap → lap 2 → done)', ph === 'warmup work gap work done', ph);
check('  the laps come from the phase log: 10 min, gap 62 s, 30 min', (() => { const lp = lapsFromEvents(a); return lp && Math.abs(lp.lap1Sec - 600) <= 2 && Math.abs(lp.gapSec - 62) <= 2 && Math.abs(lp.lap2Sec - 1800) <= 2; })());
check('  the voice cues are given (stop, sample, lap 2)', a.spoken.filter(t => t === '채혈하세요.').length === 2 && a.spoken.some(t => /2랩 시작/.test(t)), a.spoken.slice(0, 6).join(' | '));
check('  no heart rate is recorded or made up', a.hrLive.length === 0 && a.features.every(f => !Number.isFinite(f.hr)) && !Number.isFinite(a.metrics.meanHr));
check('  both lactate values are tagged lap 1 / lap 2', a.events.filter(e => e.type === 'lactate').map(e => e.lap).join(',') === '1,2');

// 2. Verdict
const v = lactateVerdict(a);
check('verdict (10/17 values): borderline — lap 1 1.2 within 0.2 of the line 1.3, rise −0.4', v.twoLap && v.level === 'near' && v.lap1 === 1.2 && v.end === 0.8 && v.rise === -0.4, v.en);
check('  without heart-rate advice, and says it is lactate only', v.noHr && v.adjust === null && !/target HR/.test(v.en) && !/목표 심박/.test(v.ko) && /no strap/.test(v.en) && /스트랩 없음/.test(v.ko), v.en);
check('  with the strap, the same values keep the advice (unchanged behaviour)', /target HR −2 bpm/.test(lactateVerdict(run({ kind: 'ble', hr: 140 })).en));

// 3. Band finder
const bf = bandFinder([a], Z);
check('band finder counts a no-strap check: last 8.9 borderline → this week 8.9', bf.from === 'result' && bf.last.speed === 8.9 && bf.last.level === 'near' && bf.nextSpeed === 8.9, bf.en);
const p1 = run({ lap1: 1.0, end: 0.9, daysAgo: 7 }), p2 = run({ lap1: 1.0, end: 0.9, daysAgo: 0 });
const bf2 = bandFinder([p1, p2], Z);
check('two no-strap passes at 8.9: the band change moves the LT1 speed only (heart rate kept at 143)', bf2.change && bf2.change.zones.lt1Speed === 8.9 && bf2.change.zones.lt1Hr === 143 && bf2.change.keys.join() === 'lt1Speed', bf2.change && bf2.change.en);

// 4. A demo recording converted (what the owner did on 10/17)
const demo = run({ kind: 'demo', hr: 137 });
check('demo recording: made-up heart rate 137, left out of the band finder', demo.hrLive.length > 2000 && Math.round(demo.metrics.meanHr) === 137 && bandFinder([demo], Z).from === 'zones');
const c = asLactateOnly(demo);
check('converted: source nostrap (from demo), heart rate / RR / α1 removed, times and events kept', c.sourceKind === 'nostrap' && c.convertedFrom === 'demo' && c.hrLive.length === 0 && c.rr.length === 0 && c.features.length === demo.features.length && c.features.every(f => !Number.isFinite(f.hr) && !Number.isFinite(f.alpha1)) && c.events.length === demo.events.length && c.startedAt === demo.startedAt && c.speed === 8.9);
check('  metrics: no heart rate, the duration kept', !Number.isFinite(c.metrics.meanHr) && !Number.isFinite(c.metrics.maxHr) && Math.abs(c.metrics.durationSec - demo.metrics.durationSec) < 1);
check('  the original is not changed', demo.sourceKind === 'demo' && demo.hrLive.length > 0);
const vc = lactateVerdict(c);
check('  same lactate verdict (borderline, gap ≈ 62 s), now without heart-rate advice', vc.level === 'near' && Math.abs(vc.gapSec - 62) <= 1.5 && vc.noHr && !Number.isFinite(vc.lap1Hr), vc.en);
check('  now counted by the band finder → 8.9 this week', bandFinder([c], Z).nextSpeed === 8.9 && bandFinder([c], Z).from === 'result');

// 5. Curve and summary
const curve = multiDayCurve([c, p1]);
check('multi-day curve: no-strap runs are points, without a heart rate, no NaN in the speeds', (curve.points || []).length >= 1 && curve.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.la)), JSON.stringify((curve.points || []).map(p => [p.x, p.la, p.hr])));
const txt = claudeSummary({ profile: { age: 29 }, zones: Z, session: c, metrics: c.metrics });
check('summary: source nostrap, heart rate n/a, no NaN', /source nostrap/.test(txt) && /mean HR n\/a/.test(txt) && !/NaN/.test(txt) && /no strap/.test(txt), txt.split('\n').filter(l => /NaN/.test(l)).join(' | ').slice(0, 200));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS'); process.exit(failures ? 1 : 0);

// node test/test_cadence.mjs — v1.1.33: how often the two-lap LT1 check runs. Weekly while the search moves; once the last two checks
// at the same speed gave the same verdict the band has settled → every 4 weeks, Thursdays in between are easy runs; a later check
// that disagrees puts it back to weekly. Rebuilt from the owner's checks: 10/11 pass @ 8.7, 10/17 borderline @ 8.9.
import { SessionEngine, DEFAULT_LAPS } from '../js/session.js';
import { NoStrapSource } from '../js/sources.js';
import { bandFinder, checkCadence, checkDueInWeek, weeklyPlan, sessionMetrics, setRestBaseline, setTestLowest, MAINT_DAYS } from '../js/prescribe.js';
let failures = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) failures++; };
const alerts = { speak() {}, cue() {}, keepAwake: async () => true, beep() {}, vibrate() {} };
const settings = { protocol: {}, treadmill: {}, alpha1: { artifactMode: 'auto', windowSec: 120, stepSec: 5, lambda: 500 }, alerts: { zoneExitSec: 30 } };
const DAY = 86400000; const now = Date.now();
class Clock extends NoStrapSource { constructor(t0) { super(); this.T = t0; this.status = 'connected'; } now() { return this.T; } }
function run(speed, lap1, end, daysAgo) {
  const src = new Clock(now - daysAgo * DAY - 4 * 3600000); const eng = new SessionEngine({ settings, alerts, onEvent: () => {} }); eng.setSource(src);
  eng.configure({ mode: 'verify', laps: { ...DEFAULT_LAPS }, targets: null, meta: { speed, incline: 1, purpose: 'lt1' } }); eng.start(); clearInterval(eng.timer);
  const go = sec => { for (let i = 0; i < sec; i++) { src.T += 1000; eng.tick(src.T); } };
  go(300); go(601); go(40); eng.enterLactate(lap1); go(30); eng.lap(); go(1801); go(45); eng.enterLactate(end); go(20);
  const s = eng.stop('user'); s.final = true; s.sourceKind = 'nostrap'; s.id = `c${daysAgo}-${lap1}-${end}-${Math.random()}`; s.metrics = sessionMetrics(s); return s;
}
setRestBaseline(0.8); setTestLowest(null);
const Z = { lt1Hr: 143, lt1Speed: 8.7, lt2Hr: 157, lt2Speed: 10.5 };
const oct11 = run(8.7, 0.9, 0.8, 14), oct17 = run(8.9, 1.2, 0.8, 7);

const b1 = bandFinder([oct11, oct17], Z);
check('10/11 pass @ 8.7, 10/17 borderline @ 8.9: still weekly (different speeds), next 8.9', b1.cadence.mode === 'weekly' && b1.nextSpeed === 8.9 && /매주/.test(b1.ko), b1.en);
check('  weekly: every week is a check week', checkDueInWeek(b1.cadence, '2026-10-26') && checkDueInWeek(b1.cadence, '2026-11-02'));

const again = run(8.9, 1.1, 0.9, 0);
const b2 = bandFinder([oct11, oct17, again], Z);
const dueDays = Math.round((b2.cadence.due - new Date(new Date(again.startedAt).setHours(0, 0, 0, 0)).getTime()) / DAY);
check('a second borderline @ 8.9: settled → every 4 weeks, due 28 days after the last check', b2.cadence.mode === 'maintenance' && dueDays === MAINT_DAYS && /4주마다/.test(b2.ko) && /every 4 weeks/.test(b2.en), b2.en);
check('  the speed stays 8.9 and no band change (borderlines change nothing)', b2.nextSpeed === 8.9 && !b2.change);
const mondayOf = t => { const d = new Date(t); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const wk = k => mondayOf(again.startedAt + k * 7 * DAY);
check('  the next three weeks are off, the 4th week is the check week', !checkDueInWeek(b2.cadence, wk(1)) && !checkDueInWeek(b2.cadence, wk(2)) && !checkDueInWeek(b2.cadence, wk(3)) && checkDueInWeek(b2.cadence, wk(4)), [1, 2, 3, 4].map(k => `${wk(k)}:${checkDueInWeek(b2.cadence, wk(k))}`).join(' '));
check('  overdue (a later week) is still due', checkDueInWeek(b2.cadence, wk(6)));

const off = weeklyPlan({ zones: Z, week: 2, verifySpeed: 8.9, verifyDue: false, verifyNext: '11/19' });
const thu = off.days.find(d => d.day === 4);
check('plan in an off week: Thursday is an easy run, saying when the next check is', thu.type === 'lt1' && /LT1 검사 없는 주/.test(thu.ko) && /11\/19/.test(thu.note.ko) && /11\/19/.test(thu.note.en) && thu.speed === 8.1, `${thu.ko} | ${thu.note.en.slice(0, 80)}`);
const on = weeklyPlan({ zones: Z, week: 2, verifySpeed: 8.9, verifyDue: true });
check('plan in a check week: Thursday is the two-lap check at 8.9 (as before)', on.days.find(d => d.day === 4).type === 'verify' && on.days.find(d => d.day === 4).speed === 8.9);
check('  the default (no cadence given) is the check, unchanged behaviour', weeklyPlan({ zones: Z, week: 2, verifySpeed: 8.9 }).days.find(d => d.day === 4).type === 'verify');
const blood = weeklyPlan({ zones: Z, week: 2, verifyDue: false, kinds: ['blood'] });
check('  a blood-test week stays a rest morning', blood.days.find(d => d.day === 4).type === 'rest');

// a maintenance check that disagrees → weekly again
const s1 = run(8.9, 1.2, 0.8, 35), s2 = run(8.9, 1.1, 0.9, 28), later = run(8.9, 0.9, 0.9, 0);
const b3 = bandFinder([s1, s2, later], Z);
check('4 weeks later a pass @ 8.9 (after two borderlines): back to weekly, next 9.0 (the cap)', b3.cadence.mode === 'weekly' && b3.nextSpeed === 9.0, b3.en);
const b4 = bandFinder([s1, s2, run(8.9, 1.2, 0.9, 0)], Z);
check('4 weeks later borderline again: stays every 4 weeks', b4.cadence.mode === 'maintenance');
check('no results: weekly', checkCadence([]).mode === 'weekly' && bandFinder([], Z).cadence.mode === 'weekly');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS'); process.exit(failures ? 1 : 0);

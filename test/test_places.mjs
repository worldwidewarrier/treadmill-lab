// v1.1.36 — places: weekdays at the unit (track, hill, non-motorized treadmill), weekends at the gym (motorized treadmill, StairMaster).
// What the plan says per day, what a session's place does to the verdicts and the curve, the satoff calendar kind, the engine's record.
import { computeZones, weeklyPlan, lapTime, onBelt, PLACES, SURFACES, parseCalendar, planContext, lactateVerdict, verdictZoneChange, multiDayCurve, bandFinder, mlssPasses } from '../js/prescribe.js';
import { SessionEngine } from '../js/session.js';
let failures = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) failures++; };
const now = Date.now();
const Z = computeZones({ lt1Hr: 143, lt2Hr: 157, lt1Speed: 8.7, lt2Speed: 10.5, maxHr: 188, pace3k: 14.1 });

// ── lap pace ──
check('lapTime: 10.5 → 2:17, 13.0 → 1:51, 14.1 → 1:42, 12.0 → 2:00, 7.7 → 3:07 per 400 m; nothing for no speed', lapTime(10.5) === '2:17' && lapTime(13) === '1:51' && lapTime(14.1) === '1:42' && lapTime(12) === '2:00' && lapTime(7.7) === '3:07' && lapTime(null) === '–' && lapTime(0) === '–');
check('onBelt: an old session without the field, a treadmill session → yes; track / non-motorized → no', onBelt({}) && onBelt({ surface: 'treadmill' }) && !onBelt({ surface: 'outdoor' }) && !onBelt({ surface: 'nmt' }) && SURFACES.join() === 'treadmill,outdoor,nmt' && PLACES.gym.surface === 'treadmill' && PLACES.hill.surface === 'outdoor');

// ── the week ──
const p1 = weeklyPlan({ zones: Z, week: 1 }), p2 = weeklyPlan({ zones: Z, week: 2 });
const D = (p, d) => p.days.find(x => x.day === d);
check('weekdays at the unit, the weekend at the gym', [1, 2, 3, 4, 5].every(d => D(p1, d).surface === 'outdoor') && [6, 0].every(d => D(p1, d).place === 'gym' && D(p1, d).surface === 'treadmill'), JSON.stringify(p1.days.map(d => [d.day, d.place])));
check('every check that needs a fixed speed is on the weekend belt (two-lap check Sat, MLSS Sat, step test Sat)', D(p1, 6).type === 'verify' && D(weeklyPlan({ zones: Z, week: 1, kinds: ['mlss'] }), 6).purpose === 'mlss' && D(weeklyPlan({ zones: Z, week: 1, kinds: ['step'] }), 6).type === 'test' && !p1.days.some(d => d.surface !== 'treadmill' && (d.type === 'verify' || d.type === 'test')));
check('the track ladder: 4×8 at 2:17 per 400 m (10.5 km/h) ≈ 1400 m a rep, no lactate on the track', D(p1, 2).place === 'track' && D(p1, 2).lap === '2:17' && /2:17 per 400 m \(= 10\.5 km\/h, MLSS speed; ≈ 1400 m a rep\)/.test(D(p1, 2).note.en) && /no lactate on the track/.test(D(p1, 2).note.en));
check('the hill 4×4 (600 m up + 170 m flat): stop where you are at 4:00, mark it, HR 169–179, jog back down, the track fallback 13.0 = 1:51 per 400 m ≈ 870 m, rain or ice → non-motorized', (() => { const t = D(p2, 2); const n = t.note.en; return t.place === 'hill' && t.kind === 'vo2' && /hill reps 4×4/.test(t.en) && /stop where you are at 4:00 — mark that spot/.test(n) && /HR target 169–179/.test(n) && /jog back down, about 3 min/.test(n) && /end of the 770 m before 4:00/.test(n) && /1:51 per 400 m \(13\.0 km\/h, ≈ 870 m a rep\)/.test(n) && /rain or ice → 4 × 4 min on the non-motorized treadmill, HR only/.test(n); })(), D(p2, 2).note.en.slice(0, 200));
check('the unit easy days run by heart rate: no speed, the warm-up line, the non-motorized rules (≤ 30 min for 2 weeks, calf/Achilles > 2/10)', [1, 3, 4].every(d => { const x = D(p1, d); return x.speed === null && /heart rate instead of speed/.test(x.note.en) && /first 2 weeks ≤ 30 min per run/.test(x.note.en) && /ignore its speed display/.test(x.note.en); }));
check('Mon and Wed at the low end (HR ≤ 133), Thu in the band 133–140', D(p1, 1).slow && D(p1, 3).slow && D(p1, 1).hr.hrHi === 133 && D(p1, 3).hr.hrHi === 133 && !D(p1, 4).slow && D(p1, 4).hr.hrLo === 133 && D(p1, 4).hr.hrHi === 140 && D(p1, 4).minutes === 45);
check('Saturday off-week: an easy 50 on the belt + optional StairMaster (HR ≤ 140)', (() => { const s = D(weeklyPlan({ zones: Z, week: 1, verifyDue: false }), 6); return s.type === 'lt1' && s.minutes === 50 && s.speed === 8.1 && /StairMaster 20 min/.test(s.note.en) && /HR ≤ 140/.test(s.note.en); })());
check('Sunday: the long run, except after a step test or an MLSS check (easy 50)', D(p1, 0).type === 'long' && D(weeklyPlan({ zones: Z, week: 1, kinds: ['step'] }), 0).type === 'lt1' && D(weeklyPlan({ zones: Z, week: 1, kinds: ['mlss'] }), 0).minutes === 50);
check('a blood week: Thursday no run, the Saturday check stays', D(weeklyPlan({ zones: Z, week: 2, kinds: ['blood'] }), 4).type === 'rest' && D(weeklyPlan({ zones: Z, week: 2, kinds: ['blood'] }), 6).type === 'verify');
check('satoff: Saturday rest, its session (here the step test) on Sunday, no long run that week', (() => { const p = weeklyPlan({ zones: Z, week: 1, kinds: ['step', 'satoff'], notes: ['exam'] }); return D(p, 6).type === 'rest' && /exam/.test(D(p, 6).note.en) && D(p, 0).type === 'test' && D(p, 0).day === 0 && !p.days.some(d => d.type === 'long'); })());
check('satoff in a check week: the two-lap check moves to Sunday', D(weeklyPlan({ zones: Z, week: 1, kinds: ['satoff'] }), 0).type === 'verify');
check('the weekday sessions still fit the hour', p1.days.filter(d => d.day >= 1 && d.day <= 5).every(d => d.minutes <= 60) && p2.days.filter(d => d.day >= 1 && d.day <= 5).every(d => d.minutes <= 60));

// ── calendar ──
const cal = '2026-10-12 recovery\n2026-10-19 mlss MLSS check (Sun 10/25)\n2026-10-19 satoff TOEIC Sat 10/24\n2026-10-26 step step test\n2026-11-09 blood';
check('parseCalendar keeps satoff next to mlss in the same week', parseCalendar(cal)['2026-10-19'].kinds.join() === 'mlss,satoff');
const ctx = d => planContext({ startDate: '2026-10-12', calendar: cal, now: new Date(d + 'T12:00:00') });
const run = d => { const c = ctx(d); return weeklyPlan({ zones: Z, week: c.ladderWeek, blockWeek: c.blockWeek, longWeek: c.longWeek, kinds: c.kinds, notes: c.notes }); };
check('the week of 10/19: Tue easy, Sat 10/24 rest (TOEIC), Sun 10/25 the MLSS check, no long run', (() => { const p = run('2026-10-21'); return D(p, 2).type === 'lt1' && D(p, 6).type === 'rest' && D(p, 0).purpose === 'mlss' && !p.days.some(d => d.type === 'long'); })());
check('the week of 10/26: Sat 10/31 step test, Sun 11/1 easy 50; the long run returns on 11/8 at 80 (longWeek 2)', (() => { const p = run('2026-10-28'), q = run('2026-11-04'); return D(p, 6).type === 'test' && D(p, 0).type === 'lt1' && D(p, 0).minutes === 50 && D(q, 0).type === 'long' && D(q, 0).minutes === 80; })(), [run('2026-11-04').days[6].minutes, ctx('2026-11-04').longWeek].join());

// ── sessions off the belt ──
const mk = (type, speed, { surface, end = null, mid = null, purpose, daysAgo = 1, dur = 1800, laps } = {}) => {
  const t0 = now - daysAgo * 86400000; const hrLive = []; for (let i = 0; i < dur; i++) hrLive.push([t0 + i * 1000, 140]);
  const events = [{ t: t0, type: 'phase', phase: 'work' }]; if (mid != null) events.push({ t: t0 + 600000, type: 'lactate', value: mid }); if (end != null) events.push({ t: t0 + dur * 1000 - 60000, type: 'lactate', value: end });
  return { id: `${type}${speed}${surface}${daysAgo}`, type, final: true, sourceKind: 'ble', startedAt: t0, endedAt: t0 + dur * 1000, speed, incline: 1, hrLive, features: [], events, ...(surface ? { surface } : {}), ...(purpose ? { purpose } : {}), ...(laps ? { laps } : {}) };
};
const belt = mk('lt1', 8.0, { end: 1.2, daysAgo: 3 }), track = mk('lt1', 9.5, { surface: 'outdoor', end: 3.0, daysAgo: 2 }), nmt = mk('lt1', 6.0, { surface: 'nmt', end: 1.0, daysAgo: 1 });
check('a track session with lactate still gets its verdict text, but moves no zone', lactateVerdict(track) && verdictZoneChange(Z, track) === null && verdictZoneChange(Z, nmt) === null);
check('…a belt session with the same verdict can (the rule is unchanged)', (() => { const s = mk('lt1', 9.5, { end: 3.0, daysAgo: 2 }); return lactateVerdict(s).level === 'high' && verdictZoneChange(Z, s) !== null; })());
const md = multiDayCurve([belt, track, nmt]);
check('the multi-day curve takes the belt session and lists the track / non-motorized ones as off-belt', md.points.length === 1 && md.points[0].x === 8.0 && md.skipped.filter(k => k.why === 'off-belt').length === 2, JSON.stringify({ pts: md.points.map(p => p.x), skipped: md.skipped.map(k => k.why) }));
check('an MLSS session off the belt does not count as a pass (the same run on the belt does)', mlssPasses([mk('lt2', 10.5, { surface: 'outdoor', mid: 3.0, end: 3.2, purpose: 'mlss' })], 10.5).passes === 0 && mlssPasses([mk('lt2', 10.5, { surface: 'outdoor', mid: 3.0, end: 3.2, purpose: 'mlss' })], 10.5).results.length === 0 && mlssPasses([mk('lt2', 10.5, { mid: 3.0, end: 3.2, purpose: 'mlss' })], 10.5).passes === 1);
check('the band finder ignores a two-lap run off the belt', bandFinder([{ ...mk('verify', 8.9, { surface: 'nmt', mid: 1.0, end: 1.1 }) }], Z).from === 'zones');

// ── the engine writes the place into the record ──
{
  const e = new SessionEngine({ settings: { alpha1: {}, alerts: {} } });
  e.configure({ mode: 'lt1', targets: { hrLo: 133, hrHi: 140, durationSec: 600 }, meta: { speed: null, surface: 'nmt' } });
  const a = e.snapshot(false).surface;
  e.configure({ mode: 'lt1', targets: { hrLo: 133, hrHi: 140, durationSec: 600 }, meta: { speed: 8.1 } });
  const b = e.snapshot(false).surface;
  check('the session record carries surface (nmt as chosen; treadmill when none is given)', a === 'nmt' && b === 'treadmill', `${a} ${b}`);
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS'); process.exit(failures ? 1 : 0);

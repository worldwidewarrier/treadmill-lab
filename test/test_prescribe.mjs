import { setAlphaUse } from '../js/analysis.js';
import { computeZones, sessionTargets, weeklyPlan, lt2Structure, isRecoveryWeek, sessionMetrics, assessRecent, sessionSummaryText, claudeSummary } from '../js/prescribe.js';
let failures = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) failures++; };
const zones = computeZones({ lt1Hr: 146, lt2Hr: 167, lt1Speed: 9.9, lt2Speed: 12.0, maxHr: 188 });
check('zones computed', zones && zones.five.length === 5 && zones.three.length === 3);
check('five-zone boundaries contiguous', zones.five.every((z, i) => i === 0 || z.hrLo === zones.five[i - 1].hrHi + 1), zones.five.map(z => `${z.hrLo}-${z.hrHi}`).join(' '));
const t1 = sessionTargets(zones, 'lt1'); check('LT1 target band 136–143', t1.hrLo === 136 && t1.hrHi === 143 && t1.alphaMin === 0.75, JSON.stringify(t1));
const t2 = sessionTargets(zones, 'lt2'); check('LT2 target band 164–170', t2.hrLo === 164 && t2.hrHi === 170, JSON.stringify(t2));
for (const w of [1, 2, 3, 4, 5, 6, 7, 8, 9]) { const p = weeklyPlan({ zones, week: w, weekdayMin: 60, weekendMin: 150, goal: 'base' }); console.log(`week ${w}${p.recovery ? ' (rec)' : ''}: total ${p.totalMin} min, hard ${p.hardPct}%, long ${p.days[5].minutes} min, wed ${p.days[2].en}`); }
const p1 = weeklyPlan({ zones, week: 1, weekdayMin: 60, weekendMin: 150 });
check('week 1 has one LT2 day and six LT1-type days', p1.days.filter(d => d.type === 'lt2').length === 1 && p1.days.length === 7);
check('weekday sessions fit 60 min', p1.days.filter(d => [1, 2, 4, 5].includes(d.day)).every(d => d.minutes <= 60));
check('hard share ≤ 25%', p1.hardPct <= 25, p1.hardPct + '%');
check('recovery week 4 has no LT2', weeklyPlan({ zones, week: 4 }).days.every(d => d.type !== 'lt2') && isRecoveryWeek(4));
check('LT2 progression 4×8 → 4×10 → 5×10', lt2Structure(1).reps === 4 && lt2Structure(1).workSec === 480 && lt2Structure(2).workSec === 600 && lt2Structure(3).reps === 5);
// metrics + insights on fake sessions
const now = Date.now();
const fakeSession = (a1, drift, daysAgo) => { const hr = []; for (let i = 0; i < 3000; i++) hr.push([now - daysAgo * 86400000 + i * 1000, 138 + (i / 3000) * drift]); return { type: 'lt1', final: true, startedAt: now - daysAgo * 86400000, endedAt: now - daysAgo * 86400000 + 3000000, hrLive: hr, features: Array.from({ length: 500 }, (_, i) => ({ t: 0, alpha1: a1, phase: 'work', artifactPct: 1 })), tiz: { inSec: 2400, totalSec: 3000 }, rr: [] }; };
const m = sessionMetrics(fakeSession(0.65, 10, 1)); check('metrics drift ≈ +4.2% (first 5 min excluded)', Math.abs(m.driftPct - 4.15) < 0.3, m.driftPct.toFixed(2));
const ins = assessRecent([fakeSession(0.65, 2, 1), fakeSession(0.66, 1, 3)], zones, now - 70 * 86400000);
check('low α1 → −3 bpm adjust', ins.lt1Adjust === -3, JSON.stringify(ins.notes.map(n => n.en)));
check('retest flagged at 10 weeks', ins.retest === true);
const insDemo = assessRecent([{ ...fakeSession(0.65, 2, 1), sourceKind: 'demo' }, { ...fakeSession(0.66, 1, 3), sourceKind: 'demo' }], zones, now - 7 * 86400000);
check('practice sessions on the demo strap never adjust the real targets', insDemo.lt1Adjust === 0 && insDemo.sessionsConsidered === 0, JSON.stringify(insDemo.notes.map(n => n.en)));
const txt = sessionSummaryText(fakeSession(0.65, 2, 1), m, zones); check('summary text bilingual', /LT1보다 높은/.test(txt.ko) && /Harder than LT1/.test(txt.en));
const cs = claudeSummary({ profile: { age: 29, restHr: 52, maxHr: 188 }, zones: { ...zones, grade: 'B' }, session: fakeSession(0.8, 1, 0), metrics: m, plan: p1 });
check('claude summary has sections', /Thresholds/.test(cs) && /Plan week 1/.test(cs));
// α1 guidance switched off (Settings → α1, default since v1.1.14): no target change, no α1 verdict, the summary says to ignore α1
setAlphaUse(false);
const insOff = assessRecent([fakeSession(0.65, 2, 1), fakeSession(0.66, 1, 3)], zones, now - 70 * 86400000);
check('α1 off: low α1 no longer lowers the LT1 target', insOff.lt1Adjust === 0 && !insOff.notes.some(n => /α1/.test(n.en)), JSON.stringify(insOff.notes.map(n => n.en)));
const txtOff = sessionSummaryText(fakeSession(0.65, 2, 1), m, zones);
check('α1 off: no α1 line or "harder than LT1" verdict in the session text', !/α1/.test(txtOff.ko + txtOff.en) && !/Harder than LT1/.test(txtOff.en), txtOff.en);
const csOff = claudeSummary({ profile: { age: 29, restHr: 52, maxHr: 188 }, zones: { ...zones, grade: 'B' }, session: fakeSession(0.8, 1, 0), metrics: m, plan: p1 });
check('α1 off: the copied summary keeps the α1 numbers but says not to use them', /mean α1/.test(csOff) && /switched OFF/.test(csOff));
setAlphaUse(true);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS'); process.exit(failures ? 1 : 0);

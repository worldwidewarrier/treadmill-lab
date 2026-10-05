// node test/test_analysis.mjs — synthetic step test through summarizeStages → HRVT / SmO2 / triangulation
import { analyzeSession, hrvThresholds, smo2Breakpoints, agreement, triangulate } from '../js/analysis.js';
let failures = 0;
const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) failures++; };

// Ground truth model: speed 6..14, HR = 70 + 8.5*speed (approx), a1 = 1.15 - 0.075*(speed-6) clipped, lactate exponential, SmO2 piecewise
const truth = s => ({
  hr: 60 + 8.6 * s,
  a1: Math.max(0.35, Math.min(1.25, 1.2 - 0.09 * (s - 6))),        // a1=0.75 at s=11, 0.5 at s≈13.8
  la: 0.9 + 0.08 * Math.exp(0.55 * (s - 8)),
  smo2: s <= 9 ? 70 - 0.4 * (s - 6) : (s <= 12 ? 68.8 - 2.5 * (s - 9) : 61.3 - 0.3 * (s - 12)),
});
const t0 = 1_790_000_000_000; const stageSec = 180, pauseSec = 30;
const session = { stages: [], features: [], hrLive: [], smo2: { series: [], offsetMs: 0 } };
let t = t0;
for (let i = 0, s = 6; s <= 14; i++, s++) {
  const tr = truth(s); const tStart = t, tEnd = t + stageSec * 1000;
  session.stages.push({ idx: i, speed: s, incline: 1, tStart, tEnd, lactate: Math.round(tr.la * 10) / 10, rpe: 8 + i });
  for (let k = 0; k < stageSec; k += 5) { // features every 5 s with a little noise
    const frac = k / stageSec; const hr = tr.hr - 6 * Math.exp(-frac * 6); // cardiac lag early in the stage
    session.features.push({ t: tStart + k * 1000, alpha1: tr.a1 + 0.03 * Math.sin(k), hr, artifactPct: 1 });
  }
  for (let k = 0; k < stageSec * 10; k++) session.smo2.series.push([tStart + k * 100, tr.smo2 + 0.3 * Math.sin(k / 7), 55]);
  t = tEnd + pauseSec * 1000;
}
const r = analyzeSession(session);
console.log('stage rows:', r.rows.map(x => `${x.speed}km/h hr${x.hr.toFixed(0)} a1 ${x.alpha1.toFixed(2)} la ${x.lactate} smo2 ${x.smo2.toFixed(1)}`).join(' | '));
check('9 stage rows', r.rows.length === 9);
check('HRVT1 near speed 11 (a1=0.75)', r.hrv.hrvt1 && Math.abs(r.hrv.hrvt1.speed - 11) < 0.4, JSON.stringify(r.hrv.hrvt1));
check('HRVT2 near speed 13.8 (a1=0.5)', r.hrv.hrvt2 && Math.abs(r.hrv.hrvt2.speed - 13.8) < 0.5, JSON.stringify(r.hrv.hrvt2));
check('HRVT regression used transition region', r.hrv.fit && r.hrv.fit.usedTransitionOnly === true, `r2=${r.hrv.fit?.r2?.toFixed(3)}`);
check('SmO2 BP1 near 9', r.smo2.bp1 && Math.abs(r.smo2.bp1.speed - 9) < 0.6, JSON.stringify(r.smo2.bp1));
check('SmO2 BP2 near 12', r.smo2.bp2 && Math.abs(r.smo2.bp2.speed - 12) < 0.6, JSON.stringify(r.smo2.bp2));
check('lactate LT1 defined', r.lactate && isFinite(r.lactate.lt1Primary.x), `LT1 ${r.lactate?.lt1Primary.x?.toFixed(2)} km/h hr ${r.lactate?.lt1Primary.hr?.toFixed(0)}`);
check('lactate LT2 defined', r.lactate && isFinite(r.lactate.lt2Primary.x), `LT2 ${r.lactate?.lt2Primary.x?.toFixed(2)} km/h hr ${r.lactate?.lt2Primary.hr?.toFixed(0)}`);
check('triangulation anchors on lactate', r.tri.lt1.source === 'lactate' && r.tri.lt2.source === 'lactate');
console.log('tri LT1', r.tri.lt1.hr.toFixed(0), 'bpm grade', r.tri.grade1, 'others', r.tri.lt1.others.map(o => `${o.src}:${o.hr.toFixed(0)}(${o.label})`).join(','));
console.log('tri LT2', r.tri.lt2.hr.toFixed(0), 'bpm grade', r.tri.grade2, 'others', r.tri.lt2.others.map(o => `${o.src}:${o.hr.toFixed(0)}(${o.label})`).join(','));
check('grades assigned', ['A', 'B', 'C'].includes(r.tri.grade1) && ['A', 'B', 'C'].includes(r.tri.grade2));
check('agreement labels', agreement(150, 154).label === 'agree' && agreement(150, 158).label === 'caution' && agreement(150, 165).label === 'disagree');
// no-lactate fallback: HRV-only triangulation
const s2 = JSON.parse(JSON.stringify(session)); s2.stages.forEach(s => delete s.lactate); delete s2.smo2;
const r2 = analyzeSession(s2);
check('no lactate → anchor = hrv, grade C', r2.tri.lt1 && r2.tri.lt1.source === 'hrv' && r2.tri.grade1 === 'C', `${r2.tri.lt1?.source} ${r2.tri.grade1}`);
// too-easy test: a1 never below 0.75
const s3 = JSON.parse(JSON.stringify(session)); s3.features.forEach(f => f.alpha1 = Math.max(f.alpha1, 0.9));
const r3 = hrvThresholds(analyzeSession(s3).rows);
check('a1 never crossing → hrvt1 null with note', r3.hrvt1 === null && /never/.test(r3.note), r3.note);
// stages that came from imported laps have no speed: thresholds keep their heart rate, the speed is unknown — never 0 km/h
{ const rows = [1.2, 1.0, 0.85, 0.68, 0.52, 0.4].map((a, i) => ({ idx: i + 1, speed: null, incline: 1, hr: 120 + 10 * i, alpha1: a, artifactPct: 1 }));
  const h = hrvThresholds(rows); check('no stage speeds → HRVT1 has a heart rate and an unknown speed', h.hrvt1 && Number.isFinite(h.hrvt1.hr) && Number.isNaN(h.hrvt1.speed), JSON.stringify(h.hrvt1));
  const noisy = [1.2, 1.25, 0.7, 1.1, 0.45, 1.0].map((a, i) => ({ idx: i + 1, speed: null, incline: 1, hr: 120 + 10 * i, alpha1: a, artifactPct: 1 }));
  const h2 = hrvThresholds(noisy); check('…also on the first-crossing path (weak fit)', h2.hrvt1 && h2.hrvt1.how === 'interp' && Number.isNaN(h2.hrvt1.speed), JSON.stringify(h2.hrvt1));
  const tri = triangulate({ lactate: null, hrv: h, smo2: null, stageCount: 6 }); check('…and the triangulated threshold carries no made-up speed', tri.lt1 && Number.isNaN(tri.lt1.speed), JSON.stringify(tri.lt1 && { hr: tri.lt1.hr, speed: tri.lt1.speed })); }
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);

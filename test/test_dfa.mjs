// node test/test_dfa.mjs  — cross-validates js/dfa.js against test/ref_dfa.py and known values
import { dfaAlpha, alpha1FatMaxxer, smoothnessPriors, FATMAXXER_SCALES, ArtifactFilter, Alpha1Window } from '../js/dfa.js';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail = '') { console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : '')); if (!cond) failures++; }

// 1) FatMaxxer self-test vector (dfaAlpha1V1 with smoothN=false, hard-coded scales) → 1.5503173309573208
const selfTest = [635.0, 628.0, 627.0, 625.0, 624.0, 627.0, 624.0, 623.0, 633.0, 636.0, 633.0, 628.0, 625.0, 628.0, 622.0, 621.0, 613.0, 608.0, 604.0, 612.0, 620.0, 616.0, 611.0, 616.0, 614.0, 622.0, 627.0, 625.0, 622.0, 617.0, 620.0, 622.0, 623.0, 615.0, 614.0, 627.0, 630.0, 632.0, 632.0, 632.0, 631.0, 627.0, 629.0, 634.0, 628.0, 625.0, 629.0, 633.0, 632.0, 628.0, 631.0, 631.0, 628.0, 623.0, 619.0, 618.0, 618.0, 628.0, 634.0, 631.0, 626.0, 633.0, 637.0, 636.0, 632.0, 634.0, 625.0, 614.0, 610.0, 607.0, 613.0, 616.0, 622.0, 625.0, 620.0, 633.0, 640.0, 639.0, 631.0, 626.0, 634.0, 628.0, 615.0, 610.0, 607.0, 611.0, 613.0, 614.0, 611.0, 608.0, 627.0, 625.0, 619.0, 618.0, 622.0, 625.0, 626.0, 625.0, 626.0, 624.0, 631.0, 631.0, 619.0, 611.0, 608.0, 607.0, 602.0, 586.0, 583.0, 576.0, 580.0, 571.0, 583.0, 591.0, 598.0, 607.0, 607.0, 621.0, 619.0, 622.0, 613.0, 604.0, 607.0, 603.0, 604.0, 598.0, 595.0, 592.0, 589.0, 594.0, 594.0, 602.0, 611.0, 614.0, 634.0, 635.0, 636.0, 628.0, 627.0, 628.0, 626.0, 619.0, 616.0, 616.0, 622.0, 615.0, 607.0, 611.0, 610.0, 619.0, 624.0, 625.0, 626.0, 633.0, 643.0, 647.0, 644.0, 644.0, 642.0, 645.0, 637.0, 628.0, 632.0, 633.0, 625.0, 626.0, 623.0, 620.0, 620.0, 610.0, 612.0, 612.0, 610.0, 614.0, 611.0, 609.0, 616.0, 624.0, 623.0, 618.0, 622.0, 623.0, 625.0, 629.0, 621.0, 622.0, 617.0, 619.0, 618.0, 610.0, 607.0, 606.0, 611.0];
const a = dfaAlpha(selfTest, FATMAXXER_SCALES);
check('FatMaxxer self-test vector', Math.abs(a - 1.5503173309573208) < 1e-9, `got ${a}`);

// 2) Windows from the owner's FatMaxxer RR file (private fixture, see test/data/README.md) + synthetic signals, compared with the Python reference
const fixture = join(here, 'data', 'fatmaxxer_rr_121156.csv'); const haveFixture = existsSync(fixture);
const csv = haveFixture ? readFileSync(fixture, 'utf8').split('\n').slice(2).filter(Boolean).map(l => l.split(',').map(Number)) : [];
// csv rows: [timestamp(ms), rr, since_start]
const windows = {};
const starts = [200, 300, 500, 800, 1200, 1600, 2000, 2400];
if (haveFixture) for (const idx of starts) {
  const tEnd = csv[idx][0];
  const w = csv.filter(r => r[0] > tEnd - 120000 && r[0] <= tEnd).map(r => r[1]);
  windows['w' + idx] = w;
}
else console.log('SKIP FatMaxxer-file windows (test/data/fatmaxxer_rr_121156.csv not present) — a synthetic RR series stands in');
windows['raw:self'] = selfTest;
// synthetic signals (deterministic LCG) — white noise, random walk
function lcg(seed) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }
const rnd = lcg(42);
function gauss() { let u = 0, v = 0; while (u === 0) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const white = Array.from({ length: 150 }, () => 800 + 30 * gauss());
let acc = 800; const brown = Array.from({ length: 150 }, () => (acc += 5 * gauss()));
windows['raw:white'] = white; windows['raw:brown'] = brown;
// a 2-min exercise-like RR series (≈150 bpm, correlated + white noise): exercises smoothness priors + DFA end to end without the private file
let wk = 0; const synth = Array.from({ length: 300 }, () => { wk = 0.97 * wk + gauss(); return Math.round(400 + 3 * wk + 4 * gauss()); });
windows['wSynth'] = synth; windows['sp:wSynth'] = synth; if (haveFixture) windows['sp:w500'] = windows['w500'];

const py = spawnSync('python3', [join(here, 'ref_dfa.py')], { input: JSON.stringify(windows), encoding: 'utf8' });
if (py.status !== 0) { console.error(py.stderr); process.exit(1); }
const ref = JSON.parse(py.stdout);

for (const k of Object.keys(windows)) {
  if (k.startsWith('sp:')) {
    const mine = smoothnessPriors(windows[k], 500);
    const maxErr = Math.max(...mine.map((v, i) => Math.abs(v - ref[k][i])));
    check('smoothness priors vs dense inverse (' + k + ')', maxErr < 1e-6, `max abs err ${maxErr.toExponential(2)}`);
  } else if (k.startsWith('raw:')) {
    const mine = dfaAlpha(windows[k], FATMAXXER_SCALES);
    check('DFA core ' + k, Math.abs(mine - ref[k]) < 1e-9, `js=${mine.toFixed(4)} py=${ref[k].toFixed(4)}`);
  } else {
    const mine = alpha1FatMaxxer(windows[k], 500);
    check('alpha1v2 ' + k + ' (n=' + windows[k].length + ')', Math.abs(mine - ref[k]) < 1e-6, `js=${mine.toFixed(4)} py=${ref[k].toFixed(4)}`);
  }
}
// expectations for synthetic noise: white ≈ 0.5 (±0.2), brown ≈ 1.5 (±0.2) on raw DFA
check('white noise alpha ~0.5', Math.abs(dfaAlpha(white) - 0.5) < 0.25, dfaAlpha(white).toFixed(3));
check('random walk alpha ~1.5', Math.abs(dfaAlpha(brown) - 1.5) < 0.25, dfaAlpha(brown).toFixed(3));

// 3) Artifact filter behaviour mirrors FatMaxxer (prev = last received, drop outside ±thr)
const f = new ArtifactFilter('0.25');
const seq = [800, 810, 1200, 805, 300, 790];
const res = seq.map(r => f.push(r, 75).accept);
check('artifact filter drops 1200 after 810 and 300 after 805', JSON.stringify(res) === JSON.stringify([true, true, false, false, false, false]), JSON.stringify(res));
// after 1200, prev=1200 so 805 is also rejected (as in FatMaxxer); then 300 rejected; then 790 vs prev 300 → rejected. Matches FatMaxxer semantics.

// 4) Streaming window reproduces batch alpha1 on the same samples
{ const win = new Alpha1Window({ windowSec: 120 }); let t = 1_700_000_000_000; const inWin = [];
  for (const rr of synth) { t += rr; win.pushAccepted(t, rr); } const tEnd = t; t = 1_700_000_000_000; for (const rr of synth) { t += rr; if (t > tEnd - 120000) inWin.push(rr); }
  const feat = win.features(); check('Alpha1Window matches batch on the synthetic series', Math.abs(feat.alpha1 - alpha1FatMaxxer(inWin)) < 1e-9 && feat.samples === inWin.length, `${feat.alpha1.toFixed(4)} hr=${feat.hr.toFixed(1)} n=${feat.samples}`); }
if (haveFixture) {
  const win = new Alpha1Window({ windowSec: 120 });
  for (const r of csv) { if (r[0] <= csv[500][0]) win.pushAccepted(r[0], r[1]); }
  const feat = win.features();
  check('Alpha1Window matches batch on w500', Math.abs(feat.alpha1 - alpha1FatMaxxer(windows['w500'])) < 1e-9, `${feat.alpha1.toFixed(4)} hr=${feat.hr.toFixed(1)} n=${feat.samples}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);

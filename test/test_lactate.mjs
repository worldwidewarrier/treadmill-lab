// node test/test_lactate.mjs — cross-validates js/lactate.js against test/ref_lactate.py
import { analyzeLactate, polyFit } from '../js/lactate.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) failures++; };

// Datasets (speed km/h, lactate mmol/L, HR)
const sets = {
  // smooth exponential-ish curve typical for a recreational runner (LT1 ~10, LT2 ~12.5)
  smooth: [[6, 1.1, 105], [7, 1.0, 115], [8, 1.1, 124], [9, 1.3, 133], [10, 1.6, 142], [11, 2.2, 152], [12, 3.1, 161], [13, 4.6, 170], [14, 6.9, 178]],
  // noisier field data with a dip
  noisy: [[6, 1.4, 108], [7, 1.2, 118], [8, 1.3, 126], [9, 1.2, 135], [10, 1.7, 143], [11, 2.0, 151], [12, 3.4, 160], [13, 5.2, 169]],
  // short test (5 stages) – ModDmax just allowed
  short: [[7, 1.0, 112], [8, 1.2, 122], [9, 1.5, 131], [10, 2.3, 141], [11, 4.1, 152]],
  // cycling-style power steps
  power: [[100, 0.9, 110], [130, 1.0, 120], [160, 1.2, 131], [190, 1.6, 142], [220, 2.4, 153], [250, 3.9, 164], [280, 6.3, 175]],
};
const req = {}; for (const k in sets) req[k] = sets[k].map(([x, la, hr]) => ({ x, la, hr }));
const py = spawnSync('python3', [join(here, 'ref_lactate.py')], { input: JSON.stringify(req), encoding: 'utf8' });
if (py.status !== 0) { console.error(py.stderr); process.exit(1); }
const ref = JSON.parse(py.stdout);

const near = (a, b, tol) => (Number.isNaN(a) && (b === null || Number.isNaN(b))) || Math.abs(a - b) <= tol;
for (const k in req) {
  const r = analyzeLactate(req[k]);
  const tol = k === 'power' ? 1.0 : 0.03;
  const m = Object.fromEntries([...r.lt1, ...r.lt2].map(e => [e.method, e]));
  check(`${k}: LT1 baseline+0.5`, near(m['baseline+0.5'].x, ref[k].lt1b, tol), `js=${m['baseline+0.5'].x?.toFixed(2)} py=${ref[k].lt1b?.toFixed?.(2)} hr=${m['baseline+0.5'].hr?.toFixed(0)}`);
  check(`${k}: LT1 log-log`, near(m['log-log'].x, ref[k].loglog, tol), `js=${m['log-log'].x?.toFixed(2)} py=${ref[k].loglog?.toFixed?.(2)}`);
  check(`${k}: LT2 ModDmax`, near(m['Log-Poly-ModDmax'].x, ref[k].moddmax, tol), `js=${m['Log-Poly-ModDmax'].x?.toFixed(2)} py=${ref[k].moddmax?.toFixed?.(2)} hr=${m['Log-Poly-ModDmax'].hr?.toFixed(0)}`);
  check(`${k}: LT2 Dmax`, near(m['Dmax'].x, ref[k].dmax, tol), `js=${m['Dmax'].x?.toFixed(2)} py=${ref[k].dmax?.toFixed?.(2)}`);
  check(`${k}: OBLA 4`, near(m['OBLA 4.0'].x, ref[k].obla4, tol), `js=${m['OBLA 4.0'].x?.toFixed(2)} py=${ref[k].obla4?.toFixed?.(2)}`);
  check(`${k}: OBLA 2`, near(m['OBLA 2.0'].x, ref[k].obla2, tol), `js=${m['OBLA 2.0'].x?.toFixed(2)} py=${ref[k].obla2?.toFixed?.(2)}`);
  // physiological ordering: LT1 < LT2 (primary methods) when both defined
  if (isFinite(m['baseline+0.5'].x) && isFinite(m['Log-Poly-ModDmax'].x)) check(`${k}: LT1 < LT2`, m['baseline+0.5'].x < m['Log-Poly-ModDmax'].x);
}
// polyFit sanity: exact cubic recovery
const f = polyFit([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6].map(x => 0.5 * x ** 3 - 2 * x + 1), 3);
check('polyFit recovers cubic', Math.abs(f(2.5) - (0.5 * 2.5 ** 3 - 2 * 2.5 + 1)) < 1e-9);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);

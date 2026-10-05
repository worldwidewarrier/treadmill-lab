// estimateOffsetMs: recover a known clock offset between the session HR and an import's HR series; real Train.Red file check when available.
import { estimateOffsetMs } from '../js/analysis.js';
import { readFileSync, existsSync } from 'node:fs';
let fails = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) fails++; };
const t0 = Date.UTC(2026, 9, 4, 0, 20, 0);
const hrAt = (sec) => 120 + 25 * (1 - Math.exp(-sec / 120)) + 3 * Math.sin(sec / 37) + (sec > 900 ? 4 : 0);
const sess = []; for (let s = 0; s < 2100; s += 5) sess.push([t0 + s * 1000, Math.round(hrAt(s))]);
for (const trueOff of [0, 17, -42, 95]) { // import clock behind the app by trueOff s → importTime + off = sessionTime
  const imp = []; for (let s = -30; s < 2130; s += 1) imp.push([t0 + s * 1000 - trueOff * 1000, Math.round(hrAt(s))]);
  const e = estimateOffsetMs(sess, imp);
  check(`recovers offset ${trueOff}s`, e.ok && Math.abs(e.offsetMs / 1000 - trueOff) <= 1, `${e.offsetMs / 1000}s mad ${e.mad.toFixed(2)} n ${e.n}`);
}
const noise = sess.map(([t, h]) => [t, h + 40 * Math.sin(t / 1e4)]); const bad = estimateOffsetMs(sess, noise.map(([t, h]) => [t, 180 - h]));
check('mismatched series flagged not ok', !bad.ok, `mad ${bad.mad.toFixed(1)}`);
check('too short → not ok', !estimateOffsetMs(sess.slice(0, 20), sess.slice(0, 20)).ok);
// real data (Oct 4) when present in the scratchpad
const S = '/tmp/claude-0/-home-claude-treadmill-lab/b7afc582-3385-59f9-b17f-772b43d6baaf/scratchpad/day2/';
if (existsSync(S + 'app_free.csv') && existsSync(S + 'trainred/session_20261004_092022.csv')) {
  const { parseTrainRedCsv } = await import('../js/importers.js');
  const tr = parseTrainRedCsv(readFileSync(S + 'trainred/session_20261004_092022.csv', 'utf8'), 'x.csv');
  const lines = readFileSync(S + 'app_free.csv', 'utf8').split('\n'); const i = lines.findIndex(l => l.startsWith('t_iso,'));
  const hr = []; for (const l of lines.slice(i + 1)) { const p = l.split(','); if (!p[0].startsWith('20')) break; if (+p[2] > 0) hr.push([Date.parse(p[0]), +p[2]]); }
  const e = estimateOffsetMs(hr, tr.hrSeries);
  check('real Oct-4 Train.Red aligned within 2 s', e.ok && Math.abs(e.offsetMs) <= 2000, `${e.offsetMs / 1000}s mad ${e.mad.toFixed(2)} n ${e.n}`);
}
console.log(fails ? `${fails} FAILURE(S)` : 'ALL PASS'); process.exit(fails ? 1 : 0);

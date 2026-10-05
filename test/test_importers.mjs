// node test/test_importers.mjs — real Train.Red CSV/FIT, FatMaxxer rr/features, synthetic Garmin FIT
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTrainRedCsv, parseRrCsv, parseFatMaxxerFeatures, importFile } from '../js/importers.js';
import { parseFit, fitToImport } from '../js/fit.js';
const here = dirname(fileURLToPath(import.meta.url)); const d = f => join(here, 'data', f);
let failures = 0; const check = (n, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) failures++; };
// The owner's own exports are not in the repository (test/data/README.md): sections that need one are skipped when it is absent.
const have = (...files) => { const missing = files.filter(f => !existsSync(d(f))); if (missing.length) console.log(`SKIP (private fixture not present: ${missing.join(', ')})`); return !missing.length; };
const fake = (name, content) => ({ name, text: async () => content, arrayBuffer: async () => content });

// Train.Red CSV
if (have('trainred_session.csv')) {
  const tr = parseTrainRedCsv(readFileSync(d('trainred_session.csv'), 'utf8'), 'session.csv');
  check('Train.Red CSV samples = 15561', tr.smo2Series.length === 15561, String(tr.smo2Series.length));
  check('Train.Red CSV position parsed', tr.meta.position === 'Right VL Quad', tr.meta.position);
  check('Train.Red CSV start time 2026-09-27 13:14:28 local', new Date(tr.startedAt).getHours() === 13 && new Date(tr.startedAt).getMinutes() === 14);
  check('Train.Red CSV duration ≈ 1556 s', Math.abs(tr.durationSec - 1555.97) < 0.1, tr.durationSec.toFixed(2));
  check('Train.Red CSV SmO2 range 67.8–82.4', Math.min(...tr.smo2Series.map(r => r[1])).toFixed(1) === '67.8' && Math.max(...tr.smo2Series.map(r => r[1])).toFixed(1) === '82.4');
  check('Train.Red CSV THb present', isFinite(tr.smo2Series[100][2]) && tr.smo2Series[100][2] > 20);
  check('Train.Red CSV no HR column → empty hrSeries', tr.hrSeries.length === 0);
    check('importFile detects Train.Red', (await importFile(fake('x.csv', readFileSync(d('trainred_session.csv'), 'utf8')))).source === 'trainred-csv');
}

// Train.Red FIT
if (have('trainred_sensor0.fit')) {
  const fit = parseFit(readFileSync(d('trainred_sensor0.fit')).buffer.slice(0));
  const fi = fitToImport(fit, 'sensor_0.fit');
  check('Train.Red FIT records = 1557', fit.records.length === 1557, String(fit.records.length));
  check('Train.Red FIT SmO2 series 1 Hz', fi.smo2Series.length === 1557 && Math.abs(fi.smo2Series[0][1] - 81.9) < 0.01, `${fi.smo2Series.length} first=${fi.smo2Series[0]?.[1]}`);
  check('Train.Red FIT session start = 2026-09-27T04:14:28Z', new Date(fi.startedAt).toISOString().startsWith('2026-09-27T04:14:28'), new Date(fi.startedAt).toISOString());
  check('Train.Red FIT sport running', fit.sport === 1, String(fit.sport));
    check('importFile detects FIT', (await importFile(fake('x.fit', readFileSync(d('trainred_sensor0.fit')).buffer.slice(0)))).source === 'fit');
}

// Synthetic Garmin FIT (HR + speed + dev SmO2 + hrv + laps)
const exp = JSON.parse(readFileSync(d('synthetic_garmin.json'), 'utf8'));
const g = parseFit(readFileSync(d('synthetic_garmin.fit')).buffer.slice(0)); const gi = fitToImport(g, 'g.fit');
check('Garmin FIT records', g.records.length === exp.nRecords, `${g.records.length}/${exp.nRecords}`);
check('Garmin FIT HR first/last', g.records[0].hr === exp.firstHr && g.records[g.records.length - 1].hr === exp.lastHr, `${g.records[0].hr}/${g.records[g.records.length - 1].hr}`);
check('Garmin FIT developer SmO2 decoded', Math.abs(g.records[0].smo2 - exp.firstSmo2) < 1e-6 && g.devFieldNames.includes('SmO2'), `${g.records[0].smo2} names=${g.devFieldNames}`);
check('Garmin FIT hrv RR count', g.rr.length === exp.nRr, `${g.rr.length}/${exp.nRr}`);
check('Garmin FIT hrv RR sum', Math.abs(g.rr.reduce((a, b) => a + b, 0) - exp.rrSum) < 1, '');
check('Garmin FIT laps', gi.laps.length === exp.laps.length && gi.laps[0].tStart === exp.laps[0][0], `${gi.laps.length} laps`);
check('Garmin FIT speed m/s', Math.abs(g.records[0].speed - 7 / 3.6) < 0.001, String(g.records[0].speed));
check('importFile detects a Garmin FIT by its name', (await importFile(fake('activity.FIT', readFileSync(d('synthetic_garmin.fit')).buffer.slice(0)))).source === 'fit');

// Generic RR text (no private file needed): FatMaxxer layout "timestamp, rr, since_start" with epoch-ms stamps, and seconds + RR
{ const t0 = 1790478718728; const lines = ['timestamp, rr, since_start']; let t = t0; for (let i = 0; i < 40; i++) { const rr = 440 + (i % 7); t += rr; lines.push(`${t},${rr},${((t - t0) / 1000).toFixed(3)}`); }
  const a = parseRrCsv(lines.join('\n'), 'rr.csv'); check('RR text with epoch-ms stamps', a.rr.length === 40 && a.rr[0][0] === t0 + 440 && a.rr[0][1] === 440 && a.startedAt === t0 + 440, `${a.rr.length} rows`);
  check('importFile detects RR text by its header', (await importFile(fake('rr.csv', lines.join('\n')))).source === 'rr-csv');
  const b = parseRrCsv(['0.5;812', '1.3;805', '2.1;798'].join('\n'), 'x.txt'); check('seconds;RR with semicolons → relative times kept', b.rr.length === 3 && b.rr[1][0] - b.rr[0][0] === 800 && b.rr[2][1] === 798, JSON.stringify(b.rr.map(r => r[1])));
  let threw = false; try { parseRrCsv('a,b\nfoo,bar', 'x.csv'); } catch (e) { threw = true; } check('a file without RR intervals is refused', threw); }

// FatMaxxer RR + features
if (have('fatmaxxer_rr_121156.csv', 'fatmaxxer_rr_123618.csv', 'fatmaxxer_features_0926.csv')) {
  const rr = parseRrCsv(readFileSync(d('fatmaxxer_rr_121156.csv'), 'utf8'), 'rr.csv');
  check('FatMaxxer rr rows 2627', rr.rr.length === 2627, String(rr.rr.length));
  check('FatMaxxer rr epoch ms', rr.rr[0][0] === 1790478718728 && rr.rr[0][1] === 453);
  const ft = parseFatMaxxerFeatures(readFileSync(d('fatmaxxer_features_0926.csv'), 'utf8'));
  check('FatMaxxer features 5 rows alpha1v2', ft.length === 5 && ft[0].alpha1 === 1.17 && ft[0].thr === 0.25, JSON.stringify(ft[0]));
    check('importFile detects rr', (await importFile(fake('x.csv', readFileSync(d('fatmaxxer_rr_123618.csv'), 'utf8')))).source === 'rr-csv');
    check('importFile detects features', (await importFile(fake('x.csv', readFileSync(d('fatmaxxer_features_0926.csv'), 'utf8')))).source === 'fatmaxxer-features');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS'); process.exit(failures ? 1 : 0);

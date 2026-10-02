// File importers: Train.Red CSV export, FatMaxxer rr/features CSV, generic RR CSV. FIT lives in fit.js.
import { parseFit, fitToImport } from './fit.js';

function splitCsvLine(line) { return line.split(',').map(s => s.trim()); }

/** Parse "2026-09-27T13:14:28.493117" (local time, no zone) → ms epoch in the device's local zone. */
function parseLocalIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(s || '');
  if (!m) { const d = new Date(s); return isNaN(d) ? null : d.getTime(); }
  const ms = m[7] ? Math.round(Number('0.' + m[7]) * 1000) : 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms).getTime();
}

/** Train.Red app CSV export (one or more sensor blocks). */
export function parseTrainRedCsv(text, filename = '') {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const meta = {}; let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; if (!l.trim()) continue;
    if (/^Timestamp/i.test(l)) { headerIdx = i; break; }
    const parts = splitCsvLine(l);
    if (parts.length >= 2 && parts[0] && !/^-+$/.test(parts[0])) meta[parts[0]] = parts.slice(1).filter(Boolean).join(',');
  }
  if (headerIdx < 0) throw new Error('Train.Red CSV header row (Timestamp …) not found');
  const header = splitCsvLine(lines[headerIdx]).map(h => h.toLowerCase());
  const col = (re) => header.findIndex(h => re.test(h));
  const cT = col(/^timestamp/), cLap = col(/lap|event/), cSmo = header.findIndex(h => h === 'smo2' || h === 'smo2%' || h === 'tsi'), cSmoRaw = col(/smo2 unfiltered/),
    cThb = col(/thb/), cHbd = header.findIndex(h => h === 'hbdiff'), cState = col(/muscle state/), cHr = col(/heart ?rate|^hr$|bpm/);
  const series = []; const laps = []; const hr = [];
  let lastLap = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const l = lines[i]; if (!l.trim()) continue;
    const p = splitCsvLine(l); if (p.length < 4) continue;
    const t = Number(p[cT]); if (!isFinite(t)) { if (/^Timestamp/i.test(l)) break; continue; }
    const smo = Number(p[cSmo >= 0 ? cSmo : 3]);
    const thb = cThb >= 0 ? Number(p[cThb]) : NaN; const hbd = cHbd >= 0 ? Number(p[cHbd]) : NaN;
    const state = cState >= 0 ? Number(p[cState]) : NaN; const raw = cSmoRaw >= 0 ? Number(p[cSmoRaw]) : NaN;
    const lap = cLap >= 0 ? Number(p[cLap]) : 0;
    if (lap && lap !== lastLap) { laps.push(t); lastLap = lap; }
    series.push([t, smo, thb, hbd, state, raw]);
    if (cHr >= 0) { const h = Number(p[cHr]); if (isFinite(h) && h > 0) hr.push([t, h]); }
  }
  const startedAt = parseLocalIso(meta['Measurement Date']) || Date.now();
  const durationSec = series.length ? series[series.length - 1][0] : 0;
  return {
    source: 'trainred-csv', filename, startedAt, endedAt: startedAt + durationSec * 1000, durationSec,
    // absolute-time series: [tAbs, smo2, thb, hbdiff, state, smo2raw]
    smo2Series: series.map(r => [startedAt + r[0] * 1000, r[1], r[2], r[3], r[4], r[5]]),
    hrSeries: hr.map(r => [startedAt + r[0] * 1000, r[1]]),
    laps: laps.map(t => startedAt + t * 1000),
    meta: {
      position: meta['Sensor Position'] || '', sensor: meta['Sensor ID'] || '', type: meta['Type'] || '', sport: meta['Sport'] || '',
      samples: Number(meta['Samples']) || series.length, tsiMin: Number(meta['TSI Min']), tsiMax: Number(meta['TSI Max']), tsiAvg: Number(meta['TSI Avg']),
      sensors: Number(meta['Number of Sensors']) || 1,
    },
  };
}

/** FatMaxxer rr.csv ("timestamp, rr, since_start") or any CSV whose first two numeric columns are ms-timestamp and RR ms. */
export function parseRrCsv(text, filename = '') {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const rr = [];
  let sep = ',';
  if (lines[0] && lines[0].includes(';') && !lines[0].includes(',')) sep = ';';
  for (const l of lines) {
    const p = l.split(sep).map(s => s.trim()); if (p.length < 2) continue;
    const a = Number(p[0]), b = Number(p[1]);
    if (!isFinite(a) || !isFinite(b)) continue;
    if (a > 1e11 && b > 200 && b < 3000) rr.push([a, b]);          // epoch ms, RR ms
    else if (b > 200 && b < 3000 && rr.length === 0 && a < 1e6) {    // relative seconds + RR
      rr.push([Math.round(a * 1000), b]);
    } else if (b > 200 && b < 3000) rr.push([Math.round(a * 1000), b]);
  }
  if (!rr.length) throw new Error('no RR intervals found');
  const relative = rr[0][0] < 1e11;
  const t0 = relative ? Date.now() - (rr[rr.length - 1][0] - rr[0][0]) : rr[0][0];
  const out = relative ? rr.map(r => [t0 + (r[0] - rr[0][0]), r[1]]) : rr;
  return { source: 'rr-csv', filename, startedAt: out[0][0], endedAt: out[out.length - 1][0], durationSec: (out[out.length - 1][0] - out[0][0]) / 1000, rr: out };
}

/** FatMaxxer features.csv → [{t, elapsedSec, hr, rmssd, alpha1, artifacts, samples, droppedPct, thr}] */
export function parseFatMaxxerFeatures(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const h = splitCsvLine(lines[0]).map(s => s.toLowerCase()); const ix = n => h.indexOf(n);
  const out = [];
  for (const l of lines.slice(1)) {
    const p = splitCsvLine(l); if (p.length < 5) continue;
    out.push({ t: Number(p[ix('timestamp')]), elapsedSec: Number(p[ix('elapsedsec')]), hr: Number(p[ix('heartrate')]), rmssd: Number(p[ix('rmssd')]),
      alpha1: Number(p[ix('alpha1v2')] || p[ix('alpha1v1')]), artifacts: Number(p[ix('filtered')]), samples: Number(p[ix('samples')]), droppedPct: Number(p[ix('droppedpercent')]), thr: Number(p[ix('artifactthreshold')]) });
  }
  return out;
}

/** Detect file type and parse. Accepts File/Blob or {name, text/arrayBuffer}. */
export async function importFile(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.fit')) { const buf = await file.arrayBuffer(); return fitToImport(parseFit(buf), file.name); }
  const text = await file.text();
  if (/Train\.Red Export/i.test(text.slice(0, 200)) || /Timestamp \(seconds passed\)/i.test(text)) return parseTrainRedCsv(text, file.name);
  if (/^date,timestamp,elapsedSec/i.test(text.trimStart())) return { source: 'fatmaxxer-features', filename: file.name, features: parseFatMaxxerFeatures(text) };
  if (/^timestamp\s*,\s*rr/i.test(text.trimStart()) || /rr/i.test(text.slice(0, 80))) return parseRrCsv(text, file.name);
  // last resort: try RR
  return parseRrCsv(text, file.name);
}

// v1.1.42 — Garmin runs as sessions (owner 10/23: "가민 러닝 기록을 추가하는 기능"). Garmin Connect (web) → the activity → ⚙ → Export Original
// gives a .zip holding one .fit; either file is accepted. The run becomes one finished session (sourceKind 'garmin', surface 'outdoor'), so it
// ticks today's run and counts in the weekly quota; off the belt it never feeds a lactate verdict, the curve or a zone change (onBelt).
import { parseFit } from './fit.js';

/** The first .fit inside a .zip (stored or deflated), via the central directory; DecompressionStream does the inflating. */
export async function fitFromZip(buf) {
  const u8 = new Uint8Array(buf); const dv = new DataView(buf);
  let eocd = -1; for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl)); p += 46 + nl + xl + cl;
    if (!/\.fit$/i.test(name)) continue;
    const ds = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true); const data = u8.slice(ds, ds + csize);
    if (method === 0) return { name, buf: data.buffer };
    if (method !== 8) throw new Error('unsupported zip compression');
    const out = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
    return { name, buf: out };
  }
  throw new Error('no .fit file in the zip');
}

/** A Garmin FIT run → a finished session. Hard (type 'lt2') when ≥ 10 min of heart rate sit at LT2 − 5 or above, else 'free' (an easy run). */
export function garminSession(fit, filename = '', zones = null) {
  const recs = fit.records.filter(r => r.t != null); if (!recs.length) throw new Error('no records in the FIT file');
  const s0 = fit.sessions && fit.sessions[0]; const t0 = (s0 && s0.tStart) || fit.startedAt || recs[0].t; const t1 = (s0 && s0.tEnd) || recs[recs.length - 1].t;
  const hrLive = recs.filter(r => r.hr > 0).map(r => [r.t, r.hr]);
  const distM = (s0 && Number.isFinite(s0.distance)) ? s0.distance : (recs.map(r => r.distance).filter(Number.isFinite).pop() ?? null);
  const moving = (s0 && Number.isFinite(s0.elapsed)) ? s0.elapsed : (t1 - t0) / 1000;
  let hardSec = 0; const lt2 = zones && Number.isFinite(zones.lt2Hr) ? zones.lt2Hr - 5 : null;
  if (lt2 != null) for (let i = 1; i < hrLive.length; i++) { const dt = (hrLive[i][0] - hrLive[i - 1][0]) / 1000; if (hrLive[i][1] >= lt2 && dt > 0 && dt < 30) hardSec += dt; }
  const hard = hardSec >= 600;
  // v1.1.43: what the watch measured beyond heart rate — cadence, 1-km laps (pace + heart rate), and the pace at a fixed heart rate (LT1 − 3):
  // the mean speed of the running samples (after minute 10, faster than 1.5 m/s) whose heart rate is within ± 3 bpm of it, ≥ 2 min of them.
  const run = recs.filter(r => Number.isFinite(r.speed) && r.speed > 1.5);
  const cad = run.map(r => r.cadence).filter(c => c > 0); const cadenceSpm = cad.length ? Math.round(2 * cad.reduce((a, b) => a + b, 0) / cad.length) : null; // FIT running cadence = one foot (rpm)
  const lapsDetail = (fit.laps || []).filter(l => l.tStart != null && l.tEnd != null && l.distance > 0).map(l => { const hs = recs.filter(r => r.t >= l.tStart && r.t <= l.tEnd && r.hr > 0).map(r => r.hr); const sec = l.elapsed ?? (l.tEnd - l.tStart) / 1000; return { km: Math.round(l.distance) / 1000, sec: Math.round(sec), pace: Math.round(sec / (l.distance / 1000)), hr: hs.length ? Math.round(hs.reduce((a, b) => a + b, 0) / hs.length) : null }; });
  const refHr = zones && Number.isFinite(zones.lt1Hr) ? zones.lt1Hr - 3 : 140;
  const band = run.filter(r => r.t >= t0 + 600000 && r.hr > 0 && Math.abs(r.hr - refHr) <= 3);
  const paceAtHr = band.length >= 120 ? { hr: refHr, pace: Math.round(1000 / (band.reduce((a, r) => a + r.speed, 0) / band.length)), n: band.length } : { hr: refHr, pace: null, n: band.length };
  return {
    id: 'garmin-' + t0, type: hard ? 'lt2' : 'free', sourceKind: 'garmin', final: true, startedAt: t0, endedAt: t1, surface: 'outdoor',
    hrLive, rr: fit.rr || [], features: [], events: [], stages: [], tiz: {}, pauseMs: 0,
    meta: { speed: distM && moving ? Math.round(36 * distM / moving) / 10 : null, surface: 'outdoor' },
    garmin: { v: 2, filename, distanceM: distM, elapsedSec: moving, paceSecPerKm: distM ? Math.round(moving / (distM / 1000)) : null, hardMin: Math.round(hardSec / 60), laps: (fit.laps || []).length, cadenceSpm, lapsDetail, paceAtHr },
  };
}

/** A picked file (.zip from Garmin Connect, or a .fit) → { name, fit }. */
export async function readGarminFile(file) {
  const buf = await file.arrayBuffer();
  if (/\.zip$/i.test(file.name || '') || new DataView(buf).getUint32(0, true) === 0x04034b50) { const z = await fitFromZip(buf); return { name: z.name, fit: parseFit(z.buf) }; }
  return { name: file.name, fit: parseFit(buf) };
}

export const fmtPace = sec => Number.isFinite(sec) ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}` : '–';
/** Pace at the fixed heart rate over time (easy Garmin runs): the last 14 days vs the 14 before; ≥ 2 runs in each and a change of ≥ 10 s/km
 *  → 'faster' (an LT1 check may move the band) or 'slower' (fatigue, heat, sleep — check them). Outdoor values: never a zone change by themselves. */
export function paceTrend(sessions, now = Date.now()) {
  const pts = sessions.filter(s => s.sourceKind === 'garmin' && s.final && s.type !== 'lt2' && s.garmin && s.garmin.paceAtHr && Number.isFinite(s.garmin.paceAtHr.pace)).map(s => ({ t: s.startedAt, pace: s.garmin.paceAtHr.pace, hr: s.garmin.paceAtHr.hr })).sort((a, b) => a.t - b.t);
  const d = 864e5; const a = pts.filter(p => p.t > now - 14 * d), b = pts.filter(p => p.t <= now - 14 * d && p.t > now - 28 * d);
  const m = x => x.reduce((s, p) => s + p.pace, 0) / x.length;
  let flag = null; if (a.length >= 2 && b.length >= 2) { const diff = m(a) - m(b); if (diff <= -10) flag = { kind: 'faster', diff: Math.round(-diff) }; else if (diff >= 10) flag = { kind: 'slower', diff: Math.round(diff) }; }
  return { pts, flag };
}

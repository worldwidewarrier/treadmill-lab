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
  return {
    id: 'garmin-' + t0, type: hard ? 'lt2' : 'free', sourceKind: 'garmin', final: true, startedAt: t0, endedAt: t1, surface: 'outdoor',
    hrLive, rr: fit.rr || [], features: [], events: [], stages: [], tiz: {}, pauseMs: 0,
    meta: { speed: distM && moving ? Math.round(36 * distM / moving) / 10 : null, surface: 'outdoor' },
    garmin: { filename, distanceM: distM, elapsedSec: moving, paceSecPerKm: distM ? Math.round(moving / (distM / 1000)) : null, hardMin: Math.round(hardSec / 60), laps: (fit.laps || []).length },
  };
}

/** A picked file (.zip from Garmin Connect, or a .fit) → { name, fit }. */
export async function readGarminFile(file) {
  const buf = await file.arrayBuffer();
  if (/\.zip$/i.test(file.name || '') || new DataView(buf).getUint32(0, true) === 0x04034b50) { const z = await fitFromZip(buf); return { name: z.name, fit: parseFit(z.buf) }; }
  return { name: file.name, fit: parseFit(buf) };
}

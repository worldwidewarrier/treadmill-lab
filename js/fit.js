// Minimal FIT decoder (Garmin FIT protocol) — records, laps, sessions, hrv, developer fields.
const FIT_EPOCH_OFFSET = 631065600; // seconds between Unix epoch and FIT epoch (1989-12-31T00:00:00Z)

const BASE = {
  0x00: { size: 1, inv: 0xFF, get: (dv, o) => dv.getUint8(o) },
  0x01: { size: 1, inv: 0x7F, get: (dv, o) => dv.getInt8(o) },
  0x02: { size: 1, inv: 0xFF, get: (dv, o) => dv.getUint8(o) },
  0x83: { size: 2, inv: 0x7FFF, get: (dv, o, le) => dv.getInt16(o, le) },
  0x84: { size: 2, inv: 0xFFFF, get: (dv, o, le) => dv.getUint16(o, le) },
  0x85: { size: 4, inv: 0x7FFFFFFF, get: (dv, o, le) => dv.getInt32(o, le) },
  0x86: { size: 4, inv: 0xFFFFFFFF, get: (dv, o, le) => dv.getUint32(o, le) },
  0x07: { size: 1, inv: 0x00, get: (dv, o) => dv.getUint8(o), str: true },
  0x88: { size: 4, inv: null, get: (dv, o, le) => dv.getFloat32(o, le) },
  0x89: { size: 8, inv: null, get: (dv, o, le) => dv.getFloat64(o, le) },
  0x0A: { size: 1, inv: 0x00, get: (dv, o) => dv.getUint8(o) },
  0x8B: { size: 2, inv: 0x0000, get: (dv, o, le) => dv.getUint16(o, le) },
  0x8C: { size: 4, inv: 0x00000000, get: (dv, o, le) => dv.getUint32(o, le) },
  0x0D: { size: 1, inv: 0xFF, get: (dv, o) => dv.getUint8(o) },
  0x8E: { size: 8, inv: null, get: (dv, o, le) => Number(dv.getBigInt64(o, le)) },
  0x8F: { size: 8, inv: null, get: (dv, o, le) => Number(dv.getBigUint64(o, le)) },
  0x90: { size: 8, inv: null, get: (dv, o, le) => Number(dv.getBigUint64(o, le)) },
};

/** Decode a FIT ArrayBuffer into a simplified activity object. */
export function parseFit(buf) {
  const dv = new DataView(buf); const u8 = new Uint8Array(buf);
  if (buf.byteLength < 14) throw new Error('not a FIT file');
  const headerSize = u8[0];
  const dataSize = dv.getUint32(4, true);
  const sig = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]);
  if (sig !== '.FIT') throw new Error('not a FIT file (missing .FIT signature)');
  let p = headerSize; const end = Math.min(buf.byteLength, headerSize + dataSize);
  const defs = {}; // local msg type -> definition
  const devFields = {}; // key `${devIdx}:${fieldNum}` -> {name, units, baseType}
  const out = { records: [], laps: [], sessions: [], events: [], rr: [], fileId: null, sport: null, startedAt: null, devFieldNames: [] };
  let lastTs = null;
  const toMs = s => (s + FIT_EPOCH_OFFSET) * 1000;

  while (p < end) {
    const hdr = u8[p++];
    let local, isDef = false, hasDev = false, compressed = false, tsOffset = 0;
    if (hdr & 0x80) { compressed = true; local = (hdr >> 5) & 0x03; tsOffset = hdr & 0x1F; }
    else { isDef = (hdr & 0x40) !== 0; hasDev = (hdr & 0x20) !== 0; local = hdr & 0x0F; }
    if (isDef) {
      p += 1; // reserved
      const arch = u8[p++]; const le = arch === 0;
      const global = le ? dv.getUint16(p, true) : dv.getUint16(p, false); p += 2;
      const nf = u8[p++]; const fields = [];
      for (let i = 0; i < nf; i++) { fields.push({ num: u8[p], size: u8[p + 1], type: u8[p + 2], dev: false }); p += 3; }
      if (hasDev) { const nd = u8[p++]; for (let i = 0; i < nd; i++) { fields.push({ num: u8[p], size: u8[p + 1], devIdx: u8[p + 2], dev: true }); p += 3; } }
      defs[local] = { global, le, fields };
      continue;
    }
    const def = defs[local];
    if (!def) throw new Error('data message without definition (local ' + local + ')');
    const msg = {}; const dev = {};
    for (const f of def.fields) {
      let val = null;
      if (f.dev) {
        const meta = devFields[`${f.devIdx}:${f.num}`];
        const bt = meta ? BASE[meta.baseType] : null;
        if (bt && !bt.str) {
          const cnt = Math.floor(f.size / bt.size); const arr = [];
          for (let k = 0; k < cnt; k++) { const v = bt.get(dv, p + k * bt.size, def.le); if (bt.inv === null || v !== bt.inv) arr.push(v / meta.scale - meta.offset); }
          val = cnt === 1 ? (arr.length ? arr[0] : null) : arr;
        }
        if (meta) dev[meta.name || `dev${f.devIdx}_${f.num}`] = val;
        p += f.size; continue;
      }
      const bt = BASE[f.type];
      if (!bt) { p += f.size; continue; }
      if (bt.str) { let s = ''; for (let k = 0; k < f.size; k++) { const c = u8[p + k]; if (c === 0) break; s += String.fromCharCode(c); } val = s; }
      else {
        const cnt = Math.floor(f.size / bt.size); const arr = [];
        for (let k = 0; k < cnt; k++) { const v = bt.get(dv, p + k * bt.size, def.le); arr.push((bt.inv !== null && v === bt.inv) ? null : v); }
        val = cnt === 1 ? arr[0] : arr;
      }
      msg[f.num] = val; p += f.size;
    }
    if (compressed && lastTs != null) { const low = lastTs & 0x1F; lastTs = (lastTs & ~0x1F) + tsOffset + (tsOffset < low ? 0x20 : 0); msg[253] = lastTs; }
    else if (msg[253] != null) lastTs = msg[253];

    switch (def.global) {
      case 0: out.fileId = { type: msg[0], manufacturer: msg[1], product: msg[2], timeCreated: msg[4] != null ? toMs(msg[4]) : null }; break;
      case 206: { // field_description
        const key = `${msg[0]}:${msg[1]}`; const name = Array.isArray(msg[3]) ? msg[3].join('') : (msg[3] || '');
        devFields[key] = { name, units: msg[8] || '', baseType: msg[2], scale: (msg[6] != null && msg[6] !== 0) ? msg[6] : 1, offset: msg[7] != null ? msg[7] : 0 }; out.devFieldNames.push(name); break;
      }
      case 20: { // record
        const r = { t: msg[253] != null ? toMs(msg[253]) : null };
        if (msg[3] != null) r.hr = msg[3];
        if (msg[73] != null) r.speed = msg[73] / 1000; else if (msg[6] != null) r.speed = msg[6] / 1000; // m/s
        if (msg[5] != null) r.distance = msg[5] / 100;
        if (msg[4] != null) r.cadence = msg[4];
        if (msg[57] != null) r.smo2 = msg[57] / 10;      // saturated_hemoglobin_percent (scale 10)
        if (msg[54] != null) r.thb = msg[54] / 100;      // total_hemoglobin_conc (scale 100)
        if (msg[58] != null) r.smo2Min = msg[58] / 10; if (msg[59] != null) r.smo2Max = msg[59] / 10;
        if (msg[2] != null) r.altitude = msg[2] / 5 - 500;
        for (const [k, v] of Object.entries(dev)) {
          const kl = k.toLowerCase();
          if (v == null || Array.isArray(v)) continue;
          if (r.smo2 == null && /smo2|oxygen|tsi|saturation/.test(kl)) r.smo2 = v;
          else if (r.thb == null && /thb|hemoglobin/.test(kl)) r.thb = v;
          else if (r.hr == null && /heart|^hr$/.test(kl)) r.hr = v;
        }
        if (r.t != null) out.records.push(r); break;
      }
      case 19: out.laps.push({ tStart: msg[2] != null ? toMs(msg[2]) : null, tEnd: msg[253] != null ? toMs(msg[253]) : null, elapsed: msg[7] != null ? msg[7] / 1000 : null, distance: msg[9] != null ? msg[9] / 100 : null }); break;
      case 18: out.sessions.push({ tStart: msg[2] != null ? toMs(msg[2]) : null, tEnd: msg[253] != null ? toMs(msg[253]) : null, sport: msg[5], elapsed: msg[7] != null ? msg[7] / 1000 : null, distance: msg[9] != null ? msg[9] / 100 : null }); break;
      case 21: out.events.push({ t: msg[253] != null ? toMs(msg[253]) : null, event: msg[0], type: msg[1] }); break;
      case 78: { // hrv: field 0 = array of uint16 (s/1000)
        const arr = Array.isArray(msg[0]) ? msg[0] : [msg[0]];
        for (const v of arr) if (v != null && v > 0) out.rr.push(v); // ms
        break;
      }
      default: break;
    }
  }
  // derived
  if (out.sessions.length) { out.startedAt = out.sessions[0].tStart; out.sport = out.sessions[0].sport; }
  else if (out.records.length) out.startedAt = out.records[0].t;
  // Assign timestamps to RR intervals by cumulative sum from the first record time (good enough for alignment)
  if (out.rr.length && out.startedAt) { let t = out.startedAt; out.rrTimed = out.rr.map(rr => { t += rr; return [t, rr]; }); }
  return out;
}

/** Normalise a decoded FIT into the app's import shape. */
export function fitToImport(fit, filename = '') {
  const recs = fit.records.filter(r => r.t != null);
  const smo2 = recs.filter(r => r.smo2 != null).map(r => [r.t, r.smo2, r.thb ?? NaN]);
  const hr = recs.filter(r => r.hr != null).map(r => [r.t, r.hr]);
  const t0 = fit.startedAt || (recs[0] && recs[0].t) || null;
  const t1 = recs.length ? recs[recs.length - 1].t : t0;
  return {
    source: 'fit', filename, startedAt: t0, endedAt: t1, durationSec: t0 && t1 ? (t1 - t0) / 1000 : 0,
    smo2Series: smo2, hrSeries: hr, rr: fit.rrTimed || [], laps: fit.laps.filter(l => l.tStart != null),
    meta: { sport: fit.sport, manufacturer: fit.fileId?.manufacturer, devFields: fit.devFieldNames, records: recs.length },
  };
}

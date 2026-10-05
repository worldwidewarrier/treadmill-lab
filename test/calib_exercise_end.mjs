// node test/calib_exercise_end.mjs — not a pass/fail test: how often and how precisely exerciseEnd() finds the stop on 4,000
// random synthetic recordings whose true stop is known (run types × tail types × noise × sample spacing). Prints one line per
// combination. The figures quoted in README §4 come from this script; run it again after touching the detector's thresholds.
import { exerciseEnd } from '../js/analysis.js';
function mkGauss(seed) { let s = seed >>> 0; const r = () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; return () => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }; }
const T0 = Date.UTC(2026, 9, 7);
/** schedule: [{ until: s, hr: bpm | fn(s), tau, fast: { part, tau } }] — first-order response; `fast` = bi-exponential recovery. */
function sched({ schedule, step = 1, noise = 1.5, seed = 1, h0 = 95 }) {
  const g = mkGauss(seed); const hr = []; let slow = h0, fast = 0, cur = null; const total = schedule[schedule.length - 1].until; let nextEmit = 0;
  for (let sec = 0; sec <= total; sec++) {
    const seg = schedule.find(x => sec < x.until) || schedule[schedule.length - 1]; const target = typeof seg.hr === 'function' ? seg.hr(sec) : seg.hr;
    if (seg !== cur) { cur = seg; if (seg.fast) { const h = slow + fast; fast = seg.fast.part * (h - target); slow = h - fast; } }
    slow += (target - slow) * (1 - Math.exp(-1 / (seg.tau || 30))); fast *= Math.exp(-1 / ((seg.fast && seg.fast.tau) || 15));
    if (sec >= nextEmit) { hr.push([T0 + sec * 1000, Math.round(slow + fast + noise * g())]); nextEmit = sec + step; }
  }
  return { type: 'free', startedAt: T0, endedAt: T0 + total * 1000, hrLive: hr, features: [], events: [] };
}
let seed = 777; const rnd = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; }; const pick = a => a[Math.floor(rnd() * a.length)]; const U = (a, b) => a + (b - a) * rnd();
const res = {}; const add = (k, v) => { (res[k] = res[k] || []).push(v); };
for (let k = 0; k < 4000; k++) {
  const run = Math.round(U(600, 3000)); const lvl = U(125, 168); const schedule = []; let endLvl = lvl;
  // the run: steady · drifting (−6…+15 bpm) · with a faster stretch of 1–7 min (+8…+30) · pace eased by 4–13 bpm in its second half · with a 30–110-s belt stop
  const kind = pick(['steady', 'steady', 'drift', 'drift', 'surge', 'eased', 'belt stop']);
  if (kind === 'steady') schedule.push({ until: run, hr: lvl });
  else if (kind === 'drift') { const d = U(-6, 15); endLvl = lvl + d; schedule.push({ until: run, hr: s => lvl + d * s / run }); }
  else if (kind === 'surge') { const a = Math.round(U(0.2, 0.6) * run), len = Math.round(U(60, 420)); schedule.push({ until: a, hr: lvl }, { until: Math.min(run - 240, a + len), hr: lvl + U(8, 30) }, { until: run, hr: lvl }); }
  else if (kind === 'eased') { const a = Math.round(U(0.5, 0.85) * run); const d = U(4, 13); endLvl = lvl - d; schedule.push({ until: a, hr: lvl }, { until: run, hr: lvl - d }); }
  else { const a = Math.round(U(0.25, 0.5) * run); schedule.push({ until: a, hr: lvl }, { until: a + Math.round(U(30, 110)), hr: lvl - U(25, 45), tau: 50 }, { until: run, hr: lvl + U(0, 4) }); }
  // what follows the stop: nothing (Finish while running) · standing 40 s – 25 min · a walk (Finish while walking) · walk then stand · stand, walk, stand
  const tail = pick(['none', 'stand', 'stand', 'stand', 'walk', 'walk, stand', 'stand, walk, stand']);
  let t = run; const floor = U(90, Math.min(112, endLvl - 30)); const walk = () => Math.min(endLvl - 22, floor + U(8, 22));
  if (tail === 'stand') { t += Math.round(pick([U(40, 120), U(120, 400), U(400, 1500)])); schedule.push({ until: t, hr: floor, tau: U(40, 110), ...(rnd() < 0.4 ? { fast: { part: U(0.2, 0.5), tau: U(10, 25) } } : {}) }); }
  else if (tail === 'walk') { t += Math.round(U(120, 1200)); schedule.push({ until: t, hr: walk(), tau: U(35, 60) }); }
  else if (tail === 'walk, stand') { t += Math.round(U(120, 600)); schedule.push({ until: t, hr: walk(), tau: U(35, 60) }); t += Math.round(U(40, 200)); schedule.push({ until: t, hr: floor, tau: 50 }); }
  else if (tail === 'stand, walk, stand') { t += Math.round(U(60, 150)); schedule.push({ until: t, hr: floor, tau: U(45, 80) }); t += Math.round(U(120, 420)); schedule.push({ until: t, hr: walk(), tau: 40 }); t += Math.round(U(40, 150)); schedule.push({ until: t, hr: floor, tau: 50 }); }
  const ss = sched({ seed: k + 1, schedule, step: pick([1, 1, 1, 1, 2, 5]), noise: U(0.8, 3) });
  const x = exerciseEnd(ss, {}); const at = x.how === 'hr' ? (x.t - ss.startedAt) / 1000 : null;
  add(`${kind} | ${tail}`, tail === 'none' ? (at == null ? 'ok' : 'false') : (at == null ? 'missed' : at - run));
}
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const all = { n: 0, noTail: 0, falseEnd: 0, tails: 0, missed: 0, err: [] };
console.log('run | what follows the stop'.padEnd(36), 'recordings · result');
for (const k of Object.keys(res).sort()) { const v = res[k]; all.n += v.length;
  if (k.endsWith('| none')) { const bad = v.filter(x => x !== 'ok').length; all.noTail += v.length; all.falseEnd += bad; console.log(k.padEnd(36), `${String(v.length).padStart(4)} · an end reported although the runner never stopped: ${bad}`); continue; }
  const num = v.filter(x => typeof x === 'number'); const missed = v.length - num.length; all.tails += v.length; all.missed += missed; all.err.push(...num);
  console.log(k.padEnd(36), `${String(v.length).padStart(4)} · not found ${String(missed).padStart(3)} · error (s): median ${pct(num, 0.5).toFixed(0)}, 5–95 % ${pct(num, 0.05).toFixed(0)} … ${pct(num, 0.95).toFixed(0)}, range ${Math.min(...num).toFixed(0)} … ${Math.max(...num).toFixed(0)} · more than 20 s off: ${num.filter(x => Math.abs(x) > 20).length}`); }
const e = all.err; const off = e.filter(x => Math.abs(x) > 20).length;
console.log(`\n${all.n} recordings. Without a tail: ${all.noTail}, false ends ${all.falseEnd}. With a tail: ${all.tails}, end found in ${e.length} (${(100 * e.length / all.tails).toFixed(0)} %), not found ${all.missed} (the recording end is used, as before).`);
console.log(`Where found: median error ${pct(e, 0.5).toFixed(0)} s, 5–95 % ${pct(e, 0.05).toFixed(0)} … ${pct(e, 0.95).toFixed(0)} s; within ±20 s of the true stop: ${(100 * (e.length - off) / e.length).toFixed(1)} % (${off} beyond — mostly a faster stretch longer than the minutes before it, or a walk barely slower than the run).`);

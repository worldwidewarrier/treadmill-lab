import { DemoSource } from '../js/sources.js';
import { alpha1FatMaxxer } from '../js/dfa.js';
function measure(u, hr) {
  const src = new DemoSource({ profile: () => ({ hr, alpha: 1 }) }); src.mixOverride = u;
  src.wallStart = 0; src.t0 = 0; src.cursor = 0; src.hrLag = hr; src.seed = 999 + Math.round(u * 1000);
  const rrs = []; src.on('hr', e => rrs.push(...e.rr)); src.now = () => 900000; src.pump();
  const vals = [];
  for (let start = 60; start + 120 <= 900; start += 20) { let t = 0; const w = []; for (let i = 0; i < rrs.length; i++) { t += rrs[i]; if (t >= start * 1000 && t <= (start + 120) * 1000) w.push(rrs[i]); if (t > (start + 120) * 1000) break; } vals.push(alpha1FatMaxxer(w)); }
  return +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3);
}
for (const hr of [110, 160]) { const row = []; for (const u of [0, 0.25, 0.4, 0.5, 0.7, 1.0, 1.3, 1.6, 2.0]) row.push(`${u}:${measure(u, hr)}`); console.log('hr', hr, row.join('  ')); }
// end-to-end: target → measured
console.log('target→measured');
for (const a of [1.3, 1.1, 0.9, 0.75, 0.6, 0.5, 0.4]) { const src = new DemoSource({ profile: () => ({ hr: 140, alpha: a }) }); src.wallStart = 0; src.t0 = 0; src.cursor = 0; src.hrLag = 140; const rrs = []; src.on('hr', e => rrs.push(...e.rr)); src.now = () => 600000; src.pump(); const vals = []; for (let start = 60; start + 120 <= 600; start += 20) { let t = 0; const w = []; for (let i = 0; i < rrs.length; i++) { t += rrs[i]; if (t >= start * 1000 && t <= (start + 120) * 1000) w.push(rrs[i]); if (t > (start + 120) * 1000) break; } vals.push(alpha1FatMaxxer(w)); } console.log(a, '→', (vals.reduce((x, y) => x + y, 0) / vals.length).toFixed(2)); }

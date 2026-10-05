import { DemoSource } from '../js/sources.js';
import { alpha1FatMaxxer } from '../js/dfa.js';
function measureWf(wf, hr) {
  DemoSource.whiteFraction = () => wf;
  const src = new DemoSource({ profile: () => ({ hr, alpha: 1 }) });
  src.wallStart = 0; src.t0 = 0; src.cursor = 0; src.hrLag = hr; src.seed = 777 + Math.round(wf * 1000);
  const rrs = []; src.on('hr', e => rrs.push(...e.rr)); src.now = () => 600000; src.pump();
  const vals = [];
  for (let start = 60; start + 120 <= 600; start += 20) { let t = 0; const w = []; for (let i = 0; i < rrs.length; i++) { t += rrs[i]; if (t >= start * 1000 && t <= (start + 120) * 1000) w.push(rrs[i]); if (t > (start + 120) * 1000) break; } vals.push(alpha1FatMaxxer(w)); }
  return +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3);
}
for (const hr of [100, 150]) { const row = []; for (const wf of [0, 0.2, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 1.0]) row.push(`${wf}:${measureWf(wf, hr)}`); console.log('hr', hr, row.join('  ')); }

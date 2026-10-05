import { DemoSource } from '../js/sources.js';
import { alpha1FatMaxxer } from '../js/dfa.js';
function measure(alphaTarget, hr) {
  const src = new DemoSource({ profile: () => ({ hr, alpha: alphaTarget }) });
  src.wallStart = 0; src.t0 = 0; src.cursor = 0; src.hrLag = hr;
  const rrs = [];
  src.on('hr', e => rrs.push(...e.rr));
  // drive pump manually: emulate 400 s of data
  src.now = () => 400000; src.pump();
  const vals = [];
  for (let start = 60; start + 120 <= 400; start += 20) {
    // window by time: accumulate rr until window covered
    let t = 0, i = 0; const w = [];
    for (; i < rrs.length; i++) { t += rrs[i]; if (t >= start * 1000 && t <= (start + 120) * 1000) w.push(rrs[i]); if (t > (start + 120) * 1000) break; }
    vals.push(alpha1FatMaxxer(w));
  }
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { target: alphaTarget, hr, measured: +m.toFixed(2), n: vals.length };
}
for (const [a, hr] of [[1.3, 90], [1.2, 110], [1.0, 125], [0.9, 135], [0.75, 150], [0.6, 160], [0.5, 170], [0.45, 180]]) console.log(measure(a, hr));

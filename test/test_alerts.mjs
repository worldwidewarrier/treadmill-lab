// node test/test_alerts.mjs — screen wake lock handling in js/alerts.js against a fake navigator.wakeLock.
import { Alerts } from '../js/alerts.js';
let failures = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const locks = []; let refuse = false;
const fake = { request: async () => { await sleep(15); if (refuse) throw Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }); const s = new EventTarget(); s.released = false; s.release = async () => { if (!s.released) { s.released = true; s.dispatchEvent(new Event('release')); } }; locks.push(s); return s; } };
Object.defineProperty(globalThis.navigator, 'wakeLock', { value: fake, configurable: true });
const active = () => locks.filter(s => !s.released).length;

{ // Start asks twice at the same moment (engine.start() and the UI)
  const a = new Alerts(); const [r1, r2] = await Promise.all([a.keepAwake(true), a.keepAwake(true)]);
  check('two simultaneous requests → one lock', r1 === true && r2 === true && locks.length === 1 && active() === 1, `${locks.length} handed out`);
  check('asking again while held → still one', (await a.keepAwake(true)) === true && locks.length === 1);
  await a.keepAwake(false); check('Finish releases it: nothing keeps the screen on', active() === 0 && a.wakeLock === null, `${active()} still active`);
}
{ // Finish arrives while the request is still on its way
  locks.length = 0; const a = new Alerts(); const p = a.keepAwake(true); const off = a.keepAwake(false); await Promise.all([p, off]); await sleep(30);
  check('switched off before the lock arrived → released on arrival', active() === 0 && a.wakeLock === null, `${locks.length} handed out, ${active()} active`);
}
{ // the system drops the lock when the page is hidden; coming back asks again
  locks.length = 0; const a = new Alerts(); await a.keepAwake(true); await locks[0].release();
  check('lock taken away by the system is noticed', a.wakeLock === null);
  await a.keepAwake(true); check('…and requested again on return', locks.length === 2 && active() === 1);
  await a.keepAwake(false);
}
{ // refused (battery saver)
  locks.length = 0; refuse = true; const a = new Alerts(); check('a refused request reports false', (await a.keepAwake(true)) === false && a.wakeLock === null); refuse = false;
  check('…and a later request can succeed', (await a.keepAwake(true)) === true && active() === 1); await a.keepAwake(false);
}
{ // Finish and Start again before the first request has been answered (on, off, on in one breath): the last wish counts
  locks.length = 0; const a = new Alerts(); const r = await Promise.all([a.keepAwake(true), a.keepAwake(false), a.keepAwake(true)]); await sleep(40);
  check('on → off → on together ends with the screen kept on', active() === 1 && a.wakeLock !== null && r[2] === true, `${locks.length} handed out, ${active()} active`);
  const r2 = await Promise.all([a.keepAwake(false), a.keepAwake(true), a.keepAwake(false)]); await sleep(40);
  check('off → on → off together ends with nothing held', active() === 0 && a.wakeLock === null && r2[2] === true, `${active()} active`);
}
{ // released and wanted again while the release is still in progress
  locks.length = 0; const a = new Alerts(); await a.keepAwake(true);
  const slow = locks[0]; const rel = slow.release; slow.release = async () => { await sleep(20); return rel(); };
  const off = a.keepAwake(false); const on = a.keepAwake(true); await Promise.all([off, on]); await sleep(40);
  check('Start pressed while the old lock is being released → a new lock is taken', active() === 1 && a.wakeLock !== null && a.wakeLock !== slow, `${locks.length} handed out, ${active()} active`);
  await a.keepAwake(false);
}
{ // a burst of presses never leaves more than one lock, and the end state follows the last press
  locks.length = 0; const a = new Alerts(); const seq = [true, false, true, true, false, true, false, false, true, false];
  await Promise.all(seq.map(on => a.keepAwake(on))); await sleep(60);
  check('ten presses in a row, last one "off" → nothing held', active() === 0 && a.wakeLock === null, `${locks.length} handed out, ${active()} active`);
  await Promise.all([...seq, true].map(on => a.keepAwake(on))); await sleep(60);
  check('…last one "on" → exactly one held', active() === 1 && a.wakeLock !== null, `${active()} active`);
  await a.keepAwake(false);
}
{ // two opposite wishes in the same instant, the first of which finds nothing to do (the worker has had its last look already)
  locks.length = 0; const a = new Alerts(); await a.keepAwake(true);
  a.keepAwake(true); const off = a.keepAwake(false); check('held, then "on" and "off" in the same instant → released', (await off) === true && active() === 0 && a.wakeLock === null, `${active()} active`); await sleep(40);
  check('…and it stays released', active() === 0 && a.wakeLock === null);
  a.keepAwake(false); const on = a.keepAwake(true); check('nothing held, then "off" and "on" in the same instant → held', (await on) === true && active() === 1 && a.wakeLock !== null, `${active()} active`);
  await a.keepAwake(false);
  locks.length = 0; refuse = true; const b = new Alerts(); const t0 = Date.now(); const r = await b.keepAwake(true); refuse = false;
  check('a refused request is not asked for again and again in one call', r === false && Date.now() - t0 < 40, `${Date.now() - t0} ms`);
}
{ // a phone without the Wake Lock API
  const saved = Object.getOwnPropertyDescriptor(globalThis.navigator, 'wakeLock'); Object.defineProperty(globalThis.navigator, 'wakeLock', { value: undefined, configurable: true });
  const a = new Alerts(); check('no Wake Lock API → false for on, true for off, no error', (await a.keepAwake(true)) === false && (await a.keepAwake(false)) === true);
  Object.defineProperty(globalThis.navigator, 'wakeLock', saved);
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS'); process.exit(failures ? 1 : 0);

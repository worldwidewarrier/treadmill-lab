// node test/test_ble.mjs — js/ble.js against a mock Web Bluetooth that behaves like Chrome:
// one characteristic object per connection (asking again returns the same object), and operations that were
// under way when the link dropped reject with NetworkError. Takes ≈45 s (real reconnect timers).
import { HeartRateSource, parseHrMeasurement } from '../js/ble.js';
let failures = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const netErr = () => Object.assign(new Error('GATT Server is disconnected. Cannot retrieve services.'), { name: 'NetworkError' });

class MockDevice extends EventTarget {
  constructor() {
    super(); this.name = 'Polar H10 TEST'; this.conn = 0; this.connected = false; this.failDiscovery = 0; this.connectCalls = 0; this.chars = new Map(); const dev = this;
    this.hang = null; this.battery = null; this.hangBattery = false; // hang: 'service' | 'notify' = that call never answers, once
    this.hold = false; this.waiters = []; this.log = []; // hold = the strap is out of range: gatt.connect() stays pending until reach() is called
    this.gatt = { get connected() { return dev.connected; }, async connect() { dev.connectCalls++; if (dev.hold) await new Promise(r => dev.waiters.push(r)); else await sleep(20); if (!dev.connected) { dev.connected = true; dev.conn++; dev.log.push('link up'); } return dev.server(dev.conn); }, disconnect() { if (dev.connected) { dev.log.push('gatt.disconnect()'); dev.drop(); } } };
  }
  server(conn) {
    const dev = this; return {
      async getPrimaryService(name) {
        if (name === 'heart_rate' && dev.hang === 'service') { dev.hang = null; return new Promise(() => {}); } // a GATT call that never answers
        await sleep(20); if (!dev.connected || dev.conn !== conn) throw netErr();
        if (name === 'battery_service' && dev.battery != null) return { async getCharacteristic() { return { readValue: () => dev.hangBattery ? new Promise(() => {}) : sleep(15).then(() => new DataView(Uint8Array.of(dev.battery).buffer)) }; } };
        if (name === 'heart_rate' && dev.failDiscovery > 0) { dev.failDiscovery--; dev.drop(); throw netErr(); } // the link drops during service discovery
        if (name !== 'heart_rate') throw Object.assign(new Error('no such service'), { name: 'NotFoundError' });
        return { async getCharacteristic() {
          await sleep(10); if (!dev.connected || dev.conn !== conn) throw netErr();
          if (!dev.chars.has(conn)) { const c = new EventTarget(); c.notifying = false; c.startNotifications = async () => { if (dev.hang === 'notify') { dev.hang = null; return new Promise(() => {}); } await sleep(10); if (!dev.connected || dev.conn !== conn) throw netErr(); c.notifying = true; return c; }; c.stopNotifications = async () => { c.notifying = false; }; dev.chars.set(conn, c); }
          return dev.chars.get(conn);
        } };
      },
    };
  }
  drop() { this.connected = false; this.dispatchEvent(new Event('gattserverdisconnected')); }
  reach() { this.hold = false; this.waiters.splice(0).forEach(r => r()); } // the strap is in range again: every pending connect() completes
  /** One heart-rate notification: flags 0x10 (RR present), HR uint8, one RR in 1/1024 s. */
  notify(hr = 120, rrMs = 500) { const c = this.chars.get(this.conn); if (!this.connected || !c || !c.notifying) return false; const dv = new DataView(new ArrayBuffer(4)); dv.setUint8(0, 0x10); dv.setUint8(1, hr); dv.setUint16(2, Math.round(rrMs * 1024 / 1000), true); const ev = new Event('characteristicvaluechanged'); Object.defineProperty(ev, 'target', { value: { value: dv } }); c.dispatchEvent(ev); return true; }
}
const install = dev => Object.defineProperty(globalThis.navigator, 'bluetooth', { value: { requestDevice: async () => { if (dev.chooserMs) await sleep(dev.chooserMs); if (dev.cancel) throw Object.assign(new Error('User cancelled the requestDevice() chooser.'), { name: 'NotFoundError' }); return dev; } }, configurable: true });

// parser: 16-bit HR, energy field skipped, two RR intervals, contact bits
{ const dv = new DataView(new ArrayBuffer(9)); dv.setUint8(0, 0x01 | 0x02 | 0x04 | 0x08 | 0x10); dv.setUint16(1, 300, true); dv.setUint16(3, 1234, true); dv.setUint16(5, 1024, true); dv.setUint16(7, 512, true);
  const p = parseHrMeasurement(dv); check('parser: uint16 HR, energy skipped, RR in ms, contact', p.hr === 300 && p.rr.length === 2 && p.rr[0] === 1000 && p.rr[1] === 500 && p.contact === true, JSON.stringify(p)); }

// A — the link drops, and drops again while the first reconnect attempt is discovering services
{ const dev = new MockDevice(); install(dev); const src = new HeartRateSource(); const got = []; src.on('hr', e => got.push(e)); await src.connect();
  dev.notify(120, 500); check('connected: one event per notification, RR decoded', got.length === 1 && Math.abs(got[0].rr[0] - 500) < 1 && src.status === 'connected', `${got.length} event(s)`);
  got.length = 0; dev.failDiscovery = 1; dev.drop(); await sleep(6000);
  const delivered = dev.notify(121, 495); await sleep(50);
  check('reconnects after a drop during rediscovery', delivered && src.status === 'connected', src.status);
  check('still exactly one event per notification after the flaky reconnect (no doubled RR)', got.length === 1, `${got.length} event(s)`);
  for (let i = 0; i < 3; i++) { dev.drop(); await sleep(1400); } const before = got.length; dev.notify(); await sleep(50);
  check('…and after three more drops', got.length - before === 1, `${got.length - before} event(s)`);
  await src.disconnect(); check('disconnect() closes the link', !dev.connected && src.status === 'disconnected'); }

// B — the very first connection fails during discovery: the caller gets the error and nothing keeps running
{ const dev = new MockDevice(); install(dev); const src = new HeartRateSource(); let n = 0; src.on('hr', () => n++); dev.failDiscovery = 1; let err = null;
  try { await src.connect(); } catch (e) { err = e.name; }
  const calls = dev.connectCalls; await sleep(4000); dev.notify(); await sleep(50);
  check('first connection failure is reported', err === 'NetworkError', String(err));
  check('no reconnecting behind the app\'s back afterwards', dev.connectCalls === calls && !dev.connected && src.status === 'disconnected' && n === 0, `connect calls +${dev.connectCalls - calls}, status ${src.status}, events ${n}`); }

// C — chooser cancelled
{ const dev = new MockDevice(); dev.cancel = true; install(dev); const src = new HeartRateSource(); let err = null; try { await src.connect(); } catch (e) { err = e.name; }
  check('cancelled chooser → NotFoundError, source idle', err === 'NotFoundError' && src.status === 'disconnected' && src.wantConnected === false, `${err} ${src.status}`); }

// D — disconnect() while a reconnect is pending or running
{ const dev = new MockDevice(); install(dev); const src = new HeartRateSource(); await src.connect(); dev.drop(); await sleep(200); await src.disconnect(); const calls = dev.connectCalls; await sleep(3000);
  check('disconnect() cancels a pending reconnect', dev.connectCalls === calls && !dev.connected, `connect calls +${dev.connectCalls - calls}`);
  const dev2 = new MockDevice(); install(dev2); const src2 = new HeartRateSource(); let n = 0; src2.on('hr', () => n++); await src2.connect(); dev2.drop(); await sleep(1010); /* attempt under way */ await src2.disconnect(); await sleep(500); dev2.notify(); await sleep(50);
  check('disconnect() during a running attempt leaves nothing connected', !dev2.connected && src2.status === 'disconnected' && n === 0, `connected ${dev2.connected}, status ${src2.status}, events ${n}`); }

// E — a second source on the same device object (reconnect button) does not inherit listeners from the first
{ const dev = new MockDevice(); install(dev); const a = new HeartRateSource(); let na = 0; a.on('hr', () => na++); await a.connect(); await a.disconnect();
  const b = new HeartRateSource(); let nb = 0; b.on('hr', () => nb++); await b.connect(); dev.notify(); await sleep(50);
  check('old source is silent, new source gets one event', na === 0 && nb === 1, `old ${na}, new ${nb}`);
  dev.drop(); await sleep(1500); dev.notify(); await sleep(50); check('only the new source reconnects', b.status === 'connected' && a.status === 'disconnected' && nb === 2 && na === 0, `old ${a.status}/${na}, new ${b.status}/${nb}`);
  await b.disconnect(); }

// F — "Connect" pressed again while the old source is still trying to reach the strap (out of range): the new source must come up
//     and stay up when the old attempt finally completes — both hold the same BluetoothDevice object
{ const dev = new MockDevice(); install(dev); const a = new HeartRateSource(); let na = 0; a.on('hr', () => na++); await a.connect();
  dev.hold = true; dev.drop(); await sleep(1200); // the first reconnect attempt of A is now waiting in gatt.connect()
  check('old source is waiting for the strap', a.status === 'connecting' && dev.waiters.length === 1, `${a.status}, ${dev.waiters.length} pending`);
  await a.disconnect(); const b = new HeartRateSource(); let nb = 0; const seen = []; b.on('hr', () => nb++); b.on('status', x => seen.push(x.status)); const pb = b.connect(); await sleep(100);
  dev.reach(); let err = null; try { await pb; } catch (e) { err = e.name; } await sleep(300); dev.notify(); await sleep(50);
  check('new source connects although the old attempt was still pending', err === null && b.status === 'connected' && dev.connected, `${err || 'resolved'}, ${b.status}, link ${dev.connected}`);
  check('the old attempt, waking up, does not cut the new link', !dev.log.includes('gatt.disconnect()') && nb === 1 && na === 0 && a.status === 'disconnected', `log: ${dev.log.join('; ')} · events new ${nb} old ${na}`);
  await sleep(2500); dev.notify(); await sleep(50); check('…and nothing happens later either', b.status === 'connected' && nb === 2 && !seen.includes('reconnecting'), `${b.status}, ${nb} events, statuses ${seen.join(' → ')}`);
  await b.disconnect(); check('the owner can still close the link', !dev.connected); }

// G — two sources alive on one device (the old one was never told to stop): stopping the old one leaves the new one connected
{ const dev = new MockDevice(); install(dev); const a = new HeartRateSource(); let na = 0; a.on('hr', () => na++); await a.connect(); const b = new HeartRateSource(); let nb = 0; b.on('hr', () => nb++); await b.connect(); await sleep(50);
  check('a newer source on the same strap retires the older one by itself', a.status === 'disconnected' && a.wantConnected === false && b.status === 'connected' && dev.connected, `old ${a.status}, new ${b.status}, link ${dev.connected}`);
  dev.notify(); await sleep(50); check('…only the newer one receives the heart rate', na === 0 && nb === 1, `old ${na}, new ${nb}`); nb = 0;
  await a.disconnect(); await sleep(100); dev.notify(); await sleep(50);
  check('disconnect() of a superseded source does not drop the link of its successor', dev.connected && b.status === 'connected' && nb === 1, `link ${dev.connected}, new ${b.status}, events ${nb}`);
  await b.disconnect(); check('…the successor closes it', !dev.connected); }

// H — Cancel while the first connection is still under way
{ const dev = new MockDevice(); dev.hold = true; install(dev); const src = new HeartRateSource(); let n = 0; src.on('hr', () => n++); let out = 'pending'; const p = src.connect().then(() => { out = 'resolved'; }, e => { out = 'rejected ' + e.name; });
  await sleep(100); check('first connection is waiting for the strap', src.status === 'connecting' && out === 'pending', `${src.status}, ${out}`);
  await src.disconnect(); dev.reach(); await p; await sleep(300); dev.notify(); await sleep(50);
  check('disconnect() during the first attempt: connect() does not report success', out === 'rejected AbortError', out);
  check('…and the link that came up afterwards is closed again, nothing retries', !dev.connected && src.status === 'disconnected' && n === 0, `link ${dev.connected}, ${src.status}, events ${n}`);
  const calls = dev.connectCalls; await sleep(2500); check('…for good', dev.connectCalls === calls && !dev.connected, `connect calls +${dev.connectCalls - calls}`); }

// I — Cancel while the browser's device chooser is still open
{ const dev = new MockDevice(); dev.chooserMs = 200; install(dev); const src = new HeartRateSource(); let out = 'pending'; const p = src.connect().then(() => { out = 'resolved'; }, e => { out = 'rejected ' + e.name; });
  await sleep(50); await src.disconnect(); await p; await sleep(200);
  check('disconnect() while the chooser is open: no connection is made', out === 'rejected AbortError' && dev.connectCalls === 0 && !dev.connected && src.status === 'disconnected', `${out}, connect calls ${dev.connectCalls}`); }

// J — a GATT call that never answers during a reconnect, then the link drops again: the next attempt must start afresh
{ const dev = new MockDevice(); install(dev); const src = new HeartRateSource(); let n = 0; src.on('hr', () => n++); await src.connect();
  dev.hang = 'service'; dev.drop(); await sleep(1300);
  check('reconnect attempt is waiting in a call that never answers', src.status === 'connecting' && dev.connected, `${src.status}, link ${dev.connected}`);
  dev.drop(); await sleep(2500); dev.notify(); await sleep(50);
  check('the link drops again → a fresh attempt connects, one event per notification', src.status === 'connected' && dev.connected && n === 1, `${src.status}, link ${dev.connected}, events ${n}`);
  await src.disconnect(); check('…and disconnect() still closes the link', !dev.connected); }

// K — the same without a second drop: the attempt is given up after the time limit, the half-open link is reset, a new attempt connects
{ const keep = HeartRateSource.ATTEMPT_MS; HeartRateSource.ATTEMPT_MS = 600;
  const dev = new MockDevice(); install(dev); const src = new HeartRateSource(); let n = 0; src.on('hr', () => n++); await src.connect();
  dev.hang = 'notify'; dev.drop(); await sleep(1300);
  check('reconnect attempt stuck in startNotifications(), link up', src.status === 'connecting' && dev.connected, `${src.status}, link ${dev.connected}`);
  await sleep(2200); dev.notify(); await sleep(50);
  check('given up after the time limit, link reset, new attempt connected', src.status === 'connected' && dev.connected && n === 1 && dev.log.includes('gatt.disconnect()'), `${src.status}, events ${n}, log: ${dev.log.join('; ')}`);
  const calls = dev.connectCalls; await sleep(1500); dev.notify(); await sleep(50); check('a finished attempt is never "given up" afterwards', src.status === 'connected' && dev.connectCalls === calls && n === 2, `${src.status}, connect calls +${dev.connectCalls - calls}, events ${n}`);
  await src.disconnect();
  // first connection to a strap that never answers: the caller hears about it, nothing stays behind
  const dev2 = new MockDevice(); dev2.hold = true; install(dev2); const s2 = new HeartRateSource(); let out = 'pending'; const p = s2.connect().then(() => { out = 'resolved'; }, e => { out = 'rejected ' + e.name; }); await sleep(900);
  check('first connection that never completes → TimeoutError after the limit', out === 'rejected TimeoutError' && s2.status === 'disconnected', `${out}, ${s2.status}`);
  dev2.reach(); await p; await sleep(300); const c2 = dev2.connectCalls; await sleep(1500);
  check('…and when the strap answers later the link is closed again, no retry', !dev2.connected && dev2.connectCalls === c2 && s2.status === 'disconnected', `link ${dev2.connected}, connect calls +${dev2.connectCalls - c2}`);
  HeartRateSource.ATTEMPT_MS = keep; }

// L — battery level: read after the connection is reported, never holds it up
{ const keep = HeartRateSource.ATTEMPT_MS; HeartRateSource.ATTEMPT_MS = 500;
  const dev = new MockDevice(); dev.battery = 87; install(dev); const src = new HeartRateSource(); let batt = null; src.on('battery', b => { batt = b; }); await src.connect();
  check('connected is reported without waiting for the battery level', src.status === 'connected' && batt === null);
  await sleep(120); check('…which arrives a moment later', batt === 87 && src.battery === 87, String(batt)); await src.disconnect();
  const dev2 = new MockDevice(); dev2.battery = 50; dev2.hangBattery = true; install(dev2); const s2 = new HeartRateSource(); let n = 0; s2.on('hr', () => n++); await s2.connect(); await sleep(1200); dev2.notify(); await sleep(50);
  check('a battery read that never answers neither blocks nor resets the connection', s2.status === 'connected' && dev2.connected && n === 1 && !dev2.log.includes('gatt.disconnect()'), `${s2.status}, events ${n}, log: ${dev2.log.join('; ')}`);
  await s2.disconnect(); HeartRateSource.ATTEMPT_MS = keep; }

// M — two sources started back to back on the same strap, neither stopped by the app (overlapping taps): one survives, nothing lingers
{ const dev = new MockDevice(); dev.chooserMs = 30; install(dev); const a = new HeartRateSource(), b = new HeartRateSource(); let na = 0, nb = 0; a.on('hr', () => na++); b.on('hr', () => nb++);
  const ra = a.connect().then(() => 'ok', e => e.name); await sleep(10); const rb = b.connect().then(() => 'ok', e => e.name); const res = [await ra, await rb]; await sleep(200); dev.notify(); await sleep(50);
  check('overlapping connects: the later one is connected, the earlier one cancelled', res[1] === 'ok' && res[0] === 'AbortError' && b.status === 'connected' && a.status === 'disconnected' && nb === 1 && na === 0, `${res.join(' / ')}; ${a.status} / ${b.status}; events ${na} / ${nb}`);
  await b.disconnect(); const calls = dev.connectCalls; await sleep(2500);
  check('…after disconnecting it the link is closed and nothing reconnects', !dev.connected && dev.connectCalls === calls, `link ${dev.connected}, connect calls +${dev.connectCalls - calls}`); }

// N — Cancel while the first attempt is in service discovery (link already up): told as a cancellation, link closed
{ const dev = new MockDevice(); dev.hang = 'service'; install(dev); const src = new HeartRateSource(); let out = 'pending'; const p = src.connect().then(() => { out = 'resolved'; }, e => { out = 'rejected ' + e.name; });
  await sleep(150); check('first attempt is in discovery with the link up', src.status === 'connecting' && dev.connected);
  await src.disconnect(); await p; await sleep(100);
  check('disconnect() during discovery → AbortError, link closed, source idle', out === 'rejected AbortError' && !dev.connected && src.status === 'disconnected', `${out}, link ${dev.connected}, ${src.status}`); }

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS'); process.exit(failures ? 1 : 0);

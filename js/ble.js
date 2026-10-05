// Polar H10 (any BLE heart-rate strap) via Web Bluetooth. Emits: 'status', 'hr', 'battery', 'error'.
// hr events: { t (ms, receive time), hr, rr: [ms...], contact }
const HR_SERVICE = 'heart_rate', HR_MEAS = 'heart_rate_measurement', BATT = 'battery_service', BATT_LVL = 'battery_level';

export function parseHrMeasurement(dv) {
  const flags = dv.getUint8(0); const hr16 = flags & 0x01; let i = 1;
  const hr = hr16 ? dv.getUint16(i, true) : dv.getUint8(i); i += hr16 ? 2 : 1;
  if (flags & 0x08) i += 2; // energy expended
  const rr = [];
  if (flags & 0x10) while (i + 1 < dv.byteLength) { rr.push(dv.getUint16(i, true) * 1000 / 1024); i += 2; }
  return { hr, rr, contact: (flags & 0x04) ? !!(flags & 0x02) : null };
}

// Pressing Connect again hands the SAME BluetoothDevice object to a new HeartRateSource. Only the instance that asked for the
// device last (its owner) may drop the GATT link or stop the notifications; an older instance is retired when the new one
// takes over, and whatever it is still finishing must not cut the new one off.
const owners = new WeakMap();
const cancelled = () => Object.assign(new Error('connection cancelled'), { name: 'AbortError' });

export class HeartRateSource {
  constructor() {
    this.listeners = {}; this.device = null; this.char = null; this.status = 'idle'; this.battery = null; this.wantConnected = false; this._retry = null; this._opening = null; this.name = ''; this.kind = 'ble';
    this._attempt = 0; this._giveUp = null; this._openTimer = null; // the connection attempt in flight (see open())
    // One stable handler each: addEventListener ignores a function that is already registered, so a second
    // open() on the same characteristic can never make every notification (and every RR interval) arrive twice.
    this._onValue = ev => { const p = parseHrMeasurement(ev.target.value); this.emit('hr', { t: this.now(), ...p }); };
    this._onGattDisconnected = () => this.onDisconnected();
  }
  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; }
  off(ev, fn) { if (this.listeners[ev]) this.listeners[ev] = this.listeners[ev].filter(f => f !== fn); return this; }
  emit(ev, data) { (this.listeners[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }
  setStatus(s, detail = '') { this.status = s; this.emit('status', { status: s, detail, name: this.name, battery: this.battery }); }
  static available() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }
  now() { return Date.now(); }

  async connect() {
    if (!HeartRateSource.available()) throw new Error('Web Bluetooth not available');
    this.wantConnected = true;
    this.setStatus('requesting');
    try {
      this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [HR_SERVICE] }], optionalServices: [BATT] });
      if (!this.wantConnected) throw cancelled(); // disconnect() while the chooser was open
      const prev = owners.get(this.device); owners.set(this.device, this);
      if (prev && prev !== this) prev.disconnect().catch(() => {}); // one source per strap: an older one that was never told to stop stands down (no longer the owner, it cannot cut the link)
      this.name = this.device.name || 'HR sensor';
      this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
      this.device.addEventListener('gattserverdisconnected', this._onGattDisconnected);
      await this.open();
      if (!this.wantConnected) throw cancelled(); // disconnect() arrived during the attempt: this is not a successful connection
    } catch (e) {
      // The first connection failed (cancelled, or dropped during discovery): stop completely instead of
      // retrying in the background on an object the app has already thrown away.
      await this.disconnect();
      throw e;
    }
  }

  /**
   * Connect + subscribe. Only one attempt runs at a time; concurrent callers share it.
   * An attempt is given up — and the next open() starts afresh — when the link it was using drops, when disconnect() is
   * called, or when it has not finished after ATTEMPT_MS: a GATT call that never returns must not block every later reconnect
   * (there is no Connect button during a session).
   */
  open() {
    if (this._opening) return this._opening;
    const my = ++this._attempt; let giveUp; const givenUp = new Promise((_, reject) => { giveUp = reject; });
    const p = Promise.race([this._open(my), givenUp]);
    const done = () => { if (this._opening === p) { this._opening = null; this._giveUp = null; clearTimeout(this._openTimer); this._openTimer = null; } };
    p.then(done, done);
    this._opening = p; this._giveUp = giveUp;
    this._openTimer = setTimeout(() => { if (this._opening === p) this.abandonAttempt(Object.assign(new Error('연결 시도가 제한 시간 안에 끝나지 않았습니다 / connection attempt timed out'), { name: 'TimeoutError' }), true); }, HeartRateSource.ATTEMPT_MS);
    return p;
  }
  /** Give up the attempt in flight: whoever waits for it gets `err`; whatever the old attempt still does is ignored. resetLink also drops a half-open GATT link. */
  abandonAttempt(err, resetLink = false) {
    if (!this._opening) return;
    const giveUp = this._giveUp; this._attempt++; this._opening = null; this._giveUp = null; clearTimeout(this._openTimer); this._openTimer = null;
    if (resetLink) { try { if (this.device && owners.get(this.device) === this && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) { /* ignore */ } }
    if (giveUp) giveUp(err);
  }
  async _open(my) {
    // After every wait: has this attempt been given up, or the connection been cancelled, in the meantime? A given-up attempt
    // leaves everything alone — except that a link which came up after disconnect() is closed again (release() checks ownership).
    const over = () => { if (my !== this._attempt) { if (!this.wantConnected) this.release(); return true; } if (!this.wantConnected) { this.release(); return true; } return false; };
    this.setStatus('connecting');
    const server = await this.device.gatt.connect();
    if (over()) return;
    const svc = await server.getPrimaryService(HR_SERVICE);
    const ch = await svc.getCharacteristic(HR_MEAS);
    if (over()) return;
    if (this.char && this.char !== ch) this.char.removeEventListener('characteristicvaluechanged', this._onValue);
    ch.addEventListener('characteristicvaluechanged', this._onValue);
    this.char = ch;
    await ch.startNotifications();
    if (over()) return;
    if (!this.device.gatt.connected) throw Object.assign(new Error('GATT server disconnected during setup'), { name: 'NetworkError' });
    this.setStatus('connected');
    this.readBattery(server); // optional and not waited for: the heart rate is already flowing
  }
  async readBattery(server) {
    try { const bs = await server.getPrimaryService(BATT); const bl = await bs.getCharacteristic(BATT_LVL); const v = await bl.readValue(); if (this.wantConnected && this.status === 'connected') { this.battery = v.getUint8(0); this.emit('battery', this.battery); } } catch (e) { /* optional */ }
  }
  /** Drop the notification handler and — if the device has not been taken over by a newer instance — the GATT link (no status change). */
  release() {
    const ch = this.char; this.char = null;
    try { if (ch) ch.removeEventListener('characteristicvaluechanged', this._onValue); } catch (e) { /* ignore */ }
    try { if (this.device && owners.get(this.device) === this && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) { /* ignore */ }
  }

  onDisconnected() {
    try { if (this.char) this.char.removeEventListener('characteristicvaluechanged', this._onValue); } catch (e) { /* ignore */ }
    this.char = null;
    this.abandonAttempt(Object.assign(new Error('GATT server disconnected during setup'), { name: 'NetworkError' })); // an attempt that was using this link will not finish
    if (!this.wantConnected) { this.setStatus('disconnected'); return; }
    this.setStatus('reconnecting');
    this.scheduleRetry(0);
  }
  /** At most one pending retry: a drop during a reconnect attempt must not start a second chain. */
  scheduleRetry(n) {
    clearTimeout(this._retry);
    this._retry = setTimeout(async () => {
      this._retry = null;
      if (!this.wantConnected || !this.device) return;
      if (this.status === 'connected' && this.char && this.device.gatt.connected) return; // already back
      try { await this.open(); }
      catch (e) { if (this.wantConnected && this._retry == null) this.scheduleRetry(n + 1); }
    }, Math.min(5000, 1000 + n * 1000));
  }

  async disconnect() {
    this.wantConnected = false; clearTimeout(this._retry); this._retry = null;
    this.abandonAttempt(cancelled()); // connect() waiting for an attempt is told at once; the attempt itself, should it ever return, closes what it opened
    const ch = this.char; const own = !!this.device && owners.get(this.device) === this;
    // Best effort, never longer than 1.5 s: dropping the GATT link below ends the notifications anyway. Only the owner does it —
    // the characteristic object is shared by every source on the same connection, and stopping it would silence the newer one.
    try { if (own && ch && this.device.gatt.connected) await Promise.race([Promise.resolve(ch.stopNotifications()).catch(() => {}), new Promise(r => setTimeout(r, 1500))]); } catch (e) { /* ignore */ }
    this.release();
    try { if (this.device) this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnected); } catch (e) { /* ignore */ }
    this.setStatus('disconnected');
  }
}
/** A connection attempt that has not finished after this many ms is given up and started afresh. */
HeartRateSource.ATTEMPT_MS = 20000;

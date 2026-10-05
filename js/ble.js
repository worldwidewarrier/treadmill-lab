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
// device last may drop its GATT link; an older instance that is still finishing an attempt must not cut the new one off.
const owners = new WeakMap();
const cancelled = () => Object.assign(new Error('connection cancelled'), { name: 'AbortError' });

export class HeartRateSource {
  constructor() {
    this.listeners = {}; this.device = null; this.char = null; this.status = 'idle'; this.battery = null; this.wantConnected = false; this._retry = null; this._opening = null; this.name = ''; this.kind = 'ble';
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
      owners.set(this.device, this);
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

  /** Connect + subscribe. Only one attempt runs at a time; concurrent callers share it. */
  open() {
    if (!this._opening) this._opening = this._open().finally(() => { this._opening = null; });
    return this._opening;
  }
  async _open() {
    this.setStatus('connecting');
    const server = await this.device.gatt.connect();
    if (!this.wantConnected) { this.release(); return; } // disconnect() was called while this attempt was running
    const svc = await server.getPrimaryService(HR_SERVICE);
    const ch = await svc.getCharacteristic(HR_MEAS);
    if (!this.wantConnected) { this.release(); return; }
    if (this.char && this.char !== ch) this.char.removeEventListener('characteristicvaluechanged', this._onValue);
    ch.addEventListener('characteristicvaluechanged', this._onValue);
    this.char = ch;
    await ch.startNotifications();
    if (!this.wantConnected) { this.release(); return; }
    try { const bs = await server.getPrimaryService(BATT); const bl = await bs.getCharacteristic(BATT_LVL); const v = await bl.readValue(); this.battery = v.getUint8(0); this.emit('battery', this.battery); } catch (e) { /* optional */ }
    if (!this.wantConnected) { this.release(); return; }
    if (!this.device.gatt.connected) throw Object.assign(new Error('GATT server disconnected during setup'), { name: 'NetworkError' });
    this.setStatus('connected');
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
    const ch = this.char; const own = !!this.device && owners.get(this.device) === this;
    // Best effort, never longer than 1.5 s: dropping the GATT link below ends the notifications anyway. Only the owner does it —
    // the characteristic object is shared by every source on the same connection, and stopping it would silence the newer one.
    try { if (own && ch && this.device.gatt.connected) await Promise.race([Promise.resolve(ch.stopNotifications()).catch(() => {}), new Promise(r => setTimeout(r, 1500))]); } catch (e) { /* ignore */ }
    this.release();
    try { if (this.device) this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnected); } catch (e) { /* ignore */ }
    this.setStatus('disconnected');
  }
}

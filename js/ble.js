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

export class HeartRateSource {
  constructor() { this.listeners = {}; this.device = null; this.char = null; this.status = 'idle'; this.battery = null; this.wantConnected = false; this._retry = null; this.name = ''; this.kind = 'ble'; }
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
    this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [HR_SERVICE] }], optionalServices: [BATT] });
    this.name = this.device.name || 'HR sensor';
    this.device.addEventListener('gattserverdisconnected', () => this.onDisconnected());
    await this.open();
  }

  async open() {
    this.setStatus('connecting');
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(HR_SERVICE);
    this.char = await svc.getCharacteristic(HR_MEAS);
    this.char.addEventListener('characteristicvaluechanged', ev => {
      const p = parseHrMeasurement(ev.target.value);
      this.emit('hr', { t: this.now(), ...p });
    });
    await this.char.startNotifications();
    try { const bs = await server.getPrimaryService(BATT); const bl = await bs.getCharacteristic(BATT_LVL); const v = await bl.readValue(); this.battery = v.getUint8(0); this.emit('battery', this.battery); } catch (e) { /* optional */ }
    this.setStatus('connected');
  }

  onDisconnected() {
    this.char = null;
    if (!this.wantConnected) { this.setStatus('disconnected'); return; }
    this.setStatus('reconnecting');
    const attempt = async (n) => {
      if (!this.wantConnected || !this.device) return;
      try { await this.open(); }
      catch (e) { this._retry = setTimeout(() => attempt(n + 1), Math.min(5000, 1000 + n * 1000)); }
    };
    this._retry = setTimeout(() => attempt(0), 1000);
  }

  async disconnect() {
    this.wantConnected = false; clearTimeout(this._retry);
    try { if (this.char) await this.char.stopNotifications(); } catch (e) { /* ignore */ }
    try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) { /* ignore */ }
    this.setStatus('disconnected');
  }
}

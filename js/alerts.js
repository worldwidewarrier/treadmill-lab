// Voice (Korean TTS), vibration and beep alerts + screen wake lock.
export class Alerts {
  constructor(settings = {}) { this.settings = { voice: true, vibrate: true, beep: true, volume: 1, ...settings }; this.ctx = null; this.koVoice = null; this.lastSpoken = {}; this.wakeLock = null; this.muted = false;
    if (typeof speechSynthesis !== 'undefined') { const pick = () => { const v = speechSynthesis.getVoices().filter(x => /^ko/i.test(x.lang)); this.koVoice = v.find(x => /google|samsung|premium|enhanced/i.test(x.name)) || v[0] || null; }; pick(); speechSynthesis.onvoiceschanged = pick; }
  }
  update(settings) { Object.assign(this.settings, settings); }
  /** Call from a user gesture once to unlock audio. */
  unlock() { try { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); if (this.ctx.state === 'suspended') this.ctx.resume(); } catch (e) { /* no audio */ } }
  beep(pattern = 'single') {
    if (!this.settings.beep || this.muted) return;
    try {
      this.unlock(); const ctx = this.ctx; if (!ctx) return;
      const seq = pattern === 'double' ? [[880, 0, 0.12], [880, 0.18, 0.12]] : pattern === 'triple' ? [[988, 0, 0.1], [988, 0.15, 0.1], [988, 0.3, 0.1]] : pattern === 'low' ? [[440, 0, 0.3]] : pattern === 'high' ? [[1320, 0, 0.2]] : [[880, 0, 0.15]];
      for (const [f, dt, dur] of seq) { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.value = f; g.gain.value = 0.0001; o.connect(g).connect(ctx.destination); const t0 = ctx.currentTime + dt; g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.5 * this.settings.volume, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); o.start(t0); o.stop(t0 + dur + 0.02); }
    } catch (e) { /* ignore */ }
  }
  vibrate(pattern = [200]) { if (!this.settings.vibrate || this.muted) return; try { navigator.vibrate && navigator.vibrate(pattern); } catch (e) { /* ignore */ } }
  speak(text, { key = null, minGapSec = 0, interrupt = false } = {}) {
    if (!this.settings.voice || this.muted || typeof speechSynthesis === 'undefined') return false;
    const now = Date.now(); if (key && minGapSec && this.lastSpoken[key] && now - this.lastSpoken[key] < minGapSec * 1000) return false;
    if (key) this.lastSpoken[key] = now;
    try { const u = new SpeechSynthesisUtterance(text); u.lang = 'ko-KR'; if (this.koVoice) u.voice = this.koVoice; u.rate = 1.0; u.volume = this.settings.volume; if (interrupt) speechSynthesis.cancel(); speechSynthesis.speak(u); return true; } catch (e) { return false; }
  }
  /** Combined cue: beep + vibration + voice. */
  cue(text, { beep = 'single', vib = [200], key = null, minGapSec = 0, interrupt = false } = {}) { this.beep(beep); this.vibrate(vib); if (text) this.speak(text, { key, minGapSec, interrupt }); }
  async keepAwake(on) {
    try {
      if (on) { if (!('wakeLock' in navigator)) return false; if (this.wakeLock) return true; this.wakeLock = await navigator.wakeLock.request('screen'); this.wakeLock.addEventListener('release', () => { this.wakeLock = null; }); return true; }
      if (this.wakeLock) { await this.wakeLock.release(); this.wakeLock = null; } return true;
    } catch (e) { this.wakeLock = null; return false; }
  }
}

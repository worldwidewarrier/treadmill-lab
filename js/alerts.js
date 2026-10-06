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
  /**
   * Screen wake lock. Only one lock is ever held: Start asks twice in the same instant (engine + UI), and two
   * requests used to return two locks of which only one was released at Finish — the screen then never slept.
   * keepAwake() only notes what is wanted; one worker at a time (settleWake) brings the lock into line with the
   * LATEST wish, so on → off → on in quick succession ends with the lock held and on → off with none.
   */
  async keepAwake(on) {
    this.wantAwake = !!on;
    if (on && !(typeof navigator !== 'undefined' && navigator.wakeLock)) return false;
    // One worker at a time. It may have had its last look just before this wish arrived (two calls in the same instant, the first
    // finding nothing to do): so look again until the lock agrees with the latest wish — unless the system refused the request.
    for (let i = 0; i < 3; i++) {
      if (!this.wakeBusy) { const w = this.settleWake(); this.wakeBusy = w; const clear = () => { if (this.wakeBusy === w) this.wakeBusy = null; }; w.then(clear, clear); }
      let refused = false; try { refused = await this.wakeBusy; } catch (e) { /* the worker never throws; nothing to do if it did */ }
      if (refused || (this.wantAwake ? !!this.wakeLock : !this.wakeLock)) break;
    }
    return this.wantAwake ? !!this.wakeLock : !this.wakeLock;
  }
  /** Brings the lock into line with the wish, re-reading the wish after every wait. → true when the system refused a request. */
  async settleWake() {
    for (let i = 0; i < 8; i++) { // 8 rounds is far more than a burst of presses needs
      if (this.wantAwake && !this.wakeLock) {
        let lock; try { lock = await navigator.wakeLock.request('screen'); } catch (e) { return true; } // refused (battery saver, page hidden): the next call asks again
        if (!this.wantAwake) { try { await lock.release(); } catch (e) { /* already gone */ } continue; } // switched off while the request was on its way
        this.wakeLock = lock; lock.addEventListener('release', () => { if (this.wakeLock === lock) this.wakeLock = null; }); // the system takes it back when the page is hidden
      } else if (!this.wantAwake && this.wakeLock) {
        const lock = this.wakeLock; this.wakeLock = null; try { await lock.release(); } catch (e) { /* already gone */ }
      } else return false;
    }
    return false;
  }
}

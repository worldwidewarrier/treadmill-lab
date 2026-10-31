// Headless UI test (v1.1.44): the split step test — Home's Saturday button opens the part, the setup card's part picker, a demo run of part 2
// (stages 1–4, samples only at 3 and 4, ends by itself after stage 4), the saved card, and the Analysis tab's merged-curve card.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { tmpdir } from 'node:os'; const S = tmpdir();
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 384, height: 790 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
let f = 0; const ck = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + ' ' + d); if (!c) f++; };
await p.clock.install({ time: new Date('2026-11-07T09:00:00+09:00') }); // Sat 11/7 = split step test 1/3 (ticking in real time)
await p.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle' }); await p.waitForSelector('#view .card');
ck('Home Sat 11/7: the split step test 1/3 button', !!(await p.$('button[data-action=go-test][data-split="1"]')), await p.$eval('#view h3', e => e.textContent).catch(() => ''));
await p.click('button[data-action=go-test][data-split="1"]'); await p.waitForSelector('#split-seg');
const line = () => p.textContent('#split-line').catch(() => '');
ck('Live: part 1 preselected — stages 1–2 (8.0 · 9.0), sampled at both', (await p.$eval('#split-seg button.active', e => e.dataset.split)) === '1' && /단계 1–2 \(8\.0 · 9\.0 km\/h\) · 채혈은 1·2단계/.test(await line()), (await line()).slice(0, 100));
await p.click('#split-seg button[data-split="2"]'); await p.waitForSelector('#split-line');
ck('part 2 — stages 1–4 (8.0 … 11.0), samples only at 3·4 (10.0 · 11.0)', /단계 1–4 \(8\.0 · 9\.0 · 10\.0 · 11\.0 km\/h\) · 채혈은 3·4단계\(10\.0 · 11\.0 km\/h\)/.test(await line()), (await line()).slice(0, 120));
await p.click('#split-seg button[data-split="0"]'); await p.waitForTimeout(150);
ck('full test: no split line', !(await p.$('#split-line')));
await p.click('#split-seg button[data-split="2"]'); await p.waitForSelector('#split-line');
// a short demo run of part 2 at ×60
await p.evaluate(() => { TL.settings.protocol.warmupSec = 60; TL.settings.protocol.stageSec = 60; TL.settings.protocol.pauseSec = 20; });
await p.click('#src-seg button[data-src=demo]'); await p.selectOption('#demo-speed', '60'); await p.waitForTimeout(100);
await p.click('[data-action=connect]'); await p.waitForSelector('[data-action=start]:not([disabled])', { timeout: 5000 });
await p.evaluate(() => { window.__skips = []; window.__said = []; const a = TL.alerts; const cu = a.cue.bind(a); a.cue = (t, o) => { if (t) window.__said.push(t); return cu(t, o); }; });
await p.click('[data-action=start]'); await p.waitForSelector('#lv-hr');
const la = { 3: '2.1', 4: '3.4' }; const prompted = []; const t0 = Date.now();
while (Date.now() - t0 < 60000) {
  if (await p.$('#lac-modal')) {
    const st = await p.evaluate(() => Number.isFinite(TL.engine.pendingLactate) ? TL.engine.pendingLactate : TL.engine.stages.length);
    prompted.push(st); const v = la[st] || '1.5';
    for (const d of v.split('')) await p.click(`#lac-modal .keypad button[data-k="${d}"]`);
    await p.click('#lac-modal [data-x=save]'); await p.waitForTimeout(100);
    if (await p.$('.rpe')) await p.click('.rpe button[data-r="7"]');
  }
  const st = await p.evaluate(() => ({ state: TL.engine.state, phase: TL.engine.phase, stopAdvised: TL.engine.stopAdvised, pending: Number.isFinite(TL.engine.pendingLactate) }));
  if (st.stopAdvised && st.phase === 'pause' && !st.pending && !(await p.$('#lac-modal'))) break;
  if (st.state !== 'running') break;
  await p.waitForTimeout(120);
}
const eng = await p.evaluate(() => ({ stages: TL.engine.stages.length, stopAdvised: TL.engine.stopAdvised, said: window.__said.slice(), meta: { splitStages: TL.engine.meta.splitStages, splitPart: TL.engine.meta.splitPart, splitLast: TL.engine.meta.splitLast } }));
ck('engine: meta carries part 2 (samples at 3·4, last 4)', eng.meta.splitPart === 2 && JSON.stringify(eng.meta.splitStages) === '[3,4]' && eng.meta.splitLast === 4, JSON.stringify(eng.meta));
ck('run: 4 stages, prompted only at stages 3 and 4, stop advised after stage 4', eng.stages === 4 && prompted.join() === '3,4' && eng.stopAdvised, `stages ${eng.stages} prompted ${prompted.join()} stopAdvised ${eng.stopAdvised}`);
ck('voice: "채혈 없음 … 다음 단계" twice (stages 1·2), never the "종료" variant', eng.said.filter(t => t === '정지. 채혈 없음. 30초 뒤 다음 단계.').length === 2 && !eng.said.some(t => /채혈 없음. 30초 뒤 종료/.test(t)), eng.said.filter(t => /채혈/.test(t)).join(' | '));
await p.click('[data-action=stop]'); await p.click('.modal [data-x=yes]');
await p.waitForSelector('#stage-table', { timeout: 10000 });
const det = await p.evaluate(() => { const s = TL.detail; return { split: s.split, lac: s.events.filter(e => e.type === 'lactate').map(e => `${e.stage}:${e.value}`), kind: s.sourceKind, id: s.id }; });
ck('saved: split {part 2, measure [3,4], last 4}, lactate 3:2.1 · 4:3.4', det.split && det.split.part === 2 && JSON.stringify(det.split.measure) === '[3,4]' && det.split.last === 4 && det.lac.join() === '3:2.1,4:3.4', JSON.stringify(det));
await p.screenshot({ path: `${S}/split-detail.png`, fullPage: true });
// the merged-curve card on the Analysis tab counts real sessions only → mark this one as a strap session
await p.evaluate(async id => { const r = indexedDB.open('treadmill-lab', 1); await new Promise(res => r.onsuccess = res); const t = r.result.transaction('sessions', 'readwrite'); const g = t.objectStore('sessions').get(id); await new Promise(res => g.onsuccess = res); const s = g.result; s.sourceKind = 'ble'; t.objectStore('sessions').put(s); await new Promise(res => t.oncomplete = res); }, det.id);
await p.reload({ waitUntil: 'networkidle' }); await p.waitForSelector('#view .card');
await p.click('#nav button[data-view=analysis]'); await p.waitForSelector('[data-action=import]');
const an = await p.textContent('#view');
ck('Analysis: the split step test card lists part 2/3 with points at 10.0 and 11.0, parts 1 and 3 missing, apply disabled', /분할 계단 테스트/.test(an) && /2\/3/.test(an) && /10\.0/.test(an) && /11\.0/.test(an) && (await p.$eval('button[data-action=apply-split]', e => e.disabled).catch(() => null)) === true, an.slice(an.indexOf('분할 계단 테스트'), an.indexOf('분할 계단 테스트') + 160));
await p.screenshot({ path: `${S}/split-analysis.png`, fullPage: true });
ck('no page errors', errs.length === 0, errs.join(' | ').slice(0, 300));
await b.close(); process.exit(f ? 1 : 0);

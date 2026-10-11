// Headless (dev server on :8765), v1.1.31: an install still on the old 3-min stage moves to 4 min once (a length chosen on purpose is
// kept, a fresh install starts at 4 min); Settings shows the new recommendation (the duplicate-strip rule is unit-tested in test_stage).
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const base = process.env.TL_BASE || 'http://127.0.0.1:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 384, height: 790 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
let fails = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) fails++; };
const load = async () => { await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#view .card'); };
await page.goto(base, { waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
check('a fresh install starts at 4-min stages', await page.evaluate(() => TL.settings.protocol.stageSec) === 240);
await page.evaluate(async () => { TL.settings.protocol.stageSec = 180; TL.settings.migr.stage1131 = null; await TL.saveSettings(); }); await load();
const m = await page.evaluate(() => ({ s: TL.settings.protocol.stageSec, done: !!TL.settings.migr.stage1131, toast: document.getElementById('toast-root').textContent }));
check('an install on the old 3-min default moves to 4 min once, with a notice', m.s === 240 && m.done && /4-min stages/.test(m.toast), JSON.stringify(m).slice(0, 200));
await page.evaluate(async () => { TL.settings.protocol.stageSec = 180; await TL.saveSettings(); }); await load();
check('  only once: set back to 3 min by hand, it stays', await page.evaluate(() => TL.settings.protocol.stageSec) === 180);
await page.evaluate(async () => { TL.settings.protocol.stageSec = 300; TL.settings.migr.stage1131 = null; await TL.saveSettings(); }); await load();
check('a length chosen on purpose (5 min) is kept', await page.evaluate(() => TL.settings.protocol.stageSec) === 300);
await page.click('#nav button[data-view=settings]'); await page.waitForSelector('[data-set="protocol.stageSec"]');
check('Settings recommends 4-min stages and two strips at the lowest stage', await page.evaluate(() => /4분 단계/.test(document.getElementById('view').textContent) && /스트립 2장/.test(document.getElementById('view').textContent)));
check('no console or page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close(); console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);

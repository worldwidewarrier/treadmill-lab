// Headless (dev server on :8765): the language "English + 한국어" (v1.1.28) — English on top, Korean under it, on every tab, in the
// setup cards, on the live screen and in a dialog; nothing else changes (fields, buttons, ids keep working); back to "한국어 + English"
// without a reload restores the Korean-first order, also in the tab bar. Demo strap.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs'; import { tmpdir } from 'node:os';
const SHOTS = process.env.TL_SHOTS || `${tmpdir()}/treadmill-lab-shots`; mkdirSync(SHOTS, { recursive: true });
const base = process.env.TL_BASE || 'http://127.0.0.1:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 384, height: 790 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
let fails = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) fails++; };
const noToast = () => page.evaluate(() => { document.getElementById('toast-root').innerHTML = ''; });
const HANGUL = /[가-힣]/;
/** Every pair on screen: is English in front? Pairs left Korean-first (an .en whose own text is English with Korean right before it) are counted as missed. */
const audit = () => page.evaluate(() => { const H = /[가-힣]/; const out = { swapped: 0, wrong: [], missed: [] };
  document.querySelectorAll('.ko[data-sw]').forEach(e => { const k = e.nextSibling; out.swapped++; if (!(k && k.nodeType === 1 && k.classList.contains('en') && H.test(k.textContent) && !H.test(e.textContent.replace(/[「」]/g, '')))) { if (H.test(e.textContent) && !(k && H.test(k.textContent))) out.wrong.push(e.textContent.slice(0, 40)); } });
  document.querySelectorAll('.en:not([data-sw])').forEach(e => { if (!e.checkVisibility()) return; const p = e.previousSibling; const t = p ? p.textContent : ''; if (H.test(t) && !H.test(e.textContent)) out.missed.push(`${t.slice(-25)} | ${e.textContent.slice(0, 25)}`); });
  return out; });
await page.goto(base, { waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
// switch in Settings, as the owner would
await page.click('#nav button[data-view=settings]'); await page.waitForSelector('[data-set="profile.lang"]');
check('Settings offers "English + 한국어"', await page.$eval('[data-set="profile.lang"]', s => [...s.options].some(o => o.value === 'enfirst' && o.text === 'English + 한국어')));
await page.selectOption('[data-set="profile.lang"]', 'enfirst'); await page.waitForTimeout(400);
check('the setting is saved and marked on the page', await page.evaluate(() => TL.settings.profile.lang === 'enfirst' && document.documentElement.classList.contains('lang-enfirst')));
const nav = await page.evaluate(() => [...document.querySelectorAll('#nav button')].map(b => [...b.querySelectorAll('span')].filter(s => s.checkVisibility()).map(s => s.textContent).join('|')));
check('the tab bar reads in English', nav.join(',') === '⌂|Home,▶|Session,⌁|Analysis,▦|Plan,⚙|Settings', nav.join(','));
for (const [view, sel] of [['home', '#view .card'], ['plan', '.plan-day'], ['analysis', '#view'], ['settings', '[data-set="profile.lang"]']]) {
  await page.click(`#nav button[data-view=${view}]`); await page.waitForSelector(sel); await page.waitForTimeout(250); await noToast();
  const a = await audit();
  check(`${view}: pairs swapped, English in front, none left Korean-first`, a.swapped > 3 && a.wrong.length === 0 && a.missed.length === 0, `swapped ${a.swapped} wrong ${JSON.stringify(a.wrong.slice(0, 3))} missed ${JSON.stringify(a.missed.slice(0, 4))}`);
  await page.screenshot({ path: `${SHOTS}/90-enfirst-${view}.png`, fullPage: true });
}
await page.click('#nav button[data-view=home]'); await page.waitForSelector('details.desc[data-key="home-today"]');
const head = await page.$eval('details.desc[data-key="home-today"] h3', h => [...h.children].map(c => `${c.className}:${c.textContent}`));
check('Home: the title is English first ("Easy run 50 min"), Korean under it', /^ko:[A-Za-z]/.test(head[0]) && /^en:.*[가-힣]/.test(head[1]), JSON.stringify(head));
check('Home: the description still folds behind the title', !(await page.$eval('details.desc[data-key="home-today"]', d => d.open)));
// every setup card, then a live session from Home
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg');
for (const m of ['test', 'verify', 'lt1', 'lt2', 'free']) { await page.click(`#mode-seg button[data-mode=${m}]`); await page.waitForSelector(`#mode-seg button.active[data-mode=${m}]`); await page.waitForTimeout(150); const a = await audit(); check(`setup ${m}: English first, none missed`, a.wrong.length === 0 && a.missed.length === 0, JSON.stringify(a.missed.slice(0, 3))); }
await page.click('#nav button[data-view=home]'); await page.waitForSelector('[data-action=go-live]'); await page.click('#view .card [data-action=go-live]'); await page.waitForSelector('#sess-speed');
check('Start from Home still carries the plan\'s speed into the field', (await page.inputValue('#sess-speed')) !== '');
await page.click('#src-seg button[data-src=demo]'); await page.selectOption('#demo-speed', '30'); await page.click('[data-action=connect]'); await page.waitForSelector('[data-action=start]:not([disabled])'); await page.click('[data-action=start]'); await page.waitForSelector('#lv-zone');
await page.waitForFunction(() => TL.engine.view().phaseElapsed >= 20, null, { timeout: 30000 }); await page.waitForTimeout(1200); await noToast();
const live = await page.evaluate(() => ({ banner: document.getElementById('lv-zone-text').textContent, speed: document.getElementById('lv-speed')?.textContent }));
check('live: the banner speaks English ("Warm-up" 7.0, "from 5:00: main speed …")', /^Warm-up/.test(live.banner) && live.speed === '7.0' && /from 5:00/.test(live.banner), JSON.stringify(live));
const la = await audit(); check('live screen: none left Korean-first', la.missed.length === 0, JSON.stringify(la.missed.slice(0, 3)));
await page.screenshot({ path: `${SHOTS}/91-enfirst-live.png` });
await page.click('[data-action=stop]'); await page.waitForSelector('.modal [data-x=yes]'); await page.waitForTimeout(200);
const md = await audit(); check('a dialog (Finish?): English first', md.missed.length === 0, JSON.stringify(md.missed.slice(0, 3)));
await page.click('.modal [data-x=yes]'); await page.waitForSelector('#tl-chart .uplot', { timeout: 10000 }); await page.waitForTimeout(300);
const sa = await audit(); check('the saved session\'s screen: English first, none missed', sa.missed.length === 0 && sa.wrong.length === 0, JSON.stringify(sa.missed.slice(0, 3)));
// back to Korean first, no reload
await page.click('#nav button[data-view=settings]'); await page.waitForSelector('[data-set="profile.lang"]'); await page.selectOption('[data-set="profile.lang"]', 'both'); await page.waitForTimeout(400);
const back = await page.evaluate(() => ({ cls: document.documentElement.classList.contains('lang-enfirst'), nav: [...document.querySelectorAll('#nav button')].map(b => [...b.querySelectorAll('span')].filter(s => s.checkVisibility()).map(s => s.textContent).join('|')).join(','), sw: document.querySelectorAll('[data-sw]').length }));
check('back to "한국어 + English": the tab bar is Korean again, nothing left swapped', !back.cls && back.nav === '⌂|홈,▶|세션,⌁|분석,▦|계획,⚙|설정' && back.sw === 0, JSON.stringify(back));
await page.click('#nav button[data-view=home]'); await page.waitForSelector('details.desc[data-key="home-today"]');
const head2 = await page.$eval('details.desc[data-key="home-today"] h3', h => h.textContent);
check('…and Home is Korean first again', /^[^A-Za-z]*[가-힣]/.test(head2), head2);
check('no console or page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close(); console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);

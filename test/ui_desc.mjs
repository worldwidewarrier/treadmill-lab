// Headless (dev server on :8765): each session's description sits behind its title (v1.1.27, owner: "앱 화면이 난잡함. 각 세션별 설명은
// 제목을 터치하면 볼 수 있도록"). Home's today card, every day of the Plan tab and the setup card of every mode show the title, the numbers
// and the warm-up line; the description opens when the title is tapped, closes on a second tap, and stays open across a repaint.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs'; import { tmpdir } from 'node:os';
const SHOTS = process.env.TL_SHOTS || `${tmpdir()}/treadmill-lab-shots`; mkdirSync(SHOTS, { recursive: true });
const base = process.env.TL_BASE || 'http://127.0.0.1:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 384, height: 790 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
let fails = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) fails++; };
const noToast = () => page.evaluate(() => { document.getElementById('toast-root').innerHTML = ''; });
const visible = sel => page.evaluate(sel => { const el = document.querySelector(sel); return el ? el.checkVisibility() : null; }, sel); // (content of a closed <details> keeps a box in Chromium but is not rendered: checkVisibility says so)
await page.goto(base, { waitUntil: 'networkidle' }); await page.waitForSelector('#view .card'); await noToast();

// ---- Home
const H = '#view details.desc[data-key="home-today"]';
let st = await page.evaluate(H => { const d = document.querySelector(H); const s = d?.querySelector('summary'); return d && { open: d.open, head: s.textContent, wu: !!s.querySelector('#home-warmup'), mono: !!s.querySelector('.mono'), body: d.querySelector('.desc-body').textContent }; }, H);
check('Home: today\'s description is closed; the title, the numbers and the warm-up line are in the part that shows', st && st.open === false && st.wu && st.mono && /km\/h/.test(st.head) && st.body.length > 40, JSON.stringify(st && { open: st.open, head: st.head.slice(0, 80) }));
check('…the description (the long note, noon · evening) is not on screen', await visible(`${H} .desc-body p`) === false);
await page.screenshot({ path: `${SHOTS}/80-desc-home-closed.png` });
await page.click(`${H} > summary h3`); await page.waitForTimeout(150);
check('a tap on the title opens it', await page.$eval(H, d => d.open) && await visible(`${H} .desc-body p`) === true);
await page.screenshot({ path: `${SHOTS}/81-desc-home-open.png` });
await page.click('#nav button[data-view=plan]'); await page.waitForSelector('.plan-day'); await page.click('#nav button[data-view=home]'); await page.waitForSelector(H);
check('…and it stays open when Home is drawn again', await page.$eval(H, d => d.open));
await page.click(`${H} > summary h3`); await page.waitForTimeout(150);
check('a second tap closes it', !(await page.$eval(H, d => d.open)));
const startOk = await page.$('#view [data-action=go-live]') || await page.$('#view [data-action=go-test]');
check('the Start button is outside the description (always there)', !!startOk && !(await page.evaluate(() => !!document.querySelector('details.desc [data-action=go-live], details.desc [data-action=go-test]'))));

// ---- Plan
await page.click('#nav button[data-view=plan]'); await page.waitForSelector('.plan-day'); await noToast();
const rows = await page.evaluate(() => [...document.querySelectorAll('.plan-day')].map(r => { const d = r.querySelector('details.desc'); return { has: !!d, open: d?.open ?? null, wuIn: !!d?.querySelector('summary .wu-line'), monoIn: !!d?.querySelector('summary .mono'), body: d?.querySelector('.desc-body')?.textContent.length ?? 0, h: r.getBoundingClientRect().height }; }));
check('Plan: every day with a note has it behind its title, closed; the numbers and the warm-up line show', rows.filter(r => r.has).length >= 6 && rows.every(r => !r.has || (r.open === false && r.monoIn)) && rows.filter(r => r.wuIn).length >= 6, JSON.stringify(rows.map(r => [r.has, r.open, r.wuIn, r.body])));
check('…each closed day row is short (≤ 160 px: title, numbers, warm-up line)', rows.every(r => r.h <= 160), JSON.stringify(rows.map(r => Math.round(r.h))));
await page.screenshot({ path: `${SHOTS}/82-desc-plan-closed.png`, fullPage: true });
const first = '.plan-day details.desc'; await page.click(`${first} > summary b`); await page.waitForTimeout(150);
check('Plan: a tap on a day\'s title opens that day only', await page.evaluate(() => [...document.querySelectorAll('.plan-day details.desc')].map(d => d.open).filter(Boolean).length === 1 && document.querySelector('.plan-day details.desc').open));
await page.screenshot({ path: `${SHOTS}/83-desc-plan-open.png`, fullPage: true });

// ---- setup cards
await page.click('#nav button[data-view=live]'); await page.waitForSelector('#mode-seg');
for (const [m, extra] of [['test', null], ['verify', '#sess-speed'], ['lt1', '#sess-speed'], ['lt2', '#lt2-reps'], ['free', '#free-cues']]) {
  await page.click(`#mode-seg button[data-mode=${m}]`); await page.waitForSelector(`#mode-seg button.active[data-mode=${m}]`); await page.waitForSelector(`details.desc[data-key="setup-${m}"]`);
  const c = await page.evaluate(m => { const d = document.querySelector(`details.desc[data-key="setup-${m}"]`); return { open: d.open, h3: !!d.querySelector('summary h3'), body: d.querySelector('.desc-body').textContent.length }; }, m);
  const fieldOk = extra ? await visible(extra) : true;
  check(`setup card ${m}: the description is closed under the title; the fields show`, c.open === false && c.h3 && c.body > 20 && fieldOk && await visible(`details.desc[data-key="setup-${m}"] .desc-body p`) === false, JSON.stringify(c));
  if (m === 'lt1' || m === 'lt2') check(`  ${m}: the target line and the warm-up line show`, await visible('details.desc summary p.inline') && await visible('#wu-line'));
  if (m === 'verify') { await noToast(); await page.screenshot({ path: `${SHOTS}/84-desc-verify-closed.png` }); await page.click('details.desc[data-key="setup-verify"] > summary h3'); await page.waitForTimeout(150); check('  verify: a tap shows the band-finder line, the line and the checklist', await visible('details.desc[data-key="setup-verify"] .desc-body details summary')); await page.screenshot({ path: `${SHOTS}/85-desc-verify-open.png` }); await page.click('details.desc[data-key="setup-verify"] > summary h3'); }
}
check('no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
check('no console or page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close(); console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);

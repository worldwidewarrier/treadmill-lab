// Headless (dev server on :8765): v1.1.37 (owner: "가장 심플하게, 설명을 다 제외") — no descriptions anywhere: Home, Plan and the setup cards
// show the title, the numbers and the Start button only; Home has 「오늘 체크」 (run = session or free run, other exercise per day).
// (Replaces the v1.1.27 test of descriptions behind their titles.)
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const base = process.env.TL_BASE || 'http://127.0.0.1:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 384, height: 790 }, isMobile: true, hasTouch: true, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
let fails = 0; const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) fails++; };
await page.goto(base, { waitUntil: 'networkidle' }); await page.waitForSelector('#view .card');
check('Home: no description blocks', await page.$$eval('#view details', d => d.length) === 0);
check('Home: a Start button (disabled on a rest day)', !!(await page.$('#view [data-action=go-live]') || await page.$('#view [data-action=go-test]') || await page.$('#view .card button[disabled]')));
check('Home: 「오늘 체크」 with at least one row', await page.$$eval('.chk-row', r => r.length) >= 1);
await page.click('#nav button[data-view=plan]'); await page.waitForSelector('.plan-day');
check('Plan: no description blocks', await page.$$eval('#view details', d => d.length) === 0);
check('Plan: seven days', await page.$$eval('.plan-day', d => d.length) === 7);
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close(); process.exit(fails ? 1 : 0);

import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { tmpdir } from 'node:os'; const S=tmpdir();
const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:384,height:790},deviceScaleFactor:2,isMobile:true,hasTouch:true,colorScheme:'dark',locale:'ko-KR',timezoneId:'Asia/Seoul'});
const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
let f=0; const ck=(n,c,d='')=>{console.log((c?'PASS ':'FAIL ')+n+' '+d); if(!c)f++;};
const go=async iso=>{ await p.clock.setFixedTime(new Date(iso)); await p.goto('http://127.0.0.1:8765/',{waitUntil:'networkidle'}); await p.waitForSelector('.chk-row'); };
await p.clock.install({time:new Date('2026-10-27T07:00:00+09:00')});
await go('2026-10-27T07:00:00+09:00'); // Tue
let ids=await p.$$eval('.chk-tap',r=>r.map(x=>x.dataset.id)); ck('Tue rows', ids.includes('squat')&&ids.includes('r_main'), ids.join(','));
await p.fill('.ex-val[data-id=squat]','60'); await p.dispatchEvent('.ex-val[data-id=squat]','change'); await p.waitForTimeout(300);
await p.fill('.ex-val[data-id=chin]','5'); await p.dispatchEvent('.ex-val[data-id=chin]','change'); await p.waitForTimeout(300);
await p.fill('.ex-val[data-id=bench]','40'); await p.dispatchEvent('.ex-val[data-id=bench]','change'); await p.waitForTimeout(300);
await p.click('.chk-tap[data-id=bench]'); await p.waitForTimeout(300); // untick: not all reps
ck('squat ticked by value', await p.$eval('.chk-tap[data-id=squat]',e=>e.parentElement.classList.contains('on')));
await p.fill('.ex-val[data-id=r_rpe]','6'); await p.dispatchEvent('.ex-val[data-id=r_rpe]','change'); await p.waitForTimeout(300);
await p.screenshot({path:S+'/tue.png',fullPage:true});
await go('2026-11-03T07:00:00+09:00'); // next Tue
const ph=id=>p.$eval(`.ex-val[data-id=${id}]`,e=>e.placeholder);
ck('squat next 65', await ph('squat')==='65'); ck('chin next 6', await ph('chin')==='6'); ck('bench same 40 (not done)', await ph('bench')==='40');
await go('2026-11-02T07:00:00+09:00'); // Mon — easy? flag uses last RPE 6
ck('RPE flag shown on easy day', !!(await p.$('.notice.warn')));
await go('2026-10-31T09:00:00+09:00'); ids=await p.$$eval('.chk-tap',r=>r.map(x=>x.dataset.id)); ck('Sat stairs row', ids.includes('stairs')); ck('stairs start 10', await ph('stairs')==='10');
await p.click('.chk-tap[data-id=stairs]'); await p.waitForTimeout(300);
await go('2026-11-07T09:00:00+09:00'); ck('stairs next 15', await ph('stairs')==='15');
await p.screenshot({path:S+'/sat.png',fullPage:true});
ck('no page errors', errs.length===0, errs.join('|').slice(0,300)); await b.close(); process.exit(f?1:0);

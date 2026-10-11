// node test/test_stage.mjs — v1.1.31: 4-min stages by default, two strips at a stage (duplicate → mean, LT1 = lowest + 0.3)
import { DEFAULT_PROTOCOL, SessionEngine } from '../js/session.js';
import { stageLactate } from '../js/analysis.js';
import { analyzeLactate } from '../js/lactate.js';
let failures = 0;
const check = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  ' + d : '')); if (!c) failures++; };

check('default stage is 4 min (Jamnick 2018: ModDmax from 4-min stages matched MLSS)', DEFAULT_PROTOCOL.stageSec === 240);

const a = stageLactate({ lactate: 0.9, lactate2: 1.1 });
check('two strips 0.9 and 1.1: mean 1.0, marked duplicate', a.lactate === 1.0 && a.lactateDup && a.lactateN === 2, JSON.stringify(a));
const b = stageLactate({ lactate: 0.9, lactate2: 0.9 });
check('two equal strips: duplicate', b.lactate === 0.9 && b.lactateDup);
const c = stageLactate({ lactate: 0.9, lactate2: 2.0 });
check('two strips 1.1 apart: not averaged, the first is kept (as before)', c.lactate === 0.9 && !c.lactateDup);
const d = stageLactate({ lactate: 1.2 });
check('one strip: as before', d.lactate === 1.2 && !d.lactateDup && d.lactateN === 1);
check('no strip: nothing', !Number.isFinite(stageLactate({}).lactate));

// the engine keeps a second strip even when it equals the first
const e = Object.create(SessionEngine.prototype);
Object.assign(e, { stages: [{ idx: 1, lactate: null }], pendingLactate: 1, events: [], rep: 0, phase: 'pause', protocol: { stopLactate: 8 }, mode: 'test', now: () => 0, sampleTags: () => ({}), onUpdate: () => {}, view: () => ({}) });
e.enterLactate(0.8, 1); e.enterLactate(0.8, 1);
check('engine: an equal second strip is stored as lactate2', e.stages[0].lactate === 0.8 && e.stages[0].lactate2 === 0.8, JSON.stringify(e.stages[0]));

const pts = [[7, 0.9], [8, 0.9], [9, 1.3], [10, 2.2], [11, 3.6], [12, 6.0]].map(([x, la]) => ({ x, la, hr: 120 + (x - 7) * 10 }));
const one = analyzeLactate(pts), two = analyzeLactate(pts.map((p, i) => i === 1 ? { ...p, dup: true } : p));
check('single strips: LT1 method baseline+0.5', one.lt1Primary.method === 'baseline+0.5' && Math.abs(one.lt1Primary.la - 1.4) < 1e-9);
check('lowest stage measured twice: baseline+0.3, a slower LT1', two.lt1Primary.method === 'baseline+0.3' && Math.abs(two.lt1Primary.la - 1.2) < 1e-9 && two.lt1Primary.x < one.lt1Primary.x && /twice/.test(two.lt1Primary.note), `${one.lt1Primary.x.toFixed(2)} → ${two.lt1Primary.x.toFixed(2)}`);
const other = analyzeLactate(pts.map((p, i) => i === 3 ? { ...p, dup: true } : p));
check('a duplicate at another stage: still +0.5', other.lt1Primary.method === 'baseline+0.5');
check('LT2 unchanged by the duplicate mark', Math.abs(two.lt2Primary.x - one.lt2Primary.x) < 1e-9);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS'); process.exit(failures ? 1 : 0);

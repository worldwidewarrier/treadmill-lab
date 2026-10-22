// Treadmill Lab — app shell, views and wiring.
import { t, tx, setLang, getLang, S, VOICE } from './i18n.js';
import { store, uid } from './store.js';
import { Alerts } from './alerts.js';
import { HeartRateSource } from './ble.js';
import { ReplaySource, DemoSource, NoStrapSource, demoProfileForEngine } from './sources.js';
import { SessionEngine, DEFAULT_PROTOCOL, DEFAULT_INTERVALS, DEFAULT_LAPS, LT1_WARMUP_SEC, buildStages, computeFeaturesOffline, warmupSteps, cooldownSteps, stepAt } from './session.js';
import { analyzeSession, summarizeStages, smo2Steady, estimateOffsetMs, runTimeline, list, setAlphaUse, ALPHA_ARTIFACT_MAX } from './analysis.js';
import { asLactateOnly, checkDueInWeek, computeZones, sessionTargets, sessionSpeeds, midSpeed, weeklyPlan, lt2Structure, sessionMetrics, assessRecent, sessionSummaryText, claudeSummary, lactateChecks, typedChecks, midLabel, setRestBaseline, setTestLowest, testLowest, lactateFloor, lactateVerdict, verdictZoneChange, multiDayCurve, endWindowStats, lapStats, bandFinder, longestRecentMin, GAP_STRICT_SEC, CURVE_LT2_MIN_LA, planContext, PLAN_WHY, vo2Speed, vo2Band, mlssPasses, longestHardWorkMin, setMlssLactate, ladderLactateWindow, PLACES, SURFACES, onBelt } from './prescribe.js';
import { importFile } from './importers.js';
import { liveChart, timelineChart, stepTestChart, trendChart } from './charts.js';

// ---------- defaults ----------
export const APP_VERSION = '1.1.39'; // keep in sync with sw.js VERSION
const DEFAULTS = {
  profile: { birth: '1997-07-21', restHr: 52, restLactate: 0.8, restLactateAt: '2026-10-09', maxHr: 188, maxHrMode: 'tanaka', lang: 'both', theme: 'system' }, // restLactateAt: when the baseline was measured (a monthly reminder to re-measure)
  treadmill: { model: 'LTSXL', minSpeed: 0.8, maxSpeed: 18, speedStep: 0.1, maxIncline: 15, inclineStep: 0.5 },
  protocol: { ...DEFAULT_PROTOCOL },
  alpha1: { guidance: 'off', windowSec: 120, stepSec: 5, artifactMode: 'auto', lambda: 500, scales: 'fatmaxxer' }, // guidance off (v1.1.14): α1 0.46 on a lactate-confirmed below-LT1 run — recorded, not shown or used
  alerts: { voice: true, vibrate: true, beep: true, zoneExitSec: 30, volume: 1 },
  plan: { weekdayMin: 60, weekendMin: 150, goal: 'base', startDate: null, weekOffset: 0, calendar: '' }, // calendar (v1.1.18): one line per week, `YYYY-MM-DD kind note` — see prescribe.parseCalendar
  // testLt1Speed (v1.1.17): the step-test LT1 speed — the weekly test speed rises to it + 0.3 at most. The thresholds of the Oct 10 review (LT1 143 @ 8.7, LT2 157 @ 10.5) are set once by runMigrations, not here: "Delete all data" leaves the zones empty.
  zones: { lt1Hr: null, lt2Hr: null, lt1Speed: null, lt2Speed: null, testLt1Speed: null, pace3k: null, mlssLactate: null, source: '', grade: '', updatedAt: null, testSessionId: null }, // pace3k / mlssLactate (v1.1.35): the 3-km pace (strides, the 4×4 speed) and the lactate at MLSS (the ladder's target ± 0.5)
  laps: { ...DEFAULT_LAPS },
  migr: { z1117: null, oct5: null, z1118: null, z1135: null }, // one-time data fixes already applied (timestamps)
};
const deepMerge = (a, b) => { const o = { ...a }; for (const k in b) o[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) ? deepMerge(a[k] || {}, b[k]) : b[k]; return o; };
/** A <select> stores text: give every setting whose default is a number its number type back ('10' + 10 would concatenate). */
/** A private copy of the defaults. Merging into DEFAULTS itself shared its sub-objects with the live settings on a first run, so editing a setting rewrote the defaults and "Delete all data" then restored the edited values. */
const freshDefaults = () => JSON.parse(JSON.stringify(DEFAULTS));
/** α1 shown and used (tile, charts, tables, voice cue, verdicts, auto-adjust)? Recording goes on either way. */
const A1 = () => A.settings?.alpha1?.guidance !== 'off';
const numericSetting = (g, k, val) => (typeof DEFAULTS[g]?.[k] === 'number' && typeof val === 'string' && val.trim() !== '' && Number.isFinite(Number(val))) ? Number(val) : val;
const coerceSettings = st => { for (const g in DEFAULTS) for (const k in DEFAULTS[g]) if (st[g] && k in st[g]) st[g][k] = numericSetting(g, k, st[g][k]); return st; };

const A = { settings: null, view: 'home', sessions: [], imports: [], engine: null, source: null, alerts: null, live: { chart: null, mode: 'test', sourceKind: 'ble', demoSpeed: 10, replay: null, replaySpeed: 10, minutes: 50, purpose: 'lt1' }, detail: null, charts: [] };

// ---------- utilities ----------
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtClock = sec => { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; };
const fmtDate = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/**
 * A time as typed into the run-end field → seconds. "35:05" → 2105 · "1:02:03" → 3723 · the separator may also be . , - or a space
 * (a phone's number pad has no colon) · digits alone are read like the display without its colons: "3505" → 35:05, "10203" → 1:02:03,
 * one or two digits are minutes ("35" → 35:00) · "35.5" is 35:05 (dot = colon) · seconds of 60 and more, and minutes of 60 and more in
 * the h:m:s form → NaN ("75:00" is 75 minutes) · anything else → NaN
 */
const parseClock = txt => {
  const str = String(txt).trim(); let p;
  if (/^\d+$/.test(str)) p = str.length <= 2 ? [str, '0'] : str.length <= 4 ? [str.slice(0, -2), str.slice(-2)] : str.length <= 6 ? [str.slice(0, -4), str.slice(-4, -2), str.slice(-2)] : null;
  else p = str.split(/\s*[:.,\-\s]\s*/);
  if (!p || p.length < 2 || p.length > 3 || p.some(x => !/^\d+$/.test(x))) return NaN;
  const v = p.map(Number); if (v[v.length - 1] >= 60 || (v.length === 3 && v[1] >= 60)) return NaN;
  return v.length === 2 ? v[0] * 60 + v[1] : v[0] * 3600 + v[1] * 60 + v[2];
};
/** How the end of the run was found (analysis.js runTimeline) — card wording [ko, en]. */
const RUN_HOW = {
  sample: ['채혈 값을 입력하기 전, 심박이 떨어지기 시작한 시점', 'where the heart rate began to fall before the lactate entry'],
  pause: ['일시정지 시점(또는 그 직전 심박이 떨어지기 시작한 시점)', 'at Pause (or where the heart rate began to fall just before it)'],
  manual: ['직접 입력한 시각', 'set by hand'],
  phase: ['반복 시계(랩 시계)가 끝난 시점', 'where the rep / lap clock ended'],
  finish: ['기록의 끝(종료 버튼)', 'the end of the recording (Finish)'],
  hr: ['심박만으로 추정한 시점', 'estimated from the heart rate alone'],
};
const n1 = v => Number.isFinite(v) ? (Math.round(v * 10) / 10).toFixed(1) : '–';
const n0 = v => Number.isFinite(v) ? String(Math.round(v)) : '–';
const n2 = v => Number.isFinite(v) ? v.toFixed(2) : '–';
const DOW = { ko: ['일', '월', '화', '수', '목', '금', '토'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] };
const typeLabel = ty => ({ test: t('mode_test'), lt1: t('mode_lt1'), lt2: t('mode_lt2'), free: t('mode_free'), verify: t('mode_verify') }[ty] || esc(ty));
function toast(msg, ms = 2600) { const r = $('#toast-root'); r.innerHTML = `<div class="toast">${msg}</div>`; clearTimeout(toast._t); toast._t = setTimeout(() => { r.innerHTML = ''; }, ms); }
function modal(html, onMount) { const root = $('#modal-root'); root.innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`; const close = () => { root.innerHTML = ''; }; root.querySelector('.modal-bg').addEventListener('click', e => { if (e.target.classList.contains('modal-bg')) close(); }); if (onMount) onMount(root.querySelector('.modal'), close); return close; }
function confirmBox(msgHtml, onYes) { modal(`<p>${msgHtml}</p><div class="grid2"><button class="ghost" data-x="no">${t('no')}</button><button class="danger" data-x="yes">${t('yes')}</button></div>`, (m, close) => { m.querySelector('[data-x=no]').onclick = close; m.querySelector('[data-x=yes]').onclick = () => { close(); onYes(); }; }); }
function download(name, text, type = 'text/plain') { const blob = new Blob([text], { type }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000); }
async function copyText(text) { try { await navigator.clipboard.writeText(text); toast(tx('saved') + ' → 📋'); } catch (e) { modal(`<textarea readonly style="min-height:50vh">${esc(text)}</textarea><p class="small muted">자동 복사가 막혔습니다. 길게 눌러 복사하세요. / Clipboard blocked — long-press to copy.</p>`); } }
function ageFrom(birth) { const b = new Date(birth); if (isNaN(b)) return null; const now = new Date(); let a = now.getFullYear() - b.getFullYear(); if (now < new Date(now.getFullYear(), b.getMonth(), b.getDate())) a--; return a; }
function effectiveMaxHr() { const p = A.settings.profile; if (p.maxHrMode === 'tanaka') { const age = ageFrom(p.birth); return age != null ? Math.round(208 - 0.7 * age) : p.maxHr; } return p.maxHr; }
function zonesObj() { const z = A.settings.zones; if (!Number.isFinite(z.lt1Hr) || !Number.isFinite(z.lt2Hr)) return null; return { ...computeZones({ ...z, maxHr: effectiveMaxHr() }), grade: z.grade, updatedAt: z.updatedAt, source: z.source }; }
/** Where this week stands (v1.1.18): block week (the long run), ladder week (the LT2 ladder) and the calendar's kinds for the week shown (‹ › move weekOffset). */
/** The speeds of the session cards — prescribe.sessionSpeeds, one speed each since v1.1.26 — and the heart rates beside them: z1 = the Z1 ceiling (LT1 − 15 bpm; a warm-up stays under it), bandTop = the top of the easy band (LT1 − 3). */
function warmupNums(z) { const sp = sessionSpeeds(z); return sp ? { ...sp, z1: Math.round(z.lt1Hr - 15), bandTop: Math.round(z.lt1Hr - 3) } : null; }
/** meta.warmup: the speeds the engine speaks (v1.1.25). */
function warmupMeta(z) { return sessionSpeeds(z); }
// ---- the speed to set, on the screen (v1.1.26): one step plan per phase (session.warmupSteps / cooldownSteps — the numbers and moments of the spoken cues), shown as a line before the run and as the large banner during it ----
/** An ad-hoc string in the first display language (what tx does for the strings of S). */
const lx = (ko, en) => (getLang() === 'en' || getLang() === 'enfirst' ? en : ko);
/** A step plan as text — "걷기 5.5 → 7.0(0:30) km/h": each later step with the moment it starts. '' without steps. */
function warmupText(plan) { return plan && plan.steps.length ? plan.steps.map((s, i) => `${s.walk ? lx('걷기 ', 'walk ') : ''}${s.speed}${i ? `(${fmtClock(s.fromSec)})` : ''}`).join(' → ') + ' km/h' : ''; }
/** The warm-up line of the Home card, the Plan tab and the setup cards as [head, speeds] — ["워밍업 5분", "7.0 km/h"]; null when there is no warm-up or its speeds are not known. */
function warmupParts(plan) { const txt = warmupText(plan); if (!txt || !(plan.totalSec > 0)) return null; const m = plan.totalSec / 60; return [`${tx('warmup')} ${Number.isInteger(m) ? m : m.toFixed(1)}${lx('분', ' min')}`, txt]; }
const warmupLine = plan => (warmupParts(plan) || []).join(' · ');
/** The warm-up of a plan day as its session runs it. */
function dayWarmup(d, z) {
  if (!d || d.type === 'rest' || (d.surface && d.surface !== 'treadmill')) return ''; // (v1.1.36: no belt speeds at the unit — heart rate or lap pace there)
  const mode = d.type === 'test' ? 'test' : d.type === 'verify' ? 'verify' : d.type === 'lt2' || d.type === 'tempo' ? 'lt2' : 'lt1';
  return warmupLine(warmupSteps({ mode, W: warmupMeta(z), purpose: d.purpose, warmupSec: mode === 'lt2' ? (d.structure?.warmupSec ?? DEFAULT_INTERVALS.warmupSec) : (A.settings.laps?.warmupSec ?? DEFAULT_LAPS.warmupSec), protocol: A.settings.protocol }));
}
/** v1.1.36 — where a plan day is run (PLACES) as one line. */
const PLACE_SHORT = { unit: ['부대 트랙·무동력', 'unit track / NMT'], track: ['부대 트랙', 'unit track'], hill: ['부대 언덕', 'unit hill'], gym: ['헬스장', 'gym'] };
const PLACE_DOW = { unit: ['부대', 'unit'], track: ['트랙', 'track'], hill: ['언덕', 'hill'], gym: ['헬스장', 'gym'] }; // (the Plan tab: under the weekday, so a row stays as short as before)
const placeTag = d => { const P = d && d.place ? PLACE_SHORT[d.place] : null; return P ? `<span class="place-tag">${esc(lx(P[0], P[1]))}</span>` : ''; }; // (one short tag at the front of the numbers line: rows stay short)
const SURFACE_LBL = { treadmill: ['동력식 트레드밀', 'motorized treadmill'], outdoor: ['트랙·야외', 'track / outdoor'], nmt: ['무동력 트레드밀', 'non-motorized treadmill'] };
/** The place of the session being set up (v1.1.36): only a motorized belt gives a speed the verdicts and the curve can use. */
function surfaceSel() { const v = A.live.surface || 'treadmill'; return `<label class="field" style="margin-top:8px">장소 / where<select id="sess-surface">${SURFACES.map(k => `<option value="${k}" ${v === k ? 'selected' : ''}>${SURFACE_LBL[k][0]} / ${SURFACE_LBL[k][1]}</option>`).join('')}</select></label>${v !== 'treadmill' ? `<p class="small muted" style="margin:4px 0 0">심박으로 달리기: 속도 음성·배너 없음, 속도 칸은 참고용(트랙 랩 페이스) — 곡선·젖산 판정·존 변경에서 빠집니다. <span class="en">Run by heart rate: no speed cues or banner, the speed field is for reference (track lap pace) — kept out of the curve, the lactate verdicts and zone changes.</span></p>` : ''}`; }
/** The warm-up of the session being set up on the Session tab (with the minutes typed in its card), as the card's line. */
function setupWarmupHtml(z) { const L = A.live; const p = warmupParts(warmupSteps({ mode: L.mode, W: warmupMeta(z), purpose: L.purpose, warmupSec: L.mode === 'lt2' ? L.lt2?.warmupSec : L.mode === 'verify' ? L.laps?.warmupSec : 0, protocol: A.settings.protocol })); return p ? `${esc(p[0])}: <b class="mono">${esc(p[1])}</b>` : ''; }
/** Open descriptions (v1.1.27), remembered across repaints by key: Home's and the Plan tab's re-renders do not fold them again. */
const OPEN = new Set();
document.addEventListener('toggle', e => { const d = e.target; if (d && d.matches && d.matches('details.desc[data-key]')) { if (d.open) OPEN.add(d.dataset.key); else OPEN.delete(d.dataset.key); } }, true);
/**
 * A session's description behind its title (v1.1.27, owner: "각 세션별 설명은 제목을 터치하면 볼 수 있도록"): head = what is always shown
 * (title, the numbers, the warm-up line), body = the description, shown when the title is tapped. No body → the head alone.
 */
function descBlock(key, head, body) {
  return head; // v1.1.37 (owner: "가장 심플하게, 설명을 다 제외"): only the title and the numbers; the descriptions are gone from every card
  if (!body) return head;
  return `<details class="desc" data-key="${esc(key)}"${OPEN.has(key) ? ' open' : ''}><summary><div class="grow">${head}</div><span class="chev" aria-hidden="true">▾</span></summary><div class="desc-body">${body}</div></details>`;
}
/**
 * Under the thresholds of the multi-day curve (v1.1.26): what its points cannot carry (multiDayCurve().trust) and where a zone change
 * comes from instead — LT1 read between the two points on either side of the line when the fit crossed it elsewhere, LT1 not
 * reached, LT2 withheld because the points stop below CURVE_LT2_MIN_LA. '' when the curve can be applied as it stands.
 */
function curveNoteHtml(md) {
  const T = md && md.trust; if (!T) return ''; const ko = [], en = [];
  if (T.lt1.why === 'not-reached') { ko.push(`모든 점이 기준선(최저 + 0.5 = ${n1(T.lt1.line)}) 아래 — LT1은 가장 빠른 점 ${n1(T.lt1.lo)} km/h보다 위에 있습니다.`); en.push(`Every point is under the line (lowest + 0.5 = ${n1(T.lt1.line)}): LT1 lies above the fastest one, ${n1(T.lt1.lo)} km/h.`); }
  else if (T.lt1.fixed) { ko.push(`LT1은 기준선 양쪽의 두 점(${n1(T.lt1.lo)} · ${n1(T.lt1.hi)} km/h) 사이에서 읽었습니다 — 곡선 맞춤은 점이 없는 곳에서 기준선을 넘었습니다.`); en.push(`LT1 is read between the two points on either side of the line (${n1(T.lt1.lo)} and ${n1(T.lt1.hi)} km/h) — the fitted curve crossed it where no point does.`); }
  if (T.lt2.why === 'not-reached') { ko.push(`가장 높은 젖산이 ${n1(T.lt2.maxLa)} mmol/L(${n1(CURVE_LT2_MIN_LA)} 미만)라 이 곡선으로는 LT2를 정하지 않습니다 — LT2는 MLSS 검증·계단 테스트로.`); en.push(`The highest value is ${n1(T.lt2.maxLa)} mmol/L (under ${n1(CURVE_LT2_MIN_LA)}), so this curve does not place LT2 — that comes from the MLSS check or a step test.`); }
  else if (T.lt2.why === 'below-lt1') { ko.push('LT2 추정이 LT1보다 낮게 나와 쓰지 않습니다.'); en.push('The LT2 estimate came out below LT1 and is not used.'); }
  else if (T.lt2.why === 'none') { ko.push(`LT2는 5점 이상이고 ${n1(CURVE_LT2_MIN_LA)} mmol/L에 닿은 곡선에서만 계산합니다.`); en.push(`LT2 is calculated only from five or more points that reach ${n1(CURVE_LT2_MIN_LA)} mmol/L.`); }
  if (!T.apply) { ko.push(`「${S.apply_zones.ko}」은 LT1·LT2가 모두 이 곡선에서 나올 때만 열립니다. LT1 범위는 두 랩 검증이 두 번 연속 같은 결과일 때 홈의 「범위 반영」으로 옮깁니다.`); en.push(`“${S.apply_zones.en}” opens only when both LT1 and LT2 come from this curve. The LT1 band moves through Home’s “Apply the band change” after two consecutive two-lap results.`); }
  return ko.length ? `<p class="small muted" id="md-note" style="margin-top:6px">${esc(ko.join(' '))} <span class="en">${esc(en.join(' '))}</span></p>` : '';
}
/** The warm-up plan of the running session, from the engine's own numbers. */
function liveWarmupPlan(v) { const e = A.engine; return e ? warmupSteps({ mode: v.mode, W: e.meta?.warmup, purpose: e.meta?.purpose, warmupSec: v.mode === 'lt2' ? e.intervals.warmupSec : v.mode === 'verify' ? e.laps.warmupSec : 0, protocol: e.protocol }) : null; }
/** The one speed of the running session's main part: the speed of its card's field (the test speed, the interval speed, the treadmill speed); without one, the easy speed (LT1 session) or the LT2 speed (ladder). */
function liveMainSpeed(v) { const e = A.engine; if (Number.isFinite(e?.meta?.speed)) return n1(e.meta.speed); return v.mode === 'lt1' ? (e?.meta?.warmup?.easy ?? null) : v.mode === 'lt2' && Number.isFinite(v.targets?.speedHi) ? n1(v.targets.speedHi) : null; }
/**
 * The speed to set now, for the banner: in a warm-up the step that applies at this second; in the ladder's recovery and cool-down
 * their speed; in an LT1 session the main speed from 5:00 until the band is judged (10:00) — large, and under it what comes next and
 * when. One speed, never a range; the same numbers at the same moments as the voice. null in every other phase and when the speeds
 * are not known (the banner then shows the zone state or the phase's name).
 */
function speedNow(v) {
  const e = A.engine; if (!e || v.state !== 'running') return null; const W = e.meta?.warmup, T = v.targets, el = v.phaseElapsed || 0, main = liveMainSpeed(v);
  const banner = (lbl, speed, next) => ({ sig: `${lbl}|${speed}|${next}`, html: `<span class="wu"><span class="wu-now"><span>${esc(lbl)}</span><b class="wu-speed" id="lv-speed">${esc(speed)}</b><span>km/h</span></span>${next ? `<span class="wu-next">${esc(next)}</span>` : ''}</span>` });
  const from = (sec, what) => lx(`${fmtClock(sec)}부터 ${what}`, `from ${fmtClock(sec)}: ${what}`), stepTxt = st => `${st.walk ? lx('걷기 ', 'walk ') : ''}${st.speed} km/h`, walking = st => (st.walk ? lx(' 걷기', ' walk') : '');
  if (v.mode === 'lt2' && v.phase === 'rest') return W?.rec ? banner(lx('회복', 'Recovery'), W.rec, main ? lx(`다음 인터벌 ${v.rep + 1}/${v.reps} · ${main} km/h`, `next: interval ${v.rep + 1}/${v.reps} at ${main} km/h`) : '') : null;
  if (v.mode === 'lt2' && v.phase === 'cooldown') { const at = stepAt(cooldownSteps({ W, cooldownSec: e.intervals.cooldownSec }), el); return at ? banner(lx('쿨다운', 'Cool-down') + walking(at.step), at.step.speed, at.next ? from(at.next.fromSec, stepTxt(at.next)) : '') : null; }
  if (!(v.mode === 'lt1' ? v.phase === 'work' : v.phase === 'warmup')) return null;
  const plan = liveWarmupPlan(v), end = plan.totalSec, judgeFrom = T?.judgeFromSec ?? 600;
  if (v.mode === 'lt1' && el >= plan.totalSec) return plan.steps.length && main && el < judgeFrom ? banner(lx('본 속도', 'Main speed'), main, lx(`심박 판정은 ${fmtClock(judgeFrom)}부터`, `heart rate judged from ${fmtClock(judgeFrom)}`)) : null; // after the 5-min jog: the main speed, until the band is judged
  const at = stepAt(plan, el); if (!at) return null; let next = '';
  if (at.next) next = from(at.next.fromSec, stepTxt(at.next));
  else if (v.mode === 'lt1') next = main ? from(end, lx(`본 속도 ${main} km/h`, `main speed ${main} km/h`)) : '';
  else if (v.mode === 'verify') next = main ? from(end, `${tx('lap1')} ${main} km/h`) : '';
  else if (v.mode === 'lt2') next = main ? from(end, lx(`인터벌 ${main} km/h`, `intervals at ${main} km/h`)) : '';
  else if (v.mode === 'test') next = v.nextStage ? from(end, lx(`1단계 ${n1(v.nextStage.speed)} km/h`, `stage 1 at ${n1(v.nextStage.speed)} km/h`)) : '';
  return banner(tx('warmup') + walking(at.step), at.step.speed, next);
}
function planCtx(withOffset = false) { const p = A.settings.plan; return planContext({ startDate: p.startDate || null, calendar: p.calendar || '', weekOffset: withOffset ? (p.weekOffset || 0) : 0 }); } // the ‹ › offset of the Plan tab never moves Home or a live session
function planWeek() { return planCtx().ladderWeek; }
function planArgs(z, ins, all, bf, withOffset = false) { const c = planCtx(withOffset); return { zones: z, week: c.ladderWeek, blockWeek: c.blockWeek, longWeek: c.longWeek, kinds: c.kinds, notes: c.notes, weekdayMin: A.settings.plan.weekdayMin, weekendMin: A.settings.plan.weekendMin, goal: A.settings.plan.goal, lt1Adjust: ins.lt1Adjust, longestMin: longestRecentMin(all), hardCapMin: longestHardWorkMin(all), verifySpeed: bf.nextSpeed, verifyDue: checkDueInWeek(bf.cadence, c.monday), verifyNext: bf.cadence && bf.cadence.due ? (d => `${d.getMonth() + 1}/${d.getDate()}`)(new Date(bf.cadence.due)) : null }; }
const weekTag = (c, plan) => `${t('week')} ${c.blockWeek} (${c.monday})${plan.kinds.includes('mlss') ? ' · MLSS 검증 주 / MLSS-check week' : plan.kinds.includes('blood') ? ' · 혈액검사 주 / blood-test week' : plan.kinds.includes('easy') ? ' · 쉬운 주 / easy week' : plan.kinds.includes('test') ? ' · 검정 주 / test week' : ''}${plan.recovery ? ' · 회복주 / recovery' : ''}${plan.kinds.includes('step') ? ' · 계단 테스트 주 / step-test week' : ''}`;
/**
 * Language "English + 한국어" (v1.1.28, owner: swap the order of English and Korean, "with the least risk of malfunction"): a
 * display-only pass over what is already drawn — nothing about how screens are built changes, and the other three language settings
 * are untouched. Every Korean / English pair (a span.ko + span.en, or Korean text followed by span.en) is swapped in place: the English
 * part takes the class `ko` (shown as the main line) and moves in front, the Korean part takes the class `en` (the small grey line), so
 * the existing styles lay both out as before with the languages exchanged. Only text and plain inline elements are ever moved — never
 * a field, a button or anything with an id. A MutationObserver does the same for whatever is drawn later (repaints, the live screen,
 * dialogs, toasts); every swapped node is marked, so the observer never swaps twice and never loops.
 */
const INLINE_TAGS = new Set(['B', 'I', 'EM', 'STRONG', 'SMALL', 'CODE', 'SUP', 'SUB', 'SPAN', 'U', 'MARK']);
function swapPair(en) {
  if (!en.isConnected || en.dataset.sw || !en.parentNode) return;
  en.dataset.sw = '1'; const parent = en.parentNode; const prev = en.previousSibling; let ko = null;
  if (prev && prev.nodeType === 1 && prev.classList.contains('ko') && !prev.dataset.sw) ko = prev;
  else {
    const run = []; let n = prev;
    while (n) {
      if (n.nodeType === 3) { run.unshift(n); n = n.previousSibling; continue; }
      if (n.nodeType === 1 && INLINE_TAGS.has(n.tagName) && !n.id && !n.classList.contains('en') && !n.classList.contains('ko') && !n.dataset.sw && !n.querySelector('input,select,button,textarea,[id],[data-action]')) { run.unshift(n); n = n.previousSibling; continue; }
      break;
    }
    if (!run.some(x => /[가-힣]/.test(x.textContent))) return; // nothing Korean right before it: leave it as it is
    ko = document.createElement('span'); parent.insertBefore(ko, run[0]); for (const x of run) ko.appendChild(x);
  }
  ko.dataset.sw = '1'; ko.classList.remove('ko'); ko.classList.add('en'); en.classList.remove('en'); en.classList.add('ko');
  parent.insertBefore(en, ko);
}
/**
 * The rest of the English-first pass (v1.1.29, owner: "안 바뀐 부분이 있음"): Korean written inside one text, never as a pair of elements.
 *   · "한국어 / English" in one text (field labels, the live phase label, toasts, buttons, the Plan footnote) → "English / 한국어"; only
 *     the Korean part next to the slash moves ("Lap 1 · 8.7 km/h · 10분 값 / 10-min value" → "… · 10-min value / 10분 값").
 *   · Korean text followed by <span class="muted">/ English</span> (the checklists) → the English first, the Korean in the muted span.
 *   · a Korean word, a line break, then an English word (the Plan tab's days "월 / Mon") → the English word first.
 *   · a few labels that have no English at all → "English / 한국어" from a short table (TEXT_EN).
 * Only text is touched — never a field's value (input, textarea, select), never an element with an id; originals are kept for the way back.
 */
const HANGUL = /[가-힣]/;
const TEXT_EN = { '러닝머신 km/h': 'Treadmill km/h', '경사 %': 'Incline %', '최대 km/h': 'Max km/h', '최대 경사 %': 'Max incline %', '시작 km/h': 'Start km/h', '증분 km/h': 'Step km/h', '경사 % (고정)': 'Incline % (fixed)', '고정 속도 km/h': 'Fixed speed km/h', '시작 경사 %': 'Start incline %', '경사 증분 %p': 'Incline step %p', '워밍업 km/h': 'Warm-up km/h', '종료 젖산 mmol/L': 'Stop lactate mmol/L', '인터벌 속도 km/h': 'Interval speed km/h', '상태': 'Status' };
const TEXT_ORIG = new Map(); // text node → its Korean-first text (for the way back)
const NO_TEXT = 'textarea,input,script,style,[data-sw]'; // (an option's text is only its label: its value stays)
function swapText(n) {
  const el = n.parentElement; if (!el || TEXT_ORIG.has(n) || el.closest(NO_TEXT)) return;
  const raw = n.data; if (!HANGUL.test(raw)) return;
  const lead = raw.match(/^\s*/)[0], trail = raw.match(/\s*$/)[0], t = raw.trim(); let out = null;
  if (TEXT_EN[t]) out = `${TEXT_EN[t]} / ${t}`;
  else if (t.includes('백업 JSON') && !HANGUL.test(t.replace('백업 JSON', ''))) out = t.replace('백업 JSON', 'backup JSON');
  else {
    let i = -1; for (let k = t.indexOf(' / '); k >= 0; k = t.indexOf(' / ', k + 1)) { const L = t.slice(0, k), R = t.slice(k + 3); if (HANGUL.test(L) && !HANGUL.test(R) && /[A-Za-z]/.test(R)) { i = k; break; } }
    if (i >= 0) {
      const L = t.slice(0, i); let R = t.slice(i + 3); const tail = (R.match(/\s*·\s*$/) || [''])[0]; R = R.slice(0, R.length - tail.length);
      const h = L.search(HANGUL); const cut = L.lastIndexOf(' · ', h); const from = cut >= 0 ? cut + 3 : 0; // the Korean segment: from the last " · " before the first Korean letter
      out = `${L.slice(0, from)}${R} / ${L.slice(from)}${tail}`;
    }
  }
  if (out == null || out === t) return;
  TEXT_ORIG.set(n, raw); n.data = lead + out + trail;
}
/** <span class="muted">/ English</span> after Korean text: English first. */
function swapMuted(m) {
  if (m.dataset.sw || !m.parentNode || HANGUL.test(m.textContent) || !/^\s*\/\s*\S/.test(m.textContent)) return;
  const run = []; let n = m.previousSibling;
  while (n) { if (n.nodeType === 3 || (n.nodeType === 1 && INLINE_TAGS.has(n.tagName) && !n.id && !n.dataset.sw && !n.classList.contains('muted') && !n.querySelector('input,select,button,textarea,[id],[data-action]'))) { run.unshift(n); n = n.previousSibling; } else break; }
  m.dataset.sw = '1'; if (!run.some(x => HANGUL.test(x.textContent))) return;
  const parent = m.parentNode, en = document.createElement('span'), ko = document.createElement('span');
  en.dataset.sw = '1'; ko.dataset.sw = '1'; ko.className = 'muted'; en.textContent = m.textContent.replace(/^\s*\/\s*/, '') + ' ';
  parent.insertBefore(en, run[0]); parent.insertBefore(ko, run[0]); ko.appendChild(document.createTextNode('/ ')); for (const x of run) ko.appendChild(x);
  m.remove(); // (its English now leads the line; switching back repaints the screen)
}
/** "월<br><span>Mon</span>": the English word first. */
function swapStacked(br) {
  const ko = br.previousSibling, en = br.nextSibling;
  if (!ko || !en || ko.nodeType !== 3 || en.nodeType !== 1 || en.dataset.sw || !HANGUL.test(ko.data) || HANGUL.test(en.textContent) || !/[A-Za-z]/.test(en.textContent) || en.id || en.querySelector('*')) return;
  en.dataset.sw = '1'; const k = document.createElement('span'); k.dataset.sw = '1'; k.className = en.className; br.parentNode.insertBefore(k, ko); k.appendChild(ko);
  en.className = ''; br.parentNode.insertBefore(en, k); br.parentNode.insertBefore(br, k);
}
const swapIn = root => {
  if (root.nodeType === 3) { swapText(root); return; } if (root.nodeType !== 1) return;
  if (root.matches('.en:not([data-sw])')) swapPair(root); root.querySelectorAll('.en:not([data-sw])').forEach(swapPair);
  if (root.matches('span.muted:not([data-sw])')) swapMuted(root); root.querySelectorAll('span.muted:not([data-sw])').forEach(swapMuted);
  root.querySelectorAll('br').forEach(swapStacked);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const list = []; for (let n; (n = w.nextNode());) list.push(n); list.forEach(swapText);
};
let langObserver = null;
function applyLang() {
  const on = A.settings.profile.lang === 'enfirst'; document.documentElement.classList.toggle('lang-enfirst', on);
  if (on && !langObserver) { langObserver = new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) swapIn(n); }); langObserver.observe(document.body, { childList: true, subtree: true }); swapIn(document.body); }
  else if (!on && langObserver) { langObserver.disconnect(); langObserver = null; unswapAll(); }
}
/** Back to Korean first without a reload (a session may be running): every swapped pair goes back to its order and classes (the screens repaint anyway; this is for what stays, the tab bar). */
function unswapAll() {
  for (const [n, raw] of TEXT_ORIG) if (n.isConnected) n.data = raw; TEXT_ORIG.clear();
  document.querySelectorAll('.ko[data-sw]').forEach(en => { const ko = en.nextSibling; if (ko && ko.nodeType === 1 && ko.dataset.sw && ko.classList.contains('en')) { en.parentNode.insertBefore(ko, en); ko.classList.remove('en'); ko.classList.add('ko'); en.classList.remove('ko'); en.classList.add('en'); delete ko.dataset.sw; } delete en.dataset.sw; });
  document.querySelectorAll('[data-sw]').forEach(n => { delete n.dataset.sw; });
}
function applyTheme() { const th = A.settings.profile.theme; if (th === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', th); }
async function saveSettings() { await store.saveSettings(A.settings); setLang(A.settings.profile.lang); applyTheme(); applyLang(); setRestBaseline(A.settings.profile.restLactate); setMlssLactate(A.settings.zones.mlssLactate); setAlphaUse(A1()); }
/** The "lowest" of the two-lap rule: the lowest in-test lactate of the newest finished step test (real strap), else the resting baseline (prescribe.lactateFloor). */
function refreshTestLowest() { const t = A.sessions.find(s => s.type === 'test' && s.final && s.sourceKind !== 'demo' && Number.isFinite(testLowest(s))); setTestLowest(t ? testLowest(t) : null); }
function destroyCharts() { for (const c of A.charts) { try { c.destroy(); } catch (e) { /* ignore */ } } A.charts = []; }

// ---------- router ----------
function navigate(view, param = null) { A.view = view; A.param = param; destroyCharts(); render(); try { localStorage.setItem('tl.view', view); } catch (e) { /* ignore */ } window.scrollTo(0, 0); }
async function render() {
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === A.view));
  const v = $('#view'); const view = A.view; const seq = A.renderSeq = (A.renderSeq || 0) + 1;
  const current = () => A.renderSeq === seq; // a screen that took long to build must not paint over the tab the user went to meanwhile
  try {
    if (A.view === 'home') { const h = await renderHome(); if (current()) v.innerHTML = h; }
    else if (A.view === 'live') { v.innerHTML = renderLive(); try { mountLive(); } catch (e) { console.error('live screen', e); } } // (the buttons work without the chart: Finish must stay reachable)
    else if (A.view === 'analysis') { if (A.param) { v.innerHTML = '<p class="muted">…</p>'; await renderSessionDetail(A.param, current); } else { const h = await renderAnalysisList(); if (current()) v.innerHTML = h; } }
    else if (A.view === 'plan') { const h = await renderPlan(); if (current()) v.innerHTML = h; }
    else if (A.view === 'settings') { v.innerHTML = renderSettings(); mountSettings(); }
  } catch (e) { if (current()) showRenderError(e); }
  updateConnChip();
}
/** A screen that fails must not look like a frozen app: say so (with the text to report) and leave a way on — the other tabs, Finish for a running session, Delete for a session that cannot be shown. */
function showRenderError(e) {
  console.error('render', A.view, e);
  const running = A.engine && A.engine.state === 'running';
  const btns = (running ? `<button class="danger" data-action="stop">${t('stop')}</button> <button class="ghost" data-action="pause">${t('pause')}</button> <button class="ghost" data-action="lactate">${t('lactate_entry')}</button>` : '') + (A.view === 'analysis' && A.param ? ` <button class="ghost danger" data-action="delete-broken" data-id="${esc(A.param)}">이 세션 삭제 <span class="en">Delete this session</span></button>` : '');
  $('#view').innerHTML = `<div class="notice warn" id="render-error"><b>이 화면을 표시하지 못했습니다.</b> 다른 탭은 그대로 쓸 수 있고, 기록 중인 세션은 계속 기록됩니다${running ? ' — 아래 버튼으로 종료할 수 있습니다' : ''}. 아래 내용을 알려 주세요.<span class="en"><b>This screen could not be shown.</b> The other tabs still work and a running session keeps recording${running ? ' — it can be finished with the button below' : ''}. Please report the text below.</span>${btns ? `<div class="row" style="margin-top:8px">${btns}</div>` : ''}<pre class="small" style="white-space:pre-wrap;word-break:break-all;margin-top:6px">${esc(String((e && (e.stack || e.message)) || e).slice(0, 500))}</pre></div>`;
}
document.getElementById('nav').addEventListener('click', e => { const b = e.target.closest('button'); if (b) navigate(b.dataset.view); });
$('#view').addEventListener('click', onViewClick);

// ---------- TODAY'S EXERCISE LIST (v1.1.39) ----------
// Owner (10/23): "러닝 및 그 외 운동 세부 리스트를 제시하여 각각의 운동을 체크 · 이를 수집하여 다음 운동에 반영". Every part of the day is a row:
// tap = done. Rows with a number (kg, reps, contacts, minutes) keep what was done; the next time the same exercise comes up its target is
// computed from the last log — done with the target → the step up (lower lifts +5 kg, upper +2.5 kg, chin-ups +1 rep, plyometric contacts
// +10 to 100, StairMaster +5 min to 20), not done → the same target again. Running rows tick themselves once a real session (or free run) of
// today is finished; the run's RPE (session end, or typed here) shapes the next easy day. Stored in settings.log[date] (kept 120 days).
const EX = {
  r_wu: ['워밍업', 'Warm-up'], r_main: ['본 구간', 'Main part'], r_str: ['스트라이드 4–6 × 20초', 'Strides 4–6 × 20 s'], r_cd: ['쿨다운 걷기', 'Cool-down walk'], r_rpe: ['RPE (0–10)', 'RPE (0–10)', 'rpe'],
  mob: ['가동성 5분', 'Mobility 5 min'], deadbug: ['데드버그 3×8/측', 'Dead bug 3 × 8/side'], splank: ['사이드 플랭크 2×30초/측', 'Side plank 2 × 30 s/side'], pallof: ['팔로프 2×10/측', 'Pallof 2 × 10/side'], foot: ['발 코어 5분', 'Foot core 5 min'],
  birddog: ['버드독 2×8/측', 'Bird dog 2 × 8/side'], hollow: ['할로우 2×20초', 'Hollow 2 × 20 s'], sls: ['한발 서기 30초×2/측', 'Single-leg stand 30 s × 2/side'], wallsit: ['월 싯 2분×4', 'Wall sit 2 min × 4'],
  squat: ['스쿼트 3×3–6', 'Squat 3 × 3–6', 'kg', 5], bench: ['벤치 3×8–12', 'Bench 3 × 8–12', 'kg', 2.5], chin: ['친업 3세트', 'Chin-up 3 sets', 'reps', 1],
  dl: ['데드리프트 3×3–6', 'Deadlift 3 × 3–6', 'kg', 5], ohp: ['OHP 3×8–12', 'OHP 3 × 8–12', 'kg', 2.5], row: ['로우 3×8–12', 'Row 3 × 8–12', 'kg', 2.5],
  rdl: ['RDL 3×8–12', 'RDL 3 × 8–12', 'kg', 5], bulg: ['불가리안 3×8/측', 'Bulgarian 3 × 8/side', 'kg', 2.5], facepull: ['페이스 풀 3×12', 'Face pull 3 × 12'], carry: ['파머스 캐리 2×40 m', 'Farmer\'s carry 2 × 40 m', 'kg', 2.5], calf: ['앉은 카프 3×15', 'Seated calf 3 × 15', 'kg', 2.5],
  walk: ['걷기 20분', 'Walk 20 min'], incline: ['경사 걷기 20분', 'Incline walk 20 min'], plyo: ['플라이오 (접지)', 'Plyometrics (contacts)', 'contacts', 10], foam: ['폼롤링 5분', 'Foam roll 5 min'], calfhold: ['카프 홀드 5×45초', 'Calf holds 5 × 45 s'],
  stairs: ['천국의 계단 (선택)', 'StairMaster (optional)', 'min', 5],
};
const UNIT = { kg: 'kg', reps: '회', contacts: '회', min: '분', rpe: '' };
const CAP = { plyo: 100, stairs: 20 };
const START = { stairs: 10, rpe: null };
const OTHER_DAY = { 1: ['mob', 'deadbug', 'splank', 'pallof', 'foot', 'birddog', 'hollow', 'sls', 'wallsit'], 2: ['squat', 'bench', 'chin', 'rdl', 'pallof', 'carry', 'calf', 'sls'], 3: ['walk', 'plyo', 'incline'], 4: ['dl', 'ohp', 'row', 'bulg', 'facepull', 'carry', 'calf', 'sls'], 5: ['foam', 'calfhold', 'mob', 'plyo', 'foot', 'wallsit'], 6: ['stairs'], 0: ['incline'] };
const dkey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayKey = () => dkey(new Date());
const sameDay = (ms, key) => Number.isFinite(ms) && dkey(new Date(ms)) === key;
function dayLog(key) { const L = A.settings.log || (A.settings.log = {}); return L[key] || (L[key] = {}); }
/** The last logged entry of an exercise before today. */
function lastOf(id, key) { const L = A.settings.log || {}; const ks = Object.keys(L).filter(k => k < key && L[k][id] && (L[k][id].d || Number.isFinite(L[k][id].v))).sort(); return ks.length ? { date: ks[ks.length - 1], ...L[ks[ks.length - 1]][id] } : null; }
/** Today's target from the last log: done → one step up (capped), not done → the same; none yet → the start value or empty. */
function targetOf(id, key, plan) {
  const ex = EX[id]; if (!ex || !ex[2] || ex[2] === 'rpe') return null; const last = lastOf(id, key);
  if (!last || !Number.isFinite(last.v)) return id === 'plyo' && plan && Number.isFinite(plan.plyoContacts) ? plan.plyoContacts : (START[id] ?? null);
  const up = last.d ? last.v + ex[3] : last.v; return CAP[id] ? Math.min(CAP[id], up) : up;
}
const realToday = (all, key) => all.filter(s => s.final && s.sourceKind !== 'demo' && sameDay(s.startedAt, key));
function runRows(today) { if (!today || today.type === 'rest') return []; return ['r_wu', 'r_main', ...(today.day === 1 ? ['r_str'] : []), 'r_cd', 'r_rpe']; }
/** The latest run RPE before today (session RPE or typed here) and whether that day was easy. */
function lastRunRpe(all, key) {
  const L = A.settings.log || {}; let best = null;
  for (const s of all) { if (!s.final || s.sourceKind === 'demo' || !Number.isFinite(s.rpe) || sameDay(s.startedAt, key) || dkey(new Date(s.startedAt)) > key) continue; const k = dkey(new Date(s.startedAt)); if (!best || k > best.date) best = { date: k, rpe: s.rpe, easy: s.type === 'lt1' || s.type === 'free' }; }
  for (const k of Object.keys(L)) { if (k >= key || !L[k].r_rpe || !Number.isFinite(L[k].r_rpe.v)) continue; if (!best || k > best.date) best = { date: k, rpe: L[k].r_rpe.v, easy: true }; }
  return best;
}
function exDone(id, key, all) { const e = dayLog(key)[id]; if (e && (e.d === true || e.d === false)) return e.d; if (id.startsWith('r_') && id !== 'r_rpe') return realToday(all, key).length > 0; if (id === 'r_rpe') return Number.isFinite(e && e.v) || realToday(all, key).some(s => Number.isFinite(s.rpe)); return false; }
function checklistCard(today, all, plan) {
  const key = todayKey(); const dow = new Date().getDay(); const log = dayLog(key);
  const row = id => { const ex = EX[id]; const on = exDone(id, key, all); const e = log[id] || {}; const kind = ex[2]; const tgt = targetOf(id, key, plan); const last = kind ? lastOf(id, key) : null;
    const sessRpe = id === 'r_rpe' ? (realToday(all, key).find(s => Number.isFinite(s.rpe)) || {}).rpe : undefined; const val = Number.isFinite(e.v) ? e.v : (Number.isFinite(sessRpe) ? sessRpe : '');
    const hint = kind && kind !== 'rpe' ? `${last ? `지난 ${last.v ?? '–'}${UNIT[kind]}${last.d ? ' ✓' : ''} · ` : ''}${tgt != null ? `오늘 ${tgt}${UNIT[kind]}` : '첫 기록'}` : '';
    const inp = kind ? `<input class="ex-val" type="number" inputmode="decimal" step="${kind === 'kg' ? 0.5 : 1}" data-id="${id}" value="${val}" placeholder="${tgt ?? ''}" aria-label="${esc(ex[0])}">` : '';
    return `<div class="chk-row${on ? ' on' : ''}"><button class="chk-tap" data-action="chk" data-id="${id}"><span class="box" aria-hidden="true">${on ? '✓' : ''}</span><span>${esc(ex[0])}<span class="en">${esc(ex[1])}</span>${hint ? `<span class="small muted ex-hint">${esc(hint)}</span>` : ''}</span></button>${inp}</div>`; };
  const rr = runRows(today); const lr = lastRunRpe(all, key);
  const flag = rr.length && lr && lr.easy && lr.rpe >= 5 && today && today.type === 'lt1' ? `<p class="notice warn small" style="margin:0 0 6px">지난 쉬운 런 RPE ${lr.rpe} (≥ 5) → 오늘은 밴드 하단, 속도 −0.3 <span class="en">Last easy run RPE ${lr.rpe} (≥ 5) → today at the low end, speed −0.3</span></p>` : '';
  const other = OTHER_DAY[dow] || [];
  return `<h2>오늘 체크 <span class="en">Today's checks</span></h2><div class="card chk-list">${rr.length ? `<div class="small muted">러닝 <span class="en">Run</span></div>${flag}${rr.map(row).join('')}` : ''}${other.length ? `<div class="small muted" style="margin-top:6px">다른 운동 <span class="en">Other exercise</span></div>${other.map(row).join('')}` : ''}</div>`;
}
function saveLog() { const L = A.settings.log; const keep = Object.keys(L).sort().slice(-120); for (const k of Object.keys(L)) if (!keep.includes(k)) delete L[k]; return saveSettings(); }
function toggleCheck(id) {
  const key = todayKey(); const e = dayLog(key)[id] || (dayLog(key)[id] = {}); const on = exDone(id, key, A.sessions); e.d = !on;
  if (e.d && !Number.isFinite(e.v)) { const t = targetOf(id, key, A.planCache || A.homePlan); if (Number.isFinite(t)) e.v = t; } // checked without typing = the target was done
  saveLog().then(render);
}
function setExValue(id, raw) { const key = todayKey(); const v = parseFloat(String(raw).replace(',', '.')); const e = dayLog(key)[id] || (dayLog(key)[id] = {}); if (Number.isFinite(v)) { e.v = v; if (e.d !== false) e.d = true; } else delete e.v; saveLog().then(render); }

// ---------- HOME ----------
async function renderHome() {
  const z = zonesObj(); const week = planWeek();
  const sessions = A.sessions; const lastTest = sessions.find(s => s.type === 'test' && s.final); const last = sessions.find(s => s.final);
  const all = await store.listSessions(); const ins = assessRecent(all, z, A.settings.zones.updatedAt, { restLactateAt: A.settings.profile.restLactateAt });
  const bf = bandFinder(all, A.settings.zones); A.bandFinder = bf;
  const plan = z ? weeklyPlan(planArgs(z, ins, all, bf)) : null; const pc = planCtx();
  const todayIdx = new Date().getDay(); const today = plan ? plan.days.find(d => d.day === todayIdx) : null;
  let html = ''; // v1.1.38: Home = today's session + today's checks (thresholds live in Plan / Settings)
  if (false) html += `<div class="card accent"><div class="thr-card">
      <div class="box"><div class="small muted">${t('lt1')}</div><div class="v">${n0(z.lt1Hr)}<small> bpm</small></div><div class="small">${Number.isFinite(z.lt1Speed) ? n1(z.lt1Speed) + ' km/h' : ''}</div></div>
      <div class="box"><div class="small muted">${t('lt2')}</div><div class="v">${n0(z.lt2Hr)}<small> bpm</small></div><div class="small">${Number.isFinite(z.lt2Speed) ? n1(z.lt2Speed) + ' km/h' : ''}</div></div></div>
</div>`;
  if (!z) html += `<h2>${t('zones_title')}</h2><div class="card"><p>${t('no_zones')}</p><div class="grid2"><button class="primary" data-action="go-test">${t('start_test')}</button><button data-action="import">${t('import_file')}</button></div></div>`;
  html += `<h2>${t('today')}</h2>`;
  if (today) {
    const hrTxt = today.hr ? `${today.hr.hrLo}–${today.hr.hrHi} bpm` : ''; const wuTxt = dayWarmup(today, z); // the warm-up speed on its own line (v1.1.26)
    const todayHead = `<h3 class="type-${today.type}">${esc(today.ko)}<span class="en">${esc(today.en)}</span></h3><div class="mono">${placeTag(today)}${today.place ? ' · ' : ''}${today.minutes ? `${today.minutes} min` : '–'}${hrTxt ? ` · ${hrTxt}` : ''}${Array.isArray(today.speed) ? ` · ${today.speed[0].toFixed(1)}${today.speed[1] !== today.speed[0] ? `–${today.speed[1].toFixed(1)}` : ''} km/h` : Number.isFinite(today.speed) ? ` · ${today.speed.toFixed(1)} km/h` : ''}</div>${wuTxt ? `<div class="mono wu-line" id="home-warmup">${esc(wuTxt)}</div>` : ''}`;
    const todayBody = `${today.note ? `<p class="small muted" style="margin:0">${esc(today.note.ko)}<span class="en">${esc(today.note.en)}</span></p>` : ''}${today.evening ? `<p class="small" style="margin:4px 0 0">점심·저녁 / noon · evening: ${esc(today.evening.ko)}<span class="en">${esc(today.evening.en)}</span></p>` : ''}`;
    html += `<div class="card">${descBlock('home-today', todayHead, todayBody)}
      <div class="grid1" style="margin-top:10px;display:grid">${today.type === 'rest' ? `<button disabled>${t('start_session')}</button>` : today.type === 'test' ? `<button class="primary big" data-action="go-test">${t('start_test')}</button>` : `<button class="primary big" data-action="go-live" data-mode="${today.type === 'lt2' || today.type === 'tempo' ? 'lt2' : today.type === 'verify' ? 'verify' : 'lt1'}" data-minutes="${today.minutes}" data-surface="${today.surface || 'treadmill'}"${Number.isFinite(today.speed) ? ` data-speed="${today.speed}"` : ''}${today.purpose ? ` data-purpose="${today.purpose}"` : ''}${today.structure ? ` data-structure="${esc(JSON.stringify(today.structure))}"` : ''}>${t('start_session')}</button>`}</div></div>`;
  } else html += `<div class="card"><p class="muted">${t('no_zones')}</p></div>`;
  A.homePlan = plan; html += checklistCard(today, all, plan);
  // the weekly LT1 verification run (v1.1.17): this week's test speed from the latest two-lap result; the band moves after two consecutive results
  if (z && bf.change) html += `<h2>${bf.cadence && bf.cadence.mode === 'maintenance' ? 'LT1 검증 (4주마다) <span class="en">LT1 check (every 4 weeks)</span>' : '주간 LT1 검증 <span class="en">Weekly LT1 check</span>'}</h2><div class="card"><p class="small"><b class="mono">${Number.isFinite(bf.nextSpeed) ? bf.nextSpeed.toFixed(1) + ' km/h' : '–'}</b></p>${bf.change ? `<button class="primary block" style="margin-top:8px" data-action="apply-band">범위 반영: ${esc(bf.change.ko)} <span class="en">Apply the band change</span></button>` : ''}<div class="row" style="margin-top:8px"><button class="compact" data-action="go-live" data-mode="verify"${Number.isFinite(bf.nextSpeed) ? ` data-speed="${bf.nextSpeed}"` : ''}>${t('mode_verify')} ›</button></div></div>`;
  // the MLSS checks (v1.1.35): two passes at the same speed before the ladder speed rises; the end lactate of a pass/hold is the ladder's target
  if (z) { const mp = mlssPasses(all, A.settings.zones.lt2Speed); A.mlssPasses = mp; const mBtn = mp.last && ((Number.isFinite(mp.last.mlssLa) && A.settings.zones.mlssLactate !== mp.last.mlssLa) || (mp.passes >= 2 && Number.isFinite(mp.nextSpeed) && mp.nextSpeed !== A.settings.zones.lt2Speed)); if (mBtn) html += `<h2>MLSS 검증 <span class="en">MLSS checks</span></h2><div class="card">${Number.isFinite(mp.last.mlssLa) && A.settings.zones.mlssLactate !== mp.last.mlssLa ? `<button class="compact" style="margin-top:6px" data-action="save-mlss-lactate" data-la="${mp.last.mlssLa}">MLSS 젖산 ${mp.last.mlssLa}를 사다리 목표로 저장 (± 0.5) <span class="en">Save MLSS lactate ${mp.last.mlssLa} as the ladder target (± 0.5)</span></button>` : ''}${mp.passes >= 2 && Number.isFinite(mp.nextSpeed) && mp.nextSpeed !== A.settings.zones.lt2Speed ? `<button class="primary compact" style="margin-top:6px" data-action="raise-lt2" data-speed="${mp.nextSpeed}">통과 2회 → LT2 속도 ${mp.nextSpeed} km/h로 <span class="en">Two passes → LT2 speed ${mp.nextSpeed} km/h</span></button>` : ''}</div>`; }
  return html;
}

// ---------- LIVE ----------
function ensureEngine() {
  if (!A.alerts) A.alerts = new Alerts(A.settings.alerts);
  if (!A.engine) {
    A.engine = new SessionEngine({ settings: A.settings, alerts: A.alerts, onUpdate: v => updateLive(v), onEvent: e => onEngineEvent(e), onAutosave: snap => store.putSession({ ...snap, final: false }).catch(() => {}) });
  }
  return A.engine;
}
function renderLive() {
  const eng = ensureEngine(); const v = eng.view(); const L = A.live; const z = zonesObj();
  const running = v.state === 'running';
  const bleOk = HeartRateSource.available();
  const wuLineHtml = (style = '') => { const h = setupWarmupHtml(z); return `<p id="wu-line"${style ? ` style="${style}"` : ''}${h ? '' : ' hidden'}>${h}</p>`; }; // this session's warm-up speed on its own line (v1.1.26); mountLive keeps it in step with the minutes typed
  let html = '';
  if (!running) {
    html += `<h2>${t('mode')}</h2><div class="segment" id="mode-seg">${['test', 'verify', 'lt1', 'lt2', 'free'].map(m => `<button class="${L.mode === m ? 'active' : ''}" data-mode="${m}">${t('mode_' + m)}</button>`).join('')}</div>`;
    // mode-specific setup
    if (L.mode === 'test') {
      const P = A.settings.protocol; const stages = buildStages(P, A.settings.treadmill);
      html += `<div class="card" style="margin-top:10px"><div class="row between" style="align-items:flex-start"><div class="grow">${descBlock('setup-test', `<h3>${t('protocol')}</h3>`, `<p class="small muted" style="margin:0">${t('stop_criteria', { la: P.stopLactate, hr: Math.round((effectiveMaxHr() || 220) * (P.stopHrPct || 95) / 100), pct: P.stopHrPct || 95 })}</p><div class="small mono" style="margin-top:4px">${stages.map(s => `${s.idx}: ${s.speed}${P.type === 'incline' ? `/${s.incline}%` : ''}`).join(' · ')}</div>`)}</div><button class="compact ghost" data-action="go-settings">${t('nav_settings')}</button></div>
        <div class="segment" id="pause-seg" style="margin:6px 0 10px"><button class="${P.pauseSec > 0 ? 'active' : ''}" data-pause="30">채혈 정지 30초<span class="en">30-s sampling pause</span></button><button class="${P.pauseSec > 0 ? '' : 'active'}" data-pause="0">연속 · 채혈 없음 (혼자)<span class="en">Continuous · no sampling (solo)</span></button></div>
        <p class="small">${P.type === 'speed' ? `경사 ${P.incline}% 고정 · ${P.startSpeed} km/h부터 +${P.speedStep} km/h` : `속도 ${P.fixedSpeed} km/h 고정 · 경사 ${P.startIncline}%부터 +${P.inclineStep}%p`} · ${P.stageSec / 60}분 + 채혈 ${P.pauseSec}초 · 워밍업 ${P.warmupSec / 60}분 @ ${P.warmupSpeed} km/h<span class="en">${P.type === 'speed' ? `${P.incline}% incline fixed · from ${P.startSpeed} km/h, +${P.speedStep} km/h` : `${P.fixedSpeed} km/h fixed · from ${P.startIncline}%, +${P.inclineStep}%`} · ${P.stageSec / 60} min + ${P.pauseSec}-s sampling · warm-up ${P.warmupSec / 60} min @ ${P.warmupSpeed} km/h</span></p>
</div>`;
    } else if (L.mode === 'verify') {
      // the weekly two-lap LT1 check (v1.1.17): speed = the band finder's test speed unless typed; MLSS variant = lap 2 of 20 min
      const Lp = L.laps || (L.laps = { ...A.settings.laps }); const bf = A.bandFinder; const mlss = L.purpose === 'mlss';
      const defSpeed = mlss ? (Number.isFinite(z?.lt2Speed) ? z.lt2Speed : '') : (Number.isFinite(bf?.nextSpeed) ? bf.nextSpeed : (Number.isFinite(z?.lt1Speed) ? z.lt1Speed : ''));
      const fl = lactateFloor();
      const verifyDesc = `<p class="small" style="margin:0">${bf && bf.from === 'result' ? `<span class="ko">${esc(bf.ko)}</span><span class="en">${esc(bf.en)}</span>` : `<span class="ko">첫 검증: 현재 LT1 속도에서 시작합니다. 통과 → 다음 검사 +0.3 km/h(계단 검사 LT1 + 0.3까지), 경계 → 같은 속도, 실패 → −0.3.</span><span class="en">First check: start at the current LT1 speed. Pass → next check +0.3 km/h (up to the step-test LT1 + 0.3), borderline → same speed, fail → −0.3.</span>`}</p>
        <p class="small muted">기준선 ${fl ? `${fl.lowest.toFixed(1)} + 0.5 = ${(fl.lowest + 0.5).toFixed(1)} mmol/L (${fl.from === 'test' ? '계단 검사 최저값' : '안정 시 기준값'})` : '없음'} · 통과 = 랩 1 ≤ 기준선, 랩 1→종료 상승 ≤ 0.5 (간격 3분 초과 시 ≤ 0.3) · 안정 시 채혈은 선택<span class="en">Line ${fl ? `${fl.lowest.toFixed(1)} + 0.5 = ${(fl.lowest + 0.5).toFixed(1)} mmol/L (${fl.from === 'test' ? 'test lowest' : 'resting baseline'})` : 'none'} · pass = lap 1 ≤ line and lap-1 → end rise ≤ 0.5 (≤ 0.3 when the gap exceeds 3 min) · a resting sample is optional</span></p>
        <details class="small" style="margin-top:6px"><summary>진행 · 채혈 체크리스트 <span class="en">Procedure · sampling checklist</span></summary><ol style="padding-left:18px;margin:6px 0 0;line-height:1.5">
          <li>전날 준비: 키트 2벌(스트립 2개, 란셋 2개, 알코올 솜, 티슈), 스트립은 실온(15 °C 이상), 측정기 2분 자동 꺼짐 유의 <span class="muted">/ the night before: two kits (2 strips, 2 lancets, swabs, tissue), strips at room temperature (≥ 15 °C), the meter switches off after 2 min</span></li>
          <li>같은 조건: 토요일 09:00 헬스장(동력식 트레드밀, 경사 1 %), 공복, 같은 시각 ± 30분, 전날 고강도 없음, 카페인 없음(전날 14:00부터) <span class="muted">/ same conditions: Saturday 09:00 at the gym (motorized treadmill, 1 % incline), fasted, same clock time ± 30 min, no hard session the day before, no caffeine since 14:00 the day before</span></li>
          <li>${(() => { const w = warmupNums(z); return mlss ? `워밍업 5분 = 2분 ${w ? w.hi : '–'} → 3분 ${w ? w.sub : '–'} km/h → 음성에 맞춰 LT2 속도로 → 랩 1 10분 <span class="muted">/ warm-up 5 min = 2 min at ${w ? w.hi : '–'} → 3 min at ${w ? w.sub : '–'} km/h → up to the LT2 speed on the cue → lap 1, 10 min</span>` : `워밍업 5분 = 0:30 걷기 5.5 → 4:30 ${w ? w.jog : '–'} km/h(5분에 심박 < ${w ? w.z1 : '–'}, 스트라이드 없음) → 음성에 맞춰 검사 속도로 → 랩 1 10분 <span class="muted">/ warm-up 5 min = 0:30 walk at 5.5 → 4:30 at ${w ? w.jog : '–'} km/h (HR < ${w ? w.z1 : '–'} at 5:00, no strides) → up to the test speed on the cue → lap 1, 10 min</span>`; })()}</li>
          <li>「정지」: 벨트를 멈추고 <b>서서 기다리기</b>(걷지 않기). 30–45초에 채혈: 땀 닦기 → 손가락 말리기 → 첫 방울 닦기 → 짜지 않기 → 같은 손가락 쪽 → 입력 <span class="muted">/ "Stop": stop the belt and <b>stand still</b> (no walking). Sample at 30–45 s: wipe sweat → dry → wipe the first drop → no squeezing → same site → enter</span></li>
          <li>간격 60–90초 안에 벨트를 올리고 「2랩 시작」 (상한 3분, 넘으면 엄격 규칙) <span class="muted">/ belt back up and "Start lap 2" within 60–90 s (cap 3 min; beyond it the strict rule)</span></li>
          <li>랩 2 끝 「정지」 → 같은 방법으로 종료 채혈(쿨다운 전) → 입력 → 종료 <span class="muted">/ at the end of lap 2: stop → the end sample the same way (before any cool-down) → enter → Finish</span></li>
        </ol></details>`;
      html += `<div class="card" style="margin-top:10px">${descBlock('setup-verify', `<h3>${t('mode_verify')}</h3>`, verifyDesc)}
        <div class="segment" id="purpose-seg" style="margin:6px 0 10px"><button class="${mlss ? '' : 'active'}" data-purpose="lt1">LT1 (랩 2 = 30분)<span class="en">LT1 (lap 2 = 30 min)</span></button><button class="${mlss ? 'active' : ''}" data-purpose="mlss">MLSS (랩 2 = 20분)<span class="en">MLSS (lap 2 = 20 min)</span></button></div>
        <div class="grid2"><label class="field">검사 속도 km/h <span class="en">test speed</span><input type="number" id="sess-speed" step="0.1" value="${L.speed ?? defSpeed}"></label><label class="field">경사 %<input type="number" id="sess-incline" step="0.5" value="${L.incline ?? A.settings.protocol.incline}"></label></div>
        <div class="grid3" style="margin-top:8px"><label class="field">워밍업 (분)<span class="en">warm-up</span><input type="number" id="lap-wu" value="${Lp.warmupSec / 60}" min="0" max="20" step="1"></label><label class="field">랩 1 (분)<span class="en">lap 1</span><input type="number" id="lap-1" value="${Lp.lap1Sec / 60}" min="1" max="20" step="1"></label><label class="field">랩 2 (분)<span class="en">lap 2</span><input type="number" id="lap-2" value="${Lp.lap2Sec / 60}" min="1" max="60" step="1"></label></div>
        ${wuLineHtml('margin:8px 0 0')}</div>`;
    } else if (L.mode === 'lt1') {
      const T = z ? sessionTargets(z, 'lt1', { minutes: L.minutes }) : null;
      const lt1Desc = `<p class="small muted" style="margin:0">${(() => { const w = warmupNums(z); return `0–5분 ${w ? w.jog : '–'} km/h → 본 구간(속도가 용량) → 마지막 3분 걷기 5.5 · 심박 범위 판정은 10:00부터(30초 이탈 시 음성), 20:00부터 천장 LT1 + 5(60초 초과 시 "속도 −0.3") · 15분마다 말하기 검사(10단어 문장을 한 번에)<span class="en">0–5 min at ${w ? w.jog : '–'} km/h → main part (speed is the dose) → last 3 min walk at 5.5 · the band is judged from 10:00 (voice after 30 s outside), the ceiling LT1 + 5 from 20:00 (voice after 60 s above) · talk test every 15 min (a 10-word sentence in one breath)</span>`; })()}</p>
        <p class="small muted" style="margin:6px 0 0">속도를 적어 두면 종료 시 젖산 한 방울로 "검증 세션"이 됩니다(혼자 측정용). <span class="en">Enter the treadmill speed so an end-of-run lactate sample turns this into a verification run.</span></p>`;
      html += `<div class="card" style="margin-top:10px">${descBlock('setup-lt1', `<h3>${t('mode_lt1')}</h3>${T ? `<p class="inline" style="margin:0">${t('target')}: <b class="mono">${T.hrLo}–${T.hrHi} bpm</b>${A1() ? ' · α1 ≥ 0.75' : ''}${Number.isFinite(T.speedLo) ? ` · <b class="mono">${n1(midSpeed(T.speedLo, T.speedHi))} km/h</b>` : ''}</p>` : `<p class="muted">${t('no_zones')}</p>`}`, lt1Desc)}${wuLineHtml()}
        <div class="grid3"><label class="field">${t('duration')} (min)<input type="number" id="lt1-min" value="${L.minutes}" min="10" max="300" step="5"></label><label class="field">러닝머신 km/h<input type="number" id="sess-speed" step="0.1" value="${L.speed ?? (T && Number.isFinite(T.speedLo) ? n1(midSpeed(T.speedLo, T.speedHi)) : '')}"></label><label class="field">경사 %<input type="number" id="sess-incline" step="0.5" value="${L.incline ?? A.settings.protocol.incline}"></label></div>${surfaceSel()}</div>`;
    } else if (L.mode === 'lt2') {
      const st = L.lt2 || lt2Structure(planWeek()); L.lt2 = st; const vo2 = st.kind === 'vo2'; const T = z ? (vo2 ? sessionTargets(z, 'vo2') : sessionTargets(z, 'lt2', { speedOffset: st.speedOffset || 0 })) : null; const W = ladderLactateWindow();
      const lt2Desc = vo2
        ? `<p class="small muted" style="margin:0">${(() => { const w = warmupNums(z); return `VO₂max 4×4분(격주 화요일): 심박 목표 최대 심박의 90–95 %, 구간 2:30까지는 올라가는 중(판정 없음) · 회복 조깅 ${w ? w.rec : '–'} km/h · 젖산 목표 없음 · 조정: 마지막 구간을 같은 속도로 못 끝내면 다음 −0.3, 모든 구간이 90 %에 못 미치면 +0.3 · 쿨다운 ${st.cooldownSec / 60}분 = 절반 ${w ? w.jog : '–'} → 절반 걷기 5.5<span class="en">VO₂max 4×4 min (alternate Tuesdays): HR target 90–95 % of max, still rising until 2:30 of a rep (no judging there) · recovery jog at ${w ? w.rec : '–'} km/h · no lactate target · adjust: last rep not finished at speed → next time −0.3; every rep under 90 % → +0.3 · cool-down ${st.cooldownSec / 60} min = half at ${w ? w.jog : '–'} → half walking at 5.5</span>`; })()}</p>`
        : `<p class="small muted" style="margin:0">${(() => { const w = warmupNums(z); return `회복 조깅 ${w ? w.rec : '–'} km/h(끝에 심박이 ${w ? w.bandTop : '–'} 위면 피로 표시, 감속 아님) · 천장: 구간 10분까지 ${T ? T.hrHi : '–'}, 그 뒤 2분마다 +1 bpm — 심박만으로는 감속하지 않음(음성: "RPE 7 이상이면 다음 구간 0.3 느리게") · 감속 −0.3은 RPE ≥ 7, 구간 간 젖산 상승 > 1.0, 속도를 못 지킬 때 · 15분 이상 구간은 MLSS − 0.3 · 쿨다운 ${st.cooldownSec / 60}분 = 절반 ${w ? w.jog : '–'} → 절반 걷기 5.5<span class="en">recovery jog at ${w ? w.rec : '–'} km/h (HR above ${w ? w.bandTop : '–'} at its end = a fatigue flag, not a speed cut) · ceiling ${T ? T.hrHi : '–'} for the first 10 min of a rep, then +1 bpm per 2 min — never slow down on heart rate alone (voice: "RPE 7 or more → next rep 0.3 slower") · −0.3 on RPE ≥ 7, a lactate rise > 1.0 between reps or a speed that cannot be held · reps of 15 min and more at MLSS − 0.3 · cool-down ${st.cooldownSec / 60} min = half at ${w ? w.jog : '–'} → half walking at 5.5</span>`; })()}</p>
        <p class="small muted" style="margin:6px 0 0">마지막 구간 뒤 젖산 목표 ${W.lo.toFixed(1)}–${W.hi.toFixed(1)}${W.own ? ' (본인 MLSS 젖산 ± 0.5)' : ' (본인 MLSS 젖산이 설정되기 전의 기본값)'} · MLSS 검증은 「LT1 검증 (두 랩)」의 MLSS 변형(랩 2 = 20분): 상승 ≤ 0.5 → 통과(같은 속도 통과 2회면 +0.3), 0.5–1.0 → 유지, > 1.0 → −0.4. <span class="en">Lactate target after the last rep ${W.lo.toFixed(1)}–${W.hi.toFixed(1)}${W.own ? ' (your MLSS lactate ± 0.5)' : ' (the default until your MLSS lactate is set)'} · the MLSS check = the two-lap mode's MLSS variant (lap 2 = 20 min): rise ≤ 0.5 → pass (two passes at the same speed → +0.3), 0.5–1.0 → hold, > 1.0 → −0.4.</span></p>`;
      html += `<div class="card" style="margin-top:10px">${descBlock('setup-lt2', `<h3>${t('mode_lt2')}${vo2 ? ' — VO₂max 4×4' : ' — 사다리 / ladder'}</h3>${T ? `<p class="inline" style="margin:0">${t('target')}: <b class="mono">${T.hrLo}–${T.hrHi} bpm</b>${Number.isFinite(T.speedHi) ? ` · <b class="mono">${n1(T.speedHi)} km/h</b>` : ''}${vo2 && !Number.isFinite(T.speedHi) ? ' · <span class="small">3 km 페이스를 설정 → 역치에 적으세요 / enter the 3-km pace in Settings → thresholds</span>' : ''}</p>` : `<p class="muted">${t('no_zones')}</p>`}`, lt2Desc)}${wuLineHtml()}
        <div class="grid3"><label class="field">반복 / reps<input type="number" id="lt2-reps" value="${st.reps}" min="1" max="10"></label><label class="field">운동 / work (min)<input type="number" id="lt2-work" value="${st.workSec / 60}" min="1" max="60"></label><label class="field">회복 / rest (min)<input type="number" id="lt2-rest" value="${st.restSec / 60}" min="0" max="15"></label></div>
        <div class="grid2" style="margin-top:8px"><label class="field">${t('warmup')} (min)<input type="number" id="lt2-wu" value="${st.warmupSec / 60}" min="0" max="30"></label><label class="field">쿨다운 / cool-down (min)<input type="number" id="lt2-cd" value="${st.cooldownSec / 60}" min="0" max="30"></label></div>
        <div class="grid2" style="margin-top:8px"><label class="field">인터벌 속도 km/h<input type="number" id="sess-speed" step="0.1" value="${L.speed ?? (T && Number.isFinite(T.speedHi) ? T.speedHi : '')}"></label><label class="field">경사 %<input type="number" id="sess-incline" step="0.5" value="${L.incline ?? A.settings.protocol.incline}"></label></div>${surfaceSel()}</div>`;
    } else html += `<div class="card" style="margin-top:10px">${descBlock('setup-free', `<h3>${t('mode_free')}</h3>`, `<p class="small muted" style="margin:0">${A1() ? '심박·α1만' : '심박만'} 모니터링합니다. 랩 버튼으로 구간을 표시할 수 있습니다.<span class="en">Monitors ${A1() ? 'HR and α1' : 'HR'} only; use Lap to mark segments.</span></p><p class="small muted" style="margin:6px 0 0">MLSS 검증: 10,30 · LT1 검증 35분: 35 · 비우면 알림 없음 <span class="en">MLSS check: 10,30 · 35-min LT1 check: 35 · empty = no cues</span></p>`)}<div class="grid2"><label class="field">러닝머신 km/h<input type="number" id="sess-speed" step="0.1" value="${L.speed ?? ''}"></label><label class="field">경사 %<input type="number" id="sess-incline" step="0.5" value="${L.incline ?? A.settings.protocol.incline}"></label></div><label class="field" style="margin-top:8px">채혈 알림 (분, 쉼표 구분 · 30초 전 예고 + 정각 음성) <span class="en">Lactate cue minutes (comma-separated; 30-s warning + voice on the minute)</span><input type="text" id="free-cues" inputmode="numeric" placeholder="예: 10,30" value="${esc(L.cuesText ?? '10,30')}"></label>${surfaceSel()}</div>`;
    // source
    html += `<h2>센서 <span class="en">Sensor</span></h2><div class="segment" id="src-seg"><button class="${L.sourceKind === 'ble' ? 'active' : ''}" data-src="ble" ${bleOk ? '' : 'disabled'}>${t('source_ble')}</button><button class="${L.sourceKind === 'demo' ? 'active' : ''}" data-src="demo">${t('source_demo')}</button><button class="${L.sourceKind === 'replay' ? 'active' : ''}" data-src="replay">${t('source_replay')}</button><button class="${L.sourceKind === 'nostrap' ? 'active' : ''}" data-src="nostrap">${t('source_nostrap')}</button></div>${L.sourceKind === 'nostrap' ? `<p class="small muted" style="margin-top:6px">스트랩 없이 실제로 달릴 때: 시계·단계·음성·젖산 입력은 그대로, 심박·α1은 비어 있고 존 판정은 없습니다. 판정·주간 검사·곡선은 젖산만으로. <span class="en">Running for real without the strap: clock, phases, cues and lactate entries as usual; heart rate and α1 stay empty and no zone is judged. Verdict, weekly check and curve use lactate only.</span></p>` : ''}`;
    html += `<p class="small" id="ble-diag" style="margin-top:6px"></p>`;
    if (L.sourceKind === 'demo') html += `<div class="card" style="margin-top:10px"><label class="field">${t('demo_speed')}<select id="demo-speed">${[1, 5, 10, 30, 60].map(s => `<option value="${s}" ${L.demoSpeed === s ? 'selected' : ''}>×${s}</option>`).join('')}</select></label><p class="small muted">가상 스트랩이 프로토콜을 따라 심박·α1을 만들어냅니다. 젖산은 직접 입력하세요(연습용 값: 1.0 → 1.2 → 1.5 → 2.0 → 3.0 → 4.5 → 7).<span class="en">A virtual strap follows the protocol; type lactate values yourself (practice: 1.0 → 1.2 → 1.5 → 2.0 → 3.0 → 4.5 → 7).</span></p></div>`;
    if (L.sourceKind === 'replay') html += `<div class="card" style="margin-top:10px"><div class="row"><button data-action="pick-replay">${t('replay_pick')}</button><span class="small muted">${L.replay ? esc(L.replay.filename) + ` · ${L.replay.rr.length} RR · ${fmtClock(L.replay.durationSec)}` : 'FatMaxxer rr.csv'}</span></div><label class="field" style="margin-top:8px">${t('demo_speed')}<select id="replay-speed">${[1, 5, 10, 30, 60].map(s => `<option value="${s}" ${L.replaySpeed === s ? 'selected' : ''}>×${s}</option>`).join('')}</select></label></div>`;
    const connected = A.source && (A.source.status === 'connected');
    html += `<div class="grid2" style="margin-top:14px"><button class="big ${connected ? '' : 'primary'}" data-action="connect" ${connected ? 'disabled' : ''}>${connected ? t('connected') : t('connect')}</button><button class="big ${connected ? 'primary' : ''}" data-action="start" ${connected ? '' : 'disabled'}>${t('start')}</button></div>
      ${A.lastBleError ? `<p class="notice warn small" style="margin-top:10px">${esc(A.lastBleError)}</p>` : ''}
      <div class="stats" style="margin-top:10px"><div>${t('hr')}<b id="pre-hr">${v.hr ?? '–'}</b></div><div>RR<b id="pre-rr">${v.rrSeen ?? 0}</b></div><div>${t('battery')}<b id="pre-batt">${A.source?.battery != null ? A.source.battery + '%' : '–'}</b></div><div>상태<b id="pre-status" style="font-size:0.8rem">${esc(v.source.status)}</b></div></div>`;
    return html;
  }
  // running / finished layout (updated in place)
  html += `<div class="live-big${A1() ? '' : ' single'}">
      <div class="metric hr"><div class="lbl"><span>${tx('hr')}</span><span id="lv-contact"></span></div><div class="val" id="lv-hr">–</div><div class="sub" id="lv-hr-sub"></div></div>
      ${A1() ? `<div class="metric a1 na" id="lv-a1-box"><div class="lbl"><span>DFA α1</span><span id="lv-art"></span></div><div class="val" id="lv-a1">–</div><div class="sub" id="lv-a1-sub">${tx('waiting')}</div></div>` : ''}
    </div>
    <div class="zone-banner rest" id="lv-zone" style="margin-top:10px"><span class="dot"></span><span id="lv-zone-text">–</span></div>
    <div class="phase" id="lv-phase" style="margin-top:10px"><div class="row between"><div class="small muted" id="lv-phase-lbl">–</div><div class="small muted mono" id="lv-elapsed">0:00</div></div><div class="row between"><div class="big" id="lv-phase-time">–</div><div id="lv-phase-info" class="small" style="text-align:right"></div></div><div class="progress"><div id="lv-prog"></div></div></div>
    <div class="controls" style="margin-top:10px"><button id="lv-lap" data-action="lap">${t('next_stage')}</button><button id="lv-pause" data-action="pause">${t('pause')}</button><button class="danger" data-action="stop">${t('stop')}</button></div>
    <div class="stats" style="margin-top:10px">${A1() ? `<div>${tx('samples')}<b id="lv-n">0</b></div>` : `<div>${tx('artifacts')}<b id="lv-art-s">–</b></div>`}<div>RMSSD<b id="lv-rmssd">–</b></div><div>${tx('battery')}<b id="lv-batt">${A.source?.battery != null ? A.source.battery + '%' : '–'}</b></div><div>${tx('in_zone')}<b id="lv-tiz">–</b></div></div>
    <div class="card" style="margin-top:10px;padding:8px 6px 4px"><div class="chart" id="lv-chart"></div></div>
    <div class="card" style="margin-top:10px" id="lv-stages"></div>
    <div class="row" style="margin-top:10px"><button class="compact ghost" data-action="lactate">${t('lactate_entry')}</button><button class="compact ghost" id="lv-mute" data-action="mute">🔊</button></div>${v.mode === 'test' ? '' : v.mode === 'verify' ? '<p class="small muted" id="lv-lac-hint" style="margin-top:6px">「정지」 음성 뒤 벨트를 멈추고 서서 기다리세요. 30초 뒤 「채혈하세요」에 채혈·입력(랩 1 값), 60–90초 안에 벨트를 올리고 「2랩 시작」. 랩 2 끝에도 같은 방법으로 종료 값을 입력한 뒤 종료. <span class="en">At "Stop" stop the belt and stand still. At "sample" (30 s) take the sample and enter it (the lap-1 value); belt back up and "Start lap 2" within 60–90 s. After lap 2 enter the end value the same way, then Finish.</span></p>' : '<p class="small muted" id="lv-lac-hint" style="margin-top:6px">젖산 값은 멈춘 직후, 쿨다운 전에 입력하세요 — 입력한 시각으로 달리기가 끝난 시점을 찾습니다. <span class="en">Type the lactate value right after you stop, before any cool-down: its time is used to find where the run ended.</span></p>'}`;
  return html;
}
function mountLive() {
  const eng = ensureEngine(); const v = eng.view();
  if (v.state === 'running') { const el = $('#lv-chart'); if (el) { A.live.chart = liveChart(el, { getBand: () => eng.targets ? [eng.targets.hrLo, eng.targets.hrHi] : null, alpha: A1() }); A.charts.push(A.live.chart); } updateLive(v); }
  const diag = $('#ble-diag'); if (diag) bleDiagnostics().then(txt => { diag.innerHTML = txt; });
  const ms = $('#mode-seg'); if (ms) ms.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { const m = b.dataset.mode; if (m !== A.live.mode || m === 'verify') A.live.speed = null; A.live.mode = m; if (m === 'verify') A.live.laps = { ...A.settings.laps, ...(A.live.purpose === 'mlss' ? { lap2Sec: 1200 } : {}) }; render(); } }); // (the check's speed comes from the band finder each week, not from the last session)
  const ps = $('#pause-seg'); if (ps) ps.addEventListener('click', async e => { const b = e.target.closest('button'); if (!b) return; A.settings.protocol.pauseSec = +b.dataset.pause; await saveSettings(); if (A.engine) A.engine.settings = A.settings; toast(+b.dataset.pause ? '매 단계 채혈 30초 / 30-s pause each stage' : '연속 테스트 · 채혈 없음 / continuous, no sampling'); render(); });
  const ss = $('#src-seg'); if (ss) ss.addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) { A.live.sourceKind = b.dataset.src; if (A.source && A.source.kind !== b.dataset.src) { A.source.disconnect(); A.source = null; } render(); if (b.dataset.src === 'nostrap' && !A.source) connectSource(); } }); // (no strap: nothing to pair — ready at once)
  const ds = $('#demo-speed'); if (ds) ds.onchange = () => { A.live.demoSpeed = +ds.value; };
  const rs = $('#replay-speed'); if (rs) rs.onchange = () => { A.live.replaySpeed = +rs.value; };
  const lm = $('#lt1-min'); if (lm) lm.onchange = () => { A.live.minutes = +lm.value; };
  const pg = $('#purpose-seg'); if (pg) pg.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; A.live.purpose = b.dataset.purpose; A.live.laps = { ...(A.live.laps || A.settings.laps), lap2Sec: b.dataset.purpose === 'mlss' ? 1200 : 1800 }; A.live.speed = null; render(); });
  const wuRefresh = () => { const el = $('#wu-line'); if (el) { const h = setupWarmupHtml(zonesObj()); el.innerHTML = h; el.hidden = !h; } }; // the warm-up line follows the warm-up minutes as they are typed (v1.1.26)
  for (const [id, key] of [['lap-wu', 'warmupSec'], ['lap-1', 'lap1Sec'], ['lap-2', 'lap2Sec']]) { const el = document.getElementById(id); if (el) { el.onchange = () => { A.live.laps[key] = Math.max(0, +el.value) * 60; wuRefresh(); }; if (key === 'warmupSec') el.oninput = el.onchange; } }
  const sp = $('#sess-speed'); if (sp) sp.onchange = () => { A.live.speed = sp.value === '' ? null : +sp.value; };
  const cu = $('#free-cues'); if (cu) cu.onchange = () => { A.live.cuesText = cu.value; };
  const si = $('#sess-incline'); if (si) si.onchange = () => { A.live.incline = si.value === '' ? null : +si.value; };
  const ssf = $('#sess-surface'); if (ssf) ssf.onchange = () => { const sp = $('#sess-speed'); if (sp) A.live.speed = sp.value === '' ? null : +sp.value; A.live.surface = ssf.value; render(); };
  for (const [id, key, mul] of [['lt2-reps', 'reps', 1], ['lt2-work', 'workSec', 60], ['lt2-rest', 'restSec', 60], ['lt2-wu', 'warmupSec', 60], ['lt2-cd', 'cooldownSec', 60]]) { const el = document.getElementById(id); if (el) { el.onchange = () => { A.live.lt2[key] = +el.value * mul; wuRefresh(); }; if (key === 'warmupSec') el.oninput = el.onchange; } }
}
let liveStageSig = '';
function updateLive(v) {
  updateConnChip(v);
  // Lactate cues run on the session clock whichever tab of the app is showing (they used to wait until the Session tab was open again).
  if (v.state === 'running' && v.mode === 'free' && A.live.cueSecs?.length && !v.paused) { for (const c of A.live.cueSecs) { const kW = c + ':w', kC = c + ':c'; if (v.elapsedSec >= c - 30 && v.elapsedSec < c && !A.live.cueFired.has(kW)) { A.live.cueFired.add(kW); A.alerts?.speak(VOICE.stage_warn(30), { key: 'cue-w' }); } if (v.elapsedSec >= c && !A.live.cueFired.has(kC)) { A.live.cueFired.add(kC); A.live.cueFired.add(kW); A.alerts?.cue(VOICE.free_cue(Math.round(c / 60)), { beep: 'triple', vib: [300, 100, 300, 100, 300] }); toast(`채혈 시간 / lactate sample now (${Math.round(c / 60)} min)`, 8000); } } }
  if (A.view !== 'live') return;
  if (v.state !== 'running') { const h = $('#pre-hr'); if (h) { h.textContent = v.hr ?? '–'; $('#pre-rr').textContent = v.rrSeen ?? 0; $('#pre-status').textContent = v.source.status; if (A.source?.battery != null) $('#pre-batt').textContent = A.source.battery + '%'; } if (A.source && A.source.status === 'connected' && $('[data-action=start]')?.disabled) render(); return; }
  if (!$('#lv-hr')) return;
  $('#lv-hr').textContent = v.hr ?? '–'; $('#lv-contact').textContent = v.contact === false ? '⚠ 접촉 없음' : '';
  const f = v.feature; const box = $('#lv-a1-box');
  if (box && f && Number.isFinite(f.alpha1)) { $('#lv-a1').textContent = f.alpha1.toFixed(2); box.className = 'metric a1 ' + (f.alpha1 >= 0.75 ? 'ok' : f.alpha1 >= 0.5 ? 'mid' : 'low'); $('#lv-a1-sub').textContent = f.alpha1 >= 0.75 ? 'LT1 아래 / below LT1' : f.alpha1 >= 0.5 ? 'LT1–LT2' : 'LT2 위 / above LT2'; }
  else if (box) { $('#lv-a1').textContent = '–'; box.className = 'metric a1 na'; $('#lv-a1-sub').textContent = tx('waiting') + (f ? ` (${f.samples})` : ''); }
  if (f && box) { $('#lv-art').textContent = `${tx('artifacts')} ${f.artifactPct.toFixed(1)}%`; $('#lv-art').style.color = f.artifactPct >= ALPHA_ARTIFACT_MAX ? 'var(--bad)' : ''; $('#lv-n').textContent = f.samples; } // (≥ 3 %: the α1 of this window is not used)
  else if (f) { const ar = $('#lv-art-s'); if (ar) { ar.textContent = `${f.artifactPct.toFixed(1)}%`; ar.style.color = f.artifactPct > 5 ? 'var(--bad)' : ''; } }
  if (f) { $('#lv-rmssd').textContent = Number.isFinite(f.rmssd) ? f.rmssd.toFixed(0) : '–'; }
  if (A.source?.battery != null) $('#lv-batt').textContent = A.source.battery + '%';
  $('#lv-elapsed').textContent = fmtClock(v.elapsedSec);
  // zone banner
  const zb = $('#lv-zone'); const T = v.targets; const zt = $('#lv-zone-text'); const wu = speedNow(v);
  if (!wu && zt.dataset.sig) delete zt.dataset.sig;
  if (wu) { zb.className = 'zone-banner warm'; if (zt.dataset.sig !== wu.sig) { zt.innerHTML = wu.html; zt.dataset.sig = wu.sig; } } // a phase with a speed to set and no zone to judge (warm-up, recovery, cool-down, the LT1 session's minutes 5–10): that speed, large (v1.1.26)
  else if (v.mode === 'verify') { zb.className = 'zone-banner ' + (v.phase === 'work' ? 'in' : 'rest'); const sp = A.engine?.meta?.speed; $('#lv-zone-text').textContent = v.phase === 'work' ? `${tx('lap' + v.rep)}${Number.isFinite(sp) ? ` · ${n1(sp)} km/h` : ''} · ${v.rep === 1 ? '10분 값 / 10-min value' : '30분 값 / end value'}` : v.phase === 'gap' ? '간격 — 서서 대기 / gap — stand still' : v.phase === 'done' ? '완료 — 정지 후 채혈 / done — sample after the stop' : tx('warmup'); }
  else if (v.mode === 'test' || v.mode === 'free' || !T) { zb.className = 'zone-banner rest'; $('#lv-zone-text').textContent = v.mode === 'test' ? (v.stopAdvised ? tx('stop_reached') : `${tx('stage')} ${v.stage ? v.stage.idx : '–'}`) : tx('mode_free'); if (v.stopAdvised) zb.className = 'zone-banner above'; }
  else if (v.mode === 'lt1' && (v.elapsedSec || 0) < (T.judgeFromSec ?? 600)) { zb.className = 'zone-banner rest'; $('#lv-zone-text').textContent = (v.elapsedSec || 0) < LT1_WARMUP_SEC ? '워밍업 — 판정은 10:00부터 / warm-up — judged from 10:00' : '본 속도 — 판정은 10:00부터 / main speed — judged from 10:00'; }
  else { const z = v.zone; zb.className = 'zone-banner ' + (z === 'in' || z === 'drift' ? 'in' : z === 'above' ? 'above' : z === 'below' ? 'below' : 'rest'); $('#lv-zone-text').textContent = (z === 'in' ? tx('in_zone') : z === 'drift' ? `드리프트 허용 (천장 ${T.ceilHr}) / drift allowed (ceiling ${T.ceilHr})` : z === 'above' ? (Number.isFinite(T.ceilHr) && v.elapsedSec >= (T.lateFromSec ?? 1200) ? `천장 ${T.ceilHr} 초과 — 속도 −0.3 / above the ceiling ${T.ceilHr} — speed −0.3` : tx('above_zone')) : z === 'below' ? tx('below_zone') : ({ warmup: '워밍업 / warm-up', rest: '회복 / recovery', cooldown: '쿨다운 / cool-down', done: '완료 / done' }[v.phase] || v.phase)) + (v.mode === 'lt2' && v.phase !== 'work' ? '' : ` · ${tx('target')} ${T.hrLo}–${T.hrHi}`); }
  if (v.tiz && v.tiz.totalSec) $('#lv-tiz').textContent = Math.round(100 * v.tiz.inSec / v.tiz.totalSec) + '%';
  // phase card
  const ph = $('#lv-phase'); ph.className = 'phase' + (v.phase === 'pause' || v.phase === 'rest' ? ' pause' : '');
  let lbl = v.phase, info = ''; const wN = warmupNums(zonesObj()); // (the two-lap warm-up's heart-rate ceiling)
  const wuPlan = v.phase === 'warmup' ? liveWarmupPlan(v) : v.mode === 'lt2' && v.phase === 'cooldown' ? cooldownSteps({ W: A.engine?.meta?.warmup, cooldownSec: A.engine?.intervals?.cooldownSec }) : null;
  const wuTxt = wuPlan && wuPlan.steps.length > 1 ? warmupText(wuPlan) : ''; // a warm-up / cool-down of several steps, whole, in one line (v1.1.26: from the step plans, so the ladder's times are the engine's); a single speed is in the banner and is not repeated here
  const mainSp = liveMainSpeed(v);
  if (v.mode === 'test') { lbl = v.phase === 'warmup' ? `${tx('warmup')}${wuTxt ? ` · ${wuTxt}` : ''}` : v.phase === 'work' ? `${tx('stage')} ${v.stage?.idx} · ${v.stage?.speed} km/h · ${v.stage?.incline}%` : v.phase === 'pause' ? `${tx('sampling')} · ${tx('stage')} ${v.stage?.idx}` : v.phase === 'done' ? '완료 / done' : v.phase; info = v.nextStage ? `${tx('next_stage')}: ${v.nextStage.speed} km/h` : ''; }
  else if (v.mode === 'lt2') { lbl = v.phase === 'work' ? `인터벌 ${v.rep}/${v.reps} / interval` : v.phase === 'rest' ? `회복 ${v.rep}/${v.reps} / recovery` : v.phase === 'warmup' ? `${tx('warmup')}${wuTxt ? ` · ${wuTxt}` : ''}` : v.phase === 'cooldown' ? `쿨다운${wuTxt ? ` · ${wuTxt}` : ''} / cool-down` : v.phase; }
  else if (v.mode === 'lt1') { const el = v.elapsedSec || 0; if (el < LT1_WARMUP_SEC) lbl = '워밍업 0–5분 / warm-up'; else if (el < (T?.judgeFromSec ?? 600)) { lbl = '본 구간 / main part'; info = T ? `${tx('target')} ${T.hrLo}–${T.hrHi} bpm` : ''; } else { lbl = T ? `${tx('target')} ${T.hrLo}–${T.hrHi} bpm` : tx('mode_lt1'); info = mainSp ? `${mainSp} km/h` : ''; } } // (the speeds of the first 10 minutes are in the banner)
  else if (v.mode === 'verify') { const Lp = v.laps || {}; const wuHr = v.phase === 'warmup' && wN && A.engine?.meta?.purpose !== 'mlss' ? lx(`${fmtClock(Lp.warmupSec)}에 심박 < ${wN.z1}`, `HR < ${wN.z1} at ${fmtClock(Lp.warmupSec)}`) : ''; // the LT1 check's warm-up: under the Z1 ceiling at its end
    lbl = v.phase === 'warmup' ? (wuTxt ? `${tx('warmup')} · ${wuTxt}` : '워밍업 / warm-up') : v.phase === 'work' ? `${tx('lap' + v.rep)} · ${fmtClock(v.rep === 1 ? Lp.lap1Sec : Lp.lap2Sec)}` : v.phase === 'gap' ? `간격 / gap · 목표 60–90초, 상한 3분` : v.phase === 'done' ? '완료 / done · 정지 후 30–45초에 채혈' : v.phase; info = v.phase === 'gap' || v.phase === 'done' ? (v.phaseElapsed < (Lp.sampleAtSec ?? 30) ? `채혈까지 ${fmtClock((Lp.sampleAtSec ?? 30) - v.phaseElapsed)} / sample in` : v.phaseElapsed <= 45 ? '지금 채혈 / sample now' : v.phase === 'gap' ? (v.phaseElapsed > (Lp.gapCapSec ?? 180) ? '3분 초과 — 엄격 규칙 / strict rule' : '벨트 올리고 「2랩 시작」 / belt up, Start lap 2') : '입력 후 종료 / enter, then Finish') : v.phase === 'work' && v.rep === 2 ? '끝나면 정지·채혈·입력 / at the end: stop, sample, enter' : wuHr; }
  else lbl = tx('mode_free');
  $('#lv-phase-lbl').textContent = (v.paused ? '⏸ ' : '') + lbl; $('#lv-phase-info').textContent = info;
  $('#lv-phase-time').textContent = v.phaseLeft != null ? (v.phaseLeft > 0 || v.phaseDur == null ? fmtClock(v.phaseLeft) : '+' + fmtClock(v.phaseElapsed - v.phaseDur)) : fmtClock(v.phaseElapsed);
  $('#lv-prog').style.width = v.phaseDur ? Math.min(100, 100 * v.phaseElapsed / v.phaseDur) + '%' : '0%';
  const lap = $('#lv-lap'); lap.innerHTML = v.mode === 'test' ? (v.phase === 'pause' ? t('next_stage') : v.phase === 'warmup' ? '1단계 시작<span class="en">Start stage 1</span>' : '단계 종료<span class="en">End stage</span>') : v.mode === 'lt2' ? '다음 구간<span class="en">Next block</span>' : v.mode === 'verify' ? (v.phase === 'warmup' ? t('start_lap1') : v.phase === 'work' ? t('end_lap') : v.phase === 'gap' ? t('start_lap2') : '—') : t('lap'); lap.disabled = v.mode === 'verify' && v.phase === 'done';
  $('#lv-pause').innerHTML = v.paused ? t('resume') : t('pause');
  // stage table (test)
  if (v.mode === 'test') { const sig = JSON.stringify(v.stages.map(s => [s.idx, s.lactate, s.rpe, !!s.tEnd])); if (sig !== liveStageSig) { liveStageSig = sig; $('#lv-stages').innerHTML = `<div class="table-wrap"><table><thead><tr><th>#</th><th>km/h</th><th>%</th><th>HR</th>${A1() ? '<th>α1</th>' : ''}<th>La</th><th>RPE</th></tr></thead><tbody>${v.stages.map(s => { const fs = A.engine.features.filter(f => f.t >= (s.tEnd || A.engine.now()) - 60000 && f.t <= (s.tEnd || Infinity) && f.stage === s.idx); const a = fs.filter(f => Number.isFinite(f.alpha1)).map(f => f.alpha1); const hr = fs.map(f => f.hrInst).filter(x => x > 0); return `<tr><td>${s.idx}</td><td>${s.speed}</td><td>${s.incline}</td><td>${hr.length ? n0(hr.reduce((x, y) => x + y, 0) / hr.length) : '–'}</td>${A1() ? `<td>${a.length ? n2(a.reduce((x, y) => x + y, 0) / a.length) : '–'}</td>` : ''}<td>${s.lactate ?? '–'}</td><td>${s.rpe ?? '–'}</td></tr>`; }).join('')}</tbody></table></div>`; } }
  else $('#lv-stages').style.display = 'none';
  // chart
  if (A.live.chart && A.engine) { const now = A.engine.now(); const t0 = A.engine.startedAt; const feats = A.engine.features.filter(x => x.t >= now - 15 * 60000); const hrs = A.engine.hrLive.filter(x => x[0] >= now - 15 * 60000); const step = Math.max(1, Math.floor(hrs.length / 450)); const hrPts = hrs.filter((_, i) => i % step === 0); const ts = hrPts.map(p => (p[0] - t0) / 1000); const a1 = ts.map(() => null); let j = 0; for (let i = 0; i < ts.length; i++) { while (j < feats.length - 1 && (feats[j + 1].t - t0) / 1000 <= ts[i]) j++; if (feats[j] && Math.abs((feats[j].t - t0) / 1000 - ts[i]) <= 6 && Number.isFinite(feats[j].alpha1)) a1[i] = feats[j].alpha1; } if (ts.length > 1) A.live.chart.setData(ts, hrPts.map(p => p[1] || null), a1); }
}
function updateConnChip(v) {
  const st = A.source ? A.source.status : 'idle'; const chip = $('#conn-chip'); const txt = $('#conn-text'); if (!chip) return;
  chip.className = 'pill ' + (st === 'connected' ? 'ok' : st === 'reconnecting' || st === 'connecting' || st === 'requesting' ? 'warn' : '');
  chip.querySelector('.dot').className = 'dot' + (st === 'connected' ? ' pulse' : '');
  const hr = v?.hr ?? A.engine?.lastHr; txt.textContent = st === 'connected' ? `${A.source.name || 'H10'} ${hr ? hr + ' bpm' : ''}` : st === 'idle' ? 'H10' : tx(st) !== st ? tx(st) : st;
}
function onEngineEvent(e) {
  if (e.type === 'lactate-prompt') openLactateModal(e.stage, e.lap);
  if (e.type === 'finished' && e.reason !== 'user') { (async () => { if (A.source && A.source.kind !== 'ble') { await A.source.disconnect(); A.source = null; } await finalizeSession(e.session); })(); }
}
function openLactateModal(stageIdx, lap = null) {
  if ($('#lac-modal')) return;
  let val = '';
  const lapTxt = lap === 1 ? ` — ${tx('lap1')} (간격 / gap)` : lap === 2 ? ` — ${tx('lap2')} 종료 / end` : '';
  modal(`<div id="lac-modal"><h3>${t('lactate_entry')}${stageIdx != null ? ` — ${tx('stage')} ${stageIdx}` : lapTxt}</h3><div class="lac-display" id="lac-disp">&nbsp;</div><div class="keypad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map(k => `<button data-k="${k}">${k}</button>`).join('')}</div><div class="grid2"><button class="ghost" data-x="skip">${t('skip')}</button><button class="primary" data-x="save">${t('save')}</button></div><p class="small muted" style="margin-top:8px">${t('stop_criteria', { la: A.settings.protocol.stopLactate, rpe: A.settings.protocol.stopRpe })}</p></div>`, (m, close) => {
    const disp = m.querySelector('#lac-disp');
    m.querySelector('.keypad').addEventListener('click', ev => { const b = ev.target.closest('button'); if (!b) return; const k = b.dataset.k; if (k === '⌫') val = val.slice(0, -1); else if (k === '.') { if (!val.includes('.')) val = (val || '0') + '.'; } else if (val.replace('.', '').length < 3) val += k; disp.textContent = val || ' '; });
    m.querySelector('[data-x=skip]').onclick = () => { A.engine.enterLactate(null, stageIdx); close(); };
    m.querySelector('[data-x=save]').onclick = () => { const n = parseFloat(val); if (!Number.isFinite(n) || n < 0.3 || n > 25) { toast('0.3–25 mmol/L'); return; } A.engine.enterLactate(n, stageIdx); close(); };
  });
}
async function bleDiagnostics() {
  const ua = navigator.userAgent; const samsung = /SamsungBrowser/i.test(ua); const chrome = /Chrome\/(\d+)/.exec(ua);
  if (!window.isSecureContext) return `<span style="color:var(--bad)">HTTPS가 아니라 블루투스를 쓸 수 없습니다. / Not a secure (HTTPS) page.</span>`;
  if (!navigator.bluetooth) return `<span style="color:var(--bad)">이 브라우저는 Web Bluetooth를 지원하지 않습니다${samsung ? ' (삼성 인터넷)' : ''}. 같은 주소를 <b>Chrome</b>으로 여세요.<span class="en">This browser has no Web Bluetooth${samsung ? ' (Samsung Internet)' : ''} — open the same address in <b>Chrome</b>.</span></span>`;
  let avail = null; try { avail = await navigator.bluetooth.getAvailability(); } catch (e) { avail = null; }
  if (avail === false) return `<span style="color:var(--warn)">폰의 블루투스가 꺼져 있습니다. 켠 뒤 다시 시도하세요. / Phone Bluetooth is off.</span>`;
  return `<span class="muted">Web Bluetooth 사용 가능${chrome ? ' · Chrome ' + chrome[1] : ''} · H10은 <b>착용하고 전극을 적셔야</b> 목록에 나타납니다. / Web Bluetooth OK — the H10 advertises only when worn with wet electrodes.</span>`;
}
function bleErrorHint(e) {
  const n = e && e.name;
  if (n === 'NotFoundError') return '목록에 H10이 없거나 선택을 취소했습니다. 스트랩을 착용하고 전극을 적신 뒤(H10은 착용해야 켜짐), FatMaxxer·Polar Flow·Polar Beat·Train.Red 등 다른 앱의 H10 연결을 끊고 다시 시도하세요. / H10 not listed or cancelled: wear the strap with wet electrodes and disconnect it from other apps (FatMaxxer, Polar Flow/Beat, Train.Red), then retry.';
  if (n === 'SecurityError') return '블루투스 권한이 차단되었습니다. 폰 설정 → 애플리케이션 → Chrome → 권한 → 근처 기기(및 위치) 허용, Chrome 주소창 자물쇠 → 권한 → 블루투스 허용 후 다시 시도. / Bluetooth permission blocked: Phone Settings → Apps → Chrome → Permissions → Nearby devices (and Location) → Allow; then lock icon → Permissions → Bluetooth → Allow.';
  if (n === 'NetworkError') return '연결은 됐지만 바로 끊겼습니다. H10을 다시 착용하고(전극 적시기), 다른 앱 연결을 끊은 뒤 재시도하세요. / Connected then dropped: re-seat the strap, disconnect other apps, retry.';
  if (n === 'NotSupportedError') return '이 기기/브라우저는 Web Bluetooth를 지원하지 않습니다. Android Chrome에서 여세요. / Web Bluetooth not supported here — use Android Chrome.';
  return (e && e.message) || String(e);
}
async function connectSource() {
  if (A.connectBusy) return; // a second tap while the first is still disconnecting the old sensor or connecting: one attempt at a time
  const L = A.live; ensureEngine(); A.alerts.unlock();
  A.lastBleError = null; // a new attempt: the hint from the previous failure must not stay on screen next to "Connected"
  let src = null;
  A.connectBusy = true; // set only here, directly before the try whose finally clears it (nothing above waits, so the guard still holds)
  try {
    if (A.source) { await A.source.disconnect(); A.source = null; }
    if (L.sourceKind === 'ble') { src = new HeartRateSource(); }
    else if (L.sourceKind === 'demo') { src = new DemoSource({ speed: L.demoSpeed }); src.profile = demoProfileForEngine(A.engine); }
    else if (L.sourceKind === 'nostrap') { src = new NoStrapSource(); }
    else { if (!L.replay) { toast(tx('replay_pick')); return; } src = new ReplaySource(L.replay.rr, { speed: L.replaySpeed, name: L.replay.filename }); }
    A.source = src; A.engine.setSource(src);
    src.on('status', () => { updateConnChip(); if (A.view === 'live' && A.engine.state !== 'running') render(); });
    src.on('battery', () => updateLive(A.engine.view()));
    await src.connect();
    if (A.source !== src) { src.disconnect(); return; } // replaced or switched off while it was connecting: it must not stay connected in the background
    A.lastBleError = null; toast(tx('connected'));
  } catch (e) { if (src && A.source !== src) return; console.error(e); A.source = null; A.lastBleError = `${e && e.name ? e.name + ': ' : ''}${bleErrorHint(e)}`; toast(`연결 실패 / Failed: ${e && e.name ? e.name : ''}`, 3000); render(); }
  finally { A.connectBusy = false; }
}
/** v1.1.36: the place of the session to start — the checks and the step test always on the belt. */
function liveSurface() { const L = A.live; const el = $('#sess-surface'); if (el) L.surface = el.value; return L.mode === 'lt1' || L.mode === 'lt2' || L.mode === 'free' ? (SURFACES.includes(L.surface) ? L.surface : 'treadmill') : 'treadmill'; }
async function startSession() {
  const eng = ensureEngine(); const L = A.live; const z = zonesObj();
  if (!A.source || A.source.status !== 'connected') { toast(tx('disconnected')); return; }
  A.alerts.update(A.settings.alerts); A.alerts.unlock();
  const ins = assessRecent(await store.listSessions(), z, A.settings.zones.updatedAt);
  let targets = null;
  if (L.mode === 'lt1') { if (!z) { toast(tx('no_zones')); return; } targets = sessionTargets(z, 'lt1', { minutes: L.minutes, lt1Adjust: ins.lt1Adjust }); }
  if (L.mode === 'lt2') { if (!z) { toast(tx('no_zones')); return; } if (!L.lt2) L.lt2 = lt2Structure(planWeek()); targets = L.lt2.kind === 'vo2' ? sessionTargets(z, 'vo2') : sessionTargets(z, 'lt2', { speedOffset: L.lt2.speedOffset || 0 }); }
  eng.settings = A.settings; // (a restore or "delete all" may have replaced the object since the engine was created)
  eng.reset(); if (eng.source !== A.source) eng.setSource(A.source);
  const spEl = $('#sess-speed'), siEl = $('#sess-incline'); if (spEl) L.speed = spEl.value === '' ? null : +spEl.value; if (siEl) L.incline = siEl.value === '' ? null : +siEl.value;
  if (L.mode === 'verify' && !Number.isFinite(L.speed)) { toast('검사 속도를 입력하세요 / enter the test speed', 3000); return; } // (the verdict and the curve need the speed)
  for (const [id, key] of [['lap-wu', 'warmupSec'], ['lap-1', 'lap1Sec'], ['lap-2', 'lap2Sec']]) { const el = document.getElementById(id); if (el && L.laps) L.laps[key] = Math.max(0, +el.value) * 60; }
  eng.configure({ mode: L.mode, protocol: A.settings.protocol, intervals: L.mode === 'lt2' ? L.lt2 : null, laps: L.mode === 'verify' ? { ...A.settings.laps, ...(L.laps || {}) } : null, targets, meta: { ...(L.mode === 'test' ? { stopHr: Math.round((effectiveMaxHr() || 220) * (A.settings.protocol.stopHrPct || 95) / 100) } : { speed: L.speed ?? null, incline: L.incline ?? A.settings.protocol.incline, surface: liveSurface(), ...(L.mode === 'verify' ? { purpose: L.purpose || 'lt1' } : {}) }), warmup: liveSurface() === 'treadmill' ? warmupMeta(z) : null } }); // v1.1.36: off the belt no speed cues (warm-up null)
  if (A.source.kind === 'demo') A.source.profile = demoProfileForEngine(eng);
  const cuEl = $('#free-cues'); if (cuEl) L.cuesText = cuEl.value;
  L.cueSecs = L.mode === 'free' ? String(L.cuesText ?? '').split(/[,\s]+/).map(x => parseFloat(x)).filter(x => Number.isFinite(x) && x > 0).map(x => Math.round(x * 60)) : []; L.cueFired = new Set();
  liveStageSig = ''; eng.start();
  const ok = await A.alerts.keepAwake(true); if (!ok) toast(tx('keep_awake_fail'), 4000);
  render(); window.scrollTo(0, 0); // the session screen opens at its top — heart rate, the banner (the warm-up speed), the clock — not where the Start button was (v1.1.26)
}
async function stopSession() {
  const eng = A.engine; if (!eng || eng.state !== 'running') return;
  confirmBox(t('confirm_stop'), async () => {
    const session = eng.stop('user');
    if (A.source && A.source.kind !== 'ble') { await A.source.disconnect(); A.source = null; }
    await finalizeSession(session);
  });
}
async function finalizeSession(session) {
  session.final = true;
  if (session.type === 'test') { const r = analyzeSession(session); session.result = resultFrom(r); }
  const m = sessionMetrics(session); session.metrics = m;
  await store.putSession(session); await refreshLists(); if (session.type === 'test') refreshTestLowest(); if (session.type === 'verify') { A.live.speed = null; try { A.bandFinder = bandFinder(await store.listSessions(), A.settings.zones); } catch (e) { console.error('band finder', e); } }
  if (A.engine) { A.engine.reset(); if (A.source && A.source.status === 'connected') A.engine.state = 'ready'; }
  toast(tx('session_saved') + ' · RPE(CR-10)를 입력하세요 / enter the session RPE', 4000);
  navigate('analysis', session.id);
}
function resultFrom(r) { const tri = r.tri; return { lt1Hr: tri.lt1?.hr ?? null, lt2Hr: tri.lt2?.hr ?? null, lt1Speed: tri.lt1?.speed ?? null, lt2Speed: tri.lt2?.speed ?? null, grade: `${tri.grade1}/${tri.grade2}`, source: [tri.lt1?.source, tri.lt2?.source].filter(Boolean).join('+') }; }

// ---------- ANALYSIS ----------
async function refreshLists() { A.sessions = await store.listSessionSummaries(); A.imports = await store.listImports(); refreshTestLowest(); }
async function renderAnalysisList() {
  await refreshLists();
  const tests = A.sessions.filter(s => s.type === 'test'); const others = A.sessions.filter(s => s.type !== 'test');
  let html = `<div class="row between"><h2 style="margin:0">${t('sessions')}</h2><div class="row"><button class="compact" data-action="import">${t('import_file')}</button></div></div>`;
  html += `<div class="file-drop small" style="margin-top:10px">Train.Red CSV/FIT · FatMaxxer rr.csv/features.csv · Garmin FIT · 백업 JSON<br><span class="muted">파일을 선택하면 종류를 자동 인식합니다 / File type is detected automatically</span></div>`;
  if (!A.sessions.length) html += `<div class="card" style="margin-top:10px"><p class="muted">${t('no_sessions')}</p></div>`;
  if (tests.length) { html += `<h2>${t('tests')}</h2><div class="card">` + tests.map(s => itemHtml(s)).join('') + '</div>'; }
  if (tests.filter(s => s.result && Number.isFinite(s.result.lt1Hr)).length >= 2) html += `<div class="card" style="margin-top:10px;padding:8px 6px 4px"><div class="chart" id="trend-chart"></div></div>`;
  if (others.length) { html += `<h2>${t('mode_lt1')} / ${t('mode_lt2')} / ${t('mode_free')}</h2><div class="card">` + others.map(s => itemHtml(s)).join('') + '</div>'; }
  // multi-day lactate curve from verification runs
  const md = multiDayCurve(await store.listSessions(), { days: 60 }); A.multiDay = md;
  const WHY = { 'off-belt': ['트랙·무동력 세션 — 속도가 일정하지 않아 곡선 점이 아님', 'a track / non-motorized session — its speed is not fixed, so it is no curve point'], 'durability': ['35분 넘게 달린 뒤의 값 = 지구력 판독(곡선 제외) — 20–35분 사이 중간 값(과 「중간 채혈 시각」)이 있으면 그 값이 점이 됩니다', 'taken after more than 35 min at speed = a durability reading (not a curve point) — a mid value taken 20–35 min in (with its minute) would be the point'], 'too-short': ['15분 미만 달리기 — 곡선에는 15–35분 값만', 'under 15 min of running — the curve takes 15–35-min values only'], 'long-no-mid': ['롱런: 20–35분 중간 값(과 그 시각) 없음 — 세션 카드에 중간 값과 「중간 채혈 시각」 입력', 'long run: no mid value taken 20–35 min in — enter it and its minute in the card'], 'no-speed': ['속도 없음 — 세션 카드에 속도 입력', 'no speed — enter it in the session'], 'unfinished': ['미완료 세션', 'unfinished session'], 'intervals': ['인터벌(반복 2회 이상)', 'intervals (2+ reps)'], 'no-end': ['종료 젖산 없음', 'no end value'] };
  const skipNote = md.skipped?.length ? `<div class="small" style="margin-top:8px;color:var(--warn)">곡선에서 빠진 세션 <span class="en">Left out of the curve</span>${md.skipped.map(k => `<div style="margin-top:4px"><span role="link" tabindex="0" style="text-decoration:underline;cursor:pointer" data-action="open-session" data-id="${k.id}">${fmtDate(k.date).slice(5, 10)}${Number.isFinite(k.x) ? ' ' + k.x + ' km/h' : ''}</span> — ${(WHY[k.why] || [k.why, k.why])[0]}<span class="en">${(WHY[k.why] || [k.why, k.why])[1]}</span></div>`).join('')}</div>` : '';
  if (md.points.length || md.skipped?.length) {
    html += `<h2>다일 젖산 곡선 <span class="en">Multi-day lactate curve</span></h2><div class="card"><p class="small muted">일정 속도 세션의 젖산을 모아 만든 곡선(최근 60일, 속도당 최신 1개, 데모 세션 제외). 젖산 = 두 랩 검증의 종료 값(랩 2, 20–35분) 또는 15–35분 정속 런의 종료 값; 심박 = 랩 1 5–10분, 단일 런은 8–13분(드리프트 전). 35분 넘게 달린 뒤의 값은 지구력 판독으로 제외. <span class="en">Lactate from constant-speed sessions (last 60 days, newest per speed, demo sessions excluded). Lactate = the end value of a two-lap check (lap 2, 20–35 min) or of a 15–35-min constant run; heart rate = lap-1 minutes 5–10, or minutes 8–13 of a single run (before the drift). Values from more than 35 min at speed are durability readings, left out.</span></p>
      <div class="table-wrap"><table><thead><tr><th>km/h</th><th>La</th><th>HR</th>${A1() ? '<th>α1</th>' : ''}<th>날짜</th></tr></thead><tbody>${md.points.map(p => `<tr><td>${p.x}</td><td>${p.la}${p.from === 'mid' ? `<span class="small muted"> (${p.atMin}′)</span>` : p.from === 'lap2' ? `<span class="small muted"> (랩 2 ${p.atMin}′${p.lap1 != null ? ` · 랩 1 ${p.lap1}` : ''})</span>` : ''}</td><td>${Number.isFinite(p.hr) ? n0(p.hr) : '?'}${p.unsure ? '<span class="small muted">*</span>' : ''}</td>${A1() ? `<td>${p.unsure || !Number.isFinite(p.alpha1) ? '?' : n2(p.alpha1)}</td>` : ''}<td>${fmtDate(p.date).slice(5, 10)}</td></tr>`).join('')}</tbody></table></div>${md.points.some(p => p.from === 'mid') ? '<p class="small muted" style="margin-top:6px">(30′) = 롱런: 종료 값 대신 그 시점의 중간 값을 씁니다(긴 시간에 따른 상승은 속도와 무관). <span class="en">(30′) = long run: the mid value at that minute is used instead of the end value (a rise from duration says nothing about speed).</span></p>' : ''}${md.points.some(p => p.unsure || !Number.isFinite(p.hr)) ? '<p class="small muted" style="margin-top:6px">* = 달리기 종료 시점이 불확실한 세션(젖산은 쓰고, 심박은 달리기 초반 창에서 읽음) · ? = 그 창의 심박이 없음 — 양옆 속도의 세션 사이에서만 보간합니다. 세션 화면의 검증 카드에서 종료 시각을 확정하세요.<span class="en">* = the end of that run is uncertain (its lactate is used; its heart rate comes from the early window of the run) · ? = no heart rate in that window — interpolated only between runs at speeds on either side. Confirm the end of the run in that session\'s verification card.</span></p>' : ''}`;
    if (md.analysis) { const L1 = md.analysis.lt1Primary, L2 = md.analysis.lt2Primary; html += `<div class="thr-card" style="margin-top:10px"><div class="box"><div class="small muted">LT1 (baseline+0.5)</div><div class="v">${n0(L1.hr)}<small> bpm</small></div><div class="small">${n1(L1.x)} km/h</div></div><div class="box"><div class="small muted">LT2 (ModDmax)</div><div class="v">${n0(L2.hr)}<small> bpm</small></div><div class="small">${n1(L2.x)} km/h</div></div></div><p class="small muted" style="margin-top:6px">${t('grade')} ${md.grade} · ${md.points.length}점${md.points.length < 5 ? ' — 5점 이상(젖산 범위 2 mmol/L 이상)이면 B등급' : ''}</p>${curveNoteHtml(md)}<button class="primary block" style="margin-top:8px" data-action="apply-multiday" ${md.trust?.apply ? '' : 'disabled'}>${t('apply_zones')}</button>`; }
    else html += `<p class="small muted" style="margin-top:6px">${md.points.length}/3 — 서로 다른 속도 3개 이상이면 곡선을 계산합니다. <span class="en">Need ≥3 different speeds to fit the curve.</span></p>`;
    html += skipNote + '</div>';
  }
  if (A.imports.length) { html += `<h2>${t('imports')}</h2><div class="card">` + A.imports.map(i => `<div class="list-item" data-action="import-detail" data-id="${i.id}"><div><div class="t">${esc(i.filename || i.source)}</div><div class="s">${esc(i.source)} · ${i.startedAt ? fmtDate(i.startedAt) : ''} · ${i.durationSec ? fmtClock(i.durationSec) : ''}${i.meta?.position ? ' · ' + esc(i.meta.position) : ''}</div></div><button class="compact ghost danger" data-action="delete-import" data-id="${i.id}">✕</button></div>`).join('') + '</div>'; }
  setTimeout(() => { const el = $('#trend-chart'); if (el) { const tt = tests.filter(s => s.result && Number.isFinite(s.result.lt1Hr)).slice().reverse(); const c = trendChart(el, { labels: tt.map(s => fmtDate(s.startedAt).slice(5, 10)), lt1: tt.map(s => s.result.lt1Hr), lt2: tt.map(s => s.result.lt2Hr ?? null) }); A.charts.push(c); } }, 0);
  return html;
}
function itemHtml(s) { const m = s.metrics || {}; return `<div class="list-item" data-action="open-session" data-id="${s.id}"><div><div class="t">${typeLabel(s.type)} · ${fmtDate(s.startedAt)}${s.final ? '' : ' · <span class="pill warn">미완료 / unfinished</span>'}</div><div class="s">${fmtClock(m.durationSec || 0)} · HR ${n0(m.meanHr)}${A1() ? ` · α1 ${n2(m.meanAlpha1)}` : ''}${s.result ? ` · LT1 ${n0(s.result.lt1Hr)} / LT2 ${n0(s.result.lt2Hr)} (${esc(s.result.grade)})` : ''}${s.hasSmo2 ? ' · SmO2' : ''} · ${esc(s.sourceKind || '')}</div></div><div>›</div></div>`; }

async function renderSessionDetail(id, current = () => true) {
  const s = await store.getSession(id); const v = $('#view'); if (!current()) return; if (!s) { v.innerHTML = '<p>not found</p>'; return; }
  for (const k of ['events', 'features', 'hrLive', 'rr', 'stages']) if (s[k] != null) s[k] = list(s[k]); // a damaged record: read what can be read
  destroyCharts(); A.detail = s;
  const r = analyzeSession(s); const m = sessionMetrics(s); const z = zonesObj(); const txt = sessionSummaryText(s, m, z, r);
  let html = `<div class="row between"><button class="compact ghost" data-action="back">‹ ${t('sessions')}</button><div class="row"><button class="compact ghost" data-action="export-csv">${t('export_csv')}</button><button class="compact ghost danger" data-action="delete-session">${t('delete')}</button></div></div>
    <h3 style="margin-top:10px">${typeLabel(s.type)} · ${fmtDate(s.startedAt)}</h3><p class="small muted">${esc(s.sourceKind || '')} · ${fmtClock(m.durationSec)}${s.smo2?.series?.length ? ` · SmO2 ${esc(s.smo2.position || '')} (${s.smo2.series.length} pts, offset ${Math.round((s.smo2.offsetMs || 0) / 1000)} s · ${alignmentText(s.smo2)})` : ''}</p>
    <div class="card"><dl class="kv"><dt>${t('duration')}</dt><dd>${fmtClock(m.durationSec)}</dd><dt>${t('hr')}</dt><dd>${n0(m.meanHr)} / max ${n0(m.maxHr)}</dd>${A1() ? `<dt>${t('mean_alpha')}</dt><dd>${n2(m.meanAlpha1)} (≥0.75: ${n0(m.pctAlphaAbove75)}%)</dd>` : ''}<dt>${t('drift')}</dt><dd>${Number.isFinite(m.driftPct) ? (m.driftPct >= 0 ? '+' : '') + m.driftPct.toFixed(1) + '%' : '–'}</dd><dt>${t('artifacts')}</dt><dd>${n1(m.artifactPct)}%</dd>${Number.isFinite(m.timeInZonePct) ? `<dt>${t('time_in_zone')}</dt><dd>${n0(m.timeInZonePct)}%</dd>` : ''}</dl>
      <p style="margin-top:10px"><span class="ko">${esc(txt.ko)}</span><span class="en">${esc(txt.en)}</span></p></div>
    <div class="card" style="margin-top:10px;padding:8px 6px 4px"><div class="chart" id="tl-chart"></div></div>
    <div class="row" style="margin-top:10px"><button class="compact" data-action="attach-smo2">${t('attach_smo2')}</button>${s.smo2 ? `<label class="field grow">${t('offset')} (s) <input type="number" id="smo2-offset" value="${Math.round((s.smo2.offsetMs || 0) / 1000)}" step="5"></label>` : ''}<button class="compact" data-action="copy-summary">${t('copy_summary')}</button></div>`;
  if (s.sourceKind === 'demo' && s.final && list(s.events).some(e => e.type === 'lactate')) html += `<div class="card" style="margin-top:10px;border:1px solid var(--warn, #f5a623)"><p class="small">데모(가상 스트랩)로 기록된 세션입니다 — 심박·α1은 가짜이고, 주간 검사·곡선에서 빠집니다. 스트랩 없이 실제로 달렸다면 아래 버튼으로 바꾸세요: 젖산·시간·랩은 그대로, 가짜 심박은 지웁니다. <span class="en">Recorded on the demo (virtual) strap — its heart rate and α1 are made up, and it is left out of the weekly check and the curve. If you really ran without the strap, convert it: lactate, times and laps stay, the made-up heart rate is removed.</span></p><button class="compact" data-action="to-nostrap" style="margin-top:8px">스트랩 없이 달린 실제 기록으로 (젖산만) <span class="en">Real run without strap (lactate only)</span></button></div>`;
  if (s.sourceKind === 'nostrap') html += `<p class="small muted" style="margin-top:8px">스트랩 없음 — 젖산만으로 판정합니다(심박 수치는 쓰지 않음).${s.convertedFrom ? ' 데모 기록에서 바꾼 세션.' : ''} <span class="en">No strap — judged on lactate only (no heart-rate figure is used).${s.convertedFrom ? ' Converted from a demo recording.' : ''}</span></p>`;
  if (s.type !== 'test') {
    const c = lactateChecks(s); const vd = lactateVerdict(s); const ew = endWindowStats(s, 300);
    // where the running stopped: everything below is measured from there (see runTimeline)
    const endSec = (ew.endT - s.startedAt) / 1000, recSec = endSec + ew.tailSec; const how = RUN_HOW[ew.how] || RUN_HOW.finish;
    const tail = ew.tailSec >= 20 ? [` · 그 뒤 ${fmtClock(ew.tailSec)} 더 기록됨`, ` · the recording went on for ${fmtClock(ew.tailSec)}`] : ['', ''];
    const back = s.runEndSec != null ? [' · 칸을 비우면 자동 판단으로 돌아갑니다', ' · empty the field to return to the automatic value'] : ['', ''];
    const LEAD = {
      'no-entry': ['달리기가 끝난 시점을 가리키는 입력(채혈 값·일시정지)을 찾지 못해, 심박이 달리기 수준을 떠난 시점으로 추정했습니다.', 'Nothing logged (a lactate entry, Pause) could be tied to the end of the run, so it is estimated at the point where the heart rate left its running level.'],
      'late-entry': ['이 시점보다 6분 넘게 지나 입력된 채혈 값이 있습니다 — 그 사이가 쿨다운이었는지, 속도만 낮춰 계속 달린 것인지 심박만으로는 알 수 없습니다.', 'A lactate value was entered more than 6 min after this point — a cool-down in between, or running on at a lower speed? The heart rate alone cannot tell.'],
      'two-steps': ['채혈 값을 입력하기 전에 심박이 몇 분 간격으로 두 단계 내려갔습니다 — 첫 단계가 달리기의 끝(그 뒤는 쿨다운)인지, 속도만 낮춰 계속 달린 것인지 심박만으로는 알 수 없습니다.', 'Before the value was entered the heart rate stepped down twice, minutes apart — was the first step the end of the run (with a cool-down after it), or did you run on at a lower speed? The heart rate alone cannot tell.'],
      shallow: ['이 시점 뒤로 심박이 조금만 내려간 채 2분 넘게 지나 값이 입력됐습니다 — 멈춘 것인지 속도만 낮춘 것인지 확실하지 않습니다.', 'After this point the heart rate stayed only a little lower for more than 2 min before the value was entered — stopped, or just slower? Not certain.'],
      level: ['멈추기 전에 이미 심박이 달리기 수준보다 낮아져 있었습니다 — 어디까지가 검증 달리기였는지 확실하지 않습니다.', 'The heart rate was already below the level of the run before the stop — where the verification run ended is not certain.'],
      error: ['이 기록에서는 달리기가 끝난 시점을 계산하지 못해, 기록의 끝을 표시했습니다.', 'Where the run ended could not be worked out for this recording, so the end of the recording is shown.'],
    }; const lead = LEAD[ew.why] || LEAD['no-entry'];
    const unsure = ew.sure ? '' : `<div class="notice warn" style="margin-top:6px"><b>달리기 종료 시점 불확실</b> — ${lead[0]} 맞으면 「확정」을, 기록 끝까지 달렸다면 ${fmtClock(recSec)}을, 아니면 실제 시각을 위 칸에 입력하세요. 그때까지 심박으로는 존을 바꾸지 않고 대리 지표 판정도 하지 않습니다.<span class="en"><b>End of the run uncertain</b> — ${lead[1]} Press "confirm" if it is right, enter ${fmtClock(recSec)} if you ran to the end of the recording, or the real time otherwise. Until then no zone is changed by heart rate and no proxy call is made.</span></div>`;
    const est = ew.sure ? ['', ''] : [' (추정 구간)', ' (estimated window)'];
    const lastLbl = ew.bouts > 1 ? ['마지막 반복의 끝 5분 평균', 'Mean of the last 5 min of the last rep'] : ['달리기 마지막 5분 평균', 'Mean of the last 5 min of running'];
    html += `<h2>젖산 검증 <span class="en">Lactate verification</span></h2><div class="card">
      <div class="grid2"><label class="field">러닝머신 km/h<input type="number" step="0.1" id="vc-speed" value="${s.speed ?? ''}"></label><label class="field">경사 %<input type="number" step="0.5" id="vc-incline" value="${s.incline ?? ''}"></label></div>${s.type !== 'test' ? `<label class="field" style="margin-top:8px">장소 / where<select id="vc-surface">${SURFACES.map(k => `<option value="${k}" ${(s.surface || 'treadmill') === k ? 'selected' : ''}>${SURFACE_LBL[k][0]} / ${SURFACE_LBL[k][1]}</option>`).join('')}</select></label>${!onBelt(s) ? '<p class="small muted" style="margin:4px 0 0">벨트 밖 세션: 속도는 참고용 — 곡선·판정·존 변경에서 빠짐 <span class="en">Off the belt: speed is for reference — kept out of the curve, the verdicts and zone changes</span></p>' : ''}` : ''}
      <div class="grid2" style="margin-top:8px"><label class="field">세션 RPE (CR-10, 0–10) <span class="en">session RPE</span><input type="number" step="0.5" min="0" max="10" inputmode="decimal" id="vc-rpe" value="${Number.isFinite(s.rpe) ? s.rpe : ''}" placeholder="끝난 뒤 30분 안에 / within 30 min"></label><p class="small muted" style="align-self:end;margin:0">${Number.isFinite(s.rpe) ? (s.type === 'lt1' && s.rpe >= 5 ? '쉬운 런치고 높음 — 피로 표시 / high for an easy run — fatigue flag' : '기록됨 / recorded') : '쉬운 런 ≥ 5 = 피로 표시, 사다리 ≥ 7 = 다음 구간 −0.3 / easy run ≥ 5 = fatigue flag, ladder ≥ 7 = next rep −0.3'}</p></div>
      <label class="field" style="margin-top:8px">목적 / purpose<select id="vc-purpose">${s.type === 'verify' ? '' : `<option value="" ${!s.purpose ? 'selected' : ''}>자동 (종료 ≥ 3 → MLSS 규칙) / auto</option>`}<option value="lt1" ${s.purpose === 'lt1' || (s.type === 'verify' && !s.purpose) ? 'selected' : ''}>LT1 검증${s.type === 'verify' ? ' (두 랩)' : ''} / LT1 check</option><option value="mlss" ${s.purpose === 'mlss' ? 'selected' : ''}>MLSS(LT2) 검증 / MLSS check</option></select></label>
      <div class="grid3" style="margin-top:8px"><label class="field">안정 시 / rest<input type="text" inputmode="decimal" autocomplete="off" id="vc-rest" value="${c.rest ?? ''}" placeholder="${Number.isFinite(A.settings.profile.restLactate) ? '기준 ' + A.settings.profile.restLactate : ''}"></label><label class="field">${midLabel(c).ko} / ${midLabel(c).en}<input type="text" inputmode="decimal" autocomplete="off" id="vc-mid" value="${c.mid ?? ''}"></label><label class="field">종료 / end<input type="text" inputmode="decimal" autocomplete="off" id="vc-end" value="${c.end ?? ''}"></label></div>${c.mid != null && !c.twoLap ? `<label class="field" style="margin-top:6px">중간 채혈 시각 (분) <span class="en">Mid sample taken at (min)</span><input type="number" inputmode="numeric" min="1" max="600" step="1" id="vc-mid-min" value="${Number.isFinite(c.midMin) ? c.midMin : ''}" placeholder="예: 30"></label>` : ''}
      <div class="row" style="margin-top:8px;align-items:flex-end"><label class="field grow">달리기 종료 (분:초 · 3505 = 35:05) / run ended at (min:s)<input type="text" id="vc-runend" inputmode="numeric" autocomplete="off" value="${fmtClock(endSec)}"></label>${ew.sure ? '' : '<button class="compact" id="vc-runend-ok">확정 <span class="en">confirm</span></button>'}</div>
      <p class="small muted" id="vc-runend-how" style="margin-top:4px">${how[0]}${tail[0]}${back[0]} <span class="en">${how[1]}${tail[1]}${back[1]}</span></p>
      ${unsure}
      <p class="small muted" id="vc-last5" style="margin-top:6px">${lastLbl[0]}${est[0]}: 심박 ${n0(ew.hr)} bpm${A1() ? ` · α1 ${n2(ew.alpha1)}` : ''} <span class="en">${lastLbl[1]}${est[1]}: HR ${n0(ew.hr)}${A1() ? ` · α1 ${n2(ew.alpha1)}` : ''}</span></p>
      ${(() => { const ls = lapStats(s); if (!ls) return ''; const gapWarn = Number.isFinite(ls.gapSec) && ls.gapSec > GAP_STRICT_SEC; const dr = Number.isFinite(ls.lap2Drift) ? `${ls.lap2Drift >= 0 ? '+' : ''}${ls.lap2Drift.toFixed(0)} bpm` : '–'; return `<div class="notice ${gapWarn || ls.lap2Drift > 8 ? 'warn' : ''}" id="vc-laps" style="margin-top:6px"><b>두 랩</b> 랩 1 ${ls.lap1Min.toFixed(1)}분 · 5–10분 심박 <b class="mono">${n0(ls.lap1Hr)}</b> bpm (곡선·범위에 쓰는 값) → 간격 <b class="mono">${Number.isFinite(ls.gapSec) ? Math.round(ls.gapSec) + '초' : '–'}</b>${gapWarn ? ' ⚠ 3분 초과 → 엄격 규칙' : ''} → 랩 2 ${ls.lap2Min.toFixed(1)}분 · 드리프트(재시작 1–6분 → 마지막 5분) <b class="mono">${dr}</b>${ls.lap2Drift > 8 ? ' ⚠ > 8 — 지구력 표시' : ''}<span class="en"><b>Two laps</b> lap 1 ${ls.lap1Min.toFixed(1)} min · HR min 5–10 <b class="mono">${n0(ls.lap1Hr)}</b> bpm (the value the curve and the band take) → gap <b class="mono">${Number.isFinite(ls.gapSec) ? Math.round(ls.gapSec) + ' s' : '–'}</b>${gapWarn ? ' ⚠ over 3 min → strict rule' : ''} → lap 2 ${ls.lap2Min.toFixed(1)} min · drift (min 1–6 after the restart → last 5) <b class="mono">${dr}</b>${ls.lap2Drift > 8 ? ' ⚠ > 8 — durability flag' : ''}</span></div>`; })()}
      ${(() => { const ss = smo2Steady(s); if (!ss) return ''; const st = (ss.steady == null ? '' : ss.steady ? '안정 상태 / steady' : '비정상 상태 — 계속 하락 / not steady — still falling') + (ew.sure ? '' : ' (추정 구간 / estimated window)'); return `<div class="notice ${ss.steady === false || ss.contact === 'low' ? 'warn' : ''}" style="margin-top:6px"><b>SmO₂</b> 5–10분 ${n1(ss.earlyMean)} % → 마지막 5분 ${n1(ss.endMean)} % (Δ ${Number.isFinite(ss.drift) ? (ss.drift > 0 ? '+' : '') + ss.drift.toFixed(1) : '–'}), 끝 10분 기울기 ${Number.isFinite(ss.slopeEnd) ? ss.slopeEnd.toFixed(2) : '–'} %/min → ${st}. THb ${n1(ss.thbMean)}${ss.contact === 'low' ? ' ⚠ 접촉 불량 의심 / poor contact?' : ''}<span class="en">SmO₂ 5–10 min ${n1(ss.earlyMean)} % → last 5 min ${n1(ss.endMean)} %, end slope ${Number.isFinite(ss.slopeEnd) ? ss.slopeEnd.toFixed(2) : '–'} %/min → ${ss.steady == null ? '' : ss.steady ? 'steady' : 'not steady'}</span></div>`; })()}
      ${vd ? `<div class="notice ${vd.level === 'ok' && !vd.durability ? '' : 'warn'}" style="margin-top:6px"><span class="ko">${esc(vd.ko)}</span><span class="en">${esc(vd.en)}</span></div>${vd.kind === 'mlss' && Number.isFinite(vd.mlssLa) && A.settings.zones.mlssLactate !== vd.mlssLa ? `<button class="compact" style="margin-top:8px" data-action="save-mlss-lactate" data-la="${vd.mlssLa}">MLSS 젖산 ${vd.mlssLa}를 사다리 목표로 저장 (± 0.5) <span class="en">Save MLSS lactate ${vd.mlssLa} as the ladder target (± 0.5)</span></button>` : ''}${vd.twoLap ? (() => { const bf = A.bandFinder; const mine = bf && bf.last && bf.last.id === s.id; return `<div class="small" style="margin-top:6px">${mine ? `<span class="ko">${esc(bf.ko)}</span><span class="en">${esc(bf.en)}</span>` : '<span class="ko">주간 범위 탐색기: 한 번의 검증으로는 존을 바꾸지 않습니다 — 두 주 연속 같은 결과일 때 홈 화면에서 「범위 반영」.</span><span class="en">Weekly band finder: one check changes no zone — after two consecutive results of the same kind, "Apply the band change" on Home.</span>'}</div>${mine && bf.change ? `<button class="compact" style="margin-top:8px" data-action="apply-band">범위 반영: ${esc(bf.change.ko)} <span class="en">Apply the band change</span></button>` : ''}`; })() : (() => { const ch = verdictZoneChange(A.settings.zones, s, vd); return ch ? `<button class="compact" style="margin-top:8px" data-action="apply-verdict">존에 반영: ${esc(ch.ko)} <span class="en">Apply to zones</span></button>` : `<p class="small muted" style="margin-top:6px">현재 존(LT1 ${A.settings.zones?.lt1Hr ?? '–'} bpm @ ${A.settings.zones?.lt1Speed ?? '–'} · LT2 ${A.settings.zones?.lt2Hr ?? '–'} @ ${A.settings.zones?.lt2Speed ?? '–'})과 모순되지 않음 — 변경 없음 <span class="en">Consistent with current zones — nothing to change</span></p>`; })()}` : `<p class="small muted">종료 젖산을 입력하면 LT1/LT2 판정이 나옵니다. 세션 중 「젖산 입력」으로 기록한 값은 자동 배치됩니다(멈춘 뒤 입력한 값 = 종료, 입력 뒤 다시 달렸으면 10분 값${s.type === 'verify' ? '; 두 랩: 간격의 값 = 랩 1, 랩 2 뒤의 값 = 종료' : ''}). <span class="en">Enter the end lactate to get a verdict; values logged during the session are placed automatically (typed after the stop = end; running resumed after it = the 10-min value${s.type === 'verify' ? '; two laps: the gap value = lap 1, the value after lap 2 = end' : ''}).</span></p>`}
    </div>`;
  }
  const evs = (s.events || []).filter(e => ['lactate', 'lap'].includes(e.type) && (s.type !== 'test' || e.type === 'lap'));
  // the tags a lactate value carries (v1.1.17): lap, running time at speed, seconds after the belt stopped
  const lapName = l => l === 1 ? tx('lap1') : l === 2 ? tx('lap2') : l === 0 ? '워밍업 / warm-up' : `#${l}`;
  const tagTxt = e => e.type !== 'lactate' ? '' : [e.lap != null ? lapName(e.lap) : '', Number.isFinite(e.runSec) ? `${fmtClock(e.runSec)} 달림 / at speed` : '', Number.isFinite(e.sinceStopSec) ? `정지 후 ${e.sinceStopSec}초 / ${e.sinceStopSec} s after the stop` : ''].filter(Boolean).join(' · ');
  if (evs.length) html += `<h2>이벤트 <span class="en">Events</span></h2><div class="card"><div class="table-wrap"><table><thead><tr><th>t</th><th>type</th><th>value</th><th>phase</th><th>태그 / tags</th></tr></thead><tbody>${evs.map(e => `<tr><td>${fmtClock((e.t - s.startedAt) / 1000)}</td><td>${esc(e.type)}</td><td>${e.value ?? ''}</td><td>${esc(e.phase || '')}${e.rep ? ' #' + e.rep : ''}</td><td class="small">${esc(tagTxt(e))}</td></tr>`).join('')}</tbody></table></div></div>`;
  if (s.type === 'test' || (s.stages && s.stages.length)) {
    const incl = r.rows.map(x => x.incline); const constIncl = incl.length && incl.every(v => v === incl[0]);
    html += `<h2>${t('stage_table')}</h2><div class="card"><div class="table-wrap"><table id="stage-table"><thead><tr><th>#</th><th>km/h</th>${constIncl ? '' : '<th>%</th>'}<th>HR</th>${A1() ? '<th>α1</th>' : ''}<th>La</th><th>SmO2</th><th>%/min</th></tr></thead><tbody>${r.rows.map(row => `<tr data-idx="${row.idx}"><td>${row.idx}</td><td><input type="number" step="0.1" data-f="speed" value="${row.speed ?? ''}"></td>${constIncl ? '' : `<td><input type="number" step="0.5" data-f="incline" value="${row.incline ?? ''}"></td>`}<td>${n0(row.hr)}</td>${A1() ? `<td>${n2(row.alpha1)}${row.artifactPct > 5 ? ' ⚠' : ''}</td>` : ''}<td><input type="number" step="0.1" data-f="lactate" value="${row.lactate ?? ''}">${row.lactateDup ? '<div class="small muted">×2</div>' : ''}</td><td>${n1(row.smo2)}</td><td>${Number.isFinite(row.smo2Slope) ? row.smo2Slope.toFixed(1) : '–'}</td></tr>`).join('')}</tbody></table></div><p class="small muted">${constIncl ? `경사 ${incl[0]}% 고정 / incline ${incl[0]}% fixed · ` : ''}값을 고치면 자동으로 다시 계산됩니다. α1은 각 단계 마지막 60초 평균, SmO2는 마지막 60초 평균과 2분 기울기.<span class="en">Edits recalculate automatically. α1 = mean of the last 60 s of each stage; SmO2 = last-60-s mean and 2-min slope.</span></p></div>
      <div class="card" style="margin-top:10px;padding:8px 6px 4px"><div class="chart" id="step-chart"></div></div>`;
    html += `<h2>${t('thresholds')}</h2><div class="card"><div class="table-wrap"><table class="wrap-first"><thead><tr><th>${t('method')}</th><th>km/h</th><th>bpm</th><th>mmol/L</th></tr></thead><tbody>`;
    if (r.lactate) html += [...r.lactate.lt1, ...r.lactate.lt2].map(e => `<tr><td>${e.method.includes('ModDmax') || e.method.startsWith('baseline') ? '<b>' + esc(e.method.replace('Log-Poly-ModDmax', 'ModDmax (log-poly)')) + '</b>' : esc(e.method)}${e.note ? `<div class="small muted">${esc(e.note)}</div>` : ''}</td><td>${n1(e.x)}</td><td>${n0(e.hr)}</td><td>${n1(e.la)}</td></tr>`).join(''); else html += `<tr><td colspan="4" class="muted">젖산 3단계 이상 필요 / needs ≥3 lactate stages</td></tr>`;
    if (r.hrv) html += `<tr><td>HRVT1 (α1 0.75)${r.hrv.fit ? `<div class="small muted">r²=${n2(r.hrv.fit.r2)} · ${r.hrv.points} pts</div>` : ''}</td><td>${n1(r.hrv.hrvt1?.speed)}</td><td>${n0(r.hrv.hrvt1?.hr)}</td><td></td></tr><tr><td>HRVT2 (α1 0.5)${r.hrv.note ? `<div class="small muted">${esc(r.hrv.note)}</div>` : ''}${r.hrv.plateau ? `<div class="small" style="color:var(--warn)">⚠ ${esc(r.hrv.plateau.note)}</div>` : ''}</td><td>${n1(r.hrv.hrvt2?.speed)}</td><td>${n0(r.hrv.hrvt2?.hr)}</td><td></td></tr>`;
    html += `<tr><td>SmO2 BP1${r.smo2.note ? `<div class="small muted">${esc(r.smo2.note)}</div>` : ''}</td><td>${n1(r.smo2.bp1?.speed)}</td><td>${n0(r.smo2.bp1?.hr)}</td><td></td></tr><tr><td>SmO2 BP2${r.smo2.firstUnsteady ? `<div class="small muted">첫 비정상 상태 / first unsteady: ${n1(r.smo2.firstUnsteady.speed)} km/h</div>` : ''}</td><td>${n1(r.smo2.bp2?.speed)}</td><td>${n0(r.smo2.bp2?.hr)}</td><td></td></tr></tbody></table></div></div>`;
    const tri = r.tri; const agreeHtml = (o) => `<span class="agree agree-${o.label === 'agree' ? 'ok' : o.label}">${esc(o.src)} ${n0(o.hr)} (${tx(o.label)}${Number.isFinite(o.diff) ? ' ' + n0(o.diff) : ''})</span>`;
    html += `<h2>${t('triangulation')}</h2><div class="card accent"><div class="thr-card"><div class="box"><div class="small muted">${t('lt1')}</div><div class="v">${n0(tri.lt1?.hr)}<small> bpm</small></div><div class="small">${n1(tri.lt1?.speed)} km/h · ${esc(tri.lt1?.source || '–')} · ${t('grade')} ${tri.grade1}</div><div class="small">${(tri.lt1?.others || []).map(agreeHtml).join(' · ')}</div></div>
      <div class="box"><div class="small muted">${t('lt2')}</div><div class="v">${n0(tri.lt2?.hr)}<small> bpm</small></div><div class="small">${n1(tri.lt2?.speed)} km/h · ${esc(tri.lt2?.source || '–')} · ${t('grade')} ${tri.grade2}</div><div class="small">${(tri.lt2?.others || []).map(agreeHtml).join(' · ')}</div></div></div>
      <button class="primary block" style="margin-top:10px" data-action="apply-zones" ${tri.lt1 && tri.lt2 ? '' : 'disabled'}>${t('apply_zones')}</button>${A.settings.zones.testSessionId === s.id ? `<p class="small muted" style="margin-top:6px">${t('applied')} ✓</p>` : ''}</div>`;
  }
  // FatMaxxer comparison (features import overlapping this session)
  const fm = A.imports.find(i => i.source === 'fatmaxxer-features' && i.features?.some(f => f.t >= s.startedAt && f.t <= (s.endedAt || Infinity)));
  if (A1() && fm && s.features?.length) { const pairs = []; for (const f of fm.features) { if (f.t < s.startedAt || f.t > s.endedAt) continue; const mine = s.features.reduce((best, x) => Math.abs(x.t - f.t) < Math.abs(best.t - f.t) ? x : best, s.features[0]); if (Math.abs(mine.t - f.t) < 6000 && Number.isFinite(mine.alpha1) && Number.isFinite(f.alpha1)) pairs.push([f.alpha1, mine.alpha1]); } if (pairs.length) { const mad = pairs.reduce((a, p) => a + Math.abs(p[0] - p[1]), 0) / pairs.length; html += `<div class="card" style="margin-top:10px"><h3>FatMaxxer α1 비교 <span class="en">comparison</span></h3><p class="small">${pairs.length}개 시점, 평균 절대차 <b class="mono">${mad.toFixed(3)}</b> / ${pairs.length} points, mean |Δ| ${mad.toFixed(3)}</p></div>`; } }
  if (!current()) return;
  v.innerHTML = html;
  // charts (a chart that cannot be drawn must not take the card and its buttons with it)
  try {
  const el = $('#tl-chart'); if (el && s.features?.length) { const t0 = s.startedAt; const feats = s.features; const ts = feats.map(f => (f.t - t0) / 1000); const hr = feats.map(f => f.hrInst > 0 ? f.hrInst : null); const a1 = feats.map(f => Number.isFinite(f.alpha1) ? f.alpha1 : null); let sm = null; if (s.smo2?.series?.length) { const off = s.smo2.offsetMs || 0; const ser = s.smo2.series; sm = ts.map(tt => { const target = t0 + tt * 1000 - off; let lo = 0, hi = ser.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (ser[mid][0] < target) lo = mid + 1; else hi = mid; } const p = ser[lo]; return p && Math.abs(p[0] - target) < 3000 ? p[1] : null; }); } const band = s.targets ? [s.targets.hrLo, s.targets.hrHi] : null; A.charts.push(timelineChart(el, { ts, hr, a1, smo2: sm, band, alpha: A1() })); }
  else if (el && s.hrLive?.length) { const t0 = s.startedAt; const step = Math.max(1, Math.floor(s.hrLive.length / 600)); const pts = s.hrLive.filter((_, i) => i % step === 0); A.charts.push(timelineChart(el, { ts: pts.map(p => (p[0] - t0) / 1000), hr: pts.map(p => p[1]), a1: pts.map(() => null) })); }
  const sc = $('#step-chart'); if (sc && r.rows.length) { const rows = r.rows.filter(x => Number.isFinite(x.speed)); const marks = []; if (r.lactate && Number.isFinite(r.lactate.lt1Primary.x)) marks.push({ x: r.lactate.lt1Primary.x, label: 'LT1', color: getComputedStyle(document.documentElement).getPropertyValue('--c-la') }); if (r.lactate && Number.isFinite(r.lactate.lt2Primary.x)) marks.push({ x: r.lactate.lt2Primary.x, label: 'LT2', color: getComputedStyle(document.documentElement).getPropertyValue('--c-la') }); if (r.hrv?.hrvt1) marks.push({ x: r.hrv.hrvt1.speed, label: 'HRVT1', row: 1, color: getComputedStyle(document.documentElement).getPropertyValue('--c-a1') }); if (r.hrv?.hrvt2) marks.push({ x: r.hrv.hrvt2.speed, label: 'HRVT2', row: 1, color: getComputedStyle(document.documentElement).getPropertyValue('--c-a1') }); if (r.smo2.bp2) marks.push({ x: r.smo2.bp2.speed, label: 'BP2', row: 2, color: getComputedStyle(document.documentElement).getPropertyValue('--c-smo2') }); A.charts.push(stepTestChart(sc, { speeds: rows.map(x => x.speed), lactate: rows.map(x => Number.isFinite(x.lactate) ? x.lactate : null), a1: rows.map(x => Number.isFinite(x.alpha1) ? x.alpha1 : null), smo2: rows.map(x => Number.isFinite(x.smo2) ? x.smo2 : null), hr: rows.map(x => Number.isFinite(x.hr) ? x.hr : null), marks, alpha: A1() })); }
  } catch (e) { console.error('session charts', e); }
  // stage edits
  const tbl = $('#stage-table'); if (tbl) tbl.addEventListener('change', async e => { const inp = e.target; const tr = inp.closest('tr'); if (!tr) return; const idx = +tr.dataset.idx; const st = s.stages.find(x => x.idx === idx); if (!st) return; const val = inp.value === '' ? null : +inp.value; st[inp.dataset.f] = val; if (inp.dataset.f === 'lactate') delete st.lactate2; /* a typed value replaces both strips */ if (s.type === 'test') s.result = resultFrom(analyzeSession(s)); await store.putSession(s); await refreshDetail(s.id); });
  const vsf = document.getElementById('vc-surface'); if (vsf) vsf.onchange = async () => { s.surface = vsf.value; await store.putSession(s); await refreshDetail(s.id); };
  const vp = document.getElementById('vc-purpose'); if (vp) vp.onchange = async () => { s.purpose = vp.value || null; await store.putSession(s); await refreshDetail(s.id); };
  for (const [id, key] of [['vc-speed', 'speed'], ['vc-incline', 'incline']]) { const el = document.getElementById(id); if (el) el.onchange = async () => { s[key] = el.value === '' ? null : +el.value; await store.putSession(s); await refreshDetail(s.id); }; }
  const rpeEl = document.getElementById('vc-rpe'); if (rpeEl) rpeEl.onchange = async () => { const v = rpeEl.value === '' ? null : +rpeEl.value; if (v != null && !(v >= 0 && v <= 10)) { toast('0–10', 2000); rpeEl.value = Number.isFinite(s.rpe) ? s.rpe : ''; return; } if (v == null) delete s.rpe; else s.rpe = v; await store.putSession(s); await refreshDetail(s.id); };
  // A field typed here is final for that field alone (also when emptied); the other two keep following what was logged during the session.
  for (const [id, key] of [['vc-rest', 'rest'], ['vc-mid', 'mid'], ['vc-end', 'end']]) { const el = document.getElementById(id); if (el) el.onchange = async () => { const raw = el.value.trim().replace(',', '.'); const v = raw === '' ? null : Number(raw);
    if (v != null && !(v >= 0.3 && v <= 25)) { toast('0.3–25 mmol/L', 3000); el.value = lactateChecks(s)[key] ?? ''; return; } // (the meter's range; a typo must not become a verdict)
    s.lactateChecks = { ...typedChecks(s), [key]: Number.isFinite(v) ? v : null }; s.lactateChecksV = 2; s.metrics = sessionMetrics(s); await store.putSession(s); await refreshDetail(s.id); }; }
  // The minute of the mid sample: typed when the value was typed by hand (no time of its own) or to correct it; empty = from the recording.
  const mm = document.getElementById('vc-mid-min'); if (mm) mm.onchange = async () => { const raw = mm.value.trim(); const v = raw === '' ? null : Math.round(Number(raw));
    if (v != null && !(v >= 1 && v <= 600)) { toast('1–600 min', 3000); mm.value = lactateChecks(s).midMin ?? ''; return; }
    if (v == null) delete s.midMinTyped; else s.midMinTyped = v; s.metrics = sessionMetrics(s); await store.putSession(s); await refreshDetail(s.id); };
  // End of the run: a time typed here (or the estimate, confirmed) replaces the automatic one; an empty field returns to it.
  const setRunEnd = async sec => { if (sec == null) delete s.runEndSec; else s.runEndSec = sec; s.metrics = sessionMetrics(s); await store.putSession(s); await refreshDetail(s.id); };
  const re = document.getElementById('vc-runend'); if (re) re.onchange = async () => {
    if (re.value.trim() === '') { await setRunEnd(null); return; }
    const sec = parseClock(re.value); const w = endWindowStats(s, 300); const rec = Math.round((w.endT - s.startedAt) / 1000 + w.tailSec);
    const first = Math.floor((runTimeline(s).start - s.startedAt) / 1000) + 1; // (an LT2 session: after the start of the last rep)
    if (!(sec >= first) || sec > rec) { toast(`${fmtClock(first)} – ${fmtClock(rec)} 사이의 시각을 입력하세요 (예: 35:05 = 3505 = 35.05) / enter a time in that range`, 4000); re.value = fmtClock((w.endT - s.startedAt) / 1000); return; }
    await setRunEnd(sec);
  };
  const reOk = document.getElementById('vc-runend-ok'); if (reOk) reOk.onclick = async () => { const w = endWindowStats(s, 300); await setRunEnd(Math.round((w.endT - s.startedAt) / 1000)); };
  const off = $('#smo2-offset'); if (off) off.onchange = async () => { s.smo2.offsetMs = (+off.value || 0) * 1000; s.smo2.alignment = { ...(s.smo2.alignment || {}), method: 'manual', ok: true, mad: s.smo2.alignment?.mad ?? NaN, estimatedMs: s.smo2.alignment?.estimatedMs ?? s.smo2.offsetMs }; await store.putSession(s); await refreshDetail(s.id); };
  // The numbers kept with a session (the list shows them) were worked out by the version that recorded it: once the session has been
  // opened they are the ones shown here.
  if (s.final && JSON.stringify(s.metrics ?? null) !== JSON.stringify(m)) { s.metrics = m; try { await store.putSession(s); } catch (e) {} }
}
/**
 * Show the session again after an edit in it. Not while the user is already typing in another field of the card: rebuilding the card
 * would take that field away under the finger (the typing lost, or half of it stored) — then once that field is left.
 */
document.addEventListener('change', e => { A.lastChanged = e.target; }, true);
function refreshDetail(id) {
  return new Promise(res => setTimeout(async () => {
    const ae = document.activeElement;
    if (ae && ae !== A.lastChanged && ae.tagName === 'INPUT' && ae.closest('#view') && ae.isConnected) { if (!A.refreshWait) { A.refreshWait = true; ae.addEventListener('blur', () => { A.refreshWait = false; refreshDetail(id); }, { once: true }); } res(); return; }
    if (A.view !== 'analysis' || A.param !== id) { res(); return; }
    try { destroyCharts(); await renderSessionDetail(id); } catch (e) { showRenderError(e); }
    res();
  }, 0));
}
async function applyZonesFromDetail() {
  const s = A.detail; if (!s) return; const r = analyzeSession(s); const tri = r.tri; if (!tri.lt1 || !tri.lt2) return;
  A.settings.zones = { lt1Hr: Math.round(tri.lt1.hr), lt2Hr: Math.round(tri.lt2.hr), lt1Speed: Number.isFinite(tri.lt1.speed) ? Math.round(tri.lt1.speed * 10) / 10 : null, lt2Speed: Number.isFinite(tri.lt2.speed) ? Math.round(tri.lt2.speed * 10) / 10 : null, source: `${tri.lt1.source} / ${tri.lt2.source}`, grade: `${tri.grade1}/${tri.grade2}`, updatedAt: s.startedAt, testSessionId: s.id };
  if (!A.settings.plan.startDate) A.settings.plan.startDate = new Date(s.startedAt).toISOString().slice(0, 10);
  await saveSettings(); toast(tx('applied')); await renderSessionDetail(s.id);
}
function attachSmo2Modal() {
  const s = A.detail; const cands = A.imports.filter(i => i.smo2Series && i.smo2Series.length);
  // first choice: a Train.Red file straight from the phone, attached to this session (no trip through the list)
  const pick = `<button class="primary" id="smo2-pick-file" style="width:100%">${t('smo2_pick_file')}</button><p class="small muted" style="margin:6px 0 10px">Train.Red 앱에서 내려받은 CSV(또는 FIT)를 고르면 이 세션에 바로 붙습니다. 심박으로 시간을 자동 정렬합니다. / Pick the CSV (or FIT) downloaded from the Train.Red app; it is attached to this session and aligned by heart rate.</p>`;
  const list = cands.map(i => { const ov = Math.max(0, Math.min(i.endedAt, s.endedAt || i.endedAt) - Math.max(i.startedAt, s.startedAt)) / 1000; return `<div class="list-item" data-imp="${i.id}"><div><div class="t">${esc(i.filename)}</div><div class="s">${fmtDate(i.startedAt)} · ${fmtClock(i.durationSec)} · ${esc(i.meta?.position || '')} · 겹침/overlap ${fmtClock(ov)}</div></div><div>›</div></div>`; }).join('');
  const prev = cands.length ? `<h3 style="margin-top:6px">${t('smo2_imported')}</h3>${list}<p class="small muted">세션과 겹치지 않아도 붙일 수 있습니다(시작 시각 기준 정렬, 보정 슬라이더로 맞추세요). / Files that don't overlap can still be attached (aligned by start time; use the offset to align).</p>` : '';
  modal(`<h3>${t('attach_smo2')}</h3>${pick}${prev}`, (m, close) => {
    m.querySelector('#smo2-pick-file').addEventListener('click', () => { A.pendingSmo2For = s.id; close(); $('#file-input').click(); });
    m.addEventListener('click', async e => { const it = e.target.closest('[data-imp]'); if (!it) return; const imp = await store.getImport(it.dataset.imp); const ov = imp.startedAt < (s.endedAt || Infinity) && imp.endedAt > s.startedAt; s.smo2 = buildSmo2(s, imp, { overlap: ov }); if (s.type === 'test') s.result = resultFrom(analyzeSession(s)); await store.putSession(s); close(); destroyCharts(); await renderSessionDetail(s.id); });
  });
}
/** A Train.Red file picked from a session's screen: keep it with the imports (once) and attach it to that session. */
async function attachSmo2File(sessionId, file) {
  try {
    const imp = await importFile(file);
    if (!imp.smo2Series?.length) throw new Error('이 파일에는 SmO2가 없습니다 / no SmO2 in this file');
    const s = await store.getSession(sessionId); if (!s) throw new Error('세션 없음 / session not found');
    const known = (await store.listImports()).find(i => i.smo2Series?.length && i.filename === imp.filename && i.startedAt === imp.startedAt);
    const rec = known || { id: uid(), source: imp.source, filename: imp.filename, startedAt: imp.startedAt, endedAt: imp.endedAt, durationSec: imp.durationSec, smo2Series: imp.smo2Series, hrSeries: imp.hrSeries || [], laps: imp.laps || [], meta: imp.meta || {} };
    if (!known) await store.putImport(rec);
    const ov = rec.startedAt < (s.endedAt || Infinity) && rec.endedAt > s.startedAt;
    s.smo2 = buildSmo2(s, rec, { overlap: ov }); if (s.type === 'test') s.result = resultFrom(analyzeSession(s));
    await store.putSession(s); await refreshLists();
    const al = s.smo2.alignment;
    const msg = !ov ? '⚠ 세션과 시간이 겹치지 않음 — 시작 시각에 맞춤, 보정값 확인 / no time overlap — aligned to the start, check the offset'
      : al ? (al.ok ? `SmO2 첨부 ✓ 심박으로 정렬 (${Math.round(s.smo2.offsetMs / 1000)} s) / attached, HR-aligned` : 'SmO2 첨부 — ⚠ 정렬 확인 필요 / attached — check the alignment')
      : 'SmO2 첨부 (시계 기준) / attached (by clock)';
    toast(msg, 5000);
    if (A.view === 'analysis' && A.param === sessionId) { destroyCharts(); await renderSessionDetail(sessionId); }
  } catch (e) { console.error(e); toast(`첨부 실패 / attach failed: ${esc(file.name)} — ${esc(e.message)}`, 5000); }
}
function exportSessionCsv(s) {
  const r = analyzeSession(s); const L = [];
  L.push('# Treadmill Lab session export'); L.push(`# type,${s.type},start,${new Date(s.startedAt).toISOString()},source,${s.sourceKind || ''}`);
  L.push(`# end,${s.endedAt ? new Date(s.endedAt).toISOString() : ''},duration_s,${s.endedAt ? Math.round((s.endedAt - s.startedAt) / 1000) : ''},speed_kmh,${s.speed ?? ''},incline_pct,${s.incline ?? ''}`);
  const lc = lactateChecks(s); const vd = lactateVerdict(s);
  if (s.type !== 'test') { const w = endWindowStats(s, 300); L.push(`# run_end_s,${Math.round((w.endT - s.startedAt) / 1000)},found_by,${w.how},certain,${w.sure ? 1 : 0},last5_hr_bpm,${n1(w.hr).replace('–', '')},last5_alpha1,${n2(w.alpha1).replace('–', '')}`); }
  L.push(`# lactate_rest,${lc.rest ?? ''},lactate_mid,${lc.mid ?? ''},lactate_end,${lc.end ?? ''},verdict,${vd ? vd.level : ''},${vd ? '"' + vd.en.replace(/"/g, "'") + '"' : ''},lactate_mid_min,${lc.midMin ?? ''}`);
  const ss = smo2Steady(s); if (ss) L.push(`# smo2_early_pct,${n1(ss.earlyMean)},smo2_end_pct,${n1(ss.endMean)},smo2_drift,${Number.isFinite(ss.drift) ? ss.drift.toFixed(1) : ''},smo2_end_slope_pct_per_min,${Number.isFinite(ss.slopeEnd) ? ss.slopeEnd.toFixed(2) : ''},steady,${ss.steady == null ? '' : ss.steady},thb_mean,${n1(ss.thbMean)},contact,${ss.contact ?? ''}`);
  const ev = (s.events || []).filter(e => e.type === 'lactate' || e.type === 'lap' || e.type === 'pause' || e.type === 'resume' || e.type === 'stop');
  const ls = lapStats(s); if (ls) L.push(`# two_lap,1,lap1_min,${ls.lap1Min.toFixed(1)},lap1_hr_5_10,${n0(ls.lap1Hr).replace('–', '')},gap_sec,${Number.isFinite(ls.gapSec) ? Math.round(ls.gapSec) : ''},lap2_min,${ls.lap2Min.toFixed(1)},lap2_drift_bpm,${Number.isFinite(ls.lap2Drift) ? ls.lap2Drift.toFixed(1) : ''},lap1_lactate,${lc.mid ?? ''},end_lactate,${lc.end ?? ''},strict,${Number.isFinite(ls.gapSec) && ls.gapSec > GAP_STRICT_SEC ? 1 : 0}`);
  if (ev.length) { L.push('event_t_iso,elapsed_s,type,value,stage,phase,lap,run_s,since_stop_s,gap_s'); for (const e of ev) L.push([new Date(e.t).toISOString(), ((e.t - s.startedAt) / 1000).toFixed(0), e.type, e.value ?? e.reason ?? '', e.stage ?? '', e.phase ?? '', e.lap ?? '', e.runSec ?? '', e.sinceStopSec ?? '', e.gapSec ?? ''].join(',')); L.push(''); }
  if (r.rows.length) { L.push('stage,speed_kmh,incline_pct,hr_bpm,alpha1,lactate_mmol,smo2_pct,smo2_slope_pct_per_min,artifact_pct'); for (const x of r.rows) L.push([x.idx, x.speed, x.incline, n0(x.hr), n2(x.alpha1), x.lactate ?? '', n1(x.smo2), Number.isFinite(x.smo2Slope) ? x.smo2Slope.toFixed(2) : '', n1(x.artifactPct)].join(',')); L.push(''); }
  L.push('t_iso,elapsed_s,hr_bpm,alpha1,rmssd_ms,artifact_pct,samples,phase,stage'); for (const f of s.features || []) L.push([new Date(f.t).toISOString(), ((f.t - s.startedAt) / 1000).toFixed(0), f.hrInst ?? '', Number.isFinite(f.alpha1) ? f.alpha1.toFixed(3) : '', Number.isFinite(f.rmssd) ? f.rmssd.toFixed(1) : '', f.artifactPct?.toFixed(1) ?? '', f.samples ?? '', f.phase ?? '', f.stage ?? ''].join(','));
  L.push(''); L.push('rr_t_ms,rr_ms,accepted'); for (const x of s.rr || []) L.push(x.join(','));
  download(`treadmill-lab_${s.type}_${new Date(s.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`, L.join('\n'), 'text/csv');
}

// ---------- IMPORT ----------
async function handleFiles(files) {
  let made = 0, restored = false;
  for (const file of files) {
    try {
      if (/\.json$/i.test(file.name)) { const b = JSON.parse(await file.text()); const r = await store.importAll(b, { merge: true }); if (b.settings) { A.settings = coerceSettings(deepMerge(freshDefaults(), b.settings)); await saveSettings(); restored = true; } toast(`복원 / restored: ${r.sessions} sessions, ${r.imports} imports`); made++; continue; }
      const imp = await importFile(file);
      if (imp.source === 'rr-csv' || (imp.source === 'fit' && imp.rr && imp.rr.length > 100)) {
        const comp = computeFeaturesOffline(imp.rr, A.settings.alpha1, A.settings.alpha1.stepSec || 5);
        const laps = imp.laps || []; const stages = laps.length >= 3 ? laps.map((l, i) => ({ idx: i + 1, speed: null, incline: A.settings.protocol.incline, tStart: l.tStart, tEnd: l.tEnd, lactate: null, rpe: null })) : [];
        const sess = { id: uid(), type: stages.length ? 'test' : 'free', startedAt: imp.startedAt, endedAt: imp.endedAt, final: true, sourceKind: 'import:' + (imp.source === 'fit' ? 'fit' : 'fatmaxxer'), filename: imp.filename, rr: comp.rr, features: comp.features, hrLive: imp.hrSeries?.length ? imp.hrSeries : comp.hrLive, stages, events: [], alpha1Settings: { ...A.settings.alpha1 } };
        if (imp.smo2Series?.length) sess.smo2 = { source: imp.source, series: imp.smo2Series.map(p => [p[0], p[1], p[2]]), offsetMs: 0, position: '' };
        sess.metrics = sessionMetrics(sess); await store.putSession(sess); made++;
        await autoAttach(sess);
        toast(`세션 생성 / session created: ${fmtClock(imp.durationSec)}`);
      } else if (imp.source === 'fit' && imp.hrSeries?.length && !imp.smo2Series?.length) {
        const sess = { id: uid(), type: (imp.laps || []).length >= 3 ? 'test' : 'free', startedAt: imp.startedAt, endedAt: imp.endedAt, final: true, sourceKind: 'import:fit-hr', filename: imp.filename, rr: [], features: [], hrLive: imp.hrSeries, stages: (imp.laps || []).length >= 3 ? imp.laps.map((l, i) => ({ idx: i + 1, speed: null, incline: A.settings.protocol.incline, tStart: l.tStart, tEnd: l.tEnd, lactate: null, rpe: null })) : [], events: [] };
        sess.metrics = sessionMetrics(sess); await store.putSession(sess); made++; toast('HR-only session imported');
      } else if (imp.source === 'trainred-csv' || imp.source === 'fit') {
        const rec = { id: uid(), source: imp.source, filename: imp.filename, startedAt: imp.startedAt, endedAt: imp.endedAt, durationSec: imp.durationSec, smo2Series: imp.smo2Series, hrSeries: imp.hrSeries || [], laps: imp.laps || [], meta: imp.meta || {} };
        await store.putImport(rec); made++;
        const target = await findOverlapSession(rec); if (target) { target.smo2 = buildSmo2(target, rec); if (target.type === 'test') target.result = resultFrom(analyzeSession(target)); await store.putSession(target); const al = target.smo2.alignment; toast(`SmO2 자동 연결 / auto-attached → ${fmtDate(target.startedAt)}${al ? (al.ok ? ` · 시간 보정 ${Math.round(target.smo2.offsetMs / 1000)} s ✓` : ' · ⚠ 정렬 확인 필요') : ''}`, 5000); } else toast(`SmO2 가져옴 / imported (${esc(imp.meta?.position || '')}, ${fmtClock(imp.durationSec)})`);
      } else if (imp.source === 'fatmaxxer-features') { await store.putImport({ id: uid(), source: imp.source, filename: imp.filename, startedAt: imp.features[0]?.t, endedAt: imp.features[imp.features.length - 1]?.t, durationSec: ((imp.features[imp.features.length - 1]?.t || 0) - (imp.features[0]?.t || 0)) / 1000, features: imp.features, meta: {} }); made++; toast('FatMaxxer features imported'); }
    } catch (e) { console.error(e); toast(`가져오기 실패 / import failed: ${esc(file.name)} — ${esc(e.message)}`, 4000); }
  }
  if (restored) { if (A.alerts) A.alerts.update(A.settings.alerts); if (A.engine && A.engine.state !== 'running') A.engine.settings = A.settings; }
  if (made) { await refreshLists(); if (restored ? !(A.view === 'live' && A.engine?.state === 'running') : (A.view === 'analysis' && !A.param)) render(); } // after a restore every screen is stale (Settings kept showing the old values)
}
async function findOverlapSession(rec) { const all = await store.listSessions(); let best = null, bestOv = 0; for (const s of all) { if (!s.endedAt) continue; const ov = Math.min(rec.endedAt, s.endedAt) - Math.max(rec.startedAt, s.startedAt); if (ov > bestOv) { bestOv = ov; best = s; } } return bestOv > 0.5 * (rec.endedAt - rec.startedAt) ? best : null; }
/** Build session.smo2 from an import record; align by heart rate when both sides carry HR (same H10). */
function buildSmo2(sess, imp, { overlap = true } = {}) {
  const smo2 = { importId: imp.id, source: imp.source, position: imp.meta?.position || '', series: imp.smo2Series.map(p => [p[0], p[1], p[2]]), offsetMs: overlap ? 0 : (sess.startedAt - imp.startedAt), alignment: null };
  const hrS = sess.hrLive?.length ? sess.hrLive : (sess.features || []).filter(f => f.hrInst > 0).map(f => [f.t, f.hrInst]);
  if (hrS.length >= 60 && imp.hrSeries?.length >= 60) {
    const est = estimateOffsetMs(hrS, imp.hrSeries.map(p => [p[0] + smo2.offsetMs, p[1]]));
    smo2.alignment = { method: 'hr', ok: est.ok, mad: est.mad, n: est.n, estimatedMs: est.offsetMs + smo2.offsetMs };
    if (est.ok && Math.abs(est.offsetMs) >= 1500) smo2.offsetMs += est.offsetMs;
  }
  return smo2;
}
function alignmentText(smo2) {
  const a = smo2?.alignment; if (!a) return '정렬: 시작 시각 기준 (심박 없음 — 수동 확인) / aligned by clock only (no HR to cross-check)';
  const f = (v, d) => Number.isFinite(v) ? v.toFixed(d) : '–'; // (a backup turns NaN into null)
  if (a.method === 'manual') return '정렬: 수동 보정 / aligned by hand';
  if (!a.ok) return `정렬 불확실: 심박 불일치 ${f(a.mad, 1)} bpm — 보정값 확인 / alignment uncertain (HR mismatch ${f(a.mad, 1)} bpm) — check the offset`;
  return `심박 교차검증 ✓ 오차 ${f(a.mad, 2)} bpm, 추정 ${Number.isFinite(a.estimatedMs) ? Math.round(a.estimatedMs / 1000) : '–'} s / HR-verified, ${f(a.mad, 2)} bpm, est. ${Number.isFinite(a.estimatedMs) ? Math.round(a.estimatedMs / 1000) : '–'} s`;
}
async function autoAttach(sess) { if (sess.smo2) return; const imps = await store.listImports(); for (const i of imps) { if (!i.smo2Series?.length) continue; const ov = Math.min(i.endedAt, sess.endedAt) - Math.max(i.startedAt, sess.startedAt); if (ov > 0.5 * (i.endedAt - i.startedAt)) { sess.smo2 = buildSmo2(sess, i); await store.putSession(sess); return; } } }
$('#file-input').addEventListener('change', async e => { const files = [...e.target.files]; e.target.value = ''; if (A.pendingSmo2For) { const id = A.pendingSmo2For; A.pendingSmo2For = null; if (files[0]) await attachSmo2File(id, files[0]); return; } if (A.pendingReplayPick) { A.pendingReplayPick = false; if (files[0]) { try { const imp = await importFile(files[0]); if (!imp.rr?.length) throw new Error('no RR'); A.live.replay = { rr: imp.rr, filename: files[0].name, durationSec: imp.durationSec }; toast(`${imp.rr.length} RR`); } catch (err) { toast('RR 파일이 아닙니다 / not an RR file'); } render(); } return; } await handleFiles(files); });

// ---------- PLAN ----------
async function renderPlan() {
  const z = zonesObj(); if (!z) return `<div class="card"><p>${t('no_zones')}</p><button class="primary" data-action="go-test">${t('start_test')}</button></div>`;
  const week = planWeek(); const all = await store.listSessions(); const ins = assessRecent(all, z, A.settings.zones.updatedAt, { restLactateAt: A.settings.profile.restLactateAt });
  const bf = bandFinder(all, A.settings.zones); A.bandFinder = bf;
  const plan = weeklyPlan(planArgs(z, ins, all, bf, true)); const pc = planCtx(true);
  const todayIdx = new Date().getDay(); const isThisWeek = !(A.settings.plan.weekOffset || 0);
  let html = `<div class="row between"><h2 style="margin:0">${tx('weekly_plan')} · ${weekTag(pc, plan)}</h2><div class="row"><button class="compact ghost" data-action="week-prev">‹</button><button class="compact ghost" data-action="week-next">›</button></div></div>
    <div class="card" style="margin-top:10px">${[1, 2, 3, 4, 5, 6, 0].map(d => plan.days.find(x => x.day === d)).map(d => `<div class="plan-day"><div class="dow ${isThisWeek && d.day === todayIdx ? 'today' : ''}">${DOW.ko[d.day]}<br><span class="small">${DOW.en[d.day]}</span>${d.place ? `<br><span class="small place-tag">${esc(lx(...PLACE_DOW[d.place]))}</span>` : ''}</div><div>${descBlock(`plan-${pc.monday || ''}-${d.day}`, `<div class="type-${d.type}"><b>${esc(d.ko)}</b><span class="en">${esc(d.en)}</span></div><div class="small muted mono">${d.hr ? `${d.hr.hrLo}–${d.hr.hrHi} bpm` : ''}${Array.isArray(d.speed) ? ` · ${d.speed[0].toFixed(1)}${d.speed[1] !== d.speed[0] ? `–${d.speed[1].toFixed(1)}` : ''} km/h` : Number.isFinite(d.speed) ? ` · ${d.speed.toFixed(1)} km/h` : ''}${d.lap ? ` · 400 m ${esc(d.lap)}` : ''}${d.structure ? ` · ${esc((p => lx(p[0], p[1] || p[0]))(d.structure.label.split(' / ')))}` : ''}</div>${(w => (w ? `<div class="small muted mono wu-line">${esc(w)}</div>` : ''))(dayWarmup(d, z))}`, `${d.note ? `<div class="small muted">${esc(d.note.ko)}<span class="en">${esc(d.note.en)}</span></div>` : ''}${d.evening ? `<div class="small eve">점심·저녁${esc(d.evening.ko)}<span class="en">noon · evening ${esc(d.evening.en)}</span></div>` : ''}`)}</div><div class="mins">${d.minutes ? `${d.minutes}′` : '–'}</div></div>`).join('')}
      ${bf.change ? `<button class="primary block" style="margin-top:8px" data-action="apply-band">범위 반영: ${esc(bf.change.ko)} <span class="en">Apply the band change</span></button>` : ''}
      <div class="row"><button class="compact" data-action="copy-plan">${t('copy_summary')}</button></div></div>`;
  html += `<h2>${t('zones_table')}</h2><div class="card"><div class="zone-list">${z.five.map((zz, i) => `<div class="zone-item"><div class="bar" style="background:var(--z${i + 1})"></div><div class="nm"><b>${zz.id}</b> ${esc(zz.ko)}<span class="en">${esc(zz.en)}</span></div><div class="rng">${zz.hrLo || '<'}${zz.hrLo ? '–' : ''}${zz.hrHi} bpm<br><span class="small muted">${Number.isFinite(zz.speedLo) || Number.isFinite(zz.speedHi) ? `${Number.isFinite(zz.speedLo) ? n1(zz.speedLo) : '<'}${Number.isFinite(zz.speedLo) && Number.isFinite(zz.speedHi) ? '–' : ''}${Number.isFinite(zz.speedHi) ? n1(zz.speedHi) : '+'} km/h` : ''}</span></div></div>`).join('')}</div></div>`;
  A.planCache = plan;
  return html;
}

// ---------- SETTINGS ----------
function renderSettings() {
  const s = A.settings; const age = ageFrom(s.profile.birth);
  const num = (path, label, attrs = '') => { const [g, k] = path.split('.'); return `<label class="field">${label}<input type="number" data-set="${path}" value="${s[g][k] ?? ''}" ${attrs}></label>`; };
  const sel = (path, label, opts) => { const [g, k] = path.split('.'); return `<label class="field">${label}<select data-set="${path}">${opts.map(([v, l]) => `<option value="${v}" ${String(s[g][k]) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`; };
  const chk = (path, label) => { const [g, k] = path.split('.'); return `<label class="check"><input type="checkbox" data-set="${path}" ${s[g][k] ? 'checked' : ''}>${label}</label>`; };
  return `<h2>${t('profile')}</h2><div class="card stack">
      <div class="grid2"><label class="field">${t('birth')}<input type="date" data-set="profile.birth" value="${esc(s.profile.birth)}"></label>${num('profile.restHr', t('rest_hr'), 'min="30" max="100"')}</div>
      <div class="grid2">${num('profile.restLactate', '안정 시 젖산 mmol/L / Resting lactate', 'min="0.3" max="4" step="0.1"')}<label class="field">측정일 / measured on<input type="date" data-set="profile.restLactateAt" value="${esc(s.profile.restLactateAt || '')}"></label></div>
      <p class="small muted" style="margin:0">아침 공복·채혈 규칙대로 잰 값. 계단 검사가 없을 때 두 랩 검증의 기준선(안정 시 + 0.5)과 단일 런 LT1 판정(종료 ≤ 안정 시 + 1.0)에 씁니다. 값을 바꾸면 측정일이 오늘로 바뀝니다. 30일이 지나면 홈에 재측정 안내가 뜹니다(검증 달리기 날에는 안정 시 채혈 불필요).<span class="en">Measured fasted, by the sampling rules. The line of the two-lap check (rest + 0.5) when there is no step test, and the single-run LT1 rule (end ≤ rest + 1.0). Changing the value sets the date to today; after 30 days Home reminds you to re-measure (a check day needs no resting sample).</span></p>
      <div class="grid2">${sel('profile.maxHrMode', t('max_hr'), [['tanaka', tx('max_hr_tanaka') + (age != null ? ` = ${Math.round(208 - 0.7 * age)}` : '')], ['manual', '직접 입력 / manual']])}${num('profile.maxHr', 'bpm (manual)', 'min="120" max="230"')}</div>
      <div class="grid2">${sel('profile.lang', t('lang'), [['both', '한국어 + English'], ['enfirst', 'English + 한국어'], ['ko', '한국어'], ['en', 'English']])}${sel('profile.theme', '테마 / Theme', [['system', '시스템 / System'], ['dark', '다크 / Dark'], ['light', '라이트 / Light']])}</div></div>
    <h2>${t('treadmill')}</h2><div class="card stack"><label class="field">모델 / Model<input type="text" data-set="treadmill.model" value="${esc(s.treadmill.model)}"></label>
      <div class="grid3">${num('treadmill.maxSpeed', '최대 km/h', 'step="0.5"')}${num('treadmill.speedStep', '속도 단위 / step', 'step="0.1"')}${num('treadmill.maxIncline', '최대 경사 %', 'step="0.5"')}</div></div>
    <h2>${t('protocol')}</h2><div class="card stack">
      ${sel('protocol.type', '유형 / Type', [['speed', '속도 증가 (경사 고정) / speed steps'], ['incline', '경사 증가 (속도 고정) / incline steps']])}
      <div class="grid3">${num('protocol.startSpeed', '시작 km/h', 'step="0.5"')}${num('protocol.speedStep', '증분 km/h', 'step="0.1"')}${num('protocol.incline', '경사 % (고정)', 'step="0.5"')}</div>
      <div class="grid3">${num('protocol.fixedSpeed', '고정 속도 km/h', 'step="0.5"')}${num('protocol.startIncline', '시작 경사 %', 'step="0.5"')}${num('protocol.inclineStep', '경사 증분 %p', 'step="0.5"')}</div>
      <div class="grid3">${num('protocol.stageSec', '단계 초 / stage s', 'step="30"')}${num('protocol.pauseSec', '채혈 초 / pause s', 'step="5"')}${num('protocol.maxStages', '최대 단계 / max', 'step="1"')}</div>
      <div class="grid3">${num('protocol.warmupSec', '워밍업 초 / warm-up s', 'step="30"')}${num('protocol.warmupSpeed', '워밍업 km/h', 'step="0.5"')}<span></span></div>
      <div class="grid3">${num('protocol.stopLactate', '종료 젖산 mmol/L (하한) / stop lactate (floor)', 'step="0.5"')}${num('protocol.minStagesPast4', '4 mmol 뒤 최소 단계 / stages past 4 mmol', 'min="0" max="4" step="1"')}${num('protocol.stopHrPct', '종료 심박 (최대 심박의 %) / stop HR (% of max)', 'min="80" max="100" step="1"')}</div>
      <p class="small muted">권장: 4분 단계 + 30초 채혈 정지(벨트 양옆 딛기), 경사 1% 고정 — 4분 단계의 ModDmax가 MLSS와 가장 잘 맞음(Jamnick 2018). 가장 낮은 단계(보통 1–2단계)는 스트립 2장 → 두 값 차이 0.5 이내면 평균을 쓰고 LT1 = 최저 + 0.3. <b>종료점은 매번 같게(10/17):</b> 심박 ≥ 최대 심박의 95 % 또는 단계 미완수가 끝이고, 젖산 6.0은 4 mmol 지점에서 두 단계가 지난 뒤에만 끝냅니다(ModDmax는 마지막 점까지 선을 긋기 때문). 식단은 검사 2주 전부터 그대로. 재검사 때도 동일 프로토콜. <b>채혈 초를 0으로 두면 정지 없이 연속 진행(α1 전용 테스트)</b>, 혼자 할 때는 45~60초로 늘려도 됩니다.<span class="en">Recommended: 4-min stages + 30-s sampling pause (straddle the belt), 1% incline fixed — ModDmax from 4-min stages matched MLSS best (Jamnick 2018). Two strips at the lowest stage (usually 1–2) → within 0.5 of each other, their mean is used and LT1 = lowest + 0.3. <b>The same end point every time (Oct 17):</b> HR ≥ 95 % of max or an uncompleted stage ends the test; lactate 6.0 ends it only once two stages past the 4-mmol point are done (ModDmax draws its line to the last point). The diet stays unchanged for the 2 weeks before. Keep the same protocol for retests. <b>Pause = 0 runs the stages back-to-back (α1-only test)</b>; alone, 45–60 s is fine.</span></p></div>
    <h2>${t('alpha_settings')}</h2><div class="card stack">${sel('alpha1.guidance', 'α1 안내·판정 / α1 guidance', [['off', '끄기 — 기록만 / off — record only'], ['on', '켜기 / on']])}<p class="small muted">끄면 α1 칸·차트·표·음성 안내·판정·자동 조정이 모두 사라지고, α1은 뒤에서 계속 기록됩니다(CSV·요약에 남음). 젖산 검사에서 α1이 젖산과 맞으면 다시 켜세요.<span class="en">Off hides the α1 tile, chart line, table columns, voice cue, verdicts and auto-adjust; α1 is still recorded (CSV and summary). Turn it back on if lactate tests show it agrees.</span></p><div class="grid3">${sel('alpha1.artifactMode', '아티팩트 임계 / threshold', [['auto', 'Auto (5%/25%)'], ['0.05', '5%'], ['0.25', '25%'], ['off', '끄기 / off']])}${sel('alpha1.stepSec', '갱신 주기 / update', [[5, '5 s'], [10, '10 s'], [20, '20 s']])}${sel('alpha1.scales', '스케일 / scales', [['fatmaxxer', 'FatMaxxer (3–15)'], ['kubios', '4–16']])}</div>
      <p class="small muted">기본값은 FatMaxxer와 동일(2분 창, smoothness priors λ=500, FatMaxxer 스케일).<span class="en">Defaults match FatMaxxer (2-min window, smoothness priors λ=500, FatMaxxer scales).</span></p></div>
    <h2>${t('alert_settings')}</h2><div class="card stack">${chk('alerts.voice', t('voice'))}${chk('alerts.vibrate', t('vibrate'))}${chk('alerts.beep', t('beep'))}${num('alerts.zoneExitSec', '존 이탈 알림 지연 초 / zone-exit delay s', 'step="5"')}<button data-action="test-alert">${t('test_alert')}</button></div>
    <h2>${t('plan_settings')}</h2><div class="card stack"><div class="grid2">${num('plan.weekdayMin', '평일 분 / weekday min', 'step="5"')}${num('plan.weekendMin', '주말 분 / weekend min', 'step="10"')}</div><p class="small muted" style="margin:0">평일 분이 55 미만이면 쉬운 런이 그만큼 짧아지고, 주말 분은 롱런의 상한입니다(기본 롱런 70 → +10/주 → 100).<span class="en">A weekday allowance below 55 shortens the easy runs; the weekend allowance caps the long run (default 70 → +10 a week → 100).</span></p><div class="grid2">${sel('plan.goal', '목표 / Goal', [['base', tx('goal_base')], ['perf', tx('goal_perf')], ['health', tx('goal_health')]])}<label class="field">블록 1주차 시작일 / Block week-1 start<input type="date" data-set="plan.startDate" value="${esc(s.plan.startDate || '')}"></label></div>
      <label class="field">주 달력 / Week calendar<textarea data-set="plan.calendar" rows="6" style="font-family:var(--mono);font-size:0.85rem" spellcheck="false">${esc(s.plan.calendar || '')}</textarea></label>
      <p class="small muted" style="margin:0">줄마다 <b>날짜 종류 메모</b>. 날짜는 그 주의 아무 날(월요일로 맞춰짐). 종류: <b>recovery</b>(그 주 전체 쉽게: 화 2×8분, 롱런 × 0.7, 근력 가볍게) · <b>mlss</b>(토 = 헬스장 MLSS 검증, 화·일 쉬운 런) · <b>easy</b>(화 쉬운 런, 메모에 이유) · <b>blood</b>(화 쉬운 런 + 목 달리기 없음: 공복 채혈) · <b>step</b>(토 = 헬스장 계단 테스트, 일 쉬운 런) · <b>vo2</b> / <b>ladder</b>(그 주 화요일을 강제로 4×4 / 사다리 — 3 km 검정 2주 전은 두 주 모두 vo2) · <b>test</b>(검정 주: 화 3×4분, 목 쉬운 런 20분 + 스트라이드, 토 롱런 없음) · <b>satoff</b>(토요일 다른 일정: 토 세션을 일요일로, 그 주 일요일 롱런 없음). 평일은 부대(트랙·언덕·무동력, 심박·랩 페이스), 주말은 헬스장 09:00(토 검사, 일 롱런). 고강도 주는 사다리와 4×4를 번갈아 갑니다(홀수 주 사다리, 짝수 주 4×4); recovery·mlss·easy·blood·test 주는 그 수에 세지 않아 번갈기는 멈춘 데서 이어집니다. 사다리 4·8단계는 저절로 회복주(2×8분).<span class="en">One line per entry: <b>date kind note</b>; the date is any day of that week. Kinds: recovery (the whole week easy: Tuesday 2×8, long run × 0.7, strength lighter), mlss (Saturday = the MLSS check at the gym; Tuesday and Sunday easy), easy (Tuesday easy, reason in the note), blood (Tuesday easy + no run on Thursday: a fasted draw), step (Saturday = the step test at the gym, Sunday easy), vo2 / ladder (force that Tuesday — both weeks before a 3-km test take vo2), test (the test week: Tuesday 3×4, Thursday easy 20 + strides, no long run), satoff (Saturday taken: its session moves to Sunday, no long run that Sunday). Weekdays at the unit (track, hill, non-motorized treadmill: heart rate and lap pace), weekends at the gym 09:00 (Saturday the check, Sunday the long run). Hard weeks alternate the ladder and the 4×4 (odd weeks ladder, even weeks 4×4); recovery / mlss / easy / blood / test weeks do not count, so the alternation continues where it stopped. Ladder steps 4 and 8 are recovery weeks (2×8) by themselves.</span></p>
      <button class="compact" data-action="fill-calendar">10/10 계획 달력 채우기 (10/12 시작) <span class="en">Fill in the Oct 10 plan calendar (start 10/12)</span></button></div>
    <h2>역치 직접 입력 <span class="en">Manual thresholds</span></h2><div class="card stack"><div class="grid2">${num('zones.lt1Hr', 'LT1 bpm')}${num('zones.lt1Speed', 'LT1 km/h', 'step="0.1"')}</div><div class="grid2">${num('zones.lt2Hr', 'LT2 bpm')}${num('zones.lt2Speed', 'LT2 km/h', 'step="0.1"')}</div><div class="grid2">${num('zones.testLt1Speed', '계단 검사 LT1 km/h (검증 상한 기준) / step-test LT1 km/h (test-speed cap)', 'step="0.1"')}<p class="small muted" style="align-self:end;margin:0">검증 속도는 이 값 + 0.3까지만 올라갑니다.<span class="en">The test speed rises to this value + 0.3 at most.</span></p></div>
      <div class="grid2">${num('zones.mlssLactate', 'MLSS 젖산 mmol/L (사다리 목표 ± 0.5) / MLSS lactate', 'min="1" max="10" step="0.1"')}${num('zones.pace3k', '3 km 검정 페이스 km/h (스트라이드·4×4 기준) / Test pace, 3 km (km/h)', 'min="8" max="22" step="0.1"')}</div>
      <p class="small muted">MLSS 젖산 = MLSS 검증(두 랩 MLSS 변형)을 통과·유지했을 때의 종료 젖산 — 홈의 MLSS 카드나 세션 카드의 버튼이 넣어 줍니다; 비어 있으면 사다리 목표는 3.0–4.5. 3 km 페이스 = 검정 목표(4:15/km = 14.1; 10/12는 내리막이라 평지 기록으로 다시 잡기): 스트라이드는 이 속도 이상, 4×4는 이 속도 − 1(0.5 단위). 테스트 결과를 적용하면 역치는 자동으로 채워집니다(기본값: 10/10 평가의 LT1 143 @ 8.7, LT2 157 @ 10.5).<span class="en">MLSS lactate = the end value of a passed/held MLSS check (the button on Home's MLSS card or the session card fills it); empty → the ladder target is 3.0–4.5. 3-km pace = the test target (4:15/km = 14.1; the 10/12 run was downhill — re-anchor it with a flat time): strides at this speed or faster, the 4×4 at this speed − 1 (to 0.5). Thresholds fill in automatically when you apply a test result (defaults: the Oct 10 review's LT1 143 @ 8.7, LT2 157 @ 10.5).</span></p></div>
    <h2>채혈 체크리스트 <span class="en">Sampling checklist</span></h2><div class="card"><details><summary>펼치기 / expand</summary><ol class="small" style="padding-left:18px;margin:8px 0 0;line-height:1.6">
      <li>같은 조건: 같은 식사 상태(검증 달리기는 아침 공복), 같은 시각 ± 30분, 전날 고강도 없음, 카페인 없음(전날 14:00부터) <span class="muted">/ same conditions: same fed state (check runs fasted), same clock time ± 30 min, no hard session the day before, no caffeine since 14:00 the day before</span></li>
      <li>달리기 전에 키트 2벌 준비(스트립 2개, 란셋 2개, 알코올 솜, 티슈), 스트립은 15 °C 이상 실온, 측정기는 2분 뒤 자동으로 꺼짐 <span class="muted">/ two kits ready before the run (2 strips, 2 lancets, swabs, tissue); strips at ≥ 15 °C; the meter switches off after 2 min</span></li>
      <li>한 부위만(같은 손가락 쪽): 날마다 자리를 바꾸면 값이 흔들립니다 <span class="muted">/ one site only (same finger side): changing the site moves the value</span></li>
      <li>정지 30–45초 뒤에 채혈, 그동안 서서 기다리기(걷지 않기) <span class="muted">/ sample 30–45 s after the stop, standing still meanwhile (no walking)</span></li>
      <li>땀 닦기 → 손가락 완전히 말리기 → 첫 방울 닦아 내기 → 짜지 않기(밀어 내지 않기) → 둘째 방울로 측정 <span class="muted">/ wipe sweat → dry the finger fully → wipe the first drop → no squeezing or milking → measure the second drop</span></li>
      <li>값이 이상하면(기준선 아래, 또는 두 스트립 차이 > 0.5) 둘째 스트립으로 바로 재측정 <span class="muted">/ an odd value (under the baseline, or two strips > 0.5 apart): repeat at once with the second strip</span></li>
      <li>값은 멈춘 직후, 쿨다운 전에 입력 <span class="muted">/ enter the value right after the stop, before any cool-down</span></li>
    </ol></details></div>
    <h2>테스트 당일 체크리스트 <span class="en">Test-day checklist</span></h2><div class="card"><details open><summary>펼치기 / expand</summary><ol class="small" style="padding-left:18px;margin:8px 0 0;line-height:1.6">
      <li>식후 2시간 이상(계단 테스트는 공복), 전날 고강도 금지, 카페인 없음(전날 14:00부터), 같은 시각 ± 30분 <span class="muted">/ ≥ 2 h after a meal (the step test fasted), no hard session the day before, no caffeine since 14:00 the day before, same clock time ± 30 min</span></li>
      <li>H10 전극 적시기 → Train.Red 앱에서 FYER 시작(허벅지 외측광근) + H10을 심박 센서로 연결 <span class="muted">/ wet the H10 electrodes → start the FYER in the Train.Red app (vastus lateralis) and pair the H10 there too</span></li>
      <li>이 앱: 세션 → 단계 테스트 → H10 연결 → 시작 (화면 켜짐 유지 확인) <span class="muted">/ this app: Session → Step test → Connect H10 → Start (keep screen on)</span></li>
      <li>워밍업 5분 걷기 → 음성 안내대로 단계 진행. 각 단계 끝 "정지. 채혈하세요": 벨트 양옆을 딛고 속도는 그대로 둔 채 30초 안에 채혈·입력 <span class="muted">/ 5-min walk warm-up → follow the voice cues. At "Stop, sample": straddle the belt, keep the speed, sample and enter within 30 s</span></li>
      <li>단계가 바뀔 때마다 Train.Red 앱의 랩 버튼도 누르기 <span class="muted">/ press Lap in the Train.Red app at each stage change</span></li>
      <li>종료 기준: 심박 ≥ 최대 심박의 95 %(30초) 또는 단계를 끝까지 못 달림; 젖산 ≥ 6.0은 4 mmol 지점에서 두 단계가 지난 뒤에만 종료(매번 같은 종료점) → 그 단계까지 하고 종료 → 쿨다운 걷기 <span class="muted">/ stop criterion: HR ≥ 95 % of max (30 s) or a stage cannot be completed; lactate ≥ 6.0 ends the test only once two stages past the 4-mmol point are done (the same end point every time) → finish that stage, then cool down walking</span></li>
      <li>끝나면 Train.Red 앱에서 CSV 내보내기 → 이 앱 분석 탭에서 가져오기(자동 연결) → 삼각측량 확인 → "존에 적용" <span class="muted">/ export the Train.Red CSV → import it in Analysis (auto-attaches) → check the triangulation → Apply</span></li>
    </ol></details></div>
    <h2>${t('data')}</h2><div class="card stack"><button data-action="backup">${t('backup')}</button><button data-action="restore">${t('restore')}</button><button class="danger" data-action="clear-all">${t('clear_all')}</button><p class="small muted">모든 데이터는 이 폰의 브라우저 안에만 저장됩니다. 폰을 바꾸기 전 백업하세요.<span class="en">All data stays in this phone's browser. Back up before changing phones.</span></p>
      <p class="small muted">${A.storagePersisted === true ? '저장소 보호: 켜짐 ✓ (브라우저가 공간 부족으로 지우지 않음)<span class="en">Storage protection: on ✓ (the browser will not evict this data when space runs low)</span>' : A.storagePersisted === false ? '저장소 보호: 꺼짐 — 폰 저장 공간이 부족하면 브라우저가 지울 수 있습니다. 홈 화면에 추가해 쓰고, 가끔 백업하세요.<span class="en">Storage protection: off — the browser may evict this data if the phone runs out of space. Use the home-screen app and back up now and then.</span>' : ''}</p></div>
    <div class="card stack" style="margin-top:14px"><div class="row between"><span class="small">Treadmill Lab <b>v${APP_VERSION}</b></span><button class="compact ghost" data-action="force-update">강제 업데이트 / force update</button></div><p class="small muted">새 버전이 적용되지 않을 때: 캐시를 지우고 다시 불러옵니다 (데이터는 유지).<span class="en">If an update doesn't appear: clears the app cache and reloads (your data is kept).</span></p></div>
    <p class="small muted" style="margin-top:14px">DFA α1 engine matches FatMaxxer alpha1v2 (Apache-2.0) · ${t('disclaimer')}</p>`;
}
function mountSettings() { /* delegated listener registered once in init */ }
async function onSettingsChange(e) {
  if (A.view !== 'settings') return;
  const el = e.target; const path = el.dataset.set; if (!path) return; const [g, k] = path.split('.');
  const val = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? null : +el.value) : numericSetting(g, k, el.value);
  A.settings[g][k] = val; if (g === 'zones') { A.settings.zones.updatedAt = Date.now(); A.settings.zones.source = 'manual'; A.settings.zones.grade = 'manual'; }
  if (path === 'profile.restLactate') { A.settings.profile.restLactateAt = new Date().toISOString().slice(0, 10); const d = document.querySelector('[data-set="profile.restLactateAt"]'); if (d) d.value = A.settings.profile.restLactateAt; } // a new baseline: measured today
  await saveSettings(); if (A.alerts) A.alerts.update(A.settings.alerts); if (A.engine) A.engine.settings = A.settings; toast(tx('saved'), 1200);
  if (path === 'profile.lang' || path === 'profile.maxHrMode' || path === 'profile.birth') render();
}
$('#view').addEventListener('change', onSettingsChange);
$('#view').addEventListener('change', e => { const i = e.target.closest && e.target.closest('.ex-val'); if (i) setExValue(i.dataset.id, i.value); });

// ---------- click actions ----------
async function onViewClick(e) {
  const b = e.target.closest('[data-action]'); if (!b) return; const act = b.dataset.action;
  switch (act) {
    case 'go-test': A.live.mode = 'test'; navigate('live'); break;
    case 'chk': toggleCheck(b.dataset.id); break;
    case 'go-live': A.live.mode = b.dataset.mode || 'lt1'; if (b.dataset.minutes && A.live.mode !== 'verify') A.live.minutes = +b.dataset.minutes; if (A.live.mode === 'verify') { A.live.purpose = b.dataset.purpose === 'mlss' ? 'mlss' : 'lt1'; A.live.laps = { ...A.settings.laps, ...(A.live.purpose === 'mlss' ? { lap2Sec: 1200 } : {}) }; } if (A.live.mode === 'lt2') { let st = null; try { st = b.dataset.structure ? JSON.parse(b.dataset.structure) : null; } catch (e) { st = null; } A.live.lt2 = st || lt2Structure(planWeek()); } A.live.speed = b.dataset.speed ? +b.dataset.speed : null; A.live.surface = SURFACES.includes(b.dataset.surface) ? b.dataset.surface : 'treadmill'; navigate('live'); break; // the speed field opens with the plan's speed for this session (v1.1.26: also the easy run, the long run and the ladder — the session names that speed), not with the last session's
    case 'fill-calendar': confirmBox('주 달력을 10/10 계획(10/12 시작)으로 바꿀까요? 지금 적힌 줄은 지워집니다. / Replace the week calendar with the Oct 10 plan (start 10/12)? The current lines are discarded.', async () => { A.settings.plan.startDate = PLAN_START; A.settings.plan.weekOffset = 0; A.settings.plan.calendar = DEFAULT_CALENDAR; await saveSettings(); render(); toast('주 달력을 채웠습니다 / calendar filled in', 2000); }); break;
    case 'save-mlss-lactate': { const la = +b.dataset.la; if (!Number.isFinite(la)) break; A.settings.zones.mlssLactate = la; await saveSettings(); toast(`MLSS 젖산 ${la} 저장 — 사다리 목표 ${(la - 0.5).toFixed(1)}–${(la + 0.5).toFixed(1)} / saved: ladder target`, 4000); if (A.view === 'analysis' && A.param) await renderSessionDetail(A.param); else render(); break; }
    case 'raise-lt2': { const sp = +b.dataset.speed; if (!Number.isFinite(sp)) break; confirmBox(`LT2 속도를 ${sp} km/h로 올릴까요? (같은 속도에서 MLSS 검증 통과 2회) / Raise the LT2 speed to ${sp} km/h? (two MLSS passes at the same speed)`, async () => { A.settings.zones = { ...A.settings.zones, lt2Speed: sp, source: ((A.settings.zones?.source || 'manual') + ' +mlss').slice(-60), updatedAt: Date.now() }; await saveSettings(); toast(`LT2 ${sp} km/h`, 3000); render(); }); break; }
    case 'apply-band': { const bf = A.bandFinder; if (!bf?.change) break; A.settings.zones = { ...bf.change.zones, source: ((A.settings.zones?.source || 'manual') + ' +band').slice(-60), updatedAt: Date.now() }; if (!A.settings.plan.startDate) A.settings.plan.startDate = new Date().toISOString().slice(0, 10); await saveSettings(); toast(`${tx('applied')} · ${bf.change.ko}`, 5000); if (A.view === 'analysis' && A.param) await renderSessionDetail(A.param); else render(); break; }
    case 'go-settings': navigate('settings'); break;
    case 'import': A.pendingReplayPick = false; A.pendingSmo2For = null; $('#file-input').click(); break;
    case 'pick-replay': A.pendingReplayPick = true; A.pendingSmo2For = null; $('#file-input').click(); break;
    case 'connect': await connectSource(); break;
    case 'start': await startSession(); break;
    case 'lap': A.engine?.lap(); break;
    case 'pause': A.engine?.pauseToggle(); break;
    case 'stop': await stopSession(); break;
    case 'lactate': openLactateModal(A.engine?.stages[A.engine.stageIdx]?.idx ?? null); break;
    case 'mute': if (A.alerts) { A.alerts.muted = !A.alerts.muted; b.textContent = A.alerts.muted ? '🔇' : '🔊'; } break;
    case 'open-session': navigate('analysis', b.dataset.id); break;
    case 'back': navigate('analysis'); break;
    case 'delete-broken': { const id = b.dataset.id; confirmBox(t('delete') + '?', async () => { await store.deleteSession(id); await refreshLists(); navigate('analysis'); }); break; }
    case 'to-nostrap': confirmBox('스트랩 없이 달린 실제 기록으로 바꿀까요? 가짜 심박·α1은 지워지고 되돌릴 수 없습니다. / Convert to a real run without strap? The made-up heart rate and α1 are removed; this cannot be undone.', async () => { const cur = await store.getSession(A.detail.id); if (!cur || cur.sourceKind !== 'demo') return; await store.putSession(asLactateOnly(cur)); await refreshLists(); await refreshDetail(cur.id); toast('젖산만 반영 — 주간 검사에 포함 / Lactate only — now counts in the weekly check'); }); break;
    case 'delete-session': confirmBox(t('delete') + '?', async () => { await store.deleteSession(A.detail.id); await refreshLists(); navigate('analysis'); }); break;
    case 'delete-import': e.stopPropagation(); confirmBox(t('delete') + '?', async () => { await store.deleteImport(b.dataset.id); await refreshLists(); render(); }); break;
    case 'import-detail': { const i = await store.getImport(b.dataset.id); modal(`<h3>${esc(i.filename)}</h3><dl class="kv"><dt>source</dt><dd>${esc(i.source)}</dd><dt>start</dt><dd>${fmtDate(i.startedAt)}</dd><dt>duration</dt><dd>${fmtClock(i.durationSec)}</dd>${i.meta?.position ? `<dt>position</dt><dd>${esc(i.meta.position)}</dd>` : ''}${i.smo2Series ? `<dt>SmO2 pts</dt><dd>${i.smo2Series.length}</dd>` : ''}${i.features ? `<dt>features</dt><dd>${i.features.length}</dd>` : ''}</dl><p class="small muted" style="margin-top:8px">세션 상세에서 「SmO2 파일 붙이기」로 연결하세요. / Attach from a session's detail view.</p>`); break; }
    case 'export-csv': if (A.detail) exportSessionCsv(A.detail); break;
    case 'copy-summary': if (A.detail) { const s = A.detail; const r = analyzeSession(s); copyText(claudeSummary({ profile: { age: ageFrom(A.settings.profile.birth), restHr: A.settings.profile.restHr, restLactate: A.settings.profile.restLactate, maxHr: effectiveMaxHr(), appVersion: APP_VERSION }, zones: zonesObj(), session: s, metrics: sessionMetrics(s), analysis: r, plan: null })); } break;
    case 'copy-plan': copyText(claudeSummary({ profile: { age: ageFrom(A.settings.profile.birth), restHr: A.settings.profile.restHr, restLactate: A.settings.profile.restLactate, maxHr: effectiveMaxHr(), appVersion: APP_VERSION }, zones: zonesObj(), plan: A.planCache })); break;
    case 'attach-smo2': attachSmo2Modal(); break;
    case 'apply-zones': await applyZonesFromDetail(); break;
    case 'apply-verdict': { const ch = A.detail ? verdictZoneChange(A.settings.zones, A.detail) : null; if (!ch) break; A.settings.zones = { ...ch.zones, source: ((A.settings.zones?.source || 'manual') + ' +verify').slice(-60), updatedAt: Date.now() }; if (!A.settings.plan.startDate) A.settings.plan.startDate = new Date().toISOString().slice(0, 10); await saveSettings(); toast(`${tx('applied')} · ${ch.ko}`, 5000); await renderSessionDetail(A.detail.id); break; }
    case 'apply-multiday': { const md = A.multiDay; if (!md?.analysis || !md.trust?.apply) break; const L1 = md.analysis.lt1Primary, L2 = md.analysis.lt2Primary; A.settings.zones = { lt1Hr: Math.round(L1.hr), lt2Hr: Math.round(L2.hr), lt1Speed: Math.round(L1.x * 10) / 10, lt2Speed: Math.round(L2.x * 10) / 10, source: 'multi-day lactate', grade: `${md.grade}/${md.grade}`, updatedAt: Date.now(), testSessionId: null }; if (!A.settings.plan.startDate) A.settings.plan.startDate = new Date().toISOString().slice(0, 10); await saveSettings(); toast(tx('applied')); render(); break; }
    case 'week-prev': A.settings.plan.weekOffset = (A.settings.plan.weekOffset || 0) - 1; await saveSettings(); render(); break;
    case 'week-next': A.settings.plan.weekOffset = (A.settings.plan.weekOffset || 0) + 1; await saveSettings(); render(); break;
    case 'test-alert': if (!A.alerts) A.alerts = new Alerts(A.settings.alerts); A.alerts.update(A.settings.alerts); A.alerts.unlock(); A.alerts.cue('알림 테스트. 3단계, 시속 8 킬로미터.', { beep: 'double', vib: [300, 100, 300] }); break;
    case 'force-update': { try { if ('serviceWorker' in navigator) { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } if (window.caches) { for (const k of await caches.keys()) await caches.delete(k); } } catch (e) { console.warn(e); } location.reload(); break; }
    case 'backup': download(`treadmill-lab-backup_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await store.exportAll()), 'application/json'); break;
    case 'restore': A.pendingReplayPick = false; A.pendingSmo2For = null; $('#file-input').click(); break;
    case 'clear-all': confirmBox(t('clear_all') + '?', async () => { await store.clearAll(); A.settings = freshDefaults(); A.settings.migr = { z1117: Date.now(), oct5: Date.now(), z1118: Date.now() }; /* a wiped app stays empty: the one-time fixes do not run again */ await saveSettings(); if (A.alerts) A.alerts.update(A.settings.alerts); if (A.engine) A.engine.settings = A.settings; await refreshLists(); navigate('home'); }); break;
    default: break;
  }
}

// ---------- one-time data fixes (v1.1.17) ----------
/**
 * z1117: the thresholds of the Oct 10 review — LT1 143 bpm @ 8.7 km/h, LT2 157 @ 10.5 (the app had set 147 @ 8.5 from a drifted
 * last-5-min heart rate); testLt1Speed 8.7 caps the weekly test speed. Editable in Settings afterwards.
 * oct5: the 10/5 card carried a 0.5 mmol/L value (rest or end) that was not a reliable sample (sampling rules not yet followed):
 * the field is emptied — the value is kept in session.lactateChecksRemoved and the logged event stays in the record.
 */
export const REVIEW_ZONES = { lt1Hr: 143, lt2Hr: 157, lt1Speed: 8.7, lt2Speed: 10.5, testLt1Speed: 8.7, source: 'review 2026-10-10 (manual)', grade: 'B/B' };
/** z1118: the week calendar of the Oct 10 decisions — block week 1 = the week of 10/12; the weeks that are not ladder weeks; the step tests. Editable in Settings → Plan. */
export const PLAN_START = '2026-10-12';
export const DEFAULT_CALENDAR = ['2026-10-12 recovery 회복주 / recovery week', '2026-10-19 mlss MLSS 검증 (10/25 일, 헬스장) / MLSS check (Sun 10/25, gym)', '2026-10-19 satoff 토익 스피킹 10/24(토) / TOEIC Speaking Sat 10/24', '2026-10-26 step 계단 테스트 60분 (10/31 토) / step test 60 min (Sat 10/31)', '2026-11-09 blood 혈액검사 11/12(목) 07:00 공복 — 48시간 규칙 / blood test Thu 11/12 07:00 fasted — the 48-h rule', '2026-11-30 step 계단 테스트 40분 (12/5 토) / step test 40 min (Sat 12/5)'].join('\n');
export function oct5Fix(session, { day = '2026-10-05', value = 0.5 } = {}) {
  if (!session || session.type === 'test' || !Number.isFinite(session.startedAt)) return null;
  const d = new Date(session.startedAt); const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; if (local !== day) return null;
  const c = lactateChecks(session); const removed = {}; for (const k of ['rest', 'end']) if (c[k] === value) removed[k] = value;
  if (!Object.keys(removed).length) return null;
  const typed = typedChecks(session); for (const k in removed) typed[k] = null;
  return { lactateChecks: typed, lactateChecksV: 2, lactateChecksRemoved: { ...(session.lactateChecksRemoved || {}), ...removed, at: Date.now(), why: `v1.1.17: unreliable ${value} value on ${day} emptied (kept here)` } };
}
async function runMigrations() {
  const M = A.settings.migr || (A.settings.migr = { z1117: null, oct5: null, z1118: null }); let changed = false;
  const existed = !!M.z1118; // (an install that has run before: a fresh one gets the default settings)
  // v1.1.30 (owner: "아직도 언어가 안 바뀌었는데?" — English first was an option to pick, the app kept Korean first): an existing install still on the
  // default "한국어 + English" moves to "English + 한국어" once; Settings → language switches back. A language chosen on purpose (한국어 / English) is kept.
  if (!M.lang1130) { if (existed && A.settings.profile.lang === 'both') { A.settings.profile.lang = 'enfirst'; toast('Display language: English first, Korean under it (Settings → language to change) / 표시 언어: 영어 먼저, 한국어 아래 (설정 → 언어에서 변경)'); } M.lang1130 = Date.now(); changed = true; }
  // v1.1.31 (owner asked to apply the review: 4-min stages match MLSS best, Jamnick 2018): an install still on the old default 3-min stage moves to 4 min once; any other length chosen on purpose is kept.
  if (!M.stage1131) { if (existed && Number(A.settings.protocol?.stageSec) === 180) { A.settings.protocol.stageSec = 240; toast('Step test: 4-min stages (Settings → protocol) / 계단 검사: 4분 단계 (설정 → 프로토콜)'); } M.stage1131 = Date.now(); changed = true; }
  if (!M.z1118) { const p = A.settings.plan; if (!p.startDate || p.startDate < PLAN_START) p.startDate = PLAN_START; p.weekOffset = 0; if (!p.calendar) p.calendar = DEFAULT_CALENDAR; M.z1118 = Date.now(); changed = true; toast('주간 계획을 10/10 결정대로 바꿨습니다: 화 고강도 · 목 두 랩 검증 · 토 롱런 · 저녁 운동, 주 달력 10/12 시작 (설정에서 변경 가능) / Weekly plan set to the Oct 10 structure; week calendar from 10/12 (editable in Settings)', 8000); }
  if (!M.z1135) { const z = A.settings.zones || {}; if (!Number.isFinite(z.pace3k)) A.settings.zones.pace3k = 14.1; if (!Number.isFinite(A.settings.protocol.minStagesPast4)) A.settings.protocol.minStagesPast4 = 2; M.z1135 = Date.now(); changed = true; toast('10/17 재검토 반영: 화요일 사다리 ↔ 4×4 격주, 금요일 휴식, 검사 단계 0.3, 세션 RPE, 3 km 페이스 14.1(설정에서 변경) / Oct 17 review applied: ladder ↔ 4×4 on alternate Tuesdays, Friday rest, 0.3-km/h check steps, session RPE, 3-km pace 14.1 (editable in Settings)', 9000); }
  // v1.1.36 (owner, 2026-10-19: weekdays at the unit, weekends at the gym from 09:00): the checks moved to the weekend — the MLSS check of the
  // week of 10/19 runs on Sunday 10/25 (Saturday 10/24 is the TOEIC Speaking test). The calendar line is added once if that week holds an mlss line.
  if (!M.z1136) { const p = A.settings.plan; const cal = String(p.calendar || ''); if (/^2026-10-(19|2[0-5])\s+mlss\b/m.test(cal) && !/^2026-10-(19|2[0-5])\s+satoff\b/m.test(cal)) p.calendar = cal.replace(/\s*$/, '') + '\n2026-10-19 satoff 토익 스피킹 10/24(토) / TOEIC Speaking Sat 10/24'; M.z1136 = Date.now(); changed = true; toast('주간 계획: 평일 부대(트랙·언덕·무동력, 심박·랩 페이스) · 주말 헬스장 09:00(토 검사 · 일 롱런). 이번 주 MLSS 검증은 10/25(일) / Weekly plan: weekdays at the unit (track, hill, non-motorized: heart rate, lap pace) · weekends at the gym 09:00 (Sat check · Sun long run). This week\'s MLSS check: Sun 10/25', 10000); }
  if (!M.z1117) { const z = A.settings.zones || {}; const same = ['lt1Hr', 'lt2Hr', 'lt1Speed', 'lt2Speed'].every(k => z[k] === REVIEW_ZONES[k]); if (!same) { A.settings.zones = { ...z, ...REVIEW_ZONES, updatedAt: Date.now() }; toast('역치를 10/10 평가값으로 설정: LT1 143 @ 8.7 · LT2 157 @ 10.5 (설정에서 변경 가능) / Thresholds set to the Oct 10 review values', 7000); } else if (!Number.isFinite(z.testLt1Speed)) A.settings.zones.testLt1Speed = REVIEW_ZONES.testLt1Speed; M.z1117 = Date.now(); changed = true; }
  if (!M.oct5) { let n = 0; for (const sum of A.sessions) { const d = new Date(sum.startedAt); if (!(d.getFullYear() === 2026 && d.getMonth() === 9 && d.getDate() === 5)) continue; const full = await store.getSession(sum.id); const fix = oct5Fix(full); if (!fix) continue; Object.assign(full, fix); full.metrics = sessionMetrics(full); await store.putSession(full); n++; } if (n) { toast(`10/5 카드의 0.5 값 ${n}건을 비웠습니다(기록에는 남음) / emptied ${n} unreliable 0.5 value(s) on the 10/5 card (kept in the record)`, 7000); await refreshLists(); } M.oct5 = Date.now(); changed = true; }
  if (changed) await saveSettings();
}
// ---------- init ----------
(async function init() {
  const saved = await store.getSettings(); A.settings = coerceSettings(deepMerge(freshDefaults(), saved || {})); setRestBaseline(A.settings.profile.restLactate); setMlssLactate(A.settings.zones.mlssLactate); setAlphaUse(A1());
  setLang(A.settings.profile.lang); applyTheme(); applyLang();
  await refreshLists();
  try { await runMigrations(); } catch (e) { console.error('migrations', e); } // (one-time data fixes of v1.1.17; a failure must not stop the app)
  try { A.bandFinder = bandFinder(await store.listSessions(), A.settings.zones); } catch (e) { console.error('band finder', e); } // (the Session tab's test speed, before Home has been shown)
  let v = 'home'; try { v = localStorage.getItem('tl.view') || 'home'; } catch (e) { /* ignore */ }
  if (v === 'analysis' || v === 'live') v = 'home';
  navigate(v);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    try { const reg = await navigator.serviceWorker.register('./sw.js'); reg.addEventListener('updatefound', () => { const nw = reg.installing; nw && nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) { toast('새 버전이 있습니다 — 새로고침하세요 / Update available — reload', 6000); } }); }); } catch (e) { console.warn('sw', e); }
  }
  // Ask the browser to keep this site's data (sessions live only in IndexedDB); Chrome decides without a prompt.
  (async () => { try { if (navigator.storage && navigator.storage.persist) { A.storagePersisted = await navigator.storage.persisted(); if (!A.storagePersisted) A.storagePersisted = await navigator.storage.persist(); } } catch (e) { /* not supported */ } })(); // never blocks start-up
  window.addEventListener('beforeunload', ev => { if (A.engine && A.engine.state === 'running') { ev.preventDefault(); ev.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && A.alerts?.wakeLock == null && A.engine?.state === 'running') A.alerts.keepAwake(true); });
  A.saveSettings = saveSettings; A.navigate = navigate; A.refreshLists = refreshLists;
  window.TL = A; // debugging hook
})();

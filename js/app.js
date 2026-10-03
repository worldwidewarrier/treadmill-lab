// Treadmill Lab — app shell, views and wiring.
import { t, tx, setLang, S } from './i18n.js';
import { store, uid } from './store.js';
import { Alerts } from './alerts.js';
import { HeartRateSource } from './ble.js';
import { ReplaySource, DemoSource, demoProfileForEngine } from './sources.js';
import { SessionEngine, DEFAULT_PROTOCOL, DEFAULT_INTERVALS, buildStages, computeFeaturesOffline } from './session.js';
import { analyzeSession, summarizeStages } from './analysis.js';
import { computeZones, sessionTargets, weeklyPlan, lt2Structure, sessionMetrics, assessRecent, sessionSummaryText, claudeSummary, lactateChecks, lactateVerdict, multiDayCurve, endWindowStats } from './prescribe.js';
import { importFile } from './importers.js';
import { liveChart, timelineChart, stepTestChart, trendChart } from './charts.js';

// ---------- defaults ----------
const DEFAULTS = {
  profile: { birth: '1997-07-21', restHr: 52, maxHr: 188, maxHrMode: 'tanaka', lang: 'both', theme: 'system' },
  treadmill: { model: 'LTSXL', minSpeed: 0.8, maxSpeed: 18, speedStep: 0.1, maxIncline: 15, inclineStep: 0.5 },
  protocol: { ...DEFAULT_PROTOCOL },
  alpha1: { windowSec: 120, stepSec: 5, artifactMode: 'auto', lambda: 500, scales: 'fatmaxxer' },
  alerts: { voice: true, vibrate: true, beep: true, zoneExitSec: 30, volume: 1 },
  plan: { weekdayMin: 60, weekendMin: 150, goal: 'base', startDate: null, weekOffset: 0 },
  zones: { lt1Hr: null, lt2Hr: null, lt1Speed: null, lt2Speed: null, source: '', grade: '', updatedAt: null, testSessionId: null },
};
const deepMerge = (a, b) => { const o = { ...a }; for (const k in b) o[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) ? deepMerge(a[k] || {}, b[k]) : b[k]; return o; };

const A = { settings: null, view: 'home', sessions: [], imports: [], engine: null, source: null, alerts: null, live: { chart: null, mode: 'test', sourceKind: 'ble', demoSpeed: 10, replay: null, replaySpeed: 10, minutes: 50 }, detail: null, charts: [] };

// ---------- utilities ----------
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtClock = sec => { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; };
const fmtDate = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const n1 = v => Number.isFinite(v) ? (Math.round(v * 10) / 10).toFixed(1) : '–';
const n0 = v => Number.isFinite(v) ? String(Math.round(v)) : '–';
const n2 = v => Number.isFinite(v) ? v.toFixed(2) : '–';
const DOW = { ko: ['일', '월', '화', '수', '목', '금', '토'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] };
const typeLabel = ty => ({ test: t('mode_test'), lt1: t('mode_lt1'), lt2: t('mode_lt2'), free: t('mode_free') }[ty] || esc(ty));
function toast(msg, ms = 2600) { const r = $('#toast-root'); r.innerHTML = `<div class="toast">${msg}</div>`; clearTimeout(toast._t); toast._t = setTimeout(() => { r.innerHTML = ''; }, ms); }
function modal(html, onMount) { const root = $('#modal-root'); root.innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`; const close = () => { root.innerHTML = ''; }; root.querySelector('.modal-bg').addEventListener('click', e => { if (e.target.classList.contains('modal-bg')) close(); }); if (onMount) onMount(root.querySelector('.modal'), close); return close; }
function confirmBox(msgHtml, onYes) { modal(`<p>${msgHtml}</p><div class="grid2"><button class="ghost" data-x="no">${t('no')}</button><button class="danger" data-x="yes">${t('yes')}</button></div>`, (m, close) => { m.querySelector('[data-x=no]').onclick = close; m.querySelector('[data-x=yes]').onclick = () => { close(); onYes(); }; }); }
function download(name, text, type = 'text/plain') { const blob = new Blob([text], { type }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000); }
async function copyText(text) { try { await navigator.clipboard.writeText(text); toast(tx('saved') + ' → 📋'); } catch (e) { modal(`<textarea readonly style="min-height:50vh">${esc(text)}</textarea><p class="small muted">자동 복사가 막혔습니다. 길게 눌러 복사하세요. / Clipboard blocked — long-press to copy.</p>`); } }
function ageFrom(birth) { const b = new Date(birth); if (isNaN(b)) return null; const now = new Date(); let a = now.getFullYear() - b.getFullYear(); if (now < new Date(now.getFullYear(), b.getMonth(), b.getDate())) a--; return a; }
function effectiveMaxHr() { const p = A.settings.profile; if (p.maxHrMode === 'tanaka') { const age = ageFrom(p.birth); return age != null ? Math.round(208 - 0.7 * age) : p.maxHr; } return p.maxHr; }
function zonesObj() { const z = A.settings.zones; if (!Number.isFinite(z.lt1Hr) || !Number.isFinite(z.lt2Hr)) return null; return { ...computeZones({ ...z, maxHr: effectiveMaxHr() }), grade: z.grade, updatedAt: z.updatedAt, source: z.source }; }
function planWeek() { const p = A.settings.plan; const start = p.startDate ? new Date(p.startDate).getTime() : (A.settings.zones.updatedAt || Date.now()); const w = Math.floor((Date.now() - start) / (7 * 86400000)) + 1 + (p.weekOffset || 0); return Math.max(1, w); }
function applyTheme() { const th = A.settings.profile.theme; if (th === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', th); }
async function saveSettings() { await store.saveSettings(A.settings); setLang(A.settings.profile.lang); applyTheme(); }
function destroyCharts() { for (const c of A.charts) { try { c.destroy(); } catch (e) { /* ignore */ } } A.charts = []; }

// ---------- router ----------
function navigate(view, param = null) { A.view = view; A.param = param; destroyCharts(); render(); try { localStorage.setItem('tl.view', view); } catch (e) { /* ignore */ } window.scrollTo(0, 0); }
async function render() {
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === A.view));
  const v = $('#view');
  if (A.view === 'home') v.innerHTML = await renderHome();
  else if (A.view === 'live') { v.innerHTML = renderLive(); mountLive(); }
  else if (A.view === 'analysis') { v.innerHTML = A.param ? '<p class="muted">…</p>' : await renderAnalysisList(); if (A.param) await renderSessionDetail(A.param); }
  else if (A.view === 'plan') v.innerHTML = await renderPlan();
  else if (A.view === 'settings') { v.innerHTML = renderSettings(); mountSettings(); }
  updateConnChip();
}
document.getElementById('nav').addEventListener('click', e => { const b = e.target.closest('button'); if (b) navigate(b.dataset.view); });
$('#view').addEventListener('click', onViewClick);

// ---------- HOME ----------
async function renderHome() {
  const z = zonesObj(); const week = planWeek();
  const sessions = A.sessions; const lastTest = sessions.find(s => s.type === 'test' && s.final); const last = sessions.find(s => s.final);
  const ins = assessRecent(await store.listSessions(), z, A.settings.zones.updatedAt);
  const plan = z ? weeklyPlan({ zones: z, week, weekdayMin: A.settings.plan.weekdayMin, weekendMin: A.settings.plan.weekendMin, goal: A.settings.plan.goal, lt1Adjust: ins.lt1Adjust }) : null;
  const todayIdx = new Date().getDay(); const today = plan ? plan.days.find(d => d.day === todayIdx) : null;
  let html = `<h2>${t('zones_title')}</h2>`;
  if (z) html += `<div class="card accent"><div class="thr-card">
      <div class="box"><div class="small muted">${t('lt1')}</div><div class="v">${n0(z.lt1Hr)}<small> bpm</small></div><div class="small">${Number.isFinite(z.lt1Speed) ? n1(z.lt1Speed) + ' km/h' : ''}</div></div>
      <div class="box"><div class="small muted">${t('lt2')}</div><div class="v">${n0(z.lt2Hr)}<small> bpm</small></div><div class="small">${Number.isFinite(z.lt2Speed) ? n1(z.lt2Speed) + ' km/h' : ''}</div></div></div>
      <p class="small muted" style="margin:8px 0 0">${t('source')}: ${esc(z.source || '')} · ${t('grade')}: ${esc(z.grade || '–')} · ${z.updatedAt ? fmtDate(z.updatedAt) : ''}</p></div>`;
  else html += `<div class="card"><p>${t('no_zones')}</p><div class="grid2"><button class="primary" data-action="go-test">${t('start_test')}</button><button data-action="import">${t('import_file')}</button></div></div>`;
  html += `<h2>${t('today')}</h2>`;
  if (today) {
    const hrTxt = today.hr ? `${today.hr.hrLo}–${today.hr.hrHi} bpm` : '';
    html += `<div class="card"><div class="row between"><div><div class="small muted">${DOW.ko[todayIdx]} / ${DOW.en[todayIdx]} · ${t('week')} ${week}${plan.recovery ? ' · 회복주 / recovery' : ''}</div><h3 class="type-${today.type}">${esc(today.ko)}<span class="en">${esc(today.en)}</span></h3><div class="mono">${today.minutes} min · ${hrTxt}</div></div></div>
      <div class="grid2" style="margin-top:10px"><button class="primary big" data-action="go-live" data-mode="${today.type === 'lt2' || today.type === 'tempo' ? 'lt2' : 'lt1'}" data-minutes="${today.minutes}">${t('start_session')}</button><button data-action="go-test">${t('start_test')}</button></div></div>`;
  } else html += `<div class="card"><p class="muted">${t('no_zones')}</p></div>`;
  if (ins.notes.length) { html += `<h2>${t('insights')}</h2><div class="card stack">` + ins.notes.map(n => `<div class="notice ${n.kind === 'retest' || n.kind === 'adjust' ? 'warn' : ''}"><span class="ko">${esc(n.ko)}</span><span class="en">${esc(n.en)}</span></div>`).join('') + '</div>'; }
  if (last) { const m = sessionMetrics(last); html += `<h2>${t('last_session')}</h2><div class="card list-item" data-action="open-session" data-id="${last.id}"><div><div class="t">${typeLabel(last.type)} · ${fmtDate(last.startedAt)}</div><div class="s">${fmtClock(m.durationSec)} · HR ${n0(m.meanHr)} · α1 ${n2(m.meanAlpha1)}${last.type === 'test' && last.result ? ` · LT1 ${n0(last.result.lt1Hr)} / LT2 ${n0(last.result.lt2Hr)}` : ''}</div></div><div>›</div></div>`; }
  html += `<p class="small muted" style="margin-top:18px">${t('disclaimer')}</p>`;
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
  let html = '';
  if (!running) {
    html += `<h2>${t('mode')}</h2><div class="segment" id="mode-seg">${['test', 'lt1', 'lt2', 'free'].map(m => `<button class="${L.mode === m ? 'active' : ''}" data-mode="${m}">${t('mode_' + m)}</button>`).join('')}</div>`;
    // mode-specific setup
    if (L.mode === 'test') {
      const P = A.settings.protocol; const stages = buildStages(P, A.settings.treadmill);
      html += `<div class="card" style="margin-top:10px"><div class="row between"><h3>${t('protocol')}</h3><button class="compact ghost" data-action="go-settings">${t('nav_settings')}</button></div>
        <div class="segment" id="pause-seg" style="margin:6px 0 10px"><button class="${P.pauseSec > 0 ? 'active' : ''}" data-pause="30">채혈 정지 30초<span class="en">30-s sampling pause</span></button><button class="${P.pauseSec > 0 ? '' : 'active'}" data-pause="0">연속 · 채혈 없음 (혼자)<span class="en">Continuous · no sampling (solo)</span></button></div>
        <p class="small">${P.type === 'speed' ? `경사 ${P.incline}% 고정 · ${P.startSpeed} km/h부터 +${P.speedStep} km/h` : `속도 ${P.fixedSpeed} km/h 고정 · 경사 ${P.startIncline}%부터 +${P.inclineStep}%p`} · ${P.stageSec / 60}분 + 채혈 ${P.pauseSec}초 · 워밍업 ${P.warmupSec / 60}분 @ ${P.warmupSpeed} km/h<span class="en">${P.type === 'speed' ? `${P.incline}% incline fixed · from ${P.startSpeed} km/h, +${P.speedStep} km/h` : `${P.fixedSpeed} km/h fixed · from ${P.startIncline}%, +${P.inclineStep}%`} · ${P.stageSec / 60} min + ${P.pauseSec}-s sampling · warm-up ${P.warmupSec / 60} min @ ${P.warmupSpeed} km/h</span></p>
        <p class="small muted">${t('stop_criteria', { la: P.stopLactate, rpe: P.stopRpe })}</p>
        <div class="small mono">${stages.map(s => `${s.idx}: ${s.speed}${P.type === 'incline' ? `/${s.incline}%` : ''}`).join(' · ')}</div></div>`;
    } else if (L.mode === 'lt1') {
      const T = z ? sessionTargets(z, 'lt1', { minutes: L.minutes }) : null;
      html += `<div class="card" style="margin-top:10px"><h3>${t('mode_lt1')}</h3>${T ? `<p>${t('target')}: <b class="mono">${T.hrLo}–${T.hrHi} bpm</b> · α1 ≥ 0.75${Number.isFinite(T.speedLo) ? ` · ≈ ${n1(T.speedLo)}–${n1(T.speedHi)} km/h` : ''}</p>` : `<p class="muted">${t('no_zones')}</p>`}
        <div class="grid3"><label class="field">${t('duration')} (min)<input type="number" id="lt1-min" value="${L.minutes}" min="10" max="300" step="5"></label><label class="field">러닝머신 km/h<input type="number" id="sess-speed" step="0.1" value="${L.speed ?? (T && Number.isFinite(T.speedLo) ? ((T.speedLo + T.speedHi) / 2).toFixed(1) : '')}"></label><label class="field">경사 %<input type="number" id="sess-incline" step="0.5" value="${L.incline ?? A.settings.protocol.incline}"></label></div>
        <p class="small muted">속도를 적어 두면 종료 시 젖산 한 방울로 "검증 세션"이 됩니다(혼자 측정용). <span class="en">Enter the treadmill speed so an end-of-run lactate sample turns this into a verification run.</span></p></div>`;
    } else if (L.mode === 'lt2') {
      const T = z ? sessionTargets(z, 'lt2') : null; const st = L.lt2 || lt2Structure(planWeek()) || { reps: 4, workSec: 480, restSec: 180, warmupSec: 600, cooldownSec: 360 }; L.lt2 = st;
      html += `<div class="card" style="margin-top:10px"><h3>${t('mode_lt2')}</h3>${T ? `<p>${t('target')}: <b class="mono">${T.hrLo}–${T.hrHi} bpm</b>${Number.isFinite(T.speedLo) ? ` · ≈ ${n1(T.speedLo)}–${n1(T.speedHi)} km/h` : ''}</p>` : `<p class="muted">${t('no_zones')}</p>`}
        <div class="grid3"><label class="field">반복 / reps<input type="number" id="lt2-reps" value="${st.reps}" min="1" max="10"></label><label class="field">운동 / work (min)<input type="number" id="lt2-work" value="${st.workSec / 60}" min="1" max="60"></label><label class="field">회복 / rest (min)<input type="number" id="lt2-rest" value="${st.restSec / 60}" min="0" max="15"></label></div>
        <div class="grid2" style="margin-top:8px"><label class="field">${t('warmup')} (min)<input type="number" id="lt2-wu" value="${st.warmupSec / 60}" min="0" max="30"></label><label class="field">쿨다운 / cool-down (min)<input type="number" id="lt2-cd" value="${st.cooldownSec / 60}" min="0" max="30"></label></div>
        <div class="grid2" style="margin-top:8px"><label class="field">인터벌 속도 km/h<input type="number" id="sess-speed" step="0.1" value="${L.speed ?? (T && Number.isFinite(T.speedHi) ? T.speedHi : '')}"></label><label class="field">경사 %<input type="number" id="sess-incline" step="0.5" value="${L.incline ?? A.settings.protocol.incline}"></label></div>
        <p class="small muted">MLSS 검증: 1회 반복을 30분으로 두고 10분·30분에 젖산을 찍으면 상승폭(≤1.0)으로 LT2를 확인합니다. <span class="en">MLSS check: use one 30-min rep with lactate at 10 and 30 min; a rise ≤1.0 mmol/L confirms LT2.</span></p></div>`;
    } else html += `<div class="card" style="margin-top:10px"><p class="muted">심박·α1만 모니터링합니다. 랩 버튼으로 구간을 표시할 수 있습니다.<span class="en">Monitors HR and α1 only; use Lap to mark segments.</span></p><div class="grid2"><label class="field">러닝머신 km/h<input type="number" id="sess-speed" step="0.1" value="${L.speed ?? ''}"></label><label class="field">경사 %<input type="number" id="sess-incline" step="0.5" value="${L.incline ?? A.settings.protocol.incline}"></label></div></div>`;
    // source
    html += `<h2>센서 <span class="en">Sensor</span></h2><div class="segment" id="src-seg"><button class="${L.sourceKind === 'ble' ? 'active' : ''}" data-src="ble" ${bleOk ? '' : 'disabled'}>${t('source_ble')}</button><button class="${L.sourceKind === 'demo' ? 'active' : ''}" data-src="demo">${t('source_demo')}</button><button class="${L.sourceKind === 'replay' ? 'active' : ''}" data-src="replay">${t('source_replay')}</button></div>`;
    html += `<p class="small" id="ble-diag" style="margin-top:6px"></p>`;
    if (L.sourceKind === 'demo') html += `<div class="card" style="margin-top:10px"><label class="field">${t('demo_speed')}<select id="demo-speed">${[1, 5, 10, 30, 60].map(s => `<option value="${s}" ${L.demoSpeed === s ? 'selected' : ''}>×${s}</option>`).join('')}</select></label><p class="small muted">가상 스트랩이 프로토콜을 따라 심박·α1을 만들어냅니다. 젖산은 직접 입력하세요(연습용 값: 1.0 → 1.2 → 1.5 → 2.0 → 3.0 → 4.5 → 7).<span class="en">A virtual strap follows the protocol; type lactate values yourself (practice: 1.0 → 1.2 → 1.5 → 2.0 → 3.0 → 4.5 → 7).</span></p></div>`;
    if (L.sourceKind === 'replay') html += `<div class="card" style="margin-top:10px"><div class="row"><button data-action="pick-replay">${t('replay_pick')}</button><span class="small muted">${L.replay ? esc(L.replay.filename) + ` · ${L.replay.rr.length} RR · ${fmtClock(L.replay.durationSec)}` : 'FatMaxxer rr.csv'}</span></div><label class="field" style="margin-top:8px">${t('demo_speed')}<select id="replay-speed">${[1, 5, 10, 30, 60].map(s => `<option value="${s}" ${L.replaySpeed === s ? 'selected' : ''}>×${s}</option>`).join('')}</select></label></div>`;
    const connected = A.source && (A.source.status === 'connected');
    html += `<div class="grid2" style="margin-top:14px"><button class="big ${connected ? '' : 'primary'}" data-action="connect" ${connected ? 'disabled' : ''}>${connected ? t('connected') : t('connect')}</button><button class="big ${connected ? 'primary' : ''}" data-action="start" ${connected ? '' : 'disabled'}>${t('start')}</button></div>
      ${A.lastBleError ? `<p class="notice warn small" style="margin-top:10px">${esc(A.lastBleError)}</p>` : ''}
      <div class="stats" style="margin-top:10px"><div>${t('hr')}<b id="pre-hr">${v.hr ?? '–'}</b></div><div>RR<b id="pre-rr">${v.samples}</b></div><div>${t('battery')}<b id="pre-batt">${A.source?.battery != null ? A.source.battery + '%' : '–'}</b></div><div>상태<b id="pre-status" style="font-size:0.8rem">${esc(v.source.status)}</b></div></div>`;
    return html;
  }
  // running / finished layout (updated in place)
  html += `<div class="live-big">
      <div class="metric hr"><div class="lbl"><span>${tx('hr')}</span><span id="lv-contact"></span></div><div class="val" id="lv-hr">–</div><div class="sub" id="lv-hr-sub"></div></div>
      <div class="metric a1 na" id="lv-a1-box"><div class="lbl"><span>DFA α1</span><span id="lv-art"></span></div><div class="val" id="lv-a1">–</div><div class="sub" id="lv-a1-sub">${tx('waiting')}</div></div>
    </div>
    <div class="zone-banner rest" id="lv-zone" style="margin-top:10px"><span class="dot"></span><span id="lv-zone-text">–</span></div>
    <div class="phase" id="lv-phase" style="margin-top:10px"><div class="row between"><div class="small muted" id="lv-phase-lbl">–</div><div class="small muted mono" id="lv-elapsed">0:00</div></div><div class="row between"><div class="big" id="lv-phase-time">–</div><div id="lv-phase-info" class="small" style="text-align:right"></div></div><div class="progress"><div id="lv-prog"></div></div></div>
    <div class="controls" style="margin-top:10px"><button id="lv-lap" data-action="lap">${t('next_stage')}</button><button id="lv-pause" data-action="pause">${t('pause')}</button><button class="danger" data-action="stop">${t('stop')}</button></div>
    <div class="stats" style="margin-top:10px"><div>${tx('samples')}<b id="lv-n">0</b></div><div>RMSSD<b id="lv-rmssd">–</b></div><div>${tx('battery')}<b id="lv-batt">${A.source?.battery != null ? A.source.battery + '%' : '–'}</b></div><div>${tx('in_zone')}<b id="lv-tiz">–</b></div></div>
    <div class="card" style="margin-top:10px;padding:8px 6px 4px"><div class="chart" id="lv-chart"></div></div>
    <div class="card" style="margin-top:10px" id="lv-stages"></div>
    <div class="row" style="margin-top:10px"><button class="compact ghost" data-action="rpe">${t('rpe_entry')}</button><button class="compact ghost" data-action="lactate">${t('lactate_entry')}</button><span class="small muted">${v.mode === 'test' ? '' : '세션 중 젖산·RPE는 이벤트로 기록 / logged as events'}</span><button class="compact ghost" id="lv-mute" data-action="mute">🔊</button></div>`;
  return html;
}
function mountLive() {
  const eng = ensureEngine(); const v = eng.view();
  if (v.state === 'running') { const el = $('#lv-chart'); if (el) { A.live.chart = liveChart(el, { getBand: () => eng.targets ? [eng.targets.hrLo, eng.targets.hrHi] : null }); A.charts.push(A.live.chart); } updateLive(v); }
  const diag = $('#ble-diag'); if (diag) bleDiagnostics().then(txt => { diag.innerHTML = txt; });
  const ms = $('#mode-seg'); if (ms) ms.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { A.live.mode = b.dataset.mode; render(); } });
  const ps = $('#pause-seg'); if (ps) ps.addEventListener('click', async e => { const b = e.target.closest('button'); if (!b) return; A.settings.protocol.pauseSec = +b.dataset.pause; await saveSettings(); if (A.engine) A.engine.settings = A.settings; toast(+b.dataset.pause ? '매 단계 채혈 30초 / 30-s pause each stage' : '연속 테스트 · 채혈 없음 / continuous, no sampling'); render(); });
  const ss = $('#src-seg'); if (ss) ss.addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) { A.live.sourceKind = b.dataset.src; if (A.source && A.source.kind !== b.dataset.src) { A.source.disconnect(); A.source = null; } render(); } });
  const ds = $('#demo-speed'); if (ds) ds.onchange = () => { A.live.demoSpeed = +ds.value; };
  const rs = $('#replay-speed'); if (rs) rs.onchange = () => { A.live.replaySpeed = +rs.value; };
  const lm = $('#lt1-min'); if (lm) lm.onchange = () => { A.live.minutes = +lm.value; };
  const sp = $('#sess-speed'); if (sp) sp.onchange = () => { A.live.speed = sp.value === '' ? null : +sp.value; };
  const si = $('#sess-incline'); if (si) si.onchange = () => { A.live.incline = si.value === '' ? null : +si.value; };
  for (const [id, key, mul] of [['lt2-reps', 'reps', 1], ['lt2-work', 'workSec', 60], ['lt2-rest', 'restSec', 60], ['lt2-wu', 'warmupSec', 60], ['lt2-cd', 'cooldownSec', 60]]) { const el = document.getElementById(id); if (el) el.onchange = () => { A.live.lt2[key] = +el.value * mul; }; }
}
let liveStageSig = '';
function updateLive(v) {
  updateConnChip(v);
  if (A.view !== 'live') return;
  if (v.state !== 'running') { const h = $('#pre-hr'); if (h) { h.textContent = v.hr ?? '–'; $('#pre-rr').textContent = v.samples; $('#pre-status').textContent = v.source.status; if (A.source?.battery != null) $('#pre-batt').textContent = A.source.battery + '%'; } if (v.source.status === 'connected' && $('[data-action=start]')?.disabled) render(); return; }
  if (!$('#lv-hr')) return;
  $('#lv-hr').textContent = v.hr ?? '–'; $('#lv-contact').textContent = v.contact === false ? '⚠ 접촉 없음' : '';
  const f = v.feature; const box = $('#lv-a1-box');
  if (f && Number.isFinite(f.alpha1)) { $('#lv-a1').textContent = f.alpha1.toFixed(2); box.className = 'metric a1 ' + (f.alpha1 >= 0.75 ? 'ok' : f.alpha1 >= 0.5 ? 'mid' : 'low'); $('#lv-a1-sub').textContent = f.alpha1 >= 0.75 ? 'LT1 아래 / below LT1' : f.alpha1 >= 0.5 ? 'LT1–LT2' : 'LT2 위 / above LT2'; }
  else { $('#lv-a1').textContent = '–'; box.className = 'metric a1 na'; $('#lv-a1-sub').textContent = tx('waiting') + (f ? ` (${f.samples})` : ''); }
  if (f) { $('#lv-art').textContent = `${tx('artifacts')} ${f.artifactPct.toFixed(1)}%`; $('#lv-art').style.color = f.artifactPct > 5 ? 'var(--bad)' : ''; $('#lv-n').textContent = f.samples; $('#lv-rmssd').textContent = Number.isFinite(f.rmssd) ? f.rmssd.toFixed(0) : '–'; }
  if (A.source?.battery != null) $('#lv-batt').textContent = A.source.battery + '%';
  $('#lv-elapsed').textContent = fmtClock(v.elapsedSec);
  // zone banner
  const zb = $('#lv-zone'); const T = v.targets;
  if (v.mode === 'test' || v.mode === 'free' || !T) { zb.className = 'zone-banner rest'; $('#lv-zone-text').textContent = v.mode === 'test' ? (v.stopAdvised ? tx('stop_reached') : `${tx('stage')} ${v.stage ? v.stage.idx : '–'}`) : tx('mode_free'); if (v.stopAdvised) zb.className = 'zone-banner above'; }
  else { const z = v.zone; zb.className = 'zone-banner ' + (z === 'in' ? 'in' : z === 'above' ? 'above' : z === 'below' ? 'below' : 'rest'); $('#lv-zone-text').textContent = (z === 'in' ? tx('in_zone') : z === 'above' ? tx('above_zone') : z === 'below' ? tx('below_zone') : (v.phase === 'rest' ? '회복 / recovery' : v.phase)) + ` · ${tx('target')} ${T.hrLo}–${T.hrHi}`; }
  if (v.tiz && v.tiz.totalSec) $('#lv-tiz').textContent = Math.round(100 * v.tiz.inSec / v.tiz.totalSec) + '%';
  // phase card
  const ph = $('#lv-phase'); ph.className = 'phase' + (v.phase === 'pause' || v.phase === 'rest' ? ' pause' : '');
  let lbl = v.phase, info = '';
  if (v.mode === 'test') { lbl = v.phase === 'warmup' ? tx('warmup') : v.phase === 'work' ? `${tx('stage')} ${v.stage?.idx} · ${v.stage?.speed} km/h · ${v.stage?.incline}%` : v.phase === 'pause' ? `${tx('sampling')} · ${tx('stage')} ${v.stage?.idx}` : v.phase === 'done' ? '완료 / done' : v.phase; info = v.nextStage ? `${tx('next_stage')}: ${v.nextStage.speed} km/h` : ''; }
  else if (v.mode === 'lt2') { lbl = v.phase === 'work' ? `인터벌 ${v.rep}/${v.reps} / interval` : v.phase === 'rest' ? `회복 ${v.rep}/${v.reps} / recovery` : v.phase === 'warmup' ? tx('warmup') : v.phase === 'cooldown' ? '쿨다운 / cool-down' : v.phase; }
  else if (v.mode === 'lt1') { lbl = T ? `${tx('target')} ${T.hrLo}–${T.hrHi} bpm` : tx('mode_lt1'); info = Number.isFinite(T?.speedLo) ? `≈ ${n1(T.speedLo)}–${n1(T.speedHi)} km/h` : ''; }
  else lbl = tx('mode_free');
  $('#lv-phase-lbl').textContent = (v.paused ? '⏸ ' : '') + lbl; $('#lv-phase-info').textContent = info;
  $('#lv-phase-time').textContent = v.phaseLeft != null ? (v.phaseLeft > 0 || v.phaseDur == null ? fmtClock(v.phaseLeft) : '+' + fmtClock(v.phaseElapsed - v.phaseDur)) : fmtClock(v.phaseElapsed);
  $('#lv-prog').style.width = v.phaseDur ? Math.min(100, 100 * v.phaseElapsed / v.phaseDur) + '%' : '0%';
  const lap = $('#lv-lap'); lap.innerHTML = v.mode === 'test' ? (v.phase === 'pause' ? t('next_stage') : v.phase === 'warmup' ? '1단계 시작<span class="en">Start stage 1</span>' : '단계 종료<span class="en">End stage</span>') : v.mode === 'lt2' ? '다음 구간<span class="en">Next block</span>' : t('lap');
  $('#lv-pause').innerHTML = v.paused ? t('resume') : t('pause');
  // stage table (test)
  if (v.mode === 'test') { const sig = JSON.stringify(v.stages.map(s => [s.idx, s.lactate, s.rpe, !!s.tEnd])); if (sig !== liveStageSig) { liveStageSig = sig; $('#lv-stages').innerHTML = `<div class="table-wrap"><table><thead><tr><th>#</th><th>km/h</th><th>%</th><th>HR</th><th>α1</th><th>La</th><th>RPE</th></tr></thead><tbody>${v.stages.map(s => { const fs = A.engine.features.filter(f => f.t >= (s.tEnd || A.engine.now()) - 60000 && f.t <= (s.tEnd || Infinity) && f.stage === s.idx); const a = fs.filter(f => Number.isFinite(f.alpha1)).map(f => f.alpha1); const hr = fs.map(f => f.hrInst).filter(x => x > 0); return `<tr><td>${s.idx}</td><td>${s.speed}</td><td>${s.incline}</td><td>${hr.length ? n0(hr.reduce((x, y) => x + y, 0) / hr.length) : '–'}</td><td>${a.length ? n2(a.reduce((x, y) => x + y, 0) / a.length) : '–'}</td><td>${s.lactate ?? '–'}</td><td>${s.rpe ?? '–'}</td></tr>`; }).join('')}</tbody></table></div>`; } }
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
  if (e.type === 'lactate-prompt') openLactateModal(e.stage);
  if (e.type === 'finished' && e.reason !== 'user') { (async () => { if (A.source && A.source.kind !== 'ble') { await A.source.disconnect(); A.source = null; } await finalizeSession(e.session); })(); }
}
function openLactateModal(stageIdx) {
  if ($('#lac-modal')) return;
  let val = '';
  modal(`<div id="lac-modal"><h3>${t('lactate_entry')}${stageIdx != null ? ` — ${tx('stage')} ${stageIdx}` : ''}</h3><div class="lac-display" id="lac-disp">&nbsp;</div><div class="keypad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map(k => `<button data-k="${k}">${k}</button>`).join('')}</div><div class="grid2"><button class="ghost" data-x="skip">${t('skip')}</button><button class="primary" data-x="save">${t('save')}</button></div><p class="small muted" style="margin-top:8px">${t('stop_criteria', { la: A.settings.protocol.stopLactate, rpe: A.settings.protocol.stopRpe })}</p></div>`, (m, close) => {
    const disp = m.querySelector('#lac-disp');
    m.querySelector('.keypad').addEventListener('click', ev => { const b = ev.target.closest('button'); if (!b) return; const k = b.dataset.k; if (k === '⌫') val = val.slice(0, -1); else if (k === '.') { if (!val.includes('.')) val = (val || '0') + '.'; } else if (val.replace('.', '').length < 3) val += k; disp.textContent = val || ' '; });
    m.querySelector('[data-x=skip]').onclick = () => { A.engine.enterLactate(null, stageIdx); close(); };
    m.querySelector('[data-x=save]').onclick = () => { const n = parseFloat(val); if (!Number.isFinite(n) || n < 0.3 || n > 25) { toast('0.3–25 mmol/L'); return; } A.engine.enterLactate(n, stageIdx); close(); openRpeModal(stageIdx); };
  });
}
function openRpeModal(stageIdx) {
  modal(`<h3>${t('rpe_entry')}${stageIdx != null ? ` — ${tx('stage')} ${stageIdx}` : ''}</h3><div class="rpe">${[6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map(r => `<button data-r="${r}">${r}</button>`).join('')}</div><p class="small muted" style="margin-top:8px">6 아주 편함 · 11 가벼움 · 13 약간 힘듦 · 15 힘듦 · 17 매우 힘듦 · 19 극도<span class="en">6 very easy · 11 light · 13 somewhat hard · 15 hard · 17 very hard · 19 extremely hard</span></p><button class="ghost block" data-x="skip" style="margin-top:8px">${t('skip')}</button>`, (m, close) => { m.querySelector('.rpe').addEventListener('click', ev => { const b = ev.target.closest('button'); if (!b) return; A.engine.enterRpe(+b.dataset.r, stageIdx); close(); }); m.querySelector('[data-x=skip]').onclick = close; });
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
  const L = A.live; ensureEngine(); A.alerts.unlock();
  try {
    if (A.source) { await A.source.disconnect(); A.source = null; }
    let src;
    if (L.sourceKind === 'ble') { src = new HeartRateSource(); }
    else if (L.sourceKind === 'demo') { src = new DemoSource({ speed: L.demoSpeed }); src.profile = demoProfileForEngine(A.engine); }
    else { if (!L.replay) { toast(tx('replay_pick')); return; } src = new ReplaySource(L.replay.rr, { speed: L.replaySpeed, name: L.replay.filename }); }
    A.source = src; A.engine.setSource(src);
    src.on('status', () => { updateConnChip(); if (A.view === 'live' && A.engine.state !== 'running') render(); });
    src.on('battery', () => updateLive(A.engine.view()));
    await src.connect();
    A.lastBleError = null; toast(tx('connected'));
  } catch (e) { console.error(e); A.source = null; A.lastBleError = `${e && e.name ? e.name + ': ' : ''}${bleErrorHint(e)}`; toast(`연결 실패 / Failed: ${e && e.name ? e.name : ''}`, 3000); render(); }
}
async function startSession() {
  const eng = ensureEngine(); const L = A.live; const z = zonesObj();
  if (!A.source || A.source.status !== 'connected') { toast(tx('disconnected')); return; }
  A.alerts.update(A.settings.alerts); A.alerts.unlock();
  const ins = assessRecent(await store.listSessions(), z, A.settings.zones.updatedAt);
  let targets = null;
  if (L.mode === 'lt1') { if (!z) { toast(tx('no_zones')); return; } targets = sessionTargets(z, 'lt1', { minutes: L.minutes, lt1Adjust: ins.lt1Adjust }); }
  if (L.mode === 'lt2') { if (!z) { toast(tx('no_zones')); return; } targets = sessionTargets(z, 'lt2'); }
  eng.reset(); if (eng.source !== A.source) eng.setSource(A.source);
  const spEl = $('#sess-speed'), siEl = $('#sess-incline'); if (spEl) L.speed = spEl.value === '' ? null : +spEl.value; if (siEl) L.incline = siEl.value === '' ? null : +siEl.value;
  eng.configure({ mode: L.mode, protocol: A.settings.protocol, intervals: L.mode === 'lt2' ? L.lt2 : null, targets, meta: L.mode === 'test' ? null : { speed: L.speed ?? null, incline: L.incline ?? A.settings.protocol.incline } });
  if (A.source.kind === 'demo') A.source.profile = demoProfileForEngine(eng);
  liveStageSig = ''; eng.start();
  const ok = await A.alerts.keepAwake(true); if (!ok) toast(tx('keep_awake_fail'), 4000);
  render();
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
  await store.putSession(session); await refreshLists();
  if (A.engine) { A.engine.reset(); if (A.source && A.source.status === 'connected') A.engine.state = 'ready'; }
  toast(tx('session_saved'));
  navigate('analysis', session.id);
}
function resultFrom(r) { const tri = r.tri; return { lt1Hr: tri.lt1?.hr ?? null, lt2Hr: tri.lt2?.hr ?? null, lt1Speed: tri.lt1?.speed ?? null, lt2Speed: tri.lt2?.speed ?? null, grade: `${tri.grade1}/${tri.grade2}`, source: [tri.lt1?.source, tri.lt2?.source].filter(Boolean).join('+') }; }

// ---------- ANALYSIS ----------
async function refreshLists() { A.sessions = await store.listSessionSummaries(); A.imports = await store.listImports(); }
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
  if (md.points.length) {
    html += `<h2>다일 젖산 곡선 <span class="en">Multi-day lactate curve</span></h2><div class="card"><p class="small muted">일정 속도 세션의 종료 젖산을 모아 만든 곡선(최근 60일, 속도당 최신 1개). <span class="en">End-of-run lactate from constant-speed sessions (last 60 days, newest per speed).</span></p>
      <div class="table-wrap"><table><thead><tr><th>km/h</th><th>La</th><th>HR</th><th>α1</th><th>날짜</th></tr></thead><tbody>${md.points.map(p => `<tr><td>${p.x}</td><td>${p.la}</td><td>${n0(p.hr)}</td><td>${n2(p.alpha1)}</td><td>${fmtDate(p.date).slice(5, 10)}</td></tr>`).join('')}</tbody></table></div>`;
    if (md.analysis) { const L1 = md.analysis.lt1Primary, L2 = md.analysis.lt2Primary; html += `<div class="thr-card" style="margin-top:10px"><div class="box"><div class="small muted">LT1 (baseline+0.5)</div><div class="v">${n0(L1.hr)}<small> bpm</small></div><div class="small">${n1(L1.x)} km/h</div></div><div class="box"><div class="small muted">LT2 (ModDmax)</div><div class="v">${n0(L2.hr)}<small> bpm</small></div><div class="small">${n1(L2.x)} km/h</div></div></div><p class="small muted" style="margin-top:6px">${t('grade')} ${md.grade} · ${md.points.length}점${md.points.length < 5 ? ' — 5점 이상(젖산 범위 2 mmol/L 이상)이면 B등급' : ''}</p><button class="primary block" style="margin-top:8px" data-action="apply-multiday" ${Number.isFinite(L1.hr) && Number.isFinite(L2.hr) ? '' : 'disabled'}>${t('apply_zones')}</button>`; }
    else html += `<p class="small muted" style="margin-top:6px">${md.points.length}/3 — 서로 다른 속도 3개 이상이면 곡선을 계산합니다. <span class="en">Need ≥3 different speeds to fit the curve.</span></p>`;
    html += '</div>';
  }
  if (A.imports.length) { html += `<h2>${t('imports')}</h2><div class="card">` + A.imports.map(i => `<div class="list-item" data-action="import-detail" data-id="${i.id}"><div><div class="t">${esc(i.filename || i.source)}</div><div class="s">${esc(i.source)} · ${i.startedAt ? fmtDate(i.startedAt) : ''} · ${i.durationSec ? fmtClock(i.durationSec) : ''}${i.meta?.position ? ' · ' + esc(i.meta.position) : ''}</div></div><button class="compact ghost danger" data-action="delete-import" data-id="${i.id}">✕</button></div>`).join('') + '</div>'; }
  setTimeout(() => { const el = $('#trend-chart'); if (el) { const tt = tests.filter(s => s.result && Number.isFinite(s.result.lt1Hr)).slice().reverse(); const c = trendChart(el, { labels: tt.map(s => fmtDate(s.startedAt).slice(5, 10)), lt1: tt.map(s => s.result.lt1Hr), lt2: tt.map(s => s.result.lt2Hr ?? null) }); A.charts.push(c); } }, 0);
  return html;
}
function itemHtml(s) { const m = s.metrics || {}; return `<div class="list-item" data-action="open-session" data-id="${s.id}"><div><div class="t">${typeLabel(s.type)} · ${fmtDate(s.startedAt)}${s.final ? '' : ' · <span class="pill warn">미완료 / unfinished</span>'}</div><div class="s">${fmtClock(m.durationSec || 0)} · HR ${n0(m.meanHr)} · α1 ${n2(m.meanAlpha1)}${s.result ? ` · LT1 ${n0(s.result.lt1Hr)} / LT2 ${n0(s.result.lt2Hr)} (${esc(s.result.grade)})` : ''}${s.hasSmo2 ? ' · SmO2' : ''} · ${esc(s.sourceKind || '')}</div></div><div>›</div></div>`; }

async function renderSessionDetail(id) {
  const s = await store.getSession(id); const v = $('#view'); if (!s) { v.innerHTML = '<p>not found</p>'; return; }
  A.detail = s;
  const r = analyzeSession(s); const m = sessionMetrics(s); const z = zonesObj(); const txt = sessionSummaryText(s, m, z, r);
  let html = `<div class="row between"><button class="compact ghost" data-action="back">‹ ${t('sessions')}</button><div class="row"><button class="compact ghost" data-action="export-csv">${t('export_csv')}</button><button class="compact ghost danger" data-action="delete-session">${t('delete')}</button></div></div>
    <h3 style="margin-top:10px">${typeLabel(s.type)} · ${fmtDate(s.startedAt)}</h3><p class="small muted">${esc(s.sourceKind || '')} · ${fmtClock(m.durationSec)}${s.smo2?.series?.length ? ` · SmO2 ${esc(s.smo2.position || '')} (${s.smo2.series.length} pts, offset ${Math.round((s.smo2.offsetMs || 0) / 1000)} s)` : ''}</p>
    <div class="card"><dl class="kv"><dt>${t('duration')}</dt><dd>${fmtClock(m.durationSec)}</dd><dt>${t('hr')}</dt><dd>${n0(m.meanHr)} / max ${n0(m.maxHr)}</dd><dt>${t('mean_alpha')}</dt><dd>${n2(m.meanAlpha1)} (≥0.75: ${n0(m.pctAlphaAbove75)}%)</dd><dt>${t('drift')}</dt><dd>${Number.isFinite(m.driftPct) ? (m.driftPct >= 0 ? '+' : '') + m.driftPct.toFixed(1) + '%' : '–'}</dd><dt>${t('artifacts')}</dt><dd>${n1(m.artifactPct)}%</dd>${Number.isFinite(m.timeInZonePct) ? `<dt>${t('time_in_zone')}</dt><dd>${n0(m.timeInZonePct)}%</dd>` : ''}</dl>
      <p style="margin-top:10px"><span class="ko">${esc(txt.ko)}</span><span class="en">${esc(txt.en)}</span></p></div>
    <div class="card" style="margin-top:10px;padding:8px 6px 4px"><div class="chart" id="tl-chart"></div></div>
    <div class="row" style="margin-top:10px"><button class="compact" data-action="attach-smo2">${t('attach_smo2')}</button>${s.smo2 ? `<label class="field grow">${t('offset')} (s) <input type="number" id="smo2-offset" value="${Math.round((s.smo2.offsetMs || 0) / 1000)}" step="5"></label>` : ''}<button class="compact" data-action="copy-summary">${t('copy_summary')}</button></div>`;
  if (s.type !== 'test') {
    const c = lactateChecks(s); const vd = lactateVerdict(s); const ew = endWindowStats(s, 300);
    html += `<h2>젖산 검증 <span class="en">Lactate verification</span></h2><div class="card">
      <div class="grid2"><label class="field">러닝머신 km/h<input type="number" step="0.1" id="vc-speed" value="${s.speed ?? ''}"></label><label class="field">경사 %<input type="number" step="0.5" id="vc-incline" value="${s.incline ?? ''}"></label></div>
      <div class="grid3" style="margin-top:8px"><label class="field">안정 시 / rest<input type="number" step="0.1" id="vc-rest" value="${c.rest ?? ''}"></label><label class="field">10분 / mid<input type="number" step="0.1" id="vc-mid" value="${c.mid ?? ''}"></label><label class="field">종료 / end<input type="number" step="0.1" id="vc-end" value="${c.end ?? ''}"></label></div>
      <p class="small muted" style="margin-top:6px">마지막 5분 평균: 심박 ${n0(ew.hr)} bpm · α1 ${n2(ew.alpha1)} <span class="en">Last-5-min mean: HR ${n0(ew.hr)} · α1 ${n2(ew.alpha1)}</span></p>
      ${vd ? `<div class="notice ${vd.level === 'ok' ? '' : 'warn'}" style="margin-top:6px"><span class="ko">${esc(vd.ko)}</span><span class="en">${esc(vd.en)}</span></div>${vd.adjust ? `<button class="compact" style="margin-top:8px" data-action="apply-verdict">조정 적용 (${vd.adjust.lt1Hr ? `LT1 ${vd.adjust.lt1Hr > 0 ? '+' : ''}${vd.adjust.lt1Hr} bpm` : ''}${vd.adjust.lt2Speed ? `LT2 ${vd.adjust.lt2Speed > 0 ? '+' : ''}${vd.adjust.lt2Speed} km/h` : ''}) <span class="en">Apply adjustment</span></button>` : ''}` : `<p class="small muted">종료 젖산을 입력하면 LT1/LT2 판정이 나옵니다. 세션 중 「젖산 입력」으로 기록한 값은 시각에 따라 자동 배치됩니다. <span class="en">Enter the end lactate to get a verdict; values logged during the session are placed automatically by time.</span></p>`}
    </div>`;
  }
  const evs = (s.events || []).filter(e => ['lactate', 'rpe', 'lap'].includes(e.type) && (s.type !== 'test' || e.type === 'lap'));
  if (evs.length) html += `<h2>이벤트 <span class="en">Events</span></h2><div class="card"><div class="table-wrap"><table><thead><tr><th>t</th><th>type</th><th>value</th><th>phase</th></tr></thead><tbody>${evs.map(e => `<tr><td>${fmtClock((e.t - s.startedAt) / 1000)}</td><td>${esc(e.type)}</td><td>${e.value ?? ''}</td><td>${esc(e.phase || '')}${e.rep ? ' #' + e.rep : ''}</td></tr>`).join('')}</tbody></table></div></div>`;
  if (s.type === 'test' || (s.stages && s.stages.length)) {
    const incl = r.rows.map(x => x.incline); const constIncl = incl.length && incl.every(v => v === incl[0]);
    html += `<h2>${t('stage_table')}</h2><div class="card"><div class="table-wrap"><table id="stage-table"><thead><tr><th>#</th><th>km/h</th>${constIncl ? '' : '<th>%</th>'}<th>HR</th><th>α1</th><th>La</th><th>RPE</th><th>SmO2</th><th>%/min</th></tr></thead><tbody>${r.rows.map(row => `<tr data-idx="${row.idx}"><td>${row.idx}</td><td><input type="number" step="0.1" data-f="speed" value="${row.speed ?? ''}"></td>${constIncl ? '' : `<td><input type="number" step="0.5" data-f="incline" value="${row.incline ?? ''}"></td>`}<td>${n0(row.hr)}</td><td>${n2(row.alpha1)}${row.artifactPct > 5 ? ' ⚠' : ''}</td><td><input type="number" step="0.1" data-f="lactate" value="${row.lactate ?? ''}"></td><td><input type="number" step="1" data-f="rpe" value="${row.rpe ?? ''}"></td><td>${n1(row.smo2)}</td><td>${Number.isFinite(row.smo2Slope) ? row.smo2Slope.toFixed(1) : '–'}</td></tr>`).join('')}</tbody></table></div><p class="small muted">${constIncl ? `경사 ${incl[0]}% 고정 / incline ${incl[0]}% fixed · ` : ''}값을 고치면 자동으로 다시 계산됩니다. α1은 각 단계 마지막 60초 평균, SmO2는 마지막 60초 평균과 2분 기울기.<span class="en">Edits recalculate automatically. α1 = mean of the last 60 s of each stage; SmO2 = last-60-s mean and 2-min slope.</span></p></div>
      <div class="card" style="margin-top:10px;padding:8px 6px 4px"><div class="chart" id="step-chart"></div></div>`;
    html += `<h2>${t('thresholds')}</h2><div class="card"><div class="table-wrap"><table class="wrap-first"><thead><tr><th>${t('method')}</th><th>km/h</th><th>bpm</th><th>mmol/L</th></tr></thead><tbody>`;
    if (r.lactate) html += [...r.lactate.lt1, ...r.lactate.lt2].map(e => `<tr><td>${e.method.includes('ModDmax') || e.method.startsWith('baseline') ? '<b>' + esc(e.method.replace('Log-Poly-ModDmax', 'ModDmax (log-poly)')) + '</b>' : esc(e.method)}${e.note ? `<div class="small muted">${esc(e.note)}</div>` : ''}</td><td>${n1(e.x)}</td><td>${n0(e.hr)}</td><td>${n1(e.la)}</td></tr>`).join(''); else html += `<tr><td colspan="4" class="muted">젖산 3단계 이상 필요 / needs ≥3 lactate stages</td></tr>`;
    html += `<tr><td>HRVT1 (α1 0.75)${r.hrv.fit ? `<div class="small muted">r²=${n2(r.hrv.fit.r2)} · ${r.hrv.points} pts</div>` : ''}</td><td>${n1(r.hrv.hrvt1?.speed)}</td><td>${n0(r.hrv.hrvt1?.hr)}</td><td></td></tr><tr><td>HRVT2 (α1 0.5)${r.hrv.note ? `<div class="small muted">${esc(r.hrv.note)}</div>` : ''}${r.hrv.plateau ? `<div class="small" style="color:var(--warn)">⚠ ${esc(r.hrv.plateau.note)}</div>` : ''}</td><td>${n1(r.hrv.hrvt2?.speed)}</td><td>${n0(r.hrv.hrvt2?.hr)}</td><td></td></tr>`;
    html += `<tr><td>SmO2 BP1${r.smo2.note ? `<div class="small muted">${esc(r.smo2.note)}</div>` : ''}</td><td>${n1(r.smo2.bp1?.speed)}</td><td>${n0(r.smo2.bp1?.hr)}</td><td></td></tr><tr><td>SmO2 BP2${r.smo2.firstUnsteady ? `<div class="small muted">첫 비정상 상태 / first unsteady: ${n1(r.smo2.firstUnsteady.speed)} km/h</div>` : ''}</td><td>${n1(r.smo2.bp2?.speed)}</td><td>${n0(r.smo2.bp2?.hr)}</td><td></td></tr></tbody></table></div></div>`;
    const tri = r.tri; const agreeHtml = (o) => `<span class="agree agree-${o.label === 'agree' ? 'ok' : o.label}">${esc(o.src)} ${n0(o.hr)} (${tx(o.label)}${Number.isFinite(o.diff) ? ' ' + n0(o.diff) : ''})</span>`;
    html += `<h2>${t('triangulation')}</h2><div class="card accent"><div class="thr-card"><div class="box"><div class="small muted">${t('lt1')}</div><div class="v">${n0(tri.lt1?.hr)}<small> bpm</small></div><div class="small">${n1(tri.lt1?.speed)} km/h · ${esc(tri.lt1?.source || '–')} · ${t('grade')} ${tri.grade1}</div><div class="small">${(tri.lt1?.others || []).map(agreeHtml).join(' · ')}</div></div>
      <div class="box"><div class="small muted">${t('lt2')}</div><div class="v">${n0(tri.lt2?.hr)}<small> bpm</small></div><div class="small">${n1(tri.lt2?.speed)} km/h · ${esc(tri.lt2?.source || '–')} · ${t('grade')} ${tri.grade2}</div><div class="small">${(tri.lt2?.others || []).map(agreeHtml).join(' · ')}</div></div></div>
      <button class="primary block" style="margin-top:10px" data-action="apply-zones" ${tri.lt1 && tri.lt2 ? '' : 'disabled'}>${t('apply_zones')}</button>${A.settings.zones.testSessionId === s.id ? `<p class="small muted" style="margin-top:6px">${t('applied')} ✓</p>` : ''}</div>`;
  }
  // FatMaxxer comparison (features import overlapping this session)
  const fm = A.imports.find(i => i.source === 'fatmaxxer-features' && i.features?.some(f => f.t >= s.startedAt && f.t <= (s.endedAt || Infinity)));
  if (fm && s.features?.length) { const pairs = []; for (const f of fm.features) { if (f.t < s.startedAt || f.t > s.endedAt) continue; const mine = s.features.reduce((best, x) => Math.abs(x.t - f.t) < Math.abs(best.t - f.t) ? x : best, s.features[0]); if (Math.abs(mine.t - f.t) < 6000 && Number.isFinite(mine.alpha1) && Number.isFinite(f.alpha1)) pairs.push([f.alpha1, mine.alpha1]); } if (pairs.length) { const mad = pairs.reduce((a, p) => a + Math.abs(p[0] - p[1]), 0) / pairs.length; html += `<div class="card" style="margin-top:10px"><h3>FatMaxxer α1 비교 <span class="en">comparison</span></h3><p class="small">${pairs.length}개 시점, 평균 절대차 <b class="mono">${mad.toFixed(3)}</b> / ${pairs.length} points, mean |Δ| ${mad.toFixed(3)}</p></div>`; } }
  v.innerHTML = html;
  // charts
  const el = $('#tl-chart'); if (el && s.features?.length) { const t0 = s.startedAt; const feats = s.features; const ts = feats.map(f => (f.t - t0) / 1000); const hr = feats.map(f => f.hrInst > 0 ? f.hrInst : null); const a1 = feats.map(f => Number.isFinite(f.alpha1) ? f.alpha1 : null); let sm = null; if (s.smo2?.series?.length) { const off = s.smo2.offsetMs || 0; const ser = s.smo2.series; sm = ts.map(tt => { const target = t0 + tt * 1000 - off; let lo = 0, hi = ser.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (ser[mid][0] < target) lo = mid + 1; else hi = mid; } const p = ser[lo]; return p && Math.abs(p[0] - target) < 3000 ? p[1] : null; }); } const band = s.targets ? [s.targets.hrLo, s.targets.hrHi] : null; A.charts.push(timelineChart(el, { ts, hr, a1, smo2: sm, band })); }
  else if (el && s.hrLive?.length) { const t0 = s.startedAt; const step = Math.max(1, Math.floor(s.hrLive.length / 600)); const pts = s.hrLive.filter((_, i) => i % step === 0); A.charts.push(timelineChart(el, { ts: pts.map(p => (p[0] - t0) / 1000), hr: pts.map(p => p[1]), a1: pts.map(() => null) })); }
  const sc = $('#step-chart'); if (sc && r.rows.length) { const rows = r.rows.filter(x => Number.isFinite(x.speed)); const marks = []; if (r.lactate && Number.isFinite(r.lactate.lt1Primary.x)) marks.push({ x: r.lactate.lt1Primary.x, label: 'LT1', color: getComputedStyle(document.documentElement).getPropertyValue('--c-la') }); if (r.lactate && Number.isFinite(r.lactate.lt2Primary.x)) marks.push({ x: r.lactate.lt2Primary.x, label: 'LT2', color: getComputedStyle(document.documentElement).getPropertyValue('--c-la') }); if (r.hrv.hrvt1) marks.push({ x: r.hrv.hrvt1.speed, label: 'HRVT1', row: 1, color: getComputedStyle(document.documentElement).getPropertyValue('--c-a1') }); if (r.hrv.hrvt2) marks.push({ x: r.hrv.hrvt2.speed, label: 'HRVT2', row: 1, color: getComputedStyle(document.documentElement).getPropertyValue('--c-a1') }); if (r.smo2.bp2) marks.push({ x: r.smo2.bp2.speed, label: 'BP2', row: 2, color: getComputedStyle(document.documentElement).getPropertyValue('--c-smo2') }); A.charts.push(stepTestChart(sc, { speeds: rows.map(x => x.speed), lactate: rows.map(x => Number.isFinite(x.lactate) ? x.lactate : null), a1: rows.map(x => Number.isFinite(x.alpha1) ? x.alpha1 : null), smo2: rows.map(x => Number.isFinite(x.smo2) ? x.smo2 : null), hr: rows.map(x => Number.isFinite(x.hr) ? x.hr : null), marks })); }
  // stage edits
  const tbl = $('#stage-table'); if (tbl) tbl.addEventListener('change', async e => { const inp = e.target; const tr = inp.closest('tr'); if (!tr) return; const idx = +tr.dataset.idx; const st = s.stages.find(x => x.idx === idx); if (!st) return; const val = inp.value === '' ? null : +inp.value; st[inp.dataset.f] = val; if (s.type === 'test') s.result = resultFrom(analyzeSession(s)); await store.putSession(s); await renderSessionDetail(id); });
  for (const [id, key] of [['vc-speed', 'speed'], ['vc-incline', 'incline']]) { const el = document.getElementById(id); if (el) el.onchange = async () => { s[key] = el.value === '' ? null : +el.value; await store.putSession(s); destroyCharts(); await renderSessionDetail(id === 'vc-speed' ? s.id : s.id); }; }
  for (const [id, key] of [['vc-rest', 'rest'], ['vc-mid', 'mid'], ['vc-end', 'end']]) { const el = document.getElementById(id); if (el) el.onchange = async () => { s.lactateChecks = { ...lactateChecks(s), [key]: el.value === '' ? null : +el.value }; await store.putSession(s); destroyCharts(); await renderSessionDetail(s.id); }; }
  const off = $('#smo2-offset'); if (off) off.onchange = async () => { s.smo2.offsetMs = (+off.value || 0) * 1000; await store.putSession(s); destroyCharts(); await renderSessionDetail(id); };
}
async function applyZonesFromDetail() {
  const s = A.detail; if (!s) return; const r = analyzeSession(s); const tri = r.tri; if (!tri.lt1 || !tri.lt2) return;
  A.settings.zones = { lt1Hr: Math.round(tri.lt1.hr), lt2Hr: Math.round(tri.lt2.hr), lt1Speed: Number.isFinite(tri.lt1.speed) ? Math.round(tri.lt1.speed * 10) / 10 : null, lt2Speed: Number.isFinite(tri.lt2.speed) ? Math.round(tri.lt2.speed * 10) / 10 : null, source: `${tri.lt1.source} / ${tri.lt2.source}`, grade: `${tri.grade1}/${tri.grade2}`, updatedAt: s.startedAt, testSessionId: s.id };
  if (!A.settings.plan.startDate) A.settings.plan.startDate = new Date(s.startedAt).toISOString().slice(0, 10);
  await saveSettings(); toast(tx('applied')); await renderSessionDetail(s.id);
}
function attachSmo2Modal() {
  const s = A.detail; const cands = A.imports.filter(i => i.smo2Series && i.smo2Series.length);
  if (!cands.length) { toast('먼저 Train.Red CSV/FIT를 가져오세요 / Import a Train.Red file first'); return; }
  const list = cands.map(i => { const ov = Math.max(0, Math.min(i.endedAt, s.endedAt || i.endedAt) - Math.max(i.startedAt, s.startedAt)) / 1000; return `<div class="list-item" data-imp="${i.id}"><div><div class="t">${esc(i.filename)}</div><div class="s">${fmtDate(i.startedAt)} · ${fmtClock(i.durationSec)} · ${esc(i.meta?.position || '')} · 겹침/overlap ${fmtClock(ov)}</div></div><div>›</div></div>`; }).join('');
  modal(`<h3>${t('attach_smo2')}</h3>${list}<p class="small muted">세션과 겹치지 않아도 붙일 수 있습니다(시작 시각 기준 정렬, 보정 슬라이더로 맞추세요). / Files that don't overlap can still be attached (aligned by start time; use the offset to align).</p>`, (m, close) => { m.addEventListener('click', async e => { const it = e.target.closest('[data-imp]'); if (!it) return; const imp = await store.getImport(it.dataset.imp); const ov = imp.startedAt < (s.endedAt || Infinity) && imp.endedAt > s.startedAt; s.smo2 = { importId: imp.id, source: imp.source, position: imp.meta?.position || '', series: imp.smo2Series.map(p => [p[0], p[1], p[2]]), offsetMs: ov ? 0 : (s.startedAt - imp.startedAt) }; if (s.type === 'test') s.result = resultFrom(analyzeSession(s)); await store.putSession(s); close(); destroyCharts(); await renderSessionDetail(s.id); }); });
}
function exportSessionCsv(s) {
  const r = analyzeSession(s); const L = [];
  L.push('# Treadmill Lab session export'); L.push(`# type,${s.type},start,${new Date(s.startedAt).toISOString()},source,${s.sourceKind || ''}`);
  if (r.rows.length) { L.push('stage,speed_kmh,incline_pct,hr_bpm,alpha1,lactate_mmol,rpe,smo2_pct,smo2_slope_pct_per_min,artifact_pct'); for (const x of r.rows) L.push([x.idx, x.speed, x.incline, n0(x.hr), n2(x.alpha1), x.lactate ?? '', x.rpe ?? '', n1(x.smo2), Number.isFinite(x.smo2Slope) ? x.smo2Slope.toFixed(2) : '', n1(x.artifactPct)].join(',')); L.push(''); }
  L.push('t_iso,elapsed_s,hr_bpm,alpha1,rmssd_ms,artifact_pct,samples,phase,stage'); for (const f of s.features || []) L.push([new Date(f.t).toISOString(), ((f.t - s.startedAt) / 1000).toFixed(0), f.hrInst ?? '', Number.isFinite(f.alpha1) ? f.alpha1.toFixed(3) : '', Number.isFinite(f.rmssd) ? f.rmssd.toFixed(1) : '', f.artifactPct?.toFixed(1) ?? '', f.samples ?? '', f.phase ?? '', f.stage ?? ''].join(','));
  L.push(''); L.push('rr_t_ms,rr_ms,accepted'); for (const x of s.rr || []) L.push(x.join(','));
  download(`treadmill-lab_${s.type}_${new Date(s.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`, L.join('\n'), 'text/csv');
}

// ---------- IMPORT ----------
async function handleFiles(files) {
  let made = 0;
  for (const file of files) {
    try {
      if (/\.json$/i.test(file.name)) { const b = JSON.parse(await file.text()); const r = await store.importAll(b, { merge: true }); if (b.settings) { A.settings = deepMerge(DEFAULTS, b.settings); await saveSettings(); } toast(`복원 / restored: ${r.sessions} sessions, ${r.imports} imports`); made++; continue; }
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
        const target = await findOverlapSession(rec); if (target) { target.smo2 = { importId: rec.id, source: rec.source, position: rec.meta.position || '', series: rec.smo2Series.map(p => [p[0], p[1], p[2]]), offsetMs: 0 }; if (target.type === 'test') target.result = resultFrom(analyzeSession(target)); await store.putSession(target); toast(`SmO2 자동 연결 / auto-attached → ${fmtDate(target.startedAt)}`); } else toast(`SmO2 가져옴 / imported (${esc(imp.meta?.position || '')}, ${fmtClock(imp.durationSec)})`);
      } else if (imp.source === 'fatmaxxer-features') { await store.putImport({ id: uid(), source: imp.source, filename: imp.filename, startedAt: imp.features[0]?.t, endedAt: imp.features[imp.features.length - 1]?.t, durationSec: ((imp.features[imp.features.length - 1]?.t || 0) - (imp.features[0]?.t || 0)) / 1000, features: imp.features, meta: {} }); made++; toast('FatMaxxer features imported'); }
    } catch (e) { console.error(e); toast(`가져오기 실패 / import failed: ${esc(file.name)} — ${esc(e.message)}`, 4000); }
  }
  if (made) { await refreshLists(); if (A.view === 'analysis' && !A.param) render(); }
}
async function findOverlapSession(rec) { const all = await store.listSessions(); let best = null, bestOv = 0; for (const s of all) { if (!s.endedAt) continue; const ov = Math.min(rec.endedAt, s.endedAt) - Math.max(rec.startedAt, s.startedAt); if (ov > bestOv) { bestOv = ov; best = s; } } return bestOv > 0.5 * (rec.endedAt - rec.startedAt) ? best : null; }
async function autoAttach(sess) { if (sess.smo2) return; const imps = await store.listImports(); for (const i of imps) { if (!i.smo2Series?.length) continue; const ov = Math.min(i.endedAt, sess.endedAt) - Math.max(i.startedAt, sess.startedAt); if (ov > 0.5 * (i.endedAt - i.startedAt)) { sess.smo2 = { importId: i.id, source: i.source, position: i.meta?.position || '', series: i.smo2Series.map(p => [p[0], p[1], p[2]]), offsetMs: 0 }; await store.putSession(sess); return; } } }
$('#file-input').addEventListener('change', async e => { const files = [...e.target.files]; e.target.value = ''; if (A.pendingReplayPick) { A.pendingReplayPick = false; if (files[0]) { try { const imp = await importFile(files[0]); if (!imp.rr?.length) throw new Error('no RR'); A.live.replay = { rr: imp.rr, filename: files[0].name, durationSec: imp.durationSec }; toast(`${imp.rr.length} RR`); } catch (err) { toast('RR 파일이 아닙니다 / not an RR file'); } render(); } return; } await handleFiles(files); });

// ---------- PLAN ----------
async function renderPlan() {
  const z = zonesObj(); if (!z) return `<div class="card"><p>${t('no_zones')}</p><button class="primary" data-action="go-test">${t('start_test')}</button></div>`;
  const week = planWeek(); const ins = assessRecent(await store.listSessions(), z, A.settings.zones.updatedAt);
  const plan = weeklyPlan({ zones: z, week, weekdayMin: A.settings.plan.weekdayMin, weekendMin: A.settings.plan.weekendMin, goal: A.settings.plan.goal, lt1Adjust: ins.lt1Adjust });
  const todayIdx = new Date().getDay();
  let html = `<div class="row between"><h2 style="margin:0">${tx('weekly_plan')} · ${tx('week')} ${week}${plan.recovery ? ' · 회복 / recovery' : ''}</h2><div class="row"><button class="compact ghost" data-action="week-prev">‹</button><button class="compact ghost" data-action="week-next">›</button></div></div>
    <div class="card" style="margin-top:10px">${[1, 2, 3, 4, 5, 6, 0].map(d => plan.days.find(x => x.day === d)).map(d => `<div class="plan-day"><div class="dow ${d.day === todayIdx ? 'today' : ''}">${DOW.ko[d.day]}<br><span class="small">${DOW.en[d.day]}</span></div><div><div class="type-${d.type}"><b>${esc(d.ko)}</b><span class="en">${esc(d.en)}</span></div><div class="small muted mono">${d.hr ? `${d.hr.hrLo}–${d.hr.hrHi} bpm` : ''}${d.structure ? ` · ${esc(d.structure.label.split(' / ')[0])}` : ''}</div></div><div class="mins">${d.minutes}′</div></div>`).join('')}
      <p class="small muted" style="margin-top:8px">총 ${plan.totalMin}분 · 고강도 ${plan.hardPct}% · 지속시간은 매주 +10%, 4주째·8주째 회복주 / Total ${plan.totalMin} min · hard ${plan.hardPct}% · +10% per week, recovery on weeks 4 and 8</p>
      <div class="row"><button class="compact" data-action="copy-plan">${t('copy_summary')}</button></div></div>`;
  html += `<h2>${t('zones_table')}</h2><div class="card"><div class="zone-list">${z.five.map((zz, i) => `<div class="zone-item"><div class="bar" style="background:var(--z${i + 1})"></div><div class="nm"><b>${zz.id}</b> ${esc(zz.ko)}<span class="en">${esc(zz.en)}</span></div><div class="rng">${zz.hrLo || '<'}${zz.hrLo ? '–' : ''}${zz.hrHi} bpm<br><span class="small muted">${Number.isFinite(zz.speedLo) || Number.isFinite(zz.speedHi) ? `${Number.isFinite(zz.speedLo) ? n1(zz.speedLo) : '<'}${Number.isFinite(zz.speedLo) && Number.isFinite(zz.speedHi) ? '–' : ''}${Number.isFinite(zz.speedHi) ? n1(zz.speedHi) : '+'} km/h` : ''}</span></div></div>`).join('')}</div>
    <p class="small muted" style="margin-top:8px">LT1 세션 목표 = LT1 −10~−3 bpm${ins.lt1Adjust ? ` (자동 조정 ${ins.lt1Adjust > 0 ? '+' : ''}${ins.lt1Adjust})` : ''} · LT2 세션 = LT2 ±3 bpm · 속도는 경사 1% 기준<span class="en">LT1 session = LT1 −10 to −3 bpm${ins.lt1Adjust ? ` (auto ${ins.lt1Adjust > 0 ? '+' : ''}${ins.lt1Adjust})` : ''} · LT2 session = LT2 ±3 bpm · speeds at 1% incline</span></p></div>`;
  html += `<h2>${t('insights')}</h2><div class="card stack">${ins.notes.map(n => `<div class="notice ${n.kind === 'retest' || n.kind === 'adjust' ? 'warn' : ''}"><span class="ko">${esc(n.ko)}</span><span class="en">${esc(n.en)}</span></div>`).join('')}</div>`;
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
      <div class="grid2">${sel('profile.maxHrMode', t('max_hr'), [['tanaka', tx('max_hr_tanaka') + (age != null ? ` = ${Math.round(208 - 0.7 * age)}` : '')], ['manual', '직접 입력 / manual']])}${num('profile.maxHr', 'bpm (manual)', 'min="120" max="230"')}</div>
      <div class="grid2">${sel('profile.lang', t('lang'), [['both', '한국어 + English'], ['ko', '한국어'], ['en', 'English']])}${sel('profile.theme', '테마 / Theme', [['system', '시스템 / System'], ['dark', '다크 / Dark'], ['light', '라이트 / Light']])}</div></div>
    <h2>${t('treadmill')}</h2><div class="card stack"><label class="field">모델 / Model<input type="text" data-set="treadmill.model" value="${esc(s.treadmill.model)}"></label>
      <div class="grid3">${num('treadmill.maxSpeed', '최대 km/h', 'step="0.5"')}${num('treadmill.speedStep', '속도 단위 / step', 'step="0.1"')}${num('treadmill.maxIncline', '최대 경사 %', 'step="0.5"')}</div></div>
    <h2>${t('protocol')}</h2><div class="card stack">
      ${sel('protocol.type', '유형 / Type', [['speed', '속도 증가 (경사 고정) / speed steps'], ['incline', '경사 증가 (속도 고정) / incline steps']])}
      <div class="grid3">${num('protocol.startSpeed', '시작 km/h', 'step="0.5"')}${num('protocol.speedStep', '증분 km/h', 'step="0.1"')}${num('protocol.incline', '경사 % (고정)', 'step="0.5"')}</div>
      <div class="grid3">${num('protocol.fixedSpeed', '고정 속도 km/h', 'step="0.5"')}${num('protocol.startIncline', '시작 경사 %', 'step="0.5"')}${num('protocol.inclineStep', '경사 증분 %p', 'step="0.5"')}</div>
      <div class="grid3">${num('protocol.stageSec', '단계 초 / stage s', 'step="30"')}${num('protocol.pauseSec', '채혈 초 / pause s', 'step="5"')}${num('protocol.maxStages', '최대 단계 / max', 'step="1"')}</div>
      <div class="grid3">${num('protocol.warmupSec', '워밍업 초 / warm-up s', 'step="30"')}${num('protocol.warmupSpeed', '워밍업 km/h', 'step="0.5"')}<span></span></div>
      <div class="grid2">${num('protocol.stopLactate', '종료 젖산 mmol/L', 'step="0.5"')}${num('protocol.stopRpe', '종료 RPE', 'step="1"')}</div>
      <p class="small muted">권장: 3분 단계 + 30초 채혈 정지(벨트 양옆 딛기), 경사 1% 고정. 재검사 때도 동일 프로토콜. <b>채혈 초를 0으로 두면 정지 없이 연속 진행(α1 전용 테스트)</b>, 혼자 할 때는 45~60초로 늘려도 됩니다.<span class="en">Recommended: 3-min stages + 30-s sampling pause (straddle the belt), 1% incline fixed. Keep the same protocol for retests. <b>Pause = 0 runs the stages back-to-back (α1-only test)</b>; alone, 45–60 s is fine.</span></p></div>
    <h2>${t('alpha_settings')}</h2><div class="card stack"><div class="grid3">${sel('alpha1.artifactMode', '아티팩트 임계 / threshold', [['auto', 'Auto (5%/25%)'], ['0.05', '5%'], ['0.25', '25%'], ['off', '끄기 / off']])}${sel('alpha1.stepSec', '갱신 주기 / update', [[5, '5 s'], [10, '10 s'], [20, '20 s']])}${sel('alpha1.scales', '스케일 / scales', [['fatmaxxer', 'FatMaxxer (3–15)'], ['kubios', '4–16']])}</div>
      <p class="small muted">기본값은 FatMaxxer와 동일(2분 창, smoothness priors λ=500, FatMaxxer 스케일).<span class="en">Defaults match FatMaxxer (2-min window, smoothness priors λ=500, FatMaxxer scales).</span></p></div>
    <h2>${t('alert_settings')}</h2><div class="card stack">${chk('alerts.voice', t('voice'))}${chk('alerts.vibrate', t('vibrate'))}${chk('alerts.beep', t('beep'))}${num('alerts.zoneExitSec', '존 이탈 알림 지연 초 / zone-exit delay s', 'step="5"')}<button data-action="test-alert">${t('test_alert')}</button></div>
    <h2>${t('plan_settings')}</h2><div class="card stack"><div class="grid2">${num('plan.weekdayMin', '평일 분 / weekday min', 'step="5"')}${num('plan.weekendMin', '주말 분 / weekend min', 'step="10"')}</div><div class="grid2">${sel('plan.goal', '목표 / Goal', [['base', tx('goal_base')], ['perf', tx('goal_perf')], ['health', tx('goal_health')]])}<label class="field">1주차 시작일 / Week-1 start<input type="date" data-set="plan.startDate" value="${esc(s.plan.startDate || '')}"></label></div></div>
    <h2>역치 직접 입력 <span class="en">Manual thresholds</span></h2><div class="card stack"><div class="grid2">${num('zones.lt1Hr', 'LT1 bpm')}${num('zones.lt1Speed', 'LT1 km/h', 'step="0.1"')}</div><div class="grid2">${num('zones.lt2Hr', 'LT2 bpm')}${num('zones.lt2Speed', 'LT2 km/h', 'step="0.1"')}</div><p class="small muted">테스트 결과를 적용하면 자동으로 채워집니다. / Filled automatically when you apply a test result.</p></div>
    <h2>테스트 당일 체크리스트 <span class="en">Test-day checklist</span></h2><div class="card"><details open><summary>펼치기 / expand</summary><ol class="small" style="padding-left:18px;margin:8px 0 0;line-height:1.6">
      <li>식후 2시간, 전날 고강도 금지, 카페인 자제, 같은 시간대 <span class="muted">/ 2 h after a meal, no hard session the day before, limit caffeine, same time of day</span></li>
      <li>H10 전극 적시기 → Train.Red 앱에서 FYER 시작(허벅지 외측광근) + H10을 심박 센서로 연결 <span class="muted">/ wet the H10 electrodes → start the FYER in the Train.Red app (vastus lateralis) and pair the H10 there too</span></li>
      <li>이 앱: 세션 → 단계 테스트 → H10 연결 → 시작 (화면 켜짐 유지 확인) <span class="muted">/ this app: Session → Step test → Connect H10 → Start (keep screen on)</span></li>
      <li>워밍업 5분 걷기 → 음성 안내대로 단계 진행. 각 단계 끝 "정지. 채혈하세요": 벨트 양옆을 딛고 속도는 그대로 둔 채 30초 안에 채혈·입력 <span class="muted">/ 5-min walk warm-up → follow the voice cues. At "Stop, sample": straddle the belt, keep the speed, sample and enter within 30 s</span></li>
      <li>단계가 바뀔 때마다 Train.Red 앱의 랩 버튼도 누르기 <span class="muted">/ press Lap in the Train.Red app at each stage change</span></li>
      <li>종료 기준(젖산 ≥6 또는 RPE ≥17)에 닿으면 그 단계까지 하고 종료 → 쿨다운 걷기 <span class="muted">/ at the stop criterion finish that stage, then cool down walking</span></li>
      <li>끝나면 Train.Red 앱에서 CSV 내보내기 → 이 앱 분석 탭에서 가져오기(자동 연결) → 삼각측량 확인 → "존에 적용" <span class="muted">/ export the Train.Red CSV → import it in Analysis (auto-attaches) → check the triangulation → Apply</span></li>
    </ol></details></div>
    <h2>${t('data')}</h2><div class="card stack"><button data-action="backup">${t('backup')}</button><button data-action="restore">${t('restore')}</button><button class="danger" data-action="clear-all">${t('clear_all')}</button><p class="small muted">모든 데이터는 이 폰의 브라우저 안에만 저장됩니다. 폰을 바꾸기 전 백업하세요.<span class="en">All data stays in this phone's browser. Back up before changing phones.</span></p></div>
    <p class="small muted" style="margin-top:14px">Treadmill Lab v1.0 · DFA α1 engine matches FatMaxxer alpha1v2 (Apache-2.0) · ${t('disclaimer')}</p>`;
}
function mountSettings() { /* delegated listener registered once in init */ }
async function onSettingsChange(e) {
  if (A.view !== 'settings') return;
  const el = e.target; const path = el.dataset.set; if (!path) return; const [g, k] = path.split('.');
  const val = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? null : +el.value) : el.value;
  A.settings[g][k] = val; if (g === 'zones') { A.settings.zones.updatedAt = Date.now(); A.settings.zones.source = 'manual'; A.settings.zones.grade = 'manual'; }
  await saveSettings(); if (A.alerts) A.alerts.update(A.settings.alerts); if (A.engine) A.engine.settings = A.settings; toast(tx('saved'), 1200);
  if (path === 'profile.lang' || path === 'profile.maxHrMode' || path === 'profile.birth') render();
}
$('#view').addEventListener('change', onSettingsChange);

// ---------- click actions ----------
async function onViewClick(e) {
  const b = e.target.closest('[data-action]'); if (!b) return; const act = b.dataset.action;
  switch (act) {
    case 'go-test': A.live.mode = 'test'; navigate('live'); break;
    case 'go-live': A.live.mode = b.dataset.mode || 'lt1'; if (b.dataset.minutes) A.live.minutes = +b.dataset.minutes; navigate('live'); break;
    case 'go-settings': navigate('settings'); break;
    case 'import': A.pendingReplayPick = false; $('#file-input').click(); break;
    case 'pick-replay': A.pendingReplayPick = true; $('#file-input').click(); break;
    case 'connect': await connectSource(); break;
    case 'start': await startSession(); break;
    case 'lap': A.engine?.lap(); break;
    case 'pause': A.engine?.pauseToggle(); break;
    case 'stop': await stopSession(); break;
    case 'rpe': openRpeModal(A.engine?.stages[A.engine.stageIdx]?.idx ?? null); break;
    case 'lactate': openLactateModal(A.engine?.stages[A.engine.stageIdx]?.idx ?? null); break;
    case 'mute': if (A.alerts) { A.alerts.muted = !A.alerts.muted; b.textContent = A.alerts.muted ? '🔇' : '🔊'; } break;
    case 'open-session': navigate('analysis', b.dataset.id); break;
    case 'back': navigate('analysis'); break;
    case 'delete-session': confirmBox(t('delete') + '?', async () => { await store.deleteSession(A.detail.id); await refreshLists(); navigate('analysis'); }); break;
    case 'delete-import': e.stopPropagation(); confirmBox(t('delete') + '?', async () => { await store.deleteImport(b.dataset.id); await refreshLists(); render(); }); break;
    case 'import-detail': { const i = await store.getImport(b.dataset.id); modal(`<h3>${esc(i.filename)}</h3><dl class="kv"><dt>source</dt><dd>${esc(i.source)}</dd><dt>start</dt><dd>${fmtDate(i.startedAt)}</dd><dt>duration</dt><dd>${fmtClock(i.durationSec)}</dd>${i.meta?.position ? `<dt>position</dt><dd>${esc(i.meta.position)}</dd>` : ''}${i.smo2Series ? `<dt>SmO2 pts</dt><dd>${i.smo2Series.length}</dd>` : ''}${i.features ? `<dt>features</dt><dd>${i.features.length}</dd>` : ''}</dl><p class="small muted" style="margin-top:8px">세션 상세에서 「SmO2 파일 붙이기」로 연결하세요. / Attach from a session's detail view.</p>`); break; }
    case 'export-csv': if (A.detail) exportSessionCsv(A.detail); break;
    case 'copy-summary': if (A.detail) { const s = A.detail; const r = analyzeSession(s); copyText(claudeSummary({ profile: { age: ageFrom(A.settings.profile.birth), restHr: A.settings.profile.restHr, maxHr: effectiveMaxHr() }, zones: zonesObj(), session: s, metrics: sessionMetrics(s), analysis: r, plan: null })); } break;
    case 'copy-plan': copyText(claudeSummary({ profile: { age: ageFrom(A.settings.profile.birth), restHr: A.settings.profile.restHr, maxHr: effectiveMaxHr() }, zones: zonesObj(), plan: A.planCache })); break;
    case 'attach-smo2': attachSmo2Modal(); break;
    case 'apply-zones': await applyZonesFromDetail(); break;
    case 'apply-verdict': { const vd = A.detail ? lactateVerdict(A.detail) : null; if (!vd || !vd.adjust) break; const z = A.settings.zones; if (vd.adjust.lt1Hr && Number.isFinite(z.lt1Hr)) z.lt1Hr = Math.round(z.lt1Hr + vd.adjust.lt1Hr); if (vd.adjust.lt2Speed && Number.isFinite(z.lt2Speed)) z.lt2Speed = Math.round((z.lt2Speed + vd.adjust.lt2Speed) * 10) / 10; z.source = (z.source || '') + ' +verify'; z.updatedAt = z.updatedAt || Date.now(); await saveSettings(); toast(tx('applied')); await renderSessionDetail(A.detail.id); break; }
    case 'apply-multiday': { const md = A.multiDay; if (!md?.analysis) break; const L1 = md.analysis.lt1Primary, L2 = md.analysis.lt2Primary; A.settings.zones = { lt1Hr: Math.round(L1.hr), lt2Hr: Math.round(L2.hr), lt1Speed: Math.round(L1.x * 10) / 10, lt2Speed: Math.round(L2.x * 10) / 10, source: 'multi-day lactate', grade: `${md.grade}/${md.grade}`, updatedAt: Date.now(), testSessionId: null }; if (!A.settings.plan.startDate) A.settings.plan.startDate = new Date().toISOString().slice(0, 10); await saveSettings(); toast(tx('applied')); render(); break; }
    case 'week-prev': A.settings.plan.weekOffset = (A.settings.plan.weekOffset || 0) - 1; await saveSettings(); render(); break;
    case 'week-next': A.settings.plan.weekOffset = (A.settings.plan.weekOffset || 0) + 1; await saveSettings(); render(); break;
    case 'test-alert': if (!A.alerts) A.alerts = new Alerts(A.settings.alerts); A.alerts.update(A.settings.alerts); A.alerts.unlock(); A.alerts.cue('알림 테스트. 3단계, 시속 8 킬로미터.', { beep: 'double', vib: [300, 100, 300] }); break;
    case 'backup': download(`treadmill-lab-backup_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await store.exportAll()), 'application/json'); break;
    case 'restore': A.pendingReplayPick = false; $('#file-input').click(); break;
    case 'clear-all': confirmBox(t('clear_all') + '?', async () => { await store.clearAll(); A.settings = JSON.parse(JSON.stringify(DEFAULTS)); await saveSettings(); await refreshLists(); navigate('home'); }); break;
    default: break;
  }
}

// ---------- init ----------
(async function init() {
  const saved = await store.getSettings(); A.settings = deepMerge(DEFAULTS, saved || {});
  setLang(A.settings.profile.lang); applyTheme();
  await refreshLists();
  let v = 'home'; try { v = localStorage.getItem('tl.view') || 'home'; } catch (e) { /* ignore */ }
  if (v === 'analysis' || v === 'live') v = 'home';
  navigate(v);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    try { const reg = await navigator.serviceWorker.register('./sw.js'); reg.addEventListener('updatefound', () => { const nw = reg.installing; nw && nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) { toast('새 버전이 있습니다 — 새로고침하세요 / Update available — reload', 6000); } }); }); } catch (e) { console.warn('sw', e); }
  }
  window.addEventListener('beforeunload', ev => { if (A.engine && A.engine.state === 'running') { ev.preventDefault(); ev.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && A.alerts?.wakeLock == null && A.engine?.state === 'running') A.alerts.keepAwake(true); });
  A.saveSettings = saveSettings; A.navigate = navigate; A.refreshLists = refreshLists;
  window.TL = A; // debugging hook
})();

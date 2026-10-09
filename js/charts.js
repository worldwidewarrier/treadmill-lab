// uPlot wrappers (uPlot is loaded globally from vendor/uPlot.iife.min.js).
const css = (name, fallback) => (getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);
function theme() { return { fg: css('--fg', '#e8edf1'), muted: css('--muted', '#93a1ad'), grid: css('--line', '#2a343d'), hr: css('--c-hr', '#ff7a45'), a1: css('--c-a1', '#3ddc84'), la: css('--c-la', '#f5a524'), smo2: css('--c-smo2', '#4fb3ff'), thr: css('--muted', '#93a1ad') }; }
const axisBase = (t, extra = {}) => ({ stroke: t.muted, grid: { stroke: t.grid, width: 1 }, ticks: { stroke: t.grid, width: 1 }, font: '11px system-ui', ...extra });
const fmtClock = v => { const m = Math.floor(v / 60), s = Math.floor(v % 60); return `${m}:${String(s).padStart(2, '0')}`; };

function thresholdLines(levels, scaleKey, color) {
  return { hooks: { draw: [u => { const ctx = u.ctx; ctx.save(); ctx.strokeStyle = color; ctx.setLineDash([4, 4]); ctx.lineWidth = 1; for (const lv of levels) { const y = u.valToPos(lv, scaleKey, true); if (y < u.bbox.top || y > u.bbox.top + u.bbox.height) continue; ctx.beginPath(); ctx.moveTo(u.bbox.left, y); ctx.lineTo(u.bbox.left + u.bbox.width, y); ctx.stroke(); } ctx.restore(); }] } };
}
function bandPlugin(getBand, scaleKey, color) {
  return { hooks: { drawClear: [u => { const b = getBand(); if (!b) return; const ctx = u.ctx; const y1 = u.valToPos(b[1], scaleKey, true), y0 = u.valToPos(b[0], scaleKey, true); ctx.save(); ctx.fillStyle = color; ctx.fillRect(u.bbox.left, Math.min(y0, y1), u.bbox.width, Math.abs(y0 - y1)); ctx.restore(); }] } };
}

/** Live chart: time (s) vs HR (left) and α1 (right). */
export function liveChart(el, { getBand = () => null, alpha = true } = {}) {
  const t = theme();
  const opts = {
    width: el.clientWidth || 360, height: 190, padding: [8, 4, 0, 0], cursor: { show: false }, legend: { show: false },
    scales: { x: { time: false }, hr: { range: (u, min, max) => [Math.floor((min - 5) / 10) * 10, Math.ceil((max + 5) / 10) * 10] }, a1: { range: [0.2, 1.6] } },
    axes: [axisBase(t, { values: (u, v) => v.map(fmtClock), space: 60 }), axisBase(t, { scale: 'hr', size: 36 }), ...(alpha ? [axisBase(t, { scale: 'a1', side: 1, size: 36, values: (u, v) => v.map(x => x.toFixed(1)) })] : [])],
    series: [{}, { label: 'HR', scale: 'hr', stroke: t.hr, width: 2, points: { show: false } }, ...(alpha ? [{ label: 'α1', scale: 'a1', stroke: t.a1, width: 2, points: { show: false }, spanGaps: true }] : [])],
    plugins: [...(alpha ? [thresholdLines([0.75, 0.5], 'a1', t.thr)] : []), bandPlugin(getBand, 'hr', 'rgba(61,220,132,0.10)')],
  };
  const u = new uPlot(opts, alpha ? [[0], [null], [null]] : [[0], [null]], el);
  return { u, setData: (ts, hr, a1) => u.setData(alpha ? [ts, hr, a1] : [ts, hr]), resize: () => u.setSize({ width: el.clientWidth, height: 190 }), destroy: () => u.destroy() };
}

/** Session timeline: HR, α1 and optional SmO2 vs elapsed seconds. */
export function timelineChart(el, { ts, hr, a1, smo2 = null, band = null, height = 220, alpha = true }) {
  const t = theme();
  const series = [{}, { label: 'HR', scale: 'hr', stroke: t.hr, width: 1.5, points: { show: false }, spanGaps: true }];
  const data = [ts, hr];
  if (alpha) { series.push({ label: 'α1', scale: 'a1', stroke: t.a1, width: 1.5, points: { show: false }, spanGaps: true }); data.push(a1); }
  if (smo2) { series.push({ label: 'SmO2', scale: 'smo2', stroke: t.smo2, width: 1.5, points: { show: false }, spanGaps: true }); data.push(smo2); }
  // without α1 the SmO2 gets the right-hand axis
  const axes = [axisBase(t, { values: (u, v) => v.map(fmtClock), space: 60 }), axisBase(t, { scale: 'hr', size: 36 }), ...(alpha ? [axisBase(t, { scale: 'a1', side: 1, size: 36, values: (u, v) => v.map(x => x.toFixed(1)) })] : smo2 ? [axisBase(t, { scale: 'smo2', side: 1, size: 36 })] : [])];
  const opts = { width: el.clientWidth || 360, height, padding: [8, 4, 0, 0], legend: { show: true }, cursor: { drag: { x: true, y: false } },
    scales: { x: { time: false }, hr: {}, a1: { range: [0.2, 1.6] }, smo2: { range: (u, mn, mx) => [Math.floor((mn - 2) / 5) * 5, Math.ceil((mx + 2) / 5) * 5] } }, axes, series,
    plugins: [...(alpha ? [thresholdLines([0.75, 0.5], 'a1', t.thr)] : []), bandPlugin(() => band, 'hr', 'rgba(61,220,132,0.10)')] };
  const u = new uPlot(opts, data, el);
  return { u, destroy: () => u.destroy() };
}

/** Step-test chart: x = speed; lactate (left), α1 (right), SmO2 (right, own scale, drawn without axis). */
export function stepTestChart(el, { speeds, lactate, a1, smo2, hr, marks = [], alpha = true }) {
  const t = theme();
  const series = [{}, { label: 'Lactate', scale: 'la', stroke: t.la, width: 2, points: { show: true, size: 7 }, spanGaps: true }];
  const data = [speeds, lactate];
  if (alpha) { series.push({ label: 'α1', scale: 'a1', stroke: t.a1, width: 2, points: { show: true, size: 6 }, spanGaps: true }); data.push(a1); }
  if (smo2 && smo2.some(v => Number.isFinite(v))) { series.push({ label: 'SmO2', scale: 'smo2', stroke: t.smo2, width: 2, points: { show: true, size: 6 }, spanGaps: true }); data.push(smo2); }
  if (hr && hr.some(v => Number.isFinite(v))) { series.push({ label: 'HR', scale: 'hr', stroke: t.hr, width: 1, dash: [3, 3], points: { show: false }, spanGaps: true }); data.push(hr); }
  const marksPlugin = { hooks: { draw: [u => { const ctx = u.ctx; ctx.save(); ctx.font = '11px system-ui'; ctx.textAlign = 'center'; for (const m of marks) { if (!Number.isFinite(m.x)) continue; const x = u.valToPos(m.x, 'x', true); ctx.strokeStyle = m.color || t.muted; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, u.bbox.top); ctx.lineTo(x, u.bbox.top + u.bbox.height); ctx.stroke(); ctx.fillStyle = m.color || t.muted; ctx.fillText(m.label, x, u.bbox.top + 12 + (m.row || 0) * 13); } ctx.restore(); }] } };
  const opts = { width: el.clientWidth || 360, height: 240, padding: [8, 4, 0, 0], legend: { show: true }, cursor: { show: true },
    scales: { x: { time: false, range: (u, mn, mx) => [mn - 0.5, mx + 0.5] }, la: { range: (u, mn, mx) => [0, Math.max(4, Math.ceil(mx + 1))] }, a1: { range: [0.2, 1.6] }, smo2: { range: (u, mn, mx) => [Math.floor((mn - 3) / 5) * 5, Math.ceil((mx + 3) / 5) * 5] }, hr: { range: (u, mn, mx) => [mn - 60, mx + 10] } },
    axes: [axisBase(t, { values: (u, v) => v.map(x => x + ''), label: 'km/h', labelFont: '11px system-ui', labelSize: 14 }), axisBase(t, { scale: 'la', size: 34, values: (u, v) => v.map(x => x + '') }), ...(alpha ? [axisBase(t, { scale: 'a1', side: 1, size: 36, values: (u, v) => v.map(x => x.toFixed(1)) })] : [])],
    series, plugins: [...(alpha ? [thresholdLines([0.75, 0.5], 'a1', t.thr)] : []), marksPlugin] };
  const u = new uPlot(opts, data, el);
  return { u, destroy: () => u.destroy() };
}

/** Trend chart across tests: LT1/LT2 HR by date index. */
export function trendChart(el, { labels, lt1, lt2 }) {
  const t = theme();
  const xs = labels.map((_, i) => i);
  const opts = { width: el.clientWidth || 360, height: 180, padding: [8, 4, 0, 0], legend: { show: true }, cursor: { show: false },
    scales: { x: { time: false, range: [-0.5, xs.length - 0.5] }, hr: { range: (u, mn, mx) => [mn - 5, mx + 5] } },
    axes: [axisBase(t, { values: (u, v) => v.map(i => labels[Math.round(i)] || ''), space: 50 }), axisBase(t, { scale: 'hr', size: 36 })],
    series: [{}, { label: 'LT1 HR', scale: 'hr', stroke: t.a1, width: 2, points: { show: true } }, { label: 'LT2 HR', scale: 'hr', stroke: t.hr, width: 2, points: { show: true } }] };
  const u = new uPlot(opts, [xs, lt1, lt2], el);
  return { u, destroy: () => u.destroy() };
}

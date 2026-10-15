// Flyby comparer: overlay several activities and replay them on a shared clock.
// Activity elapsed time e_i = T + off_i + adj_i, where off_i comes from the
// auto alignment mode and adj_i from the activity's manual slider.

const COLORS = ['#FC4C02', '#1F77B4', '#2CA02C', '#9467BD', '#D62728', '#17BECF', '#8C564B', '#E377C2', '#BCBD22', '#7F7F7F'];
const SPEEDS = [1, 5, 10, 30, 60, 120, 300, 600];
const TAIL_SECONDS = 90;

const state = {
  acts: [],
  mode: 'point',       // 'point' | 'start' | 'clock'
  refId: null,
  T: 0, Tmin: 0, Tmax: 0,
  playing: false,
  speed: 30,
  follow: false,
  startInfo: '',
  nextId: 1,
};

const $ = sel => document.querySelector(sel);

// ---------- geometry ----------
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function buildActivity(parsed) {
  const pts = parsed.points, n = pts.length;
  const t = new Float64Array(n), lat = new Float64Array(n), lon = new Float64Array(n);
  const ele = new Float64Array(n), dist = new Float64Array(n);
  const useRecorded = pts.every(p => p.dist != null);
  let hasEle = false;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    t[i] = (p.time - pts[0].time) / 1000;
    lat[i] = p.lat; lon[i] = p.lon;
    ele[i] = p.ele ?? NaN;
    if (p.ele != null) hasEle = true;
    let d = i === 0 ? 0 : useRecorded ? p.dist - pts[0].dist
      : dist[i - 1] + haversine(lat[i - 1], lon[i - 1], lat[i], lon[i]);
    dist[i] = i === 0 ? 0 : Math.max(dist[i - 1], d);
  }
  if (hasEle) { // fill gaps in elevation
    let last = NaN;
    for (let i = 0; i < n; i++) { if (Number.isNaN(ele[i])) ele[i] = last; else last = ele[i]; }
    for (let i = n - 1; i >= 0; i--) { if (Number.isNaN(ele[i])) ele[i] = last; else last = ele[i]; }
  }
  const id = state.nextId++;
  return {
    id, name: parsed.name, color: COLORS[(id - 1) % COLORS.length], visible: true,
    startMs: pts[0].time, t, lat, lon, ele, dist, hasEle, n,
    duration: t[n - 1], total: dist[n - 1], off: 0, adj: 0, base: 0,
  };
}

// index of last sample with arr[i] <= x (arr non-decreasing)
function lowerIndex(arr, x) {
  let lo = 0, hi = arr.length - 1;
  if (x <= arr[0]) return 0;
  if (x >= arr[hi]) return hi;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid; else hi = mid; }
  return lo;
}

function sampleAt(a, e) {
  const status = e < 0 ? 'waiting' : e > a.duration ? 'finished' : 'riding';
  const ec = Math.min(Math.max(e, 0), a.duration);
  const i = lowerIndex(a.t, ec), j = Math.min(i + 1, a.n - 1);
  const span = a.t[j] - a.t[i], f = span > 0 ? (ec - a.t[i]) / span : 0;
  const lerp = arr => arr[i] + (arr[j] - arr[i]) * f;
  return { lat: lerp(a.lat), lon: lerp(a.lon), ele: lerp(a.ele), dist: lerp(a.dist), status };
}

function timeAtDist(a, d) {
  if (d > a.total || d < 0) return null;
  const i = lowerIndex(a.dist, d), j = Math.min(i + 1, a.n - 1);
  const span = a.dist[j] - a.dist[i], f = span > 0 ? (d - a.dist[i]) / span : 0;
  return a.t[i] + (a.t[j] - a.t[i]) * f;
}

function elevationAtDist(a, d) {
  const i = lowerIndex(a.dist, d), j = Math.min(i + 1, a.n - 1);
  const span = a.dist[j] - a.dist[i], f = span > 0 ? (d - a.dist[i]) / span : 0;
  return a.ele[i] + (a.ele[j] - a.ele[i]) * f;
}

const elapsed = (a, T) => T + a.off + a.adj;
const relDist = (a, T) => sampleAt(a, elapsed(a, T)).dist - a.base;

// ---------- alignment ----------
const CELL = 0.0006; // ~60 m grid for proximity lookups
const cellKey = (lat, lon) => `${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`;

// grid cell -> first sample index that falls in it
function firstIndexByCell(a) {
  const m = new Map();
  for (let i = 0; i < a.n; i++) {
    const k = cellKey(a.lat[i], a.lon[i]);
    if (!m.has(k)) m.set(k, i);
  }
  return m;
}

// first index whose cell is next to (lat, lon)'s cell, or -1 if the activity never comes near
function firstNearIndex(cells, lat, lon) {
  const ci = Math.floor(lat / CELL), cj = Math.floor(lon / CELL);
  let best = -1;
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
    const i = cells.get(`${ci + di},${cj + dj}`);
    if (i !== undefined && (best < 0 || i < best)) best = i;
  }
  return best;
}

// refine a rough first-pass index to the closest sample of that same pass
function refinePass(a, i0, lat, lon) {
  let best = i0, bestD = haversine(a.lat[i0], a.lon[i0], lat, lon);
  for (let i = i0 + 1; i < a.n; i++) {
    const d = haversine(a.lat[i], a.lon[i], lat, lon);
    if (d < bestD) { bestD = d; best = i; }
    else if (d > bestD + 200) break; // moved away again: this pass is over
  }
  return best;
}

function computeAlignment() {
  const acts = state.acts;
  state.startInfo = '';
  if (!acts.length) return;
  const ref = acts.find(a => a.id === state.refId) || acts[0];
  state.refId = ref.id;
  if (state.mode === 'start') {
    for (const a of acts) { a.off = 0; a.base = 0; }
  } else if (state.mode === 'clock') {
    const minStart = Math.min(...acts.map(a => a.startMs));
    for (const a of acts) { a.off = (minStart - a.startMs) / 1000; a.base = 0; }
  } else {
    // Candidate start points along the reference; pick the one that every activity reaches
    // earliest (minimise the largest distance anyone rides before getting there). Taking the
    // first shared point instead breaks loops started at different places: someone may pass
    // the reference's start only at the very end of their ride.
    const others = acts.filter(a => a !== ref).map(a => ({ a, cells: firstIndexByCell(a) }));
    let bestIdx = -1, bestCost = Infinity, lastD = -Infinity;
    for (let i = 0; i < ref.n; i++) {
      if (ref.dist[i] - lastD < 50 && i !== ref.n - 1) continue; // sample every ~50 m
      lastD = ref.dist[i];
      if (ref.dist[i] >= bestCost) break; // the reference alone already costs more
      let cost = ref.dist[i];
      for (const o of others) {
        const j = firstNearIndex(o.cells, ref.lat[i], ref.lon[i]);
        if (j < 0) { cost = Infinity; break; }
        cost = Math.max(cost, o.a.dist[j]);
        if (cost >= bestCost) break;
      }
      if (cost < bestCost) { bestCost = cost; bestIdx = i; }
    }
    const found = bestIdx >= 0;
    const startIdx = found ? bestIdx : 0;
    const sLat = ref.lat[startIdx], sLon = ref.lon[startIdx];
    for (const a of acts) {
      let idx = startIdx;
      if (a !== ref) {
        const j = found ? firstNearIndex(firstIndexByCell(a), sLat, sLon) : -1;
        idx = j >= 0 ? refinePass(a, j, sLat, sLon) : 0;
      }
      a.off = a.t[idx];
      a.base = a.dist[idx];
    }
    state.startInfo = found
      ? `共同起點：參考活動第 ${(ref.dist[startIdx] / 1000).toFixed(2)} km 處`
      : '找不到所有活動都經過的點，改為各自的起點開始';
  }
  updateRange();
}

function updateRange() {
  const vis = state.acts.filter(a => a.visible);
  if (!vis.length) { state.Tmin = state.Tmax = state.T = 0; return; }
  state.Tmin = Math.min(...vis.map(a => -(a.off + a.adj)));
  state.Tmax = Math.max(...vis.map(a => a.duration - a.off - a.adj));
  if (state.mode === 'point') state.Tmin = Math.min(state.Tmin, 0);
  state.T = Math.min(Math.max(state.T, state.Tmin), state.Tmax);
}

// ---------- formatting ----------
function fmtDur(s, signed = false) {
  const sign = s < 0 ? '−' : signed ? '+' : '';
  s = Math.round(Math.abs(s));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  const mmss = `${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
  return sign + (h ? `${h}:${mmss}` : mmss);
}
const fmtKm = m => `${(m / 1000).toFixed(2)} km`;
const fmtDate = ms => new Date(ms).toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- map ----------
let map = null;
// Full tracks (canvas) and the moving markers/tails (SVG) use separate renderers, so
// moving a marker only repaints the marker's own small area, not every full track.
let trackRenderer = null, liveRenderer = null;
const layers = new Map(); // id -> { line, tail, marker, status }

function initMap() {
  if (typeof L === 'undefined') {
    $('#map').innerHTML = '<p class="map-error">地圖函式庫載入失敗（需要網路連線），其餘功能仍可使用。</p>';
    return;
  }
  map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([25.02, 121.54], 11);
  // Small padding: Leaflet's default 0.5 makes each canvas 4x the map area, and
  // repainting a canvas that big is what made playback stutter on laptops.
  trackRenderer = L.canvas({ padding: 0.1 });
  liveRenderer = L.svg({ padding: 0.1 });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
}

function rebuildLayers() {
  if (!map) return;
  for (const l of layers.values()) { l.line.remove(); l.tail.remove(); l.marker.remove(); }
  layers.clear();
  const bounds = [];
  for (const a of state.acts) {
    const latlngs = [];
    const step = Math.max(1, Math.floor(a.n / 4000));
    for (let i = 0; i < a.n; i += step) latlngs.push([a.lat[i], a.lon[i]]);
    const line = L.polyline(latlngs, { color: a.color, weight: 3, opacity: 0.35, renderer: trackRenderer });
    const tail = L.polyline([], { color: a.color, weight: 5, opacity: 0.9, renderer: liveRenderer });
    const marker = L.circleMarker([a.lat[0], a.lon[0]], { radius: 8, color: '#fff', weight: 2, fillColor: a.color, fillOpacity: 1, renderer: liveRenderer })
      .bindTooltip(escapeHtml(a.name));
    if (a.visible) { line.addTo(map); tail.addTo(map); marker.addTo(map); latlngs.forEach(p => bounds.push(p)); }
    layers.set(a.id, { line, tail, marker, status: null });
  }
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], animate: false });
}

function updateMap() {
  if (!map) return;
  let leader = null, leadD = -Infinity;
  for (const a of state.acts) {
    const l = layers.get(a.id);
    if (!l || !a.visible) continue;
    const e = elapsed(a, state.T);
    const s = sampleAt(a, e);
    l.marker.setLatLng([s.lat, s.lon]);
    if (l.status !== s.status) { l.status = s.status; l.marker.setStyle({ fillOpacity: s.status === 'riding' ? 1 : 0.4 }); }
    const from = lowerIndex(a.t, Math.max(0, e - TAIL_SECONDS)), to = lowerIndex(a.t, Math.max(0, Math.min(e, a.duration)));
    const tail = [];
    for (let i = from; i <= to; i++) tail.push([a.lat[i], a.lon[i]]);
    tail.push([s.lat, s.lon]);
    l.tail.setLatLngs(e > 0 ? tail : []);
    if (s.dist - a.base > leadD) { leadD = s.dist - a.base; leader = s; }
  }
  // Re-centre only when the leader nears the edge: panning every frame forces the
  // map (tiles and every track) to redraw on every frame.
  if (state.follow && leader) {
    const p = map.latLngToContainerPoint([leader.lat, leader.lon]), size = map.getSize();
    if (p.x < size.x * 0.2 || p.x > size.x * 0.8 || p.y < size.y * 0.2 || p.y > size.y * 0.8) {
      map.panTo([leader.lat, leader.lon], { animate: false });
    }
  }
}

// ---------- leaderboard ----------
let boardHtml = '';
function setBoard(html) {
  if (html === boardHtml) return;
  boardHtml = html;
  $('#board').innerHTML = html;
}

function updateBoard() {
  const rows = state.acts.filter(a => a.visible).map(a => {
    const e = elapsed(a, state.T);
    const s = sampleAt(a, e);
    const prev = sampleAt(a, e - 10);
    const speed = s.status === 'riding' ? Math.max(0, (s.dist - prev.dist) / Math.min(10, Math.max(e, 1))) * 3.6 : 0;
    return { a, e, s, d: s.dist - a.base, speed };
  }).sort((x, y) => y.d - x.d);
  if (!rows.length) { setBoard(''); return; }
  const lead = rows[0];
  setBoard(`<table>
    <thead><tr><th></th><th>活動</th><th>距離</th><th>落後</th><th>時速</th></tr></thead>
    <tbody>${rows.map((r, k) => {
      let gap = '—';
      if (k > 0) {
        const tReach = timeAtDist(r.a, lead.d + r.a.base);
        gap = tReach != null && r.e >= 0 ? `${fmtDur(tReach - r.e, true)}` : `${((lead.d - r.d) / 1000).toFixed(2)} km`;
      }
      const status = r.s.status === 'waiting' ? '<span class="tag">未出發</span>' : r.s.status === 'finished' ? '<span class="tag">完成</span>' : '';
      return `<tr><td><span class="dot" style="background:${r.a.color}"></span>${k + 1}</td>
        <td class="name">${escapeHtml(r.a.name)} ${status}</td>
        <td>${fmtKm(Math.max(0, r.d))}</td><td>${gap}</td><td>${r.speed.toFixed(1)}</td></tr>`;
    }).join('')}</tbody></table>`);
}

// ---------- charts ----------
// Each chart has a static background (axes, curves, elevation profile) drawn once into
// an offscreen canvas; a frame only copies it and draws the cursor/dots on top.
let chartVersion = 0;     // bump to redraw backgrounds (alignment, visibility, reference, theme)
const chartBg = new Map(); // canvas id -> { key, img, scale }
const canvasSize = new Map(); // canvas id -> { w, h }, refreshed on resize (avoids forced layout per frame)

let theme = null;
function colors() {
  if (!theme) {
    const cs = getComputedStyle(document.body);
    theme = { muted: cs.getPropertyValue('--muted'), grid: cs.getPropertyValue('--grid'),
      area: cs.getPropertyValue('--area'), text: cs.getPropertyValue('--text') };
  }
  return theme;
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  let size = canvasSize.get(canvas.id);
  if (!size) { size = { w: canvas.clientWidth, h: canvas.clientHeight }; canvasSize.set(canvas.id, size); }
  const { w, h } = size;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

// draw(ctx) paints the background and returns whatever the per-frame overlay needs
function background(canvas, w, h, draw) {
  const dpr = window.devicePixelRatio || 1;
  const key = `${w}x${h}@${dpr}#${chartVersion}`;
  let bg = chartBg.get(canvas.id);
  if (!bg || bg.key !== key) {
    const img = document.createElement('canvas');
    img.width = Math.round(w * dpr); img.height = Math.round(h * dpr);
    const ctx = img.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bg = { key, img, scale: draw(ctx) };
    chartBg.set(canvas.id, bg);
  }
  return bg;
}

const PAD = { l: 64, r: 16, t: 28, b: 28 };
let gapCache = null; // recomputed when alignment or visibility changes

function chartRange() {
  const vis = state.acts.filter(a => a.visible);
  if (!vis.length) return null;
  const ref = state.acts.find(a => a.id === state.refId);
  const D = Math.min(...vis.map(a => a.total - a.base));
  return { vis, ref, D: Math.max(D, 1) };
}

function computeGaps() {
  chartVersion++;
  const r = chartRange();
  if (!r || !r.ref || !r.ref.visible) { gapCache = null; return; }
  const N = 400, series = [];
  let lo = 0, hi = 0;
  for (const a of r.vis) {
    const ys = new Float64Array(N + 1);
    for (let k = 0; k <= N; k++) {
      const d = (r.D * k) / N;
      const ta = timeAtDist(a, d + a.base), tr = timeAtDist(r.ref, d + r.ref.base);
      const y = ta == null || tr == null ? NaN : (tr - r.ref.off - r.ref.adj) - (ta - a.off - a.adj);
      ys[k] = y;
      if (Number.isFinite(y)) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
    }
    series.push({ a, ys });
  }
  const pad = Math.max(10, (hi - lo) * 0.08);
  gapCache = { D: r.D, N, series, lo: lo - pad, hi: hi + pad };
}

function drawAxes(ctx, w, h, title) {
  const c = colors();
  ctx.fillStyle = c.muted;
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(title, PAD.l, 16);
  ctx.strokeStyle = c.grid;
  ctx.lineWidth = 1;
  ctx.strokeRect(PAD.l, PAD.t, w - PAD.l - PAD.r, h - PAD.t - PAD.b);
}

function drawDistTicks(ctx, w, h, D) {
  ctx.fillStyle = colors().muted; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
  const stepKm = [0.5, 1, 2, 5, 10, 20, 50, 100].find(s => D / 1000 / s <= 8) || 200;
  for (let km = 0; km * 1000 <= D; km += stepKm) {
    const x = PAD.l + (km * 1000 / D) * (w - PAD.l - PAD.r);
    ctx.fillText(`${km} km`, x, h - 8);
  }
  ctx.textAlign = 'left';
}

function leaderDist() {
  const vis = state.acts.filter(a => a.visible);
  return vis.length ? Math.max(...vis.map(a => relDist(a, state.T))) : 0;
}

function drawGapChart() {
  const canvas = $('#gapChart');
  const { ctx, w, h } = setupCanvas(canvas);
  const bg = background(canvas, w, h, g => {
    const ref = state.acts.find(a => a.id === state.refId);
    drawAxes(g, w, h, `與參考活動（${ref ? ref.name : '—'}）的時間差：往上 = 比參考快（秒）`);
    if (!gapCache) return null;
    const { D, N, series, lo, hi } = gapCache;
    const X = d => PAD.l + (d / D) * (w - PAD.l - PAD.r);
    const Y = v => PAD.t + (1 - (v - lo) / (hi - lo)) * (h - PAD.t - PAD.b);
    const muted = colors().muted;
    g.fillStyle = muted; g.font = '11px system-ui, sans-serif'; g.textAlign = 'right';
    for (const v of [lo, 0, hi]) g.fillText(fmtDur(v, true), PAD.l - 6, Y(v) + 4);
    g.textAlign = 'left';
    g.strokeStyle = muted; g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(PAD.l, Y(0)); g.lineTo(w - PAD.r, Y(0)); g.stroke(); g.setLineDash([]);
    for (const { a, ys } of series) {
      g.strokeStyle = a.color; g.lineWidth = 2; g.beginPath();
      let pen = false;
      for (let k = 0; k <= N; k++) {
        if (!Number.isFinite(ys[k])) { pen = false; continue; }
        const x = X((D * k) / N), y = Y(ys[k]);
        pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true;
      }
      g.stroke();
    }
    drawDistTicks(g, w, h, D);
    return { X, D };
  });
  ctx.drawImage(bg.img, 0, 0, w, h);
  if (bg.scale) drawCursor(ctx, h, bg.scale.X(Math.min(Math.max(leaderDist(), 0), bg.scale.D)));
}

function drawEleChart() {
  const canvas = $('#eleChart');
  const { ctx, w, h } = setupCanvas(canvas);
  const ref = state.acts.find(a => a.id === state.refId);
  const bg = background(canvas, w, h, g => {
    drawAxes(g, w, h, '參考活動的海拔剖面與目前位置');
    if (!ref || !ref.hasEle) return null;
    const D = ref.total - ref.base;
    if (D <= 0) return null;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < ref.n; i++) if (ref.dist[i] >= ref.base) { lo = Math.min(lo, ref.ele[i]); hi = Math.max(hi, ref.ele[i]); }
    const pad = Math.max(5, (hi - lo) * 0.1); lo -= pad; hi += pad;
    const X = d => PAD.l + (d / D) * (w - PAD.l - PAD.r);
    const Y = v => PAD.t + (1 - (v - lo) / (hi - lo)) * (h - PAD.t - PAD.b);
    g.beginPath(); g.moveTo(X(0), Y(lo));
    for (let i = 0; i < ref.n; i++) if (ref.dist[i] >= ref.base) g.lineTo(X(ref.dist[i] - ref.base), Y(ref.ele[i]));
    g.lineTo(X(D), Y(lo)); g.closePath();
    g.fillStyle = colors().area; g.fill();
    g.fillStyle = colors().muted;
    g.font = '11px system-ui, sans-serif'; g.textAlign = 'right';
    g.fillText(`${Math.round(hi - pad)} m`, PAD.l - 6, Y(hi - pad) + 4);
    g.fillText(`${Math.round(lo + pad)} m`, PAD.l - 6, Y(lo + pad) + 4);
    g.textAlign = 'left';
    drawDistTicks(g, w, h, D);
    return { X, Y, D };
  });
  ctx.drawImage(bg.img, 0, 0, w, h);
  if (!bg.scale) return;
  const { X, Y, D } = bg.scale;
  for (const a of state.acts) {
    if (!a.visible) continue;
    const d = Math.min(Math.max(relDist(a, state.T), 0), D);
    ctx.beginPath(); ctx.arc(X(d), Y(elevationAtDist(ref, d + ref.base)), 6, 0, Math.PI * 2);
    ctx.fillStyle = a.color; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  }
}

function drawCursor(ctx, h, x) {
  ctx.strokeStyle = colors().text;
  ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, h - PAD.b); ctx.stroke();
}

// click on a chart: jump to when the reference activity reached that distance
function seekFromChart(ev, canvas) {
  const ref = state.acts.find(a => a.id === state.refId);
  if (!ref) return;
  const D = canvas.id === 'gapChart' ? gapCache?.D : ref.total - ref.base;
  if (!D) return;
  const rect = canvas.getBoundingClientRect();
  const f = (ev.clientX - rect.left - PAD.l) / (rect.width - PAD.l - PAD.r);
  const t = timeAtDist(ref, Math.min(Math.max(f, 0), 1) * D + ref.base);
  if (t == null) return;
  state.T = Math.min(Math.max(t - ref.off - ref.adj, state.Tmin), state.Tmax);
  render();
}

// ---------- sidebar ----------
function renderList() {
  const list = $('#acts');
  const maxDur = Math.max(3600, ...state.acts.map(a => a.duration));
  list.innerHTML = state.acts.map(a => `
    <li class="act" data-id="${a.id}">
      <div class="act-head">
        <input type="checkbox" class="vis" ${a.visible ? 'checked' : ''} title="顯示／隱藏">
        <span class="dot" style="background:${a.color}"></span>
        <span class="act-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
        <button class="icon remove" title="移除">✕</button>
      </div>
      <div class="act-meta">${fmtDate(a.startMs)} · ${fmtKm(a.total)} · ${fmtDur(a.duration)}</div>
      <label class="shift">手動平移
        <input type="range" class="adj" min="${-Math.ceil(maxDur)}" max="${Math.ceil(maxDur)}" step="1" value="${a.adj}">
      </label>
      <div class="shift-row">
        <input type="number" class="adj-num" step="1" value="${a.adj}"> 秒
        <span class="adj-fmt">${fmtDur(a.adj, true)}</span>
        <button class="small reset">歸零</button>
      </div>
    </li>`).join('');
  const refSel = $('#refSelect');
  refSel.innerHTML = state.acts.map(a => `<option value="${a.id}" ${a.id === state.refId ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('');
  $('#startInfo').textContent = state.startInfo;
  $('#empty').hidden = state.acts.length > 0;
}

function onListEvent(ev) {
  const li = ev.target.closest('.act');
  if (!li) return;
  const a = state.acts.find(x => x.id === Number(li.dataset.id));
  const t = ev.target;
  if (t.classList.contains('remove')) {
    state.acts = state.acts.filter(x => x !== a);
    if (state.refId === a.id) state.refId = state.acts[0]?.id ?? null;
    fullRefresh(true);
    return;
  }
  if (t.classList.contains('vis')) { a.visible = t.checked; fullRefresh(true); return; }
  let v = null;
  if (t.classList.contains('adj') || t.classList.contains('adj-num')) v = Math.round(Number(t.value) || 0);
  if (t.classList.contains('reset')) v = 0;
  if (v === null) return;
  a.adj = v;
  li.querySelector('.adj').value = v;
  if (t !== li.querySelector('.adj-num')) li.querySelector('.adj-num').value = v;
  li.querySelector('.adj-fmt').textContent = fmtDur(v, true);
  updateRange(); computeGaps(); render();
}

// ---------- playback ----------
const FRAME_MS = 1000 / 30; // playback redraw cap: plenty for a replay, half the work of 60 fps
const BOARD_MS = 250;       // leaderboard text refresh while playing
let lastBoard = 0;

function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

function render() {
  const slider = $('#time');
  const min = String(Math.floor(state.Tmin)), max = String(Math.ceil(state.Tmax));
  if (slider.min !== min) slider.min = min;
  if (slider.max !== max) slider.max = max;
  slider.value = state.T;
  let label = fmtDur(state.T, true);
  if (state.mode === 'clock' && state.acts.length) {
    const minStart = Math.min(...state.acts.map(a => a.startMs));
    label += ` · ${new Date(minStart + state.T * 1000).toLocaleTimeString('zh-TW', { hour12: false })}`;
  }
  setText($('#timeLabel'), label);
  setText($('#play'), state.playing ? '❚❚ 暫停' : '▶ 播放');
  updateMap();
  const now = performance.now();
  if (!state.playing || now - lastBoard >= BOARD_MS) { lastBoard = now; updateBoard(); }
  drawGapChart(); drawEleChart();
}

let lastFrame = null, lastDraw = 0;
function tick(now) {
  if (!state.playing) { lastFrame = null; return; }
  if (lastFrame != null) {
    state.T += ((now - lastFrame) / 1000) * state.speed;
    if (state.T >= state.Tmax) { state.T = state.Tmax; state.playing = false; }
  }
  lastFrame = now;
  if (!state.playing || now - lastDraw >= FRAME_MS - 2) { lastDraw = now; render(); }
  if (state.playing) requestAnimationFrame(tick);
}

function togglePlay() {
  if (!state.acts.length) return;
  if (!state.playing && state.T >= state.Tmax) state.T = state.Tmin;
  state.playing = !state.playing;
  render();
  if (state.playing) requestAnimationFrame(tick);
}

function fullRefresh(keepView) {
  computeAlignment(); computeGaps(); renderList();
  if (!keepView || layers.size !== state.acts.length) rebuildLayers();
  else for (const a of state.acts) {
    const l = layers.get(a.id);
    for (const layer of [l.line, l.tail, l.marker]) a.visible ? layer.addTo(map) : layer.remove();
  }
  render();
}

// ---------- files ----------
async function addFiles(files) {
  const errors = [];
  $('#status').textContent = `讀取中…（${files.length} 個檔案）`;
  for (const f of files) {
    try { state.acts.push(buildActivity(await parseActivityFile(f))); }
    catch (err) { errors.push(`${f.name}：${err.message}`); }
  }
  $('#status').textContent = errors.join('\n');
  if (state.refId == null && state.acts.length) state.refId = state.acts[0].id;
  state.T = 0;
  fullRefresh(false);
  if (state.mode !== 'point') state.T = state.Tmin;
  render();
}

function init() {
  initMap();
  const speedSel = $('#speed');
  speedSel.innerHTML = SPEEDS.map(s => `<option value="${s}" ${s === state.speed ? 'selected' : ''}>${s}×</option>`).join('');
  speedSel.addEventListener('change', () => { state.speed = Number(speedSel.value); });
  $('#fileInput').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
  const drop = $('#drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
  $('#mode').addEventListener('change', e => { state.mode = e.target.value; fullRefresh(true); state.T = state.mode === 'point' ? 0 : state.Tmin; render(); });
  $('#refSelect').addEventListener('change', e => { state.refId = Number(e.target.value); fullRefresh(true); });
  $('#resetAll').addEventListener('click', () => { state.acts.forEach(a => { a.adj = 0; }); fullRefresh(true); });
  $('#follow').addEventListener('change', e => { state.follow = e.target.checked; render(); });
  $('#fit').addEventListener('click', () => rebuildLayers());
  $('#play').addEventListener('click', togglePlay);
  $('#time').addEventListener('input', e => { state.T = Number(e.target.value); render(); });
  $('#acts').addEventListener('input', onListEvent);
  $('#acts').addEventListener('click', e => { if (e.target.matches('button')) onListEvent(e); });
  for (const c of [$('#gapChart'), $('#eleChart')]) c.addEventListener('click', e => seekFromChart(e, c));
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !e.target.matches('input, select, button')) { e.preventDefault(); togglePlay(); }
  });
  window.addEventListener('resize', () => { canvasSize.clear(); render(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { theme = null; chartVersion++; render(); });
  renderList(); render();
}

init();

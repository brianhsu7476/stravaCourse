// Activity file parsers: GPX, TCX, FIT (optionally .gz compressed).
// Every parser returns { name, points: [{ time (ms epoch), lat, lon, ele, dist (m or null) }] }.

const FIT_EPOCH_MS = 631065600 * 1000; // 1989-12-31T00:00:00Z
const SEMI_TO_DEG = 180 / 2 ** 31;

async function parseActivityFile(file) {
  let name = file.name;
  let buf = await file.arrayBuffer();
  if (/\.gz$/i.test(name)) {
    if (typeof DecompressionStream === 'undefined') throw new Error('此瀏覽器不支援 .gz 解壓縮，請先解壓縮');
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    buf = await new Response(stream).arrayBuffer();
    name = name.replace(/\.gz$/i, '');
  }
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  let points;
  if (ext === 'fit') points = parseFit(buf);
  else {
    const text = new TextDecoder('utf-8').decode(buf);
    if (ext === 'tcx' || /<TrainingCenterDatabase/i.test(text)) points = parseTcx(text);
    else points = parseGpx(text);
  }
  points = cleanPoints(points);
  if (points.length < 2) throw new Error('找不到含有時間與座標的紀錄點');
  return { name: name.replace(/\.[^.]+$/, ''), points };
}

function cleanPoints(points) {
  points = points.filter(p => Number.isFinite(p.time) && Number.isFinite(p.lat) && Number.isFinite(p.lon)
    && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && !(p.lat === 0 && p.lon === 0));
  points.sort((a, b) => a.time - b.time);
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && p.time <= last.time) continue;
    out.push(p);
  }
  return out;
}

function childText(el, localName) {
  for (const c of el.children) if (c.localName === localName) return c.textContent.trim();
  return null;
}

function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('GPX 格式錯誤');
  let nodes = doc.getElementsByTagNameNS('*', 'trkpt');
  if (!nodes.length) nodes = doc.getElementsByTagNameNS('*', 'rtept');
  const pts = [];
  for (const n of nodes) {
    const time = childText(n, 'time');
    const ele = childText(n, 'ele');
    pts.push({
      time: time ? Date.parse(time) : NaN,
      lat: parseFloat(n.getAttribute('lat')),
      lon: parseFloat(n.getAttribute('lon')),
      ele: ele !== null ? parseFloat(ele) : null,
      dist: null,
    });
  }
  return pts;
}

function parseTcx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('TCX 格式錯誤');
  const pts = [];
  for (const tp of doc.getElementsByTagNameNS('*', 'Trackpoint')) {
    const pos = [...tp.children].find(c => c.localName === 'Position');
    if (!pos) continue;
    const ele = childText(tp, 'AltitudeMeters');
    const dist = childText(tp, 'DistanceMeters');
    pts.push({
      time: Date.parse(childText(tp, 'Time')),
      lat: parseFloat(childText(pos, 'LatitudeDegrees')),
      lon: parseFloat(childText(pos, 'LongitudeDegrees')),
      ele: ele !== null ? parseFloat(ele) : null,
      dist: dist !== null ? parseFloat(dist) : null,
    });
  }
  return pts;
}

// Minimal FIT decoder: reads "record" messages (global number 20).
function parseFit(buf) {
  const dv = new DataView(buf);
  const pts = [];
  let pos = 0;
  while (pos + 12 <= buf.byteLength) {
    const headerSize = dv.getUint8(pos);
    const dataSize = dv.getUint32(pos + 4, true);
    const sig = String.fromCharCode(dv.getUint8(pos + 8), dv.getUint8(pos + 9), dv.getUint8(pos + 10), dv.getUint8(pos + 11));
    if (sig !== '.FIT') {
      if (pts.length) break;
      throw new Error('不是有效的 FIT 檔');
    }
    const end = Math.min(pos + headerSize + dataSize, buf.byteLength);
    decodeFitRecords(dv, pos + headerSize, end, pts);
    pos = end + 2; // skip CRC; chained FIT files follow
  }
  return pts;
}

const FIT_TYPES = { // base type number (low 5 bits) -> [size, reader, invalid]
  0: [1, 'u8', 0xFF], 1: [1, 's8', 0x7F], 2: [1, 'u8', 0xFF], 3: [2, 's16', 0x7FFF], 4: [2, 'u16', 0xFFFF],
  5: [4, 's32', 0x7FFFFFFF], 6: [4, 'u32', 0xFFFFFFFF], 8: [4, 'f32', null], 9: [8, 'f64', null],
  10: [1, 'u8', 0], 11: [2, 'u16', 0], 12: [4, 'u32', 0], 13: [1, 'u8', 0xFF],
};

function readFitValue(dv, off, size, baseType, little) {
  const t = FIT_TYPES[baseType & 0x1F];
  if (!t || t[0] !== size) return null;
  let v;
  switch (t[1]) {
    case 'u8': v = dv.getUint8(off); break;
    case 's8': v = dv.getInt8(off); break;
    case 'u16': v = dv.getUint16(off, little); break;
    case 's16': v = dv.getInt16(off, little); break;
    case 'u32': v = dv.getUint32(off, little); break;
    case 's32': v = dv.getInt32(off, little); break;
    case 'f32': v = dv.getFloat32(off, little); return Number.isFinite(v) ? v : null;
    case 'f64': v = dv.getFloat64(off, little); return Number.isFinite(v) ? v : null;
  }
  return v === t[2] ? null : v;
}

function decodeFitRecords(dv, pos, end, pts) {
  const defs = {};
  let lastTs = 0;
  while (pos < end) {
    const h = dv.getUint8(pos++);
    let local, compressedTs = null;
    if (h & 0x80) {
      local = (h >> 5) & 0x03;
      const offset = h & 0x1F;
      let ts = (lastTs & ~0x1F) + offset;
      if (offset < (lastTs & 0x1F)) ts += 0x20;
      compressedTs = ts;
      lastTs = ts;
    } else if (h & 0x40) {
      local = h & 0x0F;
      const little = dv.getUint8(pos + 1) === 0;
      const global = dv.getUint16(pos + 2, little);
      const n = dv.getUint8(pos + 4);
      pos += 5;
      const fields = [];
      for (let i = 0; i < n; i++, pos += 3) fields.push([dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2)]);
      let devSize = 0;
      if (h & 0x20) {
        const nd = dv.getUint8(pos++);
        for (let i = 0; i < nd; i++, pos += 3) devSize += dv.getUint8(pos + 1);
      }
      defs[local] = { little, global, fields, devSize };
      continue;
    } else {
      local = h & 0x0F;
    }
    const def = defs[local];
    if (!def) throw new Error('FIT 檔損毀（缺少定義訊息）');
    const vals = {};
    for (const [num, size, bt] of def.fields) {
      vals[num] = readFitValue(dv, pos, size, bt, def.little);
      pos += size;
    }
    pos += def.devSize;
    if (vals[253] != null) lastTs = vals[253];
    if (def.global !== 20) continue;
    const ts = vals[253] ?? compressedTs;
    if (ts == null || vals[0] == null || vals[1] == null) continue;
    const alt = vals[78] != null ? vals[78] / 5 - 500 : vals[2] != null ? vals[2] / 5 - 500 : null;
    pts.push({
      time: FIT_EPOCH_MS + ts * 1000,
      lat: vals[0] * SEMI_TO_DEG,
      lon: vals[1] * SEMI_TO_DEG,
      ele: alt,
      dist: vals[5] != null ? vals[5] / 100 : null,
    });
  }
}

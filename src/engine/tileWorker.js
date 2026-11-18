// Builds everything for one map tile off the main thread:
//   ground texture painted from OpenFreeMap vector tiles (+ an aux texture: road lights, water, shading)
//   terrain mesh, 3D buildings from Overture, metro viaducts, roads for traffic, and place labels.
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { PMTiles } from 'pmtiles';
import earcut from 'earcut';
import { lonLatToLocal } from './geo.js';
import { TOWERS } from './towers.js';

const R = 6378137, WORLD = 2 * Math.PI * R;
let ofmTemplate = null, overture = null, frame = null, satTemplate = null;

// ------------------------------------------------------------------ sources
async function fetchOFM(z, x, y) {
  if (!ofmTemplate) return null;
  const r = await fetch(ofmTemplate.replace('{z}', z).replace('{x}', x).replace('{y}', y));
  if (r.status === 204 || r.status === 404) return null;
  if (!r.ok) throw new Error(`OpenFreeMap ${r.status}`);
  return new VectorTile(new Pbf(new Uint8Array(await r.arrayBuffer())));
}
async function fetchOverture(z, x, y) {
  if (!overture) return null;
  const t = await overture.getZxy(z, x, y);
  return t ? new VectorTile(new Pbf(new Uint8Array(t.data))) : null;
}

// Sentinel-2 cloudless imagery (EOX): a 2x2 block of tiles one zoom deeper than the map tile
async function fetchSat(z, x, y) {
  if (!satTemplate) return null;
  const sz = Math.min(z + 1, 15), n = 2 ** (sz - z);
  const cv = new OffscreenCanvas(256 * n, 256 * n), g = cv.getContext('2d');
  const jobs = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const tx = x * n + i, ty = y * n + j;
    jobs.push(fetch(satTemplate.replace('{z}', sz).replace('{x}', tx).replace('{y}', ty))
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then((b) => createImageBitmap(b))
      .then((bm) => { g.drawImage(bm, i * 256, j * 256); bm.close(); }));
  }
  const res = await Promise.allSettled(jobs);
  return res.every((r) => r.status === 'rejected') ? null : cv;
}

// ------------------------------------------------------------------ geometry helpers
function bounds(z, x, y) {
  const T = WORLD / 2 ** z;
  const left = -WORLD / 2 + x * T, top = WORLD / 2 - y * T;
  const x0 = (left - frame.mx0) * frame.k, y1 = (top - frame.my0) * frame.k, size = T * frame.k;
  return { x0, y1, size };
}

// terrain grid: 258x258 padded zoom-12 heights for the tile's zoom-12 ancestor
let G = null, GX = 0, GY = 0;
function height(x, y) {
  const T = WORLD / 4096;   // 2^12
  const mx = x / frame.k + frame.mx0, my = y / frame.k + frame.my0;
  let gx = ((mx + WORLD / 2) / T) * 256 - 0.5 - GX * 256 + 1;
  let gy = ((WORLD / 2 - my) / T) * 256 - 0.5 - GY * 256 + 1;
  gx = Math.min(Math.max(gx, 0), 256.999); gy = Math.min(Math.max(gy, 0), 256.999);
  const ix = gx | 0, iy = gy | 0, fx = gx - ix, fy = gy - iy, i = iy * 258 + ix;
  return (G[i] * (1 - fx) + G[i + 1] * fx) * (1 - fy) + (G[i + 258] * (1 - fx) + G[i + 259] * fx) * fy;
}

// Height of the terrain mesh exactly as drawn (linear over its triangles), so roads, cars and
// trees sit on the visible ground rather than on the smoother underlying elevation model.
let MESH = null;   // { b, seg }
function meshHeight(x, y) {
  if (!MESH) return height(x, y);
  const { b, seg } = MESH, step = b.size / seg;
  let fx = (x - b.x0) / step, fy = (b.y1 - y) / step;
  fx = Math.min(Math.max(fx, 0), seg - 1e-6); fy = Math.min(Math.max(fy, 0), seg - 1e-6);
  const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
  const X = (ii) => b.x0 + ii * step, Y = (jj) => b.y1 - jj * step;
  const nw = height(X(i), Y(j)), ne = height(X(i + 1), Y(j)), sw = height(X(i), Y(j + 1)), se = height(X(i + 1), Y(j + 1));
  return u + v <= 1 ? nw + u * (ne - nw) + v * (sw - nw) : se + (1 - u) * (sw - se) + (1 - v) * (ne - se);
}

function terrainMesh(b, seg) {
  const n = seg + 1, skirt = seg * 4 * 2;
  const pos = new Float32Array((n * n + skirt) * 3), nor = new Float32Array((n * n + skirt) * 3), uv = new Float32Array((n * n + skirt) * 2);
  const idx = [];
  const step = b.size / seg, e = step * 0.5;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = b.x0 + i * step, y = b.y1 - j * step, v = j * n + i;
      const h = height(x, y);
      pos.set([x, h, -y], v * 3);
      const dx = height(x + e, y) - height(x - e, y), dy = height(x, y + e) - height(x, y - e);
      const nx = -dx / (2 * e), nz = dy / (2 * e), l = Math.hypot(nx, 1, nz);
      nor.set([nx / l, 1 / l, nz / l], v * 3);
      uv.set([i / seg, j / seg], v * 2);
      if (i < seg && j < seg) idx.push(v, v + n, v + 1, v + 1, v + n, v + n + 1);
    }
  }
  // skirts hide cracks between tiles of different detail
  let v = n * n;
  const edges = [[...Array(n).keys()].map((i) => i), [...Array(n).keys()].map((i) => i * n + seg),
    [...Array(n).keys()].map((i) => seg * n + seg - i), [...Array(n).keys()].map((i) => (seg - i) * n)];
  for (const edge of edges) {
    for (let k = 0; k < seg; k++) {
      const a = edge[k], c = edge[k + 1];
      for (const src of [a, c]) {
        pos.set([pos[src * 3], pos[src * 3 + 1] - 25, pos[src * 3 + 2]], v * 3);
        nor.set(nor.subarray(src * 3, src * 3 + 3), v * 3); uv.set(uv.subarray(src * 2, src * 2 + 2), v * 2); v++;
      }
      const s0 = v - 2, s1 = v - 1;
      idx.push(a, s0, c, c, s0, s1, a, c, s0, c, s1, s0);     // both windings: never seen from behind
    }
  }
  return { pos, nor, uv, idx: new Uint32Array(idx) };
}

// ------------------------------------------------------------------ painting the ground
const LANDUSE = { residential: '#d2c5ae', commercial: '#d6c3b3', retail: '#d6c3b3', industrial: '#c7bfb3', railway: '#bcb2a2',
  cemetery: '#b6bf9c', hospital: '#d9cdb9', school: '#d6cbb4', university: '#d6cbb4', college: '#d6cbb4', military: '#c0b7a3',
  stadium: '#a7b886', pitch: '#9db57a', playground: '#a9bb87', garages: '#c4bcae', quarry: '#c9bca3', theme_park: '#b5bf91', zoo: '#a8b886' };
const LANDCOVER = { wood: '#6f8a55', forest: '#6f8a55', grass: '#9cb172', farmland: '#b9b27f', scrub: '#a6a575',
  wetland: '#86a48b', sand: '#dfd1a6', rock: '#b4a895', ice: '#ffffff' };
const ROAD = { motorway: [18, '#55524e', 1], trunk: [15, '#57544f', 1], primary: [13, '#5b5853', 1], secondary: [11, '#615e59', 0.85],
  tertiary: [9, '#67645f', 0.7], minor: [6, '#77736c', 0.45], service: [4, '#7d7870', 0.3], track: [3, '#9d917d', 0.1],
  path: [1.5, '#a89c88', 0], rail: [4, '#4a423b', 0], raceway: [8, '#615e59', 0.2], busway: [8, '#615e59', 0.5] };
const WATERWAY = { river: 16, canal: 8, stream: 3, drain: 2.5, ditch: 2 };

let noise = null;
function noisePattern(ctx) {
  if (!noise) {
    const c = new OffscreenCanvas(256, 256), g = c.getContext('2d'), d = g.createImageData(256, 256);
    for (let i = 0; i < d.data.length; i += 4) {
      const v = Math.random() * 255;
      d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 22;
    }
    g.putImageData(d, 0, 0); noise = c;
  }
  return ctx.createPattern(noise, 'repeat');
}

function pathOf(feature, s) {
  const p = new Path2D();
  for (const ring of feature.loadGeometry()) {
    ring.forEach((pt, i) => (i ? p.lineTo(pt.x * s, pt.y * s) : p.moveTo(pt.x * s, pt.y * s)));
    if (feature.type === 3) p.closePath();
  }
  return p;
}

function paint(ofm, buildingsVT, S, mpp, sat, b, trees) {
  // willReadFrequently keeps these canvases on the CPU: painting thousands of footprints on the graphics card from every
  // worker competes with drawing the screen and shows up as stalls whenever tiles arrive
  const color = new OffscreenCanvas(S, S), c = color.getContext('2d', { willReadFrequently: true });
  const aux = new OffscreenCanvas(S, S), a = aux.getContext('2d', { willReadFrequently: true });
  a.fillStyle = '#000'; a.fillRect(0, 0, S, S); a.globalCompositeOperation = 'lighter';
  const px = (m) => Math.max(0.8, m / mpp);
  if (sat) {
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    c.drawImage(sat, 0, 0, S, S);
    if (ofm) satOverlays(ofm, c, a, S, px);
  } else {
    c.fillStyle = '#c8b699'; c.fillRect(0, 0, S, S);              // Deccan earth (map-style fallback)
  }
  if (!sat && ofm) {
    const L = ofm.layers, ext = (l) => S / l.extent;
    const each = (name, fn) => { const l = L[name]; if (!l) return; const s = ext(l); for (let i = 0; i < l.length; i++) fn(l.feature(i), s); };
    each('landcover', (f, s) => { const col = LANDCOVER[f.properties.class]; if (col && f.type === 3) { c.fillStyle = col; c.fill(pathOf(f, s)); } });
    each('landuse', (f, s) => { const col = LANDUSE[f.properties.class]; if (col && f.type === 3) { c.globalAlpha = 0.85; c.fillStyle = col; c.fill(pathOf(f, s)); c.globalAlpha = 1; } });
    each('park', (f, s) => { if (f.type === 3) { c.globalAlpha = 0.8; c.fillStyle = '#8eab69'; c.fill(pathOf(f, s)); c.globalAlpha = 1; } });
    c.fillStyle = noisePattern(c); c.fillRect(0, 0, S, S);
    each('water', (f, s) => {
      if (f.type !== 3) return;
      const p = pathOf(f, s);
      c.fillStyle = f.properties.class === 'swimming_pool' ? '#4fa3b5' : '#2d525c'; c.fill(p);
      a.fillStyle = '#00ff00'; a.fill(p);
    });
    each('waterway', (f, s) => {
      const w = WATERWAY[f.properties.class]; if (!w || f.properties.brunnel === 'tunnel') return;
      const p = pathOf(f, s);
      c.strokeStyle = '#2d525c'; c.lineWidth = px(w); c.lineCap = 'round'; c.stroke(p);
      a.strokeStyle = '#00ff00'; a.lineWidth = px(w); a.stroke(p);
    });
    // roads: casing then fill, minor first
    const order = ['path', 'track', 'service', 'minor', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway', 'rail'];
    const roads = L.transportation;
    if (roads) {
      const s = ext(roads), byClass = {};
      for (let i = 0; i < roads.length; i++) {
        const f = roads.feature(i), cl = f.properties.class;
        if (!ROAD[cl] || f.properties.brunnel === 'tunnel' || f.type !== 2 || (curZ >= 14 && f.properties.brunnel === 'bridge' && RIB[cl])) continue;
        (byClass[cl] ||= []).push(f);
      }
      c.lineCap = a.lineCap = 'round'; c.lineJoin = a.lineJoin = 'round';
      for (const cl of order) {
        const fs = byClass[cl]; if (!fs) continue;
        const [w, col, glow] = ROAD[cl];
        const p = new Path2D(); for (const f of fs) p.addPath(pathOf(f, s));
        if (w >= 6) { c.strokeStyle = 'rgba(170,160,145,0.9)'; c.lineWidth = px(w) + Math.max(1, px(2)); c.stroke(p); }
        c.strokeStyle = col; c.lineWidth = px(w); c.stroke(p);
        if (cl === 'rail') { c.setLineDash([px(3), px(3)]); c.strokeStyle = '#8c8070'; c.lineWidth = px(1.2); c.stroke(p); c.setLineDash([]); }
        if (glow > 0) { a.strokeStyle = `rgb(${Math.round(255 * glow)},0,0)`; a.lineWidth = px(w); a.stroke(p); }
      }
    }
  }
  // footprints: darker ground under buildings, soft shading in aux blue channel
  if (buildingsVT && buildingsVT.layers.building) {
    const l = buildingsVT.layers.building, s = S / l.extent;
    const all = new Path2D();
    for (let i = 0; i < l.length; i++) { const f = l.feature(i); if (f.type === 3) all.addPath(pathOf(f, s)); }
    c.fillStyle = sat ? 'rgba(120,116,110,0.3)' : 'rgba(95,86,76,0.55)'; c.fill(all);
    // soft contact shadow around buildings: layered strokes instead of a blur filter (much cheaper to paint)
    a.lineJoin = 'round';
    a.strokeStyle = 'rgb(0,0,45)'; a.lineWidth = Math.max(3, px(18)); a.stroke(all);
    a.strokeStyle = 'rgb(0,0,70)'; a.lineWidth = Math.max(2, px(10)); a.stroke(all);
    a.strokeStyle = 'rgb(0,0,110)'; a.lineWidth = Math.max(1.5, px(4.5)); a.stroke(all);
    a.fillStyle = 'rgb(0,0,255)'; a.fill(all);
  }
  if (trees && b) {                                  // soft occlusion under every tree crown
    for (let i = 0; i < trees.length; i += 5) {
      const cx = (trees[i] - b.x0) / b.size * S, cy = (b.y1 + trees[i + 2]) / b.size * S, r = Math.max(2, px(3.4 * trees[i + 3]));
      const gr = a.createRadialGradient(cx, cy, 0, cx, cy, r);
      gr.addColorStop(0, 'rgba(0,0,170,0.9)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      a.fillStyle = gr; a.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
  }
  const half = new OffscreenCanvas(Math.max(64, S >> 1), Math.max(64, S >> 1));   // masks are soft: half resolution is plenty
  half.getContext('2d').drawImage(aux, 0, 0, half.width, half.height);
  return { color: color.transferToImageBitmap(), aux: half.transferToImageBitmap() };
}

// On top of satellite imagery: sharpen what 10 m pixels blur (lake edges, roads), keep the photo.
function satOverlays(ofm, c, a, S, px) {
  const L = ofm.layers;
  const each = (name, fn) => { const l = L[name]; if (!l) return; const s = S / l.extent; for (let i = 0; i < l.length; i++) fn(l.feature(i), s); };
  each('water', (f, s) => {
    if (f.type !== 3) return;
    const p = pathOf(f, s);
    c.fillStyle = 'rgba(28,66,74,0.55)'; c.fill(p);
    a.fillStyle = '#00ff00'; a.fill(p);
  });
  each('waterway', (f, s) => {
    const w = WATERWAY[f.properties.class]; if (!w || f.properties.brunnel === 'tunnel') return;
    const p = pathOf(f, s);
    c.strokeStyle = 'rgba(28,66,74,0.5)'; c.lineWidth = px(w); c.lineCap = 'round'; c.stroke(p);
    a.strokeStyle = '#00ff00'; a.lineWidth = px(w); a.stroke(p);
  });
  const roads = L.transportation; if (!roads) return;
  const s = S / roads.extent, byClass = {};
  for (let i = 0; i < roads.length; i++) {
    const f = roads.feature(i), cl = f.properties.class;
    if (!ROAD[cl] || cl === 'path' || cl === 'track' || f.properties.brunnel === 'tunnel' || f.type !== 2 || (curZ >= 14 && f.properties.brunnel === 'bridge' && RIB[cl])) continue;
    (byClass[cl] ||= []).push(f);
  }
  const ALPHA = { motorway: 0.8, trunk: 0.78, primary: 0.72, secondary: 0.62, tertiary: 0.52, minor: 0.34, service: 0.22, rail: 0.45, raceway: 0.4, busway: 0.6 };
  c.lineCap = a.lineCap = 'round'; c.lineJoin = a.lineJoin = 'round';
  for (const cl of ['service', 'minor', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway', 'rail']) {
    const fs = byClass[cl]; if (!fs) continue;
    const [w, , glow] = ROAD[cl];
    const p = new Path2D(); for (const f of fs) p.addPath(pathOf(f, s));
    c.strokeStyle = cl === 'rail' ? `rgba(60,52,46,${ALPHA[cl]})` : `rgba(78,76,72,${ALPHA[cl]})`;
    c.lineWidth = px(w * 0.85); c.stroke(p);
    if (glow > 0) { a.strokeStyle = `rgb(${Math.round(255 * glow)},0,0)`; a.lineWidth = px(w); a.stroke(p); }
  }
}

// Trees where the satellite image is green and nothing is built: one canopy per ~9 m cell at most.
function plantTrees(sat, ofm, bvt, b, max) {
  const G = 256, cs = b.size / G, MG = 1024;       // trees are found on a 256 grid but kept off roads/buildings using a 1024 mask
  const sv = new OffscreenCanvas(G, G), sg = sv.getContext('2d', { willReadFrequently: true });
  sg.drawImage(sat, 0, 0, G, G);
  const img = sg.getImageData(0, 0, G, G).data;
  const mk = new OffscreenCanvas(MG, MG), mg = mk.getContext('2d', { willReadFrequently: true });
  mg.fillStyle = '#fff'; mg.strokeStyle = '#fff'; mg.lineCap = 'round';
  const fillLayer = (vt, name, cond) => {
    const l = vt && vt.layers[name]; if (!l) return; const s = MG / l.extent, mpp = b.size / MG;
    for (let i = 0; i < l.length; i++) { const f = l.feature(i); const w = cond(f); if (w) { if (f.type === 3) mg.fill(pathOf(f, s)); else if (f.type === 2) { mg.lineWidth = (typeof w === 'number' ? w : 8) / mpp; mg.stroke(pathOf(f, s)); } } }
  };
  fillLayer(ofm, 'water', (f) => f.type === 3);
  fillLayer(ofm, 'transportation', (f) => (f.properties.brunnel === 'tunnel' ? 0 : RIB[f.properties.class] ? RIB[f.properties.class][1] + 2.5 : f.properties.class === 'rail' ? 8 : 0));
  fillLayer(bvt, 'building', (f) => f.type === 3);
  const mask = mg.getImageData(0, 0, MG, MG).data;
  const out = [];
  let seed = (b.x0 * 7 + b.y1 * 13) | 0;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296; };
  for (let j = 0; j < G && out.length < max * 5; j++) {
    for (let i = 0; i < G; i++) {
      const k = (j * G + i) * 4;
      const r = img[k], g = img[k + 1], bl = img[k + 2];
      const veg = g - (r + bl) / 2;
      if (veg < 2 || g < 25 || g > 170) continue;
      const p = Math.min(1, (veg - 2) / 14) * 0.75;
      if (rnd() > p) continue;
      const x = b.x0 + (i + rnd()) * cs, y = b.y1 - (j + rnd()) * cs;
      if (nearCharminar(x, y) || inSecLawn(x, y)) continue;                  // hand-built landmark sites keep their own surroundings
      if (mask[(Math.min(MG - 1, Math.floor((b.y1 - y) / b.size * MG)) * MG + Math.min(MG - 1, Math.floor((x - b.x0) / b.size * MG))) * 4] > 40) continue;
      out.push(x, meshHeight(x, y) - 0.3, -y, 1.0 + rnd() * rnd() * 1.1 + rnd() * 0.3, rnd());          // mostly mid-sized, a few big old shade trees
      if (out.length >= max * 5) break;
    }
  }
  return new Float32Array(out);
}

// ------------------------------------------------------------------ buildings
const CLASS = { residential: 1, house: 1, apartments: 1, detached: 1, commercial: 2, retail: 2, office: 2, industrial: 3, warehouse: 3,
  education: 4, school: 4, university: 4, medical: 4, hospital: 4, civic: 4, government: 4, religious: 5, mosque: 5, temple: 5,
  church: 5, transportation: 6, train_station: 6, entertainment: 2, military: 4, agricultural: 3, outbuilding: 1, service: 3 };
// Hyderabad facades: whitewash, cream, beige, pastel paint, concrete grey; offices lean to blue-grey glass
// Earthy, weathered paints (white, cream, sand, grey concrete, terracotta, brick); glass towers lean to teal, smoke and bronze
const FACADES = [[232, 228, 218], [232, 228, 218], [222, 214, 196], [214, 202, 178], [200, 190, 172], [186, 182, 174], [172, 172, 170], [172, 172, 170],
  [238, 234, 226], [196, 150, 120], [168, 118, 96], [206, 178, 126], [150, 152, 140], [128, 130, 134], [226, 220, 204], [190, 176, 150]];
const GLASS = [[62, 104, 148], [48, 84, 132], [78, 122, 158], [40, 70, 112], [86, 128, 160], [56, 96, 140], [70, 110, 150], [92, 100, 108]];   // HITEC City: blue reflective curtain wall
// Flat RCC terraces: weathered concrete greys, red-oxide and terracotta waterproofing, a little green and blue paint or tarpaulin
const ROOFS = [[96, 92, 86], [104, 100, 94], [84, 84, 84], [116, 110, 102], [90, 86, 82], [100, 76, 64], [90, 68, 58], [84, 64, 54],
  [112, 106, 96], [78, 82, 78], [80, 90, 84], [82, 90, 104], [118, 112, 104], [94, 90, 85], [100, 96, 90], [88, 88, 86]];

function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }

function estimate(area, p, j) {
  const h = +p.height, fl = +p.num_floors;
  if (h >= 2 && h <= 450) return [h, true];
  if (fl >= 1 && fl <= 120) return [fl * 3.3 + 1, true];
  const rh = +p.render_height;                          // OpenFreeMap fallback layer
  if (rh >= 3 && rh <= 450) return [rh, true];
  // No data: a size-based guess. Small plots are G+1/G+2 houses, mid-size G+3..G+5 blocks,
  // large footprints are apartment towers with a long tail of tall ones.
  let e;
  if (area < 40) e = 3.5 + 3 * j;
  else if (area < 100) e = 6 + 5 * j;
  else if (area < 250) e = 9 + 7 * j;
  else if (area < 700) e = 12 + 10 * j + 14 * j ** 4;
  else if (area < 2500) e = 15 + 12 * j + 40 * j ** 3;
  else e = 10 + 22 * j;
  return [e, false];
}

// Heights the user typed in (edit mode), as local metres: x, y, height ... The building under each point gets that height.
let curFixes = [];
function applyFixes(list, b) {
  for (let k = 0; k + 2 < curFixes.length; k += 3) {
    const fx = curFixes[k], fy = curFixes[k + 1], fh = curFixes[k + 2];
    if (fx < b.x0 || fx >= b.x0 + b.size || fy > b.y1 || fy <= b.y1 - b.size) continue;
    let best = null, bd = 8;
    for (const it of list) {                                   // the footprint that contains the point, else the nearest centre within 8 m
      const P = it.pts, n = P.length / 2; let inside = false, mx = 0, my = 0;
      for (let q = 0, w = n - 1; q < n; w = q++) {
        const xi = P[q * 2], yi = P[q * 2 + 1], xj = P[w * 2], yj = P[w * 2 + 1];
        if ((yi > fy) !== (yj > fy) && fx < ((xj - xi) * (fy - yi)) / (yj - yi) + xi) inside = !inside;
        mx += xi; my += yi;
      }
      if (inside) { best = it; break; }
      const d = Math.hypot(mx / n - fx, my / n - fy);
      if (d < bd) { bd = d; best = it; }
    }
    if (best) { best.h = fh; best.cls |= 0x80; }
  }
}

// Hand edits (edits.js): buildings to leave out, given as points inside them, and roads to add, given as local-metre lines.
let curHide = [], curRoads = [], curTanks = [], tankSpecs = [];
function hideBuildings(list) {
  for (let k = 0; k + 1 < curHide.length; k += 2) {
    const fx = curHide[k], fy = curHide[k + 1];
    let at = -1, bd = 3;
    for (let i = 0; i < list.length; i++) {                     // the footprint that contains the point, else the nearest centre within 3 m
      const P = list[i].pts, n = P.length / 2; let inside = false, mx = 0, my = 0;
      for (let q = 0, w = n - 1; q < n; w = q++) {
        const xi = P[q * 2], yi = P[q * 2 + 1], xj = P[w * 2], yj = P[w * 2 + 1];
        if ((yi > fy) !== (yj > fy) && fx < ((xj - xi) * (fy - yi)) / (yj - yi) + xi) inside = !inside;
        mx += xi; my += yi;
      }
      if (inside) { at = i; break; }
      const d = Math.hypot(mx / n - fx, my / n - fy);
      if (d < bd) { bd = d; at = i; }
    }
    if (at >= 0) list.splice(at, 1);
  }
  // water tanks: the footprint is replaced by a round tank (built later by waterTanks)
  for (let k = 0; k + 1 < curTanks.length; k += 2) {
    const fx = curTanks[k], fy = curTanks[k + 1];
    let at = -1, bd = 3;
    for (let i = 0; i < list.length; i++) {
      const P = list[i].pts, n = P.length / 2; let inside = false, mx = 0, my = 0;
      for (let q = 0, w = n - 1; q < n; w = q++) {
        const xi = P[q * 2], yi = P[q * 2 + 1], xj = P[w * 2], yj = P[w * 2 + 1];
        if ((yi > fy) !== (yj > fy) && fx < ((xj - xi) * (fy - yi)) / (yj - yi) + xi) inside = !inside;
        mx += xi; my += yi;
      }
      if (inside) { at = i; break; }
      const d = Math.hypot(mx / n - fx, my / n - fy);
      if (d < bd) { bd = d; at = i; }
    }
    if (at < 0) continue;
    const it = list[at], P = it.pts, n = P.length / 2; let mx = 0, my = 0;
    for (let q = 0; q < n; q++) { mx += P[q * 2]; my += P[q * 2 + 1]; }
    tankSpecs.push({ x: mx / n, y: my / n, r: Math.min(14, Math.max(2.5, Math.sqrt(it.area / Math.PI))), h: Math.min(16, Math.max(5, it.h)) });
    list.splice(at, 1);
  }
}
// A round water tank: white-grey drum with two dark ribs, a shallow domed roof and a dark base ring.
function waterTanks() {
  if (!tankSpecs.length) return null;
  const parts = [], BODY = [0.82, 0.85, 0.88], RIB = [0.34, 0.37, 0.42], ROOF = [0.6, 0.64, 0.68], BASE = [0.3, 0.32, 0.35], N = 20;
  for (const t of tankSpecs) {
    const { band, cap, done } = geoKit(t.x, t.y, meshHeight(t.x, t.y) - 0.3), r = t.r, H = t.h;
    band(r * 1.06, 0, r * 1.06, 0.7, 0, 0, N, BASE); band(r * 1.06, 0.7, r, 0.8, 0, 0, N, BASE);
    band(r, 0.8, r, H, 0, 0, N, BODY);
    for (const f of [0.34, 0.68]) { band(r * 1.025, H * f, r * 1.025, H * f + 0.35, 0, 0, N, RIB); band(r * 1.025, H * f + 0.35, r, H * f + 0.4, 0, 0, N, RIB); }
    band(r, H, r * 1.04, H + 0.15, 0, 0, N, RIB); band(r * 1.04, H + 0.15, r * 0.55, H + r * 0.25, 0, 0, N, ROOF); cap(r * 0.55, H + r * 0.25, 0, 0, N, ROOF);
    parts.push(done());
  }
  return mergeGeo(parts);
}
// Added roads join the tile's road layer as extra features, so the ground paint, road ribbons, junctions and traffic all see them.
function addRoads(ofm, b) {
  const tr = ofm && ofm.layers && ofm.layers.transportation;
  if (!tr || !curRoads.length) return;
  const sc = b.size / tr.extent, extra = [];
  for (const r of curRoads) {
    const P = r.pts, c = P.length / 2;
    let mx = 0, my = 0; for (let i = 0; i < c; i++) { mx += P[i * 2]; my += P[i * 2 + 1]; }
    mx /= c; my /= c;
    if (mx < b.x0 || mx >= b.x0 + b.size || my > b.y1 || my <= b.y1 - b.size) continue;       // each road belongs to the tile that holds its middle
    const g = []; for (let i = 0; i < c; i++) g.push({ x: (P[i * 2] - b.x0) / sc, y: (b.y1 - P[i * 2 + 1]) / sc });
    extra.push({ properties: { class: r.cls }, type: 2, extent: tr.extent, loadGeometry: () => [g.map((p) => ({ x: p.x, y: p.y }))] });
  }
  if (!extra.length) return;
  const n0 = tr.length;
  ofm.layers.transportation = { name: tr.name, version: tr.version, extent: tr.extent, length: n0 + extra.length, feature: (i) => (i < n0 ? tr.feature(i) : extra[i - n0]) };
}

// Known towers in local metres (built on first use, once the frame is known).
let towerPts = null;
function knownTowers() {
  if (!towerPts) { towerPts = []; for (const [name, h, pts] of TOWERS) for (const [lat, lon] of pts) { const [x, y] = lonLatToLocal(frame, lon, lat); towerPts.push({ name, h, x, y }); } }
  return towerPts;
}
// Give each listed tower the best nearby large footprint (published coordinates are only good to ~30 m).
function applyKnownTowers(list, b) {
  const near = knownTowers().filter((t) => t.x > b.x0 - 60 && t.x < b.x0 + b.size + 60 && t.y > b.y1 - b.size - 60 && t.y < b.y1 + 60);
  if (!near.length) return;
  for (const it of list) { let sx = 0, sy = 0; const n = it.pts.length / 2; for (let k = 0; k < n; k++) { sx += it.pts[k * 2]; sy += it.pts[k * 2 + 1]; } it.cx = sx / n; it.cy = sy / n; }
  const taken = new Set();
  for (const t of near) {
    let best = null, bs = Infinity;
    for (const it of list) {
      if (taken.has(it) || it.area < 350) continue;
      const d = Math.hypot(it.cx - t.x, it.cy - t.y);
      if (d > 50) continue;
      const sc = d - Math.min(25, it.area * 0.01);
      if (sc < bs) { bs = sc; best = it; }
    }
    if (!best) continue;
    taken.add(best);
    if (!(best.cls & 0x80) || best.h < t.h * 0.7) { best.h = t.h; best.cls |= 0x80; }
    best.name = best.name || t.name;
  }
}

// Footprints that sit on a drawn road (data misalignment, or a mapped structure on a median) are dropped.
let roadTest = null;
function makeRoadTest(ofm, b) {
  const tr = ofm && ofm.layers.transportation; if (!tr) return null;
  const sc = b.size / tr.extent, CELL = 32, N = Math.ceil(b.size / CELL) + 2, grid = new Map(), segs = [];
  for (let i = 0; i < tr.length; i++) {
    const f = tr.feature(i), p = f.properties, def = RIB[p.class];
    if (!def || f.type !== 2 || p.brunnel === 'tunnel' || p.brunnel === 'bridge') continue;
    const hw = def[1] / 2 - 0.4;
    for (const g of f.loadGeometry()) for (let q = 1; q < g.length; q++) {
      const ax = b.x0 + g[q - 1].x * sc, ay = b.y1 - g[q - 1].y * sc, bx = b.x0 + g[q].x * sc, by = b.y1 - g[q].y * sc, id = segs.length;
      segs.push([ax, ay, bx, by, hw]);
      const x0 = Math.floor((Math.min(ax, bx) - hw - b.x0) / CELL), x1 = Math.floor((Math.max(ax, bx) + hw - b.x0) / CELL), y0 = Math.floor((b.y1 - Math.max(ay, by) - hw) / CELL), y1 = Math.floor((b.y1 - Math.min(ay, by) + hw) / CELL);
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) { const k = cy * N + cx; let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(id); }
    }
  }
  return (x, y) => {
    const a = grid.get(Math.floor((b.y1 - y) / CELL) * N + Math.floor((x - b.x0) / CELL)); if (!a) return false;
    for (const id of a) {
      const [ax, ay, bx, by, hw] = segs[id], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      if (Math.hypot(x - (ax + dx * t), y - (ay + dy * t)) < hw) return true;
    }
    return false;
  };
}

// Drop corners that barely bend the outline (within tol metres of the line between their neighbours).
function simplifyRing(P, tol) {
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let i = 0; i < P.length / 2 && P.length > 8; i++) {
      const n = P.length / 2, a = (i + n - 1) % n, c = (i + 1) % n;
      const ax = P[a * 2], ay = P[a * 2 + 1], bx = P[c * 2], by = P[c * 2 + 1], px = P[i * 2], py = P[i * 2 + 1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      if (Math.hypot(px - (ax + dx * t), py - (ay + dy * t)) < tol) { P.splice(i * 2, 2); i--; changed = true; }
    }
    if (!changed) break;
  }
}

function buildingsMesh(vt, b, layerName, z) {
  const l = vt && vt.layers[layerName];
  if (!l) return null;
  const sc = b.size / l.extent, list = [];
  const minArea = z >= 14 ? 16 : z === 13 ? 60 : 250;
  for (let i = 0; i < l.length; i++) {
    const f = l.feature(i);
    if (f.type !== 3) continue;
    const p = f.properties;
    if (p.is_underground === true || p.is_underground === 'true') continue;
    for (const poly of classifyRings(f.loadGeometry())) {
      const ring = poly[0];
      if (!ring || ring.length < 4) continue;
      // centroid rule: a building spanning two tiles is drawn once, by the tile holding its centre
      let cx = 0, cy = 0, area2 = 0;
      for (let k = 0; k < ring.length - 1; k++) {
        const c = ring[k].x * ring[k + 1].y - ring[k + 1].x * ring[k].y;
        area2 += c; cx += (ring[k].x + ring[k + 1].x) * c; cy += (ring[k].y + ring[k + 1].y) * c;
      }
      if (Math.abs(area2) < 1e-6) continue;
      cx /= 3 * area2; cy /= 3 * area2;
      if (cx < 0 || cy < 0 || cx >= l.extent || cy >= l.extent) continue;
      const area = Math.abs(area2) / 2 * sc * sc;
      if (area < minArea) continue;
      // to local metres, counter-clockwise with y north, dropping near-duplicate points
      const pts = [];
      for (let k = 0; k < ring.length - 1; k++) {
        const x = b.x0 + ring[k].x * sc, y = b.y1 - ring[k].y * sc;
        if (pts.length && Math.hypot(x - pts[pts.length - 2], y - pts[pts.length - 1]) < 0.4) continue;
        pts.push(x, y);
      }
      simplifyRing(pts, 0.35);                        // fewer corners = fewer triangles in dense districts
      if (pts.length < 6) continue;
      if (z >= 14 && area > 2500 && captureSecretariat(pts)) continue;                  // the Telangana Secretariat block: replaced by its hand-built model
      { let mx = 0, my = 0; const nn = pts.length / 2; for (let k = 0; k < nn; k++) { mx += pts[k * 2]; my += pts[k * 2 + 1]; } if (z >= 14 && (nearCharminar(mx / nn, my / nn) || (area > 350 && nearStation(mx / nn, my / nn)))) continue; }   // the hand-built Charminar replaces the plain block
      if (roadTest) {                                  // mostly on a road: not a real building
        let inside = 0, mx = 0, my = 0; const nn = pts.length / 2;
        for (let k = 0; k < nn; k++) { mx += pts[k * 2]; my += pts[k * 2 + 1]; if (roadTest(pts[k * 2], pts[k * 2 + 1])) inside++; }
        if (inside >= Math.ceil(nn * 0.6) && roadTest(mx / nn, my / nn)) continue;
      }
      let sa = 0; for (let k = 0; k < pts.length; k += 2) { const n = (k + 2) % pts.length; sa += pts[k] * pts[n + 1] - pts[n] * pts[k + 1]; }
      if (sa < 0) for (let a = 0, c = pts.length - 2; a < c; a += 2, c -= 2) { [pts[a], pts[c]] = [pts[c], pts[a]]; [pts[a + 1], pts[c + 1]] = [pts[c + 1], pts[a + 1]]; }
      const id = String(p.id || `${z}/${i}`), j = hashStr(id);
      const [h, mapped] = estimate(area, p, j);
      const cls = CLASS[p.class] || CLASS[p.subtype] || 0;
      list.push({ pts, h, area, cls: cls | (mapped ? 0x80 : 0), j, name: p['@name'] || p.name || '', gid: p.id ? String(p.id) : '' });
    }
  }
  if (!list.length) return null;
  if (z >= 13) { applyKnownTowers(list, b); applyFixes(list, b); hideBuildings(list); }

  const FLOOR = 3.2, BAY = 3.4;
  const FLAT_ROOFS = true;       // Hyderabad houses have flat RCC terraces: no hipped or pitched roofs on ordinary buildings (landmarks keep theirs)
  // Roofs and massing. Small rectangular houses get a hipped roof; large rectangular industrial buildings get a low
  // pitched roof in sheet-metal colours; tall compact buildings get a podium, a set-back tower and sometimes a crown.
  const rectangular = (P) => {
    for (let q = 0; q < 4; q++) {
      const a = (q + 3) % 4, c = (q + 1) % 4, ux = P[a * 2] - P[q * 2], uy = P[a * 2 + 1] - P[q * 2 + 1], wx = P[c * 2] - P[q * 2], wy = P[c * 2 + 1] - P[q * 2 + 1];
      if (Math.abs(ux * wx + uy * wy) / ((Math.hypot(ux, uy) * Math.hypot(wx, wy)) || 1) >= 0.3) return false;
    }
    return true;
  };
  for (const it of list) {
    const P = it.pts, cl = it.cls & 0x7f; it.hip = false; it.shed = false; it.nt = 1;
    if (P.length === 8 && it.area < 150 && it.h < 13 && cl <= 1 && (it.j * 131) % 1 <= 0.4) it.hip = !FLAT_ROOFS && rectangular(P);
    else if (P.length === 8 && cl === 3 && it.area >= 200 && it.area < 9000 && it.h < 18 && (it.j * 131) % 1 < 0.85) it.hip = it.shed = !FLAT_ROOFS && rectangular(P);
    else if (!it.hip && P.length <= 32 && it.h >= 40 && it.area >= 450 && (it.j * 57) % 1 < (it.h >= 110 ? 0.85 : 0.55)) {
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      for (let q = 0; q < P.length; q += 2) { minx = Math.min(minx, P[q]); maxx = Math.max(maxx, P[q]); miny = Math.min(miny, P[q + 1]); maxy = Math.max(maxy, P[q + 1]); }
      if ((maxx - minx) * (maxy - miny) / it.area < 1.9) it.nt = it.h >= 75 && (it.j * 311) % 1 < 0.6 ? 3 : 2;
    }
  }
  let nv = 0, ni = 0;
  for (const it of list) { const n = it.pts.length / 2; nv += n * 5 * it.nt + (it.hip ? 10 : 0); ni += (n * 6 + (n - 2) * 3) * it.nt + (it.hip ? 12 : 0); }
  const pos = new Float32Array(nv * 3), nor = new Int8Array(nv * 3), col = new Uint8Array(nv * 3), uv = new Float32Array(nv * 2), idx = new Uint32Array(ni);
  const bStart = new Uint32Array(list.length + 1), bH = new Float32Array(list.length), bCls = new Uint8Array(list.length), bBase = new Float32Array(list.length);
  const names = [], tanks = [], rooms = [], ids = [], cent = new Float32Array(list.length * 2);
  const detail = z >= 14;
  let v = 0, k = 0;
  list.forEach((it, bi) => {
    bStart[bi] = k;
    const P = it.pts, n = P.length / 2;
    { let a2 = 0, gx = 0, gy = 0;                     // footprint centre, for the building's location code
      for (let q = 0; q < n; q++) { const q2 = (q + 1) % n, c = P[q * 2] * P[q2 * 2 + 1] - P[q2 * 2] * P[q * 2 + 1]; a2 += c; gx += (P[q * 2] + P[q2 * 2]) * c; gy += (P[q * 2 + 1] + P[q2 * 2 + 1]) * c; }
      if (Math.abs(a2) > 1e-6) { cent[bi * 2] = gx / (3 * a2); cent[bi * 2 + 1] = gy / (3 * a2); } else { let mx = 0, my = 0; for (let q = 0; q < n; q++) { mx += P[q * 2]; my += P[q * 2 + 1]; } cent[bi * 2] = mx / n; cent[bi * 2 + 1] = my / n; }
      ids.push(it.gid || ''); }
    let gmin = Infinity, gsum = 0;
    // the walls start below the lowest of the smooth elevation and the ground as drawn (the mesh is coarser), so no building hovers over its ground
    for (let q = 0; q < n; q++) { const x = P[q * 2], y = P[q * 2 + 1], g = height(x, y); gmin = Math.min(gmin, g, meshHeight(x, y)); gsum += g; }
    { let mx = 0, my = 0; for (let q = 0; q < n; q++) { mx += P[q * 2]; my += P[q * 2 + 1]; } gmin = Math.min(gmin, meshHeight(mx / n, my / n)); }
    // whole floors plus a parapet, so windows line up with the roof
    const floors = Math.max(1, Math.round(it.h / FLOOR));
    const hh = floors * FLOOR + 0.9;
    const base = gmin - 1, top = gsum / n + hh, wallTop = top - base;
    bH[bi] = hh; bCls[bi] = it.cls; bBase[bi] = base; names.push(it.name);

    const j2 = (it.j * 9301 + 0.4973) % 1, j3 = (it.j * 49297 + 0.2311) % 1, j4 = (it.j * 7919 + 0.137) % 1;
    const cls = it.cls & 0x7f;
    const office = cls === 2 && hh > 20 && j3 > 0.3;
    const style = office ? (j2 < 0.62 ? 2 : 4) : hh < 9 ? (j2 < 0.45 ? 1 : j2 < 0.75 ? 3 : 5) : (j2 < 0.38 ? 0 : j2 < 0.62 ? 1 : j2 < 0.84 ? 5 : 3);
    const shop = cls === 2 || (hh < 20 && j4 < 0.45);        // shops on the ground floor
    const code = (style + (shop ? 0 : 6)) * 1000;
    const fc = FACADES[Math.floor(j2 * FACADES.length)], gc = GLASS[Math.floor(j3 * GLASS.length)];
    const shade = 0.9 + 0.12 * j3, mixg = office ? 1 : 0;
    const r = (fc[0] * (1 - mixg) + gc[0] * mixg) * shade, g = (fc[1] * (1 - mixg) + gc[1] * mixg) * shade, bl = (fc[2] * (1 - mixg) + gc[2] * mixg) * shade;
    const rc = ROOFS[Math.floor(((it.j * 7919) % 1) * ROOFS.length)], rs = 0.9 + 0.2 * j2;

    // one extruded ring: walls from y0 to y1 (facade coordinates continue up the building) and an optional flat roof
    const prism = (PP, y0, y1, fcode, cr, cg, cb, roof) => {
      const nn = PP.length / 2;
      for (let q = 0; q < nn; q++) {
        const ax = PP[q * 2], ay = PP[q * 2 + 1], bx = PP[((q + 1) % nn) * 2], by = PP[((q + 1) % nn) * 2 + 1];
        const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1, nx = Math.round((dy / len) * 127), nz = Math.round((dx / len) * 127);
        const bays = Math.max(1, Math.round(len / BAY));
        const quad = [ax, y0, -ay, bx, y0, -by, bx, y1, -by, ax, y1, -ay], qu = [0, bays, bays, 0];
        for (let c = 0; c < 4; c++) {
          pos.set(quad.slice(c * 3, c * 3 + 3), v * 3); nor[v * 3] = nx; nor[v * 3 + 2] = nz;
          col[v * 3] = Math.min(255, cr); col[v * 3 + 1] = Math.min(255, cg); col[v * 3 + 2] = Math.min(255, cb);
          // facade coordinates: u = style code + bays along this wall, v = floors from the ground
          uv[v * 2] = fcode + qu[c]; uv[v * 2 + 1] = (quad[c * 3 + 1] - base - 1) / FLOOR;
          v++;
        }
        const a0 = v - 4; idx.set([a0, a0 + 1, a0 + 2, a0, a0 + 2, a0 + 3], k); k += 6;
      }
      if (!roof) return;
      const r0 = v;
      for (let q = 0; q < nn; q++) {
        pos.set([PP[q * 2], y1, -PP[q * 2 + 1]], v * 3); nor[v * 3 + 1] = 127;
        col[v * 3] = Math.min(255, rc[0] * rs); col[v * 3 + 1] = Math.min(255, rc[1] * rs); col[v * 3 + 2] = Math.min(255, rc[2] * rs);
        uv[v * 2] = -1; uv[v * 2 + 1] = -1; v++;
      }
      const tri = nn === 3 ? [0, 1, 2] : nn === 4 ? [0, 1, 2, 0, 2, 3] : earcut(PP);
      for (let t = 0; t < tri.length; t += 3) {
        let i0 = tri[t], i1 = tri[t + 1], i2 = tri[t + 2];
        const cr2 = (PP[i1 * 2] - PP[i0 * 2]) * (PP[i2 * 2 + 1] - PP[i0 * 2 + 1]) - (PP[i1 * 2 + 1] - PP[i0 * 2 + 1]) * (PP[i2 * 2] - PP[i0 * 2]);
        if (cr2 < 0) [i1, i2] = [i2, i1];
        idx[k++] = r0 + i0; idx[k++] = r0 + i1; idx[k++] = r0 + i2;
      }
    };
    let PR = P;                                        // the ring that carries the roof equipment
    if (it.nt > 1) {
      let cx = 0, cy = 0; for (let q = 0; q < n; q++) { cx += P[q * 2]; cy += P[q * 2 + 1]; } cx /= n; cy /= n;
      const inset = (sc) => { const R = new Array(n * 2); for (let q = 0; q < n; q++) { R[q * 2] = cx + (P[q * 2] - cx) * sc; R[q * 2 + 1] = cy + (P[q * 2 + 1] - cy) * sc; } return R; };
      const pTop = base + 1 + (2 + Math.floor(j4 * 3)) * FLOOR, s1 = 0.62 + 0.2 * j3;
      const podCode = ((office ? 4 : 5) + (j4 > 0.2 ? 0 : 6)) * 1000, pr = 186 * shade, pg = 183 * shade, pb = 176 * shade;
      prism(P, base, pTop, podCode, pr, pg, pb, true);                                // podium
      const tower = inset(s1);
      if (it.nt === 3) {
        const cTop = top - 2 * FLOOR, crown = inset(s1 * 0.82);
        prism(tower, pTop, cTop, code, r, g, bl, true);
        prism(crown, cTop, top, code, r * 0.9, g * 0.9, bl * 0.9, true);              // crown
        PR = crown;
      } else { prism(tower, pTop, top, code, r, g, bl, true); PR = tower; }
    } else prism(P, base, top, code, r, g, bl, !it.hip);
    if (it.hip) {
      let Q = [[P[0], P[1]], [P[2], P[3]], [P[4], P[5]], [P[6], P[7]]];
      if (Math.hypot(Q[1][0] - Q[0][0], Q[1][1] - Q[0][1]) < Math.hypot(Q[2][0] - Q[1][0], Q[2][1] - Q[1][1])) Q = [Q[1], Q[2], Q[3], Q[0]];
      const L = Math.hypot(Q[1][0] - Q[0][0], Q[1][1] - Q[0][1]), S = Math.hypot(Q[2][0] - Q[1][0], Q[2][1] - Q[1][1]);
      const ma = [(Q[1][0] + Q[2][0]) / 2, (Q[1][1] + Q[2][1]) / 2], mb = [(Q[3][0] + Q[0][0]) / 2, (Q[3][1] + Q[0][1]) / 2];
      const kk = Math.min(0.5, S / 2 / (L || 1)), rise = it.shed ? Math.min(3.4, S * 0.11) : Math.min(2.4, S * 0.35);
      const ra = [ma[0] + (mb[0] - ma[0]) * kk, ma[1] + (mb[1] - ma[1]) * kk], rb = [mb[0] + (ma[0] - mb[0]) * kk, mb[1] + (ma[1] - mb[1]) * kk];
      const SHED = [[72, 104, 146], [136, 140, 144], [150, 90, 74], [98, 124, 100], [176, 174, 168], [120, 96, 80]], clay = it.j > 0.45;
      const tint = it.shed ? SHED[Math.floor(((it.j * 613) % 1) * SHED.length)] : clay ? [168, 98, 68] : [112, 108, 104], ts = 0.88 + 0.24 * ((it.j * 977) % 1);
      const T3 = (p, h) => [p[0], top + h, -p[1]];
      const faces = [[T3(Q[0], 0), T3(Q[1], 0), T3(ra, rise), T3(rb, rise)], [T3(Q[2], 0), T3(Q[3], 0), T3(rb, rise), T3(ra, rise)], [T3(Q[1], 0), T3(Q[2], 0), T3(ra, rise)], [T3(Q[3], 0), T3(Q[0], 0), T3(rb, rise)]];
      for (const F of faces) {
        const e1 = [F[1][0] - F[0][0], F[1][1] - F[0][1], F[1][2] - F[0][2]], e2 = [F[2][0] - F[0][0], F[2][1] - F[0][1], F[2][2] - F[0][2]];
        let cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
        const cl = Math.hypot(cx, cy, cz) || 1; cx /= cl; cy /= cl; cz /= cl;
        const f0 = v;
        for (const p of F) {
          pos.set(p, v * 3); nor[v * 3] = Math.round(cx * 127); nor[v * 3 + 1] = Math.round(cy * 127); nor[v * 3 + 2] = Math.round(cz * 127);
          col[v * 3] = Math.min(255, tint[0] * ts); col[v * 3 + 1] = Math.min(255, tint[1] * ts); col[v * 3 + 2] = Math.min(255, tint[2] * ts);
          uv[v * 2] = -1; uv[v * 2 + 1] = -1; v++;
        }
        idx[k++] = f0; idx[k++] = f0 + 1; idx[k++] = f0 + 2;
        if (F.length === 4) { idx[k++] = f0; idx[k++] = f0 + 2; idx[k++] = f0 + 3; }
      }
    }

    // rooftop: black water tanks (a Hyderabad signature) and a stair room on taller blocks
    if (detail && hh >= 6 && it.area >= 50 && !it.hip) {
      const P = PR, n = P.length / 2;
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      for (let q = 0; q < n; q++) { minx = Math.min(minx, P[q * 2]); maxx = Math.max(maxx, P[q * 2]); miny = Math.min(miny, P[q * 2 + 1]); maxy = Math.max(maxy, P[q * 2 + 1]); }
      const inside = (x, y, m) => {
        let c = false;
        for (let q = 0, w = n - 1; q < n; w = q++) {
          const xi = P[q * 2], yi = P[q * 2 + 1], xj = P[w * 2], yj = P[w * 2 + 1];
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
        }
        if (!c) return false;
        for (const [ox, oy] of [[m, 0], [-m, 0], [0, m], [0, -m]]) { /* keep away from the edge */
          let c2 = false; const px = x + ox, py = y + oy;
          for (let q = 0, w = n - 1; q < n; w = q++) {
            const xi = P[q * 2], yi = P[q * 2 + 1], xj = P[w * 2], yj = P[w * 2 + 1];
            if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c2 = !c2;
          }
          if (!c2) return false;
        }
        return true;
      };
      let seed = Math.floor(it.j * 1e9) | 1;
      const rr = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296; };
      const want = it.area < 150 ? 1 : it.area < 600 ? 2 : 3 + Math.floor(rr() * 3);
      let placed = 0;
      for (let tries = 0; tries < want * 6 && placed < want; tries++) {
        const x = minx + rr() * (maxx - minx), y = miny + rr() * (maxy - miny);
        if (!inside(x, y, 1.5)) continue;
        const s = 0.85 + rr() * 0.4;
        tanks.push(x, top, -y, s); placed++;
        if (rr() < 0.5 && placed < want && inside(x + 2.3 * s, y, 1.4)) { tanks.push(x + 2.3 * s, top, -y, s); placed++; }
      }
      if (hh >= 12 && it.area >= 200) {
        for (let tries = 0; tries < 8; tries++) {
          const x = minx + rr() * (maxx - minx), y = miny + rr() * (maxy - miny);
          if (inside(x, y, 3)) { rooms.push(x, top, -y, rr() * 6.283); break; }
        }
      }
    }
  });
  bStart[list.length] = k;
  const mapped = list.reduce((s2, it) => s2 + (it.cls & 0x80 ? 1 : 0), 0);
  return { pos, nor, col, uv, idx: idx.slice(0, k), bStart, bH, bCls, bBase, names, ids, cent, count: list.length, mapped,
    tanks: new Float32Array(tanks), rooms: new Float32Array(rooms) };
}


// Road surfaces as real geometry on near tiles, so cars drive on them (not above or below).
// Heights come from the same terrain function the traffic uses, plus a small lift per class.
const ROAD_LIFT = [0.42, 0.42, 0.42, 0.38, 0.38, 0.32, 0.3];
const RIB = { motorway: [0, 18, 0], trunk: [1, 15, 0], primary: [2, 13, 0], secondary: [3, 11, 1], tertiary: [4, 9, 1], minor: [5, 6.5, 2], service: [6, 4.5, 2] };
// Bridges and flyovers: the deck rises from the ground at both ends to a height that grows with length.
let curZ = 14;
const bridgeRise = (len) => Math.min(8.5, Math.max(0, (len - 45) * 0.055));
function roadRibbons(ofm, b) {
  const tr = ofm && ofm.layers.transportation;
  if (!tr) return null;
  const sc = b.size / tr.extent, sets = [[], [], []], deckPts = [], all = [], br = [];
  for (let i = 0; i < tr.length; i++) {
    const f = tr.feature(i), p = f.properties, def = RIB[p.class];
    if (!def || f.type !== 2 || p.brunnel === 'tunnel') continue;
    for (const g of f.loadGeometry()) {
      if (g.length < 2) continue;
      const pts = [], orig = [];
      for (let q = 0; q < g.length; q++) {
        const x = b.x0 + g[q].x * sc, y = b.y1 - g[q].y * sc;
        if (q) {                                  // subdivide so the ribbon follows the terrain
          const px = pts[pts.length - 2], py = pts[pts.length - 1], d = Math.hypot(x - px, y - py), steps = Math.floor(d / 8);
          for (let s = 1; s <= steps; s++) pts.push(px + (x - px) * s / (steps + 1), py + (y - py) * s / (steps + 1));
        }
        orig.push(pts.length / 2);
        pts.push(x, y);
      }
      const item = { cls: def[0], w: def[1], pts, ys: null, orig, name: p.class, oneway: !!p.oneway };
      if (p.brunnel === 'bridge') {
        const c = pts.length / 2, cum = [0];
        for (let i = 1; i < c; i++) cum.push(cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]));
        br.push({ item, c, cum, len: cum[c - 1], grp: br.length });
      }
      all.push(item); sets[def[2]].push(item);
    }
  }
  // One flyover is mapped as several ways (a carriageway each way, ramps). Ways that touch or run alongside each other share one
  // group, and the group's longest way sets the deck height, so the parts line up instead of crossing at different heights.
  const find = (i) => { while (br[i].grp !== i) i = br[i].grp = br[br[i].grp].grp; return i; };
  const cells = new Map();
  br.forEach((q, i) => {
    const P = q.item.pts;
    for (let k = 0; k < q.c; k++) {
      const cx = Math.floor(P[k * 2] / 24), cy = Math.floor(P[k * 2 + 1] / 24);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const j of cells.get((cx + dx) + ',' + (cy + dy)) || []) {
          if (j === i) continue;
          const Q = br[j].item.pts;
          for (let m = 0; m < br[j].c; m++) if (Math.hypot(Q[m * 2] - P[k * 2], Q[m * 2 + 1] - P[k * 2 + 1]) < 22) { br[find(i)].grp = find(j); m = br[j].c; dx = dy = 2; break; }
        }
      }
      const key = cx + ',' + cy; (cells.get(key) || cells.set(key, []).get(key)).push(i);
    }
  });
  const gLen = new Map();
  br.forEach((q, i) => { const r = find(i); gLen.set(r, Math.max(gLen.get(r) || 0, q.len)); });
  br.forEach((q, i) => {
    const { item, c, cum, len } = q, pts = item.pts, rise = bridgeRise(gLen.get(find(i))), lift = ROAD_LIFT[item.cls];
    if (rise < 0.8) return;
    const gA = meshHeight(pts[0], pts[1]) + lift, gB = meshHeight(pts[c * 2 - 2], pts[c * 2 - 1]) + lift, ramp = Math.min(len / 2, 70);
    const ys = new Float32Array(c);
    for (let k = 0; k < c; k++) {
      const t = Math.min(1, Math.min(cum[k], len - cum[k]) / ramp), sm = t * t * (3 - 2 * t);
      ys[k] = Math.max(meshHeight(pts[k * 2], pts[k * 2 + 1]) + lift, gA + (gB - gA) * cum[k] / len + rise * sm);
    }
    item.ys = ys;
    deckPts.push({ pts, ys, w: item.w, g: find(i) });
  });
  const out = sets.map((list) => {
    let nv = 0, ni = 0;
    for (const l of list) { const c = l.pts.length / 2; nv += c * 2; ni += (c - 1) * 6; }
    if (!nv) return null;
    const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = new Uint32Array(ni);
    let v = 0, k = 0;
    for (const l of list) {
      const P = l.pts, c = P.length / 2, hw = l.w / 2, lift = ROAD_LIFT[l.cls];
      let along = 0;
      for (let i = 0; i < c; i++) {
        const a = Math.max(0, i - 1), bb = Math.min(c - 1, i + 1);
        let tx = P[bb * 2] - P[a * 2], ty = P[bb * 2 + 1] - P[a * 2 + 1];
        const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
        const x = P[i * 2], y = P[i * 2 + 1];
        if (i) along += Math.hypot(x - P[i * 2 - 2], y - P[i * 2 - 1]);
        const lx = x - ty * hw, ly = y + tx * hw, rx = x + ty * hw, ry = y - tx * hw;
        const yl = l.ys ? l.ys[i] : meshHeight(lx, ly) + lift, yr = l.ys ? l.ys[i] : meshHeight(rx, ry) + lift;
        pos.set([lx, yl, -ly, rx, yr, -ry], v * 3);
        uv.set([0, along / 24, 1, along / 24], v * 2); v += 2;
        if (i < c - 1) { idx.set([v - 2, v - 1, v, v - 1, v + 1, v], k); k += 6; }
      }
    }
    return { pos, uv, idx };
  });
  out.deck = bridgeDecks(deckPts, all.filter((it) => !it.ys));
  out.cable = cableStayed(deckPts, b);
  out.extras = roadExtras(all);
  out.lamps = STREET_LAMPS ? roadLamps(all) : new Float32Array(0);
  return out;
}

// ---- street lamps: a pole every few tens of metres, alternating sides, with a pool of light on the road
const STREET_LAMPS = false;   // set true to bring back lamp poles and light pools
const LAMP_GAP = { motorway: 36, trunk: 34, primary: 30, secondary: 32, tertiary: 36, minor: 48 };
function roadLamps(items) {
  const out = [];
  for (const it of items) {
    const gap = LAMP_GAP[it.name]; if (!gap) continue;
    const P = it.pts, cum = cumOf(P), len = cum[cum.length - 1], hw = it.w / 2, lift = ROAD_LIFT[it.cls];
    let side = (Math.floor(P[0] * 7 + P[1] * 3) & 1) ? 1 : -1;
    for (let d = gap * 0.5; d < len - 6; d += gap) {
      const [x, y, tx, ty] = walkAt(P, cum, d), nx = -ty, ny = tx;
      let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
      const base = it.ys ? it.ys[i] : null;
      const ex = x + nx * side * (hw + 0.9), ey = y + ny * side * (hw + 0.9), cx = x + nx * side * (hw * 0.45), cy = y + ny * side * (hw * 0.45);
      const gy = base !== null ? base : meshHeight(ex, ey) + lift, py = base !== null ? base : meshHeight(cx, cy) + lift;
      out.push(ex, gy, -ey, cx, py + 0.12, -cy, Math.atan2(ty, tx), Math.max(8, hw + 3), side);
      side = -side;
      if (out.length > 9 * 5000) return new Float32Array(out);
    }
  }
  return new Float32Array(out);
}

// ---- sidewalks, medians, junction patches and zebra crossings
const WALK = {};   // sidewalks removed (looked poor); fill in per-class widths to bring them back
const nkey = (x, y) => Math.round(x * 2) + ',' + Math.round(y * 2);
function cumOf(P) { const c = P.length / 2, cum = new Float32Array(c); for (let i = 1; i < c; i++) cum[i] = cum[i - 1] + Math.hypot(P[i * 2] - P[i * 2 - 2], P[i * 2 + 1] - P[i * 2 - 1]); return cum; }
function walkAt(P, cum, d) {                       // point at distance d along the path + unit direction of travel
  const c = cum.length; d = Math.max(0, Math.min(cum[c - 1], d));
  let i = 1; while (i < c - 1 && cum[i] < d) i++;
  const ax = P[i * 2 - 2], ay = P[i * 2 - 1], bx = P[i * 2], by = P[i * 2 + 1], dl = Math.hypot(bx - ax, by - ay) || 1, t = (d - cum[i - 1]) / dl;
  return [ax + (bx - ax) * t, ay + (by - ay) * t, (bx - ax) / dl, (by - ay) / dl];
}
function subPath(P, cum, d0, d1) {
  const a = walkAt(P, cum, d0), out = [a[0], a[1]];
  for (let i = 0; i < cum.length; i++) if (cum[i] > d0 + 0.01 && cum[i] < d1 - 0.01) out.push(P[i * 2], P[i * 2 + 1]);
  const e = walkAt(P, cum, d1); out.push(e[0], e[1]); return out;
}
function roadExtras(items) {
  const nodes = new Map(), usable = items.filter((it) => !it.ys);
  const addLeg = (x, y, dx, dy, it, end, j) => { const k = nkey(x, y); let n = nodes.get(k); if (!n) nodes.set(k, n = { x, y, legs: [] }); const leg = { dx, dy, it, end, j, sg: 0 }; n.legs.push(leg); return leg; };
  for (const it of usable) {
    const P = it.pts, c = P.length / 2; it.cum = cumOf(P); it.cuts = [];
    let dx = P[2] - P[0], dy = P[3] - P[1], l = Math.hypot(dx, dy) || 1;
    addLeg(P[0], P[1], dx / l, dy / l, it, 0, 0);
    dx = P[c * 2 - 4] - P[c * 2 - 2]; dy = P[c * 2 - 3] - P[c * 2 - 1]; l = Math.hypot(dx, dy) || 1;
    addLeg(P[c * 2 - 2], P[c * 2 - 1], dx / l, dy / l, it, 1, c - 1);
    for (const j of it.orig) if (j > 0 && j < c - 1) {
      for (const [sg, k2] of [[1, j + 1], [-1, j - 1]]) { const ex = P[k2 * 2] - P[j * 2], ey = P[k2 * 2 + 1] - P[j * 2 + 1], el = Math.hypot(ex, ey) || 1; addLeg(P[j * 2], P[j * 2 + 1], ex / el, ey / el, it, 2, j).sg = sg; }
    }
  }
  const W = { pos: [], col: [], idx: [] }, M = { pos: [], col: [], idx: [] }, D = { pos: [], uv: [], idx: [] };
  const junctions = [];
  for (const n of nodes.values()) {
    if (n.legs.length < 3) continue;
    junctions.push(n);
    const L = n.legs.filter((q) => q.dx || q.dy).sort((p, q) => Math.atan2(p.dy, p.dx) - Math.atan2(q.dy, q.dx)), m = L.length;
    n.L = L;
    if (m < 3) { n.bad = true; continue; }
    // corner where leg i's left edge meets the next leg's right edge
    const corner = [];
    for (let i = 0; i < m; i++) {
      const a = L[i], c = L[(i + 1) % m], hi = a.it.w / 2, hj = c.it.w / 2, sin = a.dx * c.dy - a.dy * c.dx, cos = a.dx * c.dx + a.dy * c.dy;
      if (sin > 0.3) { const t = (hj + hi * cos) / sin; corner.push(t > 0 && t < 13 ? [n.x - a.dy * hi + a.dx * t, n.y + a.dx * hi + a.dy * t, t] : 'node'); }
      else corner.push(sin < -0.3 ? 'node' : null);      // reflex gap -> pinch at the node; collinear/overlapping -> straight edge
    }
    L.forEach((q, i) => {
      const h = q.it.w / 2; let T = h + 0.5;
      for (const cn of [corner[i], corner[(i + m - 1) % m]]) if (Array.isArray(cn)) T = Math.max(T, (cn[0] - n.x) * q.dx + (cn[1] - n.y) * q.dy);
      q.T = Math.min(16, Math.max(2, T));
      const len = q.it.cum[q.it.cum.length - 1], cj = q.it.cum[q.j];
      q.it.cuts.push(q.end === 0 ? [0, q.T] : q.end === 1 ? [len - q.T, len] : q.sg > 0 ? [cj, cj + q.T] : [cj - q.T, cj]);
    });
    n.poly = [];
    L.forEach((q, i) => {
      const h = q.it.w / 2;
      n.poly.push([n.x + q.dy * h + q.dx * q.T, n.y - q.dx * h + q.dy * q.T], [n.x - q.dy * h + q.dx * q.T, n.y + q.dx * h + q.dy * q.T]);
      const cn = corner[i];
      if (cn === 'node') {                         // far or reflex gap: pave only the roads' own stubs, not the gap between them
        const c = L[(i + 1) % m], hc = c.it.w / 2;
        n.poly.push([n.x - q.dy * h, n.y + q.dx * h], [n.x + c.dy * hc, n.y - c.dx * hc]);
      } else if (cn) n.poly.push([cn[0], cn[1]]);
    });
    n.maxT = Math.max(...L.map((q) => q.T));
  }
  const JC = 40, jgrid = new Map();                 // junction lookup: keep crossings off other junctions' patches
  for (const n of junctions) if (!n.bad) { const k = Math.floor(n.x / JC) + ',' + Math.floor(n.y / JC); (jgrid.get(k) || jgrid.set(k, []).get(k)).push(n); }
  const nearOther = (n, x, y) => {
    const cx = Math.floor(x / JC), cy = Math.floor(y / JC);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const o of jgrid.get((cx + dx) + ',' + (cy + dy)) || []) if (o !== n && Math.hypot(o.x - x, o.y - y) < o.maxT + 5) return true;
    return false;
  };
  const strip = (B, Q, prof, lift, col) => {
    const c = Q.length / 2, m = prof.length, base = B.pos.length / 3;
    for (let i = 0; i < c; i++) {
      const a = Math.max(0, i - 1), bb = Math.min(c - 1, i + 1);
      let tx = Q[bb * 2] - Q[a * 2], ty = Q[bb * 2 + 1] - Q[a * 2 + 1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const x = Q[i * 2], y = Q[i * 2 + 1], nx = -ty, ny = tx;
      const y0 = meshHeight(x + nx * prof[0][0], y + ny * prof[0][0]) + lift;
      for (const [o, h] of prof) { B.pos.push(x + nx * o, y0 + h, -(y + ny * o)); B.col.push(col[0], col[1], col[2]); }
    }
    for (let i = 0; i < c - 1; i++) for (let j = 0; j < m - 1; j++) { const a = base + i * m + j, b2 = a + m; B.idx.push(a, a + 1, b2, a + 1, b2 + 1, b2); }
  };
  const kept = (it) => {                            // path intervals that survive the junction cuts
    const len = it.cum[it.cum.length - 1], cs = it.cuts.slice().sort((p, q) => p[0] - q[0]), out = []; let at = 0;
    for (const [a, b] of cs) { if (a > at) out.push([at, a]); at = Math.max(at, b); }
    if (at < len) out.push([at, len]);
    return out.filter(([a, b]) => b - a > 2.5);
  };
  const SW = [0.62, 0.6, 0.56], MED = [0.42, 0.46, 0.36];
  for (const it of usable) {
    const sw = WALK[it.name], med = (it.name === 'motorway' || it.name === 'trunk') && !it.oneway, lift = ROAD_LIFT[it.cls], hw = it.w / 2;
    if (!sw && !med) continue;
    for (const [a, b] of kept(it)) {
      const Q = subPath(it.pts, it.cum, a, b);
      if (sw) { strip(W, Q, [[hw, 0], [hw, 0.16], [hw + sw, 0.16]], lift, SW); strip(W, Q, [[-hw, 0], [-hw, 0.16], [-hw - sw, 0.16]], lift, SW); }
      if (med) strip(W, Q, [[-0.7, 0], [-0.7, 0.2], [0.7, 0.2], [0.7, 0]], lift, MED);
    }
  }
  for (const n of junctions) {                      // asphalt patch hides the overlapping ribbons
    if (n.bad) continue;
    const lift = Math.max(...n.legs.map((q) => ROAD_LIFT[q.it.cls])), base = D.pos.length / 3, PL = n.poly;
    D.pos.push(n.x, meshHeight(n.x, n.y) + lift + 0.03, -n.y); D.uv.push(0.5, 0.5);
    for (const [vx, vy] of PL) { D.pos.push(vx, meshHeight(vx, vy) + lift + 0.03, -vy); D.uv.push(0.5, 0.5); }
    for (let i = 0; i < PL.length; i++) D.idx.push(base, base + 1 + i, base + 1 + ((i + 1) % PL.length));
    const mark = (cx, cy, tx, ty, o0, o1, t0, t1, lf, col) => {       // axis-aligned quad in the leg's frame
      const nx = -ty, ny = tx, b0 = M.pos.length / 3;
      for (const [o, t] of [[o0, t0], [o1, t0], [o1, t1], [o0, t1]]) { const px = cx + nx * o + tx * t, py = cy + ny * o + ty * t; M.pos.push(px, meshHeight(px, py) + lf, -py); M.col.push(col, col, col * 0.98); }
      M.idx.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3);
    };
    for (const q of n.L) {                          // zebra crossing and stop line on each wide leg
      if (q.it.w < 9) continue;
      const len = q.it.cum[q.it.cum.length - 1], cj = q.it.cum[q.j], zd = q.T + 2.2, sd = q.T + 4.8;
      const at = (d) => (q.end === 0 ? d : q.end === 1 ? len - d : q.sg > 0 ? cj + d : cj - d);
      if (at(sd) < 1 || at(sd) > len - 1) continue;
      if (Math.min(at(sd), len - at(sd)) < 3) continue;                   // too close to the road's far end
      const [cx, cy] = walkAt(q.it.pts, q.it.cum, at(zd));
      if (nearOther(n, cx, cy) || nearOther(n, ...walkAt(q.it.pts, q.it.cum, at(sd)).slice(0, 2))) continue;   // another junction is right there
      const lf = ROAD_LIFT[q.it.cls] + 0.05, hw = q.it.w / 2;
      for (let o = -(hw - 0.9); o <= hw - 0.9; o += 1) mark(cx, cy, q.dx, q.dy, o - 0.25, o + 0.25, -1.5, 1.5, lf, 0.92);
      if (!q.it.oneway) { const [sx, sy] = walkAt(q.it.pts, q.it.cum, at(sd)); mark(sx, sy, q.dx, q.dy, -hw + 0.35, -0.35, -0.2, 0.2, lf, 0.92); }
    }
  }
  const pack = (B) => { const o = { pos: new Float32Array(B.pos), idx: new Uint32Array(B.idx) }; if (B.col) o.col = new Float32Array(B.col); if (B.uv) o.uv = new Float32Array(B.uv); return o; };
  return { walk: W.idx.length ? pack(W) : null, marks: M.idx.length ? pack(M) : null, disc: D.idx.length ? pack(D) : null };
}

// Concrete slab, side walls and piers under raised bridge sections.
function bridgeDecks(list, under) {
  if (!list.length) return null;
  let n = 0; for (const l of list) n += l.ys.length;
  const pos = new Float32Array(n * 6 * 3), idx = new Uint32Array(n * 30), piers = [];
  let v = 0, k = 0;
  const tanAt = (P, c, i) => { const a = Math.max(0, i - 1), bb = Math.min(c - 1, i + 1); let tx = P[bb * 2] - P[a * 2], ty = P[bb * 2 + 1] - P[a * 2 + 1]; const tl = Math.hypot(tx, ty) || 1; return [tx / tl, ty / tl]; };
  // a pier is skipped where an at-grade road passes underneath
  const roadBelow = (px, py) => {
    for (const r of under) {
      const R = r.pts, m = R.length / 2, lim = r.w / 2 + 2.5;
      for (let q = 1; q < m; q++) {
        const ax = R[q * 2 - 2], ay = R[q * 2 - 1], bx = R[q * 2], by = R[q * 2 + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
        const s = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
        if (Math.hypot(px - ax - dx * s, py - ay - dy * s) < lim) return true;
      }
    }
    return false;
  };
  for (const l of list) {
    const P = l.pts, c = l.ys.length, hw = l.w / 2 + 0.4;
    // where a parallel carriageway of the same flyover runs alongside, this slab reaches to the middle between them (one wide deck)
    const hwL = new Float32Array(c).fill(hw), hwR = new Float32Array(c).fill(hw), inL = new Uint8Array(c), inR = new Uint8Array(c);
    for (let i = 0; i < c; i++) {
      const [tx, ty] = tanAt(P, c, i), x = P[i * 2], y = P[i * 2 + 1];
      let bd = 30, bs = 0;
      for (const o of list) {
        if (o === l || o.g !== l.g) continue;
        const Q = o.pts, oc = o.ys.length;
        for (let j = 0; j < oc; j++) {
          const dx = Q[j * 2] - x, dy = Q[j * 2 + 1] - y, d = Math.hypot(dx, dy);
          if (d >= bd || d < 3) continue;
          const [ux, uy] = tanAt(Q, oc, j);
          if (Math.abs(ux * tx + uy * ty) < 0.8) continue;           // only roads that run alongside
          bd = d; bs = dx * -ty + dy * tx;                           // > 0: on the left side
        }
      }
      if (bs > 0) { hwL[i] = Math.max(hw, bd / 2 + 0.2); inL[i] = 1; }
      else if (bs < 0) { hwR[i] = Math.max(hw, bd / 2 + 0.2); inR[i] = 1; }
    }
    let acc = 0;
    for (let i = 0; i < c; i++) {
      const [tx, ty] = tanAt(P, c, i);
      const x = P[i * 2], y = P[i * 2 + 1], t = l.ys[i] - 0.05, lx = x - ty * hwL[i], ly = y + tx * hwL[i], rx = x + ty * hwR[i], ry = y - tx * hwR[i];
      // 0 L top parapet, 1 L deck, 2 L under, 3 R under, 4 R deck, 5 R top parapet (no parapet on the side that joins the other carriageway)
      pos.set([lx, t + (inL[i] ? 0 : 0.9), -ly, lx, t, -ly, lx, t - 1.1, -ly, rx, t - 1.1, -ry, rx, t, -ry, rx, t + (inR[i] ? 0 : 0.9), -ry], v * 3);
      if (i < c - 1) {
        const o = v;
        for (const [p0, p1] of [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]) { idx.set([o + p0, o + p1, o + 6 + p0, o + p1, o + 6 + p1, o + 6 + p0], k); k += 6; }
        const sl = Math.hypot(P[i * 2 + 2] - x, P[i * 2 + 3] - y);
        for (let s = 28 - acc; s < sl; s += 28) {
          const q = s / sl, px = x + (P[i * 2 + 2] - x) * q, py = y + (P[i * 2 + 3] - y) * q, gy = meshHeight(px, py), top = t + (l.ys[i + 1] - l.ys[i]) * q - 1.1;
          if (top - gy > 1.5 && !roadBelow(px, py)) piers.push(px, gy - 0.5, -py, top - gy + 0.5);
        }
        acc = (acc + sl) % 28;
      }
      v += 6;
    }
  }
  return { pos: pos.slice(0, v * 3), idx: idx.slice(0, k), piers: new Float32Array(piers) };
}

// ---- Durgam Cheruvu cable-stayed bridge: two white pylons with fanned stay cables, placed at fixed positions on the bridge axis
// so every tile that holds a piece of it draws the same thing (a tile only draws what lies inside it).
const CABLE_BRIDGE = { a: [17.4313, 78.38804], b: [17.43484, 78.39458], t: [0.3, 0.7], height: 62 };
let cableAxis = null;
function cableStayed(deckPts, b) {
  if (!deckPts.length) return null;
  if (!cableAxis) {
    const [ax, ay] = lonLatToLocal(frame, CABLE_BRIDGE.a[1], CABLE_BRIDGE.a[0]), [bx, by] = lonLatToLocal(frame, CABLE_BRIDGE.b[1], CABLE_BRIDGE.b[0]);
    const L = Math.hypot(bx - ax, by - ay); cableAxis = { ax, ay, L, ux: (bx - ax) / L, uy: (by - ay) / L };
  }
  const { ax, ay, L, ux, uy } = cableAxis, nx = -uy, ny = ux;
  const inTile = (x, y) => x >= b.x0 && x < b.x0 + b.size && y <= b.y1 && y > b.y1 - b.size;
  const S = [];                                           // deck points along the bridge: position, deck height, distance along / across the axis
  // the bridge is an arc: take whole carriageways whose two ends sit at the two ends of the bridge
  const nearEnd = (x, y) => Math.hypot(x - ax, y - ay) < 30 || Math.hypot(x - (ax + ux * L), y - (ay + uy * L)) < 30;
  for (const d of deckPts) {
    const n2 = d.ys.length - 1;
    if (!nearEnd(d.pts[0], d.pts[1]) || !nearEnd(d.pts[n2 * 2], d.pts[n2 * 2 + 1]) || d.ys.length < 30) continue;
    for (let i = 0; i <= n2; i++) { const x = d.pts[i * 2], y = d.pts[i * 2 + 1]; S.push({ x, y, h: d.ys[i], al: (x - ax) * ux + (y - ay) * uy, ac: (x - ax) * nx + (y - ay) * ny }); }
  }
  if (!S.length) return null;
  // the outermost deck point on one side of the road near a given distance along the bridge (the deck curves, so use the real points)
  const edgeAt = (al, side, tol) => {
    const c = S.filter((s) => Math.abs(s.al - al) < tol); if (!c.length) return null;
    const mean = c.reduce((m, s) => m + s.ac, 0) / c.length; let best = null, bv = -1e9;
    for (const s of c) { const v = side * (s.ac - mean); if (v > bv) { bv = v; best = s; } }
    return best;
  };
  const pos = [], col = [], idx = [];
  const quad = (p0, p1, p2, p3, c) => {                  // double-sided quad: the material only draws front faces
    const o = pos.length / 3; for (const p of [p0, p1, p2, p3]) { pos.push(p[0], p[1], p[2]); col.push(c[0], c[1], c[2]); }
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3, o, o + 2, o + 1, o, o + 3, o + 2);
  };
  const prism = (p, q, r, c) => {                        // thin square-section bar from p to q
    let dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2]; const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
    let sx = dy * 0 - dz * 1, sy = dz * 0 - dx * 0, sz = dx * 1 - dy * 0;              // side = dir x up
    const sl = Math.hypot(sx, sy, sz) || 1; sx = sx / sl * r; sy = sy / sl * r; sz = sz / sl * r;
    const tx = (dy * sz - dz * sy), ty = (dz * sx - dx * sz), tz = (dx * sy - dy * sx), tl = Math.hypot(tx, ty, tz) || 1, k = r / tl;
    const O = [[sx, sy, sz], [tx * k, ty * k, tz * k], [-sx, -sy, -sz], [-tx * k, -ty * k, -tz * k]];
    for (let i = 0; i < 4; i++) { const u = O[i], v = O[(i + 1) % 4]; quad([p[0] + u[0], p[1] + u[1], p[2] + u[2]], [q[0] + u[0], q[1] + u[1], q[2] + u[2]], [q[0] + v[0], q[1] + v[1], q[2] + v[2]], [p[0] + v[0], p[1] + v[1], p[2] + v[2]], c); }
  };
  const WHITE = [0.9, 0.9, 0.88], H = CABLE_BRIDGE.height;
  CABLE_BRIDGE.t.forEach((t, k) => {
    const side = k % 2 ? -1 : 1, base = t * L;
    const pe = edgeAt(base, side, 10);
    if (!pe) return;
    const cx = pe.x + nx * side * 8.1, cy = pe.y + ny * side * 8.1, dy0 = pe.h, lean = -side * 1.5;
    // pylon: a tapering white column standing beside the deck, leaning slightly inwards at the top
    if (inTile(cx, cy)) {
      // leaf-shaped pylon like the real one: slim across the deck, broad along it in the lower half, ending in a pointed tip
      const y0 = dy0 - 3, TH = H + 3;
      const prof = (s) => (s < 0.35 ? 0.55 + 0.45 * (s / 0.35) : 1 - 0.97 * Math.pow((s - 0.35) / 0.65, 1.25));   // width factor along the height
      const corner = (wx, wy, s) => [cx + ux * wx + nx * (wy + lean * s), y0 + TH * s, -(cy + uy * wx + ny * (wy + lean * s))];
      const sec = (s) => { const f = prof(s), w = 3.4 * f, d = 1.25 * (0.55 + 0.45 * f); return [corner(-w, -d, s), corner(w, -d, s), corner(w, d, s), corner(-w, d, s)]; };
      const rings = [0, 0.12, 0.25, 0.38, 0.55, 0.75, 0.9, 1].map(sec);
      for (let r = 0; r < rings.length - 1; r++) for (let i = 0; i < 4; i++) quad(rings[r][i], rings[r][(i + 1) % 4], rings[r + 1][(i + 1) % 4], rings[r + 1][i], WHITE);
      quad(rings[rings.length - 1][0], rings[rings.length - 1][1], rings[rings.length - 1][2], rings[rings.length - 1][3], WHITE);
    }
    // stays: a wide fan across the main span (toward the other pylon) and a few short backstays behind, all thin white cables to the deck edge
    const inward = k === 0 ? 1 : -1;
    const stay = (al, topOff, j) => {
      const ae = edgeAt(base + al, side, 5); if (!ae) return;
      const px = ae.x + nx * side * 5.6, py = ae.y + ny * side * 5.6, dyA = ae.h;
      if (!inTile(px, py)) return;
      prism([px, dyA + 0.9, -py], [cx + nx * lean * 0.9 * (topOff / TH_TOP), dyA + topOff, -(cy + ny * lean * 0.9 * (topOff / TH_TOP))], 0.16, WHITE);
    };
    const TH_TOP = H + 3;
    for (let j = 0; j < 17; j++) stay(inward * (16 + j * 7), 24 + j * 2.1, j);          // main span fan
    for (let j = 0; j < 7; j++) stay(-inward * (14 + j * 9), 34 + j * 3.2, j);          // backstays
  });
  if (!pos.length) return null;
  return { pos: new Float32Array(pos), col: new Float32Array(col), idx: new Uint32Array(idx) };
}

// ---- Charminar (1591): four corner minarets with balconies and domes, an arcaded upper storey, and a great pointed arch on each side.
function mergeGeo(list) {                              // join several coloured geometries into one (null when none)
  const g = list.filter(Boolean); if (!g.length) return null; if (g.length === 1) return g[0];
  const nv = g.reduce((n, x) => n + x.pos.length, 0), ni = g.reduce((n, x) => n + x.idx.length, 0);
  const pos = new Float32Array(nv), col = new Float32Array(nv), idx = new Uint32Array(ni);
  let vo = 0, io = 0; for (const x of g) { pos.set(x.pos, vo); col.set(x.col, vo); for (let i = 0; i < x.idx.length; i++) idx[io + i] = x.idx[i] + vo / 3; vo += x.pos.length; io += x.idx.length; }
  return { pos, col, idx };
}
// Hand-built landmark sites (lat, lon, radius in metres): plain Overture footprints inside these are dropped in favour of the models.
const SITES = [[17.36165, 78.47467, 26], [17.41561, 78.47531, 52], [17.45035, 78.38085, 52], [17.3604, 78.4736, 70], [17.3313, 78.4672, 70], [17.4062, 78.4691, 45], [17.3713, 78.4804, 95], [17.3578, 78.4717, 100]];
let siteAt = null;
const nearCharminar = (x, y) => {
  if (!siteAt) siteAt = SITES.map(([la, lo, r]) => { const [px, py] = lonLatToLocal(frame, lo, la); return [px, py, r]; });
  for (const [px, py, r] of siteAt) if (Math.hypot(x - px, y - py) < r) return true;
  return false;
};
// A small kit for building coloured low-poly landmarks around a point: local east/north/height in metres -> scene coordinates.
function geoKit(cx, cy, g0) {
  const pos = [], col = [], idx = [];
  const P = (x, y, h) => [cx + x, g0 + h, -(cy + y)];
  const vert = (p, c) => { pos.push(p[0], p[1], p[2]); col.push(c[0], c[1], c[2]); return pos.length / 3 - 1; };
  const tri = (a, b2, c2, c) => { const i = vert(a, c), j = vert(b2, c), k = vert(c2, c); idx.push(i, j, k, i, k, j); };      // double-sided
  const quad = (a, b2, c2, d, c) => { const i = vert(a, c), j = vert(b2, c), k = vert(c2, c), l = vert(d, c); idx.push(i, j, k, i, k, l, i, k, j, i, l, k); };
  const ring = (x, y, r, h, n, rot, ry) => { const o = []; for (let i = 0; i < n; i++) { const a = rot + (i / n) * Math.PI * 2; o.push(P(x + Math.cos(a) * r, y + Math.sin(a) * (ry === undefined ? r : ry), h)); } return o; };
  const band = (r0, h0, r1, h1, x, y, n, c) => {                       // lathe step between two rings
    const A = ring(x, y, r0, h0, n, 0.2), B = ring(x, y, r1, h1, n, 0.2);
    for (let i = 0; i < n; i++) quad(A[i], A[(i + 1) % n], B[(i + 1) % n], B[i], c);
  };
  const cap = (r, h, x, y, n, c) => { const A = ring(x, y, r, h, n, 0.2), m = P(x, y, h); for (let i = 0; i < n; i++) tri(A[i], A[(i + 1) % n], m, c); };
  const box = (x0, y0, h0, x1, y1, h1, c, cTop) => {                  // axis-aligned block
    quad(P(x0, y0, h0), P(x1, y0, h0), P(x1, y0, h1), P(x0, y0, h1), c); quad(P(x1, y0, h0), P(x1, y1, h0), P(x1, y1, h1), P(x1, y0, h1), c);
    quad(P(x1, y1, h0), P(x0, y1, h0), P(x0, y1, h1), P(x1, y1, h1), c); quad(P(x0, y1, h0), P(x0, y0, h0), P(x0, y0, h1), P(x0, y1, h1), c);
    quad(P(x0, y0, h1), P(x1, y0, h1), P(x1, y1, h1), P(x0, y1, h1), cTop || c);
  };
  const pyr = (x0, y0, x1, y1, h0, h1, c, ax, ay) => {               // four-sided pyramid roof (apex above the centre, or at ax, ay)
    const mx = ax === undefined ? (x0 + x1) / 2 : ax, my = ay === undefined ? (y0 + y1) / 2 : ay, top = P(mx, my, h1);
    tri(P(x0, y0, h0), P(x1, y0, h0), top, c); tri(P(x1, y0, h0), P(x1, y1, h0), top, c); tri(P(x1, y1, h0), P(x0, y1, h0), top, c); tri(P(x0, y1, h0), P(x0, y0, h0), top, c);
  };
  const obx = (x, y, h0, dx, dy, len, thick, hgt, c, cTop) => {        // box of length len along (dx, dy), centred on x, y, standing on height h0
    const nx = -dy, ny = dx, a = len / 2, t = thick / 2;
    const p = (s, k, h) => P(x + dx * s + nx * k, y + dy * s + ny * k, h);
    quad(p(-a, -t, h0), p(a, -t, h0), p(a, -t, h0 + hgt), p(-a, -t, h0 + hgt), c); quad(p(a, -t, h0), p(a, t, h0), p(a, t, h0 + hgt), p(a, -t, h0 + hgt), c);
    quad(p(a, t, h0), p(-a, t, h0), p(-a, t, h0 + hgt), p(a, t, h0 + hgt), c); quad(p(-a, t, h0), p(-a, -t, h0), p(-a, -t, h0 + hgt), p(-a, t, h0 + hgt), c);
    quad(p(-a, -t, h0 + hgt), p(a, -t, h0 + hgt), p(a, t, h0 + hgt), p(-a, t, h0 + hgt), cTop || c);
  };
  const gpatch = (x0, y0, x1, y1, c, lift, step) => {                 // ground-hugging patch: every few metres follows the terrain
    const s = step || 8, nu = Math.max(1, Math.round((x1 - x0) / s)), nw = Math.max(1, Math.round((y1 - y0) / s));
    const at = (x, y) => P(x, y, meshHeight(cx + x, cy + y) - g0 + lift);
    for (let i = 0; i < nu; i++) for (let j = 0; j < nw; j++) {
      const a = x0 + (x1 - x0) * i / nu, b2 = x0 + (x1 - x0) * (i + 1) / nu, c0 = y0 + (y1 - y0) * j / nw, d = y0 + (y1 - y0) * (j + 1) / nw;
      quad(at(a, c0), at(b2, c0), at(b2, d), at(a, d), c);
    }
  };
  const done = () => ({ pos: new Float32Array(pos), col: new Float32Array(col), idx: new Uint32Array(idx) });
  return { P, tri, quad, ring, band, cap, box, pyr, obx, gpatch, done };
}
const siteTile = (b, la, lo) => { const [x, y] = lonLatToLocal(frame, lo, la); return x >= b.x0 && x < b.x0 + b.size && y <= b.y1 && y > b.y1 - b.size ? [x, y] : null; };

function charminar(b) {
  const at = siteTile(b, SITES[0][0], SITES[0][1]);
  if (!at) return null;
  const [cx, cy] = at;
  const { P, tri, quad, band, cap, ring, done } = geoKit(cx, cy, meshHeight(cx, cy) - 0.4);
  const STUCCO = [0.86, 0.8, 0.68], BAND = [0.8, 0.74, 0.62], LIGHT = [0.9, 0.85, 0.74], DARK = [0.2, 0.17, 0.14], GOLD = [0.92, 0.72, 0.25], DOME = [0.84, 0.78, 0.64];
  const N = 10;
  // minarets at the four corners
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const x = sx * 13, y = sy * 13;
    band(4.9, 0, 4.7, 24, x, y, N, STUCCO); band(4.7, 24, 6.0, 24.2, x, y, N, STUCCO); band(6.0, 24.2, 6.0, 25.2, x, y, N, BAND); cap(6.0, 25.2, x, y, N, LIGHT);
    band(3.4, 25.2, 3.3, 32, x, y, N, STUCCO); band(3.3, 32, 4.8, 32.2, x, y, N, STUCCO); band(4.8, 32.2, 4.8, 33.1, x, y, N, BAND); cap(4.8, 33.1, x, y, N, LIGHT);
    band(3.0, 33.1, 2.9, 40, x, y, N, STUCCO); band(2.9, 40, 4.2, 40.2, x, y, N, STUCCO); band(4.2, 40.2, 4.2, 41, x, y, N, BAND); cap(4.2, 41, x, y, N, LIGHT);
    band(2.7, 41, 2.6, 45, x, y, N, STUCCO); band(2.6, 45, 3.3, 45.2, x, y, N, BAND); band(3.3, 45.2, 3.3, 46, x, y, N, BAND);
    const dr = [3.2, 3.45, 3.05, 2.15, 1.15, 0.4], dh = [46, 47.4, 48.8, 50, 51, 51.7];
    for (let i = 0; i < dr.length - 1; i++) band(dr[i], dh[i], dr[i + 1], dh[i + 1], x, y, N, DOME);
    for (let i = 0; i < N; i++) { const A = ring(x, y, 0.45, 51.7, N, 0.2)[i], B2 = ring(x, y, 0.45, 51.7, N, 0.2)[(i + 1) % N]; tri(A, B2, P(x, y, 55.8), GOLD); }
    // open arched balconies: dark arched windows around each stage
    for (const [h0, r0, hh] of [[27, 3.4, 3.2], [34.2, 3.0, 3.2], [41.8, 2.7, 2.3]]) for (let i = 0; i < 8; i++) {
      const a = 0.2 + (i / 8) * Math.PI * 2, nx = Math.cos(a), ny = Math.sin(a), tx = -ny, ty = nx, r = r0 + 0.08, w = 0.55;
      quad(P(x + nx * r - tx * w, y + ny * r - ty * w, h0), P(x + nx * r + tx * w, y + ny * r + ty * w, h0), P(x + nx * r + tx * w, y + ny * r + ty * w, h0 + hh), P(x + nx * r - tx * w, y + ny * r - ty * w, h0 + hh), DARK);
    }
  }
  // the four sides: a thick wall with a great pointed arch through it, an arcaded gallery above, a jali parapet on top
  const WALL_H = 22, T = 4.5, D = 14.6, HALF = 13, AW = 5.75;
  const hole = []; for (let i = 0; i <= 7; i++) { const s = i / 7; hole.push([-AW * (1 - s * s), 11 + 7.6 * s]); }
  for (let i = 6; i >= 0; i--) { const s = i / 7; hole.push([AW * (1 - s * s), 11 + 7.6 * s]); }
  hole.unshift([-AW, 0]); hole.push([AW, 0]);                                // closes the opening at the ground
  const outer = [[-HALF, 0], [HALF, 0], [HALF, WALL_H], [-HALF, WALL_H]];
  const flat = []; for (const p of outer) flat.push(p[0], p[1]); for (const p of hole) flat.push(p[0], p[1]);
  const tris = earcut(flat, [outer.length]);
  for (const [nxv, nyv] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const tx = -nyv, ty = nxv;
    const W = (u, v, d) => P(nxv * d + tx * u, nyv * d + ty * u, v);        // u across the wall, v height, d distance from the centre
    const pts2 = (all, d) => { const o = []; for (let i = 0; i < all.length; i += 2) o.push(W(all[i], all[i + 1], d)); return o; };
    const F = pts2(flat, D), Bk = pts2(flat, D - T);
    for (let t = 0; t < tris.length; t += 3) { tri(F[tris[t]], F[tris[t + 1]], F[tris[t + 2]], STUCCO); tri(Bk[tris[t]], Bk[tris[t + 1]], Bk[tris[t + 2]], BAND); }
    for (let i = 0; i < hole.length; i++) { const a = hole[i], c2 = hole[(i + 1) % hole.length]; if (i === hole.length - 1) continue; quad(W(a[0], a[1], D), W(c2[0], c2[1], D), W(c2[0], c2[1], D - T), W(a[0], a[1], D - T), DARK); }
    quad(W(-HALF, WALL_H, D), W(HALF, WALL_H, D), W(HALF, WALL_H, D - T), W(-HALF, WALL_H, D - T), BAND);
    // arch moulding: a darker pointed band just outside the opening
    for (let i = 0; i < hole.length - 2; i++) { const a = hole[i + 1], c2 = hole[i + 2]; if (a[1] < 10 && c2[1] < 10) continue; quad(W(a[0] * 1.12, a[1] * 1.04, D + 0.06), W(c2[0] * 1.12, c2[1] * 1.04, D + 0.06), W(c2[0], c2[1], D + 0.06), W(a[0], a[1], D + 0.06), BAND); }
    // gallery above: a band with eleven arched openings, then the balustrade
    const GH0 = WALL_H, GH1 = 29.5;
    quad(W(-HALF - 1.5, GH0, D + 0.4), W(HALF + 1.5, GH0, D + 0.4), W(HALF + 1.5, GH1, D + 0.4), W(-HALF - 1.5, GH1, D + 0.4), BAND);
    quad(W(-HALF - 1.5, GH1, D + 0.4), W(HALF + 1.5, GH1, D + 0.4), W(HALF + 1.5, GH1, D - T), W(-HALF - 1.5, GH1, D - T), LIGHT);
    for (let i = 0; i < 11; i++) { const u = -10 + i * 2; quad(W(u - 0.7, 24.2, D + 0.46), W(u + 0.7, 24.2, D + 0.46), W(u + 0.7, 27.4, D + 0.46), W(u - 0.7, 27.4, D + 0.46), DARK); tri(W(u - 0.7, 27.4, D + 0.46), W(u + 0.7, 27.4, D + 0.46), W(u, 28.3, D + 0.46), DARK); }
    quad(W(-HALF - 1.5, GH1, D + 0.2), W(HALF + 1.5, GH1, D + 0.2), W(HALF + 1.5, 31.2, D + 0.2), W(-HALF - 1.5, 31.2, D + 0.2), LIGHT);
    for (let i = 0; i < 14; i++) { const u = -11.5 + i * 1.77; quad(W(u - 0.5, 29.9, D + 0.26), W(u + 0.5, 29.9, D + 0.26), W(u + 0.5, 30.9, D + 0.26), W(u - 0.5, 30.9, D + 0.26), DARK); }
  }
  // the gallery's roof deck
  quad(P(-13, -13, 29.5), P(13, -13, 29.5), P(13, 13, 29.5), P(-13, 13, 29.5), BAND);
  return done();
}

// ---- Cyber Towers, HITEC City (1998): one round drum in tan-orange with a white diagonal lattice, a green glass atrium slot at each end,
// and white roof rings. It faces south, towards the metro and the plaza.
function cyberTowers(b) {
  const at = siteTile(b, SITES[2][0], SITES[2][1]); if (!at) return null;
  const [cx, cy] = at;
  const { P, quad, band, cap, box, done } = geoKit(cx, cy, meshHeight(cx, cy) - 0.4);
  const TAN = [0.8, 0.55, 0.38], WHITE = [0.95, 0.94, 0.9], GLASS = [0.2, 0.52, 0.48], GLASS2 = [0.14, 0.34, 0.32], ROOF = [0.52, 0.5, 0.48], SLIT = [0.28, 0.2, 0.16];
  const R = 40, H = 60, N = 32, A0 = 0.2, FW = 2 * R * Math.sin(Math.PI / N);
  const pt = (i, r, h) => { const a = A0 + (i / N) * Math.PI * 2; return P(Math.cos(a) * r, Math.sin(a) * r, h); };
  for (let i = 0; i < N; i++) {
    const am = A0 + ((i + 0.5) / N) * Math.PI * 2, mx = Math.cos(am) * R;
    quad(pt(i, R, 0), pt(i + 1, R, 0), pt(i + 1, R, H), pt(i, R, H), TAN);
    if (Math.abs(mx) < 13) continue;                                      // the slot faces get glass instead of lattice
    for (let k = 0; k < 7; k++) {                                          // two diagonal bars per bay make the diamond lattice
      const h = 1 + k * FW;
      quad(pt(i, R + 0.35, h), pt(i + 1, R + 0.35, h + FW), pt(i + 1, R + 0.35, h + FW + 0.7), pt(i, R + 0.35, h + 0.7), WHITE);
      quad(pt(i + 1, R + 0.35, h), pt(i, R + 0.35, h + FW), pt(i, R + 0.35, h + FW + 0.7), pt(i + 1, R + 0.35, h + 0.7), WHITE);
    }
    quad(pt(i, R + 0.2, 2), pt(i, R + 0.2, 2), pt(i, R + 0.2, H - 2), pt(i, R + 0.2, H - 2), SLIT);
  }
  // glass atrium at the south and north ends, topped by the white name board
  box(-11, -R - 3, 0, 11, -R + 10, 52, GLASS, GLASS2); box(-14, -R - 4, 52, 14, -R + 11, 57, WHITE);
  box(-11, R - 10, 0, 11, R + 3, 52, GLASS, GLASS2); box(-14, R - 11, 52, 14, R + 4, 57, WHITE);
  // roof: the white rim ring, a second ring inside it and the plant deck
  band(R, H, R, H + 2.6, 0, 0, N, WHITE); band(R, H + 2.6, R - 9, H + 2.6, 0, 0, N, WHITE); band(R - 9, H + 2.6, R - 9, H, 0, 0, N, WHITE);
  cap(R - 9, H + 0.2, 0, 0, N, ROOF); box(-13, -13, H, 13, 13, H + 3.5, [0.7, 0.7, 0.68], [0.6, 0.6, 0.58]);
  return done();
}

// ---- Mecca Masjid (1694): a long prayer hall with fifteen pointed arches, two octagonal minarets, an arcaded courtyard and the central tank.
function meccaMasjid(b) {
  const at = siteTile(b, SITES[3][0], SITES[3][1]); if (!at) return null;
  const [cx, cy] = at;
  const { P, quad, tri, band, cap, box, gpatch, done } = geoKit(cx, cy, meshHeight(cx, cy) - 0.4);
  const STONE = [0.64, 0.59, 0.52], LIGHT = [0.76, 0.71, 0.63], DARK = [0.18, 0.15, 0.12], PAVE = [0.74, 0.7, 0.64], WATER = [0.3, 0.52, 0.58], DOME = [0.7, 0.64, 0.55];
  gpatch(-30, -45, 62, 45, PAVE, 0.12, 10);                                              // courtyard paving
  box(-60, -37, -3, -30, 37, 19, STONE, [0.55, 0.5, 0.45]);                              // prayer hall (the qibla wall is on the west)
  box(-60.6, -37.6, 19, -29.4, 37.6, 21.2, LIGHT, LIGHT);
  for (let y = -35; y <= 35; y += 5) box(-31, y - 0.5, 21.2, -30, y + 0.5, 24, LIGHT);   // pinnacles along the parapet
  for (let i = 0; i < 15; i++) {                                                          // the fifteen pointed arches of the facade
    const y = -32 + i * 4.57;
    quad(P(-29.9, y - 1.4, 1.5), P(-29.9, y + 1.4, 1.5), P(-29.9, y + 1.4, 12), P(-29.9, y - 1.4, 12), DARK);
    tri(P(-29.9, y - 1.4, 12), P(-29.9, y + 1.4, 12), P(-29.9, y, 15.5), DARK);
  }
  box(-32, -8, 21.2, -29.4, 8, 27.5, STONE, LIGHT);                                       // the raised centre of the facade
  for (const sy of [-1, 1]) {                                                             // the two great minarets flanking the hall
    const y = sy * 37.8, x = -30;
    band(4.2, 0, 3.6, 24, x, y, 8, STONE); band(3.6, 24, 4.8, 24.2, x, y, 8, LIGHT); band(4.8, 24.2, 4.8, 25.4, x, y, 8, LIGHT); cap(4.8, 25.4, x, y, 8, LIGHT);
    band(3, 25.4, 2.8, 31, x, y, 8, STONE); band(2.8, 31, 3.5, 31.2, x, y, 8, LIGHT);
    const rr = [3.2, 3.3, 2.7, 1.7, 0.8, 0.2], hh = [31.2, 32.4, 33.6, 34.7, 35.5, 36]; for (let i = 0; i < rr.length - 1; i++) band(rr[i], hh[i], rr[i + 1], hh[i + 1], x, y, 8, DOME);
  }
  // arcaded wall round the other three sides of the courtyard, and a gateway on the east
  for (const [x0, y0, x1, y1] of [[62, -46, 64, 46], [-30, 44, 64, 46], [-30, -46, 64, -44]]) box(x0, y0, -2, x1, y1, 7.5, STONE, LIGHT);
  for (let y = -40; y <= 40; y += 6) quad(P(61.9, y - 1.4, 1), P(61.9, y + 1.4, 1), P(61.9, y + 1.4, 5), P(61.9, y - 1.4, 5), DARK);
  for (let x = -24; x <= 58; x += 6) { quad(P(x - 1.4, 43.9, 1), P(x + 1.4, 43.9, 1), P(x + 1.4, 43.9, 5), P(x - 1.4, 43.9, 5), DARK); quad(P(x - 1.4, -43.9, 1), P(x + 1.4, -43.9, 1), P(x + 1.4, -43.9, 5), P(x - 1.4, -43.9, 5), DARK); }
  box(60, -6, -2, 66, 6, 14, STONE, LIGHT);
  quad(P(59.9, -2.2, 0.2), P(59.9, 2.2, 0.2), P(59.9, 2.2, 8), P(59.9, -2.2, 8), DARK);
  // the octagonal ablution tank (wazu khana)
  band(7, 0.1, 7, 1, 8, 0, 8, STONE); cap(7, 1, 8, 0, 8, STONE); band(6, 1, 6, 1.05, 8, 0, 8, WATER); cap(6, 1.05, 8, 0, 8, WATER);
  return done();
}

// ---- Falaknuma Palace (1893): a long white palace on its hill with arcaded galleries, a central portico under a clock tower, and hipped roofs.
function falaknuma(b) {
  const at = siteTile(b, SITES[4][0], SITES[4][1]); if (!at) return null;
  const [cx, cy] = at;
  const { P, quad, tri, box, pyr, band, cap, gpatch, done } = geoKit(cx, cy, meshHeight(cx, cy) - 0.4);
  const WHITE = [0.94, 0.91, 0.85], CREAM = [0.88, 0.83, 0.74], DARK = [0.2, 0.17, 0.14], ROOF = [0.34, 0.38, 0.38], LAWN = [0.15, 0.33, 0.1], STONE = [0.76, 0.72, 0.66];
  const L = 56, D = 15, F = 7;                                                           // the palace faces north: half length, half depth, floor height
  gpatch(-L - 8, -D - 60, L + 8, -D - 4, LAWN, 0.3, 10); gpatch(-8, -D - 60, 8, -D - 4, STONE, 0.36, 10);     // gardens in front with a central path
  box(-L, -D, -3, L, D, 3 * F, WHITE, [0.7, 0.66, 0.6]);
  box(-L - 0.6, -D - 0.6, 3 * F, L + 0.6, D + 0.6, 3 * F + 0.9, CREAM, CREAM);
  for (let f = 0; f < 3; f++) for (let x = -L + 3; x < L - 2; x += 4.2) {                  // arched gallery openings on the north face, three storeys
    if (Math.abs(x) < 11) continue;
    const h0 = 1.2 + f * F; quad(P(x - 1, -D - 0.06, h0), P(x + 1, -D - 0.06, h0), P(x + 1, -D - 0.06, h0 + 4), P(x - 1, -D - 0.06, h0 + 4), DARK);
    tri(P(x - 1, -D - 0.06, h0 + 4), P(x + 1, -D - 0.06, h0 + 4), P(x, -D - 0.06, h0 + 5.2), DARK);
  }
  // central block, portico and the clock tower
  box(-12, -D - 7, -3, 12, D, 3 * F + 5, WHITE, CREAM);
  for (let i = -2; i <= 2; i++) box(i * 4 - 0.5, -D - 7.2, 0, i * 4 + 0.5, -D - 6.2, 2 * F, CREAM);
  box(-8, -D - 3, 3 * F + 5, 8, D - 3, 3 * F + 15, WHITE, CREAM); pyr(-9.5, -D - 4.5, 9.5, D - 1.5, 3 * F + 15, 3 * F + 24, ROOF);
  quad(P(-3, -D - 3.06, 3 * F + 8), P(3, -D - 3.06, 3 * F + 8), P(3, -D - 3.06, 3 * F + 13), P(-3, -D - 3.06, 3 * F + 13), DARK);
  band(0.4, 3 * F + 24, 0.1, 3 * F + 30, 0, -D - 3, 6, [0.9, 0.72, 0.28]);
  // end pavilions with hipped roofs and chimneys
  for (const s of [-1, 1]) {
    box(s * (L - 9) - 9, -D - 3, -3, s * (L - 9) + 9, D + 2, 3 * F + 2, WHITE, CREAM); pyr(s * (L - 9) - 10.5, -D - 4.5, s * (L - 9) + 10.5, D + 3.5, 3 * F + 2, 3 * F + 9, ROOF);
    for (const k of [-1, 1]) box(s * (L - 9) + k * 5 - 0.7, -1, 3 * F + 2, s * (L - 9) + k * 5 + 0.7, 1, 3 * F + 8, STONE);
  }
  for (let x = -L + 6; x < L - 20; x += 14) if (Math.abs(x) > 20) pyr(x - 4, -D - 0.5, x + 4, D + 0.5, 3 * F + 0.9, 3 * F + 4.5, ROOF);
  return done();
}

// ---- Birla Mandir (1976): white marble temple on Kalabahad, a tall curving Utkala-style shikhara over the sanctum, a pillared mandapa
// in front, two smaller shrines at the sides, on a terrace with a flight of steps. It faces east.
function birla(b) {
  const at = siteTile(b, SITES[5][0], SITES[5][1]); if (!at) return null;
  const [cx, cy] = at;
  const { P, quad, tri, band, cap, box, pyr, done } = geoKit(cx, cy, meshHeight(cx, cy) - 0.4);
  const MARBLE = [0.96, 0.95, 0.91], STONE = [0.84, 0.82, 0.77], GOLD = [0.92, 0.72, 0.25], DARK = [0.25, 0.2, 0.17];
  box(-22, -22, -4, 40, 22, 2.6, STONE, MARBLE);                                         // terrace
  for (let i = 0; i < 6; i++) box(40 + i * 1.6, -9 + i * 0.9, -4, 41.6 + i * 1.6, 9 - i * 0.9, 2.2 - i * 0.4, STONE, MARBLE);   // steps down to the east
  const shikhara = (x, y, s0, tiers, th, h0, top) => {                                   // stacked tiers narrowing along a curve, ribbed
    let h = h0;
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1), s = s0 * (1 - 0.82 * Math.pow(t, 1.5)) / 2;
      box(x - s, y - s, h, x + s, y + s, h + th, MARBLE, MARBLE); box(x - s - 0.45, y - s - 0.45, h, x + s + 0.45, y + s + 0.45, h + 0.45, STONE, MARBLE);
      h += th;
    }
    const sT = s0 * 0.09 + 1.4; band(sT, h, sT + 0.5, h + 0.9, x, y, 12, STONE); band(sT + 0.5, h + 0.9, sT, h + 1.8, x, y, 12, STONE); cap(sT, h + 1.8, x, y, 12, MARBLE);   // amalaka disc
    band(0.55, h + 1.8, 0.1, h + 6, x, y, 6, GOLD);                                      // kalasha finial
    return h;
  };
  shikhara(-6, 0, 17, 12, 3.4, 2.6, 0);                                                    // the sanctum tower
  box(6, -10, 2.6, 24, 10, 11, MARBLE, STONE);                                             // mandapa (assembly hall)
  for (let i = -2; i <= 2; i++) box(24, i * 3.6 - 0.5, 2.6, 25, i * 3.6 + 0.5, 10, STONE, STONE);
  box(5, -11, 11, 26, 11, 12.2, STONE, MARBLE); pyr(6, -9, 24, 9, 12.2, 19, MARBLE); band(0.5, 19, 0.1, 23, 15, 0, 6, GOLD);
  for (const s of [-1, 1]) { shikhara(-4, s * 16, 8, 7, 2.5, 2.6, 0); box(-12, s * 11, 2.6, 0, s * 12, 7, MARBLE); }   // side shrines
  for (let i = 0; i < 5; i++) quad(P(24.08, -8 + i * 4, 3.2), P(24.08, -6.4 + i * 4, 3.2), P(24.08, -6.4 + i * 4, 8.4), P(24.08, -8 + i * 4, 8.4), DARK);
  void tri;
  return done();
}

// ---- Salar Jung Museum (1951): a long white two-storey building with arched window rows, a pillared central portico under a pediment,
// and a taller rear block. It faces north, towards the Musi river.
function salarJung(b) {
  const at = siteTile(b, SITES[6][0], SITES[6][1]); if (!at) return null;
  const [cx, cy] = at;
  const { P, quad, tri, box, pyr, gpatch, done } = geoKit(cx, cy, meshHeight(cx, cy) - 0.4);
  const WHITE = [0.93, 0.91, 0.85], CREAM = [0.86, 0.82, 0.72], DARK = [0.2, 0.17, 0.14], ROOF = [0.5, 0.42, 0.38], LAWN = [0.15, 0.33, 0.1], PATH = [0.78, 0.74, 0.68];
  const L = 80, D = 22, H = 15;
  gpatch(-L, D + 3, L, D + 46, LAWN, 0.3, 10); gpatch(-9, D + 3, 9, D + 46, PATH, 0.36, 10);
  box(-L, -D, -3, L, D, H, WHITE, ROOF); box(-L - 0.6, -D - 0.6, H, L + 0.6, D + 0.6, H + 1.1, CREAM, ROOF);
  for (const f of [0, 1]) for (let x = -L + 4; x < L - 3; x += 5) {                       // two storeys of arched windows on the north face
    if (Math.abs(x) < 20) continue;
    const h0 = 1.4 + f * 7; quad(P(x - 1, D + 0.06, h0), P(x + 1, D + 0.06, h0), P(x + 1, D + 0.06, h0 + 3.6), P(x - 1, D + 0.06, h0 + 3.6), DARK);
    tri(P(x - 1, D + 0.06, h0 + 3.6), P(x + 1, D + 0.06, h0 + 3.6), P(x, D + 0.06, h0 + 4.7), DARK);
  }
  box(-20, -D + 4, -3, 20, D + 8, H + 4, WHITE, ROOF);                                     // central block, a little taller and forward
  for (let i = -4; i <= 4; i++) box(i * 4.2 - 0.55, D + 8.2, 0, i * 4.2 + 0.55, D + 9.4, H + 1, CREAM);            // the columns of the portico
  box(-20.5, D + 7, H + 1, 20.5, D + 10, H + 2.4, CREAM, CREAM); pyr(-21, D + 6.5, 21, D + 10.5, H + 2.4, H + 7.5, WHITE, 0, D + 10.5);     // pediment
  box(-26, -D + 2, H, 26, D - 2, H + 9, WHITE, ROOF);                                       // taller block behind the portico
  for (const s of [-1, 1]) box(s * (L - 8) - 8, -D - 2, H, s * (L - 8) + 8, D + 2, H + 5, WHITE, ROOF);
  return done();
}

// ---- Chowmahalla Palace (1750-1869): two courtyards in a line with long pools and fountains, cream palaces with arched galleries along the
// sides, the Khilwat Mubarak durbar hall with its columned front at the north end, and the clock tower at the south gate.
function chowmahalla(b) {
  const at = siteTile(b, SITES[7][0], SITES[7][1]); if (!at) return null;
  const [cx, cy] = at;
  const { P, quad, tri, band, cap, box, pyr, gpatch, done } = geoKit(cx, cy, meshHeight(cx, cy) - 0.4);
  const CREAM = [0.9, 0.86, 0.76], WHITE = [0.95, 0.93, 0.88], DARK = [0.22, 0.18, 0.15], ROOF = [0.45, 0.38, 0.33], LAWN = [0.17, 0.36, 0.12], PATH = [0.8, 0.76, 0.7], WATER = [0.3, 0.55, 0.62], GOLD = [0.9, 0.72, 0.28];
  const W = 44;                                                                             // half width of the courts
  gpatch(-W, -100, W, 100, PATH, 0.15, 12);                                                 // paved courts
  for (const [y0, y1] of [[-95, -18], [18, 95]]) {
    gpatch(-W + 8, y0, -6, y1, LAWN, 0.35, 10); gpatch(6, y0, W - 8, y1, LAWN, 0.35, 10);
    box(-3, y0 + 8, 0.1, 3, y1 - 8, 0.7, [0.7, 0.68, 0.64], [0.7, 0.68, 0.64]); gpatch(-2.2, y0 + 9, 2.2, y1 - 9, WATER, 0.75, 10);     // long reflecting pool
  }
  // two-storey palaces down the east and west sides of both courts, with arched galleries facing the court
  for (const [y0, y1] of [[-100, -14], [14, 100]]) for (const s of [-1, 1]) {
    const xi = s * W, xo = s * (W + 14);
    box(Math.min(xi, xo), y0, -3, Math.max(xi, xo), y1, 13, CREAM, ROOF); box(Math.min(xi, xo) - 0.4 * s, y0 - 0.4, 13, Math.max(xi, xo) + 0.4 * s, y1 + 0.4, 14.2, WHITE, ROOF);
    for (let y = y0 + 4; y < y1 - 3; y += 5) for (const h0 of [1.2, 7.4]) { const xf = xi - s * 0.06; quad(P(xf, y - 1, h0), P(xf, y + 1, h0), P(xf, y + 1, h0 + 3.8), P(xf, y - 1, h0 + 3.8), DARK); tri(P(xf, y - 1, h0 + 3.8), P(xf, y + 1, h0 + 3.8), P(xf, y, h0 + 4.9), DARK); }
    for (const yy of [y0 + 12, (y0 + y1) / 2, y1 - 12]) pyr(Math.min(xi, xo) + 1, yy - 6, Math.max(xi, xo) - 1, yy + 6, 14.2, 19, ROOF);    // hipped roof pavilions
  }
  // Khilwat Mubarak, the durbar hall, closing the north court: a long hall with a columned front and corner domes
  box(-W - 14, 96, -3, W + 14, 118, 17, CREAM, ROOF); box(-W - 14.6, 95.4, 17, W + 14.6, 118.6, 18.4, WHITE, ROOF);
  for (let i = -9; i <= 9; i++) { const x = i * 4.6; box(x - 0.6, 94.6, 0, x + 0.6, 95.8, 14, WHITE, WHITE); quad(P(x + 0.9, 95.94, 1), P(x + 3.7, 95.94, 1), P(x + 3.7, 95.94, 11), P(x + 0.9, 95.94, 11), DARK); }
  box(-14, 94, 14, 14, 99, 21, WHITE, ROOF); pyr(-15, 93.4, 15, 99.6, 21, 29, WHITE);
  for (const s of [-1, 1]) { const x = s * (W + 6), N = 12, rr = [5.2, 5.3, 4.4, 3, 1.5, 0.4], hh = [18.4, 19.6, 21, 22.4, 23.4, 24];
    band(5.2, 18.4, 5.2, 19, x, 107, N, WHITE); for (let i = 0; i < rr.length - 1; i++) band(rr[i], hh[i], rr[i + 1], hh[i + 1], x, 107, N, WHITE); band(0.3, 24, 0.05, 28, x, 107, 6, GOLD); }
  // the Khilwat clock tower and the southern gate
  box(-4, -108, -3, 4, -100, 28, CREAM, WHITE); pyr(-4.8, -108.8, 4.8, -99.2, 28, 36, ROOF);
  const clock = (y, sy) => { const A = []; for (let i = 0; i < 12; i++) A.push(P(Math.cos(i / 12 * Math.PI * 2) * 2.2, y + sy * 0.05, 22 + Math.sin(i / 12 * Math.PI * 2) * 2.2)); for (let i = 0; i < 12; i++) tri(A[i], A[(i + 1) % 12], P(0, y + sy * 0.05, 22), WHITE); };
  clock(-100, 1); clock(-108, -1);
  box(-4, -118, -3, 4, -108, 14, CREAM, ROOF); box(-1.8, -118.1, -3, 1.8, -107.9, 9, DARK, DARK);
  box(-W - 14, -118, -3, -4, -108, 12, CREAM, ROOF); box(4, -118, -3, W + 14, -108, 12, CREAM, ROOF);    // gate wings
  void cap;
  return done();
}

// ---- Golconda Fort (16th century): the crenellated inner-fort wall with round bastions, and the Bala Hissar citadel stepped up its granite hill.
// The wall line is an approximation of the real one; it follows the terrain.
const GOLCONDA = [17.3833, 78.4011];
const GOLCONDA_WALL = [[-420, 40], [-370, 250], [-120, 370], [190, 390], [420, 220], [455, -90], [290, -320], [-40, -390], [-320, -280]];
function golconda(b) {
  const [cx, cy] = lonLatToLocal(frame, GOLCONDA[1], GOLCONDA[0]);
  const inT = (x, y) => x >= b.x0 && x < b.x0 + b.size && y <= b.y1 && y > b.y1 - b.size;
  const { P, box, band, cap, pyr, obx, done } = geoKit(cx, cy, 0);
  const WALL = [0.6, 0.56, 0.5], TOP = [0.5, 0.46, 0.42], LIGHT = [0.72, 0.66, 0.56], DOME = [0.74, 0.7, 0.62];
  const gh = (x, y) => meshHeight(cx + x, cy + y);
  let any = false;
  const N = GOLCONDA_WALL.length;
  for (let i = 0; i < N; i++) {
    const [ax, ay] = GOLCONDA_WALL[i], [bx, by] = GOLCONDA_WALL[(i + 1) % N], len = Math.hypot(bx - ax, by - ay), dx = (bx - ax) / len, dy = (by - ay) / len, steps = Math.max(1, Math.round(len / 9));
    for (let s = 0; s < steps; s++) {
      const x0 = ax + dx * len * s / steps, y0 = ay + dy * len * s / steps, x1 = ax + dx * len * (s + 1) / steps, y1 = ay + dy * len * (s + 1) / steps, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      if (!inT(cx + mx, cy + my)) continue;
      any = true; const sl = Math.hypot(x1 - x0, y1 - y0), g = Math.min(gh(x0, y0), gh(x1, y1), gh(mx, my)) - 1.2;
      obx(mx, my, g, dx, dy, sl + 0.2, 3.2, 12, WALL, TOP);                                   // wall segment standing on the lowest ground of its span
      for (const q of [0.25, 0.75]) obx(x0 + (x1 - x0) * q, y0 + (y1 - y0) * q, g + 12, dx, dy, 2.2, 1.4, 1.5, LIGHT);   // merlons
    }
    for (let k = 0; k * 45 < len; k++) {                                                     // round bastions every 45 m, and at every corner
      const bxp = ax + dx * Math.min(len, k * 45), byp = ay + dy * Math.min(len, k * 45);
      if (!inT(cx + bxp, cy + byp)) continue;
      any = true; const g = gh(bxp, byp) - 1.5, N8 = 9;
      band(5.2, g, 4.8, g + 16, bxp, byp, N8, WALL); band(5.8, g + 16, 5.8, g + 17.4, bxp, byp, N8, LIGHT); cap(5.8, g + 17.4, bxp, byp, N8, TOP);
    }
  }
  // the citadel: three stepped terraces on the hilltop, a pavilion and a small dome
  if (inT(cx, cy)) {
    any = true; const g = gh(0, 0) - 2;
    box(-24, -17, g, 24, 17, g + 14, WALL, TOP); box(-17, -12, g + 14, 17, 12, g + 24, LIGHT, TOP); box(-9, -7, g + 24, 9, 7, g + 31, LIGHT, TOP);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) band(2.2, g + 14, 2.0, g + 21, sx * 15, sy * 10, 8, DOME);
    const rr = [4.2, 4.3, 3.6, 2.4, 1.2, 0.3], hh = [31, 32, 33.2, 34.4, 35.3, 35.8]; for (let i = 0; i < rr.length - 1; i++) band(rr[i], g + hh[i], rr[i + 1], g + hh[i + 1], 0, 0, 10, DOME);
    box(-0.2, -0.2, g + 36, 0.2, 0.2, g + 42, [0.8, 0.4, 0.15]);                                // flag pole
  }
  return any ? done() : null;
}

// ---- Dr. B.R. Ambedkar Telangana State Secretariat (2023): a long white block with a red plinth, towers topped with domes at the
// corners and along the front, and a tall central tower carrying the big dome; two lawns and a gateway in front of it.
// It is sized from the mapped footprint (its long side is the facade; the front faces the lawns, towards the east).
let secFoot = null;
const SEC_PIN = [17.4104, 78.4693];
function captureSecretariat(pts) {                       // pts: flat local x,y ring; true when this ring is the Secretariat
  const [px, py] = lonLatToLocal(frame, SEC_PIN[1], SEC_PIN[0]);
  const n = pts.length / 2; let mx = 0, my = 0;
  for (let k = 0; k < n; k++) { mx += pts[k * 2]; my += pts[k * 2 + 1]; }
  mx /= n; my /= n;
  if (Math.hypot(mx - px, my - py) > 170) return false;
  let bl = 0, bx = 1, by = 0;                               // direction of the longest edge
  for (let k = 0; k < n; k++) { const j = (k + 1) % n, dx = pts[j * 2] - pts[k * 2], dy = pts[j * 2 + 1] - pts[k * 2 + 1], l = Math.hypot(dx, dy); if (l > bl) { bl = l; bx = dx / l; by = dy / l; } }
  let u0 = 1e9, u1 = -1e9, w0 = 1e9, w1 = -1e9;
  for (let k = 0; k < n; k++) { const u = pts[k * 2] * bx + pts[k * 2 + 1] * by, w = -pts[k * 2] * by + pts[k * 2 + 1] * bx; u0 = Math.min(u0, u); u1 = Math.max(u1, u); w0 = Math.min(w0, w); w1 = Math.max(w1, w); }
  let ux = bx, uy = by, L = u1 - u0, D = w1 - w0, cu = (u0 + u1) / 2, cw = (w0 + w1) / 2;
  if (D > L) { [L, D] = [D, L]; [ux, uy] = [-by, bx]; [cu, cw] = [cw, -cu]; }            // make u the long axis
  // front direction: the perpendicular that points more towards the east
  let wx = -uy, wy = ux; if (wx * 1 + wy * 0.2 < 0) { wx = -wx; wy = -wy; }
  const cx = cu * bx + cw * -by, cy = cu * by + cw * bx;                                       // centre in local metres
  secFoot = { cx: (u0 + u1) / 2 * bx - (w0 + w1) / 2 * by, cy: (u0 + u1) / 2 * by + (w0 + w1) / 2 * bx, L: Math.max(L, 60), D: Math.max(D, 40), ux, uy, wx, wy };
  void cx; void cy;
  return true;
}
function preSecretariat(vt, b) {                          // read the Secretariat footprint early, so the lawns can be kept free of trees
  const l = vt && vt.layers.building; if (!l || secFoot) return;
  const sc = b.size / l.extent;
  for (let i = 0; i < l.length; i++) {
    const f = l.feature(i); if (f.type !== 3) continue;
    for (const poly of classifyRings(f.loadGeometry())) {
      const ring = poly[0]; if (!ring || ring.length < 4) continue;
      let a2 = 0; for (let k = 0; k < ring.length - 1; k++) a2 += ring[k].x * ring[k + 1].y - ring[k + 1].x * ring[k].y;
      if (Math.abs(a2) / 2 * sc * sc < 2500) continue;
      const pts = []; for (let k = 0; k < ring.length - 1; k++) pts.push(b.x0 + ring[k].x * sc, b.y1 - ring[k].y * sc);
      if (captureSecretariat(pts)) return;
    }
  }
}
const inSecLawn = (x, y) => {
  if (!secFoot) {                                          // before the footprint has been read: a disc around the lawns east of the pin
    const [px, py] = lonLatToLocal(frame, SEC_PIN[1], SEC_PIN[0]);
    return Math.hypot(x - (px + 45), y - (py - 20)) < 110;
  }
  const dx = x - secFoot.cx, dy = y - secFoot.cy, u = dx * secFoot.ux + dy * secFoot.uy, w = dx * secFoot.wx + dy * secFoot.wy;
  return Math.abs(u) < secFoot.L / 2 + 12 && w > -secFoot.D / 2 - 12 && w < secFoot.D / 2 + 100;
};
function secretariat(b) {
  const F = secFoot; if (!F) return null;
  const { cx, cy, L, D, ux, uy, wx, wy } = F;
  if (!(cx >= b.x0 && cx < b.x0 + b.size && cy <= b.y1 && cy > b.y1 - b.size)) return null;
  const g0 = meshHeight(cx, cy) - 0.3;
  const { P, tri, quad, band, done } = geoKit(cx, cy, g0);
  const U = (u, w, h) => P(u * ux + w * wx, u * uy + w * wy, h);
  const Q = (a, b2, c2, d, c) => quad(U(...a), U(...b2), U(...c2), U(...d), c);
  const WHITE = [0.93, 0.92, 0.89], GREYW = [0.86, 0.85, 0.82], RED = [0.62, 0.31, 0.26], ROOF = [0.7, 0.3, 0.25], WIN = [0.2, 0.28, 0.4], GLASS = [0.34, 0.58, 0.84], DOME = [0.92, 0.92, 0.9], GOLD = [0.9, 0.7, 0.25], LAWN = [0.2, 0.42, 0.13], PATH = [0.8, 0.76, 0.7];
  const ob = (u0, w0, h0, u1, w1, h1, c, cTop) => {              // box aligned with the building
    Q([u0, w0, h0], [u1, w0, h0], [u1, w0, h1], [u0, w0, h1], c); Q([u1, w0, h0], [u1, w1, h0], [u1, w1, h1], [u1, w0, h1], c);
    Q([u1, w1, h0], [u0, w1, h0], [u0, w1, h1], [u1, w1, h1], c); Q([u0, w1, h0], [u0, w0, h0], [u0, w0, h1], [u0, w1, h1], c);
    Q([u0, w0, h1], [u1, w0, h1], [u1, w1, h1], [u0, w1, h1], cTop || c);
  };
  const dome = (u, w, h0, r) => {                                   // drum, bulb dome and finial
    const x = u * ux + w * wx, y = u * uy + w * wy, N = 14;
    band(r * 0.95, h0, r * 0.95, h0 + r * 0.35, x, y, N, GREYW);
    band(r * 1.05, h0 + r * 0.35, r * 1.05, h0 + r * 0.5, x, y, N, WHITE);
    const rr = [1, 0.97, 0.88, 0.72, 0.5, 0.26, 0.07], hh = [0, 0.2, 0.42, 0.62, 0.8, 0.93, 1];
    for (let i = 0; i < rr.length - 1; i++) band(r * rr[i], h0 + r * 0.5 + r * hh[i] * 0.95, r * rr[i + 1], h0 + r * 0.5 + r * hh[i + 1] * 0.95, x, y, N, DOME);
    band(0.35, h0 + r * 1.45, 0.05, h0 + r * 1.45 + r * 0.5, x, y, 6, GOLD);
  };
  const HW = L / 2, HD = D / 2, FLOOR = 4.2, WALL = 29.4;
  // plinth and main slab
  ob(-HW - 0.5, -HD - 0.5, -4, HW + 0.5, HD + 0.5, 4.4, RED, RED);                    // the plinth goes below ground so it never floats on a slope
  ob(-HW, -HD, 4.4, HW, HD, WALL, WHITE, WHITE);
  ob(-HW - 0.4, -HD - 0.4, WALL, HW + 0.4, HD + 0.4, WALL + 1.2, ROOF, [0.5, 0.36, 0.3]);        // red roof trim, brown roof deck
  // corner towers, towers along the front and a pair at the back
  const towers = [];
  for (const su of [-1, 1]) for (const sw of [-1, 1]) towers.push([su * (HW - 6.5), sw * (HD - 6.5), 6.6, 36, 5.4]);
  for (const su of [-1, 1]) for (const k of [0.3, 0.62]) { towers.push([su * HW * k, HD, 5, 33, 4]); }
  for (const [u, w, hs, h, r] of towers) { ob(u - hs - 0.5, w - hs - 0.5, 4.4, u + hs + 0.5, w + hs + 0.5, h, GREYW, WHITE); dome(u, w, h, r); }
  // central tower: portico, glass-arched block, second stage, drum and the big dome with four small ones
  ob(-14, HD - 26, WALL, 14, HD + 5, 44, WHITE, WHITE);
  ob(-9.5, HD - 20, 44, 9.5, HD - 4, 56, WHITE, WHITE);
  ob(-10.3, HD - 20.8, 55, 10.3, HD - 3.2, 56.8, GREYW, WHITE);
  dome(0, HD - 12, 56.8, 10.5);
  for (const su of [-1, 1]) for (const wo of [HD - 3.5, HD - 24]) dome(su * 12, wo, 44, 3.1);
  Q([-4.6, HD + 5.08, 33], [4.6, HD + 5.08, 33], [4.6, HD + 5.08, 41], [-4.6, HD + 5.08, 41], GLASS);                 // great glass arch
  for (let i = 0; i < 10; i++) { const a0 = Math.PI * i / 10, a1 = Math.PI * (i + 1) / 10; tri(U(Math.cos(a0) * 4.6, HD + 5.08, 41 + Math.sin(a0) * 3.5), U(Math.cos(a1) * 4.6, HD + 5.08, 41 + Math.sin(a1) * 3.5), U(0, HD + 5.08, 41), GLASS); }
  for (const u of [-9, 9]) Q([u - 1.2, HD + 5.08, 31], [u + 1.2, HD + 5.08, 31], [u + 1.2, HD + 5.08, 42], [u - 1.2, HD + 5.08, 42], WIN);
  // front portico and steps
  for (let i = -3; i <= 3; i++) ob(i * 4 - 0.6, HD + 5.5, 0, i * 4 + 0.6, HD + 6.7, 8, WHITE, WHITE);
  ob(-14, HD + 4, 8, 14, HD + 7.6, 9.2, GREYW, WHITE);
  ob(-13, HD + 7.6, 0, 13, HD + 10.2, 0.8, PATH, PATH); ob(-12, HD + 10.2, 0, 12, HD + 12.6, 0.4, PATH, PATH);
  // window rows: six storeys on the front, back and both ends, left out where a tower stands
  const rows = 6, bay = 3.3, blocked = (u, w, face) => {
    if (face === 'f') { if (Math.abs(u) < 15) return true; for (const [tu, tw, hs] of towers) if (Math.abs(tw - HD) < 0.5 && Math.abs(u - tu) < hs + 2) return true; }
    for (const [tu, tw, hs] of towers) if (Math.abs(u - tu) < hs + 1.6 && Math.abs(w - tw) < hs + 6) return true;
    return false;
  };
  for (let r = 0; r < rows; r++) {
    const h0 = 5.3 + r * FLOOR;
    for (let u = -HW + 3; u < HW - 2; u += bay) {
      if (!blocked(u, HD, 'f')) Q([u - 0.8, HD + 0.06, h0], [u + 0.8, HD + 0.06, h0], [u + 0.8, HD + 0.06, h0 + 2.3], [u - 0.8, HD + 0.06, h0 + 2.3], WIN);
      if (!blocked(u, -HD, 'b')) Q([u - 0.8, -HD - 0.06, h0], [u + 0.8, -HD - 0.06, h0], [u + 0.8, -HD - 0.06, h0 + 2.3], [u - 0.8, -HD - 0.06, h0 + 2.3], WIN);
    }
    for (let w = -HD + 4; w < HD - 3; w += bay) for (const su of [-1, 1]) { const u = su * (HW + 0.06); if (Math.abs(w) < HD - 14) Q([u, w - 0.8, h0], [u, w + 0.8, h0], [u, w + 0.8, h0 + 2.3], [u, w - 0.8, h0 + 2.3], WIN); }
  }
  // two lawns with a central path and round pools, and the entrance gateway at the end of the path
  const W0 = HD + 14, W1 = HD + 78;
  const patch = (u0, w0, u1, w1, c, lift) => {                      // ground-hugging patch: every 8 m follows the terrain
    const nu = Math.max(1, Math.round((u1 - u0) / 8)), nw = Math.max(1, Math.round((w1 - w0) / 8));
    const at = (u, w) => U(u, w, meshHeight(cx + u * ux + w * wx, cy + u * uy + w * wy) - g0 + lift);
    for (let i = 0; i < nu; i++) for (let j = 0; j < nw; j++) {
      const a = u0 + (u1 - u0) * i / nu, b2 = u0 + (u1 - u0) * (i + 1) / nu, c0 = w0 + (w1 - w0) * j / nw, d = w0 + (w1 - w0) * (j + 1) / nw;
      quad(at(a, c0), at(b2, c0), at(b2, d), at(a, d), c);
    }
  };
  patch(-HW + 6, W0, -9, W1, LAWN, 0.35); patch(9, W0, HW - 6, W1, LAWN, 0.35);
  patch(-9, W0, 9, W1, PATH, 0.4);
  for (const su of [-1, 1]) { const x = su * 45 * 0.9 * Math.min(1, HW / 70) * 1, y = HD + 44; band(4.2, 0.2, 4.2, 0.6, x * ux + y * wx, x * uy + y * wy, 14, [0.3, 0.62, 0.72]); }
  for (const su of [-1, 1]) ob(su * 8 - 1.3, W1 + 4, 0, su * 8 + 1.3, W1 + 6.6, 9, WHITE, WHITE);
  ob(-9.6, W1 + 4, 9, 9.6, W1 + 6.6, 11, GREYW, WHITE);
  return done();
}

// ---- Hussain Sagar: the stone platform in the lake, its chequered lawn, the three-tier pedestal with carved panels,
// the lotus base and the 17.5 m standing Buddha (1992), robe folds, raised right hand.
function buddha(b) {
  const at = siteTile(b, SITES[1][0], SITES[1][1]);
  if (!at) return null;
  const [cx, cy] = at;
  const g0 = meshHeight(cx, cy) - 0.4;
  const { P, tri, quad, ring, band, cap, box, done } = geoKit(cx, cy, g0);
  const WALL = [0.66, 0.64, 0.6], PAVE = [0.74, 0.72, 0.68], LAWN = [0.34, 0.5, 0.24], GREY = [0.78, 0.77, 0.74], PANEL = [0.55, 0.53, 0.5], STONE = [0.88, 0.87, 0.84], BLUE = [0.5, 0.74, 0.82];
  const PL = 2.4;                                                        // platform height above the water
  // platform (long side east-west, the statue near the east end), parapet around the edge
  const X0 = -50, X1 = 16, Y0 = -19, Y1 = 19;
  box(X0, Y0, -2, X1, Y1, PL, WALL, PAVE);
  const PAR = 0.9;
  box(X0, Y0, PL, X1, Y0 + 0.6, PL + PAR, WALL); box(X0, Y1 - 0.6, PL, X1, Y1, PL + PAR, WALL); box(X0, Y0, PL, X0 + 0.6, Y1, PL + PAR, WALL); box(X1 - 0.6, Y0, PL, X1, Y1, PL + PAR, WALL);
  // chequered lawn to the west of the statue
  for (let i = 0; i < 8; i++) for (let j = 0; j < 6; j++) {
    const x = -42 + i * 3.6, y = -10.8 + j * 3.6, c = (i + j) % 2 ? LAWN : PAVE;
    quad(P(x, y, PL + 0.04), P(x + 3.6, y, PL + 0.04), P(x + 3.6, y + 3.6, PL + 0.04), P(x, y + 3.6, PL + 0.04), c);
  }
  // blue fountain pool in front of the pedestal
  box(-18, -3.2, PL, -9, 3.2, PL + 0.5, BLUE, [0.3, 0.62, 0.74]);
  // the boarding jetty and a boat at the west end
  box(X0 - 12, -6, 0.4, X0, 6, 1.6, [0.62, 0.5, 0.38]);
  box(X0 - 11, -4.5, 1.6, X0 - 3, 4.5, 4.4, [0.92, 0.9, 0.84], [0.82, 0.78, 0.7]);
  // pedestal: three tiers with a carved frieze, then the lotus base
  const T = [[8.2, PL, PL + 3.2, WALL], [6.8, PL + 3.2, PL + 5.7, STONE], [7.4, PL + 5.7, PL + 6.4, GREY]];
  for (const [h, a, z, c] of T) box(-h, -h, a, h, h, z, c, GREY);
  for (const [sx, sy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {            // relief panels on each face of the middle tier
    const tx = sy === 0 ? 0 : 1, ty = sy === 0 ? 1 : 0, d = 6.86;
    for (let i = -2; i <= 2; i++) { const u = i * 2.4; quad(P(sx * d + tx * (u - 0.9), sy * d + ty * (u - 0.9) * (sy === 0 ? 1 : 1), PL + 3.6), P(sx * d + tx * (u + 0.9), sy * d + ty * (u + 0.9), PL + 3.6), P(sx * d + tx * (u + 0.9), sy * d + ty * (u + 0.9), PL + 5.3), P(sx * d + tx * (u - 0.9), sy * d + ty * (u - 0.9), PL + 5.3), PANEL); }
  }
  const LB = PL + 6.4;
  band(6.6, LB, 6.9, LB + 0.5, 0, 0, 16, GREY); band(6.9, LB + 0.5, 5.6, LB + 1.5, 0, 0, 16, STONE); cap(5.6, LB + 1.5, 0, 0, 16, STONE);   // scalloped lotus base
  const SB = LB + 1.5;
  // the figure: lathe of the robe (elliptical, with fold bands), shoulders, neck, head, topknot
  const prof = [[0, 2.5, 1.7], [3.5, 2.3, 1.55], [8, 2.1, 1.45], [11.5, 2.1, 1.4], [12.6, 2.5, 1.45], [13.4, 1.4, 1.0], [13.9, 0.55, 0.55]];
  const N = 18;
  for (let s = 0; s < prof.length - 1; s++) {
    const [h0, rx0, ry0] = prof[s], [h1, rx1, ry1] = prof[s + 1];
    const A = ring(0, 0, rx0, SB + h0, N, 0.1, ry0), B2 = ring(0, 0, rx1, SB + h1, N, 0.1, ry1);
    for (let i = 0; i < N; i++) quad(A[i], A[(i + 1) % N], B2[(i + 1) % N], B2[i], i % 2 ? [0.9, 0.89, 0.86] : [0.8, 0.79, 0.75]);   // alternating strips read as drapery folds
  }
  const head = (r, h, ry) => ring(0, -0.05, r, SB + h, 12, 0, ry);
  const HP = [[13.9, 0.5, 0.5], [14.4, 0.85, 0.8], [15.2, 1.0, 0.92], [16.0, 0.9, 0.85], [16.6, 0.45, 0.4], [17.0, 0.15, 0.15]];
  for (let s = 0; s < HP.length - 1; s++) { const A = head(HP[s][1], HP[s][0], HP[s][2]), B2 = head(HP[s + 1][1], HP[s + 1][0], HP[s + 1][2]); for (let i = 0; i < 12; i++) quad(A[i], A[(i + 1) % 12], B2[(i + 1) % 12], B2[i], [0.86, 0.85, 0.82]); }
  // raised right hand (viewer's left) and the left hand at the chest
  box(-3.9, -0.7, SB + 9.6, -2.9, 0.5, SB + 13.0, [0.84, 0.83, 0.8]);            // forearm
  box(-4.2, -0.6, SB + 13.0, -2.7, 0.4, SB + 14.8, [0.86, 0.85, 0.82]);           // open palm
  box(-2.0, -1.7, SB + 11.0, -0.4, -0.8, SB + 12.4, [0.84, 0.83, 0.8]);          // other hand held at the chest
  return done();
}

// ------------------------------------------------------------------ roads, metro, labels
const TRAFFIC = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4 };
function lines(ofm, b, z14) {
  const out = { roads: [], metro: [], labels: [] };
  if (!ofm) return out;
  const tr = ofm.layers.transportation;
  if (tr) {
    const sc = b.size / tr.extent;
    for (let i = 0; i < tr.length; i++) {
      const f = tr.feature(i), p = f.properties;
      if (f.type !== 2 || p.brunnel === 'tunnel') continue;
      if (p.brunnel === 'bridge' && z14 && TRAFFIC[p.class] !== undefined) { let L2 = 0; for (const g of f.loadGeometry()) for (let q = 1; q < g.length; q++) L2 += Math.hypot(g[q].x - g[q - 1].x, g[q].y - g[q - 1].y) * sc; if (bridgeRise(L2) >= 0.8) continue; }
      const isMetro = p.class === 'transit' && ['subway', 'light_rail', 'monorail'].includes(p.subclass);
      const cls = TRAFFIC[p.class];
      if (cls === undefined && !isMetro) continue;
      for (const g of f.loadGeometry()) {
        if (g.length < 2) continue;
        const pts = new Float32Array(g.length * 2);
        g.forEach((pt, q) => { pts[q * 2] = b.x0 + pt.x * sc; pts[q * 2 + 1] = b.y1 - pt.y * sc; });
        (isMetro ? out.metro : out.roads).push({ cls: isMetro ? 0 : cls, pts });
      }
    }
  }
  const KIND = { city: ['town', 5], town: ['town', 4], suburb: ['ward', 3], quarter: ['hood', 2], neighbourhood: ['hood', 1] };
  for (const [layer, kindOf] of [['place', (p) => KIND[p.class]], ['water_name', () => ['water', 2]]]) {
    const l = ofm.layers[layer]; if (!l) continue;
    const sc = b.size / l.extent;
    for (let i = 0; i < l.length; i++) {
      const f = l.feature(i), p = f.properties, kind = kindOf(p);
      const name = p.name_en || p['name:en'] || p['name:latin'] || p.name;
      if (!kind || !name || f.type !== 1) continue;
      const pt = f.loadGeometry()[0][0];
      if (pt.x < 0 || pt.y < 0 || pt.x > l.extent || pt.y > l.extent) continue;
      const x = b.x0 + pt.x * sc, y = b.y1 - pt.y * sc;
      out.labels.push({ n: name, x, y, k: kind[0], r: kind[1], h: height(x, y) });
    }
  }
  return out;
}

function ribbons(list, width, lift) {
  let nv = 0, ni = 0;
  for (const l of list) { const c = l.pts.length / 2; nv += c * 2; ni += (c - 1) * 6; }
  if (!nv) return null;
  const pos = new Float32Array(nv * 3), idx = new Uint32Array(ni), piers = [];
  let v = 0, k = 0;
  for (const l of list) {
    const P = l.pts, c = P.length / 2;
    let acc = 0;
    for (let i = 0; i < c; i++) {
      const a = Math.max(0, i - 1), bb = Math.min(c - 1, i + 1);
      let tx = P[bb * 2] - P[a * 2], ty = P[bb * 2 + 1] - P[a * 2 + 1];
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const x = P[i * 2], y = P[i * 2 + 1], g = height(x, y) + lift;
      pos.set([x - ty * width / 2, g, -(y + tx * width / 2), x + ty * width / 2, g, -(y - tx * width / 2)], v * 3); v += 2;
      if (i < c - 1) {
        idx.set([v - 2, v - 1, v, v - 1, v + 1, v], k); k += 6;
        const sl = Math.hypot(P[i * 2 + 2] - x, P[i * 2 + 3] - y);
        for (let s = 35 - acc; s < sl; s += 35) { const t = s / sl; const px = x + (P[i * 2 + 2] - x) * t, py = y + (P[i * 2 + 3] - y) * t; piers.push(px, height(px, py), -py); }
        acc = (acc + sl) % 35;
      }
    }
  }
  return { pos, idx, piers: new Float32Array(piers) };
}

// ---- Hyderabad Metro: an elevated box-girder viaduct (trapezoid section with side parapets) carried on single piers with hammerhead caps.
const METRO_TOP = 11.5;                               // rail level above the ground, metres
// U-shaped trough girder: vertical parapets, sloping sides to a flatter underside, and two low plinths for the rails on the floor (across the track, height)
const METRO_SECTION = [[-4.5, 1.0], [-4.5, -0.15], [-3.45, -2.3], [3.45, -2.3], [4.5, -0.15], [4.5, 1.0], [4.25, 1.0], [4.25, 0.1], [1.95, 0.1], [1.95, 0.27], [1.45, 0.27], [1.45, 0.1],
  [-1.45, 0.1], [-1.45, 0.27], [-1.95, 0.27], [-1.95, 0.1], [-4.25, 0.1], [-4.25, 1.0]];
function metroViaduct(list, spots) {
  const S = METRO_SECTION, ns = S.length, piers = [], parts = [], tracks = [];
  let nv = 0, ni = 0;
  for (const l of list) {
    const P0 = l.pts, c0 = P0.length / 2, pts = [];
    for (let i = 0; i < c0; i++) {                    // subdivide so the deck can follow the ground
      if (i) { const px = pts[pts.length - 2], py = pts[pts.length - 1], d = Math.hypot(P0[i * 2] - px, P0[i * 2 + 1] - py), n = Math.floor(d / 24); for (let s = 1; s <= n; s++) pts.push(px + (P0[i * 2] - px) * s / (n + 1), py + (P0[i * 2 + 1] - py) * s / (n + 1)); }
      pts.push(P0[i * 2], P0[i * 2 + 1]);
    }
    const c = pts.length / 2; if (c < 2) continue;
    const raw = new Float32Array(c), hs = new Float32Array(c);
    for (let i = 0; i < c; i++) raw[i] = height(pts[i * 2], pts[i * 2 + 1]);
    for (let i = 0; i < c; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - 3); j <= Math.min(c - 1, i + 3); j++) { s += raw[j]; n++; } hs[i] = s / n + METRO_TOP; }   // a viaduct is smoother than the ground
    parts.push({ pts, hs, c }); nv += c * ns; ni += (c - 1) * ns * 6;
    // for the trains: the line, the rail height along it, and where each station stop is (distance along the line)
    const cum = new Float32Array(c), stops = [];
    for (let i = 1; i < c; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
    for (const sp of spots || []) {
      let best = 14, at = -1;
      for (let i = 0; i < c - 1; i++) {
        const ax = pts[i * 2], ay = pts[i * 2 + 1], dx = pts[i * 2 + 2] - ax, dy = pts[i * 2 + 3] - ay, L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((sp[0] - ax) * dx + (sp[1] - ay) * dy) / L2)), d = Math.hypot(ax + dx * t - sp[0], ay + dy * t - sp[1]);
        if (d < best) { best = d; at = cum[i] + Math.sqrt(L2) * t; }
      }
      if (at >= 0) stops.push(at);
    }
    tracks.push({ pts: Float32Array.from(pts), hs, cum, stops: Float32Array.from(stops) });
  }
  if (!nv) return null;
  const pos = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  let v = 0, k = 0;
  for (const { pts, hs, c } of parts) {
    const base = v;
    for (let i = 0; i < c; i++) {
      const a = Math.max(0, i - 1), bb = Math.min(c - 1, i + 1);
      let tx = pts[bb * 2] - pts[a * 2], ty = pts[bb * 2 + 1] - pts[a * 2 + 1];
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const x = pts[i * 2], y = pts[i * 2 + 1];
      for (const [u, h] of S) { pos[v * 3] = x - ty * u; pos[v * 3 + 1] = hs[i] + h; pos[v * 3 + 2] = -(y + tx * u); v++; }
      if (i < c - 1) for (let j = 0; j < ns; j++) {
        const a0 = base + i * ns + j, a1 = base + i * ns + (j + 1) % ns, b0 = a0 + ns, b1 = a1 + ns;
        idx.set([a0, a1, b0, a1, b1, b0], k); k += 6;
      }
    }
    let acc = 0;                                      // a pier every 30 m along the line
    for (let i = 0; i < c - 1; i++) {
      const x = pts[i * 2], y = pts[i * 2 + 1], sl = Math.hypot(pts[i * 2 + 2] - x, pts[i * 2 + 3] - y); if (!sl) continue;
      const tx = (pts[i * 2 + 2] - x) / sl, ty = (pts[i * 2 + 3] - y) / sl, th = Math.atan2(tx, -ty);
      for (let s = 30 - acc; s < sl; s += 30) {
        const q = s / sl, px = x + tx * s, py = y + ty * s, top = hs[i] + (hs[i + 1] - hs[i]) * q - 2.3;
        piers.push(px, height(px, py), -py, th, top);
      }
      acc = (acc + sl) % 30;
    }
  }
  return { pos, idx, piers: new Float32Array(piers), tracks };
}

// A metro station straddling the viaduct: columns, a glazed concourse, a platform level, an arched roof on slim columns, stairs up from the street.
function metroStation(cx, cy, dx, dy) {
  const g0 = height(cx, cy), { P, quad, tri, obx, done } = geoKit(cx, cy, g0);
  const CONC = [0.74, 0.73, 0.7], CONC2 = [0.84, 0.83, 0.8], GLASS = [0.42, 0.6, 0.68], BAND = [0.93, 0.93, 0.9], ROOF = [0.88, 0.9, 0.92], ROOF2 = [0.78, 0.82, 0.86], STEEL = [0.34, 0.36, 0.38], ACC = [0.78, 0.2, 0.25];
  const nx = -dy, ny = dx, W = (s, k, h) => P(dx * s + nx * k, dy * s + ny * k, h), at = (s, k) => [dx * s + nx * k, dy * s + ny * k];
  const L = 136, HL = L / 2, T = METRO_TOP;
  for (let s = -28; s <= 28; s += 14) for (const k of [-5.2, 5.2]) { const [x, y] = at(s, k); obx(x, y, -0.5, dx, dy, 1.3, 1.3, 5, CONC); }      // columns under the concourse
  obx(0, 0, 4.4, dx, dy, 66, 15, 5.8, GLASS, BAND);                                   // glazed concourse
  obx(0, 0, 4.3, dx, dy, 66.6, 15.6, 0.6, CONC2); obx(0, 0, 9.5, dx, dy, 66.6, 15.6, 0.7, ACC);
  obx(0, 0, T - 1.6, dx, dy, L, 15, 1.6, CONC, CONC2);                                // platform level
  for (const k of [-7.2, 7.2]) obx(...at(0, k), T, dx, dy, L, 0.25, 1.1, [0.7, 0.85, 0.9]);   // glass screens along the platform edges
  // arched roof, in ribs of two shades
  const N = 8, RIB_N = 8, ribL = L / RIB_N, arc = (t) => [9.4 * t, T + 5.2 + 3.0 * (1 - t * t)];
  for (let r = 0; r < RIB_N; r++) for (let j = 0; j < N; j++) {
    const t0 = -1 + 2 * j / N, t1 = -1 + 2 * (j + 1) / N, [k0, h0] = arc(t0), [k1, h1] = arc(t1), s0 = -HL + r * ribL, s1 = s0 + ribL;
    quad(W(s0, k0, h0), W(s1, k0, h0), W(s1, k1, h1), W(s0, k1, h1), (r + j) % 2 ? ROOF : ROOF2);
  }
  for (let s = -HL + 6; s <= HL - 6; s += 17) for (const k of [-8.4, 8.4]) { const [x, y] = at(s, k); obx(x, y, T, dx, dy, 0.6, 0.6, 5.6, STEEL); }
  for (const s of [-HL, HL]) for (let j = 0; j < N; j++) {                              // end fascia, a thin arched frame
    const t0 = -1 + 2 * j / N, t1 = -1 + 2 * (j + 1) / N, [k0, h0] = arc(t0), [k1, h1] = arc(t1);
    quad(W(s, k0, h0), W(s, k1, h1), W(s, k1, h1 - 0.7), W(s, k0, h0 - 0.7), BAND);
  }
  // stairs from the street to the concourse, two on each side
  for (const s of [-18, 18]) for (const side of [-1, 1]) {
    const w = 1.9, k0 = side * 17, k1 = side * 7.6;
    quad(W(s - w, k0, 0), W(s + w, k0, 0), W(s + w, k1, 4.4), W(s - w, k1, 4.4), CONC2);
    for (const e of [-w, w]) { quad(W(s + e, k0, 0), W(s + e, k0, 1), W(s + e, k1, 5.4), W(s + e, k1, 4.4), CONC); tri(W(s + e, k0, 0), W(s + e, k0, 1), W(s + e, k1, 4.4), CONC); }
    obx(...at(s, side * 18), 3.1, dx, dy, 5.6, 2.6, 0.3, ACC);                        // small canopy at the foot of the stairs
  }
  return done();
}
let metroSpots = [];                                   // stations in the tile being built: x, y, direction of the line
function stationSpots(ofm, b, metro) {
  const l = ofm && ofm.layers.poi, out = []; if (!l || !metro.length) return out;
  const sc = b.size / l.extent, seen = [];
  for (let i = 0; i < l.length; i++) {
    const f = l.feature(i), p = f.properties;
    if (f.type !== 1 || p.class !== 'railway' || !['subway', 'station', 'light_rail'].includes(p.subclass)) continue;
    const pt = f.loadGeometry()[0][0]; if (pt.x < 0 || pt.y < 0 || pt.x > l.extent || pt.y > l.extent) continue;
    const x = b.x0 + pt.x * sc, y = b.y1 - pt.y * sc;
    if (seen.some((s) => Math.hypot(s[0] - x, s[1] - y) < 90)) continue;
    let best = 1e9, bx = 0, by = 0, bdx = 1, bdy = 0;          // nearest point on a metro line, and its direction
    for (const m of metro) {
      const Q = m.pts;
      for (let q = 0; q < Q.length / 2 - 1; q++) {
        const ax = Q[q * 2], ay = Q[q * 2 + 1], ex = Q[q * 2 + 2] - ax, ey = Q[q * 2 + 3] - ay, el = Math.hypot(ex, ey) || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (el * el))), qx = ax + ex * t, qy = ay + ey * t, d = Math.hypot(x - qx, y - qy);
        if (d < best) { best = d; bx = qx; by = qy; bdx = ex / el; bdy = ey / el; }
      }
    }
    if (best > 50) continue;
    seen.push([x, y]); out.push([bx, by, bdx, bdy]);
  }
  return out;
}
const nearStation = (x, y) => { for (const s of metroSpots) if (Math.hypot(x - s[0], y - s[1]) < 70) return true; return false; };

// ------------------------------------------------------------------ messages
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    frame = m.frame; ofmTemplate = m.ofm; satTemplate = m.sat;
    if (m.overture) overture = new PMTiles(m.overture);
    return;
  }
  if (m.type !== 'build') return;
  const { id, z, x, y, opts } = m;
  try {
    const b = bounds(z, x, y);
    const [ofm, bvt, sat] = await Promise.all([
      fetchOFM(Math.min(z, 14), x, y).catch((err) => { console.warn(err); return null; }),
      fetchOverture(z, x, y).catch((err) => { console.warn('Overture', err); return null; }),
      fetchSat(z, x, y).catch(() => null),
    ]);
    // Two jobs can be in flight per worker: set the terrain for THIS tile only after the downloads
    // finish, so everything below (all synchronous) uses its own heights, not another tile's.
    G = m.grid; GX = m.gx; GY = m.gy;
    MESH = { b, seg: opts.seg };
    curFixes = opts.fixes || []; curHide = opts.hide || []; curRoads = opts.roads || []; curTanks = opts.tanks || []; tankSpecs = [];
    if (z >= 13) addRoads(ofm, b);
    const mpp = b.size / opts.canvas;
    if (z >= 14 && !secFoot) preSecretariat(bvt, b);
    const trees = sat && opts.trees > 0 && z >= 14 ? plantTrees(sat, ofm, bvt || ofm, b, opts.trees) : null;
    curZ = z;
    const tex = paint(ofm, bvt || ofm, opts.canvas, mpp, sat, b, trees);
    const terrain = terrainMesh(b, opts.seg);
    roadTest = z >= 14 ? makeRoadTest(ofm, b) : null;
    const ln = lines(ofm, b, z >= 14);
    metroSpots = z >= 14 ? stationSpots(ofm, b, ln.metro) : [];
    let bld = bvt ? buildingsMesh(bvt, b, 'building', z) : null;
    if (!bvt && ofm) bld = buildingsMesh(ofm, b, 'building', z);       // OpenStreetMap fallback
    curZ = z;
    if (z < 14) ln.roads = [];
    if (z < 13) ln.metro = [];
    const rib = z >= 14 ? roadRibbons(ofm, b) : null;
    const lm = z >= 14 ? mergeGeo([charminar(b), buddha(b), secretariat(b), cyberTowers(b), meccaMasjid(b), falaknuma(b), golconda(b), birla(b), salarJung(b), chowmahalla(b), mergeGeo(metroSpots.map((s) => metroStation(s[0], s[1], s[2], s[3]))), waterTanks()]) : null;
    const metro = z >= 13 ? metroViaduct(ln.metro, metroSpots) : null;
    const transfer = [tex.color, tex.aux, terrain.pos.buffer, terrain.nor.buffer, terrain.uv.buffer, terrain.idx.buffer];
    if (bld) transfer.push(bld.pos.buffer, bld.nor.buffer, bld.col.buffer, bld.uv.buffer, bld.idx.buffer, bld.bStart.buffer, bld.bH.buffer, bld.bCls.buffer, bld.bBase.buffer, bld.tanks.buffer, bld.rooms.buffer);
    if (rib) for (const r of rib) if (r) transfer.push(r.pos.buffer, r.uv.buffer, r.idx.buffer);
    if (rib && rib.extras) for (const e of [rib.extras.walk, rib.extras.marks, rib.extras.disc]) if (e) transfer.push(...Object.values(e).map((a) => a.buffer));
    if (rib && rib.lamps) transfer.push(rib.lamps.buffer);
    if (rib && rib.deck) transfer.push(rib.deck.pos.buffer, rib.deck.idx.buffer, rib.deck.piers.buffer);
    if (lm) transfer.push(lm.pos.buffer, lm.col.buffer, lm.idx.buffer);
    if (rib && rib.cable) transfer.push(rib.cable.pos.buffer, rib.cable.col.buffer, rib.cable.idx.buffer);
    if (metro) {
      transfer.push(metro.pos.buffer, metro.idx.buffer, metro.piers.buffer);
      for (const t of metro.tracks) transfer.push(t.pts.buffer, t.hs.buffer, t.cum.buffer, t.stops.buffer);
    }
    if (trees) transfer.push(trees.buffer);
    for (const r of ln.roads) transfer.push(r.pts.buffer);
    self.postMessage({ id, tex, terrain, bld, metro, trees, rib, roads: ln.roads, deck: rib && rib.deck, cable: rib && rib.cable, lm, extras: rib && rib.extras, lamps: rib && rib.lamps, labels: ln.labels, source: bvt ? 'overture' : 'osm', sat: !!sat }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};

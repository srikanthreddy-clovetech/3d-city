// Hyderabad 3D engine. Everything three.js lives here; React talks to it through the object
// returned by createEngine() and hears back through callbacks. All map data streams live
// from public tile services while you move: nothing has to be prepared in advance.
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { skyMaterial, groundMaterial, buildingMaterial, glowMaterial, roadMaterial, paintMaterial, lampMaterial, poolMaterial } from './materials.js';
import { facadeAtlas, roadTexture } from './textures.js';
import { HIDDEN_BUILDINGS, EXTRA_ROADS, WATER_TANKS } from '../edits.js';
import { parseCode } from '../buildingId.js';
import { sunPosition, istNow, findSunTime } from './sun.js';
import { makeFrame, lonLatToLocal, localToLonLat, tileAt } from './geo.js';
import { Terrain, TZ, BASE } from './terrain.js';
import { TileManager } from './tiles.js';

export const CENTER = { lat: 17.405, lon: 78.445 };
export const START = { lat: 17.4156, lon: 78.4746 };     // Hussain Sagar
const LIMIT = 40000;                                       // how far (m) from the centre you can roam

// r14 / r13: distance (m) within which tiles split to zoom 14 (every building) and zoom 13
export const QUALITY = {
  lite:   { r14: 900,  r13: 3000,  far: 12000, canvas: 384,  seg: 32, cache: 30,  pr: 1,    shadows: 0,    cars: 0,    trees: 0,    bloom: false },
  low:    { r14: 1200, r13: 5000,  far: 18000, canvas: 512,  seg: 48, cache: 40,  pr: 1,    shadows: 0,    cars: 500,  trees: 1500, bloom: true },
  medium: { r14: 1600, r13: 7000,  far: 24000, canvas: 512,  seg: 64, cache: 55,  pr: 1,    shadows: 2048, shadowEvery: 0.06, shadowMax: 1100, cars: 1200, trees: 3000, bloom: true },
  high:   { r14: 2100, r13: 9500,  far: 30000, canvas: 640,  seg: 64, cache: 75,  pr: 1.25, shadows: 2048, shadowEvery: 0.05, shadowMax: 1500, cars: 2400, trees: 5000, bloom: true },
  ultra:  { ao: true, r14: 3200, r13: 13000, far: 38000, canvas: 1024, seg: 64, cache: 100, pr: 1.5,  shadows: 4096, shadowEvery: 0.04, shadowMax: 2400, cars: 4000, trees: 8000, bloom: true },
};
export const LEVELS = ['lite', 'low', 'medium', 'high', 'ultra'];

const LANDMARKS = [
  ['Charminar', 17.3616, 78.4747], ['Golconda Fort', 17.3833, 78.4011], ['Buddha Statue, Hussain Sagar', 17.4156, 78.4746],
  ['Birla Mandir', 17.4062, 78.4691], ['Salar Jung Museum', 17.3713, 78.4804], ['Mecca Masjid', 17.3604, 78.4736],
  ['Chowmahalla Palace', 17.3578, 78.4717], ['Falaknuma Palace', 17.3313, 78.4672], ['Qutb Shahi Tombs', 17.3949, 78.3946],
  ['Cyber Towers', 17.4504, 78.3810], ['Durgam Cheruvu Bridge', 17.4300, 78.3895], ['KBR National Park', 17.4235, 78.4206],
  ['Secunderabad Station', 17.4337, 78.5016], ['Osmania University', 17.4136, 78.5281], ['Uppal Cricket Stadium', 17.4065, 78.5505],
  ['Rajiv Gandhi Intl Airport', 17.2403, 78.4294],
];
const CLASS_NAMES = ['Building', 'Residential', 'Commercial', 'Industrial', 'Public building', 'Religious building', 'Transport building'];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

async function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

/** Find the live data endpoints: OpenFreeMap's current tileset and Overture's latest release. */
async function discoverSources(signal) {
  const ofm = withTimeout(fetch('https://tiles.openfreemap.org/planet', { signal }).then((r) => r.json()), 10000)
    .then((tj) => ({ url: tj.tiles[0], attribution: tj.attribution })).catch(() => null);
  const ov = withTimeout((async () => {
    const cat = await fetch('https://stac.overturemaps.org/catalog.json', { signal }).then((r) => r.json());
    const rel = cat.latest;
    try {
      const b = await fetch(`https://stac.overturemaps.org/${rel}/buildings/catalog.json`, { signal }).then((r) => r.json());
      const link = b.links.find((l) => l.rel === 'pmtiles');
      if (link) return { url: link.href, release: rel };
    } catch { /* fall through */ }
    return { url: `https://tiles.overturemaps.org/${rel}/buildings.pmtiles`, release: rel };
  })(), 10000).catch(() => null);
  const [a, b] = await Promise.all([ofm, ov]);
  // Sentinel-2 cloudless 2024 by EOX (CC BY-NC-SA 4.0: non-commercial use only)
  const sat = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg';
  return { ofm: a?.url || null, overture: b?.url || null, release: b?.release || null, sat };
}

/**
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas
 * @param {HTMLElement} o.labelRoot   container the engine fills with label elements
 * @param {HTMLElement} [o.needle]    compass needle element to rotate
 * @param {string} [o.quality]        initial quality, or undefined for automatic
 * @param {(frac:number, msg?:string)=>void} o.onProgress
 * @param {(t:{hours:number, live:boolean})=>void} o.onTime
 * @param {(q:{name:string, auto:boolean})=>void} o.onQuality
 * @param {(info:object|null)=>void} o.onPick
 * @param {(s:object)=>void} o.onStats
 * @param {(v:{lat:number, lon:number, eye:number})=>void} o.onView   look-at point, about 3 times a second
 * @param {{lat:number, lon:number, range?:number, az?:number, tilt?:number}} [o.initial]   start view (from a shared link)
 * @param {(id:string)=>void} [o.onPin]   a map pin was tapped
 * @param {()=>void} o.onReady
 * @param {AbortSignal} o.signal
 */
export async function createEngine(o) {
  const { canvas, labelRoot, signal } = o;
  let needle = o.needle;                                   // the compass needle can come and go (the side panel opens and closes)
  const cleanups = [];
  const listen = (t, type, fn, opts) => { t.addEventListener(type, fn, opts); cleanups.push(() => t.removeEventListener(type, fn, opts)); };

  const isMobile = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700;
  // Auto quality walks a ladder of (preset, resolution scale); the last rung used is remembered
  const LADDER = [['lite', 0.8], ['lite', 1], ['low', 0.85], ['low', 1], ['medium', 0.85], ['medium', 1], ['high', 0.85], ['high', 1]];
  const rungOf = (name) => LADDER.map((r) => r[0]).lastIndexOf(name);
  function initialRung(ignoreSaved) {
    try { const v = JSON.parse(localStorage.getItem('hyd3d.rung')); if (!ignoreSaved && Number.isInteger(v) && v >= 0 && v < LADDER.length) return v; } catch { /* no storage */ }
    let gpu = '';
    try {                                               // a throwaway context, only to read the graphics card's name
      const gl = document.createElement('canvas').getContext('webgl2');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      gpu = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || '').toLowerCase();
      gl && gl.getExtension('WEBGL_lose_context') && gl.getExtension('WEBGL_lose_context').loseContext();
    } catch { /* unknown */ }
    if (/swiftshader|llvmpipe|software|basic render/.test(gpu)) return rungOf('low');
    const mem = navigator.deviceMemory || 8, cores = navigator.hardwareConcurrency || 8;
    if (isMobile) return rungOf(mem >= 6 ? 'medium' : 'low');
    return rungOf(mem <= 4 || cores <= 4 ? 'medium' : 'high');
  }
  let autoQuality = !QUALITY[o.quality];
  let rung = initialRung(false);
  let resScale = autoQuality ? LADDER[rung][1] : 1;
  let qName = QUALITY[o.quality] ? o.quality : LADDER[rung][0];
  // shadows are redrawn only when something that affects them changed (see updateShadowFrustum)
  let shadowDirty = true, shadowVer = -1, shadowR = 0, shadowAt = -1e9;
  const shadowC = new THREE.Vector3(1e9, 0, 0);
  let Q = QUALITY[qName];

  o.onProgress(0.05, 'Finding the latest map data');
  const sources = await discoverSources(signal);
  if (signal?.aborted) return null;
  if (!sources.ofm && !sources.overture) throw new Error('Could not reach the map data services. Check your internet connection and reload.');

  const frame = makeFrame(CENTER.lat, CENTER.lon);
  const terrain = new Terrain(frame);
  const groundZ = (x, z) => terrain.heightAt(x, -z);

  o.onProgress(0.15, 'Laying out the Deccan terrain');
  const [sx, sy] = lonLatToLocal(frame, START.lon, START.lat);
  const [tx, ty] = tileAt(frame, sx, sy, TZ);
  await terrain.padded(tx, ty);
  if (signal?.aborted) return null;

  // ---------------------------------------------------------------- renderer
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  // If the graphics driver drops the context (memory pressure, a driver reset) the screen goes black in patches or entirely;
  // the page hash always holds the current view, so a reload brings the user straight back to the same place.
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); setTimeout(() => location.reload(), 600); });
  const size = () => [canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight];
  let [W, H] = size();
  renderer.setPixelRatio(Math.min(devicePixelRatio, Q.pr) * resScale);
  renderer.setSize(W, H, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;                  // refreshed by hand in tick(): less often while the camera is flying

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, W / H, 2, 120000);
  // the bloom path renders to its own targets, which have no anti-aliasing by default: small bright things (headlights) then shimmer
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  const gtao = new GTAOPass(scene, camera, W, H);
  gtao.updateGtaoMaterial({ radius: 5, distanceExponent: 1.2, thickness: 4, scale: 1.1, samples: 12, distanceFallout: 1, screenSpaceRadius: false });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 12 });
  gtao.blendIntensity = 0.85;
  composer.addPass(gtao);
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.6, 0.5, 0.75);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const U = { uNight: { value: 0 }, uTime: { value: 0 }, uSkyH: { value: new THREE.Vector3(0.7, 0.78, 0.85) }, uSkyZ: { value: new THREE.Vector3(0.3, 0.5, 0.85) }, uSunView: { value: new THREE.Vector3(0, 1, 0) }, uGlint: { value: 700 }, uWaveN: { value: 8 }, uWaveR: { value: 1.3 } };
  const skyMat = skyMaterial(U);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(100000, 48, 24), skyMat);
  sky.renderOrder = -100; sky.frustumCulled = false;
  scene.add(sky);
  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  const hemi = new THREE.HemisphereLight(0xbcd6ff, 0x6b5a44, 1);
  scene.add(sun, sun.target, hemi);
  scene.fog = new THREE.FogExp2(0xb8c8d8, 1 / 30000);

  // ---------------------------------------------------------------- labels
  const labels = [], labelByName = new Map();
  const MAXD = { town: 45000, ward: 14000, hood: 6000, water: 9000, poi: 15000 };
  const PRIO = { poi: 6, town: 5, water: 4, ward: 3, hood: 1 };
  function addLabel(text, x, y, kind, r = 1, lift = 25, h = null, owner = null) {
    const key = text.toLowerCase();
    const prev = labelByName.get(key);
    if (prev && Math.hypot(prev.x - x, prev.y - y) < 4000) return;
    const el = document.createElement('div');
    el.className = `lbl ${kind}`; el.textContent = text; el.style.opacity = 0;
    labelRoot.appendChild(el);
    const L = { el, x, y, pos: new THREE.Vector3(x, (h ?? terrain.heightAt(x, y)) + lift, -y), maxd: MAXD[kind] * (kind === 'hood' ? 1 + r * 0.3 : 1), prio: PRIO[kind] + r * 0.1, on: false, w: 0, h: 0, key, owner };
    let lo = 0, hi = labels.length;                       // keep the list sorted by priority: insert at its place instead of sorting everything
    while (lo < hi) { const m = (lo + hi) >> 1; if (labels[m].prio >= L.prio) lo = m + 1; else hi = m; }
    labels.splice(lo, 0, L); labelByName.set(key, L);
  }
  // a tile that is thrown out of the cache takes its labels with it (they come back if the tile is loaded again)
  function removeLabels(owner) {
    let w = 0;
    for (let i = 0; i < labels.length; i++) {
      const L = labels[i];
      if (L.owner === owner) { L.el.remove(); if (labelByName.get(L.key) === L) labelByName.delete(L.key); }
      else labels[w++] = L;
    }
    labels.length = w;
  }
  for (const [n, lat, lon] of LANDMARKS) { const [x, y] = lonLatToLocal(frame, lon, lat); addLabel(n, x, y, 'poi', 1, 45); }
  let showLabels = true, showPins = true;
  const _v = new THREE.Vector3();
  function updateLabels() {
    const placed = [], cp = camera.position, pinned = new Set(pins.map((P) => P.key));      // a pin already names its place: the plain label of the same name stays hidden
    for (const L of labels) {
      let vis = false;
      if (showLabels && !pinned.has(L.key) && cp.distanceTo(L.pos) < L.maxd) {
        _v.copy(L.pos).project(camera);
        if (_v.z < 1 && Math.abs(_v.x) < 1.1 && Math.abs(_v.y) < 1.1) {
          const sx2 = (_v.x * 0.5 + 0.5) * W, sy2 = (-_v.y * 0.5 + 0.5) * H;
          if (!L.w) { L.w = L.el.offsetWidth || 80; L.h = L.el.offsetHeight || 16; }
          const r = [sx2 - L.w / 2 - 4, sy2 - L.h / 2 - 3, sx2 + L.w / 2 + 4, sy2 + L.h / 2 + 3];
          if (!placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) {
            placed.push(r); vis = true;
            L.el.style.transform = `translate3d(${(sx2 - L.w / 2).toFixed(1)}px, ${(sy2 - L.h / 2).toFixed(1)}px, 0)`;
          }
        }
      }
      if (vis !== L.on) { L.on = vis; L.el.style.opacity = vis ? 1 : 0; }
    }
  }

  // ---------------------------------------------------------------- pins (saved buildings, search result)
  let pins = [];
  function setPinList(list) {
    pins.forEach((P) => P.el.remove());
    pins = (list || []).map((p) => {
      const [x, y] = lonLatToLocal(frame, p.lon, p.lat);
      const el = document.createElement('button');
      el.type = 'button'; el.className = `pin ${p.kind}`; el.setAttribute('aria-label', p.name);
      const head = document.createElement('i'), name = document.createElement('span');
      name.textContent = p.name; el.append(head, name); el.style.display = 'none';
      el.addEventListener('click', (e) => { e.stopPropagation(); o.onPin && o.onPin(p.id); });
      labelRoot.appendChild(el);
      const P = { el, key: String(p.name || '').toLowerCase(), kind: p.kind, on: false, pos: new THREE.Vector3(x, groundZ(x, -y) + (p.h ?? 8) + 3, -y), dragging: false, last: null };
      if (p.drag) {                                    // a handle: drag it over the ground, double-click removes it
        el.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); el.setPointerCapture(e.pointerId); P.dragging = true; });
        el.addEventListener('pointermove', (e) => {
          if (!P.dragging) return;
          const g = groundAtClient(e.clientX, e.clientY);
          if (g) { const [gx, gy] = lonLatToLocal(frame, g.lon, g.lat); P.pos.set(gx, groundZ(gx, -gy) + 3, -gy); P.last = g; }
        });
        el.addEventListener('pointerup', (e) => {
          if (!P.dragging) return;
          P.dragging = false; try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
          if (P.last) { const g = P.last; P.last = null; o.onPinDrop && o.onPinDrop(p.id, g.lat, g.lon); }
        });
        el.addEventListener('dblclick', (e) => { e.stopPropagation(); o.onPinDouble && o.onPinDouble(p.id); });
      }
      return P;
    });
  }
  function updatePins() {
    for (const P of pins) {
      let vis = false;
      if (showPins || P.kind === 'result') {
        const d = camera.position.distanceTo(P.pos);
        if (d < (P.kind === 'result' ? 60000 : 14000)) {
          _v.copy(P.pos).project(camera);
          if (_v.z < 1 && Math.abs(_v.x) < 1.05 && Math.abs(_v.y) < 1.05) { P.el.style.transform = `translate3d(${((_v.x * 0.5 + 0.5) * W).toFixed(1)}px, ${((-_v.y * 0.5 + 0.5) * H).toFixed(1)}px, 0)`; vis = true; }
        }
      }
      if (vis !== P.on) { P.on = vis; P.el.style.display = vis ? '' : 'none'; }
    }
  }

  // ---------------------------------------------------------------- tiles
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const atlas = facadeAtlas(aniso);
  const bMat = buildingMaterial(U, atlas);
  const roadMats = [0, 1, 2].map((k) => roadMaterial(roadTexture(k, aniso), U, k));
  const junctionMat = roadMaterial(roadTexture(2, aniso), U, 2, 0.0);      // junction patches glow like the major roads they join
  const walkMat = paintMaterial(U, 0.0, [-2, -10]), markMat = paintMaterial(U, 0.05, [-3, -14]);
  const lampMat = lampMaterial(U), poolMat = poolMaterial(U);
  const metroMat = glowMaterial(U, [0.4, 0.9, 0.85], 0.12, { vertexColors: false, color: new THREE.Color('#a5a39c'), side: THREE.DoubleSide, polygonOffset: false });
  const pierMat = new THREE.MeshLambertMaterial({ color: 0x9c9a94 });
  const treeMat = new THREE.MeshLambertMaterial({ flatShading: true, vertexColors: true });
  const tiles = new TileManager({
    scene, frame, terrain, sources, renderer, maxAniso: aniso,
    makeGround: (map, aux) => groundMaterial(map, aux, U), buildingMat: bMat, metroMat, pierMat, treeMat, roadMats, junctionMat, walkMat, markMat, lampMat, poolMat,
    onLabels: (ls, owner) => ls.forEach((l) => addLabel(l.n, l.x, l.y, l.k, l.r, 25, l.h, owner)),
  });
  tiles.onTileGone = removeLabels;
  tiles.q = Q;
  // hand edits from edits.js: buildings to leave out (as points inside them) and roads to add (as local metres)
  const baseEdits = tiles.edits = {
    hide: HIDDEN_BUILDINGS.flatMap((c) => { const p = parseCode(c); return p ? lonLatToLocal(frame, p.lon, p.lat) : []; }),
    tanks: WATER_TANKS.flatMap((c) => { const p = parseCode(c); return p ? lonLatToLocal(frame, p.lon, p.lat) : []; }),
    roads: EXTRA_ROADS.map((r) => ({ cls: r.cls, pts: r.points.flatMap(([lat, lon]) => lonLatToLocal(frame, lon, lat)) })),
  };

  // ---------------------------------------------------------------- traffic
  // vehicle models: boxes with vertex-coloured parts (body is tinted per vehicle, glass stays dark)
  function boxes(parts) {
    const pos = [], col = [], nor = [];
    for (const [w, h, d, x, y, z, c] of parts) {
      const b = new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();
      pos.push(...b.attributes.position.array); nor.push(...b.attributes.normal.array);
      for (let i = 0; i < b.attributes.position.count; i++) col.push(c, c, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return g;
  }
  const carGeo = boxes([[4.2, 0.75, 1.75, 0, 0.55, 0, 1], [2.3, 0.62, 1.55, -0.25, 1.22, 0, 0.22], [2.25, 0.08, 1.5, -0.25, 1.56, 0, 1],
    [0.7, 0.36, 0.36, 1.45, 0.25, 0.75, 0.08], [0.7, 0.36, 0.36, 1.45, 0.25, -0.75, 0.08], [0.7, 0.36, 0.36, -1.35, 0.25, 0.75, 0.08], [0.7, 0.36, 0.36, -1.35, 0.25, -0.75, 0.08]]);
  const busGeo = boxes([[11, 2.4, 2.5, 0, 1.75, 0, 1], [10.4, 0.9, 2.52, -0.1, 2.25, 0, 0.18], [1.2, 1.2, 2.52, 5.3, 1.9, 0, 0.18],
    [1, 0.5, 0.5, 3.6, 0.3, 1.1, 0.08], [1, 0.5, 0.5, 3.6, 0.3, -1.1, 0.08], [1, 0.5, 0.5, -3.4, 0.3, 1.1, 0.08], [1, 0.5, 0.5, -3.4, 0.3, -1.1, 0.08]]);
  const lightGeo = (() => {
    const pos = [], col = [], idx = [];
    for (const [x, z, front] of [[2.12, 0.6, 1], [2.12, -0.6, 1], [-2.12, 0.6, 0], [-2.12, -0.6, 0]]) {
      const b = new THREE.BoxGeometry(0.1, 0.22, 0.32).translate(x, 0.7, z);
      const off = pos.length / 3;
      pos.push(...b.attributes.position.array);
      for (let i = 0; i < b.attributes.position.count; i++) col.push(...(front ? [1, 0.93, 0.8] : [1, 0.08, 0.04]));
      idx.push(...Array.from(b.index.array, (i) => i + off));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx); return g;
  })();
  const carMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const lightMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  const CAR_COLORS = ['#f2f2ee', '#f2f2ee', '#c9ccd0', '#c9ccd0', '#2a2c30', '#8a1e1e', '#2b4a7a', '#7a7d80', '#d9b13a'].map((c) => new THREE.Color(c));
  const SPEED = [19, 16, 12, 10, 8], WIDTH = [18, 15, 13, 11, 9], WEIGHT = [4, 3, 2, 1.4, 1], LIFT = [0.42, 0.42, 0.42, 0.38, 0.38];
  let roads = [], roadCum = [], cars = [], carMesh = null, busMesh = null, lightMesh = null, trafficOn = true, trafficMode = 'static', trafficVersion = -1, trafficTimer = 0, trafficDirty = true, trafficDrawn = -1;
  const prepRoad = (r) => {
    if (r.cum) return r;
    const P = r.pts, cum = new Float32Array(P.length / 2);
    for (let k = 1; k < cum.length; k++) cum[k] = cum[k - 1] + Math.hypot(P[k * 2] - P[k * 2 - 2], P[k * 2 + 1] - P[k * 2 - 1]);
    r.cum = cum; r.len = cum[cum.length - 1];
    return r;
  };
  function pointAt(l, s) {
    const cum = l.cum, P = l.pts;
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const seg = Math.max(1e-6, cum[hi] - cum[lo]), t = clamp((s - cum[lo]) / seg, 0, 1);
    const ax = P[lo * 2], ay = P[lo * 2 + 1], bx = P[hi * 2], by = P[hi * 2 + 1];
    return [ax + (bx - ax) * t, ay + (by - ay) * t, (bx - ax) / seg, (by - ay) / seg];
  }
  const pickRoad = () => {
    const r = Math.random() * roadCum[roadCum.length - 1];
    let lo = 0, hi = roadCum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (roadCum[m] < r) lo = m + 1; else hi = m; }
    return roads[lo];
  };
  function rebuildTraffic() {
    trafficDirty = true;
    roads = tiles.roads().map(prepRoad).filter((r) => r.len > 30);
    roadCum = []; roads.forEach((l, i) => roadCum.push((roadCum[i - 1] || 0) + l.len * WEIGHT[l.cls]));
    const n = roads.length ? Q.cars : 0;
    if (!carMesh || carMesh.userData.n !== n) {
      if (carMesh) { scene.remove(carMesh, busMesh, lightMesh); carMesh.dispose(); busMesh.dispose(); lightMesh.dispose(); carMesh = busMesh = lightMesh = null; }
      cars = [];
      if (!n) return;
      const nb = Math.round(n * 0.06), nc = n - nb;
      carMesh = new THREE.InstancedMesh(carGeo, carMat, nc);
      busMesh = new THREE.InstancedMesh(busGeo, carMat, nb);
      lightMesh = new THREE.InstancedMesh(lightGeo, lightMat, nc);
      carMesh.userData.n = n;
      for (const m of [carMesh, busMesh, lightMesh]) { m.frustumCulled = false; }
      carMesh.castShadow = busMesh.castShadow = true;
      carMesh.visible = busMesh.visible = trafficOn;
      for (let i = 0; i < n; i++) {
        const bus = i >= nc, auto = !bus && Math.random() < 0.28;
        const color = bus ? new THREE.Color(Math.random() < 0.6 ? '#b8312f' : '#e9e4d8')
          : auto ? new THREE.Color(Math.random() < 0.7 ? '#e6c229' : '#3f8f4a') : CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0];
        if (bus) busMesh.setColorAt(i - nc, color); else carMesh.setColorAt(i, color);
        cars.push({ kind: bus ? 'bus' : auto ? 'auto' : 'car', idx: bus ? i - nc : i, scale: auto ? [0.62, 1.1, 0.8] : [1, 1, 1], lane: 0.2 + Math.random() * 0.22, dir: Math.random() < 0.5 ? 1 : -1, l: null });
      }
      scene.add(carMesh, busMesh, lightMesh);
    }
    // keep cars whose road is still loaded, move the rest
    const live = new Set(roads);
    for (const c of cars) if (!c.l || !live.has(c.l)) { c.l = pickRoad(); c.s = Math.random() * c.l.len; c.v = SPEED[c.l.cls] * (c.kind === 'bus' ? 0.75 : 0.8 + Math.random() * 0.4); }
  }
  const _q2 = new THREE.Quaternion(), _z = new THREE.Vector3(0, 0, 1), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
  function updateTraffic(dt) {
    if (!carMesh || !carMesh.visible) return;
    if (trafficMode !== 'sim' && !trafficDirty && trafficDrawn === tiles.version) return;      // parked: positions only change when the cars or the tiles do
    trafficDirty = false; trafficDrawn = tiles.version;
    const step = trafficMode === 'sim' ? dt : 0;      // 'static': vehicles stay parked where they are
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      c.s += c.dir * c.v * step;
      if (c.s < 0 || c.s > c.l.len) { c.l = pickRoad(); c.s = Math.random() * c.l.len; }
      const [x, y, tx, ty] = pointAt(c.l, c.s);
      const w = WIDTH[c.l.cls] * c.lane;
      const px = x - ty * w * c.dir, py = y + tx * w * c.dir;        // India drives on the left
      _q.setFromAxisAngle(_up, Math.atan2(ty * c.dir, tx * c.dir));
      // sit exactly on the road surface as drawn; where the 3D road is not on screen, hide the vehicle
      const surf = tiles.surfaceAt(px, py);
      if (surf && surf.z === 14) { _p.set(px, surf.h + LIFT[c.l.cls], -py); _s.set(c.scale[0], c.scale[1], c.scale[2]); }
      else { _p.set(px, -1000, -py); _s.set(0, 0, 0); }
      _m.compose(_p, _q, _s);
      if (c.kind === 'bus') busMesh.setMatrixAt(c.idx, _m);
      else { carMesh.setMatrixAt(c.idx, _m); lightMesh.setMatrixAt(c.idx, _m); }
    }
    carMesh.instanceMatrix.needsUpdate = busMesh.instanceMatrix.needsUpdate = lightMesh.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- metro trains
  // three-car sets running up and down the elevated line, slowing to a stop at each station
  function boxesC(parts) {
    const pos = [], col = [], nor = [];
    for (const [w, h, d, x, y, z, c] of parts) {
      const b = new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();
      pos.push(...b.attributes.position.array); nor.push(...b.attributes.normal.array);
      for (let i = 0; i < b.attributes.position.count; i++) col.push(c[0], c[1], c[2]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return g;
  }
  const CAR_LEN = 20, CAR_STRIDE = 20.7, CARS = 3, MAX_TRAINS = 32;
  // Hyderabad Metro look: white body, sky-blue band along the top, teal windows, dark cab mask with a green-white-orange stripe, pantograph on the middle car
  const WHITE = [0.93, 0.94, 0.95], BLUE = [0.16, 0.62, 0.86], DARK = [0.07, 0.08, 0.1];
  function trainCar(cabNeg, cabPos, panto) {
    const body = [[CAR_LEN, 3.3, 2.9, 0, 2.25, 0, WHITE], [CAR_LEN + 0.04, 0.6, 2.93, 0, 3.7, 0, BLUE], [CAR_LEN - 0.4, 0.18, 2.3, 0, 4.0, 0, [0.72, 0.74, 0.77]],
      [CAR_LEN - 1.2, 0.55, 2.5, 0, 0.55, 0, [0.22, 0.23, 0.25]]];
    const win = [];
    for (const x of [-7.5, -2.5, 2.5, 7.5]) body.push([1.3, 2.45, 2.935, x, 2.1, 0, [0.78, 0.8, 0.82]]);
    for (const x of [-5, 0, 5]) win.push([3.3, 1.0, 2.95, x, 2.75, 0, [1, 1, 1]]);
    for (const x of [-9.05, 9.05]) win.push([1.5, 1.0, 2.95, x, 2.75, 0, [1, 1, 1]]);
    for (const [on, sg] of [[cabNeg, -1], [cabPos, 1]]) {
      if (!on) continue;
      const x = sg * (CAR_LEN / 2);
      body.push([0.5, 3.3, 2.9, x + sg * 0.15, 2.25, 0, WHITE], [0.55, 0.6, 2.93, x + sg * 0.15, 3.7, 0, BLUE], [0.4, 2.0, 2.45, x + sg * 0.4, 2.75, 0, DARK],
        [0.5, 1.2, 2.8, x + sg * 0.15, 1.1, 0, [0.88, 0.9, 0.92]], [0.2, 0.34, 0.7, x + sg * 0.5, 0.45, 0, [0.15, 0.15, 0.17]],
        [0.12, 0.12, 2.3, x + sg * 0.64, 2.0, 0, [0.12, 0.55, 0.25]], [0.12, 0.12, 2.3, x + sg * 0.64, 1.86, 0, [0.95, 0.95, 0.95]], [0.12, 0.12, 2.3, x + sg * 0.64, 1.72, 0, [0.92, 0.38, 0.18]],
        [0.14, 0.2, 0.3, x + sg * 0.6, 1.25, 1.0, [1, 1, 0.9]], [0.14, 0.2, 0.3, x + sg * 0.6, 1.25, -1.0, [1, 1, 0.9]]);
      for (const z of [-0.78, 0, 0.78]) win.push([0.1, 1.1, 0.65, x + sg * 0.62, 3.0, z, [1, 1, 1]]);
    }
    if (panto) body.push([2.2, 0.15, 1.7, 0, 4.18, 0, DARK], [0.12, 0.95, 0.12, -0.5, 4.7, 0.6, DARK], [0.12, 0.95, 0.12, 0.5, 4.7, -0.6, DARK], [0.2, 0.08, 1.9, 0, 5.2, 0, DARK]);
    return [boxesC(body), boxesC(win)];
  }
  const trainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const winMat = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(0.09, 0.27, 0.32), toneMapped: false });
  const TRAIN_GEO = [trainCar(true, false, false), trainCar(false, false, true), trainCar(false, true, false)];   // tail, middle (pantograph), head: local +x is the direction the line is numbered
  let trains = [], trainTracks = [], trainParts = [];
  const trainAlive = new Set();
  function hAt(l, s) {
    const cum = l.cum, H = l.hs;
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const t = clamp((s - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]), 0, 1);
    return H[lo] + (H[hi] - H[lo]) * t;
  }
  // the line continues on a neighbouring tile's track: find it so a train can carry on instead of turning back
  let trainStamp = 0;
  function findNext(l, atEnd) {
    if (l.nstamp !== trainStamp) { l.nstamp = trainStamp; l.nxt = [undefined, undefined]; }
    const slot = atEnd ? 1 : 0;
    if (l.nxt[slot] !== undefined) return l.nxt[slot];
    const n = l.cum.length, P = l.pts, i0 = atEnd ? n - 1 : 0, i1 = atEnd ? n - 2 : 1;
    const ex = P[i0 * 2], ey = P[i0 * 2 + 1];
    let ux = ex - P[i1 * 2], uy = ey - P[i1 * 2 + 1]; const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
    let best = null, bd = 30;
    for (const B of trainTracks) {
      if (B === l) continue;
      const Q2 = B.pts, m = B.cum.length, lenB = B.cum[m - 1];
      for (let i = 0; i < m - 1; i++) {
        const ax = Q2[i * 2], ay = Q2[i * 2 + 1], dx = Q2[i * 2 + 2] - ax, dy = Q2[i * 2 + 3] - ay, L2 = dx * dx + dy * dy || 1;
        const t = clamp(((ex - ax) * dx + (ey - ay) * dy) / L2, 0, 1), d = Math.hypot(ax + dx * t - ex, ay + dy * t - ey);
        if (d >= bd) continue;
        const sl = Math.sqrt(L2), dot = (dx * ux + dy * uy) / sl;
        if (Math.abs(dot) < 0.8) continue;
        const dB = dot > 0 ? 1 : -1, sB = B.cum[i] + sl * t;
        if ((dB > 0 ? lenB - sB : sB) < 60) continue;
        bd = d; best = { b: B, s: sB, d: dB };
      }
    }
    return (l.nxt[slot] = best);
  }
  function rebuildTrains() {
    trainStamp++;
    trainTracks = tiles.tracks().filter((t) => t.cum[t.cum.length - 1] > CAR_STRIDE * CARS + 40);
    if (!trainParts.length) {
      for (const [bg, wg] of TRAIN_GEO) {
        const body = new THREE.InstancedMesh(bg, trainMat, MAX_TRAINS), win = new THREE.InstancedMesh(wg, winMat, MAX_TRAINS);
        for (const m of [body, win]) { m.frustumCulled = false; m.count = 0; m.visible = trafficOn; scene.add(m); }
        body.castShadow = true;
        trainParts.push({ body, win });
      }
    }
    const live = new Set(trainTracks);
    trains = trains.filter((t) => live.has(t.l));
    let total = 0; for (const t of trainTracks) total += t.cum[t.cum.length - 1];
    const want = Math.min(MAX_TRAINS, Math.max(trainTracks.length ? 1 : 0, Math.round(total / 450)));
    const ext = CAR_STRIDE * (CARS - 1) / 2 + CAR_LEN / 2 + 4;
    while (trains.length < want) {
      let r = Math.random() * total, l = trainTracks[0];
      for (const t of trainTracks) { r -= t.cum[t.cum.length - 1]; if (r <= 0) { l = t; break; } }
      const len = l.cum[l.cum.length - 1];
      // every track is one-way (the map draws the two directions as two tracks), so trains never meet head-on; keep new ones apart from the others
      let sp = ext;
      for (let tries = 0; tries < 8; tries++) {
        sp = ext + Math.random() * Math.max(1, len - 2 * ext);
        if (!trains.some((o) => o.l === l && Math.abs(o.s - sp) < 170)) break;
      }
      trains.push({ l, s: sp, dir: 1, v: 0, dwell: Math.random() * 6, done: -1 });
    }
    if (trains.length > want) trains.length = want;
  }
  function updateTrains(dt) {
    if (!trainParts.length) return;
    const showTrains = trafficOn && trains.length > 0;
    for (const p of trainParts) p.body.visible = p.win.visible = showTrains;
    if (!showTrains) return;
    const step = trafficMode === 'sim' ? dt : 0;      // trains stand still while the traffic is parked, like the cars
    const ext = CAR_STRIDE * (CARS - 1) / 2 + CAR_LEN / 2 + 4, VMAX = 15;
    let n = 0;
    for (const tr of trains) {
      if (n >= MAX_TRAINS) break;
      const l = tr.l, len = l.cum[l.cum.length - 1];
      if (step) {
        if (tr.dwell > 0) { tr.dwell -= step; tr.v = 0; }
        else {
          let target = VMAX;
          for (const st of l.stops) {
            const d = (st - tr.s) * tr.dir;
            if (st === tr.done || d < -0.3) continue;
            if (d < 0.6) { tr.done = st; tr.dwell = 9 + Math.random() * 5; tr.v = 0; target = 0; break; }
            target = Math.min(target, Math.sqrt(2 * 1.1 * d));
          }
          for (const o of trains) {                      // keep a safe gap behind the train in front on the same track
            if (o === tr || o.l !== l || o.dir !== tr.dir) continue;
            const gap = (o.s - tr.s) * tr.dir;
            if (gap > 0 && gap < 220) target = Math.min(target, Math.sqrt(2 * 1.1 * Math.max(0, gap - 95)));
          }
          tr.v = tr.v < target ? Math.min(target, tr.v + 1.0 * step) : target;
          tr.s += tr.dir * tr.v * step;
          if (tr.done >= 0 && Math.abs(tr.s - tr.done) > 40) tr.done = -1;
          if (tr.s < ext || tr.s > len - ext) {
            const nx = findNext(l, tr.dir > 0);
            if (nx) {                                   // carry on along the next piece of the line
              const lenB = nx.b.cum[nx.b.cum.length - 1];
              tr.l = nx.b; tr.dir = nx.d; tr.s = clamp(nx.s - nx.d * ext, ext, lenB - ext); tr.done = -1;
            } else { tr.s = tr.dir > 0 ? ext : len - ext; tr.dwell = 3; tr.done = -1; }          // end of the loaded line: come back in at the other end, same direction
          }
        }
      }
      for (let k = 0; k < CARS; k++) {
        const sc = tr.s + (k - (CARS - 1) / 2) * CAR_STRIDE;
        const a = pointAt(l, sc - 7), b = pointAt(l, sc + 7), m = pointAt(l, sc);
        const dx = b[0] - a[0], dy = b[1] - a[1], dl = Math.hypot(dx, dy) || 1;
        const h1 = hAt(l, sc - 7), h2 = hAt(l, sc + 7);
        _q.setFromAxisAngle(_up, Math.atan2(dy, dx));
        _q2.setFromAxisAngle(_z, Math.atan2(h2 - h1, dl));
        _q.multiply(_q2);
        _p.set(m[0], hAt(l, sc) + 0.15, -m[1]); _s.set(1, 1, 1);
        _m.compose(_p, _q, _s);
        trainParts[k].body.setMatrixAt(n, _m); trainParts[k].win.setMatrixAt(n, _m);
      }
      n++;
    }
    for (const p of trainParts) { p.body.count = p.win.count = n; p.body.instanceMatrix.needsUpdate = p.win.instanceMatrix.needsUpdate = true; }
  }

  // ---------------------------------------------------------------- time of day
  let liveTime = true;
  let { hours: timeH, doy: DOY } = istNow();
  let fogBase = 1 / 34000;
  const sunDir = new THREE.Vector3();
  function applyTime() {
    const { el, az } = sunPosition(timeH, DOY, CENTER.lat, CENTER.lon);
    sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    const deg = el * 180 / Math.PI;
    const day = smooth(-4, 12, deg), night = 1 - smooth(-9, 2, deg);
    U.uNight.value = night;
    poolMat.visible = night > 0.03;
    winMat.color.setRGB(0.09 + night * 1.2, 0.27 + night * 0.85, 0.32 + night * 0.3);
    skyMat.uniforms.uSun.value.copy(sunDir);
    const warm = 1 - smooth(2, 30, deg);
    sun.color.setRGB(1, 0.96 - warm * 0.3, 0.9 - warm * 0.5);
    sun.intensity = 3.0 * day;
    {
      const dsk = 1 - day - night > 0 ? 1 - day - night : 0;     // twilight share
      U.uSkyH.value.set(0.78 * day + 0.7 * dsk + 0.03 * night, 0.8 * day + 0.45 * dsk + 0.035 * night, 0.82 * day + 0.32 * dsk + 0.05 * night);
      U.uSkyZ.value.set(0.30 * day + 0.12 * dsk + 0.01 * night, 0.52 * day + 0.16 * dsk + 0.012 * night, 0.92 * day + 0.28 * dsk + 0.03 * night);
    }
    hemi.intensity = night > 0.5 ? 0.25 + 0.15 * (1 - night) : 0.25 + 0.75 * day;
    hemi.color.setRGB(0.55 + 0.2 * day, 0.62 + 0.2 * day, 0.85 + 0.1 * day);
    hemi.groundColor.setRGB(0.25 + 0.2 * day, 0.22 + 0.16 * day, 0.2 + 0.1 * day);
    const dusk = clamp(1 - day - night, 0, 1);
    scene.fog.color.setRGB(0.74 * day + 0.75 * dusk + 0.035 * night, 0.74 * day + 0.5 * dusk + 0.04 * night, 0.72 * day + 0.38 * dusk + 0.06 * night);
    fogBase = 1 / (24000 - 8000 * dusk);
    renderer.toneMappingExposure = 0.95 + 0.3 * night;
    bloom.strength = 0.18 + 0.28 * night;
    bloom.threshold = 0.82 - 0.06 * night;
    sun.castShadow = Q.shadows > 0 && day > 0.05; shadowDirty = true;
    o.onTime({ hours: timeH, live: liveTime });
  }
  let timeAnim = null;

  // ---------------------------------------------------------------- controls
  const controls = new MapControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.maxPolarAngle = 1.42; controls.minDistance = 60; controls.maxDistance = 60000;
  controls.zoomToCursor = true; controls.screenSpacePanning = false;
  controls.target.set(sx, terrain.heightAt(sx, sy), -sy);
  camera.position.set(sx - 1500, terrain.heightAt(sx, sy) + 1300, -sy + 2200);
  controls.update();
  function applyView(v) {                               // jump straight to a view: look-at point, distance, heading, tilt
    const [x, y] = lonLatToLocal(frame, v.lon, v.lat);
    controls.target.set(x, groundZ(x, -y), -y);
    const tl = clamp(v.tilt ?? 0.8, 0.15, 1.4), r = clamp(v.range ?? 1200, 60, 60000), az = v.az ?? 0;
    camera.position.set(x + Math.sin(az) * Math.cos(tl) * r, controls.target.y + Math.sin(tl) * r, -y + Math.cos(az) * Math.cos(tl) * r);
    controls.update();
  }
  if (o.initial && isFinite(o.initial.lat) && isFinite(o.initial.lon)) applyView(o.initial);

  const keys = new Set();
  listen(window, 'keydown', (e) => { if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) keys.add(e.key.toLowerCase()); });
  listen(window, 'keyup', (e) => keys.delete(e.key.toLowerCase()));
  listen(window, 'blur', () => keys.clear());
  const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _mv = new THREE.Vector3();
  function flyKeys(dt) {
    if (!keys.size) return;
    const sp = camera.position.distanceTo(controls.target) * 0.9 * dt * (keys.has('shift') ? 3 : 1);
    camera.getWorldDirection(_f); _f.y = 0; _f.normalize();
    _r.crossVectors(_f, _up); _mv.set(0, 0, 0);
    if (keys.has('w') || keys.has('arrowup')) _mv.add(_f);
    if (keys.has('s') || keys.has('arrowdown')) _mv.sub(_f);
    if (keys.has('d') || keys.has('arrowright')) _mv.add(_r);
    if (keys.has('a') || keys.has('arrowleft')) _mv.sub(_r);
    if (_mv.lengthSq()) { _mv.normalize().multiplyScalar(sp); camera.position.add(_mv); controls.target.add(_mv); }
    const rot = (keys.has('q') ? 1 : 0) - (keys.has('e') ? 1 : 0);
    if (rot) camera.position.sub(controls.target).applyAxisAngle(_up, rot * dt * 0.9).add(controls.target);
  }
  function keepInBounds() {
    const t = controls.target;
    const ox = clamp(t.x, -LIMIT, LIMIT) - t.x, oz = clamp(t.z, -LIMIT, LIMIT) - t.z;
    if (ox || oz) { t.x += ox; t.z += oz; camera.position.x += ox; camera.position.z += oz; }
    t.y = groundZ(t.x, t.z);
    const gy = groundZ(camera.position.x, camera.position.z) + 25;
    if (camera.position.y < gy) camera.position.y = gy;
  }
  // fly to a place: keeps the current heading and (clamped) tilt, eases target and distance, arcs up for long hops
  let flyAnim = null;
  function flyTo(lat, lon, range = 900) {
    const [x, y] = lonLatToLocal(frame, lon, lat);
    const to = new THREE.Vector3(x, groundZ(x, -y), -y);
    const off = camera.position.clone().sub(controls.target);
    const tilt = clamp(Math.atan2(off.y, Math.hypot(off.x, off.z) || 1), 0.4, 0.95), az = Math.atan2(off.x, off.z);
    const offTo = new THREE.Vector3(Math.sin(az) * Math.cos(tilt), Math.sin(tilt), Math.cos(az) * Math.cos(tilt)).multiplyScalar(Math.max(150, range));
    const dist = Math.hypot(to.x - controls.target.x, to.z - controls.target.z);
    flyAnim = { t: 0, t0: performance.now(), fromT: controls.target.clone(), toT: to, fromO: off, toO: offTo, dur: clamp(1 + dist / 5000, 1.3, 3.4), arc: Math.min(dist * 0.25, 5000) };
    northAnim = null;
  }
  function animateTo(toT, toO, dur = 0.45, arc = 0) {
    flyAnim = { t: 0, t0: performance.now(), fromT: controls.target.clone(), toT, fromO: camera.position.clone().sub(controls.target), toO, dur, arc };
    northAnim = null;
  }
  function zoomBy(factor) {                              // factor < 1 zooms in
    const off = camera.position.clone().sub(controls.target);
    animateTo(controls.target.clone(), off.setLength(clamp(off.length() * factor, controls.minDistance, controls.maxDistance)), 0.35);
  }
  const TILTS = [1.3, 0.85, 0.45];                       // high looking down, middle, low like standing back
  function tiltStep() {
    const off = camera.position.clone().sub(controls.target), len = off.length();
    const cur = Math.atan2(off.y, Math.hypot(off.x, off.z) || 1), az = Math.atan2(off.x, off.z);
    const next = TILTS.find((t) => t < cur - 0.08) ?? TILTS[0];
    animateTo(controls.target.clone(), new THREE.Vector3(Math.sin(az) * Math.cos(next), Math.sin(next), Math.cos(az) * Math.cos(next)).multiplyScalar(len), 0.6);
  }
  function resetView() {
    const to = new THREE.Vector3(sx, terrain.heightAt(sx, sy), -sy), dist = Math.hypot(to.x - controls.target.x, to.z - controls.target.z);
    animateTo(to, new THREE.Vector3(-1500, 1300, 2200), clamp(1 + dist / 5000, 1.2, 3), Math.min(dist * 0.25, 5000));
  }
  const _fo = new THREE.Vector3();
  function updateFly(dt) {
    if (!flyAnim) return;
    const a = flyAnim; a.t = Math.min(1, (performance.now() - a.t0) / (a.dur * 1000));
    const e = smooth(0, 1, a.t);
    controls.target.lerpVectors(a.fromT, a.toT, e);
    _fo.lerpVectors(a.fromO, a.toO, e);
    _fo.multiplyScalar(1 + (a.arc / Math.max(_fo.length(), 1)) * Math.sin(Math.PI * e));
    camera.position.copy(controls.target).add(_fo);
    if (a.t >= 1) flyAnim = null;
  }
  for (const ev of ['pointerdown', 'wheel', 'touchstart']) listen(canvas, ev, () => { flyAnim = null; });
  let northAnim = null;
  function updateNorth(dt) {
    if (!northAnim) return;
    northAnim.t = Math.min(1, northAnim.t + dt / 0.7);
    const target = northAnim.from * (1 - smooth(0, 1, northAnim.t));
    camera.position.sub(controls.target).applyAxisAngle(_up, target - controls.getAzimuthalAngle()).add(controls.target);
    if (northAnim.t >= 1) northAnim = null;
  }

  // ---------------------------------------------------------------- picking
  const ray = new THREE.Raycaster();
  let downAt = null, pickCb = null;
  listen(canvas, 'pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  // where the ray from the camera through the pointer meets the ground: march along it, then bisect
  function groundPoint() {
    const o = ray.ray.origin, d = ray.ray.direction; let t = 1, step = 2;
    for (let i = 0; i < 2500 && t < 60000; i++) {
      if (o.y + d.y * t <= terrain.heightAt(o.x + d.x * t, -(o.z + d.z * t))) {
        let a = t - step, c = t;
        for (let k = 0; k < 20; k++) { const m = (a + c) / 2; if (o.y + d.y * m <= terrain.heightAt(o.x + d.x * m, -(o.z + d.z * m))) c = m; else a = m; }
        const [lon, lat] = localToLonLat(frame, o.x + d.x * c, -(o.z + d.z * c));
        return { lat, lon };
      }
      t += step; step *= 1.04;
    }
    return null;
  }
  function groundAtClient(cx, cy) {
    const rect = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1), camera);
    return groundPoint();
  }
  listen(canvas, 'pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
    const rect = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), camera);
    if (pickCb) { const p = groundPoint(); if (p) { const cb = pickCb; pickCb = null; canvas.style.cursor = ''; cb(p); } return; }
    const hit = ray.intersectObjects(tiles.buildingGroup.children.filter((m) => m.visible), false)[0];
    if (!hit) { o.onPick(null, groundPoint()); return; }
    o.onPick(describeHit(hit, e.clientX, e.clientY));
  });
  function describeHit(hit, px, py) {
    const ud = hit.object.userData, tri = hit.faceIndex * 3;
    let lo = 0, hi = ud.bH.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ud.bStart[m] <= tri) lo = m; else hi = m - 1; }
    const c = ud.bCls[lo];
    const ia = hit.object.geometry.index.array, pa = hit.object.geometry.attributes.position.array;
    let sx = 0, sz = 0, cn = 0;
    for (let t = ud.bStart[lo]; t < ud.bStart[lo + 1]; t++) { const vi = ia[t]; sx += pa[vi * 3]; sz += pa[vi * 3 + 2]; cn++; }
    const [clon, clat] = localToLonLat(frame, sx / (cn || 1), -(sz / (cn || 1)));
    let blat = clat, blon = clon;
    if (ud.cent) { const [a, b2] = localToLonLat(frame, ud.cent[lo * 2], ud.cent[lo * 2 + 1]); blat = b2; blon = a; }
    return {
      lat: clat, lon: clon, blat, blon, gid: (ud.ids && ud.ids[lo]) || '',
      x: px, y: py, kind: CLASS_NAMES[c & 0x7f] || 'Building', name: ud.names[lo] || '', height: Math.round(ud.bH[lo]),
      mapped: (c & 0x80) !== 0, elevation: Math.round(ud.bBase[lo] + 1 + BASE), source: ud.source,
    };
  }
  // pick the building at a place on the map (for share links and ID search); true once a building is found there
  function selectAt(lat, lon) {
    const [x, y] = lonLatToLocal(frame, lon, lat), meshes = tiles.buildingGroup.children.filter((m) => m.visible);
    for (const [dx, dy] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, 2], [2, -2], [-2, -2]]) {
      ray.set(new THREE.Vector3(x + dx, 3000, -(y + dy)), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObjects(meshes, false)[0];
      if (hit) { o.onPick(describeHit(hit)); return true; }
    }
    return false;
  }

  // ---------------------------------------------------------------- quality, shadows, resize
  sun.shadow.camera.near = 10; sun.shadow.camera.far = 14000;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 1.5;
  const _sr = new THREE.Vector3(), _su = new THREE.Vector3(), _sc = new THREE.Vector3();
  function updateShadowFrustum(now) {
    if (!sun.castShadow) { renderer.shadowMap.needsUpdate = false; return; }
    const R = Math.round(clamp(camera.position.distanceTo(controls.target) * 0.85, 280, Q.shadowMax || 1500) / 40) * 40;
    const texel = (2 * R) / sun.shadow.mapSize.x, t = controls.target;
    _sr.crossVectors(sunDir, _up).normalize(); _su.crossVectors(_sr, sunDir).normalize();
    // snap the light's centre to whole texels so edges do not shimmer as the camera moves
    _sc.set(0, 0, 0).addScaledVector(_sr, Math.round(t.dot(_sr) / texel) * texel).addScaledVector(_su, Math.round(t.dot(_su) / texel) * texel).addScaledVector(sunDir, t.dot(sunDir));
    const moved = _sc.distanceToSquared(shadowC) > (R * 0.05) ** 2;
    const carsMove = trafficOn && trafficMode === 'sim' && now - shadowAt > 250;      // moving vehicles: a few refreshes a second
    if (!(R !== shadowR || shadowDirty || moved || tiles.version !== shadowVer || carsMove)) return;
    const busy = flyAnim || tiles.pending() > 0;                 // while moving or loading, redraw shadows at most 5 times a second
    if (now - shadowAt < Math.max(Q.shadowEvery || 0, busy ? 0.2 : 0) * 1000) return;
    const sc = sun.shadow.camera;
    if (sc.right !== R) { sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.updateProjectionMatrix(); sun.shadow.normalBias = 0.5 + R / 650; }
    sun.target.position.copy(_sc); sun.target.updateMatrixWorld();
    sun.position.copy(_sc).addScaledVector(sunDir, 6000);
    shadowC.copy(_sc); shadowR = R; shadowDirty = false; shadowVer = tiles.version; shadowAt = now;
    renderer.shadowMap.needsUpdate = true;
  }
  function resize() {
    [W, H] = size();
    renderer.setSize(W, H, false);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(W, H);
    camera.aspect = W / H; camera.updateProjectionMatrix();
    for (const L of labels) L.w = 0;
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  cleanups.push(() => ro.disconnect());

  function setQuality(name, auto) {
    qName = name; Q = QUALITY[name]; autoQuality = auto; tiles.q = Q; shadowDirty = true;
    renderer.setPixelRatio(Math.min(devicePixelRatio, Q.pr) * resScale);
    resize();
    sun.shadow.mapSize.set(Q.shadows || 1024, Q.shadows || 1024);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    bloom.enabled = Q.bloom;
    const aoSamples = name === 'ultra' ? 12 : 8;                  // High: a lighter ambient-occlusion pass
    gtao.updateGtaoMaterial({ samples: aoSamples }); gtao.updatePdMaterial({ samples: aoSamples });
    const waveN = { lite: 4, low: 5, medium: 6, high: 8, ultra: 12 }[name] || 8;           // waves in the water shader: the biggest cost on weaker graphics cards
    U.uWaveN.value = waveN; U.uWaveR.value = Math.pow(10, 1 / (waveN - 1));                    // same range of wave sizes, spread over fewer waves
    U.uGlint.value = name === 'high' || name === 'ultra' ? 1600 : 700;      // sharper sun sparkles on the water where the machine can afford the detail
    trafficVersion = -1;
    if (carMesh && carMesh.userData.n !== Q.cars) { scene.remove(carMesh, busMesh, lightMesh); carMesh.dispose(); busMesh.dispose(); lightMesh.dispose(); carMesh = busMesh = lightMesh = null; }
    applyTime();
    o.onQuality({ name, auto });
  }

  // ---------------------------------------------------------------- auto quality
  // Median frame time over 1.5 s windows (loading hitches over 500 ms are ignored). Two slow windows in a row step one
  // rung down (two if very slow); if stepping down does not help, go back and relax the target instead of spiralling;
  // a run of fast windows climbs again, and quickly repeated climbs make the next one wait longer.
  const gov = { dts: [], js: [], t0: 0, hold: 0, good: 0, bad: 0, need: 4, slow: 34, fast: 21, lastDown: null, origin: 0, futile: 0, climbedAt: -1e9 };
  const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  function applyRung(i, now) {
    rung = clamp(i, 0, LADDER.length - 1);
    gov.hold = now + 2500; gov.good = gov.bad = 0;
    const [name, scale] = LADDER[rung];
    resScale = scale;
    if (name !== qName) setQuality(name, true);
    else { renderer.setPixelRatio(Math.min(devicePixelRatio, Q.pr) * resScale); resize(); }
    try { localStorage.setItem('hyd3d.rung', JSON.stringify(rung)); } catch { /* no storage */ }
  }
  function govSample(now, dtMs, jsMs) {
    if (dtMs > 500) { gov.dts.length = gov.js.length = 0; gov.t0 = now; return; }
    gov.dts.push(dtMs); gov.js.push(jsMs);
    if (now - gov.t0 < 1500 || gov.dts.length < 10) return;
    const j = median(gov.dts), jj = median(gov.js);
    gov.dts.length = gov.js.length = 0; gov.t0 = now;
    if (now < gov.hold) return;
    if (j > gov.slow) {
      gov.good = 0;
      if (++gov.bad < 2 && j < 55) return;
      if (gov.lastDown && j > gov.lastDown * 0.9) gov.futile++; else gov.futile = 0;
      if (gov.futile >= 2) { gov.slow = j * 1.35; gov.fast = j * 1.08; gov.futile = 0; gov.lastDown = null; applyRung(gov.origin, now); return; }
      const floor = j < 55 ? rungOf('lite') + 1 : 0;
      if (rung <= floor) return;
      let q = rung - (j > 55 ? 2 : 1);
      if (jj > j * 0.6) { let k = rung - 1; while (k > 0 && LADDER[k][0] === LADDER[rung][0]) k--; q = Math.min(q, k); }   // CPU-bound: a lower resolution will not help
      q = Math.max(floor, q);
      if (gov.lastDown === null) gov.origin = rung;
      gov.lastDown = j;
      if (now - gov.climbedAt < 20000) gov.need = Math.min(40, gov.need * 2);
      applyRung(q, now);
    } else {
      gov.bad = 0; gov.futile = 0; gov.lastDown = null;
      if (j >= gov.fast) { gov.good = 0; return; }
      if (++gov.good < gov.need || rung >= LADDER.length - 1 || jj > 9) return;
      gov.climbedAt = now; applyRung(rung + 1, now);
    }
  }

  // ---------------------------------------------------------------- loop
  setQuality(qName, autoQuality);
  o.onProgress(0.3, 'Raising the buildings');

  const clock = new THREE.Clock();
  const t0 = performance.now();
  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4();
  let lastJs = 0, labelFrame = 0;
  let raf = 0, tileTimer = 1, liveTimer = 0, statTimer = 0, viewTimer = 0, fpsT = 0, fpsN = 0, autoChecks = 0, ready = false;
  function tick() {
    raf = requestAnimationFrame(tick);
    const frameStart = performance.now();
    const raw = clock.getDelta(), dt = Math.min(raw, 0.1);
    if (autoQuality && ready && !document.hidden) govSample(frameStart, raw * 1000, lastJs);
    U.uTime.value += dt;
    if (keys.size) flyAnim = null;
    flyKeys(dt);
    updateFly(dt);
    tiles.hold = !!(flyAnim && flyAnim.arc > 800 && flyAnim.t < 0.72);
    updateNorth(dt);
    controls.update();
    keepInBounds();
    const camH = camera.position.y - groundZ(camera.position.x, camera.position.z);
    camera.near = clamp(camH * 0.02, 1, 60); camera.updateProjectionMatrix();
    sky.position.copy(camera.position);
    scene.fog.density = fogBase / (1 + camH / 2500);
    U.uSunView.value.copy(sunDir).transformDirection(camera.matrixWorldInverse);

    if (timeAnim) {
      timeAnim.t = Math.min(1, timeAnim.t + dt / 1.2);
      let a = timeAnim.from, b = timeAnim.to;
      if (Math.abs(b - a) > 12) b += b < a ? 24 : -24;
      timeH = (a + (b - a) * smooth(0, 1, timeAnim.t) + 24) % 24;
      applyTime();
      if (timeAnim.t >= 1) timeAnim = null;
    } else if (liveTime && (liveTimer += dt) > 10) { liveTimer = 0; timeH = istNow().hours; applyTime(); }
    updateShadowFrustum(performance.now());

    if ((tileTimer += dt) > 0.25) {
      tileTimer = 0;
      camera.updateMatrixWorld();
      pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pv);
      tiles.update(camera, frustum);
    }
    tiles.stagger = ready;                                   // during the first load everything may appear at once
    tiles.pump(5);
    if (!flyAnim && tiles.version !== trafficVersion && (trafficTimer += dt) > 1.5) { trafficTimer = 0; trafficVersion = tiles.version; rebuildTraffic(); rebuildTrains(); }
    updateTraffic(dt); updateTrains(dt);
    if (lightMesh) lightMesh.visible = carMesh.visible && U.uNight.value > 0.15;
    lightMat.color.setScalar(2.5 * U.uNight.value);
    if ((labelFrame++ & 1) === 0) updateLabels();          // labels move slowly enough to refresh every other frame
    updatePins();
    if (needle) needle.style.transform = `rotate(${(-controls.getAzimuthalAngle() * 180 / Math.PI).toFixed(1)}deg)`;
    const glow = Q.bloom && U.uNight.value > 0.05;
    gtao.enabled = !!Q.ao;
    if (glow || Q.ao) composer.render(dt); else renderer.render(scene, camera);

    if ((viewTimer += dt) > 0.3) { viewTimer = 0; const [vlon, vlat] = localToLonLat(frame, controls.target.x, -controls.target.z); const dx = camera.position.x - controls.target.x, dz = camera.position.z - controls.target.z; o.onView && o.onView({ lat: vlat, lon: vlon, eye: camH, range: camera.position.distanceTo(controls.target), az: Math.atan2(dx, dz), tilt: Math.atan2(camera.position.y - controls.target.y, Math.hypot(dx, dz) || 1) }); }
    if ((statTimer += dt) > 1) { statTimer = 0; o.onStats({ ...tiles.stats(), release: sources.release, overture: !!sources.overture, ofm: !!sources.ofm }); }
    if (!ready) {
      const p = tiles.progress();
      const frac = p.leaves ? (p.covered + p.ready) / (2 * p.leaves) : 0;
      o.onProgress(0.3 + 0.7 * frac, `Raising the buildings · ${p.ready} of ${p.leaves} map tiles`);
      if ((p.leaves && p.covered === p.leaves && p.ready / p.leaves > 0.35) || performance.now() - t0 > 15000) { ready = true; o.onReady(); }
    }
    lastJs = performance.now() - frameStart;
  }
  raf = requestAnimationFrame(tick);

  return {
    sources,
    setLayer(name, on) {
      if (name === 'labels') showLabels = on;
      if (name === 'pins') showPins = on;
      if (name === 'traffic') this.setTraffic(on ? 'sim' : 'off');
    },
    /** 'off' hides vehicles, 'sim' moves them, 'static' shows them standing still */
    setTraffic(mode) {
      trafficMode = mode; trafficOn = mode !== 'off'; trafficDirty = true;
      if (carMesh) carMesh.visible = busMesh.visible = trafficOn;
      for (const p of trainParts) p.body.visible = p.win.visible = trafficOn && trains.length > 0;
    },
    flyTo,
    selectAt,
    /** edits made in the app: { hide: [[lat, lon]], tanks: [[lat, lon]], roads: [{ cls, points: [[lat, lon], ...] }] }, added to the ones in edits.js */
    setMapEdits(m) {
      const flat = (l) => (l || []).flatMap(([la, lo]) => lonLatToLocal(frame, lo, la));
      tiles.setEdits({
        hide: [...baseEdits.hide, ...flat(m.hide)], tanks: [...baseEdits.tanks, ...flat(m.tanks)],
        roads: [...baseEdits.roads, ...(m.roads || []).map((r) => ({ cls: r.cls, pts: flat(r.points) }))],
      });
    },
    /** the next click on the ground (not on the camera drag) calls cb({ lat, lon }); one shot */
    pickGround(cb) { pickCb = cb; canvas.style.cursor = 'crosshair'; },
    cancelPick() { pickCb = null; canvas.style.cursor = ''; },
    // heights typed in by the user in edit mode: [[lat, lon, metres], ...]
    setHeightFixes(list) { tiles.setFixes(list.map(([lat, lon, h]) => { const [x, y] = lonLatToLocal(frame, lon, lat); return { x, y, h }; })); },
    setNeedle(el) { needle = el; },
    /** current look-at point and camera distance, to save as a place */
    view() { const [lon, lat] = localToLonLat(frame, controls.target.x, -controls.target.z); return { lat, lon, range: camera.position.distanceTo(controls.target) }; },
    zoomBy, tiltStep, resetView, setView: applyView,
    /** map pins: [{id, lat, lon, name, kind: 'saved' | 'result', h?}] replaces the current set */
    setPins(list) { setPinList(list); },
    setTime(h) { liveTime = false; timeAnim = null; timeH = h; applyTime(); },
    preset(name) {
      if (name === 'now') { liveTime = true; timeAnim = { from: timeH, to: istNow().hours, t: 0 }; return; }
      liveTime = false;
      const to = { sunrise: findSunTime(2, true, DOY, CENTER.lat, CENTER.lon), midday: 12.4, golden: findSunTime(7, false, DOY, CENTER.lat, CENTER.lon), night: 21 }[name];
      timeAnim = { from: timeH, to, t: 0 };
    },
    setQuality(name) {
      if (name === 'auto') { rung = initialRung(true); resScale = LADDER[rung][1]; gov.hold = performance.now() + 2500; gov.bad = gov.good = 0; setQuality(LADDER[rung][0], true); }
      else { resScale = 1; setQuality(name, false); }
    },
    faceNorth() { northAnim = { from: controls.getAzimuthalAngle(), t: 0 }; },
    debug: { rawTrains: () => trains, trains: () => trains.map((t) => { const p = pointAt(t.l, t.s); return { x: p[0], y: p[1], s: Math.round(t.s), v: +t.v.toFixed(1), dwell: +t.dwell.toFixed(1) }; }), camera, controls, tiles, renderer, terrain, frame, THREE, traffic: () => ({ cars: cars.length, roads: roads.length, carMesh: !!carMesh, inScene: !!carMesh?.parent, trafficVersion, version: tiles.version, Qcars: Q.cars }) },
    dispose() {
      cancelAnimationFrame(raf);
      cleanups.forEach((f) => f());
      controls.dispose();
      tiles.disposeAll();
      labels.forEach((L) => L.el.remove());
      pins.forEach((P) => P.el.remove());
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
        mats.forEach((m) => m.dispose());
      });
      composer.dispose();
      renderer.dispose();
    },
  };
}

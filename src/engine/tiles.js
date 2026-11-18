// Streams map tiles around the camera as a quadtree: zoom 12 tiles far away, splitting
// into zoom 13 and zoom 14 (full building detail) close to the camera. A parent tile
// stays on screen until all its replacements are ready, so the ground never has holes.
import * as THREE from 'three';
import { tileBounds, tileAt } from './geo.js';

const MIN_Z = 12, MAX_Z = 14;

export class TileManager {
  constructor({ scene, frame, terrain, sources, makeGround, buildingMat, metroMat, pierMat, treeMat, roadMats, onLabels, maxAniso, renderer, junctionMat, walkMat, markMat, lampMat, poolMat }) {
    this.renderer = renderer;
    this.queue = [];             // finished tiles waiting to be turned into meshes, a few milliseconds per frame
    this.hold = false;           // true during a long camera flight: do not start detailed tiles for places we are only passing over
    Object.assign(this, { scene, frame, terrain, makeGround, buildingMat, metroMat, pierMat, treeMat, roadMats, onLabels, maxAniso });
    this.nodes = new Map();
    this.fixes = [];             // heights typed in by the user: { x, y, h } in local metres
    this.shown = new Set();
    this.jobs = new Map();
    this.jobId = 0;
    this.q = null;
    this.version = 0;            // bumps whenever the shown set changes
    // leave plenty of CPU for drawing: tile builders running on every core make the view stutter while they load
    const n = Math.min(Math.max(Math.round((navigator.hardwareConcurrency || 4) / 2), 2), 4);
    this.workers = [];
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./tileWorker.js', import.meta.url), { type: 'module' });
      w.busy = 0;
      w.postMessage({ type: 'init', frame, ofm: sources.ofm, overture: sources.overture, sat: sources.sat });
      w.onmessage = (e) => { w.busy--; const cb = this.jobs.get(e.data.id); this.jobs.delete(e.data.id); cb && cb(e.data); };
      this.workers.push(w);
    }
    this.junctionMat = junctionMat; this.lampMat = lampMat; this.poolMat = poolMat;
    this.poolGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    this.poleGeo = (() => {
      const pole = new THREE.CylinderGeometry(0.1, 0.14, 7.4, 5).translate(0, 3.7, 0).toNonIndexed(), arm = new THREE.BoxGeometry(0.12, 0.12, 1.3).translate(0, 7.4, 0.6).toNonIndexed(), head = new THREE.BoxGeometry(0.5, 0.14, 0.9).translate(0, 7.35, 1.2).toNonIndexed();
      const pos = [], col = [];
      for (const [g2, c] of [[pole, [0.22, 0.22, 0.24]], [arm, [0.22, 0.22, 0.24]], [head, [1, 0.88, 0.6]]]) { pos.push(...g2.attributes.position.array); for (let i = 0; i < g2.attributes.position.count; i++) col.push(...c); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals(); return g;
    })();
    this.walkMat = walkMat || new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -10 });
    this.markMat = markMat || new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -14 });
    this.pierGeo = new THREE.BoxGeometry(2.2, 1, 2.2).translate(0, 0.5, 0);
    this.capGeo = new THREE.BoxGeometry(7.2, 1.6, 2.6);       // hammerhead cap under the metro girder
    // tree: a low-poly canopy on a short trunk (one mesh, vertex-coloured trunk)
    const merge = (parts) => {                         // parts: [geometry, [r,g,b] vertex colour] -> one coloured geometry
      const pos = [], col = [];
      for (const [geo, c] of parts) { const ng = geo.index ? geo.toNonIndexed() : geo; pos.push(...ng.attributes.position.array); for (let i = 0; i < ng.attributes.position.count; i++) col.push(...c); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals(); return g;
    };
    const TR = [0.55, 0.45, 0.38], W = [1, 1, 1];
    // species: 0 round canopy (neem, mango), 1 wide umbrella (rain tree), 2 tall narrow (ashoka, eucalyptus), 3 coconut / date palm
    const fronds = [];
    for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2; fronds.push([new THREE.BoxGeometry(0.55, 0.12, 3.4).translate(0, 0, 1.8).rotateX(0.5).rotateY(a).translate(0, 7.2, 0), W]); }
    this.treeSpecies = [
      merge([[new THREE.IcosahedronGeometry(1, 0).scale(2.6, 2.2, 2.6).translate(0, 4.4, 0), W], [new THREE.CylinderGeometry(0.22, 0.3, 2.6, 5).translate(0, 1.3, 0), TR]]),
      merge([[new THREE.IcosahedronGeometry(1, 0).scale(4.2, 1.5, 4.2).translate(0, 5.4, 0), W], [new THREE.CylinderGeometry(0.25, 0.38, 4.2, 5).translate(0, 2.1, 0), TR]]),
      merge([[new THREE.IcosahedronGeometry(1, 0).scale(1.5, 4.6, 1.5).translate(0, 5.4, 0), W], [new THREE.CylinderGeometry(0.18, 0.26, 2.2, 5).translate(0, 1.1, 0), TR]]),
      merge([[new THREE.CylinderGeometry(0.14, 0.24, 7.2, 5).translate(0, 3.6, 0), TR], ...fronds]),
    ];
    this.treeGeo = (() => {
      const crown = new THREE.IcosahedronGeometry(1, 0).scale(2.6, 2.2, 2.6).translate(0, 4.4, 0);
      const trunk = new THREE.CylinderGeometry(0.22, 0.3, 2.6, 5).translate(0, 1.3, 0).toNonIndexed();
      const pos = [...crown.attributes.position.array, ...trunk.attributes.position.array];
      const col = [...new Array(crown.attributes.position.count).fill([1, 1, 1]).flat(), ...new Array(trunk.attributes.position.count).fill([0.55, 0.45, 0.38]).flat()];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.computeVertexNormals();
      return g;
    })();
    this.treeColors = ['#3d5a2a', '#4a7a2e', '#5c8a34', '#2f4d26', '#6e8f3c', '#3f6a30', '#86a03e', '#557a3a', '#8a8a3c', '#2b5a3a'].map((c) => new THREE.Color(c));
    this.tankGeo = new THREE.CylinderGeometry(0.72, 0.72, 1.5, 10).translate(0, 0.75, 0);
    this.roomGeo = new THREE.BoxGeometry(3.2, 2.6, 3.6).translate(0, 1.3, 0);
    this.tankMat = new THREE.MeshLambertMaterial({ color: 0x232527 });
    this.roomMat = new THREE.MeshLambertMaterial({ color: 0xd2cec6 });
    this.shared = new Set([this.poolGeo, this.poleGeo, this.pierGeo, this.capGeo, this.treeGeo, ...this.treeSpecies, this.tankGeo, this.roomGeo]);
    this.buildingGroup = new THREE.Group();
    scene.add(this.buildingGroup);
  }

  node(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let n = this.nodes.get(key);
    if (!n) { n = { key, z, x, y, b: tileBounds(this.frame, z, x, y), state: 'idle', group: null, used: 0 }; this.nodes.set(key, n); }
    return n;
  }
  parent(n) { return n.z > MIN_Z ? this.node(n.z - 1, n.x >> 1, n.y >> 1) : null; }
  children(n) { return [0, 1, 2, 3].map((i) => this.node(n.z + 1, n.x * 2 + (i & 1), n.y * 2 + (i >> 1))); }

  update(camera, frustum) {
    const q = this.q, cx = camera.position.x, cy = -camera.position.z;
    const camH = Math.max(0, camera.position.y - this.terrain.heightAt(cx, cy));
    const dist = (b) => Math.hypot(Math.max(b.x0 - cx, 0, cx - b.x1), Math.max(b.y0 - cy, 0, cy - b.y1), camH);
    const split = { 12: q.r13, 13: q.r14 };
    const far = q.far + camH * 0.8;
    const leaves = [];
    const [ax, ay] = tileAt(this.frame, cx - far, cy + far, MIN_Z), [bx, by] = tileAt(this.frame, cx + far, cy - far, MIN_Z);
    const visit = (n) => {
      n.d = dist(n.b);
      if (n.z < MAX_Z && n.d < split[n.z]) this.children(n).forEach(visit);
      else leaves.push(n);
    };
    for (let x = ax; x <= bx; x++) for (let y = ay; y <= by; y++) { const n = this.node(MIN_Z, x, y); n.d = dist(n.b); if (n.d <= far) visit(n); }

    // what to show: ready leaves, otherwise the nearest ready ancestor, otherwise ready children
    let fresh = this.stagger ? 2 : 1e9;              // brand-new tiles allowed on screen in this update
    const isReady = (n) => {
      if (n.state !== 'ready') return false;
      if (n.seen) return true;
      if (fresh-- > 0) { n.seen = true; return true; }
      return false;
    };
    const shown = new Set(), cover = new Set();
    leaves.sort((a, b) => a.d - b.d);                // nearest first, so they get the allowance
    for (const l of leaves) {
      if (isReady(l)) { shown.add(l); continue; }
      let a = this.parent(l);
      while (a && !(a.state === 'ready' && a.seen)) a = this.parent(a);
      if (a) { cover.add(a); continue; }
      if (l.z < MAX_Z) { const ch = this.children(l); if (ch.every((c) => c.state === 'ready' && c.seen)) ch.forEach((c) => shown.add(c)); }
    }
    for (const a of cover) shown.add(a);
    for (const s of [...shown]) { let a = this.parent(s); while (a) { if (cover.has(a)) { shown.delete(s); break; } a = this.parent(a); } }

    const now = performance.now();
    let changed = shown.size !== this.shown.size;
    for (const n of this.nodes.values()) {
      if (!n.group) continue;
      const vis = shown.has(n);
      if (vis) n.used = now;
      if (n.group.visible !== vis) { n.group.visible = vis; if (n.bMesh) n.bMesh.visible = vis; changed = true; }
    }
    if (changed) this.version++;
    this.shown = shown;

    // requests: the zoom-12 cover first (fast, fills the view), then leaves by distance
    const want = new Map();
    for (const l of leaves) {
      let r = l; while (r.z > MIN_Z) r = this.parent(r);
      if (r.state === 'idle') want.set(r, r.d * 0.3);
      if (l.state === 'idle') {
        const vis = frustum.intersectsBox(new THREE.Box3(new THREE.Vector3(l.b.x0, -200, -l.b.y1), new THREE.Vector3(l.b.x1, 600, -l.b.y0)));
        want.set(l, l.d * (vis ? 1 : 3));
      }
    }
    let free = this.queue.length > 6 ? 0 : this.workers.length - this.jobs.size - this.queue.length;
    for (const [n] of [...want].sort((a, b) => a[1] - b[1])) { if (this.hold && n.z > MIN_Z) continue; if (free-- <= 0) break; this.request(n); }

    // evict hidden tiles beyond the cache budget, oldest first
    const leafSet = new Set(leaves), hidden = [], forget = far * 1.6;
    for (const [k, n] of this.nodes) {
      if (n.state === 'ready') { if (!shown.has(n)) hidden.push(n); }
      else if (n.state === 'idle' && !leafSet.has(n) && dist(n.b) > forget) this.nodes.delete(k);      // records are cheap to make again, so far-away idle ones go
    }
    if (hidden.length > q.cache) {
      hidden.sort((a, b) => a.used - b.used);
      for (const n of hidden.slice(0, hidden.length - q.cache)) this.dispose(n);
    }
    this.leaves = leaves;
  }

  async request(n, keep = false) {
    if (!keep) n.state = 'loading';                    // keep: rebuild a tile that stays on screen meanwhile
    const s = n.z - MIN_Z, rx = n.x >> s, ry = n.y >> s;
    let grid;
    try { grid = await this.terrain.padded(rx, ry); } catch { grid = new Float32Array(258 * 258).fill(this.terrain.fallback); }
    const id = ++this.jobId;
    const w = this.workers.reduce((a, b) => (a.busy <= b.busy ? a : b));
    w.busy++;
    this.jobs.set(id, (r) => { r.keep = keep; this.queue.push([n, r]); });
    const q = this.q;
    n.seg = n.z === MAX_Z ? q.seg : n.z === 13 ? 40 : 56;
    w.postMessage({ type: 'build', id, z: n.z, x: n.x, y: n.y, grid, gx: rx, gy: ry,
      opts: { canvas: n.z === MAX_Z ? q.canvas : Math.min(q.canvas, 512), seg: n.z === MAX_Z ? q.seg : n.z === 13 ? 40 : 56, trees: q.trees, fixes: this.fixesFor(n.b), hide: this.edits?.hide || [], tanks: this.edits?.tanks || [], roads: this.edits?.roads || [] } }, [grid.buffer]);
  }

  fixesFor(b) {
    const out = [];
    for (const f of this.fixes) if (f.x >= b.x0 - 10 && f.x < b.x1 + 10 && f.y >= b.y0 - 10 && f.y < b.y1 + 10) out.push(f.x, f.y, f.h);
    return out;
  }
  /** hand edits changed (hidden buildings, water tanks, added roads): rebuild the building tiles they touch */
  setEdits(next) {
    const pts = (e) => { const m = new Map(); const f = e.hide || []; for (let k = 0; k + 1 < f.length; k += 2) m.set('h' + f[k].toFixed(1) + ',' + f[k + 1].toFixed(1), [f[k], f[k + 1]]);
      const t = e.tanks || []; for (let k = 0; k + 1 < t.length; k += 2) m.set('t' + t[k].toFixed(1) + ',' + t[k + 1].toFixed(1), [t[k], t[k + 1]]);
      for (const r of e.roads || []) { let mx = 0, my = 0; const c = r.pts.length / 2; for (let i = 0; i < c; i++) { mx += r.pts[i * 2]; my += r.pts[i * 2 + 1]; } m.set('r' + r.cls + r.pts.map((v) => v.toFixed(1)).join(';'), [mx / c, my / c]); }
      return m; };
    const a = pts(this.edits || {}), b = pts(next), changed = [];
    for (const [k, v] of a) if (!b.has(k)) changed.push(v);
    for (const [k, v] of b) if (!a.has(k)) changed.push(v);
    this.edits = next;
    for (const [x, y] of changed) {
      for (const n of this.nodes.values()) {
        if (n.z < 13 || n.state !== 'ready' || n.refreshing) continue;
        if (x >= n.b.x0 - 12 && x < n.b.x1 + 12 && y >= n.b.y0 - 12 && y < n.b.y1 + 12) { n.refreshing = true; this.request(n, true); }
      }
    }
  }
  /** a new list of typed-in heights: rebuild the building tiles that contain a changed one */
  setFixes(list) {
    const key = (f) => `${f.x.toFixed(1)},${f.y.toFixed(1)},${f.h}`;
    const before = new Set(this.fixes.map(key)), after = new Set(list.map(key));
    const changed = [...this.fixes.filter((f) => !after.has(key(f))), ...list.filter((f) => !before.has(key(f)))];
    this.fixes = list;
    for (const f of changed) {
      for (const n of this.nodes.values()) {
        if (n.z < 13 || n.state !== 'ready' || n.refreshing) continue;
        if (f.x >= n.b.x0 && f.x < n.b.x1 && f.y >= n.b.y0 && f.y < n.b.y1) { n.refreshing = true; this.request(n, true); }
      }
    }
  }

  /** build meshes for finished tiles, but only for a few milliseconds per frame so arrivals never freeze the view */
  pump(budgetMs = 5) {
    const t0 = performance.now();
    for (;;) {
      if (!this.cur) {
        if (!this.queue.length) break;
        const [n, r] = this.queue.shift();
        this.cur = this.receive(n, r);                  // a generator: builds one tile in small steps
      }
      if (this.cur.next().done) this.cur = null;
      if (performance.now() - t0 > budgetMs) break;
    }
  }
  pending() { return this.queue.length + this.jobs.size + (this.cur ? 1 : 0); }

  *receive(n, r) {
    if (r.keep) n.refreshing = false;
    if (r.error && r.keep) return;                     // a failed rebuild keeps the old tile
    if (r.error) { console.warn('tile', n.key, r.error); n.state = 'idle'; n.retry = (n.retry || 0) + 1; if (n.retry > 2) n.state = 'error'; return; }
    const old = r.keep && n.group ? { group: n.group, bMesh: n.bMesh } : null;     // a rebuilt tile replaces this one once it is ready
    const g = new THREE.Group();
    g.visible = false;
    // ground
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(r.terrain.pos, 3));
    tg.setAttribute('normal', new THREE.BufferAttribute(r.terrain.nor, 3));
    tg.setAttribute('uv', new THREE.BufferAttribute(r.terrain.uv, 2));
    tg.setIndex(new THREE.BufferAttribute(r.terrain.idx, 1));
    tg.computeBoundingSphere();
    const tex = (bmp, srgb) => {
      const t = new THREE.Texture(bmp);
      t.flipY = false; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = srgb ? this.maxAniso : 1; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
      if (!srgb) { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; }      // masks: no mipmap chain
      return t;
    };
    const colorTex = tex(r.tex.color, true), auxTex = tex(r.tex.aux, false);
    if (this.renderer) { this.renderer.initTexture(colorTex); this.renderer.initTexture(auxTex); }   // upload now, inside the time budget, not when the tile first appears
    const ground = new THREE.Mesh(tg, this.makeGround(colorTex, auxTex));
    ground.receiveShadow = true;
    g.add(ground);
    yield;
    // buildings
    if (r.bld) {
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.BufferAttribute(r.bld.pos, 3));
      bg.setAttribute('normal', new THREE.BufferAttribute(r.bld.nor, 3, true));
      bg.setAttribute('color', new THREE.BufferAttribute(r.bld.col, 3, true));
      bg.setAttribute('uv', new THREE.BufferAttribute(r.bld.uv, 2));
      bg.setIndex(new THREE.BufferAttribute(r.bld.idx, 1));
      bg.computeBoundingSphere();
      const m = new THREE.Mesh(bg, this.buildingMat);
      m.castShadow = m.receiveShadow = true;
      m.visible = false;
      m.userData = { bStart: r.bld.bStart, bH: r.bld.bH, bCls: r.bld.bCls, bBase: r.bld.bBase, names: r.bld.names, ids: r.bld.ids, cent: r.bld.cent, source: r.source };
      n.bMesh = m;
      n.stats = { count: r.bld.count, mapped: r.bld.mapped };
      this.buildingGroup.add(m);
      // rooftop tanks and stair rooms
      const inst = (arr, geo, mat, rot) => {
        const cnt = arr.length / 4; if (!cnt) return;
        const im = new THREE.InstancedMesh(geo, mat, cnt), M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
        for (let i = 0; i < cnt; i++) {
          P.set(arr[i * 4], arr[i * 4 + 1], arr[i * 4 + 2]);
          if (rot) { Q.setFromAxisAngle(up, arr[i * 4 + 3]); S.set(1, 1, 1); } else { Q.identity(); S.setScalar(arr[i * 4 + 3]); }
          M.compose(P, Q, S); im.setMatrixAt(i, M);
        }
        im.castShadow = true; g.add(im);
      };
      inst(r.bld.tanks, this.tankGeo, this.tankMat, false);
      inst(r.bld.rooms, this.roomGeo, this.roomMat, true);
    } else n.stats = { count: 0, mapped: 0 };
    yield;
    // metro viaduct
    if (r.metro) {
      const mg = new THREE.BufferGeometry();
      mg.setAttribute('position', new THREE.BufferAttribute(r.metro.pos, 3));
      mg.setIndex(new THREE.BufferAttribute(r.metro.idx, 1));
      mg.computeVertexNormals();
      const deck = new THREE.Mesh(mg, this.metroMat);
      deck.castShadow = true; g.add(deck);
      const P = r.metro.piers, cnt = P.length / 5;     // per pier: x, ground, z, angle across the track, underside of the girder
      if (cnt) {
        const cols = new THREE.InstancedMesh(this.pierGeo, this.pierMat, cnt), caps = new THREE.InstancedMesh(this.capGeo, this.pierMat, cnt);
        const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), V = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
        for (let i = 0; i < cnt; i++) {
          const o = i * 5, gy = P[o + 1] - 1, top = P[o + 4];
          Q.setFromAxisAngle(up, P[o + 3]);
          S.set(1, Math.max(1, top - 1.7 - gy), 1); V.set(P[o], gy, P[o + 2]); M.compose(V, Q, S); cols.setMatrixAt(i, M);
          S.set(1, 1, 1); V.set(P[o], top - 0.8, P[o + 2]); M.compose(V, Q, S); caps.setMatrixAt(i, M);
        }
        cols.castShadow = caps.castShadow = true; g.add(cols, caps);
      }
    }
    yield;
    // road surfaces
    if (r.rib) r.rib.forEach((rb, i) => {
      if (!rb) return;
      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.BufferAttribute(rb.pos, 3));
      rg.setAttribute('uv', new THREE.BufferAttribute(rb.uv, 2));
      rg.setIndex(new THREE.BufferAttribute(rb.idx, 1));
      const nrm = new Float32Array(rb.pos.length); for (let q = 1; q < nrm.length; q += 3) nrm[q] = 1;
      rg.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      rg.computeBoundingSphere();
      const rm = new THREE.Mesh(rg, this.roadMats[i]);
      rm.receiveShadow = true; rm.renderOrder = 1 + (2 - i);
      g.add(rm);
    });
    yield;
    // street lamps: poles with a lit head, and a warm pool of light on the road beneath
    if (r.lamps && r.lamps.length && this.lampMat) {
      const A = r.lamps, cnt = A.length / 9;
      const poles = new THREE.InstancedMesh(this.poleGeo, this.lampMat, cnt), pools = new THREE.InstancedMesh(this.poolGeo, this.poolMat, cnt);
      const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
      for (let i = 0; i < cnt; i++) {
        const o = i * 9, th = A[o + 6];
        Q.setFromAxisAngle(up, th + (A[o + 8] < 0 ? Math.PI : 0)); S.set(1, 1, 1); P.set(A[o], A[o + 1], A[o + 2]); M.compose(P, Q, S); poles.setMatrixAt(i, M);
        Q.setFromAxisAngle(up, th); S.set(A[o + 7] * 1.3, 1, A[o + 7] * 0.95); P.set(A[o + 3], A[o + 4], A[o + 5]); M.compose(P, Q, S); pools.setMatrixAt(i, M);
      }
      poles.frustumCulled = pools.frustumCulled = true; pools.renderOrder = 9; poles.castShadow = false;
      g.add(poles, pools);
    }
    yield;
    // sidewalks, medians, junction patches, zebra crossings
    if (r.extras) {
      const mk = (e, mat, order, shadow) => {
        const eg = new THREE.BufferGeometry();
        eg.setAttribute('position', new THREE.BufferAttribute(e.pos, 3));
        if (e.col) eg.setAttribute('color', new THREE.BufferAttribute(e.col, 3));
        if (e.uv) {
          eg.setAttribute('uv', new THREE.BufferAttribute(e.uv, 2));
          const nrm = new Float32Array(e.pos.length); for (let q = 1; q < nrm.length; q += 3) nrm[q] = 1;
          eg.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
        } else eg.computeVertexNormals();
        eg.setIndex(new THREE.BufferAttribute(e.idx, 1));
        eg.computeBoundingSphere();
        const m = new THREE.Mesh(eg, mat); m.receiveShadow = shadow; m.renderOrder = order; g.add(m);
      };
      if (r.extras.disc) mk(r.extras.disc, (this.junctionMat || this.roadMats[2]), 6, true);
      if (r.extras.walk) mk(r.extras.walk, this.walkMat, 7, true);
      if (r.extras.marks) mk(r.extras.marks, this.markMat, 8, false);
    }
    yield;
    // bridge / flyover slabs and piers
    if (r.deck) {
      const dg = new THREE.BufferGeometry();
      dg.setAttribute('position', new THREE.BufferAttribute(r.deck.pos, 3));
      dg.setIndex(new THREE.BufferAttribute(r.deck.idx, 1));
      dg.computeVertexNormals();
      const slab = new THREE.Mesh(dg, this.metroMat);
      slab.castShadow = true; g.add(slab);
      const P = r.deck.piers, cnt = P.length / 4;
      if (cnt) {
        const piers = new THREE.InstancedMesh(this.pierGeo, this.pierMat, cnt);
        const M = new THREE.Matrix4();
        for (let i = 0; i < cnt; i++) { M.makeScale(1.6, P[i * 4 + 3], 1.6); M.setPosition(P[i * 4], P[i * 4 + 1], P[i * 4 + 2]); piers.setMatrixAt(i, M); }
        piers.castShadow = true; g.add(piers);
      }
    }
    for (const gm of [r.cable, r.lm]) {             // hand-built landmarks: cable-stayed bridge, Charminar
      if (!gm) continue;
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.BufferAttribute(gm.pos, 3));
      cg.setAttribute('color', new THREE.BufferAttribute(gm.col, 3));
      cg.setIndex(new THREE.BufferAttribute(gm.idx, 1));
      cg.computeVertexNormals();
      const mesh = new THREE.Mesh(cg, this.treeMat);
      mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh);
    }
    yield;
    // trees
    if (r.trees && r.trees.length) {
      const T = r.trees, cnt = T.length / 5;
      const spOf = (u) => (u < 0.52 ? 0 : u < 0.72 ? 1 : u < 0.88 ? 2 : 3);   // share of round / umbrella / tall / palm
      const buckets = [[], [], [], []];
      for (let i = 0; i < cnt; i++) buckets[spOf(T[i * 5 + 4])].push(i);
      const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
      const FLOWER = ['#c8502c', '#d9a62e'].map((x) => new THREE.Color(x));   // gulmohar, copper pod
      buckets.forEach((ids, sp) => {
        if (!ids.length) return;
        const trees = new THREE.InstancedMesh(this.treeSpecies[sp], this.treeMat, ids.length);
        ids.forEach((i, m) => {
          const u = T[i * 5 + 4], f = (u * 977) % 1, s = T[i * 5 + 3] * (sp === 3 ? 0.9 : 1);
          P.set(T[i * 5], T[i * 5 + 1], T[i * 5 + 2]); S.set(s, s * (0.85 + f * 0.4), s); Q.setFromAxisAngle(up, f * 6.28);
          M.compose(P, Q, S); trees.setMatrixAt(m, M);
          const base = sp === 0 && f > 0.93 ? FLOWER[f > 0.97 ? 1 : 0] : this.treeColors[Math.floor(f * 10) % this.treeColors.length];
          trees.setColorAt(m, c.copy(base).multiplyScalar(0.85 + 0.3 * ((i * 0.618) % 1)));
        });
        trees.castShadow = true; trees.receiveShadow = true;
        g.add(trees);
      });
    }
    yield;
    if (old) this.disposeParts(old.group, old.bMesh);
    n.roads = r.roads; n.tracks = r.metro ? r.metro.tracks : null;
    n.group = g;
    n.state = 'ready';
    n.used = performance.now();
    this.scene.add(g);
    if (r.labels.length) this.onLabels(r.labels, n.key);
  }

  disposeParts(group, bMesh) {
    if (group) {
      group.traverse((o) => {
        if (o.geometry && !this.shared.has(o.geometry)) o.geometry.dispose();
        if (o.material && o.material.userData.perTile) { o.material.map?.dispose(); o.material.userData.aux?.dispose(); o.material.dispose(); }
        if (o.isInstancedMesh) o.dispose();
      });
      this.scene.remove(group);
    }
    if (bMesh) { this.buildingGroup.remove(bMesh); bMesh.geometry.dispose(); }
  }
  dispose(n) {
    this.disposeParts(n.group, n.bMesh);
    n.group = null; n.bMesh = null; n.roads = null; n.tracks = null; n.state = 'idle';
    if (this.onTileGone) this.onTileGone(n.key);
  }

  /** The tile drawn at local (x, y) and the exact height of its ground there (same triangles as the mesh). */
  surfaceAt(x, y) {
    for (let z = MAX_Z; z >= MIN_Z; z--) {
      const [tx, ty] = tileAt(this.frame, x, y, z);
      const n = this.nodes.get(`${z}/${tx}/${ty}`);
      if (!n || !this.shown.has(n)) continue;
      const { b } = n, seg = n.seg, step = b.size / seg, T = this.terrain;
      let fx = (x - b.x0) / step, fy = (b.y1 - y) / step;
      fx = Math.min(Math.max(fx, 0), seg - 1e-6); fy = Math.min(Math.max(fy, 0), seg - 1e-6);
      const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
      const X0 = b.x0 + i * step, X1 = X0 + step, Y0 = b.y1 - j * step, Y1 = Y0 - step;
      const nw = T.heightAt(X0, Y0), ne = T.heightAt(X1, Y0), sw = T.heightAt(X0, Y1), se = T.heightAt(X1, Y1);
      const h = u + v <= 1 ? nw + u * (ne - nw) + v * (sw - nw) : se + (1 - u) * (sw - se) + (1 - v) * (ne - se);
      return { z, h };
    }
    return null;
  }

  /** shown tiles' road lines (zoom 13+) for traffic */
  roads() {
    const out = [];
    for (const n of this.shown) if (n.z === MAX_Z && n.roads) for (const r of n.roads) out.push(r);
    return out;
  }

  /** shown tiles' metro lines (zoom 14) for the trains */
  tracks() {
    const out = [];
    for (const n of this.shown) if (n.z === MAX_Z && n.tracks) for (const t of n.tracks) out.push(t);
    return out;
  }

  stats() {
    let count = 0, mapped = 0;
    for (const n of this.shown) if (n.stats) { count += n.stats.count; mapped += n.stats.mapped; }
    return { count, mapped };
  }

  progress() {
    const ls = this.leaves || [];
    const ready = ls.filter((l) => this.shown.has(l)).length;
    const covered = ls.filter((l) => { if (this.shown.has(l)) return true; let a = this.parent(l); while (a) { if (this.shown.has(a)) return true; a = this.parent(a); } return false; }).length;
    return { leaves: ls.length, ready, covered };
  }

  disposeAll() {
    this.queue.length = 0; this.cur = null;
    for (const n of this.nodes.values()) this.dispose(n);
    this.workers.forEach((w) => w.terminate());
    this.shared.forEach((g) => g.dispose());
  }
}

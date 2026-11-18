// Procedural textures, drawn once at start-up on a canvas (no image files to download).
//
// Facade atlas: 4 styles (columns) x 2 rows (upper floors, ground floor). Each cell is one bay
// (window column) by one floor. The colour texture is a brightness multiplier over the building's
// own paint colour; the mask texture marks glass (white) and signboards (grey) for curtains and night lights.
//   style 0  apartment with balcony and railing           (newer residential blocks)
//   style 1  window with a concrete sunshade (chajja)     (classic Indian houses and blocks)
//   style 2  glass curtain wall with mullions             (offices, IT parks)
//   style 3  small paired windows, pastel old-city look   (older neighbourhoods)
// Ground-floor row: rolling-shutter shops, a lobby, glass shopfront, and an old shop front.
import * as THREE from 'three';

const C = 256;   // cell size in pixels

function rnd(seed) { let s = seed; return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296; }; }

function grain(g, x, y, w, h, amount, seed) {
  const r = rnd(seed);
  for (let i = 0; i < (w * h) / 18; i++) {
    const v = r() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v},${v},${v},${amount * r()})`;
    g.fillRect(x + r() * w, y + r() * h, 1 + r() * 2, 1 + r() * 2);
  }
}

// window: frame + glass (alpha 255 inside)
function windowAt(g, a, x, y, w, h, frame = 6) {
  g.fillStyle = 'rgb(250,250,248)'; g.fillRect(x - frame, y - frame, w + frame * 2, h + frame * 2);
  g.fillStyle = 'rgb(60,62,66)'; g.fillRect(x, y, w, h);
  a.fillStyle = '#f00'; a.fillRect(x, y, w, h);
  g.fillStyle = 'rgb(200,200,198)'; g.fillRect(x + w / 2 - 2, y, 4, h);       // mullion
  a.fillStyle = '#000'; a.fillRect(x + w / 2 - 2, y, 4, h);
}

export function facadeAtlas(maxAniso) {
  const W = C * 6, H = C * 2;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const al = document.createElement('canvas'); al.width = W; al.height = H;
  const a = al.getContext('2d');
  g.fillStyle = 'rgb(232,232,230)'; g.fillRect(0, 0, W, H);
  a.fillStyle = '#000'; a.fillRect(0, 0, W, H);

  // ---------- upper floors (row 0 = top of the canvas = v 1..0 flipped below)
  // style 0: balcony
  {
    const x = 0, y = 0;
    g.fillStyle = 'rgb(90,88,86)'; g.fillRect(x + 20, y + 40, C - 40, 170);                // recess in shadow
    windowAt(g, a, x + 40, y + 60, C - 80, 110, 4);
    g.fillStyle = 'rgb(244,242,238)'; g.fillRect(x + 10, y + 180, C - 20, 50);              // balcony parapet
    g.fillStyle = 'rgb(205,203,198)'; g.fillRect(x + 10, y + 180, C - 20, 6);
    g.fillStyle = 'rgb(225,223,219)'; g.fillRect(x, y + 230, C, 26);                        // floor slab
    grain(g, x, y, C, C, 0.06, 11);
  }
  // style 1: window with chajja
  {
    const x = C, y = 0;
    windowAt(g, a, x + 64, y + 70, C - 128, 120, 8);
    g.fillStyle = 'rgb(252,252,250)'; g.fillRect(x + 44, y + 46, C - 88, 16);               // sunshade
    g.fillStyle = 'rgb(140,138,134)'; g.fillRect(x + 44, y + 62, C - 88, 8);                // its shadow
    g.fillStyle = 'rgb(218,216,212)'; g.fillRect(x, y + 238, C, 18);
    grain(g, x, y, C, C, 0.07, 12);
  }
  // style 2: curtain wall
  {
    const x = C * 2, y = 0;
    g.fillStyle = 'rgb(70,84,96)'; g.fillRect(x, y, C, C);
    a.fillStyle = '#f00'; a.fillRect(x, y, C, C);
    g.fillStyle = 'rgb(190,196,200)';
    for (const mx of [0, C / 2 - 3]) { g.fillRect(x + mx, y, 6, C); a.fillStyle = '#000'; a.fillRect(x + mx, y, 6, C); }
    g.fillRect(x, y + C - 22, C, 22); a.fillStyle = '#000'; a.fillRect(x, y + C - 22, C, 22);   // spandrel
    const grd = g.createLinearGradient(x, y, x + C, y + C);
    grd.addColorStop(0, 'rgba(255,255,255,0.18)'); grd.addColorStop(0.5, 'rgba(255,255,255,0)'); grd.addColorStop(1, 'rgba(255,255,255,0.1)');
    g.fillStyle = grd; g.fillRect(x, y, C, C);
  }
  // style 4: ribbon windows between concrete spandrels (mid-rise offices)
  {
    const x = C * 4, y = 0;
    g.fillStyle = 'rgb(226,224,220)'; g.fillRect(x, y, C, C);
    g.fillStyle = 'rgb(60,66,74)'; g.fillRect(x, y + 70, C, 130);
    a.fillStyle = '#f00'; a.fillRect(x, y + 70, C, 130);
    g.fillStyle = 'rgb(205,205,202)'; g.fillRect(x + C / 2 - 3, y + 70, 6, 130); a.fillStyle = '#000'; a.fillRect(x + C / 2 - 3, y + 70, 6, 130);
    g.fillStyle = 'rgb(150,150,148)'; g.fillRect(x, y + 200, C, 8);                          // ledge shadow
    g.fillStyle = 'rgb(236,235,232)'; g.fillRect(x, y + 62, C, 8);
    grain(g, x, y, C, C, 0.06, 15);
  }
  // style 5: punched windows in exposed concrete / plaster, deep reveals and an AC unit
  {
    const x = C * 5, y = 0;
    g.fillStyle = 'rgb(228,226,222)'; g.fillRect(x, y, C, C);
    for (const wx of [34, C - 34 - 84]) {
      g.fillStyle = 'rgb(120,118,114)'; g.fillRect(x + wx - 6, y + 56, 96, 142);              // reveal
      g.fillStyle = 'rgb(56,60,66)'; g.fillRect(x + wx, y + 66, 84, 122);
      a.fillStyle = '#f00'; a.fillRect(x + wx, y + 66, 84, 122);
      g.fillStyle = 'rgb(215,213,208)'; g.fillRect(x + wx + 40, y + 66, 4, 122); a.fillStyle = '#000'; a.fillRect(x + wx + 40, y + 66, 4, 122);
      g.fillStyle = 'rgb(198,196,190)'; g.fillRect(x + wx - 10, y + 190, 104, 10);            // sill
    }
    g.fillStyle = 'rgb(170,170,168)'; g.fillRect(x + C / 2 - 20, y + 150, 40, 30);            // AC unit between the windows
    g.fillStyle = 'rgb(120,120,118)'; g.fillRect(x + C / 2 - 16, y + 156, 32, 16);
    g.fillStyle = 'rgb(205,203,198)'; g.fillRect(x, y + 238, C, 18);
    grain(g, x, y, C, C, 0.12, 16);
    g.fillStyle = 'rgba(90,80,70,0.10)'; g.fillRect(x, y + 205, C, 33);
  }
  // style 3: old city, paired narrow windows
  {
    const x = C * 3, y = 0;
    windowAt(g, a, x + 38, y + 70, 64, 120, 6);
    windowAt(g, a, x + C - 102, y + 70, 64, 120, 6);
    g.fillStyle = 'rgb(205,200,190)'; g.fillRect(x, y + 230, C, 26);
    grain(g, x, y, C, C, 0.12, 13);
    g.fillStyle = 'rgba(120,100,80,0.12)'; g.fillRect(x, y + 200, C, 30);                    // monsoon staining
  }

  // ---------- ground floor
  const shutters = (x, y, col) => {
    g.fillStyle = 'rgb(70,70,72)'; g.fillRect(x + 10, y + 40, C - 20, C - 40);
    for (let k = 0; k < 24; k++) { g.fillStyle = k % 2 ? 'rgb(160,160,160)' : 'rgb(130,130,132)'; g.fillRect(x + 14, y + 90 + k * 6, C - 28, 3); }
    g.fillStyle = col; g.fillRect(x + 6, y + 20, C - 12, 46);                                 // signboard
    g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillRect(x + 30, y + 36, C - 90, 8); g.fillRect(x + 30, y + 50, C - 140, 6);
    a.fillStyle = '#0f0'; a.fillRect(x + 6, y + 20, C - 12, 46);                              // signs light up at night
  };
  shutters(0, C, 'rgb(190,40,40)');
  // lobby
  {
    const x = C, y = C;
    g.fillStyle = 'rgb(215,212,206)'; g.fillRect(x, y, C, C);
    windowAt(g, a, x + 60, y + 70, C - 120, 170, 8);
    g.fillStyle = 'rgb(170,166,160)'; g.fillRect(x, y + C - 12, C, 12);
  }
  // glass shopfront
  {
    const x = C * 2, y = C;
    g.fillStyle = 'rgb(40,46,52)'; g.fillRect(x, y + 50, C, C - 50);
    a.fillStyle = '#f00'; a.fillRect(x, y + 50, C, C - 50);
    g.fillStyle = 'rgb(30,110,150)'; g.fillRect(x, y + 10, C, 40);
    a.fillStyle = '#0f0'; a.fillRect(x, y + 10, C, 40);
  }
  shutters(C * 3, C, 'rgb(30,120,70)');
  shutters(C * 5, C, 'rgb(40,70,140)');
  {                                                  // style 4 ground floor: glazed lobby
    const x = C * 4, y = C;
    g.fillStyle = 'rgb(200,198,194)'; g.fillRect(x, y, C, C);
    g.fillStyle = 'rgb(40,46,52)'; g.fillRect(x + 20, y + 50, C - 40, C - 50); a.fillStyle = '#f00'; a.fillRect(x + 20, y + 50, C - 40, C - 50);
    g.fillStyle = 'rgb(190,190,188)'; g.fillRect(x + C / 2 - 3, y + 50, 6, C - 50); a.fillStyle = '#000'; a.fillRect(x + C / 2 - 3, y + 50, 6, C - 50);
  }

  // two textures (not RGB + alpha): canvas alpha is premultiplied and would wipe the colour
  const mk = (canvas) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.NoColorSpace;   // multipliers and masks, not colours
    t.anisotropy = maxAniso;
    return t;
  };
  return { color: mk(cv), mask: mk(al) };
}

// Road surfaces: 0 = major (4 lanes, edge lines), 1 = two-lane with centre dashes, 2 = plain lane.
// u runs across the road (0..1), v along it (one texture length = 24 m).
export function roadTexture(kind, maxAniso) {
  const w = 256, h = 512;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.fillStyle = 'rgb(66,66,68)'; g.fillRect(0, 0, w, h);
  grain(g, 0, 0, w, h, 0.18, 20 + kind);
  const r = rnd(40 + kind);
  for (let i = 0; i < 18; i++) { g.fillStyle = `rgba(40,40,40,${0.08 + r() * 0.12})`; g.beginPath(); g.ellipse(r() * w, r() * h, 6 + r() * 30, 10 + r() * 60, 0, 0, 7); g.fill(); }
  // gutters
  g.fillStyle = 'rgb(118,114,108)'; g.fillRect(0, 0, 8, h); g.fillRect(w - 8, 0, 8, h);
  const line = (x, dash, col = 'rgb(230,230,224)', lw = 5) => {
    g.fillStyle = col;
    if (!dash) g.fillRect(x - lw / 2, 0, lw, h);
    else for (let y = 0; y < h; y += 128) g.fillRect(x - lw / 2, y + 20, lw, 64);
  };
  if (kind === 0) { line(18, false); line(w - 18, false); line(w / 2 - 4, false, 'rgb(224,190,70)', 4); line(w / 2 + 4, false, 'rgb(224,190,70)', 4); line(w * 0.27, true); line(w * 0.73, true); }
  if (kind === 1) { line(w / 2, true); }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAniso;
  return t;
}

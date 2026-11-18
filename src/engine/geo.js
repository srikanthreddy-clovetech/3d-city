// Projection helpers. The scene uses a local metric frame centred on Hyderabad:
// x = metres east, y = metres north (three.js: X = x, Z = -y). It is Web Mercator
// scaled by cos(latitude) at the centre, which keeps distances true to within ~1%.
export const R = 6378137;
export const WORLD = 2 * Math.PI * R;

export function makeFrame(lat0, lon0) {
  const k = Math.cos((lat0 * Math.PI) / 180);
  const mx0 = mercX(lon0), my0 = mercY(lat0);
  return { lat0, lon0, k, mx0, my0 };
}

export const mercX = (lon) => (R * lon * Math.PI) / 180;
export const mercY = (lat) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

export function lonLatToLocal(f, lon, lat) {
  return [(mercX(lon) - f.mx0) * f.k, (mercY(lat) - f.my0) * f.k];
}

export function localToLonLat(f, x, y) {
  const mx = x / f.k + f.mx0, my = y / f.k + f.my0;
  return [(mx / R) * 180 / Math.PI, (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * 180 / Math.PI];
}

/** Local bounds of slippy tile z/x/y: { x0, x1, y0 (south), y1 (north), size } */
export function tileBounds(f, z, x, y) {
  const T = WORLD / 2 ** z;
  const left = -WORLD / 2 + x * T, top = WORLD / 2 - y * T;
  const x0 = (left - f.mx0) * f.k, y1 = (top - f.my0) * f.k, size = T * f.k;
  return { x0, x1: x0 + size, y0: y1 - size, y1, size };
}

/** Tile containing local point (x, y) at zoom z */
export function tileAt(f, x, y, z) {
  const T = WORLD / 2 ** z;
  const mx = x / f.k + f.mx0, my = y / f.k + f.my0;
  return [Math.floor((mx + WORLD / 2) / T), Math.floor((WORLD / 2 - my) / T)];
}

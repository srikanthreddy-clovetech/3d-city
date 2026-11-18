// Elevation from the free AWS Terrain Tiles (Terrarium PNG encoding), at zoom 12
// (about 36 m per pixel over Hyderabad). Heights are stored relative to BASE metres.
import { WORLD } from './geo.js';

export const TZ = 12;
export const BASE = 500;           // scene y = elevation - BASE
const URL_T = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

export class Terrain {
  constructor(frame) {
    this.f = frame;
    this.tiles = new Map();         // "x/y" -> Float32Array(256*256) | null (failed)
    this.pending = new Map();       // "x/y" -> Promise
    this.fallback = 40;             // used where no tile has loaded yet
  }

  load(x, y) {
    const key = `${x}/${y}`;
    if (this.tiles.has(key)) return Promise.resolve(this.tiles.get(key));
    if (this.pending.has(key)) return this.pending.get(key);
    const p = (async () => {
      try {
        const blob = await fetch(URL_T(TZ, x, y)).then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); });
        const img = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        const c = new OffscreenCanvas(256, 256).getContext('2d', { willReadFrequently: true });
        c.drawImage(img, 0, 0);
        const d = c.getImageData(0, 0, 256, 256).data;
        const h = new Float32Array(256 * 256);
        let sum = 0;
        for (let i = 0; i < h.length; i++) {
          h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768 - BASE;
          sum += h[i];
        }
        if (this.tiles.size === 0) this.fallback = sum / h.length;
        this.tiles.set(key, h);
        return h;
      } catch (e) {
        console.warn('terrain tile failed', key, e);
        this.tiles.set(key, null);
        return null;
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, p);
    return p;
  }

  /** Load the 3x3 block around a z12 tile and return a 258x258 grid padded by one pixel. */
  async padded(x, y) {
    await Promise.all([-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => this.load(x + dx, y + dy))));
    const g = new Float32Array(258 * 258);
    for (let j = 0; j < 258; j++) {
      for (let i = 0; i < 258; i++) g[j * 258 + i] = this.pixel(x * 256 + i - 1, y * 256 + j - 1);
    }
    return g;
  }

  /** Global pixel lookup at zoom 12, falling back to the nearest loaded tile's edge. */
  pixel(gx, gy) {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const t = this.tiles.get(`${tx}/${ty}`);
    if (t) return t[(gy - ty * 256) * 256 + (gx - tx * 256)];
    return this.fallback;
  }

  /** Bilinear height (scene units) at local x (east), y (north). */
  heightAt(x, y) {
    const T = WORLD / 2 ** TZ;
    const mx = x / this.f.k + this.f.mx0, my = y / this.f.k + this.f.my0;
    const gx = ((mx + WORLD / 2) / T) * 256 - 0.5, gy = ((WORLD / 2 - my) / T) * 256 - 0.5;
    const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
    const a = this.pixel(ix, iy), b = this.pixel(ix + 1, iy), c = this.pixel(ix, iy + 1), d = this.pixel(ix + 1, iy + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
}

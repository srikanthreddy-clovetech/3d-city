// Shareable links: the view (look-at point, distance, heading, tilt), the time of day and an optional selected building live in the page address.
//   #v=17.41560,78.47460,1200,0.80,0.70&t=14.50&b=HYD-1K2F-3M9Z      (lat, lon, range m, heading rad, tilt rad), hour in IST, building ID
import { parseCode } from './buildingId.js';
const num = (s) => (s == null || s === '' ? NaN : Number(s));

export function parseHash(hash) {
  const out = { view: null, t: null, b: null };
  try {
    const p = new URLSearchParams((hash || '').replace(/^#/, ''));
    const v = (p.get('v') || '').split(',').map(num);
    if (v.length >= 2 && v[0] > 16 && v[0] < 18.5 && v[1] > 77.3 && v[1] < 79.5) {
      out.view = { lat: v[0], lon: v[1], range: isFinite(v[2]) ? v[2] : 1200, az: isFinite(v[3]) ? v[3] : 0, tilt: isFinite(v[4]) ? v[4] : 0.8 };
    }
    const t = num(p.get('t'));
    if (isFinite(t) && t >= 0 && t <= 24) out.t = t;
    const b = parseCode(p.get('b'));
    if (b) out.b = { ...b, code: String(p.get('b')).trim().toUpperCase() };
  } catch { /* ignore a malformed link */ }
  return out;
}

export function buildHash(view, time, code) {
  if (!view) return '';
  const p = new URLSearchParams();
  p.set('v', [view.lat.toFixed(5), view.lon.toFixed(5), Math.round(view.range), view.az.toFixed(2), view.tilt.toFixed(2)].join(','));
  if (time && !time.live) p.set('t', time.hours.toFixed(2));
  if (code) p.set('b', code);
  return '#' + p.toString().replace(/%2C/g, ',');
}

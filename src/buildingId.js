// Building IDs. Every building gets a location code made from its footprint centre, e.g. HYD-1K2F-3M9Z.
// The code is the same in every data release and at every zoom level (the map's own building IDs can change between releases),
// and it can be turned back into a place on the map, so it works as a share link and as a search term.
const LAT0 = 16.9, LON0 = 78.0, STEP = 5e4;         // 2e-5 degrees, about 2 m
const enc = (n) => n.toString(36).toUpperCase().padStart(4, '0');

export function makeCode(lat, lon) {
  if (!isFinite(lat) || !isFinite(lon)) return '';
  const a = Math.round((lat - LAT0) * STEP), o = Math.round((lon - LON0) * STEP);
  if (a < 0 || o < 0 || a > 1679615 || o > 1679615) return '';
  return `HYD-${enc(a)}-${enc(o)}`;
}

export function parseCode(text) {
  const m = /^\s*HYD[-\s]?([0-9A-Z]{4})[-\s]?([0-9A-Z]{4})\s*$/i.exec(text || '');
  if (!m) return null;
  const lat = LAT0 + parseInt(m[1], 36) / STEP, lon = LON0 + parseInt(m[2], 36) / STEP;
  return lat > 16 && lat < 18.5 && lon > 77.3 && lon < 79.5 ? { lat, lon } : null;
}

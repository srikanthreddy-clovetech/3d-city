// Quick-jump places shown as chips above the time slider, plus saved buildings and map search.
// range = how far (m) the camera sits from the point after flying there.
export const PLACES = [
  { id: 'hussain-sagar', n: 'Hussain Sagar', lat: 17.4156, lon: 78.4746, range: 1100 },
  { id: 'charminar', n: 'Charminar', lat: 17.3616, lon: 78.4747, range: 650 },
  { id: 'golconda', n: 'Golconda Fort', lat: 17.3833, lon: 78.4011, range: 900 },
  { id: 'hitec', n: 'HITEC City', lat: 17.4504, lon: 78.3810, range: 1000 },
  { id: 'fin-district', n: 'Financial District', lat: 17.4140, lon: 78.3430, range: 1100 },
  { id: 'kokapet', n: 'Kokapet', lat: 17.4012, lon: 78.3389, range: 900 },
  { id: 'gachibowli', n: 'Gachibowli', lat: 17.4401, lon: 78.3489, range: 1000 },
  { id: 'banjara', n: 'Banjara Hills', lat: 17.4126, lon: 78.4390, range: 1000 },
  { id: 'jubilee', n: 'Jubilee Hills', lat: 17.4325, lon: 78.4071, range: 1000 },
  { id: 'secunderabad', n: 'Secunderabad', lat: 17.4337, lon: 78.5016, range: 1000 },
  { id: 'tank-bund', n: 'Tank Bund', lat: 17.4239, lon: 78.4738, range: 800 },
  { id: 'durgam', n: 'Durgam Cheruvu', lat: 17.4300, lon: 78.3895, range: 800 },
  { id: 'falaknuma', n: 'Falaknuma Palace', lat: 17.3313, lon: 78.4672, range: 700 },
  { id: 'osmania', n: 'Osmania University', lat: 17.4136, lon: 78.5281, range: 900 },
  { id: 'airport', n: 'Airport', lat: 17.2403, lon: 78.4294, range: 2200 },
];

const store = (key) => ({
  load() {
    try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
  },
  save(list) {
    try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* private mode: keep in memory only */ }
  },
});
const placeStore = store('hyd3d.places'), buildingStore = store('hyd3d.buildings');
export const loadCustomPlaces = () => placeStore.load().filter((p) => p && p.n && isFinite(p.lat) && isFinite(p.lon));
export const saveCustomPlaces = (list) => placeStore.save(list);
export const loadBuildings = () => buildingStore.load().filter((b) => b && b.id && isFinite(b.lat) && isFinite(b.lon));
export const saveBuildings = (list) => buildingStore.save(list);

/** distance in metres between two lat/lon points (good enough at city scale) */
export function metres(aLat, aLon, bLat, bLon) {
  const dy = (aLat - bLat) * 111320, dx = (aLon - bLon) * 111320 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

// ---- saved buildings
export const TYPES = ['Residential', 'Apartment', 'Commercial', 'Office', 'Retail / Mall', 'Industrial', 'Hospital', 'School / College', 'Hotel', 'Religious', 'Government', 'Other'];
export const typeFor = (kind) => ({ Residential: 'Residential', Commercial: 'Commercial', Industrial: 'Industrial', 'Public building': 'Government', 'Religious building': 'Religious' }[kind] || 'Other');

/** Accept "example.com/page" or "https://…"; only http(s) links are kept. Returns '' if it is not a usable link. */
export function cleanUrl(raw) {
  const s = (raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch { return ''; }
}

/** the saved record for the building at (lat, lon): the nearest one within 8 m */
export function findSaved(list, lat, lon) {
  let best = null, d0 = 8;
  for (const b of list) { const d = metres(lat, lon, b.lat, b.lon); if (d < d0) { d0 = d; best = b; } }
  return best;
}

// ---- map search (OpenStreetMap Nominatim: free, no key; called only when the user types a search)
export async function searchMap(q, signal) {
  const ask = async (text) => {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=in&accept-language=en'
      + '&viewbox=77.9,17.8,78.9,17.0&bounded=1&q=' + encodeURIComponent(text);
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('search failed');
    return res.json();
  };
  let rows = await ask(q);
  const words = q.trim().split(/\s+/);
  if (!rows.length && words.length > 2) rows = await ask(words.slice(0, 2).join(' '));     // too specific: try the first words
  return rows.map((r) => {
    const parts = (r.display_name || '').split(', ');
    return { id: 'm' + r.place_id, n: r.name || parts[0] || q, sub: parts.slice(1, 4).join(', '), lat: +r.lat, lon: +r.lon, range: 600, kind: 'map' };
  }).filter((r) => isFinite(r.lat) && isFinite(r.lon));
}

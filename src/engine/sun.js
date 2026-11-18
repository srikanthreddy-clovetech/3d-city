// Sun position for a given IST time and day of year (NOAA approximation, good to ~0.5°).
export function sunPosition(hoursIST, doy, latDeg, lonDeg) {
  const rad = Math.PI / 180;
  const decl = -23.44 * rad * Math.cos((2 * Math.PI / 365) * (doy + 10));
  const B = (2 * Math.PI * (doy - 81)) / 364;
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);   // minutes
  const solar = hoursIST + (4 * (lonDeg - 82.5) + eot) / 60;                       // IST meridian is 82.5° E
  const ha = (solar - 12) * 15 * rad, lat = latDeg * rad;
  const el = Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha));
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) + Math.PI;
  return { el, az };   // radians; azimuth clockwise from north
}

export function istNow() {
  const d = new Date();
  const ist = new Date(d.getTime() + (d.getTimezoneOffset() + 330) * 60000);
  const start = new Date(ist.getFullYear(), 0, 0);
  return { hours: ist.getHours() + ist.getMinutes() / 60 + ist.getSeconds() / 3600, doy: Math.floor((ist - start) / 86400000) };
}

// IST hour when the sun is `targetDeg` above the horizon, morning or evening
export function findSunTime(targetDeg, morning, doy, lat, lon) {
  let best = morning ? 6 : 18, bestErr = 9;
  for (let h = morning ? 4 : 15; h < (morning ? 9 : 20); h += 1 / 60) {
    const e = Math.abs(sunPosition(h, doy, lat, lon).el * 180 / Math.PI - targetDeg);
    if (e < bestErr) { bestErr = e; best = h; }
  }
  return best;
}

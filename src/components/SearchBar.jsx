import { useEffect, useMemo, useRef, useState } from 'react';
import { searchMap } from '../places.js';
import { parseCode } from '../buildingId.js';

const norm = (s) => (s || '').toLowerCase();

export default function SearchBar({ places, custom, buildings, onGo }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);       // dropdown (and, on phones, the whole bar)
  const [remote, setRemote] = useState({ q: '', rows: [], busy: false, failed: false });
  const [sel, setSel] = useState(0);
  const box = useRef(null), input = useRef(null);

  // what we already know: saved buildings, then places
  const local = useMemo(() => {
    const t = norm(q).trim();
    if (!t) return [...places, ...custom].slice(0, 15).map((p) => ({ id: p.id, n: p.n, sub: 'Famous place', lat: p.lat, lon: p.lon, range: p.range, kind: 'place' }));   // nothing typed yet: suggest the famous places
    const hits = [];
    const bc = parseCode(q);
    if (bc) hits.push({ id: q, n: q.trim().toUpperCase(), sub: 'Building ID · open on the map', lat: bc.lat, lon: bc.lon, range: 220, kind: 'building' });
    for (const b of buildings) {
      const hay = norm([b.name, b.type, b.url, ...(b.extra || []).flatMap((x) => [x.k, x.v])].join(' '));
      if (hay.includes(t)) hits.push({ id: b.id, n: b.name, sub: `Saved building · ${b.type}`, lat: b.lat, lon: b.lon, range: 220, kind: 'saved' });
    }
    for (const p of [...places, ...custom]) if (norm(p.n).includes(t)) hits.push({ id: p.id, n: p.n, sub: 'Place', lat: p.lat, lon: p.lon, range: p.range, kind: 'place' });
    return hits.slice(0, 8);
  }, [q, places, custom, buildings]);

  // online map search, only after a pause in typing (be gentle with the free service)
  useEffect(() => {
    const t = q.trim();
    if (t.length < 3) { setRemote({ q: '', rows: [], busy: false, failed: false }); return undefined; }
    const ac = new AbortController();
    const timer = setTimeout(async () => {
      setRemote((r) => ({ ...r, busy: true, failed: false }));
      try { const rows = await searchMap(t, ac.signal); setRemote({ q: t, rows, busy: false, failed: false }); }
      catch (e) { if (e.name !== 'AbortError') setRemote({ q: t, rows: [], busy: false, failed: true }); }
    }, 650);
    return () => { clearTimeout(timer); ac.abort(); };
  }, [q]);

  useEffect(() => {
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, []);

  const rows = [...local, ...remote.rows.filter((r) => !local.some((l) => Math.abs(l.lat - r.lat) < 1e-4 && Math.abs(l.lon - r.lon) < 1e-4))];
  useEffect(() => { setSel(0); }, [q, remote.rows.length]);

  const go = (r) => { onGo(r); setOpen(false); setQ(''); if (input.current) input.current.blur(); };
  const keys = (e) => {
    if (e.key === 'Escape') { setOpen(false); e.currentTarget.blur(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter' && rows[sel]) { e.preventDefault(); go(rows[sel]); }
  };

  const showDrop = open;
  const empty = q.trim().length === 0;
  return (
    <div className={`panel search${open ? ' open' : ''}`} ref={box} role="search">
      <button type="button" className="search-btn" aria-label="Search" onClick={() => { setOpen(true); setTimeout(() => input.current && input.current.focus(), 0); }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
      </button>
      <input
        ref={input} value={q} placeholder="Search places, buildings, addresses" aria-label="Search places, buildings and addresses"
        autoComplete="off" spellCheck="false"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={keys}
      />
      {q && <button type="button" className="search-clear" aria-label="Clear search" onClick={() => { setQ(''); input.current && input.current.focus(); }}>×</button>}
      {showDrop && (
        <ul className="results" role="listbox">
          {empty && <li className="note head">Famous places</li>}
          {rows.map((r, i) => (
            <li key={r.kind + r.id} role="option" aria-selected={i === sel}>
              <button type="button" className={i === sel ? 'on' : ''} onMouseEnter={() => setSel(i)} onClick={() => go(r)}>
                <span className={`dot ${r.kind}`} aria-hidden="true" />
                <span className="t"><b>{r.n}</b>{r.sub && <small>{r.sub}</small>}</span>
              </button>
            </li>
          ))}
          {!empty && remote.busy && <li className="note">Searching the map…</li>}
          {!empty && !remote.busy && rows.length === 0 && <li className="note">{q.trim().length < 3 ? 'Keep typing…' : remote.failed ? 'Map search is not reachable right now.' : 'No results.'}</li>}
          <li className="note foot">Addresses by OpenStreetMap Nominatim</li>
        </ul>
      )}
    </div>
  );
}

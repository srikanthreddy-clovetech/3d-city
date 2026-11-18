import { useEffect, useRef, useState } from 'react';

// Small credit in the bottom-right corner, shown when the side panel is closed. The OpenStreetMap credit is always
// visible; the rest of the credits open above it.
export default function Credits() {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="credits" ref={box}>
      {open && (
        <div className="panel credit-pop" role="note">
          © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors ·{' '}
          <a href="https://overturemaps.org" target="_blank" rel="noreferrer">Overture Maps</a> ·{' '}
          <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> ·{' '}
          <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> ·{' '}
          <a href="https://s2maps.eu" target="_blank" rel="noreferrer">Sentinel-2 cloudless by EOX</a>
        </div>
      )}
      <button type="button" className="credit-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)} title="Data and imagery credits">© OpenStreetMap contributors</button>
    </div>
  );
}

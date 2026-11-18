import { useRef, useState } from 'react';
import { metres } from '../places.js';
import MapEdits from './MapEdits.jsx';

const fmt = (h) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
const fmtDeg = (v, p, n) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? p : n}`;
const LEVELS = { lite: 'Lite', low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra' };
const PRESETS = [['sunrise', 'Sunrise', 'Sunrise'], ['midday', 'Midday', 'Midday'], ['golden', 'Golden', 'Golden hour'], ['night', 'Night', 'Night'], ['now', 'Now', 'Live time of day']];
const TRAFFIC = [['sim', 'Live', 'Vehicles drive around'], ['static', 'Parked', 'Vehicles stand still'], ['off', 'Off', 'Hide vehicles']];

function Switch({ on, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`sw${on ? ' on' : ''}`} onClick={onChange}><i /></button>
  );
}

// One panel for everything: where you are, places, time of day and map settings.
export default function SidePanel({ view, time, places, custom, layers, onToggle, traffic, onTraffic, quality, onQuality,
  onFly, onAdd, onRemove, onSlide, onPreset, onAbout, aboutOpen, editMode, onEditMode, showEditSwitch, mapEdits, drawing, onDraw, onDrawCancel, onDrawFinish, onSelectRoad, onRemoveEdit, onCopyEdits }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const chips = useRef(null);
  const all = [...places, ...custom.map((p) => ({ ...p, custom: true }))];

  // the nearest known place within 600 m is "where you are" and its chip lights up
  let here = null, best = 600;
  if (view) for (const p of all) { const d = metres(view.lat, view.lon, p.lat, p.lon); if (d < best) { best = d; here = p; } }

  const save = (e) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    onAdd(n); setName(''); setAdding(false);
    requestAnimationFrame(() => chips.current && chips.current.scrollTo({ left: chips.current.scrollWidth, behavior: 'smooth' }));
  };
  const scrollBy = (dx) => chips.current && chips.current.scrollBy({ left: dx, behavior: 'smooth' });

  return (
    <section className="panel sp" aria-label="Map controls">
      <header className="sp-head">
        <div className="sp-title">
          <h2>{here ? here.n : 'Hyderabad'}</h2>
</div>
      </header>

      {showEditSwitch && (
        <div className="sp-sec">
          <div className="sp-row">
            <span>Edit mode <small>Add and change details of buildings</small></span>
            <Switch on={editMode} onChange={() => onEditMode(!editMode)} label="Edit mode" />
          </div>
        </div>
      )}

      <div className="sp-sec">
        <h3>Go to a place</h3>
        <div className="places">
          {adding ? (
            <form className="add-form" onSubmit={save}>
              <input autoFocus value={name} maxLength={28} placeholder="Name this view, e.g. My office" aria-label="Name for the saved place"
                onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setAdding(false); setName(''); } }} />
              <button type="submit" className="btn save" disabled={!name.trim()}>Save</button>
              <button type="button" className="btn" aria-label="Cancel" onClick={() => { setAdding(false); setName(''); }}>✕</button>
            </form>
          ) : (
            <>
              <button type="button" className="arrow" aria-label="Scroll places left" onClick={() => scrollBy(-240)}>‹</button>
              <div className="chips" ref={chips} role="list" aria-label="Places">
                {all.map((p) => (
                  <button key={p.id} type="button" role="listitem" className={`chip${p.custom ? ' mine' : ''}`} aria-pressed={here === p} onClick={() => onFly(p)}>
                    {p.n}
                    {p.custom && (
                      <span className="x" role="button" tabIndex={0} aria-label={`Remove ${p.n}`}
                        onClick={(e) => { e.stopPropagation(); onRemove(p.id); }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onRemove(p.id); } }}>×</span>
                    )}
                  </button>
                ))}
              </div>
              <button type="button" className="arrow" aria-label="Scroll places right" onClick={() => scrollBy(240)}>›</button>
              <button type="button" className="chip add" title="Save the current view as a place" onClick={() => setAdding(true)}>+ Add</button>
            </>
          )}
        </div>
      </div>

      <div className="sp-sec">
        <h3>Time of day <span className="sp-time">{fmt(time.hours)} <small>IST</small></span></h3>
        <div className="seg five" role="group" aria-label="Time presets">
          {PRESETS.map(([k, label, tip]) => (
            <button key={k} type="button" title={tip} aria-pressed={k === 'now' ? time.live : undefined} onClick={() => onPreset(k)}>{label}</button>
          ))}
        </div>
        <div className="sp-slide">
          <span aria-hidden="true" className="sp-ico">☀</span>
          <input type="range" min="0" max="24" step="0.05" aria-label="Time of day (IST)" value={time.hours} onChange={(e) => onSlide(+e.target.value)} />
          <span aria-hidden="true" className="sp-ico">☾</span>
        </div>
      </div>

      <div className="sp-sec">
        <h3>Map</h3>
        <div className="sp-row">
          <span>Place labels</span>
          <Switch on={layers.labels} onChange={() => onToggle('labels')} label="Place labels" />
        </div>
        <div className="sp-row col">
          <span>Traffic</span>
          <div className="seg three" role="group" aria-label="Traffic">
            {TRAFFIC.map(([k, label, tip]) => (
              <button key={k} type="button" title={tip} aria-pressed={traffic === k} onClick={() => onTraffic(k)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="sp-row">
          <span>Detail <small>Auto lowers it when your device struggles</small></span>
          <select className="sp-sel" aria-label="Detail level" value={quality.auto ? 'auto' : quality.name} onChange={(e) => onQuality(e.target.value)}>
            <option value="auto">Auto · {LEVELS[quality.name]}</option>
            {Object.entries(LEVELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>

      {editMode && mapEdits && <MapEdits edits={mapEdits} drawing={drawing} onDraw={onDraw} onCancel={onDrawCancel} onFinish={onDrawFinish} onSelect={onSelectRoad} onRemove={onRemoveEdit} onCopy={onCopyEdits} />}

      <footer className="sp-foot">
        <button type="button" className="sp-about" aria-expanded={aboutOpen} onClick={onAbout}>About this map and how to move around</button>
        <div className="attrib">
          © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors ·{' '}
          <a href="https://overturemaps.org" target="_blank" rel="noreferrer">Overture Maps</a> ·{' '}
          <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> ·{' '}
          <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> ·{' '}
          <a href="https://s2maps.eu" target="_blank" rel="noreferrer">Sentinel-2 cloudless by EOX</a>
        </div>
      </footer>
    </section>
  );
}

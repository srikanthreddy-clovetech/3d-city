import { useEffect, useState } from 'react';
import { TYPES, typeFor, cleanUrl } from '../places.js';
import { makeCode } from '../buildingId.js';

const MAX_EXTRA = 8;

export default function BuildingInfo({ info, saved, onSave, onDelete, onClose, onEditing, onCopy, rail, float, editMode, onModel }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState(null);
  const [err, setErr] = useState('');

  // a different building was clicked: drop any half-filled form
  useEffect(() => { setEditing(false); setErr(''); }, [info && info.lat, info && info.lon]);
  useEffect(() => { onEditing && onEditing(editing); }, [editing]);
  useEffect(() => { if (!editMode) setEditing(false); }, [editMode]);       // leaving edit mode closes an open form
  if (!info) return null;

  const start = () => {
    setF({
      name: (saved && saved.name) || info.name || '',
      url: (saved && saved.url) || '',
      type: (saved && saved.type) || typeFor(info.kind),
      height: saved && saved.realHeight ? String(saved.realHeight) : '',
      extra: saved && saved.extra ? saved.extra.map((e) => ({ ...e })) : [],
    });
    setErr(''); setEditing(true);
  };
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const setExtra = (i, k, v) => setF((p) => ({ ...p, extra: p.extra.map((e, j) => (j === i ? { ...e, [k]: v } : e)) }));

  const submit = (e) => {
    e.preventDefault();
    const hv = f.height.trim() === '' ? null : Math.round(parseFloat(f.height) * 10) / 10;
    if (hv !== null && !(hv >= 3 && hv <= 450)) { setErr('Height should be between 3 and 450 metres.'); return; }
    const name = f.name.trim() || (hv !== null ? info.name || info.kind : '');
    if (!name) { setErr('Please give the building a name, or a height.'); return; }
    const url = cleanUrl(f.url);
    if (f.url.trim() && !url) { setErr('That link does not look right. Use a web address like example.com'); return; }
    onSave({
      id: (saved && saved.id) || 'b' + Date.now().toString(36),
      lat: (saved && saved.lat) || info.lat, lon: (saved && saved.lon) || info.lon,
      name, url, type: f.type, height: hv !== null ? hv : info.height, realHeight: hv,
      blat: (saved && saved.blat) || info.blat, blon: (saved && saved.blon) || info.blon,
      extra: f.extra.map((x) => ({ k: x.k.trim(), v: x.v.trim() })).filter((x) => x.k && x.v),
    });
    setEditing(false);
  };

  const code = makeCode(info.blat, info.blon);
  // phones: a bottom sheet (styled in CSS); desktop: a panel on the right; otherwise next to the click
  let style;
  if (!rail && info.x != null) {
    const W = Math.min(editing ? 330 : 310, innerWidth - 24);
    const left = info.x + 14 + W > innerWidth - 12 ? Math.max(12, info.x - 14 - W) : info.x + 14;
    const half = editing ? 230 : 90;
    style = { left, top: Math.min(Math.max(info.y, half + 64), innerHeight - half - 12), width: W };
  }

  return (
    <div className={`panel info card${rail ? ` rail${float ? ' float' : ''}` : ''}`} style={style} role="dialog" aria-label="Building details">
      <span className="grab" aria-hidden="true" />
      <div className="card-head">
        <span className="ttl"><small className="kicker">{saved ? saved.type : info.kind}</small><b>{(saved && saved.name) || info.name || info.kind}</b></span>
        <span className="card-actions">
          {editMode && <button type="button" className="icon" title={saved ? 'Edit saved details' : 'Save this building'} aria-label={saved ? 'Edit saved details' : 'Save this building'} onClick={editing ? () => setEditing(false) : start}>
            {saved ? '✎' : '+'}
          </button>}
          <button type="button" className="icon" title="Close" aria-label="Close" onClick={onClose}>×</button>
        </span>
      </div>

      {!editing && code && (
        <div className="idrow">
          <span className="idlab">Building ID</span>
          <code>{code}</code>
          <button type="button" className="chip" onClick={() => onCopy(code, 'Building ID copied')}>Copy ID</button>
          <button type="button" className="chip" onClick={() => onCopy(location.origin + location.pathname + '#b=' + code, 'Link to this building copied', true)}>Copy link</button>
        </div>
      )}

      {!editing && (
        <>
          <dl className="facts">
            <div><dt>Type</dt><dd>{info.kind}</dd></div>
            <div><dt>Height</dt><dd>{saved && saved.realHeight ? `${saved.realHeight} m` : `${info.height} m`} <span className={`badge ${saved && saved.realHeight ? 'you' : info.mapped ? 'ok' : ''}`}>{saved && saved.realHeight ? 'set by you' : info.mapped ? 'from the map' : 'estimated'}</span></dd></div>
            <div><dt>Ground</dt><dd>{info.elevation} m above sea level</dd></div>
            <div><dt>Data</dt><dd>{info.source === 'osm' ? 'OpenStreetMap' : 'Overture Maps'}</dd></div>
            {info.gid && <div><dt>Map ID</dt><dd className="mono" title={info.gid}>{info.gid.slice(0, 13)}…</dd></div>}
          </dl>
          {saved && (
            <div className="saved">
              <span className="tag">{saved.type}</span>
              {saved.url && <a href={saved.url} target="_blank" rel="noopener noreferrer">{saved.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')} ↗</a>}
              {saved.extra && saved.extra.length > 0 && (
                <dl>{saved.extra.map((x, i) => <div key={i}><dt>{x.k}</dt><dd>{x.v}</dd></div>)}</dl>
              )}
              {editMode && <button type="button" className="link danger" onClick={() => onDelete(saved.id)}>Remove saved details</button>}
            </div>
          )}
          {!saved && editMode && <button type="button" className="link" onClick={start}>+ Save details for this building</button>}
          {editMode && onModel && (
            <div className="idrow modelrow">
              <span className="idlab">Model</span>
              <button type="button" className="chip" onClick={() => onModel('hide')}>Hide building</button>
            </div>
          )}
        </>
      )}

      {editing && editMode && (
        <form className="bform" onSubmit={submit} noValidate>
          <label>Building name
            <input autoFocus value={f.name} maxLength={60} placeholder="e.g. Head office" onChange={(e) => set('name', e.target.value)} />
          </label>
          <label>Link (URL)
            <input value={f.url} maxLength={300} inputMode="url" placeholder="example.com/page" onChange={(e) => set('url', e.target.value)} />
          </label>
          <label>Real height (metres)
            <input value={f.height} maxLength={6} inputMode="decimal" placeholder="e.g. 45 (leave empty to keep the map's)" onChange={(e) => set('height', e.target.value)} />
          </label>
          <label>Building type
            <select value={f.type} onChange={(e) => set('type', e.target.value)}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          {f.extra.map((x, i) => (
            <div className="extra" key={i}>
              <input value={x.k} maxLength={30} placeholder="Label (e.g. Owner)" aria-label="Field label" onChange={(e) => setExtra(i, 'k', e.target.value)} />
              <input value={x.v} maxLength={120} placeholder="Value" aria-label="Field value" onChange={(e) => setExtra(i, 'v', e.target.value)} />
              <button type="button" className="icon" aria-label="Remove field" onClick={() => setF((p) => ({ ...p, extra: p.extra.filter((_, j) => j !== i) }))}>×</button>
            </div>
          ))}
          {f.extra.length < MAX_EXTRA && (
            <button type="button" className="link" onClick={() => setF((p) => ({ ...p, extra: [...p.extra, { k: '', v: '' }] }))}>+ Add more</button>
          )}
          {err && <div className="err" role="alert">{err}</div>}
          <div className="row">
            <button type="submit" className="btn save">Save</button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
          </div>
          <div className="m">Saved on this device only.</div>
        </form>
      )}
    </div>
  );
}

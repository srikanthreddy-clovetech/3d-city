import { useState } from 'react';
import { metres } from '../places.js';

const CLASSES = [['secondary', 'Main road'], ['tertiary', 'Street'], ['minor', 'Lane']];
const NAMES = Object.fromEntries(CLASSES);

const roadLength = (pts) => { let m = 0; for (let i = 1; i < pts.length; i++) m += metres(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]); return Math.round(m); };

// Edit mode: roads added by clicking on the map, and the buildings that were hidden or turned into water tanks.
export default function MapEdits({ edits, drawing, onDraw, onCancel, onFinish, onSelect, onRemove, onCopy }) {
  const [cls, setCls] = useState('tertiary');
  const [open, setOpen] = useState(false);
  const total = edits.roads.length + edits.hide.length + edits.tanks.length;
  return (
    <div className="sp-sec mapedits">
      <button type="button" className="me-head" aria-expanded={open || !!drawing} onClick={() => setOpen((v) => !v)}>
        <span>Map edits{total > 0 && <i className="me-count">{total}</i>}</span><span className="me-chev" aria-hidden="true">{open || drawing ? '▴' : '▾'}</span>
      </button>
      {(open || drawing) && <>
      <div className="seg three" role="group" aria-label="Kind of road to add">
        {CLASSES.map(([k, label]) => <button key={k} type="button" aria-pressed={cls === k} disabled={!!drawing} onClick={() => setCls(k)}>{label}</button>)}
      </div>
      {drawing ? (
        <div className="me-row">
          <span className="me-draw">{drawing.pts.length === 0 ? 'Click the start of the road on the map' : drawing.pts.length === 1 ? 'Click the next point' : 'Click more points, then Finish'}</span>
          <span className="me-btns">{drawing.pts.length >= 2 && <button type="button" className="chip" onClick={onFinish}>Finish</button>}<button type="button" className="chip" onClick={onCancel}>Cancel</button></span>
        </div>
      ) : (
        <button type="button" className="btn me-add" onClick={() => onDraw(cls)}>+ Add a road</button>
      )}

      {edits.roads.map((r, i) => (
        <div className="me-row" key={r.id}><span><b>Road {i + 1}</b> · {NAMES[r.cls] || r.cls} · {roadLength(r.points)} m</span><span className="me-btns"><button type="button" className="chip" onClick={() => onSelect(r.id)}>Edit</button><button type="button" className="chip" onClick={() => onRemove('roads', r.id)}>Remove</button></span></div>
      ))}
      {edits.hide.map((h) => (
        <div className="me-row" key={h.code}><span><b>Hidden</b> · <code>{h.code}</code></span><button type="button" className="chip" onClick={() => onRemove('hide', h.code)}>Restore</button></div>
      ))}
      {edits.tanks.map((h) => (
        <div className="me-row" key={h.code}><span><b>Water tank</b> · <code>{h.code}</code></span><button type="button" className="chip" onClick={() => onRemove('tanks', h.code)}>Restore</button></div>
      ))}

      {total > 0 && <button type="button" className="link" onClick={onCopy}>Copy these edits as code for edits.js</button>}
      <div className="me-note">Saved on this device only. Paste the copied code into <code>src/edits.js</code> to make them permanent for everyone.</div>
      </>}
    </div>
  );
}

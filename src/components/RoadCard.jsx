import { metres } from '../places.js';

const NAMES = { secondary: 'Main road', tertiary: 'Street', minor: 'Lane' };
const length = (pts) => { let m = 0; for (let i = 1; i < pts.length; i++) m += metres(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]); return Math.round(m); };

// A road picked on the map in edit mode: its points show as numbered dots to drag.
export default function RoadCard({ road, index, adding, onAddPoint, onRemove, onClose }) {
  if (!road) return null;
  return (
    <div className="panel roadcard" role="dialog" aria-label="Edit road">
      <b>Road {index + 1}</b> · {NAMES[road.cls] || road.cls} · {length(road.points)} m
      <small>{adding ? 'Click on the map where the new point should go.' : 'Drag a numbered dot to reshape the road. Double-click a dot to remove it.'}</small>
      <div className="row">
        <button type="button" className="btn" onClick={onAddPoint}>{adding ? 'Cancel' : '+ Add a point'}</button>
        <button type="button" className="btn" onClick={onRemove}>Remove road</button>
        <button type="button" className="btn save" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

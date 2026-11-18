const Svg = ({ children }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

const fmtPos = (v) => `${Math.abs(v.lat).toFixed(4)}° ${v.lat >= 0 ? 'N' : 'S'} ${Math.abs(v.lon).toFixed(4)}° ${v.lon >= 0 ? 'E' : 'W'} · ${Math.round(v.eye).toLocaleString('en-IN')} m`;

export default function ViewControls({ view, needleRef, onNorth, onZoomIn, onZoomOut, onReset, onTilt, onShare }) {
  return (
    <>
      {/* bottom-left: zoom and where you are, in one pill */}
      <div className="panel vc-bl" role="group" aria-label="Zoom and position">
        <button type="button" className="zb" title="Zoom in" aria-label="Zoom in" onClick={onZoomIn}><Svg><path d="M12 5v14M5 12h14" /></Svg></button>
        <button type="button" className="zb" title="Zoom out" aria-label="Zoom out" onClick={onZoomOut}><Svg><path d="M5 12h14" /></Svg></button>
        {view && <span className="readout" aria-live="off">{fmtPos(view)}</span>}
      </div>

      <div className="panel vc" role="group" aria-label="View controls">
        <button type="button" className="icon compass" title="Face north" aria-label="Face north" onClick={onNorth}>
          <svg ref={needleRef} width="22" height="22" viewBox="-11 -11 22 22" aria-hidden="true" focusable="false">
            <path d="M0-9 L4 2 L0 0 L-4 2 Z" fill="#3cc8b4" />
            <path d="M0 9 L4 2 L0 0 L-4 2 Z" fill="#6e7882" />
          </svg>
        </button>
        <button type="button" className="icon" title="Change tilt" aria-label="Change tilt" onClick={onTilt}><Svg><path d="M3 15l9-9 9 9M3 20l9-9 9 9" /></Svg></button>
        <button type="button" className="icon" title="Back to the start view" aria-label="Back to the start view" onClick={onReset}><Svg><path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10" /></Svg></button>
        <button type="button" className="icon" title="Share this view" aria-label="Share this view" onClick={onShare}><Svg><path d="M12 15V3M8 7l4-4 4 4M5 12v8h14v-8" /></Svg></button>
      </div>
    </>
  );
}

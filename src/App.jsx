import { useCallback, useEffect, useRef, useState } from 'react';
import TitlePanel from './components/TitlePanel.jsx';
import AboutPanel from './components/AboutPanel.jsx';
import SidePanel from './components/SidePanel.jsx';
import LoadingScreen from './components/LoadingScreen.jsx';
import BuildingInfo from './components/BuildingInfo.jsx';
import HintBar from './components/HintBar.jsx';
import SearchBar from './components/SearchBar.jsx';
import ViewControls from './components/ViewControls.jsx';
import Credits from './components/Credits.jsx';
import TimeBar from './components/TimeBar.jsx';
import RoadCard from './components/RoadCard.jsx';
import { makeCode } from './buildingId.js';
import { EDIT_MODE } from './config.js';
import { PLACES, loadCustomPlaces, saveCustomPlaces, loadBuildings, saveBuildings, findSaved } from './places.js';
import { parseHash, buildHash } from './links.js';
import { useMedia } from './hooks.js';

const EDITS_KEY = 'hyd3d.mapedits';
const loadMapEdits = () => {
  try { const v = JSON.parse(localStorage.getItem(EDITS_KEY) || 'null'); if (v) return { hide: v.hide || [], tanks: v.tanks || [], roads: v.roads || [] }; } catch { /* no storage */ }
  return { hide: [], tanks: [], roads: [] };
};
// the user road nearest to a point on the ground, within 12 m (flat-earth distance is plenty at this size)
const nearestRoad = (roads, g) => {
  const kx = 111320 * Math.cos(g.lat * Math.PI / 180), ky = 110574; let best = null, bd = 12;
  for (const r of roads) {
    for (let i = 1; i < r.points.length; i++) {
      const ax = (r.points[i - 1][1] - g.lon) * kx, ay = (r.points[i - 1][0] - g.lat) * ky, bx = (r.points[i][1] - g.lon) * kx, by = (r.points[i][0] - g.lat) * ky;
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L));
      const d = Math.hypot(ax + dx * t, ay + dy * t);
      if (d < bd) { bd = d; best = r; }
    }
  }
  return best;
};
const forEngine = (m) => ({ hide: m.hide.map((h) => [h.lat, h.lon]), tanks: m.tanks.map((h) => [h.lat, h.lon]), roads: m.roads.map((r) => ({ cls: r.cls, points: r.points })) });

const qParam = new URLSearchParams(location.search).get('q') || undefined;
const startLink = parseHash(location.hash);        // a shared link can open straight at a view and time of day

export default function App() {
  const canvasRef = useRef(null);
  const labelsRef = useRef(null);
  const needleEl = useRef(null);
  const setNeedle = useCallback((el) => { needleEl.current = el; engineRef.current?.setNeedle(el); }, []);
  const engineRef = useRef(null);
  const phone = useMedia('(max-width: 640px)');

  const [load, setLoad] = useState({ frac: 0, msg: 'Starting up', done: false, error: null });
  const [stats, setStats] = useState(null);         // buildings in view, data release
  const [time, setTime] = useState({ hours: 12, live: true });
  const [quality, setQuality] = useState({ name: 'high', auto: true });
  const [layers, setLayers] = useState({ labels: true });
  const [traffic, setTrafficMode] = useState('static');   // off | sim | static
  const [pick, setPick] = useState(null);
  const [view, setView] = useState(null);             // look-at point shown in the bottom panel
  const [custom, setCustom] = useState(loadCustomPlaces);
  const [buildings, setBuildings] = useState(loadBuildings);   // buildings the user saved details for
  const [resultPin, setResultPin] = useState(null);             // pin dropped by the last search result
  const [toast, setToast] = useState('');
  // the toolbar and the time/places panel live only in the right-hand side panel; the toggle opens and closes it (remembered)
  const [docked, setDocked] = useState(() => { try { const v = localStorage.getItem('hyd3d.docked'); if (v !== null) return v === '1'; } catch { /* no storage */ } return !matchMedia('(max-width: 640px)').matches; });
  const toggleDock = () => setDocked((v) => { const n = !v; try { localStorage.setItem('hyd3d.docked', n ? '1' : '0'); } catch { /* no storage */ } return n; });
  const pendingB = useRef(startLink.b ? startLink.b.code : '');      // a building from the opening link, kept in the address until it has opened
  // edit mode (off by default): only then does the building panel offer to add or change details
  const [editOn, setEditModeState] = useState(() => { try { return localStorage.getItem('hyd3d.edit') === '1'; } catch { return false; } });
  const editMode = EDIT_MODE && editOn;                       // EDIT_MODE in config.js false: the switch is hidden and editing is always off
  const setEditMode = (v) => { setEditModeState(v); try { localStorage.setItem('hyd3d.edit', v ? '1' : '0'); } catch { /* no storage */ } };
  const editingRef = useRef(false);                           // true while the building form is open: keep the card
  const [aboutOpen, setAboutOpen] = useState(false);
  // map edits made in the app (edit mode): buildings hidden or turned into water tanks, and roads added by clicking
  const [mapEdits, setMapEditsState] = useState(loadMapEdits);
  const [drawing, setDrawing] = useState(null);                      // { cls, pts } while a road is being drawn
  const drawRef = useRef(null);                                  // the road being drawn: { cls, pts }
  const [selectedRoad, setSelectedRoad] = useState(null);       // id of the road whose points can be dragged
  const [addingPoint, setAddingPoint] = useState(false);
  const updateMapEdits = (fn) => setMapEditsState((m) => { const n = fn(m); try { localStorage.setItem(EDITS_KEY, JSON.stringify(n)); } catch { /* no storage */ } return n; });
  const latest = useRef({});                                  // newest state for callbacks the engine holds on to
  latest.current = { edit: editMode, roads: mapEdits.roads, view, time, buildings, code: pick ? makeCode(pick.blat, pick.blon) : pendingB.current };

  useEffect(() => {
    const ac = new AbortController();
    let engine = null;
    // the 3D engine (three.js, about 1 MB) loads on its own after the page shell is on screen
    import('./engine/Engine.js').then(({ createEngine }) => createEngine({
      canvas: canvasRef.current,
      labelRoot: labelsRef.current,
      needle: needleEl.current,
      quality: qParam,
      initial: startLink.view || undefined,
      signal: ac.signal,
      onProgress: (frac, msg) => setLoad((s) => ({ ...s, frac, msg: msg ?? s.msg })),
      onTime: (t) => setTime({ hours: t.hours, live: t.live }),
      onQuality: setQuality,
      onPick: (p, ground) => {
        if (p === null && ground && latest.current.edit) { const hit = nearestRoad(latest.current.roads, ground); setSelectedRoad(hit ? hit.id : null); if (hit) { editingRef.current = false; setPick(null); return; } }
        if (p === null && editingRef.current) return; if (p) pendingB.current = ''; setPick(p);
      },
      onPinDrop: (id, lat, lon) => movePoint(id, lat, lon),
      onPinDouble: (id) => dropPoint(id),
      onPin: (id) => {
        const e = engineRef.current;
        if (id === 'result') { setResultPin(null); return; }
        const b = latest.current.buildings.find((x) => x.id === id);
        if (b && e) e.flyTo(b.lat, b.lon, 200);
      },
      onStats: setStats,
      onView: (v) => setView((p) => (p && Math.abs(p.lat - v.lat) < 1e-5 && Math.abs(p.lon - v.lon) < 1e-5 && Math.abs(p.eye - v.eye) < 1 && Math.abs(p.az - v.az) < 0.01 && Math.abs(p.tilt - v.tilt) < 0.01 ? p : v)),
      onReady: () => setLoad((s) => ({ ...s, frac: 1, done: true })),
    })).then((e) => {
      if (!e) return;
      if (ac.signal.aborted) { e.dispose(); return; }
      engine = e;
      engineRef.current = e;
      e.setNeedle(needleEl.current);
      e.setMapEdits(forEngine(loadMapEdits()));
      if (startLink.t !== null) e.setTime(startLink.t);
      window.__hyd = { ...e.debug, setTime: e.setTime };
    }).catch((err) => {
      if (!ac.signal.aborted) setLoad((s) => ({ ...s, error: err.message }));
    });
    return () => {
      ac.abort();
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  // heights typed in for buildings (edit mode) reshape the model
  useEffect(() => {
    engineRef.current?.setHeightFixes(buildings.filter((b) => b.realHeight > 2).map((b) => [b.blat ?? b.lat, b.blon ?? b.lon, b.realHeight]));
  }, [buildings, load.done]);

  // edits made in the app reshape the model
  useEffect(() => { engineRef.current?.setMapEdits(forEngine(mapEdits)); }, [mapEdits, load.done]);
  const stopDrawing = useCallback(() => { engineRef.current?.cancelPick(); drawRef.current = null; setDrawing(null); setAddingPoint(false); }, []);
  useEffect(() => { if (!editMode) { stopDrawing(); setSelectedRoad(null); } }, [editMode, stopDrawing]);

  const roadSel = selectedRoad ? mapEdits.roads.find((r) => r.id === selectedRoad) || null : null;
  // saved buildings and the search result show as pins on the map
  useEffect(() => {
    engineRef.current?.setPins([
      ...buildings.map((b) => ({ id: b.id, lat: b.lat, lon: b.lon, name: b.name, kind: 'saved', h: b.height })),
      ...(resultPin ? [{ id: 'result', ...resultPin, kind: 'result' }] : []),
      ...(drawing ? drawing.pts.map((p, i) => ({ id: 'draw' + i, lat: p[0], lon: p[1], name: i === 0 ? 'Start' : 'Point ' + (i + 1), kind: 'result' })) : []),
      ...(roadSel ? roadSel.points.map((p, i) => ({ id: 'h:' + roadSel.id + ':' + i, lat: p[0], lon: p[1], name: String(i + 1), kind: 'handle', drag: true, h: 0 })) : []),
    ]);
  }, [buildings, resultPin, drawing, roadSel, load.done]);

  // keep the page address in step with the view, so any copy of it is a share link
  const writeHash = useCallback(() => {
    const { view: v, time: t } = latest.current;
    const h = buildHash(v, t, latest.current.code);
    if (h && h !== location.hash) history.replaceState(null, '', location.pathname + location.search + h);
  }, []);
  useEffect(() => { const id = setTimeout(writeHash, 700); return () => clearTimeout(id); }, [view, time, pick, writeHash]);

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2200); };
  const copyText = async (text, msg) => {
    try { await navigator.clipboard.writeText(text); flash(msg); }
    catch { window.prompt('Copy this', text); }
  };
  // fly to a place and open the building there (its tile may still be loading, so try for a few seconds)
  const selectTimer = useRef(0);
  const openBuildingAt = useCallback((lat, lon) => {
    clearInterval(selectTimer.current);
    const e = engineRef.current; if (!e) return;
    e.flyTo(lat, lon, 220);
    let tries = 0;
    selectTimer.current = setInterval(() => { if (e.selectAt(lat, lon) || ++tries > 24) clearInterval(selectTimer.current); }, 700);
  }, []);
  useEffect(() => () => clearInterval(selectTimer.current), []);
  useEffect(() => { if (load.done && startLink.b) openBuildingAt(startLink.b.lat, startLink.b.lon); }, [load.done, openBuildingAt]);
  const share = async () => {
    writeHash();
    const url = location.href;
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) { await navigator.share({ title: 'Hyderabad 3D', url }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(url); flash('Link copied. Anyone who opens it sees this view.'); }
    catch { window.prompt('Copy this link', url); }
  };

  const toggleLayer = useCallback((name) => {
    setLayers((l) => {
      const next = { ...l, [name]: !l[name] };
      engineRef.current?.setLayer(name, next[name]);
      return next;
    });
  }, []);

  const eng = () => engineRef.current;
  const addPlace = (n) => {
    const v = eng()?.view(); if (!v) return;
    const next = [...custom, { id: 'u' + Date.now().toString(36), n, lat: v.lat, lon: v.lon, range: Math.round(v.range) }];
    setCustom(next); saveCustomPlaces(next);
  };
  const saveBuilding = (rec) => {
    const next = buildings.some((b) => b.id === rec.id) ? buildings.map((b) => (b.id === rec.id ? rec : b)) : [...buildings, rec];
    setBuildings(next); saveBuildings(next);
  };
  // hide a building or turn it into a water tank (the card closes: it is no longer a building to click)
  const modelBuilding = (kind) => {
    if (!pick) return;
    const code = makeCode(pick.blat, pick.blon), rec = { code, lat: pick.blat, lon: pick.blon };
    updateMapEdits((m) => ({ ...m, hide: m.hide.filter((x) => x.code !== code), tanks: m.tanks.filter((x) => x.code !== code), [kind === 'tank' ? 'tanks' : 'hide']: [...(kind === 'tank' ? m.tanks : m.hide), rec] }));
    editingRef.current = false; setPick(null);
    flash(kind === 'tank' ? 'Now drawn as a water tank. Undo it in the side panel under Map edits.' : 'Building hidden. Bring it back in the side panel under Map edits.');
  };
  // add a road: click its points on the map (two or more), then Finish; three or more points make a curve
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  const drawRoad = (cls) => {
    const e = eng(); if (!e) return;
    drawRef.current = { cls, pts: [] }; setSelectedRoad(null); setDrawing({ cls, pts: [] });
    const arm = () => e.pickGround(({ lat, lon }) => {
      const d = drawRef.current; if (!d) return;
      d.pts = [...d.pts, [r5(lat), r5(lon)]]; setDrawing({ cls: d.cls, pts: d.pts }); arm();
    });
    if (phone) setDocked(false);
    arm();
  };
  const finishRoad = () => {
    const d = drawRef.current; engineRef.current?.cancelPick(); drawRef.current = null; setDrawing(null);
    if (!d || d.pts.length < 2) return;
    const id = 'r' + Date.now().toString(36);
    updateMapEdits((m) => ({ ...m, roads: [...m.roads, { id, cls: d.cls, points: d.pts }] }));
    setSelectedRoad(id); flash('Road added. Drag its dots to reshape it.');
  };
  const setRoadPoints = (id, fn) => updateMapEdits((m) => ({ ...m, roads: m.roads.map((r) => (r.id === id ? { ...r, points: fn(r.points) } : r)) }));
  const movePoint = (hid, lat, lon) => { const [, id, i] = String(hid).split(':'); if (id) setRoadPoints(id, (p) => p.map((q, k) => (k === +i ? [r5(lat), r5(lon)] : q))); };
  const dropPoint = (hid) => { const [, id, i] = String(hid).split(':'); if (id) setRoadPoints(id, (p) => (p.length > 2 ? p.filter((_, k) => k !== +i) : p)); };
  // add a point to the selected road: click where it should go; it joins the nearest stretch of the road
  const addPoint = () => {
    const e = eng(); if (!e || !roadSel) return;
    if (addingPoint) { e.cancelPick(); setAddingPoint(false); return; }
    setAddingPoint(true);
    e.pickGround(({ lat, lon }) => {
      setAddingPoint(false);
      setRoadPoints(roadSel.id, (pts) => {
        const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110574; let at = pts.length - 1, bd = Infinity;
        for (let i = 1; i < pts.length; i++) {
          const ax = (pts[i - 1][1] - lon) * kx, ay = (pts[i - 1][0] - lat) * ky, bx = (pts[i][1] - lon) * kx, by = (pts[i][0] - lat) * ky;
          const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)), d = Math.hypot(ax + dx * t, ay + dy * t);
          if (d < bd) { bd = d; at = i; }
        }
        return [...pts.slice(0, at), [r5(lat), r5(lon)], ...pts.slice(at)];
      });
    });
  };
  const removeEdit = (kind, id) => { if (kind === 'roads' && id === selectedRoad) setSelectedRoad(null); updateMapEdits((m) => ({ ...m, [kind]: m[kind].filter((x) => (kind === 'roads' ? x.id : x.code) !== id) })); }
  const copyEdits = () => {
    const list = (a) => a.length ? a.map((x) => `  '${x.code}',`).join('\n') : '';
    const roads = mapEdits.roads.map((r, i) => `  { name: 'Road ${i + 1}', cls: '${r.cls}', points: [${r.points.map((p) => `[${p[0]}, ${p[1]}]`).join(', ')}] },`).join('\n');
    copyText(`// merge these into src/edits.js\nexport const HIDDEN_BUILDINGS = [\n${list(mapEdits.hide)}\n];\n\nexport const WATER_TANKS = [\n${list(mapEdits.tanks)}\n];\n\nexport const EXTRA_ROADS = [\n${roads}\n];\n`, 'Edits copied as code');
  };
  const deleteBuilding = (id) => { const next = buildings.filter((b) => b.id !== id); setBuildings(next); saveBuildings(next); };
  const removePlace = (id) => { const next = custom.filter((p) => p.id !== id); setCustom(next); saveCustomPlaces(next); };
  const goTo = (r) => {
    if (r.kind === 'building') { setResultPin(null); openBuildingAt(r.lat, r.lon); if (phone) setDocked(false); return; }
    eng()?.flyTo(r.lat, r.lon, r.range);
    setResultPin(r.kind === 'saved' ? null : { name: r.n, lat: r.lat, lon: r.lon });
    if (phone) setDocked(false);
  };

  const infoCard = (
    <BuildingInfo
      info={pick}
      rail={!phone}
      float={!docked}
      editMode={editMode}
      saved={pick ? findSaved(buildings, pick.lat, pick.lon) : null}
      onSave={saveBuilding}
      onModel={modelBuilding}
      onDelete={deleteBuilding}
      onClose={() => { editingRef.current = false; pendingB.current = ''; setPick(null); }}
      onEditing={(v) => { editingRef.current = v; }}
      onCopy={(text, msg, link) => { if (link) writeHash(); copyText(text, msg); }}
    />
  );
  const panel = (
    <SidePanel
      view={view}
      time={time}
      places={PLACES}
      custom={custom}
      layers={layers}
      onToggle={toggleLayer}
      traffic={traffic}
      onTraffic={(m) => { setTrafficMode(m); eng()?.setTraffic(m); }}
      quality={quality}
      onQuality={(q) => eng()?.setQuality(q)}
      onFly={(p) => { eng()?.flyTo(p.lat, p.lon, p.range); if (phone) setDocked(false); }}
      onAdd={addPlace}
      onRemove={removePlace}
      onSlide={(h) => eng()?.setTime(h)}
      onPreset={(p) => eng()?.preset(p)}
      aboutOpen={aboutOpen}
      editMode={editMode}
      onEditMode={setEditMode}
      showEditSwitch={EDIT_MODE}
      mapEdits={mapEdits}
      drawing={drawing}
      onDraw={drawRoad}
      onDrawCancel={stopDrawing}
      onDrawFinish={finishRoad}
      onSelectRoad={(id) => { stopDrawing(); setSelectedRoad(id); if (phone) setDocked(false); }}
      onRemoveEdit={removeEdit}
      onCopyEdits={copyEdits}
      onAbout={() => setAboutOpen((v) => !v)}
    />
  );

  return (
    <div className="app">
      <canvas ref={canvasRef} className="view" tabIndex={0} aria-label="Interactive 3D model of Greater Hyderabad" />
      <div ref={labelsRef} className="labels" aria-hidden="true" />
      {(phone || !docked) && infoCard}

      <div className={`hud${docked ? ' docked' : ''}`}>
        <div className="top-left">
          <TitlePanel />
          {aboutOpen && <AboutPanel stats={stats} onClose={() => setAboutOpen(false)} />}
        </div>
        <div className="top-center">
          <SearchBar places={PLACES} custom={custom} buildings={buildings} onGo={goTo} />
        </div>
        <div className="top-right">
          <button type="button" className="panel dock-toggle" aria-pressed={docked} onClick={toggleDock}
            title={docked ? 'Hide the controls panel' : 'Show the controls panel'} aria-label={docked ? 'Hide the controls panel' : 'Show the controls panel'}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M15 4v16" />
            </svg>
          </button>
        </div>
        <ViewControls
          view={view}
          needleRef={setNeedle}
          onNorth={() => eng()?.faceNorth()}
          onZoomIn={() => eng()?.zoomBy(0.55)}
          onZoomOut={() => eng()?.zoomBy(1 / 0.55)}
          onTilt={() => eng()?.tiltStep()}
          onReset={() => eng()?.resetView()}
          onShare={share}
        />
        <HintBar visible={load.done} />
        <TimeBar time={time} onSlide={(h) => eng()?.setTime(h)} />
        {docked ? <aside className="sidedock">{!phone && infoCard}{panel}</aside> : <Credits />}
        {toast && <div className="toast" role="status">{toast}</div>}
      </div>

      {editMode && roadSel && !drawing && (
        <RoadCard road={roadSel} index={mapEdits.roads.indexOf(roadSel)} adding={addingPoint} onAddPoint={addPoint}
          onRemove={() => { setSelectedRoad(null); removeEdit('roads', roadSel.id); }} onClose={() => { engineRef.current?.cancelPick(); setAddingPoint(false); setSelectedRoad(null); }} />
      )}

      <LoadingScreen {...load} />
    </div>
  );
}

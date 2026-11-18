import { useCallback, useEffect, useRef, useState } from 'react';
import { createEngine } from './engine/Engine.js';
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
import { makeCode } from './buildingId.js';
import { EDIT_MODE } from './config.js';
import { PLACES, loadCustomPlaces, saveCustomPlaces, loadBuildings, saveBuildings, findSaved } from './places.js';
import { parseHash, buildHash } from './links.js';
import { useMedia } from './hooks.js';

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
  const latest = useRef({});                                  // newest state for callbacks the engine holds on to
  latest.current = { view, time, buildings, code: pick ? makeCode(pick.blat, pick.blon) : pendingB.current };

  useEffect(() => {
    const ac = new AbortController();
    let engine = null;
    createEngine({
      canvas: canvasRef.current,
      labelRoot: labelsRef.current,
      needle: needleEl.current,
      quality: qParam,
      initial: startLink.view || undefined,
      signal: ac.signal,
      onProgress: (frac, msg) => setLoad((s) => ({ ...s, frac, msg: msg ?? s.msg })),
      onTime: (t) => setTime({ hours: t.hours, live: t.live }),
      onQuality: setQuality,
      onPick: (p) => { if (p === null && editingRef.current) return; if (p) pendingB.current = ''; setPick(p); },
      onPin: (id) => {
        const e = engineRef.current;
        if (id === 'result') { setResultPin(null); return; }
        const b = latest.current.buildings.find((x) => x.id === id);
        if (b && e) e.flyTo(b.lat, b.lon, 200);
      },
      onStats: setStats,
      onView: (v) => setView((p) => (p && Math.abs(p.lat - v.lat) < 1e-5 && Math.abs(p.lon - v.lon) < 1e-5 && Math.abs(p.eye - v.eye) < 1 && Math.abs(p.az - v.az) < 0.01 && Math.abs(p.tilt - v.tilt) < 0.01 ? p : v)),
      onReady: () => setLoad((s) => ({ ...s, frac: 1, done: true })),
    }).then((e) => {
      if (!e) return;
      if (ac.signal.aborted) { e.dispose(); return; }
      engine = e;
      engineRef.current = e;
      e.setNeedle(needleEl.current);
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

  // saved buildings and the search result show as pins on the map
  useEffect(() => {
    engineRef.current?.setPins([
      ...buildings.map((b) => ({ id: b.id, lat: b.lat, lon: b.lon, name: b.name, kind: 'saved', h: b.height })),
      ...(resultPin ? [{ id: 'result', ...resultPin, kind: 'result' }] : []),
    ]);
  }, [buildings, resultPin, load.done]);

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

      <LoadingScreen {...load} />
    </div>
  );
}

const fmtIN = (n) => (n ?? 0).toLocaleString('en-IN');

export default function AboutPanel({ stats, onClose }) {
  const pct = stats && stats.count ? Math.round((100 * stats.mapped) / stats.count) : null;
  return (
    <section className="panel about" aria-label="About this map">
      <div className="about-head">
        <b>About this map</b>
        <button className="btn close" type="button" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="body">
        <p>
          A 3D model of Greater Hyderabad drawn live in your browser from open map data and satellite
          imagery. Nothing is pre-built: buildings, trees, roads, lakes and terrain stream in as you move around.
        </p>
        <h3>Getting around</h3>
        <ul>
          <li>Drag to move, scroll or pinch to zoom</li>
          <li>Right-drag or <kbd>Ctrl</kbd>-drag to turn and tilt</li>
          <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to fly, <kbd>Q</kbd>/<kbd>E</kbd> to turn</li>
          <li>Click a building to see its height</li>
        </ul>
        <h3>Data</h3>
        <ul>
          <li>
            Buildings: Overture Maps Foundation{stats?.release ? ` (release ${stats.release})` : ''}, which combines
            OpenStreetMap, Google Open Buildings and Microsoft ML Buildings
          </li>
          <li>Roads, water, parks and place names: © OpenStreetMap contributors, via OpenFreeMap and OpenMapTiles</li>
          <li>Ground imagery: Sentinel-2 cloudless 2024 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024), CC BY-NC-SA 4.0</li>
          <li>Terrain: AWS Terrain Tiles (Mapzen), from SRTM and other public elevation data</li>
          <li>Rendered with three.js and React</li>
        </ul>
        {pct !== null && (
          <p>
            Of the {fmtIN(stats.count)} buildings in view, {pct}% have a height or floor count in the map; the rest
            use an estimate from their footprint size.
          </p>
        )}
        {stats && !stats.overture && <p>Overture was unreachable, so buildings come from OpenStreetMap only.</p>}
      </div>
    </section>
  );
}

export default function LoadingScreen({ frac, msg, done, error }) {
  return (
    <div className={`loading${done && !error ? ' done' : ''}`} aria-hidden={done && !error}>
      <div className="box">
        <h2>HYDERABAD</h2>
        <div className="tel" lang="te">హైదరాబాద్</div>
        <div className="bar"><i style={{ width: `${Math.round(frac * 100)}%` }} /></div>
        <div className="msg">{msg}</div>
        {error && <div className="err">{error}</div>}
      </div>
    </div>
  );
}

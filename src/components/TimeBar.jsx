const MIN = 5, MAX = 22;       // the bar spans sunrise to late evening; the full 24 hours stay on the side panel

const fmt = (h) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')} IST`;

// Bottom centre: Morning ... Night, a coloured track that shows how the light changes through the day.
export default function TimeBar({ time, onSlide }) {
  const v = Math.min(MAX, Math.max(MIN, time.hours));
  return (
    <div className="panel timebar" role="group" aria-label="Time of day">
      <span>Morning</span>
      <input type="range" min={MIN} max={MAX} step="0.05" value={v} aria-label="Time of day" aria-valuetext={fmt(time.hours)} title={fmt(time.hours)}
        onChange={(e) => onSlide(+e.target.value)} />
      <span>Night</span>
    </div>
  );
}

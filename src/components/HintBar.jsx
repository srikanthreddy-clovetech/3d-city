import { useEffect, useState } from 'react';

// A one-line control hint that fades after the first interaction (or after a while).
export default function HintBar({ visible }) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!visible) return;
    const hide = () => setGone(true);
    const t = setTimeout(hide, 12000);
    window.addEventListener('pointerdown', hide, { once: true });
    window.addEventListener('wheel', hide, { once: true });
    return () => { clearTimeout(t); window.removeEventListener('pointerdown', hide); window.removeEventListener('wheel', hide); };
  }, [visible]);
  return (
    <div className={`panel hint${visible && !gone ? '' : ' hidden'}`} aria-hidden={!visible || gone}>
      Drag to move · pinch or scroll to zoom · right-drag or Ctrl-drag to rotate · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to fly
    </div>
  );
}

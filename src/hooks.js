import { useEffect, useState } from 'react';

/** true while the CSS media query matches, e.g. useMedia('(max-width: 640px)') */
export function useMedia(query) {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on); on();
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { SLOWED_POLL_MILLISECONDS } from '@/lib/campaign';

// A little under the 30 second delay, so the timer's own next tick, which comes about 30 seconds after the last one, is never skipped.
const QUIET_MILLISECONDS = SLOWED_POLL_MILLISECONDS - 2000;

/**
 * One route's pause after it answered 429. While it lasts the route is left alone, whether the timer or the tab coming
 * back asks for a read, and the page keeps what it last read. `report` tells the page, which shows one line for every
 * route that is paused.
 */
export function useReadPause(route: string, report: (route: string, slowed: boolean) => void) {
  const [slowed, setSlowed] = useState(false);
  const quietUntil = useRef(0);

  const busy = useCallback(() => {
    quietUntil.current = Date.now() + QUIET_MILLISECONDS;
    setSlowed(true);
    report(route, true);
  }, [route, report]);

  const ok = useCallback(() => {
    quietUntil.current = 0;
    setSlowed(false);
    report(route, false);
  }, [route, report]);

  const quiet = useCallback(() => Date.now() < quietUntil.current, []);

  return useMemo(() => ({ slowed, busy, ok, quiet }), [slowed, busy, ok, quiet]);
}

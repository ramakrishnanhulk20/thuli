'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Calls the function every `milliseconds` while the tab is visible, and once more at the moment the tab becomes visible
 * again, so a page left in the background catches up when it comes back.
 */
export function useVisibleInterval(callback: () => void, milliseconds: number, enabled = true): void {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  });

  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      if (document.visibilityState === 'visible') latest.current();
    };
    const timer = window.setInterval(run, milliseconds);
    document.addEventListener('visibilitychange', run);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
    };
  }, [milliseconds, enabled]);
}

/** The current time in milliseconds, renewed on an interval, for text such as "5 minutes ago" that has to move. */
export function useNow(milliseconds: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), milliseconds);
    return () => window.clearInterval(timer);
  }, [milliseconds]);
  return now;
}

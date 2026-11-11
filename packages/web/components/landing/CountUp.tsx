'use client';

import { useEffect, useRef } from 'react';
import styles from './landing.module.css';

const COUNT_MS = 1200;

/**
 * Shows a number that counts up from zero the first time it is 40% in view. The server HTML holds the final
 * text, and so does a reduced-motion visit. A screen reader gets the final text once, not the count.
 */
export function CountUp({ value, className }: { value: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = ref.current;
    const match = /^([^0-9]*)(\d+(?:\.(\d+))?)(.*)$/.exec(value);
    if (node === null || match === null || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const [, prefix = '', digits = '0', fraction = '', suffix = ''] = match;
    const target = Number(digits);
    const write = (amount: number) => {
      node.textContent = `${prefix}${amount.toFixed(fraction.length)}${suffix}`;
    };

    write(0);
    let frame = 0;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        const startedAt = performance.now();
        const tick = (now: number) => {
          const progress = Math.min(1, (now - startedAt) / COUNT_MS);
          if (progress < 1) {
            write(target * (1 - Math.pow(1 - progress, 3)));
            frame = requestAnimationFrame(tick);
          } else {
            node.textContent = value;
          }
        };
        frame = requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    observer.observe(node);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      node.textContent = value;
    };
  }, [value]);

  return (
    <p className={className}>
      <span ref={ref} data-count aria-hidden="true">
        {value}
      </span>
      <span className={styles.visuallyHidden}>{value}</span>
    </p>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import campaign from '../campaign/campaign.module.css';

const SHOWN_MILLISECONDS = 1500;

/** Copies a value and says "Copied" for a moment. A browser that refuses the copy changes nothing. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), SHOWN_MILLISECONDS);
  }

  return (
    <button type="button" className={campaign.quiet} onClick={copy} aria-label={`Copy ${label}`} data-copy={label}>
      <span className={campaign.quietLabel}>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

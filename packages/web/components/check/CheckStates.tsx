'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { Drop } from '../Drop';
import styles from './check.module.css';

/** The site's text link: label with an underline that draws on hover, and a small arrow. */
export function ArrowLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} prefetch={false} className={styles.link}>
      <span className={styles.linkLabel}>{children}</span>
      <svg className={styles.linkArrow} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M1 6h9M6.5 2.5L10 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </Link>
  );
}

/** From the moment the request goes out. The seconds come from the clock, so a slow tab still tells the truth. */
export function Waiting() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className={styles.waiting} aria-live="polite" data-state="waiting">
      <span className={styles.visuallyHidden}>Checking the wallet</span>
      <div className={styles.drops} aria-hidden="true">
        <Drop width={14} className={styles.drop} />
        <Drop width={14} className={styles.drop} />
        <Drop width={14} className={styles.drop} />
      </div>
      <h2 className={styles.waitTitle}>Reading the chain, then asking SERV.</h2>
      <p className={styles.waitBody}>
        {"Thuli reads this wallet's public history from Ethereum, works out the facts in code, and asks SERV to apply the rulebook. This can take up to two minutes."}
      </p>
      <p className={styles.seconds} data-seconds>{`${seconds} S`}</p>
    </div>
  );
}

function TryAgain({ onRetry }: { onRetry: () => void }) {
  return (
    <button type="button" className={styles.primary} onClick={onRetry}>
      Try again
    </button>
  );
}

export function LimitState() {
  return (
    <div className={styles.state} data-state="limit">
      <h2 className={styles.stateTitle}>{"That is this hour's free checks."}</h2>
      <p className={styles.stateBody}>
        Each visitor gets 5 new checks an hour. Wallets you already checked are kept for a day and still open instantly. The replay is open to browse without limit.
      </p>
      <div className={styles.stateActions}>
        <ArrowLink href="/replay">Open the replay</ArrowLink>
      </div>
    </div>
  );
}

export function BusyState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={styles.state} data-state="busy">
      <h2 className={styles.stateTitle}>The free check is busy.</h2>
      <p className={styles.stateBody}>
        {"It is at today's limit or handling other checks. Nothing was decided for this wallet. Try again in a while."}
      </p>
      <div className={styles.stateActions}>
        <TryAgain onRetry={onRetry} />
        <ArrowLink href="/replay">Open the replay</ArrowLink>
      </div>
    </div>
  );
}

export function BadAddressState() {
  return (
    <div className={styles.state} data-state="bad">
      <h2 className={styles.stateTitle}>That is not a wallet address.</h2>
      <p className={styles.stateBody}>
        An Ethereum address starts with 0x and has 42 characters. If you typed it by hand, one character may be wrong.
      </p>
      <div className={styles.stateActions}>
        <ArrowLink href="/check">Check another wallet</ArrowLink>
      </div>
    </div>
  );
}

export function UnreachableState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={styles.state} data-state="unreachable">
      <h2 className={styles.stateTitle}>The check could not be reached.</h2>
      <p className={styles.stateBody}>Nothing was decided for this wallet. Your connection or the service may be down.</p>
      <div className={styles.stateActions}>
        <TryAgain onRetry={onRetry} />
      </div>
    </div>
  );
}

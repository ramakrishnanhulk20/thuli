'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_PENDING_ANSWERS, POLL_MILLISECONDS, requestCheck, type CheckOutcome } from '@/lib/check';
import { addressUrl } from '@/lib/explorer';
import { CheckResult } from './CheckResult';
import { BadAddressState, BusyState, LimitState, UnreachableState, Waiting } from './CheckStates';
import styles from './check.module.css';

const COPIED_MILLISECONDS = 1500;

type View = { kind: 'waiting' } | CheckOutcome;

function BackLink() {
  return (
    <Link href="/check" prefetch={false} className={styles.back}>
      <svg className={styles.backArrow} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M11 6H2M5.5 2.5L2 6l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <span className={styles.linkLabel}>Check another wallet</span>
    </Link>
  );
}

function AddressRow({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  const link = addressUrl(address);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      return;
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), COPIED_MILLISECONDS);
  }

  return (
    <>
      <p className={styles.address} data-address>
        {address}
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} onClick={copy}>
          <span className={styles.quietLabel}>{copied ? 'Copied' : 'Copy'}</span>
        </button>
        {link === null ? null : (
          <a className={styles.quiet} href={link} target="_blank" rel="noopener noreferrer">
            <span className={styles.quietLabel}>Etherscan</span>
          </a>
        )}
      </div>
    </>
  );
}

/** address is null when the route segment was not an address: nothing is sent and the bad address state shows. */
export function CheckRun({ address }: { address: string | null }) {
  const [view, setView] = useState<View>(address === null ? { kind: 'bad' } : { kind: 'waiting' });
  const [run, setRun] = useState(0);
  // The request goes out once per page load: the second pass of the development double effect finds this set.
  const started = useRef(false);
  const alive = useRef(false);

  const ask = useCallback(async (wallet: string) => {
    setView({ kind: 'waiting' });
    let pending = 0;
    for (;;) {
      const outcome = await requestCheck(wallet);
      if (!alive.current) return;
      if (outcome.kind !== 'pending') {
        setView(outcome);
        return;
      }
      pending += 1;
      if (pending >= MAX_PENDING_ANSWERS) {
        setView({ kind: 'busy' });
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, POLL_MILLISECONDS));
      if (!alive.current) return;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (address !== null && !started.current) {
      started.current = true;
      void ask(address);
    }
    return () => {
      alive.current = false;
    };
  }, [address, ask]);

  function retry() {
    if (address === null) return;
    setRun((count) => count + 1);
    void ask(address);
  }

  return (
    <>
      <BackLink />
      {address === null ? null : <AddressRow address={address} />}
      <div className={styles.stage}>
        {view.kind === 'waiting' ? <Waiting key={run} /> : null}
        {view.kind === 'result' && address !== null ? <CheckResult address={address} result={view.body} /> : null}
        {view.kind === 'limit' ? <LimitState /> : null}
        {view.kind === 'busy' ? <BusyState onRetry={retry} /> : null}
        {view.kind === 'bad' ? <BadAddressState /> : null}
        {view.kind === 'unreachable' ? <UnreachableState onRetry={retry} /> : null}
      </div>
    </>
  );
}

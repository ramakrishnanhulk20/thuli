'use client';

import Link from 'next/link';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { notCheckedText, OUTCOME_WORDS, relativeTime, type FreeCheck } from '@/lib/check';
import { shortHash, txUrl } from '@/lib/explorer';
import { loadWallet } from '@/lib/replay/client';
import { ruleMeaning } from '@/lib/rules';
import styles from './check.module.css';

function Rise({ index, className, children }: { index: number; className?: string; children: ReactNode }) {
  return (
    <div className={`${styles.rise} ${className ?? ''}`} style={{ '--i': index } as CSSProperties}>
      {children}
    </div>
  );
}

export function CheckResult({ address, result }: { address: string; result: FreeCheck }) {
  const { decision } = result;
  const meaning = ruleMeaning(decision.rule);
  const [inReplay, setInReplay] = useState(false);

  // Whether the wallet also claimed in the ROBO airdrop. A failed load only means the line is not shown.
  useEffect(() => {
    let current = true;
    loadWallet(address)
      .then((detail) => {
        if (current && detail !== null) setInReplay(true);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [address]);

  return (
    <div data-state="result">
      <Rise index={0}>
        <h2 className={`${styles.banner} ${styles[decision.action]}`} data-outcome={decision.action}>
          {OUTCOME_WORDS[decision.action]}
        </h2>
        <p className={styles.bannerMeta} data-share>{`SHARE ${decision.shareBps / 100}%`}</p>
      </Rise>

      <Rise index={1}>
        <h3 className={styles.resultLabel}>WHY</h3>
        <div className={styles.ruleLine}>
          <span className={styles.ruleChip} data-rule>{`RULE ${decision.rule}`}</span>
          {meaning === decision.rule ? null : <p className={styles.ruleMeaning}>{meaning}</p>}
        </div>
        <p className={styles.reason} data-reason>
          {decision.reason}
        </p>
        <p className={styles.citedLabel}>Cited transactions</p>
        {decision.citedTxs.length === 0 ? (
          <p className={styles.none}>None</p>
        ) : (
          <ul className={styles.txList} data-cited>
            {decision.citedTxs.map((hash, index) => {
              const link = txUrl(hash);
              return (
                <li key={`${hash}-${index}`}>
                  {link === null ? (
                    <span className={styles.tx}>{shortHash(hash)}</span>
                  ) : (
                    <a className={styles.tx} href={link} target="_blank" rel="noopener noreferrer">
                      <span className={styles.txText}>{shortHash(hash)}</span>
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Rise>

      <Rise index={2}>
        <h3 className={styles.resultLabel}>NOT CHECKED</h3>
        <p className={styles.notIntro}>One wallet on its own cannot show these, so this check did not measure them:</p>
        {result.notChecked.length === 0 ? null : (
          <ul className={styles.notList} data-not-checked>
            {result.notChecked.map((name, index) => (
              <li key={`${name}-${index}`}>{notCheckedText(name)}</li>
            ))}
          </ul>
        )}
      </Rise>

      <Rise index={3}>
        <h3 className={styles.resultLabel}>HOW IT WAS DECIDED</h3>
        <div className={styles.decided} data-decided>
          <p>{`Scope: ${result.scope}.`}</p>
          <p>{`Rulebook ${result.rulebook}.`}</p>
          <p>{`Checked ${relativeTime(result.checkedAt, Date.now())}.${result.cached ? " Served from the day's cache." : ''}`}</p>
        </div>
        {result.servRequestId === null ? null : <p className={styles.servRun}>{`SERV RUN ${result.servRequestId}`}</p>}
      </Rise>

      {inReplay ? (
        <Rise index={4}>
          <p className={styles.replayLine} data-in-replay>
            This wallet also claimed in the ROBO airdrop.{' '}
            <Link href={`/replay?wallet=${address}`} prefetch={false} className={styles.link}>
              <span className={styles.linkLabel}>See it in the replay</span>
              <svg className={styles.linkArrow} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M1 6h9M6.5 2.5L10 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </Link>
          </p>
        </Rise>
      ) : null}

      <Rise index={5}>
        <p className={styles.closing}>
          This is an assessment of on-chain behaviour from public data. It is not an accusation about a person.
        </p>
      </Rise>
    </div>
  );
}

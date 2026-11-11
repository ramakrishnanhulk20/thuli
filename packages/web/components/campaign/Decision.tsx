import type { ReactNode } from 'react';
import { shortHash, txUrl } from '@/lib/explorer';
import { displayReason, ruleMeaning } from '@/lib/rules';
import { NEW_WALLET_ADVICE, NOT_CHECKED_INTRO, notCheckedLine, outcomeWords, showsWhatToDo, WHAT_TO_DO_LABEL, type AskJson, type Payout } from '@/lib/campaign';
import styles from './campaign.module.css';

/** Cited transactions as links, laid out as on the check page. Plain text only. */
export function CitedList({ hashes }: { hashes: readonly string[] }) {
  if (hashes.length === 0) return <p className={styles.none}>None</p>;
  return (
    <ul className={styles.txList} data-cited>
      {hashes.map((hash, index) => {
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
  );
}

/** For a held wallet that has never been used: what to do about it, in plain words, directly above the model's reason. */
export function WhatToDo({ ask }: { ask: AskJson }) {
  if (!showsWhatToDo(ask)) return null;
  return (
    <div className={styles.todoBlock} data-what-to-do>
      <h3 className={styles.todoLabel}>{WHAT_TO_DO_LABEL}</h3>
      <p className={styles.todoLine}>{NEW_WALLET_ADVICE}</p>
    </div>
  );
}

/** A decided ask as its owner sees it: the outcome, the reason, what was not checked, and what happens to the reward. */
export function DecisionView({ ask, payout, appeal = null }: { ask: AskJson; payout: Payout; appeal?: ReactNode }) {
  if (ask.action === null || ask.rule === null || ask.reason === null) return null;
  const meaning = ruleMeaning(ask.rule);
  return (
    <div data-state="decided">
      <h2 className={`${styles.banner} ${styles[ask.action]}`} data-outcome={ask.action}>
        {outcomeWords(ask.action, payout.paid)}
      </h2>
      <p className={styles.bannerMeta} data-share>{`SHARE ${(ask.shareBps ?? 0) / 100}%`}</p>

      <h3 className={styles.resultLabel}>WHY</h3>
      <div className={styles.ruleLine}>
        <span className={styles.ruleChip} data-rule>{`RULE ${ask.rule}`}</span>
        {meaning === ask.rule ? null : <p className={styles.ruleMeaning}>{meaning}</p>}
      </div>
      <WhatToDo ask={ask} />
      <p className={styles.reason} data-reason>
        {displayReason(ask.reason)}
      </p>
      <p className={styles.citedLabel}>Cited transactions</p>
      <CitedList hashes={ask.citedTxs ?? []} />

      {ask.notChecked === null || ask.notChecked.length === 0 ? null : (
        <>
          <h3 className={styles.resultLabel}>NOT CHECKED</h3>
          <p className={styles.notIntro}>{NOT_CHECKED_INTRO}</p>
          <ul className={styles.notList} data-not-checked>
            {ask.notChecked.map((name, index) => (
              <li key={`${name}-${index}`}>{notCheckedLine(name)}</li>
            ))}
          </ul>
        </>
      )}

      {appeal}

      <div className={styles.payout} data-payout>
        {payout.lines.map((line, index) => (
          <p
            key={line}
            className={`${styles.payoutLine} ${payout.paid ? styles.payoutPaid : index === 0 ? styles.payoutFirst : ''}`}
            data-payout-line
          >
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

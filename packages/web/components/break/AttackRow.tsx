'use client';

import { forwardRef } from 'react';
import type { AttackResult } from '@/lib/attacks';
import { MARKUP_REASON } from '@/lib/attacks';
import { Drop } from '../Drop';
import type { RowCopy } from './rows';
import styles from './break.module.css';

export type RowState = { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; result: AttackResult };

interface AttackRowProps {
  number: number;
  copy: RowCopy;
  state: RowState;
  disabled: boolean;
  /** Bumped every time the markup row runs, so the paragraph is made new each time. */
  markupRun: number;
  onRun: () => void;
}

function ResultLine({ result }: { result: AttackResult }) {
  if (result.status === 'refused') {
    return (
      <div className={styles.result} aria-live="polite">
        <p className={styles.resultLine}>
          <span className={`${styles.badge} ${styles.badgeRefused}`}>REFUSED</span>
          <span className={styles.answer}>{result.answer}</span>
          <span className={styles.ms}>{`${result.ms} MS`}</span>
        </p>
        {result.note === null ? null : <p className={styles.resultNote}>{result.note}</p>}
      </div>
    );
  }
  if (result.status === 'not-refused') {
    return (
      <div className={styles.result} aria-live="polite">
        <p className={styles.resultLine}>
          <span className={`${styles.badge} ${styles.badgeNot}`}>NOT REFUSED</span>
          <span className={styles.answer}>This should not happen. Please tell us.</span>
        </p>
      </div>
    );
  }
  const where = result.target === 'chain' ? 'the chain' : 'the site';
  return (
    <div className={styles.result} aria-live="polite">
      <p className={styles.resultLine}>
        <span className={`${styles.badge} ${styles.badgeLost}`}>COULD NOT RUN</span>
        <span className={styles.answer}>{`The call did not reach ${where}. Try again.`}</span>
        {result.answer === '' ? null : <span className={styles.ms}>{`STATUS ${result.answer}`}</span>}
      </p>
    </div>
  );
}

/** The reason of row 10, put on the page as a plain text node in a paragraph, the way the check page shows a reason. */
const MarkupReason = forwardRef<HTMLParagraphElement>(function MarkupReason(_props, ref) {
  return (
    <p ref={ref} className={styles.markupBox} data-reason data-markup-reason>
      {MARKUP_REASON}
    </p>
  );
});

export const AttackRow = forwardRef<HTMLParagraphElement, AttackRowProps>(function AttackRow(
  { number, copy, state, disabled, markupRun, onRun },
  markupRef,
) {
  const running = state.kind === 'running';
  return (
    <li className={styles.row} data-row={copy.id} data-state={state.kind === 'done' ? state.result.status : state.kind}>
      <span className={styles.num}>{String(number).padStart(2, '0')}</span>
      <div className={styles.rowText}>
        <h2 className={styles.rowTitle}>{copy.title}</h2>
        <p className={styles.rowLine}>{copy.line}</p>
        {state.kind === 'done' ? <ResultLine result={state.result} /> : null}
        {copy.id === 'markup' && markupRun > 0 ? <MarkupReason key={markupRun} ref={markupRef} /> : null}
      </div>
      <span className={styles.target}>{copy.tag}</span>
      <div className={styles.rowAction}>
        <button type="button" className={styles.runButton} onClick={onRun} disabled={running || disabled} data-run={copy.id}>
          {running ? 'Running' : 'Run'}
        </button>
        {running ? <Drop width={10} className={styles.pulse} /> : null}
      </div>
    </li>
  );
});

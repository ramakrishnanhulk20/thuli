'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import styles from './owner.module.css';

export type Word = 'todo' | 'wallet' | 'network' | 'done' | 'failed';

const WORD_TEXT: Record<Word, string> = {
  todo: 'To do',
  wallet: 'Waiting for your wallet',
  network: 'Waiting for the network',
  done: 'Done',
  failed: 'Failed',
};

const WORD_CLASS: Record<Word, string> = {
  todo: styles.wordTodo as string,
  wallet: styles.wordWait as string,
  network: styles.wordWait as string,
  done: styles.wordDone as string,
  failed: styles.wordFailed as string,
};

const CROSS_FADE_MILLISECONDS = 200;

/** The state word. When it changes, the old word fades out as the new one fades in, over 0.2 seconds. */
function StateWord({ word }: { word: Word }) {
  const [view, setView] = useState<{ current: Word; previous: Word | null }>({ current: word, previous: null });
  // The change is noticed while drawing, so the new word is drawn already fading in rather than flashing first.
  if (view.current !== word) setView({ current: word, previous: view.current });

  const leaving = view.previous;
  useEffect(() => {
    if (leaving === null) return;
    const timer = setTimeout(() => setView((before) => ({ ...before, previous: null })), CROSS_FADE_MILLISECONDS);
    return () => clearTimeout(timer);
  }, [leaving, word]);

  return (
    <span className={styles.word} aria-live="polite" data-state-word={word}>
      {leaving === null ? null : (
        <span className={`${styles.leaving} ${WORD_CLASS[leaving]}`} aria-hidden="true">
          {WORD_TEXT[leaving]}
        </span>
      )}
      <span key={word} className={`${leaving === null ? '' : styles.arriving} ${WORD_CLASS[word]}`}>
        {WORD_TEXT[word]}
      </span>
    </span>
  );
}

interface RowProps {
  number: string;
  title: string;
  word: Word;
  /** Only the current row is open. A row that is done keeps one line, its result. */
  open: boolean;
  result?: ReactNode;
  children?: ReactNode;
}

/**
 * One numbered row of the setup panel: its number, title and state word, then its body while it is the current row. The
 * body opens and closes by height and opacity in CSS, so the page ships no animation code for it.
 */
export function Row({ number, title, word, open, result, children }: RowProps) {
  const titleId = useId();
  return (
    <div className={styles.row} role="group" aria-labelledby={titleId} data-row={number} data-word={word} data-open={open ? 'true' : 'false'}>
      <div className={styles.rowHead}>
        <span className={styles.rowNumber}>{number}</span>
        <h3 className={styles.rowTitle} id={titleId}>
          {title}
        </h3>
        <StateWord word={word} />
      </div>
      {result === undefined || result === null ? null : <div className={styles.result}>{result}</div>}
      <div className={open ? `${styles.collapse} ${styles.collapseOpen}` : styles.collapse}>
        <div className={styles.collapseInner}>
          <div className={styles.rowBody}>{children}</div>
        </div>
      </div>
    </div>
  );
}

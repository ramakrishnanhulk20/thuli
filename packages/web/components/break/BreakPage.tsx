'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  apiAttacks,
  createChainClient,
  judgeRenderedReason,
  readActiveRoot,
  rebuiltLeaf,
  rootLineState,
  rootLineText,
  runApiAttack,
  runVaultAttack,
  vaultCalls,
  type AttackResult,
  type LiveRoot,
  type ProofFacts,
} from '@/lib/attacks';
import { Drop } from '../Drop';
import { AttackRow, type RowState } from './AttackRow';
import { ROWS, type RowId } from './rows';
import styles from './break.module.css';

const GAP_MILLISECONDS = 250;
// Long enough for an image that cannot load to fire its error handler, if the reason had become a real element.
const MARKUP_SETTLE_MILLISECONDS = 120;

const VAULT_IDS: readonly RowId[] = ['claimOther', 'claimTwice', 'claimMore', 'withdraw', 'postRoot'];

const sleep = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

function ArrowLink({ href, external, children }: { href: string; external?: boolean; children: string }) {
  const inner = (
    <>
      <span className={styles.linkLabel}>{children}</span>
      <svg className={styles.linkArrow} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M1 6h9M6.5 2.5L10 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </>
  );
  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={styles.link}>
      {inner}
    </a>
  ) : (
    <Link href={href} prefetch={false} className={styles.link}>
      {inner}
    </Link>
  );
}

export function BreakPage({ facts, settlementHref }: { facts: ProofFacts; settlementHref: string }) {
  const [states, setStates] = useState<Partial<Record<RowId, RowState>>>({});
  const [runningAll, setRunningAll] = useState(false);
  const [markupRun, setMarkupRun] = useState(0);
  const markupRef = useRef<HTMLParagraphElement>(null);
  const client = useMemo(() => createChainClient(), []);
  const [live, setLive] = useState<LiveRoot>({ status: 'reading' });
  const rootLine = useMemo(() => rootLineState(rebuiltLeaf(facts), live, facts.root), [facts, live]);
  // Only a root that is proven wrong switches the vault rows off. A vault that cannot be read leaves them to say so themselves.
  const rowsOff = rootLine.kind === 'mismatch';
  const calls = useMemo(() => vaultCalls(facts), [facts]);
  const api = useMemo(() => apiAttacks(facts), [facts]);

  useEffect(() => {
    let current = true;
    void readActiveRoot(client, facts.vault).then((read) => {
      if (current) setLive(read);
    });
    return () => {
      current = false;
    };
  }, [client, facts.vault]);

  const execute = useCallback(
    async (id: RowId): Promise<AttackResult> => {
      switch (id) {
        case 'claimOther':
        case 'claimTwice':
        case 'claimMore':
        case 'withdraw':
        case 'postRoot':
          return runVaultAttack(client, facts, calls[id]);
        case 'mistyped':
        case 'unpaid':
        case 'forged':
        case 'oversized':
          return runApiAttack(api[id]);
        case 'markup': {
          const started = performance.now();
          flushSync(() => setMarkupRun((count) => count + 1));
          await sleep(MARKUP_SETTLE_MILLISECONDS);
          const flag = (window as unknown as { __thuliBroken?: unknown }).__thuliBroken;
          return judgeRenderedReason(markupRef.current, flag, Math.round(performance.now() - started));
        }
      }
    },
    [api, calls, client, facts],
  );

  const run = useCallback(
    async (id: RowId) => {
      setStates((before) => ({ ...before, [id]: { kind: 'running' } }));
      const result = await execute(id);
      setStates((before) => ({ ...before, [id]: { kind: 'done', result } }));
    },
    [execute],
  );

  async function runAll() {
    if (runningAll) return;
    setRunningAll(true);
    try {
      for (const [index, row] of ROWS.entries()) {
        if (rowsOff && VAULT_IDS.includes(row.id)) continue;
        if (index > 0) await sleep(GAP_MILLISECONDS);
        await run(row.id);
      }
    } finally {
      setRunningAll(false);
    }
  }

  const results = ROWS.flatMap((row) => {
    const state = states[row.id];
    return state?.kind === 'done' ? [state.result] : [];
  });
  const ran = results.filter((result) => result.status !== 'could-not-run').length;
  const refused = results.filter((result) => result.status === 'refused').length;
  const allRefused = refused === ROWS.length;
  const tally = ran === 0 ? `0 of ${ROWS.length} run` : `${refused} of ${ran} refused`;

  return (
    <>
      <p className={styles.label}>
        <Drop width={8} className={styles.labelMark} />
        TRY TO BREAK IT
      </p>
      <h1 className={styles.title}>Attack it yourself.</h1>
      <p className={styles.body}>
        Every row below is a real attack, run live from your browser against the vault on Base Sepolia or against this site&apos;s own routes. Nothing here is a recording. Press a button and read what comes back.
      </p>
      <div className={styles.controls}>
        <button type="button" className={styles.primary} onClick={runAll} disabled={runningAll} data-run-all>
          {`Run all ${ROWS.length} attacks`}
        </button>
        <p className={`${styles.tally} ${allRefused ? styles.tallyFull : ''}`} data-tally aria-live="polite">
          {tally}
        </p>
      </div>
      <p className={styles.rootLine} data-root-line data-root-state={rootLine.kind} aria-live="polite">
        {rootLineText(rootLine)}
      </p>
      {rowsOff ? (
        <p className={styles.mismatch} role="alert">
          The vault record and this page disagree about the list root, so the vault rows are switched off.
        </p>
      ) : null}

      <ol className={styles.rows}>
        {ROWS.map((row, index) => (
          <AttackRow
            key={row.id}
            ref={row.id === 'markup' ? markupRef : undefined}
            number={index + 1}
            copy={row}
            state={states[row.id] ?? { kind: 'idle' }}
            disabled={rowsOff && VAULT_IDS.includes(row.id)}
            markupRun={markupRun}
            onRun={() => void run(row.id)}
          />
        ))}
      </ol>

      <h2 className={styles.blockLabel}>WHAT THIS PAGE CANNOT SHOW</h2>
      <ul className={styles.cannot}>
        <li>
          <Drop width={6} className={styles.itemMark} />
          <span>
            A replayed payment. That needs a funded wallet. The proof run paid once and replayed the same payment ten times for nothing:{' '}
            <ArrowLink href={settlementHref} external>
              the settlement on BaseScan
            </ArrowLink>
          </span>
        </li>
        <li>
          <Drop width={6} className={styles.itemMark} />
          <span>A forged appeal. Appeals are checked in code and tested, but no public route takes them yet.</span>
        </li>
        <li>
          <Drop width={6} className={styles.itemMark} />
          <span>
            Talking the model into paying a farm. The protection is structural: what the model reads holds only numbers, fixed words, addresses and hashes, and code sets a ceiling the model cannot lift.
          </span>
        </li>
        <li>
          <Drop width={6} className={styles.itemMark} />
          <span>
            Farmers who leave no shared trace. Thuli does not catch them, and says so.{' '}
            <ArrowLink href="/docs/limits">Limits</ArrowLink>
          </span>
        </li>
      </ul>
    </>
  );
}

'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { relativeTime } from '@/lib/check';
import { addressLink, ETHEREUM_CHAIN, shortAddress } from '@/lib/explorer';
import { displayReason } from '@/lib/rules';
import { formatInt } from '@/lib/format';
import {
  APPEAL_COPY,
  appealChip,
  appealCountsLine,
  BOARD_PAGE_SIZE,
  boardCheckWords,
  fetchBoard,
  funderFanoutText,
  funderKindWords,
  groupText,
  mergeBoard,
  outcomeWords,
  pollDelay,
  settledWords,
  type AppealCounts,
  type AppealView,
  type AskJson,
} from '@/lib/campaign';
import { Drop } from '../Drop';
import { CitedList, WhatToDo } from './Decision';
import { useReadPause } from './useReadPause';
import { useNow, useVisibleInterval } from './useVisibleInterval';
import styles from './campaign.module.css';

const REFRESH_MILLISECONDS = 10_000;

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div>
      <p className={styles.factName}>{name}</p>
      <div className={styles.factValue}>{children}</div>
    </div>
  );
}

function Facts({ ask }: { ask: AskJson }) {
  const { facts } = ask;
  if (facts === null) return null;
  const funder = facts.funder;
  // The funder is a wallet Thuli read on Ethereum, so it opens on the Ethereum explorer.
  const funderLink = funder === null ? null : addressLink(ETHEREUM_CHAIN, funder.address);
  const fanout = funder === null ? null : funderFanoutText(funder);
  return (
    <div className={styles.facts} data-facts>
      <Fact name="Wallet age">{facts.ageDays === null ? 'not read' : `${formatInt(facts.ageDays)} days`}</Fact>
      <Fact name="Transactions sent">{facts.txCount === null ? 'not read' : formatInt(facts.txCount)}</Fact>
      <Fact name="First funder">
        {funder === null ? (
          'none found'
        ) : (
          <>
            {funderLink === null ? (
              shortAddress(funder.address)
            ) : (
              <a className={styles.factLink} href={funderLink} target="_blank" rel="noopener noreferrer">
                <span className={styles.factLinkLabel}>{shortAddress(funder.address)}</span>
              </a>
            )}
            {`, ${funderKindWords(funder.kind)}`}
          </>
        )}
      </Fact>
      {fanout === null ? null : <Fact name="Asking wallets that funder paid">{fanout}</Fact>}
      <Fact name="Linked group">{groupText(facts.groupSize)}</Fact>
    </div>
  );
}

/** What the outside judges said about an appealed row, and the owner's call once there is one. */
function BoardCheck({ appeal }: { appeal: AppealView }) {
  const words = boardCheckWords(appeal);
  const settled = settledWords(appeal);
  return (
    <div className={styles.boardCheck} data-board-check>
      <p className={styles.factName}>{APPEAL_COPY.boardLabel}</p>
      <p className={styles.factValue} data-board-check-headline>
        {words.headline}
      </p>
      {words.note === null ? null : (
        <p className={styles.factValue} data-board-check-note>
          {words.note}
        </p>
      )}
      {settled === null ? null : (
        <p className={styles.factValue} data-board-settled>
          {settled.headline}
        </p>
      )}
    </div>
  );
}

function BoardRow({ ask, now }: { ask: AskJson; now: number }) {
  const [open, setOpen] = useState(false);
  const action = ask.action ?? 'hold';
  const detailsId = `board-${ask.wallet}`;
  const when = ask.decidedAt ?? ask.askedAt;
  const chip = appealChip(ask.appeal ?? null);
  return (
    <li className={`${styles.row} ${styles[action]}`} data-board-row data-wallet={ask.wallet}>
      <button type="button" className={styles.rowButton} aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((value) => !value)}>
        <span className={styles.rowWallet}>{shortAddress(ask.wallet)}</span>
        <span className={styles.rowOutcome}>
          <span className={styles.dot} aria-hidden="true" />
          {outcomeWords(action, false, 'board')}
          {chip === null ? null : (
            <span className={`${styles.chip} ${chip.tone === 'full' ? styles.chipReversed : ''}`} data-chip>
              {chip.text}
            </span>
          )}
        </span>
        <span className={styles.rowRule}>{ask.rule === null ? '' : `RULE ${ask.rule}`}</span>
        <span className={styles.rowReason}>{ask.reason === null ? '' : displayReason(ask.reason)}</span>
        <span className={styles.rowTime}>{relativeTime(when, now)}</span>
        <span className={styles.rowSlot}>{ask.slot === null ? '' : `SLOT ${ask.slot}`}</span>
      </button>
      {open ? (
        <div id={detailsId} className={styles.rowOpen} data-row-open>
          <WhatToDo ask={ask} />
          <p className={styles.reason} data-reason>
            {ask.reason === null ? '' : displayReason(ask.reason)}
          </p>
          <p className={styles.citedLabel}>Cited transactions</p>
          <CitedList hashes={ask.citedTxs ?? []} />
          <Facts ask={ask} />
          {ask.appeal ? <BoardCheck appeal={ask.appeal} /> : null}
        </div>
      ) : null}
    </li>
  );
}

export function Board({ campaignId, appeals, onSlowed }: { campaignId: string; appeals: AppealCounts; onSlowed: (route: string, slowed: boolean) => void }) {
  const [rows, setRows] = useState<AskJson[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const now = useNow(30_000);
  const { slowed, busy, ok, quiet } = useReadPause('board', onSlowed);
  const countsLine = appealCountsLine(appeals);

  const refresh = useCallback(async () => {
    if (quiet()) return;
    const read = await fetchBoard(campaignId, null);
    if (read.kind === 'busy') {
      busy();
      return;
    }
    if (read.kind === 'failed') return;
    ok();
    const page = read.asks;
    setRows((current) => (current === null ? page : mergeBoard(current, page)));
    setMore((current) => (current ? current : page.length === BOARD_PAGE_SIZE));
  }, [campaignId, busy, ok, quiet]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useVisibleInterval(() => void refresh(), pollDelay(REFRESH_MILLISECONDS, slowed));

  async function showEarlier() {
    if (rows === null || rows.length === 0 || loadingMore) return;
    const oldest = rows[rows.length - 1];
    if (oldest === undefined) return;
    setLoadingMore(true);
    const read = await fetchBoard(campaignId, oldest.decidedAt ?? oldest.askedAt);
    setLoadingMore(false);
    if (read.kind === 'busy') {
      busy();
      return;
    }
    if (read.kind === 'failed') return;
    ok();
    const page = read.asks;
    setRows((current) => mergeBoard(current ?? [], page));
    setMore(page.length === BOARD_PAGE_SIZE);
  }

  return (
    <section className={styles.block} aria-labelledby="board-title" data-board>
      <p className={styles.label}>
        <Drop width={8} className={styles.labelMark} />
        THE BOARD
      </p>
      <h2 id="board-title" className={styles.blockHeading}>
        Every decision, as it happens
      </h2>
      {countsLine === null ? null : (
        <p className={styles.appealCounts} data-appeal-counts>
          {countsLine}
        </p>
      )}
      {rows !== null && rows.length === 0 ? (
        <p className={styles.empty} data-board-empty>
          Nobody has asked yet.
        </p>
      ) : (
        <ul className={styles.rows}>
          {(rows ?? []).map((ask) => (
            <BoardRow key={ask.wallet} ask={ask} now={now} />
          ))}
        </ul>
      )}
      {more ? (
        <button type="button" className={styles.more} onClick={() => void showEarlier()} disabled={loadingMore} data-show-earlier>
          Show earlier
        </button>
      ) : null}
    </section>
  );
}

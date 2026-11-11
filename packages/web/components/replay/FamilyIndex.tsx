'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatInt } from '@/lib/format';
import type { WebGroup } from '@/lib/replay/types';
import styles from './replay.module.css';

const FIRST_ROWS = 40;

type SortKey = 'size' | 'robo' | 'held';

const SORTS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'size', label: 'LARGEST' },
  { key: 'robo', label: 'MOST ROBO' },
  { key: 'held', label: 'MOST HELD' },
];

interface FamilyIndexProps {
  groups: WebGroup[];
  onSelect: (index: number) => void;
  onHover: (index: number | null) => void;
}

export function FamilyIndex({ groups, onSelect, onHover }: FamilyIndexProps) {
  const [sort, setSort] = useState<SortKey>('size');
  const [showAll, setShowAll] = useState(false);

  const order = useMemo(
    () =>
      groups
        .map((_, index) => index)
        .sort((a, b) => (groups[b] as WebGroup)[sort] - (groups[a] as WebGroup)[sort] || a - b),
    [groups, sort],
  );
  const totalWallets = useMemo(() => groups.reduce((sum, group) => sum + group.size, 0), [groups]);

  // The list is replaced by another view when a row is chosen, and a mouse leave never fires on a removed row.
  useEffect(() => () => onHover(null), [onHover]);

  const visible = showAll ? order : order.slice(0, FIRST_ROWS);

  return (
    <>
      <h2 className={styles.heading}>Linked families</h2>
      <p className={styles.sub}>
        {`${formatInt(groups.length)} families holding ${formatInt(totalWallets)} wallets. Pick one on the map or in the list.`}
      </p>
      <div className={styles.chips} role="group" aria-label="Sort families">
        {SORTS.map((option) => (
          <button key={option.key} type="button" className={styles.chip} aria-pressed={sort === option.key} onClick={() => setSort(option.key)}>
            {option.label}
          </button>
        ))}
      </div>
      <div className={styles.rows} data-family-list>
        {visible.map((index) => {
          const group = groups[index] as WebGroup;
          return (
            <button
              key={index}
              type="button"
              className={styles.row}
              data-family-row={index}
              onClick={() => onSelect(index)}
              onMouseEnter={() => onHover(index)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(index)}
              onBlur={() => onHover(null)}
            >
              <span className={styles.rowNumber}>{`#${index + 1}`}</span>
              <span className={styles.rowSize}>{`${formatInt(group.size)} wallets`}</span>
              <span className={`${styles.rowHeld} ${group.held > 0 ? styles.rowHeldOn : ''}`}>{`${formatInt(group.held)} held`}</span>
              <span className={styles.rowRobo}>{`${formatInt(group.robo)} ROBO`}</span>
            </button>
          );
        })}
      </div>
      {!showAll && order.length > FIRST_ROWS ? (
        <button type="button" className={`${styles.quiet} ${styles.showAll}`} onClick={() => setShowAll(true)}>
          <span className={styles.quietLabel}>{`Show all ${formatInt(order.length)} families`}</span>
        </button>
      ) : null}
    </>
  );
}

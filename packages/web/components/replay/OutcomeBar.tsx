import { formatInt } from '@/lib/format';
import { OUTCOME_STYLES } from '@/lib/replay/replayTypes';
import type { OutcomeName } from '@/lib/replay/types';
import styles from './replay.module.css';

// Held first, then excluded, partial and full: the order the bar and the legend both read in.
const DISPLAY_ORDER = [OUTCOME_STYLES[2], OUTCOME_STYLES[3], OUTCOME_STYLES[1], OUTCOME_STYLES[0]] as const;

export function OutcomeBar({ totals }: { totals: Record<OutcomeName, number> }) {
  return (
    <>
      <div className={styles.bar} aria-hidden="true">
        {DISPLAY_ORDER.map((outcome) =>
          totals[outcome.name] > 0 ? (
            <span key={outcome.name} className={`${styles.segment} ${styles[outcome.name]}`} style={{ flexGrow: totals[outcome.name] }} data-bar-segment={outcome.name} />
          ) : null,
        )}
      </div>
      <ul className={styles.legend}>
        {DISPLAY_ORDER.map((outcome) => (
          <li key={outcome.name} className={`${styles.legendRow} ${styles[outcome.name]}`}>
            <span className={styles.swatch} aria-hidden="true" />
            <span className={styles.legendName}>{outcome.label}</span>
            <span className={styles.legendCount} data-legend-count={outcome.name}>
              {formatInt(totals[outcome.name])}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

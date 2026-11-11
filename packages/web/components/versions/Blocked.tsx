import { Drop } from '../Drop';
import type { Verdict, VersionsFile } from '@/lib/replay/types';
import styles from './versions.module.css';

const ACTION_CLASS: Record<string, string | undefined> = {
  hold: styles.actionHold,
  full: styles.actionFull,
  partial: styles.actionPartial,
  exclude: styles.actionExclude,
};

const actionClass = (action: string) => ACTION_CLASS[action] ?? '';

export function Blocked({ verdicts, routes, total }: { verdicts: Verdict[]; routes: VersionsFile['routes']; total: number }) {
  return (
    <section className={styles.section} aria-labelledby="blocked-title">
      <p id="blocked-title" className={styles.label}>
        <Drop width={8} className={styles.labelMark} />
        {`THE ${verdicts.length} BLOCKED DECISIONS`}
      </p>
      <ul className={styles.verdicts}>
        {verdicts.map((verdict, index) => (
          <li key={index} className={styles.verdict}>
            <span className={styles.group}>{verdict.group}</span>
            <span className={styles.dim}>SCORE {verdict.score}</span>
            <span className={styles.dim}>{verdict.confidence} confidence</span>
            <span className={styles.actions}>
              <span className={actionClass(verdict.v1Action)}>V1 {verdict.v1Action}</span>
              <svg className={styles.arrow} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M1 6h9M6.5 2.5L10 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              <span className={actionClass(verdict.v2Action)}>V2 {verdict.v2Action}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className={styles.routesLine}>
        {`Reppo's routes over all ${total} checks: ${routes.ship} ship, ${routes.review} review, ${routes.block} block.`}
      </p>
    </section>
  );
}

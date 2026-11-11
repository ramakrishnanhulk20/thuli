import type { VersionsFile } from '@/lib/replay/types';
import { Drop } from '../Drop';
import styles from './versions.module.css';

export function NotCovered({ noReply, testWalletAppeals }: { noReply: VersionsFile['noReply']; testWalletAppeals: number }) {
  const items = [
    'Each wallet has one stored reply and both columns check that one reply, so neither shows how a model would answer under a different rulebook text.',
    'Reppo judged decisions made before the shared-funder rule. No verdict here is on a v2 decision.',
    'Right on a blocked entry means that version no longer makes the decision Reppo blocked, not that Reppo would pass what it does instead.',
    "Hop's probably-real wallets are not proved real, and the rate comes from a sample.",
    `A record with no model reply to check again keeps its stored hold in both columns: ${noReply.robo} in ROBO, ${noReply.hopSample} in the Hop sample, ${noReply.hopEliminated} in the eliminated sample.`,
    ...(testWalletAppeals >= 1 ? ['One appeal exists and it was written by a test wallet, so it is left out of every number here.'] : []),
    'Dollar figures elsewhere on this site value ROBO at the claim-day price. Nothing was sold or paid.',
  ];

  return (
    <section className={styles.section} aria-labelledby="not-covered-title">
      <p id="not-covered-title" className={styles.label}>
        <Drop width={8} className={styles.labelMark} />
        NOT COVERED
      </p>
      <ul className={styles.notCovered}>
        {items.map((text) => (
          <li key={text}>
            <Drop width={6} className={styles.itemMark} />
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

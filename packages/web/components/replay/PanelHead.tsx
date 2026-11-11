import { formatInt } from '@/lib/format';
import type { ReplaySummary } from '@/lib/replay/replayTypes';
import { Drop } from '../Drop';
import { OutcomeBar } from './OutcomeBar';
import { WalletSearch } from './WalletSearch';
import styles from './replay.module.css';

export function PanelHead({ summary }: { summary: ReplaySummary }) {
  const { key, other } = summary.outcomes;
  const totals = {
    full: key.full + other.full,
    partial: key.partial + other.partial,
    hold: key.hold + other.hold,
    exclude: key.exclude + other.exclude,
  };
  const rulebook = summary.run.rulebook === undefined ? "Thuli's rulebook" : `Thuli's rulebook v${summary.run.rulebook}`;

  return (
    <div className={styles.head}>
      <p className={styles.label}>
        <Drop width={8} className={styles.labelMark} />
        <span>REPLAY</span>
      </p>
      <h1 className={styles.title}>The ROBO airdrop, replayed.</h1>
      <p className={styles.lede}>
        {`${formatInt(summary.wallets)} wallets claimed this airdrop. This is what ${rulebook} decides for each one, using only chain data from before the first claim. No money moved.`}
      </p>
      <OutcomeBar totals={totals} />
      <p className={styles.note}>
        Most wallets are cut to a partial reward because one exchange first funded them in large same-day bursts. That is a pattern, not proof of one owner.
      </p>
      <WalletSearch />
    </div>
  );
}

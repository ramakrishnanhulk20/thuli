import { formatInt, formatPercent } from '@/lib/format';
import type { HopFile } from '@/lib/replay/types';
import { Drop } from '../Drop';
import styles from './versions.module.css';

export function Control({ hop }: { hop: HopFile }) {
  const { probablyReal, eliminated } = hop;
  return (
    <section className={styles.section} aria-labelledby="control-title">
      <p className={styles.label}>
        <Drop width={8} className={styles.labelMark} />
        CONTROL GROUP
      </p>
      <h2 id="control-title" className={styles.h2}>
        {"Hop's list, with no model in the loop."}
      </h2>
      <p className={styles.body}>
        {"Hop Protocol published the wallets it kept and the wallets it removed from its 2022 airdrop. Thuli's code alone, reading only chain data from before Hop's snapshot:"}
      </p>
      <div className={styles.controls}>
        <div className={styles.control}>
          <p className={styles.number}>{formatPercent(probablyReal.held, probablyReal.counted, 1)}</p>
          <p className={styles.controlLabel}>of the wallets Hop kept are held</p>
          <p className={styles.counts}>
            {`${formatInt(probablyReal.held)} of ${formatInt(probablyReal.counted)}, ${probablyReal.excluded} excluded`}
          </p>
        </div>
        <div className={styles.control}>
          <p className={styles.number}>{formatPercent(eliminated.held, eliminated.counted, 1)}</p>
          <p className={styles.controlLabel}>of the wallets Hop removed are held</p>
          <p className={styles.counts}>{`${formatInt(eliminated.held)} of ${formatInt(eliminated.counted)}`}</p>
          <p className={styles.controlNote}>
            Not a catch rate: Hop found its list with a transfer graph, so a graph method agrees with it partly by construction.
          </p>
        </div>
      </div>
    </section>
  );
}

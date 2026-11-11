import * as motion from 'motion/react-client';
import type { ScorecardCell, ScorecardRow } from '@/lib/replay/load';
import { rowReveal } from './reveal';
import styles from './versions.module.css';

const MEASURES: Record<ScorecardRow['key'], { name: string; plain: string }> = {
  catch: {
    name: 'Farm wallets caught',
    plain: "Wallets on Bitquery's ROBO farm list that Thuli holds or excludes.",
  },
  falseHold: {
    name: 'Real users held by mistake',
    plain: "Hop's probably-real wallets, a random sample, held or excluded.",
  },
  feedback: {
    name: 'Blocked decisions no longer made',
    plain: "Holds that Reppo's judges blocked. Right means this version no longer makes that hold.",
  },
  cost: {
    name: 'The cost of the change',
    plain: 'Wallets Hop removed, a sample on rules A8 and A9, still held. Not a catch rate.',
  },
};

function Value({ tag, cell, accent }: { tag: string; cell: ScorecardCell; accent: boolean }) {
  return (
    <div role="cell" className={styles.valueCell}>
      <span className={styles.tag}>{tag}</span>
      <p className={`${styles.number} ${accent ? styles.numberAccent : ''}`}>{cell.value}</p>
      {cell.counts ? <p className={styles.counts}>{cell.counts}</p> : null}
      {cell.interval ? <p className={styles.counts}>{cell.interval}</p> : null}
    </div>
  );
}

export function Scorecard({ rows }: { rows: ScorecardRow[] }) {
  return (
    <div role="table" aria-label="Rulebook scorecard" className={styles.scorecard}>
      <div role="row" className={styles.headRow}>
        <span role="columnheader">
          <span className={styles.visuallyHidden}>Measure</span>
        </span>
        <span role="columnheader">RULEBOOK V1</span>
        <span role="columnheader">RULEBOOK V2</span>
      </div>
      {rows.map((row, index) => (
        <motion.div key={row.key} role="row" className={`${styles.row} ${styles.reveal}`} {...rowReveal(index)}>
          <div role="rowheader" className={styles.measure}>
            <p className={styles.measureName}>{MEASURES[row.key].name}</p>
            <p className={styles.measurePlain}>{MEASURES[row.key].plain}</p>
          </div>
          <Value tag="V1" cell={row.v1} accent={false} />
          <Value tag="V2" cell={row.v2} accent={row.key === 'falseHold'} />
        </motion.div>
      ))}
    </div>
  );
}

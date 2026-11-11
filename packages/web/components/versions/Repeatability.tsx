import * as motion from 'motion/react-client';
import { buildRepeatability, loadConsistency } from '@/lib/replay/load';
import { Drop } from '../Drop';
import { rowReveal } from './reveal';
import styles from './versions.module.css';

/** The wallets screened again from scratch and how often they got the same outcome, all of it written from consistency.json. */
export function Repeatability() {
  const view = buildRepeatability(loadConsistency());
  return (
    <section className={styles.section} aria-labelledby="repeat-title" data-repeatability>
      <motion.div className={styles.reveal} {...rowReveal(0)}>
        <p className={styles.label}>
          <Drop width={8} className={styles.labelMark} />
          ASKED AGAIN
        </p>
        <h2 id="repeat-title" className={styles.h2}>
          The same wallet, the same answer.
        </h2>
        <p className={styles.body}>{view.firstParagraph}</p>
      </motion.div>
      <div className={styles.repeatFigures}>
        {view.figures.map((figure, index) => (
          <motion.div key={figure.label} className={`${styles.repeatFigure} ${styles.reveal}`} {...rowReveal(index)}>
            <p className={styles.number}>{figure.value}</p>
            <p className={styles.repeatLabel}>{figure.label}</p>
            <p className={styles.repeatNote}>{figure.note}</p>
          </motion.div>
        ))}
      </div>
      {view.flaw === null ? null : (
        <motion.p className={`${styles.body} ${styles.repeatFlaw} ${styles.reveal}`} {...rowReveal(0)}>
          {view.flaw}
        </motion.p>
      )}
      <motion.p className={`${styles.repeatNote} ${styles.repeatClosing} ${styles.reveal}`} {...rowReveal(0)}>
        {view.closing}
      </motion.p>
    </section>
  );
}

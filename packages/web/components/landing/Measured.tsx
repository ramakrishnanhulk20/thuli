import Link from 'next/link';
import * as motion from 'motion/react-client';
import { formatInt, formatPercent, formatUsdCents } from '@/lib/format';
import { loadHop, loadSummary, loadVersions } from '@/lib/replay/load';
import { Drop } from '../Drop';
import { CountUp } from './CountUp';
import styles from './landing.module.css';

const reveal = (index: number) => ({
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.25 },
  transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] as [number, number, number, number], delay: index * 0.08 },
});

export function Measured() {
  const summary = loadSummary();
  const { v2 } = loadVersions();
  const hop = loadHop();
  const { farmKey } = summary;

  const figures = [
    {
      value: formatPercent(farmKey.held, farmKey.wallets, 1),
      label: "of the wallets on Bitquery's farm list held back",
      note: `${formatInt(farmKey.held)} of ${formatInt(farmKey.wallets)}, using only chain data from before the first claim.`,
    },
    {
      value: formatPercent(v2.falseHold.held, v2.falseHold.wallets, 2),
      label: "of Hop's probably-real wallets held by mistake",
      note: `${v2.falseHold.held} of ${formatInt(v2.falseHold.wallets)} in a random sample, after the model. Code alone: ${formatInt(hop.probablyReal.held)} of ${formatInt(hop.probablyReal.counted)} (${formatPercent(hop.probablyReal.held, hop.probablyReal.counted, 1)}). Hop's list is not proof that a wallet is real.`,
    },
    {
      value: `$${(summary.run.spentCents / 100 / summary.wallets).toFixed(4)}`,
      label: 'of SERV credit to screen one wallet',
      note: `Realised: ${formatUsdCents(summary.run.spentCents)} for ${formatInt(summary.wallets)} wallets. Thuli's price is 5 cents a wallet.`,
    },
  ];

  return (
    <section id="measured" className={styles.section} aria-labelledby="measured-title">
      <div className={styles.inner}>
        <motion.p className={`${styles.label} ${styles.reveal}`} {...reveal(0)}>
          <Drop width={8} className={styles.labelMark} />
          PROOF
        </motion.p>
        <motion.h2 id="measured-title" className={`${styles.heading} ${styles.reveal}`} {...reveal(1)}>
          Measured, not claimed.
        </motion.h2>
        <motion.div className={styles.reveal} {...reveal(2)}>
          <p className={styles.body}>
            Every number here comes from a run you can repeat. The method and its limits are on the versions page.
          </p>
          <div className={styles.linkRow}>
            <Link href="/versions" className={styles.link}>
              <span className={styles.linkLabel}>How these were measured</span>
              <svg className={styles.linkArrow} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M1 6h9M6.5 2.5L10 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </Link>
          </div>
        </motion.div>

        <div className={styles.figures}>
          {figures.map((item) => (
            <div key={item.label}>
              <Drop width={10} className={styles.figureMark} />
              <CountUp value={item.value} className={styles.figure} />
              <p className={styles.figureLabel}>{item.label}</p>
              <p className={styles.figureNote}>{item.note}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

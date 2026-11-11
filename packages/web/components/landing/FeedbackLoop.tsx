import type { CSSProperties } from 'react';
import Link from 'next/link';
import * as motion from 'motion/react-client';
import { formatPercent } from '@/lib/format';
import { loadVersions } from '@/lib/replay/load';
import { Drop } from '../Drop';
import { ElevenDots } from './ElevenDots';
import styles from './landing.module.css';

const EASE = [0.16, 1, 0.3, 1] as [number, number, number, number];

const reveal = (index: number) => ({
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.25 },
  transition: { duration: 0.7, ease: EASE, delay: index * 0.08 },
});

export function FeedbackLoop() {
  const { v1, v2, verdicts, routes, eliminatedHeld } = loadVersions();
  const routesTotal = routes.ship + routes.review + routes.block + routes.unread;
  const v1Rate = v1.falseHold.held / v1.falseHold.wallets;
  const v2Rate = v2.falseHold.held / v2.falseHold.wallets;
  const v2Width = `${((v2Rate / v1Rate) * 100).toFixed(2)}%`;

  const bars = [
    { tag: 'V1', fill: styles.barFillOld, width: '100%', delay: 0, number: formatPercent(v1.falseHold.held, v1.falseHold.wallets, 2) },
    { tag: 'V2', fill: styles.barFillNew, width: v2Width, delay: 0.2, number: formatPercent(v2.falseHold.held, v2.falseHold.wallets, 2) },
  ];

  return (
    <section id="feedback" className={styles.section} aria-labelledby="feedback-title">
      <div className={styles.inner}>
        <motion.p className={`${styles.label} ${styles.reveal}`} {...reveal(0)}>
          <Drop width={8} className={styles.labelMark} />
          FEEDBACK
        </motion.p>
        <motion.h2 id="feedback-title" className={`${styles.heading} ${styles.reveal}`} {...reveal(1)}>
          It gets better when it is wrong.
        </motion.h2>

        <div className={styles.feedback}>
          <motion.div className={`${styles.feedbackText} ${styles.reveal}`} {...reveal(2)}>
            <p className={styles.body}>
              {`An outside judge, Reppo, read ${routesTotal} of Thuli's decisions without seeing a single address. It blocked ${verdicts.length} holds: the evidence was a shared funder and nothing else.`}
            </p>
            <p className={styles.body}>So the rulebook changed by one rule: a shared funder alone cannot hold a wallet.</p>
            <p className={styles.body}>Scored again on the same model replies, before and after:</p>
            <div className={styles.linkRow}>
              <Link href="/versions" prefetch={false} className={styles.link}>
                <span className={styles.linkLabel}>See both versions side by side</span>
                <svg className={styles.linkArrow} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M1 6h9M6.5 2.5L10 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </Link>
            </div>
          </motion.div>

          <div>
            <p className={styles.rowLabel}>{"FALSE HOLDS, HOP'S PROBABLY-REAL SAMPLE"}</p>
            <motion.div className={styles.bars} initial="hidden" whileInView="shown" viewport={{ once: true, amount: 0.4 }}>
              {bars.map((bar) => (
                <div key={bar.tag} className={styles.barRow}>
                  <span className={styles.barTag}>{bar.tag}</span>
                  <div className={styles.barTrack}>
                    <motion.div
                      className={`${styles.barFill} ${bar.fill}`}
                      style={{ '--w': bar.width } as CSSProperties}
                      variants={{
                        hidden: { width: '0%' },
                        shown: { width: bar.width, transition: { duration: 0.9, ease: EASE, delay: bar.delay } },
                      }}
                    />
                  </div>
                  <span className={styles.barNumber}>{bar.number}</span>
                </div>
              ))}
            </motion.div>

            <ElevenDots
              afterActions={verdicts.map((verdict) => verdict.v2Action)}
              before={`${v1.feedback.right} of ${v1.feedback.total}`}
              after={`${v2.feedback.right} of ${v2.feedback.total}`}
            />

            <p className={styles.cost}>
              {`The cost: the same change also releases some wallets Hop removed. In that sample, holds fell from ${formatPercent(eliminatedHeld.v1.held, eliminatedHeld.v1.wallets, 1)} to ${formatPercent(eliminatedHeld.v2.held, eliminatedHeld.v2.wallets, 1)}. That is the price of the rule, not a catch rate.`}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

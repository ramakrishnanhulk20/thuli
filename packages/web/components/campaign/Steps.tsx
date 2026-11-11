'use client';

import { motion, useReducedMotion } from 'motion/react';
import type { Step } from '@/lib/campaign';
import { Drop } from '../Drop';
import styles from './campaign.module.css';

const EASE = [0.16, 1, 0.3, 1] as [number, number, number, number];

const STEPS = [
  { number: '01', heading: 'Ask', body: 'Sign one short message with your wallet. It costs nothing and moves nothing.' },
  {
    number: '02',
    heading: 'Screened in public',
    body: "Thuli reads the wallet's history and how it links to the other wallets that asked. The decision and its reason go on the board, usually within a minute.",
  },
  {
    number: '03',
    heading: 'Listed, then paid',
    body: "Approved wallets go on a list posted to the vault. The vault waits at least one hour before it pays, so the campaign's owner can cancel a bad list. Then Thuli submits your claim and the money arrives. You pay no gas.",
  },
] as const;

function StepContent({ number, heading, body }: { number: string; heading: string; body: string }) {
  return (
    <>
      <span className={styles.stepDrop} aria-hidden="true">
        <Drop width={8} />
      </span>
      <p className={styles.stepNumber}>{number}</p>
      <h3 className={styles.stepHeading}>{heading}</h3>
      <p className={styles.stepBody}>{body}</p>
    </>
  );
}

/** The three steps from asking to being paid, with the one the visitor is on lit. Nothing here is a control. */
export function Steps({ current }: { current: Step | null }) {
  const still = useReducedMotion() === true;
  return (
    <section className={styles.steps} aria-labelledby="steps-title" data-steps>
      <h2 className={styles.label} id="steps-title">
        <Drop width={8} className={styles.labelMark} />
        HOW IT GOES
      </h2>
      <ol className={styles.stepList}>
        {STEPS.map((step, index) => {
          const lit = current === index + 1;
          const className = `${styles.step} ${lit ? styles.stepCurrent : ''}`;
          const marks = { 'data-step': index + 1, 'data-current': lit ? 'true' : 'false', 'aria-current': lit ? ('step' as const) : undefined };
          if (still) {
            return (
              <li key={step.number} className={className} {...marks}>
                <StepContent {...step} />
              </li>
            );
          }
          return (
            <motion.li
              key={step.number}
              className={className}
              {...marks}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.6, ease: EASE, delay: index * 0.08 }}
            >
              <StepContent {...step} />
            </motion.li>
          );
        })}
      </ol>
      <p className={styles.stepsNote}>The waiting time is set in the vault contract. Thuli cannot shorten it.</p>
    </section>
  );
}

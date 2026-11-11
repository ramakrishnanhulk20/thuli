'use client';

import { motion, useReducedMotion } from 'motion/react';
import { ArrowLink } from '../campaign/ArrowLink';
import campaign from '../campaign/campaign.module.css';
import { Drop } from '../Drop';
import styles from './owner.module.css';

const EASE = [0.16, 1, 0.3, 1] as [number, number, number, number];

const BLOCKS = [
  {
    heading: 'You, the owner',
    mark: 'you',
    lines: ['Cancel any list during the waiting time', 'Pause the vault', 'Move the end date later', 'Take back what is left after the end'],
  },
  {
    heading: 'Thuli, the agent',
    mark: 'thuli',
    lines: [
      'Post a list of approved wallets',
      "Submit a listed wallet's claim and pay its gas",
      'Nothing else. It cannot withdraw, change the terms, or pay a wallet more than the cap.',
    ],
  },
] as const;

const MARK_CLASS = { you: styles.youMark, thuli: styles.thuliMark } as const;

function Lines({ lines, mark }: { lines: readonly string[]; mark: 'you' | 'thuli' }) {
  return (
    <ul className={styles.lines}>
      {lines.map((line) => (
        <li key={line} className={styles.line}>
          <span className={`${styles.lineMark} ${MARK_CLASS[mark]}`} aria-hidden="true">
            <Drop width={8} />
          </span>
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

function BlockBody({ block }: { block: (typeof BLOCKS)[number] }) {
  return (
    <>
      <h3 className={styles.blockHeading}>{block.heading}</h3>
      <Lines lines={block.lines} mark={block.mark} />
    </>
  );
}

/**
 * What the owner can do with the vault and what Thuli can, set beside the form so it is read before anything is signed.
 * The same elements are drawn on the server and in the browser; for someone who asks for less motion only the length of
 * the fade changes, because a different tree on the client would leave the server's hidden style in place.
 */
export function WhoCanDo() {
  const still = useReducedMotion() === true;
  return (
    <section className={campaign.steps} aria-labelledby="who-title" data-who>
      <h2 className={campaign.label} id="who-title">
        <Drop width={8} className={campaign.labelMark} />
        WHO CAN DO WHAT
      </h2>
      <motion.div
        className={styles.blocks}
        initial="hidden"
        whileInView="shown"
        viewport={{ once: true, amount: 0.2 }}
        variants={{ hidden: {}, shown: { transition: { staggerChildren: still ? 0 : 0.08 } } }}
      >
        {BLOCKS.map((block, index) => (
          <motion.div
            key={block.heading}
            data-who-block={index + 1}
            variants={{ hidden: { opacity: 0, y: 16 }, shown: { opacity: 1, y: 0, transition: { duration: still ? 0 : 0.6, ease: EASE } } }}
          >
            <BlockBody block={block} />
          </motion.div>
        ))}
      </motion.div>
      <p className={styles.whoNote}>These limits are in the vault contract, not in a promise.</p>
      <div className={styles.whoLink}>
        <ArrowLink href="/docs/contracts">Read the contract</ArrowLink>
      </div>
    </section>
  );
}

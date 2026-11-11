import * as motion from 'motion/react-client';
import Link from 'next/link';
import { describeVaultProof, loadVaultProof } from '@/lib/vaultProof';
import { Drop } from '../Drop';
import { ProofLine } from './ProofLine';
import styles from './vaultProof.module.css';

const reveal = (index: number) => ({
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.25 },
  transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] as [number, number, number, number], delay: index * 0.08 },
});

function ArrowLink({ href, children }: { href: string; children: string }) {
  return (
    <a className={styles.link} href={href} target="_blank" rel="noopener noreferrer">
      <span className={styles.linkLabel}>{children}</span>
      <svg className={styles.linkArrow} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M1 6h9M6.5 2.5L10 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </a>
  );
}

export function VaultProof() {
  const view = describeVaultProof(loadVaultProof());

  const points = [
    {
      heading: 'A new list waits.',
      line: `Every list Thuli posts sits for a delay the project chose, and the project can cancel it in that time. In the proof below the delay was ${view.delay}.`,
    },
    {
      heading: 'A wallet is paid once.',
      line: 'The contract remembers what each wallet has received and pays only the difference, never more than the cap the project set.',
    },
    {
      heading: 'What is left goes back.',
      line: 'After the end date only the project can withdraw the rest. Nobody can take it earlier, and a pause cannot run out the clock.',
    },
  ];

  return (
    <section id="vault" className={styles.section} aria-labelledby="vault-title">
      <div className={styles.inner}>
        <motion.p className={`${styles.label} ${styles.reveal}`} {...reveal(0)}>
          <Drop width={8} className={styles.labelMark} />
          ON CHAIN
        </motion.p>
        <motion.h2 id="vault-title" className={`${styles.heading} ${styles.reveal}`} {...reveal(1)}>
          The reward money sits in a contract, not with us.
        </motion.h2>
        <motion.div className={styles.reveal} {...reveal(2)}>
          <p className={styles.body}>
            {"A project puts its reward pool into a vault on Base. Thuli's key can do one thing there: post a list. It cannot move a cent."}
          </p>
        </motion.div>

        <div className={styles.points}>
          {points.map((point) => (
            <div key={point.heading} data-point>
              <Drop width={10} className={styles.pointMark} />
              <h3 className={styles.pointHeading}>{point.heading}</h3>
              <p className={styles.pointLine}>{point.line}</p>
            </div>
          ))}
        </div>

        <div className={styles.proof} data-proof>
          <p className={styles.proofLabel}>PROVED ON BASE SEPOLIA, WITH TEST USDC</p>
          <ProofLine steps={view.steps} />

          <div className={styles.cards}>
            <div className={styles.card} data-card="paid">
              <span className={`${styles.tag} ${styles.tagPaid}`}>PAID</span>
              <p className={styles.account}>{view.paid.short}</p>
              <p className={styles.result}>{`received ${view.paid.amount} USDC, exactly the amount on the list.`}</p>
            </div>
            <div className={styles.card} data-card="refused">
              <span className={`${styles.tag} ${styles.tagRefused}`}>REFUSED</span>
              <p className={styles.account}>{view.refused.short}</p>
              <p className={styles.result}>
                {`tried to claim with another wallet's proof. The contract answered ${view.refused.error}. This was a simulated call: nothing was sent.`}
              </p>
            </div>
          </div>

          <div className={styles.links}>
            <ArrowLink href={view.vaultUrl}>The vault on BaseScan</ArrowLink>
            <ArrowLink href={view.factoryUrl}>{"The factory's verified source"}</ArrowLink>
            <Link className={styles.link} href="/break">
              <span className={styles.linkLabel}>Attack this vault yourself</span>
              <svg className={styles.linkArrow} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M1 6h9M6.5 2.5L10 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </Link>
          </div>
          <p className={styles.lastLine}>Test money on a test network. Base mainnet is not deployed yet.</p>
        </div>
      </div>
    </section>
  );
}

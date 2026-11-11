import Link from 'next/link';
import * as motion from 'motion/react-client';
import { OUTCOME_WORDS } from '@/lib/check';
import { loadPaidExample } from '@/lib/paidExample';
import { loadSummary } from '@/lib/replay/load';
import { displayReason } from '@/lib/rules';
import { Drop } from '../Drop';
import styles from './paidApi.module.css';

const EASE = [0.16, 1, 0.3, 1] as [number, number, number, number];

const reveal = (index: number) => ({
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.25 },
  transition: { duration: 0.7, ease: EASE, delay: index * 0.08 },
});

const STUB_CIRCLES = 10;

function ArrowLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} className={styles.link}>
      <span className={styles.linkLabel}>{children}</span>
      <svg className={styles.linkArrow} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M1 6h9M6.5 2.5L10 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </Link>
  );
}

export function PaidApi() {
  const example = loadPaidExample();
  const summary = loadSummary();
  const cents = (summary.run.spentCents / summary.wallets).toFixed(2);
  const paid = `${example.price} USDC on ${example.networkName}`;
  const reason = displayReason(example.reason);

  const steps = [
    { title: 'Ask', line: 'POST /api/x402/screen with one wallet address.' },
    {
      title: 'Pay',
      line: `The answer is 402 Payment required with the terms: ${paid}. Sign that payment and send the same request again.`,
    },
    { title: 'Get the decision', line: 'One payment buys exactly one result, and a settled payment always gets its answer.' },
  ];

  return (
    <section id="agents" className={styles.section} aria-labelledby="agents-title">
      <div className={styles.inner}>
        <div className={styles.layout}>
          <div>
            <motion.p className={`${styles.label} ${styles.reveal}`} {...reveal(0)}>
              <Drop width={8} className={styles.labelMark} />
              FOR AGENTS AND SCRIPTS
            </motion.p>
            <motion.h2 id="agents-title" className={`${styles.heading} ${styles.reveal}`} {...reveal(1)}>
              One wallet, five cents, no account.
            </motion.h2>
            <motion.div className={styles.reveal} {...reveal(2)}>
              <p className={styles.body}>
                Any program can buy one screening over plain HTTP. It asks, gets a price back, pays in USDC, and asks again. No key and no sign-up.
              </p>
            </motion.div>

            <ol className={styles.steps}>
              {steps.map((step, index) => (
                <li key={step.title} className={styles.step}>
                  <span className={styles.stepNumber}>{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <h3 className={styles.stepTitle}>{step.title}</h3>
                    <p className={styles.stepLine}>{step.line}</p>
                  </div>
                </li>
              ))}
            </ol>

            <p className={styles.price}>
              {`Price: 5 cents a wallet. In the replay, the realised model cost came to ${cents} cents a wallet.`}
            </p>
            <div className={styles.links}>
              <ArrowLink href="/docs/paid-api">Read the API docs</ArrowLink>
              <ArrowLink href="/check">Try the free check</ArrowLink>
            </div>
            {example.testnet ? (
              <p className={styles.lastLine}>Proved on Base Sepolia with test USDC. Base mainnet waits for the site&apos;s public address.</p>
            ) : null}
          </div>

          <motion.div
            className={`${styles.receipt} ${styles.reveal}`}
            data-receipt
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.7, ease: EASE }}
          >
            <div className={styles.stub} aria-hidden="true">
              {Array.from({ length: STUB_CIRCLES }, (_, index) => (
                <span key={index} className={styles.punch} />
              ))}
            </div>
            <div className={styles.receiptRow}>
              <p className={styles.rowName}>A REAL PAID SCREENING</p>
              <p className={styles.rowDate}>{example.checkedText}</p>
            </div>
            <div className={styles.receiptRow}>
              <p className={styles.rowName}>WALLET</p>
              <p className={styles.rowWallet}>{example.walletShort}</p>
            </div>
            <div className={styles.receiptRow}>
              <p className={styles.rowName}>DECISION</p>
              <div className={styles.decision}>
                <p className={`${styles.outcome} ${styles[example.action]}`} data-outcome={example.action}>
                  {OUTCOME_WORDS[example.action]}
                </p>
                <span className={styles.chip}>{`RULE ${example.rule}`}</span>
              </div>
            </div>
            <div className={styles.receiptRow}>
              <p className={styles.rowName}>REASON</p>
              <p className={styles.reason} title={reason}>
                {reason}
              </p>
            </div>
            <div className={styles.receiptRow}>
              <p className={styles.rowName}>PAID</p>
              <p className={styles.rowPaid}>{paid}</p>
            </div>
            <div className={styles.receiptRow}>
              <p className={styles.rowName}>SETTLEMENT</p>
              <a className={styles.settlement} href={example.settlementUrl} target="_blank" rel="noopener noreferrer">
                <span className={styles.settlementLabel}>{example.transactionShort}</span>
              </a>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

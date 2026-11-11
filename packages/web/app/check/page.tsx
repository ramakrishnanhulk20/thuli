import type { Metadata } from 'next';
import { CheckForm } from '@/components/check/CheckForm';
import { ArrowLink } from '@/components/check/CheckStates';
import styles from '@/components/check/check.module.css';
import { Drop } from '@/components/Drop';
import { SiteNav } from '@/components/site/SiteNav';

export const metadata: Metadata = {
  title: 'Check a wallet',
};

const CANNOT_SEE = [
  'Whether it belongs to a group of linked wallets on the same claim list',
  'Whether it shares an exchange deposit address with other claimants',
  'Whether an exchange funded it in a same-day burst with other claimants',
  'Whether its claim was paid to a different address',
];

export default function CheckPage() {
  return (
    <>
      <SiteNav mode="bar" />
      <main id="check" className={styles.page}>
        <div className={styles.column}>
          <p className={styles.label}>
            <Drop width={8} className={styles.labelMark} />
            CHECK
          </p>
          <h1 className={styles.title}>Check any wallet.</h1>
          <p className={styles.body}>
            Paste an Ethereum address. Thuli reads its public history and applies the same rulebook as the replay, to that one wallet alone. Free, with no sign-in.
          </p>
          <CheckForm />

          <h2 className={styles.blockLabel}>WHAT ONE CHECK CANNOT SEE</h2>
          <p className={styles.copy}>
            A farm shows up across a list, not inside one wallet. Checked alone, these four things cannot be measured:
          </p>
          <ul className={styles.cannotList}>
            {CANNOT_SEE.map((text) => (
              <li key={text}>
                <Drop width={6} className={styles.itemMark} />
                <span>{text}</span>
              </li>
            ))}
          </ul>
          <p className={styles.copy}>
            Screening a whole claim list is what Thuli is for. The replay shows that on a real airdrop.
          </p>
          <div className={styles.linkRow}>
            <ArrowLink href="/replay">Open the replay</ArrowLink>
          </div>

          <h2 className={styles.blockLabel}>LIMITS</h2>
          <p className={styles.limits}>
            Up to 5 new checks an hour for each visitor. A result is kept for a day, so checking the same wallet again costs nothing.
          </p>
        </div>
      </main>
    </>
  );
}

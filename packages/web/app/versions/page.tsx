import type { Metadata } from 'next';
import Link from 'next/link';
import { Drop } from '@/components/Drop';
import { SiteNav } from '@/components/site/SiteNav';
import { Blocked } from '@/components/versions/Blocked';
import { Control } from '@/components/versions/Control';
import { NotCovered } from '@/components/versions/NotCovered';
import { Scorecard } from '@/components/versions/Scorecard';
import styles from '@/components/versions/versions.module.css';
import { loadHop, loadScorecard, loadVersions } from '@/lib/replay/load';
import { SHARE_IMAGE } from '@/lib/siteUrl';

const DESCRIPTION = 'Each Thuli rulebook version scored the same way, with what changed and what the numbers do not cover.';

export const metadata: Metadata = {
  title: 'Versions',
  description: DESCRIPTION,
  openGraph: { title: 'Versions', description: DESCRIPTION, images: [SHARE_IMAGE] },
};

export default function VersionsPage() {
  const versions = loadVersions();
  const hop = loadHop();
  const { runDate, rows, routesTotal } = loadScorecard();

  return (
    <>
      <SiteNav mode="bar" />
      <main id="versions" className={styles.page}>
        <div className={styles.inner}>
          <p className={styles.label}>
            <Drop width={8} className={styles.labelMark} />
            VERSIONS
          </p>
          <h1 className={styles.title}>Every rulebook version, scored the same way.</h1>
          <p className={styles.body}>
            Both versions are scored by plain code on the same stored model replies, so the only difference between the columns is the rule that changed.
          </p>
          <p className={styles.run}>RUN {runDate}</p>

          <Scorecard rows={rows} />

          <section className={styles.section} aria-labelledby="changed-title">
            <p className={styles.label}>
              <Drop width={8} className={styles.labelMark} />
              WHAT CHANGED IN V2
            </p>
            <h2 id="changed-title" className={styles.h2}>
              One rule, added after outside feedback.
            </h2>
            <p className={styles.body}>
              {`Reppo's judges read ${routesTotal} of Thuli's decisions with every address, hash and amount removed. They blocked ${versions.routes.block}. In each one the reason given for the hold was a funder shared with other wallets.`}
            </p>
            <p className={styles.body}>
              Rulebook v2 adds: a shared funder alone cannot hold a wallet. How many wallets a funder paid is a count, not a trail. A wallet with a link of its own, or a traced trail to a shared source, is still held.
            </p>
          </section>

          <Blocked verdicts={versions.verdicts} routes={versions.routes} total={routesTotal} />
          <Control hop={hop} />
          <NotCovered noReply={versions.noReply} testWalletAppeals={versions.testWalletAppeals} />

          <div className={styles.footLink}>
            <Link href="/replay" prefetch={false} className={styles.link}>
              <span className={styles.linkLabel}>Open the replay</span>
              <svg className={styles.linkArrow} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M1 6h9M6.5 2.5L10 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}

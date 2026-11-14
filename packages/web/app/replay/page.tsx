import type { Metadata } from 'next';
import { Suspense } from 'react';
import summaryFile from '@/public/replay/robo/summary.json';
import { PanelHead } from '@/components/replay/PanelHead';
import { ReplayExplorer } from '@/components/replay/ReplayExplorer';
import styles from '@/components/replay/replay.module.css';
import { SiteNav } from '@/components/site/SiteNav';
import type { ReplaySummary } from '@/lib/replay/replayTypes';
import { SHARE_IMAGE } from '@/lib/siteUrl';

const DESCRIPTION = "Every wallet that claimed the ROBO airdrop, with Thuli's decision, its reason and the transactions behind it.";

export const metadata: Metadata = {
  title: 'Replay',
  description: DESCRIPTION,
  openGraph: { title: 'Replay', description: DESCRIPTION, images: [SHARE_IMAGE] },
};

const summary: ReplaySummary = summaryFile;

export default function ReplayPage() {
  const head = <PanelHead summary={summary} />;
  return (
    <>
      <SiteNav mode="bar" />
      <main id="replay">
        <Suspense fallback={<div className={styles.page}>{head}</div>}>
          <ReplayExplorer
            head={head}
            groups={summary.groups}
            usdPerRobo={summary.drop.usdPerRobo}
            run={{ wallets: summary.wallets, spentCents: summary.run.spentCents }}
            farmKey={{ families: summary.farmKey.families.total, wallets: summary.farmKey.wallets }}
          />
        </Suspense>
      </main>
    </>
  );
}

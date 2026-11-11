import type { Metadata } from 'next';
import { Suspense } from 'react';
import summaryFile from '@/public/replay/robo/summary.json';
import { PanelHead } from '@/components/replay/PanelHead';
import { ReplayExplorer } from '@/components/replay/ReplayExplorer';
import styles from '@/components/replay/replay.module.css';
import { SiteNav } from '@/components/site/SiteNav';
import type { ReplaySummary } from '@/lib/replay/replayTypes';

export const metadata: Metadata = {
  title: 'Replay',
};

const summary: ReplaySummary = summaryFile;

export default function ReplayPage() {
  const head = <PanelHead summary={summary} />;
  return (
    <>
      <SiteNav mode="bar" />
      <main id="replay">
        <Suspense fallback={<div className={styles.page}>{head}</div>}>
          <ReplayExplorer head={head} groups={summary.groups} usdPerRobo={summary.drop.usdPerRobo} />
        </Suspense>
      </main>
    </>
  );
}

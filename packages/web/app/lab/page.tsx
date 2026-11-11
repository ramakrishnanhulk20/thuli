import type { Metadata } from 'next';
import { LabNotes } from '@/components/lab/LabNotes';
import { SiteNav } from '@/components/site/SiteNav';

export const metadata: Metadata = {
  title: 'Lab',
  robots: { index: false, follow: false },
};

export default function LabPage() {
  return (
    <>
      <SiteNav mode="bar" />
      <main id="lab">
        <LabNotes />
      </main>
    </>
  );
}

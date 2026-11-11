import type { Metadata } from 'next';
import { Hero } from '@/components/hero/Hero';
import { CaseFile } from '@/components/landing/CaseFile';
import { FeedbackLoop } from '@/components/landing/FeedbackLoop';
import { Measured } from '@/components/landing/Measured';
import { PaidApi } from '@/components/landing/PaidApi';
import { VaultProof } from '@/components/landing/VaultProof';
import { SiteNav } from '@/components/site/SiteNav';

const TITLE = 'Thuli: airdrop rewards for real users, not farms';
const DESCRIPTION = 'Thuli screens an airdrop claim list, holds back farm wallets, and gives a reason for every wallet it holds.';

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION },
};

export default function HomePage() {
  return (
    <>
      <main id="home">
        <Hero />
        <CaseFile />
        <Measured />
        <FeedbackLoop />
        <VaultProof />
        <PaidApi />
      </main>
      <SiteNav mode="bar" revealAfterHero />
    </>
  );
}

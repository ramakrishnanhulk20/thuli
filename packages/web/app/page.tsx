import type { Metadata } from 'next';
import { Hero } from '@/components/hero/Hero';
import { CaseFile } from '@/components/landing/CaseFile';
import { FeedbackLoop } from '@/components/landing/FeedbackLoop';
import { Measured } from '@/components/landing/Measured';
import { SiteNav } from '@/components/site/SiteNav';

export const metadata: Metadata = {
  title: { absolute: 'Thuli: airdrop rewards for real users, not farms' },
  description: 'Thuli screens an airdrop claim list, holds back farm wallets, and gives a reason for every wallet it holds.',
};

export default function HomePage() {
  return (
    <>
      <main id="home">
        <Hero />
        <CaseFile />
        <Measured />
        <FeedbackLoop />
      </main>
      <SiteNav mode="bar" revealAfterHero />
    </>
  );
}

import type { Metadata } from 'next';
import { CheckRun } from '@/components/check/CheckRun';
import styles from '@/components/check/check.module.css';
import { SiteNav } from '@/components/site/SiteNav';
import { addressFromRoute } from '@/lib/check';
import { shortAddress } from '@/lib/explorer';

interface RouteProps {
  params: Promise<{ address: string }>;
}

export async function generateMetadata({ params }: RouteProps): Promise<Metadata> {
  const address = addressFromRoute((await params).address);
  return {
    title: address === null ? 'Check a wallet' : `Check ${shortAddress(address)}`,
    description: "Thuli's decision for this wallet, with its reason and what a single check cannot see.",
    robots: { index: false, follow: false },
  };
}

export default async function CheckAddressPage({ params }: RouteProps) {
  const address = addressFromRoute((await params).address);
  return (
    <>
      <SiteNav mode="bar" />
      <main id="check-result" className={styles.page}>
        <div className={styles.column}>
          <CheckRun key={address ?? 'none'} address={address} />
        </div>
      </main>
    </>
  );
}

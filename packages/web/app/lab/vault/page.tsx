import type { Metadata } from 'next';
import { VaultProof } from '@/components/landing/VaultProof';
import { SiteNav } from '@/components/site/SiteNav';

export const metadata: Metadata = {
  title: 'Vault proof',
  robots: { index: false, follow: false },
};

export default function VaultLabPage() {
  return (
    <>
      <SiteNav mode="bar" />
      <main id="vault-lab">
        <VaultProof />
      </main>
    </>
  );
}

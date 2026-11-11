import type { Metadata } from 'next';
import campaign from '@/components/campaign/campaign.module.css';
import { OwnerPage } from '@/components/owner/OwnerPage';
import styles from '@/components/owner/owner.module.css';
import { SiteNav } from '@/components/site/SiteNav';
import { SHARE_IMAGE } from '@/lib/siteUrl';

const TITLE = 'Start a campaign';
const DESCRIPTION = 'Put rewards in a vault that only screened wallets can claim from.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, images: [SHARE_IMAGE] },
};

// The WalletConnect project id is a NEXT_PUBLIC variable: Next fixes it into the site when it is built.
export default function StartCampaignRoute() {
  const walletConnectProjectId = (process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '').trim();
  return (
    <>
      <SiteNav mode="bar" />
      <main id="start-campaign" className={styles.page}>
        <div className={campaign.column}>
          <OwnerPage walletConnectProjectId={walletConnectProjectId} />
        </div>
      </main>
    </>
  );
}

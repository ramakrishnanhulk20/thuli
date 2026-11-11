import type { Metadata } from 'next';
import { CampaignPage } from '@/components/campaign/CampaignPage';
import styles from '@/components/campaign/campaign.module.css';
import { NoCampaign } from '@/components/campaign/NoCampaign';
import { SiteNav } from '@/components/site/SiteNav';
import { SHARE_IMAGE } from '@/lib/siteUrl';

const DESCRIPTION = 'A live reward campaign screened in public: ask with your wallet and watch Thuli decide.';

export const metadata: Metadata = {
  title: 'Campaign',
  description: DESCRIPTION,
  openGraph: { title: 'Campaign', description: DESCRIPTION, images: [SHARE_IMAGE] },
};

// The campaign id is read when a visitor asks for the page, so a host can change it without a new build.
// The WalletConnect project id is a NEXT_PUBLIC variable: Next fixes it into the site when it is built.
export const dynamic = 'force-dynamic';

export default function CampaignRoute() {
  const campaignId = (process.env.DEMO_CAMPAIGN_ID ?? '').trim();
  const walletConnectProjectId = (process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '').trim();
  return (
    <>
      <SiteNav mode="bar" />
      <main id="campaign" className={styles.page}>
        <div className={styles.column}>
          {campaignId === '' ? <NoCampaign /> : <CampaignPage campaignId={campaignId} walletConnectProjectId={walletConnectProjectId} />}
        </div>
      </main>
    </>
  );
}

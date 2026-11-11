'use client';

import campaign from '../campaign/campaign.module.css';
import { Drop } from '../Drop';
import { WalletProvider } from '../wallet/WalletProvider';
import { SetupPanel } from './SetupPanel';
import { WhoCanDo } from './WhoCanDo';
import styles from './owner.module.css';

/** The owner's page: what it is for, the setup panel, and beside it what the owner and Thuli can each do. */
export function OwnerPage({ walletConnectProjectId }: { walletConnectProjectId: string }) {
  return (
    <>
      <p className={campaign.label}>
        <Drop width={8} className={campaign.labelMark} />
        FOR PROJECTS
      </p>
      <h1 className={campaign.title}>Start a campaign</h1>
      <p className={styles.intro}>
        Put your rewards in a vault on Base Sepolia. Thuli screens every wallet that asks and can only post the list of approved wallets. It can never
        withdraw, and you can cancel any list before it pays.
      </p>
      <p className={styles.testLine}>Test money on a test network.</p>
      <div className={campaign.askRow}>
        <WalletProvider walletConnectProjectId={walletConnectProjectId}>
          <SetupPanel />
        </WalletProvider>
        <WhoCanDo />
      </div>
    </>
  );
}

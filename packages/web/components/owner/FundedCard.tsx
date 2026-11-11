'use client';

import { shortAddress, shortHash } from '@/lib/explorer';
import { explorerAddressUrl, explorerTxUrl } from '@/lib/owner';
import { ArrowLink } from '../campaign/ArrowLink';
import campaign from '../campaign/campaign.module.css';
import { CopyButton } from './CopyButton';
import { ExplorerLink } from './ExplorerLink';
import styles from './owner.module.css';

interface FundedCardProps {
  vault: string;
  txHash: string;
  onRestart: () => void;
}

/** What the owner leaves with: the vault, the creation transaction to send to Thuli, and what happens next. */
export function FundedCard({ vault, txHash, onRestart }: FundedCardProps) {
  return (
    <section className={`${styles.funded} ${campaign.rise}`} aria-labelledby="funded-title" data-funded>
      <h3 id="funded-title" className={`${campaign.banner} ${campaign.full}`}>
        Your vault is funded
      </h3>
      <div className={styles.fact}>
        <p className={styles.factLabel}>Vault</p>
        <div className={styles.factLine} data-fact="vault">
          <ExplorerLink href={explorerAddressUrl(vault)}>{shortAddress(vault)}</ExplorerLink>
          <CopyButton value={vault} label="vault address" />
        </div>
      </div>
      <div className={styles.fact}>
        <p className={styles.factLabel}>Creation transaction</p>
        <div className={styles.factLine} data-fact="transaction">
          <ExplorerLink href={explorerTxUrl(txHash)}>{shortHash(txHash)}</ExplorerLink>
          <CopyButton value={txHash} label="creation transaction" />
        </div>
        <p className={styles.afterSend}>Send this to Thuli to open screening for your vault.</p>
      </div>
      <p className={styles.afterNote}>Campaigns are opened by hand while Thuli is in testing. Screening starts once Thuli has registered your vault.</p>
      <div className={styles.fundedLinks}>
        <ArrowLink href="/campaign">See the live demo campaign</ArrowLink>
      </div>
      <button type="button" className={`${campaign.quiet} ${styles.restart}`} onClick={onRestart} data-restart>
        <span className={campaign.quietLabel}>Start another vault</span>
      </button>
    </section>
  );
}

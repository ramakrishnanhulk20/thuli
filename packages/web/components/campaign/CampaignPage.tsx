'use client';

import { useCallback, useEffect, useState } from 'react';
import { chainName, explorerFor, fetchCampaign, statusLine, usdc, type CampaignView, type Step } from '@/lib/campaign';
import { shortAddress } from '@/lib/explorer';
import { Drop } from '../Drop';
import { WalletProvider } from '../wallet/WalletProvider';
import { AskPanel } from './AskPanel';
import { Board } from './Board';
import { Lists } from './Lists';
import { NoCampaign } from './NoCampaign';
import { Steps } from './Steps';
import { useNow, useVisibleInterval } from './useVisibleInterval';
import styles from './campaign.module.css';

const REFRESH_MILLISECONDS = 10_000;

type Load = { status: 'loading' } | { status: 'none' } | { status: 'found'; campaign: CampaignView };

function Head({ campaign }: { campaign: CampaignView }) {
  const reward = usdc(campaign.rewardPerWallet);
  const { counts } = campaign;
  const explorer = explorerFor(campaign.chain);
  const filled = campaign.maxSlots === 0 ? 0 : Math.min(100, (counts.slotsTaken / campaign.maxSlots) * 100);
  const figures = [
    { number: `${counts.slotsTaken} of ${campaign.maxSlots}`, label: 'SLOTS TAKEN' },
    { number: String(counts.asked), label: 'WALLETS ASKED' },
    { number: String(counts.held), label: 'HELD FOR REVIEW' },
    { number: `${reward} USDC`, label: 'PER WALLET' },
  ];
  return (
    <>
      <p className={styles.label}>
        <Drop width={8} className={styles.labelMark} />
        LIVE CAMPAIGN
      </p>
      <h1 className={styles.title} data-campaign-name>
        {campaign.name}
      </h1>
      <p className={styles.body} data-campaign-body>
        {`${campaign.maxSlots} wallets can each receive ${reward} USDC from a vault on ${chainName(campaign.chain)}. Ask with your wallet. Thuli screens it in public, and an approved wallet is paid by the vault with no gas to pay. Farmers are welcome to try.`}
      </p>
      <div className={styles.figures} data-figures>
        {figures.map((figure, index) => (
          <div key={figure.label} data-figure={figure.label}>
            <p className={styles.figureNumber}>{figure.number}</p>
            <p className={styles.figureLabel}>{figure.label}</p>
            {index === 0 ? (
              <div className={styles.track} data-track aria-hidden="true">
                <div className={styles.trackFill} data-fill style={{ width: `${filled}%` }} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <p className={styles.vaultLine} data-vault-line>
        <span>
          VAULT{' '}
          {explorer === null ? (
            shortAddress(campaign.vault)
          ) : (
            <a className={styles.inline} href={`${explorer}/address/${campaign.vault}`} target="_blank" rel="noopener noreferrer">
              <span className={styles.inlineLabel}>{shortAddress(campaign.vault)}</span>
            </a>
          )}
        </span>
        <span data-status>{statusLine(campaign)}</span>
      </p>
      {campaign.chain === 84532 ? <p className={styles.testLine}>Test money on a test network.</p> : null}
    </>
  );
}

export function CampaignPage({ campaignId, walletConnectProjectId }: { campaignId: string; walletConnectProjectId: string }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [step, setStep] = useState<Step | null>(1);
  const now = useNow(30_000);

  const refresh = useCallback(async () => {
    const campaign = await fetchCampaign(campaignId);
    setLoad((before) => {
      if (campaign !== null) return { status: 'found', campaign };
      // A refresh that fails keeps the campaign already on screen; only the first read can say there is none.
      return before.status === 'found' ? before : { status: 'none' };
    });
  }, [campaignId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useVisibleInterval(() => void refresh(), REFRESH_MILLISECONDS, load.status === 'found');

  if (load.status === 'none') return <NoCampaign />;
  if (load.status === 'loading') {
    return (
      <div className={styles.loading} aria-busy="true">
        <p className={styles.label}>
          <Drop width={8} className={styles.labelMark} />
          LIVE CAMPAIGN
        </p>
      </div>
    );
  }

  const { campaign } = load;
  return (
    <>
      <Head campaign={campaign} />
      <div className={styles.askRow}>
        <WalletProvider walletConnectProjectId={walletConnectProjectId}>
          <AskPanel campaignId={campaignId} campaign={campaign} now={now} onGone={() => setLoad({ status: 'none' })} onStep={setStep} />
        </WalletProvider>
        <Steps current={step} />
      </div>
      <Board campaignId={campaignId} />
      <Lists campaignId={campaignId} campaign={campaign} />
    </>
  );
}

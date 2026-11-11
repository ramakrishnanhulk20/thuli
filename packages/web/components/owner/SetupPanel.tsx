'use client';

import { useState } from 'react';
import { useConnection, useDisconnect, useSwitchChain } from 'wagmi';
import { BASE_SEPOLIA } from '@/lib/contracts';
import { shortAddress } from '@/lib/explorer';
import campaign from '../campaign/campaign.module.css';
import { ConnectChoices } from '../wallet/ConnectButton';
import { Flow } from './Flow';
import styles from './owner.module.css';

/** The setup panel: connect a wallet, get it onto Base Sepolia, then the four rows. */
export function SetupPanel() {
  const connection = useConnection();
  const { mutate: disconnect } = useDisconnect();
  const { mutate: switchChain, isPending: switching } = useSwitchChain();
  // Starting another vault remounts the rows, so every field and every step begins again.
  const [generation, setGeneration] = useState(0);

  const address = connection.isConnected && connection.address !== undefined ? connection.address : null;
  const panel = address === null ? 'connect' : connection.chainId !== BASE_SEPOLIA.chainId ? 'network' : 'setup';

  const walletRow =
    address === null ? null : (
      <div className={campaign.walletRow}>
        <span className={campaign.walletAddress} data-wallet>
          {shortAddress(address)}
        </span>
        <button type="button" className={campaign.quiet} onClick={() => disconnect()}>
          <span className={campaign.quietLabel}>Disconnect</span>
        </button>
      </div>
    );

  return (
    <section className={campaign.panel} aria-labelledby="setup-title" data-panel={panel}>
      <div key={panel} className={campaign.rise}>
        {panel === 'connect' ? (
          <>
            <h2 id="setup-title" className={campaign.panelTitle}>
              Connect the wallet that will own the vault
            </h2>
            <p className={campaign.panelBody}>It signs three transactions and pays their gas. Use a wallet with test USDC and a little Base Sepolia ETH.</p>
            <ConnectChoices />
          </>
        ) : null}

        {panel === 'network' ? (
          <>
            {walletRow}
            <h2 id="setup-title" className={campaign.panelTitle}>
              This page works on Base Sepolia.
            </h2>
            <button
              type="button"
              className={`${styles.primary} ${styles.afterLine}`}
              disabled={switching}
              onClick={() => switchChain({ chainId: BASE_SEPOLIA.chainId })}
              data-switch
            >
              Switch to Base Sepolia
            </button>
          </>
        ) : null}

        {panel === 'setup' && address !== null ? (
          <>
            <h2 id="setup-title" className={campaign.visuallyHidden}>
              Vault setup
            </h2>
            {walletRow}
            <Flow key={`${address}:${generation}`} wallet={address} onRestart={() => setGeneration((value) => value + 1)} />
          </>
        ) : null}
      </div>
    </section>
  );
}

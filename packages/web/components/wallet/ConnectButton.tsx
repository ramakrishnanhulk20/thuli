'use client';

import { useEffect, useState } from 'react';
import { useConnect, useConnectors } from 'wagmi';
import styles from './wallet.module.css';

type Found = 'unknown' | 'found' | 'none';

/** The ways to connect: a browser wallet, and WalletConnect when the settings give it a project id. */
export function ConnectChoices() {
  const connectors = useConnectors();
  const { mutate, isPending } = useConnect();
  const [found, setFound] = useState<Found>('unknown');

  const browser = connectors.find((connector) => connector.id === 'injected') ?? connectors.find((connector) => connector.type === 'injected');
  const walletConnect = connectors.find((connector) => connector.type === 'walletConnect');

  useEffect(() => {
    let current = true;
    if (browser === undefined) {
      setFound('none');
      return;
    }
    browser
      .getProvider()
      .then((provider) => {
        if (current) setFound(provider === undefined || provider === null ? 'none' : 'found');
      })
      .catch(() => {
        if (current) setFound('none');
      });
    return () => {
      current = false;
    };
  }, [browser]);

  return (
    <div>
      <div className={styles.choices}>
        <div className={styles.choice}>
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            disabled={isPending || found === 'none' || browser === undefined}
            onClick={() => browser !== undefined && mutate({ connector: browser })}
            data-connect="browser"
          >
            Browser wallet
          </button>
          {found === 'none' ? (
            <p className={styles.hint}>
              {walletConnect === undefined
                ? 'No browser wallet found. Install one and reload this page.'
                : 'No browser wallet found. Install one and reload this page, or use WalletConnect with a phone wallet.'}
            </p>
          ) : null}
        </div>
        {walletConnect === undefined ? null : (
          <button
            type="button"
            className={`${styles.button} ${styles.outline}`}
            disabled={isPending}
            onClick={() => mutate({ connector: walletConnect })}
            data-connect="walletconnect"
          >
            WalletConnect
          </button>
        )}
      </div>
    </div>
  );
}

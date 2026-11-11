import { createConfig, http } from 'wagmi';
import { base, baseSepolia } from 'wagmi/chains';
import { injected, walletConnect } from 'wagmi/connectors';

/**
 * The wallet settings for the campaign page: Base Sepolia and Base over their public endpoints, a browser wallet, and
 * WalletConnect only when a project id is set. A visitor who never connected is never connected by the page, because
 * wagmi only restores a connection it stored.
 */
export function createWalletConfig(walletConnectProjectId: string) {
  const connectors = [injected(), ...(walletConnectProjectId === '' ? [] : [walletConnect({ projectId: walletConnectProjectId })])];
  return createConfig({
    chains: [baseSepolia, base],
    connectors,
    transports: { [baseSepolia.id]: http(), [base.id]: http() },
    ssr: true,
  });
}

export type WalletConfig = ReturnType<typeof createWalletConfig>;

'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { WagmiProvider } from 'wagmi';
import { createWalletConfig } from '@/lib/wagmi';

/** Wraps one page only, so no other page ships wallet code. */
export function WalletProvider({ walletConnectProjectId, children }: { walletConnectProjectId: string; children: ReactNode }) {
  const [config] = useState(() => createWalletConfig(walletConnectProjectId));
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}

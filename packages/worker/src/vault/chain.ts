import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS, parseAddress } from '@thuli/core';
import { VAULT_ABI } from './abi.ts';
import type { VaultPort } from './root.ts';

export const BASE_SEPOLIA = CHAINS['base-sepolia'];
const RPC_TIMEOUT_MS = 30_000;
const RECEIPT_TIMEOUT_MS = 180_000;

export class ChainCallError extends Error {
  override name = 'ChainCallError';
}

export type Wallet = WalletClient<Transport, Chain, Account>;

export interface Connection {
  publicClient: PublicClient<Transport, Chain>;
  wallet(privateKey: `0x${string}`): Wallet;
}

/**
 * Clients for Base Sepolia on `rpcUrl`. Refuses before any transaction when the RPC reports another chain, so a wrong
 * URL can never spend a key's ETH elsewhere.
 *
 * @throws ChainCallError when the RPC is on any chain but 84532.
 */
export async function connectBaseSepolia(rpcUrl: string): Promise<Connection> {
  const chain = defineChain({
    id: BASE_SEPOLIA.id,
    name: 'Base Sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = http(rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 2 });
  const publicClient = createPublicClient({ chain, transport });
  const reported = await publicClient.getChainId();
  if (reported !== BASE_SEPOLIA.id) {
    throw new ChainCallError(`the RPC is on chain ${reported}; this runs only on Base Sepolia (${BASE_SEPOLIA.id})`);
  }
  return {
    publicClient,
    wallet: (privateKey) => createWalletClient({ account: privateKeyToAccount(privateKey), chain, transport }),
  };
}

export interface Sent {
  hash: Hash;
  gasUsed: bigint;
  from: Address;
}

/** Waits for a sent transaction and refuses anything but success. */
export async function confirm(publicClient: PublicClient<Transport, Chain>, hash: Hash, from: Address): Promise<Sent> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== 'success') throw new ChainCallError(`transaction ${hash} reverted`);
  return { hash, gasUsed: receipt.gasUsed, from };
}

/** The custom error a reverted call carried, such as InvalidProof, or undefined when it carried none we know. */
export function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
}

export function txLink(hash: Hash): string {
  return `${BASE_SEPOLIA.explorer}/tx/${hash}`;
}

export function addressLink(address: string): string {
  return `${BASE_SEPOLIA.explorer}/address/${parseAddress(address)}`;
}

/** The agent key's view of a vault, for root.ts postRoot. */
export function vaultPort(publicClient: PublicClient<Transport, Chain>, agent: Wallet): VaultPort {
  return {
    signer: agent.account.address,
    chainId: () => publicClient.getChainId(),
    async readState(vault) {
      const state = await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'state' });
      return {
        agent: parseAddress(state.agent),
        deposited: state.deposited,
        perWalletCap: state.perWalletCap,
        pendingRoot: state.pendingRoot,
      };
    },
    async sendPostRoot(vault, root, declaredTotal) {
      const { request } = await publicClient.simulateContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: 'postRoot',
        args: [root, declaredTotal],
        account: agent.account,
      });
      return confirm(publicClient, await agent.writeContract(request), agent.account.address);
    },
  };
}

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAbiItem,
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
import { FACTORY_ABI, VAULT_ABI } from './abi.ts';
import type { VaultPort } from './root.ts';

export const BASE_SEPOLIA = CHAINS['base-sepolia'];
const RPC_TIMEOUT_MS = 30_000;
const RECEIPT_TIMEOUT_MS = 180_000;
// Multicall3 sits at this address on Base Sepolia, as on most chains; it lets every snapshot read share one block.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const VAULT_CREATED = getAbiItem({ abi: FACTORY_ABI, name: 'VaultCreated' });
// Public nodes rate-limit by request size and by requests in flight, so claimed() is read 1,000 wallets per eth_call,
// one call at a time: 100,000 wallets are 100 calls in a row, never 100 at once (C41).
export const CLAIMED_BATCH = 1_000;

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
  const chain = baseSepoliaChain(rpcUrl);
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

/** Base Sepolia as viem needs it, with Multicall3 so snapshot reads can share one block. */
export function baseSepoliaChain(rpcUrl: string): Chain {
  return defineChain({
    id: BASE_SEPOLIA.id,
    name: 'Base Sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
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
    async readSnapshot(vault, accounts) {
      const block = await publicClient.getBlock({ blockTag: 'latest' });
      const blockNumber = block.number;
      const state = await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'state', blockNumber });
      const claimed = new Map<Address, bigint>();
      for (let start = 0; start < accounts.length; start += CLAIMED_BATCH) {
        const batch = accounts.slice(start, start + CLAIMED_BATCH);
        // batchSize 0 keeps viem from splitting the batch into calls it would send all at once.
        const results = await publicClient.multicall({
          contracts: batch.map((account) => ({
            address: vault,
            abi: VAULT_ABI,
            functionName: 'claimed' as const,
            args: [account] as const,
          })),
          allowFailure: false,
          batchSize: 0,
          blockNumber,
        });
        batch.forEach((account, i) => claimed.set(account, results[i] as bigint));
      }
      return {
        blockNumber,
        timestamp: block.timestamp,
        agent: parseAddress(state.agent),
        deposited: state.deposited,
        totalPaid: state.totalPaid,
        perWalletCap: state.perWalletCap,
        endTime: state.endTime,
        rootDelay: BigInt(state.rootDelay),
        paused: state.paused,
        activeRoot: state.activeRoot,
        pendingRoot: state.pendingRoot,
        claimed,
      };
    },
    async findVaultCreated(factory, vault, block) {
      const logs = await publicClient.getLogs({
        address: factory,
        event: VAULT_CREATED,
        args: { vault },
        fromBlock: block,
        toBlock: block,
        strict: true,
      });
      return logs
        .filter((log) => parseAddress(log.address) === factory && parseAddress(log.args.vault) === vault)
        .map((log) => ({
          token: parseAddress(log.args.token),
          owner: parseAddress(log.args.owner),
          agent: parseAddress(log.args.agent),
          perWalletCap: log.args.perWalletCap,
          endTime: log.args.endTime,
          rootDelay: BigInt(log.args.rootDelay),
        }));
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

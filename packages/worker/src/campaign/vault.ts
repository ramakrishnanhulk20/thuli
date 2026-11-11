import { BaseError, ContractFunctionRevertedError, type Chain, type Hash, type PublicClient, type Transport } from 'viem';
import { AddressError, ChainError, parseAddress, parseChain, type Address, type MerkleHash } from '@thuli/core';
import { getCampaign, StoreError, type Campaign, type Db } from '@thuli/store';
import { VAULT_ABI } from '../vault/abi.ts';
import { ChainCallError, CLAIMED_BATCH, revertName, vaultPort, type Wallet } from '../vault/chain.ts';
import { ClaimListError, type ClaimTicket } from '../vault/claimList.ts';
import { RootError, type CampaignRecord, type VaultEntry, type VaultPort } from '../vault/root.ts';

export const NO_ROOT = `0x${'00'.repeat(32)}` as MerkleHash;
const RECEIPT_TIMEOUT_MS = 180_000;

/** The vault's roots and clock as one block shows them, a root whose delay is over counting as active. */
export interface VaultRoots {
  blockNumber: bigint;
  timestamp: bigint;
  activeRoot: MerkleHash;
  pendingRoot: MerkleHash;
  /** When the pending root starts paying, in Unix seconds; 0 when nothing is pending. */
  pendingClaimableAt: bigint;
  paused: boolean;
}

export type ClaimSimulation = { ok: true } | { ok: false; error: string };

/**
 * The campaign worker's view of a vault. Its only two writes are postRoot (sendPostRoot, from VaultPort) and claim
 * (sendClaim), both signed by the agent key, which the vault lets do nothing else (C30, C39). Everything else is a read.
 */
export interface CampaignVault extends VaultPort {
  roots(vault: Address): Promise<VaultRoots>;
  /**
   * claimable(account, cumulativeAmount) for each entry, every value read at `blockNumber`: the block roots() just
   * reported, so what is owed is read against the same active root the caller checked.
   */
  claimableOf(vault: Address, entries: readonly VaultEntry[], blockNumber: bigint): Promise<bigint[]>;
  /** A static call of claim from the agent: ok, or the name of the custom error it reverted with. */
  simulateClaim(vault: Address, ticket: ClaimTicket): Promise<ClaimSimulation>;
  /** Signs and broadcasts claim(account, cumulativeAmount, proof) from the agent key, and returns its hash. */
  sendClaim(vault: Address, ticket: ClaimTicket): Promise<Hash>;
  /** Waits for a sent claim. ok is false when it reverted on chain. */
  confirmClaim(hash: Hash): Promise<{ ok: boolean; gasUsed: bigint }>;
}

/**
 * Why a campaign is left alone when its row records no vault block. A public Base Sepolia node answers eth_getLogs over
 * at most 200 blocks, so the block the createVault transaction landed in is recorded with the campaign, never searched
 * for or guessed.
 */
export const NO_VAULT_BLOCK = 'the campaign records no vault block, so its vault cannot be checked';

/** What the publish, activate and relay steps share: the store, the vault port and what this process has learned. */
export interface ChainDeps {
  db: Db;
  chain: CampaignVault;
  /** The factory in the deployment record, the only one a campaign vault may come from. */
  factory: Address;
  now(): Date;
  log(line: string): void;
  memory: ChainMemory;
}

/** What one process has learned about one campaign. Kept apart per campaign, so two campaigns never share any of it. */
export interface CampaignMemory {
  /** The campaign's vault record, so the factory's log is read once; rebuilt when the recorded vault block changes. */
  record: CampaignRecord | null;
  /** List versions whose owed wallets have been queued for relay. */
  queued: Set<number>;
  /** The last reason each step gave for doing nothing, so the loop logs a reason once rather than every few seconds. */
  waiting: Map<string, string>;
}

/** Kept for the life of one process only. A restart starts it empty, which costs reads and never changes an outcome. */
export interface ChainMemory {
  campaigns: Map<string, CampaignMemory>;
}

export function emptyChainMemory(): ChainMemory {
  return { campaigns: new Map() };
}

/** The campaign's own memory, made empty the first time the campaign is seen. */
export function campaignMemory(memory: ChainMemory, campaignId: string): CampaignMemory {
  let mine = memory.campaigns.get(campaignId);
  if (mine === undefined) {
    mine = { record: null, queued: new Set(), waiting: new Map() };
    memory.campaigns.set(campaignId, mine);
  }
  return mine;
}

/**
 * The campaign row, when the vault port's chain is the campaign's chain; otherwise why the campaign is skipped. Both
 * chain ids go through parseChain, so one chain can never be told apart from itself by its spelling (C2).
 */
export async function campaignHere(
  deps: Pick<ChainDeps, 'db' | 'chain'>,
  campaignId: string,
): Promise<{ ok: true; campaign: Campaign } | { ok: false; reason: string }> {
  const campaign = await getCampaign(deps.db, campaignId);
  if (campaign === null) return { ok: false, reason: 'no campaign has this id' };
  let same: boolean;
  try {
    same = parseChain(campaign.chain) === parseChain(await deps.chain.chainId());
  } catch (error) {
    if (error instanceof ChainError) return { ok: false, reason: 'the campaign is on a chain Thuli does not run on' };
    throw error;
  }
  return same ? { ok: true, campaign } : { ok: false, reason: 'the campaign vault is on another chain than this worker' };
}

/**
 * An error in words safe for a log line. Thuli's own errors carry only public values; a library error can quote an RPC
 * URL, which may hold a key, so only its custom error name or its first short line is kept (C40).
 */
export function safeCause(error: unknown): string {
  if (
    error instanceof RootError ||
    error instanceof ClaimListError ||
    error instanceof StoreError ||
    error instanceof ChainCallError ||
    error instanceof AddressError ||
    error instanceof ChainError
  ) {
    return error.message;
  }
  const reverted = revertName(error);
  if (reverted !== undefined) return `the vault reverted with ${reverted}`;
  if (error instanceof BaseError) return (error.shortMessage.split('\n')[0] ?? error.name).slice(0, 160);
  return error instanceof Error ? error.name : 'an unknown error';
}

const RECORD_FIELDS = ['token', 'owner', 'agent', 'perWalletCap'] as const;

/**
 * The vault record postRoot and verifyVault check a vault against, built from the campaign row, the vault block it
 * records and the factory's own VaultCreated log in that one block. The row holds no end time or root delay, so those
 * are the ones the factory logged; the token, owner, agent and cap must match the row exactly, or nothing is posted.
 *
 * @throws RootError when the row records no vault block, or the factory on record did not log this vault once in that
 *   block, or logged it with other terms than the row.
 */
export async function vaultRecordFor(port: CampaignVault, campaign: Campaign, factoryAddress: Address): Promise<CampaignRecord> {
  if (campaign.vaultBlock === null) throw new RootError(`${NO_VAULT_BLOCK}; nothing was posted`);
  const createdAtBlock = campaign.vaultBlock;
  const vault = parseAddress(campaign.vault);
  const factory = parseAddress(factoryAddress);
  const created = await port.findVaultCreated(factory, vault, createdAtBlock);
  const [terms] = created;
  if (terms === undefined || created.length !== 1) {
    throw new RootError('the factory on record did not log this vault once in the recorded block; nothing was posted');
  }
  const expected = {
    token: parseAddress(campaign.token),
    owner: parseAddress(campaign.owner),
    agent: parseAddress(campaign.agent),
    perWalletCap: BigInt(campaign.perWalletCap),
  };
  for (const field of RECORD_FIELDS) {
    if (terms[field] !== expected[field]) throw new RootError(`the vault's ${field} is not the campaign's; nothing was posted`);
  }
  return { factory, vault, createdAtBlock, ...expected, endTime: terms.endTime, rootDelay: terms.rootDelay };
}

function revertedOnChain(error: unknown): boolean {
  return error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError;
}

/**
 * The agent key's view of a campaign vault on `publicClient`'s chain. Reads use the latest block; claimableOf reads
 * CLAIMED_BATCH wallets per multicall, one call at a time, so 100,000 wallets are 100 calls in a row (C41).
 */
export function campaignVault(publicClient: PublicClient<Transport, Chain>, agent: Wallet): CampaignVault {
  const claimCall = (vault: Address, ticket: ClaimTicket) =>
    publicClient.simulateContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: 'claim',
      args: [ticket.account, ticket.cumulativeAmount, ticket.proof],
      account: agent.account,
    });

  return {
    ...vaultPort(publicClient, agent),
    async roots(vault) {
      const block = await publicClient.getBlock({ blockTag: 'latest' });
      const state = await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'state', blockNumber: block.number });
      return {
        blockNumber: block.number,
        timestamp: block.timestamp,
        activeRoot: state.activeRoot,
        pendingRoot: state.pendingRoot,
        pendingClaimableAt: BigInt(state.pendingClaimableAt),
        paused: state.paused,
      };
    },
    async claimableOf(vault, entries, blockNumber) {
      const amounts: bigint[] = [];
      for (let start = 0; start < entries.length; start += CLAIMED_BATCH) {
        const batch = entries.slice(start, start + CLAIMED_BATCH);
        // batchSize 0 keeps viem from splitting the batch into calls it would send all at once.
        const results = await publicClient.multicall({
          contracts: batch.map((entry) => ({
            address: vault,
            abi: VAULT_ABI,
            functionName: 'claimable' as const,
            args: [parseAddress(entry.account), entry.cumulativeAmount] as const,
          })),
          allowFailure: false,
          batchSize: 0,
          blockNumber,
        });
        amounts.push(...(results as bigint[]));
      }
      return amounts;
    },
    async simulateClaim(vault, ticket) {
      try {
        await claimCall(vault, ticket);
        return { ok: true };
      } catch (error) {
        // A dropped connection is not an answer from the vault, so it is thrown and the relay is tried again.
        if (!revertedOnChain(error)) throw error;
        return { ok: false, error: revertName(error) ?? 'an unrecognised revert' };
      }
    },
    async sendClaim(vault, ticket) {
      const { request } = await claimCall(vault, ticket);
      return agent.writeContract(request);
    },
    async confirmClaim(hash) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      return { ok: receipt.status === 'success', gasUsed: receipt.gasUsed };
    },
  };
}

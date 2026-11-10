import type { Hash } from 'viem';
import { z } from 'zod';
import {
  buildTree,
  leafValues,
  parseAddress,
  parseChain,
  type Address,
  type LeafTree,
  type MerkleHash,
} from '@thuli/core';

export class RootError extends Error {
  override name = 'RootError';
}

/** One wallet on a published claim list: its total entitlement across every root so far, in base units (C3, C27). */
export interface VaultEntry {
  account: string;
  cumulativeAmount: bigint;
}

export interface BuiltRoot {
  root: MerkleHash;
  tree: LeafTree;
}

/** The terms a vault was created with, as the factory's VaultCreated event records them. */
export interface VaultTerms {
  token: Address;
  owner: Address;
  agent: Address;
  perWalletCap: bigint;
  endTime: bigint;
  rootDelay: bigint;
}

/** Thuli's own record of a campaign's vault: where it came from, the block it was made in, and its terms. */
export interface CampaignRecord extends VaultTerms {
  factory: Address;
  vault: Address;
  createdAtBlock: bigint;
}

/** The vault as one block shows it, with what every listed wallet has claimed, all read at `blockNumber`. */
export interface VaultSnapshot {
  blockNumber: bigint;
  timestamp: bigint;
  agent: Address;
  deposited: bigint;
  totalPaid: bigint;
  perWalletCap: bigint;
  endTime: bigint;
  rootDelay: bigint;
  paused: boolean;
  pendingRoot: MerkleHash;
  claimed: ReadonlyMap<Address, bigint>;
}

const MAX_UINT256 = 2n ** 256n - 1n;
// Every leaf sits in memory while the tree is built; a list this long is not one campaign's claim list (C41).
export const MAX_ROOT_ENTRIES = 100_000;
const MAX_PUBLISHED_BYTES = MAX_ROOT_ENTRIES * 120;
const TERM_FIELDS = ['token', 'owner', 'agent', 'perWalletCap', 'endTime', 'rootDelay'] as const;

/**
 * The vault's Merkle root for a list, built through core's leaf encoding so it matches what ThuliVault hashes (C28).
 *
 * @throws AddressError, ChainError or LeafError for any value the vault would not hash as given.
 */
export function buildRoot(entries: readonly VaultEntry[], vault: string, chainId: number | string): BuiltRoot {
  const tree = buildTree(entries.map((entry) => leafValues(chainId, vault, entry.account, entry.cumulativeAmount)));
  return { root: tree.root as MerkleHash, tree };
}

/**
 * The server half of C32: a list is postable only if every entry is well formed and the vault can still pay it.
 *
 * Each wallet is owed min(amount, cap) minus what it has already claimed, never less than zero, because the vault pays
 * no more than the cap and only the difference (C27). The sum of what is owed must fit in what is left, deposited minus
 * totalPaid. Checking against the whole deposit would miss money already paid to wallets a later list drops.
 *
 * @returns declaredTotal, the capped cumulative sum that postRoot declares to the vault, and owed, the new money due.
 * @throws RootError for an empty or oversized list, a malformed or repeated entry, a snapshot missing a listed wallet,
 *   or a list that owes more than the vault has left.
 */
export function checkRoot(entries: readonly VaultEntry[], snapshot: VaultSnapshot): { declaredTotal: bigint; owed: bigint } {
  const { perWalletCap, deposited, totalPaid } = snapshot;
  if (perWalletCap <= 0n) throw new RootError('the cap must be above zero');
  if (totalPaid > deposited) throw new RootError('the vault reports paying more than was deposited');
  if (entries.length === 0) throw new RootError('the list is empty');
  if (entries.length > MAX_ROOT_ENTRIES) throw new RootError(`the list is longer than ${MAX_ROOT_ENTRIES} wallets`);
  const seen = new Set<Address>();
  let declaredTotal = 0n;
  let owed = 0n;
  entries.forEach((entry, i) => {
    let account: Address;
    try {
      account = parseAddress(entry.account);
    } catch {
      throw new RootError(`entry ${i} has a malformed address`);
    }
    const amount = entry.cumulativeAmount;
    if (typeof amount !== 'bigint' || amount < 0n || amount > MAX_UINT256) {
      throw new RootError(`entry ${i} has a malformed amount`);
    }
    if (seen.has(account)) throw new RootError(`entry ${i} repeats ${account}`);
    seen.add(account);
    const claimed = snapshot.claimed.get(account);
    if (claimed === undefined) throw new RootError(`the snapshot has no claimed amount for ${account}`);
    const capped = amount < perWalletCap ? amount : perWalletCap;
    declaredTotal += capped;
    if (capped > claimed) owed += capped - claimed;
  });
  const left = deposited - totalPaid;
  if (owed > left) throw new RootError(`the list owes ${owed} base units but the vault has ${left} left`);
  return { declaredTotal, owed };
}

/**
 * Refuses to sign for a vault of unknown origin (C32, C39): `factory` must have logged a VaultCreated for `vault` in
 * the campaign's recorded block, with every term equal to the record, and the record's agent must be this worker.
 *
 * @throws RootError naming what did not match.
 */
export async function verifyVault(port: VaultPort, vault: string, factory: string, expected: CampaignRecord): Promise<void> {
  if (parseAddress(expected.agent) !== port.signer) throw new RootError('the campaign record names an agent that is not this worker');
  const created = await port.findVaultCreated(parseAddress(factory), parseAddress(vault), expected.createdAtBlock);
  if (created.length !== 1) throw new RootError('the factory did not create this vault in the recorded block; nothing was posted');
  const [terms] = created as [VaultTerms];
  for (const field of TERM_FIELDS) {
    if (terms[field] !== expected[field]) throw new RootError(`the vault's ${field} is not the campaign record's; nothing was posted`);
  }
}

const PublishedList = z
  .array(z.strictObject({ account: z.string(), cumulativeAmount: z.string().regex(/^(0|[1-9][0-9]{0,77})$/) }))
  .max(MAX_ROOT_ENTRIES);

/** The list as Thuli publishes it, so anyone can rebuild the root: canonical addresses, amounts as decimal text. */
export function publishList(entries: readonly VaultEntry[]): string {
  return JSON.stringify(
    entries.map((entry) => ({ account: parseAddress(entry.account), cumulativeAmount: entry.cumulativeAmount.toString() })),
  );
}

/** @throws RootError when the text is not a published list. */
export function readPublishedList(text: string): VaultEntry[] {
  if (text.length > MAX_PUBLISHED_BYTES) throw new RootError('the published list is too large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RootError('the published list is not JSON');
  }
  const parsed = PublishedList.safeParse(raw);
  if (!parsed.success) throw new RootError('the published list is malformed');
  return parsed.data.map((entry) => ({ account: entry.account, cumulativeAmount: BigInt(entry.cumulativeAmount) }));
}

/** The chain as postRoot sees it. The worker's viem port is in chain.ts; tests pass a fake. */
export interface VaultPort {
  /** The address of the key that signs, which must be the vault's agent. */
  readonly signer: Address;
  chainId(): Promise<number>;
  /** The vault's state and claimed(account) for each of `accounts`, every value read at the same block. */
  readSnapshot(vault: Address, accounts: readonly Address[]): Promise<VaultSnapshot>;
  /** Every VaultCreated that `factory` logged for `vault` in `block`. */
  findVaultCreated(factory: Address, vault: Address, block: bigint): Promise<VaultTerms[]>;
  /** Simulates, sends and waits for postRoot; throws unless the transaction succeeded. */
  sendPostRoot(vault: Address, root: MerkleHash, declaredTotal: bigint): Promise<{ hash: Hash; gasUsed: bigint }>;
}

export interface PostedRoot {
  root: MerkleHash;
  declaredTotal: bigint;
  hash: Hash;
  gasUsed: bigint;
  /** The exact list text the root was rebuilt from, to publish next to it. */
  published: string;
}

/**
 * Posts a list's root to the campaign's vault from the agent key (C30, C32, C39: the key lives only in the worker).
 *
 * Nothing is sent unless: the chain is one we run on; verifyVault proves the factory made this vault with the record's
 * terms; the signer is the vault's agent; the vault is not paused and the root's delay would end before the campaign
 * does; checkRoot passes on the list as published against one block's snapshot; and the root built from the caller's
 * entries equals the root rebuilt from the published text, which catches a list that changed between checking and
 * signing. `expectedRoot`, when given, must match too.
 *
 * @throws ChainError, RootError, or the port's error when the transaction fails.
 */
export async function postRoot(
  port: VaultPort,
  campaign: CampaignRecord,
  entries: readonly VaultEntry[],
  options: { expectedRoot?: string } = {},
): Promise<PostedRoot> {
  const chainId = await port.chainId();
  parseChain(chainId);
  const vault = parseAddress(campaign.vault);
  await verifyVault(port, vault, campaign.factory, campaign);

  const published = publishList(entries);
  const list = readPublishedList(published);
  const snapshot = await port.readSnapshot(vault, list.map((entry) => parseAddress(entry.account)));
  if (snapshot.agent !== port.signer) throw new RootError('this key is not the vault agent; nothing was posted');
  if (snapshot.paused) throw new RootError('the vault is paused, so it refuses new roots; nothing was posted');
  if (snapshot.timestamp + snapshot.rootDelay >= snapshot.endTime) {
    throw new RootError('a root posted now could not pay before the end; nothing was posted');
  }
  const { declaredTotal } = checkRoot(list, snapshot);
  const first = buildRoot(entries, vault, chainId);
  const second = buildRoot(list, vault, chainId);
  if (first.root !== second.root) throw new RootError('the root rebuilt from the published list differs; nothing was posted');
  if (options.expectedRoot !== undefined && options.expectedRoot.toLowerCase() !== first.root) {
    throw new RootError('the rebuilt root is not the expected root; nothing was posted');
  }

  const sent = await port.sendPostRoot(vault, first.root, declaredTotal);
  const after = await port.readSnapshot(vault, []);
  if (after.pendingRoot !== first.root) throw new RootError('the vault does not show the posted root as pending');
  return { root: first.root, declaredTotal, hash: sent.hash, gasUsed: sent.gasUsed, published };
}

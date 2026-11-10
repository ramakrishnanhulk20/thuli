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

const MAX_UINT256 = 2n ** 256n - 1n;
// Every leaf sits in memory while the tree is built; a list this long is not one campaign's claim list (C41).
export const MAX_ROOT_ENTRIES = 100_000;
const MAX_PUBLISHED_BYTES = MAX_ROOT_ENTRIES * 120;

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
 * The server half of C32: a list is postable only if every entry is well formed and the vault can pay all of it.
 *
 * Each wallet counts at most `perWalletCap`, because that is the most the vault will ever pay it whatever the leaf says.
 * Wallets dropped from a later list keep what they were already paid, which this sum cannot see; the vault's own
 * deposit check in claim is what holds that line on-chain (C29).
 *
 * @returns declaredTotal, the capped sum, which is what postRoot declares to the vault.
 * @throws RootError for an empty or oversized list, a malformed or repeated entry, or a capped sum above the deposit.
 */
export function checkRoot(
  entries: readonly VaultEntry[],
  deposit: bigint,
  perWalletCap: bigint,
): { declaredTotal: bigint } {
  if (typeof deposit !== 'bigint' || deposit < 0n) throw new RootError('the deposit must be base units as a bigint');
  if (typeof perWalletCap !== 'bigint' || perWalletCap <= 0n) throw new RootError('the cap must be above zero');
  if (entries.length === 0) throw new RootError('the list is empty');
  if (entries.length > MAX_ROOT_ENTRIES) throw new RootError(`the list is longer than ${MAX_ROOT_ENTRIES} wallets`);
  const seen = new Set<Address>();
  let declaredTotal = 0n;
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
    declaredTotal += amount < perWalletCap ? amount : perWalletCap;
  });
  if (declaredTotal > deposit) {
    throw new RootError(`the list can pay ${declaredTotal} base units but the vault holds ${deposit}`);
  }
  return { declaredTotal };
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

/** What postRoot reads from the vault before and after posting. */
export interface VaultView {
  agent: Address;
  deposited: bigint;
  perWalletCap: bigint;
  pendingRoot: MerkleHash;
}

/** The chain as postRoot sees it. The worker's viem port is in chain.ts; tests pass a fake. */
export interface VaultPort {
  /** The address of the key that signs, which must be the vault's agent. */
  readonly signer: Address;
  chainId(): Promise<number>;
  readState(vault: Address): Promise<VaultView>;
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
 * Posts a list's root to the vault from the agent key (C30, C32, C39: the key lives only in the worker).
 *
 * Nothing is sent unless the chain is one we run on, the signer is the vault's agent, checkRoot passes on the list as
 * published, and the root built from the caller's entries equals the root rebuilt from the published text. The second
 * build catches a list that changed between checking and signing. `expectedRoot`, when given, must match too.
 *
 * @throws ChainError, RootError, or the port's error when the transaction fails.
 */
export async function postRoot(
  port: VaultPort,
  vault: string,
  entries: readonly VaultEntry[],
  options: { expectedRoot?: string } = {},
): Promise<PostedRoot> {
  const chainId = await port.chainId();
  parseChain(chainId);
  const vaultAddress = parseAddress(vault);
  const before = await port.readState(vaultAddress);
  if (before.agent !== port.signer) throw new RootError('this key is not the vault agent; nothing was posted');

  const published = publishList(entries);
  const list = readPublishedList(published);
  const { declaredTotal } = checkRoot(list, before.deposited, before.perWalletCap);
  const first = buildRoot(entries, vaultAddress, chainId);
  const second = buildRoot(list, vaultAddress, chainId);
  if (first.root !== second.root) throw new RootError('the root rebuilt from the published list differs; nothing was posted');
  if (options.expectedRoot !== undefined && options.expectedRoot.toLowerCase() !== first.root) {
    throw new RootError('the rebuilt root is not the expected root; nothing was posted');
  }

  const sent = await port.sendPostRoot(vaultAddress, first.root, declaredTotal);
  const after = await port.readState(vaultAddress);
  if (after.pendingRoot !== first.root) throw new RootError('the vault does not show the posted root as pending');
  return { root: first.root, declaredTotal, hash: sent.hash, gasUsed: sent.gasUsed, published };
}

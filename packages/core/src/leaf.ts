import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { parseAddress, type Address } from './address.ts';
import { CHAINS, parseChain } from './chains.ts';

/**
 * The vault's leaf, field by field (threat model C28): ThuliVault hashes
 * abi.encode(block.chainid, address(this), account, cumulativeAmount) with the same double keccak as StandardMerkleTree.
 */
export const LEAF_TYPES = ['uint256', 'address', 'address', 'uint256'];

/**
 * One leaf as StandardMerkleTree takes it: chain id and amount as canonical decimal text, both addresses in the C1 form.
 * Text rather than bigint so a published tree survives JSON and reloads to the same root.
 */
export type LeafValues = [chainId: string, vault: Address, account: Address, cumulativeAmount: string];

export type LeafTree = StandardMerkleTree<LeafValues>;

export type MerkleHash = `0x${string}`;

export class LeafError extends Error {
  override name = 'LeafError';
}

const MAX_UINT256 = 2n ** 256n - 1n;

/**
 * Builds one leaf. Every value goes through the one parser for its kind: addresses through parseAddress (C1), the chain
 * through parseChain (C2), and the amount must already be integer base units (C3).
 *
 * @throws AddressError for a bad address, ChainError for a chain we do not run on, LeafError for a bad amount.
 */
export function leafValues(
  chainId: number | string,
  vault: string,
  account: string,
  cumulativeAmount: bigint,
): LeafValues {
  if (typeof cumulativeAmount !== 'bigint') throw new LeafError('amount must be a bigint in base units');
  if (cumulativeAmount < 0n || cumulativeAmount > MAX_UINT256) throw new LeafError('amount outside uint256');
  const chain = CHAINS[parseChain(chainId)].id;
  return [String(chain), parseAddress(vault), parseAddress(account), cumulativeAmount.toString()];
}

/**
 * Builds the vault's Merkle tree from leaves made by leafValues.
 *
 * Each entry is rebuilt through leafValues and must come back identical, so a hand-made entry such as "0x10" or " 16"
 * for an amount, a lowercase address, or a chain id we do not run on is refused rather than hashed (C28: the same
 * leaf off-chain and on-chain). All entries must name one chain and one vault, and each account may appear once,
 * because a second leaf for a wallet would be a second valid entitlement.
 *
 * @throws LeafError for an empty list, a non-canonical entry, mixed chains or vaults, or a repeated account.
 */
export function buildTree(entries: readonly LeafValues[]): LeafTree {
  if (entries.length === 0) throw new LeafError('a tree needs at least one leaf');
  const first = entries[0] as LeafValues;
  const seen = new Set<Address>();
  for (const entry of entries) {
    if (!sameLeaf(entry, canonical(entry))) throw new LeafError('entry was not built by leafValues');
    if (entry[0] !== first[0] || entry[1] !== first[1]) throw new LeafError('entries name more than one chain or vault');
    if (seen.has(entry[2])) throw new LeafError(`account ${entry[2]} appears twice`);
    seen.add(entry[2]);
  }
  return StandardMerkleTree.of(entries.map((entry) => [...entry] as LeafValues), LEAF_TYPES);
}

/**
 * The proof the vault's claim takes for `account`, which may be written in any form parseAddress accepts.
 *
 * @throws AddressError for a bad address, LeafError when the account has no leaf in the tree.
 */
export function proofFor(tree: LeafTree, account: string): MerkleHash[] {
  const wanted = parseAddress(account);
  for (const [index, value] of tree.entries()) {
    if (value[2] === wanted) return tree.getProof(index) as MerkleHash[];
  }
  throw new LeafError(`account ${wanted} is not in the tree`);
}

function canonical(entry: LeafValues): LeafValues | undefined {
  try {
    const [chainId, vault, account, amount] = entry;
    if (!/^(0|[1-9][0-9]*)$/.test(amount)) return undefined;
    return leafValues(chainId, vault, account, BigInt(amount));
  } catch {
    return undefined;
  }
}

function sameLeaf(a: LeafValues, b: LeafValues | undefined): boolean {
  return b !== undefined && a.length === 4 && a.every((value, i) => value === b[i]);
}

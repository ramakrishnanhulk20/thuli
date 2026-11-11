import { OUTCOMES, parseAddress, proofFor, shareFor, shareOf, WHOLE_SHARE_BPS, type Address, type MerkleHash, type Outcome } from '@thuli/core';
import { buildRoot, MAX_ROOT_ENTRIES, readPublishedList, type VaultEntry } from './root.ts';

export class ClaimListError extends Error {
  override name = 'ClaimListError';
}

/** One wallet's final screening decision, as the claim list takes it. */
export interface ScreenedWallet {
  account: string;
  action: Outcome;
  shareBps: number;
}

/** What a campaign pays: a full wallet's reward in base units, the vault's per-wallet cap, and a partial wallet's share. */
export interface ClaimTerms {
  rewardPerWallet: bigint;
  perWalletCap: bigint;
  partialShareBps: number;
}

export interface ClaimList {
  entries: VaultEntry[];
  /** The exact sum of the entry amounts. */
  declaredTotal: bigint;
}

/** What one wallet needs to claim: its leaf amount, the proof the vault checks, and the root it proves against. */
export interface ClaimTicket {
  account: Address;
  cumulativeAmount: bigint;
  proof: MerkleHash[];
  root: MerkleHash;
}

/**
 * Turns screened wallets into the entries a vault root is built from. A full wallet gets rewardPerWallet and a partial
 * one shareOf(rewardPerWallet, partialShareBps), rounded down (C3); hold and exclude wallets get no entry. Entries keep
 * the input order and carry the address in the one canonical form (C1).
 *
 * Every doubt is a refusal, never a clamp or a silent skip: terms the vault could not pay as written, a malformed
 * address, one wallet in two rows in any spelling (C1), a share that disagrees with its action (C13), or more than
 * MAX_ROOT_ENTRIES entries (C41).
 *
 * Not covered: how many reward slots a campaign has, which is decided before this runs, and whether the vault holds
 * enough to pay the list, which checkRoot in root.ts judges when postRoot posts it.
 *
 * @throws ClaimListError naming the terms or the row that was refused.
 */
export function buildClaimList(screened: readonly ScreenedWallet[], terms: ClaimTerms): ClaimList {
  checkTerms(terms);
  if (!Array.isArray(screened)) throw new ClaimListError('the screened wallets must be a list');
  const seen = new Set<Address>();
  const entries: VaultEntry[] = [];
  let declaredTotal = 0n;
  for (const [i, row] of screened.entries()) {
    if (typeof row !== 'object' || row === null) throw new ClaimListError(`row ${i} is not a screened wallet`);
    let account: Address;
    try {
      account = parseAddress(row.account);
    } catch (cause) {
      throw new ClaimListError(`row ${i} has a malformed address`, { cause });
    }
    if (seen.has(account)) throw new ClaimListError(`row ${i} repeats ${account}`);
    seen.add(account);
    if (!(OUTCOMES as readonly unknown[]).includes(row.action)) throw new ClaimListError(`row ${i} has an action that is not one of the four`);
    // The same rule validateDecision checks a model's share with, so a list can never pay a share the checks refused (C13).
    const expected = shareFor(row.action, terms);
    if (row.shareBps !== expected) {
      throw new ClaimListError(`row ${i} is a ${row.action} decision, which must carry share ${expected}`);
    }
    if (row.action === 'hold' || row.action === 'exclude') continue;
    if (entries.length === MAX_ROOT_ENTRIES) {
      throw new ClaimListError(`row ${i} would make the list longer than ${MAX_ROOT_ENTRIES} wallets`);
    }
    const amount = shareOf(terms.rewardPerWallet, expected);
    entries.push({ account, cumulativeAmount: amount });
    declaredTotal += amount;
  }
  return { entries, declaredTotal };
}

/**
 * One wallet's claim from a published list. The tree is rebuilt from the published text through buildRoot, so the
 * ticket proves against the same root anyone rebuilding that text gets (C28, C32).
 *
 * @param account Any spelling parseAddress accepts.
 * @returns null when the wallet is not on the list.
 * @throws RootError for text that is not a published list, AddressError for a bad vault, account or listed address,
 *   ChainError for a chain Thuli does not run on, and LeafError for an empty list or a wallet listed twice.
 */
export function claimTicket(
  publishedList: string,
  vault: string,
  chainId: number | string,
  account: string,
): ClaimTicket | null {
  const entries = readPublishedList(publishedList);
  const { root, tree } = buildRoot(entries, vault, chainId);
  const wanted = parseAddress(account);
  const entry = entries.find((listed) => parseAddress(listed.account) === wanted);
  if (entry === undefined) return null;
  return { account: wanted, cumulativeAmount: entry.cumulativeAmount, proof: proofFor(tree, wanted), root };
}

function checkTerms({ rewardPerWallet, perWalletCap, partialShareBps }: ClaimTerms): void {
  if (typeof rewardPerWallet !== 'bigint' || rewardPerWallet <= 0n) {
    throw new ClaimListError('terms: the reward per wallet must be a bigint above zero');
  }
  if (typeof perWalletCap !== 'bigint' || rewardPerWallet > perWalletCap) {
    throw new ClaimListError('terms: the reward per wallet must not be above the per-wallet cap');
  }
  if (!Number.isInteger(partialShareBps) || partialShareBps <= 0 || partialShareBps >= WHOLE_SHARE_BPS) {
    throw new ClaimListError(`terms: the partial share must be whole basis points strictly between 0 and ${WHOLE_SHARE_BPS}`);
  }
  // A partial wallet would get an entry of zero, which reads as paid while paying nothing.
  if (shareOf(rewardPerWallet, partialShareBps) === 0n) {
    throw new ClaimListError('terms: the partial share gives a partial reward that rounds to nothing');
  }
}

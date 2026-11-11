import type { Hash } from 'viem';
import { parseAddress, type MerkleHash } from '@thuli/core';
import {
  addListVersion,
  latestList,
  listText,
  listVersions,
  markListCancelled,
  markListPosted,
  markListSending,
  markListUnsent,
  slotHolders,
  type Campaign,
  type ListVersion,
} from '@thuli/store';
import { buildClaimList } from '../vault/claimList.ts';
import { buildRoot, postRoot, publishList, readPublishedList, RootError, type CampaignRecord, type VaultPort } from '../vault/root.ts';
import {
  campaignHere,
  campaignMemory,
  checkpoint,
  NO_ROOT,
  NO_VAULT_BLOCK,
  vaultRecordFor,
  type ChainDeps,
  type PostReceipt,
} from './vault.ts';

export type PublishOutcome =
  | { kind: 'skipped'; reason: string }
  | {
      kind: 'posted';
      version: number;
      root: MerkleHash;
      wallets: number;
      declaredTotal: bigint;
      tx: Hash;
      gasUsed: bigint;
      claimableAt: number;
    };

export type ReconcileOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'reconciled'; posted: number[]; cancelled: number[]; unsent: number[] };

const skipped = (reason: string): PublishOutcome => ({ kind: 'skipped', reason });

/** The reason publishCheck gives for leaving alone a list whose root the owner cancelled on the vault. */
export const CANCELLED_LIST = 'the owner cancelled this list; nothing is posted until the slot holders change';

/** The reason publishCheck gives while the newest posted list is missing from the read, until it shows or its cancel is recorded. */
export const UNSEEN_LIST =
  'the newest posted list is neither pending nor paid in this read of the vault; nothing is posted until it shows or its cancel is recorded';

/**
 * How long after a post a read of the vault must be before it may prove the owner cancelled that post. A public RPC is
 * load balanced, and a node a few blocks behind still shows the vault as it was before our own postRoot. Two minutes is
 * far longer than any such lag and far shorter than the hour a root waits, so a real cancel is still recorded long
 * before the delay would have ended.
 */
export const CANCEL_MARGIN_SECONDS = 120;

/** The reason publishCheck gives while a list's post is recorded as sent and not yet settled from the chain. */
export const SENDING_LIST = 'a list is being sent to the vault; nothing more is posted until reconcile settles it from the chain';

/**
 * How long a sending version's transaction may be unknown to every node before its root is taken never to have reached
 * the vault and the version is built again. Counted from when this process first found it missing, because a node
 * that has not yet heard of a broadcast looks the same as one that never will.
 */
export const UNSENT_AFTER_SECONDS = 600;

// How long publish waits for its own post to be mined before leaving the settling to reconcile.
const RECEIPT_WAIT_MS = 180_000;

// Statuses a version only reaches once its root was on the vault, so a version older than one of these may have been
// replaced there rather than cancelled.
const REACHED_CHAIN: readonly string[] = ['posted', 'active', 'superseded'];

/** The newest posted version, when no newer version ever reached the vault; the only one a read can find missing. */
function newestPosted(versions: readonly ListVersion[]): ListVersion | undefined {
  const last = versions.filter((version) => version.status === 'posted').at(-1);
  if (last === undefined) return undefined;
  return versions.some((version) => version.version > last.version && REACHED_CHAIN.includes(version.status)) ? undefined : last;
}

/**
 * True only when a read at `readAt` is at least CANCEL_MARGIN_SECONDS after the version was posted, its post moment
 * being its claimableAt less the vault's root delay, so a missing root in that read cannot be a node that has not yet
 * seen our post. Without a claimable time or a delay it is false, which leaves the version posted (fail closed). Pure.
 */
export function cancelProven(version: Pick<ListVersion, 'claimableAt'>, rootDelay: bigint | null, readAt: bigint): boolean {
  if (version.claimableAt === null || rootDelay === null) return false;
  const postedAt = BigInt(version.claimableAt) - rootDelay;
  return readAt >= postedAt + BigInt(CANCEL_MARGIN_SECONDS);
}

/** The vault's root delay from its record, or null when the record cannot be had, which proves no cancel. */
async function rootDelayOf(deps: ChainDeps, campaign: Campaign): Promise<bigint | null> {
  if (campaign.vaultBlock === null) return null;
  try {
    return (await recordFor(deps, campaign)).rootDelay;
  } catch {
    return null;
  }
}

/**
 * Whether a sending version's transaction is taken never to land, given what this read found of it. Every rule about
 * when our own post is dead lives here and only here. For now: no node knew it on every read for UNSENT_AFTER_SECONDS
 * without a break, counted from when this process first found it missing. Any sighting, pending or mined, clears that
 * count, because a transaction a node has just shown can still be mined; calling it dead then would sign the root again
 * with a fresh nonce while the first one can still land (C27, C32).
 */
async function postNeverLands(deps: ChainDeps, campaign: Campaign, sending: ListVersion, seen: PostReceipt['state']): Promise<boolean> {
  const missing = campaignMemory(deps.memory, campaign.id).missingSince;
  if (seen !== 'unknown') {
    missing.delete(sending.version);
    return false;
  }
  const now = deps.now().getTime();
  const since = missing.get(sending.version) ?? now;
  missing.set(sending.version, since);
  if (now - since < UNSENT_AFTER_SECONDS * 1000) return false;
  missing.delete(sending.version);
  return true;
}

/**
 * Settles a version recorded as sending from what the network knows of its transaction: mined and successful, posted
 * with the claimable time the transaction's own RootPosted log holds, so the existing cancel rule applies to it after
 * its margin and its root is never sent again; mined and reverted, built again; unknown and proven never to land
 * (postNeverLands), built again; otherwise left as it is. Returns false while it stays sending.
 */
async function settleSending(
  deps: ChainDeps,
  campaign: Campaign,
  sending: ListVersion,
  outcome: { posted: number[]; unsent: number[] },
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const id = campaign.id;
  if (sending.postTx === null) throw new RootError(`list version ${sending.version} is sending with no transaction on record`);
  const hash = sending.postTx as `0x${string}`;
  const receipt = await deps.chain.postReceipt(parseAddress(campaign.vault), sending.root as `0x${string}`, hash, 0);
  const lost = await postNeverLands(deps, campaign, sending, receipt.state);
  if (receipt.state === 'pending') return false;
  if (receipt.state === 'unknown') {
    if (!lost) return false;
    checkpoint(signal, 'recording a post as unsent');
    if (await markListUnsent(deps.db, id, sending.version)) {
      outcome.unsent.push(sending.version);
      deps.log(`reconcile ${id}: no node knows the post ${hash} of list version ${sending.version} after ${UNSENT_AFTER_SECONDS} s, so it is built again`);
    }
    return true;
  }
  checkpoint(signal, 'recording what became of a post');
  if (!receipt.ok) {
    if (await markListUnsent(deps.db, id, sending.version)) {
      outcome.unsent.push(sending.version);
      deps.log(`reconcile ${id}: the post ${hash} of list version ${sending.version} reverted, so it is built again`);
    }
    return true;
  }
  const claimableAt = Number(receipt.claimableAt);
  if (!(await markListPosted(deps.db, id, sending.version, { postTx: null, claimableAt }))) {
    throw new RootError(`list version ${sending.version} could not be recorded as posted from its receipt`);
  }
  outcome.posted.push(sending.version);
  deps.log(`reconcile ${id}: the post ${hash} of list version ${sending.version} is mined, so it is recorded as posted, claimable from unix ${claimableAt}`);
  return true;
}

/**
 * Brings a campaign's list versions into line with what its vault shows at one block, so a worker stopped between any
 * two lines picks up exactly where the vault stands (C27, C32). It sends nothing, and every write checks the status it
 * expects first, so it can only move a version to a status the vault already shows. A version recorded as sending is
 * settled from its own transaction before anything else (settleSending), and while it cannot be, nothing else happens.
 * Then:
 * 1. the newest version is built and its root is the vault's pending root: the post reached the chain and the worker
 *    stopped before recording it, so it is marked posted, with no transaction hash and the vault's own claimable time;
 * 2. a built version's root is the root the vault pays now: the same, found after the delay, so it is marked posted with
 *    the block's time, which the vault has passed, and activateCheck makes it active on this same run;
 * 3. the newest posted version's root is neither pending nor paid, no newer version ever reached the vault, and the read
 *    is at least CANCEL_MARGIN_SECONDS after that version was posted (cancelProven): the owner cancelled it with
 *    cancelRoot or setAgent, so it is marked cancelled. A read inside the margin may come from a node that has not seen
 *    our post yet, so the version stays posted and nothing is said; a real cancel is recorded on a later run. An older
 *    posted version with a newer one on chain after it may have been replaced instead, which the vault's state cannot
 *    tell apart, so it is left as it is.
 * Cases 1 and 2 cannot be misled by a lagging node: an older view of the vault shows our root pending or paid only if it
 * was posted. The vault keeps no claimable time for a root it already pays, so case 2 records the block's time instead.
 *
 * @returns reconciled with the versions marked posted and cancelled, or skipped with the reason.
 * @throws StoreError or a chain error when a read fails; nothing is written after a failed read.
 */
export async function reconcileCheck(deps: ChainDeps, campaignId: string, signal?: AbortSignal): Promise<ReconcileOutcome> {
  const here = await campaignHere(deps, campaignId);
  if (!here.ok) return { kind: 'skipped', reason: here.reason };
  const posted: number[] = [];
  const cancelled: number[] = [];
  const unsent: number[] = [];
  const sending = (await listVersions(deps.db, campaignId)).filter((version) => version.status === 'sending').at(-1);
  if (sending !== undefined && !(await settleSending(deps, here.campaign, sending, { posted, unsent }, signal))) {
    return { kind: 'reconciled', posted, cancelled, unsent };
  }
  const roots = await deps.chain.roots(parseAddress(here.campaign.vault));

  const versions = await listVersions(deps.db, campaignId);
  const newest = versions.at(-1);
  if (newest?.status === 'built' && roots.pendingRoot !== NO_ROOT && newest.root === roots.pendingRoot) {
    const claimableAt = Number(roots.pendingClaimableAt);
    checkpoint(signal, 'recording a pending list as posted');
    if (await markListPosted(deps.db, campaignId, newest.version, { postTx: null, claimableAt })) {
      posted.push(newest.version);
      deps.log(`reconcile ${campaignId}: list version ${newest.version} is pending on the vault but was never recorded, so it is recorded as posted, claimable from unix ${claimableAt}`);
    }
  }
  const paying =
    roots.activeRoot === NO_ROOT
      ? undefined
      : versions.filter((version) => version.status === 'built' && version.root === roots.activeRoot).at(-1);
  if (paying !== undefined) {
    checkpoint(signal, 'recording a paid list as posted');
    if (await markListPosted(deps.db, campaignId, paying.version, { postTx: null, claimableAt: Number(roots.timestamp) })) {
      posted.push(paying.version);
      deps.log(`reconcile ${campaignId}: list version ${paying.version} is the root the vault pays but was never recorded, so it is recorded as posted`);
    }
  }

  const lastPosted = newestPosted(await listVersions(deps.db, campaignId));
  const missing = lastPosted !== undefined && lastPosted.root !== roots.pendingRoot && lastPosted.root !== roots.activeRoot;
  if (missing && cancelProven(lastPosted, await rootDelayOf(deps, here.campaign), roots.timestamp)) {
    checkpoint(signal, 'recording a cancel');
    if (await markListCancelled(deps.db, campaignId, lastPosted.version)) {
      cancelled.push(lastPosted.version);
      deps.log(`reconcile ${campaignId}: the owner cancelled list version ${lastPosted.version} on the vault, so it is recorded as cancelled`);
    }
  }
  return { kind: 'reconciled', posted, cancelled, unsent };
}

async function recordFor(deps: ChainDeps, campaign: Campaign): Promise<CampaignRecord> {
  const mine = campaignMemory(deps.memory, campaign.id);
  if (mine.record !== null && mine.record.createdAtBlock === campaign.vaultBlock) return mine.record;
  mine.record = await vaultRecordFor(deps.chain, campaign, deps.factory);
  return mine.record;
}

/**
 * The version to post for this list: the newest one when it is still built with this root, so a post that failed is
 * resumed rather than recorded twice; otherwise a new one. A newest version still built with another root is cancelled
 * first, because it lists fewer slot holders than there are now and was never posted.
 */
async function versionFor(
  deps: ChainDeps,
  campaignId: string,
  newest: ListVersion | undefined,
  list: { root: MerkleHash; text: string; declaredTotal: bigint },
  signal: AbortSignal | undefined,
): Promise<number> {
  if (newest?.status === 'built') {
    if (newest.root === list.root) return newest.version;
    checkpoint(signal, 'cancelling an out-of-date list');
    await markListCancelled(deps.db, campaignId, newest.version);
    deps.log(`publish ${campaignId}: list version ${newest.version} was never posted and is out of date, so it is cancelled`);
  }
  checkpoint(signal, 'recording a new list');
  return addListVersion(
    deps.db,
    { campaignId, root: list.root, publishedList: list.text, declaredTotal: list.declaredTotal.toString() },
    deps.now(),
  );
}

interface RecordedPost {
  claimableAt: number;
  gasUsed: bigint;
}

/**
 * The vault port postRoot is handed, whose one send records itself in the store before the network can know it (C27,
 * C32). Right before signing it reads the vault and the store again and refuses when the vault has a pending root or
 * this version is no longer the newest built one, so a step that stalled cannot post over a newer list. Then it signs,
 * records the hash with markListSending, sends the signed bytes, waits for the receipt and records the version posted
 * with the receipt's own claimable time, or built again when the post reverted. The step's signal is checked before
 * every signature, store write and send; a step stopped after the send leaves the version sending, for reconcile.
 */
function recordedPort(
  deps: ChainDeps,
  campaign: Campaign,
  version: number,
  signal: AbortSignal | undefined,
  result: { posted?: RecordedPost },
): VaultPort {
  const id = campaign.id;
  const chain = deps.chain;
  // Delegated one by one, not spread, so a port that keeps its methods on a prototype keeps them here too.
  return {
    signer: chain.signer,
    chainId: () => chain.chainId(),
    readSnapshot: (vault, accounts) => chain.readSnapshot(vault, accounts),
    findVaultCreated: (factory, vault, block) => chain.findVaultCreated(factory, vault, block),
    async sendPostRoot(vault, root, declaredTotal) {
      checkpoint(signal, 'signing a post');
      const roots = await deps.chain.roots(vault);
      if (roots.pendingRoot !== NO_ROOT) throw new RootError('a root is pending on the vault, so nothing was signed');
      const newest = await latestList(deps.db, id);
      if (newest?.version !== version || newest.status !== 'built' || newest.root !== root) {
        throw new RootError(`list version ${version} is no longer the newest built list, so nothing was signed`);
      }
      checkpoint(signal, 'signing a post');
      const signed = await deps.chain.signPostRoot(vault, root, declaredTotal);
      checkpoint(signal, 'recording a signed post');
      if (!(await markListSending(deps.db, id, version, { postTx: signed.hash.toLowerCase() }, deps.now()))) {
        throw new RootError(`list version ${version} could not be recorded as sending, so nothing was sent`);
      }
      checkpoint(signal, 'sending a post');
      await deps.chain.broadcast(signed);
      const receipt = await deps.chain.postReceipt(vault, root, signed.hash, RECEIPT_WAIT_MS);
      if (receipt.state !== 'mined') throw new RootError(`the post ${signed.hash} is not mined yet; reconcile settles it`);
      checkpoint(signal, 'recording a mined post');
      if (!receipt.ok) {
        await markListUnsent(deps.db, id, version);
        throw new RootError(`the post ${signed.hash} reverted, so list version ${version} is built again`);
      }
      const claimableAt = Number(receipt.claimableAt);
      if (!(await markListPosted(deps.db, id, version, { postTx: null, claimableAt }))) {
        throw new RootError(`list version ${version} could not be recorded as posted`);
      }
      result.posted = { claimableAt, gasUsed: receipt.gasUsed };
      return { hash: signed.hash, gasUsed: receipt.gasUsed };
    },
  };
}

/**
 * Posts the campaign's slot holders to its vault when they are not on chain yet. Each holder's entry comes from
 * buildClaimList with the campaign row's reward, cap and partial share, in slot order, so a vault posts at most
 * max_slots wallets and never one that holds no slot (C44). The list is recorded with addListVersion before anything is
 * sent, then read back from the store and posted from that stored text, so the root on chain is the one anyone rebuilds
 * from the published list (C32). Every amount is cumulative and a slot is never taken back, so a wallet on two versions
 * has one entitlement, and the vault pays only what it has not paid yet (C27).
 *
 * Nothing is sent while a version is recorded as sending (SENDING_LIST), while the vault has a pending root, when the
 * slot holders are exactly the newest posted or active version, when they are exactly the newest version and the owner
 * cancelled it (CANCELLED_LIST), or while the newest posted version is missing from the read, which may be a node
 * behind our own post (UNSEEN_LIST). postRoot then runs every check it has: the vault record matches the factory's
 * VaultCreated log and the campaign row (vaultRecordFor, verifyVault), the agent is this key, the vault is not paused
 * and the root can activate before the end, the active root rebuilds from its own published list, and the vault can
 * pay everything both lists may still owe. The one send goes through recordedPort, which records it before sending.
 *
 * @returns posted with the transaction, or skipped with the reason nothing was sent.
 * @throws RootError, ClaimListError, StoreError or a chain error when a check refuses or a call fails. Nothing is posted
 *   after a refusal, and a version recorded before a failed post is resumed on the next call.
 */
export async function publishCheck(deps: ChainDeps, campaignId: string, signal?: AbortSignal): Promise<PublishOutcome> {
  const here = await campaignHere(deps, campaignId);
  if (!here.ok) return skipped(here.reason);
  const { campaign } = here;
  if (campaign.vaultBlock === null) return skipped(NO_VAULT_BLOCK);
  const vault = parseAddress(campaign.vault);

  const holders = await slotHolders(deps.db, campaignId);
  if (holders.length === 0) return skipped('no wallet holds a slot yet');
  if ((await listVersions(deps.db, campaignId)).some((version) => version.status === 'sending')) return skipped(SENDING_LIST);
  const roots = await deps.chain.roots(vault);
  if (roots.pendingRoot !== NO_ROOT) return skipped('a root is pending on the vault');

  const list = buildClaimList(
    holders.map((holder) => ({ account: holder.wallet, action: holder.action, shareBps: holder.shareBps })),
    {
      rewardPerWallet: BigInt(campaign.rewardPerWallet),
      perWalletCap: BigInt(campaign.perWalletCap),
      partialShareBps: campaign.partialShareBps,
    },
  );
  const text = publishList(list.entries);
  const { root } = buildRoot(list.entries, vault, campaign.chain);
  if (roots.activeRoot === root) return skipped('the vault already pays exactly this list');
  const versions = await listVersions(deps.db, campaignId);
  const onChain = versions.filter((version) => version.status === 'posted' || version.status === 'active').at(-1);
  if (onChain?.root === root) return skipped(`the slot holders are already list version ${onChain.version}`);
  // The owner's cancel is a decision about exactly this list. addListVersion would refuse its root anyway; the list is
  // posted again only as a new root, once a new wallet takes a slot.
  const newest = versions.at(-1);
  if (newest?.status === 'cancelled' && newest.root === root) return skipped(CANCELLED_LIST);
  // A read that shows no pending root may come from a node that has not seen our own last post. Posting then would
  // replace that list on the vault and restart its delay, so nothing is posted until the read shows it or reconcile
  // has recorded its cancel.
  const lastPosted = newestPosted(versions);
  if (lastPosted !== undefined && lastPosted.root !== roots.pendingRoot && lastPosted.root !== roots.activeRoot) {
    return skipped(UNSEEN_LIST);
  }

  let activePublished: string | undefined;
  if (roots.activeRoot !== NO_ROOT) {
    const paying = versions.filter((version) => version.root === roots.activeRoot).at(-1);
    const paid = paying === undefined ? null : await listText(deps.db, campaignId, paying.version);
    if (paid === null) return skipped('no list on record rebuilds the root the vault pays now');
    activePublished = paid;
  }

  const version = await versionFor(deps, campaignId, versions.at(-1), { root, text, declaredTotal: list.declaredTotal }, signal);
  const stored = await listText(deps.db, campaignId, version);
  if (stored === null) throw new RootError(`list version ${version} has no published text; nothing was posted`);
  const entries = readPublishedList(stored);
  if (publishList(entries) !== stored || buildRoot(entries, vault, campaign.chain).root !== root) {
    throw new RootError(`list version ${version} does not rebuild to its own root; nothing was posted`);
  }

  const record = await recordFor(deps, campaign);
  const sent: { posted?: RecordedPost } = {};
  const posted = await postRoot(recordedPort(deps, campaign, version, signal, sent), record, entries, { activePublished, expectedRoot: root });
  if (sent.posted === undefined) throw new RootError(`list version ${version} was not recorded as posted`);
  const { claimableAt } = sent.posted;
  deps.log(
    `publish ${campaignId}: list version ${version} with ${entries.length} wallet${entries.length === 1 ? '' : 's'}, ${posted.declaredTotal} base units, root ${root}, ` +
      `posted in ${posted.hash} (gas ${posted.gasUsed}), claimable from unix ${claimableAt}`,
  );
  return {
    kind: 'posted',
    version,
    root,
    wallets: entries.length,
    declaredTotal: posted.declaredTotal,
    tx: posted.hash,
    gasUsed: posted.gasUsed,
    claimableAt,
  };
}

import type { Hash } from 'viem';
import { parseAddress, type MerkleHash } from '@thuli/core';
import {
  addListVersion,
  latestList,
  listText,
  listVersions,
  markListCancelled,
  markListPosted,
  markListResent,
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
  type SentPost,
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
 * For a version recorded before its transaction's nonce was kept: how long that transaction may be unknown to every
 * node before its root is taken never to have reached the vault and the version is built again. Counted from when this
 * process first found it missing, because a node that has not yet heard of a broadcast looks the same as one that
 * never will. A version with a nonce is built again only on proof that the nonce was used (settleSending).
 */
export const UNSENT_AFTER_SECONDS = 600;

/**
 * How long no node may show any of a sending version's transactions, counted the same way, before it is signed again
 * at its own nonce with fees taken fresh. Any sighting starts the count again.
 */
export const RESEND_AFTER_SECONDS = 600;

/**
 * The most times one process signs a sending version again at its nonce. Past this nothing more is sent: it is said
 * once, and the version waits for a receipt or for its nonce to be used.
 */
export const MAX_RESENDS = 5;

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
 * True once no node has shown a sending version's transactions on every read for `seconds` without a break, counted
 * from when this process first found them missing. Any sighting, pending or mined, clears the count, because a
 * transaction a node has just shown can still be mined. Answering true starts the count again.
 */
function unseenFor(deps: ChainDeps, campaignId: string, version: number, seen: boolean, seconds: number): boolean {
  const missing = campaignMemory(deps.memory, campaignId).missingSince;
  if (seen) {
    missing.delete(version);
    return false;
  }
  const now = deps.now().getTime();
  const since = missing.get(version) ?? now;
  missing.set(version, since);
  if (now - since < seconds * 1000) return false;
  missing.delete(version);
  return true;
}

/** Forgets what this process sent for a version that is no longer sending. */
function forgetPost(deps: ChainDeps, campaignId: string, version: number): void {
  const mine = campaignMemory(deps.memory, campaignId);
  mine.posts.delete(version);
  mine.missingSince.delete(version);
}

/** What this process signed for a sending version at its stored nonce, starting from the stored hash after a restart. */
function sentPost(deps: ChainDeps, campaignId: string, sending: ListVersion, nonce: number): SentPost {
  const posts = campaignMemory(deps.memory, campaignId).posts;
  const known = posts.get(sending.version);
  if (known !== undefined && known.nonce === nonce) return known;
  const fresh: SentPost = { nonce, hashes: [sending.postTx as Hash], resends: 0, gaveUp: false };
  posts.set(sending.version, fresh);
  return fresh;
}

type Mined = Extract<PostReceipt, { state: 'mined' }>;

async function recordMined(
  deps: ChainDeps,
  campaignId: string,
  version: number,
  hash: Hash,
  receipt: Mined,
  outcome: { posted: number[]; unsent: number[] },
  signal: AbortSignal | undefined,
): Promise<true> {
  checkpoint(signal, 'recording what became of a post');
  if (!receipt.ok) {
    if (await markListUnsent(deps.db, campaignId, version)) {
      outcome.unsent.push(version);
      deps.log(`reconcile ${campaignId}: the post ${hash} of list version ${version} reverted, so it is built again`);
    }
    forgetPost(deps, campaignId, version);
    return true;
  }
  const claimableAt = Number(receipt.claimableAt);
  if (!(await markListPosted(deps.db, campaignId, version, { postTx: hash.toLowerCase(), claimableAt }))) {
    throw new RootError(`list version ${version} could not be recorded as posted from its receipt`);
  }
  forgetPost(deps, campaignId, version);
  outcome.posted.push(version);
  deps.log(`reconcile ${campaignId}: the post ${hash} of list version ${version} is mined, so it is recorded as posted, claimable from unix ${claimableAt}`);
  return true;
}

async function recordUnsent(
  deps: ChainDeps,
  campaignId: string,
  version: number,
  why: string,
  outcome: { unsent: number[] },
  signal: AbortSignal | undefined,
): Promise<true> {
  checkpoint(signal, 'recording a post as unsent');
  if (await markListUnsent(deps.db, campaignId, version)) {
    outcome.unsent.push(version);
    deps.log(`reconcile ${campaignId}: ${why}, so list version ${version} is built again`);
  }
  forgetPost(deps, campaignId, version);
  return true;
}

/**
 * Signs a sending version's same root and declared total again at its stored nonce, with fees taken fresh, records the
 * new hash with markListResent, and only then broadcasts it. One nonce can carry only one mined transaction, so this
 * can replace the lost post and never add a second. At most MAX_RESENDS times in this process; after that it says so
 * once and sends nothing more.
 */
async function resend(deps: ChainDeps, campaign: Campaign, sending: ListVersion, nonce: number, signal: AbortSignal | undefined): Promise<void> {
  const id = campaign.id;
  const version = sending.version;
  const mine = sentPost(deps, id, sending, nonce);
  if (mine.resends >= MAX_RESENDS) {
    if (!mine.gaveUp) {
      mine.gaveUp = true;
      deps.log(
        `reconcile ${id}: list version ${version} was signed again ${MAX_RESENDS} times at nonce ${nonce} and no node shows it, so nothing more is sent; it waits for a receipt or for the nonce to be used`,
      );
    }
    return;
  }
  checkpoint(signal, 'signing a post again');
  const signed = await deps.chain.signPostRoot(parseAddress(campaign.vault), sending.root as MerkleHash, BigInt(sending.declaredTotal), nonce);
  if (signed.nonce !== nonce) throw new RootError(`list version ${version} was signed at another nonce than its own, so nothing was sent`);
  mine.resends += 1;
  mine.hashes.push(signed.hash);
  checkpoint(signal, 'recording a post signed again');
  if (!(await markListResent(deps.db, id, version, { postTx: signed.hash.toLowerCase() }, deps.now()))) {
    throw new RootError(`list version ${version} could not be recorded as sent again, so nothing was sent`);
  }
  checkpoint(signal, 'sending a post again');
  await deps.chain.broadcast(signed);
  deps.log(
    `reconcile ${id}: no node has shown the post of list version ${version} for ${RESEND_AFTER_SECONDS} s and nonce ${nonce} is unused, so it was signed again at that nonce and sent in ${signed.hash}`,
  );
}

/**
 * Settles a version recorded as sending, on proof only (C27, C32), in this order:
 * a. a receipt for any transaction it was sent with, the stored one or an earlier one this process signed at the same
 *    nonce: mined and successful, posted with the claimable time that receipt's own RootPosted log holds, so the
 *    existing cancel rule applies to it after its margin and its root is never sent again; mined and reverted, built again;
 * b. no receipt, and the agent's nonce at the latest mined block is above the stored nonce: another transaction used
 *    that nonce, so none of this version's can ever land, and it is built again, for publish to sign anew;
 * c. no receipt, the nonce unused, and no node has shown any of them for RESEND_AFTER_SECONDS: signed again at the same
 *    nonce (resend). Never a new nonce and never another version while the stored nonce is unused.
 * The nonce is read before the receipts, so a post mined between the two reads shows as its receipt, not as a used
 * nonce. A version recorded before nonces were kept (postNonce null) keeps the earlier rule: unknown to every node for
 * UNSENT_AFTER_SECONDS without a break, built again, and never signed again. Returns false while it stays sending.
 */
async function settleSending(
  deps: ChainDeps,
  campaign: Campaign,
  sending: ListVersion,
  outcome: { posted: number[]; unsent: number[] },
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const id = campaign.id;
  const version = sending.version;
  if (sending.postTx === null) throw new RootError(`list version ${version} is sending with no transaction on record`);
  const vault = parseAddress(campaign.vault);
  const nonce = sending.postNonce;
  const used = nonce !== null && (await deps.chain.minedNonce()) > nonce;
  const hashes = nonce === null ? [sending.postTx as Hash] : sentPost(deps, id, sending, nonce).hashes;
  const stored = sending.postTx.toLowerCase();
  let seen = false;
  for (const hash of [stored as Hash, ...hashes.filter((one) => one.toLowerCase() !== stored)]) {
    const receipt = await deps.chain.postReceipt(vault, sending.root as MerkleHash, hash, 0);
    if (receipt.state === 'mined') return recordMined(deps, id, version, hash, receipt, outcome, signal);
    if (receipt.state === 'pending') seen = true;
  }
  if (nonce === null) {
    if (!unseenFor(deps, id, version, seen, UNSENT_AFTER_SECONDS)) return false;
    return recordUnsent(deps, id, version, `no node knows the post ${stored} after ${UNSENT_AFTER_SECONDS} s`, outcome, signal);
  }
  if (used) return recordUnsent(deps, id, version, `nonce ${nonce} of its post was used by another transaction`, outcome, signal);
  if (!unseenFor(deps, id, version, seen, RESEND_AFTER_SECONDS)) return false;
  await resend(deps, campaign, sending, nonce, signal);
  return false;
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
 * records the hash and its nonce with markListSending, sends the signed bytes, waits for the receipt and records the
 * version posted with the receipt's own claimable time, or built again when the post reverted. The step's signal is
 * checked before every signature, store write and send; a step stopped after the send leaves the version sending, for
 * reconcile.
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
      const sent = { postTx: signed.hash.toLowerCase(), postNonce: signed.nonce };
      if (!(await markListSending(deps.db, id, version, sent, deps.now()))) {
        throw new RootError(`list version ${version} could not be recorded as sending, so nothing was sent`);
      }
      const mine = campaignMemory(deps.memory, id);
      mine.posts.set(version, { nonce: signed.nonce, hashes: [signed.hash], resends: 0, gaveUp: false });
      mine.missingSince.delete(version);
      checkpoint(signal, 'sending a post');
      await deps.chain.broadcast(signed);
      const receipt = await deps.chain.postReceipt(vault, root, signed.hash, RECEIPT_WAIT_MS);
      if (receipt.state !== 'mined') throw new RootError(`the post ${signed.hash} is not mined yet; reconcile settles it`);
      checkpoint(signal, 'recording a mined post');
      if (!receipt.ok) {
        await markListUnsent(deps.db, id, version);
        forgetPost(deps, id, version);
        throw new RootError(`the post ${signed.hash} reverted, so list version ${version} is built again`);
      }
      const claimableAt = Number(receipt.claimableAt);
      if (!(await markListPosted(deps.db, id, version, { postTx: null, claimableAt }))) {
        throw new RootError(`list version ${version} could not be recorded as posted`);
      }
      forgetPost(deps, id, version);
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

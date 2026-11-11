import type { Hash } from 'viem';
import { parseAddress, type Address } from '@thuli/core';
import {
  activeList,
  listText,
  listVersions,
  markListActive,
  markRelay,
  queueRelays,
  takeRelay,
  type RelayStatus,
} from '@thuli/store';
import { claimTicket } from '../vault/claimList.ts';
import { readPublishedList, RootError } from '../vault/root.ts';
import { LONGEST_RETRY_SECONDS, retryDelaySeconds } from './screen.ts';
import { campaignHere, campaignMemory, checkpoint, safeCause, StepStopped, waitNoted, type ChainDeps } from './vault.ts';

/** How long one worker holds a relay: above the 180 second receipt wait, so a claim in flight is never taken twice. */
export const RELAY_LEASE_SECONDS = 300;

/** Why activateCheck waits: a paused vault answers every claim and every claimable() with nothing. */
export const PAUSED_VAULT = 'the vault is paused';

// OpenZeppelin Pausable's error, which the vault reverts every claim with while paused.
const PAUSE_ERROR = 'EnforcedPause';
const RELAY_LABEL = 'relay';

export type ActivateOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'queued'; version: number; activated: boolean; owed: number; added: number };

export type RelayOutcome =
  | { kind: 'idle' }
  | {
      kind: 'relayed';
      campaignId: string;
      wallet: Address;
      version: number;
      status: RelayStatus | null;
      /** The wait before its next try, when it was given back pending; null otherwise. */
      retryAfterSeconds: number | null;
      tx: Hash | null;
      gasUsed: bigint | null;
      cause: string;
    };

/**
 * Makes a posted list version active once the vault pays it, then queues a relay for every wallet on the active list
 * that the vault still owes. A posted version becomes active only when the vault's own clock has reached its claimable
 * time and the vault's active root is that version's root, so the store never calls a list active that the vault does
 * not pay. While the vault is paused nothing is marked or queued (PAUSED_VAULT), because a paused vault answers 0 for
 * every claimable(). Owed is the wallet's listed cumulative amount less claimed(wallet), all read at the block the roots
 * were read at, and a wallet is queued when that is above zero, so a wallet paid in full, under this version or an
 * earlier one, gets no relay, and one paid in part is relayed for the rest (C27, C44). The version is marked queued in
 * this process only after a successful queue on an unpaused read; queueRelays leaves existing rows alone, so a restart
 * that queues again adds nothing.
 *
 * @returns queued with what was owed and added, or skipped with the reason.
 * @throws RootError, StoreError or a chain error when a read fails or the active list's text is not a published list.
 */
export async function activateCheck(deps: ChainDeps, campaignId: string, signal?: AbortSignal): Promise<ActivateOutcome> {
  const here = await campaignHere(deps, campaignId);
  if (!here.ok) return { kind: 'skipped', reason: here.reason };
  const vault = parseAddress(here.campaign.vault);
  const roots = await deps.chain.roots(vault);
  if (roots.paused) return { kind: 'skipped', reason: PAUSED_VAULT };

  const due = (await listVersions(deps.db, campaignId))
    .filter((version) => version.status === 'posted' && version.root === roots.activeRoot)
    .filter((version) => version.claimableAt !== null && BigInt(version.claimableAt) <= roots.timestamp)
    .at(-1);
  let activated = false;
  if (due !== undefined) {
    checkpoint(signal, 'marking a list active');
    activated = await markListActive(deps.db, campaignId, due.version);
    if (activated) deps.log(`activate ${campaignId}: list version ${due.version} is the root the vault pays now`);
  }

  const active = await activeList(deps.db, campaignId);
  if (active === null) return { kind: 'skipped', reason: 'no list version is active yet' };
  if (active.root !== roots.activeRoot) return { kind: 'skipped', reason: 'the vault pays another root than the active list' };
  const queued = campaignMemory(deps.memory, campaignId).queued;
  if (queued.has(active.version)) return { kind: 'skipped', reason: `relays for list version ${active.version} are queued` };

  const text = await listText(deps.db, campaignId, active.version);
  if (text === null) return { kind: 'skipped', reason: `list version ${active.version} has no published text` };
  const entries = readPublishedList(text);
  const claimed = await deps.chain.claimedOf(vault, entries.map((entry) => parseAddress(entry.account)), roots.blockNumber);
  if (claimed.length !== entries.length) throw new RootError('the vault read did not answer claimed() for every listed wallet');
  const owed = entries.filter((entry, index) => entry.cumulativeAmount > (claimed[index] as bigint));
  checkpoint(signal, 'queueing relays');
  const added = await queueRelays(
    deps.db,
    campaignId,
    active.version,
    owed.map((entry) => ({ wallet: entry.account, amount: entry.cumulativeAmount.toString() })),
    deps.now(),
  );
  queued.add(active.version);
  deps.log(`activate ${campaignId}: list version ${active.version}, ${owed.length} of ${entries.length} wallets owed, ${added} relays queued`);
  return { kind: 'queued', version: active.version, activated, owed: owed.length, added };
}

/**
 * Submits the oldest waiting claim from the worker's key, so the wallet is paid without paying gas. The ticket is built
 * by claimTicket from that version's published text exactly as stored, so it proves against the root anyone rebuilds
 * from it (C32), and the vault always pays the wallet in the leaf, whoever submits (C31). The worker signs only claim
 * here, never anything on the wallet's behalf (C30, C39).
 *
 * The vault's paused flag is read before the claim is simulated. While it is paused, or when the simulation reverts with
 * the pause error, the relay is given back with LONGEST_RETRY_SECONDS and its try handed back, so a pause of any length
 * never ends a listed wallet's claim (C44), and the wait is logged once for the campaign.
 *
 * A claim is simulated before it is sent. One that would revert with NothingToClaim is confirmed without a transaction,
 * because the vault has paid that wallet everything it is owed already; any other revert, a claim that reverts on
 * chain, or any failed call gives the relay back for another try after retryDelaySeconds for its attempt, and the store
 * ends it failed at its attempt limit (C41). A broadcast claim is marked sent with its hash before the wait, even when
 * the step was told to stop during the send, so a worker that stops mid-wait leaves a record, and the next try's
 * simulation finds NothingToClaim if it landed (C27). The signal is checked before the send and before every other
 * write, never between the send and its record.
 *
 * @returns idle when no relay is waiting; relayed with the status the store recorded and the cause in fixed words.
 * @throws StoreError only when the store cannot hand out or record a relay at all.
 */
export async function relayNext(deps: ChainDeps, signal?: AbortSignal): Promise<RelayOutcome> {
  checkpoint(signal, 'taking a relay');
  const relay = await takeRelay(deps.db, deps.now(), RELAY_LEASE_SECONDS);
  if (relay === null) return { kind: 'idle' };
  const key = { campaignId: relay.campaignId, wallet: relay.wallet, version: relay.version };
  let tx: Hash | null = null;
  let gasUsed: bigint | null = null;
  const finish = async (status: RelayStatus, cause: string): Promise<RelayOutcome> => {
    checkpoint(signal, 'recording a relay');
    const wait = status === 'pending' ? retryDelaySeconds(relay.attempts) : undefined;
    const stored = await markRelay(deps.db, key, { status, retryAfterSeconds: wait }, deps.now());
    const retryAfterSeconds = stored === 'pending' && wait !== undefined ? wait : null;
    const outcome = retryAfterSeconds === null ? (stored ?? 'not recorded') : `pending, next try in ${retryAfterSeconds} s`;
    deps.log(`relay ${relay.campaignId} ${relay.wallet} list version ${relay.version}: ${outcome}, ${cause}`);
    return { kind: 'relayed', ...key, status: stored, retryAfterSeconds, tx, gasUsed, cause };
  };
  // A pause is the owner's, not the claim's, so the try is handed back and the claim is looked at again every ten
  // minutes until the vault pays again; the wait is said once for the campaign, not once per claim.
  const pausedBack = async (waiting: Map<string, string>): Promise<RelayOutcome> => {
    checkpoint(signal, 'giving a relay back');
    const stored = await markRelay(deps.db, key, { status: 'pending', retryAfterSeconds: LONGEST_RETRY_SECONDS, refundTry: true }, deps.now());
    if (waitNoted(waiting, RELAY_LABEL, PAUSED_VAULT)) deps.log(`relay ${relay.campaignId}: waiting, ${PAUSED_VAULT}`);
    const retryAfterSeconds = stored === 'pending' ? LONGEST_RETRY_SECONDS : null;
    return { kind: 'relayed', ...key, status: stored, retryAfterSeconds, tx: null, gasUsed: null, cause: PAUSED_VAULT };
  };

  try {
    const here = await campaignHere(deps, relay.campaignId);
    if (!here.ok) return finish('pending', here.reason);
    const { campaign } = here;
    const vault = parseAddress(campaign.vault);
    const text = await listText(deps.db, relay.campaignId, relay.version);
    if (text === null) return finish('failed', 'the list version has no published text');
    const ticket = claimTicket(text, vault, campaign.chain, relay.wallet);
    if (ticket === null || ticket.cumulativeAmount !== BigInt(relay.amount)) {
      return finish('failed', 'the wallet is not on that list version with the amount queued');
    }

    const waiting = campaignMemory(deps.memory, relay.campaignId).waiting;
    if ((await deps.chain.roots(vault)).paused) return pausedBack(waiting);
    const simulated = await deps.chain.simulateClaim(vault, ticket);
    if (!simulated.ok) {
      if (simulated.error === 'NothingToClaim') return finish('confirmed', 'the vault has nothing left to pay this wallet');
      if (simulated.error === PAUSE_ERROR) return pausedBack(waiting);
      return finish('pending', `the claim would revert with ${simulated.error}`);
    }
    waitNoted(waiting, RELAY_LABEL, undefined);
    checkpoint(signal, 'sending a claim');
    tx = await deps.chain.sendClaim(vault, ticket);
    // No checkpoint here: a claim on the network is always recorded, abort or not, so a stop never hides our own send.
    await markRelay(deps.db, key, { status: 'sent', tx: tx.toLowerCase() }, deps.now());
    const receipt = await deps.chain.confirmClaim(tx);
    gasUsed = receipt.gasUsed;
    if (!receipt.ok) return finish('pending', `claim ${tx} reverted on chain`);
    return finish('confirmed', `claimed ${ticket.cumulativeAmount} cumulative base units in ${tx} (gas ${receipt.gasUsed})`);
  } catch (error) {
    // A stopped step writes nothing more: the relay stays leased and is taken again once its lease runs out (C41).
    if (error instanceof StepStopped) throw error;
    return finish('pending', safeCause(error));
  }
}

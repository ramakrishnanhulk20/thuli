import { accountTypeFromCode } from './accountType.ts';
import { parseAddress } from './address.ts';
import { FACT_NAMES, Facts, FUNDER_KINDS, MAX_EVIDENCE_TXS, type FactName } from './facts.ts';
import type { Settings } from './settings.ts';

/** A pass-through wallet forwards its one funding within this many blocks, about ten minutes on Ethereum. */
export const PASS_THROUGH_MAX_BLOCKS = 50;
/** Most pass-through wallets followed back from one claim wallet, so a funding cycle cannot loop (C41). */
export const MAX_TRACE_HOPS = 6;
/** A sender with at least this many transactions at the snapshot counts as an exchange or service (C16). */
export const HIGH_VOLUME_NONCE = 10_000;
/** Fundings from one source inside this window count together for the group rule. */
export const FUNDING_WINDOW_SECONDS = 7 * 86_400;
export const SECONDS_PER_DAY = 86_400;

/**
 * One value movement as an explorer lists it. Addresses and hashes are lowercase, valueWei is whole wei in decimal
 * digits, time is in seconds, and `to` is null for a contract creation. An internal transfer is value a contract moved
 * during someone's transaction.
 */
export interface Transfer {
  hash: string;
  block: number;
  time: number;
  from: string;
  to: string | null;
  valueWei: string;
  failed: boolean;
  kind: 'external' | 'internal';
}

/** Transfers oldest first, all before the snapshot. complete is false when more may follow the last one. */
export interface TransferPage {
  transfers: Transfer[];
  complete: boolean;
}

/** What was read for one address. internal is undefined when its internal transfers were not fetched. */
export interface AddressData {
  external: TransferPage;
  internal?: TransferPage;
}

/** Nonce and code at the snapshot block. null means the value could not be read. */
export interface AccountState {
  nonce: number | null;
  code: string | null;
}

// 'bridge' stays in the shared list but this engine never produces it: no single predicate tells a bridge from any
// other contract, so a bridge reports as 'contract'.
export type FunderKind = (typeof FUNDER_KINDS)[number];

export type TraceResult =
  | { status: 'done'; funder: string; root: string; hops: string[]; txs: string[]; fundingTime: number }
  | { status: 'needs'; address: string }
  | { status: 'none' }
  | { status: 'unknown' };

/** Everything the replay read, keyed by lowercase address: data and traces by claim wallet, states by any address. */
export interface ReplayInput {
  wallets: string[];
  snapshotTime: number;
  settings: Settings;
  data: Map<string, AddressData>;
  traces: Map<string, TraceResult>;
  states: Map<string, AccountState>;
  /** Each shared destination's oldest transfers, keyed by lowercase address. An absent page means it could not be read. */
  destinationPages: Map<string, TransferPage>;
}

const DECIMAL_DIGITS = /^[0-9]+$/;

// Both sides of every address and hash comparison go through this one function (C.2 standard 2).
function lower(value: string): string {
  return value.toLowerCase();
}

function wei(transfer: Transfer): bigint {
  // BigInt also accepts hex, a sign, spaces and the empty string, so a malformed value would quietly become a number.
  if (!DECIMAL_DIGITS.test(transfer.valueWei)) throw new TypeError('valueWei must be whole wei in decimal digits');
  return BigInt(transfer.valueWei);
}

function allTransfers(data: AddressData): Transfer[] {
  const external = data.external.transfers;
  return data.internal === undefined ? external : [...external, ...data.internal.transfers];
}

/** Value someone else successfully moved to the address. Failed and zero-value transfers move nothing, so never count. */
function incomingTo(address: string, data: AddressData): Transfer[] {
  return allTransfers(data).filter(
    (t) => !t.failed && t.to !== null && lower(t.to) === address && lower(t.from) !== address && wei(t) > 0n,
  );
}

/** Successful external transactions the address signed itself, of any value. */
function ownSends(address: string, data: AddressData): Transfer[] {
  return data.external.transfers.filter((t) => !t.failed && lower(t.from) === address);
}

/** External sends of real value the address signed itself. */
function valueSendsFrom(address: string, data: AddressData): Transfer[] {
  return ownSends(address, data).filter((t) => wei(t) > 0n);
}

function everythingRead(data: AddressData): boolean {
  return data.external.complete && data.internal !== undefined && data.internal.complete;
}

/**
 * Sends that emptied the wallet: each moved at least half of everything the wallet had received up to that block. A
 * farm sweeps its wallets into a collector; an ordinary user paying the same service fee does not. Live, 4 Nov: five
 * old wallets each paid about 0.002 ETH to one fee wallet (nonce 5,524) over 17 months, and counting those payments
 * as links excluded all five under A3. Only sweeps link wallets or count as a shared deposit (C15).
 */
function sweepsFrom(address: string, data: AddressData): Transfer[] {
  const incoming = incomingTo(address, data);
  return valueSendsFrom(address, data).filter((send) => {
    const received = incoming.filter((t) => t.block <= send.block).reduce((sum, t) => sum + wei(t), 0n);
    return wei(send) * 2n >= received;
  });
}

/** Larger value first, then the earliest: lower block, external before internal, then hash order. */
function outranks(a: Transfer, b: Transfer): boolean {
  const valueA = wei(a);
  const valueB = wei(b);
  if (valueA !== valueB) return valueA > valueB;
  if (a.block !== b.block) return a.block < b.block;
  if (a.kind !== b.kind) return a.kind === 'external';
  return lower(a.hash) < lower(b.hash);
}

function uniqueLower(values: string[]): string[] {
  return [...new Set(values.map(lower))];
}

/**
 * The transfer that funded the address: its largest successful incoming value at or before its first own send,
 * earliest on a tie. Dust and zero-value look-alike transfers lose to the real funding (DECISIONS.md 3 Nov, M3).
 * Returns 'none' only when every external and internal transfer was read and none qualifies; otherwise 'unknown',
 * because the funding may sit in an unread page or in internal transfers not yet fetched (C11).
 */
export function fundingTransfer(
  address: string,
  data: AddressData,
): { status: 'found'; transfer: Transfer } | { status: 'none' } | { status: 'unknown' } {
  const self = lower(address);
  let firstOutBlock: number | undefined;
  for (const t of ownSends(self, data)) {
    if (firstOutBlock === undefined || t.block < firstOutBlock) firstOutBlock = t.block;
  }
  const candidates = incomingTo(self, data).filter((t) => firstOutBlock === undefined || t.block <= firstOutBlock);
  let best: Transfer | undefined;
  for (const t of candidates) {
    if (best === undefined || outranks(t, best)) best = t;
  }
  if (best !== undefined) return { status: 'found', transfer: best };
  return everythingRead(data) ? { status: 'none' } : { status: 'unknown' };
}

/**
 * Whole days from the wallet's first activity to the snapshot: the earliest successful transfer that moved value into
 * the wallet or that the wallet sent itself, any value. Zero-value inbound transfers and failed transfers never count,
 * because anyone can send them to any address, so a stranger cannot make a wallet look old (C15). The replay and the
 * single-wallet collector both call this, so age means one thing (C20).
 *
 * Returns 0 for a wallet with no such transfer when every page was read, and null when a page may be missing one, or
 * when the earliest one is dated after the snapshot.
 */
export function walletAgeDays(address: string, data: AddressData, snapshotTime: number): number | null {
  const self = lower(address);
  let earliest: number | undefined;
  for (const t of [...ownSends(self, data), ...incomingTo(self, data)]) {
    if (earliest === undefined || t.time < earliest) earliest = t.time;
  }
  if (earliest === undefined) return everythingRead(data) ? 0 : null;
  if (earliest > snapshotTime) return null;
  return Math.floor((snapshotTime - earliest) / SECONDS_PER_DAY);
}

/**
 * True for a single-use wallet that only forwards money: a fully read history with exactly one incoming value, exactly
 * one external send of value, sent within PASS_THROUGH_MAX_BLOCKS of receiving it and carrying at least half of it.
 * Zero-value and failed transfers are ignored on both sides.
 */
export function isPassThrough(address: string, data: AddressData): boolean {
  if (!data.external.complete) return false;
  const self = lower(address);
  const incoming = incomingTo(self, data);
  const outgoing = valueSendsFrom(self, data);
  const received = incoming[0];
  const sent = outgoing[0];
  if (incoming.length !== 1 || outgoing.length !== 1 || received === undefined || sent === undefined) return false;
  return (
    sent.block >= received.block &&
    sent.block <= received.block + PASS_THROUGH_MAX_BLOCKS &&
    wei(sent) * 2n >= wei(received)
  );
}

/**
 * Follows a claim wallet's funding back through pass-through wallets to the real source, at most maxHops wallets.
 * Returns 'needs' with the first address whose data the caller has not supplied yet, so the caller can fetch it and
 * call again. txs lists the funding hashes walked, the claim wallet's own funding first. A cycle cannot loop forever
 * because hops is capped.
 */
export function traceFunding(
  wallet: string,
  lookup: (address: string) => AddressData | undefined,
  maxHops = MAX_TRACE_HOPS,
): TraceResult {
  const self = lower(wallet);
  const data = lookup(self);
  if (data === undefined) return { status: 'needs', address: self };
  const funding = fundingTransfer(self, data);
  if (funding.status !== 'found') return funding;
  const funder = lower(funding.transfer.from);
  const txs = [lower(funding.transfer.hash)];
  const hops: string[] = [];
  let current = funder;
  for (;;) {
    const hopData = lookup(current);
    if (hopData === undefined) return { status: 'needs', address: current };
    if (!isPassThrough(current, hopData)) break;
    // Still passing money on at the cap: the real source is further back than Thuli looks, so this is doubt, and doubt
    // means hold (C41, C11). One-in-one-out wallets cannot form a cycle, so the cap alone bounds the walk.
    if (hops.length >= maxHops) return { status: 'unknown' };
    const next = fundingTransfer(current, hopData);
    if (next.status !== 'found') break;
    hops.push(current);
    txs.push(lower(next.transfer.hash));
    current = lower(next.transfer.from);
  }
  return { status: 'done', funder, root: current, hops, txs, fundingTime: funding.transfer.time };
}

/**
 * What kind of sender an address is, from its nonce and code at the snapshot. A delegated EOA (EIP-7702) keeps its
 * own key, so it stays a wallet (C20). Anything unread is 'unknown'.
 */
export function funderKind(state: AccountState | undefined): FunderKind {
  if (state === undefined || state.code === null || state.nonce === null) return 'unknown';
  if (accountTypeFromCode(state.code) === 'contract') return 'contract';
  // A high-volume sender, probably an exchange or service hot wallet. A predicate instead of a label list (C16).
  if (state.nonce >= HIGH_VOLUME_NONCE) return 'exchange';
  return 'wallet';
}

/**
 * Each address that two or more claim wallets swept into before the snapshot (see sweepsFrom), with the claim wallets
 * that swept. The runner calls this to learn which destinations' states to fetch.
 */
export function sharedDestinations(input: Pick<ReplayInput, 'wallets' | 'data'>): Map<string, Set<string>> {
  const senders = new Map<string, Set<string>>();
  for (const wallet of uniqueLower(input.wallets)) {
    const data = input.data.get(wallet);
    if (data === undefined) continue;
    for (const send of sweepsFrom(wallet, data)) {
      if (send.to === null) continue;
      const dest = lower(send.to);
      const set = senders.get(dest) ?? new Set<string>();
      set.add(wallet);
      senders.set(dest, set);
    }
  }
  for (const [dest, set] of senders) {
    if (set.size < 2) senders.delete(dest);
  }
  return senders;
}

/** False when value the wallet received may be missing from what was read, so a send of its cannot be judged a sweep. */
function inflowsRead(data: AddressData | undefined): boolean {
  return data !== undefined && data.internal !== undefined && data.internal.complete;
}

/**
 * How much of an address's early crowd is on the claim list, in whole basis points rounded down: the distinct senders of
 * successful incoming value in the page, and the share of them in claimWallets (lowercase addresses). The address's own
 * sends, failed transfers and zero-value transfers do not count, and a sender counts once however often it paid.
 *
 * It tells a public address from a private collector where nonce cannot: a bridge or a donation address is paid by
 * strangers from the start, and a donation address can have a nonce of 48 with tens of thousands of senders (C16).
 *
 * An empty sender set gives 10000: nothing shows the address is public, and the wallets that swept there are themselves
 * senders the page may not reach. Not covered: a new public address used first mostly by list wallets still links, and
 * only the oldest transfers are seen, so an address that went public later looks as private as it first was. A farm that
 * pays its collector from enough throwaway wallets before using it looks public and is not linked through that address.
 */
export function senderListShareBps(destination: string, page: TransferPage, claimWallets: ReadonlySet<string>): number {
  const senders = new Set(incomingTo(lower(destination), { external: page }).map((t) => lower(t.from)));
  if (senders.size === 0) return 10_000;
  const onList = [...senders].filter((sender) => claimWallets.has(sender)).length;
  return Math.floor((onList * 10_000) / senders.size);
}

/** Union-find over the claim wallets, so every wallet reachable through any link shares one component. */
class Components {
  private readonly wallets: string[] = [];
  private readonly index = new Map<string, number>();
  private readonly parent: number[] = [];
  private readonly size: number[] = [];
  // Each root's earliest member in input order, so a group's label does not depend on the order links were joined in.
  private readonly first: number[] = [];

  constructor(wallets: string[]) {
    for (const wallet of wallets) {
      this.index.set(wallet, this.parent.length);
      this.first.push(this.parent.length);
      this.parent.push(this.parent.length);
      this.size.push(1);
      this.wallets.push(wallet);
    }
  }

  private find(start: number): number {
    let i = start;
    while (this.parent[i] !== i) {
      const grandparent = this.parent[this.parent[i] as number] as number;
      this.parent[i] = grandparent;
      i = grandparent;
    }
    return i;
  }

  join(wallets: Iterable<string>): void {
    let first: number | undefined;
    for (const wallet of wallets) {
      const at = this.index.get(wallet);
      if (at === undefined) continue;
      if (first === undefined) {
        first = at;
        continue;
      }
      const a = this.find(first);
      const b = this.find(at);
      if (a === b) continue;
      const [big, small] = (this.size[a] as number) >= (this.size[b] as number) ? [a, b] : [b, a];
      this.parent[small] = big;
      this.size[big] = (this.size[big] as number) + (this.size[small] as number);
      this.first[big] = Math.min(this.first[big] as number, this.first[small] as number);
    }
  }

  /**
   * The wallet's linked group: its size in claim wallets and a label naming it, the group's first wallet in input order.
   * Null when nothing links the wallet to another claim wallet. facts.group and replayGroupLabels both read this.
   */
  groupOf(wallet: string): { label: string; size: number } | null {
    const at = this.index.get(wallet);
    if (at === undefined) return null;
    const root = this.find(at);
    const size = this.size[root] as number;
    if (size < 2) return null;
    return { label: this.wallets[this.first[root] as number] as string, size };
  }
}

/**
 * For each wallet under one root: the most same-root fundings that fit in one FUNDING_WINDOW_SECONDS window (ends
 * included) that also holds the wallet's own funding. Linear after the sort, because one root can fund thousands.
 */
function sameFunderWindowCounts(members: { wallet: string; fundingTime: number }[]): Map<string, number> {
  const sorted = [...members].sort((a, b) => a.fundingTime - b.fundingTime);
  const times = sorted.map((m) => m.fundingTime);
  const count = times.length;
  const fitsFrom: number[] = [];
  let end = 0;
  for (let i = 0; i < count; i += 1) {
    while (end < count && (times[end] as number) - (times[i] as number) <= FUNDING_WINDOW_SECONDS) end += 1;
    fitsFrom.push(end - i);
  }
  // A best window holding time t can slide later until it starts on a funding, and that start lies in [t - window, t].
  // So the answer for t is the largest fitsFrom over those starts. As t grows the range only moves forward, and a queue
  // of starts whose fitsFrom keeps falling gives each range's largest at its head.
  const result = new Map<string, number>();
  const queue: number[] = [];
  let head = 0;
  let nextStart = 0;
  for (const { wallet, fundingTime: t } of sorted) {
    while (nextStart < count && (times[nextStart] as number) <= t) {
      const fits = fitsFrom[nextStart] as number;
      while (queue.length > head && (fitsFrom[queue[queue.length - 1] as number] as number) <= fits) queue.pop();
      queue.push(nextStart);
      nextStart += 1;
    }
    while ((times[queue[head] as number] as number) < t - FUNDING_WINDOW_SECONDS) head += 1;
    result.set(wallet, fitsFrom[queue[head] as number] as number);
  }
  return result;
}

/** One claim wallet's first funding, as the burst rule reads it. Each wallet appears once. */
export interface BurstCandidate {
  wallet: string;
  source: string;
  time: number;
  amount: bigint;
}

/**
 * For each amount in ascending order, the size of the largest window holding it. Window starts only move forward, so
 * the windows holding one amount are neighbours by end, and a queue of ever smaller sizes reads the largest in O(n).
 */
function largestWindowSizes(amounts: bigint[], spread: bigint): number[] {
  const starts: number[] = [];
  let start = 0;
  amounts.forEach((amount, end) => {
    while (amount * 10_000n > (amounts[start] as bigint) * spread) start += 1;
    starts[end] = start;
  });
  const sizeOf = (end: number) => end - (starts[end] as number) + 1;

  const queue: number[] = [];
  let head = 0;
  let nextEnd = 0;
  return amounts.map((_, index) => {
    while (nextEnd < amounts.length && (starts[nextEnd] as number) <= index) {
      while (queue.length > head && sizeOf(queue[queue.length - 1] as number) <= sizeOf(nextEnd)) queue.pop();
      queue.push(nextEnd);
      nextEnd += 1;
    }
    while ((queue[head] as number) < index) head += 1;
    return sizeOf(queue[head] as number);
  });
}

/**
 * Wallets first funded in a burst: at least burstMinWallets from one source on one UTC day, in amounts within
 * burstSpreadBps of the smallest in the window. Each wallet maps to the size of the largest single window holding it,
 * because that count lands in a reason that calls the amounts near-equal, and a chain of overlapping windows can span
 * any range; a wallet in no burst is absent. One exchange can fund a whole list in a day, so the work stays O(n log n)
 * (C41).
 */
export function fundingBursts(
  candidates: BurstCandidate[],
  settings: Pick<Settings, 'burstMinWallets' | 'burstSpreadBps'>,
): Map<string, number> {
  const buckets = new Map<string, BurstCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.source}:${Math.floor(candidate.time / SECONDS_PER_DAY)}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [candidate]);
    else bucket.push(candidate);
  }

  const spread = 10_000n + BigInt(settings.burstSpreadBps);
  const result = new Map<string, number>();
  for (const bucket of buckets.values()) {
    const sorted = [...bucket].sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
    const largest = largestWindowSizes(sorted.map((candidate) => candidate.amount), spread);
    sorted.forEach(({ wallet }, index) => {
      const size = largest[index] as number;
      if (size >= settings.burstMinWallets) result.set(wallet, size);
    });
  }
  return result;
}

/**
 * Claim wallets an exchange funded directly. A contract stays out on purpose: on the ROBO replay one contract source hit
 * 63 of 742 old active control wallets and exchange sources hit none. A pass-through hop stays out because the amount
 * that reached the wallet is no longer the amount the exchange sent.
 */
function directExchangeFundings(
  wallets: string[],
  { data, traces }: Pick<ReplayInput, 'data' | 'traces'>,
  kindOf: (address: string) => FunderKind,
): BurstCandidate[] {
  const candidates: BurstCandidate[] = [];
  for (const wallet of wallets) {
    const trace = traces.get(wallet);
    const walletData = data.get(wallet);
    if (trace?.status !== 'done' || trace.hops.length > 0 || walletData === undefined) continue;
    const source = lower(trace.root);
    if (kindOf(source) !== 'exchange') continue;
    const funding = fundingTransfer(wallet, walletData);
    if (funding.status !== 'found') continue;
    candidates.push({ wallet, source, time: funding.transfer.time, amount: wei(funding.transfer) });
  }
  return candidates;
}

/**
 * Works out every rulebook fact for each claim wallet from data the runner already read (pure, no network). Wallets
 * are linked into groups by a shared funding root or a shared destination, but only through addresses that are
 * wallets or unknown: doubt should make a hold more likely, never less, and contracts and exchanges never link (C16).
 * A shared destination must also look private by senderListShareBps, so a bridge or a donation address links nobody;
 * one whose page could not be read leaves the group unread, so the wallet holds (C11). So does a destination that a
 * wallet whose internal transfers are missing or incomplete swept to, for every wallet that swept there, because the
 * sweep may be a payment from money that was not read. Funding roots take no such check.
 * A funding burst is a pattern, not a link, so it is reported on its own and never joins wallets into a group (C45).
 * Each result goes through Facts.parse, so a bad fact throws instead of reaching a decision.
 */
export function buildReplayFacts(input: ReplayInput): Map<string, Facts> {
  const { snapshotTime, settings, data, traces, states, destinationPages } = input;
  const { wallets, kindOf, linkable, linksWallets, byRoot, shared, components, windowCounts, sweptOnUnreadInflows } = linkClaimWallets(input);
  const bursts = fundingBursts(directExchangeFundings(wallets, input, kindOf), settings);

  const result = new Map<string, Facts>();
  for (const wallet of wallets) {
    const walletData = data.get(wallet);
    const state = states.get(wallet);
    const trace = traces.get(wallet);
    const missing = new Set<FactName>();

    let firstFunder: Facts['firstFunder'] = null;
    if (trace?.status === 'done') {
      const root = lower(trace.root);
      firstFunder = {
        address: parseAddress(root),
        kind: kindOf(root),
        fanoutInList: byRoot.get(root)?.length ?? 0,
        hopsTraced: trace.hops.length,
      };
      if (kindOf(root) === 'unknown') missing.add('group');
    } else if (trace?.status !== 'none') {
      missing.add('firstFunder');
    }

    let swept = false;
    let largestDeposit = 0;
    const sendHashes: string[] = [];
    for (const send of walletData === undefined ? [] : sweepsFrom(wallet, walletData)) {
      const dest = send.to === null ? undefined : lower(send.to);
      const senders = dest === undefined ? undefined : shared.get(dest)?.size;
      if (dest === undefined || senders === undefined) continue;
      // Without the destination's state or its page we cannot tell a farm collector from an exchange or a public address,
      // so the group stays unread.
      if (kindOf(dest) === 'unknown' || (linkable(dest) && !destinationPages.has(dest))) missing.add('group');
      if (!linksWallets(dest)) continue;
      if (sweptOnUnreadInflows.has(dest)) missing.add('group');
      sendHashes.push(lower(send.hash));
      if (senders >= settings.groupMinSize) swept = true;
      else largestDeposit = Math.max(largestDeposit, senders);
    }

    const linked = components.groupOf(wallet);
    const fundedAnotherClaimWallet = linkable(wallet) && (byRoot.get(wallet) ?? []).some((member) => member.wallet !== wallet);
    const group =
      linked !== null
        ? {
            size: linked.size,
            sameFunderWithinWindow: windowCounts.get(wallet) ?? null,
            sweptToSharedCollector: swept,
            // Only a sweep is something this wallet did. A funding it received could have come from anyone (C15).
            authoredEvidence: swept,
            // Wider than authoredEvidence on purpose: a sweep shared with one other wallet, or funding another claim wallet,
            // is this wallet's own doing but too thin to exclude on. It tells the model what happened and A3 never reads it.
            linkedByWallet: sendHashes.length > 0 || fundedAnotherClaimWallet,
          }
        : null;

    const age = walletData === undefined ? null : walletAgeDays(wallet, walletData, snapshotTime);
    const txCount = state?.nonce ?? null;
    const accountType = state === undefined || state.code === null ? 'unknown' : accountTypeFromCode(state.code);
    if (age === null) missing.add('walletAgeDays');
    if (txCount === null) missing.add('txCountAtSnapshot');
    if (accountType === 'unknown') missing.add('accountType');

    const traceTxs = trace?.status === 'done' ? trace.txs.map(lower) : [];
    const burstWallets = bursts.get(wallet);
    result.set(
      wallet,
      Facts.parse({
        walletAgeDays: age,
        txCountAtSnapshot: txCount,
        accountType,
        firstFunder,
        group,
        sharedDepositAddress: largestDeposit >= 2 ? { sharedWithClaimants: largestDeposit - 1 } : null,
        fundingBurst: burstWallets === undefined ? null : { wallets: burstWallets },
        // Pre-claim replay: claims have not opened, so there is no claim to redirect (DECISIONS.md 3 Nov, M3).
        claimPaidToOtherAddress: false,
        evidenceTxs: [...new Set([...traceTxs, ...sendHashes])].slice(0, MAX_EVIDENCE_TXS),
        missing: FACT_NAMES.filter((name) => missing.has(name)),
      }),
    );
  }
  return result;
}

/**
 * Each linked claim wallet's group label, keyed by lowercase wallet: the group's first wallet in input order. A wallet
 * that facts.group leaves null is absent, and the wallets sharing a label are exactly the facts.group.size wallets of
 * that group, because both come from the same linking. Pure, like buildReplayFacts.
 */
export function replayGroupLabels(input: ReplayInput): Map<string, string> {
  const { wallets, components } = linkClaimWallets(input);
  const labels = new Map<string, string>();
  for (const wallet of wallets) {
    const linked = components.groupOf(wallet);
    if (linked !== null) labels.set(wallet, linked.label);
  }
  return labels;
}

interface Links {
  wallets: string[];
  kindOf: (address: string) => FunderKind;
  linkable: (address: string) => boolean;
  linksWallets: (dest: string) => boolean;
  byRoot: Map<string, { wallet: string; fundingTime: number }[]>;
  shared: Map<string, Set<string>>;
  components: Components;
  windowCounts: Map<string, number>;
  sweptOnUnreadInflows: Set<string>;
}

/** The one place claim wallets are joined into groups, by the rules buildReplayFacts states. */
function linkClaimWallets(input: ReplayInput): Links {
  const { settings, data, traces, states, destinationPages } = input;
  const wallets = uniqueLower(input.wallets);
  const claimWallets = new Set(wallets);
  const kindOf = (address: string) => funderKind(states.get(address));
  const linkable = (address: string) => kindOf(address) === 'wallet' || kindOf(address) === 'unknown';
  // The one test for a destination, so groups, A3, A6, evidence and linkedByWallet can never disagree about an address.
  const linksWallets = (dest: string) => {
    const page = destinationPages.get(dest);
    return linkable(dest) && page !== undefined && senderListShareBps(dest, page, claimWallets) >= settings.collectorMinListShareBps;
  };

  const byRoot = new Map<string, { wallet: string; fundingTime: number }[]>();
  for (const wallet of wallets) {
    const trace = traces.get(wallet);
    if (trace?.status !== 'done') continue;
    const root = lower(trace.root);
    const members = byRoot.get(root) ?? [];
    members.push({ wallet, fundingTime: trace.fundingTime });
    byRoot.set(root, members);
  }

  const shared = sharedDestinations({ wallets, data });
  const components = new Components(wallets);
  const windowCounts = new Map<string, number>();
  for (const [root, members] of byRoot) {
    if (!linkable(root)) continue;
    // A claim wallet that funded other claim wallets belongs in their group too.
    components.join([...members.map((m) => m.wallet), ...(claimWallets.has(root) ? [root] : [])]);
    for (const [wallet, fits] of sameFunderWindowCounts(members)) windowCounts.set(wallet, fits);
  }
  // A payment from a wallet whose inflows were not all read can look like a sweep, so every count at that destination
  // is in doubt, for the wallets whose own inflows were read too: a fifth doubtful sweeper is what lifts four to A3.
  // The wallets are still joined, because leaving one out could raise another wallet's outcome (C11).
  const sweptOnUnreadInflows = new Set<string>();
  for (const [dest, senders] of shared) {
    if (!linksWallets(dest)) continue;
    components.join(senders);
    if ([...senders].some((sender) => !inflowsRead(data.get(sender)))) sweptOnUnreadInflows.add(dest);
  }
  return { wallets, kindOf, linkable, linksWallets, byRoot, shared, components, windowCounts, sweptOnUnreadInflows };
}

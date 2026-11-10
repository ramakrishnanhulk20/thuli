import {
  buildReplayFacts,
  computeCeiling,
  computeStart,
  funderKind,
  fundingTransfer,
  MAX_TRACE_HOPS,
  parseAddress,
  sharedDestinations,
  traceFunding,
  type AccountState,
  type AddressData,
  type ReplayRow,
  type Settings,
  type TraceResult,
  type TransferPage,
} from '@thuli/core';
import { ExplorerError, type ExplorerSource } from '../chain/explorer.ts';

// The explorer's shared rate limiter still sets the pace. A few calls in flight only hide each call's round trip, so a
// run reaches the allowed rate instead of waiting on the network between calls (6e).
const IN_FLIGHT = 4;
const PROGRESS_EVERY_CALLS = 1_000;
// One pass per address on the longest funding path: the funder, MAX_TRACE_HOPS pass-through wallets after it, and a
// last pass that finds nothing new. Hitting the cap leaves the rest unread, which ends in hold (C41, C11).
const MAX_TRACE_PASSES = MAX_TRACE_HOPS + 2;

export interface ReplayDeps {
  explorer: ExplorerSource;
  accounts: { read(addresses: string[], block: number): Promise<Map<string, AccountState>> };
  /** Gets progress and problem lines. None holds a URL, a key or a reply body (C40). */
  log: (line: string) => void;
}

export interface ReplayOptions {
  snapshotBlock: number;
  /** The snapshot block's time in seconds. */
  snapshotTime: number;
  settings: Settings;
  /** Transfers read per claim wallet, oldest first. */
  walletLimit: number;
  /** Transfers read per funding wallet walked through. A few are enough to see one in and one out. */
  hopLimit: number;
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes}m` : `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Progress lines: at the start and end of each phase, and every PROGRESS_EVERY_CALLS explorer calls. */
class Progress {
  readonly #log: (line: string) => void;
  #calls = 0;
  #phase = '';
  #total = 0;
  #done = 0;
  #startedAt = 0;

  constructor(log: (line: string) => void) {
    this.#log = log;
  }

  begin(phase: string, total: number): void {
    this.#phase = phase;
    this.#total = total;
    this.#done = 0;
    this.#startedAt = performance.now();
    this.#log(this.#line());
  }

  step(explorerCall: boolean): void {
    this.#done += 1;
    if (!explorerCall) return;
    this.#calls += 1;
    if (this.#calls % PROGRESS_EVERY_CALLS === 0) this.#log(`${this.#line()}, ${this.#calls.toLocaleString('en-US')} explorer calls so far`);
  }

  end(): void {
    // An empty phase already said "0/0, finished" when it began.
    if (this.#total === 0) return;
    this.#done = this.#total;
    this.#log(this.#line());
  }

  #line(): string {
    const elapsed = performance.now() - this.#startedAt;
    const counts = `${this.#phase}: ${this.#done.toLocaleString('en-US')}/${this.#total.toLocaleString('en-US')}`;
    if (this.#done >= this.#total) return `${counts}, finished in ${duration(elapsed)}`;
    if (this.#done === 0) return `${counts}, time left not known yet`;
    return `${counts}, about ${duration((elapsed / this.#done) * (this.#total - this.#done))} left`;
  }
}

async function inFlight<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, items.length) }, lane));
}

/** The page, or undefined when the explorer could not give it. Anything other than an ExplorerError is a bug and throws. */
async function pageOrNothing(read: () => Promise<TransferPage>): Promise<TransferPage | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ExplorerError) return undefined;
    throw error;
  }
}

function wholeNumber(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`${name} must be a whole number of at least ${min}`);
}

/**
 * Screens claim wallets with code alone, from chain data before the snapshot, and returns one row per distinct wallet
 * in input order: the fixed-check start, the ceiling and the facts.
 *
 * Reads each wallet's oldest transfers, then internal transfers where no external funding was found or where, on external
 * data alone, the wallet swept to an address another claim wallet also swept to, then walks funding back through
 * pass-through wallets one pass at a time, asking for each address once, then reads nonce and
 * code for every claim wallet, funding root and shared destination in one call, then the oldest transfers of each shared
 * destination that could link wallets. A read that fails leaves its facts missing, so the wallet starts on A1 and is
 * held, and the run goes on (C11). Resuming is the sources' job: the real explorer and account readers cache every page.
 *
 * @throws AddressError for a wallet that is not a 0x address, and RangeError for options that are not whole numbers,
 * both before any read.
 */
export async function runReplay(wallets: string[], opts: ReplayOptions, deps: ReplayDeps): Promise<ReplayRow[]> {
  wholeNumber('snapshotBlock', opts.snapshotBlock, 0);
  wholeNumber('snapshotTime', opts.snapshotTime, 0);
  wholeNumber('walletLimit', opts.walletLimit, 1);
  wholeNumber('hopLimit', opts.hopLimit, 1);
  const { snapshotBlock, settings, walletLimit, hopLimit } = opts;
  const claimWallets = [...new Set(wallets.map((wallet) => parseAddress(wallet).toLowerCase()))];
  const isClaimWallet = new Set(claimWallets);
  const progress = new Progress(deps.log);
  const data = new Map<string, AddressData>();

  progress.begin('wallets', claimWallets.length);
  await inFlight(claimWallets, async (wallet) => {
    const page = await pageOrNothing(() => deps.explorer.oldestTransfers(wallet, snapshotBlock, walletLimit));
    progress.step(true);
    if (page === undefined) deps.log(`wallets: could not read ${wallet}, so its facts stay missing`);
    else data.set(wallet, { external: page });
  });
  progress.end();

  // Judged on external data alone here. Internal inflows only raise what a wallet had received, so they can turn a sweep
  // into a payment but never a payment into a sweep: only a wallet that looks like a sharing sweeper now can be wrong.
  const sweepers = new Set([...sharedDestinations({ wallets: claimWallets, data }).values()].flatMap((senders) => [...senders]));
  const needInternal = claimWallets.filter((wallet) => {
    const walletData = data.get(wallet);
    if (walletData === undefined || walletData.internal !== undefined) return false;
    return sweepers.has(wallet) || fundingTransfer(wallet, walletData).status === 'unknown';
  });
  progress.begin('internal transfers', needInternal.length);
  await inFlight(needInternal, async (wallet) => {
    const page = await pageOrNothing(() => deps.explorer.oldestInternalTransfers(wallet, snapshotBlock, walletLimit));
    progress.step(true);
    const walletData = data.get(wallet);
    if (page === undefined) deps.log(`internal transfers: could not read ${wallet}, so its funding and its sweeps stay in doubt`);
    else if (walletData !== undefined) data.set(wallet, { ...walletData, internal: page });
  });
  progress.end();

  const hopData = new Map<string, AddressData>();
  const tried = new Set<string>();
  const lookup = (address: string) => data.get(address) ?? hopData.get(address);
  let traces = new Map<string, TraceResult>();
  for (let pass = 1; ; pass += 1) {
    traces = new Map(claimWallets.map((wallet) => [wallet, traceFunding(wallet, lookup)]));
    const wanted = new Set<string>();
    for (const trace of traces.values()) {
      if (trace.status === 'needs' && !isClaimWallet.has(trace.address) && !tried.has(trace.address)) wanted.add(trace.address);
    }
    if (wanted.size === 0) break;
    if (pass === MAX_TRACE_PASSES) {
      deps.log(`funding trace: stopped at ${pass} passes with ${wanted.size} addresses unread, so their wallets stay missing a funder`);
      break;
    }
    const addresses = [...wanted];
    for (const address of addresses) tried.add(address);
    progress.begin(`funding trace pass ${pass}`, addresses.length);
    await inFlight(addresses, async (address) => {
      const page = await pageOrNothing(() => deps.explorer.oldestTransfers(address, snapshotBlock, hopLimit));
      progress.step(true);
      if (page === undefined) deps.log(`funding trace: could not read ${address}, so the wallets it funded stay missing a funder`);
      else hopData.set(address, { external: page });
    });
    progress.end();
  }

  const roots = [...traces.values()].flatMap((trace) => (trace.status === 'done' ? [trace.root] : []));
  deps.log(`funding trace: ${roots.length}/${claimWallets.length} wallets traced to a funding source`);
  const shared = sharedDestinations({ wallets: claimWallets, data });
  const stateAddresses = [...new Set([...claimWallets, ...roots, ...shared.keys()])];
  progress.begin('account states', stateAddresses.length);
  const states = await deps.accounts.read(stateAddresses, snapshotBlock);
  progress.end();

  // Exchanges and contracts never link, so their crowd would cost a read and change nothing.
  const destinations = [...shared.keys()].filter((dest) => ['wallet', 'unknown'].includes(funderKind(states.get(dest))));
  const destinationPages = new Map<string, TransferPage>();
  progress.begin('destination pages', destinations.length);
  await inFlight(destinations, async (dest) => {
    const page = await pageOrNothing(() => deps.explorer.oldestTransfers(dest, snapshotBlock, walletLimit));
    progress.step(true);
    if (page === undefined) deps.log(`destination pages: could not read ${dest}, so the wallets that swept there stay missing a group`);
    else destinationPages.set(dest, page);
  });
  progress.end();

  progress.begin('facts', claimWallets.length);
  const facts = buildReplayFacts({ wallets: claimWallets, snapshotTime: opts.snapshotTime, settings, data, traces, states, destinationPages });
  const rows = claimWallets.map((wallet): ReplayRow => {
    const walletFacts = facts.get(wallet);
    if (walletFacts === undefined) throw new Error('the facts engine returned no facts for a claim wallet');
    progress.step(false);
    return {
      wallet,
      start: computeStart(walletFacts, settings),
      ceiling: computeCeiling(walletFacts, settings).ceiling,
      facts: walletFacts,
    };
  });
  progress.end();
  return rows;
}

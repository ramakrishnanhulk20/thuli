import { firstActivityTime, olderChain, type AccountState, type Address, type Facts, type ScreenedChain, type Transfer } from '@thuli/core';
import { chainClient, collectBasicFacts, MAX_FUNDING_PAGES, readTransferPages, type FactSources } from '../facts/basic.ts';
import { accountStateAtFinalizedBlock } from '../screen/single.ts';
import type { WorkerConfig } from './config.ts';

/** Transaction pages the picker reads per chain, oldest first, looking for the first activity (C41). */
export const PICK_TRANSACTION_PAGES = 3;
/**
 * How long the picker waits for both chains. It leaves 80 of SCREEN_TIME_LIMIT_MS's 120 seconds for the full facts read
 * on the chosen chain and the model (C41).
 */
export const PICK_TIME_LIMIT_MS = 40_000;

/**
 * One chain's first activity time in seconds, null when the wallet has none there, and the finalized block it was read
 * at; or 'unknown' when it could not be settled.
 */
export type FirstActivity = { time: number | null; block: number } | 'unknown';

/** What a campaign screening reads on one chain. */
export interface ChainReader {
  /** The wallet's first activity at the chain's latest finalized block, firstActivityOn in production. Never throws. */
  firstActivity(wallet: Address, signal?: AbortSignal): Promise<FirstActivity>;
  /** The wallet's free facts at this block of the chain, collectBasicFacts in production. */
  facts(wallet: Address, block: number): Promise<Facts>;
  /** An address's nonce and code at the chain's latest finalized block, accountStateAtFinalizedBlock in production. */
  accountState(address: Address): Promise<AccountState>;
}

export type ChainReaders = Readonly<Record<ScreenedChain, ChainReader>>;

/** What pickChain settled: the chain to screen on, null when neither chain has activity, and the block each was read at. */
export interface PickedChain {
  chain: ScreenedChain | null;
  blocks: Readonly<Record<ScreenedChain, number>>;
}

/**
 * The wallet's first activity on one chain at that chain's latest finalized block: core's firstActivityTime over the
 * transaction rows and internal rows read, the very rule wallet age uses, so the pick and the age mean one thing (C20).
 * Transactions are read oldest first, page by page, until the rows read date the wallet, the list ends, or
 * PICK_TRANSACTION_PAGES pages are read. Internal transfers cannot be sorted, so they are read to the end, at most
 * MAX_FUNDING_PAGES pages. Only rows at or before the finalized block count, by the rule the full facts read uses.
 *
 * @returns the time, or null when every row was read and none dates the wallet, with the block; 'unknown' when
 *   transaction pages are left past the cap with nothing found, internal pages are left past theirs, or any read fails,
 *   times out, is out of shape or is stopped by the signal. Doubt is never read as no history (C11). Never throws, and
 *   nothing it read reaches a log (C40).
 */
export async function firstActivityOn(chain: ScreenedChain, wallet: Address, sources: FactSources, signal?: AbortSignal): Promise<FirstActivity> {
  // One failed list stops the other, so a chain that cannot be settled costs no more pages.
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted === true) return 'unknown';
    const head = await chainClient(chain, sources.rpcUrl).getBlock({ blockTag: 'finalized' });
    const block = Number(head.number);
    if (!Number.isSafeInteger(block) || block < 0) return 'unknown';
    const dated = (transfers: readonly Transfer[]) => firstActivityTime(wallet, { external: { transfers: [...transfers], complete: false } }) !== null;
    const read = (list: 'transactions' | 'internal-transactions', options: { maxPages: number; oldestFirst?: boolean; enough?: typeof dated }) =>
      readTransferPages(wallet, list, block, sources, { ...options, signal: stop.signal }).catch((error: unknown) => {
        stop.abort();
        throw error;
      });
    const [external, internal] = await Promise.all([
      read('transactions', { maxPages: PICK_TRANSACTION_PAGES, oldestFirst: true, enough: dated }),
      read('internal-transactions', { maxPages: MAX_FUNDING_PAGES }),
    ]);
    if (!internal.complete) return 'unknown';
    // Read oldest first, so once a transaction row dates the wallet no later page can hold an earlier one.
    if (!external.complete && firstActivityTime(wallet, { external }) === null) return 'unknown';
    return { time: firstActivityTime(wallet, { external, internal }), block };
  } catch {
    return 'unknown';
  } finally {
    stop.abort();
    signal?.removeEventListener('abort', onAbort);
  }
}

class ChainUnread extends Error {
  override name = 'ChainUnread';
}

const isBlock = (block: number) => Number.isSafeInteger(block) && block >= 0;

/**
 * The chain an ask is screened on: both chains' first activity, read at the same time, then core's olderChain, so the
 * chain the wallet was active on first wins, activity on one chain only picks that one, and an exact tie is Ethereum.
 * 'unknown' as soon as either chain is 'unknown', when a reader throws or gives a time olderChain refuses, and after
 * PICK_TIME_LIMIT_MS, so an ask is never decided from one chain while the other could not be read (C11, C41). Every
 * read still running when the pick ends is told to stop through its signal, as it is when `signal` aborts.
 *
 * @returns the chain, or null when neither chain has any activity, with the finalized block each chain was read at, so
 *   the full facts are read at the very block the pick was made at (C.2 standard 2); or 'unknown'. Never throws.
 */
export async function pickChain(
  wallet: Address,
  deps: Readonly<Record<ScreenedChain, Pick<ChainReader, 'firstActivity'>>>,
  signal?: AbortSignal,
): Promise<PickedChain | 'unknown'> {
  if (signal?.aborted === true) return 'unknown';
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let end: () => void = () => undefined;
  const cut = new Promise<'unknown'>((resolve) => {
    end = () => {
      stop.abort();
      resolve('unknown');
    };
    timer = setTimeout(end, PICK_TIME_LIMIT_MS);
  });
  const onAbort = () => end();
  signal?.addEventListener('abort', onAbort, { once: true });
  const readOne = async (chain: ScreenedChain) => {
    const read = await deps[chain].firstActivity(wallet, stop.signal);
    if (read === 'unknown' || !isBlock(read.block)) throw new ChainUnread(chain);
    return read;
  };
  const both = Promise.all([readOne('ethereum'), readOne('base')]).then(
    ([ethereum, base]): PickedChain => ({
      chain: olderChain({ ethereum: ethereum.time, base: base.time }),
      blocks: { ethereum: ethereum.block, base: base.block },
    }),
  );
  try {
    return await Promise.race([both, cut]);
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
    stop.abort();
    signal?.removeEventListener('abort', onAbort);
  }
}

/** The production reader for one chain on its sources: firstActivityOn, collectBasicFacts and accountStateAtFinalizedBlock. */
export function chainReader(chain: ScreenedChain, sources: FactSources): ChainReader {
  return {
    firstActivity: (wallet, signal) => firstActivityOn(chain, wallet, sources, signal),
    facts: (wallet, block) => collectBasicFacts(wallet, { chain, block }, sources),
    accountState: accountStateAtFinalizedBlock(sources, chain),
  };
}

/** Said once at start when Base history is off. It names the setting and no value (C40). */
export const BASE_HISTORY_OFF = 'screen: Base history is off because BLOCKSCOUT_API_KEY is not set, so every ask is screened on Ethereum only';

/**
 * The campaign screening's reader per chain, from the worker's settings: Ethereum on ETH_RPC_URL and BLOCKSCOUT_ETH_API,
 * Base on BASE_RPC_URL and BLOCKSCOUT_BASE_API. The Blockscout key goes to Base's Blockscout only: Ethereum's source is
 * read without one, exactly as before. With no key Base history is off: nothing is returned, every ask is screened on
 * Ethereum as before, and BASE_HISTORY_OFF is logged. The worker calls this once, at start.
 */
export function screenChains(
  config: Pick<WorkerConfig, 'ethRpcUrl' | 'blockscoutApi' | 'baseRpcUrl' | 'blockscoutBaseApi' | 'blockscoutApiKey'>,
  log: (line: string) => void,
): ChainReaders | undefined {
  if (config.blockscoutApiKey === null) {
    log(BASE_HISTORY_OFF);
    return undefined;
  }
  return {
    ethereum: chainReader('ethereum', { rpcUrl: config.ethRpcUrl, blockscoutApi: config.blockscoutApi }),
    base: chainReader('base', { rpcUrl: config.baseRpcUrl, blockscoutApi: config.blockscoutBaseApi, apiKey: config.blockscoutApiKey }),
  };
}

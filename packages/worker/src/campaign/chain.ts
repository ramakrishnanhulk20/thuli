import {
  firstActivityTime,
  olderChain,
  SCREENED_CHAIN_NAME,
  SCREENED_CHAINS,
  type AccountState,
  type Address,
  type Facts,
  type ScreenedChain,
} from '@thuli/core';
import { chainClient, collectBasicFacts, type FactSources } from '../facts/basic.ts';
import {
  finalizedBlock,
  firstUsedBlock,
  HistoryError,
  historyClientOf,
  historyProbe,
  rpcHistory,
  transfersInBlock,
  type HistoryClient,
  type HistoryLack,
} from '../facts/rpcHistory.ts';
import { accountStateAtFinalizedBlock } from '../screen/single.ts';
import type { WorkerConfig } from './config.ts';

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
  /** The wallet's first activity at the chain's latest finalized block, rpcFirstActivity in production. Never throws. */
  firstActivity(wallet: Address, signal?: AbortSignal): Promise<FirstActivity>;
  /** The wallet's free facts at this block of the chain, collectBasicFacts on rpcHistory in production. */
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

// The picker's signal stops a search between steps: each read already sent still ends by its own 15 second timeout.
function stoppedBy(client: HistoryClient, signal: AbortSignal): HistoryClient {
  return {
    request: (method, params) => (signal.aborted ? Promise.reject(new HistoryError('the read was stopped')) : client.request(method, params)),
  };
}

/**
 * The wallet's first activity on one chain at that chain's latest finalized block, read with plain RPC calls:
 * firstUsedBlock finds the first block where its sent count or balance is above zero, and transfersInBlock reads that
 * block's transfers. The time is core's firstActivityTime over those rows, the very rule wallet age uses over the same
 * rows in rpcHistory, so the pick and the age mean one thing (C20).
 *
 * @returns the time with the block, null for a wallet never used there; 'unknown' when the first block holds no
 *   qualifying transfer (money that came with no transaction, such as a staking withdrawal or a block reward, or only a
 *   failed one), or when any read fails, is out of shape, meets a trace kind it does not read, or is stopped by the
 *   signal. Doubt is never read as no history (C11). Never throws, and nothing it read reaches a log (C40).
 */
export async function rpcFirstActivity(client: HistoryClient, wallet: Address, signal?: AbortSignal): Promise<FirstActivity> {
  try {
    if (signal?.aborted === true) return 'unknown';
    const reads = signal === undefined ? client : stoppedBy(client, signal);
    const block = await finalizedBlock(reads);
    const used = await firstUsedBlock(reads, wallet, block);
    if (used === null) return { time: null, block };
    const rows = await transfersInBlock(reads, wallet, used);
    const time = firstActivityTime(wallet, { external: { transfers: rows.external, complete: false }, internal: { transfers: rows.internal, complete: false } });
    return time === null ? 'unknown' : { time, block };
  } catch {
    return 'unknown';
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

/**
 * The production reader for one chain on its RPC alone: rpcFirstActivity for the pick, collectBasicFacts on rpcHistory
 * for the facts, and accountStateAtFinalizedBlock, every call with the fact reads' 15 second timeout and one retry (C41).
 */
export function chainReader(chain: ScreenedChain, sources: Pick<FactSources, 'rpcUrl'>): ChainReader {
  const client = historyClientOf(chainClient(chain, sources.rpcUrl));
  return {
    firstActivity: (wallet, signal) => rpcFirstActivity(client, wallet, signal),
    facts: (wallet, block) => collectBasicFacts(wallet, { chain, block }, { rpcUrl: sources.rpcUrl, history: (address, at) => rpcHistory(client, address, at) }),
    accountState: accountStateAtFinalizedBlock(sources, chain),
  };
}

const RPC_SETTING: Readonly<Record<ScreenedChain, string>> = { ethereum: 'ETH_RPC_URL', base: 'BASE_RPC_URL' };
const LACK_WORDS: Readonly<Record<HistoryLack, string>> = { 'old state': 'serves no old state', traces: 'serves no traces', 'no answer': 'gave no answer' };

/**
 * The one line said at start when RPC history is off: each chain whose endpoint failed the probe, by name and setting,
 * and what it lacks. Fixed words only, never an address or a value (C40).
 */
export function historyOffLine(lacks: Readonly<Partial<Record<ScreenedChain, HistoryLack>>>): string {
  const reasons = SCREENED_CHAINS.flatMap((chain) => {
    const lack = lacks[chain];
    return lack === undefined ? [] : [`${SCREENED_CHAIN_NAME[chain]}'s endpoint (${RPC_SETTING[chain]}) ${LACK_WORDS[lack]}`];
  });
  return `screen: RPC history is off because ${reasons.join(' and ')}, so every ask is screened on Ethereum only`;
}

/**
 * The campaign screening's reader per chain, Ethereum on ETH_RPC_URL and Base on BASE_RPC_URL, read with plain RPC calls.
 * Both endpoints are probed at once with historyProbe: old state and traces. RPC history is on only when both pass;
 * otherwise nothing is returned, every ask is screened on Ethereum through the explorer reader as before, and
 * historyOffLine is logged once. The worker calls this once, at start. Never throws.
 */
export async function screenChains(config: Pick<WorkerConfig, 'ethRpcUrl' | 'baseRpcUrl'>, log: (line: string) => void): Promise<ChainReaders | undefined> {
  const urls: Readonly<Record<ScreenedChain, string>> = { ethereum: config.ethRpcUrl, base: config.baseRpcUrl };
  const probes = await Promise.all(SCREENED_CHAINS.map(async (chain) => [chain, await historyProbe(historyClientOf(chainClient(chain, urls[chain])))] as const));
  const lacks: Partial<Record<ScreenedChain, HistoryLack>> = {};
  for (const [chain, probe] of probes) if (!probe.ok) lacks[chain] = probe.lacks;
  if (Object.keys(lacks).length > 0) {
    log(historyOffLine(lacks));
    return undefined;
  }
  return { ethereum: chainReader('ethereum', { rpcUrl: urls.ethereum }), base: chainReader('base', { rpcUrl: urls.base }) };
}

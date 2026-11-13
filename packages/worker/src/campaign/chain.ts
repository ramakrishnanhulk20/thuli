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
import { chainClient, collectBasicFacts, SCREENED_CHAIN_ID, type FactSources } from '../facts/basic.ts';
import {
  blockTime,
  callBudget,
  finalizedBlock,
  firstUsedBlock,
  HistoryError,
  historyClientOf,
  historyProbe,
  MAX_READ_CALLS,
  rpcHistory,
  transfersInBlock,
  type HistoryClient,
  type HistoryLack,
} from '../facts/rpcHistory.ts';
import { accountStateAtFinalizedBlock, factsAtFinalizedBlock } from '../screen/single.ts';
import { WorkerConfigError, type WorkerConfig } from './config.ts';

/**
 * How long the picker waits for both chains. It leaves 80 of SCREEN_TIME_LIMIT_MS's 120 seconds for the full facts read
 * on the chosen chain and the model (C41).
 */
export const PICK_TIME_LIMIT_MS = 40_000;

/**
 * One chain's first activity, with the finalized block it was read at: its time in seconds, or null when the wallet has
 * none there; or `notBefore`, the time of the first block the wallet was used in, when that block was found but could
 * not be read as a dated transfer, so its first activity there is no earlier than that; or 'unknown' when nothing could
 * be settled.
 */
export type FirstActivity = { time: number | null; block: number } | { notBefore: number; block: number } | 'unknown';

/** What a campaign screening reads on one chain. */
export interface ChainReader {
  /** The wallet's first activity at the chain's latest finalized block, rpcFirstActivity in production. Never throws. */
  firstActivity(wallet: Address, signal?: AbortSignal): Promise<FirstActivity>;
  /**
   * The wallet's free facts at this block of the chain, collectBasicFacts on rpcHistory in production. It rejects when a
   * read failed, rather than give facts with the unread ones marked missing: the screening tries again later, so an
   * outage or a history this reader cannot read is never stored as a hold (C11). `signal` stops the reads still to send.
   */
  facts(wallet: Address, block: number, signal?: AbortSignal): Promise<Facts>;
  /** An address's nonce and code at the chain's latest finalized block, accountStateAtFinalizedBlock in production. */
  accountState(address: Address): Promise<AccountState>;
}

export type ChainReaders = Readonly<Record<ScreenedChain, ChainReader>>;

/** What pickChain settled: the chain to screen on, null when neither chain has activity, and the block each was read at. */
export interface PickedChain {
  chain: ScreenedChain | null;
  blocks: Readonly<Record<ScreenedChain, number>>;
}

// A read's signal stops it between calls here, whatever the client under it does with a signal, and is handed on so the
// client can drop a call still waiting to be sent. A call already sent ends by its own 15 second timeout.
function stoppedBy(client: HistoryClient, signal: AbortSignal): HistoryClient {
  return {
    request: (method, params) => (signal.aborted ? Promise.reject(new HistoryError('the read was stopped')) : client.request(method, params, signal)),
  };
}

/**
 * The wallet's first activity on one chain at that chain's latest finalized block, read with plain RPC calls:
 * firstUsedBlock finds the first block where its sent count or balance is above zero, and transfersInBlock reads that
 * block's transfers. The time is core's firstActivityTime over those rows, the very rule wallet age uses over the same
 * rows in rpcHistory, so the pick and the age mean one thing (C20).
 *
 * The first used block's own time bounds the first activity from below whatever that block holds: before it the wallet
 * had sent nothing and held nothing, and a transfer that counts either raises its balance or is one it sent. So when the
 * block cannot be read as a dated transfer, the answer is that time as `notBefore` rather than 'unknown'. Anyone can
 * fill a wallet's first block on a chain it never used with more calls than this reader takes, for cents; with the
 * bound, that stops the pick only where that chain could be the older one (C15).
 *
 * @returns the time with the block, or null for a wallet never used there; `notBefore` with the block when the first
 *   used block holds no qualifying transfer (money that came with no transaction, such as a staking withdrawal or a
 *   block reward, or only a failed one) or its transfers could not be read; 'unknown' when the finalized block, the
 *   first used block or its time could not be read, or the signal stopped the read first. Doubt is never read as no
 *   history (C11). Never throws, and nothing it read reaches a log (C40).
 */
export async function rpcFirstActivity(client: HistoryClient, wallet: Address, signal?: AbortSignal): Promise<FirstActivity> {
  try {
    if (signal?.aborted === true) return 'unknown';
    const reads = signal === undefined ? client : stoppedBy(client, signal);
    const block = await finalizedBlock(reads);
    const used = await firstUsedBlock(reads, wallet, block);
    if (used === null) return { time: null, block };
    const notBefore = await blockTime(reads, used);
    try {
      const rows = await transfersInBlock(reads, wallet, used);
      const time = firstActivityTime(wallet, { external: { transfers: rows.external, complete: false }, internal: { transfers: rows.internal, complete: false } });
      if (time !== null) return { time, block };
    } catch {
      // The block's transfers could not be read. Its time still bounds the first activity, so the bound is the answer.
    }
    return { notBefore, block };
  } catch {
    return 'unknown';
  }
}

class ChainUnread extends Error {
  override name = 'ChainUnread';
}

const isBlock = (block: number) => Number.isSafeInteger(block) && block >= 0;

type ChainRead = Exclude<FirstActivity, 'unknown'>;

/**
 * The older chain from one read per chain, by core's olderChain. When one chain holds only a bound, the other wins only
 * if olderChain picks it against the bound itself: the bounded chain's first activity is at the bound or later, and
 * olderChain's answer can then only stay the same, the tie that goes to Ethereum included. 'unknown' when both chains
 * hold only a bound, when the other chain was never used (the bounded chain is then the only one with a history, and
 * it could not be read), or when the bounded chain could still be the older.
 *
 * @throws RangeError, from olderChain, for a time or a bound that is not a finite number of 0 or more.
 */
export function olderOf(first: Readonly<Record<ScreenedChain, ChainRead>>): ScreenedChain | null | 'unknown' {
  const { ethereum, base } = first;
  if ('time' in ethereum && 'time' in base) return olderChain({ ethereum: ethereum.time, base: base.time });
  if ('time' in ethereum) {
    if (ethereum.time === null || !('notBefore' in base)) return 'unknown';
    return olderChain({ ethereum: ethereum.time, base: base.notBefore }) === 'ethereum' ? 'ethereum' : 'unknown';
  }
  if ('time' in base) {
    if (base.time === null || !('notBefore' in ethereum)) return 'unknown';
    return olderChain({ ethereum: ethereum.notBefore, base: base.time }) === 'base' ? 'base' : 'unknown';
  }
  return 'unknown';
}

/**
 * The chain an ask is screened on: both chains' first activity, read at the same time, then olderOf, so the chain the
 * wallet was active on first wins, activity on one chain only picks that one, and an exact tie is Ethereum. A chain
 * whose first block could not be read gives only a bound, and the other chain is picked only when it is older than
 * that bound. 'unknown' as soon as either chain is 'unknown', when a reader throws or gives a time olderChain refuses,
 * when a bound leaves the older chain open, and after PICK_TIME_LIMIT_MS, so an ask is never decided from one chain
 * while the other could still be the older one (C11, C41). Every read still running when the pick ends is told to stop
 * through its signal, as it is when `signal` aborts.
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
  const both = Promise.all([readOne('ethereum'), readOne('base')]).then(([ethereum, base]): PickedChain | 'unknown' => {
    const chain = olderOf({ ethereum, base });
    return chain === 'unknown' ? chain : { chain, blocks: { ethereum: ethereum.block, base: base.block } };
  });
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

const FAILED_READ = 'a read of the wallet failed, so its facts were not used';

/**
 * The production reader for one chain on its RPC alone: rpcFirstActivity for the pick, collectBasicFacts on rpcHistory
 * for the facts, and accountStateAtFinalizedBlock, every call with the fact reads' 15 second timeout and one retry (C41).
 * Each first-activity read and each facts read may ask for MAX_READ_CALLS history calls at most, and the facts read's
 * own count, code and block reads are three more (C49). A facts read in which any read failed rejects in fixed words.
 */
export function chainReader(chain: ScreenedChain, sources: Pick<FactSources, 'rpcUrl'>): ChainReader {
  const client = historyClientOf(chainClient(chain, sources.rpcUrl));
  return {
    firstActivity: (wallet, signal) => rpcFirstActivity(callBudget(client, MAX_READ_CALLS), wallet, signal),
    facts: async (wallet, block, signal) => {
      const reads = callBudget(signal === undefined ? client : stoppedBy(client, signal), MAX_READ_CALLS);
      let failed = false;
      const facts = await collectBasicFacts(wallet, { chain, block }, {
        rpcUrl: sources.rpcUrl,
        history: (address, at) => rpcHistory(reads, address, at),
        onFailedRead: () => {
          failed = true;
        },
      });
      if (failed) throw new HistoryError(FAILED_READ);
      return facts;
    },
    accountState: accountStateAtFinalizedBlock(sources, chain),
  };
}

/**
 * The Ethereum reader of a worker whose RPC history is off: the single-wallet screening's explorer reader, except that a
 * facts read in which any read failed rejects in fixed words, as chainReader's does. The campaign can try an ask again
 * later, so here too an outage is never stored as a hold (C11). The paid check, which must answer at once, keeps
 * factsAtFinalizedBlock and its facts marked missing.
 */
export function ethereumFacts(sources: FactSources): (wallet: Address) => Promise<Facts> {
  return async (wallet) => {
    let failed = false;
    const read = factsAtFinalizedBlock({
      ...sources,
      onFailedRead: () => {
        failed = true;
      },
    });
    const facts = await read(wallet);
    if (failed) throw new HistoryError(FAILED_READ);
    return facts;
  };
}

const RPC_SETTING: Readonly<Record<ScreenedChain, string>> = { ethereum: 'ETH_RPC_URL', base: 'BASE_RPC_URL' };
const LACK_WORDS: Readonly<Record<HistoryLack, string>> = {
  chain: "did not answer with that chain's id",
  'old state': 'serves no old state',
  traces: 'serves no traces',
  'no answer': 'gave no answer',
};

type Lacks = Readonly<Partial<Record<ScreenedChain, HistoryLack>>>;

// Each chain whose endpoint lacks one of `kinds`, by name and setting, with what it lacks. Fixed words only (C40).
function lackWords(lacks: Lacks, kinds: readonly HistoryLack[]): string {
  return SCREENED_CHAINS.flatMap((chain) => {
    const lack = lacks[chain];
    return lack === undefined || !kinds.includes(lack) ? [] : [`${SCREENED_CHAIN_NAME[chain]}'s endpoint (${RPC_SETTING[chain]}) ${LACK_WORDS[lack]}`];
  }).join(' and ');
}

const EVERY_LACK: readonly HistoryLack[] = ['chain', 'old state', 'traces', 'no answer'];

/**
 * The one line said at start when RPC history is off: each chain whose endpoint failed the probe, by name and setting,
 * and what it lacks. Fixed words only, never an address or a value (C40).
 */
export function historyOffLine(lacks: Lacks): string {
  return `screen: RPC history is off because ${lackWords(lacks, EVERY_LACK)}, so every ask is screened on Ethereum only, and a wallet with no Ethereum history is not decided`;
}

/** Said once at start when both endpoints passed the probe. */
export const HISTORY_ON = 'screen: RPC history is on, so every ask is screened on Ethereum or Base, whichever the wallet was active on first';

/**
 * Waits between probes of an endpoint that gave no answer at start, in milliseconds: 52 seconds in all, on top of each
 * call's own resends. After the last, the worker does not start.
 */
export const PROBE_WAITS_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000];

/**
 * The campaign screening's reader per chain, Ethereum on ETH_RPC_URL and Base on BASE_RPC_URL, read with plain RPC calls.
 * Both endpoints are probed at once with historyProbe: the chain id, old state and traces. RPC history is on only when
 * both pass; then HISTORY_ON is logged. When an endpoint answered and does not serve old state or traces, nothing is
 * returned, every ask is screened on Ethereum through the explorer reader, and historyOffLine is logged.
 *
 * What an endpoint serves is a property of the endpoint that was configured; whether it answered just now is not. So an
 * endpoint that gave no answer is probed again after each of PROBE_WAITS_MS and never chooses the mode: one blip at start
 * would otherwise leave every ask of this process screened on Ethereum alone (C60). The worker calls this once, at start.
 *
 * @throws WorkerConfigError, in fixed words with no address or value (C40), when an endpoint names another chain's id,
 *   or still gives no answer after the last wait.
 */
export async function screenChains(
  config: Pick<WorkerConfig, 'ethRpcUrl' | 'baseRpcUrl'>,
  log: (line: string) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<ChainReaders | undefined> {
  const urls: Readonly<Record<ScreenedChain, string>> = { ethereum: config.ethRpcUrl, base: config.baseRpcUrl };
  const clients: Readonly<Record<ScreenedChain, HistoryClient>> = {
    ethereum: historyClientOf(chainClient('ethereum', urls.ethereum), sleep),
    base: historyClientOf(chainClient('base', urls.base), sleep),
  };
  for (let attempt = 0; ; attempt += 1) {
    const probes = await Promise.all(SCREENED_CHAINS.map(async (chain) => [chain, await historyProbe(clients[chain], SCREENED_CHAIN_ID[chain])] as const));
    const lacks: Partial<Record<ScreenedChain, HistoryLack>> = {};
    for (const [chain, probe] of probes) if (!probe.ok) lacks[chain] = probe.lacks;
    const wrongChain = lackWords(lacks, ['chain']);
    if (wrongChain !== '') throw new WorkerConfigError(`${wrongChain}, so the worker did not start. Set it to an endpoint of that chain.`);
    const unanswered = lackWords(lacks, ['no answer']);
    if (unanswered === '') {
      if (Object.keys(lacks).length > 0) {
        log(historyOffLine(lacks));
        return undefined;
      }
      log(HISTORY_ON);
      return { ethereum: chainReader('ethereum', { rpcUrl: urls.ethereum }), base: chainReader('base', { rpcUrl: urls.base }) };
    }
    const wait = PROBE_WAITS_MS[attempt];
    if (wait === undefined) throw new WorkerConfigError(`${unanswered} at start, so the worker did not start. Start it again once the endpoint answers.`);
    log(`screen: ${unanswered} at start; asking again in ${wait / 1000} s`);
    await sleep(wait);
  }
}

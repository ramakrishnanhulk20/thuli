import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import {
  computeCeiling,
  computeStart,
  Facts,
  holdForReview,
  parseAddress,
  type AccountState,
  type Address,
  type FactName,
  type Outcome,
  type Settings,
  type Start,
} from '@thuli/core';
import { collectBasicFacts, REQUEST_TIMEOUT_MS, type FactSources } from '../facts/basic.ts';
import { DecisionRecord, decideWallet, OutOfCredit, type DecideDeps } from '../replay/decide.ts';

export const SINGLE_SCOPE = 'one wallet on Ethereum, no claim list';

/**
 * SERV calls one screening may make. decideWallet's own retry rules stop at 12, and this cap holds even if those rules
 * change, so the cost of a screening has a stated ceiling (threat model C26).
 */
export const MAX_SERV_CALLS_PER_SCREEN = 12;

/** Facts and SERV together. Past this the wallet is held and no new SERV call starts (C41). */
export const SCREEN_TIME_LIMIT_MS = 120_000;

/** The only causes a held single screening can carry. Fixed words, so nothing from the chain or SERV reaches them (C34). */
export const SCREEN_CAUSES = Object.freeze({
  facts: 'the wallet facts could not be read',
  noAnswer: 'SERV gave no answer',
  outOfCredit: 'the screening service is out of credit',
  spendCap: 'the spend cap for one screening was reached',
  timeUp: 'the screening ran out of time',
  failed: 'the screening could not finish',
});

/** What a single-wallet screening never checks, listed on every result so a buyer sees it. */
export const NOT_CHECKED = ['group', 'sharedDepositAddress', 'fundingBurst', 'claimPaidToOtherAddress'] as const;
export type NotChecked = (typeof NOT_CHECKED)[number];

const OUT_OF_SCOPE: readonly FactName[] = ['group', 'sharedDepositAddress', 'claimPaidToOtherAddress'];

export interface SingleScreen {
  wallet: Address;
  checkedAt: string;
  decision: DecisionRecord;
  servRequestId: string | null;
  rulebook: 'v2';
  scope: 'one wallet on Ethereum, no claim list';
  notChecked: NotChecked[];
}

/**
 * With no claim list there is no group, funding burst or shared deposit to measure, and no claim has been made yet, so
 * these facts are out of scope, not doubt, and must not hold the wallet on A1. Every other unread fact stays in missing,
 * so a wallet whose age, activity, account type or funder could not be read still holds on A1 (C11).
 */
export function inSingleScope(facts: Facts): Facts {
  return Facts.parse({
    ...facts,
    group: null,
    sharedDepositAddress: null,
    fundingBurst: null,
    claimPaidToOtherAddress: false,
    missing: facts.missing.filter((name) => !OUT_OF_SCOPE.includes(name)),
  });
}

export interface SingleScreenDeps {
  facts(wallet: Address): Promise<Facts>;
  decide: DecideDeps;
  settings: Settings;
}

/** A SERV call refused by the budget. Its message is one of SCREEN_CAUSES. */
class ScreenStopped extends Error {
  override name = 'ScreenStopped';
}

export interface ServBudget {
  deps: DecideDeps;
  /** From now on every SERV call and every retry wait is refused with this cause. */
  stop(cause: string): void;
  calls(): number;
}

/**
 * Wraps the SERV routes so one screening makes at most maxCalls calls, and none after stop(). A refused call throws an
 * error decideWallet does not retry, so the screening ends at once and the caller holds the wallet (C26, C41).
 */
export function servBudget(deps: DecideDeps, maxCalls: number): ServBudget {
  let made = 0;
  let stopped: string | null = null;
  const spend = async <T>(call: () => Promise<T>): Promise<T> => {
    if (stopped !== null) throw new ScreenStopped(stopped);
    if (made >= maxCalls) throw new ScreenStopped(SCREEN_CAUSES.spendCap);
    made += 1;
    return call();
  };
  return {
    deps: {
      viaGraph: (record) => spend(() => deps.viaGraph(record)),
      viaV2: (record) => spend(() => deps.viaV2(record)),
      sleep: async (ms) => {
        if (stopped !== null) throw new ScreenStopped(stopped);
        return deps.sleep(ms);
      },
    },
    stop: (cause) => {
      stopped = cause;
    },
    calls: () => made,
  };
}

const HELD_START: Start = Object.freeze({ outcome: 'hold', rule: 'A1' });

function heldRecord(wallet: Address, cause: string, start: Start = HELD_START, ceiling: Outcome = 'hold'): DecisionRecord {
  const { decision } = holdForReview(cause);
  return DecisionRecord.parse({
    wallet,
    // No route served this wallet. The record still needs a mode, and auto mode would have asked the graph first.
    mode: 'v3',
    fallback: false,
    start,
    ceiling,
    requestId: null,
    rawText: '',
    usage: null,
    verdict: null,
    modelAction: null,
    modelRule: null,
    action: decision.action,
    shareBps: decision.shareBps,
    rule: decision.rule,
    reason: decision.reason,
    citedTxs: decision.citedTxs,
    clampedFrom: null,
    accepted: false,
    cause,
    secondAsk: false,
    firstCause: null,
  });
}

/** A hold with rule A1 and one of SCREEN_CAUSES, for a caller that must answer even when the screening itself failed. */
export function heldScreen(wallet: Address, cause: string, checkedAt: string = new Date().toISOString()): SingleScreen {
  const decision = heldRecord(parseAddress(wallet), cause);
  return {
    wallet: decision.wallet as Address,
    checkedAt,
    decision,
    servRequestId: null,
    rulebook: 'v2',
    scope: SINGLE_SCOPE,
    notChecked: [...NOT_CHECKED],
  };
}

function causeOf(error: unknown): string {
  if (error instanceof ScreenStopped) return error.message;
  if (error instanceof OutOfCredit) return SCREEN_CAUSES.outOfCredit;
  return SCREEN_CAUSES.failed;
}

async function decide(wallet: Address, deps: SingleScreenDeps, budget: ServBudget): Promise<DecisionRecord> {
  let facts: Facts;
  try {
    facts = inSingleScope(Facts.parse(await deps.facts(wallet)));
  } catch {
    return heldRecord(wallet, SCREEN_CAUSES.facts);
  }
  const start = computeStart(facts, deps.settings);
  const { ceiling } = computeCeiling(facts, deps.settings);
  try {
    const record = await decideWallet({ wallet, start, ceiling, facts }, deps.settings, budget.deps, 'auto');
    return record ?? heldRecord(wallet, SCREEN_CAUSES.noAnswer, start, ceiling);
  } catch (error) {
    return heldRecord(wallet, causeOf(error), start, ceiling);
  }
}

/**
 * Screens one wallet on its own: facts from the chain taken into single-wallet scope (inSingleScope), the code's start
 * and ceiling, then SERV in auto mode with the real output checks, so the answer is never above the ceiling (C12, C13).
 *
 * Every failure after the address check ends in a hold with rule A1 and one of SCREEN_CAUSES, never a throw: unreadable
 * facts, no answer from SERV, SERV out of credit, the call cap, the time limit, or any other error. A caller that has
 * already been paid always gets a decision back (C11, C25). At most MAX_SERV_CALLS_PER_SCREEN SERV calls are made
 * (C26), and none start after SCREEN_TIME_LIMIT_MS (C41).
 *
 * @param signal lets a caller whose own time has run out stop the screening early, exactly as the time limit does: the
 *   budget refuses every SERV call and retry wait from then on, and the answer is the time-up hold at once. A call
 *   already sent may still finish, as it may at the time limit. Left out, only the time limit stops it.
 * @throws AddressError for an address that is not 40 hex characters or has a wrong checksum, before any fact is read or
 * any call is made, so a caller can refuse the request before taking payment (C1).
 */
export async function screenOneWallet(wallet: string, deps: SingleScreenDeps, signal?: AbortSignal): Promise<SingleScreen> {
  const address = parseAddress(wallet);
  const checkedAt = new Date().toISOString();
  const budget = servBudget(deps.decide, MAX_SERV_CALLS_PER_SCREEN);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopNow: (() => void) | undefined;
  const timeUp = new Promise<DecisionRecord>((resolve) => {
    stopNow = () => {
      budget.stop(SCREEN_CAUSES.timeUp);
      resolve(heldRecord(address, SCREEN_CAUSES.timeUp));
    };
    timer = setTimeout(stopNow, SCREEN_TIME_LIMIT_MS);
  });
  const onAbort = () => stopNow?.();
  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const decision = await Promise.race([decide(address, deps, budget), timeUp]);
    return {
      wallet: address,
      checkedAt,
      decision,
      servRequestId: decision.requestId,
      rulebook: 'v2',
      scope: SINGLE_SCOPE,
      notChecked: [...NOT_CHECKED],
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Reads one address's nonce and code as of the latest finalized Ethereum block, with the same client, timeout and
 * offchain lookups off as factsAtFinalizedBlock (C38, C41). Empty code comes back as "0x", the raw eth_getCode answer
 * the replay's states hold, so core's funderKind reads both the same way. The single-wallet screening does not call it.
 *
 * @throws the client's error when the block, the nonce or the code cannot be read; nothing is guessed.
 */
export function accountStateAtFinalizedBlock(sources: Pick<FactSources, 'rpcUrl'>): (address: Address) => Promise<AccountState> {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(sources.rpcUrl, { timeout: REQUEST_TIMEOUT_MS, retryCount: 1 }),
    ccipRead: false,
  });
  return async (address) => {
    const block = await client.getBlock({ blockTag: 'finalized' });
    const [nonce, code] = await Promise.all([
      client.getTransactionCount({ address, blockNumber: block.number }),
      client.getCode({ address, blockNumber: block.number }),
    ]);
    return { nonce, code: code ?? '0x' };
  };
}

/**
 * Reads one wallet's free facts as of the latest finalized Ethereum block, so a reorg cannot change what was screened.
 * The block read has the same timeout as every fact read, and offchain lookups are off (C38, C41).
 */
export function factsAtFinalizedBlock(sources: FactSources): (wallet: Address) => Promise<Facts> {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(sources.rpcUrl, { timeout: REQUEST_TIMEOUT_MS, retryCount: 1 }),
    ccipRead: false,
  });
  return async (wallet) => {
    const block = await client.getBlock({ blockTag: 'finalized' });
    return collectBasicFacts(wallet, { chain: 'ethereum', block: Number(block.number) }, sources);
  };
}

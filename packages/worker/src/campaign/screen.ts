import {
  computeCeiling,
  computeStart,
  CURRENT_RULEBOOK,
  Facts,
  funderKind,
  parseAddress,
  toGraphRecord,
  type AccountState,
  type Address,
  type Outcome,
  type ScreenedChain,
  type Settings,
  type Start,
} from '@thuli/core';
import {
  bumpDay,
  CAMPAIGN_SCREENINGS_DAY_COUNTER,
  decideAsk,
  funderLinks,
  getAsk,
  getCampaign,
  MAX_RETRY_SECONDS,
  releaseAsk,
  takeAsk,
  type AskDecision,
  type Db,
  type ReleaseAskResult,
  type TakenAsk,
} from '@thuli/store';
import { decideWallet, OutOfCredit, type DecideDeps, type DecisionRecord } from '../replay/decide.ts';
import { inSingleScope, MAX_SERV_CALLS_PER_SCREEN, SCREEN_CAUSES, SCREEN_TIME_LIMIT_MS, servBudget } from '../screen/single.ts';
import { pickChain, type ChainReaders } from './chain.ts';
import { askFactsOf, campaignFacts, campaignSettings, familyAddressesToCheck } from './facts.ts';
import { checkpoint, waitNoted, type ChainMemory } from './vault.ts';

/** How long one worker holds an ask: above SCREEN_TIME_LIMIT_MS, so a live screening never loses its ask midway. */
export const ASK_LEASE_SECONDS = 300;
/**
 * Screenings one ask gets before it ends held for review (C11). With retryDelaySeconds between them the nine waits come
 * to 3,400 seconds, so a SERV or chain outage of up to about 57 minutes is waited out before any ask is held on it.
 */
export const MAX_ASK_ATTEMPTS = 10;

const FIRST_RETRY_SECONDS = 10;
/** The longest wait retryDelaySeconds gives, so a long outage is checked every ten minutes. */
export const LONGEST_RETRY_SECONDS = 600;

/**
 * How long an ask or a relay waits before its next try, after `attempt` tries: 10 seconds times 3 to the power attempt
 * less one, so 10, 30, 90 and 270, then 600 for every later attempt. Short enough that a blip costs seconds, and capped
 * so a long outage is checked every ten minutes (C41). Pure. An attempt below 1 is read as the first.
 */
export function retryDelaySeconds(attempt: number): number {
  const tries = Number.isSafeInteger(attempt) && attempt > 1 ? attempt : 1;
  let wait = FIRST_RETRY_SECONDS;
  for (let n = 1; n < tries && wait < LONGEST_RETRY_SECONDS; n += 1) wait *= 3;
  return Math.min(wait, LONGEST_RETRY_SECONDS);
}
/**
 * The most family members one screening looks up in the store. Each is a funder no link names as an asker; a family
 * with more is refused rather than counted short, so the screening is tried again and held at the last attempt (C41).
 */
export const MAX_FAMILY_LOOKUPS = 1_000;
/**
 * Tries of one ask on which an answer the output checks refused counts as a failed try, given back with the usual wait,
 * rather than stored as the code-written hold. Measured on the ROBO replay: 6 of 8 sampled stored holds of this kind did
 * not come back when the same wallet was asked again, so a refusal is usually a one-off. From this try on the hold is
 * stored. A retry takes the same ceiling and the same checks, so it can never approve what they would not (C11, C13).
 */
export const REFUSED_ANSWER_TRIES = 3;

/**
 * Model screenings every campaign together may run in one UTC day, counted in the store under
 * CAMPAIGN_SCREENINGS_DAY_COUNTER right before each one calls SERV, so a flood of asks cannot run up the SERV bill:
 * 2,000 is about one dollar of SERV a day at the replay's measured cost per screening (C24, C26). A decision made by
 * code takes no count.
 */
export const CAMPAIGN_SCREENINGS_DAY_MAX = 2_000;

/** Every cause an undecided ask can carry. Fixed words, so nothing from the chain, SERV or the store reaches a log (C40). */
export const CAMPAIGN_SCREEN_CAUSES = Object.freeze({
  ...SCREEN_CAUSES,
  noCampaign: 'no campaign has this id',
  rulebook: 'the campaign names a rulebook other than the current one',
  settings: 'the campaign settings are not valid',
  links: 'the campaign funder records could not be read',
  family: 'the linked family has more funders than one screening looks up',
  refused: 'the answer was refused by the output checks',
  store: 'the decision could not be stored',
  dayBudget: "the day's budget of model screenings is used up",
  dayCounter: "the day's count of model screenings could not be read",
  chains: "the wallet's history could not be read on both chains",
});

const SCREEN_LABEL = 'screen';

export interface ScreenDeps {
  db: Db;
  /**
   * The single-wallet screening's own reader on Ethereum, factsAtFinalizedBlock in production; a stand-in in tests. Used
   * only while Base history is off, with no chains.
   */
  facts(wallet: Address): Promise<Facts>;
  /**
   * An address's nonce and code on Ethereum at a finalized block, accountStateAtFinalizedBlock in production. The first
   * funder is classified from it, because the single-wallet reader leaves every funder's kind unknown. Used only while
   * Base history is off, with no chains.
   */
  accountState(address: Address): Promise<AccountState>;
  /**
   * A reader per screened chain, given only while Base history is on (screenChains, with BLOCKSCOUT_API_KEY set). With
   * it, each ask is screened on the chain pickChain names, its funder's kind read on that same chain, and facts and
   * accountState above are never called. Left out, every ask is screened on Ethereum through them, as before.
   */
  chains?: ChainReaders;
  /** SERV's two routes and the wait between retries, as decideWallet takes them. */
  serv: DecideDeps;
  now(): Date;
  log(line: string): void;
  /** What this process has learned, so a wait that lasts hours, such as a used-up day budget, is logged once. */
  memory: ChainMemory;
}

export type ScreenOutcome =
  | { kind: 'idle' }
  | {
      kind: 'decided';
      campaignId: string;
      wallet: Address;
      action: Outcome;
      rule: string;
      slot: number | null;
      servRequestId: string | null;
    }
  | { kind: 'released'; campaignId: string; wallet: Address; cause: string; status: ReleaseAskResult | null }
  | { kind: 'dropped'; campaignId: string; wallet: Address };

/** A screening that stopped before a decision. Its message is one of CAMPAIGN_SCREEN_CAUSES. */
class ScreenRefused extends Error {
  override name = 'ScreenRefused';
}

const KNOWN_CAUSES: readonly string[] = Object.values(CAMPAIGN_SCREEN_CAUSES);

function causeOf(error: unknown): string {
  if (error instanceof ScreenRefused) return error.message;
  if (error instanceof OutOfCredit) return SCREEN_CAUSES.outOfCredit;
  // The SERV budget's refusal, which decideWallet passes on untouched. Its message is always one of SCREEN_CAUSES.
  if (error instanceof Error && error.name === 'ScreenStopped' && KNOWN_CAUSES.includes(error.message)) return error.message;
  return SCREEN_CAUSES.failed;
}

async function refusedUnless<T>(work: () => Promise<T> | T, cause: string): Promise<T> {
  try {
    return await work();
  } catch {
    throw new ScreenRefused(cause);
  }
}

/**
 * The wallet's facts with its first funder's kind read from the chain rather than left unknown: contract by code, an
 * exchange at HIGH_VOLUME_NONCE and above, otherwise a wallet, through core's funderKind, the very predicate the replay
 * classifies a funding root with (C16, standard 2). `accountState` reads the chain the facts were read on, where the
 * funding was. A funder whose nonce or code cannot be read stops the screening with the facts cause, so the ask is tried
 * again and is never linked or cleared on a guess (C11).
 */
async function withFunderKind(single: Facts, accountState: ScreenDeps['accountState']): Promise<Facts> {
  const funder = single.firstFunder;
  if (funder === null) return single;
  const kind = await refusedUnless(async () => funderKind(await accountState(funder.address)), SCREEN_CAUSES.facts);
  if (kind === 'unknown') throw new ScreenRefused(SCREEN_CAUSES.facts);
  return { ...single, firstFunder: { ...funder, kind } };
}

/** The addresses among `candidates` that asked in this campaign, whatever became of their asks. */
async function askersAmong(db: Db, campaignId: string, candidates: readonly Address[]): Promise<Address[]> {
  if (candidates.length > MAX_FAMILY_LOOKUPS) throw new ScreenRefused(CAMPAIGN_SCREEN_CAUSES.family);
  const askers: Address[] = [];
  for (const candidate of candidates) {
    const found = await refusedUnless(() => getAsk(db, campaignId, candidate), CAMPAIGN_SCREEN_CAUSES.links);
    if (found !== null) askers.push(candidate);
  }
  return askers;
}

// The single-wallet screening's decision path, unchanged: the code's start and ceiling, then decideWallet in auto mode,
// whose output checks run under the current rulebook because nothing here can name another (C12, C13).
async function decideOnce(
  wallet: Address,
  row: { facts: Facts; start: Start; ceiling: Outcome },
  settings: Settings,
  serv: DecideDeps,
): Promise<DecisionRecord> {
  const record = await decideWallet({ wallet, ...row }, settings, serv, 'auto');
  if (record === null) throw new ScreenRefused(SCREEN_CAUSES.noAnswer);
  return record;
}

/** The reason stored for a wallet decided by code because it was never used, while Base history is off. */
export const NEVER_USED_REASON = 'A1: This wallet has never been used on Ethereum, so there is nothing to screen.';
/** The reason stored for a wallet decided by code because it was never used, while Base history is on. */
export const NEVER_USED_ON_EITHER_REASON = 'A1: This wallet has never been used on Ethereum or Base, so there is nothing to screen.';

/**
 * True when the wallet's own facts show it was never used on the chain they were read on: no transaction sent, a plain
 * account with no code, and no first funder in a history that was read, its age known. A failed read leaves the count,
 * the account type or the age unknown, so it is never taken for an empty wallet and goes to the model as before.
 */
function neverUsed(single: Facts): boolean {
  return single.txCountAtSnapshot === 0 && single.accountType === 'eoa' && single.firstFunder === null && single.walletAgeDays !== null;
}

/** The wallet's own facts in single-wallet scope, the chain they were read on and what goes with that chain. */
interface OwnFacts {
  chain: ScreenedChain;
  read: Facts;
  accountState: ScreenDeps['accountState'];
  neverUsedReason: string;
}

/**
 * The wallet's own facts. With Base history off, read on Ethereum through deps.facts as before. With it on, pickChain
 * first: the facts are read on the chain it names, at the very block it read that chain at, and the funder's state on
 * that chain too. When neither chain shows any activity the facts are read on Ethereum, at the picker's Ethereum block,
 * so the never-used test and the stored facts rest on real reads. A chain that could not be read fails the try with
 * CAMPAIGN_SCREEN_CAUSES.chains, through the same retry path as unreadable facts, so an ask is never decided from one
 * chain while the other could not be read (C11).
 */
async function ownFacts(wallet: Address, deps: ScreenDeps, signal: AbortSignal | undefined): Promise<OwnFacts> {
  if (deps.chains === undefined) {
    const read = await refusedUnless(async () => inSingleScope(Facts.parse(await deps.facts(wallet))), SCREEN_CAUSES.facts);
    return { chain: 'ethereum', read, accountState: (address) => deps.accountState(address), neverUsedReason: NEVER_USED_REASON };
  }
  const picked = await pickChain(wallet, deps.chains, signal);
  if (picked === 'unknown') throw new ScreenRefused(CAMPAIGN_SCREEN_CAUSES.chains);
  const chain = picked.chain ?? 'ethereum';
  const reader = deps.chains[chain];
  const read = await refusedUnless(async () => inSingleScope(Facts.parse(await reader.facts(wallet, picked.blocks[chain]))), SCREEN_CAUSES.facts);
  // Called through the reader, never handed on loose, so a reader written as a class keeps its own state.
  return { chain, read, accountState: (address) => reader.accountState(address), neverUsedReason: NEVER_USED_ON_EITHER_REASON };
}

/** A decision for decideAsk, and whether it is the code-written hold the output checks put in place of a refused answer. */
interface Screened {
  decision: AskDecision;
  refused: boolean;
}

async function decisionFor(taken: TakenAsk, deps: ScreenDeps, serv: DecideDeps, signal: AbortSignal | undefined): Promise<Screened> {
  const campaign = await getCampaign(deps.db, taken.campaignId);
  if (campaign === null) throw new ScreenRefused(CAMPAIGN_SCREEN_CAUSES.noCampaign);
  if (campaign.rulebook !== CURRENT_RULEBOOK) throw new ScreenRefused(CAMPAIGN_SCREEN_CAUSES.rulebook);
  const settings = await refusedUnless(() => campaignSettings(campaign), CAMPAIGN_SCREEN_CAUSES.settings);
  const own = await ownFacts(taken.wallet, deps, signal);
  const single = await withFunderKind(own.read, own.accountState);
  const links = await refusedUnless(async () => {
    const all = await funderLinks(deps.db, taken.campaignId);
    return all.filter((link) => parseAddress(link.wallet) !== taken.wallet);
  }, CAMPAIGN_SCREEN_CAUSES.links);
  const askers = await askersAmong(deps.db, taken.campaignId, familyAddressesToCheck(taken.wallet, single, links));
  const { facts, notChecked } = await refusedUnless(
    () => campaignFacts(taken.wallet, single, { links, askers }, settings),
    CAMPAIGN_SCREEN_CAUSES.links,
  );
  const start = computeStart(facts, settings);
  const { ceiling } = computeCeiling(facts, settings);
  // The flat record decideWallet hands SERV, built by the same function from the same facts and start, so the stored
  // record is exactly what the model was given, or would have been. Public facts only: no key, nothing to log (C40).
  const record = toGraphRecord(facts, start);
  // Safe without the model: such a wallet starts on hold under A1 and its ceiling is hold before any model runs, so a
  // SERV answer could only have written the reason. Deciding it here means a free new key costs no SERV run (C24, C26),
  // and the outcome is exactly the code's start and ceiling, which approve nothing (C11, C12). Nothing was refused, so
  // the refused-answer retry does not apply.
  if (neverUsed(single) && start.outcome === 'hold' && start.rule === 'A1' && ceiling === 'hold') {
    const decision: AskDecision = {
      campaignId: taken.campaignId,
      wallet: taken.wallet,
      action: 'hold',
      shareBps: 0,
      rule: 'A1',
      reason: own.neverUsedReason,
      citedTxs: [],
      notChecked,
      facts: askFactsOf(facts, own.chain),
      servRequestId: null,
      record,
    };
    return { decision, refused: false };
  }
  // The day's count is taken in one store statement before SERV is called, so no two workers can pass the ceiling
  // together. A count that cannot be read runs no screening (C11, C24, C26).
  checkpoint(signal, 'counting a model screening');
  let counted: boolean;
  try {
    counted = await bumpDay(deps.db, CAMPAIGN_SCREENINGS_DAY_COUNTER, CAMPAIGN_SCREENINGS_DAY_MAX, deps.now());
  } catch {
    throw new ScreenRefused(CAMPAIGN_SCREEN_CAUSES.dayCounter);
  }
  if (!counted) throw new ScreenRefused(CAMPAIGN_SCREEN_CAUSES.dayBudget);
  waitNoted(deps.memory.waiting, SCREEN_LABEL, undefined);
  const decided = await decideOnce(taken.wallet, { facts, start, ceiling }, settings, serv);
  const decision: AskDecision = {
    campaignId: taken.campaignId,
    wallet: taken.wallet,
    action: decided.action,
    shareBps: decided.shareBps,
    rule: decided.rule,
    reason: decided.reason,
    // Lowercased again here, whatever the checks already did, because the store compares hashes as text (C13).
    citedTxs: decided.citedTxs.map((hash) => hash.toLowerCase()),
    notChecked,
    facts: askFactsOf(facts, own.chain),
    servRequestId: decided.requestId,
    record,
  };
  // Not every answer the checks replace is refused: a burst wallet's partial and a start a shared funder alone cannot
  // hold are the code's own outcomes. Only the hold written in place of a refused answer is.
  return { decision, refused: !decided.accepted && decided.action === 'hold' && decided.rule === 'A1' };
}

/** The whole screening of one ask, held to the single screening's call cap and time limit (C26, C41). */
async function decisionInTime(taken: TakenAsk, deps: ScreenDeps, signal: AbortSignal | undefined): Promise<Screened> {
  const budget = servBudget(deps.serv, MAX_SERV_CALLS_PER_SCREEN);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      budget.stop(SCREEN_CAUSES.timeUp);
      reject(new ScreenRefused(SCREEN_CAUSES.timeUp));
    }, SCREEN_TIME_LIMIT_MS);
  });
  try {
    return await Promise.race([decisionFor(taken, deps, budget.deps, signal), timeUp]);
  } finally {
    clearTimeout(timer);
  }
}

/** Seconds from now to one second past the next UTC midnight, when the day's count starts again, capped at the store's longest wait. */
function secondsPastMidnight(now: Date): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.min(MAX_RETRY_SECONDS, Math.ceil((midnight - now.getTime()) / 1000) + 1);
}

// A used-up day is no fault of the ask: its try is handed back and it waits until just after the next UTC midnight.
// The wait is said once until a screening is counted again, not once for every ask that meets it.
async function waitForTomorrow(taken: TakenAsk, deps: ScreenDeps, signal: AbortSignal | undefined): Promise<ScreenOutcome> {
  checkpoint(signal, 'giving an ask back');
  const cause = CAMPAIGN_SCREEN_CAUSES.dayBudget;
  const wait = secondsPastMidnight(deps.now());
  const status = await releaseAsk(deps.db, taken.campaignId, taken.wallet, deps.now(), MAX_ASK_ATTEMPTS, wait, { refundTry: true });
  if (waitNoted(deps.memory.waiting, SCREEN_LABEL, cause)) deps.log(`screen: waiting, ${cause}; asks are screened again just after midnight UTC`);
  return { kind: 'released', campaignId: taken.campaignId, wallet: taken.wallet, cause, status };
}

async function release(taken: TakenAsk, cause: string, deps: ScreenDeps, signal: AbortSignal | undefined): Promise<ScreenOutcome> {
  checkpoint(signal, 'giving an ask back');
  const wait = retryDelaySeconds(taken.attempts);
  const status = await releaseAsk(deps.db, taken.campaignId, taken.wallet, deps.now(), MAX_ASK_ATTEMPTS, wait);
  const after =
    status === 'queued'
      ? `queued again, next try in ${wait} s`
      : status === 'failed'
        ? `held for review after ${MAX_ASK_ATTEMPTS} attempts`
        : 'already moved on';
  deps.log(`screen ${taken.campaignId} ${taken.wallet}: not decided, ${cause}; ${after}`);
  return { kind: 'released', campaignId: taken.campaignId, wallet: taken.wallet, cause, status };
}

/**
 * Screens the oldest waiting ask of any campaign, through the same path as every other screening (C12): the wallet's
 * own facts from the single-wallet reader taken into single-wallet scope, linked to the campaign's other asks by
 * campaignFacts, the code's start and ceiling, then SERV and the output checks in decideWallet. With Base history on
 * (deps.chains), the facts are read on one chain only, Ethereum or Base, whichever pickChain finds the wallet active on
 * first, and the chain they were read on is stored with them. A wallet whose own facts show it was never used, and
 * whose start and ceiling are both hold under A1, is decided by code with NEVER_USED_REASON, or with Base history on
 * NEVER_USED_ON_EITHER_REASON, and no SERV call, on its first try. Every other screening first takes one count of
 * CAMPAIGN_SCREENINGS_DAY_MAX; when the day is used up the ask is given back, its try handed back, until just after the
 * next UTC midnight, and when the count cannot be read it is given back like any failed try. The decision is stored by
 * decideAsk, which gives an approved ask the next slot while slots are left (C44), with every cited hash lowercase
 * (C13), the public facts it rested on, and, privately, the flat record the model was given or would have been (C40).
 *
 * Nothing but a checked answer becomes a decision. A campaign that is missing or names a rulebook other than
 * CURRENT_RULEBOOK, settings that are not valid, a chain whose history the picker could not settle, facts that cannot
 * be read, no answer from SERV, SERV out of credit, the call cap, the time limit, or a decision the store refuses all
 * give the ask back with releaseAsk: queued again below MAX_ASK_ATTEMPTS, not to be taken before retryDelaySeconds for
 * its attempt has passed, and held for review with rule A1 at it (C11, C41). An answer the checks refuse is a hold with
 * rule A1; on the first REFUSED_ANSWER_TRIES tries of the ask it is given back like a failed try, and from then on it is
 * stored as the hold. No path gives a slot to an ask whose screening failed. The step's signal is checked before every
 * store write, so a step stopped at its limit takes no ask and writes no decision (C41).
 *
 * @returns idle when no ask is waiting; decided with the slot given, if any; released with the fixed cause; dropped
 *   when another worker decided the ask first.
 * @throws StoreError only when the store cannot hand out or give back an ask at all.
 */
export async function screenNextAsk(deps: ScreenDeps, signal?: AbortSignal): Promise<ScreenOutcome> {
  checkpoint(signal, 'taking an ask');
  const taken = await takeAsk(deps.db, deps.now(), ASK_LEASE_SECONDS, MAX_ASK_ATTEMPTS);
  if (taken === null) return { kind: 'idle' };
  let screened: Screened;
  try {
    screened = await decisionInTime(taken, deps, signal);
  } catch (error) {
    const cause = causeOf(error);
    if (cause === CAMPAIGN_SCREEN_CAUSES.dayBudget) return waitForTomorrow(taken, deps, signal);
    return release(taken, cause, deps, signal);
  }
  if (screened.refused && taken.attempts < REFUSED_ANSWER_TRIES) return release(taken, CAMPAIGN_SCREEN_CAUSES.refused, deps, signal);
  const { decision } = screened;
  checkpoint(signal, 'storing a decision');
  let placed: { slot: number | null } | null;
  try {
    placed = await decideAsk(deps.db, decision, deps.now());
  } catch {
    return release(taken, CAMPAIGN_SCREEN_CAUSES.store, deps, signal);
  }
  if (placed === null) {
    deps.log(`screen ${taken.campaignId} ${taken.wallet}: another worker decided this ask first`);
    return { kind: 'dropped', campaignId: taken.campaignId, wallet: taken.wallet };
  }
  const slot = placed.slot === null ? 'no slot' : `slot ${placed.slot}`;
  deps.log(
    `screen ${taken.campaignId} ${taken.wallet}: ${decision.action} under ${decision.rule}, ${slot}, SERV run ${decision.servRequestId ?? 'none'}`,
  );
  return {
    kind: 'decided',
    campaignId: taken.campaignId,
    wallet: taken.wallet,
    action: decision.action,
    rule: decision.rule,
    slot: placed.slot,
    servRequestId: decision.servRequestId,
  };
}

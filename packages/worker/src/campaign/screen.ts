import {
  computeCeiling,
  computeStart,
  CURRENT_RULEBOOK,
  Facts,
  funderKind,
  parseAddress,
  type AccountState,
  type Address,
  type Outcome,
  type Settings,
} from '@thuli/core';
import {
  decideAsk,
  funderLinks,
  getAsk,
  getCampaign,
  releaseAsk,
  takeAsk,
  type AskDecision,
  type Db,
  type ReleaseAskResult,
  type TakenAsk,
} from '@thuli/store';
import { decideWallet, OutOfCredit, type DecideDeps, type DecisionRecord } from '../replay/decide.ts';
import { inSingleScope, MAX_SERV_CALLS_PER_SCREEN, SCREEN_CAUSES, SCREEN_TIME_LIMIT_MS, servBudget } from '../screen/single.ts';
import { askFactsOf, campaignFacts, campaignSettings, familyAddressesToCheck } from './facts.ts';
import { checkpoint } from './vault.ts';

/** How long one worker holds an ask: above SCREEN_TIME_LIMIT_MS, so a live screening never loses its ask midway. */
export const ASK_LEASE_SECONDS = 300;
/**
 * Screenings one ask gets before it ends held for review (C11). With retryDelaySeconds between them the nine waits come
 * to 3,400 seconds, so a SERV or chain outage of up to about 57 minutes is waited out before any ask is held on it.
 */
export const MAX_ASK_ATTEMPTS = 10;

const FIRST_RETRY_SECONDS = 10;
const LONGEST_RETRY_SECONDS = 600;

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
});

export interface ScreenDeps {
  db: Db;
  /** The single-wallet screening's own reader, factsAtFinalizedBlock in production; a stand-in in tests. */
  facts(wallet: Address): Promise<Facts>;
  /**
   * An address's nonce and code on Ethereum at a finalized block, accountStateAtFinalizedBlock in production. The first
   * funder is classified from it, because the single-wallet reader leaves every funder's kind unknown.
   */
  accountState(address: Address): Promise<AccountState>;
  /** SERV's two routes and the wait between retries, as decideWallet takes them. */
  serv: DecideDeps;
  now(): Date;
  log(line: string): void;
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
 * classifies a funding root with (C16, standard 2). A funder whose nonce or code cannot be read stops the screening with
 * the facts cause, so the ask is tried again and is never linked or cleared on a guess (C11).
 */
async function withFunderKind(single: Facts, deps: ScreenDeps): Promise<Facts> {
  const funder = single.firstFunder;
  if (funder === null) return single;
  const kind = await refusedUnless(async () => funderKind(await deps.accountState(funder.address)), SCREEN_CAUSES.facts);
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
async function decideOnce(wallet: Address, facts: Facts, settings: Settings, serv: DecideDeps): Promise<DecisionRecord> {
  const start = computeStart(facts, settings);
  const { ceiling } = computeCeiling(facts, settings);
  const record = await decideWallet({ wallet, start, ceiling, facts }, settings, serv, 'auto');
  if (record === null) throw new ScreenRefused(SCREEN_CAUSES.noAnswer);
  return record;
}

/** A decision for decideAsk, and whether it is the code-written hold the output checks put in place of a refused answer. */
interface Screened {
  decision: AskDecision;
  refused: boolean;
}

async function decisionFor(taken: TakenAsk, deps: ScreenDeps, serv: DecideDeps): Promise<Screened> {
  const campaign = await getCampaign(deps.db, taken.campaignId);
  if (campaign === null) throw new ScreenRefused(CAMPAIGN_SCREEN_CAUSES.noCampaign);
  if (campaign.rulebook !== CURRENT_RULEBOOK) throw new ScreenRefused(CAMPAIGN_SCREEN_CAUSES.rulebook);
  const settings = await refusedUnless(() => campaignSettings(campaign), CAMPAIGN_SCREEN_CAUSES.settings);
  const read = await refusedUnless(async () => inSingleScope(Facts.parse(await deps.facts(taken.wallet))), SCREEN_CAUSES.facts);
  const single = await withFunderKind(read, deps);
  const links = await refusedUnless(async () => {
    const all = await funderLinks(deps.db, taken.campaignId);
    return all.filter((link) => parseAddress(link.wallet) !== taken.wallet);
  }, CAMPAIGN_SCREEN_CAUSES.links);
  const askers = await askersAmong(deps.db, taken.campaignId, familyAddressesToCheck(taken.wallet, single, links));
  const { facts, notChecked } = await refusedUnless(
    () => campaignFacts(taken.wallet, single, { links, askers }, settings),
    CAMPAIGN_SCREEN_CAUSES.links,
  );
  const record = await decideOnce(taken.wallet, facts, settings, serv);
  const decision: AskDecision = {
    campaignId: taken.campaignId,
    wallet: taken.wallet,
    action: record.action,
    shareBps: record.shareBps,
    rule: record.rule,
    reason: record.reason,
    // Lowercased again here, whatever the checks already did, because the store compares hashes as text (C13).
    citedTxs: record.citedTxs.map((hash) => hash.toLowerCase()),
    notChecked,
    facts: askFactsOf(facts),
    servRequestId: record.requestId,
  };
  // Not every answer the checks replace is refused: a burst wallet's partial and a start a shared funder alone cannot
  // hold are the code's own outcomes. Only the hold written in place of a refused answer is.
  return { decision, refused: !record.accepted && record.action === 'hold' && record.rule === 'A1' };
}

/** The whole screening of one ask, held to the single screening's call cap and time limit (C26, C41). */
async function decisionInTime(taken: TakenAsk, deps: ScreenDeps): Promise<Screened> {
  const budget = servBudget(deps.serv, MAX_SERV_CALLS_PER_SCREEN);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      budget.stop(SCREEN_CAUSES.timeUp);
      reject(new ScreenRefused(SCREEN_CAUSES.timeUp));
    }, SCREEN_TIME_LIMIT_MS);
  });
  try {
    return await Promise.race([decisionFor(taken, deps, budget.deps), timeUp]);
  } finally {
    clearTimeout(timer);
  }
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
 * campaignFacts, the code's start and ceiling, then SERV and the output checks in decideWallet. The decision is stored
 * by decideAsk, which gives an approved ask the next slot while slots are left (C44), with every cited hash lowercase
 * (C13) and the public facts it rested on.
 *
 * Nothing but a checked answer becomes a decision. A campaign that is missing or names a rulebook other than
 * CURRENT_RULEBOOK, settings that are not valid, facts that cannot be read, no answer from SERV, SERV out of credit, the
 * call cap, the time limit, or a decision the store refuses all give the ask back with releaseAsk: queued again below
 * MAX_ASK_ATTEMPTS, not to be taken before retryDelaySeconds for its attempt has passed, and held for review with rule
 * A1 at it (C11, C41). An answer the checks refuse is a hold with rule A1; on the first REFUSED_ANSWER_TRIES tries of
 * the ask it is given back like a failed try, and from then on it is stored as the hold. No path gives a slot to an ask
 * whose screening failed. The step's signal is checked before every store write, so a step stopped at its limit takes
 * no ask and writes no decision (C41).
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
    screened = await decisionInTime(taken, deps);
  } catch (error) {
    return release(taken, causeOf(error), deps, signal);
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

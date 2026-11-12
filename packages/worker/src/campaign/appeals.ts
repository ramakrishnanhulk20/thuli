import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import {
  CAMPAIGN_ID,
  isOneLine,
  isPlainText,
  OutcomeSchema,
  parseAddress,
  ReppoPayloadError,
  reppoInput,
  ReppoVerdict,
  SCREENED_CHAINS,
  type Address,
  type GraphRecord,
} from '@thuli/core';
import {
  APPEAL_MAYBE_PAID,
  clearAppealSubmitting,
  countUnclearSubmit,
  getAsk,
  markAppealSubmitting,
  markAppealUnchecked,
  MAX_OWNER_NOTE_CHARS,
  MAX_REPPO_DECISION_CHARS,
  MAX_REPPO_NOTE_CHARS,
  noteAppealEval,
  ownerAppeals,
  recordAppealCheck,
  releaseAppeal,
  settleAppeal,
  settleRefusal,
  StoreError,
  takeAppeal,
  type Db,
  type OwnerAppeal,
  type PublicAsk,
  type ReleaseAppealResult,
  type ReppoConfidence,
  type ReppoRoute,
  type TakenAppeal,
} from '@thuli/store';
import {
  lookUpEvaluation,
  ReppoError,
  ReppoOutOfCredit,
  ReppoRefused,
  ReppoStoppedFirst,
  ReppoUnreachable,
  ReppoUnsendable,
  submitEvaluationOnce,
  type ReppoConnection,
  type ReppoEval,
} from '../reppo/client.ts';
import { identifyingPart } from '../reppo/feedback.ts';
import { LONGEST_RETRY_SECONDS, retryDelaySeconds } from './screen.ts';
import { checkpoint, StepStopped, waitNoted, type ChainMemory } from './vault.ts';

/**
 * How long one worker holds an appeal. The submit always ends inside it: the take, the text and the mark take
 * milliseconds, and the one POST then ends by APPEAL_SUBMIT_DEADLINE_MS, 30 seconds, at the latest, or sooner at the
 * step's own 240 second limit, leaving over 260 seconds of the lease. A second worker can take the appeal only once the
 * lease has run out, when the submit mark already stands, so it counts that submit as unclear and sends again only while
 * the count is below MAX_UNCLEAR_SUBMITS (C23, C41, C56).
 */
export const APPEAL_LEASE_SECONDS = 300;
/** Tries one appeal's outside check gets before it ends unchecked (C41). */
export const APPEAL_MAX_ATTEMPTS = 6;
/**
 * How many submits of one appeal may end unclear, each perhaps charged with no evaluation id to show, before its check
 * is given up as "may have been paid for" (APPEAL_MAYBE_PAID). At 2, one unclear submit is tried once more, so a single
 * dropped connection does not cost an appeal its check, and one check is paid for at most twice (C56).
 */
export const MAX_UNCLEAR_SUBMITS = 2;
/** How long one look-up waits for Reppo, which answers in 30 to 90 seconds; past this the try is given back unfinished. */
export const APPEAL_REPPO_WAIT_MS = 150_000;
/** The deadline of the one POST that submits an appeal; with no retry, it is the whole submit. */
export const APPEAL_SUBMIT_DEADLINE_MS = 30_000;
/** How long an appeal waits after Reppo answered its submit busy (409 or 429), having created nothing. */
export const APPEAL_BUSY_WAIT_SECONDS = 180;
/** How long an appeal waits, its try handed back, when Reppo could not be reached or refused our key (401 or 403). */
export const APPEAL_SERVICE_WAIT_SECONDS = 600;
/** How long a paid check waits between look-ups while Reppo still has its evaluation queued or running. */
export const APPEAL_LOOKUP_WAIT_SECONDS = 300;
const APPEAL_POLL_MS = 5_000;

/** Why the appeal step does nothing, with no Reppo key set. */
export const NO_REPPO_KEY = 'no REPPO_API_KEY is set, so appeals stay queued';

/** Every cause an appeal's check can end or wait on. Fixed words, so nothing from Reppo or the store reaches a log (C40). */
export const APPEAL_CAUSES = Object.freeze({
  noRecord: 'the decision kept no record to send',
  unreadable: 'the decision record could not be turned into the text for the outside check',
  identifying: 'the text for the outside check still held something that could identify the wallet, so nothing was sent',
  outOfCredit: 'the outside check is out of credit',
  unfinished: 'the outside check had not finished',
  failed: 'the outside check could not finish',
  lost: 'the appeal was no longer being checked by this worker',
  busy: 'the outside check was busy and created nothing',
  keptRefusing: 'the outside check kept refusing the submit',
  evaluationFailed: 'the outside check failed',
  unreachable: 'the outside check could not be reached, so nothing was sent',
  keyRefused: 'the outside check refused the key in REPPO_API_KEY',
  stopped: 'the step was stopped before the submit, so nothing was sent',
  unsendable: 'the decision could not be sent to the outside check',
});

const APPEAL_LABEL = 'appeal';
const ROUTES: readonly ReppoRoute[] = ['ship', 'review', 'block'];

/** Reppo as the appeal step uses it: a submit that answers with the id before any wait, and a look-up by that id. */
export interface AppealReppo {
  /** One POST with no retry, ending by its deadline or the signal; throws as submitEvaluationOnce does. */
  submit(input: string, signal?: AbortSignal): Promise<string>;
  /** Waits for one evaluation; never submits. The signal cuts the wait short. */
  lookUp(id: string, signal?: AbortSignal): Promise<ReppoEval>;
}

/** The Reppo credits this process has seen charged for finished checks, for the running total in the log. */
export interface AppealSpend {
  credits: number;
}

export interface AppealDeps {
  db: Db;
  now(): Date;
  log(line: string): void;
  memory: ChainMemory;
  reppo: AppealReppo;
  spend: AppealSpend;
  /** The unclear submits one appeal may have before its check ends; MAX_UNCLEAR_SUBMITS when left out. */
  maxUnclearSubmits?: number;
}

type Where = { campaignId: string; wallet: Address };

export type AppealOutcome =
  | { kind: 'idle' }
  | { kind: 'skipped'; reason: string }
  | (Where & { kind: 'checked'; route: ReppoRoute | null; evalId: string; creditsCharged: number })
  | (Where & { kind: 'unchecked'; cause: string })
  | (Where & { kind: 'released'; cause: string; status: ReleaseAppealResult | null })
  | (Where & { kind: 'dropped'; cause: string });

/** The real Reppo client for the appeal step, with the step's wait and poll interval. */
export function reppoForAppeals(connection: ReppoConnection): AppealReppo {
  const options = { ...connection, pollMs: APPEAL_POLL_MS, timeoutMs: APPEAL_REPPO_WAIT_MS };
  return {
    submit: (input, signal) => submitEvaluationOnce(input, { ...connection, timeoutMs: APPEAL_SUBMIT_DEADLINE_MS, signal }),
    lookUp: (id, signal) =>
      lookUpEvaluation(id, {
        ...options,
        sleep: async (ms) => {
          await wait(ms, undefined, { signal });
        },
      }),
  };
}

/**
 * The text Reppo judges for an appealed decision: the stored record, the appealed action and the ask's reason, through
 * reppoInput, the builder the offline checks used, then identifyingPart over the whole text (C35). It takes only those
 * three fields, so the appellant's own words cannot reach it. Pure.
 *
 * @returns the text, or why nothing may be sent: no record, a record reppoInput cannot read, or something identifying.
 */
export function outsideInput(
  decision: Pick<TakenAppeal, 'record' | 'appealedAction' | 'reason'>,
): { ok: true; input: string } | { ok: false; cause: string; kind?: string } {
  if (decision.record === null) return { ok: false, cause: APPEAL_CAUSES.noRecord };
  let input: string;
  try {
    input = reppoInput(decision.record as GraphRecord, decision.appealedAction, decision.reason);
  } catch (error) {
    return { ok: false, cause: error instanceof ReppoPayloadError ? APPEAL_CAUSES.identifying : APPEAL_CAUSES.unreadable };
  }
  const kind = identifyingPart(input);
  return kind === null ? { ok: true, input } : { ok: false, cause: APPEAL_CAUSES.identifying, kind };
}

/** Reppo's route as one of the three the store keeps, or null for any other value. Pure. */
export function routeFrom(value: unknown): ReppoRoute | null {
  return typeof value === 'string' && (ROUTES as readonly string[]).includes(value) ? (value as ReppoRoute) : null;
}

/**
 * Reppo's note as the store may keep it: cut to MAX_REPPO_NOTE_CHARS, never through a character pair, and kept only when
 * it is still plain text and one line by core's rules, so a link, markup or a line break is never stored or shown, the
 * same rules the store holds it to (C13, C34, C58). Pure.
 */
export function noteFrom(reason: string | null): string | null {
  if (reason === null) return null;
  let cut = reason.slice(0, MAX_REPPO_NOTE_CHARS);
  if (!cut.isWellFormed()) cut = cut.slice(0, -1);
  cut = cut.trim();
  return cut !== '' && isPlainText(cut) && isOneLine(cut) ? cut : null;
}

// Only Thuli's own and the client's errors carry fixed words; anything else is named by a fixed cause (C40).
function causeOf(error: unknown): string {
  if (error instanceof ReppoError || error instanceof StoreError) return error.message;
  return APPEAL_CAUSES.failed;
}

/**
 * Gets one appeal's outside check: the oldest ready appeal from takeAppeal, its decision sent to Reppo once, and Reppo's
 * route and note recorded. The check is advice: nothing here changes an ask (C11).
 *
 * - No stored record, a record reppoInput cannot read, or a text that still holds something identifying: the check ends
 *   unchecked and nothing is sent (C35).
 * - An evaluation id already on the appeal, from a try cut short after its submit: that evaluation is looked up and
 *   nothing is submitted again (C23). A submit begun with no id kept (submitStarted) may have been paid for, so the
 *   store counts it (countUnclearSubmit); once the count reaches the limit, deps.maxUnclearSubmits or else
 *   MAX_UNCLEAR_SUBMITS, the appeal ends unchecked with the store's APPEAL_MAYBE_PAID and is never sent again, and below
 *   it the same run submits again. Every submit goes through markAppealSubmitting first, and only a worker whose mark
 *   landed sends, with one POST and no retry (submitOnce), so a check is submitted with a possible charge and no id to
 *   show at most the limit's number of times, under any cut and with any number of workers (C56).
 * - A failed submit is handled by whose fault it is (afterFailedSubmit): our credit or key, or the outside check busy or
 *   out of reach, waits with its try handed back and ends no appeal; this appeal's own refused request counts its tries;
 *   an input that can never be sent ends at once; anything unclear keeps its mark for the next take to count.
 * - COMPLETED: recordAppealCheck with the route, noteFrom of Reppo's reason, the id, the credits charged and the
 *   verdict's score, decision and confidence, each null when the store would refuse it. A paid check always ends checked,
 *   with route null when Reppo named none Thuli knows or its verdict was out of shape (C23).
 * - A paid check is followed to its result (C56): UNFINISHED is looked up again after APPEAL_LOOKUP_WAIT_SECONDS with
 *   its try handed back (followLater), and the store, not a count of tries, ends it a day after its submit; FAILED ends
 *   it at once with "the outside check failed" (endFailed); a look-up that fails is given back with retryDelaySeconds.
 * - Out of credit: given back with LONGEST_RETRY_SECONDS and its try handed back, said once (C24). A check with no
 *   evaluation id that runs out of tries ends unchecked (C41).
 * Log lines hold ids, routes, counts and fixed words; never the appeal's text, which this step never receives, Reppo's
 * note or a key (C40). The signal is checked before every store write and before the submit (C41), except the writes
 * that undo a submit which sent nothing: the mark taken back, and for a submit stopped before its call, the try handed
 * back too.
 *
 * @returns idle when no appeal is ready; checked, unchecked, released or dropped (another worker or a settle moved it).
 * @throws StepStopped when the signal is aborted, unless the stop came before the submit's call, which hands the try
 *   back and returns released; StoreError only when the store cannot hand out an appeal at all; RangeError, before any
 *   take, when deps.maxUnclearSubmits is not a whole number from 1.
 */
export async function appealNext(deps: AppealDeps, signal?: AbortSignal): Promise<AppealOutcome> {
  const unclearLimit = deps.maxUnclearSubmits ?? MAX_UNCLEAR_SUBMITS;
  // A limit that is not a whole number, NaN among them, would never be reached, so it is refused before any take (C56).
  if (!Number.isInteger(unclearLimit) || unclearLimit < 1) throw new RangeError('maxUnclearSubmits must be a whole number from 1');
  checkpoint(signal, 'taking an appeal');
  const taken = await takeAppeal(deps.db, deps.now(), APPEAL_LEASE_SECONDS, APPEAL_MAX_ATTEMPTS);
  if (taken === null) return { kind: 'idle' };
  const where: Where = { campaignId: taken.campaignId, wallet: taken.wallet };
  const label = `appeal ${taken.campaignId} ${taken.wallet}`;
  try {
    let evalId = taken.reppoEvalId;
    if (evalId === null) {
      // A mark with no id is a submit that may have been charged, and Reppo cannot recognise a text sent twice. The
      // store counts it and takes the mark back; once the count reaches the limit the appeal is never sent again, and
      // ends unchecked but can still be settled. A count already at the limit with no mark, as a stop right after the
      // count leaves it, ends the same way (C23, C56, fail closed).
      let unclear = taken.unclearSubmits;
      if (taken.submitStarted) {
        checkpoint(signal, 'counting an unclear submit');
        unclear = (await countUnclearSubmit(deps.db, where, deps.now())).unclearSubmits;
      }
      if (unclear >= unclearLimit) return await endCheck(deps, taken, APPEAL_MAYBE_PAID, signal, `, after ${plural(unclear, 'unclear submit')}`);
      const built = outsideInput(taken);
      if (!built.ok) return await endCheck(deps, taken, built.cause, signal, built.kind === undefined ? '' : ` (${built.kind})`);
      checkpoint(signal, 'marking an appeal as being sent');
      // The durable mark goes first: of two workers holding this appeal after a lease ran out, only the one whose mark
      // lands may send, and a cut at any later point leaves the mark for the next take to see (C23).
      if (!(await markAppealSubmitting(deps.db, where, deps.now()))) {
        deps.log(`${label}: ${APPEAL_CAUSES.lost}, so nothing was sent`);
        return { kind: 'dropped', ...where, cause: APPEAL_CAUSES.lost };
      }
      const sent = await submitOnce(deps, taken, built.input, signal);
      if (sent.kind === 'ended') return sent.outcome;
      evalId = sent.evalId;
    }
    checkpoint(signal, 'waiting for the outside check');
    const result = await deps.reppo.lookUp(evalId, signal);
    if (result.status === 'COMPLETED') return await recordCheck(deps, taken, evalId, result, signal);
    if (result.status === 'FAILED') return await endFailed(deps, taken, evalId, result, signal);
    return await followLater(deps, taken, evalId, signal);
  } catch (error) {
    if (error instanceof StepStopped) throw error;
    if (error instanceof ReppoOutOfCredit) return waitFor(deps, taken, APPEAL_CAUSES.outOfCredit, LONGEST_RETRY_SECONDS, signal);
    return giveBack(deps, taken, causeOf(error), signal);
  }
}

/**
 * What the step does after its one POST failed, decided by whose fault the failure is:
 * - wait: our balance (402), the service busy (409, 429), our key (401, 403) or a call that never left
 *   (ReppoUnreachable). None is this appeal's fault, so its try is handed back and it waits `seconds`, for good if need
 *   be (C24);
 * - stopped: the worker's own time limit stopped the submit before its call (ReppoStoppedFirst). The try is handed back;
 * - refused: Reppo refused this appeal's own request (400, 404). The try counts, and APPEAL_MAX_ATTEMPTS of them end it;
 * - unsendable: the input can never be sent (ReppoUnsendable). The check ends at once;
 * - unclear: anything else, a submit that may have been charged. The mark stays, and the next take counts it.
 * Every kind but unclear proves nothing was charged. Read by the error's class and, for a refusal, its status; anything
 * not named here, a refusal with another status or a kind of ReppoNotSent added later among them, is unclear, never
 * "not charged" (fail closed). Pure.
 */
type FailedSubmit = { kind: 'wait'; cause: string; seconds: number } | { kind: 'stopped' | 'refused' | 'unsendable' | 'unclear'; cause: string };

function afterFailedSubmit(error: unknown): FailedSubmit {
  if (error instanceof ReppoOutOfCredit) return { kind: 'wait', cause: APPEAL_CAUSES.outOfCredit, seconds: LONGEST_RETRY_SECONDS };
  if (error instanceof ReppoUnreachable) return { kind: 'wait', cause: APPEAL_CAUSES.unreachable, seconds: APPEAL_SERVICE_WAIT_SECONDS };
  if (error instanceof ReppoStoppedFirst) return { kind: 'stopped', cause: APPEAL_CAUSES.stopped };
  if (error instanceof ReppoUnsendable) return { kind: 'unsendable', cause: APPEAL_CAUSES.unsendable };
  if (error instanceof ReppoRefused) {
    if (error.status === 409 || error.status === 429) return { kind: 'wait', cause: APPEAL_CAUSES.busy, seconds: APPEAL_BUSY_WAIT_SECONDS };
    if (error.status === 401 || error.status === 403) return { kind: 'wait', cause: APPEAL_CAUSES.keyRefused, seconds: APPEAL_SERVICE_WAIT_SECONDS };
    if (error.status === 400 || error.status === 404) return { kind: 'refused', cause: causeOf(error) };
  }
  return { kind: 'unclear', cause: causeOf(error) };
}

/**
 * The one POST of a marked appeal, and what it leaves in the store for each way it can end (C23, C56):
 * - an evaluation id: kept at once with noteAppealEval, before any wait, with no stop allowed between the two;
 * - a failure afterFailedSubmit reads as anything but unclear: nothing was charged, so the mark is taken back with
 *   clearAppealSubmitting, with no stop before it either, and the appeal waits, is given back or ends as that kind says;
 * - an unclear failure: the submit may have been charged, so the mark stays and the appeal is given back with its try
 *   counted. Its next take counts the submit, and ends the check once MAX_UNCLEAR_SUBMITS are counted (fail closed).
 * When noteAppealEval fails after an id came back, the mark stays too and the next take counts it the same way: one
 * check is paid for and its verdict lost, the lesser harm than paying past the limit. That line names the id, so the
 * operator can look it up.
 */
async function submitOnce(
  deps: AppealDeps,
  taken: TakenAppeal,
  input: string,
  signal: AbortSignal | undefined,
): Promise<{ kind: 'sent'; evalId: string } | { kind: 'ended'; outcome: AppealOutcome }> {
  const where: Where = { campaignId: taken.campaignId, wallet: taken.wallet };
  const label = `appeal ${taken.campaignId} ${taken.wallet}`;
  let evalId: string;
  try {
    evalId = await deps.reppo.submit(input, signal);
  } catch (error) {
    const failed = afterFailedSubmit(error);
    if (failed.kind === 'unclear') {
      return { kind: 'ended', outcome: await giveBack(deps, taken, `${failed.cause}; the next try counts it as an unclear submit`, signal) };
    }
    // No checkpoint before this write: it records that this send charged nothing, and left undone the next take would
    // count a submit that paid nothing as perhaps paid for.
    await clearAppealSubmitting(deps.db, where, deps.now());
    let outcome: AppealOutcome;
    if (failed.kind === 'wait') outcome = await waitFor(deps, taken, failed.cause, failed.seconds, signal);
    else if (failed.kind === 'stopped') outcome = await stoppedFirst(deps, taken, failed.cause);
    else if (failed.kind === 'refused') outcome = await refusedBack(deps, taken, failed.cause, signal);
    else outcome = await endCheck(deps, taken, failed.cause, signal);
    return { kind: 'ended', outcome };
  }
  // No checkpoint between the submit and this record: the evaluation may be paid for already, so its id is kept, abort
  // or not, and every later try looks it up instead of paying again.
  let kept = false;
  try {
    kept = await noteAppealEval(deps.db, where, evalId, deps.now());
  } catch {
    kept = false;
  }
  if (!kept) {
    deps.log(`${label}: evaluation ${evalId} could not be kept, so this appeal ends unchecked; look the evaluation up by hand`);
    return { kind: 'ended', outcome: { kind: 'dropped', ...where, cause: APPEAL_CAUSES.lost } };
  }
  deps.log(`${label}: sent to the outside check as evaluation ${evalId}`);
  return { kind: 'sent', evalId };
}

async function recordCheck(
  deps: AppealDeps,
  taken: TakenAppeal,
  evalId: string,
  result: ReppoEval,
  signal: AbortSignal | undefined,
): Promise<AppealOutcome> {
  const where: Where = { campaignId: taken.campaignId, wallet: taken.wallet };
  const label = `appeal ${taken.campaignId} ${taken.wallet}`;
  const verdict: Partial<Record<keyof ReppoVerdict, unknown>> | null = result.verdict;
  // A charged evaluation is always recorded as checked, with no route when it named none Thuli knows, so it is never
  // handed out or paid for again (C23).
  const route = verdict === null ? null : routeFrom(verdict.route);
  checkpoint(signal, 'recording an outside check');
  deps.spend.credits += result.creditsCharged;
  const spent = `${result.creditsCharged} credits, ${deps.spend.credits} credits since start`;
  const check = {
    evalId,
    route,
    note: noteFrom(typeof verdict?.reason === 'string' ? verdict.reason : null),
    creditsCharged: result.creditsCharged,
    score: scoreFrom(verdict?.score),
    decision: decisionFrom(verdict?.decision),
    confidence: confidenceFrom(verdict?.confidence),
  };
  if (!(await recordAppealCheck(deps.db, where, check, deps.now()))) {
    deps.log(`${label}: ${APPEAL_CAUSES.lost}, so the check of evaluation ${evalId} was not kept, ${spent}`);
    return { kind: 'dropped', ...where, cause: APPEAL_CAUSES.lost };
  }
  waitNoted(deps.memory.waiting, APPEAL_LABEL, undefined);
  deps.log(`${label}: checked, ${route === null ? 'with no route Thuli knows' : `route ${route}`}, evaluation ${evalId}, ${spent}`);
  return { kind: 'checked', ...where, route, evalId, creditsCharged: result.creditsCharged };
}

// Each verdict field is held to the rule the store holds it to, core's ReppoVerdict for the score and the confidence and
// plain text for the decision, so a value the store would refuse costs that one field and never the paid check (C23).
function scoreFrom(value: unknown): number | null {
  const parsed = ReppoVerdict.shape.score.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function confidenceFrom(value: unknown): ReppoConfidence | null {
  const parsed = ReppoVerdict.shape.confidence.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function decisionFrom(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_REPPO_DECISION_CHARS && isPlainText(value) ? value : null;
}

// Ends the check unchecked for good with a cause in fixed words, kept for the owner's view only (C40). detail is more
// fixed words or numbers for the log line alone.
async function endCheck(deps: AppealDeps, taken: TakenAppeal, cause: string, signal: AbortSignal | undefined, detail = ''): Promise<AppealOutcome> {
  checkpoint(signal, 'ending an appeal check');
  const where: Where = { campaignId: taken.campaignId, wallet: taken.wallet };
  await markAppealUnchecked(deps.db, where, deps.now(), cause);
  deps.log(`appeal ${taken.campaignId} ${taken.wallet}: unchecked, ${cause}${detail}`);
  return { kind: 'unchecked', ...where, cause };
}

async function giveBack(deps: AppealDeps, taken: TakenAppeal, cause: string, signal: AbortSignal | undefined): Promise<AppealOutcome> {
  checkpoint(signal, 'giving an appeal back');
  const where: Where = { campaignId: taken.campaignId, wallet: taken.wallet };
  const wait = retryDelaySeconds(taken.attempts);
  const status = await releaseAppeal(deps.db, where, deps.now(), APPEAL_MAX_ATTEMPTS, wait);
  const after =
    status === 'queued' ? `queued again, next try in ${wait} s` : status === 'unchecked' ? `unchecked after ${APPEAL_MAX_ATTEMPTS} tries` : 'already moved on';
  deps.log(`appeal ${taken.campaignId} ${taken.wallet}: not checked, ${cause}; ${after}`);
  return { kind: 'released', ...where, cause, status };
}

// Reppo refused this appeal's own request (400 or 404), and this submit created nothing. The try counts, so a request
// it keeps refusing ends after APPEAL_MAX_ATTEMPTS tries with a cause that says so.
async function refusedBack(deps: AppealDeps, taken: TakenAppeal, cause: string, signal: AbortSignal | undefined): Promise<AppealOutcome> {
  if (taken.attempts >= APPEAL_MAX_ATTEMPTS) return endCheck(deps, taken, APPEAL_CAUSES.keptRefusing, signal);
  return giveBack(deps, taken, cause, signal);
}

// The worker's own time limit stopped the submit before its call, so nothing was sent and the appeal is not to blame.
// No checkpoint before this write, though the signal is aborted: it is the one write that leaves the appeal as if this
// try was never made, and left undone the lease would run out with the try counted.
async function stoppedFirst(deps: AppealDeps, taken: TakenAppeal, cause: string): Promise<AppealOutcome> {
  const where: Where = { campaignId: taken.campaignId, wallet: taken.wallet };
  const wait = retryDelaySeconds(taken.attempts);
  const status = await releaseAppeal(deps.db, where, deps.now(), APPEAL_MAX_ATTEMPTS, wait, { refundTry: true });
  deps.log(`appeal ${taken.campaignId} ${taken.wallet}: not checked, ${cause}; queued again, next try in ${wait} s`);
  return { kind: 'released', ...where, cause, status };
}

// Paid for and still queued or running at Reppo: looked up again after APPEAL_LOOKUP_WAIT_SECONDS with the try handed
// back, so no count of tries ends it; the store follows it for a day from its submit mark (C56).
async function followLater(deps: AppealDeps, taken: TakenAppeal, evalId: string, signal: AbortSignal | undefined): Promise<AppealOutcome> {
  checkpoint(signal, 'giving an appeal back');
  const where: Where = { campaignId: taken.campaignId, wallet: taken.wallet };
  const status = await releaseAppeal(deps.db, where, deps.now(), APPEAL_MAX_ATTEMPTS, APPEAL_LOOKUP_WAIT_SECONDS, { refundTry: true });
  deps.log(
    `appeal ${taken.campaignId} ${taken.wallet}: ${APPEAL_CAUSES.unfinished}, so evaluation ${evalId} is looked up again in ${APPEAL_LOOKUP_WAIT_SECONDS} s`,
  );
  return { kind: 'released', ...where, cause: APPEAL_CAUSES.unfinished, status };
}

// Reppo ended the evaluation FAILED: no verdict will come, so the check ends now, with no further look-up. Reppo's docs
// say a FAILED evaluation charges nothing; any credits it reports anyway go into the spend total and the log line, so
// such a charge would be seen.
async function endFailed(
  deps: AppealDeps,
  taken: TakenAppeal,
  evalId: string,
  result: ReppoEval,
  signal: AbortSignal | undefined,
): Promise<AppealOutcome> {
  checkpoint(signal, 'ending an appeal check');
  const where: Where = { campaignId: taken.campaignId, wallet: taken.wallet };
  await markAppealUnchecked(deps.db, where, deps.now(), APPEAL_CAUSES.evaluationFailed);
  let charged = '';
  if (result.creditsCharged > 0) {
    deps.spend.credits += result.creditsCharged;
    charged = `, ${result.creditsCharged} credits charged though it failed, ${deps.spend.credits} credits since start`;
  }
  deps.log(`appeal ${taken.campaignId} ${taken.wallet}: unchecked, ${APPEAL_CAUSES.evaluationFailed}, evaluation ${evalId}${charged}`);
  return { kind: 'unchecked', ...where, cause: APPEAL_CAUSES.evaluationFailed };
}

// A wait that is no fault of the appeal: our credit, our key, or the outside check busy or out of reach. Its try is
// handed back and it waits `seconds`, so however long the cause lasts it neither ends appeals nor spins (C24, C41).
// Said once, then again only when the cause changes or after a check is recorded.
async function waitFor(deps: AppealDeps, taken: TakenAppeal, cause: string, seconds: number, signal: AbortSignal | undefined): Promise<AppealOutcome> {
  checkpoint(signal, 'giving an appeal back');
  const where: Where = { campaignId: taken.campaignId, wallet: taken.wallet };
  const status = await releaseAppeal(deps.db, where, deps.now(), APPEAL_MAX_ATTEMPTS, seconds, { refundTry: true });
  if (waitNoted(deps.memory.waiting, APPEAL_LABEL, cause)) deps.log(`appeal: waiting, ${cause}`);
  return { kind: 'released', ...where, cause, status };
}

// Every character that can still break, end or turn a line once JSON.stringify has escaped quotes, backslashes and the
// C0 controls: the rest of the controls (DEL and the C1 range, NEL among them), the line and paragraph separators, and
// every format character, such as a zero-width space or a direction override.
const STILL_RAW = /[\p{Cc}\p{Zl}\p{Zp}\p{Cf}]/gu;
const escaped = (found: string) =>
  Array.from({ length: found.length }, (_, unit) => `\\u${found.charCodeAt(unit).toString(16).padStart(4, '0')}`).join('');

/**
 * Text that came from outside Thuli's code, the appellant's, the owner's, Reppo's or a stored cause, as one line for the
 * operator's screen: a JSON string after a fixed label, with every character in STILL_RAW written as an escape too, so
 * it can never start a new line, move the cursor or pass for a line of the command's own (C34, C40, C58). The one
 * quoting function every printed outside text goes through. Ids, routes, numbers and fixed words print as they are. Pure.
 */
export function quoted(text: string): string {
  return JSON.stringify(text).replace(STILL_RAW, escaped);
}

function appealLines(appeal: OwnerAppeal, ask: PublicAsk | null, place: number, total: number): string[] {
  const check = [
    appeal.checkStatus,
    ...(appeal.reppoRoute === null ? [] : [`route ${appeal.reppoRoute}`]),
    ...(appeal.reppoEvalId === null ? [] : [`evaluation ${appeal.reppoEvalId}`]),
    ...(appeal.creditsCharged === null ? [] : [`${appeal.creditsCharged} credits`]),
    ...(appeal.reppoScore === null ? [] : [`score ${appeal.reppoScore}`]),
    ...(appeal.reppoConfidence === null ? [] : [`confidence ${appeal.reppoConfidence}`]),
    ...(appeal.reppoDecision === null ? [] : [`decision ${quoted(appeal.reppoDecision)}`]),
  ].join(', ');
  const outcome = appeal.outcome === 'reversed' && appeal.newAction !== null ? `reversed to ${appeal.newAction}` : appeal.outcome;
  return [
    `appeal ${place} of ${total}: ${appeal.wallet}`,
    `  ask: ${ask?.action ?? 'unknown'} under ${ask?.rule ?? 'unknown'} (appealed: ${appeal.appealedAction} under ${appeal.appealedRule})`,
    `  text: ${quoted(appeal.text)}`,
    `  outside check: ${check}`,
    ...(appeal.checkNote === null ? [] : [`  check note: ${quoted(appeal.checkNote)}`]),
    ...(appeal.unclearSubmits > 0 ? [`  unclear submits: ${appeal.unclearSubmits}`] : []),
    // A mark beside an evaluation id is a submit that shows what it paid for, so only a mark with none is worth a warning.
    ...(appeal.submitStartedAt !== null && appeal.reppoEvalId === null
      ? [`  warning: a submit may have been paid for, marked at ${appeal.submitStartedAt.toISOString()} with no evaluation id`]
      : []),
    `  note: ${appeal.reppoNote === null ? 'none' : quoted(appeal.reppoNote)}`,
    `  outcome: ${outcome}`,
    ...(appeal.ownerNote === null ? [] : [`  owner note: ${quoted(appeal.ownerNote)}`]),
  ];
}

/**
 * appeal:list for one campaign: one block per appeal with its wallet, the ask's action and rule, the appeal's text, the
 * outside check and the outcome. The only place an appeal's text is shown, and it goes only to the operator's terminal.
 */
export async function appealListLines(db: Db, campaignId: string): Promise<{ ok: boolean; lines: string[] }> {
  const appeals = await ownerAppeals(db, campaignId);
  if (appeals.length === 0) return { ok: true, lines: [`no appeals in campaign ${campaignId}`] };
  const lines: string[] = [];
  for (const [index, appeal] of appeals.entries()) {
    lines.push(...appealLines(appeal, await getAsk(db, campaignId, appeal.wallet), index + 1, appeals.length));
  }
  return { ok: true, lines };
}

/** appeal:settle's flags, checked. */
export interface SettleArgs {
  campaignId: string;
  wallet: Address;
  outcome: 'reversed' | 'upheld';
  newAction: 'full' | 'partial' | null;
  ownerNote: string | null;
}

/**
 * Checks appeal:settle's flags before anything is read, so a refusal names the flag: --id a campaign id, --wallet an
 * address, --outcome reversed or upheld, --action full or partial for a reversal and none for an upheld appeal, and
 * --note, when given, plain text of 1 to MAX_OWNER_NOTE_CHARS characters. Pure.
 */
export function parseSettleArgs(raw: {
  id?: string;
  wallet?: string;
  outcome?: string;
  action?: string;
  note?: string;
}): { ok: true; value: SettleArgs } | { ok: false; cause: string } {
  const refuse = (cause: string) => ({ ok: false as const, cause });
  if (raw.id === undefined || !CAMPAIGN_ID.test(raw.id)) return refuse('--id must be the campaign id: letters, digits, dots, dashes or underscores');
  let wallet: Address;
  try {
    wallet = parseAddress(raw.wallet ?? '');
  } catch {
    return refuse("--wallet must be the appealing wallet's address");
  }
  const { outcome, action, note } = raw;
  if (outcome !== 'reversed' && outcome !== 'upheld') return refuse('--outcome must be reversed or upheld');
  if (outcome === 'reversed' && action !== 'full' && action !== 'partial') return refuse('--action must be full or partial for a reversal');
  if (outcome === 'upheld' && action !== undefined) return refuse('--action is only for a reversal; an upheld appeal changes nothing');
  if (note !== undefined && (note.length === 0 || note.length > MAX_OWNER_NOTE_CHARS || !isPlainText(note))) {
    return refuse(`--note must be plain text of 1 to ${MAX_OWNER_NOTE_CHARS} characters, with no link or markup`);
  }
  const newAction = outcome === 'reversed' ? (action as 'full' | 'partial') : null;
  return { ok: true, value: { campaignId: raw.id, wallet, outcome, newAction, ownerNote: note ?? null } };
}

/**
 * appeal:settle for one appeal: the appeal as it stands, then, dry, the store's settleRefusal, which runs the very checks
 * settleAppeal does and writes nothing, so the dry run prints the refusal or the slot the settlement would leave (C11);
 * or, with write, settleAppeal, the only path that changes an ask after its screening, and only toward an approval the
 * owner chose. The store gives the reversed ask the next free slot or none (C44), and refuses with a fixed cause, passed
 * on as is. Between a dry run and a write the appeal or the ask can still change, which the write then refuses.
 *
 * @returns ok with the lines to print, or not ok when there is no such appeal or the store refused or would refuse.
 */
export async function settleAppealCommand(db: Db, args: SettleArgs, write: boolean, now: Date): Promise<{ ok: boolean; lines: string[] }> {
  const appeal = (await ownerAppeals(db, args.campaignId)).find((one) => one.wallet === args.wallet);
  if (appeal === undefined) return { ok: false, lines: [`no appeal from ${args.wallet} in campaign ${args.campaignId}`] };
  const head =
    `appeal ${args.campaignId} ${args.wallet}: ${appeal.appealedAction} under ${appeal.appealedRule} appealed, ` +
    `outside check ${appeal.checkStatus}${appeal.reppoRoute === null ? '' : ` with route ${appeal.reppoRoute}`}, outcome ${appeal.outcome}`;
  const what = args.outcome === 'reversed' ? `reversed to ${args.newAction}` : 'upheld';
  if (!write) {
    // The store's own checks, run under the same lock and writing nothing, so the dry run says what --write would do.
    const preview = await settleRefusal(db, args);
    if (preview.refused !== null) return { ok: false, lines: [head, `it would be refused: ${preview.refused}`] };
    if (args.outcome === 'upheld') return { ok: true, lines: [head, 'it would be settled as upheld, the ask unchanged; add --write to do it'] };
    const slot = preview.slot === null ? 'with no slot, since every slot is taken' : `holding slot ${preview.slot}`;
    return { ok: true, lines: [head, `it would be settled as ${what}, ${slot}; add --write to do it`] };
  }
  const result = await settleAppeal(db, args, now);
  if ('refused' in result) return { ok: false, lines: [head, `refused: ${result.refused}`] };
  if (args.outcome === 'upheld') return { ok: true, lines: [head, 'settled as upheld; the ask is unchanged'] };
  return { ok: true, lines: [head, `settled as ${what}, ${result.slot === null ? 'with no slot, since every slot is taken' : `slot ${result.slot}`}`] };
}

/** What every export run says, because no scoring reads these lines today. */
export const EXPORT_SUMMARY = 'exported as input for the next rulebook change; the scorecard does not score appeals yet';

/**
 * One checked appeal as appeal:export writes it, in its own strict shape: the decision as it was appealed, with the ask's
 * reason, the chain its facts were read on, the stored record the check was built from, Reppo's whole verdict and the
 * outcome. There is no field for the appeal's text, its hash, its signature or the owner's note, so none can be written
 * (C34, C40). The record still holds the evidence transaction hashes that reppoInput leaves out of what Reppo sees, so
 * these lines are private data, kept only in a git-ignored file.
 */
export const AppealExportLine = z.strictObject({
  campaignId: z.string(),
  wallet: z.string(),
  appealedAction: OutcomeSchema,
  appealedRule: z.string(),
  reason: z.string().nullable(),
  /**
   * The screened chain, from the ask's facts; null when the ask has none. Left out only by lines exported before the
   * chain was recorded, so a file holding them is still added to.
   */
  chain: z.enum(SCREENED_CHAINS).nullable().optional(),
  record: z.record(z.string(), z.unknown()).nullable(),
  route: z.enum(['ship', 'review', 'block']).nullable(),
  score: ReppoVerdict.shape.score.nullable(),
  decision: z.string().nullable(),
  confidence: ReppoVerdict.shape.confidence.nullable(),
  note: z.string().nullable(),
  evalId: z.string(),
  creditsCharged: z.int().min(0),
  checkedAt: z.string(),
  outcome: z.enum(['open', 'reversed', 'upheld']),
  newAction: z.enum(['full', 'partial']).nullable(),
});
export type AppealExportLine = z.infer<typeof AppealExportLine>;

// At 20 appeals a day and a few KB a line this is years of appeals, so a file past it is not this export's (C41).
const MAX_EXPORT_FILE_BYTES = 16 * 1024 * 1024;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

async function exportLine(db: Db, appeal: OwnerAppeal): Promise<AppealExportLine> {
  const ask = await getAsk(db, appeal.campaignId, appeal.wallet);
  // The store reads an ask's private record only inside takeAppeal, which leases the appeal, so this one column is read
  // here, read only, for an export that stays on this machine.
  const [row] = await db.query<{ record: unknown }>('SELECT record FROM asks WHERE campaign_id = $1 AND wallet = $2', [
    appeal.campaignId,
    appeal.wallet,
  ]);
  return AppealExportLine.parse({
    campaignId: appeal.campaignId,
    wallet: appeal.wallet,
    appealedAction: appeal.appealedAction,
    appealedRule: appeal.appealedRule,
    reason: ask?.reason ?? null,
    chain: ask?.facts?.chain ?? null,
    record: row?.record ?? null,
    route: appeal.reppoRoute,
    score: appeal.reppoScore,
    decision: appeal.reppoDecision,
    confidence: appeal.reppoConfidence,
    note: appeal.reppoNote,
    evalId: appeal.reppoEvalId,
    creditsCharged: appeal.creditsCharged ?? 0,
    checkedAt: appeal.checkedAt?.toISOString(),
    outcome: appeal.outcome,
    newAction: appeal.newAction,
  });
}

/**
 * appeal:export for one campaign: every checked appeal not yet in `file`, by evaluation id, as one AppealExportLine each,
 * appended with write and only counted without. A file holding any line that is not an exported appeal is refused and
 * left exactly as it was, so this never mixes into a file another tool owns. The list read is one campaign's appeals, at
 * most one per ask, and the file read is capped at MAX_EXPORT_FILE_BYTES (C41).
 *
 * @returns ok with the lines to print, ending with EXPORT_SUMMARY; not ok, nothing written, for a file it cannot add to.
 */
export async function exportAppeals(db: Db, campaignId: string, file: string, write: boolean): Promise<{ ok: boolean; lines: string[] }> {
  let existing = '';
  if (fs.existsSync(file)) {
    if (fs.statSync(file).size > MAX_EXPORT_FILE_BYTES) {
      return { ok: false, lines: [`${file} is over ${MAX_EXPORT_FILE_BYTES} bytes, so nothing was written`] };
    }
    existing = fs.readFileSync(file, 'utf8');
  }
  const known = new Set<string>();
  for (const [index, text] of existing.split('\n').entries()) {
    if (text.trim() === '') continue;
    let parsed: ReturnType<typeof AppealExportLine.safeParse> | undefined;
    try {
      parsed = AppealExportLine.safeParse(JSON.parse(text));
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || !parsed.success) {
      return { ok: false, lines: [`line ${index + 1} of ${file} is not an exported appeal, so nothing was written`] };
    }
    known.add(parsed.data.evalId);
  }
  const checked = (await ownerAppeals(db, campaignId)).filter((appeal) => appeal.checkStatus === 'checked' && appeal.reppoEvalId !== null);
  const fresh: AppealExportLine[] = [];
  for (const appeal of checked) {
    if (!known.has(appeal.reppoEvalId as string)) fresh.push(await exportLine(db, appeal));
  }
  const counts = `${plural(checked.length, 'checked appeal')}, ${checked.length - fresh.length} already in the file, ${fresh.length} to add`;
  if (!write) return { ok: true, lines: [counts, `${plural(fresh.length, 'line')} would be added; add --write to write it`, EXPORT_SUMMARY] };
  if (fresh.length > 0) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lead = existing !== '' && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, `${lead}${fresh.map((line) => JSON.stringify(line)).join('\n')}\n`);
  }
  return { ok: true, lines: [counts, `${plural(fresh.length, 'line')} added to ${file}`, EXPORT_SUMMARY] };
}

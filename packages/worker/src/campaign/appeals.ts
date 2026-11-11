import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import {
  CAMPAIGN_ID,
  isPlainText,
  OutcomeSchema,
  parseAddress,
  ReppoPayloadError,
  reppoInput,
  ReppoVerdict,
  type Address,
  type GraphRecord,
} from '@thuli/core';
import {
  getAsk,
  markAppealUnchecked,
  MAX_OWNER_NOTE_CHARS,
  MAX_REPPO_DECISION_CHARS,
  MAX_REPPO_NOTE_CHARS,
  noteAppealEval,
  ownerAppeals,
  recordAppealCheck,
  releaseAppeal,
  settleAppeal,
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
import { lookUpEvaluation, ReppoError, ReppoOutOfCredit, submitEvaluation, type ReppoConnection, type ReppoEval } from '../reppo/client.ts';
import { identifyingPart } from '../reppo/feedback.ts';
import { LONGEST_RETRY_SECONDS, retryDelaySeconds } from './screen.ts';
import { checkpoint, StepStopped, waitNoted, type ChainMemory } from './vault.ts';

/** How long one worker holds an appeal: above the step's time limit, so a check under way never loses its appeal. */
export const APPEAL_LEASE_SECONDS = 300;
/** Tries one appeal's outside check gets before it ends unchecked (C41). */
export const APPEAL_MAX_ATTEMPTS = 6;
/** How long one look-up waits for Reppo, which answers in 30 to 90 seconds; past this the try is given back unfinished. */
export const APPEAL_REPPO_WAIT_MS = 150_000;
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
});

const APPEAL_LABEL = 'appeal';
const ROUTES: readonly ReppoRoute[] = ['ship', 'review', 'block'];

/** Reppo as the appeal step uses it: a submit that answers with the id before any wait, and a look-up by that id. */
export interface AppealReppo {
  submit(input: string): Promise<string>;
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
    // The submit's own retry waits are not cut short: a submit that may have landed must finish and hand back its id,
    // or the next try would pay for a second evaluation (C23).
    submit: (input) => submitEvaluation(input, options),
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
 * it is still plain text by core's rule, so a link or markup is never stored or shown (C13, C34). Pure.
 */
export function noteFrom(reason: string | null): string | null {
  if (reason === null) return null;
  let cut = reason.slice(0, MAX_REPPO_NOTE_CHARS);
  if (!cut.isWellFormed()) cut = cut.slice(0, -1);
  cut = cut.trim();
  return cut !== '' && isPlainText(cut) ? cut : null;
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
 *   nothing is submitted again (C23). Otherwise the text is submitted and its id is kept with noteAppealEval before the
 *   wait, with no stop allowed between the two, because the evaluation is paid for once it is submitted.
 * - COMPLETED: recordAppealCheck with the route, noteFrom of Reppo's reason, the id, the credits charged and the
 *   verdict's score, decision and confidence, each null when the store would refuse it. A paid check always ends checked,
 *   with route null when Reppo named none Thuli knows or its verdict was out of shape (C23).
 * - UNFINISHED, FAILED or any failed call: given back with retryDelaySeconds for its attempt, the id staying on it. Out
 *   of credit: given back with LONGEST_RETRY_SECONDS and its try handed back, said once (C24). The store ends an appeal
 *   that runs out of tries unchecked (C41).
 * Log lines hold ids, routes, counts and fixed words; never the appeal's text, which this step never receives, Reppo's
 * note or a key (C40). The signal is checked before every store write and before the submit (C41).
 *
 * @returns idle when no appeal is ready; checked, unchecked, released or dropped (another worker or a settle moved it).
 * @throws StepStopped when the signal is aborted; StoreError only when the store cannot hand out an appeal at all.
 */
export async function appealNext(deps: AppealDeps, signal?: AbortSignal): Promise<AppealOutcome> {
  checkpoint(signal, 'taking an appeal');
  const taken = await takeAppeal(deps.db, deps.now(), APPEAL_LEASE_SECONDS, APPEAL_MAX_ATTEMPTS);
  if (taken === null) return { kind: 'idle' };
  const where: Where = { campaignId: taken.campaignId, wallet: taken.wallet };
  const label = `appeal ${taken.campaignId} ${taken.wallet}`;
  try {
    let evalId = taken.reppoEvalId;
    if (evalId === null) {
      const built = outsideInput(taken);
      if (!built.ok) {
        checkpoint(signal, 'ending an appeal check');
        await markAppealUnchecked(deps.db, where, deps.now());
        deps.log(`${label}: unchecked, ${built.cause}${built.kind === undefined ? '' : ` (${built.kind})`}`);
        return { kind: 'unchecked', ...where, cause: built.cause };
      }
      checkpoint(signal, 'sending an appeal to the outside check');
      evalId = await deps.reppo.submit(built.input);
      // No checkpoint between the submit and this record: once submitted the evaluation is paid for, so its id is always
      // kept, abort or not, and every later try looks it up instead of paying again (C23).
      if (!(await noteAppealEval(deps.db, where, evalId, deps.now()))) {
        deps.log(`${label}: ${APPEAL_CAUSES.lost}, so evaluation ${evalId} was not kept`);
        return { kind: 'dropped', ...where, cause: APPEAL_CAUSES.lost };
      }
      deps.log(`${label}: sent to the outside check as evaluation ${evalId}`);
    }
    checkpoint(signal, 'waiting for the outside check');
    const result = await deps.reppo.lookUp(evalId, signal);
    if (result.status === 'COMPLETED') return await recordCheck(deps, taken, evalId, result, signal);
    return await giveBack(deps, taken, result.status === 'UNFINISHED' ? APPEAL_CAUSES.unfinished : APPEAL_CAUSES.failed, signal);
  } catch (error) {
    if (error instanceof StepStopped) throw error;
    if (error instanceof ReppoOutOfCredit) return outOfCredit(deps, taken, signal);
    return giveBack(deps, taken, causeOf(error), signal);
  }
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

// No credit is no fault of the appeal: its try is handed back and it waits the longest wait, so a long outage of credit
// neither ends appeals nor spins (C24). Said once until a check is recorded again.
async function outOfCredit(deps: AppealDeps, taken: TakenAppeal, signal: AbortSignal | undefined): Promise<AppealOutcome> {
  checkpoint(signal, 'giving an appeal back');
  const where: Where = { campaignId: taken.campaignId, wallet: taken.wallet };
  const status = await releaseAppeal(deps.db, where, deps.now(), APPEAL_MAX_ATTEMPTS, LONGEST_RETRY_SECONDS, { refundTry: true });
  if (waitNoted(deps.memory.waiting, APPEAL_LABEL, APPEAL_CAUSES.outOfCredit)) deps.log(`appeal: waiting, ${APPEAL_CAUSES.outOfCredit}`);
  return { kind: 'released', ...where, cause: APPEAL_CAUSES.outOfCredit, status };
}

function appealLines(appeal: OwnerAppeal, ask: PublicAsk | null, place: number, total: number): string[] {
  const check = [
    appeal.checkStatus,
    ...(appeal.reppoRoute === null ? [] : [`route ${appeal.reppoRoute}`]),
    ...(appeal.reppoEvalId === null ? [] : [`evaluation ${appeal.reppoEvalId}`]),
    ...(appeal.creditsCharged === null ? [] : [`${appeal.creditsCharged} credits`]),
  ].join(', ');
  const outcome = appeal.outcome === 'reversed' && appeal.newAction !== null ? `reversed to ${appeal.newAction}` : appeal.outcome;
  return [
    `appeal ${place} of ${total}: ${appeal.wallet}`,
    `  ask: ${ask?.action ?? 'unknown'} under ${ask?.rule ?? 'unknown'} (appealed: ${appeal.appealedAction} under ${appeal.appealedRule})`,
    `  text: ${appeal.text}`,
    `  outside check: ${check}`,
    `  note: ${appeal.reppoNote ?? 'none'}`,
    `  outcome: ${outcome}`,
    ...(appeal.ownerNote === null ? [] : [`  owner note: ${appeal.ownerNote}`]),
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
 * appeal:settle for one appeal: the appeal as it stands, then, dry, what it would be settled as, or with write the store's
 * settleAppeal, the only path that changes an ask after its screening, and only toward an approval the owner chose (C11).
 * The store gives the reversed ask the next free slot or none (C44), and refuses with a fixed cause, passed on as is.
 *
 * @returns ok with the lines to print, or not ok when there is no such appeal or the store refused.
 */
export async function settleAppealCommand(db: Db, args: SettleArgs, write: boolean, now: Date): Promise<{ ok: boolean; lines: string[] }> {
  const appeal = (await ownerAppeals(db, args.campaignId)).find((one) => one.wallet === args.wallet);
  if (appeal === undefined) return { ok: false, lines: [`no appeal from ${args.wallet} in campaign ${args.campaignId}`] };
  const head =
    `appeal ${args.campaignId} ${args.wallet}: ${appeal.appealedAction} under ${appeal.appealedRule} appealed, ` +
    `outside check ${appeal.checkStatus}${appeal.reppoRoute === null ? '' : ` with route ${appeal.reppoRoute}`}, outcome ${appeal.outcome}`;
  const what = args.outcome === 'reversed' ? `reversed to ${args.newAction}` : 'upheld';
  if (!write) return { ok: true, lines: [head, `it would be settled as ${what}; add --write to do it`] };
  const result = await settleAppeal(db, args, now);
  if ('refused' in result) return { ok: false, lines: [head, `refused: ${result.refused}`] };
  if (args.outcome === 'upheld') return { ok: true, lines: [head, 'settled as upheld; the ask is unchanged'] };
  return { ok: true, lines: [head, `settled as ${what}, ${result.slot === null ? 'with no slot, since every slot is taken' : `slot ${result.slot}`}`] };
}

/** What every export run says, because no scoring reads these lines today. */
export const EXPORT_SUMMARY = 'exported as input for the next rulebook change; the scorecard does not score appeals yet';

/**
 * One checked appeal as appeal:export writes it, in its own strict shape: the decision as it was appealed, with the ask's
 * reason, the stored record the check was built from, Reppo's whole verdict and the outcome. There is no field for the
 * appeal's text, its hash, its signature or the owner's note, so none can be written (C34, C40). The record still holds
 * the evidence transaction hashes that reppoInput leaves out of what Reppo sees, so these lines are private data, kept
 * only in a git-ignored file.
 */
export const AppealExportLine = z.strictObject({
  campaignId: z.string(),
  wallet: z.string(),
  appealedAction: OutcomeSchema,
  appealedRule: z.string(),
  reason: z.string().nullable(),
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

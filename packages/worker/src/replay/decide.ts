import { z } from 'zod';
import {
  computeCeiling,
  computeStart,
  DECISION_RULES,
  decisionFromGraphAnswer,
  GraphVersionError,
  holdForReview,
  OutcomeSchema,
  Start,
  toGraphRecord,
  validateDecision,
  VERDICTS,
  type GraphRecord,
  type ReplayRow,
  type Settings,
} from '@thuli/core';
import type { JsonlCache } from '../chain/jsonlCache.ts';
import { HttpError } from '../http.ts';
import { ServError, type ServReply } from '../serv/client.ts';

// A real reply is well under 2 KB, and the checks read the reply before this cut, so the cut only limits what is kept (C41).
const MAX_STORED_TEXT_CHARS = 8192;
/** The most wallets sent to SERV at once (C41). Measured 6 Nov: no rate limit seen up to 40 v2 and 32 graph calls at once. */
export const MAX_DECIDE_WIDTH = 64;
// One wait per retry, so a wallet costs at most 4 calls per route and a stuck provider cannot hold a lane forever (C41).
const RETRY_WAITS_MS = [2_000, 8_000, 30_000] as const;
const PROGRESS_EVERY_WALLETS = 500;
// A bad key or a dead provider fails every wallet alike, so this many in a row means stop, not carry on (C11, C41).
export const MAX_UNDECIDED_IN_A_ROW = 25;

export const STALE_ROWS = 'replay rows are stale, rerun the replay';

export const DecisionRecord = z.strictObject({
  wallet: z.string(),
  mode: z.enum(['v3', 'v2']),
  /** True only when a graph call failed and v2 served instead. A burst wallet sent to v2 by design is not a fallback. */
  fallback: z.boolean(),
  start: Start,
  ceiling: OutcomeSchema,
  requestId: z.string().nullable(),
  rawText: z.string().max(MAX_STORED_TEXT_CHARS),
  usage: z.strictObject({ inputTokens: z.int().min(0), outputTokens: z.int().min(0) }).nullable(),
  verdict: z.enum(VERDICTS).nullable(),
  modelAction: OutcomeSchema.nullable(),
  modelRule: z.enum(DECISION_RULES).nullable(),
  action: OutcomeSchema,
  shareBps: z.int(),
  rule: z.enum(DECISION_RULES),
  reason: z.string(),
  citedTxs: z.array(z.string()),
  clampedFrom: OutcomeSchema.nullable(),
  accepted: z.boolean(),
  cause: z.string().nullable(),
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;

export interface DecideDeps {
  viaGraph(record: GraphRecord): Promise<ServReply>;
  viaV2(record: GraphRecord): Promise<ServReply>;
  sleep(ms: number): Promise<void>;
}

/** SERV answered 402. Nothing more can be decided until the balance is topped up, and a retry would only waste time. */
export class OutOfCredit extends Error {
  override name = 'OutOfCredit';
}

/** MAX_UNDECIDED_IN_A_ROW wallets in a row got no answer, so the rest of the list would fail the same way. */
export class ServDown extends Error {
  override name = 'ServDown';
}

// client.ts lets fetch's own failures through: a dropped line, a timeout, an oversized reply. They carry no status, so
// they take the status-null path. Their text can quote the URL, so it is never copied (C40). Anything else is a bug.
function failedCall(error: unknown): ServError {
  if (error instanceof ServError) return error;
  if (error instanceof HttpError || error instanceof TypeError || error instanceof DOMException) {
    return new ServError('the SERV call did not finish', null, null);
  }
  throw error;
}

function worthRetrying(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
}

async function withRetries(call: () => Promise<ServReply>, sleep: DecideDeps['sleep']): Promise<ServReply> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      const failure = failedCall(error);
      if (failure.status === 402) throw new OutOfCredit('SERV answered 402, so the credit balance has run out');
      const wait = RETRY_WAITS_MS[attempt];
      if (wait === undefined || !worthRetrying(failure.status)) throw failure;
      await sleep(wait);
    }
  }
}

interface Served {
  reply: ServReply;
  mode: 'v3' | 'v2';
  fallback: boolean;
}

async function askV2(record: GraphRecord, deps: DecideDeps, fallback: boolean): Promise<Served | null> {
  try {
    return { reply: await withRetries(() => deps.viaV2(record), deps.sleep), mode: 'v2', fallback };
  } catch (error) {
    if (error instanceof ServError) return null;
    throw error;
  }
}

async function askServ(record: GraphRecord, deps: DecideDeps, mode: 'auto' | 'v2'): Promise<Served | null> {
  if (mode === 'v2') return askV2(record, deps, false);
  try {
    return { reply: await withRetries(() => deps.viaGraph(record), deps.sleep), mode: 'v3', fallback: false };
  } catch (error) {
    if (error instanceof GraphVersionError) return askV2(record, deps, false);
    if (error instanceof ServError) return askV2(record, deps, true);
    throw error;
  }
}

/**
 * Sends one wallet through SERV and checks the answer with the code's rules. A burst wallet goes to v2 because graph g1
 * has no field for a burst; a graph call that fails after its retries also goes to v2, marked as a fallback.
 *
 * Returns null when no route gave an answer: nothing was approved for the wallet, and a rerun asks again (C11). Any
 * answer that arrived, however bad, ends in a record, with a failed check holding the wallet (C11, C13). The final
 * action is never above the ceiling (C12).
 *
 * @throws Error when the row's start or ceiling no longer match its facts, before any call.
 * @throws OutOfCredit on a 402 from either route.
 */
export async function decideWallet(
  row: ReplayRow,
  settings: Settings,
  deps: DecideDeps,
  mode: 'auto' | 'v2',
): Promise<DecisionRecord | null> {
  const start = computeStart(row.facts, settings);
  const { ceiling } = computeCeiling(row.facts, settings);
  if (start.outcome !== row.start.outcome || start.rule !== row.start.rule || ceiling !== row.ceiling) {
    throw new Error(STALE_ROWS);
  }

  const served = await askServ(toGraphRecord(row.facts, start), deps, mode);
  if (served === null) return null;
  const { reply } = served;

  const answer: ReturnType<typeof decisionFromGraphAnswer> =
    reply.answerProblem === null
      ? decisionFromGraphAnswer(reply.answer, settings, 0)
      : { ok: false, cause: reply.answerProblem };
  const result = answer.ok
    ? validateDecision(answer.decision, { facts: row.facts, settings, ceiling, start, toolTxs: [], paidHopsMade: 0 })
    : holdForReview(answer.cause);

  return DecisionRecord.parse({
    wallet: row.wallet,
    mode: served.mode,
    fallback: served.fallback,
    start,
    ceiling,
    requestId: reply.requestId,
    rawText: reply.rawText.slice(0, MAX_STORED_TEXT_CHARS),
    usage: reply.usage,
    verdict: answer.ok ? answer.verdict : null,
    modelAction: answer.ok ? answer.decision.action : null,
    modelRule: answer.ok ? answer.decision.rule : null,
    action: result.decision.action,
    shareBps: result.decision.shareBps,
    rule: result.decision.rule,
    reason: result.decision.reason,
    citedTxs: result.decision.citedTxs,
    clampedFrom: result.decision.clampedFrom ?? null,
    accepted: result.accepted,
    cause: result.cause ?? null,
  });
}

function timeLeft(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes}m` : `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Decides every wallet not yet in the cache, up to limit, width at a time, and stores each answer as it lands, so a run
 * can stop at any moment and resume. A wallet with no answer is not stored, so the next run asks again.
 *
 * Any error stops new work and lets running lanes finish, so nothing already paid for is lost, then the first error is
 * rethrown. OutOfCredit and ServDown are the expected ones. The run of undecided wallets is counted across all lanes,
 * in the order they finish, and any stored record resets it. Log lines hold counts only (C40).
 *
 * @returns Counts for this run: decided and undecided among the wallets tried, skipped for those already in the cache.
 * @throws RangeError when width is not from 1 to MAX_DECIDE_WIDTH, or limit is not a whole number, before any call.
 * @throws OutOfCredit on a 402, and ServDown after MAX_UNDECIDED_IN_A_ROW wallets in a row get no answer.
 */
export async function runDecisions(
  rows: ReplayRow[],
  settings: Settings,
  deps: DecideDeps,
  opts: {
    mode: 'auto' | 'v2';
    width: number;
    limit: number | undefined;
    cache: JsonlCache<DecisionRecord>;
    log(line: string): void;
  },
): Promise<{ decided: number; undecided: number; skipped: number }> {
  if (!Number.isInteger(opts.width) || opts.width < 1 || opts.width > MAX_DECIDE_WIDTH) {
    throw new RangeError(`width must be a whole number from 1 to ${MAX_DECIDE_WIDTH}`);
  }
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 0)) {
    throw new RangeError('limit must be a whole number of at least 0');
  }
  const waiting = rows.filter((row) => !opts.cache.has(row.wallet));
  const work = opts.limit === undefined ? waiting : waiting.slice(0, opts.limit);
  const startedAt = performance.now();
  let next = 0;
  let decided = 0;
  let undecided = 0;
  let undecidedInARow = 0;
  const failures: unknown[] = [];

  const lane = async () => {
    while (failures.length === 0 && next < work.length) {
      const row = work[next] as ReplayRow;
      next += 1;
      try {
        const record = await decideWallet(row, settings, deps, opts.mode);
        if (record === null) {
          undecided += 1;
          undecidedInARow += 1;
          if (undecidedInARow === MAX_UNDECIDED_IN_A_ROW) {
            failures.push(new ServDown(`${MAX_UNDECIDED_IN_A_ROW} wallets in a row got no answer from SERV`));
          }
        } else {
          opts.cache.put(row.wallet, record);
          decided += 1;
          undecidedInARow = 0;
        }
      } catch (error) {
        failures.push(error);
        return;
      }
      const finished = decided + undecided;
      if (finished % PROGRESS_EVERY_WALLETS === 0) {
        const left = ((performance.now() - startedAt) / finished) * (work.length - finished);
        const counts = `${finished.toLocaleString('en-US')}/${work.length.toLocaleString('en-US')}`;
        opts.log(`decisions: ${counts}, ${undecided.toLocaleString('en-US')} undecided, about ${timeLeft(left)} left`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.width, work.length) }, lane));

  if (failures.length > 0) throw failures[0];
  return { decided, undecided, skipped: rows.length - waiting.length };
}

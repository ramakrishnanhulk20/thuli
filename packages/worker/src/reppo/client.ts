import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import { parseVerdict, type ReppoVerdict } from '@thuli/core';
import { EnvError } from '../env.ts';
import { fetchJsonCapped, type JsonReply, type Limits } from '../http.ts';

export interface ReppoConnection {
  baseUrl: string;
  apiKey: string;
}

export interface ReppoOptions extends ReppoConnection {
  pollMs?: number;
  timeoutMs?: number;
  sleep?(ms: number): Promise<void>;
}

export interface ReppoEval {
  id: string;
  /**
   * UNFINISHED: Reppo was still working when the wait ran out. It charges when it finishes, so the id comes back for a
   * later look-up and the text is never sent again.
   */
  status: 'COMPLETED' | 'FAILED' | 'UNFINISHED';
  /** What Reppo had charged by the last reply. For an UNFINISHED evaluation the real charge comes later. */
  creditsCharged: number;
  verdict: ReppoVerdict | null;
}

export class ReppoError extends Error {
  override name = 'ReppoError';
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

/** Reppo answered 402. Nothing more can be checked until a person buys credits, and a retry would only waste time. */
export class ReppoOutOfCredit extends Error {
  override name = 'ReppoOutOfCredit';
}

// The real reply with its full evaluator trace was about 12 KB, so 1 MB only stops a flood (C41).
const LIMITS: Limits = { timeoutMs: 30_000, maxBytes: 1024 * 1024 };
const MAX_INPUT_BYTES = 50_000;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const RETRY_WAITS_MS = [2_000, 8_000, 30_000] as const;
const BUSY_WAIT_MS = 15_000;
const MAX_BUSY_RESUBMITS = 8;
// Real ids are 25 letters and digits. The id goes into a URL, so nothing wider than this gets that far.
const EVAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

const Submitted = z.object({ id: z.string().regex(EVAL_ID) });

const EvalReply = z.object({
  id: z.string(),
  status: z.enum(['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED']),
  creditsCharged: z.int().min(0),
  result: z.unknown(),
});
type EvalReply = z.infer<typeof EvalReply>;

// Same shape as BaseUrl in env.ts: https only, because the key travels as a bearer header.
const ReppoEnv = z.object({
  REPPO_API_KEY: z.string().trim().min(1),
  REPPO_BASE_URL: z.url({ protocol: /^https$/ }).transform((url) => url.replace(/\/+$/, '')),
});

/**
 * Reads the Reppo key and base URL. loadEnv cannot do this: it requires the chain and SERV variables, which a feedback
 * run does not use, and it drops every name it does not list.
 *
 * @throws EnvError naming each missing or malformed variable. The message never contains a value (C40).
 */
export function reppoConnectionFromEnv(source: Record<string, string | undefined> = process.env): ReppoConnection {
  const parsed = ReppoEnv.safeParse(source);
  if (parsed.success) return { baseUrl: parsed.data.REPPO_BASE_URL, apiKey: parsed.data.REPPO_API_KEY };
  const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
  throw new EnvError(`Missing or invalid environment variable: ${names.join(', ')}. Set it in .env (see .env.example for what goes there).`);
}

/**
 * One HTTP call, retried on a 5xx or a failed call. unanswered is true when an earlier try got no usable reply: for a
 * submit, Reppo may have taken that try without our seeing it. Reppo has no way to ask whether a lost submit landed, so
 * submit reads every refusal after such a try as one that may have been charged.
 */
async function call(
  url: string,
  init: RequestInit,
  sleep: (ms: number) => Promise<void>,
): Promise<{ reply: JsonReply; unanswered: boolean }> {
  for (let attempt = 0; ; attempt += 1) {
    let status: number | null = null;
    try {
      const reply = await fetchJsonCapped(url, init, LIMITS);
      if (reply.status < 500) return { reply, unanswered: attempt > 0 };
      status = reply.status;
    } catch {
      // fetch's own failure text can quote the URL, so nothing of it is copied (C40).
    }
    const pause = RETRY_WAITS_MS[attempt];
    if (pause === undefined) {
      throw new ReppoError(status === null ? 'the Reppo call did not finish' : `Reppo answered with status ${status}`, status);
    }
    await sleep(pause);
  }
}

/**
 * Statuses with which Reppo refuses a submit before any evaluation exists, so nothing was charged. Its own error table
 * says a 409 means another evaluation is running and none was created for this one; 400, 401, 403, 404 and 429 are
 * refusals before any work. 402 has its own error, ReppoOutOfCredit. Both submit paths read this one list, so one
 * status has one meaning in this file. Any other status, 408 and every 5xx among them, may have created a paid
 * evaluation (fail closed).
 */
export const NO_EVALUATION_CREATED: readonly number[] = [400, 401, 403, 404, 409, 429];
// Reppo is running another evaluation: the one status the retrying submit waits out.
const BUSY_STATUS = 409;

/** Reppo refused a submit with a status in NO_EVALUATION_CREATED: no evaluation was created, so nothing was charged. */
export class ReppoRefused extends ReppoError {}

/**
 * A submit that stopped before any request left, so it cannot have charged. Abstract, so every one names its kind: an
 * input that can never be sent (ReppoUnsendable), a submit stopped before its call (ReppoStoppedFirst), or a call that
 * never left this machine (ReppoUnreachable).
 */
export abstract class ReppoNotSent extends ReppoError {}

/** The input is empty or over the byte limit, so it can never be sent as it is, however often it is tried. */
export class ReppoUnsendable extends ReppoNotSent {}

/** The caller's signal was already aborted, so the submit stopped before its call. */
export class ReppoStoppedFirst extends ReppoNotSent {}

/**
 * The call failed before any request left this machine: the host name did not resolve or no connection was made. Its
 * words are fixed and hold nothing of fetch's own text, which can quote the URL (C40).
 */
export class ReppoUnreachable extends ReppoNotSent {}

// The cause codes with which fetch fails before a byte of the request is sent: no address for the host (ENOTFOUND, and
// EAI_AGAIN for a lookup that failed for now), or no connection (ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT for a connect
// that did not finish in time). Every other failure, a reset or a socket closed mid-call among them, may have sent the
// request, so it is left unclear (fail closed).
const NEVER_LEFT: readonly string[] = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'];

/**
 * True only for fetch's own TypeError whose cause carries one of the NEVER_LEFT codes. Read from the cause's code,
 * never from any message text. Not covered: a wrapper that hides the cause, which then reads as unclear. Pure.
 */
function neverLeft(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const cause: unknown = error.cause;
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return false;
  const code: unknown = cause.code;
  return typeof code === 'string' && NEVER_LEFT.includes(code);
}

function refuse(reply: JsonReply): never {
  if (reply.status === 402) throw new ReppoOutOfCredit('Reppo answered 402, so the credit balance has run out');
  if (NO_EVALUATION_CREATED.includes(reply.status)) throw new ReppoRefused(`Reppo answered with status ${reply.status}`, reply.status);
  throw new ReppoError(`Reppo answered with status ${reply.status}`, reply.status);
}

/** The message names no evaluation id: there is none we saw, and a guessed one could point a person at someone else's. */
export const SUBMIT_MAY_HAVE_LANDED =
  'a Reppo submit got no reply and a later try was refused, so a charge may have been made; this text was not sent again';

/**
 * The retrying submit behind evaluate and submitEvaluation. A 409 is waited out and sent again, at most
 * MAX_BUSY_RESUBMITS times, while every try so far was answered. Once a try got no reply (mayHaveLanded), that try may
 * have landed and been charged, so every later reply that is not OK, whatever its status, throws a plain ReppoError
 * with SUBMIT_MAY_HAVE_LANDED and the status, and the text is not sent again. It is never ReppoRefused or
 * ReppoOutOfCredit, which would say nothing was charged (C23).
 */
async function submit(input: string, conn: Required<ReppoOptions>, headers: Record<string, string>): Promise<string> {
  const init = { method: 'POST', headers, body: JSON.stringify({ taskType: 'response', input }) };
  let mayHaveLanded = false;
  for (let busy = 0; ; busy += 1) {
    const { reply, unanswered } = await call(`${conn.baseUrl}/agents/evals`, init, conn.sleep);
    mayHaveLanded ||= unanswered;
    if (reply.ok) {
      const submitted = Submitted.safeParse(reply.json);
      if (!submitted.success) throw new ReppoError('Reppo gave an evaluation id that is not safe to use', null);
      return submitted.data.id;
    }
    // A refusal speaks only for the try it answers. After a try we never heard back from, a 409 most likely means that
    // try is the evaluation running, and any other refusal says nothing about it either way.
    if (mayHaveLanded) throw new ReppoError(SUBMIT_MAY_HAVE_LANDED, reply.status);
    if (reply.status !== BUSY_STATUS) refuse(reply);
    if (busy === MAX_BUSY_RESUBMITS) throw new ReppoRefused('Reppo still had another evaluation running', BUSY_STATUS);
    await conn.sleep(BUSY_WAIT_MS);
  }
}

// Counted in polls, not by the clock, so a stalled clock or a stubbed sleep still ends the loop (C41). The last reply
// comes back when the polls run out, still queued or processing.
async function waitForEnd(id: string, conn: Required<ReppoOptions>, headers: Record<string, string>): Promise<EvalReply> {
  const polls = Math.max(Math.ceil(conn.timeoutMs / conn.pollMs), 1);
  let last: EvalReply | undefined;
  for (let poll = 0; poll < polls; poll += 1) {
    await conn.sleep(conn.pollMs);
    const { reply } = await call(`${conn.baseUrl}/agents/evals/${id}`, { headers }, conn.sleep);
    if (!reply.ok) refuse(reply);
    const body = EvalReply.safeParse(reply.json);
    if (!body.success || body.data.id !== id) throw new ReppoError('the Reppo reply did not match the evaluation shape', null);
    if (body.data.status === 'COMPLETED' || body.data.status === 'FAILED') return body.data;
    last = body.data;
  }
  return last as EvalReply;
}

const FINAL_STATUS: Record<EvalReply['status'], ReppoEval['status']> = {
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  QUEUED: 'UNFINISHED',
  PROCESSING: 'UNFINISHED',
};

// The key goes only into this header. Nothing here logs a request, and every error is words and a status (C40).
function headersFor(conn: Pick<ReppoConnection, 'apiKey'>): Record<string, string> {
  return { authorization: `Bearer ${conn.apiKey}`, 'content-type': 'application/json', accept: 'application/json' };
}

function asEval(id: string, body: EvalReply): ReppoEval {
  return {
    id,
    status: FINAL_STATUS[body.status],
    creditsCharged: body.creditsCharged,
    verdict: body.status === 'COMPLETED' ? parseVerdict(body.result) : null,
  };
}

async function submitAndWait(input: string, conn: Required<ReppoOptions>): Promise<ReppoEval> {
  const headers = headersFor(conn);
  const id = await submit(input, conn, headers);
  return asEval(id, await waitForEnd(id, conn, headers));
}

function withDefaults(opts: ReppoOptions): Required<ReppoOptions> {
  const conn: Required<ReppoOptions> = {
    pollMs: DEFAULT_POLL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    sleep: async (ms) => {
      await wait(ms);
    },
    ...opts,
  };
  if (!(conn.pollMs > 0) || !(conn.timeoutMs > 0)) throw new RangeError('pollMs and timeoutMs must be above 0');
  return conn;
}

function checkInput(input: string): void {
  if (input === '' || Buffer.byteLength(input) > MAX_INPUT_BYTES) {
    throw new ReppoUnsendable(`the input is empty or over the ${MAX_INPUT_BYTES} byte limit`, null);
  }
}

/**
 * Sends one text to Reppo as a 'response' evaluation and waits for its result, one evaluation at a time.
 *
 * A 409 means an earlier evaluation is still running, so this waits 15 seconds and resubmits, at most 8 times. A 5xx or a
 * failed call waits 2, 8 and 30 seconds. A FAILED evaluation costs nothing, so it is resubmitted once and then returned.
 * Every call has a 30 second timeout and a 1 MB reply cap (C41). An evaluation Reppo finished with a result out of shape
 * returns with verdict null, since it was still charged.
 *
 * Nothing that may already be paid for is sent twice (C23). After a submit try that got no reply or a 5xx, that try may
 * have landed, so any refusal that follows, a 409 or any other status, ends the submit with SUBMIT_MAY_HAVE_LANDED and
 * the text is not sent again. When the wait runs out, the evaluation is still running and Reppo charges it when it
 * finishes, so it returns as UNFINISHED with its id and verdict null instead of being sent again.
 *
 * @throws ReppoOutOfCredit on a 402 to a poll, or to a submit whose tries were all answered.
 * @throws ReppoError on a 400, 401 or 404 at once, on any refusal after a submit try with no reply, when the retries run
 * out, and on a reply out of shape, including an id that is not a short url-safe string, which is refused before it
 * goes in a URL. No error holds the key or the URL (C40).
 * @throws RangeError when pollMs or timeoutMs is not above 0, before any call.
 */
export async function evaluate(input: string, opts: ReppoOptions): Promise<ReppoEval> {
  const conn = withDefaults(opts);
  checkInput(input);
  const first = await submitAndWait(input, conn);
  return first.status === 'FAILED' ? submitAndWait(input, conn) : first;
}

/**
 * Submits one text as a 'response' evaluation and answers with its id at once, without waiting for the result, so the
 * caller can keep the id before any wait and every later try looks it up instead of paying again (C23). The input, 409,
 * retry and id rules are evaluate's.
 *
 * @throws ReppoOutOfCredit on a 402 to a submit whose tries were all answered; ReppoError as evaluate throws it before
 *   its wait, ReppoUnsendable among them for an input refused before any call; RangeError as evaluate does.
 */
export async function submitEvaluation(input: string, opts: ReppoOptions): Promise<string> {
  const conn = withDefaults(opts);
  checkInput(input);
  return submit(input, conn, headersFor(conn));
}

/** The words of every single-try submit whose outcome is unknown: it may have reached Reppo and been charged. */
export const SUBMIT_OUTCOME_UNKNOWN = 'the Reppo submit got no answer it could read, so it may have been charged';

// Settles with the work, or rejects as soon as the signal aborts; the work itself is left to end on its own deadline.
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Submits one text as a 'response' evaluation with exactly one POST: no retry, no resubmit on a 409, no wait. For a
 * caller that marked the submit first and must never pay twice, since Reppo cannot recognise a text sent again (C23).
 * The POST ends by timeoutMs at the latest, and an aborted signal ends the wait at once or, before the call, sends
 * nothing (C41).
 *
 * A 409 here always means another evaluation, never this text's own earlier submit: the caller marks a submit before
 * it, keeps the mark whenever a submit might have landed, and posts nothing while the mark stands. So a 409 is read as
 * NO_EVALUATION_CREATED says, the same as in the retrying submit.
 *
 * @returns the evaluation id Reppo answered with.
 * @throws ReppoOutOfCredit on a 402; ReppoRefused on a status in NO_EVALUATION_CREATED; a ReppoNotSent when nothing
 *   left: ReppoUnsendable for an input that is empty or too large, ReppoStoppedFirst for a signal aborted before the
 *   call, ReppoUnreachable for a fetch that failed with one of the NEVER_LEFT cause codes. None of these can have
 *   charged (submitCannotHaveCharged). Any other outcome, no answer, the deadline, the signal mid-call, any other fetch
 *   failure, 408, a 5xx, another status or a reply out of shape, throws a plain ReppoError: the submit may have been
 *   charged (fail closed). No error holds the key or the URL (C40).
 */
export async function submitEvaluationOnce(input: string, opts: ReppoConnection & { timeoutMs: number; signal?: AbortSignal }): Promise<string> {
  checkInput(input);
  if (!(opts.timeoutMs > 0)) throw new RangeError('timeoutMs must be above 0');
  if (opts.signal?.aborted === true) throw new ReppoStoppedFirst('the Reppo submit was not sent, because the step was told to stop first', null);
  const init = { method: 'POST', headers: headersFor(opts), body: JSON.stringify({ taskType: 'response', input }) };
  let reply: JsonReply;
  try {
    reply = await untilAborted(fetchJsonCapped(`${opts.baseUrl}/agents/evals`, init, { ...LIMITS, timeoutMs: opts.timeoutMs }), opts.signal);
  } catch (error) {
    // fetch's own failure text can quote the URL, so nothing of it is copied, and only its cause's code is read (C40).
    if (neverLeft(error)) throw new ReppoUnreachable('the Reppo submit could not reach Reppo, so nothing was sent', null);
    throw new ReppoError(SUBMIT_OUTCOME_UNKNOWN, null);
  }
  if (!reply.ok) refuse(reply);
  const submitted = Submitted.safeParse(reply.json);
  if (!submitted.success) throw new ReppoError('Reppo gave an evaluation id that is not safe to use, so it may have been charged', null);
  return submitted.data.id;
}

/**
 * True only for an error that proves no evaluation was created, so nothing was charged: out of credit, a refusal with
 * a status in NO_EVALUATION_CREATED, or a submit that never left. Read by the error's class, never by a status alone,
 * so the retrying submit's 409 after a try that may have landed stays "may have been charged". Pure.
 */
export function submitCannotHaveCharged(error: unknown): boolean {
  return error instanceof ReppoOutOfCredit || error instanceof ReppoRefused || error instanceof ReppoNotSent;
}

/**
 * Waits for one evaluation by its id with evaluate's polling, timeouts and reply checks, and submits nothing (C23): the
 * look-up for an evaluation an earlier try submitted. The id is checked before it goes into a URL.
 *
 * @returns COMPLETED, FAILED or UNFINISHED, as evaluate returns them.
 * @throws ReppoOutOfCredit on a 402; ReppoError on an id that is not safe to use, any other refusal or a reply out of
 *   shape; RangeError as evaluate does.
 */
export async function lookUpEvaluation(id: string, opts: ReppoOptions): Promise<ReppoEval> {
  const conn = withDefaults(opts);
  if (!EVAL_ID.test(id)) throw new ReppoError('the evaluation id is not safe to use', null);
  return asEval(id, await waitForEnd(id, conn, headersFor(conn)));
}

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
  status: 'COMPLETED' | 'FAILED';
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
 * One HTTP call, retried on a 5xx or a failed call. Reppo has no way to ask whether a lost submit landed, so a retried
 * submit can start a second evaluation. It is left in because a 502 is the documented "try again", and the first one,
 * if it did land, makes the retry answer 409 until it finishes.
 */
async function call(url: string, init: RequestInit, sleep: (ms: number) => Promise<void>): Promise<JsonReply> {
  for (let attempt = 0; ; attempt += 1) {
    let status: number | null = null;
    try {
      const reply = await fetchJsonCapped(url, init, LIMITS);
      if (reply.status < 500) return reply;
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

function refuse(reply: JsonReply): never {
  if (reply.status === 402) throw new ReppoOutOfCredit('Reppo answered 402, so the credit balance has run out');
  throw new ReppoError(`Reppo answered with status ${reply.status}`, reply.status);
}

async function submit(input: string, conn: Required<ReppoOptions>, headers: Record<string, string>): Promise<string> {
  const init = { method: 'POST', headers, body: JSON.stringify({ taskType: 'response', input }) };
  for (let busy = 0; ; busy += 1) {
    const reply = await call(`${conn.baseUrl}/agents/evals`, init, conn.sleep);
    if (reply.ok) {
      const submitted = Submitted.safeParse(reply.json);
      if (!submitted.success) throw new ReppoError('Reppo gave an evaluation id that is not safe to use', null);
      return submitted.data.id;
    }
    if (reply.status !== 409) refuse(reply);
    if (busy === MAX_BUSY_RESUBMITS) throw new ReppoError('Reppo still had another evaluation running', 409);
    await conn.sleep(BUSY_WAIT_MS);
  }
}

// Counted in polls, not by the clock, so a stalled clock or a stubbed sleep still ends the loop (C41).
async function waitForEnd(id: string, conn: Required<ReppoOptions>, headers: Record<string, string>): Promise<EvalReply> {
  const polls = Math.ceil(conn.timeoutMs / conn.pollMs);
  for (let poll = 0; poll < polls; poll += 1) {
    await conn.sleep(conn.pollMs);
    const reply = await call(`${conn.baseUrl}/agents/evals/${id}`, { headers }, conn.sleep);
    if (!reply.ok) refuse(reply);
    const body = EvalReply.safeParse(reply.json);
    if (!body.success || body.data.id !== id) throw new ReppoError('the Reppo reply did not match the evaluation shape', null);
    if (body.data.status === 'COMPLETED' || body.data.status === 'FAILED') return body.data;
  }
  throw new ReppoError('the Reppo evaluation did not finish in time', null);
}

async function submitAndWait(input: string, conn: Required<ReppoOptions>): Promise<ReppoEval> {
  // The key goes only into this header. Nothing here logs a request, and every error is words and a status (C40).
  const headers = { authorization: `Bearer ${conn.apiKey}`, 'content-type': 'application/json', accept: 'application/json' };
  const id = await submit(input, conn, headers);
  const body = await waitForEnd(id, conn, headers);
  return {
    id,
    status: body.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
    creditsCharged: body.creditsCharged,
    verdict: body.status === 'COMPLETED' ? parseVerdict(body.result) : null,
  };
}

/**
 * Sends one text to Reppo as a 'response' evaluation and waits for its result, one evaluation at a time.
 *
 * A 409 means an earlier evaluation is still running, so this waits 15 seconds and resubmits, at most 8 times. A 5xx or a
 * failed call waits 2, 8 and 30 seconds. A FAILED evaluation costs nothing, so it is resubmitted once and then returned.
 * Every call has a 30 second timeout and a 1 MB reply cap (C41). An evaluation Reppo finished with a result out of shape
 * returns with verdict null, since it was still charged.
 *
 * Giving up on an evaluation still running does not stop it, and Reppo charges it when it finishes.
 *
 * @throws ReppoOutOfCredit on a 402.
 * @throws ReppoError on a 400, 401 or 404 at once, when the retries or the wait run out, and on a reply out of shape,
 * including an id that is not a short url-safe string, which is refused before it goes in a URL. No error holds the key
 * or the URL (C40).
 * @throws RangeError when pollMs or timeoutMs is not above 0, before any call.
 */
export async function evaluate(input: string, opts: ReppoOptions): Promise<ReppoEval> {
  const conn: Required<ReppoOptions> = {
    pollMs: DEFAULT_POLL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    sleep: async (ms) => {
      await wait(ms);
    },
    ...opts,
  };
  if (!(conn.pollMs > 0) || !(conn.timeoutMs > 0)) throw new RangeError('pollMs and timeoutMs must be above 0');
  if (input === '' || Buffer.byteLength(input) > MAX_INPUT_BYTES) {
    throw new ReppoError(`the input is empty or over the ${MAX_INPUT_BYTES} byte limit`, null);
  }
  const first = await submitAndWait(input, conn);
  return first.status === 'FAILED' ? submitAndWait(input, conn) : first;
}

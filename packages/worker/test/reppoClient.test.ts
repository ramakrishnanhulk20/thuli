// Not covered here: a live Reppo call (every reply is a stub and no request leaves the machine), and whether a real
// timed-out or lost evaluation is charged, which only Reppo's own ledger can show.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvError } from '../src/env.ts';
import {
  evaluate,
  ReppoError,
  ReppoOutOfCredit,
  reppoConnectionFromEnv,
  SUBMIT_MAY_HAVE_LANDED,
  submitCannotHaveCharged,
  submitEvaluationOnce,
} from '../src/reppo/client.ts';

const BASE = 'https://eval.example.org/api/v1';
const KEY = 'SECRETREPPOKEY';
const ID = 'cmw5763r4000008le0b3liam7';
const RESULT = { score: 91, decision: 'accept', confidence: 'high', route: 'ship', reason: 'Fair.', trace_id: 'dropped' };

const queued = (id = ID) => ({ id, status: 'QUEUED', creditsCharged: 0, result: null });
const completed = (id = ID) => ({ id, status: 'COMPLETED', creditsCharged: 440, result: RESULT });
const failed = (id = ID) => ({ id, status: 'FAILED', creditsCharged: 0, result: null });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const sleep = vi.fn(async (_ms: number) => {});
const opts = { baseUrl: BASE, apiKey: KEY, sleep };

/** Answers each call with the next reply in the list, and fails the test on one call too many. */
function replies(...list: (Response | Error)[]) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
    const next = list.shift();
    if (next === undefined) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const waits = () => sleep.mock.calls.map(([ms]) => ms);

beforeEach(() => {
  sleep.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('evaluate', () => {
  it('submits, polls until the end, and returns the checked verdict', async () => {
    const fetchMock = replies(json(queued(), 201), json({ ...queued(), status: 'PROCESSING' }), json(completed()));
    const result = await evaluate('the text', opts);

    expect(result).toEqual({
      id: ID,
      status: 'COMPLETED',
      creditsCharged: 440,
      verdict: { score: 91, decision: 'accept', confidence: 'high', route: 'ship', reason: 'Fair.' },
    });
    const [postUrl, postInit] = fetchMock.mock.calls[0] ?? [];
    expect(postUrl).toBe(`${BASE}/agents/evals`);
    expect(postInit?.method).toBe('POST');
    expect(JSON.parse(String(postInit?.body))).toEqual({ taskType: 'response', input: 'the text' });
    expect(new Headers(postInit?.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`${BASE}/agents/evals/${ID}`);
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(waits()).toEqual([5_000, 5_000]);
  });

  it('honours pollMs', async () => {
    replies(json(queued(), 201), json(completed()));
    await evaluate('the text', { ...opts, pollMs: 250 });
    expect(waits()).toEqual([250]);
  });

  it('keeps a charged evaluation whose result is out of shape, with no verdict', async () => {
    replies(json(queued(), 201), json({ ...completed(), result: { score: 101 } }));
    await expect(evaluate('the text', opts)).resolves.toMatchObject({ status: 'COMPLETED', creditsCharged: 440, verdict: null });
  });

  it('throws ReppoOutOfCredit on a 402, and does not retry', async () => {
    const fetchMock = replies(json({ error: 'no credits' }, 402));
    await expect(evaluate('the text', opts)).rejects.toBeInstanceOf(ReppoOutOfCredit);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('waits 15 seconds on a 409 and resubmits', async () => {
    const fetchMock = replies(json({}, 409), json({}, 409), json(queued(), 201), json(completed()));
    await expect(evaluate('the text', opts)).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(waits()).toEqual([15_000, 15_000, 5_000]);
  });

  it('gives up after 8 resubmits on a 409', async () => {
    const fetchMock = replies(...Array.from({ length: 9 }, () => json({}, 409)));
    await expect(evaluate('the text', opts)).rejects.toMatchObject({ name: 'ReppoError', status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(9);
    expect(waits()).toEqual(Array.from({ length: 8 }, () => 15_000));
  });

  it.each([400, 401, 404])('throws at once on a %i from the submit', async (status) => {
    const fetchMock = replies(json({}, status));
    await expect(evaluate('the text', opts)).rejects.toMatchObject({ name: 'ReppoError', status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws at once on a 404 from a poll', async () => {
    const fetchMock = replies(json(queued(), 201), json({}, 404));
    await expect(evaluate('the text', opts)).rejects.toMatchObject({ name: 'ReppoError', status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx and a failed call with waits of 2, 8 and 30 seconds', async () => {
    replies(json({}, 502), new TypeError('fetch failed'), json({}, 500), json(queued(), 201), json(completed()));
    await expect(evaluate('the text', opts)).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(waits()).toEqual([2_000, 8_000, 30_000, 5_000]);
  });

  it('stops after the third retry and keeps the last status', async () => {
    const fetchMock = replies(json({}, 500), json({}, 500), json({}, 500), json({}, 503));
    await expect(evaluate('the text', opts)).rejects.toMatchObject({ name: 'ReppoError', status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('resubmits a FAILED evaluation once and returns the second result', async () => {
    const second = 'cmw5763r4000008le0b3liam8';
    const fetchMock = replies(json(queued(), 201), json(failed()), json(queued(second), 201), json(completed(second)));
    await expect(evaluate('the text', opts)).resolves.toMatchObject({ id: second, status: 'COMPLETED', creditsCharged: 440 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('returns a second FAILED evaluation with no verdict and no charge', async () => {
    const fetchMock = replies(json(queued(), 201), json(failed()), json(queued(), 201), json(failed()));
    await expect(evaluate('the text', opts)).resolves.toEqual({ id: ID, status: 'FAILED', creditsCharged: 0, verdict: null });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('stops polling at the timeout and returns the id it has, without sending the text again (C23)', async () => {
    const fetchMock = replies(json(queued(), 201), ...Array.from({ length: 4 }, () => json(queued())));
    await expect(evaluate('the text', { ...opts, pollMs: 5, timeoutMs: 20 })).resolves.toEqual({
      id: ID,
      status: 'UNFINISHED',
      creditsCharged: 0,
      verdict: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it.each([
    ['timed out', () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
    ['answered 502', () => json({}, 502)],
  ])('stops with one error and no third POST when the first submit %s but landed and the next gets 409 (C23)', async (_name, first) => {
    const fetchMock = replies(first(), json({}, 409), json(queued(), 201), json(completed()));
    const error = (await evaluate('the text', opts).catch((caught: unknown) => caught)) as ReppoError;
    expect(error).toBeInstanceOf(ReppoError);
    expect(error).toMatchObject({ status: 409, message: SUBMIT_MAY_HAVE_LANDED });
    expect(error.message).toContain('a charge may have been made');
    expect(error.message).not.toContain(ID);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(waits()).toEqual([2_000]);
  });

  it.each([
    ['a path', '../../admin'],
    ['a query', 'abc?x=1'],
    ['a long string', 'a'.repeat(65)],
    ['an empty string', ''],
    ['not a string', 7],
  ])('refuses an id that is %s before it goes in a URL', async (_name, id) => {
    const fetchMock = replies(json({ id, status: 'QUEUED' }, 201));
    await expect(evaluate('the text', opts)).rejects.toBeInstanceOf(ReppoError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a poll reply out of shape or about another evaluation', async () => {
    replies(json(queued(), 201), json({ ...queued(), status: 'DONE' }));
    await expect(evaluate('the text', opts)).rejects.toBeInstanceOf(ReppoError);
    replies(json(queued(), 201), json(completed('another')));
    await expect(evaluate('the text', opts)).rejects.toBeInstanceOf(ReppoError);
  });

  it('refuses an empty input and one over 50 KB, and a wait that would never end, before any call', async () => {
    const fetchMock = replies();
    await expect(evaluate('', opts)).rejects.toBeInstanceOf(ReppoError);
    await expect(evaluate('é'.repeat(25_001), opts)).rejects.toBeInstanceOf(ReppoError);
    await expect(evaluate('the text', { ...opts, pollMs: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(evaluate('the text', { ...opts, timeoutMs: Number.NaN })).rejects.toBeInstanceOf(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('puts neither the key nor the URL in any error', async () => {
    const quoting = () => new TypeError(`fetch failed for ${BASE}/agents/evals with Bearer ${KEY}`);
    const failures: (() => unknown)[] = [
      () => replies(json({ message: `bad key ${KEY}` }, 401)),
      () => replies(json({ message: `no credits for ${KEY}` }, 402)),
      () => replies(quoting(), quoting(), quoting(), quoting()),
      () => replies(json({}, 500), json({}, 500), json({}, 500), json({ message: `${BASE} ${KEY}` }, 500)),
      () => replies(json({ id: `${BASE}/${KEY}` }, 201)),
      () => replies(json(queued(), 201), json({ status: KEY })),
    ];
    for (const stub of failures) {
      stub();
      const error = (await evaluate('the text', opts).catch((caught: unknown) => caught)) as Error;
      expect(error).toBeInstanceOf(Error);
      const seen = `${error.name} ${error.message} ${String(error.stack)} ${JSON.stringify(error)}`;
      expect(seen).not.toContain(KEY);
      expect(seen).not.toContain('example.org');
    }
  });
});

describe('submitEvaluationOnce', () => {
  const once = { baseUrl: BASE, apiKey: KEY, timeoutMs: 30_000 };

  it('makes exactly one request whatever comes back, and tells a refusal that cannot have charged from one that may have', async () => {
    let fetchMock = replies(json({ id: ID }, 201));
    expect(await submitEvaluationOnce('the text', once)).toBe(ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');

    const cases: [Response | Error, boolean][] = [
      [json({}, 402), true],
      [json({}, 400), true],
      [json({}, 401), true],
      [json({}, 404), true],
      [json({}, 500), false],
      [json({}, 503), false],
      [json({}, 409), false],
      [new Error('socket hang up'), false],
      [json({ id: 'not/safe' }, 201), false],
      [new Response('not json', { status: 201 }), false],
    ];
    for (const [reply, cannotHaveCharged] of cases) {
      fetchMock = replies(reply);
      const error = await submitEvaluationOnce('the text', once).catch((caught: unknown) => caught);
      expect(error instanceof ReppoError || error instanceof ReppoOutOfCredit).toBe(true);
      expect(submitCannotHaveCharged(error)).toBe(cannotHaveCharged);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
    expect(submitCannotHaveCharged(new Error('a store failure'))).toBe(false);
  });

  it('sends nothing once its signal is aborted, and stops waiting on an abort mid-call with the outcome left unknown', async () => {
    const stopped = new AbortController();
    stopped.abort();
    const none = replies();
    const before = await submitEvaluationOnce('the text', { ...once, signal: stopped.signal }).catch((caught: unknown) => caught);
    expect(none).not.toHaveBeenCalled();
    expect(submitCannotHaveCharged(before)).toBe(false);

    const hanging = vi.fn(async (_url: string, _init?: RequestInit) => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', hanging);
    const midway = new AbortController();
    const pending = submitEvaluationOnce('the text', { ...once, signal: midway.signal }).catch((caught: unknown) => caught);
    midway.abort();
    const cut = await pending;
    expect(cut).toBeInstanceOf(ReppoError);
    expect(submitCannotHaveCharged(cut)).toBe(false);
    expect(hanging).toHaveBeenCalledTimes(1);
  });
});

describe('reppoConnectionFromEnv', () => {
  it('reads the key and base URL, and drops a trailing slash', () => {
    expect(reppoConnectionFromEnv({ REPPO_API_KEY: KEY, REPPO_BASE_URL: `${BASE}/` })).toEqual({ baseUrl: BASE, apiKey: KEY });
  });

  it('names a missing or plain http variable without printing any value', () => {
    const call = () => reppoConnectionFromEnv({ REPPO_API_KEY: ' ', REPPO_BASE_URL: 'http://eval.example.org' });
    expect(call).toThrow(EnvError);
    expect(call).toThrow(/REPPO_API_KEY, REPPO_BASE_URL/);
    expect(call).not.toThrow(/example\.org/);
  });
});

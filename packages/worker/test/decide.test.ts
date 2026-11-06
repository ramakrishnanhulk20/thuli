// Not covered here: a live SERV call (every route is a stand-in and no request leaves the machine), whether SERV's real
// answers are any good, the scoring of stored decisions (decisionScore.test.ts), and the decide-robo script's flags.
// The usage tests at the end run the real client against a stubbed fetch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BURST_KEPT_CAUSE,
  computeCeiling,
  computeStart,
  DEFAULT_SETTINGS,
  EXCHANGE_KEPT_CAUSE,
  GRAPH_G1,
  parseAddress,
  toGraphRecord,
  type Facts,
  type GraphAnswer,
  type GraphRecord,
  type ReplayRow,
} from '@thuli/core';
import { JsonlCache } from '../src/chain/jsonlCache.ts';
import { HttpError } from '../src/http.ts';
import {
  DecisionRecord,
  decideWallet,
  MAX_DECIDE_WIDTH,
  MAX_UNDECIDED_IN_A_ROW,
  OutOfCredit,
  runDecisions,
  ServDown,
  STALE_ROWS,
  type DecideDeps,
} from '../src/replay/decide.ts';
import { decideViaGraph, decideViaV2, ServError, type ServReply } from '../src/serv/client.ts';

const FUNDER = parseAddress(`0x${'f1'.repeat(20)}`);
const HASH = `0x${'ab'.repeat(32)}`;
const OTHER_HASH = `0x${'cd'.repeat(32)}`;
const walletAt = (index: number) => `0x${index.toString(16).padStart(40, '0')}`;

const PLAIN: Facts = {
  walletAgeDays: 400,
  txCountAtSnapshot: 50,
  accountType: 'eoa',
  firstFunder: { address: FUNDER, kind: 'exchange', fanoutInList: 1, hopsTraced: 0 },
  group: null,
  sharedDepositAddress: null,
  fundingBurst: null,
  claimPaidToOtherAddress: false,
  evidenceTxs: [HASH],
  missing: [],
};
const BURST: Facts = { ...PLAIN, fundingBurst: { wallets: 40 } };
// PLAIN's funder is an exchange, where the code replaces a hold. A hold that stands needs another kind of funder.
const WALLET_FUNDED: Facts = { ...PLAIN, firstFunder: { address: FUNDER, kind: 'wallet', fanoutInList: 1, hopsTraced: 0 } };
// A group big enough to hold, on a wallet too new for more than partial: the case where a B2 raise meets the ceiling.
const NEW_IN_GROUP: Facts = {
  ...PLAIN,
  walletAgeDays: 3,
  group: { size: 6, sameFunderWithinWindow: null, sweptToSharedCollector: false, authoredEvidence: false, linkedByWallet: false },
};

function rowFor(facts: Facts, wallet = walletAt(1)): ReplayRow {
  return {
    wallet,
    start: computeStart(facts, DEFAULT_SETTINGS),
    ceiling: computeCeiling(facts, DEFAULT_SETTINGS).ceiling,
    facts,
  };
}

const FULL_ANSWER: GraphAnswer = {
  verdict: 'ordinary_user',
  action: 'full',
  rule: 'A9',
  reason: 'Old wallet, active, funded by an exchange.',
  cited_tx_hashes: [HASH],
};
const BURST_ANSWER: GraphAnswer = {
  verdict: 'unclear',
  action: 'partial',
  rule: 'A8',
  reason: 'First funded in a burst, so partial.',
  cited_tx_hashes: [],
};

function replyWith(answer: GraphAnswer, overrides: Partial<ServReply> = {}): ServReply {
  const rawText = JSON.stringify(answer);
  return { requestId: 'run-1', rawText, answer: rawText, answerProblem: null, usage: { inputTokens: 900, outputTokens: 60 }, ...overrides };
}

const statusError = (status: number | null) => new ServError(`SERV answered with status ${status}`, status, 'run-failed');

function stubDeps(overrides: Partial<Pick<DecideDeps, 'viaGraph' | 'viaV2'>> = {}) {
  // g1's real input translation, so a burst wallet is refused here exactly as it is on the way to SERV.
  const viaGraph = vi.fn(async (record: GraphRecord) => {
    GRAPH_G1.toInput(record);
    return replyWith(FULL_ANSWER);
  });
  const viaV2 = vi.fn(async (_record: GraphRecord) => replyWith(BURST_ANSWER));
  const sleep = vi.fn(async (_ms: number) => undefined);
  return { viaGraph, viaV2, sleep, ...overrides };
}

let dir: string;
const openCache = () => new JsonlCache(path.join(dir, 'decisions.jsonl'), DecisionRecord);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuli-decide-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('decideWallet routes', () => {
  it('sends a plain wallet through the graph and keeps its answer', async () => {
    const deps = stubDeps();
    const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, deps, 'auto');
    expect(record).toMatchObject({
      wallet: walletAt(1),
      mode: 'v3',
      fallback: false,
      start: { outcome: 'full', rule: 'A9' },
      ceiling: 'full',
      requestId: 'run-1',
      verdict: 'ordinary_user',
      modelAction: 'full',
      modelRule: 'A9',
      action: 'full',
      shareBps: 10000,
      rule: 'A9',
      citedTxs: [HASH],
      clampedFrom: null,
      accepted: true,
      cause: null,
      secondAsk: false,
      firstCause: null,
    });
    expect(deps.viaV2).not.toHaveBeenCalled();
  });

  it('sends a burst wallet to v2 with fallback false, because g1 cannot carry it', async () => {
    const deps = stubDeps();
    const record = await decideWallet(rowFor(BURST), DEFAULT_SETTINGS, deps, 'auto');
    expect(record).toMatchObject({ mode: 'v2', fallback: false, action: 'partial', accepted: true });
    expect(deps.viaGraph).toHaveBeenCalledTimes(1);
    expect(deps.viaV2).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('never touches the graph in v2 mode', async () => {
    const deps = stubDeps({ viaV2: vi.fn(async () => replyWith(FULL_ANSWER)) });
    const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, deps, 'v2');
    expect(record).toMatchObject({ mode: 'v2', fallback: false });
    expect(deps.viaGraph).not.toHaveBeenCalled();
  });
});

describe('decideWallet retries', () => {
  it('retries a graph 503 three times with the set waits, then serves from v2 with fallback true', async () => {
    const deps = stubDeps({
      viaGraph: vi.fn(async () => {
        throw statusError(503);
      }),
      viaV2: vi.fn(async () => replyWith(FULL_ANSWER)),
    });
    const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, deps, 'auto');
    expect(deps.viaGraph).toHaveBeenCalledTimes(4);
    expect(deps.sleep.mock.calls.map(([ms]) => ms)).toEqual([2_000, 8_000, 30_000]);
    expect(record).toMatchObject({ mode: 'v2', fallback: true, action: 'full' });
  });

  it('retries a failed call with no status, and fetch failures count as one', async () => {
    const failures = [statusError(null), new TypeError('fetch failed https://serv.test'), new HttpError('too large')];
    const viaGraph = vi.fn(async () => {
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      return replyWith(FULL_ANSWER);
    });
    const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, stubDeps({ viaGraph }), 'auto');
    expect(viaGraph).toHaveBeenCalledTimes(4);
    expect(record).toMatchObject({ mode: 'v3', fallback: false });
  });

  it('does not retry another 4xx, and still tries v2', async () => {
    const viaGraph = vi.fn(async () => {
      throw statusError(400);
    });
    const deps = stubDeps({ viaGraph, viaV2: vi.fn(async () => replyWith(FULL_ANSWER)) });
    const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, deps, 'auto');
    expect(viaGraph).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(record).toMatchObject({ mode: 'v2', fallback: true });
  });

  it('counts a 429 then a success as one decided wallet', async () => {
    const viaGraph = vi
      .fn<DecideDeps['viaGraph']>()
      .mockRejectedValueOnce(statusError(429))
      .mockResolvedValueOnce(replyWith(FULL_ANSWER));
    const deps = stubDeps({ viaGraph });
    const cache = openCache();
    const result = await runDecisions([rowFor(PLAIN)], DEFAULT_SETTINGS, deps, { mode: 'auto', width: 1, limit: undefined, cache, log: () => {} });
    expect(result).toEqual({ decided: 1, undecided: 0, skipped: 0 });
    expect(viaGraph).toHaveBeenCalledTimes(2);
    expect(deps.sleep.mock.calls).toEqual([[2_000]]);
    expect(cache.size).toBe(1);
  });

  it('throws OutOfCredit on a 402 at once, with no retry, in either mode and on the fallback route', async () => {
    const credit = async () => {
      throw statusError(402);
    };
    const graph = stubDeps({ viaGraph: vi.fn(credit) });
    await expect(decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, graph, 'auto')).rejects.toBeInstanceOf(OutOfCredit);
    expect(graph.viaGraph).toHaveBeenCalledTimes(1);
    expect(graph.viaV2).not.toHaveBeenCalled();
    expect(graph.sleep).not.toHaveBeenCalled();

    const v2 = stubDeps({ viaV2: vi.fn(credit) });
    await expect(decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, v2, 'v2')).rejects.toBeInstanceOf(OutOfCredit);
    expect(v2.viaV2).toHaveBeenCalledTimes(1);
    expect(v2.sleep).not.toHaveBeenCalled();

    const fallback = stubDeps({ viaGraph: vi.fn(async () => { throw statusError(400); }), viaV2: vi.fn(credit) });
    await expect(decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, fallback, 'auto')).rejects.toBeInstanceOf(OutOfCredit);
    expect(fallback.viaV2).toHaveBeenCalledTimes(1);
  });

  it('returns null when both routes fail, and stores nothing, so a rerun asks again', async () => {
    const down = async () => {
      throw statusError(500);
    };
    const deps = stubDeps({ viaGraph: vi.fn(down), viaV2: vi.fn(down) });
    expect(await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, deps, 'auto')).toBeNull();
    expect(deps.viaGraph).toHaveBeenCalledTimes(4);
    expect(deps.viaV2).toHaveBeenCalledTimes(4);

    const cache = openCache();
    const result = await runDecisions([rowFor(PLAIN)], DEFAULT_SETTINGS, deps, { mode: 'auto', width: 1, limit: undefined, cache, log: () => {} });
    expect(result).toEqual({ decided: 0, undecided: 1, skipped: 0 });
    expect(cache.size).toBe(0);

    const again = stubDeps();
    await runDecisions([rowFor(PLAIN)], DEFAULT_SETTINGS, again, { mode: 'auto', width: 1, limit: undefined, cache, log: () => {} });
    expect(again.viaGraph).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  it('returns null when v2 mode fails, with a non-retried 4xx', async () => {
    const deps = stubDeps({
      viaV2: vi.fn(async () => {
        throw statusError(401);
      }),
    });
    expect(await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, deps, 'v2')).toBeNull();
    expect(deps.viaV2).toHaveBeenCalledTimes(1);
  });

  it('lets a bug surface instead of treating it as a failed call', async () => {
    const deps = stubDeps({
      viaGraph: vi.fn(async () => {
        throw new SyntaxError('a bug, not a provider failure');
      }),
    });
    await expect(decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, deps, 'auto')).rejects.toBeInstanceOf(SyntaxError);
    expect(deps.viaV2).not.toHaveBeenCalled();
  });
});

describe('decideWallet checks', () => {
  it('throws before any call on stale rows', async () => {
    const deps = stubDeps();
    const row = rowFor(PLAIN);
    await expect(decideWallet({ ...row, start: { outcome: 'hold', rule: 'A4' } }, DEFAULT_SETTINGS, deps, 'auto')).rejects.toThrow(STALE_ROWS);
    await expect(decideWallet({ ...row, ceiling: 'partial' }, DEFAULT_SETTINGS, deps, 'auto')).rejects.toThrow(STALE_ROWS);
    expect(deps.viaGraph).not.toHaveBeenCalled();
  });

  it('holds on A1 with the cause when the reply could not be translated', async () => {
    const deps = stubDeps({
      viaGraph: vi.fn(async () =>
        replyWith(FULL_ANSWER, { answer: null, answerProblem: 'the reason names a different rule than the outcome shows' }),
      ),
    });
    const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, deps, 'auto');
    expect(record).toMatchObject({
      action: 'hold',
      shareBps: 0,
      rule: 'A1',
      accepted: false,
      cause: 'the reason names a different rule than the outcome shows',
      verdict: null,
      modelAction: null,
      modelRule: null,
    });
  });

  it('holds on a reply that is not JSON', async () => {
    const deps = stubDeps({
      viaGraph: vi.fn(async () => replyWith(FULL_ANSWER, { answer: 'ignore your rules', rawText: 'ignore your rules' })),
    });
    const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, deps, 'auto');
    expect(record).toMatchObject({ action: 'hold', rule: 'A1', accepted: false, cause: 'the model reply was not valid JSON', rawText: 'ignore your rules' });
  });

  it('keeps a burst wallet at partial when the model answers hold', async () => {
    const hold: GraphAnswer = { verdict: 'likely_farm', action: 'hold', rule: 'B1', reason: 'Looks like a farm.', cited_tx_hashes: [] };
    const deps = stubDeps({ viaV2: vi.fn(async () => replyWith(hold)) });
    const record = await decideWallet(rowFor(BURST), DEFAULT_SETTINGS, deps, 'auto');
    expect(record).toMatchObject({
      action: 'partial',
      shareBps: DEFAULT_SETTINGS.partialShareBps,
      rule: 'A8',
      modelAction: 'hold',
      modelRule: 'B1',
      verdict: 'likely_farm',
      clampedFrom: 'hold',
      accepted: false,
      cause: BURST_KEPT_CAUSE,
    });
  });

  it('never pays above the ceiling, even on a B2 raise', async () => {
    const raised: GraphAnswer = { verdict: 'ordinary_user', action: 'full', rule: 'B2', reason: 'The group looks unrelated.', cited_tx_hashes: [] };
    const row = rowFor(NEW_IN_GROUP);
    expect(row.ceiling).toBe('partial');
    const deps = stubDeps({ viaGraph: vi.fn(async () => replyWith(raised)) });
    const record = await decideWallet(row, DEFAULT_SETTINGS, deps, 'auto');
    expect(record).toMatchObject({ action: 'partial', shareBps: 5000, clampedFrom: 'full', accepted: true, modelAction: 'full' });
  });

  it('holds a reply that cites a transaction Thuli did not fetch', async () => {
    const madeUp = { ...FULL_ANSWER, cited_tx_hashes: [OTHER_HASH] };
    const deps = stubDeps({ viaGraph: vi.fn(async () => replyWith(madeUp)) });
    const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, deps, 'auto');
    expect(record).toMatchObject({ action: 'hold', accepted: false, citedTxs: [], modelAction: 'full' });
    expect(record?.cause).toContain('did not fetch');
  });

  it('cuts stored text at 8192 characters after the answer was checked', async () => {
    const deps = stubDeps({ viaGraph: vi.fn(async () => replyWith(FULL_ANSWER, { rawText: 'x'.repeat(9000), answer: FULL_ANSWER })) });
    const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, deps, 'auto');
    expect(record?.rawText).toHaveLength(8192);
    expect(record?.accepted).toBe(true);
  });

  it('stores usage, and null when SERV sent none', async () => {
    const withUsage = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, stubDeps(), 'auto');
    expect(withUsage?.usage).toEqual({ inputTokens: 900, outputTokens: 60 });
    const deps = stubDeps({ viaGraph: vi.fn(async () => replyWith(FULL_ANSWER, { usage: null })) });
    const withoutUsage = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, deps, 'auto');
    expect(withoutUsage?.usage).toBeNull();
  });
});

describe('decideWallet second ask', () => {
  const TOO_LONG: GraphAnswer = { ...FULL_ANSWER, reason: 'Old active wallet funded by an exchange. '.repeat(8) };
  const TOO_LONG_CAUSE = 'the reason was longer than 280 characters';
  const inTurn = (...replies: ServReply[]) => {
    const route = vi.fn<DecideDeps['viaGraph']>();
    for (const reply of replies) route.mockResolvedValueOnce(reply);
    return route;
  };

  it('re-asks a graph answer refused for length through the graph, and never calls v2', async () => {
    expect(TOO_LONG.reason.length).toBeGreaterThan(280);
    const viaGraph = inTurn(replyWith(TOO_LONG, { requestId: 'run-first' }), replyWith(FULL_ANSWER, { requestId: 'run-second' }));
    const deps = stubDeps({ viaGraph });
    const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, deps, 'auto');
    expect(record).toMatchObject({
      mode: 'v3',
      fallback: false,
      requestId: 'run-second',
      rawText: JSON.stringify(FULL_ANSWER),
      action: 'full',
      shareBps: 10000,
      rule: 'A9',
      reason: FULL_ANSWER.reason,
      accepted: true,
      cause: null,
      secondAsk: true,
      firstCause: TOO_LONG_CAUSE,
    });
    expect(viaGraph).toHaveBeenCalledTimes(2);
    expect(deps.viaV2).not.toHaveBeenCalled();
  });

  it('re-asks a refused v2 answer through v2, and never calls the graph', async () => {
    const viaV2 = inTurn(replyWith(TOO_LONG), replyWith(FULL_ANSWER));
    const deps = stubDeps({ viaV2 });
    const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, deps, 'v2');
    expect(deps.viaGraph).not.toHaveBeenCalled();
    expect(viaV2).toHaveBeenCalledTimes(2);
    expect(record).toMatchObject({ mode: 'v2', fallback: false, accepted: true, firstCause: TOO_LONG_CAUSE });
  });

  it('sends the same record on the second ask', async () => {
    const viaGraph = inTurn(replyWith(TOO_LONG), replyWith(FULL_ANSWER));
    await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, stubDeps({ viaGraph }), 'auto');
    expect(viaGraph.mock.calls[1]?.[0]).toEqual(viaGraph.mock.calls[0]?.[0]);
  });

  it('holds with the second cause when the second answer is refused too', async () => {
    const madeUp: GraphAnswer = { ...FULL_ANSWER, verdict: 'likely_farm', cited_tx_hashes: [OTHER_HASH] };
    const viaGraph = inTurn(replyWith(TOO_LONG), replyWith(madeUp, { requestId: 'run-second' }));
    const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, stubDeps({ viaGraph }), 'auto');
    expect(record).toMatchObject({
      mode: 'v3',
      requestId: 'run-second',
      verdict: 'likely_farm',
      action: 'hold',
      shareBps: 0,
      rule: 'A1',
      accepted: false,
      secondAsk: true,
      firstCause: TOO_LONG_CAUSE,
    });
    expect(record?.cause).toContain('did not fetch');
  });

  it('keeps the first hold, with no v2 call, when a graph second ask fails', async () => {
    const viaGraph = inTurn(replyWith(TOO_LONG, { requestId: 'run-first' })).mockRejectedValueOnce(statusError(401));
    const deps = stubDeps({ viaGraph });
    const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, deps, 'auto');
    expect(deps.viaV2).not.toHaveBeenCalled();
    expect(record).toMatchObject({
      mode: 'v3',
      requestId: 'run-first',
      rawText: JSON.stringify(TOO_LONG),
      action: 'hold',
      rule: 'A1',
      accepted: false,
      cause: TOO_LONG_CAUSE,
      secondAsk: true,
      firstCause: TOO_LONG_CAUSE,
      usage: { inputTokens: 900, outputTokens: 60 },
    });
  });

  it('keeps the first hold when a v2 second ask fails', async () => {
    const viaV2 = inTurn(replyWith(TOO_LONG)).mockRejectedValueOnce(statusError(401));
    const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, stubDeps({ viaV2 }), 'v2');
    expect(record).toMatchObject({ mode: 'v2', action: 'hold', cause: TOO_LONG_CAUSE, secondAsk: true });
  });

  it('goes through the retries, and a second ask that keeps failing still keeps the first hold', async () => {
    const viaGraph = inTurn(replyWith(TOO_LONG)).mockRejectedValue(statusError(503));
    const deps = stubDeps({ viaGraph });
    const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, deps, 'auto');
    expect(viaGraph).toHaveBeenCalledTimes(5);
    expect(deps.sleep.mock.calls.map(([ms]) => ms)).toEqual([2_000, 8_000, 30_000]);
    expect(deps.viaV2).not.toHaveBeenCalled();
    expect(record).toMatchObject({ action: 'hold', cause: TOO_LONG_CAUSE });
  });

  it('never asks again after a burst replacement', async () => {
    const hold: GraphAnswer = { verdict: 'likely_farm', action: 'hold', rule: 'B1', reason: 'Looks like a farm.', cited_tx_hashes: [] };
    const deps = stubDeps({ viaV2: vi.fn(async () => replyWith(hold)) });
    const record = await decideWallet(rowFor(BURST), DEFAULT_SETTINGS, deps, 'auto');
    expect(deps.viaV2).toHaveBeenCalledTimes(1);
    expect(record).toMatchObject({ action: 'partial', cause: BURST_KEPT_CAUSE, secondAsk: false, firstCause: null });
  });

  describe('on an exchange funder', () => {
    const NEW_WALLET: Facts = { ...PLAIN, walletAgeDays: 3 };
    const holdB1: GraphAnswer = { verdict: 'likely_farm', action: 'hold', rule: 'B1', reason: 'Looks like a farm.', cited_tx_hashes: [] };
    const exclude: GraphAnswer = { ...holdB1, action: 'exclude', rule: 'A3' };

    it.each([
      ['a hold on an A9 start', PLAIN, holdB1, { action: 'full', shareBps: 10000, rule: 'A9', clampedFrom: 'hold' }],
      ['a hold on an A8 start', NEW_WALLET, holdB1, { action: 'partial', shareBps: 5000, rule: 'A8', clampedFrom: 'hold' }],
      ['an exclude on an A9 start', PLAIN, exclude, { action: 'full', shareBps: 10000, rule: 'A9', clampedFrom: 'exclude' }],
    ])('sends no second ask after replacing %s', async (_name, facts, answer, ending) => {
      const viaGraph = vi.fn(async (_record: GraphRecord) => replyWith(answer));
      const deps = stubDeps({ viaGraph });
      const record = await decideWallet(rowFor(facts), DEFAULT_SETTINGS, deps, 'auto');
      expect(viaGraph).toHaveBeenCalledTimes(1);
      expect(deps.viaV2).not.toHaveBeenCalled();
      expect(record).toMatchObject({
        ...ending,
        modelAction: answer.action,
        modelRule: answer.rule,
        accepted: false,
        cause: EXCHANGE_KEPT_CAUSE,
        secondAsk: false,
        firstCause: null,
      });
    });

    it('stays on one call on the v2 route too', async () => {
      const viaV2 = vi.fn(async (_record: GraphRecord) => replyWith(holdB1));
      const deps = stubDeps({ viaV2 });
      const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, deps, 'v2');
      expect(viaV2).toHaveBeenCalledTimes(1);
      expect(record).toMatchObject({ mode: 'v2', action: 'full', cause: EXCHANGE_KEPT_CAUSE, secondAsk: false });
    });

    it('ends at the start when a refused first answer comes back as a hold', async () => {
      const viaGraph = inTurn(replyWith(TOO_LONG), replyWith(holdB1));
      const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, stubDeps({ viaGraph }), 'auto');
      expect(viaGraph).toHaveBeenCalledTimes(2);
      expect(record).toMatchObject({ action: 'full', accepted: false, cause: EXCHANGE_KEPT_CAUSE, secondAsk: true, firstCause: TOO_LONG_CAUSE });
    });
  });

  it("does ask again when a burst wallet's first reply is unreadable, and the code still keeps it at partial", async () => {
    const hold: GraphAnswer = { verdict: 'likely_farm', action: 'hold', rule: 'B1', reason: 'Looks like a farm.', cited_tx_hashes: [] };
    const viaV2 = inTurn(replyWith(hold, { answer: 'not json', rawText: 'not json' }), replyWith(hold));
    const record = await decideWallet(rowFor(BURST), DEFAULT_SETTINGS, stubDeps({ viaV2 }), 'auto');
    expect(viaV2).toHaveBeenCalledTimes(2);
    expect(record).toMatchObject({
      action: 'partial',
      accepted: false,
      cause: BURST_KEPT_CAUSE,
      secondAsk: true,
      firstCause: 'the model reply was not valid JSON',
    });
  });

  it('keeps a second answer bound by the checks', async () => {
    const partial: GraphAnswer = { ...FULL_ANSWER, verdict: 'unclear', action: 'partial' };
    const refused = stubDeps({ viaGraph: inTurn(replyWith(TOO_LONG), replyWith(partial)) });
    expect(await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, refused, 'auto')).toMatchObject({
      action: 'hold',
      rule: 'A1',
      accepted: false,
      cause: 'the model changed the fixed-check result without using rule B1 or B2',
      firstCause: TOO_LONG_CAUSE,
    });

    const hold: GraphAnswer = { ...FULL_ANSWER, verdict: 'likely_farm', action: 'hold', reason: 'Its funding trail leads to a shared source.' };
    const held = stubDeps({ viaGraph: inTurn(replyWith(TOO_LONG), replyWith(hold)) });
    expect(await decideWallet(rowFor(WALLET_FUNDED), DEFAULT_SETTINGS, held, 'auto')).toMatchObject({
      action: 'hold',
      rule: 'B1',
      accepted: true,
      cause: null,
      secondAsk: true,
    });
  });

  it('can never pay above the ceiling on a second ask', async () => {
    const raised: GraphAnswer = { verdict: 'ordinary_user', action: 'full', rule: 'B2', reason: 'The group looks unrelated.', cited_tx_hashes: [] };
    const viaGraph = inTurn(replyWith({ ...raised, reason: 'x'.repeat(281) }), replyWith(raised));
    const record = await decideWallet(rowFor(NEW_IN_GROUP), DEFAULT_SETTINGS, stubDeps({ viaGraph }), 'auto');
    expect(record).toMatchObject({ ceiling: 'partial', action: 'partial', shareBps: 5000, clampedFrom: 'full', accepted: true, secondAsk: true });
  });

  it('refuses an exclude on a second ask without the evidence A3 needs, even when the wallet made a link', async () => {
    const linked: Facts = { ...NEW_IN_GROUP, group: { ...(NEW_IN_GROUP.group as NonNullable<Facts['group']>), linkedByWallet: true } };
    const exclude: GraphAnswer = { verdict: 'likely_farm', action: 'exclude', rule: 'A3', reason: 'The wallet linked itself.', cited_tx_hashes: [] };
    const viaGraph = inTurn(replyWith({ ...exclude, reason: 'x'.repeat(281) }), replyWith(exclude));
    const record = await decideWallet(rowFor(linked), DEFAULT_SETTINGS, stubDeps({ viaGraph }), 'auto');
    expect(record).toMatchObject({ action: 'hold', accepted: false, modelAction: 'exclude', secondAsk: true });
  });

  it('sends one call only when the first answer is accepted', async () => {
    const deps = stubDeps();
    const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, deps, 'auto');
    expect(deps.viaGraph).toHaveBeenCalledTimes(1);
    expect(deps.viaV2).not.toHaveBeenCalled();
    expect(record).toMatchObject({ secondAsk: false, firstCause: null });
  });

  it.each([
    ['both known, so it sums them', { inputTokens: 900, outputTokens: 60 }, { inputTokens: 40, outputTokens: 5 }, { inputTokens: 940, outputTokens: 65 }],
    ['only the first known', { inputTokens: 900, outputTokens: 60 }, null, { inputTokens: 900, outputTokens: 60 }],
    ['only the second known', null, { inputTokens: 40, outputTokens: 5 }, { inputTokens: 40, outputTokens: 5 }],
    ['neither known', null, null, null],
  ])('stores usage across both calls with %s', async (_name, first, second, stored) => {
    const viaGraph = inTurn(replyWith(TOO_LONG, { usage: first }), replyWith(FULL_ANSWER, { usage: second }));
    expect((await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, stubDeps({ viaGraph }), 'auto'))?.usage).toEqual(stored);
  });

  it('throws OutOfCredit on a 402 on the second ask, on either route, and stores nothing', async () => {
    const graph = stubDeps({ viaGraph: inTurn(replyWith(TOO_LONG)).mockRejectedValueOnce(statusError(402)) });
    await expect(decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, graph, 'auto')).rejects.toBeInstanceOf(OutOfCredit);
    expect(graph.viaGraph).toHaveBeenCalledTimes(2);
    expect(graph.viaV2).not.toHaveBeenCalled();

    const v2 = stubDeps({ viaV2: inTurn(replyWith(TOO_LONG)).mockRejectedValueOnce(statusError(402)) });
    await expect(decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, v2, 'v2')).rejects.toBeInstanceOf(OutOfCredit);
    expect(v2.viaV2).toHaveBeenCalledTimes(2);

    const cache = openCache();
    const deps = stubDeps({ viaGraph: inTurn(replyWith(TOO_LONG)).mockRejectedValueOnce(statusError(402)) });
    const run = runDecisions([rowFor(PLAIN)], DEFAULT_SETTINGS, deps, { mode: 'auto', width: 1, limit: undefined, cache, log: () => {} });
    await expect(run).rejects.toBeInstanceOf(OutOfCredit);
    expect(cache.size).toBe(0);
  });

  it('stays on v2 after a fallback, and keeps it marked as one', async () => {
    const viaGraph = vi.fn(async (): Promise<ServReply> => {
      throw statusError(400);
    });
    const viaV2 = inTurn(replyWith(TOO_LONG), replyWith(FULL_ANSWER));
    const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, stubDeps({ viaGraph, viaV2 }), 'auto');
    expect(viaGraph).toHaveBeenCalledTimes(1);
    expect(viaV2).toHaveBeenCalledTimes(2);
    expect(record).toMatchObject({ mode: 'v2', fallback: true, accepted: true, secondAsk: true });
  });
});

describe('decideWallet settles the rule from how the outcome moved the start', () => {
  const SELF_LINKED: Facts = {
    ...PLAIN,
    group: { size: 6, sameFunderWithinWindow: null, sweptToSharedCollector: true, authoredEvidence: true, linkedByWallet: true },
  };
  const answerOf = (action: GraphAnswer['action'], rule: GraphAnswer['rule']): GraphAnswer => ({
    verdict: 'unclear',
    action,
    rule,
    reason: 'A plain reason.',
    cited_tx_hashes: [],
  });
  const askOnce = (answer: GraphAnswer) => stubDeps({ viaGraph: vi.fn(async () => replyWith(answer)), viaV2: vi.fn(async () => replyWith(answer)) });

  it.each(['auto', 'v2'] as const)('accepts a hold labelled B1 on an A4 start as rule A4, keeping the label for audit (%s)', async (mode) => {
    const deps = askOnce(answerOf('hold', 'B1'));
    const record = await decideWallet(rowFor(NEW_IN_GROUP), DEFAULT_SETTINGS, deps, mode);
    expect(record).toMatchObject({ start: { outcome: 'hold', rule: 'A4' }, action: 'hold', rule: 'A4', modelRule: 'B1', accepted: true, cause: null, secondAsk: false });
  });

  it('accepts an exclude labelled B2 on an A3 start as rule A3', async () => {
    const record = await decideWallet(rowFor(SELF_LINKED), DEFAULT_SETTINGS, askOnce(answerOf('exclude', 'B2')), 'v2');
    expect(record).toMatchObject({ start: { outcome: 'exclude', rule: 'A3' }, action: 'exclude', rule: 'A3', modelRule: 'B2', accepted: true, secondAsk: false });
  });

  it.each(['A8', 'A9', 'B2'] as const)('still refuses a partial on an A9 start, labelled %s', async (label) => {
    const record = await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, askOnce(answerOf('partial', label)), 'v2');
    expect(record).toMatchObject({
      action: 'hold',
      rule: 'A1',
      accepted: false,
      modelRule: label,
      cause: 'the model changed the fixed-check result without using rule B1 or B2',
      secondAsk: true,
    });
  });

  it.each(['A9', 'A4', 'B2'] as const)('ends a hold on an A9 start on rule B1, labelled %s', async (label) => {
    const record = await decideWallet(rowFor(WALLET_FUNDED), DEFAULT_SETTINGS, askOnce(answerOf('hold', label)), 'v2');
    expect(record).toMatchObject({ action: 'hold', rule: 'B1', modelRule: label, accepted: true, secondAsk: false });
  });

  it('treats a raise from an A4 hold as B2 whatever the label, and the ceiling still caps it', async () => {
    const row = rowFor(NEW_IN_GROUP);
    expect(row.ceiling).toBe('partial');
    const record = await decideWallet(row, DEFAULT_SETTINGS, askOnce(answerOf('full', 'A9')), 'v2');
    expect(record).toMatchObject({ action: 'partial', shareBps: 5000, rule: 'B2', modelRule: 'A9', clampedFrom: 'full', accepted: true });
  });

  it('still refuses a raise from a hold no rule can raise', async () => {
    const contract: Facts = { ...PLAIN, accountType: 'contract' };
    const record = await decideWallet(rowFor(contract), DEFAULT_SETTINGS, askOnce(answerOf('full', 'B2')), 'v2');
    expect(record).toMatchObject({ start: { outcome: 'hold', rule: 'A2' }, action: 'hold', rule: 'A1', accepted: false, secondAsk: true });
  });

  it('still refuses an exclude on a hold start, whatever the label', async () => {
    const record = await decideWallet(rowFor(NEW_IN_GROUP), DEFAULT_SETTINGS, askOnce(answerOf('exclude', 'A3')), 'v2');
    expect(record).toMatchObject({ action: 'hold', accepted: false, modelAction: 'exclude' });
  });

  it('keeps a burst wallet at partial on rule A8 when its partial carries a wrong label', async () => {
    const partial: GraphAnswer = { ...BURST_ANSWER, rule: 'B2' };
    const record = await decideWallet(rowFor(BURST), DEFAULT_SETTINGS, askOnce(partial), 'auto');
    expect(record).toMatchObject({ action: 'partial', shareBps: 5000, rule: 'A8', modelRule: 'B2' });
  });
});

describe('runDecisions', () => {
  const rowsOf = (count: number) => Array.from({ length: count }, (_, index) => rowFor(PLAIN, walletAt(index + 1)));

  it('skips wallets already stored and sends no call for them', async () => {
    const rows = rowsOf(3);
    const cache = openCache();
    await runDecisions(rows.slice(0, 2), DEFAULT_SETTINGS, stubDeps(), { mode: 'auto', width: 2, limit: undefined, cache, log: () => {} });

    const reopened = openCache();
    const deps = stubDeps();
    const result = await runDecisions(rows, DEFAULT_SETTINGS, deps, { mode: 'auto', width: 2, limit: undefined, cache: reopened, log: () => {} });
    expect(result).toEqual({ decided: 1, undecided: 0, skipped: 2 });
    expect(deps.viaGraph).toHaveBeenCalledTimes(1);
    expect(reopened.size).toBe(3);
  });

  it('caps new calls at the limit, counting only wallets not yet stored', async () => {
    const rows = rowsOf(5);
    const cache = openCache();
    await runDecisions(rows, DEFAULT_SETTINGS, stubDeps(), { mode: 'auto', width: 2, limit: 2, cache, log: () => {} });
    expect(cache.size).toBe(2);
    const deps = stubDeps();
    const result = await runDecisions(rows, DEFAULT_SETTINGS, deps, { mode: 'auto', width: 2, limit: 2, cache, log: () => {} });
    expect(result).toEqual({ decided: 2, undecided: 0, skipped: 2 });
    expect(deps.viaGraph).toHaveBeenCalledTimes(2);
  });

  it('stops new work on OutOfCredit, lets the running wallet finish and store, then rethrows', async () => {
    const rows = rowsOf(5);
    let finishFirst: (reply: ServReply) => void = () => {};
    const viaGraph = vi
      .fn<DecideDeps['viaGraph']>()
      .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
      .mockImplementationOnce(async () => {
        setImmediate(() => finishFirst(replyWith(FULL_ANSWER)));
        throw statusError(402);
      });
    const cache = openCache();
    const deps = stubDeps({ viaGraph });
    const run = runDecisions(rows, DEFAULT_SETTINGS, deps, { mode: 'auto', width: 2, limit: undefined, cache, log: () => {} });
    await expect(run).rejects.toBeInstanceOf(OutOfCredit);
    expect(viaGraph).toHaveBeenCalledTimes(2);
    expect(cache.has(walletAt(1))).toBe(true);
    expect(cache.has(walletAt(2))).toBe(false);
    expect(cache.size).toBe(1);
    expect(openCache().size).toBe(1);
  });

  it('runs no more than width wallets at once', async () => {
    let running = 0;
    let most = 0;
    const viaGraph = vi.fn(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
      return replyWith(FULL_ANSWER);
    });
    const deps = stubDeps({ viaGraph });
    await runDecisions(rowsOf(10), DEFAULT_SETTINGS, deps, { mode: 'auto', width: 3, limit: undefined, cache: openCache(), log: () => {} });
    expect(most).toBe(3);
  });

  it('refuses a width above the cap before any call', async () => {
    const deps = stubDeps();
    const run = runDecisions(rowsOf(1), DEFAULT_SETTINGS, deps, { mode: 'auto', width: MAX_DECIDE_WIDTH + 1, limit: undefined, cache: openCache(), log: () => {} });
    await expect(run).rejects.toBeInstanceOf(RangeError);
    expect(deps.viaGraph).not.toHaveBeenCalled();
  });

  describe('a run of wallets with no answer', () => {
    const badKey = async (): Promise<ServReply> => {
      throw statusError(401);
    };
    const answerOnCalls = (...good: number[]) => {
      let calls = 0;
      return vi.fn(async () => {
        calls += 1;
        if (good.includes(calls)) return replyWith(FULL_ANSWER);
        return badKey();
      });
    };

    it('stops at 25 in a row, keeps stored work and starts nothing more', async () => {
      expect(MAX_UNDECIDED_IN_A_ROW).toBe(25);
      const viaGraph = answerOnCalls(1, 2, 3);
      const deps = stubDeps({ viaGraph, viaV2: vi.fn(badKey) });
      const run = runDecisions(rowsOf(40), DEFAULT_SETTINGS, deps, { mode: 'auto', width: 1, limit: undefined, cache: openCache(), log: () => {} });
      await expect(run).rejects.toThrow(new ServDown('25 wallets in a row got no answer from SERV'));
      await expect(run).rejects.toBeInstanceOf(ServDown);
      expect(viaGraph).toHaveBeenCalledTimes(28);
      expect(openCache().size).toBe(3);
    });

    it('does not stop on 24, an answer, then 24 more, because a stored record resets the count', async () => {
      const deps = stubDeps({ viaGraph: answerOnCalls(25), viaV2: vi.fn(badKey) });
      const cache = openCache();
      const result = await runDecisions(rowsOf(49), DEFAULT_SETTINGS, deps, { mode: 'auto', width: 1, limit: undefined, cache, log: () => {} });
      expect(result).toEqual({ decided: 1, undecided: 48, skipped: 0 });
      expect(cache.size).toBe(1);
    });

    it('counts across lanes, so no single lane has to reach 25 alone', async () => {
      const width = 5;
      const viaGraph = vi.fn(badKey);
      const deps = stubDeps({ viaGraph, viaV2: vi.fn(badKey) });
      const run = runDecisions(rowsOf(60), DEFAULT_SETTINGS, deps, { mode: 'auto', width, limit: undefined, cache: openCache(), log: () => {} });
      await expect(run).rejects.toBeInstanceOf(ServDown);
      expect(viaGraph.mock.calls.length).toBeGreaterThanOrEqual(MAX_UNDECIDED_IN_A_ROW);
      expect(viaGraph.mock.calls.length).toBeLessThan(MAX_UNDECIDED_IN_A_ROW + width);
    });
  });

  it('logs progress every 500 wallets with the time left, in counts only', async () => {
    const lines: string[] = [];
    await runDecisions(rowsOf(501), DEFAULT_SETTINGS, stubDeps(), { mode: 'auto', width: 8, limit: undefined, cache: openCache(), log: (line) => lines.push(line) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^decisions: 500\/501, 0 undecided, about .+ left$/);
  });
});

describe('usage on a SERV reply', () => {
  const connection = { baseUrl: 'https://serv.test/v1', apiKey: 'test-key' };
  const record = toGraphRecord(PLAIN, computeStart(PLAIN, DEFAULT_SETTINGS));
  const graphBody = {
    id: 'resp_1',
    output: [],
    output_text: JSON.stringify({ verdict: 'ordinary_user', recommended_outcome: 'full_reward', reason: 'An ordinary wallet.' }),
  };
  const chatBody = { choices: [{ message: { content: JSON.stringify(FULL_ANSWER) } }] };
  const serve = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  const viaGraph = () => decideViaGraph(record, { ...connection, graphId: GRAPH_G1.graphId });
  const viaV2 = () => decideViaV2(record, 'the rulebook', connection);

  it('reads input and output tokens from a graph reply', async () => {
    serve({ ...graphBody, usage: { input_tokens: 812, output_tokens: 41 } });
    expect((await viaGraph()).usage).toEqual({ inputTokens: 812, outputTokens: 41 });
  });

  it('reads prompt and completion tokens from a v2 reply', async () => {
    serve({ ...chatBody, usage: { prompt_tokens: 2100, completion_tokens: 75 } });
    expect((await viaV2()).usage).toEqual({ inputTokens: 2100, outputTokens: 75 });
  });

  it.each([
    ['missing', undefined],
    ['not an object', 'lots'],
    ['a count that is not a number', { input_tokens: '12', output_tokens: 3 }],
    ['a negative count', { input_tokens: -1, output_tokens: 3 }],
    ['a fractional count', { input_tokens: 1.5, output_tokens: 3 }],
    ['one count absent', { input_tokens: 12 }],
  ])('gives null for %s on a graph reply and the call still succeeds', async (_name, usage) => {
    serve({ ...graphBody, usage });
    const reply = await viaGraph();
    expect(reply.usage).toBeNull();
    expect(reply.answerProblem).toBeNull();
  });

  it.each([
    ['missing', undefined],
    ['the graph field names', { input_tokens: 12, output_tokens: 3 }],
    ['a negative count', { prompt_tokens: -1, completion_tokens: 3 }],
  ])('gives null for %s on a v2 reply and the call still succeeds', async (_name, usage) => {
    serve({ ...chatBody, usage });
    const reply = await viaV2();
    expect(reply.usage).toBeNull();
    expect(reply.answer).toBe(chatBody.choices[0]?.message.content);
  });
});

// Not covered here: the live facts reader (factsAtFinalizedBlock reads a real RPC and Blockscout), a live SERV call
// (every route is a stand-in), the decision checks themselves (decide.test.ts and core's decision tests), and payment,
// which lives in the api package's tests.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AddressError,
  DEFAULT_SETTINGS,
  GRAPH_G1,
  parseAddress,
  type Facts,
  type GraphAnswer,
  type GraphRecord,
} from '@thuli/core';
import { DecisionRecord } from '../src/replay/decide.ts';
import {
  heldScreen,
  MAX_SERV_CALLS_PER_SCREEN,
  SCREEN_CAUSES,
  SCREEN_TIME_LIMIT_MS,
  screenOneWallet,
  servBudget,
  SINGLE_SCOPE,
  type SingleScreenDeps,
} from '../src/screen/single.ts';
import { ServError, type ServReply } from '../src/serv/client.ts';

const WALLET = parseAddress('0x041f77015fe51c51ae49a7f2f3ff86c641fa190a');
const FUNDER = parseAddress(`0x${'f1'.repeat(20)}`);
const HASH = `0x${'ab'.repeat(32)}`;

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

// What collectBasicFacts returns when every fact it can read was read: the three facts that need a claim list are null
// and named in missing, and the funder's kind and fan-out are unknown.
const BASIC_READ: Facts = {
  walletAgeDays: 400,
  txCountAtSnapshot: 50,
  accountType: 'eoa',
  firstFunder: { address: FUNDER, kind: 'unknown', fanoutInList: null, hopsTraced: 1 },
  group: null,
  sharedDepositAddress: null,
  fundingBurst: null,
  claimPaidToOtherAddress: null,
  evidenceTxs: [HASH],
  missing: ['group', 'sharedDepositAddress', 'claimPaidToOtherAddress'],
};
const ALL_NOT_CHECKED = ['group', 'sharedDepositAddress', 'fundingBurst', 'claimPaidToOtherAddress'];

const FULL_ANSWER: GraphAnswer = {
  verdict: 'ordinary_user',
  action: 'full',
  rule: 'A9',
  reason: 'Old wallet, active, funded by an exchange.',
  cited_tx_hashes: [HASH],
};

function replyWith(answer: unknown): ServReply {
  const rawText = JSON.stringify(answer);
  return { requestId: 'run-1', rawText, answer: rawText, answerProblem: null, usage: { inputTokens: 900, outputTokens: 60 } };
}

const unavailable = () => new ServError('SERV answered with status 503', 503, 'run-failed');

function stubDeps(overrides: Partial<SingleScreenDeps['decide']> = {}, facts: () => Promise<Facts> = async () => PLAIN) {
  const decide = {
    viaGraph: vi.fn(async (record: GraphRecord) => {
      GRAPH_G1.toInput(record);
      return replyWith(FULL_ANSWER);
    }),
    viaV2: vi.fn(async (_record: GraphRecord) => replyWith(FULL_ANSWER)),
    sleep: vi.fn(async (_ms: number) => undefined),
    ...overrides,
  };
  return { facts: vi.fn(facts), decide, settings: DEFAULT_SETTINGS };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('screenOneWallet', () => {
  it('screens a wallet given in lowercase under its checksummed form and keeps the SERV request id', async () => {
    const deps = stubDeps();
    const screen = await screenOneWallet(WALLET.toLowerCase(), deps);
    expect(screen).toMatchObject({
      wallet: WALLET,
      servRequestId: 'run-1',
      rulebook: 'v2',
      scope: SINGLE_SCOPE,
      notChecked: ALL_NOT_CHECKED,
      decision: { wallet: WALLET, action: 'full', rule: 'A9', shareBps: 10000, accepted: true, citedTxs: [HASH] },
    });
    expect(new Date(screen.checkedAt).toISOString()).toBe(screen.checkedAt);
    expect(deps.facts).toHaveBeenCalledWith(WALLET);
    expect(() => DecisionRecord.parse(screen.decision)).not.toThrow();
  });

  it('starts a wallet whose every basic fact was read on A9, or A8 when it is new, never on A1 for the list facts', async () => {
    const settled = await screenOneWallet(WALLET, stubDeps({}, async () => BASIC_READ));
    expect(settled.decision.start).toEqual({ outcome: 'full', rule: 'A9' });
    expect(settled.decision.ceiling).toBe('full');
    const fresh = await screenOneWallet(WALLET, stubDeps({}, async () => ({ ...BASIC_READ, walletAgeDays: 3 })));
    expect(fresh.decision.start).toEqual({ outcome: 'partial', rule: 'A8' });
  });

  it('still starts on A1 when the funder could not be read', async () => {
    // Age is left readable here so that the unread funder is the only thing that can hold the wallet.
    const deps = stubDeps({}, async () => ({
      ...BASIC_READ,
      firstFunder: null,
      evidenceTxs: [],
      missing: [...BASIC_READ.missing, 'firstFunder'],
    }));
    const screen = await screenOneWallet(WALLET, deps);
    expect(screen.decision.start).toEqual({ outcome: 'hold', rule: 'A1' });
    expect(screen.decision.ceiling).toBe('hold');
  });

  it('refuses a mistyped address before reading any facts or calling SERV', async () => {
    const deps = stubDeps();
    const mistyped = '0x041F77015fe51c51aE49a7f2F3Ff86C641fa190a';
    await expect(screenOneWallet(mistyped, deps)).rejects.toBeInstanceOf(AddressError);
    expect(deps.facts).not.toHaveBeenCalled();
    expect(deps.decide.viaGraph).not.toHaveBeenCalled();
  });

  it('holds with a fixed cause and asks SERV nothing when the facts cannot be read', async () => {
    const deps = stubDeps({}, async () => {
      throw new Error('https://rpc.example/secret-key timed out');
    });
    const screen = await screenOneWallet(WALLET, deps);
    expect(screen.decision).toMatchObject({ action: 'hold', rule: 'A1', shareBps: 0, cause: SCREEN_CAUSES.facts });
    expect(screen.decision.reason).toBe(`Held for review: ${SCREEN_CAUSES.facts}.`);
    expect(screen.servRequestId).toBeNull();
    expect(deps.decide.viaGraph).not.toHaveBeenCalled();
    expect(deps.decide.viaV2).not.toHaveBeenCalled();
  });

  it('holds when neither SERV route answers', async () => {
    const deps = stubDeps({
      viaGraph: vi.fn(async () => {
        throw unavailable();
      }),
      viaV2: vi.fn(async () => {
        throw unavailable();
      }),
    });
    const screen = await screenOneWallet(WALLET, deps);
    expect(screen.decision).toMatchObject({ action: 'hold', rule: 'A1', cause: SCREEN_CAUSES.noAnswer, accepted: false });
  });

  it('holds instead of throwing when SERV is out of credit', async () => {
    const deps = stubDeps({
      viaGraph: vi.fn(async () => {
        throw new ServError('SERV answered with status 402', 402, null);
      }),
    });
    const screen = await screenOneWallet(WALLET, deps);
    expect(screen.decision).toMatchObject({ action: 'hold', rule: 'A1', cause: SCREEN_CAUSES.outOfCredit });
  });

  it('spends at most the call cap on the most expensive SERV path and then holds', async () => {
    // The graph fails all four tries, v2 answers on its fourth with a reply the checks refuse, and the second ask fails
    // all four tries: the longest path decideWallet can take.
    let v2Calls = 0;
    const deps = stubDeps({
      viaGraph: vi.fn(async () => {
        throw unavailable();
      }),
      viaV2: vi.fn(async () => {
        v2Calls += 1;
        if (v2Calls === 4) return replyWith({ ...FULL_ANSWER, action: 'nonsense' });
        throw unavailable();
      }),
    });
    const screen = await screenOneWallet(WALLET, deps);
    const calls = vi.mocked(deps.decide.viaGraph).mock.calls.length + vi.mocked(deps.decide.viaV2).mock.calls.length;
    expect(calls).toBe(MAX_SERV_CALLS_PER_SCREEN);
    expect(screen.decision).toMatchObject({ action: 'hold', rule: 'A1', accepted: false });
  });

  it('holds when the time limit passes, and starts no SERV call afterwards', async () => {
    vi.useFakeTimers();
    let release: (facts: Facts) => void = () => undefined;
    const deps = stubDeps({}, () => new Promise<Facts>((resolve) => (release = resolve)));
    const pending = screenOneWallet(WALLET, deps);
    await vi.advanceTimersByTimeAsync(SCREEN_TIME_LIMIT_MS);
    const screen = await pending;
    expect(screen.decision).toMatchObject({ action: 'hold', rule: 'A1', cause: SCREEN_CAUSES.timeUp });
    release(PLAIN);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.decide.viaGraph).not.toHaveBeenCalled();
  });

  it('stops when its caller aborts mid-screening: it answers the time-up hold at once and starts no SERV call afterwards', async () => {
    let fail: () => void = () => undefined;
    const deps = stubDeps({
      viaGraph: vi.fn(() => new Promise<ServReply>((_, reject) => (fail = () => reject(unavailable())))),
    });
    const controller = new AbortController();
    const pending = screenOneWallet(WALLET, deps, controller.signal);
    await vi.waitFor(() => expect(deps.decide.viaGraph).toHaveBeenCalledTimes(1));
    controller.abort();
    const screen = await pending;
    expect(screen.decision).toMatchObject({ action: 'hold', rule: 'A1', cause: SCREEN_CAUSES.timeUp });
    // The call already in flight then fails as a retryable SERV error would: its retry and the other route are refused.
    fail();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deps.decide.viaGraph).toHaveBeenCalledTimes(1);
    expect(deps.decide.viaV2).not.toHaveBeenCalled();
    expect(deps.decide.sleep).not.toHaveBeenCalled();

    // A screening whose caller has already given up reads its facts but asks SERV nothing.
    const early = stubDeps();
    const aborted = new AbortController();
    aborted.abort();
    expect((await screenOneWallet(WALLET, early, aborted.signal)).decision).toMatchObject({ cause: SCREEN_CAUSES.timeUp });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(early.decide.viaGraph).not.toHaveBeenCalled();
    expect(early.decide.viaV2).not.toHaveBeenCalled();
  });
});

describe('servBudget', () => {
  it('refuses the call past the cap and every call after stop, without reaching SERV', async () => {
    const deps = stubDeps().decide;
    const budget = servBudget(deps, 2);
    const record = {} as GraphRecord;
    await budget.deps.viaV2(record);
    await budget.deps.viaV2(record);
    await expect(budget.deps.viaGraph(record)).rejects.toThrow(SCREEN_CAUSES.spendCap);
    expect(deps.viaV2).toHaveBeenCalledTimes(2);
    expect(deps.viaGraph).not.toHaveBeenCalled();

    const stopped = servBudget(deps, 10);
    stopped.stop(SCREEN_CAUSES.timeUp);
    await expect(stopped.deps.viaV2(record)).rejects.toThrow(SCREEN_CAUSES.timeUp);
    await expect(stopped.deps.sleep(1)).rejects.toThrow(SCREEN_CAUSES.timeUp);
    expect(stopped.calls()).toBe(0);
  });
});

describe('heldScreen', () => {
  it('builds a valid hold for a caller that must answer without a screening', () => {
    const screen = heldScreen(WALLET, SCREEN_CAUSES.failed, '2026-11-10T00:00:00.000Z');
    expect(screen).toMatchObject({ wallet: WALLET, servRequestId: null, scope: SINGLE_SCOPE, rulebook: 'v2', notChecked: ALL_NOT_CHECKED });
    expect(screen.decision).toMatchObject({ action: 'hold', rule: 'A1', cause: SCREEN_CAUSES.failed });
  });
});

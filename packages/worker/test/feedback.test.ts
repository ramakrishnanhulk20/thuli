// Not covered here: the feedback-reppo script's flags and file reading (its --dry-run is the check for those), the payload
// wording (core reppo.test.ts), and the HTTP side (reppoClient.test.ts). Every evaluation here is a stand-in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeCeiling,
  computeStart,
  DEFAULT_SETTINGS,
  parseAddress,
  reppoInput,
  ReppoPayloadError,
  type Facts,
  type GraphRecord,
  type ReplayRow,
  type ReppoVerdict,
} from '@thuli/core';
import { JsonlCache } from '../src/chain/jsonlCache.ts';
import type { DecisionRecord } from '../src/replay/decide.ts';
import { ReppoOutOfCredit, type ReppoEval } from '../src/reppo/client.ts';
import { FeedbackEntry, feedbackItem, namesOtherVersion, runFeedback, type FeedbackItem } from '../src/reppo/feedback.ts';

const RECORD: GraphRecord = {
  start_outcome: 'full',
  start_rule: 'A9',
  wallet_age_days: 324,
  tx_count: 16,
  account_type: 'eoa',
  first_funder_kind: 'exchange',
  first_funder_claim_wallets: 3,
  traced_funder_kind: 'none',
  traced_funder_claim_wallets: null,
  group_size: 0,
  group_same_funder: null,
  group_swept_to_shared_collector: false,
  group_links_made_by_wallet: false,
  shared_deposit_claimants: 0,
  funding_burst_wallets: 0,
  claim_paid_to_other_address: false,
  evidence_tx_hashes: [],
  unreadable_facts: [],
};

const walletAt = (index: number) => `0x${index.toString(16).padStart(40, '0')}`;
const item = (index: number, overrides: Partial<FeedbackItem> = {}): FeedbackItem => ({
  wallet: walletAt(index),
  set: 'robo',
  group: 'contested',
  record: RECORD,
  action: 'full',
  rule: 'A9',
  reason: `A9: Reason number ${index}.`,
  ...overrides,
});

const verdict = (decision: ReppoVerdict['decision']): ReppoVerdict => ({
  score: decision === 'accept' ? 90 : 40,
  decision,
  confidence: 'high',
  route: decision === 'accept' ? 'ship' : 'block',
  reason: 'Checked.',
});

const completed = (decision: ReppoVerdict['decision']): ReppoEval => ({
  id: 'eval1',
  status: 'COMPLETED',
  creditsCharged: 440,
  verdict: verdict(decision),
});

let dir: string;
let file: string;
const open = () => new JsonlCache(file, FeedbackEntry);
const logLines: string[] = [];
const options = (cache: JsonlCache<FeedbackEntry>, limit?: number) => ({
  rulebook: 'v1',
  limit,
  cache,
  log: (line: string) => logLines.push(line),
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuli-feedback-'));
  file = path.join(dir, 'reppo.jsonl');
  logLines.length = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('runFeedback', () => {
  it('stores each result as it lands, with the exact payload sent', async () => {
    const evaluate = vi.fn(async (_input: string) => completed('accept'));
    const cache = open();
    await expect(runFeedback([item(1)], { evaluate }, options(cache))).resolves.toEqual({
      sent: 1,
      disagreed: 0,
      failed: 0,
      unfinished: 0,
      skipped: 0,
      creditsCharged: 440,
    });

    const stored = open().get(`v1:robo:${walletAt(1)}`);
    expect(stored).toMatchObject({ wallet: walletAt(1), set: 'robo', group: 'contested', rulebook: 'v1', evalId: 'eval1', action: 'full', rule: 'A9' });
    expect(stored?.input).toBe(evaluate.mock.calls[0]?.[0]);
    expect(stored?.input).toContain('Reason: Reason number 1.');
  });

  it('sends one at a time, in order', async () => {
    let running = 0;
    let most = 0;
    const evaluate = vi.fn(async () => {
      running += 1;
      most = Math.max(most, running);
      await Promise.resolve();
      running -= 1;
      return completed('accept');
    });
    await runFeedback([item(1), item(2), item(3)], { evaluate }, options(open()));
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(most).toBe(1);
  });

  it('skips stored wallets on a resume, and spends nothing on them', async () => {
    await runFeedback([item(1), item(2)], { evaluate: async () => completed('accept') }, options(open()));

    const evaluate = vi.fn(async () => completed('accept'));
    const counts = await runFeedback([item(1), item(2), item(3)], { evaluate }, options(open()));
    expect(counts).toMatchObject({ sent: 1, skipped: 2 });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('counts limit against wallets not stored yet', async () => {
    await runFeedback([item(1)], { evaluate: async () => completed('accept') }, options(open()));

    const evaluate = vi.fn(async () => completed('accept'));
    const counts = await runFeedback([item(1), item(2), item(3), item(4)], { evaluate }, options(open(), 2));
    expect(counts).toMatchObject({ sent: 2, skipped: 1 });
    expect(open().size).toBe(3);
  });

  it('sends a wallet listed twice only once', async () => {
    const evaluate = vi.fn(async () => completed('accept'));
    await expect(runFeedback([item(1), item(1)], { evaluate }, options(open()))).resolves.toMatchObject({ sent: 1, skipped: 1 });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('treats one wallet in both sets, or under a new rulebook, as separate decisions', async () => {
    const evaluate = vi.fn(async () => completed('accept'));
    await runFeedback([item(1), item(1, { set: 'hop' })], { evaluate }, options(open()));
    expect(evaluate).toHaveBeenCalledTimes(2);

    await runFeedback([item(1)], { evaluate }, { ...options(open()), rulebook: 'v2' });
    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  it('stores one list under v1-recheck and v2 with no clash, and a rerun of either pays nothing', async () => {
    const evaluate = vi.fn(async () => completed('accept'));
    const list = [item(1), item(2)];
    await runFeedback(list, { evaluate }, { ...options(open()), rulebook: 'v1-recheck' });
    await runFeedback(list, { evaluate }, { ...options(open()), rulebook: 'v2' });
    expect(evaluate).toHaveBeenCalledTimes(4);

    const stored = open();
    expect(stored.size).toBe(4);
    expect(stored.get(`v1-recheck:robo:${walletAt(1)}`)?.rulebook).toBe('v1-recheck');
    expect(stored.get(`v2:robo:${walletAt(1)}`)?.rulebook).toBe('v2');

    await runFeedback(list, { evaluate }, { ...options(open()), rulebook: 'v1-recheck' });
    await runFeedback(list, { evaluate }, { ...options(open()), rulebook: 'v2' });
    expect(evaluate).toHaveBeenCalledTimes(4);
  });

  it('stops on out of credit, keeps finished work, and rethrows', async () => {
    const evaluate = vi
      .fn<() => Promise<ReppoEval>>()
      .mockResolvedValueOnce(completed('accept'))
      .mockRejectedValueOnce(new ReppoOutOfCredit('out of credit'));
    await expect(runFeedback([item(1), item(2), item(3)], { evaluate }, options(open()))).rejects.toBeInstanceOf(ReppoOutOfCredit);

    expect(evaluate).toHaveBeenCalledTimes(2);
    const kept = open();
    expect(kept.size).toBe(1);
    expect(kept.has(`v1:robo:${walletAt(1)}`)).toBe(true);

    const resumed = vi.fn(async () => completed('accept'));
    await expect(runFeedback([item(1), item(2), item(3)], { evaluate: resumed }, options(open()))).resolves.toMatchObject({ sent: 2, skipped: 1 });
  });

  it.each([
    ['a reject', completed('reject'), true],
    ['an accept', completed('accept'), false],
    ['a charged result out of shape', { ...completed('accept'), verdict: null }, false],
  ])('sets disagrees for %s', async (_name, result, expected) => {
    const counts = await runFeedback([item(1)], { evaluate: async () => result }, options(open()));
    expect(open().get(`v1:robo:${walletAt(1)}`)?.disagrees).toBe(expected);
    expect(counts.disagreed).toBe(expected ? 1 : 0);
  });

  it('stores a paid result out of shape, so a rerun does not pay for it twice', async () => {
    const result: ReppoEval = { ...completed('accept'), verdict: null };
    await runFeedback([item(1)], { evaluate: async () => result }, options(open()));
    expect(open().get(`v1:robo:${walletAt(1)}`)).toMatchObject({ verdict: null, creditsCharged: 440 });
  });

  it('stores an UNFINISHED evaluation with its id, apart from a null verdict, and a rerun does not pay for it again (C23)', async () => {
    const unfinished: ReppoEval = { id: 'eval3', status: 'UNFINISHED', creditsCharged: 0, verdict: null };
    const outOfShape: ReppoEval = { ...completed('accept'), id: 'eval4', verdict: null };
    const evaluate = vi.fn<() => Promise<ReppoEval>>().mockResolvedValueOnce(unfinished).mockResolvedValueOnce(outOfShape);
    const counts = await runFeedback([item(1), item(2)], { evaluate }, options(open()));
    expect(counts).toMatchObject({ sent: 2, unfinished: 1, failed: 0, disagreed: 0 });
    expect(logLines.at(-1)).toBe('feedback: 2/2 sent, 0 disagreed, 0 failed, 1 unfinished');

    const stored = open();
    expect(stored.get(`v1:robo:${walletAt(1)}`)).toMatchObject({ evalId: 'eval3', status: 'UNFINISHED', verdict: null, disagrees: false });
    expect(stored.get(`v1:robo:${walletAt(2)}`)).toMatchObject({ evalId: 'eval4', status: 'COMPLETED', verdict: null });

    const again = vi.fn(async () => completed('accept'));
    await expect(runFeedback([item(1), item(2)], { evaluate: again }, options(open()))).resolves.toMatchObject({ sent: 0, skipped: 2 });
    expect(again).not.toHaveBeenCalled();
  });

  it('still reads an entry stored before entries carried a status', () => {
    const older = { wallet: walletAt(1), set: 'robo', group: 'g', rulebook: 'v1', evalId: 'eval1', input: 'x', action: 'full', rule: 'A9' };
    expect(FeedbackEntry.safeParse({ ...older, verdict: verdict('accept'), creditsCharged: 440, disagrees: false }).success).toBe(true);
  });

  it('does not store a FAILED evaluation, so a rerun asks again for free', async () => {
    const failed: ReppoEval = { id: 'eval2', status: 'FAILED', creditsCharged: 0, verdict: null };
    const counts = await runFeedback([item(1)], { evaluate: async () => failed }, options(open()));
    expect(counts).toMatchObject({ sent: 1, failed: 1, creditsCharged: 0 });
    expect(open().size).toBe(0);

    const evaluate = vi.fn(async () => completed('accept'));
    await runFeedback([item(1)], { evaluate }, options(open()));
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('refuses a bad payload before the first call, with nothing spent', async () => {
    const evaluate = vi.fn(async () => completed('accept'));
    const leaky = item(2, { record: { ...RECORD, tx_count: 1_234_567_890_123_456 } });
    await expect(runFeedback([item(1), leaky], { evaluate }, options(open()))).rejects.toBeInstanceOf(ReppoPayloadError);
    expect(evaluate).not.toHaveBeenCalled();
    expect(open().size).toBe(0);
  });

  it('refuses a bad limit before any call', async () => {
    const evaluate = vi.fn(async () => completed('accept'));
    await expect(runFeedback([item(1)], { evaluate }, options(open(), -1))).rejects.toBeInstanceOf(RangeError);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('logs counts only', async () => {
    await runFeedback([item(1)], { evaluate: async () => completed('reject') }, options(open()));
    expect(logLines).toEqual(['feedback: 1/1 sent, 1 disagreed, 0 failed, 0 unfinished']);
    expect(logLines.join()).not.toContain('0x');
  });
});

describe('feedbackItem', () => {
  const FACTS: Facts = {
    walletAgeDays: 324,
    txCountAtSnapshot: 16,
    accountType: 'eoa',
    firstFunder: { address: parseAddress(`0x${'f1'.repeat(20)}`), kind: 'contract', fanoutInList: 63, hopsTraced: 0 },
    group: null,
    sharedDepositAddress: null,
    fundingBurst: null,
    claimPaidToOtherAddress: false,
    evidenceTxs: [],
    missing: [],
  };
  const start = computeStart(FACTS, DEFAULT_SETTINGS);
  const ceiling = computeCeiling(FACTS, DEFAULT_SETTINGS).ceiling;
  const ROW: ReplayRow = { wallet: walletAt(1), start, ceiling, facts: FACTS };
  const STORED: DecisionRecord = {
    wallet: walletAt(1),
    mode: 'v3',
    fallback: false,
    start,
    ceiling,
    requestId: 'run-1',
    // A graph g1 reply holding the wallet on its funder count alone, which rulebook 2 replaces with the start.
    rawText: JSON.stringify({
      verdict: 'likely_farm',
      recommended_outcome: 'hold_for_review',
      reason: 'The contract first funder also funded 62 claim wallets.',
    }),
    usage: null,
    verdict: 'likely_farm',
    modelAction: 'hold',
    modelRule: 'B1',
    action: 'hold',
    shareBps: 0,
    rule: 'B1',
    reason: 'The contract first funder also funded 62 claim wallets.',
    citedTxs: [],
    clampedFrom: null,
    accepted: true,
    cause: null,
    secondAsk: false,
    firstCause: null,
  };
  const LISTED = { wallet: walletAt(1), set: 'robo', group: 'contract-hold' } as const;

  it('sends the stored decision as it stands without --use-v2', () => {
    const built = feedbackItem(LISTED, ROW, STORED, { useV2: false, settings: DEFAULT_SETTINGS });
    expect(built).toMatchObject({ ...LISTED, action: 'hold', rule: 'B1', reason: STORED.reason });
  });

  it('sends what v2 decided with --use-v2, in the payload as well as the item', () => {
    const built = feedbackItem(LISTED, ROW, STORED, { useV2: true, settings: DEFAULT_SETTINGS });
    expect(built).toMatchObject({ ...LISTED, action: 'full', rule: 'A9' });
    const input = reppoInput(built.record, built.action, built.reason);
    expect(input).toContain("Decision: full reward. Reason: No funding trail was traced and this wallet made no links of its own, so the code's start stands.");
  });
});

describe('namesOtherVersion', () => {
  it.each([
    ['v1', false, false],
    ['v1-recheck', false, false],
    ['v2', true, false],
    ['v2-recheck', true, false],
    ['nov-sample', false, false],
    ['nov-sample', true, false],
    ['v1', true, true],
    ['v1-recheck', true, true],
    ['v2', false, true],
  ])('reads %s with useV2 %s as %s', (rulebook, useV2, clash) => {
    expect(namesOtherVersion(rulebook, useV2)).toBe(clash);
  });
});

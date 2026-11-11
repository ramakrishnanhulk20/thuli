// Not covered here: live SERV (the script's run is the live measurement), reading the private rows and decisions files,
// the run log on disk and its resume, and whether the public addresses are in the replay shards; the script checks that
// against packages/web/public/replay before it writes them.
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type GraphRecord, type Outcome, type ReplayRow } from '@thuli/core';
import {
  ceilingViolated,
  ConsistencyFile,
  fixedByCode,
  mostCommonCount,
  publicFile,
  rateOf,
  sampleWallets,
  scoreConsistency,
  spendGuard,
  spendLimit,
  stoppedBySpendGuard,
  stratumOf,
  type RunLine,
  type SampledWallet,
  type Stratum,
} from '../src/replay/consistency.ts';
import { decideWallet } from '../src/replay/decide.ts';
import { MAX_SERV_CALLS_PER_SCREEN } from '../src/screen/single.ts';
import type { ServReply } from '../src/serv/client.ts';

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

function candidates(perStratum: number): { wallet: string; stratum: Stratum }[] {
  const strata: Stratum[] = ['full', 'partial', 'modelHold'];
  return strata.flatMap((stratum, s) => Array.from({ length: perStratum }, (_, n) => ({ wallet: wallet(s * 1000 + n + 1), stratum })));
}

function line(target: SampledWallet, run: number, action: Outcome | null, overrides: Partial<RunLine> = {}): RunLine {
  return {
    seed: 11,
    wallets: 3,
    runs: 5,
    wallet: target.wallet,
    stratum: target.stratum,
    run,
    answered: action !== null,
    action,
    rule: action === null ? null : 'A9',
    mode: action === null ? null : 'v3',
    fallback: action === null ? null : false,
    replaced: action === null ? null : false,
    clamped: action === null ? null : false,
    requestId: action === null ? null : `run-${run}`,
    calls: 1,
    start: 'full',
    ceiling: 'full',
    ceilingViolation: false,
    at: '2026-11-11T12:00:00.000Z',
    ...overrides,
  };
}

describe('the seeded stratified sample', () => {
  it('draws the same wallets for the same seed, other wallets for another, and a third from each stratum', () => {
    const pool = candidates(50);
    const first = sampleWallets(pool, 30, 11);
    expect(sampleWallets(pool, 30, 11)).toEqual(first);
    expect(sampleWallets(pool, 30, 12)).not.toEqual(first);
    expect(first).toHaveLength(30);
    for (const stratum of ['full', 'partial', 'modelHold']) expect(first.filter((one) => one.stratum === stratum)).toHaveLength(10);
    expect(new Set(first.map((one) => one.wallet)).size).toBe(30);
    // A share that does not divide by three goes to the first strata, and a short stratum gives what it has.
    const uneven = sampleWallets([...candidates(50).filter((one) => one.stratum !== 'modelHold'), ...candidates(4).filter((one) => one.stratum === 'modelHold')], 32, 11);
    expect(['full', 'partial', 'modelHold'].map((stratum) => uneven.filter((one) => one.stratum === stratum).length)).toEqual([11, 11, 4]);
  });

  it('puts a wallet in a stratum by its stored outcome, and skips those the code alone fixed', () => {
    expect(stratumOf({ start: { outcome: 'full', rule: 'A9' }, ceiling: 'full', action: 'full' })).toBe('full');
    expect(stratumOf({ start: { outcome: 'partial', rule: 'A8' }, ceiling: 'partial', action: 'partial' })).toBe('partial');
    expect(stratumOf({ start: { outcome: 'partial', rule: 'A8' }, ceiling: 'partial', action: 'hold' })).toBe('modelHold');
    expect(stratumOf({ start: { outcome: 'full', rule: 'A9' }, ceiling: 'full', action: 'hold' })).toBe('modelHold');
    // A hold the code's start already gave is not one the model made.
    expect(stratumOf({ start: { outcome: 'hold', rule: 'A4' }, ceiling: 'full', action: 'hold' })).toBeNull();
    // A ceiling of hold or exclude leaves no reply anything to move, so repeating it measures nothing.
    expect(fixedByCode({ ceiling: 'hold' })).toBe(true);
    expect(fixedByCode({ ceiling: 'exclude' })).toBe(true);
    expect(fixedByCode({ ceiling: 'partial' })).toBe(false);
    expect(stratumOf({ start: { outcome: 'partial', rule: 'A8' }, ceiling: 'hold', action: 'hold' })).toBeNull();
    expect(stratumOf({ start: { outcome: 'exclude', rule: 'A3' }, ceiling: 'exclude', action: 'exclude' })).toBeNull();
  });
});

describe('scoring the runs', () => {
  const sample: SampledWallet[] = [
    { wallet: wallet(1), stratum: 'full', stored: 'full' },
    { wallet: wallet(2), stratum: 'partial', stored: 'partial' },
    { wallet: wallet(3), stratum: 'modelHold', stored: 'hold' },
  ];

  it('counts the most common action, a tie included', () => {
    expect(mostCommonCount(['full', 'full', 'full', 'full', 'full'])).toBe(5);
    expect(mostCommonCount(['full', 'full', 'hold', 'full', 'full'])).toBe(4);
    expect(mostCommonCount(['full', 'hold', 'full', 'hold', 'partial'])).toBe(2);
    expect(mostCommonCount([])).toBe(0);
  });

  it('scores all-same, one-differs and a tie, against the stored outcome, with replaced answers, routes and calls', () => {
    const [same, oneOff, tie] = sample as [SampledWallet, SampledWallet, SampledWallet];
    const lines = [
      ...[1, 2, 3, 4, 5].map((run) => line(same, run, 'full')),
      ...(['partial', 'partial', 'hold', 'partial', 'partial'] as const).map((action, i) =>
        line(oneOff, i + 1, action, action === 'hold' ? { replaced: true, rule: 'A1', mode: 'v2', fallback: true } : { mode: 'v2' }),
      ),
      ...(['hold', 'full', 'hold', 'full', 'partial'] as const).map((action, i) => line(tie, i + 1, action)),
      // A try with no answer is paid for but never scored.
      line(tie, 6, null, { calls: 8 }),
    ];
    const scores = scoreConsistency(sample, lines, 5);
    expect(scores.overall.allSame).toMatchObject({ count: 1, total: 3 });
    expect(scores.overall.matchMode).toMatchObject({ count: 5 + 4 + 2, total: 15 });
    expect(scores.overall.matchStored).toMatchObject({ count: 5 + 4 + 2, total: 15 });
    expect(scores.overall.replaced).toMatchObject({ count: 1, total: 15 });
    expect(scores.overall.routes).toEqual({ graph: 10, v2: 5, fallback: 1 });
    expect(scores.overall.servCalls).toBe(15 + 8);
    expect(scores.strata.full).toMatchObject({ wallets: 1, runs: 5, allSame: { count: 1, total: 1 } });
    expect(scores.strata.partial).toMatchObject({ allSame: { count: 0, total: 1 }, matchMode: { count: 4, total: 5 } });
    expect(scores.strata.modelHold).toMatchObject({ matchMode: { count: 2, total: 5 }, matchStored: { count: 2, total: 5 }, servCalls: 13 });
    expect(scores.samples.map((one) => one.actions)).toEqual([
      ['full', 'full', 'full', 'full', 'full'],
      ['partial', 'partial', 'hold', 'partial', 'partial'],
      ['hold', 'full', 'hold', 'full', 'partial'],
    ]);
  });

  it('leaves a wallet short of its runs out of the all-same count, and counts ceiling violations', () => {
    const [same] = sample as [SampledWallet];
    const lines = [line(same, 1, 'full'), line(same, 2, 'full', { ceilingViolation: true })];
    const scores = scoreConsistency(sample, lines, 5);
    expect(scores.overall.allSame).toMatchObject({ count: 0, total: 0 });
    expect(scores.overall.ceilingViolations).toBe(1);
    expect(ceilingViolated('full', 'partial')).toBe(true);
    expect(ceilingViolated('hold', 'partial')).toBe(false);
    expect(ceilingViolated('partial', 'partial')).toBe(false);
  });

  it('gives each rate its 95% Wilson interval, matching known values', () => {
    const half = rateOf(3, 6);
    expect(half.rate).toBe(0.5);
    expect(half.low).toBeCloseTo(0.5 - 0.31238, 4);
    expect(half.high).toBeCloseTo(0.5 + 0.31238, 4);
    expect(rateOf(0, 10)).toMatchObject({ rate: 0, low: 0 });
    expect(rateOf(0, 10).high).toBeCloseTo(0.2775, 4);
    expect(rateOf(10, 10).low).toBeCloseTo(0.7225, 4);
    expect(rateOf(0, 0)).toEqual({ count: 0, total: 0, rate: null, low: null, high: null });
  });
});

describe('the public file', () => {
  const sample: SampledWallet[] = [
    { wallet: wallet(1), stratum: 'full', stored: 'full' },
    { wallet: wallet(2), stratum: 'modelHold', stored: 'hold' },
  ];
  const lines = sample.flatMap((target) => [1, 2].map((run) => line(target, run, target.stored)));
  const meta = { runDate: '2026-11-11', rulebook: 2, seed: 11, runsPerWallet: 2 };

  // Every text in the file is a fixed word, a date or an address, so nothing a model wrote can reach it (C40).
  function texts(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(texts);
    if (value !== null && typeof value === 'object') return Object.values(value).flatMap(texts);
    return [];
  }

  it('passes its own schema and holds no free text', () => {
    const file = publicFile(meta, scoreConsistency(sample, lines, 2), true);
    expect(() => ConsistencyFile.parse(file)).not.toThrow();
    for (const text of texts(file)) {
      expect(text).toMatch(/^(full|partial|hold|exclude|modelHold|\d{4}-\d{2}-\d{2}|0x[0-9a-f]{40})$/);
    }
    expect(JSON.stringify(file)).not.toMatch(/reason|rawText|requestId/);
    expect(file).toMatchObject({ schema: 1, wallets: 2, runsPerWallet: 2, totalRuns: 4, servCalls: 4, ceilingViolations: 0 });
  });

  it('leaves every address out when told the addresses are not all public', () => {
    const file = publicFile(meta, scoreConsistency(sample, lines, 2), false);
    expect(file.samples.every((one) => one.wallet === undefined)).toBe(true);
    expect(texts(file).some((text) => text.startsWith('0x'))).toBe(false);
  });
});

describe('the spend guard', () => {
  const record = { start_outcome: 'full' } as GraphRecord;

  it('allows at most the per-screening cap for every planned run', () => {
    expect(spendLimit(30, 5)).toBe(30 * 5 * MAX_SERV_CALLS_PER_SCREEN);
  });

  it('refuses the call past its limit without reaching SERV, and stops a decision part-way', async () => {
    const answer = JSON.stringify({ verdict: 'ordinary_user', action: 'full', rule: 'A9', reason: 'Old and active.', cited_tx_hashes: [] });
    const reply: ServReply = { requestId: 'run-1', rawText: answer, answer, answerProblem: null, usage: null };
    const route = vi.fn(async (_graph: GraphRecord) => reply);
    const guard = spendGuard({ viaGraph: route, viaV2: route, sleep: async () => undefined }, 1);
    await guard.deps.viaV2(record);
    await expect(guard.deps.viaGraph(record)).rejects.toSatisfy(stoppedBySpendGuard);
    expect(route).toHaveBeenCalledTimes(1);
    expect(guard.calls()).toBe(1);

    const row: ReplayRow = {
      wallet: wallet(9),
      start: { outcome: 'full', rule: 'A9' },
      ceiling: 'full',
      facts: {
        walletAgeDays: 400,
        txCountAtSnapshot: 50,
        accountType: 'eoa',
        firstFunder: null,
        group: null,
        sharedDepositAddress: null,
        fundingBurst: null,
        claimPaidToOtherAddress: false,
        evidenceTxs: [],
        missing: [],
      },
    };
    const spent = spendGuard({ viaGraph: route, viaV2: route, sleep: async () => undefined }, 0);
    await expect(decideWallet(row, DEFAULT_SETTINGS, spent.deps, 'auto')).rejects.toSatisfy(stoppedBySpendGuard);
  });
});

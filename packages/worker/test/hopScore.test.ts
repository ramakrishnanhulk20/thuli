// Not covered here: how the rows were built (the replay runner and its tests), and whether Hop's lists are themselves
// right. This file checks only the arithmetic of the Hop scorecard and the words it prints.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, FIXED_RULES, parseAddress, type FactName, type Facts, type FixedRule, type ReplayRow, type Start } from '@thuli/core';
import type { HopLists } from '../src/replay/answerKeys.ts';
import { hopToMarkdown, scoreHop, type HopCohort } from '../src/replay/hopScore.ts';

const META = { snapshotBlock: 14_497_033, snapshotTime: '2022-03-31T23:59:56.000Z', runDate: '2026-11-06' };
const LONG_DASH = String.fromCharCode(0x2014);
const FUNDER = `0x${'f1'.repeat(20)}`;
const wallet = (index: number) => `0x${index.toString(16).padStart(40, '0')}`;

const FULL: Start = { outcome: 'full', rule: 'A9' };
const PARTIAL: Start = { outcome: 'partial', rule: 'A8' };
const HOLD_A4: Start = { outcome: 'hold', rule: 'A4' };
const HOLD_A5: Start = { outcome: 'hold', rule: 'A5' };
const EXCLUDE: Start = { outcome: 'exclude', rule: 'A3' };
const READ_FAILED: Start = { outcome: 'hold', rule: 'A1' };

interface RowOptions {
  age?: number | null;
  txCount?: number;
  funder?: string | null;
  burst?: number;
  missing?: FactName[];
}

// An old, busy wallet unless the options say otherwise: well past both minimums, with a funder.
function row(address: string, start: Start, opts: RowOptions = {}): ReplayRow {
  const funder = opts.funder === undefined ? FUNDER : opts.funder;
  const facts: Facts = {
    walletAgeDays: opts.age === undefined ? 400 : opts.age,
    txCountAtSnapshot: opts.txCount ?? 50,
    accountType: 'eoa',
    firstFunder: funder === null ? null : { address: parseAddress(funder), kind: 'wallet', fanoutInList: 1, hopsTraced: 0 },
    group: null,
    sharedDepositAddress: null,
    fundingBurst: opts.burst === undefined ? null : { wallets: opts.burst },
    claimPaidToOtherAddress: false,
    evidenceTxs: [],
    missing: opts.missing ?? [],
  };
  return { wallet: address, start, ceiling: start.outcome, facts };
}

// The facts the engine gives a wallet nothing was ever sent to or from, which it starts at partial under A8.
const noHistory = (address: string, burst?: number) => row(address, PARTIAL, { age: 0, txCount: 0, funder: null, burst });
// The facts the engine gives a wallet whose explorer read failed, which it starts at hold under A1.
const failedRead = (address: string) => row(address, READ_FAILED, { age: null, txCount: 0, funder: null, missing: ['walletAgeDays', 'firstFunder'] });

function rules(counts: Partial<Record<FixedRule, number>>): Record<FixedRule, number> {
  return Object.fromEntries(FIXED_RULES.map((rule) => [rule, counts[rule] ?? 0])) as Record<FixedRule, number>;
}

// Letters, so its checksummed spelling really differs from the lowercase one on the list.
const N1 = `0x${'ab'.repeat(20)}`;
const [N2, N3, N4, N5, N6, N7, N8] = [2, 3, 4, 5, 6, 7, 8].map(wallet) as [string, string, string, string, string, string, string];
const [K1, K2, K3] = [21, 22, 23].map(wallet) as [string, string, string];
const [E1, E2, E3, E4, E5, E6, E7, E8, E9] = [31, 32, 33, 34, 35, 36, 37, 38, 39].map(wallet) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

const LISTS: HopLists = {
  eligible: [N1, N2, N3, N4, N5, N6, N7, N8, K1, K2, K3],
  eliminated: [E1, E2, E3, E4, E5, E6, E7, E8, E9],
  negatives: new Set([N1, N2, N3, N4, N5, N6, N7, N8]),
  keptInGroups: new Set([K1, K2, K3]),
  clusters: new Map([
    [E1, 'both held'],
    [E2, 'both held'],
    [E3, 'one held'],
    [E4, 'one held'],
    [E5, 'none held'],
    [E6, 'only no history'],
    [E7, 'failed read and no history'],
    [E8, 'failed read and no history'],
    [E9, 'not in this run'],
  ]),
};

const ROWS: ReplayRow[] = [
  // Checksummed on purpose: the score must compare it with the lowercase lists through the one parser.
  row(parseAddress(N1), FULL),
  row(N2, PARTIAL, { burst: 25 }),
  row(N3, PARTIAL, { burst: 25, age: 12, txCount: 2 }),
  row(N4, HOLD_A4),
  row(N5, EXCLUDE),
  noHistory(N6),
  failedRead(N7),
  row(K1, HOLD_A5),
  row(K2, FULL),
  noHistory(K3, 25),
  row(E1, HOLD_A4),
  row(E2, EXCLUDE),
  row(E3, HOLD_A5),
  row(E4, FULL),
  row(E5, FULL),
  noHistory(E6),
  failedRead(E7),
  noHistory(E8),
];

/** A list of negatives alone, with `held` of `counted` wallets held, for checking the interval on its own. */
function scoreOf(held: number, counted: number): HopCohort {
  const rows = Array.from({ length: counted }, (_, index) => row(wallet(index + 1), index < held ? HOLD_A4 : FULL));
  const lists: HopLists = {
    eligible: rows.map((r) => r.wallet),
    eliminated: [],
    negatives: new Set(rows.map((r) => r.wallet)),
    keptInGroups: new Set(),
    clusters: new Map(),
  };
  return scoreHop(rows, lists, DEFAULT_SETTINGS).negatives;
}

function singleNegative(oneRow: ReplayRow): HopCohort {
  const lists: HopLists = { eligible: [oneRow.wallet], eliminated: [], negatives: new Set([oneRow.wallet]), keptInGroups: new Set(), clusters: new Map() };
  return scoreHop([oneRow], lists, DEFAULT_SETTINGS).negatives;
}

describe('scoreHop', () => {
  const score = scoreHop(ROWS, LISTS, DEFAULT_SETTINGS);

  it('pins every field of a cohort', () => {
    const { heldRate, heldLow, heldHigh, ...counts } = score.negatives;
    expect(counts).toEqual({
      screened: 7,
      noEthereumHistory: 1,
      counted: 6,
      full: 1,
      partial: 2,
      hold: 2,
      exclude: 1,
      byRule: rules({ A1: 1, A3: 1, A4: 1, A8: 2, A9: 1 }),
      inBurst: 2,
      burstOnly: 1,
    });
    expect(heldRate).toBe(0.5);
    // 3 of 6: centre 0.5, reach 0.31238, worked by hand from the Wilson formula.
    expect(heldLow).toBeCloseTo(0.18762, 4);
    expect(heldHigh).toBeCloseTo(0.81238, 4);
  });

  it('keeps the three parts of the list apart', () => {
    expect(score.keptInGroups).toMatchObject({ screened: 3, noEthereumHistory: 1, counted: 2, full: 1, hold: 1, heldRate: 0.5 });
    expect(score.keptInGroups.byRule).toEqual(rules({ A5: 1, A9: 1 }));
    expect(score.eliminated).toMatchObject({ screened: 8, noEthereumHistory: 2, counted: 6, full: 2, hold: 3, exclude: 1 });
    expect(score.eliminated.byRule).toEqual(rules({ A1: 1, A3: 1, A4: 1, A5: 1, A9: 2 }));
    expect(score.wallets).toBe(18);
    expect(score.notScreened).toBe(2);
  });

  it('matches published Wilson intervals', () => {
    // Newcombe 1998, Statistics in Medicine 17(8), table of intervals for a single proportion.
    const published = scoreOf(81, 263);
    expect(published.heldLow).toBeCloseTo(0.2553, 4);
    expect(published.heldHigh).toBeCloseTo(0.3662, 4);
    const noneHeld = scoreOf(0, 20);
    expect(noneHeld.heldLow).toBe(0);
    expect(noneHeld.heldHigh).toBeCloseTo(0.1611, 4);
    const allHeld = scoreOf(20, 20);
    expect(allHeld.heldLow).toBeCloseTo(0.8389, 4);
    expect(allHeld.heldHigh).toBe(1);
  });

  it('gives no rate at all when nothing was counted', () => {
    const lists: HopLists = { eligible: [N6], eliminated: [], negatives: new Set([N6]), keptInGroups: new Set(), clusters: new Map() };
    const { negatives, keptInGroups } = scoreHop([noHistory(N6)], lists, DEFAULT_SETTINGS);
    expect(negatives).toMatchObject({ screened: 1, noEthereumHistory: 1, counted: 0, partial: 0, heldRate: null, heldLow: null, heldHigh: null });
    expect(keptInGroups).toMatchObject({ screened: 0, counted: 0, heldRate: null });
  });

  it('leaves a no-history wallet out of the rate, the rules and the bursts', () => {
    const cohort = singleNegative(noHistory(N1, 25));
    expect(cohort).toMatchObject({ noEthereumHistory: 1, counted: 0, partial: 0, inBurst: 0, burstOnly: 0 });
    expect(cohort.byRule).toEqual(rules({}));
  });

  it('counts anything short of the exact empty-wallet facts', () => {
    const nearMisses = [
      row(N1, PARTIAL, { age: 1, txCount: 0, funder: null }),
      row(N1, PARTIAL, { age: 0, txCount: 1, funder: null }),
      row(N1, PARTIAL, { age: 0, txCount: 0 }),
      row(N1, READ_FAILED, { age: 0, txCount: 0, funder: null, missing: ['firstFunder'] }),
    ];
    for (const nearMiss of nearMisses) expect(singleNegative(nearMiss)).toMatchObject({ noEthereumHistory: 0, counted: 1 });
  });

  it('keeps a failed read counted as a hold, never labelled no history (C11)', () => {
    const cohort = singleNegative(failedRead(N1));
    expect(cohort).toMatchObject({ noEthereumHistory: 0, counted: 1, hold: 1, heldRate: 1 });
    expect(cohort.byRule).toEqual(rules({ A1: 1 }));
  });

  it('tallies clusters over counted wallets only', () => {
    expect(score.clusters).toEqual({ total: 6, touched: 3, fullyHeld: 2, noCounted: 2 });
  });

  it('does not count a no-history wallet as held in a cluster', () => {
    const lists: HopLists = { eligible: [], eliminated: [E1, E2], negatives: new Set(), keptInGroups: new Set(), clusters: new Map([[E1, 'one'], [E2, 'one']]) };
    const { clusters } = scoreHop([noHistory(E1), noHistory(E2)], lists, DEFAULT_SETTINGS);
    expect(clusters).toEqual({ total: 1, touched: 0, fullyHeld: 0, noCounted: 1 });
  });

  it('refuses rows it cannot place', () => {
    expect(() => scoreHop([row(N1, FULL), row(parseAddress(N1), FULL)], LISTS, DEFAULT_SETTINGS)).toThrow('a wallet appears in two replay rows');
    expect(() => scoreHop([row(wallet(999), FULL)], LISTS, DEFAULT_SETTINGS)).toThrow('a replay row names a wallet on none of the Hop lists');
  });
});

describe('hopToMarkdown', () => {
  const markdown = hopToMarkdown(scoreHop(ROWS, LISTS, DEFAULT_SETTINGS), META);

  it('opens with what was measured and how', () => {
    expect(markdown.startsWith('# Hop replay: how often Thuli holds wallets Hop never suspected\n')).toBe(true);
    expect(markdown).toContain("uses only chain data before Hop's 1 April 2022 snapshot, and no model");
    expect(markdown).toContain('Snapshot block: 14,497,033 (2022-03-31T23:59:56.000Z)');
    expect(markdown).toContain('Hop wallets not in this run: 2');
  });

  it('prints the sections in order', () => {
    const headings = markdown.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual([
      "## Hop's probably-real wallets",
      '## Why these wallets were held',
      '## Funding bursts',
      '## Eligible wallets inside groups Hop looked at',
      "## Hop's eliminated wallets",
      '## Not covered',
    ]);
  });

  it('leads with the held rate and its interval, then partial and full', () => {
    expect(markdown).toContain('Held: 3, 50.0% (95% interval 18.8% to 81.2%)');
    expect(markdown).toContain('Cut to partial: 2 (33.3%)');
    expect(markdown).toContain('Paid in full: 1 (16.7%)');
    expect(markdown).toContain('No Ethereum history, left out: 1');
  });

  it('prints why wallets were held, bursts with their rate, and clusters', () => {
    expect(markdown).toContain('| A4 | a group of wallets that move together, so hold | 1 |');
    expect(markdown).toContain("| Hop's probably-real wallets | 2 (33.3%) | 1 (16.7%) |");
    expect(markdown).toContain('Clusters Hop eliminated: 6');
    expect(markdown).toContain('Clusters with at least one counted wallet held: 3');
    expect(markdown).toContain('Clusters with every counted wallet held: 2');
    expect(markdown).toContain('Clusters with no counted wallet, so neither: 2');
  });

  it('says everything the replay does not cover', () => {
    const notCovered = markdown.slice(markdown.indexOf('## Not covered'));
    expect(notCovered).toContain('Eligible means not removed by Hop, not proved real, so some held wallets may be real farms.');
    expect(notCovered).toContain("Hop's clusters came from a transfer graph, so catching eliminated wallets here is partly by construction and is not a recall claim.");
    expect(notCovered).toContain("Only Ethereum is read, and Hop's users also lived on other chains.");
    expect(notCovered).toContain('Wallets with no Ethereum history are left out: age 0, no transactions, no funder and no fact missing.');
    expect(notCovered).toContain('It stays counted as a hold under A1, so a failed read can only raise the rate, never hide.');
    expect(notCovered).toContain("Transfers past a wallet's first 100 are not read.");
    expect(notCovered).toContain('This is the code alone, with no model in the loop.');
  });

  it('prints no wallet and no long dash', () => {
    expect(markdown).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(markdown).not.toContain(LONG_DASH);
  });
});

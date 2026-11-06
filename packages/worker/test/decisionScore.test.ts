// Not covered here: how the records were made (decide.test.ts), whether Bitquery's key or its claim-day value is right,
// and the real ROBO data. This file checks only the arithmetic of the scorecard and the words it prints.
import { describe, expect, it } from 'vitest';
import { BURST_KEPT_CAUSE, DEFAULT_SETTINGS, FUNDER_KEPT_CAUSE, parseAddress, type FarmKeyEntry, type Outcome, type ReplayRow, type Start } from '@thuli/core';
import type { DecisionRecord } from '../src/replay/decide.ts';
import { decisionsToMarkdown, scoreDecisions, STALE_DECISION, USD_PER_ROBO_AT_CLAIM } from '../src/replay/decisionScore.ts';

const wallet = (tag: string) => `0x${tag.repeat(20)}`;
const [K1, K2, K3, K4, K5, K6] = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map(wallet) as [string, string, string, string, string, string];
const [O1, O2, O3, O4, O5, O6, O7] = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'].map(wallet) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];
const ROBO = 10n ** 18n;
const LONG_DASH = String.fromCharCode(0x2014);
const BAD_SHARE = 'the share did not match the action';
const BAD_JSON = 'the model reply was not valid JSON';
const TOO_LONG = 'the reason was longer than 280 characters';

const SHARE_FOR: Record<Outcome, number> = { full: 10000, partial: DEFAULT_SETTINGS.partialShareBps, hold: 0, exclude: 0 };

function row(address: string, start: Start): ReplayRow {
  return {
    wallet: address,
    start,
    ceiling: 'full',
    facts: {
      walletAgeDays: 12,
      txCountAtSnapshot: 2,
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
}

function record(address: string, start: Start, action: Outcome, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    wallet: address,
    mode: 'v3',
    fallback: false,
    start,
    ceiling: 'full',
    requestId: 'run-1',
    rawText: '{}',
    usage: { inputTokens: 100, outputTokens: 10 },
    verdict: 'unclear',
    modelAction: action,
    modelRule: start.rule,
    action,
    shareBps: SHARE_FOR[action],
    rule: start.rule,
    reason: 'A reason.',
    citedTxs: [],
    clampedFrom: null,
    accepted: true,
    cause: null,
    secondAsk: false,
    firstCause: null,
    ...overrides,
  };
}

const FULL_A9: Start = { outcome: 'full', rule: 'A9' };
const PARTIAL_A8: Start = { outcome: 'partial', rule: 'A8' };
const HOLD_A1: Start = { outcome: 'hold', rule: 'A1' };
const HOLD_A4: Start = { outcome: 'hold', rule: 'A4' };
const HOLD_A5: Start = { outcome: 'hold', rule: 'A5' };
const HOLD_A6: Start = { outcome: 'hold', rule: 'A6' };
const EXCLUDE_A3: Start = { outcome: 'exclude', rule: 'A3' };

const COLLECTORS = [wallet('c1'), wallet('c2'), wallet('c3'), wallet('c4')] as const;
const entry = (family: number): FarmKeyEntry => ({ collector: COLLECTORS[family - 1] as string, family, fundingWallet: null });

// Family 1 has one wallet raised and one held; family 2 is fully held; family 3 is one undecided wallet; family 4 is paid.
const KEY = new Map<string, FarmKeyEntry>([
  [K1, entry(1)],
  [K2, entry(1)],
  [K3, entry(2)],
  [K4, entry(2)],
  [K5, entry(3)],
  [K6, entry(4)],
]);

const ROWS: ReplayRow[] = [
  // Checksummed on purpose: the score must lowercase before it looks the wallet up in the key and the claims.
  row(parseAddress(K1), HOLD_A4),
  row(K2, HOLD_A5),
  row(K3, EXCLUDE_A3),
  row(K4, PARTIAL_A8),
  row(K5, HOLD_A4),
  row(K6, FULL_A9),
  row(O1, FULL_A9),
  row(O2, PARTIAL_A8),
  row(O3, FULL_A9),
  row(O4, HOLD_A1),
  row(O5, FULL_A9),
  row(O6, PARTIAL_A8),
  row(O7, HOLD_A6),
];

// K5 and O6 have no record: SERV never answered for them.
const RECORDS: DecisionRecord[] = [
  record(K1, HOLD_A4, 'full', { rule: 'B2', modelRule: 'B2', verdict: 'ordinary_user' }),
  record(K2, HOLD_A5, 'hold', { verdict: 'likely_farm' }),
  record(K3, EXCLUDE_A3, 'exclude'),
  record(K4, PARTIAL_A8, 'hold', { rule: 'B1', modelRule: 'B1' }),
  record(K6, FULL_A9, 'full', { verdict: 'likely_farm' }),
  record(O1, FULL_A9, 'full', { verdict: 'ordinary_user', secondAsk: true, firstCause: TOO_LONG }),
  record(O2, PARTIAL_A8, 'partial', { mode: 'v2', modelAction: 'hold', clampedFrom: 'hold', accepted: false, cause: BURST_KEPT_CAUSE }),
  record(O3, FULL_A9, 'hold', { verdict: 'ordinary_user', modelAction: 'full', rule: 'A1', accepted: false, cause: BAD_SHARE, secondAsk: true, firstCause: TOO_LONG }),
  record(O4, HOLD_A1, 'hold', { mode: 'v2', fallback: true, usage: null, verdict: null, modelAction: null, modelRule: null, accepted: false, cause: BAD_JSON }),
  record(O5, FULL_A9, 'hold', { rule: 'B1', modelRule: 'B1' }),
  record(O7, HOLD_A6, 'partial', { mode: 'v2', fallback: true, rule: 'B2', modelRule: 'B2' }),
];

const CLAIMED = new Map<string, bigint>([
  [K1, 100n * ROBO],
  [K2, 100n * ROBO],
  [K3, 100n * ROBO],
  [K4, 100n * ROBO],
  [K5, 100n * ROBO],
  [K6, 100n * ROBO],
  [O1, 100n * ROBO],
  // One wei over a whole ROBO, so half of it has to round to a whole wei.
  [O2, ROBO + 1n],
  [O3, 10n * ROBO],
  [O4, 10n * ROBO],
  [O5, 10n * ROBO],
  [O6, 7n * ROBO],
  [O7, 3n * ROBO],
]);

const zeroOutcomes = { full: 0, partial: 0, hold: 0, exclude: 0 };

describe('scoreDecisions', () => {
  it('pins every field on a mixed set of key and other wallets', () => {
    expect(scoreDecisions(RECORDS, ROWS, KEY, CLAIMED)).toEqual({
      wallets: 13,
      decided: 11,
      undecided: 2,
      modes: { v3: 8, v2: 3, fallbacks: 2 },
      tokens: { v3: { input: 800, output: 80 }, v2: { input: 200, output: 20 } },
      accepted: 8,
      burstKept: 1,
      funderKept: 0,
      secondAsks: { asked: 2, fixed: 1 },
      refused: { [BAD_SHARE]: 1, [BAD_JSON]: 1 },
      final: {
        key: { full: 2, partial: 0, hold: 2, exclude: 1 },
        other: { full: 1, partial: 2, hold: 3, exclude: 0 },
      },
      startHeld: { key: 3, other: 2 },
      finalHeld: { key: 3, other: 3 },
      families: { total: 4, fullyHeld: 1, touched: 2 },
      moved: { raisedByB2: { key: 1, other: 1 }, heldByB1: { key: 1, other: 1 } },
      robo: {
        // K2, K3 and K4 held at 100 each, K5 undecided at 100, K1 and K6 paid in full.
        keptKey: '400',
        allKey: '600',
        // O2 half of 1 ROBO and 1 wei (the odd wei stays paid), O3 to O5 held at 10 each, O6 undecided at 7, O7 half of 3.
        keptOther: '39',
        allOther: '141.000000000000000001',
      },
      verdictClash: { ordinaryButHeld: 1, farmButPaidInFull: 1 },
    });
  });

  it('keeps the full claim of an undecided wallet and rounds a partial down to whole wei', () => {
    const score = scoreDecisions([record(O2, PARTIAL_A8, 'partial')], [row(O2, PARTIAL_A8), row(O6, PARTIAL_A8)], new Map(), CLAIMED);
    expect(score.robo.keptOther).toBe('7.5');
    expect(score.robo.allOther).toBe('8.000000000000000001');
    expect(score.undecided).toBe(1);
  });

  it('counts a key wallet raised by B2 as a miss in the recall', () => {
    const held = scoreDecisions([record(K1, HOLD_A4, 'hold')], [row(K1, HOLD_A4)], KEY, CLAIMED);
    expect(held.finalHeld.key).toBe(1);
    const raised = scoreDecisions([record(K1, HOLD_A4, 'full', { rule: 'B2' })], [row(K1, HOLD_A4)], KEY, CLAIMED);
    expect(raised.finalHeld.key).toBe(0);
    expect(raised.startHeld.key).toBe(1);
    expect(raised.moved.raisedByB2.key).toBe(1);
    expect(raised.families).toEqual({ total: 1, fullyHeld: 0, touched: 0 });
  });

  it('gives empty counts and keeps every claim when nothing is decided', () => {
    const score = scoreDecisions([], ROWS, KEY, CLAIMED);
    expect(score).toMatchObject({
      wallets: 13,
      decided: 0,
      undecided: 13,
      secondAsks: { asked: 0, fixed: 0 },
      refused: {},
      final: { key: zeroOutcomes, other: zeroOutcomes },
      startHeld: { key: 0, other: 0 },
      finalHeld: { key: 0, other: 0 },
      families: { total: 4, fullyHeld: 0, touched: 0 },
      robo: { keptKey: '600', allKey: '600', keptOther: '141.000000000000000001', allOther: '141.000000000000000001' },
    });
  });

  it('ignores a record for a wallet outside the rows', () => {
    const score = scoreDecisions([record(K1, HOLD_A4, 'hold')], [row(O1, FULL_A9)], KEY, CLAIMED);
    expect(score).toMatchObject({ wallets: 1, decided: 0, undecided: 1 });
    expect(score.tokens.v3.input).toBe(0);
  });

  it('refuses a record whose start or ceiling differs from its row, and takes a matching one', () => {
    const rows = [row(K1, HOLD_A4)];
    const score = (stored: DecisionRecord) => scoreDecisions([stored], rows, KEY, CLAIMED);
    expect(STALE_DECISION).toBe('a stored decision was made on different replay rows, use a fresh --out');
    expect(() => score(record(K1, { outcome: 'partial', rule: 'A4' }, 'hold'))).toThrow(STALE_DECISION);
    expect(() => score(record(K1, HOLD_A5, 'hold'))).toThrow(STALE_DECISION);
    expect(() => score(record(K1, HOLD_A4, 'hold', { ceiling: 'partial' }))).toThrow(STALE_DECISION);
    expect(score(record(K1, HOLD_A4, 'hold')).decided).toBe(1);
  });

  it('counts a hold the code replaced on a funder alone apart from refused, burst and held', () => {
    const replaced = record(O1, FULL_A9, 'full', { modelAction: 'hold', modelRule: 'B1', clampedFrom: 'hold', accepted: false, cause: FUNDER_KEPT_CAUSE });
    const score = scoreDecisions([replaced], [row(O1, FULL_A9)], new Map(), CLAIMED);
    expect(score).toMatchObject({ funderKept: 1, burstKept: 0, refused: {}, accepted: 0, finalHeld: { key: 0, other: 0 }, final: { other: { full: 1 } } });
    expect(score.robo.keptOther).toBe('0');
    const report = decisionsToMarkdown(score, { runDate: '2026-11-06', spentCents: null });
    expect(report).toContain('Holds on a funder alone, replaced by the code: 1');
    expect(report).toContain('Still refused and held:\n- none');
  });

  it('counts a refused first answer as asked even when the second call failed, and not as fixed', () => {
    const failedSecond = record(O3, FULL_A9, 'hold', { rule: 'A1', accepted: false, cause: TOO_LONG, secondAsk: true, firstCause: TOO_LONG });
    const score = scoreDecisions([failedSecond], [row(O3, FULL_A9)], new Map(), CLAIMED);
    expect(score.secondAsks).toEqual({ asked: 1, fixed: 0 });
    expect(score.refused).toEqual({ [TOO_LONG]: 1 });
  });

  it('refuses a wallet listed twice, in the rows or in the records', () => {
    expect(() => scoreDecisions([], [row(K1, HOLD_A4), row(parseAddress(K1), HOLD_A4)], KEY, CLAIMED)).toThrow(RangeError);
    const twice = [record(K1, HOLD_A4, 'hold'), record(parseAddress(K1), HOLD_A4, 'hold')];
    expect(() => scoreDecisions(twice, [row(K1, HOLD_A4)], KEY, CLAIMED)).toThrow(RangeError);
  });
});

describe('decisionsToMarkdown', () => {
  const score = scoreDecisions(RECORDS, ROWS, KEY, CLAIMED);
  const report = decisionsToMarkdown(score, { runDate: '2026-11-06', spentCents: 275 });

  it('prints the sections in order', () => {
    const headings = report.split('\n').filter((line) => line.startsWith('#'));
    expect(headings).toEqual([
      '# ROBO replay: SERV decisions',
      '## What the model changed',
      "## Bitquery's farm key",
      '## Everyone else',
      '## Kept back',
      '## Answers',
      '## Cost',
      '## Not covered',
    ]);
  });

  it('opens with three lines on what this is', () => {
    const opening = report.split('\n').slice(2, 5);
    expect(opening[0]).toContain('no money moved');
    expect(opening[1]).toContain('stored');
    expect(opening[2]).toContain('checks every answer');
    expect(report).toContain('Run date: 2026-11-06');
    expect(report).toContain('Wallets: 13 (11 decided, 2 undecided)');
  });

  it('shows what the model changed', () => {
    expect(report).toContain('Held by the code at the start: 3 key wallets, 2 others');
    expect(report).toContain('Held after SERV: 3 key wallets, 3 others');
    expect(report).toContain('Raised by rule B2: 1 key wallets, 1 others');
    expect(report).toContain('Held by rule B1: 1 key wallets, 1 others');
    expect(report).toContain("Burst replies replaced by the code's partial: 1\nHolds on a funder alone, replaced by the code: 0");
  });

  it('shows the final recall after the B2 raise, and the families', () => {
    expect(report).toContain('Key wallets decided: 5');
    expect(report).toContain('Held after SERV: 3 (60.0%)');
    expect(report).toContain('Excluded: 1, held: 2, cut to partial: 0, paid in full: 2');
    expect(report).toContain('Families (one per collector): 4');
    expect(report).toContain('Families with at least one wallet held: 2');
    expect(report).toContain('Families with every wallet held: 1');
  });

  it('shows everyone else by final outcome', () => {
    expect(report).toContain('Other wallets decided: 6');
    expect(report).toContain('Paid in full: 1 (16.7%)');
    expect(report).toContain('Cut to partial: 2 (33.3%)');
    expect(report).toContain('Held: 3 (50.0%)');
    expect(report).toContain('Excluded: 0 (0.0%)');
  });

  it('labels the money as unrealised and gives ROBO and dollars', () => {
    expect(USD_PER_ROBO_AT_CLAIM).toBeCloseTo(0.04193, 5);
    expect(report).toContain('Unrealised, replay only');
    expect(report).toContain('Key wallets: 400.0 ROBO of 600.0 ROBO ($17 of $25)');
    expect(report).toContain('Other wallets: 39.0 ROBO of 141.0 ROBO ($2 of $6)');
  });

  it('lists every refusal and the verdict clashes', () => {
    expect(report).toContain('Decided: 11');
    expect(report).toContain('Undecided: 2');
    expect(report).toContain('Accepted by the checks: 8');
    expect(report).toContain(`First answers refused: 2\nFixed by a second ask: 1\nStill refused and held:\n- ${BAD_JSON}: 1\n- ${BAD_SHARE}: 1`);
    expect(report).toContain(`- ${BAD_SHARE}: 1`);
    expect(report).toContain(`- ${BAD_JSON}: 1`);
    expect(report).not.toContain(`- ${BURST_KEPT_CAUSE}`);
    expect(report).toContain('Verdict clashes: 1 called ordinary but held, 1 called likely farm but paid in full');
  });

  it('shows the cost, and the spent line only when it is set', () => {
    expect(report).toContain('Graph (v3) answers: 8, using 800 input and 80 output tokens');
    expect(report).toContain('v2 answers: 3, using 200 input and 20 output tokens');
    expect(report).toContain('Of the v2 answers, stand-ins for a failed graph call: 2');
    expect(report).toContain('Spent, from the console balance: $2.75 (25.000 cents per wallet)');
    expect(decisionsToMarkdown(score, { runDate: '2026-11-06', spentCents: null })).not.toContain('Spent');
  });

  it('closes by naming what it does not cover', () => {
    const notCovered = report.slice(report.indexOf('## Not covered'));
    expect(notCovered).toContain("Bitquery's claim-day value");
    expect(notCovered).toContain('a real sale would move the price');
    expect(notCovered).toContain('not a live campaign');
    expect(notCovered).toContain('Tokens are not a bill');
    expect(notCovered).toContain('console balance');
  });

  it('prints plain words on an empty run, with nothing to divide by', () => {
    const empty = decisionsToMarkdown(scoreDecisions([], ROWS, KEY, CLAIMED), { runDate: '2026-11-06', spentCents: 0 });
    expect(empty).toContain('Wallets: 13 (0 decided, 13 undecided)');
    expect(empty).toContain('Held after SERV: 0 (n/a)');
    expect(empty).toContain('First answers refused: 0\nFixed by a second ask: 0\nStill refused and held:\n- none');
    expect(empty).toContain('Spent, from the console balance: $0.00 (n/a cents per wallet)');
  });

  it('has no long dashes', () => {
    expect(report).not.toContain(LONG_DASH);
  });
});

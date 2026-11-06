// Not covered here: what a model would answer on the new rulebook (no model runs, these are stored answers), whether Reppo
// would pass v2's decisions, and the versions-score script's file reading (npm run versions:score is the check for that).
// The last block reads the real stored runs under data/, which git ignores, so it is skipped on a clean clone.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BURST_KEPT_CAUSE,
  computeCeiling,
  computeStart,
  DEFAULT_SETTINGS,
  FUNDER_KEPT_CAUSE,
  parseAddress,
  type AppealRecord,
  type Facts,
  type FarmKeyEntry,
  type Outcome,
  type ReplayRow,
  type ReppoVerdict,
} from '@thuli/core';
import { STALE_ROWS, type DecisionRecord } from '../src/replay/decide.ts';
import { STALE_DECISION } from '../src/replay/decisionScore.ts';
import { wilson } from '../src/replay/hopScore.ts';
import { asRulebookV2, compareVersions, heldShare, scoreVersion, splitAppeals, versionsToMarkdown } from '../src/replay/versions.ts';
import type { FeedbackEntry } from '../src/reppo/feedback.ts';

const LONG_DASH = String.fromCharCode(0x2014);
const OTHER_TX = `0x${'ab'.repeat(32)}`;
const wallet = (tag: string) => `0x${tag.repeat(20)}`;
const [W1, W2, W3, W4, W5] = ['a1', 'a2', 'a3', 'a4', 'a5'].map(wallet) as [string, string, string, string, string];
const FAR_AWAY = wallet('e9');

const PLAIN: Facts = {
  walletAgeDays: 324,
  txCountAtSnapshot: 16,
  accountType: 'eoa',
  firstFunder: { address: parseAddress(wallet('f1')), kind: 'contract', fanoutInList: 63, hopsTraced: 0 },
  group: null,
  sharedDepositAddress: null,
  fundingBurst: null,
  claimPaidToOtherAddress: false,
  evidenceTxs: [OTHER_TX],
  missing: [],
};
const OWN_LINK: Facts = {
  ...PLAIN,
  group: { size: 2, sameFunderWithinWindow: null, sweptToSharedCollector: false, authoredEvidence: false, linkedByWallet: true },
};
const BURST: Facts = { ...PLAIN, fundingBurst: { wallets: 27 } };
const IN_GROUP: Facts = {
  ...PLAIN,
  group: { size: 23, sameFunderWithinWindow: 23, sweptToSharedCollector: false, authoredEvidence: false, linkedByWallet: false },
};

function rowFor(facts: Facts, address = W1): ReplayRow {
  return {
    wallet: address,
    start: computeStart(facts, DEFAULT_SETTINGS),
    ceiling: computeCeiling(facts, DEFAULT_SETTINGS).ceiling,
    facts,
  };
}

function recordFor(row: ReplayRow, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    wallet: row.wallet,
    mode: 'v3',
    fallback: false,
    start: row.start,
    ceiling: row.ceiling,
    requestId: 'run-1',
    rawText: '{"recommended_outcome":"hold_for_review"}',
    usage: { inputTokens: 900, outputTokens: 60 },
    verdict: 'likely_farm',
    modelAction: 'hold',
    modelRule: 'B1',
    action: 'hold',
    shareBps: 0,
    rule: 'B1',
    reason: 'The contract first funder also funded 62 claim wallets.',
    citedTxs: [OTHER_TX],
    clampedFrom: null,
    accepted: true,
    cause: null,
    secondAsk: false,
    firstCause: null,
    ...overrides,
  };
}

// Field for field, these three are the stored ROBO records for a long reason, a made-up hash and a burst replacement.
const REFUSED_LONG_REASON = {
  verdict: 'likely_farm',
  modelAction: 'hold',
  modelRule: 'A4',
  action: 'hold',
  shareBps: 0,
  rule: 'A1',
  reason: 'Held for review: the reason was longer than 280 characters.',
  citedTxs: [],
  accepted: false,
  cause: 'the reason was longer than 280 characters',
  secondAsk: true,
  firstCause: 'the reason was longer than 280 characters',
} as const satisfies Partial<DecisionRecord>;
const REFUSED_MADE_UP_HASH = {
  mode: 'v2',
  verdict: 'unclear',
  modelAction: 'partial',
  modelRule: 'A8',
  action: 'hold',
  shareBps: 0,
  rule: 'A1',
  reason: 'Held for review: the reason cited a transaction Thuli did not fetch for this wallet.',
  citedTxs: [],
  accepted: false,
  cause: 'the reason cited a transaction Thuli did not fetch for this wallet',
  secondAsk: true,
  firstCause: 'the reason cited a transaction Thuli did not fetch for this wallet',
} as const satisfies Partial<DecisionRecord>;
const BURST_REPLACED = {
  mode: 'v2',
  verdict: 'unclear',
  modelAction: 'partial',
  modelRule: 'B2',
  action: 'partial',
  shareBps: 5000,
  rule: 'A8',
  reason: 'First funded in a burst of 27 wallets from one exchange on one day in near-equal amounts. A funding pattern alone does not prove one owner, so the reward is partial.',
  citedTxs: [],
  accepted: false,
  cause: BURST_KEPT_CAUSE,
} as const satisfies Partial<DecisionRecord>;

describe('asRulebookV2', () => {
  const replay = (record: DecisionRecord, row: ReplayRow) => asRulebookV2(record, row, DEFAULT_SETTINGS);

  it('replaces an accepted hold on a funder alone with the start, and keeps what the model said', () => {
    const row = rowFor(PLAIN);
    const stored = recordFor(row);
    expect(replay(stored, row)).toEqual({
      ...stored,
      action: 'full',
      shareBps: 10000,
      rule: 'A9',
      reason: "No funding trail was traced and this wallet made no links of its own, so the code's start stands.",
      citedTxs: [],
      clampedFrom: 'hold',
      accepted: false,
      cause: FUNDER_KEPT_CAUSE,
    });
    expect(stored.action).toBe('hold');
  });

  it('keeps a hold on a wallet that made a link of its own', () => {
    const row = rowFor(OWN_LINK);
    const stored = recordFor(row);
    expect(replay(stored, row)).toEqual(stored);
  });

  it.each([
    ['a start the model repeated', PLAIN, { modelAction: 'full', modelRule: 'A9', action: 'full', shareBps: 10000, rule: 'A9', reason: 'Old and active.' }],
    ['a held group the model kept', IN_GROUP, { modelAction: 'hold', modelRule: 'A4', rule: 'A4', reason: 'A group of 23 wallets shares funding.' }],
    [
      'a full reward cut by the ceiling',
      { ...IN_GROUP, walletAgeDays: 3 },
      { modelAction: 'full', modelRule: 'B2', action: 'partial', shareBps: 5000, rule: 'B2', reason: 'Ordinary shared infrastructure.', clampedFrom: 'full' },
    ],
  ] as const)('gives the stored record back for %s', (_name, facts, overrides) => {
    const row = rowFor(facts);
    const stored = recordFor(row, overrides);
    expect(replay(stored, row)).toEqual(stored);
  });

  it('returns a record with no usable answer unchanged', () => {
    const row = rowFor(PLAIN);
    const stored = recordFor(row, { modelAction: null, modelRule: null, verdict: null, rule: 'A1', reason: 'Held for review: the model reply was not valid JSON.', accepted: false, cause: 'the model reply was not valid JSON' });
    expect(replay(stored, row)).toBe(stored);
  });

  it.each([
    ['a long reason on a held group', IN_GROUP, REFUSED_LONG_REASON],
    ['a made-up hash on a burst wallet, which a replay of the fallback text would raise to partial', BURST, REFUSED_MADE_UP_HASH],
    ['a burst replacement', BURST, BURST_REPLACED],
  ])('leaves %s exactly as stored', (_name, facts, overrides) => {
    const row = rowFor(facts);
    const stored = recordFor(row, overrides);
    expect(replay(stored, row)).toBe(stored);
  });

  it('gives the same answer a second time, so a v2 record can be replayed again', () => {
    const row = rowFor(PLAIN);
    const once = replay(recordFor(row), row);
    expect(replay(once, row)).toEqual(once);
  });

  it('refuses a record whose start no longer fits the row', () => {
    const row = rowFor(PLAIN);
    expect(() => replay(recordFor(row, { start: { outcome: 'partial', rule: 'A8' } }), row)).toThrow(STALE_ROWS);
    expect(() => replay(recordFor(row, { ceiling: 'partial' }), row)).toThrow(STALE_ROWS);
  });
});

const entry = (address: string, overrides: Partial<FeedbackEntry> = {}): FeedbackEntry => ({
  wallet: address,
  set: 'robo',
  group: 'contract-hold',
  rulebook: 'v1',
  evalId: 'eval1',
  input: 'payload',
  action: 'hold',
  rule: 'B1',
  verdict: { score: 40, decision: 'reject', confidence: 'high', route: 'block', reason: 'Checked.' },
  creditsCharged: 440,
  disagrees: true,
  ...overrides,
});

const passed: ReppoVerdict = { score: 90, decision: 'accept', confidence: 'high', route: 'ship', reason: 'Checked.' };

const appeal = (address: string, overrides: Partial<AppealRecord> = {}): AppealRecord => ({
  campaignId: 'robo-claims',
  wallet: parseAddress(address),
  text: 'This wallet is mine.',
  textHash: `0x${'0'.repeat(64)}`,
  signedAt: 1,
  signature: `0x${'a'.repeat(130)}`,
  appealedAction: 'hold',
  appealedRule: 'B1',
  advice: null,
  adviceReason: null,
  adviceRequestId: null,
  status: 'reversed',
  newAction: 'full',
  ownerNote: null,
  ...overrides,
});

const held = (address: string, action: Outcome = 'hold') => {
  const row = rowFor(PLAIN, address);
  const shareBps = action === 'full' ? 10000 : action === 'partial' ? 5000 : 0;
  return recordFor(row, { action, modelAction: action, shareBps });
};

const FAMILY: FarmKeyEntry = { collector: wallet('c1'), family: 1, fundingWallet: null };

describe('scoreVersion', () => {
  const ROWS = [rowFor(PLAIN, W1), rowFor(PLAIN, W2), rowFor(PLAIN, W3)];
  const KEY = new Map([
    [W1, FAMILY],
    [W2, FAMILY],
  ]);
  const NO_FEEDBACK = { entries: [], appeals: [], hopEliminated: [] };
  const score = (robo: DecisionRecord[], hop: DecisionRecord[], feedback: Parameters<typeof scoreVersion>[5]) =>
    scoreVersion('v1', robo, ROWS, KEY, hop, feedback);

  it('counts every key wallet in the rows, and an undecided one is not held', () => {
    const result = score([held(W1), held(W3)], [], NO_FEEDBACK);
    expect(result.name).toBe('v1');
    expect(result.catchRate).toEqual({ held: 1, wallets: 2, rate: 0.5 });
  });

  it('counts an exclude as held, and matches the key in any letter case', () => {
    const rows = [rowFor(PLAIN, parseAddress(W1))];
    const result = scoreVersion('v1', [held(W1, 'exclude')], rows, KEY, [], NO_FEEDBACK);
    expect(result.catchRate).toEqual({ held: 1, wallets: 1, rate: 1 });
  });

  it('gives the false-hold rate with the Wilson interval, and calls nothing held on an empty sample', () => {
    const result = score([], [held(W4), held(W5, 'exclude'), held(W1, 'full'), held(W2, 'partial')], NO_FEEDBACK);
    const interval = wilson(2, 4);
    expect(result.falseHold).toEqual({ held: 2, wallets: 4, rate: 0.5, low: interval?.low, high: interval?.high });
    expect(score([], [], NO_FEEDBACK).falseHold).toEqual({ held: 0, wallets: 0, rate: 0, low: 0, high: 0 });
  });

  it('marks a blocked entry right only when the action moved, and ignores other routes', () => {
    const entries = [entry(W1), entry(W2), entry(W3, { verdict: { ...passed, route: 'review' } }), entry(W3, { verdict: passed }), entry(W3, { verdict: null })];
    const result = score([held(W1), held(W2, 'full')], [], { ...NO_FEEDBACK, entries });
    expect(result.feedback).toEqual({ right: 1, total: 2 });
  });

  it("reads a wallet in both sets from the entry's own set", () => {
    const entries = [entry(W1, { set: 'hop' })];
    expect(score([held(W1)], [held(W1, 'full')], { ...NO_FEEDBACK, entries }).feedback).toEqual({ right: 1, total: 1 });
    expect(score([held(W1, 'full')], [held(W1)], { ...NO_FEEDBACK, entries }).feedback).toEqual({ right: 0, total: 1 });
  });

  it("reads a blocked Hop entry from the eliminated sample without touching the false-hold rate", () => {
    const entries = [entry(W4, { set: 'hop' })];
    const result = score([], [], { ...NO_FEEDBACK, entries, hopEliminated: [held(W4, 'full')] });
    expect(result.feedback).toEqual({ right: 1, total: 1 });
    expect(result.falseHold.wallets).toBe(0);
  });

  it('never marks a blocked entry right when the version has no decision for it', () => {
    expect(score([], [], { ...NO_FEEDBACK, entries: [entry(W1)] }).feedback).toEqual({ right: 0, total: 1 });
  });

  it.each([
    ['full', 'full', 1],
    ['full', 'partial', 1],
    ['partial', 'partial', 1],
    ['partial', 'full', 0],
    ['hold', 'partial', 0],
  ] as const)('marks an action of %s against a reversal to %s', (action, newAction, right) => {
    const appeals = [appeal(W1, { newAction })];
    expect(score([held(W1, action)], [], { ...NO_FEEDBACK, appeals }).feedback).toEqual({ right, total: 1 });
  });

  it('counts only reversed appeals, and needs a wallet in both sets to meet the reversal in both', () => {
    const open = appeal(W2, { status: 'open', newAction: null });
    const upheld = appeal(W3, { status: 'upheld', newAction: null });
    const appeals = [appeal(parseAddress(W1)), open, upheld];
    expect(score([held(W1, 'full')], [], { ...NO_FEEDBACK, appeals }).feedback).toEqual({ right: 1, total: 1 });
    expect(score([held(W1, 'full')], [held(W1)], { ...NO_FEEDBACK, appeals }).feedback).toEqual({ right: 0, total: 1 });
  });

  it('refuses a ROBO record from older rows', () => {
    const stale = recordFor(rowFor(PLAIN, W1), { ceiling: 'partial' });
    expect(() => score([stale], [], NO_FEEDBACK)).toThrow(STALE_DECISION);
  });
});

describe('splitAppeals', () => {
  it('calls a wallet on no replay list a test wallet, in any letter case', () => {
    const real = appeal(parseAddress(W1));
    const made = appeal(parseAddress(FAR_AWAY));
    expect(splitAppeals([real, made], [W1, W2])).toEqual({ claimant: [real], testWallet: [made] });
  });
});

describe('heldShare', () => {
  it('counts holds and excludes, and reads 0 on an empty list', () => {
    expect(heldShare([held(W1), held(W2, 'exclude'), held(W3, 'partial'), held(W4, 'full')])).toEqual({ held: 2, wallets: 4, rate: 0.5 });
    expect(heldShare([])).toEqual({ held: 0, wallets: 0, rate: 0 });
  });
});

describe('compareVersions and versionsToMarkdown', () => {
  const ROWS = [rowFor(PLAIN, W1), rowFor(PLAIN, W2)];
  const KEY = new Map([[W1, FAMILY]]);
  const V1 = { robo: [held(W1), held(W2)], hopSample: [held(W3), held(W4, 'full')], hopEliminated: [held(W5)] };
  const V2 = { robo: [held(W1), held(W2, 'full')], hopSample: [held(W3, 'full'), held(W4, 'full')], hopEliminated: [held(W5, 'full')] };
  const ENTRIES = [
    entry(W2, { group: 'contract-hold' }),
    entry(W5, { set: 'hop', group: 'eliminated-hold', verdict: { score: 43, decision: 'reject', confidence: 'medium', route: 'block', reason: 'Checked.' } }),
    entry(W1, { group: 'known-farm-hold', verdict: passed }),
    entry(W1, { group: 'plain-full', verdict: { ...passed, route: 'review' } }),
    entry(W2, { group: 'burst-partial', verdict: null }),
  ];
  const APPEALS = [
    appeal(parseAddress(FAR_AWAY), { campaignId: 'thuli-appeal-proof' }),
    appeal(W2, { status: 'open', newAction: null, campaignId: 'robo-claims' }),
  ];
  const comparison = compareVersions(V1, V2, { roboRows: ROWS, key: KEY, entries: ENTRIES, appeals: APPEALS, listed: [W1, W2, W3, W4, W5] });
  const report = versionsToMarkdown(comparison, { runDate: '2026-11-06' });

  it('scores both versions over the same rows', () => {
    expect(comparison.v1).toMatchObject({ name: 'v1', feedback: { right: 0, total: 2 }, falseHold: { held: 1, wallets: 2 } });
    expect(comparison.v2).toMatchObject({ name: 'v2', feedback: { right: 2, total: 2 }, falseHold: { held: 0, wallets: 2 } });
    expect(comparison.eliminatedHeld).toEqual({ v1: { held: 1, wallets: 1, rate: 1 }, v2: { held: 0, wallets: 1, rate: 0 } });
    expect(comparison.routes).toEqual({ ship: 1, review: 1, block: 2, unread: 1 });
  });

  it('keeps a test wallet out of the feedback number and counts it on its own line', () => {
    expect(comparison.testWalletAppeals).toBe(1);
    expect(comparison.v2.feedback.total).toBe(2);
    expect(report).toContain('Appeals by a test wallet, left out of the feedback number because no real claimant wrote them: 1');
    expect(report).toContain('- thuli-appeal-proof: reversed, hold to full, test wallet');
    expect(report).toContain('- robo-claims: open, hold\n');
  });

  it('prints the four measures side by side, with the eliminated sample labelled as a cost', () => {
    expect(report).toContain('| Measure | v1 | v2 |');
    expect(report).toContain('| ROBO catch rate: Bitquery key wallets held or excluded | 100.0% (1 of 1) | 100.0% (1 of 1) |');
    expect(report).toContain('| Hop false-hold rate: probably-real sample held or excluded | 50.00% (1 of 2), 95% interval');
    expect(report).toContain('| Feedback set right | 0 of 2 | 2 of 2 |');
    expect(report).toContain("| Hop's eliminated A8/A9 sample held: not a recall claim, the cost of the change | 100.00% (1 of 1) | 0.00% (0 of 1) |");
  });

  it('gives one line per verdict in the feedback set, with what v2 does now', () => {
    expect(report).toContain('- contract-hold: stored hold, score 40, route block, confidence high, v2 now full');
    expect(report).toContain('- eliminated-hold: stored hold, score 43, route block, confidence medium, v2 now full');
    expect(report).not.toContain('- known-farm-hold');
  });

  it('counts every verdict by route and closes by naming what it does not cover', () => {
    expect(report).toContain('Ship: 1\nReview: 1\nBlock: 2\nPaid but out of shape: 1');
    expect(report.indexOf('## Not covered')).toBeGreaterThan(report.indexOf('## Appeals'));
    expect(report).toContain('No model read the new rulebook');
    expect(report).toContain('No verdict here is on a v2 decision');
  });

  it('names no wallet in the report or the stored summary, and has no long dashes', () => {
    for (const text of [report, JSON.stringify(comparison)]) {
      expect(text).not.toMatch(/0x/i);
      expect(text).not.toContain(LONG_DASH);
    }
  });
});

const decisionsFile = (name: string) => fileURLToPath(new URL(`../../../data/replay/${name}`, import.meta.url));
const STORED_RUNS = ['robo/decisions.jsonl', 'hop/decisions-sample.jsonl', 'hop/decisions-eliminated.jsonl'] as const;
const hasStoredRuns = STORED_RUNS.every((name) => fs.existsSync(decisionsFile(name)));

function storedLines<T>(name: string): T[] {
  return fs.readFileSync(decisionsFile(name), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as T);
}

describe.runIf(hasStoredRuns)('asRulebookV2 on the real stored runs', () => {
  it.each(STORED_RUNS)(
    'leaves every refusal and burst replacement in %s unchanged, and moves only holds on a funder alone',
    (name) => {
      const set = name.split('/')[0] as string;
      const rows = new Map(storedLines<ReplayRow>(`${set}/rows.jsonl`).map((row) => [row.wallet, row]));
      const records = storedLines<{ value: DecisionRecord }>(name).map((line) => line.value);

      const notAccepted = records.filter((record) => !record.accepted);
      expect(notAccepted.length).toBeGreaterThan(0);
      for (const record of notAccepted) {
        expect(asRulebookV2(record, rows.get(record.wallet) as ReplayRow, DEFAULT_SETTINGS)).toEqual(record);
      }

      const moved = records.filter((record) => {
        const after = asRulebookV2(record, rows.get(record.wallet) as ReplayRow, DEFAULT_SETTINGS);
        if (JSON.stringify(after) === JSON.stringify(record)) return false;
        expect(record).toMatchObject({ action: 'hold', rule: 'B1', accepted: true, cause: null });
        expect(after).toMatchObject({ action: record.start.outcome, rule: record.start.rule, accepted: false, cause: FUNDER_KEPT_CAUSE, clampedFrom: 'hold' });
        expect(rows.get(record.wallet)?.facts).toMatchObject({ sharedDepositAddress: null });
        expect(rows.get(record.wallet)?.facts.group?.linkedByWallet).not.toBe(true);
        return true;
      });
      expect(moved.length).toBeGreaterThan(0);
    },
    60_000,
  );

  it('holds at least one real burst replacement, so the case above is not empty', () => {
    const records = storedLines<{ value: DecisionRecord }>('robo/decisions.jsonl').map((line) => line.value);
    expect(records.filter((record) => record.cause === BURST_KEPT_CAUSE && record.modelAction !== null).length).toBeGreaterThan(0);
  }, 60_000);
});

// Not covered here: loading the real files, rebuilding the group labels offline and writing the JSON (the export script
// does those, and its run on the real replay is the proof), how the labels are made (factsEngine.test.ts), how scoreHop
// counts (hopScore.test.ts), how the version scorecard is scored (versions.test.ts), and whether the web app draws these
// numbers or fetches these files correctly.
import { describe, expect, it } from 'vitest';
import {
  computeCeiling,
  computeStart,
  DEFAULT_SETTINGS,
  FUNDER_KEPT_CAUSE,
  MALFORMED_HASH_CAUSE,
  parseAddress,
  type Facts,
  type FarmKeyEntry,
  type Outcome,
  type ReplayRow,
  type Start,
} from '@thuli/core';
import type { ClaimEvent } from '../src/replay/answerKeys.ts';
import type { DecisionRecord } from '../src/replay/decide.ts';
import { decisionsToMarkdown, scoreDecisions } from '../src/replay/decisionScore.ts';
import type { HopCohort, HopScore } from '../src/replay/hopScore.ts';
import { asRulebook } from '../src/replay/versions.ts';
import {
  buildWalletFiles,
  buildWebExport,
  buildWebHop,
  buildWebVersions,
  checkRulebookMoves,
  cleanReason,
  ExportCheckError,
  ROBO_CLAIM_CONTRACT,
} from '../src/replay/webExport.ts';

const LONG_DASH = '\u2014';
const ROBO = 10n ** 18n;
const wallet = (tag: string) => `0x${tag.repeat(20)}`;
const STRANGER = wallet('ff');
const TOO_LONG = 'the reason was longer than 280 characters';
const SHARE_FOR: Record<Outcome, number> = { full: 10000, partial: DEFAULT_SETTINGS.partialShareBps, hold: 0, exclude: 0 };

const FULL_A9: Start = { outcome: 'full', rule: 'A9' };
const PARTIAL_A8: Start = { outcome: 'partial', rule: 'A8' };
const HOLD_A1: Start = { outcome: 'hold', rule: 'A1' };
const HOLD_A4: Start = { outcome: 'hold', rule: 'A4' };
const EXCLUDE_A3: Start = { outcome: 'exclude', rule: 'A3' };

// Labels are the first wallet of each group, as the facts engine names them.
const [G1, G2, G3] = [wallet('a1'), wallet('a2'), wallet('a7')] as [string, string, string];

interface Spec {
  tag: string;
  start: Start;
  action: Outcome;
  group: [label: string, size: number] | null;
  burst: boolean;
  claims: bigint[];
  record?: Partial<DecisionRecord>;
}

const SPECS: Spec[] = [
  { tag: 'a1', start: FULL_A9, action: 'full', group: [G1, 2], burst: false, claims: [(16n * ROBO) / 10n, ROBO / 2n], record: { secondAsk: true, firstCause: TOO_LONG } },
  { tag: 'a2', start: HOLD_A4, action: 'hold', group: [G2, 3], burst: false, claims: [10_000n * ROBO] },
  { tag: 'a3', start: PARTIAL_A8, action: 'partial', group: [G1, 2], burst: false, claims: [(9n * ROBO) / 10n], record: { mode: 'v2' } },
  { tag: 'a4', start: EXCLUDE_A3, action: 'exclude', group: null, burst: true, claims: [5n * ROBO] },
  { tag: 'a5', start: HOLD_A4, action: 'hold', group: [G2, 3], burst: false, claims: [3n * ROBO, 4n * ROBO] },
  { tag: 'a6', start: EXCLUDE_A3, action: 'exclude', group: [G2, 3], burst: false, claims: [1n] },
  { tag: 'a7', start: PARTIAL_A8, action: 'partial', group: [G3, 2], burst: false, claims: [20n * ROBO] },
  { tag: 'a8', start: FULL_A9, action: 'full', group: null, burst: false, claims: [100_000n * ROBO] },
  {
    tag: 'a9',
    start: HOLD_A1,
    action: 'hold',
    group: [G3, 2],
    burst: true,
    claims: [(5n * ROBO) / 2n],
    record: { accepted: false, cause: TOO_LONG, secondAsk: true, firstCause: TOO_LONG },
  },
];

function rowFor(spec: Spec, index: number): ReplayRow {
  return {
    // Checksummed once on purpose: the export must lowercase before it looks the wallet up anywhere.
    wallet: index === 0 ? parseAddress(wallet(spec.tag)) : wallet(spec.tag),
    start: spec.start,
    ceiling: 'full',
    facts: {
      walletAgeDays: 12,
      txCountAtSnapshot: 2,
      accountType: 'eoa',
      firstFunder: null,
      group:
        spec.group === null
          ? null
          : { size: spec.group[1], sameFunderWithinWindow: null, sweptToSharedCollector: false, authoredEvidence: false, linkedByWallet: false },
      sharedDepositAddress: null,
      fundingBurst: spec.burst ? { wallets: 20 } : null,
      claimPaidToOtherAddress: false,
      evidenceTxs: [],
      missing: [],
    },
  };
}

function recordFor(spec: Spec): DecisionRecord {
  return {
    wallet: wallet(spec.tag),
    mode: 'v3',
    fallback: false,
    start: spec.start,
    ceiling: 'full',
    requestId: 'run-1',
    rawText: '{}',
    usage: { inputTokens: 100, outputTokens: 10 },
    verdict: 'unclear',
    modelAction: spec.action,
    modelRule: spec.start.rule,
    action: spec.action,
    shareBps: SHARE_FOR[spec.action],
    rule: spec.start.rule,
    reason: 'A reason.',
    citedTxs: [],
    clampedFrom: null,
    accepted: true,
    cause: null,
    secondAsk: false,
    firstCause: null,
    ...spec.record,
  };
}

const claim = (recipient: string, amountWei: bigint, block: number): ClaimEvent => ({ recipient, account: recipient, amountWei, block });

const ROWS = SPECS.map(rowFor);
const RECORDS = new Map(SPECS.map((spec) => [wallet(spec.tag), recordFor(spec)]));
const CLAIMS: ClaimEvent[] = [
  ...SPECS.flatMap((spec) => spec.claims.map((wei, i) => claim(wallet(spec.tag), wei, 24_546_233 + i))),
  claim(STRANGER, 1_000n * ROBO, 24_546_300),
];
const LABELS = new Map(SPECS.flatMap((spec): [string, string][] => (spec.group === null ? [] : [[wallet(spec.tag), spec.group[0]]])));
const entry = (family: number): FarmKeyEntry => ({ collector: wallet(`c${family}`), family, fundingWallet: null });
const KEY = new Map<string, FarmKeyEntry>([
  [wallet('a2'), entry(1)],
  [wallet('a4'), entry(1)],
  [wallet('a5'), entry(2)],
  [wallet('a6'), entry(2)],
]);
const META = { runDate: '2026-11-10', spentCents: 1751, rowsSha256: 'a'.repeat(64), decisionsSha256: 'b'.repeat(64), rulebook: 2 as const };

type ExportInput = Parameters<typeof buildWebExport>[0];
const build = (overrides: Partial<ExportInput> = {}) =>
  buildWebExport({ rows: ROWS, records: RECORDS, claims: CLAIMS, farmKey: KEY, groupLabels: LABELS, meta: META, ...overrides });
const files = (overrides: Partial<ExportInput> = {}) =>
  buildWalletFiles({ rows: ROWS, records: RECORDS, claims: CLAIMS, farmKey: KEY, groupLabels: LABELS, meta: META, ...overrides });
const withRecord = (tag: string, change: Partial<DecisionRecord>) => {
  const spec = SPECS.find((candidate) => candidate.tag === tag) as Spec;
  return new Map([...RECORDS, [wallet(tag), { ...recordFor(spec), ...change }]]);
};

describe('buildWebExport', () => {
  it('codes each wallet by its stored final action, in row order', () => {
    const { points } = build();
    expect(points.count).toBe(9);
    expect(points.outcome).toEqual([0, 2, 1, 3, 2, 3, 1, 0, 2]);
  });

  it('numbers groups largest first, then by their earliest wallet, and gives -1 to a wallet in no group', () => {
    const { summary, points } = build();
    expect(points.group).toEqual([1, 0, 1, -1, 0, 0, 2, -1, 2]);
    expect(summary.groups.map(({ size, held }) => ({ size, held }))).toEqual([
      { size: 3, held: 3 },
      { size: 2, held: 0 },
      { size: 2, held: 1 },
    ]);
  });

  it('sums claim events in wei per wallet and per group before rounding down, and counts only the rows', () => {
    const { summary, points } = build();
    expect(points.robo).toEqual([2, 10_000, 0, 5, 7, 0, 20, 100_000, 2]);
    // 2.1 and 0.9 ROBO make 3 whole ROBO together, though each alone rounds down to 2 and 0.
    expect(summary.groups.map((group) => group.robo)).toEqual([10_007, 3, 22]);
    expect(summary.claims).toBe(11);
  });

  it('flags the wallets first funded in a burst', () => {
    expect(build().points.burst).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it('throws on a wallet with no stored decision', () => {
    const records = new Map(RECORDS);
    records.delete(wallet('a4'));
    expect(() => build({ records })).toThrow(ExportCheckError);
    expect(() => build({ records })).toThrow('row 4 has no stored decision');
  });

  it('throws when a label disagrees with facts.group', () => {
    const missing = new Map(LABELS);
    missing.delete(wallet('a7'));
    expect(() => build({ groupLabels: new Map([...LABELS, [wallet('a4'), wallet('a4')]]) })).toThrow('row 4: its group label and its facts.group disagree');
    expect(() => build({ groupLabels: missing })).toThrow('row 7: its group label and its facts.group disagree');
    expect(() => build({ groupLabels: new Map([...LABELS, [wallet('a3'), G2]]) })).toThrow(
      'row 1: 1 wallets share its group label, but its facts.group.size is 2',
    );
    expect(() => build({ groupLabels: new Map([...LABELS, [STRANGER, G1]]) })).toThrow('a group label names a wallet outside the replay rows');
  });

  it('takes every summary figure from scoreDecisions and the scorecard arithmetic', () => {
    const claimed = new Map(SPECS.map((spec) => [wallet(spec.tag), spec.claims.reduce((sum, wei) => sum + wei, 0n)]));
    const score = scoreDecisions([...RECORDS.values()], ROWS, KEY, claimed);
    const report = decisionsToMarkdown(score, { runDate: META.runDate, spentCents: META.spentCents });
    const line = (start: string) => report.split('\n').find((text) => text.startsWith(start));
    const dollars = (value: number) => `$${value.toLocaleString('en-US')}`;
    const { summary } = build();

    expect(summary.wallets).toBe(score.wallets);
    expect(summary.outcomes).toEqual(score.final);
    // 10,012 of 110,037.5 ROBO claimed, and one wei, is 909.9 basis points.
    expect(summary.farmKey).toEqual({ wallets: 4, held: score.finalHeld.key, families: score.families, shareOfDropBps: 909 });
    expect(summary.robo).toEqual({ claimedKey: score.robo.allKey, keptKey: score.robo.keptKey, claimedOther: score.robo.allOther, keptOther: score.robo.keptOther });
    expect(line('Key wallets: ')?.endsWith(`(${dollars(summary.usd.keptKey)} of ${dollars(summary.usd.claimedKey)})`)).toBe(true);
    expect(line('Other wallets: ')?.endsWith(`(${dollars(summary.usd.keptOther)} of ${dollars(summary.usd.claimedOther)})`)).toBe(true);
    expect(summary.usd.claimedOther).toBe(4_194);
    expect(summary.answers).toEqual({ accepted: score.accepted, firstRefused: score.secondAsks.asked, fixedBySecondAsk: score.secondAsks.fixed, stillRefused: 1 });
    expect(summary.modes).toEqual({ v3: score.modes.v3, v2: score.modes.v2 });
    expect(summary.run.centsPerWallet).toBe(194.556);
    expect(report).toContain(`(${summary.run.centsPerWallet.toFixed(3)} cents per wallet)`);
  });

  it('names the rulebook the outcomes were decided under, and refuses one the checks do not know', () => {
    expect(build().summary.run.rulebook).toBe(2);
    expect(() => build({ meta: { ...META, rulebook: 3 as unknown as 2 } })).toThrow('the rulebook is not a version the checks know');
  });

  it('holds no wallet address, label or collector, and no address but the claim contract', () => {
    const { summary, points } = build();
    const text = `${JSON.stringify(summary)}${JSON.stringify(points)}`.toLowerCase();
    for (const address of [...SPECS.map((spec) => wallet(spec.tag)), STRANGER, wallet('c1'), wallet('c2')]) expect(text).not.toContain(address);
    expect(JSON.stringify(points)).not.toContain('0x');
    expect(JSON.stringify(summary).match(/0x[0-9a-f]+/gi)).toEqual([ROBO_CLAIM_CONTRACT]);
  });
});

describe('cleanReason', () => {
  it('drops one leading rule code and the spaces after it', () => {
    expect(cleanReason('A8:  The wallet is 142 days old.')).toBe('The wallet is 142 days old.');
    expect(cleanReason('B2: A9: only the first code goes.')).toBe('A9: only the first code goes.');
  });

  it('turns every long dash, with any spaces around it, into a comma and one space', () => {
    expect(cleanReason(`Unclear${LONG_DASH}(1) no transactions ${LONG_DASH}  (2) exchange funding.`)).toBe('Unclear, (1) no transactions, (2) exchange funding.');
  });

  it('does both on one reason', () => {
    expect(cleanReason(`A3: swept to a shared collector${LONG_DASH}strong farm evidence. `)).toBe('swept to a shared collector, strong farm evidence.');
  });

  it('changes nothing else', () => {
    for (const text of ['A8 retained: unclear, partial.', 'a8: a lowercase code stays.', 'Old wallet; rule A8: applies.']) {
      expect(cleanReason(text)).toBe(text);
    }
  });
});

describe('buildWalletFiles', () => {
  it('puts each wallet in the shard named by its first two hex characters, and writes all 256 shards', () => {
    const hash = `0x${'ab'.repeat(32)}`;
    const rows = ROWS.map((row, index): ReplayRow =>
      index === 1 ? { ...row, facts: { ...row.facts, firstFunder: { address: parseAddress(wallet('f1')), kind: 'exchange', fanoutInList: 3, hopsTraced: 1 } } } : row,
    );
    const { shards } = files({ rows, records: withRecord('a2', { reason: 'A4: Held with its group.', citedTxs: [hash] }) });

    expect([...shards.keys()]).toEqual(Array.from({ length: 256 }, (_, n) => n.toString(16).padStart(2, '0')));
    // Row 1 is checksummed in the rows, and still lands once, lowercase.
    const placed = [...shards].flatMap(([name, shard]) => Object.keys(shard.wallets).map((address) => [name, address]));
    expect(placed).toEqual(SPECS.map((spec) => [spec.tag, wallet(spec.tag)]));
    expect(shards.get('a2')?.wallets[wallet('a2')]).toEqual({
      i: 1,
      outcome: 2,
      shareBps: 0,
      rule: 'A4',
      reason: 'Held with its group.',
      txs: [hash],
      robo: 10_000,
      group: 0,
      start: { outcome: 'hold', rule: 'A4' },
      facts: {
        ageDays: 12,
        txCount: 2,
        accountType: 'eoa',
        funder: { address: wallet('f1'), kind: 'exchange', fanout: 3, hops: 1 },
        burstWallets: null,
        sameFunderWithinWindow: null,
        sweptToSharedCollector: false,
        missing: [],
      },
      serv: { mode: 'v3', requestId: 'run-1', accepted: true, secondAsk: false },
    });
  });

  it('lists every member of a group, held or not, in claim-list order, under the numbers summary.groups holds', () => {
    const { groups } = files();
    const { summary } = build();
    expect(groups.map((group) => group.members.map((member) => member.address))).toEqual([
      [wallet('a2'), wallet('a5'), wallet('a6')],
      [wallet('a1'), wallet('a3')],
      [wallet('a7'), wallet('a9')],
    ]);
    expect(groups[2]?.members.map((member) => member.outcome)).toEqual([1, 2]);
    expect(groups.map(({ index, size, held, robo }) => ({ index, size, held, robo }))).toEqual(summary.groups.map((group, index) => ({ index, ...group })));
  });

  it('never exports the raw model reply', () => {
    const secret = 'raw reply text that stays private';
    const records = new Map([...RECORDS].map(([key, record]): [string, DecisionRecord] => [key, { ...record, rawText: `{"reason":"${secret}"}` }]));
    const { shards, groups } = files({ records });
    const text = JSON.stringify([...shards.values(), ...groups]);
    expect(text).not.toContain('rawText');
    expect(text).not.toContain(secret);
  });

  it('refuses a reason that fails the plain-text rule', () => {
    for (const reason of ['A8: See <b>this</b>.', 'A8: Read [the proof](x) first.']) {
      expect(() => files({ records: withRecord('a3', { reason }) })).toThrow(ExportCheckError);
      expect(() => files({ records: withRecord('a3', { reason }) })).toThrow('row 3: its reason is not plain text');
    }
  });
});

describe('checkRulebookMoves', () => {
  // An old, active wallet whose only weak fact is a contract funder shared with 62 other claim wallets: start full, A9.
  const FUNDED: Facts = {
    walletAgeDays: 324,
    txCountAtSnapshot: 16,
    accountType: 'eoa',
    firstFunder: { address: parseAddress(wallet('f1')), kind: 'contract', fanoutInList: 63, hopsTraced: 0 },
    group: null,
    sharedDepositAddress: null,
    fundingBurst: null,
    claimPaidToOtherAddress: false,
    evidenceTxs: [],
    missing: [],
  };
  const start = computeStart(FUNDED, DEFAULT_SETTINGS);
  const { ceiling } = computeCeiling(FUNDED, DEFAULT_SETTINGS);
  const row: ReplayRow = { wallet: wallet('b1'), start, ceiling, facts: FUNDED };
  // Stored under rulebook 1: the model's graph g1 hold on the funder count alone, accepted then.
  const storedHold: DecisionRecord = {
    ...recordFor({ tag: 'b1', start, action: 'hold', group: null, burst: false, claims: [] }),
    ceiling,
    rawText: JSON.stringify({ verdict: 'likely_farm', recommended_outcome: 'hold_for_review', reason: 'The contract funder also funded 62 claim wallets.' }),
    verdict: 'likely_farm',
    modelRule: 'B1',
    rule: 'B1',
    reason: 'The contract funder also funded 62 claim wallets.',
  };
  const one = (record: DecisionRecord) => new Map([[record.wallet, record]]);

  it('puts a stored hold on a shared funder alone back at its start under rulebook 2, and counts it as moved (C47)', () => {
    expect(start).toEqual({ outcome: 'full', rule: 'A9' });
    const now = asRulebook(storedHold, row, DEFAULT_SETTINGS, 2);
    expect(now).toMatchObject({ action: 'full', rule: 'A9', shareBps: 10_000, cause: FUNDER_KEPT_CAUSE, clampedFrom: 'hold' });
    expect(checkRulebookMoves([row], one(storedHold), one(now))).toEqual({
      toStart: 1,
      heldByChecks: 0,
      stored: { full: 0, partial: 0, hold: 1, exclude: 0 },
      exported: { full: 1, partial: 0, hold: 0, exclude: 0 },
    });
    expect(checkRulebookMoves([row], one(storedHold), one(asRulebook(storedHold, row, DEFAULT_SETTINGS, 1)))).toMatchObject({ toStart: 0, heldByChecks: 0 });
  });

  it("counts a stored reward that today's checks refuse as a hold of its own kind (C11, C13)", () => {
    const young: Facts = { ...FUNDED, walletAgeDays: 5, txCountAtSnapshot: 1, firstFunder: null };
    const youngStart = computeStart(young, DEFAULT_SETTINGS);
    const youngRow: ReplayRow = { wallet: wallet('b3'), start: youngStart, ceiling: computeCeiling(young, DEFAULT_SETTINGS).ceiling, facts: young };
    // A space after 0x, as in a stored v2 reply the older hash scan let through.
    const reason = `A funding pattern alone does not prove one owner (0x ${'ab'.repeat(32)}).`;
    const storedPartial: DecisionRecord = {
      ...recordFor({ tag: 'b3', start: youngStart, action: 'partial', group: null, burst: false, claims: [] }),
      ceiling: youngRow.ceiling,
      mode: 'v2',
      rawText: JSON.stringify({ verdict: 'unclear', action: 'partial', rule: youngStart.rule, reason, cited_tx_hashes: [] }),
      reason,
    };
    expect(youngStart).toEqual({ outcome: 'partial', rule: 'A8' });
    const now = asRulebook(storedPartial, youngRow, DEFAULT_SETTINGS, 2);
    expect(now).toMatchObject({ action: 'hold', rule: 'A1', accepted: false, cause: MALFORMED_HASH_CAUSE });
    expect(checkRulebookMoves([youngRow], one(storedPartial), one(now))).toMatchObject({
      toStart: 0,
      heldByChecks: 1,
      stored: { partial: 1, hold: 0 },
      exported: { partial: 0, hold: 1 },
    });
  });

  const refusedHold = { accepted: false, cause: 'the reason was longer than 280 characters' };
  const funderKept = { accepted: false, cause: FUNDER_KEPT_CAUSE };
  it.each([
    ['a stored hold raised past its start', 'hold', { action: 'full', ...funderKept }, { outcome: 'partial', rule: 'A8' }],
    ['a stored hold moved to anything but its start', 'hold', { action: 'partial', ...funderKept }, start],
    ['a stored hold raised to its start by a reply now accepted, not the shared-funder rule', 'hold', { action: 'full', accepted: true, cause: null }, start],
    ['a stored exclude raised to a refused hold', 'exclude', { action: 'hold', ...refusedHold }, start],
    ['a stored full reward cut to a hold the checks accepted', 'full', { action: 'hold', accepted: true, cause: null }, start],
    ['a stored full reward cut to a partial the checks refused', 'full', { action: 'partial', ...refusedHold }, start],
    ['a stored partial reward raised to its full start', 'partial', { action: 'full', ...funderKept }, start],
  ] as const)('refuses %s (C47, C11)', (_label, was, now, rowStart) => {
    const at = { ...row, start: rowStart };
    expect(() => checkRulebookMoves([at], one({ ...storedHold, action: was }), one({ ...storedHold, ...now }))).toThrow(
      "row 1: its outcome changed in a way neither the shared-funder rule nor a refused reply explains",
    );
  });

  it('refuses an exported outcome above the row ceiling, even one equal to the start or unchanged (C12)', () => {
    const capped = { ...row, ceiling: 'partial' as const };
    for (const [was, now] of [['hold', 'full'], ['full', 'full']] as const) {
      expect(() => checkRulebookMoves([capped], one({ ...storedHold, action: was }), one({ ...storedHold, action: now, ...funderKept }))).toThrow(
        'row 1: its exported outcome is above its ceiling',
      );
    }
    expect(checkRulebookMoves([capped], one({ ...storedHold, action: 'partial' }), one({ ...storedHold, action: 'partial' }))).toMatchObject({
      toStart: 0,
      heldByChecks: 0,
    });
  });

  it('refuses a row with no decision on either side, or one filed under another wallet', () => {
    expect(() => checkRulebookMoves([row], new Map(), one(storedHold))).toThrow('row 1 has no stored decision');
    expect(() => checkRulebookMoves([row], one(storedHold), new Map())).toThrow('row 1 has no stored decision');
    const elsewhere = new Map([[row.wallet, { ...storedHold, wallet: wallet('b2') }]]);
    expect(() => checkRulebookMoves([row], one(storedHold), elsewhere)).toThrow('row 1: a decision for it names another wallet');
  });
});

describe('buildWebHop', () => {
  const cohort = (counted: number, hold: number, exclude: number): HopCohort => ({
    screened: counted + 7,
    noEthereumHistory: 7,
    counted,
    full: counted - hold - exclude - 3,
    partial: 3,
    hold,
    exclude,
    heldRate: counted === 0 ? null : (hold + exclude) / counted,
    heldLow: counted === 0 ? null : 0.004,
    heldHigh: counted === 0 ? null : 0.007,
    byRule: { A1: 1, A2: 0, A3: exclude, A4: hold - 1, A5: 0, A6: 0, A7: 0, A8: 3, A9: counted - hold - exclude - 3 },
    inBurst: 2,
    burstOnly: 1,
  });
  const SCORE: HopScore = {
    wallets: 300,
    notScreened: 0,
    negatives: cohort(200, 9, 1),
    keptInGroups: cohort(40, 5, 0),
    eliminated: cohort(60, 30, 4),
    clusters: { total: 12, touched: 8, fullyHeld: 3, noCounted: 2 },
  };

  it('copies the probably-real and eliminated cohorts and the clusters, field by field, with held counting excluded', () => {
    const { value, text } = buildWebHop(SCORE, '2026-11-10');
    expect(value).toEqual({
      schema: 1,
      runDate: '2026-11-10',
      probablyReal: { screened: 207, noHistory: 7, counted: 200, held: 10, heldLow: 0.004, heldHigh: 0.007, excluded: 1, partial: 3, full: 187 },
      eliminated: { screened: 67, noHistory: 7, counted: 60, held: 34, heldLow: 0.004, heldHigh: 0.007, excluded: 4, partial: 3, full: 23 },
      clusters: { total: 12, touched: 8, fullyHeld: 3, uncounted: 2 },
    });
    expect(JSON.parse(text)).toEqual(value);
    expect(text.startsWith('{')).toBe(true);
  });

  it('carries nothing the score holds beyond the listed counts, and refuses an address-like run date (C33, C34)', () => {
    const address = `0x${'ab'.repeat(20)}`;
    const leaky = { ...SCORE, negatives: { ...SCORE.negatives, wallet: address }, sample: [address] } as HopScore;
    expect(buildWebHop(leaky, '2026-11-10').text).not.toContain('0x');
    expect(() => buildWebHop(SCORE, address)).toThrow('hop.json does not match its public shape');
  });

  it('refuses a cohort that counted no wallet, since it has no held rate', () => {
    expect(() => buildWebHop({ ...SCORE, eliminated: cohort(0, 0, 0) }, '2026-11-10')).toThrow('no eliminated wallet was counted');
  });
});

describe('buildWebVersions', () => {
  const score = (name: 'v1' | 'v2', held: number) => ({
    name,
    catchRate: { held: 90, wallets: 100, rate: 0.9 },
    falseHold: { held, wallets: 1500, rate: held / 1500, low: 0.006, high: 0.016 },
    feedback: { right: name === 'v1' ? 0 : 2, total: 2 },
  });
  const verdict = { group: 'contract-hold', storedAction: 'hold', score: 43, route: 'block', confidence: 'high', v1Action: 'hold', v2Action: 'full' };
  const STORED = {
    v1: score('v1', 38),
    v2: score('v2', 15),
    eliminatedHeld: { v1: { held: 56, wallets: 500, rate: 0.112 }, v2: { held: 15, wallets: 500, rate: 0.03 } },
    verdicts: [verdict, { ...verdict, score: null, route: null, confidence: null, v2Action: null }],
    routes: { ship: 3, review: 35, block: 2, unread: 0 },
    appeals: [{ campaignId: 'thuli-appeal-proof', status: 'reversed', appealedAction: 'hold', newAction: 'full', testWallet: true }],
    testWalletAppeals: 1,
    noReply: { robo: 3, hopSample: 9, hopEliminated: 9 },
  };

  it('passes every stored field through, with the run date from the flag', () => {
    const { value, text } = buildWebVersions(STORED, '2026-11-10');
    expect(value).toEqual({ ...STORED, runDate: '2026-11-10' });
    expect(JSON.parse(text)).toEqual(value);
    expect(buildWebVersions({ ...STORED, runDate: '2020-01-01' }, '2026-11-10').value.runDate).toBe('2026-11-10');
  });

  it.each([
    ['a group label that is a cut-down address', { verdicts: [{ ...verdict, group: '0xdeadbeef01' }] }, 'versions.json would hold 0x and 8 or more hex characters'],
    ['a campaign id that is a whole address', { appeals: [{ ...STORED.appeals[0], campaignId: `0x${'ab'.repeat(20)}` }] }, 'versions.json would hold 0x and 8 or more hex characters'],
    ['a field nobody listed', { verdicts: [{ ...verdict, wallet: `0x${'ab'.repeat(20)}` }] }, 'versions.json does not match its public shape'],
    ['free text where a label belongs', { verdicts: [{ ...verdict, group: 'held, see the funder' }] }, 'versions.json does not match its public shape'],
    ['a version under the wrong name', { v2: score('v1', 15) }, 'versions.json does not match its public shape'],
  ])('refuses %s (C33, C34)', (_label, change, message) => {
    expect(() => buildWebVersions({ ...STORED, ...change }, '2026-11-10')).toThrow(message);
  });

  it('refuses a stored value that is not an object, or a run date that is not a calendar day', () => {
    for (const stored of [null, [STORED], 'versions']) {
      expect(() => buildWebVersions(stored, '2026-11-10')).toThrow('versions.json does not match its public shape');
    }
    expect(() => buildWebVersions(STORED, '2026-02-30')).toThrow('versions.json does not match its public shape');
  });
});

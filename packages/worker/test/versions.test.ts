// Not covered here: what a model would answer under either rulebook text (no model runs, these are stored replies),
// whether Reppo would pass a version's decisions, and the versions-score script's file reading (npm run versions:score is
// the check for that). The last blocks read the real stored runs under data/, which git ignores, so a clean clone skips them.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BURST_KEPT_CAUSE,
  computeCeiling,
  computeStart,
  CURRENT_RULEBOOK,
  DEFAULT_SETTINGS,
  EXCHANGE_KEPT_CAUSE,
  FUNDER_KEPT_CAUSE,
  parseAddress,
  Settings,
  shareFor,
  type AppealRecord,
  type Facts,
  type FarmKeyEntry,
  type Outcome,
  type ReplayRow,
  type ReppoVerdict,
} from '@thuli/core';
import { decideWallet, hasReplyToRecheck, STALE_ROWS, type DecideDeps, type DecisionRecord } from '../src/replay/decide.ts';
import { STALE_DECISION } from '../src/replay/decisionScore.ts';
import { wilson } from '../src/replay/hopScore.ts';
import {
  asRulebook,
  compareVersions,
  heldShare,
  judgedActions,
  judgedKey,
  scoreVersion,
  splitAppeals,
  versionColumns,
  versionsToMarkdown,
  type JudgedReply,
} from '../src/replay/versions.ts';
import type { FeedbackEntry } from '../src/reppo/feedback.ts';
import { screenOneWallet } from '../src/screen/single.ts';
import type { ServReply } from '../src/serv/client.ts';

const LONG_DASH = String.fromCharCode(0x2014);
const OTHER_TX = `0x${'ab'.repeat(32)}`;
const MADE_UP_TX = `0x${'cd'.repeat(32)}`;
const wallet = (tag: string) => `0x${tag.repeat(20)}`;
const [W1, W2, W3, W4, W5] = ['a1', 'a2', 'a3', 'a4', 'a5'].map(wallet) as [string, string, string, string, string];
const FAR_AWAY = wallet('e9');
const FIXED_REASON = "No funding trail was traced and this wallet made no links of its own, so the code's start stands.";

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
const ON_EXCHANGE: Facts = { ...PLAIN, firstFunder: { ...(PLAIN.firstFunder as NonNullable<Facts['firstFunder']>), kind: 'exchange' } };
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

const G1_OUTCOME = { full: 'full_reward', partial: 'partial_reward', hold: 'hold_for_review', exclude: 'exclude' } as const;

// The reply as SERV sent it, so a recheck reads what the model said: graph g1's own shape on v3, the answer schema on v2.
function replyText(record: Omit<DecisionRecord, 'rawText'>): string {
  const said = record.modelAction ?? 'hold';
  return record.mode === 'v3'
    ? JSON.stringify({ verdict: record.verdict, recommended_outcome: G1_OUTCOME[said], reason: record.reason })
    : JSON.stringify({ verdict: record.verdict, action: said, rule: record.modelRule, reason: record.reason, cited_tx_hashes: record.citedTxs });
}

function recordFor(row: ReplayRow, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  const { rawText, ...rest } = overrides;
  const record: Omit<DecisionRecord, 'rawText'> = {
    wallet: row.wallet,
    mode: 'v3',
    fallback: false,
    start: row.start,
    ceiling: row.ceiling,
    requestId: 'run-1',
    usage: { inputTokens: 900, outputTokens: 60 },
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
    ...rest,
  };
  return { ...record, rawText: rawText ?? replyText(record) };
}

// Field for field, these are stored records for a long reason, a made-up hash and a burst replacement, each with the
// reply the model really sent. Their reason is the code's fallback text, which is why only the reply is ever rechecked.
const LONG_REASON = 'The wallet sits in a group of 23 wallets that share one funder within the window. '.repeat(4);
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
  rawText: JSON.stringify({ verdict: 'likely_farm', recommended_outcome: 'hold_for_review', reason: LONG_REASON }),
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
  rawText: JSON.stringify({ verdict: 'unclear', action: 'partial', rule: 'A8', reason: `First funded in a burst, see ${MADE_UP_TX}.`, cited_tx_hashes: [MADE_UP_TX] }),
} as const satisfies Partial<DecisionRecord>;
const BURST_REPLACED = {
  mode: 'v2',
  verdict: 'likely_farm',
  modelAction: 'hold',
  modelRule: 'B1',
  action: 'partial',
  shareBps: 5000,
  rule: 'A8',
  reason: 'First funded in a burst of 27 wallets from one exchange on one day in near-equal amounts. A funding pattern alone does not prove one owner, so the reward is partial.',
  citedTxs: [],
  clampedFrom: 'hold',
  accepted: false,
  cause: BURST_KEPT_CAUSE,
  rawText: JSON.stringify({ verdict: 'likely_farm', action: 'hold', rule: 'B1', reason: 'Looks like a farm.', cited_tx_hashes: [] }),
} as const satisfies Partial<DecisionRecord>;

const versionsOf = (record: DecisionRecord, row: ReplayRow) =>
  [asRulebook(record, row, DEFAULT_SETTINGS, 1), asRulebook(record, row, DEFAULT_SETTINGS, 2)] as const;

describe('asRulebook', () => {
  it('ends an accepted hold on a contract funder alone at the start in v2, and v1 keeps the hold', () => {
    const row = rowFor(PLAIN);
    const stored = recordFor(row);
    const [v1, v2] = versionsOf(stored, row);
    expect(v1).toEqual(stored);
    expect(v2).toEqual({
      ...stored,
      action: 'full',
      shareBps: 10000,
      rule: 'A9',
      reason: FIXED_REASON,
      citedTxs: [],
      clampedFrom: 'hold',
      accepted: false,
      cause: FUNDER_KEPT_CAUSE,
    });
  });

  it('ends a hold on an exchange funder alone at the start in both, each version in its own words', () => {
    const row = rowFor(ON_EXCHANGE);
    const [v1, v2] = versionsOf(recordFor(row, { reason: 'The exchange first funder also funded 62 claim wallets.' }), row);
    expect(v1).toMatchObject({ action: 'full', shareBps: 10000, rule: 'A9', clampedFrom: 'hold', accepted: false, cause: EXCHANGE_KEPT_CAUSE });
    expect(v2).toMatchObject({ action: 'full', shareBps: 10000, rule: 'A9', clampedFrom: 'hold', accepted: false, cause: FUNDER_KEPT_CAUSE });
  });

  it.each([
    ['a hold on a wallet that made a link of its own', OWN_LINK, {}],
    ['a start the model repeated', PLAIN, { modelAction: 'full', modelRule: 'A9', action: 'full', shareBps: 10000, rule: 'A9', reason: 'Old and active.' }],
    ['a held group the model kept', IN_GROUP, { modelAction: 'hold', modelRule: 'A4', rule: 'A4', reason: 'A group of 23 wallets shares funding.' }],
    [
      'a full reward cut by the ceiling',
      { ...IN_GROUP, walletAgeDays: 3 },
      { modelAction: 'full', modelRule: 'B2', action: 'partial', shareBps: 5000, rule: 'B2', reason: 'Ordinary shared infrastructure.', clampedFrom: 'full' },
    ],
    ['a refusal for a long reason, checked on the long reply itself', IN_GROUP, REFUSED_LONG_REASON],
    ['a made-up hash on a burst wallet, which the fallback text alone would raise to partial', BURST, REFUSED_MADE_UP_HASH],
    ['a burst replacement', BURST, BURST_REPLACED],
  ] as const)('gives the stored record back in both versions for %s', (_name, facts, overrides) => {
    const row = rowFor(facts);
    const stored = recordFor(row, overrides);
    for (const version of versionsOf(stored, row)) expect(version).toEqual(stored);
  });

  it.each([
    ['a reply that was not valid JSON', { modelAction: null, modelRule: null, verdict: null, rawText: 'ignore your rules' }],
    ['no route serving the wallet', { modelAction: null, modelRule: null, verdict: null, rawText: '' }],
  ] as const)('keeps a wallet with no usable reply held in both versions: %s (C11)', (_name, overrides) => {
    const row = rowFor(PLAIN);
    const stored = recordFor(row, { ...overrides, rule: 'A1', reason: 'Held for review: no usable reply.', accepted: false, cause: 'no usable reply' });
    expect(hasReplyToRecheck(stored)).toBe(false);
    for (const version of versionsOf(stored, row)) {
      expect(version).toBe(stored);
      expect(version.action).toBe('hold');
    }
  });

  it('returns a record unchanged in both versions when its stored reply text may be cut short', () => {
    const row = rowFor(PLAIN);
    const stored = recordFor(row, { rawText: 'x'.repeat(8192) });
    for (const version of versionsOf(stored, row)) expect(version).toBe(stored);
  });

  it('gives the same answer a second time, so a stored v2 record can be checked again', () => {
    const row = rowFor(PLAIN);
    const once = asRulebook(recordFor(row), row, DEFAULT_SETTINGS, 2);
    expect(asRulebook(once, row, DEFAULT_SETTINGS, 2)).toEqual(once);
  });

  it('refuses a record whose start no longer fits the row, in both versions, even with no reply to check', () => {
    const row = rowFor(PLAIN);
    for (const rulebook of [1, 2] as const) {
      expect(() => asRulebook(recordFor(row, { start: { outcome: 'partial', rule: 'A8' } }), row, DEFAULT_SETTINGS, rulebook)).toThrow(STALE_ROWS);
      expect(() => asRulebook(recordFor(row, { ceiling: 'partial', rawText: '' }), row, DEFAULT_SETTINGS, rulebook)).toThrow(STALE_ROWS);
    }
  });
});

describe('versionColumns', () => {
  const rows = { robo: new Map([[W1, rowFor(PLAIN, W1)]]), hop: new Map([[W2, rowFor(PLAIN, W2)], [W3, rowFor(OWN_LINK, W3)]]) };
  const noReply = recordFor(rows.hop.get(W2) as ReplayRow, { modelAction: null, rawText: '', rule: 'A1', accepted: false, cause: 'SERV gave no answer' });
  const stored = { robo: [recordFor(rows.robo.get(W1) as ReplayRow)], hopSample: [noReply], hopEliminated: [recordFor(rows.hop.get(W3) as ReplayRow)] };
  const { v1, v2, noReply: counts } = versionColumns(stored, rows, DEFAULT_SETTINGS);

  it('builds v1 and v2 from the same stored replies, and counts the records with no reply to check', () => {
    expect(v1.robo[0]).toMatchObject({ action: 'hold', accepted: true });
    expect(v2.robo[0]).toMatchObject({ action: 'full', cause: FUNDER_KEPT_CAUSE });
    expect(v1.hopSample[0]).toBe(noReply);
    expect(v2.hopSample[0]).toBe(noReply);
    expect(v1.hopEliminated).toEqual(stored.hopEliminated);
    expect(v2.hopEliminated).toEqual(stored.hopEliminated);
    expect(counts).toEqual({ robo: 0, hopSample: 1, hopEliminated: 0 });
  });

  it('refuses a stored record with no row', () => {
    expect(() => versionColumns({ ...stored, robo: [recordFor(rowFor(PLAIN, W4))] }, rows, DEFAULT_SETTINGS)).toThrow(STALE_ROWS);
  });
});

describe('judgedActions', () => {
  const line = (source: JudgedReply['source'], address: string, facts: Facts = PLAIN): JudgedReply => {
    const row = rowFor(facts, address);
    return { key: address, source, record: recordFor(row), row };
  };

  it("keys each version's action by the entry's set, and scores each reply on its own row", () => {
    const judged = [line('robo', W1), line('hop-sample', W1, OWN_LINK), line('hop-eliminated', W2)];
    expect(judgedActions(judged, DEFAULT_SETTINGS, 1)).toEqual(new Map([[judgedKey('robo', W1), 'hold'], [judgedKey('hop', W1), 'hold'], [judgedKey('hop', W2), 'hold']]));
    expect(judgedActions(judged, DEFAULT_SETTINGS, 2)).toEqual(new Map([[judgedKey('robo', W1), 'full'], [judgedKey('hop', W1), 'hold'], [judgedKey('hop', W2), 'full']]));
  });

  it('refuses two lines for one wallet in one set, and a line whose key is not its record', () => {
    expect(() => judgedActions([line('hop-sample', W1), line('hop-eliminated', W1)], DEFAULT_SETTINGS, 2)).toThrow(RangeError);
    expect(() => judgedActions([{ ...line('robo', W1), key: W2 }], DEFAULT_SETTINGS, 2)).toThrow(RangeError);
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

const judgedOf = (...lines: [FeedbackEntry['set'], string, Outcome][]) => new Map(lines.map(([set, address, action]) => [judgedKey(set, address), action]));

const FAMILY: FarmKeyEntry = { collector: wallet('c1'), family: 1, fundingWallet: null };

describe('scoreVersion', () => {
  const ROWS = [rowFor(PLAIN, W1), rowFor(PLAIN, W2), rowFor(PLAIN, W3)];
  const KEY = new Map([
    [W1, FAMILY],
    [W2, FAMILY],
  ]);
  const NO_FEEDBACK = { entries: [], appeals: [], hopEliminated: [], judged: new Map<string, Outcome>() };
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

  it('marks a blocked entry right only when the action on the judged reply moved, and ignores other routes', () => {
    const entries = [entry(W1), entry(W2), entry(W3, { verdict: { ...passed, route: 'review' } }), entry(W3, { verdict: passed }), entry(W3, { verdict: null })];
    const result = score([], [], { ...NO_FEEDBACK, entries, judged: judgedOf(['robo', W1, 'hold'], ['robo', W2, 'full']) });
    expect(result.feedback).toEqual({ right: 1, total: 2 });
  });

  it('marks a blocked entry from the judged reply, never from a later answer for the same wallet', () => {
    const entries = [entry(W1)];
    const result = score([held(W1, 'full')], [], { ...NO_FEEDBACK, entries, judged: judgedOf(['robo', W1, 'hold']) });
    expect(result.feedback).toEqual({ right: 0, total: 1 });
  });

  it("reads a wallet in both sets from the entry's own set", () => {
    const entries = [entry(W1, { set: 'hop' })];
    expect(score([], [], { ...NO_FEEDBACK, entries, judged: judgedOf(['robo', W1, 'hold'], ['hop', W1, 'full']) }).feedback).toEqual({ right: 1, total: 1 });
    expect(score([], [], { ...NO_FEEDBACK, entries, judged: judgedOf(['robo', W1, 'full'], ['hop', W1, 'hold']) }).feedback).toEqual({ right: 0, total: 1 });
  });

  it('reads a blocked Hop entry from the judged replies without touching the false-hold rate', () => {
    const entries = [entry(W4, { set: 'hop' })];
    const result = score([], [], { ...NO_FEEDBACK, entries, judged: judgedOf(['hop', W4, 'full']) });
    expect(result.feedback).toEqual({ right: 1, total: 1 });
    expect(result.falseHold.wallets).toBe(0);
  });

  it('never marks a blocked entry right when there is no judged reply for it', () => {
    expect(score([held(W1, 'full')], [], { ...NO_FEEDBACK, entries: [entry(W1)] }).feedback).toEqual({ right: 0, total: 1 });
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
  const JUDGED = {
    v1: judgedOf(['robo', W2, 'hold'], ['hop', W5, 'hold']),
    v2: judgedOf(['robo', W2, 'full'], ['hop', W5, 'full']),
  };
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
  const comparison = compareVersions(V1, V2, {
    roboRows: ROWS,
    key: KEY,
    entries: ENTRIES,
    appeals: APPEALS,
    listed: [W1, W2, W3, W4, W5],
    judged: JUDGED,
    noReply: { robo: 3, hopSample: 0, hopEliminated: 1 },
  });
  const report = versionsToMarkdown(comparison, { runDate: '2026-11-11', hopAskedOn: '2026-11-11' });

  it('scores both versions over the same rows, and the feedback set on the judged replies', () => {
    expect(comparison.v1).toMatchObject({ name: 'v1', feedback: { right: 0, total: 2 }, falseHold: { held: 1, wallets: 2 } });
    expect(comparison.v2).toMatchObject({ name: 'v2', feedback: { right: 2, total: 2 }, falseHold: { held: 0, wallets: 2 } });
    expect(comparison.eliminatedHeld).toEqual({ v1: { held: 1, wallets: 1, rate: 1 }, v2: { held: 0, wallets: 1, rate: 0 } });
    expect(comparison.routes).toEqual({ ship: 1, review: 1, block: 2, unread: 1 });
    expect(comparison.noReply).toEqual({ robo: 3, hopSample: 0, hopEliminated: 1 });
  });

  it('keeps a test wallet out of the feedback number and counts it on its own line', () => {
    expect(comparison.testWalletAppeals).toBe(1);
    expect(comparison.v2.feedback.total).toBe(2);
    expect(report).toContain('Appeals by a test wallet, left out of the feedback number because no real claimant wrote them: 1');
    expect(report).toContain('- thuli-appeal-proof: reversed, hold to full, test wallet');
    expect(report).toContain('- robo-claims: open, hold\n');
  });

  it('says both columns check the same stored replies, and counts the records with none to check', () => {
    expect(report).toContain('Both columns come from the same stored model replies. No model was called and nothing was sent.');
    expect(report).toContain('v1 applies the checks without the rule rulebook v2 added (a shared funder alone cannot hold a wallet).');
    expect(report).toContain('The feedback line is scored on the replies Reppo judged.');
    expect(report).toContain('Records with no model reply to check again, kept as stored in both columns: ROBO 3, Hop sample 0, Hop eliminated 1.');
  });

  it('prints the four measures side by side, with the eliminated sample labelled as a cost', () => {
    expect(report).toContain('| Measure | v1 | v2 |');
    expect(report).toContain('| ROBO catch rate: Bitquery key wallets held or excluded | 100.0% (1 of 1) | 100.0% (1 of 1) |');
    expect(report).toContain('| Hop false-hold rate: probably-real sample held or excluded | 50.00% (1 of 2), 95% interval');
    expect(report).toContain('| Feedback set right | 0 of 2 | 2 of 2 |');
    expect(report).toContain("| Hop's eliminated A8/A9 sample held: not a recall claim, the cost of the change | 100.00% (1 of 1) | 0.00% (0 of 1) |");
  });

  it('gives one line per verdict in the feedback set, with what each version does with the judged reply', () => {
    expect(report).toContain('- contract-hold: stored hold, score 40, route block, confidence high, v1 now hold, v2 now full');
    expect(report).toContain('- eliminated-hold: stored hold, score 43, route block, confidence medium, v1 now hold, v2 now full');
    expect(report).not.toContain('- known-farm-hold');
  });

  it('counts every verdict by route and closes by naming what it does not cover, including the new asks', () => {
    expect(report).toContain('Ship: 1\nReview: 1\nBlock: 2\nPaid but out of shape: 1');
    expect(report.indexOf('## Not covered')).toBeGreaterThan(report.indexOf('## Appeals'));
    expect(report).toContain('both columns check that one reply');
    expect(report).toContain('No verdict here is on a v2 decision');
    expect(report).toContain('- A record with no model reply to check again keeps its stored hold in both columns.');
    expect(report).toContain('- The Hop answers were asked again on 2026-11-11 for wallets whose facts changed after the 10 Nov fixes');
  });

  it('names no wallet in the report or the stored summary, and has no long dashes', () => {
    for (const text of [report, JSON.stringify(comparison)]) {
      expect(text).not.toMatch(/0x/i);
      expect(text).not.toContain(LONG_DASH);
    }
  });
});

describe('rulebook 1 is reachable only from the scorecard', () => {
  const holdOnFunder = JSON.stringify({ verdict: 'likely_farm', action: 'hold', rule: 'B1', reason: 'Looks like a farm.', cited_tx_hashes: [] });
  const reply: ServReply = { requestId: 'run-1', rawText: holdOnFunder, answer: holdOnFunder, answerProblem: null, usage: null };
  const serv: DecideDeps = { viaGraph: async () => reply, viaV2: async () => reply, sleep: async () => undefined };

  it('has no setting that could choose a rulebook', () => {
    expect(Object.keys(Settings.shape)).not.toContain('rulebook');
    expect(Settings.safeParse({ ...DEFAULT_SETTINGS, rulebook: 1 }).success).toBe(false);
  });

  it("screens with CURRENT_RULEBOOK in the paid API's single-wallet screening and in the replay", async () => {
    expect(CURRENT_RULEBOOK).toBe(2);
    const screen = await screenOneWallet(W1, { facts: async () => PLAIN, decide: serv, settings: DEFAULT_SETTINGS });
    expect(screen.rulebook).toBe(`v${CURRENT_RULEBOOK}`);
    expect(screen.decision).toMatchObject({ modelAction: 'hold', action: 'full', accepted: false, cause: FUNDER_KEPT_CAUSE });
    expect(await decideWallet(rowFor(PLAIN), DEFAULT_SETTINGS, serv, 'auto')).toMatchObject({ modelAction: 'hold', action: 'full', cause: FUNDER_KEPT_CAUSE });
  });
});

const dataFile = (name: string) => fileURLToPath(new URL(`../../../data/${name}`, import.meta.url));
const STORED_RUNS = ['replay/robo/decisions.jsonl', 'replay/hop/decisions-sample.jsonl', 'replay/hop/decisions-eliminated.jsonl'] as const;
const hasStoredRuns = STORED_RUNS.every((name) => fs.existsSync(dataFile(name)));
const JUDGED_FILE = 'feedback/judged.jsonl';
const hasJudged = fs.existsSync(dataFile(JUDGED_FILE)) && fs.existsSync(dataFile('feedback/reppo.jsonl'));

function storedLines<T>(name: string): T[] {
  return fs.readFileSync(dataFile(name), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as T);
}

/**
 * Checks one stored record under both versions against the C47 standard and says how they compare: the same, or v2
 * ending a held reply on the code's start where v1 kept the hold, or both ending on the start in their own words.
 */
function compareOnRealData(record: DecisionRecord, row: ReplayRow): 'same' | 'moved' | 'reworded' | 'noReply' {
  const [v1, v2] = versionsOf(record, row);
  for (const version of [v1, v2]) expect(version.shareBps).toBeLessThanOrEqual(shareFor(record.ceiling, DEFAULT_SETTINGS));
  if (!hasReplyToRecheck(record)) {
    expect(v1).toBe(record);
    expect(v2).toBe(record);
    expect(record.action).toBe('hold');
    return 'noReply';
  }
  if (JSON.stringify(v1) === JSON.stringify(v2)) return 'same';
  expect(v2).toMatchObject({ action: record.start.outcome, rule: record.start.rule, accepted: false, cause: FUNDER_KEPT_CAUSE, citedTxs: [] });
  expect(row.facts.sharedDepositAddress).toBeNull();
  expect(row.facts.group?.linkedByWallet).not.toBe(true);
  if (v1.cause === EXCHANGE_KEPT_CAUSE) {
    expect(v1).toMatchObject({ action: v2.action, shareBps: v2.shareBps, rule: v2.rule, clampedFrom: v2.clampedFrom, accepted: false });
    return 'reworded';
  }
  // v1 holds: an accepted hold, or an exclude on a reward start that the fixed-rule check refuses into a hold.
  expect(v1.action).toBe('hold');
  expect(['hold', 'exclude']).toContain(v2.clampedFrom);
  expect(v2.clampedFrom).toBe(v1.modelAction);
  return 'moved';
}

describe.runIf(hasStoredRuns)('asRulebook on the real stored runs', () => {
  it.each(STORED_RUNS)(
    'in %s, v2 differs from v1 only where a hold on a shared funder alone became the start, and no-reply records hold in both',
    (name) => {
      const set = name.split('/')[1] as string;
      const rows = new Map(storedLines<ReplayRow>(`replay/${set}/rows.jsonl`).map((row) => [row.wallet, row]));
      const records = storedLines<{ value: DecisionRecord }>(name).map((line) => line.value);
      const counts = { same: 0, moved: 0, reworded: 0, noReply: 0 };
      for (const record of records) counts[compareOnRealData(record, rows.get(record.wallet) as ReplayRow)] += 1;
      expect(counts.same + counts.moved + counts.reworded + counts.noReply).toBe(records.length);
      expect(counts.moved).toBeGreaterThan(0);
    },
    120_000,
  );

  it('holds at least one real burst replacement, so the replacement path is not empty', () => {
    const records = storedLines<{ value: DecisionRecord }>('replay/robo/decisions.jsonl').map((line) => line.value);
    expect(records.filter((record) => record.cause === BURST_KEPT_CAUSE && record.modelAction !== null).length).toBeGreaterThan(0);
  }, 60_000);
});

describe.runIf(hasJudged)('the replies Reppo judged', () => {
  it('has one for every Reppo entry, and scores each on its own row under the same C47 standard', () => {
    const judged = storedLines<JudgedReply>(JUDGED_FILE);
    const entries = storedLines<{ value: FeedbackEntry }>('feedback/reppo.jsonl').map((line) => line.value);
    const keys = new Set(judged.map((line) => judgedKey(line.source === 'robo' ? 'robo' : 'hop', line.key)));
    expect(entries.every((one) => keys.has(judgedKey(one.set, one.wallet)))).toBe(true);
    for (const line of judged) {
      expect(line.record.action).toBe(entries.find((one) => one.wallet === line.key)?.action);
      compareOnRealData(line.record, line.row);
    }
    expect(judgedActions(judged, DEFAULT_SETTINGS, 1).size).toBe(judged.length);
  });
});

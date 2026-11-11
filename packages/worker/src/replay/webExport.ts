import { parseUnits } from 'viem';
import { z } from 'zod';
import {
  ACCOUNT_TYPES,
  AppealRecord,
  BURST_KEPT_CAUSE,
  DECISION_RULES,
  FACT_NAMES,
  FUNDER_KEPT_CAUSE,
  FUNDER_KINDS,
  isPlainText,
  leastGenerous,
  OUTCOMES,
  OutcomeSchema,
  parseAddress,
  ReppoVerdict,
  RULEBOOK_VERSIONS,
  Start,
  TxHash,
  type FarmKeyEntry,
  type Outcome,
  type ReplayRow,
  type RulebookVersion,
} from '@thuli/core';
import type { ClaimEvent } from './answerKeys.ts';
import type { DecisionRecord } from './decide.ts';
import { scoreDecisions, USD_PER_ROBO_AT_CLAIM, wholeDollars, type DecisionScore } from './decisionScore.ts';
import type { HopCohort, HopScore } from './hopScore.ts';

export const OUTCOME_CODES = { full: 0, partial: 1, hold: 2, exclude: 3 } as const;

/** The ROBO claim contract on Ethereum. Source and on-chain proof: reference/answer-keys/counts.md. */
export const ROBO_CLAIM_CONTRACT = '0xb8a4deb1c30404555ffeaf30e65b24339abbc2d8';

const ROBO_DECIMALS = 18;
const WEI_PER_ROBO = 10n ** 18n;
const BPS_PER_WHOLE = 10_000n;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const LEADING_RULE_CODE = /^(?:A[1-9]|B[12]): */;
const LONG_DASH = '\u2014';
const SPACED_LONG_DASH = / *\u2014 */g;
// Two hex characters after 0x name the file, so the site fetches one small file per wallet it opens.
const SHARD_NAMES = Array.from({ length: 256 }, (_, n) => n.toString(16).padStart(2, '0'));

const PublicAddress = z.string().regex(/^0x[0-9a-f]{40}$/);
const Count = z.int().min(0);
const OutcomeCode = z.int().min(0).max(3);
const Fraction = z.number().min(0).max(1);
const CalendarDay = z.string().refine(isCalendarDate);
// Shorter than any address or transaction hash, so a cut-down one is caught as well as a whole one (C33, C34).
const ADDRESS_LIKE = /0x[0-9a-f]{8,}/i;

const HopCohortShape = z.strictObject({
  screened: Count,
  noHistory: Count,
  counted: Count,
  held: Count,
  heldLow: Fraction,
  heldHigh: Fraction,
  excluded: Count,
  partial: Count,
  full: Count,
});

const WebHopShape = z.strictObject({
  schema: z.literal(1),
  runDate: CalendarDay,
  probablyReal: HopCohortShape,
  eliminated: HopCohortShape,
  clusters: z.strictObject({ total: Count, touched: Count, fullyHeld: Count, uncounted: Count }),
});

// Feedback group names and campaign ids are labels: letters, digits, dots, dashes or underscores, never free text.
const Label = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const HeldShareShape = z.strictObject({ held: Count, wallets: Count, rate: Fraction });
const versionScoreShape = (name: 'v1' | 'v2') =>
  z.strictObject({
    name: z.literal(name),
    catchRate: HeldShareShape,
    falseHold: z.strictObject({ held: Count, wallets: Count, rate: Fraction, low: Fraction, high: Fraction }),
    feedback: z.strictObject({ right: Count, total: Count }),
  });

// Every field versions-score writes to data/feedback/versions.json, the day it scored included.
const WebVersionsShape = z.strictObject({
  runDate: CalendarDay,
  v1: versionScoreShape('v1'),
  v2: versionScoreShape('v2'),
  eliminatedHeld: z.strictObject({ v1: HeldShareShape, v2: HeldShareShape }),
  verdicts: z.array(
    z.strictObject({
      group: Label,
      storedAction: OutcomeSchema,
      score: ReppoVerdict.shape.score.nullable(),
      route: ReppoVerdict.shape.route.nullable(),
      confidence: ReppoVerdict.shape.confidence.nullable(),
      v1Action: OutcomeSchema.nullable(),
      v2Action: OutcomeSchema.nullable(),
    }),
  ),
  routes: z.strictObject({ ship: Count, review: Count, block: Count, unread: Count }),
  appeals: z.array(
    z.strictObject({
      campaignId: Label,
      status: AppealRecord.shape.status,
      appealedAction: OutcomeSchema,
      newAction: OutcomeSchema.nullable(),
      testWallet: z.boolean(),
    }),
  ),
  testWalletAppeals: Count,
  noReply: z.strictObject({ robo: Count, hopSample: Count, hopEliminated: Count }),
});

/** versions.json: the rulebook v1 and v2 scorecard as the version scorer stored it, with the day it was scored. */
export type WebVersions = z.infer<typeof WebVersionsShape>;

// Strict, so any field nobody listed here, the model's raw reply above all, stops the export instead of going public.
const WalletDetailShape = z.strictObject({
  i: Count,
  outcome: OutcomeCode,
  shareBps: z.int().min(0).max(10_000),
  rule: z.enum(DECISION_RULES),
  reason: z.string(),
  txs: z.array(TxHash),
  robo: Count,
  group: z.int().min(-1),
  start: Start,
  facts: z.strictObject({
    ageDays: Count.nullable(),
    txCount: Count.nullable(),
    accountType: z.enum(ACCOUNT_TYPES),
    funder: z.strictObject({ address: PublicAddress, kind: z.enum(FUNDER_KINDS), fanout: Count.nullable(), hops: Count }).nullable(),
    burstWallets: Count.nullable(),
    sameFunderWithinWindow: Count.nullable(),
    sweptToSharedCollector: z.boolean().nullable(),
    missing: z.array(z.enum(FACT_NAMES)),
  }),
  serv: z.strictObject({ mode: z.enum(['v3', 'v2']), requestId: z.string().nullable(), accepted: z.boolean(), secondAsk: z.boolean() }),
});

const GroupFileShape = z.strictObject({
  schema: z.literal(1),
  index: Count,
  size: Count,
  held: Count,
  robo: Count,
  members: z.array(
    z.strictObject({ address: PublicAddress, outcome: OutcomeCode, rule: z.enum(DECISION_RULES), robo: Count, reason: z.string(), txs: z.array(TxHash) }),
  ),
});

interface ExportInput {
  rows: ReplayRow[];
  records: Map<string, DecisionRecord>;
  claims: ClaimEvent[];
  farmKey: Map<string, FarmKeyEntry>;
  groupLabels: Map<string, string>;
  meta: ExportMeta;
}

interface ExportMeta {
  runDate: string;
  spentCents: number;
  rowsSha256: string;
  decisionsSha256: string;
  /** The rulebook every record was checked under before it reached the export. */
  rulebook: RulebookVersion;
}

/** One entry per claim wallet, index i in every list is the same wallet, in replay row order. */
export interface WebPoints {
  schema: 1;
  /** Number of wallets, the length of every list below. */
  count: number;
  /** OUTCOME_CODES of the final action under summary.run.rulebook. */
  outcome: number[];
  /** Index into WebSummary.groups, or -1 when the wallet is linked to no other claim wallet. */
  group: number[];
  /** Whole ROBO the wallet claimed, summed over its claim events and rounded down. */
  robo: number[];
  /** 1 when the wallet was first funded in a burst, else 0. */
  burst: number[];
}

/** One linked group: its wallets, how many of them ended hold or exclude, and the whole ROBO they claimed together. */
export interface WebGroup {
  size: number;
  held: number;
  robo: number;
}

export interface WebSummary {
  schema: 1;
  drop: { name: 'ROBO'; chain: 'ethereum'; claimContract: string; usdPerRobo: number };
  /** rulebook is the version whose checks decided every outcome here. */
  run: { date: string; rulebook: number; rowsSha256: string; decisionsSha256: string; spentCents: number; centsPerWallet: number };
  wallets: number;
  /** Claim events of the wallets above; one wallet can claim more than once. */
  claims: number;
  outcomes: { key: Record<Outcome, number>; other: Record<Outcome, number> };
  farmKey: { wallets: number; held: number; families: { total: number; touched: number; fullyHeld: number }; shareOfDropBps: number };
  /** Decimal ROBO text exactly as the scorecard holds it. */
  robo: { claimedKey: string; keptKey: string; claimedOther: string; keptOther: string };
  /** Whole dollars at the claim-day value, the figures decisions-report.md prints. */
  usd: { claimedKey: number; keptKey: number; claimedOther: number; keptOther: number };
  /**
   * How the stored answers fare under today's checks. firstRefused is always fixedBySecondAsk + stillRefused +
   * replacedByCode: the export refuses to write otherwise. Every wallet in stillRefused or refusedOnRecheck is a hold.
   */
  answers: {
    /** Answers the checks accept, first or second. */
    accepted: number;
    /** First answers the checks refused, each of which was asked a second time. */
    firstRefused: number;
    /** Of those, second answers the checks accept. */
    fixedBySecondAsk: number;
    /** Of those, second answers the checks refuse too, or the first refusal kept when the second call failed. */
    stillRefused: number;
    /** Of those, second answers the code replaced with its own start, on a funding burst or a shared funder alone. */
    replacedByCode: number;
    /** Answers never asked a second time, because the checks accepted them or the code replaced them when they were
     * asked, that today's checks refuse. */
    refusedOnRecheck: number;
  };
  modes: { v3: number; v2: number };
  /** Largest first; groups of one size in the order their first wallet appears. */
  groups: WebGroup[];
}

/** What the replay page shows for one claim wallet. Every value is stored and already checked, or counted by code. */
export interface WalletDetail {
  /** Index of this wallet in points.json. */
  i: number;
  /** OUTCOME_CODES of the final action under summary.run.rulebook. */
  outcome: 0 | 1 | 2 | 3;
  shareBps: number;
  /** The final rule, A1 to A9, B1 or B2. */
  rule: string;
  /** The final reason as cleanReason shows it: the model's checked words, or the code's own when it replaced them. */
  reason: string;
  /** The stored citedTxs. */
  txs: string[];
  /** Whole ROBO claimed, the same value as points.robo[i]. */
  robo: number;
  /** The same value as points.group[i]. */
  group: number;
  /** What the code said before SERV answered. */
  start: { outcome: string; rule: string };
  facts: {
    ageDays: number | null;
    txCount: number | null;
    accountType: string;
    /** From facts.firstFunder. */
    funder: { address: string; kind: string; fanout: number | null; hops: number } | null;
    /** facts.fundingBurst.wallets */
    burstWallets: number | null;
    /** facts.group.sameFunderWithinWindow */
    sameFunderWithinWindow: number | null;
    /** facts.group.sweptToSharedCollector */
    sweptToSharedCollector: boolean | null;
    /** facts.missing */
    missing: string[];
  };
  serv: { mode: 'v3' | 'v2'; requestId: string | null; accepted: boolean; secondAsk: boolean };
}

/** One of the 256 wallet files, keyed by lowercase address. */
export interface WalletShard {
  schema: 1;
  wallets: Record<string, WalletDetail>;
}

/** One linked group and every claim wallet in it, held or not, in claim-list order. */
export interface GroupFile {
  schema: 1;
  /** index, size, held and robo are the same numbers as summary.groups[index]. */
  index: number;
  size: number;
  held: number;
  robo: number;
  members: Array<{ address: string; outcome: 0 | 1 | 2 | 3; rule: string; robo: number; reason: string; txs: string[] }>;
}

/** How the code's starts fell on one part of Hop's list. held counts hold and exclude, and excluded is part of it. */
export interface WebHopCohort {
  screened: number;
  noHistory: number;
  counted: number;
  held: number;
  /** The 95% Wilson interval of held / counted, as fractions. */
  heldLow: number;
  heldHigh: number;
  excluded: number;
  partial: number;
  full: number;
}

/** The Hop control numbers: aggregates only, no wallet and nothing from the answer keys but counts. */
export interface WebHop {
  schema: 1;
  runDate: string;
  probablyReal: WebHopCohort;
  eliminated: WebHopCohort;
  /** uncounted are clusters with no counted wallet, so neither touched nor fully held. */
  clusters: { total: number; touched: number; fullyHeld: number; uncounted: number };
}

/** Outcome counts over every row, before and after the current rulebook checked the stored replies again. */
export interface RulebookMoves {
  /** Stored holds and excludes put back at the row's start because a shared funder was the only evidence (C47). */
  toStart: number;
  /** Stored outcomes that became a hold because today's output checks refuse the stored reply (C11, C13). */
  heldByChecks: number;
  stored: Record<Outcome, number>;
  exported: Record<Outcome, number>;
}

/** A check the export refused on. Messages name a row number, never a wallet. */
export class ExportCheckError extends Error {
  override name = 'ExportCheckError';
}

interface GroupTally {
  firstRow: number;
  size: number;
  held: number;
  wei: bigint;
}

// Both sides of every wallet comparison go through this one function (C.2 standard 2).
function lower(value: string): string {
  return value.toLowerCase();
}

// The scorecard's meaning of held. buildWebExport checks its total against scoreDecisions, so the two cannot drift.
function isHeld(outcome: Outcome): boolean {
  return outcome === 'hold' || outcome === 'exclude';
}

function wholeRobo(wei: bigint): number {
  return Number(wei / WEI_PER_ROBO);
}

function byLowerWallet<T>(entries: Map<string, T>, what: string): Map<string, T> {
  const out = new Map<string, T>();
  for (const [wallet, value] of entries) {
    if (out.has(lower(wallet))) throw new ExportCheckError(`two ${what} entries name the same wallet`);
    out.set(lower(wallet), value);
  }
  return out;
}

/** True for a real calendar day written YYYY-MM-DD. The export script reads --run-date with this same check. */
export function isCalendarDate(text: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text)) return false;
  const time = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === text;
}

// The code's own start standing in for a reply. scoreDecisions does not count it as a refusal either.
function isReplacedByCode(record: DecisionRecord): boolean {
  return record.cause === BURST_KEPT_CAUSE || record.cause === FUNDER_KEPT_CAUSE;
}

function isRefused(record: DecisionRecord): boolean {
  return record.cause !== null && !isReplacedByCode(record);
}

/**
 * summary.answers for the rows' records, split so the counts add up: every first answer the checks refused was asked
 * once more, then fixed, still refused, or replaced by the code. Refusals of answers never asked again are their own count.
 *
 * @throws ExportCheckError when firstRefused is not fixedBySecondAsk + stillRefused + replacedByCode.
 */
function answerCounts(records: DecisionRecord[], score: DecisionScore): WebSummary['answers'] {
  const askedAgain = records.filter((record) => record.secondAsk);
  const answers = {
    accepted: score.accepted,
    firstRefused: score.secondAsks.asked,
    fixedBySecondAsk: score.secondAsks.fixed,
    stillRefused: askedAgain.filter(isRefused).length,
    replacedByCode: askedAgain.filter(isReplacedByCode).length,
    refusedOnRecheck: records.filter((record) => !record.secondAsk && isRefused(record)).length,
  };
  const { firstRefused, fixedBySecondAsk, stillRefused, replacedByCode } = answers;
  if (firstRefused !== fixedBySecondAsk + stillRefused + replacedByCode) {
    throw new ExportCheckError(
      `the answer counts do not add up: ${firstRefused} first answers refused, but ${fixedBySecondAsk} fixed, ${stillRefused} still refused and ${replacedByCode} replaced by the code`,
    );
  }
  return answers;
}

function checkMeta(meta: ExportMeta): void {
  if (!isCalendarDate(meta.runDate)) throw new ExportCheckError('the run date is not a calendar day written YYYY-MM-DD');
  if (!(RULEBOOK_VERSIONS as readonly unknown[]).includes(meta.rulebook)) throw new ExportCheckError('the rulebook is not a version the checks know');
  if (!Number.isSafeInteger(meta.spentCents) || meta.spentCents < 0) throw new ExportCheckError('the spend is not a whole number of cents');
  if (!SHA256_HEX.test(meta.rowsSha256) || !SHA256_HEX.test(meta.decisionsSha256)) {
    throw new ExportCheckError('a file hash is not 64 lowercase hex characters');
  }
}

/**
 * Builds the two files the web app draws the ROBO replay from. summary.json holds every headline count and money
 * figure; points.json holds one entry per claim wallet in row order, with no address in it. Counts and money come from
 * scoreDecisions and the scorecard's dollar arithmetic, so the site and decisions-report.md cannot disagree. A wallet's
 * group is the label groupLabels gives it, numbered by its group's place in summary.groups (largest first, then the
 * group whose first wallet comes earliest). Only claim events of wallets in the rows count. Pure: no network, no
 * clock, no files.
 *
 * @throws ExportCheckError when there are no rows, meta is malformed, a row has no stored decision or its record names
 * another wallet, a label names a wallet outside the rows, a wallet's label and its facts.group disagree (one without
 * the other, or a label shared by a different number of wallets than facts.group.size), or the answer counts do not add
 * up (answerCounts).
 * @throws Error STALE_DECISION, and RangeError for a wallet listed twice, both from scoreDecisions.
 */
export function buildWebExport(input: ExportInput): { summary: WebSummary; points: WebPoints } {
  const { rows, meta } = input;
  checkMeta(meta);
  if (rows.length === 0) throw new ExportCheckError('there are no replay rows to export');
  const records = byLowerWallet(input.records, 'decision');
  const labels = byLowerWallet(input.groupLabels, 'group label');
  const wallets = rows.map((row) => lower(row.wallet));
  const inRows = new Set(wallets);

  let claims = 0;
  const claimedWei = new Map<string, bigint>();
  for (const event of input.claims) {
    const wallet = lower(event.recipient);
    if (!inRows.has(wallet)) continue;
    claims += 1;
    claimedWei.set(wallet, (claimedWei.get(wallet) ?? 0n) + event.amountWei);
  }

  const stored = wallets.map((wallet, index) => {
    const record = records.get(wallet);
    if (record === undefined) throw new ExportCheckError(`row ${index + 1} has no stored decision, and the site says every wallet was decided`);
    return record;
  });
  const score = scoreDecisions(stored, rows, input.farmKey, claimedWei);
  // A record filed under one wallet but naming another leaves its row undecided in the score.
  if (score.decided !== rows.length) {
    throw new ExportCheckError(`${rows.length - score.decided} stored decisions name a wallet other than their row's`);
  }

  for (const wallet of labels.keys()) {
    if (!inRows.has(wallet)) throw new ExportCheckError('a group label names a wallet outside the replay rows');
  }
  const members = new Map<string, number>();
  for (const label of labels.values()) members.set(label, (members.get(label) ?? 0) + 1);

  const tallies = new Map<string, GroupTally>();
  const outcome: number[] = [];
  const robo: number[] = [];
  const burst: number[] = [];
  let heldWallets = 0;
  rows.forEach((row, index) => {
    const wallet = wallets[index] as string;
    const { action } = stored[index] as DecisionRecord;
    const label = labels.get(wallet);
    const { group } = row.facts;
    if ((label === undefined) !== (group === null)) {
      throw new ExportCheckError(`row ${index + 1}: its group label and its facts.group disagree on whether it is in a group`);
    }
    const wei = claimedWei.get(wallet) ?? 0n;
    if (isHeld(action)) heldWallets += 1;
    if (label !== undefined && group !== null) {
      const sharing = members.get(label) ?? 0;
      if (sharing !== group.size) {
        throw new ExportCheckError(`row ${index + 1}: ${sharing} wallets share its group label, but its facts.group.size is ${group.size}`);
      }
      const tally = tallies.get(label) ?? { firstRow: index, size: group.size, held: 0, wei: 0n };
      if (isHeld(action)) tally.held += 1;
      tally.wei += wei;
      tallies.set(label, tally);
    }
    outcome.push(OUTCOME_CODES[action]);
    robo.push(wholeRobo(wei));
    burst.push(row.facts.fundingBurst === null ? 0 : 1);
  });
  if (heldWallets !== score.finalHeld.key + score.finalHeld.other) {
    throw new ExportCheckError('the wallets counted as held here differ from the scorecard');
  }

  const sorted = [...tallies].sort(([, a], [, b]) => b.size - a.size || a.firstRow - b.firstRow);
  const groupIndex = new Map(sorted.map(([label], index) => [label, index]));
  const group = wallets.map((wallet) => {
    const label = labels.get(wallet);
    return label === undefined ? -1 : (groupIndex.get(label) as number);
  });

  const claimedKeyWei = parseUnits(score.robo.allKey, ROBO_DECIMALS);
  const dropWei = claimedKeyWei + parseUnits(score.robo.allOther, ROBO_DECIMALS);
  const summary: WebSummary = {
    schema: 1,
    drop: { name: 'ROBO', chain: 'ethereum', claimContract: ROBO_CLAIM_CONTRACT, usdPerRobo: USD_PER_ROBO_AT_CLAIM },
    run: {
      date: meta.runDate,
      rulebook: meta.rulebook,
      rowsSha256: meta.rowsSha256,
      decisionsSha256: meta.decisionsSha256,
      spentCents: meta.spentCents,
      // Every wallet is decided by now, so this is the scorecard's per-wallet spend, rounded the way it prints it.
      centsPerWallet: Number((meta.spentCents / rows.length).toFixed(3)),
    },
    wallets: score.wallets,
    claims,
    outcomes: { key: { ...score.final.key }, other: { ...score.final.other } },
    farmKey: {
      wallets: OUTCOMES.reduce((sum, name) => sum + score.final.key[name], 0),
      held: score.finalHeld.key,
      families: { total: score.families.total, touched: score.families.touched, fullyHeld: score.families.fullyHeld },
      shareOfDropBps: dropWei === 0n ? 0 : Number((claimedKeyWei * BPS_PER_WHOLE) / dropWei),
    },
    robo: { claimedKey: score.robo.allKey, keptKey: score.robo.keptKey, claimedOther: score.robo.allOther, keptOther: score.robo.keptOther },
    usd: {
      claimedKey: wholeDollars(score.robo.allKey),
      keptKey: wholeDollars(score.robo.keptKey),
      claimedOther: wholeDollars(score.robo.allOther),
      keptOther: wholeDollars(score.robo.keptOther),
    },
    answers: answerCounts(stored, score),
    modes: { v3: score.modes.v3, v2: score.modes.v2 },
    groups: sorted.map(([, tally]) => ({ size: tally.size, held: tally.held, robo: wholeRobo(tally.wei) })),
  };
  return { summary, points: { schema: 1, count: rows.length, outcome, group, robo, burst } };
}

/**
 * The text the replay page shows for a stored reason. The page shows the rule on its own, so one leading rule code (A1:
 * to A9:, B1: or B2:) and the spaces after it are dropped, and every long dash, with any spaces around it, becomes a
 * comma and one space. Nothing else changes: the words stay the ones validateDecision already checked (C13).
 */
export function cleanReason(stored: string): string {
  return stored.replace(LEADING_RULE_CODE, '').replace(SPACED_LONG_DASH, ', ').trim();
}

// The one parser, then lowercase: the form every shard name, key and member list uses, so two spellings of one wallet
// can never become two entries (C1).
function publicAddress(value: string, where: string): string {
  try {
    return lower(parseAddress(value));
  } catch {
    throw new ExportCheckError(`${where} is not a valid address`);
  }
}

function shardName(address: string): string {
  return address.slice(2, 4);
}

// The page renders this text inert, but a link, markup or hidden character must never reach it at all (C13, C33).
// isPlainText is the rule the decision checks and appeals share, so there is no second rule to drift from it.
function checkShownText(text: string, where: string): void {
  if (!isPlainText(text)) throw new ExportCheckError(`${where} is not plain text`);
  if (text.includes(LONG_DASH)) throw new ExportCheckError(`${where} still holds a long dash`);
}

/** Refuses wallet and group files that are not exactly the rows, in the public shape, agreeing with points and summary. */
function checkWalletFiles(
  wallets: string[],
  points: WebPoints,
  summary: WebSummary,
  files: { shards: Map<string, WalletShard>; groups: GroupFile[] },
): void {
  const { shards, groups } = files;
  if (shards.size !== SHARD_NAMES.length) throw new ExportCheckError(`there are ${shards.size} wallet shards, not ${SHARD_NAMES.length}`);
  const placed = new Set<number>();
  for (const [name, shard] of shards) {
    for (const [address, detail] of Object.entries(shard.wallets)) {
      if (!WalletDetailShape.safeParse(detail).success) throw new ExportCheckError(`shard ${name}: an entry does not match the public wallet shape`);
      const row = `row ${detail.i + 1}`;
      if (wallets[detail.i] !== address || shardName(address) !== name || placed.has(detail.i)) {
        throw new ExportCheckError(`${row}: its wallet is not in exactly one shard, the one its address names`);
      }
      placed.add(detail.i);
      checkShownText(detail.reason, `${row}: its reason`);
      if (detail.serv.requestId !== null) checkShownText(detail.serv.requestId, `${row}: its request id`);
      if (detail.outcome !== points.outcome[detail.i] || detail.robo !== points.robo[detail.i] || detail.group !== points.group[detail.i]) {
        throw new ExportCheckError(`${row}: its wallet file and points.json disagree`);
      }
    }
  }
  if (placed.size !== points.count) throw new ExportCheckError(`the shards hold ${placed.size} wallets, but points.json holds ${points.count}`);

  if (groups.length !== summary.groups.length) throw new ExportCheckError(`there are ${groups.length} group files for ${summary.groups.length} groups`);
  const rowOf = new Map(wallets.map((wallet, index) => [wallet, index]));
  let listed = 0;
  groups.forEach((file, index) => {
    const expected = summary.groups[index] as WebGroup;
    if (
      !GroupFileShape.safeParse(file).success ||
      file.index !== index ||
      file.size !== expected.size ||
      file.held !== expected.held ||
      file.robo !== expected.robo
    ) {
      throw new ExportCheckError(`group ${index}: its file does not match summary.groups`);
    }
    let previous = -1;
    let held = 0;
    for (const member of file.members) {
      const at = rowOf.get(member.address);
      if (at === undefined || at <= previous || points.group[at] !== index) {
        throw new ExportCheckError(`group ${index}: its members are not its own wallets in claim-list order`);
      }
      previous = at;
      checkShownText(member.reason, `row ${at + 1}: its reason in group ${index}`);
      if (member.outcome !== points.outcome[at] || member.robo !== points.robo[at]) {
        throw new ExportCheckError(`row ${at + 1}: group ${index} and points.json disagree`);
      }
      if (member.outcome === OUTCOME_CODES.hold || member.outcome === OUTCOME_CODES.exclude) held += 1;
    }
    if (file.members.length !== file.size || held !== file.held) {
      throw new ExportCheckError(
        `group ${index}: it lists ${file.members.length} members, ${held} held, but summary.groups says ${file.size} and ${file.held}`,
      );
    }
    listed += file.members.length;
  });
  const sizes = summary.groups.reduce((sum, group) => sum + group.size, 0);
  const grouped = points.group.filter((group) => group !== -1).length;
  if (listed !== sizes || listed !== grouped) {
    throw new ExportCheckError(`the group files list ${listed} members, but summary.groups sizes add to ${sizes} and points.json groups ${grouped}`);
  }
}

/**
 * Builds the files the replay page opens one wallet or one linked group from: 256 wallet shards, wallets/00.json to
 * wallets/ff.json, each keyed by lowercase address and named by the address's first two hex characters, and one group
 * file per entry of summary.groups. Outcome, robo and group are buildWebExport's own points for this same input, and
 * every other value is a stored, already-checked one, so these files and points.json cannot disagree. A group lists
 * every wallet in it, held or not, in row order, which is the claim list's order. The model's raw reply and the farm key
 * are never read. Pure: no network, no clock, no files.
 *
 * @throws ExportCheckError on everything buildWebExport refuses, on a row or first-funder address the one parser
 * refuses, on a row wallet with anything around the address, and when the output check fails: a reason or request id
 * that is not plain text or still holds a long dash, a cited hash that is not 0x and 64 lowercase hex, a field outside
 * the public shape, a wallet not in exactly one shard, or totals that differ from points.json and summary.groups.
 * @throws Error STALE_DECISION, and RangeError for a wallet listed twice, both from scoreDecisions.
 */
export function buildWalletFiles(input: ExportInput): { shards: Map<string, WalletShard>; groups: GroupFile[] } {
  const { summary, points } = buildWebExport(input);
  const records = byLowerWallet(input.records, 'decision');
  const wallets = input.rows.map((row, index) => {
    const wallet = publicAddress(row.wallet, `row ${index + 1}: its wallet`);
    // buildWebExport looked each row up as lower(row.wallet), so the published key must be that very string.
    if (wallet !== lower(row.wallet)) throw new ExportCheckError(`row ${index + 1}: its wallet has characters around the address`);
    return wallet;
  });

  const shards = new Map(SHARD_NAMES.map((name): [string, WalletShard] => [name, { schema: 1, wallets: {} }]));
  const groups = summary.groups.map(
    (group, index): GroupFile => ({ schema: 1, index, size: group.size, held: group.held, robo: group.robo, members: [] }),
  );
  input.rows.forEach((row, index) => {
    const wallet = wallets[index] as string;
    // buildWebExport has already refused a row with no stored decision.
    const record = records.get(wallet) as DecisionRecord;
    const { facts } = row;
    const funder = facts.firstFunder;
    const detail: WalletDetail = {
      i: index,
      outcome: OUTCOME_CODES[record.action],
      shareBps: record.shareBps,
      rule: record.rule,
      reason: cleanReason(record.reason),
      txs: [...record.citedTxs],
      robo: points.robo[index] as number,
      group: points.group[index] as number,
      start: { outcome: row.start.outcome, rule: row.start.rule },
      facts: {
        ageDays: facts.walletAgeDays,
        txCount: facts.txCountAtSnapshot,
        accountType: facts.accountType,
        funder:
          funder === null
            ? null
            : {
                address: publicAddress(funder.address, `row ${index + 1}: its first funder`),
                kind: funder.kind,
                fanout: funder.fanoutInList,
                hops: funder.hopsTraced,
              },
        burstWallets: facts.fundingBurst?.wallets ?? null,
        sameFunderWithinWindow: facts.group?.sameFunderWithinWindow ?? null,
        sweptToSharedCollector: facts.group?.sweptToSharedCollector ?? null,
        missing: [...facts.missing],
      },
      serv: { mode: record.mode, requestId: record.requestId, accepted: record.accepted, secondAsk: record.secondAsk },
    };
    (shards.get(shardName(wallet)) as WalletShard).wallets[wallet] = detail;
    groups[detail.group]?.members.push({
      address: wallet,
      outcome: detail.outcome,
      rule: detail.rule,
      robo: detail.robo,
      reason: detail.reason,
      txs: [...detail.txs],
    });
  });
  const files = { shards, groups };
  checkWalletFiles(wallets, points, summary, files);
  return files;
}

function zeroOutcomes(): Record<Outcome, number> {
  return Object.fromEntries(OUTCOMES.map((name) => [name, 0])) as Record<Outcome, number>;
}

/**
 * Compares each row's stored decision with the one the export publishes: the same record's stored reply checked again
 * with today's output checks under the current rulebook. An outcome may change in exactly two ways. A stored hold or
 * exclude goes back to the row's start, carrying the code's shared-funder cause, because a shared funder was the only
 * evidence (C47). Or any stored outcome becomes a hold, not accepted and with a cause, because today's checks refuse the
 * stored reply; that hold is never more generous than what was stored (C11, C13). Any other change stops the export, and
 * so does an exported outcome above the row's ceiling, even one equal to the start (C12). Pure: no network, no clock, no
 * files.
 *
 * @throws ExportCheckError naming the row: no stored or no exported decision, a decision that names another wallet, an
 * exported outcome above the ceiling, or an outcome changed any way other than the two above.
 */
export function checkRulebookMoves(
  rows: ReplayRow[],
  stored: Map<string, DecisionRecord>,
  exported: Map<string, DecisionRecord>,
): RulebookMoves {
  const before = byLowerWallet(stored, 'decision');
  const after = byLowerWallet(exported, 'exported decision');
  const moves: RulebookMoves = { toStart: 0, heldByChecks: 0, stored: zeroOutcomes(), exported: zeroOutcomes() };
  rows.forEach((row, index) => {
    const at = `row ${index + 1}`;
    const wallet = lower(row.wallet);
    const was = before.get(wallet);
    const now = after.get(wallet);
    if (was === undefined || now === undefined) throw new ExportCheckError(`${at} has no stored decision, or none under the current rulebook`);
    if (lower(was.wallet) !== wallet || lower(now.wallet) !== wallet) throw new ExportCheckError(`${at}: a decision for it names another wallet`);
    if (leastGenerous(now.action, row.ceiling) !== now.action) throw new ExportCheckError(`${at}: its exported outcome is above its ceiling`);
    moves.stored[was.action] += 1;
    moves.exported[now.action] += 1;
    if (now.action === was.action) return;
    if (isHeld(was.action) && now.action === row.start.outcome && now.cause === FUNDER_KEPT_CAUSE) {
      moves.toStart += 1;
      return;
    }
    if (now.action === 'hold' && !now.accepted && now.cause !== null && leastGenerous(now.action, was.action) === now.action) {
      moves.heldByChecks += 1;
      return;
    }
    throw new ExportCheckError(`${at}: its outcome changed in a way neither the shared-funder rule nor a refused reply explains`);
  });
  return moves;
}

/**
 * The exact text a public file is written with: the value parsed through its strict shape, so a field nobody listed
 * stops the export, then refused if the text holds anything shaped like an address or a hash (C33, C34).
 */
function publicText<T>(name: string, value: unknown, shape: z.ZodType<T>): { value: T; text: string } {
  const parsed = shape.safeParse(value);
  if (!parsed.success) throw new ExportCheckError(`${name} does not match its public shape`);
  const text = `${JSON.stringify(parsed.data, null, 2)}\n`;
  if (ADDRESS_LIKE.test(text)) throw new ExportCheckError(`${name} would hold 0x and 8 or more hex characters`);
  return { value: parsed.data, text };
}

function webCohort(cohort: HopCohort, part: string): WebHopCohort {
  if (cohort.heldLow === null || cohort.heldHigh === null) {
    throw new ExportCheckError(`no ${part} wallet was counted, so there is no held rate to publish`);
  }
  return {
    screened: cohort.screened,
    noHistory: cohort.noEthereumHistory,
    counted: cohort.counted,
    held: cohort.hold + cohort.exclude,
    heldLow: cohort.heldLow,
    heldHigh: cohort.heldHigh,
    excluded: cohort.exclude,
    partial: cohort.partial,
    full: cohort.full,
  };
}

/**
 * hop.json from a scoreHop result: how the code's starts fell on Hop's probably-real wallets and its eliminated ones,
 * and how far holds reached into Hop's clusters. Every number is the score's own, copied field by field, so nothing else
 * the score holds can reach the file. Pure: no network, no clock, no files.
 *
 * @returns The value and the exact text to write.
 * @throws ExportCheckError when a cohort counted no wallet, the run date is not a calendar day, or the text fails
 * publicText.
 */
export function buildWebHop(score: HopScore, runDate: string): { value: WebHop; text: string } {
  const hop: WebHop = {
    schema: 1,
    runDate,
    probablyReal: webCohort(score.negatives, 'probably-real'),
    eliminated: webCohort(score.eliminated, 'eliminated'),
    clusters: {
      total: score.clusters.total,
      touched: score.clusters.touched,
      fullyHeld: score.clusters.fullyHeld,
      uncounted: score.clusters.noCounted,
    },
  };
  return publicText('hop.json', hop, WebHopShape);
}

/**
 * versions.json from the stored version comparison (data/feedback/versions.json). Its run date is the one the scorer
 * wrote, the day the scorecard was scored. The export's own date never replaces it, because copying a scorecard does
 * not make it newer. The stored value goes through a strict shape that names every field it holds, so a field added to
 * the scorecard later stops the export until someone decides it may go public. Pure: no network, no clock, no files.
 *
 * @returns The value and the exact text to write.
 * @throws ExportCheckError when the stored value is not an object or not in that shape, a missing run date or one that
 * is not a calendar day included, or the text holds 0x and 8 or more hex characters.
 */
export function buildWebVersions(stored: unknown): { value: WebVersions; text: string } {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    throw new ExportCheckError('versions.json does not match its public shape');
  }
  if (!('runDate' in stored)) throw new ExportCheckError('the stored versions.json does not say when it was scored, rerun npm run versions:score');
  return publicText('versions.json', stored, WebVersionsShape);
}

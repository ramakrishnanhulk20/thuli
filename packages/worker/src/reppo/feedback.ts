import { z } from 'zod';
import {
  DECISION_RULES,
  OutcomeSchema,
  ReppoVerdict,
  reppoInput,
  toGraphRecord,
  type GraphRecord,
  type Outcome,
  type ReplayRow,
  type Settings,
} from '@thuli/core';
import type { JsonlCache } from '../chain/jsonlCache.ts';
import type { DecisionRecord } from '../replay/decide.ts';
import { asRulebook } from '../replay/versions.ts';
import type { ReppoEval } from './client.ts';

export const FeedbackEntry = z.strictObject({
  wallet: z.string(),
  set: z.enum(['robo', 'hop']),
  group: z.string(),
  rulebook: z.string(),
  evalId: z.string(),
  input: z.string(),
  action: OutcomeSchema,
  rule: z.enum(DECISION_RULES),
  verdict: ReppoVerdict.nullable(),
  creditsCharged: z.int().min(0),
  disagrees: z.boolean(),
  /**
   * UNFINISHED: Reppo was still working when the wait ran out, so there is no verdict yet and evalId is the way to fetch
   * it. Absent on entries stored before this field, every one of which finished.
   */
  status: z.enum(['COMPLETED', 'UNFINISHED']).optional(),
});

export type FeedbackEntry = z.infer<typeof FeedbackEntry>;

export interface FeedbackItem {
  wallet: string;
  set: FeedbackEntry['set'];
  group: string;
  record: GraphRecord;
  action: Outcome;
  rule: FeedbackEntry['rule'];
  reason: string;
}

/** The wallet, set and group one line of a list file names. */
export type ListedWallet = Pick<FeedbackItem, 'wallet' | 'set' | 'group'>;

export interface FeedbackDeps {
  evaluate(input: string): Promise<ReppoEval>;
}

export interface FeedbackOptions {
  rulebook: string;
  limit: number | undefined;
  cache: JsonlCache<FeedbackEntry>;
  log(line: string): void;
}

export interface FeedbackCounts {
  sent: number;
  disagreed: number;
  /** Reppo failed these twice for free, so they are not stored and a rerun asks again. */
  failed: number;
  /** Still running when the wait ran out. Stored with the eval id and no verdict, so a rerun does not pay for them again. */
  unfinished: number;
  skipped: number;
  creditsCharged: number;
}

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const NUMBER = String.raw`\d[\d,]*(?:\.\d+)?`;

// What a text bound for Reppo's public pages must never hold, by kind (C35). The hex rule is the same definition as
// core's last check on a payload, so an address and a transaction hash are caught alike in both places.
const IDENTIFYING: readonly { kind: string; patterns: readonly RegExp[] }[] = [
  { kind: 'an address or a transaction hash', patterns: [/0x[0-9a-f]{4,}|[0-9a-f]{16,}/i] },
  {
    kind: 'an amount',
    patterns: [
      new RegExp(String.raw`\p{Sc}\s?\d`, 'u'),
      new RegExp(String.raw`\b${NUMBER}\s?(?:eth|ether|wei|gwei|usdc|usdt|dai|tokens?)\b`, 'i'),
      // All capitals after a number reads as a ticker; EOA is the one capital word a count is ever followed by.
      new RegExp(String.raw`\b${NUMBER}\s?(?!EOAS?\b)[A-Z][A-Z0-9]{1,9}\b`),
    ],
  },
  {
    kind: 'a date or a time',
    patterns: [
      /\b\d{4}-\d{2}-\d{2}\b/,
      /\b\d{1,2}:\d{2}\b/,
      new RegExp(String.raw`\b(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:${MONTHS})\.?,?\s+\d{4}\b`, 'i'),
    ],
  },
];

// Seven digits or more once separators go: a Unix time, or an amount in base units such as a reward of 1,000,000. Every
// count the facts give, days, transactions or wallets, is far shorter.
const LONG_NUMBER = /\d{7,}/;

/**
 * The kind of thing in a text bound for Reppo that could tie it to one wallet or one moment, or null when there is none:
 * an address or a transaction hash, an amount in a currency or a token, a date or a clock time, or a number of seven
 * digits or more. Read after the same normalising core's stripIdentifiers does, so a full-width digit or a zero-width
 * character cannot split a run past it. It does not catch a name, such as an ENS name, which no fact or stored reason
 * holds. Pure.
 */
export function identifyingPart(text: string): string | null {
  const normal = text.normalize('NFKC').replace(/\p{Cf}/gu, '');
  const found = IDENTIFYING.find(({ patterns }) => patterns.some((pattern) => pattern.test(normal)));
  if (found !== undefined) return found.kind;
  return LONG_NUMBER.test(normal.replace(/(?<=\d)[,._](?=\d)/g, '')) ? 'a number long enough to be a time or an amount' : null;
}

// 12 wallets sit in both replay sets, and a new rulebook is a new decision, so the wallet alone would skip real work.
const feedbackKey = (item: FeedbackItem, rulebook: string) => `${rulebook}:${item.set}:${item.wallet}`;

/**
 * Builds one item from a wallet's stored decision. With useV2 the stored model reply is checked again under rulebook 2
 * (asRulebook), the same recheck the version scorecard runs, so a re-check sends what v2 actually decided, not what v1
 * stored. A record with no reply to check is sent as stored, which holds (C11).
 *
 * @throws Error STALE_ROWS when useV2 is on and the stored decision no longer matches the row's facts.
 * @throws RangeError when useV2 is on and the row is another wallet's.
 * @throws ZodError when the row's facts do not make a GraphRecord.
 */
export function feedbackItem(
  listed: ListedWallet,
  row: ReplayRow,
  stored: DecisionRecord,
  opts: { useV2: boolean; settings: Settings },
): FeedbackItem {
  const decision = opts.useV2 ? asRulebook(stored, row, opts.settings, 2) : stored;
  return {
    ...listed,
    record: toGraphRecord(row.facts, row.start),
    action: decision.action,
    rule: decision.rule,
    reason: decision.reason,
  };
}

/**
 * True when a rulebook label names the other version from the decisions being sent, such as v2 decisions under
 * v1-recheck. A stored entry says which version Reppo judged, so a wrong label would mark the wrong version right or
 * wrong, and under plain v1 the wallets would be skipped as already sent. A label with no version in it is left alone.
 */
export function namesOtherVersion(rulebook: string, useV2: boolean): boolean {
  const version = /^v\d+/.exec(rulebook)?.[0];
  return version !== undefined && version !== (useV2 ? 'v2' : 'v1');
}

/**
 * Sends each wallet's decision to Reppo, one at a time because an account may run only one evaluation at once, and stores
 * each paid result as it lands, so a run can stop at any moment and resume. Anything already stored is skipped, and a
 * wallet listed twice is sent once.
 *
 * Every payload is built and checked before the first call, so a refused payload stops the run with nothing spent (C35).
 * An evaluation Reppo finished is stored even when its result was out of shape, because it was paid for and asking again
 * would pay twice. One still running when the wait ran out is stored as UNFINISHED with its eval id and no verdict, and
 * counted apart, because Reppo charges it when it ends: a rerun skips it, and the id is how its result is fetched (C23).
 * A FAILED evaluation cost nothing and holds no verdict, so it is not stored. Log lines hold counts only (C40). Any error
 * stops the run, and everything finished before it is already on disk.
 *
 * @returns Counts for this run.
 * @throws ReppoPayloadError before any call when a payload still holds an identifier.
 * @throws RangeError when limit is not a whole number of at least 0, before any call.
 * @throws ReppoOutOfCredit on a 402, and whatever else evaluate throws, after keeping what finished.
 */
export async function runFeedback(items: FeedbackItem[], deps: FeedbackDeps, opts: FeedbackOptions): Promise<FeedbackCounts> {
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 0)) {
    throw new RangeError('limit must be a whole number of at least 0');
  }
  const waiting = new Map<string, FeedbackItem>();
  for (const item of items) {
    const key = feedbackKey(item, opts.rulebook);
    if (!opts.cache.has(key)) waiting.set(key, item);
  }
  const work = [...waiting].slice(0, opts.limit).map(([key, item]) => ({
    key,
    item,
    input: reppoInput(item.record, item.action, item.reason),
  }));

  const counts: FeedbackCounts = { sent: 0, disagreed: 0, failed: 0, unfinished: 0, skipped: items.length - waiting.size, creditsCharged: 0 };
  for (const { key, item, input } of work) {
    const result = await deps.evaluate(input);
    counts.sent += 1;
    counts.creditsCharged += result.creditsCharged;
    if (result.status === 'FAILED') {
      counts.failed += 1;
    } else {
      const unfinished = result.status === 'UNFINISHED';
      const disagrees = !unfinished && result.verdict?.decision === 'reject';
      if (unfinished) counts.unfinished += 1;
      if (disagrees) counts.disagreed += 1;
      opts.cache.put(key, {
        wallet: item.wallet,
        set: item.set,
        group: item.group,
        rulebook: opts.rulebook,
        evalId: result.id,
        input,
        action: item.action,
        rule: item.rule,
        verdict: unfinished ? null : result.verdict,
        creditsCharged: result.creditsCharged,
        disagrees,
        status: result.status,
      });
    }
    opts.log(`feedback: ${counts.sent}/${work.length} sent, ${counts.disagreed} disagreed, ${counts.failed} failed, ${counts.unfinished} unfinished`);
  }
  return counts;
}

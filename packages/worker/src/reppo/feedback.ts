import { z } from 'zod';
import { DECISION_RULES, OutcomeSchema, ReppoVerdict, reppoInput, type GraphRecord, type Outcome } from '@thuli/core';
import type { JsonlCache } from '../chain/jsonlCache.ts';
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
  skipped: number;
  creditsCharged: number;
}

// 12 wallets sit in both replay sets, and a new rulebook is a new decision, so the wallet alone would skip real work.
const feedbackKey = (item: FeedbackItem, rulebook: string) => `${rulebook}:${item.set}:${item.wallet}`;

/**
 * Sends each wallet's decision to Reppo, one at a time because an account may run only one evaluation at once, and stores
 * each paid result as it lands, so a run can stop at any moment and resume. Anything already stored is skipped, and a
 * wallet listed twice is sent once.
 *
 * Every payload is built and checked before the first call, so a refused payload stops the run with nothing spent (C35).
 * An evaluation Reppo finished is stored even when its result was out of shape, because it was paid for and asking again
 * would pay twice. A FAILED evaluation cost nothing and holds no verdict, so it is not stored. Log lines hold counts only
 * (C40). Any error stops the run, and everything finished before it is already on disk.
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

  const counts: FeedbackCounts = { sent: 0, disagreed: 0, failed: 0, skipped: items.length - waiting.size, creditsCharged: 0 };
  for (const { key, item, input } of work) {
    const result = await deps.evaluate(input);
    counts.sent += 1;
    counts.creditsCharged += result.creditsCharged;
    if (result.status === 'FAILED') {
      counts.failed += 1;
    } else {
      const disagrees = result.verdict?.decision === 'reject';
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
        verdict: result.verdict,
        creditsCharged: result.creditsCharged,
        disagrees,
      });
    }
    opts.log(`feedback: ${counts.sent}/${work.length} sent, ${counts.disagreed} disagreed, ${counts.failed} failed`);
  }
  return counts;
}

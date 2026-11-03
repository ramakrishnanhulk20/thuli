import { z } from 'zod';
import { meetsGroupExcludeRule } from './ceiling.ts';
import type { Facts } from './facts.ts';
import { leastGenerous, OUTCOMES, OutcomeSchema, type Outcome } from './outcome.ts';
import type { Settings } from './settings.ts';

export const DECISION_RULES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'B1', 'B2'] as const;

export const RawDecision = z.strictObject({
  action: OutcomeSchema,
  shareBps: z.int(),
  rule: z.enum(DECISION_RULES),
  reason: z.string(),
  citedTxs: z.array(z.string()),
  paidHops: z.int().min(0),
});

export type RawDecision = z.infer<typeof RawDecision>;

/**
 * RawDecision as a JSON Schema for SERV's structured outputs. SERV rewrites the system prompt before the model sees
 * it, so without this the model invented its own field names and SERV's filter replaced the rule and reason with
 * "redacted" (live run 32256e58, 3 Nov). No minimum or maximum keywords: builders report SERV rejects numeric
 * ranges, and validateDecision checks them anyway.
 */
export const DECISION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...OUTCOMES] },
    shareBps: { type: 'integer' },
    rule: { type: 'string', enum: [...DECISION_RULES] },
    reason: { type: 'string' },
    citedTxs: { type: 'array', items: { type: 'string' } },
    paidHops: { type: 'integer' },
  },
  required: ['action', 'shareBps', 'rule', 'reason', 'citedTxs', 'paidHops'],
  additionalProperties: false,
} as const;

export type FinalDecision = RawDecision & { clampedFrom?: Outcome };

export interface DecisionContext {
  facts: Facts;
  settings: Settings;
  ceiling: Outcome;
  toolTxs: string[];
  /** Paid lookups the worker actually made in this run; when given, the model's own count must match it. */
  paidHopsMade?: number;
}

export const MAX_REASON_CHARS = 280;

// A real decision is well under 2 KB. Anything far larger is refused before JSON.parse ever sees it (C41).
const MAX_RAW_TEXT_CHARS = 16_384;

// Plain text only: no links, no markup, no markdown links (C13, C33). Checked on the lowercased reason.
const FORBIDDEN_IN_REASON = ['http', 'www.', '<', '>', ']('];
// Control characters other than tab and newline, and the bidirectional overrides that can make text display out of order.
const NON_PLAIN_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/** The only share that matches each action, in basis points. */
export function shareFor(action: Outcome, settings: Settings): number {
  if (action === 'full') return 10000;
  if (action === 'partial') return settings.partialShareBps;
  return 0;
}

export type ParsedReply = { ok: true; decision: RawDecision } | { ok: false; cause: string };

/**
 * Parses a model reply into the fixed decision shape. A string must be exactly one JSON object; nothing around it
 * is stripped or repaired, because a repaired reply is no longer the one the model gave.
 */
export function parseRawDecision(raw: unknown): ParsedReply {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_RAW_TEXT_CHARS) return { ok: false, cause: 'the model reply was too long to check' };
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, cause: 'the model reply was not valid JSON' };
    }
  }
  const parsed = RawDecision.safeParse(value);
  if (!parsed.success) return { ok: false, cause: 'the model reply did not match the decision format' };
  return { ok: true, decision: parsed.data };
}

/** A hold with rule A1 and the cause in plain words. Doubt, of any kind, ends here (threat model C11). */
export function holdForReview(cause: string): { decision: FinalDecision; accepted: false; cause: string } {
  return {
    decision: {
      action: 'hold',
      shareBps: 0,
      rule: 'A1',
      reason: `Held for review: ${cause}.`,
      citedTxs: [],
      paidHops: 0,
    },
    accepted: false,
    cause,
  };
}

/**
 * Checks a model's decision like untrusted input, then applies the code ceiling.
 *
 * Any failed check gives a hold with rule A1 and accepted false (threat model C11, C13). An exclude without the A3
 * self-linked group evidence becomes a hold (C15). Otherwise the final action is the less generous of the model's
 * action and the ceiling; when that lowers it, clampedFrom records the model's action and the share is recomputed
 * (C12). The cause texts are fixed strings, so no model text is ever copied into a fallback reason.
 */
export function validateDecision(
  raw: unknown,
  ctx: DecisionContext,
): { decision: FinalDecision; accepted: boolean; cause?: string } {
  const parsed = parseRawDecision(raw);
  if (!parsed.ok) return holdForReview(parsed.cause);
  const reply = parsed.decision;

  if (reply.shareBps !== shareFor(reply.action, ctx.settings)) {
    return holdForReview('the share did not match the action');
  }
  if (reply.reason.length > MAX_REASON_CHARS) {
    return holdForReview('the reason was longer than 280 characters');
  }
  const lowered = reply.reason.toLowerCase();
  if (FORBIDDEN_IN_REASON.some((token) => lowered.includes(token)) || NON_PLAIN_CHARACTERS.test(reply.reason)) {
    return holdForReview('the reason contained a link, markup or control characters');
  }
  const fetched = new Set([...ctx.facts.evidenceTxs, ...ctx.toolTxs].map((hash) => hash.toLowerCase()));
  if (reply.citedTxs.some((hash) => !fetched.has(hash.toLowerCase()))) {
    return holdForReview('the reason cited a transaction Thuli did not fetch for this wallet');
  }
  if (reply.paidHops > ctx.settings.maxPaidHops) {
    return holdForReview('the model reported more paid lookups than the settings allow');
  }
  if (ctx.paidHopsMade !== undefined && reply.paidHops !== ctx.paidHopsMade) {
    return holdForReview('the model reported a different number of paid lookups than were made');
  }
  if (reply.action === 'partial' && !ctx.settings.allowPartial) {
    return holdForReview('the model chose partial but this campaign has partial rewards switched off');
  }
  if (reply.action === 'exclude' && !meetsGroupExcludeRule(ctx.facts, ctx.settings)) {
    return holdForReview('the model chose exclude without the self-linked group evidence that rule A3 requires');
  }

  const action = leastGenerous(reply.action, ctx.ceiling);
  if (action === reply.action) return { decision: reply, accepted: true };
  return {
    decision: { ...reply, action, shareBps: shareFor(action, ctx.settings), clampedFrom: reply.action },
    accepted: true,
  };
}

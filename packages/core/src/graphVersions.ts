import { z } from 'zod';
import { GraphAnswer, GraphRecord, VERDICTS } from './graph.ts';
import { FULL_HASH, HEX_RUN, MALFORMED_HASH_CAUSE } from './hex.ts';
import { leastGenerous, type Outcome } from './outcome.ts';
import type { FixedRule } from './start.ts';

export class GraphVersionError extends Error {
  override name = 'GraphVersionError';
}

/**
 * One frozen SERV graph and the hand-written translation between our flat record and that graph's own shapes. SERV's
 * generator invents each graph's input schema, checks run input strictly against it and will not invent a missing
 * field, and a graph id never changes once generated, so each id gets exactly one translation (PLAN item 4, "Frozen
 * rulebook per campaign version").
 */
export interface GraphVersion {
  graphId: string;
  name: string;
  /** The run input for this graph. Throws ZodError on a bad record and GraphVersionError on one the graph cannot carry. */
  toInput(record: GraphRecord): unknown;
  /** The graph's reply as our answer, or a fixed cause when it is unusable, so no model text ever reaches a cause. */
  toAnswer(raw: unknown, record: GraphRecord): { ok: true; answer: GraphAnswer } | { ok: false; cause: string };
}

const G1_OUTCOMES = ['full_reward', 'partial_reward', 'hold_for_review', 'exclude'] as const;
type G1Outcome = (typeof G1_OUTCOMES)[number];

const G1_OUTCOME_FOR: Record<Outcome, G1Outcome> = {
  full: 'full_reward',
  partial: 'partial_reward',
  hold: 'hold_for_review',
  exclude: 'exclude',
};

const ACTION_FOR_G1: Record<G1Outcome, Outcome> = {
  full_reward: 'full',
  partial_reward: 'partial',
  hold_for_review: 'hold',
  exclude: 'exclude',
};

interface G1Input {
  record: {
    wallet_age_days: number;
    pre_snapshot_activity_count: number;
    account_type: string;
    first_funder_kind: string;
    first_funder_claim_wallet_count: number;
    first_funder_tx_hash: string | null;
    linked_claim_wallet_group_size: number;
    group_has_shared_funding: boolean;
    group_sweeps_to_shared_collector: boolean;
    wallet_made_group_links: boolean;
    group_tx_hashes: string[];
    shared_exchange_claimant_count: number;
    exchange_tx_hashes: string[];
    claim_paid_to_another_address: boolean;
    claim_payment_tx_hash: string | null;
    unreadable_facts: string[];
    start_outcome: G1Outcome;
    start_rule_code: FixedRule;
  };
}

const G1Answer = z.strictObject({
  verdict: z.enum(VERDICTS),
  recommended_outcome: z.enum(G1_OUTCOMES),
  reason: z.string(),
});

// A real answer is well under 2 KB. Anything far larger is refused before JSON.parse ever sees it (C41).
const MAX_ANSWER_CHARS = 16_384;

const RULE_CODE = /\b(?:A[1-9]|B[12])\b/g;

const RAISED_BY_B2: readonly FixedRule[] = ['A4', 'A5', 'A6'];
const HELD_BY_B1: readonly FixedRule[] = ['A8', 'A9'];

function g1Input(input: GraphRecord): G1Input {
  const record = GraphRecord.parse(input);
  if (record.traced_funder_kind !== 'none') throw new GraphVersionError('graph g1 has no field for a traced funder');
  if (record.funding_burst_wallets > 0) throw new GraphVersionError('graph g1 has no field for a funding burst');
  const hasFunder = record.first_funder_kind !== 'none';
  const unreadable: string[] = [...record.unreadable_facts];
  if (record.first_funder_claim_wallets === null && hasFunder) unreadable.push('first_funder_claim_wallet_count');
  return {
    record: {
      // g1 takes no nulls here. An unread value is listed in unreadable_facts, so this 0 is never read as a measurement.
      wallet_age_days: record.wallet_age_days ?? 0,
      pre_snapshot_activity_count: record.tx_count ?? 0,
      account_type: record.account_type,
      first_funder_kind: record.first_funder_kind,
      // Our count includes this wallet; g1's counts only the other claim wallets the funder paid.
      first_funder_claim_wallet_count:
        record.first_funder_claim_wallets === null ? 0 : Math.max(record.first_funder_claim_wallets - 1, 0),
      // The facts collector puts the first funding transaction first, and drops it whenever it drops the funder.
      first_funder_tx_hash: hasFunder ? (record.evidence_tx_hashes[0] ?? null) : null,
      linked_claim_wallet_group_size: record.group_size,
      group_has_shared_funding: (record.group_same_funder ?? 0) >= 2,
      group_sweeps_to_shared_collector: record.group_swept_to_shared_collector,
      wallet_made_group_links: record.group_links_made_by_wallet,
      group_tx_hashes: [],
      shared_exchange_claimant_count: record.shared_deposit_claimants,
      exchange_tx_hashes: [],
      claim_paid_to_another_address: record.claim_paid_to_other_address ?? false,
      claim_payment_tx_hash: null,
      unreadable_facts: unreadable,
      start_outcome: G1_OUTCOME_FOR[record.start_outcome],
      start_rule_code: record.start_rule,
    },
  };
}

// g1 answers with no rule, so the rule is worked out from how its outcome moved the code's start. A move no rule
// allows keeps the start rule, which validateDecision then refuses, because a fixed rule must keep the start outcome.
export function ruleFor(action: Outcome, record: GraphRecord): GraphAnswer['rule'] {
  if (action === record.start_outcome) return record.start_rule;
  if (RAISED_BY_B2.includes(record.start_rule) && leastGenerous(action, record.start_outcome) === record.start_outcome) {
    return 'B2';
  }
  if (HELD_BY_B1.includes(record.start_rule) && action === 'hold') return 'B1';
  return record.start_rule;
}

function g1Answer(raw: unknown, record: GraphRecord): ReturnType<GraphVersion['toAnswer']> {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_ANSWER_CHARS) return { ok: false, cause: 'the model reply was too long to check' };
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, cause: 'the model reply was not valid JSON' };
    }
  }
  const parsed = G1Answer.safeParse(value);
  if (!parsed.success) return { ok: false, cause: 'the model reply did not match the answer format' };
  const { verdict, recommended_outcome, reason } = parsed.data;

  // One scan both collects the hashes and refuses the malformed ones.
  const cited = new Set<string>();
  for (const [run] of reason.matchAll(HEX_RUN)) {
    if (!FULL_HASH.test(run)) return { ok: false, cause: MALFORMED_HASH_CAUSE };
    cited.add(`0x${run.slice(2).toLowerCase()}`);
  }

  const action = ACTION_FOR_G1[recommended_outcome];
  const rule = ruleFor(action, record);
  // g1's writer names a rule in the reason, but its outcome decides the rule. When they disagree (live: reason "B2:"
  // on a kept A4 hold, 3 Nov), the record would contradict itself, so the answer is refused.
  const named = [...reason.matchAll(RULE_CODE)].map(([code]) => code);
  if (named.length > 0 && !named.includes(rule)) {
    return { ok: false, cause: 'the reason names a different rule than the outcome shows' };
  }
  return { ok: true, answer: GraphAnswer.parse({ verdict, action, rule, reason, cited_tx_hashes: [...cited] }) };
}

/**
 * Graph g1, frozen on SERV as gr_bc6116b0153f023d. Its input names every field its own way and has no field for a
 * traced funder; its answer is {verdict, recommended_outcome, reason}, with no rule and no hash list, so the rule
 * comes from the code's start and the cited hashes from the reason.
 */
export const GRAPH_G1: GraphVersion = Object.freeze({
  graphId: 'gr_bc6116b0153f023d',
  name: 'g1',
  toInput: g1Input,
  toAnswer: g1Answer,
});

const GRAPH_VERSIONS: readonly GraphVersion[] = Object.freeze([GRAPH_G1]);

/** The translation for a frozen graph id, or undefined when Thuli has none, so no graph is ever sent a guessed input. */
export function graphVersion(graphId: string): GraphVersion | undefined {
  return GRAPH_VERSIONS.find((version) => version.graphId === graphId);
}

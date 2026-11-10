import { z } from 'zod';
import { DECISION_RULES, shareFor, type RawDecision } from './decision.ts';
import { ACCOUNT_TYPES, FACT_NAMES, FUNDER_KINDS, MAX_EVIDENCE_TXS, TxHash, type FactName, type Facts } from './facts.ts';
import { OUTCOMES, OutcomeSchema } from './outcome.ts';
import type { Settings } from './settings.ts';
import { FIXED_RULES, type Start } from './start.ts';

export const VERDICTS = ['ordinary_user', 'likely_farm', 'unclear'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** 'none' marks a wallet with no funder on record, so a funder kind is always a fixed word and never null. */
export const GRAPH_FUNDER_KINDS = [...FUNDER_KINDS, 'none'] as const;

const Count = z.int().min(0);

/**
 * The one flat record SERV sees for a wallet. The field names are the rulebook's, word for word: a SERV v3 graph
 * checks run input strictly against its own schema and will not invent a field it was not given. Every value is a
 * number, a boolean, a fixed word or a hash, so no text a stranger wrote on-chain can reach the model (C14, C34).
 */
export const GraphRecord = z.strictObject({
  start_outcome: OutcomeSchema,
  start_rule: z.enum(FIXED_RULES),
  wallet_age_days: Count.nullable(),
  tx_count: Count.nullable(),
  account_type: z.enum(ACCOUNT_TYPES),
  first_funder_kind: z.enum(GRAPH_FUNDER_KINDS),
  first_funder_claim_wallets: Count.nullable(),
  traced_funder_kind: z.enum(GRAPH_FUNDER_KINDS),
  traced_funder_claim_wallets: Count.nullable(),
  group_size: Count,
  group_same_funder: Count.nullable(),
  group_swept_to_shared_collector: z.boolean(),
  group_links_made_by_wallet: z.boolean(),
  shared_deposit_claimants: Count,
  funding_burst_wallets: Count,
  claim_paid_to_other_address: z.boolean().nullable(),
  evidence_tx_hashes: z.array(TxHash).max(MAX_EVIDENCE_TXS),
  unreadable_facts: z.array(z.enum(FACT_NAMES)).max(FACT_NAMES.length),
});

export type GraphRecord = z.infer<typeof GraphRecord>;

/**
 * Flattens a wallet's facts and the code's start into the record SERV receives. A fact is unreadable when the
 * collector listed it missing or left it null or unknown; evidenceTxs is never listed because no check depends on it.
 *
 * @throws ZodError when the record does not match GraphRecord, so a bad record never reaches SERV.
 */
export function toGraphRecord(facts: Facts, start: Start): GraphRecord {
  const unreadable = new Set<FactName>(facts.missing.filter((name) => name !== 'evidenceTxs'));
  if (facts.walletAgeDays === null) unreadable.add('walletAgeDays');
  if (facts.txCountAtSnapshot === null) unreadable.add('txCountAtSnapshot');
  if (facts.accountType === 'unknown') unreadable.add('accountType');
  if (facts.claimPaidToOtherAddress === null) unreadable.add('claimPaidToOtherAddress');
  const group = facts.group;
  const record: GraphRecord = {
    start_outcome: start.outcome,
    start_rule: start.rule,
    wallet_age_days: facts.walletAgeDays,
    tx_count: facts.txCountAtSnapshot,
    account_type: facts.accountType,
    first_funder_kind: facts.firstFunder?.kind ?? 'none',
    first_funder_claim_wallets: facts.firstFunder?.fanoutInList ?? null,
    // Facts hold no funder of the funder yet. The traced trail is filled in once Thuli's code buys funder lookups.
    traced_funder_kind: 'none',
    traced_funder_claim_wallets: null,
    group_size: group?.size ?? 0,
    group_same_funder: group?.sameFunderWithinWindow ?? null,
    group_swept_to_shared_collector: group?.sweptToSharedCollector ?? false,
    // Not authoredEvidence: that is exclude-grade evidence for A3, and this is a plain fact the model repeats in a reason.
    // Reading the stricter one here told the model a wallet made no links when its own sweep had made them (C15 unchanged).
    group_links_made_by_wallet: group?.linkedByWallet ?? false,
    shared_deposit_claimants: facts.sharedDepositAddress?.sharedWithClaimants ?? 0,
    funding_burst_wallets: facts.fundingBurst?.wallets ?? 0,
    claim_paid_to_other_address: facts.claimPaidToOtherAddress,
    evidence_tx_hashes: facts.evidenceTxs,
    unreadable_facts: FACT_NAMES.filter((name) => unreadable.has(name)),
  };
  return GraphRecord.parse(record);
}

/** SERV's answer for one wallet, with the field names the rulebook asks for. */
export const GraphAnswer = z.strictObject({
  verdict: z.enum(VERDICTS),
  action: OutcomeSchema,
  rule: z.enum(DECISION_RULES),
  reason: z.string(),
  cited_tx_hashes: z.array(z.string()),
});

export type GraphAnswer = z.infer<typeof GraphAnswer>;

/**
 * GraphAnswer as a JSON Schema for SERV's structured outputs. SERV rewrites the system prompt before the model sees
 * it, so without a schema the model invented its own field names (live run 32256e58, 3 Nov). No range keywords such
 * as minimum or maximum: builders report SERV rejects them, and validateDecision checks every limit anyway.
 */
export const GRAPH_ANSWER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: [...VERDICTS] },
    action: { type: 'string', enum: [...OUTCOMES] },
    rule: { type: 'string', enum: [...DECISION_RULES] },
    reason: { type: 'string' },
    cited_tx_hashes: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'action', 'rule', 'reason', 'cited_tx_hashes'],
  additionalProperties: false,
} as const;

// A real answer is well under 2 KB. Anything far larger is refused before JSON.parse ever sees it (C41).
const MAX_ANSWER_CHARS = 16_384;

/**
 * Turns SERV's answer into the decision shape validateDecision checks. The answer is untrusted input (C13): a string
 * must be exactly one JSON object, nothing around it is stripped or repaired, and its fields must match GraphAnswer
 * exactly. The share comes from the action and the settings, and paidHops is the worker's own count, so neither is
 * ever taken from the model. Cited hashes are lowercased and deduplicated, and an entry that is not a transaction hash
 * refuses the answer. Whether each hash was fetched for this wallet, and what the reason says, is validateDecision's
 * check. The cause texts are fixed strings, so no model text is ever copied into a fallback reason.
 */
export function decisionFromGraphAnswer(
  raw: unknown,
  settings: Settings,
  paidHops: number,
): { ok: true; decision: RawDecision; verdict: Verdict } | { ok: false; cause: string } {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_ANSWER_CHARS) return { ok: false, cause: 'the model reply was too long to check' };
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, cause: 'the model reply was not valid JSON' };
    }
  }
  const parsed = GraphAnswer.safeParse(value);
  if (!parsed.success) return { ok: false, cause: 'the model reply did not match the answer format' };
  const answer = parsed.data;
  // Stored hashes are lowercase only (TxHash), so a cited hash in another case is stored the way it is compared.
  const cited = answer.cited_tx_hashes.map((hash) => hash.toLowerCase());
  if (cited.some((hash) => !TxHash.safeParse(hash).success)) {
    return { ok: false, cause: 'the answer cited something that is not a transaction hash' };
  }
  return {
    ok: true,
    verdict: answer.verdict,
    decision: {
      action: answer.action,
      shareBps: shareFor(answer.action, settings),
      rule: answer.rule,
      reason: answer.reason,
      citedTxs: [...new Set(cited)],
      paidHops,
    },
  };
}

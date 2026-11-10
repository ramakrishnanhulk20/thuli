// Not covered here: whether the live g1 graph accepts this input and answers in this shape (the live prove-slice run
// shows that), and the checks validateDecision runs on the rule, the reason and the cited hashes (decision.test.ts).
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { GraphRecord } from '../src/graph.ts';
import { GRAPH_G1, graphVersion, GraphVersionError } from '../src/graphVersions.ts';

const FUNDING_TX = `0x${'a1'.repeat(32)}`;
const SWEEP_TX = `0x${'b2'.repeat(32)}`;

const CLEAN: GraphRecord = {
  start_outcome: 'full',
  start_rule: 'A9',
  wallet_age_days: 400,
  tx_count: 120,
  account_type: 'eoa',
  first_funder_kind: 'exchange',
  first_funder_claim_wallets: 3,
  traced_funder_kind: 'none',
  traced_funder_claim_wallets: null,
  group_size: 0,
  group_same_funder: null,
  group_swept_to_shared_collector: false,
  group_links_made_by_wallet: false,
  shared_deposit_claimants: 0,
  funding_burst_wallets: 0,
  claim_paid_to_other_address: false,
  evidence_tx_hashes: [FUNDING_TX],
  unreadable_facts: [],
};

const UNREAD: GraphRecord = {
  ...CLEAN,
  start_outcome: 'hold',
  start_rule: 'A1',
  wallet_age_days: null,
  tx_count: null,
  account_type: 'unknown',
  first_funder_kind: 'unknown',
  first_funder_claim_wallets: null,
  claim_paid_to_other_address: null,
  unreadable_facts: ['walletAgeDays', 'txCountAtSnapshot', 'accountType', 'claimPaidToOtherAddress'],
};

// Two wallets sharing a funder is the smallest count g1 reads as shared funding.
const FARM: GraphRecord = {
  ...CLEAN,
  start_outcome: 'exclude',
  start_rule: 'A3',
  first_funder_kind: 'wallet',
  first_funder_claim_wallets: 12,
  group_size: 8,
  group_same_funder: 2,
  group_swept_to_shared_collector: true,
  group_links_made_by_wallet: true,
  shared_deposit_claimants: 3,
  claim_paid_to_other_address: true,
  evidence_tx_hashes: [FUNDING_TX, SWEEP_TX],
};

describe('GRAPH_G1.toInput: our record in g1 field names', () => {
  it('maps a clean record to all 18 g1 fields', () => {
    expect(GRAPH_G1.toInput(CLEAN)).toEqual({
      record: {
        wallet_age_days: 400,
        pre_snapshot_activity_count: 120,
        account_type: 'eoa',
        first_funder_kind: 'exchange',
        first_funder_claim_wallet_count: 2,
        first_funder_tx_hash: FUNDING_TX,
        linked_claim_wallet_group_size: 0,
        group_has_shared_funding: false,
        group_sweeps_to_shared_collector: false,
        wallet_made_group_links: false,
        group_tx_hashes: [],
        shared_exchange_claimant_count: 0,
        exchange_tx_hashes: [],
        claim_paid_to_another_address: false,
        claim_payment_tx_hash: null,
        unreadable_facts: [],
        start_outcome: 'full_reward',
        start_rule_code: 'A9',
      },
    });
  });

  it('carries a self-linked farm group through, counting only the other claim wallets', () => {
    expect(GRAPH_G1.toInput(FARM)).toMatchObject({
      record: {
        first_funder_kind: 'wallet',
        first_funder_claim_wallet_count: 11,
        first_funder_tx_hash: FUNDING_TX,
        linked_claim_wallet_group_size: 8,
        group_has_shared_funding: true,
        group_sweeps_to_shared_collector: true,
        wallet_made_group_links: true,
        shared_exchange_claimant_count: 3,
        claim_paid_to_another_address: true,
        start_outcome: 'exclude',
        start_rule_code: 'A3',
      },
    });
  });

  it('turns unread values into zeros and lists each one as unreadable', () => {
    expect(GRAPH_G1.toInput(UNREAD)).toMatchObject({
      record: {
        wallet_age_days: 0,
        pre_snapshot_activity_count: 0,
        account_type: 'unknown',
        first_funder_kind: 'unknown',
        first_funder_claim_wallet_count: 0,
        first_funder_tx_hash: FUNDING_TX,
        group_has_shared_funding: false,
        claim_paid_to_another_address: false,
        unreadable_facts: [
          'walletAgeDays',
          'txCountAtSnapshot',
          'accountType',
          'claimPaidToOtherAddress',
          'first_funder_claim_wallet_count',
        ],
        start_outcome: 'hold_for_review',
        start_rule_code: 'A1',
      },
    });
    // With no funder there is no claim-wallet count to read, so nothing is listed and no funding hash is sent.
    expect(GRAPH_G1.toInput({ ...UNREAD, first_funder_kind: 'none' })).toMatchObject({
      record: {
        first_funder_claim_wallet_count: 0,
        first_funder_tx_hash: null,
        unreadable_facts: ['walletAgeDays', 'txCountAtSnapshot', 'accountType', 'claimPaidToOtherAddress'],
      },
    });
  });

  it('refuses a traced funder it has no field for, and a record that breaks the schema', () => {
    const traced = () => GRAPH_G1.toInput({ ...CLEAN, traced_funder_kind: 'wallet' });
    expect(traced).toThrow(GraphVersionError);
    expect(traced).toThrow('graph g1 has no field for a traced funder');
    expect(() => GRAPH_G1.toInput({ ...CLEAN, evidence_tx_hashes: [`0x${'A1'.repeat(32)}`] })).toThrow(ZodError);
  });

  it('refuses a funding burst it has no field for, and accepts a record with none', () => {
    const burst = () => GRAPH_G1.toInput({ ...CLEAN, funding_burst_wallets: 20 });
    expect(burst).toThrow(GraphVersionError);
    expect(burst).toThrow('graph g1 has no field for a funding burst');
    expect(() => GRAPH_G1.toInput({ ...CLEAN, funding_burst_wallets: 0 })).not.toThrow();
  });
});

const REASON ='Wallet is 400 days old with 120 transactions and was first funded by an exchange.';

function g1Reply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ verdict: 'ordinary_user', recommended_outcome: 'full_reward', reason: REASON, ...overrides });
}

// Recorded from SERV's g1 graph writer, character for character.
const REAL_G1_ANSWER =
  '{"verdict":"likely_farm","recommended_outcome":"exclude","reason":"A3: The wallet made links within an 8-wallet group that shares funding and sweeps to a shared collector, strong evidence of coordinated activity."}';

describe('GRAPH_G1.toAnswer: the g1 reply is untrusted input (C13)', () => {
  it('keeps the start rule when g1 keeps the start outcome', () => {
    expect(GRAPH_G1.toAnswer(g1Reply(), CLEAN)).toEqual({
      ok: true,
      answer: { verdict: 'ordinary_user', action: 'full', rule: 'A9', reason: REASON, cited_tx_hashes: [] },
    });
  });

  it('names rule B2 when g1 raises an A4 group hold', () => {
    const record: GraphRecord = { ...CLEAN, start_outcome: 'hold', start_rule: 'A4' };
    expect(GRAPH_G1.toAnswer(g1Reply({ recommended_outcome: 'partial_reward' }), record)).toMatchObject({
      ok: true,
      answer: { action: 'partial', rule: 'B2' },
    });
  });

  it('names rule B1 when g1 holds an A9 wallet', () => {
    expect(GRAPH_G1.toAnswer(g1Reply({ recommended_outcome: 'hold_for_review' }), CLEAN)).toMatchObject({
      ok: true,
      answer: { action: 'hold', rule: 'B1' },
    });
  });

  it('keeps the start rule on a move no rule allows, so validateDecision refuses it', () => {
    expect(GRAPH_G1.toAnswer(g1Reply({ recommended_outcome: 'partial_reward' }), CLEAN)).toMatchObject({
      ok: true,
      answer: { action: 'partial', rule: 'A9' },
    });
  });

  it('cites every full hash in the reason once, lowercased, in order of appearance', () => {
    const mixed = `0x${'aB'.repeat(32)}`;
    const reason = `Funded in ${mixed}, swept in ${SWEEP_TX}, and funded again in ${mixed.toLowerCase()}.`;
    expect(GRAPH_G1.toAnswer(g1Reply({ reason }), CLEAN)).toMatchObject({
      ok: true,
      answer: { cited_tx_hashes: [`0x${'ab'.repeat(32)}`, SWEEP_TX] },
    });
  });

  it('cites a hash written with an upper-case 0X in its lower-case form', () => {
    const reason = `Swept in 0X${'ab'.repeat(32)}.`;
    expect(GRAPH_G1.toAnswer(g1Reply({ reason }), CLEAN)).toMatchObject({
      ok: true,
      answer: { cited_tx_hashes: [`0x${'ab'.repeat(32)}`] },
    });
  });

  it('cites a hash glued to "tx", so validateDecision checks it like any other', () => {
    expect(GRAPH_G1.toAnswer(g1Reply({ reason: `Swept in tx0x${'ab'.repeat(32)}s.` }), CLEAN)).toMatchObject({
      ok: true,
      answer: { cited_tx_hashes: [`0x${'ab'.repeat(32)}`] },
    });
  });

  it("accepts a real g1 writer answer as 'exclude' under rule A3", () => {
    expect(GRAPH_G1.toAnswer(REAL_G1_ANSWER, FARM)).toEqual({
      ok: true,
      answer: {
        verdict: 'likely_farm',
        action: 'exclude',
        rule: 'A3',
        reason:
          'A3: The wallet made links within an 8-wallet group that shares funding and sweeps to a shared collector, strong evidence of coordinated activity.',
        cited_tx_hashes: [],
      },
    });
  });

  const MALFORMED = 'the reason contains a malformed transaction hash';
  const NOT_JSON = 'the model reply was not valid JSON';
  const TOO_LONG = 'the model reply was too long to check';
  const WRONG_SHAPE = 'the model reply did not match the answer format';

  // Asserting the exact cause proves no model text is ever copied into it.
  it.each([
    ['a 54-digit hash in the reason', g1Reply({ reason: `Swept in 0x${'c'.repeat(54)}.` }), MALFORMED],
    ['a full hash written without its 0x', g1Reply({ reason: `Swept in ${'c'.repeat(64)}.` }), MALFORMED],
    [
      'a reason that names B2 while the outcome keeps the start (live, 3 Nov)',
      g1Reply({ reason: 'B2: its bridge funder also funded 39 claim wallets, an ordinary shared-infrastructure link.' }),
      'the reason names a different rule than the outcome shows',
    ],
    ['an address the record never carried', g1Reply({ reason: `Funded by 0x${'d'.repeat(40)}.` }), MALFORMED],
    ['an address with a letter right after it', g1Reply({ reason: `Funded by 0x${'de'.repeat(20)}s.` }), MALFORMED],
    ['text that is not one JSON object', `\`\`\`json\n${g1Reply()}\n\`\`\``, NOT_JSON],
    ['an otherwise valid reply over the 16,384 character cap', g1Reply({ reason: 'a'.repeat(16_384) }), TOO_LONG],
    ['an extra field', g1Reply({ rule: 'A9' }), WRONG_SHAPE],
    ['an outcome g1 does not use', g1Reply({ recommended_outcome: 'full' }), WRONG_SHAPE],
  ])('refuses %s with a fixed cause', (_case, raw, cause) => {
    expect(GRAPH_G1.toAnswer(raw, CLEAN)).toEqual({ ok: false, cause });
  });
});

describe('graphVersion: one frozen translation per graph id', () => {
  it('finds g1 by its graph id and nothing else', () => {
    expect(graphVersion('gr_bc6116b0153f023d')).toBe(GRAPH_G1);
    expect(Object.isFrozen(GRAPH_G1)).toBe(true);
    expect(graphVersion('gr_0000000000000000')).toBeUndefined();
    expect(graphVersion('g1')).toBeUndefined();
  });
});

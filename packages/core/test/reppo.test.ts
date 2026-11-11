// Not covered here: whether Reppo's evaluators judge this text well (a real evaluation shows that), the network side
// (reppoClient.test.ts), and names such as an ENS name, which stripIdentifiers does not look for and the facts never hold.
import { describe, expect, it } from 'vitest';
import { parseAddress } from '../src/address.ts';
import type { GraphRecord } from '../src/graph.ts';
import { parseVerdict, ReppoPayloadError, reppoInput, stripIdentifiers } from '../src/reppo.ts';

const LOWERCASE = `0xa9ac${'1f'.repeat(16)}4573`;
const CHECKSUMMED = parseAddress(LOWERCASE);
const HASH = `0x${'ab'.repeat(32)}`;
const RULE_CODE = /\b(?:A[1-9]|B[12])\b/;

const RECORD: GraphRecord = {
  start_outcome: 'full',
  start_rule: 'A9',
  wallet_age_days: 324,
  tx_count: 16,
  account_type: 'eoa',
  first_funder_kind: 'contract',
  first_funder_claim_wallets: 63,
  traced_funder_kind: 'none',
  traced_funder_claim_wallets: null,
  group_size: 0,
  group_same_funder: null,
  group_swept_to_shared_collector: false,
  group_links_made_by_wallet: false,
  shared_deposit_claimants: 0,
  funding_burst_wallets: 0,
  claim_paid_to_other_address: false,
  evidence_tx_hashes: [HASH],
  unreadable_facts: [],
};

describe('stripIdentifiers', () => {
  it.each([
    ['checksummed', CHECKSUMMED],
    ['lowercase', LOWERCASE],
    ['truncated with dots', '0xa9ac...4573'],
    ['truncated with an ellipsis', '0xa9ac…4573'],
    ['truncated in capitals', '0xA9AC…4573'],
    ['shortened below the run length', '0xa9...4573'],
    ['truncated with no 0x', 'a9ac...4573'],
  ])('removes an address written %s', (_name, form) => {
    expect(stripIdentifiers(`The wallet ${form} funded it.`)).toBe('The wallet [removed] funded it.');
  });

  it.each([
    ['in a tx label', `Funded by an exchange (tx: ${HASH}).`],
    ['in a tx label with no colon', `Funded by an exchange (tx ${HASH}).`],
    ['in a numbered list', `Funded by an exchange (tx 1: ${HASH}, tx 2: ${HASH}).`],
    ['after a hash label', `Funded by an exchange. Hash: ${HASH}`],
    ['alone in brackets', `Funded by an exchange (${HASH}).`],
    ['after a spaced prefix', `Funded by an exchange (0x ${'a6cbdeb8'.repeat(8)}).`],
    ['with a citation mark', `Funded by an exchange [1]. Hash: ${HASH}`],
  ])('takes a hash %s with nothing dangling', (_name, text) => {
    expect(stripIdentifiers(text)).toBe('Funded by an exchange.');
  });

  it('removes a bare hex run of 16 or more, and the 0x prefix alone', () => {
    expect(stripIdentifiers('Seen in a6cbdeb8dffd4ac5 once.')).toBe('Seen in [removed] once.');
    expect(stripIdentifiers('Backed by (0x evidence).')).toBe('Backed by ([removed] evidence).');
  });

  it.each(['2022-03-24', '2022-03-24T12:05:33.000Z', '2022-03-24 12:05:33 UTC', 'Mar 24, 2022', 'March 24 2022', '24 Mar 2022'])(
    'removes the date %s',
    (date) => {
      expect(stripIdentifiers(`Funded on ${date} once.`)).toBe('Funded on [removed] once.');
    },
  );

  it.each(['0.0012 ETH', '1,234 ROBO', '$5.00', '12.5 USDC', '40 tokens', '3 eth'])('removes the amount %s', (amount) => {
    expect(stripIdentifiers(`It received ${amount} once.`)).toBe('It received [removed] once.');
  });

  it('keeps ordinary numbers and words', () => {
    const text = 'That contract funded 63 wallets; 1 EOA and a 2-wallet group made 1,171 transactions in May. Evidence hash recorded.';
    expect(stripIdentifiers(text)).toBe(text);
  });

  it('cannot be split past by a zero-width character or full-width digits', () => {
    expect(stripIdentifiers('See 0x\u200ba9ac\u200b1234 now.')).toBe('See [removed] now.');
    expect(stripIdentifiers('See ０ｘａ９ａｃ１２３４ now.')).toBe('See [removed] now.');
  });
});

describe('reppoInput', () => {
  it('builds the payload in the fixed order', () => {
    expect(reppoInput(RECORD, 'hold', 'A9: The first funder is a contract that funded 62 claim wallets.')).toBe(
      "User prompt: You screen one wallet on a crypto project's airdrop list. Decide: full reward, partial reward, hold for a person to review, or exclude. " +
        'Be fair to real users: ordinary people often share a popular bridge, an exchange or a faucet, and a new wallet is not a farm by itself. Links a wallet made itself are strong evidence of one operator. Links it did not make are weak on their own. A funding burst is a pattern, not proof of one owner, so it caps a wallet at a partial reward and never justifies a hold. A group of five or more listed wallets funded together, or sweeping to a shared collector, is held for a person, and excluded when the wallet itself swept to that collector. A wallet heading to a reward is held only on a traced funding trail or a link it made itself, never on how many wallets its funder paid. ' +
        "Facts from public chain data, identifiers removed: wallet age 324 days; 16 transactions before the snapshot; normal account; first funded by a contract; its first funder also funded 62 other wallets on this list; no group of linked wallets; no sweep to a shared collector; no shared deposit address; no funding burst; the code's own starting decision: full reward." +
        '\n\nAI response: Decision: hold for a person to review. Reason: The first funder is a contract that funded 62 claim wallets.',
    );
  });

  it('puts every fact in words and counts, for a wallet in a group with unreadable facts', () => {
    const input = reppoInput(
      {
        ...RECORD,
        start_outcome: 'partial',
        wallet_age_days: null,
        tx_count: 1,
        account_type: 'delegated_eoa',
        first_funder_kind: 'exchange',
        first_funder_claim_wallets: 1,
        group_size: 12,
        group_same_funder: 5,
        group_swept_to_shared_collector: true,
        group_links_made_by_wallet: true,
        shared_deposit_claimants: 3,
        funding_burst_wallets: 40,
        unreadable_facts: ['walletAgeDays', 'group'],
      },
      'partial',
      'A pattern only.',
    );
    expect(input).toContain(
      "wallet age unreadable; 1 transaction before the snapshot; normal account with delegated code; first funded by an exchange; its first funder funded no other wallets on this list; in a group of 12 linked wallets; the group shares funding; the group sweeps to a shared collector; this wallet itself made links to other listed wallets; its deposit address is used by 3 listed wallets; first funded in a burst of 40 wallets; unreadable facts: wallet age, linked group; the code's own starting decision: partial reward.",
    );
  });

  it.each([
    [1, 'its first funder funded no other wallets on this list'],
    [2, 'its first funder also funded 1 other wallet on this list'],
    [63, 'its first funder also funded 62 other wallets on this list'],
  ])('names the funder for a count of %i, never a bare "it"', (count, sentence) => {
    const input = reppoInput({ ...RECORD, first_funder_claim_wallets: count }, 'hold', 'Plain words.');
    expect(input).toContain(sentence);
    expect(input).not.toMatch(/\bit funded\b/i);
  });

  it('keeps the funder sentence plain when the funder is what ties the wallet to its group', () => {
    const input = reppoInput({ ...RECORD, first_funder_claim_wallets: 21, group_size: 21, group_same_funder: 21 }, 'hold', 'Plain words.');
    expect(input).toContain('its first funder funded 20 other wallets on this list; in a group of 21 linked wallets; the group shares funding');
    expect(input).not.toContain('also funded');
  });

  it('says the wallet made links only when it did', () => {
    const inGroup = { ...RECORD, group_size: 3, group_same_funder: null };
    const own = reppoInput({ ...inGroup, group_links_made_by_wallet: true }, 'hold', 'Plain words.');
    expect(own).toContain('; this wallet itself made links to other listed wallets;');

    const notOwn = reppoInput(inGroup, 'hold', 'Plain words.');
    expect(notOwn).toContain('; this wallet did not make the links;');
    expect(reppoInput(RECORD, 'hold', 'Plain words.')).not.toContain('made links');
    expect(notOwn).not.toContain('made links to other listed wallets');
  });

  it('tells the evaluators the group rule and the limit on holding a wallet heading to a reward', () => {
    const input = reppoInput(RECORD, 'hold', 'Plain words.');
    expect(input).toContain(
      'A group of five or more listed wallets funded together, or sweeping to a shared collector, is held for a person, and excluded when the wallet itself swept to that collector.',
    );
    expect(input).toContain(
      'A wallet heading to a reward is held only on a traced funding trail or a link it made itself, never on how many wallets its funder paid.',
    );
    expect(input.indexOf('never on how many wallets')).toBeLessThan(input.indexOf('Facts from public chain data'));
  });

  it('says plainly when a wallet has no funder on record', () => {
    expect(reppoInput({ ...RECORD, first_funder_kind: 'none', first_funder_claim_wallets: null }, 'hold', 'No funder.')).toContain(
      'normal account; no first funder on record; no group',
    );
  });

  it.each([
    ['checksummed', CHECKSUMMED],
    ['lowercase', LOWERCASE],
    ['truncated', '0xa9ac...4573'],
    ['truncated with an ellipsis', '0xa9ac…4573'],
  ])('sends no trace of an address written %s in the reason', (_name, form) => {
    const input = reppoInput(RECORD, 'hold', `The funder ${form} paid this wallet.`);
    expect(input).toContain('The funder [removed] paid this wallet.');
    expect(input).not.toMatch(/0x/i);
    expect(input).not.toContain('a9ac');
  });

  it.each([
    'A4: The group has no shared funding.',
    'A8 The group has no shared funding.',
    'Rule A8: The group has no shared funding.',
    'Under A3, the group has no shared funding.',
    'Retain the A8 partial outcome (B2). The group has no shared funding.',
    'The group has no shared funding, so retain partial under start rule A3.',
    'B1: The group has no shared funding (tx 0xa9ac1234).',
  ])('sends no rule code and no evidence hash for the reason "%s"', (reason) => {
    const input = reppoInput({ ...RECORD, start_rule: 'A5' }, 'hold', reason);
    expect(input).not.toMatch(RULE_CODE);
    expect(input).not.toContain(HASH);
    expect(input).not.toMatch(/0x/i);
    expect(input).toMatch(/the group has no shared funding/i);
  });

  it('throws rather than send a hex run still in the payload', () => {
    // No reason can reach this check, since stripIdentifiers takes out what it matches. A 16 digit count can.
    expect(() => reppoInput({ ...RECORD, tx_count: 1_234_567_890_123_456 }, 'hold', 'Plain words.')).toThrow(ReppoPayloadError);
  });

  it('refuses a record that does not match GraphRecord', () => {
    expect(() => reppoInput({ ...RECORD, wallet_age_days: -1 }, 'hold', 'Plain words.')).toThrow();
  });
});

// The `result` object of the real evaluation cmw5763r4000008le0b3liam7 on 6 Nov, field for field. The reason stops at the
// end of its first clause, and the long gates, explain and consensus arrays are cut to one entry each.
const REAL_RESULT = {
  gates: [{ floor: 50, severity: 'none', dimension: 'safety', failingWeight: 0, failingEvaluators: [] }],
  route: 'review',
  score: 66,
  reason:
    'The response was rejected because the score of 66 fell below the 70-point pass threshold, driven primarily by low instruction adherence (50) and completeness (50) scores.',
  explain: {
    route_reasons: ['score 66 < passAt 70 -> decision reject', 'score between rejectBelow 60 and acceptAt 85 -> review'],
    confidence_checks: [{ ok: true, check: 'enough evaluators', detail: '3 independent evaluators (want >= 3)' }],
  },
  decision: 'reject',
  trace_id: '7fc264ce-8678-40c8-b5ed-fac81a6637a0',
  consensus: { weighting: 'economic (net veREPPO)', economic_score: 66, equal_weight_score: 76 },
  task_type: 'response',
  confidence: 'low',
  rubric_scores: { safety: 100, completeness: 50, factual_accuracy: 68, instruction_adherence: 50 },
};

describe('parseVerdict', () => {
  it('reads the real reply and keeps only the five fields', () => {
    const verdict = parseVerdict(REAL_RESULT);
    expect(verdict).toEqual({
      score: 66,
      decision: 'reject',
      confidence: 'low',
      route: 'review',
      reason: REAL_RESULT.reason,
    });
    expect(Object.keys(verdict ?? {}).sort()).toEqual(['confidence', 'decision', 'reason', 'route', 'score']);
  });

  it.each([
    ['a score of 101', { ...REAL_RESULT, score: 101 }],
    ['a score of -1', { ...REAL_RESULT, score: -1 }],
    ['a score that is not whole', { ...REAL_RESULT, score: 66.5 }],
    ['an unknown route', { ...REAL_RESULT, route: 'hold' }],
    ['an unknown decision', { ...REAL_RESULT, decision: 'revise' }],
    ['an unknown confidence', { ...REAL_RESULT, confidence: 'certain' }],
    ['a missing reason', { ...REAL_RESULT, reason: undefined }],
    ['a reason that is not text', { ...REAL_RESULT, reason: 7 }],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'accept'],
    ['a number', 66],
    ['an array', [REAL_RESULT]],
  ])('refuses %s', (_name, raw) => {
    expect(parseVerdict(raw)).toBeNull();
  });

  it('strips control and format characters from the reason and cuts it to 2000', () => {
    expect(parseVerdict({ ...REAL_RESULT, reason: 'plain\u0000 te\u0007xt\u202e\n' })?.reason).toBe('plain text');
    expect(parseVerdict({ ...REAL_RESULT, reason: 'x'.repeat(5000) })?.reason).toHaveLength(2000);
  });

  it.each([
    ['markup and a markdown link', '<img src=x onerror=alert(1)> [claim](https://evil.example)'],
    ['a bare link', 'Read more at https://evil.example today.'],
    ['a link split by a format character', 'Read more at ht\u200btps://evil.example today.'],
  ])('stores a reason with %s as null and keeps the rest of the verdict (C35)', (_name, reason) => {
    expect(parseVerdict({ ...REAL_RESULT, reason })).toEqual({ score: 66, decision: 'reject', confidence: 'low', route: 'review', reason: null });
  });
});

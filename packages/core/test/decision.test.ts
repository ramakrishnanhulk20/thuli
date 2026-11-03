// Not covered here: real model replies (these are recorded bad and good outputs written by hand), and whether the
// reason's sentences are true.
import { describe, expect, it } from 'vitest';
import { validateDecision, type DecisionContext } from '../src/decision.ts';
import type { Facts } from '../src/facts.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';

const OWN_TX = `0x${'a1'.repeat(32)}`;
const OTHER_WALLET_TX = `0x${'b2'.repeat(32)}`;
const MADE_UP_TX = `0x${'c3'.repeat(32)}`;

function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    walletAgeDays: 12,
    txCountAtSnapshot: 2,
    accountType: 'eoa',
    firstFunder: null,
    group: null,
    sharedDepositAddress: null,
    claimPaidToOtherAddress: false,
    evidenceTxs: [OWN_TX],
    missing: [],
    ...overrides,
  };
}

const otherWalletFacts = facts({ evidenceTxs: [OTHER_WALLET_TX] });

function ctx(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return { facts: facts(), settings: DEFAULT_SETTINGS, ceiling: 'hold', toolTxs: [], ...overrides };
}

const VALID_HOLD = {
  action: 'hold',
  shareBps: 0,
  rule: 'A8',
  reason: 'Wallet is 12 days old with 2 transactions, under the 30 day and 5 transaction minimums.',
  citedTxs: [OWN_TX],
  paidHops: 0,
};

function reply(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...VALID_HOLD, ...overrides });
}

function expectRejected(result: ReturnType<typeof validateDecision>): void {
  expect(result.accepted).toBe(false);
  expect(result.decision.action).toBe('hold');
  expect(result.decision.shareBps).toBe(0);
  expect(result.decision.rule).toBe('A1');
  expect(result.cause).toBeTruthy();
}

describe('validateDecision: bad replies end in hold (C11, C13)', () => {
  it('rejects text that is not one JSON object', () => {
    expectRejected(validateDecision(`\`\`\`json\n${reply({})}\n\`\`\``, ctx()));
  });

  it('rejects a share of 1.5', () => {
    expectRejected(validateDecision(reply({ shareBps: 1.5 }), ctx()));
  });

  it('rejects a share that does not match the action', () => {
    expectRejected(validateDecision(reply({ action: 'full', shareBps: 5000 }), ctx({ ceiling: 'full' })));
  });

  it('rejects an unknown action', () => {
    expectRejected(validateDecision(reply({ action: 'maybe' }), ctx()));
  });

  it('rejects a made-up transaction hash', () => {
    expectRejected(validateDecision(reply({ citedTxs: [MADE_UP_TX] }), ctx()));
  });

  it("rejects a hash from another wallet's evidence", () => {
    expect(otherWalletFacts.evidenceTxs).toContain(OTHER_WALLET_TX);
    expectRejected(validateDecision(reply({ citedTxs: [OTHER_WALLET_TX] }), ctx()));
  });

  it('rejects a reason with a link or markup', () => {
    for (const reason of [
      'Funded by https://evil.example',
      'See www.evil.example for proof.',
      'Held <img src=x onerror=alert(1)>',
      'Proof [here](evil.example).',
      'Plain words \u001b[31mred',
    ]) {
      expectRejected(validateDecision(reply({ reason }), ctx()));
    }
  });

  it('rejects a reason over 280 characters', () => {
    expectRejected(validateDecision(reply({ reason: 'a'.repeat(281) }), ctx()));
  });

  it('rejects more paid hops than the settings allow', () => {
    expectRejected(validateDecision(reply({ paidHops: DEFAULT_SETTINGS.maxPaidHops + 1 }), ctx()));
  });
});

describe('validateDecision: answers that break the campaign or the run record end in hold', () => {
  it('rejects a paid lookup count that differs from the lookups made', () => {
    expectRejected(validateDecision(reply({ paidHops: 2 }), ctx({ paidHopsMade: 1 })));
  });

  it('rejects partial when the campaign has partial rewards switched off', () => {
    const settings = { ...DEFAULT_SETTINGS, allowPartial: false };
    const partial = reply({ action: 'partial', shareBps: settings.partialShareBps, rule: 'B2' });
    expectRejected(validateDecision(partial, ctx({ settings, ceiling: 'full' })));
  });
});

describe('validateDecision: exclude needs A3 evidence (C15)', () => {
  it('turns an exclude without the A3 group condition into hold', () => {
    expectRejected(validateDecision(reply({ action: 'exclude', rule: 'A3' }), ctx({ ceiling: 'exclude' })));
  });

  it('accepts an exclude when the self-linked group meets A3', () => {
    const farm = facts({
      group: { size: 8, sameFunderWithinWindow: 8, sweptToSharedCollector: true, authoredEvidence: true },
    });
    const result = validateDecision(reply({ action: 'exclude', rule: 'A3' }), ctx({ facts: farm, ceiling: 'exclude' }));
    expect(result.accepted).toBe(true);
    expect(result.decision.action).toBe('exclude');
  });
});

describe('validateDecision: the ceiling wins (C12)', () => {
  it("clamps a 'full' answer under a 'partial' ceiling and recomputes the share", () => {
    const result = validateDecision(reply({ action: 'full', shareBps: 10000, rule: 'A9' }), ctx({ ceiling: 'partial' }));
    expect(result.accepted).toBe(true);
    expect(result.decision.action).toBe('partial');
    expect(result.decision.clampedFrom).toBe('full');
    expect(result.decision.shareBps).toBe(DEFAULT_SETTINGS.partialShareBps);
    expect(result.decision.rule).toBe('A9');
  });

  it("accepts a valid 'hold', matching cited hashes in any letter case", () => {
    const result = validateDecision(reply({ citedTxs: [`0x${OWN_TX.slice(2).toUpperCase()}`] }), ctx());
    expect(result.accepted).toBe(true);
    expect(result.cause).toBeUndefined();
    expect(result.decision.action).toBe('hold');
    expect(result.decision.clampedFrom).toBeUndefined();
  });
});

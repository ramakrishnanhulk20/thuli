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
    fundingBurst: null,
    claimPaidToOtherAddress: false,
    evidenceTxs: [OWN_TX],
    missing: [],
    ...overrides,
  };
}

const otherWalletFacts = facts({ evidenceTxs: [OTHER_WALLET_TX] });

function ctx(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    facts: facts(),
    settings: DEFAULT_SETTINGS,
    ceiling: 'hold',
    start: { outcome: 'hold', rule: 'A8' },
    toolTxs: [],
    ...overrides,
  };
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
    const context = ctx({ settings, ceiling: 'full', start: { outcome: 'hold', rule: 'A4' } });
    expectRejected(validateDecision(partial, context));
  });
});

describe('validateDecision: exclude needs A3 evidence (C15)', () => {
  const excludeStart = { outcome: 'exclude', rule: 'A3' } as const;

  it('turns an exclude without the A3 group condition into hold', () => {
    const exclude = reply({ action: 'exclude', rule: 'A3' });
    expectRejected(validateDecision(exclude, ctx({ ceiling: 'exclude', start: excludeStart })));
  });

  it('accepts an exclude when the self-linked group meets A3', () => {
    const farm = facts({
      group: { size: 8, sameFunderWithinWindow: 8, sweptToSharedCollector: true, authoredEvidence: true, linkedByWallet: true },
    });
    const exclude = reply({ action: 'exclude', rule: 'A3' });
    const result = validateDecision(exclude, ctx({ facts: farm, ceiling: 'exclude', start: excludeStart }));
    expect(result.accepted).toBe(true);
    expect(result.decision.action).toBe('exclude');
  });
});

describe('validateDecision: the ceiling wins (C12)', () => {
  it("clamps a 'full' answer under a 'partial' ceiling and recomputes the share", () => {
    const full = reply({ action: 'full', shareBps: 10000, rule: 'A9' });
    const result = validateDecision(full, ctx({ ceiling: 'partial', start: { outcome: 'full', rule: 'A9' } }));
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

describe('validateDecision: a funding burst keeps a wallet at partial (C45)', () => {
  const BURST_WALLET = facts({ walletAgeDays: 400, txCountAtSnapshot: 120, fundingBurst: { wallets: 23 } });
  const BURST_CTX = ctx({ facts: BURST_WALLET, ceiling: 'partial', start: { outcome: 'partial', rule: 'A8' } });
  const NAMES_BURST = 'First funded in a Funding Burst of 23 wallets, so partial.';
  const PARTIAL_A8 = { action: 'partial', shareBps: DEFAULT_SETTINGS.partialShareBps, rule: 'A8', reason: NAMES_BURST };
  const HOLD = { action: 'hold', shareBps: 0, reason: NAMES_BURST };

  it.each([
    ['hold under B1', { ...HOLD, rule: 'B1' }, 'hold'],
    ['hold under A8', { ...HOLD, rule: 'A8' }, 'hold'],
    ['full under A9', { action: 'full', shareBps: 10000, rule: 'A9', reason: NAMES_BURST }, 'full'],
    ['exclude under A3', { action: 'exclude', shareBps: 0, rule: 'A3', reason: NAMES_BURST }, 'exclude'],
    ['partial under B2', { ...PARTIAL_A8, rule: 'B2' }, undefined],
    ['partial under A8 with the burst left out of the reason', { ...PARTIAL_A8, reason: 'Old and active wallet.' }, undefined],
  ])('replaces %s with the start and a code-written reason', (_case, overrides, clampedFrom) => {
    const result = validateDecision(reply(overrides), BURST_CTX);
    expect(result.accepted).toBe(false);
    expect(result.cause).toBe('a funding burst keeps this wallet at partial');
    expect(result.decision).toEqual({
      action: 'partial',
      shareBps: 5000,
      rule: 'A8',
      reason:
        'First funded in a burst of 23 wallets from one exchange on one day in near-equal amounts. A funding pattern alone does not prove one owner, so the reward is partial.',
      citedTxs: [],
      paidHops: 0,
      ...(clampedFrom === undefined ? {} : { clampedFrom }),
    });
    expect('clampedFrom' in result.decision).toBe(clampedFrom !== undefined);
  });

  it('reports the paid lookups the worker made, not the model count', () => {
    const result = validateDecision(reply({ ...HOLD, rule: 'B1', paidHops: 3 }), { ...BURST_CTX, paidHopsMade: 2 });
    expect(result.decision).toMatchObject({ action: 'partial', paidHops: 2 });
  });

  it('accepts partial under A8 that names the burst, in any letter case, and keeps the model reason', () => {
    const result = validateDecision(reply(PARTIAL_A8), BURST_CTX);
    expect(result.accepted).toBe(true);
    expect(result.cause).toBeUndefined();
    expect(result.decision).toMatchObject({ action: 'partial', rule: 'A8', reason: NAMES_BURST });
  });

  it('still ends a reply that does not parse in hold (C11)', () => {
    expectRejected(validateDecision('not json', BURST_CTX));
  });

  it('still runs every other check on a reply that passes the guard (C13)', () => {
    expectRejected(validateDecision(reply({ ...PARTIAL_A8, reason: `A funding burst. ${'a'.repeat(280)}` }), BURST_CTX));
  });

  it('leaves a wallet with no burst, or one under the minimum, free to be held under B1', () => {
    for (const wallet of [facts(), facts({ fundingBurst: { wallets: 19 } })]) {
      const context = ctx({ facts: wallet, ceiling: 'partial', start: { outcome: 'partial', rule: 'A8' } });
      const result = validateDecision(reply({ ...HOLD, rule: 'B1' }), context);
      expect(result.accepted).toBe(true);
      expect(result.decision).toMatchObject({ action: 'hold', rule: 'B1', reason: NAMES_BURST });
    }
  });

  it('never pays above the ceiling: with a hold ceiling the normal checks decide (C12)', () => {
    const context = { ...BURST_CTX, ceiling: 'hold' as const };
    const held = validateDecision(reply({ ...HOLD, rule: 'B1' }), context);
    expect(held.accepted).toBe(true);
    expect(held.decision).toMatchObject({ action: 'hold', shareBps: 0, rule: 'B1', reason: NAMES_BURST });

    for (const overrides of [PARTIAL_A8, { ...PARTIAL_A8, rule: 'B2' }, { ...HOLD, rule: 'A8' }, { action: 'full', shareBps: 10000, rule: 'A9' }]) {
      const result = validateDecision(reply(overrides), context);
      expect(result.decision.action, JSON.stringify(overrides)).toBe('hold');
      expect(result.decision.shareBps, JSON.stringify(overrides)).toBe(0);
    }
  });

  it('does not run when partial is off, because the start is then a hold', () => {
    const context = ctx({
      facts: BURST_WALLET,
      settings: { ...DEFAULT_SETTINGS, allowPartial: false },
      ceiling: 'hold',
      start: { outcome: 'hold', rule: 'A8' },
    });
    const result = validateDecision(reply({ reason: 'Held because partial is off.' }), context);
    expect(result.accepted).toBe(true);
    expect(result.decision).toMatchObject({ action: 'hold', rule: 'A8', reason: 'Held because partial is off.' });
  });
});

describe('validateDecision: the rule must fit the code start', () => {
  const CHANGED_START = 'the model changed the fixed-check result without using rule B1 or B2';
  const B1_MISPLACED = 'the model used rule B1 outside a funder check that ends in hold';
  const B2_MISPLACED = 'the model used rule B2 outside a group, shared funder or shared deposit hold';
  const FULL = { action: 'full', shareBps: 10000 };
  const PARTIAL = { action: 'partial', shareBps: DEFAULT_SETTINGS.partialShareBps };

  // Asserting the cause proves the start check fired, not some earlier check that happened to reject the reply too.
  function expectRejectedFor(result: ReturnType<typeof validateDecision>, cause: string): void {
    expectRejected(result);
    expect(result.cause).toBe(cause);
  }

  it("rejects a fixed rule other than the start's rule", () => {
    expectRejectedFor(validateDecision(reply({ rule: 'A7' }), ctx()), CHANGED_START);
  });

  it("rejects the start's rule with a different action", () => {
    const context = ctx({ ceiling: 'partial', start: { outcome: 'partial', rule: 'A8' } });
    expectRejectedFor(validateDecision(reply({ ...FULL, rule: 'A8' }), context), CHANGED_START);
  });

  it("rejects B1 under an A9 start with action 'partial'", () => {
    const context = ctx({ ceiling: 'full', start: { outcome: 'full', rule: 'A9' } });
    expectRejectedFor(validateDecision(reply({ ...PARTIAL, rule: 'B1' }), context), B1_MISPLACED);
  });

  it('rejects B1 under an A4 start', () => {
    const context = ctx({ start: { outcome: 'hold', rule: 'A4' } });
    expectRejectedFor(validateDecision(reply({ rule: 'B1' }), context), B1_MISPLACED);
  });

  it('rejects B2 under an A8 start', () => {
    const context = ctx({ ceiling: 'full', start: { outcome: 'partial', rule: 'A8' } });
    expectRejectedFor(validateDecision(reply({ ...FULL, rule: 'B2' }), context), B2_MISPLACED);
  });

  it("accepts B2 raising an A4 hold to 'full' under a 'full' ceiling", () => {
    const context = ctx({ ceiling: 'full', start: { outcome: 'hold', rule: 'A4' } });
    const result = validateDecision(reply({ ...FULL, rule: 'B2' }), context);
    expect(result.accepted).toBe(true);
    expect(result.cause).toBeUndefined();
    expect(result.decision.action).toBe('full');
    expect(result.decision.rule).toBe('B2');
    expect(result.decision.clampedFrom).toBeUndefined();
  });

  it('accepts B1 holding an A9 start', () => {
    const context = ctx({ ceiling: 'full', start: { outcome: 'full', rule: 'A9' } });
    const result = validateDecision(reply({ rule: 'B1' }), context);
    expect(result.accepted).toBe(true);
    expect(result.cause).toBeUndefined();
    expect(result.decision.action).toBe('hold');
    expect(result.decision.rule).toBe('B1');
  });
});

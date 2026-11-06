// Not covered here: whether the facts themselves are right (that is the facts collector's job), and what the model
// does under each ceiling (decision.test.ts covers clamping).
import { describe, expect, it } from 'vitest';
import { computeCeiling } from '../src/ceiling.ts';
import type { Facts } from '../src/facts.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';

function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    walletAgeDays: 400,
    txCountAtSnapshot: 120,
    accountType: 'eoa',
    firstFunder: null,
    group: null,
    sharedDepositAddress: null,
    fundingBurst: null,
    claimPaidToOtherAddress: false,
    evidenceTxs: [],
    missing: [],
    ...overrides,
  };
}

const FARM_GROUP = { size: 8, sameFunderWithinWindow: 8, sweptToSharedCollector: true, authoredEvidence: true };

describe('computeCeiling', () => {
  it('holds when age, tx count or account type is unreadable, or the account is a contract', () => {
    for (const f of [
      facts({ walletAgeDays: null }),
      facts({ txCountAtSnapshot: null }),
      facts({ accountType: 'unknown' }),
      facts({ accountType: 'contract' }),
    ]) {
      expect(computeCeiling(f, DEFAULT_SETTINGS).ceiling).toBe('hold');
    }
  });

  it('allows exclude only for a self-linked group that meets the A3 condition', () => {
    expect(computeCeiling(facts({ group: FARM_GROUP }), DEFAULT_SETTINGS).ceiling).toBe('exclude');
  });

  it('holds when the claim was paid to another address', () => {
    expect(computeCeiling(facts({ claimPaidToOtherAddress: true }), DEFAULT_SETTINGS).ceiling).toBe('hold');
  });

  it('holds when a link fact is missing', () => {
    for (const name of ['group', 'sharedDepositAddress', 'claimPaidToOtherAddress', 'firstFunder'] as const) {
      expect(computeCeiling(facts({ missing: [name] }), DEFAULT_SETTINGS).ceiling, name).toBe('hold');
    }
  });

  it('caps a new wallet at partial, or hold when partial is off', () => {
    expect(computeCeiling(facts({ walletAgeDays: 3 }), DEFAULT_SETTINGS).ceiling).toBe('partial');
    expect(computeCeiling(facts({ txCountAtSnapshot: 1 }), DEFAULT_SETTINGS).ceiling).toBe('partial');
    expect(computeCeiling(facts({ walletAgeDays: 3 }), { ...DEFAULT_SETTINGS, allowPartial: false }).ceiling).toBe('hold');
  });

  it('caps a burst wallet at partial with the true reason, or hold when partial is off (C45)', () => {
    const burst = facts({ fundingBurst: { wallets: 20 } });
    expect(computeCeiling(burst, DEFAULT_SETTINGS)).toEqual({
      ceiling: 'partial',
      reason: 'Wallet was first funded in an exchange funding burst, so at most partial.',
    });
    expect(computeCeiling(burst, { ...DEFAULT_SETTINGS, allowPartial: false })).toEqual({
      ceiling: 'hold',
      reason: 'Wallet was first funded in an exchange funding burst and partial is off.',
    });
  });

  it('gives a new wallet its own reason, byte for byte, and ignores a burst under the minimum', () => {
    expect(computeCeiling(facts({ walletAgeDays: 3 }), DEFAULT_SETTINGS)).toEqual({
      ceiling: 'partial',
      reason: 'Wallet is newer or less active than the project minimum, so at most partial.',
    });
    expect(computeCeiling(facts({ txCountAtSnapshot: 1 }), { ...DEFAULT_SETTINGS, allowPartial: false })).toEqual({
      ceiling: 'hold',
      reason: 'Wallet is newer or less active than the project minimum and partial is off.',
    });
    expect(computeCeiling(facts({ fundingBurst: { wallets: 19 } }), DEFAULT_SETTINGS)).toEqual({
      ceiling: 'full',
      reason: 'No code check limits this wallet.',
    });
  });

  it('allows full when no check limits the wallet', () => {
    expect(computeCeiling(facts(), DEFAULT_SETTINGS).ceiling).toBe('full');
  });
});

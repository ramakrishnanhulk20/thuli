// Not covered here: whether the facts themselves are right (that is the facts collector's job), and how the model may
// move the start with rule B1 or B2 (decision.test.ts covers that).
import { describe, expect, it } from 'vitest';
import { parseAddress } from '../src/address.ts';
import { computeCeiling } from '../src/ceiling.ts';
import { FACT_NAMES, FUNDER_KINDS, type Facts } from '../src/facts.ts';
import { leastGenerous } from '../src/outcome.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { computeStart } from '../src/start.ts';

const PARTIAL_OFF = { ...DEFAULT_SETTINGS, allowPartial: false };
const FUNDER = parseAddress(`0x${'11'.repeat(20)}`);
const FANOUT_MIN = DEFAULT_SETTINGS.funderFanoutMin;

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

function fundedBy(kind: (typeof FUNDER_KINDS)[number], fanoutInList: number | null): Facts {
  return facts({ firstFunder: { address: FUNDER, kind, fanoutInList, hopsTraced: 1 } });
}

const FARM_GROUP = { size: 8, sameFunderWithinWindow: 8, sweptToSharedCollector: true, authoredEvidence: true, linkedByWallet: true };
// Big enough to count, but not linked by this wallet's own transactions, so A3 cannot exclude it and A4 holds it.
const UNPROVEN_GROUP = {
  size: DEFAULT_SETTINGS.groupMinSize,
  sameFunderWithinWindow: null,
  sweptToSharedCollector: true,
  authoredEvidence: false,
  linkedByWallet: false,
};

const UNREADABLE = [
  facts({ walletAgeDays: null }),
  facts({ txCountAtSnapshot: null }),
  facts({ accountType: 'unknown' }),
  facts({ claimPaidToOtherAddress: null }),
  ...FACT_NAMES.filter((name) => name !== 'evidenceTxs').map((name) => facts({ missing: [name] })),
  facts({ missing: ['evidenceTxs', 'group'] }),
];
const CONTRACT = facts({ accountType: 'contract' });
const FARM = facts({ group: FARM_GROUP });
const GROUP_AT_MIN = facts({ group: UNPROVEN_GROUP });
const GROUP_BELOW_MIN = facts({ group: { ...UNPROVEN_GROUP, size: DEFAULT_SETTINGS.groupMinSize - 1 } });
const FANOUT_HOLDS = [fundedBy('wallet', FANOUT_MIN), fundedBy('unknown', FANOUT_MIN)];
const FANOUT_IGNORED = [
  ...FUNDER_KINDS.filter((kind) => kind !== 'wallet' && kind !== 'unknown').map((kind) => fundedBy(kind, 50)),
  fundedBy('wallet', FANOUT_MIN - 1),
];
const FANOUT_UNCOUNTED = fundedBy('wallet', null);
const SHARED_DEPOSIT = facts({ sharedDepositAddress: { sharedWithClaimants: 2 } });
const OWN_DEPOSIT = facts({ sharedDepositAddress: { sharedWithClaimants: 1 } });
const PAID_ELSEWHERE = facts({ claimPaidToOtherAddress: true });
const NEW_OR_QUIET = [facts({ walletAgeDays: 3 }), facts({ txCountAtSnapshot: 1 })];
const CLEAN = facts();
const EVIDENCE_MISSING = facts({ missing: ['evidenceTxs'] });

const ALL_FIXTURES = [
  ...UNREADABLE,
  CONTRACT,
  FARM,
  GROUP_AT_MIN,
  GROUP_BELOW_MIN,
  ...FANOUT_HOLDS,
  ...FANOUT_IGNORED,
  FANOUT_UNCOUNTED,
  SHARED_DEPOSIT,
  OWN_DEPOSIT,
  PAID_ELSEWHERE,
  ...NEW_OR_QUIET,
  CLEAN,
  EVIDENCE_MISSING,
];

describe('computeStart', () => {
  it('A1 holds when age, tx count, account type or claim address is unreadable, or a fact is missing', () => {
    for (const f of UNREADABLE) {
      expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A1' });
    }
  });

  it('A2 holds a contract account', () => {
    expect(computeStart(CONTRACT, DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A2' });
  });

  it('A3 excludes a self-linked group that meets the group rule', () => {
    expect(computeStart(FARM, DEFAULT_SETTINGS)).toEqual({ outcome: 'exclude', rule: 'A3' });
  });

  it('A4 holds a group of at least the minimum size that the wallet did not link itself', () => {
    expect(computeStart(GROUP_AT_MIN, DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A4' });
    expect(computeStart(GROUP_BELOW_MIN, DEFAULT_SETTINGS).rule).toBe('A9');
  });

  it('A5 holds a wallet or unknown funder that funded at least the fan-out minimum in the list', () => {
    for (const f of FANOUT_HOLDS) {
      expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A5' });
    }
    for (const f of FANOUT_IGNORED) {
      expect(computeStart(f, DEFAULT_SETTINGS).rule).toBe('A9');
    }
  });

  it('A5 does not fire when the fan-out count is unknown', () => {
    expect(computeStart(FANOUT_UNCOUNTED, DEFAULT_SETTINGS)).toEqual({ outcome: 'full', rule: 'A9' });
  });

  it('A6 holds a deposit address shared with at least one other claimant', () => {
    expect(computeStart(SHARED_DEPOSIT, DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A6' });
    expect(computeStart(OWN_DEPOSIT, DEFAULT_SETTINGS).rule).toBe('A9');
  });

  it('A7 holds a claim paid to another address', () => {
    expect(computeStart(PAID_ELSEWHERE, DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A7' });
  });

  it('A8 starts a new or quiet wallet at partial, or hold when partial is off', () => {
    for (const f of NEW_OR_QUIET) {
      expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'partial', rule: 'A8' });
      expect(computeStart(f, PARTIAL_OFF)).toEqual({ outcome: 'hold', rule: 'A8' });
    }
  });

  it('A8 starts an old active wallet in a funding burst at partial, or hold when partial is off (C45)', () => {
    const burst = facts({ fundingBurst: { wallets: 20 } });
    expect(computeStart(burst, DEFAULT_SETTINGS)).toEqual({ outcome: 'partial', rule: 'A8' });
    expect(computeStart(burst, PARTIAL_OFF)).toEqual({ outcome: 'hold', rule: 'A8' });
  });

  it('keeps A3 and A4 ahead of a funding burst, and ignores a burst under the minimum', () => {
    const fundingBurst = { wallets: 20 };
    expect(computeStart(facts({ group: FARM_GROUP, fundingBurst }), DEFAULT_SETTINGS)).toEqual({ outcome: 'exclude', rule: 'A3' });
    expect(computeStart(facts({ group: UNPROVEN_GROUP, fundingBurst }), DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A4' });
    expect(computeStart(facts({ fundingBurst: { wallets: 19 } }), DEFAULT_SETTINGS)).toEqual({ outcome: 'full', rule: 'A9' });
  });

  it('A9 starts at full when no fixed check applies', () => {
    expect(computeStart(CLEAN, DEFAULT_SETTINGS)).toEqual({ outcome: 'full', rule: 'A9' });
  });

  it('does not trigger A1 when only the evidence list is missing', () => {
    expect(computeStart(EVIDENCE_MISSING, DEFAULT_SETTINGS)).toEqual({ outcome: 'full', rule: 'A9' });
  });

  it('never starts a fixture in this file more generous than the code ceiling', () => {
    for (const f of ALL_FIXTURES) {
      for (const settings of [DEFAULT_SETTINGS, PARTIAL_OFF]) {
        const start = computeStart(f, settings).outcome;
        expect(leastGenerous(start, computeCeiling(f, settings).ceiling), JSON.stringify(f)).toBe(start);
      }
    }
  });

  it('holds, never excludes, a proven farm group when another fact is unread', () => {
    for (const f of [facts({ group: FARM_GROUP, claimPaidToOtherAddress: null }), facts({ group: FARM_GROUP, missing: ['firstFunder'] })]) {
      expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A1' });
      expect(computeCeiling(f, DEFAULT_SETTINGS).ceiling).toBe('hold');
    }
  });

  // 58,320 combinations; before the ceiling checked unread facts first, 1,584 of the first 29,160 started at hold under
  // an exclude ceiling. A burst may only ever move an A9 start to A8 (C45).
  it('never starts more generous than the code ceiling across a grid of every fact combination', () => {
    const funders = [null, fundedBy('wallet', FANOUT_MIN).firstFunder, FANOUT_UNCOUNTED.firstFunder];
    const groups = [null, FARM_GROUP, UNPROVEN_GROUP];
    const missings: Facts['missing'][] = [[], ['evidenceTxs'], ['group'], ['walletAgeDays'], ['claimPaidToOtherAddress']];
    let checked = 0;
    for (const walletAgeDays of [null, 3, 400])
      for (const txCountAtSnapshot of [null, 1, 120])
        for (const accountType of ['eoa', 'contract', 'delegated_eoa', 'unknown'] as const)
          for (const firstFunder of funders)
            for (const group of groups)
              for (const sharedDepositAddress of [null, { sharedWithClaimants: 1 }, { sharedWithClaimants: 2 }])
                for (const claimPaidToOtherAddress of [null, false, true])
                  for (const missing of missings)
                    for (const fundingBurst of [null, { wallets: 20 }])
                      for (const settings of [DEFAULT_SETTINGS, PARTIAL_OFF]) {
                        const f = facts({
                          walletAgeDays,
                          txCountAtSnapshot,
                          accountType,
                          firstFunder,
                          group,
                          sharedDepositAddress,
                          fundingBurst,
                          claimPaidToOtherAddress,
                          missing,
                        });
                        const fixed = computeStart(f, settings);
                        const start = fixed.outcome;
                        if (leastGenerous(start, computeCeiling(f, settings).ceiling) !== start) {
                          expect.fail(`start ${start} is above the ceiling for ${JSON.stringify(f)}`);
                        }
                        const unburst = computeStart({ ...f, fundingBurst: null }, settings);
                        const allowed = unburst.rule === 'A9' && fundingBurst !== null ? 'A8' : unburst.rule;
                        if (fixed.rule !== allowed) expect.fail(`a burst moved the start to ${fixed.rule} for ${JSON.stringify(f)}`);
                        checked += 1;
                      }
    expect(checked).toBe(58_320);
  });
});

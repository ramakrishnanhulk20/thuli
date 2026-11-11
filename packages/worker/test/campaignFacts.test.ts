// Not covered here: reading a wallet's own facts or its funder's state from the chain (single.test.ts, basic.test.ts and
// the rehearsal), linking by anything but first funders (sweeps, shared deposits and bursts are listed as not checked),
// and families built across several asks, a funder that also asks and chains of fundings, which campaignWorker.test.ts
// screens through the store.
import { describe, expect, it } from 'vitest';
import {
  computeCeiling,
  computeStart,
  DEFAULT_SETTINGS,
  meetsGroupExcludeRule,
  parseAddress,
  validateDecision,
  type Facts,
  type Settings,
} from '@thuli/core';
import type { FunderLink } from '@thuli/store';
import { askFactsOf, CAMPAIGN_NOT_CHECKED, campaignFacts as linkFacts, campaignSettings } from '../src/campaign/facts.ts';

const FUNDER = parseAddress(`0x${'f1'.repeat(20)}`);
const HASH = `0x${'ab'.repeat(32)}`;
const DECIDED_AT = new Date('2026-11-11T12:00:00.000Z');
const wallet = (n: number) => parseAddress(`0x${n.toString(16).padStart(40, '0')}`);
// The asking wallet itself, beside the numbered wallets the links name.
const ASKER = parseAddress(`0x${'a5'.repeat(20)}`);
const campaignFacts = (single: Facts, links: FunderLink[], settings: Settings) => linkFacts(ASKER, single, { links, askers: [] }, settings);

// What the single-wallet screening reads for an old, active wallet once inSingleScope has taken it in scope.
const SINGLE: Facts = {
  walletAgeDays: 400,
  txCountAtSnapshot: 50,
  accountType: 'eoa',
  firstFunder: { address: FUNDER, kind: 'unknown', fanoutInList: null, hopsTraced: 1 },
  group: null,
  sharedDepositAddress: null,
  fundingBurst: null,
  claimPaidToOtherAddress: false,
  evidenceTxs: [HASH],
  missing: [],
};
const DEMO: Settings = { ...DEFAULT_SETTINGS, groupMinSize: 2, funderFanoutMin: 2 };

const link = (n: number, funderAddress: string, funderKind = 'unknown'): FunderLink => ({
  wallet: wallet(n),
  funderAddress: funderAddress as FunderLink['funderAddress'],
  funderKind,
  decidedAt: DECIDED_AT,
});

describe('campaignFacts', () => {
  it('gives a lone wallet a fan-out of 1 and no group, passes every other fact through and lists what it cannot check', () => {
    const { facts, notChecked } = campaignFacts(SINGLE, [link(1, `0x${'e2'.repeat(20)}`)], DEMO);
    expect(facts).toEqual({ ...SINGLE, firstFunder: { ...SINGLE.firstFunder, fanoutInList: 1 } });
    expect(notChecked).toEqual(['sharedDepositAddress', 'sweptToSharedCollector', 'claimPaidToOtherAddress', 'fundingBurst', 'passThroughFunding']);
    expect(notChecked).toEqual([...CAMPAIGN_NOT_CHECKED]);
    expect(computeStart(facts, DEMO)).toEqual({ outcome: 'full', rule: 'A9' });
  });

  it('counts one funder in any spelling as one funder, and a wallet listed twice once (C1)', () => {
    const links = [link(1, FUNDER.toLowerCase()), link(2, FUNDER), link(1, `0x${FUNDER.slice(2).toUpperCase()}`)];
    const { facts } = campaignFacts({ ...SINGLE, firstFunder: { ...SINGLE.firstFunder!, address: FUNDER } }, links, DEMO);
    expect(facts.firstFunder?.fanoutInList).toBe(3);
    expect(facts.group?.size).toBe(3);
  });

  it('gives a funding-only group that the start rules hold and that can never exclude, even when the model asks (C15)', () => {
    const { facts } = campaignFacts(SINGLE, [link(1, FUNDER)], DEMO);
    expect(facts.group).toEqual({
      size: 2,
      sameFunderWithinWindow: null,
      sweptToSharedCollector: false,
      authoredEvidence: false,
      linkedByWallet: false,
    });
    const start = computeStart(facts, DEMO);
    expect(start).toEqual({ outcome: 'hold', rule: 'A4' });
    expect(meetsGroupExcludeRule(facts, DEMO)).toBe(false);
    const { ceiling } = computeCeiling(facts, DEMO);
    expect(ceiling).not.toBe('exclude');
    const reply = { action: 'exclude', shareBps: 0, rule: 'A4', reason: 'One funder paid two asking wallets.', citedTxs: [], paidHops: 0 };
    const checked = validateDecision(reply, { facts, settings: DEMO, ceiling, start, toolTxs: [] });
    expect(checked.decision.action).toBe('hold');

    // Below the group size but at the fan-out minimum, the shared funder alone holds it under A5.
    const fanoutOnly = { ...DEFAULT_SETTINGS, funderFanoutMin: 2 };
    expect(computeStart(campaignFacts(SINGLE, [link(1, FUNDER)], fanoutOnly).facts, fanoutOnly)).toEqual({ outcome: 'hold', rule: 'A5' });
  });

  it('links none of 10 asks that share one exchange funder, nor asks that share a contract (C16)', () => {
    for (const kind of ['exchange', 'contract', 'bridge'] as const) {
      const shared: Facts = { ...SINGLE, firstFunder: { address: FUNDER, kind, fanoutInList: null, hopsTraced: 0 } };
      const asks = Array.from({ length: 10 }, (_, n) => n + 1);
      for (const n of asks) {
        const others = asks.filter((other) => other !== n).map((other) => link(other, FUNDER, kind));
        const { facts } = campaignFacts(shared, others, DEMO);
        expect(facts.group).toBeNull();
        expect(facts.firstFunder).toEqual(shared.firstFunder);
        expect(computeStart(facts, DEMO)).toEqual({ outcome: 'full', rule: 'A9' });
      }
    }
  });

  it('fails a link that is not an address instead of counting one wallet fewer', () => {
    expect(() => campaignFacts(SINGLE, [link(1, 'not an address')], DEMO)).toThrow();
  });
});

describe('campaignSettings', () => {
  it('starts from the defaults, applies only what the campaign changes, and always takes the row partial share', () => {
    expect(campaignSettings({ partialShareBps: 4000 })).toEqual({ ...DEFAULT_SETTINGS, partialShareBps: 4000 });
    expect(campaignSettings({ partialShareBps: 4000, settings: null })).toEqual({ ...DEFAULT_SETTINGS, partialShareBps: 4000 });
    expect(campaignSettings({ partialShareBps: 5000, settings: { groupMinSize: 2, funderFanoutMin: 2 } })).toEqual(DEMO);
  });

  it('refuses a setting that is unknown or out of range', () => {
    expect(() => campaignSettings({ partialShareBps: 5000, settings: { groupMinSize: 1 } })).toThrow();
    expect(() => campaignSettings({ partialShareBps: 5000, settings: { cheap: true } as Partial<Settings> })).toThrow();
  });
});

describe('askFactsOf', () => {
  it('writes the facts in the store field names, with the canonical funder and the chain they were read on', () => {
    const { facts } = campaignFacts(SINGLE, [link(1, FUNDER.toLowerCase())], DEMO);
    const written = {
      ageDays: 400,
      txCount: 50,
      accountType: 'eoa',
      funder: { address: FUNDER, kind: 'unknown', fanout: 2, hops: 1 },
      burstWallets: null,
      groupSize: 2,
      missing: [],
    };
    expect(askFactsOf(facts, 'base')).toEqual({ ...written, chain: 'base' });
    expect(askFactsOf(facts, 'ethereum')).toEqual({ ...written, chain: 'ethereum' });
    expect(askFactsOf(facts)).toEqual({ ...written, chain: 'ethereum' });
  });
});

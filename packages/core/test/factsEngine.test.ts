// Not covered here: reading transfers, nonces and code from the chain (the worker's chain readers do that), whether
// these fixtures still match a fresh read of mainnet (the replay run shows that), and how the model moves a start.
import { keccak256, parseEther, toHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { parseAddress } from '../src/address.ts';
import { Facts } from '../src/facts.ts';
import {
  buildReplayFacts,
  funderKind,
  fundingTransfer,
  HIGH_VOLUME_NONCE,
  isPassThrough,
  PASS_THROUGH_MAX_BLOCKS,
  sharedDestinations,
  traceFunding,
  type AccountState,
  type AddressData,
  type ReplayInput,
  type Transfer,
} from '../src/factsEngine.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { computeStart } from '../src/start.ts';

// The live ROBO chain from 3 Nov: 0x8439 funded 19 fresh wallets, and one of them reached claim wallet 0x041f through
// three single-use wallets.
const ROOT_FUNDER = '0xf81b45b1663b7ea8716c74796d99bbe4ea26f488';
const LOOK_ALIKE = '0xf81baad0224255d7ca5c16acaaab692f6e53f488';
const ROOT = '0x8439895979b4060e20839d6d8bceda2d786e2401';
const HOP_1 = '0x6e4a01561816439d269be9058ec2aa74a293d09c';
const HOP_2 = '0xb8f425dc4223ddb5d88f71d2dc24dccac70bf2af';
const HOP_3 = '0x02dd2aee26986d6b86fb2bfb98e105cd1a661fdb';
const FARM_WALLET = '0x041f77015fe51c51ae49a7f2f3ff86c641fa190a';
const FARM_WALLET_FUNDING_TX = '0xf5d6490c5f3c18c05e6c791e9f22ec0a8341bea2a1fb035e6caba2b3b8afd806';
const BINANCE_14 = '0x28c6c06298d514db089934071355e5743bf21d60';

// Timestamps are synthetic at 12 seconds a block; only the gaps between them matter here.
const ANCHOR_BLOCK = 24_511_003;
const DAY_BLOCKS = 7_200;
const OLD_BLOCK = ANCHOR_BLOCK - 400 * DAY_BLOCKS;
const timeOf = (block: number) => 1_771_400_000 + (block - ANCHOR_BLOCK) * 12;
const SNAPSHOT_TIME = timeOf(24_600_000);

const synthetic = (tag: string, index: number) => `0x${tag}${index.toString(16).padStart(40 - tag.length, '0')}`;
const STRANGER = synthetic('5e', 1);
const COLLECTOR = synthetic('c0', 1);
const DEPOSIT = synthetic('de', 1);

function send(from: string, to: string, block: number, eth: string, kind: Transfer['kind'] = 'external'): Transfer {
  return {
    hash: keccak256(toHex(`${from}>${to}@${block}:${eth}`)),
    block,
    time: timeOf(block),
    from,
    to,
    valueWei: parseEther(eth).toString(),
    failed: false,
    kind,
  };
}

function dataFor(address: string, ledger: Transfer[], complete = true): AddressData {
  const touching = ledger.filter((t) => t.from === address || t.to === address).sort((a, b) => a.block - b.block);
  return {
    external: { transfers: touching.filter((t) => t.kind === 'external'), complete },
    internal: { transfers: touching.filter((t) => t.kind === 'internal'), complete: true },
  };
}

function lookupFrom(ledger: Transfer[], options: { absent?: string[]; incomplete?: string[] } = {}) {
  return (address: string): AddressData | undefined =>
    options.absent?.includes(address) ? undefined : dataFor(address, ledger, !options.incomplete?.includes(address));
}

const eoa = (nonce: number): AccountState => ({ nonce, code: '0x' });
const BINANCE_STATE: AccountState = { nonce: 15_500_000, code: '0x' };

const FARM_SLOTS = Array.from({ length: 19 }, (_, i) => ({
  fresh: i === 2 ? HOP_1 : synthetic('f5e5', i),
  claim: i === 2 ? FARM_WALLET : synthetic('c1a1', i),
  block: ANCHOR_BLOCK + 4 * i,
}));
const FARM_LEDGER: Transfer[] = [
  send(ROOT_FUNDER, ROOT, 24_204_379, '0.03097'),
  send(LOOK_ALIKE, ROOT, 24_204_385, '0'),
  ...FARM_SLOTS.map((slot) => send(ROOT, slot.fresh, slot.block, '0.001289')),
  send(HOP_1, HOP_2, 24_511_012, '0.001203'),
  send(HOP_2, HOP_3, 24_511_013, '0.001118'),
  { ...send(HOP_3, FARM_WALLET, 24_511_014, '0.001032'), hash: FARM_WALLET_FUNDING_TX },
  ...FARM_SLOTS.filter((slot) => slot.fresh !== HOP_1).map((slot) => send(slot.fresh, slot.claim, slot.block + 1, '0.001203')),
];

function hashOf(from: string, to: string): string {
  const found = FARM_LEDGER.find((t) => t.from === from && t.to === to);
  if (found === undefined) throw new Error('fixture transfer not found');
  return found.hash;
}

function replay(wallets: string[], ledger: Transfer[], states: [string, AccountState][]): ReplayInput {
  const lookup = lookupFrom(ledger, { incomplete: [BINANCE_14] });
  return {
    wallets,
    snapshotTime: SNAPSHOT_TIME,
    settings: DEFAULT_SETTINGS,
    data: new Map(wallets.map((w) => [w, dataFor(w, ledger)])),
    traces: new Map(wallets.map((w) => [w, traceFunding(w, lookup)])),
    states: new Map(states),
  };
}

function farmReplay(): ReplayInput {
  const claims = FARM_SLOTS.map((slot) => slot.claim);
  return replay(claims, FARM_LEDGER, [[ROOT, eoa(19)], ...claims.map((c): [string, AccountState] => [c, eoa(2)])]);
}

/** Old wallets funded by Binance 14, each optionally sending to one shared address. */
function exchangeReplay(tag: string, count: number, sharedTo?: string, sharedState?: AccountState): ReplayInput {
  const wallets = Array.from({ length: count }, (_, i) => synthetic(tag, i));
  const ledger = wallets.flatMap((w, i) => [
    send(BINANCE_14, w, OLD_BLOCK + 10 * i, '0.5'),
    ...(sharedTo === undefined ? [] : [send(w, sharedTo, ANCHOR_BLOCK + i, '0.49')]),
  ]);
  const states: [string, AccountState][] = [[BINANCE_14, BINANCE_STATE], ...wallets.map((w): [string, AccountState] => [w, eoa(120)])];
  if (sharedTo !== undefined && sharedState !== undefined) states.push([sharedTo, sharedState]);
  return replay(wallets, ledger, states);
}

const collectorReplay = (collectorState?: AccountState) => exchangeReplay('aa', 5, COLLECTOR, collectorState);
const depositReplay = (depositState?: AccountState) => exchangeReplay('bb', 3, DEPOSIT, depositState);

describe('fundingTransfer', () => {
  it('does not take an earlier dust transfer from a stranger as the funder', () => {
    const dust = send(STRANGER, FARM_WALLET, 24_511_000, '0.000000000000000001');
    const funding = fundingTransfer(FARM_WALLET, dataFor(FARM_WALLET, [dust, ...FARM_LEDGER]));
    expect(funding).toMatchObject({ status: 'found', transfer: { hash: FARM_WALLET_FUNDING_TX, from: HOP_3 } });
  });

  it('ignores the zero-value look-alike transfer', () => {
    expect(fundingTransfer(ROOT, dataFor(ROOT, FARM_LEDGER))).toMatchObject({ transfer: { from: ROOT_FUNDER } });
    const poisonOnly = FARM_LEDGER.filter((t) => t.from !== ROOT_FUNDER);
    expect(fundingTransfer(ROOT, dataFor(ROOT, poisonOnly))).toEqual({ status: 'none' });
  });

  it('ignores value that arrives after the wallet first sends', () => {
    const wallet = synthetic('ab', 1);
    const ledger = [
      send(STRANGER, wallet, 24_400_000, '0.01'),
      send(wallet, COLLECTOR, 24_400_010, '0.005'),
      send(ROOT, wallet, 24_400_020, '5'),
    ];
    expect(fundingTransfer(wallet, dataFor(wallet, ledger))).toMatchObject({ transfer: { from: STRANGER } });
  });

  it('finds internal funding when no external transfer funded the wallet', () => {
    const wallet = synthetic('ab', 2);
    const ledger = [send(COLLECTOR, wallet, 24_400_050, '1', 'internal'), send(wallet, STRANGER, 24_400_100, '0.1')];
    expect(fundingTransfer(wallet, dataFor(wallet, ledger))).toMatchObject({
      status: 'found',
      transfer: { from: COLLECTOR, kind: 'internal' },
    });
  });

  it('is unknown, not none, until every page and the internal transfers are read', () => {
    const wallet = synthetic('ab', 3);
    const external = { transfers: [send(wallet, STRANGER, 24_400_100, '0.1')], complete: true };
    expect(fundingTransfer(wallet, { external })).toEqual({ status: 'unknown' });
    expect(fundingTransfer(wallet, { external, internal: { transfers: [], complete: false } })).toEqual({ status: 'unknown' });
    expect(fundingTransfer(wallet, { external: { ...external, complete: false }, internal: { transfers: [], complete: true } })).toEqual({
      status: 'unknown',
    });
    expect(fundingTransfer(wallet, { external, internal: { transfers: [], complete: true } })).toEqual({ status: 'none' });
  });
});

describe('isPassThrough', () => {
  const RELAY = synthetic('7e', 1);
  const relay = (afterBlocks: number, eth: string, extra: Transfer[] = []) =>
    dataFor(RELAY, [send(ROOT, RELAY, ANCHOR_BLOCK, '0.001289'), send(RELAY, HOP_2, ANCHOR_BLOCK + afterBlocks, eth), ...extra]);

  it('is false with two incoming values, and a zero-value look-alike does not count as one', () => {
    expect(isPassThrough(HOP_3, dataFor(HOP_3, FARM_LEDGER))).toBe(true);
    expect(isPassThrough(RELAY, relay(1, '0.001203', [send(LOOK_ALIKE, RELAY, ANCHOR_BLOCK, '0')]))).toBe(true);
    expect(isPassThrough(RELAY, relay(1, '0.001203', [send(STRANGER, RELAY, ANCHOR_BLOCK, '0.0001')]))).toBe(false);
  });

  it('is false for a send 51 blocks after the funding', () => {
    expect(isPassThrough(RELAY, relay(PASS_THROUGH_MAX_BLOCKS, '0.001203'))).toBe(true);
    expect(isPassThrough(RELAY, relay(PASS_THROUGH_MAX_BLOCKS + 1, '0.001203'))).toBe(false);
  });

  it('is false for a send under half the value received', () => {
    expect(isPassThrough(RELAY, relay(1, '0.0006445'))).toBe(true);
    expect(isPassThrough(RELAY, relay(1, '0.000644'))).toBe(false);
  });

  it('is false when the history is not fully read', () => {
    expect(isPassThrough(HOP_3, dataFor(HOP_3, FARM_LEDGER, false))).toBe(false);
  });
});

describe('traceFunding', () => {
  it('walks 0x041f back through three single-use wallets to 0x8439', () => {
    expect(traceFunding(FARM_WALLET, lookupFrom(FARM_LEDGER))).toEqual({
      status: 'done',
      funder: HOP_3,
      root: ROOT,
      hops: [HOP_3, HOP_2, HOP_1],
      txs: [FARM_WALLET_FUNDING_TX, hashOf(HOP_2, HOP_3), hashOf(HOP_1, HOP_2), hashOf(ROOT, HOP_1)],
      fundingTime: timeOf(24_511_014),
    });
  });

  it('names the first address whose data is not supplied yet', () => {
    expect(traceFunding(FARM_WALLET, lookupFrom(FARM_LEDGER, { absent: [HOP_2, HOP_1] }))).toEqual({
      status: 'needs',
      address: HOP_2,
    });
    expect(traceFunding(FARM_WALLET, lookupFrom(FARM_LEDGER, { absent: [FARM_WALLET] }))).toEqual({
      status: 'needs',
      address: FARM_WALLET,
    });
  });

  it('is unknown, never a false root, when the money is still passing through at the hop cap (C41)', () => {
    expect(traceFunding(FARM_WALLET, lookupFrom(FARM_LEDGER), 0)).toEqual({ status: 'unknown' });
    expect(traceFunding(FARM_WALLET, lookupFrom(FARM_LEDGER), 2)).toEqual({ status: 'unknown' });
    expect(traceFunding(FARM_WALLET, lookupFrom(FARM_LEDGER), 3)).toMatchObject({ status: 'done', root: ROOT });
  });
});

describe('funderKind', () => {
  it('reads exchange, wallet, contract and unknown from nonce and code', () => {
    expect(funderKind(BINANCE_STATE)).toBe('exchange');
    expect(funderKind(eoa(HIGH_VOLUME_NONCE))).toBe('exchange');
    expect(funderKind(eoa(HIGH_VOLUME_NONCE - 1))).toBe('wallet');
    expect(funderKind(eoa(19))).toBe('wallet');
    expect(funderKind({ nonce: 1, code: '0x6080604052' })).toBe('contract');
    expect(funderKind({ nonce: 40, code: `0xef0100${'ab'.repeat(20)}` })).toBe('wallet');
    expect(funderKind(undefined)).toBe('unknown');
    expect(funderKind({ nonce: null, code: '0x' })).toBe('unknown');
    expect(funderKind({ nonce: 3, code: null })).toBe('unknown');
  });
});

describe('buildReplayFacts', () => {
  it('groups the 19 wallets 0x8439 funded in a quarter hour and holds every one under A4', () => {
    const facts = buildReplayFacts(farmReplay());
    expect(facts.size).toBe(19);
    for (const [wallet, f] of facts) {
      expect(f.firstFunder).toEqual({
        address: parseAddress(ROOT),
        kind: 'wallet',
        fanoutInList: 19,
        hopsTraced: wallet === FARM_WALLET ? 3 : 1,
      });
      expect(f.group).toEqual({ size: 19, sameFunderWithinWindow: 19, sweptToSharedCollector: false, authoredEvidence: false });
      expect(f.missing).toEqual([]);
      expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A4' });
    }
    expect(facts.get(FARM_WALLET)?.evidenceTxs).toEqual([
      FARM_WALLET_FUNDING_TX,
      hashOf(HOP_2, HOP_3),
      hashOf(HOP_1, HOP_2),
      hashOf(ROOT, HOP_1),
    ]);
  });

  it('never groups wallets an exchange funded and reports the funder as an exchange', () => {
    for (const f of buildReplayFacts(exchangeReplay('e0', 12)).values()) {
      expect(f.group).toBeNull();
      expect(f.firstFunder).toEqual({ address: parseAddress(BINANCE_14), kind: 'exchange', fanoutInList: 12, hopsTraced: 0 });
      expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'full', rule: 'A9' });
    }
  });

  it('excludes 5 wallets that swept to one wallet collector under A3', () => {
    const input = collectorReplay(eoa(0));
    expect(sharedDestinations(input).get(COLLECTOR)?.size).toBe(5);
    for (const [wallet, f] of buildReplayFacts(input)) {
      expect(f.group).toEqual({ size: 5, sameFunderWithinWindow: null, sweptToSharedCollector: true, authoredEvidence: true });
      expect(f.evidenceTxs).toHaveLength(2);
      expect(f.evidenceTxs[1]).toBe(input.data.get(wallet)?.external.transfers.find((t) => t.to === COLLECTOR)?.hash);
      expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'exclude', rule: 'A3' });
    }
  });

  it('puts a claim wallet that funded 4 other claim wallets in their group, and holds all 5 under A4', () => {
    const funder = synthetic('fa', 1);
    const funded = Array.from({ length: 4 }, (_, i) => synthetic('fb', i));
    const ledger = [
      send(BINANCE_14, funder, OLD_BLOCK, '2'),
      ...funded.map((w, i) => send(funder, w, ANCHOR_BLOCK + i, '0.1')),
    ];
    const states: [string, AccountState][] = [[BINANCE_14, BINANCE_STATE], ...[funder, ...funded].map((w): [string, AccountState] => [w, eoa(120)])];
    for (const f of buildReplayFacts(replay([funder, ...funded], ledger, states)).values()) {
      expect(f.group).toMatchObject({ size: 5, authoredEvidence: false });
      expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A4' });
    }
  });

  it('holds 3 wallets that share one deposit address under A6', () => {
    for (const f of buildReplayFacts(depositReplay(eoa(0))).values()) {
      expect(f.sharedDepositAddress).toEqual({ sharedWithClaimants: 2 });
      expect(f.group).toEqual({ size: 3, sameFunderWithinWindow: null, sweptToSharedCollector: false, authoredEvidence: false });
      expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A6' });
    }
  });

  it('marks the group unread when a shared destination has no state, so the start is A1, never an exclude', () => {
    for (const input of [depositReplay(), collectorReplay(), collectorReplay({ nonce: null, code: '0x' })]) {
      for (const f of buildReplayFacts(input).values()) {
        expect(f.missing).toEqual(['group']);
        expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A1' });
      }
    }
  });

  it('builds facts that pass the Facts schema in every case above', () => {
    const inputs = [farmReplay(), exchangeReplay('e0', 12), collectorReplay(eoa(0)), depositReplay(eoa(0)), depositReplay()];
    let checked = 0;
    for (const input of inputs) {
      for (const f of buildReplayFacts(input).values()) {
        expect(Facts.parse(f)).toEqual(f);
        checked += 1;
      }
    }
    expect(checked).toBe(19 + 12 + 5 + 3 + 3);
  });
});

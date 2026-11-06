// Not covered here: reading transfers, nonces and code from the chain (the worker's chain readers do that), whether
// these fixtures still match a fresh read of mainnet (the replay run shows that), and how the model moves a start.
import { keccak256, parseEther, toHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { parseAddress } from '../src/address.ts';
import { Facts } from '../src/facts.ts';
import {
  buildReplayFacts,
  funderKind,
  fundingBursts,
  fundingTransfer,
  HIGH_VOLUME_NONCE,
  isPassThrough,
  PASS_THROUGH_MAX_BLOCKS,
  SECONDS_PER_DAY,
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

const BURST_DAY = Math.floor(timeOf(OLD_BLOCK) / SECONDS_PER_DAY) * SECONDS_PER_DAY;
const BURST_MIDDAY = BURST_DAY + SECONDS_PER_DAY / 2;
const BURST_MIDNIGHT = BURST_DAY + SECONDS_PER_DAY;
const CONTRACT_STATE: AccountState = { nonce: 1, code: '0x6080604052' };

interface BurstShape {
  funder?: string;
  funderState?: AccountState;
  eth?: (index: number) => string;
  time?: (index: number) => number;
}

/** Old, active wallets each funded once by one source. Left alone: one exchange, one UTC day, one amount. */
function burstReplay(count: number, shape: BurstShape = {}): ReplayInput {
  const { funder = BINANCE_14, funderState = BINANCE_STATE, eth = () => '0.5', time = () => BURST_MIDDAY } = shape;
  const wallets = Array.from({ length: count }, (_, i) => synthetic('b0', i));
  const ledger = wallets.map((w, i) => ({ ...send(funder, w, OLD_BLOCK + i, eth(i)), time: time(i) }));
  return replay(wallets, ledger, [[funder, funderState], ...wallets.map((w): [string, AccountState] => [w, eoa(120)])]);
}

const burstOf = (input: ReplayInput) => [...buildReplayFacts(input).values()].map((f) => f.fundingBurst);

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

describe('fundingBursts', () => {
  const candidate = (tag: string, index: number, wei: bigint, source = BINANCE_14, time = BURST_MIDDAY) => ({
    wallet: synthetic(tag, index),
    source,
    time,
    amount: wei,
  });
  const ETH = 10n ** 18n;

  it('gives each wallet its largest single window, and sources and days never mix', () => {
    const overlapping = Array.from({ length: 30 }, (_, i) => candidate('a0', i, ETH + (BigInt(i) * ETH) / 100n));
    const between = candidate('a5', 0, 2n * ETH);
    const farApart = Array.from({ length: 20 }, (_, i) => candidate('a1', i, 3n * ETH));
    const otherSource = Array.from({ length: 19 }, (_, i) => candidate('a2', i, ETH, ROOT));
    const otherDay = Array.from({ length: 19 }, (_, i) => candidate('a3', i, ETH, BINANCE_14, BURST_MIDNIGHT));
    const bursts = fundingBursts([...overlapping, between, ...farApart, ...otherSource, ...otherDay], DEFAULT_SETTINGS);
    expect(bursts.size).toBe(50);
    // 30 wallets a hundredth of an ETH apart: only 26 of them fit inside 25% of any one wallet.
    expect(bursts.get(synthetic('a0', 0))).toBe(26);
    expect(bursts.get(synthetic('a0', 29))).toBe(26);
    expect(bursts.get(synthetic('a1', 0))).toBe(20);
    expect(bursts.has(between.wallet)).toBe(false);
  });

  it('gives 30 wallets at 1 ETH and 20 at 3 ETH bursts of 30 and 20, not one of 50', () => {
    const low = Array.from({ length: 30 }, (_, i) => candidate('a6', i, ETH));
    const high = Array.from({ length: 20 }, (_, i) => candidate('a7', i, 3n * ETH));
    const bursts = fundingBursts([...low, ...high], DEFAULT_SETTINGS);
    expect(bursts.size).toBe(50);
    expect(new Set(low.map((c) => bursts.get(c.wallet)))).toEqual(new Set([30]));
    expect(new Set(high.map((c) => bursts.get(c.wallet)))).toEqual(new Set([20]));
  });

  // The 1.25 ETH wallet is the only one in both windows: 25% above the 1 ETH wallets, and 1.5 ETH is within 25% of it.
  it('keeps two windows that share one wallet at their own sizes', () => {
    const low = Array.from({ length: 19 }, (_, i) => candidate('a8', i, ETH));
    const shared = candidate('a9', 0, (5n * ETH) / 4n);
    const high = Array.from({ length: 19 }, (_, i) => candidate('aa', i, (3n * ETH) / 2n));
    const bursts = fundingBursts([...low, shared, ...high], DEFAULT_SETTINGS);
    expect(bursts.size).toBe(39);
    expect(new Set(bursts.values())).toEqual(new Set([20]));
  });

  // A slow reading of the rule itself, so the count is checked against the definition and not against a second copy.
  function slowLargestWindow(amounts: bigint[], index: number): number {
    let best = 0;
    for (let start = 0; start <= index; start += 1) {
      const fits = amounts.filter((amount, at) => at >= start && amount * 10_000n <= (amounts[start] as bigint) * 12_500n).length;
      if (start + fits - 1 >= index) best = Math.max(best, fits);
    }
    return best;
  }

  it('never counts a chain of overlapping windows as one burst of near-equal amounts', () => {
    const chain = Array.from({ length: 400 }, (_, i) => candidate('ab', i, ETH + (BigInt(i) * ETH) / 100n));
    const bursts = fundingBursts(chain, DEFAULT_SETTINGS);
    expect(bursts.size).toBe(400);
    expect(Math.max(...bursts.values())).toBeLessThan(400);
    const amounts = chain.map((c) => c.amount);
    chain.forEach((c, index) => expect(bursts.get(c.wallet)).toBe(slowLargestWindow(amounts, index)));
  });

  it('matches the slow reading of the rule on an uneven list', () => {
    let seed = 20_261_106;
    const next = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 2 ** 32;
      return BigInt(seed);
    };
    const uneven = Array.from({ length: 300 }, (_, i) => ({ i, wei: ETH + next() * 100_000_000n }))
      .sort((a, b) => (a.wei < b.wei ? -1 : a.wei > b.wei ? 1 : 0))
      .map(({ i, wei }) => candidate('ac', i, wei));
    const bursts = fundingBursts(uneven, DEFAULT_SETTINGS);
    const amounts = uneven.map((c) => c.amount);
    uneven.forEach((c, index) => {
      const size = slowLargestWindow(amounts, index);
      expect(bursts.get(c.wallet)).toBe(size >= 20 ? size : undefined);
    });
  });

  // Every amount fits one window, the worst case. The limit is 1 second, not 5, because a tight member-by-member loop
  // took 3.3 seconds here: it would pass at 5, and this test exists to fail on it.
  it('finishes 100,000 candidates with distinct amounts in one bucket inside the 5 second limit (C41)', () => {
    const candidates = Array.from({ length: 100_000 }, (_, i) => candidate('a4', i, ETH + BigInt(100_000 - i) * 10n ** 9n));
    const started = performance.now();
    const bursts = fundingBursts(candidates, DEFAULT_SETTINGS);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(bursts.size).toBe(100_000);
    expect(bursts.get(synthetic('a4', 0))).toBe(100_000);
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

  it('does not link 5 old wallets that each paid one small fee to the same service wallet (live, 4 Nov)', () => {
    const feeWallet = synthetic('fe', 1);
    const wallets = Array.from({ length: 5 }, (_, i) => synthetic('cc', i));
    const ledger = wallets.flatMap((w, i) => [
      send(BINANCE_14, w, OLD_BLOCK + 10 * i, '0.5'),
      send(w, feeWallet, ANCHOR_BLOCK - 60 * DAY_BLOCKS * i, '0.002'),
    ]);
    const states: [string, AccountState][] = [[BINANCE_14, BINANCE_STATE], [feeWallet, eoa(5_524)], ...wallets.map((w): [string, AccountState] => [w, eoa(120)])];
    const input = replay(wallets, ledger, states);
    expect(sharedDestinations(input).has(feeWallet)).toBe(false);
    for (const f of buildReplayFacts(input).values()) {
      expect(f.group).toBeNull();
      expect(f.sharedDepositAddress).toBeNull();
      expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'full', rule: 'A9' });
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

  it('gives 20 wallets one exchange funded on one UTC day within 25% a burst of 20, with no group (C45)', () => {
    const amounts = (i: number) => (i === 19 ? '0.625' : (0.5 + i * 0.001).toFixed(3));
    for (const f of buildReplayFacts(burstReplay(20, { eth: amounts })).values()) {
      expect(f.fundingBurst).toEqual({ wallets: 20 });
      expect(f.group).toBeNull();
      expect(f.firstFunder).toMatchObject({ kind: 'exchange', fanoutInList: 20, hopsTraced: 0 });
      expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'partial', rule: 'A8' });
    }
  });

  it('gives no burst to 19 wallets, one under the minimum', () => {
    for (const f of buildReplayFacts(burstReplay(19)).values()) {
      expect(f.fundingBurst).toBeNull();
      expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'full', rule: 'A9' });
    }
  });

  // A known limit, named in the threat model: a burst split across UTC midnight is not caught.
  it('gives no burst to 20 wallets with 10 on each side of UTC midnight', () => {
    const time = (i: number) => (i < 10 ? BURST_MIDNIGHT - 60 : BURST_MIDNIGHT + 60);
    expect(burstOf(burstReplay(20, { time }))).toEqual(Array(20).fill(null));
  });

  it('leaves out a wallet funded 1.26 times the amount of the 20 in the burst', () => {
    const eth = (i: number) => (i === 20 ? '0.63' : '0.5');
    expect(burstOf(burstReplay(21, { eth }))).toEqual([...Array(20).fill({ wallets: 20 }), null]);
  });

  it('gives no burst when a wallet funder funded the same 20, and groups them by the existing rule', () => {
    for (const f of buildReplayFacts(burstReplay(20, { funder: ROOT, funderState: eoa(20) })).values()) {
      expect(f.fundingBurst).toBeNull();
      expect(f.group?.size).toBe(20);
      expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A4' });
    }
  });

  it('gives no burst when a contract funded the same 20', () => {
    const facts = buildReplayFacts(burstReplay(20, { funder: synthetic('cc', 1), funderState: CONTRACT_STATE }));
    for (const f of facts.values()) {
      expect(f.firstFunder?.kind).toBe('contract');
      expect(f.fundingBurst).toBeNull();
      expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'full', rule: 'A9' });
    }
  });

  it('gives no burst when the same 20 were funded through a pass-through hop to an exchange', () => {
    const wallets = Array.from({ length: 20 }, (_, i) => synthetic('b0', i));
    const ledger = wallets.flatMap((w, i) => {
      const hop = synthetic('b1', i);
      return [send(BINANCE_14, hop, OLD_BLOCK + 2 * i, '0.5'), send(hop, w, OLD_BLOCK + 2 * i + 1, '0.5')];
    });
    const states: [string, AccountState][] = [[BINANCE_14, BINANCE_STATE], ...wallets.map((w): [string, AccountState] => [w, eoa(120)])];
    for (const f of buildReplayFacts(replay(wallets, ledger, states)).values()) {
      expect(f.firstFunder).toMatchObject({ kind: 'exchange', hopsTraced: 1 });
      expect(f.fundingBurst).toBeNull();
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

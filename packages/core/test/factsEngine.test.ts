// Not covered here: reading transfers, nonces and code from the chain (the worker's chain readers do that), whether
// these fixtures still match a fresh read of mainnet (the replay run shows that), and how the model moves a start.
import { keccak256, parseEther, toHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { parseAddress } from '../src/address.ts';
import { computeCeiling, meetsGroupExcludeRule } from '../src/ceiling.ts';
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
  senderListShareBps,
  sharedDestinations,
  traceFunding,
  walletAgeDays,
  type AccountState,
  type AddressData,
  type ReplayInput,
  type Transfer,
  type TransferPage,
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

type PageEntry = [string, TransferPage];

// Unless a test names its pages, each shared destination's page comes from the ledger, so its crowd is list wallets only.
function replay(wallets: string[], ledger: Transfer[], states: [string, AccountState][], pages?: PageEntry[]): ReplayInput {
  const lookup = lookupFrom(ledger, { incomplete: [BINANCE_14] });
  const data = new Map(wallets.map((w) => [w, dataFor(w, ledger)]));
  const fromLedger = [...sharedDestinations({ wallets, data }).keys()].map((dest): PageEntry => [dest, dataFor(dest, ledger).external]);
  return {
    wallets,
    snapshotTime: SNAPSHOT_TIME,
    settings: DEFAULT_SETTINGS,
    data,
    traces: new Map(wallets.map((w) => [w, traceFunding(w, lookup)])),
    states: new Map(states),
    destinationPages: new Map(pages ?? fromLedger),
  };
}

function farmReplay(): ReplayInput {
  const claims = FARM_SLOTS.map((slot) => slot.claim);
  return replay(claims, FARM_LEDGER, [[ROOT, eoa(19)], ...claims.map((c): [string, AccountState] => [c, eoa(2)])]);
}

/** Old wallets funded by Binance 14, each optionally sending to one shared address. */
function exchangeReplay(tag: string, count: number, sharedTo?: string, sharedState?: AccountState, pages?: PageEntry[]): ReplayInput {
  const wallets = Array.from({ length: count }, (_, i) => synthetic(tag, i));
  const ledger = wallets.flatMap((w, i) => [
    send(BINANCE_14, w, OLD_BLOCK + 10 * i, '0.5'),
    ...(sharedTo === undefined ? [] : [send(w, sharedTo, ANCHOR_BLOCK + i, '0.49')]),
  ]);
  const states: [string, AccountState][] = [[BINANCE_14, BINANCE_STATE], ...wallets.map((w): [string, AccountState] => [w, eoa(120)])];
  if (sharedTo !== undefined && sharedState !== undefined) states.push([sharedTo, sharedState]);
  return replay(wallets, ledger, states, pages);
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

describe('walletAgeDays (C20)', () => {
  const wallet = synthetic('ab', 9);
  const daysAgo = (days: number) => SNAPSHOT_TIME - days * SECONDS_PER_DAY - 60;
  const at = (transfer: Transfer, days: number) => ({ ...transfer, time: daysAgo(days) });
  const pages = (transfers: Transfer[], internalRead = true): AddressData => ({
    external: { transfers: transfers.filter((t) => t.kind === 'external'), complete: true },
    ...(internalRead ? { internal: { transfers: transfers.filter((t) => t.kind === 'internal'), complete: true } } : {}),
  });

  it('counts from the real funding, not a zero-value or failed transfer a stranger sent earlier', () => {
    const transfers = [
      at(send(STRANGER, wallet, 100, '0'), 400),
      at({ ...send(STRANGER, wallet, 101, '1'), failed: true }, 300),
      at(send(BINANCE_14, wallet, 200, '1'), 3),
    ];
    expect(walletAgeDays(wallet, pages(transfers), SNAPSHOT_TIME)).toBe(3);
  });

  it("counts the wallet's own send of any value, and value that reached it internally", () => {
    expect(walletAgeDays(wallet, pages([at(send(wallet, STRANGER, 100, '0'), 50), at(send(ROOT, wallet, 200, '1'), 3)]), SNAPSHOT_TIME)).toBe(50);
    expect(walletAgeDays(wallet, pages([at(send(COLLECTOR, wallet, 100, '1', 'internal'), 70), at(send(ROOT, wallet, 200, '1'), 3)]), SNAPSHOT_TIME)).toBe(70);
  });

  it('is 0 with nothing to count once every page is read, and null while one may hold it or when it postdates the snapshot', () => {
    const strangerOnly = [at(send(STRANGER, wallet, 100, '0'), 400)];
    expect(walletAgeDays(wallet, pages(strangerOnly), SNAPSHOT_TIME)).toBe(0);
    expect(walletAgeDays(wallet, pages(strangerOnly, false), SNAPSHOT_TIME)).toBeNull();
    expect(walletAgeDays(wallet, pages([at(send(ROOT, wallet, 100, '1'), -1)]), SNAPSHOT_TIME)).toBeNull();
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

describe('senderListShareBps', () => {
  const DEST = synthetic('d0', 1);
  const [LISTED_A, LISTED_B, OUTSIDER] = [synthetic('a1', 1), synthetic('a1', 2), synthetic('a1', 3)] as [string, string, string];
  const list = new Set([LISTED_A, LISTED_B]);
  const pageOf = (transfers: Transfer[]): TransferPage => ({ transfers, complete: true });

  it('counts a sender once however often it paid', () => {
    const page = pageOf([send(LISTED_A, DEST, 100, '1'), send(LISTED_A, DEST, 101, '1'), send(LISTED_A, DEST, 102, '1'), send(OUTSIDER, DEST, 103, '1')]);
    expect(senderListShareBps(DEST, page, list)).toBe(5000);
  });

  it('ignores failed and zero-value transfers', () => {
    const failed = { ...send(LISTED_A, DEST, 100, '1'), failed: true };
    const zero = send(LISTED_B, DEST, 101, '0');
    expect(senderListShareBps(DEST, pageOf([failed, zero, send(OUTSIDER, DEST, 102, '1')]), list)).toBe(0);
  });

  it("ignores the address's own sends, even when the address is itself on the list", () => {
    const withDest = new Set([...list, DEST]);
    const page = pageOf([send(DEST, OUTSIDER, 100, '1'), send(DEST, DEST, 101, '1'), send(OUTSIDER, DEST, 102, '1')]);
    expect(senderListShareBps(DEST, page, withDest)).toBe(0);
  });

  it('returns 10000 when the page shows no sender, because nothing shows the address is public', () => {
    expect(senderListShareBps(DEST, pageOf([]), list)).toBe(10000);
    expect(senderListShareBps(DEST, pageOf([send(DEST, OUTSIDER, 100, '1')]), list)).toBe(10000);
  });

  it('rounds down to whole basis points', () => {
    const page = pageOf([send(LISTED_A, DEST, 100, '1'), send(LISTED_B, DEST, 101, '1'), send(OUTSIDER, DEST, 102, '1')]);
    expect(senderListShareBps(DEST, page, list)).toBe(6666);
    expect(senderListShareBps(DEST, page, new Set([LISTED_A]))).toBe(3333);
  });

  it('reads the destination and the senders in any spelling', () => {
    const page = pageOf([{ ...send(LISTED_A, DEST, 100, '1'), from: parseAddress(LISTED_A), to: parseAddress(DEST) }]);
    expect(senderListShareBps(parseAddress(DEST), page, list)).toBe(10000);
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
      expect(f.group).toEqual({ size: 19, sameFunderWithinWindow: 19, sweptToSharedCollector: false, authoredEvidence: false, linkedByWallet: false });
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
      expect(f.group).toEqual({ size: 5, sameFunderWithinWindow: null, sweptToSharedCollector: true, authoredEvidence: true, linkedByWallet: true });
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
      expect(f.group).toEqual({ size: 3, sameFunderWithinWindow: null, sweptToSharedCollector: false, authoredEvidence: false, linkedByWallet: true });
      expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A6' });
    }
  });

  describe('linkedByWallet: links this wallet made, wider than the exclude-grade authoredEvidence', () => {
    const funder = synthetic('fa', 2);
    const funded = Array.from({ length: 5 }, (_, i) => synthetic('fc', i));
    const fundings = funded.map((w, i) => send(funder, w, ANCHOR_BLOCK + i, '0.1'));
    const walletStates = (wallets: string[]) => wallets.map((w): [string, AccountState] => [w, eoa(120)]);
    const linked = (input: ReplayInput, wallet: string) => buildReplayFacts(input).get(wallet)?.group?.linkedByWallet;

    it('is true for a sweep to a destination shared with one other claim wallet, with authoredEvidence false', () => {
      const facts = [...buildReplayFacts(exchangeReplay('dd', 2, DEPOSIT, eoa(0))).values()];
      expect(facts).toHaveLength(2);
      for (const f of facts) {
        expect(f.group).toEqual({ size: 2, sameFunderWithinWindow: null, sweptToSharedCollector: false, authoredEvidence: false, linkedByWallet: true });
      }
    });

    it('is true for a claim wallet that funded another claim wallet', () => {
      const input = replay([funder, ...funded], [send(BINANCE_14, funder, OLD_BLOCK, '2'), ...fundings], [
        [BINANCE_14, BINANCE_STATE],
        ...walletStates([funder, ...funded]),
      ]);
      expect(linked(input, funder)).toBe(true);
      expect(buildReplayFacts(input).get(funder)?.group?.authoredEvidence).toBe(false);
    });

    it('is false for a wallet only funded by a shared root', () => {
      const input = replay(funded, fundings, [[funder, eoa(5)], ...walletStates(funded)]);
      for (const f of buildReplayFacts(input).values()) {
        expect(f.group).toMatchObject({ size: 5, linkedByWallet: false });
      }
    });

    it('is false for a funding root that is not linkable, even when it sits in a group', () => {
      const root = synthetic('fa', 3);
      const [busy, peer, fundedA, fundedB] = [synthetic('fd', 1), synthetic('fd', 2), synthetic('fd', 3), synthetic('fd', 4)];
      const wallets = [busy, peer, fundedA, fundedB];
      const ledger = [
        send(root, busy, ANCHOR_BLOCK, '1'),
        send(root, peer, ANCHOR_BLOCK + 1, '1'),
        send(busy, fundedA, ANCHOR_BLOCK + 2, '0.1'),
        send(busy, fundedB, ANCHOR_BLOCK + 3, '0.1'),
      ];
      const input = replay(wallets, ledger, [[root, eoa(5)], [busy, eoa(HIGH_VOLUME_NONCE)], ...walletStates([peer, fundedA, fundedB])]);
      expect(buildReplayFacts(input).get(busy)?.group).toMatchObject({ size: 2, linkedByWallet: false });
    });

    it('is false for a sweep to a shared exchange, even when the wallet sits in a group', () => {
      const exchangeDeposit = synthetic('e1', 1);
      const ledger = [...fundings, ...funded.map((w, i) => send(w, exchangeDeposit, ANCHOR_BLOCK + 100 + i, '0.09'))];
      const input = replay(funded, ledger, [[funder, eoa(5)], [exchangeDeposit, BINANCE_STATE], ...walletStates(funded)]);
      for (const f of buildReplayFacts(input).values()) {
        expect(f.group).toMatchObject({ size: 5, linkedByWallet: false });
      }
    });

    it('never reaches check A3, which still needs authoredEvidence', () => {
      const [first, second] = funded as [string, string];
      const sweeps = [first, second].map((w, i) => send(w, DEPOSIT, ANCHOR_BLOCK + 100 + i, '0.09'));
      const input = replay(funded, [...fundings, ...sweeps], [[funder, eoa(5)], [DEPOSIT, eoa(0)], ...walletStates(funded)]);
      const facts = buildReplayFacts(input).get(first) as Facts;
      expect(facts.group).toMatchObject({ size: 5, sameFunderWithinWindow: 5, authoredEvidence: false, linkedByWallet: true });
      expect(meetsGroupExcludeRule(facts, DEFAULT_SETTINGS)).toBe(false);
      expect(computeStart(facts, DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A4' });
      expect(computeCeiling(facts, DEFAULT_SETTINGS).ceiling).not.toBe('exclude');
    });
  });

  describe('a shared destination links only when it looks private', () => {
    const PUBLIC = synthetic('b1', 1);
    const sweepers = (count: number) => Array.from({ length: count }, (_, i) => synthetic('a7', i));
    const strangers = (count: number) => Array.from({ length: count }, (_, i) => synthetic('5a', i));
    const pageOf = (destination: string, senders: string[]): TransferPage => ({
      transfers: senders.map((from, i) => send(from, destination, OLD_BLOCK + i, '0.1')),
      complete: true,
    });
    const sweepTo = (count: number, crowd: string[], state: AccountState = eoa(48)) =>
      exchangeReplay('a7', count, PUBLIC, state, [[PUBLIC, pageOf(PUBLIC, crowd)]]);
    const SELF_LINKED = { size: 5, sameFunderWithinWindow: null, sweptToSharedCollector: true, authoredEvidence: true, linkedByWallet: true };

    const funder = synthetic('fa', 4);
    const funded = Array.from({ length: 5 }, (_, i) => synthetic('fe', i));
    const fundings = funded.map((w, i) => send(funder, w, ANCHOR_BLOCK + i, '0.1'));
    const fundedStates: [string, AccountState][] = [[funder, eoa(5)], ...funded.map((w): [string, AccountState] => [w, eoa(120)])];

    it('gives five wallets sweeping to a public address no group, no evidence, no A3 and no shared deposit', () => {
      const input = sweepTo(5, [...strangers(95), ...sweepers(5)]);
      expect(sharedDestinations(input).get(PUBLIC)?.size).toBe(5);
      for (const f of buildReplayFacts(input).values()) {
        expect(f.group).toBeNull();
        expect(f.sharedDepositAddress).toBeNull();
        expect(f.evidenceTxs).toHaveLength(1);
        expect(f.missing).toEqual([]);
        expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'full', rule: 'A9' });
        expect(computeCeiling(f, DEFAULT_SETTINGS).ceiling).toBe('full');
      }
    });

    it('gives three wallets sharing a public address no A6', () => {
      for (const f of buildReplayFacts(sweepTo(3, [...strangers(95), ...sweepers(3)])).values()) {
        expect(f.group).toBeNull();
        expect(f.sharedDepositAddress).toBeNull();
        expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'full', rule: 'A9' });
      }
    });

    it('keeps A3 for five wallets sweeping to a private address', () => {
      for (const f of buildReplayFacts(sweepTo(5, [...strangers(3), ...sweepers(5)])).values()) {
        expect(f.group).toEqual(SELF_LINKED);
        expect(f.evidenceTxs).toHaveLength(2);
        expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'exclude', rule: 'A3' });
      }
    });

    it('links at exactly 5000 bps', () => {
      const crowd = [...strangers(5), ...sweepers(5)];
      const input = sweepTo(5, crowd);
      expect(senderListShareBps(PUBLIC, input.destinationPages.get(PUBLIC) as TransferPage, new Set(input.wallets))).toBe(5000);
      for (const f of buildReplayFacts(input).values()) expect(f.group).toEqual(SELF_LINKED);
    });

    it('does not link at 4999 bps, the nearest share below it', () => {
      const quiet = Array.from({ length: 2495 }, (_, i) => synthetic('9e', i));
      const crowd = [...sweepers(5), ...quiet, ...strangers(2501)];
      const input = sweepTo(5, crowd);
      const list = { ...input, wallets: [...input.wallets, ...quiet] };
      expect(senderListShareBps(PUBLIC, input.destinationPages.get(PUBLIC) as TransferPage, new Set(list.wallets))).toBe(4999);
      const facts = buildReplayFacts(list);
      for (const wallet of sweepers(5)) {
        expect(facts.get(wallet)?.group).toBeNull();
        expect(facts.get(wallet)?.sharedDepositAddress).toBeNull();
      }
    });

    it('follows the setting, so a project can tighten or loosen it', () => {
      const input = sweepTo(5, [...strangers(5), ...sweepers(5)]);
      const tightened = { ...input, settings: { ...DEFAULT_SETTINGS, collectorMinListShareBps: 5001 } };
      const opened = { ...input, settings: { ...DEFAULT_SETTINGS, collectorMinListShareBps: 0 } };
      expect(buildReplayFacts(tightened).get(sweepers(5)[0] as string)?.group).toBeNull();
      expect(buildReplayFacts(opened).get(sweepers(5)[0] as string)?.group).toEqual(SELF_LINKED);
    });

    it('treats a missing page as doubt: the group stays unread, the wallet holds on A1 and nothing is excluded', () => {
      for (const f of buildReplayFacts(exchangeReplay('a7', 5, PUBLIC, eoa(0), [])).values()) {
        expect(f.group).toBeNull();
        expect(f.missing).toEqual(['group']);
        expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A1' });
        expect(computeCeiling(f, DEFAULT_SETTINGS).ceiling).toBe('hold');
      }
    });

    it.each([
      ['an exchange', BINANCE_STATE],
      ['a contract', CONTRACT_STATE],
    ])('asks for no page from %s, so its missing page is not doubt', (_name, state) => {
      for (const f of buildReplayFacts(exchangeReplay('a7', 5, PUBLIC, state, [])).values()) {
        expect(f.group).toBeNull();
        expect(f.missing).toEqual([]);
      }
    });

    it('leaves a funding-root group alone, whatever the setting and with no pages at all', () => {
      const input = replay(funded, fundings, fundedStates, []);
      const strict = { ...input, settings: { ...DEFAULT_SETTINGS, collectorMinListShareBps: 10000 } };
      for (const f of buildReplayFacts(strict).values()) {
        expect(f.group).toEqual({ size: 5, sameFunderWithinWindow: 5, sweptToSharedCollector: false, authoredEvidence: false, linkedByWallet: false });
        expect(f.missing).toEqual([]);
        expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A4' });
      }
    });

    it('keeps linkedByWallet false for a sweep to a public address, even inside a funding group', () => {
      const sweeps = funded.map((w, i) => send(w, PUBLIC, ANCHOR_BLOCK + 100 + i, '0.09'));
      const input = replay(funded, [...fundings, ...sweeps], [...fundedStates, [PUBLIC, eoa(48)]], [[PUBLIC, pageOf(PUBLIC, strangers(95))]]);
      for (const [wallet, f] of buildReplayFacts(input)) {
        expect(f.group).toEqual({ size: 5, sameFunderWithinWindow: 5, sweptToSharedCollector: false, authoredEvidence: false, linkedByWallet: false });
        expect(f.evidenceTxs).not.toContain(sweeps.find((t) => t.from === wallet)?.hash);
      }
    });

    it('judges each destination alone, so a public one does not cancel a private one', () => {
      const wallets = sweepers(5);
      const ledger = wallets.flatMap((w, i) => [
        send(BINANCE_14, w, OLD_BLOCK + 10 * i, '1'),
        send(w, PUBLIC, ANCHOR_BLOCK + i, '0.8'),
        send(w, COLLECTOR, ANCHOR_BLOCK + 100 + i, '0.9'),
      ]);
      const states: [string, AccountState][] = [[BINANCE_14, BINANCE_STATE], [PUBLIC, eoa(48)], [COLLECTOR, eoa(0)], ...wallets.map((w): [string, AccountState] => [w, eoa(120)])];
      const pages: PageEntry[] = [[PUBLIC, pageOf(PUBLIC, strangers(95))], [COLLECTOR, pageOf(COLLECTOR, wallets)]];
      for (const f of buildReplayFacts(replay(wallets, ledger, states, pages)).values()) {
        expect(f.group).toEqual(SELF_LINKED);
        expect(f.evidenceTxs).toHaveLength(2);
      }
    });
  });

  describe('a payment judged against inflows that were not read (C11)', () => {
    const PAYOUT = synthetic('cc', 7);
    const PAYEE = synthetic('9a', 1);
    const payers = Array.from({ length: 5 }, (_, i) => synthetic('a3', i));
    // The reviewer's case: 0.1 ETH from an exchange, then 10 ETH paid out internally by a contract, then 1 ETH to a
    // nonce-3 address. Against the 0.1 ETH alone the 1 ETH looks like a sweep.
    const ledger = payers.flatMap((w, i) => [
      send(BINANCE_14, w, OLD_BLOCK + 10 * i, '0.1'),
      send(PAYOUT, w, OLD_BLOCK + 10 * i + 5, '10', 'internal'),
      send(w, PAYEE, ANCHOR_BLOCK + i, '1'),
    ]);
    const states: [string, AccountState][] = [
      [BINANCE_14, BINANCE_STATE],
      [PAYOUT, CONTRACT_STATE],
      [PAYEE, eoa(3)],
      ...payers.map((w): [string, AccountState] => [w, eoa(120)]),
    ];
    const payeePage = (from: Transfer[]): PageEntry => [PAYEE, dataFor(PAYEE, from).external];

    /** The replay as the runner sees it when some wallets' internal pages were not read in full. */
    function asRead(from: Transfer[], internalFor: (wallet: string) => TransferPage | undefined, wallets = payers): ReplayInput {
      const data = new Map(
        wallets.map((w): [string, AddressData] => {
          const { external } = dataFor(w, from);
          const internal = internalFor(w);
          return [w, internal === undefined ? { external } : { external, internal }];
        }),
      );
      const lookup = (address: string) => data.get(address) ?? lookupFrom(from, { incomplete: [BINANCE_14] })(address);
      const allStates: [string, AccountState][] = [...states, ...wallets.map((w): [string, AccountState] => [w, eoa(120)])];
      return { ...replay(wallets, from, allStates, [payeePage(from)]), data, traces: new Map(wallets.map((w) => [w, traceFunding(w, lookup)])) };
    }

    it('does not count the payments as sweeps once the internal inflows are read', () => {
      const input = replay(payers, ledger, states, [payeePage(ledger)]);
      expect(sharedDestinations(input).size).toBe(0);
      for (const f of buildReplayFacts(input).values()) {
        expect(f.group).toBeNull();
        expect(f.missing).toEqual([]);
        expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'full', rule: 'A9' });
      }
    });

    it.each([
      ['missing', () => undefined],
      ['incomplete', () => ({ transfers: [], complete: false })],
    ])('holds every wallet on A1, never A3, when the internal pages are %s', (_name, internal) => {
      const input = asRead(ledger, internal);
      expect(sharedDestinations(input).get(PAYEE)?.size).toBe(5);
      for (const f of buildReplayFacts(input).values()) {
        expect(f.missing).toEqual(['group']);
        expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A1' });
        expect(computeCeiling(f, DEFAULT_SETTINGS).ceiling).toBe('hold');
      }
    });

    it('holds the four real sweepers too when the fifth sweep at their collector rests on unread inflows', () => {
      const unread = payers[0] as string;
      const mixed = payers.flatMap((w, i) => [
        send(BINANCE_14, w, OLD_BLOCK + 10 * i, '0.1'),
        ...(w === unread ? [send(PAYOUT, w, OLD_BLOCK + 10 * i + 5, '10', 'internal')] : []),
        send(w, PAYEE, ANCHOR_BLOCK + i, w === unread ? '1' : '0.09'),
      ]);
      const input = asRead(mixed, (w) => (w === unread ? undefined : dataFor(w, mixed).internal));
      for (const f of buildReplayFacts(input).values()) {
        expect(f.missing).toEqual(['group']);
        expect(computeStart(f, DEFAULT_SETTINGS)).toEqual({ outcome: 'hold', rule: 'A1' });
      }
    });

    // Unread inflows can only make a sweep look like more than it was, so a send that is no sweep on external data is
    // no sweep at all, and doubt at the collector is not this wallet's.
    it('leaves a wallet that only paid the doubtful collector unaffected, with no internal page of its own', () => {
      const shopper = synthetic('a4', 1);
      const withShopper = [...ledger, send(BINANCE_14, shopper, OLD_BLOCK + 100, '1'), send(shopper, PAYEE, ANCHOR_BLOCK + 50, '0.1')];
      const input = asRead(withShopper, () => undefined, [...payers, shopper]);
      expect(sharedDestinations(input).get(PAYEE)?.has(shopper)).toBe(false);
      const facts = buildReplayFacts(input);
      expect(facts.get(shopper)).toMatchObject({ group: null, missing: [] });
      expect(computeStart(facts.get(shopper) as Facts, DEFAULT_SETTINGS)).toEqual({ outcome: 'full', rule: 'A9' });
      for (const wallet of payers) expect(facts.get(wallet)?.missing).toEqual(['group']);
    });
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

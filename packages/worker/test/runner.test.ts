// Not covered here: a live explorer or node (both are in-memory stand-ins and no request leaves the machine), the
// on-disk caches that make a stopped run resume (explorer.test.ts and rpcBatch.test.ts cover those), the rate limit,
// and the scorecard (core's replayScore.test.ts).
import { keccak256, parseEther, toHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseAddress, type AccountState, type Transfer, type TransferPage } from '@thuli/core';
import { ExplorerError, type ExplorerSource } from '../src/chain/explorer.ts';
import { runReplay, type ReplayOptions } from '../src/replay/runner.ts';

// The live ROBO chain from 3 Nov, laid out as in core's factsEngine.test.ts: 0x8439 funded 19 fresh wallets in a
// quarter hour, 18 of them passed the money straight to a claim wallet, and one reached claim wallet 0x041f through
// three single-use wallets.
const ROOT_FUNDER = '0xf81b45b1663b7ea8716c74796d99bbe4ea26f488';
const LOOK_ALIKE = '0xf81baad0224255d7ca5c16acaaab692f6e53f488';
const ROOT = '0x8439895979b4060e20839d6d8bceda2d786e2401';
const HOP_1 = '0x6e4a01561816439d269be9058ec2aa74a293d09c';
const HOP_2 = '0xb8f425dc4223ddb5d88f71d2dc24dccac70bf2af';
const HOP_3 = '0x02dd2aee26986d6b86fb2bfb98e105cd1a661fdb';
const FARM_WALLET = '0x041f77015fe51c51ae49a7f2f3ff86c641fa190a';

// Timestamps are synthetic at 12 seconds a block; only the gaps between them matter here.
const ANCHOR_BLOCK = 24_511_003;
const SNAPSHOT_BLOCK = 24_600_000;
const timeOf = (block: number) => 1_771_400_000 + (block - ANCHOR_BLOCK) * 12;

const synthetic = (tag: string, index: number) => `0x${tag}${index.toString(16).padStart(40 - tag.length, '0')}`;
const STRANGER = synthetic('5e', 1);
const PAYOUT_CONTRACT = synthetic('cc', 1);
const INTERNALLY_FUNDED = synthetic('ab', 2);
const URL_IN_ERROR = 'https://api.etherscan.io/v2/api?module=account&apikey=K3YSECRET';

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

const FARM_SLOTS = Array.from({ length: 19 }, (_, i) => ({
  fresh: i === 2 ? HOP_1 : synthetic('f5e5', i),
  claim: i === 2 ? FARM_WALLET : synthetic('c1a1', i),
  block: ANCHOR_BLOCK + 4 * i,
}));
const FARM_CLAIMS = FARM_SLOTS.map((slot) => slot.claim);
const FARM_LEDGER: Transfer[] = [
  send(ROOT_FUNDER, ROOT, 24_204_379, '0.03097'),
  send(LOOK_ALIKE, ROOT, 24_204_385, '0'),
  ...FARM_SLOTS.map((slot) => send(ROOT, slot.fresh, slot.block, '0.001289')),
  send(HOP_1, HOP_2, 24_511_012, '0.001203'),
  send(HOP_2, HOP_3, 24_511_013, '0.001118'),
  send(HOP_3, FARM_WALLET, 24_511_014, '0.001032'),
  ...FARM_SLOTS.filter((slot) => slot.fresh !== HOP_1).map((slot) => send(slot.fresh, slot.claim, slot.block + 1, '0.001203')),
];
// Every address the funding trace has to read, each one hop above a claim wallet.
const HOP_ADDRESSES = [...FARM_SLOTS.map((slot) => slot.fresh), HOP_2, HOP_3, ROOT];

const eoa = (nonce: number): AccountState => ({ nonce, code: '0x' });
const FARM_STATES = new Map<string, AccountState>([[ROOT, eoa(19)], ...FARM_CLAIMS.map((c): [string, AccountState] => [c, eoa(2)])]);

const WALLET_LIMIT = 100;
const HOP_LIMIT = 5;
const OPTIONS: ReplayOptions = {
  snapshotBlock: SNAPSHOT_BLOCK,
  snapshotTime: timeOf(SNAPSHOT_BLOCK),
  settings: DEFAULT_SETTINGS,
  walletLimit: WALLET_LIMIT,
  hopLimit: HOP_LIMIT,
};

/** An explorer that answers from a ledger like Etherscan would: oldest first, at most limit rows, nothing past endBlock. */
function fakeExplorer(ledger: Transfer[], failFor: string[] = []) {
  const calls: { action: 'txlist' | 'txlistinternal'; address: string; limit: number }[] = [];
  const page = async (action: 'txlist' | 'txlistinternal', address: string, endBlock: number, limit: number): Promise<TransferPage> => {
    calls.push({ action, address, limit });
    // The message carries a URL and a key on purpose: the runner must never pass an error's text on (C40).
    if (failFor.includes(address)) throw new ExplorerError(`explorer ${action} for ${address}: request failed ${URL_IN_ERROR}`);
    const kind = action === 'txlist' ? 'external' : 'internal';
    const transfers = ledger
      .filter((t) => t.kind === kind && t.block <= endBlock && (t.from === address || t.to === address))
      .sort((a, b) => a.block - b.block)
      .slice(0, limit);
    return { transfers, complete: transfers.length < limit };
  };
  const explorer: ExplorerSource = {
    oldestTransfers: (address, endBlock, limit) => page('txlist', address, endBlock, limit),
    oldestInternalTransfers: (address, endBlock, limit) => page('txlistinternal', address, endBlock, limit),
  };
  return { explorer, calls };
}

function fakeAccounts(states: Map<string, AccountState>) {
  const calls: { addresses: string[]; block: number }[] = [];
  return {
    calls,
    read: async (addresses: string[], block: number) => {
      calls.push({ addresses, block });
      return new Map(addresses.map((a): [string, AccountState] => [a, states.get(a) ?? { nonce: null, code: null }]));
    },
  };
}

async function run(wallets: string[], ledger: Transfer[], states: Map<string, AccountState>, failFor: string[] = []) {
  const { explorer, calls } = fakeExplorer(ledger, failFor);
  const accounts = fakeAccounts(states);
  const log: string[] = [];
  const rows = await runReplay(wallets, OPTIONS, { explorer, accounts, log: (line) => log.push(line) });
  return { rows, calls, accounts, log };
}

const addressesAsked = (calls: { address: string; limit: number }[], limit: number) =>
  calls.filter((c) => c.limit === limit).map((c) => c.address).sort();

describe('runReplay', () => {
  it('holds all 19 wallets 0x8439 funded under A4, asking for each hop address exactly once', async () => {
    const { rows, calls, accounts } = await run(FARM_CLAIMS, FARM_LEDGER, FARM_STATES);

    expect(rows.map((r) => r.wallet)).toEqual(FARM_CLAIMS);
    for (const row of rows) {
      expect(row.start).toEqual({ outcome: 'hold', rule: 'A4' });
      expect(row.facts.firstFunder).toMatchObject({ address: parseAddress(ROOT), kind: 'wallet', fanoutInList: 19 });
      expect(row.facts.missing).toEqual([]);
    }
    expect(rows.find((r) => r.wallet === FARM_WALLET)?.facts.firstFunder?.hopsTraced).toBe(3);

    expect(addressesAsked(calls, HOP_LIMIT)).toEqual([...HOP_ADDRESSES].sort());
    expect(addressesAsked(calls, WALLET_LIMIT)).toEqual([...FARM_CLAIMS].sort());
    expect(calls.filter((c) => c.action === 'txlistinternal')).toEqual([]);
    expect(accounts.calls).toHaveLength(1);
    expect([...(accounts.calls[0]?.addresses ?? [])].sort()).toEqual([...FARM_CLAIMS, ROOT].sort());
    expect(accounts.calls[0]?.block).toBe(SNAPSHOT_BLOCK);
  });

  it('gives a wallet whose read fails A1 and still holds the other 18, logging no URL or key', async () => {
    const broken = FARM_CLAIMS[5] as string;
    const { rows, log } = await run(FARM_CLAIMS, FARM_LEDGER, FARM_STATES, [broken]);

    expect(rows).toHaveLength(19);
    const brokenRow = rows.find((r) => r.wallet === broken);
    expect(brokenRow?.start).toEqual({ outcome: 'hold', rule: 'A1' });
    expect(brokenRow?.facts.missing).toEqual(['walletAgeDays', 'firstFunder']);
    for (const row of rows.filter((r) => r.wallet !== broken)) {
      expect(row.start).toEqual({ outcome: 'hold', rule: 'A4' });
      expect(row.facts.group?.size).toBe(18);
    }
    expect(log.some((line) => line.includes(broken))).toBe(true);
    for (const phase of ['wallets: ', 'internal transfers: ', 'funding trace pass 1: ', 'account states: ', 'destination pages: ', 'facts: ']) {
      expect(log.some((line) => line.startsWith(phase))).toBe(true);
    }
    for (const line of log) expect(line).not.toMatch(/http|apikey|K3YSECRET/i);
  });

  it('asks a failing hop address once and leaves the wallet above it without a funder', async () => {
    const { rows, calls } = await run(FARM_CLAIMS, FARM_LEDGER, FARM_STATES, [HOP_2]);

    expect(calls.filter((c) => c.address === HOP_2)).toHaveLength(1);
    expect(rows.find((r) => r.wallet === FARM_WALLET)?.start).toEqual({ outcome: 'hold', rule: 'A1' });
    expect(rows.find((r) => r.wallet === FARM_WALLET)?.facts.missing).toEqual(['firstFunder']);
    expect(rows.filter((r) => r.start.rule === 'A4')).toHaveLength(18);
  });

  it('asks for internal transfers only for the wallet with no external funding', async () => {
    const ledger = [
      ...FARM_LEDGER,
      send(PAYOUT_CONTRACT, INTERNALLY_FUNDED, 24_400_050, '1', 'internal'),
      send(INTERNALLY_FUNDED, STRANGER, 24_400_100, '0.1'),
    ];
    const states = new Map([...FARM_STATES, [INTERNALLY_FUNDED, eoa(40)], [PAYOUT_CONTRACT, { nonce: 1, code: '0x6080' }]]);
    const { rows, calls } = await run([...FARM_CLAIMS, INTERNALLY_FUNDED], ledger, states);

    expect(calls.filter((c) => c.action === 'txlistinternal').map((c) => c.address)).toEqual([INTERNALLY_FUNDED]);
    expect(rows.find((r) => r.wallet === INTERNALLY_FUNDED)?.facts.firstFunder).toMatchObject({
      address: parseAddress(PAYOUT_CONTRACT),
      kind: 'contract',
    });
  });

  describe('destination pages', () => {
    const EXCHANGE = synthetic('e0', 1);
    const SHARED = synthetic('d0', 1);
    const OTHER_SHARED = synthetic('d0', 2);
    const SWEEPERS = Array.from({ length: 5 }, (_, i) => synthetic('a0', i));
    const fundings = SWEEPERS.map((w, i) => send(EXCHANGE, w, 24_000_000 + i, '0.5'));
    const sweepsTo = (dest: string) => SWEEPERS.map((w, i) => send(w, dest, 24_100_000 + i, '0.49'));
    const strangerPayments = (dest: string) => Array.from({ length: 95 }, (_, i) => send(synthetic('5a', i), dest, 23_000_000 + i, '1'));
    const baseStates: [string, AccountState][] = [[EXCHANGE, { nonce: 20_000, code: '0x' }], ...SWEEPERS.map((w): [string, AccountState] => [w, eoa(120)])];
    const statesWith = (...extra: [string, AccountState][]) => new Map([...baseStates, ...extra]);
    const askedFor = (calls: { address: string }[], address: string) => calls.filter((c) => c.address === address);

    it('reads a page once per destination, at the wallet limit, and a private address still links', async () => {
      const ledger = [...fundings, ...sweepsTo(SHARED)];
      const { rows, calls, log } = await run(SWEEPERS, ledger, statesWith([SHARED, eoa(0)]));
      expect(askedFor(calls, SHARED)).toEqual([{ action: 'txlist', address: SHARED, limit: WALLET_LIMIT }]);
      expect(log.some((line) => line.startsWith('destination pages: 1/1'))).toBe(true);
      for (const row of rows) expect(row.start).toEqual({ outcome: 'exclude', rule: 'A3' });
    });

    it('reads each destination when wallets share more than one', async () => {
      const second = SWEEPERS.map((w, i) => send(w, OTHER_SHARED, 24_200_000 + i, '0.3'));
      const ledger = [...fundings, ...sweepsTo(SHARED), ...second];
      const { calls } = await run(SWEEPERS, ledger, statesWith([SHARED, eoa(0)], [OTHER_SHARED, eoa(0)]));
      expect(askedFor(calls, SHARED)).toHaveLength(1);
      expect(askedFor(calls, OTHER_SHARED)).toHaveLength(1);
    });

    it('lets a public address link nobody, so the wallets stay on A9', async () => {
      const ledger = [...strangerPayments(SHARED), ...fundings, ...sweepsTo(SHARED)];
      const { rows } = await run(SWEEPERS, ledger, statesWith([SHARED, eoa(48)]));
      for (const row of rows) {
        expect(row.facts.group).toBeNull();
        expect(row.facts.missing).toEqual([]);
        expect(row.start).toEqual({ outcome: 'full', rule: 'A9' });
      }
    });

    it.each([
      ['an exchange', { nonce: 20_000, code: '0x' }],
      ['a contract', { nonce: 1, code: '0x6080' }],
    ])('skips the page for %s', async (_name, state) => {
      const { rows, calls } = await run(SWEEPERS, [...fundings, ...sweepsTo(SHARED)], statesWith([SHARED, state]));
      expect(askedFor(calls, SHARED)).toEqual([]);
      for (const row of rows) expect(row.start).toEqual({ outcome: 'full', rule: 'A9' });
    });

    it('still reads the page when the destination state is unknown', async () => {
      const { calls, rows } = await run(SWEEPERS, [...fundings, ...sweepsTo(SHARED)], statesWith());
      expect(askedFor(calls, SHARED)).toHaveLength(1);
      for (const row of rows) expect(row.start).toEqual({ outcome: 'hold', rule: 'A1' });
    });

    it('leaves the wallets on A1 when the page read fails, logging no URL or key', async () => {
      const { rows, calls, log } = await run(SWEEPERS, [...fundings, ...sweepsTo(SHARED)], statesWith([SHARED, eoa(0)]), [SHARED]);
      expect(askedFor(calls, SHARED)).toHaveLength(1);
      for (const row of rows) {
        expect(row.start).toEqual({ outcome: 'hold', rule: 'A1' });
        expect(row.facts.missing).toEqual(['group']);
        expect(row.facts.group).toBeNull();
      }
      expect(log.some((line) => line.startsWith('destination pages: could not read') && line.includes(SHARED))).toBe(true);
      for (const line of log) expect(line).not.toMatch(/http|apikey|K3YSECRET/i);
    });
  });
});

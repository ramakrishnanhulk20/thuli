// Not covered here: a live RPC or Blockscout (no request leaves the machine: the RPC is stubbed, and the Blockscout replies
// are either built here or real ones saved on 10 Nov and cut to the fields read), whether Blockscout's internal index is
// complete for a given block range, and the group facts, which need a claim list.
import fs from 'node:fs';
import { keccak256, parseEther, toHex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeStart, DEFAULT_SETTINGS, parseAddress, SECONDS_PER_DAY, type AccountState, type Transfer, type TransferPage } from '@thuli/core';
import type { ExplorerSource } from '../src/chain/explorer.ts';
import { collectBasicFacts, type FactSources } from '../src/facts/basic.ts';
import { runReplay } from '../src/replay/runner.ts';
import { inSingleScope } from '../src/screen/single.ts';

const RPC = 'https://rpc.example.org/key';
const SCOUT = 'https://scout.example.org/api/v2';
const SOURCES: FactSources = { rpcUrl: RPC, blockscoutApi: SCOUT };

const SNAPSHOT_BLOCK = 24_600_000;
const SNAPSHOT_TIME = 1_772_000_000;
const synthetic = (tag: string, index: number) => `0x${tag}${index.toString(16).padStart(40 - tag.length, '0')}`;
const WALLET = synthetic('ab', 1);
const STRANGER = synthetic('5e', 1);
const EXCHANGE = synthetic('e0', 1);
const PAYOUT = synthetic('cc', 1);
const SHOP = synthetic('5b', 1);

function send(from: string, to: string, block: number, eth: string, daysAgo: number, kind: Transfer['kind'] = 'external'): Transfer {
  return {
    hash: keccak256(toHex(`${from}>${to}@${block}:${eth}`)),
    block,
    time: SNAPSHOT_TIME - daysAgo * SECONDS_PER_DAY - 60,
    from,
    to,
    valueWei: parseEther(eth).toString(),
    failed: false,
    kind,
  };
}

const touching = (ledger: Transfer[], address: string, kind: Transfer['kind']) =>
  ledger.filter((t) => t.kind === kind && (t.from === address || t.to === address)).sort((a, b) => a.block - b.block);

const iso = (time: number) => new Date(time * 1000).toISOString().replace('Z', '000Z');
const checksummed = (address: string) => ({ hash: parseAddress(address) });

/** Blockscout's two address lists for a ledger, newest first and two pages each, the way its v2 API serves them. */
function blockscoutReply(ledger: Transfer[], url: URL): unknown {
  const [, address, list] = /\/addresses\/(0x[0-9a-fA-F]{40})\/([a-z-]+)$/.exec(url.pathname) ?? [];
  const wallet = (address ?? '').toLowerCase();
  const items =
    list === 'transactions'
      ? touching(ledger, wallet, 'external').map((t) => ({
          hash: t.hash,
          block_number: t.block,
          timestamp: iso(t.time),
          status: 'ok',
          value: t.valueWei,
          from: checksummed(t.from),
          to: t.to === null ? null : checksummed(t.to),
        }))
      : touching(ledger, wallet, 'internal').map((t) => ({
          transaction_hash: t.hash,
          block_number: t.block,
          timestamp: iso(t.time),
          success: true,
          value: t.valueWei,
          from: checksummed(t.from),
          to: t.to === null ? null : checksummed(t.to),
        }));
  const newestFirst = items.reverse();
  if (url.searchParams.get('page') === '2') return { items: newestFirst.slice(1), next_page_params: null };
  return { items: newestFirst.slice(0, 1), next_page_params: newestFirst.length > 1 ? { page: 2 } : null };
}

interface ChainAt {
  block: number;
  time: number;
  nonce: number;
}

function rpcReply(method: string, at: ChainAt): unknown {
  if (method === 'eth_getBlockByNumber') {
    return { number: toHex(at.block), hash: `0x${'11'.repeat(32)}`, timestamp: toHex(at.time), transactions: [] };
  }
  if (method === 'eth_getTransactionCount') return toHex(at.nonce);
  if (method === 'eth_getCode') return '0x';
  throw new Error(`unexpected RPC method ${method}`);
}

/** Answers the RPC from `at` and Blockscout from `blockscout`, and records which Blockscout lists were asked for. */
function stubFetch(at: ChainAt, blockscout: (url: URL) => unknown) {
  const lists: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.href === RPC) {
      const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: rpcReply(method, at) }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    lists.push(url.pathname.split('/').at(-1) as string);
    return new Response(JSON.stringify(blockscout(url)), { headers: { 'content-type': 'application/json' } });
  });
  return lists;
}

const stubChain = (ledger: Transfer[]) =>
  stubFetch({ block: SNAPSHOT_BLOCK, time: SNAPSHOT_TIME, nonce: 120 }, (url) => blockscoutReply(ledger, url));

function explorerFor(ledger: Transfer[]): ExplorerSource {
  const page = async (kind: Transfer['kind'], address: string, limit: number): Promise<TransferPage> => {
    const transfers = touching(ledger, address, kind).slice(0, limit);
    return { transfers, complete: transfers.length < limit };
  };
  return {
    oldestTransfers: (address, _end, limit) => page('external', address, limit),
    oldestInternalTransfers: (address, _end, limit) => page('internal', address, limit),
  };
}

async function replayFacts(ledger: Transfer[]) {
  const states = new Map<string, AccountState>([[WALLET, { nonce: 120, code: '0x' }]]);
  const rows = await runReplay(
    [WALLET],
    { snapshotBlock: SNAPSHOT_BLOCK, snapshotTime: SNAPSHOT_TIME, settings: DEFAULT_SETTINGS, walletLimit: 100, hopLimit: 5 },
    {
      explorer: explorerFor(ledger),
      accounts: { read: async (addresses) => new Map(addresses.map((a) => [a, states.get(a) ?? { nonce: 1, code: '0x6080' }])) },
      log: () => {},
    },
  );
  return rows[0]?.facts;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('collectBasicFacts and the replay share one meaning of first funder and age (C20)', () => {
  it('dates a wallet from its real funding 3 days ago, not a zero-value transfer 400 days ago, in both', async () => {
    const funding = send(EXCHANGE, WALLET, 24_590_000, '1', 3);
    const ledger = [send(STRANGER, WALLET, 21_700_000, '0', 400), funding, send(WALLET, SHOP, 24_595_000, '0.4', 2)];
    stubChain(ledger);
    const basic = await collectBasicFacts(parseAddress(WALLET), { chain: 'ethereum', block: SNAPSHOT_BLOCK }, SOURCES);
    const replayed = await replayFacts(ledger);

    expect(basic.walletAgeDays).toBe(3);
    expect(replayed?.walletAgeDays).toBe(3);
    expect(basic.firstFunder?.address).toBe(parseAddress(EXCHANGE));
    expect(replayed?.firstFunder?.address).toBe(parseAddress(EXCHANGE));
    expect(basic.evidenceTxs).toEqual([funding.hash]);
    expect(basic.missing).toEqual(['group', 'sharedDepositAddress', 'claimPaidToOtherAddress']);
  });

  it('gives a wallet funded only by an internal transfer the same funder in both', async () => {
    const ledger = [send(PAYOUT, WALLET, 24_500_000, '2', 40, 'internal'), send(WALLET, SHOP, 24_510_000, '0.5', 38)];
    const lists = stubChain(ledger);
    const basic = await collectBasicFacts(parseAddress(WALLET), { chain: 'ethereum', block: SNAPSHOT_BLOCK }, SOURCES);
    const replayed = await replayFacts(ledger);

    expect(lists).toContain('internal-transactions');
    expect(basic.firstFunder?.address).toBe(parseAddress(PAYOUT));
    expect(replayed?.firstFunder?.address).toBe(parseAddress(PAYOUT));
    expect(basic.walletAgeDays).toBe(40);
    expect(replayed?.walletAgeDays).toBe(40);
  });

  it('leaves out transfers after the snapshot block and reads no internal list when external funding is found', async () => {
    const ledger = [send(EXCHANGE, WALLET, 24_590_000, '1', 3), send(PAYOUT, WALLET, SNAPSHOT_BLOCK + 5, '9', 0)];
    const lists = stubChain(ledger);
    const basic = await collectBasicFacts(parseAddress(WALLET), { chain: 'ethereum', block: SNAPSHOT_BLOCK }, SOURCES);
    expect(basic.firstFunder?.address).toBe(parseAddress(EXCHANGE));
    expect(lists).not.toContain('internal-transactions');
  });

  it('holds the funder and the age as unread when Blockscout fails, with no URL in the cause', async () => {
    const causes: string[] = [];
    vi.stubGlobal('fetch', async (input: string) =>
      input === RPC ? new Response(null, { status: 500 }) : new Response(JSON.stringify({ message: SCOUT }), { status: 503 }),
    );
    const facts = await collectBasicFacts(parseAddress(WALLET), { chain: 'ethereum', block: SNAPSHOT_BLOCK }, {
      ...SOURCES,
      onProblem: (_fact, cause) => causes.push(cause),
    });
    expect(facts).toMatchObject({ firstFunder: null, walletAgeDays: null, evidenceTxs: [] });
    expect(facts.missing).toEqual(expect.arrayContaining(['firstFunder', 'walletAgeDays']));
    for (const cause of causes) expect(cause).not.toMatch(/example\.org|key/);
  });
});

// Real Blockscout v2 replies read on 10 Nov 2026, cut to the fields basic.ts reads, and the finalized block the live
// screening of both wallets ran at, so these check the same facts that run printed.
const SAVED = new URL('./fixtures/blockscout/', import.meta.url);
const LIVE = { block: 26_385_328, time: 1_794_323_543 };
const FARM_WALLET = '0x041f77015fe51c51ae49a7f2f3ff86c641fa190a';
const OLD_WALLET = '0x59170d55bba35af1f1f9c3d6b1f678fbb68a760e';

interface SavedPage {
  items: { from: { hash: string } }[];
  next_page_params: Record<string, string | number> | null;
}

const savedPage = (wallet: string, list: string, page: number): SavedPage =>
  JSON.parse(fs.readFileSync(new URL(`${wallet}-${list}-${page}.json`, SAVED), 'utf8')) as SavedPage;

/** Serves the saved pages, refusing a second page asked for with anything but the first page's next_page_params. */
function stubSaved(nonce: number, edit: (list: string, page: SavedPage) => SavedPage = (_list, page) => page) {
  return stubFetch({ ...LIVE, nonce }, (url) => {
    const [, address, list] = /\/addresses\/(0x[0-9a-fA-F]{40})\/([a-z-]+)$/.exec(url.pathname) ?? [];
    const wallet = (address ?? '').toLowerCase();
    const first = savedPage(wallet, list as string, 1);
    if (url.search === '') return edit(list as string, first);
    const asked = new URLSearchParams(Object.entries(first.next_page_params ?? {}).map(([key, value]) => [key, String(value)]));
    if (url.searchParams.toString() !== asked.toString()) throw new Error('the second page was asked for with other parameters');
    return edit(list as string, savedPage(wallet, list as string, 2));
  });
}

const atLive = (wallet: string, sources: FactSources = SOURCES) =>
  collectBasicFacts(parseAddress(wallet), { chain: 'ethereum', block: LIVE.block }, sources);

describe('collectBasicFacts on saved Blockscout replies', () => {
  it('finds the ROBO farm wallet funded by 0x02dd in 0xf5d6...806, 261 days old, and starts it on A8 for 3 transactions', async () => {
    const lists = stubSaved(3);
    const facts = await atLive(FARM_WALLET);
    expect(facts).toMatchObject({ walletAgeDays: 261, txCountAtSnapshot: 3, accountType: 'eoa' });
    expect(facts.firstFunder).toEqual({ address: parseAddress('0x02dd2aee26986d6b86fb2bfb98e105cd1a661fdb'), kind: 'unknown', fanoutInList: null, hopsTraced: 1 });
    expect(facts.evidenceTxs).toEqual(['0xf5d6490c5f3c18c05e6c791e9f22ec0a8341bea2a1fb035e6caba2b3b8afd806']);
    expect(lists).toEqual(['transactions']);
    expect(computeStart(inSingleScope(facts), DEFAULT_SETTINGS)).toEqual({ outcome: 'partial', rule: 'A8' });
  });

  it('reads an older wallet across both saved pages, 1352 days old with 56 transactions, and starts it on A9', async () => {
    const lists = stubSaved(56);
    const facts = await atLive(OLD_WALLET);
    expect(facts).toMatchObject({ walletAgeDays: 1352, txCountAtSnapshot: 56 });
    expect(facts.firstFunder?.address).toBe(parseAddress('0xbad33970371a32f29159fe6e25d59ef7e9160f7a'));
    expect(facts.evidenceTxs).toEqual(['0x4e21f84de7cb81e053f2c47e86c8e141725ebff4739010af9d88ad0543a5e79f']);
    expect(lists).toEqual(['transactions', 'transactions']);
    expect(computeStart(inSingleScope(facts), DEFAULT_SETTINGS)).toEqual({ outcome: 'full', rule: 'A9' });
  });

  it('parses the saved internal-transactions reply when the external list shows no funding', async () => {
    const causes: string[] = [];
    const ownSendsOnly = (list: string, page: SavedPage) =>
      list === 'transactions' ? { ...page, items: page.items.filter((item) => item.from.hash.toLowerCase() === OLD_WALLET) } : page;
    const lists = stubSaved(56, ownSendsOnly);
    const facts = await atLive(OLD_WALLET, { ...SOURCES, onProblem: (_fact, cause) => causes.push(cause) });
    expect(lists).toContain('internal-transactions');
    // Its five internal inflows all came after its first send, so nothing funded it, and nothing failed to parse.
    expect(causes).toEqual(['no incoming value transfer at or before the wallet first sent']);
    expect(facts.walletAgeDays).not.toBeNull();
  });
});

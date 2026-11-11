// Not covered here: a live RPC or Blockscout. Every request is answered in this process, by stand-in readers or a stubbed
// fetch, so whether Base's keyed Blockscout really answers in this shape, sorts oldest first and accepts the header is
// left to the live rehearsal. The single-chain screening paths are campaignWorker.test.ts; the full facts reader is
// basic.test.ts.
import { keccak256, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  askMessage,
  CURRENT_RULEBOOK,
  GRAPH_G1,
  HIGH_VOLUME_NONCE,
  parseAddress,
  type AccountState,
  type Address,
  type Facts,
  type GraphAnswer,
  type GraphRecord,
  type ScreenedChain,
} from '@thuli/core';
import { addAsk, createCampaign, getAsk, migrate, openMemoryDb, type CampaignInput, type Db } from '@thuli/store';
import {
  BASE_HISTORY_OFF,
  firstActivityOn,
  PICK_TIME_LIMIT_MS,
  PICK_TRANSACTION_PAGES,
  pickChain,
  screenChains,
  type ChainReader,
  type ChainReaders,
  type FirstActivity,
} from '../src/campaign/chain.ts';
import { loadWorkerConfig } from '../src/campaign/config.ts';
import {
  CAMPAIGN_SCREEN_CAUSES,
  MAX_ASK_ATTEMPTS,
  NEVER_USED_ON_EITHER_REASON,
  NEVER_USED_REASON,
  retryDelaySeconds,
  screenNextAsk,
  type ScreenDeps,
  type ScreenOutcome,
} from '../src/campaign/screen.ts';
import { emptyChainMemory } from '../src/campaign/vault.ts';
import { collectBasicFacts, MAX_FUNDING_PAGES, type FactSources } from '../src/facts/basic.ts';
import type { DecideDeps } from '../src/replay/decide.ts';
import type { ServReply } from '../src/serv/client.ts';

const WALLET = parseAddress(`0x${'a7'.repeat(20)}`);
const STRANGER = `0x${'5e'.repeat(20)}`;
const FUNDER = `0x${'f1'.repeat(20)}`;
const KEY = 'proapi_test-key-not-real-7f3a9c41';

interface ChainAt {
  rpc: string;
  scout: string;
  finalized: number;
  time: number;
}
const BASE: ChainAt = { rpc: 'https://base-rpc.example.org/rpc-key-1', scout: 'https://base-scout.example.org/8453/api/v2', finalized: 38_000_000, time: 1_794_000_000 };
const BASE_SOURCES: FactSources = { rpcUrl: BASE.rpc, blockscoutApi: BASE.scout };

/** A block's time on a chain with 2 second blocks that reaches `at.time` at its finalized block. */
const timeOf = (at: ChainAt, block: number) => at.time - (at.finalized - block) * 2;

type Row = Record<string, unknown>;

function txRow(at: ChainAt, block: number, from: string, to: string, wei: string): Row {
  return {
    hash: keccak256(toHex(`tx ${block} ${from} ${to} ${wei}`)),
    block_number: block,
    timestamp: new Date(timeOf(at, block) * 1000).toISOString(),
    status: 'ok',
    value: wei,
    from: { hash: from },
    to: { hash: to },
  };
}

function internalRow(at: ChainAt, block: number, from: string, to: string, wei: string): Row {
  return {
    transaction_hash: keccak256(toHex(`internal ${block} ${from} ${to} ${wei}`)),
    block_number: block,
    timestamp: new Date(timeOf(at, block) * 1000).toISOString(),
    success: true,
    value: wei,
    from: { hash: from },
    to: { hash: to },
  };
}

const spam = (at: ChainAt, block: number) => txRow(at, block, STRANGER, WALLET, '0');
const funding = (at: ChainAt, block: number) => txRow(at, block, FUNDER, WALLET, '1000000000000000');

/** Pages of one address's two lists, served by a `page` cursor; every page but the last names the next one. */
interface Lists {
  transactions: Row[][];
  internal: Row[][];
}

function scoutReply(lists: Lists, url: URL, echo: Record<string, string>): unknown {
  const pages = url.pathname.endsWith('/internal-transactions') ? lists.internal : lists.transactions;
  const page = Number(url.searchParams.get('page') ?? '1');
  const items = pages[page - 1] ?? [];
  return { items, next_page_params: page < pages.length ? { page: page + 1, items_count: 50, ...echo } : null };
}

interface Seen {
  url: string;
  headers: Headers;
  body: string;
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function rpcReply(at: ChainAt, method: string, params: unknown[], nonces: Record<string, number>): unknown {
  if (method === 'eth_getBlockByNumber') {
    const block = params[0] === 'finalized' ? at.finalized : Number(params[0]);
    return { number: toHex(block), hash: `0x${'11'.repeat(32)}`, timestamp: toHex(timeOf(at, block)), transactions: [] };
  }
  if (method === 'eth_getTransactionCount') return toHex(nonces[String(params[0]).toLowerCase()] ?? 0);
  if (method === 'eth_getCode') return '0x';
  throw new Error(`unexpected RPC method ${method}`);
}

/**
 * Answers each chain's RPC and Blockscout from `served`, keyed by the chain's RPC URL, and records every request: its URL,
 * its headers and its body. A Blockscout answer may be a Response, to fail a read.
 */
function stubFetch(
  served: { at: ChainAt; lists: (url: URL) => Lists | Response; nonces?: Record<string, number>; echo?: Record<string, string> }[],
): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? init.body : '';
    seen.push({ url: href, headers: new Headers(init?.headers), body });
    const url = new URL(href);
    for (const { at, lists, nonces, echo } of served) {
      if (href === at.rpc) {
        const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
        return json({ jsonrpc: '2.0', id, result: rpcReply(at, method, params, nonces ?? {}) });
      }
      if (href.startsWith(`${at.scout}/`)) {
        const answer = lists(url);
        return answer instanceof Response ? answer : json(scoutReply(answer, url, echo ?? {}));
      }
    }
    throw new Error('a request went to a host no test serves');
  });
  return seen;
}

const scoutCalls = (seen: Seen[], list: 'transactions' | 'internal-transactions') =>
  seen.filter((request) => new URL(request.url).pathname.endsWith(`/${list}`));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('firstActivityOn', () => {
  it('sends sort and order on every transactions page, and reads a second page when the first holds only zero-value spam (C15, C20)', async () => {
    const seen = stubFetch([
      { at: BASE, lists: () => ({ transactions: [[spam(BASE, 100), spam(BASE, 101)], [funding(BASE, 200)], [funding(BASE, 300)]], internal: [[]] }) },
    ]);
    expect(await firstActivityOn('base', WALLET, BASE_SOURCES)).toEqual({ time: timeOf(BASE, 200), block: BASE.finalized });
    const pages = scoutCalls(seen, 'transactions');
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      const query = new URL(page.url).searchParams;
      expect([query.get('sort'), query.get('order')]).toEqual(['block_number', 'asc']);
    }
    expect(new URL(pages[1]?.url as string).searchParams.get('page')).toBe('2');
    for (const page of scoutCalls(seen, 'internal-transactions')) expect(new URL(page.url).searchParams.has('sort')).toBe(false);
  });

  it('dates the wallet by an internal transfer older than its first transaction, and counts nothing after the finalized block', async () => {
    stubFetch([{ at: BASE, lists: () => ({ transactions: [[funding(BASE, 500)]], internal: [[internalRow(BASE, 400, FUNDER, WALLET, '7')]] }) }]);
    expect(await firstActivityOn('base', WALLET, BASE_SOURCES)).toEqual({ time: timeOf(BASE, 400), block: BASE.finalized });

    const late = BASE.finalized + 3;
    stubFetch([{ at: BASE, lists: () => ({ transactions: [[funding(BASE, late)]], internal: [[internalRow(BASE, late, FUNDER, WALLET, '7')]] }) }]);
    expect(await firstActivityOn('base', WALLET, BASE_SOURCES)).toEqual({ time: null, block: BASE.finalized });
  });

  it(`answers unknown at the ${PICK_TRANSACTION_PAGES} transaction page cap and the ${MAX_FUNDING_PAGES} internal page cap (C11, C41)`, async () => {
    const spamPages = Array.from({ length: 6 }, (_, page) => [spam(BASE, 100 + page)]);
    const capped = stubFetch([{ at: BASE, lists: () => ({ transactions: spamPages, internal: [[]] }) }]);
    expect(await firstActivityOn('base', WALLET, BASE_SOURCES)).toBe('unknown');
    expect(scoutCalls(capped, 'transactions')).toHaveLength(PICK_TRANSACTION_PAGES);

    const internalPages = Array.from({ length: MAX_FUNDING_PAGES + 5 }, () => []);
    const deep = stubFetch([{ at: BASE, lists: () => ({ transactions: [[funding(BASE, 200)]], internal: internalPages }) }]);
    expect(await firstActivityOn('base', WALLET, BASE_SOURCES)).toBe('unknown');
    expect(scoutCalls(deep, 'internal-transactions')).toHaveLength(MAX_FUNDING_PAGES);
  });

  it('answers unknown, never throwing, for a list served newest first, a failed or malformed reply, and a failed block read (C11)', async () => {
    const answers: ((url: URL) => Lists | Response)[] = [
      () => ({ transactions: [[funding(BASE, 300), funding(BASE, 200)]], internal: [[]] }),
      () => new Response('busy', { status: 503 }),
      () => json({ items: 'not a list', next_page_params: null }) as Response,
    ];
    for (const lists of answers) {
      stubFetch([{ at: BASE, lists }]);
      expect(await firstActivityOn('base', WALLET, BASE_SOURCES)).toBe('unknown');
    }
    vi.stubGlobal('fetch', async () => new Response(null, { status: 500 }));
    expect(await firstActivityOn('base', WALLET, BASE_SOURCES)).toBe('unknown');
  });
});

function picker(reads: Partial<Record<'ethereum' | 'base', FirstActivity | Error>>) {
  const signals: AbortSignal[] = [];
  const reader = (chain: 'ethereum' | 'base'): Pick<ChainReader, 'firstActivity'> => ({
    firstActivity: async (_wallet, signal) => {
      if (signal !== undefined) signals.push(signal);
      const read = reads[chain];
      if (read === undefined) return new Promise<FirstActivity>(() => undefined);
      if (read instanceof Error) throw read;
      return read;
    },
  });
  return { deps: { ethereum: reader('ethereum'), base: reader('base') }, signals };
}

describe('pickChain', () => {
  it('picks the chain with the older first activity, the only chain with any, and an exact tie as Ethereum, with both blocks', async () => {
    const blocks = { ethereum: 24_000_000, base: 38_000_000 };
    const at = (ethereum: number | null, base: number | null) =>
      pickChain(WALLET, picker({ ethereum: { time: ethereum, block: blocks.ethereum }, base: { time: base, block: blocks.base } }).deps);
    expect(await at(1_000, 2_000)).toEqual({ chain: 'ethereum', blocks });
    expect(await at(2_000, 1_000)).toEqual({ chain: 'base', blocks });
    expect(await at(null, 5)).toEqual({ chain: 'base', blocks });
    expect(await at(5, null)).toEqual({ chain: 'ethereum', blocks });
    expect(await at(7, 7)).toEqual({ chain: 'ethereum', blocks });
    expect(await at(null, null)).toEqual({ chain: null, blocks });
  });

  it('answers unknown when either chain is unknown or its reader throws, whatever the other chain holds (C11)', async () => {
    const read = { time: 1_000, block: 10 };
    expect(await pickChain(WALLET, picker({ ethereum: read, base: 'unknown' }).deps)).toBe('unknown');
    expect(await pickChain(WALLET, picker({ ethereum: 'unknown', base: read }).deps)).toBe('unknown');
    expect(await pickChain(WALLET, picker({ ethereum: read, base: new Error('https://rpc.example/secret') }).deps)).toBe('unknown');
    expect(await pickChain(WALLET, picker({ ethereum: { time: -1, block: 10 }, base: read }).deps)).toBe('unknown');
  });

  it(`answers unknown after ${PICK_TIME_LIMIT_MS} ms with a chain still unread, and tells both reads to stop (C41)`, async () => {
    vi.useFakeTimers();
    const { deps, signals } = picker({ ethereum: { time: 1_000, block: 10 } });
    let settled: unknown = 'waiting';
    const pending = pickChain(WALLET, deps).then((value) => {
      settled = value;
    });
    await vi.advanceTimersByTimeAsync(PICK_TIME_LIMIT_MS - 1);
    expect(settled).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe('unknown');
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

describe('the Blockscout key', () => {
  it('goes out only in the authorization header of Blockscout requests, never in a URL, the RPC or a cursor it echoes (C40)', async () => {
    const seen = stubFetch([
      {
        at: BASE,
        echo: { apikey: KEY, key: KEY },
        lists: () => ({ transactions: [[spam(BASE, 100)], [funding(BASE, 200)]], internal: [[], []] }),
      },
    ]);
    expect(await firstActivityOn('base', WALLET, { ...BASE_SOURCES, apiKey: KEY })).toEqual({ time: timeOf(BASE, 200), block: BASE.finalized });
    const scout = seen.filter((request) => request.url.startsWith(BASE.scout));
    expect(scout.length).toBe(4);
    for (const request of scout) expect(request.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    // The cursor still moves the page on; only its echoed key is dropped.
    expect(scout.filter((request) => new URL(request.url).searchParams.get('page') === '2')).toHaveLength(2);
    for (const request of seen) expect(request.url).not.toContain(KEY);
    for (const request of seen.filter((one) => one.url === BASE.rpc)) {
      expect(request.headers.get('authorization')).toBeNull();
      expect(request.body).not.toContain(KEY);
    }
  });

  it('puts the key in no error cause and no fact when Base answers a refusal that quotes it (C40)', async () => {
    const causes: string[] = [];
    const seen = stubFetch([{ at: BASE, lists: () => json({ error: `Unauthorized key ${KEY}` }, 401) as Response }]);
    const facts: Facts = await collectBasicFacts(WALLET, { chain: 'base', block: BASE.finalized }, {
      ...BASE_SOURCES,
      apiKey: KEY,
      onProblem: (_fact, cause) => causes.push(cause),
    });
    expect(causes).toContain('transaction history read failed (Blockscout answered with status 401)');
    for (const text of [...causes, JSON.stringify(facts), ...seen.map((request) => request.url)]) expect(text).not.toContain(KEY);
    // The full facts read on Base asks Base's RPC, not Ethereum's.
    expect(seen.some((request) => request.url === BASE.rpc)).toBe(true);
    expect(await firstActivityOn('base', WALLET, { ...BASE_SOURCES, apiKey: KEY })).toBe('unknown');
  });
});

const CAMPAIGN = 'two-chains';
const NOW = new Date('2026-11-11T12:00:00.000Z');
const BLOCKS: Readonly<Record<ScreenedChain, number>> = { ethereum: 24_000_000, base: 38_000_000 };
const HASH = `0x${'ab'.repeat(32)}`;
const WALLET_STATE: AccountState = { nonce: 12, code: '0x' };
const SINGLE_READ_MISSING: Facts['missing'] = ['group', 'sharedDepositAddress', 'claimPaidToOtherAddress'];

let db: Db;
let clock: Date;
let lines: string[];

function terms(): CampaignInput {
  return {
    id: CAMPAIGN,
    name: 'Two chains',
    chain: 84532,
    vault: parseAddress(`0x${'a1'.repeat(20)}`),
    token: parseAddress(`0x${'70'.repeat(20)}`),
    owner: parseAddress(`0x${'0e'.repeat(20)}`),
    agent: parseAddress(`0x${'ad'.repeat(20)}`),
    rewardPerWallet: '1000000',
    perWalletCap: '1000000',
    partialShareBps: 5000,
    maxSlots: 3,
    rulebook: CURRENT_RULEBOOK,
    settings: { groupMinSize: 2, funderFanoutMin: 2 },
    status: 'open',
    opensAt: new Date(NOW.getTime() - 3_600_000),
    closesAt: new Date(NOW.getTime() + 86_400_000),
    createdAt: NOW,
    vaultBlock: null,
  };
}

// What collectBasicFacts reads for an old, active wallet: the facts that need a list are null and named in missing.
function basicRead(funder: Address, overrides: Partial<Facts> = {}): Facts {
  return {
    walletAgeDays: 400,
    txCountAtSnapshot: 50,
    accountType: 'eoa',
    firstFunder: { address: funder, kind: 'unknown', fanoutInList: null, hopsTraced: 1 },
    group: null,
    sharedDepositAddress: null,
    fundingBurst: null,
    claimPaidToOtherAddress: null,
    evidenceTxs: [HASH],
    missing: [...SINGLE_READ_MISSING],
    ...overrides,
  };
}

// What collectBasicFacts reads for a wallet that never sent or received anything.
const neverUsed = (): Facts =>
  basicRead(freshAddress(), { walletAgeDays: 0, txCountAtSnapshot: 0, firstFunder: null, evidenceTxs: [], missing: [...SINGLE_READ_MISSING, 'firstFunder'] });

const freshAddress = () => privateKeyToAccount(generatePrivateKey()).address;

/** One chain as the screening reads it, through the ChainReader shape, with every full facts and state read recorded. */
class StandInChain implements ChainReader {
  /** Each wallet's first activity answers, oldest first; the last one repeats. A wallet not listed has none. */
  readonly history = new Map<Address, FirstActivity[]>();
  readonly own = new Map<Address, Facts>();
  readonly states = new Map<Address, AccountState>();
  readonly factsRead: { wallet: Address; block: number }[] = [];
  readonly statesRead: Address[] = [];
  readonly block: number;

  constructor(block: number) {
    this.block = block;
  }

  /** The wallet first active at `time` on this chain, null for never, with the facts its full read gives. */
  holds(wallet: Address, time: number | null, facts?: Facts): this {
    this.history.set(wallet, [{ time, block: this.block }]);
    if (facts !== undefined) this.own.set(wallet, facts);
    return this;
  }

  async firstActivity(wallet: Address): Promise<FirstActivity> {
    const answers = this.history.get(wallet) ?? [{ time: null, block: this.block }];
    return (answers.length > 1 ? answers.shift() : answers[0]) as FirstActivity;
  }

  async facts(wallet: Address, block: number): Promise<Facts> {
    this.factsRead.push({ wallet, block });
    const facts = this.own.get(wallet);
    if (facts === undefined) throw new Error('no facts for this wallet on this chain');
    return facts;
  }

  async accountState(address: Address): Promise<AccountState> {
    this.statesRead.push(address);
    return this.states.get(address) ?? WALLET_STATE;
  }
}

function reply(answer: GraphAnswer): ServReply {
  const rawText = JSON.stringify(answer);
  return { requestId: 'run-1', rawText, answer: rawText, answerProblem: null, usage: { inputTokens: 900, outputTokens: 60 } };
}

// A SERV that confirms the code's start, the answer the rulebook says is usually right.
function confirmingServ() {
  const confirm = async (record: GraphRecord) => {
    GRAPH_G1.toInput(record);
    return reply({ verdict: 'ordinary_user', action: record.start_outcome, rule: record.start_rule, reason: 'The facts match the start.', cited_tx_hashes: [] });
  };
  return { viaGraph: vi.fn(confirm), viaV2: vi.fn(confirm), sleep: vi.fn(async () => undefined) } satisfies DecideDeps;
}

const modelCalls = (serv: ReturnType<typeof confirmingServ>) => serv.viaGraph.mock.calls.length + serv.viaV2.mock.calls.length;

/**
 * Screen deps on the two stand-in chains, or with Base history off when chains is undefined. The Ethereum-only readers
 * read `ethereumOnly` and record each call, so a test can show they are never called while Base history is on.
 */
function screenDeps(chains: ChainReaders | undefined, serv: DecideDeps, ethereumOnly = new Map<Address, Facts>()) {
  const deps = {
    db,
    facts: vi.fn(async (wallet: Address) => {
      const facts = ethereumOnly.get(wallet);
      if (facts === undefined) throw new Error('no facts for this wallet');
      return facts;
    }),
    accountState: vi.fn(async (_address: Address) => WALLET_STATE),
    ...(chains === undefined ? {} : { chains }),
    serv,
    now: () => clock,
    log: (line: string) => lines.push(line),
    memory: emptyChainMemory(),
  };
  return deps satisfies ScreenDeps;
}

/** Signs and queues one ask from a fresh key, a second later than the one before so the queue order is known. */
async function ask(): Promise<Address> {
  const account = privateKeyToAccount(generatePrivateKey());
  const signedAt = Math.floor(clock.getTime() / 1000);
  const signature = await account.signMessage({ message: askMessage({ campaignId: CAMPAIGN, wallet: account.address, signedAt }) });
  expect(await addAsk(db, { campaignId: CAMPAIGN, wallet: account.address, signedAt, signature }, clock)).toBe('queued');
  clock = new Date(clock.getTime() + 1000);
  return account.address;
}

/** Screens until no ask is waiting, moving the clock past the longest retry delay whenever the only asks left wait. */
async function screenAll(deps: ScreenDeps): Promise<ScreenOutcome[]> {
  const outcomes: ScreenOutcome[] = [];
  for (let step = 0; step < 100; step += 1) {
    const outcome = await screenNextAsk(deps);
    if (outcome.kind !== 'idle') {
      outcomes.push(outcome);
      continue;
    }
    const [row] = await db.query<{ waiting: number }>("SELECT count(*)::int AS waiting FROM asks WHERE status = 'queued'");
    if ((row?.waiting ?? 0) === 0) return outcomes;
    clock = new Date(clock.getTime() + retryDelaySeconds(MAX_ASK_ATTEMPTS) * 1000);
  }
  throw new Error('the asks never settled');
}

/** A worker environment with every required name and no Base setting, so Base history is off. */
const ENV = {
  DATABASE_URL: 'postgres://thuli:hunter2-long-secret@db.example.com:5432/thuli',
  WORKER_PRIVATE_KEY: `0x${'5a'.repeat(32)}`,
  SERV_API_KEY: 'sk-serv-not-a-real-key',
  SERV_BASE_URL: 'https://inference-api.openserv.ai/v1',
  SERV_GRAPH_ID: GRAPH_G1.graphId,
  ETH_RPC_URL: 'https://eth.example.com/v1/rpc-key-123456',
  BLOCKSCOUT_ETH_API: 'https://eth.blockscout.com/api/v2',
  BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
};

function twoChains() {
  const ethereum = new StandInChain(BLOCKS.ethereum);
  const base = new StandInChain(BLOCKS.base);
  return { ethereum, base, chains: { ethereum, base } satisfies ChainReaders };
}

describe('screening an ask on the chain with the older history', () => {
  beforeEach(async () => {
    db = await openMemoryDb();
    await migrate(db);
    clock = NOW;
    lines = [];
    await createCampaign(db, terms());
  });

  afterEach(async () => {
    await db.close();
  });

  it('screens a wallet used only on Base on Base, its facts read at the block the picker read Base at (a)', async () => {
    const { ethereum, base, chains } = twoChains();
    const wallet = await ask();
    const funder = freshAddress();
    base.holds(wallet, 1_700_000_000, basicRead(funder));
    const serv = confirmingServ();
    const deps = screenDeps(chains, serv);
    expect(await screenNextAsk(deps)).toMatchObject({ kind: 'decided', action: 'full', rule: 'A9' });
    expect(await getAsk(db, CAMPAIGN, wallet)).toMatchObject({ facts: { chain: 'base', funder: { address: funder } } });
    expect(base.factsRead).toEqual([{ wallet, block: BLOCKS.base }]);
    expect(ethereum.factsRead).toEqual([]);
    expect(deps.facts).not.toHaveBeenCalled();
    expect(modelCalls(serv)).toBe(1);
  });

  it('screens a wallet used only on Ethereum on Ethereum, with no full Base read (b)', async () => {
    const { ethereum, base, chains } = twoChains();
    const wallet = await ask();
    ethereum.holds(wallet, 1_600_000_000, basicRead(freshAddress()));
    const deps = screenDeps(chains, confirmingServ());
    expect(await screenNextAsk(deps)).toMatchObject({ kind: 'decided', action: 'full' });
    expect(await getAsk(db, CAMPAIGN, wallet)).toMatchObject({ facts: { chain: 'ethereum' } });
    expect(ethereum.factsRead).toEqual([{ wallet, block: BLOCKS.ethereum }]);
    expect(base.factsRead).toEqual([]);
    expect(base.statesRead).toEqual([]);
    expect(deps.facts).not.toHaveBeenCalled();
  });

  it('screens a wallet used on both on the chain it was active on first, either way round (c, d)', async () => {
    const { ethereum, base, chains } = twoChains();
    const ethereumFirst = await ask();
    const baseFirst = await ask();
    ethereum.holds(ethereumFirst, 1_500_000_000, basicRead(freshAddress())).holds(baseFirst, 1_650_000_000, basicRead(freshAddress()));
    base.holds(ethereumFirst, 1_600_000_000, basicRead(freshAddress())).holds(baseFirst, 1_550_000_000, basicRead(freshAddress()));
    await screenAll(screenDeps(chains, confirmingServ()));
    expect(ethereum.factsRead).toEqual([{ wallet: ethereumFirst, block: BLOCKS.ethereum }]);
    expect(base.factsRead).toEqual([{ wallet: baseFirst, block: BLOCKS.base }]);
    expect(await getAsk(db, CAMPAIGN, ethereumFirst)).toMatchObject({ status: 'decided', action: 'full', facts: { chain: 'ethereum' } });
    expect(await getAsk(db, CAMPAIGN, baseFirst)).toMatchObject({ status: 'decided', action: 'full', facts: { chain: 'base' } });
  });

  it('holds a wallet used on neither chain by code, with the two-chain reason and no model call (e)', async () => {
    const { ethereum, base, chains } = twoChains();
    const wallet = await ask();
    ethereum.holds(wallet, null, neverUsed());
    base.holds(wallet, null, neverUsed());
    const serv = confirmingServ();
    expect(await screenNextAsk(screenDeps(chains, serv))).toMatchObject({ kind: 'decided', action: 'hold', rule: 'A1', slot: null, servRequestId: null });
    expect(await getAsk(db, CAMPAIGN, wallet)).toMatchObject({ action: 'hold', rule: 'A1', reason: NEVER_USED_ON_EITHER_REASON, facts: { chain: 'ethereum' } });
    expect(NEVER_USED_ON_EITHER_REASON).toBe('A1: This wallet has never been used on Ethereum or Base, so there is nothing to screen.');
    expect(modelCalls(serv)).toBe(0);
    // The stored facts rest on a real read: Ethereum's, at the block the picker read Ethereum at. Base is never read in full.
    expect(ethereum.factsRead).toEqual([{ wallet, block: BLOCKS.ethereum }]);
    expect(base.factsRead).toEqual([]);
  });

  it('decides nothing while Base cannot be read, even with Ethereum history, and decides on the next try once it can (f, C11)', async () => {
    const { ethereum, base, chains } = twoChains();
    const wallet = await ask();
    ethereum.holds(wallet, 1_600_000_000, basicRead(freshAddress()));
    base.history.set(wallet, ['unknown', { time: 1_500_000_000, block: BLOCKS.base }]);
    base.own.set(wallet, basicRead(freshAddress()));
    const serv = confirmingServ();
    const deps = screenDeps(chains, serv);

    expect(await screenNextAsk(deps)).toMatchObject({ kind: 'released', cause: CAMPAIGN_SCREEN_CAUSES.chains, status: 'queued' });
    expect(CAMPAIGN_SCREEN_CAUSES.chains).toBe("the wallet's history could not be read on both chains");
    expect(await getAsk(db, CAMPAIGN, wallet)).toMatchObject({ status: 'queued', action: null, facts: null });
    expect([...ethereum.factsRead, ...base.factsRead]).toEqual([]);
    expect(modelCalls(serv)).toBe(0);
    expect(lines).toEqual([`screen ${CAMPAIGN} ${wallet}: not decided, ${CAMPAIGN_SCREEN_CAUSES.chains}; queued again, next try in ${retryDelaySeconds(1)} s`]);

    clock = new Date(clock.getTime() + retryDelaySeconds(1) * 1000);
    expect(await screenNextAsk(deps)).toMatchObject({ kind: 'decided', action: 'full' });
    expect(base.factsRead).toEqual([{ wallet, block: BLOCKS.base }]);
  });

  it("reads the first funder's kind on the chosen chain only, never the other (g, C16)", async () => {
    const { ethereum, base, chains } = twoChains();
    const onBase = await ask();
    const onEthereum = await ask();
    const funder = freshAddress();
    // One funder that is an exchange on Base and a contract on Ethereum: each ask's stored kind shows which chain was read.
    base.states.set(funder, { nonce: HIGH_VOLUME_NONCE, code: '0x' });
    ethereum.states.set(funder, { nonce: 1, code: '0x6080604052348015600f57600080fd5b50' });
    base.holds(onBase, 1_500_000_000, basicRead(funder));
    ethereum.holds(onBase, 1_600_000_000, basicRead(funder));
    ethereum.holds(onEthereum, 1_500_000_000, basicRead(funder));
    base.holds(onEthereum, 1_600_000_000, basicRead(funder));
    const deps = screenDeps(chains, confirmingServ());
    await screenAll(deps);
    expect(await getAsk(db, CAMPAIGN, onBase)).toMatchObject({ facts: { funder: { address: funder, kind: 'exchange' } } });
    expect(await getAsk(db, CAMPAIGN, onEthereum)).toMatchObject({ facts: { funder: { address: funder, kind: 'contract' } } });
    expect(base.statesRead).toEqual([funder]);
    expect(ethereum.statesRead).toEqual([funder]);
    expect(deps.accountState).not.toHaveBeenCalled();
  });

  it('links two asks screened on different chains whose first funder is one ordinary address (h, C15)', async () => {
    const { ethereum, base, chains } = twoChains();
    const funder = freshAddress();
    const onBase = await ask();
    const onEthereum = await ask();
    base.holds(onBase, 1_500_000_000, basicRead(funder));
    ethereum.holds(onEthereum, 1_500_000_000, basicRead(funder));
    await screenAll(screenDeps(chains, confirmingServ()));
    expect(await getAsk(db, CAMPAIGN, onBase)).toMatchObject({
      action: 'full',
      facts: { chain: 'base', groupSize: null, funder: { address: funder, kind: 'wallet', fanout: 1 } },
    });
    expect(await getAsk(db, CAMPAIGN, onEthereum)).toMatchObject({
      action: 'hold',
      rule: 'A4',
      facts: { chain: 'ethereum', groupSize: 2, funder: { address: funder, kind: 'wallet', fanout: 2 } },
    });
  });

  it('keeps the Blockscout key out of every URL, log line, error and stored value through a real screening on Base (j, C40)', async () => {
    const ETH: ChainAt = { rpc: 'https://eth-rpc.example.org/rpc-key-2', scout: 'https://eth-scout.example.org/api/v2', finalized: 24_000_000, time: 1_794_000_100 };
    const wallet = await ask();
    const funder = freshAddress();
    const rows = [txRow(BASE, 18_000_000, funder, wallet, '1000000000000000'), txRow(BASE, 28_000_000, wallet, STRANGER, '1')];
    let refuseOnce = true;
    const seen = stubFetch([
      { at: ETH, lists: () => ({ transactions: [[]], internal: [[]] }) },
      {
        at: BASE,
        nonces: { [wallet.toLowerCase()]: 50, [funder.toLowerCase()]: 12 },
        echo: { apikey: KEY },
        lists: (url) => {
          if (refuseOnce) {
            refuseOnce = false;
            return json({ message: `key ${KEY} is not allowed here` }, 500) as Response;
          }
          const ascending = url.searchParams.get('order') === 'asc';
          return { transactions: [ascending ? rows : [...rows].reverse()], internal: [[]] };
        },
      },
    ]);
    const config = loadWorkerConfig({
      ...ENV,
      ETH_RPC_URL: ETH.rpc,
      BLOCKSCOUT_ETH_API: ETH.scout,
      BASE_RPC_URL: BASE.rpc,
      BLOCKSCOUT_BASE_API: BASE.scout,
      BLOCKSCOUT_API_KEY: KEY,
    });
    const chains = screenChains(config, (line) => lines.push(line));
    const deps = screenDeps(chains, confirmingServ());

    expect(await screenNextAsk(deps)).toMatchObject({ kind: 'released', cause: CAMPAIGN_SCREEN_CAUSES.chains });
    clock = new Date(clock.getTime() + retryDelaySeconds(1) * 1000);
    expect(await screenNextAsk(deps)).toMatchObject({ kind: 'decided' });
    expect(await getAsk(db, CAMPAIGN, wallet)).toMatchObject({ facts: { chain: 'base', funder: { address: funder, kind: 'wallet' } } });

    const stored = await db.query<{ row: string }>('SELECT row_to_json(a)::text AS row FROM asks a');
    const texts = [...seen.map((request) => request.url), ...lines, ...stored.map((one) => one.row), JSON.stringify(await getAsk(db, CAMPAIGN, wallet))];
    for (const text of texts) expect(text).not.toContain(KEY);
    for (const request of seen) {
      const toBaseScout = request.url.startsWith(BASE.scout);
      expect(request.headers.get('authorization')).toBe(toBaseScout ? `Bearer ${KEY}` : null);
      expect(request.body).not.toContain(KEY);
    }
    expect(seen.filter((request) => request.url.startsWith(BASE.scout)).length).toBeGreaterThan(1);
    expect(seen.filter((request) => request.url.startsWith(ETH.scout)).length).toBeGreaterThan(0);
  });
});

describe('screening with Base history off', () => {
  beforeEach(async () => {
    db = await openMemoryDb();
    await migrate(db);
    clock = NOW;
    lines = [];
    await createCampaign(db, terms());
  });

  afterEach(async () => {
    await db.close();
  });

  it('screens on Ethereum only with no key, says so in one line naming the setting and no value, and stores the old reason (k)', async () => {
    const config = loadWorkerConfig(ENV);
    expect(screenChains(config, (line) => lines.push(line))).toBeUndefined();
    expect(lines).toEqual([BASE_HISTORY_OFF]);
    expect(BASE_HISTORY_OFF).toContain('BLOCKSCOUT_API_KEY');
    for (const value of Object.values(config)) if (typeof value === 'string') expect(BASE_HISTORY_OFF).not.toContain(value);

    lines = [];
    const wallet = await ask();
    const serv = confirmingServ();
    const deps = screenDeps(undefined, serv, new Map([[wallet, neverUsed()]]));
    expect(await screenNextAsk(deps)).toMatchObject({ kind: 'decided', action: 'hold', rule: 'A1' });
    expect(deps.facts).toHaveBeenCalledWith(wallet);
    expect(await getAsk(db, CAMPAIGN, wallet)).toMatchObject({ reason: NEVER_USED_REASON });
    expect(NEVER_USED_REASON).toBe('A1: This wallet has never been used on Ethereum, so there is nothing to screen.');
    expect(modelCalls(serv)).toBe(0);
  });

  it('gives a reader for each chain, and logs nothing, once the key is set', () => {
    const chains = screenChains(loadWorkerConfig({ ...ENV, BLOCKSCOUT_API_KEY: KEY }), (line) => lines.push(line));
    expect(Object.keys(chains ?? {}).sort()).toEqual(['base', 'ethereum']);
    expect(lines).toEqual([]);
  });
});

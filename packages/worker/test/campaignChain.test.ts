// Not covered here: a live RPC. Every request is answered in this process by a simulated node per chain behind a stubbed
// fetch, so whether a real endpoint traces, marks reverted frames and keeps old state the way the simulation does is left
// to npm run history:compare against the endpoints in .env. The single-chain screening paths are campaignWorker.test.ts;
// the RPC history reader on its own is rpcHistory.test.ts; the explorer facts reader is basic.test.ts.
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
} from '@thuli/core';
import { addAsk, createCampaign, getAsk, migrate, openMemoryDb, type CampaignInput, type Db } from '@thuli/store';
import { historyOffLine, PICK_TIME_LIMIT_MS, pickChain, screenChains, type ChainReader, type ChainReaders, type FirstActivity } from '../src/campaign/chain.ts';
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
import { collectBasicFacts, KEYED_BLOCKSCOUT_HOST, keyedBlockscoutHost } from '../src/facts/basic.ts';
import type { DecideDeps } from '../src/replay/decide.ts';
import type { ServReply } from '../src/serv/client.ts';

const WALLET = parseAddress(`0x${'a7'.repeat(20)}`);
const STRANGER = `0x${'5e'.repeat(20)}`;
const CONTRACT = `0x${'c0'.repeat(20)}`;
const ONE_ETH = 10n ** 18n;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

interface Payment {
  block: number;
  from: string;
  to: string;
  wei: bigint;
  /** The frame inside its transaction, [] for the transaction itself; a frame inside a call gets frames made above it. */
  at: number[];
  hash: string;
}

type Call = { method: string; params: unknown[] };

/**
 * One chain as an archive node with traces would answer it: sent counts and balances at every block follow the payments,
 * every payment is a trace, and every request is recorded. A test may hold an address's sent count from a block on, give
 * it code, or have one method refused for a number of calls.
 */
class SimulatedNode {
  readonly url: string;
  readonly finalized: number;
  readonly finalTime: number;
  readonly blockSeconds: number;
  readonly payments: Payment[] = [];
  /** Balance that arrives with no transaction, as a staking withdrawal does: no trace shows it. */
  readonly credits: { block: number; to: string; wei: bigint }[] = [];
  readonly sentCounts = new Map<string, { from: number; count: number }>();
  readonly codes = new Map<string, string>();
  readonly calls: Call[] = [];
  refusing: { method: string; times: number; message: string } | null = null;

  constructor(url: string, finalized: number, finalTime: number, blockSeconds: number) {
    this.url = url;
    this.finalized = finalized;
    this.finalTime = finalTime;
    this.blockSeconds = blockSeconds;
    // Someone else's transaction in the finalized block, for the probe to trace.
    this.pay(finalized, STRANGER, CONTRACT, 1n);
  }

  timeOf(block: number): number {
    return this.finalTime - (this.finalized - block) * this.blockSeconds;
  }

  pay(block: number, from: string, to: string, wei: bigint, at: number[] = [], hash?: string): this {
    const [low, high] = [from.toLowerCase(), to.toLowerCase()];
    this.payments.push({ block, from: low, to: high, wei, at, hash: hash ?? keccak256(toHex(`${this.url} ${block} ${low} ${high} ${wei} ${at.join('.')}`)) });
    return this;
  }

  credit(block: number, to: string, wei: bigint): this {
    this.credits.push({ block, to: to.toLowerCase(), wei });
    return this;
  }

  /** The wallet funded by `funder` at `funded`, then active from `active` with `sent` transactions in all. */
  used(wallet: string, funder: string, funded: number, active: number, sent: number): this {
    this.pay(funded, funder, wallet, ONE_ETH).pay(active, wallet, STRANGER, 1n);
    this.sentCounts.set(wallet.toLowerCase(), { from: active, count: sent });
    return this;
  }

  private sentCount(address: string, block: number): number {
    const held = this.sentCounts.get(address);
    if (held !== undefined) return block >= held.from ? held.count : 0;
    return this.payments.filter((payment) => payment.at.length === 0 && payment.from === address && payment.block <= block).length;
  }

  private balance(address: string, block: number): bigint {
    let total = 0n;
    for (const credit of this.credits) if (credit.block <= block && credit.to === address) total += credit.wei;
    for (const payment of this.payments) {
      if (payment.block > block) continue;
      if (payment.to === address) total += payment.wei;
      if (payment.from === address) total -= payment.wei;
    }
    return total > 0n ? total : 0n;
  }

  private traces(): Record<string, unknown>[] {
    const traces: Record<string, unknown>[] = [];
    const frame = (payment: Pick<Payment, 'block' | 'hash'>, at: number[], from: string, to: string, wei: bigint) => ({
      type: 'call',
      action: { from, to, value: toHex(wei), callType: 'call', gas: '0x0', input: '0x' },
      result: { gasUsed: '0x0', output: '0x' },
      traceAddress: at,
      subtraces: 0,
      transactionHash: payment.hash,
      transactionPosition: 0,
      blockNumber: payment.block,
      blockHash: `0x${'11'.repeat(32)}`,
    });
    for (const payment of this.payments) {
      for (let depth = 0; depth < payment.at.length; depth += 1) traces.push(frame(payment, payment.at.slice(0, depth), STRANGER, CONTRACT, 0n));
      traces.push(frame(payment, payment.at, payment.from, payment.to, payment.wei));
    }
    return traces;
  }

  answer(method: string, params: unknown[]): { result: unknown } | { error: { code: number; message: string } } {
    this.calls.push({ method, params });
    if (this.refusing !== null && this.refusing.method === method && this.refusing.times > 0) {
      this.refusing.times -= 1;
      return { error: { code: -32000, message: this.refusing.message } };
    }
    const blockOf = (tag: unknown) => (tag === 'finalized' ? this.finalized : Number(tag));
    const address = String(params[0]).toLowerCase();
    if (method === 'eth_getBlockByNumber') {
      const block = blockOf(params[0]);
      const transactions = [...new Set(this.payments.filter((payment) => payment.block === block).map((payment) => payment.hash))];
      return { result: { number: toHex(block), hash: `0x${'11'.repeat(32)}`, timestamp: toHex(this.timeOf(block)), transactions } };
    }
    if (method === 'eth_getTransactionCount') return { result: toHex(this.sentCount(address, blockOf(params[1]))) };
    if (method === 'eth_getBalance') return { result: toHex(this.balance(address, blockOf(params[1]))) };
    if (method === 'eth_getCode') return { result: this.codes.get(address) ?? '0x' };
    if (method === 'trace_filter') {
      const filter = params[0] as { fromBlock: string; toBlock: string; toAddress?: string[]; fromAddress?: string[]; count?: number };
      const found = this.traces().filter((trace) => {
        const action = trace.action as { from: string; to: string };
        const block = trace.blockNumber as number;
        return (
          block >= Number(filter.fromBlock) &&
          block <= Number(filter.toBlock) &&
          (filter.toAddress === undefined || filter.toAddress.includes(action.to)) &&
          (filter.fromAddress === undefined || filter.fromAddress.includes(action.from))
        );
      });
      return { result: filter.count === undefined ? found : found.slice(0, filter.count) };
    }
    if (method === 'trace_transaction') return { result: this.traces().filter((trace) => trace.transactionHash === params[0]) };
    return { error: { code: -32601, message: `the method ${method} does not exist` } };
  }

  /** The wallet's full facts reads on this node: the code read collectBasicFacts makes, never the picker. */
  factsReads(wallet: string): unknown[] {
    return this.calls.filter((call) => call.method === 'eth_getCode' && String(call.params[0]).toLowerCase() === wallet.toLowerCase()).map((call) => call.params[1]);
  }
}

/** Serves each node at its URL; any other host fails the request. A node may instead answer every request with `status`. */
function serve(nodes: SimulatedNode[], down: { url: string; status: number } | null = null) {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (down !== null && href === down.url) return new Response(`upstream ${href} unavailable`, { status: down.status });
    const node = nodes.find((one) => one.url === href);
    if (node === undefined) throw new Error('a request went to a host no test serves');
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    return Response.json({ jsonrpc: '2.0', id, ...node.answer(method, params) });
  });
}

const ETH_URL = 'https://eth-rpc.example.org/v2/eth-token-8c1d3f';
const BASE_URL = 'https://base-rpc.example.org/v2/base-token-4a9e2b';
const ETH_FINALIZED = 24_000_000;
const BASE_FINALIZED = 38_000_000;

const nodes = () => ({
  ethereum: new SimulatedNode(ETH_URL, ETH_FINALIZED, 1_794_000_100, 12),
  base: new SimulatedNode(BASE_URL, BASE_FINALIZED, 1_794_000_000, 2),
});

/** A worker environment with every required name, its two RPCs on the simulated nodes. */
const ENV = {
  DATABASE_URL: 'postgres://thuli:hunter2-long-secret@db.example.com:5432/thuli',
  WORKER_PRIVATE_KEY: `0x${'5a'.repeat(32)}`,
  SERV_API_KEY: 'sk-serv-not-a-real-key',
  SERV_BASE_URL: 'https://inference-api.openserv.ai/v1',
  SERV_GRAPH_ID: GRAPH_G1.graphId,
  ETH_RPC_URL: ETH_URL,
  BLOCKSCOUT_ETH_API: 'https://eth.blockscout.com/api/v2',
  BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
  BASE_RPC_URL: BASE_URL,
};

describe('screenChains', () => {
  let said: string[];
  const log = (line: string) => said.push(line);
  const config = loadWorkerConfig(ENV);

  beforeEach(() => {
    said = [];
  });

  it('gives an RPC reader for each chain, and logs nothing, when both endpoints serve old state and traces', async () => {
    const both = nodes();
    serve([both.ethereum, both.base]);
    const chains = await screenChains(config, log);
    expect(Object.keys(chains ?? {}).sort()).toEqual(['base', 'ethereum']);
    expect(said).toEqual([]);
    for (const node of [both.ethereum, both.base]) {
      expect(node.calls.map((call) => call.method)).toEqual(['eth_getBlockByNumber', 'eth_getBalance', 'trace_filter', 'trace_transaction']);
    }
  });

  it('turns RPC history off with one line naming the chain, its setting and what it lacks, and no address or value (C40)', async () => {
    const cases: { set(both: ReturnType<typeof nodes>): { url: string; status: number } | null; line: string }[] = [
      {
        set: (both) => {
          both.base.refusing = { method: 'trace_filter', times: 9, message: `rejected for ${BASE_URL}` };
          return null;
        },
        line: "screen: RPC history is off because Base's endpoint (BASE_RPC_URL) serves no traces, so every ask is screened on Ethereum only",
      },
      {
        set: (both) => {
          both.ethereum.refusing = { method: 'eth_getBalance', times: 9, message: 'missing trie node' };
          return null;
        },
        line: "screen: RPC history is off because Ethereum's endpoint (ETH_RPC_URL) serves no old state, so every ask is screened on Ethereum only",
      },
      {
        set: (both) => {
          both.ethereum.refusing = { method: 'trace_transaction', times: 9, message: 'not enabled' };
          return { url: BASE_URL, status: 500 };
        },
        line: "screen: RPC history is off because Ethereum's endpoint (ETH_RPC_URL) serves no traces and Base's endpoint (BASE_RPC_URL) gave no answer, so every ask is screened on Ethereum only",
      },
    ];
    for (const { set, line } of cases) {
      said = [];
      const both = nodes();
      serve([both.ethereum, both.base], set(both));
      expect(await screenChains(config, log)).toBeUndefined();
      expect(said).toEqual([line]);
      for (const value of Object.values(config)) if (typeof value === 'string') expect(line).not.toContain(value);
      expect(line).not.toMatch(/token|example\.org/);
    }
    expect(historyOffLine({ base: 'no answer' })).toBe("screen: RPC history is off because Base's endpoint (BASE_RPC_URL) gave no answer, so every ask is screened on Ethereum only");
  });
});

describe('the Blockscout key goes to one exact host only (F6)', () => {
  const KEY = 'proapi_test-key-not-real-7f3a9c41';
  const LOOK_ALIKES = [
    'https://api.blockscout.com.evil.example/1/api/v2',
    'https://xapi.blockscout.com/1/api/v2',
    'https://evil.example/api.blockscout.com/1/api/v2',
    'https://evil.example/api/v2?host=https://api.blockscout.com',
    'https://api.blockscout.com@evil.example/1/api/v2',
    'https://user:pass@api.blockscout.com/1/api/v2',
    'https://api.blockscout.com:8443/1/api/v2',
    'https://api.blockscout.com./1/api/v2',
    'http://api.blockscout.com/1/api/v2',
    'https://eth.blockscout.com/api/v2',
  ];

  it('accepts only an https URL on api.blockscout.com itself, and refuses every look-alike', () => {
    expect(KEYED_BLOCKSCOUT_HOST).toBe('api.blockscout.com');
    for (const url of ['https://api.blockscout.com/1/api/v2', 'https://API.Blockscout.com/1/api/v2/addresses/0x1/transactions?page=2']) {
      expect(keyedBlockscoutHost(url)).toBe(true);
    }
    for (const url of [...LOOK_ALIKES, 'api.blockscout.com/1/api/v2', '']) expect(keyedBlockscoutHost(url)).toBe(false);
  });

  it('sends the key as a bearer header to the keyed host on every page, and to no look-alike host and no RPC (C40)', async () => {
    const RPC = 'https://eth-rpc.example.org/rpc-key-2';
    const seen: { url: string; authorization: string | null; body: string }[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === 'string' ? init.body : '';
      seen.push({ url: href, authorization: new Headers(init?.headers).get('authorization'), body });
      if (href === RPC) {
        const { id, method } = JSON.parse(body) as { id: number; method: string };
        const result = method === 'eth_getBlockByNumber' ? { number: '0x10', hash: `0x${'11'.repeat(32)}`, timestamp: '0x6553f100', transactions: [] } : method === 'eth_getCode' ? '0x' : '0x1';
        return Response.json({ jsonrpc: '2.0', id, result });
      }
      const page = new URL(href).searchParams.get('page');
      return Response.json({ items: [], next_page_params: page === null ? { page: 2, items_count: 50 } : null });
    });
    const read = (blockscoutApi: string) => collectBasicFacts(WALLET, { chain: 'ethereum', block: 16 }, { rpcUrl: RPC, blockscoutApi, apiKey: KEY });

    await read('https://api.blockscout.com/1/api/v2');
    const keyed = seen.filter((request) => request.url !== RPC);
    expect(keyed.map((request) => new URL(request.url).pathname.split('/').at(-1))).toEqual(['transactions', 'transactions', 'internal-transactions', 'internal-transactions']);
    for (const request of keyed) expect(request.authorization).toBe(`Bearer ${KEY}`);

    for (const host of LOOK_ALIKES) await read(host);
    for (const request of seen) {
      expect(request.url).not.toContain(KEY);
      expect(request.body).not.toContain(KEY);
      expect(request.authorization).toBe(request.url !== RPC && keyedBlockscoutHost(request.url) ? `Bearer ${KEY}` : null);
    }
    // Every look-alike was really asked, and only the keyed host's four pages carried the key.
    for (const host of LOOK_ALIKES) expect(seen.some((request) => request.url.startsWith(`${host}/`))).toBe(true);
    expect(seen.filter((request) => request.authorization !== null)).toHaveLength(4);
  });
});

const CAMPAIGN = 'two-chains';
const NOW = new Date('2026-11-11T12:00:00.000Z');
const WALLET_STATE: AccountState = { nonce: 12, code: '0x' };

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

const freshAddress = () => privateKeyToAccount(generatePrivateKey()).address;

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
 * Screen deps on the given chain readers, or with RPC history off when chains is undefined. The Ethereum-only readers
 * read `ethereumOnly` and record each call, so a test can show they are never called while RPC history is on.
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

/** Both simulated nodes behind the stubbed fetch, and the production readers screenChains gives for them. */
async function rpcChains() {
  const both = nodes();
  serve([both.ethereum, both.base]);
  const chains = await screenChains(loadWorkerConfig(ENV), (line) => lines.push(line));
  if (chains === undefined) throw new Error('RPC history did not turn on');
  return { ...both, chains };
}

// Old enough and busy enough that a wallet funded by an ordinary wallet starts full under A9.
const ETH_FUNDED = 21_000_000;
const ETH_ACTIVE = 21_500_000;
const BASE_FUNDED = 18_000_000;
const BASE_ACTIVE = 20_000_000;

describe('screening an ask on the chain with the older history, on the RPC readers', () => {
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
    const { ethereum, base, chains } = await rpcChains();
    const wallet = await ask();
    const funder = freshAddress();
    base.used(wallet, funder, BASE_FUNDED, BASE_ACTIVE, 50);
    const serv = confirmingServ();
    const deps = screenDeps(chains, serv);
    expect(await screenNextAsk(deps)).toMatchObject({ kind: 'decided', action: 'full', rule: 'A9' });
    const stored = await getAsk(db, CAMPAIGN, wallet);
    expect(stored).toMatchObject({ facts: { chain: 'base', funder: { address: funder, kind: 'wallet' } } });
    expect(base.factsReads(wallet)).toEqual([toHex(BASE_FINALIZED)]);
    expect(ethereum.factsReads(wallet)).toEqual([]);
    expect(deps.facts).not.toHaveBeenCalled();
    expect(modelCalls(serv)).toBe(1);
  });

  it('screens a wallet used only on Ethereum on Ethereum, with no full Base read (b)', async () => {
    const { ethereum, base, chains } = await rpcChains();
    const wallet = await ask();
    ethereum.used(wallet, freshAddress(), ETH_FUNDED, ETH_ACTIVE, 50);
    const deps = screenDeps(chains, confirmingServ());
    expect(await screenNextAsk(deps)).toMatchObject({ kind: 'decided', action: 'full' });
    expect(await getAsk(db, CAMPAIGN, wallet)).toMatchObject({ facts: { chain: 'ethereum' } });
    expect(ethereum.factsReads(wallet)).toEqual([toHex(ETH_FINALIZED)]);
    expect(base.factsReads(wallet)).toEqual([]);
    expect(deps.facts).not.toHaveBeenCalled();
  });

  it('screens a wallet used on both on the chain it was active on first, either way round (c, d)', async () => {
    const { ethereum, base, chains } = await rpcChains();
    const ethereumFirst = await ask();
    const baseFirst = await ask();
    // Ethereum's block 21,000,000 is about 416 days before its finalized block and Base's 18,000,000 about 463.
    ethereum.used(ethereumFirst, freshAddress(), 19_000_000, ETH_ACTIVE, 50).used(baseFirst, freshAddress(), ETH_FUNDED, ETH_ACTIVE, 50);
    base.used(ethereumFirst, freshAddress(), BASE_FUNDED, BASE_ACTIVE, 50).used(baseFirst, freshAddress(), BASE_FUNDED, BASE_ACTIVE, 50);
    expect(ethereum.timeOf(19_000_000)).toBeLessThan(base.timeOf(BASE_FUNDED));
    expect(base.timeOf(BASE_FUNDED)).toBeLessThan(ethereum.timeOf(ETH_FUNDED));
    await screenAll(screenDeps(chains, confirmingServ()));
    expect(ethereum.factsReads(ethereumFirst)).toEqual([toHex(ETH_FINALIZED)]);
    expect(base.factsReads(baseFirst)).toEqual([toHex(BASE_FINALIZED)]);
    expect([...ethereum.factsReads(baseFirst), ...base.factsReads(ethereumFirst)]).toEqual([]);
    expect(await getAsk(db, CAMPAIGN, ethereumFirst)).toMatchObject({ status: 'decided', action: 'full', facts: { chain: 'ethereum' } });
    expect(await getAsk(db, CAMPAIGN, baseFirst)).toMatchObject({ status: 'decided', action: 'full', facts: { chain: 'base' } });
  });

  it('holds a wallet used on neither chain by code, with the two-chain reason and no model call (e)', async () => {
    const { ethereum, base, chains } = await rpcChains();
    const wallet = await ask();
    const serv = confirmingServ();
    expect(await screenNextAsk(screenDeps(chains, serv))).toMatchObject({ kind: 'decided', action: 'hold', rule: 'A1', slot: null, servRequestId: null });
    expect(await getAsk(db, CAMPAIGN, wallet)).toMatchObject({ action: 'hold', rule: 'A1', reason: NEVER_USED_ON_EITHER_REASON, facts: { chain: 'ethereum' } });
    expect(modelCalls(serv)).toBe(0);
    // The stored facts rest on a real read: Ethereum's, at the block the picker read Ethereum at. Base is never read in full.
    expect(ethereum.factsReads(wallet)).toEqual([toHex(ETH_FINALIZED)]);
    expect(base.factsReads(wallet)).toEqual([]);
  });

  it('decides nothing while Base cannot be read, even with Ethereum history, and decides on the next try once it can (f, C11)', async () => {
    const { ethereum, base, chains } = await rpcChains();
    const wallet = await ask();
    ethereum.used(wallet, freshAddress(), ETH_FUNDED, ETH_ACTIVE, 50);
    base.used(wallet, freshAddress(), BASE_FUNDED, BASE_ACTIVE, 50);
    base.refusing = { method: 'trace_filter', times: 1, message: 'busy' };
    const serv = confirmingServ();
    const deps = screenDeps(chains, serv);

    expect(await screenNextAsk(deps)).toMatchObject({ kind: 'released', cause: CAMPAIGN_SCREEN_CAUSES.chains, status: 'queued' });
    expect(await getAsk(db, CAMPAIGN, wallet)).toMatchObject({ status: 'queued', action: null, facts: null });
    expect([...ethereum.factsReads(wallet), ...base.factsReads(wallet)]).toEqual([]);
    expect(modelCalls(serv)).toBe(0);
    expect(lines).toEqual([`screen ${CAMPAIGN} ${wallet}: not decided, ${CAMPAIGN_SCREEN_CAUSES.chains}; queued again, next try in ${retryDelaySeconds(1)} s`]);

    clock = new Date(clock.getTime() + retryDelaySeconds(1) * 1000);
    expect(await screenNextAsk(deps)).toMatchObject({ kind: 'decided', action: 'full' });
    expect(base.factsReads(wallet)).toEqual([toHex(BASE_FINALIZED)]);
  });

  it('decides nothing for a wallet whose first Base block brought money with no transfer to read, such as a withdrawal (C11)', async () => {
    const { base, chains } = await rpcChains();
    const wallet = await ask();
    base.credit(BASE_FUNDED, wallet, ONE_ETH).used(wallet, freshAddress(), BASE_FUNDED + 100, BASE_ACTIVE, 50);
    const serv = confirmingServ();
    expect(await screenNextAsk(screenDeps(chains, serv))).toMatchObject({ kind: 'released', cause: CAMPAIGN_SCREEN_CAUSES.chains });
    expect(await getAsk(db, CAMPAIGN, wallet)).toMatchObject({ status: 'queued', facts: null });
    expect(base.factsReads(wallet)).toEqual([]);
    expect(modelCalls(serv)).toBe(0);
  });

  it("reads the first funder's kind on the chosen chain only, never the other (g, C16)", async () => {
    const { ethereum, base, chains } = await rpcChains();
    const onBase = await ask();
    const onEthereum = await ask();
    const funder = freshAddress();
    // One funder that is an exchange on Base and a contract on Ethereum: each ask's stored kind shows which chain was read.
    base.sentCounts.set(funder.toLowerCase(), { from: 0, count: HIGH_VOLUME_NONCE });
    ethereum.codes.set(funder.toLowerCase(), '0x6080604052348015600f57600080fd5b50');
    base.used(onBase, funder, BASE_FUNDED, BASE_ACTIVE, 50);
    ethereum.used(onBase, funder, ETH_FUNDED, ETH_ACTIVE, 50);
    ethereum.used(onEthereum, funder, 19_000_000, ETH_ACTIVE, 50);
    base.used(onEthereum, funder, BASE_FUNDED, BASE_ACTIVE, 50);
    const deps = screenDeps(chains, confirmingServ());
    await screenAll(deps);
    expect(await getAsk(db, CAMPAIGN, onBase)).toMatchObject({ facts: { chain: 'base', funder: { address: funder, kind: 'exchange' } } });
    expect(await getAsk(db, CAMPAIGN, onEthereum)).toMatchObject({ facts: { chain: 'ethereum', funder: { address: funder, kind: 'contract' } } });
    expect(base.factsReads(funder)).toEqual([toHex(BASE_FINALIZED)]);
    expect(ethereum.factsReads(funder)).toEqual([toHex(ETH_FINALIZED)]);
    expect(deps.accountState).not.toHaveBeenCalled();
  });

  it('links two asks screened on different chains whose first funder is one ordinary address (h, C15)', async () => {
    const { ethereum, base, chains } = await rpcChains();
    const funder = freshAddress();
    const onBase = await ask();
    const onEthereum = await ask();
    base.used(onBase, funder, BASE_FUNDED, BASE_ACTIVE, 50);
    ethereum.used(onEthereum, funder, ETH_FUNDED, ETH_ACTIVE, 50);
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

  it('keeps every endpoint address and token out of every log line, error and stored value through a real screening (j, C40)', async () => {
    const { ethereum, base, chains } = await rpcChains();
    const wallet = await ask();
    const funder = freshAddress();
    base.used(wallet, funder, BASE_FUNDED, BASE_ACTIVE, 50);
    ethereum.used(wallet, freshAddress(), ETH_FUNDED, ETH_ACTIVE, 50);
    // Each chain's very first read is refused, so both refusals are spent on the first try before either chain's failure
    // can stop the other's reads.
    base.refusing = { method: 'eth_getBlockByNumber', times: 1, message: `rate limited at ${BASE_URL}` };
    ethereum.refusing = { method: 'eth_getBlockByNumber', times: 1, message: `rate limited at ${ETH_URL}` };
    const deps = screenDeps(chains, confirmingServ());

    expect(await screenNextAsk(deps)).toMatchObject({ kind: 'released', cause: CAMPAIGN_SCREEN_CAUSES.chains });
    clock = new Date(clock.getTime() + retryDelaySeconds(1) * 1000);
    expect(await screenNextAsk(deps)).toMatchObject({ kind: 'decided' });
    expect(await getAsk(db, CAMPAIGN, wallet)).toMatchObject({ facts: { chain: 'base', funder: { address: funder, kind: 'wallet' } } });

    const stored = await db.query<{ row: string }>('SELECT row_to_json(a)::text AS row FROM asks a');
    const texts = [...lines, ...stored.map((one) => one.row), JSON.stringify(await getAsk(db, CAMPAIGN, wallet))];
    for (const text of texts) expect(text).not.toMatch(/token|rpc\.example\.org/);
  });
});

describe('screening with RPC history off', () => {
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

  it('screens on Ethereum only when Base serves no traces, says so in one line, and stores the old reason (k)', async () => {
    const both = nodes();
    both.base.refusing = { method: 'trace_filter', times: 9, message: 'rejected due to request filter settings' };
    serve([both.ethereum, both.base]);
    expect(await screenChains(loadWorkerConfig(ENV), (line) => lines.push(line))).toBeUndefined();
    expect(lines).toEqual([historyOffLine({ base: 'traces' })]);

    lines = [];
    const wallet = await ask();
    const serv = confirmingServ();
    const neverUsed: Facts = {
      walletAgeDays: 0,
      txCountAtSnapshot: 0,
      accountType: 'eoa',
      firstFunder: null,
      group: null,
      sharedDepositAddress: null,
      fundingBurst: null,
      claimPaidToOtherAddress: null,
      evidenceTxs: [],
      missing: ['group', 'sharedDepositAddress', 'claimPaidToOtherAddress', 'firstFunder'],
    };
    const deps = screenDeps(undefined, serv, new Map([[wallet, neverUsed]]));
    expect(await screenNextAsk(deps)).toMatchObject({ kind: 'decided', action: 'hold', rule: 'A1' });
    expect(deps.facts).toHaveBeenCalledWith(wallet);
    expect(await getAsk(db, CAMPAIGN, wallet)).toMatchObject({ reason: NEVER_USED_REASON });
    expect(NEVER_USED_REASON).toBe('A1: This wallet has never been used on Ethereum, so there is nothing to screen.');
    expect(modelCalls(serv)).toBe(0);
  });
});

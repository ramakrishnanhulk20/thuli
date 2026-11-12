// Not covered here: a live node. Every call is answered in this process, by a stand-in RPC or a stubbed fetch, so whether a
// real endpoint marks reverted frames, names selfdestructs and honours trace_filter's count the way the stand-in does is
// left to npm run history:compare, run against the endpoints in .env. The campaign path on these readers is
// campaignChain.test.ts.
import { createPublicClient, http, keccak256, toHex } from 'viem';
import { mainnet } from 'viem/chains';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { firstActivityTime, fundingTransfer, parseAddress, SECONDS_PER_DAY, walletAgeDays, type Transfer } from '@thuli/core';
import { rpcFirstActivity } from '../src/campaign/chain.ts';
import { collectBasicFacts } from '../src/facts/basic.ts';
import {
  firstSendBlock,
  firstUsedBlock,
  historyClientOf,
  HistoryError,
  historyProbe,
  inflowBlocks,
  MAX_CALLS_IN_FLIGHT,
  MAX_FAILED_SEND_BLOCKS,
  MAX_INFLOW_BLOCKS,
  MAX_INFLOW_READS,
  MAX_SEARCH_STEPS,
  MAX_TRACED_TRANSACTIONS,
  NO_ANSWER_WAITS_MS,
  RpcRefused,
  rpcHistory,
  transfersInBlock,
  type HistoryClient,
} from '../src/facts/rpcHistory.ts';

const WALLET = parseAddress(`0x${'a7'.repeat(20)}`);
const SELF = WALLET.toLowerCase();
const EXCHANGE = `0x${'e0'.repeat(20)}`;
const CONTRACT = `0x${'c0'.repeat(20)}`;
const SENDER = `0x${'5e'.repeat(20)}`;
const SHOP = `0x${'5b'.repeat(20)}`;
const TOP = 1_000_000;
const TOP_TIME = 1_794_000_000;
const ONE_ETH = 10n ** 18n;

/** A block's time on a chain with 12 second blocks that reaches TOP_TIME at TOP. */
const timeOf = (block: number) => TOP_TIME - (TOP - block) * 12;

type RawTrace = Record<string, unknown> & { blockNumber: number; transactionHash: string | null; traceAddress: number[] };

const hashOf = (label: string) => keccak256(toHex(label));

function callTrace(
  block: number,
  from: string,
  to: string,
  wei: bigint,
  options: { at?: number[]; error?: string; callType?: string; hash?: string } = {},
): RawTrace {
  return {
    type: 'call',
    action: { from, to, value: toHex(wei), callType: options.callType ?? 'call', gas: '0x5208', input: '0x' },
    ...(options.error === undefined ? { result: { gasUsed: '0x5208', output: '0x' } } : { error: options.error }),
    traceAddress: options.at ?? [],
    subtraces: 0,
    transactionHash: options.hash ?? hashOf(`${block} ${from} ${to} ${wei}`),
    transactionPosition: 0,
    blockNumber: block,
    blockHash: `0x${'11'.repeat(32)}`,
  };
}

const target = (trace: RawTrace) => {
  const action = trace.action as Record<string, string>;
  return (action.to ?? action.refundAddress ?? action.author ?? '').toLowerCase();
};
const source = (trace: RawTrace) => {
  const action = trace.action as Record<string, string>;
  return (action.from ?? action.address ?? '').toLowerCase();
};

const valueOf = (trace: RawTrace) => {
  const action = trace.action as Record<string, string>;
  return BigInt(action.value ?? action.balance ?? '0x0');
};
const isPrefix = (above: number[], below: number[]) => above.length <= below.length && above.every((step, index) => below[index] === step);
// A trace moved its value only when neither it nor any frame above it in its transaction carries an error.
const succeeded = (trace: RawTrace, traces: RawTrace[]) =>
  trace.transactionHash === null ||
  !traces.some((other) => other.transactionHash === trace.transactionHash && typeof other.error === 'string' && isPrefix(other.traceAddress, trace.traceAddress));
const moves = (trace: RawTrace) => trace.type === 'suicide' || trace.type === 'reward' || trace.type === 'create' || (trace.action as { callType?: string }).callType === 'call';

/**
 * A node for one wallet: its balance turns above zero at `funded` and its sent count at `sent`, either left out for
 * never; or, with `derive`, both follow `traces` the way a chain would (the sent count counts the wallet's own
 * transactions, failed ones too; the balance sums the value that really moved, plus `credits` that came with no
 * transaction). `traces` are every trace on the chain, and every block holds one transaction unless listed in
 * `emptyBlocks`. Every call is recorded; `fail` may answer one with an error instead.
 */
function standIn(
  state: { funded?: number; sent?: number; derive?: boolean; credits?: Record<number, bigint>; traces?: RawTrace[]; emptyBlocks?: number[] },
  fail?: (method: string, params: readonly unknown[]) => Error | undefined,
) {
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const traces = state.traces ?? [];
  const blockOf = (tag: unknown) => (tag === 'finalized' ? TOP : Number(tag));
  const sentAt = (block: number) =>
    state.derive === true
      ? traces.filter((trace) => trace.traceAddress.length === 0 && source(trace) === SELF && trace.blockNumber <= block && (trace.type === 'call' || trace.type === 'create')).length
      : state.sent !== undefined && block >= state.sent
        ? 3
        : 0;
  const balanceAt = (block: number) => {
    if (state.derive !== true) return state.funded !== undefined && block >= state.funded ? ONE_ETH : 0n;
    let total = Object.entries(state.credits ?? {}).reduce((sum, [at, wei]) => (Number(at) <= block ? sum + wei : sum), 0n);
    for (const trace of traces) {
      if (trace.blockNumber > block || !moves(trace) || !succeeded(trace, traces)) continue;
      if (target(trace) === SELF) total += valueOf(trace);
      if (source(trace) === SELF) total -= valueOf(trace);
    }
    return total;
  };
  const client: HistoryClient = {
    async request(method, params) {
      calls.push({ method, params });
      const refusal = fail?.(method, params);
      if (refusal !== undefined) throw refusal;
      if (method === 'eth_getBlockByNumber') {
        const block = blockOf(params[0]);
        const transactions = state.emptyBlocks?.includes(block) === true ? [] : [hashOf(`background ${block}`)];
        return { number: toHex(block), timestamp: toHex(timeOf(block)), transactions };
      }
      if (method === 'eth_getTransactionCount') return toHex(sentAt(Number(params[1])));
      if (method === 'eth_getBalance') return params[0] === SELF ? toHex(balanceAt(Number(params[1]))) : '0x0';
      if (method === 'trace_filter') {
        const filter = params[0] as { fromBlock: string; toBlock: string; toAddress?: string[]; fromAddress?: string[]; count?: number };
        const found = traces.filter(
          (trace) =>
            trace.blockNumber >= Number(filter.fromBlock) &&
            trace.blockNumber <= Number(filter.toBlock) &&
            (filter.toAddress === undefined || filter.toAddress.includes(target(trace))) &&
            (filter.fromAddress === undefined || filter.fromAddress.includes(source(trace))),
        );
        return filter.count === undefined ? found : found.slice(0, filter.count);
      }
      if (method === 'trace_transaction') return traces.filter((trace) => trace.transactionHash === params[0]);
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { client, calls };
}

const reads = (calls: { method: string; params: readonly unknown[] }[]) =>
  calls.filter((call) => call.method === 'eth_getTransactionCount' || call.method === 'eth_getBalance');

describe('firstUsedBlock', () => {
  it('finds the first block with a balance or a sent count at block 1, in the middle and at the top, with at most two reads a step (C41)', async () => {
    const steps = Math.ceil(Math.log2(TOP + 1)) + 1;
    for (const state of [{ funded: 1 }, { funded: 523_777 }, { sent: 523_777 }, { funded: 600_000, sent: 412_345 }, { funded: TOP }]) {
      const { client, calls } = standIn(state);
      expect(await firstUsedBlock(client, WALLET, TOP)).toBe(Math.min(state.funded ?? TOP + 1, state.sent ?? TOP + 1));
      const perBlock = new Map<unknown, number>();
      for (const call of reads(calls)) perBlock.set(call.params[1], (perBlock.get(call.params[1]) ?? 0) + 1);
      expect([...perBlock.values()].every((count) => count === 2)).toBe(true);
      expect(perBlock.size).toBeLessThanOrEqual(steps);
      expect(steps).toBeLessThan(MAX_SEARCH_STEPS);
    }
  });

  it('answers null for a wallet never used, after one step at the top, and refuses a top that is not a block', async () => {
    const { client, calls } = standIn({});
    expect(await firstUsedBlock(client, WALLET, TOP)).toBeNull();
    expect(reads(calls).map((call) => call.params[1])).toEqual([toHex(TOP), toHex(TOP)]);
    expect(await firstUsedBlock(standIn({ funded: 0 }).client, WALLET, 0)).toBe(0);
    await expect(firstUsedBlock(client, WALLET, -1)).rejects.toThrow(HistoryError);
  });

  it('fails, never guessing a block, when one read fails or comes back out of shape (C11)', async () => {
    const refused = standIn({ funded: 77 }, (method, params) => (method === 'eth_getBalance' && params[1] === toHex(TOP / 2) ? new RpcRefused('refused') : undefined));
    await expect(firstUsedBlock(refused.client, WALLET, TOP)).rejects.toThrow(RpcRefused);
    const odd: HistoryClient = { request: async (method) => (method === 'eth_getBalance' ? 'lots' : '0x0') };
    await expect(firstUsedBlock(odd, WALLET, TOP)).rejects.toThrow('the RPC answer to eth_getBalance was out of shape');
  });
});

const B = 400_000;

/** A node whose wallet balance rises by each listed amount at its block, and whose sent count turns 1 at `sent`. */
function ledger(inflows: Record<number, bigint>, sent?: number) {
  const calls: string[] = [];
  const client: HistoryClient = {
    async request(method, params) {
      calls.push(method);
      const block = Number(params[1]);
      if (method === 'eth_getTransactionCount') return toHex(sent !== undefined && block >= sent ? 1 : 0);
      if (method === 'eth_getBalance') return toHex(Object.entries(inflows).reduce((sum, [at, wei]) => (Number(at) <= block ? sum + wei : sum), 0n));
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { client, calls };
}

describe('firstSendBlock and inflowBlocks', () => {
  it('finds the first send block on the sent count alone, within 1 + ceil(log2(top - from + 1)) reads (C41)', async () => {
    for (const [from, sent] of [[0, 1], [B, B], [B, 777_777], [B, TOP]] as const) {
      const { client, calls } = ledger({}, sent);
      expect(await firstSendBlock(client, WALLET, from, TOP)).toBe(sent);
      expect(calls.length).toBeLessThanOrEqual(1 + Math.ceil(Math.log2(TOP - from + 1)));
      expect(new Set(calls)).toEqual(new Set(['eth_getTransactionCount']));
    }
    const never = ledger({});
    expect(await firstSendBlock(never.client, WALLET, B, TOP)).toBeNull();
    expect(never.calls).toHaveLength(1);
    await expect(firstSendBlock(never.client, WALLET, TOP, B)).rejects.toThrow(HistoryError);
  });

  it('finds every block the balance rose in, within min(MAX_INFLOW_READS, 2 + cap * ceil(log2(to - from))) reads (C41)', async () => {
    const cases: [number, Record<number, bigint>][] = [
      [0, {}],
      [B, { [B]: 5n }],
      [B, { [B]: 5n, [B + 1]: 1n, [600_000]: 7n, [TOP - 1]: 2n }],
      [0, { 0: 3n, 999_998: 1n }],
      [B, Object.fromEntries(Array.from({ length: MAX_INFLOW_BLOCKS }, (_, index) => [B + index * 1_000, 1n]))],
    ];
    for (const [from, inflows] of cases) {
      const { client, calls } = ledger(inflows);
      expect(await inflowBlocks(client, WALLET, from, TOP, MAX_INFLOW_BLOCKS)).toEqual(Object.keys(inflows).map(Number).sort((a, b) => a - b));
      expect(calls.length).toBeLessThanOrEqual(Math.min(MAX_INFLOW_READS, 2 + MAX_INFLOW_BLOCKS * Math.ceil(Math.log2(TOP - from))));
      expect(new Set(calls.length === 0 ? ['eth_getBalance'] : calls)).toEqual(new Set(['eth_getBalance']));
    }
    expect(await inflowBlocks(ledger({ [B]: 1n }).client, WALLET, B, B, MAX_INFLOW_BLOCKS)).toEqual([]);
  });

  it('answers too many past the cap or the read budget, and fails where the balance fell (C11, C41)', async () => {
    const spread = (count: number, gap: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [B + index * gap, 1n]));
    const crowded = ledger(spread(MAX_INFLOW_BLOCKS + 1, 1_000));
    expect(await inflowBlocks(crowded.client, WALLET, B, TOP, MAX_INFLOW_BLOCKS)).toBe('too many');
    expect(crowded.calls.length).toBeLessThanOrEqual(2 + MAX_INFLOW_BLOCKS * Math.ceil(Math.log2(TOP - B)));
    // Forty inflows spread over the whole range need more balance reads than the budget allows.
    const costly = ledger(spread(40, 15_000));
    expect(await inflowBlocks(costly.client, WALLET, B, TOP, 1_000)).toBe('too many');
    expect(costly.calls.length).toBeLessThanOrEqual(MAX_INFLOW_READS);
    await expect(inflowBlocks(ledger({ [B]: 5n, 600_000: -2n }).client, WALLET, B, TOP, MAX_INFLOW_BLOCKS)).rejects.toThrow('the balance fell');
  });
});

describe('transfersInBlock', () => {
  it('reads an external inflow, an internal inflow, an own send and a selfdestruct to the wallet, each with the block time', async () => {
    const inflow = callTrace(B, EXCHANGE, SELF, ONE_ETH);
    const parent = callTrace(B, SENDER, CONTRACT, 0n, { hash: hashOf('internal'), at: [] });
    const nested = callTrace(B, CONTRACT, SELF, 2n * ONE_ETH, { hash: hashOf('internal'), at: [0] });
    const send = callTrace(B, SELF, SHOP, ONE_ETH / 2n);
    const destroyer = callTrace(B, SENDER, CONTRACT, 0n, { hash: hashOf('destroy') });
    const destroyed = { ...destroyer, type: 'suicide', action: { address: CONTRACT, refundAddress: SELF, balance: toHex(3n) }, traceAddress: [0] };
    const { client } = standIn({ funded: B, traces: [inflow, parent, nested, send, destroyer, destroyed] });
    const read = await transfersInBlock(client, WALLET, B);
    const row = (hash: string, from: string, to: string, wei: bigint, kind: Transfer['kind']): Transfer => ({
      hash,
      block: B,
      time: timeOf(B),
      from,
      to,
      valueWei: wei.toString(),
      failed: false,
      kind,
    });
    expect(read.external).toEqual([row(inflow.transactionHash as string, EXCHANGE, SELF, ONE_ETH, 'external'), row(send.transactionHash as string, SELF, SHOP, ONE_ETH / 2n, 'external')]);
    expect(read.internal).toEqual([row(hashOf('internal'), CONTRACT, SELF, 2n * ONE_ETH, 'internal'), row(hashOf('destroy'), CONTRACT, SELF, 3n, 'internal')]);
  });

  it('marks a reverted inflow failed, and an inflow inside a call that reverted above it failed too, though it carries no error itself', async () => {
    const reverted = callTrace(B, EXCHANGE, SELF, ONE_ETH, { error: 'Reverted' });
    const hash = hashOf('reverted parent');
    const tree = [
      callTrace(B, SENDER, CONTRACT, 0n, { hash, at: [] }),
      callTrace(B, CONTRACT, SHOP, 0n, { hash, at: [0], error: 'Reverted' }),
      callTrace(B, SHOP, SELF, ONE_ETH, { hash, at: [0, 1] }),
      callTrace(B, CONTRACT, SELF, 5n, { hash, at: [1] }),
    ];
    const { client, calls } = standIn({ funded: B, traces: [reverted, ...tree] });
    const read = await transfersInBlock(client, WALLET, B);
    expect(read.external.map((transfer) => transfer.failed)).toEqual([true]);
    expect(read.internal.map((transfer) => [transfer.from, transfer.failed])).toEqual([
      [SHOP, true],
      [CONTRACT, false],
    ]);
    // One whole-trace read for the transaction holding the internal transfers, none for a transaction read from its top.
    expect(calls.filter((call) => call.method === 'trace_transaction').map((call) => call.params[0])).toEqual([hash]);
  });

  it('ignores a delegatecall, a staticcall and a callcode with a value field, and reads a deployment the wallet signed as its own send', async () => {
    const traces = ['delegatecall', 'staticcall', 'callcode'].map((callType) => callTrace(B, CONTRACT, SELF, ONE_ETH, { callType, hash: hashOf(callType), at: [] }));
    const deploy = { ...callTrace(B, SELF, CONTRACT, ONE_ETH), type: 'create', action: { from: SELF, value: toHex(ONE_ETH), gas: '0x0', init: '0x' } };
    // A contract made inside a call is not the wallet's transaction, so it is no own send.
    const nested = { ...deploy, transactionHash: hashOf('nested create'), traceAddress: [0] };
    const { client } = standIn({ funded: B, traces: [...traces, deploy, nested] });
    expect(await transfersInBlock(client, WALLET, B)).toEqual({
      external: [{ hash: deploy.transactionHash, block: B, time: timeOf(B), from: SELF, to: null, valueWei: ONE_ETH.toString(), failed: false, kind: 'external' }],
      internal: [],
    });
  });

  it('fails on value reaching the wallet by a trace of any other kind, so it is never read as no transfer (C11)', async () => {
    const reward = { ...callTrace(B, SENDER, SELF, 0n), type: 'reward', action: { author: SELF, value: toHex(2n * ONE_ETH), rewardType: 'block' }, transactionHash: null };
    await expect(transfersInBlock(standIn({ funded: B, traces: [reward] }).client, WALLET, B)).rejects.toThrow(
      'a trace of a kind this reader does not read moved value to the wallet, so the block was not read',
    );
    const unread = { ...reward, action: { author: SELF, rewardType: 'block' } };
    await expect(transfersInBlock(standIn({ funded: B, traces: [unread] }).client, WALLET, B)).rejects.toThrow(HistoryError);
    const empty = { ...reward, action: { author: SELF, value: '0x0', rewardType: 'block' } };
    expect(await transfersInBlock(standIn({ funded: B, traces: [empty] }).client, WALLET, B)).toEqual({ external: [], internal: [] });
  });

  it(`fails past ${MAX_TRACED_TRANSACTIONS} transactions to check, and when a trace lacks a frame above a transfer (C11, C41)`, async () => {
    const many = Array.from({ length: MAX_TRACED_TRANSACTIONS + 1 }, (_, index) => [
      callTrace(B, SENDER, CONTRACT, 0n, { hash: hashOf(`tx ${index}`) }),
      callTrace(B, CONTRACT, SELF, 1n, { hash: hashOf(`tx ${index}`), at: [0] }),
    ]).flat();
    const crowded = standIn({ funded: B, traces: many });
    await expect(transfersInBlock(crowded.client, WALLET, B)).rejects.toThrow(`more than ${MAX_TRACED_TRANSACTIONS} transactions`);
    expect(crowded.calls.filter((call) => call.method === 'trace_transaction')).toEqual([]);
    const orphan = callTrace(B, CONTRACT, SELF, 1n, { hash: hashOf('orphan'), at: [2, 0] });
    await expect(transfersInBlock(standIn({ funded: B, traces: [orphan] }).client, WALLET, B)).rejects.toThrow('lacked a frame above a transfer');
  });
});

/** What core's three functions say about the rows rpcHistory read for this node, at TOP's time. */
async function judged(state: Parameters<typeof standIn>[0]) {
  const data = await rpcHistory(standIn(state).client, WALLET, TOP);
  const funding = fundingTransfer(WALLET, data);
  return {
    funder: funding.status === 'found' ? funding.transfer.from : funding.status,
    evidence: funding.status === 'found' ? funding.transfer.hash : null,
    ageDays: walletAgeDays(WALLET, data, TOP_TIME),
    firstActivity: firstActivityTime(WALLET, data),
  };
}

const AGE = Math.floor((TOP_TIME - timeOf(B)) / SECONDS_PER_DAY);

describe('rpcHistory read by core', () => {
  it('gives the funder, its transaction and the age from the first used block, external, internal or by selfdestruct (C20)', async () => {
    const inflow = callTrace(B, EXCHANGE, SELF, ONE_ETH);
    expect(await judged({ funded: B, traces: [inflow, callTrace(B + 9, SELF, SHOP, 1n)] })).toEqual({
      funder: EXCHANGE,
      evidence: inflow.transactionHash,
      ageDays: AGE,
      firstActivity: timeOf(B),
    });
    const hash = hashOf('payout');
    const payout = [callTrace(B, SENDER, CONTRACT, 0n, { hash }), callTrace(B, CONTRACT, SELF, ONE_ETH, { hash, at: [0] })];
    expect(await judged({ funded: B, traces: payout })).toMatchObject({ funder: CONTRACT, evidence: hash, ageDays: AGE });
    const destroyed = { ...callTrace(B, CONTRACT, SELF, 0n, { hash, at: [0] }), type: 'suicide', action: { address: CONTRACT, refundAddress: SELF, balance: toHex(ONE_ETH) } };
    expect(await judged({ funded: B, traces: [payout[0] as RawTrace, destroyed] })).toMatchObject({ funder: CONTRACT, evidence: hash, ageDays: AGE });
  });

  it('dates a wallet funded and spending in one block by that block, and takes the larger inflow as its funder', async () => {
    const small = callTrace(B, SENDER, SELF, 1n);
    const large = callTrace(B, EXCHANGE, SELF, ONE_ETH);
    expect(await judged({ funded: B, sent: B, traces: [small, large, callTrace(B, SELF, SHOP, ONE_ETH / 2n)] })).toEqual({
      funder: EXCHANGE,
      evidence: large.transactionHash,
      ageDays: AGE,
      firstActivity: timeOf(B),
    });
  });

  it('fails, never giving a guessed age, when the first block holds only a failed, reverted-inside or delegated inflow, or nothing (C11)', async () => {
    const hash = hashOf('reverted');
    const cases: Parameters<typeof standIn>[0][] = [
      { funded: B, traces: [callTrace(B, EXCHANGE, SELF, ONE_ETH, { error: 'Reverted' })] },
      { funded: B, traces: [callTrace(B, SENDER, CONTRACT, 0n, { hash, error: 'Reverted' }), callTrace(B, CONTRACT, SELF, ONE_ETH, { hash, at: [0] })] },
      { funded: B, traces: [callTrace(B, CONTRACT, SELF, ONE_ETH, { callType: 'delegatecall' })] },
      // Money that arrived with no transaction, such as a staking withdrawal: the balance rises and no trace shows why,
      // even with a readable inflow later.
      { derive: true, credits: { [B]: ONE_ETH }, traces: [callTrace(B + 50, EXCHANGE, SELF, ONE_ETH), callTrace(B + 90, SELF, SHOP, 1n)] },
    ];
    for (const state of cases) {
      await expect(rpcHistory(standIn(state).client, WALLET, TOP)).rejects.toThrow('the first used block holds no transfer that dates the wallet');
    }
  });

  it('reads a wallet never used as two complete empty pages: no funder, age 0, the explorer reader\'s answer for it', async () => {
    const { client, calls } = standIn({});
    expect(await rpcHistory(client, WALLET, TOP)).toEqual({ external: { transfers: [], complete: true }, internal: { transfers: [], complete: true } });
    expect(calls.some((call) => call.method === 'trace_filter')).toBe(false);
    expect(await judged({})).toEqual({ funder: 'none', evidence: null, ageDays: 0, firstActivity: null });
  });

  it('throws on a trace kind it does not read rather than giving rows', async () => {
    const reward = { ...callTrace(B, SENDER, SELF, 0n), type: 'reward', action: { author: SELF, value: toHex(ONE_ETH) }, transactionHash: null };
    await expect(rpcHistory(standIn({ funded: B, traces: [reward] }).client, WALLET, TOP)).rejects.toThrow(HistoryError);
  });
});

const filteredBlocks = (calls: { method: string; params: readonly unknown[] }[]) =>
  [...new Set(calls.filter((call) => call.method === 'trace_filter').map((call) => Number((call.params[0] as { fromBlock: string }).fromBlock)))].sort((a, b) => a - b);

describe('rpcHistory gathers every inflow up to the first own send', () => {
  const SEND = B + 60_000;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('takes a larger inflow after the first block as the funder, and counts the age from the first block (a, the live 0x83D5 case)', async () => {
    const batch = hashOf('batch payout');
    const later = callTrace(B + 30_000, EXCHANGE, SELF, 7_430_000_000_000_000n);
    const traces = [
      callTrace(B, SENDER, CONTRACT, 0n, { hash: batch }),
      callTrace(B, CONTRACT, SELF, 1_974_040_000_000_000n, { hash: batch, at: [0] }),
      later,
      callTrace(SEND, SELF, SHOP, 0n),
      callTrace(SEND + 10, SENDER, SELF, 10n * ONE_ETH),
    ];
    const { client, calls } = standIn({ derive: true, traces });
    const data = await rpcHistory(client, WALLET, TOP);
    const funding = fundingTransfer(WALLET, data);
    expect(funding).toMatchObject({ status: 'found', transfer: { from: EXCHANGE, hash: later.transactionHash } });
    expect(walletAgeDays(WALLET, data, TOP_TIME)).toBe(AGE);
    expect(firstActivityTime(WALLET, data)).toBe(timeOf(B));
    expect(filteredBlocks(calls)).toEqual([B, B + 30_000, SEND]);
  });

  it('takes the earlier of two equal inflows (b), and an inflow in the first send block but none after it (c)', async () => {
    const earlier = callTrace(B, SENDER, SELF, ONE_ETH);
    const equal = [earlier, callTrace(B + 10, EXCHANGE, SELF, ONE_ETH), callTrace(SEND, SELF, SHOP, 1n)];
    expect(await judged({ derive: true, traces: equal })).toMatchObject({ funder: SENDER, evidence: earlier.transactionHash, ageDays: AGE });
    const atSend = callTrace(SEND, EXCHANGE, SELF, 2n * ONE_ETH);
    const bounded = [callTrace(B, SENDER, SELF, 1n), callTrace(SEND, SELF, SHOP, 0n), atSend, callTrace(SEND + 1, CONTRACT, SELF, 5n * ONE_ETH)];
    expect(await judged({ derive: true, traces: bounded })).toMatchObject({ funder: EXCHANGE, evidence: atSend.transactionHash, ageDays: AGE });
  });

  it('weighs every inflow up to the read block for a wallet that never sent (d)', async () => {
    const atTop = callTrace(TOP, SHOP, SELF, 4n * ONE_ETH);
    const traces = [callTrace(B, SENDER, SELF, ONE_ETH), callTrace(B + 50, EXCHANGE, SELF, 2n * ONE_ETH), callTrace(TOP - 3, CONTRACT, SELF, 3n * ONE_ETH), atTop];
    const { client, calls } = standIn({ derive: true, traces });
    expect(fundingTransfer(WALLET, await rpcHistory(client, WALLET, TOP))).toMatchObject({ status: 'found', transfer: { from: SHOP, hash: atTop.transactionHash } });
    expect(filteredBlocks(calls)).toEqual([B, B + 50, TOP - 3, TOP]);
    expect(await judged({ derive: true, traces: traces.slice(0, 3) })).toMatchObject({ funder: CONTRACT, ageDays: AGE });
  });

  it(`fails past ${MAX_INFLOW_BLOCKS} inflow blocks, so the facts list the funder and the age as not read (e, C11, C41)`, async () => {
    const traces = [...Array.from({ length: MAX_INFLOW_BLOCKS + 1 }, (_, index) => callTrace(B + index * 1_000, SENDER, SELF, ONE_ETH)), callTrace(SEND, SELF, SHOP, 0n)];
    const { client } = standIn({ derive: true, traces });
    await expect(rpcHistory(client, WALLET, TOP)).rejects.toThrow(`more than ${MAX_INFLOW_BLOCKS} blocks paid the wallet before its first send`);
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string };
      const result = method === 'eth_getBlockByNumber' ? { number: toHex(TOP), hash: `0x${'11'.repeat(32)}`, timestamp: toHex(TOP_TIME), transactions: [] } : method === 'eth_getCode' ? '0x' : '0x1';
      return Response.json({ jsonrpc: '2.0', id, result });
    });
    const causes: string[] = [];
    const facts = await collectBasicFacts(WALLET, { chain: 'ethereum', block: TOP }, {
      rpcUrl: 'https://rpc.example.org/token',
      history: (wallet, block) => rpcHistory(client, wallet, block),
      onProblem: (_fact, cause) => causes.push(cause),
    });
    expect(facts).toMatchObject({ firstFunder: null, walletAgeDays: null, evidenceTxs: [] });
    expect(facts.missing).toEqual(expect.arrayContaining(['firstFunder', 'walletAgeDays']));
    expect(causes[0]).toMatch(/^transaction history read failed \(more than 24 blocks paid the wallet/);
  });

  it('bounds the funder by a first act that is a deployment (f)', async () => {
    const funding = callTrace(B, EXCHANGE, SELF, ONE_ETH);
    const deploy = { ...callTrace(SEND, SELF, CONTRACT, 0n), type: 'create', action: { from: SELF, value: '0x0', gas: '0x0', init: '0x' } };
    const traces = [funding, deploy, callTrace(SEND + 100, SENDER, SELF, 5n * ONE_ETH)];
    const data = await rpcHistory(standIn({ derive: true, traces }).client, WALLET, TOP);
    expect(data.external.transfers.find((transfer) => transfer.hash === deploy.transactionHash)).toMatchObject({ from: SELF, to: null, kind: 'external' });
    expect(fundingTransfer(WALLET, data)).toMatchObject({ status: 'found', transfer: { from: EXCHANGE } });
  });

  it('walks past a first transaction that failed to the first send that succeeded, weighing the inflows in between (the live 0x1234 case)', async () => {
    const real = callTrace(SEND + 100, SENDER, SELF, 5n * ONE_ETH);
    const traces = [
      callTrace(B, EXCHANGE, SELF, ONE_ETH),
      callTrace(SEND, SELF, SHOP, 0n, { error: 'Reverted' }),
      real,
      callTrace(SEND + 200, SELF, SHOP, 1n),
      callTrace(SEND + 300, CONTRACT, SELF, 50n * ONE_ETH),
    ];
    const { client, calls } = standIn({ derive: true, traces });
    const data = await rpcHistory(client, WALLET, TOP);
    expect(fundingTransfer(WALLET, data)).toMatchObject({ status: 'found', transfer: { from: SENDER, hash: real.transactionHash } });
    expect(walletAgeDays(WALLET, data, TOP_TIME)).toBe(AGE);
    expect(filteredBlocks(calls)).toEqual([B, SEND, SEND + 100, SEND + 200]);
    expect(data.external.transfers.find((transfer) => transfer.block === SEND)).toMatchObject({ from: SELF, failed: true });
  });

  it('weighs every inflow up to the read block for a wallet whose sends all failed', async () => {
    const late = callTrace(TOP - 5, CONTRACT, SELF, 9n * ONE_ETH);
    const traces = [callTrace(B, EXCHANGE, SELF, ONE_ETH), callTrace(SEND, SELF, SHOP, 0n, { error: 'Reverted' }), late];
    expect(fundingTransfer(WALLET, await rpcHistory(standIn({ derive: true, traces }).client, WALLET, TOP))).toMatchObject({
      status: 'found',
      transfer: { from: CONTRACT, hash: late.transactionHash },
    });
  });

  it(`fails when the sent count rose with no transaction of the wallet's own, and past ${MAX_FAILED_SEND_BLOCKS} blocks of failed sends (C11, C41)`, async () => {
    const funding = callTrace(B, EXCHANGE, SELF, ONE_ETH);
    await expect(rpcHistory(standIn({ funded: B, sent: SEND, traces: [funding] }).client, WALLET, TOP)).rejects.toThrow(
      'the sent count rose by something other than a transaction the wallet sent',
    );
    const failing = Array.from({ length: MAX_FAILED_SEND_BLOCKS + 1 }, (_, index) => callTrace(SEND + index * 10, SELF, SHOP, 0n, { error: 'Reverted', hash: hashOf(`failed ${index}`) }));
    const many = [funding, ...failing, callTrace(SEND + 1_000, SELF, SHOP, 1n)];
    await expect(rpcHistory(standIn({ derive: true, traces: many }).client, WALLET, TOP)).rejects.toThrow(`more than ${MAX_FAILED_SEND_BLOCKS} blocks hold only failed sends`);
    const few = [funding, ...failing.slice(0, MAX_FAILED_SEND_BLOCKS), callTrace(SEND + 1_000, SELF, SHOP, 1n)];
    expect(fundingTransfer(WALLET, await rpcHistory(standIn({ derive: true, traces: few }).client, WALLET, TOP))).toMatchObject({ status: 'found', transfer: { from: EXCHANGE } });
  });
});

describe('rpcFirstActivity', () => {
  it('dates the wallet by its first used block, null when never used, unknown when that block holds no qualifying row (C11, C20)', async () => {
    expect(await rpcFirstActivity(standIn({ funded: B, traces: [callTrace(B, EXCHANGE, SELF, ONE_ETH)] }).client, WALLET)).toEqual({ time: timeOf(B), block: TOP });
    expect(await rpcFirstActivity(standIn({}).client, WALLET)).toEqual({ time: null, block: TOP });
    const reward = { ...callTrace(B, SENDER, SELF, 0n), type: 'reward', action: { author: SELF, value: toHex(ONE_ETH) }, transactionHash: null };
    const unread: RawTrace[][] = [[], [callTrace(B, EXCHANGE, SELF, ONE_ETH, { error: 'Reverted' })], [callTrace(B, SENDER, SELF, 0n)], [reward]];
    for (const traces of unread) expect(await rpcFirstActivity(standIn({ funded: B, traces }).client, WALLET)).toBe('unknown');
    const refusing = standIn({ funded: B, traces: [callTrace(B, EXCHANGE, SELF, ONE_ETH)] }, (method) => (method === 'trace_filter' ? new RpcRefused('refused') : undefined));
    expect(await rpcFirstActivity(refusing.client, WALLET)).toBe('unknown');
  });

  it('reads nothing more once its signal aborts, and answers unknown (C41)', async () => {
    const stop = new AbortController();
    let asked = 0;
    const { client, calls } = standIn({ funded: B, traces: [callTrace(B, EXCHANGE, SELF, ONE_ETH)] }, () => {
      asked += 1;
      if (asked === 7) stop.abort();
      return undefined;
    });
    expect(await rpcFirstActivity(client, WALLET, stop.signal)).toBe('unknown');
    expect(calls).toHaveLength(7);
    expect(await rpcFirstActivity(client, WALLET, stop.signal)).toBe('unknown');
    expect(calls).toHaveLength(7);
  });
});

describe('historyProbe', () => {
  const traced = [callTrace(TOP, SENDER, SHOP, 1n, { hash: hashOf(`background ${TOP}`) })];

  it('passes an endpoint that serves old state and traces, stepping back from a finalized block with no transaction', async () => {
    expect(await historyProbe(standIn({ traces: traced }).client)).toEqual({ ok: true });
    const { client, calls } = standIn({ traces: [callTrace(TOP - 1, SENDER, SHOP, 1n, { hash: hashOf(`background ${TOP - 1}`) })], emptyBlocks: [TOP] });
    expect(await historyProbe(client)).toEqual({ ok: true });
    expect(calls.find((call) => call.method === 'eth_getBalance')?.params).toEqual(['0x0000000000000000000000000000000000000000', '0x1']);
  });

  it("answers its three failures: no answer, old state refused, traces refused or empty for a block with transactions", async () => {
    const failing = (method: string, error: Error) => standIn({ traces: traced }, (asked) => (asked === method ? error : undefined)).client;
    expect(await historyProbe(failing('eth_getBlockByNumber', new HistoryError('the RPC gave no answer to eth_getBlockByNumber')))).toEqual({ ok: false, lacks: 'no answer' });
    expect(await historyProbe(failing('eth_getBalance', new RpcRefused('the RPC refused eth_getBalance')))).toEqual({ ok: false, lacks: 'old state' });
    expect(await historyProbe(failing('eth_getBalance', new Error('socket hang up')))).toEqual({ ok: false, lacks: 'no answer' });
    expect(await historyProbe(failing('trace_filter', new RpcRefused('the RPC refused trace_filter')))).toEqual({ ok: false, lacks: 'traces' });
    expect(await historyProbe(failing('trace_transaction', new RpcRefused('the RPC refused trace_transaction')))).toEqual({ ok: false, lacks: 'traces' });
    expect(await historyProbe(standIn({ traces: [] }).client)).toEqual({ ok: false, lacks: 'traces' });
  });
});

describe('historyClientOf', () => {
  const URL_WITH_TOKEN = 'https://rpc.example.org/token-9f8e7d6c5b4a';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubNode(answer: (method: string) => Response) {
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string };
      const response = answer(method);
      if (response.status !== 200) return response;
      const body = (await response.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, ...body }), { headers: { 'content-type': 'application/json' } });
    });
    return historyClientOf(createPublicClient({ chain: mainnet, transport: http(URL_WITH_TOKEN, { retryCount: 0 }) }), async () => undefined);
  }

  it('turns a node error answer into RpcRefused and a failed request into no answer, with no endpoint address in either (C40)', async () => {
    const refusing = stubNode(() => Response.json({ error: { code: -32601, message: `trace_filter is not enabled for ${URL_WITH_TOKEN}` } }));
    const refusal = await refusing.request('trace_filter', [{}]).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RpcRefused);
    expect((refusal as Error).message).toBe('the RPC refused trace_filter');
    const silent = stubNode(() => new Response(`upstream ${URL_WITH_TOKEN} down`, { status: 502 }));
    const none = await silent.request('eth_getBalance', [SELF, '0x1']).catch((error: unknown) => error);
    expect(none).toBeInstanceOf(HistoryError);
    expect(none).not.toBeInstanceOf(RpcRefused);
    for (const error of [refusal, none] as Error[]) {
      expect(error.message).not.toContain('token-9f8e7d6c5b4a');
      expect(error.cause).toBeUndefined();
    }
    expect(await stubNode(() => Response.json({ result: '0x2a' })).request('eth_getBalance', [SELF, '0x1'])).toBe('0x2a');
  });

  it('sends a call that got no answer again after each wait and then fails, never retries a refusal, and makes no call it was not asked for (C41)', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    let asked = 0;
    const flaky = historyClientOf({ request: async () => (++asked < 3 ? Promise.reject(new Error('socket hang up')) : '0x2a') } as never, sleep);
    expect(await flaky.request('eth_getBalance', [SELF, '0x1'])).toBe('0x2a');
    expect([asked, waits]).toEqual([3, [...NO_ANSWER_WAITS_MS]]);

    waits.length = 0;
    asked = 0;
    const dead = historyClientOf({ request: async () => (asked++, Promise.reject(new Error('socket hang up'))) } as never, sleep);
    await expect(dead.request('eth_getBalance', [SELF, '0x1'])).rejects.toThrow('the RPC gave no answer to eth_getBalance');
    expect([asked, waits]).toEqual([NO_ANSWER_WAITS_MS.length + 1, [...NO_ANSWER_WAITS_MS]]);

    waits.length = 0;
    let fetches = 0;
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      fetches += 1;
      const { id } = JSON.parse(String(init?.body)) as { id: number };
      return Response.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'not enabled' } });
    });
    const refusing = historyClientOf(createPublicClient({ chain: mainnet, transport: http(URL_WITH_TOKEN, { retryCount: 0 }) }), sleep);
    await expect(refusing.request('trace_filter', [{}])).rejects.toBeInstanceOf(RpcRefused);
    expect([fetches, waits]).toEqual([1, []]);
  });

  it(`runs at most ${MAX_CALLS_IN_FLIGHT} calls at once and still answers every one (C41)`, async () => {
    let running = 0;
    let most = 0;
    const release: (() => void)[] = [];
    const slow = historyClientOf({
      request: async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise<void>((resolve) => release.push(resolve));
        running -= 1;
        return '0x1';
      },
    } as never);
    const all = Promise.all(Array.from({ length: MAX_CALLS_IN_FLIGHT * 3 }, (_, index) => slow.request('eth_getBalance', [SELF, toHex(index)])));
    for (let done = 0; done < MAX_CALLS_IN_FLIGHT * 3; done += 1) {
      while (release.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(running).toBeLessThanOrEqual(MAX_CALLS_IN_FLIGHT);
      release.shift()?.();
    }
    expect(await all).toHaveLength(MAX_CALLS_IN_FLIGHT * 3);
    expect(most).toBe(MAX_CALLS_IN_FLIGHT);
  });

  it('lets the probe tell a node that refuses traces from one that gives no answer', async () => {
    const node = (method: string) =>
      method === 'eth_getBlockByNumber'
        ? Response.json({ result: { number: toHex(TOP), timestamp: toHex(TOP_TIME), transactions: [hashOf('t')] } })
        : method === 'eth_getBalance'
          ? Response.json({ result: '0x0' })
          : Response.json({ error: { code: -32611, message: 'rejected due to request filter settings' } });
    expect(await historyProbe(stubNode(node))).toEqual({ ok: false, lacks: 'traces' });
    expect(await historyProbe(stubNode(() => new Response('', { status: 500 })))).toEqual({ ok: false, lacks: 'no answer' });
  });
});

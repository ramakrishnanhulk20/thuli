import { RpcRequestError, type PublicClient } from 'viem';
import { z } from 'zod';
import { firstActivityTime, type Address, type AddressData, type Transfer } from '@thuli/core';

/**
 * Blocks the first-used-block search reads at most, the block at the top included. A halving search over any block
 * number a JavaScript number can hold ends within 54, so the cap is never what stops a real search (C41).
 */
export const MAX_SEARCH_STEPS = 64;
/** Traces one trace_filter answer may hold for one wallet in one block. A wallet's first block holds a handful. */
export const MAX_BLOCK_TRACES = 1_000;
/**
 * Transactions in one block whose whole trace is read to check the frames above an internal transfer. Past this the
 * read fails rather than reading on (C41).
 */
export const MAX_TRACED_TRANSACTIONS = 16;
// A transaction's whole trace: a block's gas cannot pay for many more calls than this.
const MAX_TRANSACTION_TRACES = 100_000;
// The finalized block can hold no transaction to trace; the probe looks this many blocks back for one that does.
const PROBE_BLOCKS = 4;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
// Causes are followed this far looking for the node's own error answer; a cause chain could loop.
const MAX_CAUSE_DEPTH = 8;

/**
 * The one JSON-RPC call the history reads need. It resolves with the node's result. It rejects with RpcRefused when the
 * node answered but not with what was asked, and with any other error when it gave no answer.
 */
export interface HistoryClient {
  /** `signal`, when given, stops a call that has not been sent yet or is waiting to be sent again. */
  request(method: string, params: readonly unknown[], signal?: AbortSignal): Promise<unknown>;
}

/** An error this file wrote, in fixed words: never an endpoint address, a key, or a value the node sent (C40). */
export class HistoryError extends Error {
  override name = 'HistoryError';
}

/** The node answered, with an error or with an answer out of shape, so it does not serve what was asked. */
export class RpcRefused extends HistoryError {
  override name = 'RpcRefused';
}

/**
 * Error codes a node answers when it is asked too fast, which says nothing about what it serves: HTTP's 429 written into
 * a JSON-RPC body, EIP-1474's limit exceeded, and QuickNode's per-second, per-minute, per-method and plain rate limits,
 * as its error reference lists them. A call answered with one is sent again like a call that got no answer. Not covered:
 * a provider that reports a rate limit under any other code. That reads as a refusal, so the read it belongs to fails
 * and its try is given back, and at start the probe reads it as something the endpoint lacks.
 */
export const TRY_LATER_CODES: readonly number[] = [429, -32005, -32007, -32008, -32011, -32029];

// True when the node answered with an error about the request itself, not about how fast it was asked.
function answeredWithError(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause instanceof Error; depth += 1) {
    if (cause instanceof RpcRequestError) return !TRY_LATER_CODES.includes(cause.code);
    cause = cause.cause;
  }
  return false;
}

/** Calls one history client has in flight at most. A search level asks for many balances at once, and a paid endpoint
 * answers a burst past its rate with no answer at all. */
export const MAX_CALLS_IN_FLIGHT = 6;
/** Waits before a call that got no answer is sent again, in milliseconds. After the last, the read fails (C41). */
export const NO_ANSWER_WAITS_MS: readonly number[] = [400, 1_200];

/**
 * A HistoryClient on a viem client, chainClient's in production, so every call keeps its 15 second timeout. At most
 * MAX_CALLS_IN_FLIGHT calls run at once, and a call that got no answer (a rate limit, a dropped connection, an error
 * answer with one of TRY_LATER_CODES) is sent again after each of NO_ANSWER_WAITS_MS; a call the node refused is not. A
 * call whose signal has aborted is not sent, whether it was waiting for a place or for its next send, so a read that was
 * given up on stops holding the places the next read needs (C41). viem's own errors name the endpoint, which can carry a
 * token, so a failure leaves here as fixed words with no cause attached (C40).
 */
export function historyClientOf(
  client: Pick<PublicClient, 'request'>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): HistoryClient {
  let inFlight = 0;
  const waiting: (() => void)[] = [];
  const enter = async () => {
    if (inFlight >= MAX_CALLS_IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve));
    else inFlight += 1;
  };
  // A finished call hands its place straight to the next waiting one, so the count never passes the cap.
  const leave = () => {
    const next = waiting.shift();
    if (next === undefined) inFlight -= 1;
    else next();
  };
  return {
    async request(method, params, signal) {
      // Asked through a function each time: the signal can abort while this call waits for a place or for its next send.
      const stopped = () => signal?.aborted === true;
      if (stopped()) throw new HistoryError('the read was stopped');
      await enter();
      try {
        for (let attempt = 0; ; attempt += 1) {
          if (stopped()) throw new HistoryError('the read was stopped');
          try {
            const result: unknown = await client.request({ method, params: [...params] } as never);
            return result;
          } catch (error) {
            if (answeredWithError(error)) throw new RpcRefused(`the RPC refused ${method}`);
            const wait = NO_ANSWER_WAITS_MS[attempt];
            if (wait === undefined) throw new HistoryError(`the RPC gave no answer to ${method}`);
            await sleep(wait);
          }
        }
      } finally {
        leave();
      }
    },
  };
}

/**
 * RPC calls one history read may ask for at most: one chain's first-activity read for the pick, or the full facts read on
 * the chosen chain. Measured on the stand-in chains at Ethereum's and Base's heights (campaignChain.test.ts), a wallet
 * funded once and then active asks for 55 and 57 calls in a pick and 99 and 105 in its facts read. The other caps in this
 * file each bound one part of a read; this bounds the whole, so a wallet shaped to reach several of them at once is not read,
 * rather than read slowly (C41, C49). A call sent again after no answer counts once.
 */
export const MAX_READ_CALLS = 1_000;

/** A HistoryClient for one read: it refuses every call past `max` in fixed words, without sending it. */
export function callBudget(client: HistoryClient, max: number): HistoryClient {
  let asked = 0;
  return {
    request(method, params, signal) {
      if (asked >= max) return Promise.reject(new HistoryError(`the read asked for more than ${max} RPC calls`));
      asked += 1;
      return client.request(method, params, signal);
    },
  };
}

const QUANTITY = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const TX_HASH = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const Header = z.object({ number: QUANTITY, timestamp: QUANTITY, transactions: z.array(z.unknown()) });

const Trace = z.object({
  type: z.string(),
  action: z.record(z.string(), z.unknown()),
  error: z.string().nullable().optional(),
  traceAddress: z.array(z.int().min(0)).max(1_024),
  transactionHash: TX_HASH.nullable().optional(),
  blockNumber: z.int().min(0),
});
type Trace = z.infer<typeof Trace>;

const CallType = z.object({ callType: z.string() });
const CallAction = z.object({ from: ADDRESS, to: ADDRESS, value: QUANTITY, callType: z.string() });
const CreateAction = z.object({ from: ADDRESS, value: QUANTITY });
const SelfdestructAction = z.object({ address: ADDRESS, refundAddress: ADDRESS, balance: QUANTITY });
// Parity-style nodes name the opcode's trace 'suicide'; newer ones may say 'selfdestruct'.
const SELFDESTRUCT_TYPES: readonly string[] = ['suicide', 'selfdestruct'];

const hex = (n: number) => `0x${n.toString(16)}`;
const isBlock = (n: number) => Number.isSafeInteger(n) && n >= 0;

function parsed<T>(schema: z.ZodType<T>, value: unknown, method: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RpcRefused(`the RPC answer to ${method} was out of shape`);
  return result.data;
}

function wholeNumber(quantity: string, method: string): number {
  const value = Number(BigInt(quantity));
  if (!Number.isSafeInteger(value)) throw new RpcRefused(`the RPC answer to ${method} was out of range`);
  return value;
}

async function header(client: HistoryClient, tag: string): Promise<{ number: number; time: number; transactions: number }> {
  const head = parsed(Header, await client.request('eth_getBlockByNumber', [tag, false]), 'eth_getBlockByNumber');
  return {
    number: wholeNumber(head.number, 'eth_getBlockByNumber'),
    time: wholeNumber(head.timestamp, 'eth_getBlockByNumber'),
    transactions: head.transactions.length,
  };
}

/** The chain's latest finalized block number, the block every campaign read is taken at. */
export async function finalizedBlock(client: HistoryClient): Promise<number> {
  return (await header(client, 'finalized')).number;
}

/**
 * One block's time in seconds, from its header.
 *
 * @throws HistoryError for a block that is not a whole number, a read that fails, or a header naming another block.
 */
export async function blockTime(client: HistoryClient, block: number): Promise<number> {
  if (!isBlock(block)) throw new HistoryError('the block must be a whole number of 0 or more');
  const head = await header(client, hex(block));
  if (head.number !== block) throw new RpcRefused('the RPC answer to eth_getBlockByNumber named another block');
  return head.time;
}

// One step of the search: both reads for the block at once, so a step costs one round trip.
async function usedAt(client: HistoryClient, wallet: string, block: number): Promise<boolean> {
  const tag = hex(block);
  const [nonce, balance] = await Promise.all([
    client.request('eth_getTransactionCount', [wallet, tag]),
    client.request('eth_getBalance', [wallet, tag]),
  ]);
  return BigInt(parsed(QUANTITY, nonce, 'eth_getTransactionCount')) > 0n || BigInt(parsed(QUANTITY, balance, 'eth_getBalance')) > 0n;
}

/**
 * The lowest block at or before `top` where the wallet's sent count or its balance is above zero, found by halving
 * [0, top], two reads a step, at most MAX_SEARCH_STEPS steps (C41).
 *
 * Halving is right only when the test, once true, stays true at every later block. It does for an account without code:
 * its balance can fall only through a transaction it signs, which raises its sent count, and a sent count never falls.
 * A wallet that delegates its code under EIP-7702 raised its sent count by doing so, so it stays covered. Not covered: a
 * contract account, whose code can send its balance away with no sent count, and which the campaign refuses at the door.
 * For one, the block found may not be its first.
 *
 * @returns the block, or null when the sent count and the balance are both zero at `top`.
 * @throws HistoryError for a top that is not a whole number, a read that fails or comes back out of shape, or the step
 *   cap. Its message holds no endpoint address (C40).
 */
export async function firstUsedBlock(client: HistoryClient, wallet: Address, top: number): Promise<number | null> {
  if (!isBlock(top)) throw new HistoryError('the top block must be a whole number of 0 or more');
  const self = wallet.toLowerCase();
  if (!(await usedAt(client, self, top))) return null;
  let low = 0;
  let high = top;
  for (let steps = 1; low < high; steps += 1) {
    if (steps >= MAX_SEARCH_STEPS) throw new HistoryError(`the first used block was not found in ${MAX_SEARCH_STEPS} steps`);
    const middle = low + Math.floor((high - low) / 2);
    if (await usedAt(client, self, middle)) high = middle;
    else low = middle + 1;
  }
  return high;
}

/**
 * The lowest block in [from, top] where the wallet's sent count is above zero, by halving on the sent count alone, one
 * read a step: a sent count never falls, so the test stays true once it turns true. At most MAX_SEARCH_STEPS steps, and
 * never more than 1 + ceil(log2(top - from + 1)) reads (C41). The sent count also rises for a failed transaction and
 * for an EIP-7702 delegation, so the block found is where the wallet first spent its nonce, not always a send that
 * succeeded; rpcHistory checks which.
 *
 * @returns the block, or null when the sent count is zero at `top`.
 * @throws HistoryError for blocks out of order, a read that fails or comes back out of shape, or the step cap.
 */
export async function firstSendBlock(client: HistoryClient, wallet: Address, from: number, top: number): Promise<number | null> {
  return firstBlockWithSentCount(client, wallet, 1, from, top);
}

async function sentCountAt(client: HistoryClient, self: string, block: number): Promise<number> {
  return wholeNumber(parsed(QUANTITY, await client.request('eth_getTransactionCount', [self, hex(block)]), 'eth_getTransactionCount'), 'eth_getTransactionCount');
}

/**
 * The lowest block in [from, top] where the wallet's sent count is at least `atLeast`, by the same halving as
 * firstSendBlock and within the same bound; null when the count is below it at `top`. rpcHistory walks a wallet's first
 * spends with it, one at a time, until one of them succeeded.
 */
async function firstBlockWithSentCount(client: HistoryClient, wallet: Address, atLeast: number, from: number, top: number): Promise<number | null> {
  if (!isBlock(from) || !isBlock(top) || from > top) throw new HistoryError('the blocks must be whole numbers with from at or before top');
  const self = wallet.toLowerCase();
  const reached = async (block: number) => (await sentCountAt(client, self, block)) >= atLeast;
  if (!(await reached(top))) return null;
  let low = from;
  let high = top;
  for (let steps = 1; low < high; steps += 1) {
    if (steps >= MAX_SEARCH_STEPS) throw new HistoryError(`the first send block was not found in ${MAX_SEARCH_STEPS} steps`);
    const middle = low + Math.floor((high - low) / 2);
    if (await reached(middle)) high = middle;
    else low = middle + 1;
  }
  return high;
}

/** Blocks that paid the wallet one history read gathers at most before it is 'too many' (C41). */
export const MAX_INFLOW_BLOCKS = 24;
/**
 * Balance reads one inflowBlocks call makes at most. Twenty-four inflow blocks spread across Base's whole history could
 * need about 630; past this budget the answer is 'too many', so such a wallet reads as unknown rather than slowly (C41).
 */
export const MAX_INFLOW_READS = 400;

/** Blocks after..at, with the balance at both ends: it holds an inflow block exactly when `high` is above `low`. */
interface Span {
  after: number;
  at: number;
  low: bigint;
  high: bigint;
}

/**
 * Every block in [from, to) where the wallet's balance is higher than at the block before, found by halving every span
 * whose balance rose, one level at a time, the spans of a level read at once.
 *
 * Sound only where the balance never falls, which holds for an account without code before its first own send: nothing
 * can take its money until it signs, and signing raises its sent count. So callers pass `to` no later than the wallet's
 * first send block (firstSendBlock). On that range every block the balance rose in holds a successful inflow or money
 * that came with no transaction (a staking withdrawal), and a failed or zero-value inflow, which core ignores, moves no
 * balance and is not found. A fall seen on the range means the premise broke, and the read fails. Not covered: a
 * contract account, or a range past the first send, where gas and sends lower the balance and inflows can hide behind
 * them.
 *
 * Each live span holds at least one inflow block, so more live spans and found blocks than `cap`, or a level that would
 * pass MAX_INFLOW_READS reads, answers 'too many' at once. Reads at most min(MAX_INFLOW_READS, 2 + cap *
 * ceil(log2(to - from))) balances (C41).
 *
 * @returns the blocks in rising order, or 'too many'.
 * @throws HistoryError for blocks out of order, a read that fails or comes back out of shape, or a balance that fell.
 */
export async function inflowBlocks(client: HistoryClient, wallet: Address, from: number, to: number, cap: number): Promise<number[] | 'too many'> {
  const found = await inflowsIn(client, wallet, from, to, cap);
  return found === 'too many' ? found : found.map((inflow) => inflow.block);
}

/** A block that paid the wallet, and how much its balance rose in that block, in wei. */
interface Inflow {
  block: number;
  rise: bigint;
}

// inflowBlocks' search, keeping each found block's rise: the two balances that found it are already read.
async function inflowsIn(client: HistoryClient, wallet: Address, from: number, to: number, cap: number): Promise<Inflow[] | 'too many'> {
  if (!isBlock(from) || !isBlock(to) || from > to || !isBlock(cap)) throw new HistoryError('the blocks must be whole numbers with from at or before to');
  if (from === to) return [];
  const self = wallet.toLowerCase();
  let reads = 0;
  // Nothing holds a balance before the first block, so that end needs no read.
  const balanceAt = async (block: number): Promise<bigint> => {
    if (block < 0) return 0n;
    reads += 1;
    return BigInt(parsed(QUANTITY, await client.request('eth_getBalance', [self, hex(block)]), 'eth_getBalance'));
  };
  const [low, high] = await Promise.all([balanceAt(from - 1), balanceAt(to - 1)]);
  if (high < low) throw new HistoryError('the balance fell before the first send, so the inflows could not be found');
  let open: Span[] = high > low ? [{ after: from - 1, at: to - 1, low, high }] : [];
  const found: Inflow[] = [];
  while (open.length > 0) {
    if (found.length + open.length > cap) return 'too many';
    const splits: Span[] = [];
    for (const span of open) {
      if (span.at - span.after === 1) found.push({ block: span.at, rise: span.high - span.low });
      else splits.push(span);
    }
    if (reads + splits.length > MAX_INFLOW_READS) return 'too many';
    const middles = await Promise.all(splits.map(async (span) => {
      const block = span.after + Math.floor((span.at - span.after) / 2);
      return { span, block, balance: await balanceAt(block) };
    }));
    open = [];
    for (const { span, block, balance } of middles) {
      if (balance < span.low || balance > span.high) throw new HistoryError('the balance fell before the first send, so the inflows could not be found');
      if (balance > span.low) open.push({ after: span.after, at: block, low: span.low, high: balance });
      if (span.high > balance) open.push({ after: block, at: span.at, low: balance, high: span.high });
    }
  }
  return found.sort((a, b) => a.block - b.block);
}

async function tracesWhere(client: HistoryClient, filter: Record<string, unknown>): Promise<Trace[]> {
  return parsed(z.array(Trace).max(MAX_BLOCK_TRACES), await client.request('trace_filter', [filter]), 'trace_filter');
}

const frameKey = (traceAddress: readonly number[]) => traceAddress.join('.');

/** A trace read as a value movement, before the frames above it are checked. */
interface Move {
  hash: string;
  traceAddress: number[];
  from: string;
  to: string | null;
  valueWei: string;
  ownError: boolean;
  kind: Transfer['kind'];
}

/**
 * One trace as a value movement touching the wallet, null when it moves no value to or from it, or a throw when it is a
 * kind this reader does not read and it moved value toward the wallet, so such money is never read as "no transfer".
 */
function moveOf(trace: Trace, self: string, toward: boolean): Move | null {
  const ownError = typeof trace.error === 'string';
  if (trace.type === 'call') {
    // A delegatecall, staticcall or callcode moves no value to its target, whatever its value field says.
    if (parsed(CallType, trace.action, 'trace_filter').callType !== 'call') return null;
    const action = parsed(CallAction, trace.action, 'trace_filter');
    const hash = parsed(TX_HASH, trace.transactionHash, 'trace_filter');
    const from = action.from.toLowerCase();
    const to = action.to.toLowerCase();
    if (from !== self && to !== self) return null;
    const kind = trace.traceAddress.length === 0 ? 'external' : 'internal';
    return { hash: hash.toLowerCase(), traceAddress: trace.traceAddress, from, to, valueWei: BigInt(action.value).toString(), ownError, kind };
  }
  if (SELFDESTRUCT_TYPES.includes(trace.type)) {
    const action = parsed(SelfdestructAction, trace.action, 'trace_filter');
    const hash = parsed(TX_HASH, trace.transactionHash, 'trace_filter');
    const from = action.address.toLowerCase();
    const to = action.refundAddress.toLowerCase();
    if (from !== self && to !== self) return null;
    // The destroyed contract pays out inside someone's transaction, so this is value a contract moved.
    return { hash: hash.toLowerCase(), traceAddress: trace.traceAddress, from, to, valueWei: BigInt(action.balance).toString(), ownError, kind: 'internal' };
  }
  if (trace.type === 'create' && trace.traceAddress.length === 0) {
    const action = parsed(CreateAction, trace.action, 'trace_filter');
    // A deployment the wallet signed is its own transaction, so core counts it as an own send, as the explorer lists it.
    if (action.from.toLowerCase() === self) {
      const hash = parsed(TX_HASH, trace.transactionHash, 'trace_filter');
      return { hash: hash.toLowerCase(), traceAddress: [], from: self, to: null, valueWei: BigInt(action.value).toString(), ownError, kind: 'external' };
    }
  }
  if (!toward) return null;
  const value = QUANTITY.safeParse(trace.action.value ?? trace.action.balance);
  if (!value.success || BigInt(value.data) > 0n) {
    throw new HistoryError('a trace of a kind this reader does not read moved value to the wallet, so the block was not read');
  }
  return null;
}

/**
 * The frames that carry an error in one transaction, read from its whole trace, and the frames it holds at all, so a
 * transfer inside a frame that reverted later counts as failed: a node marks only the frame that reverted.
 */
async function framesOf(client: HistoryClient, hash: string, block: number): Promise<{ held: Set<string>; errored: Set<string> }> {
  const all = parsed(z.array(Trace).max(MAX_TRANSACTION_TRACES), await client.request('trace_transaction', [hash]), 'trace_transaction');
  const held = new Set<string>();
  const errored = new Set<string>();
  for (const trace of all) {
    if (trace.transactionHash?.toLowerCase() !== hash || trace.blockNumber !== block) {
      throw new RpcRefused('the RPC answer to trace_transaction named another transaction or block');
    }
    const key = frameKey(trace.traceAddress);
    held.add(key);
    if (typeof trace.error === 'string') errored.add(key);
  }
  return { held, errored };
}

/**
 * Every value movement to or from the wallet in one block, from trace_filter with that block as both ends, asked once
 * for traces to the wallet and once for traces from it. A trace becomes a core Transfer: 'external' when it is the
 * transaction itself (an empty traceAddress), else 'internal'; failed when it, or any frame above it in the same
 * transaction, carries an error, which takes one trace_transaction read per transaction holding an internal transfer;
 * the value in decimal wei; the block's own time. Only a call trace of call type 'call' counts. A selfdestruct that
 * pays the wallet counts as an internal transfer from the destroyed contract. A contract the wallet deploys in its own
 * transaction is an external transfer with no `to`, an own send to core; one a frame inside a call creates is not read.
 *
 * @throws HistoryError when a read fails or comes back out of shape, when any other kind of trace moved value toward the
 *   wallet (a block reward, for one), when more than MAX_TRACED_TRANSACTIONS transactions need their frames checked, or
 *   when a transaction's trace lacks a frame above a transfer, so the block is never read short (C11). Its message holds
 *   no endpoint address (C40).
 */
export async function transfersInBlock(client: HistoryClient, wallet: Address, block: number): Promise<{ external: Transfer[]; internal: Transfer[] }> {
  if (!isBlock(block)) throw new HistoryError('the block must be a whole number of 0 or more');
  const self = wallet.toLowerCase();
  const range = { fromBlock: hex(block), toBlock: hex(block) };
  const [head, toWallet, fromWallet] = await Promise.all([
    header(client, hex(block)),
    tracesWhere(client, { ...range, toAddress: [self] }),
    tracesWhere(client, { ...range, fromAddress: [self] }),
  ]);
  if (head.number !== block) throw new RpcRefused('the RPC answer to eth_getBlockByNumber named another block');
  // A wallet paying itself is in both answers; it is one movement.
  const moves = new Map<string, Move>();
  for (const [traces, toward] of [[toWallet, true], [fromWallet, false]] as const) {
    for (const trace of traces) {
      if (trace.blockNumber !== block) throw new RpcRefused('the RPC answer to trace_filter named another block');
      const move = moveOf(trace, self, toward);
      if (move !== null) moves.set(`${move.hash}:${frameKey(move.traceAddress)}`, move);
    }
  }
  const nested = [...new Set([...moves.values()].filter((move) => move.traceAddress.length > 0).map((move) => move.hash))];
  if (nested.length > MAX_TRACED_TRANSACTIONS) {
    throw new HistoryError(`more than ${MAX_TRACED_TRANSACTIONS} transactions in the block moved value inside a call to or from the wallet`);
  }
  const frames = new Map(await Promise.all(nested.map(async (hash) => [hash, await framesOf(client, hash, block)] as const)));
  const external: Transfer[] = [];
  const internal: Transfer[] = [];
  for (const move of moves.values()) {
    let failed = move.ownError;
    const tree = frames.get(move.hash);
    for (let depth = 0; depth < move.traceAddress.length; depth += 1) {
      const above = frameKey(move.traceAddress.slice(0, depth));
      if (tree === undefined || !tree.held.has(above)) throw new RpcRefused('the RPC answer to trace_transaction lacked a frame above a transfer');
      if (tree.errored.has(above)) failed = true;
    }
    const transfer: Transfer = { hash: move.hash, block, time: head.time, from: move.from, to: move.to, valueWei: move.valueWei, failed, kind: move.kind };
    (move.kind === 'external' ? external : internal).push(transfer);
  }
  return { external, internal };
}

// Blocks whose transfers are read at once: each costs three calls, plus one per transaction holding an internal transfer.
const BLOCKS_AT_ONCE = 4;

type BlockRows = { external: Transfer[]; internal: Transfer[] };

const unsure = (rows: BlockRows): AddressData => ({ external: { transfers: rows.external, complete: false }, internal: { transfers: rows.internal, complete: false } });

/**
 * Blocks in which the wallet spent its nonce on transactions that all failed, walked at most before its first send that
 * succeeded is given up on (C41). A wallet whose first transaction failed is common; one with five such blocks first is not.
 */
export const MAX_FAILED_SEND_BLOCKS = 4;

/**
 * The wallet's history at or before `block`, read with plain RPC calls, in the shape core's facts functions take: the
 * transfers of its first used block F (firstUsedBlock), of every block that paid it before its first send that
 * succeeded (inflowBlocks), and of the block S that holds that send, or of `block` itself when it never sent.
 *
 * For an account without code these are all the rows fundingTransfer, firstActivityTime and walletAgeDays can depend on.
 * Before F the wallet had signed nothing and held nothing. Until it signs, nothing can leave it, so every block a
 * successful inflow reached raised its balance and is found. S holds its first own send, the bound of core's funder
 * rule, and what comes after S is later than that send. So core's funder is the largest inflow at or before the first
 * send over these rows, as over the explorer's whole history, and the age counts from F.
 *
 * A first transaction that failed still spent the nonce and the gas, but it is not a send to core. So the blocks where
 * the sent count rises are walked in order: each is read whole, and the stretch after it is searched for inflows from
 * the balance it left, until a block holds a send that succeeded. Between two such blocks the wallet signs nothing, so
 * the balance again only rises.
 *
 * Where that cannot be established the read fails rather than give part of a history (C11): F holds no transfer that
 * dates the wallet (money that came with no transaction, such as a staking withdrawal); the sent count rose by more or
 * less than the wallet's own transactions in that block (an EIP-7702 delegation, after which its code can move its
 * balance); more than MAX_FAILED_SEND_BLOCKS blocks hold only failed sends; more than MAX_INFLOW_BLOCKS blocks paid
 * it; or the transfers read for a block that paid it do not add up to that block's rise in its balance. The last is two
 * reads of one fact disagreeing: a trace answer cut short would otherwise drop the real funding and leave a smaller
 * payer as the funder. It also refuses a block that paid the wallet with no transaction at all (a staking withdrawal, a
 * block's fees), since nothing read there says who paid. Both pages of a used wallet are marked incomplete, so core finds a funder among the rows or says 'unknown', never
 * 'none'. A wallet never used comes back as two empty, complete pages, what the explorer reads for it.
 *
 * @throws HistoryError when any read fails or any of those cases holds. Its message holds no endpoint address (C40).
 */
export async function rpcHistory(client: HistoryClient, wallet: Address, block: number): Promise<AddressData> {
  const first = await firstUsedBlock(client, wallet, block);
  if (first === null) return { external: { transfers: [], complete: true }, internal: { transfers: [], complete: true } };
  const self = wallet.toLowerCase();
  const rows = new Map<number, BlockRows>();
  const rowsAt = async (at: number): Promise<BlockRows> => {
    const known = rows.get(at);
    if (known !== undefined) return known;
    const read = await transfersInBlock(client, wallet, at);
    rows.set(at, read);
    return read;
  };
  const tooMany = () =>
    new HistoryError(`more than ${MAX_INFLOW_BLOCKS} blocks paid the wallet before its first send, or finding them passed ${MAX_INFLOW_READS} reads`);

  const blocks = new Set<number>([first]);
  const rises = new Map<number, bigint>();
  let from = first;
  let nextCount = 1;
  for (let failedBlocks = 0; ; ) {
    const spent = await firstBlockWithSentCount(client, wallet, nextCount, from, block);
    const end = spent ?? block;
    const paid = await inflowsIn(client, wallet, from, end, MAX_INFLOW_BLOCKS);
    if (paid === 'too many') throw tooMany();
    for (const inflow of paid) {
      blocks.add(inflow.block);
      rises.set(inflow.block, inflow.rise);
    }
    blocks.add(end);
    if (blocks.size > MAX_INFLOW_BLOCKS + MAX_FAILED_SEND_BLOCKS + 2) throw tooMany();
    if (spent === null) break;
    const own = (await rowsAt(spent)).external.filter((transfer) => transfer.from === self);
    if (own.some((transfer) => !transfer.failed)) break;
    // Every rise of the sent count here must be a transaction of the wallet's own that failed. Anything else, a
    // delegation above all, means its balance may now move without it signing, and the search below would be unsound.
    const [before, after] = await Promise.all([spent === 0 ? 0 : sentCountAt(client, self, spent - 1), sentCountAt(client, self, spent)]);
    if (own.length === 0 || after - before !== own.length) {
      throw new HistoryError('the sent count rose by something other than a transaction the wallet sent, so its inflows could not be found');
    }
    failedBlocks += 1;
    if (failedBlocks > MAX_FAILED_SEND_BLOCKS) throw new HistoryError(`more than ${MAX_FAILED_SEND_BLOCKS} blocks hold only failed sends before the first send that succeeded`);
    if (spent === block) break;
    from = spent + 1;
    nextCount = after + 1;
  }

  const ordered = [...blocks].sort((a, b) => a - b);
  for (let start = 0; start < ordered.length; start += BLOCKS_AT_ONCE) {
    await Promise.all(ordered.slice(start, start + BLOCKS_AT_ONCE).map((at) => rowsAt(at)));
  }
  const read = (at: number): BlockRows => rows.get(at) ?? { external: [], internal: [] };
  // The picker dates the wallet by the same rule over the same block, so the pick and the age stay one thing (C20).
  if (firstActivityTime(wallet, unsure(read(first))) === null) throw new HistoryError('the first used block holds no transfer that dates the wallet');
  // In a block found by its balance rise the wallet signed nothing, so the rise is exactly what was paid in. Rows that
  // add up to anything else were read short, or the money came with no transaction, and either way the funder is not known.
  for (const [at, rise] of rises) {
    const here = read(at);
    let received = 0n;
    for (const transfer of [...here.external, ...here.internal]) {
      if (transfer.to === self && transfer.from !== self && !transfer.failed) received += BigInt(transfer.valueWei);
    }
    if (received !== rise) throw new HistoryError("the transfers read for a block do not add up to the rise in the wallet's balance there");
  }
  return unsure({ external: ordered.flatMap((at) => read(at).external), internal: ordered.flatMap((at) => read(at).internal) });
}

export type HistoryLack = 'chain' | 'old state' | 'traces' | 'no answer';

/**
 * Whether an endpoint can serve rpcHistory for the chain with id `chainId`: its own chain id, its finalized block, a
 * balance at block 1 (old state), and trace_filter on one recent finalized block, with trace_transaction on the
 * transaction found there, since transfersInBlock needs both. The finalized block can hold no transaction, so up to four
 * blocks back are tried for one that does. The chain id comes first: an endpoint of another chain would answer every
 * read, about the wrong wallets.
 *
 * @returns ok, or what the endpoint lacks: 'no answer' when a read gets no answer at all, else 'chain' when it names
 *   another chain id or refuses to name one, 'old state' or 'traces' for the read it refused or answered out of shape.
 *   Never throws, and holds nothing the endpoint sent (C40).
 */
export async function historyProbe(client: HistoryClient, chainId: number): Promise<{ ok: true } | { ok: false; lacks: HistoryLack }> {
  const lacking = (lack: HistoryLack, error: unknown) => ({ ok: false as const, lacks: error instanceof RpcRefused ? lack : 'no answer' });
  try {
    const named = wholeNumber(parsed(QUANTITY, await client.request('eth_chainId', []), 'eth_chainId'), 'eth_chainId');
    if (named !== chainId) return { ok: false, lacks: 'chain' };
  } catch (error) {
    return lacking('chain', error);
  }
  let head: { number: number; transactions: number };
  try {
    head = await header(client, 'finalized');
  } catch {
    return { ok: false, lacks: 'no answer' };
  }
  try {
    parsed(QUANTITY, await client.request('eth_getBalance', [ZERO_ADDRESS, '0x1']), 'eth_getBalance');
  } catch (error) {
    return lacking('old state', error);
  }
  try {
    for (let back = 0; back < PROBE_BLOCKS && head.number - back >= 0; back += 1) {
      const block = head.number - back;
      const at = back === 0 ? head : await header(client, hex(block));
      const [first] = await tracesWhere(client, { fromBlock: hex(block), toBlock: hex(block), count: 1 });
      if (first === undefined) {
        if (at.transactions > 0) return { ok: false, lacks: 'traces' };
        continue;
      }
      const hash = parsed(TX_HASH, first.transactionHash, 'trace_filter').toLowerCase();
      if (first.blockNumber !== block || !(await framesOf(client, hash, block)).held.has('')) return { ok: false, lacks: 'traces' };
      return { ok: true };
    }
    return { ok: false, lacks: 'traces' };
  } catch (error) {
    return lacking('traces', error);
  }
}

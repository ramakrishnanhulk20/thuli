import path from 'node:path';
import { z } from 'zod';
import { parseAddress, type AccountState } from '@thuli/core';
import { fetchJsonCapped } from '../http.ts';
import { JsonlCache } from './jsonlCache.ts';
import { pause, RateLimiter, RETRY_DELAYS_MS } from './rateLimiter.ts';

export const RPC_TIMEOUT_MS = 20_000;
export const DEFAULT_BATCH_SIZE = 50;
// Two calls per address, and 1,000 calls is the most common ceiling hosted nodes put on one batch.
const MAX_BATCH_SIZE = 500;
// Contract code is at most 24,576 bytes today (EIP-170), 49,152 hex characters. 128 KB per address leaves room for a
// larger code limit and the JSON around it, while a batch reply still has a fixed ceiling (C41).
const MAX_REPLY_BYTES_PER_ADDRESS = 128 * 1024;

// The facts engine reads these states as they are, so the shape comes from core and cannot drift. A code of '0x' means
// the account has no code.
export type { AccountState };

const RpcItem = z.object({ id: z.int(), result: z.unknown().optional(), error: z.unknown().optional() });
const Quantity = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,16}$/)
  .transform((hex) => BigInt(hex))
  .refine((value) => value <= BigInt(Number.MAX_SAFE_INTEGER))
  .transform(Number);
const HexBytes = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/)
  .transform((hex) => hex.toLowerCase());

const StoredState = z.object({ nonce: z.int().min(0), code: z.string().regex(/^0x(?:[0-9a-f]{2})*$/) });
type StoredState = z.infer<typeof StoredState>;

/** Each address's two answers, matched by id because a node may return batch items in any order. */
function statesFrom(batch: string[], items: unknown[]): Map<string, AccountState> {
  const results = new Map<number, unknown>();
  const seen = new Set<number>();
  const repeated = new Set<number>();
  for (const item of items) {
    const parsed = RpcItem.safeParse(item);
    if (!parsed.success) continue;
    const { id, result, error } = parsed.data;
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
    if ((error === undefined || error === null) && result !== undefined) results.set(id, result);
  }
  // An id answered twice is ambiguous, so neither answer is used.
  const answer = (id: number) => (repeated.has(id) ? undefined : results.get(id));

  const states = new Map<string, AccountState>();
  batch.forEach((address, index) => {
    const nonce = Quantity.safeParse(answer(index * 2));
    const code = HexBytes.safeParse(answer(index * 2 + 1));
    states.set(address, { nonce: nonce.success ? nonce.data : null, code: code.success ? code.data : null });
  });
  return states;
}

/**
 * Reads each wallet's nonce and code at a past block from a JSON-RPC node, in batches, through one shared rate limiter
 * and an on-disk cache.
 *
 * read() lowercases and de-duplicates the addresses, serves cached ones without a request, and sends the rest as batch
 * POSTs of eth_getTransactionCount and eth_getCode at the block, one rate-limit token per batch, one batch at a time.
 * A field that came back as an error or in a bad shape is null, and that address is not cached, so the next run asks
 * again. A batch that fails as a whole (network error, timeout, 429, 5xx, not a batch reply) is retried after 1, 2, 4,
 * 8 and 16 seconds, then its addresses are left null. Any other 4xx is not retried: its addresses come back null at
 * once. Network problems never throw, and nothing this module writes contains the RPC URL (C40).
 *
 * The cache files are named only by block, so cacheDir must belong to one chain.
 *
 * @throws RangeError at creation for a non-https rpcUrl or a batchSize outside 1 to 500.
 */
export function accountStates(opts: {
  rpcUrl: string;
  perSecond: number;
  cacheDir: string;
  batchSize?: number;
  timeoutMs?: number;
}): { read(addresses: string[], block: number): Promise<Map<string, AccountState>> } {
  let isHttps = false;
  try {
    isHttps = new URL(opts.rpcUrl).protocol === 'https:';
  } catch {
    isHttps = false;
  }
  if (!isHttps) throw new RangeError('RPC URL must be a valid https URL');
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new RangeError(`batchSize must be a whole number from 1 to ${MAX_BATCH_SIZE}`);
  }
  const timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS;
  const limiter = new RateLimiter(opts.perSecond);
  const caches = new Map<number, JsonlCache<StoredState>>();

  function cacheFor(block: number): JsonlCache<StoredState> {
    let cache = caches.get(block);
    if (cache === undefined) {
      cache = new JsonlCache(path.join(opts.cacheDir, `accounts-${block}.jsonl`), StoredState);
      caches.set(block, cache);
    }
    return cache;
  }

  /**
   * The batch reply's items, 'retry' when the batch failed as a whole in a way that may pass later, or 'refused' when
   * the node turned the request itself down.
   */
  async function postBatch(body: string, callCount: number): Promise<unknown[] | 'retry' | 'refused'> {
    try {
      const reply = await fetchJsonCapped(
        opts.rpcUrl,
        { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body },
        { timeoutMs, maxBytes: (callCount / 2) * MAX_REPLY_BYTES_PER_ADDRESS },
      );
      // A 4xx other than 429 (bad key, plan limit, request too large) gets the same answer however long we wait.
      if (reply.status >= 400 && reply.status < 500 && reply.status !== 429) return 'refused';
      if (!reply.ok) return 'retry';
      const items = z.array(z.unknown()).min(1).max(callCount).safeParse(reply.json);
      return items.success ? items.data : 'retry';
    } catch {
      return 'retry';
    }
  }

  async function readBatch(batch: string[], blockHex: string): Promise<Map<string, AccountState> | null> {
    const calls = batch.flatMap((address, index) => [
      { jsonrpc: '2.0', id: index * 2, method: 'eth_getTransactionCount', params: [address, blockHex] },
      { jsonrpc: '2.0', id: index * 2 + 1, method: 'eth_getCode', params: [address, blockHex] },
    ]);
    const body = JSON.stringify(calls);
    for (let attempt = 0; ; attempt += 1) {
      await limiter.take();
      const items = await postBatch(body, calls.length);
      if (items === 'refused') return null;
      if (items !== 'retry') return statesFrom(batch, items);
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) return null;
      await pause(delay);
    }
  }

  return {
    /**
     * @throws AddressError for an address that is not a 0x address of 40 hex characters, and RangeError for a block
     * that is not a whole number, both before any request.
     */
    async read(addresses: string[], block: number): Promise<Map<string, AccountState>> {
      if (!Number.isSafeInteger(block) || block < 0) throw new RangeError('block must be a whole number');
      const wanted = [...new Set(addresses.map((address) => parseAddress(address).toLowerCase()))];
      const cache = cacheFor(block);
      const fetched = new Map<string, AccountState>();
      const missing = wanted.filter((address) => !cache.has(address));
      const blockHex = `0x${block.toString(16)}`;

      for (let start = 0; start < missing.length; start += batchSize) {
        const batch = missing.slice(start, start + batchSize);
        const states = await readBatch(batch, blockHex);
        for (const address of batch) {
          const state = states?.get(address) ?? { nonce: null, code: null };
          fetched.set(address, state);
          if (state.nonce !== null && state.code !== null) cache.put(address, { nonce: state.nonce, code: state.code });
        }
      }

      const result = new Map<string, AccountState>();
      for (const address of wanted) {
        const cached = cache.get(address);
        result.set(address, fetched.get(address) ?? (cached === undefined ? { nonce: null, code: null } : { ...cached }));
      }
      return result;
    },
  };
}

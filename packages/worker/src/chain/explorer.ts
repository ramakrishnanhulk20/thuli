import path from 'node:path';
import { z } from 'zod';
import { parseAddress, TxHash } from '@thuli/core';
import { fetchJsonCapped, HttpError, type JsonReply } from '../http.ts';
import { JsonlCache } from './jsonlCache.ts';
import { pause, RateLimiter, RETRY_DELAYS_MS } from './rateLimiter.ts';

export const EXPLORER_TIMEOUT_MS = 20_000;
// 10,000 rows at roughly 400 bytes each is about 4 MB; twice that leaves room without letting a reply grow unbounded.
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
// Etherscan refuses any page whose page times offset is above 10,000.
const MAX_LIMIT = 10_000;
const NOT_INDEXED = 'internal transactions are not indexed for this block range';

export interface ExplorerTransfer {
  hash: string;
  block: number;
  time: number;
  from: string;
  to: string | null;
  valueWei: string;
  failed: boolean;
  kind: 'external' | 'internal';
}

export interface TransferPage {
  transfers: ExplorerTransfer[];
  /** Fewer rows came back than the limit, so this is every row up to endBlock. */
  complete: boolean;
}

export class ExplorerError extends Error {
  override name = 'ExplorerError';
}

export interface ExplorerSource {
  /** The wallet's oldest normal transactions up to endBlock, oldest first (Etherscan action txlist). */
  oldestTransfers(address: string, endBlock: number, limit: number): Promise<TransferPage>;
  /** The wallet's oldest internal value transfers up to endBlock, oldest first (Etherscan action txlistinternal). */
  oldestInternalTransfers(address: string, endBlock: number, limit: number): Promise<TransferPage>;
}

type Action = 'txlist' | 'txlistinternal';

// Explorer rows go through the one address parser (C1), then lowercase, which is the form this layer stores.
const RowAddress = z.string().transform((value, ctx) => {
  try {
    return parseAddress(value).toLowerCase();
  } catch {
    ctx.issues.push({ code: 'custom', message: 'not an address', input: value });
    return z.NEVER;
  }
});
const RowHash = z.string().transform((value) => value.toLowerCase()).pipe(TxHash);
const RowWhole = z.string().regex(/^[0-9]{1,16}$/).transform(Number).pipe(z.int().min(0));

const Row = z
  .object({
    hash: RowHash.optional(),
    transactionHash: RowHash.optional(),
    blockNumber: RowWhole,
    timeStamp: RowWhole,
    from: RowAddress,
    to: z.union([z.literal(''), RowAddress]),
    // A uint256 has at most 78 decimal digits.
    value: z.string().regex(/^[0-9]{1,78}$/),
    isError: z.enum(['0', '1']),
  })
  .refine((row) => (row.hash ?? row.transactionHash) !== undefined, 'row has no transaction hash')
  .refine(
    (row) => row.hash === undefined || row.transactionHash === undefined || row.hash === row.transactionHash,
    'row names two different transaction hashes',
  );

const Envelope = z.object({ status: z.string(), message: z.string().optional(), result: z.unknown() });

const LowerAddress = z.string().regex(/^0x[0-9a-f]{40}$/);
const StoredPage: z.ZodType<TransferPage> = z.object({
  transfers: z.array(
    z.object({
      hash: TxHash,
      block: z.int().min(0),
      time: z.int().min(0),
      from: LowerAddress,
      to: LowerAddress.nullable(),
      valueWei: z.string().regex(/^(0|[1-9][0-9]*)$/),
      failed: z.boolean(),
      kind: z.enum(['external', 'internal']),
    }),
  ),
  complete: z.boolean(),
});

type Attempt = { page: TransferPage } | { retry: string };

/**
 * Reads oldest-first transfer lists from an Etherscan-compatible explorer API (Etherscan v2, or a legacy-style
 * endpoint such as Blockscout's), through one shared rate limiter and an on-disk cache.
 *
 * The cache files are named only by action, end block and limit, so cacheDir must belong to one chain and one
 * explorer. A cache hit makes no request and takes no rate-limit token. Only successful pages are cached, so a wallet
 * that failed is asked again on the next run.
 *
 * Every request has a timeout (20 s by default) and an 8 MB reply cap, and redirects are refused (C38, C41). Error
 * messages are fixed words with the action and the wallet, never the URL, the key or the explorer's own text (C40).
 *
 * @throws ExplorerError at creation when baseUrl is not https or chainId is not a positive whole number.
 */
export function explorerSource(opts: {
  baseUrl: string;
  apiKey?: string;
  chainId: number;
  perSecond: number;
  cacheDir: string;
  timeoutMs?: number;
}): ExplorerSource {
  let base: URL;
  try {
    base = new URL(opts.baseUrl);
  } catch {
    throw new ExplorerError('explorer base URL is not a valid URL');
  }
  if (base.protocol !== 'https:') throw new ExplorerError('explorer base URL must be https');
  if (!Number.isSafeInteger(opts.chainId) || opts.chainId <= 0) {
    throw new ExplorerError('explorer chainId must be a positive whole number');
  }
  const isV2 = opts.baseUrl.includes('/v2/');
  const timeoutMs = opts.timeoutMs ?? EXPLORER_TIMEOUT_MS;
  const limiter = new RateLimiter(opts.perSecond);
  const caches = new Map<string, JsonlCache<TransferPage>>();

  function cacheFor(action: Action, endBlock: number, limit: number): JsonlCache<TransferPage> {
    const file = path.join(opts.cacheDir, `${action}-${endBlock}-${limit}.jsonl`);
    let cache = caches.get(file);
    if (cache === undefined) {
      cache = new JsonlCache(file, StoredPage);
      caches.set(file, cache);
    }
    return cache;
  }

  function requestUrl(action: Action, address: string, endBlock: number, limit: number): string {
    const url = new URL(base);
    const params: Record<string, string> = {
      module: 'account',
      action,
      address,
      startblock: '0',
      endblock: String(endBlock),
      page: '1',
      offset: String(limit),
      sort: 'asc',
    };
    if (isV2) params.chainid = String(opts.chainId);
    if (opts.apiKey !== undefined) params.apikey = opts.apiKey;
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return url.toString();
  }

  function readReply(reply: JsonReply, action: Action, endBlock: number, limit: number, fail: (cause: string) => ExplorerError): Attempt {
    if (!reply.ok) {
      const cause = `answered with status ${reply.status}`;
      if (reply.status === 429 || reply.status >= 500) return { retry: cause };
      throw fail(cause);
    }
    const envelope = Envelope.safeParse(reply.json);
    if (!envelope.success) throw fail('reply was not in the expected shape');
    const { status, result } = envelope.data;
    const message = envelope.data.message ?? '';
    const resultText = typeof result === 'string' ? result : '';

    if (status === '1') {
      if (!Array.isArray(result) || result.length > limit) throw fail('reply was not in the expected shape');
      const kind = action === 'txlist' ? 'external' : 'internal';
      const transfers: ExplorerTransfer[] = [];
      for (const item of result) {
        const row = Row.safeParse(item);
        if (!row.success) throw fail('a row did not match the expected shape');
        const previous = transfers.at(-1);
        // The caller relies on "oldest first, nothing past endBlock"; a reply that breaks either is not trusted.
        if (row.data.blockNumber > endBlock || (previous !== undefined && row.data.blockNumber < previous.block)) {
          throw fail('rows were past the end block or out of order');
        }
        transfers.push({
          hash: (row.data.hash ?? row.data.transactionHash) as string,
          block: row.data.blockNumber,
          time: row.data.timeStamp,
          from: row.data.from,
          to: row.data.to === '' ? null : row.data.to,
          valueWei: BigInt(row.data.value).toString(),
          failed: row.data.isError === '1',
          kind,
        });
      }
      return { page: { transfers, complete: transfers.length < limit } };
    }
    // Checked before the empty-result case: "not indexed yet" with an empty list must never read as "no transfers".
    if (status === '2' || /not yet been processed/i.test(message) || /not yet been processed/i.test(resultText)) {
      throw new ExplorerError(NOT_INDEXED);
    }
    if (status === '0' && (message === 'No transactions found' || (Array.isArray(result) && result.length === 0))) {
      return { page: { transfers: [], complete: true } };
    }
    if (status === '0' && /rate limit/i.test(resultText)) return { retry: 'still rate limited' };
    throw fail('answered with an error');
  }

  async function fetchPage(action: Action, address: string, endBlock: number, limit: number): Promise<TransferPage> {
    const fail = (cause: string) => new ExplorerError(`explorer ${action} for ${address}: ${cause}`);
    const url = requestUrl(action, address, endBlock, limit);
    for (let attempt = 0; ; attempt += 1) {
      await limiter.take();
      let reply: JsonReply;
      try {
        reply = await fetchJsonCapped(url, { headers: { accept: 'application/json' } }, { timeoutMs, maxBytes: MAX_REPLY_BYTES });
      } catch (error) {
        // Only our own HttpError text is passed on; a library error can carry the URL, and the URL carries the key.
        throw fail(`request failed (${error instanceof HttpError ? error.message : error instanceof Error ? error.name : 'unknown error'})`);
      }
      const outcome = readReply(reply, action, endBlock, limit, fail);
      if ('page' in outcome) return outcome.page;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw fail(`${outcome.retry} after ${RETRY_DELAYS_MS.length} retries`);
      await pause(delay);
    }
  }

  async function oldest(action: Action, address: string, endBlock: number, limit: number): Promise<TransferPage> {
    let wallet: string;
    try {
      wallet = parseAddress(address).toLowerCase();
    } catch {
      throw new ExplorerError(`explorer ${action}: wallet is not a 0x address of 40 hex characters`);
    }
    if (!Number.isSafeInteger(endBlock) || endBlock < 0) {
      throw new ExplorerError(`explorer ${action} for ${wallet}: endBlock must be a whole number`);
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new ExplorerError(`explorer ${action} for ${wallet}: limit must be a whole number from 1 to ${MAX_LIMIT}`);
    }
    const cache = cacheFor(action, endBlock, limit);
    const cached = cache.get(wallet);
    if (cached !== undefined) return cached;
    const page = await fetchPage(action, wallet, endBlock, limit);
    cache.put(wallet, page);
    return page;
  }

  return {
    oldestTransfers: (address, endBlock, limit) => oldest('txlist', address, endBlock, limit),
    oldestInternalTransfers: (address, endBlock, limit) => oldest('txlistinternal', address, endBlock, limit),
  };
}

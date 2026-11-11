import { createPublicClient, http, type Chain } from 'viem';
import { base, mainnet } from 'viem/chains';
import { z } from 'zod';
import {
  accountTypeFromCode,
  Facts,
  fundingTransfer,
  isScreenedChain,
  parseAddress,
  walletAgeDays,
  type AccountType,
  type Address,
  type AddressData,
  type FactName,
  type ScreenedChain,
  type Transfer,
  type TransferPage,
} from '@thuli/core';
import { loadEnv } from '../env.ts';
import { fetchJsonCapped } from '../http.ts';

export const REQUEST_TIMEOUT_MS = 15_000;
/** Pages read per list, external and internal each. Blockscout lists newest first, so the oldest is on the last page. */
export const MAX_FUNDING_PAGES = 20;
// A Blockscout page holds 50 transactions and weighs roughly 100 KB; anything near this cap is not a normal page.
const MAX_PAGE_BYTES = 4 * 1024 * 1024;

export interface FactSources {
  rpcUrl: string;
  blockscoutApi: string;
  /**
   * The Blockscout API key. When given, every Blockscout request sends it in the authorization header as a bearer token,
   * and only there: never in a URL, an error or a stored value (C40). The RPC never receives it.
   */
  apiKey?: string;
  /** Told which fact could not be read and why, in fixed words with no URLs or secrets. */
  onProblem?: (fact: FactName, cause: string) => void;
}

function sourcesFromEnv(): FactSources {
  const env = loadEnv();
  return { rpcUrl: env.ETH_RPC_URL, blockscoutApi: env.BLOCKSCOUT_ETH_API };
}

function baseSourcesFromEnv(): FactSources {
  const env = loadEnv();
  const key = env.BLOCKSCOUT_API_KEY;
  return { rpcUrl: env.BASE_RPC_URL, blockscoutApi: env.BLOCKSCOUT_BASE_API, ...(key === undefined ? {} : { apiKey: key }) };
}

const VIEM_CHAINS: Readonly<Record<ScreenedChain, Chain>> = { ethereum: mainnet, base };

/** A read-only client for one screened chain, with the fact reads' timeout and one retry. */
export function chainClient(chain: ScreenedChain, rpcUrl: string) {
  // ccipRead off: a chain read must never be redirected to an off-chain URL a contract names (threat model C38).
  return createPublicClient({
    chain: VIEM_CHAINS[chain],
    transport: http(rpcUrl, { timeout: REQUEST_TIMEOUT_MS, retryCount: 1 }),
    ccipRead: false,
  });
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const BlockscoutAddress = z.object({ hash: z.string() });

const BlockscoutTx = z.object({
  hash: z.string().regex(TX_HASH),
  block_number: z.int().min(0).nullable(),
  timestamp: z.string().nullable(),
  status: z.string().nullable(),
  value: z.string().regex(/^[0-9]+$/),
  from: BlockscoutAddress,
  to: BlockscoutAddress.nullable(),
});

const BlockscoutInternalTx = z.object({
  transaction_hash: z.string().regex(TX_HASH),
  block_number: z.int().min(0).nullable(),
  timestamp: z.string().nullable(),
  success: z.boolean().nullable(),
  value: z.string().regex(/^[0-9]+$/),
  from: BlockscoutAddress,
  to: BlockscoutAddress.nullable(),
});

const NextPage = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullable();

/** Errors whose message this file wrote itself, so the message is safe to pass on. */
class FactError extends Error {
  override name = 'FactError';
}

/** The two Blockscout address lists the facts are read from. */
export type BlockscoutList = 'transactions' | 'internal-transactions';

// Blockscout v12 drops a sorted list back to its default order unless sort and order come again on every page.
const OLDEST_FIRST: Readonly<Record<string, string>> = { sort: 'block_number', order: 'asc' };

const keyOf = (sources: Pick<FactSources, 'apiKey'>) => (sources.apiKey === undefined || sources.apiKey === '' ? undefined : sources.apiKey);

function blockscoutHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey === undefined ? { accept: 'application/json' } : { accept: 'application/json', authorization: `Bearer ${apiKey}` };
}

// Older Blockscout builds echo the API key in next_page_params, so a cursor value holding it is dropped and never rides
// into the next URL; the key goes in the header anyway. The cursor itself is never logged (C40).
function cursorFrom(next: Record<string, string | number | boolean | null>, apiKey: string | undefined): Record<string, string> {
  const cursor: Record<string, string> = {};
  for (const [name, value] of Object.entries(next)) {
    const text = String(value);
    if (apiKey !== undefined && (text.includes(apiKey) || name.includes(apiKey))) continue;
    cursor[name] = text;
  }
  return cursor;
}

function listUrl(apiBase: string, wallet: Address, list: BlockscoutList, query: Record<string, string>, apiKey: string | undefined): string {
  const search = new URLSearchParams(query).toString();
  const url = `${apiBase}/addresses/${wallet}/${list}${search === '' ? '' : `?${search}`}`;
  // The last guard for a key placed in the configured base URL itself: such a request is never sent (fail closed).
  if (apiKey !== undefined && (url.includes(apiKey) || url.includes(encodeURIComponent(apiKey)))) {
    throw new FactError('a Blockscout URL would have held the API key, so it was not sent');
  }
  return url;
}

/** How readTransferPages pages through one list. */
export interface PageOptions {
  /** Pages read at most. A list with more pages left past them comes back with complete false. */
  maxPages: number;
  /** Asks for the oldest items first, sort and order sent on every page; refused for the internal list, which cannot sort. */
  oldestFirst?: boolean;
  /** Reads no further page once this is true of the transfers read so far, which it gets in no particular order. */
  enough?: (transfers: readonly Transfer[]) => boolean;
  /** Reads no further page once aborted. A page already asked for still ends by its own 15 second timeout. */
  signal?: AbortSignal;
}

/**
 * One Blockscout address list, page by page, as oldest-first transfers at or before snapshotBlock: pending items and
 * anything after the snapshot block are left out, the rule the whole-history read uses. A list asked for oldest first
 * must come back with its blocks in rising order across every page, or the read fails, so a list in another order can
 * never pass for the oldest items. complete is true only when Blockscout said no page follows.
 *
 * @throws FactError on any failed or oversized reply, a page out of shape, a list out of order, an aborted signal, or a
 *   URL that would hold the key. Its message holds no URL, key or cursor (C40).
 */
export async function readTransferPages(
  wallet: Address,
  list: BlockscoutList,
  snapshotBlock: number,
  sources: Pick<FactSources, 'blockscoutApi' | 'apiKey'>,
  options: PageOptions,
): Promise<TransferPage> {
  if (options.oldestFirst === true && list !== 'transactions') throw new Error('only the transactions list can be read oldest first');
  const internal = list === 'internal-transactions';
  const Page = z.object({ items: z.array(internal ? BlockscoutInternalTx : BlockscoutTx).max(100), next_page_params: NextPage });
  const apiKey = keyOf(sources);
  const transfers: (Transfer | null)[] = [];
  let lastBlock = -1;
  let cursor: Record<string, string> = {};
  for (let page = 0; page < options.maxPages; page += 1) {
    if (options.signal?.aborted === true) throw new FactError('the read was stopped');
    const query = options.oldestFirst === true ? { ...cursor, ...OLDEST_FIRST } : cursor;
    const reply = await fetchJsonCapped(
      listUrl(sources.blockscoutApi, wallet, list, query, apiKey),
      { headers: blockscoutHeaders(apiKey) },
      { timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: MAX_PAGE_BYTES },
    );
    if (!reply.ok) throw new FactError(`Blockscout answered with status ${reply.status}`);
    const parsed = Page.safeParse(reply.json);
    if (!parsed.success) throw new FactError('Blockscout page did not match the expected shape');
    for (const item of parsed.data.items) {
      if (options.oldestFirst === true && item.block_number !== null) {
        if (item.block_number < lastBlock) throw new FactError('Blockscout did not list the transactions oldest first');
        lastBlock = item.block_number;
      }
      transfers.push(
        internal
          ? internalTransfer(item as z.infer<typeof BlockscoutInternalTx>, snapshotBlock)
          : externalTransfer(item as z.infer<typeof BlockscoutTx>, snapshotBlock),
      );
    }
    const next = parsed.data.next_page_params;
    if (next === null) return { transfers: oldestFirst(transfers, options.oldestFirst === true), complete: true };
    if (options.enough?.(transfers.filter((transfer): transfer is Transfer => transfer !== null)) === true) break;
    cursor = cursorFrom(next, apiKey);
  }
  return { transfers: oldestFirst(transfers, options.oldestFirst === true), complete: false };
}

/** Every transfer of one list up to MAX_FUNDING_PAGES pages. Throws past them, so a history is never read short. */
async function readAllPages(wallet: Address, list: BlockscoutList, snapshotBlock: number, sources: FactSources): Promise<TransferPage> {
  const read = await readTransferPages(wallet, list, snapshotBlock, sources, { maxPages: MAX_FUNDING_PAGES });
  if (!read.complete) throw new FactError(`the transaction list runs past ${MAX_FUNDING_PAGES} pages`);
  return read;
}

function seconds(timestamp: string | null): number {
  const ms = timestamp === null ? Number.NaN : Date.parse(timestamp);
  if (!Number.isFinite(ms)) throw new FactError('Blockscout gave a transaction time that is not a date');
  return Math.floor(ms / 1000);
}

const lowerAddress = (hash: string) => parseAddress(hash).toLowerCase();

/**
 * Turns Blockscout's items, newest first unless they were asked for oldest first, into the oldest-first transfers the
 * facts engine reads, the same shape the replay gets from its explorer. Pending items and anything after the snapshot
 * block are left out.
 */
function oldestFirst(items: (Transfer | null)[], ascending: boolean): Transfer[] {
  const kept = items.filter((transfer): transfer is Transfer => transfer !== null);
  return (ascending ? kept : kept.reverse()).sort((a, b) => a.block - b.block);
}

function externalTransfer(tx: z.infer<typeof BlockscoutTx>, snapshotBlock: number): Transfer | null {
  if (tx.block_number === null || tx.block_number > snapshotBlock) return null;
  return {
    hash: tx.hash.toLowerCase(),
    block: tx.block_number,
    time: seconds(tx.timestamp),
    from: lowerAddress(tx.from.hash),
    to: tx.to === null ? null : lowerAddress(tx.to.hash),
    valueWei: BigInt(tx.value).toString(),
    failed: tx.status !== 'ok',
    kind: 'external',
  };
}

function internalTransfer(tx: z.infer<typeof BlockscoutInternalTx>, snapshotBlock: number): Transfer | null {
  const block = tx.block_number;
  if (block === null || block > snapshotBlock) return null;
  return {
    hash: tx.transaction_hash.toLowerCase(),
    block,
    time: seconds(tx.timestamp),
    from: lowerAddress(tx.from.hash),
    to: tx.to === null ? null : lowerAddress(tx.to.hash),
    valueWei: BigInt(tx.value).toString(),
    failed: tx.success !== true,
    kind: 'internal',
  };
}

/**
 * The wallet's whole history at or before the snapshot block, in the replay's AddressData shape. Internal transfers are
 * read only when the external ones leave the funding unknown, the order the replay runner reads them in, so a wallet
 * screened on its own and the same wallet in a replay are judged on the same transfers (C20).
 */
async function readHistory(wallet: Address, snapshotBlock: number, sources: FactSources): Promise<AddressData> {
  const external = await readAllPages(wallet, 'transactions', snapshotBlock, sources);
  if (fundingTransfer(wallet, { external }).status !== 'unknown') return { external };
  const internal = await readAllPages(wallet, 'internal-transactions', snapshotBlock, sources);
  return { external, internal };
}

function errorKind(reason: unknown): string {
  // Library messages can contain the RPC URL, and some RPC URLs carry a key, so only our own messages pass (C40).
  if (reason instanceof FactError) return reason.message;
  return reason instanceof Error ? reason.name : 'unknown error';
}

/**
 * Computes the free facts for one wallet as of a past block of one screened chain, Ethereum or Base, from that chain's
 * RPC and Blockscout. First funding and wallet age come from core's fundingTransfer and walletAgeDays, the same
 * definitions the replay uses (C20). Left out, the sources are the chain's own from the environment.
 *
 * Group, shared deposit address and claim-paid-elsewhere are not computed in this version and are always listed in
 * missing. Any fact that cannot be read is set to null or "unknown" and named in missing, so the ceiling holds the
 * wallet instead of guessing (threat model C11). That includes a wallet with no funding found: Blockscout's internal
 * index can lag the chain, so an empty internal list is not proof that nothing funded it. Every request has a 15 second
 * timeout and each transaction list stops at 20 pages (C41).
 *
 * @throws only for a bad wallet, chain or block argument; data problems never throw.
 */
export async function collectBasicFacts(
  wallet: Address,
  at: { chain: ScreenedChain; block: number },
  sources: FactSources = at.chain === 'base' ? baseSourcesFromEnv() : sourcesFromEnv(),
): Promise<Facts> {
  const address = parseAddress(wallet);
  if (!isScreenedChain(at.chain)) throw new Error('basic facts are only available on ethereum and base');
  if (!Number.isSafeInteger(at.block) || at.block < 0) throw new Error('block must be a whole number');

  const client = chainClient(at.chain, sources.rpcUrl);
  const blockNumber = BigInt(at.block);
  const missing = new Set<FactName>(['group', 'sharedDepositAddress', 'claimPaidToOtherAddress']);
  const problem = (fact: FactName, cause: string) => {
    missing.add(fact);
    sources.onProblem?.(fact, cause);
  };

  const [snapshotBlock, txCount, code, history] = await Promise.allSettled([
    client.getBlock({ blockNumber }),
    client.getTransactionCount({ address, blockNumber }),
    client.getCode({ address, blockNumber }),
    readHistory(address, at.block, sources),
  ]);

  let txCountAtSnapshot: number | null = null;
  if (txCount.status === 'fulfilled') txCountAtSnapshot = txCount.value;
  else problem('txCountAtSnapshot', `transaction count read failed (${errorKind(txCount.reason)})`);

  let accountType: AccountType = 'unknown';
  if (code.status === 'fulfilled') accountType = accountTypeFromCode(code.value);
  if (accountType === 'unknown') {
    problem('accountType', code.status === 'rejected' ? `code read failed (${errorKind(code.reason)})` : 'code was not hex');
  }

  let firstFunder: Facts['firstFunder'] = null;
  let ageDays: number | null = null;
  const evidenceTxs: string[] = [];
  if (history.status === 'rejected') {
    const cause = `transaction history read failed (${errorKind(history.reason)})`;
    problem('firstFunder', cause);
    problem('walletAgeDays', cause);
  } else {
    const funding = fundingTransfer(address, history.value);
    if (funding.status === 'found') {
      firstFunder = { address: parseAddress(funding.transfer.from), kind: 'unknown', fanoutInList: null, hopsTraced: 1 };
      evidenceTxs.push(funding.transfer.hash);
    } else {
      problem('firstFunder', 'no incoming value transfer at or before the wallet first sent');
    }
    if (snapshotBlock.status === 'rejected') {
      problem('walletAgeDays', `snapshot block read failed (${errorKind(snapshotBlock.reason)})`);
    } else {
      ageDays = walletAgeDays(address, history.value, Number(snapshotBlock.value.timestamp));
      if (ageDays === null) problem('walletAgeDays', 'the wallet age could not be worked out from its transfers');
    }
  }

  return Facts.parse({
    walletAgeDays: ageDays,
    txCountAtSnapshot,
    accountType,
    firstFunder,
    group: null,
    sharedDepositAddress: null,
    // One wallet alone has no list to measure a burst against.
    fundingBurst: null,
    claimPaidToOtherAddress: null,
    evidenceTxs,
    missing: [...missing],
  });
}

/** The snapshot block's time as an ISO string, from the same RPC the facts use. */
export async function readSnapshotTime(block: number, sources: FactSources = sourcesFromEnv()): Promise<string> {
  const header = await chainClient('ethereum', sources.rpcUrl).getBlock({ blockNumber: BigInt(block) });
  return new Date(Number(header.timestamp) * 1000).toISOString();
}

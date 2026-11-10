import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { z } from 'zod';
import {
  accountTypeFromCode,
  Facts,
  fundingTransfer,
  parseAddress,
  walletAgeDays,
  type AccountType,
  type Address,
  type AddressData,
  type FactName,
  type Transfer,
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
  /** Told which fact could not be read and why, in fixed words with no URLs or secrets. */
  onProblem?: (fact: FactName, cause: string) => void;
}

function sourcesFromEnv(): FactSources {
  const env = loadEnv();
  return { rpcUrl: env.ETH_RPC_URL, blockscoutApi: env.BLOCKSCOUT_ETH_API };
}

function ethereumClient(rpcUrl: string) {
  // ccipRead off: a chain read must never be redirected to an off-chain URL a contract names (threat model C38).
  return createPublicClient({
    chain: mainnet,
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

/** Every item of one Blockscout address list. Throws on any error, a page out of shape, or past MAX_FUNDING_PAGES. */
async function readAllPages<T>(wallet: Address, list: string, item: z.ZodType<T>, apiBase: string): Promise<T[]> {
  const Page = z.object({ items: z.array(item).max(100), next_page_params: NextPage });
  const items: T[] = [];
  let query: Record<string, string> = {};
  for (let page = 0; page < MAX_FUNDING_PAGES; page += 1) {
    const search = new URLSearchParams(query).toString();
    const url = `${apiBase}/addresses/${wallet}/${list}${search === '' ? '' : `?${search}`}`;
    const reply = await fetchJsonCapped(
      url,
      { headers: { accept: 'application/json' } },
      { timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: MAX_PAGE_BYTES },
    );
    if (!reply.ok) throw new FactError(`Blockscout answered with status ${reply.status}`);
    const parsed = Page.safeParse(reply.json);
    if (!parsed.success) throw new FactError('Blockscout page did not match the expected shape');
    items.push(...parsed.data.items);
    const next = parsed.data.next_page_params;
    if (next === null) return items;
    query = Object.fromEntries(Object.entries(next).map(([key, value]) => [key, String(value)]));
  }
  throw new FactError(`the transaction list runs past ${MAX_FUNDING_PAGES} pages`);
}

function seconds(timestamp: string | null): number {
  const ms = timestamp === null ? Number.NaN : Date.parse(timestamp);
  if (!Number.isFinite(ms)) throw new FactError('Blockscout gave a transaction time that is not a date');
  return Math.floor(ms / 1000);
}

const lowerAddress = (hash: string) => parseAddress(hash).toLowerCase();

/**
 * Turns Blockscout's newest-first items into the oldest-first transfers the facts engine reads, the same shape the replay
 * gets from its explorer. Pending items and anything after the snapshot block are left out.
 */
function oldestFirst(items: (Transfer | null)[]): Transfer[] {
  return items
    .filter((transfer): transfer is Transfer => transfer !== null)
    .reverse()
    .sort((a, b) => a.block - b.block);
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
async function readHistory(wallet: Address, snapshotBlock: number, apiBase: string): Promise<AddressData> {
  const txs = await readAllPages(wallet, 'transactions', BlockscoutTx, apiBase);
  const external = { transfers: oldestFirst(txs.map((tx) => externalTransfer(tx, snapshotBlock))), complete: true };
  if (fundingTransfer(wallet, { external }).status !== 'unknown') return { external };
  const internalTxs = await readAllPages(wallet, 'internal-transactions', BlockscoutInternalTx, apiBase);
  const internal = { transfers: oldestFirst(internalTxs.map((tx) => internalTransfer(tx, snapshotBlock))), complete: true };
  return { external, internal };
}

function errorKind(reason: unknown): string {
  // Library messages can contain the RPC URL, and some RPC URLs carry a key, so only our own messages pass (C40).
  if (reason instanceof FactError) return reason.message;
  return reason instanceof Error ? reason.name : 'unknown error';
}

/**
 * Computes the free facts for one wallet as of a past block, from the RPC and Blockscout. First funding and wallet age
 * come from core's fundingTransfer and walletAgeDays, the same definitions the replay uses (C20).
 *
 * Group, shared deposit address and claim-paid-elsewhere are not computed in this version and are always listed in
 * missing. Any fact that cannot be read is set to null or "unknown" and named in missing, so the ceiling holds the
 * wallet instead of guessing (threat model C11). That includes a wallet with no funding found: Blockscout's internal
 * index can lag the chain, so an empty internal list is not proof that nothing funded it. Every request has a 15 second
 * timeout and each transaction list stops at 20 pages (C41).
 *
 * @throws only for a bad wallet or block argument; data problems never throw.
 */
export async function collectBasicFacts(
  wallet: Address,
  at: { chain: 'ethereum'; block: number },
  sources: FactSources = sourcesFromEnv(),
): Promise<Facts> {
  const address = parseAddress(wallet);
  if (at.chain !== 'ethereum') throw new Error('basic facts are only available on ethereum in this version');
  if (!Number.isSafeInteger(at.block) || at.block < 0) throw new Error('block must be a whole number');

  const client = ethereumClient(sources.rpcUrl);
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
    readHistory(address, at.block, sources.blockscoutApi),
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
  const header = await ethereumClient(sources.rpcUrl).getBlock({ blockNumber: BigInt(block) });
  return new Date(Number(header.timestamp) * 1000).toISOString();
}

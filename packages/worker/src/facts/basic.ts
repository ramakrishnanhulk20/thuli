import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { z } from 'zod';
import { accountTypeFromCode, Facts, parseAddress, type AccountType, type Address, type FactName } from '@thuli/core';
import { loadEnv } from '../env.ts';
import { fetchJsonCapped } from '../http.ts';

export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_FUNDING_PAGES = 20;
// A Blockscout page holds 50 transactions and weighs roughly 100 KB; anything near this cap is not a normal page.
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const SECONDS_PER_DAY = 86_400n;

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

const BlockscoutTx = z.object({
  hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  block_number: z.int().min(0).nullable(),
  status: z.string().nullable(),
  value: z.string().regex(/^[0-9]+$/),
  from: z.object({ hash: z.string() }),
  to: z.object({ hash: z.string() }).nullable(),
});

const BlockscoutPage = z.object({
  items: z.array(BlockscoutTx).max(100),
  next_page_params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullable(),
});

interface Funding {
  hash: string;
  from: Address;
  blockNumber: number;
}

/** Errors whose message this file wrote itself, so the message is safe to pass on. */
class FactError extends Error {
  override name = 'FactError';
}

/**
 * The earliest successful transaction that sent native value to the wallet at or before the snapshot block.
 * Blockscout lists newest first, so every page must be read to reach the oldest. Throws on any error, on a page that
 * does not match the expected shape, or when the pages run past the cap, because the earliest might lie beyond it.
 */
async function findFirstFunding(wallet: Address, block: number, apiBase: string): Promise<Funding | null> {
  let query: Record<string, string> = { filter: 'to' };
  let earliest: Funding | null = null;
  for (let page = 0; page < MAX_FUNDING_PAGES; page += 1) {
    const url = `${apiBase}/addresses/${wallet}/transactions?${new URLSearchParams(query)}`;
    const reply = await fetchJsonCapped(
      url,
      { headers: { accept: 'application/json' } },
      { timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: MAX_PAGE_BYTES },
    );
    if (!reply.ok) throw new FactError(`Blockscout answered with status ${reply.status}`);
    const parsed = BlockscoutPage.safeParse(reply.json);
    if (!parsed.success) throw new FactError('Blockscout page did not match the expected shape');

    for (const tx of parsed.data.items) {
      if (tx.block_number === null || tx.block_number > block) continue;
      if (tx.status !== 'ok' || tx.to === null || BigInt(tx.value) === 0n) continue;
      if (parseAddress(tx.to.hash) !== wallet) continue;
      const from = parseAddress(tx.from.hash);
      if (from === wallet) continue;
      // Ties within one block keep the later list item, which is the earlier transaction in newest-first order.
      if (earliest === null || tx.block_number <= earliest.blockNumber) {
        earliest = { hash: tx.hash.toLowerCase(), from, blockNumber: tx.block_number };
      }
    }

    const next = parsed.data.next_page_params;
    if (next === null) return earliest;
    query = { filter: 'to', ...Object.fromEntries(Object.entries(next).map(([key, value]) => [key, String(value)])) };
  }
  throw new FactError(`incoming transactions run past ${MAX_FUNDING_PAGES} pages`);
}

function errorKind(reason: unknown): string {
  // Library messages can contain the RPC URL, and some RPC URLs carry a key, so only our own messages pass (C40).
  if (reason instanceof FactError) return reason.message;
  return reason instanceof Error ? reason.name : 'unknown error';
}

/**
 * Computes the free facts for one wallet as of a past block, from the RPC and Blockscout.
 *
 * Group, shared deposit address and claim-paid-elsewhere are not computed in this version and are always listed in
 * missing. Any fact that cannot be read is set to null or "unknown" and named in missing, so the ceiling holds the
 * wallet instead of guessing (threat model C11). Every request has a 15 second timeout and the funding search stops
 * at 20 pages (C41).
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

  const [snapshotBlock, txCount, code, funding] = await Promise.allSettled([
    client.getBlock({ blockNumber }),
    client.getTransactionCount({ address, blockNumber }),
    client.getCode({ address, blockNumber }),
    findFirstFunding(address, at.block, sources.blockscoutApi),
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
  let walletAgeDays: number | null = null;
  const evidenceTxs: string[] = [];
  if (funding.status === 'rejected') {
    problem('firstFunder', `funding search failed (${errorKind(funding.reason)})`);
  } else if (funding.value === null) {
    problem('firstFunder', 'no incoming value transaction at or before the snapshot block');
  } else {
    firstFunder = { address: funding.value.from, kind: 'unknown', fanoutInList: null, hopsTraced: 1 };
    evidenceTxs.push(funding.value.hash);
    if (snapshotBlock.status === 'rejected') {
      problem('walletAgeDays', `snapshot block read failed (${errorKind(snapshotBlock.reason)})`);
    } else {
      try {
        const fundingBlock = await client.getBlock({ blockNumber: BigInt(funding.value.blockNumber) });
        const seconds = snapshotBlock.value.timestamp - fundingBlock.timestamp;
        if (seconds < 0n) throw new FactError('funding block is later than the snapshot block');
        walletAgeDays = Number(seconds / SECONDS_PER_DAY);
      } catch (reason) {
        firstFunder = null;
        evidenceTxs.length = 0;
        problem('firstFunder', `funding block time could not be read (${errorKind(reason)})`);
      }
    }
  }

  return Facts.parse({
    walletAgeDays,
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

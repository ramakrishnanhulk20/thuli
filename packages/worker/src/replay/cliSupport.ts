import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { parseAddress, type ReplayRow, type TransferPage } from '@thuli/core';
import { ExplorerError, explorerSource, type ExplorerSource } from '../chain/explorer.ts';
import { JsonlCache } from '../chain/jsonlCache.ts';
import { accountStates } from '../chain/rpcBatch.ts';
import { EnvError, loadEnv, type Env } from '../env.ts';
import { readSnapshotTime } from '../facts/basic.ts';
import { AnswerKeyError } from './answerKeys.ts';
import type { ReplayDeps } from './runner.ts';

const ETHEREUM = 1;
// Etherscan's free plan allows 3 calls a second; a little under it leaves room for timing jitter.
const DEFAULT_PER_SECOND = 2.8;
const MAX_PER_SECOND = 100;
// The Tenderly public gateway counts every call inside a batch against its rate limit. Measured 4 Nov: 10 addresses
// (20 calls) once a second always passed, 20 addresses a second and 10 every half second were refused with 429.
const RPC_BATCHES_PER_SECOND = 1;
const RPC_BATCH_SIZE = 10;
// Offline nothing is ever sent, so there is nothing to pace.
const OFFLINE_PER_SECOND = 1_000_000;
// Reserved never to resolve (RFC 2606). Offline readers need some https URL, and this one cannot reach anyone.
const OFFLINE_URL = 'https://offline.invalid';

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const KEYS_DIR = path.join(REPO_ROOT, 'reference', 'answer-keys');
const DEFAULT_CACHE_DIR = path.join(REPO_ROOT, 'data', 'cache', 'eth');
const NO_KEY = 'Set EXPLORER_API_KEY in .env (free Etherscan key; see STATE.md)';

export class UsageError extends Error {
  override name = 'UsageError';
}

export interface ReplayArguments {
  /** A file of listed wallets, one per line, to screen instead of the whole list (a sample with farm wallets in it). */
  walletsFile: string | undefined;
  limit: number | undefined;
  perSecond: number;
  cacheDir: string;
  offline: boolean;
}

/**
 * Reads the flags every replay shares: --wallets, --limit, --per-second, --cache-dir and --offline.
 *
 * @throws UsageError carrying `usage` for an unknown flag or a stray word, and a fixed message for a bad value.
 */
export function readReplayArguments(usage: string): ReplayArguments {
  let values: { wallets?: string; limit?: string; 'per-second'?: string; 'cache-dir'?: string; offline?: boolean };
  try {
    values = parseArgs({
      options: {
        wallets: { type: 'string' },
        limit: { type: 'string' },
        'per-second': { type: 'string' },
        'cache-dir': { type: 'string' },
        offline: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw new UsageError(usage);
  }
  const limitText = values.limit;
  if (limitText !== undefined && !/^[1-9][0-9]{0,6}$/.test(limitText)) throw new UsageError('--limit must be a whole number above 0');
  const rateText = values['per-second'] ?? String(DEFAULT_PER_SECOND);
  const perSecond = Number(rateText);
  if (!/^[0-9]{1,3}(\.[0-9]{1,3})?$/.test(rateText) || perSecond <= 0 || perSecond > MAX_PER_SECOND) {
    throw new UsageError(`--per-second must be a number above 0 and at most ${MAX_PER_SECOND}`);
  }
  return {
    walletsFile: values.wallets === undefined ? undefined : path.resolve(values.wallets),
    limit: limitText === undefined ? undefined : Number(limitText),
    perSecond,
    cacheDir: values['cache-dir'] === undefined ? DEFAULT_CACHE_DIR : path.resolve(values['cache-dir']),
    offline: values.offline ?? false,
  };
}

/**
 * The checked environment for a live run, or undefined offline, where no variable is needed.
 *
 * @throws UsageError when the explorer key is blank, and EnvError when a variable is missing or malformed.
 */
export function envForRun(args: ReplayArguments): Env | undefined {
  if (args.offline) return undefined;
  if ((process.env.EXPLORER_API_KEY ?? '').trim() === '') throw new UsageError(NO_KEY);
  return loadEnv();
}

/**
 * The wallets this run screens, from the listed ones, and the pool they were cut from: the whole list, or the --wallets
 * file when one was named. --limit then keeps the first ones of the pool.
 *
 * @throws UsageError when the --wallets file names a wallet that is not listed; `label` says what the list is.
 * @throws AddressError for a line in that file that is not a 0x address.
 */
export function chooseWallets(args: ReplayArguments, listed: readonly string[], label: string): { pool: string[]; wallets: string[] } {
  let pool = [...listed];
  if (args.walletsFile !== undefined) {
    const known = new Set(listed);
    const lines = fs.readFileSync(args.walletsFile, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
    const chosen = [...new Set(lines.map((line) => parseAddress(line.trim()).toLowerCase()))];
    const strangers = chosen.filter((wallet) => !known.has(wallet)).length;
    if (strangers > 0) throw new UsageError(`--wallets: ${strangers} of ${chosen.length} lines are not ${label}`);
    pool = chosen;
  }
  return { pool, wallets: args.limit === undefined ? pool : pool.slice(0, args.limit) };
}

/**
 * Offline means no network at all, so every request any library tries is refused inside this process. A 4xx other
 * than 429 is the answer both chain readers give up on at once instead of retrying, so a cache miss costs nothing: the
 * explorer throws and the account reader returns null states. Cache hits are served by the same code as online.
 */
export function refuseNetwork(): void {
  globalThis.fetch = async () => new Response(null, { status: 400 });
}

export function offlineOnly(explorer: ExplorerSource): ExplorerSource {
  const fromCache = async (read: () => Promise<TransferPage>): Promise<TransferPage> => {
    try {
      return await read();
    } catch (error) {
      if (error instanceof ExplorerError) throw new ExplorerError('offline: not in cache');
      throw error;
    }
  };
  return {
    oldestTransfers: (address, endBlock, limit) => fromCache(() => explorer.oldestTransfers(address, endBlock, limit)),
    oldestInternalTransfers: (address, endBlock, limit) => fromCache(() => explorer.oldestInternalTransfers(address, endBlock, limit)),
  };
}

export interface ChainReaders {
  explorer: ExplorerSource;
  accounts: ReplayDeps['accounts'];
}

/**
 * The explorer and account readers for a run. With no env the run is offline: the network is refused for the whole
 * process and both readers can only serve what is already cached.
 */
export function chainReaders(args: ReplayArguments, env: Env | undefined): ChainReaders {
  if (env === undefined) refuseNetwork();
  const explorer =
    env === undefined
      ? offlineOnly(explorerSource({ baseUrl: OFFLINE_URL, chainId: ETHEREUM, perSecond: OFFLINE_PER_SECOND, cacheDir: args.cacheDir }))
      : explorerSource({
          baseUrl: env.EXPLORER_API_URL,
          apiKey: env.EXPLORER_API_KEY,
          chainId: ETHEREUM,
          perSecond: args.perSecond,
          cacheDir: args.cacheDir,
        });
  const accounts = accountStates({
    rpcUrl: env === undefined ? OFFLINE_URL : env.ETH_RPC_URL,
    perSecond: env === undefined ? OFFLINE_PER_SECOND : RPC_BATCHES_PER_SECOND,
    batchSize: RPC_BATCH_SIZE,
    cacheDir: args.cacheDir,
  });
  return { explorer, accounts };
}

/**
 * The block's time in seconds, read from the node once and then from the cache.
 *
 * @throws UsageError offline when the time is not cached yet.
 */
export async function snapshotSeconds(block: number, cacheDir: string, env: Env | undefined): Promise<number> {
  // Kept beside the chain caches so an offline rerun knows the snapshot time without asking the node.
  const blockTimes = new JsonlCache(path.join(cacheDir, 'block-times.jsonl'), z.int().min(0));
  const cached = blockTimes.get(String(block));
  if (cached !== undefined) return cached;
  if (env === undefined) {
    throw new UsageError('Offline, but the snapshot block time is not cached yet. Run once without --offline first.');
  }
  const iso = await readSnapshotTime(block, { rpcUrl: env.ETH_RPC_URL, blockscoutApi: env.BLOCKSCOUT_ETH_API });
  const seconds = Date.parse(iso) / 1000;
  blockTimes.put(String(block), seconds);
  return seconds;
}

/** The heading fields both replay reports print. */
export function reportMeta(snapshotBlock: number, snapshotTime: number): { snapshotBlock: number; snapshotTime: string; runDate: string } {
  return {
    snapshotBlock,
    snapshotTime: new Date(snapshotTime * 1000).toISOString(),
    runDate: new Date().toISOString().slice(0, 10),
  };
}

export function writeAtomically(file: string, text: string): void {
  // A run stopped mid-write must not leave a half file that looks finished.
  fs.writeFileSync(`${file}.partial`, text);
  fs.renameSync(`${file}.partial`, file);
}

/** Writes rows.jsonl and report.md into outDir. */
export function saveReplay(outDir: string, rows: ReplayRow[], report: string): void {
  fs.mkdirSync(outDir, { recursive: true });
  writeAtomically(path.join(outDir, 'rows.jsonl'), rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  writeAtomically(path.join(outDir, 'report.md'), report);
}

/** Turns a replay's result into the process exit code, printing only words of our own when it stopped early. */
export function finishReplay(script: string, run: Promise<number>): void {
  run.then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      if (error instanceof UsageError || error instanceof EnvError || error instanceof ExplorerError) {
        console.error(error.message);
        process.exitCode = 2;
        return;
      }
      if (error instanceof AnswerKeyError) {
        console.error(error.message);
        process.exitCode = 1;
        return;
      }
      // Library errors can quote the RPC URL, so only the error's class name is printed (threat model C40).
      console.error(`${script} stopped: ${error instanceof Error ? error.name : 'unknown error'}`);
      process.exitCode = 1;
    },
  );
}

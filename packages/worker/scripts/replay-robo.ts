import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { DEFAULT_SETTINGS, parseAddress, REPLAY_WALLET_LIMIT, scoreReplay, scoreToMarkdown, type TransferPage } from '@thuli/core';
import { ExplorerError, explorerSource, type ExplorerSource } from '../src/chain/explorer.ts';
import { JsonlCache } from '../src/chain/jsonlCache.ts';
import { accountStates } from '../src/chain/rpcBatch.ts';
import { EnvError, loadEnv } from '../src/env.ts';
import { readSnapshotTime } from '../src/facts/basic.ts';
import { AnswerKeyError, loadClaimEvents, loadFarmKey } from '../src/replay/answerKeys.ts';
import { runReplay } from '../src/replay/runner.ts';

// The block before the first ROBO claim at 24546233, so nothing after the claim opened is read.
const SNAPSHOT_BLOCK = 24546232;
const HOP_LIMIT = 5;
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

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const KEYS_DIR = path.join(REPO_ROOT, 'reference', 'answer-keys');
const OUT_DIR = path.join(REPO_ROOT, 'data', 'replay', 'robo');
const DEFAULT_CACHE_DIR = path.join(REPO_ROOT, 'data', 'cache', 'eth');
const NO_KEY = 'Set EXPLORER_API_KEY in .env (free Etherscan key; see STATE.md)';
const USAGE = 'Usage: npm run replay:robo -- [--wallets FILE] [--limit N] [--per-second N] [--cache-dir PATH] [--offline]';

class UsageError extends Error {
  override name = 'UsageError';
}

interface Arguments {
  /** A file of claim wallets, one per line, to screen instead of the whole list (a sample with farm wallets in it). */
  walletsFile: string | undefined;
  limit: number | undefined;
  perSecond: number;
  cacheDir: string;
  offline: boolean;
}

function readArguments(): Arguments {
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
    throw new UsageError(USAGE);
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
 * Offline means no network at all, so every request any library tries is refused inside this process. A 4xx other
 * than 429 is the answer both chain readers give up on at once instead of retrying, so a cache miss costs nothing: the
 * explorer throws and the account reader returns null states. Cache hits are served by the same code as online.
 */
function refuseNetwork(): void {
  globalThis.fetch = async () => new Response(null, { status: 400 });
}

function offlineOnly(explorer: ExplorerSource): ExplorerSource {
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

function writeAtomically(file: string, text: string): void {
  // A run stopped mid-write must not leave a half file that looks finished.
  fs.writeFileSync(`${file}.partial`, text);
  fs.renameSync(`${file}.partial`, file);
}

async function main(): Promise<number> {
  const args = readArguments();
  if (!args.offline && (process.env.EXPLORER_API_KEY ?? '').trim() === '') throw new UsageError(NO_KEY);
  const env = args.offline ? undefined : loadEnv();

  const events = loadClaimEvents(path.join(KEYS_DIR, 'robo-claim-events.csv'));
  const key = loadFarmKey(path.join(KEYS_DIR, 'robo-farm-claim-wallets-reconstructed.csv'));
  const claimedWei = new Map<string, bigint>();
  for (const event of events) claimedWei.set(event.recipient, (claimedWei.get(event.recipient) ?? 0n) + event.amountWei);
  let recipients = [...claimedWei.keys()];
  if (args.walletsFile !== undefined) {
    const lines = fs.readFileSync(args.walletsFile, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
    const chosen = [...new Set(lines.map((line) => parseAddress(line.trim()).toLowerCase()))];
    const strangers = chosen.filter((wallet) => !claimedWei.has(wallet)).length;
    if (strangers > 0) throw new UsageError(`--wallets: ${strangers} of ${chosen.length} lines are not ROBO claim wallets`);
    recipients = chosen;
  }
  const wallets = args.limit === undefined ? recipients : recipients.slice(0, args.limit);

  if (args.offline) refuseNetwork();
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

  // Kept beside the chain caches so an offline rerun knows the snapshot time without asking the node.
  const blockTimes = new JsonlCache(path.join(args.cacheDir, 'block-times.jsonl'), z.int().min(0));
  let snapshotTime = blockTimes.get(String(SNAPSHOT_BLOCK));
  if (snapshotTime === undefined) {
    if (env === undefined) {
      throw new UsageError('Offline, but the snapshot block time is not cached yet. Run once without --offline first.');
    }
    const iso = await readSnapshotTime(SNAPSHOT_BLOCK, { rpcUrl: env.ETH_RPC_URL, blockscoutApi: env.BLOCKSCOUT_ETH_API });
    snapshotTime = Date.parse(iso) / 1000;
    blockTimes.put(String(SNAPSHOT_BLOCK), snapshotTime);
  }

  console.error(`replaying ${wallets.length} of ${recipients.length} ROBO claim wallets at block ${SNAPSHOT_BLOCK}${args.offline ? ', offline' : ''}`);
  const rows = await runReplay(
    wallets,
    { snapshotBlock: SNAPSHOT_BLOCK, snapshotTime, settings: DEFAULT_SETTINGS, walletLimit: REPLAY_WALLET_LIMIT, hopLimit: HOP_LIMIT },
    { explorer, accounts, log: (line) => console.error(line) },
  );

  const report = scoreToMarkdown(scoreReplay(rows, key, claimedWei, DEFAULT_SETTINGS), {
    snapshotBlock: SNAPSHOT_BLOCK,
    snapshotTime: new Date(snapshotTime * 1000).toISOString(),
    runDate: new Date().toISOString().slice(0, 10),
  });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  writeAtomically(path.join(OUT_DIR, 'rows.jsonl'), rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  writeAtomically(path.join(OUT_DIR, 'report.md'), report);
  console.log(report);
  return 0;
}

main().then(
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
    console.error(`replay-robo stopped: ${error instanceof Error ? error.name : 'unknown error'}`);
    process.exitCode = 1;
  },
);

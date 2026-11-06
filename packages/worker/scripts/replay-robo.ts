import path from 'node:path';
import { DEFAULT_SETTINGS, REPLAY_WALLET_LIMIT, scoreReplay, scoreToMarkdown } from '@thuli/core';
import { loadClaimEvents, loadFarmKey } from '../src/replay/answerKeys.ts';
import {
  chainReaders,
  chooseWallets,
  envForRun,
  finishReplay,
  KEYS_DIR,
  readReplayArguments,
  REPO_ROOT,
  reportMeta,
  saveReplay,
  snapshotSeconds,
} from '../src/replay/cliSupport.ts';
import { runReplay } from '../src/replay/runner.ts';

// The block before the first ROBO claim at 24546233, so nothing after the claim opened is read.
const SNAPSHOT_BLOCK = 24546232;
const HOP_LIMIT = 5;

const OUT_DIR = path.join(REPO_ROOT, 'data', 'replay', 'robo');
const USAGE = 'Usage: npm run replay:robo -- [--wallets FILE] [--limit N] [--per-second N] [--cache-dir PATH] [--offline]';

async function main(): Promise<number> {
  const args = readReplayArguments(USAGE);
  const env = envForRun(args);

  const events = loadClaimEvents(path.join(KEYS_DIR, 'robo-claim-events.csv'));
  const key = loadFarmKey(path.join(KEYS_DIR, 'robo-farm-claim-wallets-reconstructed.csv'));
  const claimedWei = new Map<string, bigint>();
  for (const event of events) claimedWei.set(event.recipient, (claimedWei.get(event.recipient) ?? 0n) + event.amountWei);
  const { pool, wallets } = chooseWallets(args, [...claimedWei.keys()], 'ROBO claim wallets');

  const { explorer, accounts } = chainReaders(args, env);
  const snapshotTime = await snapshotSeconds(SNAPSHOT_BLOCK, args.cacheDir, env);

  console.error(`replaying ${wallets.length} of ${pool.length} ROBO claim wallets at block ${SNAPSHOT_BLOCK}${args.offline ? ', offline' : ''}`);
  const rows = await runReplay(
    wallets,
    { snapshotBlock: SNAPSHOT_BLOCK, snapshotTime, settings: DEFAULT_SETTINGS, walletLimit: REPLAY_WALLET_LIMIT, hopLimit: HOP_LIMIT },
    { explorer, accounts, log: (line) => console.error(line) },
  );

  const report = scoreToMarkdown(scoreReplay(rows, key, claimedWei, DEFAULT_SETTINGS), reportMeta(SNAPSHOT_BLOCK, snapshotTime));
  saveReplay(OUT_DIR, rows, report);
  console.log(report);
  return 0;
}

finishReplay('replay-robo', main());

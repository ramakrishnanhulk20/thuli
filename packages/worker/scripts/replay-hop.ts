import path from 'node:path';
import { DEFAULT_SETTINGS, REPLAY_WALLET_LIMIT } from '@thuli/core';
import { loadHopLists } from '../src/replay/answerKeys.ts';
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
import { hopToMarkdown, scoreHop } from '../src/replay/hopScore.ts';
import { runReplay } from '../src/replay/runner.ts';

// The last block before 00:00 UTC on 1 April 2022, Hop's snapshot.
const SNAPSHOT_BLOCK = 14_497_033;
const HOP_LIMIT = 5;

const OUT_DIR = path.join(REPO_ROOT, 'data', 'replay', 'hop');
const USAGE = 'Usage: npm run replay:hop -- [--wallets FILE] [--limit N] [--per-second N] [--cache-dir PATH] [--offline]';

async function main(): Promise<number> {
  const args = readReplayArguments(USAGE);
  const env = envForRun(args);

  const lists = loadHopLists(KEYS_DIR);
  const { pool, wallets } = chooseWallets(args, [...lists.eligible, ...lists.eliminated], 'Hop wallets');

  const { explorer, accounts } = chainReaders(args, env);
  const snapshotTime = await snapshotSeconds(SNAPSHOT_BLOCK, args.cacheDir, env);

  console.error(`replaying ${wallets.length} of ${pool.length} Hop wallets at block ${SNAPSHOT_BLOCK}${args.offline ? ', offline' : ''}`);
  const rows = await runReplay(
    wallets,
    { snapshotBlock: SNAPSHOT_BLOCK, snapshotTime, settings: DEFAULT_SETTINGS, walletLimit: REPLAY_WALLET_LIMIT, hopLimit: HOP_LIMIT },
    { explorer, accounts, log: (line) => console.error(line) },
  );

  const report = hopToMarkdown(scoreHop(rows, lists, DEFAULT_SETTINGS), reportMeta(SNAPSHOT_BLOCK, snapshotTime));
  saveReplay(OUT_DIR, rows, report);
  console.log(report);
  return 0;
}

finishReplay('replay-hop', main());

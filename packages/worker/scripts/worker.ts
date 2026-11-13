// The campaign worker: screens each queued ask, posts the list of slot holders to the campaign's vault, and after the
// vault's delay submits every listed wallet's claim from the worker's key, so the money arrives without the wallet
// paying gas.
//
//   npm run worker             one run every 5 seconds until Ctrl+C or SIGTERM, which finish the step under way
//   npm run worker -- --once   one run of each step, then exit
//
// Reads DATABASE_URL, WORKER_PRIVATE_KEY, SERV_API_KEY, SERV_BASE_URL, SERV_GRAPH_ID, ETH_RPC_URL, BLOCKSCOUT_ETH_API
// and BASE_SEPOLIA_RPC_URL from .env, and the factory from packages/contracts/deployments/base-sepolia.json. It serves
// every open campaign in the store, so starting a campaign needs no change here. The database must be migrated first
// (npm run db:migrate). REPPO_API_KEY and REPPO_BASE_URL are optional: with them, each appeal gets Reppo's outside
// check; without them, appeals wait in the queue. When ETH_RPC_URL and BASE_RPC_URL (default: Base's public endpoint)
// both serve old state and traces, which a probe checks at start, each ask is screened on Ethereum or Base history,
// whichever is older, read over those RPCs; otherwise on Ethereum only, as one line at start says. BLOCKSCOUT_API_KEY is
// optional, sent only when BLOCKSCOUT_ETH_API is Blockscout's keyed host.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connectPostgres, openCampaigns } from '@thuli/store';
import { reppoForAppeals } from '../src/campaign/appeals.ts';
import { ethereumFacts, screenChains, usedOnBase } from '../src/campaign/chain.ts';
import { loadWorkerConfig, readFactoryRecord, scrubber, secretsOf, WorkerConfigError } from '../src/campaign/config.ts';
import { runLoop } from '../src/campaign/loop.ts';
import { campaignVault, emptyChainMemory, safeCause } from '../src/campaign/vault.ts';
import { accountStateAtFinalizedBlock } from '../src/screen/single.ts';
import { decideViaGraph, decideViaV2 } from '../src/serv/client.ts';
import { connectBaseSepolia } from '../src/vault/chain.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RULEBOOK_FILE = path.join(REPO_ROOT, 'packages', 'rulebook', 'thuli-rulebook.md');
const DEPLOYMENT_FILE = path.join(REPO_ROOT, 'packages', 'contracts', 'deployments', 'base-sepolia.json');

let clean = (line: string) => line;
const log = (line: string) => console.log(`${new Date().toISOString()} ${clean(line)}`);

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { once: { type: 'boolean', default: false } } });
  const config = loadWorkerConfig(process.env);
  clean = scrubber(secretsOf(config));
  const chains = await screenChains(config, log);
  const rulebook = fs.readFileSync(RULEBOOK_FILE, 'utf8');
  if (rulebook.trim() === '') throw new WorkerConfigError('The rulebook is empty, so no screening could follow it.');
  const factory = readFactoryRecord(DEPLOYMENT_FILE).address;
  const { publicClient, wallet } = await connectBaseSepolia(config.chainRpcUrl);
  const agent = wallet(config.workerKey);
  const db = connectPostgres(config.databaseUrl);
  const serv = { baseUrl: config.servBaseUrl, apiKey: config.servApiKey };

  const stop = new AbortController();
  const onSignal = (name: string) => {
    if (stop.signal.aborted) {
      log(`${name} again: stopping now`);
      process.exit(130);
    }
    log(`${name}: finishing the step under way, then stopping`);
    stop.abort();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  try {
    const open = await openCampaigns(db, new Date());
    log(`worker as agent ${agent.account.address}: ${open.length} open campaign${open.length === 1 ? '' : 's'} found${values.once ? ', one run' : ''}`);
    const runs = await runLoop(
      {
        db,
        facts: ethereumFacts({
          rpcUrl: config.ethRpcUrl,
          blockscoutApi: config.blockscoutApi,
          ...(config.blockscoutApiKey === null ? {} : { apiKey: config.blockscoutApiKey }),
        }),
        accountState: accountStateAtFinalizedBlock({ rpcUrl: config.ethRpcUrl }, 'ethereum'),
        usedOnBase: usedOnBase({ rpcUrl: config.baseRpcUrl }),
        ...(chains === undefined ? {} : { chains }),
        serv: {
          viaGraph: (record) => decideViaGraph(record, { ...serv, graphId: config.servGraphId }),
          viaV2: (record) => decideViaV2(record, rulebook, serv),
          sleep: (ms) => wait(ms),
        },
        chain: campaignVault(publicClient, agent),
        factory,
        now: () => new Date(),
        log,
        memory: emptyChainMemory(),
        ...(config.reppo === null ? {} : { appeals: { reppo: reppoForAppeals(config.reppo), spend: { credits: 0 } } }),
      },
      { once: values.once, signal: stop.signal },
    );
    log(`stopped after ${runs} run${runs === 1 ? '' : 's'}`);
  } finally {
    await db.close();
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof WorkerConfigError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    console.error(`worker stopped: ${clean(safeCause(error))}`);
    process.exitCode = 1;
  },
);

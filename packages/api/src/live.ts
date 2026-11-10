import fs from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { DEFAULT_SETTINGS, graphVersion, type Address } from '@thuli/core';
import { loadEnv } from '@thuli/worker/src/env.ts';
import { factsAtFinalizedBlock, screenOneWallet, type SingleScreen } from '@thuli/worker/src/screen/single.ts';
import { decideViaGraph, decideViaV2 } from '@thuli/worker/src/serv/client.ts';
import { ConfigError } from './config.ts';

const RULEBOOK_FILE = new URL('../../rulebook/thuli-rulebook.md', import.meta.url);

/**
 * The real screening: free facts from the Ethereum RPC and Blockscout, then SERV in auto mode with the default
 * settings, the same graph and rulebook the replay used. Reads only the worker's own variables from env.
 *
 * @throws EnvError naming a missing SERV or chain variable, and ConfigError when SERV_GRAPH_ID names no graph Thuli can
 * translate, both before anything listens. Neither message holds a value (C40).
 */
export function liveScreen(env: Record<string, string | undefined>): (wallet: Address) => Promise<SingleScreen> {
  const workerEnv = loadEnv(env);
  const graphId = workerEnv.SERV_GRAPH_ID;
  if (graphId === undefined || graphVersion(graphId) === undefined) {
    throw new ConfigError('SERV_GRAPH_ID must name a graph Thuli has a translation for (auto mode asks the graph first).');
  }
  const rulebook = fs.readFileSync(RULEBOOK_FILE, 'utf8');
  const connection = { baseUrl: workerEnv.SERV_BASE_URL, apiKey: workerEnv.SERV_API_KEY };
  const facts = factsAtFinalizedBlock({ rpcUrl: workerEnv.ETH_RPC_URL, blockscoutApi: workerEnv.BLOCKSCOUT_ETH_API });
  const decide = {
    viaGraph: (record: Parameters<typeof decideViaGraph>[0]) => decideViaGraph(record, { ...connection, graphId }),
    viaV2: (record: Parameters<typeof decideViaV2>[0]) => decideViaV2(record, rulebook, connection),
    sleep: (ms: number) => wait(ms),
  };
  return (wallet) => screenOneWallet(wallet, { facts, decide, settings: DEFAULT_SETTINGS });
}

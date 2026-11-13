// Screens wallets the way a campaign ask is screened, in a throwaway campaign held in this process's memory: the pick of
// the chain, the facts, the code's start and ceiling, SERV and the output checks. Prints the chain each wallet's history
// was read on, its decision and the facts it rested on. Wallets named together are one campaign, so a shared funder
// links them as it would on a real board.
//
//   npm run campaign:screen -- --wallets <address>[,<address>...]
//
// Nobody signs anything here: the asks are queued for the named addresses directly, which only this script may do,
// because its database dies with the process. It sends no transaction and writes no file. Each wallet costs one model
// screening, so at most MAX_WALLETS are taken. Reads SERV_API_KEY, SERV_BASE_URL, SERV_GRAPH_ID, ETH_RPC_URL,
// BASE_RPC_URL, BLOCKSCOUT_ETH_API and, when set, BLOCKSCOUT_API_KEY from .env, and prints none of them.
// Not covered: the door (the signature, the wallet-type and never-used reads the API makes), slots that fill up, and
// everything after the decision (the list, the vault, the claim): npm run rehearse:campaign covers those.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CHAINS, CURRENT_RULEBOOK, DEFAULT_SETTINGS, graphVersion, parseAddress, SCREENED_CHAIN_NAME, type Address } from '@thuli/core';
import { addAsk, createCampaign, getAsk, migrate, openMemoryDb } from '@thuli/store';
import { ethereumFacts, screenChains, usedOnBase } from '../src/campaign/chain.ts';
import { scrubber } from '../src/campaign/config.ts';
import { screenNextAsk } from '../src/campaign/screen.ts';
import { emptyChainMemory } from '../src/campaign/vault.ts';
import { EnvError, loadEnv } from '../src/env.ts';
import { accountStateAtFinalizedBlock } from '../src/screen/single.ts';
import { decideViaGraph, decideViaV2 } from '../src/serv/client.ts';

/** Wallets one run screens at most: each is one model screening. */
export const MAX_WALLETS = 6;
// One screening is tried again after a failed read, as the worker would, but only this often here.
const TRIES_PER_WALLET = 3;
const CAMPAIGN_ID = 'screen-only';
const RULEBOOK_FILE = path.join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages', 'rulebook', 'thuli-rulebook.md');
// The throwaway campaign needs four addresses. Nothing reads them: no list is built and no vault is called.
const NOBODY = `0x${'00'.repeat(19)}01`;
// The store keeps a signature with every ask. These asks were signed by nobody, and say so in the one place they live.
const NO_SIGNATURE = `0x${'00'.repeat(65)}`;
const ONE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

class UsageError extends Error {
  override name = 'UsageError';
}

function walletsFrom(spec: string | undefined): Address[] {
  if (spec === undefined) throw new UsageError('--wallets is required: one address, or several separated by commas');
  const parts = spec.split(',').map((part) => part.trim()).filter((part) => part !== '');
  const bad = parts.find((part) => !ONE_ADDRESS.test(part));
  if (bad !== undefined) throw new UsageError('--wallets: every entry must be 0x and 40 hex characters');
  const wallets = [...new Set(parts.map((part) => part.toLowerCase()))].map((part) => parseAddress(part));
  if (wallets.length === 0) throw new UsageError('--wallets named no address');
  if (wallets.length > MAX_WALLETS) throw new UsageError(`--wallets: at most ${MAX_WALLETS} wallets a run, because each is one model screening`);
  return wallets;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { wallets: { type: 'string' } } });
  const wallets = walletsFrom(values.wallets);
  const env = loadEnv();
  const graphId = env.SERV_GRAPH_ID;
  if (graphId === undefined || graphVersion(graphId) === undefined) throw new UsageError('SERV_GRAPH_ID must name a graph Thuli has a translation for');
  const rulebook = fs.readFileSync(RULEBOOK_FILE, 'utf8');
  const scrub = scrubber([env.SERV_API_KEY, env.SERV_BASE_URL, env.ETH_RPC_URL, env.BASE_RPC_URL, env.BLOCKSCOUT_ETH_API, env.BLOCKSCOUT_API_KEY ?? '']);
  const say = (line: string) => console.log(scrub(line));

  const chains = await screenChains({ ethRpcUrl: env.ETH_RPC_URL, baseRpcUrl: env.BASE_RPC_URL }, say);
  say(chains === undefined ? 'Screening on Ethereum history only.' : 'Screening on Ethereum or Base history, whichever is older for each wallet.');

  const db = await openMemoryDb();
  try {
    await migrate(db);
    const opened = new Date();
    await createCampaign(db, {
      id: CAMPAIGN_ID,
      name: 'Screen only',
      chain: CHAINS['base-sepolia'].id,
      vault: NOBODY,
      token: NOBODY,
      owner: NOBODY,
      agent: NOBODY,
      rewardPerWallet: '1',
      perWalletCap: '1',
      partialShareBps: DEFAULT_SETTINGS.partialShareBps,
      maxSlots: wallets.length,
      rulebook: CURRENT_RULEBOOK,
      settings: { groupMinSize: DEFAULT_SETTINGS.groupMinSize, funderFanoutMin: DEFAULT_SETTINGS.funderFanoutMin },
      status: 'open',
      opensAt: new Date(opened.getTime() - 60_000),
      closesAt: new Date(opened.getTime() + 86_400_000),
      createdAt: opened,
    });
    for (const [index, wallet] of wallets.entries()) {
      const askedAt = new Date(opened.getTime() + index * 1000);
      const added = await addAsk(db, { campaignId: CAMPAIGN_ID, wallet, signedAt: Math.floor(askedAt.getTime() / 1000), signature: NO_SIGNATURE }, askedAt);
      if (added !== 'queued') throw new UsageError(`a wallet could not be queued: ${added}`);
    }

    const connection = { baseUrl: env.SERV_BASE_URL, apiKey: env.SERV_API_KEY };
    const explorer = { rpcUrl: env.ETH_RPC_URL, blockscoutApi: env.BLOCKSCOUT_ETH_API, ...(env.BLOCKSCOUT_API_KEY === undefined ? {} : { apiKey: env.BLOCKSCOUT_API_KEY }) };
    // A failed try waits minutes in the store before it is taken again. Here the clock is simply moved past the wait.
    let clock = Date.now();
    const deps = {
      db,
      facts: ethereumFacts(explorer),
      accountState: accountStateAtFinalizedBlock({ rpcUrl: env.ETH_RPC_URL }, 'ethereum'),
      usedOnBase: usedOnBase({ rpcUrl: env.BASE_RPC_URL }),
      ...(chains === undefined ? {} : { chains }),
      serv: {
        viaGraph: (record: Parameters<typeof decideViaGraph>[0]) => decideViaGraph(record, { ...connection, graphId }),
        viaV2: (record: Parameters<typeof decideViaV2>[0]) => decideViaV2(record, rulebook, connection),
        sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      },
      now: () => new Date(clock),
      log: say,
      memory: emptyChainMemory(),
    };
    for (let tries = 0; tries < wallets.length * TRIES_PER_WALLET; tries += 1) {
      const outcome = await screenNextAsk(deps);
      if (outcome.kind === 'idle') break;
      if (outcome.kind === 'released') clock += 3_600_000;
    }

    let undecided = 0;
    for (const wallet of wallets) {
      const ask = await getAsk(db, CAMPAIGN_ID, wallet);
      if (ask === null || ask.action === null) {
        undecided += 1;
        say(`\n${wallet}\n  not decided: its screening failed ${TRIES_PER_WALLET} times; the lines above say why`);
        continue;
      }
      const facts = ask.facts;
      say(`\n${wallet}`);
      say(`  history read on: ${facts === null ? 'nothing was read' : SCREENED_CHAIN_NAME[facts.chain]}`);
      say(`  decision: ${ask.action} under ${ask.rule ?? '?'}`);
      say(`  reason: ${JSON.stringify(ask.reason ?? '')}`);
      if (facts !== null) {
        const funder = facts.funder === null ? 'none found' : `${facts.funder.address} (${facts.funder.kind})`;
        say(`  facts: ${facts.ageDays ?? 'age not read'} days old, ${facts.txCount ?? 'count not read'} sent, ${facts.accountType}, first funder ${funder}, linked group ${facts.groupSize ?? 'none'}`);
      }
      say(`  cited transactions: ${(ask.citedTxs ?? []).join(' ') || 'none'}`);
    }
    return undecided === 0 ? 0 : 1;
  } finally {
    await db.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const known = error instanceof UsageError || error instanceof EnvError;
    console.error(`campaign:screen stopped: ${known ? error.message : error instanceof Error ? error.name : 'unknown error'}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  },
);

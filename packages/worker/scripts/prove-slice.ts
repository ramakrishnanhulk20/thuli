import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  AddressError,
  computeCeiling,
  computeStart,
  decisionFromGraphAnswer,
  DEFAULT_SETTINGS,
  holdForReview,
  parseAddress,
  toGraphRecord,
  validateDecision,
  type Address,
  type FactName,
} from '@thuli/core';
import { EnvError, loadEnv } from '../src/env.ts';
import { collectBasicFacts, type FactSources } from '../src/facts/basic.ts';
import { decideViaGraph, decideViaV2, ServError, type ServReply } from '../src/serv/client.ts';

// One block before the first ROBO claim (block 24546233), so no fact can include the claim or anything after it.
const DEFAULT_BLOCK = 24546232;
const RULEBOOK_PATH = new URL('../../rulebook/thuli-rulebook.md', import.meta.url);
const USAGE = 'Usage: npm run prove:slice -- --wallet <address> [--block <number>] [--mode v2|v3]';
const MAX_DISPLAY_CHARS = 4000;

class UsageError extends Error {
  override name = 'UsageError';
}

/** Model text is printed for a person to read, so terminal control sequences in it are made visible, not obeyed. */
function displayText(text: string): string {
  const shown = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '�');
  return shown.length > MAX_DISPLAY_CHARS ? `${shown.slice(0, MAX_DISPLAY_CHARS)} [cut at ${MAX_DISPLAY_CHARS} characters]` : shown;
}

function readArguments(): { wallet: Address; block: number; mode: 'v2' | 'v3' } {
  let values: { wallet?: string | undefined; block?: string | undefined; mode?: string | undefined };
  try {
    values = parseArgs({
      options: { wallet: { type: 'string' }, block: { type: 'string' }, mode: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw new UsageError(USAGE);
  }
  if (values.wallet === undefined) throw new UsageError(USAGE);
  let wallet: Address;
  try {
    wallet = parseAddress(values.wallet);
  } catch (error) {
    throw new UsageError(`Wallet address rejected: ${error instanceof AddressError ? error.message : 'unreadable'}`);
  }
  const blockText = values.block ?? String(DEFAULT_BLOCK);
  if (!/^(0|[1-9][0-9]{0,14})$/.test(blockText)) throw new UsageError('--block must be a whole number');
  const mode = values.mode ?? 'v3';
  if (mode !== 'v2' && mode !== 'v3') throw new UsageError('--mode must be v2 or v3');
  return { wallet, block: Number(blockText), mode };
}

async function main(): Promise<number> {
  const { wallet, block, mode } = readArguments();
  const env = loadEnv();
  if (mode === 'v3' && env.SERV_GRAPH_ID === undefined) {
    throw new UsageError(
      'Mode v3 needs SERV_GRAPH_ID in .env: the gr_ id from console.openserv.ai, Graphs, the Thuli graph. ' +
        'Or run with --mode v2 to send the same rulebook without a graph.',
    );
  }

  const sources: FactSources = {
    rpcUrl: env.ETH_RPC_URL,
    blockscoutApi: env.BLOCKSCOUT_ETH_API,
    onProblem: (fact: FactName, cause: string) => console.error(`note: ${fact} not available: ${cause}`),
  };
  const facts = await collectBasicFacts(wallet, { chain: 'ethereum', block }, sources);
  console.log('facts:');
  console.log(JSON.stringify(facts, null, 2));

  const { ceiling, reason } = computeCeiling(facts, DEFAULT_SETTINGS);
  const start = computeStart(facts, DEFAULT_SETTINGS);
  console.log(`ceiling: ${ceiling} (${reason})`);
  console.log(`start: ${start.outcome} (${start.rule})`);

  const record = toGraphRecord(facts, start);
  console.log('record:');
  console.log(JSON.stringify(record, null, 2));
  const connection = { baseUrl: env.SERV_BASE_URL, apiKey: env.SERV_API_KEY };

  let reply: ServReply;
  try {
    reply =
      mode === 'v3'
        ? await decideViaGraph(record, { ...connection, graphId: env.SERV_GRAPH_ID as string })
        : await decideViaV2(record, await readFile(RULEBOOK_PATH, 'utf8'), connection);
  } catch (error) {
    if (!(error instanceof ServError)) throw error;
    const held = holdForReview('the SERV call failed');
    console.log(`request id: ${error.requestId ?? 'none'}`);
    console.log(`SERV call failed: ${error.message}`);
    console.log('final decision:');
    console.log(JSON.stringify(held.decision, null, 2));
    console.log('accepted: false');
    return 1;
  }

  console.log(`request id: ${reply.requestId ?? 'none (SERV sent no x-openserv-request-id header)'}`);
  console.log('raw model text:');
  console.log(displayText(reply.rawText));

  // This build buys no funder lookups, so the decision must report none and no lookup hash can be cited.
  const answer = decisionFromGraphAnswer(reply.rawText, DEFAULT_SETTINGS, 0);
  if (answer.ok) console.log(`verdict: ${answer.verdict}`);
  else console.error(`the model reply was not usable: ${answer.cause}`);
  const result = answer.ok
    ? validateDecision(answer.decision, {
        facts,
        settings: DEFAULT_SETTINGS,
        ceiling,
        start,
        toolTxs: [],
        paidHopsMade: 0,
      })
    : holdForReview(answer.cause);
  console.log('final decision:');
  console.log(JSON.stringify(result.decision, null, 2));
  console.log(`accepted: ${result.accepted}`);

  return reply.requestId !== null && answer.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError || error instanceof EnvError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    // Library errors can quote the RPC URL, so only the error's class name is printed (threat model C40).
    console.error(`prove-slice stopped: ${error instanceof Error ? error.name : 'unknown error'}`);
    process.exitCode = 1;
  },
);

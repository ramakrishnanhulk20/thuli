// Read-only check of the RPC history reader against core's rules over the explorer's whole history: for each wallet, the
// free facts each gives at one finalized block, side by side, and every difference with both values. The whole history
// is both explorer lists read to the end. For the record, a second count says where the shipped single-wallet explorer
// reader, which reads internal transfers only when the external list names no funder, differs from that whole history;
// it does not decide the exit code.
//
//   npm run history:compare -- --wallets <file or comma list> [--chain ethereum]
//
// --wallets takes addresses, files, or both, comma separated; every address found in a file is read. Only Ethereum can
// be compared, because Base has no explorer reader. Reads ETH_RPC_URL, BLOCKSCOUT_ETH_API and, when set,
// BLOCKSCOUT_API_KEY from .env. It sends nothing and prints no endpoint address or key. Exits 1 on any difference
// between the RPC reader and the whole history, or any wallet whose whole history could not be read; 2 on a bad argument.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { parseAddress, type Address, type AddressData, type Facts } from '@thuli/core';
import { EnvError, loadEnv } from '../src/env.ts';
import { chainClient, collectBasicFacts, MAX_FUNDING_PAGES, readTransferPages, type FactSources, type HistorySources } from '../src/facts/basic.ts';
import { finalizedBlock, HistoryError, historyClientOf, rpcHistory, type HistoryClient } from '../src/facts/rpcHistory.ts';

// Wallets read at once. Each costs about 110 RPC calls and a few explorer pages; the public explorer host is the slow one.
const AT_ONCE = 3;
const ADDRESSES = /0x[0-9a-fA-F]{40}/g;
const ONE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

class UsageError extends Error {
  override name = 'UsageError';
}

function walletsFrom(spec: string): Address[] {
  const found: string[] = [];
  for (const part of spec.split(',').map((piece) => piece.trim()).filter((piece) => piece !== '')) {
    if (ONE_ADDRESS.test(part)) found.push(part);
    else if (fs.existsSync(part)) found.push(...(fs.readFileSync(part, 'utf8').match(ADDRESSES) ?? []));
    else throw new UsageError(`--wallets: ${part} is neither an address nor a file`);
  }
  return [...new Set(found.map((address) => address.toLowerCase()))].map((address) => parseAddress(address));
}

/** The facts one reader gave, and the first read it said failed, in its own fixed words. */
interface Read {
  facts: Facts;
  failed: string | null;
}

async function readFacts(wallet: Address, block: number, sources: FactSources | HistorySources): Promise<Read> {
  let failed: string | null = null;
  const facts = await collectBasicFacts(wallet, { chain: 'ethereum', block }, {
    ...sources,
    onProblem: (_fact, cause) => {
      if (failed === null && cause.includes('read failed')) failed = cause;
    },
  });
  return { facts, failed };
}

const COMPARED: readonly [string, (facts: Facts) => unknown][] = [
  ['walletAgeDays', (facts) => facts.walletAgeDays],
  ['txCountAtSnapshot', (facts) => facts.txCountAtSnapshot],
  ['accountType', (facts) => facts.accountType],
  ['first funder', (facts) => facts.firstFunder?.address ?? null],
  ['evidence transaction', (facts) => facts.evidenceTxs.join(' ') || null],
];

const shown = (value: unknown) => (value === null ? 'none' : String(value));

// Only this code's own fixed words pass; a library message can quote the endpoint (C40).
function safeCause(error: unknown): string {
  if (error instanceof HistoryError || error instanceof EnvError || error instanceof UsageError) return error.message;
  return error instanceof Error ? error.name : 'unknown error';
}

/** Every row the RPC reader gathered for a wallet that differs, so the difference can be explained from what was read. */
async function rowsOf(client: HistoryClient, wallet: Address, block: number): Promise<string[]> {
  try {
    const { external, internal } = await rpcHistory(client, wallet, block);
    const rows = [...external.transfers, ...(internal?.transfers ?? [])].sort((a, b) => a.block - b.block);
    return [
      `  rpc gathered ${rows.length} rows`,
      ...rows.map((row) => `  rpc row: block ${row.block} ${row.kind} ${row.hash} from ${row.from} to ${row.to ?? 'none'} ${row.valueWei} wei${row.failed ? ' failed' : ''}`),
    ];
  } catch (error) {
    return [`  rpc rows could not be read: ${safeCause(error)}`];
  }
}

/** Both explorer lists read to the end, whatever the external one shows, so core's rules see everything. */
async function wholeExplorerHistory(wallet: Address, block: number, sources: FactSources): Promise<AddressData> {
  const external = await readTransferPages(wallet, 'transactions', block, sources, { maxPages: MAX_FUNDING_PAGES });
  const internal = await readTransferPages(wallet, 'internal-transactions', block, sources, { maxPages: MAX_FUNDING_PAGES });
  if (!external.complete || !internal.complete) throw new HistoryError(`an explorer list runs past ${MAX_FUNDING_PAGES} pages`);
  return { external, internal };
}

const differencesOf = (left: Facts, right: Facts, names: readonly [string, string]) =>
  COMPARED.flatMap(([name, value]) => {
    const [a, b] = [value(left), value(right)];
    return a === b ? [] : [`${name} ${names[0]} ${shown(a)}, ${names[1]} ${shown(b)}`];
  });

// The public explorer host can time out on a busy wallet, so an explorer read gets one more try.
async function explorerRead(wallet: Address, block: number, sources: FactSources | HistorySources): Promise<Read> {
  const first = await readFacts(wallet, block, sources);
  return first.failed === null ? first : readFacts(wallet, block, sources);
}

interface Compared {
  lines: string[];
  same: boolean;
  /** Whether the shipped explorer reader gave what the whole history gives; null when the whole history was unread. */
  shippedSame: boolean | null;
}

async function compareOne(wallet: Address, block: number, explorer: FactSources, client: HistoryClient): Promise<Compared> {
  const viaRpc: HistorySources = { rpcUrl: explorer.rpcUrl, history: (address, at) => rpcHistory(client, address, at) };
  const viaWhole: HistorySources = { rpcUrl: explorer.rpcUrl, history: (address, at) => wholeExplorerHistory(address, at, explorer) };
  const [rpc, whole] = await Promise.all([readFacts(wallet, block, viaRpc), explorerRead(wallet, block, viaWhole)]);
  if (whole.failed !== null) return { lines: [`UNREAD ${wallet}: the explorer's whole history could not be read (${whole.failed})`], same: false, shippedSame: null };
  const shipped = await explorerRead(wallet, block, explorer);
  const shippedDifferences = shipped.failed === null ? differencesOf(whole.facts, shipped.facts, ['whole', 'shipped']) : [`not read (${shipped.failed})`];
  const record = shippedDifferences.length === 0 ? [] : [`  shipped explorer reader: ${shippedDifferences.join('; ')}`];
  const differences = differencesOf(whole.facts, rpc.facts, ['explorer', 'rpc']);
  if (differences.length === 0) {
    const facts = rpc.facts;
    const summary = `${shown(facts.walletAgeDays)} days, ${shown(facts.txCountAtSnapshot)} sent, ${facts.accountType}, funder ${shown(facts.firstFunder?.address ?? null)}`;
    return { lines: [`same   ${wallet}: ${summary}`, ...record], same: true, shippedSame: record.length === 0 };
  }
  const why = rpc.failed === null ? [] : [`  rpc said: ${rpc.failed}`];
  return { lines: [`DIFF   ${wallet}: ${differences.join('; ')}`, ...why, ...(await rowsOf(client, wallet, block)), ...record], same: false, shippedSame: record.length === 0 };
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { wallets: { type: 'string' }, chain: { type: 'string', default: 'ethereum' } } });
  if (values.chain !== 'ethereum') throw new UsageError('--chain: only ethereum can be compared, because Base has no explorer reader');
  if (values.wallets === undefined) throw new UsageError('--wallets is required: addresses or files, comma separated');
  const wallets = walletsFrom(values.wallets);
  if (wallets.length === 0) throw new UsageError('--wallets named no address');
  const env = loadEnv();
  const explorer: FactSources = {
    rpcUrl: env.ETH_RPC_URL,
    blockscoutApi: env.BLOCKSCOUT_ETH_API,
    ...(env.BLOCKSCOUT_API_KEY === undefined ? {} : { apiKey: env.BLOCKSCOUT_API_KEY }),
  };
  const client = historyClientOf(chainClient('ethereum', env.ETH_RPC_URL));
  const block = await finalizedBlock(client);
  console.log(`history:compare on ethereum at finalized block ${block}, ${wallets.length} wallets`);

  const results: Compared[] = [];
  for (let start = 0; start < wallets.length; start += AT_ONCE) {
    const batch = wallets.slice(start, start + AT_ONCE);
    results.push(...(await Promise.all(batch.map((wallet) => compareOne(wallet, block, explorer, client)))));
  }
  for (const result of results) for (const line of result.lines) console.log(line);
  const same = results.filter((result) => result.same).length;
  const read = results.filter((result) => result.shippedSame !== null);
  const shippedSame = read.filter((result) => result.shippedSame === true).length;
  console.log(
    `for the record: on ${shippedSame} of ${read.length} wallets the shipped single-wallet explorer reader gives what the whole explorer history gives`,
  );
  console.log(`${same} of ${wallets.length} wallets: the same walletAgeDays, txCountAtSnapshot, accountType, first funder and evidence transaction`);
  return same === wallets.length ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`history:compare stopped: ${safeCause(error)}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  },
);

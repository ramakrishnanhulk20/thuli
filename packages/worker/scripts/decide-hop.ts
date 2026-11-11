import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { BURST_KEPT_CAUSE, DEFAULT_SETTINGS, Facts, FUNDER_KEPT_CAUSE, graphVersion, OutcomeSchema, Start, type ReplayRow } from '@thuli/core';
import { JsonlCache } from '../src/chain/jsonlCache.ts';
import { EnvError, loadEnv } from '../src/env.ts';
import { AnswerKeyError, loadHopLists } from '../src/replay/answerKeys.ts';
import { KEYS_DIR, REPO_ROOT, UsageError, writeAtomically } from '../src/replay/cliSupport.ts';
import { DecisionRecord, MAX_UNDECIDED_IN_A_ROW, OutOfCredit, runDecisions, ServDown, STALE_ROWS, type DecideDeps } from '../src/replay/decide.ts';
import { decideViaGraph, decideViaV2 } from '../src/serv/client.ts';

// The draw of the first Hop measurement on 6 Nov: same seed, sizes, mode and width, so a rerun keeps every wallet its rows allow.
const SEED = 20261106;
const WIDTH = 24;
const SETS = {
  sample: { file: 'decisions-sample.jsonl', size: 1500 },
  eliminated: { file: 'decisions-eliminated.jsonl', size: 500 },
} as const;
type SetName = keyof typeof SETS;

// rows.jsonl is about 22 MB; a file far past this is not our replay output (C41).
const MAX_ROWS_BYTES = 256 * 1024 * 1024;
const OUT_OF_CREDIT_EXIT = 3;
const SERV_DOWN_EXIT = 4;
const OVER_LIMIT_EXIT = 5;
const UNDECIDED_EXIT = 6;

const HOP_DIR = path.join(REPO_ROOT, 'data', 'replay', 'hop');
const ROWS_FILE = path.join(HOP_DIR, 'rows.jsonl');
const RULEBOOK_FILE = path.join(REPO_ROOT, 'packages', 'rulebook', 'thuli-rulebook.md');
const USAGE = 'Usage: npm run decide:hop -- --set sample|eliminated [--limit-asks N] [--made-on-rows FILE]';

const RowLine = z.strictObject({
  wallet: z.string().regex(/^0x[0-9a-f]{40}$/),
  start: Start,
  ceiling: OutcomeSchema,
  facts: Facts,
});

const ROW_HASH = /^[0-9a-f]{64}$/;
const StoredLine = z.object({ key: z.string(), value: DecisionRecord, rowHash: z.string().regex(ROW_HASH).optional() });

interface Arguments {
  set: SetName;
  limitAsks: number | undefined;
  madeOnRows: string | undefined;
}

function readArguments(): Arguments {
  let values: { set?: string; 'limit-asks'?: string; 'made-on-rows'?: string };
  try {
    values = parseArgs({
      options: { set: { type: 'string' }, 'limit-asks': { type: 'string' }, 'made-on-rows': { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw new UsageError(USAGE);
  }
  if (values.set !== 'sample' && values.set !== 'eliminated') throw new UsageError(USAGE);
  const limitText = values['limit-asks'];
  if (limitText !== undefined && !/^(0|[1-9][0-9]{0,6})$/.test(limitText)) throw new UsageError('--limit-asks must be a whole number');
  return {
    set: values.set,
    limitAsks: limitText === undefined ? undefined : Number(limitText),
    madeOnRows: values['made-on-rows'] === undefined ? undefined : path.resolve(values['made-on-rows']),
  };
}

/** The row's line exactly as rows.jsonl holds it, hashed, so a change of any byte in the row means the answer is asked again. */
function rowHash(line: string): string {
  return crypto.createHash('sha256').update(line, 'utf8').digest('hex');
}

function readCapped(file: string, label: string): string {
  if (!fs.existsSync(file)) throw new UsageError(`${label}: that file does not exist`);
  if (fs.statSync(file).size > MAX_ROWS_BYTES) throw new UsageError(`${label}: larger than ${MAX_ROWS_BYTES} bytes`);
  return fs.readFileSync(file, 'utf8');
}

/** Today's rows and each one's line hash. A bad or doubled row stops the run here, before anything is sent. */
function loadRows(): { rows: ReplayRow[]; hashes: Map<string, string> } {
  const rows: ReplayRow[] = [];
  const hashes = new Map<string, string>();
  readCapped(ROWS_FILE, 'rows.jsonl')
    .split('\n')
    .forEach((text, index) => {
      if (text === '') return;
      let row: ReplayRow;
      try {
        row = RowLine.parse(JSON.parse(text));
      } catch {
        throw new UsageError(`rows.jsonl, line ${index + 1}: not a replay row, rerun the replay`);
      }
      if (hashes.has(row.wallet)) throw new UsageError(`rows.jsonl, line ${index + 1}: this wallet is listed twice`);
      hashes.set(row.wallet, rowHash(text));
      rows.push(row);
    });
  return { rows, hashes };
}

/**
 * The line hashes of an older rows file, for answers stored before each answer carried its row's hash. Only the bytes
 * are compared, so a line is read no further than its wallet.
 */
function madeOnHashes(file: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const Wallet = z.object({ wallet: z.string().regex(/^0x[0-9a-f]{40}$/) });
  readCapped(file, '--made-on-rows')
    .split('\n')
    .forEach((text, index) => {
      if (text === '') return;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new UsageError(`--made-on-rows, line ${index + 1}: not a replay row`);
      }
      const parsed = Wallet.safeParse(json);
      if (!parsed.success) throw new UsageError(`--made-on-rows, line ${index + 1}: not a replay row`);
      hashes.set(parsed.data.wallet, rowHash(text));
    });
  return hashes;
}

// A wallet with no recorded history at all was never read, so it is no measure of how real users are treated.
const noHistory = (facts: Facts) =>
  facts.walletAgeDays === 0 && facts.txCountAtSnapshot === 0 && facts.firstFunder === null && facts.missing.length === 0;

/**
 * The set's wallets from today's rows, in draw order: a seeded shuffle of the pool, cut to the set's size. The sample is
 * the eligible wallets no group named; the eliminated set is the wallets Hop removed whose start is a funder check.
 */
function draw(set: SetName, rows: ReplayRow[]): ReplayRow[] {
  const lists = loadHopLists(KEYS_DIR);
  const eligible = new Set(lists.eligible);
  const pool =
    set === 'sample'
      ? rows.filter((row) => lists.negatives.has(row.wallet) && !noHistory(row.facts))
      : rows.filter((row) => !eligible.has(row.wallet) && !noHistory(row.facts) && ['A8', 'A9'].includes(row.start.rule));
  let seed = SEED;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j] as ReplayRow, pool[i] as ReplayRow];
  }
  return pool.slice(0, SETS[set].size);
}

/**
 * The set file's answers and the row hash stored beside each. The later line for a wallet wins, as in a JsonlCache
 * reload. A line that does not parse, as a crash mid-write leaves, is skipped, and that wallet is asked again.
 */
function readStored(file: string): Map<string, { record: DecisionRecord; rowHash: string | null }> {
  const stored = new Map<string, { record: DecisionRecord; rowHash: string | null }>();
  if (!fs.existsSync(file)) return stored;
  for (const text of readCapped(file, path.basename(file)).split('\n')) {
    if (text === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const parsed = StoredLine.safeParse(json);
    if (parsed.success && parsed.data.key === parsed.data.value.wallet) {
      stored.set(parsed.data.key, { record: parsed.data.value, rowHash: parsed.data.rowHash ?? null });
    }
  }
  return stored;
}

function writeSet(file: string, lines: { record: DecisionRecord; rowHash: string }[]): void {
  writeAtomically(file, lines.map(({ record, rowHash: hash }) => `${JSON.stringify({ key: record.wallet, value: record, rowHash: hash })}\n`).join(''));
}

function liveDeps(): DecideDeps {
  const env = loadEnv();
  const connection = { baseUrl: env.SERV_BASE_URL, apiKey: env.SERV_API_KEY };
  const graphId = env.SERV_GRAPH_ID;
  if (graphId === undefined || graphVersion(graphId) === undefined) {
    throw new UsageError('Set SERV_GRAPH_ID in .env to a graph Thuli has a translation for: the Hop sets are asked in auto mode');
  }
  const rulebook = fs.readFileSync(RULEBOOK_FILE, 'utf8');
  return {
    viaGraph: (record) => decideViaGraph(record, { ...connection, graphId }),
    viaV2: (record) => decideViaV2(record, rulebook, connection),
    sleep: (ms) => wait(ms),
  };
}

const count = (value: number) => value.toLocaleString('en-US');

async function main(): Promise<number> {
  const args = readArguments();
  const file = path.join(HOP_DIR, SETS[args.set].file);
  const { rows, hashes } = loadRows();
  const drawn = draw(args.set, rows);
  const stored = readStored(file);
  const madeOn = args.madeOnRows === undefined ? new Map<string, string>() : madeOnHashes(args.madeOnRows);

  // An answer is reused only for a wallet still drawn whose row is byte for byte the row the answer was made on, and
  // whose start and ceiling the answer still carries, so a change in the start rules alone also asks again.
  const isReusable = (row: ReplayRow) => {
    const answer = stored.get(row.wallet);
    if (answer === undefined) return false;
    const { start, ceiling } = answer.record;
    if (start.outcome !== row.start.outcome || start.rule !== row.start.rule || ceiling !== row.ceiling) return false;
    const madeOnHash = answer.rowHash ?? madeOn.get(row.wallet) ?? null;
    return madeOnHash !== null && madeOnHash === hashes.get(row.wallet);
  };
  const reused = drawn.filter(isReusable);
  const toAsk = drawn.filter((row) => !isReusable(row));
  const label = `hop ${args.set}`;
  console.error(`${label}: drawn ${count(drawn.length)}, reused ${count(reused.length)}, to ask ${count(toAsk.length)}`);
  if (args.limitAsks !== undefined && toAsk.length > args.limitAsks) {
    console.error(`${label}: ${count(toAsk.length)} wallets would be asked, above --limit-asks ${count(args.limitAsks)}. Nothing was sent or changed.`);
    return OVER_LIMIT_EXIT;
  }

  const hashOf = (row: ReplayRow) => hashes.get(row.wallet) as string;
  // Only answers still good stay in the file before any call, so a stale one can never be read back as current.
  writeSet(file, reused.map((row) => ({ record: (stored.get(row.wallet) as { record: DecisionRecord }).record, rowHash: hashOf(row) })));
  const cache = new JsonlCache(file, DecisionRecord);

  let exitCode = 0;
  try {
    if (toAsk.length > 0) {
      await runDecisions(toAsk, DEFAULT_SETTINGS, liveDeps(), { mode: 'auto', width: WIDTH, limit: undefined, cache, log: (line) => console.error(line) });
    }
  } catch (error) {
    if (error instanceof OutOfCredit) {
      console.error('SERV credit ran out. Finished wallets are saved, so top up and run this again to carry on.');
      exitCode = OUT_OF_CREDIT_EXIT;
    } else if (error instanceof ServDown) {
      console.error(`SERV gave no answer for ${MAX_UNDECIDED_IN_A_ROW} wallets in a row. Finished wallets are saved, so check the key and the provider, then run this again.`);
      exitCode = SERV_DOWN_EXIT;
    } else {
      throw error;
    }
  } finally {
    // The file ends holding the drawn wallets that have an answer, in draw order, each beside the hash of today's row.
    writeSet(file, drawn.flatMap((row) => {
      const record = cache.get(row.wallet);
      return record === undefined ? [] : [{ record, rowHash: hashOf(row) }];
    }));
  }

  const fresh = toAsk.flatMap((row) => cache.get(row.wallet) ?? []);
  const replaced = fresh.filter((record) => record.cause === BURST_KEPT_CAUSE || record.cause === FUNDER_KEPT_CAUSE).length;
  const refused = fresh.filter((record) => !record.accepted).length - replaced;
  const undecided = toAsk.length - fresh.length;
  const tokens = fresh.reduce((sum, record) => ({ in: sum.in + (record.usage?.inputTokens ?? 0), out: sum.out + (record.usage?.outputTokens ?? 0) }), { in: 0, out: 0 });
  console.log(
    `${label}: drawn ${count(drawn.length)}, reused ${count(reused.length)}, asked ${count(toAsk.length)}, refused by the checks ${count(refused)}, replaced by the code ${count(replaced)}, undecided ${count(undecided)}`,
  );
  console.log(
    `${label}: new answers ${count(fresh.length)} (graph ${count(fresh.filter((record) => record.mode === 'v3').length)}, v2 ${count(fresh.filter((record) => record.mode === 'v2').length)}, fallback ${count(fresh.filter((record) => record.fallback).length)}), tokens ${count(tokens.in)} in and ${count(tokens.out)} out`,
  );
  if (exitCode === 0 && undecided > 0) {
    console.error(`${label}: ${count(undecided)} wallets got no answer. Run this again to ask them.`);
    exitCode = UNDECIDED_EXIT;
  }
  return exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError || error instanceof EnvError || (error instanceof Error && error.message === STALE_ROWS)) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    if (error instanceof AnswerKeyError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    // Library errors can quote the SERV URL, so only the error's class name is printed (threat model C40).
    console.error(`decide-hop stopped: ${error instanceof Error ? error.name : 'unknown error'}`);
    process.exitCode = 1;
  },
);

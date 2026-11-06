import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { AddressError, DEFAULT_SETTINGS, Facts, graphVersion, OutcomeSchema, parseAddress, Start, type ReplayRow } from '@thuli/core';
import { JsonlCache } from '../src/chain/jsonlCache.ts';
import { EnvError, loadEnv } from '../src/env.ts';
import { AnswerKeyError, loadClaimEvents, loadFarmKey } from '../src/replay/answerKeys.ts';
import { UsageError, writeAtomically } from '../src/replay/cliSupport.ts';
import {
  DecisionRecord,
  MAX_DECIDE_WIDTH,
  MAX_UNDECIDED_IN_A_ROW,
  OutOfCredit,
  runDecisions,
  ServDown,
  STALE_ROWS,
  type DecideDeps,
} from '../src/replay/decide.ts';
import { decisionsToMarkdown, scoreDecisions, STALE_DECISION } from '../src/replay/decisionScore.ts';
import { decideViaGraph, decideViaV2 } from '../src/serv/client.ts';

const DEFAULT_WIDTH = 24;
// rows.jsonl is about 21 MB; a file far past this is not our replay output (C41).
const MAX_ROWS_BYTES = 256 * 1024 * 1024;
const OUT_OF_CREDIT_EXIT = 3;
const SERV_DOWN_EXIT = 4;

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const KEYS_DIR = path.join(REPO_ROOT, 'reference', 'answer-keys');
const ROBO_DIR = path.join(REPO_ROOT, 'data', 'replay', 'robo');
const ROWS_FILE = path.join(ROBO_DIR, 'rows.jsonl');
const RULEBOOK_FILE = path.join(REPO_ROOT, 'packages', 'rulebook', 'thuli-rulebook.md');
const USAGE =
  'Usage: npm run decide:robo -- [--wallets FILE] [--limit N] [--width N] [--mode auto|v2] [--out DIR] [--spent-cents N] [--report-only]';

// Lowercase only: the decisions cache and the answer keys are both keyed by the lowercase wallet.
const RowLine = z.strictObject({
  wallet: z.string().regex(/^0x[0-9a-f]{40}$/),
  start: Start,
  ceiling: OutcomeSchema,
  facts: Facts,
});

interface Arguments {
  walletsFile: string | undefined;
  limit: number | undefined;
  width: number;
  mode: 'auto' | 'v2';
  outDir: string;
  spentCents: number | null;
  reportOnly: boolean;
}

function readArguments(): Arguments {
  let values: {
    wallets?: string;
    limit?: string;
    width?: string;
    mode?: string;
    out?: string;
    'spent-cents'?: string;
    'report-only'?: boolean;
  };
  try {
    values = parseArgs({
      options: {
        wallets: { type: 'string' },
        limit: { type: 'string' },
        width: { type: 'string' },
        mode: { type: 'string' },
        out: { type: 'string' },
        'spent-cents': { type: 'string' },
        'report-only': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw new UsageError(USAGE);
  }
  const limitText = values.limit;
  if (limitText !== undefined && !/^[1-9][0-9]{0,6}$/.test(limitText)) throw new UsageError('--limit must be a whole number above 0');
  const widthText = values.width ?? String(DEFAULT_WIDTH);
  const width = Number(widthText);
  if (!/^[1-9][0-9]{0,2}$/.test(widthText) || width > MAX_DECIDE_WIDTH) {
    throw new UsageError(`--width must be a whole number from 1 to ${MAX_DECIDE_WIDTH}`);
  }
  const mode = values.mode ?? 'auto';
  if (mode !== 'auto' && mode !== 'v2') throw new UsageError('--mode must be auto or v2');
  const spentText = values['spent-cents'];
  if (spentText !== undefined && !/^(0|[1-9][0-9]{0,8})$/.test(spentText)) {
    throw new UsageError('--spent-cents must be a whole number of cents');
  }
  return {
    walletsFile: values.wallets === undefined ? undefined : path.resolve(values.wallets),
    limit: limitText === undefined ? undefined : Number(limitText),
    width,
    mode,
    outDir: values.out === undefined ? ROBO_DIR : path.resolve(values.out),
    spentCents: spentText === undefined ? null : Number(spentText),
    reportOnly: values['report-only'] ?? false,
  };
}

/** Checks every row before anything is sent, because a bad or doubled row would be paid for and then miscounted. */
function loadRows(): ReplayRow[] {
  if (!fs.existsSync(ROWS_FILE)) throw new UsageError('No replay rows yet. Run npm run replay:robo first.');
  if (fs.statSync(ROWS_FILE).size > MAX_ROWS_BYTES) throw new UsageError(`rows.jsonl is larger than ${MAX_ROWS_BYTES} bytes`);
  const seen = new Set<string>();
  const lines = fs.readFileSync(ROWS_FILE, 'utf8').split(/\r?\n/);
  const rows: ReplayRow[] = [];
  lines.forEach((text, index) => {
    if (text === '') return;
    let row: ReplayRow;
    try {
      row = RowLine.parse(JSON.parse(text));
    } catch {
      throw new UsageError(`rows.jsonl, line ${index + 1}: not a replay row, rerun the replay`);
    }
    if (seen.has(row.wallet)) throw new UsageError(`rows.jsonl, line ${index + 1}: this wallet is listed twice`);
    seen.add(row.wallet);
    rows.push(row);
  });
  return rows;
}

function chooseRows(rows: ReplayRow[], walletsFile: string): ReplayRow[] {
  if (!fs.existsSync(walletsFile)) throw new UsageError('--wallets: that file does not exist');
  const lines = fs.readFileSync(walletsFile, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
  const chosen = new Set(lines.map((line) => parseAddress(line.trim()).toLowerCase()));
  const known = new Set(rows.map((row) => row.wallet));
  const strangers = [...chosen].filter((wallet) => !known.has(wallet)).length;
  if (strangers > 0) throw new UsageError(`--wallets: ${strangers} of ${chosen.size} wallets are not in the replay rows`);
  return rows.filter((row) => chosen.has(row.wallet));
}

function liveDeps(mode: 'auto' | 'v2'): DecideDeps {
  const env = loadEnv();
  const connection = { baseUrl: env.SERV_BASE_URL, apiKey: env.SERV_API_KEY };
  const graphId = env.SERV_GRAPH_ID;
  if (mode === 'auto' && (graphId === undefined || graphVersion(graphId) === undefined)) {
    throw new UsageError('Set SERV_GRAPH_ID in .env to a graph Thuli has a translation for, or use --mode v2');
  }
  const rulebook = fs.readFileSync(RULEBOOK_FILE, 'utf8');
  return {
    viaGraph: (record) => decideViaGraph(record, { ...connection, graphId: graphId as string }),
    viaV2: (record) => decideViaV2(record, rulebook, connection),
    sleep: (ms) => wait(ms),
  };
}

async function main(): Promise<number> {
  const args = readArguments();
  const allRows = loadRows();
  const rows = args.walletsFile === undefined ? allRows : chooseRows(allRows, args.walletsFile);
  const events = loadClaimEvents(path.join(KEYS_DIR, 'robo-claim-events.csv'));
  const key = loadFarmKey(path.join(KEYS_DIR, 'robo-farm-claim-wallets-reconstructed.csv'));
  const claimedWei = new Map<string, bigint>();
  for (const event of events) claimedWei.set(event.recipient, (claimedWei.get(event.recipient) ?? 0n) + event.amountWei);
  const cache = new JsonlCache(path.join(args.outDir, 'decisions.jsonl'), DecisionRecord);

  let exitCode = 0;
  const storedRecords = () => rows.flatMap((row) => cache.get(row.wallet) ?? []);
  // Checked before any call, so a resume into an old folder on changed rows stops here instead of paying first.
  scoreDecisions(storedRecords(), rows, key, claimedWei);

  if (!args.reportOnly) {
    const deps = liveDeps(args.mode);
    console.error(`deciding ${rows.length} ROBO claim wallets, ${args.width} at a time, mode ${args.mode}`);
    try {
      const run = await runDecisions(rows, DEFAULT_SETTINGS, deps, {
        mode: args.mode,
        width: args.width,
        limit: args.limit,
        cache,
        log: (line) => console.error(line),
      });
      console.error(`this run: ${run.decided} decided, ${run.undecided} undecided, ${run.skipped} already stored`);
    } catch (error) {
      if (error instanceof OutOfCredit) {
        console.error('SERV credit ran out. Finished wallets are saved, so top up and run this again to carry on.');
        exitCode = OUT_OF_CREDIT_EXIT;
      } else if (error instanceof ServDown) {
        console.error(
          `SERV gave no answer for ${MAX_UNDECIDED_IN_A_ROW} wallets in a row. Finished wallets are saved, so check the key and the provider, then run this again.`,
        );
        exitCode = SERV_DOWN_EXIT;
      } else {
        throw error;
      }
    }
  }

  const report = decisionsToMarkdown(scoreDecisions(storedRecords(), rows, key, claimedWei), {
    runDate: new Date().toISOString().slice(0, 10),
    spentCents: args.spentCents,
  });
  writeAtomically(path.join(args.outDir, 'decisions-report.md'), report);
  console.log(report);
  return exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError || error instanceof EnvError || error instanceof AddressError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    if (error instanceof AnswerKeyError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    if (error instanceof Error && (error.message === STALE_ROWS || error.message === STALE_DECISION)) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    // Library errors can quote the SERV URL, so only the error's class name is printed (threat model C40).
    console.error(`decide-robo stopped: ${error instanceof Error ? error.name : 'unknown error'}`);
    process.exitCode = 1;
  },
);

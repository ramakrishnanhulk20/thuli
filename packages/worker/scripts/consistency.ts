// Measures repeatability: the same wallet, with the same facts, asked again through the production decision path. It
// samples wallets from the ROBO replay by a fixed seed, a third each of full, partial and model-made holds, sends each
// one to SERV several times, and writes the agreement with its 95% intervals to packages/web/public/replay/consistency.json.
//
//   node --env-file=.env --import tsx packages/worker/scripts/consistency.ts [--wallets N] [--runs K] [--seed S] [--resume]
//
// Needs the private replay files data/replay/robo/rows.jsonl and decisions-v2.jsonl (npm run replay:robo, decide:robo
// and versions:score write them), and SERV_API_KEY, SERV_BASE_URL and SERV_GRAPH_ID from .env, none of which it prints.
// Every try is a fresh SERV call. Each try is appended to data/consistency/runs.jsonl as it lands, so --resume finishes
// a stopped measurement without paying again for tries already answered; without --resume an existing log is refused.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CURRENT_RULEBOOK, DEFAULT_SETTINGS, Facts, graphVersion, OutcomeSchema, Start, type ReplayRow } from '@thuli/core';
import { JsonlCache } from '../src/chain/jsonlCache.ts';
import { EnvError, loadEnv } from '../src/env.ts';
import { REPO_ROOT, UsageError, writeAtomically } from '../src/replay/cliSupport.ts';
import {
  ceilingViolated,
  DEFAULT_RUNS,
  DEFAULT_SEED,
  DEFAULT_WALLETS,
  publicFile,
  RunLine,
  sampleWallets,
  scoreConsistency,
  spendGuard,
  spendLimit,
  stoppedBySpendGuard,
  STRATA,
  stratumOf,
  type Rate,
  type SampledWallet,
  type Score,
} from '../src/replay/consistency.ts';
import { DecisionRecord, decideWallet, OutOfCredit, type DecideDeps } from '../src/replay/decide.ts';
import { MAX_SERV_CALLS_PER_SCREEN, SCREEN_CAUSES, SCREEN_TIME_LIMIT_MS, servBudget } from '../src/screen/single.ts';
import { decideViaGraph, decideViaV2 } from '../src/serv/client.ts';

const ROBO_DIR = path.join(REPO_ROOT, 'data', 'replay', 'robo');
const ROWS_FILE = path.join(ROBO_DIR, 'rows.jsonl');
// The stored replies rechecked under rulebook 2, the rulebook every live screening runs.
const DECISIONS_FILE = path.join(ROBO_DIR, 'decisions-v2.jsonl');
const LOG_FILE = path.join(REPO_ROOT, 'data', 'consistency', 'runs.jsonl');
const PUBLIC_FILE = path.join(REPO_ROOT, 'packages', 'web', 'public', 'replay', 'consistency.json');
const SHARDS_DIR = path.join(REPO_ROOT, 'packages', 'web', 'public', 'replay', 'robo', 'wallets');
const SUMMARY_FILE = path.join(REPO_ROOT, 'packages', 'web', 'public', 'replay', 'robo', 'summary.json');
const RULEBOOK_FILE = path.join(REPO_ROOT, 'packages', 'rulebook', 'thuli-rulebook.md');
// rows.jsonl is about 21 MB; a file far past this is not our replay output (C41).
const MAX_ROWS_BYTES = 256 * 1024 * 1024;
// Two seconds between tries, and the tries of one wallet a whole round apart, so SERV's rate limit is not what is measured.
const PAUSE_MS = 2_000;
const MAX_WALLETS = 300;
const MAX_RUNS = 20;
const OUT_OF_CREDIT_EXIT = 3;
const SPEND_LIMIT_EXIT = 4;
const UNFINISHED_EXIT = 5;
const USAGE = 'Usage: consistency.ts [--wallets N] [--runs K] [--seed S] [--resume]';

const RowLine = z.strictObject({ wallet: z.string().regex(/^0x[0-9a-f]{40}$/), start: Start, ceiling: OutcomeSchema, facts: Facts });

interface Arguments {
  wallets: number;
  runs: number;
  seed: number;
  resume: boolean;
}

function readArguments(): Arguments {
  let values: { wallets?: string; runs?: string; seed?: string; resume?: boolean };
  try {
    values = parseArgs({
      options: { wallets: { type: 'string' }, runs: { type: 'string' }, seed: { type: 'string' }, resume: { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw new UsageError(USAGE);
  }
  const whole = (text: string | undefined, fallback: number, least: number, most: number, flag: string) => {
    if (text === undefined) return fallback;
    const value = Number(text);
    if (!/^[0-9]{1,10}$/.test(text) || value < least || value > most) throw new UsageError(`${flag} must be a whole number from ${least} to ${most}`);
    return value;
  };
  return {
    wallets: whole(values.wallets, DEFAULT_WALLETS, 3, MAX_WALLETS, '--wallets'),
    runs: whole(values.runs, DEFAULT_RUNS, 2, MAX_RUNS, '--runs'),
    seed: whole(values.seed, DEFAULT_SEED, 0, 2 ** 31 - 1, '--seed'),
    resume: values.resume ?? false,
  };
}

const NEEDS_REPLAY =
  'This measure samples the private ROBO replay files data/replay/robo/rows.jsonl and decisions-v2.jsonl, which are not in the repository. Run npm run replay:robo, npm run decide:robo and npm run versions:score first.';

function loadRows(): Map<string, ReplayRow> {
  if (!fs.existsSync(ROWS_FILE) || !fs.existsSync(DECISIONS_FILE)) throw new UsageError(NEEDS_REPLAY);
  if (fs.statSync(ROWS_FILE).size > MAX_ROWS_BYTES) throw new UsageError(`rows.jsonl is larger than ${MAX_ROWS_BYTES} bytes`);
  const rows = new Map<string, ReplayRow>();
  fs.readFileSync(ROWS_FILE, 'utf8')
    .split(/\r?\n/)
    .forEach((text, index) => {
      if (text === '') return;
      let row: ReplayRow;
      try {
        row = RowLine.parse(JSON.parse(text));
      } catch {
        throw new UsageError(`rows.jsonl, line ${index + 1}: not a replay row, rerun the replay`);
      }
      rows.set(row.wallet, row);
    });
  return rows;
}

/** The sample, drawn by seed from every stored rulebook-2 decision whose row still gives the start and ceiling it was made on. */
function drawSample(rows: Map<string, ReplayRow>, args: Arguments): SampledWallet[] {
  const stored = new JsonlCache(DECISIONS_FILE, DecisionRecord);
  const candidates: SampledWallet[] = [];
  for (const [wallet, row] of rows) {
    const record = stored.get(wallet);
    if (record === undefined) continue;
    if (record.start.outcome !== row.start.outcome || record.start.rule !== row.start.rule || record.ceiling !== row.ceiling) continue;
    const stratum = stratumOf(record);
    if (stratum !== null) candidates.push({ wallet, stratum, stored: record.action });
  }
  return sampleWallets(candidates, args.wallets, args.seed);
}

/** Every try already logged. A line cut short by a stop is skipped, and the file is ended with a newline before appending. */
function readLog(): RunLine[] {
  if (!fs.existsSync(LOG_FILE)) return [];
  const text = fs.readFileSync(LOG_FILE, 'utf8');
  if (text !== '' && !text.endsWith('\n')) fs.appendFileSync(LOG_FILE, '\n');
  return text.split(/\r?\n/).flatMap((line) => {
    if (line === '') return [];
    try {
      const parsed = RunLine.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

/** True when every sampled wallet is already published in the replay's wallet shards, so naming it here reveals nothing new. */
function allPublic(sample: readonly SampledWallet[]): boolean {
  const shards = new Map<string, Record<string, unknown>>();
  return sample.every(({ wallet }) => {
    const shard = wallet.slice(2, 4);
    if (!shards.has(shard)) {
      const file = path.join(SHARDS_DIR, `${shard}.json`);
      shards.set(shard, fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { wallets: Record<string, unknown> }).wallets : {});
    }
    return Object.hasOwn(shards.get(shard) as Record<string, unknown>, wallet);
  });
}

function liveServ(): DecideDeps {
  const env = loadEnv();
  const graphId = env.SERV_GRAPH_ID;
  if (graphId === undefined || graphVersion(graphId) === undefined) {
    throw new UsageError('Set SERV_GRAPH_ID in .env to a graph Thuli has a translation for: auto mode asks the graph first.');
  }
  const connection = { baseUrl: env.SERV_BASE_URL, apiKey: env.SERV_API_KEY };
  const rulebook = fs.readFileSync(RULEBOOK_FILE, 'utf8');
  return {
    viaGraph: (record) => decideViaGraph(record, { ...connection, graphId }),
    viaV2: (record) => decideViaV2(record, rulebook, connection),
    sleep: (ms) => wait(ms),
  };
}

const percent = (value: number | null) => (value === null ? '-' : `${Math.round(value * 100)}`);
const rateText = (rate: Rate) => `${rate.count}/${rate.total} ${percent(rate.rate)}% (${percent(rate.low)}-${percent(rate.high)})`;

function printTable(scores: Record<string, Score>): void {
  const columns = ['stratum', 'wallets', 'all runs one action', 'runs = wallet mode', 'runs = stored', 'answer replaced', 'graph/v2/fallback', 'calls'];
  const rows = Object.entries(scores).map(([name, score]) => [
    name,
    String(score.wallets),
    rateText(score.allSame),
    rateText(score.matchMode),
    rateText(score.matchStored),
    rateText(score.replaced),
    `${score.routes.graph}/${score.routes.v2}/${score.routes.fallback}`,
    String(score.servCalls),
  ]);
  const widths = columns.map((column, index) => Math.max(column.length, ...rows.map((row) => (row[index] as string).length)));
  for (const row of [columns, ...rows]) console.log(row.map((cell, index) => cell.padEnd(widths[index] as number)).join('  '));
}

function centsPerCall(): number | null {
  try {
    const summary = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8')) as { run?: { centsPerWallet?: unknown } };
    return typeof summary.run?.centsPerWallet === 'number' ? summary.run.centsPerWallet : null;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const args = readArguments();
  const rows = loadRows();
  const sample = drawSample(rows, args);
  const logged = readLog();
  if (logged.length > 0 && !args.resume) {
    throw new UsageError('data/consistency/runs.jsonl already holds a measurement. Pass --resume to finish it; it is never started twice.');
  }
  if (logged.some((line) => line.seed !== args.seed || line.wallets !== args.wallets || line.runs !== args.runs)) {
    throw new UsageError('The run log was made with another --wallets, --runs or --seed; resume it with the same ones.');
  }
  const counts = STRATA.map((stratum) => `${sample.filter((one) => one.stratum === stratum).length} ${stratum}`).join(', ');
  console.log(`Repeatability, rulebook ${CURRENT_RULEBOOK}, seed ${args.seed}: ${sample.length} wallets (${counts}), ${args.runs} runs each`);

  const answered = new Set(logged.filter((line) => line.answered).map((line) => `${line.wallet}:${line.run}`));
  const loggedCalls = logged.reduce((sum, line) => sum + line.calls, 0);
  const limit = Math.max(0, spendLimit(sample.length, args.runs) - loggedCalls);
  const todo = Array.from({ length: args.runs }, (_, index) => index + 1).flatMap((run) =>
    sample.filter((target) => !answered.has(`${target.wallet}:${run}`)).map((target) => ({ target, run })),
  );
  let exitCode = 0;
  let servCallsNow = 0;
  if (todo.length > 0) {
    const guard = spendGuard(liveServ(), limit);
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    console.log(`${todo.length} tries to make, at most ${limit} SERV calls`);
    for (const [index, { target, run }] of todo.entries()) {
      const row = rows.get(target.wallet) as ReplayRow;
      const budget = servBudget(guard.deps, MAX_SERV_CALLS_PER_SCREEN);
      const before = guard.calls();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeUp = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          budget.stop(SCREEN_CAUSES.timeUp);
          resolve(null);
        }, SCREEN_TIME_LIMIT_MS);
      });
      let record: DecisionRecord | null = null;
      let stop: number | null = null;
      try {
        record = await Promise.race([decideWallet(row, DEFAULT_SETTINGS, budget.deps, 'auto'), timeUp]);
      } catch (error) {
        if (error instanceof OutOfCredit) stop = OUT_OF_CREDIT_EXIT;
        else if (stoppedBySpendGuard(error) && guard.calls() >= limit) stop = SPEND_LIMIT_EXIT;
        else if (!stoppedBySpendGuard(error)) throw error;
      } finally {
        clearTimeout(timer);
      }
      const calls = guard.calls() - before;
      servCallsNow += calls;
      const line: RunLine = {
        seed: args.seed,
        wallets: args.wallets,
        runs: args.runs,
        wallet: target.wallet,
        stratum: target.stratum,
        run,
        answered: record !== null,
        action: record?.action ?? null,
        rule: record?.rule ?? null,
        mode: record?.mode ?? null,
        fallback: record?.fallback ?? null,
        replaced: record === null ? null : !record.accepted,
        clamped: record === null ? null : record.clampedFrom !== null,
        requestId: record?.requestId ?? null,
        calls,
        start: row.start.outcome,
        ceiling: row.ceiling,
        ceilingViolation: record !== null && ceilingViolated(record.action, row.ceiling),
        at: new Date().toISOString(),
      };
      fs.appendFileSync(LOG_FILE, `${JSON.stringify(RunLine.parse(line))}\n`);
      const shown = record === null ? 'no answer' : `${record.action} ${record.rule} via ${record.mode}${record.accepted ? '' : ', replaced'}`;
      console.log(`  ${index + 1}/${todo.length} ${target.stratum} ${target.wallet} run ${run}: ${shown}, ${calls} call${calls === 1 ? '' : 's'}`);
      if (stop !== null) {
        exitCode = stop;
        console.log(stop === OUT_OF_CREDIT_EXIT ? 'SERV is out of credit; stopping now.' : 'The spend limit is reached; stopping now.');
        break;
      }
      if (index < todo.length - 1) await wait(PAUSE_MS);
    }
  }

  const lines = readLog();
  const scores = scoreConsistency(sample, lines, args.runs);
  console.log('');
  printTable({ ...scores.strata, overall: scores.overall });
  const cents = centsPerCall();
  const totalCalls = scores.overall.servCalls;
  const costText = cents === null ? '' : `, about ${(totalCalls * cents).toFixed(1)} cents at ${cents} cents a call (the replay summary's cost per wallet)`;
  console.log(`\nSERV calls: ${totalCalls} for the whole measurement, ${servCallsNow} in this process${costText}`);
  console.log(`Ceiling violations: ${scores.overall.ceilingViolations}`);

  const unfinished = scores.overall.runs < sample.length * args.runs;
  if (unfinished) {
    console.log(`\n${sample.length * args.runs - scores.overall.runs} runs have no answer yet, so the public file is not written. Run again with --resume.`);
    if (exitCode === 0) exitCode = UNFINISHED_EXIT;
  } else {
    const withAddresses = allPublic(sample);
    const file = publicFile({ runDate: new Date().toISOString().slice(0, 10), rulebook: CURRENT_RULEBOOK, seed: args.seed, runsPerWallet: args.runs }, scores, withAddresses);
    writeAtomically(PUBLIC_FILE, `${JSON.stringify(file, null, 2)}\n`);
    console.log(`\nWrote packages/web/public/replay/consistency.json${withAddresses ? '' : ', without addresses: a sampled wallet is not in the public replay'}.`);
  }
  console.log(`
NOT COVERED
  ${sample.length} wallets is a small sample, so every interval above is wide.
  The same facts asked on different days are not tested: every run here was asked within one session.
  Agreement is not correctness: a wallet given the same wrong answer five times agrees perfectly. The replay's answer
  keys and the control sample measure whether answers are right.
  Only the ROBO replay's wallets are sampled, and wallets whose outcome the code alone fixed are left out.`);
  return exitCode;
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
    // Library errors can quote the SERV URL, so only the error's class name is printed (threat model C40).
    console.error(`consistency stopped: ${error instanceof Error ? error.name : 'unknown error'}`);
    process.exitCode = 1;
  },
);

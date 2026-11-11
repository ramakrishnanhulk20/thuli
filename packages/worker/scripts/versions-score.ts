import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { AppealRecord, DEFAULT_SETTINGS, Facts, OutcomeSchema, Start } from '@thuli/core';
import { AnswerKeyError, loadFarmKey } from '../src/replay/answerKeys.ts';
import { KEYS_DIR, refuseNetwork, REPO_ROOT, UsageError, writeAtomically } from '../src/replay/cliSupport.ts';
import { DecisionRecord, STALE_ROWS } from '../src/replay/decide.ts';
import { STALE_DECISION } from '../src/replay/decisionScore.ts';
import {
  compareVersions,
  JUDGED_SOURCES,
  judgedActions,
  judgedKey,
  versionColumns,
  versionsToMarkdown,
  type VersionRecords,
} from '../src/replay/versions.ts';
import { isCalendarDate } from '../src/replay/webExport.ts';
import { FeedbackEntry } from '../src/reppo/feedback.ts';

// The largest replay file is about 40 MB; a file far past this is not our replay output (C41).
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const USAGE = 'Usage: npm run versions:score [-- --run-date YYYY-MM-DD], the day of scoring, today in UTC when left out';

/** The day of scoring. versions.json carries it, so the export publishes that day and never its own. */
function readRunDate(): string {
  let values: { 'run-date'?: string };
  try {
    values = parseArgs({ options: { 'run-date': { type: 'string' } }, strict: true, allowPositionals: false }).values;
  } catch {
    throw new UsageError(USAGE);
  }
  const runDate = values['run-date'] ?? new Date().toISOString().slice(0, 10);
  if (!isCalendarDate(runDate)) throw new UsageError('--run-date must be a calendar day written YYYY-MM-DD');
  return runDate;
}

const ROBO_DIR = path.join(REPO_ROOT, 'data', 'replay', 'robo');
const HOP_DIR = path.join(REPO_ROOT, 'data', 'replay', 'hop');
const FEEDBACK_DIR = path.join(REPO_ROOT, 'data', 'feedback');

const RowLine = z.strictObject({
  wallet: z.string().regex(/^0x[0-9a-f]{40}$/),
  start: Start,
  ceiling: OutcomeSchema,
  facts: Facts,
});

const JudgedLine = z.strictObject({
  key: z.string().regex(/^0x[0-9a-f]{40}$/),
  source: z.enum(JUDGED_SOURCES),
  record: DecisionRecord,
  row: RowLine,
});

// Read by hand, not through JsonlCache: its constructor can repair a file in place, and stored runs are read only. A bad
// line stops the run, because skipping it would quietly change every number in the table.
function readStored<T>(file: string, schema: z.ZodType<T>): T[] {
  const name = path.relative(REPO_ROOT, file);
  if (!fs.existsSync(file)) throw new UsageError(`${name}: that file does not exist`);
  if (fs.statSync(file).size > MAX_FILE_BYTES) throw new UsageError(`${name}: larger than ${MAX_FILE_BYTES} bytes`);
  const kept: T[] = [];
  fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((text, index) => {
      if (text === '') return;
      try {
        kept.push(schema.parse(JSON.parse(text)));
      } catch {
        throw new UsageError(`${name}, line ${index + 1}: not a stored record`);
      }
    });
  return kept;
}

/** The later line for a key wins, the same way a JsonlCache reload does. */
function readKeyed<T>(file: string, schema: z.ZodType<T>): T[] {
  const lines = readStored(file, z.object({ key: z.string(), value: schema }));
  return [...new Map(lines.map((line) => [line.key, line.value])).values()];
}

function saveDecisions(file: string, records: DecisionRecord[]): void {
  writeAtomically(file, records.map((record) => `${JSON.stringify({ key: record.wallet, value: record })}\n`).join(''));
}

function main(): void {
  const runDate = readRunDate();
  refuseNetwork();

  const roboRows = readStored(path.join(ROBO_DIR, 'rows.jsonl'), RowLine);
  const hopRows = readStored(path.join(HOP_DIR, 'rows.jsonl'), RowLine);
  const roboByWallet = new Map(roboRows.map((row) => [row.wallet, row]));
  const hopByWallet = new Map(hopRows.map((row) => [row.wallet, row]));

  const sampleFile = path.join(HOP_DIR, 'decisions-sample.jsonl');
  const eliminatedFile = path.join(HOP_DIR, 'decisions-eliminated.jsonl');
  const stored: VersionRecords = {
    robo: readKeyed(path.join(ROBO_DIR, 'decisions.jsonl'), DecisionRecord),
    hopSample: readKeyed(sampleFile, DecisionRecord),
    hopEliminated: readKeyed(eliminatedFile, DecisionRecord),
  };
  const { v1, v2, noReply } = versionColumns(stored, { robo: roboByWallet, hop: hopByWallet }, DEFAULT_SETTINGS);

  const entries = readKeyed(path.join(FEEDBACK_DIR, 'reppo.jsonl'), FeedbackEntry);
  const judged = readStored(path.join(FEEDBACK_DIR, 'judged.jsonl'), JudgedLine);
  // A judged reply missing from the file would quietly drop out of the feedback number, so every entry must have one.
  const judgedKeys = new Set(judged.map((line) => judgedKey(line.source === 'robo' ? 'robo' : 'hop', line.key)));
  if (entries.some((entry) => !judgedKeys.has(judgedKey(entry.set, entry.wallet)))) {
    throw new UsageError('data/feedback/judged.jsonl has no line for a wallet Reppo judged');
  }

  const comparison = compareVersions(v1, v2, {
    roboRows,
    key: loadFarmKey(path.join(KEYS_DIR, 'robo-farm-claim-wallets-reconstructed.csv')),
    entries,
    appeals: readKeyed(path.join(FEEDBACK_DIR, 'appeals.jsonl'), AppealRecord),
    listed: [...roboByWallet.keys(), ...hopByWallet.keys()],
    judged: { v1: judgedActions(judged, DEFAULT_SETTINGS, 1), v2: judgedActions(judged, DEFAULT_SETTINGS, 2) },
    noReply,
  });
  // decide:hop rewrites both sample files when it finishes, so the later of the two is the day the answers were asked.
  const hopAskedOn = new Date(Math.max(fs.statSync(sampleFile).mtimeMs, fs.statSync(eliminatedFile).mtimeMs)).toISOString().slice(0, 10);
  const report = versionsToMarkdown(comparison, { runDate, hopAskedOn });

  saveDecisions(path.join(ROBO_DIR, 'decisions-v2.jsonl'), v2.robo);
  saveDecisions(path.join(HOP_DIR, 'decisions-sample-v2.jsonl'), v2.hopSample);
  writeAtomically(path.join(FEEDBACK_DIR, 'versions.md'), report);
  writeAtomically(path.join(FEEDBACK_DIR, 'versions.json'), `${JSON.stringify({ runDate, ...comparison }, null, 2)}\n`);
  console.log(report);
}

try {
  main();
} catch (error) {
  if (error instanceof UsageError || (error instanceof Error && (error.message === STALE_ROWS || error.message === STALE_DECISION))) {
    console.error(error.message);
    process.exitCode = 2;
  } else if (error instanceof AnswerKeyError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    // Library errors can quote a URL, so only the error's class name is printed (threat model C40).
    console.error(`versions-score stopped: ${error instanceof Error ? error.name : 'unknown error'}`);
    process.exitCode = 1;
  }
}

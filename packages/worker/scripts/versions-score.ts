import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AppealRecord, DEFAULT_SETTINGS, Facts, OutcomeSchema, Start, type ReplayRow } from '@thuli/core';
import { AnswerKeyError, loadFarmKey } from '../src/replay/answerKeys.ts';
import { KEYS_DIR, refuseNetwork, REPO_ROOT, UsageError, writeAtomically } from '../src/replay/cliSupport.ts';
import { DecisionRecord, STALE_ROWS } from '../src/replay/decide.ts';
import { STALE_DECISION } from '../src/replay/decisionScore.ts';
import { asRulebookV2, compareVersions, versionsToMarkdown, type VersionRecords } from '../src/replay/versions.ts';
import { FeedbackEntry } from '../src/reppo/feedback.ts';

// The largest replay file is about 40 MB; a file far past this is not our replay output (C41).
const MAX_FILE_BYTES = 256 * 1024 * 1024;

const ROBO_DIR = path.join(REPO_ROOT, 'data', 'replay', 'robo');
const HOP_DIR = path.join(REPO_ROOT, 'data', 'replay', 'hop');
const FEEDBACK_DIR = path.join(REPO_ROOT, 'data', 'feedback');

const RowLine = z.strictObject({
  wallet: z.string().regex(/^0x[0-9a-f]{40}$/),
  start: Start,
  ceiling: OutcomeSchema,
  facts: Facts,
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

function replayed(records: DecisionRecord[], rows: Map<string, ReplayRow>): DecisionRecord[] {
  return records.map((record) => {
    const row = rows.get(record.wallet);
    if (row === undefined) throw new UsageError('a stored decision has no replay row, rerun the replay');
    return asRulebookV2(record, row, DEFAULT_SETTINGS);
  });
}

function saveDecisions(file: string, records: DecisionRecord[]): void {
  writeAtomically(file, records.map((record) => `${JSON.stringify({ key: record.wallet, value: record })}\n`).join(''));
}

function main(): void {
  refuseNetwork();

  const roboRows = readStored(path.join(ROBO_DIR, 'rows.jsonl'), RowLine);
  const hopRows = readStored(path.join(HOP_DIR, 'rows.jsonl'), RowLine);
  const roboByWallet = new Map(roboRows.map((row) => [row.wallet, row]));
  const hopByWallet = new Map(hopRows.map((row) => [row.wallet, row]));

  const v1: VersionRecords = {
    robo: readKeyed(path.join(ROBO_DIR, 'decisions.jsonl'), DecisionRecord),
    hopSample: readKeyed(path.join(HOP_DIR, 'decisions-sample.jsonl'), DecisionRecord),
    hopEliminated: readKeyed(path.join(HOP_DIR, 'decisions-eliminated.jsonl'), DecisionRecord),
  };
  const v2: VersionRecords = {
    robo: replayed(v1.robo, roboByWallet),
    hopSample: replayed(v1.hopSample, hopByWallet),
    hopEliminated: replayed(v1.hopEliminated, hopByWallet),
  };

  const comparison = compareVersions(v1, v2, {
    roboRows,
    key: loadFarmKey(path.join(KEYS_DIR, 'robo-farm-claim-wallets-reconstructed.csv')),
    entries: readKeyed(path.join(FEEDBACK_DIR, 'reppo.jsonl'), FeedbackEntry),
    appeals: readKeyed(path.join(FEEDBACK_DIR, 'appeals.jsonl'), AppealRecord),
    listed: [...roboByWallet.keys(), ...hopByWallet.keys()],
  });
  const report = versionsToMarkdown(comparison, { runDate: new Date().toISOString().slice(0, 10) });

  saveDecisions(path.join(ROBO_DIR, 'decisions-v2.jsonl'), v2.robo);
  saveDecisions(path.join(HOP_DIR, 'decisions-sample-v2.jsonl'), v2.hopSample);
  writeAtomically(path.join(FEEDBACK_DIR, 'versions.md'), report);
  writeAtomically(path.join(FEEDBACK_DIR, 'versions.json'), `${JSON.stringify(comparison, null, 2)}\n`);
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

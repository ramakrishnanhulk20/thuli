import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  AddressError,
  DEFAULT_SETTINGS,
  Facts,
  OutcomeSchema,
  parseAddress,
  ReppoPayloadError,
  reppoInput,
  Start,
  type ReplayRow,
} from '@thuli/core';
import { JsonlCache } from '../src/chain/jsonlCache.ts';
import { EnvError } from '../src/env.ts';
import { refuseNetwork, UsageError } from '../src/replay/cliSupport.ts';
import { DecisionRecord, STALE_ROWS } from '../src/replay/decide.ts';
import { evaluate, ReppoError, ReppoOutOfCredit, reppoConnectionFromEnv } from '../src/reppo/client.ts';
import { FeedbackEntry, feedbackItem, namesOtherVersion, runFeedback, type FeedbackItem } from '../src/reppo/feedback.ts';

const OUT_OF_CREDIT_EXIT = 3;
// A full account buys about 50 evaluations, so a list far past this is a mistake (C41).
const MAX_LIST_LINES = 1_000;
const MAX_LIST_BYTES = 1024 * 1024;
// The largest replay file is about 40 MB; a file far past this is not our replay output (C41).
const MAX_REPLAY_BYTES = 256 * 1024 * 1024;
const LABEL = /^[A-Za-z0-9._-]{1,64}$/;

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const REPLAY_DIR = path.join(REPO_ROOT, 'data', 'replay');
const DEFAULT_OUT = path.join(REPO_ROOT, 'data', 'feedback', 'reppo.jsonl');
const USAGE = 'Usage: npm run feedback:reppo -- --list FILE [--limit N] [--use-v2] [--rulebook NAME] [--out FILE] [--dry-run]';

const SETS = ['robo', 'hop'] as const;
type SetName = (typeof SETS)[number];

// Oldest first, so a later file's line for a wallet wins, the same way a JsonlCache reload does.
const DECISION_FILES: Record<SetName, readonly string[]> = {
  robo: ['decisions.jsonl'],
  hop: ['decisions-sample.jsonl', 'decisions-eliminated.jsonl'],
};

const RowLine = z.strictObject({
  wallet: z.string().regex(/^0x[0-9a-f]{40}$/),
  start: Start,
  ceiling: OutcomeSchema,
  facts: Facts,
});

const DecisionLine = z.object({ key: z.string(), value: DecisionRecord });

interface ListLine {
  wallet: string;
  set: SetName;
  group: string;
}

interface Arguments {
  listFile: string;
  limit: number | undefined;
  rulebook: string;
  useV2: boolean;
  outFile: string;
  dryRun: boolean;
}

function readArguments(): Arguments {
  let values: { list?: string; limit?: string; rulebook?: string; 'use-v2'?: boolean; out?: string; 'dry-run'?: boolean };
  try {
    values = parseArgs({
      options: {
        list: { type: 'string' },
        limit: { type: 'string' },
        rulebook: { type: 'string' },
        'use-v2': { type: 'boolean' },
        out: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw new UsageError(USAGE);
  }
  if (values.list === undefined) throw new UsageError(USAGE);
  const limitText = values.limit;
  if (limitText !== undefined && !/^[1-9][0-9]{0,6}$/.test(limitText)) throw new UsageError('--limit must be a whole number above 0');
  const useV2 = values['use-v2'] ?? false;
  const rulebook = values.rulebook ?? (useV2 ? 'v2' : 'v1');
  if (!LABEL.test(rulebook)) throw new UsageError('--rulebook must be letters, digits, dots, dashes or underscores');
  if (namesOtherVersion(rulebook, useV2)) throw new UsageError('--rulebook names a different version from the decisions being sent');
  return {
    listFile: path.resolve(values.list),
    limit: limitText === undefined ? undefined : Number(limitText),
    rulebook,
    useV2,
    outFile: values.out === undefined ? DEFAULT_OUT : path.resolve(values.out),
    dryRun: values['dry-run'] ?? false,
  };
}

function readCapped(file: string, maxBytes: number, label: string): string {
  if (!fs.existsSync(file)) throw new UsageError(`${label}: that file does not exist`);
  if (fs.statSync(file).size > maxBytes) throw new UsageError(`${label}: larger than ${maxBytes} bytes`);
  return fs.readFileSync(file, 'utf8');
}

/** Reads the chosen wallets. Any bad line stops the run here, before anything is sent. */
function loadList(file: string): ListLine[] {
  const text = readCapped(file, MAX_LIST_BYTES, '--list');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new UsageError('--list: that file has no wallets in it');
  if (lines.length > MAX_LIST_LINES) throw new UsageError(`--list: more than ${MAX_LIST_LINES} lines`);
  return lines.map((line, index) => {
    const [wallet, set, group, ...rest] = line.split(',').map((cell) => cell.trim());
    if (wallet === undefined || group === undefined || rest.length > 0 || !(SETS as readonly unknown[]).includes(set)) {
      throw new UsageError(`--list, line ${index + 1}: expected wallet,set,group with set robo or hop`);
    }
    if (!LABEL.test(group)) throw new UsageError(`--list, line ${index + 1}: group must be letters, digits, dots, dashes or underscores`);
    return { wallet: parseAddress(wallet).toLowerCase(), set: set as SetName, group };
  });
}

// Only the chosen wallets get the full schema check, so a 35,000 line file costs a JSON parse per line and little else.
function chosenLines(text: string, wanted: ReadonlySet<string>, keyOf: (json: unknown) => unknown): unknown[] {
  const chosen: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const key = keyOf(json);
    if (typeof key === 'string' && wanted.has(key)) chosen.push(json);
  }
  return chosen;
}

function loadRows(set: SetName, wanted: ReadonlySet<string>): Map<string, ReplayRow> {
  const rows = new Map<string, ReplayRow>();
  const text = readCapped(path.join(REPLAY_DIR, set, 'rows.jsonl'), MAX_REPLAY_BYTES, `${set} rows`);
  for (const json of chosenLines(text, wanted, (line) => (line as { wallet?: unknown } | null)?.wallet)) {
    const parsed = RowLine.safeParse(json);
    if (parsed.success) rows.set(parsed.data.wallet, parsed.data);
  }
  return rows;
}

// Read by hand, not through JsonlCache: its constructor can repair a file in place, and the replay output is read only.
function loadDecisions(set: SetName, wanted: ReadonlySet<string>): Map<string, DecisionRecord> {
  const decisions = new Map<string, DecisionRecord>();
  for (const name of DECISION_FILES[set]) {
    const text = readCapped(path.join(REPLAY_DIR, set, name), MAX_REPLAY_BYTES, `${set} decisions`);
    for (const json of chosenLines(text, wanted, (line) => (line as { key?: unknown } | null)?.key)) {
      const parsed = DecisionLine.safeParse(json);
      if (parsed.success) decisions.set(parsed.data.key, parsed.data.value);
    }
  }
  return decisions;
}

/**
 * Turns the list into checked items. A wallet with no row or no stored decision, or one whose decision came from older
 * rows, stops the run here, so a whole list is either sendable or nothing is sent.
 */
function buildItems(list: ListLine[], useV2: boolean): FeedbackItem[] {
  const items: FeedbackItem[] = [];
  for (const set of SETS) {
    const lines = list.filter((line) => line.set === set);
    if (lines.length === 0) continue;
    const wanted = new Set(lines.map((line) => line.wallet));
    const rows = loadRows(set, wanted);
    const decisions = loadDecisions(set, wanted);
    const refused = lines.filter((line) => !rows.has(line.wallet) || !decisions.has(line.wallet)).length;
    if (refused > 0) throw new UsageError(`--list: ${refused} ${set} wallets have no stored row or decision, so nothing was sent`);
    for (const line of lines) {
      const row = rows.get(line.wallet) as ReplayRow;
      const decision = decisions.get(line.wallet) as DecisionRecord;
      if (decision.start.outcome !== row.start.outcome || decision.start.rule !== row.start.rule) {
        throw new UsageError(`--list: a ${set} decision came from older rows, so nothing was sent`);
      }
      items.push(feedbackItem(line, row, decision, { useV2, settings: DEFAULT_SETTINGS }));
    }
  }
  return items;
}

function printPayloads(items: FeedbackItem[], limit: number | undefined): void {
  const chosen = items.slice(0, limit);
  chosen.forEach((item, index) => {
    console.log(`--- payload ${index + 1} of ${chosen.length}`);
    console.log(reppoInput(item.record, item.action, item.reason));
  });
  console.error(`dry run: ${chosen.length} payloads built, nothing sent`);
}

async function main(): Promise<number> {
  const args = readArguments();
  const items = buildItems(loadList(args.listFile), args.useV2);
  if (args.dryRun) {
    refuseNetwork();
    printPayloads(items, args.limit);
    return 0;
  }

  const connection = reppoConnectionFromEnv();
  const cache = new JsonlCache(args.outFile, FeedbackEntry);
  try {
    const run = await runFeedback(items, { evaluate: (input) => evaluate(input, connection) }, {
      rulebook: args.rulebook,
      limit: args.limit,
      cache,
      log: (line) => console.error(line),
    });
    console.error(
      `this run: ${run.sent} sent, ${run.disagreed} disagreed, ${run.failed} failed, ${run.skipped} already stored, ${run.creditsCharged} credits charged`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof ReppoOutOfCredit)) throw error;
    console.error('Reppo credit ran out. Finished wallets are saved, so top up and run this again to carry on.');
    return OUT_OF_CREDIT_EXIT;
  }
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
    if (error instanceof Error && error.message === STALE_ROWS) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    if (error instanceof ReppoError || error instanceof ReppoPayloadError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    // Library errors can quote the Reppo URL, so only the error's class name is printed (threat model C40).
    console.error(`feedback-reppo stopped: ${error instanceof Error ? error.name : 'unknown error'}`);
    process.exitCode = 1;
  },
);

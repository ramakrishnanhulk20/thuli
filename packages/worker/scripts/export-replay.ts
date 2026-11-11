import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  buildReplayFacts,
  CURRENT_RULEBOOK,
  DEFAULT_SETTINGS,
  Facts,
  OUTCOMES,
  OutcomeSchema,
  REPLAY_WALLET_LIMIT,
  replayGroupLabels,
  Start,
  traceFunding,
  type AccountState,
  type AddressData,
  type Outcome,
  type ReplayInput,
  type ReplayRow,
  type TransferPage,
} from '@thuli/core';
import type { ExplorerSource } from '../src/chain/explorer.ts';
import { JsonlCache } from '../src/chain/jsonlCache.ts';
import { AnswerKeyError, loadClaimEvents, loadFarmKey, loadHopLists } from '../src/replay/answerKeys.ts';
import { chainReaders, KEYS_DIR, REPO_ROOT, snapshotSeconds, UsageError, type ReplayArguments } from '../src/replay/cliSupport.ts';
import { DecisionRecord, STALE_ROWS } from '../src/replay/decide.ts';
import { STALE_DECISION } from '../src/replay/decisionScore.ts';
import { scoreHop } from '../src/replay/hopScore.ts';
import { runReplay, type ReplayDeps } from '../src/replay/runner.ts';
import { asRulebook } from '../src/replay/versions.ts';
import {
  buildWalletFiles,
  buildWebExport,
  buildWebHop,
  buildWebVersions,
  checkRulebookMoves,
  ExportCheckError,
  isCalendarDate,
  ROBO_CLAIM_CONTRACT,
  type RulebookMoves,
} from '../src/replay/webExport.ts';

// Both must match replay-robo.ts. The rows rebuilt here are checked byte for byte against rows.jsonl, so a drift stops
// the export instead of labelling groups from a different replay.
const SNAPSHOT_BLOCK = 24546232;
const HOP_LIMIT = 5;
// rows.jsonl is about 21 MB and decisions.jsonl about 40 MB; a file far past this is not our replay output (C41).
const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const NEWLINE = 0x0a;
// Only names this script writes: a wallet shard is two hex characters, a group file its index.
const SHARD_FILE = /^[0-9a-f]{2}\.json$/;
const GROUP_FILE = /^[0-9]+\.json$/;
const PARTIAL = '.partial';
// On Windows a rename onto a file the dev server or an editor has open fails until that handle closes.
export const RENAME_RETRIES = 5;
export const RENAME_PAUSE_MS = 200;

const ROBO_DIR = path.join(REPO_ROOT, 'data', 'replay', 'robo');
const ROWS_FILE = path.join(ROBO_DIR, 'rows.jsonl');
const DECISIONS_FILE = path.join(ROBO_DIR, 'decisions.jsonl');
const HOP_ROWS_FILE = path.join(REPO_ROOT, 'data', 'replay', 'hop', 'rows.jsonl');
const VERSIONS_FILE = path.join(REPO_ROOT, 'data', 'feedback', 'versions.json');
const CACHE_DIR = path.join(REPO_ROOT, 'data', 'cache', 'eth');
const DEFAULT_OUT = path.join(REPO_ROOT, 'packages', 'web', 'public', 'replay');
const USAGE = 'Usage: npm run export:replay -- --spent-cents N --run-date YYYY-MM-DD [--out DIR], where DIR holds robo/, versions.json and hop.json';

// The row schema and checks decide-robo.ts loads rows.jsonl with, so both scripts accept exactly the same rows.
const RowLine = z.strictObject({
  wallet: z.string().regex(/^0x[0-9a-f]{40}$/),
  start: Start,
  ceiling: OutcomeSchema,
  facts: Facts,
});

interface Arguments {
  spentCents: number;
  runDate: string;
  outDir: string;
}

function readArguments(): Arguments {
  let values: { 'spent-cents'?: string; 'run-date'?: string; out?: string };
  try {
    values = parseArgs({
      options: { 'spent-cents': { type: 'string' }, 'run-date': { type: 'string' }, out: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw new UsageError(USAGE);
  }
  const spentText = values['spent-cents'];
  const runDate = values['run-date'];
  if (spentText === undefined || runDate === undefined) throw new UsageError(USAGE);
  if (!/^(0|[1-9][0-9]{0,8})$/.test(spentText)) throw new UsageError('--spent-cents must be a whole number of cents');
  if (!isCalendarDate(runDate)) throw new UsageError('--run-date must be a calendar day written YYYY-MM-DD');
  return { spentCents: Number(spentText), runDate, outDir: values.out === undefined ? DEFAULT_OUT : path.resolve(values.out) };
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readInput(file: string, makeWith: string): Buffer {
  if (!fs.existsSync(file)) throw new ExportCheckError(`${path.relative(REPO_ROOT, file)} is missing. Run ${makeWith} first.`);
  if (fs.statSync(file).size > MAX_INPUT_BYTES) throw new ExportCheckError(`${path.relative(REPO_ROOT, file)} is larger than ${MAX_INPUT_BYTES} bytes`);
  return fs.readFileSync(file);
}

/** Parses a rows.jsonl from the bytes that were hashed, so the hash in summary.json is of exactly the rows exported. */
function parseRows(bytes: Buffer, name: string): ReplayRow[] {
  const seen = new Set<string>();
  const rows: ReplayRow[] = [];
  bytes
    .toString('utf8')
    .split(/\r?\n/)
    .forEach((text, index) => {
      if (text === '') return;
      let row: ReplayRow;
      try {
        row = RowLine.parse(JSON.parse(text));
      } catch {
        throw new ExportCheckError(`${name}, line ${index + 1}: not a replay row, rerun the replay`);
      }
      if (seen.has(row.wallet)) throw new ExportCheckError(`${name}, line ${index + 1}: this wallet is listed twice`);
      seen.add(row.wallet);
      rows.push(row);
    });
  return rows;
}

/**
 * Reruns the ROBO replay offline from the chain cache, as replay-robo.ts --offline does, while keeping every page and
 * state the runner was handed. The runner returns rows only, so the facts engine's input is put back together from
 * those reads: claim wallets' own pages, then funding hops, then, once account states are read, destination pages.
 * Traces are recomputed over the final pages, which is what the runner's last trace pass saw.
 */
async function rebuildOffline(wallets: string[]): Promise<{ rows: ReplayRow[]; input: ReplayInput }> {
  const args: ReplayArguments = { walletsFile: undefined, limit: undefined, perSecond: 1, cacheDir: CACHE_DIR, offline: true };
  const readers = chainReaders(args, undefined);
  const snapshotTime = await snapshotSeconds(SNAPSHOT_BLOCK, CACHE_DIR, undefined);

  const claimWallets = new Set(wallets);
  const data = new Map<string, AddressData>();
  const hopData = new Map<string, AddressData>();
  const destinationPages = new Map<string, TransferPage>();
  let states: Map<string, AccountState> | undefined;
  let statesAsked = false;

  const explorer: ExplorerSource = {
    async oldestTransfers(address, endBlock, limit) {
      const page = await readers.explorer.oldestTransfers(address, endBlock, limit);
      if (statesAsked) destinationPages.set(address, page);
      else if (claimWallets.has(address)) data.set(address, { external: page });
      else hopData.set(address, { external: page });
      return page;
    },
    async oldestInternalTransfers(address, endBlock, limit) {
      const page = await readers.explorer.oldestInternalTransfers(address, endBlock, limit);
      const walletData = data.get(address);
      if (walletData === undefined) throw new ExportCheckError('the replay read internal transfers for a wallet it had not read, so its input cannot be rebuilt');
      data.set(address, { ...walletData, internal: page });
      return page;
    },
  };
  const accounts: ReplayDeps['accounts'] = {
    async read(addresses, block) {
      if (statesAsked) throw new ExportCheckError('the replay read account states twice, so its input cannot be rebuilt');
      statesAsked = true;
      states = await readers.accounts.read(addresses, block);
      return states;
    },
  };

  const rows = await runReplay(
    wallets,
    { snapshotBlock: SNAPSHOT_BLOCK, snapshotTime, settings: DEFAULT_SETTINGS, walletLimit: REPLAY_WALLET_LIMIT, hopLimit: HOP_LIMIT },
    { explorer, accounts, log: (line) => console.error(line) },
  );
  if (states === undefined) throw new ExportCheckError('the replay never read account states, so its input cannot be rebuilt');
  const lookup = (address: string) => data.get(address) ?? hopData.get(address);
  const traces = new Map(wallets.map((wallet) => [wallet, traceFunding(wallet, lookup)]));
  return { rows, input: { wallets, snapshotTime, settings: DEFAULT_SETTINGS, data, traces, states, destinationPages } };
}

/** The files are public: points.json may hold no address at all, and summary.json none but the claim contract. */
function checkPublic(summaryText: string, pointsText: string): void {
  if (pointsText.includes('0x')) throw new ExportCheckError('points.json would hold a 0x value');
  for (const [hex] of summaryText.matchAll(/0x[0-9a-fA-F]+/g)) {
    if (hex !== ROBO_CLAIM_CONTRACT) throw new ExportCheckError('summary.json would hold a 0x value other than the claim contract');
  }
}

/**
 * The wallet and group files hold addresses and hashes on purpose. buildWalletFiles has checked every value already, and
 * this checks the very text to be written: no long dash and no trace of the model's raw reply (C13, C33).
 */
function checkWalletText(name: string, text: string): void {
  if (text.includes('\u2014')) throw new ExportCheckError(`${name} would hold a long dash`);
  if (text.includes('rawText')) throw new ExportCheckError(`${name} would hold the model's raw reply`);
}

/**
 * Deletes what a run with more groups left behind, so no stale file stays public. Only regular files with a name this
 * script writes are touched, and only those this run does not write again.
 */
function removeStale(dir: string, writing: Set<string>): number {
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (!entry.isFile() || !(SHARD_FILE.test(entry.name) || GROUP_FILE.test(entry.name)) || writing.has(file)) continue;
    fs.rmSync(file);
    removed += 1;
  }
  return removed;
}

/**
 * Deletes every regular file whose name ends in .partial anywhere under `dir`, and returns their paths. A write cut off
 * between writing and renaming leaves one behind, and the web app would serve it from the public folder. Links are
 * neither followed nor removed.
 */
export function sweepPartials(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const removed: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removed.push(...sweepPartials(file));
    } else if (entry.isFile() && entry.name.endsWith(PARTIAL)) {
      fs.rmSync(file);
      removed.push(file);
    }
  }
  return removed;
}

/**
 * Writes `text` to `file` through a .partial name and a rename, so a reader never sees half a file. A failed rename is
 * tried again up to RENAME_RETRIES times, RENAME_PAUSE_MS apart.
 *
 * @throws ExportCheckError naming the file when the last try fails. The .partial file stays for sweepPartials.
 */
export async function writePublic(file: string, text: string): Promise<void> {
  const partial = `${file}${PARTIAL}`;
  fs.writeFileSync(partial, text);
  for (let retry = 0; ; retry += 1) {
    try {
      fs.renameSync(partial, file);
      return;
    } catch {
      if (retry === RENAME_RETRIES) {
        throw new ExportCheckError(`could not replace ${path.relative(REPO_ROOT, file)} after ${RENAME_RETRIES} retries; close whatever holds it open and run again`);
      }
      await pause(RENAME_PAUSE_MS);
    }
  }
}

function outcomeTable(moves: RulebookMoves, count: (value: number) => string): string[] {
  const held = (outcomes: Record<Outcome, number>) => outcomes.hold + outcomes.exclude;
  const line = (name: string, stored: number, exported: number) => `  ${name.padEnd(22)}${count(stored).padStart(8)}${count(exported).padStart(12)}`;
  return [
    `rulebook ${CURRENT_RULEBOOK}: ${count(moves.toStart + moves.heldByChecks)} wallets moved from the stored outcome`,
    `  put back at the start, a shared funder the only evidence (C47): ${count(moves.toStart)}`,
    `  held, today's checks refuse the stored reply (C11, C13): ${count(moves.heldByChecks)}`,
    `  ${'outcome'.padEnd(22)}${'stored'.padStart(8)}${`rulebook ${CURRENT_RULEBOOK}`.padStart(12)}`,
    ...OUTCOMES.map((name) => line(name, moves.stored[name], moves.exported[name])),
    line('held (hold + exclude)', held(moves.stored), held(moves.exported)),
  ];
}

function readVersions(): unknown {
  try {
    return JSON.parse(readInput(VERSIONS_FILE, 'npm run versions:score').toString('utf8'));
  } catch (error) {
    if (error instanceof ExportCheckError) throw error;
    throw new ExportCheckError('data/feedback/versions.json is not JSON, rerun npm run versions:score');
  }
}

async function main(): Promise<number> {
  const args = readArguments();
  const rowsBytes = readInput(ROWS_FILE, 'npm run replay:robo and npm run decide:robo');
  const rowsSha256 = sha256(rowsBytes);
  const rows = parseRows(rowsBytes, 'robo rows.jsonl');
  const decisionsBytes = readInput(DECISIONS_FILE, 'npm run decide:robo');
  const decisionsSha256 = sha256(decisionsBytes);
  // The cache would append a newline to a file that ends mid-line, and data/ is never written by this script.
  if (decisionsBytes.length > 0 && decisionsBytes[decisionsBytes.length - 1] !== NEWLINE) {
    throw new ExportCheckError('decisions.jsonl ends mid-line, so a decide run may still be writing it');
  }
  const cache = new JsonlCache(DECISIONS_FILE, DecisionRecord);
  // The site shows the product as it decides today: each stored reply checked again under the current rulebook, no
  // model called. Everything counted or written below uses these records.
  const stored = new Map<string, DecisionRecord>();
  const records = new Map<string, DecisionRecord>();
  for (const row of rows) {
    const record = cache.get(row.wallet);
    if (record === undefined) continue;
    stored.set(row.wallet, record);
    records.set(row.wallet, asRulebook(record, row, DEFAULT_SETTINGS, CURRENT_RULEBOOK));
  }
  const moves = checkRulebookMoves(rows, stored, records);

  const events = loadClaimEvents(path.join(KEYS_DIR, 'robo-claim-events.csv'));
  const key = loadFarmKey(path.join(KEYS_DIR, 'robo-farm-claim-wallets-reconstructed.csv'));
  const claimWallets = [...new Set(events.map((event) => event.recipient))];

  console.error(`rebuilding the replay of ${claimWallets.length.toLocaleString('en-US')} ROBO claim wallets offline, for the group labels`);
  const rebuilt = await rebuildOffline(claimWallets);
  if (sha256(rebuilt.rows.map((row) => `${JSON.stringify(row)}\n`).join('')) !== rowsSha256) {
    throw new ExportCheckError('the rows rebuilt offline differ from rows.jsonl, so their group labels would describe other rows');
  }
  const facts = buildReplayFacts(rebuilt.input);
  rebuilt.rows.forEach((row, index) => {
    if (JSON.stringify(facts.get(row.wallet)) !== JSON.stringify(row.facts)) {
      throw new ExportCheckError(`row ${index + 1}: the rebuilt facts engine input gives other facts than the replay did`);
    }
  });
  const groupLabels = replayGroupLabels(rebuilt.input);

  const input = {
    rows,
    records,
    claims: events,
    farmKey: key,
    groupLabels,
    meta: { runDate: args.runDate, spentCents: args.spentCents, rowsSha256, decisionsSha256, rulebook: CURRENT_RULEBOOK },
  };
  const { summary, points } = buildWebExport(input);
  const { shards, groups } = buildWalletFiles(input);
  if (sha256(fs.readFileSync(ROWS_FILE)) !== rowsSha256 || sha256(fs.readFileSync(DECISIONS_FILE)) !== decisionsSha256) {
    throw new ExportCheckError('rows.jsonl or decisions.jsonl changed while the export ran, so its hashes would be wrong');
  }

  // Scored offline the way replay-hop.ts scores its rows for report.md, so both show the same Hop numbers.
  const hopRows = parseRows(readInput(HOP_ROWS_FILE, 'npm run replay:hop'), 'hop rows.jsonl');
  const hop = buildWebHop(scoreHop(hopRows, loadHopLists(KEYS_DIR), DEFAULT_SETTINGS), args.runDate);
  const versions = buildWebVersions(readVersions(), args.runDate);

  const roboDir = path.join(args.outDir, 'robo');
  const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
  const pointsText = `${JSON.stringify(points)}\n`;
  checkPublic(summaryText, pointsText);
  const outFile = (folder: string, name: string, value: unknown) => {
    const text = `${JSON.stringify(value)}\n`;
    return { file: path.join(roboDir, folder, `${name}.json`), text, bytes: Buffer.byteLength(text) };
  };
  const shardFiles = [...shards].map(([name, shard]) => outFile('wallets', name, shard));
  const groupFiles = groups.map((group) => outFile('groups', String(group.index), group));
  const walletFiles = [...shardFiles, ...groupFiles];
  for (const { file, text } of walletFiles) checkWalletText(path.relative(roboDir, file), text);

  const summaryFile = path.join(roboDir, 'summary.json');
  const pointsFile = path.join(roboDir, 'points.json');
  const hopFile = path.join(args.outDir, 'hop.json');
  const versionsFile = path.join(args.outDir, 'versions.json');
  const writing = new Set(walletFiles.map((entry) => entry.file));
  const removed = removeStale(path.join(roboDir, 'wallets'), writing) + removeStale(path.join(roboDir, 'groups'), writing);
  fs.mkdirSync(path.join(roboDir, 'wallets'), { recursive: true });
  fs.mkdirSync(path.join(roboDir, 'groups'), { recursive: true });
  let swept = sweepPartials(args.outDir).length;
  try {
    await writePublic(summaryFile, summaryText);
    await writePublic(pointsFile, pointsText);
    for (const { file, text } of walletFiles) await writePublic(file, text);
    await writePublic(hopFile, hop.text);
    await writePublic(versionsFile, versions.text);
  } finally {
    swept += sweepPartials(args.outDir).length;
  }

  const count = (value: number) => value.toLocaleString('en-US');
  const cohortLine = (name: string, cohort: typeof hop.value.probablyReal) =>
    `hop ${name}: counted ${count(cohort.counted)}, held ${count(cohort.held)} (95% interval ${(cohort.heldLow * 100).toFixed(2)}% to ${(cohort.heldHigh * 100).toFixed(2)}%), excluded ${count(cohort.excluded)}`;
  const biggest = (entries: typeof walletFiles) => {
    const most = entries.reduce<(typeof walletFiles)[number] | undefined>((top, entry) => (top === undefined || entry.bytes > top.bytes ? entry : top), undefined);
    return most === undefined ? 'none' : `${path.relative(REPO_ROOT, most.file)} (${count(most.bytes)} bytes)`;
  };
  const walletBytes = walletFiles.reduce((sum, entry) => sum + entry.bytes, 0);
  const { farmKey, usd, outcomes, run } = summary;
  const largest = summary.groups[0]?.size ?? 0;
  console.log(
    [
      ...outcomeTable(moves, count),
      `wallets ${count(summary.wallets)}, from ${count(summary.claims)} claim events`,
      `farm key held ${count(farmKey.held)} of ${count(farmKey.wallets)}`,
      `families ${count(farmKey.families.total)} total, ${count(farmKey.families.touched)} touched, ${count(farmKey.families.fullyHeld)} fully held`,
      `kept from the key $${count(usd.keptKey)} of $${count(usd.claimedKey)}`,
      `kept from others $${count(usd.keptOther)} of $${count(usd.claimedOther)}`,
      `others full ${count(outcomes.other.full)}, partial ${count(outcomes.other.partial)}, hold ${count(outcomes.other.hold)}, exclude ${count(outcomes.other.exclude)}`,
      `the key claimed ${count(farmKey.shareOfDropBps)} bps of the drop`,
      `groups ${count(summary.groups.length)}, largest ${count(largest)} wallets`,
      `spent $${(run.spentCents / 100).toFixed(2)}, ${run.centsPerWallet.toFixed(3)} cents per wallet`,
      `wrote ${path.relative(REPO_ROOT, summaryFile)} (${count(Buffer.byteLength(summaryText))} bytes)`,
      `wrote ${path.relative(REPO_ROOT, pointsFile)} (${count(Buffer.byteLength(pointsText))} bytes)`,
      `wrote ${count(walletFiles.length)} wallet and group files, ${count(shardFiles.length)} shards and ${count(groupFiles.length)} groups, ${count(walletBytes)} bytes in all`,
      `largest shard ${biggest(shardFiles)}`,
      `largest group file ${biggest(groupFiles)}`,
      `removed ${count(removed)} stale wallet and group files`,
      `removed ${count(swept)} leftover .partial files`,
      cohortLine('probably real', hop.value.probablyReal),
      cohortLine('eliminated', hop.value.eliminated),
      `hop clusters ${count(hop.value.clusters.total)} total, ${count(hop.value.clusters.touched)} touched, ${count(hop.value.clusters.fullyHeld)} fully held, ${count(hop.value.clusters.uncounted)} with none counted`,
      `wrote ${path.relative(REPO_ROOT, hopFile)} (${count(Buffer.byteLength(hop.text))} bytes)`,
      `wrote ${path.relative(REPO_ROOT, versionsFile)} (${count(Buffer.byteLength(versions.text))} bytes)`,
    ].join('\n'),
  );
  return 0;
}

// Only as the entry script, so a test can import sweepPartials and writePublic without starting an export.
if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      if (error instanceof UsageError) {
        console.error(error.message);
        process.exitCode = 2;
        return;
      }
      const ownCheck =
        error instanceof ExportCheckError ||
        error instanceof AnswerKeyError ||
        error instanceof RangeError ||
        (error instanceof Error && (error.message === STALE_DECISION || error.message === STALE_ROWS));
      // Anything else could be a library error, so only its class name is printed (threat model C40).
      console.error(ownCheck ? `export-replay refused: ${(error as Error).message}` : `export-replay stopped: ${error instanceof Error ? error.name : 'unknown error'}`);
      process.exitCode = 1;
    },
  );
}

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseAddress, type FarmKeyEntry } from '@thuli/core';

// The ROBO claim list is about 9 MB; a file far past this is not one of our answer keys (C41).
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export class AnswerKeyError extends Error {
  override name = 'AnswerKeyError';
}

export interface ClaimEvent {
  recipient: string;
  account: string;
  amountWei: bigint;
  block: number;
}

export interface HopLists {
  /** Every wallet Hop left on its final list, in file order. */
  eligible: string[];
  /** Every wallet Hop removed as a sybil, in file order. */
  eliminated: string[];
  /** Eligible wallets no group ever named: the probably-real pool. */
  negatives: Set<string>;
  /** Eligible wallets a group named but Hop kept anyway. */
  keptInGroups: Set<string>;
  /** Each eliminated wallet's cluster id. */
  clusters: Map<string, string>;
}

interface KeyRow {
  line: number;
  fields: Record<string, string>;
}

// Answer-key addresses go through the one address parser (C1), then lowercase, the form the replay compares in.
const KeyAddress = z.string().transform((value, ctx) => {
  try {
    return parseAddress(value).toLowerCase();
  } catch {
    ctx.issues.push({ code: 'custom', message: 'not a 0x address of 40 hex characters', input: value });
    return z.NEVER;
  }
});
// A uint256 has at most 78 decimal digits.
const Wei = z.string().regex(/^[0-9]{1,78}$/, 'not whole wei in decimal digits').transform(BigInt);
const Whole = z.string().regex(/^(0|[1-9][0-9]{0,14})$/, 'not a whole number').transform(Number);

const ClaimRow = z.object({ recipient: KeyAddress, account: KeyAddress, amount_wei: Wei, block_number: Whole });
const AddressRow = z.object({ address: KeyAddress });
const ClusterRow = z.object({ address: KeyAddress, cluster_id: z.string().min(1, 'is blank') });
const FarmRow = z.object({
  claim_wallet: KeyAddress,
  collector: KeyAddress,
  family_n: z.string().regex(/^[1-9][0-9]{0,8}$/, 'not a family number').transform(Number),
  funding_wallet: z.union([z.literal('').transform(() => null), KeyAddress]),
});

// Any hex run in hop-groups.json must be an address, so a damaged one stops the load instead of being skipped.
const HEX_RUN = /0x[0-9a-fA-F]+/g;

// Every answer-key file is read here, so none escapes the size cap (C41).
function readKeyFile(file: string): string {
  if (fs.statSync(file).size > MAX_FILE_BYTES) throw new AnswerKeyError(`${file}: larger than ${MAX_FILE_BYTES} bytes`);
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function readKeyLines(file: string): string[] {
  const lines = readKeyFile(file).split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Reads a CSV whose first line names the columns and returns each later line as a column-to-text record, with its
 * line number. A plain comma split, because these files never quote a field.
 *
 * @throws AnswerKeyError naming the file and line for a missing column, a short or long row, or a blank line.
 */
function readCsv(file: string, required: readonly string[]): KeyRow[] {
  const lines = readKeyLines(file);
  const header = (lines[0] ?? '').split(',');
  for (const name of required) {
    if (!header.includes(name)) throw new AnswerKeyError(`${file}, line 1: no ${name} column`);
  }
  return lines.slice(1).map((text, index) => {
    const line = index + 2;
    const cells = text.split(',');
    if (cells.length !== header.length) {
      throw new AnswerKeyError(`${file}, line ${line}: ${cells.length} fields where the header has ${header.length}`);
    }
    return { line, fields: Object.fromEntries(header.map((name, i) => [name, cells[i] as string])) };
  });
}

function parseRow<T>(schema: z.ZodType<T>, file: string, row: KeyRow): T {
  const parsed = schema.safeParse(row.fields);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new AnswerKeyError(`${file}, line ${row.line}: ${String(issue?.path[0] ?? 'row')} ${issue?.message ?? 'is not valid'}`);
}

/**
 * Every claim in robo-claim-events.csv, in file order. Columns: block_number, block_time_utc, tx_hash, log_index,
 * account, recipient, amount_wei, amount_robo. Addresses come back lowercase.
 *
 * @throws AnswerKeyError naming the file and line of the first bad row.
 */
export function loadClaimEvents(file: string): ClaimEvent[] {
  return readCsv(file, ['block_number', 'account', 'recipient', 'amount_wei']).map((row) => {
    const parsed = parseRow(ClaimRow, file, row);
    return { recipient: parsed.recipient, account: parsed.account, amountWei: parsed.amount_wei, block: parsed.block_number };
  });
}

/**
 * Bitquery's farm families rebuilt per claim wallet, from robo-farm-claim-wallets-reconstructed.csv, keyed by the
 * lowercase claim wallet. A blank funding_wallet (a collector-only family) becomes null.
 *
 * @throws AnswerKeyError naming the file and line of the first bad row, or of a claim wallet listed twice.
 */
export function loadFarmKey(file: string): Map<string, FarmKeyEntry> {
  const key = new Map<string, FarmKeyEntry>();
  for (const row of readCsv(file, ['claim_wallet', 'collector', 'family_n', 'funding_wallet'])) {
    const parsed = parseRow(FarmRow, file, row);
    // Two rows for one wallet could name two families, and the score cannot tell which one Bitquery meant.
    if (key.has(parsed.claim_wallet)) throw new AnswerKeyError(`${file}, line ${row.line}: claim_wallet listed twice`);
    key.set(parsed.claim_wallet, { collector: parsed.collector, family: parsed.family_n, fundingWallet: parsed.funding_wallet });
  }
  return key;
}

function uniqueAddresses(file: string, rows: KeyRow[], eligible: Set<string>): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const { address } = parseRow(AddressRow, file, row);
    if (seen.has(address)) throw new AnswerKeyError(`${file}, line ${row.line}: address listed twice`);
    // A wallet on both lists would count as both a real user and a sybil.
    if (eligible.has(address)) throw new AnswerKeyError(`${file}, line ${row.line}: address is on both the eligible and the eliminated list`);
    seen.add(address);
  }
  if (seen.size === 0) throw new AnswerKeyError(`${file}: no addresses`);
  return [...seen];
}

/** Every address anywhere in hop-groups.json: a value, a key, or inside a piece of text. */
function addressesInGroups(file: string): Set<string> {
  const text = readKeyFile(file);
  let groups: unknown;
  try {
    groups = JSON.parse(text);
  } catch {
    throw new AnswerKeyError(`${file}: not valid JSON`);
  }
  const found = new Set<string>();
  const collect = (value: string) => {
    for (const [hex] of value.matchAll(HEX_RUN)) {
      const parsed = KeyAddress.safeParse(hex);
      if (!parsed.success) throw new AnswerKeyError(`${file}: holds a 0x value that is not an address`);
      found.add(parsed.data);
    }
  };
  const walk = (value: unknown): void => {
    if (typeof value === 'string') collect(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) {
      for (const [name, inner] of Object.entries(value)) {
        collect(name);
        walk(inner);
      }
    }
  };
  walk(groups);
  // With no groups every eligible wallet would pass as probably real, so an empty file must not load.
  if (found.size === 0) throw new AnswerKeyError(`${file}: names no addresses`);
  return found;
}

/**
 * Hop's airdrop lists from dir: hop-eligibleAddresses.txt, hop-eliminatedSybilAttackers.csv,
 * hop-eliminated-cluster-map.csv and hop-groups.json. Addresses come back lowercase.
 *
 * @throws AnswerKeyError naming the file, and the line where a file has lines, for a bad or repeated address, an
 * address on both lists, a cluster wallet Hop did not eliminate, or a file that is empty, too large or not JSON.
 */
export function loadHopLists(dir: string): HopLists {
  const eligibleFile = path.join(dir, 'hop-eligibleAddresses.txt');
  const eliminatedFile = path.join(dir, 'hop-eliminatedSybilAttackers.csv');
  const clusterFile = path.join(dir, 'hop-eliminated-cluster-map.csv');

  const eligibleRows = readKeyLines(eligibleFile).map((text, index): KeyRow => ({ line: index + 1, fields: { address: text } }));
  const eligible = uniqueAddresses(eligibleFile, eligibleRows, new Set());
  const eliminated = uniqueAddresses(eliminatedFile, readCsv(eliminatedFile, ['address']), new Set(eligible));

  const isEliminated = new Set(eliminated);
  const clusters = new Map<string, string>();
  for (const row of readCsv(clusterFile, ['address', 'cluster_id', 'cluster_size'])) {
    const { address, cluster_id: cluster } = parseRow(ClusterRow, clusterFile, row);
    if (clusters.has(address)) throw new AnswerKeyError(`${clusterFile}, line ${row.line}: address listed twice`);
    if (!isEliminated.has(address)) throw new AnswerKeyError(`${clusterFile}, line ${row.line}: address is not on the eliminated list`);
    clusters.set(address, cluster);
  }

  const inGroup = addressesInGroups(path.join(dir, 'hop-groups.json'));
  const negatives = new Set<string>();
  const keptInGroups = new Set<string>();
  for (const wallet of eligible) (inGroup.has(wallet) ? keptInGroups : negatives).add(wallet);
  return { eligible, eliminated, negatives, keptInGroups, clusters };
}

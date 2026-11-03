import fs from 'node:fs';
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
const FarmRow = z.object({
  claim_wallet: KeyAddress,
  collector: KeyAddress,
  family_n: z.string().regex(/^[1-9][0-9]{0,8}$/, 'not a family number').transform(Number),
  funding_wallet: z.union([z.literal('').transform(() => null), KeyAddress]),
});

/**
 * Reads a CSV whose first line names the columns and returns each later line as a column-to-text record, with its
 * line number. A plain comma split, because these files never quote a field.
 *
 * @throws AnswerKeyError naming the file and line for a missing column, a short or long row, or a blank line.
 */
function readCsv(file: string, required: readonly string[]): { line: number; fields: Record<string, string> }[] {
  if (fs.statSync(file).size > MAX_FILE_BYTES) throw new AnswerKeyError(`${file}: larger than ${MAX_FILE_BYTES} bytes`);
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
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

function parseRow<T>(schema: z.ZodType<T>, file: string, row: { line: number; fields: Record<string, string> }): T {
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

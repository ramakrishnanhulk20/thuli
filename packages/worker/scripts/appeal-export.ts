// Writes one campaign's checked appeals, with Reppo's whole verdict, as input for the next rulebook change:
//
//   npm run appeal:export -- --id CAMPAIGN [--file PATH] [--write]
//
// One line per checked appeal, in this export's own strict shape (AppealExportLine), appended to
// data/feedback/campaign-appeals.jsonl unless --file names another; an evaluation id already in the file is skipped.
// Without --write it only says how many lines it would add. The scorecard does not read this file and does not score
// appeals yet. No line holds an appeal's text, its hash, its signature or the owner's note (C34, C40). Each line does hold
// the ask's stored record, which keeps the evidence transaction hashes that were never sent to Reppo, so the file is
// private data: it lives under data/, which git ignores. Reads DATABASE_URL and nothing else, and loads no private key.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CAMPAIGN_ID } from '@thuli/core';
import { connectPostgres, StoreError } from '@thuli/store';
import { exportAppeals } from '../src/campaign/appeals.ts';
import { scrubber } from '../src/campaign/config.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEFAULT_FILE = path.join(REPO_ROOT, 'data', 'feedback', 'campaign-appeals.jsonl');
const USAGE = 'Usage: npm run appeal:export -- --id CAMPAIGN [--file PATH] [--write]';
const POSTGRES_URL = /^postgres(ql)?:\/\/\S+$/;

class Refused extends Error {
  override name = 'Refused';
}

// Replaced once DATABASE_URL is read, so a message quoting it or its password is blanked (C40).
let clean = (line: string) => line;

async function main(): Promise<number> {
  let values: { id?: string; file?: string; write?: boolean };
  try {
    values = parseArgs({
      options: { id: { type: 'string' }, file: { type: 'string' }, write: { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw new Refused(USAGE);
  }
  if (values.id === undefined) throw new Refused(USAGE);
  if (!CAMPAIGN_ID.test(values.id)) throw new Refused('--id must be the campaign id: letters, digits, dots, dashes or underscores');
  if (values.file !== undefined && values.file.trim() === '') throw new Refused('--file must name a file');
  const file = values.file === undefined ? DEFAULT_FILE : path.resolve(values.file);
  const databaseUrl = (process.env.DATABASE_URL ?? '').trim();
  if (!POSTGRES_URL.test(databaseUrl)) throw new Refused('DATABASE_URL must be a postgres:// or postgresql:// URL');
  const secrets = [databaseUrl];
  try {
    secrets.push(decodeURIComponent(new URL(databaseUrl).password));
  } catch {
    // connectPostgres refuses a URL it cannot read, before any line could quote it.
  }
  clean = scrubber(secrets);

  const db = connectPostgres(databaseUrl);
  try {
    const result = await exportAppeals(db, values.id, file, values.write === true);
    for (const line of result.lines) console.log(clean(line));
    return result.ok ? 0 : 1;
  } finally {
    await db.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const known = error instanceof Refused || error instanceof StoreError;
    console.error(clean(`appeal:export refused: ${known ? (error as Error).message : error instanceof Error ? error.name : 'unknown error'}`));
    process.exitCode = known ? 2 : 1;
  },
);

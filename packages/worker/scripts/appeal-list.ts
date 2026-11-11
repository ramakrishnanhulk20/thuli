// Lists one campaign's appeals for the operator who settles them:
//
//   npm run appeal:list -- --id CAMPAIGN
//
// One block per appeal: the wallet, the ask's action and rule, the appeal's own text, the outside check and the outcome.
// This is the only place an appeal's text is shown, and it goes to this terminal only; no page or log carries it (C40).
// The text, the owner's note and Reppo's words are each printed as one quoted JSON string after a fixed label, so none
// of them can pass for a line of this command's own (C34).
// Reads DATABASE_URL and nothing else, changes nothing, and loads no private key.
import { parseArgs } from 'node:util';
import { CAMPAIGN_ID } from '@thuli/core';
import { connectPostgres, StoreError } from '@thuli/store';
import { appealListLines } from '../src/campaign/appeals.ts';
import { scrubber } from '../src/campaign/config.ts';

const USAGE = 'Usage: npm run appeal:list -- --id CAMPAIGN';
const POSTGRES_URL = /^postgres(ql)?:\/\/\S+$/;

class Refused extends Error {
  override name = 'Refused';
}

// Replaced once DATABASE_URL is read, so a message quoting it or its password is blanked (C40).
let clean = (line: string) => line;

async function main(): Promise<number> {
  let values: { id?: string };
  try {
    values = parseArgs({ options: { id: { type: 'string' } }, strict: true, allowPositionals: false }).values;
  } catch {
    throw new Refused(USAGE);
  }
  if (values.id === undefined) throw new Refused(USAGE);
  if (!CAMPAIGN_ID.test(values.id)) throw new Refused('--id must be the campaign id: letters, digits, dots, dashes or underscores');
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
    const result = await appealListLines(db, values.id);
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
    console.error(clean(`appeal:list refused: ${known ? (error as Error).message : error instanceof Error ? error.name : 'unknown error'}`));
    process.exitCode = known ? 2 : 1;
  },
);

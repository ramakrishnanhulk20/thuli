// Settles one appeal on the campaign owner's word, the only way an appeal changes a decision:
//
//   npm run appeal:settle -- --id CAMPAIGN --wallet ADDRESS --outcome reversed|upheld [--action full|partial]
//                            [--note "..."] [--write]
//
// Without --write it prints the appeal and the store's own answer to it, written nowhere: the cause it would be refused
// with, or what it would be settled as and the slot it would hold. With --write a reversal makes the ask the chosen
// approval and gives it the next free slot, which the worker's publish step then lists and pays; upheld changes nothing
// but the appeal. The outside check is advice and does not decide it (C11). Reads DATABASE_URL and nothing else, and
// loads no private key.
import { parseArgs } from 'node:util';
import { AddressError } from '@thuli/core';
import { connectPostgres, StoreError } from '@thuli/store';
import { parseSettleArgs, settleAppealCommand } from '../src/campaign/appeals.ts';
import { scrubber } from '../src/campaign/config.ts';

const USAGE =
  'Usage: npm run appeal:settle -- --id CAMPAIGN --wallet ADDRESS --outcome reversed|upheld [--action full|partial] [--note "..."] [--write]';
const POSTGRES_URL = /^postgres(ql)?:\/\/\S+$/;

class Refused extends Error {
  override name = 'Refused';
}

// Replaced once DATABASE_URL is read, so a message quoting it or its password is blanked (C40).
let clean = (line: string) => line;

async function main(): Promise<number> {
  let values: { id?: string; wallet?: string; outcome?: string; action?: string; note?: string; write?: boolean };
  try {
    values = parseArgs({
      options: {
        id: { type: 'string' },
        wallet: { type: 'string' },
        outcome: { type: 'string' },
        action: { type: 'string' },
        note: { type: 'string' },
        write: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw new Refused(USAGE);
  }
  const parsed = parseSettleArgs(values);
  if (!parsed.ok) throw new Refused(`${parsed.cause}\n${USAGE}`);
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
    const result = await settleAppealCommand(db, parsed.value, values.write === true, new Date());
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
    const known = error instanceof Refused || error instanceof AddressError || error instanceof StoreError;
    console.error(clean(`appeal:settle refused: ${known ? (error as Error).message : error instanceof Error ? error.name : 'unknown error'}`));
    process.exitCode = known ? 2 : 1;
  },
);

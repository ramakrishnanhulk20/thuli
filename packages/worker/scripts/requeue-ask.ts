// Puts one failed ask back in the queue once an outage is over, so the worker screens it again from the start:
//
//   npm run campaign:requeue -- --id CAMPAIGN --wallet ADDRESS [--write]
//
// It prints the ask's status and rule. Without --write it only says what it would do. Only a failed ask moves; any
// other is refused and left as it is. Reads DATABASE_URL and nothing else: no private key is loaded (C39).
import { parseArgs } from 'node:util';
import { AddressError } from '@thuli/core';
import { connectPostgres, StoreError } from '@thuli/store';
import { scrubber } from '../src/campaign/config.ts';
import { requeueAsk } from '../src/campaign/register.ts';

const USAGE = 'Usage: npm run campaign:requeue -- --id CAMPAIGN --wallet ADDRESS [--write]';
const POSTGRES_URL = /^postgres(ql)?:\/\/\S+$/;

class Refused extends Error {
  override name = 'Refused';
}

// Replaced once DATABASE_URL is read, so a message quoting it or its password is blanked (C40).
let clean = (line: string) => line;

async function main(): Promise<number> {
  let values: { id?: string; wallet?: string; write?: boolean };
  try {
    values = parseArgs({
      options: { id: { type: 'string' }, wallet: { type: 'string' }, write: { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw new Refused(USAGE);
  }
  if (values.id === undefined || values.wallet === undefined) throw new Refused(USAGE);
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
    const result = await requeueAsk(db, values.id, values.wallet, values.write === true, new Date());
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
    console.error(clean(`campaign:requeue refused: ${known ? (error as Error).message : error instanceof Error ? error.name : 'unknown error'}`));
    process.exitCode = known ? 2 : 1;
  },
);

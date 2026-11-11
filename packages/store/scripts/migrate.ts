// Brings the Postgres at DATABASE_URL up to date with packages/store/migrations: npm run db:migrate
// Safe to run again and from two places at once; a file already applied is never run twice.
import { connectPostgres, migrate, StoreError, type Db } from '../src/index.ts';

class SetupError extends Error {
  override name = 'SetupError';
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim() ?? '';
  if (url === '') throw new SetupError('DATABASE_URL is not set. Put a postgres:// connection string in .env.');
  let db: Db;
  try {
    db = connectPostgres(url, { max: 1 });
  } catch (error) {
    if (error instanceof StoreError) {
      throw new SetupError('DATABASE_URL is not a postgres:// or postgresql:// connection string.');
    }
    throw error;
  }
  try {
    const { applied, alreadyApplied } = await migrate(db);
    console.log(`Applied ${applied.length === 0 ? 'nothing new' : applied.join(', ')}.`);
    console.log(`Already applied before this run: ${alreadyApplied.length === 0 ? 'none' : alreadyApplied.join(', ')}.`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof SetupError) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  // StoreError messages never hold the URL or its password (C40); anything else may quote it, so only its kind is shown.
  console.error(`db:migrate stopped: ${error instanceof StoreError ? error.message : error instanceof Error ? error.name : 'unknown error'}`);
  process.exitCode = 1;
});

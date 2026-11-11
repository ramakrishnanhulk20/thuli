import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoreError, withSession, type Db } from './db.ts';

// Worked out when migrate runs, from this file's own path. A bundler reads a URL literal built on import.meta.url as an
// asset to pack, and a folder is not one, which broke the site's build.
function ownMigrations(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
}

interface MigrationFile {
  name: string;
  sql: string;
  sha256: string;
}

async function readMigrations(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) => {
      // Hashed with line endings made plain, so a Windows checkout and a Linux one of the same file agree.
      const sql = (await readFile(path.join(directory, name), 'utf8')).replaceAll('\r\n', '\n');
      return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

/**
 * Brings db's schema up to date by applying, in name order, each .sql file in directory that is not yet recorded in
 * schema_migrations. Each file runs in its own transaction together with its schema_migrations row, so a file is
 * either applied and recorded or neither. The whole run holds one advisory lock, so two migrators started together
 * cannot interleave: the second waits, then finds the work done.
 * @param db from connectPostgres or openMemoryDb.
 * @param directory the migrations folder, this package's own unless given.
 * @returns the files this run applied and the files it found already applied, each in name order.
 * @throws StoreError before anything is applied when a file already applied has a different SHA-256 now. StoreError
 *   when a statement fails, with that file and every later one left unapplied.
 */
export async function migrate(
  db: Db,
  directory: string = ownMigrations(),
): Promise<{ applied: string[]; alreadyApplied: string[] }> {
  const files = await readMigrations(directory);
  return withSession(db, async (session) => {
    await session.query('SELECT pg_advisory_lock(1000, 0)');
    try {
      const [table] = await session.query<{ present: boolean }>(
        "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
      );
      const recorded = new Map<string, string>();
      if (table?.present === true) {
        const rows = await session.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM schema_migrations');
        for (const row of rows) recorded.set(row.name, row.sha256);
      }
      for (const file of files) {
        const sha256 = recorded.get(file.name);
        if (sha256 !== undefined && sha256 !== file.sha256) {
          throw new StoreError(`${file.name} was changed after it was applied; put the change in a new file instead`);
        }
      }
      const applied: string[] = [];
      const alreadyApplied: string[] = [];
      for (const file of files) {
        if (recorded.has(file.name)) {
          alreadyApplied.push(file.name);
          continue;
        }
        await session.transaction(async (tx) => {
          await tx.script(file.sql);
          await tx.query('INSERT INTO schema_migrations (name, sha256, applied_at) VALUES ($1, $2, $3::timestamptz)', [
            file.name,
            file.sha256,
            new Date().toISOString(),
          ]);
        });
        applied.push(file.name);
      }
      return { applied, alreadyApplied };
    } finally {
      // A real Postgres session is destroyed when the run ends, which drops the lock even if this unlock fails.
      await session.query('SELECT pg_advisory_unlock(1000, 0)').catch(() => undefined);
    }
  });
}

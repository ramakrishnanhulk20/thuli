// Not covered here: two migrators in two processes against one real Postgres. Both runs here share one in-memory
// PGlite, so they are kept apart by its one-run-at-a-time session queue, not by the advisory lock a real server
// would hold. Files are hashed with Windows line endings made plain, and that is shown only by the hash itself.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb, StoreError, type Db } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';

const INIT = fileURLToPath(new URL('../migrations/001_init.sql', import.meta.url));

describe('migrate', () => {
  let db: Db;
  let directory: string;
  beforeEach(async () => {
    db = await openMemoryDb();
    directory = await mkdtemp(path.join(tmpdir(), 'thuli-migrate-'));
    await writeFile(path.join(directory, '001_init.sql'), await readFile(INIT));
  });
  afterEach(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function tableExists(name: string): Promise<boolean> {
    const [row] = await db.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [name]);
    return row?.present === true;
  }

  async function recorded(): Promise<string[]> {
    return (await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).map((row) => row.name);
  }

  it('applies each file once, even when two runs start together', async () => {
    const [first, second] = await Promise.all([migrate(db, directory), migrate(db, directory)]);
    expect([first, second]).toContainEqual({ applied: ['001_init.sql'], alreadyApplied: [] });
    expect([first, second]).toContainEqual({ applied: [], alreadyApplied: ['001_init.sql'] });
    expect(await migrate(db, directory)).toEqual({ applied: [], alreadyApplied: ['001_init.sql'] });
    const text = (await readFile(INIT, 'utf8')).replaceAll('\r\n', '\n');
    const rows = await db.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM schema_migrations');
    expect(rows).toEqual([{ name: '001_init.sql', sha256: createHash('sha256').update(text).digest('hex') }]);
  });

  it('refuses, before applying anything, when a file already applied has changed', async () => {
    await writeFile(path.join(directory, '002_notes.sql'), 'CREATE TABLE notes (body text);\n');
    expect(await migrate(db, directory)).toEqual({ applied: ['001_init.sql', '002_notes.sql'], alreadyApplied: [] });
    await writeFile(path.join(directory, '002_notes.sql'), 'CREATE TABLE notes (body text, extra text);\n');
    await writeFile(path.join(directory, '003_more.sql'), 'CREATE TABLE more (body text);\n');
    await expect(migrate(db, directory)).rejects.toThrow(StoreError);
    await expect(migrate(db, directory)).rejects.toThrow(/002_notes\.sql was changed after it was applied/);
    expect(await tableExists('more')).toBe(false);
    expect(await recorded()).toEqual(['001_init.sql', '002_notes.sql']);
  });

  it('rolls a failing file back whole, with its record, and stops before the files after it', async () => {
    await writeFile(
      path.join(directory, '002_broken.sql'),
      'CREATE TABLE half_done (x integer);\nINSERT INTO half_done VALUES (1);\nSELECT 1 / 0;\n',
    );
    await writeFile(path.join(directory, '003_after.sql'), 'CREATE TABLE after_broken (x integer);\n');
    await expect(migrate(db, directory)).rejects.toThrow(/division by zero/);
    expect(await recorded()).toEqual(['001_init.sql']);
    expect(await tableExists('half_done')).toBe(false);
    expect(await tableExists('after_broken')).toBe(false);
    await writeFile(path.join(directory, '002_broken.sql'), 'CREATE TABLE half_done (x integer);\n');
    expect(await migrate(db, directory)).toEqual({
      applied: ['002_broken.sql', '003_after.sql'],
      alreadyApplied: ['001_init.sql'],
    });
  });

  it('C40: every table holds exactly the columns in the work order, so no secret has a column to live in', async () => {
    await migrate(db);
    const rows = await db.query<{ table_name: string; column_name: string }>(
      'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position',
    );
    const tables: Record<string, string[]> = {};
    for (const row of rows) (tables[row.table_name] ??= []).push(row.column_name);
    expect(tables).toEqual({
      schema_migrations: ['name', 'sha256', 'applied_at'],
      payment_claims: ['key', 'state', 'owner', 'valid_before', 'updated_at'],
      leases: ['id', 'pool', 'expires_at'],
      rate_events: ['id', 'bucket', 'client', 'at'],
      day_counts: ['day', 'name', 'count'],
      check_cache: ['address', 'chain', 'rulebook', 'body', 'checked_at', 'expires_at'],
      campaigns: [
        'id', 'name', 'chain', 'vault', 'token', 'owner', 'agent', 'reward_per_wallet', 'per_wallet_cap', 'partial_share_bps',
        'max_slots', 'rulebook', 'settings', 'status', 'opens_at', 'closes_at', 'created_at',
      ],
      asks: [
        'campaign_id', 'wallet', 'signed_at', 'signature', 'asked_at', 'status', 'lease_until', 'attempts', 'action', 'share_bps',
        'rule', 'reason', 'cited_txs', 'not_checked', 'facts', 'serv_request_id', 'decided_at', 'slot',
      ],
      list_versions: ['campaign_id', 'version', 'root', 'published_list', 'declared_total', 'status', 'post_tx', 'claimable_at', 'created_at'],
      claim_relays: ['campaign_id', 'wallet', 'version', 'amount', 'status', 'tx', 'attempts', 'updated_at'],
    });
  });
});

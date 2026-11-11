// Not covered here: two migrators in two processes against one real Postgres. Both runs here share one in-memory
// PGlite, so they are kept apart by its one-run-at-a-time session queue, not by the advisory lock a real server
// would hold. Files are hashed with Windows line endings made plain, and that is shown only by the hash itself.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAsk, getCampaign, listVersions, markListSending, takeAsk, takeRelay } from '../src/campaigns.ts';
import { openMemoryDb, StoreError, type Db } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';

const INIT = fileURLToPath(new URL('../migrations/001_init.sql', import.meta.url));
const CAMPAIGNS = fileURLToPath(new URL('../migrations/002_campaigns.sql', import.meta.url));
const RETRIES = fileURLToPath(new URL('../migrations/003_retries_and_vault_block.sql', import.meta.url));

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

  it('a database made by 001 and 002 alone, holding a campaign, an ask and a relay, migrates on and keeps every row readable', async () => {
    await writeFile(path.join(directory, '002_campaigns.sql'), await readFile(CAMPAIGNS));
    expect(await migrate(db, directory)).toEqual({ applied: ['001_init.sql', '002_campaigns.sql'], alreadyApplied: [] });
    const vault = '0x00000000000000000000000000000000000a11ce';
    const wallet = '0x041f77015fe51c51aE49a7f2F3Ff86C641fa190a';
    const at = '2026-11-11T12:00:00.000Z';
    // Written the way the code before this migration wrote them, column for column.
    await db.query(
      `INSERT INTO campaigns (id, name, chain, vault, token, owner, agent, reward_per_wallet, per_wallet_cap, partial_share_bps,
                              max_slots, rulebook, settings, status, opens_at, closes_at, created_at)
       VALUES ('old', 'Before the retries', 84532, $1, $1, $1, $1, '1000000', '1000000', 5000, 20, 2, '{"groupMinSize": 3}',
               'open', $2::timestamptz, '2026-12-11T12:00:00.000Z'::timestamptz, $2::timestamptz)`,
      [vault, at],
    );
    await db.query(
      `INSERT INTO asks (campaign_id, wallet, signed_at, signature, asked_at, status, attempts)
       VALUES ('old', $1, 1800000000, $2, $3::timestamptz, 'queued', 0)`,
      [wallet, `0x${'ab'.repeat(65)}`, at],
    );
    await db.query(
      `INSERT INTO list_versions (campaign_id, version, root, published_list, declared_total, status, post_tx, claimable_at, created_at)
       VALUES ('old', 1, $1, '[]', '0', 'active', $2, 1800000000, $3::timestamptz)`,
      [`0x${'aa'.repeat(32)}`, `0x${'bb'.repeat(32)}`, at],
    );
    await db.query(
      `INSERT INTO claim_relays (campaign_id, wallet, version, amount, status, tx, attempts, updated_at)
       VALUES ('old', $1, 1, '1000000', 'pending', NULL, 4, $2::timestamptz)`,
      [wallet, at],
    );

    const upgraded = await migrate(db);
    expect(upgraded.alreadyApplied).toEqual(['001_init.sql', '002_campaigns.sql']);
    expect(upgraded.applied).toContain('003_retries_and_vault_block.sql');
    expect(await getCampaign(db, 'old')).toMatchObject({ id: 'old', settings: { groupMinSize: 3 }, vaultBlock: null, status: 'open' });
    expect(await getAsk(db, 'old', wallet)).toMatchObject({ status: 'queued', wallet });
    expect((await listVersions(db, 'old')).map((list) => [list.version, list.status, list.postTx])).toEqual([[1, 'active', `0x${'bb'.repeat(32)}`]]);
    const now = new Date('2026-11-11T12:01:00.000Z');
    expect(await takeAsk(db, now, 60, 3)).toMatchObject({ campaignId: 'old', wallet, attempts: 1 });
    expect(await takeRelay(db, now, 60)).toMatchObject({ campaignId: 'old', wallet, version: 1, attempts: 5, status: 'sent' });
  });

  it('a database made through 003, holding a built, a posted and an active list, migrates on with every list readable', async () => {
    await writeFile(path.join(directory, '002_campaigns.sql'), await readFile(CAMPAIGNS));
    await writeFile(path.join(directory, '003_retries_and_vault_block.sql'), await readFile(RETRIES));
    expect((await migrate(db, directory)).applied).toEqual(['001_init.sql', '002_campaigns.sql', '003_retries_and_vault_block.sql']);
    const vault = '0x00000000000000000000000000000000000a11ce';
    const at = '2026-11-11T12:00:00.000Z';
    const hash = `0x${'bb'.repeat(32)}`;
    await db.query(
      `INSERT INTO campaigns (id, name, chain, vault, token, owner, agent, reward_per_wallet, per_wallet_cap, partial_share_bps,
                              max_slots, rulebook, settings, status, opens_at, closes_at, created_at, vault_block)
       VALUES ('old', 'Before sending', 84532, $1, $1, $1, $1, '1000000', '1000000', 5000, 20, 2, '{}', 'open',
               $2::timestamptz, '2026-12-11T12:00:00.000Z'::timestamptz, $2::timestamptz, 34210987)`,
      [vault, at],
    );
    // Written the way the code before this migration wrote them: active with its hash, posted as found on the vault
    // with no hash, and built.
    for (const [version, status, postTx, claimableAt] of [
      [1, 'active', hash, '1800000000'],
      [2, 'posted', null, '1800003600'],
      [3, 'built', null, null],
    ] as const) {
      await db.query(
        `INSERT INTO list_versions (campaign_id, version, root, published_list, declared_total, status, post_tx, claimable_at, created_at)
         VALUES ('old', $1, $2, '[]', '0', $3, $4, $5::bigint, $6::timestamptz)`,
        [version, `0x${String(version).repeat(64)}`, status, postTx, claimableAt, at],
      );
    }

    const upgraded = await migrate(db);
    expect(upgraded.alreadyApplied).toEqual(['001_init.sql', '002_campaigns.sql', '003_retries_and_vault_block.sql']);
    expect(upgraded.applied).toContain('005_list_sending.sql');
    expect((await listVersions(db, 'old')).map((list) => [list.version, list.status, list.postTx, list.claimableAt])).toEqual([
      [1, 'active', hash, 1_800_000_000],
      [2, 'posted', null, 1_800_003_600],
      [3, 'built', null, null],
    ]);
    expect(await markListSending(db, 'old', 3, { postTx: hash }, new Date(at))).toBe(true);
    expect((await listVersions(db, 'old'))[2]).toMatchObject({ status: 'sending', postTx: hash, claimableAt: null });
  });

  it('C40: every table holds exactly the columns listed here, so no secret has a column to live in', async () => {
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
        'max_slots', 'rulebook', 'settings', 'status', 'opens_at', 'closes_at', 'created_at', 'vault_block',
      ],
      asks: [
        'campaign_id', 'wallet', 'signed_at', 'signature', 'asked_at', 'status', 'lease_until', 'attempts', 'action', 'share_bps',
        'rule', 'reason', 'cited_txs', 'not_checked', 'facts', 'serv_request_id', 'decided_at', 'slot', 'retry_at',
      ],
      list_versions: ['campaign_id', 'version', 'root', 'published_list', 'declared_total', 'status', 'post_tx', 'claimable_at', 'created_at'],
      claim_relays: ['campaign_id', 'wallet', 'version', 'amount', 'status', 'tx', 'attempts', 'updated_at', 'retry_at'],
    });
  });
});

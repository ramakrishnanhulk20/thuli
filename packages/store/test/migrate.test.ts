// Not covered here: two migrators in two processes against one real Postgres. Both runs here share one in-memory
// PGlite, so they are kept apart by its one-run-at-a-time session queue, not by the advisory lock a real server
// would hold. Files are hashed with Windows line endings made plain, and that is shown only by the hash itself.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appealTextHash, parseAddress } from '@thuli/core';
import { addAppeal, getAppeal } from '../src/appeals.ts';
import { counts, getAsk, getCampaign, listVersions, markListResent, markListSending, takeAsk, takeRelay } from '../src/campaigns.ts';
import { openMemoryDb, StoreError, type Db } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { claimPayment, redeemPayment } from '../src/paymentClaims.ts';

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

  it('a database made through 003, holding a held, an unsure and a used claim, migrates through 004 with each claim keeping its meaning', async () => {
    await writeFile(path.join(directory, '002_campaigns.sql'), await readFile(CAMPAIGNS));
    await writeFile(path.join(directory, '003_retries_and_vault_block.sql'), await readFile(RETRIES));
    await migrate(db, directory);
    for (const [key, state, owner] of [
      ['held', 'held', 'request-1'],
      ['unsure', 'unsure', null],
      ['used', 'used', null],
    ] as const) {
      await db.query(
        `INSERT INTO payment_claims (key, state, owner, valid_before, updated_at)
         VALUES ($1, $2, $3, 1800000300, to_timestamp(1800000000))`,
        [key, state, owner],
      );
    }

    const upgraded = await migrate(db);
    expect(upgraded.applied).toContain('004_paid_results.sql');
    const timing = { nowSeconds: 1_800_000_010n, latestSeconds: 330n };
    const owned = { nowSeconds: 1_800_000_010n, ownedUntil: 1_800_000_340n };
    const wallet = '0x041f77015fe51c51aE49a7f2F3Ff86C641fa190a';
    expect(await claimPayment(db, 'held', 1_800_000_300n, 'copy', timing)).toBe('in-use');
    expect(await claimPayment(db, 'used', 1_800_000_300n, 'copy', timing)).toBe('in-use');
    expect(await redeemPayment(db, 'used', wallet, 'copy', owned)).toEqual({ found: 'none' });
    expect(await claimPayment(db, 'unsure', 1_800_000_300n, 'retry', timing)).toBe('taken');
    // A row the new rules forbid is refused by the table itself: settled with no wallet, served with no result.
    await expect(db.query("UPDATE payment_claims SET state = 'settled', owner = NULL WHERE key = 'used'")).rejects.toThrow(StoreError);
    await expect(
      db.query(
        "UPDATE payment_claims SET state = 'served', owner = NULL, wallet = $1, tx = $2, settled_at = 1800000000 WHERE key = 'used'",
        [wallet, `0x${'5e'.repeat(32)}`],
      ),
    ).rejects.toThrow(StoreError);
  });

  it('a database made through 005, holding decided, failed and queued asks and a list, migrates on to appeals with every row readable', async () => {
    for (const name of ['002_campaigns.sql', '003_retries_and_vault_block.sql', '004_paid_results.sql', '005_list_sending.sql']) {
      await writeFile(path.join(directory, name), await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url))));
    }
    expect((await migrate(db, directory)).applied).toHaveLength(5);
    const at = '2026-11-11T12:00:00.000Z';
    const vault = '0x00000000000000000000000000000000000a11ce';
    const held = parseAddress('0x041f77015fe51c51aE49a7f2F3Ff86C641fa190a');
    const failed = parseAddress('0x00000000000000000000000000000000000000b1');
    const waiting = parseAddress('0x00000000000000000000000000000000000000b2');
    const facts = '{"ageDays":3,"txCount":1,"accountType":"eoa","funder":null,"burstWallets":null,"groupSize":null,"missing":[]}';
    await db.query(
      `INSERT INTO campaigns (id, name, chain, vault, token, owner, agent, reward_per_wallet, per_wallet_cap, partial_share_bps,
                              max_slots, rulebook, settings, status, opens_at, closes_at, created_at)
       VALUES ('old', 'Before appeals', 84532, $1, $1, $1, $1, '1000000', '1000000', 5000, 20, 2, '{}', 'open',
               $2::timestamptz, '2026-12-11T12:00:00.000Z'::timestamptz, $2::timestamptz)`,
      [vault, at],
    );
    // Written the way the code before this migration wrote them.
    const signature = `0x${'ab'.repeat(65)}`;
    await db.query(
      `INSERT INTO asks (campaign_id, wallet, signed_at, signature, asked_at, status, attempts, action, share_bps, rule, reason,
                         cited_txs, not_checked, facts, decided_at)
       VALUES ('old', $1, 1800000000, $2, $3::timestamptz, 'decided', 1, 'hold', 0, 'A9', 'Held while the funder is checked.',
               '[]', '[]', $4::jsonb, $3::timestamptz),
              ('old', $5, 1800000000, $2, $3::timestamptz, 'failed', 3, 'hold', 0, 'A1', 'Held for review: the screening could not finish.',
               '[]', '[]', NULL, $3::timestamptz)`,
      [held, signature, at, facts, failed],
    );
    await db.query(
      `INSERT INTO asks (campaign_id, wallet, signed_at, signature, asked_at, status, attempts)
       VALUES ('old', $1, 1800000000, $2, $3::timestamptz, 'queued', 0)`,
      [waiting, signature, at],
    );
    await db.query(
      `INSERT INTO list_versions (campaign_id, version, root, published_list, declared_total, status, post_tx, claimable_at, created_at)
       VALUES ('old', 1, $1, '[]', '0', 'active', $2, 1800000000, $3::timestamptz)`,
      [`0x${'11'.repeat(32)}`, `0x${'bb'.repeat(32)}`, at],
    );

    const upgraded = await migrate(db);
    expect(upgraded.alreadyApplied).toHaveLength(5);
    expect(upgraded.applied).toContain('006_appeals.sql');
    expect(await getAsk(db, 'old', held)).toMatchObject({ status: 'decided', action: 'hold', rule: 'A9', appeal: null });
    expect(await getAsk(db, 'old', failed)).toMatchObject({ status: 'failed', action: 'hold', rule: 'A1', appeal: null });
    expect(await getAsk(db, 'old', waiting)).toMatchObject({ status: 'queued', appeal: null });
    expect(await counts(db, 'old')).toMatchObject({ asked: 3, appeals: { filed: 0, checked: 0, block: 0, reversed: 0 } });
    expect((await listVersions(db, 'old')).map((list) => [list.version, list.status])).toEqual([[1, 'active']]);
    // An ask held before the migration can be appealed after it.
    const text = 'My wallet is my own.';
    expect(
      await addAppeal(db, { campaignId: 'old', wallet: held, text, textHash: appealTextHash(text), signedAt: 1_800_000_000, signature }, new Date(at)),
    ).toBe('queued');
    expect(await getAppeal(db, 'old', held)).toMatchObject({ checkStatus: 'queued', outcome: 'open' });
  });

  it('a database made through 007, holding a list being sent, migrates on to the nonce with every row readable', async () => {
    const before = ['002_campaigns.sql', '003_retries_and_vault_block.sql', '004_paid_results.sql', '005_list_sending.sql', '006_appeals.sql', '007_screening_tries.sql'];
    for (const name of before) {
      await writeFile(path.join(directory, name), await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url))));
    }
    expect((await migrate(db, directory)).applied).toHaveLength(7);
    const at = '2026-11-11T12:00:00.000Z';
    const hash = `0x${'bb'.repeat(32)}`;
    await db.query(
      `INSERT INTO campaigns (id, name, chain, vault, token, owner, agent, reward_per_wallet, per_wallet_cap, partial_share_bps,
                              max_slots, rulebook, settings, status, opens_at, closes_at, created_at)
       VALUES ('old', 'Before the nonce', 84532, $1, $1, $1, $1, '1000000', '1000000', 5000, 20, 2, '{}', 'open',
               $2::timestamptz, '2026-12-11T12:00:00.000Z'::timestamptz, $2::timestamptz)`,
      ['0x00000000000000000000000000000000000a11ce', at],
    );
    // Written the way the code before this migration wrote it: sending, with a hash and no nonce.
    await db.query(
      `INSERT INTO list_versions (campaign_id, version, root, published_list, declared_total, status, post_tx, claimable_at, created_at)
       VALUES ('old', 1, $1, '[]', '0', 'sending', $2, NULL, $3::timestamptz)`,
      [`0x${'11'.repeat(32)}`, hash, at],
    );

    const upgraded = await migrate(db);
    expect(upgraded.alreadyApplied).toHaveLength(7);
    expect(upgraded.applied).toContain('008_post_nonce.sql');
    expect(await listVersions(db, 'old')).toEqual([
      expect.objectContaining({ version: 1, status: 'sending', postTx: hash, postNonce: null, claimableAt: null }),
    ]);
    const other = `0x${'cc'.repeat(32)}`;
    expect(await markListResent(db, 'old', 1, { postTx: other }, new Date(at))).toBe(true);
    expect(await listVersions(db, 'old')).toEqual([expect.objectContaining({ status: 'sending', postTx: other, postNonce: null })]);
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
      payment_claims: [
        'key', 'state', 'owner', 'valid_before', 'updated_at', 'wallet', 'tx', 'settled_at', 'owned_until', 'result', 'screenings',
        'owner_counted',
      ],
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
        'rule', 'reason', 'cited_txs', 'not_checked', 'facts', 'serv_request_id', 'decided_at', 'slot', 'retry_at', 'record',
        'reversed_by_appeal',
      ],
      appeals: [
        'campaign_id', 'wallet', 'text', 'text_hash', 'signed_at', 'signature', 'appealed_action', 'appealed_rule', 'filed_at',
        'check_status', 'lease_until', 'attempts', 'retry_at', 'reppo_eval_id', 'reppo_route', 'reppo_note', 'credits_charged',
        'checked_at', 'outcome', 'new_action', 'owner_note', 'settled_at',
      ],
      list_versions: [
        'campaign_id', 'version', 'root', 'published_list', 'declared_total', 'status', 'post_tx', 'claimable_at', 'created_at',
        'post_nonce',
      ],
      claim_relays: ['campaign_id', 'wallet', 'version', 'amount', 'status', 'tx', 'attempts', 'updated_at', 'retry_at'],
    });
  });
});

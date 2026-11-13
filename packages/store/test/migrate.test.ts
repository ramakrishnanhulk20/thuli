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
import { addAppeal, countUnclearSubmit, getAppeal, markAppealSubmitting, ownerAppeals, recordAppealCheck, takeAppeal } from '../src/appeals.ts';
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

  it('a database made through 008, holding a checked and a waiting appeal, migrates on to 009 with every row readable', async () => {
    const before = [
      '002_campaigns.sql', '003_retries_and_vault_block.sql', '004_paid_results.sql', '005_list_sending.sql', '006_appeals.sql',
      '007_screening_tries.sql', '008_post_nonce.sql',
    ];
    for (const name of before) {
      await writeFile(path.join(directory, name), await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url))));
    }
    expect((await migrate(db, directory)).applied).toHaveLength(8);
    const at = '2026-11-11T12:00:00.000Z';
    const checked = parseAddress('0x041f77015fe51c51aE49a7f2F3Ff86C641fa190a');
    const waiting = parseAddress('0x00000000000000000000000000000000000000b2');
    const signature = `0x${'ab'.repeat(65)}`;
    const text = 'My wallet is my own.';
    await db.query(
      `INSERT INTO campaigns (id, name, chain, vault, token, owner, agent, reward_per_wallet, per_wallet_cap, partial_share_bps,
                              max_slots, rulebook, settings, status, opens_at, closes_at, created_at)
       VALUES ('old', 'Before the verdict', 84532, $1, $1, $1, $1, '1000000', '1000000', 5000, 20, 2, '{}', 'open',
               $2::timestamptz, '2026-12-11T12:00:00.000Z'::timestamptz, $2::timestamptz)`,
      ['0x00000000000000000000000000000000000a11ce', at],
    );
    await db.query(
      `INSERT INTO asks (campaign_id, wallet, signed_at, signature, asked_at, status, attempts, action, share_bps, rule, reason,
                         cited_txs, not_checked, facts, decided_at)
       SELECT 'old', w, 1800000000, $2, $3::timestamptz, 'decided', 1, 'hold', 0, 'A9', 'Held while the funder is checked.',
              '[]', '[]', $4::jsonb, $3::timestamptz
         FROM unnest(ARRAY[$1::text, $5::text]) AS w`,
      [checked, signature, at, '{"ageDays":3,"txCount":1,"accountType":"eoa","funder":null,"burstWallets":null,"groupSize":null,"missing":[]}', waiting],
    );
    // Written the way the code before this migration wrote them: one checked with its route, one still queued.
    await db.query(
      `INSERT INTO appeals (campaign_id, wallet, text, text_hash, signed_at, signature, appealed_action, appealed_rule, filed_at,
                            check_status, attempts, reppo_eval_id, reppo_route, reppo_note, credits_charged, checked_at, outcome)
       VALUES ('old', $1, $3, $4, 1800000000, $5, 'hold', 'A9', $6::timestamptz, 'checked', 1, 'eval_1', 'block', 'A count alone.', 4,
               $6::timestamptz, 'open'),
              ('old', $2, $3, $4, 1800000000, $5, 'hold', 'A9', $6::timestamptz, 'queued', 0, NULL, NULL, NULL, NULL, NULL, 'open')`,
      [checked, waiting, text, appealTextHash(text), signature, at],
    );

    const upgraded = await migrate(db);
    expect(upgraded.alreadyApplied).toHaveLength(8);
    expect(upgraded.applied).toContain('009_reppo_verdict.sql');
    expect(await getAppeal(db, 'old', checked)).toMatchObject({ checkStatus: 'checked', reppoRoute: 'block', reppoNote: 'A count alone.', reppoEvalId: 'eval_1' });
    expect(await getAppeal(db, 'old', waiting)).toMatchObject({ checkStatus: 'queued', reppoRoute: null });
    expect((await ownerAppeals(db, 'old')).map((row) => [row.checkStatus, row.reppoRoute, row.reppoScore, row.reppoDecision, row.reppoConfidence])).toEqual([
      ['queued', null, null, null, null],
      ['checked', 'block', null, null, null],
    ]);
    // The waiting appeal, checked after the migration with a route Thuli does not know, is kept as checked.
    expect(await takeAppeal(db, new Date(at), 300, 6)).toMatchObject({ wallet: waiting });
    expect(await recordAppealCheck(db, { campaignId: 'old', wallet: waiting }, { evalId: 'eval_2', route: null, note: null, creditsCharged: 3, score: 12 }, new Date(at))).toBe(
      true,
    );
    expect(await getAppeal(db, 'old', waiting)).toMatchObject({ checkStatus: 'checked', reppoRoute: null });
    // Rows the new rules forbid are refused by the table itself: a verdict or a route on an appeal that is not checked.
    await expect(db.query("UPDATE appeals SET check_status = 'unchecked', credits_charged = NULL WHERE wallet = $1", [waiting])).rejects.toThrow(StoreError);
    await expect(db.query("UPDATE appeals SET reppo_route = 'ship', check_status = 'unchecked', credits_charged = NULL, reppo_score = NULL WHERE wallet = $1", [waiting])).rejects.toThrow(
      StoreError,
    );
    await expect(db.query('UPDATE appeals SET reppo_score = 101 WHERE wallet = $1', [checked])).rejects.toThrow(StoreError);
  });

  it('a database made through 009, holding a checking and a checked appeal, migrates on to 010 with every row readable', async () => {
    const before = [
      '002_campaigns.sql', '003_retries_and_vault_block.sql', '004_paid_results.sql', '005_list_sending.sql', '006_appeals.sql',
      '007_screening_tries.sql', '008_post_nonce.sql', '009_reppo_verdict.sql',
    ];
    for (const name of before) {
      await writeFile(path.join(directory, name), await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url))));
    }
    expect((await migrate(db, directory)).applied).toHaveLength(9);
    const at = '2026-11-11T12:00:00.000Z';
    const checking = parseAddress('0x00000000000000000000000000000000000000b2');
    const checked = parseAddress('0x041f77015fe51c51aE49a7f2F3Ff86C641fa190a');
    const signature = `0x${'ab'.repeat(65)}`;
    const text = 'My wallet is my own.';
    await db.query(
      `INSERT INTO campaigns (id, name, chain, vault, token, owner, agent, reward_per_wallet, per_wallet_cap, partial_share_bps,
                              max_slots, rulebook, settings, status, opens_at, closes_at, created_at)
       VALUES ('old', 'Before the submit mark', 84532, $1, $1, $1, $1, '1000000', '1000000', 5000, 20, 2, '{}', 'open',
               $2::timestamptz, '2026-12-11T12:00:00.000Z'::timestamptz, $2::timestamptz)`,
      ['0x00000000000000000000000000000000000a11ce', at],
    );
    await db.query(
      `INSERT INTO asks (campaign_id, wallet, signed_at, signature, asked_at, status, attempts, action, share_bps, rule, reason,
                         cited_txs, not_checked, facts, decided_at)
       SELECT 'old', w, 1800000000, $2, $3::timestamptz, 'decided', 1, 'hold', 0, 'A9', 'Held while the funder is checked.',
              '[]', '[]', $4::jsonb, $3::timestamptz
         FROM unnest(ARRAY[$1::text, $5::text]) AS w`,
      [checking, signature, at, '{"ageDays":3,"txCount":1,"accountType":"eoa","funder":null,"burstWallets":null,"groupSize":null,"missing":[]}', checked],
    );
    // Written the way the code before this migration wrote them: one held by a worker whose lease has run out, one
    // checked with Reppo's verdict.
    await db.query(
      `INSERT INTO appeals (campaign_id, wallet, text, text_hash, signed_at, signature, appealed_action, appealed_rule, filed_at,
                            check_status, lease_until, attempts, reppo_eval_id, reppo_route, reppo_note, credits_charged, checked_at,
                            outcome, reppo_score, reppo_decision, reppo_confidence)
       VALUES ('old', $1, $3, $4, 1800000000, $5, 'hold', 'A9', $6::timestamptz, 'checking', $6::timestamptz, 1, NULL, NULL, NULL,
               NULL, NULL, 'open', NULL, NULL, NULL),
              ('old', $2, $3, $4, 1800000000, $5, 'hold', 'A9', $6::timestamptz, 'checked', NULL, 1, 'eval_1', 'block', NULL, 4,
               $6::timestamptz, 'open', 30, 'reject', 'high')`,
      [checking, checked, text, appealTextHash(text), signature, at],
    );

    const upgraded = await migrate(db);
    expect(upgraded.alreadyApplied).toHaveLength(9);
    expect(upgraded.applied).toContain('010_appeal_submit_mark.sql');
    expect((await ownerAppeals(db, 'old')).map((row) => [row.wallet, row.checkStatus, row.reppoScore, row.submitStartedAt, row.checkNote])).toEqual([
      [checking, 'checking', null, null, null],
      [checked, 'checked', 30, null, null],
    ]);
    expect(await getAppeal(db, 'old', checked)).toMatchObject({ checkStatus: 'checked', reppoRoute: 'block' });
    // The appeal a dead worker held is taken again with no mark, so it may be submitted, and marked first.
    const now = new Date('2026-11-11T12:10:00.000Z');
    expect(await takeAppeal(db, now, 300, 6)).toMatchObject({ wallet: checking, attempts: 2, submitStarted: false });
    expect(await markAppealSubmitting(db, { campaignId: 'old', wallet: checking }, now)).toBe(true);
    // A cause on an appeal that is not unchecked is refused by the table itself.
    await expect(db.query("UPDATE appeals SET check_note = 'a cause' WHERE wallet = $1", [checked])).rejects.toThrow(StoreError);
  });

  it('a database made through 010, holding a marked and a checked appeal, migrates on to 011 with each counting 0', async () => {
    const before = [
      '002_campaigns.sql', '003_retries_and_vault_block.sql', '004_paid_results.sql', '005_list_sending.sql', '006_appeals.sql',
      '007_screening_tries.sql', '008_post_nonce.sql', '009_reppo_verdict.sql', '010_appeal_submit_mark.sql',
    ];
    for (const name of before) {
      await writeFile(path.join(directory, name), await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url))));
    }
    expect((await migrate(db, directory)).applied).toHaveLength(10);
    const at = '2026-11-11T12:00:00.000Z';
    const marked = parseAddress('0x00000000000000000000000000000000000000b2');
    const checked = parseAddress('0x041f77015fe51c51aE49a7f2F3Ff86C641fa190a');
    const signature = `0x${'ab'.repeat(65)}`;
    const text = 'My wallet is my own.';
    await db.query(
      `INSERT INTO campaigns (id, name, chain, vault, token, owner, agent, reward_per_wallet, per_wallet_cap, partial_share_bps,
                              max_slots, rulebook, settings, status, opens_at, closes_at, created_at)
       VALUES ('old', 'Before the count', 84532, $1, $1, $1, $1, '1000000', '1000000', 5000, 20, 2, '{}', 'open',
               $2::timestamptz, '2026-12-11T12:00:00.000Z'::timestamptz, $2::timestamptz)`,
      ['0x00000000000000000000000000000000000a11ce', at],
    );
    await db.query(
      `INSERT INTO asks (campaign_id, wallet, signed_at, signature, asked_at, status, attempts, action, share_bps, rule, reason,
                         cited_txs, not_checked, facts, decided_at)
       SELECT 'old', w, 1800000000, $2, $3::timestamptz, 'decided', 1, 'hold', 0, 'A9', 'Held while the funder is checked.',
              '[]', '[]', $4::jsonb, $3::timestamptz
         FROM unnest(ARRAY[$1::text, $5::text]) AS w`,
      [marked, signature, at, '{"ageDays":3,"txCount":1,"accountType":"eoa","funder":null,"burstWallets":null,"groupSize":null,"missing":[]}', checked],
    );
    // Written the way the code before this migration wrote them: one checking with its submit marked and no evaluation
    // id, one checked.
    await db.query(
      `INSERT INTO appeals (campaign_id, wallet, text, text_hash, signed_at, signature, appealed_action, appealed_rule, filed_at,
                            check_status, lease_until, attempts, reppo_eval_id, reppo_route, credits_charged, checked_at, outcome,
                            submit_started_at)
       VALUES ('old', $1, $3, $4, 1800000000, $5, 'hold', 'A9', $6::timestamptz, 'checking', $7::timestamptz, 1, NULL, NULL, NULL,
               NULL, 'open', $6::timestamptz),
              ('old', $2, $3, $4, 1800000000, $5, 'hold', 'A9', $6::timestamptz, 'checked', NULL, 1, 'eval_1', 'block', 4,
               $6::timestamptz, 'open', $6::timestamptz)`,
      [marked, checked, text, appealTextHash(text), signature, at, '2026-11-11T12:05:00.000Z'],
    );

    const upgraded = await migrate(db);
    expect(upgraded.alreadyApplied).toHaveLength(10);
    expect(upgraded.applied).toContain('011_appeal_unclear_submits.sql');
    expect((await ownerAppeals(db, 'old')).map((row) => [row.wallet, row.checkStatus, row.unclearSubmits])).toEqual([
      [marked, 'checking', 0],
      [checked, 'checked', 0],
    ]);
    expect(await countUnclearSubmit(db, { campaignId: 'old', wallet: marked }, new Date(at))).toEqual({ counted: true, unclearSubmits: 1 });
    await expect(db.query('UPDATE appeals SET unclear_submits = -1 WHERE wallet = $1', [checked])).rejects.toThrow(StoreError);
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
        'owner_counted', 'named_txs',
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
        'checked_at', 'outcome', 'new_action', 'owner_note', 'settled_at', 'reppo_score', 'reppo_decision', 'reppo_confidence',
        'submit_started_at', 'check_note', 'unclear_submits',
      ],
      list_versions: [
        'campaign_id', 'version', 'root', 'published_list', 'declared_total', 'status', 'post_tx', 'claimable_at', 'created_at',
        'post_nonce',
      ],
      claim_relays: ['campaign_id', 'wallet', 'version', 'amount', 'status', 'tx', 'attempts', 'updated_at', 'retry_at'],
    });
  });
});

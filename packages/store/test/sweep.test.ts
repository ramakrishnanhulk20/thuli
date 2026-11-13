// Not covered here: who runs sweep and how often (that is the next order's wiring), and a sweep racing a claim on a
// real Postgres. day_counts is outside sweep by design: it gains one row per counter name per UTC day, and the names
// are chosen by Thuli's code, never by a caller. schema_migrations is the schema's own record and must stay.
import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeCheck } from '../src/checkCache.ts';
import { openMemoryDb, StoreError, type Db } from '../src/db.ts';
import { bumpDay, recordEvent, recordIfUnder, takeLease } from '../src/limits.ts';
import { migrate } from '../src/migrate.ts';
import {
  claimPayment,
  keepPaymentUnsure,
  markPaymentSettled,
  PAID_RESULT_KEEP_SECONDS,
  redeemPayment,
  servePayment,
} from '../src/paymentClaims.ts';
import { sweep } from '../src/sweep.ts';

const NOW_SECONDS = 1_800_000_000n;
const NOW = new Date(Number(NOW_SECONDS) * 1000);
const ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SWEPT = ['payment_claims', 'leases', 'rate_events', 'check_cache'];

function plus(seconds: number): Date {
  return new Date(NOW.getTime() + seconds * 1000);
}

function at(nowSeconds: bigint): { nowSeconds: bigint; latestSeconds: bigint } {
  return { nowSeconds, latestSeconds: 330n };
}

function owned(nowSeconds: bigint): { nowSeconds: bigint; ownedUntil: bigint } {
  return { nowSeconds, ownedUntil: nowSeconds + 330n };
}

const SETTLEMENT = { wallet: ADDRESS, transaction: `0x${'5e'.repeat(32)}` };

describe('sweep', () => {
  let db: Db;
  beforeAll(async () => {
    db = await openMemoryDb();
    await migrate(db);
  });
  beforeEach(async () => {
    await db.query('TRUNCATE payment_claims, leases, rate_events, day_counts, check_cache');
  });
  afterAll(async () => {
    await db.close();
  });

  async function rows(table: string): Promise<number> {
    const counts: Record<string, string> = {
      payment_claims: 'SELECT count(*)::int AS n FROM payment_claims',
      leases: 'SELECT count(*)::int AS n FROM leases',
      rate_events: 'SELECT count(*)::int AS n FROM rate_events',
      check_cache: 'SELECT count(*)::int AS n FROM check_cache',
      day_counts: 'SELECT count(*)::int AS n FROM day_counts',
      schema_migrations: 'SELECT count(*)::int AS n FROM schema_migrations',
    };
    const [row] = await db.query<{ n: number }>(counts[table] as string);
    return row?.n ?? -1;
  }

  it('deletes each kind exactly at its own boundary and reports the counts', async () => {
    expect(await claimPayment(db, 'past-hour', NOW_SECONDS - 3_601n, 'a', at(NOW_SECONDS - 3_700n))).toBe('taken');
    expect(await claimPayment(db, 'at-hour', NOW_SECONDS - 3_600n, 'a', at(NOW_SECONDS - 3_700n))).toBe('taken');
    expect(await claimPayment(db, 'live', NOW_SECONDS + 100n, 'a', at(NOW_SECONDS))).toBe('taken');
    expect(await takeLease(db, 'pool', 5, 120, plus(-120))).not.toBeNull();
    expect(await takeLease(db, 'pool', 5, 120, plus(-119))).not.toBeNull();
    await recordEvent(db, 'bucket', 'client', plus(-7_200.001));
    await recordEvent(db, 'bucket', 'client', plus(-7_200));
    await writeCheck(db, { address: ADDRESS, chain: 8453, rulebook: 1 }, { n: 1 }, plus(-600), 600);
    await writeCheck(db, { address: ADDRESS, chain: 8453, rulebook: 2 }, { n: 2 }, plus(-600), 601);

    expect(await sweep(db, NOW)).toEqual({ claims: 1, leases: 1, events: 1, checks: 1 });
    expect(await sweep(db, NOW)).toEqual({ claims: 0, leases: 0, events: 0, checks: 0 });
    // Half a second later the claim at exactly one hour is more than an hour past, and so is the event at two hours.
    expect(await sweep(db, plus(0.5))).toEqual({ claims: 1, leases: 0, events: 1, checks: 0 });
    expect((await db.query('SELECT key FROM payment_claims')).map((row) => row.key)).toEqual(['live']);
  });

  it('C25, C41: keeps a settled or served claim for a day from its settlement, long past its validBefore, and deletes it after', async () => {
    const day = BigInt(PAID_RESULT_KEEP_SECONDS);
    const settledAt = NOW_SECONDS - day;
    for (const key of ['settled', 'served']) {
      expect(await claimPayment(db, key, settledAt + 300n, 'payer', at(settledAt))).toBe('taken');
      await markPaymentSettled(db, key, 'payer', SETTLEMENT, owned(settledAt));
    }
    await servePayment(db, 'served', 'payer', { result: 1 });
    // A day to the second after settling, the claims are past redeeming but not yet more than a day old.
    expect(await redeemPayment(db, 'served', ADDRESS, 'fetch', owned(NOW_SECONDS))).toEqual({ found: 'none' });
    expect(await sweep(db, NOW)).toEqual({ claims: 0, leases: 0, events: 0, checks: 0 });
    expect(await sweep(db, plus(0.5))).toEqual({ claims: 2, leases: 0, events: 0, checks: 0 });
    expect(await db.query('SELECT key FROM payment_claims')).toEqual([]);

    // One second younger, the claim is still redeemable, and so the sweep keeps it.
    expect(await claimPayment(db, 'young', settledAt + 301n, 'payer', at(settledAt + 1n))).toBe('taken');
    await markPaymentSettled(db, 'young', 'payer', SETTLEMENT, owned(settledAt + 1n));
    await servePayment(db, 'young', 'payer', { result: 2 });
    expect(await sweep(db, plus(0.5))).toEqual({ claims: 0, leases: 0, events: 0, checks: 0 });
    expect(await redeemPayment(db, 'young', ADDRESS, 'fetch', owned(NOW_SECONDS))).toEqual({
      found: 'served',
      transaction: SETTLEMENT.transaction,
      body: { result: 2 },
    });
  });

  it('C25, C41: keeps an unsure claim that holds a named transaction for a day past its validBefore, and one that holds none for an hour', async () => {
    const day = BigInt(PAID_RESULT_KEEP_SECONDS);
    // Both authorizations ended a day ago, to the second.
    const validBefore = NOW_SECONDS - day;
    expect(await claimPayment(db, 'waiting', validBefore, 'payer', at(validBefore - 300n))).toBe('taken');
    await keepPaymentUnsure(db, 'waiting', 'payer', [`0x${'7a'.repeat(32)}`]);
    expect(await claimPayment(db, 'bare', validBefore, 'payer', at(validBefore - 300n))).toBe('taken');
    await keepPaymentUnsure(db, 'bare', 'payer');

    expect(await sweep(db, NOW)).toEqual({ claims: 1, leases: 0, events: 0, checks: 0 });
    expect(await db.query('SELECT key FROM payment_claims')).toEqual([{ key: 'waiting' }]);
    expect(await sweep(db, plus(0.5))).toEqual({ claims: 1, leases: 0, events: 0, checks: 0 });
    expect(await db.query('SELECT key FROM payment_claims')).toEqual([]);
  });

  it('C41: a sweep far in the future empties every table outside input can grow', async () => {
    expect(await claimPayment(db, 'held', NOW_SECONDS + 300n, 'a', at(NOW_SECONDS))).toBe('taken');
    expect(await claimPayment(db, 'unsure', NOW_SECONDS + 300n, 'b', at(NOW_SECONDS))).toBe('taken');
    await keepPaymentUnsure(db, 'unsure', 'b');
    expect(await claimPayment(db, 'settled', NOW_SECONDS + 300n, 'c', at(NOW_SECONDS))).toBe('taken');
    await markPaymentSettled(db, 'settled', 'c', SETTLEMENT, owned(NOW_SECONDS));
    expect(await takeLease(db, 'pool', 5, 86_400, NOW)).not.toBeNull();
    expect(await recordIfUnder(db, 'bucket', 'client', 5, 60, NOW)).toBe(true);
    await recordEvent(db, 'failed', 'client', NOW);
    await writeCheck(db, { address: ADDRESS, chain: 8453, rulebook: 2 }, { n: 1 }, NOW, 86_400 * 365);
    expect(await bumpDay(db, 'screenings', 10, NOW)).toBe(true);

    expect(await sweep(db, new Date('2100-01-01T00:00:00.000Z'))).toEqual({ claims: 3, leases: 1, events: 2, checks: 1 });
    for (const table of SWEPT) expect({ table, rows: await rows(table) }).toEqual({ table, rows: 0 });
    expect(await rows('day_counts')).toBe(1);
    const migrationFiles = fs.readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql'));
    expect(await rows('schema_migrations')).toBe(migrationFiles.length);
  });

  it('C41: the length checks refuse an over-long key, pool, bucket, client and counter name', async () => {
    const timing = at(NOW_SECONDS);
    await expect(claimPayment(db, 'k'.repeat(201), NOW_SECONDS + 10n, 'a', timing)).rejects.toThrow(StoreError);
    expect(await claimPayment(db, 'k'.repeat(200), NOW_SECONDS + 10n, 'a', timing)).toBe('taken');
    await expect(takeLease(db, 'p'.repeat(201), 5, 60, NOW)).rejects.toThrow(StoreError);
    await expect(recordIfUnder(db, 'b'.repeat(41), 'client', 5, 60, NOW)).rejects.toThrow(StoreError);
    await expect(recordIfUnder(db, 'bucket', 'c'.repeat(65), 5, 60, NOW)).rejects.toThrow(StoreError);
    await expect(recordEvent(db, '', 'client', NOW)).rejects.toThrow(StoreError);
    await expect(bumpDay(db, 'n'.repeat(41), 5, NOW)).rejects.toThrow(StoreError);
    expect(await rows('payment_claims')).toBe(1);
    expect(await rows('leases')).toBe(0);
    expect(await rows('rate_events')).toBe(0);
    expect(await rows('day_counts')).toBe(0);
  });
});

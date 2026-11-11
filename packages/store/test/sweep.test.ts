// Not covered here: who runs sweep and how often (that is the next order's wiring), and a sweep racing a claim on a
// real Postgres. day_counts is outside sweep by design: it gains one row per counter name per UTC day, and the names
// are chosen by Thuli's code, never by a caller. schema_migrations is the schema's own record and must stay.
import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeCheck } from '../src/checkCache.ts';
import { openMemoryDb, StoreError, type Db } from '../src/db.ts';
import { bumpDay, recordEvent, recordIfUnder, takeLease } from '../src/limits.ts';
import { migrate } from '../src/migrate.ts';
import { claimPayment, keepPaymentUnsure, markPaymentUsed } from '../src/paymentClaims.ts';
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

  it('C41: a sweep far in the future empties every table outside input can grow', async () => {
    expect(await claimPayment(db, 'held', NOW_SECONDS + 300n, 'a', at(NOW_SECONDS))).toBe('taken');
    expect(await claimPayment(db, 'unsure', NOW_SECONDS + 300n, 'b', at(NOW_SECONDS))).toBe('taken');
    await keepPaymentUnsure(db, 'unsure', 'b');
    expect(await claimPayment(db, 'used', NOW_SECONDS + 300n, 'c', at(NOW_SECONDS))).toBe('taken');
    await markPaymentUsed(db, 'used', 'c');
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

// Not covered here: true parallel connections. PGlite runs one statement at a time, so the calls started together with
// Promise.all interleave transaction by transaction on one connection; they prove each ceiling is decided inside one
// transaction or one statement, not that the advisory locks hold between two connections. Set STORE_TEST_URL to a
// throwaway Postgres database to run every test below there too, with ten connections; that run empties every Thuli
// table in it. Without it, that run is skipped. Which client name a request gets is the API's job, not shown here.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectPostgres, openMemoryDb, StoreError, type Db } from '../src/db.ts';
import { bumpDay, countRecent, dayCount, dropLease, liveLeases, recordEvent, recordIfUnder, takeLease } from '../src/limits.ts';
import { migrate } from '../src/migrate.ts';

const REAL_URL = process.env.STORE_TEST_URL;
const TARGETS = [
  { name: 'in-memory PGlite', open: openMemoryDb },
  {
    name: 'Postgres at STORE_TEST_URL',
    open: REAL_URL === undefined || REAL_URL === '' ? undefined : async () => connectPostgres(REAL_URL, { max: 10 }),
  },
];

const NOW = new Date('2026-11-11T12:00:00.000Z');

function plus(seconds: number, from: Date = NOW): Date {
  return new Date(from.getTime() + seconds * 1000);
}

for (const { name, open } of TARGETS) {
  describe.skipIf(open === undefined)(`limits on ${name}`, () => {
    let db: Db;
    beforeAll(async () => {
      db = await (open ?? openMemoryDb)();
      await migrate(db);
    });
    beforeEach(async () => {
      await db.query('TRUNCATE payment_claims, leases, rate_events, day_counts, check_cache');
    });
    afterAll(async () => {
      await db.close();
    });

    it('C42: 50 recordIfUnder calls started together with max 20 give exactly 20 true', async () => {
      const results = await Promise.all(
        Array.from({ length: 50 }, () => recordIfUnder(db, 'paid-minute', '192.0.2.10', 20, 60, NOW)),
      );
      expect(results.filter(Boolean)).toHaveLength(20);
      expect(await countRecent(db, 'paid-minute', '192.0.2.10', 60, NOW)).toBe(20);
      expect(await recordIfUnder(db, 'paid-minute', '192.0.2.11', 20, 60, NOW)).toBe(true);
      expect(await recordIfUnder(db, 'free-minute', '192.0.2.10', 20, 60, NOW)).toBe(true);
    });

    it('C42: an event stops counting exactly windowSeconds later, and a refused call writes nothing', async () => {
      expect(await recordIfUnder(db, 'paid-minute', 'c', 1, 60, NOW)).toBe(true);
      expect(await recordIfUnder(db, 'paid-minute', 'c', 1, 60, plus(59.999))).toBe(false);
      expect(await countRecent(db, 'paid-minute', 'c', 60, plus(59.999))).toBe(1);
      expect(await recordIfUnder(db, 'paid-minute', 'c', 1, 60, plus(60))).toBe(true);
      const [row] = await db.query<{ events: number }>('SELECT count(*)::int AS events FROM rate_events');
      expect(row?.events).toBe(2);
    });

    it('C42: recordEvent counts with no ceiling and countRecent reads it back', async () => {
      for (let index = 0; index < 7; index += 1) await recordEvent(db, 'paid-failed', 'c', plus(index));
      expect(await countRecent(db, 'paid-failed', 'c', 3_600, plus(10))).toBe(7);
      expect(await countRecent(db, 'paid-failed', 'c', 3_600, plus(3_603))).toBe(3);
      expect(await countRecent(db, 'paid-failed', 'other', 3_600, plus(10))).toBe(0);
    });

    it('refuses a window longer than events are kept, and a max that is not a whole number', async () => {
      await expect(recordIfUnder(db, 'b', 'c', 1, 7_201, NOW)).rejects.toThrow(StoreError);
      await expect(countRecent(db, 'b', 'c', 7_201, NOW)).rejects.toThrow(StoreError);
      await expect(recordIfUnder(db, 'b', 'c', 1.5, 60, NOW)).rejects.toThrow(StoreError);
      await expect(recordIfUnder(db, 'b', 'c', 1, 60, new Date(Number.NaN))).rejects.toThrow(StoreError);
    });

    it('C24: 10 takeLease calls with max 4 give exactly 4 ids, and a fifth succeeds after one is dropped or expires', async () => {
      const ids = await Promise.all(Array.from({ length: 10 }, () => takeLease(db, 'paid-running', 4, 120, NOW)));
      const taken = ids.filter((id): id is string => id !== null);
      expect(taken).toHaveLength(4);
      expect(new Set(taken).size).toBe(4);
      expect(await takeLease(db, 'paid-running', 4, 120, plus(1))).toBeNull();
      expect(await takeLease(db, 'other-pool', 4, 120, plus(1))).not.toBeNull();

      await dropLease(db, 'not-a-lease');
      await dropLease(db, '00000000-0000-4000-8000-000000000000');
      expect(await takeLease(db, 'paid-running', 4, 120, plus(1))).toBeNull();
      await dropLease(db, taken[0] as string);
      const fifth = await takeLease(db, 'paid-running', 4, 120, plus(2));
      expect(fifth).not.toBeNull();
      expect(await takeLease(db, 'paid-running', 4, 120, plus(119.999))).toBeNull();

      // The three left from the first wave expire at 120 seconds; the fifth, taken at 2, is still live.
      const afterExpiry = await Promise.all(Array.from({ length: 5 }, () => takeLease(db, 'paid-running', 4, 120, plus(120))));
      expect(afterExpiry.filter((id) => id !== null)).toHaveLength(3);
      const [row] = await db.query<{ live: number }>("SELECT count(*)::int AS live FROM leases WHERE pool = 'paid-running'");
      expect(row?.live).toBe(4);
    });

    it('C24: liveLeases agrees with takeLease before and after an expiry and a drop, and writes nothing', async () => {
      // takeLease with max equal to the live count finds no room, so it confirms the count without adding a lease.
      const agree = async (at: Date, live: number) => {
        expect(await liveLeases(db, 'paid-running', at)).toBe(live);
        expect(await takeLease(db, 'paid-running', live, 120, at)).toBeNull();
      };
      await agree(NOW, 0);
      expect(await takeLease(db, 'paid-running', 4, 120, NOW)).not.toBeNull();
      const second = (await takeLease(db, 'paid-running', 4, 120, plus(60))) as string;
      expect(await takeLease(db, 'other-pool', 4, 120, plus(60))).not.toBeNull();
      await agree(plus(60), 2);
      await agree(plus(119.999), 2);
      await agree(plus(120), 1);
      await dropLease(db, second);
      await agree(plus(121), 0);
      expect(await takeLease(db, 'paid-running', 1, 120, plus(121))).not.toBeNull();
      expect(await liveLeases(db, 'paid-running', plus(121))).toBe(1);
      expect(await liveLeases(db, 'other-pool', plus(121))).toBe(1);
      const [row] = await db.query<{ leases: number }>('SELECT count(*)::int AS leases FROM leases');
      expect(row?.leases).toBe(2);
      await expect(liveLeases(db, 'paid-running', new Date(Number.NaN))).rejects.toThrow(StoreError);
    });

    it('C24: bumpDay stops at max and starts again on the next UTC day', async () => {
      const lateInDay = new Date('2026-11-11T23:59:59.999Z');
      const results = await Promise.all(Array.from({ length: 10 }, () => bumpDay(db, 'paid-screenings', 6, NOW)));
      expect(results.filter(Boolean)).toHaveLength(6);
      expect(await bumpDay(db, 'paid-screenings', 6, lateInDay)).toBe(false);
      expect(await dayCount(db, 'paid-screenings', lateInDay)).toBe(6);
      const nextDay = new Date('2026-11-12T00:00:00.000Z');
      expect(await dayCount(db, 'paid-screenings', nextDay)).toBe(0);
      expect(await bumpDay(db, 'paid-screenings', 6, nextDay)).toBe(true);
      expect(await dayCount(db, 'paid-screenings', nextDay)).toBe(1);
      expect(await dayCount(db, 'paid-screenings', NOW)).toBe(6);
      expect(await bumpDay(db, 'free-checks', 0, NOW)).toBe(false);
      expect(await dayCount(db, 'free-checks', NOW)).toBe(0);
    });
  });
}

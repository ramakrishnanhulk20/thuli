// Not covered here: true parallel connections. PGlite runs one statement at a time, so the claims started together
// with Promise.all interleave transaction by transaction on one connection; they prove the decision is made inside one
// transaction, not that the advisory lock holds between two connections. Set STORE_TEST_URL to a throwaway Postgres
// database to run every test below there too, with ten connections; that run empties every Thuli table in it. Without
// it, that run is skipped. The facilitator and the paid route that call these functions are not here.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectPostgres, openMemoryDb, StoreError, type Db } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import {
  claimPayment,
  keepPaymentUnsure,
  markPaymentUsed,
  MAX_PAYMENT_CLAIMS,
  releasePayment,
  type ClaimTiming,
} from '../src/paymentClaims.ts';

const REAL_URL = process.env.STORE_TEST_URL;
const TARGETS = [
  { name: 'in-memory PGlite', open: openMemoryDb },
  {
    name: 'Postgres at STORE_TEST_URL',
    open: REAL_URL === undefined || REAL_URL === '' ? undefined : async () => connectPostgres(REAL_URL, { max: 10 }),
  },
];

const NOW = 1_800_000_000n;
const LATEST = 330n;
const KEY = 'eip155:8453|0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913|0x1111111111111111111111111111111111111111|0xab';

function at(nowSeconds: bigint): ClaimTiming {
  return { nowSeconds, latestSeconds: LATEST };
}

for (const { name, open } of TARGETS) {
  describe.skipIf(open === undefined)(`payment claims on ${name}`, () => {
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

    async function row(key: string): Promise<{ state: string; owner: string | null; valid_before: string } | undefined> {
      const [found] = await db.query<{ state: string; owner: string | null; valid_before: string }>(
        'SELECT state, owner, valid_before::text AS valid_before FROM payment_claims WHERE key = $1',
        [key],
      );
      return found;
    }

    it('C25: 20 claims on one key from different owners, started together, give exactly one taken', async () => {
      const owners = Array.from({ length: 20 }, (_, index) => `request-${index}`);
      const results = await Promise.all(owners.map((owner) => claimPayment(db, KEY, NOW + 300n, owner, at(NOW))));
      expect(results.filter((result) => result === 'taken')).toHaveLength(1);
      expect(results.filter((result) => result === 'in-use')).toHaveLength(19);
      const winner = owners[results.indexOf('taken')];
      expect(await row(KEY)).toEqual({ state: 'held', owner: winner, valid_before: (NOW + 300n).toString() });
    });

    it('C25: a used key stays in-use until its validBefore passes, then a fresh claim replaces it', async () => {
      expect(await claimPayment(db, KEY, NOW + 300n, 'first', at(NOW))).toBe('taken');
      await markPaymentUsed(db, KEY, 'first');
      expect(await row(KEY)).toEqual({ state: 'used', owner: null, valid_before: (NOW + 300n).toString() });
      expect(await claimPayment(db, KEY, NOW + 300n, 'copy', at(NOW + 299n))).toBe('in-use');
      expect(await claimPayment(db, KEY, NOW + 300n, 'copy', at(NOW + 300n))).toBe('expired');
      expect(await claimPayment(db, KEY, NOW + 400n, 'later', at(NOW + 300n))).toBe('taken');
      expect(await row(KEY)).toEqual({ state: 'held', owner: 'later', valid_before: (NOW + 400n).toString() });
    });

    it('C25: a held key is never replaced, even past its validBefore', async () => {
      expect(await claimPayment(db, KEY, NOW + 10n, 'slow', at(NOW))).toBe('taken');
      expect(await claimPayment(db, KEY, NOW + 50n, 'other', at(NOW + 20n))).toBe('in-use');
      expect((await row(KEY))?.owner).toBe('slow');
    });

    it('C25: an unsure key is taken by a new owner, keeps the later validBefore, and the old owner can no longer act', async () => {
      expect(await claimPayment(db, KEY, NOW + 300n, 'first', at(NOW))).toBe('taken');
      await keepPaymentUnsure(db, KEY, 'first');
      expect(await row(KEY)).toEqual({ state: 'unsure', owner: null, valid_before: (NOW + 300n).toString() });
      expect(await claimPayment(db, KEY, NOW + 100n, 'retry', at(NOW + 10n))).toBe('taken');
      expect(await row(KEY)).toEqual({ state: 'held', owner: 'retry', valid_before: (NOW + 300n).toString() });
      await markPaymentUsed(db, KEY, 'first');
      await keepPaymentUnsure(db, KEY, 'first');
      await releasePayment(db, KEY, 'first');
      expect(await row(KEY)).toEqual({ state: 'held', owner: 'retry', valid_before: (NOW + 300n).toString() });
    });

    it('C25: release frees the key only for its holder', async () => {
      expect(await claimPayment(db, KEY, NOW + 300n, 'holder', at(NOW))).toBe('taken');
      await releasePayment(db, KEY, 'stranger');
      expect(await claimPayment(db, KEY, NOW + 300n, 'next', at(NOW))).toBe('in-use');
      await releasePayment(db, KEY, 'holder');
      expect(await row(KEY)).toBeUndefined();
      expect(await claimPayment(db, KEY, NOW + 300n, 'next', at(NOW))).toBe('taken');
      await markPaymentUsed(db, KEY, 'next');
      await releasePayment(db, KEY, 'next');
      expect((await row(KEY))?.state).toBe('used');
    });

    it("C25: 'expired' and 'too-long' are answered before anything is written", async () => {
      expect(await claimPayment(db, KEY, NOW, 'a', at(NOW))).toBe('expired');
      expect(await claimPayment(db, KEY, NOW - 1n, 'a', at(NOW))).toBe('expired');
      expect(await claimPayment(db, KEY, NOW + LATEST + 1n, 'a', at(NOW))).toBe('too-long');
      expect(await claimPayment(db, 'x'.repeat(201), NOW, 'a', at(NOW))).toBe('expired');
      expect(await db.query('SELECT key FROM payment_claims')).toEqual([]);
      expect(await claimPayment(db, KEY, NOW + LATEST, 'a', at(NOW))).toBe('taken');
    });

    it('refuses an empty or over-long owner for a new claim', async () => {
      await expect(claimPayment(db, KEY, NOW + 300n, '', at(NOW))).rejects.toThrow(StoreError);
      await expect(claimPayment(db, KEY, NOW + 300n, 'o'.repeat(65), at(NOW))).rejects.toThrow(StoreError);
      expect(await row(KEY)).toBeUndefined();
    });

    it('C41: at the cap, due claims are cleared first, and full is answered only while still at the cap', { timeout: 60_000 }, async () => {
      await db.query(
        `INSERT INTO payment_claims (key, state, owner, valid_before, updated_at)
         SELECT 'filler-' || n, 'used', NULL, $1::bigint, to_timestamp($2::bigint) FROM generate_series(1, $3::int) AS n`,
        [(NOW + 100n).toString(), NOW.toString(), MAX_PAYMENT_CLAIMS],
      );
      expect(await claimPayment(db, KEY, NOW + 300n, 'new', at(NOW))).toBe('full');
      await db.query("UPDATE payment_claims SET valid_before = $1::bigint WHERE key = 'filler-1'", [NOW.toString()]);
      expect(await claimPayment(db, KEY, NOW + 300n, 'new', at(NOW))).toBe('taken');
      const [count] = await db.query<{ claims: number }>('SELECT count(*)::int AS claims FROM payment_claims');
      expect(count?.claims).toBe(MAX_PAYMENT_CLAIMS);
      expect(await row('filler-1')).toBeUndefined();
    });
  });
}

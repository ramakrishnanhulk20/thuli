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
  leaveSettledPayment,
  markPaymentSettled,
  MAX_PAYMENT_CLAIMS,
  PAID_RESULT_KEEP_SECONDS,
  redeemPayment,
  releasePayment,
  servePayment,
  type ClaimTiming,
  type OwnerTiming,
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

function owned(nowSeconds: bigint): OwnerTiming {
  return { nowSeconds, ownedUntil: nowSeconds + LATEST };
}

const WALLET = '0x041f77015fe51c51aE49a7f2F3Ff86C641fa190a';
const OTHER_WALLET = '0x5555555555555555555555555555555555555555';
const TX = `0x${'5e'.repeat(32)}`;
const SETTLEMENT = { wallet: WALLET, transaction: TX };
const DAY = BigInt(PAID_RESULT_KEEP_SECONDS);

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

    it('C25: a used key, as the code before migration 004 wrote it, stays in-use until its validBefore passes, then a fresh claim replaces it, and it is never redeemed', async () => {
      await db.query(
        `INSERT INTO payment_claims (key, state, owner, valid_before, updated_at)
         VALUES ($1, 'used', NULL, $2::bigint, to_timestamp($3::bigint))`,
        [KEY, (NOW + 300n).toString(), NOW.toString()],
      );
      expect(await redeemPayment(db, KEY, WALLET, 'copy', owned(NOW + 1n))).toEqual({ found: 'none' });
      expect(await claimPayment(db, KEY, NOW + 300n, 'copy', at(NOW + 299n))).toBe('in-use');
      expect(await claimPayment(db, KEY, NOW + 300n, 'copy', at(NOW + 300n))).toBe('expired');
      expect(await claimPayment(db, KEY, NOW + 400n, 'later', at(NOW + 300n))).toBe('taken');
      expect(await row(KEY)).toEqual({ state: 'held', owner: 'later', valid_before: (NOW + 400n).toString() });
    });

    it('C25: a settled key keeps its wallet, transaction and second, stays in-use long past its validBefore, and is replaced only a day after it settled', async () => {
      expect(await claimPayment(db, KEY, NOW + 300n, 'first', at(NOW))).toBe('taken');
      await markPaymentSettled(db, KEY, 'first', { wallet: WALLET.toLowerCase(), transaction: TX }, owned(NOW));
      const [settled] = await db.query('SELECT state, owner, wallet, tx, settled_at::text AS settled_at, owned_until::text AS owned_until FROM payment_claims');
      expect(settled).toEqual({ state: 'settled', owner: 'first', wallet: WALLET, tx: TX, settled_at: NOW.toString(), owned_until: (NOW + LATEST).toString() });
      expect(await claimPayment(db, KEY, NOW + 600n, 'copy', at(NOW + 301n))).toBe('in-use');
      expect(await claimPayment(db, KEY, NOW + DAY + 300n, 'copy', at(NOW + DAY - 1n))).toBe('in-use');
      expect(await claimPayment(db, KEY, NOW + DAY + 300n, 'later', at(NOW + DAY))).toBe('taken');
      expect((await row(KEY))?.state).toBe('held');
    });

    it('C25: 20 redeems of one settled key at once give exactly one settled, and a served key answers every one with its stored body', async () => {
      expect(await claimPayment(db, KEY, NOW + 300n, 'payer', at(NOW))).toBe('taken');
      await markPaymentSettled(db, KEY, 'payer', SETTLEMENT, owned(NOW));
      await leaveSettledPayment(db, KEY, 'payer');
      const owners = Array.from({ length: 20 }, (_, index) => `redeem-${index}`);
      const results = await Promise.all(owners.map((owner) => redeemPayment(db, KEY, WALLET, owner, owned(NOW + 10n))));
      expect(results.filter((result) => result.found === 'settled')).toEqual([{ found: 'settled', transaction: TX }]);
      expect(results.filter((result) => result.found === 'in-use')).toHaveLength(19);
      const winner = owners[results.findIndex((result) => result.found === 'settled')] as string;
      expect((await row(KEY))?.owner).toBe(winner);

      // Only the owner stores the result, and from then on every redeem, at once or later, gets exactly that body.
      await servePayment(db, KEY, 'stranger', { wrong: true });
      await servePayment(db, KEY, winner, { decision: 'kept', list: [1, 2] });
      const fetched = await Promise.all(owners.map((owner) => redeemPayment(db, KEY, WALLET, owner, owned(NOW + 20n))));
      for (const result of fetched) expect(result).toEqual({ found: 'served', transaction: TX, body: { decision: 'kept', list: [1, 2] } });
      expect(await row(KEY)).toEqual({ state: 'served', owner: null, valid_before: (NOW + 300n).toString() });
    });

    it('C24: a settled key redeems only for its own wallet, in any spelling of it, and never past its day', async () => {
      expect(await claimPayment(db, KEY, NOW + 300n, 'payer', at(NOW))).toBe('taken');
      await markPaymentSettled(db, KEY, 'payer', SETTLEMENT, owned(NOW));
      await leaveSettledPayment(db, KEY, 'payer');
      expect(await redeemPayment(db, KEY, OTHER_WALLET, 'other', owned(NOW + 1n))).toEqual({ found: 'refused' });
      expect(await redeemPayment(db, KEY, WALLET, 'late', owned(NOW + DAY))).toEqual({ found: 'none' });
      expect(await redeemPayment(db, KEY, WALLET.toLowerCase(), 'same', owned(NOW + DAY - 1n))).toEqual({ found: 'settled', transaction: TX });
      expect(await redeemPayment(db, 'no-such-key', WALLET, 'same', owned(NOW))).toEqual({ found: 'none' });
      await expect(redeemPayment(db, KEY, 'not-an-address', 'same', owned(NOW))).rejects.toThrow();
      await expect(redeemPayment(db, KEY, WALLET, 'same', { nowSeconds: NOW, ownedUntil: NOW })).rejects.toThrow(StoreError);
    });

    it('C25: an owner that leaves frees the key at once, an owner past its lease is taken over, and a late write from it changes nothing', async () => {
      expect(await claimPayment(db, KEY, NOW + 300n, 'payer', at(NOW))).toBe('taken');
      await markPaymentSettled(db, KEY, 'payer', SETTLEMENT, owned(NOW));
      // Its own wallet hears in-use while the owner lives; another wallet is refused all the same.
      expect(await redeemPayment(db, KEY, WALLET, 'copy', owned(NOW + LATEST - 1n))).toEqual({ found: 'in-use' });
      expect(await redeemPayment(db, KEY, OTHER_WALLET, 'other', owned(NOW + LATEST - 1n))).toEqual({ found: 'refused' });
      expect(await redeemPayment(db, KEY, WALLET, 'copy', owned(NOW + LATEST))).toEqual({ found: 'settled', transaction: TX });
      await leaveSettledPayment(db, KEY, 'payer');
      await servePayment(db, KEY, 'payer', { late: true });
      expect((await row(KEY))?.owner).toBe('copy');
      await leaveSettledPayment(db, KEY, 'copy');
      expect(await row(KEY)).toEqual({ state: 'settled', owner: null, valid_before: (NOW + 300n).toString() });
      expect(await redeemPayment(db, KEY, WALLET, 'next', owned(NOW + LATEST + 1n))).toEqual({ found: 'settled', transaction: TX });
    });

    it('refuses a settled result that is null, a transaction that is not lowercase hex, and a result over 16 KB', async () => {
      expect(await claimPayment(db, KEY, NOW + 300n, 'payer', at(NOW))).toBe('taken');
      await expect(markPaymentSettled(db, KEY, 'payer', { wallet: WALLET, transaction: TX.toUpperCase() }, owned(NOW))).rejects.toThrow(StoreError);
      await markPaymentSettled(db, KEY, 'payer', SETTLEMENT, owned(NOW));
      await expect(servePayment(db, KEY, 'payer', null)).rejects.toThrow(StoreError);
      await expect(servePayment(db, KEY, 'payer', { text: 'x'.repeat(17_000) })).rejects.toThrow(StoreError);
      expect((await row(KEY))?.state).toBe('settled');
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
      await markPaymentSettled(db, KEY, 'first', SETTLEMENT, owned(NOW + 10n));
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
      await markPaymentSettled(db, KEY, 'next', SETTLEMENT, owned(NOW));
      await releasePayment(db, KEY, 'next');
      expect((await row(KEY))?.state).toBe('settled');
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

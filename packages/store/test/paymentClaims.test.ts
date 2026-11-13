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
  MAX_NAMED_TXS,
  MAX_PAYMENT_CLAIMS,
  namedPaymentTxs,
  PAID_RESULT_KEEP_SECONDS,
  REDEEM_SCREEN_TRIES,
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

    async function screenings(): Promise<number | undefined> {
      const [found] = await db.query<{ screenings: number }>('SELECT screenings FROM payment_claims WHERE key = $1', [KEY]);
      return found?.screenings;
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
      // The settling request's leave without a hand-back kept its try, so the winner starts the second.
      expect(results.filter((result) => result.found === 'settled')).toEqual([{ found: 'settled', transaction: TX, screening: 2 }]);
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
      expect(await redeemPayment(db, KEY, WALLET.toLowerCase(), 'same', owned(NOW + DAY - 1n))).toEqual({ found: 'settled', transaction: TX, screening: 2 });
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
      expect(await redeemPayment(db, KEY, WALLET, 'copy', owned(NOW + LATEST))).toEqual({ found: 'settled', transaction: TX, screening: 2 });
      // The old owner can neither leave nor hand its try back nor store a result any more.
      await leaveSettledPayment(db, KEY, 'payer', true);
      await servePayment(db, KEY, 'payer', { late: true });
      expect((await row(KEY))?.owner).toBe('copy');
      expect(await screenings()).toBe(2);
      await leaveSettledPayment(db, KEY, 'copy');
      expect(await row(KEY)).toEqual({ state: 'settled', owner: null, valid_before: (NOW + 300n).toString() });
      // Both tries are used, so the next copy owns it only to store the time-up hold, and counts nothing.
      expect(await redeemPayment(db, KEY, WALLET, 'next', owned(NOW + LATEST + 1n))).toEqual({ found: 'spent', transaction: TX });
      expect(await screenings()).toBe(2);
      expect((await row(KEY))?.owner).toBe('next');
    });

    it('C26: counts one screening per taking of the claim, gives back only the owner\'s unstarted try, and answers spent at REDEEM_SCREEN_TRIES', async () => {
      expect(REDEEM_SCREEN_TRIES).toBe(2);
      expect(await claimPayment(db, KEY, NOW + 300n, 'payer', at(NOW))).toBe('taken');
      expect(await screenings()).toBe(0);
      await markPaymentSettled(db, KEY, 'payer', SETTLEMENT, owned(NOW));
      expect(await screenings()).toBe(1);
      // The settling request had no time to screen, so its try goes back and the next copy starts the first screening.
      await leaveSettledPayment(db, KEY, 'stranger', true);
      expect(await screenings()).toBe(1);
      await leaveSettledPayment(db, KEY, 'payer', true);
      expect(await screenings()).toBe(0);
      expect(await redeemPayment(db, KEY, WALLET, 'one', owned(NOW + 1n))).toEqual({ found: 'settled', transaction: TX, screening: 1 });
      await leaveSettledPayment(db, KEY, 'one');
      expect(await redeemPayment(db, KEY, WALLET, 'two', owned(NOW + 2n))).toEqual({ found: 'settled', transaction: TX, screening: 2 });
      await leaveSettledPayment(db, KEY, 'two');
      // Spent: twenty copies at once get one owner between them and none starts a third screening.
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) => redeemPayment(db, KEY, WALLET, `late-${index}`, owned(NOW + 3n))),
      );
      expect(results.filter((result) => result.found === 'spent')).toEqual([{ found: 'spent', transaction: TX }]);
      expect(results.filter((result) => result.found === 'in-use')).toHaveLength(19);
      expect(await screenings()).toBe(2);
      // An owner that took a spent claim counted no try, so even asking to hand one back cannot reopen a screening.
      const spentOwner = `late-${results.findIndex((result) => result.found === 'spent')}`;
      await leaveSettledPayment(db, KEY, spentOwner, true);
      expect(await screenings()).toBe(2);
      expect(await redeemPayment(db, KEY, WALLET, 'spent-again', owned(NOW + 3n))).toEqual({ found: 'spent', transaction: TX });
      await servePayment(db, KEY, 'spent-again', { hold: 'ran out of time' });
      expect(await redeemPayment(db, KEY, WALLET, 'after', owned(NOW + 4n))).toEqual({
        found: 'served',
        transaction: TX,
        body: { hold: 'ran out of time' },
      });
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

    it('C25: keeps the transactions named for an unsure claim for its next holder, refuses a bad hash, and takes an expired authorization only while one waits', async () => {
      const named = `0x${'7a'.repeat(32)}`;
      expect(await claimPayment(db, KEY, NOW + 300n, 'first', at(NOW))).toBe('taken');
      await expect(keepPaymentUnsure(db, KEY, 'first', ['0xabc'])).rejects.toThrow(StoreError);
      await expect(keepPaymentUnsure(db, KEY, 'first', [`0x${'7A'.repeat(32)}`])).rejects.toThrow(StoreError);
      await expect(keepPaymentUnsure(db, KEY, 'first', Array.from({ length: MAX_NAMED_TXS + 1 }, () => named))).rejects.toThrow(StoreError);
      expect((await row(KEY))?.state).toBe('held');

      await keepPaymentUnsure(db, KEY, 'first', [named]);
      expect(await namedPaymentTxs(db, KEY, 'first')).toEqual([]);
      expect(await claimPayment(db, KEY, NOW + 300n, 'second', at(NOW + 1n))).toBe('taken');
      expect(await namedPaymentTxs(db, KEY, 'second')).toEqual([named]);
      expect(await namedPaymentTxs(db, KEY, 'first')).toEqual([]);
      await keepPaymentUnsure(db, KEY, 'second');

      // Past its validBefore the authorization cannot be settled, and is taken only to read that receipt, for a day.
      expect(await claimPayment(db, KEY, NOW + 300n, 'late', at(NOW + 300n + DAY - 1n))).toBe('taken');
      expect(await namedPaymentTxs(db, KEY, 'late')).toEqual([named]);
      await keepPaymentUnsure(db, KEY, 'late');
      expect(await claimPayment(db, KEY, NOW + 300n, 'gone', at(NOW + 300n + DAY))).toBe('expired');

      // With nothing named, an unsure claim ends with its authorization.
      const bare = `${KEY}-bare`;
      expect(await claimPayment(db, bare, NOW + 300n, 'a', at(NOW))).toBe('taken');
      await keepPaymentUnsure(db, bare, 'a');
      expect(await claimPayment(db, bare, NOW + 300n, 'b', at(NOW + 300n))).toBe('expired');
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

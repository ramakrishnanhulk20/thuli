import { parseAddress } from '@thuli/core';
import { StoreError, type Db, type Queryable } from './db.ts';

/** Claims remembered at once (C41). Past this, with none due, a new payment is refused as full. */
export const MAX_PAYMENT_CLAIMS = 100_000;

/**
 * How long a settled payment can be redeemed, and its stored result fetched again, counted from the second it settled
 * (C25). Sweep keeps such a claim for exactly this long and no longer (C41).
 */
export const PAID_RESULT_KEEP_SECONDS = 86_400;

export type ClaimResult = 'taken' | 'in-use' | 'expired' | 'too-long' | 'full';

/** latestSeconds is the route's timeout plus the clock allowance: the furthest validBefore a claim accepts. */
export interface ClaimTiming {
  nowSeconds: bigint;
  latestSeconds: bigint;
}

/** ownedUntil is the second by which the request taking the claim has surely ended, so the claim frees itself then. */
export interface OwnerTiming {
  nowSeconds: bigint;
  ownedUntil: bigint;
}

/** What a payment that went through bought: the wallet it was for and the settlement transaction. */
export interface Settlement {
  wallet: string;
  transaction: string;
}

/**
 * What redeemPayment found for a key. none: no settled payment within its day, so the header goes the way of any new
 * payment. refused: settled for another wallet, or another request is screening it. settled: the caller now screens it.
 * served: the stored result, as it was written.
 */
export type Redeemed =
  | { found: 'none' }
  | { found: 'refused' }
  | { found: 'settled'; transaction: string }
  | { found: 'served'; transaction: string; body: unknown };

async function claimCount(tx: Queryable): Promise<number> {
  const [row] = await tx.query<{ claims: number }>('SELECT count(*)::int AS claims FROM payment_claims');
  return row?.claims ?? 0;
}

// A settled or served claim outlives its authorization: it stays a whole day from its settlement, so the buyer can
// always come back for the result inside that day.
function isDue(entry: { state: string; valid_before: string; settled_at: string | null }, nowSeconds: bigint): boolean {
  const kept = entry.settled_at !== null && BigInt(entry.settled_at) + BigInt(PAID_RESULT_KEEP_SECONDS) > nowSeconds;
  return entry.state !== 'held' && BigInt(entry.valid_before) <= nowSeconds && !kept;
}

/**
 * Takes the claim on one payment authorization for owner (threat model C25), shared by every server copy. The same
 * steps and answers as PaymentClaims.claim in packages/api/src/claims.ts:
 * - 'expired' when validBefore is at or before nowSeconds, and 'too-long' when it is past nowSeconds plus
 *   latestSeconds. Neither writes anything.
 * - A row that is not held and whose validBefore has passed is treated as absent and replaced, unless it settled less
 *   than PAID_RESULT_KEEP_SECONDS ago.
 * - An 'unsure' row is taken over by owner and keeps the later of the two validBefore values. Any other row is
 *   'in-use'.
 * - At MAX_PAYMENT_CLAIMS rows, the due ones are deleted first, and the answer is 'full' if it is still at the cap.
 * The decision runs in one transaction under an advisory lock on the key, and a new row also under one lock on the
 * cap, so copies of one authorization started together get exactly one 'taken'.
 * @param key at most 200 characters; owner at most 64, naming the one request settling it.
 * @throws StoreError when the key or owner is empty or too long, or the database refuses.
 */
export async function claimPayment(
  db: Db,
  key: string,
  validBefore: bigint,
  owner: string,
  timing: ClaimTiming,
): Promise<ClaimResult> {
  const { nowSeconds, latestSeconds } = timing;
  if (validBefore <= nowSeconds) return 'expired';
  if (validBefore > nowSeconds + latestSeconds) return 'too-long';
  const now = nowSeconds.toString();
  const before = validBefore.toString();
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(1001, hashtext($1))', [key]);
    let [entry] = await tx.query<{ state: string; valid_before: string; settled_at: string | null }>(
      'SELECT state, valid_before::text AS valid_before, settled_at::text AS settled_at FROM payment_claims WHERE key = $1',
      [key],
    );
    if (entry !== undefined && isDue(entry, nowSeconds)) {
      await tx.query('DELETE FROM payment_claims WHERE key = $1', [key]);
      entry = undefined;
    }
    if (entry !== undefined) {
      if (entry.state !== 'unsure') return 'in-use';
      await tx.query(
        `UPDATE payment_claims
            SET state = 'held', owner = $2, valid_before = GREATEST(valid_before, $3::bigint), updated_at = to_timestamp($4::bigint)
          WHERE key = $1`,
        [key, owner, before, now],
      );
      return 'taken';
    }
    // Different keys run side by side, so counting toward the cap needs its own lock to stay exact.
    await tx.query('SELECT pg_advisory_xact_lock(1002, 0)');
    if ((await claimCount(tx)) >= MAX_PAYMENT_CLAIMS) {
      await tx.query(
        `DELETE FROM payment_claims
          WHERE state <> 'held' AND valid_before <= $1::bigint AND (settled_at IS NULL OR settled_at <= $2::bigint)`,
        [now, (nowSeconds - BigInt(PAID_RESULT_KEEP_SECONDS)).toString()],
      );
      if ((await claimCount(tx)) >= MAX_PAYMENT_CLAIMS) return 'full';
    }
    await tx.query(
      `INSERT INTO payment_claims (key, state, owner, valid_before, updated_at)
       VALUES ($1, 'held', $2, $3::bigint, to_timestamp($4::bigint))`,
      [key, owner, before, now],
    );
    return 'taken';
  });
}

function ownerTiming({ nowSeconds, ownedUntil }: OwnerTiming): [string, string] {
  if (ownedUntil <= nowSeconds) throw new StoreError('ownedUntil must be after nowSeconds');
  return [nowSeconds.toString(), ownedUntil.toString()];
}

/**
 * Looks for a payment of key that already went through, for a request that carries its header again (C25). Inside
 * PAID_RESULT_KEEP_SECONDS from the settlement, and only for the wallet the payment was for: a served claim answers
 * with its stored result, and a settled one no other live request owns is taken by owner until ownedUntil, to screen
 * it. Runs in one transaction under the key's advisory lock, so of two requests started together at most one gets
 * 'settled'. Writes nothing unless it answers 'settled'. A row in any other state, or settled more than a day ago, is
 * 'none'.
 * @param wallet compared in its canonical form, the only form markPaymentSettled stores.
 * @throws AddressError from @thuli/core when wallet is not an address. StoreError when ownedUntil is not after
 *   nowSeconds, the owner is empty or too long, or the database refuses.
 */
export async function redeemPayment(db: Db, key: string, wallet: string, owner: string, timing: OwnerTiming): Promise<Redeemed> {
  const paidFor = parseAddress(wallet);
  const [now, until] = ownerTiming(timing);
  return db.transaction(async (tx): Promise<Redeemed> => {
    await tx.query('SELECT pg_advisory_xact_lock(1001, hashtext($1))', [key]);
    const [entry] = await tx.query<{
      state: string;
      wallet: string | null;
      tx: string | null;
      settled_at: string | null;
      owner: string | null;
      owned_until: string | null;
      result: unknown;
    }>(
      `SELECT state, wallet, tx, settled_at::text AS settled_at, owner, owned_until::text AS owned_until, result
         FROM payment_claims WHERE key = $1`,
      [key],
    );
    if (entry === undefined || (entry.state !== 'settled' && entry.state !== 'served')) return { found: 'none' };
    // The table's checks make these three present in both states; a row without them is refused, never guessed at.
    if (entry.settled_at === null || entry.tx === null || entry.wallet === null) return { found: 'refused' };
    if (BigInt(entry.settled_at) + BigInt(PAID_RESULT_KEEP_SECONDS) <= timing.nowSeconds) return { found: 'none' };
    if (entry.wallet !== paidFor) return { found: 'refused' };
    if (entry.state === 'served') return { found: 'served', transaction: entry.tx, body: entry.result };
    if (entry.owner !== null && entry.owned_until !== null && BigInt(entry.owned_until) > timing.nowSeconds) {
      return { found: 'refused' };
    }
    await tx.query(
      'UPDATE payment_claims SET owner = $2, owned_until = $3::bigint, updated_at = to_timestamp($4::bigint) WHERE key = $1',
      [key, owner, until, now],
    );
    return { found: 'settled', transaction: entry.tx };
  });
}

/**
 * The settlement for key went through. The claim becomes settled, with the wallet and transaction it paid for and
 * nowSeconds as the second it settled, and stays owned by owner until ownedUntil while that request screens it. Every
 * copy is refused from now on except a redeem of the same wallet. Does nothing unless owner holds the key.
 * @throws AddressError when the wallet is not an address. StoreError when the transaction is not 0x and 64 lowercase
 *   hex characters, ownedUntil is not after nowSeconds, or the database refuses.
 */
export async function markPaymentSettled(db: Db, key: string, owner: string, settlement: Settlement, timing: OwnerTiming): Promise<void> {
  const wallet = parseAddress(settlement.wallet);
  const [now, until] = ownerTiming(timing);
  await db.query(
    `UPDATE payment_claims
        SET state = 'settled', wallet = $3, tx = $4, settled_at = $5::bigint, owned_until = $6::bigint, updated_at = to_timestamp($5::bigint)
      WHERE key = $1 AND state = 'held' AND owner = $2`,
    [key, owner, wallet, settlement.transaction, now, until],
  );
}

/**
 * Stores the result a settled payment bought, and frees the claim: from now on a redeem of its header answers with
 * exactly this body. Does nothing unless owner owns the settled key. updated_at keeps the time of the last owner,
 * because this step is handed no time.
 * @param body any JSON value except null.
 * @throws StoreError when body is null or cannot be written as JSON, is over the table's 16 KB, or the database refuses.
 */
export async function servePayment(db: Db, key: string, owner: string, body: unknown): Promise<void> {
  let json: string | undefined;
  try {
    json = JSON.stringify(body);
  } catch {
    throw new StoreError('the paid result cannot be written as JSON');
  }
  if (json === undefined || body === null) throw new StoreError('the paid result must be a JSON value other than null');
  await db.query(
    `UPDATE payment_claims SET state = 'served', result = $3::jsonb, owner = NULL, owned_until = NULL
      WHERE key = $1 AND state = 'settled' AND owner = $2`,
    [key, owner, json],
  );
}

/**
 * The request screening a settled payment ends without a result. The claim stays settled, owned by no request, so the
 * next request with its header screens it at once. Does nothing unless owner owns the settled key.
 */
export async function leaveSettledPayment(db: Db, key: string, owner: string): Promise<void> {
  await db.query(
    "UPDATE payment_claims SET owner = NULL, owned_until = NULL WHERE key = $1 AND state = 'settled' AND owner = $2",
    [key, owner],
  );
}

/**
 * The settlement's outcome is unknown. The claim stays, owned by no request, so a retry of the same authorization can
 * take it and ask again. Does nothing unless owner holds the key.
 */
export async function keepPaymentUnsure(db: Db, key: string, owner: string): Promise<void> {
  await db.query(
    "UPDATE payment_claims SET state = 'unsure', owner = NULL WHERE key = $1 AND state = 'held' AND owner = $2",
    [key, owner],
  );
}

/** The settlement failed outright. Frees the key for an honest retry, but only when owner holds it. */
export async function releasePayment(db: Db, key: string, owner: string): Promise<void> {
  await db.query("DELETE FROM payment_claims WHERE key = $1 AND state = 'held' AND owner = $2", [key, owner]);
}

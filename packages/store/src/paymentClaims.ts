import type { Db, Queryable } from './db.ts';

/** Claims remembered at once (C41). Past this, with none due, a new payment is refused as full. */
export const MAX_PAYMENT_CLAIMS = 100_000;

export type ClaimResult = 'taken' | 'in-use' | 'expired' | 'too-long' | 'full';

/** latestSeconds is the route's timeout plus the clock allowance: the furthest validBefore a claim accepts. */
export interface ClaimTiming {
  nowSeconds: bigint;
  latestSeconds: bigint;
}

async function claimCount(tx: Queryable): Promise<number> {
  const [row] = await tx.query<{ claims: number }>('SELECT count(*)::int AS claims FROM payment_claims');
  return row?.claims ?? 0;
}

/**
 * Takes the claim on one payment authorization for owner (threat model C25), shared by every server copy. The same
 * steps and answers as PaymentClaims.claim in packages/api/src/claims.ts:
 * - 'expired' when validBefore is at or before nowSeconds, and 'too-long' when it is past nowSeconds plus
 *   latestSeconds. Neither writes anything.
 * - A row that is not held and whose validBefore has passed is treated as absent and replaced.
 * - An 'unsure' row is taken over by owner and keeps the later of the two validBefore values. A held or used row is
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
    let [entry] = await tx.query<{ state: string; valid_before: string }>(
      'SELECT state, valid_before::text AS valid_before FROM payment_claims WHERE key = $1',
      [key],
    );
    if (entry !== undefined && entry.state !== 'held' && BigInt(entry.valid_before) <= nowSeconds) {
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
      await tx.query("DELETE FROM payment_claims WHERE state <> 'held' AND valid_before <= $1::bigint", [now]);
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

/**
 * The settlement for key went through. The claim stays, owned by no request, so every copy is 'in-use' until its
 * validBefore passes. Does nothing unless owner holds the key. updated_at keeps the time of the last claim, because
 * this step is handed no time.
 */
export async function markPaymentUsed(db: Db, key: string, owner: string): Promise<void> {
  await db.query(
    "UPDATE payment_claims SET state = 'used', owner = NULL WHERE key = $1 AND state = 'held' AND owner = $2",
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

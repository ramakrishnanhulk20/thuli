import { instant, shifted, type Db } from './db.ts';
import { EVENT_KEEP_SECONDS } from './limits.ts';
import { PAID_RESULT_KEEP_SECONDS } from './paymentClaims.ts';

/** A claim is kept this long past its validBefore, well after every copy of its authorization is refused as expired. */
const CLAIM_KEEP_SECONDS = 3_600;

async function removed(rows: Promise<{ gone: number }[]>): Promise<number> {
  const [row] = await rows;
  return row?.gone ?? 0;
}

/**
 * Deletes what no rule can need again (threat model C41): claims whose validBefore is more than an hour before now,
 * except a settled or served one, which is deleted only once its settlement is more than PAID_RESULT_KEEP_SECONDS
 * before now; leases expired at now, rate events more than EVENT_KEEP_SECONDS before now, and cache rows expired at
 * now. Each kind is one statement, so a sweep never holds a lock that a claim or a limit waits on for long. Safe to
 * run from many server copies at once.
 * @returns how many rows of each kind it deleted.
 * @throws StoreError when now is not a valid Date.
 */
export async function sweep(
  db: Db,
  now: Date,
): Promise<{ claims: number; leases: number; events: number; checks: number }> {
  const nowAt = instant(now);
  // A whole-second time is more than a span past exactly when it is below now's next whole second minus that span,
  // even for a fractional now. A redeem stops at the settlement plus PAID_RESULT_KEEP_SECONDS, before this deletes it.
  const nextSecond = Math.ceil(now.getTime() / 1000);
  const claims = await removed(
    db.query<{ gone: number }>(
      `WITH gone AS (
         DELETE FROM payment_claims
          WHERE valid_before < $1::bigint AND (settled_at IS NULL OR settled_at < $2::bigint)
            AND NOT (jsonb_array_length(named_txs) > 0 AND valid_before >= $2::bigint)
         RETURNING 1
       ) SELECT count(*)::int AS gone FROM gone`,
      [String(nextSecond - CLAIM_KEEP_SECONDS), String(nextSecond - PAID_RESULT_KEEP_SECONDS)],
    ),
  );
  const leases = await removed(
    db.query<{ gone: number }>(
      'WITH gone AS (DELETE FROM leases WHERE expires_at <= $1::timestamptz RETURNING 1) SELECT count(*)::int AS gone FROM gone',
      [nowAt],
    ),
  );
  const events = await removed(
    db.query<{ gone: number }>(
      'WITH gone AS (DELETE FROM rate_events WHERE at < $1::timestamptz RETURNING 1) SELECT count(*)::int AS gone FROM gone',
      [shifted(now, -EVENT_KEEP_SECONDS)],
    ),
  );
  const checks = await removed(
    db.query<{ gone: number }>(
      'WITH gone AS (DELETE FROM check_cache WHERE expires_at <= $1::timestamptz RETURNING 1) SELECT count(*)::int AS gone FROM gone',
      [nowAt],
    ),
  );
  return { claims, leases, events, checks };
}

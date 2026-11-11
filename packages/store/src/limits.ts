import { randomUUID } from 'node:crypto';
import { instant, shifted, wholeNumber, type Db } from './db.ts';

/** Rate events older than this are deleted by sweep, so no window may be longer, or it would undercount. */
export const EVENT_KEEP_SECONDS = 7_200;

const MAX_COUNT = 2_147_483_647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Takes one of max places in pool until now plus ttlSeconds, shared by every server copy (threat model C24, C42).
 * First deletes that pool's expired leases, then adds one only while fewer than max are live, all in one transaction
 * under an advisory lock on the pool. A lease whose holder dies without dropping it frees itself at expiry.
 * @returns the lease id to hand to dropLease, or null when the pool is full.
 * @throws StoreError when max is not a whole number from 0, ttlSeconds not a whole number from 1 to 86,400 (a lease
 *   guards work in flight, so a day or more is a unit mistake), now is not a valid Date, or pool is empty or longer
 *   than 200 characters.
 */
export async function takeLease(db: Db, pool: string, max: number, ttlSeconds: number, now: Date): Promise<string | null> {
  wholeNumber(max, 'max', 0, MAX_COUNT);
  wholeNumber(ttlSeconds, 'ttlSeconds', 1, 86_400);
  const nowAt = instant(now);
  const expiresAt = shifted(now, ttlSeconds);
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(1003, hashtext($1))', [pool]);
    await tx.query('DELETE FROM leases WHERE pool = $1 AND expires_at <= $2::timestamptz', [pool, nowAt]);
    const [row] = await tx.query<{ live: number }>('SELECT count(*)::int AS live FROM leases WHERE pool = $1', [pool]);
    if ((row?.live ?? 0) >= max) return null;
    const id = randomUUID();
    await tx.query('INSERT INTO leases (id, pool, expires_at) VALUES ($1::uuid, $2, $3::timestamptz)', [id, pool, expiresAt]);
    return id;
  });
}

/**
 * How many leases in pool are live at now, by the rule takeLease counts with: a lease is live until the moment it
 * expires. Reads only, so a caller can ask whether a place is free without taking one.
 * @throws StoreError when now is not a valid Date.
 */
export async function liveLeases(db: Db, pool: string, now: Date): Promise<number> {
  const [row] = await db.query<{ live: number }>(
    'SELECT count(*)::int AS live FROM leases WHERE pool = $1 AND expires_at > $2::timestamptz',
    [pool, instant(now)],
  );
  return row?.live ?? 0;
}

/** Gives a lease's place back at once. An id that is not a live lease, or not a UUID at all, does nothing. */
export async function dropLease(db: Db, id: string): Promise<void> {
  if (typeof id !== 'string' || !UUID.test(id)) return;
  await db.query('DELETE FROM leases WHERE id = $1::uuid', [id]);
}

/**
 * Counts one event for client in bucket at now, but only while client has fewer than max events in the last
 * windowSeconds (an event exactly windowSeconds old no longer counts). The count and the write run in one transaction
 * under an advisory lock on bucket and client, so a burst started together cannot pass max.
 * @returns true when the event was counted, false when client was already at max and nothing was written.
 * @throws StoreError when max or windowSeconds is out of range (a window may be at most EVENT_KEEP_SECONDS), now is
 *   not a valid Date, bucket is empty or longer than 40 characters, or client empty or longer than 64.
 */
export async function recordIfUnder(
  db: Db,
  bucket: string,
  client: string,
  max: number,
  windowSeconds: number,
  now: Date,
): Promise<boolean> {
  wholeNumber(max, 'max', 0, MAX_COUNT);
  wholeNumber(windowSeconds, 'windowSeconds', 1, EVENT_KEEP_SECONDS);
  const nowAt = instant(now);
  const since = shifted(now, -windowSeconds);
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(1004, hashtext(json_build_array($1::text, $2::text)::text))', [
      bucket,
      client,
    ]);
    const [row] = await tx.query<{ recent: number }>(
      'SELECT count(*)::int AS recent FROM rate_events WHERE bucket = $1 AND client = $2 AND at > $3::timestamptz',
      [bucket, client, since],
    );
    if ((row?.recent ?? 0) >= max) return false;
    await tx.query('INSERT INTO rate_events (bucket, client, at) VALUES ($1, $2, $3::timestamptz)', [bucket, client, nowAt]);
    return true;
  });
}

/**
 * Counts one event for client in bucket at now with no ceiling, such as a failed settlement that countRecent reads
 * back later.
 * @throws StoreError when now is not a valid Date, or bucket or client is empty or too long.
 */
export async function recordEvent(db: Db, bucket: string, client: string, now: Date): Promise<void> {
  await db.query('INSERT INTO rate_events (bucket, client, at) VALUES ($1, $2, $3::timestamptz)', [
    bucket,
    client,
    instant(now),
  ]);
}

/**
 * How many events client has in bucket within the last windowSeconds before now, by the same rule as recordIfUnder.
 * @throws StoreError when windowSeconds is out of range or now is not a valid Date.
 */
export async function countRecent(db: Db, bucket: string, client: string, windowSeconds: number, now: Date): Promise<number> {
  wholeNumber(windowSeconds, 'windowSeconds', 1, EVENT_KEEP_SECONDS);
  instant(now);
  const [row] = await db.query<{ recent: number }>(
    'SELECT count(*)::int AS recent FROM rate_events WHERE bucket = $1 AND client = $2 AND at > $3::timestamptz',
    [bucket, client, shifted(now, -windowSeconds)],
  );
  return row?.recent ?? 0;
}

function utcDay(now: Date): string {
  return instant(now).slice(0, 10);
}

/**
 * Counts one toward name for now's UTC day, only while that day's count is below max. One upsert whose WHERE does the
 * check, so callers started together can never push the day past max. A new UTC day starts again from zero.
 * @returns true when it counted, false when the day was already at max. A max of 0 never counts and writes nothing.
 * @throws StoreError when max is out of range, now is not a valid Date, or name is empty or longer than 40 characters.
 */
export async function bumpDay(db: Db, name: string, max: number, now: Date): Promise<boolean> {
  wholeNumber(max, 'max', 0, MAX_COUNT);
  const day = utcDay(now);
  if (max === 0) return false;
  const rows = await db.query(
    `INSERT INTO day_counts (day, name, count) VALUES ($1::date, $2, 1)
     ON CONFLICT (day, name) DO UPDATE SET count = day_counts.count + 1 WHERE day_counts.count < $3::int
     RETURNING count`,
    [day, name, max],
  );
  return rows.length === 1;
}

/**
 * How many bumpDay calls counted toward name on now's UTC day, 0 when none did.
 * @throws StoreError when now is not a valid Date.
 */
export async function dayCount(db: Db, name: string, now: Date): Promise<number> {
  const [row] = await db.query<{ count: number }>('SELECT count FROM day_counts WHERE day = $1::date AND name = $2', [
    utcDay(now),
    name,
  ]);
  return row?.count ?? 0;
}

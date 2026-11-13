import { parseAddress } from '@thuli/core';
import { StoreError, type Db, type Queryable } from './db.ts';

/** Claims remembered at once (C41). Past this, with none due, a new payment is refused as full. */
export const MAX_PAYMENT_CLAIMS = 100_000;

/**
 * How long a settled payment can be redeemed, and its stored result fetched again, counted from the second it settled
 * (C25). Sweep keeps such a claim for exactly this long and no longer (C41).
 */
export const PAID_RESULT_KEEP_SECONDS = 86_400;

/**
 * Screenings one payment may start, counting the first (C26). A screening that runs out of time stores nothing, so
 * without a count every redeem could start another, each up to the call cap, until the day's ceiling refused paying
 * buyers. Two gives a slow SERV one second chance; when the last try cannot finish either, the buyer gets the
 * time-up hold instead of a third screening (C25).
 */
export const REDEEM_SCREEN_TRIES = 2;

/**
 * Transaction hashes kept with one claim at most (C41): the ones a facilitator named for the payment whose receipts
 * have not been read yet. One settle is at most two facilitator calls, and a hash leaves the list as soon as its
 * receipt is read, so a real claim holds one or two. Past the cap the oldest is the one let go.
 */
export const MAX_NAMED_TXS = 8;

const NAMED_TX = /^0x[0-9a-f]{64}$/;

/**
 * What one request learned about the transactions named for a claim: `add`, the ones a facilitator named to it whose
 * receipt it could not read yet, and `drop`, the ones whose receipt it read as not this payment. Nothing else ever
 * takes a transaction off a claim (C25).
 */
export interface NamedChange {
  add: readonly string[];
  drop: readonly string[];
}

function namedTexts(change: NamedChange): [string, string] {
  for (const list of [change.add, change.drop]) {
    if (!Array.isArray(list)) throw new StoreError('named transactions must be given as lists');
    if (list.length > 2 * MAX_NAMED_TXS) throw new StoreError(`at most ${2 * MAX_NAMED_TXS} named transactions in one change`);
    if (list.some((hash) => typeof hash !== 'string' || !NAMED_TX.test(hash))) {
      throw new StoreError('a named transaction must be 0x and 64 lowercase hex characters');
    }
  }
  return [JSON.stringify(change.add), JSON.stringify(change.drop)];
}

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
 * payment. refused: settled for another wallet, or a row missing what a settlement records. in-use: settled for this
 * wallet, and another live request is screening it now. settled: the caller now owns it and starts its screening
 * number `screening`, already counted. spent: the caller now owns it, every try was used and none stored a result,
 * so it stores the time-up hold and starts no screening. served: the stored result, as it was written.
 */
export type Redeemed =
  | { found: 'none' }
  | { found: 'refused' }
  | { found: 'in-use' }
  | { found: 'settled'; transaction: string; screening: number }
  | { found: 'spent'; transaction: string }
  | { found: 'served'; transaction: string; body: unknown };

async function claimCount(tx: Queryable): Promise<number> {
  const [row] = await tx.query<{ claims: number }>('SELECT count(*)::int AS claims FROM payment_claims');
  return row?.claims ?? 0;
}

interface ClaimRow {
  state: string;
  valid_before: string;
  settled_at: string | null;
  named: number;
  for_wallet: string | null;
}

// A claim that holds a transaction a facilitator named may have been paid by it. It waits for that receipt past its
// authorization's end, for as long as a settled claim is kept, so its buyer can still come back for the result. Only a
// claim that has not settled holds one: unsure, or held by the request that is reading the receipt right now.
function waitsOnReceipt(entry: ClaimRow, nowSeconds: bigint): boolean {
  return entry.named > 0 && BigInt(entry.valid_before) + BigInt(PAID_RESULT_KEEP_SECONDS) > nowSeconds;
}

// A settled or served claim outlives its authorization: it stays a whole day from its settlement, so the buyer can
// always come back for the result inside that day.
function isDue(entry: ClaimRow, nowSeconds: bigint): boolean {
  const kept = entry.settled_at !== null && BigInt(entry.settled_at) + BigInt(PAID_RESULT_KEEP_SECONDS) > nowSeconds;
  return entry.state !== 'held' && BigInt(entry.valid_before) <= nowSeconds && !kept && !waitsOnReceipt(entry, nowSeconds);
}

/**
 * Takes the claim on one payment authorization for owner (threat model C25), shared by every server copy. The same
 * steps and answers as PaymentClaims.claim in packages/api/src/claims.ts:
 * - 'expired' when validBefore is at or before nowSeconds, and 'too-long' when it is past nowSeconds plus
 *   latestSeconds. Neither writes anything. One expired authorization is still taken: an 'unsure' row that holds a
 *   transaction a facilitator named, for PAID_RESULT_KEEP_SECONDS past its validBefore. The authorization can no longer
 *   be settled, but that transaction may have paid it, and only its receipt can say.
 * - A row that is not held and whose validBefore has passed is treated as absent and replaced, unless it settled less
 *   than PAID_RESULT_KEEP_SECONDS ago or is waiting on such a receipt.
 * - An 'unsure' row is taken over by owner, for the wallet it was first taken for only, and keeps the later of the two
 *   validBefore values and its named transactions. For any other wallet it is 'in-use', as any other row is: a mined
 *   transaction shows all it takes to rebuild the header, so a copy must not move the payment to another wallet. A row
 *   written before the wallet was recorded takes its next taker's wallet, unless it holds a named transaction, in which
 *   case it is 'in-use' for everyone.
 * - At MAX_PAYMENT_CLAIMS rows, the due ones are deleted first, and the answer is 'full' if it is still at the cap.
 * The decision runs in one transaction under an advisory lock on the key, and a new row also under one lock on the
 * cap, so copies of one authorization started together get exactly one 'taken'.
 * @param key at most 200 characters; owner at most 64, naming the one request settling it.
 * @param wallet the wallet the request asks about, kept in its canonical form as the wallet the claim is for.
 * @throws AddressError from @thuli/core when wallet is not an address. StoreError when the key or owner is empty or too
 *   long, or the database refuses.
 */
export async function claimPayment(
  db: Db,
  key: string,
  wallet: string,
  validBefore: bigint,
  owner: string,
  timing: ClaimTiming,
): Promise<ClaimResult> {
  const { nowSeconds, latestSeconds } = timing;
  const forWallet = parseAddress(wallet);
  const expired = validBefore <= nowSeconds;
  if (!expired && validBefore > nowSeconds + latestSeconds) return 'too-long';
  const now = nowSeconds.toString();
  const before = validBefore.toString();
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(1001, hashtext($1))', [key]);
    let [entry] = await tx.query<ClaimRow>(
      `SELECT state, valid_before::text AS valid_before, settled_at::text AS settled_at, jsonb_array_length(named_txs) AS named,
              for_wallet
         FROM payment_claims WHERE key = $1`,
      [key],
    );
    if (expired && !(entry !== undefined && waitsOnReceipt(entry, nowSeconds))) return 'expired';
    if (entry !== undefined && isDue(entry, nowSeconds)) {
      await tx.query('DELETE FROM payment_claims WHERE key = $1', [key]);
      entry = undefined;
    }
    if (entry !== undefined) {
      if (entry.state !== 'unsure') return 'in-use';
      // A row from before the column has no wallet yet and takes this one, unless it already holds a named
      // transaction: nobody can say whose payment that is, so such a row is never taken and ends with its day.
      if (entry.for_wallet === null ? entry.named > 0 : entry.for_wallet !== forWallet) return 'in-use';
      await tx.query(
        `UPDATE payment_claims
            SET state = 'held', owner = $2, valid_before = GREATEST(valid_before, $3::bigint), updated_at = to_timestamp($4::bigint),
                for_wallet = $5
          WHERE key = $1`,
        [key, owner, before, now, forWallet],
      );
      return 'taken';
    }
    // Different keys run side by side, so counting toward the cap needs its own lock to stay exact.
    await tx.query('SELECT pg_advisory_xact_lock(1002, 0)');
    if ((await claimCount(tx)) >= MAX_PAYMENT_CLAIMS) {
      await tx.query(
        `DELETE FROM payment_claims
          WHERE state <> 'held' AND valid_before <= $1::bigint AND (settled_at IS NULL OR settled_at <= $2::bigint)
            AND NOT (jsonb_array_length(named_txs) > 0 AND valid_before > $2::bigint)`,
        [now, (nowSeconds - BigInt(PAID_RESULT_KEEP_SECONDS)).toString()],
      );
      if ((await claimCount(tx)) >= MAX_PAYMENT_CLAIMS) return 'full';
    }
    await tx.query(
      `INSERT INTO payment_claims (key, state, owner, valid_before, updated_at, for_wallet)
       VALUES ($1, 'held', $2, $3::bigint, to_timestamp($4::bigint), $5)`,
      [key, owner, before, now, forWallet],
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
 * it; while another does own it, the answer is 'in-use'. Taking it counts one more screening in the same statement, so
 * a payment never starts more than REDEEM_SCREEN_TRIES (C26); once they are used, it is taken as 'spent', counting
 * nothing. The wallet is checked first, so another wallet is 'refused' whoever owns the claim. Runs in one transaction
 * under the key's advisory lock, so of two requests started together at most one takes it. Writes nothing unless it
 * answers 'settled' or 'spent'. A row in any other state, or settled more than a day ago, is 'none'.
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
      screenings: number;
    }>(
      `SELECT state, wallet, tx, settled_at::text AS settled_at, owner, owned_until::text AS owned_until, result, screenings
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
      return { found: 'in-use' };
    }
    const spent = entry.screenings >= REDEEM_SCREEN_TRIES;
    await tx.query(
      `UPDATE payment_claims
          SET owner = $2, owned_until = $3::bigint, updated_at = to_timestamp($4::bigint),
              screenings = screenings + $5::int, owner_counted = ($5::int = 1)
        WHERE key = $1`,
      [key, owner, until, now, spent ? 0 : 1],
    );
    return spent ? { found: 'spent', transaction: entry.tx } : { found: 'settled', transaction: entry.tx, screening: entry.screenings + 1 };
  });
}

/**
 * The settlement for key went through. The claim becomes settled, with the wallet and transaction it paid for and
 * nowSeconds as the second it settled, and stays owned by owner until ownedUntil while that request screens it: its
 * first screening, counted here (C26). Every copy is refused from now on except a redeem of the same wallet. Does
 * nothing unless owner holds the key.
 * @throws AddressError when the wallet is not an address. StoreError when the transaction is not 0x and 64 lowercase
 *   hex characters, ownedUntil is not after nowSeconds, or the database refuses.
 */
export async function markPaymentSettled(db: Db, key: string, owner: string, settlement: Settlement, timing: OwnerTiming): Promise<void> {
  const wallet = parseAddress(settlement.wallet);
  const [now, until] = ownerTiming(timing);
  await db.query(
    `UPDATE payment_claims
        SET state = 'settled', wallet = $3, tx = $4, settled_at = $5::bigint, owned_until = $6::bigint, updated_at = to_timestamp($5::bigint),
            screenings = 1, owner_counted = true, named_txs = '[]'::jsonb
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
    `UPDATE payment_claims SET state = 'served', result = $3::jsonb, owner = NULL, owned_until = NULL, owner_counted = false
      WHERE key = $1 AND state = 'settled' AND owner = $2`,
    [key, owner, json],
  );
}

/**
 * The request screening a settled payment ends without a result. The claim stays settled, owned by no request, so the
 * next request with its header may take it at once. With handBackTry, the owner never started the screening its taking
 * counted, so that one try is given back; left out, nothing is given back, the safe side when in doubt. Only an owner
 * whose taking counted a try can hand one back, so an owner that took a spent claim can never reopen it (C26). Does
 * nothing unless owner owns the settled key.
 */
export async function leaveSettledPayment(db: Db, key: string, owner: string, handBackTry = false): Promise<void> {
  await db.query(
    `UPDATE payment_claims
        SET owner = NULL, owned_until = NULL, owner_counted = false,
            screenings = screenings - CASE WHEN $3::boolean AND owner_counted THEN 1 ELSE 0 END
      WHERE key = $1 AND state = 'settled' AND owner = $2`,
    [key, owner, handBackTry],
  );
}

// One statement for both callers below, so the list is changed and the claim is let go, or not, in a single step. The
// list becomes what it held and `add`, less `drop`, oldest first; past MAX_NAMED_TXS the newest are the ones kept.
async function changeNamed(db: Db, key: string, owner: string, change: NamedChange, letGo: boolean): Promise<void> {
  const [add, drop] = namedTexts(change);
  await db.query(
    `UPDATE payment_claims
        SET state = CASE WHEN $6::boolean THEN 'unsure' ELSE state END,
            owner = CASE WHEN $6::boolean THEN NULL ELSE owner END,
            named_txs = (
              SELECT COALESCE(jsonb_agg(hash ORDER BY first_at), '[]'::jsonb)
                FROM (
                  SELECT hash, min(at) AS first_at
                    FROM jsonb_array_elements_text(named_txs || $3::jsonb) WITH ORDINALITY AS named(hash, at)
                   WHERE hash NOT IN (SELECT jsonb_array_elements_text($4::jsonb))
                   GROUP BY hash ORDER BY first_at DESC LIMIT $5::int
                ) AS kept
            )
      WHERE key = $1 AND state = 'held' AND owner = $2`,
    [key, owner, add, drop, MAX_NAMED_TXS, letGo],
  );
}

/**
 * The settlement's outcome is unknown. The claim stays, owned by no request, so a retry of the same authorization, for
 * the same wallet, can take it and ask again. `named` is what the request that is ending learned about the
 * transactions named for this payment: the ones in `add` join the claim, so the next request can read their receipts
 * even when the facilitator will not answer for the payment again, and the ones in `drop` leave it (C25). Does nothing
 * unless owner holds the key.
 * @throws StoreError when a transaction is not 0x and 64 lowercase hex characters, or a list is longer than twice
 *   MAX_NAMED_TXS.
 */
export async function keepPaymentUnsure(db: Db, key: string, owner: string, named: NamedChange = { add: [], drop: [] }): Promise<void> {
  await changeNamed(db, key, owner, named, true);
}

/**
 * Takes off a held claim the transactions whose receipts were read as not this payment, and changes nothing else. A
 * request calls it before it lets a plainly failed payment go, so that a claim is released with a list that holds only
 * transactions still worth waiting for. Does nothing unless owner holds the key.
 * @throws StoreError as keepPaymentUnsure does.
 */
export async function forgetPaymentTxs(db: Db, key: string, owner: string, drop: readonly string[]): Promise<void> {
  await changeNamed(db, key, owner, { add: [], drop }, false);
}

/**
 * The transactions a facilitator has named for a claim whose receipts are not read yet, oldest first: what earlier
 * requests left with keepPaymentUnsure. Empty unless owner holds the key.
 */
export async function namedPaymentTxs(db: Db, key: string, owner: string): Promise<string[]> {
  const [row] = await db.query<{ named: unknown }>(
    "SELECT named_txs AS named FROM payment_claims WHERE key = $1 AND state = 'held' AND owner = $2",
    [key, owner],
  );
  const named: unknown = typeof row?.named === 'string' ? JSON.parse(row.named) : row?.named;
  return Array.isArray(named) ? named.filter((hash): hash is string => typeof hash === 'string' && NAMED_TX.test(hash)) : [];
}

/**
 * The request that holds the key lets it go without a settlement. A claim that holds no named transaction is deleted,
 * which frees the key for an honest retry. A claim that still holds one is never deleted here: it goes back to unsure
 * with its transactions, because one of them may yet prove the payment, whatever made this request give up (C25). Only
 * when owner holds the key.
 */
export async function releasePayment(db: Db, key: string, owner: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE payment_claims SET state = 'unsure', owner = NULL
        WHERE key = $1 AND state = 'held' AND owner = $2 AND jsonb_array_length(named_txs) > 0`,
      [key, owner],
    );
    await tx.query("DELETE FROM payment_claims WHERE key = $1 AND state = 'held' AND owner = $2", [key, owner]);
  });
}

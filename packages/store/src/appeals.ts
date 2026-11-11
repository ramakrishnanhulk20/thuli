import {
  appealTextHash,
  CAMPAIGN_ID,
  isPlainText,
  MAX_APPEAL_CHARS,
  OUTCOMES,
  parseAddress,
  shareFor,
  type Address,
  type Outcome,
} from '@thuli/core';
import { instant, shifted, StoreError, wholeNumber, type Db, type Queryable } from './db.ts';
import { bumpDay } from './limits.ts';

// Appeals take the campaign's own advisory lock (namespace 1005, see campaigns.ts), because filing reads the ask and
// settling changes it and its slot: both must see the ask exactly as decideAsk and the slot count leave it.

/**
 * Appeals filed across every campaign in one UTC day, because each one buys an outside check that no sign-in or
 * payment pays for (C24). Counted only for an appeal that is queued.
 */
export const APPEALS_DAY_MAX = 20;
/** The store's day counter the appeal ceiling counts in, a name of its own. */
export const APPEALS_DAY_COUNTER = 'campaign-appeals';
/** The longest note from the outside check that is kept, in characters, the same cap as a model's reason. */
export const MAX_REPPO_NOTE_CHARS = 280;
/** The longest note the owner may keep with a settlement, in characters. */
export const MAX_OWNER_NOTE_CHARS = 1_000;

// The same ceilings asks and relays have (C41): a lease or a retry wait of at most a day, at most 100 attempts.
const MAX_WAIT_SECONDS = 86_400;
const MAX_ATTEMPTS = 100;
const MAX_INTEGER = 2_147_483_647;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
// The id shape the worker's Reppo client accepts from Reppo, so a stored id is one it can look up again.
const EVAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ROUTES: readonly string[] = ['ship', 'review', 'block'];

export type AppealCheckStatus = 'queued' | 'checking' | 'checked' | 'unchecked';
export type AppealOutcome = 'open' | 'reversed' | 'upheld';
export type ReppoRoute = 'ship' | 'review' | 'block';
export type AddAppealResult = 'queued' | 'exists' | 'unknown' | 'undecided' | 'approved' | 'busy';
export type ReleaseAppealResult = 'queued' | 'unchecked';

/** One signed appeal as the route hands it over, after core's checkAppeal has passed it. */
export interface AppealInput {
  campaignId: string;
  wallet: string;
  text: string;
  textHash: string;
  signedAt: number;
  signature: string;
}

export interface AppealKey {
  campaignId: string;
  wallet: string;
}

/**
 * One appeal as anyone may see it. Built field by field, with no field for the text, its hash, the signature or the
 * owner's note, so none of them can leave through it (C40).
 */
export interface PublicAppeal {
  filedAt: Date;
  checkStatus: AppealCheckStatus;
  reppoRoute: ReppoRoute | null;
  reppoNote: string | null;
  reppoEvalId: string | null;
  checkedAt: Date | null;
  outcome: AppealOutcome;
  newAction: 'full' | 'partial' | null;
  settledAt: Date | null;
}

/**
 * The appeal takeAppeal handed to one worker, held until leaseUntil, with what the outside check judges: the action
 * and rule that were appealed, and the ask's own action, rule, reason and private record as they stand now. record is
 * null for a decision that kept none, such as a screening that failed.
 */
export interface TakenAppeal {
  campaignId: string;
  wallet: Address;
  attempts: number;
  leaseUntil: Date;
  reppoEvalId: string | null;
  appealedAction: Outcome;
  appealedRule: string;
  action: Outcome;
  rule: string;
  reason: string;
  record: Record<string, unknown> | null;
}

export interface AppealCheck {
  evalId: string;
  route: ReppoRoute;
  note: string | null;
  creditsCharged: number;
}

export interface AppealSettlement {
  campaignId: string;
  wallet: string;
  outcome: 'reversed' | 'upheld';
  newAction: 'full' | 'partial' | null;
  ownerNote: string | null;
}

export type SettleRefusal =
  | 'no appeal from this wallet'
  | 'the appeal is already settled'
  | 'a reversal needs a new action, full or partial'
  | 'an upheld appeal takes no new action'
  | 'the new action must be more generous than the appealed one'
  | 'the ask changed after the appeal was filed';

/** The ask's slot once the appeal is settled, or why nothing was settled. */
export type SettleAppealResult = { slot: number | null } | { refused: SettleRefusal };

/** One appeal in full, text and owner note included, for the operator's command only. The signature is left out. */
export interface OwnerAppeal {
  campaignId: string;
  wallet: Address;
  text: string;
  textHash: string;
  signedAt: number;
  appealedAction: Outcome;
  appealedRule: string;
  filedAt: Date;
  checkStatus: AppealCheckStatus;
  attempts: number;
  reppoEvalId: string | null;
  reppoRoute: ReppoRoute | null;
  reppoNote: string | null;
  creditsCharged: number | null;
  checkedAt: Date | null;
  outcome: AppealOutcome;
  newAction: 'full' | 'partial' | null;
  ownerNote: string | null;
  settledAt: Date | null;
}

/** The public appeal columns as every public read names them, so getAppeal and the ask views read one shape. */
export interface PublicAppealRow {
  appeal_filed_at: unknown;
  appeal_check_status: string | null;
  appeal_reppo_route: string | null;
  appeal_reppo_note: string | null;
  appeal_reppo_eval_id: string | null;
  appeal_checked_at: unknown;
  appeal_outcome: string | null;
  appeal_new_action: string | null;
  appeal_settled_at: unknown;
}

interface OwnerRow {
  campaign_id: string;
  wallet: string;
  text: string;
  text_hash: string;
  signed_at: string;
  appealed_action: string;
  appealed_rule: string;
  filed_at: unknown;
  check_status: string;
  attempts: number;
  reppo_eval_id: string | null;
  reppo_route: string | null;
  reppo_note: string | null;
  credits_charged: number | null;
  checked_at: unknown;
  outcome: string;
  new_action: string | null;
  owner_note: string | null;
  settled_at: unknown;
}

function readTime(value: unknown): Date {
  const time = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(time.getTime())) throw new StoreError('the database returned a time that could not be read');
  return time;
}

function readTimeOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : readTime(value);
}

/** The public view from a row naming the public appeal columns, or null when the row holds no appeal. */
export function readPublicAppeal(row: PublicAppealRow): PublicAppeal | null {
  if (row.appeal_filed_at === null || row.appeal_filed_at === undefined) return null;
  return {
    filedAt: readTime(row.appeal_filed_at),
    checkStatus: row.appeal_check_status as AppealCheckStatus,
    reppoRoute: row.appeal_reppo_route as ReppoRoute | null,
    reppoNote: row.appeal_reppo_note,
    reppoEvalId: row.appeal_reppo_eval_id,
    checkedAt: readTimeOrNull(row.appeal_checked_at),
    outcome: row.appeal_outcome as AppealOutcome,
    newAction: row.appeal_new_action as 'full' | 'partial' | null,
    settledAt: readTimeOrNull(row.appeal_settled_at),
  };
}

function isCampaignId(id: unknown): id is string {
  return typeof id === 'string' && CAMPAIGN_ID.test(id);
}

function plainOrNull(value: unknown, label: string, most: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > most || !isPlainText(value)) {
    throw new StoreError(`${label} must be null or plain text of 1 to ${most} characters`);
  }
  return value;
}

function evalIdOf(value: unknown): string {
  if (typeof value !== 'string' || !EVAL_ID.test(value)) throw new StoreError('an evaluation id is 1 to 64 letters, digits, dashes or underscores');
  return value;
}

function keyOf(key: AppealKey): { campaignId: string | null; wallet: Address } {
  return { campaignId: isCampaignId(key.campaignId) ? key.campaignId : null, wallet: parseAddress(key.wallet) };
}

async function lockCampaign(tx: Queryable, id: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(1005, hashtext($1))', [id]);
}

// bumpDay runs one query on the Db it is given, so the transaction's own connection can stand in for one: the day's
// count is then written, or rolled back, together with the appeal it counts.
function inTransaction(tx: Queryable): Db {
  return {
    query: tx.query,
    transaction: () => Promise.reject(new StoreError('a transaction cannot be opened inside this one')),
    close: async () => undefined,
  };
}

/**
 * Files one wallet's signed appeal against its ask's decision. Its signature must already have been checked by core's
 * checkAppeal; this stores it as the wallet's proof. One transaction under the campaign's lock: the ask is read as it
 * stands, its action and rule are kept as what was appealed, and the day's count for 'campaign-appeals' is taken
 * through the store's bumpDay in the same transaction only once the appeal is certain to be queued, so it is written
 * with the appeal or not at all (C24, C42).
 * @returns in this order: 'unknown' when the campaign or the ask does not exist; 'exists' when this wallet already
 *   appealed, and the first appeal is left exactly as it was; 'undecided' when the ask is not decided or failed yet;
 *   'approved' when its decision is a full approval; 'busy' when today's APPEALS_DAY_MAX appeals are used; otherwise
 *   'queued'. A failed ask, the hold an outage leaves, can be appealed like any hold.
 * @throws AddressError from @thuli/core when the wallet is not an address. StoreError when the text is not plain text
 *   of 1 to 1,000 characters, textHash is not appealTextHash of that text, signedAt is not whole seconds from 0, the
 *   signature is not 0x and 130 hex characters, or now is not a valid Date, each before anything is written.
 */
export async function addAppeal(db: Db, appeal: AppealInput, now: Date): Promise<AddAppealResult> {
  const nowAt = instant(now);
  const wallet = parseAddress(appeal.wallet);
  const { text } = appeal;
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_APPEAL_CHARS || !isPlainText(text)) {
    throw new StoreError(`the appeal text must be plain text of 1 to ${MAX_APPEAL_CHARS} characters`);
  }
  // Rebuilt here rather than trusted, so the stored hash always says exactly what the stored text is (C8).
  if (appeal.textHash !== appealTextHash(text)) throw new StoreError('the text hash must be the SHA-256 of the text as given');
  const signedAt = wholeNumber(appeal.signedAt, 'signedAt', 0, Number.MAX_SAFE_INTEGER);
  if (typeof appeal.signature !== 'string' || !SIGNATURE.test(appeal.signature)) {
    throw new StoreError('a signature is 0x and 130 hex characters');
  }
  if (!isCampaignId(appeal.campaignId)) return 'unknown';
  const campaignId = appeal.campaignId;
  return db.transaction(async (tx) => {
    await lockCampaign(tx, campaignId);
    const [ask] = await tx.query<{ status: string; action: string | null; rule: string | null }>(
      'SELECT status, action, rule FROM asks WHERE campaign_id = $1 AND wallet = $2 FOR UPDATE',
      [campaignId, wallet],
    );
    if (ask === undefined) return 'unknown';
    const [earlier] = await tx.query('SELECT 1 AS found FROM appeals WHERE campaign_id = $1 AND wallet = $2', [campaignId, wallet]);
    if (earlier !== undefined) return 'exists';
    if ((ask.status !== 'decided' && ask.status !== 'failed') || ask.action === null || ask.rule === null) return 'undecided';
    if (ask.action === 'full') return 'approved';
    if (!(await bumpDay(inTransaction(tx), APPEALS_DAY_COUNTER, APPEALS_DAY_MAX, now))) return 'busy';
    const added = await tx.query(
      `INSERT INTO appeals (campaign_id, wallet, text, text_hash, signed_at, signature, appealed_action, appealed_rule, filed_at,
                            check_status, attempts, outcome)
       VALUES ($1, $2, $3, $4, $5::bigint, $6, $7, $8, $9::timestamptz, 'queued', 0, 'open')
       ON CONFLICT (campaign_id, wallet) DO NOTHING
       RETURNING wallet`,
      [campaignId, wallet, text, appeal.textHash, String(signedAt), appeal.signature, ask.action, ask.rule, nowAt],
    );
    // Under the campaign's lock the appeal was just found absent, so this cannot happen; if it does, the day's count is
    // rolled back with everything else rather than spent on an appeal that was not added.
    if (added.length !== 1) throw new StoreError('the appeal appeared while it was being added');
    return 'queued';
  });
}

/**
 * Hands the oldest ready appeal, from any campaign, to one worker for the outside check: one queued with no retry time
 * or one at or before now, or checking with a lease at or before now. It is marked checking with lease_until now plus
 * leaseSeconds and one more attempt. A waiting appeal that has already had maxAttempts is never handed out again: in
 * the same transaction it ends unchecked, never checked (C41). The take itself is one statement that skips rows
 * another caller has locked, so two workers calling at once never get the same appeal. Any evaluation id already noted
 * comes back, so an unfinished evaluation is looked up again and its text is never submitted twice (C23).
 * @returns the appeal taken, or null when none is ready.
 * @throws StoreError when leaseSeconds is not a whole number from 1 to 86,400, maxAttempts not a whole number from 1
 *   to 100, or now is not a valid Date.
 */
export async function takeAppeal(db: Db, now: Date, leaseSeconds: number, maxAttempts: number): Promise<TakenAppeal | null> {
  wholeNumber(leaseSeconds, 'leaseSeconds', 1, MAX_WAIT_SECONDS);
  wholeNumber(maxAttempts, 'maxAttempts', 1, MAX_ATTEMPTS);
  const nowAt = instant(now);
  const leaseUntil = shifted(now, leaseSeconds);
  return db.transaction(async (tx) => {
    await tx.query(
      `UPDATE appeals SET check_status = 'unchecked', lease_until = NULL, retry_at = NULL, checked_at = $1::timestamptz
        WHERE attempts >= $2::int AND (check_status = 'queued' OR (check_status = 'checking' AND lease_until <= $1::timestamptz))`,
      [nowAt, maxAttempts],
    );
    const [taken] = await tx.query<{
      campaign_id: string;
      wallet: string;
      attempts: number;
      lease_until: unknown;
      reppo_eval_id: string | null;
      appealed_action: string;
      appealed_rule: string;
    }>(
      `WITH next AS (
         SELECT campaign_id, wallet FROM appeals
          WHERE attempts < $3::int
            AND ((check_status = 'queued' AND (retry_at IS NULL OR retry_at <= $1::timestamptz))
                 OR (check_status = 'checking' AND lease_until <= $1::timestamptz))
          ORDER BY filed_at, campaign_id, wallet
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE appeals SET check_status = 'checking', lease_until = $2::timestamptz, retry_at = NULL, attempts = appeals.attempts + 1
         FROM next
        WHERE appeals.campaign_id = next.campaign_id AND appeals.wallet = next.wallet
       RETURNING appeals.campaign_id, appeals.wallet, appeals.attempts, appeals.lease_until, appeals.reppo_eval_id,
                 appeals.appealed_action, appeals.appealed_rule`,
      [nowAt, leaseUntil, maxAttempts],
    );
    if (taken === undefined) return null;
    const [ask] = await tx.query<{ action: string; rule: string; reason: string; record: unknown }>(
      'SELECT action, rule, reason, record FROM asks WHERE campaign_id = $1 AND wallet = $2',
      [taken.campaign_id, taken.wallet],
    );
    if (ask === undefined) throw new StoreError('an appeal names an ask that is not there');
    return {
      campaignId: taken.campaign_id,
      wallet: taken.wallet as Address,
      attempts: taken.attempts,
      leaseUntil: readTime(taken.lease_until),
      reppoEvalId: taken.reppo_eval_id,
      appealedAction: taken.appealed_action as Outcome,
      appealedRule: taken.appealed_rule,
      action: ask.action as Outcome,
      rule: ask.rule,
      reason: ask.reason,
      record: ask.record === null || ask.record === undefined ? null : (ask.record as Record<string, unknown>),
    };
  });
}

/**
 * Gives back an appeal whose outside check could not finish. Below maxAttempts it is queued again, and takeAppeal
 * leaves it be until now plus retryAfterSeconds, so an outage is waited out; any evaluation id stays on it. At or past
 * maxAttempts it ends unchecked (C41). One statement, and only on an appeal that is checking.
 * @param options.refundTry true when the try failed for a reason that was not the appeal's own, such as an outside
 *   service out of credit: the try is handed back in this same statement, attempts falling by one but never below 0,
 *   and the appeal is judged against maxAttempts as if the try had not been made. The retry wait still applies, so a
 *   refund alone can never make an appeal loop without pause (C41). Left out or false, behaviour is unchanged.
 * @returns 'queued' or 'unchecked', or null when there is no such appeal or it is not checking, changing nothing.
 * @throws AddressError from @thuli/core when the wallet is not an address. StoreError when maxAttempts is not a whole
 *   number from 1 to 100, retryAfterSeconds not a whole number from 0 to 86,400, refundTry is given but is not true or
 *   false, or now is not a valid Date, each before anything is written.
 */
export async function releaseAppeal(
  db: Db,
  key: AppealKey,
  now: Date,
  maxAttempts: number,
  retryAfterSeconds = 0,
  options: { refundTry?: boolean } = {},
): Promise<ReleaseAppealResult | null> {
  const nowAt = instant(now);
  const { campaignId, wallet } = keyOf(key);
  wholeNumber(maxAttempts, 'maxAttempts', 1, MAX_ATTEMPTS);
  const retryAt = shifted(now, wholeNumber(retryAfterSeconds, 'retryAfterSeconds', 0, MAX_WAIT_SECONDS));
  const refundTry: unknown = options.refundTry;
  if (refundTry !== undefined && typeof refundTry !== 'boolean') throw new StoreError('refundTry must be true or false');
  const refund = refundTry === true ? 1 : 0;
  if (campaignId === null) return null;
  const [row] = await db.query<{ check_status: ReleaseAppealResult }>(
    `UPDATE appeals
        SET check_status = CASE WHEN GREATEST(attempts - $6::int, 0) < $3::int THEN 'queued' ELSE 'unchecked' END,
            attempts = GREATEST(attempts - $6::int, 0),
            lease_until = NULL,
            retry_at = CASE WHEN GREATEST(attempts - $6::int, 0) < $3::int THEN $5::timestamptz ELSE NULL END,
            checked_at = CASE WHEN GREATEST(attempts - $6::int, 0) < $3::int THEN NULL ELSE $4::timestamptz END
      WHERE campaign_id = $1 AND wallet = $2 AND check_status = 'checking'
     RETURNING check_status`,
    [campaignId, wallet, maxAttempts, nowAt, retryAt, refund],
  );
  return row?.check_status ?? null;
}

/**
 * Keeps the evaluation id of an outside check that was submitted but has not finished, on an appeal that is checking,
 * before its result is known. A later try then looks that evaluation up instead of submitting the text again (C23). The
 * same id again is a no-op; a different id is refused, because one appeal is one submission. now is checked like every
 * caller's time. One statement.
 * @returns true when the appeal is checking and holds evalId; false, changing nothing, otherwise.
 * @throws AddressError from @thuli/core when the wallet is not an address. StoreError when evalId is not 1 to 64
 *   letters, digits, dashes or underscores, or now is not a valid Date.
 */
export async function noteAppealEval(db: Db, key: AppealKey, evalId: string, now: Date): Promise<boolean> {
  instant(now);
  const { campaignId, wallet } = keyOf(key);
  const id = evalIdOf(evalId);
  if (campaignId === null) return false;
  const rows = await db.query(
    `UPDATE appeals SET reppo_eval_id = $3
      WHERE campaign_id = $1 AND wallet = $2 AND check_status = 'checking' AND (reppo_eval_id IS NULL OR reppo_eval_id = $3)
     RETURNING wallet`,
    [campaignId, wallet, id],
  );
  return rows.length === 1;
}

/**
 * Records the outside check's result on an appeal that is checking: Reppo's route, its note (already cut by the worker
 * and checked again here like any model text, C13, C34), the evaluation id and the credits it charged. Refused, changing
 * nothing, when a different evaluation id was noted for this appeal. The check is advice: nothing here touches the ask.
 * One statement.
 * @returns true when the appeal was checking and is now checked; false, changing nothing, otherwise.
 * @throws AddressError from @thuli/core when the wallet is not an address. StoreError when evalId is malformed, route is
 *   not ship, review or block, note is neither null nor plain text of 1 to 280 characters, creditsCharged is not a
 *   whole number from 0, or now is not a valid Date.
 */
export async function recordAppealCheck(db: Db, key: AppealKey, check: AppealCheck, now: Date): Promise<boolean> {
  const nowAt = instant(now);
  const { campaignId, wallet } = keyOf(key);
  const evalId = evalIdOf(check.evalId);
  if (!ROUTES.includes(check.route)) throw new StoreError('route must be ship, review or block');
  const note = plainOrNull(check.note, 'note', MAX_REPPO_NOTE_CHARS);
  const credits = wholeNumber(check.creditsCharged, 'creditsCharged', 0, MAX_INTEGER);
  if (campaignId === null) return false;
  const rows = await db.query(
    `UPDATE appeals
        SET check_status = 'checked', lease_until = NULL, retry_at = NULL, reppo_eval_id = $3, reppo_route = $4, reppo_note = $5,
            credits_charged = $6, checked_at = $7::timestamptz
      WHERE campaign_id = $1 AND wallet = $2 AND check_status = 'checking' AND (reppo_eval_id IS NULL OR reppo_eval_id = $3)
     RETURNING wallet`,
    [campaignId, wallet, evalId, check.route, note, credits, nowAt],
  );
  return rows.length === 1;
}

/**
 * Ends the outside check of an appeal that is checking as unchecked, for a decision that kept no record to send. The
 * appeal can still be settled. One statement.
 * @returns true when the appeal was checking and is now unchecked; false, changing nothing, otherwise.
 * @throws AddressError from @thuli/core when the wallet is not an address. StoreError when now is not a valid Date.
 */
export async function markAppealUnchecked(db: Db, key: AppealKey, now: Date): Promise<boolean> {
  const nowAt = instant(now);
  const { campaignId, wallet } = keyOf(key);
  if (campaignId === null) return false;
  const rows = await db.query(
    `UPDATE appeals SET check_status = 'unchecked', lease_until = NULL, retry_at = NULL, checked_at = $3::timestamptz
      WHERE campaign_id = $1 AND wallet = $2 AND check_status = 'checking'
     RETURNING wallet`,
    [campaignId, wallet, nowAt],
  );
  return rows.length === 1;
}

/**
 * Settles an open appeal on the campaign owner's word, given today by an operator's command. The only path that changes
 * a decided ask after its screening, and only toward an approval the owner chose (C11); the outside check is advice and
 * is never read here. Works whether or not the check finished. One transaction under the campaign's lock.
 * - 'upheld' changes nothing but the appeal.
 * - 'reversed' needs newAction full or partial, more generous than the appealed action, and an ask whose action still
 *   equals it. The ask's action and share become the new ones (share 10,000 for full, the campaign's partial share for
 *   partial) and it is marked reversed_by_appeal, keeping its rule and reason as the record of what was appealed; a
 *   failed ask becomes decided. An ask with no slot takes the next number while the campaign has fewer slot holders
 *   than max_slots, by decideAsk's rule (C44); an ask that already holds one, a partial raised to full, keeps it. The
 *   next published list then carries it like any slot holder (C27).
 * @returns the ask's slot after settling, or { refused } with a fixed cause, in which case nothing changes.
 * @throws AddressError from @thuli/core when the wallet is not an address. StoreError when outcome is not reversed or
 *   upheld, newAction is not null, full or partial, ownerNote is neither null nor plain text of 1 to 1,000 characters,
 *   or now is not a valid Date, each before anything is written.
 */
export async function settleAppeal(db: Db, settlement: AppealSettlement, now: Date): Promise<SettleAppealResult> {
  const nowAt = instant(now);
  const { campaignId, wallet } = keyOf(settlement);
  const { outcome, newAction } = settlement;
  if (outcome !== 'reversed' && outcome !== 'upheld') throw new StoreError('outcome must be reversed or upheld');
  if (newAction !== null && newAction !== 'full' && newAction !== 'partial') throw new StoreError('newAction must be null, full or partial');
  const ownerNote = plainOrNull(settlement.ownerNote, 'ownerNote', MAX_OWNER_NOTE_CHARS);
  if (campaignId === null) return { refused: 'no appeal from this wallet' };
  return db.transaction(async (tx) => {
    await lockCampaign(tx, campaignId);
    const [appeal] = await tx.query<{ outcome: string; appealed_action: string }>(
      'SELECT outcome, appealed_action FROM appeals WHERE campaign_id = $1 AND wallet = $2 FOR UPDATE',
      [campaignId, wallet],
    );
    if (appeal === undefined) return { refused: 'no appeal from this wallet' };
    if (appeal.outcome !== 'open') return { refused: 'the appeal is already settled' };
    const [ask] = await tx.query<{ action: string | null; slot: number | null }>(
      'SELECT action, slot FROM asks WHERE campaign_id = $1 AND wallet = $2 FOR UPDATE',
      [campaignId, wallet],
    );
    if (ask === undefined) throw new StoreError('an appeal names an ask that is not there');
    if (outcome === 'upheld') {
      if (newAction !== null) return { refused: 'an upheld appeal takes no new action' };
      await tx.query(
        `UPDATE appeals SET outcome = 'upheld', owner_note = $3, settled_at = $4::timestamptz
          WHERE campaign_id = $1 AND wallet = $2`,
        [campaignId, wallet, ownerNote, nowAt],
      );
      return { slot: ask.slot };
    }
    if (newAction === null) return { refused: 'a reversal needs a new action, full or partial' };
    // OUTCOMES runs from most generous to least, so an earlier place is the more generous action.
    if (!(OUTCOMES.indexOf(newAction) < OUTCOMES.indexOf(appeal.appealed_action as Outcome))) {
      return { refused: 'the new action must be more generous than the appealed one' };
    }
    if (ask.action !== appeal.appealed_action) return { refused: 'the ask changed after the appeal was filed' };
    const [terms] = await tx.query<{ max_slots: number; partial_share_bps: number }>(
      'SELECT max_slots, partial_share_bps FROM campaigns WHERE id = $1',
      [campaignId],
    );
    if (terms === undefined) throw new StoreError('an appeal names a campaign that is not there');
    let slot = ask.slot;
    if (slot === null) {
      const [held] = await tx.query<{ taken: number; highest: number }>(
        'SELECT count(slot)::int AS taken, COALESCE(max(slot), 0)::int AS highest FROM asks WHERE campaign_id = $1',
        [campaignId],
      );
      // Numbered past the highest one held, as decideAsk numbers them, and the unique index on slots backs it up.
      if ((held?.taken ?? 0) < terms.max_slots) slot = (held?.highest ?? 0) + 1;
    }
    await tx.query(
      `UPDATE asks SET status = 'decided', action = $3, share_bps = $4, slot = $5, reversed_by_appeal = true
        WHERE campaign_id = $1 AND wallet = $2`,
      [campaignId, wallet, newAction, shareFor(newAction, { partialShareBps: terms.partial_share_bps }), slot],
    );
    await tx.query(
      `UPDATE appeals SET outcome = 'reversed', new_action = $3, owner_note = $4, settled_at = $5::timestamptz
        WHERE campaign_id = $1 AND wallet = $2`,
      [campaignId, wallet, newAction, ownerNote, nowAt],
    );
    return { slot };
  });
}

/**
 * The public view of one wallet's appeal, never its text, hash, signature or the owner's note (C40). The wallet goes
 * through parseAddress, so any spelling finds the one appeal (C1).
 * @returns the appeal, or null when there is none.
 * @throws AddressError from @thuli/core when the wallet is not an address.
 */
export async function getAppeal(db: Db, campaignId: string, wallet: string): Promise<PublicAppeal | null> {
  const canonical = parseAddress(wallet);
  if (!isCampaignId(campaignId)) return null;
  const [row] = await db.query<PublicAppealRow>(
    `SELECT filed_at AS appeal_filed_at, check_status AS appeal_check_status, reppo_route AS appeal_reppo_route,
            reppo_note AS appeal_reppo_note, reppo_eval_id AS appeal_reppo_eval_id, checked_at AS appeal_checked_at,
            outcome AS appeal_outcome, new_action AS appeal_new_action, settled_at AS appeal_settled_at
       FROM appeals WHERE campaign_id = $1 AND wallet = $2`,
    [campaignId, canonical],
  );
  return row === undefined ? null : readPublicAppeal(row);
}

/**
 * Every appeal of a campaign in full, oldest first, text and owner note included, for the operator's command that lists
 * and settles them. Never for a route or a log (C40), and the signature is not returned even here. At most one row per
 * ask, so at most the campaign's ask cap.
 */
export async function ownerAppeals(db: Db, campaignId: string): Promise<OwnerAppeal[]> {
  if (!isCampaignId(campaignId)) return [];
  const rows = await db.query<OwnerRow>(
    `SELECT campaign_id, wallet, text, text_hash, signed_at::text AS signed_at, appealed_action, appealed_rule, filed_at,
            check_status, attempts, reppo_eval_id, reppo_route, reppo_note, credits_charged, checked_at, outcome, new_action,
            owner_note, settled_at
       FROM appeals WHERE campaign_id = $1
      ORDER BY filed_at, wallet`,
    [campaignId],
  );
  return rows.map((row) => ({
    campaignId: row.campaign_id,
    wallet: row.wallet as Address,
    text: row.text,
    textHash: row.text_hash,
    signedAt: Number(row.signed_at),
    appealedAction: row.appealed_action as Outcome,
    appealedRule: row.appealed_rule,
    filedAt: readTime(row.filed_at),
    checkStatus: row.check_status as AppealCheckStatus,
    attempts: row.attempts,
    reppoEvalId: row.reppo_eval_id,
    reppoRoute: row.reppo_route as ReppoRoute | null,
    reppoNote: row.reppo_note,
    creditsCharged: row.credits_charged,
    checkedAt: readTimeOrNull(row.checked_at),
    outcome: row.outcome as AppealOutcome,
    newAction: row.new_action as 'full' | 'partial' | null,
    ownerNote: row.owner_note,
    settledAt: readTimeOrNull(row.settled_at),
  }));
}

import { z } from 'zod';
import { parseAddress, type Address } from '@thuli/core';
import { MAX_NAMED_TXS, PAID_RESULT_KEEP_SECONDS, REDEEM_SCREEN_TRIES, type NamedChange } from '@thuli/store';
import { PRICE_UNITS, type NetworkId } from './config.ts';

/** Claims remembered at once (C41). Past this, with none expired, a new payment is refused as busy. */
export const MAX_CLAIMS = 100_000;

/** The route's maxTimeoutSeconds, the library's own default, written out because the longest validity a claim accepts is built from it. */
export const MAX_TIMEOUT_SECONDS = 300;

/**
 * How far a buyer's clock may run ahead of ours. The x402 client signs validBefore as its own clock plus the route's
 * maxTimeoutSeconds, so a buyer whose clock is up to this fast still pays; anything further out was signed to outlive
 * the claim that guards it, and is refused.
 */
export const CLOCK_ALLOWANCE_SECONDS = 30n;

/**
 * An authorization at or past its validBefore can never settle on chain. It is refused before it is claimed, unless its
 * claim still waits on the receipt of a transaction already named for it.
 */
export function hasExpired(validBefore: bigint, nowSeconds: bigint): boolean {
  return validBefore <= nowSeconds;
}

type State = 'held' | 'unsure' | 'settled' | 'served';

/** What a payment that went through bought: the wallet it was for and the settlement transaction. */
export interface Settlement {
  wallet: Address;
  transaction: `0x${string}`;
}

interface Claim {
  owner: string | null;
  state: State;
  validBefore: bigint;
  /** Set once the money moved, with the second it settled. */
  settled: (Settlement & { at: bigint }) | null;
  /** While a request owns a settled claim, the second by which that request has surely ended. */
  ownedUntil: bigint | null;
  /** A served claim's result as JSON text, kept as the shared store keeps it. */
  result: string | null;
  /** Screenings started for this payment, counted as each owner takes it (C26). */
  screenings: number;
  /** True while the current owner's taking counted a try, the only owner that may hand one back. */
  ownerCounted: boolean;
  /** The transactions a facilitator named for this payment whose receipts are not read yet, oldest first. */
  named: string[];
  /** The wallet the claim was first taken for, the only one it is ever taken for again. */
  forWallet: Address;
}

export type ClaimResult = 'taken' | 'in-use' | 'expired' | 'too-long' | 'full';

/**
 * What redeem found for a key, by redeemPayment's rules in @thuli/store. none: no settled payment within its day, so the
 * header goes the way of any new payment. refused: settled for another wallet, or a row missing what a settlement
 * records. in-use: settled for this wallet, and another live request is screening it now. settled: the caller now owns
 * it and starts its screening number `screening`, already counted. spent: the caller now owns it, every try was used
 * and none stored a result, so it stores the time-up hold and starts no screening. served: the stored result, as it
 * was written.
 */
export type Redeemed =
  | { found: 'none' }
  | { found: 'refused' }
  | { found: 'in-use' }
  | { found: 'settled'; transaction: string; screening: number }
  | { found: 'spent'; transaction: string }
  | { found: 'served'; transaction: string; body: unknown };

/**
 * One payment authorization buys one screening, and that screening can be fetched again (threat model C25). A claim is
 * taken before the facilitator is asked to settle, so a second copy of the same authorization, in parallel or later, is
 * refused without reaching it.
 *
 * A claim is held by the one request settling it. If that settlement failed outright, it is released, so an honest
 * retry can try again. If its outcome is unknown (the facilitator threw, timed out, said pending, or named a
 * transaction without proof), it stays as unsure: owned by no request, it lets the same authorization come back and try
 * again, one copy at a time, and it is never served on a guess. An unsure claim keeps every transaction a facilitator
 * named for it whose receipt is not read yet, so the next copy can read those receipts itself, and while it holds one
 * it outlives its authorization by PAID_RESULT_KEEP_SECONDS: the payment can no longer be settled, but one of those
 * transactions may have paid it. Such a claim is never deleted by a release, and a transaction leaves it only when its
 * receipt was read as not this payment. A claim is for the wallet it was first taken for: a copy that names another
 * wallet never takes it, because a mined transaction shows all it takes to rebuild the header. If it settled, it becomes settled, with the wallet
 * and transaction it paid for, owned by that request while it screens; once the result is stored it is served. For
 * PAID_RESULT_KEEP_SECONDS from the settlement, a copy of the header asking for the same wallet redeems it: a settled
 * claim no live request owns is screened by that copy, a settled claim another live request is screening is in use,
 * and a served claim answers with its stored result. Every other copy is refused.
 *
 * Memory only, in this process, at most MAX_CLAIMS entries. Only an authorization valid for at most maxTimeoutSeconds
 * plus CLOCK_ALLOWANCE_SECONDS is claimed, and its claim is remembered until its validBefore, or a day from its
 * settlement if it settled, after which the expiry check refuses every copy. So no copy of an accepted authorization is
 * ever let through by forgetting. Settled claims come only from paid screenings, which the day ceiling bounds. A full
 * map refuses new payments as busy; it never forgets a claim still in its window.
 *
 * A restart forgets every claim, results included. A copy sent after a restart but inside its window reaches the
 * facilitator again, and a facilitator that still holds the payment as pending can answer it from the old transaction.
 * This class does not close that gap.
 */
export class PaymentClaims {
  readonly #claims = new Map<string, Claim>();
  readonly #latestSeconds: bigint;

  /** maxTimeoutSeconds is the route's own, the window the x402 client signs for. */
  constructor(maxTimeoutSeconds: bigint) {
    this.#latestSeconds = maxTimeoutSeconds + CLOCK_ALLOWANCE_SECONDS;
  }

  /**
   * Takes the key for owner, one request's own random id, for wallet. Refuses an expired authorization, one valid for
   * longer than the route allows, a key another request holds, settled or used, an unsure key first taken for another
   * wallet, and a full map.
   */
  claim(key: string, wallet: Address, validBefore: bigint, owner: string, nowSeconds: bigint): ClaimResult {
    const forWallet = parseAddress(wallet);
    const expired = hasExpired(validBefore, nowSeconds);
    if (!expired && validBefore > nowSeconds + this.#latestSeconds) return 'too-long';
    let entry = this.#claims.get(key);
    // An expired authorization is taken only to read the receipt of a transaction already named for it. While another
    // request holds that claim, a copy is in use like any other, not expired.
    if (expired && !(entry !== undefined && this.#waitsOnReceipt(entry, nowSeconds))) return 'expired';
    if (entry !== undefined && this.#due(entry, nowSeconds)) {
      this.#claims.delete(key);
      entry = undefined;
    }
    if (entry !== undefined) {
      if (entry.state !== 'unsure' || entry.forWallet !== forWallet) return 'in-use';
      entry.owner = owner;
      entry.state = 'held';
      if (validBefore > entry.validBefore) entry.validBefore = validBefore;
      return 'taken';
    }
    if (this.#claims.size >= MAX_CLAIMS) this.#forgetDue(nowSeconds);
    if (this.#claims.size >= MAX_CLAIMS) return 'full';
    this.#claims.set(key, {
      owner,
      state: 'held',
      validBefore,
      settled: null,
      ownedUntil: null,
      result: null,
      screenings: 0,
      ownerCounted: false,
      named: [],
      forWallet,
    });
    return 'taken';
  }

  /**
   * Looks for a payment of key that already went through, for a request carrying its header again. Inside a day from
   * the settlement and only for the wallet it paid for: a served claim answers with its stored result, and a settled one
   * no live request owns is taken by owner until ownedUntil, to screen it; one a live request owns is in use. Taking it
   * counts one more screening in the same step, never past REDEEM_SCREEN_TRIES; once they are used it is taken as spent,
   * counting nothing. The wallet is checked first, so another wallet is refused whoever owns the claim.
   */
  redeem(key: string, wallet: Address, owner: string, nowSeconds: bigint, ownedUntil: bigint): Redeemed {
    const entry = this.#claims.get(key);
    if (entry === undefined || entry.settled === null) return { found: 'none' };
    if (entry.settled.at + BigInt(PAID_RESULT_KEEP_SECONDS) <= nowSeconds) return { found: 'none' };
    if (entry.settled.wallet !== parseAddress(wallet)) return { found: 'refused' };
    const { transaction } = entry.settled;
    if (entry.state === 'served' && entry.result !== null) return { found: 'served', transaction, body: JSON.parse(entry.result) as unknown };
    if (entry.owner !== null && entry.ownedUntil !== null && entry.ownedUntil > nowSeconds) return { found: 'in-use' };
    entry.owner = owner;
    entry.ownedUntil = ownedUntil;
    entry.ownerCounted = entry.screenings < REDEEM_SCREEN_TRIES;
    if (!entry.ownerCounted) return { found: 'spent', transaction };
    entry.screenings += 1;
    return { found: 'settled', transaction, screening: entry.screenings };
  }

  /**
   * The settlement went through: the claim is settled for settlement, owned by owner until ownedUntil while it screens,
   * its first screening counted.
   */
  markSettled(key: string, owner: string, settlement: Settlement, nowSeconds: bigint, ownedUntil: bigint): void {
    const entry = this.#take(key, owner);
    if (entry !== undefined) {
      entry.state = 'settled';
      entry.settled = { wallet: parseAddress(settlement.wallet), transaction: settlement.transaction, at: nowSeconds };
      entry.ownedUntil = ownedUntil;
      entry.screenings = 1;
      entry.ownerCounted = true;
      entry.named = [];
    }
  }

  /** Stores the result a settled claim bought and frees it. Does nothing unless owner owns the settled key. */
  serve(key: string, owner: string, body: unknown): void {
    const entry = this.#owned(key, owner);
    const json = body === null ? undefined : JSON.stringify(body);
    if (json === undefined) throw new TypeError('the paid result must be a JSON value other than null');
    if (entry !== undefined) {
      entry.state = 'served';
      entry.result = json;
      entry.owner = null;
      entry.ownedUntil = null;
      entry.ownerCounted = false;
    }
  }

  /**
   * The screening ended with no result: the claim stays settled, owned by no request, for the next copy of its header.
   * With handBackTry the owner never started the screening its taking counted, so that try is given back; an owner
   * whose taking counted none, one that took a spent claim, has nothing to give back.
   */
  leave(key: string, owner: string, handBackTry = false): void {
    const entry = this.#owned(key, owner);
    if (entry !== undefined) {
      if (handBackTry && entry.ownerCounted) entry.screenings -= 1;
      entry.owner = null;
      entry.ownedUntil = null;
      entry.ownerCounted = false;
    }
  }

  /**
   * The settlement's outcome is unknown. The claim stays, owned by no request, so a retry of the same header for the
   * same wallet can take it. `named` is what the request that is ending learned: the transactions in `add` join the
   * claim and the ones in `drop` leave it, as changedNamed says.
   */
  keepUnsure(key: string, owner: string, named: NamedChange = { add: [], drop: [] }): void {
    const entry = this.#take(key, owner);
    if (entry !== undefined) {
      entry.named = changedNamed(entry.named, named);
      entry.state = 'unsure';
      entry.owner = null;
    }
  }

  /** Takes off a held claim the transactions whose receipts were read as not this payment. Changes nothing else. */
  forgetNamed(key: string, owner: string, drop: readonly string[]): void {
    const entry = this.#take(key, owner);
    if (entry !== undefined) entry.named = changedNamed(entry.named, { add: [], drop });
  }

  /** The transactions named for a claim whose receipts are not read yet, oldest first. Empty unless owner holds the key. */
  named(key: string, owner: string): string[] {
    return [...(this.#take(key, owner)?.named ?? [])];
  }

  /**
   * The request that holds the key lets it go without a settlement. A claim that holds no named transaction is
   * forgotten, which frees the key. One that still holds a transaction goes back to unsure with it, never forgotten
   * here, because that transaction may yet prove the payment.
   */
  release(key: string, owner: string): void {
    const entry = this.#take(key, owner);
    if (entry === undefined) return;
    if (entry.named.length === 0) {
      this.#claims.delete(key);
      return;
    }
    entry.state = 'unsure';
    entry.owner = null;
  }

  get size(): number {
    return this.#claims.size;
  }

  #take(key: string, owner: string): Claim | undefined {
    const entry = this.#claims.get(key);
    return entry !== undefined && entry.state === 'held' && entry.owner === owner ? entry : undefined;
  }

  #owned(key: string, owner: string): Claim | undefined {
    const entry = this.#claims.get(key);
    return entry !== undefined && entry.state === 'settled' && entry.owner === owner ? entry : undefined;
  }

  // A held claim belongs to a request in flight and is never forgotten under it. Any other is forgotten only once its
  // authorization has expired, by the same comparison that refuses the authorization itself, and a settled or served
  // one not before a day from its settlement, so its buyer can always come back for the result inside that day.
  #due(entry: Claim, nowSeconds: bigint): boolean {
    const kept = entry.settled !== null && entry.settled.at + BigInt(PAID_RESULT_KEEP_SECONDS) > nowSeconds;
    return entry.state !== 'held' && hasExpired(entry.validBefore, nowSeconds) && !kept && !this.#waitsOnReceipt(entry, nowSeconds);
  }

  // A claim that holds a named transaction may have been paid by it, and only that receipt can say. Only a claim that
  // has not settled holds one: unsure, or held by a request that is settling it or reading its receipt, or that is gone.
  #waitsOnReceipt(entry: Claim, nowSeconds: bigint): boolean {
    return entry.named.length > 0 && entry.validBefore + BigInt(PAID_RESULT_KEEP_SECONDS) > nowSeconds;
  }

  // Runs only when the map is full, so its cost is paid once per wave of new claims, not on every request.
  #forgetDue(nowSeconds: bigint): void {
    for (const [key, entry] of this.#claims) {
      if (this.#due(entry, nowSeconds)) this.#claims.delete(key);
    }
  }
}

/**
 * A claim's named transactions after one request's change: what it held and `add`, less `drop`, oldest first, each
 * once. Past MAX_NAMED_TXS the newest are kept. The same rule as the store's keepPaymentUnsure.
 */
export function changedNamed(held: readonly string[], change: NamedChange): string[] {
  const dropped = new Set(change.drop);
  const named = [...new Set([...held, ...change.add])].filter((hash) => !dropped.has(hash));
  return named.slice(Math.max(0, named.length - MAX_NAMED_TXS));
}

const Eip3009Payload = z.object({
  authorization: z.object({
    from: z.string(),
    to: z.string(),
    value: z.string(),
    validBefore: z.string().regex(/^[0-9]{1,30}$/),
    nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
});

export interface Expected {
  networkId: NetworkId;
  usdc: Address;
  payTo: Address;
}

export interface Requirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
}

export type Terms =
  | { ok: true; key: string; payer: Address; nonce: `0x${string}`; validBefore: bigint }
  | { ok: false; reason: 'payment_not_understood' | 'payment_terms_mismatch' };

function sameAddress(value: string, expected: Address): boolean {
  try {
    return parseAddress(value) === expected;
  } catch {
    return false;
  }
}

/**
 * Reads an EIP-3009 payment and checks it pays exactly our price, in our network's USDC, to our payTo. The library has
 * already matched these, and the facilitator checks them again; this third check keeps the rule true here even if a
 * library update changed the matching. Addresses on both sides go through the one parser before they are compared
 * (C1). Any other payload shape is refused.
 *
 * The key is the network, the token, the payer and the authorization nonce: exactly what the token contract itself
 * refuses to accept twice.
 */
export function readPaymentTerms(payload: unknown, requirements: Requirements, expected: Expected): Terms {
  const parsed = Eip3009Payload.safeParse(payload);
  if (!parsed.success) return { ok: false, reason: 'payment_not_understood' };
  const { authorization } = parsed.data;
  let payer: Address;
  try {
    payer = parseAddress(authorization.from);
  } catch {
    return { ok: false, reason: 'payment_not_understood' };
  }
  const exact =
    requirements.scheme === 'exact' &&
    requirements.network === expected.networkId &&
    sameAddress(requirements.asset, expected.usdc) &&
    requirements.amount === PRICE_UNITS &&
    sameAddress(requirements.payTo, expected.payTo) &&
    sameAddress(authorization.to, expected.payTo) &&
    authorization.value === PRICE_UNITS;
  if (!exact) return { ok: false, reason: 'payment_terms_mismatch' };
  const nonce = authorization.nonce.toLowerCase() as `0x${string}`;
  return {
    ok: true,
    key: `${expected.networkId}|${expected.usdc}|${payer}|${nonce}`,
    payer,
    nonce,
    validBefore: BigInt(authorization.validBefore),
  };
}

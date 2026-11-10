import { z } from 'zod';
import { parseAddress, type Address } from '@thuli/core';
import { PRICE_UNITS, type NetworkId } from './config.ts';

/** Claims remembered at once (C41). Past this, with none due to be forgotten, a new payment is refused as busy. */
export const MAX_CLAIMS = 100_000;

/** An authorization at or past its validBefore can never settle on chain, so it is refused before it is claimed. */
export function hasExpired(validBefore: bigint, nowSeconds: bigint): boolean {
  return validBefore <= nowSeconds;
}

type State = 'held' | 'unsure' | 'used';

interface Claim {
  owner: object | null;
  state: State;
  forgetAt: bigint;
}

export type ClaimResult = 'taken' | 'in-use' | 'expired' | 'full';

/**
 * One payment authorization buys one screening (threat model C25). A claim is taken before the facilitator is asked to
 * settle, so a second copy of the same authorization, in parallel or later, is refused without reaching it.
 *
 * A claim is held by the one request settling it. If that settlement failed outright, it is released, so an honest
 * retry can try again. If it settled, it stays used. If its outcome is unknown (the facilitator threw, timed out, or left
 * it pending without proof), it stays as unsure: owned by no request, it lets the same authorization come back and try
 * again through the facilitator, one copy at a time, and it is never served on a guess.
 *
 * Memory only, in this process, at most MAX_CLAIMS entries. A claim no request holds is forgotten at the earlier of its
 * validBefore and rememberSeconds (the route's maxTimeoutSeconds) after it was taken, so an authorization signed to stay
 * valid for years cannot hold a place in the map. Before its validBefore, a forgotten authorization can come back: it
 * goes to the facilitator again, where its nonce, already spent on chain, makes the settle fail. After its validBefore
 * it is refused here. A restart forgets every claim, with the same two guards left.
 */
export class PaymentClaims {
  readonly #claims = new Map<string, Claim>();
  readonly #rememberSeconds: bigint;

  constructor(rememberSeconds: bigint) {
    this.#rememberSeconds = rememberSeconds;
  }

  /** Takes the key for owner. Refuses an expired authorization, a key another request holds or used, and a full map. */
  claim(key: string, validBefore: bigint, owner: object, nowSeconds: bigint): ClaimResult {
    if (hasExpired(validBefore, nowSeconds)) return 'expired';
    const latest = nowSeconds + this.#rememberSeconds;
    const forgetAt = validBefore < latest ? validBefore : latest;
    let entry = this.#claims.get(key);
    if (entry !== undefined && this.#due(entry, nowSeconds)) {
      this.#claims.delete(key);
      entry = undefined;
    }
    if (entry !== undefined) {
      if (entry.state !== 'unsure') return 'in-use';
      entry.owner = owner;
      entry.state = 'held';
      entry.forgetAt = forgetAt;
      return 'taken';
    }
    if (this.#claims.size >= MAX_CLAIMS) this.#forgetDue(nowSeconds);
    if (this.#claims.size >= MAX_CLAIMS) return 'full';
    this.#claims.set(key, { owner, state: 'held', forgetAt });
    return 'taken';
  }

  markUsed(key: string, owner: object): void {
    const entry = this.#take(key, owner);
    if (entry !== undefined) {
      entry.state = 'used';
      entry.owner = null;
    }
  }

  /** The settlement's outcome is unknown. The claim stays, owned by no request, so a retry of the same header can take it. */
  keepUnsure(key: string, owner: object): void {
    const entry = this.#take(key, owner);
    if (entry !== undefined) {
      entry.state = 'unsure';
      entry.owner = null;
    }
  }

  /** Frees the key only for the request that holds it, and only while its outcome is a plain failure. */
  release(key: string, owner: object): void {
    if (this.#take(key, owner) !== undefined) this.#claims.delete(key);
  }

  get size(): number {
    return this.#claims.size;
  }

  #take(key: string, owner: object): Claim | undefined {
    const entry = this.#claims.get(key);
    return entry !== undefined && entry.state === 'held' && entry.owner === owner ? entry : undefined;
  }

  // A held claim belongs to a request in flight and is never forgotten under it.
  #due(entry: Claim, nowSeconds: bigint): boolean {
    return entry.state !== 'held' && entry.forgetAt <= nowSeconds;
  }

  // Runs only when the map is full, so its cost is paid once per wave of new claims, not on every request.
  #forgetDue(nowSeconds: bigint): void {
    for (const [key, entry] of this.#claims) {
      if (this.#due(entry, nowSeconds)) this.#claims.delete(key);
    }
  }
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

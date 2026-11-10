import { z } from 'zod';
import { parseAddress, type Address } from '@thuli/core';
import { PRICE_UNITS, type NetworkId } from './config.ts';

const DAY_SECONDS = 86_400n;
// A used authorization can never settle again on chain, so this memory only guards against a facilitator that would
// answer success twice. A week bounds it even for an authorization signed to stay valid for years.
const MAX_REMEMBER_SECONDS = 7n * DAY_SECONDS;

interface Claim {
  owner: object;
  used: boolean;
  forgetAfter: bigint;
}

/**
 * One payment authorization buys one screening (threat model C25). A claim is taken before the facilitator is asked to
 * settle, so a second copy of the same authorization, in parallel or later, is refused without reaching it. A claim
 * whose settlement failed is released, so an honest retry can try again; one that settled stays used.
 *
 * Memory only, in this process. A restart forgets every claim, and then the on-chain nonce is the only guard. Entries
 * are bounded by the daily screening ceiling times the week they are kept.
 */
export class PaymentClaims {
  readonly #claims = new Map<string, Claim>();

  /** Takes the key for owner, or returns false when any request already holds it or used it. */
  claim(key: string, validBefore: bigint, owner: object, nowSeconds: bigint): boolean {
    for (const [held, entry] of this.#claims) {
      if (entry.used && entry.forgetAfter < nowSeconds) this.#claims.delete(held);
    }
    if (this.#claims.has(key)) return false;
    const until = validBefore < nowSeconds + MAX_REMEMBER_SECONDS ? validBefore : nowSeconds + MAX_REMEMBER_SECONDS;
    this.#claims.set(key, { owner, used: false, forgetAfter: until + DAY_SECONDS });
    return true;
  }

  markUsed(key: string, owner: object): void {
    const entry = this.#claims.get(key);
    if (entry !== undefined && entry.owner === owner) entry.used = true;
  }

  /** Frees the key only for the request that took it, and only if its payment never settled. */
  release(key: string, owner: object): void {
    const entry = this.#claims.get(key);
    if (entry !== undefined && entry.owner === owner && !entry.used) this.#claims.delete(key);
  }

  get size(): number {
    return this.#claims.size;
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
  | { ok: true; key: string; payer: Address; validBefore: bigint }
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
  return {
    ok: true,
    key: `${expected.networkId}|${expected.usdc}|${payer}|${authorization.nonce.toLowerCase()}`,
    payer,
    validBefore: BigInt(authorization.validBefore),
  };
}

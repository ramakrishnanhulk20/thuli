import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import { z } from 'zod';
import { parseAddress } from '@thuli/core';
import { SETTLED_RETRY } from './schema.ts';

export const TxHashText = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((hash) => hash.toLowerCase() as `0x${string}`);

export const AddressText = z.string().transform((value, ctx) => {
  try {
    return parseAddress(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'not an address' });
    return z.NEVER;
  }
});

// A failure reason is handed on only when it is a code, never when it is prose. The longest reason the payment
// libraries define is 63 characters.
export const REASON_CODE = /^[a-z0-9_]{1,64}$/;

export const INTERNAL_ERROR = { error: 'internal error' } as const;
export const UNCONFIRMED_PAYMENT = { error: 'the payment could not be confirmed' } as const;

/** The two things the payment library says beside its terms that the paid route documents. */
export const UNPAID = 'Payment required';
export const NO_MATCH = 'No matching payment requirements';

const OWN_FAULTS: readonly string[] = [JSON.stringify(INTERNAL_ERROR), JSON.stringify(UNCONFIRMED_PAYMENT)];
const OWN_WAIT = JSON.stringify(SETTLED_RETRY);

// The whole of what a refusal's PAYMENT-RESPONSE may hold. Strict, so a field nobody listed is a refusal to pass it on.
const Refusal = z.strictObject({
  success: z.literal(false),
  errorReason: z.string().regex(REASON_CODE),
  errorMessage: z.string().optional(),
  transaction: z.union([z.literal(''), TxHashText]),
  network: z.string(),
  payer: AddressText.optional(),
});

export interface ReplyRules {
  /** True once this request has recorded its payment as settled. */
  settled: boolean;
  /** The route's network, the only one a refusal may name. */
  network: string;
  /** The sentences the route's own refusals carry beside their reason. */
  messages: readonly string[];
}

export function jsonReply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/**
 * What the paid route's payment step may let out in place of `reply`: `reply` itself, a 402 rebuilt from its payment
 * header, or null when nothing of it may leave (C34).
 *
 * The payment library answers on its own in more ways than the route documents: 502 with a facilitator's words when
 * the facilitator's list of what it supports cannot be read, a 500 of its own, a page for a caller that looks like a
 * browser, and beside its terms whatever an error of its own said, a caller's own input included. So nothing is let
 * out because of who is thought to have built it, only for what it is:
 * - 200, only once this request's payment is recorded as settled (C25).
 * - 503 and 500, only with one of the route's own fixed bodies: the settled retry, once settled, and the two faults.
 * - 402, only while this request has no payment recorded as settled, so no buyer who paid is handed terms to pay
 *   again (C25), and never with the library's body. With terms, the body is rebuilt as one of the two documented things and anything else the
 *   library said reads as no matching requirements, in the body and in the header. With a refusal, the body is {} and
 *   the header must be a failure on this network whose reason is a code, whose message is the reason again or one of
 *   the route's own sentences, and whose transaction and payer are in their own shapes.
 * Everything else is null, and the caller answers in fixed words.
 *
 * Not covered: the body and the PAYMENT-RESPONSE of a 200, which the route's handler and its settle steps write from
 * fixed shapes; the terms themselves, which come from the route's configuration; replies made before the payment step
 * or after it, which the route builds itself; and what the library writes to the log.
 */
export async function documentedReply(reply: Response, rules: ReplyRules): Promise<Response | null> {
  if (reply.status === 200) return rules.settled ? reply : null;
  if (reply.status === 500) return OWN_FAULTS.includes(await reply.clone().text()) ? reply : null;
  if (reply.status === 503) return rules.settled && (await reply.clone().text()) === OWN_WAIT ? reply : null;
  if (reply.status !== 402 || rules.settled) return null;
  const terms = reply.headers.get('payment-required');
  const refusal = reply.headers.get('payment-response');
  try {
    if (terms !== null && refusal === null) {
      const required = decodePaymentRequiredHeader(terms);
      const word = required.error === UNPAID ? UNPAID : NO_MATCH;
      const header = required.error === word ? terms : encodePaymentRequiredHeader({ ...required, error: word });
      return jsonReply(402, { error: word }, { 'payment-required': header });
    }
    if (refusal !== null && terms === null) {
      const said = Refusal.safeParse(decodePaymentResponseHeader(refusal));
      if (!said.success || said.data.network !== rules.network) return null;
      const message = said.data.errorMessage;
      if (message !== undefined && message !== said.data.errorReason && !rules.messages.includes(message)) return null;
      return jsonReply(402, {}, { 'payment-response': refusal });
    }
  } catch {
    // A payment header that does not decode says nothing the route can vouch for.
  }
  return null;
}

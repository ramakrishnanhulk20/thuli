import { z } from 'zod';
import { DECISION_RULES, isCanonicalAddress, MAX_EVIDENCE_TXS, OutcomeSchema, TxHash, type Address } from '@thuli/core';
import { heldScreen, NOT_CHECKED, SINGLE_SCOPE, type SingleScreen } from '@thuli/worker/src/screen/single.ts';
import { NETWORKS } from './config.ts';

export const ScreenRequest = z.strictObject({ wallet: z.string().max(64) });

const NETWORK_IDS = [NETWORKS.base.id, NETWORKS['base-sepolia'].id] as const;

const CanonicalAddressText = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine(isCanonicalAddress, 'address must be in the canonical checksummed form');

// Model reasons pass the decision checks at 280 characters; code-written ones are shorter. Anything past this is wrong.
const MAX_REASON_OUT = 400;
// Control characters other than tab and newline, and the bidirectional overrides that make text display out of order.
const NOT_PLAIN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

export const Payment = z.strictObject({
  network: z.enum(NETWORK_IDS),
  payer: CanonicalAddressText,
  transaction: z.string().regex(/^0x[0-9a-f]{64}$/),
});
export type Payment = z.infer<typeof Payment>;

/** The only shape a paid screening ever returns (threat model C34). */
export const PaidScreenResponse = z.strictObject({
  wallet: CanonicalAddressText,
  checkedAt: z.iso.datetime(),
  scope: z.literal(SINGLE_SCOPE),
  rulebook: z.literal('v2'),
  decision: z.strictObject({
    action: OutcomeSchema,
    shareBps: z.int().min(0).max(10_000),
    rule: z.enum(DECISION_RULES),
    reason: z
      .string()
      .min(1)
      .max(MAX_REASON_OUT)
      .refine((text) => !NOT_PLAIN.test(text), 'reason must be plain text'),
    citedTxs: z.array(TxHash).max(MAX_EVIDENCE_TXS),
  }),
  servRequestId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).nullable(),
  notChecked: z.array(z.enum(NOT_CHECKED)),
  payment: Payment,
});
export type PaidScreenResponse = z.infer<typeof PaidScreenResponse>;

export const OUTPUT_CHECK_CAUSE = 'the result did not pass the output check';

function bodyFrom(screen: SingleScreen, payment: Payment) {
  const { action, shareBps, rule, reason, citedTxs } = screen.decision;
  return {
    wallet: screen.wallet,
    checkedAt: screen.checkedAt,
    scope: screen.scope,
    rulebook: screen.rulebook,
    decision: { action, shareBps, rule, reason, citedTxs },
    servRequestId: screen.servRequestId,
    notChecked: screen.notChecked,
    payment,
  };
}

/**
 * Builds the paid reply from fields picked one by one, so nothing else in the screening record (the model's raw text,
 * its usage, its own labels) can leave. The reply is checked like an input before it goes out. A screening that fails
 * the check, or that names a different wallet from the one paid for, is replaced by a code-written hold, because the
 * payment has already settled and must still buy a decision (C25, C34).
 */
export function paidBody(paidFor: Address, screen: SingleScreen, payment: Payment): PaidScreenResponse {
  if (screen.wallet === paidFor) {
    const parsed = PaidScreenResponse.safeParse(bodyFrom(screen, payment));
    if (parsed.success) return parsed.data;
  }
  return PaidScreenResponse.parse(bodyFrom(heldScreen(paidFor, OUTPUT_CHECK_CAUSE), payment));
}

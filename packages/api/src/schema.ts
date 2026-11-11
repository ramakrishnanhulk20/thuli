import { z } from 'zod';
import {
  CAMPAIGN_ID,
  DECISION_RULES,
  isCanonicalAddress,
  isPlainText,
  MAX_EVIDENCE_TXS,
  OutcomeSchema,
  SCREENED_CHAINS,
  TxHash,
  type Address,
} from '@thuli/core';
import { MAX_BOARD_PAGE, MAX_BOARD_TIES } from '@thuli/store';
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

export const Payment = z.strictObject({
  network: z.enum(NETWORK_IDS),
  payer: CanonicalAddressText,
  transaction: z.string().regex(/^0x[0-9a-f]{64}$/),
});
export type Payment = z.infer<typeof Payment>;

// The fields both replies share, so the paid and the free answer pass one and the same output check.
const SCREEN_FIELDS = {
  wallet: CanonicalAddressText,
  checkedAt: z.iso.datetime(),
  scope: z.literal(SINGLE_SCOPE),
  rulebook: z.literal('v2'),
  decision: z.strictObject({
    action: OutcomeSchema,
    shareBps: z.int().min(0).max(10_000),
    rule: z.enum(DECISION_RULES),
    // Core's one plain-text rule, the one the model's reason passed and every other answer's text passes (C13, C34).
    reason: z.string().min(1).max(MAX_REASON_OUT).refine(isPlainText, 'reason must be plain text'),
    citedTxs: z.array(TxHash).max(MAX_EVIDENCE_TXS),
  }),
  servRequestId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).nullable(),
  notChecked: z.array(z.enum(NOT_CHECKED)),
};

/** The only shape a paid screening ever returns (threat model C34). */
export const PaidScreenResponse = z.strictObject({ ...SCREEN_FIELDS, payment: Payment });
export type PaidScreenResponse = z.infer<typeof PaidScreenResponse>;

/** The only shape the free check ever returns (C34). cached says whether it came from the cache rather than a new screening. */
export const FreeCheckResponse = z.strictObject({ ...SCREEN_FIELDS, cached: z.boolean() });
export type FreeCheckResponse = z.infer<typeof FreeCheckResponse>;

export const OUTPUT_CHECK_CAUSE = 'the result did not pass the output check';

export const SETTLED_RETRY_MESSAGE = 'The payment has settled. Send the same payment header again to get the screening it bought.';

/**
 * The 503 a paid request answers when its payment settled but too little time was left to screen. The same header
 * then redeems the payment: it is never charged again (C25).
 */
export const SettledRetryBody = z.strictObject({
  settled: z.literal(true),
  retry: z.literal(true),
  message: z.literal(SETTLED_RETRY_MESSAGE),
});
export const SETTLED_RETRY: z.infer<typeof SettledRetryBody> = SettledRetryBody.parse({
  settled: true,
  retry: true,
  message: SETTLED_RETRY_MESSAGE,
});

function fieldsFrom(screen: SingleScreen) {
  const { action, shareBps, rule, reason, citedTxs } = screen.decision;
  return {
    wallet: screen.wallet,
    checkedAt: screen.checkedAt,
    scope: screen.scope,
    rulebook: screen.rulebook,
    decision: { action, shareBps, rule, reason, citedTxs },
    servRequestId: screen.servRequestId,
    notChecked: screen.notChecked,
  };
}

function bodyFrom(screen: SingleScreen, payment: Payment) {
  return { ...fieldsFrom(screen), payment };
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

/**
 * A paid result read back from the claim store, checked like an input before it goes out again (C34): it must pass
 * PaidScreenResponse, name the wallet paid for and carry exactly this payment. Anything else is replaced by the
 * code-written hold, as paidBody replaces a screening that fails the check, because the payment still bought a decision.
 */
export function storedPaidBody(paidFor: Address, stored: unknown, payment: Payment): PaidScreenResponse {
  const parsed = PaidScreenResponse.safeParse(stored);
  const same =
    parsed.success &&
    parsed.data.wallet === paidFor &&
    parsed.data.payment.network === payment.network &&
    parsed.data.payment.payer === payment.payer &&
    parsed.data.payment.transaction === payment.transaction;
  return same ? parsed.data : PaidScreenResponse.parse(bodyFrom(heldScreen(paidFor, OUTPUT_CHECK_CAUSE), payment));
}

/**
 * Builds a new free check's reply by paidBody's rules: fields picked one by one, checked like an input, and a screening
 * that fails the check or names another wallet replaced by the code-written hold (C34). accepted is true only when the
 * screening's own answer went out and the rulebook's checks accepted it; any hold from a failed or refused screening
 * is false. The caller keeps an accepted reply in the cache far longer than any other.
 */
export function freeBody(checked: Address, screen: SingleScreen): { body: FreeCheckResponse; accepted: boolean } {
  if (screen.wallet === checked) {
    const parsed = FreeCheckResponse.safeParse({ ...fieldsFrom(screen), cached: false });
    if (parsed.success) return { body: parsed.data, accepted: screen.decision.accepted };
  }
  return { body: FreeCheckResponse.parse({ ...fieldsFrom(heldScreen(checked, OUTPUT_CHECK_CAUSE)), cached: false }), accepted: false };
}

// The campaign routes' answers. Each passes its shape before it leaves (C34), and none has a field for a signature, a
// lease or the caller's address (C40).

/** Base units as decimal text, the way the store keeps them, so an amount never passes through a float. */
const AmountText = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const HashText = z.string().regex(/^0x[0-9a-f]{64}$/);
const Count = z.int().min(0);
// The store's own plain-text rule, so what leaves is held to what was let in (C13, C33).
const plainText = (most: number) => z.string().min(1).max(most).refine(isPlainText, 'must be plain text');

/** The body POST /api/campaigns/:id/asks takes, by type and size only; checkAsk judges the values. */
export const AskRequest = z.strictObject({
  wallet: z.string().max(64),
  signedAt: z.number(),
  signature: z.string().max(200),
});

export const ErrorBody = z.strictObject({ error: z.string().min(1).max(200) });
export const BusyBody = z.strictObject({ busy: z.literal(true) });
export const QueuedBody = z.strictObject({ queued: z.literal(true) });
export const ClosedBody = z.strictObject({ closed: z.literal(true) });
/** The campaign cannot seat another wallet: every slot is taken, or its asks have reached their cap. */
export const FullBody = z.strictObject({ full: z.literal(true) });
/** The wallet has sent no transaction and holds no balance on Ethereum, so nothing was stored, queued or counted. */
export const NeverUsedBody = z.strictObject({ neverUsed: z.literal(true) });

const ListVersionJson = z.strictObject({
  version: z.int().min(1),
  root: HashText,
  status: z.enum(['built', 'sending', 'posted', 'active', 'superseded', 'cancelled']),
  postTx: HashText.nullable(),
  claimableAt: Count.nullable(),
});

export const CampaignView = z.strictObject({
  name: plainText(80),
  chain: z.int().min(1),
  vault: CanonicalAddressText,
  token: CanonicalAddressText,
  rewardPerWallet: AmountText,
  perWalletCap: AmountText,
  maxSlots: z.int().min(1).max(100_000),
  status: z.enum(['open', 'closed']),
  opensAt: z.iso.datetime(),
  closesAt: z.iso.datetime(),
  counts: z.strictObject({
    asked: Count,
    queued: Count,
    decided: Count,
    held: Count,
    slotsTaken: Count,
    slotsLeft: Count,
    asksLeft: Count,
    appeals: z.strictObject({ filed: Count, checked: Count, block: Count, reversed: Count }),
  }),
  lists: z.array(ListVersionJson),
});
export type CampaignView = z.infer<typeof CampaignView>;

const FactsJson = z.strictObject({
  ageDays: Count.nullable(),
  txCount: Count.nullable(),
  accountType: plainText(32),
  funder: z
    .strictObject({ address: CanonicalAddressText, kind: plainText(32), fanout: Count.nullable(), hops: Count })
    .nullable(),
  burstWallets: Count.nullable(),
  groupSize: Count.nullable(),
  missing: z.array(plainText(64)).max(16),
  // The chain the facts were read on, so each cited transaction links to that chain's explorer.
  chain: z.enum(SCREENED_CHAINS),
});

/**
 * One appeal as anyone may see it: the store's public view, with times as ISO 8601 text. It has no field for the
 * appeal's text, its hash, its signature or the owner's note (C40). reppoNote is another service's model text, held to
 * the plain-text rule and 280 characters (C34).
 */
export const AppealJson = z.strictObject({
  filedAt: z.iso.datetime(),
  checkStatus: z.enum(['queued', 'checking', 'checked', 'unchecked']),
  reppoRoute: z.enum(['ship', 'review', 'block']).nullable(),
  reppoNote: plainText(280).nullable(),
  reppoEvalId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable(),
  checkedAt: z.iso.datetime().nullable(),
  outcome: z.enum(['open', 'reversed', 'upheld']),
  newAction: z.enum(['full', 'partial']).nullable(),
  settledAt: z.iso.datetime().nullable(),
});
export type AppealJson = z.infer<typeof AppealJson>;

/** The body POST /api/campaigns/:id/appeals takes, by type and size only; checkAppeal judges the values. */
export const AppealRequest = z.strictObject({
  wallet: z.string().max(64),
  text: z.string().max(2_000),
  signedAt: z.number(),
  signature: z.string().max(200),
});

export const ExistsAppealBody = z.strictObject({ exists: z.literal(true), appeal: AppealJson });
export const UndecidedBody = z.strictObject({ undecided: z.literal(true) });
export const ApprovedBody = z.strictObject({ approved: z.literal(true) });

/** One ask as anyone may see it: the store's public view, with times as ISO 8601 text. */
export const AskJson = z.strictObject({
  campaignId: z.string().regex(CAMPAIGN_ID),
  wallet: CanonicalAddressText,
  askedAt: z.iso.datetime(),
  status: z.enum(['queued', 'screening', 'decided', 'failed']),
  action: OutcomeSchema.nullable(),
  shareBps: z.int().min(0).max(10_000).nullable(),
  rule: z.enum(DECISION_RULES).nullable(),
  reason: plainText(400).nullable(),
  citedTxs: z.array(TxHash).max(MAX_EVIDENCE_TXS).nullable(),
  notChecked: z.array(plainText(64)).max(16).nullable(),
  facts: FactsJson.nullable(),
  servRequestId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).nullable(),
  decidedAt: z.iso.datetime().nullable(),
  slot: z.int().min(1).nullable(),
  appeal: AppealJson.nullable(),
});
export type AskJson = z.infer<typeof AskJson>;

/** What a wallet on the active list needs to claim. claimed and claimable are left out when the vault was not read. */
export const TicketJson = z.strictObject({
  cumulativeAmount: AmountText,
  // A tree of 100,000 leaves is 17 levels deep, so 64 is far past any real proof.
  proof: z.array(HashText).max(64),
  root: HashText,
  claimed: AmountText.optional(),
  claimable: AmountText.optional(),
});

export const AskView = z.strictObject({ ask: AskJson, ticket: TicketJson.optional() });
export const ExistsBody = z.strictObject({ exists: z.literal(true), ask: AskJson });
// The most one board call can return: its own page limit, then the asks that share the last one's instant. A page
// that runs on through a tie must still pass, or the tie would turn into a 500.
export const BoardPage = z.strictObject({ asks: z.array(AskJson).max(MAX_BOARD_PAGE + MAX_BOARD_TIES) });

/**
 * A cached free check read back from the store, checked like an input before it goes out again (C34): it must pass
 * FreeCheckResponse and name the wallet asked for. Answers null for anything else, so a damaged entry costs a new
 * screening, which the ceilings still bound, and never reaches a caller.
 */
export function cachedBody(checked: Address, stored: unknown): FreeCheckResponse | null {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return null;
  const parsed = FreeCheckResponse.safeParse({ ...stored, cached: true });
  return parsed.success && parsed.data.wallet === checked ? parsed.data : null;
}

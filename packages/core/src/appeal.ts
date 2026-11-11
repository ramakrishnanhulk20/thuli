import { sha256, stringToBytes, verifyMessage, type Hex } from 'viem';
import { z } from 'zod';
import { parseAddress, type Address } from './address.ts';
import { DECISION_RULES, FORBIDDEN_IN_REASON, MAX_REASON_CHARS, NON_PLAIN_CHARACTERS } from './decision.ts';
import { CanonicalAddress } from './facts.ts';
import { leastGenerous, OutcomeSchema, type Outcome } from './outcome.ts';

export const MAX_APPEAL_CHARS = 1000;
export const APPEAL_WINDOW_SECONDS = 600;
// A device clock can run a little fast, so a signature may be dated this far ahead of ours.
export const FUTURE_SKEW_SECONDS = 60;

export const APPEAL_ADVICE = ['reverse', 'uphold', 'unclear'] as const;
export type AppealAdvice = (typeof APPEAL_ADVICE)[number];

// No spaces, line breaks or colons: a line break in an id could forge the other lines of the signed text, and the
// appeal store's key is the id, a colon and the wallet.
export const CAMPAIGN_ID = /^[A-Za-z0-9._-]{1,128}$/;
const TEXT_HASH = /^0x[0-9a-f]{64}$/;
// Exactly 65 bytes as text. viem also takes other shapes, and whatever passes here goes into storage (C41).
export const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const MAX_REQUEST_ID_CHARS = 128;

// One plain-text rule for model reasons and appeal text, so the two can never drift apart.
const FORBIDDEN_IN_TEXT = FORBIDDEN_IN_REASON;

const SIGNATURE_CAUSE = 'the signature does not match this appeal';

export class AppealError extends Error {
  override name = 'AppealError';
}

export interface AppealInput {
  campaignId: string;
  wallet: string;
  text: string;
  signedAt: number;
  signature: string;
}

export type AppealCheck = { ok: true; wallet: Address; textHash: string } | { ok: false; cause: string };

const refuse = (cause: string): AppealCheck => ({ ok: false, cause });

/**
 * True when text holds no link, no markup, no control characters and no broken unicode. This is decision.ts's rule for a
 * reason (C13, C33) plus the unicode check, which matters for hashing: a lone surrogate encodes to the same bytes as the
 * replacement character, so two different stored texts would share one signed hash (C8).
 *
 * Covers the plain spellings only. A link written with look-alike letters passes, which is why text is shown inert (C33).
 */
export function isPlainText(text: string): boolean {
  const lowered = text.toLowerCase();
  return !FORBIDDEN_IN_TEXT.some((token) => lowered.includes(token)) && !NON_PLAIN_CHARACTERS.test(text) && text.isWellFormed();
}

/**
 * The SHA-256 of the UTF-8 bytes of the text exactly as stored: 0x and 64 lowercase hex characters. There is deliberately
 * no way to pass a hash in, so a client-sent one has nowhere to go (C8).
 */
export function appealTextHash(text: string): string {
  // Bytes, not the string: viem reads a string starting with 0x as hex, so an appeal reading "0xdead" would hash wrongly.
  return sha256(stringToBytes(text));
}

/**
 * The exact text a wallet signs for an appeal. Its first line is the domain, so a sign-in message can never read as an
 * appeal (C7). The address always goes through parseAddress, so every spelling of a wallet signs the same text (C1).
 *
 * @throws AppealError when the campaign id, the hash or the time could change the shape of the text.
 * @throws AddressError when the wallet is not an address.
 */
export function appealMessage(a: { campaignId: string; wallet: string; textHash: string; signedAt: number }): string {
  // RegExp.test turns a non-string into text first, so an array holding a good id would otherwise pass.
  if (typeof a.campaignId !== 'string' || !CAMPAIGN_ID.test(a.campaignId)) {
    throw new AppealError('a campaign id is letters, digits, dots, dashes or underscores');
  }
  if (!TEXT_HASH.test(a.textHash)) throw new AppealError('the text hash must come from appealTextHash');
  if (!Number.isSafeInteger(a.signedAt) || a.signedAt < 0) throw new AppealError('the signing time must be whole seconds');
  return `Thuli appeal v1\nCampaign: ${a.campaignId}\nWallet: ${parseAddress(a.wallet)}\nAppeal text SHA-256: ${a.textHash}\nSigned at: ${a.signedAt}\n`;
}

/**
 * Checks one signed appeal. The hash and the signed message are rebuilt here from the stored text and the campaign the
 * server expected, so a signature only verifies for exactly this text, campaign, wallet and time (C7, C8). Contract
 * wallets are refused outright, the one rule C9 allows until sign-in shares a verifier; a delegated EOA keeps its own key
 * and counts as a wallet, so isContract must reflect accountType 'contract' only (C20). Anything that throws is a refusal,
 * and so is any isContract answer but true or false.
 *
 * The first failed check in this order gives the cause, always a fixed text: address, text length, text content, campaign,
 * signing time, signature, contract wallet. The signature is checked before the account type because it costs nothing,
 * so a request nobody signed can never make the server read the chain.
 *
 * @param opts.now The current time in unix seconds, from the server's clock.
 * @param opts.isContract Reads the wallet's account type. Runs only after every free check, the signature included, has passed.
 * @returns The canonical wallet and our own text hash, or a fixed cause. Never throws.
 */
export async function checkAppeal(
  input: AppealInput,
  opts: { expectedCampaignId: string; now: number; isContract(address: Address): Promise<boolean> },
): Promise<AppealCheck> {
  let wallet: Address;
  try {
    wallet = parseAddress(input.wallet);
  } catch {
    return refuse('the wallet is not a valid address');
  }

  const { text } = input;
  if (typeof text !== 'string' || text.trim() === '') return refuse('the appeal text is empty');
  if (text.length > MAX_APPEAL_CHARS) return refuse(`the appeal text is longer than ${MAX_APPEAL_CHARS} characters`);
  if (!isPlainText(text)) return refuse('the appeal text contained a link, markup or control characters');

  if (input.campaignId !== opts.expectedCampaignId) return refuse('this appeal is for a different campaign');

  if (!Number.isSafeInteger(input.signedAt)) return refuse('the signing time is not a whole number of seconds');
  const age = opts.now - input.signedAt;
  // Written as "not within", so a now that is not a number is refused instead of slipping past both comparisons.
  if (!(age <= APPEAL_WINDOW_SECONDS)) return refuse('the signature is too old');
  if (!(age >= -FUTURE_SKEW_SECONDS)) return refuse('the signature is dated in the future');

  if (typeof input.signature !== 'string' || !SIGNATURE.test(input.signature)) return refuse(SIGNATURE_CAUSE);
  const textHash = appealTextHash(text);
  try {
    const message = appealMessage({ campaignId: opts.expectedCampaignId, wallet, textHash, signedAt: input.signedAt });
    if (!(await verifyMessage({ address: wallet, message, signature: input.signature as Hex }))) return refuse(SIGNATURE_CAUSE);
  } catch {
    return refuse(SIGNATURE_CAUSE);
  }

  let contract: unknown;
  try {
    contract = await opts.isContract(wallet);
  } catch {
    return refuse('the wallet type could not be checked');
  }
  if (contract === true) return refuse('contract wallets cannot appeal yet');
  // Only a plain false lets the wallet on, so a reader that answers null for "unknown" fails closed (C11).
  if (contract !== false) return refuse('the wallet type could not be checked');
  return { ok: true, wallet, textHash };
}

/**
 * One appeal as stored and shown to the owner. A record whose text no longer matches its hash, or that claims a new action
 * without a reversal, fails the schema, so it is never written and is skipped when read back (C8, C17). The model's advice
 * sits in its own fields and no code path turns it into a status or a new action.
 */
export const AppealRecord = z
  .strictObject({
    campaignId: z.string().regex(CAMPAIGN_ID),
    wallet: CanonicalAddress,
    text: z.string().min(1).max(MAX_APPEAL_CHARS),
    textHash: z.string().regex(TEXT_HASH),
    signedAt: z.int().min(0),
    signature: z.string().regex(SIGNATURE),
    appealedAction: OutcomeSchema,
    appealedRule: z.enum(DECISION_RULES),
    advice: z.enum(APPEAL_ADVICE).nullable(),
    adviceReason: z.string().max(MAX_REASON_CHARS).nullable(),
    adviceRequestId: z.string().max(MAX_REQUEST_ID_CHARS).nullable(),
    status: z.enum(['open', 'reversed', 'upheld']),
    newAction: OutcomeSchema.nullable(),
    ownerNote: z.string().max(MAX_APPEAL_CHARS).nullable(),
  })
  .refine((record) => appealTextHash(record.text) === record.textHash, 'the stored text does not match its hash')
  .refine((record) => (record.status === 'reversed') === (record.newAction !== null), 'only a reversed appeal has a new action');

export type AppealRecord = z.infer<typeof AppealRecord>;

/**
 * Closes an open appeal on the project owner's word. Advice is copied along but never read, so what the model said cannot
 * change the result (C17). The owner's identity is not checked here: confirmed must come from the caller's signed-in
 * session, and this function only refuses to act without it.
 *
 * @param owner.outcome 'reversed' needs a newAction more generous than the appealed action. 'upheld' takes no newAction.
 * @returns A new record with the outcome. The record passed in is not changed.
 * @throws AppealError without confirmation, on an appeal already settled, or when the outcome and newAction do not fit.
 * @throws ZodError when the record or the note does not match AppealRecord.
 */
export function settleAppeal(
  record: AppealRecord,
  owner: { confirmed: boolean; outcome: 'reversed' | 'upheld'; newAction?: Outcome; note: string },
): AppealRecord {
  if (owner.confirmed !== true) throw new AppealError('the project owner has not confirmed this');
  const current = AppealRecord.parse(record);
  if (current.status !== 'open') throw new AppealError('this appeal is already settled');

  if (owner.outcome === 'upheld') {
    if (owner.newAction !== undefined) throw new AppealError('an upheld appeal keeps the decision, so it has no new action');
    return AppealRecord.parse({ ...current, status: 'upheld', newAction: null, ownerNote: owner.note });
  }
  if (owner.outcome !== 'reversed') throw new AppealError('the outcome must be reversed or upheld');
  const { newAction } = owner;
  if (newAction === undefined || newAction === current.appealedAction || leastGenerous(newAction, current.appealedAction) === newAction) {
    throw new AppealError('a reversal must give the wallet more than the decision it appealed');
  }
  return AppealRecord.parse({ ...current, status: 'reversed', newAction, ownerNote: owner.note });
}

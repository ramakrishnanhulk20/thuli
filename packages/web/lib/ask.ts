import { getAddress } from 'viem';

/** The campaign id rule core/src/appeal.ts keeps line breaks and colons out of the signed text with. */
export const CAMPAIGN_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** A signature is 0x and 130 hex characters, which is 132 characters in all. */
export const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/**
 * Whether what a wallet returned is one key's signature: exactly 65 bytes. A wallet that signs through a contract
 * answers with another length, and the route cannot check that kind, so it is not sent.
 */
export function isOwnKeySignature(signature: string): boolean {
  return SIGNATURE.test(signature);
}

/**
 * The exact text a wallet signs to ask to join a campaign: four lines, each ending in a newline, built the way
 * packages/core/src/ask.ts builds it. The server rebuilds this text and the signature only checks for exactly this
 * campaign, wallet and time, so the wallet is written in its checksummed spelling.
 *
 * @throws RangeError when the campaign id or the time could change the shape of the text, or the wallet is not an address.
 */
export function askMessage(input: { campaignId: string; wallet: string; signedAt: number }): string {
  if (!CAMPAIGN_ID.test(input.campaignId)) throw new RangeError('a campaign id is letters, digits, dots, dashes or underscores');
  if (!Number.isSafeInteger(input.signedAt) || input.signedAt < 0) throw new RangeError('the signing time must be whole seconds');
  return `Thuli ask v1\nCampaign: ${input.campaignId}\nWallet: ${getAddress(input.wallet)}\nSigned at: ${input.signedAt}\n`;
}

/** The time to sign with: whole seconds from a clock in milliseconds. */
export function signedAtNow(nowMilliseconds: number = Date.now()): number {
  return Math.floor(nowMilliseconds / 1000);
}

/** The body the ask route takes, with exactly its three fields in this order. */
export function askBody(input: { wallet: string; signedAt: number; signature: string }): string {
  return JSON.stringify({ wallet: input.wallet, signedAt: input.signedAt, signature: input.signature });
}

/** The longest appeal the form takes, and the length from which it shows how much room is left. */
export const APPEAL_MAX_CHARS = 280;
export const APPEAL_COUNTER_FROM = 200;

// Core's one rule for a model's reason and for an appeal's text, so a text the page lets through is a text the route
// lets through: no link, no markup, no control or invisible character, no broken unicode.
const NOT_IN_PLAIN_WORDS: readonly string[] = ['http', 'www.', '<', '>', ']('];
const NON_PLAIN_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}]/u;

export function isPlainWords(text: string): boolean {
  const lowered = text.toLowerCase();
  return !NOT_IN_PLAIN_WORDS.some((token) => lowered.includes(token)) && !NON_PLAIN_CHARACTERS.test(text) && text.isWellFormed();
}

/**
 * Core keeps and hashes an appeal exactly as it is sent and refuses one that is only spaces. It does not trim, so the page
 * trims once and sends, and hashes, that same text: a signature is over the hash of what the route will store.
 */
export function prepareAppealText(raw: string): string {
  return raw.trim();
}

export type AppealProblem = 'empty' | 'unplain';

/** Why the text in the box cannot be sent yet, or null when it can. */
export function appealProblem(raw: string): AppealProblem | null {
  const text = prepareAppealText(raw);
  if (text === '') return 'empty';
  return isPlainWords(text) ? null : 'unplain';
}

/** The SHA-256 of the text as UTF-8 bytes: 0x and 64 lowercase hex characters, the form core hashes to. */
export async function appealTextHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

const TEXT_HASH = /^0x[0-9a-f]{64}$/;

/**
 * The exact text a wallet signs to appeal: five lines, each ending in a newline, built the way packages/core/src/appeal.ts
 * builds it. The signature covers the hash of the text, so it only holds for exactly this text, campaign, wallet and time.
 *
 * @throws RangeError when the campaign id, the hash or the time could change the shape of the text, or the wallet is not an address.
 */
export function appealMessage(input: { campaignId: string; wallet: string; textHash: string; signedAt: number }): string {
  if (!CAMPAIGN_ID.test(input.campaignId)) throw new RangeError('a campaign id is letters, digits, dots, dashes or underscores');
  if (!TEXT_HASH.test(input.textHash)) throw new RangeError('the text hash is 0x and 64 lowercase hex characters');
  if (!Number.isSafeInteger(input.signedAt) || input.signedAt < 0) throw new RangeError('the signing time must be whole seconds');
  return `Thuli appeal v1\nCampaign: ${input.campaignId}\nWallet: ${getAddress(input.wallet)}\nAppeal text SHA-256: ${input.textHash}\nSigned at: ${input.signedAt}\n`;
}

/** The body the appeals route takes, with exactly its four fields in this order. */
export function appealBody(input: { wallet: string; text: string; signedAt: number; signature: string }): string {
  return JSON.stringify({ wallet: input.wallet, text: input.text, signedAt: input.signedAt, signature: input.signature });
}

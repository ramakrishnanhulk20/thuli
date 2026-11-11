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

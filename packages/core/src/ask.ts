import { recoverMessageAddress, type Hex } from 'viem';
import { parseAddress, type Address } from './address.ts';
import { AppealError, CAMPAIGN_ID, FUTURE_SKEW_SECONDS, SIGNATURE } from './appeal.ts';

// The same window as an appeal today, under its own name so changing one never quietly changes the other.
export const ASK_WINDOW_SECONDS = 600;

const SIGNATURE_CAUSE = 'the signature does not match this ask';

export interface AskInput {
  campaignId: string;
  wallet: string;
  signedAt: number;
  signature: string;
}

export type AskCheck = { ok: true; wallet: Address } | { ok: false; cause: string };

const refuse = (cause: string): AskCheck => ({ ok: false, cause });

/**
 * The exact text a wallet signs to ask to join a campaign. Its first line names it an ask, which no appeal or sign-in text
 * starts with, so a signature over it can never be read as either (C7). The campaign id follows the appeal's rule, which
 * keeps line breaks and colons out of the signed text. The wallet always goes through parseAddress, so every spelling of
 * one wallet signs the same text (C1).
 *
 * @throws AppealError, the error appealMessage throws, when the campaign id or the time could change the shape of the text.
 * @throws AddressError when the wallet is not an address.
 */
export function askMessage(a: { campaignId: string; wallet: string; signedAt: number }): string {
  // RegExp.test turns a non-string into text first, so an array holding a good id would otherwise pass.
  if (typeof a.campaignId !== 'string' || !CAMPAIGN_ID.test(a.campaignId)) {
    throw new AppealError('a campaign id is letters, digits, dots, dashes or underscores');
  }
  if (!Number.isSafeInteger(a.signedAt) || a.signedAt < 0) throw new AppealError('the signing time must be whole seconds');
  return `Thuli ask v1\nCampaign: ${a.campaignId}\nWallet: ${parseAddress(a.wallet)}\nSigned at: ${a.signedAt}\n`;
}

/**
 * Checks one signed ask to join a campaign. The signed text is rebuilt here from the campaign the server expected, so a
 * signature only verifies for exactly this campaign, wallet and time (C7). The signer is recovered by viem's
 * recoverMessageAddress, the recovery inside checkAppeal's verifyMessage, with no onchain or offchain lookup, and must
 * equal the wallet once both have come out of parseAddress (C1, C9). Contract wallets are refused outright, the rule
 * appeals follow; isContract must reflect accountType 'contract' only, so a delegated EOA still counts as a wallet (C20).
 *
 * The first failed check in this order gives the cause, always a fixed text: address, campaign, signing time, age, future
 * date, contract wallet, signature. Anything that throws is a refusal, and so is any isContract answer but true or false.
 *
 * @param ctx.expectedCampaignId The campaign this request is for, taken from the server's route and never from the body.
 * @param ctx.now The current time in unix seconds, from the server's clock.
 * @param ctx.isContract Reads the wallet's account type. Runs only after every free check has passed.
 * @returns The canonical wallet, or a fixed cause. Never throws.
 */
export async function checkAsk(
  input: AskInput,
  ctx: { expectedCampaignId: string; now: number; isContract(address: Address): Promise<boolean> },
): Promise<AskCheck> {
  let wallet: Address;
  try {
    // Read inside the try, so an input that is not an object at all is refused here rather than thrown.
    wallet = parseAddress(input.wallet);
  } catch {
    return refuse('the wallet is not a valid address');
  }

  if (input.campaignId !== ctx.expectedCampaignId) return refuse('this ask is for a different campaign');

  if (!Number.isSafeInteger(input.signedAt)) return refuse('the signing time is not a whole number of seconds');
  const age = ctx.now - input.signedAt;
  // Written as "not within", so a now that is not a number is refused instead of slipping past both comparisons.
  if (!(age <= ASK_WINDOW_SECONDS)) return refuse('the signature is too old');
  if (!(age >= -FUTURE_SKEW_SECONDS)) return refuse('the signature is dated in the future');

  let contract: unknown;
  try {
    contract = await ctx.isContract(wallet);
  } catch {
    return refuse('the wallet type could not be checked');
  }
  if (contract === true) return refuse('contract wallets cannot ask yet');
  // Only a plain false lets the wallet on, so a reader that answers null for "unknown" fails closed.
  if (contract !== false) return refuse('the wallet type could not be checked');

  if (typeof input.signature !== 'string' || !SIGNATURE.test(input.signature)) return refuse(SIGNATURE_CAUSE);
  try {
    const message = askMessage({ campaignId: ctx.expectedCampaignId, wallet, signedAt: input.signedAt });
    const signer = parseAddress(await recoverMessageAddress({ message, signature: input.signature as Hex }));
    return signer === wallet ? { ok: true, wallet } : refuse(SIGNATURE_CAUSE);
  } catch {
    return refuse(SIGNATURE_CAUSE);
  }
}

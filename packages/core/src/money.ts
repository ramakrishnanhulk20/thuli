export class MoneyError extends Error {
  override name = 'MoneyError';
}

export const USDC_DECIMALS = 6;

export const WHOLE_SHARE_BPS = 10_000;

const UNIT = 10n ** BigInt(USDC_DECIMALS);
// JavaScript's [0-9] is ASCII only and its $ never matches before a trailing newline, so this one pattern refuses signs,
// exponents, padding, separators and non-ASCII digits without a list of each.
const USDC_TEXT = /^(0|[1-9][0-9]{0,29})(\.[0-9]{1,6})?$/;
// The first amount whose whole part is 31 digits, which parseUsdc refuses, so formatUsdc refuses it too.
const FORMAT_LIMIT = 10n ** BigInt(30 + USDC_DECIMALS);

/**
 * Reads a USDC amount written as decimal text into base units, exactly (threat model C3). Only the canonical form is
 * accepted: no sign, exponent, spaces, separators, leading zero, bare dot, or more than 6 decimals.
 *
 * @throws MoneyError for anything else.
 */
export function parseUsdc(text: string): bigint {
  if (typeof text !== 'string') throw new MoneyError('an amount must be text');
  const match = USDC_TEXT.exec(text);
  if (!match) throw new MoneyError('not a USDC amount: digits, then at most 6 decimals after one dot');
  const whole = BigInt(match[1] as string);
  const fraction = BigInt((match[2] ?? '.').slice(1).padEnd(USDC_DECIMALS, '0'));
  return whole * UNIT + fraction;
}

/**
 * Writes base units as the decimal text parseUsdc reads back to the same amount: no trailing zeros, and no dot for a
 * whole number.
 *
 * @throws MoneyError for a value that is not a bigint, is negative, or is too large for parseUsdc to read back.
 */
export function formatUsdc(amount: bigint): string {
  if (typeof amount !== 'bigint') throw new MoneyError('an amount must be a bigint in base units');
  if (amount < 0n) throw new MoneyError('an amount cannot be negative');
  if (amount >= FORMAT_LIMIT) throw new MoneyError('an amount above 30 whole digits cannot be read back');
  const fraction = (amount % UNIT).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  const whole = (amount / UNIT).toString();
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/**
 * The amount a share of `fullAmount` comes to, rounded down so a list can never promise more than the full amounts it
 * was built from (C3). Every share in Thuli becomes an amount here and nowhere else.
 *
 * @param shareBps Whole basis points, 0 to 10000.
 * @throws MoneyError unless fullAmount is a bigint of zero or more and shareBps is an integer from 0 to 10000.
 */
export function shareOf(fullAmount: bigint, shareBps: number): bigint {
  if (typeof fullAmount !== 'bigint' || fullAmount < 0n) throw new MoneyError('the full amount must be a bigint of zero or more');
  if (!Number.isInteger(shareBps) || shareBps < 0 || shareBps > WHOLE_SHARE_BPS) {
    throw new MoneyError(`a share must be whole basis points from 0 to ${WHOLE_SHARE_BPS}`);
  }
  return (fullAmount * BigInt(shareBps)) / BigInt(WHOLE_SHARE_BPS);
}

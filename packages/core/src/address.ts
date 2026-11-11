import { getAddress } from 'viem';

export type Address = `0x${string}`;

export class AddressError extends Error {
  override name = 'AddressError';
}

const HEX_ADDRESS = /^0x([0-9a-fA-F]{40})$/;

/**
 * The one address parser for all of Thuli (threat model C1). Every stored, compared, hashed or looked-up address
 * goes through here, so two spellings of one wallet always become the same string.
 *
 * Accepts all-lowercase or all-uppercase hex, and mixed case only when its EIP-55 checksum is right. A wrong
 * checksum is treated as a likely typo and rejected, never quietly lowercased.
 */
export function parseAddress(input: string): Address {
  if (typeof input !== 'string') throw new AddressError('address must be text');
  // Spreadsheet exports add a byte-order mark and Windows line endings; neither is part of the address.
  const cleaned = input.replace(/^\ufeff/, '').trim();
  const match = HEX_ADDRESS.exec(cleaned);
  if (!match) throw new AddressError('not a 0x address of 40 hex characters');
  const body = match[1] as string;
  const canonical = getAddress(`0x${body.toLowerCase()}`);
  const singleCase = body === body.toLowerCase() || body === body.toUpperCase();
  if (!singleCase && cleaned !== canonical) {
    throw new AddressError('mixed-case address with a wrong checksum, likely a typo');
  }
  return canonical;
}

/** True when the value is already in the one canonical form parseAddress produces. */
export function isCanonicalAddress(value: string): boolean {
  try {
    return parseAddress(value) === value;
  } catch {
    return false;
  }
}

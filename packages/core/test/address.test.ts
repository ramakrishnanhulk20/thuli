// Not covered here: reading addresses from a real CSV file, ENS names, and non-EVM address formats.
import { describe, expect, it } from 'vitest';
import { AddressError, parseAddress } from '../src/address.ts';

const CHECKSUMMED = '0x041f77015fe51c51aE49a7f2F3Ff86C641fa190a';

describe('parseAddress', () => {
  it('turns one address written four ways into one canonical form (C1)', () => {
    const spellings = [
      CHECKSUMMED,
      CHECKSUMMED.toLowerCase(),
      `${CHECKSUMMED.toLowerCase()}   \r`,
      `\ufeff${CHECKSUMMED}`,
    ];
    const parsed = new Set(spellings.map(parseAddress));
    expect([...parsed]).toEqual([CHECKSUMMED]);
  });

  it('accepts all-uppercase hex', () => {
    expect(parseAddress(`0x${CHECKSUMMED.slice(2).toUpperCase()}`)).toBe(CHECKSUMMED);
  });

  it('rejects mixed case with a wrong checksum instead of lowercasing it (C1)', () => {
    const typo = '0x041f77015fe51c51AE49a7f2F3Ff86C641fa190a';
    expect(() => parseAddress(typo)).toThrow(AddressError);
  });

  it('rejects text that is not a 40-hex address', () => {
    for (const bad of ['', '0x', '0x041f77015fe51c51ae49a7f2f3ff86c641fa190', 'vitalik.eth', `0X${CHECKSUMMED.slice(2)}`]) {
      expect(() => parseAddress(bad)).toThrow(AddressError);
    }
  });
});

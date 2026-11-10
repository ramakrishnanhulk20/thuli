// Not covered here: that a network call is never made for a rejected chain (the parser has no network access to make one).
import { describe, expect, it } from 'vitest';
import { isCanonicalAddress } from '../src/address.ts';
import { CHAINS, ChainError, parseChain } from '../src/chains.ts';

describe('parseChain', () => {
  it('resolves every spelling of Base to base (C2)', () => {
    for (const input of [8453, '8453', '0x2105', 'base']) expect(parseChain(input)).toBe('base');
  });

  it('resolves every spelling of Base Sepolia to base-sepolia (C2)', () => {
    for (const input of [84532, '84532', '0x14a34', 'base-sepolia']) expect(parseChain(input)).toBe('base-sepolia');
  });

  it('names Circle test USDC and Basescan for Base Sepolia, the USDC in the one canonical address form (C1)', () => {
    const sepolia = CHAINS['base-sepolia'];
    expect(sepolia.usdc).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    expect(isCanonicalAddress(sepolia.usdc)).toBe(true);
    expect(sepolia.explorer).toBe('https://sepolia.basescan.org');
  });

  it('resolves 1 and "0x1" to ethereum (C2)', () => {
    expect(parseChain(1)).toBe('ethereum');
    expect(parseChain('0x1')).toBe('ethereum');
  });

  it('rejects chains that are not configured (C2)', () => {
    for (const input of [10, '0x0', 'polygon', 'toString', '__proto__', 1.5, Number.NaN]) {
      expect(() => parseChain(input)).toThrow(ChainError);
    }
  });
});

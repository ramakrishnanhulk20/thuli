// Not covered here: that a network call is never made for a rejected chain (the parser has no network access to make one).
import { describe, expect, it } from 'vitest';
import { ChainError, parseChain } from '../src/chains.ts';

describe('parseChain', () => {
  it('resolves every spelling of Base to base (C2)', () => {
    for (const input of [8453, '8453', '0x2105', 'base']) expect(parseChain(input)).toBe('base');
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

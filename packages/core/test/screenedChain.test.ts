// Not covered here: reading either chain's history (the worker does that, and firstActivityTime in factsEngine.test.ts
// is what turns it into the times compared here), and where the chosen chain is stored or shown.
import { describe, expect, it } from 'vitest';
import { isScreenedChain, olderChain, SCREENED_CHAIN_NAME, SCREENED_CHAINS } from '../src/index.ts';

const DAY = 86_400;
const T = 1_700_000_000;

describe('screened chains', () => {
  it('are Ethereum and Base, each with the name a page shows', () => {
    expect(SCREENED_CHAINS).toEqual(['ethereum', 'base']);
    expect(SCREENED_CHAIN_NAME).toEqual({ ethereum: 'Ethereum', base: 'Base' });
    expect(Object.isFrozen(SCREENED_CHAIN_NAME)).toBe(true);
  });

  it('isScreenedChain takes only the two exact names', () => {
    expect(isScreenedChain('ethereum')).toBe(true);
    expect(isScreenedChain('base')).toBe(true);
    for (const value of ['Ethereum', 'BASE', ' base', 'base-sepolia', 'mainnet', '', null, undefined, 1, 8453, ['base'], { chain: 'base' }]) {
      expect(isScreenedChain(value), String(value)).toBe(false);
    }
  });
});

describe('olderChain', () => {
  it('picks the chain whose first activity is older', () => {
    expect(olderChain({ ethereum: T - 400 * DAY, base: T - 30 * DAY })).toBe('ethereum');
    expect(olderChain({ ethereum: T - 2 * DAY, base: T - 500 * DAY })).toBe('base');
  });

  it('picks the only chain with activity, and none when neither has any', () => {
    expect(olderChain({ ethereum: T, base: null })).toBe('ethereum');
    expect(olderChain({ ethereum: null, base: T })).toBe('base');
    expect(olderChain({ ethereum: null, base: null })).toBeNull();
  });

  it('settles an exact tie on Ethereum, and takes time 0 as a real time', () => {
    expect(olderChain({ ethereum: T, base: T })).toBe('ethereum');
    expect(olderChain({ ethereum: 0, base: 0 })).toBe('ethereum');
    expect(olderChain({ ethereum: 1, base: 0 })).toBe('base');
  });

  it('refuses a time that is not a finite number of 0 or more on either chain, rather than pick', () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => olderChain({ ethereum: bad, base: T }), String(bad)).toThrow(RangeError);
      expect(() => olderChain({ ethereum: T, base: bad }), String(bad)).toThrow(RangeError);
      expect(() => olderChain({ ethereum: null, base: bad }), String(bad)).toThrow(RangeError);
    }
    // Values a typed caller cannot pass but a parsed one could: a string time, or a chain left out.
    expect(() => olderChain({ ethereum: '5' as unknown as number, base: null })).toThrow(RangeError);
    expect(() => olderChain({ ethereum: T } as unknown as Record<'ethereum' | 'base', number | null>)).toThrow(RangeError);
  });
});

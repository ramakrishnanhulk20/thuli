// Not covered here: that a network call is never made for a rejected chain (the parser has no network access to make one).
import { describe, expect, it } from 'vitest';
import { isCanonicalAddress } from '../src/address.ts';
import { CHAINS, ChainError, onChainOnly, parseChain, WrongChainError } from '../src/chains.ts';

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

describe('onChainOnly', () => {
  it('runs a read only once the endpoint has named its own chain id, and asks the id once (C2)', async () => {
    let asked = 0;
    const gate = onChainOnly(async () => {
      asked += 1;
      return 8453;
    }, 8453);
    expect(await Promise.all([gate(async () => 'a'), gate(async () => 'b')])).toEqual(['a', 'b']);
    expect(await gate(async () => 'c')).toBe('c');
    expect(asked).toBe(1);
  });

  it('refuses every read, without running it, while the endpoint names another chain, and says which id it named', async () => {
    const named: number[] = [];
    let asked = 0;
    let ran = 0;
    const gate = onChainOnly(
      async () => {
        asked += 1;
        return 84_532;
      },
      8453,
      (answered) => named.push(answered),
    );
    const read = async () => {
      ran += 1;
      return 'never';
    };
    const failures = await Promise.all([gate(read), gate(read), gate(read)].map((pending) => pending.catch((error: unknown) => error)));
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(WrongChainError);
      expect((failure as Error).message).toBe('the endpoint is on another chain');
    }
    await expect(gate(read)).rejects.toThrow(WrongChainError);
    expect([asked, ran, named]).toEqual([1, 0, [84_532]]);
  });

  it('asks the id again after a read of it that failed, so one blip closes nothing for good', async () => {
    let asked = 0;
    const gate = onChainOnly(async () => {
      asked += 1;
      if (asked === 1) throw new Error('socket hang up');
      return 1;
    }, 1);
    await expect(gate(async () => 'x')).rejects.toThrow('socket hang up');
    expect(await gate(async () => 'x')).toBe('x');
    expect(await gate(async () => 'y')).toBe('y');
    expect(asked).toBe(2);
  });
});

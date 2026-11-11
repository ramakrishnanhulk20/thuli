// Not covered here: turning decisions into claim list entries and proofs (packages/worker/test/claimList.test.ts), and
// the vault's own cap and payout math on-chain (packages/contracts/test).
import { describe, expect, it } from 'vitest';
import { formatUsdc, MoneyError, parseUsdc, shareOf, WHOLE_SHARE_BPS } from '../src/money.ts';

const MASK64 = (1n << 64n) - 1n;

/** splitmix64, so every run checks the same cases and a failing case can be replayed from its index. */
function seeded(seed: bigint) {
  let state = seed & MASK64;
  const word = (): bigint => {
    state = (state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return z ^ (z >> 31n);
  };
  /** A value from 0 up to but not including `limit`, with 64 spare bits so the modulo bias is negligible. */
  const below = (limit: bigint): bigint => {
    let value = 0n;
    let range = 1n;
    while (range < limit << 64n) {
      value = (value << 64n) | word();
      range <<= 64n;
    }
    return value % limit;
  };
  return { below, upTo: (max: number): number => Number(below(BigInt(max) + 1n)) };
}

describe('parseUsdc (C3)', () => {
  it('reads canonical text into exact base units', () => {
    expect(parseUsdc('0')).toBe(0n);
    expect(parseUsdc('1')).toBe(1_000_000n);
    expect(parseUsdc('0.000001')).toBe(1n);
    expect(parseUsdc('20')).toBe(20_000_000n);
    expect(parseUsdc('1.5')).toBe(1_500_000n);
    expect(parseUsdc(`${'9'.repeat(30)}.999999`)).toBe(10n ** 36n - 1n);
  });

  it.each([
    ['empty text', ''],
    ['a leading space', ' 1'],
    ['a trailing space', '1 '],
    ['a plus sign', '+1'],
    ['a minus sign', '-1'],
    ['an exponent', '1e3'],
    ['a leading zero', '01'],
    ['a trailing dot', '1.'],
    ['a leading dot', '.5'],
    ['seven decimals', '1.1234567'],
    ['hex', '0x10'],
    ['a thousands comma', '1,000'],
    ['a fullwidth digit', '１'],
    ['an Arabic-Indic digit', '١'],
    ['a trailing newline', '1\n'],
    ['31 whole digits', `1${'0'.repeat(30)}`],
    ['a number instead of text', 1 as unknown as string],
  ])('refuses %s', (_label, text) => {
    expect(() => parseUsdc(text)).toThrow(MoneyError);
  });

  it('adds 0.1 and 0.2 to exactly 0.3, which floating point does not', () => {
    expect(parseUsdc('0.1') + parseUsdc('0.2')).toBe(parseUsdc('0.3'));
    expect(0.1 + 0.2).not.toBe(0.3);
  });
});

describe('formatUsdc', () => {
  it('writes canonical text: no trailing zeros, and no dot for a whole number', () => {
    expect(formatUsdc(0n)).toBe('0');
    expect(formatUsdc(1_000_000n)).toBe('1');
    expect(formatUsdc(500_000n)).toBe('0.5');
    expect(formatUsdc(1n)).toBe('0.000001');
    expect(formatUsdc(20_250_000n)).toBe('20.25');
  });

  it('refuses a negative amount, a number, and an amount parseUsdc could not read back', () => {
    expect(() => formatUsdc(-1n)).toThrow(MoneyError);
    expect(() => formatUsdc(1 as unknown as bigint)).toThrow(MoneyError);
    expect(() => formatUsdc(10n ** 36n)).toThrow(MoneyError);
    expect(formatUsdc(10n ** 36n - 1n)).toBe(`${'9'.repeat(30)}.999999`);
  });

  it('round-trips with parseUsdc on 5,000 seeded random amounts', () => {
    const random = seeded(30n);
    for (let i = 0; i < 5_000; i += 1) {
      const amount = random.below(10n ** BigInt(random.upTo(36)));
      expect(parseUsdc(formatUsdc(amount)), `case ${i}: ${amount}`).toBe(amount);
    }
  });
});

describe('shareOf (C3)', () => {
  it('rounds down', () => {
    expect(shareOf(3n, 5000)).toBe(1n);
    expect(shareOf(1_000_001n, 3333)).toBe(333_300n);
    expect(shareOf(9_999n, 1)).toBe(0n);
  });

  it('refuses a negative or non-bigint amount, and a share outside whole basis points 0 to 10000', () => {
    expect(() => shareOf(-1n, 5000)).toThrow(MoneyError);
    expect(() => shareOf(10 as unknown as bigint, 5000)).toThrow(MoneyError);
    for (const share of [-1, 10_001, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '5000' as unknown as number]) {
      expect(() => shareOf(1_000_000n, share), String(share)).toThrow(MoneyError);
    }
  });

  it('matches plain bigint arithmetic above 2^53, where a JavaScript number already loses units', () => {
    const amount = 2n ** 53n + 1n;
    expect(Number(amount), 'a number cannot hold 2^53 + 1').toBe(Number(2n ** 53n));
    expect(shareOf(amount, 3333)).toBe((amount * 3333n) / 10_000n);
    const huge = 10n ** 30n + 7n;
    expect(shareOf(huge, 7777)).toBe((huge * 7777n) / 10_000n);
  });

  it('never exceeds the amount, is exact at 0 and 10000, and never falls as the share rises, on 5,000 seeded cases', () => {
    const random = seeded(3n);
    for (let i = 0; i < 5_000; i += 1) {
      const amount = random.below(10n ** BigInt(random.upTo(30)) + 1n);
      const low = random.upTo(WHOLE_SHARE_BPS);
      const high = low + random.upTo(WHOLE_SHARE_BPS - low);
      const label = `case ${i}: ${amount} at ${low} and ${high}`;
      const share = shareOf(amount, low);
      expect(share <= amount, label).toBe(true);
      expect(share * 10_000n <= amount * BigInt(low) && amount * BigInt(low) < (share + 1n) * 10_000n, label).toBe(true);
      expect(shareOf(amount, high) >= share, label).toBe(true);
      expect(shareOf(amount, WHOLE_SHARE_BPS), label).toBe(amount);
      expect(shareOf(amount, 0), label).toBe(0n);
    }
  });
});

// Not covered here: how the final decision uses this order; that lives in decision.test.ts.
import { describe, expect, it } from 'vitest';
import { leastGenerous, type Outcome } from '../src/outcome.ts';

const EXPECTED: Record<Outcome, Record<Outcome, Outcome>> = {
  full: { full: 'full', partial: 'partial', hold: 'hold', exclude: 'exclude' },
  partial: { full: 'partial', partial: 'partial', hold: 'hold', exclude: 'exclude' },
  hold: { full: 'hold', partial: 'hold', hold: 'hold', exclude: 'exclude' },
  exclude: { full: 'exclude', partial: 'exclude', hold: 'exclude', exclude: 'exclude' },
};

describe('leastGenerous', () => {
  it('picks the less generous outcome for all 16 pairs', () => {
    let pairs = 0;
    for (const [a, row] of Object.entries(EXPECTED) as [Outcome, Record<Outcome, Outcome>][]) {
      for (const [b, want] of Object.entries(row) as [Outcome, Outcome][]) {
        expect(leastGenerous(a, b), `${a} vs ${b}`).toBe(want);
        pairs += 1;
      }
    }
    expect(pairs).toBe(16);
  });
});

import { z } from 'zod';

/** Most generous first. The position in this list is the generosity order the whole system shares. */
export const OUTCOMES = ['full', 'partial', 'hold', 'exclude'] as const;

export type Outcome = (typeof OUTCOMES)[number];

export const OutcomeSchema = z.enum(OUTCOMES);

/** Returns whichever of the two outcomes gives the wallet less. */
export function leastGenerous(a: Outcome, b: Outcome): Outcome {
  return OUTCOMES.indexOf(a) >= OUTCOMES.indexOf(b) ? a : b;
}

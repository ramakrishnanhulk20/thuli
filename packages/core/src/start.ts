import { z } from 'zod';
import { limitedToPartial, meetsGroupExcludeRule } from './ceiling.ts';
import type { Facts } from './facts.ts';
import { OutcomeSchema } from './outcome.ts';
import type { Settings } from './settings.ts';

export const FIXED_RULES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9'] as const;
export type FixedRule = (typeof FIXED_RULES)[number];

export const Start = z.strictObject({ outcome: OutcomeSchema, rule: z.enum(FIXED_RULES) });
export type Start = z.infer<typeof Start>;

/**
 * The rulebook's fixed checks A1 to A9, worked out in code before SERV runs. SERV's graph generator failed its
 * decision review on the nine-step checklist, and in code the start is exact and testable (threat model C12).
 * The checks run in a fixed order and the first match wins. The model may only move this start with rule B1 or B2.
 */
export function computeStart(facts: Facts, settings: Settings): Start {
  if (
    facts.walletAgeDays === null ||
    facts.txCountAtSnapshot === null ||
    facts.accountType === 'unknown' ||
    facts.claimPaidToOtherAddress === null ||
    facts.missing.some((name) => name !== 'evidenceTxs')
  ) {
    return { outcome: 'hold', rule: 'A1' };
  }
  if (facts.accountType === 'contract') return { outcome: 'hold', rule: 'A2' };
  if (meetsGroupExcludeRule(facts, settings)) return { outcome: 'exclude', rule: 'A3' };
  if (facts.group !== null && facts.group.size >= settings.groupMinSize) return { outcome: 'hold', rule: 'A4' };
  const funder = facts.firstFunder;
  if (
    funder !== null &&
    (funder.kind === 'wallet' || funder.kind === 'unknown') &&
    funder.fanoutInList !== null &&
    funder.fanoutInList >= settings.funderFanoutMin
  ) {
    return { outcome: 'hold', rule: 'A5' };
  }
  if (facts.sharedDepositAddress !== null && facts.sharedDepositAddress.sharedWithClaimants >= 2) {
    return { outcome: 'hold', rule: 'A6' };
  }
  if (facts.claimPaidToOtherAddress) return { outcome: 'hold', rule: 'A7' };
  if (limitedToPartial(facts, settings)) {
    return { outcome: settings.allowPartial ? 'partial' : 'hold', rule: 'A8' };
  }
  return { outcome: 'full', rule: 'A9' };
}

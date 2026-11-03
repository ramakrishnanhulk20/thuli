import type { FactName, Facts } from './facts.ts';
import type { Outcome } from './outcome.ts';
import type { Settings } from './settings.ts';

/**
 * Rulebook check A3: a group big enough to count, linked by transactions this wallet sent itself, that either swept
 * to a shared collector or was funded by one source in a short window. The ceiling and the decision check both call
 * this one function, so "exclude is allowed" means the same thing in both places (threat model C15).
 */
export function meetsGroupExcludeRule(facts: Facts, settings: Settings): boolean {
  const group = facts.group;
  if (group === null) return false;
  return (
    group.size >= settings.groupMinSize &&
    group.authoredEvidence &&
    (group.sweptToSharedCollector || (group.sameFunderWithinWindow ?? 0) >= settings.groupMinSize)
  );
}

// A missing link fact could hide a farm, so without it the code will not allow more than hold.
const LINK_FACTS: readonly FactName[] = ['group', 'sharedDepositAddress', 'claimPaidToOtherAddress', 'firstFunder'];

/**
 * The most generous outcome Thuli's code allows for this wallet, computed before the model runs (threat model C12).
 * The checks run in a fixed order and the first match wins.
 */
export function computeCeiling(facts: Facts, settings: Settings): { ceiling: Outcome; reason: string } {
  if (facts.walletAgeDays === null || facts.txCountAtSnapshot === null) {
    return { ceiling: 'hold', reason: 'Wallet age or transaction count could not be read, so a person must review it.' };
  }
  if (facts.accountType === 'unknown' || facts.accountType === 'contract') {
    return {
      ceiling: 'hold',
      reason: `Account type is ${facts.accountType === 'contract' ? 'a contract' : 'unknown'}, so a person must review it.`,
    };
  }
  if (meetsGroupExcludeRule(facts, settings)) {
    return { ceiling: 'exclude', reason: 'Wallet belongs to a group it linked itself by sweeping or shared funding.' };
  }
  if (facts.claimPaidToOtherAddress === true) {
    return { ceiling: 'hold', reason: 'The reward was claimed to a different address, so a person must review it.' };
  }
  const missingLinks = LINK_FACTS.filter((name) => facts.missing.includes(name));
  if (missingLinks.length > 0) {
    return { ceiling: 'hold', reason: `Facts not yet available: ${missingLinks.join(', ')}. Doubt means hold.` };
  }
  if (facts.walletAgeDays < settings.minWalletAgeDays || facts.txCountAtSnapshot < settings.minTxCount) {
    return settings.allowPartial
      ? { ceiling: 'partial', reason: 'Wallet is newer or less active than the project minimum, so at most partial.' }
      : { ceiling: 'hold', reason: 'Wallet is newer or less active than the project minimum and partial is off.' };
  }
  return { ceiling: 'full', reason: 'No code check limits this wallet.' };
}

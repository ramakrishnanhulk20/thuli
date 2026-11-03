import { formatUnits } from 'viem';
import { FACT_NAMES, type FactName, type Facts } from './facts.ts';
import type { Outcome } from './outcome.ts';
import { FIXED_RULES, type FixedRule, type Start } from './start.ts';

/** Transfers read per claim wallet in the replay. The scorecard names this limit in its "Not covered" list. */
export const REPLAY_WALLET_LIMIT = 100;

export interface ReplayRow {
  wallet: string;
  start: Start;
  ceiling: Outcome;
  facts: Facts;
}

/** One claim wallet's family in a farm answer key. fundingWallet is null when the key names none. */
export interface FarmKeyEntry {
  collector: string;
  family: number;
  fundingWallet: string | null;
}

/**
 * How the code starts compare with a farm answer key. Every count is over the rows scored. "Held" means the start
 * outcome is hold or exclude. Ratios are null when nothing was there to divide by.
 */
export interface ReplayScore {
  wallets: number;
  byRule: { key: Record<FixedRule, number>; other: Record<FixedRule, number> };
  keyWallets: number;
  keyHeld: number;
  keyExcluded: number;
  recall: number | null;
  /** The same three and the recall, for key wallets whose family has a known funding wallet. */
  fundedWallets: number;
  fundedHeld: number;
  fundedExcluded: number;
  fundedRecall: number | null;
  /** Key wallets that had no row, as in a run cut short with a limit. */
  keyNotScreened: number;
  /** Distinct collectors among the key wallets scored. */
  families: number;
  familiesTouched: number;
  familiesFullyHeld: number;
  otherWallets: number;
  otherHeld: number;
  otherHoldRate: number | null;
  /** ROBO as decimal text, from wei at 18 decimals. */
  robo: { heldKey: string; allKey: string; heldOther: string };
  /** Key wallets traced back to the funding wallet the key names, out of fundedWallets. */
  rootMatches: number;
  dataGaps: { a1: number; missing: Record<FactName, number> };
}

const ROBO_DECIMALS = 18;

// Both sides of every address comparison go through this one function (C.2 standard 2).
function lower(value: string): string {
  return value.toLowerCase();
}

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

function zeroCounts<T extends string>(names: readonly T[]): Record<T, number> {
  return Object.fromEntries(names.map((name) => [name, 0])) as Record<T, number>;
}

function isHeld(start: Start): boolean {
  return start.outcome === 'hold' || start.outcome === 'exclude';
}

/**
 * Scores one replay against a farm answer key: how many key wallets the code held (recall), how many families it
 * reached, how many other wallets it held, the ROBO behind each, whether its traced funding root matches the key's
 * funding wallet, and where facts were missing. Pure: no network, no clock.
 *
 * @throws RangeError when two rows name the same wallet, because every count would then be off.
 */
export function scoreReplay(
  rows: ReplayRow[],
  key: Map<string, FarmKeyEntry>,
  claimedWei: Map<string, bigint>,
): ReplayScore {
  const keyLower = new Map([...key].map(([wallet, family]) => [lower(wallet), family]));
  const claimedLower = new Map([...claimedWei].map(([wallet, wei]) => [lower(wallet), wei]));
  const byRule = { key: zeroCounts(FIXED_RULES), other: zeroCounts(FIXED_RULES) };
  const missing = zeroCounts(FACT_NAMES);
  const familyHeld = new Map<string, { members: number; held: number }>();
  const seen = new Set<string>();
  let keyWallets = 0;
  let keyHeld = 0;
  let keyExcluded = 0;
  let fundedWallets = 0;
  let fundedHeld = 0;
  let fundedExcluded = 0;
  let otherHeld = 0;
  let rootMatches = 0;
  let a1 = 0;
  let heldKeyWei = 0n;
  let allKeyWei = 0n;
  let heldOtherWei = 0n;

  for (const row of rows) {
    const wallet = lower(row.wallet);
    if (seen.has(wallet)) throw new RangeError('a wallet appears in two replay rows');
    seen.add(wallet);
    const held = isHeld(row.start);
    const excluded = row.start.outcome === 'exclude';
    const wei = claimedLower.get(wallet) ?? 0n;
    if (row.start.rule === 'A1') a1 += 1;
    for (const name of row.facts.missing) missing[name] += 1;

    const family = keyLower.get(wallet);
    if (family === undefined) {
      byRule.other[row.start.rule] += 1;
      if (held) {
        otherHeld += 1;
        heldOtherWei += wei;
      }
      continue;
    }
    byRule.key[row.start.rule] += 1;
    keyWallets += 1;
    allKeyWei += wei;
    if (held) {
      keyHeld += 1;
      heldKeyWei += wei;
    }
    if (excluded) keyExcluded += 1;
    const tally = familyHeld.get(lower(family.collector)) ?? { members: 0, held: 0 };
    tally.members += 1;
    if (held) tally.held += 1;
    familyHeld.set(lower(family.collector), tally);
    if (family.fundingWallet !== null) {
      fundedWallets += 1;
      if (held) fundedHeld += 1;
      if (excluded) fundedExcluded += 1;
      const root = row.facts.firstFunder?.address;
      if (root !== undefined && lower(root) === lower(family.fundingWallet)) rootMatches += 1;
    }
  }

  const tallies = [...familyHeld.values()];
  const otherWallets = rows.length - keyWallets;
  return {
    wallets: rows.length,
    byRule,
    keyWallets,
    keyHeld,
    keyExcluded,
    recall: ratio(keyHeld, keyWallets),
    fundedWallets,
    fundedHeld,
    fundedExcluded,
    fundedRecall: ratio(fundedHeld, fundedWallets),
    keyNotScreened: [...keyLower.keys()].filter((wallet) => !seen.has(wallet)).length,
    families: tallies.length,
    familiesTouched: tallies.filter((t) => t.held > 0).length,
    familiesFullyHeld: tallies.filter((t) => t.held === t.members).length,
    otherWallets,
    otherHeld,
    otherHoldRate: ratio(otherHeld, otherWallets),
    robo: {
      heldKey: formatUnits(heldKeyWei, ROBO_DECIMALS),
      allKey: formatUnits(allKeyWei, ROBO_DECIMALS),
      heldOther: formatUnits(heldOtherWei, ROBO_DECIMALS),
    },
    rootMatches,
    dataGaps: { a1, missing },
  };
}

const RULE_MEANING: Record<FixedRule, string> = {
  A1: 'a fact could not be read, so hold',
  A2: 'the wallet is a contract, so hold',
  A3: 'a group it linked itself, so exclude',
  A4: 'a group of wallets that move together, so hold',
  A5: 'its funder funded many listed wallets, so hold',
  A6: 'it shares a deposit address, so hold',
  A7: 'the claim was paid elsewhere, so hold',
  A8: 'newer or quieter than the minimum, so partial (hold when partial is off)',
  A9: 'no check limits it, so full',
};

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

/** Whole ROBO with thousands commas and one decimal, cut rather than rounded. */
function roboText(decimal: string): string {
  const [whole = '0', fraction = ''] = decimal.split('.');
  return `${BigInt(whole).toLocaleString('en-US')}.${fraction[0] ?? '0'} ROBO`;
}

/**
 * The scorecard as short plain-English markdown. It opens with what the replay measures and what a hold here means,
 * and closes with what it does not cover.
 */
export function scoreToMarkdown(
  score: ReplayScore,
  meta: { snapshotBlock: number; snapshotTime: string; runDate: string },
): string {
  const ruleRows = FIXED_RULES.map(
    (rule) => `| ${rule} | ${RULE_MEANING[rule]} | ${count(score.byRule.key[rule])} | ${count(score.byRule.other[rule])} |`,
  );
  const missingRows = FACT_NAMES.map((name) => `- ${name}: ${count(score.dataGaps.missing[name])}`);
  return [
    '# ROBO replay: Thuli code starts against Bitquery farm families',
    '',
    'What this measures: which ROBO claim wallets Thuli would have held at claim time, using code alone.',
    'Each wallet gets the start from the fixed checks A1 to A9. "Held" means the start is hold or exclude.',
    'The score compares those starts with the wallets Bitquery later tied to farm families.',
    '',
    'Read a hold on a key wallet plainly: Thuli found wallets later shown to move together.',
    'Bitquery labelled the farm from a July to August 2026 sweep that a screener at claim time could not see.',
    `This replay uses only chain data before block ${count(meta.snapshotBlock + 1)}, the first ROBO claim.`,
    '',
    `Snapshot block: ${count(meta.snapshotBlock)} (${meta.snapshotTime})`,
    `Run date: ${meta.runDate}`,
    `Wallets screened: ${count(score.wallets)}`,
    '',
    "## Bitquery's farm key",
    '',
    `Key wallets screened: ${count(score.keyWallets)} (key wallets not in this run: ${count(score.keyNotScreened)})`,
    `Held: ${count(score.keyHeld)} (${percent(score.recall)}), of which excluded: ${count(score.keyExcluded)}`,
    `Key wallets with a known funding wallet: ${count(score.fundedWallets)}`,
    `Of those, held: ${count(score.fundedHeld)} (${percent(score.fundedRecall)}), of which excluded: ${count(score.fundedExcluded)}`,
    `Families (one per collector): ${count(score.families)}`,
    `Families with at least one wallet held: ${count(score.familiesTouched)}`,
    `Families with every wallet held: ${count(score.familiesFullyHeld)}`,
    `ROBO claimed by key wallets: ${roboText(score.robo.allKey)}`,
    `ROBO claimed by held key wallets: ${roboText(score.robo.heldKey)}`,
    '',
    '## Everyone else',
    '',
    `Other wallets: ${count(score.otherWallets)}`,
    `Held: ${count(score.otherHeld)} (${percent(score.otherHoldRate)})`,
    `ROBO claimed by held other wallets: ${roboText(score.robo.heldOther)}`,
    '',
    '## Funding roots',
    '',
    `Key wallets traced back to the funding wallet Bitquery names: ${count(score.rootMatches)} of ${count(score.fundedWallets)}`,
    '',
    '## Which check set the start',
    '',
    '| Check | Meaning | Key wallets | Other wallets |',
    '| --- | --- | --- | --- |',
    ...ruleRows,
    '',
    '## Data gaps',
    '',
    `Wallets started on A1 because a fact could not be read: ${count(score.dataGaps.a1)}`,
    'Wallets missing each fact:',
    ...missingRows,
    '',
    '## Not covered',
    '',
    '- The model is not in the loop here. These are code starts only, before SERV runs.',
    "- Holds outside Bitquery's key are an upper bound on false holds, because the key may miss farms.",
    `- Transfers past a wallet's first ${REPLAY_WALLET_LIMIT} are not read.`,
    '- Only native ETH funding is traced, not tokens.',
    '',
  ].join('\n');
}

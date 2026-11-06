import {
  count,
  FIXED_RULES,
  isHeld,
  meetsAgeAndActivity,
  parseAddress,
  percent,
  ratio,
  REPLAY_WALLET_LIMIT,
  RULE_MEANING,
  type Facts,
  type FixedRule,
  type ReplayRow,
  type Settings,
} from '@thuli/core';
import type { HopLists } from './answerKeys.ts';

// The two-sided 95% point of the normal distribution.
const Z_95 = 1.959963984540054;

/**
 * How the code starts fell on one part of Hop's list.
 *
 * noEthereumHistory counts wallets with the exact facts an empty wallet produces: walletAgeDays 0, txCountAtSnapshot 0,
 * firstFunder null and nothing missing. The engine starts those at partial under A8, but with nothing to read that is a
 * gap in this test and not a judgment, so they are left out of counted and of every field after it.
 *
 * A wallet whose read failed has a null age and is not one of these. It stays counted as a hold under A1, so a failed
 * read can only raise the rate, never hide (C11).
 *
 * heldRate is (hold + exclude) / counted, and heldLow and heldHigh are its 95% Wilson interval. All three are null
 * when nothing was counted.
 */
export interface HopCohort {
  screened: number;
  noEthereumHistory: number;
  counted: number;
  full: number;
  partial: number;
  hold: number;
  exclude: number;
  heldRate: number | null;
  heldLow: number | null;
  heldHigh: number | null;
  byRule: Record<FixedRule, number>;
  /** Counted wallets in a funding burst. */
  inBurst: number;
  /** Counted A8 wallets in a burst whose age and transaction count both meet the minimums. */
  burstOnly: number;
}

export interface HopScore {
  wallets: number;
  /** Listed wallets with no row, as in a run cut short with a limit. */
  notScreened: number;
  negatives: HopCohort;
  keptInGroups: HopCohort;
  eliminated: HopCohort;
  /** Hop's eliminated clusters. Only counted wallets are tallied, so noCounted are clusters with none to judge. */
  clusters: { total: number; touched: number; fullyHeld: number; noCounted: number };
}

// Both sides of every address comparison go through the one parser, then lowercase (C1, C.2 standard 2).
function walletKey(address: string): string {
  return parseAddress(address).toLowerCase();
}

function hasNoEthereumHistory(facts: Facts): boolean {
  return facts.walletAgeDays === 0 && facts.txCountAtSnapshot === 0 && facts.firstFunder === null && facts.missing.length === 0;
}

function wilson(part: number, whole: number): { low: number; high: number } | null {
  if (whole === 0) return null;
  const share = part / whole;
  const zSquared = Z_95 * Z_95;
  const scale = 1 + zSquared / whole;
  const centre = (share + zSquared / (2 * whole)) / scale;
  const reach = (Z_95 * Math.sqrt((share * (1 - share)) / whole + zSquared / (4 * whole * whole))) / scale;
  // Rounding can land a hair outside 0 to 1 when the share sits on either end.
  return { low: Math.max(0, centre - reach), high: Math.min(1, centre + reach) };
}

function cohortOf(rows: ReplayRow[], settings: Pick<Settings, 'minWalletAgeDays' | 'minTxCount'>): HopCohort {
  const counted = rows.filter((row) => !hasNoEthereumHistory(row.facts));
  const byRule = Object.fromEntries(FIXED_RULES.map((rule) => [rule, 0])) as Record<FixedRule, number>;
  const outcomes = { full: 0, partial: 0, hold: 0, exclude: 0 };
  let inBurst = 0;
  let burstOnly = 0;
  for (const { start, facts } of counted) {
    byRule[start.rule] += 1;
    outcomes[start.outcome] += 1;
    if (facts.fundingBurst === null) continue;
    inBurst += 1;
    if (start.rule === 'A8' && meetsAgeAndActivity(facts, settings)) burstOnly += 1;
  }
  const held = outcomes.hold + outcomes.exclude;
  const interval = wilson(held, counted.length);
  return {
    screened: rows.length,
    noEthereumHistory: rows.length - counted.length,
    counted: counted.length,
    ...outcomes,
    heldRate: ratio(held, counted.length),
    heldLow: interval?.low ?? null,
    heldHigh: interval?.high ?? null,
    byRule,
    inBurst,
    burstOnly,
  };
}

/**
 * Scores one replay against Hop's lists: for the eligible wallets no group named, the eligible wallets inside groups,
 * and the eliminated wallets, how the code starts fell and why, and how far holds reached into Hop's clusters. Pure: no
 * network, no clock.
 *
 * @throws RangeError when two rows name the same wallet, or a row names a wallet on none of the lists, because every
 * count would then be off.
 * @throws AddressError for a row or list entry that is not a 0x address.
 */
export function scoreHop(rows: ReplayRow[], lists: HopLists, settings: Pick<Settings, 'minWalletAgeDays' | 'minTxCount'>): HopScore {
  const parts = { negatives: [] as ReplayRow[], keptInGroups: [] as ReplayRow[], eliminated: [] as ReplayRow[] };
  const partOf = new Map<string, ReplayRow[]>();
  for (const wallet of lists.negatives) partOf.set(walletKey(wallet), parts.negatives);
  for (const wallet of lists.keptInGroups) partOf.set(walletKey(wallet), parts.keptInGroups);
  for (const wallet of lists.eliminated) partOf.set(walletKey(wallet), parts.eliminated);

  const clusterOf = new Map([...lists.clusters].map(([wallet, cluster]) => [walletKey(wallet), cluster]));
  const tallies = new Map([...new Set(clusterOf.values())].map((cluster) => [cluster, { counted: 0, held: 0 }]));

  const seen = new Set<string>();
  for (const row of rows) {
    const wallet = walletKey(row.wallet);
    if (seen.has(wallet)) throw new RangeError('a wallet appears in two replay rows');
    seen.add(wallet);
    const part = partOf.get(wallet);
    if (part === undefined) throw new RangeError('a replay row names a wallet on none of the Hop lists');
    part.push(row);

    const cluster = clusterOf.get(wallet);
    const tally = cluster === undefined ? undefined : tallies.get(cluster);
    if (tally === undefined || hasNoEthereumHistory(row.facts)) continue;
    tally.counted += 1;
    if (isHeld(row.start)) tally.held += 1;
  }

  const clusters = [...tallies.values()];
  return {
    wallets: rows.length,
    notScreened: partOf.size - seen.size,
    negatives: cohortOf(parts.negatives, settings),
    keptInGroups: cohortOf(parts.keptInGroups, settings),
    eliminated: cohortOf(parts.eliminated, settings),
    clusters: {
      total: clusters.length,
      touched: clusters.filter((tally) => tally.held > 0).length,
      fullyHeld: clusters.filter((tally) => tally.counted > 0 && tally.held === tally.counted).length,
      noCounted: clusters.filter((tally) => tally.counted === 0).length,
    },
  };
}

function heldRange(cohort: HopCohort): string {
  return `${percent(cohort.heldRate)} (95% interval ${percent(cohort.heldLow)} to ${percent(cohort.heldHigh)})`;
}

function outcomeLines(cohort: HopCohort): string[] {
  return [
    `Screened: ${count(cohort.screened)}`,
    `No Ethereum history, left out: ${count(cohort.noEthereumHistory)}`,
    `Counted: ${count(cohort.counted)}`,
    `Held: ${count(cohort.hold + cohort.exclude)}, ${heldRange(cohort)}`,
    `Of those, excluded: ${count(cohort.exclude)}`,
    `Cut to partial: ${count(cohort.partial)} (${percent(ratio(cohort.partial, cohort.counted))})`,
    `Paid in full: ${count(cohort.full)} (${percent(ratio(cohort.full, cohort.counted))})`,
  ];
}

function burstRow(name: string, cohort: HopCohort): string {
  const inBurst = `${count(cohort.inBurst)} (${percent(ratio(cohort.inBurst, cohort.counted))})`;
  const burstOnly = `${count(cohort.burstOnly)} (${percent(ratio(cohort.burstOnly, cohort.counted))})`;
  return `| ${name} | ${inBurst} | ${burstOnly} |`;
}

/**
 * The Hop scorecard as short plain-English markdown. It opens with what the replay measures and closes with what it
 * does not cover. It prints counts only, never a wallet, because the answer keys are not to be republished.
 */
export function hopToMarkdown(score: HopScore, meta: { snapshotBlock: number; snapshotTime: string; runDate: string }): string {
  const { negatives, keptInGroups, eliminated, clusters } = score;
  return [
    '# Hop replay: how often Thuli holds wallets Hop never suspected',
    '',
    "What this measures: how often Thuli's code would hold a wallet on Hop's final airdrop list that none of Hop's groups ever named.",
    "This replay uses only chain data before Hop's 1 April 2022 snapshot, and no model.",
    'Each wallet gets the start from the fixed checks A1 to A9. "Held" means the start is hold or exclude.',
    '',
    `Snapshot block: ${count(meta.snapshotBlock)} (${meta.snapshotTime})`,
    `Run date: ${meta.runDate}`,
    `Wallets screened: ${count(score.wallets)}`,
    `Hop wallets not in this run: ${count(score.notScreened)}`,
    '',
    "## Hop's probably-real wallets",
    '',
    'These are the wallets Hop kept and no group named. This is the headline rate.',
    '',
    ...outcomeLines(negatives),
    '',
    '## Why these wallets were held',
    '',
    'Every counted wallet from the section above, by the check that set its start. A1 means a fact could not be read, and that wallet stays counted as a hold.',
    '',
    '| Check | Meaning | Wallets |',
    '| --- | --- | --- |',
    ...FIXED_RULES.map((rule) => `| ${rule} | ${RULE_MEANING[rule]} | ${count(negatives.byRule[rule])} |`),
    '',
    '## Funding bursts',
    '',
    'A burst can cut a wallet to partial and can never hold or exclude it, so these wallets add nothing to the held rate.',
    '',
    '| Wallets | In a burst | Cut to partial by the burst alone |',
    '| --- | --- | --- |',
    burstRow("Hop's probably-real wallets", negatives),
    burstRow('Eligible wallets inside groups', keptInGroups),
    burstRow("Hop's eliminated wallets", eliminated),
    '',
    '## Eligible wallets inside groups Hop looked at',
    '',
    'A group named these wallets and Hop kept them anyway, so a hold here is neither clearly right nor clearly wrong.',
    '',
    ...outcomeLines(keptInGroups),
    '',
    "## Hop's eliminated wallets",
    '',
    ...outcomeLines(eliminated),
    '',
    `Clusters Hop eliminated: ${count(clusters.total)}`,
    `Clusters with at least one counted wallet held: ${count(clusters.touched)}`,
    `Clusters with every counted wallet held: ${count(clusters.fullyHeld)}`,
    `Clusters with no counted wallet, so neither: ${count(clusters.noCounted)}`,
    '',
    '## Not covered',
    '',
    '- Eligible means not removed by Hop, not proved real, so some held wallets may be real farms.',
    "- Hop's clusters came from a transfer graph, so catching eliminated wallets here is partly by construction and is not a recall claim.",
    "- Only Ethereum is read, and Hop's users also lived on other chains.",
    '- Wallets with no Ethereum history are left out: age 0, no transactions, no funder and no fact missing.',
    '- A wallet whose read failed is not one of those. It stays counted as a hold under A1, so a failed read can only raise the rate, never hide.',
    `- Transfers past a wallet's first ${REPLAY_WALLET_LIMIT} are not read.`,
    '- This is the code alone, with no model in the loop.',
    '- A shared address counts as private when at least half the senders in its oldest 100 transfers are on the list, so a new public address used first by list wallets can still link them.',
    '',
  ].join('\n');
}

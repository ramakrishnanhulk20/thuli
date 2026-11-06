import { formatUnits } from 'viem';
import { BURST_KEPT_CAUSE, OUTCOMES, type FarmKeyEntry, type Outcome, type ReplayRow } from '@thuli/core';
import type { DecisionRecord } from './decide.ts';

// Source: Bitquery, 329.1M ROBO worth $13.8M on the days they were claimed.
export const USD_PER_ROBO_AT_CLAIM = 13.8 / 329.1;

export const STALE_DECISION = 'a stored decision was made on different replay rows, use a fresh --out';

const ROBO_DECIMALS = 18;
const FULL_SHARE_BPS = 10_000n;

export interface KeyAndOther {
  key: number;
  other: number;
}

/**
 * How the stored SERV decisions compare with the code's starts and Bitquery's farm key. Counts of final outcomes,
 * startHeld, finalHeld and moved cover decided wallets only, so a wallet SERV never answered cannot look released or
 * held. "Held" means hold or exclude. Families count every key wallet in the rows, and an undecided member is not held.
 */
export interface DecisionScore {
  wallets: number;
  decided: number;
  undecided: number;
  modes: { v3: number; v2: number; fallbacks: number };
  tokens: { v3: { input: number; output: number }; v2: { input: number; output: number } };
  accepted: number;
  burstKept: number;
  /** Every other cause, by its text, with how many decisions it ended. */
  refused: Record<string, number>;
  final: { key: Record<Outcome, number>; other: Record<Outcome, number> };
  startHeld: KeyAndOther;
  finalHeld: KeyAndOther;
  families: { total: number; fullyHeld: number; touched: number };
  moved: { raisedByB2: KeyAndOther; heldByB1: KeyAndOther };
  /** ROBO as decimal text, from wei at 18 decimals. */
  robo: { keptKey: string; allKey: string; keptOther: string; allOther: string };
  verdictClash: { ordinaryButHeld: number; farmButPaidInFull: number };
}

// Both sides of every address comparison go through this one function (C.2 standard 2).
function lower(value: string): string {
  return value.toLowerCase();
}

function zeroOutcomes(): Record<Outcome, number> {
  return Object.fromEntries(OUTCOMES.map((name) => [name, 0])) as Record<Outcome, number>;
}

function isHeld(outcome: Outcome): boolean {
  return outcome === 'hold' || outcome === 'exclude';
}

// An undecided wallet keeps its whole claim: with no answer nothing was approved, so doubt pays nothing (C11).
function keptWei(claimed: bigint, record: DecisionRecord | undefined): bigint {
  if (record === undefined) return claimed;
  return (claimed * (FULL_SHARE_BPS - BigInt(record.shareBps))) / FULL_SHARE_BPS;
}

/**
 * Scores stored decisions against the replay rows and a farm answer key. Every count comes from the rows, so a record
 * for a wallet outside them is ignored. Pure: no network, no clock.
 *
 * @throws RangeError when two rows or two records name the same wallet, because every count would then be off.
 * @throws Error when a record's start or ceiling differs from its row's, because its answer was checked against a
 * start this report would not show.
 */
export function scoreDecisions(
  records: DecisionRecord[],
  rows: ReplayRow[],
  key: Map<string, FarmKeyEntry>,
  claimedWei: Map<string, bigint>,
): DecisionScore {
  const recordFor = new Map<string, DecisionRecord>();
  for (const record of records) {
    const wallet = lower(record.wallet);
    if (recordFor.has(wallet)) throw new RangeError('a wallet appears in two decision records');
    recordFor.set(wallet, record);
  }
  const keyLower = new Map([...key].map(([wallet, family]) => [lower(wallet), family]));
  const claimedLower = new Map([...claimedWei].map(([wallet, wei]) => [lower(wallet), wei]));

  const seen = new Set<string>();
  const modes = { v3: 0, v2: 0, fallbacks: 0 };
  const tokens = { v3: { input: 0, output: 0 }, v2: { input: 0, output: 0 } };
  const refused = new Map<string, number>();
  const final = { key: zeroOutcomes(), other: zeroOutcomes() };
  const startHeld = { key: 0, other: 0 };
  const finalHeld = { key: 0, other: 0 };
  const moved = { raisedByB2: { key: 0, other: 0 }, heldByB1: { key: 0, other: 0 } };
  const familyHeld = new Map<string, { members: number; held: number }>();
  const verdictClash = { ordinaryButHeld: 0, farmButPaidInFull: 0 };
  const kept = { key: 0n, other: 0n };
  const all = { key: 0n, other: 0n };
  let decided = 0;
  let accepted = 0;
  let burstKept = 0;

  for (const row of rows) {
    const wallet = lower(row.wallet);
    if (seen.has(wallet)) throw new RangeError('a wallet appears in two replay rows');
    seen.add(wallet);
    const family = keyLower.get(wallet);
    const side = family === undefined ? 'other' : 'key';
    const record = recordFor.get(wallet);
    if (
      record !== undefined &&
      (record.start.outcome !== row.start.outcome || record.start.rule !== row.start.rule || record.ceiling !== row.ceiling)
    ) {
      throw new Error(STALE_DECISION);
    }
    const wei = claimedLower.get(wallet) ?? 0n;
    all[side] += wei;
    kept[side] += keptWei(wei, record);

    const held = record !== undefined && isHeld(record.action);
    if (family !== undefined) {
      const tally = familyHeld.get(lower(family.collector)) ?? { members: 0, held: 0 };
      tally.members += 1;
      if (held) tally.held += 1;
      familyHeld.set(lower(family.collector), tally);
    }
    if (record === undefined) continue;

    decided += 1;
    modes[record.mode] += 1;
    if (record.fallback) modes.fallbacks += 1;
    tokens[record.mode].input += record.usage?.inputTokens ?? 0;
    tokens[record.mode].output += record.usage?.outputTokens ?? 0;
    if (record.accepted) accepted += 1;
    // The code keeping its own start is not a refused answer, so it gets its own line.
    if (record.cause === BURST_KEPT_CAUSE) burstKept += 1;
    else if (record.cause !== null) refused.set(record.cause, (refused.get(record.cause) ?? 0) + 1);
    final[side][record.action] += 1;
    if (isHeld(row.start.outcome)) startHeld[side] += 1;
    if (held) finalHeld[side] += 1;
    if (record.rule === 'B2') moved.raisedByB2[side] += 1;
    if (record.rule === 'B1') moved.heldByB1[side] += 1;
    if (record.verdict === 'ordinary_user' && held) verdictClash.ordinaryButHeld += 1;
    if (record.verdict === 'likely_farm' && record.action === 'full') verdictClash.farmButPaidInFull += 1;
  }

  const tallies = [...familyHeld.values()];
  return {
    wallets: rows.length,
    decided,
    undecided: rows.length - decided,
    modes,
    tokens,
    accepted,
    burstKept,
    refused: Object.fromEntries(refused),
    final,
    startHeld,
    finalHeld,
    families: {
      total: tallies.length,
      fullyHeld: tallies.filter((t) => t.held === t.members).length,
      touched: tallies.filter((t) => t.held > 0).length,
    },
    moved,
    robo: {
      keptKey: formatUnits(kept.key, ROBO_DECIMALS),
      allKey: formatUnits(all.key, ROBO_DECIMALS),
      keptOther: formatUnits(kept.other, ROBO_DECIMALS),
      allOther: formatUnits(all.other, ROBO_DECIMALS),
    },
    verdictClash,
  };
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function percent(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(1)}%`;
}

/** Whole ROBO with thousands commas and one decimal, cut rather than rounded. */
function roboText(decimal: string): string {
  const [whole = '0', fraction = ''] = decimal.split('.');
  return `${BigInt(whole).toLocaleString('en-US')}.${fraction[0] ?? '0'} ROBO`;
}

function dollars(roboDecimal: string): string {
  return `$${Math.round(Number(roboDecimal) * USD_PER_ROBO_AT_CLAIM).toLocaleString('en-US')}`;
}

function total(counts: Record<Outcome, number>): number {
  return OUTCOMES.reduce((sum, outcome) => sum + counts[outcome], 0);
}

function refusalLines(refused: Record<string, number>): string[] {
  const entries = Object.entries(refused).sort(([textA, a], [textB, b]) => b - a || textA.localeCompare(textB));
  if (entries.length === 0) return ['- none'];
  return entries.map(([cause, times]) => `- ${cause}: ${count(times)}`);
}

function spentLine(spentCents: number | null, decided: number): string[] {
  if (spentCents === null) return [];
  const perWallet = decided === 0 ? 'n/a' : (spentCents / decided).toFixed(3);
  return [`Spent, from the console balance: $${(spentCents / 100).toFixed(2)} (${perWallet} cents per wallet)`];
}

/**
 * The decisions scorecard as short plain-English markdown. It opens by saying this is a replay and closes with what it
 * does not cover. Refusal causes are the code's own fixed texts, so no model text is printed here.
 */
export function decisionsToMarkdown(score: DecisionScore, meta: { runDate: string; spentCents: number | null }): string {
  const keyDecided = total(score.final.key);
  const otherDecided = total(score.final.other);
  return [
    '# ROBO replay: SERV decisions',
    '',
    'This is a replay on past ROBO claim data, and no money moved.',
    'Every number below comes from answers stored from SERV.',
    'The code checks every answer, and an answer that fails a check never raises a wallet.',
    '',
    `Run date: ${meta.runDate}`,
    `Wallets: ${count(score.wallets)} (${count(score.decided)} decided, ${count(score.undecided)} undecided)`,
    '',
    '## What the model changed',
    '',
    'Counted over decided wallets, so a wallet SERV never answered does not look released.',
    `Held by the code at the start: ${count(score.startHeld.key)} key wallets, ${count(score.startHeld.other)} others`,
    `Held after SERV: ${count(score.finalHeld.key)} key wallets, ${count(score.finalHeld.other)} others`,
    `Raised by rule B2: ${count(score.moved.raisedByB2.key)} key wallets, ${count(score.moved.raisedByB2.other)} others`,
    `Held by rule B1: ${count(score.moved.heldByB1.key)} key wallets, ${count(score.moved.heldByB1.other)} others`,
    `Burst replies replaced by the code's partial: ${count(score.burstKept)}`,
    '',
    "## Bitquery's farm key",
    '',
    `Key wallets decided: ${count(keyDecided)}`,
    `Held after SERV: ${count(score.finalHeld.key)} (${percent(score.finalHeld.key, keyDecided)})`,
    `Excluded: ${count(score.final.key.exclude)}, held: ${count(score.final.key.hold)}, cut to partial: ${count(score.final.key.partial)}, paid in full: ${count(score.final.key.full)}`,
    `Families (one per collector): ${count(score.families.total)}`,
    `Families with at least one wallet held: ${count(score.families.touched)}`,
    `Families with every wallet held: ${count(score.families.fullyHeld)}`,
    '',
    '## Everyone else',
    '',
    `Other wallets decided: ${count(otherDecided)}`,
    `Paid in full: ${count(score.final.other.full)} (${percent(score.final.other.full, otherDecided)})`,
    `Cut to partial: ${count(score.final.other.partial)} (${percent(score.final.other.partial, otherDecided)})`,
    `Held: ${count(score.final.other.hold)} (${percent(score.final.other.hold, otherDecided)})`,
    `Excluded: ${count(score.final.other.exclude)} (${percent(score.final.other.exclude, otherDecided)})`,
    '',
    '## Kept back',
    '',
    'Unrealised, replay only: nothing was sold or paid.',
    `Dollars at Bitquery's claim-day value of $${USD_PER_ROBO_AT_CLAIM.toFixed(4)} per ROBO.`,
    `Key wallets: ${roboText(score.robo.keptKey)} of ${roboText(score.robo.allKey)} (${dollars(score.robo.keptKey)} of ${dollars(score.robo.allKey)})`,
    `Other wallets: ${roboText(score.robo.keptOther)} of ${roboText(score.robo.allOther)} (${dollars(score.robo.keptOther)} of ${dollars(score.robo.allOther)})`,
    'An undecided wallet counts as kept in full, because nothing was approved for it.',
    '',
    '## Answers',
    '',
    `Decided: ${count(score.decided)}`,
    `Undecided: ${count(score.undecided)}`,
    `Accepted by the checks: ${count(score.accepted)}`,
    'Refused by the checks and held:',
    ...refusalLines(score.refused),
    `Verdict clashes: ${count(score.verdictClash.ordinaryButHeld)} called ordinary but held, ${count(score.verdictClash.farmButPaidInFull)} called likely farm but paid in full`,
    '',
    '## Cost',
    '',
    `Graph (v3) answers: ${count(score.modes.v3)}, using ${count(score.tokens.v3.input)} input and ${count(score.tokens.v3.output)} output tokens`,
    `v2 answers: ${count(score.modes.v2)}, using ${count(score.tokens.v2.input)} input and ${count(score.tokens.v2.output)} output tokens`,
    `Of the v2 answers, stand-ins for a failed graph call: ${count(score.modes.fallbacks)}`,
    ...spentLine(meta.spentCents, score.decided),
    '',
    '## Not covered',
    '',
    "- Dollars use Bitquery's claim-day value, and a real sale would move the price.",
    '- These are past wallets, not a live campaign.',
    '- Tokens are not a bill. The spent line comes from the console balance.',
    '',
  ].join('\n');
}

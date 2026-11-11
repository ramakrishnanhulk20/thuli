import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DECISION_RULES, OUTCOMES, OutcomeSchema, type Outcome, type Start } from '@thuli/core';
import { MAX_SERV_CALLS_PER_SCREEN, servBudget, type ServBudget } from '../screen/single.ts';
import type { DecideDeps } from './decide.ts';
import { wilson } from './hopScore.ts';

/**
 * The three kinds of decision the repeat measure samples, a third each: wallets paid in full, wallets cut to partial,
 * and holds the model made, where the code's start was more generous than the final outcome.
 */
export const STRATA = ['full', 'partial', 'modelHold'] as const;
export type Stratum = (typeof STRATA)[number];

export const DEFAULT_WALLETS = 30;
export const DEFAULT_RUNS = 5;
export const DEFAULT_SEED = 11;

const Count = z.int().min(0);
const LowerAddress = z.string().regex(/^0x[0-9a-f]{40}$/);

/**
 * True when no reply can move the outcome: a ceiling of hold allows nothing above hold, and exclude is reached only with
 * the evidence the ceiling already shows. Repeating such a wallet measures nothing about the model.
 */
export function fixedByCode(record: { ceiling: Outcome }): boolean {
  return record.ceiling === 'hold' || record.ceiling === 'exclude';
}

/** The stratum a stored decision falls in, or null when it is in none or the code alone fixed it. */
export function stratumOf(record: { start: Start; ceiling: Outcome; action: Outcome }): Stratum | null {
  if (fixedByCode(record)) return null;
  if (record.action === 'full') return 'full';
  if (record.action === 'partial') return 'partial';
  const startWasMoreGenerous = OUTCOMES.indexOf(record.start.outcome) < OUTCOMES.indexOf('hold');
  return record.action === 'hold' && startWasMoreGenerous ? 'modelHold' : null;
}

/**
 * `size` wallets drawn by `seed`, a third from each stratum, the share that does not divide by three going to the
 * first strata in STRATA order. Each wallet is ranked by the SHA-256 of the seed and its address, so the same seed
 * always draws the same wallets and no wallet's place depends on the order the file lists them in. A stratum with
 * fewer candidates than its share gives all it has, and the shortfall is not filled from another, so the strata stay
 * what they say. Pure.
 */
export function sampleWallets<T extends { wallet: string; stratum: Stratum }>(candidates: readonly T[], size: number, seed: number): T[] {
  const rank = (wallet: string) => createHash('sha256').update(`${seed}:${wallet.toLowerCase()}`).digest('hex');
  return STRATA.flatMap((stratum, index) => {
    const share = Math.floor(size / STRATA.length) + (index < size % STRATA.length ? 1 : 0);
    return candidates
      .filter((candidate) => candidate.stratum === stratum)
      .map((candidate) => ({ candidate, key: rank(candidate.wallet) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(0, share)
      .map(({ candidate }) => candidate);
  });
}

export interface SampledWallet {
  wallet: string;
  stratum: Stratum;
  /** The stored rulebook-2 outcome the wallet was sampled by. */
  stored: Outcome;
}

/** True when the final action is more generous than the code's ceiling allows, which the output checks must never let through (C12). */
export function ceilingViolated(action: Outcome, ceiling: Outcome): boolean {
  return OUTCOMES.indexOf(action) < OUTCOMES.indexOf(ceiling);
}

/**
 * One try in the private run log. It holds codes and counts only: the model's reason and raw reply are never kept here,
 * so they cannot reach the public file by any path. A try that got no answer has answered false, is paid for in calls,
 * and is tried again on resume.
 */
export const RunLine = z.strictObject({
  seed: Count,
  wallets: Count,
  runs: Count,
  wallet: LowerAddress,
  stratum: z.enum(STRATA),
  run: z.int().min(1),
  answered: z.boolean(),
  action: OutcomeSchema.nullable(),
  rule: z.enum(DECISION_RULES).nullable(),
  mode: z.enum(['v3', 'v2']).nullable(),
  fallback: z.boolean().nullable(),
  replaced: z.boolean().nullable(),
  clamped: z.boolean().nullable(),
  requestId: z.string().max(128).nullable(),
  calls: Count,
  start: OutcomeSchema,
  ceiling: OutcomeSchema,
  ceilingViolation: z.boolean(),
  at: z.iso.datetime(),
});
export type RunLine = z.infer<typeof RunLine>;

/** How many of the actions agree with the most common one. A tie gives the same count whichever tied action is taken. */
export function mostCommonCount(actions: readonly Outcome[]): number {
  const counts = new Map<Outcome, number>();
  for (const action of actions) counts.set(action, (counts.get(action) ?? 0) + 1);
  return Math.max(0, ...counts.values());
}

const Rate = z.strictObject({
  count: Count,
  total: Count,
  rate: z.number().min(0).max(1).nullable(),
  low: z.number().min(0).max(1).nullable(),
  high: z.number().min(0).max(1).nullable(),
});
export type Rate = z.infer<typeof Rate>;

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/** A count over its total with the 95% Wilson interval the scorecard uses (hopScore.ts wilson); nulls on an empty total. */
export function rateOf(count: number, total: number): Rate {
  const interval = wilson(count, total);
  if (interval === null) return { count, total, rate: null, low: null, high: null };
  return { count, total, rate: round(count / total), low: round(interval.low), high: round(interval.high) };
}

const Score = z.strictObject({
  wallets: Count,
  runs: Count,
  /** Wallets with all their runs answered whose runs all gave one action, over such wallets. */
  allSame: Rate,
  /** Runs that matched their wallet's most common action, over all answered runs. */
  matchMode: Rate,
  /** Runs that matched the stored outcome the wallet was sampled by. */
  matchStored: Rate,
  /** Runs whose answer the output checks replaced, with a hold or with the code's own start. */
  replaced: Rate,
  routes: z.strictObject({ graph: Count, v2: Count, fallback: Count }),
  servCalls: Count,
  ceilingViolations: Count,
});
export type Score = z.infer<typeof Score>;

export interface ConsistencyScores {
  strata: Record<Stratum, Score>;
  overall: Score;
  samples: { wallet: string; stratum: Stratum; actions: Outcome[] }[];
}

interface Tally {
  wallets: number;
  runs: number;
  complete: number;
  allSame: number;
  matchMode: number;
  matchStored: number;
  replaced: number;
  graph: number;
  v2: number;
  fallback: number;
  servCalls: number;
  ceilingViolations: number;
}

const emptyTally = (): Tally => ({
  wallets: 0,
  runs: 0,
  complete: 0,
  allSame: 0,
  matchMode: 0,
  matchStored: 0,
  replaced: 0,
  graph: 0,
  v2: 0,
  fallback: 0,
  servCalls: 0,
  ceilingViolations: 0,
});

function scoreOf(tally: Tally): Score {
  return {
    wallets: tally.wallets,
    runs: tally.runs,
    allSame: rateOf(tally.allSame, tally.complete),
    matchMode: rateOf(tally.matchMode, tally.runs),
    matchStored: rateOf(tally.matchStored, tally.runs),
    replaced: rateOf(tally.replaced, tally.runs),
    routes: { graph: tally.graph, v2: tally.v2, fallback: tally.fallback },
    servCalls: tally.servCalls,
    ceilingViolations: tally.ceilingViolations,
  };
}

/**
 * Scores the run log for the sample, per stratum and overall. Each wallet's answered runs 1 to runsPerWallet count, the
 * first answer for a run number standing; every logged try, answered or not, counts toward the SERV calls. A wallet is
 * in the all-same count only once all its runs are answered, so a stopped measurement never looks steadier than it is.
 * Pure.
 */
export function scoreConsistency(sample: readonly SampledWallet[], lines: readonly RunLine[], runsPerWallet: number): ConsistencyScores {
  const tallies = Object.fromEntries(STRATA.map((stratum) => [stratum, emptyTally()])) as Record<Stratum, Tally>;
  const overall = emptyTally();
  const samples: ConsistencyScores['samples'] = [];
  for (const target of sample) {
    const key = target.wallet.toLowerCase();
    const mine = lines.filter((line) => line.wallet === key);
    const byRun = new Map<number, RunLine>();
    for (const line of mine) {
      if (line.answered && line.action !== null && line.run <= runsPerWallet && !byRun.has(line.run)) byRun.set(line.run, line);
    }
    const answered = [...byRun.entries()].sort(([a], [b]) => a - b).map(([, line]) => line);
    const actions = answered.map((line) => line.action as Outcome);
    const common = mostCommonCount(actions);
    for (const tally of [tallies[target.stratum], overall]) {
      tally.wallets += 1;
      tally.runs += answered.length;
      if (answered.length === runsPerWallet) {
        tally.complete += 1;
        if (common === runsPerWallet) tally.allSame += 1;
      }
      tally.matchMode += common;
      tally.matchStored += actions.filter((action) => action === target.stored).length;
      tally.replaced += answered.filter((line) => line.replaced === true).length;
      tally.graph += answered.filter((line) => line.mode === 'v3').length;
      tally.v2 += answered.filter((line) => line.mode === 'v2').length;
      tally.fallback += answered.filter((line) => line.fallback === true).length;
      tally.servCalls += mine.reduce((sum, line) => sum + line.calls, 0);
      tally.ceilingViolations += mine.filter((line) => line.ceilingViolation).length;
    }
    samples.push({ wallet: key, stratum: target.stratum, actions });
  }
  return {
    strata: Object.fromEntries(STRATA.map((stratum) => [stratum, scoreOf(tallies[stratum])])) as Record<Stratum, Score>,
    overall: scoreOf(overall),
    samples,
  };
}

/**
 * The public result, packages/web/public/replay/consistency.json. Numbers, fixed words, a date and, when every sampled
 * wallet is already in the public replay files, the addresses: no reason, raw reply or request id has a field here, and
 * the strict schema refuses any other key, so nothing a model wrote can be published through it (C40).
 */
export const ConsistencyFile = z.strictObject({
  schema: z.literal(1),
  runDate: z.iso.date(),
  rulebook: z.int().min(1),
  seed: Count,
  wallets: Count,
  runsPerWallet: Count,
  totalRuns: Count,
  servCalls: Count,
  ceilingViolations: Count,
  strata: z.strictObject({ full: Score, partial: Score, modelHold: Score }),
  overall: Score,
  samples: z
    .array(z.strictObject({ wallet: LowerAddress.optional(), stratum: z.enum(STRATA), actions: z.array(OutcomeSchema).max(100) }))
    .max(1000),
});
export type ConsistencyFile = z.infer<typeof ConsistencyFile>;

/**
 * Builds the public file from the scores and checks it against its own schema before anyone writes it.
 *
 * @param withAddresses false leaves every address out, for a sample with any wallet missing from the public replay.
 * @throws ZodError when the result does not match ConsistencyFile.
 */
export function publicFile(
  meta: { runDate: string; rulebook: number; seed: number; runsPerWallet: number },
  scores: ConsistencyScores,
  withAddresses: boolean,
): ConsistencyFile {
  return ConsistencyFile.parse({
    schema: 1,
    runDate: meta.runDate,
    rulebook: meta.rulebook,
    seed: meta.seed,
    wallets: scores.overall.wallets,
    runsPerWallet: meta.runsPerWallet,
    totalRuns: scores.overall.runs,
    servCalls: scores.overall.servCalls,
    ceilingViolations: scores.overall.ceilingViolations,
    strata: scores.strata,
    overall: scores.overall,
    samples: scores.samples.map(({ wallet, stratum, actions }) => (withAddresses ? { wallet, stratum, actions } : { stratum, actions })),
  });
}

/** The most SERV calls a measurement of `wallets` times `runs` may make: the per-screening cap for every run (C26). */
export function spendLimit(wallets: number, runs: number): number {
  return wallets * runs * MAX_SERV_CALLS_PER_SCREEN;
}

/**
 * The single screening's own SERV budget (servBudget), here over a whole measurement: past `limit` calls every call and
 * every retry wait is refused before it reaches SERV, and decideWallet passes the refusal on (C26, C41).
 */
export function spendGuard(deps: DecideDeps, limit: number): ServBudget {
  return servBudget(deps, limit);
}

/** True for the budget's refusal, which servBudget throws as a ScreenStopped error. */
export function stoppedBySpendGuard(error: unknown): boolean {
  return error instanceof Error && error.name === 'ScreenStopped';
}

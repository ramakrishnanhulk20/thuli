import fs from 'node:fs';
import path from 'node:path';
import { formatFraction, formatInt, formatPercent } from '../format';
import type {
  ConsistencyFile,
  ConsistencyRate,
  ConsistencySample,
  FamilyFile,
  HopFile,
  Rate,
  RateWithRange,
  VersionScore,
  VersionsFile,
  WalletShard,
  WebSummary,
} from './types';

const WALLET_PATTERN = /^0x[0-9a-f]{40}$/;

/** Where the replay files live. Tests pass their own folder because they do not run from packages/web. */
export function replayRoot(): string {
  return path.join(process.cwd(), 'public', 'replay');
}

function readJson<T>(root: string, ...parts: string[]): T {
  const file = path.join(root, ...parts);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`The replay data file public/replay/${parts.join('/')} is missing or unreadable.`);
  }
  return JSON.parse(text) as T;
}

export function loadSummary(root = replayRoot()): WebSummary {
  return readJson<WebSummary>(root, 'robo', 'summary.json');
}

/** A wallet lives in the shard named by the first two hex characters after 0x. */
export function loadShard(wallet: string, root = replayRoot()): WalletShard {
  if (!WALLET_PATTERN.test(wallet)) throw new Error(`"${wallet}" is not a lowercase 42 character wallet address.`);
  return readJson<WalletShard>(root, 'robo', 'wallets', `${wallet.slice(2, 4)}.json`);
}

export function loadFamily(index: number, root = replayRoot()): FamilyFile {
  if (!Number.isInteger(index) || index < 0) throw new Error(`"${index}" is not a family index.`);
  return readJson<FamilyFile>(root, 'robo', 'groups', `${index}.json`);
}

export function loadVersions(root = replayRoot()): VersionsFile {
  return readJson<VersionsFile>(root, 'versions.json');
}

export function loadHop(root = replayRoot()): HopFile {
  return readJson<HopFile>(root, 'hop.json');
}

export interface ScorecardCell {
  value: string;
  counts?: string;
  interval?: string;
}

/** One row of the versions scorecard: the same measure for rulebook v1 and v2. */
export interface ScorecardRow {
  key: 'catch' | 'falseHold' | 'feedback' | 'cost';
  v1: ScorecardCell;
  v2: ScorecardCell;
}

const counts = (part: number, whole: number): string => `${formatInt(part)} of ${formatInt(whole)}`;

/**
 * The interval bounds are stored as fractions of one. Writing them as percents is only right if that holds, so this
 * checks it against the counts first.
 * @throws RangeError when a bound is not a fraction that brackets held / wallets.
 */
export function intervalLine(rate: RateWithRange): string {
  const share = rate.held / rate.wallets;
  if (!(rate.low >= 0 && rate.low <= share && share <= rate.high && rate.high <= 1)) {
    throw new RangeError(
      `The interval ${rate.low} to ${rate.high} is not a pair of fractions around ${rate.held} of ${rate.wallets}, so it cannot be shown as percentages.`,
    );
  }
  return `95% interval ${formatFraction(rate.low, 2)} to ${formatFraction(rate.high, 2)}`;
}

function ratedCell(rate: Rate, digits: number): ScorecardCell {
  return { value: formatPercent(rate.held, rate.wallets, digits), counts: counts(rate.held, rate.wallets) };
}

function feedbackCell(score: VersionScore): ScorecardCell {
  return { value: `${score.feedback.right} of ${score.feedback.total}` };
}

export function buildScorecard(versions: VersionsFile): ScorecardRow[] {
  const { v1, v2, eliminatedHeld } = versions;
  return [
    { key: 'catch', v1: ratedCell(v1.catchRate, 1), v2: ratedCell(v2.catchRate, 1) },
    {
      key: 'falseHold',
      v1: { ...ratedCell(v1.falseHold, 2), interval: intervalLine(v1.falseHold) },
      v2: { ...ratedCell(v2.falseHold, 2), interval: intervalLine(v2.falseHold) },
    },
    { key: 'feedback', v1: feedbackCell(v1), v2: feedbackCell(v2) },
    { key: 'cost', v1: ratedCell(eliminatedHeld.v1, 1), v2: ratedCell(eliminatedHeld.v2, 1) },
  ];
}

/** Every check Reppo's routes cover: the number the page states. */
export function routesTotal(routes: VersionsFile['routes']): number {
  return routes.ship + routes.review + routes.block + routes.unread;
}

export function loadScorecard(root = replayRoot()): { runDate: string; rows: ScorecardRow[]; routesTotal: number } {
  const versions = loadVersions(root);
  return { runDate: versions.runDate, rows: buildScorecard(versions), routesTotal: routesTotal(versions.routes) };
}

// ---------------------------------------------------------------- the repeatability result

const ACTIONS: readonly string[] = ['full', 'partial', 'hold', 'exclude'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
// Bounds are stored to six decimals, so a bound that equals the share may differ from it by rounding.
const BOUND_TOLERANCE = 1e-6;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

function refuse(what: string): never {
  throw new Error(`public/replay/consistency.json is not usable: ${what}.`);
}

function checkRate(name: string, value: unknown): ConsistencyRate {
  if (!isRecord(value)) return refuse(`${name} is missing`);
  const { count, total, low, high } = value;
  if (!isCount(count) || !isCount(total) || total === 0 || count > total) return refuse(`${name} needs a count that is a whole number no larger than its total`);
  if (typeof low !== 'number' || typeof high !== 'number') return refuse(`${name} needs a low and a high bound`);
  const share = count / total;
  if (!(low >= 0 && low <= share + BOUND_TOLERANCE && share - BOUND_TOLERANCE <= high && high <= 1)) {
    return refuse(`${name} has an interval ${low} to ${high} that is not a pair of fractions around ${count} of ${total}`);
  }
  return value as unknown as ConsistencyRate;
}

/**
 * Reads the repeatability file and checks every field the versions page shows, so a damaged file stops the build.
 * @throws Error when the file is missing, or a field is absent, has the wrong type, or disagrees with another field.
 */
export function loadConsistency(root = replayRoot()): ConsistencyFile {
  const file = readJson<unknown>(root, 'consistency.json');
  if (!isRecord(file)) return refuse('it is not an object');
  if (typeof file.runDate !== 'string' || !ISO_DAY.test(file.runDate)) return refuse('runDate is not a day written as YYYY-MM-DD');
  if (!isCount(file.runsPerWallet) || file.runsPerWallet === 0) return refuse('runsPerWallet is not a positive whole number');
  for (const name of ['totalRuns', 'servCalls', 'ceilingViolations'] as const) {
    if (!isCount(file[name])) return refuse(`${name} is not a whole number`);
  }
  if (!isRecord(file.overall) || !isCount(file.overall.wallets) || file.overall.wallets === 0) return refuse('overall.wallets is not a positive whole number');
  checkRate('overall.allSame', file.overall.allSame);
  checkRate('overall.matchMode', file.overall.matchMode);
  const modelHold = isRecord(file.strata) ? file.strata.modelHold : undefined;
  if (!isRecord(modelHold) || !isCount(modelHold.wallets)) return refuse('strata.modelHold.wallets is not a whole number');
  if (!Array.isArray(file.samples)) return refuse('samples is not a list');
  for (const [index, sample] of file.samples.entries()) {
    if (!isRecord(sample) || typeof sample.wallet !== 'string' || !WALLET_PATTERN.test(sample.wallet)) return refuse(`sample ${index} has no wallet address`);
    if (typeof sample.stratum !== 'string' || sample.stratum === '') return refuse(`sample ${index} has no stratum`);
    const { actions } = sample;
    if (!Array.isArray(actions) || actions.length !== file.runsPerWallet || !actions.every((action) => typeof action === 'string' && ACTIONS.includes(action))) {
      return refuse(`sample ${index} does not list ${file.runsPerWallet} known actions`);
    }
  }
  if (file.samples.length !== file.overall.wallets) return refuse(`it lists ${file.samples.length} samples for ${file.overall.wallets} wallets`);
  const heldByModel = file.samples.filter((sample: ConsistencySample) => sample.stratum === 'modelHold').length;
  if (heldByModel !== modelHold.wallets) return refuse(`strata.modelHold.wallets is ${modelHold.wallets} but ${heldByModel} samples are in that stratum`);
  return file as unknown as ConsistencyFile;
}

export interface RepeatabilityFigure {
  value: string;
  label: string;
  note: string;
}

export interface RepeatabilityView {
  firstParagraph: string;
  figures: RepeatabilityFigure[];
  /** The second paragraph, or null when no model-hold wallet escaped a hold. */
  flaw: string | null;
  closing: string;
}

const intervalText = (rate: ConsistencyRate): string => `95% interval ${formatFraction(rate.low, 0)} to ${formatFraction(rate.high, 0)}`;

/** Every sentence and figure of the "asked again" section, written from the file and nothing else. */
export function buildRepeatability(file: ConsistencyFile): RepeatabilityView {
  const { overall, runsPerWallet, runDate, servCalls, ceilingViolations } = file;
  const everyone = overall.allSame.count === overall.allSame.total;
  const agreement = everyone
    ? 'Every wallet got one outcome across all its runs.'
    : `${formatInt(overall.allSame.count)} of ${formatInt(overall.allSame.total)} wallets got one outcome across all their runs.`;
  const escaped = file.samples.filter((sample) => sample.stratum === 'modelHold' && !sample.actions.includes('hold')).length;
  return {
    firstParagraph: `${formatInt(overall.wallets)} wallets from the replay were each screened ${formatInt(runsPerWallet)} more times from scratch on ${runDate}. ${agreement}`,
    figures: [
      { value: `${formatInt(overall.allSame.count)} of ${formatInt(overall.allSame.total)}`, label: 'WALLETS WITH ONE OUTCOME EVERY RUN', note: intervalText(overall.allSame) },
      { value: `${formatInt(overall.matchMode.count)} of ${formatInt(overall.matchMode.total)}`, label: "RUNS THAT MATCHED THE WALLET'S OTHER RUNS", note: intervalText(overall.matchMode) },
      { value: formatInt(ceilingViolations), label: "RUNS ABOVE THE CODE'S CEILING", note: 'The ceiling is set before the model runs.' },
    ],
    flaw:
      escaped === 0
        ? null
        : `It also found a flaw in the replay itself. ${formatInt(escaped)} of the ${formatInt(file.strata.modelHold.wallets)} sampled wallets that the stored replay holds because of the model's answer got a reward on every fresh run. Their stored hold came from a single answer the checks refused, and a refused answer is usually a one-off. The campaign worker asks again, twice, before it stores a hold of that kind.`,
    closing: `Not covered: ${formatInt(overall.wallets)} wallets is a small sample, so the intervals are wide. The same answer twice is not the same as the right answer; the replay and the control sample measure that. This run cost ${formatInt(servCalls)} SERV calls.`,
  };
}

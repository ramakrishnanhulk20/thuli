import fs from 'node:fs';
import path from 'node:path';
import { formatFraction, formatInt, formatPercent } from '../format';
import type { FamilyFile, HopFile, Rate, RateWithRange, VersionScore, VersionsFile, WalletShard, WebSummary } from './types';

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

import {
  computeCeiling,
  computeStart,
  count,
  leastGenerous,
  percent,
  ratio,
  shareFor,
  validateDecision,
  type AppealRecord,
  type FarmKeyEntry,
  type Outcome,
  type ReplayRow,
  type ReppoVerdict,
  type Settings,
} from '@thuli/core';
import type { FeedbackEntry } from '../reppo/feedback.ts';
import { STALE_ROWS, type DecisionRecord } from './decide.ts';
import { scoreDecisions } from './decisionScore.ts';
import { wilson } from './hopScore.ts';

/** Held means hold or exclude. rate is held / wallets, and 0 when there are no wallets. */
export interface HeldShare {
  held: number;
  wallets: number;
  rate: number;
}

export interface VersionScore {
  name: string;
  catchRate: { held: number; wallets: number; rate: number };
  falseHold: { held: number; wallets: number; rate: number; low: number; high: number };
  feedback: { right: number; total: number };
}

/** What outside feedback a version is marked against. */
export interface VersionFeedback {
  /** Every stored Reppo entry. Only route 'block' is marked. */
  entries: FeedbackEntry[];
  /** Claimant appeals, latest state only (see splitAppeals). Only status 'reversed' is marked. */
  appeals: AppealRecord[];
  /** This version's decisions on Hop's eliminated sample. Some blocked entries came from it, and it is no part of the false-hold rate. */
  hopEliminated: DecisionRecord[];
}

export interface VersionRecords {
  robo: DecisionRecord[];
  hopSample: DecisionRecord[];
  hopEliminated: DecisionRecord[];
}

/** One Reppo verdict in the feedback set. No wallet, because this goes into a report and the wallet would link it to a verdict. */
export interface VerdictLine {
  group: string;
  storedAction: Outcome;
  score: number | null;
  route: ReppoVerdict['route'] | null;
  confidence: ReppoVerdict['confidence'] | null;
  /** Null when v2 has no decision for this wallet. */
  v2Action: Outcome | null;
}

export interface AppealLine {
  campaignId: string;
  status: AppealRecord['status'];
  appealedAction: Outcome;
  newAction: Outcome | null;
  testWallet: boolean;
}

export interface VersionComparison {
  v1: VersionScore;
  v2: VersionScore;
  eliminatedHeld: { v1: HeldShare; v2: HeldShare };
  verdicts: VerdictLine[];
  /** Every stored Reppo entry by route. unread counts paid results that came back out of shape. */
  routes: { ship: number; review: number; block: number; unread: number };
  appeals: AppealLine[];
  testWalletAppeals: number;
}

// Both sides of every address comparison go through this one function (C.2 standard 2).
function lower(value: string): string {
  return value.toLowerCase();
}

function heldCount(records: DecisionRecord[]): number {
  return records.filter((record) => record.action === 'hold' || record.action === 'exclude').length;
}

function actionsByWallet(records: DecisionRecord[]): Map<string, Outcome> {
  return new Map(records.map((record) => [lower(record.wallet), record.action]));
}

function atLeastAsGenerous(action: Outcome, other: Outcome): boolean {
  return leastGenerous(action, other) === other;
}

function blockedEntries(entries: FeedbackEntry[]): FeedbackEntry[] {
  return entries.filter((entry) => entry.verdict?.route === 'block');
}

/**
 * Replays one stored answer through today's real validateDecision, so a rulebook version can be scored without calling a
 * model. Pure: no network, no clock. The result stays bound by the same checks and ceiling as a live run (C12, C13).
 *
 * A record with no usable answer comes back unchanged, and so does any record the checks did not accept. Those hold the
 * code's own fallback reason instead of the model's, so replaying that text would pass the checks the real reply failed:
 * on the stored ROBO run, 7 refused wallets would rise from a hold to a partial reward (C11).
 *
 * @throws Error STALE_ROWS when the record's start or ceiling no longer match the row's facts.
 */
export function asRulebookV2(record: DecisionRecord, row: ReplayRow, settings: Settings): DecisionRecord {
  if (record.modelAction === null || !record.accepted) return record;
  const start = computeStart(row.facts, settings);
  const { ceiling } = computeCeiling(row.facts, settings);
  if (start.outcome !== record.start.outcome || start.rule !== record.start.rule || ceiling !== record.ceiling) {
    throw new Error(STALE_ROWS);
  }
  const { decision, accepted, cause } = validateDecision(
    {
      action: record.modelAction,
      shareBps: shareFor(record.modelAction, settings),
      rule: record.rule,
      reason: record.reason,
      citedTxs: record.citedTxs,
      paidHops: 0,
    },
    { facts: row.facts, settings, ceiling, start, toolTxs: [], paidHopsMade: 0 },
  );
  return {
    ...record,
    action: decision.action,
    shareBps: decision.shareBps,
    rule: decision.rule,
    reason: decision.reason,
    citedTxs: decision.citedTxs,
    clampedFrom: decision.clampedFrom ?? null,
    accepted,
    cause: cause ?? null,
  };
}

/**
 * Splits appeals by whether a real claimant could have written them. A claimant is on a replay list, and appeal-demo signs
 * with a key made fresh for each proof, so a wallet on no list is a test wallet.
 *
 * @param listed Every wallet on the replay lists, in any letter case.
 */
export function splitAppeals(appeals: AppealRecord[], listed: Iterable<string>): { claimant: AppealRecord[]; testWallet: AppealRecord[] } {
  const known = new Set([...listed].map(lower));
  return {
    claimant: appeals.filter((appeal) => known.has(lower(appeal.wallet))),
    testWallet: appeals.filter((appeal) => !known.has(lower(appeal.wallet))),
  };
}

export function heldShare(records: DecisionRecord[]): HeldShare {
  const held = heldCount(records);
  return { held, wallets: records.length, rate: ratio(held, records.length) ?? 0 };
}

/**
 * Scores one version's decisions. Pure: no network, no clock.
 *
 * catchRate counts Bitquery key wallets in the rows, and an undecided key wallet is not held. falseHold is every Hop record
 * passed, with its 95% Wilson interval, so pass only the probably-real sample. A blocked entry is right when the version's
 * action for that wallet in that entry's set differs from the blocked action. A reversed appeal is right when the version's
 * action is at least as generous as the owner's new action, and a wallet in both sets must meet it in both. A wallet with
 * no decision is never right, so a gap cannot raise the feedback number.
 *
 * @throws RangeError when two ROBO rows or records name the same wallet.
 * @throws Error STALE_DECISION when a ROBO record's start or ceiling differs from its row's.
 */
export function scoreVersion(
  name: string,
  roboRecords: DecisionRecord[],
  roboRows: ReplayRow[],
  key: Map<string, FarmKeyEntry>,
  hopRecords: DecisionRecord[],
  feedback: VersionFeedback,
): VersionScore {
  const keyWallets = new Set([...key.keys()].map(lower));
  const wallets = roboRows.filter((row) => keyWallets.has(lower(row.wallet))).length;
  const held = scoreDecisions(roboRecords, roboRows, key, new Map()).finalHeld.key;

  const hop = heldShare(hopRecords);
  const interval = wilson(hop.held, hop.wallets);

  const actions = { robo: actionsByWallet(roboRecords), hop: actionsByWallet([...hopRecords, ...feedback.hopEliminated]) };
  const blocked = blockedEntries(feedback.entries);
  const blocksAvoided = blocked.filter((entry) => {
    const action = actions[entry.set].get(lower(entry.wallet));
    return action !== undefined && action !== entry.action;
  }).length;

  const reversed = feedback.appeals.filter((appeal) => appeal.status === 'reversed');
  const reversalsMet = reversed.filter((appeal) => {
    const { newAction } = appeal;
    if (newAction === null) return false;
    const stored = [actions.robo, actions.hop].flatMap((inSet) => inSet.get(lower(appeal.wallet)) ?? []);
    return stored.length > 0 && stored.every((action) => atLeastAsGenerous(action, newAction));
  }).length;

  return {
    name,
    catchRate: { held, wallets, rate: ratio(held, wallets) ?? 0 },
    falseHold: { ...hop, low: interval?.low ?? 0, high: interval?.high ?? 0 },
    feedback: { right: blocksAvoided + reversalsMet, total: blocked.length + reversed.length },
  };
}

/**
 * Lines up v1 and v2 over the same rows, answer key and feedback. Pure: no network, no clock.
 *
 * @param data.entries Every stored Reppo entry.
 * @param data.appeals Every appeal, latest state only.
 * @param data.listed Every wallet on the replay lists, which is how a test wallet's appeal is kept out of the feedback number.
 */
export function compareVersions(
  v1: VersionRecords,
  v2: VersionRecords,
  data: { roboRows: ReplayRow[]; key: Map<string, FarmKeyEntry>; entries: FeedbackEntry[]; appeals: AppealRecord[]; listed: Iterable<string> },
): VersionComparison {
  const { claimant, testWallet } = splitAppeals(data.appeals, data.listed);
  const score = (name: string, records: VersionRecords) =>
    scoreVersion(name, records.robo, data.roboRows, data.key, records.hopSample, {
      entries: data.entries,
      appeals: claimant,
      hopEliminated: records.hopEliminated,
    });

  const v2Actions = { robo: actionsByWallet(v2.robo), hop: actionsByWallet([...v2.hopSample, ...v2.hopEliminated]) };
  const isTestWallet = new Set(testWallet);
  const routes = { ship: 0, review: 0, block: 0, unread: 0 };
  for (const entry of data.entries) routes[entry.verdict?.route ?? 'unread'] += 1;

  return {
    v1: score('v1', v1),
    v2: score('v2', v2),
    eliminatedHeld: { v1: heldShare(v1.hopEliminated), v2: heldShare(v2.hopEliminated) },
    verdicts: blockedEntries(data.entries).map((entry) => ({
      group: entry.group,
      storedAction: entry.action,
      score: entry.verdict?.score ?? null,
      route: entry.verdict?.route ?? null,
      confidence: entry.verdict?.confidence ?? null,
      v2Action: v2Actions[entry.set].get(lower(entry.wallet)) ?? null,
    })),
    routes,
    appeals: data.appeals.map((appeal) => ({
      campaignId: appeal.campaignId,
      status: appeal.status,
      appealedAction: appeal.appealedAction,
      newAction: appeal.newAction,
      testWallet: isTestWallet.has(appeal),
    })),
    testWalletAppeals: testWallet.length,
  };
}

// The Hop rates sit near 1%, where percent's one decimal would blur the change this table exists to show.
function preciseShare(share: HeldShare): string {
  return `${(share.rate * 100).toFixed(2)}% (${count(share.held)} of ${count(share.wallets)})`;
}

function catchLine(score: VersionScore): string {
  const { held, wallets, rate } = score.catchRate;
  return `${percent(rate)} (${count(held)} of ${count(wallets)})`;
}

function falseHoldLine(score: VersionScore): string {
  const { falseHold } = score;
  return `${preciseShare(falseHold)}, 95% interval ${(falseHold.low * 100).toFixed(2)}% to ${(falseHold.high * 100).toFixed(2)}%`;
}

function feedbackLine(score: VersionScore): string {
  return `${count(score.feedback.right)} of ${count(score.feedback.total)}`;
}

function verdictLine(line: VerdictLine): string {
  const heard = `score ${line.score ?? 'unread'}, route ${line.route ?? 'unread'}, confidence ${line.confidence ?? 'unread'}`;
  return `- ${line.group}: stored ${line.storedAction}, ${heard}, v2 now ${line.v2Action ?? 'undecided'}`;
}

function appealLine(line: AppealLine): string {
  const moved = line.newAction === null ? line.appealedAction : `${line.appealedAction} to ${line.newAction}`;
  return `- ${line.campaignId}: ${line.status}, ${moved}${line.testWallet ? ', test wallet' : ''}`;
}

/**
 * The comparison as short plain-English markdown. It opens by saying no model ran and closes with what it does not cover.
 * It prints counts, groups and fixed words only, never a wallet, because a wallet here would link it to a verdict (C35).
 */
export function versionsToMarkdown(comparison: VersionComparison, meta: { runDate: string }): string {
  const { v1, v2, eliminatedHeld, verdicts, routes, appeals, testWalletAppeals } = comparison;
  return [
    '# Rulebook v1 and v2, side by side',
    '',
    'Both columns come from stored runs. No model was called and nothing was sent.',
    "v1 is the decisions as stored. v2 is the same stored answers put through today's checks.",
    '',
    `Run date: ${meta.runDate}`,
    '',
    '| Measure | v1 | v2 |',
    '| --- | --- | --- |',
    `| ROBO catch rate: Bitquery key wallets held or excluded | ${catchLine(v1)} | ${catchLine(v2)} |`,
    `| Hop false-hold rate: probably-real sample held or excluded | ${falseHoldLine(v1)} | ${falseHoldLine(v2)} |`,
    `| Feedback set right | ${feedbackLine(v1)} | ${feedbackLine(v2)} |`,
    `| Hop's eliminated A8/A9 sample held: not a recall claim, the cost of the change | ${preciseShare(eliminatedHeld.v1)} | ${preciseShare(eliminatedHeld.v2)} |`,
    '',
    '## Reppo verdicts in the feedback set',
    '',
    ...(verdicts.length === 0 ? ['- none'] : verdicts.map(verdictLine)),
    '',
    '## All Reppo verdicts by route',
    '',
    `Ship: ${count(routes.ship)}`,
    `Review: ${count(routes.review)}`,
    `Block: ${count(routes.block)}`,
    `Paid but out of shape: ${count(routes.unread)}`,
    '',
    '## Appeals',
    '',
    ...(appeals.length === 0 ? ['- none'] : appeals.map(appealLine)),
    `Appeals by a test wallet, left out of the feedback number because no real claimant wrote them: ${count(testWalletAppeals)}`,
    '',
    '## Not covered',
    '',
    '- v2 replays the answers v1 got. No model read the new rulebook, so a fresh run could answer differently.',
    "- Reppo judged v1's decisions in the old wording. No verdict here is on a v2 decision or on the new wording.",
    '- Right on a blocked entry means v2 no longer makes the decision Reppo blocked, not that Reppo would pass what v2 does instead.',
    "- Hop's probably-real wallets are not proved real, and the rate comes from a sample.",
    '- A wallet the checks refused or the code replaced in the stored run keeps that outcome, because its own reply is not replayed.',
    '',
  ].join('\n');
}

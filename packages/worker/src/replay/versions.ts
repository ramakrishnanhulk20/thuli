import {
  count,
  leastGenerous,
  percent,
  ratio,
  type AppealRecord,
  type FarmKeyEntry,
  type Outcome,
  type ReplayRow,
  type ReppoVerdict,
  type RulebookVersion,
  type Settings,
} from '@thuli/core';
import type { FeedbackEntry } from '../reppo/feedback.ts';
import { hasReplyToRecheck, recheckStoredReply, STALE_ROWS, type DecisionRecord } from './decide.ts';
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
  /** This version's decisions on Hop's eliminated sample. An appeal may name one, and it is no part of the false-hold rate. */
  hopEliminated: DecisionRecord[];
  /** This version's action on each reply Reppo judged, keyed by judgedKey. Blocked entries are marked from this alone. */
  judged: Map<string, Outcome>;
}

export interface VersionRecords {
  robo: DecisionRecord[];
  hopSample: DecisionRecord[];
  hopEliminated: DecisionRecord[];
}

/** How many records in each set had no model reply to check again, so both columns keep them as stored. */
export type NoReplyCounts = Record<keyof VersionRecords, number>;

export const JUDGED_SOURCES = ['hop-sample', 'hop-eliminated', 'robo'] as const;

/** One line of data/feedback/judged.jsonl: the exact record Reppo judged and the row it was decided on. */
export interface JudgedReply {
  key: string;
  source: (typeof JUDGED_SOURCES)[number];
  record: DecisionRecord;
  row: ReplayRow;
}

/** One Reppo verdict in the feedback set. No wallet, because this goes into a report and the wallet would link it to a verdict. */
export interface VerdictLine {
  group: string;
  storedAction: Outcome;
  score: number | null;
  route: ReppoVerdict['route'] | null;
  confidence: ReppoVerdict['confidence'] | null;
  /** Null when there is no judged reply for this wallet. */
  v1Action: Outcome | null;
  /** Null when there is no judged reply for this wallet. */
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
  noReply: NoReplyCounts;
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
 * One stored record under one rulebook version: its own stored model reply checked again on today's row with that
 * version's checks (recheckStoredReply), so both versions are scored on the same reply and no model is called. Pure: no
 * network, no clock. The result stays bound by the same checks and ceiling as a live run (C12, C13).
 *
 * A record with no model reply to check (no usable answer, or reply text empty or cut at the storage cap) comes back
 * unchanged under both versions, so it stays held (C11).
 *
 * @throws Error STALE_ROWS when the record's start or ceiling no longer match the row's facts.
 * @throws RangeError when the row is another wallet's.
 */
export function asRulebook(record: DecisionRecord, row: ReplayRow, settings: Settings, rulebook: RulebookVersion): DecisionRecord {
  return recheckStoredReply(record, row, settings, rulebook) ?? record;
}

/**
 * Both columns of the scorecard for every stored set, and how many records in each had no reply to check again.
 *
 * @throws Error STALE_ROWS when a record has no row, or its start or ceiling no longer match its row's facts.
 */
export function versionColumns(
  stored: VersionRecords,
  rows: { robo: Map<string, ReplayRow>; hop: Map<string, ReplayRow> },
  settings: Settings,
): { v1: VersionRecords; v2: VersionRecords; noReply: NoReplyCounts } {
  const column = (rulebook: RulebookVersion, records: DecisionRecord[], byWallet: Map<string, ReplayRow>) =>
    records.map((record) => {
      const row = byWallet.get(record.wallet);
      if (row === undefined) throw new Error(STALE_ROWS);
      return asRulebook(record, row, settings, rulebook);
    });
  const columnOf = (rulebook: RulebookVersion): VersionRecords => ({
    robo: column(rulebook, stored.robo, rows.robo),
    hopSample: column(rulebook, stored.hopSample, rows.hop),
    hopEliminated: column(rulebook, stored.hopEliminated, rows.hop),
  });
  const unchecked = (records: DecisionRecord[]) => records.filter((record) => !hasReplyToRecheck(record)).length;
  return {
    v1: columnOf(1),
    v2: columnOf(2),
    noReply: { robo: unchecked(stored.robo), hopSample: unchecked(stored.hopSample), hopEliminated: unchecked(stored.hopEliminated) },
  };
}

/** The key a Reppo entry and a judged reply share: the entry's set and the wallet. */
export function judgedKey(set: FeedbackEntry['set'], wallet: string): string {
  return `${set}:${lower(wallet)}`;
}

/**
 * One version's action on every reply Reppo judged, each checked on the row it was decided on, never on a fresh answer.
 *
 * @throws RangeError when a line's key is not its record's wallet, or two lines name the same wallet in one set.
 * @throws Error STALE_ROWS when a judged record no longer fits its own row.
 */
export function judgedActions(judged: JudgedReply[], settings: Settings, rulebook: RulebookVersion): Map<string, Outcome> {
  const actions = new Map<string, Outcome>();
  for (const line of judged) {
    if (lower(line.key) !== lower(line.record.wallet)) throw new RangeError('a judged line names a different wallet from its record');
    const key = judgedKey(line.source === 'robo' ? 'robo' : 'hop', line.key);
    if (actions.has(key)) throw new RangeError('two judged lines name the same wallet in one set');
    actions.set(key, asRulebook(line.record, line.row, settings, rulebook).action);
  }
  return actions;
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
 * action on the reply Reppo judged (feedback.judged) differs from the blocked action, so a later answer for the same
 * wallet never marks it. A reversed appeal is right when the version's action is at least as generous as the owner's new
 * action, and a wallet in both sets must meet it in both. A wallet with no decision is never right, so a gap cannot raise
 * the feedback number.
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
    const action = feedback.judged.get(judgedKey(entry.set, entry.wallet));
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
 * @param data.judged Each version's actions on the replies Reppo judged (judgedActions).
 * @param data.noReply How many stored records per set had no reply to check again (versionColumns).
 */
export function compareVersions(
  v1: VersionRecords,
  v2: VersionRecords,
  data: {
    roboRows: ReplayRow[];
    key: Map<string, FarmKeyEntry>;
    entries: FeedbackEntry[];
    appeals: AppealRecord[];
    listed: Iterable<string>;
    judged: { v1: Map<string, Outcome>; v2: Map<string, Outcome> };
    noReply: NoReplyCounts;
  },
): VersionComparison {
  const { claimant, testWallet } = splitAppeals(data.appeals, data.listed);
  const score = (name: string, records: VersionRecords, judged: Map<string, Outcome>) =>
    scoreVersion(name, records.robo, data.roboRows, data.key, records.hopSample, {
      entries: data.entries,
      appeals: claimant,
      hopEliminated: records.hopEliminated,
      judged,
    });

  const isTestWallet = new Set(testWallet);
  const routes = { ship: 0, review: 0, block: 0, unread: 0 };
  for (const entry of data.entries) routes[entry.verdict?.route ?? 'unread'] += 1;

  return {
    v1: score('v1', v1, data.judged.v1),
    v2: score('v2', v2, data.judged.v2),
    eliminatedHeld: { v1: heldShare(v1.hopEliminated), v2: heldShare(v2.hopEliminated) },
    verdicts: blockedEntries(data.entries).map((entry) => ({
      group: entry.group,
      storedAction: entry.action,
      score: entry.verdict?.score ?? null,
      route: entry.verdict?.route ?? null,
      confidence: entry.verdict?.confidence ?? null,
      v1Action: data.judged.v1.get(judgedKey(entry.set, entry.wallet)) ?? null,
      v2Action: data.judged.v2.get(judgedKey(entry.set, entry.wallet)) ?? null,
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
    noReply: { ...data.noReply },
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
  return `- ${line.group}: stored ${line.storedAction}, ${heard}, v1 now ${line.v1Action ?? 'undecided'}, v2 now ${line.v2Action ?? 'undecided'}`;
}

function appealLine(line: AppealLine): string {
  const moved = line.newAction === null ? line.appealedAction : `${line.appealedAction} to ${line.newAction}`;
  return `- ${line.campaignId}: ${line.status}, ${moved}${line.testWallet ? ', test wallet' : ''}`;
}

/**
 * The comparison as short plain-English markdown. It opens by saying no model ran and closes with what it does not cover.
 * It prints counts, groups and fixed words only, never a wallet, because a wallet here would link it to a verdict (C35).
 *
 * @param meta.hopAskedOn The day the Hop sample answers were last written, as YYYY-MM-DD.
 */
export function versionsToMarkdown(comparison: VersionComparison, meta: { runDate: string; hopAskedOn: string }): string {
  const { v1, v2, eliminatedHeld, verdicts, routes, appeals, testWalletAppeals, noReply } = comparison;
  return [
    '# Rulebook v1 and v2, side by side',
    '',
    'Both columns come from the same stored model replies. No model was called and nothing was sent.',
    "v1 applies the checks without the rule rulebook v2 added (a shared funder alone cannot hold a wallet). v2 applies today's checks.",
    'The feedback line is scored on the replies Reppo judged.',
    `Records with no model reply to check again, kept as stored in both columns: ROBO ${count(noReply.robo)}, Hop sample ${count(noReply.hopSample)}, Hop eliminated ${count(noReply.hopEliminated)}.`,
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
    '- Each wallet has one stored reply and both columns check that one reply, so neither shows how a model would answer under a different rulebook text.',
    '- Reppo judged decisions made before the shared-funder rule. No verdict here is on a v2 decision.',
    '- Right on a blocked entry means that version no longer makes the decision Reppo blocked, not that Reppo would pass what it does instead.',
    "- Hop's probably-real wallets are not proved real, and the rate comes from a sample.",
    '- A record with no model reply to check again keeps its stored hold in both columns.',
    `- The Hop answers were asked again on ${meta.hopAskedOn} for wallets whose facts changed after the 10 Nov fixes, and the eliminated sample was drawn again from that day's rows.`,
    '',
  ].join('\n');
}

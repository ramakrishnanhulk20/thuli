import { setTimeout as wait } from 'node:timers/promises';
import { openCampaigns, type Campaign } from '@thuli/store';
import { appealNext, NO_REPPO_KEY, type AppealOutcome, type AppealReppo, type AppealSpend } from './appeals.ts';
import { publishCheck, reconcileCheck, type PublishOutcome, type ReconcileOutcome } from './publish.ts';
import { activateCheck, relayNext, type ActivateOutcome, type RelayOutcome } from './relay.ts';
import { screenNextAsk, type ScreenDeps, type ScreenOutcome } from './screen.ts';
import { campaignMemory, NO_VAULT_BLOCK, safeCause, waitNoted, type ChainDeps } from './vault.ts';

/** The pause between two runs of the loop. */
export const LOOP_INTERVAL_MS = 5_000;

/**
 * The longest the loop waits for one step (C41). Each is above the limits inside the step: a screening stops itself at
 * 120 seconds, a post and a claim each wait at most 180 seconds for a receipt, every RPC call times out at 30, and an
 * appeal's look-up waits at most APPEAL_REPPO_WAIT_MS, 150 seconds, inside its 300 second lease.
 */
export const STEP_TIMEOUTS_MS = Object.freeze({
  screen: 180_000,
  campaigns: 30_000,
  reconcile: 120_000,
  activate: 120_000,
  publish: 300_000,
  relay: 300_000,
  appeal: 240_000,
});

export { NO_VAULT_BLOCK };

export type StepName = keyof typeof STEP_TIMEOUTS_MS;

export type StepFailure = { kind: 'failed'; cause: string } | { kind: 'timed-out'; afterMs: number } | { kind: 'not-run' };

export interface WorkerDeps extends ScreenDeps, ChainDeps {
  /** Shorter limits, for tests. Left out, every step has its STEP_TIMEOUTS_MS. */
  timeouts?: Partial<Record<StepName, number>>;
  /** Reppo for the appeal step and the credits it has spent. Left out, as with no REPPO_API_KEY, the step is skipped. */
  appeals?: { reppo: AppealReppo; spend: AppealSpend };
}

/** What the chain steps did for one open campaign. Steps after a failed or skipped reconcile are not-run. */
export interface CampaignReport {
  campaignId: string;
  reconcile: ReconcileOutcome | StepFailure;
  activate: ActivateOutcome | StepFailure;
  publish: PublishOutcome | StepFailure;
}

/** What each step of one run did. A step after a stop request is not-run. */
export interface RunReport {
  screen: ScreenOutcome | StepFailure;
  campaigns: CampaignReport[] | StepFailure;
  relay: RelayOutcome | StepFailure;
  appeal: AppealOutcome | StepFailure;
}

const NOT_RUN: StepFailure = { kind: 'not-run' };

// A function rather than an inline test, because the signal can change while a step is awaited.
const stopped = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;
const TIMED_OUT = Symbol('timed out');

/**
 * Runs one step, waiting at most its limit. A step that throws or runs out of time is reported, never thrown, so one
 * failing step cannot stop the others. At the limit the step's signal is aborted and the step stops at its next check,
 * before any further store write, signature or send (C41); what it held stays leased until its lease runs out.
 */
async function bounded<T>(
  deps: WorkerDeps,
  name: StepName,
  label: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T | StepFailure> {
  const limit = deps.timeouts?.[name] ?? STEP_TIMEOUTS_MS[name];
  // Aborted at the limit, so the step itself stops: every step checks it before each store write, signature and send.
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeUp = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      stop.abort();
      resolve(TIMED_OUT);
    }, limit);
  });
  try {
    const result = await Promise.race([work(stop.signal), timeUp]);
    if (result !== TIMED_OUT) {
      if (deps.memory.failing.delete(label)) deps.log(`${label}: working again`);
      return result;
    }
    noteFailure(deps, label, `stopped waiting after ${limit / 1000} s; whatever it held is tried again when its lease runs out`);
    return { kind: 'timed-out', afterMs: limit };
  } catch (error) {
    const cause = safeCause(error);
    noteFailure(deps, label, `failed, ${cause}`);
    return { kind: 'failed', cause };
  } finally {
    clearTimeout(timer);
  }
}

// A step that fails the same way on every run is logged once, then again only when its cause changes or clears.
function noteFailure(deps: WorkerDeps, label: string, line: string): void {
  if (deps.memory.failing.get(label) === line) return;
  deps.memory.failing.set(label, line);
  deps.log(`${label}: ${line}`);
}

// A reason to wait is logged when it changes, so a quiet campaign does not write the same line every five seconds. Each
// campaign keeps its own reasons, so one campaign's line never hides another's.
function noteWaiting(deps: WorkerDeps, campaignId: string, label: string, outcome: { kind: string; reason?: string }): void {
  const reason = outcome.kind === 'skipped' ? outcome.reason : undefined;
  if (!waitNoted(campaignMemory(deps.memory, campaignId).waiting, label, reason)) return;
  deps.log(`${label === '' ? campaignId : `${label} ${campaignId}`}: waiting, ${reason}`);
}

/** Reconcile, activate and publish for one campaign. A reconcile that did not finish stops the other two, fail closed. */
async function campaignSteps(deps: WorkerDeps, campaign: Campaign): Promise<CampaignReport> {
  const id = campaign.id;
  if (campaign.vaultBlock === null) {
    const skipped = { kind: 'skipped' as const, reason: NO_VAULT_BLOCK };
    noteWaiting(deps, id, '', skipped);
    return { campaignId: id, reconcile: skipped, activate: NOT_RUN, publish: NOT_RUN };
  }
  noteWaiting(deps, id, '', { kind: 'ready' });
  const report: CampaignReport = { campaignId: id, reconcile: NOT_RUN, activate: NOT_RUN, publish: NOT_RUN };
  report.reconcile = await bounded(deps, 'reconcile', `reconcile ${id}`, (signal) => reconcileCheck(deps, id, signal));
  noteWaiting(deps, id, 'reconcile', report.reconcile);
  if (report.reconcile.kind !== 'reconciled') return report;
  report.activate = await bounded(deps, 'activate', `activate ${id}`, (signal) => activateCheck(deps, id, signal));
  noteWaiting(deps, id, 'activate', report.activate);
  report.publish = await bounded(deps, 'publish', `publish ${id}`, (signal) => publishCheck(deps, id, signal));
  noteWaiting(deps, id, 'publish', report.publish);
  return report;
}

// Without Reppo the step is skipped and said once, so appeals stay queued until a key is set and the worker restarts.
async function appealStep(deps: WorkerDeps): Promise<AppealOutcome | StepFailure> {
  const appeals = deps.appeals;
  if (appeals === undefined) {
    if (waitNoted(deps.memory.waiting, 'appeal', NO_REPPO_KEY)) deps.log(`appeal: waiting, ${NO_REPPO_KEY}`);
    return { kind: 'skipped', reason: NO_REPPO_KEY };
  }
  return bounded(deps, 'appeal', 'appeal', (signal) => appealNext({ ...deps, ...appeals }, signal));
}

/**
 * One run of the campaign worker: at most one screening; then, for every campaign openCampaigns returns, at most 100 in
 * id order, a reconcile, an activate check and a publish check; then at most one relay; then at most one appeal's
 * outside check, skipped when no Reppo key is set. Every step is held to its
 * STEP_TIMEOUTS_MS, so a run is bounded per campaign and by the store's cap on open campaigns (C41), and one campaign's
 * failure is reported for it and never stops the next. Reconcile comes first, so a list a stopped worker posted but never
 * recorded is recorded before anything is built on it; activating comes before publishing, so a list whose delay just
 * ended is marked active before the next one is posted over it. When `signal` is aborted, the step under way finishes
 * and the rest are not run.
 *
 * The worker is meant to run as one process. A redeploy can overlap the old and the new process for a few seconds, and
 * the host may stop a process between any two lines, so this holds without a lock: an ask and a relay are each leased
 * by one statement, so each is taken by one worker at a time; a claim sent twice pays once, because every amount is
 * cumulative and the vault answers NothingToClaim to the second; and two posts of the same root can only restart that
 * root's delay. Not a goal: two workers running side by side for long. Nothing would pay twice, but each would spend
 * reads, SERV calls and gas the other had already spent.
 */
export async function runOnce(deps: WorkerDeps, signal?: AbortSignal): Promise<RunReport> {
  const report: RunReport = { screen: NOT_RUN, campaigns: NOT_RUN, relay: NOT_RUN, appeal: NOT_RUN };
  report.screen = await bounded(deps, 'screen', 'screen', (signal) => screenNextAsk(deps, signal));
  if (stopped(signal)) return report;
  const open = await bounded(deps, 'campaigns', 'campaigns', () => openCampaigns(deps.db, deps.now()));
  if (Array.isArray(open)) {
    const reports: CampaignReport[] = [];
    report.campaigns = reports;
    for (const campaign of open) {
      if (stopped(signal)) return report;
      reports.push(await campaignSteps(deps, campaign));
    }
  } else {
    report.campaigns = open;
  }
  if (stopped(signal)) return report;
  report.relay = await bounded(deps, 'relay', 'relay', (signal) => relayNext(deps, signal));
  if (stopped(signal)) return report;
  report.appeal = await appealStep(deps);
  return report;
}

/**
 * Runs runOnce every LOOP_INTERVAL_MS until `signal` is aborted, or once when `once` is set. An abort during a step lets
 * that step finish; an abort during the pause ends the loop at once.
 *
 * @returns how many runs were made.
 */
export async function runLoop(deps: WorkerDeps, options: { once: boolean; signal: AbortSignal; intervalMs?: number }): Promise<number> {
  let runs = 0;
  for (;;) {
    await runOnce(deps, options.signal);
    runs += 1;
    if (options.once || options.signal.aborted) return runs;
    try {
      await wait(options.intervalMs ?? LOOP_INTERVAL_MS, undefined, { signal: options.signal });
    } catch {
      return runs;
    }
  }
}

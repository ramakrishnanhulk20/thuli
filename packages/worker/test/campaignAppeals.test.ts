// Not covered here: live Reppo, a real Postgres, the API route that files an appeal and the site. Reppo is a stand-in
// that answers the way the real client does, verdicts going through core's own parseVerdict; the store is PGlite in this
// process. The Reppo client's HTTP rules are reppoClient.test.ts; the store's appeal rules are the store's own tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  appealTextHash,
  CURRENT_RULEBOOK,
  parseAddress,
  parseVerdict,
  reppoInput,
  toGraphRecord,
  type Facts,
  type GraphRecord,
  type Outcome,
  type ReppoVerdict,
} from '@thuli/core';
import {
  addAppeal,
  addAsk,
  createCampaign,
  decideAsk,
  getAsk,
  markAppealSubmitting,
  migrate,
  openMemoryDb,
  ownerAppeals,
  slotHolders,
  takeAppeal,
  takeAsk,
  type CampaignInput,
  type Db,
  type TakenAppeal,
} from '@thuli/store';
import {
  APPEAL_CAUSES,
  APPEAL_LEASE_SECONDS,
  APPEAL_MAX_ATTEMPTS,
  appealListLines,
  appealNext,
  NO_REPPO_KEY,
  noteFrom,
  outsideInput,
  parseSettleArgs,
  routeFrom,
  settleAppealCommand,
  AppealExportLine,
  EXPORT_SUMMARY,
  exportAppeals,
  type AppealDeps,
  type AppealReppo,
} from '../src/campaign/appeals.ts';
import { askFactsOf } from '../src/campaign/facts.ts';
import { runOnce, type WorkerDeps } from '../src/campaign/loop.ts';
import { LONGEST_RETRY_SECONDS, retryDelaySeconds } from '../src/campaign/screen.ts';
import { emptyChainMemory, type CampaignVault } from '../src/campaign/vault.ts';
import { ReppoError, ReppoOutOfCredit, type ReppoEval } from '../src/reppo/client.ts';
import { identifyingPart } from '../src/reppo/feedback.ts';

// Not starting with "appeal", so the loop's own lines for the campaign are never taken for the appeal step's.
const CAMPAIGN = 'held-campaign';
const NOW = new Date('2026-11-11T12:00:00.000Z');
const SIGNATURE = `0x${'ab'.repeat(65)}`;
const TEXT = 'My wallet is mine alone; please look again. MARKER-7731';
const API_KEY = 'reppo-key-not-real-0123456789';

let db: Db;
let clock: Date;
let lines: string[];

const later = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

function terms(overrides: Partial<CampaignInput> = {}): CampaignInput {
  return {
    id: CAMPAIGN,
    name: 'Appeals',
    chain: 84532,
    vault: parseAddress(`0x${'a1'.repeat(20)}`),
    token: parseAddress(`0x${'70'.repeat(20)}`),
    owner: parseAddress(`0x${'0e'.repeat(20)}`),
    agent: parseAddress(`0x${'ad'.repeat(20)}`),
    rewardPerWallet: '1000000',
    perWalletCap: '1000000',
    partialShareBps: 5000,
    maxSlots: 3,
    rulebook: CURRENT_RULEBOOK,
    settings: { groupMinSize: 2, funderFanoutMin: 2 },
    status: 'open',
    opensAt: new Date(NOW.getTime() - 3_600_000),
    closesAt: new Date(NOW.getTime() + 86_400_000),
    createdAt: NOW,
    // No vault block, so a run of the loop leaves the chain alone and only the appeal step does anything.
    vaultBlock: null,
    ...overrides,
  };
}

// A wallet held under A4: in a group of two that share a funder.
const HELD_FACTS: Facts = {
  walletAgeDays: 400,
  txCountAtSnapshot: 50,
  accountType: 'eoa',
  firstFunder: { address: parseAddress(`0x${'f1'.repeat(20)}`), kind: 'wallet', fanoutInList: 2, hopsTraced: 1 },
  group: { size: 2, sameFunderWithinWindow: null, sweptToSharedCollector: false, authoredEvidence: false, linkedByWallet: false },
  sharedDepositAddress: null,
  fundingBurst: null,
  claimPaidToOtherAddress: false,
  evidenceTxs: [`0x${'cd'.repeat(32)}`],
  missing: [],
};

const SHARES: Record<Outcome, number> = { full: 10_000, partial: 5_000, hold: 0, exclude: 0 };

interface Decided {
  wallet: `0x${string}`;
  record: Record<string, unknown> | null;
}

/** One ask decided by hand, as the screening would store it, with the record it rested on unless told otherwise. */
async function decided(
  action: Outcome = 'hold',
  options: { rule?: string; reason?: string; record?: Record<string, unknown> | null } = {},
): Promise<Decided> {
  const wallet = privateKeyToAccount(generatePrivateKey()).address;
  const rule = options.rule ?? 'A4';
  await addAsk(db, { campaignId: CAMPAIGN, wallet, signedAt: Math.floor(clock.getTime() / 1000), signature: SIGNATURE }, clock);
  expect(await takeAsk(db, clock, 300, 10)).toMatchObject({ wallet });
  const record =
    options.record === undefined ? (toGraphRecord(HELD_FACTS, { outcome: action, rule: rule as 'A4' }) as Record<string, unknown>) : options.record;
  const placed = await decideAsk(
    db,
    {
      campaignId: CAMPAIGN,
      wallet,
      action,
      shareBps: SHARES[action],
      rule,
      reason: options.reason ?? 'In a group of 2 linked wallets that share a first funder, so a person should look.',
      citedTxs: [],
      notChecked: [],
      facts: askFactsOf(HELD_FACTS),
      servRequestId: 'run-1',
      ...(record === null ? {} : { record }),
    },
    clock,
  );
  expect(placed).not.toBeNull();
  later(1);
  return { wallet, record };
}

async function appealed(wallet: string, text = TEXT) {
  expect(
    await addAppeal(
      db,
      { campaignId: CAMPAIGN, wallet, text, textHash: appealTextHash(text), signedAt: Math.floor(clock.getTime() / 1000), signature: SIGNATURE },
      clock,
    ),
  ).toBe('queued');
  later(1);
}

const verdictOf = (route: unknown, reason = 'The hold follows the stated facts and the fairness rules.') =>
  parseVerdict({ score: 78, decision: 'accept', confidence: 'high', route, reason });

const completed = (route: unknown = 'ship', reason?: string, creditsCharged = 440): Omit<ReppoEval, 'id'> => ({
  status: 'COMPLETED',
  creditsCharged,
  verdict: verdictOf(route, reason),
});

/** Reppo as the step sees it, counting every POST, every accepted submission and every look-up. */
class StandInReppo implements AppealReppo {
  /** Every POST that reached Reppo, refused or not: the number that could ever have been paid for. */
  posts = 0;
  readonly submitted: string[] = [];
  readonly lookedUp: string[] = [];
  /** What each look-up answers, oldest first; when empty, a completed ship. */
  readonly answers: (Omit<ReppoEval, 'id'> | Error)[] = [];
  /** How the next POSTs fail, oldest first, before submitFails. */
  readonly submitAnswers: Error[] = [];
  submitFails: Error | null = null;
  /** When set, a POST's answer waits for it, as a slow network does. */
  answerGate: Promise<void> | null = null;
  onSubmit: () => void = () => undefined;
  onLookUp: () => void = () => undefined;

  async submit(input: string, signal?: AbortSignal): Promise<string> {
    // As the real single-try submit: nothing is sent once the signal is aborted, and the outcome is then unknown.
    if (signal?.aborted === true) throw new ReppoError('the Reppo submit was cut short, so it may have been charged', null);
    this.posts += 1;
    if (this.answerGate !== null) await this.answerGate;
    const failure = this.submitAnswers.shift() ?? this.submitFails;
    if (failure !== null) throw failure;
    this.submitted.push(input);
    this.onSubmit();
    return `eval_${this.submitted.length}`;
  }

  async lookUp(id: string): Promise<ReppoEval> {
    this.lookedUp.push(id);
    this.onLookUp();
    const next = this.answers.shift() ?? completed();
    if (next instanceof Error) throw next;
    return { ...next, id };
  }
}

function appealDeps(reppo: StandInReppo): AppealDeps {
  return { db, now: () => clock, log: (line) => lines.push(line), memory: emptyChainMemory(), reppo, spend: { credits: 0 } };
}

const appealRow = async (wallet: string) => (await ownerAppeals(db, CAMPAIGN)).find((one) => one.wallet === parseAddress(wallet));

const retryAt = async (wallet: string) =>
  (await db.query<{ retry_at: unknown }>('SELECT retry_at FROM appeals WHERE wallet = $1', [parseAddress(wallet)]))[0]?.retry_at;

beforeEach(async () => {
  db = await openMemoryDb();
  await migrate(db);
  clock = NOW;
  lines = [];
  await createCampaign(db, terms());
});

afterEach(async () => {
  await db.close();
});

describe('the outside check of an appeal', () => {
  it.each(['ship', 'review', 'block'] as const)('records Reppo\'s %s route, its note, the evaluation id and the credits, and leaves the ask alone (C11, C23)', async (route) => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    reppo.answers.push(completed(route));
    const before = await getAsk(db, CAMPAIGN, wallet);

    expect(await appealNext(appealDeps(reppo))).toMatchObject({ kind: 'checked', route, evalId: 'eval_1', creditsCharged: 440 });
    expect(reppo.submitted).toHaveLength(1);
    expect(await appealRow(wallet)).toMatchObject({
      checkStatus: 'checked',
      reppoRoute: route,
      reppoNote: 'The hold follows the stated facts and the fairness rules.',
      reppoEvalId: 'eval_1',
      creditsCharged: 440,
      reppoScore: 78,
      reppoDecision: 'accept',
      reppoConfidence: 'high',
      outcome: 'open',
    });
    expect(await getAsk(db, CAMPAIGN, wallet)).toMatchObject({ action: before?.action, rule: before?.rule, slot: null });
    expect(lines).toContain(`appeal ${CAMPAIGN} ${wallet}: checked, route ${route}, evaluation eval_1, 440 credits, 440 credits since start`);
  });

  it('sends Thuli\'s decision built by the offline builder, never the appellant\'s text, which the step never receives (C35)', async () => {
    const { wallet, record } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    await appealNext(appealDeps(reppo));
    const ask = await getAsk(db, CAMPAIGN, wallet);
    expect(reppo.submitted).toEqual([reppoInput(record as GraphRecord, 'hold', ask?.reason as string)]);
    expect(reppo.submitted[0]).not.toContain('MARKER-7731');
    expect(lines.join('\n')).not.toContain('MARKER-7731');
    expectTypeOf<TakenAppeal>().not.toHaveProperty('text');
    expectTypeOf<Parameters<typeof outsideInput>[0]>().not.toHaveProperty('text');
  });

  it('refuses to send a record with an address in it, or a text that still holds a time, and ends the check unchecked (C35)', async () => {
    const withAddress = await decided('hold', {
      record: { ...(toGraphRecord(HELD_FACTS, { outcome: 'hold', rule: 'A4' }) as Record<string, unknown>), funder: `0x${'f1'.repeat(20)}` },
    });
    const withTime = await decided('hold', { reason: 'Held since unix 1794418491 when the group was found.' });
    await appealed(withAddress.wallet);
    await appealed(withTime.wallet);
    const reppo = new StandInReppo();
    const deps = appealDeps(reppo);
    expect(await appealNext(deps)).toMatchObject({ kind: 'unchecked', cause: APPEAL_CAUSES.unreadable });
    expect(await appealNext(deps)).toMatchObject({ kind: 'unchecked', cause: APPEAL_CAUSES.identifying });
    expect(reppo.submitted).toEqual([]);
    for (const { wallet } of [withAddress, withTime]) expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'unchecked', reppoEvalId: null });
  });

  it('ends the check unchecked when the decision kept no record, sending nothing', async () => {
    const { wallet } = await decided('hold', { record: null });
    await appealed(wallet);
    const reppo = new StandInReppo();
    expect(await appealNext(appealDeps(reppo))).toMatchObject({ kind: 'unchecked', cause: APPEAL_CAUSES.noRecord });
    expect(reppo.submitted).toEqual([]);
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'unchecked' });
    expect(lines).toEqual([`appeal ${CAMPAIGN} ${wallet}: unchecked, ${APPEAL_CAUSES.noRecord}`]);
  });

  it('keeps the evaluation id when a try is cut after the submit, and the next try only looks it up (C23)', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    reppo.answers.push(new ReppoError('the Reppo call did not finish', null));
    const deps = appealDeps(reppo);
    expect(await appealNext(deps)).toMatchObject({ kind: 'released', status: 'queued' });
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'queued', reppoEvalId: 'eval_1', attempts: 1 });

    later(retryDelaySeconds(1));
    expect(await appealNext(deps)).toMatchObject({ kind: 'checked', evalId: 'eval_1' });
    expect(reppo.submitted).toHaveLength(1);
    expect(reppo.lookedUp).toEqual(['eval_1', 'eval_1']);
  });

  it('gives an unfinished evaluation back with the usual wait and records it from the next try\'s look-up', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    reppo.answers.push({ status: 'UNFINISHED', creditsCharged: 0, verdict: null }, completed('review'));
    const deps = appealDeps(reppo);
    expect(await appealNext(deps)).toMatchObject({ kind: 'released', cause: APPEAL_CAUSES.unfinished, status: 'queued' });
    expect(await appealNext(deps)).toEqual({ kind: 'idle' });
    later(retryDelaySeconds(1));
    expect(await appealNext(deps)).toMatchObject({ kind: 'checked', route: 'review' });
    expect(reppo.submitted).toHaveLength(1);
  });

  it('gives a failed evaluation back with the usual wait, keeping its id, and never submits the decision again (C23)', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    reppo.answers.push({ status: 'FAILED', creditsCharged: 0, verdict: null }, completed('ship'));
    const deps = appealDeps(reppo);
    expect(await appealNext(deps)).toMatchObject({ kind: 'released', cause: APPEAL_CAUSES.failed, status: 'queued' });
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'queued', reppoEvalId: 'eval_1', reppoRoute: null });
    later(retryDelaySeconds(1));
    expect(await appealNext(deps)).toMatchObject({ kind: 'checked', evalId: 'eval_1' });
    expect(reppo.submitted).toHaveLength(1);
  });

  it('hands the try back when Reppo is out of credit, waits the longest wait, and says so once (C24)', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    reppo.submitFails = new ReppoOutOfCredit('Reppo answered 402, so the credit balance has run out');
    const deps = appealDeps(reppo);
    for (let run = 0; run < 3; run += 1) {
      expect(await appealNext(deps)).toMatchObject({ kind: 'released', cause: APPEAL_CAUSES.outOfCredit, status: 'queued' });
      expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'queued', attempts: 0 });
      expect(new Date(String(await retryAt(wallet))).getTime()).toBe(clock.getTime() + LONGEST_RETRY_SECONDS * 1000);
      expect(await appealNext(deps)).toEqual({ kind: 'idle' });
      later(LONGEST_RETRY_SECONDS);
    }
    expect(lines.filter((line) => line.includes(APPEAL_CAUSES.outOfCredit))).toEqual([`appeal: waiting, ${APPEAL_CAUSES.outOfCredit}`]);
  });

  it('maps every route Reppo can send, and ends a paid check naming an unknown one as checked with no route, never handed out again (C23)', async () => {
    expect(['ship', 'review', 'block', 'SHIP', 'escalate', '', null, undefined, 3].map(routeFrom)).toEqual([
      'ship',
      'review',
      'block',
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    reppo.answers.push(completed('escalate'));
    const deps = appealDeps(reppo);
    expect(await appealNext(deps)).toMatchObject({ kind: 'checked', route: null, evalId: 'eval_1', creditsCharged: 440 });
    expect(await appealRow(wallet)).toMatchObject({
      checkStatus: 'checked',
      reppoRoute: null,
      reppoEvalId: 'eval_1',
      creditsCharged: 440,
      reppoScore: null,
      reppoDecision: null,
      reppoConfidence: null,
    });
    later(LONGEST_RETRY_SECONDS);
    expect(await appealNext(deps)).toEqual({ kind: 'idle' });
    expect(reppo.submitted).toHaveLength(1);
    expect(reppo.lookedUp).toHaveLength(1);
  });

  it('stores no score Reppo gave out of range, and still records the check with the rest of the verdict', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    const outOfRange = { score: 140, decision: 'accept', confidence: 'high', route: 'ship', reason: 'The hold is fair.' } as unknown as ReppoVerdict;
    reppo.answers.push({ status: 'COMPLETED', creditsCharged: 440, verdict: outOfRange });
    expect(await appealNext(appealDeps(reppo))).toMatchObject({ kind: 'checked', route: 'ship' });
    expect(await appealRow(wallet)).toMatchObject({
      checkStatus: 'checked',
      reppoRoute: 'ship',
      reppoScore: null,
      reppoDecision: 'accept',
      reppoConfidence: 'high',
      reppoNote: 'The hold is fair.',
      creditsCharged: 440,
    });
  });

  it('stores no note that holds a link, and cuts a long note to 280 plain characters (C13, C34)', async () => {
    expect(noteFrom('Fair hold. See https://reppo.example/x for the panel.')).toBeNull();
    expect(noteFrom(null)).toBeNull();
    expect(noteFrom(`${'a'.repeat(300)}`)).toBe('a'.repeat(280));
    const linked = await decided();
    const long = await decided();
    await appealed(linked.wallet);
    await appealed(long.wallet);
    const reppo = new StandInReppo();
    reppo.answers.push(completed('ship', 'Looks right, details at www.example.com/panel'), completed('ship', `${'Plain words. '.repeat(30)}`));
    const deps = appealDeps(reppo);
    await appealNext(deps);
    await appealNext(deps);
    expect(await appealRow(linked.wallet)).toMatchObject({ checkStatus: 'checked', reppoNote: null });
    const kept = (await appealRow(long.wallet))?.reppoNote ?? '';
    expect(kept.length).toBeLessThanOrEqual(280);
    expect(kept.startsWith('Plain words.')).toBe(true);
  });

  it(`ends an appeal unchecked after ${6} failed tries, each given back with the usual wait (C41)`, async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    // Look-ups fail, not the submit: an ambiguous submit ends an appeal at its next take, which the paying-once tests cover.
    for (let n = 0; n < APPEAL_MAX_ATTEMPTS; n += 1) reppo.answers.push(new ReppoError('Reppo answered with status 500', 500));
    const deps = appealDeps(reppo);
    const statuses: (string | null)[] = [];
    for (let attempt = 1; attempt <= APPEAL_MAX_ATTEMPTS; attempt += 1) {
      const outcome = await appealNext(deps);
      statuses.push(outcome.kind === 'released' ? outcome.status : outcome.kind);
      later(retryDelaySeconds(attempt));
    }
    expect(APPEAL_MAX_ATTEMPTS).toBe(6);
    expect(statuses).toEqual(['queued', 'queued', 'queued', 'queued', 'queued', 'unchecked']);
    expect(await appealNext(deps)).toEqual({ kind: 'idle' });
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'unchecked', attempts: 6 });
    expect(reppo.posts).toBe(1);
  });

  it('stops at its limit before any write, but always keeps an evaluation id it was given (C23, C41)', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    const stop = new AbortController();
    reppo.onSubmit = () => stop.abort();
    await expect(appealNext(appealDeps(reppo), stop.signal)).rejects.toThrow('ran past its time limit');
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'checking', reppoEvalId: 'eval_1', reppoRoute: null });
    expect(reppo.lookedUp).toEqual([]);

    const other = await decided();
    await appealed(other.wallet);
    await expect(appealNext(appealDeps(reppo), stop.signal)).rejects.toThrow('ran past its time limit');
    expect(await appealRow(other.wallet)).toMatchObject({ checkStatus: 'queued', attempts: 0 });
  });

  it('holds nothing that identifies a wallet, an amount or a time in the text it sends', () => {
    const plain = reppoInput(toGraphRecord(HELD_FACTS, { outcome: 'hold', rule: 'A4' }), 'hold', 'In a group of 2 linked wallets.');
    expect(identifyingPart(plain)).toBeNull();
    for (const bad of [
      `paid to 0x${'ab'.repeat(20)}`,
      `tx ${'cd'.repeat(32)}`,
      'it received 1 USDC',
      'it received $5',
      'it was funded with 2.5 eth',
      'decided on 2026-11-11',
      'decided on Nov 11, 2026',
      'decided at 12:30',
      'claimable from 1794418491',
      'paid 1,000,000 base units',
    ]) {
      expect(identifyingPart(bad), bad).not.toBeNull();
    }
  });
});

describe('paying the outside check at most once (C23)', () => {
  const MAYBE_PAID = 'the outside check may already have been paid for';
  const key = (wallet: string) => ({ campaignId: CAMPAIGN, wallet });

  // A Db that runs `hook` around one kind of statement, so a test can fail it, cut after it or hold it.
  function hooked(match: RegExp, hook: (run: () => Promise<unknown>) => Promise<unknown>): Db {
    const wrap = (query: Db['query']): Db['query'] =>
      (async (text: string, params?: readonly unknown[]) => (match.test(text) ? hook(() => query(text, params)) : query(text, params))) as Db['query'];
    return { query: wrap(db.query.bind(db)), transaction: (work) => db.transaction((tx) => work({ query: wrap(tx.query.bind(tx)) })), close: () => db.close() };
  }

  async function until(done: () => boolean): Promise<void> {
    for (let wait = 0; wait < 400 && !done(); wait += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    if (!done()) throw new Error('the awaited moment never came');
  }

  /** Ten more runs of the step, each past every lease and wait, as a worker left running would make. */
  async function tenMoreRuns(deps: AppealDeps): Promise<void> {
    for (let run = 0; run < 10; run += 1) {
      later(LONGEST_RETRY_SECONDS + 1);
      await appealNext(deps);
    }
  }

  it('pays once when the write keeping the evaluation id fails, ends the appeal unchecked, and logs the id for a look-up by hand (cut A)', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    let failNext = true;
    const flaky = hooked(/SET reppo_eval_id = \$3/, async (run) => {
      if (!failNext) return run();
      failNext = false;
      throw new Error('connection reset');
    });
    const deps = { ...appealDeps(reppo), db: flaky };
    await appealNext(deps);
    expect(lines.some((line) => line.includes('eval_1') && line.includes('by hand'))).toBe(true);
    later(APPEAL_LEASE_SECONDS + 1);
    expect(await appealNext(deps)).toMatchObject({ kind: 'unchecked', cause: MAYBE_PAID });
    await tenMoreRuns(deps);
    expect(reppo.posts).toBe(1);
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'unchecked', checkNote: MAYBE_PAID, reppoEvalId: null });
  });

  it('pays once when the process stops after the submit returns, before the id is kept (cut B)', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    expect(await takeAppeal(db, clock, APPEAL_LEASE_SECONDS, APPEAL_MAX_ATTEMPTS)).toMatchObject({ submitStarted: false });
    expect(await markAppealSubmitting(db, key(wallet), clock)).toBe(true);
    await reppo.submit('the decision, sent by the worker that then stopped');
    later(APPEAL_LEASE_SECONDS + 1);
    const deps = appealDeps(reppo);
    expect(await appealNext(deps)).toMatchObject({ kind: 'unchecked', cause: MAYBE_PAID });
    await tenMoreRuns(deps);
    expect(reppo.posts).toBe(1);
    expect(lines.filter((line) => line.includes(MAYBE_PAID))).toHaveLength(1);
  });

  it('never pays twice for a cut after the mark and before the POST: the appeal ends unchecked', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    const stop = new AbortController();
    const cutting = hooked(/SET submit_started_at = \$3/, async (run) => {
      const marked = await run();
      stop.abort();
      return marked;
    });
    await expect(appealNext({ ...appealDeps(reppo), db: cutting }, stop.signal)).rejects.toThrow('ran past its time limit');
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'checking', reppoEvalId: null });
    later(APPEAL_LEASE_SECONDS + 1);
    const deps = appealDeps(reppo);
    expect(await appealNext(deps)).toMatchObject({ kind: 'unchecked', cause: MAYBE_PAID });
    await tenMoreRuns(deps);
    expect(reppo.posts).toBeLessThanOrEqual(1);
  });

  it('pays once with two workers on one appeal after a lease ran out, whichever of them stalls', async () => {
    // A stalls with its POST out; B takes the appeal once the lease has run out.
    const first = await decided();
    await appealed(first.wallet);
    const slowA = new StandInReppo();
    let answer: () => void = () => undefined;
    slowA.answerGate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const a = appealNext(appealDeps(slowA));
    await until(() => slowA.posts === 1);
    later(APPEAL_LEASE_SECONDS + 1);
    const b = new StandInReppo();
    expect(await appealNext(appealDeps(b))).toMatchObject({ kind: 'unchecked', cause: MAYBE_PAID });
    answer();
    await a;
    expect(slowA.posts + b.posts).toBe(1);

    // A stalls after its take and before its mark; B takes, marks and sends first.
    const second = await decided();
    await appealed(second.wallet);
    let reachedMark = false;
    let markGo: () => void = () => undefined;
    const markGate = new Promise<void>((resolve) => {
      markGo = resolve;
    });
    const stalled = hooked(/SET submit_started_at = \$3/, async (run) => {
      reachedMark = true;
      await markGate;
      return run();
    });
    const lateA = new StandInReppo();
    const a2 = appealNext({ ...appealDeps(lateA), db: stalled });
    await until(() => reachedMark);
    later(APPEAL_LEASE_SECONDS + 1);
    const b2 = new StandInReppo();
    expect(await appealNext(appealDeps(b2))).toMatchObject({ kind: 'checked' });
    markGo();
    expect(await a2).toMatchObject({ kind: 'dropped' });
    expect(lateA.posts + b2.posts).toBe(1);
  });

  it('clears the mark on a 402 and on a 400, so a later run submits once', async () => {
    const credit = await decided();
    const badRequest = await decided();
    await appealed(credit.wallet);
    await appealed(badRequest.wallet);
    const reppo = new StandInReppo();
    reppo.submitAnswers.push(new ReppoOutOfCredit('Reppo answered 402, so the credit balance has run out'), new ReppoError('Reppo answered with status 400', 400));
    const deps = appealDeps(reppo);
    expect(await appealNext(deps)).toMatchObject({ kind: 'released', cause: APPEAL_CAUSES.outOfCredit, status: 'queued' });
    expect(await appealRow(credit.wallet)).toMatchObject({ checkStatus: 'queued', attempts: 0, submitStartedAt: null });
    expect(await appealNext(deps)).toMatchObject({ kind: 'released', status: 'queued' });
    expect(await appealRow(badRequest.wallet)).toMatchObject({ checkStatus: 'queued', attempts: 1, submitStartedAt: null });
    later(LONGEST_RETRY_SECONDS);
    expect(await appealNext(deps)).toMatchObject({ kind: 'checked', wallet: credit.wallet });
    expect(await appealNext(deps)).toMatchObject({ kind: 'checked', wallet: badRequest.wallet });
    expect(reppo.posts).toBe(4);
    expect(reppo.submitted).toHaveLength(2);
  });

  it('keeps the mark after a timeout, a 5xx or a 409, and never sends a second POST for any of them', async () => {
    const wallets = [await decided(), await decided(), await decided()];
    for (const { wallet } of wallets) await appealed(wallet);
    const reppo = new StandInReppo();
    reppo.submitAnswers.push(
      new ReppoError('the Reppo submit got no answer it could read, so it may have been charged', null),
      new ReppoError('Reppo answered with status 503', 503),
      new ReppoError('Reppo answered with status 409', 409),
    );
    const deps = appealDeps(reppo);
    for (const { wallet } of wallets) {
      expect(await appealNext(deps)).toMatchObject({ kind: 'released', wallet, status: 'queued' });
      expect((await appealRow(wallet))?.submitStartedAt).not.toBeNull();
    }
    await tenMoreRuns(deps);
    expect(reppo.posts).toBe(3);
    for (const { wallet } of wallets) expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'unchecked', checkNote: MAYBE_PAID });
  });
});

describe('the appeal step in the loop', () => {
  const chainless = {} as CampaignVault;

  function workerDeps(appeals?: WorkerDeps['appeals']): WorkerDeps {
    return {
      db,
      facts: async () => {
        throw new Error('no facts are read in these runs');
      },
      accountState: async () => ({ nonce: 1, code: '0x' }),
      serv: { viaGraph: async () => Promise.reject(new Error('no SERV')), viaV2: async () => Promise.reject(new Error('no SERV')), sleep: async () => undefined },
      chain: chainless,
      factory: parseAddress(`0x${'fa'.repeat(20)}`),
      now: () => clock,
      log: (line) => lines.push(line),
      memory: emptyChainMemory(),
      ...(appeals === undefined ? {} : { appeals }),
    };
  }

  it('skips the step with one logged reason when no REPPO_API_KEY is set, leaving every appeal queued', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const worker = workerDeps();
    for (let run = 0; run < 3; run += 1) {
      expect((await runOnce(worker)).appeal).toEqual({ kind: 'skipped', reason: NO_REPPO_KEY });
    }
    expect(lines.filter((line) => line.startsWith('appeal'))).toEqual([`appeal: waiting, ${NO_REPPO_KEY}`]);
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'queued', attempts: 0 });
  });

  it('runs the appeal step after the relay step, and logs no appeal text, key or note (C40)', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    reppo.answers.push(completed('block', 'A secret-looking note that must stay out of logs.'));
    const report = await runOnce(workerDeps({ reppo, spend: { credits: 0 } }));
    expect(report.relay).toEqual({ kind: 'idle' });
    expect(report.appeal).toMatchObject({ kind: 'checked', route: 'block' });
    const log = lines.join('\n');
    for (const secret of ['MARKER-7731', API_KEY, 'secret-looking note']) expect(log).not.toContain(secret);
  });
});

describe('the operator\'s appeal commands', () => {
  it('checks the settle flags before anything is read', () => {
    const wallet = `0x${'c7'.repeat(20)}`;
    const base = { id: CAMPAIGN, wallet };
    expect(parseSettleArgs({ ...base, outcome: 'reversed', action: 'full', note: 'Owner checked the funder by hand.' })).toEqual({
      ok: true,
      value: { campaignId: CAMPAIGN, wallet: parseAddress(wallet), outcome: 'reversed', newAction: 'full', ownerNote: 'Owner checked the funder by hand.' },
    });
    expect(parseSettleArgs({ ...base, outcome: 'upheld' })).toMatchObject({ ok: true, value: { outcome: 'upheld', newAction: null, ownerNote: null } });
    for (const [raw, cause] of [
      [{ wallet, outcome: 'upheld' }, '--id'],
      [{ ...base, wallet: '0x1234', outcome: 'upheld' }, '--wallet'],
      [{ ...base }, '--outcome'],
      [{ ...base, outcome: 'granted' }, '--outcome'],
      [{ ...base, outcome: 'reversed' }, '--action'],
      [{ ...base, outcome: 'reversed', action: 'hold' }, '--action'],
      [{ ...base, outcome: 'upheld', action: 'full' }, '--action'],
      [{ ...base, outcome: 'upheld', note: 'see https://example.com' }, '--note'],
      [{ ...base, outcome: 'upheld', note: 'x'.repeat(1001) }, '--note'],
    ] as const) {
      const parsed = parseSettleArgs(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.cause).toContain(cause);
    }
  });

  it('settles only with --write, passes the store\'s refusal on, and a reversal takes a slot the list then carries (C11, C44)', async () => {
    const partial = await decided('partial', { rule: 'A8', reason: 'Newer than the project minimum, so at most partial.' });
    const { wallet } = await decided('hold');
    await appealed(partial.wallet);
    await appealed(wallet);
    const tooSmall = parseSettleArgs({ id: CAMPAIGN, wallet: partial.wallet, outcome: 'reversed', action: 'partial' });
    const reversal = parseSettleArgs({ id: CAMPAIGN, wallet, outcome: 'reversed', action: 'full' });
    if (!tooSmall.ok || !reversal.ok) throw new Error('the flags were refused');

    expect(await settleAppealCommand(db, tooSmall.value, true, clock)).toEqual({
      ok: false,
      lines: [expect.stringContaining(`appeal ${CAMPAIGN} ${parseAddress(partial.wallet)}`), 'refused: the new action must be more generous than the appealed one'],
    });
    const dry = await settleAppealCommand(db, reversal.value, false, clock);
    expect(dry.ok).toBe(true);
    expect(dry.lines.at(-1)).toBe('it would be settled as reversed to full, holding slot 2; add --write to do it');
    expect(await appealRow(wallet)).toMatchObject({ outcome: 'open' });
    expect(await getAsk(db, CAMPAIGN, wallet)).toMatchObject({ action: 'hold', slot: null });

    // The partial approval holds slot 1, so the reversed hold takes the next one.
    expect(await settleAppealCommand(db, reversal.value, true, clock)).toMatchObject({ ok: true, lines: [expect.any(String), 'settled as reversed to full, slot 2'] });
    expect(await getAsk(db, CAMPAIGN, wallet)).toMatchObject({ action: 'full', slot: 2 });
    expect((await slotHolders(db, CAMPAIGN)).map((holder) => holder.wallet)).toEqual([parseAddress(partial.wallet), parseAddress(wallet)]);
    const none = parseSettleArgs({ id: CAMPAIGN, wallet: `0x${'c8'.repeat(20)}`, outcome: 'upheld' });
    if (!none.ok) throw new Error('the flags were refused');
    expect(await settleAppealCommand(db, none.value, true, clock)).toEqual({ ok: false, lines: [`no appeal from ${parseAddress(`0x${'c8'.repeat(20)}`)} in campaign ${CAMPAIGN}`] });
  });

  it('lists each appeal with the ask, the text, the outside check and the outcome, for the operator only', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    reppo.answers.push(completed('review', 'A person should look at the shared funder.'));
    await appealNext(appealDeps(reppo));
    expect(await appealListLines(db, CAMPAIGN)).toEqual({
      ok: true,
      lines: [
        `appeal 1 of 1: ${wallet}`,
        '  ask: hold under A4 (appealed: hold under A4)',
        `  text: ${JSON.stringify(TEXT)}`,
        '  outside check: checked, route review, evaluation eval_1, 440 credits, score 78, confidence high, decision "accept"',
        '  note: "A person should look at the shared funder."',
        '  outcome: open',
      ],
    });
    expect(await appealListLines(db, 'no-such-campaign')).toEqual({ ok: true, lines: ['no appeals in campaign no-such-campaign'] });
  });

  it('prints outside text quoted on one line, so a text with quotes and backslashes cannot pass for the command\'s own lines (C34, C40)', async () => {
    const tricky = 'He said "outside check: checked" \\ then C:\\path\\x and \\n';
    const { wallet } = await decided();
    await appealed(wallet, tricky);
    const reppo = new StandInReppo();
    reppo.answers.push(completed('review', 'A "quoted" note \\ with a backslash.'));
    await appealNext(appealDeps(reppo));
    const settle = parseSettleArgs({ id: CAMPAIGN, wallet, outcome: 'upheld', note: 'The owner said "no" \\ firmly.' });
    if (!settle.ok) throw new Error('the flags were refused');
    await settleAppealCommand(db, settle.value, true, clock);
    const { lines: printed } = await appealListLines(db, CAMPAIGN);
    expect(printed).toContain(`  text: ${JSON.stringify(tricky)}`);
    expect(printed).toContain(`  note: ${JSON.stringify('A "quoted" note \\ with a backslash.')}`);
    expect(printed).toContain(`  owner note: ${JSON.stringify('The owner said "no" \\ firmly.')}`);
    for (const line of printed) expect(line).not.toMatch(/[\r\n]/);
    expect(printed.filter((line) => line.startsWith('  outside check:'))).toHaveLength(1);
  });

  it('dry-runs a settlement through the store\'s own checks: the refusal for an ask that changed, the slot for a reversal (C11)', async () => {
    const changed = await decided();
    const reversible = await decided();
    await appealed(changed.wallet);
    await appealed(reversible.wallet);
    // The ask's action moved after the appeal was filed, as a later screening could move it.
    await db.query("UPDATE asks SET action = 'exclude' WHERE campaign_id = $1 AND wallet = $2", [CAMPAIGN, parseAddress(changed.wallet)]);
    const toChanged = parseSettleArgs({ id: CAMPAIGN, wallet: changed.wallet, outcome: 'reversed', action: 'full' });
    const toReversible = parseSettleArgs({ id: CAMPAIGN, wallet: reversible.wallet, outcome: 'reversed', action: 'partial' });
    if (!toChanged.ok || !toReversible.ok) throw new Error('the flags were refused');

    const refusedDry = await settleAppealCommand(db, toChanged.value, false, clock);
    expect(refusedDry).toMatchObject({ ok: false });
    expect(refusedDry.lines.at(-1)).toBe('it would be refused: the ask changed after the appeal was filed');
    expect(await settleAppealCommand(db, toChanged.value, true, clock)).toMatchObject({
      ok: false,
      lines: [expect.any(String), 'refused: the ask changed after the appeal was filed'],
    });
    const slotDry = await settleAppealCommand(db, toReversible.value, false, clock);
    expect(slotDry.lines.at(-1)).toBe('it would be settled as reversed to partial, holding slot 1; add --write to do it');
    expect(await settleAppealCommand(db, toReversible.value, true, clock)).toMatchObject({ ok: true, lines: [expect.any(String), 'settled as reversed to partial, slot 1'] });
  });
});

describe('the appeal export', () => {
  let dir: string;
  let file: string;
  const OWNER_NOTE = 'Owner checked the funder by hand. OWNER-NOTE-4410';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuli-appeal-export-'));
    file = path.join(dir, 'feedback', 'campaign-appeals.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const fileLines = () => fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');

  /** One checked appeal, settled reversed with an owner's note, beside one still queued that the export must leave out. */
  async function checkedAndQueued() {
    const checked = await decided();
    const queued = await decided();
    await appealed(checked.wallet);
    const reppo = new StandInReppo();
    reppo.answers.push(completed('review', 'A person should look at the shared funder.'));
    expect(await appealNext(appealDeps(reppo))).toMatchObject({ kind: 'checked' });
    await appealed(queued.wallet);
    const settle = parseSettleArgs({ id: CAMPAIGN, wallet: checked.wallet, outcome: 'reversed', action: 'full', note: OWNER_NOTE });
    if (!settle.ok) throw new Error('the flags were refused');
    expect(await settleAppealCommand(db, settle.value, true, clock)).toMatchObject({ ok: true });
    return { checked, queued };
  }

  it('writes one line per checked appeal in its own strict shape, with the decision as it was appealed and the record the check used', async () => {
    const { checked } = await checkedAndQueued();
    const ask = await getAsk(db, CAMPAIGN, checked.wallet);
    const result = await exportAppeals(db, CAMPAIGN, file, true);
    expect(result.ok).toBe(true);
    expect(result.lines).toContain(EXPORT_SUMMARY);
    expect(EXPORT_SUMMARY).toBe('exported as input for the next rulebook change; the scorecard does not score appeals yet');
    const lines = fileLines();
    expect(lines).toHaveLength(1);
    const line = AppealExportLine.parse(JSON.parse(lines[0] as string));
    expect(line).toEqual({
      campaignId: CAMPAIGN,
      wallet: parseAddress(checked.wallet),
      appealedAction: 'hold',
      appealedRule: 'A4',
      reason: ask?.reason,
      record: checked.record,
      route: 'review',
      score: 78,
      decision: 'accept',
      confidence: 'high',
      note: 'A person should look at the shared funder.',
      evalId: 'eval_1',
      creditsCharged: 440,
      checkedAt: (await appealRow(checked.wallet))?.checkedAt?.toISOString(),
      outcome: 'reversed',
      newAction: 'full',
    });
  });

  it('skips an evaluation id already in the file, and a dry run writes nothing', async () => {
    await checkedAndQueued();
    const dry = await exportAppeals(db, CAMPAIGN, file, false);
    expect(dry.ok).toBe(true);
    expect(dry.lines).toContain('1 line would be added; add --write to write it');
    expect(fs.existsSync(file)).toBe(false);

    expect((await exportAppeals(db, CAMPAIGN, file, true)).lines).toContain(`1 line added to ${file}`);
    const again = await exportAppeals(db, CAMPAIGN, file, true);
    expect(again.lines).toContain('1 checked appeal, 1 already in the file, 0 to add');
    expect(fileLines()).toHaveLength(1);
  });

  it('refuses to write into a file holding any line that is not an exported appeal', async () => {
    await checkedAndQueued();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"key":"other","value":{"text":"a line of another shape"}}\n');
    expect(await exportAppeals(db, CAMPAIGN, file, true)).toMatchObject({ ok: false });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"key":"other","value":{"text":"a line of another shape"}}\n');
  });

  it('holds no appeal text, text hash, signature or owner note in any line (C34, C40)', async () => {
    await checkedAndQueued();
    const result = await exportAppeals(db, CAMPAIGN, file, true);
    const written = fs.readFileSync(file, 'utf8');
    for (const secret of ['MARKER-7731', TEXT, appealTextHash(TEXT), SIGNATURE.slice(2), 'OWNER-NOTE-4410']) {
      expect(written).not.toContain(secret);
      expect(result.lines.join('\n')).not.toContain(secret);
    }
  });
});

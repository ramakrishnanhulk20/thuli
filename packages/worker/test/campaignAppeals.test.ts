// Not covered here: live Reppo, a real Postgres, the API route that files an appeal and the site. Reppo is a stand-in
// that answers the way the real client does, verdicts going through core's own parseVerdict; the store is PGlite in this
// process. The Reppo client's HTTP rules are reppoClient.test.ts; the store's appeal rules are the store's own tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
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
  APPEAL_MAYBE_PAID,
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
  APPEAL_BUSY_WAIT_SECONDS,
  APPEAL_CAUSES,
  APPEAL_LEASE_SECONDS,
  APPEAL_LOOKUP_WAIT_SECONDS,
  APPEAL_MAX_ATTEMPTS,
  APPEAL_SERVICE_WAIT_SECONDS,
  appealListLines,
  appealNext,
  MAX_UNCLEAR_SUBMITS,
  NO_REPPO_KEY,
  noteFrom,
  outsideInput,
  parseSettleArgs,
  quoted,
  reppoForAppeals,
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
import {
  ReppoError,
  ReppoNotSent,
  ReppoOutOfCredit,
  ReppoRefused,
  ReppoStoppedFirst,
  SUBMIT_OUTCOME_UNKNOWN,
  type ReppoEval,
} from '../src/reppo/client.ts';
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
    // As the real single-try submit: nothing is sent once the signal is aborted, or for an input refused before the call.
    if (signal?.aborted === true) throw new ReppoStoppedFirst('the Reppo submit was not sent, because the step was told to stop first', null);
    const failure = this.submitAnswers.shift() ?? this.submitFails;
    if (failure instanceof ReppoNotSent) throw failure;
    this.posts += 1;
    if (this.answerGate !== null) await this.answerGate;
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

function appealDeps(reppo: AppealReppo): AppealDeps {
  return { db, now: () => clock, log: (line) => lines.push(line), memory: emptyChainMemory(), reppo, spend: { credits: 0 } };
}

/**
 * The step's real Reppo client, reppoForAppeals, over a stubbed fetch that answers every call with `answer`, so a test
 * sees what the step does with the client's own errors. No request leaves the machine.
 */
function realReppo(answer: () => Response | Error) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
    const next = answer();
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal('fetch', fetchMock);
  const reppo = reppoForAppeals({ baseUrl: 'https://eval.example.org/api/v1', apiKey: API_KEY });
  return { reppo, fetchMock, posts: () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').length };
}

const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

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
  vi.unstubAllGlobals();
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

  it('follows a paid check through seven unfinished look-ups, each 300 s apart with its try handed back, then records it (C56)', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    for (let look = 0; look < 7; look += 1) reppo.answers.push({ status: 'UNFINISHED', creditsCharged: 0, verdict: null });
    reppo.answers.push(completed('review'));
    const deps = appealDeps(reppo);
    for (let look = 0; look < 7; look += 1) {
      expect(await appealNext(deps)).toMatchObject({ kind: 'released', cause: APPEAL_CAUSES.unfinished, status: 'queued' });
      expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'queued', attempts: 0, reppoEvalId: 'eval_1' });
      expect(new Date(String(await retryAt(wallet))).getTime()).toBe(clock.getTime() + APPEAL_LOOKUP_WAIT_SECONDS * 1000);
      expect(await appealNext(deps)).toEqual({ kind: 'idle' });
      later(APPEAL_LOOKUP_WAIT_SECONDS);
    }
    expect(APPEAL_LOOKUP_WAIT_SECONDS).toBe(300);
    expect(await appealNext(deps)).toMatchObject({ kind: 'checked', route: 'review', evalId: 'eval_1' });
    expect(reppo.posts).toBe(1);
    expect(reppo.lookedUp).toHaveLength(8);
  });

  it('ends a check whose evaluation FAILED at once, with the cause "the outside check failed", and looks it up no more', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    reppo.answers.push({ status: 'FAILED', creditsCharged: 0, verdict: null }, completed('ship'));
    const deps = appealDeps(reppo);
    expect(await appealNext(deps)).toMatchObject({ kind: 'unchecked', cause: 'the outside check failed' });
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'unchecked', checkNote: 'the outside check failed', reppoEvalId: 'eval_1' });
    for (let run = 0; run < 3; run += 1) {
      later(LONGEST_RETRY_SECONDS + 1);
      expect(await appealNext(deps)).toEqual({ kind: 'idle' });
    }
    expect(reppo.lookedUp).toHaveLength(1);
    expect(reppo.posts).toBe(1);
  });

  it('adds any credits a FAILED evaluation reports to the spend total and says so, though Reppo says FAILED charges nothing', async () => {
    const charged = await decided();
    const free = await decided();
    await appealed(charged.wallet);
    await appealed(free.wallet);
    const reppo = new StandInReppo();
    reppo.answers.push({ status: 'FAILED', creditsCharged: 12, verdict: null }, { status: 'FAILED', creditsCharged: 0, verdict: null });
    const deps = appealDeps(reppo);
    expect(await appealNext(deps)).toMatchObject({ kind: 'unchecked', cause: APPEAL_CAUSES.evaluationFailed });
    expect(deps.spend.credits).toBe(12);
    expect(lines).toContain(
      `appeal ${CAMPAIGN} ${charged.wallet}: unchecked, ${APPEAL_CAUSES.evaluationFailed}, evaluation eval_1, 12 credits charged though it failed, 12 credits since start`,
    );
    expect(await appealNext(deps)).toMatchObject({ kind: 'unchecked', cause: APPEAL_CAUSES.evaluationFailed });
    expect(deps.spend.credits).toBe(12);
    expect(lines).toContain(`appeal ${CAMPAIGN} ${free.wallet}: unchecked, ${APPEAL_CAUSES.evaluationFailed}, evaluation eval_2`);
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

  it(`ends a check with no evaluation id after ${6} refused tries, and never ends a paid one for its tries (C41, C56)`, async () => {
    // No evaluation was ever created: six definite refusals, each a counted try, end it.
    const refused = await decided();
    await appealed(refused.wallet);
    const refusing = new StandInReppo();
    for (let n = 0; n < APPEAL_MAX_ATTEMPTS; n += 1) refusing.submitAnswers.push(new ReppoRefused('Reppo answered with status 400', 400));
    const refusingDeps = appealDeps(refusing);
    const statuses: (string | null)[] = [];
    for (let attempt = 1; attempt <= APPEAL_MAX_ATTEMPTS; attempt += 1) {
      const outcome = await appealNext(refusingDeps);
      statuses.push(outcome.kind === 'released' ? outcome.status : outcome.kind);
      later(retryDelaySeconds(attempt));
    }
    expect(APPEAL_MAX_ATTEMPTS).toBe(6);
    expect(statuses).toEqual(['queued', 'queued', 'queued', 'queued', 'queued', 'unchecked']);
    expect(await appealRow(refused.wallet)).toMatchObject({ checkStatus: 'unchecked', attempts: 6, submitStartedAt: null });

    // An evaluation was created and stored: failed look-ups past the try limit keep it followed, and it is recorded.
    const paid = await decided();
    await appealed(paid.wallet);
    const following = new StandInReppo();
    for (let n = 0; n < APPEAL_MAX_ATTEMPTS + 2; n += 1) following.answers.push(new ReppoError('Reppo answered with status 500', 500));
    following.answers.push(completed('ship'));
    const followingDeps = appealDeps(following);
    for (let attempt = 1; attempt <= APPEAL_MAX_ATTEMPTS + 2; attempt += 1) {
      expect(await appealNext(followingDeps)).toMatchObject({ kind: 'released', status: 'queued' });
      later(retryDelaySeconds(attempt));
    }
    expect(await appealNext(followingDeps)).toMatchObject({ kind: 'checked', evalId: 'eval_1' });
    expect(following.posts).toBe(1);
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

describe('paying the outside check at most MAX_UNCLEAR_SUBMITS times (C23, C56)', () => {
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

  it('pays at most MAX_UNCLEAR_SUBMITS times when the write keeping the evaluation id fails: with the limit at 1, once, then ends the appeal unchecked and logs the id for a look-up by hand (cut A)', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    let failNext = true;
    const flaky = hooked(/SET reppo_eval_id = \$3/, async (run) => {
      if (!failNext) return run();
      failNext = false;
      throw new Error('connection reset');
    });
    const deps = { ...appealDeps(reppo), db: flaky, maxUnclearSubmits: 1 };
    await appealNext(deps);
    expect(lines.some((line) => line.includes('eval_1') && line.includes('by hand'))).toBe(true);
    later(APPEAL_LEASE_SECONDS + 1);
    expect(await appealNext(deps)).toMatchObject({ kind: 'unchecked', cause: MAYBE_PAID });
    await tenMoreRuns(deps);
    expect(reppo.posts).toBe(1);
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'unchecked', checkNote: MAYBE_PAID, reppoEvalId: null });
  });

  it('pays at most MAX_UNCLEAR_SUBMITS times when the process stops after the submit returns, before the id is kept: with the limit at 1, once (cut B)', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    expect(await takeAppeal(db, clock, APPEAL_LEASE_SECONDS, APPEAL_MAX_ATTEMPTS)).toMatchObject({ submitStarted: false });
    expect(await markAppealSubmitting(db, key(wallet), clock)).toBe(true);
    await reppo.submit('the decision, sent by the worker that then stopped');
    later(APPEAL_LEASE_SECONDS + 1);
    const deps = { ...appealDeps(reppo), maxUnclearSubmits: 1 };
    expect(await appealNext(deps)).toMatchObject({ kind: 'unchecked', cause: MAYBE_PAID });
    await tenMoreRuns(deps);
    expect(reppo.posts).toBe(1);
    expect(lines.filter((line) => line.includes(MAYBE_PAID))).toHaveLength(1);
  });

  it.each([1, 2])('counts each unclear submit and, with the limit at %i, ends the check as maybe paid for after exactly that many POSTs (C56)', async (limit) => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    reppo.submitFails = new ReppoError(SUBMIT_OUTCOME_UNKNOWN, null);
    const deps = { ...appealDeps(reppo), maxUnclearSubmits: limit };
    for (let post = 1; post <= limit; post += 1) {
      expect(await appealNext(deps)).toMatchObject({ kind: 'released', status: 'queued' });
      expect(reppo.posts).toBe(post);
      expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'queued', unclearSubmits: post - 1 });
      expect((await appealRow(wallet))?.submitStartedAt).not.toBeNull();
      later(retryDelaySeconds(post));
    }
    expect(await appealNext(deps)).toMatchObject({ kind: 'unchecked', cause: APPEAL_MAYBE_PAID });
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'unchecked', checkNote: APPEAL_MAYBE_PAID, unclearSubmits: limit, submitStartedAt: null });
    await tenMoreRuns(deps);
    expect(reppo.posts).toBe(limit);
  });

  it('with the limit at 2, submits again after one unclear submit and keeps the id and verdict of the one that answers, the count staying 1 (C56)', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    reppo.submitAnswers.push(new ReppoError(SUBMIT_OUTCOME_UNKNOWN, null));
    reppo.answers.push(completed('review'));
    const deps = { ...appealDeps(reppo), maxUnclearSubmits: 2 };
    expect(await appealNext(deps)).toMatchObject({ kind: 'released', status: 'queued' });
    later(retryDelaySeconds(1));
    expect(await appealNext(deps)).toMatchObject({ kind: 'checked', route: 'review', evalId: 'eval_1' });
    expect(reppo.posts).toBe(2);
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'checked', reppoEvalId: 'eval_1', reppoRoute: 'review', unclearSubmits: 1 });
    later(LONGEST_RETRY_SECONDS);
    expect(await appealNext(deps)).toEqual({ kind: 'idle' });
  });

  it('gives an appeal one more submit after an unclear one by default: MAX_UNCLEAR_SUBMITS is 2 (C56)', () => {
    expect(MAX_UNCLEAR_SUBMITS).toBe(2);
  });

  it('on the default limit, follows one unclear submit with one that answers: two POSTs, the id kept, the verdict recorded, the count 1 (C56)', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    reppo.submitAnswers.push(new ReppoError(SUBMIT_OUTCOME_UNKNOWN, null));
    reppo.answers.push(completed('review'));
    const deps = appealDeps(reppo);
    expect(await appealNext(deps)).toMatchObject({ kind: 'released', status: 'queued' });
    later(retryDelaySeconds(1));
    expect(await appealNext(deps)).toMatchObject({ kind: 'checked', route: 'review', evalId: 'eval_1' });
    expect(reppo.posts).toBe(2);
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'checked', reppoEvalId: 'eval_1', reppoRoute: 'review', reppoScore: 78, unclearSubmits: 1 });
    await tenMoreRuns(deps);
    expect(reppo.posts).toBe(2);
  });

  it('on the default limit, ends the check as maybe paid for after two unclear submits, and never sends a third over ten more runs (C56)', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    reppo.submitFails = new ReppoError(SUBMIT_OUTCOME_UNKNOWN, null);
    const deps = appealDeps(reppo);
    expect(await appealNext(deps)).toMatchObject({ kind: 'released', status: 'queued' });
    later(retryDelaySeconds(1));
    expect(await appealNext(deps)).toMatchObject({ kind: 'released', status: 'queued' });
    expect(reppo.posts).toBe(2);
    later(retryDelaySeconds(2));
    expect(await appealNext(deps)).toMatchObject({ kind: 'unchecked', cause: APPEAL_MAYBE_PAID });
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'unchecked', checkNote: APPEAL_MAYBE_PAID, unclearSubmits: 2, submitStartedAt: null });
    await tenMoreRuns(deps);
    expect(reppo.posts).toBe(2);
  });

  it('on the default limit, counts a submit cut off before its id was kept, sends once more, and keeps and follows the second evaluation (cut B, C56)', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    expect(await takeAppeal(db, clock, APPEAL_LEASE_SECONDS, APPEAL_MAX_ATTEMPTS)).toMatchObject({ submitStarted: false });
    expect(await markAppealSubmitting(db, key(wallet), clock)).toBe(true);
    await reppo.submit('the decision, sent by the worker that then stopped');
    later(APPEAL_LEASE_SECONDS + 1);
    reppo.answers.push({ status: 'UNFINISHED', creditsCharged: 0, verdict: null }, completed('ship'));
    const deps = appealDeps(reppo);
    expect(await appealNext(deps)).toMatchObject({ kind: 'released', cause: APPEAL_CAUSES.unfinished, status: 'queued' });
    expect(reppo.posts).toBe(2);
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'queued', reppoEvalId: 'eval_2', unclearSubmits: 1 });
    later(APPEAL_LOOKUP_WAIT_SECONDS);
    expect(await appealNext(deps)).toMatchObject({ kind: 'checked', route: 'ship', evalId: 'eval_2' });
    expect(reppo.lookedUp).toEqual(['eval_2', 'eval_2']);
    await tenMoreRuns(deps);
    expect(reppo.posts).toBe(2);
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'checked', reppoEvalId: 'eval_2', unclearSubmits: 1 });
  });

  it('ends a check whose count reached the limit with no mark left, as a stop right after the count leaves it, and sends nothing more (fail closed)', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    reppo.submitFails = new ReppoError(SUBMIT_OUTCOME_UNKNOWN, null);
    const deps = { ...appealDeps(reppo), maxUnclearSubmits: 1 };
    expect(await appealNext(deps)).toMatchObject({ kind: 'released', status: 'queued' });
    later(retryDelaySeconds(1));
    const stop = new AbortController();
    const cutting = hooked(/SET unclear_submits = appeals\.unclear_submits \+ 1/, async (run) => {
      const counted = await run();
      stop.abort();
      return counted;
    });
    await expect(appealNext({ ...deps, db: cutting }, stop.signal)).rejects.toThrow('ran past its time limit');
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'checking', unclearSubmits: 1, submitStartedAt: null });
    later(APPEAL_LEASE_SECONDS + 1);
    expect(await appealNext(deps)).toMatchObject({ kind: 'unchecked', cause: APPEAL_MAYBE_PAID });
    expect(reppo.posts).toBe(1);
  });

  it('refuses a limit of unclear submits that is not a whole number from 1, before it takes any appeal', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    for (const limit of [0, 1.5, Number.NaN]) {
      await expect(appealNext({ ...appealDeps(new StandInReppo()), maxUnclearSubmits: limit })).rejects.toThrow(RangeError);
    }
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'queued', attempts: 0 });
  });

  it('leaves no mark and hands the try back when the step is stopped after its mark and before its POST, which sends nothing', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const { reppo, posts } = realReppo(() => reply(201, { id: 'eval_x' }));
    const stop = new AbortController();
    const cutting = hooked(/SET submit_started_at = \$3/, async (run) => {
      const marked = await run();
      stop.abort();
      return marked;
    });
    expect(await appealNext({ ...appealDeps(reppo), db: cutting }, stop.signal)).toMatchObject({
      kind: 'released',
      cause: APPEAL_CAUSES.stopped,
      status: 'queued',
    });
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'queued', attempts: 0, submitStartedAt: null, unclearSubmits: 0, checkNote: null });
    expect(new Date(String(await retryAt(wallet))).getTime()).toBe(clock.getTime() + retryDelaySeconds(1) * 1000);
    expect(posts()).toBe(0);
    later(retryDelaySeconds(1));
    const answering = new StandInReppo();
    expect(await appealNext(appealDeps(answering))).toMatchObject({ kind: 'checked' });
    expect(answering.posts).toBe(1);
    expect(lines.join('\n')).not.toContain(MAYBE_PAID);
  });

  it('ends at once, sending nothing, a check whose input is over the byte limit, with the cause that it could not be sent', async () => {
    const { wallet } = await decided();
    await appealed(wallet);
    const real = realReppo(() => reply(201, { id: 'eval_x' }));
    // The decision's own text, padded past the client's 50,000 byte limit, through the real client's own check.
    const oversized: AppealReppo = { submit: (input, signal) => real.reppo.submit(`${input}${'x'.repeat(50_001)}`, signal), lookUp: real.reppo.lookUp };
    const deps = appealDeps(oversized);
    expect(await appealNext(deps)).toMatchObject({ kind: 'unchecked', cause: APPEAL_CAUSES.unsendable });
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'unchecked', checkNote: APPEAL_CAUSES.unsendable, submitStartedAt: null, unclearSubmits: 0, attempts: 1 });
    await tenMoreRuns(deps);
    expect(real.posts()).toBe(0);
    expect(lines).toEqual([`appeal ${CAMPAIGN} ${wallet}: unchecked, ${APPEAL_CAUSES.unsendable}`]);
  });

  it('pays at most MAX_UNCLEAR_SUBMITS times with two workers on one appeal after a lease ran out, whichever of them stalls: with the limit at 1, once', async () => {
    // A stalls with its POST out; B takes the appeal once the lease has run out, and at a limit of 1 ends it unsent.
    const first = await decided();
    await appealed(first.wallet);
    const slowA = new StandInReppo();
    let answer: () => void = () => undefined;
    slowA.answerGate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const a = appealNext({ ...appealDeps(slowA), maxUnclearSubmits: 1 });
    await until(() => slowA.posts === 1);
    later(APPEAL_LEASE_SECONDS + 1);
    const b = new StandInReppo();
    expect(await appealNext({ ...appealDeps(b), maxUnclearSubmits: 1 })).toMatchObject({ kind: 'unchecked', cause: MAYBE_PAID });
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
    reppo.submitAnswers.push(new ReppoOutOfCredit('Reppo answered 402, so the credit balance has run out'), new ReppoRefused('Reppo answered with status 400', 400));
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

  it('keeps the mark after no answer, a 408, a 500 or a reply out of shape, and with the limit at 1 never sends a second POST for any of them (fail closed)', async () => {
    const wallets = [await decided(), await decided(), await decided(), await decided()];
    for (const { wallet } of wallets) await appealed(wallet);
    const reppo = new StandInReppo();
    reppo.submitAnswers.push(
      new ReppoError(SUBMIT_OUTCOME_UNKNOWN, null),
      new ReppoError('Reppo answered with status 408', 408),
      new ReppoError('Reppo answered with status 500', 500),
      new ReppoError('Reppo gave an evaluation id that is not safe to use, so it may have been charged', null),
    );
    const deps = { ...appealDeps(reppo), maxUnclearSubmits: 1 };
    for (const { wallet } of wallets) {
      expect(await appealNext(deps)).toMatchObject({ kind: 'released', wallet, status: 'queued' });
      expect((await appealRow(wallet))?.submitStartedAt).not.toBeNull();
    }
    await tenMoreRuns(deps);
    expect(reppo.posts).toBe(4);
    for (const { wallet } of wallets) expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'unchecked', checkNote: MAYBE_PAID });
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])(
    'waits out an outside check it cannot reach (%s) for good: the mark cleared, the try handed back, 600 s, twenty in a row, no cause stored',
    async (code) => {
      const { wallet } = await decided();
      await appealed(wallet);
      const cause = Object.assign(new Error(`connect ${code} eval.example.org:443`), { code });
      const { reppo, posts } = realReppo(() => new TypeError('fetch failed', { cause }));
      const deps = appealDeps(reppo);
      for (let run = 1; run <= 20; run += 1) {
        expect(await appealNext(deps)).toMatchObject({ kind: 'released', cause: APPEAL_CAUSES.unreachable, status: 'queued' });
        expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'queued', attempts: 0, submitStartedAt: null, unclearSubmits: 0, checkNote: null });
        expect(new Date(String(await retryAt(wallet))).getTime()).toBe(clock.getTime() + APPEAL_SERVICE_WAIT_SECONDS * 1000);
        later(APPEAL_SERVICE_WAIT_SECONDS);
      }
      expect(APPEAL_SERVICE_WAIT_SECONDS).toBe(600);
      expect(posts()).toBe(20);
      expect(lines).toEqual([`appeal: waiting, ${APPEAL_CAUSES.unreachable}`]);
    },
  );

  it.each([409, 429])('waits out a busy %i from the one POST for good: the mark cleared, 180 s, the try handed back, twenty in a row', async (status) => {
    const { wallet } = await decided();
    await appealed(wallet);
    const { reppo, posts } = realReppo(() => reply(status));
    const deps = appealDeps(reppo);
    for (let run = 1; run <= 20; run += 1) {
      expect(await appealNext(deps)).toMatchObject({ kind: 'released', cause: APPEAL_CAUSES.busy, status: 'queued' });
      expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'queued', attempts: 0, submitStartedAt: null, unclearSubmits: 0, checkNote: null });
      expect(new Date(String(await retryAt(wallet))).getTime()).toBe(clock.getTime() + APPEAL_BUSY_WAIT_SECONDS * 1000);
      later(APPEAL_BUSY_WAIT_SECONDS);
    }
    expect(APPEAL_BUSY_WAIT_SECONDS).toBe(180);
    expect(posts()).toBe(20);
    expect(lines).toEqual([`appeal: waiting, ${APPEAL_CAUSES.busy}`]);
  });

  it.each([401, 403])('waits 600 s on a %i with the try handed back, and the log names REPPO_API_KEY but never its value (C40)', async (status) => {
    const { wallet } = await decided();
    await appealed(wallet);
    const { reppo, fetchMock } = realReppo(() => reply(status, { message: `bad key ${API_KEY}` }));
    const deps = appealDeps(reppo);
    for (let run = 1; run <= 3; run += 1) {
      expect(await appealNext(deps)).toMatchObject({ kind: 'released', cause: APPEAL_CAUSES.keyRefused, status: 'queued' });
      expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'queued', attempts: 0, submitStartedAt: null, unclearSubmits: 0, checkNote: null });
      expect(new Date(String(await retryAt(wallet))).getTime()).toBe(clock.getTime() + APPEAL_SERVICE_WAIT_SECONDS * 1000);
      later(APPEAL_SERVICE_WAIT_SECONDS);
    }
    // The key was in play: it went out in the header of every call.
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(lines).toEqual([`appeal: waiting, ${APPEAL_CAUSES.keyRefused}`]);
    expect(lines[0]).toContain('REPPO_API_KEY');
    expect(lines.join('\n')).not.toContain(API_KEY);
  });

  it.each([400, 404])('ends a check Reppo refuses with a %i six times, each try counted, with the refusing cause and never as paid for', async (status) => {
    const { wallet } = await decided();
    await appealed(wallet);
    const { reppo, posts } = realReppo(() => reply(status));
    const deps = appealDeps(reppo);
    for (let attempt = 1; attempt < APPEAL_MAX_ATTEMPTS; attempt += 1) {
      expect(await appealNext(deps)).toMatchObject({ kind: 'released', status: 'queued' });
      expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'queued', attempts: attempt, submitStartedAt: null });
      expect(new Date(String(await retryAt(wallet))).getTime()).toBe(clock.getTime() + retryDelaySeconds(attempt) * 1000);
      later(retryDelaySeconds(attempt));
    }
    expect(await appealNext(deps)).toMatchObject({ kind: 'unchecked', cause: APPEAL_CAUSES.keptRefusing });
    expect(await appealRow(wallet)).toMatchObject({
      checkStatus: 'unchecked',
      checkNote: APPEAL_CAUSES.keptRefusing,
      attempts: APPEAL_MAX_ATTEMPTS,
      submitStartedAt: null,
      unclearSubmits: 0,
    });
    expect(posts()).toBe(APPEAL_MAX_ATTEMPTS);
    expect(lines.join('\n')).not.toContain(MAYBE_PAID);
  });

  it.each<[string, () => Response | Error]>([
    ['a fetch failure with no cause code', () => new TypeError('fetch failed')],
    ['a cause code not in the list', () => new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })],
    ['a 408', () => reply(408)],
    ['a 500', () => reply(500)],
  ])('reads %s as unclear: the try counted, the mark kept, and with the limit at 1 the next take counts it and ends the check (fail closed)', async (_name, answer) => {
    const { wallet } = await decided();
    await appealed(wallet);
    const { reppo, posts } = realReppo(answer);
    const deps = { ...appealDeps(reppo), maxUnclearSubmits: 1 };
    expect(await appealNext(deps)).toMatchObject({ kind: 'released', status: 'queued' });
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'queued', attempts: 1, unclearSubmits: 0 });
    expect((await appealRow(wallet))?.submitStartedAt).not.toBeNull();
    later(retryDelaySeconds(1));
    expect(await appealNext(deps)).toMatchObject({ kind: 'unchecked', cause: MAYBE_PAID });
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'unchecked', unclearSubmits: 1, checkNote: MAYBE_PAID });
    expect(posts()).toBe(1);
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

  it.each([
    ['line feed', '\n'],
    ['carriage return', '\r'],
    ['escape', '\u001b'],
    ['delete', '\u007f'],
    ['next line', '\u0085'],
    ['last C1 control', '\u009f'],
    ['line separator', '\u2028'],
    ['paragraph separator', '\u2029'],
    ['zero-width space', '\u200b'],
    ['right-to-left override', '\u202e'],
  ])('prints a %s from outside only as an escape, so the line never breaks or turns (C58)', (_name, character) => {
    const printed = quoted(`before${character}after`);
    expect(printed.includes(character)).toBe(false);
    expect(printed).toMatch(/^"before\\(?:[nr]|u[0-9a-f]{4})after"$/);
  });

  it('keeps no Reppo note carrying a line separator, so it can never reach the list raw (C13, C58)', async () => {
    expect(noteFrom('First part\u2028second part')).toBeNull();
    const { wallet } = await decided();
    await appealed(wallet);
    const reppo = new StandInReppo();
    reppo.answers.push(completed('review', 'First part\u2028second part'));
    expect(await appealNext(appealDeps(reppo))).toMatchObject({ kind: 'checked' });
    expect(await appealRow(wallet)).toMatchObject({ reppoNote: null });
    const { lines: printed } = await appealListLines(db, CAMPAIGN);
    expect(printed).toContain('  note: none');
    for (const line of printed) expect(line).not.toMatch(/[\u2028\u2029\r\n]/);
  });

  it('shows the count of unclear submits, and a warning only for a submit mark with no evaluation id, so the operator sees a check that may have been paid for', async () => {
    const ended = await decided();
    const pending = await decided();
    const checked = await decided();
    const fresh = await decided();
    const reppo = new StandInReppo();
    const deps = { ...appealDeps(reppo), maxUnclearSubmits: 1 };
    // An unclear submit, then the next take counts it and, with the limit at 1, ends the check.
    await appealed(ended.wallet);
    reppo.submitAnswers.push(new ReppoError('Reppo answered with status 500', 500));
    expect(await appealNext(deps)).toMatchObject({ kind: 'released', wallet: ended.wallet });
    later(retryDelaySeconds(1));
    expect(await appealNext(deps)).toMatchObject({ kind: 'unchecked', wallet: ended.wallet, cause: APPEAL_MAYBE_PAID });
    // An unclear submit whose mark still stands, before any take has counted it.
    await appealed(pending.wallet);
    reppo.submitAnswers.push(new ReppoError('Reppo answered with status 500', 500));
    expect(await appealNext(deps)).toMatchObject({ kind: 'released', wallet: pending.wallet });
    // A mark beside the evaluation id that shows what was paid for.
    await appealed(checked.wallet);
    expect(await appealNext(deps)).toMatchObject({ kind: 'checked', wallet: checked.wallet });
    expect((await appealRow(checked.wallet))?.submitStartedAt).not.toBeNull();
    await appealed(fresh.wallet);

    const { lines: printed } = await appealListLines(db, CAMPAIGN);
    const blockOf = (wallet: string) => {
      const start = printed.findIndex((line) => line.startsWith('appeal ') && line.endsWith(`: ${parseAddress(wallet)}`));
      if (start === -1) throw new Error(`no block for ${wallet}`);
      const next = printed.findIndex((line, index) => index > start && line.startsWith('appeal '));
      return printed.slice(start, next === -1 ? undefined : next);
    };
    const markLines = (wallet: string) => blockOf(wallet).filter((line) => line.startsWith('  warning:') || line.startsWith('  submit mark:'));
    const marked = (await appealRow(pending.wallet))?.submitStartedAt?.toISOString();
    expect(marked).toBeDefined();
    expect(markLines(pending.wallet)).toEqual([`  warning: a submit may have been paid for, marked at ${marked} with no evaluation id`]);
    for (const wallet of [ended.wallet, checked.wallet, fresh.wallet]) expect(markLines(wallet)).toEqual([]);
    expect(blockOf(ended.wallet)).toEqual(expect.arrayContaining([`  check note: ${JSON.stringify(APPEAL_MAYBE_PAID)}`, '  unclear submits: 1']));
    for (const wallet of [pending.wallet, checked.wallet, fresh.wallet]) {
      expect(blockOf(wallet).filter((line) => line.startsWith('  unclear submits:'))).toEqual([]);
    }
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
      chain: 'ethereum',
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

  it('carries the chain the ask was screened on, and still adds to a file whose older lines carry none (l)', async () => {
    const wallet = privateKeyToAccount(generatePrivateKey()).address;
    await addAsk(db, { campaignId: CAMPAIGN, wallet, signedAt: Math.floor(clock.getTime() / 1000), signature: SIGNATURE }, clock);
    expect(await takeAsk(db, clock, 300, 10)).toMatchObject({ wallet });
    const onBase = {
      campaignId: CAMPAIGN,
      wallet,
      action: 'hold' as const,
      shareBps: 0,
      rule: 'A4',
      reason: 'In a group of 2 linked wallets that share a first funder, so a person should look.',
      citedTxs: [],
      notChecked: [],
      facts: askFactsOf(HELD_FACTS, 'base'),
      servRequestId: 'run-1',
      record: toGraphRecord(HELD_FACTS, { outcome: 'hold', rule: 'A4' }) as Record<string, unknown>,
    };
    expect(await decideAsk(db, onBase, clock)).not.toBeNull();
    later(1);
    await appealed(wallet);
    expect(await appealNext(appealDeps(new StandInReppo()))).toMatchObject({ kind: 'checked' });

    expect((await exportAppeals(db, CAMPAIGN, file, true)).ok).toBe(true);
    const [written] = fileLines();
    expect(AppealExportLine.parse(JSON.parse(written as string))).toMatchObject({ wallet: parseAddress(wallet), chain: 'base' });

    // A line exported before the chain was recorded has no chain key, and the file it sits in is still added to.
    const { chain: _chain, ...older } = JSON.parse(written as string) as Record<string, unknown>;
    fs.writeFileSync(file, `${JSON.stringify(older)}\n`);
    const again = await exportAppeals(db, CAMPAIGN, file, true);
    expect(again.ok).toBe(true);
    expect(again.lines).toContain('1 checked appeal, 1 already in the file, 0 to add');
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

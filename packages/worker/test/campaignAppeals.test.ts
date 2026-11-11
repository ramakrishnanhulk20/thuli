// Not covered here: live Reppo, a real Postgres, the API route that files an appeal and the site. Reppo is a stand-in
// that answers the way the real client does, verdicts going through core's own parseVerdict; the store is PGlite in this
// process. The Reppo client's HTTP rules are reppoClient.test.ts; the store's appeal rules are the store's own tests.
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
} from '@thuli/core';
import {
  addAppeal,
  addAsk,
  createCampaign,
  decideAsk,
  getAsk,
  migrate,
  openMemoryDb,
  ownerAppeals,
  slotHolders,
  takeAsk,
  type CampaignInput,
  type Db,
  type TakenAppeal,
} from '@thuli/store';
import {
  APPEAL_CAUSES,
  APPEAL_MAX_ATTEMPTS,
  appealListLines,
  appealNext,
  NO_REPPO_KEY,
  noteFrom,
  outsideInput,
  parseSettleArgs,
  routeFrom,
  settleAppealCommand,
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

/** Reppo as the step sees it, counting every submission and every look-up. */
class StandInReppo implements AppealReppo {
  readonly submitted: string[] = [];
  readonly lookedUp: string[] = [];
  /** What each look-up answers, oldest first; when empty, a completed ship. */
  readonly answers: (Omit<ReppoEval, 'id'> | Error)[] = [];
  submitFails: Error | null = null;
  onSubmit: () => void = () => undefined;
  onLookUp: () => void = () => undefined;

  async submit(input: string): Promise<string> {
    if (this.submitFails !== null) throw this.submitFails;
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

  it('maps every route Reppo can send, and an unknown one to none, which no check is recorded with', async () => {
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
    expect(await appealNext(appealDeps(reppo))).toMatchObject({ kind: 'unchecked', cause: APPEAL_CAUSES.unknownRoute });
    expect(await appealRow(wallet)).toMatchObject({ checkStatus: 'unchecked', reppoRoute: null });
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
    reppo.submitFails = new ReppoError('Reppo answered with status 500', 500);
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
    expect(dry.lines.at(-1)).toBe('it would be settled as reversed to full; add --write to do it');
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
        `  text: ${TEXT}`,
        '  outside check: checked, route review, evaluation eval_1, 440 credits',
        '  note: A person should look at the shared funder.',
        '  outcome: open',
      ],
    });
    expect(await appealListLines(db, 'no-such-campaign')).toEqual({ ok: true, lines: ['no appeals in campaign no-such-campaign'] });
  });
});

// Not covered here: truly parallel connections. PGlite runs one statement at a time, so the calls started together with
// Promise.all interleave transaction by transaction; they prove each appeal and settlement is decided inside one
// transaction under the campaign's lock or inside one statement, not that the locks hold between two connections. Set
// STORE_TEST_URL to a throwaway Postgres database to run every test below there too; that run empties every Thuli table
// in it. The appeal's signature is stored as given: checking it is core's checkAppeal. Reppo, the worker that calls it,
// and the routes and commands that call these functions are not here.
import { readFile } from 'node:fs/promises';
import { appealTextHash, parseAddress, type Outcome } from '@thuli/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addAppeal,
  APPEALS_DAY_COUNTER,
  APPEALS_DAY_MAX,
  APPEALS_PER_CAMPAIGN_DAY,
  campaignAppealsCounter,
  clearAppealSubmitting,
  getAppeal,
  markAppealSubmitting,
  markAppealUnchecked,
  noteAppealEval,
  ownerAppeals,
  recordAppealCheck,
  releaseAppeal,
  settleAppeal,
  settleRefusal,
  takeAppeal,
  type AppealInput,
} from '../src/appeals.ts';
import {
  addAsk,
  board,
  counts,
  createCampaign,
  decideAsk,
  getAsk,
  releaseAsk,
  requeueFailedAsk,
  slotHolders,
  takeAsk,
  type CampaignInput,
} from '../src/campaigns.ts';
import { connectPostgres, openMemoryDb, StoreError, type Db } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';

const REAL_URL = process.env.STORE_TEST_URL;
const TARGETS = [
  { name: 'in-memory PGlite', open: openMemoryDb },
  {
    name: 'Postgres at STORE_TEST_URL',
    open: REAL_URL === undefined || REAL_URL === '' ? undefined : async () => connectPostgres(REAL_URL, { max: 10 }),
  },
];

const NOW = new Date('2026-11-11T12:00:00.000Z');
const CAMPAIGN = 'demo';
const SIGNATURE = `0x${'ab'.repeat(65)}`;
const APPEAL_SIGNATURE = `0x${'cd'.repeat(65)}`;
const TEXT = 'This wallet is mine alone; the shared funder is an exchange I use.';
const OWNER_NOTE = 'Checked by hand: one person.';
const RECORD = { walletAgeDays: 400, txCount: 90, firstFunderKind: 'exchange', groupSize: null };
const PUBLIC_APPEAL_KEYS = ['checkStatus', 'checkedAt', 'filedAt', 'newAction', 'outcome', 'reppoEvalId', 'reppoNote', 'reppoRoute', 'settledAt'];
const FACTS = { ageDays: 400, txCount: 90, accountType: 'eoa', funder: null, burstWallets: null, groupSize: null, missing: [] };

function plus(seconds: number): Date {
  return new Date(NOW.getTime() + seconds * 1000);
}

function wallet(n: number): string {
  return parseAddress(`0x${'abcdef'.repeat(6)}${n.toString(16).padStart(4, '0')}`);
}

function terms(overrides: Partial<CampaignInput> = {}): CampaignInput {
  return {
    id: CAMPAIGN,
    name: 'Thuli demo',
    chain: 84532,
    vault: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    token: wallet(9001),
    owner: wallet(9002),
    agent: wallet(9003),
    rewardPerWallet: '1000000',
    perWalletCap: '1000000',
    partialShareBps: 5000,
    maxSlots: 20,
    rulebook: 2,
    settings: {},
    status: 'open',
    opensAt: plus(-3_600),
    closesAt: plus(86_400),
    createdAt: plus(-7_200),
    ...overrides,
  };
}

function appeal(n: number, overrides: Partial<AppealInput> = {}): AppealInput {
  const text = overrides.text ?? TEXT;
  return { campaignId: CAMPAIGN, wallet: wallet(n), text, textHash: appealTextHash(text), signedAt: 1_800_000_000, signature: APPEAL_SIGNATURE, ...overrides };
}

const key = (n: number, campaignId = CAMPAIGN) => ({ campaignId, wallet: wallet(n) });

for (const { name, open } of TARGETS) {
  describe.skipIf(open === undefined)(`appeals on ${name}`, () => {
    let db: Db;
    beforeAll(async () => {
      db = await (open ?? openMemoryDb)();
      await migrate(db);
    });
    beforeEach(async () => {
      await db.query('TRUNCATE appeals, claim_relays, list_versions, asks, campaigns, day_counts');
    });
    afterAll(async () => {
      await db.close();
    });

    /** Adds wallet n's ask and decides it at once, so it is the only ask waiting when it is taken. */
    async function decided(
      n: number,
      action: Outcome,
      options: { record?: Record<string, unknown>; campaignId?: string } = {},
    ): Promise<{ slot: number | null } | null> {
      const campaignId = options.campaignId ?? CAMPAIGN;
      expect(await addAsk(db, { campaignId, wallet: wallet(n), signedAt: 1_800_000_000, signature: SIGNATURE }, NOW)).toBe('queued');
      expect(await takeAsk(db, NOW, 60, 3)).toMatchObject({ wallet: wallet(n) });
      return decideAsk(
        db,
        {
          campaignId,
          wallet: wallet(n),
          action,
          shareBps: { full: 10_000, partial: 5_000, hold: 0, exclude: 0 }[action],
          rule: action === 'exclude' ? 'A3' : 'A9',
          reason: `Decided ${action} on the funder trail.`,
          citedTxs: [],
          notChecked: [],
          facts: FACTS,
          servRequestId: 'run-1',
          ...(options.record === undefined ? {} : { record: options.record }),
        },
        NOW,
      );
    }

    async function failed(n: number): Promise<void> {
      expect(await addAsk(db, { campaignId: CAMPAIGN, wallet: wallet(n), signedAt: 1_800_000_000, signature: SIGNATURE }, NOW)).toBe('queued');
      expect(await takeAsk(db, NOW, 60, 3)).toMatchObject({ wallet: wallet(n) });
      expect(await releaseAsk(db, CAMPAIGN, wallet(n), NOW, 1)).toBe('failed');
    }

    async function dayCount(): Promise<number> {
      const [row] = await db.query<{ count: number }>('SELECT count FROM day_counts WHERE name = $1', [APPEALS_DAY_COUNTER]);
      return row?.count ?? 0;
    }

    async function askRow(n: number) {
      const [row] = await db.query(
        'SELECT status, action, share_bps, rule, reason, slot, reversed_by_appeal FROM asks WHERE campaign_id = $1 AND wallet = $2',
        [CAMPAIGN, wallet(n)],
      );
      return row;
    }

    /**
     * Stands in for a failed ask that was requeued while it had an appeal, before requeueFailedAsk refused that: the old
     * requeue's own statement, then a screening that approves it. Returns decideAsk's answer.
     */
    async function requeuedBeforeTheRule(n: number, at: Date) {
      await db.query(
        `UPDATE asks SET status = 'queued', attempts = 0, retry_at = NULL, lease_until = NULL, action = NULL, share_bps = NULL,
                rule = NULL, reason = NULL, cited_txs = NULL, not_checked = NULL, facts = NULL, serv_request_id = NULL, decided_at = NULL
          WHERE campaign_id = $1 AND wallet = $2 AND status = 'failed'`,
        [CAMPAIGN, wallet(n)],
      );
      expect(await takeAsk(db, at, 60, 3)).toMatchObject({ wallet: wallet(n) });
      return decideAsk(
        db,
        { campaignId: CAMPAIGN, wallet: wallet(n), action: 'full', shareBps: 10_000, rule: 'A9', reason: 'Approved.', citedTxs: [], notChecked: [], facts: FACTS, servRequestId: null },
        at,
      );
    }

    it('C11: addAppeal queues an appeal on a hold, an exclusion, a partial or a failed ask, keeping what was appealed', async () => {
      await createCampaign(db, terms());
      expect(await decided(1, 'hold')).toEqual({ slot: null });
      expect(await decided(2, 'exclude')).toEqual({ slot: null });
      expect(await decided(3, 'partial')).toEqual({ slot: 1 });
      await failed(4);
      for (const n of [1, 2, 3, 4]) expect(await addAppeal(db, appeal(n, { wallet: wallet(n).toLowerCase() }), plus(n))).toBe('queued');
      const rows = await ownerAppeals(db, CAMPAIGN);
      expect(rows.map((row) => [row.wallet, row.appealedAction, row.appealedRule, row.text, row.checkStatus, row.outcome])).toEqual([
        [wallet(1), 'hold', 'A9', TEXT, 'queued', 'open'],
        [wallet(2), 'exclude', 'A3', TEXT, 'queued', 'open'],
        [wallet(3), 'partial', 'A9', TEXT, 'queued', 'open'],
        [wallet(4), 'hold', 'A1', TEXT, 'queued', 'open'],
      ]);
      expect(await getAppeal(db, CAMPAIGN, wallet(1))).toEqual({
        filedAt: plus(1),
        checkStatus: 'queued',
        reppoRoute: null,
        reppoNote: null,
        reppoEvalId: null,
        checkedAt: null,
        outcome: 'open',
        newAction: null,
        settledAt: null,
      });
      expect(await getAppeal(db, CAMPAIGN, wallet(9))).toBeNull();
    });

    it('C24, C42: addAppeal answers unknown, undecided, approved and exists without a day count, and busy past the ceiling', async () => {
      expect(APPEALS_DAY_MAX).toBe(20);
      await createCampaign(db, terms());
      expect(await decided(1, 'hold')).toEqual({ slot: null });
      expect(await decided(2, 'full')).toEqual({ slot: 1 });
      expect(await decided(3, 'hold')).toEqual({ slot: null });
      expect(await decided(4, 'hold')).toEqual({ slot: null });
      expect(await addAsk(db, { campaignId: CAMPAIGN, wallet: wallet(5), signedAt: 1, signature: SIGNATURE }, plus(-2))).toBe('queued');
      expect(await addAsk(db, { campaignId: CAMPAIGN, wallet: wallet(6), signedAt: 1, signature: SIGNATURE }, plus(-1))).toBe('queued');
      expect(await takeAsk(db, NOW, 60, 3)).toMatchObject({ wallet: wallet(5) });

      expect(await addAppeal(db, appeal(1), NOW)).toBe('queued');
      expect(await dayCount()).toBe(1);
      const answers = [
        await addAppeal(db, appeal(9), NOW),
        await addAppeal(db, appeal(1, { campaignId: 'missing' }), NOW),
        await addAppeal(db, appeal(5), NOW),
        await addAppeal(db, appeal(6), NOW),
        await addAppeal(db, appeal(2), NOW),
        await addAppeal(db, appeal(1, { text: 'A second, different appeal.' }), NOW),
      ];
      expect(answers).toEqual(['unknown', 'unknown', 'undecided', 'undecided', 'approved', 'exists']);
      expect(await dayCount()).toBe(1);
      expect((await ownerAppeals(db, CAMPAIGN)).map((row) => row.text)).toEqual([TEXT]);

      // Stands in for the appeals other campaigns took today.
      await db.query('UPDATE day_counts SET count = $1 WHERE name = $2', [APPEALS_DAY_MAX - 1, APPEALS_DAY_COUNTER]);
      expect(await addAppeal(db, appeal(3), NOW)).toBe('queued');
      expect(await addAppeal(db, appeal(4), NOW)).toBe('busy');
      expect(await addAppeal(db, appeal(3), NOW)).toBe('exists');
      expect(await dayCount()).toBe(APPEALS_DAY_MAX);
      expect(await getAppeal(db, CAMPAIGN, wallet(4))).toBeNull();
      expect(await addAppeal(db, appeal(4), new Date('2026-11-12T00:00:00.000Z'))).toBe('queued');
    });

    it('addAppeal refuses text, a hash or a signature it would not store, before writing anything', async () => {
      await createCampaign(db, terms());
      expect(await decided(1, 'hold')).toEqual({ slot: null });
      const refused: Partial<AppealInput>[] = [
        { text: '', textHash: appealTextHash('') },
        { text: 'x'.repeat(1_001), textHash: appealTextHash('x'.repeat(1_001)) },
        { text: 'See https://evil.example', textHash: appealTextHash('See https://evil.example') },
        { textHash: appealTextHash('some other text') },
        { textHash: 'not a hash' },
        ...['one\ntwo', 'one\ttwo', 'one\rtwo', 'one\u2028two', 'one\u2029two', 'one\u0085two', 'one\u000btwo'].map((line) => ({ text: line, textHash: appealTextHash(line) })),
        { signature: '0x1234' },
        { signedAt: 1.5 },
      ];
      for (const overrides of refused) await expect(addAppeal(db, appeal(1, overrides), NOW)).rejects.toThrow(StoreError);
      expect(await ownerAppeals(db, CAMPAIGN)).toEqual([]);
      expect(await dayCount()).toBe(0);
      expect(await addAppeal(db, appeal(1, { text: 'x'.repeat(1_000) }), NOW)).toBe('queued');
    });

    it('C42: ten appeals from one wallet started together give exactly one queued, and the first stands', async () => {
      await createCampaign(db, terms());
      expect(await decided(1, 'hold')).toEqual({ slot: null });
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) => addAppeal(db, appeal(1, { text: `Appeal number ${index}.` }), NOW)),
      );
      expect(results.filter((result) => result === 'queued')).toHaveLength(1);
      expect(results.filter((result) => result === 'exists')).toHaveLength(9);
      expect(await ownerAppeals(db, CAMPAIGN)).toHaveLength(1);
      expect(await dayCount()).toBe(1);
    });

    it('C41: takeAppeal never hands one appeal to two takers, and hands back the ask it judges', async () => {
      await createCampaign(db, terms());
      expect(await decided(1, 'hold', { record: RECORD })).toEqual({ slot: null });
      expect(await decided(2, 'partial')).toEqual({ slot: 1 });
      await failed(3);
      for (const n of [1, 2, 3]) expect(await addAppeal(db, appeal(n), plus(n))).toBe('queued');
      const taken = await Promise.all(Array.from({ length: 5 }, () => takeAppeal(db, plus(10), 300, 6)));
      const appeals = taken.filter((item) => item !== null);
      expect(appeals).toHaveLength(3);
      expect(new Set(appeals.map((item) => item.wallet))).toEqual(new Set([1, 2, 3].map(wallet)));
      expect(appeals.find((item) => item.wallet === wallet(1))).toEqual({
        campaignId: CAMPAIGN,
        wallet: wallet(1),
        attempts: 1,
        leaseUntil: plus(310),
        reppoEvalId: null,
        submitStarted: false,
        appealedAction: 'hold',
        appealedRule: 'A9',
        action: 'hold',
        rule: 'A9',
        reason: 'Decided hold on the funder trail.',
        record: RECORD,
      });
      expect(appeals.find((item) => item.wallet === wallet(3))).toMatchObject({ action: 'hold', rule: 'A1', record: null });
      expect(await takeAppeal(db, plus(309), 300, 6)).toBeNull();
      expect((await getAppeal(db, CAMPAIGN, wallet(1)))?.checkStatus).toBe('checking');
      // An expired lease is taken again, with one more attempt.
      expect(await takeAppeal(db, plus(310), 300, 6)).toMatchObject({ wallet: wallet(1), attempts: 2 });
      await expect(takeAppeal(db, NOW, 0, 6)).rejects.toThrow(StoreError);
      await expect(takeAppeal(db, NOW, 60, 0)).rejects.toThrow(StoreError);
    });

    it('C23: an unfinished evaluation id is kept across a release, so the same evaluation is looked up and never sent twice', async () => {
      await createCampaign(db, terms());
      expect(await decided(1, 'hold', { record: RECORD })).toEqual({ slot: null });
      expect(await addAppeal(db, appeal(1), NOW)).toBe('queued');
      expect(await noteAppealEval(db, key(1), 'eval_1', NOW)).toBe(false);
      expect((await takeAppeal(db, plus(1), 300, 6))?.reppoEvalId).toBeNull();
      await expect(noteAppealEval(db, key(1), 'not an id!', plus(2))).rejects.toThrow(StoreError);
      expect(await noteAppealEval(db, key(1), 'eval_1', plus(2))).toBe(true);
      expect(await noteAppealEval(db, key(1), 'eval_1', plus(2))).toBe(true);
      expect(await noteAppealEval(db, key(1), 'eval_2', plus(2))).toBe(false);
      for (const bad of [-1, 1.5, 86_401]) await expect(releaseAppeal(db, key(1), plus(3), 6, bad)).rejects.toThrow(StoreError);
      expect(await releaseAppeal(db, key(1), plus(3), 6, 30)).toBe('queued');
      expect(await getAppeal(db, CAMPAIGN, wallet(1))).toMatchObject({ checkStatus: 'queued', reppoEvalId: 'eval_1' });
      expect(await takeAppeal(db, plus(32), 300, 6)).toBeNull();
      expect(await takeAppeal(db, plus(33), 300, 6)).toMatchObject({ attempts: 2, reppoEvalId: 'eval_1' });

      for (const bad of [
        { evalId: 'eval_1', route: 'maybe', note: null, creditsCharged: 3 },
        { evalId: 'eval_1', route: 'ship', note: 'x'.repeat(281), creditsCharged: 3 },
        { evalId: 'eval_1', route: 'ship', note: '<b>fine</b>', creditsCharged: 3 },
        { evalId: 'eval_1', route: 'ship', note: null, creditsCharged: -1 },
      ]) {
        await expect(recordAppealCheck(db, key(1), bad as Parameters<typeof recordAppealCheck>[2], plus(40))).rejects.toThrow(StoreError);
      }
      const note = 'The hold rests on a funder count alone.';
      expect(await recordAppealCheck(db, key(1), { evalId: 'eval_1', route: 'block', note, creditsCharged: 4 }, plus(40))).toBe(true);
      expect(await recordAppealCheck(db, key(1), { evalId: 'eval_1', route: 'ship', note: null, creditsCharged: 4 }, plus(41))).toBe(false);
      expect(await getAppeal(db, CAMPAIGN, wallet(1))).toMatchObject({
        checkStatus: 'checked',
        reppoRoute: 'block',
        reppoNote: note,
        reppoEvalId: 'eval_1',
        checkedAt: plus(40),
        outcome: 'open',
      });
      expect(await takeAppeal(db, plus(10_000), 300, 6)).toBeNull();
      expect(await counts(db, CAMPAIGN)).toMatchObject({ appeals: { filed: 1, checked: 1, block: 1, reversed: 0 } });
    });

    it('C23: a paid check whose route Thuli does not know is still checked, shows reppoRoute null, and is never sent again', async () => {
      await createCampaign(db, terms());
      expect(await decided(1, 'hold', { record: RECORD })).toEqual({ slot: null });
      expect(await addAppeal(db, appeal(1), NOW)).toBe('queued');
      expect(await takeAppeal(db, plus(1), 300, 6)).toMatchObject({ wallet: wallet(1) });
      expect(await recordAppealCheck(db, key(1), { evalId: 'eval_3', route: null, note: null, creditsCharged: 4 }, plus(2))).toBe(true);
      const shown = {
        filedAt: NOW,
        checkStatus: 'checked',
        reppoRoute: null,
        reppoNote: null,
        reppoEvalId: 'eval_3',
        checkedAt: plus(2),
        outcome: 'open',
        newAction: null,
        settledAt: null,
      };
      expect(await getAppeal(db, CAMPAIGN, wallet(1))).toEqual(shown);
      expect((await getAsk(db, CAMPAIGN, wallet(1)))?.appeal).toEqual(shown);
      expect((await board(db, CAMPAIGN, 10)).find((row) => row.wallet === wallet(1))?.appeal).toEqual(shown);
      expect(await takeAppeal(db, plus(10_000), 300, 6)).toBeNull();
      expect(await recordAppealCheck(db, key(1), { evalId: 'eval_3', route: 'ship', note: null, creditsCharged: 4 }, plus(3))).toBe(false);
      expect((await ownerAppeals(db, CAMPAIGN))[0]).toMatchObject({ checkStatus: 'checked', reppoRoute: null, creditsCharged: 4 });
      expect(await counts(db, CAMPAIGN)).toMatchObject({ appeals: { filed: 1, checked: 1, block: 0, reversed: 0 } });
    });

    it("C34, C40: Reppo's score, decision and confidence are kept as given for the owner and are in no public view", async () => {
      await createCampaign(db, terms());
      for (const n of [1, 2]) expect(await decided(n, 'hold', { record: RECORD })).toEqual({ slot: null });
      for (const n of [1, 2]) expect(await addAppeal(db, appeal(n), plus(n))).toBe('queued');
      for (const n of [1, 2]) expect(await takeAppeal(db, plus(10), 300, 6)).toMatchObject({ wallet: wallet(n) });
      const verdict = { score: 37, decision: 'reject-marker', confidence: 'high' as const };
      expect(await recordAppealCheck(db, key(1), { evalId: 'eval_1', route: 'block', note: null, creditsCharged: 4, ...verdict }, plus(20))).toBe(true);
      expect(await recordAppealCheck(db, key(2), { evalId: 'eval_2', route: 'ship', note: null, creditsCharged: 4 }, plus(20))).toBe(true);
      const owned = await ownerAppeals(db, CAMPAIGN);
      expect(owned.map((row) => [row.wallet, row.reppoScore, row.reppoDecision, row.reppoConfidence])).toEqual([
        [wallet(1), 37, 'reject-marker', 'high'],
        [wallet(2), null, null, null],
      ]);
      const views = [await getAppeal(db, CAMPAIGN, wallet(1)), (await getAsk(db, CAMPAIGN, wallet(1)))?.appeal, (await board(db, CAMPAIGN, 10)).find((row) => row.wallet === wallet(1))?.appeal];
      for (const view of views) expect(Object.keys(view ?? {}).sort()).toEqual(PUBLIC_APPEAL_KEYS);
      const everything = JSON.stringify([...views, await getAsk(db, CAMPAIGN, wallet(1)), await board(db, CAMPAIGN, 10), await counts(db, CAMPAIGN)]);
      for (const hidden of ['reject-marker', '"high"', 'Score', 'Confidence']) expect(everything).not.toContain(hidden);
    });

    it("C41: a score, decision or confidence outside ReppoVerdict's bounds is refused before anything is written", async () => {
      await createCampaign(db, terms());
      for (const n of [1, 2]) expect(await decided(n, 'hold', { record: RECORD })).toEqual({ slot: null });
      for (const n of [1, 2]) expect(await addAppeal(db, appeal(n), plus(n))).toBe('queued');
      for (const n of [1, 2]) expect(await takeAppeal(db, plus(10), 300, 6)).toMatchObject({ wallet: wallet(n) });
      const base = { evalId: 'eval_1', route: 'review', note: null, creditsCharged: 4 };
      const refused: Record<string, unknown>[] = [
        ...[-1, 101, 1.5, Number.NaN, '50', true].map((score) => ({ score })),
        ...['', 'x'.repeat(65), '<b>accept</b>', 'accept\u0007', 5].map((decision) => ({ decision })),
        ...['certain', 'High', '', 0.9, 2].map((confidence) => ({ confidence })),
      ];
      for (const bad of refused) {
        await expect(recordAppealCheck(db, key(1), { ...base, ...bad } as Parameters<typeof recordAppealCheck>[2], plus(20))).rejects.toThrow(StoreError);
      }
      expect((await getAppeal(db, CAMPAIGN, wallet(1)))?.checkStatus).toBe('checking');
      expect((await ownerAppeals(db, CAMPAIGN))[0]).toMatchObject({ reppoEvalId: null, reppoScore: null, reppoDecision: null, reppoConfidence: null });
      // The edges themselves are kept.
      const edge = { score: 100, decision: 'x'.repeat(64), confidence: 'low' as const };
      expect(await recordAppealCheck(db, key(1), { ...base, route: 'review', ...edge }, plus(21))).toBe(true);
      expect(await recordAppealCheck(db, key(2), { ...base, evalId: 'eval_2', route: 'review', score: 0, decision: 'accept', confidence: 'medium' }, plus(21))).toBe(true);
      expect((await ownerAppeals(db, CAMPAIGN)).map((row) => [row.reppoScore, row.reppoDecision, row.reppoConfidence])).toEqual([
        [100, 'x'.repeat(64), 'low'],
        [0, 'accept', 'medium'],
      ]);
    });

    it('C41: an appeal try that was not its fault is handed back, never below zero, and its wait still holds', async () => {
      await createCampaign(db, terms());
      expect(await decided(1, 'hold')).toEqual({ slot: null });
      expect(await addAppeal(db, appeal(1), NOW)).toBe('queued');
      const attempts = async () => (await ownerAppeals(db, CAMPAIGN))[0]?.attempts;
      expect(await takeAppeal(db, plus(1), 300, 6)).toMatchObject({ attempts: 1 });
      for (const refundTry of ['yes', 1, null]) {
        await expect(releaseAppeal(db, key(1), plus(2), 6, 30, { refundTry } as unknown as { refundTry: boolean })).rejects.toThrow(StoreError);
      }
      expect(await releaseAppeal(db, key(1), plus(2), 6, 30, { refundTry: true })).toBe('queued');
      expect(await attempts()).toBe(0);
      expect(await takeAppeal(db, plus(31), 300, 6)).toBeNull();
      expect(await takeAppeal(db, plus(32), 300, 6)).toMatchObject({ attempts: 1 });
      // At its last attempt, a refunded try still queues the appeal rather than ending it unchecked.
      await db.query('UPDATE appeals SET attempts = 6 WHERE wallet = $1', [wallet(1)]);
      expect(await releaseAppeal(db, key(1), plus(33), 6, 0, { refundTry: true })).toBe('queued');
      expect(await attempts()).toBe(5);
      expect(await takeAppeal(db, plus(34), 300, 6)).toMatchObject({ attempts: 6 });
      await db.query('UPDATE appeals SET attempts = 0 WHERE wallet = $1', [wallet(1)]);
      expect(await releaseAppeal(db, key(1), plus(35), 6, 0, { refundTry: true })).toBe('queued');
      expect(await attempts()).toBe(0);
    });

    it('C41: an appeal out of attempts ends unchecked, never checked, and one with no record can be marked unchecked', async () => {
      await createCampaign(db, terms());
      for (const n of [1, 2, 3]) expect(await decided(n, 'hold')).toEqual({ slot: null });
      for (const n of [1, 2, 3]) expect(await addAppeal(db, appeal(n), plus(n))).toBe('queued');
      expect(await takeAppeal(db, plus(10), 60, 2)).toMatchObject({ wallet: wallet(1), attempts: 1 });
      expect(await releaseAppeal(db, key(1), plus(10), 2, 0)).toBe('queued');
      expect(await takeAppeal(db, plus(11), 60, 2)).toMatchObject({ wallet: wallet(1), attempts: 2 });
      expect(await releaseAppeal(db, key(1), plus(11), 2, 0)).toBe('unchecked');
      expect(await getAppeal(db, CAMPAIGN, wallet(1))).toMatchObject({ checkStatus: 'unchecked', reppoRoute: null, checkedAt: plus(11) });
      expect(await releaseAppeal(db, key(1), plus(12), 2, 0)).toBeNull();

      // A worker that dies holding its last attempt: the next take ends it unchecked and moves on.
      expect(await takeAppeal(db, plus(20), 60, 1)).toMatchObject({ wallet: wallet(2), attempts: 1 });
      expect(await takeAppeal(db, plus(80), 60, 1)).toMatchObject({ wallet: wallet(3), attempts: 1 });
      expect((await getAppeal(db, CAMPAIGN, wallet(2)))?.checkStatus).toBe('unchecked');
      expect(await markAppealUnchecked(db, key(1), plus(81))).toBe(false);
      expect(await markAppealUnchecked(db, key(3), plus(81))).toBe(true);
      expect(await getAppeal(db, CAMPAIGN, wallet(3))).toMatchObject({ checkStatus: 'unchecked', checkedAt: plus(81) });
      expect(await recordAppealCheck(db, key(3), { evalId: 'eval_9', route: 'ship', note: null, creditsCharged: 1 }, plus(82))).toBe(false);
      expect(await counts(db, CAMPAIGN)).toMatchObject({ appeals: { filed: 3, checked: 0, block: 0, reversed: 0 } });
    });

    it('C11: settleAppeal refuses an appeal that is not open, a reversal with no action or no more generous one, and a changed ask', async () => {
      await createCampaign(db, terms());
      expect(await decided(1, 'hold')).toEqual({ slot: null });
      expect(await decided(2, 'partial')).toEqual({ slot: 1 });
      await failed(3);
      for (const n of [1, 2, 3]) expect(await addAppeal(db, appeal(n), NOW)).toBe('queued');
      const settle = (n: number, outcome: 'reversed' | 'upheld', newAction?: 'full' | 'partial') =>
        settleAppeal(db, { campaignId: CAMPAIGN, wallet: wallet(n), outcome, newAction: newAction ?? null, ownerNote: null }, plus(5));

      expect(await settle(9, 'upheld')).toEqual({ refused: 'no appeal from this wallet' });
      expect(await settle(1, 'reversed')).toEqual({ refused: 'a reversal needs a new action, full or partial' });
      expect(await settle(2, 'reversed', 'partial')).toEqual({ refused: 'the new action must be more generous than the appealed one' });
      expect(await settle(1, 'upheld', 'full')).toEqual({ refused: 'an upheld appeal takes no new action' });
      await expect(
        settleAppeal(db, { campaignId: CAMPAIGN, wallet: wallet(1), outcome: 'reversed', newAction: 'hold' as 'full', ownerNote: null }, NOW),
      ).rejects.toThrow(StoreError);
      await expect(
        settleAppeal(db, { campaignId: CAMPAIGN, wallet: wallet(1), outcome: 'upheld', newAction: null, ownerNote: '<b>no</b>' }, NOW),
      ).rejects.toThrow(StoreError);

      // An appealed ask is never queued again; one requeued before that rule and then approved no longer matches.
      expect(await requeueFailedAsk(db, CAMPAIGN, wallet(3), plus(1))).toEqual({ requeued: false, cause: 'the ask has an appeal' });
      expect(await requeuedBeforeTheRule(3, plus(2))).toEqual({ slot: 2 });
      expect(await settle(3, 'reversed', 'full')).toEqual({ refused: 'the ask changed after the appeal was filed' });

      expect(await settle(1, 'upheld')).toEqual({ slot: null });
      expect(await settle(1, 'upheld')).toEqual({ refused: 'the appeal is already settled' });
      expect(await settle(1, 'reversed', 'full')).toEqual({ refused: 'the appeal is already settled' });
      expect(await askRow(1)).toMatchObject({ status: 'decided', action: 'hold', share_bps: 0, slot: null, reversed_by_appeal: false });
      expect(await getAppeal(db, CAMPAIGN, wallet(1))).toMatchObject({ outcome: 'upheld', newAction: null, settledAt: plus(5) });
    });

    it('C23: the submit mark is set once on a checking appeal with no id, survives a lease expiry and a release, and stays private', async () => {
      await createCampaign(db, terms());
      for (const n of [1, 2]) expect(await decided(n, 'hold', { record: RECORD })).toEqual({ slot: null });
      for (const n of [1, 2]) expect(await addAppeal(db, appeal(n), plus(n))).toBe('queued');
      expect(await markAppealSubmitting(db, key(1), plus(3))).toBe(false);
      expect(await takeAppeal(db, plus(10), 300, 6)).toMatchObject({ wallet: wallet(1), attempts: 1, submitStarted: false });
      expect(await markAppealSubmitting(db, key(1), plus(11))).toBe(true);
      expect(await markAppealSubmitting(db, key(1), plus(12))).toBe(false);
      // The worker died before the evaluation id was kept: the next take after the lease says a submit was started.
      expect(await takeAppeal(db, plus(310), 300, 6)).toMatchObject({ wallet: wallet(1), attempts: 2, reppoEvalId: null, submitStarted: true });
      expect(await markAppealSubmitting(db, key(1), plus(311))).toBe(false);
      expect(await releaseAppeal(db, key(1), plus(312), 6, 0)).toBe('queued');
      expect(await takeAppeal(db, plus(313), 300, 6)).toMatchObject({ wallet: wallet(1), attempts: 3, submitStarted: true });
      const cause = 'the outside check may already have been paid for';
      for (const bad of ['', 'x'.repeat(121), '<b>paid</b>', 'two\nlines', 'tab\there']) {
        await expect(markAppealUnchecked(db, key(1), plus(314), bad)).rejects.toThrow(StoreError);
      }
      expect((await getAppeal(db, CAMPAIGN, wallet(1)))?.checkStatus).toBe('checking');
      expect(await markAppealUnchecked(db, key(1), plus(315), cause)).toBe(true);
      const owned = (await ownerAppeals(db, CAMPAIGN))[0];
      expect(owned).toMatchObject({ checkStatus: 'unchecked', checkNote: cause, submitStartedAt: plus(11), reppoEvalId: null, checkedAt: plus(315) });
      const view = await getAppeal(db, CAMPAIGN, wallet(1));
      expect(Object.keys(view ?? {}).sort()).toEqual(PUBLIC_APPEAL_KEYS);
      expect(JSON.stringify([view, await getAsk(db, CAMPAIGN, wallet(1)), await board(db, CAMPAIGN, 10)])).not.toContain(cause);
      // An appeal whose evaluation id is kept is looked up, never marked for a fresh submit.
      expect(await takeAppeal(db, plus(316), 300, 6)).toMatchObject({ wallet: wallet(2), submitStarted: false });
      expect(await noteAppealEval(db, key(2), 'eval_2', plus(317))).toBe(true);
      expect(await markAppealSubmitting(db, key(2), plus(318))).toBe(false);
      expect((await ownerAppeals(db, CAMPAIGN))[1]).toMatchObject({ submitStartedAt: null, checkNote: null });
    });

    it('C23: clearAppealSubmitting takes back the mark of a checking appeal with no id, and no other, so a later try may submit', async () => {
      await createCampaign(db, terms());
      for (const n of [1, 2, 3]) expect(await decided(n, 'hold', { record: RECORD })).toEqual({ slot: null });
      for (const n of [1, 2, 3]) expect(await addAppeal(db, appeal(n), plus(n))).toBe('queued');
      for (const n of [1, 2, 3]) expect(await takeAppeal(db, plus(10), 300, 6)).toMatchObject({ wallet: wallet(n) });
      for (const n of [1, 2]) expect(await markAppealSubmitting(db, key(n), plus(11))).toBe(true);
      expect(await noteAppealEval(db, key(2), 'eval_2', plus(12))).toBe(true);
      expect(await clearAppealSubmitting(db, key(1), plus(13))).toBe(true);
      // Refused: the mark is already gone, an evaluation exists, and wallet 3 was never marked.
      for (const n of [1, 2, 3]) expect(await clearAppealSubmitting(db, key(n), plus(13))).toBe(false);
      expect((await ownerAppeals(db, CAMPAIGN)).map((row) => row.submitStartedAt)).toEqual([null, plus(11), null]);
      expect(await markAppealSubmitting(db, key(1), plus(14))).toBe(true);
      // Refused once the appeal is no longer checking, and the mark comes back with the next take.
      expect(await releaseAppeal(db, key(1), plus(15), 6, 0)).toBe('queued');
      expect(await clearAppealSubmitting(db, key(1), plus(16))).toBe(false);
      expect(await takeAppeal(db, plus(17), 300, 6)).toMatchObject({ wallet: wallet(1), submitStarted: true });
      expect(await clearAppealSubmitting(db, { campaignId: 'not a campaign!', wallet: wallet(1) }, plus(18))).toBe(false);
      await expect(clearAppealSubmitting(db, key(1), new Date(Number.NaN))).rejects.toThrow(StoreError);
      expect((await ownerAppeals(db, CAMPAIGN))[0]?.submitStartedAt).toEqual(plus(14));
    });

    it('C11, C17: requeueFailedAsk refuses a failed ask that has an appeal, saying so, and queues one that has none', async () => {
      await createCampaign(db, terms());
      await failed(1);
      await failed(2);
      expect(await addAppeal(db, appeal(1), NOW)).toBe('queued');
      const before = await askRow(1);
      expect(await requeueFailedAsk(db, CAMPAIGN, wallet(1), plus(1))).toEqual({ requeued: false, cause: 'the ask has an appeal' });
      expect(await askRow(1)).toEqual(before);
      expect(await requeueFailedAsk(db, CAMPAIGN, wallet(2), plus(1))).toEqual({ requeued: true });
      expect(await askRow(2)).toMatchObject({ status: 'queued', action: null, rule: null });
    });

    it('C11, C17: takeAppeal ends an appeal whose ask lost the appealed action or rule unchecked, with its cause, and never hands it out', async () => {
      await createCampaign(db, terms());
      await failed(1);
      for (const n of [2, 3]) expect(await decided(n, 'hold', { record: RECORD })).toEqual({ slot: null });
      for (const n of [1, 2, 3]) expect(await addAppeal(db, appeal(n), plus(n))).toBe('queued');
      // Wallet 1's hold became a full approval; wallet 3 keeps its hold under another rule. Only wallet 2 still matches.
      expect(await requeuedBeforeTheRule(1, plus(5))).toEqual({ slot: 1 });
      await db.query("UPDATE asks SET rule = 'A4' WHERE campaign_id = $1 AND wallet = $2", [CAMPAIGN, wallet(3)]);
      expect(await takeAppeal(db, plus(10), 300, 6)).toMatchObject({ wallet: wallet(2), action: 'hold', rule: 'A9', appealedAction: 'hold', appealedRule: 'A9' });
      expect(await takeAppeal(db, plus(10_000), 300, 6)).toMatchObject({ wallet: wallet(2), attempts: 2 });
      expect(await takeAppeal(db, plus(10_000), 300, 6)).toBeNull();
      const owned = await ownerAppeals(db, CAMPAIGN);
      expect(owned.map((row) => [row.wallet, row.checkStatus, row.checkNote, row.attempts])).toEqual([
        [wallet(1), 'unchecked', 'the decision changed after the appeal', 0],
        [wallet(2), 'checking', null, 2],
        [wallet(3), 'unchecked', 'the decision changed after the appeal', 0],
      ]);
      expect(await getAppeal(db, CAMPAIGN, wallet(1))).toMatchObject({ checkStatus: 'unchecked', checkedAt: plus(10), reppoRoute: null });
      expect(await counts(db, CAMPAIGN)).toMatchObject({ appeals: { filed: 3, checked: 0, block: 0, reversed: 0 } });
    });

    it('C24: one campaign takes at most 10 appeals a day, another campaign still queues, and the 21st of the day is busy', async () => {
      expect(APPEALS_PER_CAMPAIGN_DAY).toBe(10);
      for (const id of [CAMPAIGN, 'other', 'third']) await createCampaign(db, terms({ id }));
      for (let n = 1; n <= 11; n += 1) expect(await decided(n, 'hold')).toEqual({ slot: null });
      for (let n = 1; n <= 10; n += 1) expect(await decided(n, 'hold', { campaignId: 'other' })).toEqual({ slot: null });
      expect(await decided(1, 'hold', { campaignId: 'third' })).toEqual({ slot: null });
      const answers: string[] = [];
      for (let n = 1; n <= 11; n += 1) answers.push(await addAppeal(db, appeal(n), NOW));
      for (let n = 1; n <= 10; n += 1) answers.push(await addAppeal(db, appeal(n, { campaignId: 'other' }), NOW));
      answers.push(await addAppeal(db, appeal(1, { campaignId: 'third' }), NOW));
      expect(answers).toEqual([...Array(10).fill('queued'), 'busy', ...Array(10).fill('queued'), 'busy']);
      const counted = async (name: string) => (await db.query<{ count: number }>('SELECT count FROM day_counts WHERE name = $1', [name]))[0]?.count ?? 0;
      expect([await dayCount(), await counted(campaignAppealsCounter(CAMPAIGN)), await counted(campaignAppealsCounter('other'))]).toEqual([20, 10, 10]);
      // The appeal the global ceiling refused leaves its campaign's share as it was: both counts are one transaction.
      expect(await counted(campaignAppealsCounter('third'))).toBe(0);
      expect(campaignAppealsCounter('x'.repeat(128))).toHaveLength(40);
      expect(campaignAppealsCounter('demo')).not.toBe(campaignAppealsCounter('Demo'));
      expect(await addAppeal(db, appeal(11), new Date('2026-11-12T00:00:00.000Z'))).toBe('queued');
    });

    it('C11, C17: settleRefusal answers every refusal and slot exactly as settleAppeal then does, and writes nothing', async () => {
      await createCampaign(db, terms({ maxSlots: 3 }));
      expect(await decided(1, 'hold')).toEqual({ slot: null });
      expect(await decided(2, 'partial')).toEqual({ slot: 1 });
      expect(await decided(4, 'exclude')).toEqual({ slot: null });
      expect(await decided(5, 'hold')).toEqual({ slot: null });
      await failed(3);
      for (const n of [1, 2, 3, 4, 5]) expect(await addAppeal(db, appeal(n), NOW)).toBe('queued');
      expect(await requeuedBeforeTheRule(3, plus(1))).toEqual({ slot: 2 });
      const cases: [number, 'reversed' | 'upheld', 'full' | 'partial' | null][] = [
        [9, 'upheld', null],
        [1, 'reversed', null],
        [2, 'reversed', 'partial'],
        [1, 'upheld', 'full'],
        [3, 'reversed', 'full'],
        [2, 'reversed', 'full'],
        [1, 'reversed', 'partial'],
        [4, 'reversed', 'full'],
        [5, 'upheld', null],
        [1, 'upheld', null],
        [4, 'upheld', null],
      ];
      const tables = async () => JSON.stringify([await db.query('SELECT * FROM asks ORDER BY wallet'), await db.query('SELECT * FROM appeals ORDER BY wallet')]);
      const seen: string[] = [];
      for (const [n, outcome, newAction] of cases) {
        const before = await tables();
        const preview = await settleRefusal(db, { campaignId: CAMPAIGN, wallet: wallet(n), outcome, newAction });
        expect(await tables()).toBe(before);
        const settled = await settleAppeal(db, { campaignId: CAMPAIGN, wallet: wallet(n), outcome, newAction, ownerNote: null }, plus(5));
        expect(preview).toEqual('refused' in settled ? { refused: settled.refused, slot: null } : { refused: null, slot: settled.slot });
        seen.push('refused' in settled ? settled.refused : `slot ${settled.slot}`);
      }
      expect(seen).toEqual([
        'no appeal from this wallet',
        'a reversal needs a new action, full or partial',
        'the new action must be more generous than the appealed one',
        'an upheld appeal takes no new action',
        'the ask changed after the appeal was filed',
        'slot 1',
        'slot 3',
        'slot null',
        'slot null',
        'the appeal is already settled',
        'the appeal is already settled',
      ]);
      await expect(settleRefusal(db, { campaignId: CAMPAIGN, wallet: wallet(1), outcome: 'maybe' as 'upheld', newAction: null })).rejects.toThrow(StoreError);
      await expect(settleRefusal(db, { campaignId: CAMPAIGN, wallet: wallet(1), outcome: 'reversed', newAction: 'hold' as 'full' })).rejects.toThrow(StoreError);
      expect(await settleRefusal(db, { campaignId: 'not a campaign!', wallet: wallet(1), outcome: 'upheld', newAction: null })).toEqual({ refused: 'no appeal from this wallet', slot: null });
    });

    it('C11, C44, C27: a reversal approves the ask, takes the next slot while one is left, and slotHolders lists it once', async () => {
      await createCampaign(db, terms({ maxSlots: 2 }));
      expect(await decided(1, 'full')).toEqual({ slot: 1 });
      expect(await decided(2, 'hold')).toEqual({ slot: null });
      expect(await decided(3, 'exclude')).toEqual({ slot: null });
      await failed(4);
      for (const n of [2, 3, 4]) expect(await addAppeal(db, appeal(n), NOW)).toBe('queued');
      const settle = (n: number, newAction: 'full' | 'partial') =>
        settleAppeal(db, { campaignId: CAMPAIGN, wallet: wallet(n), outcome: 'reversed', newAction, ownerNote: OWNER_NOTE }, plus(10));

      expect(await settle(2, 'partial')).toEqual({ slot: 2 });
      expect(await askRow(2)).toMatchObject({ status: 'decided', action: 'partial', share_bps: 5000, rule: 'A9', slot: 2, reversed_by_appeal: true });
      expect(await slotHolders(db, CAMPAIGN)).toEqual([
        { wallet: wallet(1), action: 'full', shareBps: 10_000, slot: 1 },
        { wallet: wallet(2), action: 'partial', shareBps: 5_000, slot: 2 },
      ]);

      // No slot left: the reversal stands as an approval, with no slot and nothing to pay.
      expect(await settle(3, 'full')).toEqual({ slot: null });
      expect(await askRow(3)).toMatchObject({ action: 'full', share_bps: 10_000, rule: 'A3', slot: null, reversed_by_appeal: true });
      // A failed ask reversed becomes decided, by the owner, with no facts read.
      expect(await settle(4, 'full')).toEqual({ slot: null });
      expect(await askRow(4)).toMatchObject({ status: 'decided', action: 'full', rule: 'A1', slot: null, reversed_by_appeal: true });
      expect((await slotHolders(db, CAMPAIGN)).map((holder) => holder.wallet)).toEqual([wallet(1), wallet(2)]);
      expect(await getAsk(db, CAMPAIGN, wallet(2))).toMatchObject({
        action: 'partial',
        shareBps: 5000,
        slot: 2,
        appeal: { outcome: 'reversed', newAction: 'partial', settledAt: plus(10) },
      });
      expect(await counts(db, CAMPAIGN)).toMatchObject({ slotsTaken: 2, slotsLeft: 0, appeals: { filed: 3, checked: 0, block: 0, reversed: 3 } });
    });

    it('C44: a partial raised to full keeps its slot, and a reversal on a free campaign takes the next number', async () => {
      await createCampaign(db, terms({ maxSlots: 3 }));
      expect(await decided(1, 'partial')).toEqual({ slot: 1 });
      expect(await decided(2, 'full')).toEqual({ slot: 2 });
      expect(await decided(3, 'hold')).toEqual({ slot: null });
      for (const n of [1, 3]) expect(await addAppeal(db, appeal(n), NOW)).toBe('queued');
      expect(
        await settleAppeal(db, { campaignId: CAMPAIGN, wallet: wallet(1), outcome: 'reversed', newAction: 'full', ownerNote: null }, plus(1)),
      ).toEqual({ slot: 1 });
      expect(
        await settleAppeal(db, { campaignId: CAMPAIGN, wallet: wallet(3), outcome: 'reversed', newAction: 'full', ownerNote: null }, plus(2)),
      ).toEqual({ slot: 3 });
      expect(await slotHolders(db, CAMPAIGN)).toEqual([
        { wallet: wallet(1), action: 'full', shareBps: 10_000, slot: 1 },
        { wallet: wallet(2), action: 'full', shareBps: 10_000, slot: 2 },
        { wallet: wallet(3), action: 'full', shareBps: 10_000, slot: 3 },
      ]);
      expect(await askRow(1)).toMatchObject({ action: 'full', share_bps: 10_000, slot: 1, reversed_by_appeal: true });
    });

    it('C34, C40: the public views hold only the public appeal fields, never the text, hash, signature, note or record', async () => {
      await createCampaign(db, terms());
      expect(await decided(1, 'hold', { record: { ...RECORD, secretMarker: 'record-only-marker' } })).toEqual({ slot: null });
      expect(await decided(2, 'hold')).toEqual({ slot: null });
      expect(await addAppeal(db, appeal(1), NOW)).toBe('queued');
      expect(
        await settleAppeal(db, { campaignId: CAMPAIGN, wallet: wallet(1), outcome: 'upheld', newAction: null, ownerNote: OWNER_NOTE }, plus(1)),
      ).toEqual({ slot: null });
      const views = [await getAppeal(db, CAMPAIGN, wallet(1)), (await getAsk(db, CAMPAIGN, wallet(1)))?.appeal, (await board(db, CAMPAIGN, 10)).find((row) => row.wallet === wallet(1))?.appeal];
      for (const view of views) expect(Object.keys(view ?? {}).sort()).toEqual(PUBLIC_APPEAL_KEYS);
      expect((await getAsk(db, CAMPAIGN, wallet(2)))?.appeal).toBeNull();
      expect((await board(db, CAMPAIGN, 10)).find((row) => row.wallet === wallet(2))?.appeal).toBeNull();
      const everything = JSON.stringify([...views, await getAsk(db, CAMPAIGN, wallet(1)), await board(db, CAMPAIGN, 10), await counts(db, CAMPAIGN)]);
      for (const hidden of [TEXT, appealTextHash(TEXT), APPEAL_SIGNATURE.slice(2), OWNER_NOTE, 'record-only-marker', SIGNATURE.slice(2)]) {
        expect(everything).not.toContain(hidden);
      }
      expect((await ownerAppeals(db, CAMPAIGN))[0]).toMatchObject({ text: TEXT, ownerNote: OWNER_NOTE, outcome: 'upheld' });
      expect(JSON.stringify(await ownerAppeals(db, CAMPAIGN))).not.toContain(APPEAL_SIGNATURE.slice(2));
    });

    it('decideAsk keeps a record of up to 16 KB as private, refuses a larger one or a non-object, and today\'s callers need none', async () => {
      await createCampaign(db, terms());
      await expect(decided(1, 'hold', { record: { big: 'x'.repeat(16_384) } })).rejects.toThrow(StoreError);
      await expect(decided(2, 'hold', { record: [] as unknown as Record<string, unknown> })).rejects.toThrow(StoreError);
      expect(await decided(3, 'hold', { record: { fits: 'x'.repeat(16_000) } })).toEqual({ slot: null });
      expect(await decided(4, 'hold')).toEqual({ slot: null });
      const [stored] = await db.query<{ has: boolean }>('SELECT record IS NOT NULL AS has FROM asks WHERE wallet = $1', [wallet(3)]);
      expect(stored?.has).toBe(true);
      expect(JSON.stringify(await getAsk(db, CAMPAIGN, wallet(3)))).not.toContain('xxxxxxxx');
    });
  });
}

// The functions whose answers anyone may see. None may name a private appeal column or the ask's record (C40).
describe('C40 public query scan', () => {
  it("no public read selects text, text_hash, signature, owner_note, record, Reppo's verdict values, check_note or the submit mark", async () => {
    const sources = {
      'appeals.ts': await readFile(new URL('../src/appeals.ts', import.meta.url), 'utf8'),
      'campaigns.ts': await readFile(new URL('../src/campaigns.ts', import.meta.url), 'utf8'),
    };
    const publicReads: [keyof typeof sources, string][] = [
      ['appeals.ts', 'getAppeal'],
      ['campaigns.ts', 'getAsk'],
      ['campaigns.ts', 'board'],
      ['campaigns.ts', 'counts'],
    ];
    const privateColumn = /(?<![:\w])(text|text_hash|signature|owner_note|record|reppo_score|reppo_decision|reppo_confidence|check_note|submit_started_at)(?![\w(])|\*/;
    for (const [file, name] of publicReads) {
      const source = sources[file];
      const start = source.indexOf(`export async function ${name}(`);
      expect({ name, found: start >= 0 }).toEqual({ name, found: true });
      const end = source.indexOf('\nexport ', start + 1);
      const body = source.slice(start, end === -1 ? undefined : end);
      const queries = [...body.matchAll(/`([^`]*)`/g)].map((match) => match[1] ?? '');
      expect({ name, queries: queries.length > 0 }).toEqual({ name, queries: true });
      for (const query of queries) expect({ name, privateColumn: privateColumn.exec(query)?.[0] ?? null }).toEqual({ name, privateColumn: null });
    }
  });
});

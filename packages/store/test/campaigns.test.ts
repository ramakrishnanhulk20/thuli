// Not covered here: truly parallel connections. PGlite runs one statement at a time, so the calls started together
// with Promise.all interleave transaction by transaction on one connection; they prove each slot, ask and list is
// decided inside one transaction under the campaign's lock or inside one statement, not that the advisory lock and
// SKIP LOCKED hold between two connections. Set STORE_TEST_URL to a throwaway Postgres database to run every test
// below there too, with ten connections; that run empties every Thuli table in it. Without it, that run is skipped.
// An ask's signature is stored as given: checking it is core's job. The worker that screens, posts and relays, the
// API that serves these rows, and the vault itself are not here.
import { AddressError, parseAddress, type Outcome } from '@thuli/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  activeList,
  addAsk,
  addListVersion,
  ASK_BACKLOG_CAP,
  askLifetimeCap,
  board,
  confirmedPayouts,
  CAMPAIGN_SCREENINGS_DAY_COUNTER,
  counts,
  createCampaign,
  decideAsk,
  funderLinks,
  getAsk,
  getCampaign,
  latestList,
  listText,
  listVersions,
  markListActive,
  markListCancelled,
  markListPosted,
  markListResent,
  markListSending,
  markListUnsent,
  requeueFailedAsk,
  markRelay,
  MAX_PAYOUT_WALLETS,
  MAX_FUNDER_LINKS,
  MAX_RELAY_ATTEMPTS,
  openCampaigns,
  queueRelays,
  releaseAsk,
  slotHolders,
  takeAsk,
  takeRelay,
  type AskDecision,
  type AskFactsInput,
  type CampaignInput,
} from '../src/campaigns.ts';
import { connectPostgres, openMemoryDb, StoreError, type Db } from '../src/db.ts';
import { dayCount } from '../src/limits.ts';
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
const VAULT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WRONG_CHECKSUM = '0x833589FCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SIGNATURE = `0x${'ab'.repeat(65)}`;
const OTHER_SIGNATURE = `0x${'cd'.repeat(65)}`;
const HASH = `0x${'1f'.repeat(32)}`;
const PUBLIC_KEYS = [
  'action',
  'appeal',
  'askedAt',
  'campaignId',
  'citedTxs',
  'decidedAt',
  'facts',
  'notChecked',
  'reason',
  'rule',
  'servRequestId',
  'shareBps',
  'slot',
  'status',
  'wallet',
];
// The same hostile strings injection.test.ts stores (C43).
const UNICODE_RUN = ['a', 'é', 'ß', 'Ж', '漢', '🙂', 'ש', 'ا', '́', '€'].join('').repeat(15);
const FIXTURES = ["'; drop table payment_claims; --", '%00', UNICODE_RUN, '$1'];

function plus(seconds: number, from: Date = NOW): Date {
  return new Date(from.getTime() + seconds * 1000);
}

function wallet(n: number): string {
  return parseAddress(`0x${'abcdef'.repeat(6)}${n.toString(16).padStart(4, '0')}`);
}

function root(n: number): string {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

const FUNDER = wallet(7000);
const FACTS: AskFactsInput = {
  ageDays: 400,
  txCount: 120,
  accountType: 'eoa',
  funder: { address: FUNDER, kind: 'wallet', fanout: 3, hops: 1 },
  burstWallets: null,
  groupSize: null,
  missing: ['sharedDepositAddress'],
};

function terms(overrides: Partial<CampaignInput> = {}): CampaignInput {
  return {
    id: CAMPAIGN,
    name: 'Thuli demo',
    chain: 84532,
    vault: VAULT,
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

function decision(who: string, action: Outcome, overrides: Partial<AskDecision> = {}): AskDecision {
  return {
    campaignId: CAMPAIGN,
    wallet: who,
    action,
    shareBps: { full: 10_000, partial: 5_000, hold: 0, exclude: 0 }[action],
    rule: action === 'exclude' ? 'A3' : 'A9',
    reason: 'No shared funder, deposit or sweep links this wallet to another.',
    citedTxs: [HASH],
    notChecked: ['sharedDepositAddress', 'claimPaidToOtherAddress'],
    facts: FACTS,
    servRequestId: 'run-1',
    ...overrides,
  };
}

for (const { name, open } of TARGETS) {
  describe.skipIf(open === undefined)(`campaigns on ${name}`, () => {
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

    async function ask(n: number, at: Date = NOW, campaignId: string = CAMPAIGN): Promise<string> {
      return addAsk(db, { campaignId, wallet: wallet(n), signedAt: 1_800_000_000, signature: SIGNATURE }, at);
    }

    async function screenAll(howMany: number, at: Date = NOW): Promise<void> {
      for (let index = 0; index < howMany; index += 1) expect(await takeAsk(db, at, 60, 3)).not.toBeNull();
    }

    async function row(n: number): Promise<Record<string, unknown> | undefined> {
      const [found] = await db.query(
        `SELECT status, attempts, lease_until, action, share_bps, rule, reason, cited_txs, not_checked, facts, serv_request_id,
                decided_at, slot, signed_at::text AS signed_at, signature
           FROM asks WHERE campaign_id = $1 AND wallet = $2`,
        [CAMPAIGN, wallet(n)],
      );
      return found;
    }

    async function activeVersion(version: number, at: Date = NOW): Promise<void> {
      expect(await addListVersion(db, { campaignId: CAMPAIGN, root: root(version), publishedList: '[]', declaredTotal: '0' }, at)).toBe(
        version,
      );
      expect(await markListPosted(db, CAMPAIGN, version, { postTx: HASH, claimableAt: 1_800_000_000 })).toBe(true);
      expect(await markListActive(db, CAMPAIGN, version)).toBe(true);
    }

    it('C44: with max_slots 3, five approved asks decided together get slots 1, 2 and 3 and two get none', async () => {
      await createCampaign(db, terms({ maxSlots: 3 }));
      for (let n = 1; n <= 7; n += 1) expect(await ask(n)).toBe('queued');
      await screenAll(7);
      // The hold and the exclude are decided first, while every slot is free, and still take none.
      expect(await decideAsk(db, decision(wallet(6), 'hold'), NOW)).toEqual({ slot: null });
      expect(await decideAsk(db, decision(wallet(7), 'exclude'), NOW)).toEqual({ slot: null });
      const actions: Outcome[] = ['full', 'partial', 'full', 'partial', 'full'];
      const results = await Promise.all(actions.map((action, index) => decideAsk(db, decision(wallet(index + 1), action), plus(1))));
      const slots = results.map((result) => result?.slot ?? null);
      expect(slots.filter((slot) => slot !== null).sort()).toEqual([1, 2, 3]);
      expect(slots.filter((slot) => slot === null)).toHaveLength(2);

      const holders = await slotHolders(db, CAMPAIGN);
      expect(holders.map((holder) => holder.slot)).toEqual([1, 2, 3]);
      for (const holder of holders) {
        const index = slots.indexOf(holder.slot);
        expect(holder).toEqual({ wallet: wallet(index + 1), action: actions[index], shareBps: actions[index] === 'full' ? 10_000 : 5_000, slot: holder.slot });
      }
      expect((await getAsk(db, CAMPAIGN, wallet(6)))?.slot).toBeNull();
      expect((await getAsk(db, CAMPAIGN, wallet(7)))?.slot).toBeNull();
      expect(await counts(db, CAMPAIGN)).toEqual({
        asked: 7,
        queued: 0,
        decided: 7,
        held: 1,
        slotsTaken: 3,
        slotsLeft: 0,
        asksLeft: 993,
        appeals: { filed: 0, checked: 0, block: 0, reversed: 0 },
      });

      // A full campaign takes no new ask at all (C24), and nothing moves a slot once given.
      expect(await ask(8)).toBe('full');
      expect(await decideAsk(db, decision(holders[0]?.wallet as string, 'hold'), plus(3))).toBeNull();
      expect(await releaseAsk(db, CAMPAIGN, holders[0]?.wallet as string, plus(3), 3)).toBeNull();
      expect((await slotHolders(db, CAMPAIGN)).map((holder) => holder.wallet)).toEqual(holders.map((holder) => holder.wallet));
      const unslotted = wallet(slots.indexOf(null) + 1);
      await expect(db.query('UPDATE asks SET slot = 1 WHERE campaign_id = $1 AND wallet = $2', [CAMPAIGN, unslotted])).rejects.toThrow(
        StoreError,
      );
      await expect(db.query('UPDATE asks SET slot = 4 WHERE campaign_id = $1 AND wallet = $2', [CAMPAIGN, wallet(6)])).rejects.toThrow(
        StoreError,
      );
    });

    it('C1, C42: the same wallet in two spellings is one ask, and 20 asks started together give one queued', async () => {
      await createCampaign(db, terms());
      const first = { campaignId: CAMPAIGN, wallet: wallet(1).toLowerCase(), signedAt: 1_800_000_000, signature: SIGNATURE };
      expect(await addAsk(db, first, NOW)).toBe('queued');
      expect(await addAsk(db, { ...first, wallet: wallet(1), signedAt: 1_800_000_500, signature: OTHER_SIGNATURE }, plus(5))).toBe(
        'exists',
      );
      expect(await row(1)).toMatchObject({ status: 'queued', signed_at: '1800000000', signature: SIGNATURE, attempts: 0 });
      expect((await getAsk(db, CAMPAIGN, wallet(1).toUpperCase().replace('0X', '0x')))?.wallet).toBe(wallet(1));

      const spellings = [wallet(2), wallet(2).toLowerCase(), ` ${wallet(2)}\r\n`];
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          addAsk(db, { ...first, wallet: spellings[index % 3] as string, signedAt: 1_800_000_000 + index }, NOW),
        ),
      );
      expect(results.filter((result) => result === 'queued')).toHaveLength(1);
      expect(results.filter((result) => result === 'exists')).toHaveLength(19);
      const [stored] = await db.query<{ asks: number }>('SELECT count(*)::int AS asks FROM asks WHERE wallet = $1', [wallet(2)]);
      expect(stored?.asks).toBe(1);
      await expect(addAsk(db, { ...first, wallet: WRONG_CHECKSUM }, NOW)).rejects.toThrow(AddressError);
      await expect(addAsk(db, { ...first, wallet: wallet(3), signature: '0x1234' }, NOW)).rejects.toThrow(StoreError);
      await expect(addAsk(db, { ...first, wallet: wallet(3), signedAt: 1.5 }, NOW)).rejects.toThrow(StoreError);
    });

    it('takeAsk never hands one ask to two workers, and takes an expired lease again with one more attempt', async () => {
      await createCampaign(db, terms());
      for (let n = 1; n <= 4; n += 1) expect(await ask(n, plus(n))).toBe('queued');
      const taken = await Promise.all(Array.from({ length: 10 }, () => takeAsk(db, plus(10), 60, 3)));
      const asks = taken.filter((item) => item !== null);
      expect(asks).toHaveLength(4);
      expect(new Set(asks.map((item) => item.wallet))).toEqual(new Set([1, 2, 3, 4].map(wallet)));
      expect(asks.every((item) => item.attempts === 1 && item.leaseUntil.getTime() === plus(70).getTime())).toBe(true);
      expect(await takeAsk(db, plus(69.999), 60, 3)).toBeNull();

      const again = await takeAsk(db, plus(70), 60, 3);
      expect(again).toEqual({ campaignId: CAMPAIGN, wallet: wallet(1), askedAt: plus(1), attempts: 2, leaseUntil: plus(130) });
      expect(await row(1)).toMatchObject({ status: 'screening', attempts: 2 });
      await expect(takeAsk(db, NOW, 0, 3)).rejects.toThrow(StoreError);
      await expect(takeAsk(db, NOW, 60, 0)).rejects.toThrow(StoreError);
    });

    it('takeAsk never hands out an ask at maxAttempts: it ends failed with the A1 hold and the next ask is handed out', async () => {
      await createCampaign(db, terms());
      expect(await ask(1)).toBe('queued');
      // The worker takes it three times and dies each time, so releaseAsk is never called.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect((await takeAsk(db, plus((attempt - 1) * 60), 60, 3))?.attempts).toBe(attempt);
      }
      expect(await ask(2, plus(130))).toBe('queued');
      expect(await takeAsk(db, plus(180), 60, 3)).toMatchObject({ wallet: wallet(2), attempts: 1 });
      expect(await getAsk(db, CAMPAIGN, wallet(1))).toMatchObject({
        status: 'failed',
        action: 'hold',
        shareBps: 0,
        rule: 'A1',
        reason: 'Held for review: the screening could not finish.',
        citedTxs: [],
        notChecked: [],
        facts: null,
        servRequestId: null,
        decidedAt: plus(180),
        slot: null,
      });
      expect(await row(1)).toMatchObject({ attempts: 3, lease_until: null });

      // A queued ask already at the limit, here from a release that allowed more attempts, ends the same way.
      expect(await releaseAsk(db, CAMPAIGN, wallet(2), plus(181), 10)).toBe('queued');
      expect(await takeAsk(db, plus(182), 60, 1)).toBeNull();
      expect(await getAsk(db, CAMPAIGN, wallet(2))).toMatchObject({ status: 'failed', action: 'hold', rule: 'A1', decidedAt: plus(182) });
    });

    it('C41: an ask released with a retry delay waits that long, and a ready ask is taken meanwhile', async () => {
      await createCampaign(db, terms());
      expect(await ask(1, plus(1))).toBe('queued');
      expect(await ask(2, plus(2))).toBe('queued');
      expect(await takeAsk(db, plus(10), 60, 3)).toMatchObject({ wallet: wallet(1), attempts: 1 });
      for (const bad of [-1, 1.5, 86_401, Number.NaN]) {
        await expect(releaseAsk(db, CAMPAIGN, wallet(1), plus(10), 3, bad)).rejects.toThrow(StoreError);
      }
      expect(await row(1)).toMatchObject({ status: 'screening', attempts: 1 });
      expect(await releaseAsk(db, CAMPAIGN, wallet(1), plus(10), 3, 30)).toBe('queued');
      expect((await getAsk(db, CAMPAIGN, wallet(1)))?.status).toBe('queued');
      // Ask 1 is the older one, but it waits; ask 2 is ready, so it is taken in between.
      expect(await takeAsk(db, plus(11), 60, 3)).toMatchObject({ wallet: wallet(2), attempts: 1 });
      expect(await decideAsk(db, decision(wallet(2), 'hold'), plus(12))).toEqual({ slot: null });
      expect(await takeAsk(db, plus(39), 60, 3)).toBeNull();
      expect(await takeAsk(db, plus(40), 60, 3)).toMatchObject({ wallet: wallet(1), attempts: 2 });
      expect(await releaseAsk(db, CAMPAIGN, wallet(1), plus(41), 3, 86_400)).toBe('queued');
      expect(await takeAsk(db, plus(41 + 86_399), 600, 3)).toBeNull();
      // Out of attempts, a waiting ask still ends as the A1 hold, never approved (C11).
      expect(await takeAsk(db, plus(41 + 86_400), 60, 3)).toMatchObject({ wallet: wallet(1), attempts: 3 });
      expect(await releaseAsk(db, CAMPAIGN, wallet(1), plus(90_000), 3, 30)).toBe('failed');
      expect(await getAsk(db, CAMPAIGN, wallet(1))).toMatchObject({ status: 'failed', action: 'hold', rule: 'A1', slot: null });
    });

    it('C11: requeueFailedAsk screens a failed ask again from the start, and never touches a decided, waiting or slotted ask', async () => {
      await createCampaign(db, terms());
      for (const n of [1, 2, 3]) expect(await ask(n, plus(n))).toBe('queued');
      expect(await takeAsk(db, plus(10), 60, 3)).toMatchObject({ wallet: wallet(1) });
      expect(await releaseAsk(db, CAMPAIGN, wallet(1), plus(10), 1)).toBe('failed');
      expect(await takeAsk(db, plus(11), 60, 3)).toMatchObject({ wallet: wallet(2) });
      expect(await decideAsk(db, decision(wallet(2), 'hold'), plus(11))).toEqual({ slot: null });
      expect(await takeAsk(db, plus(12), 60, 3)).toMatchObject({ wallet: wallet(3) });
      expect(await decideAsk(db, decision(wallet(3), 'full'), plus(12))).toEqual({ slot: 1 });
      expect(await ask(5, plus(13))).toBe('queued');
      expect(await takeAsk(db, plus(14), 60, 3)).toMatchObject({ wallet: wallet(5) });
      expect(await ask(4, plus(15))).toBe('queued');

      const untouched = await Promise.all([2, 3, 4, 5].map((n) => row(n)));
      for (const n of [2, 3, 4, 5]) expect(await requeueFailedAsk(db, CAMPAIGN, wallet(n), plus(100))).toEqual({ requeued: false, cause: 'no failed ask from this wallet' });
      expect(await Promise.all([2, 3, 4, 5].map((n) => row(n)))).toEqual(untouched);
      expect(await requeueFailedAsk(db, CAMPAIGN, wallet(9), plus(100))).toEqual({ requeued: false, cause: 'no failed ask from this wallet' });
      expect(await requeueFailedAsk(db, 'missing', wallet(1), plus(100))).toEqual({ requeued: false, cause: 'no failed ask from this wallet' });
      await expect(requeueFailedAsk(db, CAMPAIGN, wallet(1), new Date(Number.NaN))).rejects.toThrow(StoreError);

      const signed = await row(1);
      expect(await requeueFailedAsk(db, CAMPAIGN, wallet(1).toLowerCase(), plus(100))).toEqual({ requeued: true });
      expect(await getAsk(db, CAMPAIGN, wallet(1))).toMatchObject({
        status: 'queued',
        action: null,
        shareBps: null,
        rule: null,
        reason: null,
        citedTxs: null,
        notChecked: null,
        facts: null,
        servRequestId: null,
        decidedAt: null,
        slot: null,
      });
      expect(await row(1)).toMatchObject({ attempts: 0, lease_until: null, signed_at: signed?.signed_at, signature: signed?.signature });
      expect(await requeueFailedAsk(db, CAMPAIGN, wallet(1), plus(101))).toEqual({ requeued: false, cause: 'no failed ask from this wallet' });
      // It waits its turn by when it first asked, so it is the next ask handed out.
      expect(await takeAsk(db, plus(102), 60, 3)).toMatchObject({ wallet: wallet(1), attempts: 1 });
    });

    it('releaseAsk queues again below the limit and at the limit ends failed with the A1 hold', async () => {
      await createCampaign(db, terms());
      expect(await ask(1)).toBe('queued');
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        expect((await takeAsk(db, plus(attempt), 60, 3))?.attempts).toBe(attempt);
        expect(await releaseAsk(db, CAMPAIGN, wallet(1).toLowerCase(), plus(attempt), 3)).toBe('queued');
        expect(await row(1)).toMatchObject({ status: 'queued', lease_until: null, action: null, decided_at: null });
      }
      expect((await takeAsk(db, plus(3), 60, 3))?.attempts).toBe(3);
      expect(await releaseAsk(db, CAMPAIGN, wallet(1), plus(4), 3)).toBe('failed');
      expect(await getAsk(db, CAMPAIGN, wallet(1))).toEqual({
        campaignId: CAMPAIGN,
        wallet: wallet(1),
        askedAt: NOW,
        status: 'failed',
        action: 'hold',
        shareBps: 0,
        rule: 'A1',
        reason: 'Held for review: the screening could not finish.',
        citedTxs: [],
        notChecked: [],
        facts: null,
        servRequestId: null,
        decidedAt: plus(4),
        slot: null,
        appeal: null,
      });
      expect(await takeAsk(db, plus(1_000), 60, 3)).toBeNull();
      expect(await releaseAsk(db, CAMPAIGN, wallet(1), plus(5), 3)).toBeNull();
    });

    it('decideAsk acts only on a screening ask: queued, decided and failed asks are left alone and give null', async () => {
      await createCampaign(db, terms());
      expect(await ask(1)).toBe('queued');
      const queued = await row(1);
      expect(await decideAsk(db, decision(wallet(1), 'full'), NOW)).toBeNull();
      expect(await row(1)).toEqual(queued);

      await screenAll(1);
      expect(await decideAsk(db, decision(wallet(1), 'partial'), NOW)).toEqual({ slot: 1 });
      const decided = await row(1);
      expect(await decideAsk(db, decision(wallet(1), 'full', { reason: 'A second reason.' }), plus(1))).toBeNull();
      expect(await row(1)).toEqual(decided);

      expect(await ask(2)).toBe('queued');
      await screenAll(1);
      expect(await releaseAsk(db, CAMPAIGN, wallet(2), NOW, 1)).toBe('failed');
      const failed = await row(2);
      expect(await decideAsk(db, decision(wallet(2), 'full'), plus(1))).toBeNull();
      expect(await row(2)).toEqual(failed);
      expect(await decideAsk(db, decision(wallet(3), 'full'), plus(1))).toBeNull();
      expect(await decideAsk(db, decision(wallet(1), 'full', { campaignId: 'other' }), plus(1))).toBeNull();
    });

    it('C13, C33: decideAsk refuses a reason with a link or markup, a bad hash, a wrong share or rule, and writes nothing', async () => {
      await createCampaign(db, terms());
      expect(await ask(1)).toBe('queued');
      await screenAll(1);
      const before = await row(1);
      const refused: Partial<AskDecision>[] = [
        { reason: 'See https://evil.example for proof.' },
        { reason: '<img src=x onerror=alert(1)>' },
        { reason: '[claim](evil.example)' },
        { reason: 'Hidden\u202eright to left' },
        { reason: 'x'.repeat(401) },
        { reason: '' },
        { reason: 'Broken \uD800 text' },
        { citedTxs: [HASH.toUpperCase().replace('0X', '0x')] },
        { citedTxs: [HASH.slice(0, 40)] },
        { citedTxs: Array.from({ length: 257 }, () => HASH) },
        { notChecked: ['x'.repeat(65)] },
        { notChecked: Array.from({ length: 17 }, () => 'group') },
        { shareBps: 9_999 },
        { rule: 'Z9' },
        { servRequestId: 'run 1' },
      ];
      for (const overrides of refused) {
        await expect(decideAsk(db, decision(wallet(1), 'partial', overrides), NOW)).rejects.toThrow(StoreError);
      }
      await expect(decideAsk(db, decision(wallet(1), 'full', { shareBps: 5_000 }), NOW)).rejects.toThrow(StoreError);
      await expect(decideAsk(db, decision(wallet(1), 'hold', { shareBps: 10_000 }), NOW)).rejects.toThrow(StoreError);
      await expect(decideAsk(db, decision(wallet(1), 'maybe' as Outcome), NOW)).rejects.toThrow(StoreError);
      expect(await row(1)).toEqual(before);
      expect(await decideAsk(db, decision(wallet(1), 'partial', { reason: 'x'.repeat(400), servRequestId: null }), NOW)).toEqual({
        slot: 1,
      });
    });

    it('decideAsk keeps the facts a decision rested on in one exact shape, and funderLinks lists funded asks oldest first', async () => {
      await createCampaign(db, terms());
      for (let n = 1; n <= 4; n += 1) expect(await ask(n, plus(n))).toBe('queued');
      await screenAll(4, plus(5));
      const before = await row(1);
      const funder = FACTS.funder as NonNullable<AskFactsInput['funder']>;
      const refused: unknown[] = [
        { ...FACTS, extra: 1 },
        Object.fromEntries(Object.entries(FACTS).filter(([key]) => key !== 'groupSize')),
        { ...FACTS, funder: { ...funder, address: WRONG_CHECKSUM } },
        { ...FACTS, funder: { ...funder, address: '0x1234' } },
        { ...FACTS, funder: { ...funder, label: 'Binance 14' } },
        { ...FACTS, funder: { ...funder, hops: null } },
        { ...FACTS, missing: ['x'.repeat(65)] },
        { ...FACTS, missing: Array.from({ length: 17 }, () => 'group') },
        { ...FACTS, accountType: 'e'.repeat(33) },
        { ...FACTS, accountType: '<b>eoa</b>' },
        { ...FACTS, ageDays: -1 },
        { ...FACTS, txCount: 1.5 },
        null,
      ];
      for (const facts of refused) {
        await expect(decideAsk(db, decision(wallet(1), 'full', { facts: facts as AskFactsInput }), NOW)).rejects.toThrow(StoreError);
      }
      expect(await row(1)).toEqual(before);

      const lowered = { ...FACTS, funder: { ...funder, address: FUNDER.toLowerCase() } };
      expect(await decideAsk(db, decision(wallet(1), 'full', { facts: lowered }), plus(10))).toEqual({ slot: 1 });
      expect(await decideAsk(db, decision(wallet(2), 'hold', { facts: { ...FACTS, funder: null } }), plus(20))).toEqual({ slot: null });
      expect(await decideAsk(db, decision(wallet(3), 'partial'), plus(30))).toEqual({ slot: 2 });
      expect(await releaseAsk(db, CAMPAIGN, wallet(4), plus(40), 1)).toBe('failed');
      expect((await getAsk(db, CAMPAIGN, wallet(1)))?.facts).toEqual({ ...FACTS, funder: { ...funder, address: FUNDER }, chain: 'ethereum' });
      expect((await getAsk(db, CAMPAIGN, wallet(2)))?.facts?.funder).toBeNull();
      expect((await getAsk(db, CAMPAIGN, wallet(4)))?.facts).toBeNull();
      const stored = await db.query<{ address: string }>(
        "SELECT DISTINCT facts -> 'funder' ->> 'address' AS address FROM asks WHERE facts -> 'funder' ->> 'address' IS NOT NULL",
      );
      expect(stored).toEqual([{ address: FUNDER }]);
      expect(await funderLinks(db, CAMPAIGN)).toEqual([
        { wallet: wallet(1), funderAddress: FUNDER, funderKind: 'wallet', decidedAt: plus(10) },
        { wallet: wallet(3), funderAddress: FUNDER, funderKind: 'wallet', decidedAt: plus(30) },
      ]);
      expect(await funderLinks(db, 'missing')).toEqual([]);
    });

    it('the facts carry the screened chain: given, left out, missing from an older row, refused when unknown in or out', async () => {
      await createCampaign(db, terms());
      for (let n = 1; n <= 4; n += 1) expect(await ask(n, plus(n))).toBe('queued');
      await screenAll(4, plus(5));
      const before = await row(1);
      for (const chain of ['solana', 'Base', '', null, 8453]) {
        await expect(decideAsk(db, decision(wallet(1), 'full', { facts: { ...FACTS, chain } as AskFactsInput }), NOW)).rejects.toThrow(StoreError);
      }
      expect(await row(1)).toEqual(before);
      expect(await decideAsk(db, decision(wallet(1), 'full', { facts: { ...FACTS, chain: 'base' } }), plus(10))).toEqual({ slot: 1 });
      expect(await decideAsk(db, decision(wallet(2), 'hold', { facts: FACTS }), plus(20))).toEqual({ slot: null });
      expect(await decideAsk(db, decision(wallet(3), 'hold', { facts: { ...FACTS, chain: 'ethereum' } }), plus(30))).toEqual({ slot: null });
      const chains = async () => (await board(db, CAMPAIGN, 10)).map((one) => [one.wallet, one.facts?.chain]);
      expect((await getAsk(db, CAMPAIGN, wallet(1)))?.facts?.chain).toBe('base');
      expect((await getAsk(db, CAMPAIGN, wallet(2)))?.facts?.chain).toBe('ethereum');
      expect(await chains()).toEqual([
        [wallet(3), 'ethereum'],
        [wallet(2), 'ethereum'],
        [wallet(1), 'base'],
      ]);
      const [stored] = await db.query<{ chain: string | null }>("SELECT facts ->> 'chain' AS chain FROM asks WHERE wallet = $1", [wallet(2)]);
      expect(stored?.chain).toBe('ethereum');

      // A row decided before the chain was recorded has no key, and was screened on Ethereum.
      await db.query("UPDATE asks SET facts = facts - 'chain' WHERE wallet = $1", [wallet(1)]);
      expect((await getAsk(db, CAMPAIGN, wallet(1)))?.facts).toEqual({ ...FACTS, funder: { ...FACTS.funder, address: FUNDER }, chain: 'ethereum' });

      // A stored chain Thuli does not know is refused on the way out, like a stored list that is not text.
      await db.query("UPDATE asks SET facts = jsonb_set(facts, '{chain}', '\"solana\"') WHERE wallet = $1", [wallet(3)]);
      await expect(getAsk(db, CAMPAIGN, wallet(3))).rejects.toThrow(StoreError);
      await expect(board(db, CAMPAIGN, 10)).rejects.toThrow(StoreError);
      await db.query("UPDATE asks SET facts = jsonb_set(facts, '{chain}', 'null') WHERE wallet = $1", [wallet(3)]);
      await expect(getAsk(db, CAMPAIGN, wallet(3))).rejects.toThrow(StoreError);
      await db.query("UPDATE asks SET facts = jsonb_set(facts - 'chain', '{missing}', '[1]') WHERE wallet = $1", [wallet(3)]);
      await expect(getAsk(db, CAMPAIGN, wallet(3))).rejects.toThrow(StoreError);
    });

    it('a second createCampaign with different terms throws StoreError, and identical terms are a no-op', async () => {
      expect(await createCampaign(db, terms())).toBe('created');
      const stored = await getCampaign(db, CAMPAIGN);
      const respelled = terms({ vault: VAULT.toLowerCase(), owner: wallet(9002).toLowerCase(), createdAt: plus(100) });
      expect(await createCampaign(db, respelled)).toBe('unchanged');
      for (const change of [
        { rewardPerWallet: '999999' },
        { maxSlots: 21 },
        { agent: wallet(9004) },
        { status: 'closed' as const },
        { closesAt: plus(86_401) },
        { name: 'Thuli demo 2' },
      ]) {
        await expect(createCampaign(db, terms(change))).rejects.toThrow(StoreError);
      }
      expect(await getCampaign(db, CAMPAIGN)).toEqual(stored);
      expect(stored).toMatchObject({ vault: VAULT, owner: wallet(9002), rewardPerWallet: '1000000', maxSlots: 20 });
      expect(await getCampaign(db, 'missing')).toBeNull();
      expect(await getCampaign(db, 'not an id')).toBeNull();
    });

    it("a campaign's settings are checked by core's schema, stored, read back and held to as terms", async () => {
      expect(await createCampaign(db, terms({ id: 'small', settings: { groupMinSize: 3, funderFanoutMin: 4 } }))).toBe('created');
      expect((await getCampaign(db, 'small'))?.settings).toEqual({ groupMinSize: 3, funderFanoutMin: 4 });
      expect(await createCampaign(db, terms({ id: 'small', settings: { funderFanoutMin: 4, groupMinSize: 3 } }))).toBe('unchanged');
      for (const settings of [{ groupMinSize: 4, funderFanoutMin: 4 }, { groupMinSize: 3 }, {}]) {
        await expect(createCampaign(db, terms({ id: 'small', settings }))).rejects.toThrow(StoreError);
      }
      expect(await createCampaign(db, terms({ id: 'plain' }))).toBe('created');
      expect((await getCampaign(db, 'plain'))?.settings).toEqual({});
      expect(await createCampaign(db, terms({ id: 'same-share', settings: { partialShareBps: 5000 } }))).toBe('created');
      for (const settings of [
        { groupSize: 3 },
        { groupMinSize: 1 },
        { allowPartial: 'yes' },
        { partialShareBps: 2500 },
        [],
        null,
      ]) {
        await expect(createCampaign(db, terms({ id: 'refused', settings: settings as CampaignInput['settings'] }))).rejects.toThrow(
          StoreError,
        );
      }
      expect(await getCampaign(db, 'refused')).toBeNull();
      expect((await getCampaign(db, 'small'))?.settings).toEqual({ groupMinSize: 3, funderFanoutMin: 4 });
    });

    it("createCampaign keeps the vault's creation block as a term, and openCampaigns lists only open ones in id order", async () => {
      for (const bad of [0n, -1n, 1n << 63n, 12_345 as unknown as bigint, '12345' as unknown as bigint]) {
        await expect(createCampaign(db, terms({ id: 'bad-block', vaultBlock: bad }))).rejects.toThrow(StoreError);
      }
      expect(await getCampaign(db, 'bad-block')).toBeNull();
      expect(await createCampaign(db, terms({ vaultBlock: 34_210_987n }))).toBe('created');
      expect((await getCampaign(db, CAMPAIGN))?.vaultBlock).toBe(34_210_987n);
      expect(await createCampaign(db, terms({ vaultBlock: 34_210_987n, createdAt: plus(5) }))).toBe('unchanged');
      for (const vaultBlock of [34_210_988n, null, undefined]) {
        await expect(createCampaign(db, terms({ vaultBlock }))).rejects.toThrow(StoreError);
      }
      expect((await getCampaign(db, CAMPAIGN))?.vaultBlock).toBe(34_210_987n);

      expect(await createCampaign(db, terms({ id: 'b-later', opensAt: plus(3_600), closesAt: plus(7_200) }))).toBe('created');
      expect(await createCampaign(db, terms({ id: 'A-ended', opensAt: plus(-7_200), closesAt: plus(-3_600) }))).toBe('created');
      expect(await createCampaign(db, terms({ id: 'c-shut', status: 'closed' }))).toBe('created');
      expect((await getCampaign(db, 'b-later'))?.vaultBlock).toBeNull();
      expect((await openCampaigns(db, NOW)).map((campaign) => campaign.id)).toEqual(['A-ended', 'b-later', CAMPAIGN]);
      expect((await openCampaigns(db, NOW))[2]).toEqual(await getCampaign(db, CAMPAIGN));
      await expect(openCampaigns(db, new Date(Number.NaN))).rejects.toThrow(StoreError);
    });

    it('amounts are plain decimal digits, refused by the code and by the table alike', async () => {
      for (const rewardPerWallet of ['01000000', '1e6', '-1', '1.5', ' 1', '0', '1000001']) {
        await expect(createCampaign(db, terms({ rewardPerWallet }))).rejects.toThrow(StoreError);
      }
      await expect(createCampaign(db, terms({ perWalletCap: (1n << 256n).toString() }))).rejects.toThrow(StoreError);
      await expect(createCampaign(db, terms({ partialShareBps: 10_000 }))).rejects.toThrow(StoreError);
      await expect(createCampaign(db, terms({ closesAt: plus(-3_600) }))).rejects.toThrow(StoreError);
      await expect(createCampaign(db, terms({ name: '<b>demo</b>' }))).rejects.toThrow(StoreError);
      await expect(
        db.query(
          `INSERT INTO campaigns (id, name, chain, vault, token, owner, agent, reward_per_wallet, per_wallet_cap,
                                  partial_share_bps, max_slots, rulebook, settings, status, opens_at, closes_at, created_at)
           VALUES ('raw', 'raw', 1, $1, $1, $1, $1, '1.5', '2', 5000, 3, 2, '{}', 'open', $2::timestamptz, $3::timestamptz, $2::timestamptz)`,
          [VAULT, NOW.toISOString(), plus(60).toISOString()],
        ),
      ).rejects.toThrow(StoreError);
      expect(await db.query('SELECT id FROM campaigns')).toEqual([]);
    });

    it('C24: fifty decided holds leave a three-slot campaign open, because the cap counts the backlog, not history', async () => {
      await createCampaign(db, terms({ maxSlots: 3 }));
      for (let n = 1; n <= 50; n += 1) {
        expect(await ask(n, plus(n))).toBe('queued');
        expect(await takeAsk(db, plus(n), 60, 3)).toMatchObject({ wallet: wallet(n) });
        expect(await decideAsk(db, decision(wallet(n), 'hold'), plus(n))).toEqual({ slot: null });
      }
      expect(await ask(51, plus(60))).toBe('queued');
      expect(await counts(db, CAMPAIGN)).toMatchObject({ asked: 51, slotsLeft: 3, asksLeft: 949 });
    });

    it('C24: an ask is full at 200 undecided asks and queued again once one is decided, and full when no slot is left', async () => {
      expect(ASK_BACKLOG_CAP).toBe(200);
      await createCampaign(db, terms({ maxSlots: 20 }));
      // Two hundred waiting asks from other wallets, asked before anyone below.
      await db.query(
        `INSERT INTO asks (campaign_id, wallet, signed_at, signature, asked_at, status, attempts)
         SELECT 'demo', '0x' || lpad(to_hex(n), 40, '0'), 1, $1, $2::timestamptz, 'queued', 0 FROM generate_series(1, 200) AS n`,
        [SIGNATURE, plus(-100).toISOString()],
      );
      expect(await ask(1)).toBe('full');
      const taken = await takeAsk(db, NOW, 60, 3);
      expect(await decideAsk(db, decision(taken?.wallet as string, 'hold'), NOW)).toEqual({ slot: null });
      expect(await ask(1)).toBe('queued');
      expect(await ask(2)).toBe('full');
      expect(await ask(1)).toBe('exists');
      expect(await counts(db, CAMPAIGN)).toMatchObject({ asked: 201, queued: 200, asksLeft: 1_799 });

      // Every slot taken: no new ask is queued, however short the backlog.
      await createCampaign(db, terms({ id: 'one', maxSlots: 1 }));
      expect(await ask(1, plus(-200), 'one')).toBe('queued');
      await screenAll(1);
      expect(await decideAsk(db, decision(wallet(1), 'full', { campaignId: 'one' }), NOW)).toEqual({ slot: 1 });
      expect(await ask(2, NOW, 'one')).toBe('full');
      expect(await ask(1, NOW, 'one')).toBe('exists');
    });

    it('C24, C41: a campaign takes at most max(1,000, 100 a slot) asks in all, a bound on how far its rows can grow', async () => {
      expect([askLifetimeCap(1), askLifetimeCap(10), askLifetimeCap(30), askLifetimeCap(100_000)]).toEqual([1_000, 1_000, 3_000, 10_000_000]);
      expect(MAX_FUNDER_LINKS).toBe(askLifetimeCap(100_000));
      await createCampaign(db, terms({ maxSlots: 1 }));
      await db.query(
        `INSERT INTO asks (campaign_id, wallet, signed_at, signature, asked_at, status, attempts, action, share_bps, rule, reason,
                           cited_txs, not_checked, facts, decided_at)
         SELECT 'demo', '0x' || lpad(to_hex(n), 40, '0'), 1, $1, $2::timestamptz, 'decided', 1, 'hold', 0, 'A9', 'Held.',
                '[]', '[]', $3::jsonb, $2::timestamptz
           FROM generate_series(1, 999) AS n`,
        [SIGNATURE, plus(-100).toISOString(), JSON.stringify(FACTS)],
      );
      expect(await counts(db, CAMPAIGN)).toMatchObject({ asked: 999, queued: 0, asksLeft: 1 });
      expect(await ask(1)).toBe('queued');
      expect(await counts(db, CAMPAIGN)).toMatchObject({ asked: 1_000, asksLeft: 0 });
      expect(await ask(2)).toBe('full');
      expect(await ask(1)).toBe('exists');
    });

    it('C24: addAsk takes no day count and never answers busy; screenings are counted in a bucket of their own', async () => {
      expect(CAMPAIGN_SCREENINGS_DAY_COUNTER).toBe('campaign-screenings');
      await createCampaign(db, terms());
      await db.query("INSERT INTO day_counts (day, name, count) VALUES ('2026-11-11', 'campaign-asks', 300)");
      for (let n = 1; n <= 3; n += 1) expect(await ask(n)).toBe('queued');
      // A caller still passing the old day ceiling gets an ask queued, never busy.
      const oldShape = addAsk as unknown as (...args: unknown[]) => Promise<string>;
      const fourth = { campaignId: CAMPAIGN, wallet: wallet(4), signedAt: 1, signature: SIGNATURE };
      expect(await oldShape(db, fourth, NOW, { name: 'campaign-asks', max: 0 })).toBe('queued');
      expect(await dayCount(db, 'campaign-asks', NOW)).toBe(300);
      expect(await dayCount(db, CAMPAIGN_SCREENINGS_DAY_COUNTER, NOW)).toBe(0);
    });

    it('C27, C32: a sent list keeps its nonce with its hash, a resend replaces only the hash, and unsent clears both', async () => {
      await createCampaign(db, terms());
      for (const n of [1, 2, 3]) {
        expect(await addListVersion(db, { campaignId: CAMPAIGN, root: root(n), publishedList: '[]', declaredTotal: '0' }, plus(n))).toBe(n);
      }
      const other = `0x${'2e'.repeat(32)}`;
      const version = async (n: number) => (await listVersions(db, CAMPAIGN))[n - 1];
      for (const postNonce of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7' as unknown as number]) {
        await expect(markListSending(db, CAMPAIGN, 1, { postTx: HASH, postNonce }, NOW)).rejects.toThrow(StoreError);
      }
      expect(await version(1)).toMatchObject({ status: 'built', postTx: null, postNonce: null });
      expect(await markListSending(db, CAMPAIGN, 1, { postTx: HASH, postNonce: 7 }, NOW)).toBe(true);
      expect(await version(1)).toMatchObject({ status: 'sending', postTx: HASH, postNonce: 7 });
      await expect(markListResent(db, CAMPAIGN, 1, { postTx: 'not a hash' }, NOW)).rejects.toThrow(StoreError);
      expect(await markListResent(db, CAMPAIGN, 1, { postTx: other }, plus(1))).toBe(true);
      expect(await version(1)).toMatchObject({ status: 'sending', postTx: other, postNonce: 7 });
      expect(await markListResent(db, CAMPAIGN, 2, { postTx: other }, plus(1))).toBe(false);
      expect(await markListPosted(db, CAMPAIGN, 1, { postTx: null, claimableAt: 1_800_000_000 })).toBe(true);
      expect(await version(1)).toMatchObject({ status: 'posted', postTx: other, postNonce: 7 });
      expect(await markListResent(db, CAMPAIGN, 1, { postTx: HASH }, plus(2))).toBe(false);
      expect(await version(1)).toMatchObject({ postTx: other, postNonce: 7 });

      expect(await markListSending(db, CAMPAIGN, 3, { postTx: HASH, postNonce: 0 }, NOW)).toBe(true);
      expect(await version(3)).toMatchObject({ status: 'sending', postNonce: 0 });
      expect(await markListUnsent(db, CAMPAIGN, 3)).toBe(true);
      expect(await version(3)).toMatchObject({ status: 'built', postTx: null, postNonce: null });
      // The call shape from before the nonce still works and stores none.
      expect(await markListSending(db, CAMPAIGN, 2, { postTx: HASH }, NOW)).toBe(true);
      expect(await version(2)).toMatchObject({ status: 'sending', postTx: HASH, postNonce: null });
      expect(await latestList(db, CAMPAIGN)).toMatchObject({ version: 3, postNonce: null });
    });

    it('C41: a try that was not the item\'s fault is handed back on an ask and a relay, never below zero, and the wait still holds', async () => {
      await createCampaign(db, terms());
      expect(await ask(1)).toBe('queued');
      expect(await takeAsk(db, NOW, 60, 3)).toMatchObject({ attempts: 1 });
      for (const refundTry of ['yes', 1, null]) {
        await expect(releaseAsk(db, CAMPAIGN, wallet(1), NOW, 3, 30, { refundTry } as unknown as { refundTry: boolean })).rejects.toThrow(StoreError);
      }
      expect(await releaseAsk(db, CAMPAIGN, wallet(1), NOW, 3, 30, { refundTry: true })).toBe('queued');
      expect(await row(1)).toMatchObject({ status: 'queued', attempts: 0 });
      expect(await takeAsk(db, plus(29), 60, 3)).toBeNull();
      expect(await takeAsk(db, plus(30), 60, 3)).toMatchObject({ attempts: 1 });
      // At its last attempt, a refunded try still queues the ask rather than failing it.
      await db.query("UPDATE asks SET attempts = 3 WHERE wallet = $1", [wallet(1)]);
      expect(await releaseAsk(db, CAMPAIGN, wallet(1), plus(31), 3, 0, { refundTry: true })).toBe('queued');
      expect(await row(1)).toMatchObject({ attempts: 2 });
      expect(await takeAsk(db, plus(32), 60, 3)).toMatchObject({ attempts: 3 });
      expect(await releaseAsk(db, CAMPAIGN, wallet(1), plus(33), 3, 0, { refundTry: false })).toBe('failed');

      await activeVersion(1);
      expect(await queueRelays(db, CAMPAIGN, 1, [{ wallet: wallet(2), amount: '1000000' }], NOW)).toBe(1);
      const key = { campaignId: CAMPAIGN, wallet: wallet(2), version: 1 };
      expect(await takeRelay(db, plus(40), 60)).toMatchObject({ attempts: 1 });
      await expect(markRelay(db, key, { status: 'pending', refundTry: 'yes' as unknown as boolean }, plus(40))).rejects.toThrow(StoreError);
      expect(await markRelay(db, key, { status: 'pending', retryAfterSeconds: 30, refundTry: true }, plus(40))).toBe('pending');
      const relayAttempts = async () =>
        (await db.query<{ attempts: number }>('SELECT attempts FROM claim_relays WHERE wallet = $1', [wallet(2)]))[0]?.attempts;
      expect(await relayAttempts()).toBe(0);
      expect(await takeRelay(db, plus(69), 60)).toBeNull();
      expect(await takeRelay(db, plus(70), 60)).toMatchObject({ attempts: 1 });
      // Never below zero, even for a row some other path left at zero.
      await db.query('UPDATE claim_relays SET attempts = 0 WHERE wallet = $1', [wallet(2)]);
      expect(await markRelay(db, key, { status: 'pending', refundTry: true }, plus(71))).toBe('pending');
      expect(await relayAttempts()).toBe(0);
    });
    it("addAsk answers closed outside opens_at to closes_at and on a closed campaign, and unknown for an unknown id", async () => {
      await createCampaign(db, terms({ opensAt: NOW, closesAt: plus(60) }));
      await createCampaign(db, terms({ id: 'shut', status: 'closed' }));
      expect(await ask(1, plus(-0.001))).toBe('closed');
      expect(await ask(1, NOW)).toBe('queued');
      expect(await ask(2, plus(59.999))).toBe('queued');
      expect(await ask(3, plus(60))).toBe('closed');
      expect(await ask(3, NOW, 'shut')).toBe('closed');
      expect(await ask(3, NOW, 'missing')).toBe('unknown');
      expect(await ask(3, NOW, "'; drop table asks; --")).toBe('unknown');
      // A wallet that asked in time is told its ask stands, even after the campaign closes.
      expect(await ask(1, plus(120))).toBe('exists');
      const [stored] = await db.query<{ asks: number }>('SELECT count(*)::int AS asks FROM asks');
      expect(stored?.asks).toBe(2);
    });

    it('list versions number 1, 2, 3, refuse the newest root again, keep one active and give the text back exactly', async () => {
      await createCampaign(db, terms());
      const text = `[ {"account":"${wallet(1)}","cumulativeAmount":"1000000"},\n  {"account":"${wallet(2)}","cumulativeAmount":"500000"} ]`;
      expect(await addListVersion(db, { campaignId: CAMPAIGN, root: root(1), publishedList: text, declaredTotal: '1500000' }, NOW)).toBe(1);
      await expect(
        addListVersion(db, { campaignId: CAMPAIGN, root: root(1), publishedList: '[]', declaredTotal: '0' }, plus(1)),
      ).rejects.toThrow(StoreError);
      expect(await addListVersion(db, { campaignId: CAMPAIGN, root: root(2), publishedList: '["Ж 🙂"]', declaredTotal: '0' }, plus(2))).toBe(2);
      expect(await addListVersion(db, { campaignId: CAMPAIGN, root: root(1), publishedList: '[]', declaredTotal: '0' }, plus(3))).toBe(3);
      for (const bad of [
        { root: root(0xabc).toUpperCase().replace('0X', '0x') },
        { publishedList: '{"not":"a list"}' },
        { publishedList: '[' },
        { declaredTotal: '-1' },
        { campaignId: 'missing' },
      ]) {
        const list = { campaignId: CAMPAIGN, root: root(4), publishedList: '[]', declaredTotal: '0', ...bad };
        await expect(addListVersion(db, list, plus(4))).rejects.toThrow(StoreError);
      }

      expect(await markListActive(db, CAMPAIGN, 1)).toBe(false);
      expect(await markListPosted(db, CAMPAIGN, 1, { postTx: HASH, claimableAt: 1_800_000_000 })).toBe(true);
      expect(await markListPosted(db, CAMPAIGN, 1, { postTx: HASH, claimableAt: 1_800_000_001 })).toBe(false);
      expect(await markListActive(db, CAMPAIGN, 1)).toBe(true);
      expect(await markListPosted(db, CAMPAIGN, 2, { postTx: HASH, claimableAt: 1_800_003_600 })).toBe(true);
      expect(await markListActive(db, CAMPAIGN, 2)).toBe(true);
      expect(await markListCancelled(db, CAMPAIGN, 2)).toBe(false);
      expect(await markListCancelled(db, CAMPAIGN, 3)).toBe(true);
      expect(await markListActive(db, CAMPAIGN, 3)).toBe(false);

      const versions = await listVersions(db, CAMPAIGN);
      expect(versions.map((version) => [version.version, version.status])).toEqual([
        [1, 'superseded'],
        [2, 'active'],
        [3, 'cancelled'],
      ]);
      for (const version of versions) {
        expect(Object.keys(version).sort()).toEqual(
          ['campaignId', 'claimableAt', 'createdAt', 'declaredTotal', 'postNonce', 'postTx', 'root', 'status', 'version'],
        );
      }
      expect(versions[1]).toEqual({
        campaignId: CAMPAIGN,
        version: 2,
        root: root(2),
        declaredTotal: '0',
        status: 'active',
        postTx: HASH,
        postNonce: null,
        claimableAt: 1_800_003_600,
        createdAt: plus(2),
      });
      expect(await activeList(db, CAMPAIGN)).toEqual(versions[1]);
      expect(await latestList(db, CAMPAIGN)).toEqual(versions[2]);
      expect(await listText(db, CAMPAIGN, 1)).toBe(text);
      expect(await listText(db, CAMPAIGN, 2)).toBe('["Ж 🙂"]');
      expect(await listText(db, CAMPAIGN, 9)).toBeNull();
      await expect(
        db.query("UPDATE list_versions SET status = 'active' WHERE campaign_id = $1 AND version = 1", [CAMPAIGN]),
      ).rejects.toThrow(StoreError);
    });

    it('markListPosted records a root found pending on the vault with no transaction seen, as posted with postTx null', async () => {
      await createCampaign(db, terms());
      expect(await addListVersion(db, { campaignId: CAMPAIGN, root: root(1), publishedList: '[]', declaredTotal: '0' }, NOW)).toBe(1);
      await expect(markListPosted(db, CAMPAIGN, 1, { postTx: 'not a hash', claimableAt: 1_800_000_000 })).rejects.toThrow(StoreError);
      expect(await markListPosted(db, CAMPAIGN, 1, { postTx: null, claimableAt: 1_800_000_000 })).toBe(true);
      const [posted] = await listVersions(db, CAMPAIGN);
      expect(posted).toMatchObject({ version: 1, status: 'posted', postTx: null, claimableAt: 1_800_000_000 });
      expect(await latestList(db, CAMPAIGN)).toEqual(posted);
      expect(await markListActive(db, CAMPAIGN, 1)).toBe(true);
      expect(await activeList(db, CAMPAIGN)).toMatchObject({ version: 1, postTx: null });
      // The time it becomes claimable is always known from the vault, so a posted version can never lack it.
      await expect(db.query("UPDATE list_versions SET claimable_at = NULL WHERE campaign_id = 'demo'")).rejects.toThrow(StoreError);
    });

    it('C32: a list sent to the vault keeps its hash from built to sending to posted, and an unsent one returns to built with none', async () => {
      await createCampaign(db, terms());
      for (const n of [1, 2, 3, 4]) {
        expect(await addListVersion(db, { campaignId: CAMPAIGN, root: root(n), publishedList: '[]', declaredTotal: '0' }, plus(n))).toBe(n);
      }
      const other = `0x${'2e'.repeat(32)}`;
      const version = async (n: number) => (await listVersions(db, CAMPAIGN))[n - 1];
      await expect(markListSending(db, CAMPAIGN, 1, { postTx: 'not a hash' }, NOW)).rejects.toThrow(StoreError);
      expect(await version(1)).toMatchObject({ status: 'built', postTx: null });

      // The hash is on record before any wait, and a stored null keeps it when the mined root is recorded.
      expect(await markListSending(db, CAMPAIGN, 1, { postTx: HASH }, NOW)).toBe(true);
      expect(await version(1)).toMatchObject({ status: 'sending', postTx: HASH, claimableAt: null });
      expect(await latestList(db, CAMPAIGN)).toMatchObject({ version: 4, status: 'built' });
      expect(await markListSending(db, CAMPAIGN, 1, { postTx: other }, NOW)).toBe(false);
      expect(await markListCancelled(db, CAMPAIGN, 1)).toBe(false);
      expect(await version(1)).toMatchObject({ status: 'sending', postTx: HASH });
      expect(await markListPosted(db, CAMPAIGN, 1, { postTx: null, claimableAt: 1_800_000_000 })).toBe(true);
      expect(await version(1)).toMatchObject({ status: 'posted', postTx: HASH, claimableAt: 1_800_000_000 });

      // A replacement hash given with the post replaces the one sent.
      expect(await markListSending(db, CAMPAIGN, 2, { postTx: HASH }, NOW)).toBe(true);
      expect(await markListPosted(db, CAMPAIGN, 2, { postTx: other, claimableAt: 1_800_003_600 })).toBe(true);
      expect(await version(2)).toMatchObject({ status: 'posted', postTx: other });

      // A transaction the chain reverted or never saw: back to built with no hash, and free to be sent again.
      expect(await markListUnsent(db, CAMPAIGN, 3)).toBe(false);
      expect(await markListSending(db, CAMPAIGN, 3, { postTx: HASH }, NOW)).toBe(true);
      expect(await markListUnsent(db, CAMPAIGN, 3)).toBe(true);
      expect(await version(3)).toMatchObject({ status: 'built', postTx: null, claimableAt: null });
      expect(await markListUnsent(db, CAMPAIGN, 3)).toBe(false);
      expect(await markListSending(db, CAMPAIGN, 3, { postTx: other }, NOW)).toBe(true);

      expect(await markListActive(db, CAMPAIGN, 2)).toBe(true);
      expect(await markListCancelled(db, CAMPAIGN, 4)).toBe(true);
      const before = await listVersions(db, CAMPAIGN);
      for (const n of [1, 2, 4]) expect(await markListSending(db, CAMPAIGN, n, { postTx: other }, NOW)).toBe(false);
      for (const n of [1, 2, 4]) expect(await markListUnsent(db, CAMPAIGN, n)).toBe(false);
      expect(await markListPosted(db, CAMPAIGN, 2, { postTx: null, claimableAt: 1 })).toBe(false);
      expect(await listVersions(db, CAMPAIGN)).toEqual(before);
      expect(before.map((list) => list.status)).toEqual(['posted', 'active', 'sending', 'cancelled']);
      // The table itself refuses a sending row without its hash, or with a claimable time.
      await expect(db.query("UPDATE list_versions SET post_tx = NULL WHERE campaign_id = 'demo' AND version = 3")).rejects.toThrow(StoreError);
      await expect(db.query("UPDATE list_versions SET claimable_at = 1 WHERE campaign_id = 'demo' AND version = 3")).rejects.toThrow(StoreError);
    });

    it('markListCancelled cancels a built or posted version, and leaves an active one exactly as it was', async () => {
      await createCampaign(db, terms());
      for (const n of [1, 2, 3]) {
        expect(await addListVersion(db, { campaignId: CAMPAIGN, root: root(n), publishedList: '[]', declaredTotal: '0' }, plus(n))).toBe(n);
      }
      expect(await markListPosted(db, CAMPAIGN, 1, { postTx: HASH, claimableAt: 1_800_000_000 })).toBe(true);
      expect(await markListActive(db, CAMPAIGN, 1)).toBe(true);
      expect(await markListPosted(db, CAMPAIGN, 2, { postTx: HASH, claimableAt: 1_800_003_600 })).toBe(true);
      const before = await listVersions(db, CAMPAIGN);
      expect(await markListCancelled(db, CAMPAIGN, 1)).toBe(false);
      expect(await markListCancelled(db, CAMPAIGN, 2)).toBe(true);
      expect(await markListCancelled(db, CAMPAIGN, 3)).toBe(true);
      expect(await markListCancelled(db, CAMPAIGN, 2)).toBe(false);
      const after = await listVersions(db, CAMPAIGN);
      expect(after[0]).toEqual(before[0]);
      expect(after.map((list) => list.status)).toEqual(['active', 'cancelled', 'cancelled']);
      expect(after[1]).toMatchObject({ postTx: HASH, claimableAt: 1_800_003_600 });
    });

    it('relays: one row per wallet and version however often queued, and takeRelay never hands one to two workers', async () => {
      await createCampaign(db, terms());
      await expect(queueRelays(db, CAMPAIGN, 1, [{ wallet: wallet(1), amount: '1000000' }], NOW)).rejects.toThrow(StoreError);
      await activeVersion(1);
      const entries = [1, 2, 3, 4].map((n) => ({ wallet: wallet(n), amount: '1000000' }));
      expect(await queueRelays(db, CAMPAIGN, 1, [...entries, { wallet: wallet(4).toLowerCase(), amount: '1000000' }], NOW)).toBe(4);
      expect(await queueRelays(db, CAMPAIGN, 1, entries, plus(1))).toBe(0);
      expect(await Promise.all([1, 2, 3].map(() => queueRelays(db, CAMPAIGN, 1, entries, plus(2))))).toEqual([0, 0, 0]);
      await expect(
        queueRelays(db, CAMPAIGN, 1, [entries[0] as { wallet: string; amount: string }, { wallet: wallet(1), amount: '2' }], NOW),
      ).rejects.toThrow(StoreError);
      await expect(queueRelays(db, CAMPAIGN, 1, [{ wallet: wallet(5), amount: '0' }], NOW)).rejects.toThrow(StoreError);
      const [stored] = await db.query<{ relays: number }>('SELECT count(*)::int AS relays FROM claim_relays');
      expect(stored?.relays).toBe(4);

      const taken = await Promise.all(Array.from({ length: 10 }, () => takeRelay(db, plus(10), 60)));
      const relays = taken.filter((relay) => relay !== null);
      expect(relays).toHaveLength(4);
      expect(new Set(relays.map((relay) => relay.wallet))).toEqual(new Set([1, 2, 3, 4].map(wallet)));
      expect(relays.every((relay) => relay.status === 'sent' && relay.attempts === 1 && relay.version === 1)).toBe(true);
      expect(await takeRelay(db, plus(69.999), 60)).toBeNull();

      const key = { campaignId: CAMPAIGN, wallet: wallet(1).toLowerCase(), version: 1 };
      expect(await markRelay(db, key, { status: 'sent', tx: HASH }, plus(30))).toBe('sent');
      expect(await markRelay(db, key, { status: 'confirmed' }, plus(31))).toBe('confirmed');
      expect(await markRelay(db, key, { status: 'pending' }, plus(32))).toBeNull();
      const [confirmed] = await db.query<{ tx: string; status: string }>(
        'SELECT tx, status FROM claim_relays WHERE wallet = $1',
        [wallet(1)],
      );
      expect(confirmed).toEqual({ tx: HASH, status: 'confirmed' });
      await expect(markRelay(db, key, { status: 'done' as 'sent' }, plus(33))).rejects.toThrow(StoreError);

      // A newer active version is a new key, so the same wallets get one more row each, and only one.
      await activeVersion(2, plus(40));
      expect(await queueRelays(db, CAMPAIGN, 2, entries, plus(41))).toBe(4);
      await expect(queueRelays(db, CAMPAIGN, 1, entries, plus(41))).rejects.toThrow(StoreError);
      const [after] = await db.query<{ relays: number }>('SELECT count(*)::int AS relays FROM claim_relays');
      expect(after?.relays).toBe(8);
    });

    it('confirmedPayouts gives each wallet its newest confirmed claim with a transaction, and nothing for the rest', async () => {
      await createCampaign(db, terms());
      await activeVersion(1);
      const entries = [1, 2, 3].map((n) => ({ wallet: wallet(n), amount: '250000' }));
      expect(await queueRelays(db, CAMPAIGN, 1, entries, NOW)).toBe(3);
      const asked = [1, 2, 3, 4].map(wallet);
      expect(await confirmedPayouts(db, CAMPAIGN, asked)).toEqual([]);

      // Wallet 1 is paid, wallet 2 is only sent, wallet 3 is still pending, wallet 4 has no relay at all.
      const first = `0x${'a1'.repeat(32)}`;
      for (let taken = 0; taken < 3; taken += 1) expect(await takeRelay(db, plus(10), 60)).not.toBeNull();
      const key = (n: number, version = 1) => ({ campaignId: CAMPAIGN, wallet: wallet(n), version });
      expect(await markRelay(db, key(1), { status: 'confirmed', tx: first }, plus(11))).toBe('confirmed');
      expect(await markRelay(db, key(2), { status: 'sent', tx: HASH }, plus(11))).toBe('sent');
      expect(await markRelay(db, key(3), { status: 'pending' }, plus(11))).toBe('pending');
      expect(await confirmedPayouts(db, CAMPAIGN, asked)).toEqual([{ wallet: wallet(1), amount: '250000', tx: first }]);
      expect(await confirmedPayouts(db, CAMPAIGN, [wallet(2), wallet(4)])).toEqual([]);

      // A newer list raises wallet 1's total: the newest confirmed relay is the one shown, the older one is not.
      const second = `0x${'b2'.repeat(32)}`;
      await activeVersion(2, plus(20));
      expect(await queueRelays(db, CAMPAIGN, 2, [{ wallet: wallet(1), amount: '500000' }], plus(21))).toBe(1);
      expect((await confirmedPayouts(db, CAMPAIGN, asked))[0]).toMatchObject({ amount: '250000', tx: first });
      // Wallet 3's relay is ready again too, so both are taken before the new one is confirmed.
      const taken = [await takeRelay(db, plus(22), 60), await takeRelay(db, plus(22), 60)];
      expect(taken.map((relay) => `${relay?.wallet} v${relay?.version}`).sort()).toEqual([`${wallet(1)} v2`, `${wallet(3)} v1`].sort());
      expect(await markRelay(db, key(1, 2), { status: 'confirmed', tx: second }, plus(23))).toBe('confirmed');
      expect(await confirmedPayouts(db, CAMPAIGN, asked)).toEqual([{ wallet: wallet(1), amount: '500000', tx: second }]);

      // Another campaign, an unknown id and no wallets give nothing; too many wallets is refused before any read.
      expect(await confirmedPayouts(db, 'other', asked)).toEqual([]);
      expect(await confirmedPayouts(db, 'not a campaign id', asked)).toEqual([]);
      expect(await confirmedPayouts(db, CAMPAIGN, [])).toEqual([]);
      await expect(confirmedPayouts(db, CAMPAIGN, Array.from({ length: MAX_PAYOUT_WALLETS + 1 }, (_, n) => wallet(n)))).rejects.toThrow(StoreError);
      await expect(confirmedPayouts(db, CAMPAIGN, [7 as unknown as string])).rejects.toThrow(StoreError);
    });

    it('C41: a relay given back with a retry delay waits that long, a ready one is taken meanwhile, and an ended one never again', async () => {
      await createCampaign(db, terms());
      await activeVersion(1);
      expect(await queueRelays(db, CAMPAIGN, 1, [{ wallet: wallet(1), amount: '1000000' }], plus(1))).toBe(1);
      expect(await queueRelays(db, CAMPAIGN, 1, [{ wallet: wallet(2), amount: '500000' }], plus(2))).toBe(1);
      expect(await takeRelay(db, plus(10), 60)).toMatchObject({ wallet: wallet(1), attempts: 1 });
      const first = { campaignId: CAMPAIGN, wallet: wallet(1), version: 1 };
      for (const bad of [-1, 1.5, 86_401, Number.NaN]) {
        await expect(markRelay(db, first, { status: 'pending', retryAfterSeconds: bad }, plus(10))).rejects.toThrow(StoreError);
      }
      const [held] = await db.query<{ status: string }>('SELECT status FROM claim_relays WHERE wallet = $1', [wallet(1)]);
      expect(held?.status).toBe('sent');
      expect(await markRelay(db, first, { status: 'pending', retryAfterSeconds: 30 }, plus(10))).toBe('pending');
      // Relay 1 waits out its delay; relay 2 is ready, so it is taken in between.
      expect(await takeRelay(db, plus(11), 60)).toMatchObject({ wallet: wallet(2), attempts: 1 });
      expect(await takeRelay(db, plus(39), 60)).toBeNull();
      expect(await takeRelay(db, plus(40), 60)).toMatchObject({ wallet: wallet(1), attempts: 2 });

      // C27: once confirmed or failed, a relay is never handed out again, however long the wait.
      expect(await markRelay(db, first, { status: 'confirmed', tx: `0x${'1f'.repeat(32)}` }, plus(41))).toBe('confirmed');
      expect(await markRelay(db, { ...first, wallet: wallet(2) }, { status: 'failed' }, plus(41))).toBe('failed');
      expect(await takeRelay(db, plus(1_000_000), 60)).toBeNull();
    });

    it('a relay is failed for good on its tenth failed try, not its fifth, whether given back or its lease runs out', async () => {
      await createCampaign(db, terms());
      await activeVersion(1);
      expect(MAX_RELAY_ATTEMPTS).toBe(10);
      expect(await queueRelays(db, CAMPAIGN, 1, [{ wallet: wallet(1), amount: '1000000' }], NOW)).toBe(1);
      const key = { campaignId: CAMPAIGN, wallet: wallet(1), version: 1 };
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        expect((await takeRelay(db, plus(attempt), 60))?.attempts).toBe(attempt);
        expect(await markRelay(db, key, { status: 'pending' }, plus(attempt))).toBe(attempt < 10 ? 'pending' : 'failed');
      }
      expect(await takeRelay(db, plus(20), 60)).toBeNull();

      expect(await queueRelays(db, CAMPAIGN, 1, [{ wallet: wallet(2), amount: '500000' }], NOW)).toBe(1);
      expect((await takeRelay(db, NOW, 60))?.attempts).toBe(1);
      for (let attempt = 2; attempt <= 10; attempt += 1) {
        const leaseEnds = (attempt - 1) * 60;
        expect(await takeRelay(db, plus(leaseEnds - 0.001), 60)).toBeNull();
        expect((await takeRelay(db, plus(leaseEnds), 60))?.attempts).toBe(attempt);
      }
      expect(await takeRelay(db, plus(599.999), 60)).toBeNull();
      expect(await takeRelay(db, plus(600), 60)).toBeNull();
      const rows = await db.query<{ wallet: string; status: string; attempts: number }>(
        'SELECT wallet, status, attempts FROM claim_relays',
      );
      expect(new Map(rows.map((relay) => [relay.wallet, [relay.status, relay.attempts]]))).toEqual(
        new Map([
          [wallet(1), ['failed', 10]],
          [wallet(2), ['failed', 10]],
        ]),
      );
    });

    it('board pages decided and failed asks newest first, and counts adds them up', async () => {
      await createCampaign(db, terms());
      for (let n = 1; n <= 4; n += 1) expect(await ask(n, plus(n))).toBe('queued');
      await screenAll(3, plus(5));
      expect(await decideAsk(db, decision(wallet(1), 'full'), plus(10))).toEqual({ slot: 1 });
      expect(await decideAsk(db, decision(wallet(2), 'hold'), plus(20))).toEqual({ slot: null });
      expect(await releaseAsk(db, CAMPAIGN, wallet(3), plus(30), 1)).toBe('failed');
      expect((await board(db, CAMPAIGN, 2)).map((item) => item.wallet)).toEqual([wallet(3), wallet(2)]);
      expect((await board(db, CAMPAIGN, 2, plus(20))).map((item) => item.wallet)).toEqual([wallet(1)]);
      expect(await board(db, CAMPAIGN, 100, plus(10))).toEqual([]);
      expect(await board(db, 'missing', 10)).toEqual([]);
      await expect(board(db, CAMPAIGN, 101)).rejects.toThrow(StoreError);
      await expect(board(db, CAMPAIGN, 0)).rejects.toThrow(StoreError);
      expect(await counts(db, CAMPAIGN)).toEqual({
        asked: 4,
        queued: 1,
        decided: 3,
        held: 2,
        slotsTaken: 1,
        slotsLeft: 19,
        asksLeft: 1_996,
        appeals: { filed: 0, checked: 0, block: 0, reversed: 0 },
      });
      expect(await counts(db, 'missing')).toBeNull();
    });

    it('board never ends a page inside a tie, so walking it page by page returns every ask exactly once', async () => {
      await createCampaign(db, terms());
      for (let n = 1; n <= 5; n += 1) expect(await ask(n, plus(n))).toBe('queued');
      await screenAll(5, plus(6));
      expect(await decideAsk(db, decision(wallet(1), 'full'), plus(10))).toEqual({ slot: 1 });
      expect(await decideAsk(db, decision(wallet(2), 'hold'), plus(20))).toEqual({ slot: null });
      for (const n of [3, 4, 5]) expect(await decideAsk(db, decision(wallet(n), 'hold'), plus(30))).toEqual({ slot: null });
      const pages: string[][] = [];
      let before: Date | undefined;
      for (let page = 0; page < 10; page += 1) {
        const asks = await board(db, CAMPAIGN, 2, before);
        if (asks.length === 0) break;
        pages.push(asks.map((item) => item.wallet));
        before = asks.at(-1)?.decidedAt ?? undefined;
      }
      const walked = pages.flat();
      expect(walked).toHaveLength(5);
      expect(new Set(walked)).toEqual(new Set([1, 2, 3, 4, 5].map(wallet)));
      expect(pages.map((page) => page.length)).toEqual([3, 2]);
      expect(new Set(pages[0])).toEqual(new Set([3, 4, 5].map(wallet)));
    });

    it('C43: hostile strings are stored as campaign name and reason where their checks allow, and read back unchanged', async () => {
      expect([...UNICODE_RUN]).toHaveLength(150);
      for (const [index, fixture] of FIXTURES.entries()) {
        const named = terms({ id: `named-${index}`, name: fixture });
        if ([...fixture].length <= 80) {
          expect(await createCampaign(db, named)).toBe('created');
          expect((await getCampaign(db, named.id))?.name).toBe(fixture);
        } else {
          await expect(createCampaign(db, named)).rejects.toThrow(StoreError);
        }
      }
      expect(await db.query<{ id: string }>('SELECT id FROM campaigns ORDER BY id')).toEqual([
        { id: 'named-0' },
        { id: 'named-1' },
        { id: 'named-3' },
      ]);

      await createCampaign(db, terms());
      for (const [index, fixture] of FIXTURES.entries()) {
        expect(await ask(index + 1)).toBe('queued');
        await screenAll(1);
        expect(await decideAsk(db, decision(wallet(index + 1), 'hold', { reason: fixture, notChecked: [fixture.slice(0, 8)] }), NOW)).toEqual({
          slot: null,
        });
        const stored = await getAsk(db, CAMPAIGN, wallet(index + 1));
        expect(stored?.reason).toBe(fixture);
        expect(stored?.notChecked).toEqual([fixture.slice(0, 8)]);
      }
      for (const table of ['campaigns', 'asks', 'list_versions', 'claim_relays', 'payment_claims']) {
        const [present] = await db.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [table]);
        expect({ table, present: present?.present }).toEqual({ table, present: true });
      }
    });

    it('C40: the public ask view has exactly the listed keys, so the signature and lease cannot leave through it', async () => {
      await createCampaign(db, terms());
      for (let n = 1; n <= 3; n += 1) expect(await ask(n, plus(n))).toBe('queued');
      await screenAll(2, plus(5));
      expect(await decideAsk(db, decision(wallet(1), 'full'), plus(6))).toEqual({ slot: 1 });
      expect(await releaseAsk(db, CAMPAIGN, wallet(2), plus(7), 1)).toBe('failed');
      const views = [
        await getAsk(db, CAMPAIGN, wallet(1)),
        await getAsk(db, CAMPAIGN, wallet(2)),
        await getAsk(db, CAMPAIGN, wallet(3)),
        ...(await board(db, CAMPAIGN, 10)),
      ];
      expect(views.map((view) => view?.status)).toEqual(['decided', 'failed', 'queued', 'failed', 'decided']);
      for (const view of views) {
        expect(Object.keys(view ?? {}).sort()).toEqual(PUBLIC_KEYS);
        expect(JSON.stringify(view)).not.toContain(SIGNATURE.slice(2));
      }
      expect(await getAsk(db, CAMPAIGN, wallet(4))).toBeNull();
      expect(await getAsk(db, 'missing', wallet(1))).toBeNull();
    });
  });
}

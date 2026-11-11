// Not covered here: a real chain and a real Postgres. Wallet types and vault amounts come from stand-ins, so the
// readers site.ts builds on ETH_RPC_URL and the Base RPCs are not run; every route runs on one in-memory PGlite, which
// runs one statement at a time, so limits are not raced between two connections here (the store's own tests cover the
// atomic writes). The site's mount of these routes is covered in packages/web/test/api.test.ts. Nothing here screens a
// wallet: the worker takes asks off the queue, and its loop is not part of this package.
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import type { FacilitatorClient } from '@x402/core/server';
import type { SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { appealMessage, appealTextHash, askMessage, LEAF_TYPES, leafValues, parseAddress, type Address } from '@thuli/core';
import {
  addAppeal,
  addAsk,
  addListVersion,
  APPEALS_DAY_COUNTER,
  APPEALS_DAY_MAX,
  createCampaign,
  decideAsk,
  markListActive,
  markListPosted,
  migrate,
  openMemoryDb,
  recordAppealCheck,
  settleAppeal,
  StoreError,
  takeAppeal,
  takeAsk,
  type AskDecision,
  type CampaignInput,
  type Db,
  type Queryable,
} from '@thuli/store';
import { buildClaimList } from '@thuli/worker/src/vault/claimList.ts';
import { buildRoot, publishList } from '@thuli/worker/src/vault/root.ts';
import { createApp } from '../src/app.ts';
import {
  APPEALS_PER_CALLER_HOUR,
  ASK_CLIENT_MAX_PER_MINUTE,
  CAMPAIGN_CHAIN_READS_PER_MINUTE,
  CAMPAIGN_READS_PER_MINUTE,
  CAMPAIGNS_PATH,
  type CampaignDeps,
  type VaultReader,
} from '../src/campaigns.ts';
import {
  AskView,
  BoardPage,
  BusyBody,
  CampaignView,
  ClosedBody,
  ErrorBody,
  ExistsAppealBody,
  ExistsBody,
  FullBody,
  QueuedBody,
} from '../src/schema.ts';
import { captureLogs, expectNoDatabaseUrl, noChain, post, screenResult, socketFrom, storeDown, testnetConfig, url } from './support.ts';

/** The campaign routes never take a payment, so this facilitator only answers what the app asks at start. */
class NoPayments implements FacilitatorClient {
  async getSupported(): Promise<SupportedResponse> {
    return { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: ['bazaar'], signers: {} };
  }

  async verify(): Promise<VerifyResponse> {
    throw new Error('the campaign routes never verify a payment');
  }

  async settle(): Promise<SettleResponse> {
    throw new Error('the campaign routes never settle a payment');
  }
}

const NOW = new Date('2026-11-11T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const CAMPAIGN = 'demo';
const CHAIN = 84532;
const VAULT = parseAddress('0x00000000000000000000000000000000000a11ce');
const HASH = `0x${'1f'.repeat(32)}`;
const NO_CAMPAIGN = '{"error":"no such campaign"}';
// Well formed, so it passes the body's shape, and signed by nobody, so checkAsk refuses it before any chain read.
const UNSIGNED = { wallet: '0x00000000000000000000000000000000000000c1', signedAt: Math.floor(Date.parse('2026-11-11T12:00:00.000Z') / 1000), signature: `0x${'ab'.repeat(65)}` };
const KEYS: PrivateKeyAccount[] = Array.from({ length: 12 }, () => privateKeyToAccount(generatePrivateKey()));
const walletOf = (index: number): Address => (KEYS[index] as PrivateKeyAccount).address;

function terms(overrides: Partial<CampaignInput> = {}): CampaignInput {
  return {
    id: CAMPAIGN,
    name: 'Thuli demo',
    chain: CHAIN,
    vault: VAULT,
    token: parseAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
    owner: parseAddress('0x00000000000000000000000000000000000000b0'),
    agent: parseAddress('0x00000000000000000000000000000000000000a9'),
    rewardPerWallet: '1000000',
    perWalletCap: '1000000',
    partialShareBps: 5000,
    maxSlots: 20,
    rulebook: 2,
    settings: {},
    status: 'open',
    opensAt: new Date(NOW.getTime() - 3_600_000),
    closesAt: new Date(NOW.getTime() + 86_400_000),
    createdAt: new Date(NOW.getTime() - 7_200_000),
    ...overrides,
  };
}

async function signedAsk(index: number, options: { campaignId?: string; signedAt?: number; wallet?: string } = {}) {
  return signedBy(KEYS[index] as PrivateKeyAccount, options);
}

async function signedBy(account: PrivateKeyAccount, options: { campaignId?: string; signedAt?: number; wallet?: string } = {}) {
  const signedAt = options.signedAt ?? NOW_SECONDS;
  const message = askMessage({ campaignId: options.campaignId ?? CAMPAIGN, wallet: account.address, signedAt });
  return { wallet: options.wallet ?? account.address, signedAt, signature: await account.signMessage({ message }) };
}

const APPEAL_TEXT = 'My funder is an exchange; this wallet is mine alone.';

/** Wallet index's appeal, signed over the five-line appeal message for the text sent, as the site signs it. */
async function signedAppeal(index: number, options: { campaignId?: string; signedAt?: number; text?: string; wallet?: string } = {}) {
  const account = KEYS[index] as PrivateKeyAccount;
  const signedAt = options.signedAt ?? NOW_SECONDS;
  const text = options.text ?? APPEAL_TEXT;
  const message = appealMessage({ campaignId: options.campaignId ?? CAMPAIGN, wallet: account.address, textHash: appealTextHash(text), signedAt });
  return { wallet: options.wallet ?? account.address, text, signedAt, signature: await account.signMessage({ message }) };
}

/** A hold for decideAsk, with the wallet filled in by the test. */
const HOLD: AskDecision = {
  campaignId: CAMPAIGN,
  wallet: '',
  action: 'hold',
  shareBps: 0,
  rule: 'A9',
  reason: 'Held while the funder is checked.',
  citedTxs: [],
  notChecked: [],
  facts: { ageDays: 400, txCount: 90, accountType: 'eoa', funder: null, burstWallets: null, groupSize: null, missing: [] },
  servRequestId: null,
};

interface Reply {
  status: number;
  text: string;
  type: string | null;
  retryAfter: string | null;
}

/** The campaign chain's reader unless a test gives its own: no address has code, and the vault is not read. */
const NO_CODE: VaultReader = {
  isContract: async () => false,
  claimed: async () => Promise.reject(new Error('this test reads no vault')),
  claimable: async () => Promise.reject(new Error('this test reads no vault')),
};

/** Every body any test received, so the last test can search them all for a stored signature (C40). */
const seen: string[] = [];

describe('campaign routes', () => {
  let db: Db;
  beforeAll(async () => {
    db = await openMemoryDb();
    await migrate(db);
  }, 60_000);
  beforeEach(async () => {
    await db.query('TRUNCATE appeals, claim_relays, list_versions, asks, campaigns, rate_events, day_counts');
  });
  afterAll(async () => {
    await db.close();
  });

  function campaignApp(options: Partial<CampaignDeps> & { trustedHeader?: string } = {}) {
    const config = { ...testnetConfig(new NoPayments()), trustedClientHeader: options.trustedHeader ?? null };
    const app = createApp(config, {
      screen: async (wallet) => screenResult(wallet),
      readReceipt: noChain,
      now: options.now ?? (() => NOW),
      campaigns: {
        db: options.db ?? db,
        isContract: options.isContract ?? (async () => false),
        vault: 'vault' in options ? options.vault : () => NO_CODE,
      },
    });
    return async (path: string, init: RequestInit = {}, caller = '192.0.2.10'): Promise<Reply> => {
      const reply = await app.fetch(new Request(url(path), init), socketFrom(caller));
      expect(reply.headers.get('cache-control'), path).toBe('no-store');
      const text = await reply.text();
      seen.push(text);
      return { status: reply.status, text, type: reply.headers.get('content-type'), retryAfter: reply.headers.get('retry-after') };
    };
  }

  const asks = (id = CAMPAIGN) => `${CAMPAIGNS_PATH}/${id}/asks`;
  const appeals = (id = CAMPAIGN) => `${CAMPAIGNS_PATH}/${id}/appeals`;

  async function rows(sql: 'asks' | 'hour'): Promise<number> {
    const text = {
      asks: 'SELECT count(*)::int AS n FROM asks',
      hour: "SELECT count(*)::int AS n FROM rate_events WHERE bucket = 'ask-hour'",
    }[sql];
    const [row] = await db.query<{ n: number }>(text);
    return row?.n ?? -1;
  }

  async function decided(
    index: number,
    action: 'full' | 'partial' | 'hold',
    reason = 'No shared funder links this wallet.',
    campaignId = CAMPAIGN,
  ) {
    await db.query(
      `INSERT INTO asks (campaign_id, wallet, signed_at, signature, asked_at, status, attempts)
       VALUES ($1, $2, $3::bigint, $4, $5::timestamptz, 'queued', 0)`,
      [campaignId, walletOf(index), String(NOW_SECONDS), (await signedAsk(index)).signature, NOW.toISOString()],
    );
    expect(await takeAsk(db, NOW, 60, 3)).not.toBeNull();
    return decideAsk(
      db,
      {
        campaignId,
        wallet: walletOf(index),
        action,
        shareBps: { full: 10_000, partial: 5_000, hold: 0 }[action],
        rule: 'A9',
        reason,
        citedTxs: [HASH],
        notChecked: ['sharedDepositAddress'],
        facts: { ageDays: 400, txCount: 90, accountType: 'eoa', funder: null, burstWallets: null, groupSize: null, missing: [] },
        servRequestId: 'run-1',
      },
      NOW,
    );
  }

  /** Posts a list of these wallets as the campaign's next version, made active unless told otherwise. */
  async function publish(wallets: { index: number; action: 'full' | 'partial' }[], active = true, campaignId = CAMPAIGN, vault = VAULT) {
    const { entries, declaredTotal } = buildClaimList(
      wallets.map(({ index, action }) => ({ account: walletOf(index), action, shareBps: action === 'full' ? 10_000 : 5_000 })),
      { rewardPerWallet: 1_000_000n, perWalletCap: 1_000_000n, partialShareBps: 5000 },
    );
    const text = publishList(entries);
    const { root } = buildRoot(entries, vault, CHAIN);
    const version = await addListVersion(db, { campaignId, root, publishedList: text, declaredTotal: declaredTotal.toString() }, NOW);
    expect(await markListPosted(db, campaignId, version, { postTx: HASH, claimableAt: NOW_SECONDS })).toBe(true);
    if (active) expect(await markListActive(db, campaignId, version)).toBe(true);
    return { version, root, text };
  }

  it('C7, C9: an appeal signature, another campaign, a stale ask, a contract and an unreadable wallet type are refused', async () => {
    await createCampaign(db, terms());
    const send = campaignApp();
    const appeal = KEYS[0] as PrivateKeyAccount;
    const appealSigned = await appeal.signMessage({
      message: appealMessage({ campaignId: CAMPAIGN, wallet: appeal.address, textHash: appealTextHash('please'), signedAt: NOW_SECONDS }),
    });
    const cases: [unknown, string, ReturnType<typeof campaignApp>][] = [
      [{ wallet: appeal.address, signedAt: NOW_SECONDS, signature: appealSigned }, 'the signature does not match this ask', send],
      [await signedAsk(1, { campaignId: 'other' }), 'the signature does not match this ask', send],
      [await signedAsk(2, { signedAt: NOW_SECONDS - 601 }), 'the signature is too old', send],
      [await signedAsk(3), 'contract wallets cannot ask yet', campaignApp({ isContract: async () => true })],
      [
        await signedAsk(4),
        'the wallet type could not be checked',
        campaignApp({
          isContract: async () => {
            throw new Error('the code read timed out');
          },
        }),
      ],
    ];
    for (const [body, cause, app] of cases) {
      const reply = await app(asks(), post(body));
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.text)).toEqual({ error: cause });
    }
    expect(await rows('asks')).toBe(0);
    expect(await rows('hour')).toBe(0);
  });

  it("C7: a wallet with code on the campaign's chain is refused as a contract, and an unreadable chain refuses", async () => {
    await createCampaign(db, terms());
    await createCampaign(db, terms({ id: 'mainnet', chain: 1 }));
    // Wallet 0 has code only on Base Sepolia, the campaign's chain; wallet 1 has code nowhere.
    const code: Record<number, Set<string>> = { 1: new Set(), [CHAIN]: new Set([walletOf(0)]) };
    const reads: number[] = [];
    const readerFor = (chainId: number, failing = false): VaultReader => ({
      isContract: async (address) => {
        reads.push(chainId);
        if (failing) throw new Error('the code read timed out');
        return code[chainId]?.has(address) ?? false;
      },
      claimed: async () => 0n,
      claimable: async () => 0n,
    });
    const onEthereum = async (address: Address) => {
      reads.push(1);
      return code[1]?.has(address) ?? false;
    };
    const send = campaignApp({ isContract: onEthereum, vault: (chainId) => (chainId === CHAIN ? readerFor(chainId) : null) });
    const contract = await send(asks(), post(await signedAsk(0)));
    expect([contract.status, JSON.parse(contract.text)]).toEqual([400, { error: 'contract wallets cannot ask yet' }]);
    expect(reads.sort()).toEqual([1, CHAIN]);
    const plain = await send(asks(), post(await signedAsk(1)), '192.0.2.31');
    expect([plain.status, plain.text]).toEqual([202, '{"queued":true}']);

    const unreadable = [
      campaignApp({ isContract: onEthereum, vault: (chainId) => readerFor(chainId, true) }),
      campaignApp({ isContract: onEthereum, vault: () => null }),
    ];
    for (const app of unreadable) {
      const reply = await app(asks(), post(await signedAsk(2)), '192.0.2.32');
      expect([reply.status, JSON.parse(reply.text)]).toEqual([400, { error: 'the wallet type could not be checked' }]);
    }
    expect((await db.query('SELECT wallet FROM asks')).map((row) => row.wallet)).toEqual([walletOf(1)]);

    // A campaign on Ethereum itself reads Ethereum once and no other chain.
    reads.length = 0;
    const mainnetAsk = await campaignApp({ isContract: onEthereum, vault: (chainId) => readerFor(chainId, true) })(
      asks('mainnet'),
      post(await signedAsk(3, { campaignId: 'mainnet' })),
      '192.0.2.33',
    );
    expect(mainnetAsk.status).toBe(202);
    expect(reads).toEqual([1]);
  });

  it('C1: the same wallet in two spellings gets 202 then 200 exists, and one row keeps the first ask', async () => {
    await createCampaign(db, terms());
    const send = campaignApp();
    const first = await signedAsk(0, { wallet: walletOf(0).toLowerCase() });
    const queued = await send(asks(), post(first));
    expect([queued.status, JSON.parse(queued.text)]).toEqual([202, { queued: true }]);
    const again = await send(asks(), post(await signedAsk(0, { signedAt: NOW_SECONDS - 5 })));
    expect(again.status).toBe(200);
    const body = ExistsBody.parse(JSON.parse(again.text));
    expect(body.ask).toMatchObject({ wallet: walletOf(0), status: 'queued', campaignId: CAMPAIGN, action: null, slot: null });
    const stored = await db.query<{ wallet: string; signature: string }>('SELECT wallet, signature FROM asks');
    expect(stored).toEqual([{ wallet: walletOf(0), signature: first.signature }]);
  });

  it('C42: a sixth ask in an hour is 429 and writes nothing, another caller passes, and a rotating forwarded header does not help', async () => {
    await createCampaign(db, terms());
    const send = campaignApp({ trustedHeader: 'x-vercel-forwarded-for' });
    const as = (caller: string, extra: Record<string, string> = {}) => ({ 'x-vercel-forwarded-for': caller, ...extra });
    for (let index = 0; index < 5; index += 1) {
      expect((await send(asks(), post(await signedAsk(index), as('198.51.100.1')))).status).toBe(202);
    }
    const sixth = await send(asks(), post(await signedAsk(5), as('198.51.100.1')));
    expect([sixth.status, sixth.text]).toEqual([429, '{"busy":true}']);
    for (const rotated of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      const reply = await send(asks(), post(await signedAsk(5), as('198.51.100.1', { 'x-forwarded-for': rotated })), rotated);
      expect(reply.status).toBe(429);
    }
    expect(await rows('asks')).toBe(5);
    expect((await db.query('SELECT wallet FROM asks WHERE wallet = $1', [walletOf(5)])).length).toBe(0);
    expect((await send(asks(), post(await signedAsk(5), as('198.51.100.2')))).status).toBe(202);
    expect(await rows('asks')).toBe(6);

    // The minute counts every well-formed request, a refused one too, before anything reads the chain.
    const statuses: number[] = [];
    for (let index = 0; index <= ASK_CLIENT_MAX_PER_MINUTE; index += 1) {
      statuses.push((await send(asks(), post(UNSIGNED, as('198.51.100.3')))).status);
    }
    expect(statuses).toEqual([...Array(ASK_CLIENT_MAX_PER_MINUTE).fill(400), 429]);
    const noCaller = await send(asks(), post(await signedAsk(6)));
    expect([noCaller.status, JSON.parse(noCaller.text)]).toEqual([400, { error: 'the client address could not be read' }]);
  });

  it('C24: a campaign with no slot left queues no ask, whatever the number of callers and keys, and answers 409 full', async () => {
    await createCampaign(db, terms({ maxSlots: 1 }));
    expect(await decided(0, 'full')).toEqual({ slot: 1 });
    const send = campaignApp();
    const fresh = Array.from({ length: 60 }, () => privateKeyToAccount(generatePrivateKey()));
    const statuses: string[] = [];
    for (const [index, account] of fresh.entries()) {
      const reply = await send(asks(), post(await signedBy(account)), `198.51.100.${10 + (index % 12)}`);
      statuses.push(`${reply.status} ${reply.text}`);
    }
    expect(new Set(statuses)).toEqual(new Set(['409 {"full":true}']));
    expect(statuses).toHaveLength(60);
    expect(await rows('asks')).toBe(1);
    // The wallet that already asked can still read its decision: exists beats full.
    const again = await send(asks(), post(await signedAsk(0)), '198.51.100.99');
    expect(again.status).toBe(200);
    expect(ExistsBody.parse(JSON.parse(again.text)).ask).toMatchObject({ status: 'decided', slot: 1 });
  });

  it('C42: 500 reads of one ask from one caller give 120 answers in the minute, and the vault is read once', async () => {
    await createCampaign(db, terms());
    expect(await decided(0, 'full')).toEqual({ slot: 1 });
    await publish([{ index: 0, action: 'full' }]);
    let reads = 0;
    const reader: VaultReader = {
      ...NO_CODE,
      claimed: async () => {
        reads += 1;
        return 0n;
      },
      claimable: async (_vault, _account, amount) => {
        reads += 1;
        return amount;
      },
    };
    const send = campaignApp({ vault: () => reader });
    const counted = new Map<number, number>();
    for (let index = 0; index < 500; index += 1) {
      const reply = await send(`${asks()}/${walletOf(0)}`, {}, '198.51.100.5');
      counted.set(reply.status, (counted.get(reply.status) ?? 0) + 1);
      if (reply.status === 429) expect(reply.text).toBe('{"busy":true}');
    }
    expect(reads).toBeLessThanOrEqual(2);
    expect(Object.fromEntries(counted)).toEqual({ 200: CAMPAIGN_READS_PER_MINUTE, 429: 500 - CAMPAIGN_READS_PER_MINUTE });
  });

  it('C24: the route answers full while 200 asks wait undecided, and queues again once one of them is decided', async () => {
    await createCampaign(db, terms());
    await db.query(
      `INSERT INTO asks (campaign_id, wallet, signed_at, signature, asked_at, status, attempts)
       SELECT 'demo', '0x' || lpad(to_hex(n), 40, '0'), 1, $1, $2::timestamptz, 'queued', 0 FROM generate_series(1, 200) AS n`,
      [`0x${'ab'.repeat(65)}`, new Date(NOW.getTime() - 100_000).toISOString()],
    );
    const send = campaignApp();
    const full = await send(asks(), post(await signedAsk(0)), '198.51.100.60');
    expect([full.status, full.text]).toEqual([409, '{"full":true}']);
    const taken = await takeAsk(db, NOW, 60, 3);
    expect(await decideAsk(db, { ...HOLD, wallet: taken?.wallet as string }, NOW)).toEqual({ slot: null });
    expect((await send(asks(), post(await signedAsk(0)), '198.51.100.61')).status).toBe(202);
    expect((await send(asks(), post(await signedAsk(1)), '198.51.100.62')).text).toBe('{"full":true}');
  });

  it('C24: the route answers full at the lifetime cap, and an ask refused as full, exists or closed spends no global count', async () => {
    await createCampaign(db, terms({ maxSlots: 1 }));
    await createCampaign(db, terms({ id: 'shut', status: 'closed' }));
    await db.query(
      `INSERT INTO asks (campaign_id, wallet, signed_at, signature, asked_at, status, attempts, action, share_bps, rule, reason,
                         cited_txs, not_checked, facts, decided_at)
       SELECT 'demo', '0x' || lpad(to_hex(n), 40, '0'), 1, $1, $2::timestamptz, 'decided', 1, 'hold', 0, 'A9', 'Held.',
              '[]', '[]', $3::jsonb, $2::timestamptz
         FROM generate_series(1, 999) AS n`,
      [`0x${'ab'.repeat(65)}`, new Date(NOW.getTime() - 100_000).toISOString(), JSON.stringify(HOLD.facts)],
    );
    const send = campaignApp();
    expect((await send(asks(), post(await signedAsk(0)), '198.51.100.63')).status).toBe(202);
    const answers = [
      await send(asks(), post(await signedAsk(1)), '198.51.100.64'),
      await send(asks(), post(await signedAsk(0)), '198.51.100.65'),
      await send(asks('shut'), post(await signedAsk(2, { campaignId: 'shut' })), '198.51.100.66'),
    ];
    expect(answers.map((reply) => reply.status)).toEqual([409, 200, 409]);
    expect([answers[0]?.text, answers[2]?.text]).toEqual(['{"full":true}', '{"closed":true}']);
    expect(answers.every((reply) => reply.retryAfter === null)).toBe(true);
    expect(await db.query('SELECT name, count FROM day_counts')).toEqual([]);
  });

  it('C42: the minute is counted before the body is read, so the 21st malformed body in a minute is 429', async () => {
    await createCampaign(db, terms());
    const send = campaignApp();
    const statuses: number[] = [];
    for (let index = 0; index <= ASK_CLIENT_MAX_PER_MINUTE; index += 1) {
      const body = index % 2 === 0 ? 'not json' : { wallet: 'x' };
      statuses.push((await send(asks(), post(body), '198.51.100.70')).status);
    }
    expect(statuses).toEqual([...Array(ASK_CLIENT_MAX_PER_MINUTE).fill(400), 429]);
    // The size check still comes first, and counts nothing.
    expect((await send(asks(), post({ wallet: 'x'.repeat(2_000) }), '198.51.100.71')).status).toBe(413);
    const [counted] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM rate_events WHERE client = '198.51.100.71'");
    expect(counted?.n).toBe(0);
  });

  it('C34: counts carry the appeals and each ask and board row its appeal, and an outside note with markup leaves as null', async () => {
    await createCampaign(db, terms());
    expect(await decided(0, 'hold')).toEqual({ slot: null });
    expect(await decided(1, 'hold')).toEqual({ slot: null });
    const filed = await signedAppeal(0);
    expect(await addAppeal(db, { ...filed, campaignId: CAMPAIGN, textHash: appealTextHash(filed.text) }, NOW)).toBe('queued');
    expect(await takeAppeal(db, NOW, 300, 6)).toMatchObject({ wallet: walletOf(0) });
    const note = 'The hold rests on a funder count alone.';
    expect(await recordAppealCheck(db, { campaignId: CAMPAIGN, wallet: walletOf(0) }, { evalId: 'eval_1', route: 'block', note, creditsCharged: 4 }, NOW)).toBe(true);
    const send = campaignApp();
    const view = CampaignView.parse(JSON.parse((await send(`${CAMPAIGNS_PATH}/${CAMPAIGN}`)).text));
    expect(view.counts.appeals).toEqual({ filed: 1, checked: 1, block: 1, reversed: 0 });
    const appealed = AskView.parse(JSON.parse((await send(`${asks()}/${walletOf(0)}`)).text));
    expect(appealed.ask.appeal).toEqual({
      filedAt: NOW.toISOString(),
      checkStatus: 'checked',
      reppoRoute: 'block',
      reppoNote: note,
      reppoEvalId: 'eval_1',
      checkedAt: NOW.toISOString(),
      outcome: 'open',
      newAction: null,
      settledAt: null,
    });
    expect(AskView.parse(JSON.parse((await send(`${asks()}/${walletOf(1)}`)).text)).ask.appeal).toBeNull();
    const page = BoardPage.parse(JSON.parse((await send(`${CAMPAIGNS_PATH}/${CAMPAIGN}/board`)).text));
    expect(new Map(page.asks.map((ask) => [ask.wallet, ask.appeal?.reppoRoute ?? null]))).toEqual(
      new Map([
        [walletOf(0), 'block'],
        [walletOf(1), null],
      ]),
    );
    // A note from the other service is model text: one that is not plain text never leaves, even if it was stored.
    await db.query("UPDATE appeals SET reppo_note = '<img src=x onerror=alert(1)>' WHERE wallet = $1", [walletOf(0)]);
    expect(AskView.parse(JSON.parse((await send(`${asks()}/${walletOf(0)}`)).text)).ask.appeal?.reppoNote).toBeNull();
  });

  it('the appeals route answers queued, exists, approved, undecided, no ask, no campaign and each refusal, each in its shape', async () => {
    await createCampaign(db, terms());
    expect(await decided(0, 'hold')).toEqual({ slot: null });
    expect(await decided(1, 'full')).toEqual({ slot: 1 });
    expect(await decided(2, 'partial')).toEqual({ slot: 2 });
    expect(await addAsk(db, { campaignId: CAMPAIGN, wallet: walletOf(3), signedAt: NOW_SECONDS, signature: (await signedAsk(3)).signature }, NOW)).toBe('queued');
    const send = campaignApp();
    const at = (n: number) => `198.51.100.${100 + n}`;
    const queued = await send(appeals(), post(await signedAppeal(0)), at(0));
    expect([queued.status, queued.text]).toEqual([202, '{"queued":true}']);
    const again = await send(appeals(), post(await signedAppeal(0, { text: 'A second try.' })), at(1));
    expect(again.status).toBe(200);
    expect(ExistsAppealBody.parse(JSON.parse(again.text)).appeal).toMatchObject({ checkStatus: 'queued', outcome: 'open' });
    const answers: [number, string, Reply][] = [
      [202, '{"queued":true}', await send(appeals(), post(await signedAppeal(2)), at(2))],
      [409, '{"approved":true}', await send(appeals(), post(await signedAppeal(1)), at(3))],
      [409, '{"undecided":true}', await send(appeals(), post(await signedAppeal(3)), at(4))],
      [404, '{"error":"no ask from this wallet"}', await send(appeals(), post(await signedAppeal(5)), at(5))],
      [404, NO_CAMPAIGN, await send(appeals('nope'), post(await signedAppeal(0, { campaignId: 'nope' })), at(6))],
      [400, '{"error":"the signature is too old"}', await send(appeals(), post(await signedAppeal(4, { signedAt: NOW_SECONDS - 601 })), at(7))],
      [
        400,
        '{"error":"the appeal text contained a link, markup or control characters"}',
        await send(appeals(), post(await signedAppeal(4, { text: 'See https://evil.example' })), at(8)),
      ],
      [400, '{"error":"the appeal text is empty"}', await send(appeals(), post(await signedAppeal(4, { text: '   ' })), at(9))],
      [400, '{"error":"the body must be exactly {\\"wallet\\", \\"text\\", \\"signedAt\\", \\"signature\\"}"}', await send(appeals(), post({ ...(await signedAppeal(4)), extra: 1 }), at(10))],
      [400, '{"error":"the body must be JSON like {\\"wallet\\": \\"0x...\\", \\"text\\": \\"...\\", \\"signedAt\\": 0, \\"signature\\": \\"0x...\\"}"}', await send(appeals(), post('not json'), at(11))],
      [413, '{"error":"the body is too large"}', await send(appeals(), post({ ...(await signedAppeal(4)), text: 'x'.repeat(2_100) }), at(12))],
    ];
    for (const [status, text, reply] of answers) expect([reply.status, reply.text]).toEqual([status, text]);
    expect((await db.query('SELECT wallet FROM appeals ORDER BY wallet')).length).toBe(2);
  });

  it('C24, C42: a caller files two appeals an hour, the day takes 20, and the 21st is 429 with Retry-After to midnight', async () => {
    await createCampaign(db, terms());
    for (const n of [0, 1, 2, 3, 4]) expect(await decided(n, 'hold')).toEqual({ slot: null });
    const send = campaignApp();
    expect(APPEALS_PER_CALLER_HOUR).toBe(2);
    const one = '198.51.100.120';
    expect((await send(appeals(), post(await signedAppeal(0)), one)).status).toBe(202);
    expect((await send(appeals(), post(await signedAppeal(1)), one)).status).toBe(202);
    const third = await send(appeals(), post(await signedAppeal(2)), one);
    expect([third.status, third.text, third.retryAfter]).toEqual([429, '{"busy":true}', null]);
    expect((await db.query('SELECT wallet FROM appeals WHERE wallet = $1', [walletOf(2)])).length).toBe(0);

    // Stands in for the appeals other campaigns filed today.
    await db.query('UPDATE day_counts SET count = $1 WHERE name = $2', [APPEALS_DAY_MAX - 1, APPEALS_DAY_COUNTER]);
    expect((await send(appeals(), post(await signedAppeal(2)), '198.51.100.121')).status).toBe(202);
    const past = await send(appeals(), post(await signedAppeal(3)), '198.51.100.122');
    expect([past.status, past.text, past.retryAfter]).toEqual([429, '{"busy":true}', '43200']);
    expect((await db.query('SELECT wallet FROM appeals WHERE wallet = $1', [walletOf(3)])).length).toBe(0);
  });

  it('C9: a contract wallet on either chain cannot appeal, an unreadable one is refused, and a bad signature reads no chain', async () => {
    await createCampaign(db, terms());
    for (const n of [0, 1, 2, 3]) expect(await decided(n, 'hold')).toEqual({ slot: null });
    let reads = 0;
    const counting = (contract: boolean, failing = false) => async () => {
      reads += 1;
      if (failing) throw new Error('the code read timed out');
      return contract;
    };
    const reader = (contract: boolean, failing = false): VaultReader => ({ ...NO_CODE, isContract: counting(contract, failing) });
    const cases: [ReturnType<typeof campaignApp>, string][] = [
      [campaignApp({ isContract: counting(true), vault: () => reader(false) }), 'contract wallets cannot appeal yet'],
      [campaignApp({ isContract: counting(false), vault: () => reader(true) }), 'contract wallets cannot appeal yet'],
      [campaignApp({ isContract: counting(false), vault: () => reader(false, true) }), 'the wallet type could not be checked'],
    ];
    for (const [index, [send, cause]] of cases.entries()) {
      const reply = await send(appeals(), post(await signedAppeal(index)), `198.51.100.${130 + index}`);
      expect([reply.status, JSON.parse(reply.text)]).toEqual([400, { error: cause }]);
    }
    expect(reads).toBe(6);
    reads = 0;
    const stranger = await signedAppeal(3, { wallet: walletOf(0) });
    const send = campaignApp({ isContract: counting(false), vault: () => reader(false) });
    const forged = await send(appeals(), post(stranger), '198.51.100.140');
    expect([forged.status, JSON.parse(forged.text)]).toEqual([400, { error: 'the signature does not match this appeal' }]);
    expect(reads).toBe(0);
    expect(await db.query('SELECT wallet FROM appeals')).toEqual([]);
  });

  it('C7, C8: an appeal signature never works as an ask, an ask signature never works as an appeal', async () => {
    await createCampaign(db, terms());
    expect(await decided(0, 'hold')).toEqual({ slot: null });
    const send = campaignApp();
    const appealSigned = await signedAppeal(0);
    const asAsk = await send(asks(), post({ wallet: appealSigned.wallet, signedAt: appealSigned.signedAt, signature: appealSigned.signature }), '198.51.100.150');
    expect([asAsk.status, JSON.parse(asAsk.text)]).toEqual([400, { error: 'the signature does not match this ask' }]);
    const askSigned = await signedAsk(0);
    const asAppeal = await send(appeals(), post({ ...askSigned, text: APPEAL_TEXT }), '198.51.100.151');
    expect([asAppeal.status, JSON.parse(asAppeal.text)]).toEqual([400, { error: 'the signature does not match this appeal' }]);
    // The same signature over other text is refused too: the server hashes the text it was sent (C8).
    const otherText = await send(appeals(), post({ ...appealSigned, text: 'A different line.' }), '198.51.100.152');
    expect([otherText.status, JSON.parse(otherText.text)]).toEqual([400, { error: 'the signature does not match this appeal' }]);
    expect(await db.query('SELECT wallet FROM appeals')).toEqual([]);
  });

  it('C42: appeals share the asks\' minute, and a limiter or store that cannot be read refuses with 503 and writes nothing', async () => {
    await createCampaign(db, terms());
    expect(await decided(0, 'hold')).toEqual({ slot: null });
    const send = campaignApp();
    for (let index = 0; index < ASK_CLIENT_MAX_PER_MINUTE; index += 1) {
      expect((await send(asks(), post('not json'), '198.51.100.160')).status).toBe(400);
    }
    const shared = await send(appeals(), post(await signedAppeal(0)), '198.51.100.160');
    expect([shared.status, shared.text]).toEqual([429, '{"busy":true}']);

    const logs = captureLogs();
    const down: Db = { query: async () => Promise.reject(storeDown()), transaction: async () => Promise.reject(storeDown()), close: async () => undefined };
    let transactions = 0;
    const failingAfter = (allowed: number): Db => ({
      query: (text, params) => db.query(text, params),
      transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
        transactions += 1;
        if (transactions > allowed) throw storeDown();
        return db.transaction(fn);
      },
      close: async () => undefined,
    });
    const replies = [await campaignApp({ db: down })(appeals(), post(await signedAppeal(0)), '198.51.100.161')];
    for (const allowed of [0, 1, 2]) {
      transactions = 0;
      replies.push(await campaignApp({ db: failingAfter(allowed) })(appeals(), post(await signedAppeal(0)), `198.51.100.${162 + allowed}`));
    }
    logs.restore();
    for (const reply of replies) expect([reply.status, reply.text]).toEqual([503, '{"busy":true}']);
    expect(await db.query('SELECT wallet FROM appeals')).toEqual([]);
    expectNoDatabaseUrl(logs.text());
  });

  it('C40: no answer from any campaign route, and no log line, holds an appeal\'s text, hash, signature or owner note', async () => {
    await createCampaign(db, terms());
    expect(await decided(0, 'hold')).toEqual({ slot: null });
    const logs = captureLogs();
    const send = campaignApp();
    const filed = await signedAppeal(0, { text: 'Only the owner may read this line.' });
    expect((await send(appeals(), post(filed), '198.51.100.170')).status).toBe(202);
    expect(await takeAppeal(db, NOW, 300, 6)).toMatchObject({ wallet: walletOf(0) });
    expect(await recordAppealCheck(db, { campaignId: CAMPAIGN, wallet: walletOf(0) }, { evalId: 'eval_7', route: 'review', note: 'Worth a second look.', creditsCharged: 2 }, NOW)).toBe(true);
    const ownerNote = 'Owner note that stays private.';
    expect(await settleAppeal(db, { campaignId: CAMPAIGN, wallet: walletOf(0), outcome: 'upheld', newAction: null, ownerNote }, NOW)).toEqual({ slot: null });
    const replies = [
      await send(appeals(), post(filed), '198.51.100.171'),
      await send(`${CAMPAIGNS_PATH}/${CAMPAIGN}`),
      await send(`${CAMPAIGNS_PATH}/${CAMPAIGN}/board`),
      await send(`${asks()}/${walletOf(0)}`),
      await send(`${CAMPAIGNS_PATH}/${CAMPAIGN}/lists/1`),
    ];
    logs.restore();
    expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200, 200, 404]);
    const hidden = [filed.text, appealTextHash(filed.text), filed.signature.slice(2), ownerNote];
    for (const text of [...replies.map((reply) => reply.text), logs.text()]) {
      for (const secret of hidden) expect(text).not.toContain(secret);
    }
    expect(JSON.parse(replies[0]?.text ?? '{}')).toMatchObject({ exists: true, appeal: { outcome: 'upheld', reppoNote: 'Worth a second look.' } });
  });


  it('C42: past 600 chain reads a minute a ticket goes out without claimed and claimable, and amounts are kept 15 seconds', async () => {
    await createCampaign(db, terms());
    expect(await decided(0, 'full')).toEqual({ slot: 1 });
    await publish([{ index: 0, action: 'full' }]);
    let reads = 0;
    const reader: VaultReader = {
      ...NO_CODE,
      claimed: async () => {
        reads += 1;
        return 0n;
      },
      claimable: async (_vault, _account, amount) => {
        reads += 1;
        return amount;
      },
    };
    let clock = NOW;
    const send = campaignApp({ vault: () => reader, now: () => clock });
    const ticket = async () => AskView.parse(JSON.parse((await send(`${asks()}/${walletOf(0)}`)).text)).ticket;
    // Stands in for the tickets every caller read in the last minute, two chain reads each.
    await db.query(
      `INSERT INTO rate_events (bucket, client, at)
       SELECT 'campaign-chain-reads', 'all', $1::timestamptz FROM generate_series(1, $2::int)`,
      [NOW.toISOString(), CAMPAIGN_CHAIN_READS_PER_MINUTE / 2],
    );
    expect(Object.keys((await ticket()) ?? {}).sort()).toEqual(['cumulativeAmount', 'proof', 'root']);
    expect(reads).toBe(0);
    clock = new Date(NOW.getTime() + 61_000);
    expect(await ticket()).toMatchObject({ claimed: '0', claimable: '1000000' });
    expect(reads).toBe(2);
    clock = new Date(NOW.getTime() + 61_000 + 14_999);
    expect(await ticket()).toMatchObject({ claimed: '0', claimable: '1000000' });
    expect(reads).toBe(2);
    clock = new Date(NOW.getTime() + 61_000 + 15_000);
    expect(await ticket()).toMatchObject({ claimed: '0', claimable: '1000000' });
    expect(reads).toBe(4);
  });

  it('C1: the caches never serve one wallet, vault or version what was read for another', async () => {
    const otherVault = parseAddress('0x00000000000000000000000000000000000b0b0b');
    await createCampaign(db, terms());
    await createCampaign(db, terms({ id: 'twin', vault: otherVault }));
    expect(await decided(0, 'full')).toEqual({ slot: 1 });
    expect(await decided(1, 'partial')).toEqual({ slot: 2 });
    expect(await decided(0, 'full', undefined, 'twin')).toEqual({ slot: 1 });
    const first = await publish([
      { index: 0, action: 'full' },
      { index: 1, action: 'partial' },
    ]);
    const twin = await publish([{ index: 0, action: 'full' }], true, 'twin', otherVault);
    const lastByte = (account: string) => BigInt(`0x${account.slice(-2)}`);
    const reader: VaultReader = {
      ...NO_CODE,
      claimed: async (vault, account) => (vault === otherVault ? 7n : 0n) + lastByte(account),
      claimable: async (vault, _account, amount) => amount - (vault === otherVault ? 1n : 0n),
    };
    const send = campaignApp({ vault: () => reader });
    const ticketOf = async (path: string) => AskView.parse(JSON.parse((await send(path)).text)).ticket;
    const proves = (root: string, vault: string, wallet: string, amount: bigint, proof: string[] | undefined) =>
      StandardMerkleTree.verify(root, LEAF_TYPES, leafValues(CHAIN, vault, wallet, amount), proof ?? []);

    const mine = await ticketOf(`${asks()}/${walletOf(0)}`);
    const theirs = await ticketOf(`${asks()}/${walletOf(1).toLowerCase()}`);
    expect(mine).toMatchObject({ cumulativeAmount: '1000000', root: first.root, claimed: String(lastByte(walletOf(0))), claimable: '1000000' });
    expect(theirs).toMatchObject({ cumulativeAmount: '500000', root: first.root, claimed: String(lastByte(walletOf(1))), claimable: '500000' });
    expect(proves(first.root, VAULT, walletOf(0), 1_000_000n, mine?.proof)).toBe(true);
    expect(proves(first.root, VAULT, walletOf(1), 500_000n, theirs?.proof)).toBe(true);
    expect(proves(first.root, VAULT, walletOf(1), 500_000n, mine?.proof)).toBe(false);

    const elsewhere = await ticketOf(`${asks('twin')}/${walletOf(0)}`);
    expect(elsewhere).toMatchObject({ root: twin.root, claimed: String(7n + lastByte(walletOf(0))), claimable: '999999' });
    expect(proves(twin.root, otherVault, walletOf(0), 1_000_000n, elsewhere?.proof)).toBe(true);
    expect(await ticketOf(`${asks()}/${walletOf(0)}`)).toEqual(mine);

    // A newer active version is a new key: its own amount, root and vault read, well inside the 15 seconds.
    const second = await publish([
      { index: 0, action: 'partial' },
      { index: 1, action: 'full' },
    ]);
    const moved = await ticketOf(`${asks()}/${walletOf(0)}`);
    expect(moved).toMatchObject({ cumulativeAmount: '500000', root: second.root, claimable: '500000' });
    expect(proves(second.root, VAULT, walletOf(0), 500_000n, moved?.proof)).toBe(true);
  });

  it('C32: the ticket proves against the active root, a version not yet active gives none, and a list is served byte for byte', async () => {
    await createCampaign(db, terms());
    expect(await decided(0, 'full')).toEqual({ slot: 1 });
    expect(await decided(1, 'partial')).toEqual({ slot: 2 });
    expect(await decided(2, 'full')).toEqual({ slot: 3 });
    const first = await publish([
      { index: 0, action: 'full' },
      { index: 1, action: 'partial' },
    ]);
    const second = await publish(
      [
        { index: 0, action: 'full' },
        { index: 1, action: 'partial' },
        { index: 2, action: 'full' },
      ],
      false,
    );
    const reader: VaultReader = { ...NO_CODE, claimed: async () => 0n, claimable: async (_vault, _account, amount) => amount };
    const send = campaignApp({ vault: (chainId) => (chainId === CHAIN ? reader : null) });

    for (const [index, amount] of [
      [0, 1_000_000n],
      [1, 500_000n],
    ] as const) {
      const reply = await send(`${asks()}/${walletOf(index).toLowerCase()}`);
      const view = AskView.parse(JSON.parse(reply.text));
      expect(view.ticket).toMatchObject({ root: first.root, cumulativeAmount: amount.toString(), claimed: '0', claimable: amount.toString() });
      const leaf = leafValues(CHAIN, VAULT, walletOf(index), amount);
      expect(StandardMerkleTree.verify(first.root, LEAF_TYPES, leaf, view.ticket?.proof ?? [])).toBe(true);
      expect(StandardMerkleTree.verify(first.root, LEAF_TYPES, leafValues(CHAIN, VAULT, walletOf(index), amount + 1n), view.ticket?.proof ?? [])).toBe(
        false,
      );
    }
    const posted = AskView.parse(JSON.parse((await send(`${asks()}/${walletOf(2)}`)).text));
    expect(posted.ask.slot).toBe(3);
    expect(posted.ticket).toBeUndefined();

    const unread = AskView.parse(JSON.parse((await campaignApp({ vault: () => null })(`${asks()}/${walletOf(0)}`)).text));
    expect(Object.keys(unread.ticket ?? {}).sort()).toEqual(['cumulativeAmount', 'proof', 'root']);
    const failing = campaignApp({ vault: () => ({ ...NO_CODE, claimed: async () => Promise.reject(new Error('rpc down')), claimable: async () => 1n }) });
    const logs = captureLogs();
    const failed = AskView.parse(JSON.parse((await failing(`${asks()}/${walletOf(0)}`)).text));
    logs.restore();
    expect(Object.keys(failed.ticket ?? {}).sort()).toEqual(['cumulativeAmount', 'proof', 'root']);

    for (const list of [first, second]) {
      const reply = await send(`${CAMPAIGNS_PATH}/${CAMPAIGN}/lists/${list.version}`);
      expect([reply.status, reply.type, reply.text]).toEqual([200, 'application/json', list.text]);
    }
    for (const missing of ['3', '0', 'abc', '1.0', '99999999999']) {
      const reply = await send(`${CAMPAIGNS_PATH}/${CAMPAIGN}/lists/${missing}`);
      expect([reply.status, reply.text]).toEqual([404, '{"error":"no such list version"}']);
    }
  });

  it('C33: a reason with markup cannot be stored, and the board returns reasons unchanged as strings', async () => {
    await createCampaign(db, terms());
    await expect(decided(0, 'hold', 'Held: <b>bold</b>')).rejects.toThrow(StoreError);
    const reason = 'Funded by "Binance 14" & swept twice; café 🙂 \\ it\'s 100% plain.';
    expect(await decided(1, 'hold', reason)).toEqual({ slot: null });
    const send = campaignApp();
    const page = BoardPage.parse(JSON.parse((await send(`${CAMPAIGNS_PATH}/${CAMPAIGN}/board`)).text));
    expect(page.asks.map((ask) => ask.reason)).toEqual([reason]);
    expect(typeof page.asks[0]?.reason).toBe('string');
    const earlier = await send(`${CAMPAIGNS_PATH}/${CAMPAIGN}/board?before=${NOW.toISOString()}`);
    expect(BoardPage.parse(JSON.parse(earlier.text))).toEqual({ asks: [] });
    const badTime = await send(`${CAMPAIGNS_PATH}/${CAMPAIGN}/board?before=yesterday`);
    expect(badTime.status).toBe(400);
  });

  it('C34: walking the board page by page returns every ask exactly once, a page running on through a tie still in shape', async () => {
    await createCampaign(db, terms());
    // 48 asks at their own instants, then 5 decided together across the 50th place, then 2 older ones.
    const times = [...Array.from({ length: 48 }, (_, n) => 1_000 - n), 500, 500, 500, 500, 500, 400, 300];
    const wallets = times.map((_, n) => parseAddress(`0x${(0xbeef0000 + n).toString(16).padStart(40, '0')}`));
    for (const [n, seconds] of times.entries()) {
      await db.query(
        `INSERT INTO asks (campaign_id, wallet, signed_at, signature, asked_at, status, attempts)
         VALUES ($1, $2, $3::bigint, $4, $5::timestamptz, 'queued', 0)`,
        [CAMPAIGN, wallets[n], String(NOW_SECONDS), `0x${'ab'.repeat(65)}`, NOW.toISOString()],
      );
      expect(await takeAsk(db, NOW, 60, 3)).toMatchObject({ wallet: wallets[n] });
      const at = new Date(NOW.getTime() + seconds * 1000);
      const result = await decideAsk(
        db,
        {
          campaignId: CAMPAIGN,
          wallet: wallets[n] as string,
          action: 'hold',
          shareBps: 0,
          rule: 'A9',
          reason: 'Held while the funder is checked.',
          citedTxs: [],
          notChecked: [],
          facts: { ageDays: 3, txCount: 1, accountType: 'eoa', funder: null, burstWallets: null, groupSize: null, missing: [] },
          servRequestId: null,
        },
        at,
      );
      expect(result).toEqual({ slot: null });
    }
    const send = campaignApp();
    const pages: string[][] = [];
    let path = `${CAMPAIGNS_PATH}/${CAMPAIGN}/board`;
    for (let page = 0; page < 10; page += 1) {
      const reply = await send(path);
      expect(reply.status, reply.text).toBe(200);
      const parsed = BoardPage.safeParse(JSON.parse(reply.text));
      expect(parsed.success).toBe(true);
      const asks = parsed.success ? parsed.data.asks : [];
      if (asks.length === 0) break;
      pages.push(asks.map((ask) => ask.wallet));
      path = `${CAMPAIGNS_PATH}/${CAMPAIGN}/board?before=${asks.at(-1)?.decidedAt}`;
    }
    expect(pages.map((page) => page.length)).toEqual([53, 2]);
    const walked = pages.flat();
    expect(walked).toHaveLength(wallets.length);
    expect(new Set(walked)).toEqual(new Set(wallets));
  });

  it('an ask to a closed campaign is 409 closed, and every route for an unknown id is the same 404', async () => {
    await createCampaign(db, terms({ status: 'closed' }));
    const send = campaignApp();
    const closed = await send(asks(), post(await signedAsk(0)));
    expect([closed.status, closed.text]).toEqual([409, '{"closed":true}']);
    expect(await rows('asks')).toBe(0);

    const strange = encodeURIComponent("'; drop table asks; --");
    const replies = [
      await send(`${CAMPAIGNS_PATH}/nope`),
      await send(`${CAMPAIGNS_PATH}/${strange}`),
      await send(`${CAMPAIGNS_PATH}/nope/board?before=not-a-time`),
      await send(asks('nope'), post('not json')),
      await send(asks('nope'), post(await signedAsk(1))),
      await send(asks('nope'), post({ wallet: 'x'.repeat(5_000) })),
      await send(`${asks('nope')}/not-an-address`),
      await send(`${asks('nope')}/${walletOf(1)}`),
      await send(`${CAMPAIGNS_PATH}/nope/lists/abc`),
      await send(`${CAMPAIGNS_PATH}/${'x'.repeat(300)}/lists/1`),
    ];
    for (const reply of replies) expect([reply.status, reply.text]).toEqual([404, NO_CAMPAIGN]);
  });

  it('fail closed: a store that throws gives 503 busy on every campaign route and writes nothing', async () => {
    await createCampaign(db, terms());
    const logs = captureLogs();
    const down: Db = {
      query: async () => Promise.reject(storeDown()),
      transaction: async () => Promise.reject(storeDown()),
      close: async () => undefined,
    };
    const send = campaignApp({ db: down });
    const replies = [
      await send(`${CAMPAIGNS_PATH}/${CAMPAIGN}`),
      await send(`${CAMPAIGNS_PATH}/${CAMPAIGN}/board`),
      await send(asks(), post(await signedAsk(0))),
      await send(`${asks()}/${walletOf(0)}`),
      await send(`${CAMPAIGNS_PATH}/${CAMPAIGN}/lists/1`),
    ];
    for (const reply of replies) expect([reply.status, reply.text]).toEqual([503, '{"busy":true}']);

    // Reads work and the third transaction, the ask itself, fails: still 503, and no ask is written.
    let transactions = 0;
    const writesFail: Db = {
      query: (text, params) => db.query(text, params),
      transaction: async <T>(fn: (tx: Queryable) => Promise<T>) => {
        transactions += 1;
        if (transactions >= 3) throw storeDown();
        return db.transaction(fn);
      },
      close: async () => undefined,
    };
    const late = await campaignApp({ db: writesFail })(asks(), post(await signedAsk(1)));
    expect([late.status, late.text]).toEqual([503, '{"busy":true}']);
    expect(transactions).toBe(3);
    expect(await rows('asks')).toBe(0);
    expectNoDatabaseUrl(logs.text());
    logs.restore();
  });

  it('C34, C40: every answer parses as its strict shape with no extra key, and no answer holds a stored signature', async () => {
    await createCampaign(db, terms());
    await createCampaign(db, terms({ id: 'shut', status: 'closed' }));
    await createCampaign(db, terms({ id: 'one', maxSlots: 1 }));
    expect(await decided(11, 'full', undefined, 'one')).toEqual({ slot: 1 });
    expect(await decided(0, 'full')).toEqual({ slot: 1 });
    await publish([{ index: 0, action: 'full' }]);
    const send = campaignApp({ vault: () => ({ ...NO_CODE, claimed: async () => 0n, claimable: async () => 1_000_000n }) });
    const logs = captureLogs();
    const checked: [z.ZodType, Reply][] = [
      [CampaignView, await send(`${CAMPAIGNS_PATH}/${CAMPAIGN}`)],
      [ErrorBody, await send(`${CAMPAIGNS_PATH}/missing`)],
      [BoardPage, await send(`${CAMPAIGNS_PATH}/${CAMPAIGN}/board`)],
      [ErrorBody, await send(`${CAMPAIGNS_PATH}/${CAMPAIGN}/board?before=soon`)],
      [QueuedBody, await send(asks(), post(await signedAsk(1)), '192.0.2.21')],
      [ExistsBody, await send(asks(), post(await signedAsk(1)), '192.0.2.22')],
      [ErrorBody, await send(asks(), post(await signedAsk(2, { signedAt: NOW_SECONDS + 3_600 })), '192.0.2.23')],
      [ErrorBody, await send(asks(), post({ ...(await signedAsk(2)), extra: true }), '192.0.2.24')],
      [ErrorBody, await send(asks(), post({ wallet: walletOf(2), signedAt: NOW_SECONDS, signature: 'x'.repeat(2_000) }), '192.0.2.25')],
      [ClosedBody, await send(asks('shut'), post(await signedAsk(3, { campaignId: 'shut' })), '192.0.2.26')],
      [FullBody, await send(asks('one'), post(await signedAsk(5, { campaignId: 'one' })), '192.0.2.28')],
      [AskView, await send(`${asks()}/${walletOf(0)}`)],
      [AskView, await send(`${asks()}/${walletOf(1)}`)],
      [ErrorBody, await send(`${asks()}/${walletOf(9)}`)],
      [ErrorBody, await send(`${asks()}/0x1234`)],
      [ErrorBody, await send(`${CAMPAIGNS_PATH}/${CAMPAIGN}/lists/7`)],
      [BusyBody, await campaignApp({ db: { query: async () => Promise.reject(storeDown()), transaction: async () => Promise.reject(storeDown()), close: async () => undefined } })(`${CAMPAIGNS_PATH}/${CAMPAIGN}`)],
    ];
    for (let index = 0; index <= ASK_CLIENT_MAX_PER_MINUTE; index += 1) {
      const reply = await send(asks(), post(UNSIGNED), '192.0.2.27');
      if (index === ASK_CLIENT_MAX_PER_MINUTE) checked.push([BusyBody, reply]);
    }
    logs.restore();
    expect(checked.map(([, reply]) => reply.status)).toEqual([
      200, 404, 200, 400, 202, 200, 400, 400, 413, 409, 409, 200, 200, 404, 400, 404, 503, 429,
    ]);
    for (const [shape, reply] of checked) {
      expect(reply.type).toContain('application/json');
      expect(shape.safeParse(JSON.parse(reply.text)).success, reply.text).toBe(true);
    }
    const ticketed = AskView.parse(JSON.parse((checked[11] as [z.ZodType, Reply])[1].text));
    expect(ticketed.ticket).toMatchObject({ claimed: '0', claimable: '1000000' });

    const signatures = (await db.query<{ signature: string }>('SELECT signature FROM asks')).map((row) => row.signature);
    expect(signatures.length).toBeGreaterThanOrEqual(2);
    const everything = seen.join('\n').toLowerCase();
    for (const signature of signatures) expect(everything).not.toContain(signature.slice(2).toLowerCase());
    for (const text of seen) expect(text).not.toMatch(/"(signature|signedAt|leaseUntil|lease_until|attempts|client)"/);
  });
});

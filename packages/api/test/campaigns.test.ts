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
  addListVersion,
  createCampaign,
  decideAsk,
  markListActive,
  markListPosted,
  migrate,
  openMemoryDb,
  StoreError,
  takeAsk,
  type CampaignInput,
  type Db,
  type Queryable,
} from '@thuli/store';
import { buildClaimList } from '@thuli/worker/src/vault/claimList.ts';
import { buildRoot, publishList } from '@thuli/worker/src/vault/root.ts';
import { createApp } from '../src/app.ts';
import {
  ASK_CLIENT_MAX_PER_MINUTE,
  CAMPAIGN_ASKS_DAY_COUNTER,
  CAMPAIGN_ASKS_DAY_MAX,
  CAMPAIGN_CHAIN_READS_PER_MINUTE,
  CAMPAIGN_READS_PER_MINUTE,
  CAMPAIGNS_PATH,
  type CampaignDeps,
  type VaultReader,
} from '../src/campaigns.ts';
import { AskView, BoardPage, BusyBody, CampaignView, ClosedBody, ErrorBody, ExistsBody, FullBody, QueuedBody } from '../src/schema.ts';
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
    await db.query('TRUNCATE claim_relays, list_versions, asks, campaigns, rate_events, day_counts');
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

  it('C24: 300 asks a UTC day across campaigns, then 429 with Retry-After to midnight; exists, closed and full asks use none', async () => {
    await createCampaign(db, terms());
    await createCampaign(db, terms({ id: 'shut', status: 'closed' }));
    await createCampaign(db, terms({ id: 'one', maxSlots: 1 }));
    expect(await decided(10, 'full', undefined, 'one')).toEqual({ slot: 1 });
    const today = async (day = '2026-11-11') => {
      const [row] = await db.query<{ count: number }>('SELECT count FROM day_counts WHERE name = $1 AND day = $2::date', [
        CAMPAIGN_ASKS_DAY_COUNTER,
        day,
      ]);
      return row?.count ?? 0;
    };
    const send = campaignApp();
    expect((await send(asks(), post(await signedAsk(0)), '198.51.100.40')).status).toBe(202);
    expect(await today()).toBe(1);
    // Stands in for the asks other campaigns already took today.
    await db.query('UPDATE day_counts SET count = $1 WHERE name = $2', [CAMPAIGN_ASKS_DAY_MAX - 1, CAMPAIGN_ASKS_DAY_COUNTER]);
    const answers = [
      await send(asks(), post(await signedAsk(0)), '198.51.100.41'),
      await send(asks('shut'), post(await signedAsk(1, { campaignId: 'shut' })), '198.51.100.42'),
      await send(asks('one'), post(await signedAsk(2, { campaignId: 'one' })), '198.51.100.43'),
      await send(asks(), post(UNSIGNED), '198.51.100.44'),
    ];
    expect(answers.map((reply) => reply.status)).toEqual([200, 409, 409, 400]);
    expect(answers.slice(1, 3).map((reply) => reply.text)).toEqual(['{"closed":true}', '{"full":true}']);
    expect(await today()).toBe(CAMPAIGN_ASKS_DAY_MAX - 1);
    expect((await send(asks(), post(await signedAsk(3)), '198.51.100.45')).status).toBe(202);
    expect(await today()).toBe(CAMPAIGN_ASKS_DAY_MAX);
    const refusedToday = await send(asks(), post(await signedAsk(4)), '198.51.100.46');
    expect([refusedToday.status, refusedToday.text, refusedToday.retryAfter]).toEqual([429, '{"busy":true}', '43200']);
    expect(await today()).toBe(CAMPAIGN_ASKS_DAY_MAX);
    expect((await db.query('SELECT wallet FROM asks WHERE wallet = $1', [walletOf(4)])).length).toBe(0);

    // Half a second before midnight Retry-After is the one second left, and the next UTC day starts from zero.
    const lateAt = new Date('2026-11-11T23:59:59.500Z');
    const late = await campaignApp({ now: () => lateAt })(
      asks(),
      post(await signedAsk(4, { signedAt: Math.floor(lateAt.getTime() / 1000) })),
      '198.51.100.47',
    );
    expect([late.status, late.retryAfter]).toEqual([429, '1']);
    const nextAt = new Date('2026-11-12T00:00:01.000Z');
    const next = await campaignApp({ now: () => nextAt })(
      asks(),
      post(await signedAsk(4, { signedAt: Math.floor(nextAt.getTime() / 1000) })),
      '198.51.100.48',
    );
    expect(next.status).toBe(202);
    expect(await today('2026-11-12')).toBe(1);
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

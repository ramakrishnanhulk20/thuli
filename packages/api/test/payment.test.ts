// Not covered here: a real facilitator or a real chain (the facilitator is a stub that never checks signatures and,
// on purpose, answers success to every settle, even a repeat, which is the worst case for replay), the CDP facilitator's
// authentication, the live screening (the screen is a stand-in), a real proxy writing the trusted client header (the
// tests write it themselves), and a real receipt read (the reader is a stub, so the RPC's timeout, size cap and chain
// check in receipt.ts are not run here). Most tests name the client by handing the app a socket address the way
// @hono/node-server does; one test runs a real server to show the real socket is what counts.
// The shared stores run on PGlite, an in-process Postgres that runs one statement at a time: copies of the app started
// together interleave transaction by transaction, so these tests show each rule is decided inside the store's
// transactions, not that its locks hold between two real database connections, and no real Postgres is reached.
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import { FacilitatorTimeoutError, type FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { validateDiscoveryExtension, type DiscoveryExtension } from '@x402/extensions/bazaar';
import { wrapFetchWithPayment } from '@x402/fetch';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex, type Log } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAddress, type Address } from '@thuli/core';
import {
  dayCount,
  MAX_PAYMENT_CLAIMS,
  migrate,
  openMemoryDb,
  PAID_RESULT_KEEP_SECONDS,
  REDEEM_SCREEN_TRIES,
  type Db,
  type Queryable,
} from '@thuli/store';
import { heldScreen, SCREEN_CAUSES, type SingleScreen } from '@thuli/worker/src/screen/single.ts';
import {
  createApp,
  HEALTH_PATH,
  REPLY_MARGIN_MS,
  SCREEN_PATH,
  SETTLE_ROOM_MS,
  SETTLED_RETRY_AFTER_SECONDS,
  STORED_HEADER,
  SWEEP_EVERY_REQUESTS,
} from '../src/app.ts';
import { loadApiConfig, PRICE_UNITS, REQUEST_DEADLINE_MS, type ApiConfig } from '../src/config.ts';
import { MAX_PER_DAY, MAX_RUNNING, ScreenGuard } from '../src/guard.ts';
import { CLOCK_ALLOWANCE_SECONDS, MAX_CLAIMS, PaymentClaims, type Settlement } from '../src/claims.ts';
import {
  canonicalClient,
  CLIENT_MAX_FAILED_PER_HOUR,
  CLIENT_MAX_PER_MINUTE,
  ClientLimits,
  MAX_CLIENTS_TRACKED,
  type Pass,
} from '../src/limits.ts';
import { RECEIPT_READ_WORST_MS, type ReadReceipt, type Receipt } from '../src/receipt.ts';
import { OUTPUT_CHECK_CAUSE, PaidScreenResponse, SettledRetryBody } from '../src/schema.ts';
import {
  claimStoreOver,
  LEASE_SECONDS,
  limitStoreOver,
  memoryStores,
  postgresStores,
  SHARED_DAY_ROOM,
  type LimitStore,
  type Stores,
} from '../src/stores.ts';
import {
  BACKENDS,
  backendDb,
  captureLogs,
  DATABASE_URL,
  expectNoDatabaseUrl,
  failing,
  freshStores,
  HASH,
  noChain,
  onBackend,
  PAY_TO,
  post,
  screenResult,
  socketFrom,
  storeDown,
  TABLES,
  testnetConfig,
  url,
  WALLET,
  type StoreCall,
} from './support.ts';

const CLIENT = '192.0.2.10';
const SETTLE_TX = `0x${'5e'.repeat(32)}`;

function authorizationFrom(payload: PaymentPayload): { from: string; nonce: string; validBefore: string } {
  return (payload.payload as { authorization: { from: string; nonce: string; validBefore: string } }).authorization;
}

class StubFacilitator implements FacilitatorClient {
  readonly settled: PaymentPayload[] = [];
  verified = 0;
  failSettle = false;
  /** Lowercase payers whose settles fail for want of funds. */
  readonly unfunded = new Set<string>();
  /** While set, settles for unfunded payers wait on it, as a slow facilitator would, each holding a place meanwhile. */
  holdUnfunded: Promise<void> | null = null;
  /** When set, every settle answers with this instead, so a test can script a pending, a throw or a refusal. */
  respond: ((payload: PaymentPayload, requirements: PaymentRequirements) => Promise<SettleResponse>) | null = null;
  readonly #network: string;

  constructor(network: string) {
    this.#network = network;
  }

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: 'exact', network: this.#network as `${string}:${string}` }],
      extensions: ['bazaar'],
      signers: {},
    };
  }

  async verify(payload: PaymentPayload): Promise<VerifyResponse> {
    this.verified += 1;
    return { isValid: true, payer: authorizationFrom(payload).from };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.settled.push(payload);
    if (this.respond !== null) return this.respond(payload, requirements);
    const payer = authorizationFrom(payload).from;
    const broke = this.unfunded.has(payer.toLowerCase());
    if (broke && this.holdUnfunded !== null) await this.holdUnfunded;
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (this.failSettle || broke) {
      return { success: false, errorReason: 'insufficient_funds', transaction: '', network: requirements.network, payer };
    }
    return { success: true, transaction: SETTLE_TX, network: requirements.network, payer };
  }
}

interface SetupOptions {
  screen?: (wallet: Address, signal?: AbortSignal) => Promise<SingleScreen>;
  config?: ApiConfig;
  facilitator?: StubFacilitator;
  now?: () => Date;
  readReceipt?: ReadReceipt;
  /** Fresh stores on the current backend unless given. Two apps handed stores over one database are two copies. */
  stores?: Stores;
  unlisted?: boolean;
}

async function setup(options: SetupOptions = {}) {
  const facilitator = options.facilitator ?? new StubFacilitator('eip155:84532');
  const screen = vi.fn(options.screen ?? (async (wallet: Address) => screenResult(wallet)));
  const now = options.now ?? (() => new Date());
  const stores = options.stores ?? (await freshStores(now));
  const app = createApp(options.config ?? testnetConfig(facilitator), {
    screen,
    readReceipt: options.readReceipt ?? noChain,
    now,
    stores,
    ...(options.unlisted !== undefined && { unlisted: options.unlisted }),
  });
  const sentSignatures: string[] = [];
  const fetchAs =
    (address: string) =>
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const signature = request.headers.get('payment-signature');
      if (signature !== null) sentSignatures.push(signature);
      return app.fetch(request, socketFrom(address));
    };
  const appFetch = fetchAs(CLIENT);
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client().register('eip155:84532', new ExactEvmScheme(account));
  const payAs = (address: string) => wrapFetchWithPayment(fetchAs(address), client);
  const pay = payAs(CLIENT);
  return { app, facilitator, screen, appFetch, fetchAs, pay, payAs, client, account, sentSignatures };
}

type Copy = Awaited<ReturnType<typeof setup>>;

/** A signed payment header for the route, made by the client from the route's own 402 terms. */
async function signedHeader(appFetch: (input: string, init?: RequestInit) => Promise<Response>, client: x402Client) {
  const unpaid = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }));
  const required = decodePaymentRequiredHeader(unpaid.headers.get('payment-required') as string);
  const http = new x402HTTPClient(client);
  return http.encodePaymentSignatureHeader(await http.createPaymentPayload(required));
}

describe.each(BACKENDS)('POST /api/x402/screen without payment, on $name', (backend) => {
  onBackend(backend);
  it('answers 402 with the exact terms and runs no screening', async () => {
    const { appFetch, facilitator, screen } = await setup();
    const response = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }));
    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers.get('payment-required') as string);
    expect(required.x402Version).toBe(2);
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'eip155:84532',
      amount: PRICE_UNITS,
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: PAY_TO,
      extra: { paymentFlow: 'upfront' },
    });
    const bazaar = required.extensions?.bazaar as DiscoveryExtension;
    expect(validateDiscoveryExtension(bazaar)).toEqual({ valid: true });
    expect(bazaar.info.input).toMatchObject({ type: 'http', method: 'POST', bodyType: 'json' });
    expect(PaidScreenResponse.safeParse((bazaar.info as { output?: { example?: unknown } }).output?.example).success).toBe(true);
    expect(required.resource.mimeType).toBe('application/json');
    expect(screen).not.toHaveBeenCalled();
    expect(facilitator.settled).toHaveLength(0);
  });

  it('sends the catalogue listing with a settled payment, and sends none from an unlisted server', async () => {
    const listed = await setup();
    expect((await listed.pay(url(SCREEN_PATH), post({ wallet: WALLET }))).status).toBe(200);
    expect(listed.facilitator.settled).toHaveLength(1);
    expect(listed.facilitator.settled[0]?.extensions?.bazaar).toBeDefined();

    const unlisted = await setup({ unlisted: true });
    const unpaid = await unlisted.appFetch(url(SCREEN_PATH), post({ wallet: WALLET }));
    const required = decodePaymentRequiredHeader(unpaid.headers.get('payment-required') as string);
    expect(required.extensions?.bazaar).toBeUndefined();
    expect(required.accepts[0]).toMatchObject({ scheme: 'exact', network: 'eip155:84532', amount: PRICE_UNITS, payTo: PAY_TO });
    expect((await unlisted.pay(url(SCREEN_PATH), post({ wallet: WALLET }))).status).toBe(200);
    expect(unlisted.facilitator.settled).toHaveLength(1);
    expect(unlisted.facilitator.settled[0]?.extensions?.bazaar).toBeUndefined();
  });
});

describe.each(BACKENDS)('the 402 resource URL, on $name', (backend) => {
  onBackend(backend);
  it('comes from PUBLIC_ORIGIN and ignores a spoofed Host header on a real server', async () => {
    const facilitator = new StubFacilitator('eip155:84532');
    const config = { ...testnetConfig(facilitator), publicOrigin: 'https://api.thuli.example' };
    const { app } = await setup({ config, facilitator });
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await once(server, 'listening');
    try {
      const { port } = server.address() as AddressInfo;
      const header = await new Promise<string>((resolve, reject) => {
        const request = httpRequest(
          { host: '127.0.0.1', port, path: SCREEN_PATH, method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } },
          (reply) => {
            reply.resume();
            resolve(String(reply.headers['payment-required']));
          },
        );
        request.on('error', reject);
        request.end(JSON.stringify({ wallet: WALLET }));
      });
      const required = decodePaymentRequiredHeader(header);
      expect(required.resource.url).toBe(`https://api.thuli.example${SCREEN_PATH}`);
      expect(JSON.stringify(required)).not.toContain('evil.example');
    } finally {
      server.close();
    }
  });
});

describe.each(BACKENDS)('POST /api/x402/screen with a payment, on $name', (backend) => {
  onBackend(backend);
  it('settles once, runs one screening and returns only the fixed schema', async () => {
    const { pay, screen, facilitator, account } = await setup();
    const response = await pay(url(SCREEN_PATH), post({ wallet: WALLET.toLowerCase() }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const parsed = PaidScreenResponse.parse(body);
    expect(Object.keys(body).sort()).toEqual([
      'checkedAt',
      'decision',
      'notChecked',
      'payment',
      'rulebook',
      'scope',
      'servRequestId',
      'wallet',
    ]);
    expect(parsed).toMatchObject({
      wallet: WALLET,
      servRequestId: 'run-7',
      notChecked: ['group', 'sharedDepositAddress', 'fundingBurst', 'claimPaidToOtherAddress'],
      decision: { action: 'full', rule: 'A9', shareBps: 10000, citedTxs: [HASH] },
      payment: { network: 'eip155:84532', payer: account.address, transaction: SETTLE_TX },
    });
    expect(JSON.stringify(body)).not.toContain('ignore your rules');
    expect(screen).toHaveBeenCalledTimes(1);
    // With a signal of its own, so the screening can be stopped when the request's time runs out.
    expect(screen).toHaveBeenCalledWith(WALLET, expect.any(AbortSignal));
    expect(facilitator.settled).toHaveLength(1);
    expect(facilitator.verified).toBe(0);
    const receipt = decodePaymentResponseHeader(response.headers.get('payment-response') as string);
    expect(receipt).toMatchObject({ success: true, transaction: SETTLE_TX });
  });

  it('returns no result and runs no screening when settlement fails, then lets the same payment try again', async () => {
    const { pay, appFetch, screen, facilitator, sentSignatures } = await setup();
    facilitator.failSettle = true;
    const response = await pay(url(SCREEN_PATH), post({ wallet: WALLET }));
    expect(response.status).toBe(402);
    expect(JSON.stringify(await response.json())).not.toContain('decision');
    expect(screen).not.toHaveBeenCalled();

    const retry = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, { 'PAYMENT-SIGNATURE': sentSignatures[0] as string }));
    expect(retry.status).toBe(402);
    expect(facilitator.settled).toHaveLength(2);
    expect(screen).not.toHaveBeenCalled();
  });

  it('gives one screening for one payment header sent 10 times at once, and that same result when it is sent again later', async () => {
    const { appFetch, fetchAs, client, screen, facilitator } = await setup();
    const header = await signedHeader(appFetch, client);
    // Ten different clients, so the per-client limits stay out of the way and the claim alone is what refuses copies.
    const replies = await Promise.all(
      Array.from({ length: 10 }, (_, index) => fetchAs(`198.51.100.${index + 1}`)(url(SCREEN_PATH), post({ wallet: WALLET }, header))),
    );
    const statuses = replies.map((reply) => reply.status);
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((status) => status === 200 || status === 402 || status === 503)).toBe(true);
    const results = await Promise.all(replies.filter((reply) => reply.status === 200).map((reply) => reply.text()));
    expect(new Set(results).size).toBe(1);
    expect(screen).toHaveBeenCalledTimes(1);
    expect(facilitator.settled).toHaveLength(1);

    const later = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(later.status).toBe(200);
    expect(later.headers.get(STORED_HEADER)).toBe('true');
    expect(await later.text()).toBe(results[0]);
    expect(facilitator.settled).toHaveLength(1);
    expect(screen).toHaveBeenCalledTimes(1);
  });

  it('refuses a Base Sepolia payment sent to a Base mainnet route', async () => {
    const testnet = await setup();
    const sepoliaHeader = await signedHeader(testnet.appFetch, testnet.client);
    const mainnetFacilitator = new StubFacilitator('eip155:8453');
    const mainnetConfig: ApiConfig = {
      ...loadApiConfig({
        X402_NETWORK: 'base',
        PAYTO_ADDRESS: PAY_TO,
        CDP_API_KEY_ID: 'id',
        CDP_API_KEY_SECRET: 'secret',
        PUBLIC_ORIGIN: 'https://api.thuli.example',
        BASE_RPC_URL: 'https://mainnet.base.org',
      }),
      facilitator: mainnetFacilitator,
    };
    const mainnet = await setup({ config: mainnetConfig, facilitator: mainnetFacilitator });
    const response = await mainnet.appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, sepoliaHeader));
    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers.get('payment-required') as string);
    expect(required.accepts[0]?.network).toBe('eip155:8453');
    expect(mainnetFacilitator.settled).toHaveLength(0);
    expect(mainnet.screen).not.toHaveBeenCalled();
  });

  it('still answers with a code-written hold when the screening throws after payment', async () => {
    const { pay, facilitator } = await setup({
      screen: async () => {
        throw new Error('https://rpc.example/key exploded');
      },
    });
    const response = await pay(url(SCREEN_PATH), post({ wallet: WALLET }));
    expect(response.status).toBe(200);
    const body = PaidScreenResponse.parse(await response.json());
    expect(body.decision).toMatchObject({ action: 'hold', rule: 'A1', reason: `Held for review: ${SCREEN_CAUSES.failed}.` });
    expect(facilitator.settled).toHaveLength(1);
  });

  it('replaces a result that fails the output check with a code-written hold, by the one plain-text rule in core (C13, C34)', async () => {
    const unplain = {
      'a control character': 'Fine wallet.\u001b[31m',
      'a markdown link': 'Fine wallet, see [the record](javascript:alert(1)).',
      'a zero-width space': 'Fine wallet.\u200b',
      'a byte-order mark inside': 'Fine\ufeff wallet.',
    };
    for (const [name, reason] of Object.entries(unplain)) {
      const { pay } = await setup({
        screen: async (wallet) => {
          const result = screenResult(wallet);
          return { ...result, decision: { ...result.decision, reason } };
        },
      });
      const response = await pay(url(SCREEN_PATH), post({ wallet: WALLET }));
      expect(response.status, name).toBe(200);
      const body = PaidScreenResponse.parse(await response.json());
      expect(body.decision, name).toMatchObject({ action: 'hold', rule: 'A1', reason: `Held for review: ${OUTPUT_CHECK_CAUSE}.` });
      expect(body.servRequestId, name).toBeNull();
    }
  });
});

const USDC_SEPOLIA = parseAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const LOOK_ALIKE_TOKEN = parseAddress('0x3333333333333333333333333333333333333333');
const ELSEWHERE = parseAddress('0x4444444444444444444444444444444444444444');
const PENDING_TX = `0x${'7a'.repeat(32)}` as const;
const PRICE = BigInt(PRICE_UNITS);
const TOKEN_EVENTS = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)',
]);

function tokenLog(token: string, topics: unknown, data: Hex = '0x'): Log {
  return {
    address: token as Hex,
    topics: topics as Log['topics'],
    data,
    blockHash: `0x${'01'.repeat(32)}`,
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: PENDING_TX,
    transactionIndex: 0,
    removed: false,
  };
}

const transferLog = (token: string, from: string, to: string, value: bigint) =>
  tokenLog(
    token,
    encodeEventTopics({ abi: TOKEN_EVENTS, eventName: 'Transfer', args: { from: from as Hex, to: to as Hex } }),
    encodeAbiParameters([{ type: 'uint256' }], [value]),
  );

const authorizationLog = (eventName: 'AuthorizationUsed' | 'AuthorizationCanceled', token: string, authorizer: string, nonce: string) =>
  tokenLog(token, encodeEventTopics({ abi: TOKEN_EVENTS, eventName, args: { authorizer: authorizer as Hex, nonce: nonce as Hex } }));

type Signed = { from: string; nonce: string };

/** A facilitator answer saying the transaction went out but its outcome is not known yet. */
const pendingAnswer = async (payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> => ({
  success: false,
  errorReason: 'settlement_pending',
  transaction: PENDING_TX,
  network: requirements.network,
  payer: authorizationFrom(payload).from,
});

/** Answers every receipt read with these logs, built for the authorization the facilitator was handed. */
function receiptOf(facilitator: StubFacilitator, logs: (signed: Signed) => Log[], status: Receipt['status'] = 'success') {
  const reads: string[] = [];
  const read: ReadReceipt = async (hash) => {
    reads.push(hash);
    return { status, logs: logs(authorizationFrom(facilitator.settled[0] as PaymentPayload)) };
  };
  return { read, reads };
}

describe.each(BACKENDS)('settlement with no clear answer (C25), on $name', (backend) => {
  onBackend(backend);
  it('serves a settlement left pending once its receipt proves this exact payment, and screens it only once', async () => {
    const facilitator = new StubFacilitator('eip155:84532');
    facilitator.respond = pendingAnswer;
    const receipt = receiptOf(facilitator, ({ from, nonce }) => [
      authorizationLog('AuthorizationUsed', USDC_SEPOLIA, from, nonce),
      transferLog(USDC_SEPOLIA, from, PAY_TO, PRICE),
    ]);
    const { appFetch, fetchAs, client, screen } = await setup({ facilitator, readReceipt: receipt.read });
    const header = await signedHeader(appFetch, client);
    const paid = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(paid.status).toBe(200);
    const body = await paid.text();
    expect(PaidScreenResponse.parse(JSON.parse(body)).payment.transaction).toBe(PENDING_TX);
    expect(decodePaymentResponseHeader(paid.headers.get('payment-response') as string)).toMatchObject({ success: true, transaction: PENDING_TX });
    expect(receipt.reads).toEqual([PENDING_TX]);

    const replay = await fetchAs('198.51.100.3')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(replay.status).toBe(200);
    expect(replay.headers.get(STORED_HEADER)).toBe('true');
    expect(await replay.text()).toBe(body);
    expect(screen).toHaveBeenCalledTimes(1);
    expect(facilitator.settled).toHaveLength(2);
    expect(receipt.reads).toEqual([PENDING_TX]);
  });

  it('does not serve a pending settlement whose receipt pays elsewhere, pays another amount, is another token, reverted, or cannot be read', async () => {
    const cases: Record<string, { logs: (signed: Signed) => Log[]; status?: Receipt['status']; unreadable?: true }> = {
      'pays another address': { logs: ({ from, nonce }) => [authorizationLog('AuthorizationUsed', USDC_SEPOLIA, from, nonce), transferLog(USDC_SEPOLIA, from, ELSEWHERE, PRICE)] },
      'pays another amount': { logs: ({ from, nonce }) => [authorizationLog('AuthorizationUsed', USDC_SEPOLIA, from, nonce), transferLog(USDC_SEPOLIA, from, PAY_TO, PRICE - 1n)] },
      'comes from another token contract': {
        logs: ({ from, nonce }) => [authorizationLog('AuthorizationUsed', LOOK_ALIKE_TOKEN, from, nonce), transferLog(LOOK_ALIKE_TOKEN, from, PAY_TO, PRICE)],
      },
      'marks another nonce used': {
        logs: ({ from }) => [authorizationLog('AuthorizationUsed', USDC_SEPOLIA, from, `0x${'9'.repeat(64)}`), transferLog(USDC_SEPOLIA, from, PAY_TO, PRICE)],
      },
      reverted: {
        status: 'reverted',
        logs: ({ from, nonce }) => [authorizationLog('AuthorizationUsed', USDC_SEPOLIA, from, nonce), transferLog(USDC_SEPOLIA, from, PAY_TO, PRICE)],
      },
      'cannot be read': { logs: () => [], unreadable: true },
    };
    for (const [name, shape] of Object.entries(cases)) {
      const facilitator = new StubFacilitator('eip155:84532');
      facilitator.respond = pendingAnswer;
      const receipt = receiptOf(facilitator, shape.logs, shape.status);
      const { appFetch, fetchAs, client, screen } = await setup({ facilitator, readReceipt: shape.unreadable ? noChain : receipt.read });
      const header = await signedHeader(appFetch, client);
      const reply = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header));
      expect(reply.status, name).toBe(503);
      expect(await reply.json(), name).toEqual({ retry: true });
      expect(reply.headers.get('payment-required'), name).toBeNull();
      expect(reply.headers.get('payment-response'), name).toBeNull();
      // The claim is kept, not marked used: the same header comes back, is tried again, and is still not served.
      const again = await fetchAs('198.51.100.3')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
      expect(again.status, name).toBe(503);
      expect(screen, name).not.toHaveBeenCalled();
    }
  });

  it('answers 503 retry with no chain read when settle throws or times out, and screens a retry of the same header once', async () => {
    for (const failure of [new Error('socket hang up'), new FacilitatorTimeoutError('settle', 90_000)]) {
      const facilitator = new StubFacilitator('eip155:84532');
      facilitator.respond = async () => {
        throw failure;
      };
      const readReceipt = vi.fn(noChain);
      const { appFetch, fetchAs, client, screen } = await setup({ facilitator, readReceipt });
      const header = await signedHeader(appFetch, client);
      const first = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header));
      expect(first.status, failure.name).toBe(503);
      expect(await first.json()).toEqual({ retry: true });
      expect(first.headers.get('payment-response')).toBeNull();
      expect(screen).not.toHaveBeenCalled();

      // The facilitator answers again, and this stub answers success even to a repeat: the worst case for serving twice.
      facilitator.respond = null;
      const retries = await Promise.all(
        [1, 2, 3].map((index) => fetchAs(`198.51.100.${index}`)(url(SCREEN_PATH), post({ wallet: WALLET }, header))),
      );
      expect(retries.map((reply) => reply.status).sort()).toEqual([200, 402, 402]);
      const later = await fetchAs('198.51.100.9')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
      expect(later.status).toBe(200);
      expect(later.headers.get(STORED_HEADER)).toBe('true');
      expect(screen).toHaveBeenCalledTimes(1);
      expect(facilitator.settled).toHaveLength(2);
      expect(readReceipt).not.toHaveBeenCalled();
    }
  });

  it('never serves an authorization whose nonce was spent without paying us, by a cancel or by paying the payer itself', async () => {
    const spent: Record<string, (signed: Signed) => Log[]> = {
      cancelled: ({ from, nonce }) => [authorizationLog('AuthorizationCanceled', USDC_SEPOLIA, from, nonce)],
      'paid to the payer itself': ({ from, nonce }) => [
        authorizationLog('AuthorizationUsed', USDC_SEPOLIA, from, nonce),
        transferLog(USDC_SEPOLIA, from, from, PRICE),
      ],
    };
    for (const [name, logs] of Object.entries(spent)) {
      const facilitator = new StubFacilitator('eip155:84532');
      facilitator.respond = pendingAnswer;
      const { appFetch, fetchAs, client, screen } = await setup({ facilitator, readReceipt: receiptOf(facilitator, logs).read });
      const header = await signedHeader(appFetch, client);
      expect((await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header))).status, name).toBe(503);

      facilitator.respond = async (payload, requirements) => ({
        success: false,
        errorReason: 'invalid_exact_evm_nonce_already_used',
        transaction: '',
        network: requirements.network,
        payer: authorizationFrom(payload).from,
      });
      const refused = await fetchAs('198.51.100.3')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
      expect(refused.status, name).toBe(402);
      expect(decodePaymentResponseHeader(refused.headers.get('payment-response') as string)).toMatchObject({
        success: false,
        errorReason: 'invalid_exact_evm_nonce_already_used',
      });
      expect(screen, name).not.toHaveBeenCalled();
    }
  });
});

/**
 * A facilitator that behaves like the reference one: a payload it left pending is answered from the old transaction when
 * the same signature comes back, with no new check. The first answer and the library's one immediate retry stay pending.
 */
function cachingPendingFacilitator(): StubFacilitator {
  const facilitator = new StubFacilitator('eip155:84532');
  const seen = new Map<string, number>();
  facilitator.respond = async (payload, requirements) => {
    const signature = (payload.payload as { signature: string }).signature;
    const count = (seen.get(signature) ?? 0) + 1;
    seen.set(signature, count);
    if (count <= 2) return pendingAnswer(payload, requirements);
    return { success: true, transaction: PENDING_TX, network: requirements.network, payer: authorizationFrom(payload).from };
  };
  return facilitator;
}

const provingReceipt = (facilitator: StubFacilitator) =>
  receiptOf(facilitator, ({ from, nonce }) => [
    authorizationLog('AuthorizationUsed', USDC_SEPOLIA, from, nonce),
    transferLog(USDC_SEPOLIA, from, PAY_TO, PRICE),
  ]);

/** Resolves with value() once ms have passed on the clock, faked or real. */
function later<T>(ms: number, value: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      Promise.resolve().then(value).then(resolve, reject);
    }, ms);
  });
}

// The site's route maxDuration: the host ends a request at this point, whatever it is doing.
const HOST_ENDS_REQUEST_MS = 300_000;

/**
 * A stand-in screening that takes ms and then answers result, and that stops when its signal aborts, answering the
 * time-up hold at once, as screenOneWallet does.
 */
function screeningThatTakes(ms: number, result: (wallet: Address) => SingleScreen = screenResult) {
  return (wallet: Address, signal?: AbortSignal) =>
    new Promise<SingleScreen>((resolve) => {
      const timer = setTimeout(() => resolve(result(wallet)), ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve(heldScreen(wallet, SCREEN_CAUSES.timeUp));
      });
    });
}

describe.each(BACKENDS)('a paid request slower than the host allows (C25, C41), on $name', (backend) => {
  onBackend(backend);
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends before the host ends it, with its result or the settled-retry answer, and the same header then gets the result', async () => {
    const facilitator = new StubFacilitator('eip155:84532');
    const receipt = provingReceipt(facilitator);
    // Both settle calls answer pending after 89 s, just inside the library's own 90 s default.
    facilitator.respond = (payload, requirements) => later(89_000, () => pendingAnswer(payload, requirements));
    const { appFetch, client, screen } = await setup({
      facilitator,
      readReceipt: (hash) => later(10_000, () => receipt.read(hash)),
      screen: screeningThatTakes(120_000),
    });
    const header = await signedHeader(appFetch, client);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const started = Date.now();
    let endedAt: number | null = null;
    const first = appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header)).then((reply) => {
      endedAt = Date.now();
      return reply;
    });
    await vi.advanceTimersByTimeAsync(HOST_ENDS_REQUEST_MS);
    expect(endedAt, 'the request was still running when the host ended it').not.toBeNull();
    const reply = await first;
    if (reply.status === 503) {
      expect(reply.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/);
      expect(await reply.json()).toMatchObject({ settled: true, retry: true });
    } else {
      expect(reply.status).toBe(200);
      expect((endedAt ?? Infinity) - started).toBeLessThanOrEqual(240_000);
    }

    let retried: Response | null = null;
    const again = appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header)).then((answer) => (retried = answer));
    await vi.advanceTimersByTimeAsync(HOST_ENDS_REQUEST_MS);
    expect(retried, 'the retry was still running when the host ended it').not.toBeNull();
    const result = await again;
    expect(result.status).toBe(200);
    expect(PaidScreenResponse.parse(await result.json())).toMatchObject({ wallet: WALLET, payment: { transaction: PENDING_TX } });
    // The two pending answers of the first request are the only settle calls: the retry moved no money.
    expect(facilitator.settled).toHaveLength(2);
    expect(screen.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('starts no screening with under 20 s left after settling, answers the settled retry in time, and stores no hold', async () => {
    const facilitator = new StubFacilitator('eip155:84532');
    const receipt = provingReceipt(facilitator);
    facilitator.respond = (payload, requirements) => later(107_500, () => pendingAnswer(payload, requirements));
    const { appFetch, client, screen } = await setup({ facilitator, readReceipt: (hash) => later(10_000, () => receipt.read(hash)) });
    const header = await signedHeader(appFetch, client);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const started = Date.now();
    let endedAt: number | null = null;
    const first = appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header)).then((reply) => {
      endedAt = Date.now();
      return reply;
    });
    await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
    const reply = await first;
    // 107.5 s, 107.5 s and the 10 s receipt read leave 15 s of the 240: enough for a 5 s share, too little to start.
    expect((endedAt ?? Infinity) - started).toBe(225_000);
    expect(reply.status).toBe(503);
    expect(SettledRetryBody.parse(await reply.json())).toEqual({ settled: true, retry: true, message: expect.any(String) });
    expect(reply.headers.get('retry-after')).toBe(String(SETTLED_RETRY_AFTER_SECONDS));
    expect(decodePaymentResponseHeader(reply.headers.get('payment-response') as string)).toMatchObject({ success: true, transaction: PENDING_TX });
    expect(screen).not.toHaveBeenCalled();

    vi.useRealTimers();
    const redeemed = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers.get(STORED_HEADER)).toBeNull();
    expect(PaidScreenResponse.parse(await redeemed.json()).decision).toMatchObject({ action: 'full', rule: 'A9' });
    expect(screen).toHaveBeenCalledTimes(1);
    expect(facilitator.settled).toHaveLength(2);
  });

  it('cuts a receipt read that never answers at the deadline, keeps the payment unsure and answers in time', async () => {
    const facilitator = new StubFacilitator('eip155:84532');
    facilitator.respond = pendingAnswer;
    const { appFetch, client, screen } = await setup({ facilitator, readReceipt: () => new Promise<Receipt>(() => undefined) });
    const header = await signedHeader(appFetch, client);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const started = Date.now();
    let endedAt: number | null = null;
    const reply = appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header)).then((answer) => {
      endedAt = Date.now();
      return answer;
    });
    await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
    expect(endedAt, 'the request was still waiting on the receipt at its deadline').not.toBeNull();
    expect((endedAt ?? Infinity) - started).toBeLessThanOrEqual(REQUEST_DEADLINE_MS);
    const answer = await reply;
    expect(answer.status).toBe(503);
    expect(await answer.json()).toEqual({ retry: true });
    expect(screen).not.toHaveBeenCalled();
  });

  it('settles nothing when too little of the deadline is left to settle and screen, so nothing is spent', async () => {
    // Two 30 s settle calls, the slowest receipt read (two calls, each tried twice with a 250 ms wait) and 20 s to screen.
    expect(RECEIPT_READ_WORST_MS).toBe(40_500);
    expect(SETTLE_ROOM_MS).toBe(2 * 30_000 + 40_500 + 20_000);
    let clock = new Date();
    const base = await freshStores(() => clock);
    // The time before the claim goes, as a slow store would spend it: just under what settling and screening need.
    const slow: Stores = {
      ...base,
      claims: {
        ...base.claims,
        redeem: async (...args) => {
          clock = new Date(clock.getTime() + REQUEST_DEADLINE_MS - SETTLE_ROOM_MS + 1);
          return base.claims.redeem(...args);
        },
      },
    };
    const { appFetch, client, screen, facilitator } = await setup({ now: () => clock, stores: slow });
    const header = await signedHeader(appFetch, client);
    const reply = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(reply.status).toBe(503);
    expect(await reply.json()).toEqual({ busy: true });
    expect(facilitator.settled).toHaveLength(0);
    expect(screen).not.toHaveBeenCalled();
  });
});

/** Stores whose first guard.start runs hook first, as a request cut off between settling and screening would. */
function onFirstStart(base: Stores, hook: () => Promise<void> | void): Stores {
  let first = true;
  return {
    ...base,
    guard: {
      ...base.guard,
      start: async (ticket) => {
        if (first) {
          first = false;
          await hook();
        }
        return base.guard.start(ticket);
      },
    },
  };
}

describe.each(BACKENDS)('redeeming a payment that went through, with the same header (C24, C25, C42), on $name', (backend) => {
  onBackend(backend);

  it('after a request abandoned once its payment settled, the same header gets a real result, with one settlement and one screening in total', async () => {
    let clock = new Date();
    const now = () => clock;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached = false;
    const stores = onFirstStart(await freshStores(now), async () => {
      reached = true;
      await gate;
    });
    const { appFetch, fetchAs, client, screen, facilitator } = await setup({ now, stores });
    const header = await signedHeader(appFetch, client);
    // The host cuts this request between settling and screening; nothing ever reads its answer before the end.
    const dropped = appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    await vi.waitFor(() => expect(reached).toBe(true));
    expect(facilitator.settled).toHaveLength(1);

    // While the cut request may still be alive, a copy screens nothing beside it, and is told to come back, since the
    // money has moved. Waiting on a payment that went through is not a failed payment, so it never locks the buyer out.
    for (let index = 0; index <= CLIENT_MAX_FAILED_PER_HOUR; index += 1) {
      const early = await fetchAs('198.51.100.40')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
      expect(early.status, `copy ${index + 1}`).toBe(503);
      expect(SettledRetryBody.safeParse(await early.json()).success).toBe(true);
      expect(early.headers.get('retry-after')).toBe(String(SETTLED_RETRY_AFTER_SECONDS));
    }

    clock = new Date(clock.getTime() + LEASE_SECONDS * 1000);
    const otherWallet = await fetchAs('198.51.100.41')(url(SCREEN_PATH), post({ wallet: OTHER_WALLET }, header));
    expect(otherWallet.status).toBe(402);
    const redeemed = await fetchAs('198.51.100.42')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers.get(STORED_HEADER)).toBeNull();
    expect(decodePaymentResponseHeader(redeemed.headers.get('payment-response') as string)).toMatchObject({ success: true, transaction: SETTLE_TX });
    const body = PaidScreenResponse.parse(await redeemed.json());
    expect(body).toMatchObject({ wallet: WALLET, decision: { action: 'full', rule: 'A9' }, payment: { transaction: SETTLE_TX } });
    expect(facilitator.settled).toHaveLength(1);
    expect(screen).toHaveBeenCalledTimes(1);

    // The cut request wakes long past its deadline: it neither screens nor touches the stored result.
    release();
    expect((await dropped).status).toBe(503);
    const fetched = await fetchAs('198.51.100.43')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(fetched.headers.get(STORED_HEADER)).toBe('true');
    expect(PaidScreenResponse.parse(await fetched.json())).toEqual(body);
    expect(screen).toHaveBeenCalledTimes(1);
    expect(facilitator.settled).toHaveLength(1);
  });

  it('answers a served payment fetched 10 more times with the identical body, with no screening and no settlement', async () => {
    const { pay, appFetch, screen, facilitator, sentSignatures } = await setup();
    const paid = await pay(url(SCREEN_PATH), post({ wallet: WALLET }));
    expect(paid.status).toBe(200);
    expect(paid.headers.get(STORED_HEADER)).toBeNull();
    const body = await paid.text();
    const header = { 'PAYMENT-SIGNATURE': sentSignatures[0] as string };
    for (let index = 0; index < 10; index += 1) {
      const again = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header));
      expect(again.status).toBe(200);
      expect(again.headers.get(STORED_HEADER)).toBe('true');
      expect(decodePaymentResponseHeader(again.headers.get('payment-response') as string)).toMatchObject({ success: true, transaction: SETTLE_TX });
      expect(await again.text()).toBe(body);
    }
    expect(screen).toHaveBeenCalledTimes(1);
    expect(facilitator.settled).toHaveLength(1);
  });

  it('refuses the same header for another wallet, and runs nothing for it', async () => {
    const { pay, appFetch, screen, facilitator, sentSignatures } = await setup();
    expect((await pay(url(SCREEN_PATH), post({ wallet: WALLET }))).status).toBe(200);
    const header = { 'PAYMENT-SIGNATURE': sentSignatures[0] as string };
    const other = await appFetch(url(SCREEN_PATH), post({ wallet: OTHER_WALLET }, header));
    expect(other.status).toBe(402);
    expect(decodePaymentResponseHeader(other.headers.get('payment-response') as string)).toMatchObject({
      success: false,
      errorReason: 'payment_already_used',
    });
    expect(JSON.stringify(await other.json())).not.toContain('decision');
    expect(screen).toHaveBeenCalledTimes(1);
    expect(facilitator.settled).toHaveLength(1);
  });

  it('gives two redeems of one settled payment at once a single screening: the other is told to come back, never that the payment is used, and then gets the stored result', async () => {
    let clock = new Date();
    const now = () => clock;
    // The first request's settling used up its time, as a slow facilitator would, so it stores nothing.
    const stores = onFirstStart(await freshStores(now), () => {
      clock = new Date(clock.getTime() + REQUEST_DEADLINE_MS - REPLY_MARGIN_MS);
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { appFetch, fetchAs, client, screen, facilitator } = await setup({
      now,
      stores,
      screen: async (wallet) => {
        await gate;
        return screenResult(wallet);
      },
    });
    const header = await signedHeader(appFetch, client);
    const late = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(late.status).toBe(503);
    expect(SettledRetryBody.safeParse(await late.json()).success).toBe(true);
    expect(screen).not.toHaveBeenCalled();

    const both = ['198.51.100.50', '198.51.100.51'].map((address) => fetchAs(address)(url(SCREEN_PATH), post({ wallet: WALLET }, header)));
    await vi.waitFor(() => expect(screen).toHaveBeenCalledTimes(1));
    release();
    const replies = await Promise.all(both);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 503]);
    const screened = replies.find((reply) => reply.status === 200) as Response;
    const waiting = replies.find((reply) => reply.status === 503) as Response;
    const result = await screened.text();
    expect(SettledRetryBody.safeParse(await waiting.json()).success).toBe(true);
    expect(waiting.headers.get('retry-after')).toBe(String(SETTLED_RETRY_AFTER_SECONDS));
    // No fresh terms, so no client is led to pay a second time.
    expect(waiting.headers.get('payment-required')).toBeNull();
    expect(waiting.headers.get('payment-response')).toBeNull();

    const again = await fetchAs('198.51.100.51')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(again.status).toBe(200);
    expect(again.headers.get(STORED_HEADER)).toBe('true');
    expect(await again.text()).toBe(result);
    expect(screen).toHaveBeenCalledTimes(1);
    expect(facilitator.settled).toHaveLength(1);
  });

  it('C25, C26: a payment whose screening always runs out of time buys two screenings, then the stored time-up hold, however often its header comes back', async () => {
    let clock = new Date();
    const { pay, appFetch, screen, facilitator, sentSignatures } = await setup({
      now: () => clock,
      screen: async (wallet) => heldScreen(wallet, SCREEN_CAUSES.timeUp),
    });
    const replies = [await pay(url(SCREEN_PATH), post({ wallet: WALLET }))];
    const header = { 'PAYMENT-SIGNATURE': sentSignatures[0] as string };
    for (let send = 1; send < 5; send += 1) {
      clock = new Date(clock.getTime() + 11_000);
      replies.push(await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header)));
    }
    expect(replies.map((reply) => reply.status)).toEqual([503, 200, 200, 200, 200]);
    expect(SettledRetryBody.safeParse(await replies[0]?.json()).success).toBe(true);
    const bodies = await Promise.all(replies.slice(1).map((reply) => reply.text()));
    expect(new Set(bodies).size).toBe(1);
    expect(PaidScreenResponse.parse(JSON.parse(bodies[0] as string))).toMatchObject({
      wallet: WALLET,
      decision: { action: 'hold', rule: 'A1', reason: `Held for review: ${SCREEN_CAUSES.timeUp}.` },
      payment: { transaction: SETTLE_TX },
    });
    expect(replies.slice(2).map((reply) => reply.headers.get(STORED_HEADER))).toEqual(['true', 'true', 'true']);
    expect(screen).toHaveBeenCalledTimes(2);
    expect(facilitator.settled).toHaveLength(1);
  });

  it('C25, C26: a try the request never started is handed back, so the buyer still gets two screenings before the stored hold', async () => {
    let clock = new Date();
    const now = () => clock;
    // The first request's settling used up the whole of its screening's share, so it starts none.
    const stores = onFirstStart(await freshStores(now), () => {
      clock = new Date(clock.getTime() + REQUEST_DEADLINE_MS - REPLY_MARGIN_MS);
    });
    const { pay, appFetch, screen, sentSignatures } = await setup({ now, stores, screen: async (wallet) => heldScreen(wallet, SCREEN_CAUSES.timeUp) });
    const replies = [await pay(url(SCREEN_PATH), post({ wallet: WALLET }))];
    const header = { 'PAYMENT-SIGNATURE': sentSignatures[0] as string };
    for (let send = 0; send < 3; send += 1) replies.push(await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header)));
    expect(replies.map((reply) => reply.status)).toEqual([503, 503, 200, 200]);
    expect(replies[3]?.headers.get(STORED_HEADER)).toBe('true');
    expect(screen).toHaveBeenCalledTimes(2);
  });

  it('C26: two redeems at once on the last try start one screening between them', async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { pay, fetchAs, screen, facilitator, sentSignatures } = await setup({
      screen: async (wallet) => {
        calls += 1;
        if (calls === 1) return heldScreen(wallet, SCREEN_CAUSES.timeUp);
        await gate;
        return heldScreen(wallet, SCREEN_CAUSES.timeUp);
      },
    });
    expect((await pay(url(SCREEN_PATH), post({ wallet: WALLET }))).status).toBe(503);
    const header = { 'PAYMENT-SIGNATURE': sentSignatures[0] as string };
    const both = ['198.51.100.60', '198.51.100.61'].map((address) => fetchAs(address)(url(SCREEN_PATH), post({ wallet: WALLET }, header)));
    await vi.waitFor(() => expect(screen).toHaveBeenCalledTimes(2));
    release();
    const replies = await Promise.all(both);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 503]);
    const later = await fetchAs('198.51.100.61')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(later.headers.get(STORED_HEADER)).toBe('true');
    expect(PaidScreenResponse.parse(await later.json()).decision.reason).toBe(`Held for review: ${SCREEN_CAUSES.timeUp}.`);
    expect(screen).toHaveBeenCalledTimes(2);
    expect(facilitator.settled).toHaveLength(1);
  });

  it('C24, C42: a cut screening is stopped through its signal, and its service place, the caller\'s place and the claim stay taken until it has really ended', async () => {
    let clock = new Date();
    const now = () => clock;
    const base = await freshStores(now);
    let running = 0;
    const given: string[] = [];
    const counted: Stores = {
      ...base,
      guard: {
        ...base.guard,
        enter: async () => {
          const ticket = await base.guard.enter();
          if (ticket !== null) running += 1;
          return ticket;
        },
        leave: async (ticket) => {
          running -= 1;
          given.push('service place');
          await base.guard.leave(ticket);
        },
      },
      limits: {
        ...base.limits,
        leave: async (pass) => {
          if (pass.paying) given.push('caller place');
          await base.limits.leave(pass);
        },
      },
    };
    // The first request's settling used up all but 50 ms of its screening's share, as a slow facilitator would.
    const stores = onFirstStart(counted, () => {
      clock = new Date(clock.getTime() + REQUEST_DEADLINE_MS - REPLY_MARGIN_MS - 50);
    });
    const signals: AbortSignal[] = [];
    let finish: () => void = () => undefined;
    const { pay, fetchAs, screen, sentSignatures } = await setup({
      now,
      stores,
      screen: async (wallet, signal) => {
        if (signal !== undefined) signals.push(signal);
        if (signals.length === 1) await new Promise<void>((resolve) => (finish = resolve));
        return screenResult(wallet);
      },
    });
    const cut = await pay(url(SCREEN_PATH), post({ wallet: WALLET }));
    expect(cut.status).toBe(503);
    expect(SettledRetryBody.safeParse(await cut.json()).success).toBe(true);
    // The stop was called, and the screening, still running as a SERV call in flight would, keeps every place it held.
    expect(signals[0]?.aborted).toBe(true);
    expect(running).toBe(1);
    expect(given).toEqual([]);
    const header = { 'PAYMENT-SIGNATURE': sentSignatures[0] as string };
    // A copy meanwhile screens nothing beside it, and gives back only its own places.
    const beside = await fetchAs('198.51.100.62')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(beside.status).toBe(503);
    expect(screen).toHaveBeenCalledTimes(1);
    expect(running).toBe(1);
    expect([...given].sort()).toEqual(['caller place', 'service place']);

    finish();
    await vi.waitFor(() => expect([...given].sort()).toEqual(['caller place', 'caller place', 'service place', 'service place']));
    expect(running).toBe(0);
    const redeemed = await fetchAs('198.51.100.62')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(redeemed.status).toBe(200);
    expect(PaidScreenResponse.parse(await redeemed.json()).decision).toMatchObject({ action: 'full', rule: 'A9' });
    expect(screen).toHaveBeenCalledTimes(2);
  });

  it('C25, C26: when the last try\'s request dies with the claim, the next copy gets the stored time-up hold and no third screening, and copies at once get one hold', async () => {
    let clock = new Date();
    const now = () => clock;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const { pay, fetchAs, screen, facilitator, sentSignatures } = await setup({
      now,
      screen: async (wallet) => {
        calls += 1;
        if (calls === 2) await gate;
        return heldScreen(wallet, SCREEN_CAUSES.timeUp);
      },
    });
    expect((await pay(url(SCREEN_PATH), post({ wallet: WALLET }))).status).toBe(503);
    const header = { 'PAYMENT-SIGNATURE': sentSignatures[0] as string };
    // The last try starts, and the host cuts its request: nothing ever reads this answer before the end.
    const dropped = fetchAs('198.51.100.63')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    await vi.waitFor(() => expect(screen).toHaveBeenCalledTimes(2));

    clock = new Date(clock.getTime() + LEASE_SECONDS * 1000);
    const copies = await Promise.all(
      ['198.51.100.64', '198.51.100.65'].map((address) => fetchAs(address)(url(SCREEN_PATH), post({ wallet: WALLET }, header))),
    );
    expect(copies.map((reply) => reply.status).sort()).toEqual([200, 503]);
    const hold = await (copies.find((reply) => reply.status === 200) as Response).text();
    expect(PaidScreenResponse.parse(JSON.parse(hold)).decision).toMatchObject({ action: 'hold', reason: `Held for review: ${SCREEN_CAUSES.timeUp}.` });
    const again = await fetchAs('198.51.100.65')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(again.headers.get(STORED_HEADER)).toBe('true');
    expect(await again.text()).toBe(hold);

    release();
    await dropped;
    expect(screen).toHaveBeenCalledTimes(2);
    expect(facilitator.settled).toHaveLength(1);
  });

  it('never stores the hold a screening writes when it runs out of its own time: it answers the settled retry, and the same header gets a real result', async () => {
    let calls = 0;
    const { pay, appFetch, screen, facilitator, sentSignatures } = await setup({
      screen: async (wallet) => {
        calls += 1;
        return calls === 1 ? heldScreen(wallet, SCREEN_CAUSES.timeUp) : screenResult(wallet);
      },
    });
    const first = await pay(url(SCREEN_PATH), post({ wallet: WALLET }));
    expect(first.status).toBe(503);
    expect(SettledRetryBody.safeParse(await first.json()).success).toBe(true);
    const header = { 'PAYMENT-SIGNATURE': sentSignatures[0] as string };
    const redeemed = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(redeemed.status).toBe(200);
    expect(PaidScreenResponse.parse(await redeemed.json()).decision).toMatchObject({ action: 'full', rule: 'A9' });
    const stored = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(stored.headers.get(STORED_HEADER)).toBe('true');
    expect(screen).toHaveBeenCalledTimes(2);
    expect(facilitator.settled).toHaveLength(1);
  });

  it('refuses a redeem once a day has passed since the settlement, and serves the stored result until then', async () => {
    let clock = new Date();
    const { pay, appFetch, screen, facilitator, sentSignatures } = await setup({ now: () => clock });
    const settledAt = clock.getTime();
    const paid = await pay(url(SCREEN_PATH), post({ wallet: WALLET }));
    expect(paid.status).toBe(200);
    const body = await paid.text();
    const header = { 'PAYMENT-SIGNATURE': sentSignatures[0] as string };

    clock = new Date(settledAt + (PAID_RESULT_KEEP_SECONDS - 1) * 1000);
    const lastSecond = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(lastSecond.status).toBe(200);
    expect(await lastSecond.text()).toBe(body);

    clock = new Date(settledAt + PAID_RESULT_KEEP_SECONDS * 1000);
    const after = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(after.status).toBe(402);
    expect(decodePaymentResponseHeader(after.headers.get('payment-response') as string)).toMatchObject({ errorReason: 'payment_expired' });
    expect(screen).toHaveBeenCalledTimes(1);
    expect(facilitator.settled).toHaveLength(1);
  });
});

describe.each(BACKENDS)('a payment signed to outlive its claim (C25), on $name', (backend) => {
  onBackend(backend);
  it('refuses an authorization signed with maxTimeoutSeconds raised to 864000, before claiming or settling it', async () => {
    const facilitator = cachingPendingFacilitator();
    const { appFetch, fetchAs, client, screen } = await setup({ facilitator, readReceipt: provingReceipt(facilitator).read });
    const unpaid = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }));
    const required = decodePaymentRequiredHeader(unpaid.headers.get('payment-required') as string);
    const raised = structuredClone(required);
    (raised.accepts[0] as { maxTimeoutSeconds: number }).maxTimeoutSeconds = 864_000;
    const http = new x402HTTPClient(client);
    const signed = await http.createPaymentPayload(raised);
    expect(Number(authorizationFrom(signed).validBefore)).toBeGreaterThan(Date.now() / 1000 + 863_000);

    // As signed, it names terms the route does not offer, so the library refuses it.
    const asSigned = await fetchAs('198.51.100.1')(url(SCREEN_PATH), post({ wallet: WALLET }, http.encodePaymentSignatureHeader(signed)));
    expect(asSigned.status).toBe(402);
    // The terms are not signed, so the route's own can be pasted back: then only the validity check stands in the way.
    const disguised = { ...signed, accepted: required.accepts[0] as PaymentRequirements };
    const reply = await fetchAs('198.51.100.2')(url(SCREEN_PATH), post({ wallet: WALLET }, http.encodePaymentSignatureHeader(disguised)));
    expect(reply.status).toBe(402);
    expect(decodePaymentResponseHeader(reply.headers.get('payment-response') as string)).toMatchObject({
      success: false,
      errorReason: 'payment_valid_too_long',
      errorMessage: expect.stringContaining('Sign a fresh payment'),
    });
    expect(facilitator.settled).toHaveLength(0);
    expect(screen).not.toHaveBeenCalled();
  });

  it('gives no second screening to a payment settled pending, proven by receipt, then replayed 301 s later from a new address', async () => {
    let clock = new Date();
    const facilitator = cachingPendingFacilitator();
    const receipt = provingReceipt(facilitator);
    const { appFetch, fetchAs, client, screen } = await setup({ facilitator, readReceipt: receipt.read, now: () => clock });
    // A buyer whose clock runs 20 seconds fast signs a validBefore 320 seconds out: inside the allowance, past 300.
    const realNow = Date.now();
    const fastClock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 20_000);
    const header = await signedHeader(appFetch, client);
    fastClock.mockRestore();

    clock = new Date(realNow);
    const first = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(first.status).toBe(200);
    expect(receipt.reads).toEqual([PENDING_TX]);

    clock = new Date(realNow + 301_000);
    // Past its validBefore the header is still the receipt for that payment: the stored result, never a new settle.
    const replay = await fetchAs('198.51.100.77')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(replay.status).toBe(200);
    expect(replay.headers.get(STORED_HEADER)).toBe('true');
    expect(facilitator.settled).toHaveLength(2);
    expect(screen).toHaveBeenCalledTimes(1);
  });
});

describe.each(BACKENDS)('POST /api/x402/screen refusals before payment, on $name', (backend) => {
  onBackend(backend);
  it('refuses an authorization that bought nothing once its validBefore has passed, before claiming or settling it, so a forgotten claim reopens nothing', async () => {
    let clock = new Date();
    const { appFetch, fetchAs, client, screen, facilitator } = await setup({ now: () => clock });
    const header = await signedHeader(appFetch, client);
    facilitator.failSettle = true;
    expect((await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header))).status).toBe(402);
    const validBefore = Number(authorizationFrom(facilitator.settled[0] as PaymentPayload).validBefore);
    facilitator.failSettle = false;

    clock = new Date(validBefore * 1000);
    const expired = await fetchAs('198.51.100.4')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(expired.status).toBe(402);
    expect(decodePaymentResponseHeader(expired.headers.get('payment-response') as string)).toMatchObject({
      success: false,
      errorReason: 'payment_expired',
    });
    expect(facilitator.settled).toHaveLength(1);
    expect(screen).not.toHaveBeenCalled();
  });

  it('answers a bad body with 400 and never asks for or takes payment', async () => {
    const { appFetch, client, screen, facilitator } = await setup();
    const header = await signedHeader(appFetch, client);
    const bodies: unknown[] = [
      'not json',
      { wallet: 7 },
      { wallet: WALLET, extra: 1 },
      { wallet: `${WALLET}${'0'.repeat(30)}` },
      { wallet: '0x041F77015fe51c51aE49a7f2F3Ff86C641fa190a' },
      {},
    ];
    for (const body of bodies) {
      for (const extra of [{}, header]) {
        const response = await appFetch(url(SCREEN_PATH), post(body, extra));
        expect(response.status).toBe(400);
        expect(response.headers.get('payment-required')).toBeNull();
      }
    }
    const huge = await appFetch(url(SCREEN_PATH), post({ wallet: 'a'.repeat(5000) }));
    expect(huge.status).toBe(413);
    expect(huge.headers.get('payment-required')).toBeNull();
    expect(facilitator.settled).toHaveLength(0);
    expect(screen).not.toHaveBeenCalled();
  });

  it('answers busy with 503 before asking for payment while four paid screenings run, whatever X-Forwarded-For says', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { payAs, appFetch, screen, facilitator } = await setup({
      screen: async (wallet) => {
        await gate;
        return screenResult(wallet);
      },
    });
    const running = Array.from({ length: MAX_RUNNING }, (_, index) =>
      payAs(`198.51.100.${index + 1}`)(url(SCREEN_PATH), post({ wallet: WALLET })),
    );
    await vi.waitFor(() => expect(screen).toHaveBeenCalledTimes(MAX_RUNNING));

    for (const forwarded of ['203.0.113.1', '198.51.100.2', '192.0.2.3']) {
      const busy = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, { 'x-forwarded-for': forwarded }));
      expect(busy.status).toBe(503);
      expect(await busy.json()).toEqual({ busy: true });
      expect(busy.headers.get('payment-required')).toBeNull();
    }
    expect(facilitator.settled).toHaveLength(MAX_RUNNING);

    release();
    const done = await Promise.all(running);
    expect(done.map((reply) => reply.status)).toEqual(Array(MAX_RUNNING).fill(200));
    const after = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }));
    expect(after.status).toBe(402);
  });
});

const ATTACKER = '203.0.113.9';
const HONEST = '198.51.100.7';

describe.each(BACKENDS)('per-client limits on the paid route (C24, C42), on $name', (backend) => {
  onBackend(backend);

  it('keeps the route open to a second client while one client floods it from 4 loops with unfunded payments', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const facilitator = new StubFacilitator('eip155:84532');
    let release: () => void = () => undefined;
    facilitator.holdUnfunded = new Promise<void>((resolve) => (release = resolve));
    const { fetchAs, payAs } = await setup({ facilitator });
    const attacker = privateKeyToAccount(generatePrivateKey());
    facilitator.unfunded.add(attacker.address.toLowerCase());
    const terms = decodePaymentRequiredHeader(
      (await fetchAs('192.0.2.200')(url(SCREEN_PATH), post({ wallet: WALLET }))).headers.get('payment-required') as string,
    );
    const signer = new x402HTTPClient(new x402Client().register('eip155:84532', new ExactEvmScheme(attacker)));
    const fromAttacker = async (forwarded: string) =>
      fetchAs(ATTACKER)(
        url(SCREEN_PATH),
        post(
          { wallet: WALLET },
          { ...signer.encodePaymentSignatureHeader(await signer.createPaymentPayload(terms)), 'x-forwarded-for': forwarded },
        ),
      );
    const attackerSettles = () =>
      facilitator.settled.filter((payload) => authorizationFrom(payload).from.toLowerCase() === attacker.address.toLowerCase()).length;

    const statuses: number[] = [];
    const loop = async (loopIndex: number) => {
      for (let round = 0; round < 8; round += 1) {
        const reply = await fromAttacker(`10.${loopIndex}.${round}.1`);
        statuses.push(reply.status);
        if (reply.status === 429) {
          expect(await reply.json()).toEqual({ busy: true });
          expect(reply.headers.get('payment-required')).toBeNull();
        }
      }
    };
    const loops = Promise.all([0, 1, 2, 3].map(loop));
    // Every loop has had time to reach the facilitator, where an unlimited client would now hold all four places.
    await vi.waitFor(() => expect(attackerSettles()).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const honest = await payAs(HONEST)(url(SCREEN_PATH), post({ wallet: WALLET }));
    expect(honest.status).toBe(200);

    release();
    await loops;
    expect(statuses).toHaveLength(32);
    expect(statuses).not.toContain(200);
    expect(attackerSettles()).toBeLessThanOrEqual(CLIENT_MAX_FAILED_PER_HOUR);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(32 - CLIENT_MAX_FAILED_PER_HOUR);

    for (const forwarded of ['198.51.100.250', '2001:db8::7', HONEST]) {
      expect((await fromAttacker(forwarded)).status).toBe(429);
    }
    const unpaid = await fetchAs(ATTACKER)(url(SCREEN_PATH), post({ wallet: WALLET }, { 'x-forwarded-for': '192.0.2.99' }));
    expect(unpaid.status).toBe(429);
    expect((await payAs(HONEST)(url(SCREEN_PATH), post({ wallet: WALLET }))).status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('limit'));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(ATTACKER);
    warn.mockRestore();
  });

  it('names the client by the trusted header when one is configured, never by X-Forwarded-For or the proxy socket', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const facilitator = new StubFacilitator('eip155:84532');
    const { fetchAs } = await setup({ config: { ...testnetConfig(facilitator), trustedClientHeader: 'x-vercel-forwarded-for' }, facilitator });
    const statuses: number[] = [];
    for (let index = 0; index <= CLIENT_MAX_PER_MINUTE; index += 1) {
      const reply = await fetchAs(`10.0.0.${index + 1}`)(
        url(SCREEN_PATH),
        post({ wallet: WALLET }, { 'x-vercel-forwarded-for': ATTACKER, 'x-forwarded-for': `198.51.100.${index + 1}` }),
      );
      statuses.push(reply.status);
    }
    expect(statuses).toEqual([...Array(CLIENT_MAX_PER_MINUTE).fill(402), 429]);
    const sameAddressInIpv6 = await fetchAs('10.0.0.99')(url(SCREEN_PATH), post({ wallet: WALLET }, { 'x-vercel-forwarded-for': `::ffff:${ATTACKER}` }));
    expect(sameAddressInIpv6.status).toBe(429);
    const other = await fetchAs('10.0.0.99')(url(SCREEN_PATH), post({ wallet: WALLET }, { 'x-vercel-forwarded-for': HONEST }));
    expect(other.status).toBe(402);
    const missing = await fetchAs('10.0.0.99')(url(SCREEN_PATH), post({ wallet: WALLET }, { 'x-forwarded-for': HONEST }));
    expect(missing.status).toBe(400);
    expect(missing.headers.get('payment-required')).toBeNull();
    // Behind a proxy that appends, the first value of a list is whatever the client wrote, so a list is refused.
    for (const list of [`198.51.100.250, ${ATTACKER}`, `${HONEST},${HONEST}`]) {
      const listed = await fetchAs('10.0.0.99')(url(SCREEN_PATH), post({ wallet: WALLET }, { 'x-vercel-forwarded-for': list }));
      expect(listed.status, list).toBe(400);
      expect(listed.headers.get('payment-required'), list).toBeNull();
    }

    // Moving around inside one IPv6 /64 is still one client.
    const fromNetwork: number[] = [];
    for (let index = 0; index <= CLIENT_MAX_PER_MINUTE; index += 1) {
      const reply = await fetchAs('10.0.0.99')(url(SCREEN_PATH), post({ wallet: WALLET }, { 'x-vercel-forwarded-for': `2001:db8:7:7::${index + 1}` }));
      fromNetwork.push(reply.status);
    }
    expect(fromNetwork).toEqual([...Array(CLIENT_MAX_PER_MINUTE).fill(402), 429]);
    warn.mockRestore();
  });

  it('counts the real socket address on a real server, whatever X-Forwarded-For says', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { app } = await setup();
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await once(server, 'listening');
    try {
      const { port } = server.address() as AddressInfo;
      const statuses: number[] = [];
      for (let index = 0; index <= CLIENT_MAX_PER_MINUTE; index += 1) {
        const reply = await fetch(`http://127.0.0.1:${port}${SCREEN_PATH}`, post({ wallet: WALLET }, { 'x-forwarded-for': `203.0.113.${index + 1}` }));
        await reply.arrayBuffer();
        statuses.push(reply.status);
      }
      expect(statuses).toEqual([...Array(CLIENT_MAX_PER_MINUTE).fill(402), 429]);
    } finally {
      server.close();
      warn.mockRestore();
    }
  });
});

describe('per-client limits on the paid route in memory (C41)', () => {
  // The shared stores keep no table of clients and so have no cap to fill: on Postgres a new caller is never refused
  // for 'clients', and sweep bounds the tables instead. This tests the in-memory cap only.
  it('still answers a new client with the 402 terms after 100,000 other clients inside one hour', { timeout: 120_000 }, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const clock = new Date('2026-11-10T08:00:00.000Z');
    const { fetchAs } = await setup({ now: () => clock, stores: memoryStores(() => clock) });
    for (let index = 0; index < MAX_CLIENTS_TRACKED; index += 1) {
      const address = `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;
      const reply = await fetchAs(address)(url(SCREEN_PATH), post({}));
      if (reply.status !== 400) throw new Error(`client ${address} got ${reply.status}`);
    }
    const fresh = await fetchAs(HONEST)(url(SCREEN_PATH), post({ wallet: WALLET }));
    expect(fresh.status).toBe(402);
    expect(fresh.headers.get('payment-required')).not.toBeNull();
    warn.mockRestore();
  });
});

/** A claim store on the current backend, with a way to count its claims and to fill it with unsure ones quickly. */
async function claimBackend() {
  if (backendDb === null) {
    const claims = new PaymentClaims(300n);
    const store = claimStoreOver(claims);
    return {
      store,
      count: async () => claims.size,
      fillUnsure: async (count: number, validBefore: bigint, nowSeconds: bigint) => {
        for (let index = 0; index < count; index += 1) {
          await store.claim(`unsure-${index}`, validBefore, 'filler', nowSeconds);
          await store.keepUnsure(`unsure-${index}`, 'filler');
        }
      },
    };
  }
  const db = backendDb;
  const { claims } = await freshStores(() => new Date());
  return {
    store: claims,
    count: async () => (await db.query<{ claims: number }>('SELECT count(*)::int AS claims FROM payment_claims'))[0]?.claims ?? 0,
    // One statement, because 99,999 claims one by one take minutes on PGlite. The rows are what claim and keepUnsure write.
    fillUnsure: async (count: number, validBefore: bigint, nowSeconds: bigint) => {
      await db.query(
        `INSERT INTO payment_claims (key, state, owner, valid_before, updated_at)
         SELECT 'unsure-' || n, 'unsure', NULL, $1::bigint, to_timestamp($2::bigint) FROM generate_series(0, $3::int - 1) AS n`,
        [validBefore.toString(), nowSeconds.toString(), count],
      );
    },
  };
}

const OTHER_WALLET = parseAddress('0x5555555555555555555555555555555555555555');
const settlementFor = (wallet: Address): Settlement => ({ wallet, transaction: `0x${'5e'.repeat(32)}` });

describe.each(BACKENDS)('PaymentClaims rules on $name', (backend) => {
  onBackend(backend);

  it('holds at most MAX_CLAIMS, forgets only expired claims no request holds, and lets an unsure claim pass to one retry', { timeout: 60_000 }, async () => {
    expect(MAX_PAYMENT_CLAIMS).toBe(MAX_CLAIMS);
    const { store: claims, count, fillUnsure } = await claimBackend();
    const now = 1_000n;
    await fillUnsure(MAX_CLAIMS - 1, now + 10n, now);
    expect(await claims.claim('held', now + 10n, 'holder', now)).toBe('taken');
    expect(await count()).toBe(MAX_CLAIMS);
    expect(await claims.claim('one-more', now + 100n, 'one-more', now)).toBe('full');
    expect(await claims.claim('late', now + 100n, 'late', now + 10n)).toBe('taken');
    expect(await count()).toBe(2);
    expect(await claims.claim('expired', now + 10n, 'expired', now + 10n)).toBe('expired');

    expect(await claims.claim('unsure', now + 50n, 'first', now)).toBe('taken');
    expect(await claims.claim('unsure', now + 50n, 'second', now)).toBe('in-use');
    await claims.keepUnsure('unsure', 'first');
    expect(await claims.claim('unsure', now + 50n, 'second', now)).toBe('taken');
    expect(await claims.claim('unsure', now + 50n, 'third', now)).toBe('in-use');
    await claims.release('unsure', 'first');
    await claims.markSettled('unsure', 'second', settlementFor(WALLET), now);
    await claims.release('unsure', 'second');
    expect(await claims.claim('unsure', now + 50n, 'fourth', now)).toBe('in-use');
  });

  it('refuses a validBefore past maxTimeoutSeconds plus the clock allowance, and remembers every claim until its validBefore', async () => {
    const { store: claims, count } = await claimBackend();
    const now = 1_000n;
    const latest = now + 300n + CLOCK_ALLOWANCE_SECONDS;
    expect(await claims.claim('years', now + 10n * 365n * 86_400n, 'a', now)).toBe('too-long');
    expect(await claims.claim('just-over', latest + 1n, 'b', now)).toBe('too-long');
    expect(await count()).toBe(0);

    expect(await claims.claim('settled', latest, 'payer', now)).toBe('taken');
    await claims.markSettled('settled', 'payer', settlementFor(WALLET), now);
    expect(await claims.claim('unsure', latest, 'retrier', now)).toBe('taken');
    await claims.keepUnsure('unsure', 'retrier');
    expect(await claims.claim('settled', latest, 'c', latest - 1n)).toBe('in-use');
    expect(await claims.claim('unsure', latest, 'late', latest - 1n)).toBe('taken');
    await claims.keepUnsure('unsure', 'late');
    expect(await claims.claim('settled', latest, 'd', latest)).toBe('expired');
    expect(await claims.claim('unsure', latest, 'e', latest)).toBe('expired');
  });

  it('C25: keeps a settled claim for a day from its settlement, redeems it only for its wallet and one owner at a time, and forgets it after', async () => {
    const { store: claims, count } = await claimBackend();
    const settledAt = 1_000n;
    const day = BigInt(PAID_RESULT_KEEP_SECONDS);
    expect(await claims.claim('paid', settledAt + 300n, 'payer', settledAt)).toBe('taken');
    await claims.markSettled('paid', 'payer', settlementFor(WALLET), settledAt);
    // The settling request owns it while it screens, so no copy screens beside it. Its own wallet hears in-use; another
    // wallet is refused, owned or not, because it is not this payment's buyer.
    expect(await claims.redeem('paid', WALLET, 'copy', settledAt + 1n)).toEqual({ found: 'in-use' });
    expect(await claims.redeem('paid', OTHER_WALLET, 'other', settledAt + 1n)).toEqual({ found: 'refused' });
    await claims.leave('paid', 'payer', false);

    expect(await claims.redeem('paid', OTHER_WALLET, 'other', settledAt + 400n)).toEqual({ found: 'refused' });
    const both = await Promise.all(['first', 'second'].map((owner) => claims.redeem('paid', WALLET, owner, settledAt + 400n)));
    expect(both.map((found) => found.found).sort()).toEqual(['in-use', 'settled']);
    expect(both.find((found) => found.found === 'settled')).toEqual({ found: 'settled', transaction: SETTLE_TX, screening: 2 });
    const winner = both[0]?.found === 'settled' ? 'first' : 'second';
    // An owner past its lease is surely gone, so a later copy takes the claim over; both tries are used, so it gets the
    // claim to store the time-up hold, not a third screening (C26).
    expect(await claims.redeem('paid', WALLET, 'third', settledAt + 400n + BigInt(LEASE_SECONDS))).toEqual({
      found: 'spent',
      transaction: SETTLE_TX,
    });
    await claims.serve('paid', winner, { late: true });
    await claims.serve('paid', 'third', { result: 1 });
    expect(await claims.redeem('paid', WALLET, 'fetch', settledAt + day - 1n)).toEqual({
      found: 'served',
      transaction: SETTLE_TX,
      body: { result: 1 },
    });
    expect(await claims.redeem('paid', OTHER_WALLET, 'fetch', settledAt + day - 1n)).toEqual({ found: 'refused' });
    // Past its day the claim is gone for redeeming, and its authorization has long expired.
    expect(await claims.redeem('paid', WALLET, 'fetch', settledAt + day)).toEqual({ found: 'none' });
    expect(await claims.claim('paid', settledAt + 300n, 'fetch', settledAt + day)).toBe('expired');
    // Refusing it wrote nothing: the row waits for the sweep.
    expect(await count()).toBe(1);
  });

  it('C26: counts a try as each owner takes the claim, gives back only an unstarted one, and never lets a third start, whatever the order of takes, leaves and dead owners', async () => {
    // A seeded walk over every step a request can take on one settled claim. Each owner either starts its screening,
    // hands its try back unstarted, or dies holding the claim until its lease runs out. The count of screenings
    // started must never pass REDEEM_SCREEN_TRIES, and once it reaches it every later taker gets 'spent'.
    let seed = 7;
    const next = (range: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % range;
    };
    for (let run = 0; run < 12; run += 1) {
      const { store: claims } = await claimBackend();
      let clock = 1_000n;
      const key = `walk-${run}`;
      expect(await claims.claim(key, clock + 300n, 'first', clock)).toBe('taken');
      await claims.markSettled(key, 'first', settlementFor(WALLET), clock);
      let owner: string | null = 'first';
      let started = 0;
      let spentSeen = false;
      for (let step = 0; step < 25; step += 1) {
        if (owner !== null) {
          const choice = next(3);
          if (choice === 0) {
            started += 1;
            await claims.leave(key, owner, false);
          } else if (choice === 1) {
            await claims.leave(key, owner, true);
          } else {
            // Dies holding it: its try stays used, and its lease is what frees the claim.
            started += 1;
            clock += BigInt(LEASE_SECONDS);
          }
          owner = null;
          continue;
        }
        const taker = `owner-${run}-${step}`;
        const found = await claims.redeem(key, WALLET, taker, clock);
        expect(found.found, `run ${run} step ${step}`).not.toBe('in-use');
        if (found.found === 'settled') {
          expect(spentSeen, `run ${run} step ${step}`).toBe(false);
          expect(found.screening).toBe(started + 1);
          owner = taker;
        } else {
          expect(found.found).toBe('spent');
          spentSeen = true;
          // Even asking to hand a try back cannot reopen it: this taker counted none.
          await claims.leave(key, taker, true);
        }
        expect(started, `run ${run} step ${step}`).toBeLessThanOrEqual(REDEEM_SCREEN_TRIES);
      }
      expect(started).toBeLessThanOrEqual(REDEEM_SCREEN_TRIES);
    }
  });
});

describe('canonicalClient', () => {
  it('names a client in one spelling: IPv4 as itself, IPv4 inside IPv6 as IPv4, any other IPv6 by its /64', () => {
    expect(canonicalClient(' 203.0.113.9 ')).toBe('203.0.113.9');
    expect(canonicalClient('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(canonicalClient('2001:DB8:1:2::5')).toBe('2001:db8:1:2::/64');
    expect(canonicalClient('2001:0db8:0001:0002:ffff:1:2:3')).toBe('2001:db8:1:2::/64');
    expect(canonicalClient('2001:db8:1:3::5')).toBe('2001:db8:1:3::/64');
    expect(canonicalClient('::1')).toBe('0:0:0:0::/64');
    for (const bad of [undefined, '', 'evil.example', '203.0.113.256', '01.2.3.4', 'fe80::1%eth0']) {
      expect(canonicalClient(bad)).toBeNull();
    }
  });
});

/** A limit store on the current backend, and for memory the number of clients its table holds. */
async function limitBackend(now: () => Date): Promise<{ limits: LimitStore; tracked: (() => number) | null }> {
  if (backendDb !== null) return { limits: (await freshStores(now)).limits, tracked: null };
  const limits = new ClientLimits(now);
  return { limits: limitStoreOver(limits), tracked: () => limits.size };
}

describe.each(BACKENDS)('ClientLimits rules on $name', (backend) => {
  onBackend(backend);

  it('reopens each window as it ages out, allows one paid request at a time, and forgets a client idle for an hour', async () => {
    let clock = new Date('2026-11-10T08:00:00.000Z');
    const later = (ms: number) => (clock = new Date(clock.getTime() + ms));
    const { limits, tracked } = await limitBackend(() => clock);
    const admitted = async (client: string, paying: boolean): Promise<Pass> => {
      const pass = await limits.enter(client, paying);
      if ('refused' in pass) throw new Error(`refused for ${pass.refused}`);
      return pass;
    };

    const first = await admitted('a', true);
    expect(await limits.enter('a', true)).toEqual({ refused: 'running' });
    await admitted('a', false);
    first.paymentFailed = true;
    await limits.leave(first);
    await limits.leave(first);
    for (let index = 1; index < CLIENT_MAX_FAILED_PER_HOUR; index += 1) {
      const pass = await admitted('a', true);
      pass.paymentFailed = true;
      await limits.leave(pass);
    }
    expect(await limits.enter('a', false)).toEqual({ refused: 'failed' });
    expect(await limits.enter('a', true)).toEqual({ refused: 'failed' });
    later(3_600_001);
    await limits.leave(await admitted('a', true));

    for (let index = 1; index < CLIENT_MAX_PER_MINUTE; index += 1) await admitted('b', false);
    await admitted('b', false);
    expect(await limits.enter('b', false)).toEqual({ refused: 'minute' });
    later(60_001);
    await admitted('b', false);

    // Forgetting idle clients is how the in-memory table stays bounded. The shared stores keep no table of clients and
    // are bounded by sweep instead, so only memory has a size to read.
    if (tracked !== null) expect(tracked()).toBe(2);
    later(3_600_000);
    await admitted('c', false);
    if (tracked !== null) expect(tracked()).toBe(1);
  });
});

describe('ClientLimits in memory (C41)', () => {
  // The shared stores have no cap on clients tracked, so a new caller is never refused for 'clients' there.
  it('refuses a new client as busy only while every tracked client has a request in flight', () => {
    const clock = new Date('2026-11-10T08:00:00.000Z');
    const limits = new ClientLimits(() => clock);
    const passes: Pass[] = [];
    for (let index = 0; index < MAX_CLIENTS_TRACKED; index += 1) {
      const pass = limits.enter(`running-${index}`, true);
      if ('refused' in pass) throw new Error(`refused for ${pass.refused}`);
      passes.push(pass);
    }
    expect(limits.enter('newcomer', false)).toEqual({ refused: 'clients' });
    limits.leave(passes[500] as Pass);
    const admitted = limits.enter('newcomer', false);
    expect('refused' in admitted).toBe(false);
    expect(limits.size).toBe(MAX_CLIENTS_TRACKED);
    expect(limits.enter('running-500', true)).not.toEqual({ refused: 'running' });
  });
});

describe.each(BACKENDS)('ScreenGuard rules on $name', (backend) => {
  onBackend(backend);

  it('stops at the daily ceiling, refuses entry there, and opens again the next UTC day', async () => {
    let clock = new Date('2026-11-10T08:00:00.000Z');
    const { guard } = await freshStores(() => clock);
    // The in-memory guard counts requests in flight toward the day; the shared one keeps MAX_RUNNING of headroom instead.
    const room = backendDb === null ? MAX_PER_DAY : SHARED_DAY_ROOM;
    const screened = async () => {
      const ticket = await guard.enter();
      if (ticket === null) throw new Error('refused before the ceiling');
      await guard.start(ticket);
      await guard.leave(ticket);
    };
    for (let index = 0; index < room - 1; index += 1) await screened();
    expect(await guard.busy()).toBe(false);
    await screened();
    expect(await guard.busy()).toBe(true);
    expect(await guard.enter()).toBeNull();
    clock = new Date('2026-11-11T00:00:01.000Z');
    expect(await guard.busy()).toBe(false);
  });
});

describe('ScreenGuard in memory', () => {
  // The shared guard does not count requests in flight toward the day: it stops MAX_RUNNING short instead, shown by the
  // C24 test on two copies below.
  it('stops at the daily ceiling, counts paid requests still in flight, and opens again the next UTC day', () => {
    let clock = new Date('2026-11-10T08:00:00.000Z');
    const guard = new ScreenGuard(() => clock);
    for (let index = 0; index < MAX_PER_DAY - 1; index += 1) {
      const ticket = guard.enter();
      guard.start(ticket);
      guard.leave(ticket);
    }
    expect(guard.busy()).toBe(false);
    const inFlight = guard.enter();
    expect(guard.busy()).toBe(true);
    guard.leave(inFlight);
    expect(guard.busy()).toBe(false);
    const last = guard.enter();
    guard.start(last);
    guard.leave(last);
    expect(guard.busy()).toBe(true);
    clock = new Date('2026-11-11T00:00:01.000Z');
    expect(guard.busy()).toBe(false);
  });
});

describe('GET /api/x402/health', () => {
  it('needs no payment and returns only the network, payTo, price and scope', async () => {
    const { app } = await setup();
    const response = await app.request(HEALTH_PATH);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      network: 'eip155:84532',
      payTo: PAY_TO,
      price: '$0.05',
      scope: 'one wallet on Ethereum, no claim list',
    });
  });
});

/** A copy of the app on the current backend whose named store calls fail, configured with a database URL to leak. */
async function brokenCopy(calls: StoreCall[], options: Omit<SetupOptions, 'stores' | 'config'> = {}) {
  const facilitator = options.facilitator ?? new StubFacilitator('eip155:84532');
  const now = options.now ?? (() => new Date());
  return setup({
    ...options,
    facilitator,
    now,
    config: { ...testnetConfig(facilitator), databaseUrl: DATABASE_URL },
    stores: failing(await freshStores(now), calls),
  });
}

describe.each(BACKENDS)('a store that fails (C25, C40), on $name', (backend) => {
  onBackend(backend);

  it('before a settlement is confirmed, refuses: busy before a claim, retry once one was attempted, and a store throwing inside a payment hook never leads to a settle or a screening', async () => {
    const logs = captureLogs();
    try {
      const healthy = await setup();
      const header = await signedHeader(healthy.appFetch, healthy.client);
      const bodies: string[] = [];

      const beforeClaim: StoreCall[][] = [['limits.enter'], ['guard.busy', 'guard.enter']];
      for (const calls of beforeClaim) {
        const { app, appFetch, facilitator, screen } = await brokenCopy(calls);
        for (const extra of [{}, header]) {
          const reply = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, extra));
          const body = await reply.text();
          bodies.push(body);
          expect(reply.status, calls.join()).toBe(503);
          expect(JSON.parse(body), calls.join()).toEqual({ busy: true });
          expect(reply.headers.get('payment-required'), calls.join()).toBeNull();
        }
        bodies.push(await (await app.request(HEALTH_PATH)).text());
        expect(facilitator.settled).toHaveLength(0);
        expect(screen).not.toHaveBeenCalled();
      }

      // The claim could not be looked up or recorded, so the facilitator is never asked to settle on it.
      for (const calls of [['claims.redeem'], ['claims.claim']] as StoreCall[][]) {
        const claimDown = await brokenCopy(calls);
        const unrecorded = await claimDown.appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header));
        const unrecordedBody = await unrecorded.text();
        bodies.push(unrecordedBody);
        expect(unrecorded.status, calls.join()).toBe(503);
        expect(JSON.parse(unrecordedBody), calls.join()).toEqual({ retry: true });
        expect(unrecorded.headers.get('payment-response'), calls.join()).toBeNull();
        expect(claimDown.facilitator.settled, calls.join()).toHaveLength(0);
        expect(claimDown.screen, calls.join()).not.toHaveBeenCalled();
      }

      // The settlement's outcome is unknown and keeping the claim as unsure fails as well: still retry, no screening.
      const unsureDown = await brokenCopy(['claims.keepUnsure']);
      unsureDown.facilitator.respond = async () => {
        throw new Error('socket hang up');
      };
      const lost = await unsureDown.appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header));
      const lostBody = await lost.text();
      bodies.push(lostBody);
      expect(lost.status).toBe(503);
      expect(JSON.parse(lostBody)).toEqual({ retry: true });
      expect(unsureDown.screen).not.toHaveBeenCalled();
      // The stated non-goal: the claim stays held by a request that is gone, so the same header is refused, and never
      // served, until it expires.
      unsureDown.facilitator.respond = null;
      const again = await unsureDown.fetchAs('198.51.100.71')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
      expect(again.status).toBe(402);
      expect(decodePaymentResponseHeader(again.headers.get('payment-response') as string)).toMatchObject({ errorReason: 'payment_already_used' });
      expect(unsureDown.screen).not.toHaveBeenCalled();

      const logged = logs.text();
      expect(logged).toContain('api store failed');
      expect(logged).toContain('ECONNREFUSED');
      expect(logged).not.toContain('hook threw');
      expectNoDatabaseUrl(logged);
      expectNoDatabaseUrl(bodies.join('\n'));
    } finally {
      logs.restore();
    }
  });

  it('after a settlement is confirmed, serves the buyer whatever the store does, keeps the claim held so no copy is served, and keeps a decided reply when giving places back fails', async () => {
    const logs = captureLogs();
    try {
      const settled = await brokenCopy(['claims.markSettled', 'guard.start', 'guard.leave', 'claims.release', 'limits.leave']);
      const paid = await settled.pay(url(SCREEN_PATH), post({ wallet: WALLET }));
      const paidBody = await paid.text();
      expect(paid.status).toBe(200);
      expect(PaidScreenResponse.parse(JSON.parse(paidBody)).payment.transaction).toBe(SETTLE_TX);
      const copy = await settled.fetchAs('198.51.100.81')(
        url(SCREEN_PATH),
        post({ wallet: WALLET }, { 'PAYMENT-SIGNATURE': settled.sentSignatures[0] as string }),
      );
      expect(copy.status).toBe(402);
      expect(decodePaymentResponseHeader(copy.headers.get('payment-response') as string)).toMatchObject({ errorReason: 'payment_already_used' });
      expect(settled.screen).toHaveBeenCalledTimes(1);
      expect(settled.facilitator.settled).toHaveLength(1);

      // A settlement left pending and proven by its receipt is served the same way when marking it settled fails.
      const pendingFacilitator = new StubFacilitator('eip155:84532');
      pendingFacilitator.respond = pendingAnswer;
      const pending = await brokenCopy(['claims.markSettled'], {
        facilitator: pendingFacilitator,
        readReceipt: provingReceipt(pendingFacilitator).read,
      });
      const header = await signedHeader(pending.appFetch, pending.client);
      const proven = await pending.appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header));
      expect(proven.status).toBe(200);
      expect(PaidScreenResponse.parse(await proven.json()).payment.transaction).toBe(PENDING_TX);
      const replay = await pending.fetchAs('198.51.100.82')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
      expect(replay.status).toBe(402);
      expect(pending.screen).toHaveBeenCalledTimes(1);

      // A plain refusal stays a plain refusal when giving the places back fails.
      const refusedFacilitator = new StubFacilitator('eip155:84532');
      refusedFacilitator.failSettle = true;
      const refused = await brokenCopy(['claims.release', 'guard.leave', 'limits.leave'], { facilitator: refusedFacilitator });
      expect((await refused.pay(url(SCREEN_PATH), post({ wallet: WALLET }))).status).toBe(402);
      expect(refused.screen).not.toHaveBeenCalled();

      // The result cannot be stored and the claim cannot be given back: the buyer still gets it, and a copy is told to
      // come back while the request's ownership lasts, never served a second screening beside it.
      const unstored = await brokenCopy(['claims.serve', 'claims.leave']);
      const fresh = await unstored.pay(url(SCREEN_PATH), post({ wallet: WALLET }));
      expect(fresh.status).toBe(200);
      expect(PaidScreenResponse.safeParse(await fresh.json()).success).toBe(true);
      const meanwhile = await unstored.fetchAs('198.51.100.83')(
        url(SCREEN_PATH),
        post({ wallet: WALLET }, { 'PAYMENT-SIGNATURE': unstored.sentSignatures[0] as string }),
      );
      expect(meanwhile.status).toBe(503);
      expect(SettledRetryBody.safeParse(await meanwhile.json()).success).toBe(true);
      expect(unstored.screen).toHaveBeenCalledTimes(1);
      expect(unstored.facilitator.settled).toHaveLength(1);

      const logged = logs.text();
      expect(logged).toContain('api store failed while marking a payment settled: Error (ECONNREFUSED)');
      expect(logged).toContain('api store failed while counting a screening');
      expect(logged).toContain('api store failed while giving back a place');
      expect(logged).toContain('api store failed while storing a paid result: Error (ECONNREFUSED)');
      expect(logged).toContain('api store failed while giving back a settled payment');
      expectNoDatabaseUrl(logged);
      expectNoDatabaseUrl(paidBody);
    } finally {
      logs.restore();
    }
  });
});

describe.each(BACKENDS)('sweeping the stores (C41), on $name', (backend) => {
  onBackend(backend);

  it('sweeps once in every 200 requests without waiting for it, and a failing sweep changes no reply', async () => {
    const logs = captureLogs();
    try {
      let clock = new Date();
      const now = () => clock;
      const base = await freshStores(now);
      let down = false;
      const sweep = vi.fn(async () => {
        if (down) throw storeDown();
        await base.sweep();
      });
      const { app, appFetch } = await setup({ now, stores: { ...base, sweep } });
      // A place a dead copy never gave back, expired by the time of the sweep: on Postgres the sweep deletes its row.
      expect(await base.guard.enter()).not.toBeNull();
      clock = new Date(clock.getTime() + (LEASE_SECONDS + 1) * 1000);
      for (let index = 1; index < SWEEP_EVERY_REQUESTS; index += 1) await app.request(HEALTH_PATH);
      expect(sweep).not.toHaveBeenCalled();
      expect((await app.request(HEALTH_PATH)).status).toBe(200);
      expect(sweep).toHaveBeenCalledTimes(1);
      await sweep.mock.results[0]?.value;
      if (backendDb !== null) {
        const [row] = await backendDb.query<{ leases: number }>('SELECT count(*)::int AS leases FROM leases');
        expect(row?.leases).toBe(0);
      }

      down = true;
      for (let index = 1; index < SWEEP_EVERY_REQUESTS; index += 1) await app.request(HEALTH_PATH);
      const reply = await appFetch(url(SCREEN_PATH), post({ wallet: WALLET }));
      expect(reply.status).toBe(402);
      expect(reply.headers.get('payment-required')).not.toBeNull();
      expect(sweep).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(logs.text()).toContain('api sweep failed: Error (ECONNREFUSED)'));
      expectNoDatabaseUrl(logs.text());
    } finally {
      logs.restore();
    }
  });
});

/** Passes every query through to db and keeps its text, so a test can see what a request asked the store for. */
function recorded(db: Db, seen: string[]): Db {
  const noted = (target: Queryable): Queryable => ({
    query: <Row extends object = Record<string, unknown>>(text: string, params?: readonly unknown[]) => {
      seen.push(text);
      return target.query<Row>(text, params);
    },
  });
  return {
    ...noted(db),
    transaction: <T,>(fn: (tx: Queryable) => Promise<T>) => db.transaction((tx) => fn(noted(tx))),
    close: () => db.close(),
  };
}

describe('two copies of the API over one Postgres (C24, C25, C41, C42)', () => {
  let db: Db;
  beforeAll(async () => {
    db = await openMemoryDb();
    await migrate(db);
  }, 60_000);
  beforeEach(async () => {
    await db.query(`TRUNCATE ${TABLES}`);
  });
  afterAll(async () => {
    await db.close();
  });

  /** Two apps, as two serverless copies would be, sharing one database and one stand-in facilitator. */
  async function twoCopies(options: Omit<SetupOptions, 'stores'> & { storeDb?: Db } = {}) {
    const { storeDb = db, ...rest } = options;
    const facilitator = rest.facilitator ?? new StubFacilitator('eip155:84532');
    const now = rest.now ?? (() => new Date());
    const first = await setup({ ...rest, facilitator, now, stores: postgresStores(storeDb, now) });
    const second = await setup({ ...rest, facilitator, now, stores: postgresStores(storeDb, now) });
    const screens = () => first.screen.mock.calls.length + second.screen.mock.calls.length;
    return { first, second, facilitator, screens };
  }

  it('C25 across copies: one payment header sent 10 times at once, 5 to each copy, settles once and screens once', async () => {
    const { first, second, facilitator, screens } = await twoCopies();
    const header = await signedHeader(first.appFetch, first.client);
    const replies = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 === 0 ? first : second).fetchAs(`198.51.100.${index + 1}`)(url(SCREEN_PATH), post({ wallet: WALLET }, header)),
      ),
    );
    const statuses = replies.map((reply) => reply.status);
    const bodies = await Promise.all(replies.map((reply) => reply.text()));
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((status) => status === 200 || status === 402 || status === 503)).toBe(true);
    // A copy that arrives once the result is stored gets that same result: one answer, however many times it is fetched.
    const results = bodies.filter((body) => PaidScreenResponse.safeParse(JSON.parse(body)).success);
    expect(results.length).toBe(statuses.filter((status) => status === 200).length);
    expect(new Set(results).size).toBe(1);
    expect(facilitator.settled).toHaveLength(1);
    expect(screens()).toBe(1);
  });

  it('C25 unknown outcome across copies: a settle that throws on one copy leaves the claim unsure, the other copy screens the retry once, and an expired header that bought nothing is refused with no claim write', async () => {
    let clock = new Date();
    const seen: string[] = [];
    const { first, second, facilitator, screens } = await twoCopies({ now: () => clock, storeDb: recorded(db, seen) });
    const header = await signedHeader(first.appFetch, first.client);
    facilitator.respond = async () => {
      throw new Error('socket hang up');
    };
    const lost = await first.appFetch(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(lost.status).toBe(503);
    expect(await lost.json()).toEqual({ retry: true });
    expect(await db.query('SELECT state FROM payment_claims')).toEqual([{ state: 'unsure' }]);

    facilitator.respond = null;
    const retried = await second.fetchAs('198.51.100.20')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(retried.status).toBe(200);
    const result = await retried.text();
    expect(PaidScreenResponse.safeParse(JSON.parse(result)).success).toBe(true);
    // The other copy reads the result the first stored: the same answer, no settle and no screening.
    const again = await first.fetchAs('198.51.100.21')(url(SCREEN_PATH), post({ wallet: WALLET }, header));
    expect(again.status).toBe(200);
    expect(again.headers.get(STORED_HEADER)).toBe('true');
    expect(await again.text()).toBe(result);
    expect(screens()).toBe(1);
    expect(facilitator.settled).toHaveLength(2);

    // A header that bought nothing, sent once its validBefore has passed, is refused before any claim is written.
    const unused = await signedHeader(first.appFetch, first.client);
    const unusedValidBefore = Number(authorizationFrom(decodePaymentSignatureHeader(Object.values(unused)[0] as string)).validBefore);
    clock = new Date(unusedValidBefore * 1000);
    seen.length = 0;
    const expired = await second.fetchAs('198.51.100.22')(url(SCREEN_PATH), post({ wallet: WALLET }, unused));
    expect(expired.status).toBe(402);
    expect(decodePaymentResponseHeader(expired.headers.get('payment-response') as string)).toMatchObject({ errorReason: 'payment_expired' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((text) => /\b(INSERT|UPDATE|DELETE)\b/.test(text) && text.includes('payment_claims'))).toEqual([]);
    expect(await db.query('SELECT state FROM payment_claims')).toEqual([{ state: 'served' }]);
    expect(screens()).toBe(1);
  });

  it('C42 across copies: one caller alternating between copies meets the same per-minute, in-flight and failed-attempt limits, and another caller does not', async () => {
    const logs = captureLogs();
    try {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let holdScreens = false;
      const { first, second, facilitator } = await twoCopies({
        screen: async (wallet) => {
          if (holdScreens) await gate;
          return screenResult(wallet);
        },
      });
      const copies: Copy[] = [first, second];
      const alternate = (index: number) => copies[index % 2] as Copy;

      const minute: number[] = [];
      for (let index = 0; index <= CLIENT_MAX_PER_MINUTE; index += 1) {
        minute.push((await alternate(index).fetchAs('203.0.113.50')(url(SCREEN_PATH), post({ wallet: WALLET }))).status);
      }
      expect(minute).toEqual([...Array(CLIENT_MAX_PER_MINUTE).fill(402), 429]);
      expect((await second.fetchAs('198.51.100.60')(url(SCREEN_PATH), post({ wallet: WALLET }))).status).toBe(402);

      holdScreens = true;
      const held = first.payAs('203.0.113.51')(url(SCREEN_PATH), post({ wallet: WALLET }));
      await vi.waitFor(() => expect(first.screen).toHaveBeenCalledTimes(1));
      const header = await signedHeader(second.appFetch, second.client);
      expect((await second.fetchAs('203.0.113.51')(url(SCREEN_PATH), post({ wallet: WALLET }, header))).status).toBe(429);
      expect((await second.fetchAs('203.0.113.51')(url(SCREEN_PATH), post({ wallet: WALLET }))).status).toBe(402);
      const other = second.payAs('198.51.100.61')(url(SCREEN_PATH), post({ wallet: WALLET }));
      release();
      expect((await held).status).toBe(200);
      expect((await other).status).toBe(200);
      // The refused copy counted nothing and claimed nothing, so the same header now goes through.
      expect((await second.fetchAs('203.0.113.51')(url(SCREEN_PATH), post({ wallet: WALLET }, header))).status).toBe(200);

      const unfunded = privateKeyToAccount(generatePrivateKey());
      facilitator.unfunded.add(unfunded.address.toLowerCase());
      const terms = decodePaymentRequiredHeader(
        (await first.fetchAs('192.0.2.201')(url(SCREEN_PATH), post({ wallet: WALLET }))).headers.get('payment-required') as string,
      );
      const signer = new x402HTTPClient(new x402Client().register('eip155:84532', new ExactEvmScheme(unfunded)));
      const failed: number[] = [];
      for (let index = 0; index <= CLIENT_MAX_FAILED_PER_HOUR; index += 1) {
        const unpaidHeader = signer.encodePaymentSignatureHeader(await signer.createPaymentPayload(terms));
        failed.push((await alternate(index).fetchAs('203.0.113.52')(url(SCREEN_PATH), post({ wallet: WALLET }, unpaidHeader))).status);
      }
      expect(failed).toEqual([...Array(CLIENT_MAX_FAILED_PER_HOUR).fill(402), 429]);
      expect((await second.fetchAs('203.0.113.52')(url(SCREEN_PATH), post({ wallet: WALLET }))).status).toBe(429);
      const unfundedSettles = facilitator.settled.filter((payload) => authorizationFrom(payload).from.toLowerCase() === unfunded.address.toLowerCase());
      expect(unfundedSettles).toHaveLength(CLIENT_MAX_FAILED_PER_HOUR);
      expect((await first.payAs('198.51.100.62')(url(SCREEN_PATH), post({ wallet: WALLET }))).status).toBe(200);
    } finally {
      logs.restore();
    }
  });

  it('C41: places left by a copy that never gave them back stop counting after their 330 seconds', async () => {
    // A paid request ends by its 240 s deadline and takes its places after its first line, so a 330 s lease outlives it
    // by 90 s: no live request loses its place.
    expect(LEASE_SECONDS).toBe(330);
    expect(REQUEST_DEADLINE_MS).toBe(240_000);
    expect(LEASE_SECONDS * 1000 - REQUEST_DEADLINE_MS).toBe(90_000);
    let clock = new Date('2026-11-11T08:00:00.000Z');
    const { second } = await twoCopies({ now: () => clock });
    const crashed = postgresStores(db, () => clock).guard;
    for (let index = 0; index < MAX_RUNNING; index += 1) expect(await crashed.enter()).not.toBeNull();
    const full = await second.appFetch(url(SCREEN_PATH), post({ wallet: WALLET }));
    expect(full.status).toBe(503);
    expect(await full.json()).toEqual({ busy: true });
    expect(full.headers.get('payment-required')).toBeNull();
    clock = new Date(clock.getTime() + LEASE_SECONDS * 1000 - 1);
    expect((await second.fetchAs('198.51.100.30')(url(SCREEN_PATH), post({ wallet: WALLET }))).status).toBe(503);
    clock = new Date(clock.getTime() + 1);
    const freed = await second.fetchAs('198.51.100.31')(url(SCREEN_PATH), post({ wallet: WALLET }));
    expect(freed.status).toBe(402);
    expect(freed.headers.get('payment-required')).not.toBeNull();
  });

  it('C24: with MAX_PER_DAY minus MAX_RUNNING screenings counted today a new request is busy before payment, and every request that entered is served', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { first, second, facilitator, screens } = await twoCopies({
      screen: async (wallet) => {
        await gate;
        return screenResult(wallet);
      },
    });
    const headers: Record<string, string>[] = [];
    for (let index = 0; index <= MAX_RUNNING; index += 1) headers.push(await signedHeader(first.appFetch, first.client));
    const counter = postgresStores(db, () => new Date()).guard;
    for (let index = 0; index < SHARED_DAY_ROOM - 1; index += 1) {
      const ticket = await counter.enter();
      if (ticket === null) throw new Error('refused before the headroom');
      await counter.start(ticket);
      await counter.leave(ticket);
    }
    // One short of the headroom, MAX_RUNNING paid requests enter together: each starts, and the day still ends at or
    // under MAX_PER_DAY, so none of them is refused for the day after it paid.
    const running = headers.slice(0, MAX_RUNNING).map((header, index) =>
      (index % 2 === 0 ? first : second).fetchAs(`198.51.100.${index + 1}`)(url(SCREEN_PATH), post({ wallet: WALLET }, header)),
    );
    await vi.waitFor(() => expect(screens()).toBe(MAX_RUNNING));
    release();
    expect((await Promise.all(running)).map((reply) => reply.status)).toEqual(Array(MAX_RUNNING).fill(200));
    const counted = await dayCount(db, 'paid-screenings', new Date());
    expect(counted).toBe(SHARED_DAY_ROOM - 1 + MAX_RUNNING);
    expect(counted).toBeLessThanOrEqual(MAX_PER_DAY);

    const unpaid = await second.fetchAs('198.51.100.50')(url(SCREEN_PATH), post({ wallet: WALLET }));
    expect(unpaid.status).toBe(503);
    expect(await unpaid.json()).toEqual({ busy: true });
    expect(unpaid.headers.get('payment-required')).toBeNull();
    const paying = await first.fetchAs('198.51.100.51')(url(SCREEN_PATH), post({ wallet: WALLET }, headers[MAX_RUNNING] as Record<string, string>));
    expect(paying.status).toBe(503);
    expect(await paying.json()).toEqual({ busy: true });
    expect(facilitator.settled).toHaveLength(MAX_RUNNING);
    expect(screens()).toBe(MAX_RUNNING);
  });
});

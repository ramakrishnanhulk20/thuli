import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { AfterSettleAbortError, type FacilitatorClient, type RoutesConfig } from '@x402/core/server';
import { SettleError } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { bazaarResourceServerExtension, declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { AddressError, CURRENT_RULEBOOK, parseAddress, type Address } from '@thuli/core';
import type { CheckKey } from '@thuli/store';
import { heldScreen, NOT_CHECKED, SCREEN_CAUSES, SINGLE_SCOPE, type SingleScreen } from '@thuli/worker/src/screen/single.ts';
import { MAX_TIMEOUT_SECONDS, readPaymentTerms, type ClaimResult } from './claims.ts';
import { PRICE, PRICE_UNITS, type ApiConfig } from './config.ts';
import type { Ticket } from './guard.ts';
import { canonicalClient, type Limit, type Pass } from './limits.ts';
import { receiptPays, receiptReader, type ReadReceipt } from './receipt.ts';
import { cachedBody, freeBody, paidBody, PaidScreenResponse, Payment, ScreenRequest, type FreeCheckResponse } from './schema.ts';
import { failureCode, memoryStores, type CheckPlace, type CheckRefusal, type Stores } from './stores.ts';

export const SCREEN_PATH = '/api/x402/screen';
export const HEALTH_PATH = '/api/x402/health';
export const CHECK_PATH = '/api/check';
export const CHECK_HEALTH_PATH = '/api/check/health';

/** The single-wallet screening reads Ethereum mainnet only, so every cached check is for chain 1. */
const CHECK_CHAIN = 1;
/** How long a free check the rulebook's checks accepted is served from the cache (C24). */
export const CHECK_KEEP_SECONDS = 86_400;
/**
 * How long a hold from a failed or refused screening is served from the cache: short, so an outage is not frozen in for
 * a day, and still long enough that repeating the check during one cannot run up the bill.
 */
export const CHECK_KEEP_HELD_SECONDS = 300;

// A real request is about 60 bytes: {"wallet":"0x" plus 40 hex}. Anything near this is not a screening request (C41).
const MAX_BODY_BYTES = 1024;
/** One request in this many sweeps the stores, so a short-lived serverless copy still cleans up after itself (C41). */
export const SWEEP_EVERY_REQUESTS = 200;
// Kept under the 500 characters past which verify fails (x402 issue 2284), and written as a description, not an instruction.
const DESCRIPTION =
  "Screens one Ethereum wallet with Thuli's airdrop rulebook v2 and returns a decision (full, partial, hold or exclude) " +
  'with the rule, a plain reason and the transactions behind it. One wallet on its own, no claim list.';
const EXAMPLE_WALLET = '0x041f77015fe51c51aE49a7f2F3Ff86C641fa190a';

export interface ApiDeps {
  /** Screens one canonical address and resolves with a decision. screenOneWallet never rejects for a parsed address. */
  screen(wallet: Address): Promise<SingleScreen>;
  now?: () => Date;
  /** Reads a receipt on the payment's chain. Defaults to config.settlementRpcUrl. */
  readReceipt?: ReadReceipt;
  /** Where used payments and the limits live. Defaults to this process's memory, which is right only for one server. */
  stores?: Stores;
}

interface AppEnv {
  /** pass is set on the paid route, client on the free check. */
  Variables: { wallet: Address; pass: Pass; client: string };
}

/** What one paid request carries through the payment middleware to the handler, in its own async context. */
interface PaidRequest {
  ticket: Ticket;
  /** A fresh random id, this request's name as the owner of its claim. */
  owner: string;
  /** The claim this request took, or may have taken when the store failed while it was being written. */
  claim: { key: string; payer: Address; nonce: `0x${string}` } | null;
  /** True once the claim was marked used or unsure. From then on it is never released, even if that write failed. */
  kept: boolean;
  payment: Payment | null;
  /** True when the latest settle call threw rather than answering, so its outcome is unknown. */
  settleThrew: boolean;
  /** Set when the reply must replace the payment middleware's: retry for an unknown outcome, busy for a full claim map. */
  answer: 'retry' | 'busy' | null;
}

const TxHashText = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((hash) => hash.toLowerCase() as `0x${string}`);

const AddressText = z.string().transform((value, ctx) => {
  try {
    return parseAddress(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'not an address' });
    return z.NEVER;
  }
});

const SettleReceipt = z.object({
  network: z.string(),
  payer: AddressText,
  transaction: TxHashText,
});

const refuse = (reason: string, message?: string) => ({ abort: true as const, reason, ...(message !== undefined && { message }) });

// Logged by its class and code only: a store's message can quote a query value or the database host (C40).
function storeFailed(step: string, error: unknown): void {
  console.warn(`api store failed while ${step}: ${failureCode(error)}`);
}

/** Runs one store call whose failure must not change the reply already decided, such as giving a place back. */
async function giveBack(step: string, call: () => Promise<void>): Promise<void> {
  try {
    await call();
  } catch (error) {
    storeFailed(step, error);
  }
}

// The same test the payment middleware uses to decide a request is paying, so the two never disagree about one request.
const isPaying = (c: Context) => Boolean(c.req.header('payment-signature') || c.req.header('x-payment'));

/**
 * The caller's address: the configured trusted header when one is set, otherwise the socket's peer address.
 * X-Forwarded-For is never read unless it is the configured name. Null when the address cannot be read, or when the
 * trusted header holds a list: behind a proxy that appends, the first value is the one the client wrote, and a header
 * sent twice arrives as a list too.
 */
function clientOf(c: Context, trustedHeader: string | null): string | null {
  if (trustedHeader !== null) {
    const value = c.req.header(trustedHeader);
    return value === undefined || value.includes(',') ? null : canonicalClient(value);
  }
  try {
    return canonicalClient(getConnInfo(c).remote.address);
  } catch {
    return null;
  }
}

// The root $schema keyword is dropped because the Bazaar nests this inside its own schema. The date-time format is
// dropped because the Bazaar's validator cannot check formats and warns on every compile; the pattern beside it stays.
const { $schema: _rootKeyword, ...OUTPUT_SCHEMA } = z.toJSONSchema(PaidScreenResponse, {
  override: (ctx) => {
    delete ctx.jsonSchema.format;
  },
});

// The Bazaar publishes an output schema only beside an example. This one is built here from placeholder addresses, says
// it is an example, and must pass the real response schema, so it can never drift from what the route returns.
function exampleOutput(config: ApiConfig): PaidScreenResponse {
  return PaidScreenResponse.parse({
    wallet: '0x0000000000000000000000000000000000000001',
    checkedAt: '2026-11-10T12:00:00.000Z',
    scope: SINGLE_SCOPE,
    rulebook: 'v2',
    decision: {
      action: 'hold',
      shareBps: 0,
      rule: 'A1',
      reason: 'Example only. A real reply names its rule and the facts behind it here.',
      citedTxs: [],
    },
    servRequestId: null,
    notChecked: [...NOT_CHECKED],
    payment: {
      network: config.networkId,
      payer: '0x0000000000000000000000000000000000000002',
      transaction: `0x${'0'.repeat(64)}`,
    },
  });
}

function screenRoutes(config: ApiConfig): RoutesConfig {
  return {
    [`POST ${SCREEN_PATH}`]: {
      accepts: [
        {
          scheme: 'exact',
          price: PRICE,
          network: config.networkId,
          payTo: config.payTo,
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
          extra: { paymentFlow: 'upfront' },
        },
      ],
      // The library would build this from the request URL, which Node builds from the client's Host header.
      ...(config.publicOrigin !== null && { resource: `${config.publicOrigin}${SCREEN_PATH}` }),
      description: DESCRIPTION,
      mimeType: 'application/json',
      extensions: {
        ...declareDiscoveryExtension({
          bodyType: 'json',
          input: { wallet: EXAMPLE_WALLET },
          inputSchema: {
            properties: {
              wallet: { type: 'string', maxLength: 64, description: 'Ethereum wallet address, 0x and 40 hex characters' },
            },
            required: ['wallet'],
            additionalProperties: false,
          },
          output: { example: exampleOutput(config), schema: OUTPUT_SCHEMA as Record<string, unknown> },
        }),
      },
    },
  };
}

/**
 * The paid screening API.
 *
 * POST /api/x402/screen takes {"wallet": "0x..."} and costs exactly $0.05 in USDC on the configured network, paid
 * through x402's upfront flow: the facilitator settles the payment before the screening runs, so no result leaves on an
 * unsettled authorization (C25). In order, before any payment is asked for: a client past its own limits gets 429
 * {busy: true}, a body over 1 KB gets 413, a body that is not exactly {wallet} or names a bad address gets 400, and a
 * full house gets 503 {busy: true} (C24, C42). Then the payment middleware answers 402 with the terms, or settles.
 * Before settling, an authorization that has expired, or that stays valid longer than the route's 300 seconds plus a
 * clock allowance, is refused with 402; the rest are claimed, so a copy is refused without reaching the facilitator. After settling, the receipt is checked and kept for the reply. A settlement left pending is served
 * only when its on-chain receipt proves this payment; any other unclear outcome answers 503 {retry: true} and keeps the
 * claim for a retry of the same header. The reply is the fixed PaidScreenResponse and nothing else (C34).
 *
 * The claims and limits live in deps.stores, this process's memory unless given. When a store call fails (the database
 * is down or slow), the rule has two sides:
 * - Before a settlement is confirmed, the failure refuses: 503 {busy: true} before a claim is attempted, 503 {retry:
 *   true} once one was, and the facilitator is never asked to settle on a claim the store could not record.
 * - After a settlement is confirmed, the buyer gets the result whatever the store does (C25). A failure to mark the
 *   claim used or to count the screening is logged, and the claim simply stays held until its validBefore, so no copy
 *   is served twice.
 * A failure while giving places back after the reply is decided keeps that reply; a shared place frees itself when its
 * lease ends. No reply and no log line carries a store's message. Non-goal: when a settlement's outcome is unknown and
 * keeping the claim as unsure fails too, the claim stays held by a request that is gone, so the same header cannot
 * retry before it expires. That takes two failures at once.
 *
 * Every SWEEP_EVERY_REQUESTS-th request also starts deps.stores.sweep() without waiting for it.
 *
 * GET /api/x402/health is free and returns only the network, payTo, price and scope.
 *
 * POST /api/check is the free check: the same request rules and the same screening, no payment, and a reply that says
 * whether it came from the cache. In order: the client address (400), the client's per-minute allowance in its own
 * bucket (429), the body and wallet (413, 400), the cache, the wallet's one screening place (202 {pending: true} while
 * another request screens it), the caller's hour and running ceilings (429), the service's running and day ceilings
 * (503), then the screening, the output check and the cache write. A cached answer runs nothing and counts toward no
 * ceiling but the minute. It never buys data and never takes payment (C24). A store failure before the screening
 * answers 503 {busy: true} and starts nothing; once a screening has run its result goes out even if it cannot be cached.
 * GET /api/check/health returns the scope, the rulebook version and the price, "free".
 */
export function createApp(config: ApiConfig, deps: ApiDeps): Hono<AppEnv> {
  const now = deps.now ?? (() => new Date());
  const stores = deps.stores ?? memoryStores(now);
  const { claims, guard, limits, checks, checkLimits } = stores;
  const paidRequests = new AsyncLocalStorage<PaidRequest>();
  const readReceipt = deps.readReceipt ?? receiptReader(config.settlementRpcUrl, config.chainId);

  // The settle-failure hook is handed the same kind of error whether the facilitator answered "failed" or the call
  // threw, so the throw is noted here, per call, where the two can still be told apart.
  const facilitator: FacilitatorClient = {
    getSupported: () => config.facilitator.getSupported(),
    verify: (payload, requirements) => config.facilitator.verify(payload, requirements),
    settle: async (payload, requirements) => {
      const request = paidRequests.getStore();
      if (request !== undefined) request.settleThrew = false;
      try {
        return await config.facilitator.settle(payload, requirements);
      } catch (error) {
        if (request !== undefined) request.settleThrew = true;
        throw error;
      }
    },
  };

  const resourceServer = new x402ResourceServer(facilitator).register(config.networkId, new ExactEvmScheme());
  resourceServer.registerExtension(bazaarResourceServerExtension);

  resourceServer.onBeforeSettle(async ({ paymentPayload, requirements, phase }) => {
    const request = paidRequests.getStore();
    if (phase !== 'before-handler' || request === undefined) return refuse('payment_not_expected');
    const terms = readPaymentTerms(paymentPayload.payload, requirements, config);
    if (!terms.ok) return refuse(terms.reason);
    const nowSeconds = BigInt(Math.floor(now().getTime() / 1000));
    let claimed: ClaimResult;
    try {
      claimed = await claims.claim(terms.key, terms.validBefore, request.owner, nowSeconds);
    } catch (error) {
      // The claim may have been written before the failure, so it is released when the request ends, and nothing is
      // settled on it. Caught here because the library would log the message and answer with its own reason.
      storeFailed('claiming a payment', error);
      request.claim = { key: terms.key, payer: terms.payer, nonce: terms.nonce };
      request.answer = 'retry';
      return refuse('payment_not_recorded');
    }
    if (claimed === 'expired') return refuse('payment_expired');
    if (claimed === 'too-long') {
      return refuse('payment_valid_too_long', `Sign a fresh payment for these terms, valid for at most ${MAX_TIMEOUT_SECONDS} seconds.`);
    }
    if (claimed === 'in-use') return refuse('payment_already_used');
    if (claimed === 'full') {
      request.answer = 'busy';
      return refuse('payment_claims_full');
    }
    request.claim = { key: terms.key, payer: terms.payer, nonce: terms.nonce };
  });

  /** True only when the receipt of hash shows this authorization paying exactly the price to payTo. Never throws. */
  async function paidOnChain(hash: `0x${string}`, claim: NonNullable<PaidRequest['claim']>): Promise<boolean> {
    try {
      const receipt = await readReceipt(hash);
      return receiptPays(receipt, { usdc: config.usdc, payer: claim.payer, payTo: config.payTo, nonce: claim.nonce, amount: BigInt(PRICE_UNITS) });
    } catch {
      return false;
    }
  }

  /** Marks the claim used. Never throws: once money has moved the buyer is served, and a failed write leaves it held. */
  async function markSettled(request: PaidRequest, key: string): Promise<void> {
    request.kept = true;
    try {
      await claims.markUsed(key, request.owner);
    } catch (error) {
      storeFailed('marking a payment used', error);
    }
  }

  // Settlement with no clear answer (C25). A pending settle with a transaction hash is served only if that receipt proves
  // this exact payment. Anything else unclear (a throw, a timeout, pending with no hash or no proof) keeps the claim and
  // answers 503 retry: the buyer resends the same header, which can never pay twice, and nothing is served on a guess.
  // A plain "failed" answer falls through, so the claim is released and the buyer gets 402 as before.
  resourceServer.onSettleFailure(async ({ error, phase }) => {
    const request = paidRequests.getStore();
    if (phase !== 'before-handler' || request?.claim == null) return;
    const claim = request.claim;
    // The answer is set before the write, so a failed write still answers retry and still never releases the claim.
    const keepForRetry = async () => {
      request.answer = 'retry';
      request.kept = true;
      try {
        await claims.keepUnsure(claim.key, request.owner);
      } catch (storeError) {
        storeFailed('keeping an unsure payment', storeError);
      }
    };
    try {
      const pending = error instanceof SettleError && error.errorReason === 'settlement_pending';
      if (!pending) {
        if (request.settleThrew) await keepForRetry();
        return;
      }
      const hash = TxHashText.safeParse(error.transaction);
      if (!hash.success || !(await paidOnChain(hash.data, claim))) {
        await keepForRetry();
        return;
      }
      const payment = Payment.parse({ network: config.networkId, payer: claim.payer, transaction: hash.data });
      await markSettled(request, claim.key);
      request.payment = payment;
      return {
        recovered: true as const,
        result: { success: true, transaction: hash.data, network: config.networkId, payer: claim.payer },
      };
    } catch {
      // The library logs and skips a hook that throws, which would release the claim. Unknown stays unknown instead.
      await keepForRetry();
    }
  });

  // Throwing AfterSettleAbortError turns the settle into a failure, so no screening runs. The claim stays used either
  // way, because money may have moved. Any other throw would be read as success, so the store write cannot throw here.
  resourceServer.onAfterSettle(async ({ result, phase }) => {
    const request = paidRequests.getStore();
    if (phase !== 'before-handler' || request?.claim == null) throw new AfterSettleAbortError('settlement_not_claimed');
    await markSettled(request, request.claim.key);
    const receipt = SettleReceipt.safeParse({
      network: result.network,
      payer: result.payer ?? request.claim.payer,
      transaction: result.transaction,
    });
    if (!receipt.success || receipt.data.network !== config.networkId || receipt.data.payer !== request.claim.payer) {
      throw new AfterSettleAbortError('settlement_receipt_invalid');
    }
    request.payment = Payment.parse({ ...receipt.data, network: config.networkId });
  });

  // First on the route, so every request counts, even one that fails later on its body.
  const limitClient = createMiddleware<AppEnv>(async (c, next) => {
    const client = clientOf(c, config.trustedClientHeader);
    if (client === null) {
      console.warn('api refused: the client address could not be read');
      return c.json({ error: 'the client address could not be read' }, 400);
    }
    let pass: Pass | { refused: Limit };
    try {
      pass = await limits.enter(client, isPaying(c));
    } catch (error) {
      storeFailed('checking the client limits', error);
      return c.json({ busy: true }, 503);
    }
    if ('refused' in pass) {
      // The limit is logged, the address is not: it is personal data and the log adds nothing to the refusal.
      console.warn(`api busy: a client is past the ${pass.refused} limit`);
      return c.json({ busy: true }, 429);
    }
    c.set('pass', pass);
    const admitted = pass;
    try {
      await next();
    } finally {
      await giveBack('ending a client request', () => limits.leave(admitted));
    }
  });

  const readRequest = createMiddleware<AppEnv>(async (c, next) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'the body must be JSON like {"wallet": "0x..."}' }, 400);
    }
    const parsed = ScreenRequest.safeParse(body);
    if (!parsed.success) return c.json({ error: 'the body must be exactly {"wallet": "0x..."}' }, 400);
    try {
      c.set('wallet', parseAddress(parsed.data.wallet));
    } catch (error) {
      return c.json({ error: error instanceof AddressError ? `wallet rejected: ${error.message}` : 'wallet rejected' }, 400);
    }
    await next();
  });

  const holdPlace = createMiddleware<AppEnv>(async (c, next) => {
    let ticket: Ticket | null = null;
    let full: boolean;
    try {
      if (isPaying(c)) {
        ticket = await guard.enter();
        full = ticket === null;
      } else {
        full = await guard.busy();
      }
    } catch (error) {
      // A store that cannot answer counts as full, so nothing is asked for or run on a guess.
      storeFailed('checking the ceilings', error);
      full = true;
    }
    if (full) return c.json({ busy: true }, 503);
    // An unpaid request only gets the 402 terms back, which runs nothing, so it needs no place.
    if (ticket === null) return next();
    const request: PaidRequest = { ticket, owner: randomUUID(), claim: null, kept: false, payment: null, settleThrew: false, answer: null };
    try {
      await paidRequests.run(request, next);
    } finally {
      await giveBack('giving back a place', () => guard.leave(request.ticket));
      const claim = request.claim;
      if (claim !== null && !request.kept) await giveBack('releasing a payment', () => claims.release(claim.key, request.owner));
      // Any paid attempt that took a place and bought nothing counts, an unknown outcome included, so failing is never
      // free. A full claim map is this server's limit, not the client's, so it does not count.
      c.get('pass').paymentFailed = request.payment === null && request.answer !== 'busy';
    }
    if (request.payment === null && request.answer !== null) {
      // Built fresh, so no PAYMENT-REQUIRED or PAYMENT-RESPONSE header from the middleware's own answer is carried over.
      c.res = undefined;
      c.res = new Response(JSON.stringify(request.answer === 'retry' ? { retry: true } : { busy: true }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
  });

  // Every free check counts toward the minute, a cached one too, before its body is read.
  const checkClient = createMiddleware<AppEnv>(async (c, next) => {
    const client = clientOf(c, config.trustedClientHeader);
    if (client === null) {
      console.warn('api refused: the client address could not be read');
      return c.json({ error: 'the client address could not be read' }, 400);
    }
    let counted: boolean;
    try {
      counted = await checkLimits.countRequest(client);
    } catch (error) {
      storeFailed('counting a free check', error);
      return c.json({ busy: true }, 503);
    }
    if (!counted) {
      console.warn('api check busy: a client is past the minute limit');
      return c.json({ busy: true }, 429);
    }
    c.set('client', client);
    await next();
  });

  /** The cached reply for wallet, checked like an input, or null. A damaged entry is logged and treated as none. */
  async function cachedCheck(wallet: Address, key: CheckKey): Promise<FreeCheckResponse | null> {
    const stored = await checks.read(key, now());
    if (stored === null) return null;
    const body = cachedBody(wallet, stored);
    if (body === null) console.warn('api check cache held a body that failed the output check');
    return body;
  }

  /** Screens wallet once it holds every place, writes the result to the cache, and answers with it. */
  async function screenAndKeep(c: Context<AppEnv>, wallet: Address, key: CheckKey): Promise<Response> {
    let screen: SingleScreen;
    try {
      screen = await deps.screen(wallet);
    } catch {
      screen = heldScreen(wallet, SCREEN_CAUSES.failed);
    }
    const { body, accepted } = freeBody(wallet, screen);
    // The model credit is already spent, so the result goes out even when it cannot be kept; the ceilings still bound
    // what a failing cache can cost.
    try {
      await checks.write(key, body, now(), accepted ? CHECK_KEEP_SECONDS : CHECK_KEEP_HELD_SECONDS);
    } catch (error) {
      storeFailed('caching a free check', error);
    }
    return c.json(body);
  }

  const runCheck = async (c: Context<AppEnv>) => {
    const wallet = c.get('wallet');
    const key: CheckKey = { address: wallet, chain: CHECK_CHAIN, rulebook: CURRENT_RULEBOOK };
    const busy = () => c.json({ busy: true }, 503);
    let walletPlace: CheckPlace | null;
    try {
      const cached = await cachedCheck(wallet, key);
      if (cached !== null) return c.json(cached);
      walletPlace = await checkLimits.holdWallet(wallet);
    } catch (error) {
      storeFailed('starting a free check', error);
      return busy();
    }
    if (walletPlace === null) return c.json({ pending: true }, 202);
    const heldWallet = walletPlace;
    try {
      let admitted: CheckPlace | { refused: CheckRefusal };
      try {
        // A screening of this wallet may have finished between the first read and taking its place.
        const cached = await cachedCheck(wallet, key);
        if (cached !== null) return c.json(cached);
        admitted = await checkLimits.admit(c.get('client'));
      } catch (error) {
        storeFailed('admitting a free check', error);
        return busy();
      }
      if ('refused' in admitted) {
        // The limit is logged, the address is not.
        console.warn(`api check busy: past the ${admitted.refused} limit`);
        return admitted.refused === 'hour' || admitted.refused === 'running' ? c.json({ busy: true }, 429) : busy();
      }
      const screening = admitted;
      try {
        return await screenAndKeep(c, wallet, key);
      } finally {
        await giveBack('giving back a check place', () => checkLimits.release(screening));
      }
    } finally {
      await giveBack('giving back a wallet', () => checkLimits.release(heldWallet));
    }
  };

  const app = new Hono<AppEnv>();

  // Counted per app, not drawn at random, so a test can tell exactly which request sweeps.
  let requestsSeen = 0;
  app.use(async (_c, next) => {
    requestsSeen += 1;
    const sweepAfter = requestsSeen % SWEEP_EVERY_REQUESTS === 0;
    await next();
    if (!sweepAfter) return;
    let sweeping: Promise<void>;
    try {
      sweeping = stores.sweep();
    } catch (error) {
      sweeping = Promise.reject(error);
    }
    sweeping.catch((error: unknown) => console.warn(`api sweep failed: ${failureCode(error)}`));
  });

  // Library and network errors can quote URLs, so only the class name is logged and nothing is returned (C40).
  app.onError((error, c) => {
    console.error(`api error: ${error.name}`);
    return c.json({ error: 'internal error' }, 500);
  });

  app.get(HEALTH_PATH, (c) => c.json({ network: config.networkId, payTo: config.payTo, price: PRICE, scope: SINGLE_SCOPE }));

  app.post(
    SCREEN_PATH,
    limitClient,
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'the body is too large' }, 413) }),
    readRequest,
    holdPlace,
    paymentMiddleware(screenRoutes(config), resourceServer),
    async (c) => {
      const request = paidRequests.getStore();
      // The upfront flow only reaches here after a settle this app recorded. Anything else is a broken invariant.
      if (request?.payment == null) return c.json({ error: 'the payment could not be confirmed' }, 500);
      // The payment has settled, so a failure to count the screening must not cost the buyer the result (C25).
      try {
        await guard.start(request.ticket);
      } catch (error) {
        storeFailed('counting a screening', error);
      }
      const wallet = c.get('wallet');
      let screen: SingleScreen;
      try {
        screen = await deps.screen(wallet);
      } catch {
        screen = heldScreen(wallet, SCREEN_CAUSES.failed);
      }
      return c.json(paidBody(wallet, screen, request.payment));
    },
  );

  app.get(CHECK_HEALTH_PATH, (c) => c.json({ scope: SINGLE_SCOPE, rulebook: CURRENT_RULEBOOK, price: 'free' }));

  app.post(
    CHECK_PATH,
    checkClient,
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'the body is too large' }, 413) }),
    readRequest,
    runCheck,
  );

  return app;
}

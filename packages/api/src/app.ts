import { AsyncLocalStorage } from 'node:async_hooks';
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
import { AddressError, parseAddress, type Address } from '@thuli/core';
import { heldScreen, NOT_CHECKED, SCREEN_CAUSES, SINGLE_SCOPE, type SingleScreen } from '@thuli/worker/src/screen/single.ts';
import { PaymentClaims, readPaymentTerms } from './claims.ts';
import { PRICE, PRICE_UNITS, type ApiConfig } from './config.ts';
import { ScreenGuard, type Ticket } from './guard.ts';
import { canonicalClient, ClientLimits, type Pass } from './limits.ts';
import { receiptPays, receiptReader, type ReadReceipt } from './receipt.ts';
import { paidBody, PaidScreenResponse, Payment, ScreenRequest } from './schema.ts';

export const SCREEN_PATH = '/api/x402/screen';
export const HEALTH_PATH = '/api/x402/health';

// A real request is about 60 bytes: {"wallet":"0x" plus 40 hex}. Anything near this is not a screening request (C41).
const MAX_BODY_BYTES = 1024;
// The library's own default, written out because the longest validity the claim map accepts is built from it.
const MAX_TIMEOUT_SECONDS = 300;
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
}

interface AppEnv {
  Variables: { wallet: Address; pass: Pass };
}

/** What one paid request carries through the payment middleware to the handler, in its own async context. */
interface PaidRequest {
  ticket: Ticket;
  claim: { key: string; payer: Address; nonce: `0x${string}` } | null;
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
 * GET /api/x402/health is free and returns only the network, payTo, price and scope.
 */
export function createApp(config: ApiConfig, deps: ApiDeps): Hono<AppEnv> {
  const now = deps.now ?? (() => new Date());
  const guard = new ScreenGuard(now);
  const limits = new ClientLimits(now);
  const claims = new PaymentClaims(BigInt(MAX_TIMEOUT_SECONDS));
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
    const claimed = claims.claim(terms.key, terms.validBefore, request, nowSeconds);
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

  // Settlement with no clear answer (C25). A pending settle with a transaction hash is served only if that receipt proves
  // this exact payment. Anything else unclear (a throw, a timeout, pending with no hash or no proof) keeps the claim and
  // answers 503 retry: the buyer resends the same header, which can never pay twice, and nothing is served on a guess.
  // A plain "failed" answer falls through, so the claim is released and the buyer gets 402 as before.
  resourceServer.onSettleFailure(async ({ error, phase }) => {
    const request = paidRequests.getStore();
    if (phase !== 'before-handler' || request?.claim == null) return;
    const claim = request.claim;
    const keepForRetry = () => {
      claims.keepUnsure(claim.key, request);
      request.answer = 'retry';
    };
    try {
      const pending = error instanceof SettleError && error.errorReason === 'settlement_pending';
      if (!pending) {
        if (request.settleThrew) keepForRetry();
        return;
      }
      const hash = TxHashText.safeParse(error.transaction);
      if (!hash.success || !(await paidOnChain(hash.data, claim))) {
        keepForRetry();
        return;
      }
      const payment = Payment.parse({ network: config.networkId, payer: claim.payer, transaction: hash.data });
      claims.markUsed(claim.key, request);
      request.payment = payment;
      return {
        recovered: true as const,
        result: { success: true, transaction: hash.data, network: config.networkId, payer: claim.payer },
      };
    } catch {
      // The library logs and skips a hook that throws, which would release the claim. Unknown stays unknown instead.
      keepForRetry();
    }
  });

  // Throwing AfterSettleAbortError turns the settle into a failure, so no screening runs. The claim stays used either
  // way, because money may have moved.
  resourceServer.onAfterSettle(async ({ result, phase }) => {
    const request = paidRequests.getStore();
    if (phase !== 'before-handler' || request?.claim == null) throw new AfterSettleAbortError('settlement_not_claimed');
    claims.markUsed(request.claim.key, request);
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
    const pass = limits.enter(client, isPaying(c));
    if ('refused' in pass) {
      // The limit is logged, the address is not: it is personal data and the log adds nothing to the refusal.
      console.warn(`api busy: a client is past the ${pass.refused} limit`);
      return c.json({ busy: true }, 429);
    }
    c.set('pass', pass);
    try {
      await next();
    } finally {
      limits.leave(pass);
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
    if (guard.busy()) return c.json({ busy: true }, 503);
    // An unpaid request only gets the 402 terms back, which runs nothing, so it needs no place.
    if (!isPaying(c)) return next();
    const request: PaidRequest = { ticket: guard.enter(), claim: null, payment: null, settleThrew: false, answer: null };
    try {
      await paidRequests.run(request, next);
    } finally {
      guard.leave(request.ticket);
      if (request.claim !== null) claims.release(request.claim.key, request);
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

  const app = new Hono<AppEnv>();

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
      guard.start(request.ticket);
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

  return app;
}

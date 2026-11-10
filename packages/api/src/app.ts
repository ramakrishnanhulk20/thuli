import { AsyncLocalStorage } from 'node:async_hooks';
import { AfterSettleAbortError, type RoutesConfig } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { bazaarResourceServerExtension, declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { AddressError, parseAddress, type Address } from '@thuli/core';
import { heldScreen, NOT_CHECKED, SCREEN_CAUSES, SINGLE_SCOPE, type SingleScreen } from '@thuli/worker/src/screen/single.ts';
import { PaymentClaims, readPaymentTerms } from './claims.ts';
import { PRICE, type ApiConfig } from './config.ts';
import { ScreenGuard, type Ticket } from './guard.ts';
import { paidBody, PaidScreenResponse, Payment, ScreenRequest } from './schema.ts';

export const SCREEN_PATH = '/api/x402/screen';
export const HEALTH_PATH = '/api/x402/health';

// A real request is about 60 bytes: {"wallet":"0x" plus 40 hex}. Anything near this is not a screening request (C41).
const MAX_BODY_BYTES = 1024;
// Kept under the 500 characters past which verify fails (x402 issue 2284), and written as a description, not an instruction.
const DESCRIPTION =
  "Screens one Ethereum wallet with Thuli's airdrop rulebook v2 and returns a decision (full, partial, hold or exclude) " +
  'with the rule, a plain reason and the transactions behind it. One wallet on its own, no claim list.';
const EXAMPLE_WALLET = '0x041f77015fe51c51aE49a7f2F3Ff86C641fa190a';

export interface ApiDeps {
  /** Screens one canonical address and resolves with a decision. screenOneWallet never rejects for a parsed address. */
  screen(wallet: Address): Promise<SingleScreen>;
  now?: () => Date;
}

interface AppEnv {
  Variables: { wallet: Address };
}

/** What one paid request carries through the payment middleware to the handler, in its own async context. */
interface PaidRequest {
  ticket: Ticket;
  claim: { key: string; payer: Address } | null;
  payment: Payment | null;
}

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
  transaction: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .transform((hash) => hash.toLowerCase()),
});

const refuse = (reason: string) => ({ abort: true as const, reason });

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
 * unsettled authorization (C25). In order, before any payment is asked for: a body over 1 KB gets 413, a body that is not
 * exactly {wallet} or names a bad address gets 400, and a full house gets 503 {busy: true} (C24, C42). Then the payment
 * middleware answers 402 with the terms, or settles. Before settling, the authorization is claimed so a copy of it is
 * refused without reaching the facilitator. After settling, the receipt is checked and kept for the reply. The reply is
 * the fixed PaidScreenResponse and nothing else (C34).
 *
 * GET /api/x402/health is free and returns only the network, payTo, price and scope.
 */
export function createApp(config: ApiConfig, deps: ApiDeps): Hono<AppEnv> {
  const now = deps.now ?? (() => new Date());
  const guard = new ScreenGuard(now);
  const claims = new PaymentClaims();
  const paidRequests = new AsyncLocalStorage<PaidRequest>();

  const resourceServer = new x402ResourceServer(config.facilitator).register(config.networkId, new ExactEvmScheme());
  resourceServer.registerExtension(bazaarResourceServerExtension);

  resourceServer.onBeforeSettle(async ({ paymentPayload, requirements, phase }) => {
    const request = paidRequests.getStore();
    if (phase !== 'before-handler' || request === undefined) return refuse('payment_not_expected');
    const terms = readPaymentTerms(paymentPayload.payload, requirements, config);
    if (!terms.ok) return refuse(terms.reason);
    const nowSeconds = BigInt(Math.floor(now().getTime() / 1000));
    if (!claims.claim(terms.key, terms.validBefore, request, nowSeconds)) return refuse('payment_already_used');
    request.claim = { key: terms.key, payer: terms.payer };
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
    const paying = c.req.header('payment-signature') !== undefined || c.req.header('x-payment') !== undefined;
    // An unpaid request only gets the 402 terms back, which runs nothing, so it needs no place.
    if (!paying) return next();
    const request: PaidRequest = { ticket: guard.enter(), claim: null, payment: null };
    try {
      await paidRequests.run(request, next);
    } finally {
      guard.leave(request.ticket);
      if (request.claim !== null) claims.release(request.claim.key, request);
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

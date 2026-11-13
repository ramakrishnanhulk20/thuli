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
import { REDEEM_SCREEN_TRIES, type CheckKey } from '@thuli/store';
import {
  heldScreen,
  NOT_CHECKED,
  SCREEN_CAUSES,
  SCREEN_TIME_LIMIT_MS,
  SINGLE_SCOPE,
  type SingleScreen,
} from '@thuli/worker/src/screen/single.ts';
import { registerCampaignRoutes, type CampaignDeps } from './campaigns.ts';
import { MAX_TIMEOUT_SECONDS, readPaymentTerms, type ClaimResult, type Redeemed } from './claims.ts';
import { PRICE, PRICE_UNITS, REQUEST_DEADLINE_MS, SETTLE_TIMEOUT_MS, type ApiConfig } from './config.ts';
import type { Ticket } from './guard.ts';
import { canonicalClient, type Limit, type Pass } from './limits.ts';
import { RECEIPT_READ_WORST_MS, receiptPays, receiptReader, type ReadReceipt } from './receipt.ts';
import {
  cachedBody,
  freeBody,
  paidBody,
  PaidScreenResponse,
  Payment,
  ScreenRequest,
  SETTLED_RETRY,
  storedPaidBody,
  type FreeCheckResponse,
} from './schema.ts';
import { failureCode, memoryStores, type CheckPlace, type CheckRefusal, type Stores } from './stores.ts';

export const SCREEN_PATH = '/api/x402/screen';
export const HEALTH_PATH = '/api/x402/health';
export const CHECK_PATH = '/api/check';
export const CHECK_HEALTH_PATH = '/api/check/health';
/** Set to true on a paid answer served from the result its payment already bought, with no screening and no settlement. */
export const STORED_HEADER = 'thuli-stored-result';

/** Kept back from the screening's share of a paid request's time, to store its result and give the places back. */
export const REPLY_MARGIN_MS = 10_000;
/** With less than this left after settling, no screening starts and the buyer is asked to send the same header again. */
export const SCREEN_LEAST_MS = 20_000;
/** The wait a settled-retry answer asks for before the same header comes back. */
export const SETTLED_RETRY_AFTER_SECONDS = 10;
/**
 * Time a paid request needs left before it asks the facilitator to settle: two settle calls (the library asks once
 * more when the first is pending), the slowest receipt read (RECEIPT_READ_WORST_MS: its chain-id call and its retry
 * included), and the least a screening may start with. With less, nothing is settled.
 *
 * Every await of a paid request, from its first line to its answer, ends by REQUEST_DEADLINE_MS (C41):
 * - cut by byDeadline: the body read, every store call (the client limits, the ceilings, the redeem, the claim,
 *   marking a payment settled or unsure, counting the screening, storing the result, giving places back) and the
 *   receipt read, which an RPC's own Retry-After could otherwise stretch;
 * - cut by its share timer: the screening, stopped through its signal;
 * - bounded by timedFacilitator and started only with SETTLE_ROOM_MS left: the two settle calls;
 * - bounded by timedFacilitator alone: the facilitator's supported-kinds call, made once by each server copy before
 *   its first payment and before this check.
 * A store call cut by the deadline may still finish; each is covered by a lease, an owner check or a retry. A cut
 * screening's places are given back when it stops, after the answer, not by this deadline.
 */
export const SETTLE_ROOM_MS = 2 * SETTLE_TIMEOUT_MS + RECEIPT_READ_WORST_MS + SCREEN_LEAST_MS;

/** A wait cut off at its request's deadline. Logged by its name only, like a store failure. */
class DeadlineReached extends Error {
  override name = 'DeadlineReached';
}

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
  /**
   * Screens one canonical address and resolves with a decision. screenOneWallet never rejects for a parsed address. The
   * paid route passes a signal it aborts when the screening's share of the request runs out; the screening must then
   * stop its SERV calls and resolve. The free check passes none.
   */
  screen(wallet: Address, signal?: AbortSignal): Promise<SingleScreen>;
  now?: () => Date;
  /** Reads a receipt on the payment's chain. Defaults to config.settlementRpcUrl. */
  readReceipt?: ReadReceipt;
  /** Where used payments and the limits live. Defaults to this process's memory, which is right only for one server. */
  stores?: Stores;
  /** The campaign routes' database and chain readers. Left out, no /api/campaigns route exists. */
  campaigns?: CampaignDeps;
  /**
   * True leaves the catalogue listing off the paid route's terms. For a server only this machine can reach, such as a
   * proof run in its own process: a settled payment asks the facilitator to list the route, and a public catalogue must
   * not be handed an address nobody else can open.
   */
  unlisted?: boolean;
}

interface AppEnv {
  /**
   * pass and deadlineAt are set on the paid route, client on the free check. screeningEnding is set when a paid
   * request answered before its cut screening had stopped, so the caller's place waits for that too.
   */
  Variables: { wallet: Address; pass: Pass; client: string; deadlineAt: number; screeningEnding: Promise<void> | undefined };
}

/** What one paid request carries through the payment middleware to the handler, in its own async context. */
interface PaidRequest {
  ticket: Ticket;
  /** A fresh random id, this request's name as the owner of its claim. */
  owner: string;
  /** The wallet the request body names, the one a payment is for. */
  wallet: Address;
  /** The moment, in ms on the app's clock, by which this request has answered and stopped waiting on anything. */
  deadlineAt: number;
  /** The claim this request took, or may have taken when the store failed while it was being written. */
  claim: { key: string; payer: Address; nonce: `0x${string}` } | null;
  /** True once the claim was settled, kept unsure or redeemed. From then on it is never released, even if that write failed. */
  kept: boolean;
  /** True once this request may own a settled claim, so it gives the claim back if it ends with no result stored. */
  owns: boolean;
  /** True once the result this request screened is stored on its claim. */
  served: boolean;
  /** True when the claim settled on an earlier request and this one carries its header again. */
  redeemed: boolean;
  /** Which screening of the payment this request's taking of the claim counted, from 1; 0 when it counted none (C26). */
  screening: number;
  /** True once this request started that screening, so the try is used even if the screening is cut. */
  started: boolean;
  /** Settles when the started screening itself has, which may be after the reply when it was cut. */
  ending: Promise<void> | null;
  /** True once ending has settled. */
  over: boolean;
  /** True when every try was used with no result stored, so this request stores the time-up hold and screens nothing. */
  spent: boolean;
  /** A served claim's stored result, answered as it is, with no screening and no settlement. */
  stored: unknown;
  payment: Payment | null;
  /** True when the latest settle call threw rather than answering, so its outcome is unknown. */
  settleThrew: boolean;
  /**
   * Set when the reply must replace the payment middleware's: retry for an unknown outcome, busy for a full claim map,
   * settled for a payment that went through and that another request is screening now.
   */
  answer: 'retry' | 'busy' | 'settled' | null;
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

function screenRoutes(config: ApiConfig, listed: boolean): RoutesConfig {
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
      ...(listed && {
        extensions: declareDiscoveryExtension({
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
      }),
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
 * Exactly once paid, as many times fetched (C25). A settled claim keeps the wallet and transaction it paid for, and
 * the reply is stored on it before it is sent. For a day from the settlement, the same header with the same wallet
 * redeems the payment with no settle: a stored result comes back exactly as stored, marked by the thuli-stored-result
 * header, and a payment with no result yet is screened then. Only one request screens a payment at a time; the others
 * get the settled-retry answer, which hands out no payment terms and never counts as a failed payment. Another wallet
 * with that header is refused. A redeem passes the same client and service
 * limits as any paid request and never counts as a failed payment (C24, C42). Non-goal: a redeem does not check the
 * signature again, so anyone who rebuilds the header from the settled transaction on chain can fetch the same wallet's
 * result; it buys no screening the payment did not, and the free check gives that wallet's screening to anyone anyway.
 *
 * Every paid request answers by REQUEST_DEADLINE_MS from its first line (C41). It is not settled unless SETTLE_ROOM_MS
 * is left, and after settling the screening gets the time left less REPLY_MARGIN_MS, at most its own 120 s. With under
 * SCREEN_LEAST_MS left, or when a screening before the payment's last try (REDEEM_SCREEN_TRIES, two) runs out of time,
 * the answer is 503 with the settled-retry body and a Retry-After and the claim stays settled; when the last try runs
 * out of time, or every try is already used, the hold for a screening that ran out of time is stored and sent as the
 * result.
 *
 * The claims and limits live in deps.stores, this process's memory unless given. When a store call fails (the database
 * is down or slow), the rule has two sides:
 * - Before a settlement is confirmed, the failure refuses: 503 {busy: true} before a claim is attempted, 503 {retry:
 *   true} once one was, and the facilitator is never asked to settle on a claim the store could not record.
 * - After a settlement is confirmed, the buyer gets the result whatever the store does (C25). A failure to mark the
 *   claim settled, to count the screening or to store the result is logged. A claim not marked settled stays held until
 *   the sweep, so no copy is ever served, and that payment cannot be redeemed; a result not stored is screened again on
 *   the next redeem.
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
 *
 * When deps.campaigns is given, the campaign routes under /api/campaigns are added too (see registerCampaignRoutes),
 * reading the caller's address by the same rule as the routes above.
 *
 * Every answer from every route, whatever its status, carries cache-control: no-store.
 */
export function createApp(config: ApiConfig, deps: ApiDeps): Hono<AppEnv> {
  const now = deps.now ?? (() => new Date());
  const stores = deps.stores ?? memoryStores(now);
  const { claims, guard, limits, checks, checkLimits } = stores;
  const paidRequests = new AsyncLocalStorage<PaidRequest>();
  const readReceipt = deps.readReceipt ?? receiptReader(config.settlementRpcUrl, config.chainId);

  /**
   * work, or a DeadlineReached rejection once deadlineAt has passed, so a paid request never waits past its deadline
   * (C41). A store call cut off this way may still finish; every such call is one a lease or a retry already covers.
   */
  function byDeadline<T>(deadlineAt: number, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new DeadlineReached('the request reached its deadline')), Math.max(0, deadlineAt - now().getTime()));
      Promise.resolve()
        .then(work)
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });
  }

  /**
   * Starts request's screening of wallet and answers it, or null when it has not finished within ms. Then it is stopped
   * through its signal, as its own time limit would stop it, so no more SERV calls start (C26). One that throws
   * becomes the code-written hold. request.ending settles when the screening itself has, so the places it holds are
   * given back only then (C24, C42). The screening is started before the timer, so one that finishes at the very moment
   * the share runs out still counts.
   */
  async function screenWithin(request: PaidRequest, wallet: Address, ms: number): Promise<SingleScreen | null> {
    request.started = true;
    const stop = new AbortController();
    let screening: Promise<SingleScreen>;
    try {
      screening = deps.screen(wallet, stop.signal);
    } catch (error) {
      screening = Promise.reject(error);
    }
    const finished = screening.catch(() => heldScreen(wallet, SCREEN_CAUSES.failed));
    request.ending = finished.then(() => {
      request.over = true;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    });
    try {
      const first = await Promise.race([finished, late]);
      if (first === null) stop.abort();
      return first;
    } finally {
      clearTimeout(timer);
    }
  }

  // Fixed words and a fixed shape: the payment settled, and the same header gets the screening it bought (C25).
  const settledRetry = (c: Context<AppEnv>) => {
    c.header('retry-after', String(SETTLED_RETRY_AFTER_SECONDS));
    return c.json(SETTLED_RETRY, 503);
  };

  // The settle-failure hook is handed the same kind of error whether the facilitator answered "failed" or the call
  // threw, so the throw is noted here, per call, where the two can still be told apart.
  //
  // One throw is not an unknown outcome. A facilitator that refuses a payment before sending it may say so with a 4xx
  // status and a settle body, where another says it with a 200: Coinbase's answers an unfunded wallet with 400
  // insufficient_funds. The client turns that into a thrown SettleError. It is the facilitator's own "failed", so the
  // buyer gets 402 with the reason and the claim is released, instead of a retry that can never succeed and a claim
  // held for nothing. A 5xx, an answer that names a transaction, and every other throw stay unknown (C25).
  const refusedBeforeSending = (error: unknown) =>
    error instanceof SettleError &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    (error.transaction === undefined || error.transaction === '');
  const facilitator: FacilitatorClient = {
    getSupported: () => config.facilitator.getSupported(),
    verify: (payload, requirements) => config.facilitator.verify(payload, requirements),
    settle: async (payload, requirements) => {
      const request = paidRequests.getStore();
      if (request !== undefined) request.settleThrew = false;
      try {
        return await config.facilitator.settle(payload, requirements);
      } catch (error) {
        if (request !== undefined) request.settleThrew = !refusedBeforeSending(error);
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
    const taken = { key: terms.key, payer: terms.payer, nonce: terms.nonce };

    // A header whose payment already went through is never settled again: it gets its stored result, or the screening
    // it paid for, and only for the wallet it paid for (C24, C25).
    let found: Redeemed;
    try {
      found = await byDeadline(request.deadlineAt, () => claims.redeem(terms.key, request.wallet, request.owner, nowSeconds));
    } catch (error) {
      // The claim may have been taken before the failure, so it is given back when the request ends.
      storeFailed('looking up a settled payment', error);
      request.claim = taken;
      request.kept = true;
      request.owns = true;
      request.answer = 'retry';
      return refuse('payment_not_recorded');
    }
    if (found.found === 'refused') return refuse('payment_already_used');
    // The money moved and the buyer's screening is under way in another request: come back, never "used up" (C25).
    if (found.found === 'in-use') {
      request.answer = 'settled';
      return refuse('payment_being_screened');
    }
    if (found.found !== 'none') {
      const payment = Payment.safeParse({ network: config.networkId, payer: terms.payer, transaction: found.transaction });
      request.claim = taken;
      request.kept = true;
      request.redeemed = true;
      request.owns = found.found !== 'served';
      if (found.found === 'settled') request.screening = found.screening;
      request.spent = found.found === 'spent';
      if (!payment.success) {
        // Only a damaged row can get here, and nothing is served on it.
        request.answer = 'retry';
        return refuse('payment_not_recorded');
      }
      request.payment = payment.data;
      if (found.found === 'served') request.stored = found.body;
      return {
        skip: true as const,
        result: { success: true, transaction: payment.data.transaction, network: config.networkId, payer: terms.payer },
      };
    }

    // Too little time left to settle and still screen: nothing is claimed or settled, so nothing is spent (C41).
    if (request.deadlineAt - now().getTime() < SETTLE_ROOM_MS) {
      request.answer = 'busy';
      return refuse('payment_out_of_time');
    }

    let claimed: ClaimResult;
    try {
      claimed = await byDeadline(request.deadlineAt, () => claims.claim(terms.key, terms.validBefore, request.owner, nowSeconds));
    } catch (error) {
      // The claim may have been written before the failure, so it is released when the request ends, and nothing is
      // settled on it. Caught here because the library would log the message and answer with its own reason.
      storeFailed('claiming a payment', error);
      request.claim = taken;
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
    request.claim = taken;
  });

  /**
   * True only when the receipt of hash shows this authorization paying exactly the price to payTo. Never throws. A read
   * cut by the deadline is not a proof, so the payment is kept unsure and the same header comes back.
   */
  async function paidOnChain(request: PaidRequest, hash: `0x${string}`, claim: NonNullable<PaidRequest['claim']>): Promise<boolean> {
    try {
      const receipt = await byDeadline(request.deadlineAt, () => readReceipt(hash));
      return receiptPays(receipt, { usdc: config.usdc, payer: claim.payer, payTo: config.payTo, nonce: claim.nonce, amount: BigInt(PRICE_UNITS) });
    } catch {
      return false;
    }
  }

  /**
   * Marks the claim settled for this request's wallet and payment, owned by this request while it screens. Never throws:
   * once money has moved the buyer is served, and a failed write leaves the claim held, so no copy is ever served.
   */
  async function markSettled(request: PaidRequest, key: string, payment: Payment): Promise<void> {
    request.kept = true;
    request.owns = true;
    // Marking it settled counts the payment's first screening, for this request.
    request.screening = 1;
    request.payment = payment;
    const nowSeconds = BigInt(Math.floor(now().getTime() / 1000));
    try {
      // Cut by the deadline, the write may still land; either way the answer that follows is the settled retry.
      await byDeadline(request.deadlineAt, () =>
        claims.markSettled(key, request.owner, { wallet: request.wallet, transaction: payment.transaction as `0x${string}` }, nowSeconds),
      );
    } catch (error) {
      storeFailed('marking a payment settled', error);
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
        await byDeadline(request.deadlineAt, () => claims.keepUnsure(claim.key, request.owner));
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
      if (!hash.success || !(await paidOnChain(request, hash.data, claim))) {
        await keepForRetry();
        return;
      }
      await markSettled(request, claim.key, Payment.parse({ network: config.networkId, payer: claim.payer, transaction: hash.data }));
      return {
        recovered: true as const,
        result: { success: true, transaction: hash.data, network: config.networkId, payer: claim.payer },
      };
    } catch {
      // The library logs and skips a hook that throws, which would release the claim. Unknown stays unknown instead.
      await keepForRetry();
    }
  });

  // Throwing AfterSettleAbortError turns the settle into a failure, so no screening runs. The claim is kept either way,
  // because money may have moved: settled with its receipt, or held for good when the receipt cannot be read, so no copy
  // is ever served on it. Any other throw would be read as success, so the store write cannot throw here.
  resourceServer.onAfterSettle(async ({ result, phase }) => {
    const request = paidRequests.getStore();
    if (phase !== 'before-handler' || request?.claim == null) throw new AfterSettleAbortError('settlement_not_claimed');
    // A redeem's result is the earlier settlement's own, and its claim is already settled.
    if (request.redeemed) return;
    request.kept = true;
    const receipt = SettleReceipt.safeParse({
      network: result.network,
      payer: result.payer ?? request.claim.payer,
      transaction: result.transaction,
    });
    if (!receipt.success || receipt.data.network !== config.networkId || receipt.data.payer !== request.claim.payer) {
      throw new AfterSettleAbortError('settlement_receipt_invalid');
    }
    await markSettled(request, request.claim.key, Payment.parse({ ...receipt.data, network: config.networkId }));
  });

  // First on the route, so every request counts, even one that fails later on its body, and its deadline runs from here.
  const limitClient = createMiddleware<AppEnv>(async (c, next) => {
    const deadlineAt = now().getTime() + REQUEST_DEADLINE_MS;
    c.set('deadlineAt', deadlineAt);
    const client = clientOf(c, config.trustedClientHeader);
    if (client === null) {
      console.warn('api refused: the client address could not be read');
      return c.json({ error: 'the client address could not be read' }, 400);
    }
    let pass: Pass | { refused: Limit };
    try {
      pass = await byDeadline(deadlineAt, () => limits.enter(client, isPaying(c)));
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
      const ending = c.get('screeningEnding');
      // The caller's own running place is held, like the service's, until a cut screening has really stopped (C42).
      if (ending !== undefined) void ending.then(() => giveBack('ending a client request', () => limits.leave(admitted)));
      else await giveBack('ending a client request', () => byDeadline(deadlineAt, () => limits.leave(admitted)));
    }
  });

  const readRequest = createMiddleware<AppEnv>(async (c, next) => {
    // Only the paid route has a deadline; a body still arriving when it passes is answered as unreadable.
    const deadlineAt: number | undefined = c.get('deadlineAt');
    let body: unknown;
    try {
      body = await (deadlineAt === undefined ? c.req.json() : byDeadline(deadlineAt, () => c.req.json()));
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
        ticket = await byDeadline(c.get('deadlineAt'), () => guard.enter());
        full = ticket === null;
      } else {
        full = await byDeadline(c.get('deadlineAt'), () => guard.busy());
      }
    } catch (error) {
      // A store that cannot answer counts as full, so nothing is asked for or run on a guess.
      storeFailed('checking the ceilings', error);
      full = true;
    }
    if (full) return c.json({ busy: true }, 503);
    // An unpaid request only gets the 402 terms back, which runs nothing, so it needs no place.
    if (ticket === null) return next();
    const deadlineAt = c.get('deadlineAt');
    const request: PaidRequest = {
      ticket,
      owner: randomUUID(),
      wallet: c.get('wallet'),
      deadlineAt,
      claim: null,
      kept: false,
      owns: false,
      served: false,
      redeemed: false,
      screening: 0,
      started: false,
      ending: null,
      over: false,
      spent: false,
      stored: null,
      payment: null,
      settleThrew: false,
      answer: null,
    };
    try {
      await paidRequests.run(request, next);
    } finally {
      const giveBackAll = async (run: (call: () => Promise<void>) => () => Promise<void>) => {
        await giveBack('giving back a place', run(() => guard.leave(request.ticket)));
        const claim = request.claim;
        if (claim !== null && !request.kept) await giveBack('releasing a payment', run(() => claims.release(claim.key, request.owner)));
        // A settled payment this request did not store a result for goes back as soon as its screening is over, so
        // its header can come again then rather than once the ownership runs out.
        if (claim !== null && request.owns && !request.served) {
          // A try this request counted and never started goes back with it, so waiting for time costs the buyer no try.
          const handBackTry = request.screening > 0 && !request.started;
          await giveBack('giving back a settled payment', run(() => claims.leave(claim.key, request.owner, handBackTry)));
        }
      };
      const ending = request.ending;
      if (ending !== null && !request.over) {
        // The screening was cut and has not stopped yet. Its places stay taken until it has, so the running ceilings
        // still count it and no redeem starts beside it (C24, C42). The reply does not wait: the screening's own end
        // gives them back, past the deadline if need be, each failure logged by giveBack in fixed words.
        c.set('screeningEnding', ending);
        void ending.then(() => giveBackAll((call) => call));
      } else {
        await giveBackAll((call) => () => byDeadline(deadlineAt, call));
      }
      // Any paid attempt that took a place and bought nothing counts, an unknown outcome included, so failing is never
      // free. A full claim map is this server's limit, not the client's, and a buyer waiting on its own settled payment
      // has paid, so neither counts.
      c.get('pass').paymentFailed = request.payment === null && request.answer !== 'busy' && request.answer !== 'settled';
    }
    if (request.payment === null && request.answer !== null) {
      // Built fresh, so no PAYMENT-REQUIRED or PAYMENT-RESPONSE header from the middleware's own answer is carried over,
      // and no client is handed fresh terms to pay a second time.
      const body = request.answer === 'settled' ? SETTLED_RETRY : request.answer === 'retry' ? { retry: true } : { busy: true };
      c.res = undefined;
      c.res = new Response(JSON.stringify(body), {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          ...(request.answer === 'settled' && { 'retry-after': String(SETTLED_RETRY_AFTER_SECONDS) }),
        },
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

  // Every answer belongs to one caller and one moment: a decision, a payment's terms, a busy or a pending. Outermost, so
  // it reaches errors and unknown paths too, and no browser or CDN in front ever serves one answer to someone else.
  app.use(async (c, next) => {
    await next();
    c.res.headers.set('cache-control', 'no-store');
  });

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
    paymentMiddleware(screenRoutes(config, deps.unlisted !== true), resourceServer),
    async (c) => {
      const request = paidRequests.getStore();
      // The upfront flow only reaches here after a settle this app recorded. Anything else is a broken invariant.
      if (request?.payment == null || request.claim === null) return c.json({ error: 'the payment could not be confirmed' }, 500);
      const wallet = c.get('wallet');
      const { key } = request.claim;
      if (request.redeemed && request.stored !== null) {
        c.header(STORED_HEADER, 'true');
        return c.json(storedPaidBody(wallet, request.stored, request.payment));
      }
      const payment = request.payment;
      // Stored before it is sent, so a reply lost on the way can be fetched again with the same header.
      const serveAndSend = async (screen: SingleScreen) => {
        const body = paidBody(wallet, screen, payment);
        try {
          await byDeadline(request.deadlineAt, () => claims.serve(key, request.owner, body));
          request.served = true;
        } catch (error) {
          storeFailed('storing a paid result', error);
        }
        return c.json(body);
      };
      // Every try was used and none stored a result: the buyer gets the hold for a screening that ran out of time, the
      // free check's own answer in that case, and no third screening starts (C25, C26).
      if (request.spent) return serveAndSend(heldScreen(wallet, SCREEN_CAUSES.timeUp));
      // Too little time is left to screen: the try is handed back and the buyer sends the same header again (C25, C41).
      if (request.deadlineAt - now().getTime() < SCREEN_LEAST_MS) return settledRetry(c);
      // The payment has settled, so a failure to count the screening must not cost the buyer the result (C25).
      try {
        await byDeadline(request.deadlineAt, () => guard.start(request.ticket));
      } catch (error) {
        storeFailed('counting a screening', error);
      }
      const share = Math.min(SCREEN_TIME_LIMIT_MS, request.deadlineAt - REPLY_MARGIN_MS - now().getTime());
      if (share <= 0) return settledRetry(c);
      const screen = await screenWithin(request, wallet, share);
      // Out of time, whether the share ran out or the screening's own limit did. Before the last try the claim stays
      // settled, so the same header gets another screening; on the last try the time-up hold is the result (C25, C26).
      if (screen === null || screen.decision.cause === SCREEN_CAUSES.timeUp) {
        if (request.screening < REDEEM_SCREEN_TRIES) return settledRetry(c);
        return serveAndSend(screen ?? heldScreen(wallet, SCREEN_CAUSES.timeUp));
      }
      return serveAndSend(screen);
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

  if (deps.campaigns !== undefined) {
    registerCampaignRoutes(app, { ...deps.campaigns, now: deps.campaigns.now ?? now }, (c) => clientOf(c, config.trustedClientHeader));
  }

  return app;
}

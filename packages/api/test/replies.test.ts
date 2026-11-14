// Not covered here: the route itself. These tests hand documentedReply replies built by hand, so they show what it
// lets out of each shape, not which shapes the payment library really builds or when; payment.test.ts runs the route
// against the library for that. The body and PAYMENT-RESPONSE of a 200 and the terms beside a 402's word are outside
// what documentedReply checks, and so outside these tests.
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired, SettleResponse } from '@x402/core/types';
import { describe, expect, it } from 'vitest';
import { documentedReply, INTERNAL_ERROR, NO_MATCH, UNCONFIRMED_PAYMENT, UNPAID, type ReplyRules } from '../src/replies.ts';
import { SETTLED_RETRY } from '../src/schema.ts';

const NETWORK = 'eip155:84532';
const OWN_MESSAGE = 'Sign a fresh payment for these terms, valid for at most 300 seconds.';
const PAYER = '0x041f77015fe51c51aE49a7f2F3Ff86C641fa190a';
const TX = `0x${'5e'.repeat(32)}`;

const before: ReplyRules = { settled: false, network: NETWORK, messages: [OWN_MESSAGE] };
const after: ReplyRules = { ...before, settled: true };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const TERMS: PaymentRequired = {
  x402Version: 2,
  error: UNPAID,
  resource: { url: 'https://thuli.example/api/x402/screen', description: 'a screening', mimeType: 'application/json' },
  accepts: [
    {
      scheme: 'exact',
      network: NETWORK,
      amount: '50000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: PAYER,
      maxTimeoutSeconds: 300,
      extra: { paymentFlow: 'upfront' },
    },
  ],
};
const termsReply = (error: unknown, body: unknown = { error }) =>
  json(402, body, { 'payment-required': encodePaymentRequiredHeader({ ...TERMS, error } as PaymentRequired) });

const refusalReply = (said: Record<string, unknown>, body: unknown = {}) =>
  json(402, body, { 'payment-response': encodePaymentResponseHeader(said as unknown as SettleResponse) });
const REFUSED = { success: false, errorReason: 'insufficient_funds', transaction: '', network: NETWORK };

describe('documentedReply: what the payment step of the paid route may let out (C34)', () => {
  it('lets a 200 out as it is only once the payment is recorded as settled', async () => {
    const result = json(200, { wallet: PAYER });
    expect(await documentedReply(result, after)).toBe(result);
    expect(await documentedReply(json(200, { wallet: PAYER }), before)).toBeNull();
    expect(await documentedReply(new Response(null, { status: 200 }), before)).toBeNull();
  });

  it('lets a 503 out only as the settled retry, and only once the payment is recorded as settled', async () => {
    const wait = json(503, SETTLED_RETRY, { 'retry-after': '10' });
    expect(await documentedReply(wait, after)).toBe(wait);
    // Read for the check and still whole for the caller.
    expect(await wait.json()).toEqual(SETTLED_RETRY);
    expect(await documentedReply(json(503, SETTLED_RETRY), before)).toBeNull();
    expect(await documentedReply(json(503, { busy: true }), after)).toBeNull();
    expect(await documentedReply(json(503, { ...SETTLED_RETRY, message: 'secret-token' }), after)).toBeNull();
    expect(await documentedReply(new Response('<html>secret-token</html>', { status: 503 }), after)).toBeNull();
  });

  it("lets a 500 out only with one of the route's own two bodies, settled or not", async () => {
    for (const rules of [before, after]) {
      for (const body of [INTERNAL_ERROR, UNCONFIRMED_PAYMENT]) {
        const fault = json(500, body, { 'payment-response': 'kept' });
        expect(await documentedReply(fault, rules)).toBe(fault);
      }
      expect(await documentedReply(json(500, { error: 'Internal Server Error' }), rules)).toBeNull();
      expect(await documentedReply(json(500, { error: 'internal error', detail: 'secret-token' }), rules)).toBeNull();
      expect(await documentedReply(new Response(null, { status: 500 }), rules)).toBeNull();
    }
  });

  it('lets no other status out, whatever its body', async () => {
    const statuses = [201, 202, 204, 301, 400, 401, 403, 404, 409, 412, 413, 429, 501, 502, 504];
    for (const rules of [before, after]) {
      for (const status of statuses) {
        const body = status === 204 ? null : JSON.stringify(INTERNAL_ERROR);
        expect(await documentedReply(new Response(body, { status }), rules), String(status)).toBeNull();
      }
      expect(await documentedReply(json(502, { error: 'Facilitator supported returned invalid JSON: secret-token' }), rules)).toBeNull();
      expect(await documentedReply(json(412, { error: 'permit2_allowance_required' }, { 'payment-required': encodePaymentRequiredHeader(TERMS) }), rules)).toBeNull();
    }
  });

  it('rebuilds a 402 with terms as JSON holding the word alone, and keeps the header as sent when the word is a documented one', async () => {
    for (const word of [UNPAID, NO_MATCH]) {
      const built = termsReply(word);
      const header = built.headers.get('payment-required') as string;
      const out = (await documentedReply(built, before)) as Response;
      expect(out.status).toBe(402);
      expect(out.headers.get('content-type')).toBe('application/json');
      expect(await out.text()).toBe(JSON.stringify({ error: word }));
      expect(out.headers.get('payment-required')).toBe(header);
    }
    // The library's own body never leaves: a page, or JSON saying more than the word.
    const page = new Response('<!DOCTYPE html><html>secret-token</html>', {
      status: 402,
      headers: { 'content-type': 'text/html', 'payment-required': encodePaymentRequiredHeader(TERMS), 'x-added': 'secret-token' },
    });
    const fromPage = (await documentedReply(page, before)) as Response;
    expect(fromPage.headers.get('content-type')).toBe('application/json');
    expect(await fromPage.text()).toBe(JSON.stringify({ error: UNPAID }));
    expect([...fromPage.headers.keys()].sort()).toEqual(['content-type', 'payment-required']);
    const wordy = (await documentedReply(termsReply(UNPAID, { error: UNPAID, note: 'secret-token' }), before)) as Response;
    expect(await wordy.text()).toBe(JSON.stringify({ error: UNPAID }));
  });

  it('reads any other word beside the terms as no matching requirements, in the body and in the header, and keeps the terms', async () => {
    for (const said of ['Unsupported x402 version: secret-token', 'extension_echo_mismatch', '', 7, null, { note: 'secret-token' }, undefined]) {
      const out = (await documentedReply(termsReply(said), before)) as Response;
      expect(out.status).toBe(402);
      expect(await out.text()).toBe(JSON.stringify({ error: NO_MATCH }));
      expect(decodePaymentRequiredHeader(out.headers.get('payment-required') as string)).toEqual({ ...TERMS, error: NO_MATCH });
    }
  });

  it('lets a refusal out with an empty body and its header as sent, when the header is a failure on this network with a coded reason', async () => {
    const allowed: Record<string, unknown>[] = [
      REFUSED,
      { ...REFUSED, errorMessage: 'insufficient_funds' },
      { ...REFUSED, errorReason: 'payment_valid_too_long', errorMessage: OWN_MESSAGE },
      { ...REFUSED, transaction: TX, payer: PAYER },
      { ...REFUSED, payer: PAYER.toLowerCase() },
    ];
    for (const said of allowed) {
      const built = refusalReply(said, { note: 'secret-token' });
      const header = built.headers.get('payment-response') as string;
      const out = (await documentedReply(built, before)) as Response;
      expect(out.status, JSON.stringify(said)).toBe(402);
      expect(out.headers.get('content-type')).toBe('application/json');
      expect(await out.text()).toBe('{}');
      expect(out.headers.get('payment-response')).toBe(header);
      expect([...out.headers.keys()].sort()).toEqual(['content-type', 'payment-response']);
    }
  });

  it('lets no refusal out whose header says anything else', async () => {
    const refused: [string, Record<string, unknown>][] = [
      ['a reason in prose', { ...REFUSED, errorReason: 'Insufficient funds: see https://facilitator.example/?key=secret-token' }],
      ['a reason with a capital', { ...REFUSED, errorReason: 'Insufficient_funds' }],
      ['a reason past 64 characters', { ...REFUSED, errorReason: 'a'.repeat(65) }],
      ['an empty reason', { ...REFUSED, errorReason: '' }],
      ['no reason', { success: false, transaction: '', network: NETWORK }],
      ['a message that is neither the reason nor the route\'s own', { ...REFUSED, errorMessage: 'the wallet at secret-token is empty' }],
      ['a message that is not text', { ...REFUSED, errorMessage: 7 }],
      ['a success', { success: true, transaction: TX, network: NETWORK, payer: PAYER }],
      ['a success with a reason', { ...REFUSED, success: true }],
      ['another network', { ...REFUSED, network: 'eip155:8453' }],
      ['no network', { success: false, errorReason: 'insufficient_funds', transaction: '' }],
      ['a transaction that is not one', { ...REFUSED, transaction: 'see secret-token' }],
      ['no transaction', { success: false, errorReason: 'insufficient_funds', network: NETWORK }],
      ['a payer that is not an address', { ...REFUSED, payer: 'the payer is secret-token' }],
      ['a field nobody listed', { ...REFUSED, amount: 'secret-token' }],
      ['extensions', { ...REFUSED, extensions: { note: 'secret-token' } }],
    ];
    for (const [label, said] of refused) {
      expect(await documentedReply(refusalReply(said), before), label).toBeNull();
    }
  });

  it('lets no 402 out once the payment is recorded as settled, with terms or with a refusal', async () => {
    expect(await documentedReply(termsReply(UNPAID), after)).toBeNull();
    expect(await documentedReply(termsReply('failed after settling: secret-token'), after)).toBeNull();
    expect(await documentedReply(refusalReply(REFUSED), after)).toBeNull();
  });

  it('lets no 402 out that carries both payment headers, neither, or one that does not decode', async () => {
    const terms = encodePaymentRequiredHeader(TERMS);
    const refusal = encodePaymentResponseHeader(REFUSED as unknown as SettleResponse);
    const notJson = Buffer.from('secret-token').toString('base64');
    const notAnObject = Buffer.from('[1]').toString('base64');
    const cases: [string, Record<string, string>][] = [
      ['both', { 'payment-required': terms, 'payment-response': refusal }],
      ['neither', {}],
      ['terms that are not base64', { 'payment-required': '!!!' }],
      ['terms that are not JSON', { 'payment-required': notJson }],
      ['terms that are not an object', { 'payment-required': notAnObject }],
      ['a refusal that is not base64', { 'payment-response': '!!!' }],
      ['a refusal that is not JSON', { 'payment-response': notJson }],
      ['a refusal that is not an object', { 'payment-response': notAnObject }],
    ];
    for (const [label, headers] of cases) {
      expect(await documentedReply(json(402, {}, headers), before), label).toBeNull();
    }
  });
});

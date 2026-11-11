// Covers the paid API example loader against the two real captured files, and the texts built from them. It does not
// cover the card's drawing or its reveal; the browser script checks those.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPaidExample, formatUtc, loadPaidExample, PaidExampleError } from '../lib/paidExample';
import { displayReason } from '../lib/rules';

const folder = path.join(import.meta.dirname, '..', '..', 'api', 'examples');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')) as Record<string, any>;
const terms = () => read('payment-required.json');
const answer = () => read('paid-screen-response.json');

describe('loadPaidExample', () => {
  const example = loadPaidExample(folder);

  it('accepts the two real example files', () => {
    expect(example.networkId).toBe(terms().accepts[0].network);
    expect(example.wallet).toBe(answer().wallet);
    expect(example.reason).toBe(answer().decision.reason);
    expect(example.rule).toBe(answer().decision.rule);
    expect(example.action).toBe(answer().decision.action);
  });

  it('writes the price as USDC from the amount in the terms', () => {
    expect(terms().accepts[0].amount).toBe('50000');
    expect(example.price).toBe('0.05');
  });

  it('shortens the wallet and the settlement hash', () => {
    const wallet = answer().wallet as string;
    const hash = answer().payment.transaction as string;
    expect(example.walletShort).toBe(`${wallet.slice(0, 6)}…${wallet.slice(-4)}`);
    expect(example.transactionShort).toBe(`${hash.slice(0, 10)}…${hash.slice(-6)}`);
  });

  it('names the network and builds the settlement link on its explorer', () => {
    expect(example.networkName).toBe('Base Sepolia');
    expect(example.testnet).toBe(true);
    expect(example.settlementUrl).toBe(`https://sepolia.basescan.org/tx/${answer().payment.transaction}`);
  });
});

describe('the reason the receipt shows', () => {
  it('is the example reason without its leading rule code, for the text and for the title', () => {
    const example = loadPaidExample(folder);
    expect(example.reason.startsWith(`${example.rule}: `)).toBe(true);
    const shown = displayReason(example.reason);
    expect(shown).toBe(example.reason.slice(example.rule.length + 2));
    expect(shown.startsWith(example.rule)).toBe(false);
    expect(shown).toBe(shown.trim());
  });
});

describe('checkPaidExample', () => {
  it('builds the Base mainnet link and name for eip155:8453', () => {
    const base = terms();
    base.accepts[0].network = 'eip155:8453';
    const result = checkPaidExample(base, answer());
    expect(result.networkName).toBe('Base');
    expect(result.testnet).toBe(false);
    expect(result.settlementUrl).toBe(`https://basescan.org/tx/${answer().payment.transaction}`);
  });

  it('refuses a changed scheme', () => {
    const changed = terms();
    changed.accepts[0].scheme = 'upto';
    expect(() => checkPaidExample(changed, answer())).toThrow(PaidExampleError);
    expect(() => checkPaidExample(changed, answer())).toThrow(/scheme/);
  });

  it('refuses an amount that is not whole digits', () => {
    for (const amount of ['0.05', '5e4', '-50000', '', 'fifty']) {
      const changed = terms();
      changed.accepts[0].amount = amount;
      expect(() => checkPaidExample(changed, answer()), amount).toThrow(PaidExampleError);
    }
  });

  it('refuses a network it does not know', () => {
    const changed = terms();
    changed.accepts[0].network = 'eip155:1';
    expect(() => checkPaidExample(changed, answer())).toThrow(/network/);
  });

  it('refuses an x402 version that is not 2 and a terms list that is not exactly one entry', () => {
    const old = terms();
    old.x402Version = 1;
    expect(() => checkPaidExample(old, answer())).toThrow(/version/);
    const two = terms();
    two.accepts.push(two.accepts[0]);
    expect(() => checkPaidExample(two, answer())).toThrow(/exactly one/);
    const none = terms();
    none.accepts = [];
    expect(() => checkPaidExample(none, answer())).toThrow(PaidExampleError);
  });

  it('refuses a settlement transaction that is not a lowercase 64 digit hash', () => {
    for (const hash of ['0xabc', answer().payment.transaction.toUpperCase().replace('0X', '0x'), `${answer().payment.transaction}00`, 'text']) {
      const changed = answer();
      changed.payment.transaction = hash;
      expect(() => checkPaidExample(terms(), changed), hash).toThrow(/transaction/);
    }
  });

  it('refuses an answer with a missing field or an action the rulebook does not give', () => {
    for (const field of ['wallet', 'checkedAt', 'decision', 'payment']) {
      const changed = answer();
      delete changed[field];
      expect(() => checkPaidExample(terms(), changed), field).toThrow(PaidExampleError);
    }
    const odd = answer();
    odd.decision.action = 'review';
    expect(() => checkPaidExample(terms(), odd)).toThrow(/action/);
    expect(() => checkPaidExample(terms(), null)).toThrow(PaidExampleError);
    expect(() => checkPaidExample(null, answer())).toThrow(PaidExampleError);
  });
});

describe('formatUtc', () => {
  it('writes the day, month, year and minute in UTC', () => {
    expect(formatUtc('2026-11-11T07:49:55.310Z')).toBe('11 Nov 2026, 07:49 UTC');
    expect(formatUtc('2026-01-02T23:05:00.000Z')).toBe('2 Jan 2026, 23:05 UTC');
    expect(formatUtc('2026-11-11T07:49:55+05:30')).toBe('11 Nov 2026, 02:19 UTC');
  });

  it('refuses text that is not a date', () => {
    expect(() => formatUtc('yesterday')).toThrow(RangeError);
  });
});

// Covers the answer guard, the status mapping, the relative time and the small text tables against the real example
// answer. It does not cover the request itself, the waiting state or the drawing; those need a browser.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addressFromRoute, classify, isFreeCheck, isWalletInput, notCheckedText, relativeTime } from '../lib/check';
import { displayReason } from '../lib/rules';

const example = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'api', 'examples', 'free-check-response.json'), 'utf8'),
) as Record<string, unknown>;
const copy = () => structuredClone(example) as Record<string, any>;

describe('isFreeCheck', () => {
  it('accepts the real example answer', () => {
    expect(isFreeCheck(example)).toBe(true);
  });

  it('refuses a body with a missing field', () => {
    for (const field of ['wallet', 'checkedAt', 'scope', 'rulebook', 'decision', 'servRequestId', 'notChecked', 'cached']) {
      const body = copy();
      delete body[field];
      expect(isFreeCheck(body), `without ${field}`).toBe(false);
    }
    const noReason = copy();
    delete noReason.decision.reason;
    expect(isFreeCheck(noReason)).toBe(false);
  });

  it('refuses an action it does not know', () => {
    const body = copy();
    body.decision.action = 'review';
    expect(isFreeCheck(body)).toBe(false);
  });

  it('refuses cited transactions that are not a list of strings', () => {
    const notArray = copy();
    notArray.decision.citedTxs = '0xabc';
    expect(isFreeCheck(notArray)).toBe(false);
    const mixed = copy();
    mixed.decision.citedTxs = ['0xabc', 7];
    expect(isFreeCheck(mixed)).toBe(false);
  });

  it('refuses a reason that is not a string', () => {
    const body = copy();
    body.decision.reason = { text: 'held' };
    expect(isFreeCheck(body)).toBe(false);
  });

  it('refuses things that are not objects and a time that is not a time', () => {
    for (const value of [null, undefined, 'text', 7, [], [example]]) expect(isFreeCheck(value)).toBe(false);
    const body = copy();
    body.checkedAt = 'yesterday';
    expect(isFreeCheck(body)).toBe(false);
  });

  it('takes a null SERV run and a cached flag of true', () => {
    const body = copy();
    body.servRequestId = null;
    body.cached = true;
    expect(isFreeCheck(body)).toBe(true);
  });
});

describe('the reason the result shows', () => {
  it('is the example reason without its leading rule code, and the rule is still on the answer', () => {
    const { decision } = example as { decision: { rule: string; reason: string } };
    expect(decision.reason.startsWith(`${decision.rule}: `)).toBe(true);
    expect(displayReason(decision.reason)).toBe(decision.reason.slice(decision.rule.length + 2));
    expect(displayReason(decision.reason).startsWith('The wallet is')).toBe(true);
    expect(decision.rule).toBe('A9');
  });
});

describe('classify', () => {
  it('maps each status to its state', () => {
    expect(classify(200, example)).toEqual({ kind: 'result', body: example });
    expect(classify(202, { pending: true })).toEqual({ kind: 'pending' });
    expect(classify(429, { busy: true })).toEqual({ kind: 'limit' });
    expect(classify(503, { busy: true })).toEqual({ kind: 'busy' });
    expect(classify(400, { error: 'the client address could not be read' })).toEqual({ kind: 'bad' });
  });

  it('treats everything else as unreachable, including a 200 or 202 that is not what was promised', () => {
    expect(classify(200, { wallet: 'x' })).toEqual({ kind: 'unreachable' });
    expect(classify(200, null)).toEqual({ kind: 'unreachable' });
    expect(classify(202, { busy: true })).toEqual({ kind: 'unreachable' });
    expect(classify(500, {})).toEqual({ kind: 'unreachable' });
    expect(classify(413, {})).toEqual({ kind: 'unreachable' });
  });
});

describe('relativeTime', () => {
  const at = '2026-11-11T07:00:00.000Z';
  const later = (seconds: number) => Date.parse(at) + seconds * 1000;

  it('says just now under a minute', () => {
    expect(relativeTime(at, later(0))).toBe('just now');
    expect(relativeTime(at, later(59))).toBe('just now');
  });

  it('counts minutes and hours', () => {
    expect(relativeTime(at, later(60))).toBe('1 minute ago');
    expect(relativeTime(at, later(12 * 60))).toBe('12 minutes ago');
    expect(relativeTime(at, later(3600))).toBe('1 hour ago');
    expect(relativeTime(at, later(3 * 3600))).toBe('3 hours ago');
    expect(relativeTime(at, later(30 * 3600))).toBe('30 hours ago');
  });

  it('reads a time in the future as just now', () => {
    expect(relativeTime(at, later(-90))).toBe('just now');
  });
});

describe('notCheckedText', () => {
  it('maps the four names the check can send', () => {
    expect(notCheckedText('group')).toBe('Linked group on a claim list');
    expect(notCheckedText('sharedDepositAddress')).toBe('Shared exchange deposit address');
    expect(notCheckedText('fundingBurst')).toBe('Same-day funding burst');
    expect(notCheckedText('claimPaidToOtherAddress')).toBe('Claim paid to another address');
  });

  it('shows a name it does not know as it is', () => {
    expect(notCheckedText('somethingNew')).toBe('somethingNew');
  });
});

describe('address patterns', () => {
  const lower = '0x59170d55bba35af1f1f9c3d6b1f678fbb68a760e';

  it('accepts what a visitor may type, in any case, and nothing else', () => {
    expect(isWalletInput(lower)).toBe(true);
    expect(isWalletInput('0x59170D55BbA35AF1f1f9c3D6B1f678fbb68A760E')).toBe(true);
    expect(isWalletInput('0x123')).toBe(false);
    expect(isWalletInput(`${lower}0`)).toBe(false);
    expect(isWalletInput(` ${lower}`)).toBe(false);
    expect(isWalletInput(lower.replace('0x', '0X'))).toBe(false);
    expect(isWalletInput(`0x${'g'.repeat(40)}`)).toBe(false);
  });

  it('turns a route segment into a lowercase address, or null', () => {
    expect(addressFromRoute(lower)).toBe(lower);
    expect(addressFromRoute('0x59170D55BbA35AF1f1f9c3D6B1f678fbb68A760E')).toBe(lower);
    expect(addressFromRoute(encodeURIComponent(lower))).toBe(lower);
    expect(addressFromRoute('0x123')).toBeNull();
    expect(addressFromRoute('not-an-address')).toBeNull();
    expect(addressFromRoute('%E0%A4%A')).toBeNull();
  });
});

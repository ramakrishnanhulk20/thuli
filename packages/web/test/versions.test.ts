// Covers the scorecard rows, the interval check and the route counts against the real versions.json and hop.json.
// It does not cover layout, the reveal or the colours; those need a browser.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatFraction, formatInt, formatPercent } from '../lib/format';
import { buildScorecard, intervalLine, loadScorecard, routesTotal } from '../lib/replay/load';
import type { HopFile, RateWithRange, VersionsFile } from '../lib/replay/types';

const root = path.join(import.meta.dirname, '..', 'public', 'replay');
const readJson = <T>(...parts: string[]): T => JSON.parse(fs.readFileSync(path.join(root, ...parts), 'utf8')) as T;

const versions = readJson<VersionsFile>('versions.json');
const hop = readJson<HopFile>('hop.json');
const page = loadScorecard(root);
const row = (key: string) => page.rows.find((entry) => entry.key === key) as (typeof page.rows)[number];

describe('scorecard rows', () => {
  it('has the four rows in order', () => {
    expect(page.rows.map((entry) => entry.key)).toEqual(['catch', 'falseHold', 'feedback', 'cost']);
    expect(page.runDate).toBe(versions.runDate);
  });

  it('writes every percentage from its two counts through formatPercent', () => {
    const catchRate = row('catch');
    expect(catchRate.v1.value).toBe(formatPercent(versions.v1.catchRate.held, versions.v1.catchRate.wallets, 1));
    expect(catchRate.v2.value).toBe(formatPercent(versions.v2.catchRate.held, versions.v2.catchRate.wallets, 1));
    expect(catchRate.v2.counts).toBe(`${formatInt(versions.v2.catchRate.held)} of ${formatInt(versions.v2.catchRate.wallets)}`);

    const falseHold = row('falseHold');
    expect(falseHold.v1.value).toBe(formatPercent(versions.v1.falseHold.held, versions.v1.falseHold.wallets, 2));
    expect(falseHold.v2.value).toBe(formatPercent(versions.v2.falseHold.held, versions.v2.falseHold.wallets, 2));

    const cost = row('cost');
    expect(cost.v1.value).toBe(formatPercent(versions.eliminatedHeld.v1.held, versions.eliminatedHeld.v1.wallets, 1));
    expect(cost.v2.value).toBe(formatPercent(versions.eliminatedHeld.v2.held, versions.eliminatedHeld.v2.wallets, 1));
    expect(cost.v1.counts).toBe(`${formatInt(versions.eliminatedHeld.v1.held)} of ${formatInt(versions.eliminatedHeld.v1.wallets)}`);
  });

  it('writes the feedback row as right of total with no second line', () => {
    const feedback = row('feedback');
    expect(feedback.v1.value).toBe(`${versions.v1.feedback.right} of ${versions.v1.feedback.total}`);
    expect(feedback.v2.value).toBe(`${versions.v2.feedback.right} of ${versions.v2.feedback.total}`);
    expect(feedback.v1.counts).toBeUndefined();
    expect(feedback.v2.interval).toBeUndefined();
  });

  it('does not trust a stored rate: the percent comes from the counts', () => {
    for (const version of [versions.v1, versions.v2]) {
      const stored = version.falseHold.rate;
      const fromCounts = version.falseHold.held / version.falseHold.wallets;
      expect(Math.abs(stored - fromCounts)).toBeLessThan(1e-9);
    }
  });
});

describe('interval bounds', () => {
  const rates: RateWithRange[] = [versions.v1.falseHold, versions.v2.falseHold];

  it('are fractions that bracket held over wallets', () => {
    for (const rate of rates) {
      const share = rate.held / rate.wallets;
      expect(rate.low).toBeGreaterThanOrEqual(0);
      expect(rate.high).toBeLessThanOrEqual(1);
      expect(rate.low).toBeLessThanOrEqual(share);
      expect(rate.high).toBeGreaterThanOrEqual(share);
    }
  });

  it('are shown as percentages to two decimals', () => {
    for (const rate of rates) {
      expect(intervalLine(rate)).toBe(`95% interval ${formatFraction(rate.low, 2)} to ${formatFraction(rate.high, 2)}`);
    }
    expect(row('falseHold').v1.interval).toBe(intervalLine(versions.v1.falseHold));
    expect(row('falseHold').v2.interval).toBe(intervalLine(versions.v2.falseHold));
  });

  it('stop the page when a bound is already a percent', () => {
    const asPercent = { ...versions.v1.falseHold, low: versions.v1.falseHold.low * 100, high: versions.v1.falseHold.high * 100 };
    expect(() => intervalLine(asPercent)).toThrow(/not a pair of fractions/);
    const notAround = { ...versions.v1.falseHold, low: 0.5, high: 0.6 };
    expect(() => buildScorecard({ ...versions, v1: { ...versions.v1, falseHold: notAround } })).toThrow(RangeError);
  });
});

describe('route counts', () => {
  it('add up to the total the copy states', () => {
    const { ship, review, block, unread } = versions.routes;
    expect(routesTotal(versions.routes)).toBe(ship + review + block + unread);
    expect(page.routesTotal).toBe(ship + review + block + unread);
  });

  it('say the same thing twice: the blocked list is as long as the block route', () => {
    expect(versions.verdicts.length).toBe(versions.routes.block);
  });

  it('leave no route out of the sentence under the list (it names ship, review and block)', () => {
    expect(versions.routes.unread).toBe(0);
  });
});

describe('control group numbers', () => {
  it('keeps the control group counts consistent', () => {
    for (const bucket of [hop.probablyReal, hop.eliminated]) {
      expect(bucket.held).toBeLessThanOrEqual(bucket.counted);
      expect(bucket.counted).toBeGreaterThan(0);
    }
    expect(formatPercent(hop.probablyReal.held, hop.probablyReal.counted, 1)).toMatch(/^\d+\.\d%$/);
  });
});

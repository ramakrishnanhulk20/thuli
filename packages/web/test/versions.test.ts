// Covers the scorecard rows, the interval check and the route counts against the real versions.json and hop.json, and the
// repeatability section loader and sentences against the committed consistency.json.
// It does not cover layout, the reveal or the colours; those need a browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { formatFraction, formatInt, formatPercent } from '../lib/format';
import { buildRepeatability, buildScorecard, intervalLine, loadConsistency, loadScorecard, routesTotal } from '../lib/replay/load';
import type { ConsistencyFile, HopFile, RateWithRange, VersionsFile } from '../lib/replay/types';

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

describe('the repeatability file', () => {
  const consistency = readJson<ConsistencyFile>('consistency.json');
  const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
  const interval = (rate: { low: number; high: number }) => `95% interval ${percent(rate.low)} to ${percent(rate.high)}`;
  const modelHoldSamples = consistency.samples.filter((sample) => sample.stratum === 'modelHold');
  const withoutAHold = (file: ConsistencyFile) =>
    file.samples.filter((sample) => sample.stratum === 'modelHold' && !sample.actions.includes('hold')).length;

  const folders: string[] = [];
  afterAll(() => {
    for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true });
  });
  /** Writes a changed copy of the file where the loader looks for it, and returns that folder. */
  const folderWith = (change: (copy: any) => void): string => {
    const copy = structuredClone(consistency) as any;
    change(copy);
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'thuli-consistency-'));
    folders.push(folder);
    fs.writeFileSync(path.join(folder, 'consistency.json'), JSON.stringify(copy));
    return folder;
  };
  const viewOf = (change: (copy: any) => void) => buildRepeatability(loadConsistency(folderWith(change)));

  it('is accepted as committed', () => {
    const loaded = loadConsistency(root);
    expect(loaded.runDate).toBe(consistency.runDate);
    expect(loaded.samples).toHaveLength(consistency.overall.wallets);
  });

  it('is refused when a field the page reads is missing or does not hold together', () => {
    const damage: [string, (copy: any) => void][] = [
      ['no run date', (copy) => delete copy.runDate],
      ['no runs per wallet', (copy) => delete copy.runsPerWallet],
      ['no SERV call count', (copy) => delete copy.servCalls],
      ['ceiling count that is not a whole number', (copy) => (copy.ceilingViolations = 1.5)],
      ['no overall block', (copy) => delete copy.overall],
      ['no all-same figure', (copy) => delete copy.overall.allSame],
      ['a bound written as text', (copy) => (copy.overall.matchMode.low = '0.9')],
      ['a count above its total', (copy) => (copy.overall.allSame.count = copy.overall.allSame.total + 1)],
      ['an upper bound below the share', (copy) => (copy.overall.allSame.high = 0.5)],
      ['an interval written as percents', (copy) => (copy.overall.matchMode.high = 100)],
      ['a lower bound above the share', (copy) => ((copy.overall.matchMode.count = 100), (copy.overall.matchMode.low = 0.99))],
      ['no model-hold stratum', (copy) => delete copy.strata.modelHold],
      ['samples that are not a list', (copy) => (copy.samples = {})],
      ['a sample with no stratum', (copy) => delete copy.samples[0].stratum],
      ['a sample with an unknown action', (copy) => (copy.samples[0].actions[0] = 'maybe')],
      ['a sample with the wrong number of runs', (copy) => copy.samples[0].actions.pop()],
      ['a sample wallet that is not an address', (copy) => (copy.samples[0].wallet = 'nope')],
      ['fewer samples than wallets', (copy) => copy.samples.pop()],
      ['a model-hold count that the samples do not match', (copy) => (copy.strata.modelHold.wallets += 1)],
    ];
    for (const [name, change] of damage) expect(() => loadConsistency(folderWith(change)), name).toThrow();
  });

  it('is refused when the file is missing', () => {
    expect(() => loadConsistency(fs.mkdtempSync(path.join(os.tmpdir(), 'thuli-empty-')))).toThrow(/missing or unreadable/);
  });

  it('writes the first paragraph from the file, in the wording for every wallet agreeing', () => {
    const view = buildRepeatability(consistency);
    const { overall, runsPerWallet, runDate } = consistency;
    expect(overall.allSame.count).toBe(overall.allSame.total);
    expect(view.firstParagraph).toBe(
      `${overall.wallets} wallets from the replay were each screened ${runsPerWallet} more times from scratch on ${runDate}. Every wallet got one outcome across all its runs.`,
    );
  });

  it('writes the other wording when a wallet disagreed with itself', () => {
    const view = viewOf((copy) => {
      copy.overall.allSame.count = copy.overall.allSame.total - 2;
      copy.overall.allSame.low = 0.5;
    });
    const total = consistency.overall.allSame.total;
    expect(view.firstParagraph.endsWith(` ${total - 2} of ${total} wallets got one outcome across all their runs.`)).toBe(true);
    expect(view.firstParagraph).not.toContain('Every wallet');
  });

  it('computes the three figures and their lines from the file', () => {
    const { overall, ceilingViolations } = consistency;
    const { figures } = buildRepeatability(consistency);
    expect(figures).toEqual([
      { value: `${overall.allSame.count} of ${overall.allSame.total}`, label: 'WALLETS WITH ONE OUTCOME EVERY RUN', note: interval(overall.allSame) },
      { value: `${overall.matchMode.count} of ${overall.matchMode.total}`, label: "RUNS THAT MATCHED THE WALLET'S OTHER RUNS", note: interval(overall.matchMode) },
      { value: String(ceilingViolations), label: "RUNS ABOVE THE CODE'S CEILING", note: 'The ceiling is set before the model runs.' },
    ]);
  });

  it('writes the intervals as whole percents', () => {
    for (const figure of buildRepeatability(consistency).figures.slice(0, 2)) expect(figure.note).toMatch(/^95% interval \d{1,3}% to \d{1,3}%$/);
  });

  it('counts the model-hold wallets that never got a hold on a fresh run, from the samples', () => {
    const count = withoutAHold(consistency);
    expect(modelHoldSamples).toHaveLength(consistency.strata.modelHold.wallets);
    expect(count).toBeGreaterThan(0);
    expect(buildRepeatability(consistency).flaw).toBe(
      `It also found a flaw in the replay itself. ${count} of the ${consistency.strata.modelHold.wallets} sampled wallets that the stored replay holds because of the model's answer got a reward on every fresh run. Their stored hold came from a single answer the checks refused, and a refused answer is usually a one-off. The campaign worker asks again, twice, before it stores a hold of that kind.`,
    );
  });

  it('drops the second paragraph when no model-hold wallet escaped a hold', () => {
    const view = viewOf((copy) => {
      for (const sample of copy.samples) if (sample.stratum === 'modelHold') sample.actions[0] = 'hold';
    });
    expect(view.flaw).toBeNull();
  });

  it('counts a wallet only when none of its runs was a hold', () => {
    const view = viewOf((copy) => {
      for (const sample of copy.samples) if (sample.stratum === 'modelHold') sample.actions[sample.actions.length - 1] = 'hold';
      const first = copy.samples.find((sample: any) => sample.stratum === 'modelHold');
      first.actions = first.actions.map(() => 'partial');
    });
    expect(view.flaw).toContain(' 1 of the ');
  });

  it('ends with the limits line, with the sample size and the SERV calls from the file', () => {
    expect(buildRepeatability(consistency).closing).toBe(
      `Not covered: ${consistency.overall.wallets} wallets is a small sample, so the intervals are wide. The same answer twice is not the same as the right answer; the replay and the control sample measure that. This run cost ${consistency.servCalls} SERV calls.`,
    );
  });
});

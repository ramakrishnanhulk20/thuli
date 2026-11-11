// Covers the case file loader, the percent and cent text helpers, and the shape of versions.json and hop.json against
// the real files. It does not cover drawing, the scroll pin, the count-up or the circles; those need a browser.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatPercent, formatUsdCents } from '../lib/format';
import { buildCaseFile, CASE_WALLET, CaseFileError } from '../lib/replay/caseFile';
import { loadFamily, loadHop, loadShard, loadSummary, loadVersions } from '../lib/replay/load';
import type { FamilyFile, WalletShard, WebSummary } from '../lib/replay/types';

const root = path.join(import.meta.dirname, '..', 'public', 'replay');
const readJson = <T>(...parts: string[]): T => JSON.parse(fs.readFileSync(path.join(root, ...parts), 'utf8')) as T;

const shard = readJson<WalletShard>('robo', 'wallets', `${CASE_WALLET.slice(2, 4)}.json`);
const entry = shard.wallets[CASE_WALLET];
const summary = readJson<WebSummary>('robo', 'summary.json');

describe('buildCaseFile', () => {
  it('finds the wallet in the files the build reads', () => {
    expect(entry).toBeDefined();
  });

  const data = buildCaseFile({ root });

  it('returns the wallet, its funder and its family as the files give them', () => {
    const detail = entry as NonNullable<typeof entry>;
    const funder = detail.facts.funder as NonNullable<typeof detail.facts.funder>;
    const family = readJson<FamilyFile>('robo', 'groups', `${detail.group}.json`);
    expect(data.wallet).toBe(CASE_WALLET);
    expect(data.funder).toBe(funder.address);
    expect(data.ageDays).toBe(detail.facts.ageDays);
    expect(data.txCount).toBe(detail.facts.txCount);
    expect(data.hops).toBe(funder.hops);
    expect(data.group).toBe(detail.group);
    expect(data.robo).toBe(detail.robo);
    expect(data.reason).toBe(detail.reason);
    expect(data.requestId).toBe(detail.serv.requestId);
    expect(data.groupSize).toBe(family.size);
  });

  it('derives the other wallets, the dollars and the transaction link', () => {
    const detail = entry as NonNullable<typeof entry>;
    const funder = detail.facts.funder as NonNullable<typeof detail.facts.funder>;
    expect(data.others).toBe(funder.fanout - 1);
    expect(data.usd).toBe(Math.round(detail.robo * summary.drop.usdPerRobo));
    expect(data.tx).toBe(detail.txs[0]);
    expect(data.txUrl).toBe(`https://etherscan.io/tx/${detail.txs[0]}`);
  });

  it('shortens addresses and the transaction hash with an ellipsis', () => {
    expect(data.walletShort).toBe(`${CASE_WALLET.slice(0, 6)}…${CASE_WALLET.slice(-4)}`);
    expect(data.funderShort).toBe(`${data.funder.slice(0, 6)}…${data.funder.slice(-4)}`);
    expect(data.txShort).toBe(`${data.tx.slice(0, 10)}…${data.tx.slice(-6)}`);
  });

  it('throws a clear error for a wallet that was not held (outcome 0, same shard)', () => {
    const released = Object.entries(shard.wallets).find(([, detail]) => detail.outcome === 0);
    expect(released).toBeDefined();
    const [wallet] = released as [string, unknown];
    expect(() => buildCaseFile({ root, wallet })).toThrow(CaseFileError);
    expect(() => buildCaseFile({ root, wallet })).toThrow(/outcome is 0/);
  });

  it('throws for a wallet that is not in its shard', () => {
    const missing = `0x12${'0'.repeat(38)}`;
    expect(() => buildCaseFile({ root, wallet: missing })).toThrow(/not in its shard/);
  });

  it('throws for an address that is not a wallet', () => {
    expect(() => buildCaseFile({ root, wallet: '0x12' })).toThrow(/42 character/);
  });
});

describe('loaders', () => {
  it('read the summary, the shard and the family files', () => {
    expect(loadSummary(root).wallets).toBe(summary.wallets);
    expect(Object.keys(loadShard(CASE_WALLET, root).wallets)).toContain(CASE_WALLET);
    expect(loadFamily((entry as NonNullable<typeof entry>).group, root).index).toBe((entry as NonNullable<typeof entry>).group);
  });

  it('say which file is missing', () => {
    expect(() => loadFamily(9999999, root)).toThrow(/groups\/9999999\.json/);
  });
});

describe('versions.json and hop.json', () => {
  const versions = loadVersions(root);
  const hop = loadHop(root);

  it('hold the numbers the home page prints', () => {
    expect(versions.verdicts.length).toBeGreaterThan(0);
    for (const rate of [versions.v1.falseHold, versions.v2.falseHold, versions.eliminatedHeld.v1, versions.eliminatedHeld.v2]) {
      expect(rate.wallets).toBeGreaterThan(0);
      expect(rate.held).toBeLessThanOrEqual(rate.wallets);
    }
    expect(hop.probablyReal.counted).toBeGreaterThan(0);
    expect(hop.probablyReal.held).toBeLessThanOrEqual(hop.probablyReal.counted);
    expect(summary.run.rulebook).toBeGreaterThanOrEqual(1);
  });

  it('keeps the stored feedback counts in step with the verdict list', () => {
    const released = versions.verdicts.filter((verdict) => verdict.v2Action !== 'hold').length;
    const blockedByV1 = versions.verdicts.filter((verdict) => verdict.v1Action !== 'hold').length;
    expect(versions.v2.feedback.total).toBe(versions.verdicts.length);
    expect(versions.v2.feedback.right).toBe(released);
    expect(versions.v1.feedback.right).toBe(blockedByV1);
  });
});

describe('formatPercent and formatUsdCents', () => {
  it('computes the percent from the two counts', () => {
    expect(formatPercent(11173, 11282, 1)).toBe('99.0%');
    expect(formatPercent(15, 1500, 2)).toBe('1.00%');
  });

  it('refuses a whole of zero', () => {
    expect(() => formatPercent(1, 0, 1)).toThrow(RangeError);
  });

  it('writes cents as dollars', () => {
    expect(formatUsdCents(1751)).toBe('$17.51');
    expect(formatUsdCents(5)).toBe('$0.05');
  });
});

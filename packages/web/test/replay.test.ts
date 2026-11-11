// Covers the link builders, the rule table, the wallet file names and the family clusters against the real files.
// It does not cover fetching or the in-memory cache, drawing, hover, the URL state or any markup; those need a real
// browser on a built page.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addressUrl, isReplayAddress, shortAddress, shortHash, txUrl } from '../lib/explorer';
import { familyClusters, shardName } from '../lib/replay/client';
import { OUTCOME_STYLES, type ReplaySummary } from '../lib/replay/replayTypes';
import type { WebPoints } from '../lib/replay/types';
import { hopsText, ruleMeaning } from '../lib/rules';

const root = path.join(import.meta.dirname, '..', 'public', 'replay', 'robo');
const read = <T>(name: string) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) as T;
const summary = read<ReplaySummary>('summary.json');
const points = read<WebPoints>('points.json');

const HASH = `0x${'ab'.repeat(32)}`;
const ADDRESS = `0x${'cd'.repeat(20)}`;
const LONG_DASH = String.fromCharCode(8212);
const ELLIPSIS = String.fromCharCode(8230);

function upper(value: string): string {
  return `0x${value.slice(2).toUpperCase()}`;
}

describe('txUrl', () => {
  it('links a lowercase 0x and 64 hex characters', () => {
    expect(txUrl(HASH)).toBe(`https://etherscan.io/tx/${HASH}`);
  });

  it('gives no link for an uppercase hash, a short hash, a space, a script tag or a missing 0x', () => {
    expect(txUrl(upper(HASH))).toBeNull();
    expect(txUrl(HASH.slice(0, -1))).toBeNull();
    expect(txUrl(`${HASH}a`)).toBeNull();
    expect(txUrl(`${HASH} `)).toBeNull();
    expect(txUrl(` ${HASH}`)).toBeNull();
    expect(txUrl(`${HASH}\n`)).toBeNull();
    expect(txUrl(`0x${'ab'.repeat(31)} z`)).toBeNull();
    expect(txUrl('<script>alert(1)</script>')).toBeNull();
    expect(txUrl(HASH.slice(2))).toBeNull();
    expect(txUrl('')).toBeNull();
  });
});

describe('addressUrl', () => {
  it('links a lowercase 0x and 40 hex characters', () => {
    expect(addressUrl(ADDRESS)).toBe(`https://etherscan.io/address/${ADDRESS}`);
  });

  it('gives no link for a wrong length, uppercase, a space or a script tag', () => {
    expect(addressUrl(ADDRESS.slice(0, -1))).toBeNull();
    expect(addressUrl(`${ADDRESS}0`)).toBeNull();
    expect(addressUrl(HASH)).toBeNull();
    expect(addressUrl(upper(ADDRESS))).toBeNull();
    expect(addressUrl(`${ADDRESS} `)).toBeNull();
    expect(addressUrl(`${ADDRESS}\n`)).toBeNull();
    expect(addressUrl('<script>alert(1)</script>')).toBeNull();
    expect(addressUrl('0x')).toBeNull();
    expect(addressUrl('')).toBeNull();
  });

  it('agrees with isReplayAddress', () => {
    expect(isReplayAddress(ADDRESS)).toBe(true);
    expect(isReplayAddress(upper(ADDRESS))).toBe(false);
  });
});

describe('shortening', () => {
  it('keeps 6 and 4 characters of an address and 10 and 6 of a hash', () => {
    expect(shortAddress(ADDRESS)).toBe(`0xcdcd${ELLIPSIS}cdcd`);
    expect(shortHash(HASH)).toBe(`0xabababab${ELLIPSIS}ababab`);
  });
});

describe('ruleMeaning', () => {
  const codes = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'B1', 'B2'];

  it('has a meaning for every rule code, in plain words and with no long dash', () => {
    for (const code of codes) {
      const meaning = ruleMeaning(code);
      expect(meaning).not.toBe(code);
      expect(meaning.length).toBeGreaterThan(20);
      expect(meaning.endsWith('.')).toBe(true);
      expect(meaning).not.toContain(LONG_DASH);
    }
  });

  it('gives every rule code in the real wallet files a meaning', () => {
    const seen = new Set<string>();
    for (const file of fs.readdirSync(path.join(root, 'wallets'))) {
      const shard = read<{ wallets: Record<string, { rule: string }> }>(`wallets/${file}`);
      for (const wallet of Object.values(shard.wallets)) seen.add(wallet.rule);
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const code of seen) expect(ruleMeaning(code)).not.toBe(code);
  });

  it('falls back to the code alone for a code it does not know', () => {
    expect(ruleMeaning('Z9')).toBe('Z9');
    expect(ruleMeaning('')).toBe('');
    expect(ruleMeaning('constructor')).toBe('constructor');
    expect(ruleMeaning('__proto__')).toBe('__proto__');
  });
});

describe('hopsText', () => {
  it('uses the singular for one hop and the plural for every other number', () => {
    expect(hopsText(1)).toBe('1 hop');
    expect(hopsText(2)).toBe('2 hops');
    expect(hopsText(3)).toBe('3 hops');
    expect(hopsText(6)).toBe('6 hops');
  });
});

describe('shardName', () => {
  it('is the first two hex characters after 0x', () => {
    expect(shardName(ADDRESS)).toBe('cd');
    expect(shardName(`0x0a${'f'.repeat(38)}`)).toBe('0a');
  });

  it('names the file every real wallet is stored in', () => {
    let checked = 0;
    for (const file of fs.readdirSync(path.join(root, 'wallets'))) {
      const shard = read<{ wallets: Record<string, unknown> }>(`wallets/${file}`);
      for (const address of Object.keys(shard.wallets)) {
        expect(`${shardName(address)}.json`).toBe(file);
        checked += 1;
      }
    }
    expect(checked).toBe(points.count);
  });
});

describe('familyClusters', () => {
  const clusters = familyClusters(points);

  it('holds exactly the wallets whose group is 0 or more', () => {
    const expected = points.group.flatMap((group, wallet) => (group >= 0 ? [wallet] : []));
    const held = clusters.flatMap((cluster) => cluster.members).sort((a, b) => a - b);
    expect(held).toEqual(expected);
  });

  it('makes one cluster per family whose size is the family size in summary.groups', () => {
    expect(clusters).toHaveLength(summary.groups.length);
    const seen = new Set<number>();
    for (const cluster of clusters) {
      expect(seen.has(cluster.groupIndex)).toBe(false);
      seen.add(cluster.groupIndex);
      expect(cluster.members).toHaveLength(summary.groups[cluster.groupIndex]?.size as number);
      for (const wallet of cluster.members) expect(points.group[wallet]).toBe(cluster.groupIndex);
    }
  });

  it('lists members in file order and sorts the largest family first', () => {
    for (const cluster of clusters) {
      expect([...cluster.members].sort((a, b) => a - b)).toEqual(cluster.members);
    }
    for (let q = 1; q < clusters.length; q += 1) {
      expect((clusters[q - 1] as { members: number[] }).members.length).toBeGreaterThanOrEqual(
        (clusters[q] as { members: number[] }).members.length,
      );
    }
  });
});

describe('outcome table', () => {
  it('has one entry per outcome code, in code order, each with its own colour token', () => {
    expect(OUTCOME_STYLES.map((style) => style.code)).toEqual([0, 1, 2, 3]);
    expect(new Set(OUTCOME_STYLES.map((style) => style.token)).size).toBe(4);
    expect(OUTCOME_STYLES.map((style) => style.name)).toEqual(['full', 'partial', 'hold', 'exclude']);
  });
});

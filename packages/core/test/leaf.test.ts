// Not covered here: the on-chain half of the same fixture (packages/contracts/test/LeafFixture.t.sol claims every proof
// from a real vault at the fixture address), random trees (packages/contracts/test/ThuliVault.fuzz.t.sol), and
// matching a root against a deployed vault (C32, the worker's job).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AddressError } from '../src/address.ts';
import { ChainError } from '../src/chains.ts';
import { LeafError, buildTree, leafValues, proofFor, type LeafValues } from '../src/leaf.ts';

const Hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const Fixture = z.object({
  chainId: z.string(),
  vault: z.string(),
  root: Hash,
  entries: z
    .array(z.object({ account: z.string(), cumulativeAmount: z.string(), leaf: Hash, proof: z.array(Hash) }))
    .min(2),
});

const fixture = Fixture.parse(
  JSON.parse(readFileSync(new URL('../../contracts/test/fixtures/leaf-tree.json', import.meta.url), 'utf8')),
);

function fixtureLeaves(): LeafValues[] {
  return fixture.entries.map((entry) =>
    leafValues(fixture.chainId, fixture.vault, entry.account, BigInt(entry.cumulativeAmount)),
  );
}

const VAULT = '0x381C8005C0a308DB4b846300Fd88feF7Bb3308b5';
const ALICE = '0x041f77015fe51c51aE49a7f2F3Ff86C641fa190a';
const BOB = '0x8E804eca872C0168b281155106C784fd777a536D';

describe('buildTree against the Foundry fixture (C28)', () => {
  it('builds the same root as the Solidity tree', () => {
    expect(buildTree(fixtureLeaves()).root).toBe(fixture.root);
  });

  it('gives every account the same leaf hash and the same proof', () => {
    const tree = buildTree(fixtureLeaves());
    for (const [i, entry] of fixture.entries.entries()) {
      expect(tree.leafHash(fixtureLeaves()[i] as LeafValues)).toBe(entry.leaf);
      expect(proofFor(tree, entry.account)).toEqual(entry.proof);
    }
  });

  it('builds the same root whatever the list order or address spelling (C1)', () => {
    const respelled = [...fixture.entries]
      .reverse()
      .map((entry) =>
        leafValues(8453, fixture.vault.toLowerCase(), `${entry.account.toLowerCase()} \r`, BigInt(entry.cumulativeAmount)),
      );
    expect(buildTree(respelled).root).toBe(fixture.root);
  });

  it('finds the proof from any accepted spelling of the account (C1)', () => {
    const tree = buildTree(fixtureLeaves());
    const entry = fixture.entries[1] as (typeof fixture.entries)[number];
    expect(proofFor(tree, entry.account.toLowerCase())).toEqual(entry.proof);
  });
});

describe('leafValues', () => {
  it('turns every value into the one form the vault hashes', () => {
    expect(leafValues('0x2105', VAULT.toLowerCase(), ALICE, 1_000_000n)).toEqual(['8453', VAULT, ALICE, '1000000']);
  });

  it('accepts zero and the largest uint256, and nothing outside them (C3)', () => {
    expect(leafValues(8453, VAULT, ALICE, 0n)[3]).toBe('0');
    expect(leafValues(8453, VAULT, ALICE, 2n ** 256n - 1n)[3]).toBe((2n ** 256n - 1n).toString());
    expect(() => leafValues(8453, VAULT, ALICE, -1n)).toThrow(LeafError);
    expect(() => leafValues(8453, VAULT, ALICE, 2n ** 256n)).toThrow(LeafError);
    expect(() => leafValues(8453, VAULT, ALICE, 1 as unknown as bigint)).toThrow(LeafError);
  });

  it('rejects a mistyped address instead of hashing it (C1)', () => {
    expect(() => leafValues(8453, VAULT, '0x041f77015fe51c51AE49a7f2F3Ff86C641fa190a', 1n)).toThrow(AddressError);
  });

  it('rejects a chain Thuli does not run on (C2)', () => {
    expect(() => leafValues(31337, VAULT, ALICE, 1n)).toThrow(ChainError);
  });
});

describe('buildTree refuses lists the vault would not pay as intended', () => {
  it('refuses an empty list', () => {
    expect(() => buildTree([])).toThrow(LeafError);
  });

  it('refuses an account listed twice, whatever the amounts', () => {
    const twice = [leafValues(8453, VAULT, ALICE, 1n), leafValues(8453, VAULT, ALICE.toLowerCase(), 2n)];
    expect(() => buildTree(twice)).toThrow(/appears twice/);
  });

  it('refuses entries for two vaults or two chains', () => {
    const vaults = [leafValues(8453, VAULT, ALICE, 1n), leafValues(8453, BOB, ALICE, 1n)];
    expect(() => buildTree(vaults)).toThrow(/more than one chain or vault/);
    const chains = [leafValues(8453, VAULT, ALICE, 1n), leafValues(1, VAULT, BOB, 1n)];
    expect(() => buildTree(chains)).toThrow(/more than one chain or vault/);
  });

  it('refuses hand-made entries that skip leafValues', () => {
    const good = leafValues(8453, VAULT, ALICE, 16n);
    const handMade: LeafValues[] = [
      [good[0], good[1], good[2], '0x10'],
      [good[0], good[1], good[2], ' 16'],
      [good[0], good[1], good[2], '016'],
      [good[0], good[1], ALICE.toLowerCase() as LeafValues[2], '16'],
      ['0x2105', good[1], good[2], '16'],
    ];
    for (const entry of handMade) {
      expect(() => buildTree([entry])).toThrow(LeafError);
    }
  });
});

describe('proofFor', () => {
  it('refuses an account with no leaf', () => {
    const tree = buildTree([leafValues(8453, VAULT, ALICE, 1n)]);
    expect(proofFor(tree, ALICE)).toEqual([]);
    expect(() => proofFor(tree, BOB)).toThrow(LeafError);
  });
});

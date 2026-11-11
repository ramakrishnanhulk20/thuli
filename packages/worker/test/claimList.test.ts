// Not covered here: the vault paying these proofs on-chain (packages/contracts/test/LeafFixture.t.sol and the fuzz
// suite), whether the vault holds enough to pay a list (checkRoot and postRoot in vault.test.ts), and how many reward
// slots a campaign has, which is decided before a list is built.
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { describe, expect, it } from 'vitest';
import {
  AddressError,
  ChainError,
  computeCeiling,
  computeStart,
  DEFAULT_SETTINGS,
  LEAF_TYPES,
  LeafError,
  leafValues,
  OUTCOMES,
  parseAddress,
  shareFor,
  validateDecision,
  type Address,
  type Facts,
  type Outcome,
} from '@thuli/core';
import { buildClaimList, ClaimListError, claimTicket, type ClaimTerms, type ClaimTicket, type ScreenedWallet } from '../src/vault/claimList.ts';
import { buildRoot, MAX_ROOT_ENTRIES, publishList, readPublishedList, RootError } from '../src/vault/root.ts';

const MASK64 = (1n << 64n) - 1n;

/** splitmix64, so every run checks the same cases and a failing case can be replayed from its index. */
function seeded(seed: bigint) {
  let state = seed & MASK64;
  const word = (): bigint => {
    state = (state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return z ^ (z >> 31n);
  };
  /** A value from 0 up to but not including `limit`, with 64 spare bits so the modulo bias is negligible. */
  const below = (limit: bigint): bigint => {
    let value = 0n;
    let range = 1n;
    while (range < limit << 64n) {
      value = (value << 64n) | word();
      range <<= 64n;
    }
    return value % limit;
  };
  return { below, upTo: (max: number): number => Number(below(BigInt(max) + 1n)) };
}

const VAULT = '0x381C8005C0a308DB4b846300Fd88feF7Bb3308b5';
const ALICE = '0x041f77015fe51c51aE49a7f2F3Ff86C641fa190a';
const BOB = '0x8E804eca872C0168b281155106C784fd777a536D';
const ALICE_TYPO = '0x041f77015fe51c51AE49a7f2F3Ff86C641fa190a';
const CHAIN = 84532;
const lowercaseWallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const wallet = (n: number): Address => parseAddress(lowercaseWallet(n));
const CAROL = wallet(0xca401);
const HELD = wallet(0x4e1d);

const TERMS: ClaimTerms = { rewardPerWallet: 20_000_001n, perWalletCap: 25_000_000n, partialShareBps: 3333 };

const row = (account: string, action: Outcome, partialShareBps = TERMS.partialShareBps): ScreenedWallet => ({
  account,
  action,
  shareBps: shareFor(action, { partialShareBps }),
});

describe('buildClaimList', () => {
  it('pays a full wallet the reward and a partial one its share rounded down, in input order (C3)', () => {
    const list = buildClaimList([row(BOB, 'partial'), row(ALICE, 'full')], TERMS);
    expect(list).toEqual({
      entries: [
        { account: BOB, cumulativeAmount: 6_666_000n },
        { account: ALICE, cumulativeAmount: 20_000_001n },
      ],
      declaredTotal: 26_666_001n,
    });
  });

  it('gives hold and exclude wallets no entry', () => {
    const list = buildClaimList(
      [row(HELD, 'hold'), row(ALICE, 'full'), row(wallet(7), 'exclude'), row(BOB, 'partial'), row(wallet(8), 'hold')],
      TERMS,
    );
    expect(list.entries.map((entry) => entry.account)).toEqual([ALICE, BOB]);
  });

  it('carries the canonical address whatever spelling came in (C1)', () => {
    const upperBob = `0x${BOB.slice(2).toUpperCase()}`;
    const list = buildClaimList([row(`${ALICE.toLowerCase()} \r`, 'full'), row(upperBob, 'full')], TERMS);
    expect(list.entries.map((entry) => entry.account)).toEqual([ALICE, BOB]);
  });

  it('refuses one wallet given checksummed and lowercase in the same list, whatever each row decided (C1)', () => {
    expect(() => buildClaimList([row(ALICE, 'full'), row(ALICE.toLowerCase(), 'full')], TERMS)).toThrow(
      new RegExp(`row 1 repeats ${ALICE}`),
    );
    expect(() => buildClaimList([row(ALICE.toLowerCase(), 'hold'), row(ALICE, 'full')], TERMS)).toThrow(ClaimListError);
  });

  it('refuses a mixed-case address with a wrong checksum through the one parser, naming the row (C1)', () => {
    try {
      buildClaimList([row(BOB, 'full'), row(ALICE_TYPO, 'full')], TERMS);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ClaimListError);
      expect(String(error)).toMatch(/row 1 has a malformed address/);
      expect((error as Error).cause).toBeInstanceOf(AddressError);
    }
  });

  it.each([
    ['a full decision with share 5000', { action: 'full', shareBps: 5000 }],
    ['a partial decision with a share other than the terms', { action: 'partial', shareBps: 5000 }],
    ['a hold with a non-zero share', { action: 'hold', shareBps: 1 }],
    ['an exclude with the full share', { action: 'exclude', shareBps: 10_000 }],
    ['a fractional partial share', { action: 'partial', shareBps: 3333.5 }],
    ['an action that is not one of the four', { action: 'maybe', shareBps: 0 }],
  ])('refuses %s, naming the row (C13)', (_label, decision) => {
    const rows = [row(ALICE, 'full'), { account: BOB, ...decision } as ScreenedWallet];
    expect(() => buildClaimList(rows, TERMS)).toThrow(/^row 1 /);
    expect(() => buildClaimList(rows, TERMS)).toThrow(ClaimListError);
  });

  it.each([
    ['a zero reward', { rewardPerWallet: 0n }],
    ['a reward above the cap', { rewardPerWallet: 25_000_001n }],
    ['a reward that is a number', { rewardPerWallet: 20_000_000 as unknown as bigint }],
    ['a partial share of 0', { partialShareBps: 0 }],
    ['a partial share of 10000', { partialShareBps: 10_000 }],
    ['a fractional partial share', { partialShareBps: 33.3 }],
    ['a partial reward that rounds to nothing', { rewardPerWallet: 3n }],
  ])('refuses terms with %s', (_label, change) => {
    expect(() => buildClaimList([row(ALICE, 'full')], { ...TERMS, ...change })).toThrow(/^terms: /);
  });

  it('takes the smallest reward whose partial share is one base unit', () => {
    const list = buildClaimList([row(BOB, 'partial')], { ...TERMS, rewardPerWallet: 4n });
    expect(list.entries).toEqual([{ account: BOB, cumulativeAmount: 1n }]);
  });

  it('agrees with validateDecision on the share every action carries, so one rule decides it (C13)', () => {
    const facts: Facts = {
      walletAgeDays: 400,
      txCountAtSnapshot: 40,
      accountType: 'eoa',
      firstFunder: null,
      group: null,
      sharedDepositAddress: null,
      fundingBurst: null,
      claimPaidToOtherAddress: false,
      evidenceTxs: [],
      missing: [],
    };
    const settings = { ...DEFAULT_SETTINGS, partialShareBps: TERMS.partialShareBps };
    const start = computeStart(facts, settings);
    const { ceiling } = computeCeiling(facts, settings);
    const shares = [0, 1, TERMS.partialShareBps, DEFAULT_SETTINGS.partialShareBps, 9_999, 10_000];
    for (const action of OUTCOMES) {
      let taken = 0;
      for (const shareBps of shares) {
        const raw = { action, shareBps, rule: start.rule, reason: 'A reason.', citedTxs: [], paidHops: 0 };
        const checked = validateDecision(raw, { facts, settings, ceiling, start, toolTxs: [], paidHopsMade: 0 });
        const decisionTakesShare = checked.cause !== 'the share did not match the action';
        let listTakesShare = true;
        try {
          buildClaimList([{ account: ALICE, action, shareBps }], TERMS);
        } catch (error) {
          expect(error).toBeInstanceOf(ClaimListError);
          listTakesShare = false;
        }
        expect(listTakesShare, `${action} with share ${shareBps}`).toBe(decisionTakesShare);
        if (listTakesShare) taken += 1;
      }
      // Exactly one share per action, so the two cannot agree by refusing everything.
      expect(taken, action).toBe(1);
    }
  });

  it('takes exactly MAX_ROOT_ENTRIES paid wallets and refuses one more (C41)', () => {
    const rows: ScreenedWallet[] = Array.from({ length: MAX_ROOT_ENTRIES + 1 }, (_, i) => ({
      account: lowercaseWallet(i + 1),
      action: 'full',
      shareBps: 10_000,
    }));
    expect(() => buildClaimList(rows, TERMS)).toThrow(new RegExp(`row ${MAX_ROOT_ENTRIES} would make the list longer`));
    expect(buildClaimList(rows.slice(0, MAX_ROOT_ENTRIES), TERMS).entries).toHaveLength(MAX_ROOT_ENTRIES);
  }, 60_000);

  it('keeps the total exact, within the rewards and under the cap, on 5,000 seeded random lists (C3)', () => {
    const random = seeded(41n);
    let next = 1;
    for (let i = 0; i < 5_000; i += 1) {
      const partialShareBps = 1 + random.upTo(9_998);
      // The smallest reward whose partial share is at least one base unit; checkTerms refuses anything below it.
      const leastReward = (10_000n + BigInt(partialShareBps) - 1n) / BigInt(partialShareBps);
      const rewardPerWallet = leastReward + random.below(10n ** BigInt(random.upTo(30)));
      const perWalletCap = rewardPerWallet + random.below(10n ** BigInt(random.upTo(30)) + 1n);
      const terms = { rewardPerWallet, perWalletCap, partialShareBps };
      const rows = Array.from({ length: random.upTo(8) }, () => {
        next += 1;
        return row(lowercaseWallet(next), OUTCOMES[random.upTo(3)] as Outcome, partialShareBps);
      });
      const label = `case ${i}: reward ${rewardPerWallet}, cap ${perWalletCap}, partial ${partialShareBps}`;

      const list = buildClaimList(rows, terms);
      const full = BigInt(rows.filter((r) => r.action === 'full').length);
      const partial = BigInt(rows.filter((r) => r.action === 'partial').length);
      const sum = list.entries.reduce((total, entry) => total + entry.cumulativeAmount, 0n);
      expect(sum, label).toBe(list.declaredTotal);
      expect(list.declaredTotal <= rewardPerWallet * (full + partial), label).toBe(true);
      expect(list.declaredTotal, label).toBe(full * rewardPerWallet + partial * ((rewardPerWallet * BigInt(partialShareBps)) / 10_000n));
      expect(list.entries.every((entry) => entry.cumulativeAmount <= perWalletCap), label).toBe(true);
      expect(list.entries.length, label).toBe(Number(full + partial));
    }
  });
});

describe('claimTicket (C28, C32)', () => {
  const list = buildClaimList([row(ALICE, 'full'), row(HELD, 'hold'), row(BOB, 'partial'), row(CAROL, 'full')], TERMS);
  const published = publishList(list.entries);
  const ticketFor = (account: string): ClaimTicket => {
    const ticket = claimTicket(published, VAULT, CHAIN, account);
    if (ticket === null) throw new Error(`no ticket for ${account}`);
    return ticket;
  };
  const verifies = (ticket: ClaimTicket, account: string, amount: bigint) =>
    StandardMerkleTree.verify(ticket.root, LEAF_TYPES, leafValues(CHAIN, VAULT, account, amount), ticket.proof);

  it('hands buildRoot the entries unchanged, leaf for leaf, and the published text reads back to them', () => {
    const { tree } = buildRoot(list.entries, VAULT, CHAIN);
    const leaves = [...tree.entries()].map(([, leaf]) => [leaf[2], BigInt(leaf[3])]);
    expect(leaves).toEqual(list.entries.map((entry) => [entry.account, entry.cumulativeAmount]));
    expect(readPublishedList(published)).toEqual(list.entries);
  });

  it('proves every listed wallet against the root anyone rebuilds from the published list', () => {
    const rebuilt = buildRoot(readPublishedList(published), VAULT, CHAIN).root;
    for (const entry of list.entries) {
      const ticket = ticketFor(entry.account);
      expect(ticket.root).toBe(rebuilt);
      expect(ticket.account).toBe(entry.account);
      expect(ticket.cumulativeAmount).toBe(entry.cumulativeAmount);
      expect(verifies(ticket, ticket.account, ticket.cumulativeAmount)).toBe(true);
    }
  });

  it("does not verify the same proof with another wallet's address or amount", () => {
    const alice = ticketFor(ALICE);
    const bob = ticketFor(BOB);
    expect(verifies(alice, BOB, alice.cumulativeAmount)).toBe(false);
    expect(verifies(alice, ALICE, bob.cumulativeAmount)).toBe(false);
    expect(verifies(alice, BOB, bob.cumulativeAmount)).toBe(false);
    expect(verifies(alice, ALICE, alice.cumulativeAmount + 1n)).toBe(false);
  });

  it('finds the wallet from any accepted spelling and returns the canonical address (C1)', () => {
    expect(ticketFor(ALICE.toLowerCase())).toEqual(ticketFor(ALICE));
  });

  it('gives null to a wallet that is not on the list, a held one included', () => {
    expect(claimTicket(published, VAULT, CHAIN, HELD)).toBeNull();
    expect(claimTicket(published, VAULT, CHAIN, wallet(999))).toBeNull();
  });

  it('lets the existing errors through for a malformed list, vault, chain or address', () => {
    const twice = publishList([
      { account: ALICE, cumulativeAmount: 1n },
      { account: ALICE.toLowerCase(), cumulativeAmount: 2n },
    ]);
    expect(() => claimTicket('not json', VAULT, CHAIN, ALICE)).toThrow(RootError);
    expect(() => claimTicket('[]', VAULT, CHAIN, ALICE)).toThrow(LeafError);
    expect(() => claimTicket(twice, VAULT, CHAIN, ALICE)).toThrow(LeafError);
    expect(() => claimTicket(published, '0x1234', CHAIN, ALICE)).toThrow(AddressError);
    expect(() => claimTicket(published, VAULT, 31337, ALICE)).toThrow(ChainError);
    expect(() => claimTicket(published, VAULT, CHAIN, ALICE_TYPO)).toThrow(AddressError);
  });
});

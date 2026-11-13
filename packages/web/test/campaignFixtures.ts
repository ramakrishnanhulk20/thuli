// Answers of the campaign routes, built the way the real routes build them, for the unit test and the browser script.
// campaign.test.ts holds every one of them to packages/api/src/schema.ts, so a fixture cannot drift from the contract.
import { privateKeyToAccount } from 'viem/accounts';

export const CAMPAIGN_ID = 'demo-spring_2026.v1';

const DAY = 86_400_000;
const HASH_A = '0x4e7e84ae76bcede030f2e71a8776c59b376bc838b42f7c52c190aae2e074e68c';
const HASH_B = '0xa91898bfe55aad41d5295aac670976adcea7bd1366773db8a28de12f1198de67';
const ROOT_1 = '0x1d575779216ee7c9f5a6883fda38a3d538a05fc4bab059498ace8ba5cae221c1';
const ROOT_2 = '0x3c4db8655abb753e91ee260a65d74a4ebf93d130fe0d0d1ede912ef4d4bea0db';
const POST_TX = '0x67d821afd5bfd7e33af6c73382c2bc53f8d50370ef0b516c0320e04b54a9ed28';

/** A checksummed address that is the same on every run: a key made from a number. */
export function fixtureWallet(index: number): string {
  const key = `0x${(index + 1).toString(16).padStart(64, '0')}` as `0x${string}`;
  return privateKeyToAccount(key).address;
}

/** How far an appeal has got: filed and not yet read, being read, each answer of the outside judges, or never checked. */
export type AppealKind = 'queued' | 'checking' | 'ship' | 'review' | 'block' | 'unreadable' | 'unchecked';

const NOTES: Record<'ship' | 'review' | 'block', string> = {
  ship: 'The record gives no sign of a farm. The hold looks reasonable on what was read.',
  review: 'The record is thin either way. A person should look at this wallet.',
  block: 'The hold rests on a shared funder alone, which is not enough to hold a wallet.',
};

export type AskKind = 'queued' | 'screening' | 'full' | 'partial' | 'fullNoSlot' | 'hold' | 'exclude' | 'failed';

const REASONS: Record<'full' | 'partial' | 'hold' | 'exclude' | 'failed', { rule: string; reason: string; txs: string[] }> = {
  full: {
    rule: 'A9',
    reason: 'A9: The wallet is 1,353 days old with 56 pre-snapshot activities. No linked claim-wallet group, shared funding or onward claim payment is recorded.',
    txs: [],
  },
  partial: {
    rule: 'A8',
    reason: 'A8: The wallet is 12 days old with 2 pre-snapshot activities, so it gets a partial reward. Quotes " and ampersands & stay as written.',
    txs: [HASH_A],
  },
  hold: {
    rule: 'A4',
    reason: 'A4: The wallet is in a 22-wallet group with shared funding, and its funder funded 21 other claim wallets.',
    txs: [HASH_A, HASH_B],
  },
  exclude: {
    rule: 'A3',
    reason: 'A3: The wallet made group links and the group swept funds to a shared collector.',
    txs: [HASH_B],
  },
  failed: { rule: 'A1', reason: 'Held for review: the screening could not finish.', txs: [] },
};

function isoAt(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

export interface FixtureOptions {
  /** The wallet the page is connected with. */
  wallet: string;
  /** The moment the fixtures are built around, in milliseconds. */
  now?: number;
}

export function buildFixtures({ wallet, now = Date.now() }: FixtureOptions) {
  const midnight = Math.floor(now / DAY) * DAY;
  const opensAt = isoAt(midnight - 10 * DAY);
  const closesAt = isoAt(midnight + 5 * DAY - 60_000);

  const lists = (kind: 'none' | 'one' | 'two' | 'sending') =>
    kind === 'none'
      ? []
      : kind === 'sending'
        ? [
            { version: 1, root: ROOT_1, status: 'superseded', postTx: POST_TX, claimableAt: Math.floor(now / 1000) - 7200 },
            { version: 2, root: ROOT_2, status: 'sending', postTx: HASH_B, claimableAt: null },
          ]
        : kind === 'one'
        ? [{ version: 1, root: ROOT_1, status: 'active', postTx: POST_TX, claimableAt: Math.floor(now / 1000) - 3600 }]
        : [
            { version: 1, root: ROOT_1, status: 'superseded', postTx: POST_TX, claimableAt: Math.floor(now / 1000) - 7200 },
            { version: 2, root: ROOT_2, status: 'posted', postTx: HASH_A, claimableAt: Math.floor(now / 1000) + 3600 },
            { version: 3, root: ROOT_1, status: 'built', postTx: null, claimableAt: null },
            { version: 4, root: ROOT_2, status: 'cancelled', postTx: HASH_B, claimableAt: null },
          ];

  const campaign = (overrides: Record<string, unknown> = {}) => ({
    name: 'Spring drop test',
    chain: 84532,
    vault: '0xAdb8aD5A8BC359fF17D81DBe41833bB6b26B2034',
    token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    rewardPerWallet: '1000000',
    perWalletCap: '1000000',
    maxSlots: 20,
    status: 'open',
    opensAt,
    closesAt,
    counts: { asked: 14, queued: 2, decided: 12, held: 5, slotsTaken: 7, slotsLeft: 13, asksLeft: 186, appeals: { filed: 0, checked: 0, block: 0, reversed: 0 } },
    lists: lists('one'),
    ...overrides,
  });

  const ask = (kind: AskKind, who: string = wallet, slot: number | null = null, minutesAgo = 5, factsOverride: Record<string, unknown> = {}) => {
    const base = {
      campaignId: CAMPAIGN_ID,
      wallet: who,
      askedAt: isoAt(now - (minutesAgo + 2) * 60_000),
      servRequestId: null,
      appeal: null,
    };
    if (kind === 'queued' || kind === 'screening') {
      return { ...base, status: kind, action: null, shareBps: null, rule: null, reason: null, citedTxs: null, notChecked: null, facts: null, decidedAt: null, slot: null };
    }
    const shape = kind === 'fullNoSlot' ? 'full' : kind;
    const text = REASONS[shape];
    const action = kind === 'failed' ? 'hold' : kind === 'fullNoSlot' ? 'full' : kind;
    return {
      ...base,
      status: kind === 'failed' ? 'failed' : 'decided',
      action,
      shareBps: action === 'full' ? 10_000 : action === 'partial' ? 5000 : 0,
      rule: text.rule,
      reason: text.reason,
      citedTxs: text.txs,
      notChecked: ['sharedDepositAddress', 'sweptToSharedCollector', 'claimPaidToOtherAddress', 'fundingBurst', 'passThroughFunding'],
      facts:
        kind === 'failed'
          ? null
          : {
              ageDays: kind === 'partial' ? 12 : 1353,
              txCount: kind === 'partial' ? 2 : 56,
              accountType: 'eoa',
              funder: { address: fixtureWallet(900), kind: 'wallet', fanout: kind === 'hold' ? 22 : 1, hops: 3 },
              burstWallets: null,
              groupSize: kind === 'hold' ? 22 : null,
              missing: [],
              chain: 'ethereum',
              ...factsOverride,
            },
      decidedAt: isoAt(now - minutesAgo * 60_000),
      slot: kind === 'fullNoSlot' || kind === 'hold' || kind === 'exclude' || kind === 'failed' ? null : slot,
    };
  };

  const ticket = (overrides: Record<string, unknown> = {}) => ({
    cumulativeAmount: '1000000',
    proof: [],
    root: ROOT_1,
    claimed: '0',
    claimable: '1000000',
    ...overrides,
  });

  /**
   * The public view of an appeal, in the shape the routes will send: nothing of the appellant's own words. The overrides
   * settle it, for example { outcome: 'reversed', newAction: 'full', settledAt }.
   */
  const appeal = (kind: AppealKind, overrides: Record<string, unknown> = {}) => {
    const checked = kind === 'ship' || kind === 'review' || kind === 'block' || kind === 'unreadable';
    return {
      filedAt: isoAt(now - 3 * 60_000),
      checkStatus: checked ? 'checked' : kind,
      reppoRoute: kind === 'ship' || kind === 'review' || kind === 'block' ? kind : null,
      reppoNote: kind === 'ship' || kind === 'review' || kind === 'block' ? NOTES[kind] : null,
      reppoEvalId: checked ? 'ev_8f3a1c92' : null,
      checkedAt: checked ? isoAt(now - 2 * 60_000) : null,
      outcome: 'open',
      newAction: null,
      settledAt: null,
      ...overrides,
    };
  };

  /** An ask as the routes send it once it has been appealed. */
  const withAppeal = <T extends object>(source: T, view: ReturnType<typeof appeal>) => ({ ...source, appeal: view });

  /** A board page: `count` rows, newest first, the first one decided `startMinutes` ago and each next one a minute earlier. */
  const board = (
    count: number,
    startMinutes = 1,
    appealAt?: (index: number) => ReturnType<typeof appeal> | undefined,
    paidAt?: (index: number) => boolean,
  ) => {
    const asks = Array.from({ length: count }, (_, index) => {
      const row = ask((['full', 'hold', 'partial', 'exclude', 'full'] as const)[index % 5] as AskKind, fixtureWallet(100 + startMinutes + index), index % 5 === 0 || index % 5 === 2 ? index + 1 : null, startMinutes + index);
      const view = appealAt?.(index);
      return view === undefined ? row : withAppeal(row, view);
    });
    // One payout for each row the test names: half a USDC, with a transaction of its own.
    const payouts = asks.flatMap((row, index) =>
      paidAt?.(index) === true ? [{ wallet: row.wallet, amount: '500000', transaction: `0x${'a'.repeat(62)}${(index % 100).toString().padStart(2, '0')}` }] : [],
    );
    return { asks, payouts };
  };

  /** What the ask route answers with when the wallet has sent no transaction and holds nothing: nothing is stored. */
  const neverUsed = { neverUsed: true };

  return { campaignId: CAMPAIGN_ID, campaign, lists, ask, appeal, withAppeal, ticket, board, neverUsed, askView: (a: ReturnType<typeof ask>, t?: ReturnType<typeof ticket>) => (t === undefined ? { ask: a } : { ask: a, ticket: t }) };
}

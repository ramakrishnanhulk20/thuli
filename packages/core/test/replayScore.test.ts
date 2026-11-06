// Not covered here: how the rows were built (the worker's replay runner and its tests), and whether Bitquery's key is
// itself right. This file checks only the arithmetic of the scorecard and the words it prints.
import { describe, expect, it } from 'vitest';
import { parseAddress } from '../src/address.ts';
import type { FactName, Facts } from '../src/facts.ts';
import { scoreReplay, scoreToMarkdown, type FarmKeyEntry, type ReplayRow } from '../src/replayScore.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import type { Start } from '../src/start.ts';

const wallet = (tag: string) => `0x${tag.repeat(20)}`;
const COLLECTOR_1 = wallet('c1');
const COLLECTOR_2 = wallet('c2');
const FUNDING_1 = wallet('f1');
const STRANGER = wallet('5e');
const [K1, K2, K3, K4, K5, K6] = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map(wallet) as [string, string, string, string, string, string];
const [O1, O2, O3] = ['b1', 'b2', 'b3'].map(wallet) as [string, string, string];
const ROBO = 10n ** 18n;
const LONG_DASH = String.fromCharCode(0x2014);

interface RowOptions {
  funder?: string;
  missing?: FactName[];
  burst?: number;
  age?: number;
  txCount?: number;
}

function row(address: string, start: Start, opts: RowOptions = {}): ReplayRow {
  const missing = opts.missing ?? [];
  const facts: Facts = {
    walletAgeDays: opts.age ?? 12,
    txCountAtSnapshot: missing.includes('txCountAtSnapshot') ? null : (opts.txCount ?? 2),
    accountType: 'eoa',
    firstFunder:
      opts.funder === undefined ? null : { address: parseAddress(opts.funder), kind: 'wallet', fanoutInList: 3, hopsTraced: 1 },
    group: null,
    sharedDepositAddress: null,
    fundingBurst: opts.burst === undefined ? null : { wallets: opts.burst },
    claimPaidToOtherAddress: false,
    evidenceTxs: [],
    missing,
  };
  return { wallet: address, start, ceiling: start.outcome === 'full' ? 'full' : 'hold', facts };
}

// Family 1 has a known funding wallet; family 2 is collector-only, like Bitquery's rows 184, 185, 229 and 259.
const KEY = new Map<string, FarmKeyEntry>([
  [K1, { collector: COLLECTOR_1, family: 1, fundingWallet: FUNDING_1 }],
  [K2, { collector: COLLECTOR_1, family: 1, fundingWallet: FUNDING_1 }],
  [K3, { collector: COLLECTOR_1, family: 1, fundingWallet: FUNDING_1 }],
  [K4, { collector: COLLECTOR_2, family: 2, fundingWallet: null }],
  [K5, { collector: COLLECTOR_2, family: 2, fundingWallet: null }],
  [K6, { collector: COLLECTOR_2, family: 2, fundingWallet: null }],
]);

const ROWS: ReplayRow[] = [
  // Checksummed on purpose: the score must lowercase before it looks the wallet up in the key.
  row(parseAddress(K1), { outcome: 'hold', rule: 'A4' }, { funder: FUNDING_1 }),
  row(K2, { outcome: 'exclude', rule: 'A3' }, { funder: FUNDING_1 }),
  row(K3, { outcome: 'full', rule: 'A9' }, { funder: STRANGER }),
  row(K4, { outcome: 'hold', rule: 'A4' }, { funder: STRANGER }),
  row(K5, { outcome: 'hold', rule: 'A1' }, { missing: ['firstFunder', 'group'] }),
  // Traced to family 1's funding wallet, but family 2 names none, so this is not a root match.
  row(K6, { outcome: 'hold', rule: 'A5' }, { funder: FUNDING_1 }),
  row(O1, { outcome: 'full', rule: 'A9' }, { funder: STRANGER }),
  row(O2, { outcome: 'partial', rule: 'A8' }, { funder: STRANGER, missing: ['evidenceTxs'] }),
  row(O3, { outcome: 'hold', rule: 'A1' }, { missing: ['txCountAtSnapshot'] }),
];

const CLAIMED = new Map<string, bigint>([
  [K1, 1000n * ROBO],
  [K2, 2000n * ROBO],
  [K3, 4000n * ROBO],
  [K4, ROBO / 2n],
  [K5, 1n],
  [K6, 3n * ROBO],
  [O1, 7n * ROBO],
  [O2, 9n * ROBO],
  [O3, (5n * ROBO) / 4n],
]);

const NONE = { A1: 0, A2: 0, A3: 0, A4: 0, A5: 0, A6: 0, A7: 0, A8: 0, A9: 0 };

describe('scoreReplay', () => {
  it('counts recall, families, other holds, ROBO, root matches and data gaps for 6 key wallets and 3 others', () => {
    expect(scoreReplay(ROWS, KEY, CLAIMED, DEFAULT_SETTINGS)).toEqual({
      wallets: 9,
      byRule: { key: { ...NONE, A1: 1, A3: 1, A4: 2, A5: 1, A9: 1 }, other: { ...NONE, A1: 1, A8: 1, A9: 1 } },
      keyWallets: 6,
      keyHeld: 5,
      keyExcluded: 1,
      recall: 5 / 6,
      fundedWallets: 3,
      fundedHeld: 2,
      fundedExcluded: 1,
      fundedRecall: 2 / 3,
      keyNotScreened: 0,
      families: 2,
      familiesTouched: 2,
      familiesFullyHeld: 1,
      otherWallets: 3,
      otherHeld: 1,
      otherHoldRate: 1 / 3,
      otherPartial: 1,
      otherFull: 1,
      robo: { heldKey: '3003.500000000000000001', allKey: '7003.500000000000000001', heldOther: '1.25' },
      rootMatches: 2,
      dataGaps: {
        a1: 2,
        missing: {
          walletAgeDays: 0,
          txCountAtSnapshot: 1,
          accountType: 0,
          firstFunder: 1,
          group: 1,
          sharedDepositAddress: 0,
          claimPaidToOtherAddress: 0,
          evidenceTxs: 1,
        },
      },
      burst: { minWallets: 20, spreadBps: 2500, key: 0, other: 0, burstOnly: 0 },
    });
  });

  it('counts burst wallets on each side, and in burstOnly only those the burst alone put on A8', () => {
    const partial = { outcome: 'partial', rule: 'A8' } as const;
    const rows = [
      row(K1, partial, { burst: 20, age: 400, txCount: 120 }),
      // Exactly at both minimums, so age and activity did not put it on A8 either.
      row(O1, partial, { burst: 20, age: DEFAULT_SETTINGS.minWalletAgeDays, txCount: DEFAULT_SETTINGS.minTxCount }),
      row(K2, partial, { burst: 20, age: DEFAULT_SETTINGS.minWalletAgeDays - 1, txCount: 120 }),
      row(O2, partial, { burst: 20, age: 400, txCount: DEFAULT_SETTINGS.minTxCount - 1 }),
      row(O3, { outcome: 'hold', rule: 'A4' }, { burst: 20, age: 400, txCount: 120 }),
      row(K3, partial, { age: 400, txCount: 120 }),
    ];
    expect(scoreReplay(rows, KEY, CLAIMED, DEFAULT_SETTINGS).burst).toEqual({
      minWallets: 20,
      spreadBps: 2500,
      key: 2,
      other: 3,
      burstOnly: 2,
    });
  });

  it('counts key wallets a short run did not reach, and gives null ratios when nothing was there to divide', () => {
    const short = scoreReplay(ROWS.slice(0, 2), KEY, CLAIMED, DEFAULT_SETTINGS);
    expect(short).toMatchObject({ keyWallets: 2, keyNotScreened: 4, families: 1, otherWallets: 0, otherHoldRate: null });
    expect(scoreReplay([], KEY, CLAIMED, DEFAULT_SETTINGS)).toMatchObject({ recall: null, fundedRecall: null, keyNotScreened: 6 });
  });

  it('refuses two rows for one wallet in different spellings', () => {
    const second = ROWS[1] as ReplayRow;
    const shouted = { ...second, wallet: `0x${second.wallet.slice(2).toUpperCase()}` };
    expect(() => scoreReplay([second, shouted], KEY, CLAIMED, DEFAULT_SETTINGS)).toThrow(RangeError);
  });
});

describe('scoreToMarkdown', () => {
  const markdown = scoreToMarkdown(scoreReplay(ROWS, KEY, CLAIMED, DEFAULT_SETTINGS), {
    snapshotBlock: 24_546_232,
    snapshotTime: '2026-02-27T05:39:47.000Z',
    runDate: '2026-11-03',
  });

  it('opens with what it measures and the honesty sentence, and names the block the data stops before', () => {
    const opening = markdown.slice(0, markdown.indexOf('## '));
    expect(opening).toContain('What this measures');
    expect(opening).toContain('found wallets later shown to move together');
    expect(opening).toContain('July to August 2026 sweep that a screener at claim time could not see');
    expect(opening).toContain('only chain data before block 24,546,233');
    expect(markdown).toContain('Held: 5 (83.3%), of which excluded: 1');
    expect(markdown).toContain('ROBO claimed by held key wallets: 3,003.5 ROBO');
    expect(markdown).toContain('Cut to partial: 1 (33.3%)');
    expect(markdown).toContain('Paid in full: 1 (33.3%)');
    expect(markdown).toContain('| A4 | a group of wallets that move together, so hold | 2 | 0 |');
  });

  it('prints the funding burst section right before Funding roots, with the thresholds it was given', () => {
    const rows = [
      row(K1, { outcome: 'partial', rule: 'A8' }, { burst: 30, age: 400, txCount: 120 }),
      row(O1, { outcome: 'hold', rule: 'A4' }, { burst: 30 }),
    ];
    const settings = { ...DEFAULT_SETTINGS, burstMinWallets: 30, burstSpreadBps: 1250 };
    const report = scoreToMarkdown(scoreReplay(rows, KEY, CLAIMED, settings), {
      snapshotBlock: 24_546_232,
      snapshotTime: '2026-02-27T05:39:47.000Z',
      runDate: '2026-11-03',
    });
    expect(report.slice(report.indexOf('## Funding bursts'), report.indexOf('## Funding roots'))).toBe(
      [
        '## Funding bursts',
        '',
        'Added after the held-out score was frozen, with thresholds set by reading this same data, so this part is not held out. It moves wallets from full to partial and changes no hold.',
        'A burst is at least 30 wallets first funded by one exchange on one UTC day in amounts within 12.5% of each other.',
        'It is a pattern, not proof of one owner, so it can cut a wallet to partial and can never hold or exclude it.',
        '',
        'Wallets in a burst: 2 (key wallets: 1, other wallets: 1)',
        'Cut to partial by the burst alone: 1',
        '',
        '',
      ].join('\n'),
    );
  });

  it('gives A8 its burst meaning', () => {
    expect(markdown).toContain('| A8 | newer, quieter or funded in a burst, so partial (hold when partial is off) | 0 | 1 |');
  });

  it('closes with the Not covered list and has no long dash', () => {
    const lastSection = markdown.slice(markdown.lastIndexOf('## '));
    expect(lastSection.startsWith('## Not covered')).toBe(true);
    for (const line of [
      'The model is not in the loop here',
      'upper bound on false holds',
      "Transfers past a wallet's first 100 are not read",
      'Only native ETH funding is traced, not tokens',
      'A funding burst is a pattern, so real users funded in one are cut to partial too.',
      'The burst thresholds still need the Hop check.',
      'A shared address counts as private when at least half the senders in its oldest 100 transfers are on the list, so a new public address used first by list wallets can still link them.',
    ]) {
      expect(lastSection).toContain(line);
    }
    expect(markdown).not.toContain(LONG_DASH);
  });
});

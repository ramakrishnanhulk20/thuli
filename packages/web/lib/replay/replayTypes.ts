import type { OutcomeName, WebSummary } from './types';

/** summary.run gains a rulebook number when the export is rebuilt; until then it is absent. */
export interface ReplaySummary extends Omit<WebSummary, 'run'> {
  run: WebSummary['run'] & { rulebook?: number };
}

export type OutcomeCode = 0 | 1 | 2 | 3;

export interface OutcomeStyle {
  code: OutcomeCode;
  name: OutcomeName;
  /** The one word the family list and the member rows use. */
  word: string;
  /** The sentence the legend and the wallet banner use. */
  label: string;
  /** The same sentence as it reads after a count. */
  afterCount: string;
  /** The design token the colour comes from. */
  token: string;
}

export const OUTCOME_STYLES: readonly [OutcomeStyle, OutcomeStyle, OutcomeStyle, OutcomeStyle] = [
  { code: 0, name: 'full', word: 'full', label: 'Paid in full', afterCount: 'paid in full', token: '--color-full' },
  { code: 1, name: 'partial', word: 'partial', label: 'Cut to a partial reward', afterCount: 'cut to a partial reward', token: '--color-partial' },
  { code: 2, name: 'hold', word: 'held', label: 'Held for review', afterCount: 'held for review', token: '--color-hold' },
  { code: 3, name: 'exclude', word: 'excluded', label: 'Excluded', afterCount: 'excluded', token: '--color-exclude' },
];

export interface WalletFacts {
  ageDays: number | null;
  txCount: number | null;
  accountType: string;
  funder: { address: string; kind: string; fanout: number | null; hops: number } | null;
  burstWallets: number | null;
  sameFunderWithinWindow: number | null;
  sweptToSharedCollector: boolean | null;
  missing: string[];
}

export interface WalletDetail {
  /** Index of this wallet in points.json. */
  i: number;
  outcome: OutcomeCode;
  shareBps: number;
  rule: string;
  reason: string;
  txs: string[];
  robo: number;
  /** Index into summary.groups, or -1 when the wallet is in no linked family. */
  group: number;
  start: { outcome: string; rule: string };
  facts: WalletFacts;
  serv: { mode: 'v3' | 'v2'; requestId: string | null; accepted: boolean; secondAsk: boolean };
}

export interface WalletShard {
  schema: 1;
  wallets: Record<string, WalletDetail>;
}

export interface GroupMember {
  address: string;
  outcome: OutcomeCode;
  rule: string;
  robo: number;
  reason: string;
  txs: string[];
}

export interface GroupFile {
  schema: 1;
  index: number;
  size: number;
  held: number;
  robo: number;
  members: GroupMember[];
}

/** What a loader returns while it works, when it is done, and when it failed. */
export type Loaded<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error' };

export type SearchError = 'format' | 'absent' | 'load' | null;

export type Selection = { family: number } | { wallet: string } | null;

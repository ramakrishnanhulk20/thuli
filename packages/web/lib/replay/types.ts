// Mirrors the two files the replay export writes. JSON imports widen literal values, so schema is a plain number.

export type OutcomeName = 'full' | 'partial' | 'hold' | 'exclude';

/** One entry per claim wallet. Index i in every list is the same wallet. */
export interface WebPoints {
  schema: number;
  count: number;
  /** 0 full, 1 partial, 2 hold, 3 exclude. */
  outcome: number[];
  /** Index into WebSummary.groups, or -1 when the wallet is linked to no other claim wallet. */
  group: number[];
  /** Whole ROBO the wallet claimed. */
  robo: number[];
  /** 1 when the wallet was first funded in a burst, else 0. */
  burst: number[];
}

export interface WebGroup {
  size: number;
  held: number;
  robo: number;
}

export interface WebSummary {
  schema: number;
  drop: { name: string; chain: string; claimContract: string; usdPerRobo: number };
  run: { date: string; rulebook: number; rowsSha256: string; decisionsSha256: string; spentCents: number; centsPerWallet: number };
  wallets: number;
  claims: number;
  outcomes: { key: Record<OutcomeName, number>; other: Record<OutcomeName, number> };
  farmKey: {
    wallets: number;
    held: number;
    families: { total: number; touched: number; fullyHeld: number };
    shareOfDropBps: number;
  };
  robo: { claimedKey: string; keptKey: string; claimedOther: string; keptOther: string };
  usd: { claimedKey: number; keptKey: number; claimedOther: number; keptOther: number };
  answers: { accepted: number; firstRefused: number; fixedBySecondAsk: number; stillRefused: number };
  modes: { v3: number; v2: number };
  /** Largest first. */
  groups: WebGroup[];
}

export interface WalletFunder {
  address: string;
  kind: string;
  /** Claim wallets this funder paid, itself included in the count. */
  fanout: number;
  /** Wallets between the funder and this wallet, each used once. */
  hops: number;
}

export interface WalletFacts {
  ageDays: number;
  txCount: number;
  accountType: string;
  funder: WalletFunder | null;
  burstWallets: number | null;
  sameFunderWithinWindow: number | null;
  sweptToSharedCollector: boolean | null;
  missing: string[];
}

/** One wallet's entry in robo/wallets/<first two hex characters>.json. */
export interface WalletDetail {
  i: number;
  /** 0 full, 1 partial, 2 hold, 3 exclude. */
  outcome: number;
  shareBps: number;
  rule: string;
  reason: string;
  txs: string[];
  robo: number;
  group: number;
  start: { outcome: string; rule: string };
  facts: WalletFacts;
  serv: { mode: string; requestId: string; accepted: boolean; secondAsk: boolean };
}

export interface WalletShard {
  schema: number;
  wallets: Record<string, WalletDetail>;
}

export interface FamilyMember {
  address: string;
  outcome: number;
  rule: string;
  robo: number;
  reason: string;
  txs: string[];
}

/** robo/groups/<index>.json */
export interface FamilyFile {
  schema: number;
  index: number;
  size: number;
  held: number;
  robo: number;
  members: FamilyMember[];
}

export interface Rate {
  held: number;
  wallets: number;
  rate: number;
}

export interface RateWithRange extends Rate {
  low: number;
  high: number;
}

export interface VersionScore {
  name: string;
  catchRate: Rate;
  falseHold: RateWithRange;
  feedback: { right: number; total: number };
}

export interface Verdict {
  group: string;
  storedAction: string;
  score: number;
  route: string;
  confidence: string;
  v1Action: string;
  v2Action: string;
}

export interface VersionsFile {
  runDate: string;
  v1: VersionScore;
  v2: VersionScore;
  eliminatedHeld: { v1: Rate; v2: Rate };
  verdicts: Verdict[];
  routes: { ship: number; review: number; block: number; unread: number };
  appeals: { campaignId: string; status: string; appealedAction: string; newAction: string; testWallet: boolean }[];
  testWalletAppeals: number;
  noReply: { robo: number; hopSample: number; hopEliminated: number };
}

export interface HopBucket {
  screened: number;
  noHistory: number;
  counted: number;
  held: number;
  heldLow: number;
  heldHigh: number;
  excluded: number;
  partial: number;
  full: number;
}

/** hop.json: the control group the farm list is checked against. */
export interface HopFile {
  schema: number;
  runDate: string;
  probablyReal: HopBucket;
  eliminated: HopBucket;
  clusters: { total: number; touched: number; fullyHeld: number; uncounted: number };
}

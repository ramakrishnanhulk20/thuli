import type { WebSummary } from './types';

export interface HeroFacts {
  /** Whole percent of the drop the farm wallets claimed. */
  sharePct: number;
  /** Wallets that ended hold or exclude, farm list and control group together. */
  heldTotal: number;
  /** Whole dollars kept from farm wallets, at the claim-day price. */
  keptUsd: number;
  priceText: string;
}

export function heroFacts(summary: WebSummary): HeroFacts {
  const { key, other } = summary.outcomes;
  return {
    sharePct: Math.round(summary.farmKey.shareOfDropBps / 100),
    heldTotal: key.hold + key.exclude + other.hold + other.exclude,
    keptUsd: summary.usd.keptKey,
    priceText: `$${summary.drop.usdPerRobo.toFixed(4)}`,
  };
}

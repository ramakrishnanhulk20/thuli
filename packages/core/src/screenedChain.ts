/** The chains a campaign ask can be screened on. */
export const SCREENED_CHAINS = ['ethereum', 'base'] as const;

export type ScreenedChain = (typeof SCREENED_CHAINS)[number];

/** True only for one of SCREENED_CHAINS, compared exactly, so a stored or sent value is never guessed at. */
export function isScreenedChain(value: unknown): value is ScreenedChain {
  return typeof value === 'string' && (SCREENED_CHAINS as readonly string[]).includes(value);
}

/**
 * The chain whose first activity time (firstActivityTime, in seconds) is smaller: the chain an ask is screened on.
 * When only one chain has activity, that one; when neither has, null. An exact tie is 'ethereum'.
 *
 * @throws RangeError when a time is neither null nor a finite number of 0 or more, so a bad read never picks a chain.
 */
export function olderChain(first: Readonly<Record<ScreenedChain, number | null>>): ScreenedChain | null {
  for (const chain of SCREENED_CHAINS) {
    const time = first[chain];
    if (time !== null && !(typeof time === 'number' && Number.isFinite(time) && time >= 0)) {
      throw new RangeError(`the first activity time on ${chain} must be null or a finite number of 0 or more`);
    }
  }
  const { ethereum, base } = first;
  if (ethereum === null) return base === null ? null : 'base';
  if (base === null) return 'ethereum';
  return base < ethereum ? 'base' : 'ethereum';
}

/** Each screened chain's name as a page or a message shows it. */
export const SCREENED_CHAIN_NAME: Readonly<Record<ScreenedChain, string>> = Object.freeze({ ethereum: 'Ethereum', base: 'Base' });

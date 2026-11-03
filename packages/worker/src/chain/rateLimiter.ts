/** How long to wait before each retry of a call a source turned away for load: five retries, then give up. */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spaces calls to one data source evenly, one every 1000 / perSecond milliseconds, so no one-second window ever holds
 * more than perSecond calls. Every caller of one source must share one instance, or the source sees their sum.
 *
 * Slots are booked when take() is called, not when it resolves, so callers running in parallel queue up in call order
 * instead of all waking at once. The clock is performance.now(), which never runs backwards when the wall clock is set.
 */
export class RateLimiter {
  readonly #intervalMs: number;
  #nextSlot = 0;

  /** @throws RangeError when perSecond is not a positive finite number. */
  constructor(perSecond: number) {
    if (!Number.isFinite(perSecond) || perSecond <= 0) throw new RangeError('perSecond must be a positive number');
    this.#intervalMs = 1000 / perSecond;
  }

  /** Resolves when the caller may make its next call. */
  async take(): Promise<void> {
    const now = performance.now();
    const slot = Math.max(now, this.#nextSlot);
    this.#nextSlot = slot + this.#intervalMs;
    const wait = slot - now;
    if (wait > 0) await pause(wait);
  }
}

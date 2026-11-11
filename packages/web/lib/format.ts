const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatInt(n: number): string {
  return whole.format(Math.round(n));
}

export function formatUsd(n: number): string {
  return `$${formatInt(n)}`;
}

/** Computed from the two counts, so a stored rate in a different scale cannot change the text. */
export function formatPercent(part: number, whole: number, digits: number): string {
  if (!(whole > 0)) throw new RangeError('formatPercent needs a whole above zero');
  return `${((part / whole) * 100).toFixed(digits)}%`;
}

const dollarsAndCents = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatUsdCents(cents: number): string {
  return `$${dollarsAndCents.format(cents / 100)}`;
}

/** A fraction of one, such as an interval bound, written as a percent. */
export function formatFraction(fraction: number, digits: number): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

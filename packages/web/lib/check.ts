/** What the free check page needs that is not drawing: the request, the guard on the answer, and a few texts. */

const INPUT_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ROUTE_PATTERN = /^0x[0-9a-f]{40}$/;

export const POLL_MILLISECONDS = 5000;
export const MAX_PENDING_ANSWERS = 36;

/** True for what a visitor may type: 0x and 40 hex characters in any case. */
export function isWalletInput(value: string): boolean {
  return INPUT_PATTERN.test(value);
}

/**
 * The lowercase address a route segment names, or null when it is not an address. A segment that cannot be decoded
 * is not an address either.
 */
export function addressFromRoute(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  const lower = decoded.toLowerCase();
  return ROUTE_PATTERN.test(lower) ? lower : null;
}

export type Action = 'full' | 'partial' | 'hold' | 'exclude';

const ACTIONS: readonly string[] = ['full', 'partial', 'hold', 'exclude'];

export interface FreeCheck {
  wallet: string;
  checkedAt: string;
  scope: string;
  rulebook: string;
  decision: { action: Action; shareBps: number; rule: string; reason: string; citedTxs: string[] };
  servRequestId: string | null;
  notChecked: string[];
  cached: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Checks an answer has every field the page reads, with the right kind of value. Unknown extra fields are ignored. */
export function isFreeCheck(body: unknown): body is FreeCheck {
  if (!isRecord(body)) return false;
  const { decision } = body;
  if (!isRecord(decision)) return false;
  return (
    typeof body.wallet === 'string' &&
    typeof body.checkedAt === 'string' &&
    !Number.isNaN(Date.parse(body.checkedAt)) &&
    typeof body.scope === 'string' &&
    typeof body.rulebook === 'string' &&
    typeof decision.action === 'string' &&
    ACTIONS.includes(decision.action) &&
    typeof decision.shareBps === 'number' &&
    Number.isFinite(decision.shareBps) &&
    typeof decision.rule === 'string' &&
    typeof decision.reason === 'string' &&
    isStrings(decision.citedTxs) &&
    (body.servRequestId === null || typeof body.servRequestId === 'string') &&
    isStrings(body.notChecked) &&
    typeof body.cached === 'boolean'
  );
}

/** How a request ended: a result, or the reason there is none. */
export type CheckOutcome =
  | { kind: 'result'; body: FreeCheck }
  | { kind: 'pending' }
  | { kind: 'limit' }
  | { kind: 'busy' }
  | { kind: 'bad' }
  | { kind: 'unreachable' };

/** Maps a status and a parsed body to the state the page shows. Anything the page does not expect is unreachable. */
export function classify(status: number, body: unknown): CheckOutcome {
  if (status === 200) return isFreeCheck(body) ? { kind: 'result', body } : { kind: 'unreachable' };
  if (status === 202) return isRecord(body) && body.pending === true ? { kind: 'pending' } : { kind: 'unreachable' };
  if (status === 429) return { kind: 'limit' };
  if (status === 503) return { kind: 'busy' };
  if (status === 400) return { kind: 'bad' };
  return { kind: 'unreachable' };
}

/** Asks the free check about one wallet. A failed request or an unreadable body never throws. */
export async function requestCheck(wallet: string): Promise<CheckOutcome> {
  try {
    const response = await fetch('/api/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet }),
      cache: 'no-store',
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return classify(response.status, body);
  } catch {
    return { kind: 'unreachable' };
  }
}

const NOT_CHECKED_TEXT = new Map<string, string>([
  ['group', 'Linked group on a claim list'],
  ['sharedDepositAddress', 'Shared exchange deposit address'],
  ['fundingBurst', 'Same-day funding burst'],
  ['claimPaidToOtherAddress', 'Claim paid to another address'],
]);

/** The plain line for something the check did not measure. A name the table does not know is shown as it is. */
export function notCheckedText(name: string): string {
  return NOT_CHECKED_TEXT.get(name) ?? name;
}

export const OUTCOME_WORDS: Record<Action, string> = {
  full: 'Paid in full',
  partial: 'Cut to a partial reward',
  hold: 'Held for review',
  exclude: 'Excluded',
};

/** "just now", "12 minutes ago", "3 hours ago". A time in the future reads as just now. */
export function relativeTime(checkedAt: string, now: number): string {
  const seconds = Math.floor((now - Date.parse(checkedAt)) / 1000);
  if (!(seconds >= 60)) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

import { formatUnits } from 'viem';
import { askBody } from './ask';
import { notCheckedText } from './check';
import { formatInt } from './format';

// The campaign routes' answers, as ARCHITECTURE.md 4.9 describes them. The guards below check the fields the page reads;
// the real contract is packages/api/src/schema.ts, which the unit test holds every fixture to.

export type Action = 'full' | 'partial' | 'hold' | 'exclude';
export type AskStatus = 'queued' | 'screening' | 'decided' | 'failed';
export type ListStatus = 'built' | 'sending' | 'posted' | 'active' | 'superseded' | 'cancelled';

export interface ListVersion {
  version: number;
  root: string;
  status: ListStatus;
  postTx: string | null;
  /** Unix seconds. */
  claimableAt: number | null;
}

export interface CampaignView {
  name: string;
  chain: number;
  vault: string;
  token: string;
  rewardPerWallet: string;
  perWalletCap: string;
  maxSlots: number;
  status: 'open' | 'closed';
  opensAt: string;
  closesAt: string;
  counts: { asked: number; queued: number; decided: number; held: number; slotsTaken: number; slotsLeft: number; asksLeft: number };
  lists: ListVersion[];
}

export interface AskFacts {
  ageDays: number | null;
  txCount: number | null;
  accountType: string;
  funder: { address: string; kind: string; fanout: number | null; hops: number } | null;
  burstWallets: number | null;
  groupSize: number | null;
  missing: string[];
}

export interface AskJson {
  campaignId: string;
  wallet: string;
  askedAt: string;
  status: AskStatus;
  action: Action | null;
  shareBps: number | null;
  rule: string | null;
  reason: string | null;
  citedTxs: string[] | null;
  notChecked: string[] | null;
  facts: AskFacts | null;
  servRequestId: string | null;
  decidedAt: string | null;
  slot: number | null;
}

export interface Ticket {
  cumulativeAmount: string;
  proof: string[];
  root: string;
  claimed?: string;
  claimable?: string;
}

export interface AskView {
  ask: AskJson;
  ticket?: Ticket;
}

const ACTIONS: readonly string[] = ['full', 'partial', 'hold', 'exclude'];
const ASK_STATUSES: readonly string[] = ['queued', 'screening', 'decided', 'failed'];
const LIST_STATUSES: readonly string[] = ['built', 'sending', 'posted', 'active', 'superseded', 'cancelled'];
const AMOUNT = /^[0-9]+$/;
const HASH = /^0x[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isAmount = (value: unknown): value is string => isText(value) && AMOUNT.test(value);
const isTime = (value: unknown): value is string => isText(value) && !Number.isNaN(Date.parse(value));
const orNull = <T>(value: unknown, is: (item: unknown) => item is T): boolean => value === null || is(value);
const isTexts = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);

function isListVersion(value: unknown): value is ListVersion {
  return (
    isRecord(value) &&
    isCount(value.version) &&
    isText(value.root) &&
    HASH.test(value.root) &&
    isText(value.status) &&
    LIST_STATUSES.includes(value.status) &&
    orNull(value.postTx, (item): item is string => isText(item) && HASH.test(item)) &&
    orNull(value.claimableAt, isCount)
  );
}

export function isCampaignView(value: unknown): value is CampaignView {
  if (!isRecord(value) || !isRecord(value.counts)) return false;
  const { counts } = value;
  return (
    isText(value.name) &&
    value.name !== '' &&
    isCount(value.chain) &&
    isText(value.vault) &&
    isText(value.token) &&
    isAmount(value.rewardPerWallet) &&
    isAmount(value.perWalletCap) &&
    isCount(value.maxSlots) &&
    (value.status === 'open' || value.status === 'closed') &&
    isTime(value.opensAt) &&
    isTime(value.closesAt) &&
    ['asked', 'queued', 'decided', 'held', 'slotsTaken', 'slotsLeft', 'asksLeft'].every((key) => isCount(counts[key])) &&
    Array.isArray(value.lists) &&
    value.lists.every(isListVersion)
  );
}

function isFacts(value: unknown): value is AskFacts {
  if (!isRecord(value)) return false;
  const funder = value.funder;
  return (
    orNull(value.ageDays, isCount) &&
    orNull(value.txCount, isCount) &&
    isText(value.accountType) &&
    (funder === null ||
      (isRecord(funder) && isText(funder.address) && isText(funder.kind) && orNull(funder.fanout, isCount) && isCount(funder.hops))) &&
    orNull(value.burstWallets, isCount) &&
    orNull(value.groupSize, isCount) &&
    isTexts(value.missing)
  );
}

export function isAskJson(value: unknown): value is AskJson {
  return (
    isRecord(value) &&
    isText(value.campaignId) &&
    isText(value.wallet) &&
    isTime(value.askedAt) &&
    isText(value.status) &&
    ASK_STATUSES.includes(value.status) &&
    (value.action === null || (isText(value.action) && ACTIONS.includes(value.action))) &&
    orNull(value.shareBps, isCount) &&
    orNull(value.rule, isText) &&
    orNull(value.reason, isText) &&
    (value.citedTxs === null || isTexts(value.citedTxs)) &&
    (value.notChecked === null || isTexts(value.notChecked)) &&
    (value.facts === null || isFacts(value.facts)) &&
    orNull(value.servRequestId, isText) &&
    orNull(value.decidedAt, isTime) &&
    orNull(value.slot, isCount)
  );
}

function isTicket(value: unknown): value is Ticket {
  return (
    isRecord(value) &&
    isAmount(value.cumulativeAmount) &&
    Array.isArray(value.proof) &&
    value.proof.every(isText) &&
    isText(value.root) &&
    (value.claimed === undefined || isAmount(value.claimed)) &&
    (value.claimable === undefined || isAmount(value.claimable))
  );
}

export function isAskView(value: unknown): value is AskView {
  return isRecord(value) && isAskJson(value.ask) && (value.ticket === undefined || isTicket(value.ticket));
}

export function isBoardPage(value: unknown): value is { asks: AskJson[] } {
  return isRecord(value) && Array.isArray(value.asks) && value.asks.every(isAskJson);
}

// ---------------------------------------------------------------- requests

export type Fetcher = typeof fetch;

const root = (id: string) => `/api/campaigns/${encodeURIComponent(id)}`;

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export type CampaignRead = { kind: 'found'; campaign: CampaignView } | { kind: 'busy' } | { kind: 'none' };

/**
 * The campaign. A 429 reads as busy, so the page can keep what it shows and slow down. A 404, any other answer, a body
 * that is not a campaign and a failed request all read as none.
 */
export async function fetchCampaign(id: string, request: Fetcher = fetch): Promise<CampaignRead> {
  try {
    const response = await request(root(id), { cache: 'no-store' });
    if (response.status === 429) return { kind: 'busy' };
    if (response.status !== 200) return { kind: 'none' };
    const body = await readJson(response);
    return isCampaignView(body) ? { kind: 'found', campaign: body } : { kind: 'none' };
  } catch {
    return { kind: 'none' };
  }
}

export type AskLookup = { kind: 'found'; view: AskView } | { kind: 'none' } | { kind: 'busy' } | { kind: 'error' };

/** What the campaign holds for one wallet. A 404 means the wallet has not asked; anything unexpected is an error. */
export async function fetchAsk(id: string, wallet: string, request: Fetcher = fetch): Promise<AskLookup> {
  try {
    const response = await request(`${root(id)}/asks/${encodeURIComponent(wallet)}`, { cache: 'no-store' });
    if (response.status === 404) return { kind: 'none' };
    if (response.status === 429) return { kind: 'busy' };
    if (response.status !== 200) return { kind: 'error' };
    const body = await readJson(response);
    return isAskView(body) ? { kind: 'found', view: body } : { kind: 'error' };
  } catch {
    return { kind: 'error' };
  }
}

export type AskPost =
  | { kind: 'queued' }
  | { kind: 'exists'; ask: AskJson }
  | { kind: 'closed' }
  | { kind: 'full' }
  | { kind: 'limit' }
  /** The day's ceiling across every campaign: only that answer carries Retry-After, which is kept as it came. */
  | { kind: 'ceiling'; retryAfter: string }
  | { kind: 'bad'; cause: string }
  | { kind: 'gone' }
  | { kind: 'unreachable' };

/** Maps a status, a parsed body and the Retry-After header from the ask route to what the page shows. */
export function classifyAskAnswer(status: number, body: unknown, retryAfter: string | null = null): AskPost {
  if (status === 202) return isRecord(body) && body.queued === true ? { kind: 'queued' } : { kind: 'unreachable' };
  if (status === 200) return isRecord(body) && body.exists === true && isAskJson(body.ask) ? { kind: 'exists', ask: body.ask } : { kind: 'unreachable' };
  if (status === 404) return { kind: 'gone' };
  if (status === 409) return isRecord(body) && body.full === true ? { kind: 'full' } : { kind: 'closed' };
  if (status === 429) return retryAfter === null ? { kind: 'limit' } : { kind: 'ceiling', retryAfter };
  if ((status === 400 || status === 413) && isRecord(body) && isText(body.error) && body.error !== '') return { kind: 'bad', cause: body.error };
  return { kind: 'unreachable' };
}

export async function postAsk(
  id: string,
  signed: { wallet: string; signedAt: number; signature: string },
  request: Fetcher = fetch,
): Promise<AskPost> {
  try {
    const response = await request(`${root(id)}/asks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: askBody(signed),
      cache: 'no-store',
    });
    return classifyAskAnswer(response.status, await readJson(response), response.headers.get('retry-after'));
  } catch {
    return { kind: 'unreachable' };
  }
}

export const BOARD_PAGE_SIZE = 50;

export type BoardRead = { kind: 'page'; asks: AskJson[] } | { kind: 'busy' } | { kind: 'failed' };

/** One page of the board, newest decision first; busy for a 429, failed when it could not be read. */
export async function fetchBoard(id: string, before: string | null, request: Fetcher = fetch): Promise<BoardRead> {
  try {
    const query = before === null ? '' : `?before=${encodeURIComponent(before)}`;
    const response = await request(`${root(id)}/board${query}`, { cache: 'no-store' });
    if (response.status === 429) return { kind: 'busy' };
    if (response.status !== 200) return { kind: 'failed' };
    const body = await readJson(response);
    return isBoardPage(body) ? { kind: 'page', asks: body.asks } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

/** Newer rows in front, every wallet once: a refreshed page replaces the rows it repeats and keeps the older ones. */
export function mergeBoard(current: readonly AskJson[], fresh: readonly AskJson[]): AskJson[] {
  const byWallet = new Map<string, AskJson>();
  for (const row of [...current, ...fresh]) byWallet.set(row.wallet.toLowerCase(), row);
  const time = (row: AskJson) => Date.parse(row.decidedAt ?? row.askedAt);
  return [...byWallet.values()].sort((a, b) => time(b) - time(a));
}

// ---------------------------------------------------------------- what the page says

const CHAIN_NAMES = new Map<number, string>([
  [84532, 'Base Sepolia'],
  [8453, 'Base'],
]);

export function chainName(chain: number): string {
  return CHAIN_NAMES.get(chain) ?? `chain ${chain}`;
}

export const LIST_STATUS_WORDS: Record<ListStatus, string> = {
  built: 'built',
  sending: 'sent, waiting for the network',
  posted: 'posted, waiting',
  active: 'paying',
  superseded: 'replaced',
  cancelled: 'cancelled',
};

/** USDC base units (6 decimals) as plain text: "1" for 1000000, "2.5" for 2500000. */
export function usdc(units: string | bigint): string {
  return formatUnits(BigInt(units), 6);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** A moment in UTC to the minute, such as "15 Nov 2026, 23:59 UTC". */
export function formatUtcMinute(milliseconds: number): string {
  const time = new Date(milliseconds);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${time.getUTCDate()} ${MONTHS[time.getUTCMonth()]} ${time.getUTCFullYear()}, ${pad(time.getUTCHours())}:${pad(time.getUTCMinutes())} UTC`;
}

/** Whether new asks are taken at this moment: the campaign is open and now is within its window. */
export function isAcceptingAsks(campaign: CampaignView, now: number): boolean {
  return campaign.status === 'open' && now >= Date.parse(campaign.opensAt) && now < Date.parse(campaign.closesAt);
}

export function statusLine(campaign: CampaignView): string {
  return campaign.status === 'open' ? `Open until ${formatUtcMinute(Date.parse(campaign.closesAt))}` : 'Closed';
}

/** The USDC an approved wallet's share comes to: the reward times its share in basis points, rounded down. */
export function walletAmount(reward: string, shareBps: number): bigint {
  return (BigInt(reward) * BigInt(shareBps)) / 10_000n;
}

// ---------------------------------------------------------------- the ask panel

export type Notice = 'declined' | 'closed' | 'limit' | 'bad' | 'unreachable';

export const NOTICE_TEXT: Record<Exclude<Notice, 'bad' | 'unreachable'>, string> = {
  declined: 'You declined to sign. Nothing was sent.',
  closed: 'This campaign is closed.',
  limit: 'Too many asks from this connection in the last hour. Try again later.',
};

export const UNREACHABLE_TEXT = 'The campaign could not be reached. Nothing was sent.';

export type Panel = 'connect' | 'checking' | 'ready' | 'signing' | 'screening' | 'decided' | 'refused' | 'unreachable';

export interface PanelInput {
  connected: boolean;
  /** The wallet's ask, when the campaign has one. */
  ask: AskJson | null;
  /** Whether the lookup of the wallet's ask is still running. */
  looking: boolean;
  signing: boolean;
  /** The ask was accepted by the route, and the lookup has not yet returned it. */
  sent: boolean;
  /** The route refused the ask, or the wallet answered in a way that cannot be sent: a refusal is showing. */
  refused: boolean;
  /** The lookup failed, or the last request could not be made. */
  unreachable: boolean;
}

/** Which of the panel's states shows: the order of the checks is the order the visitor moves through them. */
export function choosePanel(input: PanelInput): Panel {
  if (!input.connected) return 'connect';
  if (input.ask !== null) return input.ask.status === 'queued' || input.ask.status === 'screening' ? 'screening' : 'decided';
  if (input.signing) return 'signing';
  if (input.sent) return 'screening';
  if (input.refused) return 'refused';
  if (input.unreachable) return 'unreachable';
  if (input.looking) return 'checking';
  return 'ready';
}

export type ReadyVariant = 'open' | 'closed' | 'full' | 'stopped';

/**
 * What the ready state offers: the sign button, or no button when the campaign is closed, has no slot left, or has taken
 * every request it will take. Slots are checked first, so a campaign with neither left says its slots are gone.
 */
export function readyVariant(campaign: CampaignView, now: number): ReadyVariant {
  if (!isAcceptingAsks(campaign, now)) return 'closed';
  if (campaign.counts.slotsLeft === 0) return 'full';
  return campaign.counts.asksLeft === 0 ? 'stopped' : 'open';
}

export const READY_TEXT = {
  closed: 'This campaign is closed.',
  full: 'Every slot is taken. You can still ask, and Thuli will still decide, but no reward is left.',
} as const;

export type RefusalKind = 'stopped' | 'full' | 'ceiling' | 'contract';

/**
 * The wait to tell a visitor when the day's ceiling is used, from the seconds in Retry-After: whole hours from one hour
 * up, five-minute steps below it. A header that is missing, not a whole positive number, or an HTTP date reads as no
 * usable header, because the route only ever sends seconds.
 */
export function ceilingWords(retryAfter: string | null): string {
  const text = retryAfter === null ? '' : retryAfter.trim();
  const seconds = /^\d+$/.test(text) ? Number(text) : 0;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return 'Try again tomorrow.';
  if (seconds < 3600) return `Try again in about ${Math.ceil(Math.ceil(seconds / 60) / 5) * 5} minutes.`;
  const hours = Math.ceil(seconds / 3600);
  return hours === 1 ? 'Try again in about 1 hour.' : `Try again in about ${hours} hours.`;
}

/** The heading and body of a refusal that stands in place of the ask. Only the day's ceiling needs Retry-After. */
export function refusalWords(kind: RefusalKind, retryAfter: string | null = null): { heading: string; body: string } {
  switch (kind) {
    case 'stopped':
      return { heading: 'This campaign has stopped taking requests', body: 'It has screened as many wallets as it set out to. No new request can be sent.' };
    case 'full':
      return { heading: 'This campaign is full', body: 'Your request was not taken, and nothing was spent. Signing a message costs nothing.' };
    case 'ceiling':
      return { heading: 'Thuli has taken all the requests it screens in a day', body: ceilingWords(retryAfter) };
    case 'contract':
      return {
        heading: 'This looks like a smart contract wallet',
        body: 'Wallets that sign through a contract cannot ask yet. Ask with a wallet that signs with its own key.',
      };
  }
}

/** How long a route is left alone after it answered 429. */
export const SLOWED_POLL_MILLISECONDS = 30_000;

export const SLOWED_LINE = 'Updates are paused for a moment.';

/** The wait before the next read of a route: the usual one, or 30 seconds after a 429, never shorter than the usual. */
export function pollDelay(normalMilliseconds: number, slowed: boolean): number {
  return slowed ? Math.max(normalMilliseconds, SLOWED_POLL_MILLISECONDS) : normalMilliseconds;
}

export interface Payout {
  lines: string[];
  /** True once the wallet has been paid in full: the line is shown in the full colour. */
  paid: boolean;
}

/**
 * What a decided wallet is told about its reward. The delay a list waits in the vault is not in the routes, so the
 * sentence about it says only that a list waits.
 */
export function payoutFor(input: { ask: AskJson; ticket: Ticket | null; campaign: CampaignView; now: number }): Payout {
  const { ask, ticket, campaign, now } = input;
  const approved = ask.status === 'decided' && (ask.action === 'full' || ask.action === 'partial');
  if (!approved) return { lines: ['No reward is reserved for this wallet.', 'Appeals are not open yet.'], paid: false };
  if (ask.slot === null) return { lines: ['Approved, but every slot was already taken.'], paid: false };

  if (ticket === null) {
    const amount = usdc(walletAmount(campaign.rewardPerWallet, ask.shareBps ?? 0));
    return {
      lines: [`You hold slot ${ask.slot}.`, `Your ${amount} USDC goes on the next list Thuli posts. A list waits in the vault before it pays.`],
      paid: false,
    };
  }

  const owed = BigInt(ticket.cumulativeAmount);
  if (ticket.claimed !== undefined && BigInt(ticket.claimed) >= owed) {
    return { lines: [`Paid: ${usdc(owed)} USDC is in your wallet.`], paid: true };
  }
  const list = campaign.lists.find((entry) => entry.root === ticket.root) ?? campaign.lists.at(-1);
  const heading = list === undefined ? 'You are on a posted list.' : `You are on list ${list.version}.`;
  const startsAt = list?.claimableAt ?? null;
  const next =
    startsAt !== null && startsAt * 1000 > now
      ? `It starts paying at ${formatUtcMinute(startsAt * 1000)}.`
      : 'Thuli is submitting your claim. You do not need to do anything.';
  return { lines: [heading, next], paid: false };
}

/** Lists newest first, as the page shows them. */
export function newestFirst(lists: readonly ListVersion[]): ListVersion[] {
  return [...lists].sort((a, b) => b.version - a.version);
}

// ---------------------------------------------------------------- decisions, payments and the facts of a row

const PANEL_WORDS: Record<Action, { unpaid: string; paid: string }> = {
  full: { unpaid: 'Approved in full', paid: 'Paid in full' },
  partial: { unpaid: 'Approved for a partial reward', paid: 'Paid a partial reward' },
  hold: { unpaid: 'Held for review', paid: 'Held for review' },
  exclude: { unpaid: 'Excluded', paid: 'Excluded' },
};

const BOARD_WORDS: Record<Action, string> = {
  full: 'Approved in full',
  partial: 'Approved, partial',
  hold: 'Held for review',
  exclude: 'Excluded',
};

/**
 * The words for a decision. The panel headline also says whether the vault has paid the wallet; a board row shows the
 * decision alone, because the board has no payment data, so `paid` does not change a board label.
 */
export function outcomeWords(action: Action, paid: boolean, place: 'panel' | 'board' = 'panel'): string {
  if (place === 'board') return BOARD_WORDS[action];
  return paid ? PANEL_WORDS[action].paid : PANEL_WORDS[action].unpaid;
}

export const NOT_CHECKED_INTRO = "Thuli read this wallet's own history and linked it to the other wallets that asked here. It did not measure:";

const UNREAD_FACT = 'Another fact this screening could not read';

/** The plain line for a fact the screening did not measure. A name the table has no line for is never shown as it came. */
export function notCheckedLine(name: string): string {
  const line = notCheckedText(name);
  return line === name ? UNREAD_FACT : line;
}

const FUNDER_KIND_WORDS = new Map<string, string>([
  ['wallet', 'a wallet'],
  ['exchange', 'an exchange'],
  ['bridge', 'a bridge'],
  ['contract', 'a contract'],
]);

export function funderKindWords(kind: string): string {
  return FUNDER_KIND_WORDS.get(kind) ?? 'kind unknown';
}

/** The line for how many asking wallets a funder paid, or null when the row is left out. */
export function funderFanoutText(funder: { kind: string; fanout: number | null }): string | null {
  if (funder.fanout !== null) return formatInt(funder.fanout);
  if (funder.kind === 'exchange') return 'Not counted: an exchange pays strangers';
  if (funder.kind === 'bridge' || funder.kind === 'contract') return 'Not counted';
  return null;
}

export function groupText(groupSize: number | null): string {
  if (groupSize === null) return 'None';
  return groupSize === 1 ? '1 wallet that asked here' : `${formatInt(groupSize)} wallets that asked here`;
}

// ---------------------------------------------------------------- a held wallet that has never been used

export const WHAT_TO_DO_LABEL = 'WHAT TO DO';

export const NEW_WALLET_ADVICE =
  'This wallet has never been used on Ethereum, so nothing sets it apart from one made a minute ago. Ask with a wallet you have used for a while.';

/**
 * Whether a held wallet is told what to do: the screening read zero transactions sent and found no first funder, so the
 * hold comes from there being nothing to read. A hold for any other reason, a failed screening, one still running and an
 * answer with no facts get no line, because the line would then be a guess about the wallet.
 */
export function showsWhatToDo(ask: AskJson): boolean {
  return ask.status === 'decided' && ask.action === 'hold' && ask.facts !== null && ask.facts.txCount === 0 && ask.facts.funder === null;
}

// ---------------------------------------------------------------- the how-it-goes steps

export type Step = 1 | 2 | 3;

/**
 * The step of "How it goes" the visitor is on, or null when none is current. No ask yet is the first step; an ask that
 * was sent, queued or is being screened is the second; an approved wallet with a slot that the vault has not paid is the
 * third. A paid, held, excluded or failed wallet, or an approved one with no slot, has finished and nothing is lit.
 */
export function currentStep(input: { ask: AskJson | null; sent: boolean; paid: boolean }): Step | null {
  const { ask } = input;
  if (ask === null) return input.sent ? 2 : 1;
  if (ask.status === 'queued' || ask.status === 'screening') return 2;
  const approved = ask.status === 'decided' && ask.slot !== null && (ask.action === 'full' || ask.action === 'partial');
  return approved && !input.paid ? 3 : null;
}

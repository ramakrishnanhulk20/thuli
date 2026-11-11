import { formatUnits } from 'viem';
import { appealBody, askBody, isPlainWords } from './ask';
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
  counts: { asked: number; queued: number; decided: number; held: number; slotsTaken: number; slotsLeft: number; asksLeft: number; appeals?: AppealCounts };
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
  /** The chain whose history was screened. */
  chain: ScreenedChain;
}

export type ScreenedChain = 'ethereum' | 'base';

export type AppealRoute = 'ship' | 'review' | 'block';

/** The public view of an appeal. It never holds the appellant's words: those go to the campaign's owner alone. */
export interface AppealView {
  filedAt: string;
  checkStatus: 'queued' | 'checking' | 'checked' | 'unchecked';
  reppoRoute: AppealRoute | null;
  /** At most 280 plain characters. */
  reppoNote: string | null;
  reppoEvalId: string | null;
  checkedAt: string | null;
  outcome: 'open' | 'reversed' | 'upheld';
  newAction: 'full' | 'partial' | null;
  settledAt: string | null;
}

export interface AppealCounts {
  filed: number;
  checked: number;
  block: number;
  reversed: number;
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
  /** Left out by the committed routes, which read as no appeal. */
  appeal?: AppealView | null;
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
const APPEAL_CHECKS: readonly string[] = ['queued', 'checking', 'checked', 'unchecked'];
const APPEAL_ROUTES: readonly string[] = ['ship', 'review', 'block'];
const APPEAL_OUTCOMES: readonly string[] = ['open', 'reversed', 'upheld'];
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

const isNote = (value: unknown): value is string => isText(value) && value.length <= 280 && isPlainWords(value);

export function isAppealView(value: unknown): value is AppealView {
  return (
    isRecord(value) &&
    isTime(value.filedAt) &&
    isText(value.checkStatus) &&
    APPEAL_CHECKS.includes(value.checkStatus) &&
    (value.reppoRoute === null || (isText(value.reppoRoute) && APPEAL_ROUTES.includes(value.reppoRoute))) &&
    orNull(value.reppoNote, isNote) &&
    orNull(value.reppoEvalId, isText) &&
    orNull(value.checkedAt, isTime) &&
    isText(value.outcome) &&
    APPEAL_OUTCOMES.includes(value.outcome) &&
    (value.newAction === null || value.newAction === 'full' || value.newAction === 'partial') &&
    orNull(value.settledAt, isTime)
  );
}

function isAppealCounts(value: unknown): value is AppealCounts {
  return isRecord(value) && ['filed', 'checked', 'block', 'reversed'].every((key) => isCount(value[key]));
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
    (counts.appeals === undefined || isAppealCounts(counts.appeals)) &&
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
    isTexts(value.missing) &&
    (value.chain === 'ethereum' || value.chain === 'base')
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
    orNull(value.slot, isCount) &&
    (value.appeal === undefined || value.appeal === null || isAppealView(value.appeal))
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
  /** The wallet has sent no transaction and holds nothing, so nothing was stored for it. */
  | { kind: 'neverUsed' }
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
  if (status === 200) {
    // Exactly { neverUsed: true }: a body that says more is not this answer.
    if (isRecord(body) && Object.keys(body).length === 1 && body.neverUsed === true) return { kind: 'neverUsed' };
    return isRecord(body) && body.exists === true && isAskJson(body.ask) ? { kind: 'exists', ask: body.ask } : { kind: 'unreachable' };
  }
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
} as const;

export type RefusalKind = 'stopped' | 'slots' | 'full' | 'ceiling' | 'contract' | 'neverUsed';

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
export function refusalWords(kind: RefusalKind, retryAfter: string | null = null): { heading: string; body: string; note?: string } {
  switch (kind) {
    case 'stopped':
      return { heading: 'This campaign has stopped taking requests', body: 'It has screened as many wallets as it set out to. No new request can be sent.' };
    case 'slots':
      return {
        heading: 'Every slot is taken',
        body: 'This campaign has given out all its slots, so no new request can be sent. If you already asked, connect the same wallet to see your decision.',
      };
    case 'full':
      return { heading: 'This campaign is full', body: 'Your request was not taken, and nothing was spent. Signing a message costs nothing.' };
    case 'ceiling':
      return { heading: 'Thuli has taken all the requests it screens in a day', body: ceilingWords(retryAfter) };
    case 'neverUsed':
      return {
        heading: 'This wallet has never been used',
        body: 'It has sent no transaction and holds nothing on Ethereum or Base, so there is nothing to screen. Ask with a wallet you have used for a while.',
        note: 'Nothing was stored, and signing cost nothing.',
      };
    case 'contract':
      return {
        heading: 'This looks like a smart contract wallet',
        body: 'Wallets that sign through a contract cannot ask yet. Ask with a wallet that signs with its own key.',
      };
  }
}

/** The refusal an answer of the ask route puts in the panel, or null for an answer that is not one. */
export function refusalFor(post: AskPost): { kind: RefusalKind; retryAfter: string | null } | null {
  switch (post.kind) {
    case 'full':
      return { kind: 'full', retryAfter: null };
    case 'ceiling':
      return { kind: 'ceiling', retryAfter: post.retryAfter };
    case 'neverUsed':
      return { kind: 'neverUsed', retryAfter: null };
    default:
      return null;
  }
}

/** What the panel holds for the connected wallet: a session that belongs to another wallet is never shown, and none is for no wallet. */
export function sessionFor<T extends { wallet: string }>(session: T | null, address: string | null, fresh: (wallet: string) => T): T | null {
  if (address === null) return null;
  return session !== null && session.wallet === address ? session : fresh(address);
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
  if (!approved) return { lines: ['No reward is reserved for this wallet.'], paid: false };
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
  'This wallet has never been used on Ethereum or Base, so nothing sets it apart from one made a minute ago. Ask with a wallet you have used for a while.';

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

// ---------------------------------------------------------------- appeals

/** Every line of the appeal form and of the outside check, in one place. */
export const APPEAL_COPY = {
  formLabel: 'DISAGREE?',
  formLine: "Tell the campaign's owner why in one line. An outside judge then checks Thuli's decision.",
  placeholder: 'Why is this wrong?',
  unplain: 'Write plain words, with no links or markup.',
  button: 'Appeal',
  signing: 'Waiting for your wallet',
  sending: 'Sending',
  privacy: 'Your words go to the owner only. They are shown on no public page and sent to no model.',
  filedLabel: 'APPEAL',
  withJudge: 'With the outside judge',
  judgeLine: "Reppo's judges are reading Thuli's decision, with every address and amount removed. This takes about a minute.",
  checkedLabel: 'OUTSIDE CHECK BY REPPO',
  advice: "This is advice. The campaign's owner makes the final call.",
  uncheckedLine: "The outside check could not be made. Your appeal is still with the campaign's owner.",
  boardLabel: 'OUTSIDE CHECK',
  boardUnchecked: 'The check could not be made',
} as const;

export type AppealPanel = { kind: 'hidden' } | { kind: 'form' } | { kind: 'filed'; appeal: AppealView };

/** The appeal an ask carries. An answer with no `appeal` field, as the committed routes send it, is an ask with none. */
export function appealOf(ask: AskJson): AppealView | null {
  return ask.appeal ?? null;
}

/**
 * What the decision panel shows about appealing. A filed appeal always shows, even after a reversal made the ask an
 * approval. The form is only for a decided or failed ask that was held, excluded or cut to a partial reward, and never for
 * a full approval or an ask with no decision yet.
 */
export function appealPanel(ask: AskJson): AppealPanel {
  if (ask.status !== 'decided' && ask.status !== 'failed') return { kind: 'hidden' };
  const appeal = appealOf(ask);
  if (appeal !== null) return { kind: 'filed', appeal };
  const canAppeal = ask.status === 'failed' || ask.action === 'hold' || ask.action === 'exclude' || ask.action === 'partial';
  return canAppeal ? { kind: 'form' } : { kind: 'hidden' };
}

export type AppealStage = 'judge' | 'checked' | 'unchecked';

/** Where the outside check stands: with the judge (queued or running), answered, or never made. */
export function appealStage(appeal: AppealView): AppealStage {
  if (appeal.checkStatus === 'checked') return 'checked';
  return appeal.checkStatus === 'unchecked' ? 'unchecked' : 'judge';
}

export type AppealTone = 'hold' | 'partial' | 'full' | 'quiet';

const ROUTE_WORDS: Record<AppealRoute | 'unread', { headline: string; tone: AppealTone }> = {
  ship: { headline: 'The judges agreed with Thuli.', tone: 'hold' },
  review: { headline: 'The judges were split.', tone: 'partial' },
  block: { headline: 'The judges disagreed with Thuli.', tone: 'full' },
  unread: { headline: 'The judges answered, but not in a form Thuli could read.', tone: 'quiet' },
};

/** The outside check's answer: its headline and the colour of its drop, the note, the advice line and the check id line. */
export function checkedWords(appeal: AppealView): { headline: string; tone: AppealTone; note: string | null; advice: string; evalLine: string | null } {
  const words = ROUTE_WORDS[appeal.reppoRoute ?? 'unread'];
  return {
    headline: words.headline,
    tone: words.tone,
    note: appeal.reppoNote,
    advice: APPEAL_COPY.advice,
    evalLine: appeal.reppoEvalId === null ? null : `Reppo check ${appeal.reppoEvalId}`,
  };
}

/** The owner's call once made, or null while the appeal is open. */
export function settledWords(appeal: AppealView): { headline: string; line: string; tone: 'full' | 'ink' } | null {
  if (appeal.outcome === 'reversed') {
    const line = appeal.newAction === 'partial' ? 'Your request is now approved for a partial reward.' : 'Your request is now approved in full.';
    return { headline: 'Reversed by the owner', line, tone: 'full' };
  }
  if (appeal.outcome === 'upheld') return { headline: 'Upheld by the owner', line: 'The decision stands.', tone: 'ink' };
  return null;
}

/** What an opened board row says about the outside check: the answer and its note, the wait, or that it could not be made. */
export function boardCheckWords(appeal: AppealView): { headline: string; note: string | null } {
  const stage = appealStage(appeal);
  if (stage === 'judge') return { headline: APPEAL_COPY.withJudge, note: null };
  if (stage === 'unchecked') return { headline: APPEAL_COPY.boardUnchecked, note: null };
  return { headline: ROUTE_WORDS[appeal.reppoRoute ?? 'unread'].headline, note: appeal.reppoNote };
}

/** The chip after a row's outcome words, or null for a row that was not appealed. */
export function appealChip(appeal: AppealView | null): { text: 'APPEALED' | 'REVERSED'; tone: 'quiet' | 'full' } | null {
  if (appeal === null) return null;
  return appeal.outcome === 'reversed' ? { text: 'REVERSED', tone: 'full' } : { text: 'APPEALED', tone: 'quiet' };
}

/** The campaign's appeal counts. The committed routes send none, which reads as no appeals. */
export function appealCountsOf(campaign: CampaignView): AppealCounts {
  return campaign.counts.appeals ?? { filed: 0, checked: 0, block: 0, reversed: 0 };
}

/** The line under the board's heading, or null when nobody has appealed. */
export function appealCountsLine(counts: AppealCounts): string | null {
  if (counts.filed === 0) return null;
  return `${formatInt(counts.filed)} appealed. The outside judges disagreed with Thuli on ${formatInt(counts.block)}. The owner reversed ${formatInt(counts.reversed)}.`;
}

export type AppealPost =
  | { kind: 'queued' }
  | { kind: 'exists'; appeal: AppealView | null }
  | { kind: 'undecided' }
  | { kind: 'approved' }
  | { kind: 'limit' }
  /** The day's ceiling on appeals: only that answer carries Retry-After, which is kept as it came. */
  | { kind: 'ceiling'; retryAfter: string }
  | { kind: 'bad'; cause: string }
  | { kind: 'gone' }
  | { kind: 'unreachable' };

/** Maps a status, a parsed body and the Retry-After header from the appeals route to what the page shows. */
export function classifyAppealAnswer(status: number, body: unknown, retryAfter: string | null = null): AppealPost {
  if (status === 202) return isRecord(body) && body.queued === true ? { kind: 'queued' } : { kind: 'unreachable' };
  if (status === 200) {
    if (!isRecord(body) || body.exists !== true) return { kind: 'unreachable' };
    return { kind: 'exists', appeal: isAppealView(body.appeal) ? body.appeal : null };
  }
  if (status === 404) return { kind: 'gone' };
  if (status === 409) {
    if (isRecord(body) && body.undecided === true) return { kind: 'undecided' };
    return isRecord(body) && body.approved === true ? { kind: 'approved' } : { kind: 'unreachable' };
  }
  if (status === 429) return retryAfter === null ? { kind: 'limit' } : { kind: 'ceiling', retryAfter };
  if ((status === 400 || status === 413) && isRecord(body) && isText(body.error) && body.error !== '') return { kind: 'bad', cause: body.error };
  return { kind: 'unreachable' };
}

export async function postAppeal(
  id: string,
  signed: { wallet: string; text: string; signedAt: number; signature: string },
  request: Fetcher = fetch,
): Promise<AppealPost> {
  try {
    const response = await request(`${root(id)}/appeals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: appealBody(signed),
      cache: 'no-store',
    });
    return classifyAppealAnswer(response.status, await readJson(response), response.headers.get('retry-after'));
  } catch {
    return { kind: 'unreachable' };
  }
}

/** The line shown when the route did not take the appeal. The 404 and a smart contract wallet are handled by the panel itself. */
export function appealRefusalText(post: Extract<AppealPost, { kind: 'undecided' | 'approved' | 'limit' | 'ceiling' | 'bad' | 'unreachable' }>): string {
  switch (post.kind) {
    case 'undecided':
      return 'This request has no decision yet, so there is nothing to appeal.';
    case 'approved':
      return 'This request was approved in full. There is nothing to appeal.';
    case 'limit':
      return 'You have sent as many appeals as one caller may in an hour. Try again later.';
    case 'ceiling':
      return `Thuli has taken all the appeals it sends to the outside judge in a day. ${ceilingWords(post.retryAfter)}`;
    case 'bad':
      return post.cause;
    case 'unreachable':
      return 'The appeal could not be sent. Nothing was signed away.';
  }
}

export const ASK_POLL_MILLISECONDS = 4000;
export const REWARD_POLL_MILLISECONDS = 10_000;
export const APPEAL_CHECK_POLL_MILLISECONDS = 5000;
export const APPEAL_OWNER_POLL_MILLISECONDS = 30_000;

/**
 * How long to wait before reading the ask again because of its appeal: every 5 seconds while the outside check is
 * queued or running, or from the moment the appeal was sent until the ask shows it, then every 30 while the owner has not
 * settled, and never once settled. Null means no read is needed for the appeal.
 */
export function appealPollDelay(appeal: AppealView | null, sent: boolean): number | null {
  if (appeal === null) return sent ? APPEAL_CHECK_POLL_MILLISECONDS : null;
  if (appeal.outcome !== 'open') return null;
  return appealStage(appeal) === 'judge' ? APPEAL_CHECK_POLL_MILLISECONDS : APPEAL_OWNER_POLL_MILLISECONDS;
}

/** The shortest wait that applies to the ask: waiting for a decision, waiting for a payment, waiting on an appeal. */
export function askPollDelay(input: { waiting: boolean; approvedUnpaid: boolean; appeal: AppealView | null; appealSent: boolean }): number | null {
  const delays = [input.waiting ? ASK_POLL_MILLISECONDS : null, input.approvedUnpaid ? REWARD_POLL_MILLISECONDS : null, appealPollDelay(input.appeal, input.appealSent)].filter(
    (delay): delay is number => delay !== null,
  );
  return delays.length === 0 ? null : Math.min(...delays);
}

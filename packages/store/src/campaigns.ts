import {
  DECISION_RULES,
  isPlainText,
  isScreenedChain,
  MAX_EVIDENCE_TXS,
  OUTCOMES,
  parseAddress,
  SCREENED_CHAINS,
  Settings,
  shareFor,
  TxHash,
  type Address,
  type Outcome,
  type ScreenedChain,
} from '@thuli/core';
import { readPublicAppeal, type PublicAppeal, type PublicAppealRow } from './appeals.ts';
import { instant, shifted, StoreError, wholeNumber, type Db, type Queryable } from './db.ts';

// A decision's record is a few hundred bytes; 16 KB leaves room and still bounds what one ask can store (C41).
const MAX_RECORD_BYTES = 16_384;

// Advisory lock namespace 1005 is one campaign, beside the ones db.ts lists. Every check-then-write on a campaign's
// asks, slots and list versions holds it, so two server copies or two workers never decide on the same stale count.
// Campaign rows are records, not caches, so sweep leaves them alone (see 002_campaigns.sql).

/**
 * Attempts one relay gets before it is marked failed. Ten, because the worker waits longer after each failed try: ten
 * tries then span about an hour of a chain outage before a claim is left for the wallet to submit itself.
 */
export const MAX_RELAY_ATTEMPTS = 10;
/** The most asks board returns in one call. */
export const MAX_BOARD_PAGE = 100;
/** The most asks board adds past its limit so a page never ends between two asks decided at the same instant. */
export const MAX_BOARD_TIES = 100;
/** The longest reason an ask may store, in characters. Longer than a model reason so a code-written hold always fits. */
export const MAX_ASK_REASON_CHARS = 400;
/** The longest an ask or a relay may be told to wait before its next try: a day, so no retry is put off for ever (C41). */
export const MAX_RETRY_SECONDS = 86_400;
/** The most campaigns openCampaigns returns, so one worker pass reads a bounded list (C41). */
export const MAX_OPEN_CAMPAIGNS = 100;
/** Undecided asks, queued or screening, a campaign holds at once before it answers full; room returns as they are decided. */
export const ASK_BACKLOG_CAP = 200;
/** The fewest asks any campaign takes in all. See askLifetimeCap. */
export const ASK_LIFETIME_MIN = 1_000;
/** Asks a campaign takes in all per slot, past ASK_LIFETIME_MIN. See askLifetimeCap. */
export const ASK_LIFETIME_PER_SLOT = 100;
/** The store's day counter the worker counts the screenings it runs in, a name of its own. */
export const CAMPAIGN_SCREENINGS_DAY_COUNTER = 'campaign-screenings';

const MAX_NAME_CHARS = 80;
const MAX_NOT_CHECKED = 16;
const MAX_NOT_CHECKED_CHARS = 64;
// The worker's reader refuses a published list longer than this, so a longer one could never be rebuilt.
const MAX_PUBLISHED_CHARS = 12_000_000;
const MAX_LIST_ENTRIES = 100_000;
const MAX_SLOTS = 100_000;
/** The most rows funderLinks returns: the lifetime ask cap of the largest campaign allowed, 10,000,000. */
export const MAX_FUNDER_LINKS = askLifetimeCap(MAX_SLOTS);
const MAX_INTEGER = 2_147_483_647;
const MAX_LEASE_SECONDS = 86_400;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_BIGINT_COLUMN = (1n << 63n) - 1n;
const MAX_AMOUNT_DIGITS = 78;

// The appeal message's rule for a campaign id, so an id stored here can always be signed over.
const CAMPAIGN_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const ROOT = /^0x[0-9a-f]{64}$/;
// The worker's rule for SERV's x-openserv-request-id header.
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DIGITS = /^(0|[1-9][0-9]*)$/;

const HELD_REASON = 'Held for review: the screening could not finish.';
const RELAY_STATUSES: readonly string[] = ['pending', 'sent', 'confirmed', 'failed'];
const FACT_KEYS: readonly string[] = ['ageDays', 'txCount', 'accountType', 'funder', 'burstWallets', 'groupSize', 'missing', 'chain'];
// Facts given without the screened chain, the shape every caller used before the chain was recorded.
const FACT_KEYS_WITHOUT_CHAIN: readonly string[] = FACT_KEYS.filter((key) => key !== 'chain');
// Every ask decided before the chain was recorded was screened on Ethereum, the only chain read then.
const CHAIN_BEFORE_RECORDING: ScreenedChain = 'ethereum';
const FUNDER_KEYS: readonly string[] = ['address', 'kind', 'fanout', 'hops'];
// Core's own schema with every key optional: an unknown key or a bad value is refused, as a full Settings would be.
const CampaignSettings = Settings.partial();
const MAX_FACT_WORD_CHARS = 32;
const MAX_MISSING_FACTS = 16;
const MAX_MISSING_FACT_CHARS = 64;

export type CampaignStatus = 'open' | 'closed';
export type AskStatus = 'queued' | 'screening' | 'decided' | 'failed';
export type ListStatus = 'built' | 'sending' | 'posted' | 'active' | 'superseded' | 'cancelled';
export type RelayStatus = 'pending' | 'sent' | 'confirmed' | 'failed';
export type DecisionRule = (typeof DECISION_RULES)[number];

export type AddAskResult = 'queued' | 'exists' | 'closed' | 'unknown' | 'full';
export type CreateCampaignResult = 'created' | 'unchanged';
export type ReleaseAskResult = 'queued' | 'failed';

/** A campaign as stored. Amounts are base units as decimal text, and every time is the caller's. */
export interface Campaign {
  id: string;
  name: string;
  chain: number;
  vault: Address;
  token: Address;
  owner: Address;
  agent: Address;
  rewardPerWallet: string;
  perWalletCap: string;
  partialShareBps: number;
  maxSlots: number;
  rulebook: number;
  /** The screening settings this campaign changes from the defaults, and only those. Part of its terms. */
  settings: Partial<Settings>;
  status: CampaignStatus;
  opensAt: Date;
  closesAt: Date;
  createdAt: Date;
  /** The block of the transaction that created the vault, where its history starts; null when it was not recorded. */
  vaultBlock: bigint | null;
}

/**
 * What createCampaign takes: a Campaign whose four addresses may be in any spelling parseAddress accepts, and whose
 * vaultBlock may be left out, which records none.
 */
export type CampaignInput = Omit<Campaign, 'vault' | 'token' | 'owner' | 'agent' | 'vaultBlock'> & {
  vault: string;
  token: string;
  owner: string;
  agent: string;
  vaultBlock?: bigint | null;
};

/** The first funder a decision saw: its canonical address, its kind, how many wallets it funded and the hops traced. */
export interface AskFunder {
  address: Address;
  kind: string;
  fanout: number | null;
  hops: number;
}

/** The public chain facts one decision rested on. Every count is a whole number from 0, or null when not measured. */
export interface AskFacts {
  ageDays: number | null;
  txCount: number | null;
  accountType: string;
  funder: AskFunder | null;
  burstWallets: number | null;
  groupSize: number | null;
  missing: string[];
  /** The chain the facts were read on, so each cited transaction links to that chain's explorer. */
  chain: ScreenedChain;
}

/**
 * What decideAsk takes as facts: AskFacts whose funder address may be in any spelling parseAddress accepts, and whose
 * chain may be left out. Left out, the chain is stored as 'ethereum', the only chain any ask was screened on before the
 * chain was recorded.
 */
export type AskFactsInput = Omit<AskFacts, 'funder' | 'chain'> & {
  funder: (Omit<AskFunder, 'address'> & { address: string }) | null;
  chain?: ScreenedChain;
};

/** One decided ask whose facts name a first funder, as the worker reads them to count the wallets one funder paid. */
export interface FunderLink {
  wallet: Address;
  funderAddress: Address;
  funderKind: string;
  decidedAt: Date;
}

/**
 * One ask as anyone may see it. Built field by field, with no field for the signature, the lease or the attempts, so
 * none of them can leave through it (C40). The decision fields are null until the ask is decided or failed, and facts
 * is null unless it was decided.
 */
export interface PublicAsk {
  campaignId: string;
  wallet: Address;
  askedAt: Date;
  status: AskStatus;
  action: Outcome | null;
  shareBps: number | null;
  rule: DecisionRule | null;
  reason: string | null;
  citedTxs: string[] | null;
  notChecked: string[] | null;
  facts: AskFacts | null;
  servRequestId: string | null;
  decidedAt: Date | null;
  slot: number | null;
  /** The wallet's appeal in its public view, or null when it filed none. */
  appeal: PublicAppeal | null;
}

/** What the vault has paid one wallet, from the worker's record of a confirmed claim. */
export interface Payout {
  wallet: Address;
  /** The total paid to the wallet so far, in the token's base units. */
  amount: string;
  /** The claim transaction that brought the total there: 0x and 64 lowercase hex characters. */
  tx: string;
}

/** The ask takeAsk handed to one worker, which holds it until leaseUntil. */
export interface TakenAsk {
  campaignId: string;
  wallet: Address;
  askedAt: Date;
  attempts: number;
  leaseUntil: Date;
}

/** One screening's result for decideAsk. citedTxs must already be lowercase, as every stored hash is (C13). */
export interface AskDecision {
  campaignId: string;
  wallet: string;
  action: Outcome;
  shareBps: number;
  rule: string;
  reason: string;
  citedTxs: readonly string[];
  notChecked: readonly string[];
  facts: AskFactsInput;
  servRequestId: string | null;
  /**
   * The flat record the decision rested on, the object the worker gave SERV, kept so an appeal's outside check can be
   * made later. Private: no public view returns it. A JSON object of at most 16 KB; left out, none is kept.
   */
  record?: Record<string, unknown>;
}

/**
 * asked counts every ask; queued those not yet decided, screening included; decided those with a decision, failed
 * ones included; held those whose action is hold, failed ones included; asksLeft how many more asks the campaign takes
 * before it reaches its lifetime cap, never below 0. A campaign can also answer full sooner, when its slots are taken
 * or its backlog of undecided asks is at ASK_BACKLOG_CAP.
 */
export interface CampaignCounts {
  asked: number;
  queued: number;
  decided: number;
  held: number;
  slotsTaken: number;
  slotsLeft: number;
  asksLeft: number;
  /** Appeals filed, those the outside check finished, those it routed to block, and those the owner reversed. */
  appeals: { filed: number; checked: number; block: number; reversed: number };
}

export interface SlotHolder {
  wallet: Address;
  action: 'full' | 'partial';
  shareBps: number;
  slot: number;
}

/**
 * One list version without its published text, which only listText returns. claimableAt is in Unix seconds. postNonce
 * is the posting transaction's nonce, for the worker; the public views do not carry it.
 */
export interface ListVersion {
  campaignId: string;
  version: number;
  root: string;
  declaredTotal: string;
  status: ListStatus;
  postTx: string | null;
  postNonce: number | null;
  claimableAt: number | null;
  createdAt: Date;
}

export interface RelayKey {
  campaignId: string;
  wallet: string;
  version: number;
}

export interface Relay {
  campaignId: string;
  wallet: Address;
  version: number;
  amount: string;
  status: RelayStatus;
  tx: string | null;
  attempts: number;
  updatedAt: Date;
}

interface CampaignRow {
  id: string;
  name: string;
  chain: number;
  vault: string;
  token: string;
  owner: string;
  agent: string;
  reward_per_wallet: string;
  per_wallet_cap: string;
  partial_share_bps: number;
  max_slots: number;
  rulebook: number;
  settings: unknown;
  status: string;
  opens_at: unknown;
  closes_at: unknown;
  created_at: unknown;
  vault_block: string | null;
}

interface AskRow extends PublicAppealRow {
  campaign_id: string;
  wallet: string;
  asked_at: unknown;
  status: string;
  action: string | null;
  share_bps: number | null;
  rule: string | null;
  reason: string | null;
  cited_txs: unknown;
  not_checked: unknown;
  facts: unknown;
  serv_request_id: string | null;
  decided_at: unknown;
  slot: number | null;
}

interface ListRow {
  campaign_id: string;
  version: number;
  root: string;
  declared_total: string;
  status: string;
  post_tx: string | null;
  post_nonce: string | null;
  claimable_at: string | null;
  created_at: unknown;
}

interface RelayRow {
  campaign_id: string;
  wallet: string;
  version: number;
  amount: string;
  status: string;
  tx: string | null;
  attempts: number;
  updated_at: unknown;
}

function isCampaignId(id: unknown): id is string {
  return typeof id === 'string' && CAMPAIGN_ID.test(id);
}

function campaignIdOf(id: unknown): string {
  if (!isCampaignId(id)) throw new StoreError('a campaign id is 1 to 128 letters, digits, dots, dashes or underscores');
  return id;
}

// Postgres measures text in characters (code points), so this does too, and the two limits can never disagree.
function characters(text: string): number {
  return [...text].length;
}

function plainTextOf(value: unknown, label: string, most: number): string {
  // A string longer than twice the limit in UTF-16 units is over it in characters, so the spread below stays small.
  if (typeof value !== 'string' || value.length === 0 || value.length > most * 2 || characters(value) > most) {
    throw new StoreError(`${label} must be text of 1 to ${most} characters`);
  }
  if (!isPlainText(value)) throw new StoreError(`${label} must be plain text, with no link, markup or control characters`);
  return value;
}

function amountOf(value: unknown, label: string, least: bigint): string {
  if (typeof value !== 'string' || value.length > MAX_AMOUNT_DIGITS || !DIGITS.test(value)) {
    throw new StoreError(`${label} must be base units written as decimal digits with no leading zero`);
  }
  const amount = BigInt(value);
  if (amount < least || amount > MAX_UINT256) throw new StoreError(`${label} must be at least ${least} and fit in 256 bits`);
  return value;
}

function timeOf(value: unknown, label: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new StoreError(`${label} must be a valid Date`);
  return value.toISOString();
}

function txHashOf(value: unknown, label: string): string {
  if (!TxHash.safeParse(value).success) throw new StoreError(`${label} must be 0x and 64 lowercase hex characters`);
  return value as string;
}

function readTime(value: unknown): Date {
  const time = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(time.getTime())) throw new StoreError('the database returned a time that could not be read');
  return time;
}

function readTimeOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : readTime(value);
}

function readTexts(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new StoreError('the database returned a list that is not text');
  }
  return [...(value as string[])];
}

// Exactly these keys, no more and no fewer, so nothing a caller adds rides along into a public row (C40).
function exactKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new StoreError(`${label} must be an object`);
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    throw new StoreError(`${label} must have exactly the keys ${keys.join(', ')}`);
  }
  return value as Record<string, unknown>;
}

function countOrNull(value: unknown, label: string): number | null {
  return value === null ? null : wholeNumber(value as number, label, 0, MAX_INTEGER);
}

function factsOf(value: unknown): AskFacts {
  const withChain = typeof value === 'object' && value !== null && Object.hasOwn(value, 'chain');
  const facts = exactKeys(value, withChain ? FACT_KEYS : FACT_KEYS_WITHOUT_CHAIN, 'facts');
  let chain = CHAIN_BEFORE_RECORDING;
  if (facts.chain !== undefined) {
    if (!isScreenedChain(facts.chain)) throw new StoreError(`facts.chain must be one of ${SCREENED_CHAINS.join(', ')}`);
    chain = facts.chain;
  }
  let funder: AskFunder | null = null;
  if (facts.funder !== null) {
    const given = exactKeys(facts.funder, FUNDER_KEYS, 'facts.funder');
    let address: Address;
    try {
      address = parseAddress(given.address as string);
    } catch {
      throw new StoreError('facts.funder.address is not an address');
    }
    funder = {
      address,
      kind: plainTextOf(given.kind, 'facts.funder.kind', MAX_FACT_WORD_CHARS),
      fanout: countOrNull(given.fanout, 'facts.funder.fanout'),
      hops: wholeNumber(given.hops as number, 'facts.funder.hops', 0, MAX_INTEGER),
    };
  }
  const { missing } = facts;
  if (!Array.isArray(missing) || missing.length > MAX_MISSING_FACTS) {
    throw new StoreError(`facts.missing must be a list of at most ${MAX_MISSING_FACTS} entries`);
  }
  return {
    ageDays: countOrNull(facts.ageDays, 'facts.ageDays'),
    txCount: countOrNull(facts.txCount, 'facts.txCount'),
    accountType: plainTextOf(facts.accountType, 'facts.accountType', MAX_FACT_WORD_CHARS),
    funder,
    burstWallets: countOrNull(facts.burstWallets, 'facts.burstWallets'),
    groupSize: countOrNull(facts.groupSize, 'facts.groupSize'),
    missing: missing.map((item: unknown, index) => plainTextOf(item, `facts.missing ${index}`, MAX_MISSING_FACT_CHARS)),
    chain,
  };
}

// Picks the known keys out of a stored row, so even a row edited by hand cannot add a field to the public view. A row
// stored before the chain was recorded has no chain key and was screened on Ethereum; a chain key holding anything
// but a ScreenedChain is refused like any other malformed stored value, never guessed at.
function readFacts(value: unknown): AskFacts | null {
  if (value === null || value === undefined) return null;
  const stored = value as Record<string, unknown>;
  const funder = stored.funder as Record<string, unknown> | null | undefined;
  const chain = stored.chain === undefined ? CHAIN_BEFORE_RECORDING : stored.chain;
  if (!isScreenedChain(chain)) throw new StoreError('the database returned a screened chain that is not one Thuli knows');
  return {
    ageDays: (stored.ageDays ?? null) as number | null,
    txCount: (stored.txCount ?? null) as number | null,
    accountType: stored.accountType as string,
    funder:
      funder === null || funder === undefined
        ? null
        : {
            address: funder.address as Address,
            kind: funder.kind as string,
            fanout: (funder.fanout ?? null) as number | null,
            hops: funder.hops as number,
          },
    burstWallets: (stored.burstWallets ?? null) as number | null,
    groupSize: (stored.groupSize ?? null) as number | null,
    missing: readTexts(stored.missing) ?? [],
    chain,
  };
}

function settingsOf(value: unknown, partialShareBps: number): Partial<Settings> {
  const parsed = CampaignSettings.safeParse(value);
  if (!parsed.success) throw new StoreError('settings must hold only screening settings, each with a valid value');
  // The row's own partial share decides payouts, so a second, different one here could only disagree with it.
  if (parsed.data.partialShareBps !== undefined && parsed.data.partialShareBps !== partialShareBps) {
    throw new StoreError('settings.partialShareBps must equal the campaign partialShareBps when it is given');
  }
  return parsed.data;
}

// One text per set of settings whatever order its keys came in, so two equal sets compare equal.
function settingsKey(settings: Partial<Settings>): string {
  const entries = Object.entries(settings).filter(([, value]) => value !== undefined);
  return JSON.stringify(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function campaignTerms(input: CampaignInput): Campaign {
  const id = campaignIdOf(input.id);
  const name = plainTextOf(input.name, 'name', MAX_NAME_CHARS);
  const chain = wholeNumber(input.chain, 'chain', 1, MAX_INTEGER);
  const vault = parseAddress(input.vault);
  const token = parseAddress(input.token);
  const owner = parseAddress(input.owner);
  const agent = parseAddress(input.agent);
  const rewardPerWallet = amountOf(input.rewardPerWallet, 'rewardPerWallet', 1n);
  const perWalletCap = amountOf(input.perWalletCap, 'perWalletCap', 1n);
  if (BigInt(rewardPerWallet) > BigInt(perWalletCap)) {
    throw new StoreError('rewardPerWallet must not be above perWalletCap, or the vault could never pay it in full');
  }
  const partialShareBps = wholeNumber(input.partialShareBps, 'partialShareBps', 1, 9_999);
  const maxSlots = wholeNumber(input.maxSlots, 'maxSlots', 1, MAX_SLOTS);
  const rulebook = wholeNumber(input.rulebook, 'rulebook', 1, MAX_INTEGER);
  const settings = settingsOf(input.settings, partialShareBps);
  if (input.status !== 'open' && input.status !== 'closed') throw new StoreError("status must be 'open' or 'closed'");
  const opensAt = new Date(timeOf(input.opensAt, 'opensAt'));
  const closesAt = new Date(timeOf(input.closesAt, 'closesAt'));
  const createdAt = new Date(timeOf(input.createdAt, 'createdAt'));
  if (closesAt.getTime() <= opensAt.getTime()) throw new StoreError('closesAt must be after opensAt');
  const vaultBlock = input.vaultBlock ?? null;
  // A bigint only, as viem hands block numbers over, so a float or a text spelling can never become a different block.
  if (vaultBlock !== null && (typeof vaultBlock !== 'bigint' || vaultBlock < 1n || vaultBlock > MAX_BIGINT_COLUMN)) {
    throw new StoreError('vaultBlock must be a bigint from 1, or null');
  }
  return {
    id,
    name,
    chain,
    vault,
    token,
    owner,
    agent,
    rewardPerWallet,
    perWalletCap,
    partialShareBps,
    maxSlots,
    rulebook,
    settings,
    status: input.status,
    opensAt,
    closesAt,
    createdAt,
    vaultBlock,
  };
}

// Read back through the same schema it was written with, so a row edited by hand cannot hand the worker a bad setting.
function storedSettings(value: unknown): Partial<Settings> {
  const parsed = CampaignSettings.safeParse(value);
  if (!parsed.success) throw new StoreError('the database returned campaign settings that are not valid');
  return parsed.data;
}

function readCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    name: row.name,
    chain: row.chain,
    vault: row.vault as Address,
    token: row.token as Address,
    owner: row.owner as Address,
    agent: row.agent as Address,
    rewardPerWallet: row.reward_per_wallet,
    perWalletCap: row.per_wallet_cap,
    partialShareBps: row.partial_share_bps,
    maxSlots: row.max_slots,
    rulebook: row.rulebook,
    settings: storedSettings(row.settings),
    status: row.status as CampaignStatus,
    opensAt: readTime(row.opens_at),
    closesAt: readTime(row.closes_at),
    createdAt: readTime(row.created_at),
    vaultBlock: row.vault_block === null ? null : BigInt(row.vault_block),
  };
}

// createdAt is when the row was made, not a term, so a deploy script that runs again with a fresh clock is a no-op.
function sameTerms(a: Campaign, b: Campaign): boolean {
  return (
    a.name === b.name &&
    a.chain === b.chain &&
    a.vault === b.vault &&
    a.token === b.token &&
    a.owner === b.owner &&
    a.agent === b.agent &&
    a.rewardPerWallet === b.rewardPerWallet &&
    a.perWalletCap === b.perWalletCap &&
    a.partialShareBps === b.partialShareBps &&
    a.maxSlots === b.maxSlots &&
    a.rulebook === b.rulebook &&
    settingsKey(a.settings) === settingsKey(b.settings) &&
    a.status === b.status &&
    a.opensAt.getTime() === b.opensAt.getTime() &&
    a.closesAt.getTime() === b.closesAt.getTime() &&
    a.vaultBlock === b.vaultBlock
  );
}

function readPublicAsk(row: AskRow): PublicAsk {
  return {
    campaignId: row.campaign_id,
    wallet: row.wallet as Address,
    askedAt: readTime(row.asked_at),
    status: row.status as AskStatus,
    action: row.action as Outcome | null,
    shareBps: row.share_bps,
    rule: row.rule as DecisionRule | null,
    reason: row.reason,
    citedTxs: readTexts(row.cited_txs),
    notChecked: readTexts(row.not_checked),
    facts: readFacts(row.facts),
    servRequestId: row.serv_request_id,
    decidedAt: readTimeOrNull(row.decided_at),
    slot: row.slot,
    appeal: readPublicAppeal(row),
  };
}

function readList(row: ListRow): ListVersion {
  return {
    campaignId: row.campaign_id,
    version: row.version,
    root: row.root,
    declaredTotal: row.declared_total,
    status: row.status as ListStatus,
    postTx: row.post_tx,
    postNonce: row.post_nonce === null ? null : Number(row.post_nonce),
    claimableAt: row.claimable_at === null ? null : Number(row.claimable_at),
    createdAt: readTime(row.created_at),
  };
}

function readRelay(row: RelayRow): Relay {
  return {
    campaignId: row.campaign_id,
    wallet: row.wallet as Address,
    version: row.version,
    amount: row.amount,
    status: row.status as RelayStatus,
    tx: row.tx,
    attempts: row.attempts,
    updatedAt: readTime(row.updated_at),
  };
}

async function lockCampaign(tx: Queryable, id: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(1005, hashtext($1))', [id]);
}

async function findCampaign(q: Queryable, id: string): Promise<Campaign | null> {
  const [row] = await q.query<CampaignRow>(
    `SELECT id, name, chain, vault, token, owner, agent, reward_per_wallet, per_wallet_cap, partial_share_bps, max_slots,
            rulebook, settings, status, opens_at, closes_at, created_at, vault_block::text AS vault_block
       FROM campaigns WHERE id = $1`,
    [id],
  );
  return row === undefined ? null : readCampaign(row);
}

/**
 * Records a campaign's terms. Its four addresses are stored in the one canonical form (C1), so the same terms in
 * another spelling are the same terms.
 * @returns 'created' for a new id, 'unchanged' when that id already holds exactly these terms. createdAt is not a term.
 * @throws AddressError from @thuli/core when an address is not one. StoreError when the id already holds different
 *   terms, or any value is out of range: an id outside 1 to 128 letters, digits, dots, dashes or underscores, a name
 *   that is not plain text of 1 to 80 characters, an amount that is not positive decimal digits within 256 bits, a
 *   reward above the cap, a partial share outside 1 to 9,999, max slots outside 1 to 100,000, settings that are not an
 *   object of known screening settings with valid values (an empty object is fine) or that give a partialShareBps other
 *   than the campaign's, a status other than open or closed, closesAt not after opensAt, or a vaultBlock that is
 *   neither left out, null, nor a bigint from 1 up to what a Postgres bigint holds. Every check runs before anything is
 *   written. vaultBlock is a term: left out it is null, and null differs from any block.
 */
export async function createCampaign(db: Db, campaign: CampaignInput): Promise<CreateCampaignResult> {
  const terms = campaignTerms(campaign);
  return db.transaction(async (tx) => {
    await lockCampaign(tx, terms.id);
    const existing = await findCampaign(tx, terms.id);
    if (existing !== null) {
      if (!sameTerms(existing, terms)) throw new StoreError(`campaign ${terms.id} already exists with different terms`);
      return 'unchanged';
    }
    await tx.query(
      `INSERT INTO campaigns (id, name, chain, vault, token, owner, agent, reward_per_wallet, per_wallet_cap,
                              partial_share_bps, max_slots, rulebook, status, opens_at, closes_at, created_at, settings,
                              vault_block)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15::timestamptz, $16::timestamptz,
               $17::jsonb, $18::bigint)`,
      [
        terms.id,
        terms.name,
        terms.chain,
        terms.vault,
        terms.token,
        terms.owner,
        terms.agent,
        terms.rewardPerWallet,
        terms.perWalletCap,
        terms.partialShareBps,
        terms.maxSlots,
        terms.rulebook,
        terms.status,
        terms.opensAt.toISOString(),
        terms.closesAt.toISOString(),
        terms.createdAt.toISOString(),
        JSON.stringify(terms.settings),
        terms.vaultBlock === null ? null : terms.vaultBlock.toString(),
      ],
    );
    return 'created';
  });
}

/** The campaign with this id, or null when there is none. An id no campaign could have is null, not an error. */
export async function getCampaign(db: Db, id: string): Promise<Campaign | null> {
  if (!isCampaignId(id)) return null;
  return findCampaign(db, id);
}

/**
 * Every campaign whose status is open, whatever its opens_at and closes_at, because the worker keeps posting lists and
 * paying claims after asks close. In id order by byte value, at most MAX_OPEN_CAMPAIGNS.
 * @param now checked like every caller's time, and not used to filter: only the status decides.
 * @throws StoreError when now is not a valid Date.
 */
export async function openCampaigns(db: Db, now: Date): Promise<Campaign[]> {
  instant(now);
  const rows = await db.query<CampaignRow>(
    `SELECT id, name, chain, vault, token, owner, agent, reward_per_wallet, per_wallet_cap, partial_share_bps, max_slots,
            rulebook, settings, status, opens_at, closes_at, created_at, vault_block::text AS vault_block
       FROM campaigns WHERE status = 'open'
      ORDER BY id COLLATE "C"
      LIMIT $1`,
    [MAX_OPEN_CAMPAIGNS],
  );
  return rows.map(readCampaign);
}

// A try handed back is 1 off the attempts, none otherwise. Checked whatever else the call says, so a flag that is not
// true or false is refused before anything is written.
function refundOf(options: { refundTry?: unknown }): 0 | 1 {
  if (options.refundTry === undefined) return 0;
  if (typeof options.refundTry !== 'boolean') throw new StoreError('refundTry must be true or false');
  return options.refundTry ? 1 : 0;
}

/**
 * The most asks a campaign of maxSlots slots ever takes: max(ASK_LIFETIME_MIN, ASK_LIFETIME_PER_SLOT times maxSlots).
 * Not a limit on screenings, which the backlog cap and the worker's own day count bound, but a sanity bound on how far
 * one campaign's rows can grow (C41).
 */
export function askLifetimeCap(maxSlots: number): number {
  return Math.max(ASK_LIFETIME_MIN, ASK_LIFETIME_PER_SLOT * maxSlots);
}

/**
 * Queues one wallet's signed ask to join a campaign. The signature must already have been checked; this stores it as
 * the wallet's proof. The wallet goes through parseAddress, so every spelling of it is one ask (C1, C42). Runs in one
 * transaction under the campaign's lock, and the insert itself can never write a second ask for a wallet.
 *
 * A campaign takes no ask it cannot seat or will not reach soon (C24): none once every slot is taken; none while
 * ASK_BACKLOG_CAP of its asks wait undecided, queued or screening, so a flood waits for the worker instead of growing
 * without end and room comes back as asks are decided; and none past askLifetimeCap(max_slots) asks in all. The
 * backlog counts what is waiting, not history, so a campaign whose earlier asks were all held stays open while it has
 * slots. Asks take no day count here: the worker counts the screenings it runs in its own day bucket.
 * @returns in this order: 'unknown' when no campaign has the id; 'exists' when the wallet already asked, whatever the
 *   time or the campaign's state, and the first ask is left exactly as it was; 'closed' when the campaign's status is
 *   closed or now is before opensAt or at or after closesAt; 'full' when its slots are all taken, its backlog is at the
 *   cap or its asks have reached the lifetime cap; otherwise 'queued'.
 * @throws AddressError from @thuli/core when the wallet is not an address. StoreError when signedAt is not whole
 *   seconds from 0, the signature is not 0x and 130 hex characters, or now is not a valid Date, each before anything is
 *   written.
 */
export async function addAsk(
  db: Db,
  ask: { campaignId: string; wallet: string; signedAt: number; signature: string },
  now: Date,
): Promise<AddAskResult> {
  const nowAt = instant(now);
  const wallet = parseAddress(ask.wallet);
  const signedAt = wholeNumber(ask.signedAt, 'signedAt', 0, Number.MAX_SAFE_INTEGER);
  if (typeof ask.signature !== 'string' || !SIGNATURE.test(ask.signature)) {
    throw new StoreError('a signature is 0x and 130 hex characters');
  }
  if (!isCampaignId(ask.campaignId)) return 'unknown';
  const campaignId = ask.campaignId;
  return db.transaction(async (tx) => {
    await lockCampaign(tx, campaignId);
    const [campaign] = await tx.query<{ open: boolean; max_slots: number }>(
      `SELECT status = 'open' AND opens_at <= $2::timestamptz AND $2::timestamptz < closes_at AS open, max_slots
         FROM campaigns WHERE id = $1`,
      [campaignId, nowAt],
    );
    if (campaign === undefined) return 'unknown';
    const [earlier] = await tx.query('SELECT 1 AS found FROM asks WHERE campaign_id = $1 AND wallet = $2', [campaignId, wallet]);
    if (earlier !== undefined) return 'exists';
    if (campaign.open !== true) return 'closed';
    const [held] = await tx.query<{ asked: number; waiting: number; taken: number }>(
      `SELECT count(*)::int AS asked, (count(*) FILTER (WHERE status IN ('queued', 'screening')))::int AS waiting,
              count(slot)::int AS taken
         FROM asks WHERE campaign_id = $1`,
      [campaignId],
    );
    if (
      (held?.taken ?? 0) >= campaign.max_slots ||
      (held?.waiting ?? 0) >= ASK_BACKLOG_CAP ||
      (held?.asked ?? 0) >= askLifetimeCap(campaign.max_slots)
    ) {
      return 'full';
    }
    const added = await tx.query(
      `INSERT INTO asks (campaign_id, wallet, signed_at, signature, asked_at, status, attempts)
       VALUES ($1, $2, $3::bigint, $4, $5::timestamptz, 'queued', 0)
       ON CONFLICT (campaign_id, wallet) DO NOTHING
       RETURNING wallet`,
      [campaignId, wallet, String(signedAt), ask.signature, nowAt],
    );
    // Under the campaign's lock the wallet was just found absent, so this cannot happen; if it does, it is refused
    // rather than answered as an ask that was added.
    if (added.length !== 1) throw new StoreError('the ask appeared while it was being added');
    return 'queued';
  });
}

/**
 * Hands the oldest ready ask, from any campaign, to one worker: an ask that is queued with no retry time or one at or
 * before now, or screening with a lease at or before now. An ask still waiting out its retry time never holds back the
 * asks behind it. The ask taken is marked screening with lease_until now plus leaseSeconds and one more attempt. A waiting ask
 * that has already had maxAttempts is never handed out again: in the same transaction it ends failed with the hold
 * releaseAsk gives, so a worker that dies on one ask every time cannot keep it in the queue for ever (C11, C41). The
 * take itself is one statement that skips rows another caller has locked, so two workers calling at once never get
 * the same ask.
 * @returns the ask taken, or null when none is waiting.
 * @throws StoreError when leaseSeconds is not a whole number from 1 to 86,400, maxAttempts not a whole number from 1
 *   to 100, or now is not a valid Date.
 */
export async function takeAsk(db: Db, now: Date, leaseSeconds: number, maxAttempts: number): Promise<TakenAsk | null> {
  wholeNumber(leaseSeconds, 'leaseSeconds', 1, MAX_LEASE_SECONDS);
  wholeNumber(maxAttempts, 'maxAttempts', 1, 100);
  const nowAt = instant(now);
  const leaseUntil = shifted(now, leaseSeconds);
  const row = await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE asks
          SET status = 'failed', lease_until = NULL, retry_at = NULL, action = 'hold', share_bps = 0, rule = 'A1',
              reason = $3::text, cited_txs = '[]'::jsonb, not_checked = '[]'::jsonb, facts = NULL, serv_request_id = NULL,
              decided_at = $1::timestamptz
        WHERE attempts >= $2::int AND (status = 'queued' OR (status = 'screening' AND lease_until <= $1::timestamptz))`,
      [nowAt, maxAttempts, HELD_REASON],
    );
    const [taken] = await tx.query<{ campaign_id: string; wallet: string; asked_at: unknown; attempts: number; lease_until: unknown }>(
      `WITH next AS (
         SELECT campaign_id, wallet FROM asks
          WHERE attempts < $3::int
            AND ((status = 'queued' AND (retry_at IS NULL OR retry_at <= $1::timestamptz))
                 OR (status = 'screening' AND lease_until <= $1::timestamptz))
          ORDER BY asked_at, campaign_id, wallet
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE asks SET status = 'screening', lease_until = $2::timestamptz, retry_at = NULL, attempts = asks.attempts + 1
         FROM next
        WHERE asks.campaign_id = next.campaign_id AND asks.wallet = next.wallet
       RETURNING asks.campaign_id, asks.wallet, asks.asked_at, asks.attempts, asks.lease_until`,
      [nowAt, leaseUntil, maxAttempts],
    );
    return taken;
  });
  if (row === undefined) return null;
  return {
    campaignId: row.campaign_id,
    wallet: row.wallet as Address,
    askedAt: readTime(row.asked_at),
    attempts: row.attempts,
    leaseUntil: readTime(row.lease_until),
  };
}

/**
 * Writes one screening's decision on an ask that is screening, and marks it decided. A full or partial ask takes the
 * next slot number while the campaign has fewer than max_slots slot holders, so slots go in the order asks are
 * decided and a number is never shared or used again (C44); a hold or exclude never takes one. The share must be the
 * one the campaign's terms give the action. Runs in one transaction under the campaign's lock. Which worker holds the
 * lease is not checked: the first decision to land on a screening ask stands.
 * @returns the slot given, or { slot: null } when the ask was decided without one; null when there is no such ask or it
 *   is not screening, in which case nothing changes.
 * @throws AddressError from @thuli/core when the wallet is not an address. StoreError when the action is not full,
 *   partial, hold or exclude, the share does not match it, the rule is not a known decision rule, the reason is not
 *   plain text of 1 to 400 characters (C13, C33), a cited transaction is not 0x and 64 lowercase hex or there are more
 *   than 256, notChecked holds more than 16 entries or one that is not plain text of 1 to 64 characters, the request id
 *   is malformed, facts does not have exactly the AskFacts keys (chain may be left out) or holds a value outside its
 *   shape (a funder address that is not an address and a chain that is not a ScreenedChain included), record is given
 *   but is not a JSON object of at most 16 KB, or now is not a valid Date. The funder address is stored canonical (C1),
 *   and facts given without a chain are stored with chain 'ethereum'. The record is private and no public view returns
 *   it (C40).
 */
export async function decideAsk(db: Db, decision: AskDecision, now: Date): Promise<{ slot: number | null } | null> {
  const nowAt = instant(now);
  const wallet = parseAddress(decision.wallet);
  const action = decision.action;
  if (!(OUTCOMES as readonly string[]).includes(action)) throw new StoreError('action must be full, partial, hold or exclude');
  const shareBps = wholeNumber(decision.shareBps, 'shareBps', 0, 10_000);
  if (!(DECISION_RULES as readonly string[]).includes(decision.rule)) throw new StoreError('rule must be one of the decision rules');
  const reason = plainTextOf(decision.reason, 'reason', MAX_ASK_REASON_CHARS);
  const { citedTxs, notChecked } = decision;
  if (!Array.isArray(citedTxs) || citedTxs.length > MAX_EVIDENCE_TXS) {
    throw new StoreError(`citedTxs must be a list of at most ${MAX_EVIDENCE_TXS} transaction hashes`);
  }
  citedTxs.forEach((hash, index) => txHashOf(hash, `citedTxs ${index}`));
  if (!Array.isArray(notChecked) || notChecked.length > MAX_NOT_CHECKED) {
    throw new StoreError(`notChecked must be a list of at most ${MAX_NOT_CHECKED} entries`);
  }
  notChecked.forEach((item, index) => plainTextOf(item, `notChecked ${index}`, MAX_NOT_CHECKED_CHARS));
  const facts = factsOf(decision.facts);
  let record: string | null = null;
  if (decision.record !== undefined) {
    const given: unknown = decision.record;
    if (typeof given !== 'object' || given === null || Array.isArray(given)) throw new StoreError('record must be a JSON object');
    let json: string | undefined;
    try {
      json = JSON.stringify(given);
    } catch {
      throw new StoreError('record cannot be written as JSON');
    }
    if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_RECORD_BYTES) {
      throw new StoreError(`record must be a JSON object of at most ${MAX_RECORD_BYTES} bytes`);
    }
    record = json;
  }
  const servRequestId = decision.servRequestId;
  if (servRequestId !== null && (typeof servRequestId !== 'string' || !REQUEST_ID.test(servRequestId))) {
    throw new StoreError('servRequestId must be null or 1 to 128 letters, digits, dots, colons, dashes or underscores');
  }
  if (!isCampaignId(decision.campaignId)) return null;
  const campaignId = decision.campaignId;
  return db.transaction(async (tx) => {
    await lockCampaign(tx, campaignId);
    const [ask] = await tx.query<{ status: string }>(
      'SELECT status FROM asks WHERE campaign_id = $1 AND wallet = $2 FOR UPDATE',
      [campaignId, wallet],
    );
    if (ask?.status !== 'screening') return null;
    const [terms] = await tx.query<{ max_slots: number; partial_share_bps: number }>(
      'SELECT max_slots, partial_share_bps FROM campaigns WHERE id = $1',
      [campaignId],
    );
    if (terms === undefined) return null;
    if (shareBps !== shareFor(action, { partialShareBps: terms.partial_share_bps })) {
      throw new StoreError("the share does not match the action under this campaign's terms");
    }
    let slot: number | null = null;
    if (action === 'full' || action === 'partial') {
      const [held] = await tx.query<{ taken: number; highest: number }>(
        'SELECT count(slot)::int AS taken, COALESCE(max(slot), 0)::int AS highest FROM asks WHERE campaign_id = $1',
        [campaignId],
      );
      // Numbered past the highest one held rather than from the count, so it can never match a number already held.
      if ((held?.taken ?? 0) < terms.max_slots) slot = (held?.highest ?? 0) + 1;
    }
    await tx.query(
      `UPDATE asks
          SET status = 'decided', lease_until = NULL, action = $3, share_bps = $4, rule = $5, reason = $6,
              cited_txs = $7::jsonb, not_checked = $8::jsonb, serv_request_id = $9, decided_at = $10::timestamptz, slot = $11,
              facts = $12::jsonb, record = $13::jsonb
        WHERE campaign_id = $1 AND wallet = $2`,
      [
        campaignId,
        wallet,
        action,
        shareBps,
        decision.rule,
        reason,
        JSON.stringify(citedTxs),
        JSON.stringify(notChecked),
        servRequestId,
        nowAt,
        slot,
        JSON.stringify(facts),
        record,
      ],
    );
    return { slot };
  });
}

/**
 * Gives back an ask whose screening could not finish. Below maxAttempts it is queued again, and takeAsk leaves it be
 * until now plus retryAfterSeconds, so an outage of the screening service is waited out instead of burning every
 * attempt in seconds; asks that are ready are taken meanwhile. At or past maxAttempts, it ends failed with the hold
 * every doubt ends in (C11): action hold, share 0, rule A1, the fixed reason "Held for review: the screening could not
 * finish.", no cited transactions, no facts and decided_at now. A failed ask never takes a slot. One statement, and
 * only on an ask that is screening.
 * @param retryAfterSeconds 0, the default, queues it ready at once; at most 86,400, so no ask waits more than a day (C41).
 * @param options.refundTry true when the try failed for a reason that was not the ask's own, such as a daily budget that
 *   is used up: the try is handed back, attempts falling by one but never below 0, in this same statement, and the ask
 *   is judged against maxAttempts as if the try had not been made. The retry wait still applies, so a refund alone can
 *   never make an ask loop without pause (C41). Left out or false, behaviour is unchanged.
 * @returns 'queued' or 'failed', or null when there is no such ask or it is not screening, in which case nothing changes.
 * @throws AddressError from @thuli/core when the wallet is not an address. StoreError when maxAttempts is not a whole
 *   number from 1 to 100, retryAfterSeconds not a whole number from 0 to 86,400, refundTry is given but is not true or
 *   false, or now is not a valid Date, each before anything is written.
 */
export async function releaseAsk(
  db: Db,
  campaignId: string,
  wallet: string,
  now: Date,
  maxAttempts: number,
  retryAfterSeconds = 0,
  options: { refundTry?: boolean } = {},
): Promise<ReleaseAskResult | null> {
  const nowAt = instant(now);
  const canonical = parseAddress(wallet);
  wholeNumber(maxAttempts, 'maxAttempts', 1, 100);
  const retryAt = shifted(now, wholeNumber(retryAfterSeconds, 'retryAfterSeconds', 0, MAX_RETRY_SECONDS));
  const refund = refundOf(options);
  if (!isCampaignId(campaignId)) return null;
  const [row] = await db.query<{ status: ReleaseAskResult }>(
    `UPDATE asks
        SET status = CASE WHEN GREATEST(attempts - $7::int, 0) < $3::int THEN 'queued' ELSE 'failed' END,
            attempts = GREATEST(attempts - $7::int, 0),
            lease_until = NULL,
            retry_at = CASE WHEN GREATEST(attempts - $7::int, 0) < $3::int THEN $6::timestamptz ELSE NULL END,
            action = CASE WHEN GREATEST(attempts - $7::int, 0) < $3::int THEN NULL ELSE 'hold' END,
            share_bps = CASE WHEN GREATEST(attempts - $7::int, 0) < $3::int THEN NULL ELSE 0 END,
            rule = CASE WHEN GREATEST(attempts - $7::int, 0) < $3::int THEN NULL ELSE 'A1' END,
            reason = CASE WHEN GREATEST(attempts - $7::int, 0) < $3::int THEN NULL ELSE $4::text END,
            cited_txs = CASE WHEN GREATEST(attempts - $7::int, 0) < $3::int THEN NULL ELSE '[]'::jsonb END,
            not_checked = CASE WHEN GREATEST(attempts - $7::int, 0) < $3::int THEN NULL ELSE '[]'::jsonb END,
            facts = NULL,
            decided_at = CASE WHEN GREATEST(attempts - $7::int, 0) < $3::int THEN NULL ELSE $5::timestamptz END
      WHERE campaign_id = $1 AND wallet = $2 AND status = 'screening'
     RETURNING status`,
    [campaignId, canonical, maxAttempts, HELD_REASON, nowAt, retryAt, refund],
  );
  return row?.status ?? null;
}

export type RequeueRefusal = 'no failed ask from this wallet' | 'the ask has an appeal';
/** Whether requeueFailedAsk moved the ask, and when it did not, the fixed cause. */
export type RequeueResult = { requeued: true } | { requeued: false; cause: RequeueRefusal };

/**
 * Puts an ask that failed, because every try at screening it ran out during an outage, back in the queue to be
 * screened again from the start: status queued, no attempts, no retry time, and the A1 hold cleared. It keeps its
 * signature and its place by when it asked. For an operator's command once the outage is over. A decided ask is never
 * re-screened this way, a decided hold included: only a failed ask, which never took a slot, moves, so no command can
 * approve a wallet (C11). A failed ask that has an appeal never moves either, so the appeal and the outside check always
 * judge the decision that was appealed (C11, C17). Under the campaign's lock, which addAppeal takes too, so no appeal
 * can be filed between the check and the move; one row (C41). now is checked like every caller's time; the ask keeps
 * no requeue time of its own.
 * @returns { requeued: true } when the ask was failed and is now queued; otherwise, changing nothing, { requeued: false }
 *   with 'the ask has an appeal' or, for any other ask or none, 'no failed ask from this wallet'.
 * @throws AddressError from @thuli/core when the wallet is not an address. StoreError when now is not a valid Date.
 */
export async function requeueFailedAsk(db: Db, campaignId: string, wallet: string, now: Date): Promise<RequeueResult> {
  instant(now);
  const canonical = parseAddress(wallet);
  if (!isCampaignId(campaignId)) return { requeued: false, cause: 'no failed ask from this wallet' };
  return db.transaction(async (tx): Promise<RequeueResult> => {
    await lockCampaign(tx, campaignId);
    const [appealed] = await tx.query('SELECT 1 AS found FROM appeals WHERE campaign_id = $1 AND wallet = $2', [campaignId, canonical]);
    if (appealed !== undefined) return { requeued: false, cause: 'the ask has an appeal' };
    const rows = await tx.query(
      `UPDATE asks
          SET status = 'queued', attempts = 0, retry_at = NULL, lease_until = NULL, action = NULL, share_bps = NULL,
              rule = NULL, reason = NULL, cited_txs = NULL, not_checked = NULL, facts = NULL, serv_request_id = NULL,
              decided_at = NULL
        WHERE campaign_id = $1 AND wallet = $2 AND status = 'failed' AND slot IS NULL
       RETURNING wallet`,
      [campaignId, canonical],
    );
    return rows.length === 1 ? { requeued: true } : { requeued: false, cause: 'no failed ask from this wallet' };
  });
}

/**
 * The public view of one ask, never its signature or lease (C40). The wallet goes through parseAddress, so any
 * spelling finds the one ask (C1).
 * @returns the ask, or null when there is none.
 * @throws AddressError from @thuli/core when the wallet is not an address.
 */
export async function getAsk(db: Db, campaignId: string, wallet: string): Promise<PublicAsk | null> {
  const canonical = parseAddress(wallet);
  if (!isCampaignId(campaignId)) return null;
  const [row] = await db.query<AskRow>(
    `SELECT a.campaign_id, a.wallet, a.asked_at, a.status, a.action, a.share_bps, a.rule, a.reason, a.cited_txs, a.not_checked,
            a.facts, a.serv_request_id, a.decided_at, a.slot,
            ap.filed_at AS appeal_filed_at, ap.check_status AS appeal_check_status, ap.reppo_route AS appeal_reppo_route,
            ap.reppo_note AS appeal_reppo_note, ap.reppo_eval_id AS appeal_reppo_eval_id, ap.checked_at AS appeal_checked_at,
            ap.outcome AS appeal_outcome, ap.new_action AS appeal_new_action, ap.settled_at AS appeal_settled_at
       FROM asks a LEFT JOIN appeals ap ON ap.campaign_id = a.campaign_id AND ap.wallet = a.wallet
      WHERE a.campaign_id = $1 AND a.wallet = $2`,
    [campaignId, canonical],
  );
  return row === undefined ? null : readPublicAsk(row);
}

/**
 * A campaign's decided and failed asks, newest decision first, in the public view, one page at a time. A page ends
 * only between two different decided_at values: it holds the newest limit asks plus every other ask decided at the
 * same instant as the last of them, so the next page, asked for with beforeDecidedAt set to that instant, misses
 * nothing. Asks decided at the same instant come in wallet order. One statement, so a page is read from one snapshot.
 * Not covered: a page holds at most limit plus MAX_BOARD_TIES asks, so more than 100 further asks decided in the same
 * millisecond would still be cut. One worker decides one ask at a time, so that needs many workers on one clock tick.
 * @param limit 1 to 100.
 * @param beforeDecidedAt when given, only asks decided strictly before it.
 * @throws StoreError when limit is not a whole number from 1 to 100 or beforeDecidedAt is not a valid Date.
 */
export async function board(db: Db, campaignId: string, limit: number, beforeDecidedAt?: Date): Promise<PublicAsk[]> {
  wholeNumber(limit, 'limit', 1, MAX_BOARD_PAGE);
  const before = beforeDecidedAt === undefined ? null : timeOf(beforeDecidedAt, 'beforeDecidedAt');
  if (!isCampaignId(campaignId)) return [];
  // The limit-th newest decision sets the page's floor; every ask at or after it, before the cursor, is on the page.
  const rows = await db.query<AskRow>(
    `WITH newest AS (
       SELECT decided_at FROM asks
        WHERE campaign_id = $1 AND status IN ('decided', 'failed') AND ($2::timestamptz IS NULL OR decided_at < $2::timestamptz)
        ORDER BY decided_at DESC, wallet
        LIMIT $3
     )
     SELECT a.campaign_id, a.wallet, a.asked_at, a.status, a.action, a.share_bps, a.rule, a.reason, a.cited_txs, a.not_checked,
            a.facts, a.serv_request_id, a.decided_at, a.slot,
            ap.filed_at AS appeal_filed_at, ap.check_status AS appeal_check_status, ap.reppo_route AS appeal_reppo_route,
            ap.reppo_note AS appeal_reppo_note, ap.reppo_eval_id AS appeal_reppo_eval_id, ap.checked_at AS appeal_checked_at,
            ap.outcome AS appeal_outcome, ap.new_action AS appeal_new_action, ap.settled_at AS appeal_settled_at
       FROM asks a LEFT JOIN appeals ap ON ap.campaign_id = a.campaign_id AND ap.wallet = a.wallet
      WHERE a.campaign_id = $1 AND a.status IN ('decided', 'failed') AND ($2::timestamptz IS NULL OR a.decided_at < $2::timestamptz)
        AND a.decided_at >= (SELECT min(decided_at) FROM newest)
      ORDER BY a.decided_at DESC, a.wallet
      LIMIT $4`,
    [campaignId, before, limit, limit + MAX_BOARD_TIES],
  );
  return rows.map(readPublicAsk);
}

/** The most wallets one confirmedPayouts call looks up: a board page with its ties. */
export const MAX_PAYOUT_WALLETS = MAX_BOARD_PAGE + MAX_BOARD_TIES;

/**
 * What the vault has paid each of the given wallets in one campaign, as the worker recorded it: for each wallet, its
 * newest confirmed claim relay, and only when that relay has a transaction. A relay's amount is cumulative, so the
 * newest confirmed one is the total paid to that wallet so far, and its transaction is the claim that brought it there.
 * A wallet whose newest confirmed relay has no transaction is left out, rather than shown with an older list's smaller
 * amount. A confirmed relay holds a transaction only when the worker read that transaction's receipt as successful and
 * wrote that very hash with the confirmation; one confirmed because the vault had nothing left to pay is recorded with
 * forgetTx (see markRelay), so a claim of ours that reverted or never landed is never shown as the payout.
 * Not covered: a claim a wallet or anyone else submitted with the public ticket has no relay transaction, so that
 * wallet does not show here even though the vault paid it.
 * @param wallets canonical addresses, as the asks table stores them; at most MAX_PAYOUT_WALLETS.
 * @throws StoreError when more than MAX_PAYOUT_WALLETS wallets are given or one of them is not text.
 */
export async function confirmedPayouts(db: Db, campaignId: string, wallets: readonly string[]): Promise<Payout[]> {
  if (wallets.length > MAX_PAYOUT_WALLETS) throw new StoreError(`at most ${MAX_PAYOUT_WALLETS} wallets in one call`);
  if (wallets.some((wallet) => typeof wallet !== 'string')) throw new StoreError('every wallet must be text');
  if (!isCampaignId(campaignId) || wallets.length === 0) return [];
  // The wallets travel as one JSON text, which both database drivers pass the same way.
  const rows = await db.query<{ wallet: string; amount: string; tx: string }>(
    `SELECT wallet, amount, tx
       FROM (
         SELECT DISTINCT ON (wallet) wallet, amount, tx
           FROM claim_relays
          WHERE campaign_id = $1 AND status = 'confirmed'
            AND wallet IN (SELECT jsonb_array_elements_text($2::jsonb))
          ORDER BY wallet, version DESC
       ) AS newest
      WHERE tx IS NOT NULL`,
    [campaignId, JSON.stringify(wallets)],
  );
  return rows.map((row) => ({ wallet: row.wallet as Address, amount: row.amount, tx: row.tx }));
}

/**
 * How a campaign's asks stand, as CampaignCounts defines each number. slotsLeft is max_slots less the slots taken, and
 * asksLeft is askLifetimeCap(max_slots) less the asks so far.
 * @returns the counts, or null when no campaign has the id.
 */
export async function counts(db: Db, campaignId: string): Promise<CampaignCounts | null> {
  if (!isCampaignId(campaignId)) return null;
  // One appeal per ask at most, so joining appeals never counts an ask twice.
  const [row] = await db.query<{
    max_slots: number;
    asked: number;
    queued: number;
    decided: number;
    held: number;
    slots_taken: number;
    appeals_filed: number;
    appeals_checked: number;
    appeals_block: number;
    appeals_reversed: number;
  }>(
    `SELECT c.max_slots,
            count(a.wallet)::int AS asked,
            (count(a.wallet) FILTER (WHERE a.status IN ('queued', 'screening')))::int AS queued,
            (count(a.wallet) FILTER (WHERE a.status IN ('decided', 'failed')))::int AS decided,
            (count(a.wallet) FILTER (WHERE a.action = 'hold'))::int AS held,
            count(a.slot)::int AS slots_taken,
            count(ap.wallet)::int AS appeals_filed,
            (count(ap.wallet) FILTER (WHERE ap.check_status = 'checked'))::int AS appeals_checked,
            (count(ap.wallet) FILTER (WHERE ap.reppo_route = 'block'))::int AS appeals_block,
            (count(ap.wallet) FILTER (WHERE ap.outcome = 'reversed'))::int AS appeals_reversed
       FROM campaigns c
       LEFT JOIN asks a ON a.campaign_id = c.id
       LEFT JOIN appeals ap ON ap.campaign_id = a.campaign_id AND ap.wallet = a.wallet
      WHERE c.id = $1
      GROUP BY c.id, c.max_slots`,
    [campaignId],
  );
  if (row === undefined) return null;
  return {
    asked: row.asked,
    queued: row.queued,
    decided: row.decided,
    held: row.held,
    slotsTaken: row.slots_taken,
    slotsLeft: Math.max(0, row.max_slots - row.slots_taken),
    asksLeft: Math.max(0, askLifetimeCap(row.max_slots) - row.asked),
    appeals: {
      filed: row.appeals_filed,
      checked: row.appeals_checked,
      block: row.appeals_block,
      reversed: row.appeals_reversed,
    },
  };
}

/**
 * Every decided ask of a campaign whose facts name a first funder, oldest decision first, with that funder's canonical
 * address and kind. Failed asks carry no facts, so they never appear. Asks decided at the same instant come in wallet
 * order. A campaign holds at most askLifetimeCap(max_slots) asks, so this is at most that many rows; the query's own
 * limit, MAX_FUNDER_LINKS, is that cap for the largest campaign allowed (C41).
 */
export async function funderLinks(db: Db, campaignId: string): Promise<FunderLink[]> {
  if (!isCampaignId(campaignId)) return [];
  const rows = await db.query<{ wallet: string; funder_address: string; funder_kind: string; decided_at: unknown }>(
    `SELECT wallet, facts -> 'funder' ->> 'address' AS funder_address, facts -> 'funder' ->> 'kind' AS funder_kind, decided_at
       FROM asks
      WHERE campaign_id = $1 AND status IN ('decided', 'failed') AND jsonb_typeof(facts -> 'funder') = 'object'
      ORDER BY decided_at, wallet
      LIMIT $2`,
    [campaignId, MAX_FUNDER_LINKS],
  );
  return rows.map((row) => ({
    wallet: row.wallet as Address,
    funderAddress: row.funder_address as Address,
    funderKind: row.funder_kind,
    decidedAt: readTime(row.decided_at),
  }));
}

/** Every wallet holding a slot in a campaign, in slot order. At most max_slots rows, which is at most 100,000. */
export async function slotHolders(db: Db, campaignId: string): Promise<SlotHolder[]> {
  if (!isCampaignId(campaignId)) return [];
  const rows = await db.query<{ wallet: string; action: string; share_bps: number; slot: number }>(
    'SELECT wallet, action, share_bps, slot FROM asks WHERE campaign_id = $1 AND slot IS NOT NULL ORDER BY slot',
    [campaignId],
  );
  return rows.map((row) => ({
    wallet: row.wallet as Address,
    action: row.action as 'full' | 'partial',
    shareBps: row.share_bps,
    slot: row.slot,
  }));
}

/**
 * Records a new list version for a campaign, status built, numbered one past the newest. The published text is kept
 * exactly as given, so listText hands back the same characters anyone rebuilds the root from (C32). Runs in one
 * transaction under the campaign's lock.
 * @returns the new version number, 1 for a campaign's first list.
 * @throws StoreError when no campaign has the id, the newest version already has this root, the root is not 0x and 64
 *   lowercase hex, the published text is not a JSON array of at most 12,000,000 characters, the declared total is not
 *   decimal digits within 256 bits, or now is not a valid Date.
 */
export async function addListVersion(
  db: Db,
  list: { campaignId: string; root: string; publishedList: string; declaredTotal: string },
  now: Date,
): Promise<number> {
  const nowAt = instant(now);
  const campaignId = campaignIdOf(list.campaignId);
  if (typeof list.root !== 'string' || !ROOT.test(list.root)) throw new StoreError('the root must be 0x and 64 lowercase hex characters');
  const declaredTotal = amountOf(list.declaredTotal, 'declaredTotal', 0n);
  const text = list.publishedList;
  if (typeof text !== 'string' || text.length < 2 || text.length > MAX_PUBLISHED_CHARS) {
    throw new StoreError(`the published list must be 2 to ${MAX_PUBLISHED_CHARS} characters`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StoreError('the published list is not JSON');
  }
  if (!Array.isArray(parsed)) throw new StoreError('the published list is not a JSON array');
  return db.transaction(async (tx) => {
    await lockCampaign(tx, campaignId);
    const [campaign] = await tx.query('SELECT 1 AS found FROM campaigns WHERE id = $1', [campaignId]);
    if (campaign === undefined) throw new StoreError('no campaign has this id');
    const [newest] = await tx.query<{ version: number; root: string }>(
      'SELECT version, root FROM list_versions WHERE campaign_id = $1 ORDER BY version DESC LIMIT 1',
      [campaignId],
    );
    if (newest?.root === list.root) throw new StoreError('the newest list version already has this root');
    const version = (newest?.version ?? 0) + 1;
    await tx.query(
      `INSERT INTO list_versions (campaign_id, version, root, published_list, declared_total, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'built', $6::timestamptz)`,
      [campaignId, version, list.root, text, declaredTotal, nowAt],
    );
    return version;
  });
}

/**
 * The worker has broadcast the transaction that posts a built version's root, and records its hash before it waits for
 * the transaction to be mined. A stop or a timeout during that wait then leaves a record that the root may already be
 * on the vault, so the list is settled by markListPosted or markListUnsent and never posted a second time (C27, C32).
 * The transaction's nonce is kept with its hash, because a replacement sent at the same nonce is the only other
 * transaction that can land in its place. now is checked like every caller's time; the version keeps no send time of
 * its own. One statement.
 * @param sent.postNonce the posting transaction's nonce, a whole number from 0. Every new caller gives it; left out, as
 *   callers from before it existed do, no nonce is kept.
 * @returns true when the version was built and is now sending; false, changing nothing, for any other version.
 * @throws StoreError when version is not a whole number from 1, postTx is not 0x and 64 lowercase hex, postNonce is
 *   given but is not a whole number from 0, or now is not a valid Date, each before anything is written.
 */
export async function markListSending(
  db: Db,
  campaignId: string,
  version: number,
  sent: { postTx: string; postNonce?: number },
  now: Date,
): Promise<boolean> {
  wholeNumber(version, 'version', 1, MAX_INTEGER);
  const postTx = txHashOf(sent.postTx, 'postTx');
  const postNonce = sent.postNonce === undefined ? null : wholeNumber(sent.postNonce, 'postNonce', 0, Number.MAX_SAFE_INTEGER);
  instant(now);
  if (!isCampaignId(campaignId)) return false;
  const rows = await db.query(
    `UPDATE list_versions SET status = 'sending', post_tx = $3, post_nonce = $4::bigint
      WHERE campaign_id = $1 AND version = $2 AND status = 'built'
     RETURNING version`,
    [campaignId, version, postTx, postNonce === null ? null : String(postNonce)],
  );
  return rows.length === 1;
}

/**
 * A sending version's transaction was replaced by one at the same nonce, a higher fee for one the network left
 * unmined: the stored hash becomes the new one and the nonce stays, so the record still names every transaction that
 * could land (C27, C32). now is checked like every caller's time. One statement.
 * @returns true when the version was sending and now holds postTx; false, changing nothing, for any other version.
 * @throws StoreError when version is not a whole number from 1, postTx is not 0x and 64 lowercase hex, or now is not a
 *   valid Date.
 */
export async function markListResent(
  db: Db,
  campaignId: string,
  version: number,
  resent: { postTx: string },
  now: Date,
): Promise<boolean> {
  wholeNumber(version, 'version', 1, MAX_INTEGER);
  const postTx = txHashOf(resent.postTx, 'postTx');
  instant(now);
  if (!isCampaignId(campaignId)) return false;
  const rows = await db.query(
    `UPDATE list_versions SET post_tx = $3
      WHERE campaign_id = $1 AND version = $2 AND status = 'sending'
     RETURNING version`,
    [campaignId, version, postTx],
  );
  return rows.length === 1;
}

/**
 * A sending version's transaction was reverted, or the network does not know it after the worker's wait, so its root
 * never reached the vault: the version is built again, with no hash and no nonce, and may be sent anew. One statement.
 * @returns true when the version was sending and is now built; false, changing nothing, for any other version.
 * @throws StoreError when version is not a whole number from 1.
 */
export async function markListUnsent(db: Db, campaignId: string, version: number): Promise<boolean> {
  wholeNumber(version, 'version', 1, MAX_INTEGER);
  if (!isCampaignId(campaignId)) return false;
  const rows = await db.query(
    `UPDATE list_versions SET status = 'built', post_tx = NULL, post_nonce = NULL
      WHERE campaign_id = $1 AND version = $2 AND status = 'sending'
     RETURNING version`,
    [campaignId, version],
  );
  return rows.length === 1;
}

/**
 * A version's root is on the vault and can be claimed from claimableAt, in Unix seconds, which is always given because
 * the vault holds it. The normal path is from sending: postTx replaces the stored hash, and null keeps it. From built,
 * it is a root the worker found pending on the vault after a restart with no record of sending it, and postTx is the
 * hash if the worker learned it, or null.
 * @returns true when the version was sending or built and is now posted; false, changing nothing, for any other version.
 * @throws StoreError when version is not a whole number from 1, postTx is neither null nor 0x and 64 lowercase hex,
 *   or claimableAt is not whole seconds from 0.
 */
export async function markListPosted(
  db: Db,
  campaignId: string,
  version: number,
  posted: { postTx: string | null; claimableAt: number },
): Promise<boolean> {
  wholeNumber(version, 'version', 1, MAX_INTEGER);
  const postTx = posted.postTx === null ? null : txHashOf(posted.postTx, 'postTx');
  const claimableAt = wholeNumber(posted.claimableAt, 'claimableAt', 0, Number.MAX_SAFE_INTEGER);
  if (!isCampaignId(campaignId)) return false;
  const rows = await db.query(
    `UPDATE list_versions SET status = 'posted', post_tx = COALESCE($3::text, post_tx), claimable_at = $4::bigint
      WHERE campaign_id = $1 AND version = $2 AND status IN ('built', 'sending')
     RETURNING version`,
    [campaignId, version, postTx, String(claimableAt)],
  );
  return rows.length === 1;
}

/**
 * A posted version's root is now the vault's active root. The version active before it, if any, becomes superseded,
 * so a campaign has one active list, as the vault has one active root. Runs in one transaction under the campaign's
 * lock.
 * @returns true when the version was posted and is now active; false, changing nothing, for any other version.
 * @throws StoreError when version is not a whole number from 1.
 */
export async function markListActive(db: Db, campaignId: string, version: number): Promise<boolean> {
  wholeNumber(version, 'version', 1, MAX_INTEGER);
  if (!isCampaignId(campaignId)) return false;
  return db.transaction(async (tx) => {
    await lockCampaign(tx, campaignId);
    const [target] = await tx.query<{ status: string }>(
      'SELECT status FROM list_versions WHERE campaign_id = $1 AND version = $2 FOR UPDATE',
      [campaignId, version],
    );
    if (target?.status !== 'posted') return false;
    await tx.query("UPDATE list_versions SET status = 'superseded' WHERE campaign_id = $1 AND status = 'active'", [campaignId]);
    await tx.query("UPDATE list_versions SET status = 'active' WHERE campaign_id = $1 AND version = $2", [campaignId, version]);
    return true;
  });
}

/**
 * A version that never became active is cancelled: one built but never posted, or posted and then cancelled on chain
 * by the owner's cancelRoot inside its delay. An active or superseded version has already been claimable, so it cannot
 * be cancelled, and neither can one already cancelled. A sending version cannot be either: whether its root reached the
 * vault is not yet known, so it is first settled by markListPosted or markListUnsent.
 * @returns true when the version was built or posted and is now cancelled; false, changing nothing, otherwise.
 * @throws StoreError when version is not a whole number from 1.
 */
export async function markListCancelled(db: Db, campaignId: string, version: number): Promise<boolean> {
  wholeNumber(version, 'version', 1, MAX_INTEGER);
  if (!isCampaignId(campaignId)) return false;
  const rows = await db.query(
    `UPDATE list_versions SET status = 'cancelled'
      WHERE campaign_id = $1 AND version = $2 AND status IN ('built', 'posted')
     RETURNING version`,
    [campaignId, version],
  );
  return rows.length === 1;
}

/** The newest list version of a campaign, whatever its status, without its text; null when it has none. */
export async function latestList(db: Db, campaignId: string): Promise<ListVersion | null> {
  if (!isCampaignId(campaignId)) return null;
  const [row] = await db.query<ListRow>(
    `SELECT campaign_id, version, root, declared_total, status, post_tx, post_nonce::text AS post_nonce,
            claimable_at::text AS claimable_at, created_at
       FROM list_versions WHERE campaign_id = $1 ORDER BY version DESC LIMIT 1`,
    [campaignId],
  );
  return row === undefined ? null : readList(row);
}

/** The campaign's active list version without its text; null when none is active. */
export async function activeList(db: Db, campaignId: string): Promise<ListVersion | null> {
  if (!isCampaignId(campaignId)) return null;
  const [row] = await db.query<ListRow>(
    `SELECT campaign_id, version, root, declared_total, status, post_tx, post_nonce::text AS post_nonce,
            claimable_at::text AS claimable_at, created_at
       FROM list_versions WHERE campaign_id = $1 AND status = 'active'`,
    [campaignId],
  );
  return row === undefined ? null : readList(row);
}

/** Every list version of a campaign, oldest first, without their text. Only the worker adds versions. */
export async function listVersions(db: Db, campaignId: string): Promise<ListVersion[]> {
  if (!isCampaignId(campaignId)) return [];
  const rows = await db.query<ListRow>(
    `SELECT campaign_id, version, root, declared_total, status, post_tx, post_nonce::text AS post_nonce,
            claimable_at::text AS claimable_at, created_at
       FROM list_versions WHERE campaign_id = $1 ORDER BY version`,
    [campaignId],
  );
  return rows.map(readList);
}

/**
 * One version's published text exactly as stored, so anyone can rebuild its root (C32).
 * @returns the text, or null when there is no such version.
 * @throws StoreError when version is not a whole number from 1.
 */
export async function listText(db: Db, campaignId: string, version: number): Promise<string | null> {
  wholeNumber(version, 'version', 1, MAX_INTEGER);
  if (!isCampaignId(campaignId)) return null;
  const [row] = await db.query<{ published_list: string }>(
    'SELECT published_list FROM list_versions WHERE campaign_id = $1 AND version = $2',
    [campaignId, version],
  );
  return row?.published_list ?? null;
}

/**
 * Queues one pending relay per wallet for a campaign's active list version, leaving every wallet already queued for
 * that version exactly as it is, so calling again never adds a second row or resets one. Each wallet goes through
 * parseAddress first, so two spellings in one call are one wallet (C1). One insert, in one transaction under the
 * campaign's lock.
 * @returns how many relays were added.
 * @throws AddressError from @thuli/core when a wallet is not an address. StoreError when the version is not the
 *   campaign's active one, entries holds more than 100,000 wallets, an amount is not positive decimal digits within 256
 *   bits, one wallet comes with two different amounts, or now is not a valid Date.
 */
export async function queueRelays(
  db: Db,
  campaignId: string,
  version: number,
  entries: readonly { wallet: string; amount: string }[],
  now: Date,
): Promise<number> {
  const nowAt = instant(now);
  const id = campaignIdOf(campaignId);
  wholeNumber(version, 'version', 1, MAX_INTEGER);
  if (!Array.isArray(entries) || entries.length > MAX_LIST_ENTRIES) {
    throw new StoreError(`entries must be a list of at most ${MAX_LIST_ENTRIES} wallets`);
  }
  const amounts = new Map<Address, string>();
  entries.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new StoreError(`entries ${index} must be a wallet and an amount`);
    const wallet = parseAddress(entry.wallet);
    const amount = amountOf(entry.amount, `entries ${index} amount`, 1n);
    const earlier = amounts.get(wallet);
    if (earlier !== undefined && earlier !== amount) throw new StoreError(`entries ${index} gives a wallet a second amount`);
    amounts.set(wallet, amount);
  });
  if (amounts.size === 0) return 0;
  const rows = JSON.stringify([...amounts].map(([wallet, amount]) => ({ wallet, amount })));
  return db.transaction(async (tx) => {
    await lockCampaign(tx, id);
    const [list] = await tx.query<{ status: string }>(
      'SELECT status FROM list_versions WHERE campaign_id = $1 AND version = $2',
      [id, version],
    );
    if (list?.status !== 'active') throw new StoreError("relays are queued only for the campaign's active list version");
    const [row] = await tx.query<{ added: number }>(
      `WITH added AS (
         INSERT INTO claim_relays (campaign_id, wallet, version, amount, status, tx, attempts, updated_at)
         SELECT $1::text, entry.wallet, $2::int, entry.amount, 'pending', NULL, 0, $4::timestamptz
           FROM jsonb_to_recordset($3::jsonb) AS entry (wallet text, amount text)
         ON CONFLICT (campaign_id, wallet, version) DO NOTHING
         RETURNING 1
       )
       SELECT count(*)::int AS added FROM added`,
      [id, version, rows, nowAt],
    );
    return row?.added ?? 0;
  });
}

/**
 * Hands the oldest ready relay to one worker: one pending with no retry time or one at or before now, or sent and last
 * touched at or before now less leaseSeconds, whose holder is taken to have stopped. A relay still waiting out its retry
 * time never holds back the ones behind it. It is marked sent with one more attempt and updated_at now, and
 * the worker holds it until updated_at plus leaseSeconds. First, in the same transaction, a relay whose lease ran out
 * on its last allowed attempt is marked failed, so none gets more than MAX_RELAY_ATTEMPTS. The take is one statement
 * that skips rows another caller has locked, so two workers calling at once never get the same relay.
 * @returns the relay taken, or null when none is waiting.
 * @throws StoreError when leaseSeconds is not a whole number from 1 to 86,400 or now is not a valid Date.
 */
export async function takeRelay(db: Db, now: Date, leaseSeconds: number): Promise<Relay | null> {
  wholeNumber(leaseSeconds, 'leaseSeconds', 1, MAX_LEASE_SECONDS);
  const nowAt = instant(now);
  const staleAt = shifted(now, -leaseSeconds);
  const row = await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE claim_relays SET status = 'failed', updated_at = $1::timestamptz, retry_at = NULL
        WHERE attempts >= $3::int AND (status = 'pending' OR (status = 'sent' AND updated_at <= $2::timestamptz))`,
      [nowAt, staleAt, MAX_RELAY_ATTEMPTS],
    );
    const [taken] = await tx.query<RelayRow>(
      `WITH next AS (
         SELECT campaign_id, wallet, version FROM claim_relays
          WHERE attempts < $3::int
            AND ((status = 'pending' AND (retry_at IS NULL OR retry_at <= $1::timestamptz))
                 OR (status = 'sent' AND updated_at <= $2::timestamptz))
          ORDER BY updated_at, campaign_id, version, wallet
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE claim_relays SET status = 'sent', attempts = claim_relays.attempts + 1, updated_at = $1::timestamptz, retry_at = NULL
         FROM next
        WHERE claim_relays.campaign_id = next.campaign_id AND claim_relays.wallet = next.wallet
          AND claim_relays.version = next.version
       RETURNING claim_relays.campaign_id, claim_relays.wallet, claim_relays.version, claim_relays.amount,
                 claim_relays.status, claim_relays.tx, claim_relays.attempts, claim_relays.updated_at`,
      [nowAt, staleAt, MAX_RELAY_ATTEMPTS],
    );
    return taken;
  });
  return row === undefined ? null : readRelay(row);
}

/**
 * Records what became of a relay a worker holds (status sent): 'sent' keeps holding it and restarts its lease, for
 * example once the claim is broadcast; 'confirmed' and 'failed' end it, and takeRelay never hands it out again (C27);
 * 'pending' gives it back for another attempt, which takeRelay leaves be until now plus retryAfterSeconds so a chain
 * outage is waited out, or ends it failed when it has had MAX_RELAY_ATTEMPTS. retryAfterSeconds counts only with
 * 'pending'. tx, when given, replaces the stored hash; null or left out keeps it. A claim the vault refuses because
 * nothing is left to claim is confirmed with no tx of ours. Which worker holds the lease is not checked, and a relay
 * takeRelay already failed is left failed even if a late claim landed; the vault pays each wallet only what it has not
 * yet claimed (C27), so neither case can pay twice.
 * @param result.retryAfterSeconds 0, the default, makes it ready at once; at most 86,400 (C41).
 * @param result.refundTry with 'pending' only: true when the try failed for a reason that was not the relay's own, such
 *   as a paused vault, so the try is handed back in this same statement, attempts falling by one but never below 0, and
 *   the relay is judged against MAX_RELAY_ATTEMPTS as if the try had not been made. The retry wait still applies, so a
 *   refund alone can never make a relay loop without pause (C41). Left out or false, behaviour is unchanged.
 * @param result.forgetTx true drops the transaction recorded for the relay. For a relay confirmed without a receipt of
 *   its own: the vault already owed the wallet nothing, so whatever claim was recorded before is not known to be the one
 *   that paid. It cannot be given together with a tx. Left out or false, the recorded transaction is kept.
 * @returns the status the relay ended in, or null when there is no such relay or it was not sent, changing nothing.
 * @throws AddressError from @thuli/core when the wallet is not an address. StoreError when the status is not pending,
 *   sent, confirmed or failed, tx is not 0x and 64 lowercase hex, retryAfterSeconds is not a whole number from 0 to
 *   86,400, refundTry or forgetTx is given but is not true or false, forgetTx is true with a tx, version is not a
 *   whole number from 1, or now is not a valid Date, each before anything is written.
 */
export async function markRelay(
  db: Db,
  key: RelayKey,
  result: { status: RelayStatus; tx?: string | null; retryAfterSeconds?: number; refundTry?: boolean; forgetTx?: boolean },
  now: Date,
): Promise<RelayStatus | null> {
  const nowAt = instant(now);
  const wallet = parseAddress(key.wallet);
  wholeNumber(key.version, 'version', 1, MAX_INTEGER);
  if (!RELAY_STATUSES.includes(result.status)) throw new StoreError('status must be pending, sent, confirmed or failed');
  const tx = result.tx === undefined || result.tx === null ? null : txHashOf(result.tx, 'tx');
  const delay = wholeNumber(result.retryAfterSeconds ?? 0, 'retryAfterSeconds', 0, MAX_RETRY_SECONDS);
  const retryAt = result.status === 'pending' ? shifted(now, delay) : null;
  const refundTry = refundOf(result);
  const refund = result.status === 'pending' ? refundTry : 0;
  if (result.forgetTx !== undefined && typeof result.forgetTx !== 'boolean') throw new StoreError('forgetTx must be true or false');
  const forgetTx = result.forgetTx === true;
  if (forgetTx && tx !== null) throw new StoreError('forgetTx cannot be given together with a tx');
  // The board links a confirmed relay's transaction as the payout, so the write that confirms says what it proved (C61).
  if (result.status === 'confirmed' && !forgetTx && tx === null) {
    throw new StoreError('a confirmed relay must name the transaction it proved, or forgetTx');
  }
  if (!isCampaignId(key.campaignId)) return null;
  const [row] = await db.query<{ status: RelayStatus }>(
    `UPDATE claim_relays
        SET status = CASE WHEN $4::text = 'pending' AND GREATEST(attempts - $9::int, 0) >= $7::int THEN 'failed' ELSE $4::text END,
            attempts = GREATEST(attempts - $9::int, 0),
            tx = CASE WHEN $10::boolean THEN NULL ELSE COALESCE($5::text, tx) END,
            updated_at = $6::timestamptz,
            retry_at = CASE WHEN $4::text = 'pending' AND GREATEST(attempts - $9::int, 0) < $7::int THEN $8::timestamptz ELSE NULL END
      WHERE campaign_id = $1 AND wallet = $2 AND version = $3 AND status = 'sent'
     RETURNING status`,
    [key.campaignId, wallet, key.version, result.status, tx, nowAt, MAX_RELAY_ATTEMPTS, retryAt, refund, forgetTx],
  );
  return row?.status ?? null;
}

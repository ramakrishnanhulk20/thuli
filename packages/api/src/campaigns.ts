import type { Context, Env, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createPublicClient, http, type Chain } from 'viem';
import { base, baseSepolia, mainnet } from 'viem/chains';
import type { z } from 'zod';
import {
  accountTypeFromCode,
  checkAppeal,
  checkAsk,
  isPlainText,
  parseAddress,
  proofFor,
  type Address,
  type LeafTree,
  type MerkleHash,
  type ScreenedChain,
} from '@thuli/core';
import {
  activeList,
  addAppeal,
  addAsk,
  appealStanding,
  APPEALS_PER_CAMPAIGN_DAY,
  board,
  campaignAppealsCounter,
  confirmedPayouts,
  counts,
  dayCount,
  getAppeal,
  getAsk,
  getCampaign,
  listText,
  listVersions,
  MAX_REPPO_NOTE_CHARS,
  recordIfUnder,
  type AddAppealResult,
  type AppealStanding,
  type Campaign,
  type Db,
  type Payout,
  type PublicAppeal,
  type PublicAsk,
} from '@thuli/store';
import { VAULT_ABI } from '@thuli/worker/src/vault/abi.ts';
import { buildRoot, readPublishedList } from '@thuli/worker/src/vault/root.ts';
import { BASE_SEPOLIA_RPC } from './config.ts';
import {
  AppealRequest,
  ApprovedBody,
  AskRequest,
  AskView,
  BoardPage,
  BusyBody,
  CampaignView,
  ClosedBody,
  ErrorBody,
  ExistsAppealBody,
  ExistsBody,
  FullBody,
  NeverUsedBody,
  QueuedBody,
  UndecidedBody,
  type AppealJson,
  type AskJson,
} from './schema.ts';
import { failureCode } from './stores.ts';

export const CAMPAIGNS_PATH = '/api/campaigns';
/** Requests one caller may send to the ask and appeal routes together in any 60 seconds, in a bucket of their own. */
export const ASK_CLIENT_MAX_PER_MINUTE = 20;
/** Asks with a valid signature one caller may send in any hour, counted in a bucket of their own. */
export const ASK_CLIENT_MAX_PER_HOUR = 5;
/**
 * Appeals with a valid signature one caller may send in any hour, in a bucket of their own. Each queued appeal buys an
 * outside check, and the store's own day ceiling bounds them all together (C24).
 */
export const APPEALS_PER_CALLER_HOUR = 2;
/** Requests one caller may send to the four campaign read routes together in any 60 seconds (C42). */
export const CAMPAIGN_READS_PER_MINUTE = 120;
/** Chain reads the read routes may cause in any 60 seconds across every caller and server copy, two per ticket. */
export const CAMPAIGN_CHAIN_READS_PER_MINUTE = 600;
/**
 * Door reads the ask route may cause in any 60 seconds across every caller and server copy: two on Ethereum for every
 * ask that reaches the door, and two more on Base for one empty on Ethereum, each pair counted before it is read.
 */
export const CAMPAIGN_DOOR_READS_PER_MINUTE = 300;
/**
 * Wallet-type reads the ask and appeal routes together may cause in any 60 seconds across every caller and server copy
 * (C24, C42). A check reads the wallet's code on Ethereum, and on the campaign's own chain when that is another, and
 * counts one for each. Per caller they are already bounded by the shared 20 POSTs a minute; this bounds them all
 * together, so many callers cannot use up the RPC the real asks need.
 */
export const CAMPAIGN_TYPE_READS_PER_MINUTE = 600;
/** The most asks one board page holds. */
export const BOARD_PAGE_SIZE = 50;

// The asks' minute bucket is shared with the appeal route, so a caller cannot double its requests by splitting them.
const ASK_MINUTE_BUCKET = 'ask-minute';
const ASK_HOUR_BUCKET = 'ask-hour';
const APPEAL_HOUR_BUCKET = 'appeal-hour';
const READ_BUCKET = 'campaign-reads';
const CHAIN_READ_BUCKET = 'campaign-chain-reads';
const DOOR_READ_BUCKET = 'campaign-door-reads';
const TYPE_READ_BUCKET = 'campaign-type-reads';
// One shared counter for every caller, because the ceiling protects the RPC, which every caller shares.
const EVERY_CALLER = 'all';
// A ticket's vault amounts are a claimed read and a claimable read.
const READS_PER_TICKET = 2;
// The door reads a wallet's sent count and its balance on each chain it reads.
const READS_PER_DOOR = 2;
// A version's text never changes once stored, so a parsed list needs no age, only a bound on how many are kept.
const LIST_CACHE_SIZE = 8;
const AMOUNT_CACHE_SIZE = 5_000;
const AMOUNT_CACHE_MS = 15_000;
const DAY_SECONDS = 86_400;
// A real ask is about 230 bytes: a wallet, a time and a 132 character signature (C41).
const MAX_ASK_BODY_BYTES = 1024;
// An appeal adds one line of text to that, so 2 KB is room for any plain line a person writes and nothing more.
const MAX_APPEAL_BODY_BYTES = 2048;
const CHAIN_READ_TIMEOUT_MS = 10_000;
const MAX_LIST_VERSION = 2_147_483_647;

const NO_CAMPAIGN = { error: 'no such campaign' } as const;

/**
 * Reads one campaign chain: the vault's claimed and claimable amounts, and whether an address is a contract there. Any
 * call may reject when the chain cannot be read.
 */
export interface VaultReader {
  claimed(vault: Address, account: Address): Promise<bigint>;
  claimable(vault: Address, account: Address, cumulativeAmount: bigint): Promise<bigint>;
  /** True only for account type contract on this chain, by the same rule as CampaignDeps.isContract. */
  isContract(address: Address): Promise<boolean>;
}

/**
 * Reads one address on one chain. Called as a function, true only for account type contract: a delegated EOA keeps its
 * own key and counts as a wallet (C20). The sent count and the balance are read at the finalized block, the block the
 * worker screens at, so the door counts exactly the history a screening would. Any read may reject when the chain
 * cannot be read.
 */
export interface AccountReader {
  (address: Address): Promise<boolean>;
  /** How many transactions the address has sent: its nonce at the finalized block. */
  sentCount(address: Address): Promise<number>;
  /** The address's balance in wei at the finalized block. */
  balance(address: Address): Promise<bigint>;
}

export interface CampaignDeps {
  /** The database the campaign tables live in, the one the other stores use. */
  db: Db;
  /** The Ethereum reader: the wallet type for checkAsk and checkAppeal, and the door's first sent count and balance. */
  isContract: AccountReader;
  /** The Base mainnet reader: the door's second sent count and balance, read only for a wallet empty on Ethereum. */
  baseAccounts: AccountReader;
  /**
   * The reader for a campaign's chain, or null when Thuli has none for it. Left out, or null, a claim ticket goes out
   * without claimed and claimable, and every ask to a campaign off Ethereum is refused, because its chain cannot be read.
   */
  vault?: (chainId: number) => VaultReader | null;
  now?: () => Date;
}

// Logged by its class and code only: a store's message can quote a query value or the database host (C40).
function storeFailed(step: string, error: unknown): void {
  console.warn(`api campaign store failed while ${step}: ${failureCode(error)}`);
}

/** Every answer is checked against its shape before it leaves; one that fails is a 500 from the app, never sent (C34). */
function answer<T>(c: Context, shape: z.ZodType<T>, body: T, status: ContentfulStatusCode): Response {
  return c.json(shape.parse(body) as object, status);
}

const busy = (c: Context, status: 429 | 503 = 503) => answer(c, BusyBody, { busy: true }, status);
const refused = (c: Context, error: string, status: 400 | 404) => answer(c, ErrorBody, { error }, status);

/** Whole seconds from at until the next UTC midnight, from 1 to a day, for Retry-After. */
function untilNextUtcDay(at: Date): number {
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return Math.min(DAY_SECONDS, Math.max(1, Math.ceil((next - at.getTime()) / 1000)));
}

/** One active list, parsed once: its root, its tree, and each wallet's amount by the one canonical address (C1). */
interface ListTree {
  root: MerkleHash;
  tree: LeafTree;
  amounts: Map<Address, bigint>;
}

/**
 * The same steps claimTicket in the worker takes, split so the tree can be kept: the text read as a published list and
 * rebuilt through buildRoot, so the root is the one anyone rebuilding that text gets (C28, C32).
 */
function listTreeOf(text: string, campaign: Campaign): ListTree {
  const entries = readPublishedList(text);
  const { root, tree } = buildRoot(entries, campaign.vault, campaign.chain);
  return { root, tree, amounts: new Map(entries.map((entry) => [parseAddress(entry.account), entry.cumulativeAmount])) };
}

function askJson(ask: PublicAsk): AskJson {
  return {
    campaignId: ask.campaignId,
    wallet: ask.wallet,
    askedAt: ask.askedAt.toISOString(),
    status: ask.status,
    action: ask.action,
    shareBps: ask.shareBps,
    rule: ask.rule,
    reason: ask.reason,
    citedTxs: ask.citedTxs,
    notChecked: ask.notChecked,
    facts: ask.facts,
    servRequestId: ask.servRequestId,
    decidedAt: ask.decidedAt === null ? null : ask.decidedAt.toISOString(),
    slot: ask.slot,
    appeal: ask.appeal === null ? null : appealJson(ask.appeal),
  };
}

/**
 * The public appeal, field by field. reppoNote is another service's model text, so it leaves only when it passes core's
 * plain-text rule and fits 280 characters; otherwise it leaves as null rather than failing the answer (C13, C34).
 */
function appealJson(appeal: PublicAppeal): AppealJson {
  const note = appeal.reppoNote;
  return {
    filedAt: appeal.filedAt.toISOString(),
    checkStatus: appeal.checkStatus,
    reppoRoute: appeal.reppoRoute,
    reppoNote: note !== null && note.length > 0 && note.length <= MAX_REPPO_NOTE_CHARS && isPlainText(note) ? note : null,
    reppoEvalId: appeal.reppoEvalId,
    checkedAt: appeal.checkedAt === null ? null : appeal.checkedAt.toISOString(),
    outcome: appeal.outcome,
    newAction: appeal.newAction,
    settledAt: appeal.settledAt === null ? null : appeal.settledAt.toISOString(),
  };
}

function campaignView(campaign: Campaign, tally: CampaignView['counts'], lists: Awaited<ReturnType<typeof listVersions>>): CampaignView {
  return {
    name: campaign.name,
    chain: campaign.chain,
    vault: campaign.vault,
    token: campaign.token,
    rewardPerWallet: campaign.rewardPerWallet,
    perWalletCap: campaign.perWalletCap,
    maxSlots: campaign.maxSlots,
    status: campaign.status,
    opensAt: campaign.opensAt.toISOString(),
    closesAt: campaign.closesAt.toISOString(),
    counts: tally,
    lists: lists.map((list) => ({
      version: list.version,
      root: list.root,
      status: list.status,
      postTx: list.postTx,
      claimableAt: list.claimableAt,
    })),
  };
}

/**
 * The campaign routes, added to app. Each answer passes its strict shape first (C34), and none carries a signature, a
 * lease or a caller's address (C40). Every route looks the campaign up before reading anything of the request but the
 * caller, so an unknown id is 404 {"error": "no such campaign"} whatever else was sent, and a store that cannot answer
 * is 503 {"busy": true} with nothing written. The app's own middleware marks every answer cache-control: no-store.
 * Every limit counts on the caller's address as the paid route reads it, never on anything the caller writes (C42),
 * and a limit that cannot be read refuses the request.
 *
 * The four GET routes share one allowance of 120 requests a minute per caller, counted first (429 {"busy": true}).
 * - GET /api/campaigns/:id: the campaign's public terms, its counts and its list versions.
 * - GET /api/campaigns/:id/board?before=<ISO time>: 50 decided or failed asks, newest first, decided strictly before
 *   the given time when one is given, plus every further ask decided at the same instant as the 50th, so walking the
 *   board with before set to the last ask's decidedAt never skips one (see board in the store); 400 for a time that is
 *   not ISO 8601.
 * - GET /api/campaigns/:id/asks/:wallet: the ask's public view (404 when the wallet never asked, 400 for a bad
 *   address), and when the wallet is on the active list its claim ticket, built from that version's published text
 *   exactly as stored and refused unless it rebuilds the stored root (C32). claimed and claimable are read from the
 *   vault when deps.vault has a reader for the campaign's chain, and left out when it has none, the read fails, or the
 *   read routes have caused 600 chain reads in the last minute across every server copy.
 * - GET /api/campaigns/:id/lists/:version: the published text byte for byte as application/json, or 404.
 *
 * Two caches live in this server copy only, so each copy fills its own; nothing in them is ever served for another
 * campaign, version, vault or wallet than it was read for, all keyed by the one canonical form (C1). One holds the
 * last 8 active lists used, parsed and with their trees, dropping the one used longest ago; a stored version's text
 * never changes, so an entry never goes stale. The other holds a wallet's claimed and claimable per chain, vault and
 * leaf amount for 15 seconds, at most 5,000 entries, dropping expired ones first and then the oldest.
 *
 * The two POST routes share one allowance of 20 requests a minute per caller, counted after the body's size check and
 * before its shape is read, so a malformed body counts too. Nothing is screened or checked by Reppo inside a request.
 * - POST /api/campaigns/:id/asks with exactly {wallet, signedAt, signature}, at most 1 KB. In order: the size (413),
 *   the caller's address (400) and the minute (429), the shape (400), checkAsk with the campaign from the path, its
 *   signature checked before a wallet type is read on Ethereum and on the campaign's chain (400 with its cause), those
 *   reads counted first against the 600 a minute across both POST routes and every caller (503 {"busy": true}, reading
 *   nothing, past it or when the count cannot be read), the
 *   caller's 5 signed asks an hour (429), the wallet's earlier ask (200 {"exists": true, "ask"} with the first ask's
 *   public view, and no door read), the door reads' ceiling of 300 a minute across every caller (503 {"busy": true}),
 *   then the door: the wallet's sent count and balance at the finalized block, the worker's block, on Ethereum and, for
 *   a wallet with nothing there, on Base mainnet, whose two reads are counted against the same ceiling first. Empty on
 *   both chains is a never-used wallet, 200 {"neverUsed": true} with nothing stored or queued; a read that fails, times
 *   out or is not a whole number on a chain that had to be read is 503 {"busy": true}, as is the ceiling reached before
 *   the Base reads. Then addAsk: 202 {"queued": true}; 200 exists; 409 {"closed": true}; 409
 *   {"full": true} when no slot is left, 200 asks wait undecided or the campaign's lifetime cap is reached.
 * - POST /api/campaigns/:id/appeals with exactly {wallet, text, signedAt, signature}, at most 2 KB. In order: the size
 *   (413), the caller and the minute, the shape (400), checkAppeal's free checks with the campaign from the path (its
 *   text one line, the signature; 400 with its cause), then the store's appealStanding for the wallet's ask, before any
 *   chain read: no ask, an ask not decided yet, a full approval or an earlier appeal is answered at once, exactly as
 *   addAppeal would answer it, with no chain read and no count against the type-read ceiling or the caller's hour; a
 *   store that cannot be read is 503 {"busy": true}. Only an ask it may appeal goes on to the counted two-chain
 *   wallet-type read (400 with its cause, 503 {"busy": true} past the shared ceiling), the caller's 2 signed appeals an
 *   hour (429), then addAppeal, which counts the campaign's share and the store's 20 appeals a UTC day. The answers,
 *   one mapping for both: 202 {"queued": true}; 200 {"exists": true, "appeal"} with the first appeal's public view; 409
 *   {"undecided": true}; 409 {"approved": true}; 404 {"error": "no ask from this wallet"}; 429 {"busy": true} with
 *   Retry-After set to the seconds until the next UTC day when the campaign's share or the day's appeals are used. The
 *   text hash is rebuilt from the text, never taken from the caller, and no answer or log line carries the text, its
 *   hash, the signature or the owner's note (C40).
 *
 * @param clientOf the caller's address as the paid route reads it, or null when it cannot be read.
 */
export function registerCampaignRoutes<E extends Env>(app: Hono<E>, deps: CampaignDeps, clientOf: (c: Context) => string | null): void {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  // Per request, so later steps reuse what the first looked up without a second read.
  const campaigns = new WeakMap<Context, Campaign>();
  const lists = new Map<string, ListTree>();
  const vaultReads = new Map<string, { readAt: number; amounts: Promise<{ claimed?: string; claimable?: string }> }>();

  const limitReads = async (c: Context, next: () => Promise<void>) => {
    const client = clientOf(c);
    if (client === null) {
      console.warn('api refused: the client address could not be read');
      return refused(c, 'the client address could not be read', 400);
    }
    let counted: boolean;
    try {
      counted = await recordIfUnder(db, READ_BUCKET, client, CAMPAIGN_READS_PER_MINUTE, 60, now());
    } catch (error) {
      storeFailed('counting a campaign read', error);
      return busy(c);
    }
    if (!counted) {
      console.warn('api campaign reads busy: a client is past the minute limit');
      return busy(c, 429);
    }
    await next();
    return undefined;
  };

  const findCampaign = async (c: Context, next: () => Promise<void>) => {
    let campaign: Campaign | null;
    try {
      campaign = await getCampaign(db, c.req.param('id') ?? '');
    } catch (error) {
      storeFailed('reading a campaign', error);
      return busy(c);
    }
    if (campaign === null) return answer(c, ErrorBody, NO_CAMPAIGN, 404);
    campaigns.set(c, campaign);
    await next();
    return undefined;
  };

  const campaignOf = (c: Context): Campaign => {
    const campaign = campaigns.get(c);
    if (campaign === undefined) throw new Error('the campaign was not looked up first');
    return campaign;
  };

  app.get(`${CAMPAIGNS_PATH}/:id`, limitReads, findCampaign, async (c) => {
    const campaign = campaignOf(c);
    let tally: Awaited<ReturnType<typeof counts>>;
    let lists: Awaited<ReturnType<typeof listVersions>>;
    try {
      tally = await counts(db, campaign.id);
      lists = await listVersions(db, campaign.id);
    } catch (error) {
      storeFailed('reading a campaign', error);
      return busy(c);
    }
    if (tally === null) return answer(c, ErrorBody, NO_CAMPAIGN, 404);
    return answer(c, CampaignView, campaignView(campaign, tally, lists), 200);
  });

  app.get(`${CAMPAIGNS_PATH}/:id/board`, limitReads, findCampaign, async (c) => {
    const campaign = campaignOf(c);
    const given = c.req.query('before');
    let before: Date | undefined;
    if (given !== undefined) {
      const time = new Date(given);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(given) || Number.isNaN(time.getTime())) {
        return refused(c, 'before must be an ISO 8601 time such as 2026-11-11T12:00:00.000Z', 400);
      }
      before = time;
    }
    let asks: PublicAsk[];
    let paid: Payout[];
    try {
      asks = await board(db, campaign.id, BOARD_PAGE_SIZE, before);
      // Only a wallet that holds a slot is ever listed, so only those can have been paid.
      paid = await confirmedPayouts(
        db,
        campaign.id,
        asks.filter((ask) => ask.slot !== null).map((ask) => ask.wallet),
      );
    } catch (error) {
      storeFailed('reading a board', error);
      return busy(c);
    }
    const payouts = paid.map((payout) => ({ wallet: payout.wallet, amount: payout.amount, transaction: payout.tx }));
    return answer(c, BoardPage, { asks: asks.map(askJson), payouts }, 200);
  });

  app.post(
    `${CAMPAIGNS_PATH}/:id/asks`,
    findCampaign,
    bodyLimit({ maxSize: MAX_ASK_BODY_BYTES, onError: (c) => answer(c, ErrorBody, { error: 'the body is too large' }, 413) }),
    async (c) => {
      const campaign = campaignOf(c);
      const at = now();
      const client = await countPost(c, at);
      if (client instanceof Response) return client;
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return refused(c, 'the body must be JSON like {"wallet": "0x...", "signedAt": 0, "signature": "0x..."}', 400);
      }
      const parsed = AskRequest.safeParse(body);
      if (!parsed.success) return refused(c, 'the body must be exactly {"wallet", "signedAt", "signature"}', 400);
      const { wallet, signedAt, signature } = parsed.data;
      const types = countedTypeReader(campaign, at);
      const checked = await checkAsk(
        { campaignId: campaign.id, wallet, signedAt, signature },
        { expectedCampaignId: campaign.id, now: Math.floor(at.getTime() / 1000), isContract: (address) => types.isContract(address) },
      );
      if (!checked.ok) return types.refused() ? busy(c) : refused(c, checked.cause, 400);
      try {
        if (!(await recordIfUnder(db, ASK_HOUR_BUCKET, client, ASK_CLIENT_MAX_PER_HOUR, 3_600, at))) {
          console.warn('api ask busy: a client is past the hour limit');
          return busy(c, 429);
        }
        // A wallet that asked before gets its first ask back whatever the chain says of it now, and causes no door read.
        const earlier = await getAsk(db, campaign.id, checked.wallet);
        if (earlier !== null) return answer(c, ExistsBody, { exists: true, ask: askJson(earlier) }, 200);
        // The door reads' global ceiling: 300 a minute, counted as pairs, across every caller and server copy. This
        // pair is Ethereum's; neverUsedOnBothChains counts Base's before it reads it. Per caller they are bounded
        // before this: every pair follows a signed ask that spent one of the caller's 5 an hour, so one caller causes
        // at most 5 times 4, 20 door reads an hour.
        if (!(await recordIfUnder(db, DOOR_READ_BUCKET, EVERY_CALLER, CAMPAIGN_DOOR_READS_PER_MINUTE / READS_PER_DOOR, 60, at))) {
          console.warn('api ask busy: the door-read ceiling is reached');
          return busy(c);
        }
      } catch (error) {
        storeFailed('checking an ask', error);
        return busy(c);
      }
      const neverUsed = await neverUsedOnBothChains(checked.wallet);
      if (neverUsed === null) return busy(c);
      // A wallet that cost nothing to make is not an ask: nothing is stored or queued, and no slot or cap is taken (C24).
      if (neverUsed) return answer(c, NeverUsedBody, { neverUsed: true }, 200);
      try {
        const result = await addAsk(db, { campaignId: campaign.id, wallet: checked.wallet, signedAt, signature }, at);
        if (result === 'queued') return answer(c, QueuedBody, { queued: true }, 202);
        if (result === 'closed') return answer(c, ClosedBody, { closed: true }, 409);
        // full covers the lifetime cap, askLifetimeCap(max_slots) = max(1,000, 100 times max_slots) asks that never
        // expire. Only a wallet that has sent a transaction or holds a balance on Ethereum or Base is stored, so locking
        // a campaign this way now costs an attacker the cap times one funded wallet: at least 1,000 wallets, each with
        // its own key and each given a balance or a sent transaction on one of the two. What stays free stores nothing:
        // a never-used wallet costs only its door reads, which the ceiling caps.
        if (result === 'full') return answer(c, FullBody, { full: true }, 409);
        if (result === 'unknown') return answer(c, ErrorBody, NO_CAMPAIGN, 404);
        // The wallet's first ask landed after the lookup above, so this one reads that one.
        const first = await getAsk(db, campaign.id, checked.wallet);
        if (first === null) return busy(c);
        return answer(c, ExistsBody, { exists: true, ask: askJson(first) }, 200);
      } catch (error) {
        storeFailed('adding an ask', error);
        return busy(c);
      }
    },
  );

  app.post(
    `${CAMPAIGNS_PATH}/:id/appeals`,
    findCampaign,
    bodyLimit({ maxSize: MAX_APPEAL_BODY_BYTES, onError: (c) => answer(c, ErrorBody, { error: 'the body is too large' }, 413) }),
    async (c) => {
      const campaign = campaignOf(c);
      const at = now();
      const client = await countPost(c, at);
      if (client instanceof Response) return client;
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return refused(c, 'the body must be JSON like {"wallet": "0x...", "text": "...", "signedAt": 0, "signature": "0x..."}', 400);
      }
      const parsed = AppealRequest.safeParse(body);
      if (!parsed.success) return refused(c, 'the body must be exactly {"wallet", "text", "signedAt", "signature"}', 400);
      const { wallet, text, signedAt, signature } = parsed.data;
      // checkAppeal calls this reader only once the signature is verified, so that is where the ask is looked up: a
      // wallet with no ask it may appeal is answered from the store alone, with no chain read, no type-read count and
      // no count against the caller's hour (C49). Only for 'open' are the wallet types read, counted.
      const types = countedTypeReader(campaign, at);
      const lookup: { standing: AppealStanding | null; unread: boolean; wallet: Address | null } = { standing: null, unread: false, wallet: null };
      const isContract = async (address: Address): Promise<boolean> => {
        lookup.wallet = address;
        try {
          lookup.standing = await appealStanding(db, campaign.id, address);
        } catch (error) {
          storeFailed("looking up an appeal's ask", error);
          lookup.unread = true;
          throw new Error("the appeal's ask could not be read");
        }
        if (lookup.standing !== 'open') throw new Error('the wallet has no ask it may appeal');
        return types.isContract(address);
      };
      // The hash comes back from checkAppeal, rebuilt from the text it was given, so no caller can name one (C8).
      const checked = await checkAppeal(
        { campaignId: campaign.id, wallet, text, signedAt, signature },
        { expectedCampaignId: campaign.id, now: Math.floor(at.getTime() / 1000), isContract },
      );
      if (!checked.ok) {
        if (lookup.unread || types.refused()) return busy(c);
        if (lookup.standing === null || lookup.standing === 'open' || lookup.wallet === null) return refused(c, checked.cause, 400);
        try {
          return await appealAnswer(c, lookup.standing, campaign, lookup.wallet, at);
        } catch (error) {
          storeFailed('answering an appeal', error);
          return busy(c);
        }
      }
      try {
        if (!(await recordIfUnder(db, APPEAL_HOUR_BUCKET, client, APPEALS_PER_CALLER_HOUR, 3_600, at))) {
          console.warn('api appeal busy: a client is past the hour limit');
          return busy(c, 429);
        }
        const result = await addAppeal(
          db,
          { campaignId: campaign.id, wallet: checked.wallet, text, textHash: checked.textHash, signedAt, signature },
          at,
        );
        return await appealAnswer(c, result, campaign, checked.wallet, at);
      } catch (error) {
        storeFailed('adding an appeal', error);
        return busy(c);
      }
    },
  );

  app.get(`${CAMPAIGNS_PATH}/:id/asks/:wallet`, limitReads, findCampaign, async (c) => {
    const campaign = campaignOf(c);
    let wallet: Address;
    try {
      wallet = parseAddress(c.req.param('wallet') ?? '');
    } catch {
      return refused(c, 'the wallet is not a valid address', 400);
    }
    let ask: PublicAsk | null;
    let active: Awaited<ReturnType<typeof activeList>>;
    let key = '';
    let list: ListTree | undefined;
    let text: string | null = null;
    try {
      ask = await getAsk(db, campaign.id, wallet);
      if (ask === null) return refused(c, 'no ask from this wallet', 404);
      active = await activeList(db, campaign.id);
      if (active !== null) {
        key = JSON.stringify([campaign.id, active.version, campaign.chain, campaign.vault]);
        list = keptList(key);
        if (list === undefined) text = await listText(db, campaign.id, active.version);
      }
    } catch (error) {
      storeFailed('reading an ask', error);
      return busy(c);
    }
    if (active === null) return answer(c, AskView, { ask: askJson(ask) }, 200);
    if (list === undefined) {
      if (text === null) return answer(c, AskView, { ask: askJson(ask) }, 200);
      // Outside the store's try: a stored list that does not parse is a broken invariant, a 500, not a busy store.
      list = listTreeOf(text, campaign);
      keepList(key, list);
    }
    const cumulativeAmount = list.amounts.get(wallet);
    if (cumulativeAmount === undefined) return answer(c, AskView, { ask: askJson(ask) }, 200);
    // A ticket that proves against any root but the one recorded as active would send the wallet to a failing claim.
    if (list.root !== active.root) throw new Error('the active list text does not rebuild its recorded root');
    const amounts = await vaultAmounts(campaign, wallet, cumulativeAmount);
    return answer(
      c,
      AskView,
      {
        ask: askJson(ask),
        ticket: { cumulativeAmount: cumulativeAmount.toString(), proof: proofFor(list.tree, wallet), root: list.root, ...amounts },
      },
      200,
    );
  });

  app.get(`${CAMPAIGNS_PATH}/:id/lists/:version`, limitReads, findCampaign, async (c) => {
    const campaign = campaignOf(c);
    const given = c.req.param('version') ?? '';
    if (!/^[1-9][0-9]{0,9}$/.test(given) || Number(given) > MAX_LIST_VERSION) return refused(c, 'no such list version', 404);
    let text: string | null;
    try {
      text = await listText(db, campaign.id, Number(given));
    } catch (error) {
      storeFailed('reading a list', error);
      return busy(c);
    }
    if (text === null) return refused(c, 'no such list version', 404);
    // Checked like an input before it goes out, and sent as stored, so anyone can rebuild the root from it (C32, C34).
    readPublishedList(text);
    return c.body(text, 200, { 'content-type': 'application/json' });
  });

  /**
   * The caller of a POST, counted once toward the minute the ask and appeal routes share, before the body is read so a
   * malformed body counts too (C42). Returns the caller's address, or the refusal to send: 400 when the address cannot
   * be read, 429 past the minute, 503 when the count cannot be read.
   */
  async function countPost(c: Context, at: Date): Promise<string | Response> {
    const client = clientOf(c);
    if (client === null) {
      console.warn('api refused: the client address could not be read');
      return refused(c, 'the client address could not be read', 400);
    }
    let counted: boolean;
    try {
      counted = await recordIfUnder(db, ASK_MINUTE_BUCKET, client, ASK_CLIENT_MAX_PER_MINUTE, 60, at);
    } catch (error) {
      storeFailed('counting a campaign request', error);
      return busy(c);
    }
    if (!counted) {
      console.warn('api campaign busy: a client is past the minute limit');
      return busy(c, 429);
    }
    return client;
  }

  /**
   * The appeal route's answer to what the store said of a wallet's appeal, the same whether appealStanding said it
   * before any chain read or addAppeal said it after, so the two can never answer one case differently. A 'busy' is
   * logged as the share it used up: this campaign's for the day, which addAppeal counts first, or the day's across every
   * campaign. The store reads here may throw; the caller answers busy.
   */
  async function appealAnswer(c: Context, result: AddAppealResult, campaign: Campaign, wallet: Address, at: Date): Promise<Response> {
    if (result === 'queued') return answer(c, QueuedBody, { queued: true }, 202);
    if (result === 'undecided') return answer(c, UndecidedBody, { undecided: true }, 409);
    if (result === 'approved') return answer(c, ApprovedBody, { approved: true }, 409);
    if (result === 'unknown') return refused(c, 'no ask from this wallet', 404);
    if (result === 'busy') {
      const campaignShare = await dayCount(db, campaignAppealsCounter(campaign.id), at).catch(() => null);
      if (campaignShare !== null && campaignShare >= APPEALS_PER_CAMPAIGN_DAY) {
        console.warn("api appeal busy: this campaign's appeals for today are used");
      } else if (campaignShare !== null) {
        console.warn("api appeal busy: today's appeals across every campaign are used");
      } else {
        console.warn("api appeal busy: this campaign's or every campaign's appeals for today are used");
      }
      c.header('Retry-After', String(untilNextUtcDay(at)));
      return busy(c, 429);
    }
    const first = await getAppeal(db, campaign.id, wallet);
    if (first === null) return busy(c);
    return answer(c, ExistsAppealBody, { exists: true, appeal: appealJson(first) }, 200);
  }

  /**
   * The wallet-type reader one POST hands checkAsk or checkAppeal, which call it only once the signature has passed.
   * Before reading, it counts the reads it is about to make toward CAMPAIGN_TYPE_READS_PER_MINUTE: one counted write per
   * chain, so the ceiling is never passed. When a write is refused, or the count cannot be read at all, it reads nothing
   * and throws, and refused tells the route to answer 503 busy instead of the check's own cause. A first write that went
   * through before a second was refused stays counted, which only refuses a little earlier (fail closed).
   */
  function countedTypeReader(campaign: Campaign, at: Date): { isContract(address: Address): Promise<boolean>; refused: () => boolean } {
    let refused = false;
    return {
      refused: () => refused,
      async isContract(address) {
        const reads = campaign.chain === mainnet.id ? 1 : 2;
        try {
          for (let read = 0; read < reads; read += 1) {
            if (!(await recordIfUnder(db, TYPE_READ_BUCKET, EVERY_CALLER, CAMPAIGN_TYPE_READS_PER_MINUTE, 60, at))) {
              console.warn('api campaign busy: the wallet-type read ceiling is reached');
              refused = true;
            }
            if (refused) break;
          }
        } catch (error) {
          storeFailed('counting a wallet-type read', error);
          refused = true;
        }
        if (refused) throw new Error('the wallet-type read was not counted');
        return contractOnEitherChain(campaign, address);
      },
    };
  }

  /**
   * Whether address is a contract on Ethereum or on the campaign's own chain, read once when the campaign is on
   * Ethereum. A contract on either is refused, because the same address can be a person's wallet on one chain and a
   * contract on the other. Any failed read, a missing reader for the campaign's chain or an answer that is not true or
   * false rejects, so checkAsk refuses the ask as unreadable rather than letting it through (C11).
   */
  async function contractOnEitherChain(campaign: Campaign, address: Address): Promise<boolean> {
    if (campaign.chain === mainnet.id) return yesOrNo(await deps.isContract(address));
    const reader = deps.vault?.(campaign.chain) ?? null;
    if (reader === null) throw new Error("no reader for the campaign's chain");
    const [onEthereum, onCampaignChain] = await Promise.all([deps.isContract(address), reader.isContract(address)]);
    return yesOrNo(onEthereum) || yesOrNo(onCampaignChain);
  }

  /**
   * Whether wallet is empty on one chain: exactly 0 transactions sent and a balance of exactly 0 at the finalized block.
   * null when either read fails, times out, is missing or answers anything but a whole number of 0 or more.
   */
  async function emptyOn(reader: AccountReader, wallet: Address): Promise<boolean | null> {
    let sent: bigint | null;
    let balance: bigint | null;
    try {
      const [count, wei] = await Promise.all([reader.sentCount(wallet), reader.balance(wallet)]);
      sent = wholeNumber(count);
      balance = wholeNumber(wei);
    } catch (error) {
      console.warn(`api ask door read failed: ${failureCode(error)}`);
      return null;
    }
    if (sent === null || balance === null) {
      console.warn('api ask door read answered something other than a whole number');
      return null;
    }
    return sent === 0n && balance === 0n;
  }

  /**
   * Whether wallet has never been used on Ethereum nor on Base mainnet. Ethereum is read first, and a wallet used there
   * is used, with Base never read. Only a wallet empty on Ethereum is read on Base, and its two reads are counted
   * against the door ceiling before they are made (C49). null, which the route answers as busy, when a read on a chain
   * that had to be read fails or answers anything but a whole number, or when the second count is refused or cannot
   * be read: a read that did not happen never decides the answer (C11).
   */
  async function neverUsedOnBothChains(wallet: Address): Promise<boolean | null> {
    const onEthereum = await emptyOn(deps.isContract, wallet);
    if (onEthereum !== true) return onEthereum;
    try {
      if (!(await recordIfUnder(db, DOOR_READ_BUCKET, EVERY_CALLER, CAMPAIGN_DOOR_READS_PER_MINUTE / READS_PER_DOOR, 60, now()))) {
        console.warn('api ask busy: the door-read ceiling is reached before the Base reads');
        return null;
      }
    } catch (error) {
      storeFailed('counting the Base door reads', error);
      return null;
    }
    return emptyOn(deps.baseAccounts, wallet);
  }

  /** A parsed list kept under key, made the most recently used, or undefined. */
  function keptList(key: string): ListTree | undefined {
    const kept = lists.get(key);
    if (kept !== undefined) {
      lists.delete(key);
      lists.set(key, kept);
    }
    return kept;
  }

  function keepList(key: string, list: ListTree): void {
    lists.delete(key);
    lists.set(key, list);
    for (const oldest of lists.keys()) {
      if (lists.size <= LIST_CACHE_SIZE) break;
      lists.delete(oldest);
    }
  }

  /**
   * The vault's claimed and claimable for a ticket, as decimal text, or nothing when no reader answers. Never throws.
   * Kept 15 seconds per chain, vault, wallet and leaf amount, the promise itself, so callers arriving together share
   * one pair of reads. A miss first counts toward the shared chain-read ceiling; past it, or when that count cannot be
   * read, nothing is read and the ticket goes out without the amounts, as it does with no reader.
   */
  function vaultAmounts(campaign: Campaign, wallet: Address, cumulativeAmount: bigint): Promise<{ claimed?: string; claimable?: string }> {
    const reader = deps.vault?.(campaign.chain) ?? null;
    if (reader === null) return Promise.resolve({});
    const at = now().getTime();
    const key = JSON.stringify([campaign.chain, campaign.vault, wallet, cumulativeAmount.toString()]);
    const kept = vaultReads.get(key);
    if (kept !== undefined && at >= kept.readAt && at - kept.readAt < AMOUNT_CACHE_MS) return kept.amounts;
    const amounts = readAmounts(reader, campaign, wallet, cumulativeAmount);
    vaultReads.delete(key);
    if (vaultReads.size >= AMOUNT_CACHE_SIZE) {
      for (const [other, entry] of vaultReads) if (!(at >= entry.readAt && at - entry.readAt < AMOUNT_CACHE_MS)) vaultReads.delete(other);
    }
    for (const oldest of vaultReads.keys()) {
      if (vaultReads.size < AMOUNT_CACHE_SIZE) break;
      vaultReads.delete(oldest);
    }
    vaultReads.set(key, { readAt: at, amounts });
    return amounts;
  }

  async function readAmounts(
    reader: VaultReader,
    campaign: Campaign,
    wallet: Address,
    cumulativeAmount: bigint,
  ): Promise<{ claimed?: string; claimable?: string }> {
    try {
      const allowed = await recordIfUnder(db, CHAIN_READ_BUCKET, EVERY_CALLER, CAMPAIGN_CHAIN_READS_PER_MINUTE / READS_PER_TICKET, 60, now());
      if (!allowed) {
        console.warn('api campaign vault not read: the chain-read ceiling is reached');
        return {};
      }
    } catch (error) {
      storeFailed('counting a chain read', error);
      return {};
    }
    try {
      const [claimed, claimable] = await Promise.all([
        reader.claimed(campaign.vault, wallet),
        reader.claimable(campaign.vault, wallet, cumulativeAmount),
      ]);
      if (typeof claimed !== 'bigint' || typeof claimable !== 'bigint' || claimed < 0n || claimable < 0n) return {};
      return { claimed: claimed.toString(), claimable: claimable.toString() };
    } catch (error) {
      console.warn(`api campaign vault read failed: ${failureCode(error)}`);
      return {};
    }
  }
}

function yesOrNo(answer: unknown): boolean {
  if (typeof answer !== 'boolean') throw new Error('a wallet type reader answered something other than true or false');
  return answer;
}

// viem gives a sent count as a number and a balance as a bigint, so either form passes, but only as a safe integer
// from 0 up. A fraction, a negative, NaN, text or anything else is null: no answer about the wallet.
function wholeNumber(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

// The facts' rule, so both chains judge one address the same way: no code is a wallet, a delegated EOA (EIP-7702) is
// a wallet, any other code is a contract. Code that is not hex rejects, so checkAsk refuses the wallet as unreadable.
function isContractCode(code: string | undefined): boolean {
  const type = accountTypeFromCode(code);
  if (type === 'unknown') throw new Error('the account code was not hex');
  return type === 'contract';
}

/**
 * Base mainnet's public RPC: the door's Base reader reads it unless BASE_RPC_URL names another, the way Base Sepolia's
 * public RPC is the vault reader's.
 */
export const BASE_PUBLIC_RPC = 'https://mainnet.base.org';

/**
 * The account reader for Ethereum mainnet or Base mainnet: whether an address is a contract from its code, by the
 * facts' rule (isContractCode), and its sent count and balance at the finalized block. Offchain lookups are off and an
 * HTTP redirect is refused (C38), and each read gives up after 10 seconds.
 *
 * Before its first answer the reader asks the endpoint for its chain id, once, and every read rejects while the
 * endpoint names any other chain: an endpoint of another network would answer every question, about the wrong wallets.
 * A chain id read that fails is asked again on the next read, so one blip does not close the door for good.
 */
export function accountReader(rpcUrl: string, chain: ScreenedChain): AccountReader {
  const expected = chain === 'ethereum' ? mainnet : base;
  const client = createPublicClient({
    chain: expected,
    transport: http(rpcUrl, { timeout: CHAIN_READ_TIMEOUT_MS, retryCount: 1, fetchOptions: { redirect: 'error' } }),
    ccipRead: false,
  });
  let chainChecked: Promise<void> | null = null;
  const onItsChain = async <T>(read: () => Promise<T>): Promise<T> => {
    chainChecked ??= client.getChainId().then((answered) => {
      if (answered !== expected.id) {
        console.error(`api ask door: the ${chain} endpoint answers for chain ${answered}, not ${expected.id}`);
        throw new WrongChain();
      }
    });
    try {
      await chainChecked;
    } catch (error) {
      // A wrong chain stays refused; a read that only failed is asked again next time.
      if (!(error instanceof WrongChain)) chainChecked = null;
      throw error;
    }
    return read();
  };
  return Object.assign(async (address: Address) => onItsChain(async () => isContractCode(await client.getCode({ address }))), {
    sentCount: (address: Address) => onItsChain(() => client.getTransactionCount({ address, blockTag: 'finalized' })),
    balance: (address: Address) => onItsChain(() => client.getBalance({ address, blockTag: 'finalized' })),
  });
}

class WrongChain extends Error {
  override name = 'WrongChain';
  override message = 'the endpoint is on another chain';
}

/**
 * The vault readers by chain: Base Sepolia (84532) on its public RPC, and Base (8453) on baseRpcUrl when one is given.
 * Any other chain has no reader. Offchain lookups are off (C38), and each read gives up after 10 seconds.
 */
export function vaultReaders(baseRpcUrl: string | null): (chainId: number) => VaultReader | null {
  const sources = new Map<number, { chain: Chain; url: string }>([[baseSepolia.id, { chain: baseSepolia, url: BASE_SEPOLIA_RPC }]]);
  if (baseRpcUrl !== null) sources.set(base.id, { chain: base, url: baseRpcUrl });
  const readers = new Map<number, VaultReader>();
  return (chainId) => {
    const source = sources.get(chainId);
    if (source === undefined) return null;
    const known = readers.get(chainId);
    if (known !== undefined) return known;
    const client = createPublicClient({
      chain: source.chain,
      transport: http(source.url, { timeout: CHAIN_READ_TIMEOUT_MS, retryCount: 1 }),
      ccipRead: false,
    });
    const reader: VaultReader = {
      claimed: (vault, account) => client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'claimed', args: [account] }),
      claimable: (vault, account, cumulativeAmount) =>
        client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'claimable', args: [account, cumulativeAmount] }),
      isContract: async (address) => isContractCode(await client.getCode({ address })),
    };
    readers.set(chainId, reader);
    return reader;
  };
}

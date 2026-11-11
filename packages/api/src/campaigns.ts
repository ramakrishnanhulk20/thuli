import type { Context, Env, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createPublicClient, http, type Chain } from 'viem';
import { base, baseSepolia, mainnet } from 'viem/chains';
import type { z } from 'zod';
import { accountTypeFromCode, checkAsk, parseAddress, type Address } from '@thuli/core';
import {
  activeList,
  addAsk,
  board,
  counts,
  getAsk,
  getCampaign,
  listText,
  listVersions,
  recordIfUnder,
  type Campaign,
  type Db,
  type PublicAsk,
} from '@thuli/store';
import { VAULT_ABI } from '@thuli/worker/src/vault/abi.ts';
import { claimTicket } from '@thuli/worker/src/vault/claimList.ts';
import { readPublishedList } from '@thuli/worker/src/vault/root.ts';
import { BASE_SEPOLIA_RPC } from './config.ts';
import {
  AskJson,
  AskRequest,
  AskView,
  BoardPage,
  BusyBody,
  CampaignView,
  ClosedBody,
  ErrorBody,
  ExistsBody,
  QueuedBody,
} from './schema.ts';
import { failureCode } from './stores.ts';

export const CAMPAIGNS_PATH = '/api/campaigns';
/** Requests one caller may send to the ask route in any 60 seconds, counted in a bucket of their own. */
export const ASK_CLIENT_MAX_PER_MINUTE = 20;
/** Asks with a valid signature one caller may send in any hour, counted in a bucket of their own. */
export const ASK_CLIENT_MAX_PER_HOUR = 5;
/** The most asks one board page holds. */
export const BOARD_PAGE_SIZE = 50;

const ASK_MINUTE_BUCKET = 'ask-minute';
const ASK_HOUR_BUCKET = 'ask-hour';
// A real ask is about 230 bytes: a wallet, a time and a 132 character signature (C41).
const MAX_ASK_BODY_BYTES = 1024;
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

export interface CampaignDeps {
  /** The database the campaign tables live in, the one the other stores use. */
  db: Db;
  /** On Ethereum, true only for account type contract: a delegated EOA keeps its own key and counts as a wallet (C20). */
  isContract(address: Address): Promise<boolean>;
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
 * lease or a caller's address (C40). Every route looks the campaign up before reading anything else of the request,
 * so an unknown id is 404 {"error": "no such campaign"} whatever else was sent, and a store that cannot answer is 503
 * {"busy": true} with nothing written. The app's own middleware marks every answer cache-control: no-store.
 *
 * - GET /api/campaigns/:id: the campaign's public terms, its counts and its list versions.
 * - GET /api/campaigns/:id/board?before=<ISO time>: 50 decided or failed asks, newest first, decided strictly before
 *   the given time when one is given, plus every further ask decided at the same instant as the 50th, so walking the
 *   board with before set to the last ask's decidedAt never skips one (see board in the store); 400 for a time that is
 *   not ISO 8601.
 * - POST /api/campaigns/:id/asks with exactly {wallet, signedAt, signature}, at most 1 KB. In order: the caller's
 *   address (400), its 20 requests a minute (429), counted before anything reads the chain, the body (413, 400),
 *   checkAsk with the campaign from the path and a wallet type read on Ethereum and on the campaign's chain (400
 *   with its cause), the caller's 5 signed asks an hour (429), then addAsk: 202 {"queued": true}, 200 {"exists": true,
 *   "ask"} with the first ask's public view, or 409 {"closed": true}. Nothing is screened inside the request.
 * - GET /api/campaigns/:id/asks/:wallet: the ask's public view (404 when the wallet never asked, 400 for a bad
 *   address), and when the wallet is on the active list its claim ticket, built from that version's published text
 *   exactly as stored and refused unless it rebuilds the stored root (C32). claimed and claimable are read from the
 *   vault when deps.vault has a reader for the campaign's chain, and left out when it has none or the read fails.
 * - GET /api/campaigns/:id/lists/:version: the published text byte for byte as application/json, or 404.
 *
 * @param clientOf the caller's address as the paid route reads it, or null when it cannot be read.
 */
export function registerCampaignRoutes<E extends Env>(app: Hono<E>, deps: CampaignDeps, clientOf: (c: Context) => string | null): void {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  // Per request, so later steps reuse what the first looked up without a second read.
  const campaigns = new WeakMap<Context, Campaign>();
  const clients = new WeakMap<Context, string>();

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

  const countAsk = async (c: Context, next: () => Promise<void>) => {
    const client = clientOf(c);
    if (client === null) {
      console.warn('api refused: the client address could not be read');
      return refused(c, 'the client address could not be read', 400);
    }
    let counted: boolean;
    try {
      counted = await recordIfUnder(db, ASK_MINUTE_BUCKET, client, ASK_CLIENT_MAX_PER_MINUTE, 60, now());
    } catch (error) {
      storeFailed('counting an ask request', error);
      return busy(c);
    }
    if (!counted) {
      console.warn('api ask busy: a client is past the minute limit');
      return busy(c, 429);
    }
    clients.set(c, client);
    await next();
    return undefined;
  };

  const campaignOf = (c: Context): Campaign => {
    const campaign = campaigns.get(c);
    if (campaign === undefined) throw new Error('the campaign was not looked up first');
    return campaign;
  };

  app.get(`${CAMPAIGNS_PATH}/:id`, findCampaign, async (c) => {
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

  app.get(`${CAMPAIGNS_PATH}/:id/board`, findCampaign, async (c) => {
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
    try {
      asks = await board(db, campaign.id, BOARD_PAGE_SIZE, before);
    } catch (error) {
      storeFailed('reading a board', error);
      return busy(c);
    }
    return answer(c, BoardPage, { asks: asks.map(askJson) }, 200);
  });

  app.post(
    `${CAMPAIGNS_PATH}/:id/asks`,
    findCampaign,
    countAsk,
    bodyLimit({ maxSize: MAX_ASK_BODY_BYTES, onError: (c) => answer(c, ErrorBody, { error: 'the body is too large' }, 413) }),
    async (c) => {
      const campaign = campaignOf(c);
      const client = clients.get(c) as string;
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return refused(c, 'the body must be JSON like {"wallet": "0x...", "signedAt": 0, "signature": "0x..."}', 400);
      }
      const parsed = AskRequest.safeParse(body);
      if (!parsed.success) return refused(c, 'the body must be exactly {"wallet", "signedAt", "signature"}', 400);
      const { wallet, signedAt, signature } = parsed.data;
      const at = now();
      const checked = await checkAsk(
        { campaignId: campaign.id, wallet, signedAt, signature },
        {
          expectedCampaignId: campaign.id,
          now: Math.floor(at.getTime() / 1000),
          isContract: (address) => contractOnEitherChain(campaign, address),
        },
      );
      if (!checked.ok) return refused(c, checked.cause, 400);
      try {
        if (!(await recordIfUnder(db, ASK_HOUR_BUCKET, client, ASK_CLIENT_MAX_PER_HOUR, 3_600, at))) {
          console.warn('api ask busy: a client is past the hour limit');
          return busy(c, 429);
        }
        const result = await addAsk(db, { campaignId: campaign.id, wallet: checked.wallet, signedAt, signature }, at);
        if (result === 'queued') return answer(c, QueuedBody, { queued: true }, 202);
        if (result === 'closed') return answer(c, ClosedBody, { closed: true }, 409);
        if (result === 'unknown') return answer(c, ErrorBody, NO_CAMPAIGN, 404);
        const first = await getAsk(db, campaign.id, checked.wallet);
        if (first === null) return busy(c);
        return answer(c, ExistsBody, { exists: true, ask: askJson(first) }, 200);
      } catch (error) {
        storeFailed('adding an ask', error);
        return busy(c);
      }
    },
  );

  app.get(`${CAMPAIGNS_PATH}/:id/asks/:wallet`, findCampaign, async (c) => {
    const campaign = campaignOf(c);
    let wallet: Address;
    try {
      wallet = parseAddress(c.req.param('wallet') ?? '');
    } catch {
      return refused(c, 'the wallet is not a valid address', 400);
    }
    let ask: PublicAsk | null;
    let active: Awaited<ReturnType<typeof activeList>>;
    let text: string | null = null;
    try {
      ask = await getAsk(db, campaign.id, wallet);
      if (ask === null) return refused(c, 'no ask from this wallet', 404);
      active = await activeList(db, campaign.id);
      if (active !== null) text = await listText(db, campaign.id, active.version);
    } catch (error) {
      storeFailed('reading an ask', error);
      return busy(c);
    }
    if (active === null || text === null) return answer(c, AskView, { ask: askJson(ask) }, 200);
    const ticket = claimTicket(text, campaign.vault, campaign.chain, wallet);
    if (ticket === null) return answer(c, AskView, { ask: askJson(ask) }, 200);
    // A ticket that proves against any root but the one recorded as active would send the wallet to a failing claim.
    if (ticket.root !== active.root) throw new Error('the active list text does not rebuild its recorded root');
    const amounts = await vaultAmounts(campaign, wallet, ticket.cumulativeAmount);
    return answer(
      c,
      AskView,
      {
        ask: askJson(ask),
        ticket: { cumulativeAmount: ticket.cumulativeAmount.toString(), proof: ticket.proof, root: ticket.root, ...amounts },
      },
      200,
    );
  });

  app.get(`${CAMPAIGNS_PATH}/:id/lists/:version`, findCampaign, async (c) => {
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

  /** The vault's claimed and claimable for a ticket, as decimal text, or nothing when no reader answers. Never throws. */
  async function vaultAmounts(campaign: Campaign, wallet: Address, cumulativeAmount: bigint): Promise<{ claimed?: string; claimable?: string }> {
    const reader = deps.vault?.(campaign.chain) ?? null;
    if (reader === null) return {};
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

// The facts' rule, so both chains judge one address the same way: no code is a wallet, a delegated EOA (EIP-7702) is
// a wallet, any other code is a contract. Code that is not hex rejects, so checkAsk refuses the wallet as unreadable.
function isContractCode(code: string | undefined): boolean {
  const type = accountTypeFromCode(code);
  if (type === 'unknown') throw new Error('the account code was not hex');
  return type === 'contract';
}

/**
 * Reads whether an address is a contract on Ethereum mainnet from its code, by the facts' rule (isContractCode).
 * Offchain lookups are off (C38), and each read gives up after 10 seconds.
 */
export function accountTypeReader(rpcUrl: string): (address: Address) => Promise<boolean> {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, { timeout: CHAIN_READ_TIMEOUT_MS, retryCount: 1 }),
    ccipRead: false,
  });
  return async (address) => isContractCode(await client.getCode({ address }));
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

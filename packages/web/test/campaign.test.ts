// Covers the ask message, a signature over it against core's own check, every fixture against the API's schema, the
// guards, the request mapping, the choice of panel and the payout sentences. It does not cover drawing, the wallet
// connection or polling; the browser script runs those against a page with an injected test wallet.
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import {
  APPEAL_COUNTER_FROM,
  APPEAL_MAX_CHARS,
  appealBody,
  appealMessage,
  appealProblem,
  appealSendable,
  appealTextHash,
  appealWarning,
  askBody,
  askMessage,
  isOneLine,
  isOwnKeySignature,
  isPlainWords,
  prepareAppealText,
  SIGNATURE,
  signedAtNow,
} from '../lib/ask';
import {
  APPEAL_COPY,
  appealChip,
  appealCountsLine,
  appealCountsOf,
  appealOf,
  appealPanel,
  appealPollDelay,
  appealRefusalText,
  appealStage,
  askPollDelay,
  boardCheckWords,
  ceilingWords,
  chainName,
  checkedWords,
  classifyAppealAnswer,
  choosePanel,
  classifyAskAnswer,
  currentStep,
  fetchAsk,
  fetchBoard,
  fetchCampaign,
  formatUtcMinute,
  funderFanoutText,
  funderKindWords,
  groupText,
  isAcceptingAsks,
  isAskJson,
  isAppealView,
  isAskView,
  isBoardPage,
  mergePayouts,
  PAYOUT_COPY,
  payoutWords,
  isCampaignView,
  LIST_STATUS_WORDS,
  mergeBoard,
  newestFirst,
  pollDelay,
  NEW_WALLET_ADVICE,
  NOT_CHECKED_INTRO,
  notCheckedLine,
  outcomeWords,
  payoutFor,
  postAppeal,
  postAsk,
  READY_TEXT,
  readyVariant,
  refusalFor,
  rowPayout,
  refusalWords,
  SLOWED_LINE,
  SLOWED_POLL_MILLISECONDS,
  showsWhatToDo,
  sessionFor,
  settledWords,
  statusLine,
  usdc,
  walletAmount,
  type AppealView,
  type AskJson,
  type CampaignView,
  type PanelInput,
  type Ticket,
} from '../lib/campaign';
import { notCheckedText } from '../lib/check';
import { BASE_CHAIN, ETHEREUM_CHAIN, explorerBase } from '../lib/explorer';
import { formatUsdc6 } from '../lib/vaultProof';
import { buildFixtures, CAMPAIGN_ID, fixtureWallet, type AskKind } from './campaignFixtures';

// The components import the site's own modules as '@/lib/...', which this test runner does not map, so each one is
// handed the real module it stands for.
vi.mock('@/lib/campaign', () => import('../lib/campaign'));
vi.mock('@/lib/check', () => import('../lib/check'));
vi.mock('@/lib/explorer', () => import('../lib/explorer'));
vi.mock('@/lib/format', () => import('../lib/format'));
vi.mock('@/lib/rules', () => import('../lib/rules'));
const { Facts } = await import('../components/campaign/Board');
const { CitedList } = await import('../components/campaign/Decision');

// The core and API packages are loaded by a computed path so the site's own type check does not follow into their sources.
const loadPackage = (name: string): Promise<any> => import(/* @vite-ignore */ name);
const core = await loadPackage('@thuli/core');
const { checkAsk, askMessage: coreAskMessage } = core;
const {
  AskJson: AskSchema,
  AskView: AskViewSchema,
  BoardPage: BoardSchema,
  CampaignView: CampaignSchema,
  BusyBody,
  ClosedBody,
  ErrorBody,
  ExistsBody,
  FullBody,
  NeverUsedBody,
  AppealJson,
  ApprovedBody,
  ExistsAppealBody,
  UndecidedBody,
  QueuedBody,
} = await loadPackage('../../api/src/schema');

const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const signer = privateKeyToAccount(TEST_KEY);
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const fx = buildFixtures({ wallet: signer.address, now: NOW });
const campaign = fx.campaign() as unknown as CampaignView;
const asView = (kind: AskKind, slot: number | null = 3) => fx.ask(kind, signer.address, slot) as unknown as AskJson;

describe('the ask message', () => {
  it('is exactly the four lines, with the wallet checksummed whatever spelling came in', () => {
    const message = askMessage({ campaignId: 'spring-drop_2026.v1', wallet: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'.toLowerCase(), signedAt: 1_800_000_000 });
    expect(message).toBe('Thuli ask v1\nCampaign: spring-drop_2026.v1\nWallet: 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed\nSigned at: 1800000000\n');
  });

  it('equals the text core builds for the same input', () => {
    const input = { campaignId: CAMPAIGN_ID, wallet: signer.address, signedAt: 1_800_000_123 };
    expect(askMessage(input)).toBe(coreAskMessage(input));
  });

  it('refuses a campaign id or time that could change the shape of the text, and a wallet that is not an address', () => {
    const good = { campaignId: CAMPAIGN_ID, wallet: signer.address, signedAt: 1_800_000_000 };
    for (const campaignId of ['', 'a b', 'a\nb', 'a:b', 'x'.repeat(129)]) expect(() => askMessage({ ...good, campaignId })).toThrow(RangeError);
    for (const signedAt of [-1, 1.5, Number.NaN, 2 ** 60]) expect(() => askMessage({ ...good, signedAt })).toThrow(RangeError);
    expect(() => askMessage({ ...good, wallet: '0x123' })).toThrow();
  });

  it('turns a clock in milliseconds into whole seconds', () => {
    expect(signedAtNow(1_800_000_000_999)).toBe(1_800_000_000);
    expect(Number.isInteger(signedAtNow())).toBe(true);
  });

  it('is signed in a form core accepts, and only for this campaign, wallet and time', async () => {
    const signedAt = 1_800_000_000;
    const message = askMessage({ campaignId: CAMPAIGN_ID, wallet: signer.address, signedAt });
    const signature = await signer.signMessage({ message });
    expect(signature).toMatch(SIGNATURE);
    expect(signature).toHaveLength(132);
    const context = { expectedCampaignId: CAMPAIGN_ID, now: signedAt + 5, isContract: async () => false };
    expect(await checkAsk({ campaignId: CAMPAIGN_ID, wallet: signer.address, signedAt, signature }, context)).toEqual({ ok: true, wallet: signer.address });
    expect((await checkAsk({ campaignId: CAMPAIGN_ID, wallet: signer.address, signedAt: signedAt + 1, signature }, context)).ok).toBe(false);
    expect((await checkAsk({ campaignId: 'another', wallet: signer.address, signedAt, signature }, { ...context, expectedCampaignId: 'another' })).ok).toBe(false);
    expect((await checkAsk({ campaignId: CAMPAIGN_ID, wallet: fixtureWallet(1), signedAt, signature }, context)).ok).toBe(false);
  });

  it('builds the request body with exactly the three fields', () => {
    const body = JSON.parse(askBody({ wallet: signer.address, signedAt: 7, signature: `0x${'a'.repeat(130)}` })) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['wallet', 'signedAt', 'signature']);
  });
});

describe('the fixtures', () => {
  it('parse as the shape of the route that sends them', () => {
    expect(CampaignSchema.safeParse(fx.campaign()).success).toBe(true);
    expect(CampaignSchema.safeParse(fx.campaign({ status: 'closed', lists: fx.lists('none') })).success).toBe(true);
    expect(CampaignSchema.safeParse(fx.campaign({ lists: fx.lists('two') })).success).toBe(true);
    expect(CampaignSchema.safeParse(fx.campaign({ lists: fx.lists('sending') })).success).toBe(true);
    const kinds: AskKind[] = ['queued', 'screening', 'full', 'partial', 'fullNoSlot', 'hold', 'exclude', 'failed'];
    for (const kind of kinds) {
      const result = AskSchema.safeParse(fx.ask(kind, signer.address, 3));
      expect(result.success, `${kind}: ${result.success ? '' : JSON.stringify(result.error.issues)}`).toBe(true);
    }
  });

  it('parse as answers of the ask and board routes', () => {
    const decided = fx.ask('full', signer.address, 3);
    expect(AskViewSchema.safeParse(fx.askView(decided)).success).toBe(true);
    expect(AskViewSchema.safeParse(fx.askView(decided, fx.ticket())).success).toBe(true);
    expect(AskViewSchema.safeParse(fx.askView(decided, fx.ticket({ claimed: undefined, claimable: undefined }))).success).toBe(true);
    expect(ExistsBody.safeParse({ exists: true, ask: decided }).success).toBe(true);
    for (const count of [0, 1, 50]) expect(BoardSchema.safeParse(fx.board(count)).success, `${count} rows`).toBe(true);
    expect(QueuedBody.safeParse({ queued: true }).success).toBe(true);
    expect(ClosedBody.safeParse({ closed: true }).success).toBe(true);
    expect(BusyBody.safeParse({ busy: true }).success).toBe(true);
    expect(ErrorBody.safeParse({ error: 'no such campaign' }).success).toBe(true);
    expect(ErrorBody.safeParse({ error: 'no ask from this wallet' }).success).toBe(true);
    expect(ErrorBody.safeParse({ error: 'the signature is too old' }).success).toBe(true);
  });

  it('are accepted by the page guards, which refuse a damaged copy', () => {
    expect(isCampaignView(fx.campaign())).toBe(true);
    expect(isAskJson(fx.ask('hold', signer.address))).toBe(true);
    expect(isAskView(fx.askView(fx.ask('full', signer.address, 1), fx.ticket()))).toBe(true);
    expect(isBoardPage(fx.board(3))).toBe(true);
    expect(isCampaignView(fx.campaign({ lists: fx.lists('sending') }))).toBe(true);
    expect(isCampaignView({ ...fx.campaign(), maxSlots: '20' })).toBe(false);
    expect(isCampaignView({ ...fx.campaign(), counts: { asked: 1 } })).toBe(false);
    expect(isCampaignView({ ...fx.campaign(), lists: [{ version: 1, root: 'nope', status: 'active', postTx: null, claimableAt: null }] })).toBe(false);
    const sending = fx.lists('sending').at(-1) as Record<string, unknown>;
    expect(isCampaignView({ ...fx.campaign(), lists: [{ ...sending, status: 'frozen' }] })).toBe(false);
    expect(isAskJson({ ...fx.ask('hold', signer.address), status: 'paid' })).toBe(false);
    expect(isAskJson({ ...fx.ask('hold', signer.address), action: 'approve' })).toBe(false);
    expect(isBoardPage({ asks: [{}] })).toBe(false);
    expect(isAskView({ ask: fx.ask('full', signer.address), ticket: { cumulativeAmount: 'x' } })).toBe(false);
  });
});

describe('the requests', () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('reads a campaign, and reads a 404, a bad body, another status and a failed request as none', async () => {
    expect(await fetchCampaign(CAMPAIGN_ID, reply(200, fx.campaign()))).toEqual({ kind: 'found', campaign: fx.campaign() });
    expect(await fetchCampaign(CAMPAIGN_ID, reply(404, { error: 'no such campaign' }))).toEqual({ kind: 'none' });
    expect(await fetchCampaign(CAMPAIGN_ID, reply(200, { name: 'x' }))).toEqual({ kind: 'none' });
    expect(await fetchCampaign(CAMPAIGN_ID, reply(503, { busy: true }))).toEqual({ kind: 'none' });
    expect(await fetchCampaign(CAMPAIGN_ID, (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch)).toEqual({ kind: 'none' });
  });

  it('reads a 429 on any read route as busy, never as none or as an error', async () => {
    expect(await fetchCampaign(CAMPAIGN_ID, reply(429, { busy: true }))).toEqual({ kind: 'busy' });
    expect(await fetchAsk(CAMPAIGN_ID, signer.address, reply(429, { busy: true }))).toEqual({ kind: 'busy' });
    expect(await fetchBoard(CAMPAIGN_ID, null, reply(429, { busy: true }))).toEqual({ kind: 'busy' });
    expect(await fetchBoard(CAMPAIGN_ID, null, reply(200, fx.board(2)))).toEqual({ kind: 'page', asks: fx.board(2).asks, payouts: [] });
    expect(await fetchBoard(CAMPAIGN_ID, null, reply(500, {}))).toEqual({ kind: 'failed' });
    expect(BusyBody.safeParse({ busy: true }).success).toBe(true);
  });

  it('reads the payouts a board page carries, reads none when the server sends none, and refuses a page with a damaged one', async () => {
    const page = fx.board(3, 1, undefined, (index) => index === 0);
    expect(BoardSchema.safeParse(page).success).toBe(true);
    expect(isBoardPage(page)).toBe(true);
    expect(page.payouts).toHaveLength(1);
    expect(await fetchBoard(CAMPAIGN_ID, null, reply(200, page))).toEqual({ kind: 'page', asks: page.asks, payouts: page.payouts });
    expect(await fetchBoard(CAMPAIGN_ID, null, reply(200, { asks: page.asks }))).toEqual({ kind: 'page', asks: page.asks, payouts: [] });
    const good = page.payouts[0] as { wallet: string; amount: string; transaction: string };
    const damaged: unknown[] = [
      { ...good, amount: '0.5' },
      { ...good, amount: '0' },
      { ...good, transaction: good.transaction.toUpperCase() },
      { ...good, wallet: 'nope' },
      'paid',
    ];
    for (const bad of damaged) {
      expect(isBoardPage({ asks: page.asks, payouts: [bad] })).toBe(false);
      expect(await fetchBoard(CAMPAIGN_ID, null, reply(200, { asks: page.asks, payouts: [bad] }))).toEqual({ kind: 'failed' });
    }
    expect(isBoardPage({ asks: page.asks, payouts: 'none' })).toBe(false);
  });

  it('keeps payouts by wallet whatever its letter case, lets a newer total replace an older one, and words one in USDC', () => {
    const page = fx.board(3, 1, undefined, () => true);
    const first = page.payouts[0] as { wallet: string; amount: string; transaction: string };
    const kept = mergePayouts(new Map(), page.payouts);
    expect(kept.size).toBe(3);
    expect(kept.get(first.wallet.toLowerCase())).toEqual(first);
    const merged = mergePayouts(kept, [{ ...first, wallet: first.wallet.toLowerCase(), amount: '750000' }]);
    expect(merged.size).toBe(3);
    expect(merged.get(first.wallet.toLowerCase())?.amount).toBe('750000');
    expect(kept.get(first.wallet.toLowerCase())?.amount).toBe('500000');
    expect(payoutWords(first)).toBe('The vault has paid this wallet 0.5 USDC.');
    expect(payoutWords({ ...first, amount: '250000' })).toBe('The vault has paid this wallet 0.25 USDC.');
    expect(PAYOUT_COPY.chip).toBe('PAID');
  });

  it('shows a payout only on a row that holds a slot, whatever the board sent for its wallet (C61)', () => {
    const page = fx.board(3, 1, undefined, () => true);
    const first = page.payouts[0] as { wallet: string; amount: string; transaction: string };
    const kept = mergePayouts(new Map(), page.payouts);
    expect(rowPayout({ wallet: first.wallet, slot: 1 }, kept)).toEqual(first);
    expect(rowPayout({ wallet: first.wallet.toUpperCase().replace('0X', '0x'), slot: 3 }, kept)).toEqual(first);
    expect(rowPayout({ wallet: first.wallet, slot: null }, kept)).toBeNull();
    expect(rowPayout({ wallet: `0x${'9'.repeat(40)}`, slot: 2 }, kept)).toBeNull();
  });

  it('reads an ask lookup as found, none or error', async () => {
    const view = fx.askView(fx.ask('queued', signer.address));
    expect((await fetchAsk(CAMPAIGN_ID, signer.address, reply(200, view))).kind).toBe('found');
    expect((await fetchAsk(CAMPAIGN_ID, signer.address, reply(404, { error: 'no ask from this wallet' }))).kind).toBe('none');
    expect((await fetchAsk(CAMPAIGN_ID, signer.address, reply(400, { error: 'the wallet is not a valid address' }))).kind).toBe('error');
    expect((await fetchAsk(CAMPAIGN_ID, signer.address, reply(200, { ask: {} }))).kind).toBe('error');
  });

  it('asks for the right addresses', async () => {
    const urls: string[] = [];
    const record = (async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ asks: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchBoard(CAMPAIGN_ID, null, record);
    await fetchBoard(CAMPAIGN_ID, '2026-11-11T12:00:00.000Z', record);
    expect(urls).toEqual([`/api/campaigns/${CAMPAIGN_ID}/board`, `/api/campaigns/${CAMPAIGN_ID}/board?before=2026-11-11T12%3A00%3A00.000Z`]);
  });

  it('posts the signed ask to the campaign in the path', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const record = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify({ queued: true }), { status: 202 });
    }) as unknown as typeof fetch;
    const signed = { wallet: signer.address, signedAt: 1_800_000_000, signature: `0x${'b'.repeat(130)}` };
    expect(await postAsk(CAMPAIGN_ID, signed, record)).toEqual({ kind: 'queued' });
    expect(seen[0]?.url).toBe(`/api/campaigns/${CAMPAIGN_ID}/asks`);
    expect(seen[0]?.init).toMatchObject({ method: 'POST', cache: 'no-store' });
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual(signed);
  });

  it('reads Retry-After off a 429 when it posts, and only then', async () => {
    const signed = { wallet: signer.address, signedAt: 1_800_000_000, signature: `0x${'b'.repeat(130)}` };
    const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
    expect(await postAsk(CAMPAIGN_ID, signed, answer(429, { busy: true }, { 'Retry-After': '7200' }))).toEqual({ kind: 'ceiling', retryAfter: '7200' });
    expect(await postAsk(CAMPAIGN_ID, signed, answer(429, { busy: true }))).toEqual({ kind: 'limit' });
    expect(await postAsk(CAMPAIGN_ID, signed, answer(409, { full: true }))).toEqual({ kind: 'full' });
    expect(await postAsk(CAMPAIGN_ID, signed, answer(409, { closed: true }))).toEqual({ kind: 'closed' });
  });

  it('maps each answer of the ask route', () => {
    const exists = fx.ask('full', signer.address, 1);
    expect(classifyAskAnswer(202, { queued: true })).toEqual({ kind: 'queued' });
    expect(classifyAskAnswer(200, { exists: true, ask: exists })).toEqual({ kind: 'exists', ask: exists });
    expect(classifyAskAnswer(409, { closed: true })).toEqual({ kind: 'closed' });
    expect(classifyAskAnswer(409, { full: true })).toEqual({ kind: 'full' });
    expect(classifyAskAnswer(429, { busy: true })).toEqual({ kind: 'limit' });
    expect(classifyAskAnswer(429, { busy: true }, null)).toEqual({ kind: 'limit' });
    expect(classifyAskAnswer(429, { busy: true }, '7200')).toEqual({ kind: 'ceiling', retryAfter: '7200' });
    expect(classifyAskAnswer(429, { busy: true }, 'soon')).toEqual({ kind: 'ceiling', retryAfter: 'soon' });
    expect(classifyAskAnswer(409, { full: true }, '60')).toEqual({ kind: 'full' });
    expect(classifyAskAnswer(400, { error: 'the signature is too old' })).toEqual({ kind: 'bad', cause: 'the signature is too old' });
    expect(classifyAskAnswer(413, { error: 'the body is too large' })).toEqual({ kind: 'bad', cause: 'the body is too large' });
    expect(classifyAskAnswer(404, { error: 'no such campaign' })).toEqual({ kind: 'gone' });
    for (const [status, body] of [[503, { busy: true }], [500, {}], [200, { exists: true }], [202, {}], [400, {}]] as const) {
      expect(classifyAskAnswer(status, body), `${status}`).toEqual({ kind: 'unreachable' });
    }
  });
});

describe('choosePanel', () => {
  const base: PanelInput = { connected: true, ask: null, looking: false, signing: false, sent: false, refused: false, unreachable: false };

  it('offers the connect choices to a wallet that is not connected, whatever else is true', () => {
    expect(choosePanel({ ...base, connected: false })).toBe('connect');
    expect(choosePanel({ ...base, connected: false, ask: asView('full'), signing: true })).toBe('connect');
  });

  it('checks, then offers the ask to a connected wallet with no ask', () => {
    expect(choosePanel({ ...base, looking: true })).toBe('checking');
    expect(choosePanel(base)).toBe('ready');
  });

  it('shows signing while the wallet is asked, and screening once the ask was sent or found queued', () => {
    expect(choosePanel({ ...base, signing: true })).toBe('signing');
    expect(choosePanel({ ...base, sent: true })).toBe('screening');
    expect(choosePanel({ ...base, ask: asView('queued') })).toBe('screening');
    expect(choosePanel({ ...base, ask: asView('screening') })).toBe('screening');
  });

  it('shows the decision for a decided or failed ask', () => {
    for (const kind of ['full', 'partial', 'fullNoSlot', 'hold', 'exclude', 'failed'] as const) expect(choosePanel({ ...base, ask: asView(kind) }), kind).toBe('decided');
  });

  it('shows the unreachable state when nothing could be read or sent and there is no ask', () => {
    expect(choosePanel({ ...base, unreachable: true })).toBe('unreachable');
    expect(choosePanel({ ...base, unreachable: true, ask: asView('full') })).toBe('decided');
  });

  it('shows a refusal in place of the ask, until the wallet has an ask of its own', () => {
    expect(choosePanel({ ...base, refused: true })).toBe('refused');
    expect(choosePanel({ ...base, refused: true, unreachable: true })).toBe('refused');
    expect(choosePanel({ ...base, refused: true, ask: asView('queued') })).toBe('screening');
    expect(choosePanel({ ...base, refused: true, ask: asView('hold') })).toBe('decided');
    expect(choosePanel({ ...base, refused: true, signing: true })).toBe('signing');
    expect(choosePanel({ ...base, refused: true, connected: false })).toBe('connect');
  });

  it('closes, fills or opens the ready state from the campaign and the clock', () => {
    expect(readyVariant(campaign, NOW)).toBe('open');
    expect(readyVariant({ ...campaign, status: 'closed' }, NOW)).toBe('closed');
    expect(readyVariant(campaign, Date.parse(campaign.closesAt))).toBe('closed');
    expect(readyVariant(campaign, Date.parse(campaign.opensAt) - 1)).toBe('closed');
    expect(readyVariant({ ...campaign, counts: { ...campaign.counts, slotsLeft: 0 } }, NOW)).toBe('full');
    expect(readyVariant({ ...campaign, counts: { ...campaign.counts, asksLeft: 0 } }, NOW)).toBe('stopped');
    expect(readyVariant({ ...campaign, counts: { ...campaign.counts, slotsLeft: 0, asksLeft: 0 } }, NOW)).toBe('full');
    expect(readyVariant({ ...campaign, status: 'closed', counts: { ...campaign.counts, asksLeft: 0 } }, NOW)).toBe('closed');
    expect(isAcceptingAsks(campaign, NOW)).toBe(true);
  });
});

describe('payoutFor', () => {
  const noTicket = (kind: AskKind, slot: number | null = 3) => payoutFor({ ask: asView(kind, slot), ticket: null, campaign, now: NOW });
  const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({ cumulativeAmount: '1000000', proof: [], root: campaign.lists[0]?.root ?? '', ...overrides });

  it('says a held, excluded or failed wallet has no reward and that appeals are not open', () => {
    for (const kind of ['hold', 'exclude', 'failed'] as const) {
      expect(noTicket(kind)).toEqual({ lines: ['No reward is reserved for this wallet.'], paid: false });
    }
  });

  it('says an approved wallet without a slot was too late', () => {
    expect(noTicket('fullNoSlot')).toEqual({ lines: ['Approved, but every slot was already taken.'], paid: false });
  });

  it('names the slot and the amount for an approved wallet with no ticket yet, in full and in part', () => {
    expect(noTicket('full', 3)).toEqual({
      lines: ['You hold slot 3.', 'Your 1 USDC goes on the next list Thuli posts. A list waits in the vault before it pays.'],
      paid: false,
    });
    expect(noTicket('partial', 4).lines[1]).toBe('Your 0.5 USDC goes on the next list Thuli posts. A list waits in the vault before it pays.');
  });

  it('puts a ticket holder on its list, and says when the list starts paying or that the claim is being submitted', () => {
    const lists = [{ version: 2, root: campaign.lists[0]?.root ?? '', status: 'posted' as const, postTx: null, claimableAt: Math.floor(NOW / 1000) + 3600 }];
    const future = payoutFor({ ask: asView('full'), ticket: ticket({ claimed: '0' }), campaign: { ...campaign, lists }, now: NOW });
    expect(future).toEqual({ lines: ['You are on list 2.', `It starts paying at ${formatUtcMinute(NOW + 3_600_000)}.`], paid: false });
    expect(future.lines[1]).toBe('It starts paying at 11 Nov 2026, 13:00 UTC.');
    const started = payoutFor({ ask: asView('full'), ticket: ticket({ claimed: '0' }), campaign: { ...campaign, lists: [{ ...lists[0]!, claimableAt: Math.floor(NOW / 1000) - 1 }] }, now: NOW });
    expect(started.lines).toEqual(['You are on list 2.', 'Thuli is submitting your claim. You do not need to do anything.']);
    const unread = payoutFor({ ask: asView('full'), ticket: ticket(), campaign: { ...campaign, lists: [{ ...lists[0]!, claimableAt: Math.floor(NOW / 1000) - 1 }] }, now: NOW });
    expect(unread.paid).toBe(false);
  });

  it('shows the paid line, in the full colour, once claimed is at or above the amount', () => {
    expect(payoutFor({ ask: asView('full'), ticket: ticket({ claimed: '1000000' }), campaign, now: NOW })).toEqual({ lines: ['Paid: 1 USDC is in your wallet.'], paid: true });
    expect(payoutFor({ ask: asView('full'), ticket: ticket({ cumulativeAmount: '500000', claimed: '900000' }), campaign, now: NOW }).lines).toEqual(['Paid: 0.5 USDC is in your wallet.']);
    expect(payoutFor({ ask: asView('full'), ticket: ticket({ claimed: '999999' }), campaign, now: NOW }).paid).toBe(false);
  });
});

describe('what the page says', () => {
  it('writes the list statuses in plain words', () => {
    expect(LIST_STATUS_WORDS).toEqual({
      built: 'built',
      sending: 'sent, waiting for the network',
      posted: 'posted, waiting',
      active: 'paying',
      superseded: 'replaced',
      cancelled: 'cancelled',
    });
  });

  it('puts lists newest first and board rows newest decision first, once per wallet', () => {
    expect(newestFirst(fx.campaign({ lists: fx.lists('two') }).lists as never).map((list) => list.version)).toEqual([4, 3, 2, 1]);
    const first = (fx.board(3, 1).asks as unknown as AskJson[]);
    const older = (fx.board(3, 10).asks as unknown as AskJson[]);
    const merged = mergeBoard(older, first);
    expect(merged).toHaveLength(6);
    expect(merged.map((row) => row.decidedAt)).toEqual([...merged.map((row) => row.decidedAt)].sort().reverse());
    expect(mergeBoard(merged, [{ ...first[0]!, slot: 99 }]).find((row) => row.wallet === first[0]!.wallet)?.slot).toBe(99);
    expect(mergeBoard(merged, first)).toHaveLength(6);
  });

  it('names the chains', () => {
    expect(chainName(84532)).toBe('Base Sepolia');
    expect(chainName(8453)).toBe('Base');
    expect(chainName(1)).toBe('chain 1');
  });

  it('writes USDC as the vault page does, the time to the minute in UTC, and the campaign status', () => {
    for (const units of ['0', '1', '500000', '1000000', '2500000', '123456789']) expect(usdc(units)).toBe(formatUsdc6(units));
    expect(formatUtcMinute(Date.UTC(2026, 10, 15, 23, 59, 30))).toBe('15 Nov 2026, 23:59 UTC');
    expect(statusLine({ ...campaign, closesAt: '2026-11-15T23:59:00.000Z' })).toBe('Open until 15 Nov 2026, 23:59 UTC');
    expect(statusLine({ ...campaign, status: 'closed' })).toBe('Closed');
    expect(walletAmount('1000000', 5000)).toBe(500000n);
    expect(walletAmount('3', 3333)).toBe(0n);
  });
});

describe('outcome words', () => {
  const pairs = [
    ['full', false, 'Approved in full'],
    ['full', true, 'Paid in full'],
    ['partial', false, 'Approved for a partial reward'],
    ['partial', true, 'Paid a partial reward'],
    ['hold', false, 'Held for review'],
    ['hold', true, 'Held for review'],
    ['exclude', false, 'Excluded'],
    ['exclude', true, 'Excluded'],
  ] as const;

  it('maps every decision and payment pair to its words', () => {
    for (const [action, paid, words] of pairs) expect(outcomeWords(action, paid), `${action} ${paid}`).toBe(words);
  });

  it('says Paid only for an approved wallet the vault has paid', () => {
    for (const [action, paid, words] of pairs) expect(/Paid/.test(words), `${action} ${paid}`).toBe(paid && (action === 'full' || action === 'partial'));
  });

  it('writes board labels as decisions only, whatever the payment flag says', () => {
    for (const paid of [false, true]) {
      expect(outcomeWords('full', paid, 'board')).toBe('Approved in full');
      expect(outcomeWords('partial', paid, 'board')).toBe('Approved, partial');
      expect(outcomeWords('hold', paid, 'board')).toBe('Held for review');
      expect(outcomeWords('exclude', paid, 'board')).toBe('Excluded');
    }
  });
});

describe('the not-checked lines', () => {
  const workerNames = ['sharedDepositAddress', 'sweptToSharedCollector', 'claimPaidToOtherAddress', 'fundingBurst', 'passThroughFunding'];

  it('has a plain line for each of the five names the worker can send', () => {
    for (const name of workerNames) {
      expect(notCheckedText(name), name).not.toBe(name);
      expect(notCheckedLine(name), name).toBe(notCheckedText(name));
    }
    expect(notCheckedLine('sweptToSharedCollector')).toBe('Sweeps to a shared collector wallet');
    expect(notCheckedLine('passThroughFunding')).toBe('Funding passed through in-between wallets');
  });

  it('matches the list the worker sends, and the fixtures send exactly that list', async () => {
    const worker = await loadPackage('../../worker/src/campaign/facts');
    expect([...worker.CAMPAIGN_NOT_CHECKED]).toEqual(workerNames);
    for (const kind of ['full', 'partial', 'hold', 'exclude', 'failed'] as const) expect(fx.ask(kind, signer.address, 1).notChecked, kind).toEqual(workerNames);
  });

  it('never shows a name raw: one the table does not know reads as a fact that could not be read', () => {
    for (const name of ['somethingNew', 'group_2', '', 'x'.repeat(40)]) {
      expect(notCheckedText(name)).toBe(name);
      expect(notCheckedLine(name)).toBe('Another fact this screening could not read');
    }
  });

  it('opens with the campaign sentence, not the check page one', () => {
    expect(NOT_CHECKED_INTRO).toBe("Thuli read this wallet's own history and linked it to the other wallets that asked here. It did not measure:");
  });
});

describe('the facts of an opened board row', () => {
  it('says what kind of wallet the first funder is', () => {
    expect(funderKindWords('wallet')).toBe('a wallet');
    expect(funderKindWords('exchange')).toBe('an exchange');
    expect(funderKindWords('bridge')).toBe('a bridge');
    expect(funderKindWords('contract')).toBe('a contract');
    expect(funderKindWords('unknown')).toBe('kind unknown');
    expect(funderKindWords('something else')).toBe('kind unknown');
  });

  it('counts the wallets a funder paid, and says why a funder is not counted', () => {
    expect(funderFanoutText({ kind: 'wallet', fanout: 22 })).toBe('22');
    expect(funderFanoutText({ kind: 'wallet', fanout: 1353 })).toBe('1,353');
    expect(funderFanoutText({ kind: 'exchange', fanout: null })).toBe('Not counted: an exchange pays strangers');
    expect(funderFanoutText({ kind: 'bridge', fanout: null })).toBe('Not counted');
    expect(funderFanoutText({ kind: 'contract', fanout: null })).toBe('Not counted');
    expect(funderFanoutText({ kind: 'wallet', fanout: null })).toBeNull();
    expect(funderFanoutText({ kind: 'unknown', fanout: null })).toBeNull();
  });

  it('names the group by the wallets that asked here', () => {
    expect(groupText(null)).toBe('None');
    expect(groupText(22)).toBe('22 wallets that asked here');
    expect(groupText(1)).toBe('1 wallet that asked here');
    expect(groupText(1500)).toBe('1,500 wallets that asked here');
  });
});

describe('currentStep', () => {
  const step = (kind: AskKind | null, input: { sent?: boolean; paid?: boolean; slot?: number | null } = {}) =>
    currentStep({ ask: kind === null ? null : asView(kind, input.slot === undefined ? 3 : input.slot), sent: input.sent ?? false, paid: input.paid ?? false });

  it('is the first step with no ask: not connected, connected with none, or the lookup not yet answered', () => {
    expect(step(null)).toBe(1);
  });

  it('is the second step while the ask is sent, queued or being screened', () => {
    expect(step(null, { sent: true })).toBe(2);
    expect(step('queued')).toBe(2);
    expect(step('screening')).toBe(2);
  });

  it('is the third step for an approved wallet with a slot that is not paid yet', () => {
    expect(step('full')).toBe(3);
    expect(step('partial')).toBe(3);
  });

  it('is no step once paid, held, excluded, failed, or approved with no slot', () => {
    expect(step('full', { paid: true })).toBeNull();
    expect(step('partial', { paid: true })).toBeNull();
    expect(step('hold')).toBeNull();
    expect(step('exclude')).toBeNull();
    expect(step('failed')).toBeNull();
    expect(step('fullNoSlot')).toBeNull();
    expect(step('full', { slot: null })).toBeNull();
  });
});

describe('the plain line for a held wallet that has no history', () => {
  const noHistory = { txCount: 0, funder: null, ageDays: 0, groupSize: null };
  const held = (facts: Record<string, unknown> = noHistory) => fx.ask('hold', signer.address, null, 5, facts) as unknown as AskJson;

  it('says exactly what the wallet should do, in the words the page shows', () => {
    expect(NEW_WALLET_ADVICE).toBe(
      'This wallet has never been used on Ethereum or Base, so nothing sets it apart from one made a minute ago. Ask with a wallet you have used for a while.',
    );
  });

  it('shows for a decided hold with zero transactions sent and no first funder', () => {
    expect(showsWhatToDo(held())).toBe(true);
  });

  it('does not show for a hold whose wallet has a funder, or has sent anything, or whose counts were not read', () => {
    expect(showsWhatToDo(held({ ...noHistory, funder: { address: signer.address, kind: 'wallet', fanout: 1, hops: 1 } }))).toBe(false);
    expect(showsWhatToDo(held({ ...noHistory, txCount: 1 }))).toBe(false);
    expect(showsWhatToDo(held({ ...noHistory, txCount: null }))).toBe(false);
  });

  it('does not show for the linked-family hold the fixtures use, nor for any other outcome', () => {
    expect(showsWhatToDo(fx.ask('hold', signer.address) as unknown as AskJson)).toBe(false);
    for (const kind of ['full', 'partial', 'fullNoSlot', 'exclude'] as const) {
      expect(showsWhatToDo(fx.ask(kind, signer.address, 3, 5, noHistory) as unknown as AskJson)).toBe(false);
    }
  });

  it('does not show for a screening that failed, or one still running', () => {
    expect(showsWhatToDo({ ...(fx.ask('failed', signer.address) as unknown as AskJson), facts: { ...noHistory, accountType: 'eoa', burstWallets: null, missing: [], chain: 'ethereum' } })).toBe(false);
    expect(showsWhatToDo(fx.ask('queued', signer.address) as unknown as AskJson)).toBe(false);
    expect(showsWhatToDo(fx.ask('screening', signer.address) as unknown as AskJson)).toBe(false);
  });

  it('does not show when the answer carries no facts', () => {
    expect(showsWhatToDo({ ...held(), facts: null })).toBe(false);
  });
});

describe('a list that is being sent', () => {
  it('has its transaction and no time it can be claimed from', () => {
    const sending = fx.lists('sending').at(-1) as { status: string; postTx: string | null; claimableAt: number | null };
    expect(sending.status).toBe('sending');
    expect(sending.postTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sending.claimableAt).toBeNull();
  });
});

describe('the words for a refused ask', () => {
  it('says the campaign has stopped taking requests when it has none left but has slots', () => {
    expect(refusalWords('stopped')).toEqual({
      heading: 'This campaign has stopped taking requests',
      body: 'It has screened as many wallets as it set out to. No new request can be sent.',
    });
  });

  it('says the campaign is full, and that nothing was spent', () => {
    expect(refusalWords('full')).toEqual({
      heading: 'This campaign is full',
      body: 'Your request was not taken, and nothing was spent. Signing a message costs nothing.',
    });
  });

  it('says it is a smart contract wallet that cannot ask yet', () => {
    expect(refusalWords('contract')).toEqual({
      heading: 'This looks like a smart contract wallet',
      body: 'Wallets that sign through a contract cannot ask yet. Ask with a wallet that signs with its own key.',
    });
  });

  it('says the day is used up, and when to come back, from the Retry-After header', () => {
    expect(refusalWords('ceiling', '7200')).toEqual({ heading: 'Thuli has taken all the requests it screens in a day', body: 'Try again in about 2 hours.' });
    expect(refusalWords('ceiling', null).body).toBe('Try again tomorrow.');
  });

  it('writes the wait from seconds: whole hours from an hour up, five-minute steps below it, tomorrow when there is no number', () => {
    const cases: [string | null, string][] = [
      ['30', 'Try again in about 5 minutes.'],
      ['1', 'Try again in about 5 minutes.'],
      ['300', 'Try again in about 5 minutes.'],
      ['301', 'Try again in about 10 minutes.'],
      ['3599', 'Try again in about 60 minutes.'],
      ['3600', 'Try again in about 1 hour.'],
      ['3601', 'Try again in about 2 hours.'],
      ['7200', 'Try again in about 2 hours.'],
      ['86400', 'Try again in about 24 hours.'],
      [null, 'Try again tomorrow.'],
      ['', 'Try again tomorrow.'],
      ['soon', 'Try again tomorrow.'],
      ['0', 'Try again tomorrow.'],
      ['-5', 'Try again tomorrow.'],
      ['12.5', 'Try again tomorrow.'],
      ['Wed, 21 Oct 2026 07:28:00 GMT', 'Try again tomorrow.'],
    ];
    for (const [header, words] of cases) expect(ceilingWords(header), String(header)).toBe(words);
  });

  it('accepts the new answers the API sends', () => {
    expect(FullBody.safeParse({ full: true }).success).toBe(true);
    expect(FullBody.safeParse({ full: false }).success).toBe(false);
    expect(BusyBody.safeParse({ busy: true }).success).toBe(true);
    expect(CampaignSchema.safeParse(fx.campaign({ counts: { ...campaign.counts, asksLeft: 0 } })).success).toBe(true);
    expect(CampaignSchema.safeParse(fx.campaign({ counts: { ...campaign.counts, slotsLeft: 0, asksLeft: 0 } })).success).toBe(true);
    expect(isCampaignView(fx.campaign({ counts: { ...campaign.counts, asksLeft: 0 } }))).toBe(true);
    expect(isCampaignView(fx.campaign({ counts: { ...campaign.counts, asksLeft: undefined } }))).toBe(false);
  });
});

describe('the poll delay while reads are slowed', () => {
  it('keeps the usual delay when reads are fine, and waits 30 seconds when a route said busy', () => {
    expect(SLOWED_POLL_MILLISECONDS).toBe(30_000);
    expect(pollDelay(10_000, false)).toBe(10_000);
    expect(pollDelay(4000, false)).toBe(4000);
    expect(pollDelay(10_000, true)).toBe(30_000);
    expect(pollDelay(4000, true)).toBe(30_000);
  });

  it('never polls faster than usual because of a pause', () => {
    expect(pollDelay(60_000, true)).toBe(60_000);
  });

  it('has one plain line for the pause', () => {
    expect(SLOWED_LINE).toBe('Updates are paused for a moment.');
  });
});

describe('a signature that is not from one key', () => {
  it('is only a signature of exactly 65 bytes: 0x and 130 hex characters', () => {
    expect(isOwnKeySignature(`0x${'a'.repeat(130)}`)).toBe(true);
    expect(isOwnKeySignature(`0x${'A1'.repeat(65)}`)).toBe(true);
    expect(isOwnKeySignature(`0x${'a'.repeat(128)}`)).toBe(false);
    expect(isOwnKeySignature(`0x${'a'.repeat(132)}`)).toBe(false);
    expect(isOwnKeySignature('a'.repeat(130))).toBe(false);
    expect(isOwnKeySignature(`0x${'g'.repeat(130)}`)).toBe(false);
    expect(isOwnKeySignature('0x')).toBe(false);
    expect(isOwnKeySignature('')).toBe(false);
  });

  it('accepts a real signature from a key, and refuses what a contract wallet usually sends', async () => {
    const signature = await signer.signMessage({ message: askMessage({ campaignId: CAMPAIGN_ID, wallet: signer.address, signedAt: 1_800_000_000 }) });
    expect(isOwnKeySignature(signature)).toBe(true);
    expect(isOwnKeySignature(`0x${'00'.repeat(66)}${signature.slice(2)}`)).toBe(false);
    expect(isOwnKeySignature(`0x${'12'.repeat(32)}`)).toBe(false);
  });
});

// ---------------------------------------------------------------- appeals

describe('the appeal message and text hash', () => {
  const TEXTS = [
    'Please look again.',
    ' leading space',
    'trailing space ',
    '  both sides  ',
    'தமிழ் எழுத்து',
    'emoji 😀 and more',
    'café against café',
    '0xdead',
    'a'.repeat(280),
    '',
    'tab\there',
  ];
  const stamp = 1_800_000_000;

  it('hashes the text the way core does, for ASCII, non-ASCII, empty and spaced texts', async () => {
    for (const text of TEXTS) expect(await appealTextHash(text), JSON.stringify(text)).toBe(core.appealTextHash(text));
  });

  it('builds the five lines core builds, from the same wallet, campaign, hash and time', async () => {
    for (const text of TEXTS) {
      const textHash = await appealTextHash(text);
      const input = { campaignId: CAMPAIGN_ID, wallet: signer.address, textHash, signedAt: stamp };
      const message = appealMessage(input);
      expect(message, JSON.stringify(text)).toBe(core.appealMessage(input));
      expect(message.split('\n')).toHaveLength(6);
      expect(message.startsWith('Thuli appeal v1\nCampaign: ')).toBe(true);
    }
    const lowered = appealMessage({ campaignId: CAMPAIGN_ID, wallet: signer.address.toLowerCase(), textHash: await appealTextHash('x'), signedAt: stamp });
    expect(lowered).toContain(`Wallet: ${signer.address}\n`);
  });

  it('refuses a campaign id, hash or time that could change the shape of the text', async () => {
    const textHash = await appealTextHash('x');
    expect(() => appealMessage({ campaignId: 'a\nb', wallet: signer.address, textHash, signedAt: stamp })).toThrow(RangeError);
    expect(() => appealMessage({ campaignId: CAMPAIGN_ID, wallet: signer.address, textHash: '0xdead', signedAt: stamp })).toThrow(RangeError);
    expect(() => appealMessage({ campaignId: CAMPAIGN_ID, wallet: signer.address, textHash, signedAt: 1.5 })).toThrow(RangeError);
    expect(() => appealMessage({ campaignId: CAMPAIGN_ID, wallet: 'nope', textHash, signedAt: stamp })).toThrow();
  });

  it('does not trim inside the hash, as core does not: a space changes it, so only what is sent is hashed', async () => {
    expect(core.appealTextHash(' hi ')).not.toBe(core.appealTextHash('hi'));
    expect(await appealTextHash(' hi ')).not.toBe(await appealTextHash('hi'));
    expect(prepareAppealText('  hi there \n')).toBe('hi there');
    expect(await appealTextHash(prepareAppealText('  hi there '))).toBe(core.appealTextHash('hi there'));
  });

  it('is signed in a form core accepts, for the text that was sent and no other', async () => {
    const text = prepareAppealText('  The funder is a friend of mine.  ');
    const textHash = await appealTextHash(text);
    const signature = await signer.signMessage({ message: appealMessage({ campaignId: CAMPAIGN_ID, wallet: signer.address, textHash, signedAt: stamp }) });
    expect(isOwnKeySignature(signature)).toBe(true);
    const context = { expectedCampaignId: CAMPAIGN_ID, now: stamp + 5, isContract: async () => false };
    const sent = { campaignId: CAMPAIGN_ID, wallet: signer.address, text, signedAt: stamp, signature };
    expect(await core.checkAppeal(sent, context)).toEqual({ ok: true, wallet: signer.address, textHash });
    expect((await core.checkAppeal({ ...sent, text: `${text} ` }, context)).ok).toBe(false);
    expect((await core.checkAppeal({ ...sent, text: 'another text' }, context)).ok).toBe(false);
    expect((await core.checkAppeal({ ...sent, signedAt: stamp + 1 }, context)).ok).toBe(false);
  });

  it('builds the request body with exactly its four fields, in the order the route reads them', () => {
    const body = JSON.parse(appealBody({ wallet: signer.address, text: 'why', signedAt: 7, signature: `0x${'a'.repeat(130)}` })) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['wallet', 'text', 'signedAt', 'signature']);
  });
});

describe('the plain-words rule for an appeal', () => {
  const TABLE = [
    'plain words',
    'Why is this wrong?',
    'see HTTP://x',
    'https://example.com/a',
    'www.example.com',
    'a <b>bold</b> claim',
    'a > b',
    'a < b',
    '[text](link)',
    'tab\there',
    'new\nline',
    'null\u0000char',
    'bell\u0007',
    'vertical\u000btab',
    'delete\u007f',
    'next line\u0085',
    'zero\u200bwidth',
    'joiner\u200djoin',
    'right to left\u202eoverride',
    'mark\ufeffbyte',
    'lone \ud800 surrogate',
    'low \udc00 surrogate',
    'emoji \u{1F600} fine',
    'தமிழ் fine',
    'wwwithout dot',
    'httpx',
    'ht tp',
    '',
    '   ',
  ];

  it('agrees with core on every text in the table, including the invisible and the broken ones', () => {
    for (const text of TABLE) expect(isPlainWords(text), JSON.stringify(text)).toBe(core.isPlainText(text));
  });

  it('says why a text cannot go: empty or only spaces, or not plain, and says nothing for a good one', () => {
    expect(appealProblem('')).toBe('empty');
    expect(appealProblem('     ')).toBe('empty');
    expect(appealProblem('\u00a0\u00a0')).toBe('empty');
    expect(appealProblem('see https://x.y')).toBe('unplain');
    expect(appealProblem('  fine words  ')).toBeNull();
    expect(appealProblem('a'.repeat(APPEAL_MAX_CHARS))).toBeNull();
  });

  it('holds the limit at 280 characters and shows the counter from 200', () => {
    expect(APPEAL_MAX_CHARS).toBe(280);
    expect(APPEAL_COUNTER_FROM).toBe(200);
  });
});

describe('which appeal state shows', () => {
  const kinds: AskKind[] = ['queued', 'screening', 'full', 'fullNoSlot', 'partial', 'hold', 'exclude', 'failed'];
  const views = ['queued', 'checking', 'ship', 'review', 'block', 'unreadable', 'unchecked'] as const;
  const eligible = new Set<AskKind>(['partial', 'hold', 'exclude', 'failed']);
  const undecided = new Set<AskKind>(['queued', 'screening']);
  const askFor = (kind: AskKind) => fx.ask(kind, signer.address, 3) as unknown as AskJson;

  it('offers the form for a held, excluded, partial or failed ask with no appeal, and nothing else', () => {
    for (const kind of kinds) {
      expect(appealPanel(askFor(kind)), kind).toEqual(eligible.has(kind) ? { kind: 'form' } : { kind: 'hidden' });
    }
  });

  it('shows the filed appeal for every decided ask that has one, whatever its action now is', () => {
    for (const kind of kinds) {
      for (const view of views) {
        const appeal = fx.appeal(view) as unknown as AppealView;
        const ask = fx.withAppeal(fx.ask(kind, signer.address, 3), fx.appeal(view)) as unknown as AskJson;
        expect(appealPanel(ask), `${kind} ${view}`).toEqual(undecided.has(kind) ? { kind: 'hidden' } : { kind: 'filed', appeal });
      }
    }
  });

  it('keeps showing a settled appeal after a reversal made the ask a full approval', () => {
    const reversed = fx.appeal('block', { outcome: 'reversed', newAction: 'full', settledAt: new Date(NOW).toISOString() });
    const ask = fx.withAppeal(fx.ask('full', signer.address, 4), reversed) as unknown as AskJson;
    expect(appealPanel(ask)).toEqual({ kind: 'filed', appeal: reversed });
  });

  it('treats an ask with no appeal field, as an older answer sends it, as one with none', () => {
    const { appeal: _left, ...older } = fx.ask('hold', signer.address);
    const ask = older as unknown as AskJson;
    expect('appeal' in ask).toBe(false);
    expect(isAskJson(ask)).toBe(true);
    expect(appealOf(ask)).toBeNull();
    expect(appealPanel(ask)).toEqual({ kind: 'form' });
    expect(appealOf({ ...ask, appeal: null })).toBeNull();
  });

  it('names the stage of a filed appeal', () => {
    const stage = (view: (typeof views)[number]) => appealStage(fx.appeal(view) as unknown as AppealView);
    expect(stage('queued')).toBe('judge');
    expect(stage('checking')).toBe('judge');
    for (const view of ['ship', 'review', 'block', 'unreadable'] as const) expect(stage(view), view).toBe('checked');
    expect(stage('unchecked')).toBe('unchecked');
  });
});

describe('the words of a filed appeal', () => {
  const view = (kind: Parameters<typeof fx.appeal>[0], overrides: Record<string, unknown> = {}) => fx.appeal(kind, overrides) as unknown as AppealView;

  it('says the outside judge is reading it, and that it takes about a minute', () => {
    expect(APPEAL_COPY.filedLabel).toBe('APPEAL');
    expect(APPEAL_COPY.withJudge).toBe('With the outside judge');
    expect(APPEAL_COPY.judgeLine).toBe("Reppo's judges are reading Thuli's decision, with every address and amount removed. This takes about a minute.");
  });

  it('writes the answer of each route as a headline in its own colour, with the note, the advice and the check id', () => {
    const cases = [
      ['ship', 'The judges agreed with Thuli.', 'hold'],
      ['review', 'The judges were split.', 'partial'],
      ['block', 'The judges disagreed with Thuli.', 'full'],
    ] as const;
    for (const [kind, headline, tone] of cases) {
      const words = checkedWords(view(kind));
      expect(words, kind).toEqual({
        headline,
        tone,
        note: view(kind).reppoNote,
        advice: "This is advice. The campaign's owner makes the final call.",
        evalLine: `Reppo check ${view(kind).reppoEvalId}`,
      });
    }
    expect(APPEAL_COPY.checkedLabel).toBe('OUTSIDE CHECK BY REPPO');
  });

  it('says so when the judges answered in a form that could not be read, and leaves out a note or id that is not there', () => {
    expect(checkedWords(view('unreadable'))).toEqual({
      headline: 'The judges answered, but not in a form Thuli could read.',
      tone: 'quiet',
      note: null,
      advice: "This is advice. The campaign's owner makes the final call.",
      evalLine: `Reppo check ${view('unreadable').reppoEvalId}`,
    });
    expect(checkedWords(view('block', { reppoEvalId: null })).evalLine).toBeNull();
    expect(checkedWords(view('ship', { reppoNote: null })).note).toBeNull();
  });

  it('says the outside check could not be made, and that the appeal is still with the owner', () => {
    expect(APPEAL_COPY.uncheckedLine).toBe("The outside check could not be made. Your appeal is still with the campaign's owner.");
  });

  it('writes the owner call: reversed in full, reversed to a partial reward, upheld, and nothing while open', () => {
    expect(settledWords(view('block'))).toBeNull();
    expect(settledWords(view('block', { outcome: 'reversed', newAction: 'full' }))).toEqual({ headline: 'Reversed by the owner', line: 'Your request is now approved in full.', tone: 'full' });
    expect(settledWords(view('block', { outcome: 'reversed', newAction: 'partial' }))).toEqual({ headline: 'Reversed by the owner', line: 'Your request is now approved for a partial reward.', tone: 'full' });
    expect(settledWords(view('ship', { outcome: 'upheld' }))).toEqual({ headline: 'Upheld by the owner', line: 'The decision stands.', tone: 'ink' });
    expect(settledWords(view('unchecked', { outcome: 'upheld' }))?.headline).toBe('Upheld by the owner');
  });

  it('writes the opened board row block: the answer and its note, the wait, the failed check, and the owner call is kept apart', () => {
    expect(boardCheckWords(view('ship'))).toEqual({ headline: 'The judges agreed with Thuli.', note: view('ship').reppoNote });
    expect(boardCheckWords(view('block'))).toEqual({ headline: 'The judges disagreed with Thuli.', note: view('block').reppoNote });
    expect(boardCheckWords(view('unreadable'))).toEqual({ headline: 'The judges answered, but not in a form Thuli could read.', note: null });
    expect(boardCheckWords(view('queued'))).toEqual({ headline: 'With the outside judge', note: null });
    expect(boardCheckWords(view('checking'))).toEqual({ headline: 'With the outside judge', note: null });
    expect(boardCheckWords(view('unchecked'))).toEqual({ headline: 'The check could not be made', note: null });
    expect(APPEAL_COPY.boardLabel).toBe('OUTSIDE CHECK');
  });

  it('puts a chip on an appealed row: APPEALED, or REVERSED in the full colour', () => {
    expect(appealChip(null)).toBeNull();
    for (const kind of ['queued', 'checking', 'ship', 'review', 'block', 'unreadable', 'unchecked'] as const) expect(appealChip(view(kind)), kind).toEqual({ text: 'APPEALED', tone: 'quiet' });
    expect(appealChip(view('block', { outcome: 'upheld' }))).toEqual({ text: 'APPEALED', tone: 'quiet' });
    expect(appealChip(view('block', { outcome: 'reversed', newAction: 'full' }))).toEqual({ text: 'REVERSED', tone: 'full' });
  });
});

describe('the appeal counts line', () => {
  it('writes the three numbers from the route', () => {
    expect(appealCountsLine({ filed: 3, checked: 2, block: 1, reversed: 1 })).toBe('3 appealed. The outside judges disagreed with Thuli on 1. The owner reversed 1.');
    expect(appealCountsLine({ filed: 1500, checked: 1400, block: 1200, reversed: 1000 })).toBe('1,500 appealed. The outside judges disagreed with Thuli on 1,200. The owner reversed 1,000.');
  });

  it('is absent at zero', () => {
    expect(appealCountsLine({ filed: 0, checked: 0, block: 0, reversed: 0 })).toBeNull();
  });

  it('reads counts that an older answer does not send as zeros, so the line is absent', () => {
    const { appeals: _left, ...older } = (fx.campaign() as unknown as CampaignView).counts;
    const plain = { ...(fx.campaign() as unknown as CampaignView), counts: older };
    expect('appeals' in plain.counts).toBe(false);
    expect(isCampaignView(plain)).toBe(true);
    expect(appealCountsOf(plain)).toEqual({ filed: 0, checked: 0, block: 0, reversed: 0 });
    expect(appealCountsLine(appealCountsOf(plain))).toBeNull();
    const counts = { ...plain.counts, appeals: { filed: 4, checked: 3, block: 2, reversed: 1 } };
    expect(appealCountsOf({ ...plain, counts })).toEqual({ filed: 4, checked: 3, block: 2, reversed: 1 });
  });
});

describe('the appeal answers the page reads', () => {
  const sent = { wallet: signer.address, text: 'The funder is my sister.', signedAt: 1_800_000_000, signature: `0x${'c'.repeat(130)}` };
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;

  it('posts exactly the four fields to the appeals route of the campaign in the path', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const record = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify({ queued: true }), { status: 202 });
    }) as unknown as typeof fetch;
    expect(await postAppeal(CAMPAIGN_ID, sent, record)).toEqual({ kind: 'queued' });
    expect(seen[0]?.url).toBe(`/api/campaigns/${CAMPAIGN_ID}/appeals`);
    expect(seen[0]?.init).toMatchObject({ method: 'POST', cache: 'no-store' });
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual(sent);
    expect(Object.keys(JSON.parse(String(seen[0]?.init?.body)))).toEqual(['wallet', 'text', 'signedAt', 'signature']);
  });

  it('maps each answer of the route', async () => {
    const filed = fx.appeal('queued') as unknown as AppealView;
    expect(classifyAppealAnswer(202, { queued: true })).toEqual({ kind: 'queued' });
    expect(classifyAppealAnswer(200, { exists: true, appeal: filed })).toEqual({ kind: 'exists', appeal: filed });
    expect(classifyAppealAnswer(200, { exists: true })).toEqual({ kind: 'exists', appeal: null });
    expect(classifyAppealAnswer(409, { undecided: true })).toEqual({ kind: 'undecided' });
    expect(classifyAppealAnswer(409, { approved: true })).toEqual({ kind: 'approved' });
    expect(classifyAppealAnswer(404, { error: 'no such ask' })).toEqual({ kind: 'gone' });
    expect(classifyAppealAnswer(400, { error: 'the signature does not match this appeal' })).toEqual({ kind: 'bad', cause: 'the signature does not match this appeal' });
    expect(classifyAppealAnswer(413, { error: 'the body is too large' })).toEqual({ kind: 'bad', cause: 'the body is too large' });
    expect(classifyAppealAnswer(429, { busy: true })).toEqual({ kind: 'limit' });
    expect(classifyAppealAnswer(429, { busy: true }, '7200')).toEqual({ kind: 'ceiling', retryAfter: '7200' });
    for (const [status, body] of [[503, { busy: true }], [500, {}], [409, {}], [202, {}], [200, 'x'], [400, {}]] as const) {
      expect(classifyAppealAnswer(status, body), `${status}`).toEqual({ kind: 'unreachable' });
    }
    expect(await postAppeal(CAMPAIGN_ID, sent, answer(429, { busy: true }, { 'Retry-After': '3600' }))).toEqual({ kind: 'ceiling', retryAfter: '3600' });
    expect(await postAppeal(CAMPAIGN_ID, sent, answer(409, { approved: true }))).toEqual({ kind: 'approved' });
    expect(await postAppeal(CAMPAIGN_ID, sent, (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch)).toEqual({ kind: 'unreachable' });
  });

  it('writes every refusal in the words of the design', () => {
    const text = (post: Parameters<typeof appealRefusalText>[0]) => appealRefusalText(post);
    expect(text({ kind: 'undecided' })).toBe('This request has no decision yet, so there is nothing to appeal.');
    expect(text({ kind: 'approved' })).toBe('This request was approved in full. There is nothing to appeal.');
    expect(text({ kind: 'limit' })).toBe('You have sent as many appeals as one caller may in an hour. Try again later.');
    expect(text({ kind: 'ceiling', retryAfter: '7200' })).toBe('Thuli has taken all the appeals it sends to the outside judge in a day. Try again in about 2 hours.');
    expect(text({ kind: 'ceiling', retryAfter: '1800' })).toBe('Thuli has taken all the appeals it sends to the outside judge in a day. Try again in about 30 minutes.');
    expect(text({ kind: 'ceiling', retryAfter: 'soon' })).toBe('Thuli has taken all the appeals it sends to the outside judge in a day. Try again tomorrow.');
    expect(text({ kind: 'bad', cause: 'the appeal text is empty' })).toBe('the appeal text is empty');
    expect(text({ kind: 'unreachable' })).toBe('The appeal could not be sent. Nothing was signed away.');
  });

  it('has the form words of the design', () => {
    expect(APPEAL_COPY.formLabel).toBe('DISAGREE?');
    expect(APPEAL_COPY.formLine).toBe("Tell the campaign's owner why in one line. An outside judge then checks Thuli's decision.");
    expect(APPEAL_COPY.placeholder).toBe('Why is this wrong?');
    expect(APPEAL_COPY.unplain).toBe('Write plain words, with no links or markup.');
    expect(APPEAL_COPY.button).toBe('Appeal');
    expect(APPEAL_COPY.signing).toBe('Waiting for your wallet');
    expect(APPEAL_COPY.sending).toBe('Sending');
    expect(APPEAL_COPY.privacy).toBe('Your words go to the owner only. They are shown on no public page and sent to no model.');
  });
});

describe('the appeal shapes the guards read', () => {
  const askWith = (appeal: unknown) => ({ ...fx.ask('hold', signer.address), appeal });

  it('accept an ask with a good appeal, with none, with null, and a board row with one', () => {
    expect(isAskJson(fx.ask('hold', signer.address))).toBe(true);
    expect(isAskJson(askWith(null))).toBe(true);
    for (const kind of ['queued', 'checking', 'ship', 'review', 'block', 'unreadable', 'unchecked'] as const) expect(isAskJson(askWith(fx.appeal(kind))), kind).toBe(true);
    expect(isAskJson(askWith(fx.appeal('block', { outcome: 'reversed', newAction: 'partial', settledAt: new Date(NOW).toISOString() })))).toBe(true);
    expect(isAskView({ ask: askWith(fx.appeal('ship')) })).toBe(true);
    expect(isBoardPage(fx.board(3, 1, () => fx.appeal('review')))).toBe(true);
    expect(isAppealView(fx.appeal('queued'))).toBe(true);
  });

  it('refuse an appeal that is not in the shape of the contract', () => {
    const base = fx.appeal('block') as Record<string, unknown>;
    const damaged: [string, Record<string, unknown>][] = [
      ['a route that is not one', { ...base, reppoRoute: 'maybe' }],
      ['a check status that is not one', { ...base, checkStatus: 'done' }],
      ['an outcome that is not one', { ...base, outcome: 'won' }],
      ['a new action that is not an approval', { ...base, newAction: 'exclude' }],
      ['a note over 280 characters', { ...base, reppoNote: 'x'.repeat(281) }],
      ['a note that is not plain', { ...base, reppoNote: 'see https://x.y' }],
      ['a note that is not text', { ...base, reppoNote: 5 }],
      ['a filing time that is not a time', { ...base, filedAt: 'yesterday' }],
      ['a check id that is not text', { ...base, reppoEvalId: 12 }],
    ];
    for (const [name, appeal] of damaged) expect(isAskJson(askWith(appeal)), name).toBe(false);
    for (const key of ['filedAt', 'checkStatus', 'reppoRoute', 'reppoNote', 'reppoEvalId', 'checkedAt', 'outcome', 'newAction', 'settledAt']) {
      const { [key]: _gone, ...rest } = base;
      expect(isAskJson(askWith(rest)), `missing ${key}`).toBe(false);
    }
    expect(isAskJson(askWith('open'))).toBe(false);
  });

  it('accept a campaign with appeal counts, and one without, and refuse damaged counts', () => {
    const counts = (campaign as unknown as CampaignView).counts;
    const { appeals: _left, ...without } = counts;
    expect(isCampaignView(fx.campaign())).toBe(true);
    expect(isCampaignView(fx.campaign({ counts: without }))).toBe(true);
    expect(isCampaignView(fx.campaign({ counts: { ...counts, appeals: { filed: 3, checked: 2, block: 1, reversed: 1 } } }))).toBe(true);
    expect(isCampaignView(fx.campaign({ counts: { ...counts, appeals: { filed: 3, checked: 2, block: 1 } } }))).toBe(false);
    expect(isCampaignView(fx.campaign({ counts: { ...counts, appeals: { filed: -1, checked: 0, block: 0, reversed: 0 } } }))).toBe(false);
    expect(isCampaignView(fx.campaign({ counts: { ...counts, appeals: 'many' } }))).toBe(false);
  });

  it('are accepted by the API schema: every kind of appeal, the ask and board row that carry one, the counts, and the new bodies', () => {
    const kinds = ['queued', 'checking', 'ship', 'review', 'block', 'unreadable', 'unchecked'] as const;
    const settled = { outcome: 'reversed', newAction: 'full', settledAt: new Date(NOW).toISOString() };
    for (const kind of kinds) {
      expect(AppealJson.safeParse(fx.appeal(kind)).success, kind).toBe(true);
      expect(AskSchema.safeParse(fx.withAppeal(fx.ask('hold', signer.address), fx.appeal(kind))).success, `ask ${kind}`).toBe(true);
      expect(ExistsAppealBody.safeParse({ exists: true, appeal: fx.appeal(kind) }).success, `exists ${kind}`).toBe(true);
    }
    expect(AppealJson.safeParse(fx.appeal('block', settled)).success).toBe(true);
    expect(AppealJson.safeParse(fx.appeal('ship', { outcome: 'upheld', settledAt: new Date(NOW).toISOString() })).success).toBe(true);
    expect(BoardSchema.safeParse(fx.board(5, 1, (index) => (index % 2 === 0 ? fx.appeal('review') : undefined))).success).toBe(true);
    expect(CampaignSchema.safeParse(fx.campaign({ counts: { ...campaign.counts, appeals: { filed: 3, checked: 2, block: 1, reversed: 1 } } })).success).toBe(true);
    expect(UndecidedBody.safeParse({ undecided: true }).success).toBe(true);
    expect(ApprovedBody.safeParse({ approved: true }).success).toBe(true);
    expect(classifyAppealAnswer(409, { undecided: true })).toEqual({ kind: 'undecided' });
    expect(classifyAppealAnswer(409, { approved: true })).toEqual({ kind: 'approved' });
  });
});

describe('how often the page asks again once an appeal is filed', () => {
  const appeal = (kind: Parameters<typeof fx.appeal>[0], overrides: Record<string, unknown> = {}) => fx.appeal(kind, overrides) as unknown as AppealView;

  it('looks every 5 seconds while the outside check is queued or running, and every 30 while the owner has not settled', () => {
    expect(appealPollDelay(appeal('queued'), false)).toBe(5000);
    expect(appealPollDelay(appeal('checking'), false)).toBe(5000);
    for (const kind of ['ship', 'review', 'block', 'unreadable', 'unchecked'] as const) expect(appealPollDelay(appeal(kind), false), kind).toBe(30_000);
  });

  it('stops when the owner has settled, and when there is no appeal', () => {
    expect(appealPollDelay(appeal('block', { outcome: 'reversed', newAction: 'full' }), false)).toBeNull();
    expect(appealPollDelay(appeal('unchecked', { outcome: 'upheld' }), false)).toBeNull();
    expect(appealPollDelay(null, false)).toBeNull();
  });

  it('looks every 5 seconds from the moment an appeal was sent, until the ask shows it', () => {
    expect(appealPollDelay(null, true)).toBe(5000);
    expect(appealPollDelay(appeal('ship'), true)).toBe(30_000);
  });

  it('picks the shortest wait that applies among the ask, the reward and the appeal', () => {
    const none = { waiting: false, approvedUnpaid: false, appeal: null, appealSent: false };
    expect(askPollDelay(none)).toBeNull();
    expect(askPollDelay({ ...none, waiting: true })).toBe(4000);
    expect(askPollDelay({ ...none, approvedUnpaid: true })).toBe(10_000);
    expect(askPollDelay({ ...none, appeal: appeal('queued') })).toBe(5000);
    expect(askPollDelay({ ...none, appeal: appeal('ship') })).toBe(30_000);
    expect(askPollDelay({ ...none, appeal: appeal('ship'), approvedUnpaid: true })).toBe(10_000);
    expect(askPollDelay({ ...none, appeal: appeal('queued'), approvedUnpaid: true })).toBe(5000);
    expect(askPollDelay({ ...none, appeal: appeal('queued'), waiting: true })).toBe(4000);
    expect(askPollDelay({ ...none, appealSent: true })).toBe(5000);
    expect(askPollDelay({ ...none, appeal: appeal('block', { outcome: 'upheld' }) })).toBeNull();
  });
});

describe('the words when every slot is taken', () => {
  it('say so in a heading and a body that send a wallet that already asked to connect it', () => {
    expect(refusalWords('slots')).toEqual({
      heading: 'Every slot is taken',
      body: 'This campaign has given out all its slots, so no new request can be sent. If you already asked, connect the same wallet to see your decision.',
    });
  });

  it('no longer promise that a wallet can still ask', () => {
    expect('full' in READY_TEXT).toBe(false);
    expect(JSON.stringify(READY_TEXT)).not.toMatch(/still ask/);
  });
});

describe('a wallet that has never been used', () => {
  const sent = { wallet: signer.address, signedAt: 1_800_000_000, signature: `0x${'b'.repeat(130)}` };
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('reads a 200 that says neverUsed as its own answer, and nothing looser', async () => {
    expect(classifyAskAnswer(200, fx.neverUsed)).toEqual({ kind: 'neverUsed' });
    expect(await postAsk(CAMPAIGN_ID, sent, answer(200, fx.neverUsed))).toEqual({ kind: 'neverUsed' });
    const loose: unknown[] = [{ neverUsed: false }, { neverUsed: 'true' }, { neverUsed: 1 }, { neverUsed: true, exists: true }, { neverUsed: true, extra: 1 }, {}, null, 'neverUsed'];
    for (const body of loose) expect(classifyAskAnswer(200, body), JSON.stringify(body)).toEqual({ kind: 'unreachable' });
  });

  it('keeps the answers it already knew, and does not take a neverUsed body on another status', () => {
    const exists = fx.ask('hold', signer.address) as unknown as AskJson;
    expect(classifyAskAnswer(200, { exists: true, ask: exists })).toEqual({ kind: 'exists', ask: exists });
    expect(classifyAskAnswer(202, fx.neverUsed)).toEqual({ kind: 'unreachable' });
    expect(classifyAskAnswer(409, fx.neverUsed)).toEqual({ kind: 'closed' });
  });

  it('says it in three lines: the heading, the body, and that nothing was stored', () => {
    expect(refusalWords('neverUsed')).toEqual({
      heading: 'This wallet has never been used',
      body: 'It has sent no transaction and holds nothing on Ethereum or Base, so there is nothing to screen. Ask with a wallet you have used for a while.',
      note: 'Nothing was stored, and signing cost nothing.',
    });
  });

  it('gives no other refusal a note', () => {
    for (const kind of ['stopped', 'slots', 'full', 'contract'] as const) expect('note' in refusalWords(kind), kind).toBe(false);
    expect('note' in refusalWords('ceiling', '7200')).toBe(false);
  });

  it('is a refusal of the panel, like a full campaign or a contract wallet, with no ask behind it', () => {
    expect(refusalFor({ kind: 'neverUsed' })).toEqual({ kind: 'neverUsed', retryAfter: null });
    expect(refusalFor({ kind: 'full' })).toEqual({ kind: 'full', retryAfter: null });
    expect(refusalFor({ kind: 'ceiling', retryAfter: '7200' })).toEqual({ kind: 'ceiling', retryAfter: '7200' });
    for (const post of [{ kind: 'queued' }, { kind: 'closed' }, { kind: 'limit' }, { kind: 'unreachable' }, { kind: 'gone' }, { kind: 'bad', cause: 'x' }] as const) {
      expect(refusalFor(post), post.kind).toBeNull();
    }
    const base: PanelInput = { connected: true, ask: null, looking: false, signing: false, sent: false, refused: true, unreachable: false };
    expect(choosePanel(base)).toBe('refused');
    expect(choosePanel({ ...base, connected: false })).toBe('connect');
  });

  it('belongs to the wallet it came for: another wallet, or none, starts clean', () => {
    type Session = { wallet: string; refusal: string | null };
    const fresh = (wallet: string): Session => ({ wallet, refusal: null });
    const refused: Session = { wallet: signer.address, refusal: 'neverUsed' };
    expect(sessionFor(refused, signer.address, fresh)).toBe(refused);
    expect(sessionFor(refused, fixtureWallet(1), fresh)).toEqual({ wallet: fixtureWallet(1), refusal: null });
    expect(sessionFor(refused, null, fresh)).toBeNull();
    expect(sessionFor(null, signer.address, fresh)).toEqual({ wallet: signer.address, refusal: null });
  });

  it('has the fixture body the API will send, and nothing stored to look up', () => {
    expect(fx.neverUsed).toEqual({ neverUsed: true });
    expect(classifyAskAnswer(404, { error: 'no ask from this wallet' })).toEqual({ kind: 'gone' });
  });

  // The API's body for this answer is not committed yet. Once it exports one, hold the fixture to it like the others above:
  // expect(NeverUsedBody.safeParse(fx.neverUsed).success).toBe(true)
  it('is accepted by the API schema', () => {
    expect(NeverUsedBody.safeParse(fx.neverUsed).success).toBe(true);
    expect(NeverUsedBody.safeParse({ neverUsed: false }).success).toBe(false);
  });
});

describe('the appeal text on one line', () => {
  const stamp = 1_800_000_000;
  const CAUSES = {
    empty: 'the appeal text is empty',
    unplain: 'the appeal text contained a link, markup or control characters',
    oneLine: 'the appeal text must be one line',
  } as const;
  // Every character that is not an ordinary one is written as an escape: a raw line separator inside a literal breaks the parser.
  const TABLE = [
    'one\ntwo',
    'one\rtwo',
    'one\r\ntwo',
    'one\ttwo',
    'one\u0085two',
    'one\u2028two',
    'one\u2029two',
    'one\u000btwo',
    'one\u000ctwo',
    'one\u0000two',
    'bell\u0007',
    'delete\u007f',
    'last control\u009f',
    'see http://x.example\nmore',
    'tab and www.example.com\there',
    'zero\u200bwidth',
    'right to left\u202eover',
    'lone \ud800 surrogate',
    '\nleading and trailing\n',
    '\t tab around \t',
    'plain words',
    'தமிழ் எழுத்து',
    'café against café',
    'emoji \u{1F600} fine',
    'a'.repeat(280),
    '  padded  ',
    '',
    '   ',
  ];

  it('agrees with core on each text in the table: the same cause for a bad one, and none for a good one', async () => {
    for (const text of TABLE) {
      const prepared = prepareAppealText(text);
      const verdict = await core.checkAppeal(
        { campaignId: CAMPAIGN_ID, wallet: signer.address, text: prepared, signedAt: stamp, signature: `0x${'a'.repeat(130)}` },
        { expectedCampaignId: CAMPAIGN_ID, now: stamp + 5, isContract: async () => false },
      );
      const problem = appealProblem(text);
      // The signature is not a real one, so a text core likes ends at the signature check, and the others end at their own cause.
      expect(verdict.ok, JSON.stringify(text)).toBe(false);
      expect(verdict.cause, JSON.stringify(text)).toBe(problem === null ? 'the signature does not match this appeal' : CAUSES[problem]);
    }
  });

  it('agrees with core on what breaks a line', () => {
    for (const text of TABLE) expect(isOneLine(text), JSON.stringify(text)).toBe(core.isOneLine(text));
    expect(isOneLine('plain words')).toBe(true);
    expect(isOneLine('one\u2028two')).toBe(false);
    expect(isOneLine('one\u2029two')).toBe(false);
  });

  it('says a pasted line break, tab or separator needs one line, and keeps the other causes first', () => {
    for (const text of ['one\ntwo', 'one\rtwo', 'one\ttwo', 'one\u0085two', 'one\u2028two', 'one\u2029two', 'one\u0000two']) expect(appealProblem(text), JSON.stringify(text)).toBe('oneLine');
    expect(appealProblem('see http://x.example\nmore')).toBe('unplain');
    expect(appealProblem('zero\u200bwidth')).toBe('unplain');
    expect(appealProblem('\nleading and trailing\n')).toBeNull();
    expect(appealProblem('\n\n')).toBe('empty');
    expect(appealProblem('தமிழ் எழுத்து')).toBeNull();
    expect(appealProblem('café against café')).toBeNull();
    expect(appealProblem('emoji \u{1F600} fine')).toBeNull();
  });

  it('shows "Keep it to one line." under the input for that problem, and the plain-words line for the other', () => {
    expect(appealWarning('oneLine')).toBe('Keep it to one line.');
    expect(appealWarning('unplain')).toBe(APPEAL_COPY.unplain);
    expect(appealWarning('empty')).toBeNull();
    expect(appealWarning(null)).toBeNull();
  });

  it('keeps the button off while any problem shows, and on for a good text', () => {
    expect(appealSendable('one\ntwo')).toBe(false);
    expect(appealSendable('one\u2028two')).toBe(false);
    expect(appealSendable('see http://x.example')).toBe(false);
    expect(appealSendable('   ')).toBe(false);
    expect(appealSendable('Please look again.')).toBe(true);
    expect(appealSendable('தமிழ்')).toBe(true);
  });

  it('shows the cause of a 400 from the route as it comes', () => {
    const post = classifyAppealAnswer(400, { error: 'the appeal text must be one line' });
    expect(post).toEqual({ kind: 'bad', cause: 'the appeal text must be one line' });
    if (post.kind === 'bad') expect(appealRefusalText(post)).toBe('the appeal text must be one line');
  });
});

describe('the chain a decision read', () => {
  const funder = fixtureWallet(900);
  const facts = (chain: 'ethereum' | 'base') => (fx.ask('hold', signer.address, null, 5, { chain }) as unknown as AskJson);
  const names = (markup: string) => [...markup.matchAll(/<p class="[^"]*">([^<]*)<\/p>/g)].map((match) => match[1]);

  it('shows "History read on" as the first row of the facts, with the chain that was read', () => {
    for (const [chain, words] of [['base', 'Base'], ['ethereum', 'Ethereum']] as const) {
      const markup = renderToStaticMarkup(createElement(Facts, { ask: facts(chain) }));
      expect(names(markup)[0], chain).toBe('History read on');
      expect(markup, chain).toMatch(new RegExp(`History read on</p><div class="[^"]*">${words}</div>`));
      expect(markup.indexOf('History read on')).toBeLessThan(markup.indexOf('Wallet age'));
      expect(names(markup).filter((name) => name === 'History read on')).toHaveLength(1);
    }
  });

  it('opens the funder on the explorer of the chain that was read', () => {
    const lowered = funder.toLowerCase();
    const onBase = renderToStaticMarkup(createElement(Facts, { ask: facts('base') }));
    expect(onBase).toContain(`href="${explorerBase(BASE_CHAIN)}/address/${lowered}"`);
    expect(onBase).not.toContain(`${explorerBase(ETHEREUM_CHAIN)}/address/`);
    const onEthereum = renderToStaticMarkup(createElement(Facts, { ask: facts('ethereum') }));
    expect(onEthereum).toContain(`href="${explorerBase(ETHEREUM_CHAIN)}/address/${lowered}"`);
    expect(onEthereum).not.toContain(`${explorerBase(BASE_CHAIN)}/address/`);
  });

  it('shows no facts block for an ask with no facts', () => {
    const none = fx.ask('failed', signer.address) as unknown as AskJson;
    expect(none.facts).toBeNull();
    expect(renderToStaticMarkup(createElement(Facts, { ask: none }))).toBe('');
  });

  it('links each cited transaction on the explorer of that chain, and gives a bad hash no link', () => {
    const hashes = ['0x4e7e84ae76bcede030f2e71a8776c59b376bc838b42f7c52c190aae2e074e68c', '0xa91898bfe55aad41d5295aac670976adcea7bd1366773db8a28de12f1198de67'];
    const onBase = renderToStaticMarkup(createElement(CitedList, { hashes, chain: 'base' }));
    for (const hash of hashes) expect(onBase).toContain(`href="${explorerBase(BASE_CHAIN)}/tx/${hash}"`);
    expect(onBase).not.toContain(explorerBase(ETHEREUM_CHAIN) as string);
    const onEthereum = renderToStaticMarkup(createElement(CitedList, { hashes, chain: 'ethereum' }));
    for (const hash of hashes) expect(onEthereum).toContain(`href="${explorerBase(ETHEREUM_CHAIN)}/tx/${hash}"`);
    const bad = renderToStaticMarkup(createElement(CitedList, { hashes: ['0xABC', hashes[0] as string], chain: 'base' }));
    expect(bad).not.toContain('/tx/0xABC');
    expect(bad).toContain(`/tx/${hashes[0]}`);
    expect(renderToStaticMarkup(createElement(CitedList, { hashes: [], chain: 'base' }))).toContain('None');
  });

  describe('the words that name the chains', () => {
    const read = (...parts: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...parts), 'utf8');
    const campaignFolder = fs.readdirSync(path.join(import.meta.dirname, '..', 'components', 'campaign')).filter((name) => name.endsWith('.tsx') || name.endsWith('.ts'));
    const everything = [...campaignFolder.map((name) => read('components', 'campaign', name)), read('lib', 'campaign.ts')].join('\n');

    it('say Ethereum or Base in the ask note, the never-used refusal and the new-wallet advice', () => {
      expect(read('components', 'campaign', 'AskPanel.tsx')).toContain(
        'Thuli then reads this wallet&apos;s public history on Ethereum or Base, whichever is older, and decides. One ask per wallet.',
      );
      expect(refusalWords('neverUsed').body).toBe(
        'It has sent no transaction and holds nothing on Ethereum or Base, so there is nothing to screen. Ask with a wallet you have used for a while.',
      );
      expect(NEW_WALLET_ADVICE).toBe(
        'This wallet has never been used on Ethereum or Base, so nothing sets it apart from one made a minute ago. Ask with a wallet you have used for a while.',
      );
    });

    it('no longer hold the three old sentences', () => {
      expect(everything).not.toContain("Thuli then reads this wallet&apos;s public history on Ethereum and decides");
      expect(everything).not.toContain('holds nothing on Ethereum, so there is nothing to screen');
      expect(everything).not.toContain('has never been used on Ethereum, so nothing sets it apart');
    });

    it('name Ethereum alone nowhere in the campaign folder or its words', () => {
      const alone = everything.split('\n').filter((line) => /on Ethereum/.test(line) && !/on Ethereum or Base/.test(line));
      expect(alone).toEqual([]);
    });
  });
});

// Covers the ask message, a signature over it against core's own check, every fixture against the API's schema, the
// guards, the request mapping, the choice of panel and the payout sentences. It does not cover drawing, the wallet
// connection or polling; the browser script runs those against a page with an injected test wallet.
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { askBody, askMessage, SIGNATURE, signedAtNow } from '../lib/ask';
import {
  chainName,
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
  isAskView,
  isBoardPage,
  isCampaignView,
  LIST_STATUS_WORDS,
  mergeBoard,
  newestFirst,
  NEW_WALLET_ADVICE,
  NOT_CHECKED_INTRO,
  notCheckedLine,
  outcomeWords,
  payoutFor,
  postAsk,
  readyVariant,
  showsWhatToDo,
  statusLine,
  usdc,
  walletAmount,
  type AskJson,
  type CampaignView,
  type PanelInput,
  type Ticket,
} from '../lib/campaign';
import { notCheckedText } from '../lib/check';
import { formatUsdc6 } from '../lib/vaultProof';
import { buildFixtures, CAMPAIGN_ID, fixtureWallet, type AskKind } from './campaignFixtures';

// The core and API packages are loaded by a computed path so the site's own type check does not follow into their sources.
const loadPackage = (name: string): Promise<any> => import(/* @vite-ignore */ name);
const { checkAsk, askMessage: coreAskMessage } = await loadPackage('@thuli/core');
const {
  AskJson: AskSchema,
  AskView: AskViewSchema,
  BoardPage: BoardSchema,
  CampaignView: CampaignSchema,
  BusyBody,
  ClosedBody,
  ErrorBody,
  ExistsBody,
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
    expect(await fetchCampaign(CAMPAIGN_ID, reply(200, fx.campaign()))).toEqual(fx.campaign());
    expect(await fetchCampaign(CAMPAIGN_ID, reply(404, { error: 'no such campaign' }))).toBeNull();
    expect(await fetchCampaign(CAMPAIGN_ID, reply(200, { name: 'x' }))).toBeNull();
    expect(await fetchCampaign(CAMPAIGN_ID, reply(503, { busy: true }))).toBeNull();
    expect(await fetchCampaign(CAMPAIGN_ID, (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch)).toBeNull();
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

  it('maps each answer of the ask route', () => {
    const exists = fx.ask('full', signer.address, 1);
    expect(classifyAskAnswer(202, { queued: true })).toEqual({ kind: 'queued' });
    expect(classifyAskAnswer(200, { exists: true, ask: exists })).toEqual({ kind: 'exists', ask: exists });
    expect(classifyAskAnswer(409, { closed: true })).toEqual({ kind: 'closed' });
    expect(classifyAskAnswer(429, { busy: true })).toEqual({ kind: 'limit' });
    expect(classifyAskAnswer(400, { error: 'the signature is too old' })).toEqual({ kind: 'bad', cause: 'the signature is too old' });
    expect(classifyAskAnswer(413, { error: 'the body is too large' })).toEqual({ kind: 'bad', cause: 'the body is too large' });
    expect(classifyAskAnswer(404, { error: 'no such campaign' })).toEqual({ kind: 'gone' });
    for (const [status, body] of [[503, { busy: true }], [500, {}], [200, { exists: true }], [202, {}], [400, {}]] as const) {
      expect(classifyAskAnswer(status, body), `${status}`).toEqual({ kind: 'unreachable' });
    }
  });
});

describe('choosePanel', () => {
  const base: PanelInput = { connected: true, ask: null, looking: false, signing: false, sent: false, unreachable: false };

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

  it('closes, fills or opens the ready state from the campaign and the clock', () => {
    expect(readyVariant(campaign, NOW)).toBe('open');
    expect(readyVariant({ ...campaign, status: 'closed' }, NOW)).toBe('closed');
    expect(readyVariant(campaign, Date.parse(campaign.closesAt))).toBe('closed');
    expect(readyVariant(campaign, Date.parse(campaign.opensAt) - 1)).toBe('closed');
    expect(readyVariant({ ...campaign, counts: { ...campaign.counts, slotsLeft: 0 } }, NOW)).toBe('full');
    expect(isAcceptingAsks(campaign, NOW)).toBe(true);
  });
});

describe('payoutFor', () => {
  const noTicket = (kind: AskKind, slot: number | null = 3) => payoutFor({ ask: asView(kind, slot), ticket: null, campaign, now: NOW });
  const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({ cumulativeAmount: '1000000', proof: [], root: campaign.lists[0]?.root ?? '', ...overrides });

  it('says a held, excluded or failed wallet has no reward and that appeals are not open', () => {
    for (const kind of ['hold', 'exclude', 'failed'] as const) {
      expect(noTicket(kind)).toEqual({ lines: ['No reward is reserved for this wallet.', 'Appeals are not open yet.'], paid: false });
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
      'This wallet has never been used on Ethereum, so nothing sets it apart from one made a minute ago. Ask with a wallet you have used for a while.',
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
    expect(showsWhatToDo({ ...(fx.ask('failed', signer.address) as unknown as AskJson), facts: { ...noHistory, accountType: 'eoa', burstWallets: null, missing: [] } })).toBe(false);
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

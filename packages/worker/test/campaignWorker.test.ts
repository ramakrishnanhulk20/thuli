// Not covered here: a real chain, a real Postgres, live SERV and a real hour of root delay. The vault is a stand-in that
// keeps its own clock, roots and claimed amounts and checks each proof the way ThuliVault does; the store is PGlite in
// this process; SERV answers from a script. The local-fork rehearsal (npm run rehearse:campaign) runs the real viem
// port, the real factory and vault, the real facts reader and live SERV. Two workers racing on one store are the
// store's own tests (packages/store/test/campaigns.test.ts).
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  askMessage,
  CURRENT_RULEBOOK,
  GRAPH_G1,
  HIGH_VOLUME_NONCE,
  LEAF_TYPES,
  leafValues,
  parseAddress,
  type AccountState,
  type Address,
  type Facts,
  type GraphAnswer,
  type GraphRecord,
  type MerkleHash,
} from '@thuli/core';
import {
  addAsk,
  counts,
  createCampaign,
  getAsk,
  latestList,
  listText,
  listVersions,
  MAX_RELAY_ATTEMPTS,
  migrate,
  openMemoryDb,
  queueRelays,
  slotHolders,
  type CampaignInput,
  type Db,
} from '@thuli/store';
import { NO_VAULT_BLOCK, runLoop, runOnce, type WorkerDeps } from '../src/campaign/loop.ts';
import { publishCheck, reconcileCheck } from '../src/campaign/publish.ts';
import { activateCheck, relayNext } from '../src/campaign/relay.ts';
import { CAMPAIGN_SCREEN_CAUSES, MAX_ASK_ATTEMPTS, retryDelaySeconds, screenNextAsk, type ScreenOutcome } from '../src/campaign/screen.ts';
import { emptyChainMemory, NO_ROOT, type CampaignVault, type ClaimSimulation } from '../src/campaign/vault.ts';
import { decideWallet, type DecideDeps } from '../src/replay/decide.ts';
import { SCREEN_CAUSES } from '../src/screen/single.ts';
import { ServError, type ServReply } from '../src/serv/client.ts';
import { claimTicket, type ClaimTicket } from '../src/vault/claimList.ts';
import { buildRoot, readPublishedList, type VaultEntry, type VaultSnapshot, type VaultTerms } from '../src/vault/root.ts';

vi.mock('../src/replay/decide.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/replay/decide.ts')>();
  return { ...actual, decideWallet: vi.fn(actual.decideWallet) };
});

const CHAIN = 84532;
const NOW = new Date('2026-11-11T12:00:00.000Z');
const CHAIN_START = 1_800_000_000n;
const REWARD = 1_000_000n;
const ROOT_DELAY = 3600n;
const CAMPAIGN = 'demo';
const address = (byte: string) => parseAddress(`0x${byte.repeat(20)}`);
const VAULT = address('a1');
const FACTORY = address('fa');
const TOKEN = address('70');
const OWNER = address('0e');
const AGENT_KEY = generatePrivateKey();
const AGENT = privateKeyToAccount(AGENT_KEY).address;
const CREATED_AT_BLOCK = 500n;
const HASH = `0x${'ab'.repeat(32)}`;

/** A vault that behaves like ThuliVault for everything the worker touches, on a clock the test moves. */
class StandInVault implements CampaignVault {
  readonly signer = AGENT;
  /** Every method the worker called, in order. */
  readonly calls: string[] = [];
  /** The vault functions the worker sent a transaction to, in order. */
  readonly sent: ('postRoot' | 'claim')[] = [];
  readonly tickets: ClaimTicket[] = [];
  readonly paid = new Map<Address, bigint>();
  readonly posted: MerkleHash[] = [];
  now = CHAIN_START;
  deposited: bigint;
  totalPaid = 0n;
  endTime = CHAIN_START + 7n * 86_400n;
  claimed = new Map<Address, bigint>();
  terms: VaultTerms;
  failPost = 0;
  /** Posts land on chain and then the worker stops, before it can record them, this many times. */
  stopAfterPost = 0;
  refuseClaims: string | null = null;
  private active = NO_ROOT;
  private pending = NO_ROOT;
  private pendingAt = 0n;
  private hashes = 0;
  readonly reverted = new Set<string>();

  readonly address: Address;

  constructor(deposit: bigint, vault: Address = VAULT) {
    this.address = vault;
    this.deposited = deposit;
    this.terms = { token: TOKEN, owner: OWNER, agent: AGENT, perWalletCap: REWARD, endTime: this.endTime, rootDelay: ROOT_DELAY };
  }

  advance(seconds: bigint) {
    this.now += seconds;
  }

  private roots_() {
    const due = this.pending !== NO_ROOT && this.now >= this.pendingAt;
    return due
      ? { active: this.pending, pending: NO_ROOT, pendingAt: 0n }
      : { active: this.active, pending: this.pending, pendingAt: this.pendingAt };
  }

  private settle() {
    const { active, pending, pendingAt } = this.roots_();
    this.active = active;
    this.pending = pending;
    this.pendingAt = pendingAt;
  }

  private nextHash(): `0x${string}` {
    this.hashes += 1;
    // Led by the vault's own address, so two stand-in vaults never hand out the same hash.
    return `0x${this.address.slice(2, 10).toLowerCase()}${this.hashes.toString(16).padStart(56, '0')}`;
  }

  private check(ticket: ClaimTicket): ClaimSimulation & { amount?: bigint } {
    if (this.now >= this.endTime) return { ok: false, error: 'CampaignEnded' };
    const { active } = this.roots_();
    if (active === NO_ROOT) return { ok: false, error: 'NoClaimableRoot' };
    const leaf = leafValues(CHAIN, this.address, ticket.account, ticket.cumulativeAmount);
    if (!StandardMerkleTree.verify(active, LEAF_TYPES, leaf, ticket.proof)) return { ok: false, error: 'InvalidProof' };
    const entitled = ticket.cumulativeAmount < REWARD ? ticket.cumulativeAmount : REWARD;
    const already = this.claimed.get(ticket.account) ?? 0n;
    if (entitled <= already) return { ok: false, error: 'NothingToClaim' };
    if (this.totalPaid + entitled - already > this.deposited) return { ok: false, error: 'DepositExhausted' };
    if (this.refuseClaims !== null) return { ok: false, error: this.refuseClaims };
    return { ok: true, amount: entitled - already };
  }

  async chainId() {
    this.calls.push('chainId');
    return CHAIN;
  }

  async readSnapshot(_vault: Address, accounts: readonly Address[]): Promise<VaultSnapshot> {
    this.calls.push('readSnapshot');
    const { active, pending } = this.roots_();
    return {
      blockNumber: 1000n,
      timestamp: this.now,
      agent: AGENT,
      deposited: this.deposited,
      totalPaid: this.totalPaid,
      perWalletCap: REWARD,
      endTime: this.endTime,
      rootDelay: ROOT_DELAY,
      paused: false,
      activeRoot: active,
      pendingRoot: pending,
      claimed: new Map(accounts.map((account) => [account, this.claimed.get(account) ?? 0n])),
    };
  }

  async findVaultCreated(factory: Address, vault: Address, block: bigint) {
    this.calls.push('findVaultCreated');
    return factory === FACTORY && vault === this.address && block === CREATED_AT_BLOCK ? [this.terms] : [];
  }

  async sendPostRoot(_vault: Address, root: MerkleHash, declaredTotal: bigint) {
    this.calls.push('sendPostRoot');
    if (this.failPost > 0) {
      this.failPost -= 1;
      throw new Error('the RPC dropped the transaction');
    }
    this.sent.push('postRoot');
    if (declaredTotal > this.deposited) throw new Error('DeclaredTotalAboveDeposit');
    this.settle();
    this.pending = root;
    this.pendingAt = this.now + ROOT_DELAY;
    this.posted.push(root);
    if (this.stopAfterPost > 0) {
      this.stopAfterPost -= 1;
      throw new Error('the worker stopped between the post and its record');
    }
    return { hash: this.nextHash(), gasUsed: 61_000n };
  }

  /** The owner's cancelRoot, inside the delay. */
  cancelPending() {
    const { pending } = this.roots_();
    if (pending === NO_ROOT) throw new Error('NoPendingRoot');
    this.settle();
    this.pending = NO_ROOT;
    this.pendingAt = 0n;
  }

  async roots(_vault: Address) {
    this.calls.push('roots');
    const { active, pending, pendingAt } = this.roots_();
    return { blockNumber: 1000n, timestamp: this.now, activeRoot: active, pendingRoot: pending, pendingClaimableAt: pendingAt, paused: false };
  }

  async claimableOf(_vault: Address, entries: readonly VaultEntry[], _blockNumber: bigint) {
    this.calls.push('claimableOf');
    return entries.map((entry) => {
      const entitled = entry.cumulativeAmount < REWARD ? entry.cumulativeAmount : REWARD;
      const already = this.claimed.get(parseAddress(entry.account)) ?? 0n;
      return entitled > already ? entitled - already : 0n;
    });
  }

  async simulateClaim(_vault: Address, ticket: ClaimTicket): Promise<ClaimSimulation> {
    this.calls.push('simulateClaim');
    this.tickets.push(ticket);
    const { ok, ...rest } = this.check(ticket);
    return ok ? { ok } : { ok, error: (rest as { error: string }).error };
  }

  async sendClaim(_vault: Address, ticket: ClaimTicket) {
    this.calls.push('sendClaim');
    this.sent.push('claim');
    const hash = this.nextHash();
    const result = this.check(ticket);
    if (!result.ok || result.amount === undefined) {
      this.reverted.add(hash);
      return hash;
    }
    this.settle();
    this.claimed.set(ticket.account, (this.claimed.get(ticket.account) ?? 0n) + result.amount);
    this.totalPaid += result.amount;
    this.paid.set(ticket.account, (this.paid.get(ticket.account) ?? 0n) + result.amount);
    return hash;
  }

  async confirmClaim(hash: `0x${string}`) {
    this.calls.push('confirmClaim');
    return { ok: !this.reverted.has(hash), gasUsed: 58_000n };
  }
}

/** One port over several stand-in vaults, as the real port reaches any vault by its address. */
function chainOf(...vaults: StandInVault[]): CampaignVault {
  const at = (vault: Address) => {
    const found = vaults.find((candidate) => candidate.address === vault);
    if (found === undefined) throw new Error('no stand-in vault at this address');
    return found;
  };
  return {
    signer: AGENT,
    chainId: async () => CHAIN,
    readSnapshot: (vault, accounts) => at(vault).readSnapshot(vault, accounts),
    findVaultCreated: (factory, vault, block) => at(vault).findVaultCreated(factory, vault, block),
    sendPostRoot: (vault, root, total) => at(vault).sendPostRoot(vault, root, total),
    roots: (vault) => at(vault).roots(vault),
    claimableOf: (vault, entries, block) => at(vault).claimableOf(vault, entries, block),
    simulateClaim: (vault, ticket) => at(vault).simulateClaim(vault, ticket),
    sendClaim: (vault, ticket) => at(vault).sendClaim(vault, ticket),
    confirmClaim: async (hash) => ({ ok: !vaults.some((vault) => vault.reverted.has(hash)), gasUsed: 58_000n }),
  };
}

interface Wallet {
  address: Address;
  key: `0x${string}`;
  signature: string;
}

// What collectBasicFacts reads for an old, active wallet: the facts that need a list are null and named in missing.
function basicRead(funder: Address, overrides: Partial<Facts> = {}): Facts {
  return {
    walletAgeDays: 400,
    txCountAtSnapshot: 50,
    accountType: 'eoa',
    firstFunder: { address: funder, kind: 'unknown', fanoutInList: null, hopsTraced: 1 },
    group: null,
    sharedDepositAddress: null,
    fundingBurst: null,
    claimPaidToOtherAddress: null,
    evidenceTxs: [HASH],
    missing: ['group', 'sharedDepositAddress', 'claimPaidToOtherAddress'],
    ...overrides,
  };
}

function reply(answer: GraphAnswer, requestId = 'run-1'): ServReply {
  const rawText = JSON.stringify(answer);
  return { requestId, rawText, answer: rawText, answerProblem: null, usage: { inputTokens: 900, outputTokens: 60 } };
}

// A SERV that confirms the code's start, the answer the rulebook says is usually right.
function confirmingServ(overrides: Partial<DecideDeps> = {}): DecideDeps {
  const confirm = async (record: GraphRecord) => {
    GRAPH_G1.toInput(record);
    return reply({ verdict: 'ordinary_user', action: record.start_outcome, rule: record.start_rule, reason: 'The facts match the start.', cited_tx_hashes: [] });
  };
  return { viaGraph: vi.fn(confirm), viaV2: vi.fn(confirm), sleep: vi.fn(async () => undefined), ...overrides };
}

let db: Db;
let clock: Date;
let lines: string[];
let facts: Map<Address, Facts | Error>;
// Each first funder's nonce and code as the chain would show them. A funder not listed reads as an ordinary wallet.
let states: Map<Address, AccountState | Error>;
const WALLET_STATE: AccountState = { nonce: 12, code: '0x' };

function terms(overrides: Partial<CampaignInput> = {}): CampaignInput {
  return {
    id: CAMPAIGN,
    name: 'The demo',
    chain: CHAIN,
    vault: VAULT,
    token: TOKEN,
    owner: OWNER,
    agent: AGENT,
    rewardPerWallet: REWARD.toString(),
    perWalletCap: REWARD.toString(),
    partialShareBps: 5000,
    maxSlots: 3,
    rulebook: CURRENT_RULEBOOK,
    settings: { groupMinSize: 2, funderFanoutMin: 2 },
    status: 'open',
    opensAt: new Date(NOW.getTime() - 3_600_000),
    closesAt: new Date(NOW.getTime() + 86_400_000),
    createdAt: NOW,
    vaultBlock: CREATED_AT_BLOCK,
    ...overrides,
  };
}

function deps(vault: StandInVault, serv: DecideDeps = confirmingServ()): WorkerDeps {
  return {
    db,
    facts: async (wallet) => {
      const read = facts.get(wallet);
      if (read === undefined || read instanceof Error) throw read ?? new Error('no facts for this wallet');
      return read;
    },
    accountState: async (address: Address) => {
      const read = states.get(address) ?? WALLET_STATE;
      if (read instanceof Error) throw read;
      return read;
    },
    serv,
    chain: vault,
    factory: FACTORY,
    now: () => clock,
    log: (line) => lines.push(line),
    memory: emptyChainMemory(),
  };
}

/** Signs and queues one ask from a fresh key, a second later than the one before so the queue order is known. */
async function ask(
  read: Facts | Error | ((wallet: Address) => Facts),
  campaignId = CAMPAIGN,
  key: `0x${string}` = generatePrivateKey(),
): Promise<Wallet> {
  const account = privateKeyToAccount(key);
  const signedAt = Math.floor(clock.getTime() / 1000);
  const signature = await account.signMessage({ message: askMessage({ campaignId, wallet: account.address, signedAt }) });
  facts.set(account.address, typeof read === 'function' ? read(account.address) : read);
  expect(await addAsk(db, { campaignId, wallet: account.address, signedAt, signature }, clock)).toBe('queued');
  clock = new Date(clock.getTime() + 1000);
  return { address: account.address, key, signature };
}

const freshFunder = () => privateKeyToAccount(generatePrivateKey()).address;

/**
 * Screens until no ask of the given campaigns is waiting, moving the clock past the longest retry delay whenever the
 * only asks left are waiting one out. Returns every outcome, so a test can follow one wallet through its tries.
 */
async function screenAll(worker: WorkerDeps, campaignIds: readonly string[] = [CAMPAIGN]): Promise<ScreenOutcome[]> {
  const outcomes: ScreenOutcome[] = [];
  for (let step = 0; step < 500; step += 1) {
    const outcome = await screenNextAsk(worker);
    if (outcome.kind !== 'idle') {
      outcomes.push(outcome);
      continue;
    }
    const waiting = (await Promise.all(campaignIds.map((id) => counts(db, id)))).reduce((sum, tally) => sum + (tally?.queued ?? 0), 0);
    if (waiting === 0) return outcomes;
    clock = new Date(clock.getTime() + retryDelaySeconds(MAX_ASK_ATTEMPTS) * 1000);
  }
  throw new Error('the asks never settled');
}

/** The outcomes of one wallet's screenings, oldest first. */
const outcomesOf = (outcomes: readonly ScreenOutcome[], wallet: Wallet) =>
  outcomes.filter((outcome) => outcome.kind !== 'idle' && outcome.wallet === wallet.address);

/** Every try of the wallet released with `cause`, MAX_ASK_ATTEMPTS of them, the last one ending in the A1 hold. */
function expectHeldAfterEveryTry(outcomes: readonly ScreenOutcome[], wallet: Wallet, cause: string) {
  const tries = outcomesOf(outcomes, wallet);
  expect(tries).toHaveLength(MAX_ASK_ATTEMPTS);
  tries.forEach((outcome, index) =>
    expect(outcome).toMatchObject({ kind: 'released', cause, status: index < MAX_ASK_ATTEMPTS - 1 ? 'queued' : 'failed' }),
  );
}

async function relayAll(worker: WorkerDeps) {
  for (;;) {
    const outcome = await relayNext(worker);
    if (outcome.kind === 'idle') return;
  }
}

beforeEach(async () => {
  db = await openMemoryDb();
  await migrate(db);
  clock = NOW;
  lines = [];
  facts = new Map();
  states = new Map();
  vi.mocked(decideWallet).mockClear();
});

afterEach(async () => {
  await db.close();
});

describe('screening a campaign ask', () => {
  it('decides through the shared decision path with the current rulebook, and stores cited hashes lowercase (C12, C13)', async () => {
    await createCampaign(db, terms());
    const upper = `0x${'AB'.repeat(32)}`;
    const serv = confirmingServ({
      viaGraph: vi.fn(async (record: GraphRecord) =>
        reply({ verdict: 'ordinary_user', action: record.start_outcome, rule: record.start_rule, reason: 'Old and active.', cited_tx_hashes: [upper] }),
      ),
    });
    const wallet = await ask(basicRead(freshFunder()));
    const outcome = await screenNextAsk(deps(new StandInVault(3n * REWARD), serv));
    expect(outcome).toMatchObject({ kind: 'decided', action: 'full', rule: 'A9', slot: 1, servRequestId: 'run-1' });

    expect(decideWallet).toHaveBeenCalledTimes(1);
    const call = vi.mocked(decideWallet).mock.calls[0];
    // Four arguments and no rulebook among them: the checks inside run CURRENT_RULEBOOK and nothing here can change it.
    expect(call).toHaveLength(4);
    expect(call?.[3]).toBe('auto');
    expect(call?.[0]).toMatchObject({ wallet: wallet.address, start: { outcome: 'full', rule: 'A9' }, ceiling: 'full' });
    expect(call?.[1]).toMatchObject({ groupMinSize: 2, funderFanoutMin: 2, partialShareBps: 5000 });

    const stored = await getAsk(db, CAMPAIGN, wallet.address);
    expect(stored?.citedTxs).toEqual([HASH]);
    expect(stored?.notChecked).toEqual(['sharedDepositAddress', 'sweptToSharedCollector', 'claimPaidToOtherAddress', 'fundingBurst', 'passThroughFunding']);
    // The reader leaves the funder's kind unknown; the stored kind is the one read from the funder's own nonce and code.
    expect(stored?.facts?.funder).toMatchObject({ kind: 'wallet', fanout: 1 });
  });

  it('links no two asks whose shared first funder reads at the exchange nonce, and stores that kind (C16)', async () => {
    await createCampaign(db, terms());
    const exchange = freshFunder();
    states.set(exchange, { nonce: HIGH_VOLUME_NONCE, code: '0x' });
    const both = [await ask(basicRead(exchange)), await ask(basicRead(exchange))];
    await screenAll(deps(new StandInVault(3n * REWARD)));
    for (const wallet of both) {
      expect(await getAsk(db, CAMPAIGN, wallet.address)).toMatchObject({
        action: 'full',
        rule: 'A9',
        facts: { groupSize: null, funder: { address: exchange, kind: 'exchange', fanout: null } },
      });
    }
  });

  it('links no two asks whose shared first funder has contract code (C16)', async () => {
    await createCampaign(db, terms());
    const contract = freshFunder();
    states.set(contract, { nonce: 1, code: '0x6080604052348015600f57600080fd5b50' });
    const both = [await ask(basicRead(contract)), await ask(basicRead(contract))];
    await screenAll(deps(new StandInVault(3n * REWARD)));
    for (const wallet of both) {
      expect(await getAsk(db, CAMPAIGN, wallet.address)).toMatchObject({
        action: 'full',
        facts: { groupSize: null, funder: { kind: 'contract', fanout: null } },
      });
    }
  });

  it('decides nothing for a first funder whose code or nonce cannot be read, and holds it after the last attempt (C11)', async () => {
    await createCampaign(db, terms());
    const unreachable = freshFunder();
    const halfRead = freshFunder();
    states.set(unreachable, new Error('https://rpc.example/secret-key timed out'));
    states.set(halfRead, { nonce: null, code: '0x' });
    const wallets = [await ask(basicRead(unreachable)), await ask(basicRead(halfRead))];
    const outcomes = await screenAll(deps(new StandInVault(3n * REWARD)));
    for (const wallet of wallets) {
      expectHeldAfterEveryTry(outcomes, wallet, SCREEN_CAUSES.facts);
      expect(await getAsk(db, CAMPAIGN, wallet.address)).toMatchObject({ status: 'failed', action: 'hold', rule: 'A1', slot: null, facts: null });
    }
    expect(decideWallet).not.toHaveBeenCalled();
    expect(lines.join(' ')).not.toContain('secret-key');
  });

  /** The group facts decideWallet was given for one wallet's screening. */
  const groupSeenBy = (wallet: Wallet) =>
    vi.mocked(decideWallet).mock.calls.find(([row]) => row.wallet === wallet.address)?.[0].facts.group;

  it('makes one family of a funder that asks and the two wallets it funded, when the funder asks first (C15)', async () => {
    await createCampaign(db, terms());
    const funder = await ask(basicRead(freshFunder()));
    const funded = [await ask(basicRead(funder.address)), await ask(basicRead(funder.address))];
    await screenAll(deps(new StandInVault(3n * REWARD)));
    expect(await getAsk(db, CAMPAIGN, funder.address)).toMatchObject({ action: 'full', facts: { groupSize: null } });
    expect(await getAsk(db, CAMPAIGN, funded[0]?.address as Address)).toMatchObject({ action: 'hold', facts: { groupSize: 2 } });
    expect(await getAsk(db, CAMPAIGN, funded[1]?.address as Address)).toMatchObject({ action: 'hold', facts: { groupSize: 3 } });
    expect(groupSeenBy(funded[1] as Wallet)).toMatchObject({ size: 3, authoredEvidence: false, linkedByWallet: false });
  });

  it('makes the same family of 3 when the funded wallets ask first and the funder last, and marks the funder as the linker (C15)', async () => {
    await createCampaign(db, terms());
    const funderKey = generatePrivateKey();
    const funderAddress = privateKeyToAccount(funderKey).address;
    const worker = deps(new StandInVault(3n * REWARD));
    const funded = [await ask(basicRead(funderAddress)), await ask(basicRead(funderAddress))];
    await screenAll(worker);
    // Only now does the funder ask, after both wallets it paid were decided.
    const funder = await ask(basicRead(freshFunder()), CAMPAIGN, funderKey);
    await screenAll(worker);
    expect(await getAsk(db, CAMPAIGN, funded[0]?.address as Address)).toMatchObject({ action: 'full', facts: { groupSize: null } });
    expect(await getAsk(db, CAMPAIGN, funder.address)).toMatchObject({ action: 'hold', facts: { groupSize: 3, funder: { fanout: 1 } } });
    // The funder sent the fundings itself, which the replay records as linkedByWallet; it never makes exclude-grade evidence.
    expect(groupSeenBy(funder)).toEqual({
      size: 3,
      sameFunderWithinWindow: null,
      sweptToSharedCollector: false,
      authoredEvidence: false,
      linkedByWallet: true,
    });
    expect(groupSeenBy(funded[1] as Wallet)).toMatchObject({ size: 2, linkedByWallet: false });
  });

  it('counts a funder that asked even when its own screening failed and stored no funder', async () => {
    await createCampaign(db, terms());
    const funder = await ask(new Error('the reader failed'));
    const funded = [await ask(basicRead(funder.address)), await ask(basicRead(funder.address))];
    await screenAll(deps(new StandInVault(3n * REWARD)));
    expect(await getAsk(db, CAMPAIGN, funder.address)).toMatchObject({ status: 'failed', facts: null });
    expect(await getAsk(db, CAMPAIGN, funded[1]?.address as Address)).toMatchObject({ action: 'hold', facts: { groupSize: 3 } });
  });

  it('makes one family of 3 from a chain where each wallet funded the next (C15)', async () => {
    await createCampaign(db, terms());
    const first = await ask(basicRead(freshFunder()));
    const second = await ask(basicRead(first.address));
    const third = await ask(basicRead(second.address));
    await screenAll(deps(new StandInVault(3n * REWARD)));
    expect(await getAsk(db, CAMPAIGN, second.address)).toMatchObject({ facts: { groupSize: 2 } });
    expect(await getAsk(db, CAMPAIGN, third.address)).toMatchObject({ action: 'hold', facts: { groupSize: 3, funder: { fanout: 1 } } });
    expect(groupSeenBy(third)).toMatchObject({ size: 3, authoredEvidence: false, linkedByWallet: false });
  });

  it('refuses to screen a campaign on another rulebook, and holds the ask after the last attempt (C12)', async () => {
    await createCampaign(db, terms({ rulebook: CURRENT_RULEBOOK - 1 }));
    const wallet = await ask(basicRead(freshFunder()));
    const outcomes = await screenAll(deps(new StandInVault(3n * REWARD)));
    expectHeldAfterEveryTry(outcomes, wallet, CAMPAIGN_SCREEN_CAUSES.rulebook);
    expect(decideWallet).not.toHaveBeenCalled();
    expect(await getAsk(db, CAMPAIGN, wallet.address)).toMatchObject({ status: 'failed', action: 'hold', rule: 'A1', slot: null });
  });

  it('gives a slot to no ask whose facts, SERV call or answer failed (C11)', async () => {
    await createCampaign(db, terms());
    const downHash = `0x${'d0'.repeat(32)}`;
    const fake = `0x${'cd'.repeat(32)}`;
    const unread = await ask(new Error('https://rpc.example/secret timed out'));
    const servDown = await ask(basicRead(freshFunder(), { evidenceTxs: [downHash] }));
    const madeUp = await ask(basicRead(freshFunder()));
    const down = new ServError('SERV answered with status 503', 503, null);
    const route = vi.fn(async (record: GraphRecord) => {
      if (record.evidence_tx_hashes.includes(downHash)) throw down;
      return reply({ verdict: 'ordinary_user', action: record.start_outcome, rule: record.start_rule, reason: `Funded in ${fake}.`, cited_tx_hashes: [fake] });
    });
    const worker = deps(new StandInVault(3n * REWARD), confirmingServ({ viaGraph: route, viaV2: route }));

    const outcomes = await screenAll(worker);
    expectHeldAfterEveryTry(outcomes, unread, SCREEN_CAUSES.facts);
    expectHeldAfterEveryTry(outcomes, servDown, SCREEN_CAUSES.noAnswer);
    // An answer that cites a hash Thuli never fetched is refused by the checks, which is a hold, and is stored as one.
    expect(outcomesOf(outcomes, madeUp)).toEqual([expect.objectContaining({ kind: 'decided', action: 'hold', rule: 'A1', slot: null })]);

    for (const wallet of [unread, servDown]) {
      expect(await getAsk(db, CAMPAIGN, wallet.address)).toMatchObject({ status: 'failed', action: 'hold', rule: 'A1', slot: null });
    }
    expect(await getAsk(db, CAMPAIGN, madeUp.address)).toMatchObject({ status: 'decided', action: 'hold', slot: null });
    expect(await slotHolders(db, CAMPAIGN)).toEqual([]);
    expect(lines.join('\n')).not.toContain('secret');
  });

  it('holds the second of two asks one wallet funded, and links nobody through a shared exchange (C15, C16)', async () => {
    await createCampaign(db, terms());
    const shared = freshFunder();
    const first = await ask(basicRead(shared));
    const second = await ask(basicRead(shared));
    const exchange = freshFunder();
    states.set(exchange, { nonce: HIGH_VOLUME_NONCE + 5, code: '0x' });
    const viaExchange = basicRead(exchange);
    const viaExchangeToo = [await ask(viaExchange), await ask(viaExchange)];
    await screenAll(deps(new StandInVault(3n * REWARD)));

    expect(await getAsk(db, CAMPAIGN, first.address)).toMatchObject({ action: 'full', rule: 'A9', slot: 1 });
    expect(await getAsk(db, CAMPAIGN, second.address)).toMatchObject({ action: 'hold', rule: 'A4', slot: null, facts: { groupSize: 2 } });
    for (const [index, wallet] of viaExchangeToo.entries()) {
      expect(await getAsk(db, CAMPAIGN, wallet.address)).toMatchObject({ action: 'full', rule: 'A9', slot: index + 2, facts: { groupSize: null } });
    }
  });
});

describe('publishing, activating and relaying', () => {
  it('pays exactly the 3 slot holders when 5 asks are approved, and no held wallet (C44)', async () => {
    await createCampaign(db, terms());
    const approved: Wallet[] = [];
    for (let n = 0; n < 2; n += 1) approved.push(await ask(basicRead(freshFunder())));
    const held = await ask(basicRead(freshFunder(), { accountType: 'contract' }));
    for (let n = 0; n < 3; n += 1) approved.push(await ask(basicRead(freshFunder())));
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);

    await screenAll(worker);
    expect(await getAsk(db, CAMPAIGN, held.address)).toMatchObject({ action: 'hold', rule: 'A2', slot: null });
    expect((await Promise.all(approved.map((wallet) => getAsk(db, CAMPAIGN, wallet.address)))).every((a) => a?.action === 'full')).toBe(true);

    expect(await publishCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'posted', version: 1, wallets: 3, declaredTotal: 3n * REWARD });
    expect(await activateCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'skipped' });
    vault.advance(ROOT_DELAY);
    expect(await activateCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'queued', version: 1, activated: true, owed: 3, added: 3 });
    await relayAll(worker);

    const slotted = approved.slice(0, 3);
    for (const wallet of slotted) expect(vault.paid.get(wallet.address)).toBe(REWARD);
    for (const wallet of [...approved.slice(3), held]) expect(vault.paid.get(wallet.address)).toBeUndefined();
    expect(vault.totalPaid).toBe(3n * REWARD);
  });

  it('posts the root rebuilt from the stored text, proves each claim from it, and never pays a wallet twice across two versions (C27, C32)', async () => {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    const early = await ask(basicRead(freshFunder()));
    await screenAll(worker);
    expect(await publishCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'posted', version: 1, wallets: 1 });
    vault.advance(ROOT_DELAY);
    await activateCheck(worker, CAMPAIGN);
    await relayAll(worker);
    expect(vault.paid.get(early.address)).toBe(REWARD);

    const later = [await ask(basicRead(freshFunder())), await ask(basicRead(freshFunder()))];
    await screenAll(worker);
    const second = await publishCheck(worker, CAMPAIGN);
    expect(second).toMatchObject({ kind: 'posted', version: 2, wallets: 3 });
    const text = (await listText(db, CAMPAIGN, 2)) as string;
    const rebuilt = buildRoot(readPublishedList(text), VAULT, CHAIN).root;
    expect(vault.posted.at(-1)).toBe(rebuilt);
    expect((await latestList(db, CAMPAIGN))?.root).toBe(rebuilt);

    vault.advance(ROOT_DELAY);
    // Only the two new wallets are owed under version 2: the early one was paid its whole entitlement under version 1.
    expect(await activateCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'queued', version: 2, owed: 2, added: 2 });
    // Queue the early wallet by hand too: its claim is simulated, finds nothing to claim, and is confirmed unpaid.
    await queueRelays(db, CAMPAIGN, 2, [{ wallet: early.address, amount: REWARD.toString() }], clock);
    await relayAll(worker);
    expect(vault.paid.get(early.address)).toBe(REWARD);
    for (const wallet of later) expect(vault.paid.get(wallet.address)).toBe(REWARD);
    expect(vault.totalPaid).toBe(3n * REWARD);
    for (const ticket of vault.tickets.slice(1)) {
      expect(ticket).toEqual(claimTicket(text, VAULT, CHAIN, ticket.account));
    }
    expect(vault.sent.filter((fn) => fn === 'claim')).toHaveLength(3);
  });

  it('never posts while a root is pending or when the slot holders are already on chain, and resumes a list whose post failed', async () => {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    await ask(basicRead(freshFunder()));
    await screenAll(worker);

    vault.failPost = 1;
    await expect(publishCheck(worker, CAMPAIGN)).rejects.toThrow('the RPC dropped the transaction');
    expect((await listVersions(db, CAMPAIGN)).map((version) => version.status)).toEqual(['built']);
    expect(await publishCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'posted', version: 1 });
    expect(await publishCheck(worker, CAMPAIGN)).toEqual({ kind: 'skipped', reason: 'a root is pending on the vault' });

    await ask(basicRead(freshFunder()));
    await screenAll(worker);
    expect(await publishCheck(worker, CAMPAIGN)).toEqual({ kind: 'skipped', reason: 'a root is pending on the vault' });
    vault.advance(ROOT_DELAY);
    await activateCheck(worker, CAMPAIGN);
    expect(await publishCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'posted', version: 2, wallets: 2 });
    vault.advance(ROOT_DELAY);
    await activateCheck(worker, CAMPAIGN);
    expect(await publishCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'skipped' });
    expect(vault.sent.filter((fn) => fn === 'postRoot')).toHaveLength(2);
    expect((await listVersions(db, CAMPAIGN)).map((version) => version.status)).toEqual(['superseded', 'active']);
  });

  it('posts nothing for a vault the factory did not log in the recorded block, or logged with other terms', async () => {
    await createCampaign(db, terms({ vaultBlock: CREATED_AT_BLOCK + 1n }));
    await createCampaign(db, terms({ id: 'demo-terms' }));
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    await ask(basicRead(freshFunder()));
    await ask(basicRead(freshFunder()), 'demo-terms');
    await screenAll(worker, [CAMPAIGN, 'demo-terms']);
    await expect(publishCheck(worker, CAMPAIGN)).rejects.toThrow('did not log this vault once in the recorded block');
    vault.terms = { ...vault.terms, owner: address('99') };
    await expect(publishCheck(worker, 'demo-terms')).rejects.toThrow("the vault's owner is not the campaign's");
    expect(vault.sent).toEqual([]);
  });

  it('gives up on a relay that keeps failing at the store attempt limit (C41)', async () => {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    await ask(basicRead(freshFunder()));
    await screenAll(worker);
    await publishCheck(worker, CAMPAIGN);
    vault.advance(ROOT_DELAY);
    await activateCheck(worker, CAMPAIGN);
    vault.refuseClaims = 'EnforcedPause';
    const statuses: (string | null)[] = [];
    for (let n = 0; n <= MAX_RELAY_ATTEMPTS; n += 1) {
      const outcome = await relayNext(worker);
      statuses.push(outcome.kind === 'idle' ? 'idle' : outcome.status);
      if (outcome.kind === 'relayed' && outcome.retryAfterSeconds !== null) {
        clock = new Date(clock.getTime() + outcome.retryAfterSeconds * 1000);
      }
    }
    expect(statuses).toEqual([...Array<string>(MAX_RELAY_ATTEMPTS - 1).fill('pending'), 'failed', 'idle']);
    expect(vault.sent).toEqual(['postRoot']);
  });
});

describe('picking up where the vault stands after a restart', () => {
  const posts = (vault: StandInVault) => vault.sent.filter((fn) => fn === 'postRoot').length;

  it('records a post that reached the chain before the worker stopped, posts nothing twice, and pays it after the delay (C27, C32)', async () => {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    await ask(basicRead(freshFunder()));
    await screenAll(worker);
    vault.stopAfterPost = 1;
    await expect(publishCheck(worker, CAMPAIGN)).rejects.toThrow('stopped between the post and its record');
    expect((await listVersions(db, CAMPAIGN)).map((version) => version.status)).toEqual(['built']);

    const restarted = deps(vault);
    expect(await reconcileCheck(restarted, CAMPAIGN)).toEqual({ kind: 'reconciled', posted: [1], cancelled: [] });
    expect(await listVersions(db, CAMPAIGN)).toMatchObject([
      { version: 1, status: 'posted', postTx: null, claimableAt: Number(CHAIN_START + ROOT_DELAY) },
    ]);
    expect(await publishCheck(restarted, CAMPAIGN)).toEqual({ kind: 'skipped', reason: 'a root is pending on the vault' });
    expect(posts(vault)).toBe(1);

    vault.advance(ROOT_DELAY);
    expect(await reconcileCheck(restarted, CAMPAIGN)).toEqual({ kind: 'reconciled', posted: [], cancelled: [] });
    expect(await activateCheck(restarted, CAMPAIGN)).toMatchObject({ kind: 'queued', version: 1, activated: true, added: 1 });
    expect(posts(vault)).toBe(1);
  });

  it('makes a list active with no new post when the worker comes back after its delay is already over (C27)', async () => {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    await ask(basicRead(freshFunder()));
    await screenAll(worker);
    vault.stopAfterPost = 1;
    await expect(publishCheck(worker, CAMPAIGN)).rejects.toThrow('stopped between the post and its record');
    vault.advance(ROOT_DELAY + 60n);

    const restarted = deps(vault);
    expect(await reconcileCheck(restarted, CAMPAIGN)).toEqual({ kind: 'reconciled', posted: [1], cancelled: [] });
    expect(await activateCheck(restarted, CAMPAIGN)).toMatchObject({ kind: 'queued', version: 1, activated: true, added: 1 });
    expect(await publishCheck(restarted, CAMPAIGN)).toEqual({ kind: 'skipped', reason: 'the vault already pays exactly this list' });
    expect((await listVersions(db, CAMPAIGN)).map((version) => version.status)).toEqual(['active']);
    expect(posts(vault)).toBe(1);
  });

  it('records the owner cancelling a pending list, never posts that list again, and posts a new one once the slots change', async () => {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    await ask(basicRead(freshFunder()));
    await screenAll(worker);
    expect(await publishCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'posted', version: 1 });
    vault.cancelPending();

    expect(await reconcileCheck(worker, CAMPAIGN)).toEqual({ kind: 'reconciled', posted: [], cancelled: [1] });
    expect(lines).toContain(`reconcile ${CAMPAIGN}: the owner cancelled list version 1 on the vault, so it is recorded as cancelled`);
    for (let run = 0; run < 3; run += 1) {
      await reconcileCheck(worker, CAMPAIGN);
      expect(await publishCheck(worker, CAMPAIGN)).toEqual({
        kind: 'skipped',
        reason: 'the owner cancelled this list; nothing is posted until the slot holders change',
      });
    }
    expect(posts(vault)).toBe(1);

    await ask(basicRead(freshFunder()));
    await screenAll(worker);
    expect(await publishCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'posted', version: 2, wallets: 2 });
    expect(posts(vault)).toBe(2);
    expect((await listVersions(db, CAMPAIGN)).map((version) => version.status)).toEqual(['cancelled', 'posted']);
  });
});

describe('waiting out an outage', () => {
  it('waits 10, 30, 90 and 270 seconds after the first four tries, then 600 after every later one (C41)', () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelaySeconds)).toEqual([10, 30, 90, 270, 600, 600]);
  });

  it('takes a failed ask again only once its delay is over, and holds it on the tenth failure, not the third (C11, C41)', async () => {
    await createCampaign(db, terms());
    const wallet = await ask(new Error('the reader failed'));
    const worker = deps(new StandInVault(3n * REWARD));
    expect(MAX_ASK_ATTEMPTS).toBe(10);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect(await screenNextAsk(worker)).toMatchObject({
        kind: 'released',
        wallet: wallet.address,
        cause: SCREEN_CAUSES.facts,
        status: attempt < 10 ? 'queued' : 'failed',
      });
      if (attempt === 10) break;
      const wait = retryDelaySeconds(attempt);
      clock = new Date(clock.getTime() + (wait - 1) * 1000);
      expect(await screenNextAsk(worker)).toEqual({ kind: 'idle' });
      clock = new Date(clock.getTime() + 1000);
    }
    expect(lines).toContain(`screen ${CAMPAIGN} ${wallet.address}: not decided, ${SCREEN_CAUSES.facts}; queued again, next try in 10 s`);
    expect(await getAsk(db, CAMPAIGN, wallet.address)).toMatchObject({ status: 'failed', action: 'hold', rule: 'A1', slot: null });
  });

  it('gives a relay whose claim simulation fails back with the delay for its attempt (C41)', async () => {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    await ask(basicRead(freshFunder()));
    await screenNextAsk(worker);
    await publishCheck(worker, CAMPAIGN);
    vault.advance(ROOT_DELAY);
    await activateCheck(worker, CAMPAIGN);
    vault.refuseClaims = 'EnforcedPause';
    expect(await relayNext(worker)).toMatchObject({ kind: 'relayed', status: 'pending', retryAfterSeconds: 10 });
    expect(await relayNext(worker)).toEqual({ kind: 'idle' });
    clock = new Date(clock.getTime() + 10_000);
    expect(await relayNext(worker)).toMatchObject({ kind: 'relayed', status: 'pending', retryAfterSeconds: 30 });
    clock = new Date(clock.getTime() + 29_000);
    expect(await relayNext(worker)).toEqual({ kind: 'idle' });
    clock = new Date(clock.getTime() + 1000);
    expect(await relayNext(worker)).toMatchObject({ kind: 'relayed', status: 'pending', retryAfterSeconds: 90 });
    expect(lines.some((line) => line.includes('pending, next try in 30 s'))).toBe(true);
  });
});

describe('every open campaign', () => {
  it('posts each open campaign to its own vault, carries on past one whose vault read fails, and skips one with no vault block', async () => {
    const otherVault = address('b2');
    await createCampaign(db, terms());
    await createCampaign(db, terms({ id: 'demo-b', vault: otherVault }));
    await createCampaign(db, terms({ id: 'demo-c', vault: address('c3'), vaultBlock: null }));
    const first = new StandInVault(3n * REWARD);
    const second = new StandInVault(3n * REWARD, otherVault);
    const worker = { ...deps(first), chain: chainOf(first, second) };
    const paidByFirst = await ask(basicRead(freshFunder()));
    const paidBySecond = await ask(basicRead(freshFunder()), 'demo-b');
    await screenAll(worker, [CAMPAIGN, 'demo-b']);

    const posting = await runOnce(worker);
    expect(posting.campaigns).toMatchObject([
      { campaignId: CAMPAIGN, publish: { kind: 'posted', version: 1, wallets: 1 } },
      { campaignId: 'demo-b', publish: { kind: 'posted', version: 1, wallets: 1 } },
      { campaignId: 'demo-c', reconcile: { kind: 'skipped', reason: NO_VAULT_BLOCK } },
    ]);
    expect([first.posted.length, second.posted.length]).toEqual([1, 1]);
    expect(first.posted[0]).not.toBe(second.posted[0]);

    first.roots = async () => {
      throw new Error('the RPC is down');
    };
    first.advance(ROOT_DELAY);
    second.advance(ROOT_DELAY);
    const paying = await runOnce(worker);
    expect(paying.campaigns).toMatchObject([
      { campaignId: CAMPAIGN, reconcile: { kind: 'failed' }, activate: { kind: 'not-run' }, publish: { kind: 'not-run' } },
      { campaignId: 'demo-b', activate: { kind: 'queued', version: 1, added: 1 } },
      { campaignId: 'demo-c', reconcile: { kind: 'skipped', reason: NO_VAULT_BLOCK } },
    ]);
    expect(paying.relay).toMatchObject({ kind: 'relayed', campaignId: 'demo-b', wallet: paidBySecond.address, status: 'confirmed' });
    expect(second.paid.get(paidBySecond.address)).toBe(REWARD);
    expect(first.paid.get(paidByFirst.address)).toBeUndefined();
    expect(lines.filter((line) => line.startsWith('demo-c:'))).toEqual([`demo-c: waiting, ${NO_VAULT_BLOCK}`]);
  });
});

describe('the worker loop', () => {
  it('only ever sends postRoot and claim to the vault, and logs no key and no signature (C30, C39)', async () => {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    const wallets = [await ask(basicRead(freshFunder())), await ask(basicRead(freshFunder()))];
    // The first list holds only the first wallet, decided before the second; the second list adds the other.
    for (const pause of [ROOT_DELAY, ROOT_DELAY, 0n]) {
      for (let run = 0; run < 4; run += 1) await runOnce(worker);
      vault.advance(pause);
    }

    expect(new Set(vault.sent)).toEqual(new Set(['postRoot', 'claim']));
    const writes = vault.calls.filter((call) => call.startsWith('send'));
    expect(new Set(writes)).toEqual(new Set(['sendPostRoot', 'sendClaim']));
    for (const wallet of wallets) expect(vault.paid.get(wallet.address)).toBe(REWARD);

    const log = lines.join('\n').toLowerCase();
    expect(lines.length).toBeGreaterThan(0);
    expect(log).not.toContain(AGENT_KEY.slice(2).toLowerCase());
    for (const wallet of wallets) {
      expect(log).not.toContain(wallet.key.slice(2).toLowerCase());
      expect(log).not.toContain(wallet.signature.slice(2, 66).toLowerCase());
    }
  });

  it('bounds every step with a timeout, so a hung reader or chain cannot stop the loop (C41)', async () => {
    await createCampaign(db, terms());
    const hung = new Promise<never>(() => undefined);
    const vault = new StandInVault(3n * REWARD);
    vault.roots = () => hung;
    const timeouts = { screen: 40, campaigns: 40, reconcile: 40, activate: 40, publish: 40, relay: 40 };
    const worker = { ...deps(vault), facts: () => hung, timeouts };
    await ask(basicRead(freshFunder()));
    const report = await runOnce(worker);
    expect(report.screen).toEqual({ kind: 'timed-out', afterMs: 40 });
    // A reconcile that never answers stops that campaign's other steps for this run, fail closed.
    expect(report.campaigns).toEqual([
      { campaignId: CAMPAIGN, reconcile: { kind: 'timed-out', afterMs: 40 }, activate: { kind: 'not-run' }, publish: { kind: 'not-run' } },
    ]);
    expect(report.relay).toEqual({ kind: 'idle' });
  });

  it('runs once with once set, and finishes the step under way and stops when told to', async () => {
    await createCampaign(db, terms());
    const worker = deps(new StandInVault(3n * REWARD));
    expect(await runLoop(worker, { once: true, signal: new AbortController().signal })).toBe(1);

    const stop = new AbortController();
    await ask(basicRead(freshFunder()));
    const stopping = { ...worker, facts: async (wallet: Address) => {
      stop.abort();
      return worker.facts(wallet);
    } };
    expect(await runLoop(stopping, { once: false, signal: stop.signal, intervalMs: 10 })).toBe(1);
    expect((await slotHolders(db, CAMPAIGN)).length).toBe(1);
    expect(vi.mocked(decideWallet)).toHaveBeenCalledTimes(1);
  });
});

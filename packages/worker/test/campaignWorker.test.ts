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
  CAMPAIGN_SCREENINGS_DAY_COUNTER,
  counts,
  createCampaign,
  dayCount,
  getAsk,
  latestList,
  listText,
  listVersions,
  markRelay,
  MAX_RELAY_ATTEMPTS,
  migrate,
  openMemoryDb,
  queueRelays,
  slotHolders,
  type CampaignInput,
  type Db,
  confirmedPayouts,
} from '@thuli/store';
import { NO_VAULT_BLOCK, runLoop, runOnce, type WorkerDeps } from '../src/campaign/loop.ts';
import {
  CANCEL_MARGIN_SECONDS,
  cancelProven,
  MAX_RESENDS,
  publishCheck,
  reconcileCheck,
  RESEND_AFTER_SECONDS,
  SENDING_LIST,
  UNSEEN_LIST,
  UNSENT_AFTER_SECONDS,
} from '../src/campaign/publish.ts';
import { activateCheck, relayNext } from '../src/campaign/relay.ts';
import {
  CAMPAIGN_SCREEN_CAUSES,
  CAMPAIGN_SCREENINGS_DAY_MAX,
  MAX_ASK_ATTEMPTS,
  REFUSED_ANSWER_TRIES,
  retryDelaySeconds,
  screenNextAsk,
  type ScreenOutcome,
} from '../src/campaign/screen.ts';
import { emptyChainMemory, NO_ROOT, type CampaignVault, type ClaimSimulation } from '../src/campaign/vault.ts';
import { decideWallet, type DecideDeps } from '../src/replay/decide.ts';
import { SCREEN_CAUSES } from '../src/screen/single.ts';
import { ServError, type ServReply } from '../src/serv/client.ts';
import { claimTicket, type ClaimTicket } from '../src/vault/claimList.ts';
import { buildRoot, readPublishedList, RootError, type VaultSnapshot, type VaultTerms } from '../src/vault/root.ts';

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
  /** The owner's pause: claims stop, and claimable() answers 0 for every wallet. */
  paused = false;
  /** The worker stops after recording a signed post and before sending it, this many times. */
  stopBeforeBroadcast = 0;
  /** The next post is mined and reverts. */
  revertNextPost = false;
  /** Posts a node shows as waiting to be mined, by hash, so a read of their receipt answers pending. */
  readonly inPool = new Set<string>();
  /** The agent's transaction count at the latest block as this vault's node sees it: every nonce below it is used. */
  mined = 0;
  /** Broadcasts the node accepts and then loses this many times: never mined and never shown, unless a test lands one. */
  loseBroadcasts = 0;
  /** Broadcasts the node keeps in its pool unmined this many times, shown as pending. */
  holdBroadcasts = 0;
  /** Every post signed, in order, with the nonce it was signed at. */
  readonly signings: { hash: `0x${string}`; root: MerkleHash; nonce: number }[] = [];
  /** The node answering receipt reads is behind: every receipt read answers as if no post were known yet. */
  receiptsLag = false;
  private gate: Promise<void> | null = null;
  private readonly signedPosts = new Map<string, { root: MerkleHash; declaredTotal: bigint; nonce: number }>();
  private readonly postReceipts = new Map<string, { ok: boolean; claimableAt: bigint }>();
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

  /**
   * What a lagging node answers: set to an earlier view, the worker's reads (roots and readSnapshot) show the vault as it
   * was then, while every write still lands on the vault as it is.
   */
  staleView: { active: MerkleHash; pending: MerkleHash; pendingAt: bigint; now: bigint } | null = null;

  /** The vault as a read would show it right now, to hand to staleView later. */
  view() {
    return { ...this.roots_(), now: this.now };
  }

  /** Views the next reads answer with, one each, before reads go back to staleView or the vault as it is. */
  readonly nextReads: ReturnType<StandInVault['view']>[] = [];

  private read() {
    return this.nextReads.shift() ?? this.staleView ?? this.view();
  }

  /** A root someone else put pending on the vault, such as a second worker for a few seconds of a redeploy. */
  pendFromElsewhere(root: MerkleHash) {
    this.settle();
    this.pending = root;
    this.pendingAt = this.now + ROOT_DELAY;
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

  /** Holds the next send until the returned function is called: a node or a step that stalls mid-send. */
  gateFirstSend(): () => void {
    let open: () => void = () => undefined;
    this.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    return open;
  }

  private async passGate(): Promise<void> {
    const gate = this.gate;
    this.gate = null;
    if (gate !== null) await gate;
  }

  pause() {
    this.settle();
    this.paused = true;
  }

  unpause() {
    this.paused = false;
  }

  private check(ticket: ClaimTicket): ClaimSimulation & { amount?: bigint } {
    if (this.paused) return { ok: false, error: 'EnforcedPause' };
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
    const { active, pending, now } = this.read();
    return {
      blockNumber: 1000n,
      timestamp: now,
      agent: AGENT,
      deposited: this.deposited,
      totalPaid: this.totalPaid,
      perWalletCap: REWARD,
      endTime: this.endTime,
      rootDelay: ROOT_DELAY,
      paused: this.paused,
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
    await this.passGate();
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

  // The nonce viem's pending count would give: the mined count plus the agent's posts this node holds unmined.
  private freshNonce(): number {
    const held = [...this.inPool].filter((hash) => (this.signedPosts.get(hash)?.nonce ?? -1) >= this.mined);
    return this.mined + held.length;
  }

  // Mines one post when its nonce is the next one; a post at a used nonce can never be mined.
  private minePost(hash: string): boolean {
    const post = this.signedPosts.get(hash);
    if (post === undefined || post.nonce !== this.mined) return false;
    this.useNonce();
    if (this.revertNextPost || post.declaredTotal > this.deposited) {
      this.revertNextPost = false;
      this.postReceipts.set(hash, { ok: false, claimableAt: 0n });
      return true;
    }
    this.settle();
    this.pending = post.root;
    this.pendingAt = this.now + ROOT_DELAY;
    this.posted.push(post.root);
    this.postReceipts.set(hash, { ok: true, claimableAt: this.pendingAt });
    return true;
  }

  // The next nonce is used; every held post below it can never land, and the node drops it.
  private useNonce() {
    this.mined += 1;
    for (const held of [...this.inPool]) {
      if ((this.signedPosts.get(held)?.nonce ?? Number.POSITIVE_INFINITY) < this.mined) this.inPool.delete(held);
    }
  }

  /** Another transaction from the agent is mined at its next nonce, such as one sent by hand. */
  takeNonce() {
    this.useNonce();
  }

  /** A lost or held post reaches a block after all, when its nonce is still the next one. */
  land(hash: string): boolean {
    return this.minePost(hash);
  }

  async minedNonce() {
    this.calls.push('minedNonce');
    return this.mined;
  }

  async signPostRoot(_vault: Address, root: MerkleHash, declaredTotal: bigint, nonce?: number) {
    this.calls.push('signPostRoot');
    await this.passGate();
    const at = nonce ?? this.freshNonce();
    const hash = this.nextHash();
    this.signedPosts.set(hash, { root, declaredTotal, nonce: at });
    this.signings.push({ hash, root, nonce: at });
    return { hash, serialized: hash, nonce: at };
  }

  async broadcast(signed: { hash: `0x${string}`; serialized: `0x${string}`; nonce: number }) {
    this.calls.push('broadcast');
    if (this.stopBeforeBroadcast > 0) {
      this.stopBeforeBroadcast -= 1;
      throw new Error('the worker stopped between recording the post and sending it');
    }
    if (this.failPost > 0) {
      this.failPost -= 1;
      throw new Error('the RPC dropped the transaction');
    }
    const post = this.signedPosts.get(signed.hash);
    if (post === undefined) throw new Error('no such signed transaction');
    if (post.nonce < this.mined) throw new Error('nonce too low');
    this.sent.push('postRoot');
    if (this.loseBroadcasts > 0) {
      this.loseBroadcasts -= 1;
      return;
    }
    if (this.holdBroadcasts > 0 || post.nonce > this.mined) {
      if (this.holdBroadcasts > 0) this.holdBroadcasts -= 1;
      this.inPool.add(signed.hash);
      return;
    }
    this.minePost(signed.hash);
    if (this.stopAfterPost > 0) {
      this.stopAfterPost -= 1;
      throw new Error('the worker stopped between the post and its record');
    }
  }

  async postReceipt(_vault: Address, _root: MerkleHash, hash: `0x${string}`, _waitMs: number) {
    this.calls.push('postReceipt');
    if (this.receiptsLag) return { state: 'unknown' as const };
    if (this.inPool.has(hash)) return { state: 'pending' as const };
    const receipt = this.postReceipts.get(hash);
    if (receipt === undefined) return { state: 'unknown' as const };
    return receipt.ok
      ? { state: 'mined' as const, ok: true as const, gasUsed: 61_000n, claimableAt: receipt.claimableAt }
      : { state: 'mined' as const, ok: false as const, gasUsed: 30_000n };
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
    const { active, pending, pendingAt, now } = this.read();
    return { blockNumber: 1000n, timestamp: now, activeRoot: active, pendingRoot: pending, pendingClaimableAt: pendingAt, paused: this.paused };
  }

  async claimedOf(_vault: Address, accounts: readonly Address[], _blockNumber: bigint) {
    this.calls.push('claimedOf');
    return accounts.map((account) => this.claimed.get(parseAddress(account)) ?? 0n);
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
    // A claim is the agent's transaction too, so it uses the agent's next nonce.
    this.useNonce();
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
    signPostRoot: (vault, root, total, nonce) => at(vault).signPostRoot(vault, root, total, nonce),
    // Each stand-in counts its own nonces; the highest is the agent's, as one key signs for every vault.
    minedNonce: async () => Math.max(...vaults.map((vault) => vault.mined)),
    // A stand-in hash opens with its vault's address, so a signed post goes back to the vault that signed it.
    broadcast: (signed) => {
      const owner = vaults.find((vault) => vault.address.slice(2, 10).toLowerCase() === signed.hash.slice(2, 10));
      if (owner === undefined) throw new Error('no stand-in vault signed this');
      return owner.broadcast(signed);
    },
    postReceipt: (vault, root, hash, wait) => at(vault).postReceipt(vault, root, hash, wait),
    roots: (vault) => at(vault).roots(vault),
    claimedOf: (vault, accounts, block) => at(vault).claimedOf(vault, accounts, block),
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

const SINGLE_READ_MISSING: Facts['missing'] = ['group', 'sharedDepositAddress', 'claimPaidToOtherAddress'];

// What collectBasicFacts reads for a wallet that never sent or received anything: age 0 from a history read in full,
// no transaction sent, plain account, and no funder found, which it names in missing.
function neverUsed(overrides: Partial<Facts> = {}): Facts {
  return basicRead(freshFunder(), {
    walletAgeDays: 0,
    txCountAtSnapshot: 0,
    firstFunder: null,
    evidenceTxs: [],
    missing: [...SINGLE_READ_MISSING, 'firstFunder'],
    ...overrides,
  });
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
    // These asks stand for wallets used on Ethereum only, the one kind a worker with Base history off may decide.
    usedOnBase: async () => false,
    serv,
    chain: vault,
    factory: FACTORY,
    now: () => clock,
    log: (line) => lines.push(line),
    memory: emptyChainMemory(),
  };
}

/**
 * The same worker as one that read both chains: neither chain shows any activity, so the facts are read through the
 * Ethereum reader, which answers from the same `facts` and `states` as the worker's Ethereum-only readers. Only a worker
 * that read both chains may hold a wallet as never used; one that read Ethereum alone gives such an ask back.
 */
function onBothChains(worker: WorkerDeps): WorkerDeps {
  const reader = {
    firstActivity: async () => ({ time: null, block: 100 }),
    facts: (wallet: Address) => worker.facts(wallet),
    accountState: (address: Address) => worker.accountState(address),
  };
  return { ...worker, chains: { ethereum: reader, base: reader } };
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
    // Its first two tries are given back like failed ones, and the third stores the code-written hold.
    expect(outcomesOf(outcomes, madeUp)).toEqual([
      expect.objectContaining({ kind: 'released', cause: CAMPAIGN_SCREEN_CAUSES.refused, status: 'queued' }),
      expect.objectContaining({ kind: 'released', cause: CAMPAIGN_SCREEN_CAUSES.refused, status: 'queued' }),
      expect.objectContaining({ kind: 'decided', action: 'hold', rule: 'A1', slot: null }),
    ]);

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

    // The post was recorded as sending, with its nonce, before the node refused it. Once no node has shown it for
    // RESEND_AFTER_SECONDS it is signed again at that nonce, and the next settle records it from its receipt.
    vault.failPost = 1;
    await expect(publishCheck(worker, CAMPAIGN)).rejects.toThrow('the RPC dropped the transaction');
    expect((await listVersions(db, CAMPAIGN)).map((version) => version.status)).toEqual(['sending']);
    await reconcileCheck(worker, CAMPAIGN);
    clock = new Date(clock.getTime() + RESEND_AFTER_SECONDS * 1000);
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ posted: [], unsent: [] });
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ posted: [1], unsent: [] });
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
    // A refusal that is the claim's own uses up its tries; a pause does not (see the paused vault tests).
    vault.refuseClaims = 'DepositExhausted';
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
    const [sending] = await listVersions(db, CAMPAIGN);
    expect(sending).toMatchObject({ status: 'sending', postTx: expect.stringMatching(/^0x[0-9a-f]{64}$/) });

    const restarted = deps(vault);
    expect(await reconcileCheck(restarted, CAMPAIGN)).toEqual({ kind: 'reconciled', posted: [1], cancelled: [], unsent: [] });
    expect(await listVersions(db, CAMPAIGN)).toMatchObject([
      { version: 1, status: 'posted', postTx: sending?.postTx, claimableAt: Number(CHAIN_START + ROOT_DELAY) },
    ]);
    expect(await publishCheck(restarted, CAMPAIGN)).toEqual({ kind: 'skipped', reason: 'a root is pending on the vault' });
    expect(posts(vault)).toBe(1);

    vault.advance(ROOT_DELAY);
    expect(await reconcileCheck(restarted, CAMPAIGN)).toEqual({ kind: 'reconciled', posted: [], cancelled: [], unsent: [] });
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
    expect(await reconcileCheck(restarted, CAMPAIGN)).toEqual({ kind: 'reconciled', posted: [1], cancelled: [], unsent: [] });
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
    vault.advance(BigInt(CANCEL_MARGIN_SECONDS));

    expect(await reconcileCheck(worker, CAMPAIGN)).toEqual({ kind: 'reconciled', posted: [], cancelled: [1], unsent: [] });
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

describe('found by an independent check of the worker', () => {
  const posts = (vault: StandInVault) => vault.sent.filter((fn) => fn === 'postRoot').length;

  it('never posts a list again after a post that was never recorded and the owner\'s cancel', async () => {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    await ask(basicRead(freshFunder()));
    await screenAll(worker);
    vault.stopAfterPost = 1;
    await expect(publishCheck(worker, CAMPAIGN)).rejects.toThrow();
    vault.cancelPending();
    vault.advance(BigInt(CANCEL_MARGIN_SECONDS));
    for (let run = 0; run < 3; run += 1) {
      await reconcileCheck(worker, CAMPAIGN);
      await publishCheck(worker, CAMPAIGN).catch(() => undefined);
    }
    expect(posts(vault)).toBe(1);
  });

  it('sends nothing from a publish that ran past its limit, once a newer list has been posted', async () => {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    await ask(basicRead(freshFunder()));
    await screenAll(worker);
    const open = vault.gateFirstSend();
    const timeouts = { screen: 5000, campaigns: 5000, reconcile: 5000, activate: 5000, publish: 50, relay: 5000 };
    const stalled = await runOnce({ ...worker, timeouts });
    expect(stalled.campaigns).toMatchObject([{ campaignId: CAMPAIGN, publish: { kind: 'timed-out' } }]);

    await ask(basicRead(freshFunder()));
    await screenAll(worker);
    expect(await publishCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'posted', version: 2, wallets: 2 });
    const newer = (await latestList(db, CAMPAIGN))?.root;
    open();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(vault.posted).toEqual([newer]);
    expect(vault.view().pending).toBe(newer);
    vault.advance(BigInt(CANCEL_MARGIN_SECONDS));
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'reconciled', cancelled: [] });
  });

  it('never reads a paused vault as paid: the owed wallets are queued once it is unpaused', async () => {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    const owed = await ask(basicRead(freshFunder()));
    await screenAll(worker);
    await publishCheck(worker, CAMPAIGN);
    vault.advance(ROOT_DELAY);
    vault.pause();
    await activateCheck(worker, CAMPAIGN);
    vault.unpause();
    expect(await activateCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'queued', version: 1, added: 1 });
    expect(await relayNext(worker)).toMatchObject({ kind: 'relayed', wallet: owed.address, status: 'confirmed' });
    expect(vault.paid.get(owed.address)).toBe(REWARD);
  });
});

describe('a post recorded before the network can know it', () => {
  const posts = (vault: StandInVault) => vault.sent.filter((fn) => fn === 'postRoot').length;
  const statuses = async () => (await listVersions(db, CAMPAIGN)).map((version) => version.status);

  async function oneSlotHolder() {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    await ask(basicRead(freshFunder()));
    await screenAll(worker);
    return { vault, worker };
  }

  it('signs a post again at its own nonce when it was recorded but never sent, after the wait, and posts it once', async () => {
    const { vault, worker } = await oneSlotHolder();
    vault.stopBeforeBroadcast = 1;
    await expect(publishCheck(worker, CAMPAIGN)).rejects.toThrow('stopped between recording the post and sending it');
    expect(await statuses()).toEqual(['sending']);
    expect(await publishCheck(worker, CAMPAIGN)).toEqual({ kind: 'skipped', reason: SENDING_LIST });
    expect(await reconcileCheck(worker, CAMPAIGN)).toEqual({ kind: 'reconciled', posted: [], cancelled: [], unsent: [] });
    clock = new Date(clock.getTime() + (RESEND_AFTER_SECONDS - 1) * 1000);
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [] });
    expect(vault.signings).toHaveLength(1);
    clock = new Date(clock.getTime() + 1000);
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [] });
    expect(vault.signings.map((signing) => signing.nonce)).toEqual([0, 0]);
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ posted: [1] });
    expect(await statuses()).toEqual(['posted']);
    expect(posts(vault)).toBe(1);
  });

  it('records a post from its own receipt when the worker stopped between the send and the wait, posting it once', async () => {
    const { vault, worker } = await oneSlotHolder();
    vault.stopAfterPost = 1;
    await expect(publishCheck(worker, CAMPAIGN)).rejects.toThrow();
    const restarted = deps(vault);
    expect(await reconcileCheck(restarted, CAMPAIGN)).toMatchObject({ posted: [1] });
    expect(await listVersions(db, CAMPAIGN)).toMatchObject([{ status: 'posted', claimableAt: Number(CHAIN_START + ROOT_DELAY) }]);
    for (let run = 0; run < 3; run += 1) await publishCheck(restarted, CAMPAIGN);
    expect(posts(vault)).toBe(1);
  });

  it('builds a list again when its post reverted, and sends it again once the cause is gone', async () => {
    const { vault, worker } = await oneSlotHolder();
    vault.revertNextPost = true;
    await expect(publishCheck(worker, CAMPAIGN)).rejects.toThrow('reverted');
    expect(await statuses()).toEqual(['built']);
    expect(vault.posted).toEqual([]);
    expect(await publishCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'posted', version: 1 });
    expect(posts(vault)).toBe(2);
    expect(vault.posted).toHaveLength(1);
  });

  it('sends nothing and writes nothing once its publish is told to stop', async () => {
    const { vault, worker } = await oneSlotHolder();
    let writesAfterStop = 0;
    const stop = new AbortController();
    const counted = (query: Db['query']): Db['query'] =>
      (async (text: string, params?: readonly unknown[]) => {
        if (stop.signal.aborted && /\b(INSERT|UPDATE|DELETE)\b/i.test(text)) writesAfterStop += 1;
        return query(text, params);
      }) as Db['query'];
    const counting: Db = {
      query: counted(db.query.bind(db)),
      transaction: (work) => db.transaction((tx) => work({ query: counted(tx.query.bind(tx)) })),
      close: () => db.close(),
    };
    const open = vault.gateFirstSend();
    const stalled = publishCheck({ ...worker, db: counting }, CAMPAIGN, stop.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop.abort();
    open();
    await expect(stalled).rejects.toThrow('ran past its time limit');
    expect(writesAfterStop).toBe(0);
    expect(posts(vault)).toBe(0);
    expect(await statuses()).toEqual(['built']);
  });

  it('refuses to sign when a read right before signing shows a pending root the first reads missed', async () => {
    const { vault, worker } = await oneSlotHolder();
    const before = vault.view();
    vault.pendFromElsewhere(`0x${'77'.repeat(32)}`);
    // The first two reads, the step's own and postRoot's, come from a node behind; the read before signing does not.
    vault.nextReads.push(before, before);
    await expect(publishCheck(worker, CAMPAIGN)).rejects.toThrow('a root is pending on the vault, so nothing was signed');
    expect(vault.calls).not.toContain('signPostRoot');
    expect(posts(vault)).toBe(0);
    expect(await statuses()).toEqual(['built']);
  });
});

describe('a paused vault and what each wallet is owed', () => {
  it('marks nothing and queues nothing while the vault is paused, and after the unpause queues exactly the owed wallets', async () => {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    const owed = [await ask(basicRead(freshFunder())), await ask(basicRead(freshFunder()))];
    await screenAll(worker);
    await publishCheck(worker, CAMPAIGN);
    vault.advance(ROOT_DELAY);
    vault.pause();
    expect(await activateCheck(worker, CAMPAIGN)).toEqual({ kind: 'skipped', reason: 'the vault is paused' });
    expect((await listVersions(db, CAMPAIGN)).map((version) => version.status)).toEqual(['posted']);
    expect(await relayNext(worker)).toEqual({ kind: 'idle' });
    vault.unpause();
    expect(await activateCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'queued', activated: true, owed: 2, added: 2 });
    await relayAll(worker);
    for (const wallet of owed) expect(vault.paid.get(wallet.address)).toBe(REWARD);
  });

  it('queues a wallet paid part of its cumulative amount under an earlier version for the rest, read from claimed()', async () => {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    const partlyPaid = await ask(basicRead(freshFunder()));
    await screenAll(worker);
    await publishCheck(worker, CAMPAIGN);
    vault.advance(ROOT_DELAY);
    vault.claimed.set(partlyPaid.address, REWARD / 2n);
    vault.totalPaid = REWARD / 2n;
    expect(await activateCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'queued', owed: 1, added: 1 });
    await relayAll(worker);
    expect(vault.paid.get(partlyPaid.address)).toBe(REWARD / 2n);
    expect(vault.claimed.get(partlyPaid.address)).toBe(REWARD);
  });
});

describe('a step that fails the same way on every run', () => {
  it('is logged once, again when its cause changes, and once more when it clears', async () => {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    let cause = 'the RPC answered with nothing';
    vault.roots = async () => {
      throw new RootError(cause);
    };
    const failures = () => lines.filter((line) => line.startsWith(`reconcile ${CAMPAIGN}: failed`));
    for (let run = 0; run < 3; run += 1) await runOnce(worker);
    expect(failures()).toEqual([`reconcile ${CAMPAIGN}: failed, the RPC answered with nothing`]);
    cause = 'the RPC answered too late';
    for (let run = 0; run < 2; run += 1) await runOnce(worker);
    expect(failures()).toHaveLength(2);
    vault.roots = StandInVault.prototype.roots.bind(vault);
    for (let run = 0; run < 2; run += 1) await runOnce(worker);
    expect(lines.filter((line) => line === `reconcile ${CAMPAIGN}: working again`)).toHaveLength(1);
    expect(failures()).toHaveLength(2);
  });
});

describe('a refused answer', () => {
  it('is given back with the retry wait on its first two tries and stored as the A1 hold on the third, never approved (C11, C13)', async () => {
    await createCampaign(db, terms());
    const fake = `0x${'cd'.repeat(32)}`;
    const refusing = vi.fn(async (record: GraphRecord) =>
      reply({ verdict: 'ordinary_user', action: record.start_outcome, rule: record.start_rule, reason: `Funded in ${fake}.`, cited_tx_hashes: [fake] }),
    );
    const worker = deps(new StandInVault(3n * REWARD), confirmingServ({ viaGraph: refusing, viaV2: refusing }));
    const wallet = await ask(basicRead(freshFunder()));
    const outcomes = await screenAll(worker);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['released', 'released', 'decided']);
    expect(outcomes.slice(0, 2)).toEqual([
      expect.objectContaining({ cause: CAMPAIGN_SCREEN_CAUSES.refused, status: 'queued' }),
      expect.objectContaining({ cause: CAMPAIGN_SCREEN_CAUSES.refused, status: 'queued' }),
    ]);
    expect(await getAsk(db, CAMPAIGN, wallet.address)).toMatchObject({ status: 'decided', action: 'hold', rule: 'A1', slot: null });
    expect(REFUSED_ANSWER_TRIES).toBe(3);
  });
});

describe('found by a second independent check of the worker', () => {
  const statuses = async () => (await listVersions(db, CAMPAIGN)).map((version) => version.status);

  it('(f) keeps the earlier rule for a version stored with no nonce: built again only after UNSENT_AFTER_SECONDS unseen, never sent again (C27, C32)', async () => {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    await ask(basicRead(freshFunder()));
    await screenAll(worker);
    vault.stopBeforeBroadcast = 1;
    await expect(publishCheck(worker, CAMPAIGN)).rejects.toThrow('stopped between recording the post and sending it');
    // As a version recorded before the nonce was kept with its hash.
    await db.query('UPDATE list_versions SET post_nonce = NULL WHERE campaign_id = $1', [CAMPAIGN]);
    const hash = (await latestList(db, CAMPAIGN))?.postTx as string;
    const start = clock.getTime();
    const at = (seconds: number) => {
      clock = new Date(start + seconds * 1000);
    };

    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [] });
    at(300);
    vault.inPool.add(hash);
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [] });
    vault.inPool.delete(hash);
    at(UNSENT_AFTER_SECONDS + 1);
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [] });
    expect(await statuses()).toEqual(['sending']);

    // Missing on every read for a full, unbroken UNSENT_AFTER_SECONDS after that builds it again.
    at(2 * UNSENT_AFTER_SECONDS);
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [] });
    at(2 * UNSENT_AFTER_SECONDS + 1);
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [1] });
    expect(await statuses()).toEqual(['built']);
    expect(vault.calls).not.toContain('minedNonce');
    expect(vault.signings).toHaveLength(1);
  });

  it('records a claim it broadcast as sent with its hash, even when told to stop right after the send (C27)', async () => {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    await ask(basicRead(freshFunder()));
    await screenAll(worker);
    await publishCheck(worker, CAMPAIGN);
    vault.advance(ROOT_DELAY);
    await activateCheck(worker, CAMPAIGN);
    const stop = new AbortController();
    const send = vault.sendClaim.bind(vault);
    let broadcast = '';
    vault.sendClaim = async (at, ticket) => {
      broadcast = await send(at, ticket);
      stop.abort();
      return broadcast as `0x${string}`;
    };

    await expect(relayNext(worker, stop.signal)).rejects.toThrow('ran past its time limit');
    const rows = await db.query<{ status: string; tx: string | null }>('SELECT status, tx FROM claim_relays WHERE campaign_id = $1', [CAMPAIGN]);
    expect(rows).toEqual([{ status: 'sent', tx: broadcast }]);
    expect(vault.sent.filter((fn) => fn === 'claim')).toHaveLength(1);
  });

  it('decides a wallet never used on either chain by code alone: hold under A1, on its first try, with no SERV call (C11, C12, C24, C26)', async () => {
    await createCampaign(db, terms());
    const serv = confirmingServ();
    const wallet = await ask(neverUsed());
    const outcomes = await screenAll(onBothChains(deps(new StandInVault(3n * REWARD), serv)));

    expect(outcomes).toEqual([
      { kind: 'decided', campaignId: CAMPAIGN, wallet: wallet.address, action: 'hold', rule: 'A1', slot: null, servRequestId: null },
    ]);
    expect(serv.viaGraph).not.toHaveBeenCalled();
    expect(serv.viaV2).not.toHaveBeenCalled();
    expect(decideWallet).not.toHaveBeenCalled();
    expect(await getAsk(db, CAMPAIGN, wallet.address)).toMatchObject({
      status: 'decided',
      action: 'hold',
      shareBps: 0,
      rule: 'A1',
      reason: 'A1: This wallet has never been used on Ethereum or Base, so there is nothing to screen.',
      citedTxs: [],
      notChecked: ['sharedDepositAddress', 'sweptToSharedCollector', 'claimPaidToOtherAddress', 'fundingBurst', 'passThroughFunding'],
      servRequestId: null,
      slot: null,
      facts: { ageDays: 0, txCount: 0, accountType: 'eoa', funder: null },
    });
  });

  it('gives the same wallet back, deciding nothing and calling no model, on a worker whose Base history is off (C11, C60)', async () => {
    await createCampaign(db, terms());
    const serv = confirmingServ();
    const wallet = await ask(neverUsed());
    const [first] = await screenAll(deps(new StandInVault(3n * REWARD), serv));

    expect(first).toEqual({ kind: 'released', campaignId: CAMPAIGN, wallet: wallet.address, cause: CAMPAIGN_SCREEN_CAUSES.unseen, status: 'queued' });
    expect(await getAsk(db, CAMPAIGN, wallet.address)).toMatchObject({ status: 'failed', servRequestId: null, slot: null, facts: null });
    expect(serv.viaGraph).not.toHaveBeenCalled();
    expect(serv.viaV2).not.toHaveBeenCalled();
    expect(decideWallet).not.toHaveBeenCalled();
  });

  it('still asks the model about a wallet that sent a transaction, has a funder, was not read in full, or does not start on hold under A1', async () => {
    await createCampaign(db, terms());
    await createCampaign(db, terms({ id: 'no-partial', settings: { groupMinSize: 2, funderFanoutMin: 2, allowPartial: false } }));
    const serv = confirmingServ();
    const funder = { address: freshFunder(), kind: 'unknown' as const, fanoutInList: null, hopsTraced: 1 };
    // Each differs from a never-used wallet in one fact. The first four still start on hold under A1 with a hold ceiling.
    const wallets = [
      await ask(neverUsed({ txCountAtSnapshot: 1 })),
      await ask(neverUsed({ firstFunder: funder })),
      await ask(neverUsed({ walletAgeDays: null, missing: [...SINGLE_READ_MISSING, 'firstFunder', 'walletAgeDays'] })),
      await ask(neverUsed({ accountType: 'unknown', missing: [...SINGLE_READ_MISSING, 'firstFunder', 'accountType'] })),
      // Nothing missing: the start is partial under A8, and with partial off it is hold under A8, never A1.
      await ask(neverUsed({ missing: SINGLE_READ_MISSING })),
      await ask(neverUsed({ missing: SINGLE_READ_MISSING }), 'no-partial'),
    ];
    await screenAll(onBothChains(deps(new StandInVault(3n * REWARD), serv)), [CAMPAIGN, 'no-partial']);

    const modelled = new Set(vi.mocked(decideWallet).mock.calls.map(([row]) => row.wallet));
    expect(modelled).toEqual(new Set(wallets.map((wallet) => wallet.address)));
    expect(vi.mocked(serv.viaGraph).mock.calls.length).toBeGreaterThanOrEqual(wallets.length);
  });
});

describe('a post the network lost, settled only on proof', () => {
  const statuses = async () => (await listVersions(db, CAMPAIGN)).map((version) => version.status);
  const later = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1000);
  };

  // One slot holder whose first post the node accepts and then loses: version 1 is sending at nonce 0.
  async function lostPost() {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    await ask(basicRead(freshFunder()));
    await screenAll(worker);
    vault.loseBroadcasts = 1;
    await expect(publishCheck(worker, CAMPAIGN)).rejects.toThrow('not mined yet');
    expect(await listVersions(db, CAMPAIGN)).toMatchObject([{ status: 'sending', postTx: vault.signings[0]?.hash, postNonce: 0 }]);
    return { vault, worker };
  }

  it('(a) signs the same version again at the same nonce once no node has shown it for RESEND_AFTER_SECONDS, recording it first (C27, C32)', async () => {
    const { vault, worker } = await lostPost();
    const first = vault.signings[0]?.hash as `0x${string}`;
    const recordedAtBroadcast: (string | null)[] = [];
    const broadcast = vault.broadcast.bind(vault);
    vault.broadcast = async (signed) => {
      recordedAtBroadcast.push((await latestList(db, CAMPAIGN))?.postTx ?? null);
      return broadcast(signed);
    };

    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [] });
    later(300);
    vault.inPool.add(first);
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [] });
    vault.inPool.delete(first);
    // The sighting at 300 s started the wait again, so neither read sends anything.
    later(301);
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [] });
    later(RESEND_AFTER_SECONDS - 1);
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [] });
    expect(vault.signings).toHaveLength(1);

    later(1);
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ posted: [], unsent: [] });
    const [original, again] = vault.signings;
    expect(again).toMatchObject({ root: original?.root, nonce: original?.nonce });
    expect(recordedAtBroadcast).toEqual([again?.hash]);
    expect(await listVersions(db, CAMPAIGN)).toMatchObject([{ status: 'sending', postTx: again?.hash, postNonce: 0 }]);
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ posted: [1], unsent: [] });
    expect(vault.posted).toEqual([original?.root]);
  });

  it('(b) builds a version again once another transaction used its nonce, and the next publish signs at a fresh nonce', async () => {
    const { vault, worker } = await lostPost();
    vault.takeNonce();
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [] });
    later(CANCEL_MARGIN_SECONDS);
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [1] });
    expect(await statuses()).toEqual(['built']);
    expect(await publishCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'posted', version: 1 });
    expect(vault.signings.map((signing) => signing.nonce)).toEqual([0, 1]);
    expect(await listVersions(db, CAMPAIGN)).toMatchObject([{ status: 'posted' }]);
  });

  it('(c) records the post once when the lost transaction lands after its resend: only one of the two is ever mined', async () => {
    const { vault, worker } = await lostPost();
    await reconcileCheck(worker, CAMPAIGN);
    later(RESEND_AFTER_SECONDS);
    vault.holdBroadcasts = 1;
    await reconcileCheck(worker, CAMPAIGN);
    const [lost, resent] = vault.signings;
    expect(resent?.nonce).toBe(lost?.nonce);
    expect(vault.land(lost?.hash as string)).toBe(true);
    expect(vault.land(resent?.hash as string)).toBe(false);

    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ posted: [1], unsent: [] });
    expect(await listVersions(db, CAMPAIGN)).toMatchObject([
      { status: 'posted', postTx: lost?.hash, claimableAt: Number(CHAIN_START + ROOT_DELAY) },
    ]);
    for (let run = 0; run < 3; run += 1) {
      await reconcileCheck(worker, CAMPAIGN);
      await publishCheck(worker, CAMPAIGN);
    }
    expect(vault.posted).toEqual([lost?.root]);
    expect(vault.signings).toHaveLength(2);
  });

  it('(d) signs no other version while one is sending, even when the slot holders change', async () => {
    const { vault, worker } = await lostPost();
    await ask(basicRead(freshFunder()));
    await screenAll(worker);
    expect(await publishCheck(worker, CAMPAIGN)).toEqual({ kind: 'skipped', reason: SENDING_LIST });
    await reconcileCheck(worker, CAMPAIGN);
    later(RESEND_AFTER_SECONDS);
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [] });
    expect(await publishCheck(worker, CAMPAIGN)).toEqual({ kind: 'skipped', reason: SENDING_LIST });
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ posted: [1] });
    const first = vault.signings[0]?.root;
    expect(vault.signings.map((signing) => signing.root)).toEqual([first, first]);

    vault.advance(ROOT_DELAY);
    await activateCheck(worker, CAMPAIGN);
    expect(await publishCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'posted', version: 2, wallets: 2 });
    expect(vault.signings.map((signing) => signing.root === first)).toEqual([true, true, false]);
  });

  it('(e) signs a lost post again at most MAX_RESENDS times in one process, then says so once and keeps waiting', async () => {
    const { vault, worker } = await lostPost();
    vault.loseBroadcasts = 100;
    for (let round = 0; round < MAX_RESENDS + 3; round += 1) {
      await reconcileCheck(worker, CAMPAIGN);
      later(RESEND_AFTER_SECONDS);
      await reconcileCheck(worker, CAMPAIGN);
    }
    expect(MAX_RESENDS).toBe(5);
    expect(vault.signings).toHaveLength(1 + MAX_RESENDS);
    expect(new Set(vault.signings.map((signing) => signing.nonce))).toEqual(new Set([0]));
    expect(lines.filter((line) => line.includes(`signed again ${MAX_RESENDS} times`))).toHaveLength(1);
    expect(await statuses()).toEqual(['sending']);
    vault.takeNonce();
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [] });
    later(CANCEL_MARGIN_SECONDS);
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [1] });
  });

  it('unsends nothing while the nonce reads used but the receipt and roots reads lag behind a post just mined, and records it once from the next fresh read (C27, C32)', async () => {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    await ask(basicRead(freshFunder()));
    await screenAll(worker);
    const beforePost = vault.view();
    vault.stopAfterPost = 1;
    await expect(publishCheck(worker, CAMPAIGN)).rejects.toThrow('stopped between the post and its record');
    vault.receiptsLag = true;
    vault.staleView = beforePost;
    for (let run = 0; run < 3; run += 1) {
      expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ posted: [], unsent: [] });
      expect(await publishCheck(worker, CAMPAIGN)).toEqual({ kind: 'skipped', reason: SENDING_LIST });
      later(30);
    }
    expect(await statuses()).toEqual(['sending']);
    vault.receiptsLag = false;
    vault.staleView = null;
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ posted: [1], unsent: [] });
    await publishCheck(worker, CAMPAIGN);
    expect(vault.sent.filter((fn) => fn === 'postRoot')).toHaveLength(1);
    expect(vault.posted).toHaveLength(1);
  });

  it('records a resent version posted from the vault when its earlier transaction lands after a restart, posting nothing again', async () => {
    const { vault, worker } = await lostPost();
    await reconcileCheck(worker, CAMPAIGN);
    later(RESEND_AFTER_SECONDS);
    vault.holdBroadcasts = 1;
    await reconcileCheck(worker, CAMPAIGN);
    const [first, resent] = vault.signings;
    const restarted = deps(vault);
    const beforeLanding = vault.view();
    expect(vault.land(first?.hash as string)).toBe(true);
    // The first run after the restart reads the vault from a node that has not seen the landing yet.
    vault.staleView = beforeLanding;
    expect(await reconcileCheck(restarted, CAMPAIGN)).toMatchObject({ posted: [], unsent: [] });
    expect(await publishCheck(restarted, CAMPAIGN)).toEqual({ kind: 'skipped', reason: SENDING_LIST });
    vault.staleView = null;
    expect(await reconcileCheck(restarted, CAMPAIGN)).toMatchObject({ posted: [1], unsent: [] });
    expect(await listVersions(db, CAMPAIGN)).toMatchObject([
      { status: 'posted', postTx: resent?.hash, claimableAt: Number(CHAIN_START + ROOT_DELAY) },
    ]);
    for (let run = 0; run < 3; run += 1) {
      await reconcileCheck(restarted, CAMPAIGN);
      await publishCheck(restarted, CAMPAIGN);
    }
    expect(vault.signings).toHaveLength(2);
    expect(vault.posted).toEqual([first?.root]);
  });

  it('builds a genuinely dead post again only after CANCEL_MARGIN_SECONDS, then signs it at a fresh nonce', async () => {
    const { vault, worker } = await lostPost();
    vault.takeNonce();
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [] });
    later(CANCEL_MARGIN_SECONDS - 1);
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [] });
    expect(await statuses()).toEqual(['sending']);
    later(1);
    expect(await reconcileCheck(worker, CAMPAIGN)).toMatchObject({ unsent: [1] });
    expect(await publishCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'posted', version: 1 });
    expect(vault.signings.map((signing) => signing.nonce)).toEqual([0, 1]);
  });
});

describe('a paused vault and a claim\'s tries', () => {
  const attempts = async () =>
    (await db.query<{ attempts: number }>('SELECT attempts FROM claim_relays WHERE campaign_id = $1', [CAMPAIGN]))[0]?.attempts;

  async function queuedClaim() {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    const wallet = await ask(basicRead(freshFunder()));
    await screenAll(worker);
    await publishCheck(worker, CAMPAIGN);
    vault.advance(ROOT_DELAY);
    expect(await activateCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'queued', added: 1 });
    expect(await attempts()).toBe(0);
    return { vault, worker, wallet };
  }

  it('(g) uses up none of a claim\'s tries while the vault is paused, says so once, and claims it after the unpause (C44)', async () => {
    const { vault, worker, wallet } = await queuedClaim();
    vault.pause();
    for (let run = 0; run < 10; run += 1) {
      expect(await relayNext(worker)).toMatchObject({ kind: 'relayed', status: 'pending', retryAfterSeconds: 600, cause: 'the vault is paused' });
      expect(await relayNext(worker)).toEqual({ kind: 'idle' });
      clock = new Date(clock.getTime() + 600_000);
    }
    expect(await attempts()).toBe(0);
    // The paused flag is read before any simulation, so no claim is even simulated while the vault is paused.
    expect(vault.calls).not.toContain('simulateClaim');
    expect(vault.calls).not.toContain('sendClaim');
    expect(lines.filter((line) => line.includes('the vault is paused'))).toEqual([`relay ${CAMPAIGN}: waiting, the vault is paused`]);
    vault.unpause();
    expect(await relayNext(worker)).toMatchObject({ kind: 'relayed', wallet: wallet.address, status: 'confirmed' });
    expect(vault.paid.get(wallet.address)).toBe(REWARD);
  });

  it('keeps no transaction for a claim confirmed because the wallet had already claimed, so the board cannot link our reverted claim', async () => {
    const { vault, worker, wallet } = await queuedClaim();
    // The wallet claims with the public ticket between our simulation and our send, so our claim is mined and reverts.
    const simulate = vault.simulateClaim.bind(vault);
    vault.simulateClaim = async (address, ticket) => {
      const answer = await simulate(address, ticket);
      vault.claimed.set(ticket.account, REWARD);
      return answer;
    };
    const first = await relayNext(worker);
    expect(first).toMatchObject({ kind: 'relayed', status: 'pending' });
    const sent = first.kind === 'relayed' ? first.tx : null;
    expect(sent).toMatch(/^0x[0-9a-f]{64}$/);
    const stored = async () => (await db.query<{ status: string; tx: string | null }>('SELECT status, tx FROM claim_relays WHERE wallet = $1', [wallet.address]))[0];
    expect(await stored()).toEqual({ status: 'pending', tx: sent });
    expect(await confirmedPayouts(db, CAMPAIGN, [wallet.address])).toEqual([]);

    vault.simulateClaim = simulate;
    clock = new Date(clock.getTime() + 600_000);
    expect(await relayNext(worker)).toMatchObject({ kind: 'relayed', wallet: wallet.address, status: 'confirmed', tx: null });
    expect(await stored()).toEqual({ status: 'confirmed', tx: null });
    expect(await confirmedPayouts(db, CAMPAIGN, [wallet.address])).toEqual([]);
  });

  it('keeps the transaction of a claim whose receipt it read as successful, which is the one the board links', async () => {
    const { worker, wallet } = await queuedClaim();
    const paid = await relayNext(worker);
    expect(paid).toMatchObject({ kind: 'relayed', wallet: wallet.address, status: 'confirmed' });
    const tx = paid.kind === 'relayed' ? paid.tx : null;
    expect(tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await confirmedPayouts(db, CAMPAIGN, [wallet.address])).toEqual([{ wallet: wallet.address, amount: REWARD.toString(), tx }]);
  });

  it('confirms a claim with the very hash whose receipt it read, whatever another step wrote on the relay meanwhile (C61)', async () => {
    const { vault, worker, wallet } = await queuedClaim();
    const late = `0x${'a1'.repeat(32)}`;
    // While our claim waits for its receipt, a step whose lease ran out records its own send on the same relay.
    const confirm = vault.confirmClaim.bind(vault);
    vault.confirmClaim = async (hash) => {
      expect(await markRelay(db, { campaignId: CAMPAIGN, wallet: wallet.address, version: 1 }, { status: 'sent', tx: late }, clock)).toBe('sent');
      return confirm(hash);
    };
    const paid = await relayNext(worker);
    expect(paid).toMatchObject({ kind: 'relayed', wallet: wallet.address, status: 'confirmed' });
    const proven = paid.kind === 'relayed' ? paid.tx : null;
    expect(proven).toMatch(/^0x[0-9a-f]{64}$/);
    expect(proven).not.toBe(late);
    expect(await confirmedPayouts(db, CAMPAIGN, [wallet.address])).toEqual([{ wallet: wallet.address, amount: REWARD.toString(), tx: proven }]);
  });

  it('(g) gives a claim back the same way when its simulation reverts with the pause error a lagging read missed', async () => {
    const { vault, worker, wallet } = await queuedClaim();
    vault.refuseClaims = 'EnforcedPause';
    for (let run = 0; run < 3; run += 1) {
      expect(await relayNext(worker)).toMatchObject({ kind: 'relayed', status: 'pending', retryAfterSeconds: 600 });
      clock = new Date(clock.getTime() + 600_000);
    }
    expect(await attempts()).toBe(0);
    vault.refuseClaims = null;
    expect(await relayNext(worker)).toMatchObject({ kind: 'relayed', wallet: wallet.address, status: 'confirmed' });
  });
});

describe('the day budget for model screenings', () => {
  const askRow = async (wallet: Wallet) =>
    (
      await db.query<{ status: string; attempts: number; retry_at: string | Date | null }>(
        'SELECT status, attempts, retry_at FROM asks WHERE wallet = $1',
        [wallet.address],
      )
    )[0];

  it('(h) runs no model screening past the day budget: the ask keeps its tries and waits past midnight, a never-used wallet is still decided, and the next day screens again (C11, C24, C26)', async () => {
    await createCampaign(db, terms());
    await db.query('INSERT INTO day_counts (day, name, count) VALUES ($1::date, $2, $3)', [
      clock.toISOString().slice(0, 10),
      CAMPAIGN_SCREENINGS_DAY_COUNTER,
      CAMPAIGN_SCREENINGS_DAY_MAX - 1,
    ]);
    const worker = onBothChains(deps(new StandInVault(3n * REWARD)));
    const lastOfDay = await ask(basicRead(freshFunder()));
    const over = await ask(basicRead(freshFunder()));
    const empty = await ask(neverUsed());
    const overToo = await ask(basicRead(freshFunder()));

    const outcomes: ScreenOutcome[] = [];
    for (let n = 0; n < 4; n += 1) outcomes.push(await screenNextAsk(worker));
    expect(outcomes).toEqual([
      expect.objectContaining({ kind: 'decided', wallet: lastOfDay.address, action: 'full' }),
      expect.objectContaining({ kind: 'released', wallet: over.address, cause: CAMPAIGN_SCREEN_CAUSES.dayBudget, status: 'queued' }),
      expect.objectContaining({ kind: 'decided', wallet: empty.address, action: 'hold', servRequestId: null }),
      expect.objectContaining({ kind: 'released', wallet: overToo.address, cause: CAMPAIGN_SCREEN_CAUSES.dayBudget, status: 'queued' }),
    ]);
    expect(decideWallet).toHaveBeenCalledTimes(1);
    expect(await dayCount(db, CAMPAIGN_SCREENINGS_DAY_COUNTER, clock)).toBe(CAMPAIGN_SCREENINGS_DAY_MAX);
    const midnight = Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate() + 1);
    for (const wallet of [over, overToo]) {
      const row = await askRow(wallet);
      expect(row).toMatchObject({ status: 'queued', attempts: 0 });
      expect(new Date(row?.retry_at as string | Date).getTime()).toBeGreaterThan(midnight);
    }
    expect(lines.filter((line) => line.includes(CAMPAIGN_SCREEN_CAUSES.dayBudget))).toHaveLength(1);
    expect(await screenNextAsk(worker)).toEqual({ kind: 'idle' });

    clock = new Date(midnight + 2_000);
    await screenAll(worker);
    for (const wallet of [over, overToo]) expect(await getAsk(db, CAMPAIGN, wallet.address)).toMatchObject({ status: 'decided', action: 'full' });
    expect(decideWallet).toHaveBeenCalledTimes(3);
    expect(await dayCount(db, CAMPAIGN_SCREENINGS_DAY_COUNTER, clock)).toBe(2);
  });

  it('(h) runs no screening when the day counter cannot be read, and gives the ask back with the usual wait (C11)', async () => {
    await createCampaign(db, terms());
    const serv = confirmingServ();
    const broken = (query: Db['query']): Db['query'] =>
      (async (text: string, params?: readonly unknown[]) => {
        if (/day_counts/.test(text)) throw new Error('https://db.example/secret refused the connection');
        return query(text, params);
      }) as Db['query'];
    const unreadable: Db = {
      query: broken(db.query.bind(db)),
      transaction: (work) => db.transaction((tx) => work({ query: broken(tx.query.bind(tx)) })),
      close: () => db.close(),
    };
    const wallet = await ask(basicRead(freshFunder()));
    const outcome = await screenNextAsk({ ...deps(new StandInVault(3n * REWARD), serv), db: unreadable });
    expect(outcome).toMatchObject({ kind: 'released', cause: CAMPAIGN_SCREEN_CAUSES.dayCounter, status: 'queued' });
    expect(decideWallet).not.toHaveBeenCalled();
    expect(serv.viaGraph).not.toHaveBeenCalled();
    expect(await askRow(wallet)).toMatchObject({ status: 'queued', attempts: 1 });
    expect(lines.join('\n')).not.toContain('secret');
  });
});

describe('the record a decision rested on', () => {
  it('(i) stores the flat record the model was given, and for a code-made decision the record it would have been given, and logs neither (C40)', async () => {
    await createCampaign(db, terms());
    const serv = confirmingServ();
    const modelled = await ask(basicRead(freshFunder()));
    const empty = await ask(neverUsed());
    await screenAll(onBothChains(deps(new StandInVault(3n * REWARD), serv)));
    const recordOf = async (wallet: Wallet) =>
      (await db.query<{ record: unknown }>('SELECT record FROM asks WHERE wallet = $1', [wallet.address]))[0]?.record;

    expect(vi.mocked(serv.viaGraph)).toHaveBeenCalledTimes(1);
    expect(await recordOf(modelled)).toEqual(vi.mocked(serv.viaGraph).mock.calls[0]?.[0]);
    expect(await recordOf(empty)).toEqual({
      start_outcome: 'hold',
      start_rule: 'A1',
      wallet_age_days: 0,
      tx_count: 0,
      account_type: 'eoa',
      first_funder_kind: 'none',
      first_funder_claim_wallets: null,
      traced_funder_kind: 'none',
      traced_funder_claim_wallets: null,
      group_size: 0,
      group_same_funder: null,
      group_swept_to_shared_collector: false,
      group_links_made_by_wallet: false,
      shared_deposit_claimants: 0,
      funding_burst_wallets: 0,
      claim_paid_to_other_address: false,
      evidence_tx_hashes: [],
      unreadable_facts: ['firstFunder'],
    });
    expect(lines.join('\n')).not.toContain('start_outcome');
  });
});

describe('a read older than the worker\'s own last write', () => {
  const posts = (vault: StandInVault) => vault.sent.filter((fn) => fn === 'postRoot').length;

  async function postedOnce() {
    await createCampaign(db, terms());
    const vault = new StandInVault(3n * REWARD);
    const worker = deps(vault);
    await ask(basicRead(freshFunder()));
    await screenAll(worker);
    const beforePost = vault.view();
    expect(await publishCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'posted', version: 1 });
    return { vault, worker, beforePost };
  }

  it('cancels nothing on a stale read taken right after its own post, and activates the list on the next fresh read', async () => {
    const { vault, worker, beforePost } = await postedOnce();
    vault.staleView = beforePost;
    expect(await reconcileCheck(worker, CAMPAIGN)).toEqual({ kind: 'reconciled', posted: [], cancelled: [], unsent: [] });
    expect((await listVersions(db, CAMPAIGN)).map((version) => version.status)).toEqual(['posted']);
    expect(lines.some((line) => line.includes('cancelled'))).toBe(false);

    vault.staleView = null;
    vault.advance(ROOT_DELAY);
    expect(await reconcileCheck(worker, CAMPAIGN)).toEqual({ kind: 'reconciled', posted: [], cancelled: [], unsent: [] });
    expect(await activateCheck(worker, CAMPAIGN)).toMatchObject({ kind: 'queued', version: 1, activated: true, added: 1 });
    expect(posts(vault)).toBe(1);
  });

  it('records an owner cancel only once the vault is read at least the margin after the post', async () => {
    const { vault, worker } = await postedOnce();
    vault.cancelPending();
    expect(await reconcileCheck(worker, CAMPAIGN)).toEqual({ kind: 'reconciled', posted: [], cancelled: [], unsent: [] });
    vault.advance(BigInt(CANCEL_MARGIN_SECONDS - 1));
    expect(await reconcileCheck(worker, CAMPAIGN)).toEqual({ kind: 'reconciled', posted: [], cancelled: [], unsent: [] });
    vault.advance(1n);
    expect(await reconcileCheck(worker, CAMPAIGN)).toEqual({ kind: 'reconciled', posted: [], cancelled: [1], unsent: [] });
  });

  it('never proves a cancel for a version with no claimable time or a vault with no known delay', () => {
    const readAt = 2_000_000_000n;
    expect(cancelProven({ claimableAt: null }, 3600n, readAt)).toBe(false);
    expect(cancelProven({ claimableAt: 1_900_000_000 }, null, readAt)).toBe(false);
    const postedAt = 1_900_000_000n;
    const claimableAt = Number(postedAt + 3600n);
    expect(cancelProven({ claimableAt }, 3600n, postedAt + BigInt(CANCEL_MARGIN_SECONDS) - 1n)).toBe(false);
    expect(cancelProven({ claimableAt }, 3600n, postedAt + BigInt(CANCEL_MARGIN_SECONDS))).toBe(true);
  });

  it('posts nothing over its own pending list when a stale read no longer shows it, even with a new slot holder', async () => {
    const { vault, worker, beforePost } = await postedOnce();
    await ask(basicRead(freshFunder()));
    await screenAll(worker);
    vault.staleView = beforePost;
    expect(await publishCheck(worker, CAMPAIGN)).toEqual({ kind: 'skipped', reason: UNSEEN_LIST });
    expect(posts(vault)).toBe(1);
    expect((await listVersions(db, CAMPAIGN)).map((version) => version.status)).toEqual(['posted']);
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
    vault.refuseClaims = 'DepositExhausted';
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
    const writes = vault.calls.filter((call) => call === 'broadcast' || call.startsWith('send'));
    // A post is signed, recorded, then broadcast; the old one-call sendPostRoot is never used by the worker now.
    expect(new Set(writes)).toEqual(new Set(['broadcast', 'sendClaim']));
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

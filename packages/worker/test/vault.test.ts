// Not covered here: the viem port against a real chain, which the local-fork rehearsal runs end to end
// (packages/contracts/script/rehearse.mjs), and the vault's own on-chain checks (packages/contracts/test).
// buildProofRecord and verifyProofRecord are fed hand-built receipts and views: the reads behind them are proven only by
// running `npm run prove:vault -- record` and `-- verify` against Base Sepolia, and nothing here checks how the website
// shows the record.
import fs from 'node:fs';
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  erc20Abi,
  getAddress,
  multicall3Abi,
  type Chain,
  type PublicClient,
  type Transport,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { ChainError, CHAINS, parseAddress, type Address, type MerkleHash } from '@thuli/core';
import { FACTORY_ABI, VAULT_ABI } from '../src/vault/abi.ts';
import { baseSepoliaChain, CLAIMED_BATCH, vaultPort, type Wallet } from '../src/vault/chain.ts';
import {
  buildProofRecord,
  claimants,
  Deployment,
  loadProofEnv,
  loadRpcEnv,
  loadVerifyRpc,
  ProofFailed,
  ProofRecordFile,
  ProofSetupError,
  ProofState,
  PUBLIC_BASE_SEPOLIA_RPC,
  verifyProofRecord,
  type ProofLog,
  type ProofReceipt,
} from '../src/vault/proof.ts';
import {
  buildRoot,
  checkRoot,
  postRoot,
  publishList,
  readPublishedList,
  RootError,
  verifyVault,
  type CampaignRecord,
  type VaultEntry,
  type VaultPort,
  type VaultSnapshot,
  type VaultTerms,
} from '../src/vault/root.ts';

const CONTRACTS = new URL('../../contracts/', import.meta.url);
const fixture = JSON.parse(fs.readFileSync(new URL('test/fixtures/leaf-tree.json', CONTRACTS), 'utf8')) as {
  vault: string;
  root: string;
  entries: { account: string; cumulativeAmount: string }[];
};
const accounts = fixture.entries.map((entry) => entry.account as Address);
const [ALICE, BOB, CAROL, AGENT, OWNER, FACTORY, TOKEN] = accounts as [
  Address, Address, Address, Address, Address, Address, Address,
];
const VAULT = fixture.vault as Address;
const NO_ROOT = `0x${'00'.repeat(32)}` as MerkleHash;
const CAP = 1_000_000n;
const NOW = 1_800_000_000n;
const TERMS: VaultTerms = {
  token: TOKEN,
  owner: OWNER,
  agent: AGENT,
  perWalletCap: CAP,
  endTime: NOW + 7n * 86_400n,
  rootDelay: 3600n,
};
const CAMPAIGN: CampaignRecord = { factory: FACTORY, vault: VAULT, createdAtBlock: 100n, ...TERMS };

interface FakeChain {
  deposited: bigint;
  totalPaid: bigint;
  claimed: Partial<Record<Address, bigint>>;
  agent: Address;
  paused: boolean;
  timestamp: bigint;
  chainId: number;
  created: VaultTerms[];
  recordsPending: boolean;
  activeRoot: MerkleHash;
  pendingRoot: MerkleHash;
}

function fakePort(overrides: Partial<FakeChain> = {}) {
  const chain: FakeChain = {
    deposited: 2_000_000n,
    totalPaid: 0n,
    claimed: {},
    agent: AGENT,
    paused: false,
    timestamp: NOW,
    chainId: 84532,
    created: [TERMS],
    recordsPending: true,
    activeRoot: NO_ROOT,
    pendingRoot: NO_ROOT,
    ...overrides,
  };
  const sent: { root: MerkleHash; declaredTotal: bigint }[] = [];
  const lookups: { factory: Address; vault: Address; block: bigint }[] = [];
  let pending = chain.pendingRoot;
  const port: VaultPort = {
    signer: AGENT,
    chainId: async () => chain.chainId,
    readSnapshot: async (_vault, listed): Promise<VaultSnapshot> => ({
      blockNumber: 200n,
      timestamp: chain.timestamp,
      agent: chain.agent,
      deposited: chain.deposited,
      totalPaid: chain.totalPaid,
      perWalletCap: CAP,
      endTime: TERMS.endTime,
      rootDelay: TERMS.rootDelay,
      paused: chain.paused,
      activeRoot: chain.activeRoot,
      pendingRoot: pending,
      claimed: new Map(listed.map((account) => [account, chain.claimed[account] ?? 0n])),
    }),
    findVaultCreated: async (factory, vault, block) => {
      lookups.push({ factory, vault, block });
      return chain.created;
    },
    sendPostRoot: async (_vault, root, declaredTotal) => {
      sent.push({ root, declaredTotal });
      if (chain.recordsPending) pending = root;
      return { hash: `0x${'ab'.repeat(32)}`, gasUsed: 72_874n };
    },
  };
  return { port, sent, lookups };
}

function snapshot(overrides: Partial<VaultSnapshot> = {}): VaultSnapshot {
  return {
    blockNumber: 200n,
    timestamp: NOW,
    agent: AGENT,
    deposited: 2_000_000n,
    totalPaid: 0n,
    perWalletCap: CAP,
    endTime: TERMS.endTime,
    rootDelay: TERMS.rootDelay,
    paused: false,
    activeRoot: NO_ROOT,
    pendingRoot: NO_ROOT,
    claimed: new Map(),
    ...overrides,
  };
}

const twoWallets: VaultEntry[] = [
  { account: ALICE, cumulativeAmount: 1_000_000n },
  { account: BOB, cumulativeAmount: 500_000n },
];

describe('buildRoot (C28)', () => {
  it('builds the same root as the Foundry fixture the vault paid out against', () => {
    const entries = fixture.entries.map((entry) => ({
      account: entry.account,
      cumulativeAmount: BigInt(entry.cumulativeAmount),
    }));
    expect(buildRoot(entries, fixture.vault, 8453).root).toBe(fixture.root);
  });
});

describe('checkRoot, the server half of C32', () => {
  const claimedOf = (list: VaultEntry[], paid: Partial<Record<Address, bigint>> = {}) =>
    new Map(list.map((entry) => [entry.account as Address, paid[entry.account as Address] ?? 0n]));

  it('declares the capped sum, counting a wallet above the cap at the cap', () => {
    const list = [...twoWallets, { account: OWNER, cumulativeAmount: 50_000_000n }];
    const result = checkRoot(list, [], snapshot({ deposited: 2_500_000n, claimed: claimedOf(list) }));
    expect(result).toEqual({ declaredTotal: 2_500_000n, owed: 2_500_000n });
  });

  it('refuses a list the deposit cannot cover', () => {
    const view = snapshot({ deposited: 1_499_999n, claimed: claimedOf(twoWallets) });
    expect(() => checkRoot(twoWallets, [], view)).toThrow(/may still pay 1500000 base units but the vault has 1499999 left/);
  });

  // Ported from review: Bob is dropped after claiming, so the deposit is gone although the list fits it on paper.
  it('refuses the Alice, Bob and Carol list whose money already left with a dropped wallet', () => {
    const list = [
      { account: ALICE, cumulativeAmount: 100_000_000n },
      { account: CAROL, cumulativeAmount: 100_000_000n },
    ];
    const view = snapshot({
      deposited: 200_000_000n,
      totalPaid: 200_000_000n,
      perWalletCap: 100_000_000n,
      claimed: claimedOf(list, { [ALICE]: 100_000_000n }),
    });
    expect(() => checkRoot(list, [], view)).toThrow(/may still pay 100000000 base units but the vault has 0 left/);
  });

  it('counts only what each listed wallet is still owed', () => {
    const list = [
      { account: ALICE, cumulativeAmount: 100_000_000n },
      { account: CAROL, cumulativeAmount: 100_000_000n },
    ];
    const view = snapshot({
      deposited: 300_000_000n,
      totalPaid: 200_000_000n,
      perWalletCap: 100_000_000n,
      claimed: claimedOf(list, { [ALICE]: 100_000_000n }),
    });
    expect(checkRoot(list, [], view)).toEqual({ declaredTotal: 200_000_000n, owed: 100_000_000n });
  });

  // Ported from review round 3: the snapshot before Bob claims shows nothing paid, yet Bob, dropped from R2, can still
  // claim under the active R1 during R2's delay, after which Carol cannot be paid.
  it('refuses R2, judged with the active R1 it drops Bob from', () => {
    const r1 = [
      { account: ALICE, cumulativeAmount: 100_000_000n },
      { account: BOB, cumulativeAmount: 100_000_000n },
    ];
    const r2 = [
      { account: ALICE, cumulativeAmount: 100_000_000n },
      { account: CAROL, cumulativeAmount: 100_000_000n },
    ];
    const view = snapshot({
      deposited: 200_000_000n,
      perWalletCap: 100_000_000n,
      claimed: new Map([ALICE, BOB, CAROL].map((account) => [account, 0n])),
    });
    expect(checkRoot(r2, [], view).owed).toBe(200_000_000n);
    expect(() => checkRoot(r2, r1, view)).toThrow(/may still pay 300000000 base units but the vault has 200000000 left/);
  });

  it('counts each wallet once, at the larger of its active and new amounts', () => {
    const r1 = [
      { account: ALICE, cumulativeAmount: 100_000_000n },
      { account: BOB, cumulativeAmount: 100_000_000n },
    ];
    const r2 = [
      { account: ALICE, cumulativeAmount: 60_000_000n },
      { account: BOB, cumulativeAmount: 100_000_000n },
      { account: CAROL, cumulativeAmount: 50_000_000n },
    ];
    const view = snapshot({
      deposited: 250_000_000n,
      totalPaid: 40_000_000n,
      perWalletCap: 100_000_000n,
      claimed: new Map([[ALICE, 40_000_000n], [BOB, 0n], [CAROL, 0n]]),
    });
    expect(checkRoot(r2, r1, view)).toEqual({ declaredTotal: 210_000_000n, owed: 210_000_000n });
    expect(() => checkRoot(r2, r1, { ...view, deposited: 249_999_999n })).toThrow(RootError);
  });

  it('refuses a malformed entry in the active list', () => {
    const view = snapshot({ claimed: new Map([[ALICE, 0n]]) });
    const badActive = [{ account: ALICE, cumulativeAmount: -1n }];
    expect(() => checkRoot([{ account: ALICE, cumulativeAmount: 1n }], badActive, view)).toThrow(/active list entry 0/);
  });

  it('refuses a snapshot that is missing a listed wallet', () => {
    expect(() => checkRoot(twoWallets, [], snapshot())).toThrow(/has no claimed amount for/);
  });

  it('refuses every malformed list', () => {
    const bad: VaultEntry[][] = [
      [],
      [{ account: '0x041f77015fe51c51AE49a7f2F3Ff86C641fa190a', cumulativeAmount: 1n }],
      [{ account: ALICE, cumulativeAmount: -1n }],
      [{ account: ALICE, cumulativeAmount: 2n ** 256n }],
      [{ account: ALICE, cumulativeAmount: 1 as unknown as bigint }],
      [
        { account: ALICE, cumulativeAmount: 1n },
        { account: ALICE.toLowerCase(), cumulativeAmount: 2n },
      ],
    ];
    const rich = snapshot({ deposited: 10n ** 30n, claimed: new Map([[ALICE, 0n]]) });
    for (const list of bad) expect(() => checkRoot(list, [], rich)).toThrow(RootError);
    expect(() => checkRoot(twoWallets, [], snapshot({ perWalletCap: 0n, claimed: claimedOf(twoWallets) }))).toThrow(RootError);
  });
});

describe('verifyVault (C32, C39)', () => {
  it('accepts a vault the factory created with exactly the campaign terms, looking in the recorded block', async () => {
    const { port, lookups } = fakePort();
    await verifyVault(port, VAULT, FACTORY, CAMPAIGN);
    expect(lookups).toEqual([{ factory: FACTORY, vault: VAULT, block: 100n }]);
  });

  it('refuses a vault deployed directly, which the factory never logged', async () => {
    const { port } = fakePort({ created: [] });
    await expect(verifyVault(port, VAULT, FACTORY, CAMPAIGN)).rejects.toThrow(/did not create this vault/);
  });

  it('refuses a factory vault whose cap is not the campaign record', async () => {
    const { port } = fakePort({ created: [{ ...TERMS, perWalletCap: 5n * CAP }] });
    await expect(verifyVault(port, VAULT, FACTORY, CAMPAIGN)).rejects.toThrow(/perWalletCap/);
  });

  it('refuses a campaign record that names an agent other than this worker', async () => {
    const { port } = fakePort({ created: [{ ...TERMS, agent: OWNER }] });
    await expect(verifyVault(port, VAULT, FACTORY, { ...CAMPAIGN, agent: OWNER })).rejects.toThrow(/not this worker/);
  });
});

describe('the published list', () => {
  it('round-trips to the same root', () => {
    const text = publishList(twoWallets);
    expect(buildRoot(readPublishedList(text), VAULT, 84532).root).toBe(buildRoot(twoWallets, VAULT, 84532).root);
  });

  it('refuses text that is not a published list', () => {
    for (const text of ['not json', '[{"account":"0x1","cumulativeAmount":"0x10"}]', `[{"account":"${ALICE}","cumulativeAmount":"1","x":1}]`]) {
      expect(() => readPublishedList(text)).toThrow(RootError);
    }
  });
});

describe('postRoot (C30, C32, C39)', () => {
  it('posts the rebuilt root with the capped total and returns the list it was rebuilt from', async () => {
    const { port, sent } = fakePort();
    const posted = await postRoot(port, CAMPAIGN, twoWallets);
    expect(posted.root).toBe(buildRoot(twoWallets, VAULT, 84532).root);
    expect(posted.declaredTotal).toBe(1_500_000n);
    expect(sent).toEqual([{ root: posted.root, declaredTotal: 1_500_000n }]);
    expect(readPublishedList(posted.published)).toEqual(twoWallets);
  });

  it('sends nothing for a vault the factory did not create', async () => {
    const { port, sent } = fakePort({ created: [] });
    await expect(postRoot(port, CAMPAIGN, twoWallets)).rejects.toThrow(/did not create this vault/);
    expect(sent).toEqual([]);
  });

  it('sends nothing when money promised to the list already left with dropped wallets', async () => {
    const { port, sent } = fakePort({ deposited: 2_000_000n, totalPaid: 2_000_000n, claimed: { [ALICE]: 1_000_000n } });
    await expect(postRoot(port, CAMPAIGN, twoWallets)).rejects.toThrow(/may still pay 500000 base units but the vault has 0 left/);
    expect(sent).toEqual([]);
  });

  it('judges the new list together with the active list it was given, and posts when both fit', async () => {
    const active = [{ account: CAROL, cumulativeAmount: 1_000_000n }];
    const activeRoot = buildRoot(active, VAULT, 84532).root;
    const tight = fakePort({ activeRoot, deposited: 2_000_000n });
    await expect(postRoot(tight.port, CAMPAIGN, twoWallets, { activePublished: publishList(active) })).rejects.toThrow(
      /may still pay 2500000 base units but the vault has 2000000 left/,
    );
    expect(tight.sent).toEqual([]);
    const roomy = fakePort({ activeRoot, deposited: 2_500_000n });
    const posted = await postRoot(roomy.port, CAMPAIGN, twoWallets, { activePublished: publishList(active) });
    expect(posted.declaredTotal).toBe(1_500_000n);
  });

  it('sends nothing unless the given active list rebuilds the vault active root exactly', async () => {
    const active = [{ account: CAROL, cumulativeAmount: 1_000_000n }];
    const activeRoot = buildRoot(active, VAULT, 84532).root;
    const missing = fakePort({ activeRoot });
    await expect(postRoot(missing.port, CAMPAIGN, twoWallets)).rejects.toThrow(/rebuilds the vault active root/);
    const wrong = fakePort({ activeRoot });
    const other = publishList([{ account: CAROL, cumulativeAmount: 999_999n }]);
    await expect(postRoot(wrong.port, CAMPAIGN, twoWallets, { activePublished: other })).rejects.toThrow(
      /rebuilds the vault active root/,
    );
    const none = fakePort();
    await expect(postRoot(none.port, CAMPAIGN, twoWallets, { activePublished: publishList(active) })).rejects.toThrow(
      /no active root/,
    );
    expect([...missing.sent, ...wrong.sent, ...none.sent]).toEqual([]);
  });

  it('sends nothing while another root is pending, since it could activate first and pay an unchecked list', async () => {
    const { port, sent } = fakePort({ pendingRoot: fixture.root as MerkleHash });
    await expect(postRoot(port, CAMPAIGN, twoWallets)).rejects.toThrow(/still pending/);
    expect(sent).toEqual([]);
  });

  it('sends nothing while the vault is paused, or when the root could not pay before the end', async () => {
    const paused = fakePort({ paused: true });
    await expect(postRoot(paused.port, CAMPAIGN, twoWallets)).rejects.toThrow(/paused/);
    const late = fakePort({ timestamp: TERMS.endTime - TERMS.rootDelay });
    await expect(postRoot(late.port, CAMPAIGN, twoWallets)).rejects.toThrow(/could not pay before the end/);
    expect([...paused.sent, ...late.sent]).toEqual([]);
  });

  it('sends nothing when the list changed between checking and signing', async () => {
    const { port, sent } = fakePort();
    let reads = 0;
    const shifting = {
      account: ALICE,
      get cumulativeAmount() {
        reads += 1;
        return reads === 1 ? 1_000_000n : 2_000_000n;
      },
    };
    await expect(postRoot(port, CAMPAIGN, [shifting])).rejects.toThrow(/rebuilt from the published list differs/);
    expect(sent).toEqual([]);
  });

  it('sends nothing when the rebuilt root is not the expected one', async () => {
    const { port, sent } = fakePort();
    await expect(postRoot(port, CAMPAIGN, twoWallets, { expectedRoot: fixture.root })).rejects.toThrow(/not the expected root/);
    expect(sent).toEqual([]);
  });

  it('sends nothing from a key that is not the vault agent', async () => {
    const { port, sent } = fakePort({ agent: OWNER });
    await expect(postRoot(port, CAMPAIGN, twoWallets)).rejects.toThrow(/not the vault agent/);
    expect(sent).toEqual([]);
  });

  it('sends nothing on a chain Thuli does not run on (C2)', async () => {
    const { port, sent } = fakePort({ chainId: 31337 });
    await expect(postRoot(port, CAMPAIGN, twoWallets)).rejects.toThrow(ChainError);
    expect(sent).toEqual([]);
  });

  it('fails loudly when the vault does not show the posted root as pending', async () => {
    const { port } = fakePort({ recordsPending: false });
    await expect(postRoot(port, CAMPAIGN, twoWallets)).rejects.toThrow(/does not show the posted root/);
  });
});

describe('the proof helpers', () => {
  const seed = `0x${'5e'.repeat(32)}` as const;

  it('derives the same two distinct claimants from a seed, and others from another seed', () => {
    const first = claimants(seed);
    expect(claimants(seed)).toEqual(first);
    expect(first.a).not.toBe(first.b);
    expect(claimants(`0x${'5f'.repeat(32)}`).a).not.toBe(first.a);
  });

  it('names missing variables without printing any value (C40)', () => {
    const secret = `0x${'12'.repeat(32)}`;
    try {
      loadProofEnv({ WORKER_PRIVATE_KEY: secret, PAYER_PRIVATE_KEY: 'oops' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProofSetupError);
      expect(String(error)).toMatch(/PAYER_PRIVATE_KEY, BASE_SEPOLIA_RPC_URL/);
      expect(String(error)).not.toContain(secret);
    }
  });

  it('takes an RPC override only for a local fork, and never one key for both roles', () => {
    const keys = { WORKER_PRIVATE_KEY: `0x${'12'.repeat(32)}`, PAYER_PRIVATE_KEY: `0x${'34'.repeat(32)}` };
    expect(loadProofEnv(keys, 'http://127.0.0.1:8546').rehearsal).toBe(true);
    expect(() => loadProofEnv(keys, 'https://sepolia.base.org')).toThrow(ProofSetupError);
    expect(() => loadProofEnv({ ...keys, PAYER_PRIVATE_KEY: keys.WORKER_PRIVATE_KEY }, 'http://127.0.0.1:8546')).toThrow(
      /must be different keys/,
    );
  });

  it('refuses a state file or deployment record for another chain or with extra fields', () => {
    expect(Deployment.safeParse({ chainId: 8453, factory: VAULT }).success).toBe(false);
    expect(ProofState.safeParse({ chainId: 84532, extra: true }).success).toBe(false);
  });

  it('reads only the RPC for the record phase, naming it without its value when it is unusable (C40)', () => {
    expect(loadRpcEnv({ BASE_SEPOLIA_RPC_URL: ' https://sepolia.base.org ' })).toBe('https://sepolia.base.org');
    try {
      loadRpcEnv({ BASE_SEPOLIA_RPC_URL: 'http://rpc.example/secret-path-123' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProofSetupError);
      expect(String(error)).toMatch(/BASE_SEPOLIA_RPC_URL/);
      expect(String(error)).not.toContain('secret-path-123');
    }
  });

  it('lets verify fall back to the public endpoint only when the RPC is unset, never when it is set wrong (C40)', () => {
    expect(loadVerifyRpc({})).toEqual({ rpcUrl: PUBLIC_BASE_SEPOLIA_RPC, usesPublic: true });
    expect(loadVerifyRpc({ BASE_SEPOLIA_RPC_URL: '  ' })).toEqual({ rpcUrl: PUBLIC_BASE_SEPOLIA_RPC, usesPublic: true });
    expect(loadVerifyRpc({ BASE_SEPOLIA_RPC_URL: 'https://rpc.example/k' })).toEqual({ rpcUrl: 'https://rpc.example/k', usesPublic: false });
    expect(() => loadVerifyRpc({ BASE_SEPOLIA_RPC_URL: 'http://rpc.example/secret-path-123' })).toThrow(/^Missing or invalid in \.env: BASE_SEPOLIA_RPC_URL/);
  });
});

describe('the proof record', () => {
  const SEED = `0x${'6a'.repeat(32)}` as const;
  const { a: PAID, b: REFUSED } = claimants(SEED);
  const USDC = parseAddress(CHAINS['base-sepolia'].usdc);
  const ROOT = buildRoot([{ account: PAID, cumulativeAmount: CAP }], VAULT, 84532).root;
  const CLAIMABLE_AT = Number(NOW) + 3600;
  const HASH = {
    createVault: `0x${'c1'.repeat(32)}`,
    approve: `0x${'c2'.repeat(32)}`,
    deposit: `0x${'c3'.repeat(32)}`,
    postRoot: `0x${'c4'.repeat(32)}`,
    claim: `0x${'c5'.repeat(32)}`,
  } as const;
  type Step = keyof typeof HASH;
  // encodeEventTopics is typed for log filters, where a topic may be null or a list; every indexed argument is set here.
  const filled = (topics: readonly unknown[]) => topics as ProofLog['topics'];

  const vaultCreated = (): ProofLog => ({
    address: FACTORY,
    topics: filled(encodeEventTopics({ abi: FACTORY_ABI, eventName: 'VaultCreated', args: { vault: VAULT, owner: OWNER, agent: AGENT } })),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'uint32' }], [USDC, CAP, TERMS.endTime, 3600]),
  });
  const rootPosted = (claimableAt = CLAIMABLE_AT): ProofLog => ({
    address: VAULT,
    topics: filled(encodeEventTopics({ abi: VAULT_ABI, eventName: 'RootPosted', args: { root: ROOT } })),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }], [CAP, BigInt(claimableAt)]),
  });
  // The first claim after the delay also activates the root, so a real claim receipt carries this before Claimed.
  const rootActivated = (): ProofLog => ({
    address: VAULT,
    topics: filled(encodeEventTopics({ abi: VAULT_ABI, eventName: 'RootActivated', args: { root: ROOT } })),
    data: '0x',
  });
  const claimedEvent = (account: Address, amount: bigint): ProofLog => ({
    address: VAULT,
    topics: filled(encodeEventTopics({ abi: VAULT_ABI, eventName: 'Claimed', args: { account } })),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [amount, amount]),
  });
  const transfer = (from: Address, to: Address, value: bigint): ProofLog => ({
    address: USDC,
    topics: filled(encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } })),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  });

  function goodInput() {
    const receipt = (step: Step, from: Address, to: Address, block: bigint, gasUsed: bigint, logs: ProofLog[]): ProofReceipt => ({
      transactionHash: HASH[step],
      status: 'success',
      blockNumber: block,
      gasUsed,
      from,
      to,
      logs,
    });
    const state = ProofState.parse({
      chainId: 84532,
      factory: FACTORY,
      vault: VAULT,
      owner: OWNER,
      agent: AGENT,
      seed: SEED,
      root: ROOT,
      published: publishList([{ account: PAID, cumulativeAmount: CAP }]),
      createdAtBlock: 100,
      endTime: Number(TERMS.endTime),
      claimableAt: CLAIMABLE_AT,
      transactions: [
        { label: 'createVault', hash: HASH.createVault, from: OWNER, gasUsed: '1686371' },
        { label: 'approve', hash: HASH.approve, from: OWNER, gasUsed: '55437' },
        { label: 'deposit', hash: HASH.deposit, from: OWNER, gasUsed: '100114' },
        { label: 'postRoot', hash: HASH.postRoot, from: AGENT, gasUsed: '75112' },
        { label: 'claim A', hash: HASH.claim, from: AGENT, gasUsed: '145907' },
      ],
    });
    return {
      state,
      deployment: Deployment.parse({ chainId: 84532, factory: FACTORY.toLowerCase() }),
      chain: {
        receipts: [
          receipt('createVault', OWNER, FACTORY, 100n, 1_686_371n, [vaultCreated()]),
          receipt('approve', OWNER, USDC, 101n, 55_437n, []),
          receipt('deposit', OWNER, VAULT, 102n, 100_114n, [transfer(OWNER, VAULT, 2n * CAP)]),
          receipt('postRoot', AGENT, VAULT, 103n, 75_112n, [rootPosted()]),
          receipt('claim', AGENT, VAULT, 2_000n, 145_907n, [rootActivated(), claimedEvent(PAID, CAP), transfer(VAULT, PAID, CAP)]),
        ],
        vaultState: {
          token: USDC,
          owner: OWNER,
          agent: AGENT,
          perWalletCap: CAP,
          rootDelay: 3600,
          deposited: 2n * CAP,
          totalPaid: CAP,
          activeRoot: ROOT as string,
        },
        claimedByPaid: CAP,
        refusedSimulation: 'InvalidProof',
      },
      now: new Date('2026-11-11T06:00:00.000Z'),
    };
  }
  type Input = ReturnType<typeof goodInput>;
  const receiptOf = (input: Input, step: Step) => input.chain.receipts.find((receipt) => receipt.transactionHash === HASH[step]) as ProofReceipt;

  it('C32 seen from outside: the record root is the vault active root and the paid amount is what the vault says it paid', () => {
    const input = goodInput();
    const record = buildProofRecord(input);
    expect(record).toEqual({
      schema: 1,
      network: 'base-sepolia',
      chainId: 84532,
      explorer: 'https://sepolia.basescan.org',
      factory: FACTORY,
      vault: VAULT,
      token: USDC,
      owner: OWNER,
      agent: AGENT,
      perWalletCap: '1000000',
      rootDelaySeconds: 3600,
      root: ROOT,
      claimableAt: CLAIMABLE_AT,
      paid: { account: PAID, amount: '1000000' },
      refused: { account: REFUSED, error: 'InvalidProof' },
      deposited: '2000000',
      totalPaid: '1000000',
      transactions: [
        { label: 'createVault', hash: HASH.createVault, block: 100, gasUsed: 1_686_371, from: OWNER },
        { label: 'approve', hash: HASH.approve, block: 101, gasUsed: 55_437, from: OWNER },
        { label: 'deposit', hash: HASH.deposit, block: 102, gasUsed: 100_114, from: OWNER },
        { label: 'postRoot', hash: HASH.postRoot, block: 103, gasUsed: 75_112, from: AGENT },
        { label: 'claim', hash: HASH.claim, block: 2000, gasUsed: 145_907, from: AGENT },
      ],
      recordedAt: '2026-11-11T06:00:00.000Z',
    });
    expect(record.root).toBe(input.chain.vaultState.activeRoot);
    expect(BigInt(record.paid.amount)).toBe(input.chain.vaultState.totalPaid);
    expect(BigInt(record.paid.amount)).toBe(input.chain.claimedByPaid);
  });

  it('C1: every address in the record is in the one checksummed form, even when the state and the chain give lowercase', () => {
    const input = goodInput();
    const lower = (address: string) => address.toLowerCase() as Address;
    const state = { ...input.state, factory: lower(FACTORY), vault: lower(VAULT), owner: lower(OWNER), agent: lower(AGENT) };
    for (const receipt of input.chain.receipts) {
      receipt.from = lower(receipt.from);
      receipt.to = lower(receipt.to as string);
      receipt.logs = receipt.logs.map((log) => ({ ...log, address: lower(log.address) }));
    }
    const view = input.chain.vaultState;
    Object.assign(view, { token: lower(view.token), owner: lower(view.owner), agent: lower(view.agent) });

    const record = buildProofRecord({ ...input, state });
    const addresses = [...JSON.stringify(record).matchAll(/\b0x[0-9a-fA-F]{40}\b/g)].map(([hex]) => hex);
    expect(addresses).toHaveLength(12);
    for (const address of addresses) expect(address).toBe(getAddress(address));
    expect(record.transactions.map((tx) => tx.from)).toEqual([OWNER, OWNER, OWNER, AGENT, AGENT]);
  });

  describe('the record is refused unless the chain agrees with every line', () => {
    const refusals: [string, (input: Input) => void, RegExp][] = [
      ['a failed receipt', (input) => void (receiptOf(input, 'deposit').status = 'reverted'), /deposit transaction 0x[0-9a-f]+ did not succeed/],
      ['a wrong sender', (input) => void (receiptOf(input, 'claim').from = OWNER), /claim transaction was sent by 0x[0-9a-fA-F]+, not the agent/],
      [
        'a missing Claimed event',
        (input) => void (receiptOf(input, 'claim').logs = [rootActivated(), transfer(VAULT, PAID, CAP)]),
        /does not hold one vault Claimed event paying claimant A 1000000/,
      ],
      [
        'a Transfer of the wrong amount',
        (input) => void (receiptOf(input, 'claim').logs = [rootActivated(), claimedEvent(PAID, CAP), transfer(VAULT, PAID, CAP - 1n)]),
        /does not hold one USDC Transfer of 1000000 from the vault to claimant A/,
      ],
      ['a totalPaid that disagrees', (input) => void (input.chain.vaultState.totalPaid = 2n * CAP), /totalPaid is 2000000, not the 1000000/],
      ['a root that disagrees', (input) => void (input.chain.vaultState.activeRoot = `0x${'99'.repeat(32)}`), /active root is not the saved root/],
      ['a refusal that is not InvalidProof', (input) => void (input.chain.refusedSimulation = 'NotAgent'), /not refused with InvalidProof \(got NotAgent\)/],
      ['a claimant B static call that succeeded', (input) => void (input.chain.refusedSimulation = 'success'), /\(got success\)/],
      ['a claimed() that disagrees', (input) => void (input.chain.claimedByPaid = 0n), /claimed\(claimant A\) is 0/],
      ['a state missing a transaction', (input) => void input.state.transactions.pop(), /lists 4 transactions/],
      ['a transaction the chain does not know', (input) => void input.chain.receipts.splice(1, 1), /no receipt for the approve transaction/],
      ['a transaction sent to another contract', (input) => void (receiptOf(input, 'deposit').to = TOKEN), /deposit transaction was not sent to the vault/],
      ['a deployment record naming another factory', (input) => void (input.deployment = Deployment.parse({ chainId: 84532, factory: TOKEN })), /another factory/],
      ['a createVault without the factory event', (input) => void (receiptOf(input, 'createVault').logs = []), /VaultCreated/],
      ['a RootPosted for another claimableAt', (input) => void (receiptOf(input, 'postRoot').logs = [rootPosted(CLAIMABLE_AT + 1)]), /RootPosted/],
      [
        'a saved list that does not rebuild the saved root',
        (input) => void (input.state.published = publishList([{ account: PAID, cumulativeAmount: CAP - 1n }])),
        /does not rebuild to the saved root/,
      ],
      ['a vault on another token', (input) => void (input.chain.vaultState.token = TOKEN), /token is not Base Sepolia USDC/],
      ['a vault with another agent', (input) => void (input.chain.vaultState.agent = OWNER), /agent is not the saved agent/],
      ['a vault with another cap', (input) => void (input.chain.vaultState.perWalletCap = 2n * CAP), /perWalletCap is 2000000/],
    ];

    it.each(refusals)('refuses %s', (_name, spoil, failure) => {
      const input = goodInput();
      spoil(input);
      expect(() => buildProofRecord(input)).toThrow(ProofFailed);
      expect(() => buildProofRecord(input)).toThrow(failure);
    });
  });

  describe('the record is checkable by anyone with an RPC URL and the two committed files', () => {
    // The record goes through JSON and the committed file's shape, the way verify reads it from disk.
    function verifyInput() {
      const input = goodInput();
      const record = ProofRecordFile.parse(JSON.parse(JSON.stringify(buildProofRecord(input))));
      const chain = { receipts: input.chain.receipts, vaultState: input.chain.vaultState, claimedByPaid: CAP, claimedByRefused: 0n };
      return { record, deployment: input.deployment, chain };
    }
    type Verify = ReturnType<typeof verifyInput>;
    const chainReceipt = (v: Verify, step: Step) => v.chain.receipts.find((receipt) => receipt.transactionHash === HASH[step]) as ProofReceipt;
    const recordTx = (v: Verify, step: Step) => v.record.transactions.find((tx) => tx.label === step) as Verify['record']['transactions'][number];
    const failedChecks = (v: Verify) =>
      verifyProofRecord(v.record, v.deployment, v.chain)
        .filter((check) => !check.pass)
        .map((check) => check.name);

    it('passes every check, in a fixed order, on the record buildProofRecord wrote', () => {
      const v = verifyInput();
      const checks = verifyProofRecord(v.record, v.deployment, v.chain);
      expect(checks.map((check) => check.name)).toEqual([
        'factory',
        'createVault transaction',
        'approve transaction',
        'deposit transaction',
        'postRoot transaction',
        'claim transaction',
        'VaultCreated',
        'RootPosted',
        'Claimed',
        'USDC Transfer',
        'vault terms',
        'totalPaid',
        'claimed(paid)',
        'claimed(refused)',
      ]);
      expect(checks.filter((check) => !check.pass)).toEqual([]);
      expect(checks.find((check) => check.name === 'claim transaction')?.detail).toBe(
        `${HASH.claim} succeeded in block 2000, sent by the agent ${AGENT}, 145907 gas`,
      );
    });

    it('still passes once later claims have raised the two running totals', () => {
      const v = verifyInput();
      v.chain.vaultState.totalPaid = 3n * CAP;
      v.chain.claimedByPaid = 2n * CAP;
      expect(failedChecks(v)).toEqual([]);
    });

    it('reads the committed record file through the same shape, and refuses a file with any other field', () => {
      const committed = JSON.parse(fs.readFileSync(new URL('deployments/base-sepolia-proof.json', CONTRACTS), 'utf8')) as Record<string, unknown>;
      expect(ProofRecordFile.safeParse(committed).success).toBe(true);
      expect(ProofRecordFile.safeParse({ ...committed, seed: `0x${'6a'.repeat(32)}` }).success).toBe(false);
    });

    it('fails the transaction and both checks read from its receipt when a recorded hash is not on chain', () => {
      const v = verifyInput();
      recordTx(v, 'claim').hash = `0x${'0e'.repeat(32)}`;
      expect(failedChecks(v)).toEqual(['claim transaction', 'Claimed', 'USDC Transfer']);
    });

    const failures: [string, string, (v: Verify) => void][] = [
      ['factory', 'a record naming another factory', (v) => void (v.record.factory = TOKEN)],
      ['createVault transaction', 'a receipt that reverted', (v) => void (chainReceipt(v, 'createVault').status = 'reverted')],
      ['approve transaction', 'a receipt in another block', (v) => void (chainReceipt(v, 'approve').blockNumber += 1n)],
      ['deposit transaction', 'a receipt from another sender', (v) => void (chainReceipt(v, 'deposit').from = AGENT)],
      ['postRoot transaction', 'a receipt with other gas used', (v) => void (chainReceipt(v, 'postRoot').gasUsed += 1n)],
      ['claim transaction', 'a record naming the owner as the claim sender', (v) => void (recordTx(v, 'claim').from = OWNER)],
      ['VaultCreated', 'a createVault receipt without the event', (v) => void (chainReceipt(v, 'createVault').logs = [])],
      ['RootPosted', 'a record with another claimableAt', (v) => void (v.record.claimableAt += 1)],
      ['Claimed', 'a claim receipt without Claimed', (v) => void (chainReceipt(v, 'claim').logs = [rootActivated(), transfer(VAULT, PAID, CAP)])],
      [
        'USDC Transfer',
        'a Transfer of another amount',
        (v) => void (chainReceipt(v, 'claim').logs = [rootActivated(), claimedEvent(PAID, CAP), transfer(VAULT, PAID, CAP - 1n)]),
      ],
      ['vault terms', 'a vault with another delay', (v) => void (v.chain.vaultState.rootDelay = 7200)],
      ['vault terms', 'a vault with another agent', (v) => void (v.chain.vaultState.agent = OWNER)],
      ['totalPaid', 'a vault that paid less than recorded', (v) => void (v.chain.vaultState.totalPaid = CAP - 1n)],
      ['claimed(paid)', 'a paid account that claimed less than recorded', (v) => void (v.chain.claimedByPaid = CAP - 1n)],
      ['claimed(refused)', 'a refused account that was paid', (v) => void (v.chain.claimedByRefused = 1n)],
    ];

    it.each(failures)('fails only the %s check on %s', (check, _what, spoil) => {
      const v = verifyInput();
      spoil(v);
      expect(failedChecks(v)).toEqual([check]);
    });
  });
});

describe('the viem port reads (C41)', () => {
  it('reads 100,000 wallets 1,000 per call, one request at a time, every call at the pinned block', async () => {
    const pinned = '0x10';
    let inFlight = 0;
    let peak = 0;
    let batches = 0;
    const blockTags = new Set<string>();
    const vaultState = {
      token: TOKEN,
      owner: OWNER,
      agent: AGENT,
      perWalletCap: CAP,
      endTime: TERMS.endTime,
      rootDelay: 3600,
      deposited: 2_000_000n,
      totalPaid: 0n,
      activeRoot: NO_ROOT,
      pendingRoot: NO_ROOT,
      pendingClaimableAt: 0n,
      paused: false,
    };
    const transport = custom({
      async request({ method, params }: { method: string; params: unknown }) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (method === 'eth_chainId') return '0x14a34';
          if (method === 'eth_getBlockByNumber') {
            return { number: pinned, timestamp: '0x6b4a8864', hash: `0x${'11'.repeat(32)}`, transactions: [] };
          }
          if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
          const [call, block] = params as [{ to: string; data: `0x${string}` }, string];
          blockTags.add(block);
          if (call.to.toLowerCase() === VAULT.toLowerCase()) {
            return encodeFunctionResult({ abi: VAULT_ABI, functionName: 'state', result: vaultState });
          }
          batches += 1;
          const { args } = decodeFunctionData({ abi: multicall3Abi, data: call.data });
          const calls = args[0] as readonly unknown[];
          const seven = encodeAbiParameters([{ type: 'uint256' }], [7n]);
          return encodeFunctionResult({
            abi: multicall3Abi,
            functionName: 'aggregate3',
            result: calls.map(() => ({ success: true, returnData: seven })),
          });
        } finally {
          inFlight -= 1;
        }
      },
    });
    const client = createPublicClient({ chain: baseSepoliaChain('http://127.0.0.1:1'), transport }) as PublicClient<
      Transport,
      Chain
    >;
    const port = vaultPort(client, { account: { address: AGENT } } as unknown as Wallet);
    const wallets = Array.from({ length: 100_000 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as Address);

    const read = await port.readSnapshot(VAULT, wallets);
    expect(peak).toBe(1);
    expect(batches).toBe(100_000 / CLAIMED_BATCH);
    expect([...blockTags]).toEqual([pinned]);
    expect(read.blockNumber).toBe(16n);
    expect(read.claimed.size).toBe(100_000);
    expect(read.claimed.get(wallets[99_999] as Address)).toBe(7n);
  }, 60_000);
});

const artifact = (name: string) => new URL(`out/${name}.sol/${name}.json`, CONTRACTS);

describe.skipIf(!fs.existsSync(artifact('ThuliVault')))('the worker ABI', () => {
  it('is the compiler ABI of the deployed contracts', () => {
    const read = (name: string) => JSON.parse(fs.readFileSync(artifact(name), 'utf8')).abi;
    expect(VAULT_ABI).toEqual(read('ThuliVault'));
    expect(FACTORY_ABI).toEqual(read('ThuliVaultFactory'));
  });
});

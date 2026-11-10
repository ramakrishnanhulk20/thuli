// Not covered here: the viem port against a real chain, which the local-fork rehearsal runs end to end
// (packages/contracts/script/rehearse.mjs), and the vault's own on-chain checks (packages/contracts/test).
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ChainError, type Address, type MerkleHash } from '@thuli/core';
import { FACTORY_ABI, VAULT_ABI } from '../src/vault/abi.ts';
import { claimants, Deployment, loadProofEnv, ProofSetupError, ProofState } from '../src/vault/proof.ts';
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
    ...overrides,
  };
  const sent: { root: MerkleHash; declaredTotal: bigint }[] = [];
  const lookups: { factory: Address; vault: Address; block: bigint }[] = [];
  let pending = NO_ROOT;
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
    const result = checkRoot(list, snapshot({ deposited: 2_500_000n, claimed: claimedOf(list) }));
    expect(result).toEqual({ declaredTotal: 2_500_000n, owed: 2_500_000n });
  });

  it('refuses a list the deposit cannot cover', () => {
    const view = snapshot({ deposited: 1_499_999n, claimed: claimedOf(twoWallets) });
    expect(() => checkRoot(twoWallets, view)).toThrow(/owes 1500000 base units but the vault has 1499999 left/);
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
    expect(() => checkRoot(list, view)).toThrow(/owes 100000000 base units but the vault has 0 left/);
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
    expect(checkRoot(list, view)).toEqual({ declaredTotal: 200_000_000n, owed: 100_000_000n });
  });

  it('refuses a snapshot that is missing a listed wallet', () => {
    expect(() => checkRoot(twoWallets, snapshot())).toThrow(/has no claimed amount for/);
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
    for (const list of bad) expect(() => checkRoot(list, rich)).toThrow(RootError);
    expect(() => checkRoot(twoWallets, snapshot({ perWalletCap: 0n, claimed: claimedOf(twoWallets) }))).toThrow(RootError);
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
    await expect(postRoot(port, CAMPAIGN, twoWallets)).rejects.toThrow(/owes 500000 base units but the vault has 0 left/);
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
});

const artifact = (name: string) => new URL(`out/${name}.sol/${name}.json`, CONTRACTS);

describe.skipIf(!fs.existsSync(artifact('ThuliVault')))('the worker ABI', () => {
  it('is the compiler ABI of the deployed contracts', () => {
    const read = (name: string) => JSON.parse(fs.readFileSync(artifact(name), 'utf8')).abi;
    expect(VAULT_ABI).toEqual(read('ThuliVault'));
    expect(FACTORY_ABI).toEqual(read('ThuliVaultFactory'));
  });
});

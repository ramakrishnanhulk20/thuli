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
  type VaultEntry,
  type VaultPort,
} from '../src/vault/root.ts';

const CONTRACTS = new URL('../../contracts/', import.meta.url);
const fixture = JSON.parse(fs.readFileSync(new URL('test/fixtures/leaf-tree.json', CONTRACTS), 'utf8')) as {
  vault: string;
  root: string;
  entries: { account: string; cumulativeAmount: string }[];
};
const accounts = fixture.entries.map((entry) => entry.account as Address);
const [ALICE, BOB, AGENT, OWNER] = accounts as [Address, Address, Address, Address];
const VAULT = fixture.vault as Address;
const NO_ROOT = `0x${'00'.repeat(32)}` as MerkleHash;
const CAP = 1_000_000n;

function fakePort(options: { deposited?: bigint; agent?: Address; chainId?: number; recordsPending?: boolean } = {}) {
  const sent: { root: MerkleHash; declaredTotal: bigint }[] = [];
  let pending = NO_ROOT;
  const port: VaultPort = {
    signer: AGENT,
    chainId: async () => options.chainId ?? 84532,
    readState: async () => ({
      agent: options.agent ?? AGENT,
      deposited: options.deposited ?? 2_000_000n,
      perWalletCap: CAP,
      pendingRoot: pending,
    }),
    sendPostRoot: async (_vault, root, declaredTotal) => {
      sent.push({ root, declaredTotal });
      if (options.recordsPending ?? true) pending = root;
      return { hash: `0x${'ab'.repeat(32)}`, gasUsed: 72_874n };
    },
  };
  return { port, sent };
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
  it('declares the capped sum, counting a wallet above the cap at the cap', () => {
    const list = [...twoWallets, { account: OWNER, cumulativeAmount: 50_000_000n }];
    expect(checkRoot(list, 2_500_000n, CAP).declaredTotal).toBe(2_500_000n);
  });

  it('refuses a list the deposit cannot cover', () => {
    expect(() => checkRoot(twoWallets, 1_499_999n, CAP)).toThrow(/can pay 1500000 base units but the vault holds 1499999/);
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
    for (const list of bad) expect(() => checkRoot(list, 10n ** 30n, CAP)).toThrow(RootError);
    expect(() => checkRoot(twoWallets, 10n ** 30n, 0n)).toThrow(RootError);
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

describe('postRoot (C30, C32)', () => {
  it('posts the rebuilt root with the capped total and returns the list it was rebuilt from', async () => {
    const { port, sent } = fakePort();
    const posted = await postRoot(port, VAULT, twoWallets);
    expect(posted.root).toBe(buildRoot(twoWallets, VAULT, 84532).root);
    expect(posted.declaredTotal).toBe(1_500_000n);
    expect(sent).toEqual([{ root: posted.root, declaredTotal: 1_500_000n }]);
    expect(readPublishedList(posted.published)).toEqual(twoWallets);
  });

  it('sends nothing when the list changed between checking and signing', async () => {
    const { port, sent } = fakePort();
    let reads = 0;
    const shifting = { account: ALICE, get cumulativeAmount() {
      reads += 1;
      return reads === 1 ? 1_000_000n : 2_000_000n;
    } };
    await expect(postRoot(port, VAULT, [shifting])).rejects.toThrow(/rebuilt from the published list differs/);
    expect(sent).toEqual([]);
  });

  it('sends nothing when the rebuilt root is not the expected one', async () => {
    const { port, sent } = fakePort();
    await expect(postRoot(port, VAULT, twoWallets, { expectedRoot: fixture.root })).rejects.toThrow(/not the expected root/);
    expect(sent).toEqual([]);
  });

  it('sends nothing when the deposit cannot cover the list', async () => {
    const { port, sent } = fakePort({ deposited: 1_000_000n });
    await expect(postRoot(port, VAULT, twoWallets)).rejects.toThrow(RootError);
    expect(sent).toEqual([]);
  });

  it('sends nothing from a key that is not the vault agent', async () => {
    const { port, sent } = fakePort({ agent: OWNER });
    await expect(postRoot(port, VAULT, twoWallets)).rejects.toThrow(/not the vault agent/);
    expect(sent).toEqual([]);
  });

  it('sends nothing on a chain Thuli does not run on (C2)', async () => {
    const { port, sent } = fakePort({ chainId: 31337 });
    await expect(postRoot(port, VAULT, twoWallets)).rejects.toThrow(ChainError);
    expect(sent).toEqual([]);
  });

  it('fails loudly when the vault does not show the posted root as pending', async () => {
    const { port } = fakePort({ recordsPending: false });
    await expect(postRoot(port, VAULT, twoWallets)).rejects.toThrow(/does not show the posted root/);
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

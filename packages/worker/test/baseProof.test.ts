// Not covered here: the phases' reads and sends on a chain (the anvil fork rehearsal of Base mainnet runs every phase
// end to end and is the proof), the explorer verification of the mainnet factory, and deploy.mjs's own sending, of
// which only the refusals that come before any key or RPC is read are run here.
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  BaseError,
  createPublicClient,
  decodeErrorResult,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  http as viemHttp,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { accountTypeFromCode, parseAddress } from '@thuli/core';
import { FACTORY_ABI, VAULT_ABI } from '../src/vault/abi.ts';
import {
  BASE_PROFILE,
  BASE_USDC,
  baseChain,
  baseKey,
  vaultRevertName,
  checkBaseNode,
  checkMainnetTerms,
  chooseNetwork,
  claimNeeded,
  createPlan,
  MAINNET_PROOF,
  MAINNET_PROOF_MAX_CAP,
  MAINNET_PROOF_MAX_DEPOSIT,
  paidWalletOf,
  postNeeded,
  REFUSED_WALLET,
  whenReady,
  withdrawNeeded,
} from '../src/vault/chainBase.ts';
import {
  BaseProofRecordFile,
  BaseProofState,
  buildBaseProofRecord,
  ProofFailed,
  ProofSetupError,
  verifyBaseProofRecord,
  type ProofLog,
  type ProofReceipt,
} from '../src/vault/proof.ts';
import { buildRoot, publishList } from '../src/vault/root.ts';

const address = (tag: string) => parseAddress(`0x${tag.repeat(20)}`);
const OWNER = address('0e');
const AGENT = address('a9');
const PAID = address('b1');
const FACTORY = address('fa');
const VAULT = address('a1');
const CAP = MAINNET_PROOF.perWalletCap;
const ROOT = buildRoot([{ account: PAID, cumulativeAmount: CAP }], VAULT, 8453).root;
const NOW = 1_800_000_000n;
const CLAIMABLE_AT = 1_800_003_600;
const END = 1_800_010_800;
const DEPLOY = fileURLToPath(new URL('../../contracts/script/deploy.mjs', import.meta.url));
const KEY = `0x${'4b'.repeat(32)}`;

describe('reaching Base mainnet', () => {
  const env = { BASE_RPC_URL: 'https://base-mainnet.example/k' };

  it('stays on Base Sepolia, exactly as today, without --network base', () => {
    expect(chooseNetwork({}, env)).toEqual({ name: 'base-sepolia' });
    expect(chooseNetwork({ network: 'base-sepolia' }, env)).toEqual({ name: 'base-sepolia' });
  });

  it('reaches mainnet only with --network base and --real-money together', () => {
    expect(() => chooseNetwork({ network: 'base' }, env)).toThrow('Base mainnet moves real money: add --real-money to --network base');
    expect(() => chooseNetwork({ 'real-money': true }, env)).toThrow('--real-money and --fork go only with --network base');
    expect(() => chooseNetwork({ fork: true }, env)).toThrow(ProofSetupError);
    expect(() => chooseNetwork({ network: 'ethereum', 'real-money': true }, env)).toThrow('--network must be base or base-sepolia');
    expect(chooseNetwork({ network: 'base', 'real-money': true }, env)).toEqual({ name: 'base', rpcUrl: env.BASE_RPC_URL, fork: false });
  });

  it('takes a fork only on a loopback URL, and an --rpc-url only with --fork, so a public RPC is never a fork', () => {
    const base = { network: 'base', 'real-money': true };
    expect(chooseNetwork({ ...base, fork: true, 'rpc-url': 'http://127.0.0.1:8547' }, env)).toEqual({ name: 'base', rpcUrl: 'http://127.0.0.1:8547', fork: true });
    for (const rpc of ['https://mainnet.base.org', 'http://10.0.0.5:8545', undefined]) {
      expect(() => chooseNetwork({ ...base, fork: true, 'rpc-url': rpc }, env)).toThrow('--fork needs --rpc-url http://127.0.0.1:PORT');
    }
    expect(() => chooseNetwork({ ...base, 'rpc-url': 'http://127.0.0.1:8547' }, env)).toThrow('--rpc-url is only for --fork');
    expect(() => chooseNetwork(base, {})).toThrow('Missing or invalid in .env: BASE_RPC_URL');
  });

  it('refuses any chain but 8453, a fork posing as mainnet, and mainnet posing as a fork', () => {
    expect(() => checkBaseNode({ chainId: 84532, clientVersion: 'reth/v1', fork: false })).toThrow('the RPC is on chain 84532');
    expect(() => checkBaseNode({ chainId: 8453, clientVersion: 'anvil/v1.8.6', fork: false })).toThrow('this node is a local anvil fork');
    expect(() => checkBaseNode({ chainId: 8453, clientVersion: 'reth/v1', fork: true })).toThrow('--fork expects a local anvil fork');
    expect(() => checkBaseNode({ chainId: 8453, clientVersion: 'reth/v1', fork: false })).not.toThrow();
    expect(() => checkBaseNode({ chainId: 8453, clientVersion: 'anvil/v1.8.6', fork: true })).not.toThrow();
  });

  it('refuses the same flags in deploy.mjs before it reads any key or RPC', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [DEPLOY, ...args], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
    for (const [args, message] of [
      [['--network', 'base'], 'add --real-money'],
      [['--real-money'], 'go only with --network base'],
      [['--network', 'base', '--real-money', '--fork', '--rpc-url', 'https://mainnet.base.org'], '--fork needs --rpc-url http://127.0.0.1:PORT'],
    ] as const) {
      const result = run(...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
    }
  });
});

describe('naming a revert', () => {
  // anvil's answer, exactly as a fresh fork of Base returned it, to an eth_call of ThuliVault.claim on a vault with no
  // state (captured by scratchpad/wo80/capture-revert.mjs). Replayed over HTTP, viem builds from it the same nested error
  // the refused-wallet check meets on the fork.
  const FORK_ANSWER = { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted: custom error 0x553ae054', data: '0x553ae054' } };

  it('reads the custom error where viem leaves it, on the deepest cause, not on a RawContractError', async () => {
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const { id } = JSON.parse(body) as { id: number };
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ...FORK_ANSWER, id }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const url = `http://127.0.0.1:${port}`;
      const client = createPublicClient({ chain: baseChain(url), transport: viemHttp(url, { retryCount: 0 }) });
      const data = encodeFunctionData({ abi: VAULT_ABI, functionName: 'claim', args: [PAID, CAP, []] });
      const error = await client.call({ to: VAULT, data }).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(BaseError);
      // The shape that fooled the first version: the revert data is on a cause several levels down.
      expect((error as BaseError).walk()).not.toBe(error);
      expect(vaultRevertName(error)).toBe(decodeErrorResult({ abi: VAULT_ABI, data: '0x553ae054' }).errorName);
      expect(vaultRevertName(error)).toBe('CampaignEnded');
      expect(vaultRevertName(new Error('no data at all'))).toBe('an unrecognised revert');
    } finally {
      server.close();
    }
  });
});

describe('the mainnet money limits', () => {
  it('holds the fixed proof inside the named limits, and refuses anything above them', () => {
    expect(MAINNET_PROOF_MAX_DEPOSIT).toBe(2_000_000n);
    expect(MAINNET_PROOF_MAX_CAP).toBe(1_000_000n);
    expect(() => checkMainnetTerms(MAINNET_PROOF)).not.toThrow();
    expect(() => checkMainnetTerms({ ...MAINNET_PROOF, deposit: 2_000_001n })).toThrow('above MAINNET_PROOF_MAX_DEPOSIT');
    expect(() => checkMainnetTerms({ ...MAINNET_PROOF, perWalletCap: 1_000_001n })).toThrow('above MAINNET_PROOF_MAX_CAP');
    expect(() => checkMainnetTerms({ ...MAINNET_PROOF, deposit: 0n })).toThrow(ProofSetupError);
  });

  it('runs one hour of delay inside a three hour vault, and refuses a wallet nobody holds a key for as the refused one', () => {
    expect(MAINNET_PROOF.rootDelay).toBe(3600);
    expect(MAINNET_PROOF.runSeconds).toBe(3 * 3600);
    expect(REFUSED_WALLET).toBe(parseAddress(REFUSED_WALLET.toLowerCase()));
    expect(BASE_USDC).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  });
});

describe('the paid wallet and the keys', () => {
  const roles = { owner: OWNER, agent: AGENT };

  it('takes the paid wallet from PAYTO_ADDRESS in the one address form (C1)', () => {
    expect(paidWalletOf({ PAYTO_ADDRESS: ` ${PAID.toLowerCase()} ` }, roles, '0x')).toBe(PAID);
  });

  it("sorts the paid wallet's code with core's accountTypeFromCode, the rule the screening uses (standard 2)", () => {
    const env = { PAYTO_ADDRESS: PAID };
    const delegated = `0xef0100${'ab'.repeat(20)}`;
    expect(accountTypeFromCode(delegated)).toBe('delegated_eoa');
    // eoa and delegated_eoa: a key-held wallet, which the vault only transfers USDC to and never calls.
    expect(paidWalletOf(env, roles, undefined)).toBe(PAID);
    expect(paidWalletOf(env, roles, '0x')).toBe(PAID);
    expect(paidWalletOf(env, roles, delegated)).toBe(PAID);
    expect(() => paidWalletOf(env, roles, '0x6080604052')).toThrow('PAYTO_ADDRESS is a contract');
    expect(() => paidWalletOf(env, roles, 'not hex at all')).toThrow('PAYTO_ADDRESS has code that could not be read');
  });

  it.each([
    ['unset', {}, '0x', 'PAYTO_ADDRESS must be set'],
    ['not an address', { PAYTO_ADDRESS: '0x1234' }, '0x', 'PAYTO_ADDRESS is not an address'],
    ['a contract', { PAYTO_ADDRESS: PAID }, '0x6080', 'PAYTO_ADDRESS is a contract'],
    ['the owner', { PAYTO_ADDRESS: OWNER.toLowerCase() }, '0x', 'PAYTO_ADDRESS must not be the owner or the agent'],
    ['the agent', { PAYTO_ADDRESS: AGENT }, '0x', 'PAYTO_ADDRESS must not be the owner or the agent'],
  ] as const)('refuses a PAYTO_ADDRESS that is %s', (_what, env, code, message) => {
    expect(() => paidWalletOf(env, roles, code)).toThrow(message);
  });

  it('reads one key by its name only, and never prints it (C39, C40)', () => {
    expect(baseKey({ PAYER_PRIVATE_KEY: KEY, WORKER_PRIVATE_KEY: 'x' }, 'PAYER_PRIVATE_KEY')).toBe(KEY);
    try {
      baseKey({ WORKER_PRIVATE_KEY: 'not-a-key-but-secret' }, 'WORKER_PRIVATE_KEY');
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain('WORKER_PRIVATE_KEY must be 0x and 64 hex characters');
      expect(String(error)).not.toContain('not-a-key-but-secret');
    }
  });
});

describe('a phase run too early', () => {
  it('refuses a claim before the root pays, with the time left', () => {
    expect(() => whenReady('claim', { now: NOW, endTime: BigInt(END), claimableAt: NOW + 1800n })).toThrow(
      `the root becomes claimable in 30 minutes, at ${new Date(Number(NOW + 1800n) * 1000).toISOString()}`,
    );
    expect(() => whenReady('claim', { now: NOW + 1800n, endTime: BigInt(END), claimableAt: NOW + 1800n })).not.toThrow();
    expect(() => whenReady('claim', { now: BigInt(END), endTime: BigInt(END), claimableAt: NOW })).toThrow('the vault has ended');
  });

  it('refuses a withdraw before the end, with the time left', () => {
    expect(() => whenReady('withdraw', { now: BigInt(END) - 61n, endTime: BigInt(END) })).toThrow('the vault ends in 2 minutes');
    expect(() => whenReady('withdraw', { now: BigInt(END), endTime: BigInt(END) })).not.toThrow();
  });

  it('refuses a post too late for the root to pay before the end', () => {
    expect(() => whenReady('post', { now: BigInt(END) - 3600n, endTime: BigInt(END), rootDelay: 3600 })).toThrow('could not pay before the end');
    expect(() => whenReady('post', { now: NOW, endTime: BigInt(END), rootDelay: 3600 })).not.toThrow();
  });
});

describe('every phase is safe to run twice', () => {
  const deposit = MAINNET_PROOF.deposit;

  it('creates, approves and deposits only what the chain does not already show', () => {
    expect(createPlan({ vault: false, deposited: 0n, allowance: 0n }, deposit)).toEqual(['createVault', 'approve', 'deposit']);
    expect(createPlan({ vault: true, deposited: 0n, allowance: 0n }, deposit)).toEqual(['approve', 'deposit']);
    expect(createPlan({ vault: true, deposited: 0n, allowance: deposit }, deposit)).toEqual(['deposit']);
    expect(createPlan({ vault: true, deposited: deposit, allowance: 0n }, deposit)).toEqual([]);
    expect(() => createPlan({ vault: true, deposited: 1n, allowance: 0n }, deposit)).toThrow(ProofFailed);
  });

  it('posts, claims and withdraws once, and stops on a state it did not make', () => {
    const none = `0x${'00'.repeat(32)}`;
    expect(postNeeded({ activeRoot: none, pendingRoot: none }, ROOT)).toBe(true);
    expect(postNeeded({ activeRoot: none, pendingRoot: ROOT }, ROOT)).toBe(false);
    expect(postNeeded({ activeRoot: ROOT, pendingRoot: none }, ROOT)).toBe(false);
    expect(() => postNeeded({ activeRoot: `0x${'99'.repeat(32)}`, pendingRoot: none }, ROOT)).toThrow('the vault holds another root');
    expect(claimNeeded(0n, CAP)).toBe(true);
    expect(claimNeeded(CAP, CAP)).toBe(false);
    expect(() => claimNeeded(1n, CAP)).toThrow(ProofFailed);
    expect(withdrawNeeded(CAP)).toBe(true);
    expect(withdrawNeeded(0n)).toBe(false);
  });
});

describe('the mainnet record', () => {
  const HASH = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(32)}`;
  const labels = ['createVault', 'approve', 'deposit', 'postRoot', 'claim', 'withdraw'] as const;
  const filled = (topics: readonly unknown[]) => topics as ProofLog['topics'];
  const words = (types: { type: string }[], values: unknown[]) => encodeAbiParameters(types, values);
  const transfer = (from: string, to: string, value: bigint): ProofLog => ({
    address: BASE_USDC,
    topics: filled(encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: from as `0x${string}`, to: to as `0x${string}` } })),
    data: words([{ type: 'uint256' }], [value]),
  });
  const fromVault = (eventName: 'RootPosted' | 'Claimed' | 'Withdrawn', args: Record<string, unknown>, data: `0x${string}`): ProofLog => ({
    address: VAULT,
    topics: filled(encodeEventTopics({ abi: VAULT_ABI, eventName, args } as never)),
    data,
  });

  function input(withdrawn: bigint = CAP) {
    const state = BaseProofState.parse({
      chainId: 8453,
      factory: FACTORY,
      vault: VAULT,
      owner: OWNER,
      agent: AGENT,
      paid: PAID,
      refused: REFUSED_WALLET,
      root: ROOT,
      published: publishList([{ account: PAID, cumulativeAmount: CAP }]),
      createdAtBlock: 100,
      endTime: END,
      claimableAt: CLAIMABLE_AT,
      transactions: labels.map((label, i) => ({ label, hash: HASH(i + 1), from: i === 3 || i === 4 ? AGENT : OWNER, gasUsed: String(50_000 + i) })),
    });
    const logs: Record<(typeof labels)[number], ProofLog[]> = {
      createVault: [
        {
          address: FACTORY,
          topics: filled(encodeEventTopics({ abi: FACTORY_ABI, eventName: 'VaultCreated', args: { vault: VAULT, owner: OWNER, agent: AGENT } })),
          data: words([{ type: 'address' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'uint32' }], [BASE_USDC, CAP, BigInt(END), 3600]),
        },
      ],
      approve: [],
      deposit: [transfer(OWNER, VAULT, 2n * CAP)],
      postRoot: [fromVault('RootPosted', { root: ROOT }, words([{ type: 'uint256' }, { type: 'uint64' }], [CAP, BigInt(CLAIMABLE_AT)]))],
      claim: [fromVault('Claimed', { account: PAID }, words([{ type: 'uint256' }, { type: 'uint256' }], [CAP, CAP])), transfer(VAULT, PAID, CAP)],
      withdraw: [fromVault('Withdrawn', { to: OWNER }, words([{ type: 'uint256' }], [withdrawn])), transfer(VAULT, OWNER, withdrawn)],
    };
    const targets = { createVault: FACTORY, approve: BASE_USDC, deposit: VAULT, postRoot: VAULT, claim: VAULT, withdraw: VAULT };
    const receipts: ProofReceipt[] = labels.map((label, i) => ({
      transactionHash: HASH(i + 1),
      status: 'success',
      blockNumber: BigInt(100 + i),
      gasUsed: BigInt(50_000 + i),
      from: i === 3 || i === 4 ? AGENT : OWNER,
      to: targets[label],
      logs: logs[label],
    }));
    const vaultState = { token: BASE_USDC, owner: OWNER, agent: AGENT, perWalletCap: CAP, rootDelay: 3600, deposited: 2n * CAP, totalPaid: CAP, activeRoot: ROOT as string };
    return {
      state,
      deployment: { chainId: 8453 as const, factory: FACTORY },
      chain: { receipts, vaultState, claimedByPaid: CAP, claimedByRefused: 0n, refusedSimulation: 'InvalidProof', vaultBalance: 0n },
      now: new Date('2026-11-12T09:00:00.000Z'),
    };
  }

  it('records Base mainnet, the six transactions and the withdrawal, in the file shape verify reads', () => {
    const record = buildBaseProofRecord(input(), BASE_PROFILE);
    expect(record).toMatchObject({
      network: 'base',
      chainId: 8453,
      explorer: 'https://basescan.org',
      token: BASE_USDC,
      paid: { account: PAID, amount: '1000000' },
      refused: { account: REFUSED_WALLET, error: 'InvalidProof' },
      withdrawn: { to: OWNER, amount: '1000000' },
      totalPaid: '1000000',
    });
    expect(record.transactions.map((tx) => tx.label)).toEqual([...labels]);
    expect(BaseProofRecordFile.parse(JSON.parse(JSON.stringify(record)))).toEqual(record);
    const { state, deployment, chain } = input();
    expect(state.chainId).toBe(8453);
    expect(verifyBaseProofRecord(record, deployment, chain, BASE_PROFILE).filter((check) => !check.pass)).toEqual([]);
  });

  it('refuses a withdrawal that did not return exactly what the claim left, and a vault still holding USDC', () => {
    expect(() => buildBaseProofRecord(input(CAP - 1n), BASE_PROFILE)).toThrow('the withdraw receipt does not return the 1000000 left in the vault to the owner');
    const good = input();
    const record = buildBaseProofRecord(good, BASE_PROFILE);
    const failed = verifyBaseProofRecord(record, good.deployment, { ...good.chain, vaultBalance: 1n }, BASE_PROFILE).filter((check) => !check.pass);
    expect(failed.map((check) => check.name)).toEqual(['vault empty']);
    expect(() => buildBaseProofRecord({ ...good, chain: { ...good.chain, vaultBalance: 1n } }, BASE_PROFILE)).toThrow('the vault still holds 1');
  });
});

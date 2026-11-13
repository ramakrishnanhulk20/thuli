import { BaseError, createPublicClient, createWalletClient, decodeErrorResult, defineChain, http, keccak256, slice, toHex, type Chain, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { accountTypeFromCode, CHAINS, parseAddress, type Address } from '@thuli/core';
import { VAULT_ABI } from './abi.ts';
import { ChainCallError, type Connection } from './chain.ts';
import { BASE_PROOF_STEPS, ProofFailed, ProofSetupError, type RecordProfile } from './proof.ts';

export const BASE_ID = CHAINS.base.id;
/**
 * Circle's USDC on Base mainnet. packages/core's chain table names no Base token yet, so it is named here once, and
 * every phase checks on chain that it answers symbol USDC and 6 decimals before using it.
 */
export const BASE_USDC = parseAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
export const BASE_EXPLORER = 'https://basescan.org';

/** The most the mainnet proof may deposit and cap, in USDC base units. A larger run is a person's decision, not a flag. */
export const MAINNET_PROOF_MAX_DEPOSIT = 2_000_000n;
export const MAINNET_PROOF_MAX_CAP = 1_000_000n;

/**
 * The one run --network base makes, fixed in code: 1 USDC cap, 2 USDC deposited, the contract's minimum root delay (one
 * hour) and an end three hours after creation, so the root's hour, the hour-long claim window and an hour of room fit.
 */
export const MAINNET_PROOF = Object.freeze({ perWalletCap: 1_000_000n, deposit: 2_000_000n, rootDelay: 3600, runSeconds: 3 * 3600 });

/** The wallet the refused claim names: an address taken from a hash, so no key for it exists. */
export const REFUSED_WALLET = parseAddress(slice(keccak256(toHex('thuli.base-proof.refused-wallet')), 12));

/** What the Base mainnet record is checked against. */
export const BASE_PROFILE: RecordProfile = Object.freeze({
  deploymentFile: 'base.json',
  network: 'base',
  chainId: BASE_ID,
  explorer: BASE_EXPLORER,
  usdc: BASE_USDC,
  perWalletCap: MAINNET_PROOF.perWalletCap,
  rootDelay: MAINNET_PROOF.rootDelay,
  steps: BASE_PROOF_STEPS,
});

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;
const HTTPS = /^https:\/\/\S+$/;
const KEY = /^0x[0-9a-fA-F]{64}$/;
const RPC_TIMEOUT_MS = 30_000;
// Multicall3 sits at this address on Base as on Base Sepolia.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const NO_ROOT = `0x${'00'.repeat(32)}`;

export type ProofNetwork = { name: 'base-sepolia' } | { name: 'base'; rpcUrl: string; fork: boolean };

/**
 * Which network a run is on. Base mainnet only with --network base and --real-money together; without them, Base
 * Sepolia as before. A fork only on a loopback --rpc-url, so a public RPC can never be taken for a fork; otherwise
 * BASE_RPC_URL over https.
 *
 * @throws ProofSetupError naming the flag or variable at fault, never a value (C40).
 */
export function chooseNetwork(
  flags: { network?: string; 'real-money'?: boolean; fork?: boolean; 'rpc-url'?: string },
  env: Record<string, string | undefined>,
): ProofNetwork {
  const network = flags.network ?? 'base-sepolia';
  if (network !== 'base' && network !== 'base-sepolia') throw new ProofSetupError('--network must be base or base-sepolia');
  if (network === 'base-sepolia') {
    if (flags['real-money'] === true || flags.fork === true) throw new ProofSetupError('--real-money and --fork go only with --network base');
    return { name: 'base-sepolia' };
  }
  if (flags['real-money'] !== true) throw new ProofSetupError('Base mainnet moves real money: add --real-money to --network base');
  if (flags.fork === true) {
    const rpcUrl = flags['rpc-url'] ?? '';
    if (!LOOPBACK.test(rpcUrl)) throw new ProofSetupError('--fork needs --rpc-url http://127.0.0.1:PORT, a local fork; it never reaches a public RPC');
    return { name: 'base', rpcUrl, fork: true };
  }
  if (flags['rpc-url'] !== undefined) throw new ProofSetupError('--rpc-url is only for --fork; Base mainnet is read through BASE_RPC_URL');
  const rpcUrl = (env.BASE_RPC_URL ?? '').trim();
  if (!HTTPS.test(rpcUrl)) throw new ProofSetupError('Missing or invalid in .env: BASE_RPC_URL (an https Base mainnet RPC).');
  return { name: 'base', rpcUrl, fork: false };
}

/**
 * Refuses a node that is not where the flags say: any chain but Base (8453), a local anvil fork run without --fork, and
 * with --fork anything that is not anvil. A fork of Base reports 8453, so the node's own name tells the two apart.
 *
 * @throws ChainCallError before anything is read or sent.
 */
export function checkBaseNode(node: { chainId: number; clientVersion: string; fork: boolean }): void {
  if (node.chainId !== BASE_ID) throw new ChainCallError(`the RPC is on chain ${node.chainId}; --network base runs only on Base (${BASE_ID})`);
  const anvil = /^anvil\//i.test(node.clientVersion);
  if (anvil && !node.fork) throw new ChainCallError('this node is a local anvil fork; pass --fork to rehearse on it, or use BASE_RPC_URL for the real chain');
  if (!anvil && node.fork) throw new ChainCallError('--fork expects a local anvil fork of Base, and this node is not one');
}

/** @throws ProofSetupError when a term is zero or above the named mainnet limits. */
export function checkMainnetTerms(terms: { perWalletCap: bigint; deposit: bigint }): void {
  if (terms.perWalletCap <= 0n || terms.deposit <= 0n) throw new ProofSetupError('the mainnet proof needs a cap and a deposit above zero');
  if (terms.deposit > MAINNET_PROOF_MAX_DEPOSIT) throw new ProofSetupError(`the deposit ${terms.deposit} is above MAINNET_PROOF_MAX_DEPOSIT (${MAINNET_PROOF_MAX_DEPOSIT})`);
  if (terms.perWalletCap > MAINNET_PROOF_MAX_CAP) throw new ProofSetupError(`the cap ${terms.perWalletCap} is above MAINNET_PROOF_MAX_CAP (${MAINNET_PROOF_MAX_CAP})`);
}

/**
 * The wallet the proof pays: PAYTO_ADDRESS in the one address form (C1).
 *
 * @throws ProofSetupError when it is unset, not an address, or the owner or agent of the run.
 */
export function paidAddressOf(env: Record<string, string | undefined>, roles: { owner: string; agent: string }): Address {
  const given = (env.PAYTO_ADDRESS ?? '').trim();
  if (given === '') throw new ProofSetupError("PAYTO_ADDRESS must be set: the founder's own receive address, which the proof pays");
  let paid: Address;
  try {
    paid = parseAddress(given);
  } catch {
    throw new ProofSetupError('PAYTO_ADDRESS is not an address');
  }
  if (paid === parseAddress(roles.owner) || paid === parseAddress(roles.agent)) {
    throw new ProofSetupError('PAYTO_ADDRESS must not be the owner or the agent, or the balances would not show what the vault paid');
  }
  return paid;
}

/**
 * paidAddressOf, then the code the chain holds at it, sorted by core's accountTypeFromCode, the rule the screening and
 * the ask route use (standard 2). A plain wallet or one with an EIP-7702 delegation is taken: its owner holds the key,
 * and the vault only transfers USDC to it, never calls it. A contract is refused, and so is code that cannot be read.
 *
 * @throws ProofSetupError as paidAddressOf, or for a contract or unreadable code.
 */
export function paidWalletOf(env: Record<string, string | undefined>, roles: { owner: string; agent: string }, code: string | undefined): Address {
  const paid = paidAddressOf(env, roles);
  const type = accountTypeFromCode(code);
  if (type === 'contract') throw new ProofSetupError('PAYTO_ADDRESS is a contract; the proof pays a wallet a person holds');
  if (type === 'unknown') throw new ProofSetupError('PAYTO_ADDRESS has code that could not be read, so it cannot be shown to be a wallet');
  return paid;
}

/** One key, read by its name only, so a phase holds no key it does not send with (C39). */
export function baseKey(env: Record<string, string | undefined>, name: 'PAYER_PRIVATE_KEY' | 'WORKER_PRIVATE_KEY'): `0x${string}` {
  const value = (env[name] ?? '').trim();
  if (!KEY.test(value)) throw new ProofSetupError(`${name} must be 0x and 64 hex characters (see .env.example).`);
  return value as `0x${string}`;
}

function minutesLeft(now: bigint, at: bigint): string {
  return `${Math.ceil(Number(at - now) / 60)} minutes, at ${new Date(Number(at) * 1000).toISOString()}`;
}

/**
 * Refuses a phase run too early or too late, with the time left: a post the root could not pay after, a claim before
 * the root pays or after the end, a withdraw before the end. Times are the chain's, in unix seconds.
 */
export function whenReady(
  phase: 'post' | 'claim' | 'withdraw',
  at: { now: bigint; endTime: bigint; claimableAt?: bigint | null; rootDelay?: number },
): void {
  if (phase === 'post' && at.now + BigInt(at.rootDelay ?? 0) >= at.endTime) {
    throw new ProofSetupError('too late: a root posted now could not pay before the end of the vault');
  }
  if (phase === 'claim') {
    if (at.now >= at.endTime) throw new ProofSetupError('the vault has ended, so it takes no claim');
    if (at.claimableAt === undefined || at.claimableAt === null) throw new ProofSetupError('no root has been posted yet: run post first');
    if (at.now < at.claimableAt) throw new ProofSetupError(`the root becomes claimable in ${minutesLeft(at.now, at.claimableAt)}. Run claim then.`);
  }
  if (phase === 'withdraw' && at.now < at.endTime) throw new ProofSetupError(`the vault ends in ${minutesLeft(at.now, at.endTime)}. Run withdraw then.`);
}

/**
 * Which of createVault, approve and deposit are still to do, from what the chain shows, so create run twice sends
 * nothing more. A vault holding part of the deposit is a state this never makes, so it stops.
 */
export function createPlan(observed: { vault: boolean; deposited: bigint; allowance: bigint }, deposit: bigint): ('createVault' | 'approve' | 'deposit')[] {
  if (!observed.vault) return ['createVault', 'approve', 'deposit'];
  if (observed.deposited >= deposit) return [];
  if (observed.deposited > 0n) throw new ProofFailed('the vault holds part of the deposit; stopping rather than guess what to send');
  return observed.allowance >= deposit ? ['deposit'] : ['approve', 'deposit'];
}

/** True when the root still has to be posted; false when it is pending or active already. */
export function postNeeded(view: { activeRoot: string; pendingRoot: string }, root: string): boolean {
  const ours = root.toLowerCase();
  const active = view.activeRoot.toLowerCase();
  const pending = view.pendingRoot.toLowerCase();
  if (active === ours || pending === ours) return false;
  if (active !== NO_ROOT || pending !== NO_ROOT) throw new ProofFailed('the vault holds another root than this run posts; stopping');
  return true;
}

/** True when the paid wallet has not been paid yet; false once it holds its whole amount. */
export function claimNeeded(claimed: bigint, amount: bigint): boolean {
  if (claimed >= amount) return false;
  if (claimed > 0n) throw new ProofFailed('the paid wallet has claimed part of its amount; stopping rather than guess');
  return true;
}

/** True while the vault still holds USDC for the owner to take back. */
export function withdrawNeeded(vaultBalance: bigint): boolean {
  return vaultBalance > 0n;
}

/** Base mainnet as viem needs it, with Multicall3. */
export function baseChain(rpcUrl: string): Chain {
  return defineChain({
    id: BASE_ID,
    name: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
}

/**
 * Clients for Base mainnet, or a local anvil fork of it with `fork`. Refuses, before any read the caller makes, a node
 * on another chain or of the wrong kind (checkBaseNode).
 */
export async function connectBase(rpcUrl: string, fork: boolean): Promise<Connection> {
  const chain = baseChain(rpcUrl);
  // The configured endpoint answers, or nothing does: an HTTP redirect is refused (C38).
  const transport = http(rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 2, fetchOptions: { redirect: 'error' } });
  const publicClient = createPublicClient({ chain, transport });
  const chainId = await publicClient.getChainId();
  let clientVersion = '';
  try {
    clientVersion = String(await publicClient.request({ method: 'web3_clientVersion' } as never));
  } catch {
    // A node that does not say what it is cannot be anvil, which only matters with --fork, and that refuses below.
  }
  checkBaseNode({ chainId, clientVersion, fork });
  return {
    publicClient,
    wallet: (privateKey) => createWalletClient({ account: privateKeyToAccount(privateKey), chain, transport }),
  };
}

export function baseTxLink(hash: Hash): string {
  return `${BASE_EXPLORER}/tx/${hash}`;
}

export function baseAddressLink(address: string): string {
  return `${BASE_EXPLORER}/address/${parseAddress(address)}`;
}

/**
 * The custom error a failed vault call reverted with, decoded against the vault ABI, or 'an unrecognised revert'. The
 * revert data is read where viem's own call reads it: on the deepest cause, as hex or as an object holding the hex. A
 * plain eth_call never produces a RawContractError, so looking for one named every refusal unrecognised.
 */
export function vaultRevertName(error: unknown): string {
  const deepest = error instanceof BaseError ? (error.walk() as { data?: unknown }) : undefined;
  const data = deepest?.data;
  const revert = typeof data === 'object' && data !== null ? (data as { data?: unknown }).data : data;
  if (typeof revert !== 'string' || !/^0x[0-9a-fA-F]*$/.test(revert)) return 'an unrecognised revert';
  try {
    return decodeErrorResult({ abi: VAULT_ABI, data: revert as `0x${string}` }).errorName;
  } catch {
    return 'an unrecognised revert';
  }
}

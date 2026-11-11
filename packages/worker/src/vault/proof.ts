import { randomBytes } from 'node:crypto';
import { concat, decodeEventLog, erc20Abi, keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { CHAINS, parseAddress, type Address } from '@thuli/core';
import { FACTORY_ABI, VAULT_ABI } from './abi.ts';
import { buildRoot, readPublishedList, type VaultEntry } from './root.ts';

/** The proof campaign: 1 USDC cap, 2 USDC deposited, claimant A approved for 1 USDC, one hour delay, seven days long. */
export const PROOF_TERMS = {
  perWalletCap: 1_000_000n,
  deposit: 2_000_000n,
  approvedAmount: 1_000_000n,
  rootDelay: 3600,
  runSeconds: 7 * 24 * 3600,
} as const;

export class ProofSetupError extends Error {
  override name = 'ProofSetupError';
}

/** The chain did not show what the proof claims. */
export class ProofFailed extends Error {
  override name = 'ProofFailed';
}

const KEY = /^0x[0-9a-fA-F]{64}$/;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;
const HTTPS_RPC = /^https:\/\/\S+$/;

export interface ProofEnv {
  workerKey: `0x${string}`;
  payerKey: `0x${string}`;
  rpcUrl: string;
  /** True when the RPC is a local fork, so transaction links will not resolve on the explorer. */
  rehearsal: boolean;
}

/**
 * The two keys and the RPC for prove-vault. `rpcOverride` is accepted only for a loopback address, which is how the
 * local-fork rehearsal runs; everything else uses BASE_SEPOLIA_RPC_URL over https.
 *
 * @throws ProofSetupError naming the variable at fault, never its value (C40).
 */
export function loadProofEnv(source: Record<string, string | undefined>, rpcOverride?: string): ProofEnv {
  const missing: string[] = [];
  const key = (name: string): `0x${string}` => {
    const value = (source[name] ?? '').trim();
    if (!KEY.test(value)) missing.push(name);
    return value as `0x${string}`;
  };
  const workerKey = key('WORKER_PRIVATE_KEY');
  const payerKey = key('PAYER_PRIVATE_KEY');
  let rpcUrl = (source.BASE_SEPOLIA_RPC_URL ?? '').trim();
  const rehearsal = rpcOverride !== undefined;
  if (rehearsal) {
    if (!LOOPBACK.test(rpcOverride)) throw new ProofSetupError('--rpc-url is only for a local fork: http://127.0.0.1:PORT');
    rpcUrl = rpcOverride;
  } else if (!HTTPS_RPC.test(rpcUrl)) {
    missing.push('BASE_SEPOLIA_RPC_URL');
  }
  if (missing.length > 0) {
    throw new ProofSetupError(`Missing or invalid in .env: ${missing.join(', ')} (see .env.example for the format).`);
  }
  if (workerKey.toLowerCase() === payerKey.toLowerCase()) {
    throw new ProofSetupError('WORKER_PRIVATE_KEY and PAYER_PRIVATE_KEY must be different keys: the agent is never the owner.');
  }
  return { workerKey, payerKey, rpcUrl, rehearsal };
}

/**
 * The RPC alone, for the read-only record phase. No key is loaded, so that phase has nothing it could sign with.
 *
 * @throws ProofSetupError naming BASE_SEPOLIA_RPC_URL, never its value (C40).
 */
export function loadRpcEnv(source: Record<string, string | undefined>): string {
  const rpcUrl = (source.BASE_SEPOLIA_RPC_URL ?? '').trim();
  if (!HTTPS_RPC.test(rpcUrl)) {
    throw new ProofSetupError('Missing or invalid in .env: BASE_SEPOLIA_RPC_URL (see .env.example for the format).');
  }
  return rpcUrl;
}

/** A fresh claimant seed. Testnet only: it sits in the proof's state file so both phases derive the same wallets. */
export function newSeed(): Hex {
  return toHex(randomBytes(32));
}

/**
 * Claimant A (on the list) and claimant B (held, left off) for a seed. Their keys are derived, never stored; nobody
 * signs as them, because the agent submits A's claim and the vault pays the leaf's account whoever submits.
 */
export function claimants(seed: Hex): { a: Address; b: Address } {
  const derive = (label: string) =>
    parseAddress(privateKeyToAccount(keccak256(concat([seed, toHex(`thuli.prove-vault.${label}`)]))).address);
  return { a: derive('claimant-a'), b: derive('claimant-b') };
}

const AddressField = z.string().transform((value, ctx) => {
  try {
    return parseAddress(value);
  } catch {
    ctx.issues.push({ code: 'custom', message: 'not an address', input: value });
    return z.NEVER;
  }
});
const Hash32 = z.string().regex(/^0x[0-9a-f]{64}$/);

export const ProofState = z.strictObject({
  chainId: z.literal(84532),
  factory: AddressField,
  vault: AddressField,
  owner: AddressField,
  agent: AddressField,
  seed: Hash32,
  root: Hash32,
  published: z.string().max(10_000),
  createdAtBlock: z.int().positive(),
  endTime: z.int().positive(),
  claimableAt: z.int().positive(),
  transactions: z
    .array(z.strictObject({ label: z.string().max(64), hash: Hash32, from: AddressField, gasUsed: z.string().regex(/^[0-9]+$/) }))
    .max(32),
});
export type ProofState = z.infer<typeof ProofState>;

export const Deployment = z.object({ chainId: z.literal(84532), factory: AddressField });
export type Deployment = z.infer<typeof Deployment>;

const BASE_SEPOLIA = CHAINS['base-sepolia'];

export type ProofLabel = 'createVault' | 'approve' | 'deposit' | 'postRoot' | 'claim';

/** The public record of the vault proof: every line was read back from Base Sepolia before it was written. */
export interface ProofRecord {
  schema: 1;
  network: 'base-sepolia';
  chainId: 84532;
  explorer: 'https://sepolia.basescan.org';
  factory: string;
  vault: string;
  token: string;
  owner: string;
  agent: string;
  /** Base units as decimal text. */
  perWalletCap: string;
  rootDelaySeconds: number;
  /** The active root the claim proved against. */
  root: string;
  /** Unix seconds. */
  claimableAt: number;
  /** Claimant A and what it received, in base units. */
  paid: { account: string; amount: string };
  refused: { account: string; error: 'InvalidProof' };
  /** Both read from the vault's state() when the record is written. */
  deposited: string;
  totalPaid: string;
  transactions: Array<{ label: ProofLabel; hash: string; block: number; gasUsed: number; from: string }>;
  /** When the record was checked against the chain. */
  recordedAt: string;
}

/** One log as a receipt carries it, not yet decoded. */
export interface ProofLog {
  address: string;
  topics: readonly Hex[];
  data: Hex;
}

/** The receipt fields buildProofRecord checks. viem's TransactionReceipt fits as is. */
export interface ProofReceipt {
  transactionHash: string;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  gasUsed: bigint;
  from: string;
  to: string | null;
  logs: readonly ProofLog[];
}

/** The fields of the vault's state() the record checks or copies. */
export interface ProofVaultState {
  token: string;
  owner: string;
  agent: string;
  perWalletCap: bigint;
  rootDelay: number;
  deposited: bigint;
  totalPaid: bigint;
  activeRoot: string;
}

/** What prove-vault record reads from the chain. */
export interface ProofChain {
  /** The receipt of each transaction the state lists. One the chain does not know is left out. */
  receipts: readonly ProofReceipt[];
  vaultState: ProofVaultState;
  /** claimed(paid account). */
  claimedByPaid: bigint;
  /** The custom error a fresh static call of claim for the refused account, with the paid account's proof, reverted
   * with; anything else, including 'success', is refused. */
  refusedSimulation: 'InvalidProof' | string;
}

interface ProofStep {
  label: ProofLabel;
  /** The label the setup and claim phases saved the transaction under. */
  saved: string;
  signer: 'owner' | 'agent';
  target: 'factory' | 'token' | 'vault';
}

const PROOF_STEPS: readonly ProofStep[] = [
  { label: 'createVault', saved: 'createVault', signer: 'owner', target: 'factory' },
  { label: 'approve', saved: 'approve', signer: 'owner', target: 'token' },
  { label: 'deposit', saved: 'deposit', signer: 'owner', target: 'vault' },
  { label: 'postRoot', saved: 'postRoot', signer: 'agent', target: 'vault' },
  { label: 'claim', saved: 'claim A', signer: 'agent', target: 'vault' },
];

function must(ok: boolean, failure: string): asserts ok {
  if (!ok) throw new ProofFailed(failure);
}

/** Compared through the one parser (C1), so a lowercase address from an RPC equals the saved checksummed one. */
function sameAddress(left: string, right: string): boolean {
  try {
    return parseAddress(left) === parseAddress(right);
  } catch {
    return false;
  }
}

/** Every log `emitter` wrote in the receipt, decoded against `abi`; logs of events outside the ABI are skipped. */
function eventsFrom<const abi extends typeof VAULT_ABI | typeof FACTORY_ABI | typeof erc20Abi>(
  receipt: ProofReceipt,
  emitter: string,
  abi: abi,
) {
  return receipt.logs.flatMap((log) => {
    const [signature, ...rest] = log.topics;
    if (signature === undefined || !sameAddress(log.address, emitter)) return [];
    try {
      return [decodeEventLog({ abi, topics: [signature, ...rest], data: log.data, strict: true })];
    } catch {
      return [];
    }
  });
}

/**
 * The public record of the vault proof, built only from what the chain shows. Pure: prove-vault record makes the reads.
 *
 * Refuses unless the state holds the five transactions of a finished run, each receipt succeeded, was sent by the owner
 * (createVault, approve, deposit) or the agent (postRoot, claim) and went to the factory, USDC or the vault; the
 * createVault receipt holds the factory's VaultCreated for this vault; the postRoot receipt holds the vault's
 * RootPosted for the saved root and claimableAt; the saved list holds only claimant A and rebuilds to the saved root;
 * state() shows USDC, the saved owner and agent, the proof's cap and delay, and the saved root as active; the claim
 * receipt holds one Claimed from the vault paying claimant A the cap and one USDC Transfer of that amount from the vault
 * to claimant A; totalPaid and claimed(claimant A) both equal that amount; and a fresh static call of claim for
 * claimant B with A's proof reverts with InvalidProof. Every address in the record comes out of parseAddress (C1).
 *
 * @throws ProofFailed naming the first check the chain did not agree with.
 */
export function buildProofRecord(input: { state: ProofState; deployment: Deployment; chain: ProofChain; now: Date }): ProofRecord {
  const { state, deployment, chain, now } = input;
  const factory = parseAddress(deployment.factory);
  const vault = parseAddress(state.vault);
  const owner = parseAddress(state.owner);
  const agent = parseAddress(state.agent);
  const token = parseAddress(BASE_SEPOLIA.usdc);
  const root = state.root.toLowerCase();
  must(sameAddress(state.factory, factory), 'the proof state names another factory than the deployment record');

  must(state.transactions.length === PROOF_STEPS.length, `the proof state lists ${state.transactions.length} transactions, not the five of a finished run`);
  const signers = { owner, agent };
  const targets = { factory, token, vault };
  const receipts = new Map<ProofLabel, ProofReceipt>();
  const transactions = PROOF_STEPS.map((step) => {
    const saved = state.transactions.filter((tx) => tx.label === step.saved);
    const hash = saved[0]?.hash.toLowerCase();
    must(saved.length === 1 && hash !== undefined, `the proof state does not hold exactly one ${step.label} transaction`);
    const receipt = chain.receipts.find((candidate) => candidate.transactionHash.toLowerCase() === hash);
    must(receipt !== undefined, `the chain has no receipt for the ${step.label} transaction ${hash}`);
    must(receipt.status === 'success', `the ${step.label} transaction ${hash} did not succeed on chain`);
    must(sameAddress(receipt.from, signers[step.signer]), `the ${step.label} transaction was sent by ${receipt.from}, not the ${step.signer} ${signers[step.signer]}`);
    must(receipt.to !== null && sameAddress(receipt.to, targets[step.target]), `the ${step.label} transaction was not sent to the ${step.target}`);
    receipts.set(step.label, receipt);
    return { label: step.label, hash, block: Number(receipt.blockNumber), gasUsed: Number(receipt.gasUsed), from: parseAddress(receipt.from) };
  });
  const receiptOf = (label: ProofLabel) => receipts.get(label) as ProofReceipt;

  const created = eventsFrom(receiptOf('createVault'), factory, FACTORY_ABI).flatMap((event) =>
    event.eventName === 'VaultCreated' ? [event.args] : [],
  );
  must(
    created.length === 1 && created.every((args) => sameAddress(args.vault, vault) && sameAddress(args.owner, owner) && sameAddress(args.agent, agent)),
    'the createVault receipt does not hold the factory VaultCreated event for this vault, owner and agent',
  );
  const posted = eventsFrom(receiptOf('postRoot'), vault, VAULT_ABI).flatMap((event) => (event.eventName === 'RootPosted' ? [event.args] : []));
  must(
    posted.length === 1 && posted.every((args) => args.root.toLowerCase() === root && args.claimableAt === BigInt(state.claimableAt)),
    'the postRoot receipt does not hold the vault RootPosted event for the saved root and claimableAt',
  );

  const { a, b } = claimants(state.seed as Hex);
  let entries: VaultEntry[];
  let rebuilt: string;
  try {
    entries = readPublishedList(state.published);
    rebuilt = buildRoot(entries, vault, BASE_SEPOLIA.id).root.toLowerCase();
  } catch {
    throw new ProofFailed('the saved list is not a list the vault can hash');
  }
  must(entries.length === 1 && entries.every((entry) => sameAddress(entry.account, a)), 'the saved list does not hold only claimant A from the saved seed');
  must(rebuilt === root, 'the saved list does not rebuild to the saved root');

  const view = chain.vaultState;
  must(sameAddress(view.token, token), "the vault's token is not Base Sepolia USDC");
  must(sameAddress(view.owner, owner), "the vault's owner is not the saved owner");
  must(sameAddress(view.agent, agent), "the vault's agent is not the saved agent");
  must(view.perWalletCap === PROOF_TERMS.perWalletCap, `the vault's perWalletCap is ${view.perWalletCap}, not ${PROOF_TERMS.perWalletCap}`);
  must(view.rootDelay === PROOF_TERMS.rootDelay, `the vault's rootDelay is ${view.rootDelay}, not ${PROOF_TERMS.rootDelay}`);
  must(view.activeRoot.toLowerCase() === root, "the vault's active root is not the saved root");

  const amount = view.perWalletCap;
  const claimed = eventsFrom(receiptOf('claim'), vault, VAULT_ABI).flatMap((event) => (event.eventName === 'Claimed' ? [event.args] : []));
  must(
    claimed.length === 1 && claimed.every((args) => sameAddress(args.account, a) && args.amount === amount),
    `the claim receipt does not hold one vault Claimed event paying claimant A ${amount}`,
  );
  const transfers = eventsFrom(receiptOf('claim'), token, erc20Abi).flatMap((event) =>
    event.eventName === 'Transfer' && sameAddress(event.args.from, vault) ? [event.args] : [],
  );
  must(
    transfers.length === 1 && transfers.every((args) => sameAddress(args.to, a) && args.value === amount),
    `the claim receipt does not hold one USDC Transfer of ${amount} from the vault to claimant A`,
  );
  must(view.totalPaid === amount, `the vault's totalPaid is ${view.totalPaid}, not the ${amount} the claim paid`);
  must(chain.claimedByPaid === amount, `claimed(claimant A) is ${chain.claimedByPaid}, not the ${amount} the claim paid`);
  must(chain.refusedSimulation === 'InvalidProof', `claimant B with A's proof was not refused with InvalidProof (got ${chain.refusedSimulation})`);

  return {
    schema: 1,
    network: 'base-sepolia',
    chainId: BASE_SEPOLIA.id,
    explorer: BASE_SEPOLIA.explorer,
    factory,
    vault,
    token,
    owner,
    agent,
    perWalletCap: view.perWalletCap.toString(),
    rootDelaySeconds: view.rootDelay,
    root,
    claimableAt: state.claimableAt,
    paid: { account: a, amount: amount.toString() },
    refused: { account: b, error: 'InvalidProof' },
    deposited: view.deposited.toString(),
    totalPaid: view.totalPaid.toString(),
    transactions,
    recordedAt: now.toISOString(),
  };
}

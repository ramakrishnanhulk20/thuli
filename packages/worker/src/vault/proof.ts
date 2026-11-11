import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
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

// The deployment and proof records are a few hundred bytes; a file far past this is not one of them.
const MAX_RECORD_BYTES = 64 * 1024;

/**
 * A small JSON file read through `schema`, such as a committed deployment or proof record.
 *
 * @throws ProofSetupError naming the file when it is missing, too large, not JSON or not in the schema.
 */
export function readJson<T extends z.ZodType>(schema: T, file: string, what: string): z.infer<T> {
  if (!fs.existsSync(file)) throw new ProofSetupError(`No ${what} at ${file}.`);
  if (fs.statSync(file).size > MAX_RECORD_BYTES) throw new ProofSetupError(`The ${what} at ${file} is too large.`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new ProofSetupError(`The ${what} at ${file} is malformed.`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ProofSetupError(`The ${what} at ${file} is malformed.`);
  return parsed.data;
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

/** Base Sepolia's public endpoint, the one .env.example ships with. It is rate-limited; verify makes about a dozen calls. */
export const PUBLIC_BASE_SEPOLIA_RPC = 'https://sepolia.base.org';

/**
 * The RPC for verify: BASE_SEPOLIA_RPC_URL when it is set, else Base Sepolia's public endpoint, so checking the record
 * needs no account anywhere. A value that is set but is not https is refused, never swapped for the public one.
 *
 * @throws ProofSetupError naming BASE_SEPOLIA_RPC_URL, never its value (C40).
 */
export function loadVerifyRpc(source: Record<string, string | undefined>): { rpcUrl: string; usesPublic: boolean } {
  if ((source.BASE_SEPOLIA_RPC_URL ?? '').trim() === '') return { rpcUrl: PUBLIC_BASE_SEPOLIA_RPC, usesPublic: true };
  return { rpcUrl: loadRpcEnv(source), usesPublic: false };
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

/** deployments/base.json, the Base mainnet factory record, in the same shape as base-sepolia.json. */
export const BaseDeployment = z.object({ chainId: z.literal(8453), factory: AddressField });

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

export interface ProofStep {
  label: ProofLabel | 'withdraw';
  /** The label the phases saved the transaction under. */
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

/** The Base mainnet proof's steps: the same five, saved under their own names, then the owner's withdrawal. */
export const BASE_PROOF_STEPS: readonly ProofStep[] = [
  ...PROOF_STEPS.map((step) => ({ ...step, saved: step.label })),
  { label: 'withdraw', saved: 'withdraw', signer: 'owner', target: 'vault' },
];

/**
 * What a proof record is checked against on one network: its chain, the USDC it pays, the proof's fixed terms and the
 * steps it took. With a withdraw step the record must also show the owner taking back the rest and the vault empty.
 */
export interface RecordProfile {
  network: string;
  chainId: number;
  explorer: string;
  usdc: string;
  perWalletCap: bigint;
  rootDelay: number;
  steps: readonly ProofStep[];
  /** The committed deployment record's file name, as checks name it. */
  deploymentFile: string;
}

const SEPOLIA_PROFILE: RecordProfile = {
  deploymentFile: 'base-sepolia.json',
  network: 'base-sepolia',
  chainId: 84532,
  explorer: 'https://sepolia.basescan.org',
  usdc: CHAINS['base-sepolia'].usdc,
  perWalletCap: PROOF_TERMS.perWalletCap,
  rootDelay: PROOF_TERMS.rootDelay,
  steps: PROOF_STEPS,
};

const DecimalText = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);

/** The committed base-sepolia-proof.json as buildProofRecord writes it. Strict, so a file with any other field is refused. */
export const ProofRecordFile = z.strictObject({
  schema: z.literal(1),
  network: z.literal('base-sepolia'),
  chainId: z.literal(84532),
  explorer: z.literal('https://sepolia.basescan.org'),
  factory: AddressField,
  vault: AddressField,
  token: AddressField,
  owner: AddressField,
  agent: AddressField,
  perWalletCap: DecimalText,
  rootDelaySeconds: z.int().min(0),
  root: Hash32,
  claimableAt: z.int().positive(),
  paid: z.strictObject({ account: AddressField, amount: DecimalText }),
  refused: z.strictObject({ account: AddressField, error: z.literal('InvalidProof') }),
  deposited: DecimalText,
  totalPaid: DecimalText,
  transactions: z
    .array(
      z.strictObject({
        label: z.enum(PROOF_STEPS.map((step) => step.label) as [ProofLabel, ...ProofLabel[]]),
        hash: Hash32,
        block: z.int().positive(),
        gasUsed: z.int().positive(),
        from: AddressField,
      }),
    )
    .max(PROOF_STEPS.length),
  recordedAt: z.iso.datetime(),
});

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
  const { a, b } = claimants(input.state.seed as Hex);
  return recordFor(input, SEPOLIA_PROFILE, { paid: a, refused: b }, SEPOLIA_NAMES) as ProofRecord;
}

/** How a network's messages name the two wallets and the token. */
interface RecordNames {
  paid: string;
  refused: string;
  usdc: string;
  listOrigin: string;
}

const SEPOLIA_NAMES: RecordNames = { paid: 'claimant A', refused: 'claimant B', usdc: 'Base Sepolia USDC', listOrigin: ' from the saved seed' };
const BASE_NAMES: RecordNames = { paid: 'the paid wallet', refused: 'the refused wallet', usdc: 'Base USDC', listOrigin: '' };

/** The saved run as the record builder reads it, the same on both networks. */
interface RecordState {
  factory: string;
  vault: string;
  owner: string;
  agent: string;
  root: string;
  published: string;
  claimableAt: number;
  transactions: readonly { label: string; hash: string }[];
}

/** A proof record on any network. ProofRecord and BaseProofRecord are its two exact shapes. */
type PublicProofRecord = Omit<ProofRecord, 'network' | 'chainId' | 'explorer' | 'transactions'> & {
  network: string;
  chainId: number;
  explorer: string;
  withdrawn?: { to: string; amount: string };
  transactions: Array<{ label: ProofStep['label']; hash: string; block: number; gasUsed: number; from: string }>;
};

// The checks buildProofRecord documents, for one network's profile. With a withdraw step it also requires the owner to
// have taken back exactly what the claim left and the vault to hold nothing.
function recordFor(
  input: { state: RecordState; deployment: { factory: string }; chain: ProofChain & { vaultBalance?: bigint }; now: Date },
  profile: RecordProfile,
  wallets: { paid: Address; refused: Address },
  names: RecordNames,
): PublicProofRecord {
  const { state, deployment, chain, now } = input;
  const factory = parseAddress(deployment.factory);
  const vault = parseAddress(state.vault);
  const owner = parseAddress(state.owner);
  const agent = parseAddress(state.agent);
  const token = parseAddress(profile.usdc);
  const root = state.root.toLowerCase();
  must(sameAddress(state.factory, factory), 'the proof state names another factory than the deployment record');

  const steps = profile.steps;
  must(state.transactions.length === steps.length, `the proof state lists ${state.transactions.length} transactions, not the ${steps.length} of a finished run`);
  const signers = { owner, agent };
  const targets = { factory, token, vault };
  const receipts = new Map<ProofStep['label'], ProofReceipt>();
  const transactions = steps.map((step) => {
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
  const receiptOf = (label: ProofStep['label']) => receipts.get(label) as ProofReceipt;

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

  const { paid: a, refused: b } = wallets;
  let entries: VaultEntry[];
  let rebuilt: string;
  try {
    entries = readPublishedList(state.published);
    rebuilt = buildRoot(entries, vault, profile.chainId).root.toLowerCase();
  } catch {
    throw new ProofFailed('the saved list is not a list the vault can hash');
  }
  must(entries.length === 1 && entries.every((entry) => sameAddress(entry.account, a)), `the saved list does not hold only ${names.paid}${names.listOrigin}`);
  must(rebuilt === root, 'the saved list does not rebuild to the saved root');

  const view = chain.vaultState;
  must(sameAddress(view.token, token), `the vault's token is not ${names.usdc}`);
  must(sameAddress(view.owner, owner), "the vault's owner is not the saved owner");
  must(sameAddress(view.agent, agent), "the vault's agent is not the saved agent");
  must(view.perWalletCap === profile.perWalletCap, `the vault's perWalletCap is ${view.perWalletCap}, not ${profile.perWalletCap}`);
  must(view.rootDelay === profile.rootDelay, `the vault's rootDelay is ${view.rootDelay}, not ${profile.rootDelay}`);
  must(view.activeRoot.toLowerCase() === root, "the vault's active root is not the saved root");

  const amount = view.perWalletCap;
  const claimed = eventsFrom(receiptOf('claim'), vault, VAULT_ABI).flatMap((event) => (event.eventName === 'Claimed' ? [event.args] : []));
  must(
    claimed.length === 1 && claimed.every((args) => sameAddress(args.account, a) && args.amount === amount),
    `the claim receipt does not hold one vault Claimed event paying ${names.paid} ${amount}`,
  );
  const transfers = eventsFrom(receiptOf('claim'), token, erc20Abi).flatMap((event) =>
    event.eventName === 'Transfer' && sameAddress(event.args.from, vault) ? [event.args] : [],
  );
  must(
    transfers.length === 1 && transfers.every((args) => sameAddress(args.to, a) && args.value === amount),
    `the claim receipt does not hold one USDC Transfer of ${amount} from the vault to ${names.paid}`,
  );
  must(view.totalPaid === amount, `the vault's totalPaid is ${view.totalPaid}, not the ${amount} the claim paid`);
  must(chain.claimedByPaid === amount, `claimed(${names.paid}) is ${chain.claimedByPaid}, not the ${amount} the claim paid`);
  must(chain.refusedSimulation === 'InvalidProof', `${names.refused} with ${names.paid}'s proof was not refused with InvalidProof (got ${chain.refusedSimulation})`);

  let withdrawn: { to: Address; amount: string } | undefined;
  if (receipts.has('withdraw')) {
    const left = view.deposited - view.totalPaid;
    const back = eventsFrom(receiptOf('withdraw'), vault, VAULT_ABI).flatMap((event) => (event.eventName === 'Withdrawn' ? [event.args] : []));
    const moved = eventsFrom(receiptOf('withdraw'), token, erc20Abi).flatMap((event) =>
      event.eventName === 'Transfer' && sameAddress(event.args.from, vault) ? [event.args] : [],
    );
    must(
      back.length === 1 &&
        back.every((event) => sameAddress(event.to, owner) && event.amount === left) &&
        moved.length === 1 &&
        moved.every((event) => sameAddress(event.to, owner) && event.value === left),
      `the withdraw receipt does not return the ${left} left in the vault to the owner`,
    );
    must(chain.vaultBalance === 0n, `the vault still holds ${chain.vaultBalance} base units of USDC after the withdrawal`);
    withdrawn = { to: owner, amount: left.toString() };
  }

  return {
    schema: 1,
    network: profile.network,
    chainId: profile.chainId,
    explorer: profile.explorer,
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
    ...(withdrawn === undefined ? {} : { withdrawn }),
    deposited: view.deposited.toString(),
    totalPaid: view.totalPaid.toString(),
    transactions,
    recordedAt: now.toISOString(),
  };
}

/** The saved Base mainnet run. Written phase by phase, so root, list and claimableAt stay null until the root is posted. */
export const BaseProofState = z.strictObject({
  chainId: z.literal(8453),
  factory: AddressField,
  vault: AddressField,
  owner: AddressField,
  agent: AddressField,
  paid: AddressField,
  refused: AddressField,
  root: Hash32.nullable(),
  published: z.string().max(10_000).nullable(),
  createdAtBlock: z.int().positive(),
  endTime: z.int().positive(),
  claimableAt: z.int().positive().nullable(),
  transactions: z
    .array(z.strictObject({ label: z.string().max(64), hash: Hash32, from: AddressField, gasUsed: z.string().regex(/^[0-9]+$/) }))
    .max(16),
});
export type BaseProofState = z.infer<typeof BaseProofState>;

/** The public record of the Base mainnet proof: the Base Sepolia record's lines, plus the owner's withdrawal. */
export type BaseProofRecord = Omit<ProofRecord, 'network' | 'chainId' | 'explorer' | 'transactions'> & {
  network: 'base';
  chainId: 8453;
  explorer: 'https://basescan.org';
  withdrawn: { to: string; amount: string };
  transactions: Array<{ label: ProofStep['label']; hash: string; block: number; gasUsed: number; from: string }>;
};

/** base-proof.json as buildBaseProofRecord writes it. Strict, so a file with any other field is refused. */
export const BaseProofRecordFile = z.strictObject({
  ...ProofRecordFile.shape,
  network: z.literal('base'),
  chainId: z.literal(8453),
  explorer: z.literal('https://basescan.org'),
  withdrawn: z.strictObject({ to: AddressField, amount: DecimalText }),
  transactions: z
    .array(
      z.strictObject({
        label: z.enum(BASE_PROOF_STEPS.map((step) => step.label) as [ProofStep['label'], ...ProofStep['label'][]]),
        hash: Hash32,
        block: z.int().positive(),
        gasUsed: z.int().positive(),
        from: AddressField,
      }),
    )
    .max(BASE_PROOF_STEPS.length),
});

/**
 * The public record of the Base mainnet proof, under the same checks as buildProofRecord with `profile`'s chain, USDC
 * and terms, plus the withdrawal: the owner took back exactly what the claim left, and the vault holds no USDC.
 *
 * @throws ProofFailed naming the first check the chain did not agree with, or a state with no posted root yet.
 */
export function buildBaseProofRecord(
  input: { state: BaseProofState; deployment: { factory: string }; chain: ProofChain & { vaultBalance: bigint }; now: Date },
  profile: RecordProfile,
): BaseProofRecord {
  const { state } = input;
  const { root, published, claimableAt } = state;
  must(root !== null && published !== null && claimableAt !== null, 'the proof state has no posted root yet');
  const recordState = { ...state, root, published, claimableAt };
  return recordFor({ ...input, state: recordState }, profile, { paid: state.paid, refused: state.refused }, BASE_NAMES) as BaseProofRecord;
}

export interface ProofCheck {
  /** The same on every run, so a failure names the check. */
  name: string;
  pass: boolean;
  /** What was checked when it passed, or what the chain showed instead. */
  detail: string;
}

/** What prove-vault verify reads: public chain data only, nothing from the private state file. */
export interface VerifyChain {
  /** The receipt of each transaction the record lists. One the chain does not know is left out. */
  receipts: readonly ProofReceipt[];
  /** The vault's state() today. */
  vaultState: ProofVaultState;
  claimedByPaid: bigint;
  claimedByRefused: bigint;
}

/**
 * Checks a committed proof record against public chain data, so anyone with an RPC URL and the two committed files can
 * check it: the record names the deployed factory; each of the five transactions has a successful receipt in the
 * recorded block, sent by the recorded sender, who is the owner or the agent its step needs, with the recorded gas used;
 * the createVault receipt holds the factory's VaultCreated naming the recorded vault, owner, agent, token and cap; the
 * postRoot receipt holds the vault's RootPosted with the recorded root and claimableAt; the claim receipt holds the
 * vault's Claimed paying the paid account the recorded amount and one Base Sepolia USDC Transfer of it from the vault to
 * that account; state() today shows the recorded token, owner, agent, cap and delay and totalPaid at least the recorded
 * one; claimed(paid account) is at least the recorded amount; claimed(refused account) is 0. Later claims may raise the
 * two running totals, so those are at least, not equal. Pure: prove-vault verify makes the reads.
 *
 * Not checked, because it needs the private claim list behind the root: that the refused account's claim reverts.
 *
 * @returns Every check, passed or not, in a fixed order. Nothing throws: a check that cannot be read fails.
 */
export function verifyProofRecord(record: ProofRecord, deployment: Deployment, chain: VerifyChain): ProofCheck[] {
  return checksFor(record, deployment, chain, SEPOLIA_PROFILE, SEPOLIA_NAMES);
}

// The checks verifyProofRecord documents, for one network's profile.
function checksFor(
  record: PublicProofRecord,
  deployment: { factory: string },
  chain: VerifyChain,
  profile: RecordProfile,
  names: RecordNames,
): ProofCheck[] {
  const checks: ProofCheck[] = [];
  const check = (name: string, passed: string, failureOf: () => string | null) => {
    let failure: string | null;
    try {
      failure = failureOf();
    } catch {
      failure = 'the record or the chain data could not be read';
    }
    checks.push({ name, pass: failure === null, detail: failure ?? passed });
  };
  const listed = (label: ProofStep['label']) => record.transactions.filter((tx) => tx.label === label);
  const receiptOf = (label: ProofStep['label']) => {
    const [tx, ...others] = listed(label);
    if (tx === undefined || others.length > 0) return undefined;
    return chain.receipts.find((receipt) => receipt.transactionHash.toLowerCase() === tx.hash.toLowerCase());
  };
  const paid = record.paid.account;
  const amount = BigInt(record.paid.amount);

  check('factory', `the record names the factory in ${profile.deploymentFile}, ${deployment.factory}`, () =>
    sameAddress(record.factory, deployment.factory) ? null : `the record names ${record.factory}, ${profile.deploymentFile} names ${deployment.factory}`,
  );

  for (const step of profile.steps) {
    const signer = step.signer === 'owner' ? record.owner : record.agent;
    const [tx] = listed(step.label);
    check(
      `${step.label} transaction`,
      `${tx?.hash} succeeded in block ${tx?.block}, sent by the ${step.signer} ${tx?.from}, ${tx?.gasUsed} gas`,
      () => {
        if (tx === undefined || listed(step.label).length !== 1) return `the record does not list exactly one ${step.label} transaction`;
        if (!sameAddress(tx.from, signer)) return `the record says ${tx.from} sent it, not the ${step.signer} ${signer}`;
        const receipt = receiptOf(step.label);
        if (receipt === undefined) return `the chain has no receipt for ${tx.hash}`;
        if (receipt.status !== 'success') return `${tx.hash} did not succeed`;
        if (receipt.blockNumber !== BigInt(tx.block)) return `${tx.hash} is in block ${receipt.blockNumber}, not ${tx.block}`;
        if (!sameAddress(receipt.from, tx.from)) return `${tx.hash} was sent by ${receipt.from}, not ${tx.from}`;
        if (receipt.gasUsed !== BigInt(tx.gasUsed)) return `${tx.hash} used ${receipt.gasUsed} gas, not ${tx.gasUsed}`;
        return null;
      },
    );
  }

  const noReceipt = (label: ProofLabel) => `there is no ${label} receipt to read`;
  check('VaultCreated', 'the factory logged VaultCreated for the recorded vault, owner, agent, token and cap', () => {
    const receipt = receiptOf('createVault');
    if (receipt === undefined) return noReceipt('createVault');
    const created = eventsFrom(receipt, deployment.factory, FACTORY_ABI).flatMap((event) => (event.eventName === 'VaultCreated' ? [event.args] : []));
    const [args] = created;
    if (args === undefined || created.length !== 1) return `the createVault receipt holds ${created.length} VaultCreated events from the factory, not one`;
    const differ = [
      sameAddress(args.vault, record.vault) ? [] : ['vault'],
      sameAddress(args.owner, record.owner) ? [] : ['owner'],
      sameAddress(args.agent, record.agent) ? [] : ['agent'],
      sameAddress(args.token, record.token) ? [] : ['token'],
      args.perWalletCap === BigInt(record.perWalletCap) ? [] : ['cap'],
    ].flat();
    return differ.length === 0 ? null : `VaultCreated names another ${differ.join(', ')} than the record`;
  });

  check('RootPosted', `the vault logged RootPosted for root ${record.root}, claimable at unix ${record.claimableAt}`, () => {
    const receipt = receiptOf('postRoot');
    if (receipt === undefined) return noReceipt('postRoot');
    const posted = eventsFrom(receipt, record.vault, VAULT_ABI).flatMap((event) => (event.eventName === 'RootPosted' ? [event.args] : []));
    const [args] = posted;
    if (args === undefined || posted.length !== 1) return `the postRoot receipt holds ${posted.length} RootPosted events from the vault, not one`;
    if (args.root.toLowerCase() !== record.root.toLowerCase()) return `RootPosted names root ${args.root}, not ${record.root}`;
    if (args.claimableAt !== BigInt(record.claimableAt)) return `RootPosted says claimable at ${args.claimableAt}, not ${record.claimableAt}`;
    return null;
  });

  check('Claimed', `the vault logged Claimed paying ${paid} ${amount}`, () => {
    const receipt = receiptOf('claim');
    if (receipt === undefined) return noReceipt('claim');
    const claimed = eventsFrom(receipt, record.vault, VAULT_ABI).flatMap((event) => (event.eventName === 'Claimed' ? [event.args] : []));
    const [args] = claimed;
    if (args === undefined || claimed.length !== 1) return `the claim receipt holds ${claimed.length} Claimed events from the vault, not one`;
    if (!sameAddress(args.account, paid) || args.amount !== amount) return `Claimed pays ${args.account} ${args.amount}, not ${paid} ${amount}`;
    return null;
  });

  check('USDC Transfer', `USDC moved ${amount} from the vault to ${paid}`, () => {
    if (!sameAddress(record.token, profile.usdc)) return `the record's token ${record.token} is not ${names.usdc}`;
    const receipt = receiptOf('claim');
    if (receipt === undefined) return noReceipt('claim');
    const moved = eventsFrom(receipt, record.token, erc20Abi).flatMap((event) =>
      event.eventName === 'Transfer' && sameAddress(event.args.from, record.vault) ? [event.args] : [],
    );
    const [args] = moved;
    if (args === undefined || moved.length !== 1) return `the claim receipt holds ${moved.length} USDC Transfers from the vault, not one`;
    if (!sameAddress(args.to, paid) || args.value !== amount) return `the USDC Transfer sends ${args.value} to ${args.to}, not ${amount} to ${paid}`;
    return null;
  });

  const view = chain.vaultState;
  check('vault terms', "the vault's state() shows the recorded token, owner, agent, cap and delay", () => {
    const differ = [
      sameAddress(view.token, record.token) ? [] : ['token'],
      sameAddress(view.owner, record.owner) ? [] : ['owner'],
      sameAddress(view.agent, record.agent) ? [] : ['agent'],
      view.perWalletCap === BigInt(record.perWalletCap) ? [] : ['cap'],
      view.rootDelay === record.rootDelaySeconds ? [] : ['delay'],
    ].flat();
    return differ.length === 0 ? null : `state() shows another ${differ.join(', ')} than the record`;
  });
  check('totalPaid', `state() shows ${view.totalPaid} paid, at least the recorded ${record.totalPaid}`, () =>
    view.totalPaid >= BigInt(record.totalPaid) ? null : `state() shows ${view.totalPaid} paid, less than the recorded ${record.totalPaid}`,
  );
  check('claimed(paid)', `claimed(${paid}) is ${chain.claimedByPaid}, at least the recorded ${amount}`, () =>
    chain.claimedByPaid >= amount ? null : `claimed(${paid}) is ${chain.claimedByPaid}, less than the recorded ${amount}`,
  );
  check('claimed(refused)', `claimed(${record.refused.account}) is 0`, () =>
    chain.claimedByRefused === 0n ? null : `claimed(${record.refused.account}) is ${chain.claimedByRefused}, not 0`,
  );
  return checks;
}

/**
 * The Base mainnet record checked against public chain data: every check verifyProofRecord makes, with `profile`'s
 * chain, USDC and steps (the withdrawal's receipt included), then that the withdraw receipt holds the vault's Withdrawn
 * and the USDC Transfer returning the recorded amount to the owner, and that the vault holds no USDC now.
 *
 * @returns Every check, passed or not, in a fixed order. Nothing throws: a check that cannot be read fails.
 */
export function verifyBaseProofRecord(
  record: BaseProofRecord,
  deployment: { factory: string },
  chain: VerifyChain & { vaultBalance: bigint },
  profile: RecordProfile,
): ProofCheck[] {
  const checks = checksFor(record, deployment, chain, profile, BASE_NAMES);
  const [tx] = record.transactions.filter((entry) => entry.label === 'withdraw');
  const receipt = tx === undefined ? undefined : chain.receipts.find((candidate) => candidate.transactionHash.toLowerCase() === tx.hash.toLowerCase());
  const amount = BigInt(record.withdrawn.amount);
  let failure: string | null = null;
  try {
    if (receipt === undefined) {
      failure = 'there is no withdraw receipt to read';
    } else {
      const back = eventsFrom(receipt, record.vault, VAULT_ABI).flatMap((event) => (event.eventName === 'Withdrawn' ? [event.args] : []));
      const moved = eventsFrom(receipt, record.token, erc20Abi).flatMap((event) =>
        event.eventName === 'Transfer' && sameAddress(event.args.from, record.vault) ? [event.args] : [],
      );
      const returned =
        back.length === 1 &&
        back.every((event) => sameAddress(event.to, record.withdrawn.to) && event.amount === amount) &&
        moved.length === 1 &&
        moved.every((event) => sameAddress(event.to, record.withdrawn.to) && event.value === amount);
      if (!sameAddress(record.withdrawn.to, record.owner)) failure = `the record says ${record.withdrawn.to} took the rest, not the owner`;
      else if (!returned) failure = `the withdraw receipt does not return ${amount} to the owner`;
    }
  } catch {
    failure = 'the record or the chain data could not be read';
  }
  checks.push({ name: 'Withdrawn', pass: failure === null, detail: failure ?? `the vault returned ${amount} to the owner ${record.withdrawn.to}` });
  const empty = chain.vaultBalance === 0n;
  checks.push({
    name: 'vault empty',
    pass: empty,
    detail: empty ? 'the vault holds no USDC' : `the vault still holds ${chain.vaultBalance} base units of USDC`,
  });
  return checks;
}

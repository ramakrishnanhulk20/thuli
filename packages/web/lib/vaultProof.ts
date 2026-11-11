import fs from 'node:fs';
import path from 'node:path';
import { BASE_SEPOLIA } from './contracts';
import { formatInt } from './format';

export const PROOF_STEP_LABELS = ['createVault', 'approve', 'deposit', 'postRoot', 'claim'] as const;
export type ProofStepLabel = (typeof PROOF_STEP_LABELS)[number];

const PROOF_EXPLORER = 'https://sepolia.basescan.org';
const TX_HASH = /^0x[0-9a-f]{64}$/;
// The record keeps checksummed addresses, so both cases are accepted here and links use the text as written.
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WHOLE_DIGITS = /^[0-9]+$/;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SECONDS_PER_HOUR = 3600;
const USDC_UNIT = 1_000_000n;

export interface ProofTransaction {
  label: ProofStepLabel;
  hash: string;
  block: number;
  gasUsed: number;
  from: string;
}

/** The public proof record that scripts write after the live run on Base Sepolia. */
export interface VaultProofRecord {
  schema: 1;
  network: string;
  chainId: 84532;
  explorer: string;
  factory: string;
  vault: string;
  token: string;
  owner: string;
  agent: string;
  /** USDC base units as text. */
  perWalletCap: string;
  rootDelaySeconds: number;
  root: string;
  claimableAt: number;
  paid: { account: string; amount: string };
  refused: { account: string; error: string };
  deposited: string;
  totalPaid: string;
  transactions: ProofTransaction[];
  recordedAt: string;
}

/** A record that failed a check. The message names the check, so a failed build says what to fix. */
export class VaultProofError extends Error {
  override name = 'VaultProofError';
}

function fail(message: string): never {
  throw new VaultProofError(`The vault proof record is not usable: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (!isObject(value)) return fail(`${key} is missing`);
  return value;
}

function text(parent: Record<string, unknown>, key: string): string {
  const value = parent[key];
  if (typeof value !== 'string') return fail(`${key} is not text`);
  return value;
}

function address(parent: Record<string, unknown>, key: string): string {
  const value = text(parent, key);
  if (!ADDRESS.test(value)) return fail(`${key} is not a 42 character address`);
  return value;
}

function digits(parent: Record<string, unknown>, key: string): string {
  const value = text(parent, key);
  if (!WHOLE_DIGITS.test(value)) return fail(`${key} is not whole digits`);
  return value;
}

function wholeNumber(parent: Record<string, unknown>, key: string, least: number): number {
  const value = parent[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < least) {
    return fail(`${key} is not a whole number of at least ${least}`);
  }
  return value;
}

/**
 * Checks a parsed record before the page uses it and returns it typed.
 *
 * @throws VaultProofError when the schema is not 1, the chain is not Base Sepolia (84532), the factory is not
 * BASE_SEPOLIA.factory (compared in lowercase), the explorer is not https://sepolia.basescan.org, a transaction hash is
 * not 0x and 64 lowercase hex characters, the five step labels are not present once each, or a value the page shows
 * (an address, an amount, the delay, the refusal error) is malformed.
 */
export function checkVaultProof(raw: unknown): VaultProofRecord {
  if (!isObject(raw)) return fail('it is not a JSON object');
  if (raw.schema !== 1) return fail(`schema is ${String(raw.schema)}, not 1`);
  if (raw.chainId !== BASE_SEPOLIA.chainId) return fail(`chainId is ${String(raw.chainId)}, not ${BASE_SEPOLIA.chainId}`);
  const factory = address(raw, 'factory');
  if (factory.toLowerCase() !== BASE_SEPOLIA.factory) return fail('factory is not the Base Sepolia factory in lib/contracts.ts');
  if (raw.explorer !== PROOF_EXPLORER) return fail(`explorer is not exactly ${PROOF_EXPLORER}`);

  address(raw, 'vault');
  address(raw, 'token');
  address(raw, 'owner');
  address(raw, 'agent');
  digits(raw, 'perWalletCap');
  digits(raw, 'deposited');
  digits(raw, 'totalPaid');
  wholeNumber(raw, 'rootDelaySeconds', 1);
  wholeNumber(raw, 'claimableAt', 1);
  text(raw, 'network');
  text(raw, 'root');
  text(raw, 'recordedAt');
  const paid = ownObject(raw, 'paid');
  address(paid, 'account');
  digits(paid, 'amount');
  const refused = ownObject(raw, 'refused');
  address(refused, 'account');
  if (!ERROR_NAME.test(text(refused, 'error'))) return fail('refused.error is not a plain error name');

  const transactions = raw.transactions;
  if (!Array.isArray(transactions) || transactions.length !== PROOF_STEP_LABELS.length) {
    return fail(`transactions does not hold exactly ${PROOF_STEP_LABELS.length} entries`);
  }
  const seen = new Set<string>();
  for (const entry of transactions as unknown[]) {
    if (!isObject(entry)) return fail('a transaction entry is not an object');
    const label = text(entry, 'label');
    if (!(PROOF_STEP_LABELS as readonly string[]).includes(label)) return fail(`transaction label "${label}" is not one of the five steps`);
    if (seen.has(label)) return fail(`transaction label "${label}" appears more than once`);
    seen.add(label);
    if (!TX_HASH.test(text(entry, 'hash'))) return fail(`the ${label} hash is not 0x and 64 lowercase hex characters`);
    wholeNumber(entry, 'block', 0);
    wholeNumber(entry, 'gasUsed', 0);
    address(entry, 'from');
  }
  return raw as unknown as VaultProofRecord;
}

/** Where the record lives, from the web package folder the build runs in. Tests pass their own path. */
export function vaultProofFile(): string {
  return path.join(process.cwd(), '..', 'contracts', 'deployments', 'base-sepolia-proof.json');
}

/** Reads and checks the record. A missing, unreadable or unusable file fails the build with a clear message. */
export function loadVaultProof(file = vaultProofFile()): VaultProofRecord {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    throw new VaultProofError('The vault proof record packages/contracts/deployments/base-sepolia-proof.json is missing or unreadable.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new VaultProofError('The vault proof record is not valid JSON.');
  }
  return checkVaultProof(parsed);
}

/**
 * USDC base units (6 decimals) as plain text, with BigInt arithmetic so nothing passes through floating point.
 * "1000000" is "1", "2500000" is "2.5", "1" is "0.000001".
 *
 * @throws RangeError when the text is not whole digits.
 */
export function formatUsdc6(units: string): string {
  if (!WHOLE_DIGITS.test(units)) throw new RangeError('formatUsdc6 needs whole digits');
  const value = BigInt(units);
  const whole = value / USDC_UNIT;
  const fraction = (value % USDC_UNIT).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

/** First 6 and last 4 characters of an address. */
export function shortAddress(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** First 10 and last 6 characters of a transaction hash. */
export function shortHash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

/** The root delay in hours: "1 hour", "2 hours". */
export function delayText(seconds: number): string {
  const hours = seconds / SECONDS_PER_HOUR;
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

export interface ProofStepView {
  label: ProofStepLabel;
  name: string;
  hash: string;
  shortHash: string;
  href: string;
  gas: string;
}

/** Everything the section prints, built from the checked record so the page holds no number of its own. */
export interface VaultProofView {
  delay: string;
  steps: ProofStepView[];
  paid: { short: string; amount: string };
  refused: { short: string; error: string };
  vaultUrl: string;
  factoryUrl: string;
}

export function describeVaultProof(record: VaultProofRecord): VaultProofView {
  const stepName = (label: ProofStepLabel): string => {
    switch (label) {
      case 'createVault':
        return 'Vault created';
      case 'approve':
        return 'Spending approved';
      case 'deposit':
        return `${formatUsdc6(record.deposited)} USDC deposited`;
      case 'postRoot':
        return 'List posted';
      case 'claim':
        return `${formatUsdc6(record.paid.amount)} USDC claimed`;
    }
  };
  return {
    delay: delayText(record.rootDelaySeconds),
    steps: record.transactions.map((transaction) => ({
      label: transaction.label,
      name: stepName(transaction.label),
      hash: transaction.hash,
      shortHash: shortHash(transaction.hash),
      href: `${record.explorer}/tx/${transaction.hash}`,
      gas: `${formatInt(transaction.gasUsed)} GAS`,
    })),
    paid: { short: shortAddress(record.paid.account), amount: formatUsdc6(record.paid.amount) },
    refused: { short: shortAddress(record.refused.account), error: record.refused.error },
    vaultUrl: `${record.explorer}/address/${record.vault}`,
    factoryUrl: `${BASE_SEPOLIA.explorer}/address/${BASE_SEPOLIA.factory}`,
  };
}

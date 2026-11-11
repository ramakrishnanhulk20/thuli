import fs from 'node:fs';
import path from 'node:path';
import { BASE_CHAIN, BASE_SEPOLIA_CHAIN, explorerTxUrl } from './explorer';
import { formatUsdc6 } from './vaultProof';

const NETWORKS = new Map<string, { name: string; chain: number }>([
  ['eip155:84532', { name: 'Base Sepolia', chain: BASE_SEPOLIA_CHAIN }],
  ['eip155:8453', { name: 'Base', chain: BASE_CHAIN }],
]);

const TX_HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WHOLE_DIGITS = /^[0-9]+$/;
const ACTIONS = ['full', 'partial', 'hold', 'exclude'] as const;
export type PaidAction = (typeof ACTIONS)[number];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** What the home page section prints about the paid route, taken from the API's two captured answers. */
export interface PaidExample {
  /** The price in USDC as plain text, such as "0.05". */
  price: string;
  networkId: string;
  networkName: string;
  testnet: boolean;
  checkedAt: string;
  checkedText: string;
  wallet: string;
  walletShort: string;
  action: PaidAction;
  rule: string;
  reason: string;
  transaction: string;
  transactionShort: string;
  settlementUrl: string;
}

/** A captured answer that failed a check. The message names the check, so a failed build says what to fix. */
export class PaidExampleError extends Error {
  override name = 'PaidExampleError';
}

function fail(message: string): never {
  throw new PaidExampleError(`The paid API example is not usable: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectAt(parent: Record<string, unknown>, key: string, where: string): Record<string, unknown> {
  const value = parent[key];
  return isObject(value) ? value : fail(`${where}.${key} is missing`);
}

function textAt(parent: Record<string, unknown>, key: string, where: string): string {
  const value = parent[key];
  return typeof value === 'string' && value !== '' ? value : fail(`${where}.${key} is not text`);
}

/** The day and minute of a time in UTC, such as "11 Nov 2026, 07:49 UTC". */
export function formatUtc(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) throw new RangeError('formatUtc needs an ISO date and time');
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${time.getUTCDate()} ${MONTHS[time.getUTCMonth()]} ${time.getUTCFullYear()}, ${pad(time.getUTCHours())}:${pad(time.getUTCMinutes())} UTC`;
}

/**
 * Checks the 402 terms and the paid answer, and returns what the section prints.
 *
 * @throws PaidExampleError when the terms are not x402 version 2 with exactly one "exact" entry whose amount is whole
 * digits on Base Sepolia or Base, or when the answer is missing a field the section shows, or its settlement
 * transaction is not 0x and 64 lowercase hex characters.
 */
export function checkPaidExample(terms: unknown, answer: unknown): PaidExample {
  if (!isObject(terms)) return fail('the payment terms are not a JSON object');
  if (terms.x402Version !== 2) return fail(`the terms are x402 version ${String(terms.x402Version)}, not 2`);
  const accepts = terms.accepts;
  if (!Array.isArray(accepts) || accepts.length !== 1) return fail('the terms do not hold exactly one accepted payment');
  const entry: unknown = accepts[0];
  if (!isObject(entry)) return fail('the accepted payment is not an object');
  if (entry.scheme !== 'exact') return fail(`the payment scheme is ${String(entry.scheme)}, not exact`);
  const amount = textAt(entry, 'amount', 'accepts[0]');
  if (!WHOLE_DIGITS.test(amount)) return fail('the amount is not whole digits');
  const networkId = textAt(entry, 'network', 'accepts[0]');
  const network = NETWORKS.get(networkId);
  if (network === undefined) return fail(`the network ${networkId} is not Base Sepolia or Base`);

  if (!isObject(answer)) return fail('the paid answer is not a JSON object');
  const wallet = textAt(answer, 'wallet', 'answer');
  if (!ADDRESS.test(wallet)) return fail('the answer wallet is not a 42 character address');
  const checkedAt = textAt(answer, 'checkedAt', 'answer');
  if (Number.isNaN(Date.parse(checkedAt))) return fail('checkedAt is not a date and time');
  const decision = objectAt(answer, 'decision', 'answer');
  const action = textAt(decision, 'action', 'decision');
  if (!(ACTIONS as readonly string[]).includes(action)) return fail(`the action ${action} is not one the rulebook gives`);
  if (typeof decision.shareBps !== 'number') return fail('decision.shareBps is not a number');
  const rule = textAt(decision, 'rule', 'decision');
  const reason = textAt(decision, 'reason', 'decision');
  if (!Array.isArray(decision.citedTxs)) return fail('decision.citedTxs is not a list');
  const payment = objectAt(answer, 'payment', 'answer');
  const transaction = textAt(payment, 'transaction', 'payment');
  if (!TX_HASH.test(transaction)) return fail('the settlement transaction is not 0x and 64 lowercase hex characters');

  return {
    price: formatUsdc6(amount),
    networkId,
    networkName: network.name,
    testnet: networkId === 'eip155:84532',
    checkedAt,
    checkedText: formatUtc(checkedAt),
    wallet,
    walletShort: `${wallet.slice(0, 6)}…${wallet.slice(-4)}`,
    action: action as PaidAction,
    rule,
    reason,
    transaction,
    transactionShort: `${transaction.slice(0, 10)}…${transaction.slice(-6)}`,
    settlementUrl: explorerTxUrl(network.chain, transaction),
  };
}

/** Where the API keeps its captured answers, from the web package folder the build runs in. */
export function examplesFolder(): string {
  return path.join(process.cwd(), '..', 'api', 'examples');
}

function readJson(file: string, what: string): unknown {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return fail(`${what} is missing or unreadable`);
  }
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return fail(`${what} is not valid JSON`);
  }
}

/** Reads and checks the two files. A missing, unreadable or unusable file fails the build with a clear message. */
export function loadPaidExample(folder = examplesFolder()): PaidExample {
  return checkPaidExample(
    readJson(path.join(folder, 'payment-required.json'), 'packages/api/examples/payment-required.json'),
    readJson(path.join(folder, 'paid-screen-response.json'), 'packages/api/examples/paid-screen-response.json'),
  );
}

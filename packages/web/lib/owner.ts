import { parseAbi, type Address } from 'viem';
import { STATE_SIGNATURE } from './attacks';
import { formatUtcMinute } from './campaign';
import { BASE_SEPOLIA, THULI_AGENT } from './contracts';
import { FACTORY_ABI, TOKEN_ABI, VAULT_WRITE_ABI } from './vaultAbi';

// The pure parts of the owner's setup page (/campaign/start): what the form accepts and says, the arguments of the three
// wallet calls, the sentence for every way a call can fail, the record kept in the browser, and which row the page opens
// at. The screens in components/owner draw these and decide nothing of their own.

/** USDC on Base Sepolia. test/owner.test.ts holds it to the token the proof record names. */
export const USDC_BASE_SEPOLIA = '0x036cbd53842c5426634e7929541ec2318f3dcf7e' as const;

export const STATE_ABI = parseAbi([STATE_SIGNATURE]);

// ---------------------------------------------------------------- money text

const UNIT = 1_000_000n;
// The same rule as parseUsdc in packages/core/src/money.ts: ASCII digits, no leading zero, at most 30 whole digits and
// 6 decimals. The core package cannot be imported into the site (its sources import with .ts endings, which the site's
// type check refuses), so test/owner.test.ts holds this copy to parseUsdc and formatUsdc input by input.
const AMOUNT = /^(0|[1-9][0-9]{0,29})(\.[0-9]{1,6})?$/;
const TOO_MANY_DECIMALS = /^(0|[1-9][0-9]{0,29})\.[0-9]{7,}$/;

export type AmountRead = { kind: 'ok'; units: bigint } | { kind: 'decimals' } | { kind: 'bad' };

export function readAmount(text: string): AmountRead {
  const trimmed = text.trim();
  const match = AMOUNT.exec(trimmed);
  if (match !== null) {
    const fraction = BigInt((match[2] ?? '.').slice(1).padEnd(6, '0'));
    return { kind: 'ok', units: BigInt(match[1] as string) * UNIT + fraction };
  }
  return TOO_MANY_DECIMALS.test(trimmed) ? { kind: 'decimals' } : { kind: 'bad' };
}

/** Base units as the text readAmount reads back: no trailing zeros, no dot for a whole number. */
export function formatAmount(units: bigint): string {
  const fraction = (units % UNIT).toString().padStart(6, '0').replace(/0+$/, '');
  const whole = (units / UNIT).toString();
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

// ---------------------------------------------------------------- the terms form

export const DELAY_CHOICES = [
  { label: '1 hour', seconds: 3600 },
  { label: '6 hours', seconds: 21_600 },
  { label: '24 hours', seconds: 86_400 },
  { label: '3 days', seconds: 259_200 },
] as const;

export const DEFAULT_CAP = '1';
export const DEFAULT_DEPOSIT = '20';
export const DEFAULT_DELAY = 3600;
const DEFAULT_DAYS = 30;

const DAY = 86_400;
const MAX_DAYS_AHEAD = 365;

export interface TermsForm {
  cap: string;
  deposit: string;
  endDate: string;
  delay: number;
}

export interface Terms {
  cap: bigint;
  deposit: bigint;
  endTime: number;
  rootDelay: number;
}

export type FieldKey = 'cap' | 'deposit' | 'end';

export const FIELD_ERRORS = {
  amount: 'Enter an amount above zero.',
  decimals: 'Use at most 6 decimal places.',
  cover: 'The deposit must cover at least one wallet.',
  tooSoon: 'The end must be at least a day away.',
  tooFar: 'The end can be at most 365 days away.',
} as const;

/** The day 30 days from now, as the date field writes it, counted in UTC to match the end of the day below. */
export function defaultEndDate(nowMilliseconds: number): string {
  return new Date(nowMilliseconds + DEFAULT_DAYS * DAY * 1000).toISOString().slice(0, 10);
}

const DATE_TEXT = /^(\d{4,6})-(\d{2})-(\d{2})$/;

/** 23:59:59 UTC of a day written as YYYY-MM-DD, in whole seconds, or null when the text is not a real day. */
export function endOfDay(dateText: string): number | null {
  const match = DATE_TEXT.exec(dateText);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const milliseconds = Date.UTC(year, month - 1, day, 23, 59, 59);
  const check = new Date(milliseconds);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return milliseconds / 1000;
}

export interface TermsCheck {
  terms: Terms | null;
  errors: Partial<Record<FieldKey, string>>;
}

function readPositive(text: string): { units: bigint } | { error: string } {
  const read = readAmount(text);
  if (read.kind === 'decimals') return { error: FIELD_ERRORS.decimals };
  if (read.kind === 'bad' || read.units === 0n) return { error: FIELD_ERRORS.amount };
  return { units: read.units };
}

/**
 * Checks the form and, when every field passes, gives the terms the vault is made with. `balance` is the wallet's USDC
 * read from the chain, or null before it has been read. `nowSeconds` is the clock in whole seconds.
 */
export function checkTerms(form: TermsForm, balance: bigint | null, nowSeconds: number): TermsCheck {
  const errors: Partial<Record<FieldKey, string>> = {};

  const cap = readPositive(form.cap);
  if ('error' in cap) errors.cap = cap.error;

  const deposit = readPositive(form.deposit);
  if ('error' in deposit) errors.deposit = deposit.error;
  else if ('units' in cap && deposit.units < cap.units) errors.deposit = FIELD_ERRORS.cover;
  else if (balance !== null && deposit.units > balance) errors.deposit = `This wallet holds only ${formatAmount(balance)} USDC.`;

  const endTime = endOfDay(form.endDate);
  if (endTime === null || endTime - nowSeconds < DAY) errors.end = FIELD_ERRORS.tooSoon;
  else if (endTime - nowSeconds > MAX_DAYS_AHEAD * DAY) errors.end = FIELD_ERRORS.tooFar;

  const delayKnown = DELAY_CHOICES.some((choice) => choice.seconds === form.delay);
  if (Object.keys(errors).length > 0 || !delayKnown || !('units' in cap) || !('units' in deposit) || endTime === null) {
    return { terms: null, errors };
  }
  return { terms: { cap: cap.units, deposit: deposit.units, endTime, rootDelay: form.delay }, errors };
}

/** How many wallets a deposit pays at the cap, rounded down. Both amounts must be above zero. */
export function coverageLine(cap: bigint, deposit: bigint): string {
  const wallets = deposit / cap;
  return `Covers ${wallets} ${wallets === 1n ? 'wallet' : 'wallets'} at the cap.`;
}

/** The waiting time in the words of the form's choices, or in whole days or hours when the chain holds another. */
export function describeDelay(seconds: number): string {
  const choice = DELAY_CHOICES.find((entry) => entry.seconds === seconds);
  if (choice !== undefined) return choice.label;
  if (seconds % DAY === 0) return `${seconds / DAY} ${seconds === DAY ? 'day' : 'days'}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} ${seconds === 3600 ? 'hour' : 'hours'}`;
  return `${seconds} seconds`;
}

export function termsSummary(terms: Terms): string {
  return `Cap ${formatAmount(terms.cap)} USDC, deposit ${formatAmount(terms.deposit)} USDC, ends ${formatUtcMinute(terms.endTime * 1000)}, waits ${describeDelay(terms.rootDelay)}.`;
}

// ---------------------------------------------------------------- the three wallet calls

/** The vault is made with the connected wallet as owner and Thuli as the only agent. */
export function createVaultRequest(owner: Address, terms: Terms) {
  return {
    address: BASE_SEPOLIA.factory,
    abi: FACTORY_ABI,
    functionName: 'createVault',
    args: [USDC_BASE_SEPOLIA, owner, THULI_AGENT, terms.cap, BigInt(terms.endTime), terms.rootDelay],
  } as const;
}

/** The allowance is exactly the deposit and never more. */
export function approveRequest(vault: Address, amount: bigint) {
  return { address: USDC_BASE_SEPOLIA, abi: TOKEN_ABI, functionName: 'approve', args: [vault, amount] } as const;
}

export function depositRequest(vault: Address, amount: bigint) {
  return { address: vault, abi: VAULT_WRITE_ABI, functionName: 'deposit', args: [amount] } as const;
}

// ---------------------------------------------------------------- why a call failed

export type CallStep = 'create' | 'approve' | 'deposit';

export const REASONS = {
  declined: 'You declined in your wallet. Nothing was sent.',
  noGas: 'This wallet has no Base Sepolia ETH to pay gas.',
  zeroCap: 'The cap must be above zero.',
  delayRange: 'The waiting time must be between 1 hour and 30 days.',
  endTooSoon: 'The end is too close: a list could not pay before it.',
  endTooFar: 'The end can be at most 365 days away.',
  token: "The token refused the transfer. Check the wallet's USDC balance.",
  network: 'The network refused this transaction. Nothing moved.',
  other: 'This could not be sent. Nothing moved.',
} as const;

/** Every sentence a failed call can put on the screen. A reason is never anything else. */
export type Reason = (typeof REASONS)[keyof typeof REASONS];

interface Link {
  name?: unknown;
  code?: unknown;
  data?: unknown;
  message?: unknown;
  shortMessage?: unknown;
  cause?: unknown;
}

// An error from viem or a wallet holds the error that caused it, and that one holds its own. Walking the chain by hand
// keeps this working across copies of viem and for plain objects a wallet throws.
function linksOf(error: unknown): Link[] {
  const links: Link[] = [];
  let current = error;
  for (let depth = 0; depth < 12 && typeof current === 'object' && current !== null; depth += 1) {
    if (links.includes(current as Link)) break;
    links.push(current as Link);
    current = (current as Link).cause;
  }
  return links;
}

const REVERT_REASONS = new Map<string, Reason>([
  ['ZeroCap', REASONS.zeroCap],
  ['RootDelayOutOfRange', REASONS.delayRange],
  ['EndTimeTooSoon', REASONS.endTooSoon],
  ['EndTimeOutOfRange', REASONS.endTooFar],
  ['SafeERC20FailedOperation', REASONS.token],
]);

const NO_GAS = /insufficient funds/i;

/**
 * The plain sentence for a call that threw. Never the raw error: a line of text or a stack would mean nothing to an
 * owner. A plain-text refusal counts as the token's only in the two calls that move tokens, because the vault itself
 * refuses with named errors.
 */
export function reasonFor(error: unknown, step: CallStep): Reason {
  const links = linksOf(error);
  if (links.some((link) => link.code === 4001 || link.code === 'ACTION_REJECTED' || link.name === 'UserRejectedRequestError')) return REASONS.declined;

  for (const link of links) {
    if (link.name !== 'ContractFunctionRevertedError') continue;
    const data = link.data as { errorName?: unknown } | undefined;
    const name = typeof data?.errorName === 'string' ? data.errorName : null;
    if (name === null) continue;
    const known = REVERT_REASONS.get(name);
    if (known !== undefined) return known;
    if (name === 'Error' && step !== 'create') return REASONS.token;
  }

  const noGas = links.some(
    (link) => link.name === 'InsufficientFundsError' || (typeof link.shortMessage === 'string' && NO_GAS.test(link.shortMessage)) || (typeof link.message === 'string' && NO_GAS.test(link.message)),
  );
  return noGas ? REASONS.noGas : REASONS.other;
}

// ---------------------------------------------------------------- the record kept in this browser

export interface ResumeRecord {
  vault: string;
  txHash: string;
  cap: string;
  deposit: string;
  endTime: number;
  rootDelay: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const BASE_UNITS = /^[1-9][0-9]{0,77}$/;

/** One record per wallet and chain, so another wallet in the same browser never sees this one. */
export function resumeKey(wallet: string, chainId: number): string {
  return `thuli.owner.v1.${wallet.toLowerCase()}.${chainId}`;
}

export function packResume(record: ResumeRecord): string {
  const { vault, txHash, cap, deposit, endTime, rootDelay } = record;
  return JSON.stringify({ vault, txHash, cap, deposit, endTime, rootDelay });
}

/** Reads a kept record back. Anything that is not exactly the six fields in the right shapes is no record at all. */
export function readResume(raw: string | null): ResumeRecord | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { vault, txHash, cap, deposit, endTime, rootDelay } = parsed as Record<string, unknown>;
  if (typeof vault !== 'string' || !ADDRESS.test(vault)) return null;
  if (typeof txHash !== 'string' || !HASH.test(txHash)) return null;
  if (typeof cap !== 'string' || !BASE_UNITS.test(cap)) return null;
  if (typeof deposit !== 'string' || !BASE_UNITS.test(deposit)) return null;
  if (typeof endTime !== 'number' || !Number.isSafeInteger(endTime) || endTime <= 0) return null;
  if (typeof rootDelay !== 'number' || !Number.isSafeInteger(rootDelay) || rootDelay <= 0) return null;
  return { vault, txHash, cap, deposit, endTime, rootDelay };
}

/** The part of localStorage the page uses, so a test can stand in for it. */
export interface KeptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The record for this wallet on this chain. A value that is not a record is removed, so it is refused once. Storage that
 * refuses to answer is the same as nothing kept.
 */
export function loadResume(storage: KeptStorage | null, wallet: string, chainId: number): ResumeRecord | null {
  if (storage === null) return null;
  try {
    const key = resumeKey(wallet, chainId);
    const raw = storage.getItem(key);
    const record = readResume(raw);
    if (raw !== null && record === null) storage.removeItem(key);
    return record;
  } catch {
    return null;
  }
}

export function saveResume(storage: KeptStorage | null, wallet: string, chainId: number, record: ResumeRecord): void {
  try {
    storage?.setItem(resumeKey(wallet, chainId), packResume(record));
  } catch {
    // A browser that refuses to keep the record still lets the owner finish the three steps.
  }
}

export function clearResume(storage: KeptStorage | null, wallet: string, chainId: number): void {
  try {
    storage?.removeItem(resumeKey(wallet, chainId));
  } catch {
    // Nothing was kept, or it could not be reached.
  }
}

// ---------------------------------------------------------------- what the chain says

/** The fields of the vault's state() this page reads. */
export interface VaultState {
  token: string;
  owner: string;
  agent: string;
  perWalletCap: bigint;
  endTime: bigint;
  rootDelay: number;
  deposited: bigint;
  totalPaid: bigint;
}

/** A kept record is believed only when the vault it names has this wallet as owner, this token and Thuli as agent. */
export function vaultMatches(state: VaultState, wallet: string): boolean {
  return (
    state.owner.toLowerCase() === wallet.toLowerCase() &&
    state.token.toLowerCase() === USDC_BASE_SEPOLIA &&
    state.agent.toLowerCase() === THULI_AGENT
  );
}

/** True when the read reached a node and the address answered with nothing or a refusal, so it is no vault. A request that failed to get there is not. */
export function isNotAVault(error: unknown): boolean {
  return linksOf(error).some((link) => link.name === 'ContractFunctionZeroDataError' || link.name === 'ContractFunctionRevertedError');
}

/** The terms as the chain holds them. Only the planned deposit comes from the record, because the chain has no plan. */
export function termsFromChain(state: VaultState, record: ResumeRecord): Terms {
  return { cap: state.perWalletCap, deposit: BigInt(record.deposit), endTime: Number(state.endTime), rootDelay: state.rootDelay };
}

/** What the vault holds for claims: everything deposited less everything paid out. */
export function holdsOf(state: VaultState): bigint {
  return state.deposited - state.totalPaid;
}

export type Stage = 'reading' | 'allow' | 'deposit' | 'funded';

/** Which row a created vault opens at, from what the chain says it holds and what the wallet has allowed it. */
export function stageFor(input: { deposited: bigint; planned: bigint; allowance: bigint | null }): Stage {
  if (input.deposited >= input.planned) return 'funded';
  if (input.allowance === null) return 'reading';
  return input.allowance >= input.planned ? 'deposit' : 'allow';
}

// ---------------------------------------------------------------- links and waiting

/** Links to the explorer the site's footer uses. A value that is not an address or a hash gets no link at all. */
export function explorerAddressUrl(address: string): string | null {
  return ADDRESS.test(address) ? `${BASE_SEPOLIA.explorer}/address/${address}` : null;
}

export function explorerTxUrl(hash: string): string | null {
  return HASH.test(hash) ? `${BASE_SEPOLIA.explorer}/tx/${hash}` : null;
}

/**
 * Reads again until the answer is enough, because the public endpoint can answer from a node a block behind the one that
 * took the last transaction. A read that throws counts as not yet. Gives the last answer either way.
 */
export async function settle<T>(
  read: () => Promise<T>,
  enough: (value: T) => boolean,
  options: { tries: number; wait: () => Promise<void> },
): Promise<{ ok: boolean; value: T | null }> {
  let last: T | null = null;
  for (let attempt = 0; attempt < options.tries; attempt += 1) {
    if (attempt > 0) await options.wait();
    try {
      last = await read();
      if (enough(last)) return { ok: true, value: last };
    } catch {
      // A failed read is the same as an answer that is not enough yet.
    }
  }
  return { ok: false, value: last };
}

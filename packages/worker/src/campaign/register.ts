import { decodeEventLog } from 'viem';
import { z } from 'zod';
import {
  CHAINS,
  CURRENT_RULEBOOK,
  DEFAULT_SETTINGS,
  formatUsdc,
  isPlainText,
  parseAddress,
  parseUsdc,
  Settings,
  type Address,
} from '@thuli/core';
import type { Campaign, CampaignInput } from '@thuli/store';
import { FACTORY_ABI } from '../vault/abi.ts';
import { loadVerifyRpc, ProofSetupError, type ProofReceipt } from '../vault/proof.ts';
import { campaignSettings } from './facts.ts';

/**
 * The vault's limits in seconds, named once. Each is a constant of the same name in
 * packages/contracts/src/ThuliVault.sol (MIN_ROOT_DELAY, MAX_ROOT_DELAY, MAX_END_AHEAD, MIN_CLAIM_WINDOW), and the
 * vault refuses anything outside them, so checking here only turns a revert into a plain refusal.
 */
export const VAULT_LIMITS = Object.freeze({
  minRootDelay: 3600,
  maxRootDelay: 30 * 86_400,
  maxEndAhead: 365 * 86_400,
  minClaimWindow: 3600,
});

// The store's own ranges for a campaign (packages/store/src/campaigns.ts). It checks them again on write; checking
// them first lets a refusal name the flag.
const MAX_SLOTS = 100_000;
const MAX_NAME_CHARS = 80;
const CAMPAIGN_ID = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_BIGINT_COLUMN = (1n << 63n) - 1n;

const BASE_SEPOLIA = CHAINS['base-sepolia'];
const DAY_SECONDS = 86_400;
const HOUR_SECONDS = 3600;
const WHOLE = /^[0-9]{1,9}$/;
const KEY = /^0x[0-9a-fA-F]{64}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const POSTGRES_URL = /^postgres(ql)?:\/\/\S+$/;
const MAX_SETTINGS_CHARS = 4096;
const IsoTime = z.iso.datetime({ offset: true });
const PartialSettings = Settings.partial();

export type Refusal = { ok: false; cause: string };
export type Checked<T> = { ok: true; value: T } | Refusal;

function refuse(cause: string): Refusal {
  return { ok: false, cause };
}

// Both sides through the one parser (C1, standard 2). Anything that is not an address matches nothing.
function sameAddress(left: string, right: string): boolean {
  try {
    return parseAddress(left) === parseAddress(right);
  } catch {
    return false;
  }
}

function usdcOf(text: string | undefined, flag: string): Checked<bigint> {
  let amount: bigint;
  try {
    amount = parseUsdc(text ?? '');
  } catch {
    return refuse(`${flag} is not a USDC amount`);
  }
  return amount === 0n ? refuse(`${flag} must be above zero`) : { ok: true, value: amount };
}

function wholeOf(text: string | undefined, fallback?: number): number | undefined {
  const value = text ?? (fallback === undefined ? undefined : String(fallback));
  return value !== undefined && WHOLE.test(value) ? Number(value) : undefined;
}

function rpcOf(env: Record<string, string | undefined>): Checked<{ rpcUrl: string; usesPublic: boolean }> {
  try {
    return { ok: true, value: loadVerifyRpc(env) };
  } catch (error) {
    if (error instanceof ProofSetupError) return refuse(error.message);
    throw error;
  }
}

/**
 * The token both scripts use, from the committed proof record, and only when it is the Base Sepolia USDC core knows:
 * the money code assumes its 6 decimals, so an edited record must not be able to pick another token.
 */
export function usdcFromRecord(recordToken: string): Checked<Address> {
  return sameAddress(recordToken, BASE_SEPOLIA.usdc)
    ? { ok: true, value: parseAddress(recordToken) }
    : refuse('the committed proof record names a token that is not Base Sepolia USDC');
}

/** What vault:create was asked for, checked. rootDelay is in seconds. */
export interface VaultArgs {
  agent: Address;
  cap: bigint;
  deposit: bigint;
  days: number;
  rootDelay: number;
  send: boolean;
}

/**
 * Checks vault:create's flags: --agent an address, --cap and --deposit USDC amounts above zero (parseUsdc), --days a
 * whole number from 1 to MAX_END_AHEAD in days (120 when left out), --delay-hours whole hours within the contract's
 * root delay range (1 when left out).
 */
export function checkVaultArgs(raw: {
  agent?: string;
  cap?: string;
  deposit?: string;
  days?: string;
  'delay-hours'?: string;
  send?: boolean;
}): Checked<VaultArgs> {
  let agent: Address;
  try {
    agent = parseAddress(raw.agent ?? '');
  } catch {
    return refuse('--agent is not an address');
  }
  const cap = usdcOf(raw.cap, '--cap');
  if (!cap.ok) return cap;
  const deposit = usdcOf(raw.deposit, '--deposit');
  if (!deposit.ok) return deposit;
  const days = wholeOf(raw.days, 120);
  if (days === undefined || days < 1 || days * DAY_SECONDS > VAULT_LIMITS.maxEndAhead) {
    return refuse(`--days must be a whole number from 1 to ${VAULT_LIMITS.maxEndAhead / DAY_SECONDS}`);
  }
  const hours = wholeOf(raw['delay-hours'], 1);
  if (hours === undefined) return refuse('--delay-hours must be a whole number of hours');
  const rootDelay = hours * HOUR_SECONDS;
  if (rootDelay < VAULT_LIMITS.minRootDelay || rootDelay > VAULT_LIMITS.maxRootDelay) {
    return refuse(`--delay-hours must be from ${VAULT_LIMITS.minRootDelay / HOUR_SECONDS} to ${VAULT_LIMITS.maxRootDelay / HOUR_SECONDS} hours`);
  }
  return { ok: true, value: { agent, cap: cap.value, deposit: deposit.value, days, rootDelay, send: raw.send === true } };
}

/** Everything vault:create sends, in the one address form. endTime is unix seconds. */
export interface VaultPlan {
  owner: Address;
  agent: Address;
  token: Address;
  cap: bigint;
  deposit: bigint;
  rootDelay: number;
  endTime: bigint;
}

/**
 * The vault vault:create would make for these flags, ending args.days after the chain's own time `now`.
 *
 * Refuses an agent that is the owner in any spelling (the vault refuses it too: the owner's cancel is the check on the
 * agent), an owner holding less USDC than the deposit, and an end too soon for a root posted at once to wait out its
 * delay and still leave the minimum claim window.
 */
export function vaultPlan(args: VaultArgs, chain: { owner: string; token: string; ownerUsdc: bigint; now: bigint }): Checked<VaultPlan> {
  const owner = parseAddress(chain.owner);
  const agent = parseAddress(args.agent);
  if (agent === owner) return refuse('the agent must not be the owner: the owner can cancel what the agent posts');
  if (chain.ownerUsdc < args.deposit) return refuse('the owner holds less USDC than --deposit');
  const endTime = chain.now + BigInt(args.days * DAY_SECONDS);
  if (endTime < chain.now + BigInt(args.rootDelay + VAULT_LIMITS.minClaimWindow)) {
    return refuse('--days is too short: the vault must run at least the root delay plus the minimum claim window');
  }
  return {
    ok: true,
    value: { owner, agent, token: parseAddress(chain.token), cap: args.cap, deposit: args.deposit, rootDelay: args.rootDelay, endTime },
  };
}

/**
 * vault:create's environment: PAYER_PRIVATE_KEY, the owner's key, and BASE_SEPOLIA_RPC_URL, or Base Sepolia's public
 * endpoint when it is unset. No other variable is read (C39).
 */
export function vaultEnv(env: Record<string, string | undefined>): Checked<{ payerKey: `0x${string}`; rpcUrl: string; usesPublic: boolean }> {
  const payerKey = (env.PAYER_PRIVATE_KEY ?? '').trim();
  if (!KEY.test(payerKey)) return refuse('PAYER_PRIVATE_KEY must be 0x and 64 hex characters');
  const rpc = rpcOf(env);
  if (!rpc.ok) return rpc;
  return { ok: true, value: { payerKey: payerKey as `0x${string}`, ...rpc.value } };
}

/** What campaign:create was asked for, checked. opens and closes are undefined when left to campaignFromVault. */
export interface CampaignArgs {
  id: string;
  name: string;
  vaultTx: `0x${string}`;
  reward: bigint;
  slots: number;
  partialShareBps: number;
  opens: Date | undefined;
  closes: Date | undefined;
  settings: Partial<Settings>;
  write: boolean;
}

function timeOf(text: string | undefined): Date | undefined | null {
  if (text === undefined) return undefined;
  if (!IsoTime.safeParse(text).success) return null;
  const time = new Date(text);
  return Number.isNaN(time.getTime()) ? null : time;
}

// The same check the worker screens a campaign with (campaignSettings), so a setting stored here is one it can run on.
function settingsOf(text: string | undefined, partialShareBps: number): Checked<Partial<Settings>> {
  if (text === undefined) return { ok: true, value: {} };
  let raw: unknown;
  try {
    raw = text.length > MAX_SETTINGS_CHARS ? undefined : JSON.parse(text);
  } catch {
    raw = undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return refuse('--settings must be a JSON object of screening settings');
  const refused = refuse('--settings holds a setting or value the campaign settings check refuses');
  const parsed = PartialSettings.safeParse(raw);
  if (!parsed.success) return refused;
  if (parsed.data.partialShareBps !== undefined && parsed.data.partialShareBps !== partialShareBps) {
    return refuse('--settings may name partialShareBps only as the same value as --partial-share-bps');
  }
  try {
    campaignSettings({ partialShareBps, settings: parsed.data });
  } catch {
    return refused;
  }
  return { ok: true, value: parsed.data };
}

/**
 * Checks campaign:create's flags against the store's own ranges, so a refusal names the flag: the id and name rules,
 * --vault-tx a transaction hash, --reward a USDC amount above zero, --slots 1 to 100,000, --partial-share-bps 1 to
 * 9,999 (the rulebook default when left out), --opens and --closes ISO 8601 times with a zone, and --settings a JSON
 * object the campaign settings check accepts.
 */
export function checkCampaignArgs(raw: {
  id?: string;
  name?: string;
  'vault-tx'?: string;
  reward?: string;
  slots?: string;
  'partial-share-bps'?: string;
  opens?: string;
  closes?: string;
  settings?: string;
  write?: boolean;
}): Checked<CampaignArgs> {
  const id = raw.id ?? '';
  if (!CAMPAIGN_ID.test(id)) return refuse('--id must be 1 to 128 letters, digits, dots, dashes or underscores');
  const name = raw.name ?? '';
  if (name.length === 0 || [...name].length > MAX_NAME_CHARS || !isPlainText(name)) {
    return refuse(`--name must be plain text of 1 to ${MAX_NAME_CHARS} characters`);
  }
  const vaultTx = raw['vault-tx'] ?? '';
  if (!TX_HASH.test(vaultTx)) return refuse('--vault-tx must be 0x and 64 hex characters');
  const reward = usdcOf(raw.reward, '--reward');
  if (!reward.ok) return reward;
  const slots = wholeOf(raw.slots);
  if (slots === undefined || slots < 1 || slots > MAX_SLOTS) {
    return refuse(`--slots must be a whole number from 1 to ${MAX_SLOTS.toLocaleString('en-US')}`);
  }
  const partialShareBps = wholeOf(raw['partial-share-bps'], DEFAULT_SETTINGS.partialShareBps);
  if (partialShareBps === undefined || partialShareBps < 1 || partialShareBps > 9_999) {
    return refuse('--partial-share-bps must be a whole number from 1 to 9,999');
  }
  const opens = timeOf(raw.opens);
  if (opens === null) return refuse('--opens must be an ISO 8601 time with a zone, such as 2026-11-12T09:00:00Z');
  const closes = timeOf(raw.closes);
  if (closes === null) return refuse('--closes must be an ISO 8601 time with a zone, such as 2026-11-12T09:00:00Z');
  const settings = settingsOf(raw.settings, partialShareBps);
  if (!settings.ok) return settings;
  return {
    ok: true,
    value: {
      id,
      name,
      vaultTx: vaultTx.toLowerCase() as `0x${string}`,
      reward: reward.value,
      slots,
      partialShareBps,
      opens,
      closes,
      settings: settings.value,
      write: raw.write === true,
    },
  };
}

/**
 * campaign:create's environment: BASE_SEPOLIA_RPC_URL, or Base Sepolia's public endpoint when it is unset, and
 * DATABASE_URL only when it writes. No variable ending in PRIVATE_KEY is read (C39).
 */
export function campaignEnv(
  env: Record<string, string | undefined>,
  write: boolean,
): Checked<{ rpcUrl: string; usesPublic: boolean; databaseUrl: string | null }> {
  const rpc = rpcOf(env);
  if (!rpc.ok) return rpc;
  if (!write) return { ok: true, value: { ...rpc.value, databaseUrl: null } };
  const databaseUrl = (env.DATABASE_URL ?? '').trim();
  if (!POSTGRES_URL.test(databaseUrl)) return refuse('DATABASE_URL must be set to write the campaign: a postgres:// or postgresql:// URL');
  return { ok: true, value: { ...rpc.value, databaseUrl } };
}

/** A vault's terms as its factory logged them at creation. endTime is unix seconds, rootDelay seconds. */
export interface CreatedVault {
  vault: Address;
  owner: Address;
  agent: Address;
  token: Address;
  perWalletCap: bigint;
  endTime: bigint;
  rootDelay: number;
  block: bigint;
}

/**
 * The vault a createVault transaction made, read from its receipt alone. Refuses unless the transaction succeeded, was
 * sent to `factory`, and holds exactly one VaultCreated log that `factory` emitted. The log is decoded by the ABI, so
 * each value is an address or an integer of its Solidity width; the cap must be above zero, the delay within the
 * contract's range and the block a number the store can hold (C34).
 */
export function vaultCreatedIn(receipt: ProofReceipt, factory: string): Checked<CreatedVault> {
  if (receipt.status !== 'success') return refuse('the vault transaction did not succeed');
  if (receipt.to === null || !sameAddress(receipt.to, factory)) {
    return refuse('the vault transaction was not sent to the factory in base-sepolia.json');
  }
  const created = receipt.logs.flatMap((log) => {
    const [signature, ...rest] = log.topics;
    if (signature === undefined || !sameAddress(log.address, factory)) return [];
    try {
      const event = decodeEventLog({ abi: FACTORY_ABI, topics: [signature, ...rest], data: log.data, strict: true });
      return event.eventName === 'VaultCreated' ? [event.args] : [];
    } catch {
      return [];
    }
  });
  const [args] = created;
  if (args === undefined || created.length !== 1) {
    return refuse(`the vault transaction holds ${created.length} VaultCreated logs from the factory, not one`);
  }
  if (
    args.perWalletCap === 0n ||
    args.endTime === 0n ||
    args.rootDelay < VAULT_LIMITS.minRootDelay ||
    args.rootDelay > VAULT_LIMITS.maxRootDelay ||
    receipt.blockNumber < 1n ||
    receipt.blockNumber > MAX_BIGINT_COLUMN
  ) {
    return refuse('the VaultCreated log holds terms outside what the contract allows');
  }
  return {
    ok: true,
    value: {
      vault: parseAddress(args.vault),
      owner: parseAddress(args.owner),
      agent: parseAddress(args.agent),
      token: parseAddress(args.token),
      perWalletCap: args.perWalletCap,
      endTime: args.endTime,
      rootDelay: args.rootDelay,
      block: receipt.blockNumber,
    },
  };
}

/** What campaign:create reads from the chain and the two committed records. */
export interface VaultOnChain {
  /** The factory in packages/contracts/deployments/base-sepolia.json. */
  factory: string;
  /** The chain's USDC, from the committed proof record. */
  usdc: string;
  /** The receipt of --vault-tx. */
  receipt: ProofReceipt;
  /** The vault's state() now. */
  state: { token: string; owner: string; agent: string; perWalletCap: bigint; rootDelay: number; deposited: bigint; totalPaid: bigint };
  /** The vault's MIN_CLAIM_WINDOW(), in seconds. */
  minClaimWindow: number;
}

/**
 * A campaign ready for the store's createCampaign, and the vault figures campaign:create prints. holds is what the
 * vault still has to pay (deposited less paid) and promised is reward times slots.
 */
export interface Registration {
  campaign: CampaignInput;
  created: CreatedVault;
  deposited: bigint;
  holds: bigint;
  promised: bigint;
  latestClose: Date;
}

/**
 * The campaign for a vault, every vault term taken from the chain and none typed. The vault's terms come from its
 * VaultCreated log (vaultCreatedIn), and its state() now must agree on token, owner, agent, cap and delay, every
 * address compared through parseAddress (C1). Any refusal writes nothing (fail closed).
 *
 * Refuses a token that is not the chain's USDC, because the money code assumes 6 decimals; a MIN_CLAIM_WINDOW or an
 * end time no deployed vault could have; a state() paying more than was deposited; a reward above the cap; a vault
 * that has ended; closes after the end less the root delay less MIN_CLAIM_WINDOW, the latest moment a list posted
 * then could still pay; and opens at or after closes.
 *
 * Defaults: opens `now`, closes at that latest moment, chain 84532, status open, the current rulebook, vaultBlock from
 * the receipt. createdAt is `now`, which the store does not count as a term.
 */
export function campaignFromVault(args: CampaignArgs, onChain: VaultOnChain, now: Date): Checked<Registration> {
  const read = vaultCreatedIn(onChain.receipt, onChain.factory);
  if (!read.ok) return read;
  const created = read.value;
  const { state } = onChain;
  const checks: [string, boolean][] = [
    ['token', sameAddress(state.token, created.token)],
    ['owner', sameAddress(state.owner, created.owner)],
    ['agent', sameAddress(state.agent, created.agent)],
    ['cap', state.perWalletCap === created.perWalletCap],
    ['delay', state.rootDelay === created.rootDelay],
  ];
  const differs = checks.find(([, same]) => !same);
  if (differs !== undefined) return refuse(`the vault's state() disagrees with its VaultCreated log on ${differs[0]}`);
  if (!sameAddress(created.token, onChain.usdc)) {
    return refuse('the vault pays a token that is not Base Sepolia USDC, and campaign amounts assume its 6 decimals');
  }
  const window = onChain.minClaimWindow;
  if (!Number.isSafeInteger(window) || window < 1 || window > VAULT_LIMITS.maxRootDelay) {
    return refuse("the vault's MIN_CLAIM_WINDOW is outside what the contract allows");
  }
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  // No vault can end more than MAX_END_AHEAD after it was made, which was before now.
  if (created.endTime > nowSeconds + BigInt(VAULT_LIMITS.maxEndAhead)) return refuse('the VaultCreated log holds terms outside what the contract allows');
  if (state.totalPaid < 0n || state.totalPaid > state.deposited) return refuse("the vault's state() reports more paid than deposited");
  if (args.reward > created.perWalletCap) return refuse('--reward is above the vault per-wallet cap, so the vault could never pay it in full');
  if (created.endTime <= nowSeconds) return refuse('the vault has ended, so it can pay nothing more');

  const latestClose = new Date(Number(created.endTime - BigInt(created.rootDelay) - BigInt(window)) * 1000);
  const closesAt = args.closes ?? latestClose;
  if (closesAt.getTime() > latestClose.getTime()) {
    return refuse(`--closes is after ${latestClose.toISOString()}, the latest moment a list posted then could still pay`);
  }
  const opensAt = args.opens ?? now;
  if (opensAt.getTime() >= closesAt.getTime()) return refuse('--opens must be before closes');

  return {
    ok: true,
    value: {
      campaign: {
        id: args.id,
        name: args.name,
        chain: BASE_SEPOLIA.id,
        vault: created.vault,
        token: created.token,
        owner: created.owner,
        agent: created.agent,
        rewardPerWallet: args.reward.toString(),
        perWalletCap: created.perWalletCap.toString(),
        partialShareBps: args.partialShareBps,
        maxSlots: args.slots,
        rulebook: CURRENT_RULEBOOK,
        settings: args.settings,
        status: 'open',
        opensAt,
        closesAt,
        createdAt: now,
        vaultBlock: created.block,
      },
      created,
      deposited: state.deposited,
      holds: state.deposited - state.totalPaid,
      promised: args.reward * BigInt(args.slots),
      latestClose,
    },
  };
}

const field = (label: string, value: string) => `${label.padEnd(18)} ${value}`;

/** A stored campaign, one field a line. Built field by field because the row holds a bigint, which JSON cannot carry. */
export function campaignLines(campaign: Campaign): string[] {
  const usdc = (units: string) => `${formatUsdc(BigInt(units))} USDC (${units} base units)`;
  return [
    field('id', campaign.id),
    field('name', campaign.name),
    field('chain', String(campaign.chain)),
    field('vault', campaign.vault),
    field('token', campaign.token),
    field('owner', campaign.owner),
    field('agent', campaign.agent),
    field('reward per wallet', usdc(campaign.rewardPerWallet)),
    field('per-wallet cap', usdc(campaign.perWalletCap)),
    field('partial share', `${campaign.partialShareBps} bps`),
    field('max slots', String(campaign.maxSlots)),
    field('rulebook', String(campaign.rulebook)),
    field('settings', JSON.stringify(campaign.settings)),
    field('status', campaign.status),
    field('opens at', campaign.opensAt.toISOString()),
    field('closes at', campaign.closesAt.toISOString()),
    field('created at', campaign.createdAt.toISOString()),
    field('vault block', campaign.vaultBlock === null ? 'none recorded' : campaign.vaultBlock.toString()),
  ];
}

/** True for the store's message when the campaigns table or one of its columns is missing: the schema is behind. */
export function needsMigration(message: string): boolean {
  return /\((42P01|42703)\)$/.test(message);
}

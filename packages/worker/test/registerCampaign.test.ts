// Not covered here: the reads and the three sends the two scripts make on Base Sepolia (`npm run campaign:create` and
// `npm run vault:create` without --send are run against the live chain; --send is run by hand), Postgres itself (the
// store's own tests), and how the worker later screens a registered campaign.
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHAINS, CURRENT_RULEBOOK, DEFAULT_SETTINGS, parseAddress, type Address } from '@thuli/core';
import { createCampaign, getCampaign, migrate, openMemoryDb, type Db } from '@thuli/store';
import {
  campaignEnv,
  campaignFromVault,
  campaignLines,
  checkCampaignArgs,
  checkVaultArgs,
  needsMigration,
  usdcFromRecord,
  VAULT_LIMITS,
  vaultCreatedIn,
  vaultEnv,
  vaultPlan,
  type CampaignArgs,
  type VaultOnChain,
} from '../src/campaign/register.ts';
import { FACTORY_ABI } from '../src/vault/abi.ts';
import type { ProofLog, ProofReceipt } from '../src/vault/proof.ts';

const address = (tag: string) => parseAddress(`0x${tag.repeat(20)}`);
const FACTORY = address('fa');
const OTHER_FACTORY = address('fb');
const VAULT = address('a1');
const OWNER = address('0e');
const AGENT = address('a9');
const USDC = parseAddress(CHAINS['base-sepolia'].usdc);
const NOT_USDC = address('70');
const VAULT_TX = `0x${'da'.repeat(32)}` as const;
const NOW = new Date('2026-11-11T06:00:00.000Z');
const NOW_SECONDS = BigInt(NOW.getTime() / 1000);
const END = NOW_SECONDS + 7n * 86_400n;
const DELAY = 3600;
const CAP = 1_000_000n;
const LATEST_CLOSE = new Date(Number(END - BigInt(DELAY) - BigInt(VAULT_LIMITS.minClaimWindow)) * 1000);

// encodeEventTopics is typed for log filters, where a topic may be null or a list; every indexed argument is set here.
const filled = (topics: readonly unknown[]) => topics as ProofLog['topics'];

function vaultCreated(change: Partial<{ emitter: Address; vault: Address; owner: Address; agent: Address; token: Address; cap: bigint; end: bigint; delay: number }> = {}): ProofLog {
  const terms = { emitter: FACTORY, vault: VAULT, owner: OWNER, agent: AGENT, token: USDC, cap: CAP, end: END, delay: DELAY, ...change };
  return {
    address: terms.emitter,
    topics: filled(encodeEventTopics({ abi: FACTORY_ABI, eventName: 'VaultCreated', args: { vault: terms.vault, owner: terms.owner, agent: terms.agent } })),
    data: encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'uint32' }],
      [terms.token, terms.cap, terms.end, terms.delay],
    ),
  };
}

function receipt(change: Partial<ProofReceipt> = {}): ProofReceipt {
  return {
    transactionHash: VAULT_TX,
    status: 'success',
    blockNumber: 57_248_098n,
    gasUsed: 1_686_371n,
    from: OWNER.toLowerCase(),
    to: FACTORY.toLowerCase(),
    // An unrelated log first, as OwnershipTransferred from the new vault would be.
    logs: [{ address: VAULT, topics: [`0x${'11'.repeat(32)}` as Hex], data: '0x' }, vaultCreated()],
    ...change,
  };
}

function onChain(change: Partial<VaultOnChain> = {}, state: Partial<VaultOnChain['state']> = {}): VaultOnChain {
  return {
    factory: FACTORY,
    usdc: USDC,
    receipt: receipt(),
    state: { token: USDC, owner: OWNER, agent: AGENT, perWalletCap: CAP, rootDelay: DELAY, deposited: 2n * CAP, totalPaid: CAP, ...state },
    minClaimWindow: VAULT_LIMITS.minClaimWindow,
    ...change,
  };
}

const RAW_CAMPAIGN = { id: 'proof-vault-dry-run', name: 'Dry run', 'vault-tx': VAULT_TX, reward: '1', slots: '2' };

function campaignArgs(change: Record<string, string | boolean> = {}): CampaignArgs {
  const checked = checkCampaignArgs({ ...RAW_CAMPAIGN, ...change });
  if (!checked.ok) throw new Error(`fixture refused: ${checked.cause}`);
  return checked.value;
}

// Records every variable name a function reads, and whether it listed them all, which would let it see any name.
function watchedEnv(values: Record<string, string>) {
  const read = new Set<string>();
  const env = new Proxy(values, {
    get(target, key) {
      if (typeof key === 'string') read.add(key);
      return target[key as string];
    },
    ownKeys(target) {
      read.add('*every variable*');
      return Reflect.ownKeys(target);
    },
  });
  return { env: env as Record<string, string | undefined>, read };
}

const KEY = `0x${'4b'.repeat(32)}`;

describe('the committed token', () => {
  it('takes USDC from the committed record only when it is the chain USDC, so an edited record cannot pick the token', () => {
    expect(usdcFromRecord(USDC.toLowerCase())).toEqual({ ok: true, value: USDC });
    expect(usdcFromRecord(NOT_USDC)).toEqual({ ok: false, cause: 'the committed proof record names a token that is not Base Sepolia USDC' });
  });
});

describe('vault:create arguments', () => {
  it('reads the amounts with parseUsdc and defaults to 120 days and a one hour delay', () => {
    expect(checkVaultArgs({ agent: AGENT.toLowerCase(), cap: '0.5', deposit: '1' })).toEqual({
      ok: true,
      value: { agent: AGENT, cap: 500_000n, deposit: 1_000_000n, days: 120, rootDelay: 3600, send: false },
    });
    expect(checkVaultArgs({ agent: AGENT, cap: '1', deposit: '2', days: '365', 'delay-hours': '720', send: true })).toMatchObject({
      ok: true,
      value: { days: 365, rootDelay: VAULT_LIMITS.maxRootDelay, send: true },
    });
  });

  it.each([
    ['an agent that is not an address', { agent: '0x1234' }, '--agent is not an address'],
    ['a cap of zero', { cap: '0' }, '--cap must be above zero'],
    ['a cap that is not a USDC amount', { cap: '1.0000001' }, '--cap is not a USDC amount'],
    ['a deposit of zero', { deposit: '0.000000' }, '--deposit must be above zero'],
    ['a delay under the contract minimum', { 'delay-hours': '0' }, '--delay-hours must be from 1 to 720 hours'],
    ['a delay over the contract maximum', { 'delay-hours': '721' }, '--delay-hours must be from 1 to 720 hours'],
    ['a delay that is not whole hours', { 'delay-hours': '1.5' }, '--delay-hours must be a whole number of hours'],
    ['more than 365 days', { days: '366' }, '--days must be a whole number from 1 to 365'],
    ['zero days', { days: '0' }, '--days must be a whole number from 1 to 365'],
  ])('refuses %s', (_what, change, cause) => {
    expect(checkVaultArgs({ agent: AGENT, cap: '0.5', deposit: '1', ...change })).toEqual({ ok: false, cause });
  });
});

describe('the vault:create plan', () => {
  const args = () => {
    const checked = checkVaultArgs({ agent: AGENT, cap: '0.5', deposit: '1' });
    if (!checked.ok) throw new Error(checked.cause);
    return checked.value;
  };
  const chain = { owner: OWNER.toLowerCase(), token: USDC.toLowerCase(), ownerUsdc: 2_000_000n, now: NOW_SECONDS };

  it('ends the given number of days after the chain time, in the one address form', () => {
    expect(vaultPlan(args(), chain)).toEqual({
      ok: true,
      value: { owner: OWNER, agent: AGENT, token: USDC, cap: 500_000n, deposit: 1_000_000n, rootDelay: 3600, endTime: NOW_SECONDS + 120n * 86_400n },
    });
  });

  it('refuses an agent that is the owner, whatever its spelling (C1)', () => {
    expect(vaultPlan({ ...args(), agent: OWNER }, { ...chain, owner: OWNER.toUpperCase().replace('0X', '0x') })).toEqual({
      ok: false,
      cause: 'the agent must not be the owner: the owner can cancel what the agent posts',
    });
  });

  it('refuses an owner holding less USDC than the deposit', () => {
    expect(vaultPlan(args(), { ...chain, ownerUsdc: 999_999n })).toEqual({ ok: false, cause: 'the owner holds less USDC than --deposit' });
  });

  it('refuses an end too soon for a root posted at the start to pay for an hour', () => {
    const shortRun = { ...args(), days: 30, rootDelay: VAULT_LIMITS.maxRootDelay };
    expect(vaultPlan(shortRun, chain)).toEqual({
      ok: false,
      cause: '--days is too short: the vault must run at least the root delay plus the minimum claim window',
    });
  });

  it('reads only PAYER_PRIVATE_KEY and the RPC, and names a bad key without printing it (C39, C40)', () => {
    const { env, read } = watchedEnv({ PAYER_PRIVATE_KEY: KEY, WORKER_PRIVATE_KEY: `0x${'77'.repeat(32)}` });
    expect(vaultEnv(env)).toEqual({ ok: true, value: { payerKey: KEY, rpcUrl: 'https://sepolia.base.org', usesPublic: true } });
    expect([...read].sort()).toEqual(['BASE_SEPOLIA_RPC_URL', 'PAYER_PRIVATE_KEY']);
    const bad = vaultEnv({ PAYER_PRIVATE_KEY: 'secret-not-a-key' });
    expect(bad).toEqual({ ok: false, cause: 'PAYER_PRIVATE_KEY must be 0x and 64 hex characters' });
  });
});

describe('campaign:create arguments', () => {
  it('fills the defaults: the rulebook partial share, no settings changed, opens and closes left to the vault', () => {
    expect(checkCampaignArgs(RAW_CAMPAIGN)).toEqual({
      ok: true,
      value: {
        id: 'proof-vault-dry-run',
        name: 'Dry run',
        vaultTx: VAULT_TX,
        reward: 1_000_000n,
        slots: 2,
        partialShareBps: DEFAULT_SETTINGS.partialShareBps,
        opens: undefined,
        closes: undefined,
        settings: {},
        write: false,
      },
    });
  });

  it.each([
    ['an id the store cannot hold', { id: 'not an id!' }, '--id must be 1 to 128 letters, digits, dots, dashes or underscores'],
    ['an empty name', { name: '' }, '--name must be plain text of 1 to 80 characters'],
    ['a name with markup', { name: '<b>Drop</b>' }, '--name must be plain text of 1 to 80 characters'],
    ['a transaction that is not a hash', { 'vault-tx': '0x1234' }, '--vault-tx must be 0x and 64 hex characters'],
    ['a reward of zero', { reward: '0' }, '--reward must be above zero'],
    ['a reward that is not a USDC amount', { reward: 'one' }, '--reward is not a USDC amount'],
    ['zero slots', { slots: '0' }, '--slots must be a whole number from 1 to 100,000'],
    ['more slots than the store holds', { slots: '100001' }, '--slots must be a whole number from 1 to 100,000'],
    ['a partial share of the whole reward', { 'partial-share-bps': '10000' }, '--partial-share-bps must be a whole number from 1 to 9,999'],
    ['an opening time that is not ISO 8601', { opens: 'tomorrow' }, '--opens must be an ISO 8601 time with a zone, such as 2026-11-12T09:00:00Z'],
    ['settings that are not a JSON object', { settings: '[1]' }, '--settings must be a JSON object of screening settings'],
    ['an unknown setting', { settings: '{"payEveryone":true}' }, '--settings holds a setting or value the campaign settings check refuses'],
    ['a setting out of range', { settings: '{"groupMinSize":1}' }, '--settings holds a setting or value the campaign settings check refuses'],
    ['a second partial share in the settings', { settings: '{"partialShareBps":2500}' }, '--settings may name partialShareBps only as the same value as --partial-share-bps'],
  ])('refuses %s', (_what, change, cause) => {
    expect(checkCampaignArgs({ ...RAW_CAMPAIGN, ...change })).toEqual({ ok: false, cause });
  });

  it('keeps settings the check accepts, and a partial share that agrees with the flag', () => {
    const args = campaignArgs({ 'partial-share-bps': '2500', settings: '{"minWalletAgeDays":60,"partialShareBps":2500}' });
    expect(args.settings).toEqual({ minWalletAgeDays: 60, partialShareBps: 2500 });
  });

  it('reads no variable ending in PRIVATE_KEY, and DATABASE_URL only with --write (C39)', () => {
    const values = { BASE_SEPOLIA_RPC_URL: 'https://rpc.example/k', DATABASE_URL: 'postgres://u:p@db.example/t', PAYER_PRIVATE_KEY: KEY };
    const dry = watchedEnv(values);
    expect(campaignEnv(dry.env, false)).toEqual({ ok: true, value: { rpcUrl: 'https://rpc.example/k', usesPublic: false, databaseUrl: null } });
    expect([...dry.read]).toEqual(['BASE_SEPOLIA_RPC_URL']);
    const write = watchedEnv(values);
    expect(campaignEnv(write.env, true)).toMatchObject({ ok: true, value: { databaseUrl: 'postgres://u:p@db.example/t' } });
    expect([...write.read].sort()).toEqual(['BASE_SEPOLIA_RPC_URL', 'DATABASE_URL']);
    expect(campaignEnv({}, false)).toMatchObject({ ok: true, value: { rpcUrl: 'https://sepolia.base.org', usesPublic: true } });
    expect(campaignEnv({}, true)).toEqual({ ok: false, cause: 'DATABASE_URL must be set to write the campaign: a postgres:// or postgresql:// URL' });
  });
});

describe('reading the vault from its creation transaction', () => {
  it('takes every term from the one VaultCreated log of the factory, in the one address form (C1, C34)', () => {
    expect(vaultCreatedIn(receipt(), FACTORY.toLowerCase())).toEqual({
      ok: true,
      value: { vault: VAULT, owner: OWNER, agent: AGENT, token: USDC, perWalletCap: CAP, endTime: END, rootDelay: DELAY, block: 57_248_098n },
    });
  });

  it.each([
    ['a receipt that reverted', receipt({ status: 'reverted' }), 'the vault transaction did not succeed'],
    ['a receipt sent to another factory', receipt({ to: OTHER_FACTORY }), 'the vault transaction was not sent to the factory in base-sepolia.json'],
    ['a contract creation with no recipient', receipt({ to: null }), 'the vault transaction was not sent to the factory in base-sepolia.json'],
    ['a receipt with no VaultCreated log', receipt({ logs: [] }), 'the vault transaction holds 0 VaultCreated logs from the factory, not one'],
    ['two VaultCreated logs in one receipt', receipt({ logs: [vaultCreated(), vaultCreated({ vault: address('a2') })] }), 'the vault transaction holds 2 VaultCreated logs from the factory, not one'],
    ['a VaultCreated logged by another contract', receipt({ logs: [vaultCreated({ emitter: OTHER_FACTORY })] }), 'the vault transaction holds 0 VaultCreated logs from the factory, not one'],
    ['a root delay the contract could never hold', receipt({ logs: [vaultCreated({ delay: 59 })] }), 'the VaultCreated log holds terms outside what the contract allows'],
    ['a cap of zero', receipt({ logs: [vaultCreated({ cap: 0n })] }), 'the VaultCreated log holds terms outside what the contract allows'],
  ])('refuses %s', (_what, given, cause) => {
    expect(vaultCreatedIn(given, FACTORY)).toEqual({ ok: false, cause });
  });
});

describe('campaignFromVault', () => {
  it('fills the defaults: chain 84532, open, the current rulebook, opens now, closes at the latest moment a list could pay', () => {
    const result = campaignFromVault(campaignArgs(), onChain(), NOW);
    expect(result).toEqual({
      ok: true,
      value: {
        campaign: {
          id: 'proof-vault-dry-run',
          name: 'Dry run',
          chain: 84532,
          vault: VAULT,
          token: USDC,
          owner: OWNER,
          agent: AGENT,
          rewardPerWallet: '1000000',
          perWalletCap: '1000000',
          partialShareBps: DEFAULT_SETTINGS.partialShareBps,
          maxSlots: 2,
          rulebook: CURRENT_RULEBOOK,
          settings: {},
          status: 'open',
          opensAt: NOW,
          closesAt: LATEST_CLOSE,
          createdAt: NOW,
          vaultBlock: 57_248_098n,
        },
        created: { vault: VAULT, owner: OWNER, agent: AGENT, token: USDC, perWalletCap: CAP, endTime: END, rootDelay: DELAY, block: 57_248_098n },
        deposited: 2n * CAP,
        holds: CAP,
        promised: 2n * CAP,
        latestClose: LATEST_CLOSE,
      },
    });
  });

  it('accepts closes at exactly the latest moment, and given opening and closing times', () => {
    const opens = new Date(NOW.getTime() + 3_600_000);
    const result = campaignFromVault(campaignArgs({ opens: opens.toISOString(), closes: LATEST_CLOSE.toISOString() }), onChain(), NOW);
    expect(result).toMatchObject({ ok: true, value: { campaign: { opensAt: opens, closesAt: LATEST_CLOSE } } });
  });

  it.each([
    ['token', { token: NOT_USDC }],
    ['owner', { owner: AGENT }],
    ['agent', { agent: OWNER }],
    ['cap', { perWalletCap: 2n * CAP }],
    ['delay', { rootDelay: 7200 }],
  ] as const)('refuses a log whose %s disagrees with state() (fail closed)', (field, state) => {
    expect(campaignFromVault(campaignArgs(), onChain({}, state), NOW)).toEqual({
      ok: false,
      cause: `the vault's state() disagrees with its VaultCreated log on ${field}`,
    });
  });

  it('compares the log and state() through the one parser, so case alone is not a disagreement (C1, standard 2)', () => {
    const state = { token: USDC.toLowerCase(), owner: OWNER.toLowerCase(), agent: AGENT.toLowerCase() };
    expect(campaignFromVault(campaignArgs(), onChain({ factory: FACTORY.toLowerCase(), usdc: USDC.toLowerCase() }, state), NOW).ok).toBe(true);
  });

  it.each([
    ['a token that is not the chain USDC', { receipt: receipt({ logs: [vaultCreated({ token: NOT_USDC })] }), state: { ...onChain().state, token: NOT_USDC } }, {}, 'the vault pays a token that is not Base Sepolia USDC, and campaign amounts assume its 6 decimals'],
    ['a reward above the cap', {}, { reward: '1.000001' }, '--reward is above the vault per-wallet cap, so the vault could never pay it in full'],
    ['a vault whose end has passed', { receipt: receipt({ logs: [vaultCreated({ end: NOW_SECONDS })] }) }, {}, 'the vault has ended, so it can pay nothing more'],
    ['closes after the latest moment a list could pay', {}, { closes: new Date(LATEST_CLOSE.getTime() + 1000).toISOString() }, `--closes is after ${LATEST_CLOSE.toISOString()}, the latest moment a list posted then could still pay`],
    ['opens at closes', {}, { opens: LATEST_CLOSE.toISOString() }, '--opens must be before closes'],
    ['a vault that ends too soon to open now', { receipt: receipt({ logs: [vaultCreated({ end: NOW_SECONDS + 7200n })] }) }, {}, '--opens must be before closes'],
    ['a claim window the contract could not have', { minClaimWindow: 0 }, {}, "the vault's MIN_CLAIM_WINDOW is outside what the contract allows"],
  ] as const)('refuses %s', (_what, chainChange, argChange, cause) => {
    expect(campaignFromVault(campaignArgs(argChange), onChain(chainChange as Partial<VaultOnChain>), NOW)).toEqual({ ok: false, cause });
  });

  it('refuses any refusal of the log reader too, writing nothing (fail closed)', () => {
    expect(campaignFromVault(campaignArgs(), onChain({ receipt: receipt({ to: OTHER_FACTORY }) }), NOW)).toEqual({
      ok: false,
      cause: 'the vault transaction was not sent to the factory in base-sepolia.json',
    });
  });

  it('counts what the vault still holds, deposited less paid, against reward times slots', () => {
    const result = campaignFromVault(campaignArgs({ slots: '3' }), onChain({}, { deposited: 5n * CAP, totalPaid: 3n * CAP }), NOW);
    expect(result).toMatchObject({ ok: true, value: { holds: 2n * CAP, promised: 3n * CAP } });
  });
});

describe('the store takes what campaignFromVault builds', () => {
  let db: Db;
  beforeAll(async () => {
    db = await openMemoryDb();
    await migrate(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it('writes it once, and a second identical write is a no-op', async () => {
    const result = campaignFromVault(campaignArgs({ settings: '{"minWalletAgeDays":60}' }), onChain(), NOW);
    if (!result.ok) throw new Error(result.cause);
    expect(await createCampaign(db, result.value.campaign)).toBe('created');
    expect(await createCampaign(db, result.value.campaign)).toBe('unchanged');
    // Run again a minute later with the stored opening time, as the script does when --opens is left out: createdAt
    // moves, and it is not a term.
    const later = new Date(NOW.getTime() + 60_000);
    const again = campaignFromVault(campaignArgs({ settings: '{"minWalletAgeDays":60}', opens: NOW.toISOString() }), onChain(), later);
    if (!again.ok) throw new Error(again.cause);
    expect(again.value.campaign.createdAt).toEqual(later);
    expect(await createCampaign(db, again.value.campaign)).toBe('unchanged');

    const stored = await getCampaign(db, 'proof-vault-dry-run');
    expect(stored).toMatchObject({ vault: VAULT, agent: AGENT, vaultBlock: 57_248_098n, settings: { minWalletAgeDays: 60 }, maxSlots: 2 });
    const lines = campaignLines(stored as NonNullable<typeof stored>);
    const line = (label: string, value: string) => `${label.padEnd(18)} ${value}`;
    expect(lines).toContain(line('vault block', '57248098'));
    expect(lines).toContain(line('agent', AGENT));
    expect(lines).toContain(line('settings', '{"minWalletAgeDays":60}'));
    expect(lines).toContain(line('closes at', LATEST_CLOSE.toISOString()));
  });

  it("takes the store's most slots, which the argument check allows", async () => {
    const result = campaignFromVault(campaignArgs({ id: 'most-slots', slots: '100000' }), onChain(), NOW);
    if (!result.ok) throw new Error(result.cause);
    expect(await createCampaign(db, result.value.campaign)).toBe('created');
  });

  it('names the migration when the table or column is missing', () => {
    expect(needsMigration('relation "campaigns" does not exist (42P01)')).toBe(true);
    expect(needsMigration('column "vault_block" of relation "campaigns" does not exist (42703)')).toBe(true);
    expect(needsMigration('campaign x already exists with different terms')).toBe(false);
  });
});

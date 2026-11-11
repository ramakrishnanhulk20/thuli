// Registers a campaign from its vault's creation transaction, so no vault term is ever typed by hand:
//
//   npm run campaign:create -- --id ID --name NAME --agent ADDRESS --vault-tx HASH --reward USDC --slots N
//                              [--partial-share-bps N] [--opens ISO] [--closes ISO] [--settings JSON] [--write]
//
// It reads the receipt and the vault's state() from Base Sepolia, checks they agree, that --agent is the vault's agent
// and that the vault holds reward times slots, and prints the campaign. Without
// --write nothing is written. With --write it records the campaign through the store (DATABASE_URL). No code here reads
// a private key: registering a campaign signs nothing (C39).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BaseError, TransactionReceiptNotFoundError } from 'viem';
import { formatUsdc } from '@thuli/core';
import { connectPostgres, createCampaign, getCampaign, StoreError, type Db } from '@thuli/store';
import { scrubber } from '../src/campaign/config.ts';
import {
  campaignEnv,
  campaignFromVault,
  campaignLines,
  checkCampaignArgs,
  needsMigration,
  usdcFromRecord,
  vaultCreatedIn,
  type Registration,
} from '../src/campaign/register.ts';
import { VAULT_ABI } from '../src/vault/abi.ts';
import { addressLink, ChainCallError, connectBaseSepolia, txLink } from '../src/vault/chain.ts';
import { Deployment, ProofRecordFile, ProofSetupError, readJson } from '../src/vault/proof.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEPLOYMENTS = path.join(REPO_ROOT, 'packages', 'contracts', 'deployments');
const USAGE =
  'Usage: npm run campaign:create -- --id ID --name NAME --agent ADDRESS --vault-tx HASH --reward USDC --slots N [--partial-share-bps N] [--opens ISO] [--closes ISO] [--settings JSON] [--write]';

class Refused extends Error {
  override name = 'Refused';
}

// Replaced once the environment is read, so a library message quoting the RPC or database URL is blanked (C40).
let clean = (line: string) => line;

const usdc = (units: bigint) => `${formatUsdc(units)} USDC`;

function printSummary(registration: Registration): void {
  const { campaign, created, deposited, holds, promised, latestClose } = registration;
  const end = new Date(Number(created.endTime) * 1000).toISOString();
  console.log(`Vault          ${created.vault}  ${addressLink(created.vault)}`);
  console.log(`Created in     block ${created.block}, read from its VaultCreated log and checked against state()`);
  console.log(`Token          ${created.token} (Base Sepolia USDC)`);
  console.log(`Owner          ${created.owner}`);
  console.log(`Per-wallet cap ${usdc(created.perWalletCap)}`);
  console.log(`Ends           unix ${created.endTime} (${end})`);
  console.log(`Root delay     ${created.rootDelay} seconds`);
  console.log(`Deposited      ${usdc(deposited)}; still holds ${usdc(holds)}`);
  console.log(`Campaign       ${campaign.id}, "${campaign.name}"`);
  console.log(`Reward         ${usdc(BigInt(campaign.rewardPerWallet))} per wallet, ${campaign.maxSlots} slots, ${usdc(promised)} in all`);
  console.log(`Partial share  ${campaign.partialShareBps} bps; rulebook ${campaign.rulebook}; status ${campaign.status}; chain ${campaign.chain}`);
  console.log(`Settings       ${JSON.stringify(campaign.settings)}`);
  console.log(`Opens          ${campaign.opensAt.toISOString()}`);
  console.log(`Closes         ${campaign.closesAt.toISOString()} (latest allowed ${latestClose.toISOString()})`);
  console.log(`Agent ${created.agent}: the worker must run with this key`);
}

async function write(db: Db, registration: Registration): Promise<void> {
  const { campaign } = registration;
  const result = await createCampaign(db, campaign);
  console.log(result === 'created' ? `Wrote campaign ${campaign.id}.` : `Campaign ${campaign.id} already holds exactly these terms; nothing changed.`);
  const stored = await getCampaign(db, campaign.id);
  if (stored === null) throw new Refused(`campaign ${campaign.id} could not be read back after writing`);
  console.log('Stored row:');
  for (const line of campaignLines(stored)) console.log(`  ${line}`);
}

async function main(): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      options: {
        id: { type: 'string' },
        name: { type: 'string' },
        agent: { type: 'string' },
        'vault-tx': { type: 'string' },
        reward: { type: 'string' },
        slots: { type: 'string' },
        'partial-share-bps': { type: 'string' },
        opens: { type: 'string' },
        closes: { type: 'string' },
        settings: { type: 'string' },
        write: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw new ProofSetupError(USAGE);
  }
  const checked = checkCampaignArgs(values as Parameters<typeof checkCampaignArgs>[0]);
  if (!checked.ok) throw new Refused(checked.cause);
  let args = checked.value;
  const env = campaignEnv(process.env, args.write);
  if (!env.ok) throw new Refused(env.cause);
  const secrets = env.value.usesPublic ? [] : [env.value.rpcUrl];
  if (env.value.databaseUrl !== null) {
    secrets.push(env.value.databaseUrl);
    try {
      secrets.push(decodeURIComponent(new URL(env.value.databaseUrl).password));
    } catch {
      // connectPostgres refuses a URL it cannot read, before any line could quote it.
    }
  }
  clean = scrubber(secrets);
  if (env.value.usesPublic) console.log(`BASE_SEPOLIA_RPC_URL is not set, so this reads Base Sepolia through ${env.value.rpcUrl}.`);

  const { publicClient } = await connectBaseSepolia(env.value.rpcUrl);
  const { factory } = readJson(Deployment, path.join(DEPLOYMENTS, 'base-sepolia.json'), 'deployment record');
  const usdcToken = usdcFromRecord(readJson(ProofRecordFile, path.join(DEPLOYMENTS, 'base-sepolia-proof.json'), 'proof record').token);
  if (!usdcToken.ok) throw new Refused(usdcToken.cause);

  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: args.vaultTx });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) throw new Refused('the chain has no receipt for --vault-tx');
    throw error;
  }
  const created = vaultCreatedIn(receipt, factory);
  if (!created.ok) throw new Refused(created.cause);
  const { vault } = created.value;
  // Both views at one block, so the terms describe the vault at one moment.
  const blockNumber = await publicClient.getBlockNumber();
  const state = await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'state', blockNumber });
  const minClaimWindow = await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'MIN_CLAIM_WINDOW', blockNumber });
  console.log(`Read ${txLink(args.vaultTx)} and the vault at block ${blockNumber}.`);

  const db = env.value.databaseUrl === null ? null : connectPostgres(env.value.databaseUrl);
  try {
    if (db !== null && args.opens === undefined) {
      // Run again without --opens, the stored opening time stands, so the same command is a no-op, not a new term.
      const stored = await getCampaign(db, args.id);
      if (stored !== null) {
        args = { ...args, opens: stored.opensAt };
        console.log(`Opens is kept from the stored campaign: ${stored.opensAt.toISOString()}.`);
      }
    }
    const onChain = { factory, usdc: usdcToken.value, receipt, state, minClaimWindow };
    const registration = campaignFromVault(args, onChain, new Date());
    if (!registration.ok) throw new Refused(registration.cause);
    printSummary(registration.value);
    if (db === null) {
      console.log('nothing was written');
      return 0;
    }
    await write(db, registration.value);
    return 0;
  } catch (error) {
    if (error instanceof StoreError) {
      throw new Refused(needsMigration(error.message) ? 'run npm run db:migrate first' : error.message);
    }
    throw error;
  } finally {
    await db?.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof ProofSetupError) {
      console.error(clean(error.message));
      process.exitCode = 2;
      return;
    }
    if (error instanceof Refused || error instanceof ChainCallError) {
      console.error(clean(`campaign:create refused: ${error.message}. Nothing was written.`));
      process.exitCode = 1;
      return;
    }
    // A library message can quote a URL, so only its first short line goes out, and through the scrubber (C40).
    const detail = error instanceof BaseError ? (error.shortMessage.split('\n')[0] ?? error.name) : error instanceof Error ? error.name : 'unknown error';
    console.error(clean(`campaign:create stopped: ${detail}. Nothing was written.`));
    process.exitCode = 1;
  },
);

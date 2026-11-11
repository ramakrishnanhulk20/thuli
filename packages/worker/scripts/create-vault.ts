// Creates and funds one campaign vault on Base Sepolia from the owner's test key:
//
//   npm run vault:create -- --agent ADDRESS --cap USDC --deposit USDC [--days N] [--delay-hours N] [--send]
//
// Without --send it simulates createVault and prints the plan; nothing is signed. With --send the owner (the
// PAYER_PRIVATE_KEY test key) sends exactly three transactions: createVault through the committed factory, approve of
// exactly the deposit, and the deposit. Base Sepolia only: the RPC must report chain 84532, because a vault holding
// real money is a decision for a person, never a script default.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BaseError, erc20Abi, type Chain, type PublicClient, type Transport } from 'viem';
import { formatUsdc, parseAddress } from '@thuli/core';
import { scrubber } from '../src/campaign/config.ts';
import { checkVaultArgs, usdcFromRecord, vaultCreatedIn, vaultEnv, vaultPlan, type VaultPlan } from '../src/campaign/register.ts';
import { FACTORY_ABI, VAULT_ABI } from '../src/vault/abi.ts';
import { addressLink, ChainCallError, confirm, connectBaseSepolia, txLink, type Wallet } from '../src/vault/chain.ts';
import { Deployment, ProofRecordFile, ProofSetupError, readJson } from '../src/vault/proof.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEPLOYMENTS = path.join(REPO_ROOT, 'packages', 'contracts', 'deployments');
const USAGE = 'Usage: npm run vault:create -- --agent ADDRESS --cap USDC --deposit USDC [--days N] [--delay-hours N] [--send]';

class Refused extends Error {
  override name = 'Refused';
}

type Client = PublicClient<Transport, Chain>;

// Replaced once the key and RPC are read, so no library message can carry either to the screen (C39, C40).
let clean = (line: string) => line;

const usdc = (units: bigint) => `${formatUsdc(units)} USDC`;
const when = (unix: bigint) => `unix ${unix} (${new Date(Number(unix) * 1000).toISOString()})`;

function printPlan(plan: VaultPlan, factory: string, predicted: string): void {
  console.log(`Owner          ${plan.owner} (PAYER_PRIVATE_KEY)`);
  console.log(`Agent          ${plan.agent}`);
  console.log(`Token          ${plan.token} (Base Sepolia USDC, from the committed proof record)`);
  console.log(`Per-wallet cap ${usdc(plan.cap)}`);
  console.log(`Ends           ${when(plan.endTime)}`);
  console.log(`Root delay     ${plan.rootDelay} seconds`);
  console.log(`Deposit        ${usdc(plan.deposit)}`);
  console.log('The three transactions, in order:');
  console.log(`  1. createVault on the factory ${factory}: simulated, it would create ${predicted}`);
  console.log(`  2. approve(${predicted}, ${plan.deposit}) on USDC: exactly the deposit, in base units`);
  console.log(`  3. deposit(${plan.deposit}) on the new vault`);
}

/**
 * The only function that signs. It sends createVault, approve and deposit, nothing else, each simulated first and
 * its receipt awaited, and returns the vault and its creation transaction.
 */
async function sendVault(client: Client, owner: Wallet, plan: VaultPlan, factory: `0x${string}`, predicted: string) {
  const account = owner.account;
  const create = await client.simulateContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'createVault',
    args: [plan.token, plan.owner, plan.agent, plan.cap, plan.endTime, plan.rootDelay],
    account,
  });
  const created = await confirm(client, await owner.writeContract(create.request), account.address);
  console.log(`createVault  ${txLink(created.hash)}`);
  const receipt = await client.getTransactionReceipt({ hash: created.hash });
  const read = vaultCreatedIn(receipt, factory);
  if (!read.ok) throw new Refused(`${read.cause}; see ${txLink(created.hash)}`);
  const { vault } = read.value;
  if (vault !== parseAddress(predicted)) console.log(`The vault landed at ${vault}, not the simulated ${predicted}: another vault was created first.`);

  try {
    const approve = await client.simulateContract({
      address: plan.token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [vault, plan.deposit],
      account,
    });
    const approved = await confirm(client, await owner.writeContract(approve.request), account.address);
    console.log(`approve      ${txLink(approved.hash)}`);
    const deposit = await client.simulateContract({ address: vault, abi: VAULT_ABI, functionName: 'deposit', args: [plan.deposit], account });
    const deposited = await confirm(client, await owner.writeContract(deposit.request), account.address);
    console.log(`deposit      ${txLink(deposited.hash)}`);
  } catch (error) {
    // The vault exists either way, so say where before the error, rather than leave a second run to make another.
    console.error(clean(`The vault ${vault} was created in ${created.hash} but is not funded. Fund it with approve and deposit from the owner.`));
    throw error;
  }
  return { vault, hash: created.hash, block: read.value.block };
}

async function main(): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      options: {
        agent: { type: 'string' },
        cap: { type: 'string' },
        deposit: { type: 'string' },
        days: { type: 'string' },
        'delay-hours': { type: 'string' },
        send: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw new ProofSetupError(USAGE);
  }
  const args = checkVaultArgs(values as Parameters<typeof checkVaultArgs>[0]);
  if (!args.ok) throw new Refused(args.cause);
  const env = vaultEnv(process.env);
  if (!env.ok) throw new Refused(env.cause);
  const { payerKey, rpcUrl, usesPublic } = env.value;
  clean = scrubber(usesPublic ? [payerKey, payerKey.slice(2)] : [payerKey, payerKey.slice(2), rpcUrl]);
  if (usesPublic) console.log(`BASE_SEPOLIA_RPC_URL is not set, so this uses Base Sepolia through ${rpcUrl}.`);

  const { publicClient, wallet } = await connectBaseSepolia(rpcUrl);
  const owner = wallet(payerKey);
  const { factory } = readJson(Deployment, path.join(DEPLOYMENTS, 'base-sepolia.json'), 'deployment record');
  const token = usdcFromRecord(readJson(ProofRecordFile, path.join(DEPLOYMENTS, 'base-sepolia-proof.json'), 'proof record').token);
  if (!token.ok) throw new Refused(token.cause);
  const code = await publicClient.getCode({ address: factory });
  if (code === undefined || code === '0x') throw new Refused(`there is no factory contract at ${factory} on this chain`);
  const [symbol, decimals, ownerUsdc, ownerEth, block] = await Promise.all([
    publicClient.readContract({ address: token.value, abi: erc20Abi, functionName: 'symbol' }),
    publicClient.readContract({ address: token.value, abi: erc20Abi, functionName: 'decimals' }),
    publicClient.readContract({ address: token.value, abi: erc20Abi, functionName: 'balanceOf', args: [owner.account.address] }),
    publicClient.getBalance({ address: owner.account.address }),
    publicClient.getBlock(),
  ]);
  if (symbol !== 'USDC' || decimals !== 6) throw new Refused(`${token.value} is not six-decimal USDC on this chain`);

  const plan = vaultPlan(args.value, { owner: owner.account.address, token: token.value, ownerUsdc, now: block.timestamp });
  if (!plan.ok) throw new Refused(plan.cause);
  const terms = plan.value;
  const simulated = await publicClient.simulateContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'createVault',
    args: [terms.token, terms.owner, terms.agent, terms.cap, terms.endTime, terms.rootDelay],
    account: owner.account,
  });
  printPlan(terms, factory, simulated.result);
  console.log(`The owner holds ${usdc(ownerUsdc)} and ${ownerEth} wei of Base Sepolia ETH for gas.`);

  if (!args.value.send) {
    console.log('Simulated only: nothing was signed or sent. Run again with --send to create and fund the vault.');
    return 0;
  }
  if (ownerEth === 0n) throw new Refused('the owner has no Base Sepolia ETH for gas');
  const sent = await sendVault(publicClient, owner, terms, factory, simulated.result);
  const state = await publicClient.readContract({ address: sent.vault, abi: VAULT_ABI, functionName: 'state' });
  const slots = state.perWalletCap === 0n ? 1n : state.deposited / state.perWalletCap;

  console.log(`Vault          ${sent.vault}  ${addressLink(sent.vault)}`);
  console.log(`createVault    ${sent.hash}, block ${sent.block}`);
  console.log(`Owner          ${state.owner}`);
  console.log(`Agent          ${state.agent}`);
  console.log(`Per-wallet cap ${usdc(state.perWalletCap)}`);
  console.log(`Ends           ${when(state.endTime)}`);
  console.log(`Root delay     ${state.rootDelay} seconds`);
  console.log(`Deposited      ${usdc(state.deposited)}`);
  console.log('Next, register the campaign (pick its id and name; add --write to store it):');
  console.log(
    `  npm run campaign:create -- --id <campaign-id> --name "<campaign name>" --vault-tx ${sent.hash} --reward ${formatUsdc(state.perWalletCap)} --slots ${slots > 0n ? slots : 1n}`,
  );
  return 0;
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
      console.error(clean(`vault:create refused: ${error.message}`));
      process.exitCode = 1;
      return;
    }
    // A library message can quote the RPC URL, so only its first short line goes out, and through the scrubber (C40).
    const detail = error instanceof BaseError ? (error.shortMessage.split('\n')[0] ?? error.name) : error instanceof Error ? error.name : 'unknown error';
    console.error(clean(`vault:create stopped: ${detail}`));
    process.exitCode = 1;
  },
);

// Proves on Base Sepolia that the vault pays an approved wallet and refuses a held one. Two phases, because every
// root waits at least an hour on chain before it pays:
//
//   npm run prove:vault -- setup   the owner (PAYER key) creates a vault, 1 USDC cap, and deposits 2 USDC; the agent
//                                  (WORKER key) posts a root holding claimant A at 1 USDC; claimant B is held off it
//   npm run prove:vault -- claim   after the delay the agent submits A's claim, B's attempt fails with InvalidProof
//
// Rehearse on a local fork with --rpc-url http://127.0.0.1:PORT --deployment FILE --state FILE (rehearse.mjs does).
// Both phases refuse any chain but 84532. Claimant keys are never stored: both are derived from a seed kept only in
// the state file, which is fine for test USDC on a testnet and nowhere else.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BaseError, erc20Abi, formatUnits, parseEventLogs, type Address, type Chain, type PublicClient, type Transport } from 'viem';
import type { z } from 'zod';
import { parseAddress, proofFor } from '@thuli/core';
import { FACTORY_ABI, VAULT_ABI } from '../src/vault/abi.ts';
import { addressLink, BASE_SEPOLIA, ChainCallError, confirm, connectBaseSepolia, revertName, txLink, vaultPort, type Sent, type Wallet } from '../src/vault/chain.ts';
import { claimants, Deployment, loadProofEnv, newSeed, PROOF_TERMS, ProofSetupError, ProofState } from '../src/vault/proof.ts';
import { buildRoot, postRoot, readPublishedList, RootError } from '../src/vault/root.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEFAULT_DEPLOYMENT = path.join(REPO_ROOT, 'packages', 'contracts', 'deployments', 'base-sepolia.json');
const DEFAULT_STATE = path.join(REPO_ROOT, 'data', 'vault-proof', 'state.json');
const MAX_FILE_BYTES = 64 * 1024;
const USAGE = 'Usage: npm run prove:vault -- setup|claim [--rpc-url http://127.0.0.1:PORT] [--deployment FILE] [--state FILE]';

class ProofFailed extends Error {
  override name = 'ProofFailed';
}

type Client = PublicClient<Transport, Chain>;
type Logged = Sent & { label: string };

function readJson<T extends z.ZodType>(schema: T, file: string, what: string): z.infer<T> {
  if (!fs.existsSync(file)) throw new ProofSetupError(`No ${what} at ${file}.`);
  if (fs.statSync(file).size > MAX_FILE_BYTES) throw new ProofSetupError(`The ${what} at ${file} is too large.`);
  const parsed = schema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) throw new ProofSetupError(`The ${what} at ${file} is malformed.`);
  return parsed.data;
}

async function requireCode(client: Client, address: Address, what: string): Promise<void> {
  const code = await client.getCode({ address });
  if (code === undefined || code === '0x') throw new ProofSetupError(`No ${what} contract at ${address} on this chain.`);
}

const usdc = (amount: bigint) => `${formatUnits(amount, 6)} USDC`;

function printTransactions(transactions: readonly Logged[], rehearsal: boolean): void {
  console.log(rehearsal ? 'Transactions (local fork: these links will not resolve on Basescan):' : 'Transactions:');
  for (const tx of transactions) console.log(`  ${tx.label.padEnd(12)} ${txLink(tx.hash)}  gas ${tx.gasUsed}`);
  const byKey = new Map<string, bigint>();
  for (const tx of transactions) byKey.set(tx.from, (byKey.get(tx.from) ?? 0n) + tx.gasUsed);
  for (const [from, gas] of byKey) console.log(`  gas used by ${from}: ${gas}`);
}

async function setup(client: Client, owner: Wallet, agent: Wallet, deploymentFile: string, stateFile: string, rehearsal: boolean) {
  if (fs.existsSync(stateFile)) {
    throw new ProofSetupError(`${stateFile} already holds a proof run. Run the claim phase, or move the file to start over.`);
  }
  const { factory } = readJson(Deployment, deploymentFile, 'deployment record');
  await requireCode(client, factory, 'factory');
  const token = parseAddress(BASE_SEPOLIA.usdc);
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  if (symbol !== 'USDC' || decimals !== 6) throw new ProofSetupError(`${token} is not six-decimal USDC on this chain.`);

  const ownerAddress = owner.account.address;
  const agentAddress = agent.account.address;
  const [ownerUsdc, ownerEth, agentEth] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [ownerAddress] }),
    client.getBalance({ address: ownerAddress }),
    client.getBalance({ address: agentAddress }),
  ]);
  if (ownerUsdc < PROOF_TERMS.deposit) {
    throw new ProofSetupError(`The owner ${ownerAddress} holds ${usdc(ownerUsdc)}; it needs ${usdc(PROOF_TERMS.deposit)}.`);
  }
  if (ownerEth === 0n) throw new ProofSetupError(`The owner ${ownerAddress} has no Base Sepolia ETH for gas.`);
  if (agentEth === 0n) throw new ProofSetupError(`The agent ${agentAddress} has no Base Sepolia ETH for gas.`);

  const seed = newSeed();
  const { a, b } = claimants(seed);
  const now = (await client.getBlock()).timestamp;
  const endTime = now + BigInt(PROOF_TERMS.runSeconds);
  const transactions: Logged[] = [];

  const create = await client.simulateContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'createVault',
    args: [token, ownerAddress, agentAddress, PROOF_TERMS.perWalletCap, endTime, PROOF_TERMS.rootDelay],
    account: owner.account,
  });
  const created = await confirm(client, await owner.writeContract(create.request), ownerAddress);
  transactions.push({ label: 'createVault', ...created });
  const receipt = await client.getTransactionReceipt({ hash: created.hash });
  const [event] = parseEventLogs({ abi: FACTORY_ABI, eventName: 'VaultCreated', logs: receipt.logs }).filter(
    (log) => log.address.toLowerCase() === factory.toLowerCase(),
  );
  if (!event || parseAddress(event.args.vault) !== parseAddress(create.result)) {
    throw new ProofFailed('the factory did not report the vault it created');
  }
  const vault = parseAddress(event.args.vault);

  const approve = await client.simulateContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [vault, PROOF_TERMS.deposit],
    account: owner.account,
  });
  transactions.push({ label: 'approve', ...(await confirm(client, await owner.writeContract(approve.request), ownerAddress)) });
  const deposit = await client.simulateContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: 'deposit',
    args: [PROOF_TERMS.deposit],
    account: owner.account,
  });
  transactions.push({ label: 'deposit', ...(await confirm(client, await owner.writeContract(deposit.request), ownerAddress)) });

  const posted = await postRoot(vaultPort(client, agent), vault, [{ account: a, cumulativeAmount: PROOF_TERMS.approvedAmount }]);
  transactions.push({ label: 'postRoot', hash: posted.hash, gasUsed: posted.gasUsed, from: agentAddress });
  const { pendingClaimableAt } = await client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'state' });

  const state: ProofState = {
    chainId: 84532,
    factory,
    vault,
    owner: ownerAddress,
    agent: agentAddress,
    seed,
    root: posted.root,
    published: posted.published,
    claimableAt: Number(pendingClaimableAt),
    transactions: transactions.map((tx) => ({ label: tx.label, hash: tx.hash, from: tx.from, gasUsed: tx.gasUsed.toString() })),
  };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(ProofState.parse(state), null, 2)}\n`);

  console.log(`Vault      ${vault}  ${addressLink(vault)}`);
  console.log(`Claimant A ${a} approved for ${usdc(PROOF_TERMS.approvedAmount)}`);
  console.log(`Claimant B ${b} held, left off the list`);
  console.log(`Root       ${posted.root}, declared total ${usdc(posted.declaredTotal)}`);
  printTransactions(transactions, rehearsal);
  console.log(`The root becomes claimable at ${new Date(state.claimableAt * 1000).toISOString()} (unix ${state.claimableAt}).`);
  console.log(`Then run the claim phase. State saved to ${stateFile}.`);
}

async function claim(client: Client, owner: Wallet, agent: Wallet, stateFile: string, rehearsal: boolean) {
  const state = readJson(ProofState, stateFile, 'proof state');
  if (state.owner !== owner.account.address || state.agent !== agent.account.address) {
    throw new ProofSetupError('The keys in .env are not the owner and agent this proof run was set up with.');
  }
  await requireCode(client, state.vault, 'vault');
  const now = Number((await client.getBlock()).timestamp);
  if (now < state.claimableAt) {
    const minutes = Math.ceil((state.claimableAt - now) / 60);
    throw new ProofSetupError(`The root becomes claimable in ${minutes} minutes, at unix ${state.claimableAt}. Run claim then.`);
  }

  // C32 from the claimant's side: the list on record rebuilds to the root on record, which is the vault's active root.
  const { a, b } = claimants(state.seed as `0x${string}`);
  const entries = readPublishedList(state.published);
  if (entries.length !== 1 || parseAddress(entries[0]?.account ?? '') !== a) {
    throw new ProofFailed('the saved list does not hold claimant A from the saved seed');
  }
  const { root, tree } = buildRoot(entries, state.vault, BASE_SEPOLIA.id);
  const before = await client.readContract({ address: state.vault, abi: VAULT_ABI, functionName: 'state' });
  if (root !== state.root || before.activeRoot !== root) {
    throw new ProofFailed('the root rebuilt from the saved list is not the vault active root');
  }

  const token = parseAddress(BASE_SEPOLIA.usdc);
  const balance = (address: Address) =>
    client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
  const amount = PROOF_TERMS.approvedAmount;
  const proofA = proofFor(tree, a);
  const promised = await client.readContract({ address: state.vault, abi: VAULT_ABI, functionName: 'claimable', args: [a, amount] });
  const aBefore = await balance(a);
  const sim = await client.simulateContract({
    address: state.vault,
    abi: VAULT_ABI,
    functionName: 'claim',
    args: [a, amount, proofA],
    account: agent.account,
  });
  const claimed = await confirm(client, await agent.writeContract(sim.request), agent.account.address);
  const paidToA = (await balance(a)) - aBefore;
  if (paidToA !== amount || promised !== amount) {
    throw new ProofFailed(`claimant A was paid ${usdc(paidToA)} (claimable said ${usdc(promised)}), not ${usdc(amount)}`);
  }
  console.log(`Claimant A ${a} paid ${usdc(paidToA)}, submitted by the agent ${agent.account.address}`);

  let refusal: string | undefined;
  try {
    await client.simulateContract({
      address: state.vault,
      abi: VAULT_ABI,
      functionName: 'claim',
      args: [b, amount, proofA],
      account: agent.account,
    });
  } catch (error) {
    refusal = revertName(error) ?? 'an unrecognised revert';
  }
  if (refusal !== 'InvalidProof') throw new ProofFailed(`claimant B was not refused with InvalidProof (got ${refusal ?? 'success'})`);
  console.log(`Claimant B ${b} refused: a static call of claim with A's proof reverts with InvalidProof`);

  const [aBalance, bBalance, vaultBalance, ownerBalance] = await Promise.all([
    balance(a),
    balance(b),
    balance(state.vault),
    balance(state.owner),
  ]);
  if (bBalance !== 0n) throw new ProofFailed(`claimant B holds ${usdc(bBalance)}`);
  console.log('Balances:');
  console.log(`  claimant A ${usdc(aBalance)}`);
  console.log(`  claimant B ${usdc(bBalance)}`);
  console.log(`  vault      ${usdc(vaultBalance)}`);
  console.log(`  owner      ${usdc(ownerBalance)}`);

  const transactions: Logged[] = [
    ...state.transactions.map((tx) => ({ ...tx, hash: tx.hash as `0x${string}`, gasUsed: BigInt(tx.gasUsed) })),
    { label: 'claim A', ...claimed },
  ];
  printTransactions(transactions, rehearsal);

  const after = await client.readContract({ address: state.vault, abi: VAULT_ABI, functionName: 'state' });
  console.log(`Vault state() ${addressLink(state.vault)}`);
  for (const [field, value] of Object.entries(after)) console.log(`  ${field.padEnd(18)} ${String(value)}`);

  const saved: ProofState = {
    ...state,
    transactions: [...state.transactions, { label: 'claim A', hash: claimed.hash, from: claimed.from, gasUsed: claimed.gasUsed.toString() }],
  };
  fs.writeFileSync(stateFile, `${JSON.stringify(ProofState.parse(saved), null, 2)}\n`);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'rpc-url': { type: 'string' }, deployment: { type: 'string' }, state: { type: 'string' } },
  });
  const phase = positionals[0];
  if (positionals.length !== 1 || (phase !== 'setup' && phase !== 'claim')) throw new ProofSetupError(USAGE);
  const env = loadProofEnv(process.env, values['rpc-url']);
  const { publicClient, wallet } = await connectBaseSepolia(env.rpcUrl);
  const owner = wallet(env.payerKey);
  const agent = wallet(env.workerKey);
  const stateFile = path.resolve(values.state ?? DEFAULT_STATE);
  if (env.rehearsal) console.log('Rehearsal on a local fork of Base Sepolia. Nothing here reaches a public network.');
  if (phase === 'setup') {
    await setup(publicClient, owner, agent, path.resolve(values.deployment ?? DEFAULT_DEPLOYMENT), stateFile, env.rehearsal);
  } else {
    await claim(publicClient, owner, agent, stateFile, env.rehearsal);
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof ProofSetupError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    if (error instanceof ProofFailed || error instanceof RootError || error instanceof ChainCallError) {
      console.error(`prove-vault failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    // A full library error can quote the RPC URL, which may carry a key, so only its short message is printed (C40).
    const detail = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.name : 'unknown error';
    console.error(`prove-vault stopped: ${detail}`);
    process.exitCode = 1;
  },
);

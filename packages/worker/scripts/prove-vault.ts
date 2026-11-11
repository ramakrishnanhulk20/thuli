// Proves on Base Sepolia that the vault pays an approved wallet and refuses a held one. Two phases, because every
// root waits at least an hour on chain before it pays, then a read-only third that publishes the result:
//
//   npm run prove:vault -- setup   the owner (PAYER key) creates a vault, 1 USDC cap, and deposits 2 USDC; the agent
//                                  (WORKER key) posts a root holding claimant A at 1 USDC; claimant B is held off it
//   npm run prove:vault -- claim   after the delay the agent submits A's claim, B's attempt fails with InvalidProof
//   npm run prove:vault -- record  reads the saved run back from Base Sepolia, loading no key and sending nothing, and
//                                  only when every receipt, event and view agrees writes the public record
//                                  packages/contracts/deployments/base-sepolia-proof.json for the site and the README
//   npm run prove:vault -- verify  checks that committed record against Base Sepolia with only an RPC URL (the public
//                                  endpoint when BASE_SEPOLIA_RPC_URL is unset) and the two committed files, so anyone
//                                  can run it; --record FILE checks another copy
//
// Base mainnet, one small proof fixed in code (src/vault/chainBase.ts), only with --network base --real-money, and
// signing only with --send: create (owner), post (agent), claim (agent, after the delay), withdraw (owner, after the
// end), record, verify. Each phase reads the chain first and does only what is left. Rehearse with
// --fork --rpc-url http://127.0.0.1:PORT --state FILE --deployment FILE [--record FILE] on an anvil fork of Base.
//
// Rehearse setup and claim on a local fork with --rpc-url http://127.0.0.1:PORT --deployment FILE --state FILE
// (rehearse.mjs does). Every phase refuses any chain but 84532. Claimant keys are never stored: both are derived from a
// seed kept only in the state file, which is fine for test USDC on a testnet and nowhere else.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BaseError,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  parseEventLogs,
  TransactionReceiptNotFoundError,
  type Address,
  type Chain,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAddress, proofFor } from '@thuli/core';
import { FACTORY_ABI, VAULT_ABI } from '../src/vault/abi.ts';
import { addressLink, BASE_SEPOLIA, ChainCallError, confirm, connectBaseSepolia, revertName, txLink, vaultPort, type Sent, type Wallet } from '../src/vault/chain.ts';
import {
  BASE_ID,
  BASE_PROFILE,
  BASE_USDC,
  baseAddressLink,
  baseKey,
  baseTxLink,
  checkMainnetTerms,
  chooseNetwork,
  claimNeeded,
  connectBase,
  createPlan,
  MAINNET_PROOF,
  paidAddressOf,
  paidWalletOf,
  postNeeded,
  REFUSED_WALLET,
  whenReady,
  vaultRevertName,
  withdrawNeeded,
} from '../src/vault/chainBase.ts';
import {
  BaseDeployment,
  BaseProofRecordFile,
  BaseProofState,
  buildBaseProofRecord,
  buildProofRecord,
  claimants,
  Deployment,
  loadProofEnv,
  loadRpcEnv,
  loadVerifyRpc,
  newSeed,
  PROOF_TERMS,
  ProofFailed,
  ProofRecordFile,
  ProofSetupError,
  ProofState,
  readJson,
  verifyBaseProofRecord,
  verifyProofRecord,
} from '../src/vault/proof.ts';
import { buildRoot, postRoot, publishList, readPublishedList, RootError, type CampaignRecord } from '../src/vault/root.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEFAULT_DEPLOYMENT = path.join(REPO_ROOT, 'packages', 'contracts', 'deployments', 'base-sepolia.json');
const DEFAULT_STATE = path.join(REPO_ROOT, 'data', 'vault-proof', 'state.json');
const PROOF_RECORD = path.join(REPO_ROOT, 'packages', 'contracts', 'deployments', 'base-sepolia-proof.json');
const USAGE =
  'Usage: npm run prove:vault -- setup|claim|record [--rpc-url http://127.0.0.1:PORT] [--deployment FILE] [--state FILE], or verify [--record FILE] [--deployment FILE]';

type Client = PublicClient<Transport, Chain>;
type Logged = Sent & { label: string };

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

  // The record of what this run asked the factory for; the signer refuses unless the factory's log says the same.
  const campaign: CampaignRecord = {
    factory,
    vault,
    createdAtBlock: receipt.blockNumber,
    token,
    owner: ownerAddress,
    agent: agentAddress,
    perWalletCap: PROOF_TERMS.perWalletCap,
    endTime,
    rootDelay: BigInt(PROOF_TERMS.rootDelay),
  };
  const posted = await postRoot(vaultPort(client, agent), campaign, [
    { account: a, cumulativeAmount: PROOF_TERMS.approvedAmount },
  ]);
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
    createdAtBlock: Number(receipt.blockNumber),
    endTime: Number(endTime),
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

// Takes only a public client: this phase has no wallet, so it cannot send a transaction.
async function record(client: Client, deploymentFile: string, stateFile: string) {
  const state = readJson(ProofState, stateFile, 'proof state');
  const deployment = readJson(Deployment, deploymentFile, 'deployment record');
  await requireCode(client, state.vault, 'vault');

  const receipts: TransactionReceipt[] = [];
  for (const tx of state.transactions) {
    try {
      receipts.push(await client.getTransactionReceipt({ hash: tx.hash as `0x${string}` }));
    } catch (error) {
      // buildProofRecord names the transaction whose receipt is missing.
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    }
  }

  const { a, b } = claimants(state.seed as `0x${string}`);
  const entries = readPublishedList(state.published);
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined || parseAddress(entry.account) !== a) {
    throw new ProofFailed('the saved list does not hold claimant A from the saved seed');
  }
  const proofA = proofFor(buildRoot(entries, state.vault, BASE_SEPOLIA.id).tree, a);
  // The views and the static call share one block, so the record describes the vault at one moment.
  const blockNumber = await client.getBlockNumber();
  const vaultState = await client.readContract({ address: state.vault, abi: VAULT_ABI, functionName: 'state', blockNumber });
  const claimedByPaid = await client.readContract({ address: state.vault, abi: VAULT_ABI, functionName: 'claimed', args: [a], blockNumber });
  let refusedSimulation = 'success';
  try {
    // From the agent's address, not its key: an eth_call needs no signature, and as the agent the proof is all that differs.
    await client.simulateContract({
      address: state.vault,
      abi: VAULT_ABI,
      functionName: 'claim',
      args: [b, entry.cumulativeAmount, proofA],
      account: state.agent,
      blockNumber,
    });
  } catch (error) {
    refusedSimulation = revertName(error) ?? 'an unrecognised revert';
  }

  const proof = buildProofRecord({ state, deployment, chain: { receipts, vaultState, claimedByPaid, refusedSimulation }, now: new Date() });
  console.log(`Checked against Base Sepolia at block ${blockNumber}. Every line agrees with the chain.`);
  console.log(`Vault      ${proof.vault}  ${addressLink(proof.vault)}`);
  console.log(`Claimant A ${proof.paid.account} paid ${usdc(BigInt(proof.paid.amount))}; the vault reports ${usdc(BigInt(proof.totalPaid))} paid in all`);
  console.log(`Claimant B ${proof.refused.account} refused with ${proof.refused.error}`);
  console.log('Transactions:');
  for (const tx of proof.transactions) {
    console.log(`  ${tx.label.padEnd(12)} ${txLink(tx.hash as `0x${string}`)}  block ${tx.block}  gas ${tx.gasUsed}  from ${tx.from}`);
  }
  fs.writeFileSync(PROOF_RECORD, `${JSON.stringify(proof, null, 2)}\n`);
  console.log(`Wrote ${path.relative(REPO_ROOT, PROOF_RECORD).replaceAll('\\', '/')}`);
}

// Public reads only, and no key or private file: the receipts, state() and claimed() of the two recorded accounts.
async function verify(client: Client, deploymentFile: string, recordFile: string): Promise<number> {
  const deployment = readJson(Deployment, deploymentFile, 'deployment record');
  const proof = readJson(ProofRecordFile, recordFile, 'proof record');
  const code = await client.getCode({ address: proof.vault });
  if (code === undefined || code === '0x') throw new ProofFailed(`vault: there is no contract at the recorded vault ${proof.vault}`);

  const receipts: TransactionReceipt[] = [];
  for (const tx of proof.transactions) {
    try {
      receipts.push(await client.getTransactionReceipt({ hash: tx.hash as `0x${string}` }));
    } catch (error) {
      // verifyProofRecord fails the check of the transaction whose receipt is missing.
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    }
  }
  const blockNumber = await client.getBlockNumber();
  const read = { address: proof.vault, abi: VAULT_ABI, blockNumber } as const;
  const vaultState = await client.readContract({ ...read, functionName: 'state' });
  const claimedByPaid = await client.readContract({ ...read, functionName: 'claimed', args: [proof.paid.account] });
  const claimedByRefused = await client.readContract({ ...read, functionName: 'claimed', args: [proof.refused.account] });

  const checks = verifyProofRecord(proof, deployment, { receipts, vaultState, claimedByPaid, claimedByRefused });
  console.log(`Checking ${path.relative(REPO_ROOT, recordFile).replaceAll('\\', '/')} against Base Sepolia at block ${blockNumber}:`);
  for (const { name, pass, detail } of checks) console.log(`  ${pass ? 'pass' : 'FAIL'}  ${name.padEnd(24)} ${detail}`);
  console.log("Not checked: that the refused wallet's claim reverts. That needs the private claim list behind the root, so only the record phase repeats it.");
  const failed = checks.filter((entry) => !entry.pass).map((entry) => entry.name);
  if (failed.length > 0) {
    console.error(`prove-vault verify failed: ${failed.join(', ')}`);
    return 1;
  }
  console.log(`All ${checks.length} checks pass. The vault on Basescan: ${addressLink(proof.vault)}`);
  return 0;
}

// Base mainnet: the one small proof fixed in chainBase.ts (MAINNET_PROOF), each phase its own command, reached only with
// --network base and --real-money. Each phase reads the chain first and does only what is left, and without --send it
// simulates and stops. The owner key signs createVault, approve, deposit and withdraw; the worker key postRoot and claim.
const DEPLOYMENTS_DIR = path.join(REPO_ROOT, 'packages', 'contracts', 'deployments');
const BASE_DEPLOYMENT = path.join(DEPLOYMENTS_DIR, 'base.json');
const BASE_STATE = path.join(REPO_ROOT, 'data', 'vault-proof', 'base-state.json');
const BASE_RECORD = path.join(DEPLOYMENTS_DIR, 'base-proof.json');
const BASE_PHASES = ['create', 'post', 'claim', 'withdraw', 'record', 'verify'];
const BASE_USAGE =
  'Usage: npm run prove:vault -- create|post|claim|withdraw|record|verify --network base --real-money [--send] [--fork --rpc-url http://127.0.0.1:PORT --state FILE --deployment FILE --record FILE]';

interface BaseRun {
  client: Client;
  wallet: (key: `0x${string}`) => Wallet;
  fork: boolean;
  send: boolean;
  stateFile: string;
  deploymentFile: string;
  recordFile: string;
}

const at = (unix: bigint | number) => new Date(Number(unix) * 1000).toISOString();

function inDeployments(file: string): boolean {
  const relative = path.relative(DEPLOYMENTS_DIR, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function loadBaseState(file: string): BaseProofState | null {
  return fs.existsSync(file) ? readJson(BaseProofState, file, 'Base proof state') : null;
}

function needBaseState(file: string): BaseProofState {
  const state = loadBaseState(file);
  if (state === null) throw new ProofSetupError(`No Base proof state at ${file}. Run create first.`);
  return state;
}

// Written after every send, so a phase stopped half way resumes from what already landed.
function saveBaseState(file: string, state: BaseProofState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(BaseProofState.parse(state), null, 2)}\n`);
}

function withTx(state: BaseProofState, label: string, sent: Sent): BaseProofState {
  return { ...state, transactions: [...state.transactions, { label, hash: sent.hash, from: sent.from, gasUsed: sent.gasUsed.toString() }] };
}

function keyOf(name: 'PAYER_PRIVATE_KEY' | 'WORKER_PRIVATE_KEY'): { key: `0x${string}`; address: Address } {
  const key = baseKey(process.env, name);
  return { key, address: parseAddress(privateKeyToAccount(key).address) };
}

function printSent(label: string, sent: Sent): void {
  console.log(`  ${label.padEnd(12)} ${baseTxLink(sent.hash)}  gas ${sent.gasUsed}`);
}

const usdcBalance = (client: Client, address: Address, blockNumber?: bigint) =>
  client.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address], blockNumber });

async function chainNow(client: Client): Promise<bigint> {
  return (await client.getBlock()).timestamp;
}

async function checkBaseUsdc(client: Client): Promise<void> {
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  if (symbol !== 'USDC' || decimals !== 6) throw new ProofSetupError(`${BASE_USDC} is not six-decimal USDC on this chain.`);
}

/**
 * What a static call of claim for `account` with `proof` reverts with, decoded against the vault ABI. `time` moves only
 * the block time of the call, which the record needs: after the end every claim reverts CampaignEnded before the proof
 * is read, so the refusal is shown on today's state with the clock set back inside the claim window.
 */
async function claimRefusal(client: Client, vault: Address, from: Address, account: Address, amount: bigint, proof: `0x${string}`[], time?: bigint) {
  const data = encodeFunctionData({ abi: VAULT_ABI, functionName: 'claim', args: [account, amount, proof] });
  try {
    await client.call({ account: from, to: vault, data, ...(time === undefined ? {} : { blockOverrides: { time } }) });
    return 'success';
  } catch (error) {
    return vaultRevertName(error);
  }
}

async function receiptsOf(client: Client, transactions: readonly { hash: string }[]): Promise<TransactionReceipt[]> {
  const receipts: TransactionReceipt[] = [];
  for (const tx of transactions) {
    try {
      receipts.push(await client.getTransactionReceipt({ hash: tx.hash as `0x${string}` }));
    } catch (error) {
      // The record and verify name the transaction whose receipt is missing.
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    }
  }
  return receipts;
}

async function baseCreate(run: BaseRun): Promise<void> {
  checkMainnetTerms(MAINNET_PROOF);
  const { client } = run;
  const owner = keyOf('PAYER_PRIVATE_KEY');
  // Only the agent's address: this phase never signs with the worker key.
  const agent = keyOf('WORKER_PRIVATE_KEY').address;
  const roles = { owner: owner.address, agent };
  const paid = paidWalletOf(process.env, roles, await client.getCode({ address: paidAddressOf(process.env, roles) }));
  await checkBaseUsdc(client);
  const { factory } = readJson(BaseDeployment, run.deploymentFile, 'Base deployment record');
  await requireCode(client, factory, 'factory');

  let state = loadBaseState(run.stateFile);
  if (state !== null && (state.factory !== factory || state.owner !== owner.address || state.agent !== agent || state.paid !== paid)) {
    throw new ProofSetupError('The saved Base run names another factory, owner, agent or paid wallet than now. Move its state file to start over.');
  }
  const existing = state === null ? undefined : state.vault;
  const code = existing === undefined ? undefined : await client.getCode({ address: existing });
  const exists = existing !== undefined && code !== undefined && code !== '0x';
  const deposited = exists ? (await client.readContract({ address: existing, abi: VAULT_ABI, functionName: 'state' })).deposited : 0n;
  const allowance = exists
    ? await client.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'allowance', args: [owner.address, existing] })
    : 0n;
  const { perWalletCap: cap, deposit, rootDelay, runSeconds } = MAINNET_PROOF;
  const plan = createPlan({ vault: exists, deposited, allowance }, deposit);
  console.log('The Base mainnet proof, fixed in code:');
  console.log(`  owner (PAYER_PRIVATE_KEY)   ${owner.address}`);
  console.log(`  agent (WORKER_PRIVATE_KEY)  ${agent}`);
  console.log(`  paid wallet (PAYTO_ADDRESS) ${paid}`);
  console.log(`  refused wallet              ${REFUSED_WALLET}, an address from a hash that no key controls`);
  console.log(`  USDC ${BASE_USDC}; cap ${usdc(cap)}; deposit ${usdc(deposit)}; root delay ${rootDelay} s; the vault runs ${runSeconds} s`);
  console.log(`  factory ${factory}`);
  if (plan.length === 0) {
    console.log(`Nothing to do: the vault ${state?.vault} exists and holds the deposit.`);
    return;
  }
  const [ownerUsdc, ownerEth] = await Promise.all([usdcBalance(client, owner.address), client.getBalance({ address: owner.address })]);
  console.log(`Still to do: ${plan.join(', ')}. The owner holds ${usdc(ownerUsdc)} and ${formatEther(ownerEth)} ETH.`);
  if (ownerUsdc < deposit) throw new ProofSetupError(`The owner holds ${usdc(ownerUsdc)}; the deposit needs ${usdc(deposit)}.`);
  const wallet = run.send ? run.wallet(owner.key) : undefined;
  const account = wallet?.account ?? owner.address;

  if (plan.includes('createVault')) {
    const endTime = (await chainNow(client)) + BigInt(runSeconds);
    const create = await client.simulateContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'createVault',
      args: [BASE_USDC, owner.address, agent, cap, endTime, rootDelay],
      account,
    });
    console.log(`createVault: simulated, it would create ${create.result}, ending ${at(endTime)}`);
    if (wallet === undefined) {
      console.log(`Then approve and deposit ${usdc(deposit)}. Simulated only: nothing was signed. Add --send to make the vault.`);
      return;
    }
    const sent = await confirm(client, await wallet.writeContract(create.request), owner.address);
    const receipt = await client.getTransactionReceipt({ hash: sent.hash });
    const [event] = parseEventLogs({ abi: FACTORY_ABI, eventName: 'VaultCreated', logs: receipt.logs }).filter((log) => parseAddress(log.address) === factory);
    if (!event || parseAddress(event.args.vault) !== parseAddress(create.result)) throw new ProofFailed('the factory did not report the vault it created');
    state = withTx(
      {
        chainId: 8453,
        factory,
        vault: parseAddress(event.args.vault),
        owner: owner.address,
        agent,
        paid,
        refused: REFUSED_WALLET,
        root: null,
        published: null,
        createdAtBlock: Number(receipt.blockNumber),
        endTime: Number(endTime),
        claimableAt: null,
        transactions: [],
      },
      'createVault',
      sent,
    );
    saveBaseState(run.stateFile, state);
    printSent('createVault', sent);
  }
  if (state === null) throw new ProofFailed('there is no vault to fund');
  const { vault } = state;
  if (plan.includes('approve')) {
    const approve = await client.simulateContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'approve', args: [vault, deposit], account });
    console.log(`approve(${vault}, ${deposit}) on USDC: simulated`);
    if (wallet === undefined) {
      console.log(`Then deposit ${usdc(deposit)}. Simulated only: nothing was signed.`);
      return;
    }
    const sent = await confirm(client, await wallet.writeContract(approve.request), owner.address);
    state = withTx(state, 'approve', sent);
    saveBaseState(run.stateFile, state);
    printSent('approve', sent);
  }
  const funding = await client.simulateContract({ address: vault, abi: VAULT_ABI, functionName: 'deposit', args: [deposit], account });
  console.log(`deposit(${deposit}) on the vault: simulated`);
  if (wallet === undefined) {
    console.log('Simulated only: nothing was signed. Add --send to deposit.');
    return;
  }
  const sent = await confirm(client, await wallet.writeContract(funding.request), owner.address);
  state = withTx(state, 'deposit', sent);
  saveBaseState(run.stateFile, state);
  printSent('deposit', sent);
  const after = await client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'state' });
  console.log(`The vault ${vault} holds ${usdc(after.deposited)} deposited: ${baseAddressLink(vault)}. Post the root next.`);
}

async function basePost(run: BaseRun): Promise<void> {
  const { client } = run;
  let state = needBaseState(run.stateFile);
  const agent = keyOf('WORKER_PRIVATE_KEY');
  if (agent.address !== state.agent) throw new ProofSetupError('WORKER_PRIVATE_KEY is not the agent this run was set up with.');
  await requireCode(client, state.vault, 'vault');
  const cap = MAINNET_PROOF.perWalletCap;
  const list = [{ account: state.paid, cumulativeAmount: cap }];
  const { root } = buildRoot(list, state.vault, BASE_ID);
  const view = await client.readContract({ address: state.vault, abi: VAULT_ABI, functionName: 'state' });
  if (!postNeeded(view, root)) {
    if (state.root === null) {
      if (view.pendingRoot.toLowerCase() !== root) throw new ProofFailed('the root is active, but this state file never saw it posted; restore the state file');
      state = { ...state, root, published: publishList(list), claimableAt: Number(view.pendingClaimableAt) };
      saveBaseState(run.stateFile, state);
    }
    console.log(`Nothing to do: the root ${root} is already on the vault, claimable at ${at(state.claimableAt ?? 0)}.`);
    return;
  }
  const now = await chainNow(client);
  whenReady('post', { now, endTime: view.endTime, rootDelay: view.rootDelay });
  if (view.deposited < cap) throw new ProofSetupError(`The vault holds ${usdc(view.deposited)}, less than the list promises: run create first.`);
  console.log(`postRoot: root ${root}, listing ${state.paid} at ${usdc(cap)}, claimable about ${at(now + BigInt(view.rootDelay))}`);
  if (!run.send) {
    await client.simulateContract({ address: state.vault, abi: VAULT_ABI, functionName: 'postRoot', args: [root, cap], account: agent.address });
    console.log('Simulated only: nothing was signed. Add --send to post the root.');
    return;
  }
  const campaign: CampaignRecord = {
    factory: state.factory,
    vault: state.vault,
    createdAtBlock: BigInt(state.createdAtBlock),
    token: BASE_USDC,
    owner: state.owner,
    agent: state.agent,
    perWalletCap: cap,
    endTime: BigInt(state.endTime),
    rootDelay: BigInt(MAINNET_PROOF.rootDelay),
  };
  const posted = await postRoot(vaultPort(client, run.wallet(agent.key)), campaign, list, { expectedRoot: root });
  const after = await client.readContract({ address: state.vault, abi: VAULT_ABI, functionName: 'state' });
  const sent: Sent = { hash: posted.hash, gasUsed: posted.gasUsed, from: agent.address };
  state = withTx({ ...state, root: posted.root, published: posted.published, claimableAt: Number(after.pendingClaimableAt) }, 'postRoot', sent);
  saveBaseState(run.stateFile, state);
  printSent('postRoot', sent);
  console.log(`The root becomes claimable at ${at(after.pendingClaimableAt)} (unix ${after.pendingClaimableAt}). Run claim then.`);
}

async function baseClaim(run: BaseRun): Promise<void> {
  const { client } = run;
  let state = needBaseState(run.stateFile);
  const agent = keyOf('WORKER_PRIVATE_KEY');
  if (agent.address !== state.agent) throw new ProofSetupError('WORKER_PRIVATE_KEY is not the agent this run was set up with.');
  if (state.root === null || state.published === null) throw new ProofSetupError('No root has been posted yet: run post first.');
  const view = await client.readContract({ address: state.vault, abi: VAULT_ABI, functionName: 'state' });
  whenReady('claim', { now: await chainNow(client), endTime: view.endTime, claimableAt: state.claimableAt === null ? null : BigInt(state.claimableAt) });
  // C32 from the claimant's side: the saved list rebuilds to the saved root, which is the vault's active root.
  const entries = readPublishedList(state.published);
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined || parseAddress(entry.account) !== state.paid) {
    throw new ProofFailed('the saved list does not hold only the paid wallet');
  }
  const { root, tree } = buildRoot(entries, state.vault, BASE_ID);
  if (root !== state.root || view.activeRoot !== root) throw new ProofFailed('the root rebuilt from the saved list is not the vault active root');
  const amount = entry.cumulativeAmount;
  const proof = proofFor(tree, state.paid);
  const claimed = await client.readContract({ address: state.vault, abi: VAULT_ABI, functionName: 'claimed', args: [state.paid] });
  if (claimNeeded(claimed, amount)) {
    const before = await usdcBalance(client, state.paid);
    console.log(`claim(${state.paid}, ${amount}): the agent submits it and the vault pays the paid wallet, which holds ${usdc(before)} now`);
    const wallet = run.send ? run.wallet(agent.key) : undefined;
    const sim = await client.simulateContract({
      address: state.vault,
      abi: VAULT_ABI,
      functionName: 'claim',
      args: [state.paid, amount, proof],
      account: wallet?.account ?? agent.address,
    });
    if (wallet === undefined) {
      console.log('Simulated only: nothing was signed. Add --send to claim.');
    } else {
      const sent = await confirm(client, await wallet.writeContract(sim.request), agent.address);
      const after = await usdcBalance(client, state.paid);
      if (after - before !== amount) throw new ProofFailed(`the paid wallet received ${usdc(after - before)}, not ${usdc(amount)}`);
      state = withTx(state, 'claim', sent);
      saveBaseState(run.stateFile, state);
      printSent('claim', sent);
      console.log(`The paid wallet ${state.paid} received exactly ${usdc(amount)}: ${usdc(before)} before, ${usdc(after)} after.`);
    }
  } else {
    console.log(`Nothing to send: claimed(${state.paid}) is already ${usdc(claimed)}.`);
  }
  const refusal = await claimRefusal(client, state.vault, state.agent, state.refused, amount, proof);
  if (refusal !== 'InvalidProof') throw new ProofFailed(`the refused wallet was not refused with InvalidProof (got ${refusal})`);
  console.log(`The refused wallet ${state.refused}: a static call of claim with the paid wallet's proof reverts with InvalidProof.`);
}

async function baseWithdraw(run: BaseRun): Promise<void> {
  const { client } = run;
  let state = needBaseState(run.stateFile);
  const owner = keyOf('PAYER_PRIVATE_KEY');
  if (owner.address !== state.owner) throw new ProofSetupError('PAYER_PRIVATE_KEY is not the owner this run was set up with.');
  const view = await client.readContract({ address: state.vault, abi: VAULT_ABI, functionName: 'state' });
  whenReady('withdraw', { now: await chainNow(client), endTime: view.endTime });
  const held = await usdcBalance(client, state.vault);
  if (!withdrawNeeded(held)) {
    console.log('Nothing to do: the vault holds no USDC.');
    return;
  }
  const before = await usdcBalance(client, state.owner);
  console.log(`withdrawAfterEnd(${state.owner}): returns the ${usdc(held)} left in the vault to the owner, who holds ${usdc(before)} now`);
  const wallet = run.send ? run.wallet(owner.key) : undefined;
  const sim = await client.simulateContract({
    address: state.vault,
    abi: VAULT_ABI,
    functionName: 'withdrawAfterEnd',
    args: [state.owner],
    account: wallet?.account ?? owner.address,
  });
  if (wallet === undefined) {
    console.log('Simulated only: nothing was signed. Add --send to withdraw.');
    return;
  }
  const sent = await confirm(client, await wallet.writeContract(sim.request), owner.address);
  const [after, left] = await Promise.all([usdcBalance(client, state.owner), usdcBalance(client, state.vault)]);
  if (after - before !== held || left !== 0n) throw new ProofFailed(`the owner got back ${usdc(after - before)} of ${usdc(held)}, and the vault holds ${usdc(left)}`);
  state = withTx(state, 'withdraw', sent);
  saveBaseState(run.stateFile, state);
  printSent('withdraw', sent);
  console.log(`The owner got back exactly ${usdc(held)}; the vault holds ${usdc(left)}.`);
}

async function baseRecord(run: BaseRun): Promise<void> {
  if (run.fork && inDeployments(run.recordFile)) {
    throw new ProofSetupError('A fork rehearsal never writes the public record: pass --record FILE outside packages/contracts/deployments.');
  }
  const { client } = run;
  const state = needBaseState(run.stateFile);
  const deployment = readJson(BaseDeployment, run.deploymentFile, 'Base deployment record');
  if (state.published === null || state.claimableAt === null) throw new ProofSetupError('No root has been posted yet.');
  const receipts = await receiptsOf(client, state.transactions);
  const entries = readPublishedList(state.published);
  const proof = proofFor(buildRoot(entries, state.vault, BASE_ID).tree, state.paid);
  const blockNumber = await client.getBlockNumber();
  const read = { address: state.vault, abi: VAULT_ABI, blockNumber } as const;
  const vaultState = await client.readContract({ ...read, functionName: 'state' });
  const claimedByPaid = await client.readContract({ ...read, functionName: 'claimed', args: [state.paid] });
  const vaultBalance = await usdcBalance(client, state.vault, blockNumber);
  const refusedSimulation = await claimRefusal(client, state.vault, state.agent, state.refused, MAINNET_PROOF.perWalletCap, proof, BigInt(state.claimableAt) + 1n);
  const proofRecord = buildBaseProofRecord(
    { state, deployment, chain: { receipts, vaultState, claimedByPaid, refusedSimulation, vaultBalance }, now: new Date() },
    BASE_PROFILE,
  );
  console.log(`Checked against Base at block ${blockNumber}. Every line agrees with the chain.`);
  console.log(`Paid ${proofRecord.paid.account} ${usdc(BigInt(proofRecord.paid.amount))}; refused ${proofRecord.refused.account} with ${proofRecord.refused.error}; returned ${usdc(BigInt(proofRecord.withdrawn.amount))} to the owner`);
  for (const tx of proofRecord.transactions) console.log(`  ${tx.label.padEnd(12)} ${baseTxLink(tx.hash as `0x${string}`)}  block ${tx.block}  gas ${tx.gasUsed}`);
  fs.mkdirSync(path.dirname(run.recordFile), { recursive: true });
  fs.writeFileSync(run.recordFile, `${JSON.stringify(proofRecord, null, 2)}\n`);
  console.log(`Wrote ${path.relative(REPO_ROOT, run.recordFile).replaceAll('\\', '/')}`);
}

async function baseVerify(run: BaseRun): Promise<number> {
  const { client } = run;
  const proof = readJson(BaseProofRecordFile, run.recordFile, 'Base proof record');
  const deployment = readJson(BaseDeployment, run.deploymentFile, 'Base deployment record');
  const code = await client.getCode({ address: proof.vault });
  if (code === undefined || code === '0x') throw new ProofFailed(`vault: there is no contract at the recorded vault ${proof.vault}`);
  const receipts = await receiptsOf(client, proof.transactions);
  const blockNumber = await client.getBlockNumber();
  const read = { address: proof.vault, abi: VAULT_ABI, blockNumber } as const;
  const vaultState = await client.readContract({ ...read, functionName: 'state' });
  const claimedByPaid = await client.readContract({ ...read, functionName: 'claimed', args: [proof.paid.account] });
  const claimedByRefused = await client.readContract({ ...read, functionName: 'claimed', args: [proof.refused.account] });
  const vaultBalance = await usdcBalance(client, proof.vault, blockNumber);
  const checks = verifyBaseProofRecord(proof, deployment, { receipts, vaultState, claimedByPaid, claimedByRefused, vaultBalance }, BASE_PROFILE);
  console.log(`Checking ${path.relative(REPO_ROOT, run.recordFile).replaceAll('\\', '/')} against Base at block ${blockNumber}:`);
  for (const { name, pass, detail } of checks) console.log(`  ${pass ? 'pass' : 'FAIL'}  ${name.padEnd(24)} ${detail}`);
  const failed = checks.filter((entry) => !entry.pass).map((entry) => entry.name);
  if (failed.length > 0) {
    console.error(`prove-vault verify failed: ${failed.join(', ')}`);
    return 1;
  }
  console.log(`All ${checks.length} checks pass. The vault on Basescan: ${baseAddressLink(proof.vault)}`);
  return 0;
}

async function runBase(
  positionals: string[],
  network: { rpcUrl: string; fork: boolean },
  values: { state?: string; deployment?: string; record?: string; send?: boolean },
): Promise<number> {
  const phase = positionals[0];
  if (positionals.length !== 1 || phase === undefined || !BASE_PHASES.includes(phase)) throw new ProofSetupError(BASE_USAGE);
  const stateFile = path.resolve(values.state ?? BASE_STATE);
  const deploymentFile = path.resolve(values.deployment ?? BASE_DEPLOYMENT);
  const recordFile = path.resolve(values.record ?? BASE_RECORD);
  if (network.fork) {
    // A rehearsal keeps every file of its own, so it can never resume, overwrite or publish the real run's.
    if (values.state === undefined || stateFile === BASE_STATE || inDeployments(stateFile)) {
      throw new ProofSetupError("--fork needs --state FILE of its own, away from the real run's state and the public records.");
    }
    if (values.deployment === undefined || inDeployments(deploymentFile)) {
      throw new ProofSetupError('--fork needs --deployment FILE outside packages/contracts/deployments: the fork factory record vault:deploy wrote.');
    }
  } else if (values.state !== undefined || values.deployment !== undefined) {
    throw new ProofSetupError('The real Base run uses its fixed files; --state and --deployment are for --fork.');
  }
  const { publicClient, wallet } = await connectBase(network.rpcUrl, network.fork);
  console.log(
    network.fork
      ? 'Rehearsal on a local anvil fork of Base mainnet: nothing here reaches the real chain.'
      : `Base mainnet, real money.${values.send === true ? '' : ' Without --send nothing is signed.'}`,
  );
  const run: BaseRun = { client: publicClient, wallet, fork: network.fork, send: values.send === true, stateFile, deploymentFile, recordFile };
  if (values.send === true && (phase === 'record' || phase === 'verify')) throw new ProofSetupError(`${phase} only reads; it takes no --send.`);
  if (phase === 'create') await baseCreate(run);
  else if (phase === 'post') await basePost(run);
  else if (phase === 'claim') await baseClaim(run);
  else if (phase === 'withdraw') await baseWithdraw(run);
  else if (phase === 'record') await baseRecord(run);
  else return baseVerify(run);
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'rpc-url': { type: 'string' },
      deployment: { type: 'string' },
      state: { type: 'string' },
      record: { type: 'string' },
      network: { type: 'string' },
      'real-money': { type: 'boolean' },
      fork: { type: 'boolean' },
      send: { type: 'boolean' },
    },
  });
  const network = chooseNetwork(values, process.env);
  if (network.name === 'base') return runBase(positionals, network, values);
  if (values.send !== undefined) throw new ProofSetupError('--send goes only with --network base; the Base Sepolia phases send as before.');
  const phase = positionals[0];
  const phases = ['setup', 'claim', 'record', 'verify'];
  if (positionals.length !== 1 || phase === undefined || !phases.includes(phase)) throw new ProofSetupError(USAGE);
  const stateFile = path.resolve(values.state ?? DEFAULT_STATE);
  const deploymentFile = path.resolve(values.deployment ?? DEFAULT_DEPLOYMENT);
  if (phase === 'verify') {
    if (values['rpc-url'] !== undefined || values.state !== undefined) {
      throw new ProofSetupError('verify needs no state file and reads Base Sepolia itself; it takes only --record FILE and --deployment FILE.');
    }
    const { rpcUrl, usesPublic } = loadVerifyRpc(process.env);
    if (usesPublic) console.log(`BASE_SEPOLIA_RPC_URL is not set, so this reads Base Sepolia through its public endpoint ${rpcUrl}.`);
    const { publicClient } = await connectBaseSepolia(rpcUrl);
    return verify(publicClient, deploymentFile, path.resolve(values.record ?? PROOF_RECORD));
  }
  if (values.record !== undefined) throw new ProofSetupError(USAGE);
  if (phase === 'record') {
    // A fork's transactions are not on Basescan, so a record built from one would publish links that lead nowhere.
    if (values['rpc-url'] !== undefined) throw new ProofSetupError('record reads Base Sepolia itself; --rpc-url is only for rehearsing setup and claim.');
    const { publicClient } = await connectBaseSepolia(loadRpcEnv(process.env));
    await record(publicClient, deploymentFile, stateFile);
    return 0;
  }
  const env = loadProofEnv(process.env, values['rpc-url']);
  const { publicClient, wallet } = await connectBaseSepolia(env.rpcUrl);
  const owner = wallet(env.payerKey);
  const agent = wallet(env.workerKey);
  if (env.rehearsal) console.log('Rehearsal on a local fork of Base Sepolia. Nothing here reaches a public network.');
  if (phase === 'setup') {
    await setup(publicClient, owner, agent, deploymentFile, stateFile, env.rehearsal);
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

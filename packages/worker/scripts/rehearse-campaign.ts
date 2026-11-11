// Rehearses the campaign worker end to end on a local anvil fork of Base Sepolia: six signed asks are screened through
// the real decision path with live SERV, each first funder classified from its own nonce and code on Ethereum, the
// approved wallets take the campaign's three slots, the list goes to a vault made by the real factory, the fork's clock
// moves past the root delay, and the worker submits each claim. Then, on a second campaign whose asks a stand-in
// screens: a post the worker sent but never recorded is cancelled by the owner and never sent again; a publish that
// stalls and is aborted sends nothing after a newer list is posted; and the owner pauses the vault across a list's
// activation, after which every listed wallet is paid exactly its amount. Last, on a third campaign: anvil drops a
// post from its pool and the worker signs it again at the same nonce, never a new one; and a claim waiting while the
// owner has paused the vault uses up none of its tries and is paid after the unpause.
//
//   npm run rehearse:campaign
//
// Reads BASE_SEPOLIA_RPC_URL (anvil forks it), SERV_API_KEY, SERV_BASE_URL, SERV_GRAPH_ID, ETH_RPC_URL and
// BLOCKSCOUT_ETH_API from .env and prints none of them. No key is loaded from .env: the owner, the agent and the six
// asking wallets are fresh keys made here, and every transaction stays inside the fork. The database is PGlite in this
// process. An ask needs a signature, so real wallets cannot ask; instead each fresh key stands for one real Ethereum
// wallet whose facts are read once, live, through the single-wallet reader; first funders are read live at each
// screening. Needs Foundry's anvil.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  createTestClient,
  decodeFunctionData,
  encodeAbiParameters,
  erc20Abi,
  formatUnits,
  http,
  keccak256,
  pad,
  parseEther,
  parseEventLogs,
  publicActions,
  toHex,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  askMessage,
  CHAINS,
  checkAsk,
  CURRENT_RULEBOOK,
  funderKind,
  graphVersion,
  HIGH_VOLUME_NONCE,
  parseAddress,
  type AccountState,
  type Address,
  type Facts,
} from '@thuli/core';
import {
  activeList,
  addAsk,
  counts,
  createCampaign,
  getAsk,
  getCampaign,
  listText,
  listVersions,
  migrate,
  openMemoryDb,
  type Db,
} from '@thuli/store';
import { readFactoryRecord, scrubber } from '../src/campaign/config.ts';
import { runOnce, type RunReport, type WorkerDeps } from '../src/campaign/loop.ts';
import { CANCEL_MARGIN_SECONDS, CANCELLED_LIST, publishCheck, reconcileCheck, RESEND_AFTER_SECONDS } from '../src/campaign/publish.ts';
import { PAUSED_VAULT } from '../src/campaign/relay.ts';
import { activateCheck, relayNext, type RelayOutcome } from '../src/campaign/relay.ts';
import { LONGEST_RETRY_SECONDS, screenNextAsk } from '../src/campaign/screen.ts';
import { campaignVault, emptyChainMemory, safeCause } from '../src/campaign/vault.ts';
import { loadEnv } from '../src/env.ts';
import type { DecideDeps } from '../src/replay/decide.ts';
import { accountStateAtFinalizedBlock, factsAtFinalizedBlock } from '../src/screen/single.ts';
import { decideViaGraph, decideViaV2, type ServReply } from '../src/serv/client.ts';
import { FACTORY_ABI, VAULT_ABI } from '../src/vault/abi.ts';
import { claimTicket } from '../src/vault/claimList.ts';
import { confirm, connectBaseSepolia, revertName } from '../src/vault/chain.ts';
import { loadRpcEnv } from '../src/vault/proof.ts';
import { readPublishedList } from '../src/vault/root.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RULEBOOK_FILE = path.join(REPO_ROOT, 'packages', 'rulebook', 'thuli-rulebook.md');
const DEPLOYMENT_FILE = path.join(REPO_ROOT, 'packages', 'contracts', 'deployments', 'base-sepolia.json');

const USDC = parseAddress(CHAINS['base-sepolia'].usdc);
// FiatToken keeps each balance in the mapping at storage slot 9, as packages/contracts/script/rehearse.mjs writes it.
const USDC_BALANCE_SLOT = 9n;
const REWARD = 1_000_000n;
const SLOTS = 3;
const DEPOSIT = REWARD * BigInt(SLOTS);
const ROOT_DELAY = 3600;
const CAMPAIGN_DAYS = 7;
const CAMPAIGN_ID = 'fork-rehearsal';
// The second campaign, for the restart, cancel, stall and pause proofs: three slots, so it can take one wallet and lose
// that list to the owner's cancel, take a second whose post stalls and is aborted, then a third, and pay all three.
const CAMPAIGN_B = 'fork-rehearsal-restarts';
const SLOTS_B = 3;
const DEPOSIT_B = REWARD * BigInt(SLOTS_B);
// The third campaign, for the lost-post and paused-claim proofs: one slot, one stand-in ask.
const CAMPAIGN_C = 'fork-rehearsal-lost-post';
const DEPOSIT_C = REWARD;
// Relay runs while the vault is paused, each after the claim's longest wait.
const PAUSED_RELAY_RUNS = 3;
const SETTINGS = { groupMinSize: 2, funderFanoutMin: 2 };
/** The live budget: one screening for each of the six asks, with none spare. */
export const MAX_SCREENINGS = 6;
const START_TIMEOUT_MS = 60_000;
const MAX_STDERR_CHARS = 4000;

/**
 * The real wallets the six keys stand for, in the order they ask. The first two are group 574 of the ROBO replay
 * (packages/web/public/replay/robo/groups/574.json): both were first funded straight from one wallet,
 * 0x120b3bd4c51cd9afb054991deadd8f3921f72fd9, with no hop between. The next two are old, active wallets with outcome 0
 * in the replay shards, each with a funder of its own. The last two are rows of data/replay/robo/rows.jsonl that the
 * replay classified as funded straight from one exchange, 0x28c6c06298d514db089934071355e5743bf21d60, with no hop: two
 * strangers who must not be linked.
 */
export const REAL_WALLETS = [
  { address: parseAddress('0x45ef68ac8d200529e940febb4f9edfd5a3de0c71'), role: 'linked' },
  { address: parseAddress('0x991d12f1d8d8ed5a25d2c02e7c47b6433f90a856'), role: 'linked' },
  { address: parseAddress('0x59170d55bba35af1f1f9c3d6b1f678fbb68a760e'), role: 'unrelated' },
  { address: parseAddress('0x439af839136afde86a1992a54906758993ae88f8'), role: 'unrelated' },
  { address: parseAddress('0xd35eb65e936cd43f20b62c46f7f6e4a8c2d683d7'), role: 'exchange-funded' },
  { address: parseAddress('0x5ceac35db63a706deb29b857f986a7e393992a0a'), role: 'exchange-funded' },
] as const;
type Role = (typeof REAL_WALLETS)[number]['role'];

class RehearsalError extends Error {
  override name = 'RehearsalError';
}

/** What the rehearsal reads from outside the fork. The live run uses the real reader and live SERV. */
export interface RehearsalSources {
  forkUrl: string;
  readFacts(wallet: Address): Promise<Facts>;
  /** An address's nonce and code at a finalized Ethereum block, the reader the worker classifies first funders with. */
  readAccount(address: Address): Promise<AccountState>;
  serv: DecideDeps;
  servLabel: string;
  /** Values that must never be printed: every URL and key the sources hold. */
  secrets: string[];
}

function foundryBinary(name: string): string {
  if (spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0) return name;
  const local = path.join(os.homedir(), '.foundry', 'bin', process.platform === 'win32' ? `${name}.exe` : name);
  if (fs.existsSync(local)) return local;
  throw new RehearsalError(`${name} not found. Install Foundry (https://getfoundry.sh) and run foundryup.`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const usdc = (amount: bigint) => `${formatUnits(amount, 6)} USDC`;

/**
 * Runs the whole rehearsal and returns its exit code: 0 only when every check passes. anvil is stopped on every path.
 */
export async function rehearse(sources: RehearsalSources): Promise<number> {
  const ownerKey = generatePrivateKey();
  const agentKey = generatePrivateKey();
  const askKeys = REAL_WALLETS.map(() => generatePrivateKey());
  const askKeysB = Array.from({ length: SLOTS_B }, () => generatePrivateKey());
  const askKeyC = generatePrivateKey();
  const signatures: string[] = [];
  const clean = scrubber([...sources.secrets, ownerKey, agentKey, ...askKeys, ...askKeysB, askKeyC]);
  const say = (line: string) => console.log(clean(line));
  const workerLines: string[] = [];
  const failures: string[] = [];
  const check = (passed: boolean, line: string) => {
    say(`  ${passed ? 'pass' : 'FAIL'}  ${line}`);
    if (!passed) failures.push(line);
  };

  say(`Rehearsal on a local fork of Base Sepolia, with ${sources.servLabel}. Nothing here reaches a public network.`);
  say('\n== Facts of the six real wallets, read once through the single-wallet reader');
  const realFacts = new Map<Address, Facts>();
  for (const { address, role } of REAL_WALLETS) {
    const facts = await sources.readFacts(address);
    realFacts.set(address, facts);
    const funder = facts.firstFunder === null ? 'none read' : facts.firstFunder.address;
    say(`  ${address} (${role}): ${facts.walletAgeDays ?? '?'} days, ${facts.txCountAtSnapshot ?? '?'} txs, first funder ${funder}`);
  }
  // Every funder state the screenings read, so the results can show the nonce each kind was decided from.
  const statesRead = new Map<Address, AccountState>();
  const readAccount = async (address: Address) => {
    const state = await sources.readAccount(address);
    statesRead.set(parseAddress(address), state);
    return state;
  };
  const sharedFunder = (role: Role) => {
    const [one, other] = REAL_WALLETS.filter((wallet) => wallet.role === role).map(
      (wallet) => realFacts.get(wallet.address)?.firstFunder?.address,
    );
    return one !== undefined && one === other ? one : undefined;
  };
  // Checked before any SERV call, so a pair that no longer fits its role cannot spend the screening budget.
  for (const [role, kind] of [['linked', 'wallet'], ['exchange-funded', 'exchange']] as const) {
    const funder = sharedFunder(role);
    if (funder === undefined) throw new RehearsalError(`the two ${role} wallets do not show one first funder today`);
    const state = await readAccount(funder);
    say(`  shared first funder of the ${role} pair ${funder}: nonce ${state.nonce}, ${state.code === '0x' ? 'no code' : 'code'}, kind ${funderKind(state)}`);
    if (funderKind(state) !== kind) throw new RehearsalError(`the ${role} pair's funder reads as ${funderKind(state)}, not ${kind}`);
  }

  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  let stderr = '';
  const anvil: ChildProcess = spawn(foundryBinary('anvil'), ['--fork-url', sources.forkUrl, '--port', String(port), '--silent'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  anvil.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-MAX_STDERR_CHARS);
  });
  const stopAnvil = () => {
    if (anvil.exitCode === null) anvil.kill();
  };
  process.once('exit', stopAnvil);
  let db: Db | undefined;
  try {
    say(`\n== anvil fork on ${rpcUrl}`);
    const test = createTestClient({ mode: 'anvil', transport: http(rpcUrl, { timeout: 30_000 }) }).extend(publicActions);
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      if (anvil.exitCode !== null) throw new RehearsalError(`anvil stopped: ${clean(stderr.trim()) || 'no message'}`);
      try {
        await test.getChainId();
        break;
      } catch {
        if (Date.now() > deadline) throw new RehearsalError('anvil did not start within a minute');
        await wait(500);
      }
    }
    const { publicClient, wallet } = await connectBaseSepolia(rpcUrl);
    const forkBlock = await publicClient.getBlockNumber();
    const owner = wallet(ownerKey);
    const agent = wallet(agentKey);
    say(`  fork block ${forkBlock}; owner ${owner.account.address}, agent ${agent.account.address} (fresh keys)`);

    await test.setBalance({ address: owner.account.address, value: parseEther('1') });
    await test.setBalance({ address: agent.account.address, value: parseEther('1') });
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner.account.address, USDC_BALANCE_SLOT]));
    const funded = DEPOSIT + DEPOSIT_B + DEPOSIT_C;
    await test.setStorageAt({ address: USDC, index: slot, value: pad(toHex(funded)) });
    const balance = (address: Address) =>
      publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
    if ((await balance(owner.account.address)) !== funded) throw new RehearsalError('the USDC balance slot has moved');
    say(`  owner funded with 1 fork ETH and ${usdc(funded)}, agent with 1 fork ETH`);

    const factory = readFactoryRecord(DEPLOYMENT_FILE);
    const code = await publicClient.getCode({ address: factory.address });
    if (code === undefined || code === '0x') throw new RehearsalError(`no factory contract at ${factory.address} on the fork`);
    // The owner makes a vault from the real factory with the minimum root delay and deposits `amount` into it.
    const makeVault = async (amount: bigint) => {
      const now = (await publicClient.getBlock()).timestamp;
      const create = await publicClient.simulateContract({
        address: factory.address,
        abi: FACTORY_ABI,
        functionName: 'createVault',
        args: [USDC, owner.account.address, agent.account.address, REWARD, now + BigInt(CAMPAIGN_DAYS * 86_400), ROOT_DELAY],
        account: owner.account,
      });
      const created = await confirm(publicClient, await owner.writeContract(create.request), owner.account.address);
      const receipt = await publicClient.getTransactionReceipt({ hash: created.hash });
      const [event] = parseEventLogs({ abi: FACTORY_ABI, eventName: 'VaultCreated', logs: receipt.logs });
      if (event === undefined) throw new RehearsalError('the factory logged no VaultCreated');
      const made = parseAddress(event.args.vault);
      const minimum = await publicClient.readContract({ address: made, abi: VAULT_ABI, functionName: 'MIN_ROOT_DELAY' });
      if (minimum !== ROOT_DELAY) throw new RehearsalError(`the vault's minimum root delay is ${minimum} seconds, not ${ROOT_DELAY}`);
      const approve = await publicClient.simulateContract({
        address: USDC,
        abi: erc20Abi,
        functionName: 'approve',
        args: [made, amount],
        account: owner.account,
      });
      await confirm(publicClient, await owner.writeContract(approve.request), owner.account.address);
      const deposit = await publicClient.simulateContract({
        address: made,
        abi: VAULT_ABI,
        functionName: 'deposit',
        args: [amount],
        account: owner.account,
      });
      await confirm(publicClient, await owner.writeContract(deposit.request), owner.account.address);
      say(`  vault ${made}, created in block ${receipt.blockNumber}, root delay ${minimum} s (the vault minimum), ${usdc(amount)} deposited`);
      return { vault: made, block: receipt.blockNumber };
    };

    say('\n== Vault from the real factory: 1 USDC cap, the minimum root delay, three slots deposited');
    const { vault, block: vaultBlock } = await makeVault(DEPOSIT);

    db = await openMemoryDb();
    await migrate(db);
    const opened = new Date();
    await createCampaign(db, {
      id: CAMPAIGN_ID,
      name: 'Fork rehearsal',
      chain: CHAINS['base-sepolia'].id,
      vault,
      token: USDC,
      owner: owner.account.address,
      agent: agent.account.address,
      rewardPerWallet: REWARD.toString(),
      perWalletCap: REWARD.toString(),
      partialShareBps: 5000,
      maxSlots: SLOTS,
      rulebook: CURRENT_RULEBOOK,
      settings: SETTINGS,
      status: 'open',
      opensAt: new Date(opened.getTime() - 60_000),
      closesAt: new Date(opened.getTime() + 86_400_000),
      createdAt: opened,
      vaultBlock,
    });
    const stored = await getCampaign(db, CAMPAIGN_ID);
    if (stored?.settings.groupMinSize !== SETTINGS.groupMinSize || stored.settings.funderFanoutMin !== SETTINGS.funderFanoutMin) {
      throw new RehearsalError('the store did not keep the campaign settings, so the screening would run on the defaults');
    }
    say(`  campaign ${CAMPAIGN_ID}: ${SLOTS} slots, ${usdc(REWARD)} each, settings ${JSON.stringify(stored.settings)}`);

    // Signs an ask with `key`, checks it as the API would, and queues it.
    const store = db;
    const queueAsk = async (campaignId: string, key: Hex, askedAt: Date): Promise<Address> => {
      const account = privateKeyToAccount(key);
      const signedAt = Math.floor(askedAt.getTime() / 1000);
      const signature = await account.signMessage({ message: askMessage({ campaignId, wallet: account.address, signedAt }) });
      signatures.push(signature);
      const checked = await checkAsk(
        { campaignId, wallet: account.address, signedAt, signature },
        {
          expectedCampaignId: campaignId,
          now: signedAt,
          isContract: async (address) => ((await publicClient.getCode({ address })) ?? '0x') !== '0x',
        },
      );
      if (!checked.ok) throw new RehearsalError(`an ask failed checkAsk: ${checked.cause}`);
      const added = await addAsk(store, { campaignId, wallet: checked.wallet, signedAt, signature }, askedAt);
      if (added !== 'queued') throw new RehearsalError(`an ask was not queued: ${added}`);
      return checked.wallet;
    };

    say('\n== Six asks, each signed by a fresh key that stands for one real wallet');
    const standsFor = new Map<Address, Address>();
    for (const [index, key] of askKeys.entries()) {
      const asker = await queueAsk(CAMPAIGN_ID, key, new Date(opened.getTime() + index * 1000));
      const real = REAL_WALLETS[index]?.address as Address;
      standsFor.set(asker, real);
      say(`  ask ${index + 1}: ${asker} stands for ${real}`);
    }

    let servCalls = 0;
    const counted = (route: DecideDeps['viaGraph']): DecideDeps['viaGraph'] => (record) => {
      servCalls += 1;
      return route(record);
    };
    const deps: WorkerDeps = {
      db,
      facts: async (asker) => {
        const read = realFacts.get(standsFor.get(asker) as Address);
        if (read === undefined) throw new RehearsalError('no facts were read for this wallet');
        return read;
      },
      accountState: readAccount,
      serv: { viaGraph: counted(sources.serv.viaGraph), viaV2: counted(sources.serv.viaV2), sleep: sources.serv.sleep },
      chain: campaignVault(publicClient, agent),
      factory: factory.address,
      now: () => new Date(),
      log: (line) => {
        workerLines.push(line);
        say(`  worker: ${line}`);
      },
      memory: emptyChainMemory(),
    };

    say(`\n== Screening, through the shared decision path, at most ${MAX_SCREENINGS} screenings`);
    let screenings = 0;
    while (screenings < MAX_SCREENINGS) {
      const outcome = await screenNextAsk(deps);
      if (outcome.kind === 'idle') break;
      screenings += 1;
    }
    const tally = await counts(db, CAMPAIGN_ID);
    if (tally === null || tally.queued > 0) throw new RehearsalError(`not every ask was decided within ${MAX_SCREENINGS} screenings`);

    say('\n== Publish the slot holders to the vault');
    const posted = await publishCheck(deps, CAMPAIGN_ID);
    if (posted.kind !== 'posted') throw new RehearsalError(`nothing was posted: ${posted.reason}`);

    say(`\n== evm_increaseTime ${ROOT_DELAY} seconds and evm_mine, past the root delay`);
    await test.increaseTime({ seconds: ROOT_DELAY });
    await test.mine({ blocks: 1 });

    say('\n== Activate and relay');
    const activated = await activateCheck(deps, CAMPAIGN_ID);
    if (activated.kind !== 'queued') throw new RehearsalError(`the list did not activate: ${activated.reason}`);
    const relays: RelayOutcome[] = [];
    for (let n = 0; n < 2 * SLOTS; n += 1) {
      const outcome = await relayNext(deps);
      if (outcome.kind === 'idle') break;
      relays.push(outcome);
    }

    say('\n== Second run: the relay step, then one whole run of the loop');
    const nonceBefore = await publicClient.getTransactionCount({ address: agent.account.address });
    const again = await relayNext(deps);
    const loopRun = await runOnce(deps);
    const nonceAfter = await publicClient.getTransactionCount({ address: agent.account.address });
    const stepsOf = (run: RunReport) =>
      Array.isArray(run.campaigns)
        ? run.campaigns.map((one) => `${one.campaignId} reconcile ${one.reconcile.kind}, activate ${one.activate.kind}, publish ${one.publish.kind}`).join('; ')
        : `campaigns ${run.campaigns.kind}`;
    say(`  relay step: ${again.kind}; loop run: screen ${loopRun.screen.kind}, ${stepsOf(loopRun)}, relay ${loopRun.relay.kind}`);

    say('\n== Results');
    const active = await activeList(db, CAMPAIGN_ID);
    const text = active === null ? null : await listText(db, CAMPAIGN_ID, active.version);
    if (active === null || text === null) throw new RehearsalError('no list is active after the delay');
    const entries = readPublishedList(text);
    const listed = new Map(entries.map((entry) => [parseAddress(entry.account), entry.cumulativeAmount]));
    const paid = new Map<Address, bigint>();
    for (const [asker, real] of standsFor) {
      const decided = await getAsk(db, CAMPAIGN_ID, asker);
      const received = await balance(asker);
      paid.set(asker, received);
      say(
        `  ${asker} for ${real}: ${decided?.action ?? '?'} under ${decided?.rule ?? '?'}, ` +
          `${decided?.slot === null || decided?.slot === undefined ? 'no slot' : `slot ${decided.slot}`}, received ${usdc(received)}`,
      );
    }
    const state = await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'state' });
    say(`  list version ${active.version} root ${active.root}, ${entries.length} wallets`);
    say(`  vault totalPaid ${usdc(state.totalPaid)} of ${usdc(state.deposited)} deposited`);
    say(`  gas: postRoot ${posted.kind === 'posted' ? posted.gasUsed : '?'}; claims ${relays.map((relay) => (relay.kind === 'relayed' ? String(relay.gasUsed ?? '?') : '?')).join(', ')}`);
    const roleOf = (asker: Address) => REAL_WALLETS.find((wallet) => wallet.address === standsFor.get(asker))?.role;
    const exchangeFunded: {
      asker: Address;
      kind?: string;
      fanout?: number | null;
      groupSize?: number | null;
      funder?: Address;
      nonce?: number | null;
    }[] = [];
    for (const asker of standsFor.keys()) {
      if (roleOf(asker) !== 'exchange-funded') continue;
      const facts = (await getAsk(db, CAMPAIGN_ID, asker))?.facts;
      const funder = facts?.funder ?? undefined;
      const nonce = funder === undefined ? undefined : statesRead.get(parseAddress(funder.address))?.nonce;
      exchangeFunded.push({ asker, kind: funder?.kind, fanout: funder?.fanout, groupSize: facts?.groupSize, funder: funder?.address, nonce });
      say(
        `  exchange-funded ${asker} for ${standsFor.get(asker)}: first funder ${funder?.address ?? '?'}, read nonce ${nonce ?? '?'}, ` +
          `kind ${funder?.kind ?? '?'}, fan-out ${funder?.fanout ?? 'none'}, group size ${facts?.groupSize ?? 'none'}`,
      );
    }
    say(`  screenings used ${screenings} of ${MAX_SCREENINGS}, SERV calls ${servCalls}`);

    say('\n== Checks');
    const askers = [...standsFor.keys()];
    const linkedPaid = askers.filter((asker) => roleOf(asker) === 'linked' && (paid.get(asker) ?? 0n) > 0n).length;
    check(linkedPaid === 1, `exactly one of the two wallets one funder paid was paid (${linkedPaid})`);
    for (const wallet of exchangeFunded) {
      check(
        wallet.kind === 'exchange' && wallet.fanout === null && wallet.groupSize === null,
        `exchange-funded ${wallet.asker} is unlinked: kind ${wallet.kind ?? '?'}, no fan-out, no group`,
      );
      check((wallet.nonce ?? 0) >= HIGH_VOLUME_NONCE, `its funder's nonce ${wallet.nonce ?? '?'} was read at or above ${HIGH_VOLUME_NONCE}`);
    }
    const exchangeFunders = new Set(exchangeFunded.map((wallet) => wallet.funder));
    check(exchangeFunded.length === 2 && exchangeFunders.size === 1, 'both exchange-funded wallets were screened with one shared first funder');
    let sum = 0n;
    for (const asker of askers) {
      const received = paid.get(asker) ?? 0n;
      const owed = listed.get(asker) ?? 0n;
      sum += received;
      check(received === owed, `${asker} received exactly its listed ${usdc(owed)} (got ${usdc(received)})`);
      check(received <= REWARD, `${asker} received no more than the ${usdc(REWARD)} cap`);
    }
    check(state.totalPaid === sum, `totalPaid ${usdc(state.totalPaid)} equals the sum paid, ${usdc(sum)}`);
    check(again.kind === 'idle' && nonceAfter === nonceBefore, 'a second run of the relay step, and of the whole loop, sent nothing');

    const proofOf = (account: Address) => claimTicket(text, vault, CHAINS['base-sepolia'].id, account);
    // Off the list either because it was held or because it was approved after the last slot went.
    const unlisted = askers.filter((asker) => !listed.has(asker));
    for (const held of unlisted) {
      const why = (await getAsk(db, CAMPAIGN_ID, held))?.action === 'hold' ? 'held' : 'approved without a slot';
      const claimableNoLeaf = await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: 'claimable', args: [held, 0n] });
      check(claimableNoLeaf === 0n, `${why} ${held}: claimable(account, 0) is 0, since a wallet off the list has no leaf and so no amount`);
      const borrowed = proofOf(parseAddress(entries[0]?.account ?? held));
      let refusal = 'success';
      try {
        await publicClient.simulateContract({
          address: vault,
          abi: VAULT_ABI,
          functionName: 'claim',
          args: [held, REWARD, borrowed?.proof ?? []],
          account: agent.account,
        });
      } catch (error) {
        refusal = revertName(error) ?? 'an unrecognised revert';
      }
      check(refusal === 'InvalidProof', `${why} ${held}: a claim with a listed wallet's proof is refused (${refusal})`);
    }
    for (const entry of entries) {
      const ticket = proofOf(parseAddress(entry.account));
      let refusal = 'success';
      try {
        await publicClient.simulateContract({
          address: vault,
          abi: VAULT_ABI,
          functionName: 'claim',
          args: [parseAddress(entry.account), entry.cumulativeAmount, ticket?.proof ?? []],
          account: agent.account,
        });
      } catch (error) {
        refusal = revertName(error) ?? 'an unrecognised revert';
      }
      check(refusal === 'NothingToClaim', `paid ${entry.account}: claiming again is refused (${refusal})`);
    }

    say('\n== Restart and cancel proofs on a second campaign, its asks screened by a stand-in so no live screening is spent');
    const second = await makeVault(DEPOSIT_B);
    await createCampaign(db, {
      id: CAMPAIGN_B,
      name: 'Fork rehearsal, restarts',
      chain: CHAINS['base-sepolia'].id,
      vault: second.vault,
      token: USDC,
      owner: owner.account.address,
      agent: agent.account.address,
      rewardPerWallet: REWARD.toString(),
      perWalletCap: REWARD.toString(),
      partialShareBps: 5000,
      maxSlots: SLOTS_B,
      rulebook: CURRENT_RULEBOOK,
      settings: {},
      status: 'open',
      opensAt: new Date(Date.now() - 60_000),
      closesAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
      vaultBlock: second.block,
    });
    const standInFacts = new Map<Address, Facts>();
    const confirmStart = async (record: Parameters<DecideDeps['viaGraph']>[0]): Promise<ServReply> => {
      const rawText = JSON.stringify({
        verdict: 'ordinary_user',
        action: record.start_outcome,
        rule: record.start_rule,
        reason: 'A stand-in answer for the restart proofs.',
        cited_tx_hashes: [],
      });
      return { requestId: null, rawText, answer: rawText, answerProblem: null, usage: null };
    };
    const standIn: WorkerDeps = {
      ...deps,
      facts: async (asker) => {
        const read = standInFacts.get(asker);
        if (read === undefined) throw new RehearsalError('no stand-in facts for this wallet');
        return read;
      },
      accountState: async () => ({ nonce: 12, code: '0x' }),
      serv: { viaGraph: confirmStart, viaV2: confirmStart, sleep: async () => undefined },
      memory: emptyChainMemory(),
    };
    const askStandIn = async (campaignId: string, key: Hex) => {
      const asker = await queueAsk(campaignId, key, new Date());
      const funder = privateKeyToAccount(generatePrivateKey()).address;
      standInFacts.set(asker, {
        walletAgeDays: 900,
        txCountAtSnapshot: 80,
        accountType: 'eoa',
        firstFunder: { address: funder, kind: 'unknown', fanoutInList: null, hopsTraced: 1 },
        group: null,
        sharedDepositAddress: null,
        fundingBurst: null,
        claimPaidToOtherAddress: null,
        evidenceTxs: [],
        missing: ['group', 'sharedDepositAddress', 'claimPaidToOtherAddress'],
      });
      const decided = await screenNextAsk(standIn);
      if (decided.kind !== 'decided' || decided.slot === null) throw new RehearsalError('a stand-in ask did not take a slot');
      return asker;
    };
    const askB = (key: Hex) => askStandIn(CAMPAIGN_B, key);
    const reportFor = (run: RunReport) => (Array.isArray(run.campaigns) ? run.campaigns.find((one) => one.campaignId === CAMPAIGN_B) : undefined);
    const versionsOfB = () => listVersions(store, CAMPAIGN_B);
    const statusesB = async () => (await versionsOfB()).map((version) => version.status).join(', ');
    const agentNonce = () => publicClient.getTransactionCount({ address: agent.account.address });
    const vaultOf = new Map<string, Address>([[CAMPAIGN_B, second.vault]]);
    const ownerCalls = async (functionName: 'cancelRoot' | 'pause' | 'unpause', campaignId = CAMPAIGN_B) => {
      const target = vaultOf.get(campaignId) as Address;
      const call = await publicClient.simulateContract({ address: target, abi: VAULT_ABI, functionName, account: owner.account });
      await confirm(publicClient, await owner.writeContract(call.request), owner.account.address);
      say(`  the owner called ${functionName} on the vault of ${campaignId}`);
    };
    const moveClock = async (seconds: number, why: string) => {
      await test.increaseTime({ seconds });
      await test.mine({ blocks: 1 });
      say(`  evm_increaseTime ${seconds} seconds and evm_mine, ${why}`);
    };

    say('\n  (i) a post sent but never recorded, then the owner cancels it');
    const firstB = await askB(askKeysB[0] as Hex);
    const stopsAfterSending: WorkerDeps = {
      ...standIn,
      chain: {
        ...standIn.chain,
        broadcast: async (signed) => {
          await standIn.chain.broadcast(signed);
          throw new RehearsalError('the worker stopped after sending the post and before recording it');
        },
      },
    };
    let stoppedAfterSending = false;
    try {
      await publishCheck(stopsAfterSending, CAMPAIGN_B);
    } catch (error) {
      stoppedAfterSending = error instanceof RehearsalError;
    }
    const [unrecorded] = await versionsOfB();
    check(stoppedAfterSending && unrecorded?.status === 'sending', `${CAMPAIGN_B}: stopped after the send, list version 1 is recorded as sending (${await statusesB()})`);
    // The send returns before the fork mines it, and the owner cancels a root they can see pending.
    await publicClient.waitForTransactionReceipt({ hash: unrecorded?.postTx as `0x${string}`, timeout: 60_000 });
    await ownerCalls('cancelRoot');
    await moveClock(CANCEL_MARGIN_SECONDS, 'past the cancel margin');
    const restarted: WorkerDeps = { ...standIn, memory: emptyChainMemory() };
    const beforeCancelRuns = await agentNonce();
    const afterCancel = reportFor(await runOnce(restarted));
    const laterRun = reportFor(await runOnce(restarted));
    const settled = afterCancel?.reconcile.kind === 'reconciled' && afterCancel.reconcile.posted.join() === '1' && afterCancel.reconcile.cancelled.join() === '1';
    check(settled, `${CAMPAIGN_B}: after a restart, reconcile settled version 1 from its receipt and recorded the owner's cancel (${await statusesB()})`);
    const leftAlone = [afterCancel, laterRun].every((run) => run?.publish.kind === 'skipped' && run.publish.reason === CANCELLED_LIST);
    check(leftAlone && (await agentNonce()) === beforeCancelRuns, `${CAMPAIGN_B}: neither run posted it again: "${CANCELLED_LIST}"`);

    say('\n  (iii) a publish that stalls before signing is aborted, and a newer list is posted meanwhile');
    const secondB = await askB(askKeysB[1] as Hex);
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let stalledSends = 0;
    const stalls: WorkerDeps = {
      ...restarted,
      chain: {
        ...restarted.chain,
        signPostRoot: async (...args) => {
          await gate;
          return restarted.chain.signPostRoot(...args);
        },
        broadcast: async (signed) => {
          stalledSends += 1;
          return restarted.chain.broadcast(signed);
        },
      },
      timeouts: { publish: 2_000 },
    };
    const stalled = reportFor(await runOnce(stalls));
    check(stalled?.publish.kind === 'timed-out', `${CAMPAIGN_B}: the publish for 2 wallets stalled and was stopped at its limit (${stalled?.publish.kind ?? '?'})`);
    const thirdB = await askB(askKeysB[2] as Hex);
    const newer = reportFor(await runOnce(restarted));
    check(newer?.publish.kind === 'posted', `${CAMPAIGN_B}: a newer list for 3 wallets was posted (${newer?.publish.kind ?? '?'})`);
    const afterNewer = await agentNonce();
    openGate();
    await wait(3_000);
    const versionsNow = await versionsOfB();
    const stalledRoot = versionsNow.find((version) => version.version === 2)?.root ?? '';
    const newerRoot = versionsNow.find((version) => version.version === 3)?.root ?? '';
    const stateNow = await publicClient.readContract({ address: second.vault, abi: VAULT_ABI, functionName: 'state' });
    check(
      stalledSends === 0 && (await agentNonce()) === afterNewer && stateNow.pendingRoot.toLowerCase() === newerRoot,
      `${CAMPAIGN_B}: once released, the stopped publish sent nothing; the vault still waits on list version 3 (${await statusesB()})`,
    );

    say('\n  (ii) the owner pauses the vault across the activation of list version 3');
    await moveClock(ROOT_DELAY, 'past the root delay');
    await ownerCalls('pause');
    const whilePaused = reportFor(await runOnce(restarted));
    check(
      whilePaused?.activate.kind === 'skipped' && whilePaused.activate.reason === PAUSED_VAULT && (await statusesB()) === 'cancelled, cancelled, posted',
      `${CAMPAIGN_B}: while paused, activate marked nothing and queued nothing ("${PAUSED_VAULT}")`,
    );
    await ownerCalls('unpause');
    for (let run = 0; run < 2 + SLOTS_B; run += 1) await runOnce(restarted);
    const stateB = await publicClient.readContract({ address: second.vault, abi: VAULT_ABI, functionName: 'state' });
    say(`  ${CAMPAIGN_B}: versions ${versionsNow.map((version) => version.version).join(', ')} now ${await statusesB()}; totalPaid ${usdc(stateB.totalPaid)}`);
    for (const asker of [firstB, secondB, thirdB]) {
      const received = await balance(asker);
      check(received === REWARD, `${CAMPAIGN_B}: ${asker} received exactly ${usdc(REWARD)} after the unpause (got ${usdc(received)})`);
    }
    check(stateB.totalPaid === DEPOSIT_B && (await statusesB()) === 'cancelled, cancelled, active', `${CAMPAIGN_B}: list version 3 is active and paid ${usdc(stateB.totalPaid)}`);

    say('\n== Lost-post and paused-claim proofs on a third campaign, its one ask screened by a stand-in');
    const third = await makeVault(DEPOSIT_C);
    vaultOf.set(CAMPAIGN_C, third.vault);
    await createCampaign(db, {
      id: CAMPAIGN_C,
      name: 'Fork rehearsal, lost post',
      chain: CHAINS['base-sepolia'].id,
      vault: third.vault,
      token: USDC,
      owner: owner.account.address,
      agent: agent.account.address,
      rewardPerWallet: REWARD.toString(),
      perWalletCap: REWARD.toString(),
      partialShareBps: 5000,
      maxSlots: 1,
      rulebook: CURRENT_RULEBOOK,
      settings: {},
      status: 'open',
      opensAt: new Date(Date.now() - 60_000),
      closesAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
      vaultBlock: third.block,
    });
    const askerC = await askStandIn(CAMPAIGN_C, askKeyC);
    // The resend wait and the relay waits run on the worker's clock, not the chain's, so this worker's clock is moved
    // forward by hand while the chain stays live.
    let ahead = 0;
    const signedAtC: number[] = [];
    const later: WorkerDeps = {
      ...standIn,
      chain: {
        ...standIn.chain,
        signPostRoot: async (...args) => {
          const signed = await standIn.chain.signPostRoot(...args);
          signedAtC.push(signed.nonce);
          return signed;
        },
      },
      now: () => new Date(Date.now() + ahead),
      memory: emptyChainMemory(),
    };
    const versionC = async () => (await listVersions(store, CAMPAIGN_C)).at(-1);

    say('\n  (iv) anvil drops a post from its pool, and the worker signs it again at the same nonce');
    const freeNonce = await agentNonce();
    let dropped: Hex | undefined;
    const losesIt: WorkerDeps = {
      ...later,
      chain: {
        ...later.chain,
        broadcast: async (signed) => {
          await later.chain.broadcast(signed);
          await test.dropTransaction({ hash: signed.hash });
          dropped = signed.hash;
          say(`  anvil_dropTransaction ${signed.hash}: no node has the post now`);
        },
        // Looks once, so the publish does not sit out its whole receipt wait for a transaction that is gone.
        postReceipt: (target, root, hash) => later.chain.postReceipt(target, root, hash, 0),
      },
    };
    await test.setAutomine(false);
    let lostRefused = false;
    try {
      await publishCheck(losesIt, CAMPAIGN_C);
    } catch {
      lostRefused = true;
    } finally {
      await test.setAutomine(true);
    }
    const sendingC = await versionC();
    let goneFromNode = false;
    try {
      await publicClient.getTransaction({ hash: dropped as Hex });
    } catch {
      goneFromNode = true;
    }
    check(
      lostRefused && sendingC?.status === 'sending' && sendingC.postTx === dropped?.toLowerCase() && sendingC.postNonce === freeNonce && goneFromNode && (await agentNonce()) === freeNonce,
      `${CAMPAIGN_C}: the dropped post is recorded as sending at nonce ${freeNonce}, which no mined transaction has used`,
    );
    const firstLook = await reconcileCheck(later, CAMPAIGN_C);
    ahead = (RESEND_AFTER_SECONDS + 1) * 1000;
    const resendLook = await reconcileCheck(later, CAMPAIGN_C);
    const afterResend = await versionC();
    const resentHash = (afterResend?.postTx ?? dropped) as Hex;
    const resentTx = await publicClient.getTransaction({ hash: resentHash });
    // With nothing on the fork moving the fees, the same nonce, target and data sign to the very same bytes, so the hash
    // may repeat; what counts is that it was signed again at its own nonce and is now on the node.
    check(
      [firstLook, resendLook].every((run) => run.kind === 'reconciled' && run.unsent.length === 0) &&
        afterResend?.status === 'sending' &&
        signedAtC.join() === `${freeNonce},${freeNonce}` &&
        resentTx.nonce === freeNonce,
      `${CAMPAIGN_C}: after ${RESEND_AFTER_SECONDS} s unseen it was signed again at nonce ${freeNonce} and sent as ${resentHash}, and nothing was built again ` +
        `(signed at ${signedAtC.join(', ')}; ${afterResend?.status ?? '?'}; on the node at nonce ${resentTx.nonce})`,
    );
    await publicClient.waitForTransactionReceipt({ hash: resentHash, timeout: 60_000 });
    const settledC = await reconcileCheck(later, CAMPAIGN_C);
    check(
      settledC.kind === 'reconciled' && settledC.posted.join() === '1' && (await agentNonce()) === freeNonce + 1,
      `${CAMPAIGN_C}: the post sent again was mined and list version 1 is recorded as posted, the agent using one nonce for it`,
    );

    say('\n  (v) the owner pauses the vault while a claim waits, and the claim uses up none of its tries');
    await moveClock(ROOT_DELAY, 'past the root delay');
    const queuedC = await activateCheck(later, CAMPAIGN_C);
    check(queuedC.kind === 'queued' && queuedC.added === 1, `${CAMPAIGN_C}: list version 1 is active and its one claim is queued`);
    await ownerCalls('pause', CAMPAIGN_C);
    const triesOfC = async () =>
      (await store.query<{ attempts: number }>('SELECT attempts FROM claim_relays WHERE campaign_id = $1', [CAMPAIGN_C]))[0]?.attempts;
    const pausedRuns: RelayOutcome[] = [];
    for (let run = 0; run < PAUSED_RELAY_RUNS; run += 1) {
      pausedRuns.push(await relayNext(later));
      ahead += (LONGEST_RETRY_SECONDS + 1) * 1000;
    }
    check(
      pausedRuns.every((run) => run.kind === 'relayed' && run.status === 'pending' && run.cause === PAUSED_VAULT) && (await triesOfC()) === 0,
      `${CAMPAIGN_C}: ${PAUSED_RELAY_RUNS} relay runs while paused each gave the claim back with no try used ("${PAUSED_VAULT}")`,
    );
    await ownerCalls('unpause', CAMPAIGN_C);
    const claimedC = await relayNext(later);
    const receivedC = await balance(askerC);
    check(
      claimedC.kind === 'relayed' && claimedC.status === 'confirmed' && receivedC === REWARD,
      `${CAMPAIGN_C}: after the unpause ${askerC} was paid exactly ${usdc(REWARD)} (got ${usdc(receivedC)})`,
    );

    const latest = await publicClient.getBlockNumber({ cacheTime: 0 });
    const sent: string[] = [];
    const postsOfRoot = new Map<string, number>();
    const vaults = new Map<Address, string>([
      [vault, 'vault A'],
      [second.vault, 'vault B'],
      [third.vault, 'vault C'],
    ]);
    for (let block = forkBlock + 1n; block <= latest; block += 1n) {
      const { transactions } = await publicClient.getBlock({ blockNumber: block, includeTransactions: true });
      for (const tx of transactions) {
        if (parseAddress(tx.from) !== agent.account.address) continue;
        const target = tx.to === null ? undefined : vaults.get(parseAddress(tx.to));
        if (target === undefined) {
          sent.push('a transaction to another contract');
          continue;
        }
        const call = decodeFunctionData({ abi: VAULT_ABI, data: tx.input as Hex });
        if (call.functionName === 'postRoot') {
          const root = String(call.args[0]).toLowerCase();
          postsOfRoot.set(root, (postsOfRoot.get(root) ?? 0) + 1);
        }
        sent.push(`${call.functionName} to ${target}`);
      }
    }
    const onlyPostAndClaim = sent.length > 0 && sent.every((line) => /^(postRoot|claim) to vault [ABC]$/.test(line));
    check(onlyPostAndClaim, `the agent sent ${sent.length} transactions, each postRoot or claim to a campaign vault: ${sent.join(', ')}`);
    const rootB1 = unrecorded?.root ?? '';
    check(postsOfRoot.get(rootB1) === 1, `${CAMPAIGN_B}: list version 1's root was posted once in all, across the stop, the cancel and the restart`);
    check(!postsOfRoot.has(stalledRoot), `${CAMPAIGN_B}: list version 2's root, from the stopped publish, was never posted`);
    check(postsOfRoot.get(newerRoot) === 1, `${CAMPAIGN_B}: list version 3's root was posted once`);
    check(postsOfRoot.get((sendingC?.root ?? '').toLowerCase()) === 1, `${CAMPAIGN_C}: list version 1's root was mined once, across the drop and the send at the same nonce`);
    check([...postsOfRoot.values()].every((times) => times === 1), `every root was posted once (${postsOfRoot.size} roots)`);
    const secrets = [agentKey, ownerKey, ...askKeys, ...askKeysB, askKeyC].map((key) => key.slice(2).toLowerCase());
    const leaked = workerLines.some((line) => {
      const lowered = line.toLowerCase();
      return secrets.some((secret) => lowered.includes(secret)) || signatures.some((signature) => lowered.includes(signature.slice(2, 66).toLowerCase()));
    });
    check(!leaked && workerLines.length > 0, `none of the ${workerLines.length} worker log lines holds a private key or a signature`);
    check(screenings <= MAX_SCREENINGS, `screenings used: ${screenings}, within the ${MAX_SCREENINGS} allowed`);
  } finally {
    await db?.close();
    stopAnvil();
    process.removeListener('exit', stopAnvil);
  }

  if (failures.length > 0) {
    say(`\nRehearsal failed: ${failures.length} check${failures.length === 1 ? '' : 's'} did not pass.`);
    return 1;
  }
  say('\nRehearsal passed. anvil is stopped.');
  return 0;
}

async function main(): Promise<number> {
  const env = loadEnv(process.env);
  const graphId = env.SERV_GRAPH_ID;
  if (graphId === undefined || graphVersion(graphId) === undefined) {
    throw new RehearsalError('SERV_GRAPH_ID must name a graph Thuli has a translation for (auto mode asks the graph first).');
  }
  const forkUrl = loadRpcEnv(process.env);
  const rulebook = fs.readFileSync(RULEBOOK_FILE, 'utf8');
  const connection = { baseUrl: env.SERV_BASE_URL, apiKey: env.SERV_API_KEY };
  return rehearse({
    forkUrl,
    readFacts: factsAtFinalizedBlock({ rpcUrl: env.ETH_RPC_URL, blockscoutApi: env.BLOCKSCOUT_ETH_API }),
    readAccount: accountStateAtFinalizedBlock({ rpcUrl: env.ETH_RPC_URL }),
    serv: {
      viaGraph: (record) => decideViaGraph(record, { ...connection, graphId }),
      viaV2: (record) => decideViaV2(record, rulebook, connection),
      sleep: (ms) => wait(ms),
    },
    servLabel: 'live SERV',
    secrets: [forkUrl, env.SERV_API_KEY, env.ETH_RPC_URL, env.BLOCKSCOUT_ETH_API, env.SERV_BASE_URL],
  });
}

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const known = error instanceof RehearsalError ? error.message : safeCause(error);
      console.error(`rehearse-campaign stopped: ${known}`);
      process.exitCode = 1;
    },
  );
}

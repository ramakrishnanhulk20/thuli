// Deploys ThuliVaultFactory to Base Sepolia from the worker key, verifies it, and records it in
// deployments/base-sepolia.json (address, transaction, block, where it was verified).
//
//   npm run vault:deploy                      live: BASE_SEPOLIA_RPC_URL, WORKER_PRIVATE_KEY, EXPLORER_API_KEY from .env
//   npm run vault:deploy -- --redeploy        deploy a second factory even though one is recorded
//   node deploy.mjs --rehearsal --rpc-url http://127.0.0.1:8546 --out FILE    local fork only, no verification
//
// Base mainnet, only with both --network base and --real-money, from the owner key (PAYER_PRIVATE_KEY) and BASE_RPC_URL:
//   npm run vault:deploy -- --network base --real-money            simulate the factory creation, sign nothing
//   npm run vault:deploy -- --network base --real-money --send     deploy, verify on Basescan, write deployments/base.json
//   ... --network base --real-money --fork --rpc-url http://127.0.0.1:PORT --out FILE [--send]    an anvil fork of Base
// The Base path sends the compiled factory itself, after checking the fresh build has foundry.toml's settings and the
// exact runtime code of the factory Basescan verified on Base Sepolia, so the same source verifies on Base too.
//
// Verification tries Basescan (Etherscan API v2, chain 84532) first and falls back to Blockscout. Keys travel to
// forge through the environment only, never on a command line, and are never printed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const CHAIN_ID = 84532;
const CONTRACTS = fileURLToPath(new URL('..', import.meta.url));
const RECORD = path.join(CONTRACTS, 'deployments', 'base-sepolia.json');
// FOUNDRY_BROADCAST lets the rehearsal keep its records in its own folder, away from the live run's.
const BROADCAST = path.join(
  path.resolve(CONTRACTS, process.env.FOUNDRY_BROADCAST ?? 'broadcast'),
  'Deploy.s.sol',
  String(CHAIN_ID),
  'run-latest.json',
);
const BASESCAN = 'https://sepolia.basescan.org';
const BASE_CHAIN_ID = 8453;
const BASE_EXPLORER = 'https://basescan.org';
const DEPLOYMENTS = path.join(CONTRACTS, 'deployments');
const BASE_RECORD = path.join(DEPLOYMENTS, 'base.json');
const ARTIFACT = path.join(CONTRACTS, 'out', 'ThuliVaultFactory.sol', 'ThuliVaultFactory.json');
const SEPOLIA_PUBLIC_RPC = 'https://sepolia.base.org';
const RECEIPT_TIMEOUT_MS = 180_000;
const BLOCKSCOUT = 'https://base-sepolia.blockscout.com';
const RPC_TIMEOUT_MS = 15_000;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;
const KEY = /^0x[0-9a-fA-F]{64}$/;

class DeployError extends Error {}

function settings() {
  const { values } = parseArgs({
    options: {
      rehearsal: { type: 'boolean', default: false },
      'rpc-url': { type: 'string' },
      out: { type: 'string' },
      redeploy: { type: 'boolean', default: false },
      network: { type: 'string' },
      'real-money': { type: 'boolean', default: false },
      fork: { type: 'boolean', default: false },
      send: { type: 'boolean', default: false },
    },
    strict: true,
  });
  // Every flag is checked before any key or RPC is read, so a wrong command refuses having touched nothing.
  const network = values.network ?? 'base-sepolia';
  if (network !== 'base' && network !== 'base-sepolia') throw new DeployError('--network must be base or base-sepolia');
  if (network === 'base') return baseSettings(values);
  if (values['real-money'] || values.fork) throw new DeployError('--real-money and --fork go only with --network base');
  if (values.send) throw new DeployError('--send goes only with --network base; the Base Sepolia deploy sends as before');
  if (!KEY.test((process.env.WORKER_PRIVATE_KEY ?? '').trim())) {
    throw new DeployError('WORKER_PRIVATE_KEY must be set in .env as 0x followed by 64 hex characters.');
  }
  if (values.rehearsal) {
    // A rehearsal must never reach a public network, and must never overwrite the live record.
    if (!LOOPBACK.test(values['rpc-url'] ?? '')) throw new DeployError('--rehearsal needs --rpc-url http://127.0.0.1:PORT');
    if (!values.out) throw new DeployError('--rehearsal needs --out FILE, outside deployments/');
    return { rpcUrl: values['rpc-url'], out: path.resolve(values.out), verify: false, redeploy: values.redeploy };
  }
  if (values['rpc-url'] || values.out) throw new DeployError('--rpc-url and --out are for --rehearsal only.');
  const rpcUrl = (process.env.BASE_SEPOLIA_RPC_URL ?? '').trim();
  if (!/^https:\/\/\S+$/.test(rpcUrl)) throw new DeployError('BASE_SEPOLIA_RPC_URL must be set in .env to an https URL.');
  if (!(process.env.EXPLORER_API_KEY ?? '').trim()) throw new DeployError('EXPLORER_API_KEY must be set in .env to verify.');
  return { rpcUrl, out: RECORD, verify: true, redeploy: values.redeploy };
}

function inside(folder, file) {
  const relative = path.relative(folder, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function baseSettings(values) {
  if (!values['real-money']) throw new DeployError('Base mainnet moves real money: add --real-money to --network base');
  if (values.rehearsal || values.redeploy) throw new DeployError('--rehearsal and --redeploy are Base Sepolia flags; a Base rehearsal is --fork');
  let rpcUrl;
  let out;
  if (values.fork) {
    if (!LOOPBACK.test(values['rpc-url'] ?? '')) {
      throw new DeployError('--fork needs --rpc-url http://127.0.0.1:PORT, a local fork; it never reaches a public RPC');
    }
    if (!values.out || inside(DEPLOYMENTS, path.resolve(values.out))) {
      throw new DeployError('--fork needs --out FILE outside packages/contracts/deployments, so a rehearsal never writes the public record');
    }
    rpcUrl = values['rpc-url'];
    out = path.resolve(values.out);
  } else {
    if (values['rpc-url'] || values.out) throw new DeployError('--rpc-url and --out are only for --fork; Base mainnet is read through BASE_RPC_URL');
    rpcUrl = (process.env.BASE_RPC_URL ?? '').trim();
    if (!/^https:\/\/\S+$/.test(rpcUrl)) throw new DeployError('BASE_RPC_URL must be set in .env to an https Base mainnet RPC.');
    out = BASE_RECORD;
  }
  const key = (process.env.PAYER_PRIVATE_KEY ?? '').trim();
  if (!KEY.test(key)) throw new DeployError('PAYER_PRIVATE_KEY must be set in .env as 0x and 64 hex characters: the owner key deploys the Base factory.');
  hidden.push(key, key.slice(2), rpcUrl);
  return { network: 'base', rpcUrl, out, key, fork: values.fork, send: values.send };
}

// Values that must never reach the screen; every line this script prints after a failure goes through scrub.
const hidden = [];
const scrub = (text) => hidden.filter((value) => value.length >= 8).reduce((clean, value) => clean.split(value).join('[hidden]'), String(text));

/** foundry.toml's compiler, EVM and optimizer settings, the ones the Base Sepolia factory was built and verified with. */
function foundrySettings() {
  const toml = fs.readFileSync(path.join(CONTRACTS, 'foundry.toml'), 'utf8');
  const read = (name) => /^\s*(\S+)\s*=\s*"?([^"\n]+?)"?\s*$/m.exec(toml.split('\n').find((line) => line.trim().startsWith(`${name} `)) ?? '')?.[2];
  return { solc: read('solc_version'), evm: read('evm_version'), optimizer: read('optimizer') === 'true', runs: Number(read('optimizer_runs')) };
}

/**
 * The factory's creation code from a fresh forge build, refused unless the build used foundry.toml's settings and its
 * runtime code is byte for byte the factory Basescan verified on Base Sepolia, metadata hash included, so Basescan can
 * match the same source and settings on Base.
 */
async function checkedFactoryBuild() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/PRIVATE_KEY$/i.test(name)));
  if (!forge(['build'], env)) throw new DeployError('forge build failed, so there is no artifact to deploy.');
  const artifact = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  const wanted = foundrySettings();
  const meta = artifact.metadata;
  const built = {
    solc: String(meta?.compiler?.version ?? '').split('+')[0],
    evm: meta?.settings?.evmVersion,
    optimizer: meta?.settings?.optimizer?.enabled === true,
    runs: meta?.settings?.optimizer?.runs,
  };
  if (built.solc !== wanted.solc || built.evm !== wanted.evm || built.optimizer !== wanted.optimizer || built.runs !== wanted.runs) {
    throw new DeployError(`The build used solc ${built.solc}, ${built.evm}, optimizer ${built.optimizer} ${built.runs}, not foundry.toml's settings.`);
  }
  const sepolia = JSON.parse(fs.readFileSync(path.join(DEPLOYMENTS, 'base-sepolia.json'), 'utf8'));
  const sepoliaRpc = /^https:\/\/\S+$/.test((process.env.BASE_SEPOLIA_RPC_URL ?? '').trim()) ? process.env.BASE_SEPOLIA_RPC_URL.trim() : SEPOLIA_PUBLIC_RPC;
  hidden.push(sepoliaRpc);
  const verified = (await rpc(sepoliaRpc, 'eth_getCode', [sepolia.factory, 'latest'])).toLowerCase();
  const runtime = String(artifact.deployedBytecode?.object ?? '').toLowerCase();
  if (runtime === '' || runtime !== verified) {
    throw new DeployError('The fresh build differs from the factory Basescan verified on Base Sepolia; refusing to deploy code that would not verify.');
  }
  console.log(`Build checked: solc ${built.solc}, ${built.evm}, optimizer ${built.runs} runs, runtime code identical to ${sepolia.factory} on Base Sepolia.`);
  return { creation: artifact.bytecode.object, runtime };
}

async function deployBase(config) {
  const chainId = Number.parseInt(await rpc(config.rpcUrl, 'eth_chainId', []), 16);
  if (chainId !== BASE_CHAIN_ID) throw new DeployError(`The RPC is on chain ${chainId}; --network base deploys only on Base (${BASE_CHAIN_ID}).`);
  const node = await rpc(config.rpcUrl, 'web3_clientVersion', []).catch(() => '');
  const anvil = /^anvil\//i.test(node);
  if (anvil && !config.fork) throw new DeployError('This node is a local anvil fork; pass --fork to rehearse on it.');
  if (!anvil && config.fork) throw new DeployError('--fork expects a local anvil fork of Base, and this node is not one.');

  if (fs.existsSync(config.out)) {
    const recorded = JSON.parse(fs.readFileSync(config.out, 'utf8'));
    const code = await rpc(config.rpcUrl, 'eth_getCode', [recorded.factory, 'latest']);
    if (code !== '0x') {
      console.log(`Factory already deployed at ${recorded.factory} (${config.out}): ${BASE_EXPLORER}/address/${recorded.factory}. Nothing sent.`);
      return;
    }
    throw new DeployError(`${config.out} names ${recorded.factory}, which has no code here. Move the file aside to deploy again.`);
  }

  const { creation, runtime } = await checkedFactoryBuild();
  const account = privateKeyToAccount(config.key);
  const [balance, gasPrice, gas] = await Promise.all([
    rpc(config.rpcUrl, 'eth_getBalance', [account.address, 'latest']).then(BigInt),
    rpc(config.rpcUrl, 'eth_gasPrice', []).then(BigInt),
    rpc(config.rpcUrl, 'eth_estimateGas', [{ from: account.address, data: creation }]).then(BigInt),
  ]);
  const fee = gas * gasPrice;
  console.log(`Deployer (owner key) ${account.address}, holding ${balance} wei`);
  console.log(`Factory creation: ${(creation.length - 2) / 2} bytes, simulated gas ${gas}, at ${gasPrice} wei per gas: ${fee} wei, plus Base's L1 data fee`);
  if (!config.send) {
    console.log('Simulated only: nothing was signed. Add --send to deploy.');
    return;
  }
  if (balance <= fee) throw new DeployError(`The owner holds ${balance} wei, and the deploy needs more than ${fee} wei plus the L1 data fee.`);

  const chain = defineChain({
    id: BASE_CHAIN_ID,
    name: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const transport = http(config.rpcUrl, { timeout: RPC_TIMEOUT_MS });
  const wallet = createWalletClient({ account, chain, transport });
  const reader = createPublicClient({ chain, transport });
  const hash = await wallet.sendTransaction({ data: creation, gas: (gas * 12n) / 10n });
  console.log(`  deploy tx  ${BASE_EXPLORER}/tx/${hash}`);
  const receipt = await reader.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new DeployError(`The deploy transaction ${hash} did not create the factory.`);
  const factory = receipt.contractAddress.toLowerCase();
  if ((await rpc(config.rpcUrl, 'eth_getCode', [factory, 'latest'])).toLowerCase() !== runtime) {
    throw new DeployError(`${factory} does not hold the checked factory code.`);
  }

  let verifiedOn = 'not verified (fork rehearsal)';
  if (!config.fork) {
    const key = (process.env.EXPLORER_API_KEY ?? '').trim();
    hidden.push(key);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/PRIVATE_KEY$/i.test(name)));
    const args = ['verify-contract', factory, 'src/ThuliVaultFactory.sol:ThuliVaultFactory', '--chain', String(BASE_CHAIN_ID), '--verifier', 'etherscan', '--watch'];
    verifiedOn = key !== '' && forge(args, { ...env, ETHERSCAN_API_KEY: key }) ? 'basescan' : 'none';
  }
  const record = {
    network: 'base',
    chainId: BASE_CHAIN_ID,
    factory,
    deployer: account.address.toLowerCase(),
    txHash: hash,
    block: Number(receipt.blockNumber),
    verifiedOn,
    explorer: `${BASE_EXPLORER}/address/${factory}`,
    recordedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(config.out), { recursive: true });
  fs.writeFileSync(config.out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Factory ${factory} at block ${record.block}, gas used ${receipt.gasUsed}`);
  console.log(`  verified   ${verifiedOn}, ${record.explorer}`);
  console.log(`  recorded   ${config.out}`);
  if (!config.fork && verifiedOn === 'none') console.log('Deployed and recorded, but not verified: run npm run vault:verify -- --network base later.');
}

async function rpc(rpcUrl, method, params) {
  const reply = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  const body = await reply.json();
  if (body.error || typeof body.result !== 'string') throw new DeployError(`${method} failed on the RPC`);
  return body.result;
}

function forgeBinary() {
  const onPath = spawnSync('forge', ['--version'], { stdio: 'ignore' });
  if (onPath.status === 0) return 'forge';
  const local = path.join(os.homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'forge.exe' : 'forge');
  if (fs.existsSync(local)) return local;
  throw new DeployError('forge not found. Install Foundry (https://getfoundry.sh) and run foundryup.');
}

function forge(args, env) {
  return spawnSync(forgeBinary(), args, { cwd: CONTRACTS, stdio: 'inherit', env }).status === 0;
}

/** The factory deployment in forge's broadcast record, only if that record was written by this run. */
function broadcastResult(startedAt) {
  if (!fs.existsSync(BROADCAST) || fs.statSync(BROADCAST).mtimeMs < startedAt) return undefined;
  const run = JSON.parse(fs.readFileSync(BROADCAST, 'utf8'));
  const tx = run.transactions?.find((t) => t.contractName === 'ThuliVaultFactory' && t.transactionType === 'CREATE');
  const receipt = run.receipts?.find((r) => r.transactionHash === tx?.hash);
  if (!tx || !receipt || receipt.status !== '0x1') return undefined;
  return {
    factory: tx.contractAddress,
    deployer: tx.transaction.from,
    txHash: tx.hash,
    block: Number.parseInt(receipt.blockNumber, 16),
    gasUsed: Number.parseInt(receipt.gasUsed, 16),
  };
}

async function main() {
  const config = settings();
  if (config.network === 'base') return deployBase(config);
  const chainId = Number.parseInt(await rpc(config.rpcUrl, 'eth_chainId', []), 16);
  if (chainId !== CHAIN_ID) throw new DeployError(`The RPC is on chain ${chainId}; this deploy runs only on ${CHAIN_ID}.`);

  if (fs.existsSync(config.out) && !config.redeploy) {
    const recorded = JSON.parse(fs.readFileSync(config.out, 'utf8'));
    const code = await rpc(config.rpcUrl, 'eth_getCode', [recorded.factory, 'latest']);
    if (code !== '0x') {
      console.log(`Factory already deployed at ${recorded.factory} (${config.out}). Pass --redeploy for another.`);
      return;
    }
    throw new DeployError(`${config.out} names ${recorded.factory}, which has no code here. Pass --redeploy to replace it.`);
  }

  const env = { ...process.env, ETHERSCAN_API_KEY: process.env.EXPLORER_API_KEY ?? '' };
  const script = ['script', 'script/Deploy.s.sol:Deploy', '--rpc-url', config.rpcUrl, '--broadcast'];
  const verifyArgs = ['--verify', '--verifier', 'etherscan', '--chain', String(CHAIN_ID)];
  const startedAt = Date.now();
  const scriptOk = forge(config.verify ? [...script, ...verifyArgs] : script, env);
  const result = broadcastResult(startedAt);
  if (!result) throw new DeployError('The deploy transaction was not confirmed. Nothing was recorded.');

  let verifiedOn = 'not verified (rehearsal)';
  if (config.verify) {
    verifiedOn = scriptOk ? 'basescan' : 'none';
    if (!scriptOk) {
      console.log('Basescan verification failed; trying Blockscout.');
      const blockscout = [
        'verify-contract', result.factory, 'src/ThuliVaultFactory.sol:ThuliVaultFactory', '--chain', String(CHAIN_ID),
        '--verifier', 'blockscout', '--verifier-url', `${BLOCKSCOUT}/api/`, '--watch',
      ];
      if (forge(blockscout, env)) verifiedOn = 'blockscout';
    }
  }

  const explorer = verifiedOn === 'blockscout' ? BLOCKSCOUT : BASESCAN;
  const record = {
    network: 'base-sepolia',
    chainId: CHAIN_ID,
    factory: result.factory,
    deployer: result.deployer,
    txHash: result.txHash,
    block: result.block,
    verifiedOn,
    explorer: `${explorer}/address/${result.factory}`,
    recordedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(config.out), { recursive: true });
  fs.writeFileSync(config.out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Factory ${result.factory} at block ${result.block}, gas used ${result.gasUsed}`);
  console.log(`  deploy tx  ${BASESCAN}/tx/${result.txHash}`);
  console.log(`  verified   ${verifiedOn}, ${record.explorer}`);
  console.log(`  recorded   ${config.out}`);
  if (config.verify && verifiedOn === 'none') throw new DeployError('Deployed and recorded, but neither explorer verified it.');
}

main().catch((error) => {
  // A library error can quote the RPC URL, so only its short message goes out, and through scrub (C40).
  console.error(scrub(error instanceof DeployError ? error.message : `deploy stopped: ${error?.shortMessage ?? error?.name ?? 'unknown error'}`));
  process.exit(1);
});

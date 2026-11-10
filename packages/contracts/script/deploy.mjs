// Deploys ThuliVaultFactory to Base Sepolia from the worker key, verifies it, and records it in
// deployments/base-sepolia.json (address, transaction, block, where it was verified).
//
//   npm run vault:deploy                      live: BASE_SEPOLIA_RPC_URL, WORKER_PRIVATE_KEY, EXPLORER_API_KEY from .env
//   npm run vault:deploy -- --redeploy        deploy a second factory even though one is recorded
//   node deploy.mjs --rehearsal --rpc-url http://127.0.0.1:8546 --out FILE    local fork only, no verification
//
// Verification tries Basescan (Etherscan API v2, chain 84532) first and falls back to Blockscout. Keys travel to
// forge through the environment only, never on a command line, and are never printed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

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
    },
    strict: true,
  });
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
  console.error(error instanceof DeployError ? error.message : error);
  process.exit(1);
});

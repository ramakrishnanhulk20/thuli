// Verifies the factory and campaign vaults on Basescan (Base Sepolia, through the Etherscan V2 API), so every contract
// link on the site opens readable source and the read functions:
//
//   npm run vault:verify                        the factory and the proof vault, from the two committed records
//   npm run vault:verify -- --vault-tx HASH     also the vault that createVault transaction made (repeat for more)
//   npm run vault:verify -- --network base      the Base mainnet factory, and its proof vault once base-proof.json exists
//
// Needs EXPLORER_API_KEY. EXPLORER_API_URL and BASE_SEPOLIA_RPC_URL are optional: the Etherscan V2 endpoint and Base
// Sepolia's public RPC. A vault's constructor arguments come from the factory's VaultCreated log in its creation
// receipt, which holds exactly the values the factory passed to the vault's constructor. Compiler, optimizer and EVM
// version come from foundry.toml, as they did for the deploy. It sends no transaction, the key reaches forge through
// its environment only, and no key or URL is printed. A contract already verified is skipped by forge itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { decodeEventLog, encodeAbiParameters, getAddress, parseAbi } from 'viem';

const NETWORKS = {
  'base-sepolia': { chainId: 84532, record: 'base-sepolia.json', proof: 'base-sepolia-proof.json', explorer: 'https://sepolia.basescan.org', rpcName: 'BASE_SEPOLIA_RPC_URL', defaultRpc: 'https://sepolia.base.org' },
  base: { chainId: 8453, record: 'base.json', proof: 'base-proof.json', explorer: 'https://basescan.org', rpcName: 'BASE_RPC_URL', defaultRpc: undefined },
};
const CONTRACTS = fileURLToPath(new URL('..', import.meta.url));
const DEPLOYMENTS = path.join(CONTRACTS, 'deployments');
const DEFAULT_API = 'https://api.etherscan.io/v2/api';
const TIMEOUT_MS = 30_000;
// Both records are a few hundred bytes; a file far past this is not one of them.
const MAX_RECORD_BYTES = 64 * 1024;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const FACTORY_CONTRACT = 'src/ThuliVaultFactory.sol:ThuliVaultFactory';
const VAULT_CONTRACT = 'src/ThuliVault.sol:ThuliVault';
// The factory's event and the vault constructor's parameters, as declared in src/ThuliVaultFactory.sol and src/ThuliVault.sol.
const VAULT_CREATED = parseAbi([
  'event VaultCreated(address indexed vault, address indexed owner, address indexed agent, address token, uint256 perWalletCap, uint64 endTime, uint32 rootDelay)',
]);
const CONSTRUCTOR = [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'uint32' }];

class VerifyError extends Error {}

let hidden = [];
const hide = (text) => hidden.filter((value) => value.length >= 8).reduce((clean, value) => clean.split(value).join('[hidden]'), text ?? '');

function httpsOr(value, fallback, name) {
  const given = (value ?? '').trim();
  if (given === '') return fallback;
  if (!/^https:\/\/\S+$/.test(given)) throw new VerifyError(`${name} must be an https URL.`);
  return given;
}

function settings() {
  const { values } = parseArgs({ options: { 'vault-tx': { type: 'string', multiple: true }, network: { type: 'string' } }, strict: true, allowPositionals: false });
  const net = NETWORKS[values.network ?? 'base-sepolia'];
  if (net === undefined) throw new VerifyError('--network must be base or base-sepolia.');
  const key = (process.env.EXPLORER_API_KEY ?? '').trim();
  if (key === '') throw new VerifyError('EXPLORER_API_KEY must be set in .env: an Etherscan API key.');
  const api = httpsOr(process.env.EXPLORER_API_URL, DEFAULT_API, 'EXPLORER_API_URL');
  const rpcUrl = httpsOr(process.env[net.rpcName], net.defaultRpc, net.rpcName);
  if (rpcUrl === undefined) throw new VerifyError(`${net.rpcName} must be set in .env to an https RPC.`);
  hidden = [key, api, rpcUrl];
  const vaultTxs = values['vault-tx'] ?? [];
  if (vaultTxs.some((hash) => !TX_HASH.test(hash))) throw new VerifyError('--vault-tx must be 0x and 64 hex characters.');
  return { key, api, rpcUrl, vaultTxs, net };
}

function readRecord(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size > MAX_RECORD_BYTES) throw new VerifyError(`No usable record at ${file}.`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new VerifyError(`The record at ${file} is not JSON.`);
  }
}

async function rpc(url, method, params) {
  const reply = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await reply.json();
  if (body.error || body.result === null || body.result === undefined) throw new VerifyError(`${method} failed on the RPC`);
  return body.result;
}

// Both sides through viem's one checksum parser, so a lowercase record and a checksummed log compare equal.
function same(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

/** The vault a createVault transaction made, and its constructor arguments, from the factory's one VaultCreated log. */
async function vaultFrom(rpcUrl, factory, hash) {
  const receipt = await rpc(rpcUrl, 'eth_getTransactionReceipt', [hash]);
  if (receipt.status !== '0x1') throw new VerifyError(`${hash} did not succeed`);
  if (receipt.to === null || !same(receipt.to, factory)) throw new VerifyError(`${hash} was not sent to the factory in base-sepolia.json`);
  const created = receipt.logs
    .filter((log) => same(log.address, factory))
    .flatMap((log) => {
      try {
        return [decodeEventLog({ abi: VAULT_CREATED, topics: log.topics, data: log.data, strict: true }).args];
      } catch {
        return [];
      }
    });
  if (created.length !== 1) throw new VerifyError(`${hash} holds ${created.length} VaultCreated logs from the factory, not one`);
  const [terms] = created;
  return {
    address: getAddress(terms.vault),
    contract: VAULT_CONTRACT,
    constructorArgs: encodeAbiParameters(CONSTRUCTOR, [terms.token, terms.owner, terms.agent, terms.perWalletCap, terms.endTime, terms.rootDelay]),
  };
}

function forgeBinary() {
  if (spawnSync('forge', ['--version'], { stdio: 'ignore' }).status === 0) return 'forge';
  const local = path.join(os.homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'forge.exe' : 'forge');
  if (fs.existsSync(local)) return local;
  throw new VerifyError('forge not found. Install Foundry (https://getfoundry.sh) and run foundryup.');
}

function verifyOne(target, config) {
  // forge needs no private key to verify, so none is handed to it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/PRIVATE_KEY$/i.test(name)));
  const verifierUrl = new URL(config.api);
  verifierUrl.searchParams.set('chainid', String(config.net.chainId));
  Object.assign(env, { ETHERSCAN_API_KEY: config.key, VERIFIER_URL: verifierUrl.toString() });
  hidden.push(verifierUrl.toString());
  const args = ['verify-contract', target.address, target.contract, '--chain', String(config.net.chainId), '--verifier', 'etherscan', '--watch'];
  if (target.constructorArgs !== undefined) args.push('--constructor-args', target.constructorArgs);
  const run = spawnSync(forgeBinary(), args, { cwd: CONTRACTS, env, encoding: 'utf8', timeout: 600_000 });
  process.stdout.write(hide(run.stdout));
  process.stderr.write(hide(run.stderr));
  return run.status === 0;
}

async function sourceOf(config, address) {
  const url = new URL(config.api);
  url.search = new URLSearchParams({ chainid: String(config.net.chainId), module: 'contract', action: 'getsourcecode', address, apikey: config.key }).toString();
  const body = await (await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })).json();
  const first = Array.isArray(body.result) ? body.result[0] : undefined;
  return first !== undefined && first.SourceCode !== '' && first.ContractName !== '' ? first : undefined;
}

async function main() {
  const config = settings();
  const chainId = Number.parseInt(await rpc(config.rpcUrl, 'eth_chainId', []), 16);
  if (chainId !== config.net.chainId) throw new VerifyError(`The RPC is on chain ${chainId}; this runs only on ${config.net.chainId}.`);

  const deployment = readRecord(path.join(DEPLOYMENTS, config.net.record));
  if (deployment.chainId !== config.net.chainId) throw new VerifyError(`${config.net.record} is not a record for chain ${config.net.chainId}.`);
  const factory = getAddress(deployment.factory);
  const proofFile = path.join(DEPLOYMENTS, config.net.proof);
  // On Base mainnet the proof record exists only after the real run, so until then the factory alone is checked.
  const proof = config.net.chainId === 8453 && !fs.existsSync(proofFile) ? undefined : readRecord(proofFile);
  const proofTx = proof?.transactions?.find((tx) => tx.label === 'createVault')?.hash;
  if (proof !== undefined && (typeof proofTx !== 'string' || !TX_HASH.test(proofTx))) throw new VerifyError(`${config.net.proof} holds no createVault transaction.`);

  const targets = [{ address: factory, contract: FACTORY_CONTRACT }];
  const hashes = [...new Set([...(proofTx === undefined ? [] : [proofTx]), ...config.vaultTxs].map((hash) => hash.toLowerCase()))];
  for (const hash of hashes) targets.push(await vaultFrom(config.rpcUrl, factory, hash));
  if (proof !== undefined && !same(targets[1].address, proof.vault)) throw new VerifyError('The proof record names another vault than its createVault transaction made.');

  let failed = 0;
  for (const target of targets) {
    console.log(`Verifying ${target.contract.split(':')[1]} at ${target.address}`);
    if (!verifyOne(target, config)) failed += 1;
  }
  console.log('Basescan reports:');
  for (const target of targets) {
    const source = await sourceOf(config, target.address);
    if (source === undefined) {
      failed += 1;
      console.log(`  ${target.address}: no verified source`);
      continue;
    }
    const matched = source.SimilarMatch ? `, the same code as ${getAddress(source.SimilarMatch)}` : '';
    console.log(`  ${target.address}: ${source.ContractName}, ${source.CompilerVersion}${matched}  ${config.net.explorer}/address/${target.address}#code`);
  }
  if (failed > 0) throw new VerifyError(`${failed} step(s) failed; see the lines above.`);
}

main().catch((error) => {
  console.error(hide(error instanceof VerifyError ? error.message : `vault:verify stopped: ${error instanceof Error ? error.name : 'unknown error'}`));
  process.exit(1);
});

// Rehearses the Base Sepolia deploy and both proof phases end to end on a local anvil fork. Nothing is sent to any
// public network: anvil serves the fork on 127.0.0.1 and keeps every transaction to itself. The owner gets test USDC
// by writing its balance slot, both keys get gas by anvil_setBalance, and evm_increaseTime moves past the root delay
// between the phases.
//
//   npm run rehearse --prefix packages/contracts [-- --fork-url URL --port N]
//
// Uses WORKER_PRIVATE_KEY and PAYER_PRIVATE_KEY from .env, so the rehearsal signs with the keys the live run will use.
// Needs Foundry (anvil, forge) and the repo's root npm install, which provides viem and tsx.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createTestClient, encodeAbiParameters, erc20Abi, http, keccak256, pad, parseEther, publicActions, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const CONTRACTS = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(CONTRACTS, '..', '..');
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
// FiatToken keeps each balance in the mapping at storage slot 9, with the blacklist flag in the top bit.
const USDC_BALANCE_SLOT = 9n;
const OWNER_USDC = 2_000_000n;
const ROOT_DELAY = 3600;
const START_TIMEOUT_MS = 60_000;
const KEY = /^0x[0-9a-fA-F]{64}$/;

class RehearsalError extends Error {}

function foundryBinary(name) {
  if (spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0) return name;
  const local = path.join(os.homedir(), '.foundry', 'bin', process.platform === 'win32' ? `${name}.exe` : name);
  if (fs.existsSync(local)) return local;
  throw new RehearsalError(`${name} not found. Install Foundry (https://getfoundry.sh) and run foundryup.`);
}

function step(title) {
  console.log(`\n== ${title}`);
}

function run(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { cwd: REPO, stdio: 'inherit', env });
  if (result.status !== 0) throw new RehearsalError(`step failed: node ${args.slice(-6).join(' ')}`);
}

async function waitForRpc(client) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    try {
      return await client.getChainId();
    } catch {
      if (Date.now() > deadline) throw new RehearsalError('anvil did not start within a minute');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: { 'fork-url': { type: 'string', default: 'https://sepolia.base.org' }, port: { type: 'string', default: '8546' } },
  });
  if (!/^\d{4,5}$/.test(values.port)) throw new RehearsalError('--port must be a port number');
  const rpcUrl = `http://127.0.0.1:${values.port}`;
  for (const name of ['WORKER_PRIVATE_KEY', 'PAYER_PRIVATE_KEY']) {
    if (!KEY.test((process.env[name] ?? '').trim())) throw new RehearsalError(`${name} must be set in .env`);
  }
  const agent = privateKeyToAccount(process.env.WORKER_PRIVATE_KEY.trim()).address;
  const owner = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY.trim()).address;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'thuli-rehearsal-'));
  const deployment = path.join(work, 'deployment.json');
  const state = path.join(work, 'state.json');

  step(`anvil fork of ${values['fork-url']} on ${rpcUrl}`);
  const anvil = spawn(foundryBinary('anvil'), ['--fork-url', values['fork-url'], '--port', values.port, '--silent'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    const client = createTestClient({ mode: 'anvil', transport: http(rpcUrl, { timeout: 30_000 }) }).extend(publicActions);
    const chainId = await waitForRpc(client);
    if (chainId !== 84532) throw new RehearsalError(`the fork reports chain ${chainId}, not Base Sepolia`);
    console.log(`fork block ${await client.getBlockNumber()}, chain ${chainId}, work folder ${work}`);

    step('fund the agent and the owner with fork ETH, and the owner with 2 test USDC');
    await client.setBalance({ address: agent, value: parseEther('1') });
    await client.setBalance({ address: owner, value: parseEther('1') });
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, USDC_BALANCE_SLOT]));
    await client.setStorageAt({ address: USDC, index: slot, value: pad(toHex(OWNER_USDC)) });
    const funded = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
    if (funded !== OWNER_USDC) throw new RehearsalError('the USDC balance slot has moved; update USDC_BALANCE_SLOT');
    console.log(`agent ${agent}: 1 ETH; owner ${owner}: 1 ETH and ${funded} base units of USDC`);

    step('deploy the factory (npm run vault:deploy, rehearsal mode: no verification, record in the work folder)');
    run([path.join(CONTRACTS, 'script', 'deploy.mjs'), '--rehearsal', '--rpc-url', rpcUrl, '--out', deployment], {
      ...process.env,
      FOUNDRY_BROADCAST: path.join(work, 'broadcast'),
      FOUNDRY_CACHE_PATH: path.join(work, 'cache'),
    });

    const prove = (phase) =>
      run(['--import', 'tsx', path.join(REPO, 'packages', 'worker', 'scripts', 'prove-vault.ts'), phase,
        '--rpc-url', rpcUrl, '--deployment', deployment, '--state', state]);

    step('prove-vault setup');
    prove('setup');

    step(`evm_increaseTime ${ROOT_DELAY} seconds, then mine a block`);
    await client.increaseTime({ seconds: ROOT_DELAY });
    await client.mine({ blocks: 1 });

    step('prove-vault claim');
    prove('claim');
    console.log(`\nRehearsal passed. Work folder: ${work}`);
  } finally {
    anvil.kill();
  }
}

main().catch((error) => {
  console.error(error instanceof RehearsalError ? error.message : error);
  process.exit(1);
});
